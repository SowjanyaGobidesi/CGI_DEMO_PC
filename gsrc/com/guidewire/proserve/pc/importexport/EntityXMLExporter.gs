package com.guidewire.proserve.pc.importexport

uses gw.api.util.Logger
uses gw.entity.IArrayPropertyInfo
uses gw.entity.IColumnPropertyInfo
uses gw.entity.ILinkPropertyInfo
uses gw.entity.ITypekeyPropertyInfo
uses gw.lang.reflect.IPropertyInfo
uses gw.lang.reflect.IType
uses gw.util.Stack
uses entity.Job

/**
 * Given one work order (a Job) and related user selections, this class generates XML
 * representing the Account, the Policy, the relevant PolicyPeriod objects, and related
 * "non-administration" effective-dated objects. This XML is displayed on the screen,
 * for the user to copy to new policies on the same or different systems.
 */
class EntityXMLExporter extends EntityXMLBase
{
  /**
   * XML output of this class (the 'export' method).
   */
  var _output = new StringBuilder()

  //
  // Set on object construction:
  //
  var _lastBranchToExport : PolicyPeriod
  var _exportJob : Job
  var _exportAsStatus : PolicyPeriodStatus  // Export as this job status, even if the job we're exporting is at a later stage in the process.
  var _exportAsSubmission : boolean         // = true to force a non-Submission PolicyPeriod to be exported as if it were an initial Submission.

  //
  // Initialized on construction and used in the process:
  //
  var _processedEntities = new HashMap<String,KeyableBean>()
  var _linkedEntities = new HashMap<String,KeyableBean>()

  //
  // Valid while processing a PolicyPeriod:
  //    
  var _currentPeriodPublicID : String 
  var _processingLastBranch : boolean

  var _firstLevelLinkedEntities = new HashMap<String,KeyableBean>()
  var _processedShallowEntities = new HashSet<KeyableBean>()

  /**
   * @param job The PolicyPeriod associated with this job will become the LatestPeriod when imported. 
   * @param exportAsStatus The status to leave the LatestPeriod in. Draft, Quoted or Bound
   * @param exportAsSubmission Convert the job to a Submission. The entities that are effective as of the job will
   * end up as being part of the newly created Submission.
   */
  construct(job : Job, exportAsStatus : PolicyPeriodStatus, exportAsSubmission : boolean) 
  {   
    _lastBranchToExport = job.LatestPeriod
    _exportJob = job
    _exportAsStatus = exportAsStatus
    _exportAsSubmission = exportAsSubmission
    Logger.logInfo("Export Job #${job.JobNumber} as status ${exportAsStatus}" + (exportAsSubmission ? " as a Submission" : "") + ".")
  }
  
  /**
   * Creates an XML with the following structure:
   * 
   * Policy
   * PolicyPeriod (of Submission)
   * Entities related to the above PolicyPeriod
   * Commit
   * PolicyPeriod (of PolicyChange)
   * Entities related to the above PolicyPeriod
   * Commit
   * 
   * Create a stack of PolicyPeriods. Submission on top, final audit at the bottom (for example).
   * Process stack top to bottom.
   */
  public function export() : String
  {
    _output.append("<AccountGraph>\n")
        
    var periodStack = createPeriodStack()
    var count = 0
    var max = periodStack.size()
           
    do 
    {
      count++      
      _currentBranch = periodStack.pop()
      _currentPeriodPublicID = _currentBranch.PublicID
      _processingSubmission = _currentBranch.Submission != null or _exportAsSubmission or _currentBranch.BasedOn == null //V10 - to handle conv renewal
      _processingLastBranch = _currentBranch == _lastBranchToExport     
      Logger.logInfo("Exporting period ${count}/${max} : ${_currentBranch}")
      visitEntitiesOnCurrentBranch()
      if (_exportAsSubmission)
      {
        writeEntity(_lastBranchToExport.FirstPeriodInTerm.Submission)
      }
      if (ProcessingSubmission)
      {
        writeOutVisitedEntities()      
      }
      writeCommit()
      Logger.logInfo("  done ${count}/${max}")
    } while (not periodStack.Empty)
   
    _output.append("</AccountGraph>\n")
    
    Logger.logInfo("Giddy up, export COMPLETE!")

   return _output.toString()
  }
  
  private function createPeriodStack() : Stack<PolicyPeriod>
  {
    var toBeExportedPeriods = new HashSet<PolicyPeriod>()
    
    // Exporting just one work order and it's a Submission (or some other Job that we are going to treat as a Submission)
    if (_exportAsSubmission)
    {      
      toBeExportedPeriods.add(_lastBranchToExport)
    }
    else
    {
      //find all BasedOn periods
      var period = _lastBranchToExport
      do
      {
        toBeExportedPeriods.add(period)
        period = period.BasedOn
      } while (period != null)
      
      if (_exportJob.LatestPeriod.IsReportingPolicy)
      {
        _lastBranchToExport.AuditInformations.sortByDescending(\ a -> a.Audit.CloseDate)
                                              .where(\ a -> a.Audit != _exportJob and a.IsComplete and a.Audit.CloseDate <= _exportJob.CloseDate)
                                              .each(\ a -> 
        {
          var audit = a.Audit
          toBeExportedPeriods.add(audit.PolicyPeriod)          
        })                                              
      }
    }
    
    // Put the first job that was completed on top of the stack, last completed (or Draft) at the bottom:
    var periodStack = new Stack<PolicyPeriod>()

    toBeExportedPeriods.where(\ p -> p.Job.CloseDate == null)
                        .toList().sortBy(\ p -> p.Job.CreateTime)
                        .each(\ p -> periodStack.push(p))        

    toBeExportedPeriods.where(\ p -> p.Job.CloseDate != null)
                        .toList().sortByDescending(\ p -> p.Job.CloseDate)
                        .each(\ p -> periodStack.push(p))

    return periodStack
  }
  
  /**
   * Start at the Policy and traverse the graph. If we hit entities
   * that are not associated with the current branch, skip and move on.
   */
  private function visitEntitiesOnCurrentBranch() : void
  {       
    if (ProcessingSubmission) 
    {
      writeEntity(CurrentBranch.Policy)
      writeEntity(CurrentBranch)
      //V10
      createNonEffDatedEntityData()
    }                    
    else
    {     
      //Don't need to process the entire PolicyPeriod graph if is not a Submission
      //Just use the results of CurrentBranch.getDiffItems()
      shallowWriteEntity(CurrentBranch)
      shallowWriteEntity(CurrentBranch.Job)
      //V10
      createNonEffDatedEntityData()
      _currentBranch.Job.RoleAssignments.each(\ u -> shallowWriteEntity(u))
      
      if (_currentBranch.Job typeis Audit)
      {
        shallowWriteAudit(_currentBranch)
      }
      else
      {             
        shallowWriteNonSubmission(_currentBranch)
      }
      
      getOtherRelatedEntities().each(\ s -> shallowWriteEntity(s)) 
      
      _firstLevelLinkedEntities.Values.each(\ k -> writeLinkedToEntity(k))                                                                                                
      _firstLevelLinkedEntities.clear()
      _processedShallowEntities.clear()         
    }
  }
  
  private function writePolicyPeriodAttributes(branch : PolicyPeriod) : void
  {
    if (branch.BasedOn != null)
    {
      _output.append(" ${BASEDON_ATTR}=\"" +branch.BasedOn.PublicID+ "\"")
      _output.append(" ${EDITEFFDATE_ATTR}=\"" +_dateFormat.format(branch.EditEffectiveDate)+ "\"")
      var job = branch.Job
      if (job typeis Audit and (job.AuditInformation.IsReversal or job.AuditInformation.IsRevision))
      {           
        _output.append(" ${ISFORAUDITREVERSAL_ATTR}=\"true\"")
      }
      else if (job typeis Rewrite)
      {
        _output.append(" ${ISFORREWRITE_ATTR}=\"true\"")
      }
      //V10 - To support renewal copy
      else if (job typeis Renewal)
      {
        _output.append(" ${ISFORRENEW_ATTR}=\"true\"")
      }
    }
  }
  
  private function shallowWriteAudit(branch : PolicyPeriod) : void
  {
    shallowWriteEntity(branch.Audit.AuditInformation)
    
    getEntitiesThatCanChangeOnAudit(branch).each(\ ent -> 
    {
      if (ent typeis EffDated)
      {
        ent.VersionListUntyped.AllVersionsUntyped.sortByDescending(\ e -> e.EffectiveDate).each(\ e ->
        {                
           shallowWriteEntity(e)
        })
      }
      else
      {
        shallowWriteEntity(ent)
      }
    })
    
    branch.AllCosts.toList().sortByDescending(\ e -> e.EffectiveDate).each(\ c -> shallowWriteEntity(c))
    if (shouldExportTransactions())
    {
      branch.AllTransactions.each(\ c -> shallowWriteEntity(c as EffDated))
    }
  }
  
  private function shallowWriteNonSubmission(branch : PolicyPeriod) : void
  {
    // V10 - added try/catch to hadle OOTB related exceptions
    try {
      var diffItemsMap = branch.getDiffItems(DiffReason.TC_INTEGRATION).partition(\d ->
          {
            if (d.Remove) return "R"
            else if (d.Add) return "A"
            else return "C"
          }).toAutoMap(\s -> {
        return {}
      })

      diffItemsMap["R"].map(\d -> d.Bean).toSet().each(\ent -> writeDeleteEntity(ent))
      diffItemsMap["A"].map(\d -> d.Bean).toSet().each(\ent ->
          {
            if (ent typeis Transaction and !shouldExportTransactions()) {
              //skip
            } else {
              shallowWriteEntity(ent)
            }
          })
      diffItemsMap["C"].map(\d -> d.Bean).toSet().toList()
          .whereTypeIs(EffDated)
          .sortByDescending(\e -> e.EffectiveDate).each(\ent ->
          {
            if (ent.EffectiveDate == ent.ExpirationDate) {
              writeDeleteEntity(ent)
            } else {
              shallowWriteEntity(ent)
            }
          })
    }
    // V10 - Added code to perform full copy if exceptions happens during getDiffItems()
    catch(e: Exception){
      writeEntity(branch)
    }
  }
  
  protected function getEntitiesThatCanChangeOnAudit(branch : PolicyPeriod) : List<KeyableBean>
  {
    var changedAuditEntities = new ArrayList<KeyableBean>()
    
    if (branch.WorkersCompLineExists)
    {
      changedAuditEntities.addAll(branch.WorkersCompLine.WCCoveredEmployeeBases.toList() as Collection<KeyableBean>)
    }
    
    return changedAuditEntities
  }
  
  /**
   * Add entities here that can aren't part of the official PolicyPeriod graph but needs
   * to be exported. Its ok to add the same entity multiple times, it will be exported just
   * once.
   */
  protected function getOtherRelatedEntities() : List<KeyableBean>
  {
    return {}
  }
  
  private function writeLinkedToEntity(ent : KeyableBean) : void
  {
    var entTypeName = getEntityType(ent).RelativeName  
    if (not (isAdminEntity(entTypeName) or _processedShallowEntities.contains(ent)))
    {    
      _output.append("<${entTypeName} ${TYPE_ATTR}=\"" +entTypeName+ "\"")
      _output.append(" ${PUBLIC_ATTR}=\"" +ent.PublicID+ "\"")
          
      if (ent typeis EffDated)
      {        
        writeEffDatedAttributes(ent)                  
      }
      _output.append(" />\n")
      addToProcessedShallowEntities(ent)
    }
  }
  
  private function findEntRoot(ent : EffDated) : EffDated
  {
    var root = ent
    while (root.BasedOnUntyped != null) root = root.BasedOnUntyped
    
    return root
  }

  private function writeOutVisitedEntities() : void
  {
    var MAX_COUNT = 15
    var count = 0
    print("BEFORE: linked = ${_linkedEntities.size()}, processed=${_processedEntities.size()}")
    while (_linkedEntities.size() != _processedEntities.size() and (count < MAX_COUNT))
    { 
      _linkedEntities.Values.toList().each(\ o ->
      {        
        if (not alreadyProcessedBean(o))
        {       
         writeEntity(o)       
        }
      })
      count++      
    }
    print("AFTER: Count = ${count} linked = ${_linkedEntities.Values.size()}, processed=${_processedEntities.Values.size()}")
    //Check if we stopped processing because of a potential infinite loop
    if (count == MAX_COUNT)
    {
      Logger.logError("Count = ${count} _linkedEntities.size() = ${_linkedEntities.size()}  _processedEntities.size() = ${_processedEntities.size()}")
      if (_linkedEntities.size() > _processedEntities.size())
        Logger.logError("Linked but not processed: " + _linkedEntities.Keys.subtract(_processedEntities.Keys))
      else
        Logger.logError("Processed but not linked: " + _processedEntities.Keys.subtract(_linkedEntities.Keys))
      throw "I've stopped processing since it looks like I'm going to get stuck in an infinite loop!!"
    }
    _linkedEntities.clear()
    _processedEntities.clear()
  }
  
  private function addToProcessedBeans(bean : KeyableBean) : void
  {
    _processedEntities[bean.IntrinsicType.RelativeName+bean.PublicID] = bean
  }
  
  private function alreadyProcessedBean(bean : KeyableBean) : boolean
  {
    return _processedEntities.containsKey(bean.IntrinsicType.RelativeName+bean.PublicID)
  }
  
  private function addToLinkedBeans(bean : KeyableBean) : void
  {
    _linkedEntities[bean.IntrinsicType.RelativeName+bean.PublicID] = bean
  }
  
  private function addToFirstLevelLinkedBeans(bean : KeyableBean) : void
  {
    _firstLevelLinkedEntities[bean.IntrinsicType.RelativeName+bean.PublicID] = bean
  }
  
  private function addToProcessedShallowEntities(bean : KeyableBean) : void
  {
    _processedShallowEntities.add(bean)
  }
  
  /**
   * @param traverseOnly If true, then just traverse the policy graph without writing XML
   */
  private function writeLinkProperty(ent : KeyableBean, prop : IPropertyInfo, traverseOnly : boolean) : void
  {
   print("Processing link prop: "+prop.Name+ " " +prop.Private)
    var linkedEnt = getFieldValue(ent, prop.Name) as KeyableBean 
    
    if (_exportAsSubmission)
    {
      if (ent typeis Job and prop.Name == "SelectedVersion") linkedEnt = _lastBranchToExport 
      if (ent typeis PolicyPeriod and prop.Name == "Job") linkedEnt = _currentBranch.FirstPeriodInTerm.Job
    }

    if (linkedEnt != null and shouldExportEntity(getEntityType(linkedEnt).RelativeName))
    {    
      if (not traverseOnly)
      {
        var linkType = getEntityType(linkedEnt)  
        _output.append("<" +prop.Name+ " type=\"" +linkType.RelativeName+                                   
                                     "\" link=\"" +linkedEnt.PublicID+ "\" />\n")
      }      
      if (ProcessingSubmission)
      {
        addToLinkedBeans(linkedEnt)
      }      
      else
      {
        addToFirstLevelLinkedBeans(linkedEnt)
      }
    }
  }

  private function writeColumnProperty(ent : KeyableBean, prop : IPropertyInfo) : void
  {
    print("Processing column prop: "+prop)
    var propValue = getFieldValue(ent, prop.Name)

    // V10 - Masking PI
    if(MASK_PROPERTY_ON_EXPORT.contains(prop.Name)){
      propValue = getMaskedValues(prop.Name, propValue as String)
    }
    propValue = modifyPropertyValueIfNeeded(ent, prop, propValue)
           
    if (propValue != null)
    {    
      var linkTypeName = (typeof(propValue)).RelativeName 
      _output.append("<" +prop.Name+ " type=\"" +linkTypeName+ 
                                  "\" value=\"" +formatValue(propValue, linkTypeName)+ "\" />\n")
    }
  }
  
  private function writeEntity(ent: KeyableBean) : void
  {   
    if (not alreadyProcessedBean(ent))
    {
      //If not part of current branch, ignore it - it will get picked up on a later branch
      if (isPartOfCurrentPeriodGraph(ent) and not (ent typeis Transaction and !shouldExportTransactions()))
      {                                     
        writeEntityVersion(ent)        
        writeAnyOtherRelatedEntities(ent)                                         
      }
      else
      {
        removeFromLinkedEntites(ent)
      }
    }          
  }
  
  private function removeFromLinkedEntites(bean : KeyableBean) : void
  {
    _linkedEntities.remove(bean.IntrinsicType.RelativeName+bean.PublicID)
  }
  
  /**
   * Always export transactions unless the user has chosen to "downgrade" from QUOTED status
   */
  private function shouldExportTransactions() : boolean
  {
    if ((_currentBranch == _lastBranchToExport and _exportAsStatus.Priority >= PolicyPeriodStatus.TC_QUOTED.Priority) or
        (_currentBranch != _lastBranchToExport)
    )
    {
      return true
    }
    
    return false
  }
  
  private function writeDeleteEntity(ent : KeyableBean) : void
  {
    var entTypeName = getEntityType(ent).RelativeName      

    if (not isAdminEntity(entTypeName))
    {
      _output.append("<${entTypeName} ${TYPE_ATTR}=\"" +entTypeName+ "\"")
      _output.append(" ${PUBLIC_ATTR}=\"" +ent.PublicID+ "\"")
      _output.append(" ${DELETE_ATTR}=\"true\"")

      if (ent typeis EffDated)
      {        
        writeEffDatedAttributes(ent)                      
      }
      _output.append(" />\n")
    }
  }
  
  private function writeEffDatedAttributes(ent : EffDated) : void
  {   
    _output.append(" ${BRANCH_ATTR}=\"" +ent.BranchUntyped.PublicID+ "\"")

    if (ent.BasedOnUntyped != null and not (ent typeis Transaction))
    {
      _output.append(" ${BASEDON_ATTR}=\"" +ent.BasedOnUntyped.PublicID+ "\"")
      _output.append(" ${INITIALVER_ATTR}=\"" +findEntRoot(ent).PublicID+ "\"")
      _output.append(" ${EFFDATE_ATTR}=\"" +_dateFormat.format(ent.EffectiveDate)+ "\"")
    }
    _output.append(" ${FIXEDID_ATTR}=\"" +ent.FixedId+ "\"")                        
      
  }
  
  private function shallowWriteEntity(ent : KeyableBean) : void
  {   
    var entTypeName = getEntityType(ent).RelativeName      
  
    if (not (isAdminEntity(entTypeName) or _processedShallowEntities.contains(ent)))
    {
      _output.append("<${entTypeName} ${TYPE_ATTR}=\"" +entTypeName+ "\"")
      _output.append(" ${PUBLIC_ATTR}=\"" +ent.PublicID+ "\"")
    
      if (ent typeis PolicyPeriod)
      {
         writePolicyPeriodAttributes(ent)
      }    
      else if (ent typeis EffDated)
      {        
        writeEffDatedAttributes(ent)                
      }
      _output.append(">\n")
   
      getEntityType(ent).TypeInfo.Properties
                                 .where(\ p ->  (p typeis IArrayPropertyInfo and p.DisplayName =="WorksheetContainerArray") or
                                               p typeis ILinkPropertyInfo or
                                               p typeis IColumnPropertyInfo or
                                               p typeis ITypekeyPropertyInfo)
                                 .each(\prop ->
                                     {
                                       if (shouldExportProperty(prop, false)) {
                                         var propType : Type
                                         try {
                                           propType = typeof(ent[prop.Name])
                                         } catch (e) {
                                           // If an exception happens, then we silently discard it and we do not write this property to the XML.
                                         }
                                         if (prop typeis IArrayPropertyInfo)
                                         {
                                           var arrayEntities = getFieldValue(ent, prop.Name) as Collection<KeyableBean>
                                           arrayEntities.each(\ k ->
                                               {
                                                 if (shouldExportEntity(getEntityType(k).RelativeName))
                                                 {
                                                   if(k typeis WorksheetContainer){
                                                     addToLinkedBeans(k)
                                                   }else{
                                                     addToLinkedBeans(k)
                                                   }
                                                 }
                                               })
                                         }

                                         print("Processing property: ${typeof(ent)}.${prop.Name} of type ${typeof(prop)}")
                                         if (prop typeis ILinkPropertyInfo) {
                                           writeLinkProperty(ent, prop, false)
                                         } else if (shouldExportEntity(prop.Name) and
                                             ((prop typeis IColumnPropertyInfo) or (prop typeis ITypekeyPropertyInfo))) {
                                           writeColumnProperty(ent, prop)
                                         }
                                       }
                                     })
      
      _output.append("</${entTypeName}>\n")       
      addToProcessedShallowEntities(ent)        
    }    
  }

  private function isPartOfCurrentPeriodGraph(ent : KeyableBean) : boolean
  {
    if (ent typeis PolicyPeriod)
    {
      return _currentPeriodPublicID == ent.PublicID
    }
    else if (ent typeis Job)
    {
      if (_exportAsSubmission)
      {
        return ent typeis Submission
      }
      else
      {
        return _currentPeriodPublicID == ent.LatestPeriod.PublicID
      }
    }
    else if (ent typeis AuditInformation and ent.Audit != null)
    {
      return _currentPeriodPublicID == ent.Audit.PolicyPeriod.PublicID
    }
    else if (ent typeis UWIssueHistory)
    {
      return _currentPeriodPublicID == ent.PolicyPeriod.PublicID
    }
    else if (_exportAsSubmission and (ent typeis Cost or ent typeis Transaction))
    {
      return false
    }
    else if (ent typeis EffDated)
    {
      return _currentPeriodPublicID == ent.BranchUntyped.PublicID
    }   
    
    return true
  }
   
  private function writeCommit() : void
  {      
    _output.append("<Commit />\n")          
  }
  
  /**
   * For each entity, examine IArrayPropertyInfo, ILinkPropertyInfo, IColumnPropertyInfo
   * and ITypekeyPropertyInfo properties.
   */
  private function writeEntityVersion(ent: KeyableBean) : void
  { 
    var traverseOnly = false
    if (not alreadyProcessedBean(ent))
    {           
      var entTypeName = getEntityType(ent).RelativeName      
    
      addToLinkedBeans(ent)      
      addToProcessedBeans(ent)
    
      if (not isAdminEntity(entTypeName))
      {
        _output.append("<${entTypeName} ${TYPE_ATTR}=\"" +entTypeName+ "\"")
        _output.append(" ${PUBLIC_ATTR}=\"" +ent.PublicID+ "\"")
      
        if (ent typeis PolicyPeriod)
        {
          writePolicyPeriodAttributes(ent)
        }      
        else if (ent typeis EffDated)
        {                  
          if (ProcessingSubmission)
          {
            _output.append(" ${BRANCH_ATTR}=\"" +ent.BranchUntyped.PublicID+ "\"")                                         
          }
          else
          {
            writeEffDatedAttributes(ent)   
          }
        }
        _output.append(">\n")
     
        getEntityType(ent).TypeInfo.Properties
                                   .where(\ p -> p typeis IArrayPropertyInfo or
                                                 p typeis ILinkPropertyInfo or
                                                 p typeis IColumnPropertyInfo or
                                                 p typeis ITypekeyPropertyInfo)
                                   .each(\ prop -> 
        {      
          if (shouldExportProperty(prop, TreatAsSubmission) )
          {       
            var propType : Type 
            try
            {
              propType = typeof(ent[prop.Name])
            }
            catch(e)
            {
              // If an exception happens, then we silently discard it and we do not write this property to the XML.
            }

            print("Processing property: ${typeof(ent)}.${prop.Name} of type ${typeof(prop)}")
            if (prop typeis IArrayPropertyInfo)
            {             
              var arrayEntities = getFieldValue(ent, prop.Name) as Collection<KeyableBean>        
              arrayEntities.each(\ k -> 
              {
                if (shouldExportEntity(getEntityType(k).RelativeName))
                {
                  if(k typeis WorksheetContainer){
                    addToLinkedBeans(k)
                  }else{
                    addToLinkedBeans(k)
                  }
                }
              })
            }
            else if (prop typeis ILinkPropertyInfo)
            {         
               writeLinkProperty(ent, prop, traverseOnly)            
            }
            else if (!traverseOnly and
                     shouldExportEntity(prop.Name) and 
                    ((prop typeis IColumnPropertyInfo) or (prop typeis ITypekeyPropertyInfo)))
            {
              writeColumnProperty(ent, prop)
            }      
          }
        })        
        
        _output.append("</${entTypeName}>\n")               
      }
    }
  } 
  
  private property get TreatAsSubmission() : boolean
  {
    return _exportJob typeis Submission or _exportAsSubmission
  }
  
  /**
   * This is called only if we are trying to convert something into a Submission or if we are downgrading Status
   * from Bound to Quoted or Draft.
   */
  private function modifyPropertyValueIfNeeded(ent : KeyableBean, prop : IPropertyInfo, propValue : Object) : Object
  {
    var modifiedPropValue = propValue
    
    if (TreatAsSubmission or (_processingLastBranch and 
                                 (ent typeis Policy or
                                  ent typeis PolicyPeriod or 
                                  ent typeis Job)))
    {
      switch(_exportAsStatus)
      {
        case PolicyPeriodStatus.TC_DRAFT:
          switch(prop.Name)
          {      
            case "IssueDate"            : 
                                          if (TreatAsSubmission) modifiedPropValue = null
                                          break
            case "EffDate"              :                
            case "EditEffectiveDate"    : 
                                          if (TreatAsSubmission) modifiedPropValue = _currentBranch.PeriodStart
                                          break
            case "CloseDate"            :                        
            case "ModelDate"            :
            case "ModelNumber"          : 
            case "MostRecentModelIndex" : modifiedPropValue = null; break
            case "Locked"               : 
            case "MostRecentModel"      : 
            case "ValidQuote"           : modifiedPropValue = new Boolean(false); break
            case "PolicyNumber"         : 
                                          if (TreatAsSubmission) modifiedPropValue = "Unassigned"
                                          break
            case "Status"               : 
                                          if (ent typeis PolicyPeriod) 
                                          {
                                            modifiedPropValue = PolicyPeriodStatus.TC_DRAFT
                                          }
                                          break
            case "QuoteMaturityLevel":
              if(ent typeis PolicyPeriod){
                modifiedPropValue = QuoteMaturityLevel.TC_UNRATED
              }
              break
          }
          break
        case PolicyPeriodStatus.TC_QUOTED:
          switch(prop.Name)
          {
            case "IssueDate"            : 
                                          if (TreatAsSubmission) modifiedPropValue = null
                                          break
            case "EffDate"              :
            case "EditEffectiveDate"    : 
                                          if (TreatAsSubmission) modifiedPropValue = _currentBranch.PeriodStart
                                          break
            case "CloseDate"            : 
            case "EffectiveDate"        :
            case "ExpirationDate"       :
            case "ModelDate"            :
            case "ModelNumber"          : 
            case "MostRecentModelIndex" : modifiedPropValue = null; break
            case "Locked"               :
            case "MostRecentModel"      : modifiedPropValue = new Boolean(false); break
            case "ValidQuote"           : modifiedPropValue = new Boolean(true); break
            case "PolicyNumber"         : 
                                          if (TreatAsSubmission) modifiedPropValue = "Unassigned"
                                          break
            case "Status"               : 
                                          if (ent typeis PolicyPeriod) 
                                          {
                                            modifiedPropValue = PolicyPeriodStatus.TC_QUOTED
                                          }
                                          break 
          }
          break
        case PolicyPeriodStatus.TC_AUDITCOMPLETE:
        case PolicyPeriodStatus.TC_BOUND:
          break //do nothing
        //V10 - Added case to support renewal copy
        case PolicyPeriodStatus.TC_RENEWING:
          break //do nothing
        default : throw "Switching of work order to status ${_exportAsStatus} is not supported"
      }   
    }
    
    return modifiedPropValue
  }
  
  private function getEntityType(ent : KeyableBean) : IType
  {
    return ent.IntrinsicType
  }
  
  protected function writeAnyOtherRelatedEntities(ent : KeyableBean) : void
  {
    if (ent typeis Job)
    {
      ent.AllActivities.toList().each(\ a -> addToLinkedBeans(a))
    }
    
    //No harm in hitting  the Coverages, Cost and Transactions again
    //just in case any of these were not part of the traversed policy graph
    if (ent typeis PolicyPeriod)
    {
      if (ProcessingSubmission) 
      {
        writeAllCoverages(ent)
      }
      
      writeAllCosts(ent)
      
      if (shouldExportTransactions())
      {
        writeAllTransactions(ent)
      }
      getOtherRelatedEntities().each(\ s -> addToLinkedBeans(s))
    }         
  }
  
  private function writeAllCoverages(branch : PolicyPeriod) : void
  {
    branch.AllCoverables.each(\ c -> c.CoveragesFromCoverable.each(\ cov -> addToLinkedBeans(cov)))   
  }
  
  private function writeAllCosts(branch : PolicyPeriod) : void
  {
    branch.AllCosts.toList().sortByDescending(\ e -> e.EffectiveDate).each(\ c -> addToLinkedBeans(c))
  }
  
  private function writeAllTransactions(branch : PolicyPeriod) : void
  {
    branch.AllTransactions.each(\ c -> addToLinkedBeans(c as EffDated))
  }

  //V10 - To handle workflow and policyterm
  private function createNonEffDatedEntityData() : void
  {
    if(CurrentBranch.ActiveWorkflow != null){
      writeEntity(CurrentBranch.ActiveWorkflow)
      if(CurrentBranch.ActiveWorkflow.Message != null){
        writeEntity(CurrentBranch.ActiveWorkflow.Message)
      }
      CurrentBranch.ActiveWorkflow.Log.each(\elt -> writeEntity(elt))
    }
    if(CurrentBranch.PolicyTerm != null){
      writeEntity(CurrentBranch.PolicyTerm)
    }
  }

}
