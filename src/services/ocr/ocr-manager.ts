import { EventEmitter } from 'events';
import { OcrEngine } from './ocr-engine';
import { captureScreen, CapturedScreen } from './screen-capture';

interface StealthToggle {
  removeStealthMode(): void;
  applyStealthMode(): void;
}

export class OcrManager extends EventEmitter {
  private engine: OcrEngine;
  private intervalHandle: ReturnType<typeof setInterval> | null = null;
  private intervalMs: number;
  private lastText = '';
  private lastCapture: CapturedScreen | null = null;
  private captures: { image: CapturedScreen; text: string }[] = [];
  private stealthToggle: StealthToggle | null = null;

  constructor(intervalSeconds: number = 30) {
    super();
    this.engine = new OcrEngine();
    this.intervalMs = intervalSeconds * 1000;
  }

  setStealthToggle(toggle: StealthToggle): void {
    this.stealthToggle = toggle;
  }

  async initialize(): Promise<void> {
    await this.engine.initialize();
    this.emit('ready');
  }

  startPeriodicCapture(): void {
    if (this.intervalHandle) return;

    this.intervalHandle = setInterval(async () => {
      try {
        await this.captureAndRecognize();
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
   * Returns as soon as the screenshot is taken (fast).
   * OCR runs in the background — text available later via getCombinedText().
   */
  async captureNow(): Promise<void> {
    await this.captureWithOcrPromise();
  }

  /**
   * Capture screenshot (returns fast for thumbnail) and run OCR in background.
   * Returns a promise that resolves when OCR completes, so callers can optionally await it.
   */
  async captureWithOcrPromise(): Promise<string> {
    // Phase 1: Capture screenshot (fast ~100ms)
    const captured = await captureScreen();
    this.lastCapture = captured;

    // Store immediately with empty text — image is available for preview
    const captureIndex = this.captures.length;
    this.captures.push({ image: captured, text: '' });
    console.log(`[ocr] Capture #${this.captures.length} image ready, starting OCR in background...`);

    // Phase 2: OCR in background — return the promise so callers can await if needed
    return this.engine.recognize(captured.ocrDataUrl).then(text => {
      if (captureIndex < this.captures.length) {
        this.captures[captureIndex].text = text;
        this.lastText = text;
      }
      console.log(`[ocr] Capture #${captureIndex + 1} OCR complete (${text.length} chars)`);
      this.emit('ocr-result', { text, timestamp: captured.timestamp });
      return text;
    }).catch(err => {
      console.error(`[ocr] OCR failed for capture #${captureIndex + 1}:`, err);
      this.emit('error', err);
      return '';
    });
  }

  /** Full capture + OCR (blocking) — waits for OCR to complete before returning */
  async captureAndRecognize(): Promise<string> {
    const captured = await captureScreen();
    this.lastCapture = captured;

    const text = await this.engine.recognize(captured.ocrDataUrl);
    this.lastText = text;

    this.captures.push({ image: captured, text });
    console.log(`[ocr] Capture #${this.captures.length} stored (${text.length} chars)`);

    this.emit('ocr-result', { text, timestamp: captured.timestamp });
    return text;
  }

  getLastText(): string {
    return this.lastText;
  }

  getLastCapture(): CapturedScreen | null {
    return this.lastCapture;
  }

  getAllCaptures(): { image: CapturedScreen; text: string }[] {
    return this.captures;
  }

  getCombinedText(): string {
    if (this.captures.length === 0) return '';
    if (this.captures.length === 1) return this.captures[0].text;
    return this.captures
      .map((c, i) => `[Screenshot ${i + 1}]\n${c.text}`)
      .join('\n\n');
  }

  removeCapture(index: number): void {
    if (index >= 0 && index < this.captures.length) {
      this.captures.splice(index, 1);
      console.log(`[ocr] Removed capture #${index + 1}, ${this.captures.length} remaining`);
    }
  }

  clearCaptures(): void {
    this.captures = [];
    this.lastCapture = null;
    this.lastText = '';
    console.log('[ocr] All captures cleared');
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
    await this.engine.terminate();
  }
}
