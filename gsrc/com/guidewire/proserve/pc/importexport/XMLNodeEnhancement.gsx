package com.guidewire.proserve.pc.importexport

uses gw.xml.XMLNode

/**
 * Add properties and behavior to XMLNode to make it syntactically more convenient to process
 * imported XML and recreate Policy related Entity objects in the desired state.
 */
enhancement XMLNodeEnhancement : XMLNode {
    
  property get PublicID() : String
  {   
    var id = this.Attributes[EntityXMLBase.PUBLIC_ATTR]
    
    if (id == null)
    {
      id = this.Link
    }

    return id
  }
  
  property get Value() : String
  {
    return this.Attributes[EntityXMLBase.VALUE_ATTR]
  }
  
  property get Link() : String
  {
    return this.Attributes[EntityXMLBase.LINK_ATTR]
  }
  
  property get InitialVersion() : String
  {
    return this.Attributes[EntityXMLBase.INITIALVER_ATTR]
  }
  
  property get BasedOn() : String
  {
    return this.Attributes[EntityXMLBase.BASEDON_ATTR]
  }
  
  property get Type() : String
  {
    return this.Attributes[EntityXMLBase.TYPE_ATTR]
  }
  
  property get Branch() : String
  {
    return this.Attributes[EntityXMLBase.BRANCH_ATTR]
  }
  
  property get FixedID() : Integer
  {
    return Integer.parseInt(this.Attributes[EntityXMLBase.FIXEDID_ATTR])
  }
  
  property get EffectiveDate() : String
  {    
    return this.getAttributeValue(EntityXMLBase.EFFDATE_ATTR)
  }
  
  property get Deleted() : boolean
  {
    return Boolean.parseBoolean(this.Attributes[EntityXMLBase.DELETE_ATTR])
  }
  
  property get BranchIsForAuditReversal() : boolean
  {
    return Boolean.parseBoolean(this.Attributes[EntityXMLBase.ISFORAUDITREVERSAL_ATTR])
  }
  
  property get BranchIsForRewrite() : boolean
  {
    return Boolean.parseBoolean(this.Attributes[EntityXMLBase.ISFORREWRITE_ATTR])
  }
  // V10
  property get BranchIsForRenew() : boolean
  {
    return Boolean.parseBoolean(this.Attributes[EntityXMLBase.ISFORRENEW_ATTR])
  }
  
  function findChildEntity(entName : String, entPublicID : String) : XMLNode
  {
    return this.findFirst(\ nn -> nn.ElementName == entName 
                                  and nn.getAttributeValue(EntityXMLBase.PUBLIC_ATTR) == entPublicID)
  }  
}
