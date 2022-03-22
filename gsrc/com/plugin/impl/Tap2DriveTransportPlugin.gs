package com.plugin.impl

uses com.tap2drive.constants.Tap2DriveConstants
uses gw.api.system.PLLoggerCategory
uses gw.job.PolicyChangeProcess
uses gw.lob.common.Tap2DriveUtil
uses gw.plugin.messaging.MessageTransport
uses org.apache.http.util.EntityUtils
uses org.json.JSONObject
uses gw.transaction.Transaction
uses com.guidewire.pl.system.util.DateTimeUtil
uses java.math.BigDecimal


class Tap2DriveTransportPlugin implements MessageTransport {
  static var _logger = PLLoggerCategory.APPLICATION
  override function send(message : Message, payload : String) {
    try {
      var polDriver = message.MessageRoot typeis PolicyDriver ? message.MessageRoot as PolicyDriver : null
      if(message.EventName == Tap2DriveConstants.TAP2DRIVE_ENROLL_EVENT or message.EventName == Tap2DriveConstants.TAP2DRIVE_UNENROLL_EVENT) {
        _logger.info("Enroll: Begin Webservice call! ***Request***" + payload)
        var Tap2DriveResponse = Tap2DriveUtil.InvokeEnrollUnEnroll(payload)
        if(Tap2DriveResponse.StatusLine.StatusCode == 200 or Tap2DriveResponse.StatusLine.StatusCode == 201) {
      /*  Transaction.runWithNewBundle(\bundle -> {
          Tap2DriveUtil.performEnrollmentPolicyChange(message,polDriver, bundle)
        })*/
          message.reportAck()
        }
        else {
          throw new Exception (Tap2DriveUtil.handleErrorResponse(Tap2DriveResponse))
        }
        _logger.info("Success **** EnRoll UnEnRoll Webservice call!" )
      } else if (message.EventName == Tap2DriveConstants.TAP2DRIVE_SCORES_EVENT) {
        _logger.info("Fetch Records: Begin Webservice call!")
        var Tap2DriveResponse = Tap2DriveUtil.invokeFetchDriverScores(payload)
        if(Tap2DriveResponse.StatusLine.StatusCode == 200 or Tap2DriveResponse.StatusLine.StatusCode == 201) {
          var result = EntityUtils.toString (Tap2DriveResponse.getEntity ())
          var json = new JSONObject (result)
          var jsonResp = json.getJSONArray ("restScore").getJSONObject (0)
          Transaction.runWithNewBundle(\bundle -> {
            Tap2DriveUtil.addScoreToPolicyChange(polDriver,bundle,jsonResp)
          })
          //polDriver.Tap2DriveRecord. = jsonResp.get ("totalRidesOfMonth")
          message.reportAck()
          _logger.info("Success **** Fetch Records Webservice call!" + payload)
        } else {
          throw new Exception (Tap2DriveUtil.handleErrorResponse(Tap2DriveResponse))
        }
      }
    } catch (ex: Exception) {
      print(ex.StackTraceAsString)
      message.ErrorDescription = ex.Message
      message.reportError()
    }
  }

  override function shutdown() {

  }

  override function suspend() {

  }

  override function resume() {

  }

  override property set DestinationID(destinationID : int) {

  }
}