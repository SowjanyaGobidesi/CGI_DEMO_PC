package gw.job

uses com.tap2drive.constants.Tap2DriveConstants
uses gw.api.intentionallogging.IntentionalLogger
uses gw.api.job.JobProcessLogger
uses gw.api.locale.DisplayKey
uses gw.api.profiler.PCProfilerTag
uses gw.api.system.PCLoggerCategory
uses gw.api.util.DisplayableException
uses gw.api.web.util.TransactionUtil
uses gw.forms.FormInferenceEngine
uses gw.job.permissions.SubmissionPermissions
uses gw.pl.logging.LogMessageParams
uses org.slf4j.Marker
uses org.slf4j.MarkerFactory

/**
 * Encapsulates the actions taken within a Submission job.
 *
 * @see JobProcess for general information and job process logic.
 * @see gw.plugin.policyperiod.impl.JobProcessCreationPlugin
 */
@Export
class SubmissionProcess extends NewTermProcess {

  construct(period : PolicyPeriod) {
    super(period, new SubmissionPermissions(period.Job))
    JobProcessEvaluator = JobProcessUWIssueEvaluator.forSubmission()
  }

  override property get Job() : Submission {
    return super.Job as Submission
  }

  private final var _marker : Marker as Marker = MarkerFactory.getMarker("SubmissionProcess")

  private final var _intentionalLogger: IntentionalLogger as IntentionalLogger = gw.api.intentionallogging.IntentionalLogger.from(PCLoggerCategory.JOB_PROCESS)

  // ===== LIFECYCLE FUNCTIONS =====

  /**
   * Initializes a new submission.
   */
  override function start() {
    JobProcessLogger.logInfo("Starting submission, branch: " + _branch)
    startJobAsNew()
    _branch.Policy.PriorPremiums = 0bd.ofCurrency(_branch.PreferredSettlementCurrency)
    // go straight to editing when starting a new version on an existing Submission (for multiquote)
    if (Job.ActivePeriods.Count > 1) {
      beginEditing()
      return
    }

    // assign team members at this point so that automatic assignments will work
    Job.assignProducer()
    Job.assignUnderwriter()

    // make a history record that submission was created;
    // the block is used to evaluate the display key for the message
    Job.createCustomHistoryEvent(TC_SUB_CREATED, \ -> DisplayKey.get("Submission.History.JobCreated"))
    Job.addToGroup()
    _branch.Policy.Account.makeActive()
  }

  /**
   * Moves a policy from "New" to "Draft" status.
   */
  override function beginEditing() {
    super.beginEditing()
    _branch.Lines.each(\l -> l.onSubmissionBeginEditing())

    // fill in the empty territory codes
    for (territotyCode in _branch.PrimaryLocation.TerritoryCodes) {
      if (territotyCode.Code == null) {
        territotyCode.fillWithFirst()
      }
    }
  }

  /**
   * Checks the conditions for which the policy period can be saved.
   */
  function canSaveDraft() : JobConditions {
    return startChecksFor(DisplayKey.get("Job.Process.Submission.SaveDraft"))
  }

  override protected function addJobSpecificStartQuoteProcessChecks(jobConditions: JobConditions): JobConditions {
    return jobConditions.checkCanStartQuoteProcessStatus()
  }

  /**
   * Checks the conditions for which a new version of the policy period can be created.
   */
  override function canMakeNewVersion(): JobConditions {
    return super.canMakeNewVersion()
        .checkJobNotComplete()
  }

  /**
   * Checks the conditions for which a search for data to copy into the policy can be started
   */
  override function canStartCopyPolicyData() : JobConditions {
    return internalCanStartCopyPolicyData()
  }

  /**
   * Checks the conditions for which the submission can be switched from being a
   * "Quick Quote" to a "Full Application" for a policy.
   */
  function canConvertToFullApp() : JobConditions {
    return startChecksFor(DisplayKey.get("Job.Process.Submission.ConvertToFullApp"))
        .checkEditPermission()
        .checkQuickQuote()
        .checkNoBranchLocked()
        .checkNotStatus({PolicyPeriodStatus.TC_DECLINED, PolicyPeriodStatus.TC_NOTTAKEN})
  }

  /**
   * Converts the submission from a "Quick Quote" to a "Full Application".
   * Also invalidates (but preserves) existing quotes on the policy period.
   * Make calling period selected version.
   */
  function convertToFullApp() {
    canConvertToFullApp().assertOkay()
    Job.QuoteType = TC_FULL
    Job.ActivePeriods.each(\ pp -> pp.editIfRatedOrQuoted())
  }

  /**
   * Checks the conditions for which the policy period can be bound.
   */
  override function canBind() : JobConditions {
    return canFinishBind(super.canBind())
        .checkFullApp()
  }

  /**
   * Binds the branch without issuing or billing for the policy.
   */
  function bindOnly() {
    Job.BindOption = TC_BINDONLY
    bind()
  }

  /**
   * Gets the job specific activity pattern for UW review activity
   *
   * @see ActivityPatternEnhancement
   */
  override protected property get UWReviewActivityPattern() : ActivityPattern {
    return ActivityPattern.finder.getActivityPatternByCode("approve_submission")
  }

  /**
   * Binds the branch and issues the policy.
   */
  function issue() {
    Job.BindOption = TC_BINDANDISSUE
    bind()
  }

  /**
   * Begins the bind process for the branch.  As a result, the policy period may be rejected
   * and declined, marked for review by an underwriter, or returned to draft for user edits.  If
   * successful, binding is started.
   *
   * To complete binding, call {@link finishBinding}.
   */
  override function bind() {
    try {
      JobProcessContextUpdater.updateContext(_branch)
      PCProfilerTag.BIND_CHECK_CAN_BIND.execute(\-> canBind().assertOkay())
      JobProcessLogger.logInfo("Attempting to bind branch: " + _branch)

      // Validate. If anything fails validation, throw an exception
      var alsoTryingToIssue = Job.BindOption == TC_BINDANDISSUE
      var validationLevel : ValidationLevel = alsoTryingToIssue ? TC_READYFORISSUE : TC_BINDABLE
      var blockingPoint : UWIssueBlockingPoint = alsoTryingToIssue ? TC_BLOCKSISSUANCE : TC_BLOCKSBIND

      PCProfilerTag.BIND_PREPARE_ACCOUNT_SYNCABLES.execute(\-> _branch.AllAccountSyncables.each(\a -> a.prepareForPromote()))
      PCProfilerTag.BIND_VALIDATE.execute(\-> JobProcessValidator.validatePeriodForUI(_branch, validationLevel))
      checkThatBasedOnPeriodNotArchivedInBillingSystem()
      PCProfilerTag.BIND_CHECK_UW_ISSUES.execute(\-> JobProcessEvaluator.evaluateAndCheckForBlockingUWIssues(_branch, blockingPoint))

      // Continue processing since nothing has gone wrong
      try {
        TransactionUtil.runAtomically(\bundle -> startBinding(), _branch)
      } catch (e : Exception) {
        PCLoggerCategory.JOB_PROCESS.error("Unable to issueSubmission", e)
        // the following exception is hardcoded at platform level and as per PC-30436 we're making it translatable
        // preemption check is invoked for all jobs so, theoretically, can be thrown for any transaction
        if ((e typeis IllegalArgumentException) && e.Message == "Cannot promote preempted branch") {
          throw new DisplayableException(DisplayKey.get("Job.Error.Preempted"))
        }
        throw e
      }
    }finally {
      JobProcessContextUpdater.clearContext()
    }
  }

  /**
   * Completes the binding of a PolicyPeriod without issuing it. This marks
   * the PolicyPeriod as bound and completes the job. If issuance is being held,
   * the branch will be promoted to the main PolicyPeriod. Branches with no hold
   * status must go through {@link #finishIssuing} to be promoted to the PolicyPeriod.
   * As of 8.0.4, this no longer does it's own commit.  If calling from other than {@link RewriteNewAccountProcess#startBinding()},
   * you need to ensure the changes are committed.
   */
  function finishBinding() {
    PCProfilerTag.BIND_CHECK_CAN_FINISH.execute(\-> {
      canFinishBind()
          .checkOnlyActivePeriod()
          .checkBranchNotLocked()
          .assertOkay()
    })
    JobProcessLogger.logInfo("Finish binding branch: " + _branch)

    PCProfilerTag.BIND_FINISH.execute(\ -> {
      _branch.PolicyTerm.Bound = true
      Job.Policy.Account.markContactsForAutoSync()
      Job.copyUsersFromJobToPolicy()
      Job.createCustomHistoryEvent(TC_SUB_BOUND, \ -> DisplayKey.get("Submission.History.JobBound"))
      _branch.Policy.OriginalEffectiveDate = _branch.PeriodStart
      if (Job.BindOption == TC_BINDANDISSUE) {
        PCProfilerTag.BIND_INFER_FORMS.execute(\ -> FormInferenceEngine.Instance.inferPreBindForms(_branch))
        PCProfilerTag.BIND_FINISH_ISSUANCE.execute(\ -> {
          _branch.Status = TC_BINDING
          _branch.bindAutoNumberSequences()
          _branch.updateEstimatedPremium()
          _branch.runSubmissionIssuanceLogic()

          // To make this work asynchronously, uncomment the call to add an event
          // and remove the call to finishIssuing() below.  Whatever responds to the
          // event must invoke finishIssuing() so that PolicyCenter can complete the
          // binding process.

          //_branch.addEvent("IssueSubmission")
          if (_branch.PersonalAutoLine.PolicyDrivers.hasMatch(\dri -> dri.EnabledForTap2Drive_Ext)) {
            for(driv in _branch.PersonalAutoLine.PolicyDrivers.where (\dri -> dri.EnabledForTap2Drive_Ext))  {
              if(driv.Tap2DriveRecord_Ext.Tap2DriveStatus == Tap2DriveStatus_Ext.TC_ENROLLED) {
                driv.addEvent (Tap2DriveConstants.TAP2DRIVE_ENROLL_EVENT)
              }
            }
          }
          finishIssuing()
        })
      } else {
        PCProfilerTag.BIND_HOLD_ISSUANCE.execute(\ -> {
          _branch.renumberAutoNumberSequences()
          _branch.updateEstimatedPremium()
          // If we're holding issuance, then remove all forms before promotion so
          // that the issuance job will re-generate them all from scratch
          _branch.removeAllNewlyAddedForms()
          finalizeBeforeIssuing()

          startChecksFor(DisplayKey.get("Job.Process.Submission.FinishBinding")).checkNoActivePeriods().assertOkay()

          finalizeBindIssue()

          JobProcessLogger.logInfo("Finish binding branch: " + _branch)
        })
      }
    })

    JobProcessContextUpdater.updateContext(_branch)
    IntentionalLogger.logResult(
        Marker,
        "Operation completed",
        LogMessageParams.create()
            .put("result.outcome", Job.BindOption.Code)
            .put("result.value", _branch.EstimatedPremium)
    )
    JobProcessContextUpdater.clearContext()
  }

  /**
   * Marks the branch for review by an underwriter. Call this when binding fails.
   */
  function failBinding() {
    canFailBind().assertOkay()
    JobProcessLogger.logInfo("Fail binding branch: " + _branch)
    Job.createProducerActivity(ActivityPattern.finder.getActivityPatternByCode("bind_failed"),
        DisplayKey.get("Submission.BindSubmission.Failed.Activity.Subject"),
        DisplayKey.get("Submission.BindSubmission.Failed.Activity.Description"))
    Job.autoAssignRole(TC_UNDERWRITER)

    JobProcessContextUpdater.updateContext(_branch)
    IntentionalLogger.logFail(Marker,DisplayKey.get("Submission.BindSubmission.Failed.Activity.Subject"))
    JobProcessContextUpdater.clearContext()
  }

  /**
   * Checks the conditions for which the policy period can be issued.
   * This set of conditions is the same as .canBind(), except for the
   *     security permission.
   */
  override function canIssue() : JobConditions {
    return super.canIssue()
        .checkFullApp()
  }

  /**
   * Successfully complete issuance of a PolicyPeriod by marking the PolicyPeriod as "Bound"
   * and completing the job.
   * As of 8.0.4, this no longer does it's own commit.  If calling from other than {@link RewriteNewAccountProcess#startBinding()},
   * you need to ensure the changes are committed.
   */
  function finishIssuing() {
    canFinishIssue(canIssue(DisplayKey.get("Job.Process.Submission.FinishIssuing")))
        .checkJobNotComplete()
        .assertOkay()

    finalizeBeforeIssuing()

    _branch.Policy.markIssued(Date.Today)

    startChecksFor(DisplayKey.get("Job.Process.Submission.FinishIssuing")).checkNoActivePeriods().assertOkay()

    finalizeBindIssue()

    JobProcessLogger.logInfo("Finish issuing branch: " + _branch)
  }

  override property get RecalculateDepositOnReportingAfterValidQuote() : boolean {
    return true
  }

  override function createBillingEventMessages() {
    _branch.addEvent(PolicyPeriod.CREATEPERIOD_EVENT)
  }

  /**
   * Sets the status of <code>PolicyPeriod</code> to review, to be called when issuing fails.
   */
  function failIssuing() {
    canFailIssue().assertOkay()
    JobProcessLogger.logInfo("Fail issuing branch: " + _branch)
    Job.createProducerActivity(ActivityPattern.finder.getActivityPatternByCode("issue_failed"),
        DisplayKey.get("Submission.IssuePolicy.Failed.Activity.Subject"),
        DisplayKey.get("Submission.IssuePolicy.Failed.Activity.Description"))
    Job.autoAssignRole(TC_UNDERWRITER)
    JobProcessContextUpdater.updateContext(_branch)
    IntentionalLogger.logFail(Marker,DisplayKey.get("Issuance.IssuePolicy.Failed.Subject"))
    JobProcessContextUpdater.clearContext()
  }


  // ===== TERMINAL FUNCTIONS =====

  /**
   * Indicates whether this submission can be declined by the insurer. Decline may not be allowed due
   * to a number of factors, including lack of permission or  currect status of one or
   * more active branches on the submission.
   */
  function canDeclineJob() : JobConditions {
    var conditions = startChecksFor(DisplayKey.get("Job.Process.Submission.DeclineJob"))
        .checkPermission(Permissions.Decline)
        .checkJobNotComplete()

    // all branches on job must be able to be declined
    Job.ActivePeriods.each(\branch -> conditions.append(branch.SubmissionProcess.canDecline()))
    return conditions
  }

  /**
   * Indicates whether a period can be declined by the insured.
   */
  function canDecline() : JobConditions {
    return startChecksFor(DisplayKey.get("Job.Process.Submission.Decline"))
        .checkPermission(Permissions.Decline)
        .checkNotPromoted()
        .checkNotStatus(PolicyPeriodStatus.TF_QUOTEINPROGRESS)
  }

  /**
   * Declines all active policy periods in the job, and sets the selected version of the job to
   * the branch from which the decline was started.
   */
  function declineJob() {
    canDeclineJob().assertOkay()
    this.cancelOpenActivities()
    // decline all branches, bypassing check of conditions since we just did that
    Job.ActivePeriods.each(\ branch -> branch.SubmissionProcess.declineWithoutCheckingConditions())
    Job.SelectedVersion = _branch
  }

  /**
   * Declines this policy period, resetting the selected version of the job if needed.
   */
  function decline() {
    canDecline().assertOkay()
    declineWithoutCheckingConditions()
  }

  private function declineWithoutCheckingConditions() {
    clearAllAsyncQuoteIssues()
    lockBranchWithStatus(TC_DECLINED)
  }

  /**
   * Checks the conditions for which the Job can be rejected by the insured (i.e., "not taken").
   */
  function canNotTakeJob() : JobConditions {
    var conditions = startChecksFor(DisplayKey.get("Job.Process.Submission.NotTakeJob"))
        .checkPermission(Permissions.NotTaken)
        .checkJobNotComplete()
        .checkNotStatus(PolicyPeriodStatus.TF_QUOTEINPROGRESS)

    // all branches on job must be able to be not taken
    Job.ActivePeriods.each(\ branch -> conditions.append(branch.SubmissionProcess.canNotTake()))
    return conditions
  }

  /**
   * Indicates whether a branch can be not taken.
   */
  function canNotTake() : JobConditions {
    return startChecksFor(DisplayKey.get("Job.Process.Submission.NotTake"))
        .checkPermission(Permissions.NotTaken)
        .checkBranchNotLocked()
        .checkNotPromoted()
  }

  /**
   * Not takes all active policy periods in the job, and sets the selected version of the job to
   * the branch from which the not taken was started.
   */
  function notTakeJob() {
    canNotTakeJob().assertOkay()
    this.cancelOpenActivities()
    Job.ActivePeriods.each(\ branch -> branch.SubmissionProcess.notTakeWithoutCheckingConditions())
    Job.SelectedVersion = _branch
  }

  /**
   * Not takes this policy period, resetting the selected version of the job if needed.
   */
  function notTake() {
    canNotTake().assertOkay()
    notTakeWithoutCheckingConditions()
  }

  // useful to eliminate redundant checks because notTakeJob already check canNotTake for each of the branches
  private function notTakeWithoutCheckingConditions() {
    clearAllAsyncQuoteIssues()
    lockBranchWithStatus(TC_NOTTAKEN)
  }

  /**
   * Withdraws this Job and adds a notification message.
   */
  override function withdrawJob() {
    super.withdrawJob()
    Job.createProducerActivity(ActivityPattern.finder.getActivityPatternByCode("notification"),
        DisplayKey.get("Submission.Withdrawn.Activity.Subject"),
        DisplayKey.get("Submission.Withdrawn.Activity.Description"))
  }

  function beforePeriodStartChanged(newValue : Date) {
    _branch.Lines.each(\line -> line.prePeriodStartChanged(newValue))
  }

  private function startBinding() {
    JobProcessLogger.logInfo("Binding branch: " + _branch)

    PCProfilerTag.BIND_START.execute(\ -> {
      // only bind one period (matters in the case of multiquote)
      withdrawOtherActivePeriods()
      _branch.updateTermNumber()
      _branch.PolicyNumber = _branch.genNewPeriodPolicyNumber()

      if (Job.BindOption != TC_BINDANDISSUE) {
        Job.createRoleActivity(TC_UNDERWRITER, ActivityPattern.finder.getActivityPatternByCode("issue_policy"),
            DisplayKey.get("Submission.NotIssued.Activity.Subject"),
            DisplayKey.get("Submission.NotIssued.Activity.Description"))
      }

      _branch.Status = TC_BINDING
      _branch.properlySetTransactionFlags()
    })

    // To make this work asynchronously, uncomment the call to add an event
    // and remove the call to finishBinding() below.  Whatever responds to the
    // event must invoke finishBinding() so that PolicyCenter can complete the
    // binding process.

    //_branch.addEvent("BindSubmission")
    finishBinding()
  }

  // These tests depend on the commit ordering in the finalization
  // methods:  JobProcessTest, RenewalLossClaimsTest, PolicyImplTest,
  // UWIssueApprovalExpirationTest
  //
  private function finalizeBeforeIssuing() {
    prepareBranchForFinishingJob()
    createBillingEventMessages()
    _branch.scheduleAllAudits()
    _branch.updatePolicyTermDepositAmount()
  }

  private function finalizeBindIssue() {
    // run this before promoteBranch because it has more chance of failing
    bindReinsurableRisks() // flags Activity on error...

    _branch.promoteBranch(false)
  }

  override function issueJob(bindAndIssue : boolean) {
    _branch.onBeginIssueJob()
    if (bindAndIssue) {
      issue()
    } else {
      bindOnly()
    }
  }

}
