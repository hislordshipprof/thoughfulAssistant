#include "utils.h"

namespace Utils {

struct FindWindowData {
  std::string targetTitle;
  HWND result;
};

static BOOL CALLBACK EnumWindowsProc(HWND hwnd, LPARAM lParam) {
  auto* data = reinterpret_cast<FindWindowData*>(lParam);
  wchar_t title[256];
  GetWindowTextW(hwnd, title, 256);
  std::string windowTitle = WideToUtf8(title);
  if (windowTitle.find(data->targetTitle) != std::string::npos) {
    data->result = hwnd;
    return FALSE;
  }
  return TRUE;
}

HWND FindElectronWindow(const std::string& title) {
  FindWindowData data;
  data.targetTitle = title;
  data.result = nullptr;
  EnumWindows(EnumWindowsProc, reinterpret_cast<LPARAM>(&data));
  return data.result;
}

HWND GetHwndFromBuffer(Napi::Buffer<uint8_t>& buffer) {
  if (buffer.Length() < sizeof(HWND)) return nullptr;
  HWND hwnd;
  memcpy(&hwnd, buffer.Data(), sizeof(HWND));
  return hwnd;
}

Napi::Value GetWindowHandle(const Napi::CallbackInfo& info) {
  Napi::Env env = info.Env();

  if (info.Length() < 1 || !info[0].IsString()) {
    Napi::TypeError::New(env, "Expected window title string").ThrowAsJavaScriptException();
    return env.Null();
  }

  std::string title = info[0].As<Napi::String>().Utf8Value();
  HWND hwnd = FindElectronWindow(title);

  if (!hwnd) {
    return env.Null();
  }

  auto buffer = Napi::Buffer<uint8_t>::New(env, sizeof(HWND));
  memcpy(buffer.Data(), &hwnd, sizeof(HWND));
  return buffer;
}

std::string WideToUtf8(const std::wstring& wide) {
  if (wide.empty()) return "";
  int size = WideCharToMultiByte(CP_UTF8, 0, wide.c_str(), -1, nullptr, 0, nullptr, nullptr);
  std::string result(size - 1, 0);
  WideCharToMultiByte(CP_UTF8, 0, wide.c_str(), -1, &result[0], size, nullptr, nullptr);
  return result;
}

std::wstring Utf8ToWide(const std::string& utf8) {
  if (utf8.empty()) return L"";
  int size = MultiByteToWideChar(CP_UTF8, 0, utf8.c_str(), -1, nullptr, 0);
  std::wstring result(size - 1, 0);
  MultiByteToWideChar(CP_UTF8, 0, utf8.c_str(), -1, &result[0], size);
  return result;
}

} // namespace Utils
