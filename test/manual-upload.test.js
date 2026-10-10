import test from 'node:test';
import assert from 'node:assert/strict';
import { MemoryPersistenceCoordinator } from '../src/persistence.js';
import { MemoryStore, createEmptyStore, memoryContentDigest } from '../src/memory-store.js';
import { CacheMemoryUI, configTemplate } from '../src/ui.js';
import { getAssistantMessages } from '../src/utils.js';
import { inspectMemoryImport } from '../src/memory-import.js';
import { threeWayMerge } from '../server-plugin/cache-memory-memory/index.mjs';

const clone = value => structuredClone(value);
const gate = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };
function fixture({ authority = true } = {}) {
    let id = 'synthetic-chat';
    const chat = [{ name: '合成人物', gen_started: 'g1', mes: '合成剧情第一层' }, { name: '合成人物', gen_started: 'g2', mes: '合成剧情第二层' }];
    const entries = getAssistantMessages(chat);
    const row = (index, event) => ({ messageId: entries[index].messageId, floor: index + 1, sourceContentFingerprint: entries[index].contentFingerprint, event, frozen: true, status: 'frozen' });
    const local = createEmptyStore(id); local.summaries[entries[0].messageId] = row(0, '本机当前剧情');
    local.injectionSnapshot = { value: '原有冻结字节', blocks: [] };
    const remote = clone(local); remote.summaries[entries[0].messageId].event = '服务器原剧情'; remote.summaries[entries[1].messageId] = row(1, '仅在服务器的剧情'); remote.sync.revision = 7;
    let record = { chatId: id, revision: 7, store: remote };
    const metadata = { cache_memory: local }, values = new Map(), writes = [], statuses = [];
    const storage = { getItem: key => values.get(key) ?? null, setItem: (key, value) => values.set(key, value), removeItem: key => values.delete(key), key: index => [...values.keys()][index], get length() { return values.size; } };
    const options = { getChatId: () => id, getMetadata: () => metadata, storage, timeoutMs: 500,
        readRemoteStore: async () => clone(record.store), saveMetadata: async () => { writes.push('native'); record.store = clone(metadata.cache_memory); },
        onStatus: (_, status) => statuses.push(status), ...(authority ? {
            readAuthoritativeStore: async () => clone(record), commitAuthoritative: async (chatId, payload) => {
                writes.push(clone(payload));
                assert.equal(chatId, id);
                if (payload.baseRevision !== record.revision) throw Object.assign(new Error('revision conflict'), { status: 409, data: { record: clone(record) } });
                const result = threeWayMerge(payload.baseSnapshot, payload.snapshot, record.store);
                assert.deepEqual(result.conflicts, []);
                record = { chatId, revision: record.revision + 1, store: result.merged };
                record.store.sync.revision = record.revision;
                return { state: 'committed', record: clone(record) };
            },
        } : {}) };
    const p = new MemoryPersistenceCoordinator(options);
    p.activate(id, local);
    const store = new MemoryStore({ getChatId: () => id, getMetadata: () => metadata, saveMetadata() {} });
    return { p, store, metadata, chat, entries, values, options, storage, writes, statuses, get id() { return id; }, set id(value) { id = value; }, get record() { return record; }, set record(value) { record = value; } };
}

test('one manual upload chooses exact current local memory despite an existing conflict and confirms readback', async () => {
    const f = fixture(), before = clone(f.record.store), desired = memoryContentDigest(f.metadata.cache_memory);
    f.p.holdConflict(f.id, f.metadata.cache_memory, f.record.store);
    f.metadata.cache_memory.summaries[f.entries[0].messageId].event = '冲突出现后用户继续编辑的当前版本';
    const current = memoryContentDigest(f.metadata.cache_memory);
    const status = await f.p.uploadCurrentChat(f.id);
    assert.equal(status.state, 'confirmed'); assert.match(status.detail, /已同步/);
    assert.equal(f.writes.length, 1);
    assert.equal(memoryContentDigest(f.record.store), current); assert.notEqual(current, desired);
    assert.equal(f.record.store.summaries[f.entries[1].messageId], undefined);
    assert.equal(f.p.pending.size, 0); assert.equal(f.p.conflicts.size, 0);
    assert.deepEqual(f.p.uploadBackup(f.id).store, before);
    assert.deepEqual(f.metadata.cache_memory.injectionSnapshot, before.injectionSnapshot);
    assert.equal(f.p.pausedSaves.size, 0); assert.equal(f.p.running.size, 0);
});

test('upload backup survives browser coordinator reload and can be restored with existing JSON import', async () => {
    const f = fixture(), before = clone(f.record.store);
    assert.equal((await f.p.uploadCurrentChat(f.id)).state, 'confirmed');
    const reload = new MemoryPersistenceCoordinator(f.options), backup = reload.uploadBackup(f.id);
    assert.deepEqual(backup.store, before); assert.equal(backup.revision, 7);
    assert.equal(inspectMemoryImport(backup.store, f.id).counts.Summary, 2);
    assert.equal(reload.uploadBackup('another-chat'), null);
    assert.ok(!JSON.stringify(f.record.store).includes('upload_backup'));
});

for (const failure of ['throw', 'readback', 'unavailable']) test(`backup ${failure} stops before overwriting and retains both branches`, async () => {
    const f = fixture(), before = clone(f.record);
    if (failure === 'throw') f.storage.setItem = (key, value) => { if (key.startsWith('cache_memory_upload_backup_v1:')) throw new Error('quota exceeded'); f.values.set(key, value); };
    if (failure === 'readback') { const get = f.storage.getItem; f.storage.getItem = key => key.startsWith('cache_memory_upload_backup_v1:') ? null : get(key); }
    if (failure === 'unavailable') f.p.storage = null;
    assert.equal((await f.p.uploadCurrentChat(f.id)).state, 'conflict');
    assert.equal(f.writes.length, 0); assert.deepEqual(f.record, before);
    assert.ok(f.p.conflictBundle(f.id).local); assert.ok(f.p.conflictBundle(f.id).remote);
});

test('a server update between preflight reads stops manual overwrite without retry', async () => {
    const f = fixture(); let reads = 0;
    f.p.readAuthoritativeStore = async () => {
        if (++reads === 2) { f.record.revision++; f.record.store.summaries[f.entries[0].messageId].event = '另一设备刚更新'; }
        return clone(f.record);
    };
    const status = await f.p.uploadCurrentChat(f.id);
    assert.equal(status.state, 'conflict'); assert.match(status.detail, /其他设备/);
    assert.equal(f.writes.length, 0); assert.equal(reads, 2);
    assert.equal(f.p.conflictBundle(f.id).remote.summaries[f.entries[0].messageId].event, '另一设备刚更新');
    assert.equal(f.p.uploadBackup(f.id).store.summaries[f.entries[0].messageId].event, '服务器原剧情');
    await f.p.flush(); assert.equal(f.writes.length, 0);
});

test('CAS rejects a write arriving after the last read, preserves both sides and never auto retries', async () => {
    const f = fixture(), commit = f.p.commitAuthoritative;
    f.p.commitAuthoritative = async (id, payload) => { f.record.revision++; f.record.store.summaries[f.entries[0].messageId].event = 'CAS 前新版本'; return commit(id, payload); };
    assert.equal((await f.p.uploadCurrentChat(f.id)).state, 'conflict');
    assert.equal(f.writes.length, 1); assert.equal(f.record.store.summaries[f.entries[0].messageId].event, 'CAS 前新版本');
    assert.equal(f.p.conflictBundle(f.id).remote.summaries[f.entries[0].messageId].event, 'CAS 前新版本');
    f.p.enqueue(f.metadata.cache_memory, 'automatic save'); await f.p.flush(); assert.equal(f.writes.length, 1);
});

test('readback after another device writes is never reported synchronized', async () => {
    const f = fixture(); let reads = 0;
    f.p.readAuthoritativeStore = async () => {
        if (++reads === 3) { f.record.revision++; f.record.store.summaries[f.entries[0].messageId].event = '上传后另一设备更新'; }
        return clone(f.record);
    };
    assert.equal((await f.p.uploadCurrentChat(f.id)).state, 'conflict');
    assert.equal(f.writes.length, 1); assert.equal(f.statuses.some(status => status.state === 'confirmed'), false);
    assert.ok(f.p.conflictBundle(f.id).local); assert.ok(f.p.conflictBundle(f.id).remote);
});

for (const phase of ['read', 'commit']) test(`chat switch during ${phase} never publishes into the new chat`, async () => {
    const f = fixture(), started = gate(), release = gate();
    const method = phase === 'read' ? 'readAuthoritativeStore' : 'commitAuthoritative';
    const original = f.p[method];
    f.p[method] = async (...args) => { const result = await original(...args); started.resolve(); await release.promise; return result; };
    const uploading = f.p.uploadCurrentChat(f.id); await started.promise;
    f.id = 'other-chat'; f.metadata.cache_memory = createEmptyStore(f.id); f.p.activate(f.id, f.metadata.cache_memory);
    release.resolve(); await uploading;
    assert.equal(f.metadata.cache_memory.chatId, 'other-chat'); assert.deepEqual(f.metadata.cache_memory.summaries, {});
    assert.equal(f.writes.length, phase === 'read' ? 0 : 1);
    assert.ok(f.p.pending.get('synthetic-chat'));
});

test('local edits during preflight stop manual upload and keep the newest local pending branch', async () => {
    const f = fixture(), started = gate(), release = gate(), read = f.p.readAuthoritativeStore;
    f.p.readAuthoritativeStore = async () => { const result = await read(); started.resolve(); await release.promise; return result; };
    const uploading = f.p.uploadCurrentChat(f.id); await started.promise;
    f.metadata.cache_memory.summaries[f.entries[0].messageId].event = '读取期间最新编辑';
    f.p.enqueue(f.metadata.cache_memory); release.resolve();
    assert.equal((await uploading).state, 'conflict'); assert.equal(f.writes.length, 0);
    assert.equal(f.p.pending.get(f.id).snapshot.summaries[f.entries[0].messageId].event, '读取期间最新编辑');
});

test('manual upload without atomic version support preserves conflict instead of blind native overwrite', async () => {
    const f = fixture({ authority: false });
    f.p.holdConflict(f.id, f.metadata.cache_memory, f.record.store);
    const status = await f.p.uploadCurrentChat(f.id);
    assert.equal(status.state, 'conflict'); assert.match(status.detail, /不支持原子版本校验/); assert.equal(f.writes.length, 0);
    f.record.store = clone(f.metadata.cache_memory);
    assert.equal((await f.p.uploadCurrentChat(f.id)).state, 'confirmed'); assert.equal(f.writes.length, 0);
});

test('ordinary automatic saving still protects same-ID conflicts without creating an upload backup', async () => {
    const f = fixture();
    f.metadata.cache_memory.summaries[f.entries[0].messageId].event = '基线之后本机编辑';
    f.p.enqueue(f.metadata.cache_memory, 'automatic save');
    assert.equal((await f.p.flush()).state, 'conflict');
    assert.equal(f.writes.length, 0); assert.equal(f.p.uploadBackup(f.id), null);
});

test('unverified authority identities and foreign local snapshots cannot be overwritten', async () => {
    for (const bad of [{}, { chatId: 'other', revision: 7, store: createEmptyStore('other') }]) {
        const f = fixture(); f.p.readAuthoritativeStore = async () => bad;
        assert.notEqual((await f.p.uploadCurrentChat(f.id)).state, 'confirmed'); assert.equal(f.writes.length, 0);
    }
    const f = fixture(); f.metadata.cache_memory.chatId = 'other';
    assert.equal((await f.p.uploadCurrentChat(f.id)).state, 'failed'); assert.equal(f.writes.length, 0);
});

test('successful CAS requires a separate server readback before synchronization is confirmed', async () => {
    const f = fixture(), started = gate(), release = gate(); let reads = 0;
    f.p.readAuthoritativeStore = async () => { if (++reads === 3) { started.resolve(); await release.promise; } return clone(f.record); };
    const uploading = f.p.uploadCurrentChat(f.id); await started.promise;
    assert.equal(f.p.getState().state, 'saving'); assert.ok(f.p.pending.get(f.id));
    release.resolve(); assert.equal((await uploading).state, 'confirmed'); assert.equal(reads, 3);
});

test('manual UI upload requires no second confirmation and verifies valid message identities', async () => {
    const f = fixture(); let confirms = 0;
    const ui = Object.assign(Object.create(CacheMemoryUI.prototype), { store: f.store, persistence: f.p, getChat: () => f.chat,
        showPluginDialog: async () => { confirms++; return {}; }, renderMemorySaveState() {}, renderManager() {}, renderMessageMemories() {} });
    f.p.holdConflict(f.id, f.metadata.cache_memory, f.record.store);
    await ui.handleManagerClick({ target: { closest: selector => selector === '[data-save-memory]' ? {} : null } });
    assert.equal(confirms, 0); assert.equal(f.p.getState().state, 'confirmed'); assert.equal(f.writes.length, 1); assert.equal(ui.uploadingMemory, false);
    assert.match(configTemplate(), /data-upload-backup/);
});

test('manual UI rejects unloaded chat messages, mismatched source bodies and edits during upload', async () => {
    for (const kind of ['empty', 'mismatch', 'edited']) {
        const f = fixture();
        const ui = Object.assign(Object.create(CacheMemoryUI.prototype), { store: f.store, persistence: f.p, getChat: () => kind === 'empty' ? [] : f.chat,
            renderMemorySaveState() {}, renderManager() {}, renderMessageMemories() {} });
        if (kind === 'mismatch') f.metadata.cache_memory.summaries[f.entries[0].messageId].sourceContentFingerprint = 'old-body';
        if (kind === 'edited') { const read = f.p.readAuthoritativeStore; f.p.readAuthoritativeStore = async () => { const result = await read(); f.chat[0].mes = '读取期间修改了原文'; return result; }; }
        if (kind === 'edited') await ui.handleManagerClick({ target: { closest: selector => selector === '[data-save-memory]' ? {} : null } });
        else await assert.rejects(ui.handleManagerClick({ target: { closest: selector => selector === '[data-save-memory]' ? {} : null } }), /未上传/);
        assert.equal(f.writes.length, 0);
    }
});

for (const changed of ['revision', 'content']) test(`preflight detects a server ${changed} change even when the other stays equal`, async () => {
    const f = fixture(); let reads = 0;
    f.p.readAuthoritativeStore = async () => {
        if (++reads === 2) {
            if (changed === 'revision') f.record.revision++;
            else f.record.store.summaries[f.entries[0].messageId].event = '同版本异常修改';
        }
        return clone(f.record);
    };
    assert.equal((await f.p.uploadCurrentChat(f.id)).state, 'conflict'); assert.equal(f.writes.length, 0);
});

test('failed local pending journal prevents server overwrite even when backup storage works', async () => {
    const f = fixture();
    f.storage.setItem = (key, value) => { if (key.startsWith('cache_memory_pending_saves_v1')) throw new Error('journal quota'); f.values.set(key, value); };
    assert.equal((await f.p.uploadCurrentChat(f.id)).state, 'conflict'); assert.equal(f.writes.length, 0);
});

test('a failed post-upload read keeps backup and pending branches without claiming synchronization', async () => {
    const f = fixture(); let reads = 0;
    f.p.readAuthoritativeStore = async () => { if (++reads === 3) throw new Error('synthetic disconnect'); return clone(f.record); };
    assert.equal((await f.p.uploadCurrentChat(f.id)).state, 'conflict'); assert.equal(f.writes.length, 1);
    assert.ok(f.p.uploadBackup(f.id)); assert.ok(f.p.pending.get(f.id));
    assert.equal(f.statuses.some(status => status.state === 'confirmed'), false);
});

test('double upload clicks cannot create concurrent writes', async () => {
    const f = fixture(), started = gate(), release = gate(), read = f.p.readAuthoritativeStore;
    f.p.readAuthoritativeStore = async () => { started.resolve(); await release.promise; return read(); };
    const first = f.p.uploadCurrentChat(f.id); await started.promise;
    assert.equal((await f.p.uploadCurrentChat(f.id)).state, 'pending');
    release.resolve(); assert.equal((await first).state, 'confirmed'); assert.equal(f.writes.length, 1);
});

test('a timed-out pending commit is retained and a second manual upload never races it', async () => {
    const f = fixture(), started = gate(), release = gate(), commit = f.p.commitAuthoritative;
    f.p.timeoutMs = 10;
    f.p.commitAuthoritative = async (...args) => { started.resolve(); await release.promise; return commit(...args); };
    const first = f.p.uploadCurrentChat(f.id); await started.promise;
    assert.equal((await first).state, 'conflict'); assert.ok(f.p.uncertainWrites.get(f.id));
    assert.notEqual((await f.p.uploadCurrentChat(f.id)).state, 'confirmed'); assert.equal(f.writes.length, 0);
    release.resolve(); await f.p.uncertainWrites.get(f.id);
    assert.ok(f.p.pending.get(f.id)); assert.equal(f.p.getState().state, 'conflict'); assert.equal(f.writes.length, 1);
});

test('local edits while commit is in flight remain local and are never falsely confirmed', async () => {
    const f = fixture(), started = gate(), release = gate(), commit = f.p.commitAuthoritative;
    f.p.commitAuthoritative = async (...args) => { const result = await commit(...args); started.resolve(); await release.promise; return result; };
    const first = f.p.uploadCurrentChat(f.id); await started.promise;
    f.metadata.cache_memory.summaries[f.entries[0].messageId].event = '提交期间的新本机编辑';
    f.p.enqueue(f.metadata.cache_memory); release.resolve();
    assert.equal((await first).state, 'conflict'); await f.p.flush(); assert.equal(f.writes.length, 1);
    assert.equal(f.p.conflictBundle(f.id).local.summaries[f.entries[0].messageId].event, '提交期间的新本机编辑');
    assert.equal(f.metadata.cache_memory.summaries[f.entries[0].messageId].event, '提交期间的新本机编辑');
});

test('manual upload waits for an existing automatic write before validating its captured snapshot', async () => {
    const f = fixture(), previous = gate(); f.p.running.set(f.id, previous.promise);
    const uploading = f.p.uploadCurrentChat(f.id); await Promise.resolve(); assert.equal(f.writes.length, 0);
    previous.resolve(); assert.equal((await uploading).state, 'confirmed'); assert.equal(f.writes.length, 1);
});

test('foreign native chat identity blocks manual upload and missing authority falls back safely', async () => {
    const f = fixture(); f.p.authoritativeAvailable = () => false;
    f.p.readRemoteStore = async () => createEmptyStore('other-chat');
    assert.notEqual((await f.p.uploadCurrentChat(f.id)).state, 'confirmed'); assert.equal(f.writes.length, 0);
});
