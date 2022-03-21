package com.guidewire.proserve.pc.importexport.web

uses entity.Job

class WorkOrderExportLine {

  var _helper             : ImportExportPCFHelper
  var _job                : Job                as Job
  var _seletion           : boolean            as Selection               = false
  var _exportJobStatus    : PolicyPeriodStatus as ExportJobStatus
  var _exportAsSubmission : boolean            as ExportAsSubmissionValue = false
  var _linkedJob          : boolean            as LinkedJob               = true

  static final var PERIOD_STATUSES   =  PolicyPeriodStatus.getTypeKeys(false)
  static final var BOUND_STATUSES    = {PolicyPeriodStatus.TC_DRAFT, PolicyPeriodStatus.TC_QUOTED, PolicyPeriodStatus.TC_BOUND}
  static final var COMPLETED_STATUES = {PolicyPeriodStatus.TC_DRAFT, PolicyPeriodStatus.TC_QUOTED, PolicyPeriodStatus.TC_AUDITCOMPLETE} 

  construct(jobIn : Job, helper : ImportExportPCFHelper) {
    _helper = helper
    _job = jobIn

    _exportJobStatus = _job.LatestPeriod.Status
  }

  function resetStatus() {
    _seletion           = false
    _exportJobStatus    = _job.LatestPeriod.Status
    _exportAsSubmission = false
    _linkedJob          = true
  }

  property get Editable() : boolean {
    return ExportImplementedForJob and _helper.isEditable(this)
  }

  property get WorkOrderTypeDescription() : String {
    if (ExportImplementedForJob)
      return _job.DisplayType
    else
      return _job.DisplayType + " (export not yet implemented)"
  }

  property get WorkOrderTypeColor() : String {
    return ExportImplementedForJob ? "" : "ff0000"
  }

  private property get ExportImplementedForJob() : boolean
  {
    return true
  } // V10  altered return stmt to enable renewal copy

  /**
   * list of available PolicyPeriod status codes that can be used for this Job's export
   */
  property get AvailableExportAsStatuses() : List<PolicyPeriodStatus>
  {
    if (_exportAsSubmission and not (_job typeis Submission))
    {
      return { PolicyPeriodStatus.TC_DRAFT }
    }
    else
    {
      var allowedStatuses = (_job typeis Audit) ? COMPLETED_STATUES : BOUND_STATUSES

      return allowedStatuses.intersect(PERIOD_STATUSES.where(\ p -> p.Priority <= _job.LatestPeriod.Status.Priority))
                  .toList()
    }
  }

  property get ExportAsSubmissionIsEditable() : boolean {
    return not (_job typeis Submission or _job typeis Audit)
  }

  /**
   * This method is called on the click event ('onChange') of the selection checkbox for a row.
   */
  function toggleWorkOrderToExport() {
    _helper.toggleWorkOrderToExport(this, this.Selection)
  }

  function onChangeOfExportAsSubmission()
  {
    if (_exportAsSubmission)
    {
      _exportJobStatus = PolicyPeriodStatus.TC_DRAFT
    }

    _helper.toggleWorkOrderToExport(this, _exportAsSubmission)
  }

}
