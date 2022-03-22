package com.tap2drive

uses gw.util.PropertiesFileAccess

class Endpoint {

  public static function get(key : String) : String {
    var prop = PropertiesFileAccess.getProperties("com/tap2drive/endpoints.properties")
    return prop.getProperty (key)
  }

  static property get MyProperties() : Properties {
    // Using getProperties reads the file only once. The Properties are cached as a static property.
    // You must use the fully qualified path to the properties file even though MyPropsAccess and
    // MyProps.properties are in the same folder.
    return PropertiesFileAccess.getProperties("com/tap2drive/endpoints.properties")
  }

}