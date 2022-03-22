package com.tap2drive.DTO

class Tap2DriveRequest {
  var _policynumber : String as PolicyNumber
  var _driverid : String as DriverID
  var _status : String as Status
  construct(policyNumber:String , driverID:String , status:String) {
    PolicyNumber = policyNumber
    DriverID = driverID
    Status = status
  }
}