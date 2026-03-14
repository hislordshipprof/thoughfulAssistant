#pragma once
#include <napi.h>
#include <windows.h>

// WDA_EXCLUDEFROMCAPTURE = 0x00000011 (Windows 10 2004+)
#ifndef WDA_EXCLUDEFROMCAPTURE
#define WDA_EXCLUDEFROMCAPTURE 0x00000011
#endif

namespace WindowStealth {
  Napi::Value ApplyStealthMode(const Napi::CallbackInfo& info);
  Napi::Value RemoveStealthMode(const Napi::CallbackInfo& info);
  Napi::Value SetClickThrough(const Napi::CallbackInfo& info);
  Napi::Value ReapplyDisplayAffinity(const Napi::CallbackInfo& info);
  Napi::Value ApplyToolWindowStyle(const Napi::CallbackInfo& info);
  Napi::Value SubclassForNoActivate(const Napi::CallbackInfo& info);
}
