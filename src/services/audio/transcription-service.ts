import { EventEmitter } from 'events';
import WebSocket from 'ws';
import OpenAI from 'openai';
import { AudioRingBuffer } from './audio-buffer';

export interface TranscriptionEvent {
  text: string;
  isFinal: boolean;
  source: 'system' | 'mic';
}

interface SourceConnection {
  ws: WebSocket | null;
  isConnected: boolean;
  whisperBuffer: AudioRingBuffer;
  whisperInterval: ReturnType<typeof setInterval> | null;
  audioChunkCount: number;
  commitTimer: ReturnType<typeof setInterval> | null;
  pingTimer: ReturnType<typeof setInterval> | null;
  isSpeaking: boolean;
  samplesSinceCommit: number;
  reconnectAttempts: number;
  reconnectTimer: ReturnType<typeof setTimeout> | null;
}

// VAD settings per source — mic is less sensitive to reduce speaker bleed
const VAD_CONFIG = {
  system: { threshold: 0.3, prefix_padding_ms: 300, silence_duration_ms: 300 },
  mic:    { threshold: 0.6, prefix_padding_ms: 200, silence_duration_ms: 400 },
};

// Force-commit interval (ms) to get intermediate transcriptions during long speech
const COMMIT_INTERVAL_MS = 4000;

// Minimum samples required before force-commit (100ms at 24kHz)
const MIN_COMMIT_SAMPLES = 2400;

// Ping interval to keep WebSocket alive (every 20s)
const PING_INTERVAL_MS = 20000;

// Max reconnect attempts before falling back to Whisper
const MAX_RECONNECT_ATTEMPTS = 5;

// Base delay for exponential backoff reconnect (ms)
const RECONNECT_BASE_DELAY_MS = 1000;

export class TranscriptionService extends EventEmitter {
  private sources: Record<'system' | 'mic', SourceConnection>;
  private openai: OpenAI | null = null;
  private apiKey: string;
  private mode: 'realtime' | 'whisper' = 'realtime';
  private stopped = false;

  constructor(apiKey: string, mode: 'realtime' | 'whisper' = 'realtime') {
    super();
    this.apiKey = apiKey;
    this.mode = mode;
    this.openai = new OpenAI({ apiKey });

    this.sources = {
      system: this.createSourceConnection(),
      mic: this.createSourceConnection(),
    };
  }

  private createSourceConnection(): SourceConnection {
    return {
      ws: null,
      isConnected: false,
      whisperBuffer: new AudioRingBuffer(24000 * 10),
      whisperInterval: null,
      audioChunkCount: 0,
      commitTimer: null,
      pingTimer: null,
      isSpeaking: false,
      samplesSinceCommit: 0,
      reconnectAttempts: 0,
      reconnectTimer: null,
    };
  }

  async start(): Promise<void> {
    this.stopped = false;
    if (this.mode === 'realtime') {
      await Promise.all([
        this.startRealtimeForSource('system'),
        this.startRealtimeForSource('mic'),
      ]);
    } else {
      this.startWhisperForSource('system');
      this.startWhisperForSource('mic');
    }
  }

  stop(): void {
    this.stopped = true;
    for (const source of ['system', 'mic'] as const) {
      const conn = this.sources[source];
      if (conn.ws) {
        conn.ws.close();
        conn.ws = null;
      }
      if (conn.whisperInterval) {
        clearInterval(conn.whisperInterval);
        conn.whisperInterval = null;
      }
      if (conn.commitTimer) {
        clearInterval(conn.commitTimer);
        conn.commitTimer = null;
      }
      if (conn.pingTimer) {
        clearInterval(conn.pingTimer);
        conn.pingTimer = null;
      }
      if (conn.reconnectTimer) {
        clearTimeout(conn.reconnectTimer);
        conn.reconnectTimer = null;
      }
      conn.isConnected = false;
      conn.isSpeaking = false;
      conn.samplesSinceCommit = 0;
      conn.reconnectAttempts = 0;
    }
  }

  sendAudio(samples: Int16Array, source: 'system' | 'mic'): void {
    const conn = this.sources[source];

    if (conn.ws && conn.isConnected) {
      const base64 = AudioRingBuffer.toBase64(samples);
      conn.ws.send(JSON.stringify({
        type: 'input_audio_buffer.append',
        audio: base64
      }));
      conn.audioChunkCount++;
      conn.samplesSinceCommit += samples.length;
      if (conn.audioChunkCount % 100 === 1) {
        console.log(`[transcription:${source}] Sending audio chunk #${conn.audioChunkCount} (${samples.length} samples)`);
      }
    } else if (conn.whisperInterval) {
      conn.whisperBuffer.write(samples);
      conn.audioChunkCount++;
      if (conn.audioChunkCount % 100 === 1) {
        console.log(`[transcription:${source}] Buffering for Whisper chunk #${conn.audioChunkCount} (${samples.length} samples, buffer=${conn.whisperBuffer.available()})`);
      }
    }
  }

  private async startRealtimeForSource(source: 'system' | 'mic'): Promise<void> {
    if (this.stopped) return;

    const url = 'wss://api.openai.com/v1/realtime?intent=transcription';
    console.log(`[transcription:${source}] Connecting to Realtime API...`);

    const conn = this.sources[source];
    const vad = VAD_CONFIG[source];

    conn.ws = new WebSocket(url, {
      headers: {
        'Authorization': `Bearer ${this.apiKey}`,
        'OpenAI-Beta': 'realtime=v1'
      }
    });

    conn.ws.on('open', () => {
      conn.isConnected = true;
      conn.reconnectAttempts = 0; // Reset on successful connect
      console.log(`[transcription:${source}] WebSocket connected, sending session config (vad threshold=${vad.threshold}, silence=${vad.silence_duration_ms}ms)...`);

      conn.ws!.send(JSON.stringify({
        type: 'transcription_session.update',
        session: {
          input_audio_format: 'pcm16',
          input_audio_transcription: {
            model: 'gpt-4o-transcribe',
            language: 'en'
          },
          turn_detection: {
            type: 'server_vad',
            threshold: vad.threshold,
            prefix_padding_ms: vad.prefix_padding_ms,
            silence_duration_ms: vad.silence_duration_ms
          }
        }
      }));

      // Start ping keepalive
      this.startPingTimer(source);

      this.emit('connected', source);
    });

    // Handle pong responses (WebSocket-level ping/pong)
    conn.ws.on('pong', () => {
      // Connection is alive
    });

    conn.ws.on('message', (data: WebSocket.Data) => {
      try {
        const event = JSON.parse(data.toString());
        this.handleRealtimeEvent(event, source);
      } catch {
        // Ignore parse errors
      }
    });

    conn.ws.on('close', (code: number, reason: Buffer) => {
      const reasonStr = reason?.toString() || 'no reason';
      console.log(`[transcription:${source}] WebSocket closed: code=${code}, reason=${reasonStr}`);
      conn.isConnected = false;
      this.clearCommitTimer(source);
      this.clearPingTimer(source);
      this.emit('disconnected', source);

      // Auto-reconnect with exponential backoff
      if (!this.stopped && conn.reconnectAttempts < MAX_RECONNECT_ATTEMPTS) {
        const delay = RECONNECT_BASE_DELAY_MS * Math.pow(2, conn.reconnectAttempts);
        conn.reconnectAttempts++;
        console.log(`[transcription:${source}] Reconnecting in ${delay}ms (attempt ${conn.reconnectAttempts}/${MAX_RECONNECT_ATTEMPTS})...`);
        conn.reconnectTimer = setTimeout(() => {
          this.startRealtimeForSource(source);
        }, delay);
      } else if (!this.stopped) {
        console.log(`[transcription:${source}] Max reconnect attempts reached, falling back to Whisper`);
        this.startWhisperForSource(source);
      }
    });

    conn.ws.on('error', (err: Error) => {
      console.error(`[transcription:${source}] WebSocket error:`, err.message);
      this.emit('error', err);
    });
  }

  /** Ping keepalive to prevent idle timeout disconnects */
  private startPingTimer(source: 'system' | 'mic'): void {
    const conn = this.sources[source];
    this.clearPingTimer(source);

    conn.pingTimer = setInterval(() => {
      if (conn.ws && conn.isConnected && conn.ws.readyState === WebSocket.OPEN) {
        conn.ws.ping();
      }
    }, PING_INTERVAL_MS);
  }

  private clearPingTimer(source: 'system' | 'mic'): void {
    const conn = this.sources[source];
    if (conn.pingTimer) {
      clearInterval(conn.pingTimer);
      conn.pingTimer = null;
    }
  }

  /** Start a periodic commit timer to force intermediate transcriptions during long speech */
  private startCommitTimer(source: 'system' | 'mic'): void {
    const conn = this.sources[source];
    if (conn.commitTimer) return; // Already running

    conn.commitTimer = setInterval(() => {
      if (conn.ws && conn.isConnected && conn.isSpeaking) {
        // Only commit if we have enough audio since last commit
        if (conn.samplesSinceCommit >= MIN_COMMIT_SAMPLES) {
          console.log(`[transcription:${source}] Force-committing buffer (${conn.samplesSinceCommit} samples since last commit)`);
          conn.ws.send(JSON.stringify({ type: 'input_audio_buffer.commit' }));
          conn.samplesSinceCommit = 0;
        } else {
          console.log(`[transcription:${source}] Skipping force-commit (only ${conn.samplesSinceCommit} samples, need ${MIN_COMMIT_SAMPLES})`);
        }
      }
    }, COMMIT_INTERVAL_MS);
  }

  private clearCommitTimer(source: 'system' | 'mic'): void {
    const conn = this.sources[source];
    if (conn.commitTimer) {
      clearInterval(conn.commitTimer);
      conn.commitTimer = null;
    }
    conn.isSpeaking = false;
  }

  private handleRealtimeEvent(event: any, source: 'system' | 'mic'): void {
    const conn = this.sources[source];

    switch (event.type) {
      case 'transcription_session.created':
        console.log(`[transcription:${source}] Session created`);
        break;

      case 'transcription_session.updated':
        console.log(`[transcription:${source}] Session configured successfully`);
        break;

      case 'input_audio_buffer.speech_started':
        console.log(`[transcription:${source}] Speech detected`);
        conn.isSpeaking = true;
        this.startCommitTimer(source);
        this.emit('speech_started', source);
        break;

      case 'input_audio_buffer.speech_stopped':
        console.log(`[transcription:${source}] Speech ended`);
        conn.isSpeaking = false;
        this.emit('speech_stopped', source);
        break;

      case 'input_audio_buffer.committed':
        console.log(`[transcription:${source}] Audio buffer committed`);
        conn.samplesSinceCommit = 0;
        break;

      case 'conversation.item.input_audio_transcription.delta':
        this.emit('transcription', {
          text: event.delta || '',
          isFinal: false,
          source
        } satisfies TranscriptionEvent);
        break;

      case 'conversation.item.input_audio_transcription.completed':
        console.log(`[transcription:${source}] Final:`, (event.transcript || '').substring(0, 80));
        this.emit('transcription', {
          text: event.transcript || '',
          isFinal: true,
          source
        } satisfies TranscriptionEvent);
        break;

      case 'error':
        console.error(`[transcription:${source}] API error:`, event.error?.message || JSON.stringify(event.error));
        this.emit('error', new Error(event.error?.message || 'Realtime API error'));
        break;

      default:
        // Only log non-noisy events
        if (!event.type?.startsWith('input_audio_buffer.')) {
          console.log(`[transcription:${source}] Event:`, event.type);
        }
        break;
    }
  }

  private startWhisperForSource(source: 'system' | 'mic'): void {
    const conn = this.sources[source];
    if (conn.whisperInterval) return;

    conn.whisperInterval = setInterval(async () => {
      const available = conn.whisperBuffer.available();
      if (available < 24000) return;

      const samples = conn.whisperBuffer.drain();
      await this.transcribeWithWhisper(samples, source);
    }, 5000);
  }

  private async transcribeWithWhisper(samples: Int16Array, source: 'system' | 'mic'): Promise<void> {
    if (!this.openai || samples.length === 0) return;

    try {
      const wavBuffer = AudioRingBuffer.toWavBlob(samples, 24000);
      const file = new File([wavBuffer], 'audio.wav', { type: 'audio/wav' });

      const response = await this.openai.audio.transcriptions.create({
        model: 'whisper-1',
        file,
        response_format: 'text',
        language: 'en'
      });

      if (response && typeof response === 'string' && response.trim()) {
        this.emit('transcription', {
          text: response.trim(),
          isFinal: true,
          source
        } satisfies TranscriptionEvent);
      }
    } catch (err) {
      this.emit('error', err);
    }
  }

  setMode(mode: 'realtime' | 'whisper'): void {
    const wasRunning = Object.values(this.sources).some(
      s => s.isConnected || s.whisperInterval !== null
    );
    this.stop();
    this.mode = mode;
    if (wasRunning) this.start();
  }

  getMode(): string {
    return this.mode;
  }
}
