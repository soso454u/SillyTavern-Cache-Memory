import test from 'node:test';
import assert from 'node:assert/strict';
import { MemoryStore } from '../src/memory-store.js';
import { MemorySummarizer } from '../src/summarizer.js';
import { HistoryBackfill } from '../src/history-backfill.js';
import { CacheMemoryUI, memoryOverviewStats, summarySourceAudit } from '../src/ui.js';
import { normalizeSettings } from '../src/defaults.js';
import { getAssistantMessages } from '../src/utils.js';

function fixture() {
    const chat = Array.from({ length: 273 }, (_, i) => ({ name: 'A', mes: `正文${i}`, gen_started: `g${i}` }));
    const entries = getAssistantMessages(chat), metadata = {}, settings = normalizeSettings();
    const store = new MemoryStore({ getChatId: () => 'identity-test', getMetadata: () => metadata, saveMetadata() {} });
    for (const entry of entries) {
        const id = entry.floor <= 23 ? `legacy-${entry.floor}` : entry.messageId;
        store.current().summaries[id] = { messageId: id, floor: entry.floor, messageIndex: entry.messageIndex,
            event: `保存的剧情${entry.floor}`, status: 'frozen', sourceContentFingerprint: 'old-hash' };
    }
    for (let start = 1; start <= 270; start += 5) store.current().checkpoints.push({ id: `cp-${start}`,
        startFloor: start, endFloor: start + 4, content: '保存的阶段剧情', status: 'frozen' });
    for (let start = 1; start <= 250; start += 50) store.current().longMemories.push({ id: `long-${start}`,
        startFloor: start, endFloor: start + 49, content: '保存的重大历史及人物知情差', status: 'frozen' });
    let calls = 0;
    const summarizer = new MemorySummarizer({ store, getChat: () => chat, getSettings: () => settings,
        apiClient: { complete: async () => { calls++; return { content: '[SUMMARY]\n[Title]\n新摘要\n[Event]\n当前正文的新摘要' }; } } });
    return { chat, entries, store, settings, summarizer, get calls() { return calls; } };
}

test('273 saved floors with 23 changed IDs remain visible and no missing scan regenerates them', async () => {
    const f = fixture(), before = structuredClone(f.store.current());
    assert.equal(f.entries.filter(e => f.store.getSummary(e.messageId)).length, 250);
    const stats = memoryOverviewStats(f.store.current(), f.entries, f.settings);
    assert.deepEqual(stats.summaries, { actual: 273, generated: 273, expected: 273 });
    assert.deepEqual(stats.issues, []);
    assert.equal(stats.checkpoints.actual, 54); assert.equal(stats.longMemories.actual, 5);
    assert.deepEqual(f.summarizer.getMissingMemoryPlan().summaries, []);
    assert.equal((await f.summarizer.fillMissingMemories()).created, 0);
    const backfill = new HistoryBackfill({ store: f.store, summarizer: f.summarizer, getChat: () => f.chat });
    assert.equal((await backfill.start()).skipped, 273);
    assert.equal(f.calls, 0);
    assert.deepEqual(f.store.current(), before);
});

test('truly missing floors and actual failed records remain reported and selected for generation', () => {
    const f = fixture();
    delete f.store.current().summaries[f.entries[272].messageId];
    f.store.current().summaries[f.entries[0].messageId] = { messageId: f.entries[0].messageId,
        floor: 1, status: 'failed', frozen: false, error: 'Unauthorized' };
    const stats = memoryOverviewStats(f.store.current(), f.entries, f.settings);
    assert.equal(stats.summaries.actual, 271);
    assert.deepEqual(stats.summaryDetails.filter(r => r.current).map(r => [r.floor, r.reason]), [[1, 'failed'], [273, 'missing']]);
    assert.deepEqual(f.summarizer.getMissingMemoryPlan().summaries.map(e => e.floor), [1, 273]);
});

test('explicit latest-summary UI action regenerates a saved different-ID record', async () => {
    const f = fixture(), entry = f.entries.at(-1), old = f.store.getSummary(entry.messageId);
    delete f.store.current().summaries[entry.messageId];
    f.store.current().summaries.latestLegacy = { ...old, messageId: 'latestLegacy' };
    const aggregates = structuredClone([f.store.current().checkpoints, f.store.current().longMemories]);
    let confirms = 0;
    const ui = new CacheMemoryUI({ store: f.store, summarizer: f.summarizer, getChat: () => f.chat });
    ui.showPluginDialog = async () => { confirms++; return true; };
    ui.renderManager = () => {};
    await ui.performManagerClick({ target: { closest: selector => selector === '[data-backfill-action]'
        ? { dataset: { backfillAction: 'latest' } } : null } });
    assert.equal(confirms, 1); assert.equal(f.calls, 1);
    assert.equal(f.store.getSummary(entry.messageId).event, '当前正文的新摘要');
    assert.equal(f.store.getSummary('latestLegacy'), null);
    assert.deepEqual([f.store.current().checkpoints, f.store.current().longMemories], aggregates);
});

test('source review is read only and distinguishes matching, changed, unknown, and missing floors', () => {
    const f = fixture(), sums = f.store.current().summaries;
    sums[f.entries[0].messageId] = { ...sums['legacy-1'], messageId: f.entries[0].messageId, sourceContentFingerprint: f.entries[0].contentFingerprint };
    delete sums['legacy-1'];
    delete sums['legacy-3'].sourceContentFingerprint;
    delete sums['legacy-3'].sourceFingerprint;
    delete sums['legacy-4'];
    const before = structuredClone(f.store.current());
    const result = summarySourceAudit(f.store.current(), f.entries);
    assert.deepEqual(result.slice(0, 4).map(row => row.status), ['matched', 'changed', 'unknown', 'missing']);
    assert.equal(result[0].entry.message.mes, '正文0');
    assert.deepEqual(f.store.current(), before);
    assert.equal(f.calls, 0);
});
