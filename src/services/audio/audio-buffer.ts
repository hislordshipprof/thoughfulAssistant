export class AudioRingBuffer {
  private buffer: Int16Array;
  private writePos = 0;
  private readPos = 0;
  private size: number;
  private count = 0;

  constructor(maxSamples: number = 16000 * 30) {
    // Default: 30 seconds at 16kHz
    this.size = maxSamples;
    this.buffer = new Int16Array(maxSamples);
  }

  write(samples: Int16Array): void {
    for (let i = 0; i < samples.length; i++) {
      this.buffer[this.writePos] = samples[i];
      this.writePos = (this.writePos + 1) % this.size;
      if (this.count < this.size) {
        this.count++;
      } else {
        this.readPos = (this.readPos + 1) % this.size;
      }
    }
  }

  read(numSamples: number): Int16Array {
    const toRead = Math.min(numSamples, this.count);
    const result = new Int16Array(toRead);
    for (let i = 0; i < toRead; i++) {
      result[i] = this.buffer[this.readPos];
      this.readPos = (this.readPos + 1) % this.size;
    }
    this.count -= toRead;
    return result;
  }

  peek(numSamples: number): Int16Array {
    const toRead = Math.min(numSamples, this.count);
    const result = new Int16Array(toRead);
    let pos = this.readPos;
    for (let i = 0; i < toRead; i++) {
      result[i] = this.buffer[pos];
      pos = (pos + 1) % this.size;
    }
    return result;
  }

  available(): number {
    return this.count;
  }

  clear(): void {
    this.writePos = 0;
    this.readPos = 0;
    this.count = 0;
  }

  /** Get all buffered data as a single chunk (for sending to Whisper) */
  drain(): Int16Array {
    return this.read(this.count);
  }

  /** Convert Int16 samples to base64-encoded PCM bytes */
  static toBase64(samples: Int16Array): string {
    return Buffer.from(samples.buffer, samples.byteOffset, samples.byteLength).toString('base64');
  }

  /** Convert Int16 samples to WAV Blob */
  static toWavBlob(samples: Int16Array, sampleRate: number = 16000): Buffer {
    const byteRate = sampleRate * 2; // 16-bit mono
    const headerSize = 44;
    const dataSize = samples.length * 2;
    const buffer = Buffer.alloc(headerSize + dataSize);

    // WAV header
    buffer.write('RIFF', 0);
    buffer.writeUInt32LE(36 + dataSize, 4);
    buffer.write('WAVE', 8);
    buffer.write('fmt ', 12);
    buffer.writeUInt32LE(16, 16); // PCM chunk size
    buffer.writeUInt16LE(1, 20);  // PCM format
    buffer.writeUInt16LE(1, 22);  // mono
    buffer.writeUInt32LE(sampleRate, 24);
    buffer.writeUInt32LE(byteRate, 28);
    buffer.writeUInt16LE(2, 32);  // block align
    buffer.writeUInt16LE(16, 34); // bits per sample
    buffer.write('data', 36);
    buffer.writeUInt32LE(dataSize, 40);

    // PCM data
    for (let i = 0; i < samples.length; i++) {
      buffer.writeInt16LE(samples[i], headerSize + i * 2);
    }

    return buffer;
  }
}
