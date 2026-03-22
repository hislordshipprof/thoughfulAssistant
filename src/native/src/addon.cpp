#include <napi.h>
#include "window_stealth.h"
#include "raw_input.h"
#include "wasapi_capture.h"
#include "utils.h"
#include "screenshot.h"

Napi::Object Init(Napi::Env env, Napi::Object exports) {
  // Window Stealth
  exports.Set("applyStealthMode", Napi::Function::New(env, WindowStealth::ApplyStealthMode));
  exports.Set("removeStealthMode", Napi::Function::New(env, WindowStealth::RemoveStealthMode));
  exports.Set("setClickThrough", Napi::Function::New(env, WindowStealth::SetClickThrough));
  exports.Set("reapplyDisplayAffinity", Napi::Function::New(env, WindowStealth::ReapplyDisplayAffinity));
  exports.Set("applyToolWindowStyle", Napi::Function::New(env, WindowStealth::ApplyToolWindowStyle));
  exports.Set("subclassForNoActivate", Napi::Function::New(env, WindowStealth::SubclassForNoActivate));

  // Raw Input
  exports.Set("startRawInputListener", Napi::Function::New(env, RawInput::StartRawInputListener));
  exports.Set("stopRawInputListener", Napi::Function::New(env, RawInput::StopRawInputListener));
  exports.Set("isListening", Napi::Function::New(env, RawInput::IsListening));
  exports.Set("registerGlobalHotkeys", Napi::Function::New(env, RawInput::RegisterGlobalHotkeys));
  exports.Set("unregisterGlobalHotkeys", Napi::Function::New(env, RawInput::UnregisterGlobalHotkeys));
  exports.Set("setTypingCallback", Napi::Function::New(env, RawInput::SetTypingCallback));
  exports.Set("setTypingMode", Napi::Function::New(env, RawInput::SetTypingMode));

  // WASAPI Capture
  exports.Set("startCapture", Napi::Function::New(env, WasapiCapture::StartCapture));
  exports.Set("stopCapture", Napi::Function::New(env, WasapiCapture::StopCapture));
  exports.Set("isCapturing", Napi::Function::New(env, WasapiCapture::IsCapturing));
  exports.Set("getCaptureDevices", Napi::Function::New(env, WasapiCapture::GetCaptureDevices));

  // Utils
  exports.Set("getWindowHandle", Napi::Function::New(env, Utils::GetWindowHandle));

  // Screenshot (native BitBlt — much faster than Electron's desktopCapturer)
  exports.Set("captureScreenNative", Napi::Function::New(env, Screenshot::CaptureScreen));

  return exports;
}

NODE_API_MODULE(native_addon, Init)
