package com.guidewire.proserve.pc.importexport

uses gw.api.database.Query
uses gw.api.effdate.EffDatedUtil
uses gw.api.util.Logger
uses gw.lang.reflect.IType
uses gw.lang.reflect.TypeSystem
uses gw.transaction.Transaction
uses gw.xml.SimpleXMLNodeFactory
uses gw.xml.XMLNode
uses entity.Job
uses gw.xml.parser2.PLXMLNode
uses gw.xml.parser2.PLXMLParser

uses java.io.ByteArrayOutputStream
uses java.util.zip.GZIPInputStream
uses java.util.zip.GZIPOutputStream

/**
 * EntityXMLImporter, given the XML produced above and the command to import it, builds a new set
 * of Entities from the data in the XML. It creates new Account and Policy entity objects rather
 * than trying to find and update existing entities.
 */
class EntityXMLImporter extends EntityXMLBase {
  
  var _xmlNode : XMLNode
  var _allEntities = new HashMap<String, KeyableBean>()  // Key = Entity name + PublicID
  var _policy : Policy
  var _submissionJobNumber : String
  var _policyNumber : String
  
  construct(xml : XMLNode) {
    _xmlNode = xml
  }
  
  /**
   * The basic structure of the XML is: 
   * 
   * Policy
   * PolicyPeriod (of Submission)
   * Entities related to the above PolicyPeriod
   * Commit
   * PolicyPeriod (of PolicyChange)
   * Entities related to the above PolicyPeriod
   * Commit
   * 
   * <pre>
   * 1. Create the Policy first (since it is the container for all PolicyPeriods)
   * 2. Create the Submission PolicyPeriod (since all EffDated entities we create will need a branch)
   * 3. Iterate thru the XML and create entities *exactly* in the order that they are in the XML. Skip setting FK(s)
   * 4. Create all effdated entities using the above PolicyPeriod as the branch. Skip setting FK(s)
   * 5. Create all other entities (non effdated). Skip setting FK(s)
   * 6. Iterate thru all entities created and set their FK(s)
   * 7. Commit
   * 8. Repeat 3-7 for each job. The XML has Submission first, followed by the other jobs in the right order.
   * </pre>
   */
  public function import() : Account
  {
    gw.transaction.Transaction.runWithNewBundle(\bundle -> {
      var doc = _xmlNode//XMLNode.parse(_xmlString)
      if (_xmlNode.ElementName != "AccountGraph")
        throw "Expecting root XML Element name to be 'AccountGraph', but it is '${doc.ElementName}'."

      //create Policy first (since it is the container for all PolicyPeriods)
      _policy = createPolicy(doc)

      //create submission PolicyPeriod (since we need a PolicyPeriod to create effdated entities)
      createSubmissionBranch(doc)

      //var children = doc.Children.where(\ x ->not isSubmissionPeriod(x) and shouldImportEntity(x.Type))
      var children = doc.Children.where(\ x -> shouldImportEntity(x.Type))
      var max = children.Count
      var count = 0
      var startNode : XMLNode
      var endNode : XMLNode

      //create everythig else
      children.each(\ ele ->
          {
            count++
            Logger.logInfo("Processing ${count}/${max}: Entity ${ele.ElementName} " + (ele.PublicID == null ? "" : "publicID="+ele.PublicID))
            if (ele.ElementName == "Commit")
            {
              setFKOnEntities(children, startNode, endNode)
              setPolicyNumber()
              if (CurrentBranch.Status == PolicyPeriodStatus.TC_BOUND)
              {
                //We have to make the most recently created branch the "LatestPeriod".
                //This is needed because you can't start a PolicyChange if your Submission
                //isn't MostRecentModel
                if (CurrentBranch.BasedOn != null)
                {
                  setFieldValue(CurrentBranch.BasedOn, "MostRecentModel", false)
                }

                setFieldValue(CurrentBranch, "MostRecentModel", true)
              }
              bundle.getBeansByRootType(WorksheetContainer).each(\elt -> {
                if((elt as WorksheetContainer).Branch == null){
                  elt.remove()
                }
              })
              Transaction.getCurrent().commit()
              startNode = null
            }
            // V10 - To skip import on following entities
            else if (!ele.ElementName.containsIgnoreCase("UWIssue") and
                !ele.ElementName.containsIgnoreCase("UWIssueHistory"))
            {
              var eleTypeName = ele.Type
              var entType = TypeSystem.getByRelativeName(eleTypeName)
              var elePublicID = ele.PublicID
              var ent = createIfNeededNewEntityOfType(entType, ele)

              if (startNode == null) startNode = ele
              if (not isAdminEntity(eleTypeName))
              {
                populateProperties(ent, ele)
              }
              addNewlyCreatedEntity(ent, entType.RelativeName, elePublicID)
            }
            endNode = ele
            Logger.logDebug("Last processed ele = ${ele.ElementName} publicid=${ele.PublicID}")
          })
    },"su")

    updateRatingWorksheet(_policy)
    return _policy.Account
  }

  /**
   * Extract the XML nodes in the range from start to end, inclusive and return in a List.
   * The start and end elements must both be in the list, in that order.
   * It's OK for the start and end points to be the same XML Element.
   *
   * Returning an empty list is not currently supported.  If support is needed, then null values
   * for both start and end nodes should probably produce and empty list as the result.
   */
  private static function extractRangeOfNodes(allChildren : List<XMLNode>, startNode : XMLNode, endNode : XMLNode) : List<XMLNode>
  {
    var foundStartNode = false
    var foundEndNode = false
    var nodes = new ArrayList<XMLNode>()
    
    for (ele in allChildren)
    {
      if (not shouldImportEntity(ele.Type))
        throw "Unimportable Entity of type ${ele.Type} should NOT be seen here, as the calling method filters them out before processing them."

      if (not isTriggerElement(ele)) {
        if (!foundStartNode and ele == startNode) foundStartNode = true
      
        if (foundStartNode) nodes.add(ele)
      
        if (ele == endNode) {foundEndNode = true; break}
      }
    }
    if (not foundStartNode) throw "Unable to find starting XMLNode: " + startNode
    if (not foundEndNode)   throw "Unable to find ending XMLNode: " + endNode
    
    return nodes
  }
  
  private function setFKOnEntities(allChildren : List<XMLNode>, startNode : XMLNode, endNode : XMLNode)
  {
    //set the FK on all entities created so far
    var children = extractRangeOfNodes(allChildren, startNode, endNode)
    for(ele in children) 
    {         
      var eleTypeName = ele.Type          
      var entType = TypeSystem.getByRelativeName(eleTypeName)
      var elePublicID = ele.PublicID
      var ent = getCreatedEntity(entType.RelativeName, elePublicID)
      //V10 - Added ent for entity
      if (ent != null && not isAdminEntity(eleTypeName))
      {
        Logger.logDebug("Last processed ele = ${ele.ElementName} publicid=${ele.PublicID}")
        populateLinks(ent, ele)
      } 
      //We commit after each job so no need to look at entities in the XML beyond 
      //the last entity that was processed in the main loop.
      if (ele == endNode)
      {
        return 
      }     
    }
  }
  
  private function setPolicyNumber() : void
  {
    if (CurrentBranch.Status == PolicyPeriodStatus.TC_BOUND or not (CurrentBranch.Job typeis Submission))
    {
      //only gen a new PolicyNumber on a Bound Submission
      if (ProcessingSubmission)
      {
        _policyNumber = generateNewPolicyNumber(CurrentBranch)
      }
      CurrentBranch.PolicyNumber = _policyNumber       
    }
  }
  
  private function getCreatedEntity(typeString : String, publicID : String) : KeyableBean
  {
    return _allEntities[typeString+publicID]
  }
  
  private function addNewlyCreatedEntity(ent : KeyableBean, typeString : String, publicID : String) : void
  {   
    _allEntities.put(typeString+publicID, ent)
  }
  
  private function createPolicy(docRoot : XMLNode) : Policy 
  {
    var policyNode = docRoot.findFirst(\ nn -> nn.ElementName == "Policy" and nn.Children.Count > 0)
   
    var publicID = policyNode.PublicID
    Logger.logDebug("Creating Policy " +publicID)
    var pol = getCreatedEntity("Policy", publicID)  as Policy
    if (pol == null)
    {
       pol = new Policy()        
    }
    populateProperties(pol, policyNode)
    populateLinks(pol, policyNode)
    addNewlyCreatedEntity(pol, "Policy", publicID)
   
    Logger.logDebug("...done creating Policy ${publicID}")
    
    return pol
  }
  
  /**
   * Setup to create mulitple Submissions, but only 1 is exported for now.
   */
  private function createSubmissionBranch(docRoot : XMLNode) : void
  {
    docRoot.Children.each(\ ele -> 
    {
      if (ele.ElementName == "PolicyPeriod" and isSubmissionPeriod(ele))
      {
        var publicID = ele.PublicID
        var pp = getCreatedEntity("PolicyPeriod", publicID) as PolicyPeriod
        if (pp == null)
        {
           pp = new PolicyPeriod()                   
        }
        setFieldValue(pp, "Policy", _policy)       
        populateProperties(pp, ele)
        addNewlyCreatedEntity(pp, "PolicyPeriod", publicID)      
        _currentBranch = pp
        _processingSubmission = true
        return
      }
    })
  }
  
  private static function isSubmissionPeriod(periodNode : XMLNode) : boolean
  {
    return periodNode.ElementName == "PolicyPeriod" and 
        (periodNode.Children.hasMatch(\ ele -> ele.ElementName == "Job" and ele.Type == "Submission") or
            // V10 - Additional conditions to manage renewal conversion scenarios
            (periodNode.getAttributeValue("basedon") == null and
              periodNode.Children.hasMatch(\elt1 -> elt1.ElementName == "Job" and elt1.Type == "Renewal")))
  }
  
  /**
   * Called before we try to set any of the FK(s) (using populateLinks())
   */
  private function populateProperties(bean : KeyableBean, node : XMLNode) : void
  {
    node.Children.each(\ child -> 
    {
      var propertyName = child.ElementName
      if (shouldImportPropertyOrEntity(propertyName))
      {
        var stringValue = child.Value
        if (stringValue != null)
        {
          Logger.logDebug("${node.ElementName}.${propertyName} = ${stringValue}")
          if (bean typeis Account and propertyName == "AccountNumber")
          {
            bean.AccountNumber = generateNewAccountNumber(bean)
          }         
          else if (bean typeis Job and propertyName == "JobNumber")
          {   
            _submissionJobNumber = generateNewJobNumber(bean)     
            bean.JobNumber = _submissionJobNumber                      
          }
          else if (bean typeis SubmissionGroup and propertyName == "Name")
          {
            bean.Name = "SG" + _submissionJobNumber
          }
          else
          {
            if (bean typeis EffDated and bean.Slice and (propertyName == "EffectiveDate" or propertyName == "ExpirationDate"))
            {
              //In slice mode we shouldn't mess with EffectiveDate and ExpirationDate
              return
            }
            else
            {
              setFieldValue(bean, propertyName, stringValue, child.Type)
            }
          }
        } 
      }
    })       
  }
   
  /**
   * There could be fk(s) to Admin entities or entities that were just created. This function
   * correctly finds the entity.
   */
  private function getExistingEntity(entTypeName : String, publicID : String) : Object
  {
    if (isAdminEntity(entTypeName))
    {
      return getAdminEntity(entTypeName, publicID)
    }
    else
    {
      return getCreatedEntity(entTypeName, publicID)
    }
  } 
  
  /**
   * Once *all* entities associated with a Branch have been created, we iterate thru all
   * entities and set their FK using this method.
   */
  private function populateLinks(bean : KeyableBean, node : XMLNode) : void
  {
    Logger.logDebug("populateLinks(${bean.IntrinsicType.RelativeName}, ${node.ElementName}, publicId=${node.PublicID})")
    node.Children.each(\ child -> 
    {
      var propertyName = child.ElementName
      if (shouldImportPropertyOrEntity(propertyName))
      {              
        var link = child.Link
        var typeString = child.Type
        if (link != null and typeString != null)
        {  
          // logger will cause error on ${getExistingEntity(typeString, link)} in some cases.	
          //Logger.logDebug("${bean.IntrinsicType.RelativeName}.${child.ElementName} = ${typeString+link} ${getExistingEntity(typeString, link)}")
          var fkEnt = getExistingEntity(typeString, link)  
          //The exported file will never set a fk to null. So if we can't find
          //the existing entity, leave the bean's fk set to whatever it is currently set to 
          if (fkEnt != null)
          {      
            //Entities just created on this branch are NOT sliced
            if (bean typeis EffDated and !bean.Slice and fkEnt typeis EffDated and fkEnt.Slice)
            {
              Logger.logDebug("${bean.IntrinsicType.RelativeName} sliced=${bean.Slice}, ${fkEnt.IntrinsicType.RelativeName}:${link} sliced=${fkEnt.Slice}")
              fkEnt = fkEnt.UnslicedUntyped
            }                                    
            bean.setFieldValue(propertyName, fkEnt)
          }
        }
      }
    })
  }
  
  /**
   * For a Submission we simply create a new EffDated entity (in window mode). For other jobs we'll need to
   * create a sliced version from an existing EffDated entity. We get the old entity by using
   * the BasedOn public id and from there getting its FixedId.  EffDatedUtil.createVersionList()
   * does the rest.
   * 
   * <p>If it is not effdated, life is easy, just create.
   * 
   * <p>Note: This is the most complicated piece of the code, make any changes very very carefully
   */
  private function createIfNeededNewEntityOfType(entityType : IType, eleNode : XMLNode) : KeyableBean
  {       
    var bean : KeyableBean
    var publicID = eleNode.PublicID
    var branchPublicID = eleNode.Branch
    var branch : PolicyPeriod
    
    if (not shouldImportEntity(entityType.RelativeName))
      throw "Unimportable Entity of type ${entityType.RelativeName} should NOT be seen here, as the calling method filters them out before processing them."

    bean = getCreatedEntity(entityType.RelativeName, publicID)   
    if (bean == null)
    {
      //PolicyPeriod is special special special. At this poiint the Submission PolicyPeriod has
      //already been created and Bound. So this PolicyPeriod is related to a PolicyChange, Cancellation, ...
      if (entityType.RelativeName == "PolicyPeriod")
      {
        _currentBranch = createPolicyPeriodFromBasedOn(eleNode)         
        _processingSubmission = false
        return _currentBranch
      }
      
      if (branchPublicID != null) 
      {
        branch = getCreatedEntity("PolicyPeriod", branchPublicID) as PolicyPeriod         
      }
      
      if (branch != null and entityType.AllTypesInHierarchy.contains(EffDated))
      {
        Logger.logDebug("Creating entity: ${entityType.RelativeName} on Branch ${branch}")  
        if (eleNode.BasedOn != null)          
        {          
            var effDate = _dateFormat.parse(eleNode.EffectiveDate)  
            var effDatedBean = getCreatedEntity(eleNode.Type, eleNode.InitialVersion) as EffDated
            var effVL = EffDatedUtil.createVersionList(branch, effDatedBean.FixedId)  
           
            var unslicedVersion = effVL.getVersionAsOf(effDate)
            var branchEditDate = branch.EditEffectiveDate
            bean = unslicedVersion
            if (eleNode.Deleted)
            {
              if (unslicedVersion.EffectiveDate <= branchEditDate and unslicedVersion.ExpirationDate > branchEditDate)
              {
                bean = unslicedVersion.getSliceUntyped(branchEditDate)
                bean.remove()
              }
            }
            else if (effDate == branchEditDate)
            {
              bean = unslicedVersion.getSliceUntyped(effDate) 
            }
        }
        else
        {
//          if (entityType.Name.startsWith("productmodel"))
//          {
//            entityType = entityType.Supertype
//          }
//          bean = entityType.TypeInfo.getConstructor( {PolicyPeriod} ).Constructor.newInstance( {branch} )  as KeyableBean
          var constr = entityType.TypeInfo.getConstructor({PolicyPeriod})
          if(constr != null){
            bean = constr.Constructor.newInstance( {branch} )  as KeyableBean
          }
          else{
            var patternCd = eleNode.Children.firstWhere(\elt -> elt.ElementName == "PatternCode")?.getAttributeValue("value")
            bean = gw.lang.reflect.ReflectUtil.construct(entityType.Name, {branch, patternCd})
          }
          bean = (bean as EffDated).UnslicedUntyped
        }
      } 
      else
      {           
        Logger.logDebug("Creating NON effdated entity: " +entityType.RelativeName)
        bean = entityType.TypeInfo.getConstructor( null ).Constructor.newInstance( null ) as KeyableBean         
      }
    }
    Logger.logDebug("   done creating entity: "+entityType.RelativeName)
    
    return bean
  }
  
  /**
   * return basedOn.createDraftMultiVersionJobBranch() or createDraftBranchInSamePeriod()
   */
  private function createPolicyPeriodFromBasedOn(ppNode : XMLNode) : PolicyPeriod
  {
    var basedOnBranch = getCreatedEntity("PolicyPeriod", ppNode.BasedOn) as PolicyPeriod 
    var effDate = _dateFormat.parse(ppNode.Attributes[EDITEFFDATE_ATTR])
    
    if (ppNode.BranchIsForAuditReversal)
    {
      return basedOnBranch.getSlice(effDate).createDraftMultiVersionJobBranch()
    }
    else if (ppNode.BranchIsForRewrite)
    {
      var rewrite = new Rewrite()
      rewrite.startJob(_policy, effDate, basedOnBranch.PeriodEnd)
      
      var rewritePeriod = rewrite.LatestPeriod      
      addNewlyCreatedEntity(rewrite, "Rewrite", ppNode.findFirst(\ c -> c.ElementName == "Job").Link)
      
      return rewritePeriod      
    }
    //V10 - To enable renewal copy
    else if (ppNode.BranchIsForRenew)
    {
      var pdStart = _dateFormat.parse(ppNode.Children.firstWhere(\elt -> elt.ElementName == "PeriodStart")?.getAttributeValue("value"))
      var pdEnd = _dateFormat.parse(ppNode.Children.firstWhere(\elt -> elt.ElementName == "PeriodEnd")?.getAttributeValue("value"))
      return basedOnBranch.createDraftBranchInNewPeriod(pdStart, pdEnd)
    }
    else
    {
      return basedOnBranch.getSlice(effDate).createDraftBranchInSamePeriod(effDate)
    }
  }

  private static function getAdminEntity(entName : String, publicID : String) : KeyableBean
  {
    try
    {
      return Query.make(TypeSystem.getByRelativeName(entName) as Type)
                  .compare("PublicId", Equals, publicID)
                  .select().AtMostOneRow as KeyableBean   
    }
    catch(e)
    {
      throw "${entName} is marked as an Admin entity but I can't find a ${entName} that has a public id of ${publicID}"
    }
  }

  /**
   * Update Rating Worksheet with generated FixedID
   * @param policy
   */
  private function updateRatingWorksheet(policy : Policy){
    policy.Periods.each(\period -> {
      var workSheetData = period?.WorksheetContainer?.WorksheetData
      if(workSheetData != null){
        var nodeMap : Map<String, Class<PLXMLNode>> = new HashMap()
        var stream = new GZIPInputStream(workSheetData.Data.toInputStream())
        var parser = new PLXMLParser(new SimpleXMLNodeFactory(nodeMap))
        var result = parser.parseInputStream(stream, "(stream)") as PLXMLNode
        period.AllCosts.each(\cost -> {
          result.Children.each(\child ->{
            if(child.Attributes.get("Description")?.containsIgnoreCase("${cost}") and child.Attributes.get("FixedId").
                containsIgnoreCase(cost.IntrinsicType.RelativeName)){
              if(child.Children.first()?.Attributes.get("RouinteCode")?.equalsIgnoreCase(cost.RateRoutine)){
                child.setAttributeValue("FixedId", cost.IntrinsicType.RelativeName + ":"+cost.FixedId)
              }
            }
          })
        })
        var size = result.NumChildren*1024
        var bos = new ByteArrayOutputStream(size)
        var goutput = new GZIPOutputStream(bos)
        result.writeTo(goutput)
        goutput.close()
        gw.transaction.Transaction.runWithNewBundle(\bundle ->{
          workSheetData = bundle.add(workSheetData)
          workSheetData.Data = new Blob(bos.toByteArray())
          bos.close()
        },"su")
      }
    })
  }
}
