import { ipcMain, BrowserWindow, clipboard, dialog } from 'electron';
import { AiManager } from '../services/ai/ai-manager';
import { AudioManager } from '../services/audio/audio-manager';
import { OcrManager } from '../services/ocr/ocr-manager';
import { ConfigStore } from '../services/config/config-store';
import { WindowManager } from './window-manager';
import { extractTextFromFile } from '../services/file/file-extractor';
import { AppConfig } from '../services/config/config-schema';

/** Valid top-level config keys (derived from schema type). */
const VALID_CONFIG_KEYS: ReadonlySet<string> = new Set<keyof AppConfig>([
  'ai', 'audio', 'ocr', 'overlay', 'hotkeys', 'resume', 'jobDescription', 'customPrompt'
]);

export function registerIpcHandlers(
  mainWindow: BrowserWindow,
  aiManager: AiManager,
  audioManager: AudioManager,
  ocrManager: OcrManager,
  configStore: ConfigStore,
  windowManager: WindowManager
): void {
  /** Send to renderer only if the window hasn't been destroyed. */
  function safeSend(channel: string, ...args: any[]): void {
    if (!mainWindow.isDestroyed()) {
      mainWindow.webContents.send(channel, ...args);
    }
  }
  // AI handlers
  ipcMain.handle('ai:ask', async (_event, transcript: string, _ocrText: string, query?: string) => {
    const cfg = configStore.getAll();
    const interviewMode = cfg.ai.interviewMode || 'general';
    // Pass screenshots directly as images for vision model (no OCR)
    const allCaptures = ocrManager.getAllCaptures();
    const screenshotDataUrls = allCaptures.map(c => c.image.imageDataUrl);
    aiManager.ask(transcript, screenshotDataUrls, query, interviewMode, cfg.resume, cfg.jobDescription, cfg.customPrompt);
    return true;
  });

  ipcMain.handle('ai:context', (_event, text: string) => {
    console.log(`[ipc] ai:context SET (${text.length} chars): "${text.slice(0, 100).replace(/\n/g, '\\n')}${text.length > 100 ? '...' : ''}"`);
    aiManager.setExtraContext(text);
    return true;
  });

  ipcMain.handle('ai:cancel', () => {
    aiManager.cancelStream();
    return true;
  });

  // Wire AI events to renderer.
  // Tokens are batched: without this, each token was one IPC message (one
  // structured-clone + one renderer event-loop wakeup). A ~1500-token response
  // = ~1500 round trips. Coalescing on a ~16ms timer cuts that 10-20x while
  // still delivering fast enough that the renderer's own 90ms flush is the
  // pacing floor, not IPC.
  const TOKEN_FLUSH_MS = 16;
  let tokenBuffer = '';
  let tokenFlushTimer: ReturnType<typeof setTimeout> | null = null;

  const flushTokenBuffer = (): void => {
    if (tokenFlushTimer) {
      clearTimeout(tokenFlushTimer);
      tokenFlushTimer = null;
    }
    if (tokenBuffer) {
      safeSend('ai:token', tokenBuffer);
      tokenBuffer = '';
    }
  };

  // New stream starting — drop anything buffered from a superseded attempt so
  // its stale tail can't prepend onto the new response.
  aiManager.on('stream-start', () => {
    if (tokenFlushTimer) {
      clearTimeout(tokenFlushTimer);
      tokenFlushTimer = null;
    }
    tokenBuffer = '';
  });

  aiManager.on('token', (token: string) => {
    tokenBuffer += token;
    if (!tokenFlushTimer) {
      tokenFlushTimer = setTimeout(flushTokenBuffer, TOKEN_FLUSH_MS);
    }
  });

  aiManager.on('done', (response: string) => {
    flushTokenBuffer();
    safeSend('ai:done', response);
  });

  aiManager.on('error', (error: string) => {
    flushTokenBuffer(); // preserve any partial tokens already streamed
    safeSend('ai:error', error);
  });

  // Audio handlers
  ipcMain.handle('audio:toggle', async () => {
    if (audioManager.isActive()) {
      audioManager.stop();
      return false;
    } else {
      const config = configStore.getAll();
      await audioManager.start(config.ai.openaiKey, config.audio.transcriptionMode, {
        deepgramKey: config.audio.deepgramKey,
        groqKey: config.audio.groqKey,
        googleSttKey: config.audio.googleSttKey,
        googleProjectId: config.audio.googleProjectId
      });
      return true;
    }
  });

  ipcMain.handle('audio:state', () => {
    return audioManager.isActive();
  });

  // Wire transcript updates to renderer
  audioManager.getTranscriptStore().on('update', (entries) => {
    safeSend('transcript:update', entries);
  });

  // OCR handlers
  ipcMain.handle('ocr:capture', async () => {
    const activeProvider = aiManager.getActiveProviderName() ?? undefined;
    await ocrManager.captureNow(activeProvider);
    // Send all accumulated screenshots to renderer
    const allCaptures = ocrManager.getAllCaptures();
    const imageUrls = allCaptures.map(c => c.image.imageDataUrl);
    safeSend('ocr:screenshots', imageUrls);
    return true;
  });

  ipcMain.handle('ocr:lastText', () => {
    return ocrManager.getCombinedText();
  });

  ipcMain.handle('ocr:clear', () => {
    ocrManager.clearCaptures();
    safeSend('ocr:screenshots', []);
    return true;
  });

  ipcMain.handle('ocr:remove', (_event, index: number) => {
    ocrManager.removeCapture(index);
    const allCaptures = ocrManager.getAllCaptures();
    const imageUrls = allCaptures.map(c => c.image.imageDataUrl);
    safeSend('ocr:screenshots', imageUrls);
    return true;
  });

  // Config handlers
  ipcMain.handle('config:get', (_event, key?: string) => {
    if (key) {
      if (!VALID_CONFIG_KEYS.has(key)) {
        throw new Error(`Invalid config key: ${key}`);
      }
      return configStore.get(key as keyof AppConfig);
    }
    return configStore.getAll();
  });

  ipcMain.handle('config:set', (_event, key: string, value: unknown) => {
    if (!VALID_CONFIG_KEYS.has(key)) {
      throw new Error(`Invalid config key: ${key}`);
    }
    try {
      configStore.set(key as keyof AppConfig, value as any);
      return true;
    } catch (err: any) {
      console.error(`[ipc] config:set failed for key "${key}":`, err.message);
      throw err;
    }
  });

  // Stealth toggle
  ipcMain.handle('window:toggleStealth', () => {
    const isEnabled = windowManager.isStealthEnabled();
    if (isEnabled) {
      windowManager.removeStealthMode();
    } else {
      windowManager.applyStealthMode();
    }
    const newState = windowManager.isStealthEnabled();
    safeSend('status:update', {
      isRecording: audioManager.isActive(),
      aiProvider: aiManager.getActiveProviderName(),
      isStealthActive: newState
    });
    return newState;
  });

  // Window handlers
  ipcMain.handle('window:clickThrough', (_event, enable: boolean) => {
    windowManager.setFullPassthrough(enable);
    return true;
  });

  // Smart hit-test: preload sends fire-and-forget IPC to toggle click-through
  // dynamically based on mouse position over UI elements vs transparent areas
  ipcMain.on('set-ignore-mouse-events', (_event, ignore: boolean, options?: { forward: boolean }) => {
    windowManager.handleSmartHitTest(ignore, options);
  });

  ipcMain.handle('window:opacity', (_event, opacity: number) => {
    windowManager.setOpacity(opacity);
    return true;
  });

  ipcMain.handle('window:focusable', (_event, enable: boolean) => {
    windowManager.setFocusableForInput(enable);
    return true;
  });

  // Session reset
  ipcMain.handle('session:reset', () => {
    aiManager.clearHistory();
    aiManager.cancelStream();
    audioManager.getTranscriptStore().clear();
    ocrManager.clearCaptures();
    safeSend('ocr:screenshots', []);
    safeSend('transcript:update', []);
    return true;
  });

  // Window move (drag from renderer)
  ipcMain.handle('window:move', (_event, dx: number, dy: number) => {
    windowManager.moveBy(dx, dy);
    return true;
  });

  // Toggle resizable (disabled during drag to prevent frameless edge-resize)
  ipcMain.handle('window:resizable', (_event, enable: boolean) => {
    const win = windowManager.getWindow();
    if (win) {
      win.setResizable(enable);
    }
    return true;
  });

  // Window size
  ipcMain.handle('window:size', (_event, width: number, height: number) => {
    windowManager.setSize(width, height);
    return true;
  });

  // Clipboard — write text without requiring window focus
  ipcMain.handle('clipboard:write', (_event, text: string) => {
    clipboard.writeText(text);
    return true;
  });

  // File upload — pick file and extract text
  ipcMain.handle('file:pick-and-extract', async (_event, purpose: string) => {
    const result = await dialog.showOpenDialog(mainWindow, {
      title: `Upload ${purpose === 'resume' ? 'Resume' : 'Job Description'}`,
      filters: [
        { name: 'Documents', extensions: ['txt', 'md', 'pdf', 'docx'] },
        { name: 'All Files', extensions: ['*'] }
      ],
      properties: ['openFile']
    });

    if (result.canceled || result.filePaths.length === 0) {
      console.log(`[ipc] file:pick-and-extract — dialog canceled (purpose: ${purpose})`);
      return null;
    }

    const filePath = result.filePaths[0];
    console.log(`[ipc] file:pick-and-extract — reading "${filePath}" (purpose: ${purpose})`);
    const extraction = await extractTextFromFile(filePath);
    if (extraction.success) {
      console.log(`[ipc] file:pick-and-extract — SUCCESS: "${extraction.fileName}" → ${extraction.text.length.toLocaleString()} chars extracted`);
    } else {
      console.error(`[ipc] file:pick-and-extract — FAILED: "${extraction.fileName}" → ${extraction.error}`);
    }
    return extraction;
  });

  // Typing mode toggle — explicitly enable/disable typing mode
  // Receives an explicit state (true/false) to set typing mode
  ipcMain.handle('typing:toggle', (_event, enableTypingMode: boolean) => {
    const addon = windowManager.getNativeAddon();
    if (!addon?.setTypingMode) {
      console.warn('[ipc] typing:toggle — setTypingMode not available');
      return false;
    }

    addon.setTypingMode(enableTypingMode);
    safeSend('typing:mode', enableTypingMode);
    console.log(`[ipc] typing:toggle → ${enableTypingMode ? 'enabled' : 'disabled'}`);
    return enableTypingMode;
  });
}
