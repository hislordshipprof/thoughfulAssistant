export interface AudioState {
  isRecording: boolean;
  isStarting: boolean;
  microphone: boolean;
  systemAudio: boolean;
}
export interface AudioLevel { source: 'mic' | 'system'; level: number }
export interface ScreenState { busy: boolean; message: string }
export interface CaptureDisplay { id: string; label: string }
export type ScreenPermissionStatus = 'granted' | 'needs-approval' | 'restricted' | 'not-required';
export interface ScreenPermissionState { status: ScreenPermissionStatus; appVersion: string }
