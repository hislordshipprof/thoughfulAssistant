// macOS native addon — Cocoa-based stealth & window styling for Electron overlay.
//
// Functions exposed to JavaScript mirror the Windows addon so the TS layer
// can call them uniformly. Electron's cross-platform APIs cover the rest
// (setContentProtection, setAlwaysOnTop, setIgnoreMouseEvents, globalShortcut).
//
// The HWND buffer the Windows addon receives is, on macOS, the native handle
// that BrowserWindow.getNativeWindowHandle() returns — a buffer whose bytes
// encode an NSView* pointer. We extract the pointer and walk up to the owning
// NSWindow.

#import <AppKit/AppKit.h>
#import <Foundation/Foundation.h>
#include <napi.h>
#include <cstring>

namespace {

static NSWindow* WindowFromArg(const Napi::CallbackInfo& info) {
  if (info.Length() < 1) return nil;
  NSView* view = nil;

  if (info[0].IsBuffer()) {
    auto buf = info[0].As<Napi::Buffer<uint8_t>>();
    if (buf.Length() < sizeof(void*)) return nil;
    void* raw = nullptr;
    std::memcpy(&raw, buf.Data(), sizeof(void*));
    view = (__bridge NSView*)raw;
  } else if (info[0].IsNumber()) {
    uintptr_t raw = (uintptr_t)info[0].As<Napi::Number>().Int64Value();
    view = (__bridge NSView*)(void*)raw;
  }

  if (!view) return nil;
  if (![view isKindOfClass:[NSView class]]) return nil;
  return [view window];
}

// Hide the window from every screen-capture API that honours sharing type
// (ScreenCaptureKit, CGWindowListCreateImage, QuickTime screen recording, …).
// This mirrors WDA_EXCLUDEFROMCAPTURE on Windows.
Napi::Value ApplyStealthMode(const Napi::CallbackInfo& info) {
  Napi::Env env = info.Env();
  NSWindow* window = WindowFromArg(info);
  if (!window) return Napi::Boolean::New(env, false);

  dispatch_async(dispatch_get_main_queue(), ^{
    // NSWindowSharingNone = window content excluded from screen-capture APIs.
    [window setSharingType:NSWindowSharingNone];
    // Stay above every normal/full-screen window.
    [window setLevel:NSScreenSaverWindowLevel];
    // Appear on every Space, including full-screen apps. Don't participate
    // in Mission Control / Exposé / window cycling.
    NSWindowCollectionBehavior behavior =
        NSWindowCollectionBehaviorCanJoinAllSpaces |
        NSWindowCollectionBehaviorStationary |
        NSWindowCollectionBehaviorFullScreenAuxiliary |
        NSWindowCollectionBehaviorIgnoresCycle |
        NSWindowCollectionBehaviorTransient;
    [window setCollectionBehavior:behavior];
    // Hide from the window menu / Dock minimize list.
    [window setExcludedFromWindowsMenu:YES];
    [window setHidesOnDeactivate:NO];
  });

  return Napi::Boolean::New(env, true);
}

Napi::Value RemoveStealthMode(const Napi::CallbackInfo& info) {
  Napi::Env env = info.Env();
  NSWindow* window = WindowFromArg(info);
  if (!window) return Napi::Boolean::New(env, false);

  dispatch_async(dispatch_get_main_queue(), ^{
    [window setSharingType:NSWindowSharingReadOnly];
    [window setLevel:NSNormalWindowLevel];
    [window setCollectionBehavior:NSWindowCollectionBehaviorDefault];
    [window setExcludedFromWindowsMenu:NO];
  });

  return Napi::Boolean::New(env, true);
}

// Click-through handled by Electron setIgnoreMouseEvents — we expose a no-op
// so the TS layer's call pattern works everywhere.
Napi::Value SetClickThrough(const Napi::CallbackInfo& info) {
  return Napi::Boolean::New(info.Env(), true);
}

// Clear and re-apply sharing type — fixes rare cases where macOS forgets it
// after a space switch or display reconfiguration. Mirrors the Windows helper.
Napi::Value ReapplyDisplayAffinity(const Napi::CallbackInfo& info) {
  Napi::Env env = info.Env();
  NSWindow* window = WindowFromArg(info);
  if (!window) return Napi::Boolean::New(env, false);

  dispatch_async(dispatch_get_main_queue(), ^{
    [window setSharingType:NSWindowSharingReadOnly];
    [window setSharingType:NSWindowSharingNone];
  });

  return Napi::Boolean::New(env, true);
}

// On Windows this adds WS_EX_TOOLWINDOW | WS_EX_NOACTIVATE. The macOS
// equivalent is a non-activating panel-style window: we flip the style mask
// so clicks and keys don't steal focus from the frontmost app.
Napi::Value ApplyToolWindowStyle(const Napi::CallbackInfo& info) {
  Napi::Env env = info.Env();
  NSWindow* window = WindowFromArg(info);
  if (!window) return Napi::Boolean::New(env, false);

  dispatch_async(dispatch_get_main_queue(), ^{
    NSWindowStyleMask mask = [window styleMask];
    mask |= NSWindowStyleMaskNonactivatingPanel;
    [window setStyleMask:mask];
    [window setExcludedFromWindowsMenu:YES];
  });

  return Napi::Boolean::New(env, true);
}

// No-activate mirror. Same effect as ApplyToolWindowStyle on Mac — kept for
// API parity with the Windows addon's two separate entry points.
Napi::Value SubclassForNoActivate(const Napi::CallbackInfo& info) {
  return ApplyToolWindowStyle(info);
}

// ─── Hotkeys & raw input are handled in JS via Electron globalShortcut ───
// These exports are no-ops so the TS hotkey-manager's addon probe succeeds
// and the TS layer can fall back to the JS path cleanly.

Napi::Value StartRawInputListener(const Napi::CallbackInfo& info) {
  return Napi::Boolean::New(info.Env(), false);
}
Napi::Value StopRawInputListener(const Napi::CallbackInfo& info) {
  return Napi::Boolean::New(info.Env(), true);
}
Napi::Value IsListening(const Napi::CallbackInfo& info) {
  return Napi::Boolean::New(info.Env(), false);
}
Napi::Value RegisterGlobalHotkeys(const Napi::CallbackInfo& info) {
  return Napi::Boolean::New(info.Env(), false);
}
Napi::Value UnregisterGlobalHotkeys(const Napi::CallbackInfo& info) {
  return Napi::Boolean::New(info.Env(), true);
}
Napi::Value SetTypingCallback(const Napi::CallbackInfo& info) {
  return Napi::Boolean::New(info.Env(), false);
}
Napi::Value SetTypingMode(const Napi::CallbackInfo& info) {
  return Napi::Boolean::New(info.Env(), false);
}

// ─── WASAPI capture is Windows-only ───
Napi::Value StartCapture(const Napi::CallbackInfo& info) {
  return Napi::Boolean::New(info.Env(), false);
}
Napi::Value StopCapture(const Napi::CallbackInfo& info) {
  return Napi::Boolean::New(info.Env(), true);
}
Napi::Value IsCapturing(const Napi::CallbackInfo& info) {
  return Napi::Boolean::New(info.Env(), false);
}
Napi::Value GetCaptureDevices(const Napi::CallbackInfo& info) {
  return Napi::Array::New(info.Env());
}

// Window-handle-by-title lookup — not used on mac; main process finds the
// window via BrowserWindow directly.
Napi::Value GetWindowHandle(const Napi::CallbackInfo& info) {
  return info.Env().Null();
}

} // namespace

static Napi::Object Init(Napi::Env env, Napi::Object exports) {
  exports.Set("applyStealthMode",       Napi::Function::New(env, ApplyStealthMode));
  exports.Set("removeStealthMode",      Napi::Function::New(env, RemoveStealthMode));
  exports.Set("setClickThrough",        Napi::Function::New(env, SetClickThrough));
  exports.Set("reapplyDisplayAffinity", Napi::Function::New(env, ReapplyDisplayAffinity));
  exports.Set("applyToolWindowStyle",   Napi::Function::New(env, ApplyToolWindowStyle));
  exports.Set("subclassForNoActivate",  Napi::Function::New(env, SubclassForNoActivate));

  exports.Set("startRawInputListener",   Napi::Function::New(env, StartRawInputListener));
  exports.Set("stopRawInputListener",    Napi::Function::New(env, StopRawInputListener));
  exports.Set("isListening",             Napi::Function::New(env, IsListening));
  exports.Set("registerGlobalHotkeys",   Napi::Function::New(env, RegisterGlobalHotkeys));
  exports.Set("unregisterGlobalHotkeys", Napi::Function::New(env, UnregisterGlobalHotkeys));
  exports.Set("setTypingCallback",       Napi::Function::New(env, SetTypingCallback));
  exports.Set("setTypingMode",           Napi::Function::New(env, SetTypingMode));

  exports.Set("startCapture",      Napi::Function::New(env, StartCapture));
  exports.Set("stopCapture",       Napi::Function::New(env, StopCapture));
  exports.Set("isCapturing",       Napi::Function::New(env, IsCapturing));
  exports.Set("getCaptureDevices", Napi::Function::New(env, GetCaptureDevices));

  exports.Set("getWindowHandle", Napi::Function::New(env, GetWindowHandle));

  return exports;
}

NODE_API_MODULE(native_addon, Init)
