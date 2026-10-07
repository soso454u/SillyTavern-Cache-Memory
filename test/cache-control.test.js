import test from 'node:test';
import assert from 'node:assert/strict';
import { CacheDiagnostics, effectiveInjectionMode, refreshSnapshot, shouldRefreshInjection } from '../src/cache-control.js';
import { INJECTION_MODES, normalizeSettings } from '../src/defaults.js';
import { MemoryStore, normalizeStore } from '../src/memory-store.js';
import { MemorySummarizer } from '../src/summarizer.js';
import { getAssistantMessages, fnv1a } from '../src/utils.js';

function fixture(mode = INJECTION_MODES.CHECKPOINT_BOUNDARY) {
    const settings = normalizeSettings({ injectionMode: mode });
    const metadata = {};
    const refreshes = [];
    const store = new MemoryStore({ getMetadata: () => metadata, getChatId: () => 'chat-a', saveMetadata: () => {},
        onChange: (current, reason) => {
            if (shouldRefreshInjection(settings, reason)) refreshes.push({ reason, ...refreshSnapshot(current, settings, reason) });
        } });
    refreshSnapshot(store.current(), settings, 'chat changed');
    return { store, settings, refreshes };
}
function checkpoint(floor, content = `阶段${floor}`) {
    return { id: `checkpoint-${String(floor / 5).padStart(3, '0')}`, startFloor: floor - 4, endFloor: floor, content, status: 'frozen', frozen: true };
}

test('fresh defaults are strict, no injection, CP5/Long50; existing custom intervals survive', () => {
    const settings = normalizeSettings();
    assert.equal(settings.strictCacheMode, true);
    assert.equal(settings.injectionMode, INJECTION_MODES.NONE);
    assert.equal(settings.checkpointInterval, 5);
    assert.equal(settings.longMemoryInterval, 50);
    assert.equal(settings.generationTransport, 'auto');
    assert.equal(normalizeSettings({ generationTransport: 'stream' }).generationTransport, 'stream');
    assert.equal(normalizeSettings({ generationTransport: 'non-stream' }).generationTransport, 'non-stream');
    assert.equal(normalizeSettings({ generationTransport: 'invalid' }).generationTransport, 'auto');
    assert.equal(settings.cacheDebug, false);
    assert.equal(normalizeSettings({ checkpointInterval: 10, longMemoryInterval: 100 }).longMemoryInterval, 100);
});

test('floor summaries never refresh strict injection; 1-4/6-9 have byte-identical snapshots, 5/10 append once', () => {
    const { store, refreshes } = fixture();
    const hashes = [];
    for (let floor = 1; floor <= 10; floor++) {
        store.addSummary({ messageId: `m${floor}`, floor, raw: `S${floor}`, status: 'frozen', frozen: true });
        if (floor % 5 === 0) store.addCheckpoint(checkpoint(floor));
        hashes.push(fnv1a(store.current().injectionSnapshot.value));
    }
    assert.equal(new Set(hashes.slice(0, 4)).size, 1);
    assert.notEqual(hashes[3], hashes[4]);
    assert.equal(new Set(hashes.slice(4, 9)).size, 1);
    assert.notEqual(hashes[8], hashes[9]);
    assert.deepEqual(refreshes.map(item => item.reason), ['new checkpoint', 'new checkpoint']);
    assert.match(store.current().injectionSnapshot.value, /CHECKPOINT_001[\s\S]*CHECKPOINT_002/);
    assert.doesNotMatch(store.current().injectionSnapshot.value, /RECENT_SUMMARY|S10/);
});

test('old recent mode is demoted; long-only boundary ignores every checkpoint and summary', () => {
    const recent = normalizeSettings({ injectionMode: INJECTION_MODES.LONG_CHECKPOINT_RECENT });
    assert.equal(effectiveInjectionMode(recent), INJECTION_MODES.CHECKPOINT_BOUNDARY);
    assert.equal(shouldRefreshInjection(recent, 'new summary'), false);
    const { store, refreshes } = fixture(INJECTION_MODES.LONG_BOUNDARY);
    store.addSummary({ messageId: 'm1', floor: 1, raw: 'should not appear' });
    store.addCheckpoint(checkpoint(5));
    assert.equal(refreshes.length, 0);
    store.addLongMemory({ id: 'long-001', startFloor: 1, endFloor: 50, content: 'L1', status: 'frozen', frozen: true });
    assert.equal(refreshes.length, 1);
    assert.match(store.current().injectionSnapshot.value, /LONG_MEMORY_001/);
    assert.doesNotMatch(store.current().injectionSnapshot.value, /CHECKPOINT|should not appear/);
});

test('background appends preserve published bytes even if underlying record changes; manual edits rebuild explicitly', () => {
    const { store, settings } = fixture();
    store.addCheckpoint(checkpoint(5, 'AAA'));
    store.current().checkpoints[0].content = 'AAA2';
    store.addCheckpoint(checkpoint(10, 'BBB'));
    assert.match(store.current().injectionSnapshot.value, /AAA\n\n\[CHECKPOINT_002/);
    assert.doesNotMatch(store.current().injectionSnapshot.value, /AAA2/);
    refreshSnapshot(store.current(), settings, 'manual edit');
    assert.match(store.current().injectionSnapshot.value, /AAA2/);
});

test('Long boundary removes only fully covered CP injection, never CP data or prior Long contents', () => {
    const { store } = fixture();
    for (let floor = 5; floor <= 55; floor += 5) store.addCheckpoint(checkpoint(floor));
    const archived = structuredClone(store.current().checkpoints);
    store.addLongMemory({ id: 'long-001', startFloor: 1, endFloor: 50, content: 'frozen L1', status: 'frozen', frozen: true });
    const value = store.current().injectionSnapshot.value;
    assert.match(value, /LONG_MEMORY_001/);
    assert.doesNotMatch(value, /CHECKPOINT_001|CHECKPOINT_010/);
    assert.match(value, /CHECKPOINT_011/);
    assert.deepEqual(store.current().checkpoints, archived);
    store.current().longMemories[0].content = 'background altered L1';
    store.addLongMemory({ id: 'long-002', startFloor: 51, endFloor: 100, content: 'L2', status: 'frozen', frozen: true });
    assert.match(store.current().injectionSnapshot.value, /frozen L1/);
    assert.doesNotMatch(store.current().injectionSnapshot.value, /background altered|CHECKPOINT_011/);
});

test('chat reload restores the published snapshot; switches and settings changes are explicit refresh reasons', () => {
    const { store, settings } = fixture();
    store.addCheckpoint(checkpoint(5));
    const imported = normalizeStore(structuredClone(store.current()), 'chat-a');
    imported.checkpoints[0].content = 'not yet published';
    assert.equal(refreshSnapshot(imported, settings, 'chat changed').value, store.current().injectionSnapshot.value);
    assert.match(refreshSnapshot(imported, settings, 'settings changed').value, /not yet published/);
    assert.equal(refreshSnapshot(imported, { ...settings, injectionMode: INJECTION_MODES.NONE }, 'settings changed').value, '');
});

test('failed aggregate and metadata sync never publish; no-injection stays empty after successful commits', () => {
    const { store, refreshes } = fixture(INJECTION_MODES.NONE);
    store.addCheckpoint({ ...checkpoint(5), frozen: false, status: 'failed' });
    store.syncMessages([]);
    store.addLongMemory({ id: 'long-001', startFloor: 1, endFloor: 50, content: 'L', status: 'frozen', frozen: true });
    assert.equal(refreshes.length, 0);
    assert.equal(store.current().injectionSnapshot.value, '');
});

test('automatic 105 floors create 21 frozen CP and segmented Long1-50/51-100, preserving all chat objects', async () => {
    const { store, settings, refreshes } = fixture();
    const chat = Array.from({ length: 105 }, (_, index) => ({ name: 'A', is_user: false, mes: `body ${index}`, send_date: String(index), gen_started: String(index) }));
    const original = structuredClone(chat);
    const requests = [];
    const summarizer = new MemorySummarizer({ store, getSettings: () => settings, getChat: () => chat,
        apiClient: { complete: async request => {
            requests.push(request);
            return { content: request.userContent.startsWith('body') ? `[SUMMARY]\n[Event]\n${request.userContent}`
                : request.userContent.startsWith('[EXISTING_LONG_FACTS]') ? '[LONG_MEMORY]\n- a persistent fact' : '[CHECKPOINT]\nphase state' };
        } } });
    for (const entry of getAssistantMessages(chat)) await summarizer.summarizeEntry(entry);
    const current = store.current();
    assert.equal(current.checkpoints.length, 21);
    assert.deepEqual(current.longMemories.map(item => [item.startFloor, item.endFloor]), [[1, 50], [51, 100]]);
    const longSnapshot = structuredClone(current.longMemories);
    await summarizer.generateDueAggregates();
    assert.deepEqual(store.current().longMemories, longSnapshot);
    assert.match(current.injectionSnapshot.value, /LONG_MEMORY_001[\s\S]*LONG_MEMORY_002[\s\S]*CHECKPOINT_021/);
    assert.doesNotMatch(current.injectionSnapshot.value, /CHECKPOINT_001|RECENT_SUMMARY/);
    assert.equal(requests.length, 105 + 21 + 2);
    assert.equal(refreshes.length, 21);
    assert.equal(refreshes.filter(item => item.reason === 'new long memory').length, 2);
    assert.deepEqual(chat, original);
});

test('diagnostics retain only hashes, measure appended-history 100% LCP and identify memory/other/removed breaks', () => {
    const debug = new CacheDiagnostics();
    const { store, settings } = fixture();
    const baseline = debug.memory(store.current(), settings, 1);
    assert.equal(baseline.previousHash, null);
    assert.equal(debug.memory(store.current(), settings, 2).changed, false);
    store.addCheckpoint(checkpoint(5));
    assert.equal(debug.memory(store.current(), settings, 5).reason, 'new checkpoint');
    const messages = [{ role: 'system', content: '<CACHE_MEMORY>secret prompt</CACHE_MEMORY>' }, { role: 'user', content: 'secret user' }];
    debug.history('chat-a', messages);
    assert.equal(debug.history('chat-a', [...messages, { role: 'assistant', content: 'reply' }]).stablePrefixPercent, 100);
    const result = debug.history('chat-a', [{ role: 'system', content: '<CACHE_MEMORY>changed</CACHE_MEMORY>' }, ...messages.slice(1)]);
    assert.equal(result.brokeAt.source, 'CACHE_MEMORY');
    assert.equal(result.brokeAt.index, 0);
    const changedUser = debug.history('chat-a', [{ role: 'system', content: '<CACHE_MEMORY>changed</CACHE_MEMORY>' }, { role: 'user', content: 'other' }]);
    assert.equal(changedUser.brokeAt.source, 'other prompt/history');
    assert.equal(changedUser.stablePrefixMessages, 1);
    assert.equal(debug.history('chat-a', []).brokeAt.role, 'removed');
    assert.doesNotMatch(JSON.stringify([...debug.histories.values()]), /secret prompt|secret user|reply|changed/);
    debug.reset();
    assert.equal(debug.histories.size, 0);
});

test('strict frozen Long renders validated fact deltas, not rejected raw retirement instructions', () => {
    const { store } = fixture();
    store.addLongMemory({ id: 'long-001', startFloor: 1, endFloor: 50, memoryKind: 'facts',
        content: '[LONG_MEMORY]\nfirst fact', factUpdates: [{ action: 'add', id: 'fact-a', text: 'original fact' }], frozen: true, status: 'frozen' });
    store.addLongMemory({ id: 'long-002', startFloor: 51, endFloor: 100, memoryKind: 'facts',
        content: '[RETIRED_FACTS]\nunsupported deletion', factUpdates: [{ action: 'replace', id: 'fact-b', previousId: 'fact-a', text: 'confirmed update' }], frozen: true, status: 'frozen' });
    const value = store.current().injectionSnapshot.value;
    assert.match(value, /ADD fact-a: original fact/);
    assert.match(value, /REPLACE fact-b \(supersedes fact-a\): confirmed update/);
    assert.doesNotMatch(value, /unsupported deletion/);
});

test('Long generation failure publishes the completed CP once; retry commits Long without rewriting frozen CP', async () => {
    const { store, settings, refreshes } = fixture();
    for (let floor = 5; floor <= 45; floor += 5) store.addCheckpoint(checkpoint(floor));
    for (let floor = 1; floor <= 50; floor++) store.addSummary({ messageId: `m${floor}`, floor, raw: `S${floor}`, status: 'frozen', frozen: true });
    const previous = structuredClone(store.current().checkpoints);
    const chat = Array.from({ length: 50 }, (_, index) => ({ name: 'A', mes: 'body', gen_started: String(index), send_date: String(index) }));
    const summarizer = new MemorySummarizer({ store, getSettings: () => settings, getChat: () => chat, apiClient: {
        complete: async request => { if (request.userContent.startsWith('[EXISTING_LONG_FACTS]')) throw new Error('Long unavailable'); return { content: '[CHECKPOINT]\ncompleted 46-50' }; },
    } });
    const count = refreshes.length;
    await assert.rejects(summarizer.generateDueAggregates(), /Long unavailable/);
    assert.equal(refreshes.length, count + 1);
    assert.equal(refreshes.at(-1).reason, 'new checkpoint');
    assert.match(store.current().injectionSnapshot.value, /CHECKPOINT_010/);
    assert.deepEqual(store.current().checkpoints.slice(0, 9), previous);
    summarizer.apiClient.complete = async () => ({ content: '[LONG_MEMORY]\n- recovered long fact' });
    await summarizer.generateDueLongMemories();
    assert.equal(store.current().longMemories.length, 1);
    assert.equal(store.current().longMemories[0].status, 'frozen');
    assert.equal(refreshes.at(-1).reason, 'new long memory');
    assert.doesNotMatch(store.current().injectionSnapshot.value, /CHECKPOINT_010/);
});
