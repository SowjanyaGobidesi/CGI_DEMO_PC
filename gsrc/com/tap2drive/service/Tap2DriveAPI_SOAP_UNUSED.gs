package com.tap2drive.service

uses com.tap2drive.utils.Tap2DriveAPIException
uses com.tap2drive.utils.Tap2DriveAPIHelper
uses gw.xml.ws.annotation.WsiAvailability
uses gw.xml.ws.annotation.WsiGenInToolkit
uses gw.xml.ws.annotation.WsiWebService

@WsiWebService("http://guidewire.com/pc/ws/gw/webservice/pc/Tap2DriveAPI")
@WsiAvailability(MAINTENANCE)
@WsiGenInToolkit
@Export
class Tap2DriveAPI_SOAP_UNUSED {

  @Throws(Tap2DriveAPIException, "If cannot find entity with given identifier")
  @Param("accountNumber", "The account number of the account to check for active policies")
  @Returns("Message which indicates success or error message")
  public static function updateEnrollmentStatus(driverID:String,status:String) : String {
   // Tap2DriveAPIHelper.updateEnrollmentStatus(driverID, status)
    return "Success"
  }

}