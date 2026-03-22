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
import { setNativeAddon } from '../services/ocr/screen-capture';
import { ConfigStore } from '../services/config/config-store';

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
  console.log(`[main] Initializing AI — provider: ${config.ai.provider}, openaiModel: ${config.ai.openaiModel}, anthropicModel: ${config.ai.anthropicModel}`);
  aiManager.initializeProviders(config.ai.openaiKey, config.ai.anthropicKey, config.ai.openaiModel, config.ai.anthropicModel);
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
  console.log('[main] Native addon for typing:', !!nativeAddonForTyping);
  console.log('[main] setTypingCallback available:', !!nativeAddonForTyping?.setTypingCallback);
  console.log('[main] setTypingMode available:', !!nativeAddonForTyping?.setTypingMode);
  if (nativeAddonForTyping?.setTypingCallback) {
    nativeAddonForTyping.setTypingCallback((event: any) => {
      console.log('[main] Typing callback received:', JSON.stringify(event));
      if (event.type === 'mode') {
        // Typing mode was toggled from C++ side (e.g. Escape pressed)
        typingModeActive = event.active;
        mainWindow.webContents.send('typing:mode', event.active);
        console.log('[main] Typing mode (native):', event.active);
      } else {
        // Character or command event — relay to renderer
        mainWindow.webContents.send('typing:event', event);
      }
    });
    console.log('[main] Typing callback registered successfully');
  } else {
    console.warn('[main] WARNING: Could not register typing callback — addon missing functions');
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
      mainWindow.webContents.send('hotkey:action', 'openSettings');
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
      console.log(`[main] AI config changed — provider: ${newVal.provider}, openaiModel: ${newVal.openaiModel}, anthropicModel: ${newVal.anthropicModel}`);
      if (newVal.provider) aiManager.setActiveProvider(newVal.provider);
      if (newVal.openaiModel) aiManager.setModel('openai', newVal.openaiModel);
      if (newVal.anthropicModel) aiManager.setModel('anthropic', newVal.anthropicModel);
    }
  });

  configStore.onDidChange('hotkeys', (newVal) => {
    if (newVal) {
      hotkeyManager.updateBindings(newVal);
    }
  });
}

async function handleHotkeyAction(action: string, mainWindow: BrowserWindow): Promise<void> {
  switch (action) {
    case 'toggleOverlay':
      windowManager.toggleVisibility();
      break;

    case 'toggleInteract':
      windowManager.toggleInteractMode();
      mainWindow.webContents.send('hotkey:action', 'toggleInteract');
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
        mainWindow.webContents.send('ocr:screenshots', imageUrls);
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

      aiManager.ask(transcript, screenshotDataUrls, extraCtx || undefined, interviewMode, cfg.resume, cfg.jobDescription);

      // Clear screenshots after sending — old context is preserved in conversation history
      ocrManager.clearCaptures();
      mainWindow.webContents.send('ocr:screenshots', []);
      console.log('[main] Screenshots cleared after AI submission (old context retained in history)');

      // Clear extra context after submitting so it doesn't re-send on next ask
      if (extraCtx) {
        aiManager.setExtraContext('');
        mainWindow.webContents.send('extra-context:clear');
      }
      mainWindow.webContents.send('hotkey:action', 'askAi');
      break;
    }

    case 'captureScreen': {
      const tCap = performance.now();
      ocrManager.captureNow().then(() => {
        console.log(`[main-timing] captureScreen total: ${(performance.now() - tCap).toFixed(0)}ms`);
        // Send all accumulated screenshot URLs to renderer
        const allCaptures = ocrManager.getAllCaptures();
        const imageUrls = allCaptures.map(c => c.image.imageDataUrl);
        mainWindow.webContents.send('ocr:screenshots', imageUrls);
        mainWindow.webContents.send('hotkey:action', 'captureScreen');
      });
      break;
    }

    case 'toggleRecording':
      if (audioManager.isActive()) {
        audioManager.stop();
        trayManager.setRecordingState(false);
      } else {
        const cfg = configStore.getAll();
        audioManager.start(cfg.ai.openaiKey, cfg.audio.transcriptionMode, {
          deepgramKey: cfg.audio.deepgramKey,
          groqKey: cfg.audio.groqKey,
          googleSttKey: cfg.audio.googleSttKey,
          googleProjectId: cfg.audio.googleProjectId
        });
        trayManager.setRecordingState(true);
      }
      mainWindow.webContents.send('hotkey:action', 'toggleRecording');
      break;

    case 'cancelStream':
      aiManager.cancelStream();
      mainWindow.webContents.send('hotkey:action', 'cancelStream');
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
        mainWindow.webContents.send('typing:mode', false);
      }
      mainWindow.webContents.send('ocr:screenshots', []);
      mainWindow.webContents.send('transcript:update', []);
      mainWindow.webContents.send('hotkey:action', 'resetAll');
      console.log('[main] Session reset — all cleared');
      break;
    }

    case 'scrollUp':
      mainWindow.webContents.send('hotkey:action', 'scrollUp');
      break;

    case 'scrollDown':
      mainWindow.webContents.send('hotkey:action', 'scrollDown');
      break;

    case 'quitApp':
      cleanup();
      app.quit();
      break;

    case 'moveWindowUp':
      windowManager.moveBy(0, -30);
      break;

    case 'moveWindowDown':
      windowManager.moveBy(0, 30);
      break;

    case 'moveWindowLeft':
      windowManager.moveBy(-30, 0);
      break;

    case 'moveWindowRight':
      windowManager.moveBy(30, 0);
      break;

    case 'hideApp':
      windowManager.toggleVisibility();
      break;

    case 'toggleTypingMode': {
      console.log('[main] toggleTypingMode action received!');
      const addon = windowManager.getNativeAddon();
      console.log('[main] addon:', !!addon, 'setTypingMode:', !!addon?.setTypingMode);
      if (addon?.setTypingMode) {
        typingModeActive = !typingModeActive;
        console.log('[main] Setting typing mode to:', typingModeActive);
        addon.setTypingMode(typingModeActive);
        mainWindow.webContents.send('typing:mode', typingModeActive);
        console.log('[main] Typing mode set and sent to renderer:', typingModeActive);
      } else {
        console.warn('[main] WARNING: setTypingMode not available on addon');
      }
      break;
    }
  }

  // Send status update to renderer
  mainWindow.webContents.send('status:update', {
    isRecording: audioManager.isActive(),
    aiProvider: aiManager.getActiveProviderName(),
    isStealthActive: windowManager.isStealthEnabled()
  });
}

function cleanup(): void {
  hotkeyManager?.stop();
  audioManager?.stop();
  ocrManager?.terminate();
  trayManager?.destroy();
}

app.whenReady().then(createApp);

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
