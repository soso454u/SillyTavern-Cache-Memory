import test from 'node:test';
import assert from 'node:assert/strict';
import { INJECTION_MODES, normalizeSettings, normalizeLoadedSettings } from '../src/defaults.js';
import { aggregateVersion, createEmptyStore, MemoryStore, summaryVersion } from '../src/memory-store.js';
import { refreshSnapshot, effectiveInjectionMode, shouldRefreshInjection } from '../src/cache-control.js';
import { filterCoveredHistory, promptHistoryFloor } from '../src/history-handoff.js';
import { getAssistantMessages, messageFingerprint } from '../src/utils.js';
import { getOpeningSource } from '../src/opening-source.js';
import { MemorySummarizer } from '../src/summarizer.js';
import { summaryUserSource } from '../src/summary-source.js';
import { memoryOverviewStats, configTemplate } from '../src/ui.js';

function addTurn(chat, store, floor) {
    chat.push({ name: '旅人', is_user: true, mes: `输入${floor}`, send_date: `u${floor}` },
        { name: '守卫', mes: `正文${floor}：${'现场动作。'.repeat(1500)}`, send_date: `a${floor}`, gen_started: `g${floor}` });
    const entry = getAssistantMessages(chat).at(-1);
    store.summaries[entry.messageId] = { messageId: entry.messageId, floor, status: 'frozen',
        sourceContentFingerprint: entry.contentFingerprint, sourceFingerprint: entry.fingerprint, event: `因果${floor}：交出钥匙，约定归还。` };
    if (floor % 5 === 0) store.checkpoints.push({ id: `cp-${floor}`, startFloor: floor - 4, endFloor: floor,
        status: 'frozen', content: `[Stage Story]\n本阶段${floor - 4}至${floor}的独立因果。`,
        ...(floor === 5 ? { openingContentFingerprint: getOpeningSource(chat).contentFingerprint } : {}) });
    if (floor % 50 === 0) store.longMemories.push({ id: `long-${floor}`, startFloor: floor - 49, endFloor: floor,
        status: 'frozen', content: `[STORY_ARC]\n本段${floor - 49}至${floor}的长期因果。`,
        ...(floor === 50 ? { openingContentFingerprint: getOpeningSource(chat).contentFingerprint } : {}) });
}
function fixture(floors = 12, preferences = {}) {
    const chat = [{ name: '守卫', mes: '初始背景', send_date: 'opening' }], store = createEmptyStore('rolling');
    for (let floor = 1; floor <= floors; floor++) addTurn(chat, store, floor);
    chat.push({ name: '旅人', is_user: true, mes: '本轮输入', send_date: 'pending' });
    return { chat, store, settings: normalizeSettings(preferences) };
}
function send(f, core = structuredClone(f.chat), type = 'normal') {
    const settings = { ...f.settings, injectionFloor: promptHistoryFloor(core, f.chat, f.store.summaries) };
    refreshSnapshot(f.store, settings, 'before generation');
    return filterCoveredHistory(core, f.chat, f.store.injectionSnapshot, f.store.injectionSnapshot.value,
        { summaries: f.store.summaries, type, lastUserOnly: settings.lastUserOnly });
}
const storyBlocks = store => store.injectionSnapshot.blocks.filter(block => block.coversHistory);
const rawFloors = result => result.messages.filter(row => /^正文\d+：/.test(row.mes)).map(row => Number(row.mes.match(/^正文(\d+)/)[1]));

const shortMode = INJECTION_MODES.CHECKPOINT_SHORT_HISTORY;
function prepareShortSources(f) {
    for (const entry of getAssistantMessages(f.chat)) {
        const summary = f.store.summaries[entry.messageId];
        if (summary) summary.userSourceFingerprint = summaryUserSource(f.chat, entry).fingerprint;
    }
    for (const cp of f.store.checkpoints) {
        cp.sourceVersions = Object.fromEntries(Object.values(f.store.summaries).filter(row => row.floor >= cp.startFloor && row.floor <= cp.endFloor)
            .map(row => [row.messageId, summaryVersion(row)]));
    }
    for (const long of f.store.longMemories) {
        long.checkpointVersions = Object.fromEntries(f.store.checkpoints.filter(cp => cp.startFloor >= long.startFloor && cp.endFloor <= long.endFloor)
            .map(cp => [cp.id, aggregateVersion(cp)]));
    }
}
const tailFloors = result => result.messages.flatMap(row => row.mes.match(/^\[SUMMARY_STORY_(\d+)\]/)?.[1] ?? []).map(Number);
function sendShort(f, core = structuredClone(f.chat), type = 'normal', published = f.store.injectionSnapshot.value) {
    return filterCoveredHistory(core, f.chat, f.store.injectionSnapshot, published,
        { summaries: f.store.summaries, type, injectionMode: shortMode, recentRawFloors: f.settings.recentRawFloors });
}

test('checkpoint short history holds the CP/Long prefix at 5, 6, 9, 10, 11, 120 and 121 while the tail advances', () => {
    const f = fixture(0, { injectionMode: shortMode, strictCacheMode: false });
    f.chat.pop();
    refreshSnapshot(f.store, f.settings, 'chat changed');
    const expected = new Map([
        [5, [0, [1, 2], [3, 4, 5]]], [6, [0, [1, 2, 3], [4, 5, 6]]], [9, [0, [1, 2, 3, 4, 5, 6], [7, 8, 9]]],
        [10, [5, [6, 7], [8, 9, 10]]], [11, [5, [6, 7, 8], [9, 10, 11]]],
        [120, [115, [116, 117], [118, 119, 120]]], [121, [115, [116, 117, 118], [119, 120, 121]]],
    ]);
    for (let floor = 1; floor <= 121; floor++) {
        addTurn(f.chat, f.store, floor);
        const reason = floor % 50 === 0 ? 'new long memory' : floor % 5 === 0 ? 'new checkpoint' : 'new summary';
        const previous = f.store.injectionSnapshot;
        if (floor % 5 === 0 || expected.has(floor)) prepareShortSources(f);
        refreshSnapshot(f.store, f.settings, reason);
        if (floor % 5 !== 0) assert.equal(f.store.injectionSnapshot, previous);
        if (!expected.has(floor)) continue;
        const [coverage, tail, raw] = expected.get(floor);
        const pending = { name: '旅人', is_user: true, mes: '本轮输入', send_date: 'pending' };
        f.chat.push(pending);
        const original = structuredClone({ chat: f.chat, store: f.store });
        const result = sendShort(f), blocks = storyBlocks(f.store);
        assert.deepEqual(rawFloors(result), raw, `floor ${floor}`);
        assert.deepEqual(tailFloors(result), tail, `floor ${floor}`);
        assert.equal(Math.max(0, ...blocks.map(block => block.endFloor)), coverage);
        assert.equal(result.messages.filter(row => row.is_user).length, 4);
        assert.equal(result.messages.at(-1).mes, '本轮输入');
        assert.equal(result.messages.some(row => row.mes === '初始背景'), floor < 10);
        assert.doesNotMatch(f.store.injectionSnapshot.value, /\[SUMMARY_STORY_/);
        assert.deepEqual(result.retainedOlderFloors, []);
        for (let n = 1; n <= floor; n++) assert.equal(Number(raw.includes(n)) + Number(tail.includes(n))
            + blocks.filter(block => block.startFloor <= n && block.endFloor >= n).length, 1);
        if (floor >= 120) assert.deepEqual(blocks.filter(block => block.type === 'long-story').map(block => block.endFloor), [50, 100]);
        assert.deepEqual({ chat: f.chat, store: f.store }, original);
        f.chat.pop();
    }
});

test('checkpoint short history keeps missing, failed or unverified floors and protects regeneration, opening and latest user', () => {
    const f = fixture(11, { injectionMode: shortMode });
    prepareShortSources(f);
    refreshSnapshot(f.store, f.settings, 'settings changed');
    const frozen = structuredClone(f.store.injectionSnapshot);
    for (const type of ['swipe', 'regenerate', 'continue', 'normal']) {
        const core = structuredClone(f.chat);
        if (['swipe', 'regenerate'].includes(type)) core.splice(core.findIndex(row => row.send_date === 'a11'), 1);
        core.push({ is_system: true, mes: '系统' }, { name: '守卫', mes: '工具', extra: { tool_invocations: [] } });
        const result = sendShort(f, core, type);
        assert.deepEqual(rawFloors(result), ['swipe', 'regenerate'].includes(type) ? [8, 9, 10] : [9, 10, 11]);
        assert.equal(result.messages.filter(row => row.is_system || row.extra?.tool_invocations).length, 2);
        assert.ok(result.messages.some(row => row.mes === '本轮输入'));
    }
    const entry = floor => getAssistantMessages(f.chat).find(row => row.floor === floor);
    delete f.store.summaries[entry(2).messageId];
    f.store.summaries[entry(6).messageId].status = 'failed';
    f.store.summaries[entry(7).messageId].sourceContentFingerprint = 'wrong body';
    f.store.summaries[entry(3).messageId].event = '更新后的旧楼层事实';
    f.chat[0].mes = '开场白已更换';
    const result = sendShort(f);
    assert.deepEqual(rawFloors(result), [2, 6, 7, 9, 10, 11]);
    assert.deepEqual(tailFloors(result), [3, 8]);
    assert.deepEqual(result.retainedOlderFloors, [2, 6, 7]);
    assert.equal(result.messages[0].mes, '开场白已更换');
    assert.deepEqual(f.store.injectionSnapshot, frozen);
    assert.equal(sendShort(f, structuredClone(f.chat), 'normal', 'different prefix').removed, 0);
    f.settings.recentRawFloors = 1;
    assert.deepEqual(rawFloors(sendShort(f)), [2, 6, 7, 11]);
    assert.deepEqual(f.store.injectionSnapshot, frozen);
});

test('default rolling publication has exactly one story source per floor for 105 turns, three raw floors and CP/Long replacements', () => {
    const f = fixture(0); f.chat.pop();
    let previous = '';
    for (let floor = 1; floor <= 105; floor++) {
        addTurn(f.chat, f.store, floor);
        const records = structuredClone(f.store);
        const result = send(f), raw = rawFloors(result), blocks = storyBlocks(f.store);
        assert.deepEqual(raw, Array.from({ length: Math.min(3, floor) }, (_, i) => Math.max(1, floor - 2) + i));
        for (let n = 1; n <= floor; n++) assert.equal(Number(raw.includes(n)) + blocks.filter(block => block.startFloor <= n && block.endFloor >= n).length, 1, `turn ${floor}, history ${n}`);
        assert.ok(blocks.filter(block => block.type === 'summary-story').length <= 4);
        if (floor >= 4) assert.notEqual(f.store.injectionSnapshot.value, previous);
        previous = f.store.injectionSnapshot.value;
        assert.deepEqual(result.retainedOlderFloors, []);
        assert.equal(result.messages.some(row => row.mes === '初始背景'), floor < 8);
        for (const key of ['summaries', 'checkpoints', 'longMemories', 'keepRegistry']) assert.deepEqual(f.store[key], records[key]);
    }
    assert.deepEqual(storyBlocks(f.store).filter(b => b.type === 'long-story').map(b => [b.startFloor, b.endFloor]), [[1, 50], [51, 100]]);
    assert.deepEqual(storyBlocks(f.store).filter(b => b.type === 'summary-story').map(b => b.startFloor), [101, 102]);
});

test('rolling takes precedence over strict freezing, latest user selection is independent and recent window is configurable', () => {
    for (const strictCacheMode of [true, false]) for (const lastUserOnly of [true, false]) for (const recentRawFloors of [1, 3, 5]) {
        const f = fixture(12, { strictCacheMode, lastUserOnly, recentRawFloors, historyHandoff: false });
        const original = structuredClone(f.chat), result = send(f);
        assert.equal(rawFloors(result).length, recentRawFloors);
        assert.equal(result.messages.filter(row => row.is_user).length, lastUserOnly ? 1 : recentRawFloors + 1);
        assert.equal(effectiveInjectionMode(f.settings), INJECTION_MODES.ROLLING);
        assert.equal(shouldRefreshInjection(f.settings, 'new summary'), true);
        assert.deepEqual(f.chat, original);
    }
    for (const [value, expected] of [[0, 1], [Infinity, 3], ['5', 5], [101, 100], ['', 3]]) assert.equal(normalizeSettings({ recentRawFloors: value }).recentRawFloors, expected);
});

test('missing or failed CP uses summaries; missing, failed or state-only summary keeps only its uncovered raw turn and reports it', () => {
    const f = fixture(12);
    f.store.checkpoints = [];
    let result = send(f);
    assert.deepEqual(rawFloors(result), [10, 11, 12]);
    assert.equal(storyBlocks(f.store).filter(b => b.type === 'summary-story').length, 9);
    const entry = getAssistantMessages(f.chat).find(row => row.floor === 4);
    delete f.store.summaries[entry.messageId];
    result = send(f);
    assert.deepEqual(rawFloors(result), [4, 10, 11, 12]);
    assert.deepEqual(result.retainedOlderFloors, [4]);
    for (const record of [{ status: 'failed', event: '旧的失败结果' }, { status: 'frozen', state: '只有状态，不能代替剧情' }]) {
        f.store.summaries[entry.messageId] = { messageId: entry.messageId, floor: 4, ...record };
        assert.deepEqual(rawFloors(send(f)), [4, 10, 11, 12]);
    }
});

test('Rolling keeps 3 of 76 raw turns when four covered sources have stale swipe metadata or competing saved aliases', () => {
    const f = fixture(76);
    const entries = getAssistantMessages(f.chat);
    for (const floor of [18, 24, 31, 57]) {
        const entry = entries[floor - 1], summary = f.store.summaries[entry.messageId];
        if (floor < 30) {
            const old = { send_date: `saved-a${floor}`, gen_started: `saved-g${floor}`, extra: {} };
            summary.sourceFingerprint = messageFingerprint({ ...entry.message, ...old, swipe_id: 0 });
            delete summary.sourceContentFingerprint;
            entry.message.swipe_id = 1;
            entry.message.swipes = [entry.message.mes, entry.message.mes];
            entry.message.swipe_info = [old, { send_date: entry.message.send_date, gen_started: entry.message.gen_started }];
        } else {
            f.store.summaries[entries[floor].messageId].sourceMessageKey = entry.messageId;
        }
    }
    const result = send(f);
    assert.deepEqual(rawFloors(result), [74, 75, 76]);
    assert.deepEqual(result.recentFloors, [74, 75, 76]);
    assert.deepEqual(result.retainedOlderDetails, []);
    assert.deepEqual(storyBlocks(f.store).filter(b => b.type === 'summary-story').map(b => b.startFloor), [71, 72, 73]);
    f.chat.find(row => row.send_date === 'a18').mes += '新增的当前正文';
    const changed = send(f);
    assert.deepEqual(rawFloors(changed), [18, 74, 75, 76]);
    assert.deepEqual(changed.retainedOlderDetails, [{ floor: 18, reason: 'summary-source-unverified' }]);
});

test('swipe/regenerate retain three available raw replies without overlapping summary and protect system/tools', () => {
    const f = fixture(12);
    for (const type of ['swipe', 'regenerate', 'continue', 'normal']) {
        const core = structuredClone(f.chat);
        if (['swipe', 'regenerate'].includes(type)) core.splice(core.findIndex(row => row.send_date === 'a12'), 1);
        core.push({ is_system: true, mes: '系统' }, { name: '守卫', mes: '工具', extra: { tool_invocations: [] } });
        const original = structuredClone(f.chat), result = send(f, core, type), raw = rawFloors(result);
        assert.deepEqual(raw, ['swipe', 'regenerate'].includes(type) ? [9, 10, 11] : [10, 11, 12]);
        for (const floor of raw) assert.equal(storyBlocks(f.store).some(b => b.startFloor <= floor && b.endFloor >= floor), false);
        assert.equal(result.messages.filter(row => row.is_system || row.extra?.tool_invocations).length, 2);
        assert.deepEqual(f.chat, original);
    }
    for (const type of ['quiet', 'impersonate']) assert.equal(send(f, structuredClone(f.chat), type).removed, 0);
});

test('empty, mismatched or unpublished projections cannot remove raw history; same-ID body edits stay visible', () => {
    const f = fixture(12); send(f);
    const snapshot = f.store.injectionSnapshot;
    assert.equal(filterCoveredHistory(structuredClone(f.chat), f.chat, snapshot, 'not published', { summaries: f.store.summaries }).removed, 0);
    const empty = fixture(12); empty.store.summaries = {}; empty.store.checkpoints = [];
    assert.equal(send(empty).removed, 0);
    assert.equal(send(empty).retainedOlderFloors.length, 9);
    f.chat.find(row => row.send_date === 'a4').mes = '正文4：人工改写的新事实';
    assert.ok(rawFloors(send(f)).includes(4));
});

test('regex text-only identities use verified original indices without editing stored chat', () => {
    const f = fixture(12); f.store.summaries = {}; f.store.checkpoints = [];
    for (const row of f.chat) { delete row.send_date; delete row.gen_started; }
    for (const entry of getAssistantMessages(f.chat)) f.store.summaries[entry.messageId] = { messageId: entry.messageId, floor: entry.floor, event: `剧情${entry.floor}`, status: 'frozen', sourceContentFingerprint: entry.contentFingerprint };
    const original = structuredClone(f.chat);
    const core = structuredClone(f.chat).map((row, index) => ({ ...row, index, mes: `过滤后${row.mes.slice(0, 10)}` }));
    const result = send(f, core);
    assert.equal(result.messages.filter(row => row.mes.startsWith('过滤后正文')).length, 3);
    assert.deepEqual(f.chat, original);
});

test('rolling reload rebuilds old inflated snapshots, preserves durable KEEP and reports summary blocks in overview', () => {
    const f = fixture(12);
    f.store.injectionSnapshot = { mode: INJECTION_MODES.CHECKPOINT_BOUNDARY, value: '旧的庞大冻结字节', blocks: [] };
    f.store.keepRegistry['KEEP-0001'] = { text: '守卫知道密道，旅人不知道', status: 'active', sourceFloor: 1 };
    refreshSnapshot(f.store, { ...f.settings, injectionFloor: 12 }, 'chat changed');
    assert.doesNotMatch(f.store.injectionSnapshot.value, /旧的庞大冻结字节/);
    assert.match(f.store.injectionSnapshot.value, /守卫知道密道，旅人不知道/);
    const stats = memoryOverviewStats(f.store, getAssistantMessages(f.chat), f.settings);
    assert.equal(stats.injectedSummaries, 4); assert.equal(stats.injectedCheckpoints, 1);
    assert.match(stats.recentBodyWindow, /最近3层/);
    assert.match(configTemplate(), /data-setting="recentRawFloors"/);
    assert.equal(normalizeLoadedSettings({ injectionMode: 'checkpoint_boundary', prompts: { summary: '自定义' } }).prompts.summary, '自定义');
});

test('default automatic Summary/CP/Long pipeline publishes each floor with exactly the existing model request count', async () => {
    const chat = [{ name: '守卫', mes: '初始背景' }], metadata = {}, requests = [], settings = normalizeSettings({ globalPromptMode: 'blank' });
    const store = new MemoryStore({ getMetadata: () => metadata, getChatId: () => 'automatic', saveMetadata() {},
        onChange: (current, reason) => refreshSnapshot(current, { ...settings, injectionFloor: getAssistantMessages(chat).at(-1)?.floor ?? 0 }, reason) });
    const summarizer = new MemorySummarizer({ store, getChat: () => chat, getSettings: () => settings,
        apiClient: { complete: async request => {
            requests.push(request);
            return { content: request.userContent.startsWith('[EXISTING_LONG_FACTS]') ? '[STORY_ARC]\n旅人完成探访并归还钥匙。'
                : request.userContent.startsWith('[PREVIOUS_CONTEXT]') ? '[CHECKPOINT]\n[Stage Story]\n旅人探访城门，守卫交还钥匙。'
                    : '[SUMMARY]\n[Event]\n旅人探访城门，守卫答应归还钥匙。' };
        } } });
    for (let floor = 1; floor <= 55; floor++) {
        chat.push({ name: '旅人', is_user: true, mes: `请求${floor}`, send_date: `u${floor}` }, { name: '守卫', mes: `守卫答复${floor}`, gen_started: `g${floor}` });
        await summarizer.summarizeEntry(getAssistantMessages(chat).at(-1));
        if (floor > 3) assert.ok(storyBlocks(store.current()).length);
    }
    assert.equal(requests.length, 55 + 11 + 1);
    assert.equal(store.current().checkpoints.length, 11); assert.equal(store.current().longMemories.length, 1);
    assert.deepEqual(storyBlocks(store.current()).map(row => row.type), ['long-story', 'summary-story', 'summary-story']);
});


test('a body-verified loaded tail preserves absolute historical publication and all available raw replies', () => {
    const f = fixture(105);
    f.chat = [f.chat[0], ...f.chat.filter(row => /^(?:a|u)10[3-5]$/.test(row.send_date ?? '')), f.chat.at(-1)];
    assert.equal(promptHistoryFloor(f.chat, f.chat, f.store.summaries), 105);
    const result = send(f);
    assert.deepEqual(rawFloors(result), [103, 104, 105]);
    assert.deepEqual(storyBlocks(f.store).filter(b => b.type === 'long-story').map(b => b.endFloor), [50, 100]);
    assert.deepEqual(storyBlocks(f.store).filter(b => b.type === 'summary-story').map(b => b.endFloor), [101, 102]);
});
