import test from 'node:test';
import assert from 'node:assert/strict';
import { createEmptyStore, MemoryStore, mergeMemoryStoresThreeWay, memoryHealth } from '../src/memory-store.js';
import { MemoryPersistenceCoordinator } from '../src/persistence.js';
import { normalizeSettings, INJECTION_MODES } from '../src/defaults.js';
import { refreshSnapshot } from '../src/cache-control.js';
import { buildInjection } from '../src/injection.js';
import { getAssistantMessages } from '../src/utils.js';
import { isUsableMemory, parseFactUpdates, projectLongFacts } from '../src/continuity.js';
import { reconcileTrackedCheckpoint, stateId, trackedFactUpdates } from '../src/active-state.js';
import { MemorySummarizer } from '../src/summarizer.js';

const row = (id, value = id) => ({ messageId: id, floor: 1, event: value, status: 'frozen', frozen: true });
const cp = (id, startFloor, endFloor, content = id) => ({ id, startFloor, endFloor, content, status: 'frozen', frozen: true });
function persistenceFixture(authority = false) {
    let remote = createEmptyStore('a'), writes = 0;
    const metadata = { cache_memory: structuredClone(remote) };
    const p = new MemoryPersistenceCoordinator({ getChatId: () => 'a', getMetadata: () => metadata,
        readRemoteStore: async () => structuredClone(remote),
        saveMetadata: async () => { writes++; remote = structuredClone(metadata.cache_memory); },
        ...(authority ? {
            readAuthoritativeStore: async () => ({ store: structuredClone(remote), revision: remote.sync.revision }),
            commitAuthoritative: async (_, payload) => { assert.equal(payload.baseRevision, remote.sync.revision); writes++; remote = structuredClone(payload.snapshot); return { record: { store: structuredClone(remote), revision: remote.sync.revision } }; },
        } : {}),
    });
    p.activate('a', metadata.cache_memory);
    return { p, metadata, get remote() { return remote; }, set remote(value) { remote = value; }, get writes() { return writes; } };
}

test('legacy clipped snapshots survive reload, then regain every retained block at the next normal boundary', () => {
    const store = createEmptyStore('a'), settings = normalizeSettings();
    store.checkpoints = [cp('checkpoint-001', 1, 5, '完整早期事实'.repeat(1000)), cp('checkpoint-002', 6, 10, '完整近期事实'.repeat(1000))];
    refreshSnapshot(store, settings, 'new checkpoint');
    store.injectionSnapshot.blocks = [{ ...store.injectionSnapshot.blocks[1], text: '截断…' }];
    store.injectionSnapshot.value = '旧冻结字节'; store.injectionSnapshot.budget = { clipped: 1, omitted: 1 };
    assert.equal(refreshSnapshot(store, settings, 'chat changed').value, '旧冻结字节');
    assert.equal(refreshSnapshot(store, settings, 'new summary').value, '旧冻结字节');
    const result = refreshSnapshot(store, settings, 'new checkpoint');
    for (const record of store.checkpoints) assert.ok(result.value.includes(record.content));
    assert.equal(store.injectionSnapshot.budget, undefined);
});

test('full injection keeps Long/CP coverage and KEEP rules, without injecting per-floor summaries in the default mode', () => {
    const store = createEmptyStore('a'), settings = normalizeSettings();
    store.longMemories = [cp('long-001', 1, 50, '历史事实'.repeat(2000))];
    store.checkpoints = [cp('checkpoint-001', 1, 5, '已覆盖的 CP'), cp('checkpoint-011', 51, 55, '未覆盖的 CP')];
    store.summaries.m56 = row('m56', '不应发送逐层全文');
    store.keepRegistry = { keep: { text: '仍有效的约定', status: 'active' }, retired: { text: '已解决的约定', status: 'resolved' } };
    const value = refreshSnapshot(store, settings, 'new long memory').value;
    assert.ok(value.includes(store.longMemories[0].content));
    assert.match(value, /未覆盖的 CP/); assert.match(value, /仍有效的约定/);
    assert.doesNotMatch(value, /已覆盖的 CP|已解决的约定|不应发送逐层全文/);
    const relaxed = buildInjection(store, normalizeSettings({ strictCacheMode: false, memoryStrategy: 'legacy', injectionMode: INJECTION_MODES.LONG_CHECKPOINT }));
    assert.ok(relaxed.includes(store.longMemories[0].content)); assert.match(relaxed, /未覆盖的 CP/);
});

test('missing fingerprints and unloaded sources preserve generated CP/Long and do not block Long generation', async () => {
    const metadata = {}, store = new MemoryStore({ getMetadata: () => metadata, getChatId: () => 'a', saveMetadata: () => {} });
    const chat = [1, 2].map(i => ({ name: '甲', mes: `正文${i}`, gen_started: `g${i}` }));
    for (const entry of getAssistantMessages(chat)) store.addSummary({ ...row(entry.messageId), floor: entry.floor });
    store.addCheckpoint({ ...cp('checkpoint-001', 1, 2, '[CHECKPOINT]\n[Current State]\n完整内容'), sourceVersions: { 'legacy-missing-id': 'old' }, sourceValidity: 'unverified' });
    store.syncMessages(chat); store.syncMessages([]); store.revalidate([]);
    assert.ok(isUsableMemory(store.current().checkpoints[0]));
    assert.equal(memoryHealth(store.current().checkpoints[0]).code, 'valid');
    let requests = 0;
    const summarizer = new MemorySummarizer({ store, getChat: () => chat, getSettings: () => normalizeSettings({ checkpointInterval: 2, longMemoryInterval: 2 }),
        apiClient: { complete: async () => { requests++; return { content: '[LONG_MEMORY]\n- 重要长期事实' }; } } });
    await summarizer.generateDueLongMemories();
    assert.equal(requests, 1); assert.equal(store.current().longMemories.length, 1);
});

test('swipes, whitespace and genuine source edits leave generated CPs frozen', () => {
    const chat = [1, 2].map(i => ({ name: '甲', mes: `正文 ${i}`, gen_started: `g${i}` })), metadata = {};
    const store = new MemoryStore({ getMetadata: () => metadata, getChatId: () => 'a', saveMetadata: () => {} });
    for (const entry of getAssistantMessages(chat)) store.addSummary({ ...row(entry.messageId), floor: entry.floor, sourceFingerprint: entry.fingerprint });
    store.addCheckpoint(cp('checkpoint-001', 1, 1)); store.addCheckpoint(cp('checkpoint-002', 2, 2));
    store.syncMessages(chat); chat[0].swipe_id = 1; chat[0].mes = '正文   1\n'; store.syncMessages(chat);
    assert.ok(store.current().checkpoints.every(isUsableMemory));
    chat[0].mes = '事实发生变化'; store.syncMessages(chat);
    assert.equal(store.current().checkpoints[0].status, 'frozen'); assert.ok(isUsableMemory(store.current().checkpoints[1]));
    store.syncMessages([]); assert.equal(store.current().checkpoints[0].status, 'frozen');
});

for (const authority of [false, true]) test(`different-device additions automatically save without dropping either side (authority=${authority})`, async () => {
    const f = persistenceFixture(authority);
    f.remote.summaries.remote = row('remote'); f.metadata.cache_memory.summaries.local = row('local');
    f.p.enqueue(f.metadata.cache_memory); await f.p.flush();
    assert.equal(f.p.getState().state, 'confirmed'); assert.equal(f.p.conflicts.size, 0);
    assert.ok(f.remote.summaries.local); assert.ok(f.remote.summaries.remote);
});

test('a shared baseline distinguishes a server-only edit from genuinely concurrent same-ID edits', async () => {
    const f = persistenceFixture();
    f.metadata.cache_memory.summaries.same = row('same', 'original'); f.remote = structuredClone(f.metadata.cache_memory);
    f.p.activate('a', f.metadata.cache_memory);
    f.remote.summaries.same.event = 'new server content';
    assert.equal((await f.p.reread()).state, 'confirmed'); assert.equal(f.metadata.cache_memory.summaries.same.event, 'new server content');
    f.metadata.cache_memory.summaries.same.event = 'local change'; f.remote.summaries.same.event = 'remote change';
    assert.equal((await f.p.reread()).state, 'conflict'); assert.equal(f.remote.summaries.same.event, 'remote change');
    assert.equal(f.p.conflictBundle().local.summaries.same.event, 'local change');
    assert.equal(f.p.conflictBundle().remote.summaries.same.event, 'remote change');
});

test('readback metadata differences and disjoint writes are reconciled without manual conflict', async () => {
    const f = persistenceFixture(); let calls = 0;
    f.p.saveMetadata = async () => {
        f.remote = structuredClone(f.metadata.cache_memory);
        if (++calls === 1) { f.remote.summaries.other = row('other'); f.remote.summaries.local.updatedAt = 'device-local'; }
    };
    f.metadata.cache_memory.summaries.local = row('local'); f.p.enqueue(f.metadata.cache_memory); await f.p.flush();
    assert.equal(f.p.getState().state, 'confirmed'); assert.equal(f.p.conflicts.size, 0);
    assert.ok(f.remote.summaries.local); assert.ok(f.remote.summaries.other); assert.ok(calls <= 2);
});

for (const current of ['edit', 'delete']) test(`concurrent ${current} and remote edit/delete retain both sides without an automatic overwrite`, async () => {
    const f = persistenceFixture();
    f.metadata.cache_memory.summaries.same = row('same'); f.remote = structuredClone(f.metadata.cache_memory); f.p.activate('a', f.metadata.cache_memory);
    const edited = current === 'edit' ? f.metadata.cache_memory : f.remote;
    const deleted = current === 'delete' ? f.metadata.cache_memory : f.remote;
    edited.summaries.same.event = 'reviewed edit';
    delete deleted.summaries.same; deleted.tombstones['Summary:same'] = { deletedAt: 'explicit deletion' };
    f.p.enqueue(f.metadata.cache_memory); await f.p.flush();
    assert.equal(f.p.getState().state, 'conflict'); assert.equal(f.writes, 0);
    assert.ok(f.p.conflictBundle().local); assert.ok(f.p.conflictBundle().remote);
});

test('same-ID timestamps and missing validation metadata alone never choose facts', () => {
    const base = createEmptyStore('a'); base.checkpoints = [cp('checkpoint-001', 1, 5)];
    const local = structuredClone(base), remote = structuredClone(base);
    local.checkpoints[0].updatedAt = '2099'; local.checkpoints[0].sourceVersions = { m1: 'different check' };
    remote.checkpoints[0].content = 'confirmed remote change';
    const result = mergeMemoryStoresThreeWay(base, local, remote, 'a');
    assert.equal(result.conflicts.length, 0); assert.equal(result.merged.checkpoints[0].content, 'confirmed remote change');
});

test('checkpoint cleanup removes exact repeats and superseded tracked values while preserving knowledge differences', () => {
    const store = createEmptyStore('a'), item = { kind: 'state', entity: '甲', key: '洞察', value: 'Lv.3', status: 'active' };
    store.summaries.m = { ...row('m'), stateChanges: [{ ...item, id: stateId(item) }] };
    const text = reconcileTrackedCheckpoint('[CHECKPOINT]\n[Current State]\n- 甲 · 洞察：Lv.2\n- 地图仍在乙手中\n- 地图仍在乙手中\n[Secrets & Knowledge]\n乙不知道甲的洞察升级', store, 1);
    assert.doesNotMatch(text, /Lv.2/); assert.match(text, /Lv.3/);
    assert.equal(text.match(/地图仍在乙手中/g).length, 1); assert.match(text, /乙不知道甲的洞察升级/);
});

test('fact updates retire duplicate old attributes and avoid adding the replacement twice', () => {
    const store = createEmptyStore('a'), item = { kind: 'state', entity: '甲', key: '洞察', value: 'Lv.3', status: 'active', lifetime: 'permanent', acquisition: 'obtained', evidence: '洞察升为三级' };
    store.summaries.m = { ...row('m'), stateChanges: [{ ...item, id: stateId(item) }] };
    const old = ['a', 'b'].map(id => ({ id, text: '甲 · 洞察：Lv.2', status: 'active' }));
    const updates = trackedFactUpdates([], store, 1, old);
    store.longMemories = [{ ...cp('long-001', 1, 1), memoryKind: 'facts', factUpdates: old.map(fact => ({ ...fact, action: 'add' })) }, { ...cp('long-002', 2, 2), memoryKind: 'facts', factUpdates: updates }];
    const facts = projectLongFacts(store).facts.filter(fact => fact.status === 'active');
    assert.equal(facts.length, 1); assert.match(facts[0].text, /Lv.3/);
    const parsed = parseFactUpdates('[LONG_MEMORY]\n- 新计划\n- 新计划\n[UPDATED_FACTS]\n- old | 新计划 | 明确替代旧计划', { facts: [{ id: 'old', text: '旧计划', status: 'active' }] }, '明确替代旧计划');
    assert.equal(parsed.length, 1); assert.equal(parsed[0].action, 'replace');
});

test('skill reconciliation preserves observer knowledge and other NPC possessions', () => {
    const store = createEmptyStore('a'), item = { kind: 'state', entity: '甲', key: '洞察', value: 'Lv.3', status: 'active', lifetime: 'permanent' };
    store.summaries.m = { ...row('m'), stateChanges: [{ ...item, id: stateId(item) }] };
    const other = ['乙不知道甲的洞察等级', '乙持有甲的洞察药水'];
    const updates = trackedFactUpdates(other.map((text, i) => ({ action: 'add', id: `f${i}`, text })), store, 1,
        other.map((text, i) => ({ id: `old${i}`, text, status: 'active' })));
    for (const text of other) assert.ok(updates.some(item => item.text === text));
    assert.ok(!updates.some(item => item.previousId?.startsWith('old')));
});

test('empty CP records are pending while complete CP without fingerprints is frozen', () => {
    const empty = cp('checkpoint-001', 1, 5, ''), complete = cp('checkpoint-002', 6, 10, '有效的完整内容');
    assert.equal(isUsableMemory(empty), false); assert.equal(memoryHealth(empty).code, 'missing');
    assert.equal(isUsableMemory(complete), true); assert.equal(memoryHealth(complete).code, 'valid');
});

test('legacy validation flags do not remove generated blocks at the next publish boundary', () => {
    const store = createEmptyStore('a'), settings = normalizeSettings();
    store.checkpoints = [cp('checkpoint-001', 1, 5, '已被改写的旧事实'), cp('checkpoint-002', 6, 10, '仍有效的历史')];
    const frozen = refreshSnapshot(store, settings, 'new checkpoint').value;
    store.checkpoints[0].status = 'stale'; store.checkpoints[0].sourceValidity = 'changed';
    assert.equal(refreshSnapshot(store, settings, 'new summary').value, frozen);
    const value = refreshSnapshot(store, settings, 'new checkpoint').value;
    assert.match(value, /已被改写的旧事实/); assert.match(value, /仍有效的历史/);
});

test('an authoritative CAS revision race automatically retries only non-conflicting records', async () => {
    const f = persistenceFixture(true); let attempts = 0;
    const commit = f.p.commitAuthoritative;
    f.p.commitAuthoritative = async (id, payload) => {
        if (++attempts === 1) {
            f.remote.summaries.other = row('other'); f.remote.sync.revision++;
            throw Object.assign(new Error('revision conflict'), { status: 409, data: { record: { store: structuredClone(f.remote), revision: f.remote.sync.revision } } });
        }
        return commit(id, payload);
    };
    f.metadata.cache_memory.summaries.local = row('local'); f.p.enqueue(f.metadata.cache_memory); await f.p.flush();
    assert.equal(f.p.getState().state, 'confirmed'); assert.equal(attempts, 2);
    assert.ok(f.remote.summaries.local); assert.ok(f.remote.summaries.other);
});

test('explicit Summary and CP regeneration leave other generated records frozen until the user replaces them', () => {
    const chat = [{ name: '甲', mes: '原计划前往北门', gen_started: 'g' }], metadata = {};
    const store = new MemoryStore({ getMetadata: () => metadata, getChatId: () => 'a', saveMetadata: () => {} });
    const before = getAssistantMessages(chat)[0];
    store.addSummary({ ...row(before.messageId, before.message.mes), sourceFingerprint: before.fingerprint });
    store.addCheckpoint(cp('checkpoint-001', 1, 1, '原计划前往北门'));
    store.addLongMemory(cp('long-001', 1, 1, '原计划前往北门'));
    store.syncMessages(chat); chat[0].mes = '改为前往南门'; store.syncMessages(chat);
    const changed = getAssistantMessages(chat)[0];
    store.addSummary({ ...row(changed.messageId, changed.message.mes), sourceFingerprint: changed.fingerprint, sourceContentFingerprint: changed.contentFingerprint }, { overwrite: true, background: true });
    assert.equal(store.current().checkpoints[0].status, 'frozen'); assert.equal(store.current().longMemories[0].status, 'frozen');
    store.addCheckpoint(cp('checkpoint-001', 1, 1, '改为前往南门'), { overwrite: true });
    assert.ok(isUsableMemory(store.current().checkpoints[0])); assert.equal(store.current().longMemories[0].status, 'frozen');
});

test('a revision-only CAS race refreshes the baseline revision before retrying', async () => {
    const f = persistenceFixture(true); let attempts = 0;
    const commit = f.p.commitAuthoritative;
    f.p.commitAuthoritative = async (id, payload) => {
        if (++attempts === 1) {
            f.remote.sync.revision++;
            throw Object.assign(new Error('revision conflict'), { status: 409, data: { record: { store: structuredClone(f.remote), revision: f.remote.sync.revision } } });
        }
        return commit(id, payload);
    };
    f.metadata.cache_memory.summaries.local = row('local'); f.p.enqueue(f.metadata.cache_memory); await f.p.flush();
    assert.equal(f.p.getState().state, 'confirmed'); assert.equal(attempts, 2); assert.ok(f.remote.summaries.local);
});

test('an incomplete generation keeps the complete server record without archiving the failed attempt', async () => {
    const f = persistenceFixture(); f.remote.summaries.same = row('same', 'complete'); f.metadata.cache_memory = structuredClone(f.remote); f.p.activate('a', f.metadata.cache_memory);
    f.metadata.cache_memory.summaries.same = { ...row('same', 'failed response'), status: 'failed', frozen: false };
    f.p.enqueue(f.metadata.cache_memory); await f.p.flush();
    assert.equal(f.p.getState().state, 'confirmed'); assert.equal(f.remote.summaries.same.event, 'complete');
    assert.equal(f.remote.recovery, undefined);
});
