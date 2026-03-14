import { EventEmitter } from 'events';
import WebSocket from 'ws';
import { AudioRingBuffer } from './audio-buffer';
import { TranscriptionEvent } from './transcription-service';

interface SourceConnection {
  ws: WebSocket | null;
  isConnected: boolean;
  keepAliveTimer: ReturnType<typeof setInterval> | null;
  reconnectAttempts: number;
  reconnectTimer: ReturnType<typeof setTimeout> | null;
  audioChunkCount: number;
}

// Deepgram KeepAlive interval (ms)
const KEEPALIVE_INTERVAL_MS = 5000;

// Max reconnect attempts
const MAX_RECONNECT_ATTEMPTS = 5;
const RECONNECT_BASE_DELAY_MS = 1000;

/**
 * Deepgram streaming STT provider.
 *
 * Uses Deepgram's WebSocket streaming API with the two-flag system:
 * - `is_final`: phrase has been finalized (no more edits to this segment)
 * - `speech_final`: speaker has paused — end of utterance
 *
 * This is what Cluely and similar tools use for low-latency streaming transcription.
 * ~300ms latency, ~$0.004/min.
 */
export class DeepgramService extends EventEmitter {
  private sources: Record<'system' | 'mic', SourceConnection>;
  private apiKey: string;
  private stopped = false;

  constructor(apiKey: string) {
    super();
    this.apiKey = apiKey;
    this.sources = {
      system: this.createSourceConnection(),
      mic: this.createSourceConnection(),
    };
  }

  private createSourceConnection(): SourceConnection {
    return {
      ws: null,
      isConnected: false,
      keepAliveTimer: null,
      reconnectAttempts: 0,
      reconnectTimer: null,
      audioChunkCount: 0,
    };
  }

  async start(): Promise<void> {
    this.stopped = false;
    await Promise.all([
      this.connectSource('system'),
      this.connectSource('mic'),
    ]);
  }

  stop(): void {
    this.stopped = true;
    for (const source of ['system', 'mic'] as const) {
      const conn = this.sources[source];
      if (conn.keepAliveTimer) {
        clearInterval(conn.keepAliveTimer);
        conn.keepAliveTimer = null;
      }
      if (conn.reconnectTimer) {
        clearTimeout(conn.reconnectTimer);
        conn.reconnectTimer = null;
      }
      if (conn.ws) {
        // Send close message per Deepgram protocol
        if (conn.ws.readyState === WebSocket.OPEN) {
          conn.ws.send(JSON.stringify({ type: 'CloseStream' }));
        }
        conn.ws.close();
        conn.ws = null;
      }
      conn.isConnected = false;
      conn.reconnectAttempts = 0;
    }
  }

  sendAudio(samples: Int16Array, source: 'system' | 'mic'): void {
    const conn = this.sources[source];
    if (!conn.ws || !conn.isConnected) return;

    // Deepgram expects raw PCM bytes (not base64)
    const bytes = new Uint8Array(samples.buffer, samples.byteOffset, samples.byteLength);
    conn.ws.send(bytes);

    conn.audioChunkCount++;
    if (conn.audioChunkCount % 100 === 1) {
      console.log(`[deepgram:${source}] Sent audio chunk #${conn.audioChunkCount} (${samples.length} samples)`);
    }
  }

  private async connectSource(source: 'system' | 'mic'): Promise<void> {
    if (this.stopped) return;

    const conn = this.sources[source];

    // Deepgram streaming URL with parameters
    const params = new URLSearchParams({
      model: 'nova-2',
      language: 'en',
      encoding: 'linear16',
      sample_rate: '24000',
      channels: '1',
      punctuate: 'true',
      interim_results: 'true',
      endpointing: '300',          // 300ms silence = end of utterance
      vad_events: 'true',          // Get speech_started events
      smart_format: 'true',        // Smart formatting (numbers, dates, etc.)
    });

    const url = `wss://api.deepgram.com/v1/listen?${params.toString()}`;
    console.log(`[deepgram:${source}] Connecting...`);

    conn.ws = new WebSocket(url, {
      headers: {
        'Authorization': `Token ${this.apiKey}`,
      }
    });

    conn.ws.on('open', () => {
      conn.isConnected = true;
      conn.reconnectAttempts = 0;
      console.log(`[deepgram:${source}] Connected`);

      // Start KeepAlive timer
      conn.keepAliveTimer = setInterval(() => {
        if (conn.ws && conn.ws.readyState === WebSocket.OPEN) {
          conn.ws.send(JSON.stringify({ type: 'KeepAlive' }));
        }
      }, KEEPALIVE_INTERVAL_MS);

      this.emit('connected', source);
    });

    conn.ws.on('message', (data: WebSocket.Data) => {
      try {
        const msg = JSON.parse(data.toString());
        this.handleMessage(msg, source);
      } catch {
        // Ignore parse errors
      }
    });

    conn.ws.on('close', (code: number, reason: Buffer) => {
      const reasonStr = reason?.toString() || 'no reason';
      console.log(`[deepgram:${source}] WebSocket closed: code=${code}, reason=${reasonStr}`);
      conn.isConnected = false;

      if (conn.keepAliveTimer) {
        clearInterval(conn.keepAliveTimer);
        conn.keepAliveTimer = null;
      }

      this.emit('disconnected', source);

      // Auto-reconnect with exponential backoff
      if (!this.stopped && conn.reconnectAttempts < MAX_RECONNECT_ATTEMPTS) {
        const delay = RECONNECT_BASE_DELAY_MS * Math.pow(2, conn.reconnectAttempts);
        conn.reconnectAttempts++;
        console.log(`[deepgram:${source}] Reconnecting in ${delay}ms (attempt ${conn.reconnectAttempts}/${MAX_RECONNECT_ATTEMPTS})...`);
        conn.reconnectTimer = setTimeout(() => {
          this.connectSource(source);
        }, delay);
      } else if (!this.stopped) {
        console.error(`[deepgram:${source}] Max reconnect attempts reached`);
        this.emit('error', new Error(`Deepgram ${source} connection failed after ${MAX_RECONNECT_ATTEMPTS} attempts`));
      }
    });

    conn.ws.on('error', (err: Error) => {
      console.error(`[deepgram:${source}] WebSocket error:`, err.message);
      this.emit('error', err);
    });
  }

  private handleMessage(msg: any, source: 'system' | 'mic'): void {
    // Deepgram message types
    switch (msg.type) {
      case 'Results': {
        const alt = msg.channel?.alternatives?.[0];
        if (!alt) return;

        const text = alt.transcript || '';
        if (!text.trim()) return;

        const isFinal = msg.is_final === true;
        const speechFinal = msg.speech_final === true;

        if (isFinal) {
          // Emit as final transcription
          this.emit('transcription', {
            text: text.trim(),
            isFinal: true,
            source
          } satisfies TranscriptionEvent);

          if (speechFinal) {
            // Speaker paused — signal end of utterance
            this.emit('speech_stopped', source);
          }
        } else {
          // Interim result — emit as partial
          this.emit('transcription', {
            text: text.trim(),
            isFinal: false,
            source
          } satisfies TranscriptionEvent);
        }
        break;
      }

      case 'SpeechStarted':
        console.log(`[deepgram:${source}] Speech detected`);
        this.emit('speech_started', source);
        break;

      case 'Metadata':
        console.log(`[deepgram:${source}] Metadata:`, msg.model_info?.name || 'unknown model');
        break;

      case 'UtteranceEnd':
        console.log(`[deepgram:${source}] Utterance end`);
        this.emit('speech_stopped', source);
        break;

      default:
        break;
    }
  }

  getMode(): string {
    return 'deepgram';
  }
}
