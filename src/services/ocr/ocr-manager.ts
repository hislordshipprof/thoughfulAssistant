import { EventEmitter } from 'events';
import { captureScreen, CapturedScreen } from './screen-capture';

interface StealthToggle {
  removeStealthMode(): void;
  applyStealthMode(): void;
}

/** Max screenshots held in memory — oldest is dropped when exceeded */
const MAX_CAPTURES = 10;

export class OcrManager extends EventEmitter {
  private intervalHandle: ReturnType<typeof setInterval> | null = null;
  private intervalMs: number;
  private lastCapture: CapturedScreen | null = null;
  private captures: { image: CapturedScreen; text: string }[] = [];
  private stealthToggle: StealthToggle | null = null;
  private isCapturing = false;

  constructor(intervalSeconds: number = 30) {
    super();
    this.intervalMs = intervalSeconds * 1000;
  }

  setStealthToggle(toggle: StealthToggle): void {
    this.stealthToggle = toggle;
  }

  async initialize(): Promise<void> {
    // No OCR engine needed — vision models read images directly
    this.emit('ready');
  }

  startPeriodicCapture(): void {
    if (this.intervalHandle) return;

    this.intervalHandle = setInterval(async () => {
      if (this.isCapturing) return; // Skip if previous capture is still in-flight
      try {
        await this.captureScreenOnly();
      } catch (err) {
        this.emit('error', err);
      }
    }, this.intervalMs);
  }

  stopPeriodicCapture(): void {
    if (this.intervalHandle) {
      clearInterval(this.intervalHandle);
      this.intervalHandle = null;
    }
  }

  /**
   * On-demand capture triggered by hotkey.
   * Screenshot only — vision model reads images directly.
   */
  async captureNow(): Promise<void> {
    await this.captureScreenOnly();
  }

  /**
   * Capture screenshot only — no OCR processing.
   * Used for vision model workflow where images are sent directly to AI.
   */
  async captureScreenOnly(): Promise<void> {
    this.isCapturing = true;
    try {
      const captured = await captureScreen();
      this.lastCapture = captured;
      if (this.captures.length >= MAX_CAPTURES) {
        this.captures.shift();
      }
      this.captures.push({ image: captured, text: '' });
      console.log(`[capture] Screenshot #${this.captures.length} ready (vision mode)`);
    } finally {
      this.isCapturing = false;
    }
  }

  getLastCapture(): CapturedScreen | null {
    return this.lastCapture;
  }

  getAllCaptures(): { image: CapturedScreen; text: string }[] {
    return this.captures;
  }

  getCombinedText(): string {
    // Legacy — no longer used with vision models
    return '';
  }

  removeCapture(index: number): void {
    if (index >= 0 && index < this.captures.length) {
      this.captures.splice(index, 1);
      console.log(`[capture] Removed screenshot #${index + 1}, ${this.captures.length} remaining`);
    }
  }

  clearCaptures(): void {
    this.captures = [];
    this.lastCapture = null;
    console.log('[capture] All screenshots cleared');
  }

  getCaptureCount(): number {
    return this.captures.length;
  }

  setInterval(seconds: number): void {
    this.intervalMs = seconds * 1000;
    if (this.intervalHandle) {
      this.stopPeriodicCapture();
      this.startPeriodicCapture();
    }
  }

  async terminate(): Promise<void> {
    this.stopPeriodicCapture();
  }
}
