import { useEffect, useCallback } from 'react';
import type { WindowState } from '../../shared/controls';
import type { AudioState, AudioLevel, ScreenState, CaptureDisplay, ScreenPermissionState } from '../../shared/media';

declare global {
  interface Window {
    electronAPI: {
      getAudioStatus: () => Promise<AudioState>;
      listDisplays: () => Promise<CaptureDisplay[]>;
      getScreenPermission: () => Promise<ScreenPermissionState>;
      requestScreenPermission: () => Promise<ScreenPermissionState>;
      openScreenPermissionSettings: () => Promise<void>;
      restartForPermissions: () => Promise<boolean>;
      onAudioStatus: (callback: (status: AudioState) => void) => () => void;
      onAudioLevel: (callback: (level: AudioLevel) => void) => () => void;
      onAudioError: (callback: (error: string) => void) => () => void;
      onScreenState: (callback: (state: ScreenState) => void) => () => void;
      platform: string;
      getWindowState: () => Promise<WindowState>;
      getShortcutFailures: () => Promise<string[]>;
      runControl: (action: string, query?: string) => Promise<void>;
      onWindowState: (callback: (state: WindowState) => void) => () => void;
      askAi: (transcript: string, ocrText: string, query?: string) => Promise<void>;
      cancelAiStream: () => Promise<void>;
      setExtraContext: (text: string) => Promise<boolean>;
      getOllamaStatus: (baseUrl?: string) => Promise<{
        connected: boolean;
        version?: string;
        models: Array<{
          name: string;
          model: string;
          size: number;
          details?: { family?: string; parameterSize?: string; quantizationLevel?: string; contextLength?: number };
        }>;
        error?: string;
      }>;
      onAiToken: (callback: (token: string) => void) => () => void;
      onAiStarted: (callback: () => void) => () => void;
      onAiCancelled: (callback: () => void) => () => void;
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
      setFocusable: (enable: boolean) => Promise<boolean>;
      resetSession: () => Promise<boolean>;
      setWindowSize: (w: number, h: number) => Promise<boolean>;
      copyToClipboard: (text: string) => Promise<boolean>;
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
  channel: 'onAudioStatus' | 'onAudioLevel' | 'onAudioError' | 'onScreenState' | 'onAiToken' | 'onAiStarted' | 'onAiCancelled' | 'onAiDone' | 'onAiError' | 'onTranscriptUpdate' | 'onHotkeyAction' | 'onStatusUpdate' | 'onWindowState' | 'onScreenshots' | 'onTypingEvent' | 'onTypingMode' | 'onExtraContextClear',
  callback: (data: any) => void
): void {
  useEffect(() => {
    const api = window.electronAPI;
    if (!api || !api[channel]) return;
    const subscribe = api[channel] as (handler: (data: any) => void) => () => void;
    const cleanup = subscribe(callback);
    return cleanup;
  }, [channel, callback]);
}
