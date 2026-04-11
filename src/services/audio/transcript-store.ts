import { EventEmitter } from 'events';

export interface TranscriptEntry {
  id: string;
  text: string;
  source: 'system' | 'mic';
  timestamp: number;
  isFinal: boolean;
}

// Max time gap (ms) before starting a new entry for same source
const MERGE_GAP_MS = 3200;

export class TranscriptStore extends EventEmitter {
  private entries: TranscriptEntry[] = [];
  private maxAgeMs: number;
  private nextId = 0;

  constructor(maxAgeMinutes: number = 15) {
    super();
    this.maxAgeMs = maxAgeMinutes * 60 * 1000;
  }

  add(text: string, source: 'system' | 'mic', isFinal: boolean = true): TranscriptEntry {
    this.prune();

    const entry: TranscriptEntry = {
      id: `t-${this.nextId++}`,
      text: text.trim(),
      source,
      timestamp: Date.now(),
      isFinal
    };

    if (!entry.text) return entry;

    this.entries.push(entry);
    this.emit('entry', entry);
    this.emit('update', this.entries);

    return entry;
  }

  /** Append text to an existing entry (for accumulating fragments) */
  appendText(id: string, text: string, isFinal: boolean = true): void {
    const entry = this.entries.find(e => e.id === id);
    if (entry) {
      const trimmed = text.trim();
      if (!trimmed) return;
      // Append with space separator, avoiding double spaces
      entry.text = entry.text ? `${entry.text} ${trimmed}` : trimmed;
      entry.isFinal = isFinal;
      entry.timestamp = Date.now();
      this.emit('entry', entry);
      this.emit('update', this.entries);
    }
  }

  updatePartial(id: string, text: string, isFinal: boolean = false): void {
    const entry = this.entries.find(e => e.id === id);
    if (entry) {
      entry.text = text.trim();
      entry.isFinal = isFinal;
      this.emit('entry', entry);
      this.emit('update', this.entries);
    }
  }

  /** Get the last entry for a given source, if recent enough to merge into */
  getLastEntryForSource(source: 'system' | 'mic'): TranscriptEntry | null {
    for (let i = this.entries.length - 1; i >= 0; i--) {
      const entry = this.entries[i];
      if (entry.source === source && entry.isFinal) {
        // Only merge if within time gap
        if (Date.now() - entry.timestamp < MERGE_GAP_MS) {
          return entry;
        }
        return null;
      }
      // If we hit a different source, don't merge across sources
      if (entry.source !== source) {
        return null;
      }
    }
    return null;
  }

  getEntry(id: string): TranscriptEntry | undefined {
    return this.entries.find(e => e.id === id);
  }

  getAll(): TranscriptEntry[] {
    this.prune();
    return [...this.entries];
  }

  getRecent(count: number): TranscriptEntry[] {
    this.prune();
    return this.entries.slice(-count);
  }

  /** Get transcript as formatted text for AI context.
   *  Entries are already time-pruned (15 min window), so maxChars is a safety net.
   *  60K chars ≈ 15K tokens — comfortably fits alongside history in any model. */
  toContext(maxEntries: number = 50, maxChars: number = 60000): string {
    const recent = this.getRecent(maxEntries);
    const lines: string[] = [];
    let totalChars = 0;

    // Build from newest to oldest, then reverse, so we keep the most recent entries
    for (let i = recent.length - 1; i >= 0; i--) {
      const e = recent[i];
      const label = e.source === 'system' ? 'Interviewer' : 'You';
      const time = new Date(e.timestamp).toLocaleTimeString();
      const line = `[${time}] ${label}: ${e.text}`;
      if (totalChars + line.length > maxChars && lines.length > 0) break;
      lines.unshift(line);
      totalChars += line.length + 1; // +1 for newline
    }

    return lines.join('\n');
  }

  clear(): void {
    this.entries = [];
    this.emit('update', this.entries);
  }

  private prune(): void {
    const cutoff = Date.now() - this.maxAgeMs;
    this.entries = this.entries.filter(e => e.timestamp > cutoff);
  }
}
