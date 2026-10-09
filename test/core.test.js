import test from 'node:test';
import assert from 'node:assert/strict';

import { normalizeApiBaseUrl, normalizeBaseUrl, normalizeModelsUrl, readModels, SummaryApiClient } from '../src/api-client.js';
import { API_PROVIDERS, INJECTION_MODES, normalizeSettings } from '../src/defaults.js';
import { buildInjection } from '../src/injection.js';
import { MemoryStore } from '../src/memory-store.js';
import { MemorySummarizer } from '../src/summarizer.js';
import { getAssistantMessages } from '../src/utils.js';

function message(mes, sendDate, extra = {}) {
    return {
        name: '角色',
        is_user: false,
        is_system: false,
        mes,
        send_date: sendDate,
        gen_started: `${sendDate}-start`,
        extra,
    };
}

function createStore(chatId = 'chat-a') {
    const metadata = {};
    let saves = 0;
    const store = new MemoryStore({
        getMetadata: () => metadata,
        getChatId: () => chatId,
        saveMetadata: () => { saves += 1; },
    });
    return { store, metadata, get saves() { return saves; } };
}

test('normalizes long interval to checkpoint boundaries', () => {
    const settings = normalizeSettings({ checkpointInterval: 20, longMemoryInterval: 101 });
    assert.equal(settings.longMemoryInterval, 120);
    assert.equal(settings.strictCacheMode, true);
    assert.equal(settings.showWandButton, true);
    assert.equal(normalizeSettings({ showWandButton: false }).showWandButton, false);
    assert.equal(normalizeSettings({ temperature: 0 }).temperature, 0);
    assert.equal(normalizeSettings({ recentSummaryCount: 0 }).recentSummaryCount, 0);
});

test('migrates legacy provider values without changing API settings', () => {
    for (const provider of ['doubao', 'ark', 'coding_plan', 'doubao-coding']) {
        const settings = normalizeSettings({
            provider,
            apiBaseUrl: 'https://legacy.example/v1',
            model: 'my-custom-model',
        });
        assert.equal(settings.provider, API_PROVIDERS.OPENAI_COMPATIBLE);
        assert.equal(settings.apiBaseUrl, 'https://legacy.example/v1');
        assert.equal(settings.model, 'my-custom-model');
    }
});

test('normalizes origin, versioned, API-path, and complete chat URLs consistently', () => {
    assert.equal(normalizeApiBaseUrl('https://example.com'), 'https://example.com/v1');
    assert.equal(normalizeModelsUrl('https://example.com'), 'https://example.com/v1/models');
    assert.equal(normalizeBaseUrl('https://example.com'), 'https://example.com/v1/chat/completions');
    assert.equal(normalizeModelsUrl('https://example.com/v1/'), 'https://example.com/v1/models');
    assert.equal(normalizeBaseUrl('https://example.com/v1'), 'https://example.com/v1/chat/completions');
    assert.equal(normalizeApiBaseUrl('https://example.com/v1/chat/completions'), 'https://example.com/v1');
    assert.equal(normalizeModelsUrl('https://example.com/v1/chat/completions'), 'https://example.com/v1/models');
    assert.equal(normalizeBaseUrl('https://example.com/v1/chat/completions'), 'https://example.com/v1/chat/completions');
    assert.equal(normalizeModelsUrl('https://example.com/api/openai/v3'), 'https://example.com/api/openai/v3/models');
    assert.equal(normalizeBaseUrl('https://ark.cn-beijing.volces.com/api/coding/v3'), 'https://ark.cn-beijing.volces.com/api/coding/v3/chat/completions');
    assert.equal(normalizeModelsUrl('https://ark.cn-beijing.volces.com/api/coding/v3'), 'https://ark.cn-beijing.volces.com/api/coding/v3/models');
});

test('parses supported model response envelopes and item fields', () => {
    assert.deepEqual(readModels([{ model: 'm3' }, { model_id: 'm2' }, { model_name: 'm1' }]), ['m1', 'm2', 'm3']);
    assert.deepEqual(readModels({ data: { models: [{ id: 'a' }] } }), ['a']);
    assert.deepEqual(readModels({ result: { data: { models: [{ name: 'b' }] } } }), ['b']);
});

test('assistant floor scan excludes user, system, narrator and tool messages', () => {
    const chat = [
        { name: '角色', is_user: false, is_system: false, mes: 'card greeting', extra: {} },
        { is_user: true, mes: 'user' },
        message('A', '1'),
        { is_system: true, mes: 'system' },
        message('narrator', '2', { type: 'narrator' }),
        message('tool', '3', { tool_invocations: [{}] }),
        message('B', '4'),
    ];
    const entries = getAssistantMessages(chat);
    assert.deepEqual(entries.map(item => item.floor), [1, 2]);
    assert.deepEqual(entries.map(item => item.messageIndex), [2, 6]);
});

test('saved message identity and fingerprint stay stable after cross-device JSON loading', () => {
    const original = message('同一段已保存正文', '2026-10-08T10:00:00.000Z', { gen_id: 12345, model: 'model-a' });
    original.swipe_id = 2;
    const restored = JSON.parse(JSON.stringify(original));
    const [first] = getAssistantMessages([original]);
    const [second] = getAssistantMessages([restored]);
    assert.equal(first.messageId, second.messageId);
    assert.equal(first.fingerprint, second.fingerprint);
});

test('legacy messages without timestamps get distinct content fallback identities', () => {
    const entries = getAssistantMessages([
        { is_user: true, mes: 'user' },
        { name: '角色', is_user: false, is_system: false, mes: 'legacy A', extra: {} },
        { name: '角色', is_user: false, is_system: false, mes: 'legacy B', extra: {} },
    ]);
    assert.equal(entries.length, 2);
    assert.notEqual(entries[0].messageId, entries[1].messageId);
});

test('automatic add is append-only and never overwrites a frozen summary', () => {
    const fixture = createStore();
    const record = { messageId: 'm1', floor: 1, title: 'original', status: 'frozen' };
    fixture.store.addSummary(record);
    fixture.store.addSummary({ ...record, title: 'changed' });
    assert.equal(fixture.store.getSummary('m1').title, 'original');
    fixture.store.addSummary({ ...record, title: 'manual replacement' }, { overwrite: true });
    assert.equal(fixture.store.getSummary('m1').title, 'manual replacement');
});

test('clearCurrentChat atomically replaces only the current chat memory store', () => {
    const metadata = {
        cache_memory: {
            version: 3,
            chatId: 'chat-a',
            summaries: { m1: { messageId: 'm1', floor: 1, status: 'frozen' } },
            checkpoints: [{ id: 'checkpoint-001' }],
            longMemories: [{ id: 'long-001' }],
            keepRegistry: { 'KEEP-0001': { text: '保留事项' } },
            injectionSnapshot: { value: '<CACHE_MEMORY>old</CACHE_MEMORY>', blocks: [{ id: 'old' }] },
        },
        unrelated: { preserved: true },
    };
    let saves = 0;
    let change;
    const store = new MemoryStore({
        getMetadata: () => metadata,
        getChatId: () => 'chat-a',
        saveMetadata: () => { saves += 1; },
        onChange: (value, reason) => { change = { value, reason }; },
    });

    const cleared = store.clearCurrentChat();

    assert.equal(saves, 1);
    assert.equal(change.reason, 'current chat cleared');
    assert.equal(cleared.chatId, 'chat-a');
    assert.deepEqual(cleared.summaries, {});
    assert.deepEqual(cleared.checkpoints, []);
    assert.deepEqual(cleared.longMemories, []);
    assert.deepEqual(cleared.keepRegistry, {});
    assert.equal(Object.hasOwn(cleared, 'injectionSnapshot'), false);
    assert.deepEqual(metadata.unrelated, { preserved: true });
});

test('message sync keeps identity through array index shifts and marks edited source stale', () => {
    const fixture = createStore();
    const assistant = message('original body', '2026-01-01');
    const firstChat = [{ is_user: true, mes: 'u' }, assistant];
    const [entry] = fixture.store.syncMessages(firstChat);
    fixture.store.addSummary({
        messageId: entry.messageId,
        floor: 1,
        messageIndex: 1,
        sourceFingerprint: entry.fingerprint,
        sourceContentFingerprint: entry.contentFingerprint,
        title: 'frozen',
        status: 'frozen',
    });

    assistant.mes = 'edited body';
    fixture.store.syncMessages([assistant]);
    const stored = fixture.store.getSummary(entry.messageId);
    assert.equal(stored.messageIndex, 0);
    assert.equal(stored.status, 'stale');
});

test('message sync rebinds a restored summary by stable assistant fingerprint', () => {
    const metadata = { cache_memory: { version: 5, chatId: 'chat-a', summaries: {}, checkpoints: [], longMemories: [], keepRegistry: {} } };
    const restoredMessage = { is_user: false, is_system: false, mes: 'same', send_date: 1, gen_started: 2, gen_finished: 3 };
    const entry = getAssistantMessages([restoredMessage])[0];
    metadata.cache_memory.summaries.old_id = { messageId: 'old_id', sourceFingerprint: entry.fingerprint, floor: 161, messageIndex: 161, raw: 'saved', status: 'frozen', frozen: true };
    const store = new MemoryStore({ getMetadata: () => metadata, getChatId: () => 'chat-a', saveMetadata: () => {} });
    store.syncMessages([restoredMessage]);
    const reboundId = getAssistantMessages([restoredMessage])[0].messageId;
    assert.equal(store.current().summaries[reboundId]?.raw, 'saved');
    assert.equal(store.current().summaries.old_id, undefined);
});

test('injection is deterministic, ordered and excludes checkpoints covered by long memory', () => {
    const store = {
        longMemories: [
            { id: 'long-002', startFloor: 101, endFloor: 200, content: 'L2', frozen: true },
            { id: 'long-001', startFloor: 1, endFloor: 100, content: 'L1', frozen: true },
        ],
        checkpoints: [
            { id: 'checkpoint-010', startFloor: 181, endFloor: 200, content: 'covered', frozen: true },
            { id: 'checkpoint-011', startFloor: 201, endFloor: 220, content: 'C11', frozen: true },
            { id: 'checkpoint-012', startFloor: 221, endFloor: 240, content: 'C12', frozen: true },
        ],
        summaries: {
            z: { floor: 242, title: 'S242', characters: 'B', event: 'E2', status: 'frozen' },
            a: { floor: 241, title: 'S241', characters: 'A', event: 'E1', status: 'frozen' },
        },
    };
    const settings = normalizeSettings({
        strictCacheMode: false,
        injectionMode: INJECTION_MODES.LONG_CHECKPOINT_RECENT,
        recentCheckpointCount: 2,
        recentSummaryCount: 2,
    });
    const first = buildInjection(store, settings);
    const second = buildInjection(store, settings);
    assert.equal(first, second);
    assert.ok(first.indexOf('LONG_001') < first.indexOf('LONG_002'));
    assert.ok(first.indexOf('CHECKPOINT_011') < first.indexOf('CHECKPOINT_012'));
    assert.ok(first.indexOf('RECENT_SUMMARY_241') < first.indexOf('RECENT_SUMMARY_242'));
    assert.doesNotMatch(first, /covered/);
});

test('summarizer builds frozen floor, checkpoint and long memories without changing chat text', async () => {
    const fixture = createStore();
    const chat = [
        message('body one', '1'),
        message('body two', '2'),
        message('body three', '3'),
        message('body four', '4'),
    ];
    const originalBodies = chat.map(item => item.mes);
    const settings = normalizeSettings({ memoryStrategy: 'legacy', checkpointInterval: 2, longMemoryInterval: 4 });
    let calls = 0;
    const budgets = [];
    const apiClient = {
        async complete({ systemPrompt, userContent, maxTokens }) {
            calls += 1;
            budgets.push(maxTokens);
            if (userContent.startsWith('body')) {
                return { content: `<title>T${calls}</title><characters>C</characters><event>${userContent}</event>`, status: 200 };
            }
            return { content: `aggregate-${calls}`, status: 200 };
        },
    };
    const summarizer = new MemorySummarizer({
        store: fixture.store,
        apiClient,
        getSettings: () => settings,
        getChat: () => chat,
    });
    for (const entry of getAssistantMessages(chat)) await summarizer.summarizeEntry(entry);
    const memory = fixture.store.current();
    assert.equal(Object.keys(memory.summaries).length, 4);
    assert.equal(memory.checkpoints.length, 2);
    assert.equal(memory.longMemories.length, 1);
    assert.equal(budgets.filter(value => value === 1024).length, 4);
    assert.equal(budgets.filter(value => value === 3072).length, 2);
    assert.equal(budgets.filter(value => value === 4096).length, 1);
    assert.deepEqual(chat.map(item => item.mes), originalBodies);

    const firstTitle = Object.values(memory.summaries).find(item => item.floor === 1).title;
    await summarizer.summarizeEntry(getAssistantMessages(chat)[0]);
    assert.equal(Object.values(fixture.store.current().summaries).find(item => item.floor === 1).title, firstTitle);
});

test('checkpoint failure does not rewrite the already frozen floor summary', async () => {
    const fixture = createStore();
    const chat = [message('body one', '1')];
    const settings = normalizeSettings({ checkpointInterval: 1, longMemoryInterval: 2 });
    let calls = 0;
    const summarizer = new MemorySummarizer({
        store: fixture.store,
        apiClient: {
            async complete() {
                calls += 1;
                if (calls === 1) return { content: '<title>kept</title><characters>C</characters><event>E</event>' };
                throw new Error('checkpoint offline');
            },
        },
        getSettings: () => settings,
        getChat: () => chat,
    });
    await summarizer.summarizeEntry(getAssistantMessages(chat)[0]);
    const memory = fixture.store.current();
    assert.equal(Object.values(memory.summaries)[0].title, 'kept');
    assert.equal(Object.values(memory.summaries)[0].status, 'frozen');
    assert.equal(memory.checkpoints[0].status, 'failed');
});

test('changing intervals keeps checkpoint ids append-only and collision-free', async () => {
    const fixture = createStore();
    fixture.store.addCheckpoint({ id: 'checkpoint-001', startFloor: 1, endFloor: 20, content: 'old', frozen: true, status: 'frozen' });
    const chat = Array.from({ length: 60 }, (_, index) => message(`body ${index + 1}`, String(index + 1)));
    for (const entry of getAssistantMessages(chat).filter(item => item.floor > 20)) {
        fixture.store.addSummary({
            messageId: entry.messageId,
            floor: entry.floor,
            messageIndex: entry.messageIndex,
            sourceFingerprint: entry.fingerprint,
            title: `S${entry.floor}`,
            characters: 'C',
            event: 'E',
            status: 'frozen',
            frozen: true,
        });
    }
    const settings = normalizeSettings({ checkpointInterval: 40, longMemoryInterval: 80 });
    const summarizer = new MemorySummarizer({
        store: fixture.store,
        apiClient: { complete: async () => ({ content: 'new checkpoint' }) },
        getSettings: () => settings,
        getChat: () => chat,
    });
    await summarizer.generateDueAggregates();
    assert.deepEqual(fixture.store.current().checkpoints.map(item => item.id), ['checkpoint-001', 'checkpoint-002']);
    assert.equal(fixture.store.current().checkpoints[1].startFloor, 21);
    assert.equal(fixture.store.current().checkpoints[1].endFloor, 60);
});

test('late summary response is discarded after switching chats', async () => {
    let metadata = {};
    let chatId = 'chat-a';
    const store = new MemoryStore({
        getMetadata: () => metadata,
        getChatId: () => chatId,
        saveMetadata: () => {},
    });
    const chat = [message('body', '1')];
    const settings = normalizeSettings({ checkpointInterval: 20, longMemoryInterval: 100 });
    let release;
    const response = new Promise(resolve => { release = resolve; });
    const summarizer = new MemorySummarizer({
        store,
        apiClient: { complete: () => response },
        getSettings: () => settings,
        getChat: () => chat,
    });
    const pending = summarizer.summarizeEntry(getAssistantMessages(chat)[0]);
    metadata = {};
    chatId = 'chat-b';
    release({ content: '<title>late</title><characters>C</characters><event>E</event>' });
    await assert.rejects(pending, /聊天已切换/);
    assert.equal(Object.keys(store.current().summaries).length, 0);
});

test('independent API client sends its browser-stored key only through the same-origin ST backend', async () => {
    const values = new Map([['key', 'private-key']]);
    const storage = {
        getItem: key => values.get(key) ?? null,
        setItem: (key, value) => values.set(key, value),
        removeItem: key => values.delete(key),
    };
    const settings = normalizeSettings({ apiBaseUrl: 'https://example.com/v1/', model: 'small-model' });
    const client = new SummaryApiClient({ getSettings: () => settings, storage, storageKey: 'key' });
    const originalFetch = globalThis.fetch;
    const originalParent = globalThis.parent;
    let request;
    globalThis.parent = {
        location: { href: 'https://st.example/chat' },
        getRequestHeaders: () => ({ 'X-CSRF-Token': 'csrf' }),
        fetch: async (url, options) => {
            request = { url, options };
            return new Response(JSON.stringify({ choices: [{ message: { content: 'OK' } }] }), { status: 200 });
        },
    };
    globalThis.fetch = async () => assert.fail('browser must not request a third-party API');
    try {
        const result = await client.complete({ systemPrompt: 'system', userContent: 'body' });
        assert.equal(result.content, 'OK');
        assert.equal(request.url, '/api/backends/chat-completions/generate');
        assert.equal(request.options.headers.has('Authorization'), false);
        const payload = JSON.parse(request.options.body);
        assert.equal(JSON.parse(payload.custom_include_headers).Authorization, 'Bearer private-key');
        assert.equal(payload.model, 'small-model');
        assert.deepEqual(payload.messages.map(item => item.role), ['system', 'user']);
    } finally {
        globalThis.fetch = originalFetch;
        if (originalParent === undefined) delete globalThis.parent;
        else globalThis.parent = originalParent;
    }
});

test('model listing reads proxied OpenAI responses and never injects provider-specific presets', async () => {
    const storage = { getItem: () => 'saved-key', setItem: () => {}, removeItem: () => {} };
    let settings = normalizeSettings({ apiBaseUrl: 'https://example.com/v1', model: 'test-model' });
    const client = new SummaryApiClient({ getSettings: () => settings, storage, storageKey: 'key' });
    const originalFetch = globalThis.fetch;
    const originalParent = globalThis.parent;
    const root = {
        location: { href: 'https://st.example/chat' },
        getRequestHeaders: () => ({ 'X-CSRF-Token': 'csrf' }),
        fetch: async () => new Response(JSON.stringify({ data: [{ id: 'model-b' }, { id: 'model-a' }] }), { status: 200 }),
    };
    globalThis.parent = root;
    globalThis.fetch = async () => assert.fail('browser must not request a third-party API');
    try {
        const remote = await client.listModels();
        assert.deepEqual(remote.models, ['model-a', 'model-b']);
        assert.equal(remote.source, 'proxy');

        settings = normalizeSettings({ apiBaseUrl: 'https://example.com/v1', model: 'my-custom-model' });
        root.fetch = async () => new Response('not found', { status: 404 });
        const failure = await client.listModels();
        assert.equal(failure.source, 'unavailable');
        assert.deepEqual(failure.models, []);
        assert.equal(failure.warning, '无法获取模型列表，请手动填写模型名称。');
        assert.match(failure.diagnostics.proxy, /HTTP 404/);
        assert.equal(failure.diagnostics.proxyBody, 'not found');
        assert.equal(settings.model, 'my-custom-model');

        root.fetch = async () => new Response(JSON.stringify({ data: { invalid: true } }), { status: 200 });
        const malformed = await client.listModels();
        assert.equal(malformed.source, 'unavailable');
        assert.equal(malformed.warning, '无法获取模型列表，请手动填写模型名称。');
        assert.match(malformed.diagnostics.proxy, /未识别模型数组/);
        assert.match(malformed.error, /没有可识别的模型数组/);
    } finally {
        globalThis.fetch = originalFetch;
        if (originalParent === undefined) delete globalThis.parent;
        else globalThis.parent = originalParent;
    }
});

test('model listing uses the SillyTavern proxy first without a browser cross-origin request', async () => {
    const values = new Map([['key', 'secret-key']]);
    const storage = { getItem: key => values.get(key) ?? null, setItem: (key, value) => values.set(key, value), removeItem: key => values.delete(key) };
    const settings = normalizeSettings({ apiBaseUrl: 'https://provider.example/api/v3', model: '' });
    const client = new SummaryApiClient({ getSettings: () => settings, storage, storageKey: 'key' });
    const originalFetch = globalThis.fetch;
    const originalParent = globalThis.parent;
    const originalLocation = globalThis.location;
    let directRequest;
    let proxyRequest;
    globalThis.location = { origin: 'https://st.example' };
    globalThis.parent = {
        location: { origin: 'https://st.example' },
        SillyTavern: { getContext: () => ({ getRequestHeaders: () => ({ 'Content-Type': 'application/json', 'X-CSRF-Token': 'test-csrf' }) }) },
        fetch: async (url, options) => {
            proxyRequest = { url, options };
            return new Response(JSON.stringify({ result: { models: [{ model_name: 'proxy-model' }] } }), { status: 200 });
        },
    };
    globalThis.fetch = async (url, options) => {
        directRequest = { url, options };
        throw new TypeError('Failed to fetch');
    };
    try {
        const result = await client.listModels();
        assert.deepEqual(result.models, ['proxy-model']);
        assert.equal(result.source, 'proxy');
        assert.equal(result.diagnostics.direct, '已禁用');
        assert.equal(result.diagnostics.suspectedCors, false);
        assert.equal(result.diagnostics.proxy, 'HTTP 200');
        assert.equal(directRequest, undefined);
        assert.equal(proxyRequest.url, '/api/backends/chat-completions/status');
        assert.equal(proxyRequest.options.headers.get('X-CSRF-Token'), 'test-csrf');
        assert.equal(proxyRequest.options.credentials, 'same-origin');
        assert.equal(proxyRequest.options.method, 'POST');
        const proxyBody = JSON.parse(proxyRequest.options.body);
        assert.equal(proxyBody.chat_completion_source, 'custom');
        assert.equal(proxyBody.custom_url, 'https://provider.example/api/v3');
        assert.deepEqual(JSON.parse(proxyBody.custom_include_headers), { Authorization: 'Bearer secret-key' });
        assert.doesNotMatch(JSON.stringify(result), /secret-key/);
    } finally {
        globalThis.fetch = originalFetch;
        if (originalParent === undefined) delete globalThis.parent;
        else globalThis.parent = originalParent;
        if (originalLocation === undefined) delete globalThis.location;
        else globalThis.location = originalLocation;
    }
});

test('connection test switches to max_completion_tokens when max_tokens is explicitly rejected', async () => {
    const storage = { getItem: () => 'saved-key', setItem: () => {}, removeItem: () => {} };
    const settings = normalizeSettings({ apiBaseUrl: 'https://example.com', model: 'model-x' });
    const client = new SummaryApiClient({ getSettings: () => settings, storage, storageKey: 'key' });
    const originalFetch = globalThis.fetch;
    const originalParent = globalThis.parent;
    const requests = [];
    globalThis.parent = {
        location: { href: 'https://st.example/chat' },
        getRequestHeaders: () => ({ 'X-CSRF-Token': 'csrf' }),
        fetch: async (url, options) => {
            requests.push({ url, payload: JSON.parse(options.body) });
            if (requests.length === 1) return new Response(JSON.stringify({ error: { message: 'Unsupported parameter max_tokens' } }));
            return new Response(JSON.stringify({ choices: [{ message: { content: 'OK' } }] }), { status: 200 });
        },
    };
    globalThis.fetch = async () => assert.fail('browser must not request a third-party API');
    try {
        const result = await client.test();
        assert.equal(result.ok, true);
        assert.equal(requests[0].url, '/api/backends/chat-completions/generate');
        assert.equal(requests[0].payload.max_tokens, 16);
        assert.equal(requests[0].payload.messages.at(-1).content, 'OK');
        assert.equal(requests[0].payload.stream, true);
        assert.equal(requests[1].payload.max_completion_tokens, 16);
        assert.equal('max_tokens' in requests[1].payload, false);
        assert.equal(requests[1].payload.temperature, 0);
    } finally {
        globalThis.fetch = originalFetch;
        if (originalParent === undefined) delete globalThis.parent;
        else globalThis.parent = originalParent;
    }
});

test('hot unload cancellation is distinguishable from an API timeout', async () => {
    const storage = { getItem: () => 'saved-key', setItem: () => {}, removeItem: () => {} };
    const settings = normalizeSettings({ apiBaseUrl: 'https://example.com/v1', model: 'test-model' });
    const client = new SummaryApiClient({ getSettings: () => settings, storage, storageKey: 'key' });
    const originalFetch = globalThis.fetch;
    const originalParent = globalThis.parent;
    globalThis.parent = {
        location: { href: 'https://st.example/chat' },
        getRequestHeaders: () => ({ 'X-CSRF-Token': 'csrf' }),
        fetch: async (_url, options) => new Promise((_resolve, reject) => {
            options.signal.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')), { once: true });
        }),
    };
    globalThis.fetch = async () => assert.fail('browser must not request a third-party API');
    try {
        const pending = client.complete({ systemPrompt: 'system', userContent: 'body' });
        client.abortAll();
        await assert.rejects(pending, error => error.code === 'REQUEST_ABORTED');
    } finally {
        globalThis.fetch = originalFetch;
        if (originalParent === undefined) delete globalThis.parent;
        else globalThis.parent = originalParent;
    }
});
