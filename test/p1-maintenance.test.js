import test from 'node:test';
import assert from 'node:assert/strict';
import { createEmptyStore, MemoryStore, aggregateVersion, summaryVersion, mergeMemoryStores, memoryContentDigest, memoryHealth } from '../src/memory-store.js';
import { MemoryPersistenceCoordinator } from '../src/persistence.js';
import { MemorySummarizer } from '../src/summarizer.js';
import { inspectMemoryImport, prepareMemoryImport } from '../src/memory-import.js';
import { DEFAULT_PROMPTS, V1200_DEFAULT_PROMPTS, normalizeSettings } from '../src/defaults.js';
import { getAssistantMessages } from '../src/utils.js';
import { isUsableMemory, projectLongFacts } from '../src/continuity.js';
import { parseStateChanges, projectActiveState, stateId, stateContext, trackedFactUpdates } from '../src/active-state.js';
import { memoryOverviewStats } from '../src/ui.js';
import { refreshSnapshot } from '../src/cache-control.js';

const gate = () => { let resolve, reject; const promise = new Promise((a, b) => { resolve = a; reject = b; }); return { promise, resolve, reject }; };
const row = (id, floor, event = id) => ({ messageId: id, floor, event, raw: event, frozen: true, status: 'frozen', sourceFingerprint: id });
function persistenceFixture(authority = false) {
    let chatId = 'a', remote = createEmptyStore('a'), writes = 0;
    const metadata = { cache_memory: structuredClone(remote) };
    const p = new MemoryPersistenceCoordinator({ getChatId: () => chatId, getMetadata: () => metadata,
        readRemoteStore: async () => structuredClone(remote), saveMetadata: async () => { writes++; remote = structuredClone(metadata.cache_memory); },
        ...(authority ? { readAuthoritativeStore: async () => ({ store: structuredClone(remote), revision: remote.sync.revision }), commitAuthoritative: async (_, payload) => { assert.equal(payload.baseRevision, remote.sync.revision); writes++; remote = structuredClone(payload.snapshot); return { record: { store: structuredClone(remote), revision: remote.sync.revision } }; } } : {}) });
    p.activate('a', metadata.cache_memory);
    return { p, metadata, get remote() { return remote; }, set remote(value) { remote = value; }, get writes() { return writes; }, set chatId(value) { chatId = value; } };
}
function aggregateFixture() {
    const chat = Array.from({ length: 10 }, (_, i) => ({ name: '合成人物', mes: `合成正文 ${i + 1}`, gen_started: `g${i}` }));
    const metadata = { cache_memory: createEmptyStore('a') }, reasons = [], calls = [];
    const store = new MemoryStore({ getChatId: () => 'a', getMetadata: () => metadata, saveMetadata: () => {}, onChange: (_, reason) => reasons.push(reason) });
    for (const entry of getAssistantMessages(chat)) store.addSummary({ ...row(entry.messageId, entry.floor), sourceFingerprint: entry.fingerprint, messageIndex: entry.messageIndex });
    const cp = (start, end, id, prev = null) => {
        const summaries = Object.values(store.current().summaries).filter(item => item.floor >= start && item.floor <= end);
        return { id, startFloor: start, endFloor: end, content: `旧 ${id}`, status: 'frozen', frozen: true,
            sourceVersions: Object.fromEntries(summaries.map(item => [item.messageId, summaryVersion(item)])), previousCheckpointId: prev,
            checkpointVersions: prev ? { [prev]: aggregateVersion(store.current().checkpoints.find(item => item.id === prev)) } : {} };
    };
    store.addCheckpoint(cp(1, 5, 'checkpoint-001'));
    store.addCheckpoint(cp(6, 10, 'checkpoint-002', 'checkpoint-001'));
    const summarizer = new MemorySummarizer({ store, getChat: () => chat, getSettings: () => normalizeSettings(), apiClient: { complete: async req => { calls.push(req); return { content: '[CHECKPOINT]\n[Current State]\n新阶段状态\n[Open Threads]\n无' }; } } });
    return { chat, metadata, store, summarizer, reasons, calls };
}

test('new defaults and reset templates preserve budget, structure, NPC rules and custom prompts', () => {
    assert.deepEqual(normalizeSettings().prompts, DEFAULT_PROMPTS);
    assert.deepEqual(normalizeSettings({ prompts: V1200_DEFAULT_PROMPTS }).prompts, DEFAULT_PROMPTS);
    for (const name of Object.keys(DEFAULT_PROMPTS)) {
        const custom = `${V1200_DEFAULT_PROMPTS[name]}\n自定义内容`;
        assert.equal(normalizeSettings({ prompts: { [name]: custom } }).prompts[name], custom);
        for (const variable of V1200_DEFAULT_PROMPTS[name].match(/{{\w+}}/g)) assert.ok(DEFAULT_PROMPTS[name].includes(variable));
    }
    assert.match(DEFAULT_PROMPTS.summary, /候选奖励、待领取奖励不等于已获得/);
    assert.match(DEFAULT_PROMPTS.checkpoint, /条件满足待结算仍保留/);
    assert.match(DEFAULT_PROMPTS.longMemory, /UPDATED_FACTS 更新原 fact-id/);
    assert.equal(normalizeSettings().injectionMaxTokens, 2800);
});

test('published, ready and unclaimed tasks remain active; failed tasks leave current context', () => {
    const store = createEmptyStore('a');
    const base = { kind: 'thread', entity: '甲/主角', key: '任务', value: '已正式发布', evidence: '系统正式发布任务', confirmed: true };
    for (const [i, status] of ['published', 'active', 'ready', 'unclaimed', 'failed'].entries()) {
        const known = projectActiveState(store);
        const changes = parseStateChanges(JSON.stringify([{ ...base, status }]), base.evidence, known);
        store.summaries[`m${i}`] = { ...row(`m${i}`, i + 1), stateChanges: changes };
        assert.equal(changes.length, 1);
        if (status !== 'failed') assert.match(stateContext(store), /任务/);
    }
    assert.equal(projectActiveState(store).length, 1);
    assert.equal(stateContext(store), '无');
});

test('unclaimed rewards do not enter Long Facts and acquired skills reuse unique existing fact IDs', () => {
    const store = createEmptyStore('a'), reward = { kind: 'state', entity: '甲/主角', key: '金币奖励', value: '100', status: 'active', category: 'reward', evidence: '系统奖励一百金币', confirmed: true };
    store.summaries.m1 = { ...row('m1', 1), stateChanges: parseStateChanges(JSON.stringify([reward]), reward.evidence) };
    assert.equal(projectActiveState(store)[0].acquisition, 'pending');
    assert.deepEqual(trackedFactUpdates([], store, 1), []);
    assert.equal(projectLongFacts(store, Infinity, { includeTracked: true }).facts.length, 0);
    const skill = { ...reward, key: '洞察', category: 'skill', acquisition: 'obtained', value: 'Lv.3' };
    store.summaries.m2 = { ...row('m2', 2), stateChanges: [{ ...skill, id: stateId(skill) }] };
    const updates = trackedFactUpdates([], store, 2, [{ id: 'fact-001', status: 'active', text: '甲/主角 · 洞察：Lv.2' }]);
    assert.equal(updates.length, 1); assert.equal(updates[0].id, 'fact-001'); assert.match(updates[0].text, /Lv.3/);
});

for (const authority of [false, true]) for (const preference of ['local', 'server']) test(`same-ID ${preference} choice keeps disjoint records and confirms readback (authority=${authority})`, async () => {
    const f = persistenceFixture(authority);
    f.remote.summaries.same = row('same', 1, '服务器版本'); f.remote.summaries.r = row('r', 2);
    f.metadata.cache_memory.summaries.same = row('same', 1, '本机版本'); f.metadata.cache_memory.summaries.l = row('l', 3);
    f.metadata.cache_memory.injectionSnapshot = { value: '冻结原文', blocks: [] };
    await f.p.reread(); assert.equal(f.p.getState().state, 'conflict');
    const partial = await f.p.resolveConflictByMerge(); assert.equal(partial.conflicts.length, 1); assert.equal(f.writes, 0);
    assert.ok(f.metadata.cache_memory.summaries.r);
    await f.p.resolveConflict('a', preference);
    assert.equal(f.p.getState().state, 'confirmed'); assert.equal(f.p.conflicts.size, 0);
    assert.equal(f.remote.summaries.same.event, preference === 'local' ? '本机版本' : '服务器版本');
    assert.ok(f.remote.summaries.r); assert.ok(f.remote.summaries.l);
    assert.equal(f.remote.injectionSnapshot.value, '冻结原文');
    assert.ok(Object.values(f.remote.recovery).some(item => item.kind === 'conflict-backup' && item.local && item.remote));
});

test('a new server revision after conflict preview aborts resolution without writes', async () => {
    const f = persistenceFixture(); f.remote.summaries.m1 = row('m1', 1, 'other');
    await f.p.reread(); f.remote.summaries.m2 = row('m2', 2);
    await assert.rejects(f.p.resolveConflict('a', 'local'), /版本已变化/);
    assert.equal(f.writes, 0); assert.equal(f.p.getState().state, 'conflict'); assert.ok(f.p.conflictBundle().remote.summaries.m2);
});

test('reread cancels obsolete requests and suppresses stale errors even for same-chat reload', async () => {
    const f = persistenceFixture(), release = gate(); let signal;
    f.p.readRemoteStore = async (_, options) => { signal = options.signal; return release.promise; };
    const reading = f.p.reread(); await Promise.resolve();
    f.p.activate('a', f.metadata.cache_memory); assert.equal(signal.aborted, true);
    f.p.setState('a', 'confirmed', '新读取已完成'); release.reject(new Error('old failure'));
    await reading; assert.equal(f.p.getState().state, 'confirmed'); assert.equal(f.p.getState().detail, '新读取已完成');
});

test('reread equality is synced; read failure is distinct and does not mutate records', async () => {
    const f = persistenceFixture(); assert.equal((await f.p.reread()).state, 'confirmed');
    const digest = memoryContentDigest(f.metadata.cache_memory);
    f.p.readRemoteStore = async () => { throw new Error('network'); };
    assert.equal((await f.p.reread()).state, 'failed'); assert.equal(memoryContentDigest(f.metadata.cache_memory), digest);
});

test('v6 imports preview counts, reject malformed/foreign/future data and preserve caller input', () => {
    const data = createEmptyStore('a'); data.summaries.m1 = row('m1', 1);
    assert.equal(inspectMemoryImport(data, 'a').counts.Summary, 1);
    for (const bad of [{ ...data, version: 7 }, { ...data, chatId: 'b' }, { ...data, summaries: [] }, { ...data, checkpoints: [{ id: 'cp' }] }, { ...data, summaries: { bad: row('other', 1) } }]) assert.throws(() => inspectMemoryImport(bad, 'a'));
    assert.throws(() => inspectMemoryImport(JSON.parse(JSON.stringify(data).replace('"m1":', '"__proto__":')), 'a'));
    assert.equal(data.version, 6);
});

test('merge and replace imports keep frozen snapshot and backup both versions, honoring deletion markers', () => {
    const current = createEmptyStore('a'), incoming = createEmptyStore('a');
    current.summaries.m1 = row('m1', 1, 'local'); current.summaries.extra = row('extra', 2);
    current.injectionSnapshot = { value: '冻结本机', blocks: [] }; current.tombstones['Summary:gone'] = { deletedAt: 'now' };
    incoming.summaries.m1 = row('m1', 1, 'incoming'); incoming.summaries.gone = row('gone', 3);
    incoming.injectionSnapshot = { value: '导入快照', blocks: [] };
    const inspected = inspectMemoryImport(incoming, 'a');
    for (const mode of ['merge', 'replace']) {
        const result = prepareMemoryImport(current, inspected, { mode, preference: 'incoming' });
        assert.equal(result.merged.summaries.m1.event, 'incoming'); assert.equal(result.merged.injectionSnapshot.value, '冻结本机');
        assert.ok(Object.values(result.merged.recovery).some(item => item.kind === 'import-backup'));
        assert.equal(result.merged.summaries.gone, undefined);
        assert.equal(Boolean(result.merged.summaries.extra), mode === 'merge');
    }
    assert.equal(current.summaries.m1.event, 'local');
});

test('deleting a Summary or CP cannot be undone by merging an older device', () => {
    const f = aggregateFixture(), old = structuredClone(f.store.current());
    const id = Object.keys(f.store.current().summaries)[0]; f.store.deleteSummary(id); f.store.deleteAggregate('checkpoint', 'checkpoint-001');
    const merged = mergeMemoryStores(f.store.current(), old, 'a');
    assert.equal(merged.merged.summaries[id], undefined); assert.equal(merged.merged.checkpoints.some(cp => cp.id === 'checkpoint-001'), false);
    assert.ok(Object.values(merged.merged.recovery).some(item => item.kind === 'deleted-merge'));
});

test('CP restores only when all recorded dependencies match; unknown legacy stale CP stays unverified', () => {
    const f = aggregateFixture(), cp = f.store.current().checkpoints[0];
    cp.status = 'stale'; cp.staleReason = '旧标记'; f.store.revalidate(f.chat);
    assert.equal(isUsableMemory(f.store.current().checkpoints[0]), true);
    const second = f.store.current().checkpoints[1]; second.status = 'stale'; delete second.checkpointVersions;
    f.store.revalidate(f.chat); assert.equal(isUsableMemory(second), false); assert.equal(second.sourceValidity, 'unverified');
    assert.match(second.staleReason, /缺少完整来源/);
});

test('source edit and return revalidates CP in order without calling model', () => {
    const f = aggregateFixture(), original = f.chat[0].mes;
    f.chat[0].mes = '已编辑的正文'; f.store.revalidate(f.chat);
    assert.ok(f.store.current().checkpoints.every(cp => cp.status === 'stale'));
    f.chat[0].mes = original; f.store.revalidate(f.chat);
    assert.ok(f.store.current().checkpoints.every(isUsableMemory)); assert.equal(f.calls.length, 0);
});

test('CP content update invalidates downstream CP and Long, including legacy dependencies', () => {
    const f = aggregateFixture(); f.store.addLongMemory({ id: 'long-001', startFloor: 1, endFloor: 10, content: '长期内容', checkpointIds: ['checkpoint-001', 'checkpoint-002'], status: 'frozen' });
    f.store.updateAggregate('checkpoint', 'checkpoint-001', { content: '人工新内容' });
    assert.equal(f.store.current().checkpoints[1].status, 'stale'); assert.equal(f.store.current().longMemories[0].status, 'stale');
});

test('maintenance updates stale CPs old to new using existing summaries, never publishes frozen snapshot', async () => {
    const f = aggregateFixture(), settings = normalizeSettings();
    refreshSnapshot(f.store.current(), settings, 'manual reinject'); const frozen = f.store.current().injectionSnapshot.value;
    const firstSummary = Object.values(f.store.current().summaries)[0]; firstSummary.event = '已核对的新摘要'; f.store.validateDependencies();
    f.reasons.length = 0;
    const result = await f.summarizer.updateCheckpoints();
    assert.equal(result.created, 2); assert.equal(f.calls.length, 2);
    assert.match(f.calls[1].userContent, /新阶段状态/);
    assert.equal(f.store.current().injectionSnapshot.value, frozen);
    assert.ok(f.reasons.every(reason => !['manual edit', 'new checkpoint', 'new long memory'].includes(reason)));
    assert.ok(Object.values(f.store.current().recovery).some(item => item.kind === 'checkpoint' && item.record.content === '旧 checkpoint-001'));
});

test('update failure keeps old CP content and stops downstream; conflict performs no model requests', async () => {
    const f = aggregateFixture(); Object.values(f.store.current().summaries)[0].event = 'changed'; f.store.validateDependencies();
    f.summarizer.apiClient.complete = async () => { throw new Error('synthetic API failure'); };
    const result = await f.summarizer.updateCheckpoints(); assert.equal(result.failed, 1); assert.equal(result.processed, 1);
    assert.equal(f.store.current().checkpoints[0].content, '旧 checkpoint-001'); assert.equal(f.store.current().checkpoints[1].content, '旧 checkpoint-002');
    f.summarizer.getPersistenceState = () => ({ state: 'conflict' }); await assert.rejects(f.summarizer.updateCheckpoints(), /跨设备冲突/);
    assert.equal(f.calls.length, 0);
});

test('missing Summary blocks CP update without model; cancellation stops before first call', async () => {
    const f = aggregateFixture(); f.store.deleteSummary(Object.keys(f.store.current().summaries)[0]);
    const result = await f.summarizer.updateCheckpoints(); assert.equal(result.failed, 1); assert.equal(f.calls.length, 0);
    const controller = new AbortController(); controller.abort();
    await assert.rejects(f.summarizer.updateCheckpoints({ signal: controller.signal }), { code: 'REQUEST_ABORTED' });
});

test('health separates stored stale CP, failed/unverified Summary and missing records from injection omissions', () => {
    const f = aggregateFixture(), entries = getAssistantMessages(f.chat);
    Object.values(f.store.current().summaries)[0].sourceValidity = 'unverified';
    Object.values(f.store.current().summaries)[1].status = 'failed';
    f.store.current().checkpoints[0].status = 'stale'; f.store.current().checkpoints[0].staleReason = '来源版本不一致';
    f.store.current().injectionSnapshot = { value: '', blocks: [], budget: { omitted: 2 } };
    const overview = memoryOverviewStats(f.store.current(), entries, normalizeSettings());
    assert.match(overview.issues.join('\n'), /校验信息缺失/); assert.match(overview.issues.join('\n'), /生成失败/);
    assert.match(overview.issues.join('\n'), /已生成但需要更新：来源版本不一致/);
    assert.ok(!overview.aggregateDetails.some(row => row.id === 'checkpoint-002'));
    assert.equal(memoryHealth(f.store.current().checkpoints[1]).code, 'valid');
});

test('maintenance snapshot is retained on reload and rebuilt at the next permitted boundary', async () => {
    const f = aggregateFixture(), settings = normalizeSettings();
    refreshSnapshot(f.store.current(), settings, 'manual reinject'); const frozen = f.store.current().injectionSnapshot.value;
    Object.values(f.store.current().summaries)[0].event = '新确认的来源'; f.store.validateDependencies();
    await f.summarizer.updateCheckpoints();
    assert.equal(f.store.current().injectionSnapshot.needsRebuild, true);
    assert.equal(refreshSnapshot(f.store.current(), settings, 'chat changed').value, frozen);
    const next = refreshSnapshot(f.store.current(), settings, 'new checkpoint');
    assert.match(next.value, /新阶段状态/); assert.notEqual(next.value, frozen);
    assert.equal(f.store.current().injectionSnapshot.needsRebuild, undefined);
});

test('manual tracked corrections invalidate CP without prematurely changing frozen bytes', () => {
    const f = aggregateFixture(), source = Object.values(f.store.current().summaries)[0];
    refreshSnapshot(f.store.current(), normalizeSettings(), 'manual reinject'); const frozen = f.store.current().injectionSnapshot.value;
    f.store.editTrackedState({ kind: 'state', entity: '合成人物', key: '技能', value: 'Lv.3', sourceFloor: source.floor, status: 'active', lifetime: 'permanent' });
    assert.equal(f.store.current().checkpoints[0].status, 'stale'); assert.equal(f.store.current().injectionSnapshot.value, frozen);
    assert.equal(f.store.current().injectionSnapshot.needsRebuild, true);
});

test('unconfirmed CP persistence stops the batch and retains the old CP recovery copy', async () => {
    const f = aggregateFixture(); Object.values(f.store.current().summaries)[0].event = 'new'; f.store.validateDependencies();
    f.summarizer.flushMemory = async () => ({ state: 'failed', detail: 'synthetic disconnect' });
    const result = await f.summarizer.updateCheckpoints();
    assert.equal(f.calls.length, 1); assert.equal(result.failed, 1);
    assert.ok(Object.values(f.store.current().recovery).some(item => item.kind === 'checkpoint' && item.record.content === '旧 checkpoint-001'));
});

test('device-local validation metadata does not cause a same-ID content conflict', () => {
    const local = createEmptyStore('a'), remote = createEmptyStore('a');
    local.summaries.m1 = { ...row('m1', 1), sourceValidity: 'valid' };
    remote.summaries.m1 = row('m1', 1);
    assert.equal(mergeMemoryStores(local, remote, 'a').conflicts.length, 0);
    remote.summaries.m1.event = 'actual change';
    assert.equal(mergeMemoryStores(local, remote, 'a').conflicts.length, 1);
});

test('server aggregate ordering alone does not change the memory digest', () => {
    const store = createEmptyStore('a'); store.checkpoints = [{ id: 'cp-z', startFloor: 1 }, { id: 'cp-a', startFloor: 6 }];
    const reordered = structuredClone(store); reordered.checkpoints.reverse();
    assert.equal(memoryContentDigest(store), memoryContentDigest(reordered));
});

test('an older authoritative plugin dropping deletion markers cannot falsely confirm the save', async () => {
    const f = persistenceFixture(true);
    f.metadata.cache_memory.tombstones['Summary:deleted'] = { deletedAt: 'now' };
    f.p.commitAuthoritative = async (_, payload) => {
        const store = structuredClone(payload.snapshot); delete store.tombstones;
        return { record: { store, revision: store.sync.revision } };
    };
    f.p.enqueue(f.metadata.cache_memory);
    const state = await f.p.flush(); assert.equal(state.state, 'failed'); assert.match(state.detail, /更新服务端插件/);
    assert.ok(f.p.pending.get('a').snapshot.tombstones['Summary:deleted']);
});

test('unverified existing CP blocks automatic paid repair and gapped CP input is rejected before Long generation', async () => {
    const f = aggregateFixture(); f.store.current().checkpoints[0].sourceValidity = 'unverified';
    await f.summarizer.generateDueAggregates(); assert.equal(f.calls.length, 0);
    const gapped = structuredClone(f.store.current().checkpoints); gapped[0].sourceValidity = 'valid'; gapped[1].startFloor = 7;
    await assert.rejects(f.summarizer.generateLongMemory(gapped), /区间存在缺口/); assert.equal(f.calls.length, 0);
});
