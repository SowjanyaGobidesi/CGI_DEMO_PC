package com.tap2drive.enhancement

uses com.tap2drive.utils.Tap2DriveUIHelper
uses gw.api.util.DateUtil

enhancement PolicyDriverEnhancement : PolicyDriver {

  function showUnEnrollmentConfirmationMessage() : boolean {
    return this.EnabledForTap2Drive_Ext == false
  }

  function setTap2DriveStatus() {
    if(this.EnabledForTap2Drive_Ext) {
      this.Tap2DriveRecord_Ext.Tap2DriveStatus = Tap2DriveStatus_Ext.TC_ENROLLED
      if(null == this.Tap2DriveRecord_Ext.UniqueDriverID) {
        this.Tap2DriveRecord_Ext.UniqueDriverID = Tap2DriveUIHelper.generateUniqueDriverID(this)
      }
      this.Tap2DriveRecord_Ext.EnrolledDate = this.Branch.EditEffectiveDate
    }
    if(this.Tap2DriveRecord_Ext.Tap2DriveStatus == Tap2DriveStatus_Ext.TC_ENROLLED
        and !this.EnabledForTap2Drive_Ext ) {
      this.Tap2DriveRecord_Ext.Tap2DriveStatus = Tap2DriveStatus_Ext.TC_UNENROLLED
    }
  }
}
