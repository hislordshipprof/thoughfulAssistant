import { contextBridge, ipcRenderer } from 'electron';

const electronAPI = {
  getAudioStatus: () => ipcRenderer.invoke('audio:status'),
  listDisplays: () => ipcRenderer.invoke('screen:displays'),
  getScreenPermission: () => ipcRenderer.invoke('screen:permission-status'),
  requestScreenPermission: () => ipcRenderer.invoke('screen:permission-request'),
  openScreenPermissionSettings: () => ipcRenderer.invoke('screen:permission-settings'),
  restartForPermissions: () => ipcRenderer.invoke('app:restart-for-permissions'),
  onAudioStatus: (callback: (status: any) => void) => {
    const handler = (_event: any, status: any) => callback(status);
    ipcRenderer.on('audio:status', handler);
    return () => ipcRenderer.removeListener('audio:status', handler);
  },
  onAudioLevel: (callback: (level: any) => void) => {
    const handler = (_event: any, level: any) => callback(level);
    ipcRenderer.on('audio:level', handler);
    return () => ipcRenderer.removeListener('audio:level', handler);
  },
  onAudioError: (callback: (error: string) => void) => {
    const handler = (_event: any, error: string) => callback(error);
    ipcRenderer.on('audio:error', handler);
    return () => ipcRenderer.removeListener('audio:error', handler);
  },
  onScreenState: (callback: (state: any) => void) => {
    const handler = (_event: any, state: any) => callback(state);
    ipcRenderer.on('screen:state', handler);
    return () => ipcRenderer.removeListener('screen:state', handler);
  },
  platform: process.platform,
  getWindowState: () => ipcRenderer.invoke('window:state'),
  getShortcutFailures: () => ipcRenderer.invoke('controls:failures'),
  runControl: (action: string, query?: string) => ipcRenderer.invoke('controls:run', action, query),
  onWindowState: (callback: (state: any) => void) => {
    const handler = (_event: any, state: any) => callback(state);
    ipcRenderer.on('window:state', handler);
    return () => ipcRenderer.removeListener('window:state', handler);
  },
  // AI
  onAiStarted: (callback: () => void) => {
    const handler = () => callback();
    ipcRenderer.on('ai:started', handler);
    return () => ipcRenderer.removeListener('ai:started', handler);
  },
  onAiCancelled: (callback: () => void) => {
    const handler = () => callback();
    ipcRenderer.on('ai:cancelled', handler);
    return () => ipcRenderer.removeListener('ai:cancelled', handler);
  },
  askAi: (transcript: string, ocrText: string, query?: string) =>
    ipcRenderer.invoke('ai:ask', transcript, ocrText, query),
  cancelAiStream: () => ipcRenderer.invoke('ai:cancel'),
  getOllamaStatus: (baseUrl?: string) => ipcRenderer.invoke('ai:ollama-status', baseUrl),
  setExtraContext: (text: string) => ipcRenderer.invoke('ai:context', text),
  onAiToken: (callback: (token: string) => void) => {
    const handler = (_event: any, token: string) => callback(token);
    ipcRenderer.on('ai:token', handler);
    return () => ipcRenderer.removeListener('ai:token', handler);
  },
  onAiDone: (callback: (response: string) => void) => {
    const handler = (_event: any, response: string) => callback(response);
    ipcRenderer.on('ai:done', handler);
    return () => ipcRenderer.removeListener('ai:done', handler);
  },
  onAiError: (callback: (error: string) => void) => {
    const handler = (_event: any, error: string) => callback(error);
    ipcRenderer.on('ai:error', handler);
    return () => ipcRenderer.removeListener('ai:error', handler);
  },

  // Transcript
  onTranscriptUpdate: (callback: (entries: any[]) => void) => {
    const handler = (_event: any, entries: any[]) => callback(entries);
    ipcRenderer.on('transcript:update', handler);
    return () => ipcRenderer.removeListener('transcript:update', handler);
  },

  // Hotkeys
  onHotkeyAction: (callback: (action: string) => void) => {
    const handler = (_event: any, action: string) => callback(action);
    ipcRenderer.on('hotkey:action', handler);
    return () => ipcRenderer.removeListener('hotkey:action', handler);
  },

  // Audio
  toggleRecording: () => ipcRenderer.invoke('audio:toggle'),
  getRecordingState: () => ipcRenderer.invoke('audio:state'),

  // OCR
  captureScreen: () => ipcRenderer.invoke('ocr:capture'),
  getLastOcrText: () => ipcRenderer.invoke('ocr:lastText'),
  clearScreenshots: () => ipcRenderer.invoke('ocr:clear'),
  removeScreenshot: (index: number) => ipcRenderer.invoke('ocr:remove', index),
  onScreenshots: (callback: (dataUrls: string[]) => void) => {
    const handler = (_event: any, dataUrls: string[]) => callback(dataUrls);
    ipcRenderer.on('ocr:screenshots', handler);
    return () => ipcRenderer.removeListener('ocr:screenshots', handler);
  },

  // Config
  getConfig: (key?: string) => ipcRenderer.invoke('config:get', key),
  setConfig: (key: string, value: any) => ipcRenderer.invoke('config:set', key, value),

  // Window
  setClickThrough: (enable: boolean) => ipcRenderer.invoke('window:clickThrough', enable),
  setOpacity: (opacity: number) => ipcRenderer.invoke('window:opacity', opacity),
  setFocusable: (enable: boolean) => ipcRenderer.invoke('window:focusable', enable),

  // Session
  resetSession: () => ipcRenderer.invoke('session:reset'),

  // Window size
  setWindowSize: (w: number, h: number) => ipcRenderer.invoke('window:size', w, h),

  // Clipboard — write without stealing focus
  copyToClipboard: (text: string) => ipcRenderer.invoke('clipboard:write', text),

  // Status
  onStatusUpdate: (callback: (status: any) => void) => {
    const handler = (_event: any, status: any) => callback(status);
    ipcRenderer.on('status:update', handler);
    return () => ipcRenderer.removeListener('status:update', handler);
  },

  // Typing mode
  onTypingEvent: (callback: (event: any) => void) => {
    const handler = (_event: any, event: any) => callback(event);
    ipcRenderer.on('typing:event', handler);
    return () => ipcRenderer.removeListener('typing:event', handler);
  },
  onTypingMode: (callback: (active: boolean) => void) => {
    const handler = (_event: any, active: boolean) => callback(active);
    ipcRenderer.on('typing:mode', handler);
    return () => ipcRenderer.removeListener('typing:mode', handler);
  },
  onExtraContextClear: (callback: () => void) => {
    const handler = () => callback();
    ipcRenderer.on('extra-context:clear', handler);
    return () => ipcRenderer.removeListener('extra-context:clear', handler);
  }
};

contextBridge.exposeInMainWorld('electronAPI', electronAPI);

export type ElectronAPI = typeof electronAPI;

// ─── Smart hit-test: auto-toggle click-through based on mouse position ───
// When mouse is over a UI element (pointer-events: all) → capture clicks
// When mouse is over transparent area (pointer-events: none) → pass through to apps below

let isCurrentlyIgnoring: boolean | null = null;
ipcRenderer.on('window:hit-test-reset', () => { isCurrentlyIgnoring = null; });

function setIgnore(ignore: boolean) {
  if (ignore === isCurrentlyIgnoring) return;
  isCurrentlyIgnoring = ignore;

  if (ignore) {
    ipcRenderer.send('set-ignore-mouse-events', true, { forward: true });
  } else {
    ipcRenderer.send('set-ignore-mouse-events', false);
  }
}

window.addEventListener('DOMContentLoaded', () => {
  document.addEventListener('mousemove', (event) => {
    const target = event.target as Element;
    // If target is html, body, or #root — we're over transparent area
    const isOverEmpty =
      target === document.documentElement ||
      target === document.body ||
      target?.id === 'root';

    setIgnore(isOverEmpty);
  });

  document.addEventListener('mouseleave', () => {
    setIgnore(true);
  });
});
