// Real Electron/preload/renderer + real OCR, with synthetic capture/audio and loopback AI.
// This deliberately does not request OS permissions, listen to a mic, or capture the desktop.
const { app, BrowserWindow, desktopCapturer, screen, systemPreferences } = require('electron');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const { EventEmitter } = require('node:events');
const { PassThrough } = require('node:stream');
const childProcess = require('child_process');
process.on('uncaughtException', error => { console.error('UNCAUGHT TEST ERROR:', error); app.exit(1); });
process.on('unhandledRejection', error => { console.error('UNHANDLED TEST ERROR:', error); app.exit(1); });
const fixtureDir = fs.mkdtempSync(path.join(os.tmpdir(), 'overlay-media-smoke-'));
app.setPath('userData', fixtureDir);
app.getAppPath = () => fixtureDir; // Never load a real project .env.
for (const name of ['OPENAI_API_KEY', 'ANTHROPIC_API_KEY', 'DEEPGRAM_API_KEY', 'GROQ_API_KEY', 'GOOGLE_STT_API_KEY']) process.env[name] = '';
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(check, label) {
  for (let i = 0; i < 150; i++) { if (await check()) return; await pause(100); }
  throw new Error('Timed out: ' + label);
}
let win, sourceImage, lastRequest, requestCount = 0, captures = 0, vision = false, permission = 'granted';
let nextAudio = 'ready', currentChild;
const spawn = childProcess.spawn;
childProcess.spawn = (file, args, options) => {
  if (!file.endsWith('/overlay-audio')) return spawn(file, args, options);
  const child = new EventEmitter();
  Object.assign(child, { stdin: new PassThrough(), stdout: new PassThrough(), stderr: new PassThrough(), exitCode: null });
  child.kill = () => { child.exitCode = 0; child.emit('exit', 0); };
  child.stdin.on('finish', child.kill); currentChild = child;
  setTimeout(() => {
    if (child.exitCode !== null || nextAudio === 'pending') return;
    child.stdout.write(JSON.stringify(nextAudio === 'denied'
      ? { type: 'error', message: 'Synthetic microphone permission denied. Open Audio settings.' }
      : { type: 'ready', microphone: true, system: true }) + '\n');
  }, 50);
  return child;
};
systemPreferences.getMediaAccessStatus = () => permission;
desktopCapturer.getSources = async () => {
  assert.equal(win.isVisible(), false, 'Overlay must hide before taking a screen image');
  captures++;
  return [{ display_id: String(screen.getPrimaryDisplay().id), thumbnail: sourceImage }];
};
const server = http.createServer((req, res) => {
  let body = ''; req.on('data', data => { body += data; });
  req.on('end', () => {
    if (req.url === '/api/show') res.end(JSON.stringify({ capabilities: vision ? ['completion', 'vision'] : ['completion'] }));
    else if (req.url === '/api/chat') {
      lastRequest = JSON.parse(body); requestCount++;
      res.end(JSON.stringify({ message: { content: 'Synthetic answer ' + requestCount }, done: true }) + '\n');
    } else res.end(JSON.stringify(req.url === '/api/version' ? { version: 'test' } : { models: [] }));
  });
});
const watchdog = setTimeout(() => { console.error('Media smoke timed out'); app.exit(1); }, 90000);
server.listen(0, '127.0.0.1', async () => {
  try {
    fs.writeFileSync(path.join(fixtureDir, 'interview-overlay-config.json'), JSON.stringify({
      ai: { provider: 'ollama', ollamaUrl: 'http://127.0.0.1:' + server.address().port, ollamaModel: 'synthetic-text' },
      audio: { transcriptionMode: 'macos-speech', captureMicrophone: true, captureSystemAudio: true, autoAnswer: true, macDefaultsApplied: true },
      ocr: { autoCapture: false, displayId: 'cursor' }
    }));
    // Optional packaged ASAR verification uses that bundle's resources without touching installed settings.
    if (process.argv[2]) {
      const main = path.resolve(process.argv[2]);
      Object.defineProperty(app, 'isPackaged', { value: true });
      Object.defineProperty(process, 'resourcesPath', { value: path.resolve(main, '../../../../') });
    }
    require(process.argv[2] ? path.resolve(process.argv[2]) : path.resolve(__dirname, '../out/main/main.js'));
    await app.whenReady();
    await until(() => BrowserWindow.getAllWindows()[0]?.webContents.getURL(), 'main window');
    win = BrowserWindow.getAllWindows()[0];
    console.log('CHECK: main window created');
    win.webContents.on('did-fail-load', (_event, code, description) => console.error('Renderer load failed:', code, description));
    win.webContents.on('render-process-gone', (_event, details) => console.error('Renderer exited:', details));
    const js = code => Promise.race([win.webContents.executeJavaScript(code, true),
      new Promise((_, reject) => { const timer = setTimeout(() => reject(new Error('Renderer JS timeout: ' + code.slice(0, 100))), 10000); timer.unref(); })]);
    await until(async () => { try { return await js('!!document.querySelector(".overlay-panel")'); } catch { return false; } }, 'renderer');
    console.log('CHECK: renderer loaded');
    await js(`(async () => window.electronAPI.setConfig('ocr', { ...(await window.electronAPI.getConfig('ocr')), displayId: ${JSON.stringify(String(screen.getPrimaryDisplay().id))} }))()`);
    console.log('CHECK: display configured');
    assert.equal(await js('document.querySelector("[aria-label=\\"Toggle recording\\"]").disabled'), false);
    await js('document.querySelector("[aria-label=\\"Toggle recording\\"]").click()');
    await until(async () => (await js('window.electronAPI.getAudioStatus()')).isRecording, 'record state');
    currentChild.stdout.write(JSON.stringify({ type: 'level', source: 'mic', level: 0.6 }) + '\n');
    currentChild.stdout.write(JSON.stringify({ type: 'transcript', source: 'system', text: 'Synthetic meeting question', isFinal: true }) + '\n');
    await until(() => js('document.querySelector("meter[aria-label=\\"Microphone input level\\"]")?.value > 0.5'), 'input meter');
    await js(`[...document.querySelectorAll('.overlay-tab')].find(button => button.textContent.includes('Transcript')).click()`);
    await until(() => js('document.body.innerText.includes("Synthetic meeting question")'), 'transcript UI');
    await until(() => requestCount === 1, 'automatic answer from finalized system audio');
    assert.match(lastRequest.messages.at(-1).content, /Synthetic meeting question/);
    assert.equal(lastRequest.messages.at(-1).images, undefined);
    assert.equal(await js('[...document.querySelectorAll(".overlay-tab")].find(button => button.textContent === "Assist").classList.contains("active")'), true);
    await js('window.electronAPI.runControl("toggleRecording")');
    assert.equal((await js('window.electronAPI.getAudioStatus()')).isRecording, false);
    assert.equal(currentChild.exitCode, 0);
    nextAudio = 'denied';
    await js('document.querySelector("[aria-label=\\"Toggle recording\\"]").click()');
    await until(() => js('document.body.innerText.includes("Synthetic microphone permission denied")'), 'permission failure UI');
    assert.equal((await js('window.electronAPI.getAudioStatus()')).isRecording, false);
    nextAudio = 'pending';
    await js('document.querySelector("[aria-label=\\"Toggle recording\\"]").click()');
    await until(async () => (await js('window.electronAPI.getAudioStatus()')).isStarting, 'starting state');
    await js('window.electronAPI.runControl("toggleRecording")');
    assert.equal((await js('window.electronAPI.getAudioStatus()')).isStarting, false);
    console.log('PASS LIVE: enabled Record, source state, level meter, transcript, automatic answer, Stop cleanup, permission failure, cancel during startup');

    const source = new BrowserWindow({ show: false, width: 1200, height: 800, webPreferences: { sandbox: true } });
    async function fixture(text) {
      await source.loadURL('data:text/html,' + encodeURIComponent('<html><body style="background:white;color:black;font:48px Arial;padding:60px">' + text + '</body></html>'));
      await pause(250); sourceImage = await source.webContents.capturePage();
    }
    await fixture('SCREEN ALPHA: What is 12 plus 30?');
    await js('window.electronAPI.runControl("askAi")');
    await until(() => requestCount === 2, 'OCR request');
    assert.match(lastRequest.messages.at(-1).content, /SCREEN ALPHA/);
    assert.equal(lastRequest.messages.at(-1).images, undefined);
    assert.equal(win.isVisible(), true);
    await fixture('SCREEN BETA: What is 8 times 7?');
    await js('window.electronAPI.runControl("askAi")');
    await until(() => requestCount === 3, 'fresh OCR request');
    assert.match(lastRequest.messages.at(-1).content, /SCREEN BETA/);
    assert.doesNotMatch(lastRequest.messages.at(-1).content, /SCREEN ALPHA/);
    assert.equal(await js('document.querySelectorAll(".screenshot-thumb").length'), 1);
    assert.equal(captures, 2);
    vision = true;
    await js(`(async () => window.electronAPI.setConfig('ai', { ...(await window.electronAPI.getConfig('ai')), ollamaModel: 'synthetic-vision' }))()`);
    await js('window.electronAPI.runControl("askAi")');
    await until(() => requestCount === 4, 'vision request');
    const images = lastRequest.messages.at(-1).images;
    assert.equal(images.length, 1); assert.equal(Buffer.from(images[0], 'base64')[0], 0xff);
    assert.ok(!images[0].startsWith('data:'));
    permission = 'denied';
    const deniedScreen = await js('window.electronAPI.runControl("askAi").then(() => "unexpected success", error => error.message)');
    assert.match(deniedScreen, /not approved/); assert.equal(requestCount, 4);
    assert.equal(win.isVisible(), true, 'Screen failure restores the overlay');
    console.log('PASS LIVE: real OCR, fresh screen replacement, overlay excluded from own capture, Ollama image payload, denied screen fails closed');
    await js(`[...document.querySelectorAll('.overlay-tab')].find(button => button.textContent === 'Assist').click()`);
    await pause(100);
    const screenshot = path.join(fixtureDir, 'media-controls.png');
    fs.writeFileSync(screenshot, (await win.webContents.capturePage()).toPNG());
    console.log('SCREENSHOT: ' + screenshot);
    source.destroy(); clearTimeout(watchdog); server.close(); app.quit();
  } catch (error) { console.error(error); clearTimeout(watchdog); server.close(); app.exit(1); }
});
