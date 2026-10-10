import test from 'node:test';
import assert from 'node:assert/strict';
import { MemoryPersistenceCoordinator } from '../src/persistence.js';
import { createEmptyStore, memoryContentDigest } from '../src/memory-store.js';

const clone = value => structuredClone(value);
const row = event => ({ messageId: 'm1', floor: 1, event, status: 'frozen', frozen: true });
function storage() {
    const data = new Map();
    return { getItem: key => data.get(key) ?? null, setItem: (key, value) => data.set(key, value), removeItem: key => data.delete(key),
        key: index => [...data.keys()][index], get length() { return data.size; } };
}
function fixture(authority = false, sharedStorage = storage(), sessionStorage = storage()) {
    let remote = createEmptyStore('a'), writes = 0;
    remote.summaries.m1 = row('original');
    const metadata = { cache_memory: clone(remote) };
    const options = { getChatId: () => 'a', getMetadata: () => metadata, storage: sharedStorage, sessionStorage,
        readRemoteStore: async () => clone(remote), saveMetadata: async () => { writes++; remote = clone(metadata.cache_memory); },
        ...(authority ? { readAuthoritativeStore: async () => ({ revision: remote.sync.revision, store: clone(remote) }),
            commitAuthoritative: async (_, payload) => { writes++; remote = clone(payload.snapshot); return { record: { revision: remote.sync.revision, store: clone(remote) } }; } } : {}) };
    const p = new MemoryPersistenceCoordinator(options); p.activate('a', metadata.cache_memory);
    return { p, options, metadata, get remote() { return remote; }, set remote(value) { remote = value; }, get writes() { return writes; } };
}

for (const authority of [false, true]) test(`idle cached records, server deletions and frozen snapshots never become edits (authority=${authority})`, async () => {
    const f = fixture(authority);
    f.remote = createEmptyStore('a');
    f.remote.injectionSnapshot = { value: 'server frozen bytes', blocks: [] };
    for (let n = 0; n < 4; n++) {
        assert.equal((await f.p.verify()).state, 'confirmed');
        assert.equal((await f.p.reread()).state, 'confirmed');
        assert.equal(memoryContentDigest(f.metadata.cache_memory), memoryContentDigest(f.remote));
        await f.p.enqueue(f.metadata.cache_memory); await f.p.flush();
    }
    assert.equal(f.metadata.cache_memory.summaries.m1, undefined);
    assert.equal(f.writes, 0); assert.equal(f.p.pending.size, 0); assert.equal(f.p.conflicts.size, 0);
});

test('unchanged activation cannot enqueue an automatic write even before the first server read', async () => {
    const f = fixture();
    await f.p.enqueue(f.metadata.cache_memory); await f.p.flush();
    assert.equal(f.writes, 0); assert.equal(f.p.pending.size, 0);
});

test('a read returning after a real local edit never replaces or confirms that edit', async () => {
    const f = fixture(); let release;
    f.p.readRemoteStore = () => new Promise(resolve => { release = resolve; });
    const reading = f.p.reread(); await Promise.resolve();
    f.metadata.cache_memory.summaries.m1.event = 'real new edit';
    release(clone(f.remote)); await reading;
    assert.equal(f.metadata.cache_memory.summaries.m1.event, 'real new edit');
    assert.notEqual(f.p.getState().state, 'confirmed'); assert.equal(f.writes, 0);
});

test('live windows do not restore, merge or erase each other journals; the owning tab reload recovers', async () => {
    const shared = storage(), session = storage(), first = fixture(false, shared, session);
    first.p.getChatId = () => 'inactive';
    first.metadata.cache_memory.summaries.m1.event = 'owner unsaved edit';
    await first.p.enqueue(first.metadata.cache_memory);
    const originalJournal = shared.getItem(first.p.storageKey);
    const idle = fixture(false, shared, storage());
    assert.equal(idle.p.pending.size, 0); idle.p.persistPending();
    assert.equal(shared.getItem(first.p.storageKey), originalJournal);
    const reload = new MemoryPersistenceCoordinator(first.options);
    assert.equal(reload.storageKey, first.p.storageKey);
    assert.equal(reload.pending.get('a').snapshot.summaries.m1.event, 'owner unsaved edit');
});

test('ordinary ST manual preflight detects a competing server edit before saving', async () => {
    const f = fixture(), before = clone(f.remote); let reads = 0;
    f.metadata.cache_memory.summaries.m1.event = 'local choice';
    f.p.readRemoteStore = async () => { if (++reads === 2) f.remote.summaries.m1.event = 'competing edit'; return clone(f.remote); };
    assert.equal((await f.p.uploadCurrentChat()).state, 'conflict');
    assert.equal(f.writes, 0); assert.deepEqual(f.p.uploadBackup().store, before);
});

test('ordinary ST manual readback mismatch retains the local branch and server backup', async () => {
    const f = fixture(); let reads = 0;
    f.metadata.cache_memory.summaries.m1.event = 'local choice';
    f.p.readRemoteStore = async () => { if (++reads === 3) f.remote.summaries.m1.event = 'post-save competing edit'; return clone(f.remote); };
    assert.equal((await f.p.uploadCurrentChat()).state, 'conflict');
    assert.equal(f.writes, 1); assert.ok(f.p.uploadBackup());
    assert.equal(f.p.conflictBundle().local.summaries.m1.event, 'local choice');
    assert.equal(f.p.conflictBundle().remote.summaries.m1.event, 'post-save competing edit');
    await f.p.flush(); assert.equal(f.writes, 1);
});

test('duplicated tab sessionStorage cannot inherit a live journal, including a duplicate of a duplicate', async () => {
    const held = new Set();
    const locks = { request: async (key, _, callback) => {
        if (held.has(key)) return callback(null);
        held.add(key);
        try { return await callback({ name: key }); } finally { held.delete(key); }
    } };
    const shared = storage(), firstSession = storage();
    const make = session => {
        const metadata = {cache_memory: createEmptyStore('a')};
        const p = new MemoryPersistenceCoordinator({getChatId: () => 'inactive', getMetadata: () => metadata, storage: shared, sessionStorage: session, locks});
        return {p, metadata};
    };
    const first = make(firstSession); await first.p.ready;
    first.metadata.cache_memory.summaries.m1 = row('only first edited'); await first.p.enqueue(first.metadata.cache_memory);
    const duplicateSession = storage(); duplicateSession.setItem('cache_memory_pending_saves_v1', first.p.storageKey);
    const duplicate = make(duplicateSession); await duplicate.p.ready;
    assert.equal(duplicate.p.pending.size, 0); assert.notEqual(duplicate.p.storageKey, first.p.storageKey);
    duplicate.metadata.cache_memory.summaries.m1 = row('only second edited'); await duplicate.p.enqueue(duplicate.metadata.cache_memory);
    const thirdSession = storage(); thirdSession.setItem('cache_memory_pending_saves_v1', duplicate.p.storageKey);
    const third = make(thirdSession); await third.p.ready;
    assert.equal(third.p.pending.size, 0); assert.notEqual(third.p.storageKey, duplicate.p.storageKey);
    for (const {p} of [first, duplicate, third]) p.releaseJournal();
    await new Promise(resolve => setImmediate(resolve));
    const reloaded = make(firstSession); await reloaded.p.ready;
    assert.equal(reloaded.p.pending.get('a').snapshot.summaries.m1.event, 'only first edited'); reloaded.p.releaseJournal();
});

test('read-only source bookkeeping stays clean without replacing the server merge base for the next real edit', async () => {
    const f = fixture();
    f.metadata.cache_memory.summaries.m1.sourceFingerprint = 'rebound-source';
    f.p.noteReadOnlySnapshot(f.metadata.cache_memory);
    await f.p.enqueue(f.metadata.cache_memory); assert.equal(f.p.pending.size, 0);
    f.metadata.cache_memory.summaries.m1.event = 'real edit after bookkeeping';
    await f.p.enqueue(f.metadata.cache_memory);
    assert.equal((await f.p.flush()).state, 'confirmed'); assert.equal(f.writes, 1);
    assert.equal(f.remote.summaries.m1.event, 'real edit after bookkeeping');
});

test('LAN HTTP without Web Locks isolates copied live journals using the browser channel', async () => {
    const channels = new Set();
    const createJournalChannel = () => {
        const channel = {onmessage:null, close:()=>channels.delete(channel), postMessage(data) {
            for (const other of channels) if (other!==channel) queueMicrotask(()=>other.onmessage?.({data}));
        }};channels.add(channel);return channel;
    };
    const shared=storage(), session=storage();
    const make = ownSession => {
        const metadata={cache_memory:createEmptyStore('a')};
        return {metadata,p:new MemoryPersistenceCoordinator({getChatId:()=> 'inactive',getMetadata:()=>metadata,storage:shared,sessionStorage:ownSession,createJournalChannel})};
    };
    const first=make(session);await first.p.ready;
    first.metadata.cache_memory.summaries.m1=row('only owner edited');await first.p.enqueue(first.metadata.cache_memory);
    const copied=storage();copied.setItem('cache_memory_pending_saves_v1',first.p.storageKey);
    const duplicate=make(copied);await duplicate.p.ready;
    assert.notEqual(duplicate.p.storageKey,first.p.storageKey);assert.equal(duplicate.p.pending.size,0);
    duplicate.p.persistPending();assert.ok(shared.getItem(first.p.storageKey));
    first.p.releaseJournal();duplicate.p.releaseJournal();
    const reload=make(session);await reload.p.ready;
    assert.equal(reload.p.pending.get('a').snapshot.summaries.m1.event,'only owner edited');reload.p.releaseJournal();
});
