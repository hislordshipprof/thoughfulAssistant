export interface CaptureOptions {
  captureMicrophone: boolean;
  captureSystemAudio: boolean;
  localSpeech?: boolean;
  speechLocale?: string;
}

export interface AudioChunk {
  samples: Buffer;
  sampleRate: number;
  channels: number;
  isLoopback: boolean;
}

export interface CaptureBackend {
  supportsLocalSpeech?: boolean;
  startCapture(system: (chunk: AudioChunk) => void, mic: (chunk: AudioChunk) => void, options?: CaptureOptions): boolean | Promise<boolean>;
  stopCapture(): unknown;
  isCapturing(): boolean;
  on?(event: string, callback: (...args: any[]) => void): unknown;
}
