#pragma once
#include <napi.h>
#include <windows.h>
#include <thread>
#include <atomic>
#include <mutex>
#include <vector>
#include <string>

namespace RawInput {
  Napi::Value StartRawInputListener(const Napi::CallbackInfo& info);
  Napi::Value StopRawInputListener(const Napi::CallbackInfo& info);
  Napi::Value IsListening(const Napi::CallbackInfo& info);
  Napi::Value RegisterGlobalHotkeys(const Napi::CallbackInfo& info);
  Napi::Value UnregisterGlobalHotkeys(const Napi::CallbackInfo& info);
  Napi::Value SetTypingCallback(const Napi::CallbackInfo& info);
  Napi::Value SetTypingMode(const Napi::CallbackInfo& info);

  // Internal
  void RawInputThreadProc(Napi::ThreadSafeFunction tsfn);
}
