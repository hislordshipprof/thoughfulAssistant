import { ipcMain, BrowserWindow, clipboard, desktopCapturer } from 'electron';
import { AiManager } from '../services/ai/ai-manager';
import { AudioManager } from '../services/audio/audio-manager';
import { OcrManager } from '../services/ocr/ocr-manager';
import { ConfigStore } from '../services/config/config-store';
import { WindowManager } from './window-manager';

export function registerIpcHandlers(
  mainWindow: BrowserWindow,
  aiManager: AiManager,
  audioManager: AudioManager,
  ocrManager: OcrManager,
  configStore: ConfigStore,
  windowManager: WindowManager
): void {
  // AI handlers
  ipcMain.handle('ai:ask', async (_event, transcript: string, ocrText: string, query?: string) => {
    const cfg = configStore.getAll();
    const interviewMode = cfg.ai.interviewMode || 'general';
    aiManager.ask(transcript, ocrText, query, interviewMode, cfg.resume, cfg.jobDescription);
    return true;
  });

  ipcMain.handle('ai:context', (_event, text: string) => {
    aiManager.setExtraContext(text);
    return true;
  });

  ipcMain.handle('ai:cancel', () => {
    aiManager.cancelStream();
    return true;
  });

  // Wire AI events to renderer
  aiManager.on('token', (token: string) => {
    mainWindow.webContents.send('ai:token', token);
  });

  aiManager.on('done', (response: string) => {
    mainWindow.webContents.send('ai:done', response);
  });

  aiManager.on('error', (error: string) => {
    mainWindow.webContents.send('ai:error', error);
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
    mainWindow.webContents.send('transcript:update', entries);
  });

  // OCR handlers
  ipcMain.handle('ocr:capture', async () => {
    await ocrManager.captureNow();
    // Send all accumulated screenshots to renderer (image available immediately, OCR runs in background)
    const allCaptures = ocrManager.getAllCaptures();
    const imageUrls = allCaptures.map(c => c.image.imageDataUrl);
    mainWindow.webContents.send('ocr:screenshots', imageUrls);
    return true;
  });

  ipcMain.handle('ocr:lastText', () => {
    return ocrManager.getCombinedText();
  });

  ipcMain.handle('ocr:clear', () => {
    ocrManager.clearCaptures();
    mainWindow.webContents.send('ocr:screenshots', []);
    return true;
  });

  ipcMain.handle('ocr:remove', (_event, index: number) => {
    ocrManager.removeCapture(index);
    const allCaptures = ocrManager.getAllCaptures();
    const imageUrls = allCaptures.map(c => c.image.imageDataUrl);
    mainWindow.webContents.send('ocr:screenshots', imageUrls);
    return true;
  });

  // Config handlers
  ipcMain.handle('config:get', (_event, key?: string) => {
    if (key) {
      return configStore.get(key as any);
    }
    return configStore.getAll();
  });

  ipcMain.handle('config:set', (_event, key: string, value: any) => {
    configStore.set(key as any, value);
    return true;
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

  // Provide the primary screen's capture source id so the renderer can try
  // to capture system (loopback) audio on macOS via getUserMedia. Best-effort.
  ipcMain.handle('mac-audio:getScreenSourceId', async () => {
    try {
      const sources = await desktopCapturer.getSources({
        types: ['screen'],
        thumbnailSize: { width: 1, height: 1 }
      });
      return sources[0]?.id ?? null;
    } catch {
      return null;
    }
  });

  // Session reset
  ipcMain.handle('session:reset', () => {
    aiManager.clearHistory();
    aiManager.cancelStream();
    audioManager.getTranscriptStore().clear();
    ocrManager.clearCaptures();
    mainWindow.webContents.send('ocr:screenshots', []);
    mainWindow.webContents.send('transcript:update', []);
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
}
