package com.guidewire.proserve.pc.importexport

uses gw.api.util.Logger
uses gw.lang.reflect.IEnumConstant
uses gw.lang.reflect.IPropertyInfo
uses gw.plugin.Plugins
uses gw.plugin.account.IAccountPlugin
uses gw.plugin.jobnumbergen.IJobNumberGenPlugin
uses gw.plugin.policynumgen.IPolicyNumGenPlugin
uses gw.xml.XMLNode

uses java.math.BigDecimal
uses java.text.SimpleDateFormat

uses entity.Job

/**
 * This abstract base class contains state and behavior that is common between import and export functionality.
 */
abstract class EntityXMLBase {

  /**
   * Common state used for both exporting and importing policies.
   */
  protected var _currentBranch            : PolicyPeriod as CurrentBranch
  protected var _processingSubmission     : boolean      as ProcessingSubmission

  /**
   * Maintenance Note: The SimpleDateFormat class is *NOT* thread safe!
   *   DO NOT make this field static.  Doing so can cause rare and mysterious bugs on multi-user systems.
   */
  protected final var _dateFormat : SimpleDateFormat = new SimpleDateFormat("yyyy/MM/dd hh:mm:ss:SS a")



  protected final static var VALUE_ATTR : String = "value" 
  protected final static var LINK_ATTR : String = "link" 
  protected final static var BASEDON_ATTR : String = "basedon"
  protected final static var INITIALVER_ATTR : String = "initialversion"
  protected final static var TYPE_ATTR : String = "type" 
  protected final static var BRANCH_ATTR : String = "branch"
  protected final static var PUBLIC_ATTR : String = "publicid"
  protected final static var FIXEDID_ATTR : String = "fixedid"
  protected final static var EFFDATE_ATTR : String = "effdate"
  protected final static var DELETE_ATTR : String = "delete"
  protected final static var EDITEFFDATE_ATTR : String = "editeffectivedate"
  protected final static var ISFORAUDITREVERSAL_ATTR : String = "isforauditreversal"
  protected final static var ISFORREWRITE_ATTR : String = "isforrewrite"
  // V10
  protected final static var ISFORRENEW_ATTR : String = "isforrenew"
  protected final static var MASK_PROPERTY_ON_EXPORT : String[] = {
      "PrimaryInsuredName",
      "LastNameInternal",
      "LicenseNumberInternal",
      "LastName",
      "LicenseNumber",
      "TaxID",
      "OfficialIDValue",
      "Phone",
      "CellPhone",
      "HomePhone",
      "FaxPhone",
      "AddressLine1",
      "AddressLine2",
      "AddressLine1Internal",
      "AddressLine2Internal",
      "EmailAddress1",
      "EmailAddress2"
  }

  //Basic OOTB BusinessAuto and WC
  private final static var ADMIN_ENTITY_NAMES : String[] = {  
    "ActivityPattern",
    "AssignableQueue",
    "AssignableQueue",
    "CommodityExt",
    "Group",
    "GroupUser",
    "IndustryCode",
    "LicensedState",   
    "Organization",
    "ProducerCode", 
    "TerritoryCode",
    "RegionZone",
    "Role",
    "User",
    "UserProducerCode",
    "UWAuthorityType",
    "UWCompany",
    "UWIssueType",
    "WCClassCode"
  }

  private final static var ENTITIES_TO_IGNORE : String[] = {  
    "Acctholderedge",
    "ContactTag",       // new to 7.0
    "Jobpolicyperiod",
    "PrimaryAcctLoc",
    "PolicyEffDatedRegistry",
    "RenewalGroup", //TODO
    "WorksheetContainer" // Uncomments this code after actual rating implemented
  }

  /**
   * Do not ever write these properties to the export XML.
   */
  private final static var IGNORE_PROPERTY_ON_EXPORT : String[] = {
    "AccountNumberDenorm",
    "BranchValue",               // This property is not Writable.  Definition: "Link to root of effdated tree."
    "CityDenorm",
    "CityInternalDenorm",
    "CompanyNameInternalDenorm",
    "FirstNameDenorm",
    "FirstNameInternalDenorm",
    "Fixed",                     // This property is not Readable or Writable on a number of entities.
    "LastNameDenorm",
    "LastNameInternalDenorm",
    "NameDenorm",
    "Period",
    "PostalCodeDenorm",
    "PostalCodeInternalDenorm",
    "PrimaryInsuredNameDenorm",
    "PublicID",                  // This property of KeyableBean is exported as an attribute of the Element for the table. It would be redundant to also export it as a separate property as a child XML Element.
    "SubjectDenorm",              // Related to Notes on a Policy.
      "WorksheetContainer" //Uncomments this code after actual rating implemented
  }

  /**
   * Additional properties to ignore when exporting a job as a Submission, even though it may be at a later stage in the process.
   */
  private final static var IGNORE_PROPERTY_ON_SUB_EXPORT : String[] = {
    "EffectiveDate",
    "ExpirationDate",
    "BasedOnValue"
  }

  private final static var IGNORE_PROPERTY_ON_IMPORT : String[] = {
    "BasedOnValue",
    "BeanVersion",
    "CreateTime",
    "CreateUser",
    "ChangeType",
    "HumanTouched",
    "ID",
    "Period",
    "PolicyNumber",
    "PublicID",
    "Subtype",
    "UpdateTime",
    "UpdateUser"
  }

  /**
   * XML Element names that appear as direct children of the root <AccountGraph> element,
   * but which do NOT represent Entity objects.
   */
  private final static var TRIGGER_ELEMENTS : String[] = {
    "TriggerJob",  // Constant "TriggerJob" is not currently used in this system.
    "Commit"
  }
  
  protected static function isAdminEntity(typeString : String) : boolean
  {
    return ADMIN_ENTITY_NAMES.contains(typeString)
  }

  protected static function generateNewPolicyNumber(branch : PolicyPeriod) : String
  {
    return Plugins.get(IPolicyNumGenPlugin).genNewPeriodPolicyNumber(branch)
  }
  
  protected static function generateNewAccountNumber(account : Account) : String
  {
    //return account.generateAccountNumber()
    return Plugins.get(IAccountPlugin).generateAccountNumber(account)
  }
  
  protected static function generateNewJobNumber(job : Job) : String
  {
    return Plugins.get(IJobNumberGenPlugin).genNewJobNumber(job)
  }
  
  protected static function shouldImportPropertyOrEntity(propName : String) : boolean
  {
    return not IGNORE_PROPERTY_ON_IMPORT.contains(propName)
  }
  
  protected static function shouldImportEntity(typeName : String) : boolean
  {
    //uncomment ENTITIES_TO_IMPORT to import sets of entities at a time when debugging
    return shouldExportEntity(typeName) // and ENTITIES_TO_IMPORT.contains(entName))
  }
   
  protected static function shouldExportEntity(typeName : String) : boolean
  {    
    return not ENTITIES_TO_IGNORE.contains(typeName)
  }
  
  protected static function shouldExportProperty(propInfo : IPropertyInfo, treatAsSubmission : boolean) : boolean 
  {
    return treatAsSubmission ?  not IGNORE_PROPERTY_ON_EXPORT.contains(propInfo.Name) and not IGNORE_PROPERTY_ON_SUB_EXPORT.contains(propInfo.Name) :
                                not IGNORE_PROPERTY_ON_EXPORT.contains(propInfo.Name)
  }
  
  //Might need to expand this list 
  private function typedValue(bean : KeyableBean, propertyName : String, value : Object, toType : String) : Object
  {
    Logger.logDebug("Converting '${value}' to ${toType} for property " + propertyName + " on bean of type ${(typeof bean).Name}")

    // For well known types, do direct conversion:
    switch(toType)
    {
      case "String"              : return value
      case "Boolean"             : return value as Boolean
      case "BigDecimal"          : return value as BigDecimal
      case "Date"                :      
      case "FastCompareDate"     : return _dateFormat.parse(value as String)    
      case "EffDatedChangeType"  : return value as typekey.EffDatedChangeType     
      case "Integer"             : return value as Integer
      case "Long"                : return value as Long
    }

    // Handle all typekey and enum values:
    var beanTypeInfo = (typeof bean).TypeInfo
    var propInfo : IPropertyInfo = beanTypeInfo.getProperty(propertyName)
    var propertyType = propInfo.Type         // PC 4.0  (deprecated in PC 7.0)
//    var propertyType = propInfo.FeatureType  // Preferred in PC 7.0
    if (propertyType.AllTypesInHierarchy.contains(IEnumConstant)) {
      // Use the 'public static get(String)' method to fetch the singleton instance for this string value.
      var getMethod = propertyType.TypeInfo.getMethod("get", {String})
      if (getMethod != null and getMethod.Static) {
        var enumValue = getMethod.CallHandler.handleCall(null, {value})
        Logger.logDebug("  for type ${propertyType.Name}, value = ${enumValue}")
        return enumValue
      }
    }

    Logger.logInfo("We don't know how to convert '${value}' to ${toType} for property " + propertyName + " on bean of type ${(typeof bean).Name}")
    return value
  }
  
  protected function formatValue(value : Object, valueType : String) : Object
  {
    switch (valueType)
    {
      case "FastCompareDate" :
      case "Date"            : return _dateFormat.format(value)
      case "String"          : return org.apache.commons.lang.StringEscapeUtils.escapeXml(value as String)        
      default                : return value
    }
  }
  
  protected function getFieldValue(bean : KeyableBean, fieldName : String) : Object
  {
    var value : Object
    
    try
    {
      value = bean[fieldName]
    }
    catch(e)
    {
      value = bean.getFieldValue(fieldName)
    }

    return value
  }
  
  protected function setFieldValue(bean : KeyableBean, propertyName : String, stringValue : String, xmlType : String)
  {
    setFieldValue(bean, propertyName, typedValue(bean, propertyName, stringValue, xmlType))
  }
  
  protected function setFieldValue(bean : KeyableBean, propertyName : String, value : Object)
  {
    try
    {
      // Try the Gosu convention of setting bean properties like Map entries.
      bean[propertyName] = value
    }
    catch(e)
    {
      // If that fails, then try using the KeyableBean method for setting properties.
      bean.setFieldValue(propertyName, value)
    }
  }
  
  protected static function isTriggerElement(ele : XMLNode) : boolean
  {
    return TRIGGER_ELEMENTS.contains(ele.ElementName)
  }

  //V10
  protected function getMaskedValues(propName : String, propValue : String) : String
  {
    var jobNum = _currentBranch.Job?.JobNumber
    if(propValue != null){
      if("LastNameInternal".equalsIgnoreCase(propName) || "LastName".equalsIgnoreCase(propName) ||
          "PrimaryInsuredName".equalsIgnoreCase(propName)){
        return _currentBranch.PolicyNumber
      }
      else if("LicenseNumberInternal".equalsIgnoreCase(propName) || "LicenseNumber".equalsIgnoreCase(propName)){
        return jobNum?.substring(1,9)
      }
      else if("TaxID".equalsIgnoreCase(propName) || "OfficialIDValue".equalsIgnoreCase(propName)){
        return "999-" + jobNum.substring((jobNum?.length()) - 6, jobNum?.length() - 4) + "-" + jobNum.substring((jobNum?.length()) - 4, jobNum?.length())
      }
      else if("Phone".equalsIgnoreCase(propName) || "CellPhone".equalsIgnoreCase(propName) ||
              "HomePhone".equalsIgnoreCase(propName) || "FaxPhone".equalsIgnoreCase(propName)){
        return "555" + jobNum.substring((jobNum?.length()) - 7, jobNum?.length())
      }
      else if("EmailAddress1".equalsIgnoreCase(propName) || "EmailAddress2".equalsIgnoreCase(propName)){
        return propValue?.split('@')[0] + "@test.com"
      }
      else{
        return "xxxxxxxxx"
      }
    }
    return propValue
  }

  /**
   * For debugging entity import issues
   */
//   protected final static var ENTITIES_TO_IMPORT : String[] = {          
//     "Account",
//     "AccountContact",
//     "AccountHolder",
//     "AccountCertHolderExt",
//     "AccountLocation",
//     "Address",
//     "Policy",
//     "AutoNumberSequence",
//   }

}
