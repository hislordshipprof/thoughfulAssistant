import { useEffect, useCallback } from 'react';
import type { ElectronAPI } from '../../main/preload';

// Single source of truth for the preload surface — the actual type the
// preload exposes, so this never drifts from what's really available.
declare global {
  interface Window {
    electronAPI: ElectronAPI;
  }
}

// Names of the event-subscription methods (on*) the renderer may listen to.
type IpcEventChannel = {
  [K in keyof ElectronAPI]: K extends `on${string}` ? K : never;
}[keyof ElectronAPI];

export function useIpc() {
  return window.electronAPI;
}

export function useIpcEvent(
  channel: IpcEventChannel,
  callback: (data: any) => void
): void {
  useEffect(() => {
    const api = window.electronAPI;
    if (!api || !api[channel]) return;
    const cleanup = (api[channel] as (cb: (data: any) => void) => () => void)(callback);
    return cleanup;
  }, [channel, callback]);
}
