// Real Electron UI, IPC, capture and OCR with synthetic permission responses.
// Does not open real OS dialogs, capture the desktop/mic, or contact cloud AI.
const { app, BrowserWindow, desktopCapturer, screen, systemPreferences, shell, dialog } = require('electron');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const fixtureDir = fs.mkdtempSync(path.join(os.tmpdir(), 'overlay-permission-smoke-'));
app.setPath('userData', fixtureDir);
app.getAppPath = () => fixtureDir;
app.getVersion = () => '1.2.0';
for (const key of ['OPENAI_API_KEY', 'ANTHROPIC_API_KEY', 'GROQ_API_KEY', 'DEEPGRAM_API_KEY', 'GOOGLE_STT_API_KEY']) process.env[key] = '';
process.on('uncaughtException', error => { console.error(error); app.exit(1); });
process.on('unhandledRejection', error => { console.error(error); app.exit(1); });
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(check, label) {
  for (let i = 0; i < 120; i++) { if (await check()) return; await pause(100); }
  throw new Error('Timed out: ' + label);
}
let access = 'denied', nextAccess = 'denied', requests = 0, captures = 0, aiRequests = 0;
let openedUrl, restartDialog, win, sourceImage;
systemPreferences.getMediaAccessStatus = () => access;
desktopCapturer.getSources = async options => {
  if (options.thumbnailSize.width === 0 && options.thumbnailSize.height === 0) {
    requests++; access = nextAccess;
    if (access !== 'granted') throw new Error('Synthetic consent not granted');
    return [];
  }
  assert.equal(access, 'granted');
  assert.equal(win.isVisible(), false, 'Overlay hidden during actual screen capture');
  captures++;
  return [{ display_id: String(screen.getPrimaryDisplay().id), thumbnail: sourceImage }];
};
shell.openExternal = async url => { openedUrl = url; };
dialog.showMessageBox = async (_window, options) => { restartDialog = options; return { response: 0 }; };
const server = http.createServer((req, res) => {
  if (req.url === '/api/chat') aiRequests++;
  res.setHeader('Content-Type', 'application/json');
  res.end(JSON.stringify(req.url === '/api/version' ? { version: 'fixture' } : { models: [] }));
});
const watchdog = setTimeout(() => { console.error('Permission smoke timed out'); app.exit(1); }, 60000);
server.listen(0, '127.0.0.1', async () => {
  try {
    fs.writeFileSync(path.join(fixtureDir, 'interview-overlay-config.json'), JSON.stringify({
      ai: { provider: 'ollama', ollamaUrl: 'http://127.0.0.1:' + server.address().port, ollamaModel: 'synthetic-text' },
      ocr: { autoCapture: false, displayId: 'cursor' }
    }));
    const main = process.argv[2] ? path.resolve(process.argv[2]) : path.resolve(__dirname, '../out/main/main.js');
    if (process.argv[2]) {
      Object.defineProperty(app, 'isPackaged', { value: true });
      Object.defineProperty(process, 'resourcesPath', { value: path.resolve(main, '../../../../') });
    }
    require(main); await app.whenReady();
    await until(() => BrowserWindow.getAllWindows()[0]?.webContents.getURL(), 'window');
    win = BrowserWindow.getAllWindows()[0];
    const js = source => win.webContents.executeJavaScript(source, true);
    await until(async () => { try { return await js('!!document.querySelector(".overlay-panel")'); } catch { return false; } }, 'renderer');
    const click = text => js(`[...document.querySelectorAll('button')].find(b => b.textContent === ${JSON.stringify(text)}).click()`);
    await js('document.querySelector("[aria-label=\\"Settings\\"]").click()');
    await until(() => js('!!document.querySelector("[aria-label=\\"Screen Capture Permission\\"]")'), 'permission settings');
    await until(() => js('document.querySelector(".settings-title").textContent.includes("1.2.0")'), 'version label');
    assert.equal(requests, 0, 'Opening settings must not prompt');
    assert.ok(await js('document.querySelector("[data-testid=screen-permission-status]").textContent.includes("needs approval")'));
    await click('Request screen access');
    await until(() => requests === 1, 'first permission request');
    await until(() => js('![...document.querySelectorAll("button")].find(b => b.textContent === "Request screen access").disabled'), 'request completes');
    assert.equal(captures, 0); assert.equal(aiRequests, 0);
    await click('Open macOS Settings');
    await until(() => !!openedUrl, 'settings button');
    assert.equal(openedUrl, 'x-apple.systempreferences:com.apple.preference.security?Privacy_ScreenCapture');
    await click('Restart app'); await until(() => !!restartDialog, 'restart confirmation');
    assert.match(restartDialog.detail, /unsaved conversation/);
    console.log('PASS LIVE: version/status shown, request reaches OS path with zero thumbnails, Settings link, restart confirmation, no AI request');

    nextAccess = 'granted';
    await click('Request screen access');
    await until(() => js('document.querySelector("[data-testid=screen-permission-status]").textContent.includes("is approved")'), 'approved status');
    assert.equal(captures, 0); assert.equal(aiRequests, 0);
    const screenshot = path.join(fixtureDir, 'permission-settings.png');
    fs.writeFileSync(screenshot, (await win.webContents.capturePage()).toPNG());
    await js('document.querySelector(".settings-btn-primary").click()');
    await until(() => js('!document.querySelector("[role=dialog]")'), 'settings closed');
    const source = new BrowserWindow({ show: false, width: 1000, height: 700, webPreferences: { sandbox: true } });
    await source.loadURL('data:text/html,' + encodeURIComponent('<html><body style="background:white;color:black;font:48px Arial;padding:60px">PERMISSION APPROVED TEST SCREEN</body></html>'));
    await pause(250); sourceImage = await source.webContents.capturePage();
    await js(`(async () => window.electronAPI.setConfig('ocr', { ...(await window.electronAPI.getConfig('ocr')), displayId: ${JSON.stringify(String(screen.getPrimaryDisplay().id))} }))()`);
    await js('window.electronAPI.runControl("captureScreen")');
    assert.equal(captures, 1); assert.equal(aiRequests, 0);
    assert.equal(win.isVisible(), true);
    assert.match(await js('window.electronAPI.getLastOcrText()'), /PERMISSION APPROVED/);

    access = 'denied'; nextAccess = 'denied'; const requestCount = requests;
    const denied = await js('window.electronAPI.runControl("captureScreen").then(() => "unexpected success", error => error.message)');
    assert.match(denied, /not approved/); assert.equal(requests, requestCount + 1); assert.equal(captures, 1);
    assert.equal(win.isVisible(), true); assert.equal(aiRequests, 0);
    access = 'restricted';
    await js('document.querySelector("[aria-label=\\"Settings\\"]").click()');
    await until(() => js('document.querySelector("[data-testid=screen-permission-status]")?.textContent.includes("restricted")'), 'restricted status');
    assert.equal(await js('[...document.querySelectorAll("button")].find(b => b.textContent === "Request screen access").disabled'), true);
    console.log('PASS LIVE: approved capture + real OCR, denial prevents captures/AI and restores overlay, restricted request disabled');
    console.log('SCREENSHOT: ' + screenshot);
    source.destroy(); clearTimeout(watchdog); server.close(); app.quit();
  } catch (error) { console.error(error); clearTimeout(watchdog); server.close(); app.exit(1); }
});
