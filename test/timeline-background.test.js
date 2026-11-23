import test from 'node:test';
import assert from 'node:assert/strict';
import { BackgroundMemoryTasks } from '../src/background-memory.js';
import { hydrateHostChat } from '../src/host-chat.js';
import { MemoryStore, createEmptyStore, memoryContentDigest } from '../src/memory-store.js';
import { getAssistantMessages, chatInheritedThrough, resetBranchNumbering, trimBranchTimeline } from '../src/utils.js';
import { normalizeSettings } from '../src/defaults.js';
import { refreshSnapshot } from '../src/cache-control.js';

const clone = value => structuredClone(value);
function backgroundFixture({ authority = false } = {}) {
    const context = { characterId: 0, characters: [{ avatar: 'a.png', name: '合成A' }, { avatar: 'b.png', name: '合成B' }],
        chatId: 'playing', chat: [{ mes: '当前正在玩的正文' }], chatMetadata: { privateOtherState: true }, getRequestHeaders: () => ({ 'Content-Type': 'application/json' }) };
    const disk = new Map(['one', 'two'].map(file => [file, [{ chat_metadata: { integrity: `integrity-${file}`, unrelated: { keep: true } } },
        { mes: '合成开场' }, { is_user: true, mes: '请送信' }, { mes: '信使接过信件。', gen_started: 'g1' },
        { is_user: true, mes: '送到后回报' }, { mes: '信使送达信件并返回。', gen_started: 'g2' }]]));
    const writes = [], calls = [], authorities = new Map();
    const f = { context, disk, writes, calls, authorities, duringModel: null, duringRead: null };
    const fetchImpl = async (url, init) => {
        if (init.signal?.aborted) throw Object.assign(new Error('cancelled'), { code: 'REQUEST_ABORTED' });
        const body = JSON.parse(init.body);
        let value;
        if (url === '/api/characters/chats') value = [...disk.keys()].map(file => ({ file_name: `${file}.jsonl` }));
        else if (url === '/api/chats/get') { f.duringRead?.(body.file_name); value = disk.get(body.file_name); }
        else if (url === '/api/chats/save') { writes.push(clone(body)); disk.set(body.file_name, clone(body.chat)); value = { ok: true }; }
        else throw new Error(`Unexpected ${url}`);
        return new Response(JSON.stringify(value));
    };
    const server = authority ? { available: true,
        read: async id => ({ chatId: id, revision: authorities.get(id)?.sync.revision ?? 0, store: clone(authorities.get(id) ?? null) }),
        commit: async (id, payload) => {
            assert.equal(payload.baseRevision, authorities.get(id)?.sync.revision ?? 0);
            authorities.set(id, clone(payload.snapshot));
            return { record: { chatId: id, revision: payload.snapshot.sync.revision, store: clone(payload.snapshot) } };
        } } : null;
    f.tasks = new BackgroundMemoryTasks({ getContext: () => context,
        getSettings: () => normalizeSettings({ checkpointInterval: 2, longMemoryInterval: 2 }), fetchImpl, memoryServer: server,
        createApiClient: () => ({ abortAll() {}, complete: async request => {
            calls.push(request);
            await f.duringModel?.();
            return { content: request.userContent.startsWith('[PREVIOUS_CONTEXT]') ? '[CHECKPOINT]\n[Stage Story]\n信使完成送信并返回。'
                : request.userContent.startsWith('[EXISTING_LONG_FACTS]') ? '[STORY_ARC]\n信使完成了两人的通信。\n[LONG_MEMORY]\n送信已完成。'
                    : '[SUMMARY]\n[Event]\n信使按约处理信件。' };
        } }) });
    return f;
}

for (const authority of [false, true]) test(`background tasks save each selected chat without switching the foreground (authority=${authority})`, async () => {
    const f = backgroundFixture({ authority }), before = clone({ chat: f.context.chat, chatMetadata: f.context.chatMetadata });
    const state = await f.tasks.start('b.png', ['one', 'two']);
    assert.equal(state.status, 'completed', state.message);
    assert.equal(state.completed, 2);
    assert.deepEqual(f.context.chat, before.chat); assert.deepEqual(f.context.chatMetadata, before.chatMetadata);
    assert.equal(f.context.chatId, 'playing'); assert.equal(f.calls.length, 8);
    for (const file of ['one', 'two']) {
        const rows = f.disk.get(file), memory = rows[0].chat_metadata.cache_memory;
        assert.equal(memory.chatId, JSON.stringify(['character', 'b.png', file]));
        assert.equal(Object.keys(memory.summaries).length, 2);
        assert.equal(memory.checkpoints.length, 1); assert.equal(memory.longMemories.length, 1);
        assert.deepEqual(rows[0].chat_metadata.unrelated, { keep: true });
        assert.equal(rows[3].mes, '信使接过信件。');
        if (authority) assert.equal(memoryContentDigest(memory), memoryContentDigest(f.authorities.get(memory.chatId)));
    }
    const previousCalls = f.calls.length;
    assert.equal((await f.tasks.start('b.png', ['one'])).status, 'completed');
    assert.equal(f.calls.length, previousCalls, 'saved memory is reused without another model request');
});

test('background source edit during model generation cannot save an obsolete result', async () => {
    const f = backgroundFixture(); f.duringModel = () => { f.disk.get('one')[3].mes = '已修改为另一份正文'; };
    const state = await f.tasks.start('b.png', ['one']);
    assert.equal(state.status, 'failed'); assert.match(state.message, /正文或文件身份已变化/);
    assert.equal(f.writes.length, 0);
});

test('background opening, cancellation and ambiguous read responses never overwrite a target', async () => {
    const opened = backgroundFixture(); opened.context.characterId = 1; opened.context.chatId = 'one';
    assert.notEqual((await opened.tasks.start('b.png', ['one'])).status, 'completed'); assert.equal(opened.calls.length, 0);
    const cancelled = backgroundFixture(); cancelled.duringModel = () => cancelled.tasks.cancel();
    assert.equal((await cancelled.tasks.start('b.png', ['one'])).status, 'cancelled'); assert.equal(cancelled.writes.length, 0);
    const malformed = backgroundFixture(); malformed.disk.set('one', {});
    assert.equal((await malformed.tasks.start('b.png', ['one'])).status, 'failed'); assert.equal(malformed.writes.length, 0);
});

test('background saving preserves another extension metadata added while the model works', async () => {
    const f = backgroundFixture(); f.duringModel = () => { f.disk.get('one')[0].chat_metadata.newExtensionValue = { preserved: true }; };
    const state = await f.tasks.start('b.png', ['one']);
    assert.equal(state.status, 'completed', state.message);
    assert.deepEqual(f.disk.get('one')[0].chat_metadata.newExtensionValue, { preserved: true });
});

test('timeline invalidation removes every dependent layer and immediately replaces frozen injection', () => {
    const chat = Array.from({ length: 6 }, (_, i) => ({ mes: `合成正文${i + 1}`, gen_started: `g${i}` }));
    const metadata = { cache_memory: createEmptyStore('a') };
    const store = new MemoryStore({ getChatId: () => 'a', getMetadata: () => metadata, saveMetadata() {} });
    for (const row of getAssistantMessages(chat)) store.addSummary({ messageId: row.messageId, floor: row.floor, sourceContentFingerprint: row.contentFingerprint,
        event: `摘要${row.floor}`, keep: row.floor === 1 ? '早期约定' : '', status: 'frozen' });
    store.current().checkpoints = [{ id: 'before', startFloor: 1, endFloor: 2, content: '[Stage Story]\n早期剧情', status: 'frozen' },
        { id: 'after', startFloor: 3, endFloor: 6, content: '[Stage Story]\n已删除剧情', status: 'frozen' }];
    store.current().longMemories = [{ id: 'long', startFloor: 1, endFloor: 6, content: '[STORY_ARC]\n已删除剧情', status: 'frozen' }];
    const settings = normalizeSettings({ strictCacheMode: true, injectionMode: 'checkpoint-boundary' });
    store.current().injectionSnapshot = { value: '已删除剧情', blocks: [] };
    store.discardTimelineFrom(3);
    assert.deepEqual(Object.values(store.current().summaries).map(row => row.floor), [1, 2]);
    assert.deepEqual(store.current().checkpoints.map(row => row.id), ['before']); assert.deepEqual(store.current().longMemories, []);
    assert.ok(store.current().tombstones['Checkpoint:after']); assert.ok(store.current().tombstones['Long Memory:long']);
    assert.doesNotMatch(refreshSnapshot(store.current(), settings, 'timeline changed').value, /已删除剧情/);
    assert.equal(Object.values(store.current().keepRegistry)[0].text, '早期约定');
});

test('reload diagnoses already-saved deleted or rolled sources while preserving intentional branch inheritance', () => {
    const chat = Array.from({ length: 6 }, (_, index) => ({ mes: `旧正文${index + 1}`, gen_started: `g${index}` }));
    const metadata = { cache_memory: createEmptyStore('a') };
    const store = new MemoryStore({ getChatId: () => 'a', getMetadata: () => metadata, saveMetadata() {} });
    for (const entry of getAssistantMessages(chat)) store.addSummary({ messageId: entry.messageId, floor: entry.floor,
        sourceContentFingerprint: entry.contentFingerprint, event: `摘要${entry.floor}`, status: 'frozen' });
    assert.equal(store.changedTimelineFloor(chat), null);
    const deleted = clone(chat).slice(0, 5);
    assert.equal(store.changedTimelineFloor(deleted), 6);
    deleted[0].extra = { cache_memory_branch: { hasOpening: false, inheritedThrough: 6 } };
    for (const [index, row] of deleted.entries()) row.extra = { ...row.extra, cache_memory_branch_floor: index + 1 };
    assert.equal(store.changedTimelineFloor(deleted), null);
    chat[4].mes = 'roll后的第五层';
    assert.equal(store.changedTimelineFloor(chat), 5);
    assert.equal(store.changedTimelineFloor([chat[0], null]), null);
});

test('clearing inherited memory resets normal floors and native Swipe copies across a reload', () => {
    const chat = [{ mes: '开场', extra: { cache_memory_branch: { floorOffset: 0, inheritedThrough: 25, hasOpening: true } },
        swipe_info: [{ extra: { cache_memory_branch: { inheritedThrough: 25 } } }] },
    { mes: '保留的一层', gen_started: 'g1', extra: { cache_memory_branch_floor: 1 }, swipe_info: [{ extra: { cache_memory_branch_floor: 1 } }] }];
    const metadata = { cache_memory: createEmptyStore('a') };
    const store = new MemoryStore({ getChatId: () => 'a', getMetadata: () => metadata, saveMetadata() {} });
    store.clearCurrentChat(chat);
    const reloaded = clone(chat); reloaded.push({ mes: '新的第二层', gen_started: 'g2' });
    assert.deepEqual(getAssistantMessages(reloaded).map(row => row.floor), [1, 2]); assert.equal(chatInheritedThrough(reloaded), 0);
    assert.doesNotMatch(JSON.stringify(reloaded), /branch_floor|inheritedThrough/);
    reloaded[0].extra = clone(reloaded[0].swipe_info[0].extra);
    assert.deepEqual(getAssistantMessages(reloaded).map(row => row.floor), [1, 2]);
    resetBranchNumbering(reloaded); assert.equal(getAssistantMessages(reloaded)[0].floor, 1);
});

test('changing inherited raw history removes its future numbering boundary', () => {
    const chat = [{ mes: '开场', extra: { cache_memory_branch: { floorOffset: 0, inheritedThrough: 25, hasOpening: true } } },
        { mes: '旧回复', gen_started: 'g1', extra: { cache_memory_branch_floor: 1 } }];
    trimBranchTimeline(chat, 1); chat.push({ mes: '新回复', gen_started: 'g2' });
    assert.deepEqual(getAssistantMessages(chat).map(row => row.floor), [1, 2]);
});

test('TT fills only null history slots and keeps the absolute message indexes', async () => {
    const rows = [{ mes: '开场' }, { is_user: true, mes: '输入' }, { mes: '回复', gen_started: 'g1' }];
    const loaded = clone(rows[2]), context = { characterId: 0, characters: [{ avatar: 'a.png' }], chatId: 'one', chat: [null, null, loaded] };
    const root = { __TAURITAVERN__: { api: { chat: { current: { handle: () => ({ history: {
        tail: async () => ({ startIndex: 2, messages: [rows[2]], hasMoreBefore: true }),
        before: async () => ({ startIndex: 0, messages: rows.slice(0, 2), hasMoreBefore: false }),
    } }) } } } } };
    await hydrateHostChat(() => context, root);
    assert.deepEqual(context.chat, rows); assert.equal(context.chat[2], loaded); assert.equal(getAssistantMessages(context.chat)[0].messageIndex, 2);
    context.chat[0] = null; context.chat[2].mes = '未保存的本机改动';
    await assert.rejects(hydrateHostChat(() => context, root), /未覆盖/); assert.equal(context.chat[0], null);
});
