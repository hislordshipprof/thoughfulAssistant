import Tesseract, { Worker } from 'tesseract.js';

export class OcrEngine {
  private worker: Worker | null = null;
  private isReady = false;
  private initPromise: Promise<void> | null = null;

  /** Pre-initialize the Tesseract worker at startup for fast OCR */
  async initialize(): Promise<void> {
    if (this.initPromise) return this.initPromise;

    this.initPromise = (async () => {
      this.worker = await Tesseract.createWorker('eng', 1, {
        logger: () => {} // Suppress progress logs
      });
      this.isReady = true;
    })();

    return this.initPromise;
  }

  async recognize(imageDataUrl: string): Promise<string> {
    if (!this.isReady || !this.worker) {
      await this.initialize();
    }

    const result = await this.worker!.recognize(imageDataUrl);
    return result.data.text;
  }

  async terminate(): Promise<void> {
    if (this.worker) {
      await this.worker.terminate();
      this.worker = null;
      this.isReady = false;
      this.initPromise = null;
    }
  }

  getStatus(): boolean {
    return this.isReady;
  }
}
