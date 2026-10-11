{
  "targets": [
    {
      "target_name": "native_addon",
      "cflags!": ["-fno-exceptions"],
      "cflags_cc!": ["-fno-exceptions"],
      "sources": [
        "src/native/src/addon.cpp",
        "src/native/src/window_stealth.cpp",
        "src/native/src/raw_input.cpp",
        "src/native/src/wasapi_capture.cpp",
        "src/native/src/utils.cpp",
        "src/native/src/screenshot.cpp"
      ],
      "include_dirs": [
        "<!@(node -p \"require('node-addon-api').include\")"
      ],
      "defines": ["NAPI_DISABLE_CPP_EXCEPTIONS", "UNICODE", "_UNICODE"],
      "conditions": [
        [
          "OS=='win'",
          {
            "libraries": [
              "-lole32",
              "-loleaut32",
              "-lmmdevapi",
              "-lavrt",
              "-luser32",
              "-luuid",
              "-lksuser",
              "-lgdiplus",
              "-lgdi32"
            ],
            "msvs_settings": {
              "VCCLCompilerTool": {
                "ExceptionHandling": 1,
                "AdditionalOptions": ["/std:c++17"]
              }
            }
          }
        ]
      ]
    }
  ]
}
