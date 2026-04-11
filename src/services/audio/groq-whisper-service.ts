import { EventEmitter } from 'events';
import { AudioRingBuffer } from './audio-buffer';
import { TranscriptionEvent } from './transcription-service';

interface SourceState {
  buffer: AudioRingBuffer;
  chunkTimer: ReturnType<typeof setInterval> | null;
  audioChunkCount: number;
}

/**
 * Groq Whisper batch STT provider.
 *
 * Uses Groq's whisper-large-v3-turbo model via REST API.
 * 216x real-time speed means a 3-second chunk returns in ~14ms.
 * Much faster than OpenAI Whisper (~1-2s per chunk).
 *
 * Batch-only (no WebSocket), so we chunk audio into 3-second segments.
 * At $0.04/hour, this is very cost-effective.
 */
export class GroqWhisperService extends EventEmitter {
  private sources: Record<'system' | 'mic', SourceState>;
  private apiKey: string;
  private stopped = false;

  // Chunk interval — send audio every 3 seconds
  private readonly CHUNK_INTERVAL_MS = 2500;
  // Minimum samples to bother sending (500ms at 24kHz)
  private readonly MIN_SAMPLES = 12000;
  // Segments with no_speech_prob above this are discarded (Whisper hallucination filter)
  private readonly NO_SPEECH_THRESHOLD = 0.4;
  // RMS energy below this = silence, skip API call entirely (Int16 range: 0–32767)
  // 150 filters out ambient room noise that causes Whisper "Thank you" hallucinations
  private readonly SILENCE_RMS_THRESHOLD = 150;
  // Known Whisper hallucination phrases on near-silence audio
  private readonly HALLUCINATION_PHRASES = new Set([
    'thank you',
    'thank you.',
    'thanks.',
    'thanks for watching.',
    'thanks for watching',
    'bye.',
    'bye',
    'the end.',
    'the end',
    'subscribe',
    'i\'m sorry.',
  ]);

  constructor(apiKey: string) {
    super();
    this.apiKey = apiKey;
    this.sources = {
      system: this.createSourceState(),
      mic: this.createSourceState(),
    };
  }

  private createSourceState(): SourceState {
    return {
      buffer: new AudioRingBuffer(24000 * 10), // 10s buffer
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
      // Flush remaining buffered audio before clearing
      const remaining = state.buffer.available();
      if (remaining >= this.MIN_SAMPLES) {
        const samples = state.buffer.drain();
        this.transcribeChunk(samples, source).catch(err => {
          console.warn(`[groq-whisper:${source}] Final flush error:`, err.message);
        });
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

    state.chunkTimer = setInterval(() => {
      if (this.stopped) return;

      const available = state.buffer.available();
      if (available < this.MIN_SAMPLES) return;

      const samples = state.buffer.drain();
      this.transcribeChunk(samples, source).catch(err => {
        console.error(`[groq-whisper:${source}] Unhandled chunk error:`, err.message);
      });
    }, this.CHUNK_INTERVAL_MS);
  }

  private rmsEnergy(samples: Int16Array): number {
    let sum = 0;
    for (let i = 0; i < samples.length; i++) {
      sum += samples[i] * samples[i];
    }
    return Math.sqrt(sum / samples.length);
  }

  private async transcribeChunk(samples: Int16Array, source: 'system' | 'mic'): Promise<void> {
    if (samples.length === 0) return;

    // Skip silence — don't waste API calls on noise that Whisper will hallucinate on
    const rms = this.rmsEnergy(samples);
    console.log(`[groq-whisper:${source}] chunk: ${samples.length} samples, rms=${rms.toFixed(1)}, threshold=${this.SILENCE_RMS_THRESHOLD}`);
    if (rms < this.SILENCE_RMS_THRESHOLD) {
      return;
    }
    console.log(`[groq-whisper:${source}] RMS passed, sending to API...`);

    try {
      const wavBuffer = AudioRingBuffer.toWavBlob(samples, 24000);

      // Use FormData via fetch — Groq API is OpenAI-compatible
      const formData = new FormData();
      const blob = new Blob([wavBuffer], { type: 'audio/wav' });
      formData.append('file', blob, 'audio.wav');
      formData.append('model', 'whisper-large-v3-turbo');
      formData.append('response_format', 'verbose_json');
      formData.append('language', 'en');

      const resp = await fetch('https://api.groq.com/openai/v1/audio/transcriptions', {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${this.apiKey}`,
        },
        body: formData,
      });

      if (!resp.ok) {
        const errText = await resp.text();
        console.error(`[groq-whisper:${source}] API error ${resp.status}:`, errText);
        this.emit('error', new Error(`Groq API ${resp.status}: ${errText.slice(0, 200)}`));
        return;
      }

      const result = await resp.json() as {
        text?: string;
        segments?: Array<{ text: string; no_speech_prob: number }>;
      };

      // Filter segments by no_speech_prob to discard Whisper hallucinations on silence
      const segments = result.segments || [];
      const speechSegments = segments.filter(s => s.no_speech_prob < this.NO_SPEECH_THRESHOLD);

      if (speechSegments.length === 0) return;

      const text = speechSegments.map(s => s.text.trim()).join(' ').trim();

      // Filter known Whisper hallucination phrases (common on near-silence audio)
      if (this.HALLUCINATION_PHRASES.has(text.toLowerCase())) {
        console.log(`[groq-whisper:${source}] Filtered hallucination: "${text}"`);
        return;
      }

      if (text) {
        console.log(`[groq-whisper:${source}] transcribed: "${text.substring(0, 80)}${text.length > 80 ? '...' : ''}"`);
        this.emit('transcription', {
          text,
          isFinal: true,
          source
        } satisfies TranscriptionEvent);
      }
    } catch (err: any) {
      console.error(`[groq-whisper:${source}] Error:`, err.message);
      this.emit('error', err);
    }
  }

  getMode(): string {
    return 'groq-whisper';
  }
}
