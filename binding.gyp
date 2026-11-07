{
  "targets": [
    {
      "target_name": "native_addon",
      "cflags!": ["-fno-exceptions"],
      "cflags_cc!": ["-fno-exceptions"],
      "include_dirs": [
        "<!@(node -p \"require('node-addon-api').include\")"
      ],
      "defines": ["NAPI_DISABLE_CPP_EXCEPTIONS"],
      "conditions": [
        [
          "OS=='win'",
          {
            "sources": [
              "src/native/src/addon.cpp",
              "src/native/src/window_stealth.cpp",
              "src/native/src/raw_input.cpp",
              "src/native/src/wasapi_capture.cpp",
              "src/native/src/utils.cpp"
            ],
            "defines": ["UNICODE", "_UNICODE"],
            "libraries": [
              "-lole32",
              "-loleaut32",
              "-lmmdevapi",
              "-lavrt",
              "-luser32",
              "-luuid",
              "-lksuser"
            ],
            "msvs_settings": {
              "VCCLCompilerTool": {
                "ExceptionHandling": 1,
                "AdditionalOptions": ["/std:c++17"]
              }
            }
          }
        ],
        [
          "OS=='mac' and '<!(echo $ENABLE_NATIVE_MAC)'=='1'",
          {
            "sources": [
              "src/native/src/mac/addon_mac.mm"
            ],
            "xcode_settings": {
              "CLANG_CXX_LANGUAGE_STANDARD": "c++17",
              "CLANG_CXX_LIBRARY": "libc++",
              "MACOSX_DEPLOYMENT_TARGET": "10.15",
              "GCC_ENABLE_CPP_EXCEPTIONS": "YES",
              "OTHER_CFLAGS": ["-ObjC++"]
            },
            "link_settings": {
              "libraries": [
                "$(SDKROOT)/System/Library/Frameworks/AppKit.framework",
                "$(SDKROOT)/System/Library/Frameworks/Carbon.framework",
                "$(SDKROOT)/System/Library/Frameworks/CoreFoundation.framework"
              ]
            }
          }
        ]
      ]
    }
  ]
}
