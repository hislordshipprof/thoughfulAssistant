import Store from 'electron-store';
import { ConfigSchema, AppConfig } from './config-schema';
import { defaultConfig } from './default-config';
import { migrateControls } from '../../shared/controls';

export class ConfigStore {
  private store: Store<AppConfig>;

  constructor() {
    this.store = new Store<AppConfig>({
      name: 'interview-overlay-config',
      defaults: defaultConfig
    });
    this.fillMissingAiSettings();
    const audio = ConfigSchema.shape.audio.parse(this.store.get('audio'));
    if (process.platform === 'darwin' && !audio.macDefaultsApplied) {
      const hasKey = audio.transcriptionMode === 'deepgram' ? audio.deepgramKey || process.env.DEEPGRAM_API_KEY
        : audio.transcriptionMode === 'groq-whisper' ? audio.groqKey || process.env.GROQ_API_KEY
        : audio.transcriptionMode === 'google-stt' ? audio.googleSttKey || process.env.GOOGLE_STT_API_KEY
        : this.store.get('ai').openaiKey || process.env.OPENAI_API_KEY;
      if (!hasKey) audio.transcriptionMode = 'macos-speech';
      audio.macDefaultsApplied = true;
    }
    this.store.set('audio', audio);
    this.store.set('ocr', ConfigSchema.shape.ocr.parse(this.store.get('ocr')));
    const hotkeys = migrateControls(this.store.get('hotkeys'), process.platform, this.store.get('controlsVersion'));
    if (JSON.stringify(hotkeys) !== JSON.stringify(this.store.get('hotkeys'))) this.store.set('hotkeys', hotkeys);
    this.store.set('controlsVersion', 1);
    this.store.set('overlay', ConfigSchema.shape.overlay.parse(this.store.get('overlay')));
  }

  /** Backfill provider settings introduced after an existing config was saved. */
  private fillMissingAiSettings(): void {
    const ai = this.store.get('ai') as Record<string, any>;
    const defaults = defaultConfig.ai as Record<string, any>;
    let changed = false;

    for (const [key, value] of Object.entries(defaults)) {
      if (ai[key] === undefined) {
        ai[key] = value;
        changed = true;
      }
    }

    if (changed) {
      this.store.set('ai', ai as any);
      console.log('[config] Added missing AI provider settings');
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
      this.store.set(key, result.data[key]);
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
