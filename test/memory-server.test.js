import test from 'node:test';
import assert from 'node:assert/strict';

import { threeWayMerge } from '../server-plugin/cache-memory-memory/index.mjs';
import { MemoryPersistenceCoordinator, MEMORY_SAVE_STATES } from '../src/persistence.js';

const store = (id, summaries = {}) => ({ version: 5, chatId: id, summaries, checkpoints: [], longMemories: [], keepRegistry: {}, injectionSnapshot: null, sync: { revision: 0 } });
const summary = (id, floor, text = id) => ({ messageId: id, floor, raw: text, status: 'frozen', frozen: true });

test('authoritative server merge keeps disjoint stable IDs and reports same-ID conflicts', () => {
    const base = store('chat-a', { a: summary('a', 1) });
    const local = store('chat-a', { a: summary('a', 1), b: summary('b', 2) });
    const remote = store('chat-a', { a: summary('a', 1), c: summary('c', 3) });
    const merged = threeWayMerge(base, local, remote);
    assert.deepEqual(Object.keys(merged.merged.summaries).sort(), ['a', 'b', 'c']);
    assert.equal(merged.conflicts.length, 0);
    const conflict = threeWayMerge(base, { ...local, summaries: { a: summary('a', 1, 'local') } }, { ...remote, summaries: { a: summary('a', 1, 'remote'), c: summary('c', 3) } });
    assert.equal(conflict.conflicts[0].id, 'a');
});

test('authoritative persistence migrates old metadata once and confirms server commit', async () => {
    const metadata = { cache_memory: store('chat-a', { a: summary('a', 1) }) };
    let remote = { chatId: 'chat-a', revision: 0, store: null };
    const client = {
        getChatId: () => 'chat-a',
        getMetadata: () => metadata,
        readRemoteStore: async () => null,
        saveMetadata: async () => { throw new Error('must not use chat_metadata as authority'); },
        readAuthoritativeStore: async () => structuredClone(remote),
        commitAuthoritative: async (_id, payload) => {
            remote = { chatId: 'chat-a', revision: remote.revision + 1, store: structuredClone(payload.snapshot) };
            return { state: 'committed', record: remote };
        },
    };
    const coordinator = new MemoryPersistenceCoordinator(client);
    await coordinator.sync('chat-a', metadata.cache_memory);
    await coordinator.flush('chat-a');
    assert.equal(coordinator.getState('chat-a').state, MEMORY_SAVE_STATES.CONFIRMED);
    assert.equal(remote.store.summaries.a.raw, 'a');
    assert.equal(remote.revision, 1);
});
