import { app, ipcMain, BrowserWindow, clipboard, dialog, shell } from 'electron';
import { AiManager } from '../services/ai/ai-manager';
import { AudioManager } from '../services/audio/audio-manager';
import { OcrManager } from '../services/ocr/ocr-manager';
import { ConfigStore } from '../services/config/config-store';
import { WindowManager } from './window-manager';
import { getOllamaStatus } from '../services/ai/ollama-provider';
import { listDisplays } from '../services/ocr/screen-capture';
import { getScreenPermissionStatus, requestScreenPermission } from '../services/ocr/screen-permission';

export function registerIpcHandlers(
  mainWindow: BrowserWindow,
  aiManager: AiManager,
  audioManager: AudioManager,
  ocrManager: OcrManager,
  configStore: ConfigStore,
  windowManager: WindowManager,
  controls: { run: (action: string) => Promise<void>; failures: () => string[] }
): void {
  // AI handlers
  ipcMain.handle('ai:ask', async (_event, transcript: string, ocrText: string, query?: string) => {
    const cfg = configStore.getAll();
    const interviewMode = cfg.ai.interviewMode || 'general';
    aiManager.ask(
      transcript,
      ocrText,
      query,
      interviewMode,
      cfg.resume,
      cfg.jobDescription,
      undefined,
      cfg.ai.customSystemPrompt,
      cfg.ai.systemPromptMode
    );
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

  ipcMain.handle('ai:ollama-status', async (_event, baseUrl?: string) => {
    const url = baseUrl || configStore.getAll().ai.ollamaUrl;
    return getOllamaStatus(url);
  });

  // Wire AI events to renderer
  aiManager.on('stream-start', () => mainWindow.webContents.send('ai:started'));
  aiManager.on('cancelled', () => mainWindow.webContents.send('ai:cancelled'));
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
  ipcMain.handle('audio:status', () => audioManager.getState());
  ipcMain.handle('audio:toggle', async () => {
    await controls.run('toggleRecording');
    return audioManager.isActive();
  });

  ipcMain.handle('audio:state', () => {
    return audioManager.isActive();
  });

  // Wire transcript updates to renderer
  audioManager.getTranscriptStore().on('update', (entries) => {
    mainWindow.webContents.send('transcript:update', entries);
  });

  // OCR handlers
  ipcMain.handle('screen:displays', () => listDisplays());
  ipcMain.handle('screen:permission-status', () => ({ status: getScreenPermissionStatus(), appVersion: app.getVersion() }));
  ipcMain.handle('screen:permission-request', async () => ({ status: await requestScreenPermission(), appVersion: app.getVersion() }));
  ipcMain.handle('screen:permission-settings', async () => {
    if (process.platform === 'darwin') await shell.openExternal('x-apple.systempreferences:com.apple.preference.security?Privacy_ScreenCapture');
  });
  ipcMain.handle('app:restart-for-permissions', async () => {
    const { response } = await dialog.showMessageBox(mainWindow, {
      type: 'question', title: 'Restart InterviewOverlay?',
      message: 'Restart to apply macOS permission changes?',
      detail: 'Saved settings and API keys are kept. Recording will stop, and the current unsaved conversation and captured context will be cleared.',
      buttons: ['Cancel', 'Restart'], defaultId: 0, cancelId: 0, noLink: true
    });
    if (response !== 1) return false;
    app.relaunch();
    app.quit();
    return true;
  });
  ipcMain.handle('ocr:capture', async () => {
    await controls.run('captureScreen');
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
  ipcMain.handle('window:state', () => windowManager.getState());
  ipcMain.handle('controls:failures', () => controls.failures());
  ipcMain.handle('controls:run', async (_event, action: string, query?: string) => {
    const allowed = ['chat', 'submitChat', 'askAi', 'captureScreen', 'toggleRecording',
      'toggleInteract', 'cancelStream', 'resetAll', 'hideOverlay', 'exitTyping'];
    if (!allowed.includes(action)) throw new Error('Unknown control');
    if (typeof query === 'string' && action === 'submitChat') aiManager.setExtraContext(query);
    await controls.run(action);
  });

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
