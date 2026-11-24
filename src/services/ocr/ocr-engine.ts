import Tesseract, { Worker } from 'tesseract.js';
import { app } from 'electron';
import path from 'path';
import fs from 'fs';

export class OcrEngine {
  private worker: Worker | null = null;
  private isReady = false;
  private initPromise: Promise<void> | null = null;

  /** Pre-initialize the Tesseract worker at startup for fast OCR */
  async initialize(): Promise<void> {
    if (this.initPromise) return this.initPromise;

    this.initPromise = (async () => {
      const langPath = app.isPackaged ? path.join(process.resourcesPath, 'ocr') : path.resolve(__dirname, '../..');
      const languageFile = path.join(langPath, 'eng.traineddata');
      if (!fs.existsSync(languageFile)) throw new Error('Bundled English OCR data is missing. Reinstall the latest build.');
      // Tesseract 5 treats Electron language paths as URLs. Its Node cache reader
      // does support filesystem paths, so use the bundled data as a read-only cache.
      let rejectWorker!: (error: Error) => void;
      const workerError = new Promise<never>((_resolve, reject) => { rejectWorker = reject; });
      this.worker = await Promise.race([Tesseract.createWorker('eng', 1, {
        cachePath: langPath, langPath, cacheMethod: 'readOnly', gzip: false,
        logger: () => {},
        errorHandler: error => rejectWorker(new Error(`Local OCR failed: ${String(error)}`))
      }), workerError]);
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
