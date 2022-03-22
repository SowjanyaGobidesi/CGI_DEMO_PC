package com.tap2drive.utils

uses gw.job.PolicyChangeProcess
uses gw.transaction.Transaction
uses gw.plugin.Plugins
uses gw.plugin.policy.IPolicyPlugin
uses jsonschema.taptodrive.pc.taptodriverequest.v1_0.Tap2DrivePolicyRequest
uses jsonschema.taptodrive.pc.taptodriveresponse.v1_0.Tap2DriveResponse
uses com.guidewire.pl.system.util.DateTimeUtil

class Tap2DriveAPIHelper {

  public static function updateEnrollmentStatus(body : Tap2DrivePolicyRequest) : Tap2DriveResponse {
    var statusType = Tap2DriveStatus_Ext.get(body.status)
    if (body.policyNumber == null) {
      throw new Exception("Please provide valid Policy Number")
    }
    if (statusType == null) {
      throw new Exception("Invalid Status is provided")
    }
    var policy = Policy.finder.findPolicyByPolicyNumber(body.policyNumber)
    if (policy == null) {
      throw new Exception("Could not find policy with PolicyNumber " + body.policyNumber)
    }
    var tap2drive = policy.LatestPeriod.PersonalAutoLine.PolicyDrivers
        .firstWhere(\driver -> driver.Tap2DriveRecord_Ext.UniqueDriverID == body.driverId)
    if (tap2drive == null) {
      throw new Exception("No Tap2Drive Record found for DriverID provided")
    }
    var effectiveDate = DateTimeUtil.setHourMinuteSecondFromDate(Date.Today, policy.LatestPeriod.PeriodStart)
    var error = Plugins.get(IPolicyPlugin).canStartPolicyChange(policy, effectiveDate)
    if (error != null) {
      throw new Exception("Cannot start policy change")
    }
    try {
      Transaction.runWithNewBundle(\bundle -> {
        var policyChange = new PolicyChange()
        policyChange.startJob(policy, effectiveDate)
        var policyPeriod = policyChange.SelectedVersion.getSlice(policyChange.SelectedVersion.EditEffectiveDate)
        var tap2driveRecord = policyPeriod.PersonalAutoLine.PolicyDrivers
            .firstWhere(\driver -> driver.Tap2DriveRecord_Ext.UniqueDriverID == body.driverId)
        if (null != tap2driveRecord) {
          tap2driveRecord.Tap2DriveRecord_Ext.Tap2DriveStatus = statusType
        }
        var policyChangeProcess = policyPeriod.JobProcess as PolicyChangeProcess
        var jobConditions = policyChangeProcess.canRequestQuote()
        if (not jobConditions.Okay) {
          throw new Exception(jobConditions.Message)
        }
        policyChangeProcess.requestQuote()
        jobConditions = policyChangeProcess.canBind()
        if (not jobConditions.Okay) {
          throw new Exception(jobConditions.Message)
        }
        policyChangeProcess.issueJob(true)
      })
    } catch (ex : Exception) {
      ex.printStackTrace()
      return new Tap2DriveResponse() {:failureMessage = "Failure"}
    }
    return new Tap2DriveResponse() {:successMessage = "Record Updated Successfully"}
  }

}