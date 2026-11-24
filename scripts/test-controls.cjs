const assert = require('node:assert/strict');
const vm = require('node:vm');
const { EventEmitter } = require('node:events');
const { buildSync } = require('esbuild');
const path = require('node:path');

function load(file, electron, platform = 'darwin') {
  const code = buildSync({ entryPoints: [path.resolve(__dirname, '..', file)], bundle: true,
    platform: 'node', format: 'cjs', external: ['electron'], write: false }).outputFiles[0].text;
  const module = { exports: {} };
  vm.runInNewContext(code, {
    module, exports: module.exports, __dirname: __dirname, Buffer, setTimeout,
    process: { platform, resourcesPath: '/unavailable' },
    console: { log() {}, warn() {}, error() {} },
    require: name => name === 'electron' ? electron : require(name)
  });
  return module.exports;
}
const { defaultHotkeys, migrateControls, acceleratorFor, shortcutLabel } = load('src/shared/controls.ts');
const mac = defaultHotkeys('darwin');
assert.equal(acceleratorFor(mac.toggleOverlay.vkCodes, 'darwin'), 'Command+\\');
assert.equal(acceleratorFor(mac.chat.vkCodes, 'darwin'), 'Command+Enter');
assert.equal(acceleratorFor(mac.askAi.vkCodes, 'darwin'), 'Command+Shift+Enter');
assert.equal(shortcutLabel([0x11, 0x12, 0x25], 'darwin'), '⌘⌥←');
const old = defaultHotkeys('win32');
old.captureScreen = { vkCodes: [0xA2, 0x12, 0x4B], label: 'custom stale label' };
const migrated = migrateControls(old, 'darwin', 0);
assert.equal(migrated.toggleOverlay.label, '⌘\\');
assert.equal(migrated.askAi.label, '⌘⇧↵');
assert.equal(migrated.captureScreen.label, '⌘⌥K');
assert.equal(migrated.cancelStream.label, '⌘⇧X');
assert.deepEqual(migrateControls(migrated, 'darwin', 1), migrated);
assert.equal(migrateControls(old, 'win32', 0).askAi.label, 'Ctrl+Shift+A');
assert.equal(new Set(Object.values(mac).map(b => acceleratorFor(b.vkCodes, 'darwin'))).size, Object.keys(mac).length);
console.log('PASS: Mac mappings, legacy migration, custom bindings, idempotence, Windows defaults, no collisions');

class MockWindow extends EventEmitter {
  constructor(options) {
    super(); this.options = options; this.visible = false; this.focused = false;
    this.bounds = { x: options.x, y: options.y, width: options.width, height: options.height };
    this.events = []; this.webContents = { send: (...args) => this.events.push(args), isDestroyed: () => false };
  }
  setAlwaysOnTop() {} setVisibleOnAllWorkspaces() {}
  setContentProtection(value) { this.protected = value; }
  isContentProtected() { return this.protected; }
  setIgnoreMouseEvents(value) { this.ignoring = value; }
  setFocusable(value) { this.focusable = value; }
  focus() { this.focused = true; }
  blur() { this.focused = false; }
  isFocused() { return this.focused; }
  isVisible() { return this.visible; }
  isDestroyed() { return false; }
  showInactive() { assert.equal(this.focused, false); this.visible = true; this.emit('show'); }
  hide() { this.visible = false; this.emit('hide'); }
  getBounds() { return this.bounds; }
  getPosition() { return [this.bounds.x, this.bounds.y]; }
  setPosition(x, y) { Object.assign(this.bounds, { x, y }); }
  setSize(width, height) { Object.assign(this.bounds, { width, height }); }
}
const display = { workArea: { x: 0, y: 25, width: 1200, height: 775 }, workAreaSize: { width: 1200, height: 775 } };
const { WindowManager } = load('src/main/window-manager.ts', {
  BrowserWindow: MockWindow, screen: { getPrimaryDisplay: () => display, getDisplayMatching: () => display }
});
const manager = new WindowManager();
const win = manager.createOverlayWindow({ x: 100, y: 100, width: 500, height: 600, opacity: 0.85 });
assert.equal(win.options.show, false);
assert.equal(win.protected, true);
assert.equal(manager.getState().contentProtection, 'requested');
assert.match(manager.getState().protectionNote, /ScreenCaptureKit/);
win.emit('ready-to-show');
assert.equal(win.visible, true);
assert.equal(win.focused, false);
manager.setContentProtection(false); manager.hide(); manager.stealthShow();
assert.equal(win.protected, false, 'show must not silently re-enable disabled protection');
manager.toggleVisibility(); assert.equal(win.visible, false);
manager.stealthShow(); manager.toggleVisibility(); assert.equal(win.visible, false, 'toggle reads native visibility');
manager.setFullPassthrough(true); assert.equal(win.ignoring, true);
manager.handleSmartHitTest(false); assert.equal(win.ignoring, true);
manager.setFullPassthrough(false); assert.equal(win.ignoring, false, 'immediate click-through recovery');
manager.setFocusableForInput(true); assert.equal(win.visible, true); assert.equal(win.focused, true);
manager.setFocusableForInput(false); assert.equal(win.focused, false);
manager.moveBy(-10000, 10000); assert.equal(win.bounds.x, 0); assert.equal(win.bounds.y, 200);
win.setContentProtection = () => { throw new Error('unsupported'); };
manager.setContentProtection(true); assert.equal(manager.getState().contentProtection, 'unavailable');
console.log('PASS: protection before show, opt-out persistence, no focus steal, hide/show, click-through, focus release, bounds, failure status');

const registrations = new Map();
const shortcuts = {
  register: (key, callback) => {
    if (key === 'Command+Shift+S') return false;
    if (key === 'Command+Shift+R') throw new Error('invalid accelerator');
    registrations.set(key, callback); return true;
  },
  unregister: key => registrations.delete(key)
};
const { HotkeyManager } = load('src/main/hotkey-manager.ts', { globalShortcut: shortcuts });
const hotkeys = new HotkeyManager();
hotkeys.registerHotkeys(mac); hotkeys.start();
assert.equal(hotkeys.getFailedShortcuts().join(','), 'captureScreen,toggleRecording');
assert.ok(registrations.has('Command+\\'));
assert.ok(!registrations.has('Escape'));
let fired; hotkeys.on('hotkey', action => { fired = action; });
registrations.get('Command+Enter')(); assert.equal(fired, 'chat');
hotkeys.stop(); assert.equal(registrations.size, 0);
console.log('PASS: accelerator registration, callback dispatch, conflicts surfaced, no global Escape, cleanup');

(async () => {
  manager.stealthShow();
  await manager.withoutOverlay(async () => { assert.equal(win.visible, false); });
  assert.equal(win.visible, true);
  await assert.rejects(manager.withoutOverlay(async () => { throw new Error('capture denied'); }), /capture denied/);
  assert.equal(win.visible, true, 'Failure must restore the overlay');
  await manager.withoutOverlay(async () => { manager.hide(); });
  assert.equal(win.visible, false, 'User Hide during capture wins over auto-restore');
  await manager.withoutOverlay(async () => {});
  assert.equal(win.visible, false, 'Already-hidden overlay stays hidden');
  console.log('PASS: own-capture exclusion, restore after failure, manual Hide and hidden state respected');
})().catch(error => { console.error(error); process.exitCode = 1; });
