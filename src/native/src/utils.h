#pragma once
#include <napi.h>
#include <windows.h>
#include <string>

namespace Utils {
  HWND FindElectronWindow(const std::string& title);
  HWND GetHwndFromBuffer(Napi::Buffer<uint8_t>& buffer);
  Napi::Value GetWindowHandle(const Napi::CallbackInfo& info);
  std::string WideToUtf8(const std::wstring& wide);
  std::wstring Utf8ToWide(const std::string& utf8);
}
