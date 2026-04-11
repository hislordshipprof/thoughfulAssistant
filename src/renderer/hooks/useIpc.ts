import { useEffect, useCallback } from 'react';

declare global {
  interface Window {
    electronAPI: {
      askAi: (transcript: string, ocrText: string, query?: string) => Promise<void>;
      cancelAiStream: () => Promise<void>;
      setExtraContext: (text: string) => Promise<boolean>;
      onAiToken: (callback: (token: string) => void) => () => void;
      onAiDone: (callback: (response: string) => void) => () => void;
      onAiError: (callback: (error: string) => void) => () => void;
      onTranscriptUpdate: (callback: (entries: any[]) => void) => () => void;
      onHotkeyAction: (callback: (action: string) => void) => () => void;
      toggleRecording: () => Promise<boolean>;
      getRecordingState: () => Promise<boolean>;
      captureScreen: () => Promise<string>;
      getLastOcrText: () => Promise<string>;
      clearScreenshots: () => Promise<boolean>;
      removeScreenshot: (index: number) => Promise<boolean>;
      onScreenshots: (callback: (dataUrls: string[]) => void) => () => void;
      getConfig: (key?: string) => Promise<any>;
      setConfig: (key: string, value: any) => Promise<boolean>;
      toggleStealth: () => Promise<boolean>;
      setClickThrough: (enable: boolean) => Promise<boolean>;
      setOpacity: (opacity: number) => Promise<boolean>;
      setFocusable: (enable: boolean) => Promise<boolean>;
      resetSession: () => Promise<boolean>;
      setWindowSize: (w: number, h: number) => Promise<boolean>;
      pickAndExtractFile: (purpose: string) => Promise<{ success: boolean; text: string; fileName: string; error?: string } | null>;
      copyToClipboard: (text: string) => Promise<boolean>;
      moveWindowBy: (dx: number, dy: number) => Promise<boolean>;
      setDragging: (active: boolean) => void;
      onStatusUpdate: (callback: (status: any) => void) => () => void;
      onTypingEvent: (callback: (event: any) => void) => () => void;
      onTypingMode: (callback: (active: boolean) => void) => () => void;
      onExtraContextClear: (callback: () => void) => () => void;
    };
  }
}

export function useIpc() {
  return window.electronAPI;
}

export function useIpcEvent(
  channel: 'onAiToken' | 'onAiDone' | 'onAiError' | 'onTranscriptUpdate' | 'onHotkeyAction' | 'onStatusUpdate' | 'onScreenshots' | 'onTypingEvent' | 'onTypingMode' | 'onExtraContextClear',
  callback: (data: any) => void
): void {
  useEffect(() => {
    const api = window.electronAPI;
    if (!api || !api[channel]) return;
    const cleanup = api[channel](callback);
    return cleanup;
  }, [channel, callback]);
}
