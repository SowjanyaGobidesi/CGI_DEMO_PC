package com.common

uses com.tap2drive.Endpoint
uses gw.api.properties.PropertyLoader
uses org.apache.http.client.methods.HttpGet
uses org.apache.http.client.methods.HttpPost
uses org.apache.http.conn.ssl.NoopHostnameVerifier
uses org.apache.http.conn.ssl.SSLConnectionSocketFactory
uses org.apache.http.conn.ssl.TrustSelfSignedStrategy
uses org.apache.http.entity.StringEntity
uses org.apache.http.impl.client.CloseableHttpClient
uses org.apache.http.impl.client.HttpClients
uses org.apache.http.ssl.SSLContexts

uses javax.net.ssl.SSLContext

class ServiceCallUtil {

  /**
   * Funtion to return the endpoint for the ServiceName
   * @param serviceName
   * @return
   */
  private static function getEndpointUrl(serviceName : String) : String {
    var url = Endpoint.MyProperties.getProperty (serviceName)
    var urlName = Endpoint.get (serviceName)
    return url
  }

  /**
   * Function to return HTTP Post Rquest object
   * @param serviceName
   * @param queryParam
   * @param params
   * @param authentication
   * @return HTTP Post Rquest object
   */
  public static function buildHttpPostAuthRequest(serviceName : String, queryParam : String, params : StringEntity, authentication : String) : HttpPost {
    var url = getEndpointUrl(serviceName)
    var request:HttpPost = new HttpPost(url+queryParam)
    request.addHeader("content-type", "application/x-www-form-urlencoded;charset=UTF-8")
    request.addHeader("Accept","application/x-www-form-urlencoded")
    request.addHeader ("Authorization", authentication)
    request.setEntity(params)
    return request
  }

  /**
   * Function to return HTTP Post Rquest object
   * @param serviceName
   * @param queryParam
   * @param params
   * @param authentication
   * @return HTTP Post Rquest object
   */
  public static function buildHttpPostRequest(serviceName : String, queryParam : String, params : StringEntity, authentication : String) : HttpPost {
    var url = getEndpointUrl(serviceName)
    var request:HttpPost = new HttpPost(url+queryParam)
    request.addHeader("content-type", "application/json")
    request.addHeader("Authorization",authentication)
    request.setEntity (params)
    return request
  }

  /**
   * Function to return HTTP Get Rquest object
   * @param service
   * @param queryParam
   * @param authentication
   * @return HTTP Get Rquest object
   */
  public static function buildHttpGetRequest(serviceName : String, queryParam : String, authentication : String) : HttpGet {
    var url = getEndpointUrl(serviceName)
    var request:HttpGet = new HttpGet(url+queryParam)
    request.addHeader("content-type", "application/x-www-form-urlencoded;charset=UTF-8")
    request.addHeader("Accept","application/json")
    request.addHeader("Authorization", authentication)
    return request
  }

  public static function createClient() : CloseableHttpClient {
    var ssl  = SSLContexts.custom ().loadTrustMaterial (null, new TrustSelfSignedStrategy ()).build ()
    var client = HttpClients.custom ()
                .setSSLContext (ssl).setSSLSocketFactory (new SSLConnectionSocketFactory (ssl, NoopHostnameVerifier.INSTANCE))
                .build ()
    return client
  }

}