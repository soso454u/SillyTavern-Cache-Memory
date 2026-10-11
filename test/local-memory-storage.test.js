import test from 'node:test';
import assert from 'node:assert/strict';
import { MemoryPersistenceCoordinator } from '../src/persistence.js';
import { MemoryStore, createEmptyStore, memoryContentDigest } from '../src/memory-store.js';

const clone = value => value === undefined ? undefined : structuredClone(value);
function fixture() {
    const disk = new Map(), legacy = new Map(), session = new Map();
    let fail = false, failBackup = false, offline = false, writes = 0, webWrites = 0;
    const durableStorage = { read: async key => clone(disk.get(key)), write: async (key, value) => {
        if (fail || failBackup && key.startsWith('cache_memory_replacement_backup')) throw new Error('模拟 IndexedDB 事务中止');
        disk.set(key, clone(value));
    }, remove: async key => { if (fail) throw new Error('模拟 IndexedDB 事务中止'); disk.delete(key); } };
    const storage = { getItem: key => legacy.get(key), setItem: () => { webWrites++; throw new Error('QuotaExceededError'); }, removeItem: key => legacy.delete(key) };
    const sessionStorage = { getItem: key => session.get(key), setItem: (key, value) => session.set(key, value) };
    const metadata = { cache_memory: createEmptyStore('a') };
    // Large enough to exceed common localStorage limits once repeated in a journal.
    metadata.cache_memory.summaries.large = { messageId: 'large', floor: 1, event: '合成重大历史与认知差。'.repeat(90000), status: 'frozen' };
    let remote = clone(metadata.cache_memory);
    const options = { storage, sessionStorage, durableStorage, getChatId: () => 'a', getMetadata: () => metadata,
        readRemoteStore: async () => { if (offline) throw new Error('模拟离线'); return clone(remote); },
        saveMetadata: async () => { writes++; if (offline) throw new Error('模拟离线'); remote = clone(metadata.cache_memory); } };
    const persistence = new MemoryPersistenceCoordinator(options);
    const store = new MemoryStore({ getMetadata: () => metadata, getChatId: () => 'a', saveMetadata: (value, reason) => persistence.enqueue(value, reason) });
    return { persistence, store, options, metadata, disk, legacy, session, get remote() { return remote; }, set remote(value) { remote = value; },
        set fail(value) { fail = value; }, set failBackup(value) { failBackup = value; }, set offline(value) { offline = value; }, get writes() { return writes; }, get webWrites() { return webWrites; } };
}
async function activate(f) { await f.persistence.ready; f.persistence.activate('a', f.store.current()); await f.persistence.reread(); }

test('large Summary, Checkpoint and Long replacements commit and read back despite full localStorage', async () => {
    const f = fixture(); await activate(f);
    for (const section of ['summaries', 'checkpoints', 'longMemories']) {
        await f.persistence.commitReplacement(f.store, () => {
            if (section === 'summaries') f.store.addSummary({ messageId: 'new', floor: 2, event: '新楼层', status: 'frozen' });
            else f.store.current()[section].push({ id: section, startFloor: 1, endFloor: section === 'checkpoints' ? 5 : 50, content: '合成永久结果', status: 'frozen' });
        });
        assert.equal(f.persistence.getState().state, 'confirmed');
        assert.equal(memoryContentDigest(f.remote), memoryContentDigest(f.store.current()));
    }
    assert.equal(f.writes, 3); assert.equal(f.webWrites, 0);
    await f.persistence.journalWrite; assert.equal(f.disk.has(f.persistence.storageKey), false);
    assert.equal(f.remote.summaries.large.event, f.metadata.cache_memory.summaries.large.event);
});

test('failed durable transaction retains original and generated candidate, then retries without another model call', async () => {
    const f = fixture(); await activate(f); f.fail = true;
    await assert.rejects(f.persistence.commitReplacement(f.store, () => f.store.addSummary({ messageId: 'new', floor: 2, event: '不能丢失的生成结果', status: 'frozen' })), { code: 'SAVE_UNCONFIRMED' });
    assert.equal(f.writes, 0); assert.equal(f.remote.summaries.new, undefined);
    assert.equal(f.store.current().summaries.new, undefined);
    assert.equal(f.persistence.pending.get('a').snapshot.summaries.new.event, '不能丢失的生成结果');
    assert.ok(f.persistence.pending.get('a').replacementFallback.summaries.large);
    f.fail = false; assert.equal((await f.persistence.flush()).state, 'confirmed');
    assert.equal(f.remote.summaries.new.event, '不能丢失的生成结果');
});

test('own durable pending branch survives refresh while an idle window adopts server without uploading', async () => {
    const f = fixture(); await activate(f); f.offline = true;
    await assert.rejects(f.persistence.commitReplacement(f.store, () => f.store.addSummary({ messageId: 'pending', floor: 2, event: '离线新结果', status: 'frozen' })), { code: 'SAVE_UNCONFIRMED' });
    await f.persistence.journalWrite; f.offline = false;
    const reload = new MemoryPersistenceCoordinator(f.options); await reload.ready;
    assert.equal(reload.pending.get('a').snapshot.summaries.pending.event, '离线新结果');
    reload.activate('a', f.remote); assert.equal((await reload.flush()).state, 'confirmed');
    const before = f.writes;
    const idle = new MemoryPersistenceCoordinator({ ...f.options, sessionStorage: { getItem: () => null, setItem() {} } });
    await idle.ready; idle.activate('a', createEmptyStore('a')); await idle.loadLatest();
    assert.equal(f.writes, before); assert.equal(idle.pending.size, 0);
    assert.equal(f.metadata.cache_memory.summaries.pending.event, '离线新结果');
});

test('manual native upload backs up original in durable storage with full localStorage', async () => {
    const f = fixture(); await activate(f); const before = clone(f.remote);
    f.metadata.cache_memory.summaries.large.event = '用户选择本机';
    assert.equal((await f.persistence.uploadCurrentChat()).state, 'confirmed');
    assert.deepEqual((await f.persistence.readUploadBackup()).store, before); assert.equal(f.webWrites, 0);
    const reload = new MemoryPersistenceCoordinator(f.options); await reload.ready;
    assert.deepEqual((await reload.readUploadBackup()).store, before);
});

test('legacy pending journal migrates only after durable commit and restores its actual pending data', async () => {
    const f = fixture(); await f.persistence.ready;
    const key = f.persistence.storageKey, snapshot = clone(f.remote); snapshot.summaries.new = { messageId: 'new', event: '旧队列真实待保存结果', status: 'frozen' };
    const raw = JSON.stringify([{ chatId: 'a', snapshot, baseSnapshot: f.remote, baseDigest: memoryContentDigest(f.remote), sequence: 1 }]);
    f.legacy.set(key, raw);
    const reload = new MemoryPersistenceCoordinator(f.options); await reload.ready;
    assert.equal(f.legacy.has(key), false); assert.equal(f.disk.get(key)[0].snapshot.summaries.new.event, '旧队列真实待保存结果');
    assert.equal(reload.pending.size, 1);
});

test('cleanup cannot bypass a failed permanent backup on a later flush', async () => {
    const f = fixture(); await activate(f); f.failBackup = true;
    await assert.rejects(f.persistence.commitReplacement(f.store, () => {
        f.store.deleteSummary('large'); f.store.persist('memory replacement');
    }), { code: 'SAVE_UNCONFIRMED' });
    assert.equal((await f.persistence.flush()).state, 'failed'); assert.equal(f.writes, 0); assert.ok(f.remote.summaries.large);
    f.failBackup = false; assert.equal((await f.persistence.flush()).state, 'confirmed');
    assert.equal(f.remote.summaries.large, undefined);
    assert.ok((await f.persistence.readReplacementBackup()).store.summaries.large);
});

test('an unread durable journal blocks automatic adoption and can recover on explicit verification', async () => {
    const f = fixture(); await activate(f);
    const snapshot = clone(f.remote); snapshot.summaries.recover = { messageId: 'recover', floor: 2, event: '不能被服务器读取掩盖的待保存结果', status: 'frozen' };
    f.disk.set(f.persistence.storageKey, [{ chatId: 'a', snapshot, baseSnapshot: f.remote, baseDigest: memoryContentDigest(f.remote), sequence: 1 }]);
    const read = f.options.durableStorage.read;
    f.options.durableStorage.read = async () => { throw new Error('模拟存储暂时不可读'); };
    const reload = new MemoryPersistenceCoordinator(f.options); await reload.ready; reload.activate('a', f.remote);
    assert.equal((await reload.loadLatest()).state, 'failed'); assert.equal(f.writes, 0);
    assert.ok(f.disk.get(reload.storageKey)[0].snapshot.summaries.recover);
    f.options.durableStorage.read = read;
    assert.equal((await reload.reread()).state, 'confirmed'); assert.equal(f.remote.summaries.recover.event, '不能被服务器读取掩盖的待保存结果');
});

test('manual upload rescues a failed generated draft instead of confirming the old visible fallback and clearing it', async () => {
    const f = fixture(); await activate(f); f.fail = true;
    await assert.rejects(f.persistence.commitReplacement(f.store, () => f.store.addSummary({ messageId: 'generated', floor: 2, event: '用户要上传的未保存生成结果', status: 'frozen' })), { code: 'SAVE_UNCONFIRMED' });
    assert.equal(f.store.current().summaries.generated, undefined); f.fail = false;
    assert.equal((await f.persistence.uploadCurrentChat()).state, 'confirmed');
    assert.equal(f.remote.summaries.generated.event, '用户要上传的未保存生成结果');
    assert.equal(f.store.current().summaries.generated.event, '用户要上传的未保存生成结果');
    assert.equal(f.persistence.pending.size, 0); assert.equal(f.persistence.replacementStores.size, 0);
    assert.equal((await f.persistence.readUploadBackup()).store.summaries.generated, undefined);
});
