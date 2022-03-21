package com.guidewire.proserve.pc.importexport.web

uses com.guidewire.pl.web.util.WebFileUtil
uses com.guidewire.proserve.pc.importexport.EntityXMLExporter
uses com.guidewire.proserve.pc.importexport.EntityXMLImporter
uses gw.api.database.Query
uses gw.api.util.DisplayableException
uses gw.api.util.Logger
uses gw.pl.persistence.core.Key
uses gw.xml.XMLNode
uses org.apache.commons.io.IOUtils
uses org.w3c.dom.NodeList
uses pcf.api.Location
uses org.apache.commons.io.FileUtils;

uses javax.xml.parsers.DocumentBuilderFactory
uses java.io.File
uses java.io.FileOutputStream
uses java.nio.charset.StandardCharsets


/**
 * This is the Presenter for the "Import Export Work Orders" screen (ImportExportWorkOrders.pcf).
 * As part of the Model-View-Presenter pattern, this class holds all the state (data) and logic
 * for the "Import Export Work Orders" screen, which is a View.  And it interfaces to the "Model",
 * the "EntityXML*" classes, which do all the significant work of exporting and importing Policy
 * related data in the XML format.
 */
class ImportExportPCFHelper {

  // Search fields:
  var _accountNumber   : String as AccountNumber
  var _workOrderNumber : String as WorkOrderNumber
  var _policyNumber    : String as PolicyNumber

  // Work Orders on Account section:  [The Maps are essentially used to add properties to the Job object for maintaining the on-screen list.]
  var _workOrders        : List<WorkOrderExportLine>     as WorkOrders        = new ArrayList<WorkOrderExportLine>()
  var _workOrdersByJobID : Map<Key, WorkOrderExportLine>                      = new HashMap<Key, WorkOrderExportLine>()
  var _workOrderToExport : WorkOrderExportLine          as WorkOrderToExport                                            // currently slected row
  var _workOrdersToExport : List<WorkOrderExportLine> as WorkOrderToExports = new ArrayList<WorkOrderExportLine>()
  // XML Output:
  var _outputXML : String as OutputXML
  var _outputsBuilderXML : StringBuilder

  // Import tab:
  var _inputXML           : String    as InputXML
  var _importedWorkOrders : List<Job> as ImportedWorkOrders = new ArrayList<Job>()

  private function clearAllSelections(currentLocation : Location) : void
  {
    WorkOrders.clear()
    WorkOrderToExport = null
    OutputXML = null
    _workOrdersToExport.clear()

    gw.api.web.PebblesUtil.invalidateIterators(currentLocation, WorkOrderExportLine)
  }

  /**
   * Clear PCF Selection
   * @param currentLocation
   */
  function resetPCFElement(currentLocation : Location){
    clearAllSelections(currentLocation)
    AccountNumber = null
    PolicyNumber = null
    WorkOrderNumber = null
  }

  /**
   * Clear PCF Selection
   * @param currentLocation
   */
  function resetImportPCFSelection(){
    _inputXML = null
    _importedWorkOrders.clear()
  }


  protected function toggleWorkOrderToExport(workOrder : WorkOrderExportLine, selected : boolean) : void
  {

    Logger.logInfo("setWorkOrderToExport(${workOrder.Job}, ${selected})")
    //OutputXML = null
    _outputsBuilderXML = null

    if (selected)
    {
      WorkOrderToExport = workOrder
      workOrder.Selection = true
      getJobsThatWereClosedBefore(workOrder).each(\ j ->
          {
            var wrk = _workOrdersByJobID[j.ID]
            wrk.resetStatus()
            wrk.Selection = selected
            wrk.LinkedJob = false
            _workOrdersToExport.removeWhere(\elt1-> elt1.Job.JobNumber == j.JobNumber)
          })
      _workOrdersToExport.add(WorkOrderToExport)
    }
    else
    {
      _workOrdersToExport.removeWhere(\elt -> elt.Job.JobNumber == workOrder.Job.JobNumber )
      setWorkOrderDefaultValues(workOrder)
    }

  }

  private function setDefaultValuesInLV()
  {
    WorkOrders.each(\workOrder -> workOrder.resetStatus())
    WorkOrderToExport = null
  }

  /**
   * "Export" tab, "Search Work Orders" button.
   */
  function findWorkOrders(loc : Location) : void
  {
    clearAllSelections(loc)
  
    if (AccountNumber == null and PolicyNumber == null and WorkOrderNumber == null)
    {
      throw new DisplayableException("how about giving me an account, policy or work order number?")
    }
    
    if (AccountNumber == null and WorkOrderNumber != null)
    {
      var job = Query.make(Job).compare("JobNumber", Equals, WorkOrderNumber)
                          .select().AtMostOneRow    
      if (job == null)
      {
        throw new DisplayableException("hello, where did you get this work order number from? i can't find it in this environment.")
      }
    
      AccountNumber = job.LatestPeriod.Policy.Account.AccountNumber
      Logger.logInfo("Job #${job.JobNumber} found -- Account #${AccountNumber}.")
    }
    else if (AccountNumber == null and PolicyNumber != null)
    {
      var pp = Query.make(PolicyPeriod).compare("PolicyNumber", Equals, PolicyNumber)
                          .select().FirstResult     
      if (pp == null)
      {
        throw new DisplayableException("might want to check your policy number! i can't find it in this environment.")
      }

      AccountNumber = pp.Policy.Account.AccountNumber
      Logger.logInfo("Policy #${pp.PolicyNumber} found -- Account #${AccountNumber}.")
    }

    var jobs = findWorkOrdersOnAccount(AccountNumber)
    WorkOrders.addAll(jobs.map(\ job -> new WorkOrderExportLine(job, this)))
    _workOrdersByJobID = _workOrders.partitionUniquely(\ workOrder -> workOrder.Job.ID)
    setDefaultValuesInLV()
  }

  function findWorkOrdersOnAccount(number : String) : List<Job>
  {
    var acct = Query.make(Account).compare("AccountNumber", Equals, number)
                          .select().AtMostOneRow
                        
    if (acct == null)
    {
      throw new DisplayableException("is that really a valid account number in this environment?")
    }
  
    var jobList = acct.Policies.flatMap(\ p -> p.Jobs).toList()
    Logger.logInfo("Account #${acct.AccountNumber} has ${jobList.Count} Jobs.")
    return jobList
  }

  function exportWorkOrder() : void
  {
    if (not _workOrdersToExport.HasElements)
    {
      throw new DisplayableException("would be nice if you tell me what you want exported!")
    }
    try{
      _outputsBuilderXML = new StringBuilder()
      _outputsBuilderXML.append("<Parent>\n")
      for(workOrderToExport in _workOrdersToExport) {
        var exp = new EntityXMLExporter(workOrderToExport.Job, workOrderToExport.ExportJobStatus, workOrderToExport.ExportAsSubmissionValue)
        OutputXML = exp.export()
        _outputsBuilderXML.append(OutputXML)
      }
      _outputsBuilderXML.append("</Parent>\n")
      var workOrderWithPolicyNumber = _workOrdersToExport.firstWhere(\order -> order.Job.LatestPeriod.PolicyNumber != null)
      var workOrderWithJobNumber = _workOrdersToExport.firstWhere(\order -> order.Job.JobNumber != null)
      var workOrderNumber = workOrderWithPolicyNumber != null ? workOrderWithPolicyNumber.Job.LatestPeriod.PolicyNumber :
                            workOrderWithJobNumber.Job.JobNumber
      var acctFile = File.createTempFile("policy-" + workOrderNumber,".xml")
      var fio = new FileOutputStream(acctFile)
      try {
        IOUtils.write(_outputsBuilderXML.toString(), fio)
      } finally {
        _outputsBuilderXML = null
        IOUtils.closeQuietly(fio)
      }
      WebFileUtil.copyFileToClient(acctFile,"policy-" + workOrderNumber+".xml","text/xml")
      print("File exported successfully!")
    }
    catch(e)
    {
      _outputsBuilderXML = null
      e.printStackTrace()
      throw new DisplayableException(formatUnexpectedExceptionMessage(e, "exporting work orders"))
    }
  }

  private static function getJobsThatWereClosedBefore(workOrder : WorkOrderExportLine) : Set<Job>
  {        
    if (workOrder.Job typeis Submission or workOrder.ExportAsSubmissionValue)
    {
      return {}
    }
    
    return workOrder.Job.Policy.Jobs.where(\ j -> j.CloseDate != null and j.CloseDate < workOrder.Job.CloseDate).toSet()
    /*return workOrder.Job.Policy.Jobs.where(\ j -> j.CloseDate != null and (j.CloseDate <= workOrder.Job.CloseDate or
    workOrder.Job.CloseDate ==null)).toSet()*/
  }
  
  protected function isEditable(workOrder : WorkOrderExportLine) : boolean
  {            
    return (WorkOrderToExport == null or WorkOrderToExport == workOrder)
  }
  
  function importWorkOrders() : void
  {
    ImportedWorkOrders.clear()
    try
    {
      /*var acct = new EntityXMLImporter(_inputXML).import()
      Logger.logInfo("Import successful.  Account #${acct.AccountNumber}")

      var jobList = acct.Policies.flatMap(\ p -> p.Jobs).toList()
      jobList.each(\ j -> {
          Logger.logInfo("  Job/Work Order #${j.JobNumber}")
        })
      ImportedWorkOrders.addAll(jobList)*/
    }
    catch(e)
    {
      e.printStackTrace()
      throw new DisplayableException(formatUnexpectedExceptionMessage(e, "importing work orders"))
    }
  }

  function importWorkOrders(importContent : gw.api.web.WebFile) : void
  {
    ImportedWorkOrders.clear()
    try
    {
      _inputXML = IOUtils.toString(importContent.InputStream, StandardCharsets.UTF_8);
      var doc = XMLNode.parse(_inputXML)
      var childerXML = doc.Children
      for(inputChildrenXML in childerXML){
        var acct = new EntityXMLImporter(inputChildrenXML).import()
        Logger.logInfo("Import successful.  Account #${acct.AccountNumber}")

        var jobList = acct.Policies.flatMap(\p -> p.Jobs).toList()
        jobList.each(\j -> {
          Logger.logInfo("  Job/Work Order #${j.JobNumber}")
        })
        ImportedWorkOrders.addAll(jobList)
      }
    }
    catch(e)
    {
      e.printStackTrace()
      throw new DisplayableException(formatUnexpectedExceptionMessage(e, "importing work orders"))
    }
  }


  private static function formatUnexpectedExceptionMessage(e : Throwable, currentAction : String) : String {
    var errMsg = new StringBuilder("hmmmm, something that I hadn't anticipated happened while ").append(currentAction).append(":\n")
    errMsg.append("Unexpected exception:\n")
    var exceptionCause = e
    var previousExceptionMessage = ""
    while (exceptionCause != null) {
      errMsg.append("   ").append(exceptionCause.getClass().getName())
      var exceptionMessage = exceptionCause.getMessage()
      if (exceptionMessage != null and exceptionMessage != "") {
        if (exceptionMessage == previousExceptionMessage) {
          errMsg.append(" - <same message as above>")
        } else {
          errMsg.append(": ").append(exceptionMessage)
        }
      }
      errMsg.append("\n")

      exceptionCause = exceptionCause.Cause
      previousExceptionMessage = exceptionMessage
    }
    errMsg.append("Consult log file for stack trace.")
    return errMsg.toString()
  }


  private function setWorkOrderDefaultValues(workOrder : WorkOrderExportLine)
  {
    workOrder.resetStatus()
    getJobsThatWereClosedBefore(workOrder).each(\ j ->
        {
          var wrk = _workOrdersByJobID[j.ID]
          wrk.resetStatus()
        })
    WorkOrderToExport = null
  }
}