import { EventEmitter } from 'events';
import { OcrEngine } from './ocr-engine';
import { captureScreen, CapturedScreen } from './screen-capture';

export class OcrManager extends EventEmitter {
  private engine = new OcrEngine();
  private intervalHandle: ReturnType<typeof setInterval> | null = null;
  private intervalMs: number;
  private displayId = 'cursor';
  private captures: { image: CapturedScreen; text: string }[] = [];
  private busy = false;
  private revision = 0;
  private captureGuard = (take: () => Promise<CapturedScreen>) => take();

  constructor(intervalSeconds = 30) { super(); this.intervalMs = intervalSeconds * 1000; }
  setCaptureGuard(guard: (take: () => Promise<CapturedScreen>) => Promise<CapturedScreen>) { this.captureGuard = guard; }
  setDisplay(id: string) { this.displayId = id; }
  async initialize() { await this.engine.initialize(); this.emit('ready'); }

  startPeriodicCapture() {
    if (this.intervalHandle) return;
    this.intervalHandle = setInterval(() => {
      if (!this.busy) void this.captureWithOcrPromise({ replace: true, allowPermissionPrompt: false }).catch(error => {
        if (error?.code === 'SCREEN_PERMISSION_REQUIRED') this.stopPeriodicCapture();
        this.emit('error', error);
      });
    }, this.intervalMs);
  }
  stopPeriodicCapture() {
    if (this.intervalHandle) clearInterval(this.intervalHandle);
    this.intervalHandle = null;
  }
  async captureNow() { await this.captureWithOcrPromise(); }

  async captureWithOcrPromise(options: { replace?: boolean; recognize?: boolean; allowPermissionPrompt?: boolean } = {}): Promise<string> {
    if (this.busy) throw new Error('A screen capture is already in progress.');
    this.busy = true;
    const revision = this.revision;
    try {
      const captured = await this.captureGuard(() => captureScreen(this.displayId, { allowPermissionPrompt: options.allowPermissionPrompt }));
      if (revision !== this.revision) throw new Error('Screen capture cancelled.');
      const entry = { image: captured, text: '' };
      this.captures = options.replace ? [entry] : [...this.captures.slice(-2), entry];
      this.emit('screenshots', this.captures.map(item => item.image.imageDataUrl));
      if (options.recognize !== false) entry.text = await this.engine.recognize(captured.ocrDataUrl);
      if (revision !== this.revision) throw new Error('Screen capture cancelled.');
      this.emit('ocr-result', { text: entry.text, timestamp: captured.timestamp });
      return entry.text;
    } finally { this.busy = false; }
  }

  async ensureTextForCaptures() {
    for (const entry of this.captures) {
      if (!entry.text) entry.text = await this.engine.recognize(entry.image.ocrDataUrl);
    }
  }
  cancelPending() { this.revision++; }
  getLastText() { return this.captures.at(-1)?.text || ''; }
  getLastCapture() { return this.captures.at(-1)?.image || null; }
  getAllCaptures() { return this.captures; }
  getCombinedText() {
    return this.captures.map((entry, index) => '[Screen capture ' + (index + 1) + ']\n' + entry.text).join('\n\n');
  }
  removeCapture(index: number) {
    if (Number.isInteger(index) && index >= 0 && index < this.captures.length) this.captures.splice(index, 1);
  }
  clearCaptures() { this.revision++; this.captures = []; }
  getCaptureCount() { return this.captures.length; }
  setInterval(seconds: number) {
    this.intervalMs = seconds * 1000;
    if (this.intervalHandle) { this.stopPeriodicCapture(); this.startPeriodicCapture(); }
  }
  async terminate() { this.stopPeriodicCapture(); this.cancelPending(); await this.engine.terminate(); }
}
