import test from 'node:test';
import assert from 'node:assert/strict';
import { SummaryApiClient } from '../src/api-client.js';
import { CacheMemoryUI, configTemplate, parseLongMemorySections, buildLongMemoryContent } from '../src/ui.js';
import { DEFAULT_GLOBAL_PROMPT, globalPromptText, normalizeSettings } from '../src/defaults.js';
import { MemoryStore } from '../src/memory-store.js';
import { MemorySummarizer } from '../src/summarizer.js';
import { getAssistantMessages } from '../src/utils.js';

function fixture(t, { legacy = false } = {}) {
    const settings = normalizeSettings({ apiBaseUrl: 'https://a.example/v1', model: 'model-a', temperature: 1, thinkingMode: 'enabled' });
    const values = new Map(legacy ? [['secret', 'synthetic-key-a']] : []);
    const storage = { getItem: key => values.get(key) ?? null, setItem: (key, value) => values.set(key, value), removeItem: key => values.delete(key) };
    const client = new SummaryApiClient({ getSettings: () => settings, storage, storageKey: 'secret' });
    const handlers = {}, status = [], requests = [], logs = [];
    const keyInput = { value: '', closest: selector => selector === '[data-api-key]' ? keyInput : null };
    const modelInput = { value: settings.model };
    const button = { disabled: false };
    const root = { dataset: {}, querySelector: selector => ({ '[data-api-key]': keyInput, '[data-setting="model"]': modelInput, '[data-list-models]': button })[selector] ?? null,
        addEventListener: (name, handler) => { handlers[name] = handler; } };
    const ui = new CacheMemoryUI({ getSettings: () => settings, apiClient: client, updateSettings: patch => Object.assign(settings, patch) });
    ui.doc = { activeElement: keyInput };
    ui.populateSettings = () => { modelInput.value = settings.model; };
    ui.renderMessageMemories = () => {};
    ui.renderModelOptions = models => { ui.modelOptions = [...models]; };
    ui.setStatus = (state, message) => status.push({ state, message });
    ui.bindSettings(root);
    const original = Object.getOwnPropertyDescriptor(globalThis, 'parent');
    const proxy = { location: { href: 'https://st.example/' }, getRequestHeaders: () => ({ 'X-CSRF-Token': 'synthetic-csrf' }),
        fetch: async (url, options) => { requests.push({ url, body: JSON.parse(options.body) }); return new Response(url.endsWith('/status') ? '{"data":[{"id":"listed-a"}]}' : '{"choices":[{"message":{"content":"OK"}}]}'); } };
    Object.defineProperty(globalThis, 'parent', { configurable: true, value: proxy });
    t.after(() => {
        clearTimeout(ui.apiKeySaveTimer); clearTimeout(ui.modelListTimer);
        if (original) Object.defineProperty(globalThis, 'parent', original); else delete globalThis.parent;
    });
    t.mock.method(console, 'info', (...args) => logs.push(args));
    t.mock.method(console, 'warn', (...args) => logs.push(args));
    return { settings, values, storage, client, ui, handlers, keyInput, modelInput, button, root, status, requests, logs, proxy };
}

test('connection tests preserve the same Thinking and temperature parameters as normal generation', async t => {
    const f = fixture(t, { legacy: true });
    for (const stream of [true, false]) await f.client.test({ stream });
    await f.client.complete({ systemPrompt: 'ordinary', userContent: 'synthetic', maxTokens: 32 });
    assert.ok(f.requests.every(({ body }) => body.temperature === 1 && body.thinking.type === 'enabled'));
    assert.ok(f.requests.slice(0, 2).every(({ body }) => body.max_tokens === 16 && !body.messages[0].content.includes('ENTITY_OVERFLOW')));
    assert.equal(f.settings.temperature, 1);
    f.settings.temperature = 0.65;
    f.settings.thinkingMode = 'disabled';
    await f.client.test();
    assert.equal(f.requests.at(-1).body.temperature, 0.65);
    assert.equal(f.requests.at(-1).body.thinking.type, 'disabled');
});

test('browser credentials and models are isolated by normalized endpoint and survive new clients', async t => {
    const f = fixture(t, { legacy: true });
    assert.equal(f.client.hasApiKey(), true);
    f.client.saveConnectionModel('saved-a');
    f.settings.apiBaseUrl = 'https://b.example/v1';
    assert.equal(f.client.hasApiKey(), false);
    assert.equal(f.client.savedConnectionModel(), '');
    await f.client.saveApiKey('synthetic-key-b');
    f.client.saveConnectionModel('saved-b');
    await f.client.listModels();
    assert.equal(JSON.parse(f.requests.at(-1).body.custom_include_headers).Authorization, 'Bearer synthetic-key-b');
    await f.client.saveApiKey('   ');
    assert.equal(f.client.hasApiKey(), true);
    const reopened = new SummaryApiClient({ getSettings: () => f.settings, storage: f.storage, storageKey: 'secret' });
    assert.equal(reopened.savedConnectionModel(), 'saved-b');
    f.settings.apiBaseUrl = 'https://a.example/v1/chat/completions';
    assert.equal(reopened.savedConnectionModel(), 'saved-a');
    await reopened.listModels();
    assert.equal(JSON.parse(f.requests.at(-1).body.custom_include_headers).Authorization, 'Bearer synthetic-key-a');
    reopened.clearApiKey();
    assert.equal(reopened.hasApiKey(), false);
    f.settings.apiBaseUrl = 'https://b.example/v1';
    assert.equal(reopened.hasApiKey(), true);
    assert.equal(reopened.savedConnectionModel(), 'saved-b');
    assert.doesNotMatch(JSON.stringify(f.settings), /synthetic-key/);
    assert.doesNotMatch(JSON.stringify(f.logs), /synthetic-key/);
    const metadata = {};
    const memory = new MemoryStore({ getMetadata: () => metadata, getChatId: () => 'synthetic', saveMetadata: () => {} });
    assert.doesNotMatch(JSON.stringify(memory.current()), /synthetic-key/);
});

test('key typing is debounced, blank input keeps the key, and automatic listing sends only one status request', async t => {
    t.mock.timers.enable({ apis: ['setTimeout'] });
    const f = fixture(t);
    f.keyInput.value = 'synthetic-key-new';
    f.handlers.input({ target: f.keyInput });
    t.mock.timers.tick(600);
    assert.equal(f.client.hasApiKey(), false);
    f.handlers.input({ target: f.keyInput });
    t.mock.timers.tick(700);
    await Promise.resolve(); await Promise.resolve();
    assert.equal(f.client.hasApiKey(), true);
    assert.equal(f.keyInput.value, 'synthetic-key-new'); // Do not truncate typing after a pause.
    t.mock.timers.tick(400);
    await f.ui.modelListRequests.get(f.client.modelListIdentity()).promise;
    assert.deepEqual(f.ui.modelOptions, ['listed-a']);
    assert.equal(f.settings.model, 'model-a');
    f.ui.scheduleModelList(f.root); f.ui.scheduleModelList(f.root);
    t.mock.timers.tick(5000);
    assert.equal(f.requests.length, 1);
    assert.equal(f.requests[0].url, '/api/backends/chat-completions/status');
    assert.equal(f.requests[0].body.messages, undefined);
    f.keyInput.value = '';
    await f.ui.saveInputApiKey(f.root);
    assert.equal(f.client.hasApiKey(), true);
    await f.ui.refreshModelList(f.root, true);
    assert.equal(f.requests.length, 2);
    assert.ok(f.requests.every(request => request.url.endsWith('/status')));
});

test('failed model refresh preserves the prior list and manual model without an automatic retry loop', async t => {
    const f = fixture(t, { legacy: true });
    await f.ui.refreshModelList(f.root);
    f.proxy.fetch = async () => new Response('{"error":{"message":"unauthorized synthetic-key-a"}}', { status: 401 });
    await f.ui.refreshModelList(f.root, true);
    assert.deepEqual(f.ui.modelOptions, ['listed-a']);
    assert.equal(f.settings.model, 'model-a');
    assert.equal(f.modelInput.value, 'model-a');
    assert.equal(f.button.disabled, false);
    assert.doesNotMatch(JSON.stringify({ logs: f.logs, status: f.status }), /synthetic-key-a/);
    assert.ok(f.ui.modelListRequests.has(f.client.modelListIdentity()));
});

test('late model results cannot replace another connection or a model typed during the request', async t => {
    const f = fixture(t, { legacy: true });
    let resolve;
    f.client.listModels = () => new Promise(done => { resolve = done; });
    const pending = f.ui.refreshModelList(f.root);
    f.settings.apiBaseUrl = 'https://b.example/v1'; f.settings.model = f.modelInput.value = 'manual-b';
    resolve({ source: 'proxy', models: ['wrong-a'] });
    await pending;
    assert.deepEqual(f.ui.modelOptions, []);
    assert.equal(f.settings.model, 'manual-b');
    const next = f.ui.refreshModelList(f.root, true);
    f.settings.model = f.modelInput.value = 'typed-b';
    resolve({ source: 'proxy', models: ['listed-b'] });
    await next;
    assert.equal(f.settings.model, 'typed-b');
});

test('switching API addresses restores their own saved model and clears unsaved credential display', async t => {
    const f = fixture(t, { legacy: true });
    f.client.saveConnectionModel('model-a');
    const changeAddress = value => f.handlers.change({ target: { dataset: { setting: 'apiBaseUrl' }, value,
        closest(selector) { return selector === '[data-setting]' ? this : null; } } });
    changeAddress('https://b.example/v1');
    assert.equal(f.settings.model, '');
    await f.client.saveApiKey('synthetic-key-b');
    f.client.saveConnectionModel('model-b'); f.settings.model = 'model-b';
    changeAddress('https://a.example/v1');
    assert.equal(f.settings.model, 'model-a');
    changeAddress('https://b.example/v1');
    assert.equal(f.settings.model, 'model-b');
    assert.equal(f.keyInput.value, '');
});

test('global prompt modes retain custom text and prepend exactly once to all three memory stages', async t => {
    const f = fixture(t);
    assert.equal(globalPromptText(f.settings), DEFAULT_GLOBAL_PROMPT);
    Object.assign(f.settings, { globalPromptMode: 'custom', globalPromptCustom: 'GLOBAL_SYNTHETIC_SENTINEL', checkpointInterval: 1, longMemoryInterval: 1, activeStateEnabled: false });
    assert.equal(globalPromptText({ ...f.settings, globalPromptMode: 'blank' }), '');
    assert.equal(normalizeSettings({ ...f.settings, globalPromptMode: 'default' }).globalPromptCustom, 'GLOBAL_SYNTHETIC_SENTINEL');
    const metadata = {}, prompts = [];
    const store = new MemoryStore({ getMetadata: () => metadata, getChatId: () => 'global-synthetic', saveMetadata: () => {} });
    const chat = [{ name: '合成角色', mes: '合成角色找到古代书信', gen_started: '1' }];
    const summarizer = new MemorySummarizer({ store, getSettings: () => f.settings, getChat: () => chat, apiClient: { complete: async request => {
        prompts.push(request.systemPrompt);
        return { content: prompts.length === 1 ? '[SUMMARY]\n[Event]\n找到古代书信' : prompts.length === 2 ? '[CHECKPOINT]\n[Story So Far]\n找到古代书信' : '[LONG_MEMORY]\n- 找到古代书信' };
    } } });
    await summarizer.summarizeEntry(getAssistantMessages(chat)[0]);
    assert.equal(prompts.length, 3);
    assert.ok(prompts.every(prompt => prompt.startsWith('GLOBAL_SYNTHETIC_SENTINEL\n\n') && prompt.match(/GLOBAL_SYNTHETIC_SENTINEL/g).length === 1));
    assert.doesNotMatch(JSON.stringify(store.current()), /GLOBAL_SYNTHETIC_SENTINEL/);
    const html = configTemplate();
    assert.ok(html.indexOf('<summary>全局提示词</summary>') < html.indexOf('<summary>小总结提示词</summary>'));
    assert.match(html, /<details class="cache-memory-global-prompt"><summary>全局提示词/);
    assert.match(html, /value="blank">空白[\s\S]*value="default">默认破限[\s\S]*value="custom">自定义/);
});

test('Long Memory with existing tracked and checkpoint sections shows separate Chinese fields without dropping content', () => {
    const content = '[LONG_MEMORY]\n- 合成历史\n[UPDATED_FACTS]\n无\n[RETIRED_FACTS]\n无\n[CURRENT_TRACKED_STATE]\n合成当前状态\n[Characters]\n合成人物\n[Current State]\n合成世界\n[Secrets & Knowledge]\n合成认知差\n[Open Threads]\n合成未解决事项';
    const fields = parseLongMemorySections(content);
    const emptyWrapper = parseLongMemorySections(content.replace('合成当前状态', ''));
    assert.deepEqual(parseLongMemorySections(buildLongMemoryContent(emptyWrapper)), emptyWrapper);
    assert.equal(fields.trackedState, '合成当前状态');
    assert.equal(fields.characters, '合成人物');
    assert.equal(fields.secretsKnowledge, '合成认知差');
    assert.equal(fields.openThreads, '合成未解决事项');
    assert.deepEqual(parseLongMemorySections(buildLongMemoryContent(fields)), fields);
    assert.equal(parseLongMemorySections(`${content}\n[Custom Extra]\n必须保留`), null);
});


test('typing a key before the first address retains it and saves it to that address', async t => {
    const f = fixture(t);
    f.settings.apiBaseUrl = '';
    f.keyInput.value = 'synthetic-key-first';
    await f.ui.saveInputApiKey(f.root);
    assert.equal(f.client.hasApiKey(), false);
    assert.equal(f.keyInput.value, 'synthetic-key-first');
    const input = { dataset: { setting: 'apiBaseUrl' }, value: 'https://first.example/v1', closest: selector => selector === '[data-setting]' ? input : null };
    f.handlers.change({ target: input });
    await Promise.resolve(); await Promise.resolve();
    assert.equal(f.client.hasApiKey(), true);
    await f.client.listModels();
    assert.equal(JSON.parse(f.requests.at(-1).body.custom_include_headers).Authorization, 'Bearer synthetic-key-first');
});
