// Deterministic media tests: synthetic audio/screens only; no permissions or network.
const assert = require('node:assert/strict');
const vm = require('node:vm');
const { EventEmitter } = require('node:events');
const { PassThrough } = require('node:stream');
const { buildSync } = require('esbuild');
const path = require('node:path');

function load(file, mocks = {}, globals = {}) {
  const code = buildSync({ entryPoints: [path.resolve(__dirname, '..', file)], bundle: true,
    platform: 'node', format: 'cjs', packages: 'external', external: Object.keys(mocks), write: false }).outputFiles[0].text;
  const module = { exports: {} };
  vm.runInNewContext(code, { module, exports: module.exports, __dirname, Buffer,
    setTimeout, clearTimeout, setInterval, clearInterval, AbortController, AbortSignal,
    TextDecoder, TextEncoder, Response, process: { platform: 'darwin', resourcesPath: '/test/resources' },
    console: { log() {}, warn() {}, error() {} },
    require: name => Object.hasOwn(mocks, name) ? mocks[name] : require(name), ...globals });
  return module.exports;
}
const tick = () => new Promise(resolve => setImmediate(resolve));
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
const deferred = () => { let resolve, reject; const promise = new Promise((a, b) => { resolve = a; reject = b; }); return { promise, resolve, reject }; };

async function autoAnswerTests() {
  const { AutoAnswerScheduler } = load('src/services/audio/auto-answer-scheduler.ts');
  const scheduler = new AutoAnswerScheduler(15); const answers = [];
  scheduler.on('ready', value => answers.push(value));
  scheduler.observe({ id: 'disabled', text: 'Should not answer', source: 'system', timestamp: 1, isFinal: true }, true);
  await pause(25); assert.equal(answers.length, 0);
  scheduler.setEnabled(true);
  scheduler.observe({ id: 'partial', text: 'What is', source: 'system', timestamp: 2, isFinal: false }, true);
  await pause(25); assert.equal(answers.length, 0);
  scheduler.observe({ id: 'turn-1', text: 'What is a mutex?', source: 'system', timestamp: 3, isFinal: true }, true);
  scheduler.observe({ id: 'mic-1', text: 'Let me answer', source: 'mic', timestamp: 4, isFinal: true }, true);
  await pause(25); assert.equal(answers.length, 0, 'Microphone speech must cancel a pending answer');
  const turn = { id: 'turn-2', text: 'Explain eventual consistency', source: 'system', timestamp: 5, isFinal: true };
  scheduler.observe(turn, true); await pause(25);
  assert.equal(answers.length, 1); assert.equal(answers[0].text, turn.text);
  scheduler.observe(turn, true); await pause(25);
  assert.equal(answers.length, 1, 'An unchanged finalized turn must not answer twice');
  scheduler.observe({ ...turn, text: turn.text + ' with an example' }, true); await pause(25);
  assert.equal(answers.length, 2, 'New text on the same transcript entry is a new candidate');
  scheduler.reset();
  console.log('PASS: system-audio auto-answer debounce, microphone cancellation, disabled state, duplicate suppression');
}

async function audioTests() {
  class Stt extends EventEmitter {
    static instances = [];
    constructor() { super(); this.audio = []; Stt.instances.push(this); }
    async start() {} stop() {} sendAudio(samples, source) { this.audio.push({ samples, source }); }
  }
  const { AudioManager } = load('src/services/audio/audio-manager.ts', {
    './transcription-service': { TranscriptionService: Stt },
    './deepgram-service': { DeepgramService: Stt },
    './google-stt-service': { GoogleSttService: Stt },
    './groq-whisper-service': { GroqWhisperService: Stt }
  });
  class Backend extends EventEmitter {
    supportsLocalSpeech = true;
    starts = 0; stops = 0;
    startCapture(system, mic, options) { this.starts++; Object.assign(this, { system, mic, options }); return this.pending?.promise || true; }
    stopCapture() { this.stops++; }
  }
  const backend = new Backend(); const audio = new AudioManager(backend);
  const errors = []; audio.on('error', error => errors.push(error));
  await assert.rejects(audio.start('', 'macos-speech', {}, { captureMicrophone: false, captureSystemAudio: false }), /at least one/);
  assert.equal(backend.starts, 0);
  await audio.start('', 'macos-speech', {}, { captureMicrophone: true, captureSystemAudio: false, speechLocale: 'en-US' });
  assert.equal(audio.getState().isRecording, true);
  assert.equal(audio.getState().systemAudio, false);
  assert.equal(backend.options.localSpeech, true);
  backend.emit('transcription', { source: 'mic', text: 'partial', isFinal: false });
  backend.emit('transcription', { source: 'mic', text: 'completed sentence', isFinal: true });
  backend.emit('transcription', { source: 'system', text: 'disabled source', isFinal: true });
  assert.equal(audio.getTranscript().length, 1);
  assert.equal(audio.getTranscript()[0].text, 'completed sentence');
  audio.stop();
  backend.emit('transcription', { source: 'mic', text: 'after stop', isFinal: true });
  assert.equal(audio.getTranscript()[0].text, 'completed sentence');

  backend.pending = deferred();
  const starting = audio.start('', 'macos-speech');
  await tick(); assert.equal(audio.isStarting(), true);
  audio.stop(); backend.pending.reject(new Error('Audio start cancelled'));
  await starting; assert.equal(audio.isActive(), false); backend.pending = null;
  backend.pending = deferred();
  const denied = audio.start('', 'macos-speech');
  await tick(); backend.pending.reject(new Error('Microphone access denied'));
  await assert.rejects(denied, /access denied/);
  assert.equal(audio.isStarting(), false); backend.pending = null;
  await assert.rejects(audio.start('', 'deepgram'), /key required/);
  assert.equal(audio.isActive(), false);

  await audio.start('', 'deepgram', { deepgramKey: 'synthetic-test-key' }, { captureMicrophone: false, captureSystemAudio: true });
  const old = Stt.instances.at(-1), oldCallback = backend.system;
  const chunk = { samples: Buffer.from([1, 0, 2, 0]), sampleRate: 24000, channels: 1, isLoopback: true };
  backend.mic(chunk); backend.system(chunk);
  assert.equal(old.audio.length, 1); assert.equal(old.audio[0].source, 'system');
  audio.stop(); await audio.start('', 'macos-speech');
  old.emit('error', new Error('late old provider error')); oldCallback(chunk);
  assert.equal(audio.isActive(), true); assert.equal(errors.length, 0);
  backend.emit('error', new Error('device disconnected'));
  assert.equal(audio.isActive(), false); assert.equal(errors.length, 1);
  console.log('PASS: audio source selection, local speech, transcript finalization, startup denial/cancel, stale provider events, device failure');
}

async function helperTests() {
  const children = [];
  const { MacAudioCapture } = load('src/services/audio/mac-audio-capture.ts', {
    electron: { app: { isPackaged: true } }, fs: { existsSync: () => true },
    child_process: { spawn: (file, args) => {
      const child = new EventEmitter();
      Object.assign(child, { file, args, stdin: new PassThrough(), stdout: new PassThrough(), stderr: new PassThrough(), exitCode: null });
      child.kill = () => { child.exitCode = 0; child.emit('exit', 0); };
      child.stdin.on('finish', child.kill); children.push(child); return child;
    } }
  });
  const capture = new MacAudioCapture(); const samples = [], levels = [], transcripts = [];
  capture.on('level', level => levels.push(level)); capture.on('transcription', event => transcripts.push(event));
  const start = capture.startCapture(value => samples.push(value), () => {}, {
    captureMicrophone: false, captureSystemAudio: true, localSpeech: true, speechLocale: 'en-GB'
  });
  const child = children.at(-1);
  assert.ok(child.file.endsWith('/native/overlay-audio')); assert.ok(child.args.includes('--system'));
  assert.ok(!child.args.includes('--mic')); assert.ok(child.args.includes('--locale=en-GB'));
  const send = message => child.stdout.write(JSON.stringify(message) + '\n');
  send({ type: 'ready' }); await start;
  send({ type: 'audio', source: 'system', samples: Buffer.from([1, 0]).toString('base64') });
  send({ type: 'level', source: 'system', level: 0.4 });
  send({ type: 'transcript', source: 'system', text: 'Synthetic words', isFinal: true });
  assert.equal(samples[0].sampleRate, 24000); assert.equal(samples[0].channels, 1);
  assert.equal(levels[0].level, 0.4); assert.equal(transcripts[0].isFinal, true);
  capture.stopCapture(); assert.equal(capture.isCapturing(), false);
  const denied = capture.startCapture(() => {}, () => {});
  children.at(-1).stdout.write(JSON.stringify({ type: 'error', message: 'Permission denied' }) + '\n');
  await assert.rejects(denied, /Permission denied/); assert.equal(capture.isCapturing(), false);
  const cancelled = capture.startCapture(() => {}, () => {}); capture.stopCapture();
  await assert.rejects(cancelled, /cancelled/);
  console.log('PASS: packaged helper path, flags, JSON protocol, PCM/levels/transcripts, permission error, child cleanup');
}

async function screenTests() {
  let access = 'granted', selected, ocrFailure = false, pending;
  const display = { id: 22, label: 'Test display', size: { width: 2400, height: 1600 }, scaleFactor: 1 };
  const thumbnail = { isEmpty: () => false, getSize: () => display.size, resize() { return this; }, toJPEG: () => Buffer.from('jpeg'), toPNG: () => Buffer.from('png') };
  const electron = { systemPreferences: { getMediaAccessStatus: () => access },
    screen: { getAllDisplays: () => [display], getDisplayNearestPoint: () => display, getCursorScreenPoint: () => ({ x: 1, y: 1 }) },
    desktopCapturer: { getSources: async () => [{ display_id: 'wrong', thumbnail: null }, { display_id: '22', thumbnail }] }
  };
  const { captureScreen, listDisplays } = load('src/services/ocr/screen-capture.ts', { electron });
  assert.equal(listDisplays()[0].id, '22'); assert.equal((await captureScreen()).displayId, '22');
  await assert.rejects(captureScreen('missing'), /disconnected/);
  access = 'denied'; await assert.rejects(captureScreen(), /not approved/);
  access = 'granted';
  const { OcrManager } = load('src/services/ocr/ocr-manager.ts', {
    './ocr-engine': { OcrEngine: class {
      async initialize() {} async terminate() {}
      async recognize() { if (ocrFailure) throw new Error('OCR failure'); return 'Synthetic screen text'; }
    } },
    './screen-capture': { captureScreen: async id => {
      selected = id;
      if (pending) await pending.promise;
      return { imageDataUrl: 'data:image/jpeg;base64,abc', ocrDataUrl: 'data:image/png;base64,def', timestamp: Date.now() };
    } }
  });
  const ocr = new OcrManager(); ocr.setDisplay('22');
  for (let i = 0; i < 4; i++) await ocr.captureNow();
  assert.equal(ocr.getCaptureCount(), 3); assert.equal(selected, '22');
  await ocr.captureWithOcrPromise({ replace: true, recognize: false });
  assert.equal(ocr.getCaptureCount(), 1); assert.equal(ocr.getLastText(), '');
  await ocr.ensureTextForCaptures(); assert.equal(ocr.getLastText(), 'Synthetic screen text');
  ocrFailure = true; await assert.rejects(ocr.captureNow(), /OCR failure/); ocrFailure = false;
  pending = deferred(); const reading = ocr.captureNow();
  await assert.rejects(ocr.captureNow(), /already in progress/);
  ocr.clearCaptures(); pending.resolve(); await assert.rejects(reading, /cancelled/);
  assert.equal(ocr.getCaptureCount(), 0);
  await ocr.terminate();
  console.log('PASS: display-ID selection, permission/disconnected errors, capture limit, fresh replacement, OCR fallback, capture cancellation');
}

async function aiTests() {
  const requests = [];
  const fetch = async (url, options) => {
    requests.push({ url, body: JSON.parse(options.body) });
    return new Response(url.endsWith('/api/show') ? JSON.stringify({ capabilities: ['completion', 'vision'] })
      : JSON.stringify({ message: { content: 'Synthetic answer' }, done: true }) + '\n');
  };
  const { OllamaProvider } = load('src/services/ai/ollama-provider.ts', {}, { fetch });
  const provider = new OllamaProvider('http://synthetic.invalid', 'vision-model');
  assert.equal(await provider.supportsImages(), true); await provider.supportsImages();
  assert.equal(requests.length, 1);
  const events = [];
  await provider.streamChat([{ role: 'user', content: 'Screen question', images: ['data:image/jpeg;base64,YWJj'] }], event => events.push(event));
  assert.deepEqual(requests.at(-1).body.messages[0].images, ['YWJj']);
  assert.equal(events.at(-1).type, 'done');
  const { OllamaProvider: OfflineProvider } = load('src/services/ai/ollama-provider.ts', {}, { fetch: async () => { throw new Error('offline'); } });
  assert.equal(await new OfflineProvider('http://synthetic.invalid', 'text-model').supportsImages(), false);
  const { AiManager } = load('src/services/ai/ai-manager.ts', {}, { fetch });
  const ai = new AiManager(), callbacks = [], messages = [], tokens = [];
  ai.activeProvider = { isConfigured: () => true, streamChat: async (value, cb) => { messages.push(value); callbacks.push(cb); }, cancelStream() {} };
  ai.on('token', token => tokens.push(token));
  await ai.ask('', '', 'first', 'general', '', '', ['data:image/jpeg;base64,YWJj']);
  ai.cancelStream(); await ai.ask('', '', 'second');
  callbacks[0]({ type: 'token', content: 'stale' }); callbacks[0]({ type: 'done', content: '' });
  callbacks[1]({ type: 'token', content: 'current' }); callbacks[1]({ type: 'done', content: '' });
  assert.deepEqual(tokens, ['current']);
  await ai.ask('', '', 'third');
  assert.equal(messages[0].at(-1).images.length, 1);
  assert.ok(messages[2].every(message => !message.images), 'Old screenshots must not be resent from history');
  console.log('PASS: Ollama vision capabilities/base64, offline OCR fallback, cancelled-stream isolation, no image retention in history');
}

(async () => { await autoAnswerTests(); await audioTests(); await helperTests(); await screenTests(); await aiTests(); })()
  .catch(error => { console.error(error); process.exitCode = 1; });
