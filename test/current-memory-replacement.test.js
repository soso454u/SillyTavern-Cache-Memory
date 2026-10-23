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
    const persistence = new MemoryPersistenceCoordinator({ retryDelay: async () => {}, storage, getChatId: () => 'a', getMetadata: () => metadata,
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
    const summarizer = new MemorySummarizer({ store, getChat: () => chat, getSettings: () => normalizeSettings({ injectionMode: 'checkpoint_boundary' }),
        getPersistenceState: () => persistence.getState(), flushMemory: () => persistence.flush(),
        commitMemory: (mutate, active) => persistence.commitReplacement(store, mutate, active),
        apiClient: { complete: async request => { requests.push(request); return { content: request.systemPrompt.includes('[CHECKPOINT]')
            ? '[CHECKPOINT]\n[Current State]\n新版阶段正文' : request.systemPrompt.includes('[LONG_MEMORY]')
                ? '[STORY_ARC]\n新版长期剧情梗概。\n[LONG_MEMORY]\n新版长期正文\n[UPDATED_FACTS]\n无\n[RETIRED_FACTS]\n无' : '[SUMMARY]\n[Title]\n新版\n[Event]\n新版摘要正文\n[KEEP]\n无' }; } } });
    const seed = () => { remote = structuredClone(store.current()); persistence.pending.clear(); persistence.activate('a', store.current()); };
    return { chat, store, persistence, summarizer, requests, seed, get remote() { return remote; }, set fail(v) { fail = v; }, set duringWrite(fn) { duringWrite = fn; }, set remote(v) { remote = v; } };
}

for (const authority of [false, true]) test(`failed uploads retry three times without regenerating or exposing the replacement (authority=${authority})`, async () => {
    const f = fixture(1, authority), entry = getAssistantMessages(f.chat)[0];
    const original = structuredClone(f.store.getSummary(entry.messageId)), waits = [];
    let writes = 0;
    f.persistence.retryDelay = async ms => waits.push(ms);
    f.duringWrite = () => {
        writes++;
        f.fail = writes < 4;
        assert.deepEqual(f.store.getSummary(entry.messageId), original);
    };
    await f.summarizer.summarizeMessage(entry.messageId, { overwrite: true, deferAggregates: true });
    assert.equal(writes, 4); assert.deepEqual(waits, [2000, 5000, 10000]);
    assert.equal(f.requests.length, 1); assert.equal(f.persistence.getState().state, 'confirmed');
    assert.notEqual(f.store.getSummary(entry.messageId).event, original.event);
});

test('a previously failed server read is checked again automatically; a model response survives preflight retries', async () => {
    const f = fixture(1), entry = getAssistantMessages(f.chat)[0], read = f.persistence.readRemoteStore;
    let failures = 0; const waits = [];
    f.persistence.retryDelay = async ms => waits.push(ms);
    f.persistence.readRemoteStore = async (...args) => {
        if (++failures <= 3) throw new Error('服务器读取超时');
        return read(...args);
    };
    await f.summarizer.summarizeMessage(entry.messageId, { overwrite: true, deferAggregates: true });
    assert.deepEqual(waits, [2000, 5000, 10000]); assert.equal(f.requests.length, 1);
    assert.equal(f.persistence.getState().state, 'confirmed');
});

test('exhausted preflight retries preserve old memory and let a later click save the same generated result', async () => {
    const f = fixture(1), entry = getAssistantMessages(f.chat)[0], read = f.persistence.readRemoteStore;
    const original = structuredClone(f.store.getSummary(entry.messageId));
    let reads = 0;
    f.persistence.readRemoteStore = async () => { reads++; throw new Error('服务器读取超时'); };
    await assert.rejects(f.summarizer.summarizeMessage(entry.messageId, { overwrite: true, deferAggregates: true }), { code: 'SAVE_UNCONFIRMED' });
    assert.equal(reads, 4); assert.equal(f.requests.length, 1);
    assert.deepEqual(f.store.getSummary(entry.messageId), original);
    f.persistence.readRemoteStore = read;
    await f.summarizer.summarizeMessage(entry.messageId, { overwrite: true, deferAggregates: true });
    assert.equal(f.requests.length, 1); assert.equal(f.persistence.getState().state, 'confirmed');
});

test('a failed local record can be retried when the server has never stored any summary', async () => {
    const f = fixture(0);
    f.chat.push({ mes: '尚未上传过的正文', gen_started: 'new-source' });
    const entry = getAssistantMessages(f.chat)[0], resume = f.persistence.pauseSaves('a');
    f.store.addSummary({ messageId: entry.messageId, floor: entry.floor, status: 'failed', frozen: false, error: 'HTTP 504' });
    resume({ retryPending: false });
    assert.equal(Object.keys(f.remote.summaries).length, 0);
    await f.summarizer.summarizeMessage(entry.messageId, { overwrite: true, deferAggregates: true });
    assert.equal(f.requests.length, 1); assert.equal(f.persistence.getState().state, 'confirmed');
    assert.equal(f.remote.summaries[entry.messageId].status, 'frozen');
});

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
    await f.summarizer.summarizeMessage(entry.messageId, { overwrite: true, deferAggregates: true });
    assert.equal(f.store.getSummary(old.messageId), null); assert.equal(f.remote.summaries[old.messageId], undefined);
    assert.equal(Object.values(f.remote.summaries).filter(row => row.floor === 207).length, 1);
    assert.deepEqual(f.store.current().checkpoints[0].summaryIds, [old.messageId]);
    assert.equal(f.store.current().checkpoints[0].sourceVersions[old.messageId], summaryVersion(original));
    assert.ok(f.store.current().keepRegistry['KEEP-0001']);
    assert.deepEqual(f.store.current().stateOverrides.override, { sourceId: old.messageId, value: '用户状态' });
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
    await assert.rejects(f.summarizer.summarizeMessage(entry.messageId, { overwrite: true, deferAggregates: true }), { code: 'SAVE_UNCONFIRMED' });
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
    await assert.rejects(f.summarizer.summarizeMessage(e.messageId, { overwrite: true, deferAggregates: true }), { code: 'SAVE_UNCONFIRMED' });
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
    f.store.current().summaries = { 'earlier-matching-copy': { ...f.store.getSummary(current.messageId), messageId: 'earlier-matching-copy', event: '同正文的旧版摘要' }, ...f.store.current().summaries };
    f.seed();
    await f.persistence.commitReplacement(f.store, () => f.store.cleanupSuperseded(f.chat));
    assert.equal(f.remote.summaries['earlier-matching-copy'], undefined);
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
    await assert.rejects(f.summarizer.summarizeMessage(entry.messageId, { overwrite: true, deferAggregates: true }), { code: 'SOURCE_CHANGED' });
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

test('Summary cleanup never deletes or rewrites saved aggregates', async () => {
    const f = fixture(), summary = f.store.getSummary(getAssistantMessages(f.chat)[0].messageId);
    f.store.current().checkpoints = [
        { id: 'cp-current', startFloor: 1, endFloor: 5, content: '新版阶段', sourceVersions: { [summary.messageId]: summaryVersion(summary) }, status: 'frozen' },
        { id: 'cp-old', startFloor: 1, endFloor: 5, content: '旧阶段', sourceVersions: { [summary.messageId]: 'obsolete-version' }, status: 'frozen' },
        { id: 'uncertain-1', startFloor: 6, endFloor: 10, content: '无法判定甲', status: 'frozen' },
        { id: 'uncertain-2', startFloor: 6, endFloor: 10, content: '无法判定乙', status: 'frozen' },
    ]; f.seed();
    await f.persistence.commitReplacement(f.store, () => f.store.cleanupSuperseded(f.chat));
    assert.deepEqual(f.remote.checkpoints.map(row => row.id), ['cp-current', 'cp-old', 'uncertain-1', 'uncertain-2']);
    assert.equal(f.remote.tombstones['Checkpoint:cp-old'], undefined);
});


test('authoritative replacement keeps the old effective record until commit and readback, including a failed retry', async () => {
    const f = fixture(5, true), entry = getAssistantMessages(f.chat)[0], old = structuredClone(f.store.getSummary(entry.messageId));
    f.chat[0].mes = '明确的新正文'; f.fail = true;
    f.duringWrite = () => assert.deepEqual(f.store.getSummary(entry.messageId), old);
    await assert.rejects(f.summarizer.summarizeMessage(entry.messageId, { overwrite: true, deferAggregates: true }), { code: 'SAVE_UNCONFIRMED' });
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
    await assert.rejects(f.summarizer.summarizeMessage(getAssistantMessages(f.chat)[0].messageId, { overwrite: true, deferAggregates: true }), { code: 'SAVE_UNCONFIRMED' });
    assert.equal(f.persistence.getState().state, 'conflict');
    assert.equal(f.remote.summaries[old.messageId], undefined);
    assert.equal(f.remote.summaries['remote-current'].event, '另一设备当前剧情');
});

test('explicit Summary replacement leaves CP, Long, KEEP and manual state unchanged', async () => {
    const f = fixture(10), entry = getAssistantMessages(f.chat)[0];
    f.store.current().checkpoints = [{ id: 'cp-1', startFloor: 1, endFloor: 5, memoryKind: 'state', content: '完整阶段历史', status: 'frozen', summaryIds: [entry.messageId] }];
    f.store.current().longMemories = [{ id: 'long-1', startFloor: 1, endFloor: 10, content: '完整长期历史', checkpointIds: ['cp-1'], status: 'frozen' }];
    f.store.current().keepRegistry['KEEP-0001'] = { text: '独立历史秘密', sourceId: entry.messageId, status: 'active' };
    f.store.current().stateOverrides.user = { sourceId: entry.messageId, value: '用户手动状态' };
    f.seed(); const before = structuredClone(f.store.current()); f.chat[0].mes = '第一层明确的新剧情';
    await f.summarizer.summarizeMessage(entry.messageId, { overwrite: true, deferAggregates: true });
    for (const key of ['checkpoints', 'longMemories', 'keepRegistry', 'stateOverrides']) assert.deepEqual(f.remote[key], before[key]);
    assert.equal(f.remote.summaries[entry.messageId].event, '新版摘要正文');
    assert.equal(f.requests.length, 1);
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
    await assert.rejects(f.summarizer.summarizeMessage(entry.messageId, { overwrite: true, deferAggregates: true }), { code: 'SAVE_UNCONFIRMED' });
    await f.persistence.flush();
    assert.equal(writes, 0); assert.deepEqual(f.store.getSummary(entry.messageId), old); assert.deepEqual(f.remote.summaries[entry.messageId], old);
});

test('body edits and obsolete flags do not change memory eligibility, raw records or make automatic requests', async () => {
    const { refreshSnapshot } = await import('../src/cache-control.js');
    const f = fixture(10), entries = getAssistantMessages(f.chat), settings = normalizeSettings({ injectionMode: 'checkpoint_boundary' });
    f.store.current().checkpoints = [{ id: 'cp', startFloor: 6, endFloor: 10, content: '重大历史：城门永久毁坏；甲知道秘密但乙未知', status: 'frozen', sourceReplaced: true }];
    f.store.current().longMemories = [{ id: 'long', startFloor: 1, endFloor: 5, content: '已存长期历史', status: 'frozen', sourceReplaced: true }];
    f.store.current().keepRegistry['KEEP-0001'] = { text: '独立秘密及承诺', sourceFloor: 1, sourceInvalidated: true, status: 'active' };
    f.store.current().summaries[entries[0].messageId].status = 'orphaned';
    f.store.current().summaries[entries[0].messageId].sourceInvalidated = true;
    const value = refreshSnapshot(f.store.current(), settings, 'manual reinject', f.store.effectiveStore(f.chat)).value;
    f.seed(); const raw = structuredClone(f.store.current()); f.chat[0].mes = '切换到当前新正文';
    f.store.syncMessages(f.chat); f.store.revalidate(f.chat); f.store.reconcileDeletion([]);
    const effective = f.store.effectiveStore(f.chat);
    assert.deepEqual(f.store.current(), raw);
    assert.equal(Object.keys(effective.summaries).length, 10); assert.equal(effective.longMemories.length, 1);
    assert.equal(effective.checkpoints.length, 1); assert.ok(effective.keepRegistry['KEEP-0001']);
    for (const text of ['城门永久毁坏', '乙未知', '已存长期历史', '独立秘密及承诺']) assert.ok(value.includes(text));
    for (const reason of ['new summary', 'chat changed', 'history metadata changed']) assert.equal(refreshSnapshot(f.store.current(), settings, reason, effective).value, value);
    await f.summarizer.summarizeMessage(entries[0].messageId);
    assert.equal(f.requests.length, 0); assert.deepEqual(f.store.current(), raw);
});

test('only the explicitly replaced floor has its duplicates removed after readback without retaining a permanent replacement backup', async () => {
    const f = fixture(), entry = getAssistantMessages(f.chat)[0];
    f.store.current().summaries.duplicate = { ...structuredClone(f.store.getSummary(entry.messageId)), messageId: 'duplicate' };
    f.seed();
    await f.summarizer.summarizeMessage(getAssistantMessages(f.chat)[0].messageId, { overwrite: true, deferAggregates: true });
    assert.equal(f.remote.summaries.duplicate, undefined);
    assert.equal(f.persistence.storage.getItem('cache_memory_replacement_backup_v1:a'), undefined);
    assert.equal(f.persistence.pending.size, 0);
    assert.equal(f.persistence.replacementStores.size, 0);
    assert.equal(Object.values(f.remote.summaries).filter(row => row.floor === 1).length, 1);
});

test('238 floors retain all records and replace the inflated snapshot with Long coverage and seven uncovered CPs', async () => {
    const { refreshSnapshot } = await import('../src/cache-control.js');
    const { buildInjection } = await import('../src/injection.js');
    const { aggregateVersion } = await import('../src/memory-store.js');
    const f = fixture(238), entries = getAssistantMessages(f.chat), settings = normalizeSettings({ injectionMode: 'checkpoint_boundary' });
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
    assert.equal(Object.keys(effective.summaries).length, 238);
    assert.equal(effective.checkpoints.length, 47); assert.equal(effective.longMemories.length, 4);
    assert.equal(effective.summaryRepairRanges, undefined);
    assert.deepEqual(f.store.current(), raw);
    if (f.store.current().injectionSnapshot) assert.equal(refreshSnapshot(f.store.current(), settings, 'chat changed', effective).value, raw.injectionSnapshot.value);
    const value = refreshSnapshot(f.store.current(), settings, 'new checkpoint', effective).value;
    assert.equal(f.store.current().injectionSnapshot.value, value);
    assert.equal((value.match(/RECENT_SUMMARY_/g) ?? []).length, 0);
    assert.doesNotMatch(value, /历史膨胀内容/); assert.match(value, /旧 Swipe 的长期事实/);
    assert.match(value, /不可逆重大历史51/); assert.match(value, /重大阶段历史231/);
    assert.ok(value.length < raw.injectionSnapshot.value.length / 10);
    for (let n = 0; n < 10; n++) {
        assert.equal(refreshSnapshot(f.store.current(), settings, 'new summary', f.store.effectiveStore(f.chat)).value, value);
        assert.equal(refreshSnapshot(f.store.current(), settings, 'chat changed', f.store.effectiveStore(f.chat)).value, value);
    }
    const dynamic = buildInjection(effective, normalizeSettings({ strictCacheMode: false, injectionMode: INJECTION_MODES.LONG_CHECKPOINT_RECENT }));
    assert.equal((dynamic.match(/RECENT_SUMMARY_/g) ?? []).length, 0); // Only the explicit recent-tail mode includes floors 236–238.
    assert.match(dynamic, /不可逆重大历史51/); assert.match(dynamic, /旧 Swipe 的长期事实/);
    assert.deepEqual(f.chat, originalChat); assert.equal(f.requests.length, 0);
    // Unverifiable legacy cascade flags are never permission to replay every
    // Summary, even when the old broad range was persisted/imported.
    const unknown = structuredClone(raw);
    unknown.sourceFallbackRanges = [{ startFloor: 1, endFloor: 238 }];
    for (const cp of unknown.checkpoints) { delete cp.summaryIds; delete cp.sourceVersions; }
    const metadata = { cache_memory: unknown };
    const legacy = new MemoryStore({ getMetadata: () => metadata, getChatId: () => 'a', saveMetadata() {} });
    const noFallback = refreshSnapshot(legacy.current(), settings, 'manual reinject', legacy.effectiveStore(f.chat)).value;
    assert.doesNotMatch(noFallback, /RECENT_SUMMARY_/);
    assert.equal(legacy.current().injectionSnapshot.blocks.filter(b => b.type === 'long-story').length, 4);
    assert.equal(legacy.current().injectionSnapshot.blocks.filter(b => b.type === 'checkpoint').length, 7);
});

test('confirmed matching alternate becomes the sole current Summary; unrelated partial-load records remain untouched', async () => {
    const f = fixture(), entry = getAssistantMessages(f.chat)[0], current = structuredClone(f.store.getSummary(entry.messageId));
    f.store.current().summaries[entry.messageId].sourceContentFingerprint = 'old-body';
    f.store.current().summaries[entry.messageId].event = '废弃正文摘要';
    f.store.current().summaries['matching-copy'] = { ...current, messageId: 'matching-copy' };
    f.store.current().summaries.unknown = { messageId: 'unknown', floor: 1, messageIndex: 0, event: '未确认的导入记录', status: 'frozen' };
    f.seed();
    assert.equal(f.store.currentSummaries(f.chat)[0].event, '废弃正文摘要');
    await f.persistence.commitReplacement(f.store, () => f.store.cleanupSuperseded(f.chat, { aggregates: false }));
    assert.equal(f.remote.summaries[entry.messageId].event, current.event);
    assert.equal(f.remote.summaries['matching-copy'], undefined); assert.ok(f.remote.summaries.unknown);
});

test('same-ID edit keeps existing memory and frozen injection through a failed replacement save', async () => {
    const { refreshSnapshot } = await import('../src/cache-control.js');
    const f = fixture(), entries = getAssistantMessages(f.chat), entry = entries[0], settings = normalizeSettings({ injectionMode: 'checkpoint_boundary' });
    f.store.current().checkpoints = [{ id: 'cp', startFloor: 1, endFloor: 5, content: '仅属于旧正文的剧情', status: 'frozen',
        summaryIds: entries.map(e => e.messageId), sourceVersions: Object.fromEntries(entries.map(e => [e.messageId, summaryVersion(f.store.getSummary(e.messageId))])) }];
    refreshSnapshot(f.store.current(), settings, 'manual reinject', f.store.effectiveStore(f.chat));
    f.seed(); f.chat[0].mes = '完全不同的当前正文';
    const value = refreshSnapshot(f.store.current(), settings, 'chat changed', f.store.effectiveStore(f.chat)).value;
    assert.match(value, /仅属于旧正文/);
    f.seed(); // The immediate injection invalidation has already been saved.
    f.fail = true;
    await assert.rejects(f.summarizer.summarizeMessage(entry.messageId, { overwrite: true, deferAggregates: true }), { code: 'SAVE_UNCONFIRMED' });
    assert.equal(f.store.currentSummaries(f.chat).some(row => row.floor === 1), true);
    assert.ok(f.persistence.pending.get('a').replacementFallback.summaries[entry.messageId]);
    assert.equal(f.persistence.storage.getItem('cache_memory_replacement_backup_v1:a'), undefined);
    f.fail = false; await f.persistence.flush();
    assert.equal(Object.values(f.remote.summaries).filter(row => row.floor === 1).length, 1);
    assert.equal(f.remote.summaries[entry.messageId].event, '新版摘要正文');
    assert.equal(f.persistence.pending.size, 0); assert.equal(f.persistence.replacementStores.size, 0);
});

test('a KEEP-only frozen snapshot survives body edits and incomplete loading', async () => {
    const { refreshSnapshot } = await import('../src/cache-control.js');
    const f = fixture(), entry = getAssistantMessages(f.chat)[0], settings = normalizeSettings({ injectionMode: 'checkpoint_boundary' });
    f.store.current().keepRegistry['KEEP-0001'] = { text: '只属于当前正文的秘密', sourceId: entry.messageId, sourceFloor: 1, status: 'active' };
    const value = refreshSnapshot(f.store.current(), settings, 'manual reinject', f.store.effectiveStore(f.chat)).value;
    assert.match(value, /只属于当前正文的秘密/);
    assert.equal(f.store.current().injectionSnapshot.value, value);
    const partial = f.store.effectiveStore([]);
    assert.equal(refreshSnapshot(f.store.current(), settings, 'chat changed', partial).value, value);
    f.chat[0].mes = 'Swipe 改变了第一层正文';
    const next = refreshSnapshot(f.store.current(), settings, 'chat changed', f.store.effectiveStore(f.chat)).value;
    assert.equal(next, value);
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

test('real-shaped flags and old Swipe references retain all raw aggregates and uncovered stage coverage', async () => {
    const { aggregateVersion } = await import('../src/memory-store.js');
    const { refreshSnapshot } = await import('../src/cache-control.js');
    const { memoryOverviewStats } = await import('../src/ui.js');
    const f = fixture(238), entries = getAssistantMessages(f.chat), settings = normalizeSettings({ injectionMode: 'checkpoint_boundary' });
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
    assert.equal(effective.checkpoints.length, 47);
    assert.equal(effective.summaryRepairRanges, undefined);

    const value = refreshSnapshot(f.store.current(), settings, 'new checkpoint', effective).value;
    const blocks = f.store.current().injectionSnapshot.blocks;
    assert.equal(blocks.filter(b => b.type === 'long-story').length, 4);
    assert.equal(blocks.filter(b => b.type === 'checkpoint').length, 7);
    assert.equal(blocks.filter(b => b.type === 'summary').length, 0);
    assert.equal(memoryOverviewStats(f.store.current(), entries, settings).injectedCheckpoints, 7);
    assert.doesNotMatch(value, /废弃 Swipe/);
    assert.match(value, /不可逆重大历史0/); assert.match(value, /重大历史47/);
    assert.match(value, /甲知道秘密，乙不知道/);
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
    assert.equal(f.store.effectiveStore([]).checkpoints.length, 1);
    assert.equal(f.store.current().checkpoints[0].sourceReplaced, true);
});

test('diagnostic CP count ignores inner structured headers, including text-only old snapshots', async () => {
    const { memoryOverviewStats } = await import('../src/ui.js');
    const raw = createEmptyStore('a'), settings = normalizeSettings({ injectionMode: 'checkpoint_boundary' });
    raw.injectionSnapshot = { value: '[CHECKPOINT_041 | 第201-205层]\n[CHECKPOINT]\n内容\n[CHECKPOINT_043 | 第211-215层]\n[CHECKPOINT]\n内容', blocks: [] };
    assert.equal(memoryOverviewStats(raw, [], settings).injectedCheckpoints, 2);
    raw.injectionSnapshot.value = '[LATEST_CHECKPOINT]\n[CHECKPOINT]\n内容';
    assert.equal(memoryOverviewStats(raw, [], settings).injectedCheckpoints, 1);
});

test('upgrade rebuilds the old snapshot once without needing chat bodies', async () => {
    const { refreshSnapshot } = await import('../src/cache-control.js');
    const f = fixture(10), entries = getAssistantMessages(f.chat), settings = normalizeSettings({ injectionMode: 'checkpoint_boundary' });
    f.store.current().checkpoints = [{ id: 'cp', startFloor: 1, endFloor: 5, content: '有效历史', status: 'frozen',
        sourceReplaced: true, summaryIds: entries.slice(0, 5).map(e => e.messageId),
        sourceVersions: Object.fromEntries(entries.slice(0, 5).map(e => [e.messageId, 's2:metadata-drift'])) }];
    f.store.current().injectionSnapshot = { signature: JSON.stringify([true, true, INJECTION_MODES.CHECKPOINT_BOUNDARY, 1]),
        blocks: [], value: '<CACHE_MEMORY>已冻结内容</CACHE_MEMORY>' };
    f.seed(); let writes = 0; f.duringWrite = () => { writes++; };
    const previous = structuredClone(f.store.current());
    assert.equal(refreshSnapshot(f.store.current(), settings, 'chat changed', f.store.effectiveStore([])).value, previous.injectionSnapshot.value);
    const partial = refreshSnapshot(f.store.current(), settings, 'new checkpoint', f.store.effectiveStore([]));
    assert.equal(partial.changed, true); assert.equal(partial.migrated, true); assert.match(partial.value, /有效历史/);
    f.store.persist('injection snapshot');
    assert.equal((await f.persistence.flush()).state, 'confirmed');
    assert.equal(f.remote.injectionSnapshot.value, partial.value);
    for (const key of ['summaries', 'checkpoints', 'longMemories', 'keepRegistry']) assert.deepEqual(f.remote[key], previous[key]);
    await f.persistence.reread();
    const full = refreshSnapshot(f.store.current(), settings, 'chat changed', f.store.effectiveStore(f.chat));
    assert.match(full.value, /有效历史/); assert.equal(full.changed, false); assert.equal(full.migrated, undefined);
    assert.equal(writes, 1); assert.equal(f.requests.length, 0);
    assert.equal(refreshSnapshot(f.store.current(), settings, 'chat changed', f.store.effectiveStore(f.chat)).changed, false);
    assert.equal(refreshSnapshot(f.store.current(), settings, 'chat changed', f.store.effectiveStore([])).value, full.value);
});

test('changed assistant text clears only this Summary and replaces it after server confirmation', async () => {
    const f = fixture(), e = getAssistantMessages(f.chat)[0];
    f.store.current().checkpoints.push({ id: 'cp', startFloor: 1, endFloor: 5, content: '不变阶段', status: 'frozen' });
    f.store.current().longMemories.push({ id: 'long', startFloor: 1, endFloor: 5, content: '不变长期', status: 'frozen' });
    f.seed();
    f.chat[0].mes = '重新生成的新正文';
    const changed = getAssistantMessages(f.chat)[0];
    assert.equal(f.store.discardChangedSummary(changed, { previouslyDifferent: true }), true);
    assert.equal(f.store.getSummaryForEntry(changed), null);
    await f.persistence.flush();
    await f.summarizer.summarizeMessage(changed.messageId, { expectedFingerprint: changed.fingerprint, deferAggregates: true });
    assert.equal(Object.values(f.remote.summaries).filter(s => s.floor === 1).length, 1);
    assert.equal(f.remote.checkpoints[0].content, '不变阶段');
    assert.equal(f.remote.longMemories[0].content, '不变长期');
});
test('metadata-only change does not clear saved Summary', () => {
    const f = fixture(), prior = getAssistantMessages(f.chat)[0];
    f.chat[0].swipe_id = 2;
    assert.equal(getAssistantMessages(f.chat)[0].contentFingerprint, prior.contentFingerprint);
    assert.equal(f.store.discardChangedSummary(getAssistantMessages(f.chat)[0]), false);
});
test('deletion retires only selected message Summary', async () => {
    const f = fixture(), prior = getAssistantMessages(f.chat)[1];
    f.seed(); f.chat.splice(1, 1);
    assert.equal(f.store.discardDeletedSummary(prior), true);
    await f.persistence.flush();
    assert.equal(Object.keys(f.remote.summaries).length, 4);
    assert.equal(f.remote.summaries[prior.messageId], undefined);
});
