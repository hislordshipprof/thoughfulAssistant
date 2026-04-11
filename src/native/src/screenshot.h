#pragma once
#include <napi.h>

namespace Screenshot {
  // Captures a screen as JPEG data URL (base64 encoded).
  // Optional arg[0]: Buffer containing HWND — captures the monitor that window is on.
  // If no HWND provided, captures the primary monitor.
  // Returns: { dataUrl: string, width: number, height: number, ... timing fields }
  Napi::Value CaptureScreen(const Napi::CallbackInfo& info);
}
