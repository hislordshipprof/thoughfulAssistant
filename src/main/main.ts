import { app, BrowserWindow, desktopCapturer } from 'electron';
import path from 'path';
import fs from 'fs';
import { WindowManager } from './window-manager';
import { HotkeyManager } from './hotkey-manager';
import { TrayManager } from './tray';
import { registerIpcHandlers } from './ipc-handlers';
import { AiManager } from '../services/ai/ai-manager';
import { AudioManager } from '../services/audio/audio-manager';
import { OcrManager } from '../services/ocr/ocr-manager';
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

  ocrManager = new OcrManager(config.ocr.intervalSeconds);
  ocrManager.setStealthToggle(windowManager);

  // Initialize AI providers
  aiManager.initializeProviders(config.ai.openaiKey, config.ai.anthropicKey, config.ai.openaiModel, config.ai.anthropicModel);
  if (config.ai.provider) {
    aiManager.setActiveProvider(config.ai.provider);
  }

  // Create overlay window (must exist before the Mac audio bridge needs it)
  const mainWindow = windowManager.createOverlayWindow({
    width: config.overlay.width,
    height: config.overlay.height,
    x: config.overlay.x,
    y: config.overlay.y,
    opacity: config.overlay.opacity
  });

  // Audio capture source — Windows uses the native WASAPI addon, macOS uses
  // a renderer-side getUserMedia bridge over IPC.
  const nativeAddon = windowManager.getNativeAddon();
  let audioSource: any;
  if (process.platform === 'darwin') {
    const { MacAudioBridge } = await import('./mac-audio-bridge');
    audioSource = new MacAudioBridge(mainWindow);
    console.log('[main] Using MacAudioBridge for microphone capture');
  } else if (nativeAddon) {
    audioSource = nativeAddon;
  } else {
    audioSource = {
      startCapture: () => false,
      stopCapture: () => false,
      isCapturing: () => false
    };
  }
  audioManager = new AudioManager(audioSource);

  // Smart hit-test is the default — overlay UI elements are clickable,
  // transparent areas pass through. No binary click-through toggle needed.

  // Grant microphone / media permissions requested by the renderer
  // (macOS still shows the native OS prompt the first time).
  mainWindow.webContents.session.setPermissionRequestHandler((_wc, permission, callback) => {
    // 'media' covers microphone + camera getUserMedia; 'display-capture'
    // covers desktop/system-audio capture used by the Mac loopback path.
    if (permission === 'media' || permission === 'display-capture') {
      callback(true);
      return;
    }
    callback(false);
  });

  // macOS system-audio capture. When the renderer calls getDisplayMedia,
  // hand it the primary screen plus 'loopback' audio — Electron captures
  // system audio through ScreenCaptureKit on macOS 13+ with no on-screen
  // picker. We only want the audio; the renderer drops the video track.
  if (process.platform === 'darwin') {
    try {
      mainWindow.webContents.session.setDisplayMediaRequestHandler((_request, callback) => {
        desktopCapturer.getSources({ types: ['screen'], thumbnailSize: { width: 1, height: 1 } })
          .then((sources) => {
            if (!sources.length) { callback({}); return; }
            // 'loopback' = system audio via ScreenCaptureKit (Electron ≥30, macOS 13+)
            callback({ video: sources[0], audio: 'loopback' } as any);
          })
          .catch(() => callback({}));
      }, { useSystemPicker: false });
    } catch (e: any) {
      console.warn('[main] setDisplayMediaRequestHandler unavailable:', e?.message);
    }
  }

  // Load renderer
  if (process.env.ELECTRON_RENDERER_URL) {
    mainWindow.loadURL(process.env.ELECTRON_RENDERER_URL);
  } else {
    mainWindow.loadFile(path.join(__dirname, '../renderer/index.html'));
  }

  // Push initial status once the renderer is ready, so the StatusBar
  // reflects true state (STEALTH, provider, etc.) instead of its defaults.
  mainWindow.webContents.once('did-finish-load', () => {
    mainWindow.webContents.send('status:update', {
      isRecording: audioManager.isActive(),
      aiProvider: aiManager.getActiveProviderName(),
      isStealthActive: windowManager.isStealthEnabled()
    });
  });

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
      // Auto-capture screen if no screenshots are queued
      if (ocrManager.getCaptureCount() === 0) {
        console.log('[main] No screenshots queued — auto-capturing screen before asking AI...');
        // captureWithOcrPromise: screenshot is instant (thumbnail available immediately),
        // OCR runs in parallel — we send the thumbnail to renderer right away, then await OCR
        const ocrPromise = ocrManager.captureWithOcrPromise();
        // Send thumbnail to renderer immediately (no waiting for OCR)
        const allCaptures = ocrManager.getAllCaptures();
        const imageUrls = allCaptures.map(c => c.image.imageDataUrl);
        mainWindow.webContents.send('ocr:screenshots', imageUrls);
        // Now wait for OCR to finish so the AI gets the text
        await ocrPromise;
      }

      const transcript = audioManager.getTranscriptContext();
      const ocrText = ocrManager.getCombinedText();
      const cfg = configStore.getAll();
      const interviewMode = cfg.ai.interviewMode || 'general';
      const extraCtx = aiManager.getExtraContext();

      console.log('[main] Asking AI —',
        `transcript: ${transcript.length} chars,`,
        `screenshots: ${ocrManager.getCaptureCount()},`,
        `OCR: ${ocrText.length} chars,`,
        `extraContext: ${extraCtx.length} chars,`,
        `mode: ${interviewMode}`
      );

      aiManager.ask(transcript, ocrText, extraCtx || undefined, interviewMode, cfg.resume, cfg.jobDescription);

      // Clear extra context after submitting so it doesn't re-send on next ask
      if (extraCtx) {
        aiManager.setExtraContext('');
        mainWindow.webContents.send('extra-context:clear');
      }
      mainWindow.webContents.send('hotkey:action', 'askAi');
      break;
    }

    case 'captureScreen':
      ocrManager.captureNow().then(() => {
        // Send all accumulated screenshot URLs to renderer
        const allCaptures = ocrManager.getAllCaptures();
        const imageUrls = allCaptures.map(c => c.image.imageDataUrl);
        mainWindow.webContents.send('ocr:screenshots', imageUrls);
        mainWindow.webContents.send('hotkey:action', 'captureScreen');
      });
      break;

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
      // Escape also exits typing mode (Windows does this inside the native
      // hook; replicate for the focusable-window path on macOS/other).
      if (typingModeActive && !windowManager.getNativeAddon()?.setTypingMode) {
        typingModeActive = false;
        windowManager.setFocusableForInput(false);
        mainWindow.webContents.send('typing:mode', false);
      }
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
        if (addon?.setTypingMode) {
          addon.setTypingMode(false);
        } else {
          windowManager.setFocusableForInput(false);
        }
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
      const addon = windowManager.getNativeAddon();
      typingModeActive = !typingModeActive;
      if (addon?.setTypingMode) {
        // Windows: native LL hook swallows keystrokes globally and relays
        // them as typing events.
        addon.setTypingMode(typingModeActive);
      } else {
        // macOS/other: make the overlay focusable so keystrokes land in the
        // overlay textarea (the renderer focuses it) instead of the app
        // underneath. Keys never reach the app behind the overlay while it
        // holds focus.
        windowManager.setFocusableForInput(typingModeActive);
      }
      mainWindow.webContents.send('typing:mode', typingModeActive);
      console.log('[main] Typing mode:', typingModeActive, addon?.setTypingMode ? '(native)' : '(focusable)');
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
