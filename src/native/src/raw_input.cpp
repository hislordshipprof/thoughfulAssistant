#include "raw_input.h"
#include <vector>
#include <set>

namespace RawInput {

static std::atomic<bool> g_listening{false};
static std::thread g_thread;
static HWND g_messageWindow = nullptr;
static Napi::ThreadSafeFunction g_tsfn;

// Global hotkey support
static Napi::ThreadSafeFunction g_hotkeyTsfn;
static std::mutex g_hotkeyMutex;

struct KeyEvent {
  USHORT vkCode;
  USHORT scanCode;
  bool isKeyDown;
  bool isE0;
};

struct GlobalHotkeyBinding {
  int id;
  UINT modifiers;
  UINT vk;
  std::string name;
};

static std::vector<GlobalHotkeyBinding> g_hotkeys;
static bool g_hotkeyTsfnActive = false;

// --- WH_KEYBOARD_LL hook (replaces RegisterHotKey) ---
static HHOOK g_llKeyboardHook = nullptr;
static bool g_llCtrlDown = false;
static bool g_llShiftDown = false;
static bool g_llAltDown = false;
static std::set<DWORD> g_swallowedVks; // track swallowed keydowns to also swallow their keyups

// --- Typing mode support ---
// When active, non-modifier keystrokes (without Ctrl/Alt) are intercepted,
// translated to Unicode via ToUnicodeEx, and forwarded to JS via TSFN.
static std::atomic<bool> g_typingModeActive{false};
static Napi::ThreadSafeFunction g_typingTsfn;
static bool g_typingTsfnActive = false;

struct TypingEvent {
  enum Type { CHAR, COMMAND, MODE } type;
  wchar_t character;       // for CHAR type
  std::string command;     // for COMMAND type ("backspace", "enter")
  bool modeActive;         // for MODE type
};

static void TypingTsfnCallback(Napi::Env env, Napi::Function callback, TypingEvent* evt) {
  auto obj = Napi::Object::New(env);
  switch (evt->type) {
    case TypingEvent::CHAR: {
      obj.Set("type", Napi::String::New(env, "char"));
      char utf8[8] = {};
      WideCharToMultiByte(CP_UTF8, 0, &evt->character, 1, utf8, sizeof(utf8), nullptr, nullptr);
      obj.Set("char", Napi::String::New(env, utf8));
      break;
    }
    case TypingEvent::COMMAND:
      obj.Set("type", Napi::String::New(env, "command"));
      obj.Set("command", Napi::String::New(env, evt->command));
      break;
    case TypingEvent::MODE:
      obj.Set("type", Napi::String::New(env, "mode"));
      obj.Set("active", Napi::Boolean::New(env, evt->modeActive));
      break;
  }
  callback.Call({obj});
  delete evt;
}

// Custom messages for cross-thread hotkey management
#define WM_REGISTER_HOTKEYS   (WM_USER + 1)
#define WM_UNREGISTER_HOTKEYS (WM_USER + 2)

static bool IsModifierKey(DWORD vk) {
  return vk == VK_LCONTROL || vk == VK_RCONTROL || vk == VK_CONTROL ||
         vk == VK_LSHIFT   || vk == VK_RSHIFT   || vk == VK_SHIFT   ||
         vk == VK_LMENU    || vk == VK_RMENU    || vk == VK_MENU;
}

static bool IsShiftKey(DWORD vk) {
  return vk == VK_LSHIFT || vk == VK_RSHIFT || vk == VK_SHIFT;
}

// Low-level keyboard hook callback.
// Runs on the message-loop thread. Must return quickly.
// Returning 1 without CallNextHookEx swallows the key — no app ever sees it.
static LRESULT CALLBACK LowLevelKeyboardProc(int nCode, WPARAM wParam, LPARAM lParam) {
  if (nCode != HC_ACTION) {
    return CallNextHookEx(g_llKeyboardHook, nCode, wParam, lParam);
  }

  KBDLLHOOKSTRUCT* kb = reinterpret_cast<KBDLLHOOKSTRUCT*>(lParam);
  DWORD vk = kb->vkCode;
  bool isDown = (wParam == WM_KEYDOWN || wParam == WM_SYSKEYDOWN);
  bool isUp   = (wParam == WM_KEYUP   || wParam == WM_SYSKEYUP);

  // Always update modifier state first (even if we swallow the key later,
  // the internal tracking must stay accurate for hotkey matching)
  switch (vk) {
    case VK_LCONTROL: case VK_RCONTROL: case VK_CONTROL:
      g_llCtrlDown = isDown;
      break;
    case VK_LSHIFT: case VK_RSHIFT: case VK_SHIFT:
      g_llShiftDown = isDown;
      break;
    case VK_LMENU: case VK_RMENU: case VK_MENU:
      g_llAltDown = isDown;
      break;
  }

  // --- Swallow Shift when Ctrl is already held (hides Ctrl+Shift+X combos) ---
  if (isDown && IsShiftKey(vk) && g_llCtrlDown) {
    g_swallowedVks.insert(vk);
    return 1;
  }

  // --- Keydown of a non-modifier key ---
  if (isDown && !IsModifierKey(vk)) {
    // If already swallowed (auto-repeat), keep swallowing silently
    if (g_swallowedVks.count(vk)) {
      return 1;
    }

    // Build current modifier bitmask
    UINT currentMods = 0;
    if (g_llCtrlDown)  currentMods |= MOD_CONTROL;
    if (g_llShiftDown) currentMods |= MOD_SHIFT;
    if (g_llAltDown)   currentMods |= MOD_ALT;

    // Check against registered hotkeys
    std::lock_guard<std::mutex> lock(g_hotkeyMutex);
    for (const auto& hk : g_hotkeys) {
      if (hk.vk == vk && hk.modifiers == currentMods) {
        // Match! Fire the hotkey callback to JS
        if (g_hotkeyTsfnActive) {
          auto* name = new std::string(hk.name);
          g_hotkeyTsfn.NonBlockingCall(name, [](Napi::Env env, Napi::Function callback, std::string* n) {
            callback.Call({Napi::String::New(env, *n)});
            delete n;
          });
        }

        // Remember this key so we swallow its keyup too
        g_swallowedVks.insert(vk);

        // Swallow — browser / other apps never see this key
        return 1;
      }
    }

    // --- Typing mode: capture keystrokes for overlay textarea ---
    // Runs AFTER hotkey check so hotkeys (Ctrl+Shift+W, etc.) still work.
    if (g_typingModeActive) {
      // If Ctrl or Alt held and no hotkey matched, pass through
      // so system shortcuts (Ctrl+C, Alt+Tab, etc.) still work
      if (g_llCtrlDown || g_llAltDown) {
        return CallNextHookEx(g_llKeyboardHook, nCode, wParam, lParam);
      }

      // Escape exits typing mode
      if (vk == VK_ESCAPE) {
        g_typingModeActive = false;
        if (g_typingTsfnActive) {
          auto* evt = new TypingEvent{TypingEvent::MODE, 0, "", false};
          g_typingTsfn.NonBlockingCall(evt, TypingTsfnCallback);
        }
        g_swallowedVks.insert(vk);
        return 1;
      }

      // Backspace
      if (vk == VK_BACK) {
        if (g_typingTsfnActive) {
          auto* evt = new TypingEvent{TypingEvent::COMMAND, 0, "backspace", true};
          g_typingTsfn.NonBlockingCall(evt, TypingTsfnCallback);
        }
        g_swallowedVks.insert(vk);
        return 1;
      }

      // Enter / Return
      if (vk == VK_RETURN) {
        if (g_typingTsfnActive) {
          auto* evt = new TypingEvent{TypingEvent::COMMAND, 0, "enter", true};
          g_typingTsfn.NonBlockingCall(evt, TypingTsfnCallback);
        }
        g_swallowedVks.insert(vk);
        return 1;
      }

      // Translate to Unicode character
      BYTE kbState[256] = {};
      if (g_llShiftDown) kbState[VK_SHIFT] = 0x80;
      if (GetKeyState(VK_CAPITAL) & 0x01) kbState[VK_CAPITAL] = 0x01;

      wchar_t buf[4] = {};
      HKL layout = GetKeyboardLayout(0);
      int result = ToUnicodeEx(vk, kb->scanCode, kbState, buf, 4, 0, layout);

      if (result == -1) {
        // Dead key — call again to clear the dead key state
        ToUnicodeEx(vk, kb->scanCode, kbState, buf, 4, 0, layout);
      } else if (result >= 1) {
        // Got a printable character
        if (g_typingTsfnActive) {
          auto* evt = new TypingEvent{TypingEvent::CHAR, buf[0], "", true};
          g_typingTsfn.NonBlockingCall(evt, TypingTsfnCallback);
        }
      }

      // Swallow all non-modifier keys in typing mode
      g_swallowedVks.insert(vk);
      return 1;
    }
  }

  // --- Keyup of a previously swallowed key ---
  if (isUp && g_swallowedVks.count(vk)) {
    g_swallowedVks.erase(vk);
    return 1; // swallow the keyup too
  }

  // Everything else passes through normally
  return CallNextHookEx(g_llKeyboardHook, nCode, wParam, lParam);
}

// -------------------------------------------------------
// Window procedure for the hidden message-only window
// -------------------------------------------------------
static LRESULT CALLBACK RawInputWndProc(HWND hwnd, UINT msg, WPARAM wParam, LPARAM lParam) {
  if (msg == WM_INPUT) {
    UINT dataSize = 0;
    GetRawInputData(reinterpret_cast<HRAWINPUT>(lParam), RID_INPUT, nullptr, &dataSize, sizeof(RAWINPUTHEADER));

    if (dataSize == 0) return 0;

    std::vector<BYTE> rawData(dataSize);
    if (GetRawInputData(reinterpret_cast<HRAWINPUT>(lParam), RID_INPUT, rawData.data(), &dataSize, sizeof(RAWINPUTHEADER)) != dataSize) {
      return 0;
    }

    RAWINPUT* raw = reinterpret_cast<RAWINPUT*>(rawData.data());
    if (raw->header.dwType == RIM_TYPEKEYBOARD) {
      auto* keyEvent = new KeyEvent{
        raw->data.keyboard.VKey,
        raw->data.keyboard.MakeCode,
        (raw->data.keyboard.Flags & RI_KEY_BREAK) == 0,
        (raw->data.keyboard.Flags & RI_KEY_E0) != 0
      };

      g_tsfn.NonBlockingCall(keyEvent, [](Napi::Env env, Napi::Function callback, KeyEvent* event) {
        auto obj = Napi::Object::New(env);
        obj.Set("vkCode", Napi::Number::New(env, event->vkCode));
        obj.Set("scanCode", Napi::Number::New(env, event->scanCode));
        obj.Set("isKeyDown", Napi::Boolean::New(env, event->isKeyDown));
        obj.Set("isE0", Napi::Boolean::New(env, event->isE0));
        callback.Call({obj});
        delete event;
      });
    }
    return 0;
  }

  // --- Install the low-level keyboard hook ---
  if (msg == WM_REGISTER_HOTKEYS) {
    // Remove previous hook if any
    if (g_llKeyboardHook) {
      UnhookWindowsHookEx(g_llKeyboardHook);
      g_llKeyboardHook = nullptr;
    }
    g_swallowedVks.clear();

    g_llKeyboardHook = SetWindowsHookExW(
      WH_KEYBOARD_LL,
      LowLevelKeyboardProc,
      GetModuleHandleW(nullptr),
      0   // 0 = system-wide hook
    );

    if (g_llKeyboardHook) {
      std::lock_guard<std::mutex> lock(g_hotkeyMutex);
      printf("[raw_input] WH_KEYBOARD_LL hook installed, monitoring %zu hotkeys\n", g_hotkeys.size());
      for (const auto& hk : g_hotkeys) {
        printf("[raw_input]   id=%d mod=0x%x vk=0x%x name=%s\n", hk.id, hk.modifiers, hk.vk, hk.name.c_str());
      }
    } else {
      printf("[raw_input] WH_KEYBOARD_LL hook FAILED err=%lu\n", GetLastError());
    }
    return 0;
  }

  // --- Remove the low-level keyboard hook ---
  if (msg == WM_UNREGISTER_HOTKEYS) {
    if (g_llKeyboardHook) {
      UnhookWindowsHookEx(g_llKeyboardHook);
      g_llKeyboardHook = nullptr;
    }
    g_swallowedVks.clear();
    g_llCtrlDown = false;
    g_llShiftDown = false;
    g_llAltDown = false;
    std::lock_guard<std::mutex> lock(g_hotkeyMutex);
    g_hotkeys.clear();
    return 0;
  }

  if (msg == WM_CLOSE || msg == WM_DESTROY) {
    // Unhook LL keyboard hook
    if (g_llKeyboardHook) {
      UnhookWindowsHookEx(g_llKeyboardHook);
      g_llKeyboardHook = nullptr;
    }
    g_swallowedVks.clear();
    {
      std::lock_guard<std::mutex> lock(g_hotkeyMutex);
      g_hotkeys.clear();
    }
    PostQuitMessage(0);
    return 0;
  }

  return DefWindowProcW(hwnd, msg, wParam, lParam);
}

void RawInputThreadProc(Napi::ThreadSafeFunction tsfn) {
  // Register a hidden message-only window class
  WNDCLASSEXW wc = {};
  wc.cbSize = sizeof(WNDCLASSEXW);
  wc.lpfnWndProc = RawInputWndProc;
  wc.hInstance = GetModuleHandleW(nullptr);
  wc.lpszClassName = L"RawInputHiddenClass";
  RegisterClassExW(&wc);

  // Create message-only window (invisible, not discoverable)
  g_messageWindow = CreateWindowExW(
    0,
    L"RawInputHiddenClass",
    L"",
    0,
    0, 0, 0, 0,
    HWND_MESSAGE, // message-only window
    nullptr,
    GetModuleHandleW(nullptr),
    nullptr
  );

  if (!g_messageWindow) {
    g_listening = false;
    tsfn.Release();
    return;
  }

  // Register for raw keyboard input with RIDEV_INPUTSINK (receive even when not focused)
  RAWINPUTDEVICE rid = {};
  rid.usUsagePage = 0x01; // Generic Desktop
  rid.usUsage = 0x06;     // Keyboard
  rid.dwFlags = RIDEV_INPUTSINK;
  rid.hwndTarget = g_messageWindow;

  if (!RegisterRawInputDevices(&rid, 1, sizeof(rid))) {
    DestroyWindow(g_messageWindow);
    g_messageWindow = nullptr;
    g_listening = false;
    tsfn.Release();
    return;
  }

  g_listening = true;

  // Message pump
  MSG msg;
  while (g_listening && GetMessageW(&msg, nullptr, 0, 0)) {
    TranslateMessage(&msg);
    DispatchMessageW(&msg);
  }

  // Cleanup
  if (g_llKeyboardHook) {
    UnhookWindowsHookEx(g_llKeyboardHook);
    g_llKeyboardHook = nullptr;
  }
  if (g_messageWindow) {
    DestroyWindow(g_messageWindow);
    g_messageWindow = nullptr;
  }
  UnregisterClassW(L"RawInputHiddenClass", GetModuleHandleW(nullptr));
  tsfn.Release();
}

Napi::Value StartRawInputListener(const Napi::CallbackInfo& info) {
  Napi::Env env = info.Env();

  if (g_listening) {
    return Napi::Boolean::New(env, true); // Already running
  }

  if (info.Length() < 1 || !info[0].IsFunction()) {
    Napi::TypeError::New(env, "Expected callback function").ThrowAsJavaScriptException();
    return Napi::Boolean::New(env, false);
  }

  auto callback = info[0].As<Napi::Function>();

  g_tsfn = Napi::ThreadSafeFunction::New(
    env,
    callback,
    "RawInputCallback",
    0,    // unlimited queue
    1     // one thread
  );

  g_thread = std::thread(RawInputThreadProc, g_tsfn);
  g_thread.detach();

  return Napi::Boolean::New(env, true);
}

Napi::Value StopRawInputListener(const Napi::CallbackInfo& info) {
  Napi::Env env = info.Env();

  if (!g_listening) {
    return Napi::Boolean::New(env, true);
  }

  g_listening = false;

  // Post quit message to break the message loop
  if (g_messageWindow) {
    PostMessageW(g_messageWindow, WM_CLOSE, 0, 0);
  }

  // Release hotkey TSFN if active
  if (g_hotkeyTsfnActive) {
    g_hotkeyTsfn.Release();
    g_hotkeyTsfnActive = false;
  }

  // Release typing TSFN if active
  if (g_typingTsfnActive) {
    g_typingTsfn.Release();
    g_typingTsfnActive = false;
  }
  g_typingModeActive = false;

  return Napi::Boolean::New(env, true);
}

Napi::Value IsListening(const Napi::CallbackInfo& info) {
  return Napi::Boolean::New(info.Env(), g_listening.load());
}

// RegisterGlobalHotkeys(callback, hotkeys[])
// hotkeys: [{ id: number, modifiers: number, vk: number, name: string }, ...]
Napi::Value RegisterGlobalHotkeys(const Napi::CallbackInfo& info) {
  Napi::Env env = info.Env();

  if (!g_listening || !g_messageWindow) {
    Napi::Error::New(env, "Raw input listener not started — call startRawInputListener first").ThrowAsJavaScriptException();
    return Napi::Boolean::New(env, false);
  }

  if (info.Length() < 2 || !info[0].IsFunction() || !info[1].IsArray()) {
    Napi::TypeError::New(env, "Expected (callback, hotkeys[])").ThrowAsJavaScriptException();
    return Napi::Boolean::New(env, false);
  }

  // Unregister any existing hotkeys first
  if (g_hotkeyTsfnActive) {
    PostMessageW(g_messageWindow, WM_UNREGISTER_HOTKEYS, 0, 0);
    g_hotkeyTsfn.Release();
    g_hotkeyTsfnActive = false;
  }

  auto callback = info[0].As<Napi::Function>();
  auto arr = info[1].As<Napi::Array>();

  // Build hotkey list
  {
    std::lock_guard<std::mutex> lock(g_hotkeyMutex);
    g_hotkeys.clear();

    for (uint32_t i = 0; i < arr.Length(); i++) {
      auto item = arr.Get(i).As<Napi::Object>();
      GlobalHotkeyBinding hk;
      hk.id = item.Get("id").As<Napi::Number>().Int32Value();
      hk.modifiers = item.Get("modifiers").As<Napi::Number>().Uint32Value();
      hk.vk = item.Get("vk").As<Napi::Number>().Uint32Value();
      hk.name = item.Get("name").As<Napi::String>().Utf8Value();
      g_hotkeys.push_back(hk);
    }
  }

  // Create TSFN for hotkey callbacks
  g_hotkeyTsfn = Napi::ThreadSafeFunction::New(
    env,
    callback,
    "GlobalHotkeyCallback",
    0,
    1
  );
  g_hotkeyTsfnActive = true;

  // Tell the message loop thread to install the LL keyboard hook
  PostMessageW(g_messageWindow, WM_REGISTER_HOTKEYS, 0, 0);

  return Napi::Boolean::New(env, true);
}

Napi::Value UnregisterGlobalHotkeys(const Napi::CallbackInfo& info) {
  Napi::Env env = info.Env();

  if (g_messageWindow) {
    PostMessageW(g_messageWindow, WM_UNREGISTER_HOTKEYS, 0, 0);
  }

  if (g_hotkeyTsfnActive) {
    g_hotkeyTsfn.Release();
    g_hotkeyTsfnActive = false;
  }

  return Napi::Boolean::New(env, true);
}

// SetTypingCallback(callback) — register a JS callback for typing events
Napi::Value SetTypingCallback(const Napi::CallbackInfo& info) {
  Napi::Env env = info.Env();

  if (g_typingTsfnActive) {
    g_typingTsfn.Release();
    g_typingTsfnActive = false;
  }

  if (info.Length() < 1 || !info[0].IsFunction()) {
    Napi::TypeError::New(env, "Expected callback function").ThrowAsJavaScriptException();
    return Napi::Boolean::New(env, false);
  }

  g_typingTsfn = Napi::ThreadSafeFunction::New(
    env,
    info[0].As<Napi::Function>(),
    "TypingCallback",
    0,
    1
  );
  g_typingTsfnActive = true;

  return Napi::Boolean::New(env, true);
}

// SetTypingMode(active: boolean) — toggle typing mode on/off
Napi::Value SetTypingMode(const Napi::CallbackInfo& info) {
  Napi::Env env = info.Env();

  if (info.Length() < 1 || !info[0].IsBoolean()) {
    Napi::TypeError::New(env, "Expected boolean").ThrowAsJavaScriptException();
    return Napi::Boolean::New(env, false);
  }

  g_typingModeActive = info[0].As<Napi::Boolean>().Value();
  return Napi::Boolean::New(env, g_typingModeActive.load());
}

} // namespace RawInput
