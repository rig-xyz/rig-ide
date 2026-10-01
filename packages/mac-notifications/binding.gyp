{
  "targets": [
    {
      "target_name": "mac_notifications",
      "conditions": [
        ["OS=='mac'", {
          "sources": ["src/mac_notifications.mm"],
          "include_dirs": ["<!@(node -p \"require('node-addon-api').include\")"],
          "defines": ["NAPI_DISABLE_CPP_EXCEPTIONS", "NAPI_VERSION=8"],
          "xcode_settings": {
            "OTHER_CPLUSPLUSFLAGS": ["-std=c++17", "-fobjc-arc"],
            "MACOSX_DEPLOYMENT_TARGET": "11.0"
          },
          "link_settings": { "libraries": ["-framework UserNotifications", "-framework Foundation"] }
        }, {
          "sources": ["src/stub.cc"],
          "include_dirs": ["<!@(node -p \"require('node-addon-api').include\")"],
          "defines": ["NAPI_DISABLE_CPP_EXCEPTIONS", "NAPI_VERSION=8"]
        }]
      ]
    }
  ]
}
