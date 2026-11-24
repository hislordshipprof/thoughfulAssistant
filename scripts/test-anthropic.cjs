// No network, credentials, screen content, or user config. Run: npm run test:anthropic
const assert = require('node:assert/strict');
const vm = require('node:vm');
const path = require('node:path');
const { buildSync } = require('esbuild');

function load(file, mocks = {}, platform = 'darwin') {
  const code = buildSync({
    entryPoints: [path.resolve(__dirname, '..', file)],
    bundle: true,
    platform: 'node',
    format: 'cjs',
    packages: 'external',
    external: Object.keys(mocks),
    write: false
  }).outputFiles[0].text;
  const module = { exports: {} };
  vm.runInNewContext(code, {
    module,
    exports: module.exports,
    Buffer,
    AbortController,
    AbortSignal,
    setTimeout,
    clearTimeout,
    TextDecoder,
    TextEncoder,
    process: { platform, env: {} },
    console: { log() {}, warn() {}, error() {} },
    require: name => Object.hasOwn(mocks, name) ? mocks[name] : require(name)
  });
  return module.exports;
}

const json = value => JSON.parse(JSON.stringify(value));
const deferred = () => {
  let resolve;
  const promise = new Promise(done => { resolve = done; });
  return { promise, resolve };
};
const tick = () => new Promise(resolve => setImmediate(resolve));

const clients = [];
const requests = [];
let failWith = null;
let empty = false;
let handler;

class FakeAgent {
  constructor(options) { this.options = options; }
}

class FakeAnthropic {
  constructor(options) {
    clients.push(options);
    this.messages = {
      stream: (body, options) => {
        requests.push({ body, options });
        if (handler) return handler(body, options);
        if (failWith) throw failWith;
        return (async function* () {
          yield { type: 'message_start' };
          if (!empty) yield { type: 'content_block_delta', delta: { type: 'text_delta', text: 'Claude answer' } };
          yield { type: 'message_stop' };
        })();
      }
    };
  }
}

const mocks = {
  '@anthropic-ai/sdk': FakeAnthropic,
  'node:https': { Agent: FakeAgent }
};
const { AnthropicProvider } = load('src/services/ai/anthropic-provider.ts', mocks);
const events = [];
const collect = event => events.push(event);
const messages = [
  { role: 'system', content: 'Be concise' },
  { role: 'user', content: 'Synthetic question' }
];

async function providerTests() {
  const provider = new AnthropicProvider('');
  await provider.streamChat(messages, collect);
  assert.match(events.at(-1).content, /Set an Anthropic API key/);
  assert.equal(requests.length, 0);

  provider.setApiKey('  synthetic-secret  ');
  assert.equal(provider.isConfigured(), true);
  const client = clients.at(-1);
  assert.equal(client.apiKey, 'synthetic-secret');
  assert.equal(client.timeout, 120000);
  assert.equal(client.maxRetries, 1);
  assert.equal(client.httpAgent.options.family, 4);

  events.length = 0;
  await provider.streamChat(messages, collect);
  assert.deepEqual(json(events), [
    { type: 'token', content: 'Claude answer' },
    { type: 'done', content: '' }
  ]);
  const request = requests.at(-1);
  assert.equal(request.body.model, 'claude-sonnet-4-5-20250929');
  assert.equal(request.body.system, 'Be concise');
  assert.deepEqual(json(request.body.messages), [{ role: 'user', content: 'Synthetic question' }]);
  assert.equal(request.options.signal.aborted, false);
  assert.equal(await provider.supportsImages(), true);

  provider.setModel(' claude-sonnet-5-5 ');
  assert.equal(provider.getModel(), 'claude-sonnet-5-5');
  const image = 'data:image/png;base64,c3ludGhldGlj';
  await provider.streamChat([...messages, { role: 'user', content: 'Screen question', images: [image] }], collect);
  assert.deepEqual(json(requests.at(-1).body.messages.at(-1).content), [
    { type: 'text', text: 'Screen question' },
    { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'c3ludGhldGlj' } }
  ]);
  console.log('PASS: trimmed key/model, macOS IPv4 agent, streamed text, system separation, and image payload');

  for (const [status, expected] of [
    [400, /rejected this request/],
    [401, /rejected the API key/],
    [402, /billing is not active/],
    [403, /access denied/],
    [404, /claude-sonnet-5-5/],
    [413, /too large/],
    [429, /quota limit/],
    [500, /temporarily unavailable/],
    [529, /overloaded/]
  ]) {
    failWith = { status, message: 'DO NOT LEAK synthetic-secret or prompt' };
    events.length = 0;
    await provider.streamChat(messages, collect);
    assert.equal(events.length, 1);
    assert.equal(events[0].type, 'error');
    assert.match(events[0].content, expected);
    assert.doesNotMatch(events[0].content, /DO NOT LEAK|synthetic-secret/);
  }
  failWith = { name: 'APIConnectionTimeoutError', message: 'DO NOT LEAK' };
  events.length = 0;
  await provider.streamChat(messages, collect);
  assert.match(events.at(-1).content, /timed out/);
  failWith = new Error('DO NOT LEAK network details');
  events.length = 0;
  await provider.streamChat(messages, collect);
  assert.match(events.at(-1).content, /Could not connect/);
  assert.doesNotMatch(events.at(-1).content, /DO NOT LEAK/);
  failWith = null;
  empty = true;
  events.length = 0;
  await provider.streamChat(messages, collect);
  assert.match(events.at(-1).content, /did not return a text answer/);
  empty = false;
  console.log('PASS: actionable auth, billing, access, model, quota, timeout, service, network, and empty-answer errors without raw data leakage');

  const first = deferred();
  const second = deferred();
  let index = 0;
  handler = () => (async function* () {
    await (++index === 1 ? first.promise : second.promise);
    yield { type: 'content_block_delta', delta: { type: 'text_delta', text: 'late' } };
  })();
  events.length = 0;
  const a = provider.streamChat(messages, collect);
  await tick();
  const oldSignal = requests.at(-1).options.signal;
  const b = provider.streamChat(messages, collect);
  await tick();
  const newSignal = requests.at(-1).options.signal;
  assert.equal(oldSignal.aborted, true);
  first.resolve();
  await a;
  assert.equal(newSignal.aborted, false);
  provider.cancelStream();
  assert.equal(newSignal.aborted, true);
  second.resolve();
  await b;
  assert.equal(events.length, 0);
  handler = undefined;

  provider.setApiKey('');
  assert.equal(provider.isConfigured(), false);
  assert.equal(await provider.supportsImages(), false);
  provider.setApiKey('synthetic-secret');
  provider.setModel('   ');
  assert.equal(provider.isConfigured(), false);
  console.log('PASS: overlapping streams, cancellation isolation, and blank key/model fail closed');
}

function platformAndConfigTests() {
  clients.length = 0;
  const { AnthropicProvider: OtherPlatformProvider } = load('src/services/ai/anthropic-provider.ts', mocks, 'win32');
  new OtherPlatformProvider('synthetic-secret');
  assert.equal(clients.at(-1).httpAgent, undefined);

  const { ConfigSchema } = load('src/services/config/config-schema.ts');
  const parsed = ConfigSchema.parse({
    ai: { anthropicKey: ' key ', anthropicModel: ' model ' },
    audio: {}, ocr: {}, overlay: {}, resume: '', jobDescription: ''
  });
  assert.equal(parsed.ai.anthropicKey, 'key');
  assert.equal(parsed.ai.anthropicModel, 'model');
  assert.throws(() => ConfigSchema.parse({
    ai: { anthropicModel: ' ' }, audio: {}, ocr: {}, overlay: {}, resume: '', jobDescription: ''
  }), /Choose an Anthropic model/);
  console.log('PASS: IPv4 override is macOS-only and Anthropic config is trimmed and validated');
}

(async () => {
  await providerTests();
  platformAndConfigTests();
})().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
