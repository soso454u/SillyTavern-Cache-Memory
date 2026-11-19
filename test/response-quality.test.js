import test from 'node:test';
import assert from 'node:assert/strict';
import { isGeneratedFailureLine, isRejectedSummary } from '../src/response-quality.js';
import { cleanGeneratedResponse, prepareMemoryResponse } from '../src/response-cleanup.js';
import { MemoryStore, memoryHealth } from '../src/memory-store.js';
import { MemorySummarizer } from '../src/summarizer.js';
import { normalizeSettings, DEFAULT_PROMPTS } from '../src/defaults.js';
import { getAssistantMessages } from '../src/utils.js';
import { isUsableMemory } from '../src/continuity.js';
import { projectActiveState, stateContext } from '../src/active-state.js';
import { memoryOverviewStats } from '../src/ui.js';
import { refreshSnapshot } from '../src/cache-control.js';
import { HistoryBackfill } from '../src/history-backfill.js';

const failures = ['抱歉，没有找到相关的结果。', '你好，这个问题我无法回答，很遗憾不能帮助你。',
    '对不起，我不能帮助你。', '很抱歉，我无法完成此请求。', 'I cannot generate the requested content.',
    '您好！很抱歉，但我无法回答您的问题。', '作为一个AI助手，我无法生成此类内容。'];
const plot = '信使交出信件，医师收下后同意明晨会面。';
const summary = '[SUMMARY]\n[Title]\n交信\n[Characters]\n信使、医师\n[Event]\n' + plot;

for (const [kind, prompt, wrap] of [
    ['Summary', DEFAULT_PROMPTS.summary, value => '[SUMMARY]\n[Title]\n无\n[Characters]\n无\n[Event]\n' + value],
    ['Checkpoint', DEFAULT_PROMPTS.checkpoint, value => '[CHECKPOINT]\n[Stage Story]\n' + value],
    ['Long Memory', DEFAULT_PROMPTS.longMemory, value => '[STORY_ARC]\n' + value],
]) {
    test(`${kind} rejects standalone service refusals and search failure inside its required plot field`, () => {
        for (const failure of failures) {
            assert.equal(isGeneratedFailureLine(failure), true);
            assert.throws(() => prepareMemoryResponse(wrap(failure), kind, { prompt }), { code: 'INVALID_MEMORY_RESPONSE' });
            assert.equal(prepareMemoryResponse(wrap(failure + '\n' + plot), kind, { prompt }).includes(failure), false);
        }
    });
}

test('plain, XML, JSON, Markdown and Chinese-label Summary paths all reject the same service failures', () => {
    for (const failure of failures) for (const value of [failure, '**' + failure + '**', '<summary>' + failure + '</summary>',
        '<event>' + failure + '</event>', JSON.stringify({ summary: failure }), '[正文]\n' + failure,
        '```markdown\n' + failure + '\n```']) {
        assert.throws(() => prepareMemoryResponse(value, 'Summary', { prompt: DEFAULT_PROMPTS.summary }), { code: 'INVALID_MEMORY_RESPONSE' });
    }
    const xml = prepareMemoryResponse('<event>' + failures[0] + '\n' + plot + '</event>', 'Summary');
    assert.equal(xml, '<event>' + plot + '</event>');
});

test('real apologies, failed searches and attributed refusal dialogue remain story', () => {
    for (const value of ['医师说：“抱歉，没有找到相关的结果。”随后拿出另一封信。',
        '信使向医师道歉，两人重新约定会面时间。', '抱歉，我没有找到钥匙。',
        '我不能帮助你过河，因为船已经损坏。', '医师没有找到相关的药物，决定换一个药方。']) {
        assert.equal(isGeneratedFailureLine(value), false);
        assert.equal(cleanGeneratedResponse(value), value);
        assert.match(prepareMemoryResponse(value, 'Summary', { prompt: DEFAULT_PROMPTS.summary }), /\[Event\]/);
    }
    for (const failure of failures) {
        assert.equal(cleanGeneratedResponse('“' + failure + '”'), '“' + failure + '”');
        assert.equal(cleanGeneratedResponse(failure, '信使说：“' + failure + '”'), failure);
    }
});

function fixture() {
    const metadata = {}, chat = [{ mes: plot, gen_started: 'synthetic-1' }], waits = [], calls = [];
    const settings = normalizeSettings();
    const store = new MemoryStore({ getChatId: () => 'refusal-recovery', getMetadata: () => metadata, saveMetadata() {} });
    const entry = getAssistantMessages(chat)[0];
    const rejected = { ...entry, message: undefined, title: '无', characters: '无', event: failures[0],
        raw: '[SUMMARY]\n[Title]\n无\n[Characters]\n无\n[Event]\n' + failures[0], format: 'structured',
        frozen: true, status: 'frozen', manualEdited: false, sourceFingerprint: entry.fingerprint,
        stateChanges: [{ id: 'bad-state', kind: 'state', entity: '医师', key: '身份', value: '未知', category: 'identity', status: 'active' }] };
    store.addSummary(rejected);
    const summarizer = new MemorySummarizer({ store, getChat: () => chat, getSettings: () => settings,
        retryDelay: async ms => waits.push(ms), apiClient: { complete: async request => { calls.push(request); return { content: summary }; } } });
    return { store, chat, entry, rejected, summarizer, settings, waits, calls };
}

test('old frozen refusal-only summaries are classified without mutation and kept out of projections', () => {
    const f = fixture(), before = structuredClone(f.store.current());
    assert.equal(isRejectedSummary(f.rejected), true);
    assert.equal(isUsableMemory(f.rejected), false);
    assert.equal(memoryHealth(f.rejected).code, 'invalid-response');
    assert.deepEqual(f.summarizer.getMissingMemoryPlan().summaries.map(row => row.messageId), [f.entry.messageId]);
    assert.deepEqual(f.store.currentSummaries(f.chat), []);
    assert.deepEqual(f.store.effectiveStore(f.chat).summaries, {});
    assert.ok(projectActiveState(f.store.current()).every(row => row.needsReview));
    assert.equal(stateContext(f.store.current()), '无');
    const stats = memoryOverviewStats(f.store.current(), getAssistantMessages(f.chat), f.settings);
    assert.equal(stats.summaries.generated, 0);
    assert.match(stats.issues.join('\n'), /拒答或检索失败/);
    const copy = structuredClone(f.store.current());
    const snapshot = refreshSnapshot(copy, f.settings, 'manual reinject', f.store.effectiveStore(f.chat));
    assert.equal(snapshot.value.includes(failures[0]), false);
    assert.deepEqual(f.store.current(), before);
});

test('refusal recovery replaces only after save confirmation; a failed replacement retains the original', async () => {
    const f = fixture(), before = structuredClone(f.store.getSummary(f.entry.messageId));
    f.summarizer.commitMemory = async () => { throw Object.assign(new Error('保存未确认'), { code: 'SAVE_UNCONFIRMED' }); };
    await assert.rejects(f.summarizer.summarizeEntry(f.entry, { deferAggregates: true }), { code: 'SAVE_UNCONFIRMED' });
    assert.deepEqual(f.store.getSummary(f.entry.messageId), before);
    assert.equal(f.calls.length, 1);
    f.summarizer.commitMemory = async mutate => mutate();
    const fixed = await f.summarizer.summarizeEntry(f.entry, { deferAggregates: true });
    assert.equal(fixed.event, plot);
    assert.equal(isUsableMemory(fixed), true);
    assert.equal(fixed.stateChanges?.some(row => row.id === 'bad-state') ?? false, false);
    assert.equal(stateContext(f.store.current()), '无');
    assert.equal(f.calls.length, 1);
    assert.deepEqual(f.summarizer.getMissingMemoryPlan().summaries, []);
});

test('persistent refusals never freeze a replacement, even when an older record is already frozen', async () => {
    const f = fixture(), before = structuredClone(f.store.getSummary(f.entry.messageId));
    f.summarizer.apiClient.complete = async request => { f.calls.push(request); return { content: failures[1] }; };
    await assert.rejects(f.summarizer.summarizeEntry(f.entry, { deferAggregates: true }), { code: 'INVALID_MEMORY_RESPONSE' });
    assert.equal(f.calls.length, 4);
    assert.deepEqual(f.waits, [2000, 5000, 10000]);
    assert.deepEqual(f.store.getSummary(f.entry.messageId), before);
    assert.equal(isUsableMemory(f.store.getSummary(f.entry.messageId)), false);
});

test('manual edits and story summaries with identified characters are preserved by old-record classification', () => {
    const f = fixture();
    for (const extra of [{ manualEdited: true }, { status: 'manual-edited' }, { title: '医师的道歉' }, { characters: '医师' }]) {
        assert.equal(isRejectedSummary({ ...f.rejected, ...extra }), false);
    }
    assert.equal(isRejectedSummary({ ...f.rejected, event: '医师说：“' + failures[0] + '”' }), false);
});

test('the default missing/failed batch repairs a frozen service failure instead of skipping it', async () => {
    const f = fixture();
    const backfill = new HistoryBackfill({ summarizer: f.summarizer, store: f.store, getChat: () => f.chat });
    const result = await backfill.start({ startFloor: 1, endFloor: 1, mode: 'missing-failed' });
    assert.equal(result.success, 1);
    assert.equal(result.skipped, 0);
    assert.equal(f.calls.length, 1);
    assert.equal(f.store.getSummary(f.entry.messageId).event, plot);
});
