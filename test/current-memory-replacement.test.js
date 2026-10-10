import test from 'node:test';
import assert from 'node:assert/strict';
import { MemoryStore, createEmptyStore, summaryVersion } from '../src/memory-store.js';
import { MemorySummarizer } from '../src/summarizer.js';
import { MemoryPersistenceCoordinator } from '../src/persistence.js';
import { normalizeSettings } from '../src/defaults.js';
import { getAssistantMessages } from '../src/utils.js';

function fixture(count = 5, authority = false) {
    const chat = Array.from({ length: count }, (_, i) => ({ name: 'A', mes: `当前正文${i + 1}`, send_date: `d${i}`, gen_started: `g${i}` }));
    const metadata = { cache_memory: createEmptyStore('a') };
    const store = new MemoryStore({ getMetadata: () => metadata, getChatId: () => 'a', saveMetadata() {} });
    for (const e of getAssistantMessages(chat)) store.current().summaries[e.messageId] = { messageId: e.messageId,
        floor: e.floor, messageIndex: e.messageIndex, sourceFingerprint: e.fingerprint, sourceContentFingerprint: e.contentFingerprint,
        sourceMessageKey: e.sourceMessageKey, event: `当前摘要${e.floor}`, frozen: true, status: 'frozen' };
    let remote = structuredClone(store.current()), fail = false, duringWrite = () => {};
    const persistence = new MemoryPersistenceCoordinator({ getChatId: () => 'a', getMetadata: () => metadata,
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
    assert.equal(f.store.current().checkpoints[0].summaryIds[0], entry.messageId);
    assert.equal(f.store.current().keepRegistry['KEEP-0001'].sourceId, entry.messageId);
    assert.equal(f.store.current().stateOverrides.override.sourceId, entry.messageId);
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
    delete record.sourceFingerprint; delete record.sourceContentFingerprint; f.seed();
    for (let i = 0; i < 3; i++) { f.store.syncMessages(f.chat); await f.summarizer.summarizeLatest(); }
    assert.equal(f.requests.length, 0); assert.equal(Object.keys(f.store.current().summaries).length, 5);
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

test('a replaced source cannot leak through an existing previous-Checkpoint chain into later generation', async () => {
    const f = fixture(10), entries = getAssistantMessages(f.chat);
    f.store.current().checkpoints = [
        { id: 'cp-1', startFloor: 1, endFloor: 5, memoryKind: 'state', content: '旧第一阶段剧情', status: 'frozen', summaryIds: entries.slice(0, 5).map(e => e.messageId) },
        { id: 'cp-2', startFloor: 6, endFloor: 10, memoryKind: 'state', content: '旧后续阶段剧情', status: 'frozen', previousCheckpointId: 'cp-1' },
    ];
    f.store.current().longMemories = [{ id: 'long-1', startFloor: 1, endFloor: 10, content: '旧长期剧情', checkpointIds: ['cp-1', 'cp-2'], status: 'frozen' }];
    f.seed(); f.chat[0].mes = '第一层明确的新剧情';
    await f.summarizer.summarizeMessage(entries[0].messageId, { deferAggregates: true });
    assert.ok(f.store.current().checkpoints.every(row => row.sourceReplaced));
    await assert.rejects(f.summarizer.generateLongMemory(f.store.current().checkpoints, { overwrite: true }), /来源 Checkpoint/);
    const result = await f.summarizer.fillMissingMemories();
    assert.equal(result.failed, 0); assert.equal(result.created, 2);
    assert.ok(f.store.current().checkpoints.every(row => !row.sourceReplaced));
    assert.doesNotMatch(f.requests.at(-1).userContent, /旧第一阶段剧情|旧后续阶段剧情|旧长期剧情/);
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
