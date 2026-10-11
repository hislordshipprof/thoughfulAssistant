import { EventEmitter } from 'events';
import { AudioRingBuffer } from './audio-buffer';
import { TranscriptionEvent } from './transcription-service';

interface SourceState {
  buffer: AudioRingBuffer;
  chunkTimer: ReturnType<typeof setInterval> | null;
  audioChunkCount: number;
}

/**
 * Google Cloud Speech-to-Text batch provider.
 *
 * Uses the v1 REST API (speech:recognize) with LINEAR16 audio.
 * Sends chunked audio every 3 seconds as base64-encoded PCM in a JSON body.
 *
 * Requires a Google Cloud API key + project ID.
 * Note: Google STT uses 16kHz sample rate, so we resample from 24kHz.
 */
export class GoogleSttService extends EventEmitter {
  private sources: Record<'system' | 'mic', SourceState>;
  private apiKey: string;
  private projectId: string;
  private stopped = false;

  private readonly CHUNK_INTERVAL_MS = 3000;
  // Minimum samples to send (500ms at 24kHz)
  private readonly MIN_SAMPLES = 12000;

  constructor(apiKey: string, projectId: string) {
    super();
    this.apiKey = apiKey;
    this.projectId = projectId;
    this.sources = {
      system: this.createSourceState(),
      mic: this.createSourceState(),
    };
  }

  private createSourceState(): SourceState {
    return {
      buffer: new AudioRingBuffer(24000 * 10),
      chunkTimer: null,
      audioChunkCount: 0,
    };
  }

  async start(): Promise<void> {
    this.stopped = false;
    for (const source of ['system', 'mic'] as const) {
      this.startChunking(source);
    }
    this.emit('connected', 'system');
    this.emit('connected', 'mic');
  }

  stop(): void {
    this.stopped = true;
    for (const source of ['system', 'mic'] as const) {
      const state = this.sources[source];
      if (state.chunkTimer) {
        clearInterval(state.chunkTimer);
        state.chunkTimer = null;
      }
      state.buffer.clear();
    }
  }

  sendAudio(samples: Int16Array, source: 'system' | 'mic'): void {
    this.sources[source].buffer.write(samples);
    this.sources[source].audioChunkCount++;
  }

  private startChunking(source: 'system' | 'mic'): void {
    const state = this.sources[source];
    if (state.chunkTimer) return;

    state.chunkTimer = setInterval(async () => {
      if (this.stopped) return;

      const available = state.buffer.available();
      if (available < this.MIN_SAMPLES) return;

      const samples = state.buffer.drain();
      await this.transcribeChunk(samples, source);
    }, this.CHUNK_INTERVAL_MS);
  }

  /** Downsample from 24kHz to 16kHz (Google STT expects 16kHz) */
  private downsample(samples: Int16Array, fromRate: number, toRate: number): Int16Array {
    if (fromRate === toRate) return samples;
    const ratio = fromRate / toRate;
    const newLength = Math.floor(samples.length / ratio);
    const result = new Int16Array(newLength);
    for (let i = 0; i < newLength; i++) {
      const srcIdx = Math.floor(i * ratio);
      result[i] = samples[srcIdx];
    }
    return result;
  }

  private async transcribeChunk(samples: Int16Array, source: 'system' | 'mic'): Promise<void> {
    if (samples.length === 0) return;

    try {
      // Downsample 24kHz → 16kHz for Google STT
      const resampled = this.downsample(samples, 24000, 16000);

      // Convert to base64
      const bytes = new Uint8Array(resampled.buffer, resampled.byteOffset, resampled.byteLength);
      let binary = '';
      for (let i = 0; i < bytes.length; i++) {
        binary += String.fromCharCode(bytes[i]);
      }
      const audioBase64 = btoa(binary);

      const body = {
        config: {
          encoding: 'LINEAR16',
          sampleRateHertz: 16000,
          languageCode: 'en-US',
        },
        audio: {
          content: audioBase64,
        },
      };

      const url = `https://speech.googleapis.com/v1/speech:recognize?key=${encodeURIComponent(this.apiKey)}`;
      const resp = await fetch(url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-goog-user-project': this.projectId,
        },
        body: JSON.stringify(body),
      });

      if (!resp.ok) {
        const errText = await resp.text();
        console.error(`[google-stt:${source}] API error ${resp.status}:`, errText);
        return;
      }

      const result = await resp.json() as {
        results?: Array<{
          alternatives?: Array<{ transcript?: string; confidence?: number }>;
        }>;
      };

      const text = result.results?.[0]?.alternatives?.[0]?.transcript?.trim();

      if (text) {
        this.emit('transcription', {
          text,
          isFinal: true,
          source,
        } satisfies TranscriptionEvent);
      }
    } catch (err: any) {
      console.error(`[google-stt:${source}] Error:`, err.message);
      this.emit('error', err);
    }
  }

  getMode(): string {
    return 'google-stt';
  }
}
