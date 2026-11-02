import test from 'node:test';
import assert from 'node:assert/strict';
import { MemorySummarizer } from '../src/summarizer.js';
import { MemoryStore } from '../src/memory-store.js';
import { normalizeSettings } from '../src/defaults.js';
import { getAssistantMessages } from '../src/utils.js';
import { CacheMemoryUI } from '../src/ui.js';

const settle = () => new Promise(resolve => setImmediate(resolve));
function gate() { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; }
function fixture(count = 154) {
    const chat = Array.from({ length: count }, (_, i) => ({ mes: `注入测试正文${i + 1}`, gen_started: `g${i}` }));
    const metadata = {}, settings = normalizeSettings(), calls = [], statuses = [], waits = [];
    const store = new MemoryStore({ getMetadata: () => metadata, getChatId: () => 'injection-chat', saveMetadata() {} });
    const summarizer = new MemorySummarizer({ store, getChat: () => chat, getSettings: () => settings,
        retryDelay: async ms => waits.push(ms), onStatus: (...args) => statuses.push(args),
        apiClient: { complete: async request => {
            const kind = request.userContent.startsWith('[PREVIOUS_CONTEXT]') ? 'CP' : request.userContent.startsWith('[EXISTING_LONG_FACTS]') ? 'Long' : 'Summary';
            calls.push({ kind, request });
            return { content: { Summary: '[SUMMARY]\n[Event]\n信使交信，医师约定明天答复。', CP: '[CHECKPOINT]\n[Stage Story]\n信使与医师确立通信约定。',
                Long: '[STORY_ARC]\n两人经过多次通信建立合作，医师最后如期答复。\n[LONG_MEMORY]\n无' }[kind] };
        } } });
    for (const entry of getAssistantMessages(chat)) store.addSummary({ floor: entry.floor, messageIndex: entry.messageIndex, messageId: entry.messageId,
        sourceContentFingerprint: entry.contentFingerprint, sourceFingerprint: entry.fingerprint, event: `原摘要${entry.floor}`, status: 'frozen' });
    for (let start = 1; start + 4 <= count; start += 5) store.addCheckpoint({ id: `cp-${start}`, startFloor: start, endFloor: start + 4, content: `原阶段${start}`, status: 'frozen' });
    for (let start = 1; start + 49 <= count; start += 50) store.addLongMemory({ id: `long-${start}`, startFloor: start, endFloor: start + 49, content: `原长期${start}`, status: 'frozen' });
    const drop = floor => delete store.current().summaries[getAssistantMessages(chat)[floor - 1].messageId];
    return { chat, settings, store, summarizer, calls, statuses, waits, drop };
}
function gaps(f) {
    f.drop(150); f.drop(154);
    f.store.current().checkpoints = f.store.current().checkpoints.filter(row => row.startFloor !== 146);
    f.store.current().longMemories = f.store.current().longMemories.filter(row => row.startFloor !== 101);
}

test('154-floor screenshot: each injection fills missing Summary, CP and Long before finishing', async () => {
    const f = fixture(); gaps(f); const before = structuredClone(f.store.current());
    const result = await f.summarizer.completeBeforeInjection();
    assert.equal(result.created, 4); assert.equal(result.remaining, 0);
    assert.deepEqual(f.calls.map(call => call.kind), ['Summary', 'Summary', 'CP', 'Long']);
    assert.equal(Object.keys(f.store.current().summaries).length, 154);
    assert.equal(f.store.current().checkpoints.length, 30); assert.equal(f.store.current().longMemories.length, 3);
    for (const row of Object.values(before.summaries)) assert.deepEqual(f.store.getSummary(row.messageId), row);
    assert.deepEqual(f.store.current().checkpoints.slice(0, 29), before.checkpoints);
    assert.deepEqual(f.store.current().longMemories.slice(0, 2), before.longMemories);
    assert.equal(f.summarizer.injectionRecovery, null);
});

test('complete memory is a read-only no-op on repeated injections', async () => {
    const f = fixture(), before = structuredClone(f.store.current());
    for (let i = 0; i < 3; i++) assert.equal((await f.summarizer.completeBeforeInjection()).remaining, 0);
    assert.deepEqual(f.calls, []); assert.deepEqual(f.store.current(), before);
});

test('concurrent injection requests share one fill, then a later injection rescans for new gaps', async () => {
    const f = fixture(2), hold = gate(), complete = f.summarizer.apiClient.complete;
    f.drop(1);
    f.summarizer.apiClient.complete = async request => { await hold.promise; return complete(request); };
    const first = f.summarizer.completeBeforeInjection(), second = f.summarizer.completeBeforeInjection();
    assert.equal(first, second); await settle();
    hold.resolve(); await Promise.all([first, second]); assert.equal(f.calls.length, 1);
    f.drop(2); await f.summarizer.completeBeforeInjection(); assert.equal(f.calls.length, 2);
});

test('an exhausted content failure is retried again on the next injection without requiring a new floor', async () => {
    const f = fixture(2), complete = f.summarizer.apiClient.complete; f.drop(1);
    let failures = 0;
    f.summarizer.apiClient.complete = async () => { failures++; return { content: '[SUMMARY]\n[Event]\n无' }; };
    const first = await f.summarizer.completeBeforeInjection();
    assert.equal(first.remaining, 1); assert.equal(first.failed, 1); assert.equal(failures, 4);
    assert.deepEqual(f.waits, [2000, 5000, 10000]);
    f.summarizer.apiClient.complete = complete;
    assert.equal((await f.summarizer.completeBeforeInjection()).remaining, 0);
    assert.equal(f.calls.length, 1);
});

test('manual-summary mode still fills at injection; disabled plugin/API/injection does not request models', async () => {
    const f = fixture(2); f.drop(1); f.settings.autoSummarize = false;
    assert.equal((await f.summarizer.completeBeforeInjection()).created, 1);
    for (const patch of [{ enabled: false }, { independentApi: false }, { injectionMode: 'none' }]) {
        const disabled = fixture(2); disabled.drop(1); Object.assign(disabled.settings, patch);
        assert.equal((await disabled.summarizer.completeBeforeInjection()).skipped, true);
        assert.deepEqual(disabled.calls, []);
    }
});

test('pending summaries settle before checking gaps so an already generated floor is not regenerated', async () => {
    const f = fixture(2), complete = f.summarizer.apiClient.complete, hold = gate(); f.drop(1);
    f.summarizer.apiClient.complete = async request => { await hold.promise; return complete(request); };
    const summary = f.summarizer.summarizeMessage(getAssistantMessages(f.chat)[0].messageId, { deferAggregates: true });
    const injection = f.summarizer.completeBeforeInjection(); await settle(); hold.resolve();
    await Promise.all([summary, injection]); assert.equal(f.calls.length, 1);
});

test('cancellation interrupts queue waiting, and context invalidation stops content backoff', async () => {
    const f = fixture(2), queued = gate(); f.drop(1); f.summarizer.queue = queued.promise;
    const pending = f.summarizer.completeBeforeInjection(); await settle(); f.summarizer.cancelInjectionRecovery();
    await assert.rejects(pending, { code: 'REQUEST_ABORTED' });
    assert.deepEqual(f.calls, []); queued.resolve();
    const g = fixture(2); g.drop(1); let calls = 0;
    g.summarizer.apiClient.complete = async () => { calls++; return { content: '[SUMMARY]\n[Event]\n无' }; };
    g.summarizer.retryDelay = async () => g.summarizer.invalidateContext();
    await assert.rejects(g.summarizer.completeBeforeInjection(), error => ['CHAT_CHANGED', 'REQUEST_ABORTED'].includes(error.code));
    assert.equal(calls, 1); assert.equal(g.summarizer.injectionRecovery, null);
});

for (const kind of ['assistant', 'opening', 'user']) test(`${kind} changes while queued cancel the old injection before generating memories`, async () => {
    const f = fixture(2), queued = gate(); f.drop(1); f.summarizer.queue = queued.promise;
    if (kind === 'opening') f.chat.unshift({ mes: '原开场白' });
    if (kind === 'user') f.chat.push({ mes: '原用户输入', is_user: true });
    const pending = f.summarizer.completeBeforeInjection(); await settle();
    (kind === 'user' ? f.chat.at(-1) : f.chat[0]).mes = '更改后的正文'; queued.resolve();
    await assert.rejects(pending, { code: 'SOURCE_CHANGED' }); assert.deepEqual(f.calls, []);
});

test('manual reinjection waits for completion, then reports remaining gaps instead of success', async () => {
    const f = fixture(2), hold = gate(), calls = [], statuses = [];
    const ui = new CacheMemoryUI({ store: f.store, prepareInjection: async () => { calls.push('prepare'); await hold.promise; return { remaining: 1, failed: 1 }; },
        updateInjection: reason => calls.push(reason) });
    ui.setManagerActionStatus = (...args) => statuses.push(args); ui.renderManager = () => {};
    const pending = ui.performManagerClick({ target: { closest: selector => selector === '[data-reinject]' ? {} : null } });
    await settle(); assert.deepEqual(calls, ['prepare']); hold.resolve(); await pending;
    assert.deepEqual(calls, ['prepare', 'manual reinject']); assert.equal(statuses.at(-1)[0], 'warning');
});

test('conflicts and active manual backfills do not start competing model requests', async () => {
    const f = fixture(2); f.drop(1); f.summarizer.getPersistenceState = () => ({ state: 'conflict' });
    await assert.rejects(f.summarizer.completeBeforeInjection(), { code: 'SAVE_UNCONFIRMED' }); assert.deepEqual(f.calls, []);
    f.summarizer.getPersistenceState = () => ({}); f.summarizer.aggregateDeferrals++;
    const result = await f.summarizer.completeBeforeInjection();
    assert.equal(result.busy, true); assert.equal(result.remaining, 1); assert.deepEqual(f.calls, []);
});
