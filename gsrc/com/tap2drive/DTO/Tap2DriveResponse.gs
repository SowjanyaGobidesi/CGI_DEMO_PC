package com.tap2drive.DTO

class Tap2DriveResponse {
  var _error : String as Error
  var _successmessage : String as SuccessMessage
  construct(error:String , successMessage:String) {
    Error = error
    SuccessMessage = successMessage
  }
}