// Actual Electron UI + SDK/SSE + OCR. Synthetic keys/screens and loopback only.
// Optional argument: release/.../Resources/app.asar/out/main/main.js
const { app, BrowserWindow, desktopCapturer, screen, systemPreferences } = require('electron');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const Module = require('node:module');
const RealOpenAI = require('openai');
const fixtureDir = fs.mkdtempSync(path.join(os.tmpdir(), 'overlay-groq-smoke-'));
app.setPath('userData', fixtureDir);
app.getAppPath = () => fixtureDir; // Never load a real project .env.
for (const key of ['OPENAI_API_KEY', 'ANTHROPIC_API_KEY', 'GROQ_API_KEY', 'DEEPGRAM_API_KEY', 'GOOGLE_STT_API_KEY']) process.env[key] = '';
process.on('uncaughtException', error => { console.error(error); app.exit(1); });
process.on('unhandledRejection', error => { console.error(error); app.exit(1); });
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(check, label) {
  for (let i = 0; i < 150; i++) { if (await check()) return; await pause(100); }
  throw new Error('Timed out: ' + label);
}
const requests = [];
let win, sourceImage, captures = 0, aborted = 0;
systemPreferences.getMediaAccessStatus = () => 'granted';
desktopCapturer.getSources = async () => {
  assert.equal(win.isVisible(), false); captures++;
  return [{ display_id: String(screen.getPrimaryDisplay().id), thumbnail: sourceImage }];
};
const server = http.createServer((req, res) => {
  let raw = ''; req.on('data', chunk => { raw += chunk; });
  req.on('end', () => {
    if (req.url !== '/openai/v1/chat/completions') {
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify(req.url === '/api/version' ? { version: 'fixture' } : { models: [] })); return;
    }
    const body = JSON.parse(raw); requests.push(body);
    assert.equal(req.headers.authorization, 'Bearer synthetic-groq-key');
    if (body.model === 'unavailable-model') {
      res.writeHead(404, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: { message: 'Synthetic model not found', type: 'invalid_request_error' } })); return;
    }
    res.setHeader('Content-Type', 'text/event-stream');
    const slow = raw.includes('SLOW_GROQ_FIXTURE');
    res.write('data: ' + JSON.stringify({ choices: [{ delta: { content: slow ? 'Partial Groq fixture' : 'Groq fixture answer ' + requests.length } }] }) + '\n\n');
    const finish = () => res.end('data: ' + JSON.stringify({ choices: [{ delta: {}, finish_reason: 'stop' }] }) + '\n\ndata: [DONE]\n\n');
    if (slow) {
      const timer = setTimeout(finish, 20000);
      res.on('close', () => { clearTimeout(timer); aborted++; });
    } else finish();
  });
});
const watchdog = setTimeout(() => { console.error('Groq smoke timed out'); app.exit(1); }, 90000);
server.listen(0, '127.0.0.1', async () => {
  try {
    const loopback = 'http://127.0.0.1:' + server.address().port;
    // Only the test harness redirects the fixed production URL; production has
    // no endpoint override or test mode. The real SDK still handles HTTP/SSE.
    class TestOpenAI extends RealOpenAI {
      constructor(options) {
        assert.equal(options.baseURL, 'https://api.groq.com/openai/v1');
        assert.equal(options.apiKey, 'synthetic-groq-key');
        super({ ...options, baseURL: loopback + '/openai/v1' });
      }
    }
    const originalLoad = Module._load;
    Module._load = function (request, parent, isMain) {
      return request === 'openai' ? TestOpenAI : originalLoad.call(this, request, parent, isMain);
    };
    fs.writeFileSync(path.join(fixtureDir, 'interview-overlay-config.json'), JSON.stringify({
      ai: { provider: 'ollama', ollamaUrl: loopback, ollamaModel: 'existing-model' },
      audio: { transcriptionMode: 'macos-speech', groqKey: 'synthetic-speech-key', macDefaultsApplied: true },
      ocr: { autoCapture: false, displayId: 'cursor' }
    }));
    const main = process.argv[2] ? path.resolve(process.argv[2]) : path.resolve(__dirname, '../out/main/main.js');
    if (process.argv[2]) {
      Object.defineProperty(app, 'isPackaged', { value: true });
      Object.defineProperty(process, 'resourcesPath', { value: path.resolve(main, '../../../../') });
    }
    require(main);
    await app.whenReady();
    await until(() => BrowserWindow.getAllWindows()[0]?.webContents.getURL(), 'window');
    win = BrowserWindow.getAllWindows()[0];
    const js = source => win.webContents.executeJavaScript(source, true);
    await until(async () => { try { return await js('!!document.querySelector(".overlay-panel")'); } catch { return false; } }, 'renderer');
    async function settings() {
      await js('document.querySelector("[aria-label=\\"Settings\\"]").click()');
      await until(() => js('!!document.querySelector("#ai-provider")'), 'settings loaded');
    }
    async function edit(selector, value, select = false) {
      await js(`(() => {
        const element = document.querySelector(${JSON.stringify(selector)});
        Object.getOwnPropertyDescriptor(${select ? 'HTMLSelectElement' : 'HTMLInputElement'}.prototype, 'value').set.call(element, ${JSON.stringify(value)});
        element.dispatchEvent(new Event('${select ? 'change' : 'input'}', { bubbles: true }));
      })()`);
      await pause(60);
    }
    async function save() {
      await js('document.querySelector(".settings-btn-primary").click()');
      await until(() => js('!document.querySelector("[role=dialog]")'), 'saved');
    }
    await settings(); await edit('#ai-provider', 'groq', true);
    assert.equal(await js('document.querySelector("#groq-answer-key").type'), 'password');
    assert.ok(await js('document.querySelector("#groq-model-help").textContent.includes("OCR")'));
    await save();
    const missing = await js('window.electronAPI.runControl("askAi").then(() => "unexpected success", error => error.message)');
    assert.match(missing, /groq API key/); assert.equal(requests.length, 0); assert.equal(captures, 0);
    await settings(); await edit('#groq-answer-key', 'synthetic-groq-key');
    await edit('#groq-answer-model', 'openai/gpt-oss-20b'); await save();
    const saved = await js('window.electronAPI.getConfig()');
    assert.equal(saved.ai.provider, 'groq'); assert.equal(saved.ai.groqModel, 'openai/gpt-oss-20b');
    assert.equal(saved.ai.ollamaModel, 'existing-model'); assert.equal(saved.audio.groqKey, 'synthetic-speech-key');
    assert.equal(saved.audio.transcriptionMode, 'macos-speech');
    const disk = JSON.parse(fs.readFileSync(path.join(fixtureDir, 'interview-overlay-config.json'), 'utf8'));
    assert.equal(disk.ai.groqModel, saved.ai.groqModel);
    await settings(); assert.equal(await js('document.querySelector("#groq-answer-model").value'), 'openai/gpt-oss-20b');
    const screenshot = path.join(fixtureDir, 'groq-settings.png');
    fs.writeFileSync(screenshot, (await win.webContents.capturePage()).toPNG());
    await save();
    console.log('PASS LIVE: selectable Groq, masked key, model UI, persisted settings, no provider/audio changes, missing key blocks before capture');

    await js('window.electronAPI.runControl("submitChat", "Synthetic Groq question")');
    await until(() => js('document.body.innerText.includes("Groq fixture answer 1")'), 'SSE answer rendered');
    assert.equal(requests[0].model, 'openai/gpt-oss-20b');
    assert.match(requests[0].messages.at(-1).content, /Synthetic Groq question/);
    await js('window.electronAPI.runControl("submitChat", "SLOW_GROQ_FIXTURE")');
    await until(() => js('document.body.innerText.includes("Partial Groq fixture")'), 'partial answer');
    await js('window.electronAPI.runControl("cancelStream")');
    await until(() => aborted === 1, 'HTTP request aborted');
    console.log('PASS LIVE: real OpenAI-compatible SSE streaming through IPC/UI, Stop aborts HTTP request');

    const source = new BrowserWindow({ show: false, width: 1200, height: 800, webPreferences: { sandbox: true } });
    await source.loadURL('data:text/html,' + encodeURIComponent('<html><body style="background:white;color:black;font:48px Arial;padding:60px">GROQ SCREEN: What is 12 plus 30?</body></html>'));
    await pause(250); sourceImage = await source.webContents.capturePage();
    await js(`(async () => window.electronAPI.setConfig('ocr', { ...(await window.electronAPI.getConfig('ocr')), displayId: ${JSON.stringify(String(screen.getPrimaryDisplay().id))} }))()`);
    await js('window.electronAPI.runControl("askAi")');
    await until(() => requests.length === 3, 'OCR answer request');
    assert.match(requests.at(-1).messages.at(-1).content, /GROQ SCREEN/);
    assert.equal(typeof requests.at(-1).messages.at(-1).content, 'string');
    await until(() => js('document.body.innerText.includes("Groq fixture answer 3")'), 'OCR answer rendered');
    await settings(); await edit('#groq-answer-model', 'qwen/qwen3.8-27b');
    assert.ok(await js('document.querySelector("#groq-model-help").textContent.includes("captured screen images")'));
    await save(); await js('window.electronAPI.runControl("askAi")');
    await until(() => requests.length === 4, 'vision answer request');
    const parts = requests.at(-1).messages.at(-1).content;
    assert.equal(parts[1].type, 'image_url'); assert.match(parts[1].image_url.url, /^data:image\/jpeg;base64,/);
    assert.equal(requests.at(-1).reasoning_format, 'hidden');
    await until(() => js('document.body.innerText.includes("Groq fixture answer 4")'), 'vision answer rendered');
    await js('window.electronAPI.runControl("resetAll")');
    await settings(); await edit('#groq-answer-model', 'unavailable-model'); await save();
    await js('window.electronAPI.runControl("submitChat", "Synthetic unavailable model")');
    await until(() => js('document.body.innerText.includes("Groq model not found")'), 'model error rendered');
    assert.equal(requests.length, 5); assert.equal(captures, 2); assert.equal(win.isVisible(), true);
    console.log('PASS LIVE: real OCR-to-Groq text, screen-to-Groq vision, actionable model errors without fallback');
    console.log('SCREENSHOT: ' + screenshot);
    source.destroy(); clearTimeout(watchdog); server.close(); app.quit();
  } catch (error) { console.error(error); clearTimeout(watchdog); server.close(); app.exit(1); }
});
