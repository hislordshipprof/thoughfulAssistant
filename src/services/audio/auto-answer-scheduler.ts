import { EventEmitter } from 'events';
import type { TranscriptEntry } from './transcript-store';

export interface AutoAnswerCandidate {
  entryId: string;
  text: string;
}

/**
 * Debounces finalized system-audio transcript updates into one answer request.
 * Any new speech (including microphone speech) cancels the pending request.
 */
export class AutoAnswerScheduler extends EventEmitter {
  private timer: ReturnType<typeof setTimeout> | null = null;
  private enabled = false;
  private lastAnsweredSignature = '';

  constructor(private readonly delayMs = 2000) {
    super();
  }

  setEnabled(enabled: boolean): void {
    this.enabled = enabled;
    if (!enabled) this.cancelPending();
  }

  observe(entry: TranscriptEntry, recording: boolean): void {
    this.cancelPending();
    if (!this.enabled || !recording || entry.source !== 'system' || !entry.isFinal) return;

    const text = entry.text.trim();
    if (!text) return;
    const signature = `${entry.id}\n${text}`;
    if (signature === this.lastAnsweredSignature) return;

    this.timer = setTimeout(() => {
      this.timer = null;
      this.lastAnsweredSignature = signature;
      this.emit('ready', { entryId: entry.id, text } satisfies AutoAnswerCandidate);
    }, this.delayMs);
  }

  cancelPending(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
  }

  reset(): void {
    this.cancelPending();
    this.lastAnsweredSignature = '';
  }
}
