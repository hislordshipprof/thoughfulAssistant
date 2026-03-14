import Store from 'electron-store';
import { ConfigSchema, AppConfig } from './config-schema';
import { defaultConfig } from './default-config';

// Map left/right-specific VK codes to their generic equivalents.
// Raw Input reports generic codes (0x11=VK_CONTROL, 0x10=VK_SHIFT, 0x12=VK_MENU)
// but older configs may have stored left-specific codes (0xA2, 0xA0, 0xA4).
const VK_MIGRATION: Record<number, number> = {
  0xA0: 0x10, // VK_LSHIFT   → VK_SHIFT
  0xA1: 0x10, // VK_RSHIFT   → VK_SHIFT
  0xA2: 0x11, // VK_LCONTROL → VK_CONTROL
  0xA3: 0x11, // VK_RCONTROL → VK_CONTROL
  0xA4: 0x12, // VK_LMENU    → VK_MENU
  0xA5: 0x12, // VK_RMENU    → VK_MENU
};

export class ConfigStore {
  private store: Store<AppConfig>;

  constructor() {
    this.store = new Store<AppConfig>({
      name: 'interview-overlay-config',
      defaults: defaultConfig
    });
    this.migrateHotkeys();
    this.fillMissingHotkeys();
  }

  /** Backfill any hotkey entries added in newer versions but missing from saved config. */
  private fillMissingHotkeys(): void {
    const hotkeys = this.store.get('hotkeys') as Record<string, any>;
    const defaults = defaultConfig.hotkeys as Record<string, any>;
    let changed = false;

    for (const [name, binding] of Object.entries(defaults)) {
      if (!hotkeys[name]) {
        hotkeys[name] = binding;
        changed = true;
        console.log(`[config] Added missing hotkey: ${name}`);
      }
    }

    if (changed) {
      this.store.set('hotkeys', hotkeys as any);
    }
  }

  /** Fix stale left/right-specific VK codes in persisted hotkeys. */
  private migrateHotkeys(): void {
    const hotkeys = this.store.get('hotkeys');
    if (!hotkeys) return;

    let changed = false;
    for (const [name, binding] of Object.entries(hotkeys)) {
      const migrated = binding.vkCodes.map((vk: number) => {
        const generic = VK_MIGRATION[vk];
        if (generic !== undefined) {
          changed = true;
          return generic;
        }
        return vk;
      });
      if (changed) {
        (hotkeys as any)[name] = { ...binding, vkCodes: migrated };
      }
    }
    if (changed) {
      this.store.set('hotkeys', hotkeys);
      console.log('[config] Migrated hotkey VK codes to generic values');
    }
  }

  get<K extends keyof AppConfig>(key: K): AppConfig[K] {
    const raw = this.store.get(key);
    return raw;
  }

  set<K extends keyof AppConfig>(key: K, value: AppConfig[K]): void {
    // Validate the section being set
    const partial = { [key]: value };
    const fullConfig = { ...this.getAll(), ...partial };
    const result = ConfigSchema.safeParse(fullConfig);

    if (result.success) {
      this.store.set(key, value);
    } else {
      throw new Error(`Invalid config for ${key}: ${result.error.message}`);
    }
  }

  getAll(): AppConfig {
    return this.store.store;
  }

  setAll(config: Partial<AppConfig>): void {
    const merged = { ...this.getAll(), ...config };
    const result = ConfigSchema.safeParse(merged);

    if (result.success) {
      this.store.store = result.data;
    } else {
      throw new Error(`Invalid config: ${result.error.message}`);
    }
  }

  reset(): void {
    this.store.clear();
    this.store.store = defaultConfig;
  }

  onDidChange<K extends keyof AppConfig>(
    key: K,
    callback: (newValue: AppConfig[K] | undefined, oldValue: AppConfig[K] | undefined) => void
  ): () => void {
    return this.store.onDidChange(key, callback as any);
  }
}
