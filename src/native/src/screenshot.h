#pragma once
#include <napi.h>

namespace Screenshot {
  // Captures the primary screen and returns a JPEG data URL (base64 encoded)
  // Returns: { dataUrl: string, width: number, height: number }
  Napi::Value CaptureScreen(const Napi::CallbackInfo& info);
}
