import { useEffect, useCallback } from 'react';

declare global {
  interface Window {
    electronAPI: {
      askAi: (transcript: string, ocrText: string, query?: string) => Promise<void>;
      cancelAiStream: () => Promise<void>;
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
      setClickThrough: (enable: boolean) => Promise<boolean>;
      setOpacity: (opacity: number) => Promise<boolean>;
      resetSession: () => Promise<boolean>;
      setWindowSize: (w: number, h: number) => Promise<boolean>;
      onStatusUpdate: (callback: (status: any) => void) => () => void;
    };
  }
}

export function useIpc() {
  return window.electronAPI;
}

export function useIpcEvent(
  channel: 'onAiToken' | 'onAiDone' | 'onAiError' | 'onTranscriptUpdate' | 'onHotkeyAction' | 'onStatusUpdate' | 'onScreenshots',
  callback: (data: any) => void
): void {
  useEffect(() => {
    const api = window.electronAPI;
    if (!api || !api[channel]) return;
    const cleanup = api[channel](callback);
    return cleanup;
  }, [channel, callback]);
}
