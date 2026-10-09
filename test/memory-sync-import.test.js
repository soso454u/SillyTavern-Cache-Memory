import test from 'node:test';
import assert from 'node:assert/strict';
import { createEmptyStore, memoryContentDigest, MemoryStore } from '../src/memory-store.js';
import { MemoryPersistenceCoordinator } from '../src/persistence.js';
import { inspectMemoryImport, prepareMemoryImport } from '../src/memory-import.js';
import { CacheMemoryUI, configTemplate, memoryOverviewStats } from '../src/ui.js';

const row = (n, text = `summary ${n}`) => ({ messageId: `m${n}`, floor: n, raw: text, event: text, status: 'frozen', frozen: true });
const makeStore = count => { const store = createEmptyStore('a'); for (let n = 1; n <= count; n++) store.summaries[`m${n}`] = row(n); return store; };
function fixture(authority = false, count = 0) {
    let remote = makeStore(count), writes = 0;
    const metadata = { cache_memory: structuredClone(remote) };
    const p = new MemoryPersistenceCoordinator({ getChatId: () => 'a', getMetadata: () => metadata,
        readRemoteStore: async () => structuredClone(remote),
        saveMetadata: async () => { writes++; remote = structuredClone(metadata.cache_memory); },
        ...(authority ? {
            readAuthoritativeStore: async () => ({ revision: remote.sync.revision, store: structuredClone(remote) }),
            commitAuthoritative: async (_, payload) => { assert.equal(payload.baseRevision, remote.sync.revision); writes++; remote = structuredClone(payload.snapshot); return { record: { revision: remote.sync.revision, store: structuredClone(remote) } }; },
        } : {}),
    });
    p.activate('a', metadata.cache_memory);
    const store = new MemoryStore({ getChatId: () => 'a', getMetadata: () => metadata, saveMetadata: (value, reason) => p.enqueue(value, reason) });
    return { p, store, metadata, get remote() { return remote; }, set remote(value) { remote = value; }, get writes() { return writes; } };
}

for (const authority of [false, true]) {
    test(`a 199-summary window catches up to all 207 server summaries and survives reload (authority=${authority})`, async () => {
        const f = fixture(authority, 199); f.remote = makeStore(207);
        assert.equal((await f.p.verify()).state, 'confirmed');
        assert.equal(Object.keys(f.metadata.cache_memory.summaries).length, 207);
        assert.equal(memoryContentDigest(f.metadata.cache_memory), memoryContentDigest(f.remote));
        assert.equal(f.writes, 0);
        f.metadata.cache_memory = makeStore(199); f.p.activate('a', f.metadata.cache_memory);
        assert.equal((await f.p.verify()).state, 'confirmed');
        assert.equal(Object.keys(f.metadata.cache_memory.summaries).length, 207);
    });

    test(`an old window with concurrent edits cannot overwrite a newer server record (authority=${authority})`, async () => {
        const f = fixture(authority, 1); await f.p.verify();
        f.metadata.cache_memory.summaries.m1.event = 'old window edit';
        f.remote.summaries.m1.event = 'new server edit';
        f.p.enqueue(f.metadata.cache_memory);
        assert.equal((await f.p.flush()).state, 'conflict'); assert.equal(f.writes, 0);
        assert.equal(f.remote.summaries.m1.event, 'new server edit');
        assert.equal(f.p.conflictBundle().local.summaries.m1.event, 'old window edit');
        assert.equal((await f.p.verify()).state, 'conflict');
    });

    test(`confirmed JSON restore replaces content, omissions and deletions and reads back every memory section (authority=${authority})`, async () => {
        const f = fixture(authority, 2); await f.p.verify();
        f.remote.recovery = { previous: { kind: 'old-data', content: 'remove me' } };
        f.remote.tombstones['Summary:m3'] = { reason: 'previous deletion' };
        await f.p.reread();
        f.metadata.cache_memory.injectionSnapshot = { value: 'frozen original bytes', blocks: [] };
        f.p.enqueue(f.metadata.cache_memory); await f.p.flush();
        const incoming = makeStore(1); incoming.summaries.m1 = row(1, 'file is the intended version'); incoming.summaries.m3 = row(3);
        incoming.checkpoints = [{ id: 'cp', startFloor: 1, endFloor: 3, content: 'CP', status: 'frozen' }];
        incoming.longMemories = [{ id: 'long', startFloor: 1, endFloor: 3, content: 'Long', status: 'frozen' }];
        incoming.keepRegistry['KEEP-0001'] = { text: 'KEEP', status: 'active' };
        incoming.stateOverrides.state = { id: 'state', kind: 'state', sourceId: 'm1', entity: '甲', key: '状态', value: 'active' };
        incoming.recovery = { previous: { kind: 'file-data', content: 'also remove me' } };
        const prepared = prepareMemoryImport(f.store.current(), inspectMemoryImport(incoming, 'a'));
        f.store.replace(prepared.merged);
        assert.equal((await f.p.flush()).state, 'confirmed');
        assert.equal(f.remote.summaries.m1.event, 'file is the intended version');
        assert.ok(f.remote.summaries.m3); assert.equal(f.remote.summaries.m2, undefined);
        assert.ok(f.remote.tombstones['Summary:m2']); assert.equal(f.remote.tombstones['Summary:m3'], undefined);
        assert.equal(f.remote.checkpoints[0].content, 'CP'); assert.equal(f.remote.longMemories[0].content, 'Long');
        assert.equal(f.remote.keepRegistry['KEEP-0001'].text, 'KEEP'); assert.ok(f.remote.stateOverrides.state);
        assert.equal(f.remote.injectionSnapshot.value, 'frozen original bytes');
        assert.equal(f.remote.recovery, undefined);
        assert.equal(memoryContentDigest(f.remote), memoryContentDigest(f.metadata.cache_memory));
    });

    test(`server writes arriving after import confirmation stop the restore without silent overwrite (authority=${authority})`, async () => {
        const f = fixture(authority, 2); await f.p.verify();
        const prepared = prepareMemoryImport(f.store.current(), inspectMemoryImport(makeStore(1), 'a'));
        f.remote.summaries.m4 = row(4); // Arrived during the confirmation dialog.
        f.store.replace(prepared.merged);
        assert.equal((await f.p.flush()).state, 'conflict'); assert.equal(f.writes, 0);
        assert.ok(f.remote.summaries.m4); assert.ok(f.remote.summaries.m2);
        assert.equal(f.p.conflictBundle().local.summaries.m1.event, 'summary 1');
    });
}

test('205 generated summaries remain usable despite 6 old source flags; only 2 Unauthorized failures need handling', () => {
    const store = makeStore(207);
    for (let n = 1; n <= 6; n++) Object.assign(store.summaries[`m${n}`], { status: 'stale', sourceValidity: 'changed' });
    for (let n = 206; n <= 207; n++) Object.assign(store.summaries[`m${n}`], { status: 'failed', frozen: false, error: 'Unauthorized' });
    const entries = Array.from({ length: 207 }, (_, i) => ({ floor: i + 1, messageId: `m${i + 1}` }));
    const overview = memoryOverviewStats(store, entries, {});
    assert.deepEqual(overview.summaries, { actual: 205, generated: 205, expected: 207 });
    assert.equal(overview.summaryDetails.filter(row => row.reason === 'stale').length, 0);
    assert.equal(overview.summaryDetails.filter(row => row.reason === 'failed').length, 2);
    assert.doesNotMatch(overview.issues.join('\n'), /需要更新|来源消息或版本|待核对/);
});

test('downloaded JSON can be selected for one-confirmation import without creating any download', async () => {
    const f = fixture(false, 1); let confirmations = 0, renders = 0;
    const file = { text: async () => JSON.stringify(makeStore(2)) };
    const event = { target: { files: [file], value: 'selected.json' } };
    const ui = Object.assign(Object.create(CacheMemoryUI.prototype), {
        store: f.store, persistence: f.p, summarizer: { invalidateContext() {} }, getChat: () => [],
        isMissingCheckpointBackfillActive: () => false,
        showPluginDialog: async options => { confirmations++; assert.equal(options.fields, undefined); return {}; },
        doc: { createElement: () => assert.fail('import must not download any file') },
        renderManager: () => { renders++; }, renderMessageMemories() {},
    });
    await ui.importMergeFile(event);
    assert.equal(confirmations, 1); assert.equal(renders, 1); assert.equal(event.target.value, '');
    assert.equal(f.p.getState().state, 'confirmed'); assert.ok(f.remote.summaries.m2);
});

test('the ordinary toolbar exposes download and import without any recovery-copy controls', () => {
    const html = configTemplate();
    const start = html.indexOf('data-manager-view="overview"');
    const recovery = html.indexOf('<details class="cache-memory-backup"', start);
    const ordinary = html.slice(start, recovery);
    assert.match(ordinary, /下载记忆 JSON/); assert.match(ordinary, /导入记忆 JSON/);
    assert.match(ordinary, /data-save-memory>上传记忆到服务器/);
    assert.match(ordinary, /data-read-server>从服务器恢复记忆/);
    assert.doesNotMatch(ordinary, /data-export-recovery|data-memory-conflict/);
    assert.doesNotMatch(html, /恢复副本|data-export-recovery/);
    assert.equal((html.match(/data-import-merge-file/g) ?? []).length, 1);
});

for (const authority of [false, true]) test(`server restore replaces local pending content without uploading it (authority=${authority})`, async () => {
    const f = fixture(authority, 1); await f.p.verify();
    f.metadata.cache_memory.summaries.m1.event = 'unsaved local version';
    f.p.enqueue(f.metadata.cache_memory);
    const resume = f.p.pauseSaves('a');
    const prepared = await f.p.prepareRestore('a', { requireSaved: true });
    assert.equal(f.writes, 0); assert.equal(prepared.remote.summaries.m1.event, 'summary 1');
    f.p.restoreServerSnapshot(prepared);
    resume();
    await Promise.resolve();
    assert.equal(f.metadata.cache_memory.summaries.m1.event, 'summary 1');
    assert.equal(f.p.pending.size, 0); assert.equal(f.p.getState().state, 'confirmed'); assert.equal(f.writes, 0);
});

test('cancelled server restore resumes the pending save without losing local edits', async () => {
    const f = fixture(false, 1); await f.p.verify();
    f.metadata.cache_memory.summaries.m1.event = 'local edit';
    f.p.enqueue(f.metadata.cache_memory);
    const ui = Object.assign(Object.create(CacheMemoryUI.prototype), { store: f.store, persistence: f.p,
        summarizer: {}, isMissingCheckpointBackfillActive: () => false,
        showPluginDialog: async () => { assert.equal(f.writes, 0); return null; },
    });
    await ui.handleManagerClick({ target: { closest: selector => selector === '[data-read-server]' ? {} : null } });
    await f.p.flush();
    assert.equal(f.remote.summaries.m1.event, 'local edit');
    assert.equal(f.p.getState().state, 'confirmed'); assert.equal(f.p.pausedSaves.size, 0);
    assert.equal(ui.restoringServerMemory, false);
});

test('unchanged memory never restarts a failed upload, but a real edit and explicit upload do', async () => {
    const f = fixture(false, 1); await f.p.verify();
    let reads = 0;
    f.p.readRemoteStore = async () => { reads++; throw new Error('offline'); };
    f.p.enqueue(f.metadata.cache_memory, 'injection snapshot');
    await Promise.resolve(); assert.equal(reads, 0);
    f.metadata.cache_memory.summaries.m1.event = 'actual edit';
    f.p.enqueue(f.metadata.cache_memory);
    await f.p.flush(); assert.equal(reads, 1);
    const sequence = f.p.pending.get('a').sequence;
    for (let n = 0; n < 10; n++) f.p.enqueue(f.metadata.cache_memory, 'injection snapshot');
    await Promise.resolve(); assert.equal(reads, 1); assert.equal(f.p.pending.get('a').sequence, sequence);
    f.metadata.cache_memory.summaries.m1.event = 'next edit';
    f.p.enqueue(f.metadata.cache_memory);
    await f.p.flush(); assert.equal(reads, 2);
    f.p.enqueue(f.metadata.cache_memory, 'manual save');
    await f.p.flush(); assert.equal(reads, 3);
});

test('temporarily unloaded sources change diagnostics without causing automatic uploads', () => {
    const f = fixture(false, 1); let saves = 0;
    f.store.saveMetadata = () => { saves++; };
    f.store.syncMessages([]); f.store.syncMessages([]);
    assert.equal(saves, 0); assert.equal(f.store.current().summaries.m1.event, 'summary 1');
});

for (const authority of [false, true]) test(`reload adopts last saved server memory over old local edits without merging or uploading (authority=${authority})`, async () => {
    const f = fixture(authority, 1);
    f.metadata.cache_memory.summaries.m1.event = 'local unsaved version';
    f.p.enqueue(f.metadata.cache_memory);
    f.remote = makeStore(2); f.remote.summaries.m1.event = 'latest saved server version';
    assert.equal((await f.p.loadLatest('a')).state, 'confirmed');
    assert.equal(f.metadata.cache_memory.summaries.m1.event, 'latest saved server version');
    assert.ok(f.metadata.cache_memory.summaries.m2);
    assert.equal(f.p.pending.size, 0); assert.equal(f.p.conflicts.size, 0); assert.equal(f.writes, 0);
});

test('a new authority migrates existing native server memory instead of replacing it with an empty record', async () => {
    const f = fixture(true, 2), read = f.p.readAuthoritativeStore;
    f.p.readAuthoritativeStore = async () => f.writes ? read() : { revision: 0, store: null };
    assert.equal((await f.p.loadLatest('a')).state, 'confirmed');
    assert.ok(f.metadata.cache_memory.summaries.m2); assert.ok(f.remote.summaries.m2); assert.equal(f.writes, 1);
});

test('a failed reload retains pending edits without immediately retrying another server read', async () => {
    const f = fixture(false, 1); let reads = 0;
    f.metadata.cache_memory.summaries.m1.event = 'not yet saved'; f.p.enqueue(f.metadata.cache_memory);
    f.p.readRemoteStore = async () => { reads++; throw new Error('server offline'); };
    assert.equal((await f.p.loadLatest('a')).state, 'failed');
    await Promise.resolve(); assert.equal(reads, 1); assert.equal(f.writes, 0);
    assert.equal(f.p.pending.get('a').snapshot.summaries.m1.event, 'not yet saved');
});

test('server restore rejects edits during confirmation and cannot invent absent server memory', async () => {
    const f = fixture(false, 1); const prepared = await f.p.prepareRestore('a', { requireSaved: true });
    f.metadata.cache_memory.summaries.m1.event = 'changed while confirming';
    assert.throws(() => f.p.restoreServerSnapshot(prepared), /确认期间/);
    assert.equal(f.metadata.cache_memory.summaries.m1.event, 'changed while confirming'); assert.equal(f.writes, 0);
    f.p.readRemoteStore = async () => null;
    await assert.rejects(f.p.prepareRestore('a', { requireSaved: true }), /尚未保存/);
});

test('visible server-restore button requires one confirmation and refreshes memory lists', async () => {
    const f = fixture(false, 1); let confirms = 0, renders = 0;
    f.metadata.cache_memory.summaries.m1.event = 'local version';
    const ui = Object.assign(Object.create(CacheMemoryUI.prototype), { store: f.store, persistence: f.p,
        summarizer: { invalidateContext() {} }, isMissingCheckpointBackfillActive: () => false,
        showPluginDialog: async () => { confirms++; return {}; }, updateInjection() {},
        renderManager() { renders++; }, renderMessageMemories() { renders++; },
    });
    await ui.handleManagerClick({ target: { closest: selector => selector === '[data-read-server]' ? {} : null } });
    assert.equal(confirms, 1); assert.equal(renders, 2); assert.equal(f.writes, 0);
    assert.equal(f.metadata.cache_memory.summaries.m1.event, 'summary 1');
});

test('invalid authority envelopes and foreign-chat snapshots cannot report successful synchronization', async () => {
    const f = fixture(true, 1);
    f.p.readAuthoritativeStore = async () => ({});
    assert.equal((await f.p.verify()).state, 'failed'); assert.equal(f.writes, 0);
    f.p.readAuthoritativeStore = async () => ({ revision: 1, store: { ...makeStore(1), chatId: 'another-chat' } });
    assert.equal((await f.p.verify()).state, 'failed'); assert.equal(f.metadata.cache_memory.chatId, 'a');
});

test('legacy swipe-only validation cannot invalidate unchanged frozen summaries and dependent memory', async () => {
    const { getAssistantMessages } = await import('../src/utils.js');
    const chat = [{ name: '角色', gen_started: 'g', mes: '原文没有改变', swipe_id: 0 }];
    const [entry] = getAssistantMessages(chat);
    const f = fixture(false);
    f.store.addSummary({ ...row(1), messageId: entry.messageId, sourceFingerprint: entry.fingerprint, status: 'stale', sourceValidity: 'changed' });
    const source = f.store.current().summaries[entry.messageId];
    f.store.current().checkpoints = [{ id: 'cp', startFloor: 1, endFloor: 5, content: '原冻结阶段记忆', status: 'stale', sourceValidity: 'changed', invalidSourceIds: [entry.messageId], invalidSourceVersions: { [entry.messageId]: 'old weak validation' } }];
    f.store.current().longMemories = [{ id: 'long', startFloor: 1, endFloor: 50, content: '原冻结长期记忆', status: 'stale', invalidSourceIds: [entry.messageId] }];
    f.store.current().injectionSnapshot = { value: 'do not rebuild frozen injection', blocks: [] };
    chat[0].swipe_id = 3;
    f.store.syncMessages(chat);
    assert.equal(source.event, 'summary 1');
    assert.equal(source.status, 'frozen'); assert.equal(source.sourceValidity, 'unverified');
    assert.equal(source.sourceContentFingerprint, undefined); // Do not invent historic evidence.
    assert.equal(f.store.current().checkpoints[0].status, 'frozen');
    assert.equal(f.store.current().longMemories[0].status, 'frozen');
    assert.equal(f.store.current().injectionSnapshot.value, 'do not rebuild frozen injection');
    await f.p.flush();
});

test('legacy v4 JSON checks the chat filename plus every current source before upgrading its scope', () => {
    const scoped = JSON.stringify(['character', 'avatar.png', 'old-chat']);
    const old = { ...makeStore(1), version: 4, chatId: 'old-chat' };
    const inspected = inspectMemoryImport(old, scoped, { assistants: [{ messageId: 'm1' }] });
    assert.equal(inspected.store.chatId, scoped); assert.equal(inspected.sourceVersion, 4);
    assert.throws(() => inspectMemoryImport(old, scoped, { assistants: [{ messageId: 'unrelated' }] }), /不匹配/);
    assert.throws(() => inspectMemoryImport({ ...old, chatId: 'different-file' }, scoped, { assistants: [{ messageId: 'm1' }] }), /不匹配/);
});

function sharedStorage() {
    const values = new Map();
    return { get length() { return values.size; }, key: i => [...values.keys()][i] ?? null,
        getItem: key => values.get(key) ?? null, setItem: (key, value) => values.set(key, value), removeItem: key => values.delete(key), values };
}

test('an empty old-window journal cannot erase another window pending changes; reload combines disjoint journals', async () => {
    const storage = sharedStorage();
    const make = () => {
        const metadata = { cache_memory: makeStore(0) };
        const p = new MemoryPersistenceCoordinator({ storage, getChatId: () => 'inactive', getMetadata: () => metadata });
        return { p, metadata };
    };
    const first = make(), oldWindow = make();
    assert.notEqual(first.p.storageKey, oldWindow.p.storageKey);
    first.p.enqueue(makeStore(1)); oldWindow.p.persistPending();
    assert.ok(JSON.parse(storage.getItem(first.p.storageKey))[0].snapshot.summaries.m1);
    const other = makeStore(0); other.summaries.m2 = row(2);
    oldWindow.p.enqueue(other);
    const recovered = make();
    assert.ok(recovered.p.pending.get('a').snapshot.summaries.m1);
    assert.ok(recovered.p.pending.get('a').snapshot.summaries.m2);
    recovered.p.persistPending();
    const again = make(); assert.ok(again.p.pending.get('a').snapshot.summaries.m1); assert.ok(again.p.pending.get('a').snapshot.summaries.m2);
    await Promise.all([first.p.flush('a'), oldWindow.p.flush('a')]);
});

test('repeated imports save only current memory without accumulating backups', () => {
    let current = makeStore(1);
    current.recovery = { existing: { kind: 'old-recovery', content: 'remove me' } };
    for (let n = 2; n < 12; n++) {
        const incoming = makeStore(n);
        current = prepareMemoryImport(current, inspectMemoryImport(incoming, 'a')).merged;
        assert.equal(current.recovery, undefined);
        assert.equal(Object.keys(current.summaries).length, n);
        assert.ok(JSON.stringify(current).length < JSON.stringify(incoming).length + 100);
    }
});

test('three conflicting window journals retain every earlier conflict branch on reload', () => {
    const storage = sharedStorage();
    const windows = ['first-window', 'second-window', 'third-window'].map(text => {
        const p = new MemoryPersistenceCoordinator({ storage, getChatId: () => 'inactive', getMetadata: () => ({}) });
        return { p, value: { ...makeStore(1), summaries: { m1: row(1, text) } } };
    });
    for (const item of windows) item.p.enqueue(item.value);
    const recovered = new MemoryPersistenceCoordinator({ storage, getChatId: () => 'inactive', getMetadata: () => ({}) });
    assert.equal(recovered.getState('a').state, 'conflict');
    const retained = JSON.stringify(recovered.pending.get('a'));
    for (const text of ['first-window', 'second-window', 'third-window']) assert.ok(retained.includes(text));
    recovered.persistPending();
    const again = new MemoryPersistenceCoordinator({ storage, getChatId: () => 'inactive', getMetadata: () => ({}) });
    for (const text of ['first-window', 'second-window', 'third-window']) assert.ok(JSON.stringify(again.pending.get('a')).includes(text));
});

test('a swallowed import save failure retains the original memory and attempted file without confirming success', async () => {
    const f = fixture(false, 2); await f.p.verify();
    f.p.saveMetadata = async () => {};
    f.store.replace(prepareMemoryImport(f.store.current(), inspectMemoryImport(makeStore(1), 'a')).merged);
    assert.equal((await f.p.flush()).state, 'failed');
    assert.ok(f.remote.summaries.m2);
    assert.ok(f.p.pending.get('a').baseSnapshot.summaries.m2);
    assert.equal(f.p.pending.get('a').snapshot.summaries.m2, undefined);
    assert.equal(f.p.pending.get('a').snapshot.recovery, undefined);
});

test('a confirmed file can resolve existing sync conflicts without asking the user to choose versions', async () => {
    const f = fixture(false, 1); await f.p.verify();
    f.metadata.cache_memory.summaries.m1.event = 'local conflicted version';
    f.remote.summaries.m1.event = 'server conflicted version';
    f.p.enqueue(f.metadata.cache_memory); assert.equal((await f.p.flush()).state, 'conflict');
    const incoming = makeStore(1); incoming.summaries.m1 = row(1, 'explicitly selected file');
    let confirms = 0;
    const ui = Object.assign(Object.create(CacheMemoryUI.prototype), { store: f.store, persistence: f.p,
        summarizer: { invalidateContext() {} }, getChat: () => [], isMissingCheckpointBackfillActive: () => false,
        showPluginDialog: async options => { confirms++; assert.equal(options.fields, undefined); return {}; },
        doc: { createElement: () => assert.fail('must not download') }, renderManager() {}, renderMessageMemories() {},
    });
    await ui.importMergeFile({ target: { files: [{ text: async () => JSON.stringify(incoming) }], value: '' } });
    assert.equal(confirms, 1); assert.equal(f.p.getState().state, 'confirmed');
    assert.equal(f.remote.summaries.m1.event, 'explicitly selected file');
    assert.equal(f.remote.recovery, undefined);
    assert.equal(f.p.pending.size, 0);
    assert.equal(f.p.conflicts.size, 0);
});
