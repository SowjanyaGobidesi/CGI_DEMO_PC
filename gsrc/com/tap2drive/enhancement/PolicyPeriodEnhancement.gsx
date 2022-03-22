package com.tap2drive.enhancement
uses gw.api.system.PLLoggerCategory
uses gw.lob.common.Tap2DriveUtil
uses org.apache.http.client.methods.CloseableHttpResponse
uses org.apache.http.util.EntityUtils
uses org.json.JSONObject
uses java.math.BigDecimal
uses java.math.RoundingMode

enhancement PolicyPeriodEnhancement : PolicyPeriod {

  public function updateDriverScore(driver : PolicyDriver ,
                                    Tap2DriveResponse : CloseableHttpResponse) {
    var _logger = PLLoggerCategory.APPLICATION
    _logger.info("--Begin updateDriverScore--")
    if(Tap2DriveResponse.StatusLine.StatusCode == 200 or Tap2DriveResponse.StatusLine.StatusCode == 201) {
      var result = EntityUtils.toString(Tap2DriveResponse.getEntity())
      _logger.info(result)
      var json = new JSONObject(result)
      var jsonResp = json.getJSONArray("restScore").getJSONObject(0)
        var tap2DriveRecord = new Tap2DriveRecord_Ext(this, this.EditEffectiveDate
            , this.EndOfCoverageDate)
        tap2DriveRecord.AccelerationPoint = new BigDecimal(jsonResp.get("accelerationStars").toString()).setScale(2, RoundingMode.HALF_UP)
        tap2DriveRecord.BrakingPoint = new BigDecimal(jsonResp.get("brakingStars").toString()).setScale(2, RoundingMode.HALF_UP)
        tap2DriveRecord.RouteScore = new BigDecimal(jsonResp.get("routeScore").toString()).setScale(2, RoundingMode.HALF_UP)
        tap2DriveRecord.CallingPoint = new BigDecimal(jsonResp.get("notCallingPercentage").toString()).setScale(2, RoundingMode.HALF_UP)
        tap2DriveRecord.SpeedingPoint = new BigDecimal(jsonResp.get("notSpeedingPercentage").toString()).setScale(2, RoundingMode.HALF_UP)
        driver.Tap2DriveRecord_Ext = tap2DriveRecord
    } else {
      _logger.error(Tap2DriveUtil.handleErrorResponse(Tap2DriveResponse))
    }
    _logger.info("--End of updateDriverScore--")
  }
}
