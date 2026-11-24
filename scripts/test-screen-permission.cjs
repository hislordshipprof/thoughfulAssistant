// No real OS prompts, screenshots, keys, or network. npm run test:permissions
const assert = require('node:assert/strict');
const vm = require('node:vm');
const path = require('node:path');
const { EventEmitter } = require('node:events');
const { buildSync } = require('esbuild');
function load(file, mocks = {}, globals = {}) {
  const code = buildSync({ entryPoints: [path.resolve(__dirname, '..', file)], bundle: true,
    platform: 'node', format: 'cjs', packages: 'external', external: Object.keys(mocks), write: false }).outputFiles[0].text;
  const module = { exports: {} };
  vm.runInNewContext(code, { module, exports: module.exports, Buffer, setTimeout, clearTimeout,
    setInterval, clearInterval, AbortController, AbortSignal, process: { platform: 'darwin' },
    console: { log() {}, error() {}, warn() {} }, require: name => mocks[name] || require(name), ...globals });
  return module.exports;
}
const tick = () => new Promise(resolve => setImmediate(resolve));
const json = value => JSON.parse(JSON.stringify(value));
let access = 'denied', nextAccess, pending, rejectSources = false, revoking = false;
const calls = [];
let encoded = 0;
const display = { id: 22, size: { width: 1000, height: 800 }, scaleFactor: 1 };
const thumbnail = { isEmpty: () => false, getSize: () => display.size,
  toJPEG: () => { encoded++; return Buffer.from('jpeg'); }, toPNG: () => Buffer.from('png') };
const electron = {
  systemPreferences: { getMediaAccessStatus: () => access },
  screen: { getAllDisplays: () => [display], getDisplayNearestPoint: () => display, getCursorScreenPoint: () => ({ x: 0, y: 0 }) },
  desktopCapturer: { getSources: async options => {
    calls.push(json(options));
    if (pending) await pending;
    if (nextAccess) { access = nextAccess; nextAccess = null; }
    if (revoking) access = 'denied';
    if (rejectSources) throw new Error('Native capture failure');
    return [{ display_id: '22', thumbnail }];
  } }
};

async function permissionTests() {
  const { getScreenPermissionStatus, requestScreenPermission, ensureScreenPermission } = load('src/services/ocr/screen-permission.ts', { electron });
  assert.equal(getScreenPermissionStatus(), 'needs-approval');
  await assert.rejects(ensureScreenPermission(false), /not approved/);
  assert.equal(calls.length, 0, 'Background checks must never prompt');
  assert.equal(await requestScreenPermission(), 'needs-approval');
  assert.deepEqual(calls.at(-1), { types: ['screen'], thumbnailSize: { width: 0, height: 0 }, fetchWindowIcons: false });
  assert.equal(encoded, 0, 'Permission request must not encode images');
  nextAccess = 'granted'; await ensureScreenPermission(true);
  assert.equal(getScreenPermissionStatus(), 'granted');
  const count = calls.length; await requestScreenPermission(); assert.equal(calls.length, count);
  for (const status of ['not-determined', 'unknown', 'denied']) {
    access = status; rejectSources = true;
    await assert.rejects(ensureScreenPermission(true), /not approved/);
  }
  rejectSources = false; access = 'restricted';
  const beforeRestricted = calls.length;
  await assert.rejects(ensureScreenPermission(true), /restricted/);
  assert.equal(calls.length, beforeRestricted);
  access = 'denied';
  let resolve; pending = new Promise(r => { resolve = r; });
  const beforeConcurrent = calls.length;
  const a = requestScreenPermission(), b = requestScreenPermission();
  assert.equal(a, b); assert.equal(calls.length, beforeConcurrent + 1);
  resolve(); await Promise.all([a, b]); pending = null;
  await requestScreenPermission(); assert.equal(calls.length, beforeConcurrent + 2, 'Retry remains possible');
  const win = load('src/services/ocr/screen-permission.ts', { electron }, { process: { platform: 'win32' } });
  const beforeWindows = calls.length; await win.ensureScreenPermission(true);
  assert.equal(win.getScreenPermissionStatus(), 'not-required'); assert.equal(calls.length, beforeWindows);
  console.log('PASS: first-request path, grant/deny/restricted/unknown, coalesced requests, no thumbnails, no background prompts, Windows unchanged');
}

async function captureTests() {
  const { captureScreen } = load('src/services/ocr/screen-capture.ts', { electron });
  access = 'denied'; nextAccess = 'granted'; calls.length = 0;
  await captureScreen();
  assert.equal(calls.length, 2); assert.equal(calls[0].thumbnailSize.width, 0); assert.equal(calls[1].thumbnailSize.width, 1000);
  access = 'denied'; calls.length = 0; const before = encoded;
  await assert.rejects(captureScreen(), /not approved/);
  assert.equal(calls.length, 1); assert.equal(calls[0].thumbnailSize.width, 0); assert.equal(encoded, before);
  calls.length = 0;
  await assert.rejects(captureScreen('cursor', { allowPermissionPrompt: false }), /not approved/);
  assert.equal(calls.length, 0);
  await assert.rejects(captureScreen('disconnected'), /disconnected/); assert.equal(calls.length, 0);
  access = 'granted'; revoking = true;
  await assert.rejects(captureScreen(), /not approved/); assert.equal(encoded, before);
  revoking = false; access = 'granted'; rejectSources = true;
  await assert.rejects(captureScreen(), /Native capture failure/); rejectSources = false;
  console.log('PASS: consent before full capture, denial/revocation never encodes images, missing displays never prompt, genuine capture errors retained');
}

async function backgroundTests() {
  let timer, stopped = 0, options;
  const { OcrManager } = load('src/services/ocr/ocr-manager.ts', {
    './ocr-engine': { OcrEngine: class {} },
    './screen-capture': { captureScreen: async (_id, value) => {
      options = value; throw Object.assign(new Error('Approval needed'), { code: 'SCREEN_PERMISSION_REQUIRED' });
    } }
  }, { setInterval: cb => { timer = cb; return 1; }, clearInterval: () => { stopped++; } });
  const ocr = new OcrManager(); const errors = [];
  ocr.on('error', error => errors.push(error));
  ocr.startPeriodicCapture(); timer(); await tick();
  assert.equal(options.allowPermissionPrompt, false); assert.equal(stopped, 1); assert.equal(errors.length, 1);
  console.log('PASS: periodic capture stops on missing permission without a prompt loop');
}

async function ipcTests() {
  const handlers = {}; let settingsUrl, restartChoice = 0, relaunches = 0, quits = 0, permissionRequests = 0;
  const { registerIpcHandlers } = load('src/main/ipc-handlers.ts', {
    electron: { ipcMain: { handle: (key, fn) => { handlers[key] = fn; }, on() {} },
      app: { getVersion: () => '1.2.0', relaunch: () => { relaunches++; }, quit: () => { quits++; } },
      shell: { openExternal: async url => { settingsUrl = url; } },
      dialog: { showMessageBox: async (_window, options) => {
        assert.match(options.detail, /unsaved conversation/); assert.equal(options.cancelId, 0);
        return { response: restartChoice };
      } } },
    '../services/ocr/screen-permission': { getScreenPermissionStatus: () => 'needs-approval', requestScreenPermission: async () => { permissionRequests++; return 'granted'; } },
    '../services/ocr/screen-capture': { listDisplays: () => [] },
    '../services/ai/ollama-provider': { getOllamaStatus: async () => ({}) }
  });
  const ai = new EventEmitter(), audio = new EventEmitter(), ocr = new EventEmitter();
  audio.getTranscriptStore = () => new EventEmitter();
  registerIpcHandlers({ webContents: { send() {} } }, ai, audio, ocr, {}, new EventEmitter(), {});
  assert.deepEqual(json(handlers['screen:permission-status']()), { status: 'needs-approval', appVersion: '1.2.0' });
  assert.equal(permissionRequests, 0);
  assert.equal((await handlers['screen:permission-request']()).status, 'granted');
  await handlers['screen:permission-settings']();
  assert.equal(settingsUrl, 'x-apple.systempreferences:com.apple.preference.security?Privacy_ScreenCapture');
  assert.equal(await handlers['app:restart-for-permissions'](), false); assert.equal(relaunches, 0); assert.equal(quits, 0);
  restartChoice = 1; assert.equal(await handlers['app:restart-for-permissions'](), true);
  assert.equal(relaunches, 1); assert.equal(quits, 1);
  console.log('PASS: permission IPC, fixed Settings URL, version visibility, restart requires explicit confirmation');
}
(async () => { await permissionTests(); await captureTests(); await backgroundTests(); await ipcTests(); })().catch(error => { console.error(error); process.exitCode = 1; });
