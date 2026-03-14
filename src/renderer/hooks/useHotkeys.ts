import { useEffect, useCallback } from 'react';
import { useIpcEvent } from './useIpc';

type HotkeyAction =
  | 'toggleOverlay'
  | 'askAi'
  | 'captureScreen'
  | 'toggleRecording'
  | 'toggleInteract'
  | 'cancelStream'
  | 'openSettings'
  | 'resetAll'
  | 'scrollUp'
  | 'scrollDown';

export function useHotkeys(handlers: Partial<Record<HotkeyAction, () => void>>): void {
  const handleAction = useCallback((action: string) => {
    const handler = handlers[action as HotkeyAction];
    if (handler) handler();
  }, [handlers]);

  useIpcEvent('onHotkeyAction', handleAction);
}
