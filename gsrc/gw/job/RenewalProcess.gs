package gw.job

uses com.tap2drive.constants.Tap2DriveConstants
uses gw.api.job.JobProcessLogger
uses gw.api.locale.DisplayKey
uses gw.api.system.PCLoggerCategory
uses gw.api.system.PLLoggerCategory
uses gw.api.util.DisplayableException
uses gw.api.validation.EntityValidationException
uses gw.api.web.job.JobWizardHelper
uses gw.api.web.util.TransactionUtil
uses gw.forms.FormInferenceEngine
uses gw.job.permissions.RenewalPermissions
uses gw.job.uw.UWAuthorityBlocksProgressException
uses gw.lang.reflect.ReflectUtil
uses gw.lob.common.Tap2DriveUtil
uses gw.plugin.Plugins
uses gw.plugin.job.IPolicyRenewalPlugin
uses gw.plugin.messaging.BillingMessageTransport
uses gw.plugin.notification.INotificationPlugin

/**
 * Encapsulates the actions taken within a Renewal job.  The renewal process is
 * one of the most complicated because it involves a combination of automated
 * and manual processing.  Some portions are handled asynchronously, and
 * workflow is used to control the timing of key events.
 *
 * @see gw.job.JobProcess for general information and job process logic.
 * @see gw.plugin.policyperiod.impl.JobProcessCreationPlugin
 */
@Export
class RenewalProcess extends NewTermProcess implements IRenewalProcess {
  private var _timeoutHandler : RenewalProcessTimeoutHandler
  static var _logger = PLLoggerCategory.APPLICATION
  construct(period : PolicyPeriod) {
    this(period, RenewalProcessTimeoutHandler.STANDARD_INSTANCE)
  }

  construct(period : PolicyPeriod, timeoutHandler : RenewalProcessTimeoutHandler) {
    super(period, new RenewalPermissions(period.Job))
    _timeoutHandler = timeoutHandler
    JobProcessEvaluator = JobProcessUWIssueEvaluator.forRenewal()
  }

  override property get Job() : Renewal {
    return super.Job as Renewal
  }

  property get ActiveRenewalWorkflow() : PolicyPeriodWorkflow {
    var workflow = _branch.ActiveWorkflow
    return (workflow == null or workflow.State == TC_COMPLETED) ? null : workflow
  }

  override property get RecalculateDepositOnReportingAfterValidQuote() : boolean {
    return true
  }

  override function createBillingEventMessages() {
    _branch.addEvent(PolicyPeriod.RENEWPERIOD_EVENT)
  }

  /**
   * Checks the conditions for which a search for data to copy into the policy can be started
   */
  override function canStartCopyPolicyData() : JobConditions {
    return internalCanStartCopyPolicyData()
  }

  // ===== LIFECYCLE FUNCTIONS =====

  /**
   * Checks the conditions for starting a renewal.
   */
  function canStart() : JobConditions {
    return canStartJob(DisplayKey.get("Job.Process.Renewal.StartOrAssign"))
        .checkNotNull(_branch.PeriodStart, DisplayKey.get("Job.Renewal.Process.PeriodStartNotSet"))
        .checkNotNull(_branch.PeriodEnd, DisplayKey.get("Job.Renewal.Process.PeriodEndNotSet"))
  }

  /**
   * Initializes the renewal, starting the StartRenewalWF workflow.
   */
  override function start() {
    canStart().assertOkay()
    startJobAsNew()
    JobProcessLogger.logInfo("Starting renewal for branch: " + _branch)

    if (Job.ActivePeriods.Count == 1) {
      initialize()
      JobProcessLogger.logInfo("Starting renewal workflow for branch: " + _branch)
      //Tap2Drive Changes
      for(policyDriver in _branch.PersonalAutoLine.PolicyDrivers) {
        if(policyDriver.Tap2DriveRecord_Ext.Tap2DriveStatus == Tap2DriveStatus_Ext.TC_ENROLLED) {
          _logger.info("Calling FetchScore during renewal on driver :" + policyDriver.PublicID )
          var driverID = policyDriver.Tap2DriveRecord_Ext.UniqueDriverID
          var enrolledDate = policyDriver.Tap2DriveRecord_Ext.EnrolledDate
          var endDate = _branch.EditEffectiveDate
          Tap2DriveUtil.removeTap2DriveRecords(_branch)
          var Tap2DriveResponse = Tap2DriveUtil.invokeFetchDriverScores(Tap2DriveUtil.createAddScorePayload(driverID,enrolledDate,endDate))
          _branch.updateDriverScore(policyDriver, Tap2DriveResponse)
        }
      }
    } else {
      // multiquote
      _branch.edit()
    }
  }

  /**
   * Initializes the renewal.  This method is only ever called on the first renewal, but not on any subsequent multiquotes
   * based on that renewal.
   */
  function initialize() {
    var producerCode = Job.Policy.ProducerCodeOfService
    if (producerCode != null) {
      _branch.EffectiveDatedFields.ProducerCode = producerCode
      _branch.ProducerCodeOfRecord = producerCode
    }
    _branch.PolicyNumber = _branch.genNewPeriodPolicyNumber()
    _branch.cloneAutoNumberSequences()
    _branch.resetAutoNumberSequences()
    _branch.expireNextChangeApprovals()
    _branch.expireEndOfTermApprovals()
    _branch.expirePastDateApprovals()
    _branch.Lines.each(\l -> l.onRenewalInitialize())
  }

  // ---------------------------------------------------------- Job escalation

  /**
   * Checks the conditions for escalating the job.
   */
  function canEscalate() : JobConditions {
    return startChecksFor(DisplayKey.get("Job.Process.Renewal.JobEscalation"))
        .checkBranchNotLocked()
  }

  /**
   * Escalates the job.
   */
  function escalate(subject : String, description : String) {
    canEscalate().assertOkay()
    JobProcessLogger.logInfo("Escalating renewal branch: " + _branch)
    Job.createCustomHistoryEvent(TC_RENEWAL, \ -> DisplayKey.get("Job.Renewal.History.Escalated", _branch.BranchName, _branch.Status))

    // By default the pre-renewal owner should be assigned the escalation activity.
    var preRenewalOwner = _branch.Renewal.getUserRoleAssignmentByRole(TC_PRERENEWALOWNER).AssignedUser
    if (preRenewalOwner != null) {
      Job.createRoleActivity(TC_PRERENEWALOWNER, ActivityPattern.finder.getActivityPatternByCode("open_eval_issue"), subject, description, preRenewalOwner)
    } else {
      Job.createRoleActivity(TC_UNDERWRITER, ActivityPattern.finder.getActivityPatternByCode("open_eval_issue"), subject, description)
    }
    _branch.Status = _branch.ValidQuote ? TC_QUOTED : _branch.ValidRate ? TC_RATED : TC_DRAFT
  }

  // ---------------------------------------------------------- Manual quoting

  /**
   * Checks the conditions for manually quoting the renewal.
   */
  function canManuallyQuote() : JobConditions {
    return startChecksFor(DisplayKey.get("Job.Process.Renewal.ManuallyQuote"))
        .checkBranchNotLocked()
        .checkQuotePermission()
        .checkDraft()
        .checkNotQuoted()
        .checkNoUnhandledPreemptions()
        .checkEditPermission()
  }

  // ---------------------------------------------------------- Immediate Issue (UI button)

  /**
   * Checks the conditions for binding immediately.
   */
  function canIssueNow() : JobConditions {
    return startChecksFor(DisplayKey.get("Job.Process.Renewal.ImmediateBind"))
        .checkAdvancePermission()
        .checkPermission(Permissions.Renew)
        .checkQuoteIsValid()
        .checkStatus(TC_QUOTED)
        .checkBranchNotLocked()
        .checkNoUnhandledPreemptions()
        .checkIsOnlyPendingPeriod()
  }

  /**
   * Immediately binds the policy period.
   */
  function issueNow() {
    canIssueNow().assertOkay()
    JobProcessLogger.logInfo("Immediately issuing renewal branch: " + _branch)
    Job.createCustomHistoryEvent(TC_RENEWAL, \ -> DisplayKey.get("Job.Renewal.History.Button.ImmediateIssue", _branch.BranchName))
    unconditionalIssueRenewal()
  }

  // ---------------------------------------------------------- Pending non-renew (UI button)

  /**
   * Checks the conditions for pending non-renew.
   */
  function canPendingNonRenew() : JobConditions {
    return startChecksFor(DisplayKey.get("Job.Process.Renewal.PendingNonRenew"))
        .checkPermission(Permissions.NonRenew)
        .checkBranchNotLocked()
        .checkNoUnhandledPreemptions()
        .checkStatus({TC_DRAFT, TC_RATED, TC_QUOTED})
        .checkIsOnlyPendingPeriod()
  }

  /**
   * Puts policy period in "NonRenewing" status and starts the PendingNonRenewalWF workflow.
   */
  function pendingNonRenew() {
    canPendingNonRenew().assertOkay()
    JobProcessLogger.logInfo("Pending non-renew for renewal branch: " + _branch)
    Job.createCustomHistoryEvent(TC_RENEWAL, \ -> DisplayKey.get("Job.Renewal.History.Button.PendingNonRenew", _branch.BranchName, _branch.Status))
    schedulePendingNonRenewal()
  }

  // ---------------------------------------------------------- Pending not taken (UI button)

  /**
   * Checks the conditions for pending not taken.
   */
  function canPendingNotTaken() : JobConditions {
    return startChecksFor(DisplayKey.get("Job.Process.Renewal.PendingNotTaken"))
        .checkPermission(Permissions.NotTaken)
        .checkBranchNotLocked()
        .checkNoUnhandledPreemptions()
        .checkStatus({TC_DRAFT, TC_RATED, TC_QUOTED})
        .checkIsOnlyPendingPeriod()
  }

  /**
   * Puts policy period in "NotTaking" status and starts the PendingNotTakenWF workflow.
   */
  function pendingNotTaken() {
    canPendingNotTaken().assertOkay()
    JobProcessLogger.logInfo("Pending not-taken for renewal branch: " + _branch)
    Job.createCustomHistoryEvent(TC_RENEWAL, \ -> DisplayKey.get("Job.Renewal.History.Button.PendingNotTaken", _branch.BranchName, _branch.Status))
    schedulePendingNotTaken()
  }

  // ---------------------------------------------------------- Pending renew (UI button)

  /**
   * Checks the conditions for pending renew.
   */
  function canPendingRenew() : JobConditions {
    return startChecksFor(DisplayKey.get("Job.Process.Renewal.PendingRenew"))
        .checkAdvancePermission()
        .checkPermission(Permissions.Renew)
        .checkBranchNotLocked()
        .checkQuoteIsValid()
        .checkStatus(TC_QUOTED)
        .checkNoUnhandledPreemptions()
        .checkIsOnlyPendingPeriod()
  }

  /**
   * Puts policy period in "Renewing" status and starts the PendingRenewalWF workflow.
   */
  function pendingRenew() {
    canPendingRenew().assertOkay()
    JobProcessLogger.logInfo("Pending renew for renewal branch: " + _branch)
    Job.createCustomHistoryEvent(TC_RENEWAL, \ -> DisplayKey.get("Job.Renewal.History.Button.PendingRenewal", _branch.BranchName, _branch.Status))
    schedulePendingRenewal()
  }

  // ---------------------------------------------------------- Edit Policy (UI button)

  /**
   * Custom list of statuses for Renewals from which a policy period can
   * be switched into edit mode
   */
  override protected property get AllowedEditStatus() : PolicyPeriodStatus[] {
    return {TC_NEW, TC_QUOTED, TC_RATED, TC_RENEWING, TC_NONRENEWING, TC_NOTTAKING}
  }

  /**
   * Checks the conditions for which the policy period can be switched to edit mode ("Draft" status).
   */
  override function canEdit() : JobConditions {
    return super.canEdit()
        .checkNull(Job.RenewalNotifDate, DisplayKey.get("Job.Renewal.Process.AlreadyHasRenewalNotificationDate"))
        .checkNull(ActiveRenewalWorkflow, DisplayKey.get("Job.Renewal.Process.HasActiveRenewalWorkflow"))
  }

  // ---------------------------------------------------------- New Version (UI button)

  /**
   * Checks the conditions for which a new version of the policy period can be created.
   */
  override function canMakeNewVersion() : JobConditions {
    var jobConditions = super.canMakeNewVersion()
    if (not Job.SideBySide) {
      // This check prevents multi-version creation of policy periods on 'Renewing'
      // status and only allows it for rated and quoted renewal jobs.
      jobConditions.checkStatus({TC_RATED, TC_QUOTED})
    }
    return jobConditions
  }

  // ---------------------------------------------------------- Edit Policy (from the workflow)

  /**
   * Checks the conditions for which the policy period can be switched to edit mode from workflow.
   */
  function canEditFromWorkflow() : JobConditions {
    return startChecksFor(DisplayKey.get("Job.Process.Renewal.EditInWorkflow"))
        .checkEditPermission()
        .checkBranchNotLocked()
        .checkNotNull(ActiveRenewalWorkflow, DisplayKey.get("Job.Renewal.Process.NoActiveRenewalWorkflow"))
  }

  /**
   * Switches policy period to edit mode.
   */
  function editFromWorkflow() {
    canEditFromWorkflow().assertOkay()
    JobProcessLogger.logInfo("Editing branch: " + _branch)
    Job.createCustomHistoryEvent(TC_RENEWAL, \ -> DisplayKey.get("Job.Renewal.History.Button.EditFromWorkflow", _branch.BranchName, _branch.Status))
    _branch.edit()
  }

  // ---------------------------------------------------------- Withdraw (UI button)

  /**
   * Check the conditions for which this policy period can be withdrawn.
   */
  override function canWithdraw() : JobConditions {
    return super.canWithdraw()
        .checkNull(Job.RenewalNotifDate, DisplayKey.get("Job.Renewal.Process.AlreadyHasRenewalNotificationDate"))
        .check(this.ActiveRenewalWorkflow == null or this.ActiveRenewalWorkflow.isTriggerAvailable(TC_WITHDRAW),
            DisplayKey.get("Job.Renewal.Process.WorkflowNotInAStateThatAllowsWithdraw"))
        .checkStatus(new PolicyPeriodStatus[] {TC_NEW, TC_RENEWING, TC_NONRENEWING, TC_NOTTAKING, TC_DRAFT, TC_RATED, TC_QUOTED})
  }

  override function withdrawWithoutCheckingConditions() {
    Job.createCustomHistoryEvent(TC_RENEWAL, \ -> DisplayKey.get("Job.Renewal.History.Withdrawn", _branch.BranchName, _branch.Status))
    if (this.ActiveRenewalWorkflow != null) {
      this.ActiveRenewalWorkflow.invokeTrigger(TC_WITHDRAW)
    }

    super.withdrawWithoutCheckingConditions()
  }

  // ---------------------------------------------------------- Additional checks for UI buttons

  /**
   * Throws an exception if there are open cancellations.
   */
  function assertNoOpenCancellations() {
    if (Job.hasOpenCancellationInPriorPeriod()) {
      throw new DisplayableException(DisplayKey.get("Web.Renewal.Warning.OpenCancellation"))
    }
  }

  /**
   * Throws an exception if non-renewal is allowed.
   */
  function assertNonRenewLeadTime() {
    if (not this.canNonRenew()) {
      throw new DisplayableException(DisplayKey.get("Web.Renewal.Warning.NonRenewLeadTime"))
    }
  }

  // ---------------------- Automated Flow

  /**
   * Handles automatic set up of a renewal.  Out of the box, this is invoked by the
   * StartRenewalWF workflow.
   */
  function beginAutomaticRenewal() {
    canStart().assertOkay()
    JobProcessLogger.logInfo("Beginning automated renewal for branch: " + _branch)

    updatePeriodOnBeginRenewal()
    checkProductAvailability()

    // decide what to do with renewal based on pre-renewal direction
    var preRenewalDirection = _branch.BasedOn.PolicyTerm.PreRenewalDirection
    if (preRenewalDirection == TC_NONRENEW) {
      startPendingNonRenewal()
    } else if (preRenewalDirection == TC_NOTTAKEN) {
      startPendingNotTaken()
    } else if (preRenewalDirectionRequestsReferral()) {

      // an underwriter needs to take a look
      if (preRenewalDirection == TC_NONRENEWREFER) {
        var reasonChecker = new EscalationReasonChecker(TC_NONRENEWING)
            .addCustomError(DisplayKey.get("Job.Renewal.Escalation.Reason.NonRenewalRefer"))
        escalate(reasonChecker.ActivitySubject, reasonChecker.ActivityDescription)
      } else {
        var reasonChecker = new EscalationReasonChecker(TC_RENEWING)
            .addCustomError(DisplayKey.get("Job.Renewal.Escalation.Reason.ReferralRequested", preRenewalDirection))
        escalate(reasonChecker.ActivitySubject, reasonChecker.ActivityDescription)
      }
    } else {
      startPendingRenewal()
    }
  }

  function updatePeriodOnBeginRenewal() {
    Job.assignRolesFromPolicy()
    if(_branch.BasedOn == null or _branch.BasedOn.Status == PolicyPeriodStatus.TC_LEGACYCONVERSION) {
      _branch.Job.assignUnderwriter()
    }
    _branch.Renewal.addToGroup()
    ReflectUtil.invokeStaticMethod("rules.Renewal.RenewalAutoUpdate", "invoke", {_branch})

    var issues = JobProcess.checkBranchAgainstProductModel(_branch)
    // fix issues and log events for them
    issues.fixDuringQuoteIfNecessary(_branch, \ fixedIssue -> Job.createCustomHistoryEvent(TC_RENEWAL,
        \ -> DisplayKey.get("Job.Renewal.History.FixedProductModelIssue", Job.JobNumber, fixedIssue.BaseMessage))
    )
    _branch.runSegmentationRules()
  }

  protected property get PreRenewalDirectionBlocksPendingRenewal() : boolean {
    return new PreRenewalDirection[] {TC_NONRENEW, TC_NOTTAKEN}.contains(_branch.BasedOn.PolicyTerm.PreRenewalDirection)
        or preRenewalDirectionRequestsReferral()
  }

  protected property get IsProductAvailable() : boolean {
    return _branch.Policy.Account.getAvailableProduct(_branch.PolicyProductRoot, _branch.Policy.Product) != null
  }

  protected function checkProductAvailability() {
    if (not (PreRenewalDirectionBlocksPendingRenewal or IsProductAvailable)) {
      _branch.BasedOn.PolicyTerm.PreRenewalDirection = TC_NONRENEW
      Job.createCustomHistoryEvent(TC_RENEWAL, \ -> DisplayKey.get("Job.Renewal.History.PreRenewalDirection.PendingNonRenewal", _branch.BranchName))
      _branch.addNote(TC_PRERENEWAL,
          DisplayKey.get("Web.Renewal.Warning.NonRenewReason"),
          DisplayKey.get("Web.Renewal.Warning.NonRenewProductNotAvailable", _branch.Policy.Product,
              _branch.BaseState,
              _branch.PeriodStart))
    }
  }

  // -------------- Renewal Automated Flow

  protected function startPendingRenewal() {
    var escalationReasonChecker = new EscalationReasonChecker(TC_RENEWING)
        .checkForOpenCancellationInPriorPeriod()
        .checkForUnhandledPreemptions()
    if (escalationReasonChecker.ShouldEscalate) {
      escalate(escalationReasonChecker.ActivitySubject, escalationReasonChecker.ActivityDescription)
    } else {
      try {
        requestQuote(null as JobWizardHelper, ValidationLevel.TC_QUOTABLE, RatingStyle.TC_DEFAULT, false)
        if (_branch.ValidQuote) {
          JobProcessLogger.logInfo("Quoting succeeded for renewal on branch: " + _branch)
          Job.createCustomHistoryEvent(TC_RENEWAL, \ -> DisplayKey.get("Job.Renewal.History.Quoted", _branch.BranchName))
          escalationReasonChecker = shouldEscalatePendingRenewal()
          if (escalationReasonChecker.ShouldEscalate) {
            escalate(escalationReasonChecker.ActivitySubject, escalationReasonChecker.ActivityDescription)
          } else {
            schedulePendingRenewal()
          }
        } else {
          JobProcessLogger.logInfo("Quoting failed for renewal on branch: " + _branch)
          var reasonChecker = new EscalationReasonChecker(TC_RENEWING)
              .addCustomError(DisplayKey.get("Job.Renewal.Escalation.Reason.InvalidQuote"))
          escalate(reasonChecker.ActivitySubject, reasonChecker.ActivityDescription)
        }
      } catch (e : EntityValidationException) {
        JobProcessLogger.logDebug("Exception in startPendingRenewal for branch: " + _branch, e)
        var reasonChecker = new EscalationReasonChecker(TC_RENEWING)
            .addCustomError(DisplayKey.get("Job.Renewal.Escalation.Reason.ValidationErrors"))
        escalate(reasonChecker.ActivitySubject, reasonChecker.ActivityDescription)
      } catch (e : UWAuthorityBlocksProgressException) {
        JobProcessLogger.logDebug("Exception in startPendingRenewal for branch: " + _branch, e)
        var reasonChecker = new EscalationReasonChecker(TC_RENEWING)
            .addCustomError(DisplayKey.get("Job.Renewal.Escalation.Reason.UWIssues"))
        escalate(reasonChecker.ActivitySubject, reasonChecker.ActivityDescription)
      } catch (e : Exception) {
        JobProcessLogger.logWarning("Exception in startPendingRenewal for branch: " + _branch, e)
        var reasonChecker = new EscalationReasonChecker(TC_RENEWING)
            .addCustomError(DisplayKey.get("Job.Renewal.Escalation.Reason.Other"))
        escalate(reasonChecker.ActivitySubject, reasonChecker.ActivityDescription)
      }
    }
  }

  /**
   * Schedules the first check for a pending renewal.
   */
  protected function schedulePendingRenewal() {
    _branch.Status = TC_RENEWING
    Job.SelectedVersion = _branch
    _timeoutHandler.scheduleTimeoutOperation(_branch, PendingRenewalFirstCheckDate, "pendingRenewalFirstCheck", false)
  }

  protected property get PendingRenewalFirstCheckDate() : Date {
    return _branch.PeriodStart.addDays(-80)
  }

  /**
   * Looks for a reason to escalate the renewal to an underwriter.  If not, schedules the final check.
   */
  function pendingRenewalFirstCheck() {
    var escalationReasonChecker = shouldEscalatePendingRenewal()
    if (escalationReasonChecker.ShouldEscalate) {
      escalate(escalationReasonChecker.ActivitySubject, escalationReasonChecker.ActivityDescription)
    } else {
      _timeoutHandler.scheduleTimeoutOperation(_branch, PendingRenewalFinalCheckDate, "pendingRenewalFinalCheck", false)
    }
  }

  protected property get PendingRenewalFinalCheckDate() : Date {
    return _branch.PeriodStart.addDays(-75)
  }

  /**
   * Looks for a reason to escalate the renewal to an underwriter.  If not, proceeds to finalize
   * the renewal.
   */
  function pendingRenewalFinalCheck() {
    var escalationReasonChecker = shouldEscalatePendingRenewal()
    if (escalationReasonChecker.ShouldEscalate) {
      escalate(escalationReasonChecker.ActivitySubject, escalationReasonChecker.ActivityDescription)
    } else {
      if (Job.RenewalNotifDate == null) {
        sendRenewalDocuments()
      }
      var plugin = Plugins.get(IPolicyRenewalPlugin)
      if(plugin.isRenewalOffered(_branch)){
        _timeoutHandler.scheduleTimeoutOperation(_branch, SendNotTakenDate, "sendNotTakenForRenewalOffer", true)
      }else{
        _timeoutHandler.scheduleTimeoutOperation(_branch, IssueAutomatedRenewalDate, "issueAutomatedRenewal", false)
      }
    }
  }

  protected property get IssueAutomatedRenewalDate() : Date {
    return _branch.PeriodStart.addDays(-35)
  }

  /**
   * Checks the conditions for sending renewal documents.
   */
  function canSendRenewalDocuments() : JobConditions {
    return startChecksFor(DisplayKey.get("Job.Process.Renewal.SendRenewalDoc"))
        .checkBranchNotLocked()
        .checkQuoteIsValid()
        .checkStatus(TC_RENEWING)
  }

  /**
   * Sends renewal documents.
   */
  function sendRenewalDocuments() {
    canSendRenewalDocuments().assertOkay()
    JobProcessLogger.logInfo("Sending renewal documents for renewal branch: " + _branch)

    Job.RenewalNotifDate = Date.CurrentDate
    Job.RenewalCode = TC_GOODRISK
    _branch.addEvent("SendRenewalDocuments")
  }

  /**
   * Checks the conditions for binding the renewal.
   */
  function canIssueAutomatedRenewal() : JobConditions {
    return startChecksFor(DisplayKey.get("Job.Process.Renewal.IssueRenewal"))
        .checkBranchNotLocked()
        .checkQuoteIsValid()
  }

  /**
   * Wraps the call to unconditionalIssueRenewal in error handling logic that escalates if validation or evaluation
   * fails.
   */
  function issueAutomatedRenewal() {
    try {
      canIssueAutomatedRenewal().assertOkay()
      _branch.onBeginIssueJob()
      unconditionalIssueRenewal()
    } catch (e : EntityValidationException) {
      var reasonChecker = new EscalationReasonChecker(TC_RENEWING)
          .addCustomError(DisplayKey.get("Job.Renewal.Escalation.Reason.ValidationErrors"))
      escalate(reasonChecker.ActivitySubject, reasonChecker.ActivityDescription)
    } catch (e : UWAuthorityBlocksProgressException) {
      var reasonChecker = new EscalationReasonChecker(TC_RENEWING)
          .addCustomError(DisplayKey.get("Job.Renewal.Escalation.Reason.UWIssues"))
      escalate(reasonChecker.ActivitySubject, reasonChecker.ActivityDescription)
    } catch (e : Throwable) {
      var reasonChecker = new EscalationReasonChecker(TC_RENEWING)
          .addCustomError(DisplayKey.get("Job.Renewal.Escalation.Reason.Other"))
      escalate(reasonChecker.ActivitySubject, reasonChecker.ActivityDescription)
    }
  }

  /**
   * Binds the renewal.
   */
  protected function unconditionalIssueRenewal() {
    JobProcessLogger.logInfo("Binding renewal branch: " + _branch)

    _branch.AllAccountSyncables.each(\a -> a.prepareForPromote())

    // Final validation and checking of UW Issues
    JobProcessValidator.validatePeriodForUI(_branch, TC_READYFORISSUE, false)
    checkThatBasedOnPeriodNotArchivedInBillingSystem()
    JobProcessEvaluator.evaluateAndCheckForBlockingUWIssues(_branch, TC_BLOCKSISSUANCE)

    try {
      TransactionUtil.runAtomically(\ bundle -> {
        _branch.properlySetTransactionFlags()
        _branch.ensureProducerOfService()
        _branch.ensureProducerOfRecord()
        withdrawOtherActivePeriods()      // probably should be moved down too
        _branch.bindAutoNumberSequences()
        _branch.updateEstimatedPremium()

        startChecksFor(DisplayKey.get("Job.Process.Renewal.FinishRenewal")).checkOnlyActivePeriod().assertOkay()
        FormInferenceEngine.Instance.inferPreBindForms(_branch)
        Job.createCustomHistoryEvent(TC_RENEWAL, \ -> DisplayKey.get("Job.Renewal.History.Issued", _branch.BranchName))
        prepareBranchForFinishingJob()
        if (_branch.BasedOn != null) {
          _branch.BasedOn.PolicyTerm.removePreRenewalDirection()
          if (_branch.BasedOn.Status == PolicyPeriodStatus.TC_LEGACYCONVERSION
              and not _branch.Policy.Issued) {
            _branch.Policy.markIssued(Date.Today)
          }
        }
        _branch.addEvent("IssueRenewal")
        // if is renewal confirm, set bound to be false to wait for confirmation.
        var plugin = Plugins.get(IPolicyRenewalPlugin)
        _branch.PolicyTerm.Bound = not plugin.doesRenewalRequireConfirmation(_branch)

        bindReinsurableRisks() // flags Activity on error...

      /* Escalation will be performed by callers on error, but cannot occur once the
       * branch has been promoted.  So promote last after any other actions whose
       * errors or exceptions should be escalated (and don't depend on promotion)...
       */

        createBillingEventMessages()
        _branch.scheduleAllAudits()
        _branch.Job.copyUsersFromJobToPolicy()
        _branch.Policy.Account.markContactsForAutoSync()
        _branch.updatePolicyTermDepositAmount()
        _branch.promoteBranch(false)
      }, _branch)
    } catch (e : Exception) {
      PCLoggerCategory.JOB_PROCESS.error("Unable to issueRenewal", e)
      // the following exception is hardcoded at platform level and as per PC-30436 we're making it translatable
      // preemption check is invoked for all jobs so, theoretically, can be thrown for any transaction
      if ((e typeis IllegalArgumentException) && e.Message == "Cannot promote preempted branch") {
        throw new DisplayableException(DisplayKey.get("Job.Error.Preempted"))
      }
      throw e
    }
  }

  /**
   * Raises issues if needed for pending renewal.
   */
  protected function shouldEscalatePendingRenewal() : EscalationReasonChecker {
    JobProcessLogger.logInfo("Running checks for pending renewal in branch: " + _branch)

    // Make sure to evaluate UW issues first, so any issues will be raised even if we have unhandled preemptions
    // or validation issues

    return new EscalationReasonChecker(TC_RENEWING)
        .checkForUWIssues()
        .checkForOpenCancellationInPriorPeriod()
        .checkForUnhandledPreemptions()
        .checkForValidationIssues()
  }

  protected function preRenewalDirectionRequestsReferral() : boolean {
    var preRenewalDirection = _branch.BasedOn.PolicyTerm.PreRenewalDirection
    return preRenewalDirection == TC_UNDERWRITER or
        preRenewalDirection == TC_ASSISTANT or
        preRenewalDirection == TC_CUSTREP or
        preRenewalDirection == TC_NONRENEWREFER
  }

  protected function preSchedulePendingRenewal() {
    assertNoOpenCancellations()
    _branch.onBeginIssueJob()
    JobProcessValidator.validatePeriodForUI(_branch, TC_READYFORISSUE, false)
    JobProcessEvaluator.evaluateAndCheckForBlockingUWIssues(_branch, TC_BLOCKSISSUANCE)
  }

  // --------------------- Non Renewal Automated Flow

  protected function startPendingNonRenewal() {
    var escalationReasonChecker = shouldEscalateNonRenewal()
    if (escalationReasonChecker.ShouldEscalate) {
      escalate(escalationReasonChecker.ActivitySubject, escalationReasonChecker.ActivityDescription)
    } else {
      Job.createCustomHistoryEvent(TC_RENEWAL, \ -> DisplayKey.get("Job.Renewal.History.PreRenewalDirection.PendingNonRenewal", _branch.BranchName))
      schedulePendingNonRenewal()
    }
  }

  protected function schedulePendingNonRenewal() {
    _branch.Status = TC_NONRENEWING
    Job.SelectedVersion = _branch
    _timeoutHandler.scheduleTimeoutOperation(_branch, PendingNonRenewalFirstCheckDate, "pendingNonRenewalFirstCheck", false)
  }

  protected property get PendingNonRenewalFirstCheckDate() : Date {
    return _branch.PeriodStart.addDays(-105)
  }

  function pendingNonRenewalFirstCheck() {
    var escalationReasonChecker = shouldEscalateNonRenewal()
    if (escalationReasonChecker.ShouldEscalate) {
      escalate(escalationReasonChecker.ActivitySubject, escalationReasonChecker.ActivityDescription)
    } else {
      _timeoutHandler.scheduleTimeoutOperation(_branch, PendingNonRenewalFinalCheckDate, "pendingNonRenewalFinalCheck", false)
    }
  }

  protected property get PendingNonRenewalFinalCheckDate() : Date {
    return _branch.PeriodStart.addDays(-100)
  }

  function pendingNonRenewalFinalCheck() {
    var escalationReasonChecker = shouldEscalateNonRenewal()
    if (escalationReasonChecker.ShouldEscalate) {
      escalate(escalationReasonChecker.ActivitySubject, escalationReasonChecker.ActivityDescription)
    } else {
      if (Job.NonRenewalNotifDate == null) {
        sendNonRenewalDocuments()
      }
      _timeoutHandler.scheduleTimeoutOperation(_branch, SendNonRenewalDate, "sendNonRenewal", false)
    }
  }

  protected property get SendNonRenewalDate() : Date {
    return _branch.PeriodStart.addDays(-35)
  }

  /**
   * Checks the conditions for sending non-renewal documents.
   */
  function canSendNonRenewalDocuments() : JobConditions {
    return startChecksFor(DisplayKey.get("Job.Process.Renewal.SendNonRenewalDoc"))
        .checkBranchNotLocked()
        .checkStatus(TC_NONRENEWING)
        .checkNonRenewLeadTime()
  }

  /**
   * Sends non-renewal documents.
   */
  function sendNonRenewalDocuments() {
    canSendNonRenewalDocuments().assertOkay()
    JobProcessLogger.logInfo("Sending non-renewal documents for renewal branch: " + _branch)
    Job.NonRenewalNotifDate = Date.CurrentDate
    _branch.addEvent("SendNonRenewalDocuments")
  }

  /**
   * Checks the conditions for sending non-renewal.
   */
  function canSendNonRenewal() : JobConditions {
    return startChecksFor(DisplayKey.get("Job.Process.Renewal.NonRenew"))
        .checkBranchNotLocked()
        .checkStatus(TC_NONRENEWING)
        .checkNotNull(Job.NonRenewalNotifDate, "Non-renewal notification date is not set")
  }

  /**
   * Sends non-renewal.
   */
  function sendNonRenewal() {
    canSendNonRenewal().assertOkay()
    JobProcessLogger.logInfo("Sending non-renewal for branch: " + _branch)
    withdrawOtherActivePeriods()
    JobProcessLogger.logInfo("Finish sending non-renewal for branch: " + _branch)
    Job.createCustomHistoryEvent(TC_RENEWAL, \ -> DisplayKey.get("Job.Renewal.History.NonRenewed", _branch.BranchName))
    _branch.Status = TC_NONRENEWED
    _branch.BasedOn.PolicyTerm.removePreRenewalDirection()
    _branch.addEvent("SendNonRenewal")
    clearAllAsyncQuoteIssues()
    _branch.lockBranch()
  }

  protected function shouldEscalateNonRenewal() : EscalationReasonChecker {
    return new EscalationReasonChecker(TC_NONRENEWING)
        .checkForNonRenewLeadTime()
        .checkForUnhandledPreemptions()
  }

  /**
   * Determines if the PolicyPeriod can be non-renewed by looking at the legal requirements
   * for the non-renewal notification lead time. This is computed as the minimum value of the
   * "LeadTime" column of all rows of the NotificationConfig system table which match the
   * action type "NonRenewMin", the line pattern of one of the policy's lines, and the state
   * of one of the branch's PolicyLocations. Returns false if no configuration information is
   * found. Returns true if non-renew notices were already sent.
   */
  override function canNonRenew() : boolean {
    if (Job.NonRenewalNotifDate != null) {
      return true
    }
    try {
      var notificationPlugin = Plugins.get(INotificationPlugin)
      var periodEnd = _branch.BasedOn.PeriodEnd
      var lineToJurisdictions = _branch.AllPolicyLinePatternsAndJurisdictions
      var leadTime = notificationPlugin.getMinimumLeadTime(periodEnd, lineToJurisdictions, TC_NONRENEWMIN)
      return Date.CurrentDate < periodEnd.addDays(-leadTime)
    } catch (e : Exception) {
      return false
    }
  }

  // --------------------- Not Taken Automated Flow

  protected function startPendingNotTaken() {
    var escalationReasonChecker = shouldEscalateNotTaken()
    if (escalationReasonChecker.ShouldEscalate) {
      escalate(escalationReasonChecker.ActivitySubject, escalationReasonChecker.ActivityDescription)
    } else {
      Job.createCustomHistoryEvent(TC_RENEWAL, \ -> DisplayKey.get("Job.Renewal.History.PreRenewalDirection.PendingNotTaken", _branch.BranchName))
      schedulePendingNotTaken()
    }
  }

  protected function schedulePendingNotTaken() {
    _branch.Status = TC_NOTTAKING
    Job.SelectedVersion = _branch
    _timeoutHandler.scheduleTimeoutOperation(_branch, PendingNotTakenFirstCheckDate, "pendingNotTakenFirstCheck", false)
  }

  protected property get PendingNotTakenFirstCheckDate() : Date {
    return _branch.PeriodStart.addDays(-45)
  }

  function pendingNotTakenFirstCheck() {
    var escalationReasonChecker = shouldEscalateNotTaken()
    if (escalationReasonChecker.ShouldEscalate) {
      escalate(escalationReasonChecker.ActivitySubject, escalationReasonChecker.ActivityDescription)
    } else {
      _timeoutHandler.scheduleTimeoutOperation(_branch, PendingNotTakenFinalCheckDate, "pendingNotTakenFinalCheck", false)
    }
  }

  protected property get PendingNotTakenFinalCheckDate() : Date {
    return _branch.PeriodStart.addDays(-40)
  }

  function pendingNotTakenFinalCheck() {
    var escalationReasonChecker = shouldEscalateNotTaken()
    if (escalationReasonChecker.ShouldEscalate) {
      escalate(escalationReasonChecker.ActivitySubject, escalationReasonChecker.ActivityDescription)
    } else {
      if (Job.NotTakenNotifDate == null) {
        sendNotTakenDocuments()
      }
      _timeoutHandler.scheduleTimeoutOperation(_branch, SendNotTakenDate, "sendNotTaken", false)
    }
  }

  protected property get SendNotTakenDate() : Date {
    return _branch.PeriodStart.addDays(-35)
  }

  private function canNotTaken(action : String) : JobConditions {
    return startChecksFor(action)
        .checkBranchNotLocked()
        .checkStatus({TC_NOTTAKING, TC_RENEWING})
  }

  /**
   * Checks the conditions for sending not-taken documents.
   */
  function canSendNotTakenDocuments() : JobConditions {
    return canNotTaken("send not taken documents")
  }

  function sendNotTakenDocuments() {
    canSendNotTakenDocuments().assertOkay()
    JobProcessLogger.logInfo("Sending not taken documents for branch: " + _branch)
    Job.NotTakenNotifDate = Date.CurrentDate
    _branch.addEvent("SendNotTakenDocuments")
  }

  /**
   * Checks the conditions to send not-taken event.
   */
  function canSendNotTaken() : JobConditions {
    return canNotTaken("send not taken")
  }

  /**
   * Sends not-taken event.
   */
  function sendNotTaken() {
    canSendNotTaken().assertOkay()
    JobProcessLogger.logInfo("Sending not-taken for branch: " + _branch)
    withdrawOtherActivePeriods()
    Job.createCustomHistoryEvent(TC_RENEWAL, \ -> DisplayKey.get("Job.Renewal.History.NotTaken", _branch.BranchName))
    _branch.Status = TC_NOTTAKEN
    _branch.BasedOn.PolicyTerm.removePreRenewalDirection()
    _branch.addEvent("SendNotTaken")
    clearAllAsyncQuoteIssues()
    _branch.lockBranch()
  }

  function sendNotTakenForRenewalOffer(){
    sendNotTaken()
    // may do some extra things here like sending out a notice that the policy has now expired
    // since no payment was received
  }

  function runMethodAsRenewalUser(method : String) {
    var user = Plugins.get(IPolicyRenewalPlugin).getAutomatedRenewalUser(_branch)
    executeAsAutomatedUser(user, \ -> {
      ReflectUtil.invokeMethod(this, method, {})
    })
  }

  // ------------------------ General Helper Functions

  protected function shouldEscalateNotTaken() : EscalationReasonChecker {
    return new EscalationReasonChecker(TC_NOTTAKING).checkForUnhandledPreemptions()
  }

  protected function hasAnyUnhandledPreemptions() : boolean {
    return _branch.hasAnyUnhandledPreemptions()
  }

  protected function hasOpenCancellationInPriorPeriod() : boolean {
    return Job.hasOpenCancellationInPriorPeriod()
  }

  protected function hasValidationIssues() : boolean {
    try {
      JobProcessValidator.validatePeriodForUI(_branch.getSlice(_branch.EditEffectiveDate), TC_READYFORISSUE, false)
    } catch (e: EntityValidationException) {
      return true
    }

    return false
  }

  /**
   * Inner class that encapsulates methods for determining when an underwriter should get involved
   * with a renewal.
   */
  private class EscalationReasonChecker {
    private var _messages = new ArrayList<String>()
    private var _state : PolicyPeriodStatus

    construct(state : PolicyPeriodStatus) {
      _state = state
    }

    function checkForOpenCancellationInPriorPeriod() : EscalationReasonChecker {
      if (hasOpenCancellationInPriorPeriod()) {
        _messages.add(DisplayKey.get("Job.Renewal.Escalation.Reason.OpenCancellation"))
      }
      return this
    }

    function checkForUnhandledPreemptions() : EscalationReasonChecker {
      if (hasAnyUnhandledPreemptions()) {
        _messages.add(DisplayKey.get("Job.Renewal.Escalation.Reason.UnhandledPreemptions"))
      }
      return this
    }

    function checkForValidationIssues() : EscalationReasonChecker {
      if (hasValidationIssues()) {
        _messages.add(DisplayKey.get("Job.Renewal.Escalation.Reason.ValidationErrors"))
      }
      return this
    }

    function checkForUWIssues() : EscalationReasonChecker {
      var blockingIssues = JobProcessEvaluator.evaluateAndFindBlockingUWIssues(_branch, TC_BLOCKSISSUANCE)
      if (blockingIssues.Count > 0) {
        _messages.add(DisplayKey.get("Job.Renewal.Escalation.Reason.UWIssues"))
      }
      return this
    }

    function checkForNonRenewLeadTime() : EscalationReasonChecker {
      if (not canNonRenew()) {
        _messages.add(DisplayKey.get("Job.Renewal.Escalation.Reason.NonRenewLeadTime"))
      }
      return this
    }

    function addCustomError(error : String) : EscalationReasonChecker {
      _messages.add(error)
      return this
    }

    property get ShouldEscalate() : boolean {
      return not _messages.Empty
    }

    property get ActivitySubject() : String {
      switch (_state) {
        case TC_NONRENEWING:
          return DisplayKey.get("Job.Renewal.Escalation.Subject.NonRenewing", _branch.Renewal.JobNumber)
        case TC_RENEWING:
          return DisplayKey.get("Job.Renewal.Escalation.Subject.Renewing", _branch.Renewal.JobNumber)
        case TC_NOTTAKING:
          return DisplayKey.get("Job.Renewal.Escalation.Subject.NotTaking", _branch.Renewal.JobNumber)
        default : throw "Unexpected state ${_state} passed in; should be one of NonRenewing, Renewing, or NotTaking"
      }
    }

    property get ActivityDescription() : String {
      var stateString = ""
      switch (_state) {
        case TC_NONRENEWING:
          stateString = DisplayKey.get("Job.Renewal.Escalation.JobState.NonRenewing")
          break
        case TC_RENEWING:
          stateString = DisplayKey.get("Job.Renewal.Escalation.JobState.Renewing")
          break
        case TC_NOTTAKING:
          stateString = DisplayKey.get("Job.Renewal.Escalation.JobState.NotTaking")
          break
        default : throw "Unexpected state ${_state} passed in; should be one of NonRenewing, Renewing, or NotTaking"
      }

      return DisplayKey.get("Job.Renewal.Escalation.ActivityHeader", stateString, _messages.join("\n"))
    }
  }

  override function issueJob(bindAndIssue : boolean) {
    if (not bindAndIssue) {
      throw new IllegalArgumentException("Bind-only not supported for Renewal")
    }
    assertNoOpenCancellations()
    _branch.onBeginIssueJob()
    issueNow()
  }
}
