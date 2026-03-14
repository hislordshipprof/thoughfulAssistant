import { EventEmitter } from 'events';
import { TranscriptionService, TranscriptionEvent } from './transcription-service';
import { DeepgramService } from './deepgram-service';
import { GroqWhisperService } from './groq-whisper-service';
import { GoogleSttService } from './google-stt-service';
import { TranscriptStore, TranscriptEntry } from './transcript-store';
import { AudioRingBuffer } from './audio-buffer';

type TranscriptionMode = 'realtime' | 'whisper' | 'deepgram' | 'groq-whisper' | 'google-stt';

interface NativeAddon {
  startCapture(loopbackCb: (chunk: any) => void, micCb: (chunk: any) => void): boolean;
  stopCapture(): boolean;
  isCapturing(): boolean;
}

// Common interface for all STT providers
interface SttProvider extends EventEmitter {
  start(): Promise<void>;
  stop(): void;
  sendAudio(samples: Int16Array, source: 'system' | 'mic'): void;
  getMode(): string;
}

// Time gap (ms) — if no new transcription from same source within this window, next one starts a new entry
const TURN_GAP_MS = 1500;

export class AudioManager extends EventEmitter {
  private native: NativeAddon;
  private sttProvider: SttProvider | null = null;
  private transcriptStore: TranscriptStore;
  private loopbackBuffer: AudioRingBuffer;
  private micBuffer: AudioRingBuffer;
  private isRunning = false;

  // Track partial (delta) entry IDs per source
  private partialIds: Record<'system' | 'mic', string | null> = { system: null, mic: null };

  // Track the current accumulation entry per source (for merging consecutive finals)
  private accumulationIds: Record<'system' | 'mic', string | null> = { system: null, mic: null };

  // Track last source that produced a transcription (for source-change detection)
  private lastTranscriptionSource: 'system' | 'mic' | null = null;

  constructor(native: NativeAddon) {
    super();
    this.native = native;
    this.transcriptStore = new TranscriptStore(15);
    this.loopbackBuffer = new AudioRingBuffer(24000 * 60);  // 1 min at 24kHz
    this.micBuffer = new AudioRingBuffer(24000 * 60);
  }

  async start(
    apiKey: string,
    mode: TranscriptionMode = 'deepgram',
    keys?: { deepgramKey?: string; groqKey?: string; googleSttKey?: string; googleProjectId?: string }
  ): Promise<void> {
    if (this.isRunning) return;
    console.log(`[audio] Starting audio capture, transcription mode: ${mode}`);

    // Create the appropriate STT provider
    this.sttProvider = this.createProvider(mode, apiKey, keys);

    // Wire up common events
    this.sttProvider.on('speech_started', (_source: 'system' | 'mic') => {
      // Speech started — accumulation continues into current entry
    });

    this.sttProvider.on('speech_stopped', (_source: 'system' | 'mic') => {
      // Don't immediately reset accumulation — brief pauses (300ms–2s) are normal mid-sentence.
      // Turn boundaries are detected by time gap (TURN_GAP_MS) and source changes instead.
    });

    this.sttProvider.on('transcription', (event: TranscriptionEvent) => {
      this.handleTranscription(event);
    });

    this.sttProvider.on('error', (err: Error) => {
      this.emit('error', err);
    });

    this.sttProvider.on('connected', () => {
      this.emit('transcription-connected');
    });

    // Start native audio capture
    console.log('[audio] Starting native WASAPI capture...');
    const started = this.native.startCapture(
      (chunk) => this.handleLoopbackChunk(chunk),
      (chunk) => this.handleMicChunk(chunk)
    );

    if (!started) {
      console.error('[audio] Native capture failed to start');
      throw new Error('Failed to start audio capture');
    }
    console.log('[audio] Native WASAPI capture started');

    await this.sttProvider.start();
    this.isRunning = true;
    console.log('[audio] Audio pipeline fully started');
    this.emit('started');
  }

  private createProvider(
    mode: TranscriptionMode,
    apiKey: string,
    keys?: { deepgramKey?: string; groqKey?: string; googleSttKey?: string; googleProjectId?: string }
  ): SttProvider {
    switch (mode) {
      case 'deepgram': {
        const key = keys?.deepgramKey;
        if (!key) throw new Error('Deepgram API key required');
        console.log('[audio] Using Deepgram streaming STT');
        return new DeepgramService(key);
      }
      case 'groq-whisper': {
        const key = keys?.groqKey;
        if (!key) throw new Error('Groq API key required');
        console.log('[audio] Using Groq Whisper batch STT');
        return new GroqWhisperService(key);
      }
      case 'google-stt': {
        const key = keys?.googleSttKey;
        const projectId = keys?.googleProjectId;
        if (!key) throw new Error('Google STT API key required');
        if (!projectId) throw new Error('Google Cloud project ID required');
        console.log('[audio] Using Google Cloud Speech-to-Text');
        return new GoogleSttService(key, projectId);
      }
      case 'realtime':
      case 'whisper':
      default:
        console.log(`[audio] Using OpenAI ${mode} STT`);
        return new TranscriptionService(apiKey, mode as 'realtime' | 'whisper');
    }
  }

  private handleTranscription(event: TranscriptionEvent): void {
    const src = event.source;

    if (event.isFinal) {
      const text = event.text?.trim();
      if (!text) return;

      // Source changed (e.g. interviewer → you) — seal the previous source's entry
      if (this.lastTranscriptionSource && this.lastTranscriptionSource !== src) {
        this.accumulationIds[this.lastTranscriptionSource] = null;
      }
      this.lastTranscriptionSource = src;

      // If we had a partial entry for this source, finalize it
      if (this.partialIds[src]) {
        this.transcriptStore.updatePartial(this.partialIds[src]!, text, true);
        this.accumulationIds[src] = this.partialIds[src];
        this.partialIds[src] = null;
        return;
      }

      // Try to append to existing accumulation entry (merge consecutive same-source finals)
      if (this.accumulationIds[src]) {
        const existing = this.transcriptStore.getEntry(this.accumulationIds[src]!);
        if (existing && (Date.now() - existing.timestamp < TURN_GAP_MS)) {
          this.transcriptStore.appendText(this.accumulationIds[src]!, text, true);
          return;
        }
        // Entry too old or pruned — start fresh
        this.accumulationIds[src] = null;
      }

      // Check if last entry for this source is recent enough to merge
      const lastEntry = this.transcriptStore.getLastEntryForSource(src);
      if (lastEntry) {
        this.transcriptStore.appendText(lastEntry.id, text, true);
        this.accumulationIds[src] = lastEntry.id;
        return;
      }

      // Create new entry
      const entry = this.transcriptStore.add(text, src, true);
      this.accumulationIds[src] = entry.id;
    } else {
      // Delta/partial update
      if (!this.partialIds[src]) {
        const entry = this.transcriptStore.add(event.text, event.source, false);
        this.partialIds[src] = entry.id;
      } else {
        this.transcriptStore.updatePartial(this.partialIds[src]!, event.text, false);
      }
    }
  }

  stop(): void {
    if (!this.isRunning) return;

    this.native.stopCapture();
    this.sttProvider?.stop();
    this.sttProvider = null;
    this.isRunning = false;
    this.partialIds = { system: null, mic: null };
    this.accumulationIds = { system: null, mic: null };
    this.lastTranscriptionSource = null;
    this.emit('stopped');
  }

  private handleLoopbackChunk(chunk: { samples: Buffer; sampleRate: number; channels: number; isLoopback: boolean }): void {
    const samples = new Int16Array(chunk.samples.buffer, chunk.samples.byteOffset, chunk.samples.byteLength / 2);
    this.loopbackBuffer.write(samples);
    this.sttProvider?.sendAudio(samples, 'system');
  }

  private micChunkCount = 0;
  private handleMicChunk(chunk: { samples: Buffer; sampleRate: number; channels: number; isLoopback: boolean }): void {
    const samples = new Int16Array(chunk.samples.buffer, chunk.samples.byteOffset, chunk.samples.byteLength / 2);
    this.micChunkCount++;
    // Log every 100 chunks (~1s at typical rates) so we can verify mic data is flowing
    if (this.micChunkCount % 100 === 1) {
      let sum = 0;
      for (let i = 0; i < samples.length; i++) sum += samples[i] * samples[i];
      const rms = Math.sqrt(sum / samples.length);
      console.log(`[audio:mic] chunk #${this.micChunkCount}, samples=${samples.length}, rms=${rms.toFixed(1)}`);
    }
    this.micBuffer.write(samples);
    this.sttProvider?.sendAudio(samples, 'mic');
  }

  getTranscriptStore(): TranscriptStore {
    return this.transcriptStore;
  }

  getTranscript(): TranscriptEntry[] {
    return this.transcriptStore.getAll();
  }

  getTranscriptContext(): string {
    return this.transcriptStore.toContext();
  }

  isActive(): boolean {
    return this.isRunning;
  }

  setTranscriptionMode(mode: TranscriptionMode): void {
    // For OpenAI modes, we can hot-swap
    if (this.sttProvider instanceof TranscriptionService && (mode === 'realtime' || mode === 'whisper')) {
      (this.sttProvider as TranscriptionService).setMode(mode);
    }
    // For switching between provider types, need to restart
  }
}
