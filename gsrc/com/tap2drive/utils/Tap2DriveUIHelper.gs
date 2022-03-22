package com.tap2drive.utils

uses gw.api.database.Query
uses gw.api.database.Relop
uses gw.api.locale.DisplayKey
uses gw.api.util.DateUtil
uses gw.api.util.LocationUtil

uses java.math.BigDecimal

class Tap2DriveUIHelper {
  public static function handleDriverEnrollment (policyDriver : PolicyDriver , policyPeriod : PolicyPeriod,isEnrolled : Boolean ) {
    if(isEnrolled) {
      enrollDriver (policyDriver,policyPeriod)
    } else {
      unEnrollDriver(policyDriver, policyPeriod)
    }
  }

  public static function enrollDriver (policyDriver : PolicyDriver , policyPeriod : PolicyPeriod ) {
    //Call the integration layer to enroll driver for Tap2Drive application
    var UniqueDriverID = generateUniqueDriverID (policyDriver)
    /*  var priorRecord = getPriorDriverRecord(UniqueDriverID)
  if(null != priorRecord) {
     // policyDriver.Tap2DriveRecord = priorRecord
      policyDriver.Tap2DriveRecord.Tap2DriveStatus = Tap2DriveStatus.TC_PREENROLLED
    }
    else {*/
    policyDriver.Tap2DriveRecord_Ext.Tap2DriveStatus = Tap2DriveStatus_Ext.TC_REQUESTFORENROLLMENT
    policyDriver.Tap2DriveRecord_Ext.UniqueDriverID = UniqueDriverID
    policyDriver.Tap2DriveRecord_Ext.EnrolledDate = DateUtil.currentDate()
  }

  public static function getPriorDriverRecord (UniqueDriverID:String) :Tap2DriveRecord_Ext {
    return Query.make(Tap2DriveRecord_Ext).compare(Tap2DriveRecord_Ext#UniqueDriverID,
        Relop.Equals,UniqueDriverID).select().FirstResult
  }

  public static function generateUniqueDriverID (policyDriver : PolicyDriver) :String {
    var driverDetails = policyDriver.FirstName + policyDriver.LastName + policyDriver.LicenseState + policyDriver.LicenseNumber
    var uniqueID = UUID.nameUUIDFromBytes(driverDetails.Bytes)
    return uniqueID.toString()
  }

  public static function unEnrollDriver (policyDriver : PolicyDriver , policyPeriod : PolicyPeriod ) {
    //Call the integration layer to unenroll driver for Tap2Drive application
    policyDriver.Tap2DriveRecord_Ext.Tap2DriveStatus = Tap2DriveStatus_Ext.TC_UNENROLLED
    policyDriver.Tap2DriveRecord_Ext.UnEnrolledDate = DateUtil.currentDate()
  }

  public static function getTap2DriveRecords (policyDriver : PolicyDriver , policyPeriod : PolicyPeriod ) {
    //Call the integration layer to fetch records for Tap2Drive application
    var tap2DriveRecord = new Tap2DriveRecord_Ext(policyPeriod,policyPeriod.EditEffectiveDate
        ,policyPeriod.EndOfCoverageDate)
    tap2DriveRecord.Tap2DriveStatus = Tap2DriveStatus_Ext.TC_REPORTRECEIVED
    tap2DriveRecord.RouteScore = new BigDecimal("74")
    tap2DriveRecord.CallingPoint = new BigDecimal("74")
    tap2DriveRecord.AccelerationPoint = new BigDecimal("83")
    tap2DriveRecord.SpeedingPoint = new BigDecimal("65")
    tap2DriveRecord.BrakingPoint = new BigDecimal("85")
    policyDriver.Tap2DriveRecord_Ext = tap2DriveRecord
  }

  public static function getAssociatedRecord ( policyDriver : PolicyDriver ) : Tap2DriveRecord_Ext {
    return policyDriver.Tap2DriveRecord_Ext
  }
  public static function validateEmailID( policyDriver : PolicyDriver ) {

  }

}