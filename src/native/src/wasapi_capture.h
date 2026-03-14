#pragma once
#include <napi.h>
#include <windows.h>
#include <mmdeviceapi.h>
#include <audioclient.h>
#include <thread>
#include <atomic>

namespace WasapiCapture {
  Napi::Value StartCapture(const Napi::CallbackInfo& info);
  Napi::Value StopCapture(const Napi::CallbackInfo& info);
  Napi::Value IsCapturing(const Napi::CallbackInfo& info);
  Napi::Value GetCaptureDevices(const Napi::CallbackInfo& info);
}
