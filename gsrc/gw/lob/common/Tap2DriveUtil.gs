package gw.lob.common

uses com.common.ServiceCallUtil
uses com.tap2drive.constants.Tap2DriveConstants
uses gw.api.system.PLLoggerCategory
uses gw.api.util.DateUtil
uses gw.job.PolicyChangeProcess
uses gw.pl.persistence.core.Bundle
uses org.apache.http.client.methods.CloseableHttpResponse
uses org.apache.http.client.methods.HttpGet
uses org.apache.http.entity.StringEntity
uses org.apache.http.impl.client.BasicResponseHandler
uses org.apache.http.impl.client.CloseableHttpClient
uses org.apache.http.impl.client.HttpClientBuilder
uses org.apache.http.util.EntityUtils
uses org.json.JSONObject
uses gw.transaction.Transaction
uses com.guidewire.pl.system.util.DateTimeUtil

uses java.math.BigDecimal
uses java.math.RoundingMode


class Tap2DriveUtil {
   static var _logger = PLLoggerCategory.APPLICATION
  private final var strArr = {"content-type, application/x-www-form-urlencoded;charset=UTF-8",
      "Accept,application/x-www-form-urlencoded","Authorization","Basic"}

  public static function invokeTap2Drive_allRideAPI(): ArrayList<String>{
    _logger.info("Begin Webservice call!")
    var httpClient = ServiceCallUtil.createClient()// HttpClientBuilder.create().build();
    var resultResponse =  new ArrayList<String> ()
    try {
      //Step1: Get Authentication token. Currently Tap2Drive API are built with the context of mobile app. Hence we are passing the username and password of the user to get the info.
      var responsehandler = new BasicResponseHandler();
      var respString = invokeTap2Drive_Authentication(httpClient)
      var myObject = new JSONObject(respString)
      //Step2: Using the Authenitcation token, get the profile info, we are especially interested in the unique userID
      var userIdRequest:HttpGet =new HttpGet("https://safe-driver-qa.cgi.com/safedriver-auth-api/user")
      userIdRequest.addHeader("Authorization","Bearer "+myObject.get("access_token"))
      var userIdResponse = httpClient.execute(userIdRequest,responsehandler)
      print(userIdResponse);
      resultResponse.add(userIdResponse)
      //Step3: Using the unique userID from step 2, invoke All RIDE api info
      var userIdResponseObj = new JSONObject(userIdResponse);
      var allRidesRequest = new HttpGet("https://safe-driver-qa.cgi.com/safedriver-route-api/allrides?userid="+userIdResponseObj.get("userid"))
      allRidesRequest.addHeader("Authorization","Bearer "+myObject.get("access_token"));
      var allRidesResponse=httpClient.execute(allRidesRequest,responsehandler);
      print(allRidesResponse);
      resultResponse.add(allRidesResponse)
      return resultResponse
    } catch (ex: Exception) {
      print(ex.StackTraceAsString)
    } finally {
      _logger.info("End Webservice call!")
      httpClient.close();
    }
    return null;
  }
  public static function handleErrorResponse(response : CloseableHttpResponse): String {
    return EntityUtils.toString (response.getEntity ())
  }
  /**
   * Function to Invoke Authrntication to Tap2Drive
   * @param httpClient
   * @param responsehandler
   * @return Access Token
   */
  public static function invokeTap2Drive_Authentication(httpClient : CloseableHttpClient): String {
    try {
      //Get Authentication token. Currently Tap2Drive API are built with the context of mobile app. Hence we are passing the username and password of the user to get the info.
      var urlparameter = "grant_type=password&username=abdul.razak.shaik@cgi.com&password=admin123"
      var params = new StringEntity(urlparameter,"UTF-8")
      var queryParam = "/safedriver-auth-api/oauth/token"
      var authentication = "Basic "+Base64.getEncoder().encodeToString(("ios-client:ios-secret").getBytes())
      var req = ServiceCallUtil.buildHttpPostAuthRequest (Tap2DriveConstants.TAP2DRIVE, queryParam, params, authentication)
      var resp = httpClient.execute(req)
      if(resp.StatusLine.StatusCode == 200 or resp.StatusLine.StatusCode == 201) {
        return EntityUtils.toString (resp.getEntity ())
      } else {
        var errorResp = handleErrorResponse(resp)
        throw new Exception (errorResp)
      }
    }catch (ex : Exception) {
      ex.printStackTrace()
      throw ex
    }
  }
  /**
   * Function to Invoke Enroll/UnEnroll to Tap2Drive
   * @param payload
   * @return
   */
  public static function InvokeEnrollUnEnroll(payload: String): CloseableHttpResponse {
    try {
      //Step1: Get Authentication token. Currently Tap2Drive API are built with the context of mobile app. Hence we are passing the username and password of the user to get the info.
      var httpClient = ServiceCallUtil.createClient ()
      var respString = invokeTap2Drive_Authentication (httpClient)
      var myObject = new JSONObject(respString)
      var authentication = "Bearer "+ myObject.get ("access_token") //eyJhbGciOiJSUzI1NiIsInR5cCI6IkpXVCJ9.eyJhdWQiOlsic2FmZWRyaXZlci1yb3V0ZS1hcGkiLCJzYWZlZHJpdmVyLWF1dGgtYXBpIiwic2FmZWRyaXZlci10cmFjZS1hcGkiLCJzYWZlZHJpdmVyLWJhZGdlLWFwaSIsInRhcDJkcml2ZS1sb2ctYXBpIl0sInVzZXJfbmFtZSI6ImFiZHVsLnJhemFrLnNoYWlrQGNnaS5jb20iLCJzY29wZSI6WyJyZWFkIiwid3JpdGUiLCJvcGVuaWQiXSwibG9naW5OYW1lIjoiYWJkdWwucmF6YWsuc2hhaWtAY2dpLmNvbSIsIm5hbWUiOiJBYmR1bCBSYXphayIsImV4cCI6MTYzNDcyNjkwOSwidXNlcmlkIjoiMGFlMmMyYzctMTA3ZC00MjFmLTllMzQtYmU3NDg2NmYyYTI0IiwiYXV0aG9yaXRpZXMiOlsiUk9MRV9BRE1JTiJdLCJqdGkiOiJhMDU1MmVlNS1hYWMwLTQyNGEtOGVlOS0yNmVhZjM0MDhiNjMiLCJjbGllbnRfaWQiOiJpb3MtY2xpZW50In0.Rd3AnLKaSFtMeg2B4vRnEiuXR01haAaxOcQfYiQVP4ttyvo3f9wOm4h9D_IcrMjPXlZI7i8ItYlR6Bq7z0mGsVE8mrkMrRvy8YSpV97wwDNrT-YGeIbjbnKK8EDwny7vrjczZP5Bw_hT3VqZGOQNR1Zi1hLs9PVVXHaoROeavyH-NxLvJvxAlIf5v_nS6LQoddk4GsEiQudTGE4VdIhNLw6ABzst8UhxAmEakvk4xl4H8AhtymnygU8rGzMfx6ceinfq-yq_tGZ0NV7V-ClQtp0odOxSS6N7RoAfHHlay1dU8hiMeIyTnDMLvVddXeU-ZxwIuFipaBwkxq7MCehT3A"
      var queryParam = "/safedriver-auth-api/enroll/guidewire"
      var params:StringEntity = new StringEntity(payload,"UTF-8")
      var req = ServiceCallUtil.buildHttpPostRequest(Tap2DriveConstants.TAP2DRIVE, queryParam, params,authentication)
      return httpClient.execute(req)
    } catch (ex: Exception) {
      print (ex.StackTraceAsString)
      throw ex
    }
  }
  /**
   * Function to Fetch Tap2Drive Records
   * @param payload
   * @return
   */
  public static function invokeFetchDriverScores(payload : String) : CloseableHttpResponse{
    try {
      var httpClient = ServiceCallUtil.createClient ()
      var respString = invokeTap2Drive_Authentication (httpClient)
      var myObject = new JSONObject(respString)
      var strArr = payload.split (",")
      var authentication = "Bearer "+ myObject.get ("access_token")
      var queryParam = "/safedriver-route-api/gwtotalscore/"+strArr[0]+"?startDate="+strArr[1]+"&endDate="+strArr[2]
      var req = ServiceCallUtil.buildHttpGetRequest(Tap2DriveConstants.TAP2DRIVE, queryParam, authentication )
      return httpClient.execute(req)
    } catch (ex: Exception) {
      print(ex.StackTraceAsString)
      throw ex
    }
  }

  public static function removeTap2DriveRecords( policyPeriod : PolicyPeriod ) {
    for (policyDriver in policyPeriod.PersonalAutoLine.PolicyDrivers) {
      if (policyDriver.Tap2DriveRecord_Ext != null) {
        policyDriver.Tap2DriveRecord_Ext.remove()
      }
    }
  }

  public static function performEnrollmentPolicyChange(message : Message,polDriver:PolicyDriver,bundle:Bundle) {
    var policy = Policy.finder.findPolicyByPolicyNumber(polDriver.PersonalAutoLine.AssociatedPolicyPeriod.PolicyNumber)
    var effectiveDate = DateTimeUtil.setHourMinuteSecondFromDate(Date.Today, policy.LatestPeriod.PeriodStart)
    var policyChange = new PolicyChange()
    bundle.add(policyChange)
    policyChange.startJob(policy, effectiveDate)
    var policyPeriod = policyChange.SelectedVersion.getSlice(policyChange.SelectedVersion.EditEffectiveDate)
    var policyChangeProcess = policyPeriod.JobProcess as PolicyChangeProcess
    //get the driver matching the original driver and update it
    var driver  = policyPeriod.PersonalAutoLine.PolicyDrivers.firstWhere(\driver -> driver.PublicID ==
        polDriver.PublicID)
    if(message.EventName == Tap2DriveConstants.TAP2DRIVE_ENROLL_EVENT) {
      driver.Tap2DriveRecord_Ext.Tap2DriveStatus = Tap2DriveStatus_Ext.TC_ENROLLED
    }else {
      driver.Tap2DriveRecord_Ext.Tap2DriveStatus = Tap2DriveStatus_Ext.TC_UNENROLLED
    }
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
  }
  public static function addScoreToPolicyChange(polDriver:PolicyDriver,bundle:Bundle,jsonResp:JSONObject) {
    var policy = Policy.finder.findPolicyByPolicyNumber(polDriver.PersonalAutoLine.AssociatedPolicyPeriod.PolicyNumber)
    var effectiveDate = DateTimeUtil.setHourMinuteSecondFromDate(Date.Today, policy.LatestPeriod.PeriodStart)
    var policyChange = new PolicyChange()
    bundle.add(policyChange)
    policyChange.startJob(policy, effectiveDate)
    var policyPeriod = policyChange.SelectedVersion.getSlice(policyChange.SelectedVersion.EditEffectiveDate)
    var policyChangeProcess = policyPeriod.JobProcess as PolicyChangeProcess
    //get the driver matching the original driver and update it
    var driver  = policyPeriod.PersonalAutoLine.PolicyDrivers.firstWhere(\driver -> driver.PublicID ==
        polDriver.PublicID)
    driver.Tap2DriveRecord_Ext.AccelerationPoint = new BigDecimal(jsonResp.get ("accelerationStars").toString ())
    driver.Tap2DriveRecord_Ext.BrakingPoint = new BigDecimal(jsonResp.get ("brakingStars").toString ())
    driver.Tap2DriveRecord_Ext.RouteScore = new BigDecimal(jsonResp.get ("routeScore").toString ())
    driver.Tap2DriveRecord_Ext.CallingPoint = new BigDecimal(jsonResp.get ("notCallingPercentage").toString ())
    //polDriver.Tap2DriveRecord. = jsonResp.get ("totalRidesOfMonth")

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
  }
  public static function createAddScorePayload(driverID:String,enrolledDate:Date,endDate:Date) :String {
    var DATE_FORMAT ="yy-MM-dd"
    var returnString  = driverID + "," + enrolledDate.format(DATE_FORMAT)
        + "," + endDate.format(DATE_FORMAT)
    _logger.info("--Request of updateDriverScore--" + returnString)
    return returnString
    //return "u3298478324-3dscsdc-893898787jsxcx8" + ",21-10-06,21-11-04"
  }
  public static function updateDriverScore(policyPeriod:PolicyPeriod,
                                           driver : PolicyDriver ,
                                           Tap2DriveResponse : CloseableHttpResponse) {
    _logger.info("--Begin updateDriverScore--")
    if(Tap2DriveResponse.StatusLine.StatusCode == 200 or Tap2DriveResponse.StatusLine.StatusCode == 201) {
      var result = EntityUtils.toString(Tap2DriveResponse.getEntity())
      _logger.info(result)
      var json = new JSONObject(result)
      var jsonResp = json.getJSONArray("restScore").getJSONObject(0)
      Transaction.runWithNewBundle( \bundle -> {
        bundle.add(driver)
        var tap2DriveRecord = new Tap2DriveRecord_Ext(policyPeriod, policyPeriod.EditEffectiveDate
            , policyPeriod.EndOfCoverageDate)
        bundle.add(tap2DriveRecord)
        tap2DriveRecord.AccelerationPoint = new BigDecimal(jsonResp.get("accelerationStars").toString()).setScale(2, RoundingMode.HALF_UP)
        tap2DriveRecord.BrakingPoint = new BigDecimal(jsonResp.get("brakingStars").toString()).setScale(2, RoundingMode.HALF_UP)
        tap2DriveRecord.RouteScore = new BigDecimal(jsonResp.get("routeScore").toString()).setScale(2, RoundingMode.HALF_UP)
        tap2DriveRecord.CallingPoint = new BigDecimal(jsonResp.get("notCallingPercentage").toString()).setScale(2, RoundingMode.HALF_UP)
        tap2DriveRecord.SpeedingPoint = new BigDecimal(jsonResp.get("notSpeedingPercentage").toString()).setScale(2, RoundingMode.HALF_UP)
        driver.Tap2DriveRecord_Ext = tap2DriveRecord
      })
    } else {
      _logger.error(Tap2DriveUtil.handleErrorResponse(Tap2DriveResponse))
    }
    _logger.info("--End of updateDriverScore--")
  }

  public static function setRightPrecision(value : String) : String {
      return value.substring( 0,value.lastIndexOf(".")+ 3 )
  }
}