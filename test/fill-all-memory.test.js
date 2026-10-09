import test from 'node:test';
import assert from 'node:assert/strict';
import { MemoryStore } from '../src/memory-store.js';
import { MemorySummarizer } from '../src/summarizer.js';
import { normalizeSettings } from '../src/defaults.js';
import { getAssistantMessages } from '../src/utils.js';
import { CacheMemoryUI } from '../src/ui.js';

function fixture(count = 208) {
    const chat = Array.from({ length: count }, (_, i) => ({ name: 'A', mes: `正文${i + 1}`, gen_started: `g${i}` }));
    const metadata = {};
    const store = new MemoryStore({ getChatId: () => 'a', getMetadata: () => metadata, saveMetadata() {} });
    for (const entry of getAssistantMessages(chat)) store.current().summaries[entry.messageId] = {
        messageId: entry.messageId, floor: entry.floor, messageIndex: entry.messageIndex, sourceFingerprint: entry.fingerprint,
        sourceContentFingerprint: entry.contentFingerprint, sourceValidity: 'valid', event: `原摘要${entry.floor}`, status: 'frozen', frozen: true,
    };
    const calls = [];
    const summarizer = new MemorySummarizer({ store, getChat: () => chat, getSettings: () => normalizeSettings(),
        apiClient: { complete: async request => {
            const type = request.systemPrompt.includes('[CHECKPOINT]') ? 'Checkpoint' : request.systemPrompt.includes('[LONG_MEMORY]') ? 'Long Memory' : 'Summary';
            calls.push(type);
            return { content: type === 'Checkpoint' ? '[CHECKPOINT]\n[Current State]\n阶段内容'
                : type === 'Long Memory' ? '[LONG_MEMORY]\n无\n[UPDATED_FACTS]\n无\n[RETIRED_FACTS]\n无' : '[SUMMARY]\n[Title]\n补齐\n[Event]\n补齐内容\n[KEEP]\n无' };
        } } });
    const checkpoint = start => store.addCheckpoint({ id: `cp-${start}`, startFloor: start, endFloor: start + 4, content: `原阶段${start}`, status: 'frozen', frozen: true });
    const long = start => store.addLongMemory({ id: `long-${start}`, startFloor: start, endFloor: start + 49, content: `原长期${start}`, status: 'frozen', frozen: true });
    return { chat, store, summarizer, calls, checkpoint, long };
}

test('208 floors fills exactly 17 missing checkpoints and 3 long memories and preserves existing frozen content', async () => {
    const f = fixture();
    for (let start = 1; start <= 120; start += 5) f.checkpoint(start);
    f.long(1);
    const before = structuredClone(f.store.current());
    const result = await f.summarizer.fillMissingMemories();
    assert.equal(result.created, 20); assert.equal(result.failed, 0);
    assert.equal(f.store.current().checkpoints.length, 41); assert.equal(f.store.current().longMemories.length, 4);
    assert.deepEqual(f.calls, [...Array(17).fill('Checkpoint'), ...Array(3).fill('Long Memory')]);
    assert.deepEqual(f.store.current().summaries, before.summaries);
    for (const row of before.checkpoints) assert.deepEqual(f.store.current().checkpoints.find(item => item.id === row.id), row);
    assert.deepEqual(f.store.current().longMemories.find(item => item.id === 'long-1'), before.longMemories[0]);
    assert.equal((await f.summarizer.fillMissingMemories()).created, 0); assert.equal(f.calls.length, 20);
});

test('missing and failed summaries precede aggregates; earlier holes are filled even with later long memories', async () => {
    const f = fixture(102), entries = getAssistantMessages(f.chat);
    delete f.store.current().summaries[entries[0].messageId];
    Object.assign(f.store.current().summaries[entries[1].messageId], { status: 'failed', frozen: false, error: 'Unauthorized' });
    for (let start = 1; start <= 100; start += 5) if (start !== 1) f.checkpoint(start);
    f.long(51);
    const result = await f.summarizer.fillMissingMemories();
    assert.equal(result.created, 4); assert.equal(result.failed, 0);
    assert.deepEqual(f.calls, ['Summary', 'Summary', 'Checkpoint', 'Long Memory']);
    assert.equal(f.store.current().longMemories.find(item => item.startFloor === 51).content, '原长期51');
    assert.ok(f.store.current().longMemories.some(item => item.startFloor === 1 && item.endFloor === 50));
});

test('209 floors with complete checkpoints can explicitly generate all four missing long memories', async () => {
    const f = fixture(209);
    for (let start = 1; start <= 205; start += 5) f.checkpoint(start);
    const result = await f.summarizer.fillMissingMemories({ onlyLong: true });
    assert.equal(result.failed, 0); assert.equal(result.created, 4);
    assert.deepEqual(f.calls, Array(4).fill('Long Memory'));
    assert.deepEqual(f.store.current().longMemories.map(row => [row.startFloor, row.endFloor]), [[1, 50], [51, 100], [101, 150], [151, 200]]);
    assert.equal(f.summarizer.getMissingMemoryPlan({ onlyLong: true }).longMemories.length, 0);
});

test('long-only completion leaves unrelated recent missing summaries and checkpoints untouched', async () => {
    const f = fixture(110), entry = getAssistantMessages(f.chat).at(-1);
    delete f.store.current().summaries[entry.messageId];
    for (let start = 1; start <= 100; start += 5) f.checkpoint(start);
    const result = await f.summarizer.fillMissingMemories({ onlyLong: true });
    assert.equal(result.created, 2); assert.equal(result.failed, 0);
    assert.deepEqual(f.calls, ['Long Memory', 'Long Memory']);
    assert.equal(f.store.getSummary(entry.messageId), null); assert.equal(f.store.current().checkpoints.length, 20);
});

test('authorization and unconfirmed saves stop the chain without calling downstream models', async () => {
    const f = fixture(50), entries = getAssistantMessages(f.chat);
    delete f.store.current().summaries[entries[0].messageId];
    let calls = 0;
    f.summarizer.apiClient.complete = async () => { calls++; throw new Error('Unauthorized'); };
    let result = await f.summarizer.fillMissingMemories();
    assert.equal(result.failed, 1); assert.match(result.errors[0], /Unauthorized/); assert.equal(calls, 1);
    assert.equal(f.store.current().checkpoints.length, 0); assert.equal(f.summarizer.aggregateDeferrals, 0);
    const g = fixture(50);
    g.summarizer.flushMemory = async () => ({ state: 'failed', detail: '服务器超时' });
    result = await g.summarizer.fillMissingMemories();
    assert.equal(result.failed, 1); assert.match(result.errors[0], /服务器超时/); assert.deepEqual(g.calls, ['Checkpoint']);
});

test('safe stop or a chat revision change prevents committing late generated content', async () => {
    for (const switchChat of [false, true]) {
        const f = fixture(50), controller = new AbortController();
        f.summarizer.apiClient.complete = async () => {
            if (switchChat) f.summarizer.invalidateContext(); else controller.abort();
            return { content: '[CHECKPOINT]\n[Current State]\n迟到内容' };
        };
        await assert.rejects(f.summarizer.fillMissingMemories({ signal: controller.signal }), { code: switchChat ? 'CHAT_CHANGED' : 'REQUEST_ABORTED' });
        assert.equal(f.store.current().checkpoints.length, 0); assert.equal(f.summarizer.aggregateDeferrals, 0);
    }
});

test('one-click UI reads server first, runs every memory stage and releases its stop control', async () => {
    const f = fixture(5); let reads = 0;
    const ui = Object.assign(Object.create(CacheMemoryUI.prototype), { store: f.store, summarizer: f.summarizer,
        persistence: { epoch: 1, reread: async () => { reads++; return { state: 'confirmed' }; } },
        missingCheckpointRunId: 0, missingCheckpointState: { status: 'idle' },
        renderManager() {}, renderMessageMemories() {}, showTaskProgress() {},
    });
    await ui.handleManagerClick({ target: { closest: selector => selector === '[data-fill-all-memories]' ? {} : null } });
    assert.equal(reads, 1); assert.equal(ui.missingCheckpointState.status, 'completed');
    assert.equal(ui.missingCheckpointState.created, 1); assert.equal(ui.missingCheckpointController, null);
});
