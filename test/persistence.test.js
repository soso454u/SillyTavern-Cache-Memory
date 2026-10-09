import test from 'node:test';
import assert from 'node:assert/strict';
import { createEmptyStore, memoryContentDigest, mergeMemoryStores, MemoryStore } from '../src/memory-store.js';
import { MEMORY_SAVE_STATES, MemoryPersistenceCoordinator, readSillyTavernRemoteStore } from '../src/persistence.js';

function summary(id, floor, event = `event-${floor}`) {
    return { messageId: id, floor, event, raw: event, status: 'frozen', frozen: true };
}

function coordinatorFixture() {
    const metadata = { cache_memory: createEmptyStore('chat-a') };
    let chatId = 'chat-a';
    let remote = structuredClone(metadata.cache_memory);
    let saveCalls = 0;
    const coordinator = new MemoryPersistenceCoordinator({
        getChatId: () => chatId,
        getMetadata: () => metadata,
        readRemoteStore: async id => {
            assert.equal(id, chatId);
            return structuredClone(remote);
        },
        saveMetadata: async () => {
            saveCalls++;
            remote = structuredClone(metadata.cache_memory);
        },
    });
    coordinator.activate(chatId, metadata.cache_memory);
    return { coordinator, metadata, get remote() { return remote; }, set remote(value) { remote = structuredClone(value); },
        get saveCalls() { return saveCalls; }, set chatId(value) { chatId = value; } };
}

test('memory persistence waits for official save and confirms only after server read-back', async () => {
    const fixture = coordinatorFixture();
    fixture.metadata.cache_memory.summaries.m1 = summary('m1', 1);
    fixture.coordinator.enqueue(fixture.metadata.cache_memory, 'new summary');
    const state = await fixture.coordinator.flush('chat-a');
    assert.equal(state.state, MEMORY_SAVE_STATES.CONFIRMED);
    assert.equal(fixture.saveCalls, 1);
    assert.ok(fixture.remote.summaries.m1);
    assert.ok(fixture.remote.sync.writeId);
});

test('loaded page memory is not called confirmed until a direct server read-back matches', async () => {
    const fixture = coordinatorFixture();
    assert.equal(fixture.coordinator.getState('chat-a').state, MEMORY_SAVE_STATES.UNKNOWN);
    assert.equal((await fixture.coordinator.verify('chat-a')).state, MEMORY_SAVE_STATES.CONFIRMED);
    const remote = createEmptyStore('chat-a');
    remote.summaries.m2 = summary('m2', 2);
    fixture.remote = remote;
    assert.equal((await fixture.coordinator.verify('chat-a')).state, MEMORY_SAVE_STATES.CONFIRMED);
    assert.ok(fixture.metadata.cache_memory.summaries.m2);
});

test('stale device preserves a remote superset without overwriting newer records', async () => {
    const fixture = coordinatorFixture();
    fixture.metadata.cache_memory.summaries.m1 = summary('m1', 1);
    const newer = createEmptyStore('chat-a');
    newer.summaries.m1 = summary('m1', 1);
    newer.summaries.m2 = summary('m2', 2);
    fixture.remote = newer;
    fixture.coordinator.enqueue(fixture.metadata.cache_memory, 'old device update');
    const state = await fixture.coordinator.flush('chat-a');
    assert.equal(state.state, MEMORY_SAVE_STATES.CONFIRMED);
    assert.equal(fixture.saveCalls, 0);
    assert.ok(fixture.metadata.cache_memory.summaries.m1);
    assert.ok(fixture.metadata.cache_memory.summaries.m2);
});

test('swallowed SillyTavern save failure remains retryable and is never reported confirmed', async () => {
    const metadata = { cache_memory: createEmptyStore('chat-a') };
    const remote = structuredClone(metadata.cache_memory);
    const coordinator = new MemoryPersistenceCoordinator({
        getChatId: () => 'chat-a', getMetadata: () => metadata,
        readRemoteStore: async () => structuredClone(remote),
        saveMetadata: async () => {},
    });
    coordinator.activate('chat-a', metadata.cache_memory);
    metadata.cache_memory.summaries.m1 = summary('m1', 1);
    coordinator.enqueue(metadata.cache_memory, 'new summary');
    const state = await coordinator.flush('chat-a');
    assert.equal(state.state, MEMORY_SAVE_STATES.FAILED);
    assert.ok(coordinator.pending.has('chat-a'));
});

test('failed saves retain a chat-isolated pending snapshot in browser storage for reload retry', async () => {
    const values = new Map();
    const storage = { getItem: key => values.get(key) ?? null, setItem: (key, value) => values.set(key, value) };
    const metadata = { cache_memory: createEmptyStore('chat-a') };
    const remote = structuredClone(metadata.cache_memory);
    const makeCoordinator = () => new MemoryPersistenceCoordinator({
        getChatId: () => 'chat-a', getMetadata: () => metadata, storage,
        readRemoteStore: async () => structuredClone(remote), saveMetadata: async () => {},
    });
    const first = makeCoordinator();
    first.activate('chat-a', metadata.cache_memory);
    metadata.cache_memory.summaries.m1 = summary('m1', 1);
    first.enqueue(metadata.cache_memory, 'new summary');
    assert.equal((await first.flush('chat-a')).state, MEMORY_SAVE_STATES.FAILED);
    const second = makeCoordinator();
    assert.ok(second.pending.get('chat-a').snapshot.summaries.m1);
});

test('queued saves never write after switching to another chat', async () => {
    const fixture = coordinatorFixture();
    fixture.metadata.cache_memory.summaries.m1 = summary('m1', 1);
    fixture.chatId = 'chat-b';
    fixture.coordinator.enqueue(fixture.metadata.cache_memory, 'late chat-a change');
    const state = await fixture.coordinator.flush('chat-a');
    assert.equal(state.state, MEMORY_SAVE_STATES.PENDING);
    assert.equal(fixture.saveCalls, 0);
});

test('merge adds disjoint records and reports same-ID content conflicts without timestamp wins', () => {
    const current = createEmptyStore('chat-a');
    current.summaries.m1 = summary('m1', 1, 'current');
    current.checkpoints.push({ id: 'checkpoint-001', startFloor: 1, endFloor: 5, content: 'same' });
    current.keepRegistry['KEEP-0001'] = { text: 'current keep', status: 'active' };
    const imported = createEmptyStore('chat-a');
    imported.summaries.m1 = { ...summary('m1', 1, 'incoming'), updatedAt: '2099-01-01' };
    imported.summaries.m2 = summary('m2', 2);
    imported.checkpoints.push({ id: 'checkpoint-001', startFloor: 1, endFloor: 5, content: 'same', createdAt: 'later' });
    imported.longMemories.push({ id: 'long-001', startFloor: 1, endFloor: 50, content: 'long' });
    imported.keepRegistry['KEEP-0001'] = { text: 'incoming keep', status: 'resolved' };
    const result = mergeMemoryStores(current, imported, 'chat-a');
    assert.equal(result.added.summaries, 1);
    assert.equal(result.added.longMemories, 1);
    assert.equal(result.conflicts.length, 2);
    assert.equal(result.merged.summaries.m1.event, 'current');
    assert.equal(result.merged.keepRegistry['KEEP-0001'].text, 'current keep');
    assert.ok(result.merged.summaries.m2);
    assert.notEqual(memoryContentDigest(result.merged), memoryContentDigest(current));
});

test('partial message loading never marks a healthy Summary orphaned', () => {
    const metadata = {};
    const store = new MemoryStore({ getMetadata: () => metadata, getChatId: () => 'chat-a', saveMetadata: () => {} });
    store.addSummary({ ...summary('message-known', 8), messageIndex: 12 });
    store.syncMessages([]);
    assert.equal(store.getSummary('message-known').status, 'frozen');
    store.markSummaryOrphanedAtMessageIndex(12);
    assert.equal(store.getSummary('message-known').status, 'orphaned');
});

test('remote reader rejects ambiguous HTTP 200 objects and reads verified chat metadata arrays', async () => {
    const context = {
        chatId: 'chat-a', characterId: 0, groupId: null,
        characters: [{ name: 'A', avatar: 'a.png' }], chatMetadata: { integrity: 'slug' },
        getRequestHeaders: () => ({ 'Content-Type': 'application/json' }),
    };
    await assert.rejects(() => readSillyTavernRemoteStore(() => context, 'chat-a', async () => new Response('{}')), /无法验证/);
    const result = await readSillyTavernRemoteStore(() => context, 'chat-a', async () => new Response(JSON.stringify([
        { chat_metadata: { integrity: 'slug', cache_memory: { version: 4, summaries: {}, checkpoints: [], longMemories: [] } } },
    ])));
    assert.equal(result.version, 4);
});
