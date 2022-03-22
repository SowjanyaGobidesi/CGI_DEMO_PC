package com.tap2drive.service

uses com.tap2drive.utils.Tap2DriveAPIHelper
uses jsonschema.taptodrive.pc.taptodriverequest.v1_0.Tap2DrivePolicyRequest
uses jsonschema.taptodrive.pc.taptodriveresponse.v1_0.Tap2DriveResponse

class Tap2DriveAPIHandler {

  function updateEnrollmentStatus(tap2DriveRequest: Tap2DrivePolicyRequest) : Tap2DriveResponse {
   return  Tap2DriveAPIHelper.updateEnrollmentStatus(tap2DriveRequest)
  }
}