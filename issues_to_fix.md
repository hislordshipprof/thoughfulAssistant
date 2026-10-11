# Issues to Fix

Verified by direct source code reading. All line numbers reference actual code.

---

## Bug 1 — OCR Index Race with `removeCapture()`

**File:** `src/services/ocr/ocr-manager.ts:72–89`
**Severity:** High

### What the code does
```typescript
const captureIndex = this.captures.length;   // e.g. = 0
this.captures.push({ image: captured, text: '' });

return this.engine.recognize(...).then(text => {
  if (captureIndex < this.captures.length) {
    this.captures[captureIndex].text = text;  // BUG: index may be wrong
  }
});
```

### What goes wrong
User captures screenshot #1 (`captureIndex=0`), then #2 (`captureIndex=1`). User removes capture #1 via `removeCapture(0)` which calls `splice(0,1)` and shifts the array. When #1's OCR finishes, `this.captures[0]` now points to capture #2. OCR text from screenshot #1 is written into screenshot #2's slot.

- `clearCaptures()` is safe — after clearing, `captureIndex < 0` = false, callback exits cleanly.
- `removeCapture()` is the trigger — it shifts all higher indices down.

### Effect
Wrong OCR text shown for captures. AI receives the wrong screenshot context. Silent — no error thrown.

### Fix
Store a reference to the object itself, not its index:
```typescript
const captureEntry = { image: captured, text: '' };
this.captures.push(captureEntry);

return this.engine.recognize(...).then(text => {
  captureEntry.text = text;  // always writes to the right object regardless of array shifts
  this.lastText = text;
  ...
});
```

---

## Bug 2 — Ghost Partial Entry Loses Final Transcript Text

**Files:** `src/services/audio/transcript-store.ts:24–41` + `src/services/audio/audio-manager.ts:182–190`
**Severity:** High

### What the code does
OpenAI Realtime sends `event.delta = undefined` on some events. The transcription service handles this as:
```typescript
// transcription-service.ts
this.emit('transcription', {
  text: event.delta || '',   // empty string when delta is undefined
  isFinal: false,
  source
});
```

In `transcript-store.ts`, `add()` with empty text returns an entry without storing it:
```typescript
add(text: string, source: 'system' | 'mic', isFinal: boolean = true): TranscriptEntry {
  const entry = { id: `t-${this.nextId++}`, text: text.trim(), ... };
  if (!entry.text) return entry;   // Returns phantom entry — NOT pushed to entries[]
  this.entries.push(entry);
  ...
}
```

In `audio-manager.ts`, the phantom ID gets stored:
```typescript
const entry = this.transcriptStore.add(event.text, event.source, false);
this.partialIds[src] = entry.id;   // Stores phantom ID not in entries[]
```

When the actual final transcript arrives:
```typescript
this.transcriptStore.updatePartial(this.partialIds[src]!, text, true);
// updatePartial does entries.find(e => e.id === id) → undefined → silent no-op
// The final transcript text is completely lost
```

`accumulationIds[src]` is also set to the phantom ID, so any subsequent appends also silently fail.

### Effect
An entire sentence can be silently dropped. The transcript shows gaps. The AI gets incomplete context. No error is thrown or logged.

### Fix
Guard against empty text before calling `add()` in `audio-manager.ts`:
```typescript
} else {
  // Delta/partial update — ignore empty deltas
  const text = event.text?.trim();
  if (!text) return;

  if (!this.partialIds[src]) {
    const entry = this.transcriptStore.add(text, event.source, false);
    this.partialIds[src] = entry.id;
  } else {
    this.transcriptStore.updatePartial(this.partialIds[src]!, text, false);
  }
}
```

---

## Bug 3 — Provider Switch Mid-Session Is a Silent No-Op

**File:** `src/services/audio/audio-manager.ts:243–249` + `src/main/main.ts` (missing watcher)
**Severity:** High

### What the code does
```typescript
// audio-manager.ts
setTranscriptionMode(mode: TranscriptionMode): void {
  if (this.sttProvider instanceof TranscriptionService && (mode === 'realtime' || mode === 'whisper')) {
    (this.sttProvider as TranscriptionService).setMode(mode);
  }
  // For switching between provider types, need to restart ← comment with no code
}
```

Additionally, `main.ts` has `configStore.onDidChange` watchers for `'overlay'`, `'ai'`, and `'hotkeys'` — but no watcher for `'audio'`. So `setTranscriptionMode` is never called when audio config changes. The function is dead code.

### Effect
User opens settings, changes transcription provider from Deepgram to Groq while recording. Nothing happens. Audio keeps using Deepgram. The UI shows "Groq" but Deepgram is still transcribing. No error, no indication of failure.

### Fix
Add an audio config watcher in `main.ts`:
```typescript
configStore.onDidChange('audio', async (newVal) => {
  if (newVal && audioManager.isActive()) {
    const cfg = configStore.getAll();
    audioManager.stop();
    await audioManager.start(cfg.ai.openaiKey, newVal.transcriptionMode, {
      deepgramKey: newVal.deepgramKey,
      groqKey: newVal.groqKey,
      googleSttKey: newVal.googleSttKey,
      googleProjectId: newVal.googleProjectId,
    });
  }
});
```

---

## Bug 4 — Google STT Uses Wrong Authentication Format

**File:** `src/services/audio/google-stt-service.ts:128–136`
**Severity:** High (feature completely broken)

### What the code does
```typescript
const resp = await fetch('https://speech.googleapis.com/v1/speech:recognize', {
  method: 'POST',
  headers: {
    'Authorization': `Bearer ${this.apiKey}`,   // WRONG for API keys
    'x-goog-user-project': this.projectId,
  },
  body: JSON.stringify(body),
});
```

`Authorization: Bearer` is for **OAuth2 access tokens**, not API keys. Google API keys must be passed as a `?key={apiKey}` query parameter in the URL. Any user pasting their API key from the Google Cloud Console will receive a 401 or 403 response.

### Effect
Google STT never works with a standard API key. The entire provider is broken for normal user setup. It would only work if the user provides a short-lived OAuth2 access token, which expires in 1 hour and the code has no refresh logic for.

### Fix
Use API key as a URL query parameter:
```typescript
const url = `https://speech.googleapis.com/v1/speech:recognize?key=${this.apiKey}`;

const resp = await fetch(url, {
  method: 'POST',
  headers: {
    'Content-Type': 'application/json',
    'x-goog-user-project': this.projectId,
  },
  body: JSON.stringify(body),
});
```

---

## Bug 5 — `toggleRecording` Hotkey Sets Tray State Before `start()` Resolves

**File:** `src/main/main.ts:292–305`
**Severity:** Medium

### What the code does
```typescript
case 'toggleRecording':
  if (audioManager.isActive()) {
    audioManager.stop();
    trayManager.setRecordingState(false);
  } else {
    const cfg = configStore.getAll();
    audioManager.start(cfg.ai.openaiKey, cfg.audio.transcriptionMode, {...});  // NOT awaited
    trayManager.setRecordingState(true);   // Always called, even if start() fails
  }
```

Compare to the IPC handler in `ipc-handlers.ts:48–62` which correctly `await`s `start()` and only returns `true` on success.

### Effect
If `start()` fails (bad API key, native addon unavailable), the tray icon shows "Recording: ON" but recording never started. No error is shown to the user. The state eventually self-corrects on the next hotkey press, but the user has no indication of what happened.

### Fix
Await `start()` and wrap with try/catch:
```typescript
case 'toggleRecording':
  if (audioManager.isActive()) {
    audioManager.stop();
    trayManager.setRecordingState(false);
  } else {
    const cfg = configStore.getAll();
    try {
      await audioManager.start(cfg.ai.openaiKey, cfg.audio.transcriptionMode, {
        deepgramKey: cfg.audio.deepgramKey,
        groqKey: cfg.audio.groqKey,
        googleSttKey: cfg.audio.googleSttKey,
        googleProjectId: cfg.audio.googleProjectId,
      });
      trayManager.setRecordingState(true);
    } catch (err: any) {
      console.error('[main] Failed to start recording:', err.message);
      mainWindow.webContents.send('ai:error', `Failed to start recording: ${err.message}`);
    }
  }
  break;
```

---

## Issue 6 — Native Capture Not Stopped if `sttProvider.start()` Throws

**File:** `src/services/audio/audio-manager.ts:86–101`
**Severity:** Low (unlikely to trigger in practice)

### What the code does
```typescript
const started = this.native.startCapture(...);  // WASAPI starts
if (!started) throw new Error('Failed to start audio capture');

await this.sttProvider.start();  // If this throws:
this.isRunning = true;           // Never reached → isRunning stays false
```

If `sttProvider.start()` throws after native capture has started, `isRunning` stays `false`. `stop()` returns early (`if (!this.isRunning) return`) so WASAPI capture keeps running with no way to stop it short of restarting the app.

In practice this is low probability — all providers connect asynchronously and `start()` rarely throws synchronously. But the failure mode is severe when it does occur.

### Fix
Wrap the provider start in try/catch and clean up native capture on failure:
```typescript
const started = this.native.startCapture(...);
if (!started) throw new Error('Failed to start audio capture');

try {
  await this.sttProvider.start();
} catch (err) {
  this.native.stopCapture();
  this.sttProvider = null;
  throw err;
}

this.isRunning = true;
```

---

## Issue 7 — Google STT base64 Encoding is O(n²)

**Files:** `src/services/audio/google-stt-service.ts:111–115` + `src/services/audio/audio-buffer.ts:67–70`
**Severity:** Low (performance)

### What the code does
```typescript
let binary = '';
for (let i = 0; i < bytes.length; i++) {
  binary += String.fromCharCode(bytes[i]);  // String concat in a loop
}
const audioBase64 = btoa(binary);
```

For a 3-second audio chunk at 24kHz: 3 × 24,000 × 2 = 144,000 bytes. String concatenation in a loop has O(n²) behavior in non-optimizing paths.

### Fix
Use Node.js Buffer directly:
```typescript
const audioBase64 = Buffer.from(bytes).toString('base64');
```

---

## Dismissed (Not Real)

| Previously claimed | Verdict | Reason |
|---|---|---|
| `nextId` integer overflow | Not real | Needs 10 million+ days of use at max transcription rate to hit `Number.MAX_SAFE_INTEGER` |
| WebSocket listener leak on reconnect | Not real | Old socket is already closed when reconnect fires; new object is created fresh; old one is eligible for GC |
| EventEmitter stacking across `start()` calls | Not real | Each `start()` creates a fresh provider object; `start()` returns early if `isRunning`, so no double-attach |
| RMS sum integer overflow | Not real | Max possible sum (~6.4e13) is well within `Number.MAX_SAFE_INTEGER` (9e15) |
| Transcript speaker attribution bug | Not real | Two-stage merge (TURN_GAP_MS then MERGE_GAP_MS fallback) is intentional design |
| Stealth window show() ordering | Very minor | Window is at opacity=0 before `show()`, so contents are invisible even without `WDA_EXCLUDEFROMCAPTURE` |

---

## Fix Priority

| # | Bug | Effort | Impact |
|---|---|---|---|
| 1 | Bug 4 — Google STT auth | Low | Feature completely broken |
| 2 | Bug 2 — Ghost partial entry | Low | Final transcripts silently dropped (Realtime mode) |
| 3 | Bug 1 — OCR index race | Low | Wrong OCR text on wrong screenshot |
| 4 | Bug 3 — Provider switch no-op | Medium | Setting change ignored while recording |
| 5 | Bug 5 — Tray state mismatch | Low | Wrong UI state on start failure |
| 6 | Issue 6 — WASAPI leak on failure | Low | App stuck on rare failure path |
| 7 | Issue 7 — base64 O(n²) | Low | Performance on large audio chunks |
