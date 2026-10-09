import test from 'node:test';
import assert from 'node:assert/strict';
import { MemoryPersistenceCoordinator } from '../src/persistence.js';
import { createEmptyStore, memoryContentDigest } from '../src/memory-store.js';

const gate = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };
const add = (store, id) => { store.summaries[id] = { messageId: id, event: id, status: 'frozen' }; };
function fixture(extra = {}) {
    let id = 'a', remote = createEmptyStore('a');
    const metadata = { cache_memory: structuredClone(remote) };
    const values = new Map();
    const storage = { getItem: key => values.get(key), setItem: (key, value) => values.set(key, value) };
    const options = { getChatId: () => id, getMetadata: () => metadata, storage, timeoutMs: 25,
        readRemoteStore: async () => structuredClone(remote), saveMetadata: async () => { remote = structuredClone(metadata.cache_memory); }, ...extra };
    const p = new MemoryPersistenceCoordinator(options);
    p.activate('a', metadata.cache_memory);
    return { p, metadata, options, values, get remote() { return remote; }, set remote(value) { remote = value; }, set id(value) { id = value; } };
}

test('read-back equality cannot clear a newer queued snapshot', async () => {
    const f = fixture(), started = gate(), release = gate();
    add(f.metadata.cache_memory, 'one'); f.remote = structuredClone(f.metadata.cache_memory);
    let reads = 0;
    f.p.readRemoteStore = async () => { const result = structuredClone(f.remote); if (++reads === 1) { started.resolve(); await release.promise; } return result; };
    f.p.enqueue(f.metadata.cache_memory); const saving = f.p.flush();
    await started.promise; add(f.metadata.cache_memory, 'two'); f.p.enqueue(f.metadata.cache_memory); release.resolve();
    // It may need conflict resolution because the baseline changed, but cannot lose two.
    await saving;
    assert.ok(f.p.pending.get('a')?.snapshot.summaries.two || f.remote.summaries.two);
});

test('chat switch during remote preflight cannot write old memory into the new chat', async () => {
    const f = fixture(), started = gate(), release = gate(); let saves = 0;
    f.p.readRemoteStore = async () => { started.resolve(); await release.promise; return f.remote; };
    f.p.saveMetadata = async () => { saves++; };
    add(f.metadata.cache_memory, 'one'); f.p.enqueue(f.metadata.cache_memory); const saving = f.p.flush();
    await started.promise; f.id = 'b'; f.metadata.cache_memory = createEmptyStore('b'); f.p.activate('b', f.metadata.cache_memory); release.resolve();
    await saving;
    assert.equal(f.metadata.cache_memory.chatId, 'b'); assert.equal(saves, 0); assert.ok(f.p.pending.has('a'));
});

test('hung native save releases queue with failure and retains local snapshot without parallel rewrites', async () => {
    const release = gate(); let writes = 0;
    const f = fixture({ saveMetadata: () => { writes++; return release.promise; } });
    add(f.metadata.cache_memory, 'one'); f.p.enqueue(f.metadata.cache_memory);
    assert.equal((await f.p.flush()).state, 'failed'); assert.equal(f.p.running.size, 0);
    assert.ok(f.p.pending.has('a'));
    assert.equal((await f.p.flush()).state, 'failed'); assert.equal(writes, 1);
    release.resolve(); await Promise.resolve();
    f.p.saveMetadata = async () => { f.remote = structuredClone(f.metadata.cache_memory); };
    assert.equal((await f.p.flush()).state, 'confirmed');
});

test('hung read releases queue and a later retry confirms normally', async () => {
    const f = fixture(); const read = f.p.readRemoteStore;
    f.p.readRemoteStore = () => new Promise(() => {});
    add(f.metadata.cache_memory, 'one'); f.p.enqueue(f.metadata.cache_memory);
    assert.equal((await f.p.flush()).state, 'failed'); assert.equal(f.p.running.size, 0);
    f.p.readRemoteStore = read; assert.equal((await f.p.flush()).state, 'confirmed');
});

test('legacy pending conflicts survive reload until explicitly resolved', async () => {
    const f = fixture(); add(f.remote, 'one'); f.remote.summaries.one.event = 'remote differs'; add(f.metadata.cache_memory, 'one'); add(f.remote, 'other');
    f.p.conflicts.set('a', { local: structuredClone(f.metadata.cache_memory), remote: structuredClone(f.remote) });
    f.p.setState('a', 'conflict');
    f.p.getChatId = () => 'inactive';
    add(f.metadata.cache_memory, 'two'); f.p.enqueue(f.metadata.cache_memory);
    const reload = new MemoryPersistenceCoordinator(f.options);
    reload.activate('a', f.metadata.cache_memory); await reload.flush();
    assert.equal(reload.getState().state, 'conflict'); assert.equal(reload.conflicts.size, 1);
    assert.ok(reload.pending.get('a').snapshot.summaries.two);
    assert.ok(f.remote.summaries.other); assert.equal(f.remote.summaries.one.event, 'remote differs');
    await reload.resolveConflict('a', 'local');
    assert.equal(reload.getState().state, 'confirmed'); assert.ok(f.remote.summaries.two);
});

test('page activation alone cannot confirm pending data', () => {
    const f = fixture(); add(f.metadata.cache_memory, 'one'); f.p.enqueue(f.metadata.cache_memory);
    const reloaded = new MemoryPersistenceCoordinator(f.options);
    reloaded.activate('a', f.metadata.cache_memory);
    assert.equal(reloaded.getState().state, 'pending'); assert.ok(reloaded.pending.has('a'));
});

test('authoritative read returning after a switch cannot overwrite another chat', async () => {
    const started = gate(), release = gate();
    const f = fixture({ readAuthoritativeStore: async () => { started.resolve(); await release.promise; return { revision: 2, store: createEmptyStore('a') }; }, commitAuthoritative: async () => {} });
    const syncing = f.p.sync(); await started.promise;
    f.id = 'b'; f.metadata.cache_memory = createEmptyStore('b'); f.p.activate('b', f.metadata.cache_memory); release.resolve();
    await syncing; assert.equal(f.metadata.cache_memory.chatId, 'b');
});

test('authoritative commit cannot overwrite an edit queued while it was saving', async () => {
    const started = gate(), release = gate(); let record = { revision: 0, store: createEmptyStore('a') }, count = 0;
    const f = fixture({ readAuthoritativeStore: async () => structuredClone(record), commitAuthoritative: async (_id, payload) => {
        if (++count === 1) { started.resolve(); await release.promise; }
        record = { revision: record.revision + 1, store: structuredClone(payload.snapshot) }; return { record };
    } });
    add(f.metadata.cache_memory, 'one'); f.p.enqueue(f.metadata.cache_memory); const saving = f.p.flush();
    await started.promise; add(f.metadata.cache_memory, 'two'); f.p.enqueue(f.metadata.cache_memory); release.resolve();
    await saving; assert.ok(f.metadata.cache_memory.summaries.two); assert.ok(record.store.summaries.two);
    assert.equal(memoryContentDigest(record.store), memoryContentDigest(f.metadata.cache_memory)); assert.equal(count, 2);
});
