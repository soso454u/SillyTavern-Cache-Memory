import test from 'node:test';
import assert from 'node:assert/strict';
import { createEmptyStore, normalizeStore, MemoryStore, memoryContentDigest, memoryHealth } from '../src/memory-store.js';
import { MemorySummarizer } from '../src/summarizer.js';
import { MemoryPersistenceCoordinator } from '../src/persistence.js';
import { normalizeSettings } from '../src/defaults.js';
import { getAssistantMessages } from '../src/utils.js';
import { isUsableMemory } from '../src/continuity.js';
import { memoryOverviewStats } from '../src/ui.js';
import { threeWayMerge } from '../server-plugin/cache-memory-memory/index.mjs';

function fixture(count = 15, complete = async () => ({ content: '[CHECKPOINT]\n[Current State]\n合成阶段内容' })) {
    const chat = Array.from({ length: count }, (_, i) => ({ name: '合成角色', mes: `原始正文 ${i + 1}`, gen_started: `g${i}` }));
    const metadata = { cache_memory: createEmptyStore('a') };
    const store = new MemoryStore({ getMetadata: () => metadata, getChatId: () => 'a', saveMetadata() {} });
    for (const entry of getAssistantMessages(chat)) metadata.cache_memory.summaries[entry.messageId] = {
        messageId: entry.messageId, floor: entry.floor, messageIndex: entry.messageIndex,
        sourceFingerprint: entry.fingerprint, sourceContentFingerprint: entry.contentFingerprint,
        event: `冻结摘要 ${entry.floor}`, status: 'frozen', frozen: true,
    };
    const calls = [], warnings = [];
    const summarizer = new MemorySummarizer({ store, getChat: () => chat, getSettings: () => normalizeSettings(),
        onStatus: (_, message) => warnings.push(message), apiClient: { complete: async request => { calls.push(request); return complete(request); } } });
    return { chat, metadata, store, summarizer, calls, warnings };
}

test('the reported six source flags keep all 205 summaries usable and floor 14 cannot block CP 11–15', async () => {
    const f = fixture(207);
    for (const row of Object.values(f.metadata.cache_memory.summaries)) {
        if ([14, 148, 152, 185, 191, 202].includes(row.floor)) Object.assign(row, { status: 'stale', sourceValidity: 'changed' });
        if (row.floor > 205) Object.assign(row, { status: 'failed', frozen: false, error: 'Unauthorized' });
    }
    f.metadata.cache_memory.checkpoints = [1, 6].map(start => ({ id: `cp-${start}`, startFloor: start, endFloor: start + 4,
        content: `冻结阶段 ${start}`, status: 'stale', sourceValidity: 'changed', invalidSourceIds: ['old-task-source'] }));
    f.chat[13].mes = '原始正文   14\n'; // Formatting alone is not a replacement.
    f.store.syncMessages(f.chat);
    const overview = memoryOverviewStats(f.store.current(), getAssistantMessages(f.chat), normalizeSettings());
    assert.deepEqual(overview.summaries, { actual: 205, generated: 205, expected: 207 });
    assert.deepEqual(overview.summaryDetails.map(row => row.floor), [206, 207]);
    assert.doesNotMatch(overview.issues.join('\n'), /来源消息或版本|需要更新/);
    assert.equal(f.summarizer.getCheckpointUpdatePlan().length, 0);
    const cp = await f.summarizer.generateCheckpoint(11, 15);
    assert.equal(cp.status, 'frozen'); assert.equal(f.calls.length, 1);
    assert.match(f.calls[0].userContent, /冻结摘要 14/);
    assert.ok(!f.warnings.some(message => /缺失摘要/.test(message)));
    const long = await f.summarizer.generateLongMemory(f.store.current().checkpoints);
    assert.equal(long.status, 'frozen'); assert.equal(f.calls.length, 2);
    assert.equal(f.store.current().checkpoints[0].content, '冻结阶段 1');
});

test('legacy flags restore frozen/manual records without changing content, failed records or injection bytes', () => {
    const data = createEmptyStore('a');
    data.summaries.a = { messageId: 'a', floor: 1, event: '用户的原文', status: 'stale', previousStatus: 'manual-edited', frozen: true, sourceValidity: 'changed' };
    data.summaries.b = { messageId: 'b', floor: 2, status: 'failed', frozen: false, error: 'Unauthorized', sourceValidity: 'changed' };
    data.summaries.c = { messageId: 'c', floor: 3, status: 'orphaned', frozen: true };
    data.checkpoints = [{ id: 'cp', startFloor: 1, endFloor: 5, content: '阶段原文', status: 'stale', staleReason: '旧检查', invalidSourceVersions: { a: 'v1' } }];
    data.injectionSnapshot = { value: '严格缓存冻结字节', blocks: [] };
    data.recovery = { obsolete: { snapshot: structuredClone(data) } };
    const normalized = normalizeStore(data, 'a');
    assert.equal(normalized.summaries.a.status, 'manual-edited'); assert.equal(normalized.summaries.a.event, '用户的原文');
    assert.equal(memoryHealth(normalized.summaries.a).code, 'valid');
    assert.equal(isUsableMemory(normalized.summaries.b), false); assert.equal(normalized.summaries.b.error, 'Unauthorized');
    assert.equal(isUsableMemory(normalized.summaries.c), false);
    assert.equal(normalized.checkpoints[0].content, '阶段原文'); assert.equal(normalized.checkpoints[0].invalidSourceVersions, undefined);
    assert.equal(normalized.injectionSnapshot.value, '严格缓存冻结字节'); assert.equal(normalized.recovery, undefined);
    assert.equal(memoryContentDigest(normalizeStore(structuredClone(normalized), 'a')), memoryContentDigest(normalized));
});

test('only an explicit selection regenerates an existing frozen CP; repeated edits do not accumulate copies', async () => {
    const f = fixture(5);
    f.store.addCheckpoint({ id: 'cp', startFloor: 1, endFloor: 5, content: '用户旧阶段', status: 'frozen' });
    f.store.revalidate(f.chat);
    await f.summarizer.updateCheckpoints(); assert.equal(f.calls.length, 0);
    const result = await f.summarizer.updateCheckpoints({ ids: ['cp'] });
    assert.equal(result.created, 1); assert.equal(f.calls.length, 1);
    for (let n = 0; n < 30; n++) f.store.updateAggregate('checkpoint', 'cp', { content: `当前版本 ${n}` });
    assert.equal(f.store.current().checkpoints[0].content, '当前版本 29'); assert.equal(f.store.current().recovery, undefined);
    assert.doesNotMatch(JSON.stringify(f.store.current()), /用户旧阶段|当前版本 28/);
});

test('removing persistent source checks still rejects a source mutation during a running CP request', async () => {
    let resolve;
    const response = new Promise(done => { resolve = done; });
    const f = fixture(5, () => response);
    const pending = f.summarizer.generateCheckpoint(1, 5);
    const rejection = assert.rejects(pending, { code: 'SOURCE_CHANGED' });
    f.chat[0].mes = '请求期间改变了输入';
    resolve({ content: '[CHECKPOINT]\n过期输出' });
    await rejection;
    assert.equal(f.store.current().checkpoints.length, 0);
    assert.ok(Object.values(f.store.current().summaries).every(isUsableMemory));
});

for (const authority of [false, true]) test(`saving an otherwise identical current version removes server archives (authority=${authority})`, async () => {
    let remote = createEmptyStore('a'), writes = 0;
    remote.recovery = { huge: { content: '旧备份'.repeat(10000) } };
    const metadata = { cache_memory: structuredClone(remote) };
    const p = new MemoryPersistenceCoordinator({ getChatId: () => 'a', getMetadata: () => metadata,
        readRemoteStore: async () => structuredClone(remote), saveMetadata: async () => { writes++; remote = structuredClone(metadata.cache_memory); },
        ...(authority ? { readAuthoritativeStore: async () => ({ revision: remote.sync.revision, store: structuredClone(remote) }),
            commitAuthoritative: async (_, payload) => {
                // Simulate the previous server plugin's per-record comparison:
                // archives must occur only in base, so its deletion is explicit.
                assert.deepEqual(payload.baseSnapshot.recovery, remote.recovery);
                assert.equal(payload.snapshot.recovery, undefined);
                writes++; remote = structuredClone(payload.snapshot);
                return { record: { revision: remote.sync.revision, store: structuredClone(remote) } };
            } } : {}),
    });
    p.activate('a', metadata.cache_memory); p.enqueue(metadata.cache_memory, 'store migration');
    assert.equal((await p.flush()).state, 'confirmed');
    assert.equal(writes, 1); assert.equal(remote.recovery, undefined); assert.equal(p.pending.size, 0);
});

test('server three-way merge discards old archives without creating conflicts or removing current memory', () => {
    const remote = createEmptyStore('a'); remote.recovery = { a: { snapshot: 'old' } };
    remote.summaries.a = { messageId: 'a', floor: 1, event: '当前内容', status: 'frozen' };
    const base = structuredClone(remote), local = structuredClone(remote); delete base.recovery; delete local.recovery;
    const result = threeWayMerge(base, local, remote);
    assert.equal(result.conflicts.length, 0); assert.equal(result.merged.recovery, undefined);
    assert.equal(result.merged.summaries.a.event, '当前内容');
});

test('a swallowed archive-cleanup write cannot report confirmed while the server still contains backups', async () => {
    const remote = createEmptyStore('a'); remote.recovery = { old: { content: 'old copy' } };
    const metadata = { cache_memory: structuredClone(remote) };
    const p = new MemoryPersistenceCoordinator({ getChatId: () => 'a', getMetadata: () => metadata,
        readRemoteStore: async () => structuredClone(remote), saveMetadata: async () => {} });
    p.activate('a', metadata.cache_memory); p.enqueue(metadata.cache_memory, 'store migration');
    assert.equal((await p.flush()).state, 'failed'); assert.equal(p.pending.size, 1);
    assert.match(p.getState().detail, /清理尚未确认/);
});
