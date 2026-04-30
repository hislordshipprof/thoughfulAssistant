import { app, BrowserWindow } from 'electron';
import path from 'path';
import fs from 'fs';
import { WindowManager } from './window-manager';
import { HotkeyManager } from './hotkey-manager';
import { TrayManager } from './tray';
import { registerIpcHandlers } from './ipc-handlers';
import { AiManager } from '../services/ai/ai-manager';
import { AudioManager } from '../services/audio/audio-manager';
import { OcrManager } from '../services/ocr/ocr-manager';
import { setNativeAddon, setMainWindow } from '../services/ocr/screen-capture';
import { ConfigStore } from '../services/config/config-store';

// Disguise process name in Task Manager
process.title = 'AudioDeviceHelper';
app.setName('AudioDeviceHelper');

// Disable Chromium's WGC (Windows Graphics Capture) — it conflicts with
// SetWindowDisplayAffinity(WDA_EXCLUDEFROMCAPTURE). Chromium falls back to
// DXGI duplication which is not affected by display affinity flags.
app.commandLine.appendSwitch('disable-features', 'DesktopCaptureWgc');
// Suppress Chromium's internal WGC capturability checks (harmless ERROR logs
// from the compositor probing a WDA_EXCLUDEFROMCAPTURE window).
app.commandLine.appendSwitch('log-level', '3');

// Prevent multiple instances
const gotTheLock = app.requestSingleInstanceLock();
if (!gotTheLock) {
  app.quit();
}

let windowManager: WindowManager;
let hotkeyManager: HotkeyManager;
let trayManager: TrayManager;
let aiManager: AiManager;
let audioManager: AudioManager;
let ocrManager: OcrManager;
let configStore: ConfigStore;
let typingModeActive = false;

/** Pixel distance for Ctrl+Alt+Arrow window movement */
const WINDOW_MOVE_DELTA = 30;

function loadEnvFile(): void {
  const envPath = path.join(app.getAppPath(), '.env');
  if (!fs.existsSync(envPath)) return;
  const lines = fs.readFileSync(envPath, 'utf-8').split('\n');
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eqIdx = trimmed.indexOf('=');
    if (eqIdx === -1) continue;
    const key = trimmed.slice(0, eqIdx).trim();
    const value = trimmed.slice(eqIdx + 1).trim();
    if (!process.env[key]) {
      process.env[key] = value;
    }
  }
}

async function createApp(): Promise<void> {
  // Load .env file (process.env keys won't override existing env vars)
  loadEnvFile();

  // Initialize config
  configStore = new ConfigStore();
  const config = configStore.getAll();

  // Seed API keys from .env if not yet saved in config
  let configChanged = false;
  if (!config.ai.openaiKey && process.env.OPENAI_API_KEY) {
    config.ai.openaiKey = process.env.OPENAI_API_KEY;
    configChanged = true;
  }
  if (!config.ai.anthropicKey && process.env.ANTHROPIC_API_KEY) {
    config.ai.anthropicKey = process.env.ANTHROPIC_API_KEY;
    configChanged = true;
  }
  if (!config.ai.groqKey && process.env.GROQ_API_KEY) {
    config.ai.groqKey = process.env.GROQ_API_KEY;
    configChanged = true;
  }
  if (configChanged) {
    configStore.set('ai', config.ai);
  }

  let audioConfigChanged = false;
  if (!config.audio.deepgramKey && process.env.DEEPGRAM_API_KEY) {
    config.audio.deepgramKey = process.env.DEEPGRAM_API_KEY;
    audioConfigChanged = true;
  }
  if (!config.audio.groqKey && process.env.GROQ_API_KEY) {
    config.audio.groqKey = process.env.GROQ_API_KEY;
    audioConfigChanged = true;
  }
  if (!config.audio.googleSttKey && process.env.GOOGLE_STT_API_KEY) {
    config.audio.googleSttKey = process.env.GOOGLE_STT_API_KEY;
    audioConfigChanged = true;
  }
  if (!config.audio.googleProjectId && process.env.GOOGLE_PROJECT_ID) {
    config.audio.googleProjectId = process.env.GOOGLE_PROJECT_ID;
    audioConfigChanged = true;
  }
  if (audioConfigChanged) {
    configStore.set('audio', config.audio);
  }

  // Initialize managers
  windowManager = new WindowManager();
  hotkeyManager = new HotkeyManager();
  trayManager = new TrayManager();
  aiManager = new AiManager();

  const nativeAddon = windowManager.getNativeAddon();
  // Pass native addon to screen-capture for fast BitBlt screenshots
  setNativeAddon(nativeAddon);

  audioManager = new AudioManager(nativeAddon || {
    startCapture: () => false,
    stopCapture: () => false,
    isCapturing: () => false
  });
  ocrManager = new OcrManager(config.ocr.intervalSeconds);
  ocrManager.setStealthToggle(windowManager);

  // Initialize AI providers
  console.log(`[main] Initializing AI — provider: ${config.ai.provider}, openaiModel: ${config.ai.openaiModel}, anthropicModel: ${config.ai.anthropicModel}, groqModel: ${config.ai.groqModel}`);
  aiManager.initializeProviders(config.ai.openaiKey, config.ai.anthropicKey, config.ai.openaiModel, config.ai.anthropicModel, config.ai.groqKey, config.ai.groqModel);
  if (config.ai.provider) {
    aiManager.setActiveProvider(config.ai.provider);
  }

  // Create overlay window
  const mainWindow = windowManager.createOverlayWindow({
    width: config.overlay.width,
    height: config.overlay.height,
    x: config.overlay.x,
    y: config.overlay.y,
    opacity: config.overlay.opacity
  });

  // Pass main window to screen-capture for multi-monitor support
  setMainWindow(mainWindow);

  // Smart hit-test is the default — overlay UI elements are clickable,
  // transparent areas pass through. No binary click-through toggle needed.

  // Load renderer
  if (process.env.ELECTRON_RENDERER_URL) {
    mainWindow.loadURL(process.env.ELECTRON_RENDERER_URL);
  } else {
    mainWindow.loadFile(path.join(__dirname, '../renderer/index.html'));
  }

  // Register IPC handlers
  registerIpcHandlers(mainWindow, aiManager, audioManager, ocrManager, configStore, windowManager);

  // Initialize OCR engine
  await ocrManager.initialize();
  if (config.ocr.autoCapture) {
    ocrManager.startPeriodicCapture();
  }

  // Setup hotkeys
  console.log('[main] Hotkey config loaded:', JSON.stringify(config.hotkeys));
  hotkeyManager.registerHotkeys(config.hotkeys);
  const hotkeyStarted = hotkeyManager.start();
  console.log('[main] Hotkey manager started:', hotkeyStarted);

  hotkeyManager.on('hotkey', (action: string) => {
    console.log('[main] Hotkey triggered:', action);
    handleHotkeyAction(action, mainWindow);
  });

  // Setup typing mode callback — receives keystroke events from native LL hook
  const nativeAddonForTyping = windowManager.getNativeAddon();
  if (nativeAddonForTyping?.setTypingCallback) {
    nativeAddonForTyping.setTypingCallback((event: any) => {
      if (mainWindow.isDestroyed()) return;
      if (event.type === 'mode') {
        typingModeActive = event.active;
        safeSend(mainWindow, 'typing:mode', event.active);
      } else {
        safeSend(mainWindow, 'typing:event', event);
      }
    });
    console.log('[main] Typing callback registered');
  } else {
    console.warn('[main] Typing callback unavailable — addon missing functions');
  }

  // Setup tray
  trayManager.create({
    onToggleOverlay: () => windowManager.toggleVisibility(),
    onToggleRecording: async () => {
      if (audioManager.isActive()) {
        audioManager.stop();
        trayManager.setRecordingState(false);
      } else {
        const cfg = configStore.getAll();
        await audioManager.start(cfg.ai.openaiKey, cfg.audio.transcriptionMode, {
          deepgramKey: cfg.audio.deepgramKey,
          groqKey: cfg.audio.groqKey,
          googleSttKey: cfg.audio.googleSttKey,
          googleProjectId: cfg.audio.googleProjectId
        });
        trayManager.setRecordingState(true);
      }
    },
    onSettings: () => {
      // Disable full passthrough so user can interact with settings modal
      windowManager.setFullPassthrough(false);
      safeSend(mainWindow, 'hotkey:action', 'openSettings');
    },
    onQuit: () => {
      cleanup();
    }
  });

  // Watch config changes
  configStore.onDidChange('overlay', (newVal) => {
    if (newVal) {
      windowManager.setOpacity(newVal.opacity);
      windowManager.setSize(newVal.width, newVal.height);
    }
  });

  configStore.onDidChange('ai', (newVal) => {
    if (newVal) {
      console.log(`[main] AI config changed — provider: ${newVal.provider}, openaiModel: ${newVal.openaiModel}, anthropicModel: ${newVal.anthropicModel}, groqModel: ${newVal.groqModel}`);
      if (newVal.provider) aiManager.setActiveProvider(newVal.provider);
      if (newVal.openaiModel) aiManager.setModel('openai', newVal.openaiModel);
      if (newVal.anthropicModel) aiManager.setModel('anthropic', newVal.anthropicModel);
      if (newVal.groqModel) aiManager.setModel('groq', newVal.groqModel);
    }
  });

  configStore.onDidChange('hotkeys', (newVal) => {
    if (newVal) {
      hotkeyManager.updateBindings(newVal);
    }
  });
}

/** Send to renderer only if the window hasn't been destroyed. */
function safeSend(win: BrowserWindow, channel: string, ...args: any[]): void {
  if (!win.isDestroyed()) {
    win.webContents.send(channel, ...args);
  }
}

async function handleHotkeyAction(action: string, mainWindow: BrowserWindow): Promise<void> {
  switch (action) {
    case 'toggleOverlay':
      windowManager.toggleVisibility();
      break;

    case 'toggleInteract':
      windowManager.toggleInteractMode();
      safeSend(mainWindow, 'hotkey:action', 'toggleInteract');
      break;

    case 'askAi': {
      const askStart = performance.now();

      // Auto-capture screen if no screenshots are queued
      if (ocrManager.getCaptureCount() === 0) {
        console.log('[main] No screenshots queued — auto-capturing screen before asking AI...');
        await ocrManager.captureScreenOnly();
        const tCapture = performance.now();
        console.log(`[main-timing] auto-capture: ${(tCapture - askStart).toFixed(0)}ms`);
        // Send thumbnail to renderer immediately
        const allCaptures = ocrManager.getAllCaptures();
        const imageUrls = allCaptures.map(c => c.image.imageDataUrl);
        safeSend(mainWindow, 'ocr:screenshots', imageUrls);
        const tSend = performance.now();
        console.log(`[main-timing] IPC send thumbnails: ${(tSend - tCapture).toFixed(0)}ms`);
      }

      const transcript = audioManager.getTranscriptContext();
      // Collect screenshot data URLs to send directly to vision model (no OCR)
      const allCaptures = ocrManager.getAllCaptures();
      const screenshotDataUrls = allCaptures.map(c => c.image.imageDataUrl);
      const cfg = configStore.getAll();
      const interviewMode = cfg.ai.interviewMode || 'general';
      const extraCtx = aiManager.getExtraContext();

      const tPreAi = performance.now();
      console.log(`[main-timing] prep before AI call: ${(tPreAi - askStart).toFixed(0)}ms`);
      console.log('[main] Asking AI (vision) —',
        `transcript: ${transcript.length} chars,`,
        `screenshots: ${screenshotDataUrls.length},`,
        `imgSizes: [${screenshotDataUrls.map(u => (u.length / 1024).toFixed(0) + 'KB').join(', ')}],`,
        `extraContext: ${extraCtx.length} chars,`,
        `mode: ${interviewMode}`
      );
      // Log actual content previews for pipeline debugging
      if (transcript) {
        console.log(`[main] transcript preview: "${transcript.slice(0, 200).replace(/\n/g, '\\n')}${transcript.length > 200 ? '...' : ''}"`);
      }
      if (extraCtx) {
        console.log(`[main] extraContext preview: "${extraCtx.slice(0, 200).replace(/\n/g, '\\n')}${extraCtx.length > 200 ? '...' : ''}"`);
      } else {
        console.log('[main] extraContext: EMPTY — no typed text will be sent to AI');
      }

      aiManager.ask(transcript, screenshotDataUrls, extraCtx || undefined, interviewMode, cfg.resume, cfg.jobDescription, cfg.customPrompt);

      // Clear screenshots after sending — old context is preserved in conversation history
      ocrManager.clearCaptures();
      safeSend(mainWindow, 'ocr:screenshots', []);
      console.log('[main] Screenshots cleared after AI submission (old context retained in history)');

      // Clear extra context after submitting so it doesn't re-send on next ask
      if (extraCtx) {
        aiManager.setExtraContext('');
        safeSend(mainWindow, 'extra-context:clear');
      }
      safeSend(mainWindow, 'hotkey:action', 'askAi');
      break;
    }

    case 'captureScreen': {
      const tCap = performance.now();
      ocrManager.captureNow().then(() => {
        console.log(`[main-timing] captureScreen total: ${(performance.now() - tCap).toFixed(0)}ms`);
        // Send all accumulated screenshot URLs to renderer
        const allCaptures = ocrManager.getAllCaptures();
        const imageUrls = allCaptures.map(c => c.image.imageDataUrl);
        safeSend(mainWindow, 'ocr:screenshots', imageUrls);
        safeSend(mainWindow, 'hotkey:action', 'captureScreen');
      }).catch((err) => {
        console.error('[main] captureScreen failed:', err);
      });
      break;
    }

    case 'toggleRecording':
      if (audioManager.isActive()) {
        audioManager.stop();
        trayManager.setRecordingState(false);
      } else {
        const cfg = configStore.getAll();
        try {
          await audioManager.start(cfg.ai.openaiKey, cfg.audio.transcriptionMode, {
            deepgramKey: cfg.audio.deepgramKey,
            groqKey: cfg.audio.groqKey,
            googleSttKey: cfg.audio.googleSttKey,
            googleProjectId: cfg.audio.googleProjectId
          });
          trayManager.setRecordingState(true);
        } catch (err) {
          console.error('[main] audioManager.start() failed:', err);
        }
      }
      safeSend(mainWindow, 'hotkey:action', 'toggleRecording');
      break;

    case 'cancelStream':
      aiManager.cancelStream();
      safeSend(mainWindow, 'hotkey:action', 'cancelStream');
      break;

    case 'resetAll': {
      aiManager.clearHistory();
      aiManager.cancelStream();
      audioManager.getTranscriptStore().clear();
      ocrManager.clearCaptures();
      // Turn off typing mode if active
      if (typingModeActive) {
        typingModeActive = false;
        const addon = windowManager.getNativeAddon();
        addon?.setTypingMode?.(false);
        safeSend(mainWindow, 'typing:mode', false);
      }
      safeSend(mainWindow, 'ocr:screenshots', []);
      safeSend(mainWindow, 'transcript:update', []);
      safeSend(mainWindow, 'hotkey:action', 'resetAll');
      console.log('[main] Session reset — all cleared');
      break;
    }

    case 'scrollUp':
      safeSend(mainWindow, 'hotkey:action', 'scrollUp');
      break;

    case 'scrollDown':
      safeSend(mainWindow, 'hotkey:action', 'scrollDown');
      break;

    case 'quitApp':
      cleanup();
      app.quit();
      break;

    case 'moveWindowUp':
      windowManager.moveBy(0, -WINDOW_MOVE_DELTA);
      break;

    case 'moveWindowDown':
      windowManager.moveBy(0, WINDOW_MOVE_DELTA);
      break;

    case 'moveWindowLeft':
      windowManager.moveBy(-WINDOW_MOVE_DELTA, 0);
      break;

    case 'moveWindowRight':
      windowManager.moveBy(WINDOW_MOVE_DELTA, 0);
      break;

    case 'hideApp':
      windowManager.toggleVisibility();
      break;

    case 'emergencyHide':
      windowManager.emergencyHide();
      break;

    case 'toggleTypingMode': {
      const addon = windowManager.getNativeAddon();
      if (addon?.setTypingMode) {
        typingModeActive = !typingModeActive;
        addon.setTypingMode(typingModeActive);
        safeSend(mainWindow, 'typing:mode', typingModeActive);
        console.log('[main] Typing mode:', typingModeActive);
      } else {
        console.warn('[main] setTypingMode not available on addon');
      }
      break;
    }
  }

  // Send status update to renderer
  safeSend(mainWindow, 'status:update', {
    isRecording: audioManager.isActive(),
    aiProvider: aiManager.getActiveProviderName(),
    isStealthActive: windowManager.isStealthEnabled()
  });
}

let cleanedUp = false;
function cleanup(): void {
  if (cleanedUp) return;
  cleanedUp = true;
  hotkeyManager?.stop();
  audioManager?.stop();
  ocrManager?.terminate();
  trayManager?.destroy();
}

app.whenReady().then(createApp).catch((err) => {
  console.error('[main] Fatal error during startup:', err);
  app.quit();
});

app.on('window-all-closed', () => {
  cleanup();
  app.quit();
});

app.on('before-quit', () => {
  cleanup();
});

// Handle second instance — focus existing window
app.on('second-instance', () => {
  if (windowManager) {
    windowManager.stealthShow();
  }
});
