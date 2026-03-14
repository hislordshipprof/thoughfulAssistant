import { EventEmitter } from 'events';
import path from 'path';
import { HotkeyConfig } from '../services/config/config-schema';

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
    console.log('[hotkey] Registered bindings:', this.bindings.map(b => `${b.name}=[${b.vkCodes.map(v => '0x'+v.toString(16)).join(',')}]`).join(', '));

    // If already running, re-register global hotkeys
    if (this.isRunning) {
      this.setupGlobalHotkeys();
    }
  }

  start(): boolean {
    if (this.isRunning || !nativeAddon) {
      if (!nativeAddon) console.warn('Native addon unavailable — hotkeys disabled');
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
    if (!this.isRunning || !nativeAddon) return;

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
