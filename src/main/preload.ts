import { contextBridge, ipcRenderer } from 'electron';

const electronAPI = {
  // AI
  askAi: (transcript: string, ocrText: string, query?: string) =>
    ipcRenderer.invoke('ai:ask', transcript, ocrText, query),
  cancelAiStream: () => ipcRenderer.invoke('ai:cancel'),
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
  toggleStealth: () => ipcRenderer.invoke('window:toggleStealth'),
  setClickThrough: (enable: boolean) => ipcRenderer.invoke('window:clickThrough', enable),
  setOpacity: (opacity: number) => ipcRenderer.invoke('window:opacity', opacity),
  setFocusable: (enable: boolean) => ipcRenderer.invoke('window:focusable', enable),

  // Session
  resetSession: () => ipcRenderer.invoke('session:reset'),

  // Window size
  setWindowSize: (w: number, h: number) => ipcRenderer.invoke('window:size', w, h),

  // Clipboard — write without stealing focus
  copyToClipboard: (text: string) => ipcRenderer.invoke('clipboard:write', text),

  // File upload — pick file and extract text (for resume/JD upload)
  pickAndExtractFile: (purpose: string) => ipcRenderer.invoke('file:pick-and-extract', purpose),

  // Status
  onStatusUpdate: (callback: (status: any) => void) => {
    const handler = (_event: any, status: any) => callback(status);
    ipcRenderer.on('status:update', handler);
    return () => ipcRenderer.removeListener('status:update', handler);
  },

  // Typing mode
  toggleTypingMode: (forceState?: boolean) => ipcRenderer.invoke('typing:toggle', forceState),
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
  },

  // Window drag — move overlay by delta
  moveWindowBy: (dx: number, dy: number) => ipcRenderer.invoke('window:move', dx, dy),

  // Drag lock — keep mouse events flowing during header drag
  setDragging: (active: boolean) => {
    isDragging = active;
    if (active) {
      // Force capture mouse events so drag doesn't break
      setIgnore(false);
    }
  }
};

contextBridge.exposeInMainWorld('electronAPI', electronAPI);

export type ElectronAPI = typeof electronAPI;

// ─── Smart hit-test: auto-toggle click-through based on mouse position ───
// When mouse is over a UI element (pointer-events: all) → capture clicks
// When mouse is over transparent area (pointer-events: none) → pass through to apps below

let isCurrentlyIgnoring = true;
let isDragging = false;

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
    // During drag, always capture mouse events — don't toggle
    if (isDragging) {
      setIgnore(false);
      return;
    }

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
