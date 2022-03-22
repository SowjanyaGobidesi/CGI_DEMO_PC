package gw.job

uses com.tap2drive.constants.Tap2DriveConstants
uses gw.api.locale.DisplayKey
uses gw.api.job.JobProcessLogger
uses gw.api.util.DisplayableException
uses gw.forms.FormInferenceEngine
uses gw.job.permissions.ReinstatementPermissions
uses gw.plugin.messaging.BillingMessageTransport
uses java.lang.IllegalArgumentException
uses java.util.Date
uses gw.api.database.Query
uses gw.api.web.util.TransactionUtil
uses java.lang.Exception
uses gw.api.system.PCLoggerCategory

/**
 * Encapsulates the actions taken within a Reinstatement job.
 *
 * @see JobProcess for general information and job process logic.
 * @see gw.plugin.policyperiod.impl.JobProcessCreationPlugin
 */
@Export
class ReinstatementProcess extends JobProcess {

  construct(period : PolicyPeriod) {
    super(period, new ReinstatementPermissions((period.Job)))
    JobProcessEvaluator = JobProcessUWIssueEvaluator.forReinstatement()
  }

  override property get Job() : Reinstatement {
    return super.Job as Reinstatement
  }

  // ===== LIFECYCLE FUNCTIONS =====

  /**
   * Initializes a reinstatement.
   */
  override function start() {
    JobProcessLogger.logInfo("Starting reinstatement for branch: " + _branch)
    startJobAsDraft()
    Job.assignRolesFromPolicy()
  }

  /**
   * Checks the conditions for which the policy period can be reinstated.
   */
  function canReinstate() : JobConditions {
    return canFinishIssue(canIssue(DisplayKey.get("Job.Process.Reinstatement.Reinstate")))
            .checkNotStatus(TC_REINSTATING)
            .checkNoUnhandledPreemptions()
  }

  /**
   * Two step quoting feature disabled by default for reinstatement process
   */
  override property get TwoStepQuotingAvailable(): boolean {
    return false
  }

  /**
   * Returns the default written date to use for this job.
   * which should be the written date of the latest non-cancellation job
   */
  override protected property get DefaultWrittenDate() : Date {
    return PriorPeriod.WrittenDate
  }

  /**
   * the BasedOn for the current period would normally be a cancellation,
   * but it could be a policy change (change after cancel) so use the first found
   * non-cancel job.
   * @return PolicyPeriod that should be reinstated
   */
  private property get PriorPeriod() : PolicyPeriod {
    var priorPeriod = _branch.BasedOn
    while (priorPeriod.Job.Subtype == typekey.Job.TC_CANCELLATION) {
      priorPeriod = priorPeriod.BasedOn
    }
    return priorPeriod
  }

  /**
   * Begins reinstating the policy period.
   */
  function reinstate() {
    canReinstate().assertOkay()

    _validator.validateReinsurance(_branch)
    checkThatBasedOnPeriodNotArchivedInBillingSystem()
    JobProcessEvaluator.evaluateAndCheckForBlockingUWIssues(_branch, TC_BLOCKSISSUANCE)

    // Do not do AccountSyncable validation.
    _branch.Status = TC_REINSTATING
    _branch.ensureProducerOfService()
    FormInferenceEngine.Instance.inferPreBindForms(_branch)

    // To make this work asynchronously, uncomment this event and remove the call to finishReinstatement.
    // Whatever responds to the event needs to call finishReinstatement() when it has finished so that
    // PolicyCenter can finish the process.

    //_branch.addEvent("IssueReinstatement")
    finishReinstatement()
  }

  /**
   * Finishes reinstating the policy period.
   * As of 8.0.4, this no longer does it's own commit.  If calling from other than {@link RewriteNewAccountProcess#startBinding()},
   * you need to ensure the changes are committed.
   */
  function finishReinstatement() {
    try {
      TransactionUtil.runAtomically(\bundle -> {
        canFinishJob(DisplayKey.get("Job.Process.Reinstatement.FinishReinstatement"))
            .checkStatus(TC_REINSTATING)
            .assertOkay()

        createBillingEventMessages()
        _branch.Job.copyUsersFromJobToPolicy()
        prepareBranchForFinishingJob()
        processAudits()

        _branch.clearOutstandingCancellationsOrReinstatementsInSamePeriod()
        _branch.updateTrendAnalysisValues()
        _branch.PolicyTerm.DepositReleased = false
        _branch.updatePolicyTermDepositAmount()
        for(driv in _branch.PersonalAutoLine.PolicyDrivers)  {
          if(driv.Tap2DriveRecord_Ext.Tap2DriveStatus == Tap2DriveStatus_Ext.TC_ENROLLED) {
            driv.addEvent (Tap2DriveConstants.TAP2DRIVE_ENROLL_EVENT)
          }
          if(driv.Tap2DriveRecord_Ext.Tap2DriveStatus == Tap2DriveStatus_Ext.TC_UNENROLLED) {
            driv.addEvent (Tap2DriveConstants.TAP2DRIVE_UNENROLL_EVENT)
          }
        }
        try {
          _branch.promoteBranch(false)
        } catch (e : IllegalArgumentException) {
          // the following exception is hardcoded at platform level and as per PC-30436 we're making it translatable
          // preemption check is invoked for all jobs so, theoretically, can be thrown for any transaction
          if (e.Message == "Cannot promote preempted branch") {
            throw new DisplayableException(DisplayKey.get("Job.Error.Preempted"))
          }
          throw e
        }

        bindReinsurableRisks()
        // flags Activity on error...
      }, _branch)
    } catch (e: Exception) {
      PCLoggerCategory.JOB_PROCESS.error("Unable to issueReinstatement", e)
      throw e
    }

    // test for restart depends on commit of branch promotion...
    if (hasWithdrawnRenewalToRestart()) {
      restartRenewal()
    }
  }

  /**
   * Fails binding, setting the policy period status to "Review."
   */
  function failBinding() {
    Job.createProducerActivity(ActivityPattern.finder.getActivityPatternByCode("issue_failed"),
                               DisplayKey.get("Reinstatement.IssueReinstatement.Failed.Subject"),
                               DisplayKey.get("Reinstatement.IssueReinstatement.Failed.Description"))
    canFailBind().assertOkay()
    Job.assignUnderwriter()
  }

  private function processAudits() {
    _branch.withdrawOpenRevisedFinalAudit()
    _branch.withdrawOpenFinalAudit()
    _branch.reverseFinalAudits()
    _branch.removeScheduledFinalAudit()
    _branch.scheduleExpirationFinalAudit()
    _branch.rescheduleAuditSeries()
  }

  override function initializeFuturePeriodJob(futureJob : Job) {
    var futureReinstatement = futureJob as Reinstatement
    futureReinstatement.ReinstateCode = this.Job.ReinstateCode
  }

  override property get RecalculateDepositOnReportingAfterValidQuote() : boolean {
    return true
  }

  override function createBillingEventMessages() {
    _branch.addEvent(PolicyPeriod.REINSTATEPERIOD_EVENT)
  }

  private function restartRenewal() : Renewal {
    var renewal = new Renewal(_branch.Bundle)
    renewal.startJob(_branch.Policy)
    return renewal
  }

  /**
    Call when the reinstatement job finishes and will like to restart any withdrawn renewal,
    which may have been withdrawn because of a cancellation job.
  */
  private function hasWithdrawnRenewalToRestart() : boolean {

    // If there's already a future renewal that has been bound
    // or that's active, there is nothing to withdraw.
    if (_branch.hasFutureRenewals()) {
      return false
    }

    // find all renewal job for this policy that have been completed
    var renewals = Query.make(Renewal).compare(Renewal#Policy.PropertyInfo.Name, Equals, _branch.Policy).select()

    // then find renewals that are in a period after the reinstatement
    // and ones that are not bound (period is draft), which result because
    // of a withdrawl
    for (renewalJob in renewals) {
      var renewal = renewalJob.Periods.first()
      if(renewalJob.Complete
          and renewal.PeriodStart.after(_branch.PeriodStart)
          and renewal.Locked // A withrawn renewal will be locked
          and renewal.Status == TC_WITHDRAWN) {
        return true
      }
    }

    return false
  }

  override function issueJob(bindAndIssue : boolean) {
    if (not bindAndIssue) {
      throw new IllegalArgumentException("Bind-only not allowed for Reinstatement")
    }
    _branch.onBeginIssueJob()
    reinstate()
  }
}


