#include "window_stealth.h"
#include "utils.h"
#include <dwmapi.h>

namespace WindowStealth {

// Subclass state for no-activate behavior
static WNDPROC g_originalWndProc = nullptr;

static LRESULT CALLBACK NoActivateWndProc(HWND hwnd, UINT msg, WPARAM wParam, LPARAM lParam) {
  // Prevent the window from being activated when clicked
  if (msg == WM_MOUSEACTIVATE) {
    return MA_NOACTIVATE;
  }

  // Block programmatic activation attempts (Chromium may call SetForegroundWindow internally)
  if (msg == WM_ACTIVATE) {
    WORD activateState = LOWORD(wParam);
    if (activateState != WA_INACTIVE) {
      // Reject activation — tell Windows we're going inactive
      return 0;
    }
  }

  return CallWindowProcW(g_originalWndProc, hwnd, msg, wParam, lParam);
}

static HWND ExtractHwnd(const Napi::CallbackInfo& info) {
  Napi::Env env = info.Env();
  if (info.Length() < 1) {
    Napi::TypeError::New(env, "Expected HWND buffer argument").ThrowAsJavaScriptException();
    return nullptr;
  }

  HWND hwnd = nullptr;

  // Accept Buffer (raw HWND pointer bytes)
  if (info[0].IsBuffer()) {
    auto buffer = info[0].As<Napi::Buffer<uint8_t>>();
    hwnd = Utils::GetHwndFromBuffer(buffer);
  }
  // Accept Number (HWND as number — from Electron getNativeWindowHandle)
  else if (info[0].IsNumber()) {
    hwnd = reinterpret_cast<HWND>(static_cast<uintptr_t>(info[0].As<Napi::Number>().Int64Value()));
  }
  else {
    Napi::TypeError::New(env, "Expected Buffer or Number for HWND").ThrowAsJavaScriptException();
    return nullptr;
  }

  // Validate that the HWND refers to an existing window
  if (hwnd && !IsWindow(hwnd)) {
    Napi::Error::New(env, "Invalid or destroyed HWND").ThrowAsJavaScriptException();
    return nullptr;
  }

  return hwnd;
}

Napi::Value ApplyStealthMode(const Napi::CallbackInfo& info) {
  Napi::Env env = info.Env();
  HWND hwnd = ExtractHwnd(info);
  if (!hwnd) return Napi::Boolean::New(env, false);

  // Set WDA_EXCLUDEFROMCAPTURE — hides window from all screen capture
  BOOL result = SetWindowDisplayAffinity(hwnd, WDA_EXCLUDEFROMCAPTURE);

  if (!result) {
    // Fallback to WDA_MONITOR (older Windows 10)
    result = SetWindowDisplayAffinity(hwnd, 0x00000001); // WDA_MONITOR
  }

  // Apply WS_EX_TOOLWINDOW | WS_EX_NOACTIVATE to hide from taskbar and Alt+Tab
  LONG_PTR exStyle = GetWindowLongPtrW(hwnd, GWL_EXSTYLE);
  exStyle |= WS_EX_TOOLWINDOW;
  exStyle |= WS_EX_NOACTIVATE;
  exStyle &= ~WS_EX_APPWINDOW; // Remove app window style
  SetWindowLongPtrW(hwnd, GWL_EXSTYLE, exStyle);

  return Napi::Boolean::New(env, result != 0);
}

Napi::Value RemoveStealthMode(const Napi::CallbackInfo& info) {
  Napi::Env env = info.Env();
  HWND hwnd = ExtractHwnd(info);
  if (!hwnd) return Napi::Boolean::New(env, false);

  BOOL result = SetWindowDisplayAffinity(hwnd, 0); // WDA_NONE

  LONG_PTR exStyle = GetWindowLongPtrW(hwnd, GWL_EXSTYLE);
  exStyle &= ~WS_EX_TOOLWINDOW;
  exStyle &= ~WS_EX_NOACTIVATE;
  SetWindowLongPtrW(hwnd, GWL_EXSTYLE, exStyle);

  return Napi::Boolean::New(env, result != 0);
}

Napi::Value SetClickThrough(const Napi::CallbackInfo& info) {
  Napi::Env env = info.Env();
  HWND hwnd = ExtractHwnd(info);
  if (!hwnd) return Napi::Boolean::New(env, false);

  bool enable = true;
  if (info.Length() >= 2 && info[1].IsBoolean()) {
    enable = info[1].As<Napi::Boolean>().Value();
  }

  LONG_PTR exStyle = GetWindowLongPtrW(hwnd, GWL_EXSTYLE);
  if (enable) {
    exStyle |= WS_EX_TRANSPARENT;
    exStyle |= WS_EX_LAYERED;
  } else {
    exStyle &= ~WS_EX_TRANSPARENT;
  }
  SetWindowLongPtrW(hwnd, GWL_EXSTYLE, exStyle);

  return Napi::Boolean::New(env, true);
}

Napi::Value ReapplyDisplayAffinity(const Napi::CallbackInfo& info) {
  Napi::Env env = info.Env();
  HWND hwnd = ExtractHwnd(info);
  if (!hwnd) return Napi::Boolean::New(env, false);

  // Workaround: Clear and re-set to fix Electron hide/show bug
  SetWindowDisplayAffinity(hwnd, 0);
  Sleep(50);
  BOOL result = SetWindowDisplayAffinity(hwnd, WDA_EXCLUDEFROMCAPTURE);

  if (!result) {
    result = SetWindowDisplayAffinity(hwnd, 0x00000001);
  }

  return Napi::Boolean::New(env, result != 0);
}

Napi::Value ApplyToolWindowStyle(const Napi::CallbackInfo& info) {
  Napi::Env env = info.Env();
  HWND hwnd = ExtractHwnd(info);
  if (!hwnd) return Napi::Boolean::New(env, false);

  LONG_PTR exStyle = GetWindowLongPtrW(hwnd, GWL_EXSTYLE);
  exStyle |= WS_EX_TOOLWINDOW;
  exStyle |= WS_EX_NOACTIVATE;
  exStyle &= ~WS_EX_APPWINDOW;
  SetWindowLongPtrW(hwnd, GWL_EXSTYLE, exStyle);

  return Napi::Boolean::New(env, true);
}

Napi::Value SubclassForNoActivate(const Napi::CallbackInfo& info) {
  Napi::Env env = info.Env();
  HWND hwnd = ExtractHwnd(info);
  if (!hwnd) return Napi::Boolean::New(env, false);

  // Already subclassed
  if (g_originalWndProc) return Napi::Boolean::New(env, true);

  g_originalWndProc = reinterpret_cast<WNDPROC>(
    SetWindowLongPtrW(hwnd, GWLP_WNDPROC, reinterpret_cast<LONG_PTR>(NoActivateWndProc))
  );

  if (g_originalWndProc) {
    printf("[stealth] Window subclassed for no-activate behavior\n");
  } else {
    printf("[stealth] Failed to subclass window, err=%lu\n", GetLastError());
  }

  return Napi::Boolean::New(env, g_originalWndProc != nullptr);
}

} // namespace WindowStealth
