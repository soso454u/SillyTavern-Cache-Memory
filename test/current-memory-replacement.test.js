import test from 'node:test';
import assert from 'node:assert/strict';
import { MemoryStore, createEmptyStore, summaryVersion } from '../src/memory-store.js';
import { MemorySummarizer } from '../src/summarizer.js';
import { MemoryPersistenceCoordinator } from '../src/persistence.js';
import { INJECTION_MODES, normalizeSettings } from '../src/defaults.js';
import { getAssistantMessages } from '../src/utils.js';

function fixture(count = 5, authority = false) {
    const chat = Array.from({ length: count }, (_, i) => ({ name: 'A', mes: `当前正文${i + 1}`, send_date: `d${i}`, gen_started: `g${i}` }));
    const metadata = { cache_memory: createEmptyStore('a') };
    const store = new MemoryStore({ getMetadata: () => metadata, getChatId: () => 'a', saveMetadata() {} });
    for (const e of getAssistantMessages(chat)) store.current().summaries[e.messageId] = { messageId: e.messageId,
        floor: e.floor, messageIndex: e.messageIndex, sourceFingerprint: e.fingerprint, sourceContentFingerprint: e.contentFingerprint,
        sourceMessageKey: e.sourceMessageKey, event: `当前摘要${e.floor}`, frozen: true, status: 'frozen' };
    let remote = structuredClone(store.current()), fail = false, duringWrite = () => {};
    const journal = new Map();
    const storage = { getItem: key => journal.get(key), setItem: (key, value) => journal.set(key, value), removeItem: key => journal.delete(key) };
    const persistence = new MemoryPersistenceCoordinator({ storage, getChatId: () => 'a', getMetadata: () => metadata,
        readRemoteStore: async () => structuredClone(remote), saveMetadata: async () => {
            duringWrite(); if (fail) throw new Error('模拟保存失败'); remote = structuredClone(metadata.cache_memory);
        }, ...(authority ? {
            readAuthoritativeStore: async () => ({ revision: remote.sync.revision, store: structuredClone(remote) }),
            commitAuthoritative: async (_, payload) => {
                duringWrite(); if (fail) throw new Error('模拟权威保存失败');
                assert.equal(payload.baseRevision, remote.sync.revision);
                remote = structuredClone(payload.snapshot);
                return { record: { revision: remote.sync.revision, store: structuredClone(remote) } };
            },
        } : {}) });
    persistence.activate('a', store.current());
    store.saveMetadata = (value, reason) => persistence.enqueue(value, reason);
    const requests = [];
    const summarizer = new MemorySummarizer({ store, getChat: () => chat, getSettings: () => normalizeSettings(),
        getPersistenceState: () => persistence.getState(), flushMemory: () => persistence.flush(),
        commitMemory: (mutate, active) => persistence.commitReplacement(store, mutate, active),
        apiClient: { complete: async request => { requests.push(request); return { content: request.systemPrompt.includes('[CHECKPOINT]')
            ? '[CHECKPOINT]\n[Current State]\n新版阶段正文' : request.systemPrompt.includes('[LONG_MEMORY]')
                ? '[LONG_MEMORY]\n新版长期正文\n[UPDATED_FACTS]\n无\n[RETIRED_FACTS]\n无' : '[SUMMARY]\n[Title]\n新版\n[Event]\n新版摘要正文\n[KEEP]\n无' }; } } });
    const seed = () => { remote = structuredClone(store.current()); persistence.pending.clear(); persistence.activate('a', store.current()); };
    return { chat, store, persistence, summarizer, requests, seed, get remote() { return remote; }, set fail(v) { fail = v; }, set duringWrite(fn) { duringWrite = fn; }, set remote(v) { remote = v; } };
}

test('floor 207 swipe replaces its old versions after readback; CP-042 uses only the current summary', async () => {
    const f = fixture(210), message = f.chat[206], old = getAssistantMessages(f.chat)[206];
    message.swipes = [message.mes, '当前有效的新剧情207'];
    message.swipe_info = [{ send_date: message.send_date, gen_started: message.gen_started, extra: {} }, { send_date: 'new207', gen_started: 'new-g207', extra: {} }];
    Object.assign(message, message.swipe_info[1], { mes: message.swipes[1], swipe_id: 1 });
    const entry = getAssistantMessages(f.chat)[206];
    const original = structuredClone(f.store.getSummary(old.messageId));
    f.store.current().checkpoints.push({ id: 'checkpoint-042', startFloor: 206, endFloor: 210, content: '旧阶段剧情',
        frozen: true, status: 'frozen', summaryIds: [old.messageId], sourceVersions: { [old.messageId]: summaryVersion(original) } });
    f.store.current().keepRegistry['KEEP-0001'] = { text: '保留用户 KEEP', sourceId: old.messageId, sourceFloor: 207, status: 'active' };
    f.store.current().stateOverrides.override = { sourceId: old.messageId, value: '用户状态' };
    f.seed(); f.store.rebindSummaryAtMessageIndex(206, f.chat);
    f.duringWrite = () => { assert.deepEqual(f.store.getSummary(old.messageId), original); assert.equal(f.store.getSummary(entry.messageId), null); };
    await f.summarizer.summarizeMessage(entry.messageId, { deferAggregates: true });
    assert.equal(f.store.getSummary(old.messageId), null); assert.equal(f.remote.summaries[old.messageId], undefined);
    assert.equal(Object.values(f.remote.summaries).filter(row => row.floor === 207).length, 1);
    assert.deepEqual(f.store.current().checkpoints[0].summaryIds, []);
    assert.equal(f.store.current().checkpoints[0].sourceVersions[old.messageId], undefined);
    assert.equal(f.store.current().keepRegistry['KEEP-0001'], undefined);
    assert.equal(f.store.current().stateOverrides.override, undefined);
    f.duringWrite = () => {};
    const cp = await f.summarizer.generateCheckpoint(206, 210, { overwrite: true });
    const input = f.requests.at(-1).userContent.split('[NEW_SUMMARIES]')[1];
    assert.equal((input.match(/\[第207层\]/g) ?? []).length, 1);
    assert.match(input, /新版摘要正文/); assert.doesNotMatch(input, /当前摘要207/);
    assert.equal(cp.sourceVersions[old.messageId], undefined);
    assert.equal(cp.sourceVersions[entry.messageId], summaryVersion(f.store.getSummary(entry.messageId)));
    assert.equal(f.remote.checkpoints.filter(row => row.startFloor === 206 && row.endFloor === 210).length, 1);
});

test('same-ID edit retains original on model or persistence failure, then replaces it on confirmed retry', async () => {
    const f = fixture(), entry = getAssistantMessages(f.chat)[0], original = structuredClone(f.store.getSummary(entry.messageId));
    f.chat[0].mes = '明确修改的正文'; f.fail = true;
    await assert.rejects(f.summarizer.summarizeMessage(entry.messageId, { deferAggregates: true }), { code: 'SAVE_UNCONFIRMED' });
    assert.deepEqual(f.store.getSummary(entry.messageId), original); assert.deepEqual(f.remote.summaries[entry.messageId], original);
    assert.deepEqual(f.persistence.pending.get('a').replacementFallback.summaries[entry.messageId], original);
    f.fail = false;
    assert.equal((await f.persistence.flush()).state, 'confirmed');
    assert.equal(f.store.getSummary(entry.messageId).event, '新版摘要正文');
    assert.equal(f.persistence.pending.size, 0);
    f.summarizer.apiClient.complete = async () => { throw new Error('Unauthorized'); };
    const current = structuredClone(f.store.getSummary(entry.messageId));
    await assert.rejects(f.summarizer.summarizeMessage(entry.messageId, { overwrite: true }), /Unauthorized/);
    assert.deepEqual(f.store.getSummary(entry.messageId), current);
});

test('replacement and tombstone cannot overwrite a genuinely newer server summary', async () => {
    const f = fixture(), e = getAssistantMessages(f.chat)[0], remote = structuredClone(f.remote);
    await f.persistence.reread();
    remote.summaries[e.messageId].event = '另一设备新正文摘要'; remote.sync.revision++;
    f.remote = remote; f.chat[0].mes = '本机不同编辑';
    await assert.rejects(f.summarizer.summarizeMessage(e.messageId, { deferAggregates: true }), { code: 'SAVE_UNCONFIRMED' });
    assert.equal(f.persistence.getState().state, 'conflict');
    assert.equal(f.remote.summaries[e.messageId].event, '另一设备新正文摘要');
});

test('regenerated aggregates replace every exact-range copy, preserve references, and roll back failures', async () => {
    const f = fixture(50);
    for (let start = 1; start <= 50; start += 5) f.store.current().checkpoints.push({ id: `cp-${start}`, startFloor: start, endFloor: start + 4, content: '原阶段', status: 'frozen' });
    f.store.current().checkpoints.push({ id: 'duplicate', startFloor: 1, endFloor: 5, content: '旧重复阶段', status: 'frozen' });
    f.store.current().longMemories.push({ id: 'long-current', startFloor: 1, endFloor: 50, content: '原长期', checkpointIds: ['duplicate'], status: 'frozen' },
        { id: 'long-duplicate', startFloor: 1, endFloor: 50, content: '旧重复长期', status: 'frozen' });
    f.seed(); const before = structuredClone(f.store.current()); f.fail = true;
    await assert.rejects(f.summarizer.generateCheckpoint(1, 5, { overwrite: true }), { code: 'SAVE_UNCONFIRMED' });
    assert.deepEqual(f.store.current().checkpoints, before.checkpoints);
    f.fail = false; await f.persistence.flush();
    assert.equal(f.store.current().checkpoints.filter(row => row.startFloor === 1).length, 1);
    assert.deepEqual(f.store.current().longMemories[0].checkpointIds, ['cp-1']);
    await f.summarizer.generateLongMemory(f.store.current().checkpoints, { overwrite: true });
    assert.equal(f.remote.longMemories.length, 1); assert.equal(f.remote.longMemories[0].content.includes('新版长期正文'), true);
    assert.equal(f.remote.tombstones['Long Memory:long-duplicate'].replacedBy, 'long-current');
});

test('cleanup removes provable swipe history but retains an uncertain same-floor record and partial-load data', async () => {
    const f = fixture(), message = f.chat[0], current = getAssistantMessages(f.chat)[0];
    message.swipes = [message.mes, '备选旧正文'];
    message.swipe_info = [{ send_date: message.send_date, gen_started: message.gen_started, extra: {} }, { send_date: 'old-date', gen_started: 'old-gen', extra: {} }];
    const alternate = getAssistantMessages([{ ...message, ...message.swipe_info[1], mes: message.swipes[1], swipe_id: 1 }])[0];
    f.store.current().summaries[alternate.messageId] = { messageId: alternate.messageId, floor: 1, messageIndex: 0, event: '旧备选摘要', sourceContentFingerprint: alternate.contentFingerprint, status: 'orphaned', frozen: true };
    f.store.current().summaries.uncertain = { messageId: 'uncertain', floor: 1, messageIndex: 0, event: '不能确定归属', status: 'frozen' };
    f.seed();
    assert.equal(f.store.hasSupersededRecords([]), false);
    await f.persistence.commitReplacement(f.store, () => f.store.cleanupSuperseded(f.chat));
    assert.equal(f.remote.summaries[alternate.messageId], undefined); assert.ok(f.remote.summaries.uncertain);
    assert.equal(f.remote.summaries[current.messageId].event, '当前摘要1');
    const before = structuredClone(f.store.current()); f.store.syncMessages([]);
    assert.deepEqual(Object.keys(f.store.current().summaries), Object.keys(before.summaries));
    assert.equal(f.store.current().summaries.uncertain.event, '不能确定归属');
    assert.equal(f.store.current().summaries[current.messageId].event, before.summaries[current.messageId].event);
});

test('ordinary refresh, swipe metadata or missing legacy fingerprints do not generate another summary', async () => {
    const f = fixture(), entry = getAssistantMessages(f.chat).at(-1), record = f.store.getSummary(entry.messageId);
    delete record.sourceFingerprint; delete record.sourceContentFingerprint;
    f.store.current().checkpoints.push({ id: 'legacy-cp', startFloor: 1, endFloor: 5, content: '不能因旧格式缺少指纹而丢失的重要历史', summaryIds: [entry.messageId], status: 'frozen' }); f.seed();
    for (let i = 0; i < 3; i++) { f.store.syncMessages(f.chat); await f.summarizer.summarizeLatest(); }
    assert.equal(f.requests.length, 0); assert.equal(Object.keys(f.store.current().summaries).length, 5);
    assert.equal(f.store.effectiveStore(f.chat).checkpoints.length, 1);
});

test('a first server verification cannot adopt newer memory and then overwrite it with an already generated draft', async () => {
    const f = fixture(), entry = getAssistantMessages(f.chat)[0];
    f.chat[0].mes = '本机新正文';
    f.summarizer.apiClient.complete = async () => {
        f.remote.summaries[entry.messageId].event = '模型运行期间另一设备保存的新摘要';
        return { content: '[SUMMARY]\n[Event]\n本机较早生成结果' };
    };
    await assert.rejects(f.summarizer.summarizeMessage(entry.messageId, { deferAggregates: true }), { code: 'SOURCE_CHANGED' });
    assert.equal(f.remote.summaries[entry.messageId].event, '模型运行期间另一设备保存的新摘要');
    assert.equal(f.persistence.pending.size, 0);
});

test('empty model replacements preserve all original Summary, Checkpoint and Long Memory records', async () => {
    const f = fixture();
    f.store.current().checkpoints.push({ id: 'cp', startFloor: 1, endFloor: 5, content: '原阶段', status: 'frozen' });
    f.store.current().longMemories.push({ id: 'long', startFloor: 1, endFloor: 5, content: '原长期', status: 'frozen' });
    f.seed(); const before = structuredClone(f.store.current());
    f.summarizer.apiClient.complete = async () => ({ content: '' });
    await assert.rejects(f.summarizer.summarizeMessage(getAssistantMessages(f.chat)[0].messageId, { overwrite: true }), /输出为空/);
    await assert.rejects(f.summarizer.generateCheckpoint(1, 5, { overwrite: true }), /输出为空/);
    await assert.rejects(f.summarizer.generateLongMemory(f.store.current().checkpoints, { overwrite: true }), /输出为空/);
    assert.deepEqual(f.store.current(), before);
});

test('edits made while a replacement is saving survive; a superseded local draft is not reported successful', async () => {
    const f = fixture(), entry = getAssistantMessages(f.chat)[0];
    let edited = false;
    f.duringWrite = () => {
        if (edited) return; edited = true;
        f.store.updateSummary(entry.messageId, { event: '保存过程中用户明确编辑的最新内容' });
    };
    await assert.rejects(f.summarizer.summarizeMessage(entry.messageId, { overwrite: true, deferAggregates: true }), { code: 'SOURCE_CHANGED' });
    assert.equal(f.remote.summaries[entry.messageId].event, '保存过程中用户明确编辑的最新内容');
    assert.equal(f.store.getSummary(entry.messageId).event, '保存过程中用户明确编辑的最新内容');
});

test('cleanup collapses a confirmed current aggregate but preserves conflicting ranges without proof', async () => {
    const f = fixture(), summary = f.store.getSummary(getAssistantMessages(f.chat)[0].messageId);
    f.store.current().checkpoints = [
        { id: 'cp-current', startFloor: 1, endFloor: 5, content: '新版阶段', sourceVersions: { [summary.messageId]: summaryVersion(summary) }, status: 'frozen' },
        { id: 'cp-old', startFloor: 1, endFloor: 5, content: '旧阶段', sourceVersions: { [summary.messageId]: 'obsolete-version' }, status: 'frozen' },
        { id: 'uncertain-1', startFloor: 6, endFloor: 10, content: '无法判定甲', status: 'frozen' },
        { id: 'uncertain-2', startFloor: 6, endFloor: 10, content: '无法判定乙', status: 'frozen' },
    ]; f.seed();
    await f.persistence.commitReplacement(f.store, () => f.store.cleanupSuperseded(f.chat));
    assert.deepEqual(f.remote.checkpoints.map(row => row.id), ['cp-current', 'uncertain-1', 'uncertain-2']);
    assert.equal(f.remote.tombstones['Checkpoint:cp-old'].replacedBy, 'cp-current');
});


test('authoritative replacement keeps the old effective record until commit and readback, including a failed retry', async () => {
    const f = fixture(5, true), entry = getAssistantMessages(f.chat)[0], old = structuredClone(f.store.getSummary(entry.messageId));
    f.chat[0].mes = '明确的新正文'; f.fail = true;
    f.duringWrite = () => assert.deepEqual(f.store.getSummary(entry.messageId), old);
    await assert.rejects(f.summarizer.summarizeMessage(entry.messageId, { deferAggregates: true }), { code: 'SAVE_UNCONFIRMED' });
    assert.deepEqual(f.store.getSummary(entry.messageId), old); assert.deepEqual(f.remote.summaries[entry.messageId], old);
    f.fail = false; await f.persistence.flush();
    assert.equal(f.remote.summaries[entry.messageId].event, '新版摘要正文');
    assert.equal(f.store.getSummary(entry.messageId).event, '新版摘要正文');
});

test('a stale alternative cannot resurrect a retired Summary or replace the other device’s current alternative', async () => {
    const f = fixture(), message = f.chat[0], old = getAssistantMessages(f.chat)[0];
    await f.persistence.reread();
    delete f.remote.summaries[old.messageId];
    f.remote.summaries['remote-current'] = { ...f.store.getSummary(old.messageId), messageId: 'remote-current', event: '另一设备当前剧情', sourceContentFingerprint: 'remote-content' };
    f.remote.tombstones[`Summary:${old.messageId}`] = { replacedBy: 'remote-current', sourceFloor: 1 };
    message.swipes = [message.mes, '本机另一段剧情'];
    message.swipe_info = [{ send_date: message.send_date, gen_started: message.gen_started, extra: {} }, { send_date: 'local-new', gen_started: 'local-gen', extra: {} }];
    Object.assign(message, message.swipe_info[1], { mes: message.swipes[1], swipe_id: 1 });
    f.store.rebindSummaryAtMessageIndex(0, f.chat);
    await assert.rejects(f.summarizer.summarizeMessage(getAssistantMessages(f.chat)[0].messageId, { deferAggregates: true }), { code: 'SAVE_UNCONFIRMED' });
    assert.equal(f.persistence.getState().state, 'conflict');
    assert.equal(f.remote.summaries[old.messageId], undefined);
    assert.equal(f.remote.summaries['remote-current'].event, '另一设备当前剧情');
});

test('a replaced source is quarantined without automatic historical regeneration or blocking a new stage', async () => {
    const f = fixture(10), entries = getAssistantMessages(f.chat);
    f.store.current().checkpoints = [
        { id: 'cp-1', startFloor: 1, endFloor: 5, memoryKind: 'state', content: '旧第一阶段剧情', status: 'frozen', summaryIds: entries.slice(0, 5).map(e => e.messageId) },
        { id: 'cp-2', startFloor: 6, endFloor: 10, memoryKind: 'state', content: '有效后续阶段剧情', status: 'frozen', previousCheckpointId: 'cp-1' },
    ];
    f.store.current().longMemories = [{ id: 'long-1', startFloor: 1, endFloor: 10, content: '旧长期剧情', checkpointIds: ['cp-1', 'cp-2'], status: 'frozen' }];
    f.seed(); f.chat[0].mes = '第一层明确的新剧情';
    await f.summarizer.summarizeMessage(entries[0].messageId, { deferAggregates: true });
    assert.equal(f.store.current().checkpoints[0].sourceReplaced, true);
    assert.equal(f.store.current().checkpoints[1].sourceReplaced, undefined);
    await assert.rejects(f.summarizer.generateLongMemory(f.store.current().checkpoints, { overwrite: true }), /来源 Checkpoint/);
    const calls = f.requests.length;
    const result = await f.summarizer.fillMissingMemories();
    assert.equal(result.failed, 0); assert.equal(result.created, 0); assert.equal(f.requests.length, calls);
    assert.equal(f.store.current().checkpoints[1].sourceReplaced, undefined);
    const effective = f.store.effectiveStore(f.chat);
    assert.deepEqual(effective.checkpoints.map(row => row.id), ['cp-2']); assert.equal(effective.longMemories.length, 0);
    for (let i = 10; i < 15; i++) f.chat.push({ name: 'A', mes: `有效后续正文${i + 1}`, send_date: `d${i}`, gen_started: `g${i}` });
    for (const entry of getAssistantMessages(f.chat).slice(10)) f.store.current().summaries[entry.messageId] = {
        messageId: entry.messageId, floor: entry.floor, messageIndex: entry.messageIndex,
        sourceFingerprint: entry.fingerprint, sourceContentFingerprint: entry.contentFingerprint, event: `有效后续摘要${entry.floor}`, status: 'frozen' };
    f.seed(); await f.summarizer.generateCheckpoint(11, 15);
    assert.doesNotMatch(f.requests.at(-1).userContent, /旧第一阶段剧情|旧长期剧情/);
    assert.match(f.requests.at(-1).userContent, /有效后续阶段剧情/);
    assert.match(f.requests.at(-1).userContent, /当前摘要2/);
    assert.match(f.requests.at(-1).userContent, /新版摘要正文/);
});

test('unknown conflicting prior ranges are preserved and cannot silently become the next stage’s story', async () => {
    const f = fixture(15);
    f.store.current().checkpoints = [
        { id: 'uncertain-a', startFloor: 6, endFloor: 10, content: '可能旧剧情', status: 'frozen' },
        { id: 'uncertain-b', startFloor: 6, endFloor: 10, content: '可能新剧情', status: 'frozen' },
    ]; f.seed(); const before = structuredClone(f.store.current().checkpoints);
    await assert.rejects(f.summarizer.generateCheckpoint(11, 15), /无法确认的不同记录/);
    assert.deepEqual(f.store.current().checkpoints, before); assert.equal(f.requests.length, 0);
});

test('a full browser journal stops replacement before writing and keeps the original effective memory', async () => {
    const f = fixture(), entry = getAssistantMessages(f.chat)[0], old = structuredClone(f.store.getSummary(entry.messageId));
    let writes = 0; f.duringWrite = () => { writes++; };
    f.persistence.storage = { setItem() { throw new Error('QuotaExceededError'); } };
    f.chat[0].mes = '新的正文';
    await assert.rejects(f.summarizer.summarizeMessage(entry.messageId, { deferAggregates: true }), { code: 'SAVE_UNCONFIRMED' });
    await f.persistence.flush();
    assert.equal(writes, 0); assert.deepEqual(f.store.getSummary(entry.messageId), old); assert.deepEqual(f.remote.summaries[entry.messageId], old);
});

test('effective source projection excludes old swipe facts, KEEP and state while retaining independent history and task settlement', async () => {
    const { refreshSnapshot } = await import('../src/cache-control.js');
    const { projectActiveState, stateId } = await import('../src/active-state.js');
    const f = fixture(10), entries = getAssistantMessages(f.chat);
    const task = { kind: 'thread', entity: '合成主角', key: '调查', value: '完成调查并取得永久奖励', status: 'completed', evidence: '任务已完成并领取奖励' };
    task.id = stateId(task);
    f.store.current().summaries[entries[1].messageId].event = '重大历史：城门永久毁坏；甲知道身份秘密但乙尚不知道';
    f.store.current().summaries[entries[1].messageId].stateChanges = [task];
    f.store.current().summaries[entries[0].messageId].stateChanges = [{ ...task, status: 'active', value: '废弃剧情中的未完成调查' }];
    f.store.current().checkpoints = [{ id: 'cp-old', startFloor: 1, endFloor: 5, content: '旧 Swipe 的废弃事实', status: 'frozen', summaryIds: entries.slice(0, 5).map(e => e.messageId) },
        { id: 'cp-independent', startFloor: 6, endFloor: 10, content: '独立有效历史阶段', status: 'frozen', summaryIds: entries.slice(5).map(e => e.messageId) }];
    f.store.current().longMemories = [{ id: 'long-old', startFloor: 1, endFloor: 5, content: '废弃长期剧情', memoryKind: 'facts', factUpdates: [{ action: 'add', id: 'old', text: '旧 Swipe 的废弃事实' }], checkpointIds: ['cp-old'], status: 'frozen' }];
    f.store.current().keepRegistry['KEEP-0001'] = { text: '旧 Swipe 的秘密', sourceId: entries[0].messageId, sourceFloor: 1, status: 'active' };
    f.store.current().keepRegistry['KEEP-0002'] = { text: '独立且仍然重要的认知差', sourceId: entries[1].messageId, sourceFloor: 2, status: 'active' };
    f.seed(); f.chat[0].mes = '切换到当前新正文';
    const raw = structuredClone(f.store.current()), effective = f.store.effectiveStore(f.chat);
    assert.deepEqual(f.store.current(), raw); assert.deepEqual(effective.checkpoints.map(row => row.id), ['cp-independent']);
    assert.equal(effective.longMemories.length, 0); assert.equal(effective.keepRegistry['KEEP-0001'], undefined);
    const rows = projectActiveState(effective).filter(row => !row.needsReview);
    assert.equal(rows.find(row => row.id === task.id).status, 'completed');
    const settings = normalizeSettings();
    const value = refreshSnapshot(f.store.current(), settings, 'manual reinject', effective).value;
    assert.doesNotMatch(value, /废弃|旧 Swipe/); assert.match(value, /城门永久毁坏/); assert.match(value, /乙尚不知道/); assert.match(value, /独立有效历史阶段/);
    const { buildInjection } = await import('../src/injection.js');
    const nonStrict = buildInjection(effective, normalizeSettings({ strictCacheMode: false, injectionMode: INJECTION_MODES.LONG_CHECKPOINT_RECENT }));
    assert.equal((nonStrict.match(/RECENT_SUMMARY_002/g) ?? []).length, 1);
    assert.match(nonStrict, /乙尚不知道/); assert.doesNotMatch(nonStrict, /废弃|旧 Swipe/);
    for (let n = 0; n < 10; n++) assert.equal(refreshSnapshot(f.store.current(), settings, 'new summary', f.store.effectiveStore(f.chat)).value, value);
    await f.summarizer.summarizeMessage(entries[0].messageId, { deferAggregates: true });
    assert.equal(f.store.current().keepRegistry['KEEP-0001'], undefined);
    assert.equal(f.store.effectiveStore(f.chat).keepRegistry['KEEP-0001'], undefined);
    assert.equal(f.store.current().checkpoints[1].sourceReplaced, undefined);
    assert.match(f.store.current().summaries[entries[1].messageId].event, /城门永久毁坏/);
});

test('verified duplicates are removed after readback without retaining a permanent replacement backup', async () => {
    const f = fixture(), entry = getAssistantMessages(f.chat)[0];
    f.store.current().summaries.duplicate = { ...structuredClone(f.store.getSummary(entry.messageId)), messageId: 'duplicate' };
    f.seed();
    await f.summarizer.summarizeMessage(getAssistantMessages(f.chat)[1].messageId, { overwrite: true, deferAggregates: true });
    assert.equal(f.remote.summaries.duplicate, undefined);
    assert.equal(f.persistence.storage.getItem('cache_memory_replacement_backup_v1:a'), undefined);
    assert.equal(f.persistence.pending.size, 0);
    assert.equal(f.persistence.replacementStores.size, 0);
    assert.equal(Object.values(f.remote.summaries).filter(row => row.floor === 1).length, 1);
});

test('238 floors repair the legacy cascade locally: no 207-summary replay, valid Long/CP history and frozen bytes survive', async () => {
    const { refreshSnapshot } = await import('../src/cache-control.js');
    const { buildInjection } = await import('../src/injection.js');
    const { aggregateVersion } = await import('../src/memory-store.js');
    const f = fixture(238), entries = getAssistantMessages(f.chat), settings = normalizeSettings();
    for (let start = 1; start <= 235; start += 5) {
        const sources = entries.slice(start - 1, start + 4);
        f.store.current().checkpoints.push({ id: `cp-${start}`, startFloor: start, endFloor: start + 4,
            content: start === 11 ? '废弃 Swipe 事实' : `重大阶段历史${start}；甲知道秘密，乙尚不知道`, memoryKind: 'state', status: 'frozen',
            summaryIds: sources.map(e => e.messageId), sourceVersions: Object.fromEntries(sources.map(e => [e.messageId, summaryVersion(f.store.getSummary(e.messageId))])),
            previousCheckpointId: start > 1 ? `cp-${start - 5}` : '', ...(start >= 11 ? { sourceReplaced: true } : {}) });
    }
    for (let start = 1; start <= 151; start += 50) {
        const cps = f.store.current().checkpoints.filter(cp => cp.startFloor >= start && cp.endFloor < start + 50);
        f.store.current().longMemories.push({ id: `long-${start}`, startFloor: start, endFloor: start + 49,
            content: start === 1 ? '旧 Swipe 的长期事实' : `不可逆重大历史${start}；人物认知差保留`, status: 'frozen', sourceReplaced: true,
            checkpointIds: cps.map(cp => cp.id), checkpointVersions: Object.fromEntries(cps.map(cp => [cp.id, aggregateVersion(cp)])) });
    }
    f.store.current().summaries[entries[11].messageId].event = '当前有效重大事件：城门永久毁坏；甲知情，乙未知';
    // Refresh the matching CP version after changing this synthetic fixture.
    f.store.current().checkpoints[2].sourceVersions[entries[11].messageId] = summaryVersion(f.store.getSummary(entries[11].messageId));
    const legacyBlocks = entries.slice(0, 207).map(e => ({ id: `summary:${e.messageId}`, type: 'summary', startFloor: e.floor, endFloor: e.floor,
        text: `[RECENT_SUMMARY_${e.floor}]\n历史膨胀内容${'合成剧情'.repeat(140)}` }));
    f.store.current().injectionSnapshot = { signature: JSON.stringify([true, true, INJECTION_MODES.CHECKPOINT_BOUNDARY]),
        blocks: legacyBlocks, value: `<CACHE_MEMORY>\n${legacyBlocks.map(b => b.text).join('\n')}\n</CACHE_MEMORY>`, needsRebuild: true };
    f.chat[13].mes = '当前选中的全新正文14';
    const originalChat = structuredClone(f.chat), raw = structuredClone(f.store.current());
    const effective = f.store.effectiveStore(f.chat);
    assert.equal(Object.keys(effective.summaries).length, 237);
    assert.equal(effective.checkpoints.length, 46); assert.equal(effective.longMemories.length, 3);
    assert.deepEqual(effective.summaryRepairRanges, [{ startFloor: 11, endFloor: 15 }]);
    assert.deepEqual(f.store.current(), raw);
    const value = refreshSnapshot(f.store.current(), settings, 'chat changed', effective).value;
    assert.equal(f.store.current().injectionSnapshot.value, value);
    assert.equal((value.match(/RECENT_SUMMARY_/g) ?? []).length, 4);
    assert.doesNotMatch(value, /废弃 Swipe|旧 Swipe|历史膨胀内容/);
    assert.match(value, /城门永久毁坏/); assert.match(value, /乙未知/);
    assert.match(value, /不可逆重大历史51/); assert.match(value, /重大阶段历史231/);
    assert.ok(value.length < raw.injectionSnapshot.value.length / 10);
    for (let n = 0; n < 10; n++) {
        assert.equal(refreshSnapshot(f.store.current(), settings, 'new summary', f.store.effectiveStore(f.chat)).value, value);
        assert.equal(refreshSnapshot(f.store.current(), settings, 'chat changed', f.store.effectiveStore(f.chat)).value, value);
    }
    const dynamic = buildInjection(effective, normalizeSettings({ strictCacheMode: false, injectionMode: INJECTION_MODES.LONG_CHECKPOINT_RECENT }));
    assert.equal((dynamic.match(/RECENT_SUMMARY_/g) ?? []).length, 7); // Four local sources + the three newest uncovered floors.
    assert.match(dynamic, /不可逆重大历史51/); assert.doesNotMatch(dynamic, /废弃 Swipe|旧 Swipe/);
    assert.deepEqual(f.chat, originalChat); assert.equal(f.requests.length, 0);
    // Unverifiable legacy cascade flags are never permission to replay every
    // Summary, even when the old broad range was persisted/imported.
    const unknown = structuredClone(raw);
    unknown.sourceFallbackRanges = [{ startFloor: 1, endFloor: 238 }];
    for (const cp of unknown.checkpoints) { delete cp.summaryIds; delete cp.sourceVersions; }
    const metadata = { cache_memory: unknown };
    const legacy = new MemoryStore({ getMetadata: () => metadata, getChatId: () => 'a', saveMetadata() {} });
    const { sourceFallbackSummaries } = await import('../src/continuity.js');
    assert.equal(sourceFallbackSummaries(unknown).length, 0);
    assert.equal(sourceFallbackSummaries(legacy.effectiveStore(f.chat)).length, 4);
});

test('confirmed matching alternate becomes the sole current Summary; unrelated partial-load records remain untouched', async () => {
    const f = fixture(), entry = getAssistantMessages(f.chat)[0], current = structuredClone(f.store.getSummary(entry.messageId));
    f.store.current().summaries[entry.messageId].sourceContentFingerprint = 'old-body';
    f.store.current().summaries[entry.messageId].event = '废弃正文摘要';
    f.store.current().summaries['matching-copy'] = { ...current, messageId: 'matching-copy' };
    f.store.current().summaries.unknown = { messageId: 'unknown', floor: 1, messageIndex: 0, event: '未确认的导入记录', status: 'frozen' };
    f.seed();
    assert.equal(f.store.currentSummaries(f.chat)[0].event, current.event);
    assert.equal(f.store.hasSupersededRecords(f.chat, { aggregates: false }), true);
    await f.persistence.commitReplacement(f.store, () => f.store.cleanupSuperseded(f.chat, { aggregates: false }));
    assert.equal(f.remote.summaries[entry.messageId].event, current.event);
    assert.equal(f.remote.summaries['matching-copy'], undefined); assert.ok(f.remote.summaries.unknown);
    assert.equal(f.store.hasSupersededRecords(f.chat, { aggregates: false }), false);
    assert.equal(f.store.hasSupersededRecords([], { aggregates: false }), false);
});

test('same-ID edit immediately leaves effective memory even when the replacement save fails', async () => {
    const { refreshSnapshot } = await import('../src/cache-control.js');
    const f = fixture(), entries = getAssistantMessages(f.chat), entry = entries[0], settings = normalizeSettings();
    f.store.current().checkpoints = [{ id: 'cp', startFloor: 1, endFloor: 5, content: '仅属于旧正文的剧情', status: 'frozen',
        summaryIds: entries.map(e => e.messageId), sourceVersions: Object.fromEntries(entries.map(e => [e.messageId, summaryVersion(f.store.getSummary(e.messageId))])) }];
    refreshSnapshot(f.store.current(), settings, 'manual reinject', f.store.effectiveStore(f.chat));
    f.seed(); f.chat[0].mes = '完全不同的当前正文';
    const value = refreshSnapshot(f.store.current(), settings, 'chat changed', f.store.effectiveStore(f.chat)).value;
    assert.doesNotMatch(value, /仅属于旧正文|当前摘要1\b/);
    f.seed(); // The immediate injection invalidation has already been saved.
    f.fail = true;
    await assert.rejects(f.summarizer.summarizeMessage(entry.messageId, { deferAggregates: true }), { code: 'SAVE_UNCONFIRMED' });
    assert.equal(f.store.currentSummaries(f.chat).some(row => row.floor === 1), false);
    assert.ok(f.persistence.pending.get('a').replacementFallback.summaries[entry.messageId]);
    assert.equal(f.persistence.storage.getItem('cache_memory_replacement_backup_v1:a'), undefined);
    f.fail = false; await f.persistence.flush();
    assert.equal(Object.values(f.remote.summaries).filter(row => row.floor === 1).length, 1);
    assert.equal(f.remote.summaries[entry.messageId].event, '新版摘要正文');
    assert.equal(f.persistence.pending.size, 0); assert.equal(f.persistence.replacementStores.size, 0);
});

test('a KEEP-only frozen snapshot drops a proven old source, but a partial load does not erase published memory', async () => {
    const { refreshSnapshot } = await import('../src/cache-control.js');
    const f = fixture(), entry = getAssistantMessages(f.chat)[0], settings = normalizeSettings();
    f.store.current().keepRegistry['KEEP-0001'] = { text: '只属于当前正文的秘密', sourceId: entry.messageId, sourceFloor: 1, status: 'active' };
    const value = refreshSnapshot(f.store.current(), settings, 'manual reinject', f.store.effectiveStore(f.chat)).value;
    assert.match(value, /只属于当前正文的秘密/);
    assert.equal(f.store.current().injectionSnapshot.value, value);
    const partial = f.store.effectiveStore([]);
    assert.equal(refreshSnapshot(f.store.current(), settings, 'chat changed', partial).value, value);
    f.chat[0].mes = 'Swipe 改变了第一层正文';
    const next = refreshSnapshot(f.store.current(), settings, 'chat changed', f.store.effectiveStore(f.chat)).value;
    assert.doesNotMatch(next, /只属于当前正文的秘密/);
    assert.equal(refreshSnapshot(f.store.current(), settings, 'chat changed', f.store.effectiveStore(f.chat)).changed, false);
});

test('same-body regeneration, metadata rebinding and reparsing cannot retire frozen CP/Long history', async () => {
    const { aggregateVersion } = await import('../src/memory-store.js');
    const f = fixture(), entries = getAssistantMessages(f.chat), first = entries[0];
    const sources = Object.fromEntries(entries.map(e => [e.messageId, summaryVersion(f.store.getSummary(e.messageId))]));
    f.store.current().checkpoints = [{ id: 'cp', startFloor: 1, endFloor: 5, content: '重大事件：甲知情，乙未知',
        summaryIds: entries.map(e => e.messageId), sourceVersions: sources, status: 'frozen' }];
    f.store.current().longMemories = [{ id: 'long', startFloor: 1, endFloor: 5, content: '永久技能与重大历史',
        checkpointIds: ['cp'], checkpointVersions: { cp: aggregateVersion(f.store.current().checkpoints[0]) }, sourceVersions: sources, status: 'frozen' }];
    f.store.current().keepRegistry['KEEP-0001'] = { text: '仍然有效的秘密', sourceId: first.messageId, sourceFloor: 1, status: 'active' };
    f.seed();
    await f.persistence.commitReplacement(f.store, () => f.store.addSummary({ ...f.store.getSummary(first.messageId),
        event: '同一正文重新整理摘要', sourceFingerprint: 'ST metadata changed' }, { overwrite: true, entry: first }));
    assert.equal(f.remote.checkpoints[0].sourceReplaced, undefined);
    assert.equal(f.remote.longMemories[0].sourceReplaced, undefined);
    assert.ok(f.remote.keepRegistry['KEEP-0001']);
    const effective = f.store.effectiveStore(f.chat);
    assert.equal(effective.checkpoints.length, 1); assert.equal(effective.longMemories.length, 1);
    assert.equal(f.requests.length, 0);
});

test('real-shaped legacy flags and hash drift keep four Longs; only two proven old-body stages need local current summaries', async () => {
    const { aggregateVersion } = await import('../src/memory-store.js');
    const { refreshSnapshot } = await import('../src/cache-control.js');
    const { memoryOverviewStats } = await import('../src/ui.js');
    const f = fixture(238), entries = getAssistantMessages(f.chat), settings = normalizeSettings();
    const flagged = new Set([3, 30, 31, 37, 39, 41, 42, 43, 44, 45]);
    for (let n = 1; n <= 47; n++) {
        const sources = entries.slice((n - 1) * 5, n * 5);
        f.store.current().checkpoints.push({ id: `cp-${n}`, startFloor: (n - 1) * 5 + 1, endFloor: n * 5,
            content: `[CHECKPOINT]\n[Current State]\n重大历史${n}；甲知道秘密，乙不知道`, status: 'frozen', previousCheckpointId: n > 1 ? `cp-${n - 1}` : '',
            summaryIds: sources.map(e => e.messageId), sourceVersions: Object.fromEntries(sources.map(e => [e.messageId, summaryVersion(f.store.getSummary(e.messageId))])),
            ...(flagged.has(n) ? { sourceReplaced: true } : {}) });
    }
    for (let n = 0; n < 4; n++) {
        const cps = f.store.current().checkpoints.slice(n * 10, n * 10 + 10);
        f.store.current().longMemories.push({ id: `long-${n}`, startFloor: n * 50 + 1, endFloor: n * 50 + 50,
            content: `不可逆重大历史${n}；认知差、永久技能保留`, status: 'frozen', sourceReplaced: true,
            sourceVersions: Object.fromEntries(entries.slice(n * 50, n * 50 + 50).map(e => [e.messageId, summaryVersion(f.store.getSummary(e.messageId))])),
            checkpointIds: cps.map(cp => cp.id), checkpointVersions: Object.fromEntries(cps.map(cp => [cp.id, aggregateVersion(cp)])) });
    }
    // Summary hashes drift although the assistant bodies remain byte-for-byte identical.
    for (const floor of [14, 148, 152, 185, 191, 202, 207, 209, 210, 211, 217, 221]) f.store.getSummary(entries[floor - 1].messageId).event += '（重新解析后的字段）';
    for (const floor of [207, 220]) {
        const current = f.store.getSummary(entries[floor - 1].messageId), oldId = `legacy-old-${floor}`;
        f.store.current().summaries[oldId] = { ...structuredClone(current), messageId: oldId,
            sourceMessageKey: oldId, sourceContentFingerprint: `old-body-${floor}`, event: `废弃 Swipe 剧情${floor}` };
        const cp = f.store.current().checkpoints[Math.floor((floor - 1) / 5)];
        cp.summaryIds.push(oldId); cp.sourceVersions[oldId] = summaryVersion(f.store.getSummary(oldId));
    }
    const previousChat = structuredClone(f.chat);
    f.store.current().injectionSnapshot = { signature: JSON.stringify([true, true, INJECTION_MODES.CHECKPOINT_BOUNDARY, 1]), blocks: [], value: '旧膨胀快照' };
    const effective = f.store.effectiveStore(f.chat);
    assert.equal(effective.longMemories.length, 4);
    assert.equal(effective.checkpoints.length, 45);
    assert.deepEqual(effective.summaryRepairRanges, [{ startFloor: 206, endFloor: 210 }, { startFloor: 216, endFloor: 220 }]);
    const value = refreshSnapshot(f.store.current(), settings, 'chat changed', effective).value;
    const blocks = f.store.current().injectionSnapshot.blocks;
    assert.equal(blocks.filter(b => b.type === 'long').length, 4);
    assert.equal(blocks.filter(b => b.type === 'checkpoint').length, 5);
    assert.equal(blocks.filter(b => b.type === 'summary').length, 10);
    assert.equal(memoryOverviewStats(f.store.current(), entries, settings).injectedCheckpoints, 5);
    assert.doesNotMatch(value, /废弃 Swipe/);
    assert.match(value, /不可逆重大历史0/); assert.match(value, /重大历史47/);
    assert.match(value, /当前摘要208/); assert.match(value, /甲知道秘密，乙不知道/);
    for (let i = 0; i < 3; i++) {
        assert.equal(refreshSnapshot(f.store.current(), settings, 'new summary', f.store.effectiveStore(f.chat)).value, value);
        assert.equal(refreshSnapshot(f.store.current(), settings, 'chat changed', f.store.effectiveStore(f.chat)).value, value);
    }
    f.seed(); await f.persistence.commitReplacement(f.store, () => f.store.cleanupSuperseded(f.chat));
    assert.equal(Object.keys(f.remote.summaries).length, 238);
    assert.equal(f.remote.summaries['legacy-old-207'], undefined);
    assert.equal(f.remote.summaries['legacy-old-220'], undefined);
    assert.equal(f.persistence.pending.size, 0); assert.equal(f.requests.length, 0);
    assert.deepEqual(f.chat, previousChat);
});

test('legacy positional cleanup waits for complete loaded slots and server confirmation; missing current summaries survive', async () => {
    const f = fixture(10), entries = getAssistantMessages(f.chat);
    const old = { ...structuredClone(f.store.getSummary(entries[0].messageId)), messageId: 'lost-swipe-key',
        sourceMessageKey: 'lost-swipe-key', sourceContentFingerprint: 'old-body' };
    f.store.current().summaries[old.messageId] = old;
    const last = f.store.getSummary(entries[9].messageId);
    last.sourceContentFingerprint = 'unselected-last-body';
    f.seed();
    await f.persistence.commitReplacement(f.store, () => f.store.cleanupSuperseded(f.chat.slice(0, 5)));
    assert.ok(f.remote.summaries[old.messageId]); assert.ok(f.remote.summaries[last.messageId]);
    f.fail = true;
    await assert.rejects(f.persistence.commitReplacement(f.store, () => f.store.cleanupSuperseded(f.chat)), { code: 'SAVE_UNCONFIRMED' });
    assert.ok(f.remote.summaries[old.messageId]); assert.ok(f.store.getSummary(old.messageId));
    f.fail = false; assert.equal((await f.persistence.flush()).state, 'confirmed');
    assert.equal(f.remote.summaries[old.messageId], undefined);
    assert.ok(f.remote.summaries[last.messageId]);
    assert.equal(f.persistence.pending.size, 0); assert.equal(f.requests.length, 0);
});

test('unloaded sources cannot clear ambiguous legacy flags just because Summary text was reparsed', () => {
    const f = fixture(), entry = getAssistantMessages(f.chat)[0], record = f.store.getSummary(entry.messageId);
    f.store.current().checkpoints = [{ id: 'cp', startFloor: 1, endFloor: 5, previousCheckpointId: 'prior',
        sourceVersions: { [entry.messageId]: summaryVersion(record) }, sourceReplaced: true, content: '归属尚不可验证', status: 'frozen' }];
    record.event += '（哈希变化）';
    assert.equal(f.store.effectiveStore([]).checkpoints.length, 0);
    assert.equal(f.store.current().checkpoints[0].sourceReplaced, true);
});

test('diagnostic CP count ignores inner structured headers, including text-only old snapshots', async () => {
    const { memoryOverviewStats } = await import('../src/ui.js');
    const raw = createEmptyStore('a'), settings = normalizeSettings();
    raw.injectionSnapshot = { value: '[CHECKPOINT_041 | 第201-205层]\n[CHECKPOINT]\n内容\n[CHECKPOINT_043 | 第211-215层]\n[CHECKPOINT]\n内容', blocks: [] };
    assert.equal(memoryOverviewStats(raw, [], settings).injectedCheckpoints, 2);
    raw.injectionSnapshot.value = '[LATEST_CHECKPOINT]\n[CHECKPOINT]\n内容';
    assert.equal(memoryOverviewStats(raw, [], settings).injectedCheckpoints, 1);
});

test('upgrade waits for loaded source slots before rebuilding frozen bytes, then rebuilds exactly once', async () => {
    const { refreshSnapshot } = await import('../src/cache-control.js');
    const f = fixture(10), entries = getAssistantMessages(f.chat), settings = normalizeSettings();
    f.store.current().checkpoints = [{ id: 'cp', startFloor: 1, endFloor: 5, content: '有效历史', status: 'frozen',
        sourceReplaced: true, summaryIds: entries.slice(0, 5).map(e => e.messageId),
        sourceVersions: Object.fromEntries(entries.slice(0, 5).map(e => [e.messageId, 's2:metadata-drift'])) }];
    f.store.current().injectionSnapshot = { signature: JSON.stringify([true, true, INJECTION_MODES.CHECKPOINT_BOUNDARY, 1]),
        blocks: [], value: '<CACHE_MEMORY>已冻结内容</CACHE_MEMORY>' };
    const previous = structuredClone(f.store.current().injectionSnapshot);
    const partial = refreshSnapshot(f.store.current(), settings, 'chat changed', f.store.effectiveStore([]));
    assert.equal(partial.skipped, true); assert.deepEqual(f.store.current().injectionSnapshot, previous);
    const full = refreshSnapshot(f.store.current(), settings, 'chat changed', f.store.effectiveStore(f.chat));
    assert.match(full.value, /有效历史/); assert.equal(full.changed, true);
    assert.equal(refreshSnapshot(f.store.current(), settings, 'chat changed', f.store.effectiveStore(f.chat)).changed, false);
    assert.equal(refreshSnapshot(f.store.current(), settings, 'chat changed', f.store.effectiveStore([])).value, full.value);
});
