package com.tap2drive.rulehelper

uses com.tap2drive.constants.Tap2DriveConstants
uses gw.api.json.JsonConfigAccess
uses gw.lob.common.Tap2DriveUtil
uses jsonschema.taptodrive.pc.taptodriveenrollrequest.v1_0.Tap2DriveEnrollRequest
uses jsonschema.taptodrive.pc.taptodrivepolicydriverrequest.v1_0.Tap2DrivePolicyDriverRequest

class Tap2DriveRuleHelper {

  public static function isEnrolledUnenrolled(messageContext : MessageContext) : boolean {
    var polDriver = messageContext.Root typeis PolicyDriver ? messageContext.Root as PolicyDriver : null
    return polDriver != null and (messageContext.EventName == Tap2DriveConstants.TAP2DRIVE_ENROLL_EVENT or
        messageContext.EventName == Tap2DriveConstants.TAP2DRIVE_UNENROLL_EVENT)
  }

  public static function enroll(messageContext : MessageContext, actions : gw.rules.Action)  {
    var policyDriver = messageContext.Root typeis PolicyDriver ? messageContext.Root as PolicyDriver : null
    if(policyDriver != null) {
      try {
        var createJson = JsonConfigAccess.getMapper ("custom.taptodrive.pc.taptodriveenroll-1.0","Tap2DriveEnrollRequest")
        var reqObj = new Tap2DriveEnrollRequest ().parse (createJson.transformObject (policyDriver).toPrettyJsonString ())
        reqObj.email=((policyDriver as PolicyContactRole).AccountContactRole.AccountContact.Contact as Person).EmailAddress1
        reqObj.driverKey=policyDriver.Tap2DriveRecord_Ext.UniqueDriverID
        reqObj.password = "password"
        if(messageContext.EventName == Tap2DriveConstants.TAP2DRIVE_ENROLL_EVENT) {
          reqObj.status = "Active"
        }
        if(messageContext.EventName == Tap2DriveConstants.TAP2DRIVE_UNENROLL_EVENT) {
          reqObj.status = "Inactive"
        }
        //reqObj.policy.policyNumber = policyPeriod.PolicyNumber
        // var reqobj = Tap2DriveUtil.buildEnrollUnEnrollRequestObj (driver, policyPeriod)
        var payload = reqObj.unwrap ().toPrettyJsonString ()
        messageContext.createMessage(payload)
      }catch(ex : Exception) {
        policyDriver.Tap2DriveRecord_Ext.Tap2DriveStatus = Tap2DriveStatus_Ext.TC_PENDINGENROLLMENT
        ex.printStackTrace()
      }
    }
  }

  public static function fetchDriverScores(messageContext : MessageContext, actions : gw.rules.Action)  {
    var policyDriver = messageContext.Root typeis PolicyDriver ? messageContext.Root : null
    try {
      if ( policyDriver != null ) {
        //var reqobj = Tap2DriveUtil.buildDriversListRequestObj (policyDriver)
        //var createJson = JsonConfigAccess.getMapper ("custom.taptodrive.pc.taptodriveenroll-1.0", "Tap2DriveEnrollRequest")
        //var reqObj = new Tap2DriveEnrollRequest ().parse (createJson.transformObject (policyDriver).toPrettyJsonString ())
        //reqObj.policy.policyNumber = policyDriver.PersonalAutoLine.AssociatedPolicyPeriod.PolicyNumber
        var payload = "u3298478324-3dscsdc-893888,"+"21-10-06"+","+"21-09-10"
        //var payload = string
        messageContext.createMessage (payload)
      }
    } catch ( ex : Exception ) {
      ex.printStackTrace ()
    }
  }
}