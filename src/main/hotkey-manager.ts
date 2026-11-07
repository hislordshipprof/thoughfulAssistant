import { EventEmitter } from 'events';
import path from 'path';
import { globalShortcut } from 'electron';
import { HotkeyConfig } from '../services/config/config-schema';

const IS_WIN = process.platform === 'win32';

let nativeAddon: any;
try {
  nativeAddon = require('../../build/Release/native_addon.node');
} catch {
  try {
    nativeAddon = require(path.join(process.resourcesPath, 'native', 'native_addon.node'));
  } catch {
    nativeAddon = null;
  }
}

// Win32 modifier flags (must match RegisterHotKey API)
const MOD_ALT = 0x0001;
const MOD_CONTROL = 0x0002;
const MOD_SHIFT = 0x0004;

// VK codes for modifier keys
const VK_SHIFT = 0x10;
const VK_CONTROL = 0x11;
const VK_ALT = 0x12;   // VK_MENU
const VK_LSHIFT = 0xA0;
const VK_RSHIFT = 0xA1;
const VK_LCONTROL = 0xA2;
const VK_RCONTROL = 0xA3;
const VK_LMENU = 0xA4;
const VK_RMENU = 0xA5;

const MODIFIER_VKS = new Set([
  VK_SHIFT, VK_CONTROL, VK_ALT,
  VK_LSHIFT, VK_RSHIFT,
  VK_LCONTROL, VK_RCONTROL,
  VK_LMENU, VK_RMENU,
]);

interface KeyState {
  [vkCode: number]: boolean;
}

interface HotkeyBinding {
  name: string;
  vkCodes: number[];
}

interface ParsedHotkey {
  modifiers: number;
  vk: number;
}

export class HotkeyManager extends EventEmitter {
  private bindings: HotkeyBinding[] = [];
  private bindingLabels: Map<string, string> = new Map();
  private rawOnlyBindings: HotkeyBinding[] = [];  // Standalone keys (no modifiers) — Raw Input
  private keyState: KeyState = {};
  private isRunning = false;
  private globalHotkeysRegistered = false;

  constructor() {
    super();
  }

  registerHotkeys(hotkeys: Record<string, HotkeyConfig>): void {
    this.bindings = Object.entries(hotkeys).map(([name, config]) => ({
      name,
      vkCodes: config.vkCodes
    }));
    this.bindingLabels = new Map(Object.entries(hotkeys).map(([name, cfg]) => [name, cfg.label]));
    console.log('[hotkey] Registered bindings:', this.bindings.map(b => `${b.name}=[${b.vkCodes.map(v => '0x'+v.toString(16)).join(',')}]`).join(', '));

    // If already running, re-register
    if (this.isRunning) {
      if (IS_WIN) {
        this.setupGlobalHotkeys();
      } else {
        this.setupElectronGlobalShortcuts();
      }
    }
  }

  start(): boolean {
    if (this.isRunning) return true;

    // macOS / Linux: skip the Win32 raw-input path and use Electron's
    // globalShortcut (native Cocoa event tap, no accessibility permission
    // required for registering — only for standalone keys like Escape,
    // which we fall back to a BrowserWindow 'before-input-event' for).
    if (!IS_WIN) {
      this.isRunning = true;
      this.setupElectronGlobalShortcuts();
      return true;
    }

    if (!nativeAddon) {
      console.warn('Native addon unavailable — hotkeys disabled');
      return false;
    }

    const started = nativeAddon.startRawInputListener((event: {
      vkCode: number;
      scanCode: number;
      isKeyDown: boolean;
      isE0: boolean;
    }) => {
      this.handleKeyEvent(event);
    });

    this.isRunning = started;

    if (started) {
      // Give the message loop a moment to initialize, then register global hotkeys
      setTimeout(() => this.setupGlobalHotkeys(), 200);
    }

    return started;
  }

  stop(): void {
    if (!this.isRunning) return;

    if (!IS_WIN) {
      globalShortcut.unregisterAll();
      this.isRunning = false;
      return;
    }

    if (!nativeAddon) return;

    // Unregister global hotkeys first
    if (this.globalHotkeysRegistered) {
      try {
        nativeAddon.unregisterGlobalHotkeys();
      } catch (e: any) {
        console.warn('[hotkey] Failed to unregister global hotkeys:', e.message);
      }
      this.globalHotkeysRegistered = false;
    }

    nativeAddon.stopRawInputListener();
    this.isRunning = false;
    this.keyState = {};
  }

  /**
   * macOS/Linux path: register each binding through Electron's globalShortcut.
   * Accelerator string is derived from the config label (Ctrl+Shift+H → CommandOrControl+Shift+H).
   */
  private setupElectronGlobalShortcuts(): void {
    globalShortcut.unregisterAll();

    for (const binding of this.bindings) {
      const label = this.bindingLabels.get(binding.name) || '';
      const accelerator = labelToAccelerator(label);
      if (!accelerator) {
        console.warn(`[hotkey] Skipping ${binding.name} — no translatable label (${label})`);
        continue;
      }

      try {
        const ok = globalShortcut.register(accelerator, () => {
          console.log(`[hotkey] Electron globalShortcut fired: ${binding.name} (${accelerator})`);
          this.emit('hotkey', binding.name);
        });
        if (!ok) {
          console.warn(`[hotkey] Failed to register ${accelerator} for ${binding.name} (already in use?)`);
        }
      } catch (e: any) {
        console.warn(`[hotkey] Error registering ${accelerator} for ${binding.name}:`, e.message);
      }
    }
  }

  private setupGlobalHotkeys(): void {
    if (!nativeAddon || !this.isRunning) return;

    // Separate bindings: modifier combos → RegisterHotKey, standalone keys → Raw Input
    const globalHotkeys: { id: number; modifiers: number; vk: number; name: string }[] = [];
    this.rawOnlyBindings = [];

    for (let i = 0; i < this.bindings.length; i++) {
      const binding = this.bindings[i];
      const parsed = this.parseModifiers(binding.vkCodes);

      if (parsed) {
        // Has modifiers — use RegisterHotKey (consumes the keystroke)
        globalHotkeys.push({
          id: i + 1, // hotkey IDs start at 1
          modifiers: parsed.modifiers,
          vk: parsed.vk,
          name: binding.name,
        });
      } else {
        // No modifiers (standalone key like Escape) — keep on Raw Input
        this.rawOnlyBindings.push(binding);
      }
    }

    if (globalHotkeys.length > 0) {
      try {
        nativeAddon.registerGlobalHotkeys(
          (actionName: string) => {
            console.log(`[hotkey] Global hotkey fired: ${actionName}`);
            this.emit('hotkey', actionName);
          },
          globalHotkeys
        );
        this.globalHotkeysRegistered = true;
        console.log(`[hotkey] Registered ${globalHotkeys.length} global hotkeys (consumed), ${this.rawOnlyBindings.length} raw-only bindings`);
      } catch (e: any) {
        console.error('[hotkey] Failed to register global hotkeys:', e.message);
        // Fall back to Raw Input for all bindings
        this.rawOnlyBindings = [...this.bindings];
      }
    } else {
      this.rawOnlyBindings = [...this.bindings];
    }
  }

  /**
   * Parse a vkCodes array into Win32 RegisterHotKey modifiers + main key.
   * Returns null if no modifier keys are present (standalone key).
   */
  private parseModifiers(vkCodes: number[]): ParsedHotkey | null {
    let modifiers = 0;
    let vk = 0;

    for (const code of vkCodes) {
      if (code === VK_CONTROL || code === VK_LCONTROL || code === VK_RCONTROL) {
        modifiers |= MOD_CONTROL;
      } else if (code === VK_SHIFT || code === VK_LSHIFT || code === VK_RSHIFT) {
        modifiers |= MOD_SHIFT;
      } else if (code === VK_ALT || code === VK_LMENU || code === VK_RMENU) {
        modifiers |= MOD_ALT;
      } else {
        vk = code; // The main (non-modifier) key
      }
    }

    if (modifiers === 0) return null; // No modifiers → use Raw Input
    if (vk === 0) return null; // Only modifiers, no main key → skip
    return { modifiers, vk };
  }

  private handleKeyEvent(event: { vkCode: number; isKeyDown: boolean }): void {
    this.keyState[event.vkCode] = event.isKeyDown;

    if (event.isKeyDown) {
      // Only check raw-only bindings (standalone keys without modifiers)
      this.checkRawBindings();
    }
  }

  private checkRawBindings(): void {
    for (const binding of this.rawOnlyBindings) {
      const allPressed = binding.vkCodes.every(vk => this.keyState[vk]);
      if (allPressed) {
        // Clear state to prevent repeat triggering
        for (const vk of binding.vkCodes) {
          this.keyState[vk] = false;
        }
        console.log(`[hotkey] Raw input hotkey fired: ${binding.name}`);
        this.emit('hotkey', binding.name);
      }
    }
  }

  updateBindings(hotkeys: Record<string, HotkeyConfig>): void {
    this.registerHotkeys(hotkeys);
  }

  isActive(): boolean {
    return this.isRunning;
  }
}

/**
 * Translate a human-readable hotkey label ("Ctrl+Shift+H", "Ctrl+Alt+Up",
 * "Escape") into an Electron accelerator. On macOS, Ctrl → Command so the
 * stored Windows-oriented defaults feel native (Cmd+Shift+H, etc.).
 */
function labelToAccelerator(label: string): string | null {
  if (!label) return null;
  const parts = label.split('+').map(p => p.trim()).filter(Boolean);
  if (parts.length === 0) return null;

  const out: string[] = [];
  for (const part of parts) {
    const lower = part.toLowerCase();
    switch (lower) {
      case 'ctrl':
      case 'control':
        out.push('CommandOrControl');
        break;
      case 'cmd':
      case 'command':
      case 'meta':
      case 'super':
      case 'win':
        out.push('Command');
        break;
      case 'shift':
        out.push('Shift');
        break;
      case 'alt':
      case 'option':
        out.push('Alt');
        break;
      case 'up':   out.push('Up'); break;
      case 'down': out.push('Down'); break;
      case 'left': out.push('Left'); break;
      case 'right': out.push('Right'); break;
      case 'esc':
      case 'escape':
        out.push('Escape');
        break;
      case 'space': out.push('Space'); break;
      case 'tab':   out.push('Tab'); break;
      case 'enter':
      case 'return':
        out.push('Return');
        break;
      case 'backspace': out.push('Backspace'); break;
      case 'delete':    out.push('Delete'); break;
      case 'home':      out.push('Home'); break;
      case 'end':       out.push('End'); break;
      case 'pageup':    out.push('PageUp'); break;
      case 'pagedown':  out.push('PageDown'); break;
      default:
        // Letters, digits, F-keys, punctuation — pass through as-is uppercased.
        out.push(part.length === 1 ? part.toUpperCase() : part);
    }
  }
  return out.join('+');
}

