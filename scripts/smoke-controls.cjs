// Run with: node_modules/.bin/electron scripts/smoke-controls.cjs
// Uses isolated settings and a loopback-only mock Ollama server, never user prompts.
const { app, BrowserWindow, globalShortcut } = require('electron');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');

const fixtureDir = fs.mkdtempSync(path.join(os.tmpdir(), 'overlay-controls-smoke-'));
app.setPath('userData', fixtureDir);
let lastRequest;
const server = http.createServer((req, res) => {
  if (req.url === '/api/chat') {
    let body = '';
    req.on('data', data => { body += data; });
    req.on('end', () => {
      lastRequest = JSON.parse(body);
      res.setHeader('Content-Type', 'application/x-ndjson');
      if (body.includes('SLOW_CONTROL_TEST')) {
        res.write(JSON.stringify({ message: { content: 'Partial response' }, done: false }) + '\n');
        const finish = setTimeout(() => res.end(JSON.stringify({ done: true }) + '\n'), 10000);
        res.on('close', () => clearTimeout(finish));
        return;
      }
      res.end(JSON.stringify({ message: { content: 'Local control smoke test passed.' }, done: true }) + '\n');
    });
  } else {
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify(req.url === '/api/version' ? { version: 'test' } : { models: [] }));
  }
});
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(check, message) {
  for (let i = 0; i < 100; i++) {
    if (await check()) return;
    await pause(100);
  }
  throw new Error('Timed out: ' + message);
}
const watchdog = setTimeout(() => { console.error('Smoke test timed out'); app.exit(1); }, 45000);

server.listen(0, '127.0.0.1', async () => {
  try {
    fs.writeFileSync(path.join(fixtureDir, 'interview-overlay-config.json'), JSON.stringify({
      ai: { provider: 'ollama', ollamaUrl: 'http://127.0.0.1:' + server.address().port, ollamaModel: 'test-local' },
      hotkeys: {
        toggleOverlay: { vkCodes: [0x11, 0x10, 0x48], label: 'Ctrl+Shift+H' },
        captureScreen: { vkCodes: [0x11, 0x12, 0x4B], label: 'stale custom label' }
      }, controlsVersion: 0
    }));
    require(process.argv[2] ? path.resolve(process.argv[2]) : path.resolve(__dirname, '../out/main/main.js'));
    await app.whenReady();
    await until(() => BrowserWindow.getAllWindows()[0]?.webContents.getURL(), 'window created');
    const win = BrowserWindow.getAllWindows()[0];
    const js = source => win.webContents.executeJavaScript(source, true);
    await until(async () => {
      try { return await js('!!document.querySelector("textarea.extra-context-input")'); }
      catch { return false; }
    }, 'renderer loaded');
    assert.equal(win.isVisible(), true);
    assert.equal(win.isFocusable(), false);
    assert.equal(app.dock.isVisible(), false);
    assert.ok(globalShortcut.isRegistered('Command+\\'));
    assert.ok(globalShortcut.isRegistered('Command+Enter'));
    assert.ok(globalShortcut.isRegistered('Command+Shift+Enter'));
    assert.ok(globalShortcut.isRegistered('Command+Alt+K'));
    assert.equal(globalShortcut.isRegistered('Escape'), false);
    const state = await js('window.electronAPI.getWindowState()');
    assert.equal(state.contentProtection, 'requested');
    assert.ok(await js('document.querySelector(".privacy-notice").textContent.includes("Capture protection requested")'));
    assert.ok(await js('document.querySelector(".privacy-notice").title.includes("ScreenCaptureKit")'));
    assert.ok(await js('document.querySelector("[aria-label=\\"Capture screen\\"]").title.includes("⌘⌥K")'));
    assert.equal(await js('document.querySelector("[aria-label=\\"Toggle recording\\"]").disabled'), false);
    console.log('PASS LIVE: renderer, migrated/custom shortcuts registered, Dock hidden, truthful privacy status');

    await js('document.querySelector("[aria-label=\\"Settings\\"]").click()');
    await until(() => js('!!document.querySelector("#system-prompt-mode")'), 'system prompt settings');
    await js(`(() => {
      const mode = document.querySelector('#system-prompt-mode');
      Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value').set.call(mode, 'append');
      mode.dispatchEvent(new Event('change', { bubbles: true }));
      const prompt = document.querySelector('#custom-system-prompt');
      Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set.call(prompt, 'Always begin with a synthetic headline.');
      prompt.dispatchEvent(new Event('input', { bubbles: true }));
    })()`);
    await pause(100);
    await js('document.querySelector(".prompt-preview").open = true');
    assert.ok(await js('document.querySelector(".prompt-preview pre").textContent.includes("Always begin with a synthetic headline.")'));
    await js('document.querySelector("#custom-system-prompt").scrollIntoView({ block: "center" })');
    await pause(100);
    const promptScreenshot = path.join(fixtureDir, 'system-prompt-settings.png');
    fs.writeFileSync(promptScreenshot, (await win.webContents.capturePage()).toPNG());
    console.log('SCREENSHOT PROMPT: ' + promptScreenshot);
    await js('document.querySelector(".settings-btn-primary").click()');
    await until(() => js('!document.querySelector("[role=dialog]")'), 'prompt settings saved');
    const savedPromptSettings = await js('window.electronAPI.getConfig("ai")');
    assert.equal(savedPromptSettings.systemPromptMode, 'append');
    assert.equal(savedPromptSettings.customSystemPrompt, 'Always begin with a synthetic headline.');
    console.log('PASS LIVE: custom system prompt editor, assembled preview, and persisted Append mode');

    await js('window.electronAPI.runControl("toggleInteract")');
    await until(() => js('document.body.classList.contains("full-passthrough")'), 'passthrough UI');
    await js('window.electronAPI.runControl("chat")');
    await until(() => js('document.activeElement === document.querySelector("textarea.extra-context-input")'), 'chat focus');
    assert.equal((await js('window.electronAPI.getWindowState()')).passthrough, false);
    assert.equal(win.isFocusable(), true);
    await js(`(() => {
      const input = document.querySelector('textarea.extra-context-input');
      Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set.call(input, 'Synthetic local test question');
      input.dispatchEvent(new Event('input', { bubbles: true }));
    })()`);
    await pause(100);
    // Same renderer event emitted by the globally registered Cmd+Enter callback.
    win.webContents.send('hotkey:action', 'chat');
    await until(() => !!lastRequest, 'typed prompt submitted');
    assert.ok(lastRequest.messages.some(message => message.content.includes('Synthetic local test question')));
    assert.equal(lastRequest.messages[0].role, 'system');
    assert.match(lastRequest.messages[0].content, /CUSTOM SYSTEM INSTRUCTIONS/);
    assert.match(lastRequest.messages[0].content, /Always begin with a synthetic headline\.$/);
    await until(() => js('document.body.innerText.includes("Local control smoke test passed.")'), 'stream rendered');
    assert.equal(await js('document.querySelector("textarea.extra-context-input").value'), '');
    console.log('PASS LIVE: click-through recovery, chat focus, typed question through IPC/Ollama streaming, context cleared');

    await js('window.electronAPI.runControl("submitChat", "SLOW_CONTROL_TEST")');
    await until(() => js('document.body.innerText.includes("Partial response")'), 'second stream');
    assert.equal(await js('document.body.innerText.includes("Local control smoke test passed.")'), false);
    await js('window.electronAPI.runControl("cancelStream")');
    await until(() => js('![...document.querySelectorAll(".chat-controls button")].some(button => button.textContent === "Stop")'), 'stop button state');
    console.log('PASS LIVE: new answer replaces old response; stop updates streaming UI');

    await js('window.electronAPI.runControl("exitTyping")');
    assert.equal(win.isFocusable(), false);
    await js('document.querySelector("[aria-label=\\"Hide overlay\\"]").click()');
    await until(() => !win.isVisible(), 'hide button');
    app.emit('second-instance');
    await until(() => win.isVisible(), 'recovery show');
    await js('document.querySelector("[aria-label=\\"Settings\\"]").click()');
    await until(() => js('!!document.querySelector("[role=dialog]")'), 'settings');
    assert.ok(await js('document.querySelector("[role=dialog]").innerText.includes("ScreenCaptureKit")'));
    assert.ok(await js('document.querySelector("[role=dialog]").innerText.includes("⌘⌥K")'));
    await js(`(() => {
      const checkbox = [...document.querySelectorAll('input[type=checkbox]')].find(input => input.parentElement.textContent.includes('Request capture protection'));
      checkbox.click();
    })()`);
    await pause(100);
    await js('document.querySelector(".settings-btn-primary").click()');
    await until(async () => (await js('window.electronAPI.getWindowState()')).contentProtection === 'off', 'privacy save');
    await until(() => js('!document.querySelector("[role=dialog]")'), 'settings save completed');
    await js('window.electronAPI.runControl("hideOverlay")'); app.emit('second-instance');
    assert.equal((await js('window.electronAPI.getWindowState()')).contentProtection, 'off');
    await js('(async () => window.electronAPI.setConfig("overlay", { ...(await window.electronAPI.getConfig("overlay")), captureProtection: true }))()');
    await until(async () => (await js('window.electronAPI.getWindowState()')).contentProtection === 'requested', 'privacy restored');
    await js('document.querySelector("[aria-label=\\"Settings\\"]").click()');
    await until(() => js('!!document.querySelector("[role=dialog]")'), 'reopen settings');
    await js('window.electronAPI.runControl("chat")');
    await until(() => js('!document.querySelector("[role=dialog]") && document.activeElement === document.querySelector("textarea.extra-context-input")'), 'chat focus from settings');
    assert.equal(win.isFocusable(), true);
    await js('window.electronAPI.runControl("exitTyping")');
    await until(() => js('document.querySelector(".privacy-notice").textContent.includes("Capture protection requested")'), 'renderer privacy state matches main');
    await pause(300);
    console.log('PASS LIVE: hide button, recovery show, Settings labels, privacy toggle persists across hide/show');
    const screenshot = path.join(fixtureDir, 'overlay.png');
    fs.writeFileSync(screenshot, (await win.webContents.capturePage()).toPNG());
    console.log('SCREENSHOT: ' + screenshot);
    console.log('ISOLATED SETTINGS: ' + fixtureDir);
    clearTimeout(watchdog); server.close(); app.quit();
  } catch (error) {
    console.error(error); clearTimeout(watchdog); server.close(); app.exit(1);
  }
});
