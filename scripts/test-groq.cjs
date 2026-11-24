// No network, credentials, ambient audio, or user config. Run: npm run test:groq
const assert = require('node:assert/strict');
const vm = require('node:vm');
const path = require('node:path');
const { buildSync } = require('esbuild');

function load(file, mocks = {}) {
  const code = buildSync({ entryPoints: [path.resolve(__dirname, '..', file)], bundle: true,
    platform: 'node', format: 'cjs', packages: 'external', external: Object.keys(mocks), write: false }).outputFiles[0].text;
  const module = { exports: {} };
  vm.runInNewContext(code, { module, exports: module.exports, Buffer, AbortController, AbortSignal,
    setTimeout, clearTimeout, TextDecoder, TextEncoder, process: { platform: 'darwin', env: {} },
    console: { log() {}, warn() {}, error() {} },
    require: name => Object.hasOwn(mocks, name) ? mocks[name] : require(name) });
  return module.exports;
}
const json = value => JSON.parse(JSON.stringify(value));
const deferred = () => { let resolve; const promise = new Promise(r => { resolve = r; }); return { promise, resolve }; };
const tick = () => new Promise(resolve => setImmediate(resolve));
const requests = [], clients = [];
let failWith = null, finishReason = 'stop', empty = false, handler;
class FakeOpenAI {
  constructor(options) {
    clients.push(options);
    this.chat = { completions: { create: async (body, options) => {
      requests.push({ body, options });
      if (handler) return handler(body, options);
      if (failWith) throw failWith;
      return (async function* () {
        yield { choices: [] }; // usage-only / keep-alive event
        if (!empty) yield { choices: [{ delta: { content: 'Groq answer' } }] };
        yield { choices: [{ delta: {}, finish_reason: finishReason }] };
      })();
    } } };
  }
}
const { GroqProvider } = load('src/services/ai/groq-provider.ts', { openai: FakeOpenAI });
const events = [];
const collect = event => events.push(event);
const messages = [{ role: 'system', content: 'Be helpful' }, { role: 'user', content: 'Synthetic question' }];

async function providerTests() {
  const provider = new GroqProvider('');
  await provider.streamChat(messages, collect);
  assert.equal(events.at(-1).type, 'error'); assert.equal(requests.length, 0);
  provider.setApiKey('  synthetic-secret  ');
  assert.equal(provider.isConfigured(), true);
  assert.deepEqual(json(clients.at(-1)), { apiKey: 'synthetic-secret', baseURL: 'https://api.groq.com/openai/v1', timeout: 60000, maxRetries: 0 });
  events.length = 0;
  await provider.streamChat(messages, collect);
  assert.deepEqual(json(events), [{ type: 'token', content: 'Groq answer' }, { type: 'done', content: '' }]);
  assert.deepEqual(json(requests.at(-1).body.messages), messages);
  assert.equal(requests.at(-1).body.model, 'openai/gpt-oss-120b');
  assert.equal(requests.at(-1).body.stream, true);
  assert.equal(requests.at(-1).body.max_completion_tokens, 4096);
  assert.equal(requests.at(-1).body.include_reasoning, false);
  assert.equal(requests.at(-1).body.reasoning_format, undefined);
  assert.equal(await provider.supportsImages(), false);

  provider.setModel(' qwen/qwen3.8-27b ');
  assert.equal(await provider.supportsImages(), true);
  const image = 'data:image/jpeg;base64,c3ludGhldGlj';
  await provider.streamChat([...messages, { role: 'user', content: 'Screen question', images: [image] }], collect);
  const body = requests.at(-1).body;
  assert.deepEqual(json(body.messages.at(-1).content), [{ type: 'text', text: 'Screen question' }, { type: 'image_url', image_url: { url: image } }]);
  assert.equal(body.reasoning_format, 'hidden'); assert.equal(body.include_reasoning, undefined);
  provider.setModel('unknown-custom-model');
  assert.equal(await provider.supportsImages(), false);
  const before = requests.length;
  await provider.streamChat([{ role: 'user', content: 'Screen', images: [image] }], collect);
  assert.equal(requests.length, before); assert.match(events.at(-1).content, /no verified image support/);
  await provider.streamChat(messages, collect);
  assert.equal(requests.at(-1).body.model, 'unknown-custom-model');
  assert.equal(requests.at(-1).body.reasoning_effort, undefined);
  console.log('PASS: Groq-only endpoint/key, streamed text, verified vision payload, unknown-model OCR safety, model-specific reasoning parameters');

  for (const [status, expected] of [[401, /rejected the API key/], [403, /access denied/], [404, /model not found/],
    [413, /too large/], [429, /quota limit/], [400, /rejected this request/], [422, /rejected this request/], [503, /temporarily unavailable/]]) {
    failWith = { status, message: 'DO NOT LEAK synthetic-secret or prompt' };
    events.length = 0; await provider.streamChat(messages, collect);
    assert.equal(events.length, 1); assert.equal(events[0].type, 'error');
    assert.match(events[0].content, expected); assert.doesNotMatch(events[0].content, /DO NOT LEAK|synthetic-secret/);
  }
  failWith = { name: 'APIConnectionTimeoutError' };
  await provider.streamChat(messages, collect); assert.match(events.at(-1).content, /timed out/);
  failWith = new Error('network unavailable');
  await provider.streamChat(messages, collect); assert.match(events.at(-1).content, /internet connection/);
  failWith = null; empty = true;
  await provider.streamChat(messages, collect); assert.match(events.at(-1).content, /complete text answer/);
  empty = false; finishReason = 'length';
  await provider.streamChat(messages, collect); assert.match(events.at(-1).content, /output limit/);
  finishReason = null;
  await provider.streamChat(messages, collect); assert.match(events.at(-1).content, /complete text answer/);
  finishReason = 'stop';
  console.log('PASS: auth, access, model, quota, network, timeout, empty/truncated streams; no raw error/key leakage');

  const first = deferred(), second = deferred();
  let index = 0;
  handler = async () => (async function* () {
    await (++index === 1 ? first.promise : second.promise);
    yield { choices: [{ delta: { content: 'late' }, finish_reason: 'stop' }] };
  })();
  events.length = 0;
  const a = provider.streamChat(messages, collect); await tick();
  const oldSignal = requests.at(-1).options.signal;
  const b = provider.streamChat(messages, collect); await tick();
  const newSignal = requests.at(-1).options.signal;
  assert.equal(oldSignal.aborted, true);
  first.resolve(); await a;
  assert.equal(newSignal.aborted, false);
  provider.cancelStream(); assert.equal(newSignal.aborted, true);
  second.resolve(); await b; assert.equal(events.length, 0);
  handler = undefined; provider.setApiKey('');
  assert.equal(provider.isConfigured(), false);
  console.log('PASS: overlapping streams, stop abort, no stale tokens/done, removing key disables Groq');
}

async function managerTests() {
  let otherRequests = 0;
  class OtherProvider {
    name = 'openai'; isConfigured() { return true; }
    async streamChat() { otherRequests++; } cancelStream() {}
  }
  const { AiManager } = load('src/services/ai/ai-manager.ts', {
    openai: FakeOpenAI, './openai-provider': { OpenAiProvider: OtherProvider }
  });
  const manager = new AiManager();
  manager.initializeProviders('fake-openai', '', undefined, undefined, 'http://127.0.0.1:11434', 'fake-ollama');
  const errors = []; manager.on('error', error => errors.push(error));
  assert.equal(manager.setActiveProvider('groq'), false);
  assert.match(manager.getConfigurationError(), /groq API key/);
  assert.match(manager.getActiveProviderName(), /^groq/);
  const before = requests.length;
  await manager.ask('', '', 'Do not fall back');
  assert.equal(otherRequests, 0); assert.equal(requests.length, before); assert.equal(errors.length, 1);
  manager.updateApiKey('groq', 'fake-groq'); manager.setModel('groq', 'qwen/qwen3.8-27b');
  assert.equal(manager.setActiveProvider('groq'), true);
  assert.equal(manager.getConfigurationError(), null);
  assert.equal(await manager.supportsImages(), true);
  await manager.ask('Synthetic transcript', '', 'Image question', 'general', '', '', ['data:image/jpeg;base64,AA==']);
  await manager.ask('', '', 'Follow-up');
  const sent = json(requests.at(-1).body.messages);
  assert.ok(sent.some(m => m.content.includes('Image question')));
  assert.ok(sent.every(m => typeof m.content === 'string'));
  manager.updateApiKey('groq', '');
  await manager.ask('', '', 'Removed key'); assert.equal(errors.length, 2);
  assert.equal(otherRequests, 0);
  manager.setActiveProvider('unknown');
  await manager.ask('', '', 'No selection'); assert.equal(errors.length, 3);
  console.log('PASS: manager selection, reconfiguration, current-turn images only, missing/removed key fails closed');
}

function configTests() {
  let saved;
  class Store {
    constructor({ defaults }) {
      saved = json(defaults);
      saved.ai = { provider: 'ollama', ollamaUrl: 'http://127.0.0.1:11434', ollamaModel: 'existing-model', openaiKey: 'existing-key' };
      delete saved.audio.autoAnswer;
      saved.audio.groqKey = 'existing-speech-key'; saved.audio.macDefaultsApplied = true;
    }
    get(key) { return saved[key]; } set(key, value) { saved[key] = value; }
    get store() { return saved; }
  }
  const { ConfigStore } = load('src/services/config/config-store.ts', { 'electron-store': Store });
  const config = new ConfigStore();
  assert.equal(saved.ai.provider, 'ollama'); assert.equal(saved.ai.ollamaModel, 'existing-model');
  assert.equal(saved.ai.openaiKey, 'existing-key'); assert.equal(saved.ai.groqKey, '');
  assert.equal(saved.ai.groqModel, 'openai/gpt-oss-120b');
  assert.equal(saved.audio.autoAnswer, true);
  config.set('ai', { ...saved.ai, provider: 'groq', groqKey: ' new-answer-key ', groqModel: ' openai/gpt-oss-20b ' });
  assert.equal(saved.ai.groqKey, 'new-answer-key'); assert.equal(saved.ai.groqModel, 'openai/gpt-oss-20b');
  assert.equal(saved.audio.groqKey, 'existing-speech-key');
  assert.throws(() => config.set('ai', { ...saved.ai, groqModel: ' ' }), /Choose a Groq model/);
  console.log('PASS: old settings migrated with auto-answer without changing provider/keys, separate speech key, trimmed/validated model config');
}

(async () => { await providerTests(); await managerTests(); configTests(); })().catch(error => { console.error(error); process.exitCode = 1; });
