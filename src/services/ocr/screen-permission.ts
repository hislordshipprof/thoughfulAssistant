import { desktopCapturer, systemPreferences } from 'electron';
import type { ScreenPermissionStatus } from '../../shared/media';

export class ScreenPermissionError extends Error {
  readonly code = 'SCREEN_PERMISSION_REQUIRED';
  constructor(restricted = false) {
    super(restricted
      ? 'Screen recording is restricted by macOS or device management. Contact your administrator.'
      : 'Screen recording access is not approved for this app session. In Settings → Screen Capture, use Request screen access or Open macOS Settings, allow InterviewOverlay, then Restart app.');
  }
}

export function getScreenPermissionStatus(): ScreenPermissionStatus {
  if (process.platform !== 'darwin') return 'not-required';
  const status = systemPreferences.getMediaAccessStatus('screen');
  // Electron 33's screen check wraps CGPreflightScreenCaptureAccess. Unlike
  // microphone access, "denied" also includes "not requested yet".
  return status === 'granted' ? 'granted' : status === 'restricted' ? 'restricted' : 'needs-approval';
}

let pendingRequest: Promise<ScreenPermissionStatus> | null = null;

/** Explicit user action only. Requests OS consent without collecting thumbnails. */
export function requestScreenPermission(): Promise<ScreenPermissionStatus> {
  const status = getScreenPermissionStatus();
  if (status !== 'needs-approval') return Promise.resolve(status);
  if (pendingRequest) return pendingRequest;
  // This enters Electron's CGRequestScreenCaptureAccess path. Do not replace
  // it with askForMediaAccess('screen'), which Electron does not support.
  pendingRequest = (async () => {
    try {
      await desktopCapturer.getSources({ types: ['screen'], thumbnailSize: { width: 0, height: 0 }, fetchWindowIcons: false });
    } catch {
      // Rejection is expected when consent is declined or a restart is needed.
      // No source names, image data, or raw native errors leave this function.
    }
    return getScreenPermissionStatus();
  })().finally(() => { pendingRequest = null; });
  return pendingRequest;
}

export async function ensureScreenPermission(allowPrompt: boolean): Promise<void> {
  let status = getScreenPermissionStatus();
  if (status === 'needs-approval' && allowPrompt) status = await requestScreenPermission();
  if (status === 'needs-approval' || status === 'restricted') throw new ScreenPermissionError(status === 'restricted');
}
