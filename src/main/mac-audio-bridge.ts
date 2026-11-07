// macOS audio-capture bridge.
//
// The Windows path uses a native WASAPI addon that produces Int16 PCM
// chunks (24 kHz mono) from both system loopback and the microphone.
// On macOS we don't have that addon, so we drive mic capture from the
// renderer with Web Audio (getUserMedia → AudioWorklet) and shuttle the
// chunks over IPC to the main process. System-audio loopback still
// requires a virtual device like BlackHole (treated as the mic).
//
// This class exposes the same shape AudioManager expects of its NativeAddon
// — startCapture(loopbackCb, micCb), stopCapture(), isCapturing() — so the
// rest of the pipeline is unchanged.
import { BrowserWindow, ipcMain } from 'electron';

type ChunkCallback = (chunk: {
  samples: Buffer;
  sampleRate: number;
  channels: number;
  isLoopback: boolean;
}) => void;

export class MacAudioBridge {
  private window: BrowserWindow;
  private running = false;
  private micCb: ChunkCallback | null = null;
  private handler: ((event: any, payload: { samples: ArrayBuffer }) => void) | null = null;

  constructor(window: BrowserWindow) {
    this.window = window;
  }

  startCapture(_loopbackCb: ChunkCallback, micCb: ChunkCallback): boolean {
    if (this.running) return true;
    this.micCb = micCb;

    this.handler = (_event, payload) => {
      if (!this.micCb || !payload?.samples) return;
      const buf = Buffer.from(payload.samples);
      this.micCb({
        samples: buf,
        sampleRate: 24000,
        channels: 1,
        isLoopback: false
      });
    };
    ipcMain.on('mac-audio:chunk', this.handler);

    // Ask the renderer to begin capturing. Fire-and-forget — the renderer
    // will report back via IPC with either audio chunks or an error.
    this.window.webContents.send('mac-audio:start');
    this.running = true;
    console.log('[mac-audio] Bridge started — mic capture requested from renderer');
    return true;
  }

  stopCapture(): boolean {
    if (!this.running) return true;
    this.window.webContents.send('mac-audio:stop');
    if (this.handler) {
      ipcMain.removeListener('mac-audio:chunk', this.handler);
      this.handler = null;
    }
    this.micCb = null;
    this.running = false;
    console.log('[mac-audio] Bridge stopped');
    return true;
  }

  isCapturing(): boolean {
    return this.running;
  }

  getCaptureDevices(): any[] {
    return [];
  }
}
