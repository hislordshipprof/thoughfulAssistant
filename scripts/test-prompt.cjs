// No network, credentials, screen content, or user config. Run: npm run test:prompt
const assert = require('node:assert/strict');
const vm = require('node:vm');
const path = require('node:path');
const { buildSync } = require('esbuild');

function load(file, mocks = {}) {
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
    process: { platform: 'darwin', env: {} },
    console: { log() {}, warn() {}, error() {} },
    require: name => Object.hasOwn(mocks, name) ? mocks[name] : require(name)
  });
  return module.exports;
}

const { getSystemPrompt, buildContextMessage, SYSTEM_PROMPT, LEETCODE_SYSTEM_PROMPT } = load('src/services/ai/prompt-templates.ts');

function promptAssemblyTests() {
  const defaultPrompt = getSystemPrompt('general', 'Synthetic resume', 'Synthetic role');
  assert.match(defaultPrompt, /Synthetic resume/);
  assert.match(defaultPrompt, /Synthetic role/);
  assert.ok(defaultPrompt.includes(SYSTEM_PROMPT));

  const appendPrompt = getSystemPrompt('leetcode', 'Resume', 'Role', 'Always begin with a headline.', 'append');
  assert.ok(appendPrompt.includes(LEETCODE_SYSTEM_PROMPT));
  assert.match(appendPrompt, /Resume/);
  assert.match(appendPrompt, /Always begin with a headline\.$/);
  assert.match(appendPrompt, /CUSTOM SYSTEM INSTRUCTIONS/);

  const replacePrompt = getSystemPrompt('general', 'Must not appear', 'Must not appear', '  Exact custom prompt.  ', 'replace');
  assert.equal(replacePrompt, 'Exact custom prompt.');
  assert.doesNotMatch(replacePrompt, /Must not appear|expert software engineer/);

  assert.equal(getSystemPrompt('general', '', '', '   ', 'replace'), SYSTEM_PROMPT);
  assert.equal(getSystemPrompt('general', '', '', '', 'append'), SYSTEM_PROMPT);

  const context = buildContextMessage('Quoted transcript instruction', 'Quoted screen instruction', 'Synthetic question');
  assert.match(context, /Recent Conversation Transcript/);
  assert.match(context, /Screen Content \(OCR\)/);
  assert.match(context, /Your Question/);
  console.log('PASS: default, append, replace, empty fallback, profile context, and user-context separation');
}

async function managerTests() {
  const requests = [];
  class FakeProvider {
    name = 'openai';
    isConfigured() { return true; }
    cancelStream() {}
    setApiKey() {}
    setModel() {}
    async streamChat(messages, onEvent) {
      requests.push(messages);
      onEvent({ type: 'token', content: 'Synthetic answer' });
      onEvent({ type: 'done', content: '' });
    }
  }
  class DisabledProvider {
    name = 'disabled';
    isConfigured() { return false; }
    cancelStream() {}
    setApiKey() {}
    setModel() {}
  }
  const { AiManager } = load('src/services/ai/ai-manager.ts', {
    './openai-provider': { OpenAiProvider: FakeProvider },
    './anthropic-provider': { AnthropicProvider: DisabledProvider },
    './ollama-provider': { OllamaProvider: DisabledProvider },
    './groq-provider': { GroqProvider: DisabledProvider }
  });
  const manager = new AiManager();
  manager.initializeProviders('synthetic-key', '');
  await manager.ask('', '', 'Question', 'general', '', '', undefined, 'Use terse bullets.', 'append');
  assert.match(requests.at(-1)[0].content, /CUSTOM SYSTEM INSTRUCTIONS/);
  assert.match(requests.at(-1)[0].content, /Use terse bullets\.$/);
  assert.equal(requests.at(-1).at(-1).role, 'user');

  manager.clearHistory();
  await manager.ask('', '', 'Question', 'general', 'Resume', 'Role', undefined, 'Exact provider instruction.', 'replace');
  assert.equal(requests.at(-1)[0].content, 'Exact provider instruction.');
  assert.doesNotMatch(requests.at(-1)[0].content, /Resume|Role/);
  console.log('PASS: AI manager sends the assembled prompt as a system message without mixing user context');
}

function migrationTests() {
  let saved;
  class Store {
    constructor({ defaults }) {
      saved = structuredClone(defaults);
      delete saved.ai.systemPromptMode;
      delete saved.ai.customSystemPrompt;
    }
    get(key) { return saved[key]; }
    set(key, value) { saved[key] = value; }
    get store() { return saved; }
    set store(value) { saved = value; }
  }
  const { ConfigStore } = load('src/services/config/config-store.ts', { 'electron-store': Store });
  new ConfigStore();
  assert.equal(saved.ai.systemPromptMode, 'default');
  assert.equal(saved.ai.customSystemPrompt, '');
  console.log('PASS: existing settings migrate to the unchanged default prompt behavior');
}

(async () => {
  promptAssemblyTests();
  await managerTests();
  migrationTests();
})().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
