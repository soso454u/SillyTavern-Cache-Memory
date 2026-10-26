import test from 'node:test';
import assert from 'node:assert/strict';
import { chatFileIdentity } from '../src/chat-file.js';
import { readFile } from 'node:fs/promises';
import { MemoryPersistenceCoordinator, missingMemoryRecords } from '../src/persistence.js';
import { MemoryStore, createEmptyStore, memoryContentDigest, normalizeStore } from '../src/memory-store.js';

const clone = value => structuredClone(value);
const gate = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };
function full(id = 'a') {
    const value = createEmptyStore(id);
    for (let floor = 1; floor <= 318; floor++) value.summaries[`m${floor}`] = { messageId: `m${floor}`, floor, event: `历史${floor}`, status: 'frozen' };
    value.checkpoints = Array.from({ length: 63 }, (_, i) => ({ id: `cp${i}`, content: `阶段${i}`, status: 'frozen' }));
    value.longMemories = Array.from({ length: 6 }, (_, i) => ({ id: `long${i}`, content: `长期${i}`, status: 'frozen' }));
    value.keepRegistry['KEEP-0001'] = { text: '永久结果', status: 'active' };
    value.sync.revision = 10;
    return normalizeStore(value, id);
}
function fixture(authority = false) {
    const disk = new Map(), session = new Map();
    let remote = full(), chatId = 'a', writes = 0;
    const metadata = { cache_memory: clone(remote) };
    const durableStorage = { read: async key => clone(disk.get(key)), write: async (key, value) => disk.set(key, clone(value)),
        remove: async key => disk.delete(key), keys: async () => [...disk.keys()] };
    const options = { getChatId: () => chatId, getMetadata: () => metadata, durableStorage, timeoutMs: 30,
        sessionStorage: { getItem: key => session.get(key), setItem: (key, value) => session.set(key, value) },
        readRemoteStore: async () => clone(remote), saveMetadata: async () => { writes++; remote = clone(metadata.cache_memory); },
        ...(authority ? { readAuthoritativeStore: async () => ({ chatId, revision: remote?.sync.revision ?? 0, store: clone(remote) }),
            commitAuthoritative: async (_, payload) => { writes++; remote = clone(payload.snapshot); return { record: { chatId, revision: remote.sync.revision, store: clone(remote) } }; } } : {}) };
    const p = new MemoryPersistenceCoordinator(options);
    return { p, disk, metadata, options, durableStorage, get remote() { return remote; }, set remote(value) { remote = value; },
        set chatId(value) { chatId = value; }, get writes() { return writes; } };
}
async function activate(f) { await f.p.ready; f.p.activate('a', f.metadata.cache_memory); }

for (const authority of [false, true]) {
    test(`restart without manual restore never replaces 318-layer memory with an empty server copy (${authority})`, async () => {
        const f = fixture(authority); await activate(f);
        const original = clone(f.metadata.cache_memory); f.remote = createEmptyStore('a');
        assert.equal((await f.p.loadLatest()).state, 'conflict');
        assert.deepEqual(f.metadata.cache_memory, original); assert.equal(f.writes, 0);
        assert.equal(Object.keys(f.p.conflictBundle().local.summaries).length, 318);
        assert.equal(Object.keys(f.p.conflictBundle().remote.summaries).length, 0);
        await f.p.flush(); assert.equal(f.writes, 0);
    });
    for (const method of ['verify', 'reread']) test(`${method} quarantines partial server memory without auto merging (${authority})`, async () => {
        const f = fixture(authority); await activate(f);
        const original = clone(f.metadata.cache_memory);
        f.remote = createEmptyStore('a'); f.remote.summaries.m1 = clone(original.summaries.m1); f.remote.sync.revision = 100;
        assert.equal((await f.p[method]()).state, 'conflict');
        assert.deepEqual(f.metadata.cache_memory, original); assert.equal(f.writes, 0);
        assert.equal(Object.keys(f.p.conflictBundle().remote.summaries).length, 1);
    });
    test(`automatic save refuses a lost remote baseline even if it could merge records back (${authority})`, async () => {
        const f = fixture(authority); await activate(f);
        f.metadata.cache_memory.summaries.m319 = { messageId: 'm319', floor: 319, event: '新结果' };
        f.remote = createEmptyStore('a');
        await f.p.enqueue(f.metadata.cache_memory);
        assert.equal((await f.p.flush()).state, 'conflict'); assert.equal(f.writes, 0);
        assert.ok(f.p.pending.get('a').snapshot.summaries.m319);
        assert.equal(Object.keys(f.remote.summaries).length, 0);
    });
}

for (const section of ['summaries', 'checkpoints', 'longMemories', 'keepRegistry']) test(`missing ${section} is protected independently of total Summary count`, async () => {
    const f = fixture(); await activate(f);
    f.remote[section] = Array.isArray(f.remote[section]) ? [] : {};
    assert.equal((await f.p.loadLatest()).state, 'conflict'); assert.equal(f.writes, 0);
    assert.ok(missingMemoryRecords(full(), f.remote).length);
});

test('confirmed browser snapshot survives successful queue cleanup and a fresh tab after both live copies become empty', async () => {
    const f = fixture(); await activate(f); assert.equal((await f.p.verify()).state, 'confirmed');
    const key = 'cache_memory_verified_backup_v1:a', original = clone(f.disk.get(key));
    assert.equal(f.disk.has(f.p.storageKey), false);
    f.metadata.cache_memory = createEmptyStore('a'); f.remote = createEmptyStore('a');
    const reload = new MemoryPersistenceCoordinator({ ...f.options, sessionStorage: { getItem: () => null, setItem() {} } });
    await reload.ready; reload.activate('a', f.metadata.cache_memory);
    assert.equal((await reload.loadLatest()).state, 'conflict');
    assert.deepEqual(f.disk.get(key), original); assert.equal(f.writes, 0);
    const report = await reload.inspectRecovery();
    assert.ok(report.candidates.some(candidate => candidate.counts.Summary === 318 && candidate.counts.CP === 63 && candidate.counts.Long === 6 && candidate.counts.KEEP === 1));
    assert.equal(Object.keys(f.metadata.cache_memory.summaries).length, 0);
});

test('an empty local save cannot replace a complete remote without deletion markers', async () => {
    const f = fixture(); await activate(f);
    f.metadata.cache_memory = createEmptyStore('a'); await f.p.enqueue(f.metadata.cache_memory);
    assert.equal((await f.p.flush()).state, 'conflict'); assert.equal(f.writes, 0);
    assert.equal(Object.keys(f.remote.summaries).length, 318);
});

test('normal explicit clearing with tombstones still saves and retains the previous full recovery snapshot', async () => {
    const f = fixture(); await activate(f); await f.p.verify();
    const store = new MemoryStore({ getChatId: () => 'a', getMetadata: () => f.metadata, saveMetadata: (value, reason) => f.p.enqueue(value, reason) });
    store.clearCurrentChat(); assert.equal((await f.p.flush()).state, 'confirmed');
    assert.equal(Object.keys(f.remote.summaries).length, 0);
    const report = await f.p.inspectRecovery(); assert.ok(report.candidates.some(entry => entry.counts.Summary === 318));
    assert.equal((await f.p.loadLatest()).state, 'confirmed');
    assert.equal(Object.keys(f.metadata.cache_memory.summaries).length, 0);
});

test('orphaned IDB journals from closed sessions are discoverable without adopting or deleting them', async () => {
    const f = fixture(); await activate(f);
    const key = 'cache_memory_pending_saves_v1:closed-window';
    f.disk.set(key, [{ chatId: 'a', snapshot: full(), baseSnapshot: createEmptyStore('a') }]);
    const original = clone([...f.disk]); f.metadata.cache_memory = createEmptyStore('a'); f.remote = createEmptyStore('a');
    const report = await f.p.inspectRecovery();
    assert.ok(report.candidates.some(entry => entry.source.includes('closed-window') && entry.counts.Summary === 318));
    assert.deepEqual([...f.disk], original); assert.equal(f.p.pending.size, 0); assert.equal(f.writes, 0);
});

test('read timeout leaves generated candidate and original recoverable without another model request', async () => {
    const f = fixture(); await activate(f); f.p.readRemoteStore = () => new Promise(() => {});
    f.metadata.cache_memory.summaries.m319 = { messageId: 'm319', floor: 319, event: '已生成结果' };
    await f.p.enqueue(f.metadata.cache_memory);
    assert.equal((await f.p.flush()).state, 'failed'); assert.equal(f.writes, 0);
    const saved = f.disk.get(f.p.storageKey)[0]; assert.ok(saved.snapshot.summaries.m319); assert.equal(Object.keys(saved.baseSnapshot.summaries).length, 318);
    f.p.readRemoteStore = f.options.readRemoteStore;
    assert.equal((await f.p.flush()).state, 'confirmed'); assert.ok(f.remote.summaries.m319);
});

for (const damaged of [{ summaries: [] }, { checkpoints: {} }, { longMemories: null }, { keepRegistry: 'bad' }]) test(`damaged section cannot normalize to empty: ${JSON.stringify(damaged)}`, async () => {
    const f = fixture(); await activate(f); Object.assign(f.remote, damaged);
    const original = clone(f.metadata.cache_memory);
    assert.equal((await f.p.loadLatest()).state, 'failed'); assert.deepEqual(f.metadata.cache_memory, original); assert.equal(f.writes, 0);
    assert.throws(() => normalizeStore(f.remote, 'a'), /格式异常/);
});

test('persisted current-schema record missing a whole section is rejected before migration', () => {
    const damaged = full(); delete damaged.longMemories;
    assert.throws(() => normalizeStore(damaged, 'a'), /缺少必要分区/);
});

test('MemoryStore refuses to relabel loaded memory as a different character or filename', () => {
    const raw = full('old-chat'), metadata = { cache_memory: raw };
    const store = new MemoryStore({ getMetadata: () => metadata, getChatId: () => 'new-chat', saveMetadata: () => assert.fail('must not save') });
    assert.throws(() => store.current(), /身份不匹配/); assert.equal(metadata.cache_memory, raw); assert.equal(raw.chatId, 'old-chat');
});

test('initialization does not create a scoped ID until the selected chat and owner are both available', async () => {
    const source = await readFile(new URL('../index.js', import.meta.url), 'utf8');
    const body = source.match(/function memoryChatId\(\) \{([\s\S]*?)\n\}/)[1];
    let context = { chatId: 'story', characterId: 0, characters: [] }, id = 'story';
    const getId = new Function('getContext', 'getCurrentChatId', 'chatFileIdentity', body).bind(null, () => context, () => id, chatFileIdentity);
    assert.equal(getId(), ''); context.characters = [{ avatar: 'a.png' }];
    assert.equal(getId(), JSON.stringify(['character', 'a.png', 'story']));
    context.chatId = 'other'; assert.equal(getId(), '');
    context.chatId = 'story'; context.groupId = 0; assert.equal(getId(), JSON.stringify(['group', '0', 'story']));
});

test('chat switch while startup native read is pending cannot capture or replace the new chat', async () => {
    const f = fixture(), started = gate(), release = gate(); await activate(f);
    f.p.readRemoteStore = async () => { started.resolve(); await release.promise; return full(); };
    const loading = f.p.loadLatest(); await started.promise;
    f.chatId = 'b'; f.metadata.cache_memory = createEmptyStore('b'); f.p.activate('b', f.metadata.cache_memory);
    release.resolve(); await loading;
    assert.equal(f.metadata.cache_memory.chatId, 'b'); assert.equal(Object.keys(f.metadata.cache_memory.summaries).length, 0);
    assert.equal(f.writes, 0); assert.equal(f.disk.has('cache_memory_verified_backup_v1:b'), false);
});

test('failure to retain confirmed snapshot never clears the pending journal or reports success', async () => {
    const f = fixture(); await activate(f); await f.p.verify();
    const write = f.durableStorage.write;
    f.durableStorage.write = async (key, value) => {
        if (key.startsWith('cache_memory_verified_backup') && value.snapshots[0].store.summaries.m319) throw new Error('模拟快照事务中止');
        return write(key, value);
    };
    f.metadata.cache_memory.summaries.m319 = { messageId: 'm319', event: '新记录' }; await f.p.enqueue(f.metadata.cache_memory);
    assert.equal((await f.p.flush()).state, 'failed'); assert.ok(f.p.pending.has('a')); assert.ok(f.disk.get(f.p.storageKey)[0].snapshot.summaries.m319);
    assert.equal(Object.keys(f.disk.get('cache_memory_verified_backup_v1:a').snapshots[0].store.summaries).length, 318);
});

test('damaged pending checksum is retained and blocks startup replacement', async () => {
    const f = fixture(); await activate(f);
    const entry = { chatId: 'a', snapshot: createEmptyStore('a'), digest: memoryContentDigest(full()), baseSnapshot: full() };
    f.disk.set(f.p.storageKey, [entry]); const raw = clone(f.disk.get(f.p.storageKey));
    const reload = new MemoryPersistenceCoordinator(f.options); await reload.ready; reload.activate('a', f.metadata.cache_memory);
    assert.equal((await reload.loadLatest()).state, 'failed'); assert.deepEqual(f.disk.get(f.p.storageKey), raw); assert.equal(f.writes, 0);
});

test('a crash between remembering an empty loading page and adopting the server cannot demote the full recovery head', async () => {
    const f = fixture(); await activate(f); await f.p.verify();
    await f.p.rememberSnapshot('a', createEmptyStore('a'), 'loading page before server adoption');
    const backup = f.disk.get('cache_memory_verified_backup_v1:a');
    assert.equal(Object.keys(backup.snapshots[0].store.summaries).length, 318);
    f.metadata.cache_memory = createEmptyStore('a'); f.remote = createEmptyStore('a');
    const reload = new MemoryPersistenceCoordinator(f.options); await reload.ready; reload.activate('a', f.metadata.cache_memory);
    assert.equal((await reload.loadLatest()).state, 'conflict'); assert.equal(f.writes, 0);
});

test('shared-tab checkpoints use atomic update and an empty tab cannot replace the fuller comparison head', async () => {
    const f = fixture(); await activate(f); await f.p.verify();
    let queue = Promise.resolve(), updates = 0;
    f.durableStorage.update = (key, updater) => {
        const task = queue.then(() => { updates++; const next = updater(clone(f.disk.get(key))); f.disk.set(key, clone(next)); return clone(next); });
        queue = task; return task;
    };
    const other = new MemoryPersistenceCoordinator(f.options); await other.ready;
    const newer = full(); newer.summaries.m319 = { messageId: 'm319', floor: 319, event: 'newer tab' };
    await Promise.all([f.p.rememberSnapshot('a', newer), other.rememberSnapshot('a', createEmptyStore('a'), 'old empty tab')]);
    const backup = f.disk.get('cache_memory_verified_backup_v1:a');
    assert.equal(updates, 2); assert.ok(backup.snapshots[0].store.summaries.m319);
    assert.ok(backup.snapshots.some(entry => Object.keys(entry.store.summaries).length === 318));
});

test('verification surfaces a failed backup read without losing page memory or throwing an unhandled rejection', async () => {
    const f = fixture(); await activate(f); const original = clone(f.metadata.cache_memory);
    f.durableStorage.read = async () => { throw new Error('模拟备份无法读取'); };
    assert.equal((await f.p.verify()).state, 'failed'); assert.deepEqual(f.metadata.cache_memory, original); assert.equal(f.writes, 0);
});
