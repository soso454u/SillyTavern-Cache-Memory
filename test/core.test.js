import test from 'node:test';
import assert from 'node:assert/strict';

import { SummaryApiClient } from '../src/api-client.js';
import { INJECTION_MODES, normalizeSettings } from '../src/defaults.js';
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
        title: 'frozen',
        status: 'frozen',
    });

    assistant.mes = 'edited body';
    fixture.store.syncMessages([assistant]);
    const stored = fixture.store.getSummary(entry.messageId);
    assert.equal(stored.messageIndex, 0);
    assert.equal(stored.status, 'stale');
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
    const settings = normalizeSettings({ checkpointInterval: 2, longMemoryInterval: 4 });
    let calls = 0;
    const apiClient = {
        async complete({ userContent }) {
            calls += 1;
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

test('independent API client posts directly with its own browser-stored bearer key', async () => {
    const values = new Map([['key', 'private-key']]);
    const storage = {
        getItem: key => values.get(key) ?? null,
        setItem: (key, value) => values.set(key, value),
        removeItem: key => values.delete(key),
    };
    const settings = normalizeSettings({ apiBaseUrl: 'https://example.com/v1/', model: 'small-model' });
    const client = new SummaryApiClient({ getSettings: () => settings, storage, storageKey: 'key' });
    const originalFetch = globalThis.fetch;
    let request;
    globalThis.fetch = async (url, options) => {
        request = { url, options };
        return new Response(JSON.stringify({ choices: [{ message: { content: 'OK' } }] }), { status: 200 });
    };
    try {
        const result = await client.complete({ systemPrompt: 'system', userContent: 'body' });
        assert.equal(result.content, 'OK');
        assert.equal(request.url, 'https://example.com/v1/chat/completions');
        assert.equal(request.options.headers.Authorization, 'Bearer private-key');
        const payload = JSON.parse(request.options.body);
        assert.equal(payload.model, 'small-model');
        assert.deepEqual(payload.messages.map(item => item.role), ['system', 'user']);
    } finally {
        globalThis.fetch = originalFetch;
    }
});
