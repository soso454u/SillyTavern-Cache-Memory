import test from 'node:test';
import assert from 'node:assert/strict';
import { CacheMemoryUI, memoryOverviewStats } from '../src/ui.js';
import { normalizeSettings } from '../src/defaults.js';
import { createEmptyStore, MemoryStore } from '../src/memory-store.js';
import { MemorySummarizer } from '../src/summarizer.js';
import { getAssistantMessages } from '../src/utils.js';
import { stateId } from '../src/active-state.js';
import { refreshSnapshot } from '../src/cache-control.js';

class Element {
    constructor(tag, text = '') { this.tag = tag; this.textContent = text ?? ''; this.children = []; this.dataset = {}; this.attributes = {}; }
    append(...children) { this.children.push(...children); }
    setAttribute(key, value) { this.attributes[key] = value; }
    addEventListener() {}
    querySelector(tag) { return this.children.find(child => child.tag === tag); }
}
const contents = node => [node.textContent, ...node.children.map(contents)].join(' ');
const descendants = node => [node, ...node.children.flatMap(descendants)];

test('all four tables have independent view buttons and counts; browsing unselected tables works with tables disabled and changes no memory/settings', async () => {
    const data = createEmptyStore('a'), settings = normalizeSettings({ characterTables: { characters: false, knowledge: false, relationships: false, tasks: true } });
    const changes = [
        { kind: 'state', entity: '医师', key: '身份', value: '守卫的姐姐', category: 'identity' },
        { kind: 'state', entity: '医师', key: '密道', value: '医师知道密道，守卫不知道', category: 'knowledge' },
        { kind: 'thread', entity: '守卫', key: '护送', value: '先护送村民', category: 'task' },
    ].map(row => ({ ...row, status: 'active', lifetime: 'permanent', id: stateId(row), evidence: '有效原文证据' }));
    data.summaries.m1 = { messageId: 'm1', floor: 1, event: '医师与守卫交谈', status: 'frozen', stateChanges: changes };
    data.injectionSnapshot = { value: '冻结内容保持', blocks: [] };
    const before = structuredClone(data), beforeSettings = structuredClone(settings);
    const ui = Object.assign(Object.create(CacheMemoryUI.prototype), {
        element: (tag, _class, text) => new Element(tag, text), controller: new AbortController(), getSettings: () => settings,
        getChat: () => [], store: { current: () => data, effectiveStore: () => data },
        renderManager() { this.rendered = this.renderCharacterTablesPage(); },
        updateSettings() { assert.fail('view cannot change preferences'); }, updateInjection() { assert.fail('view cannot publish a snapshot'); },
    });
    ui.renderManager();
    assert.equal(descendants(ui.rendered).filter(node => node.dataset.viewCharacterTable).length, 4);
    assert.match(contents(ui.rendered), /守卫的姐姐/); assert.doesNotMatch(contents(ui.rendered), /医师知道密道，守卫不知道/);
    await ui.handleManagerClick({ target: { closest: selector => selector === '[data-view-character-table]' ? { dataset: { viewCharacterTable: 'knowledge' } } : null } });
    assert.equal(ui.characterTableView, 'knowledge'); assert.match(contents(ui.rendered), /医师知道密道，守卫不知道/);
    assert.doesNotMatch(contents(ui.rendered), /守卫的姐姐/); assert.match(contents(ui.rendered), /当前未启用，仅查看/);
    const view = descendants(ui.rendered).find(node => node.dataset.viewCharacterTable === 'knowledge');
    assert.equal(view.textContent, '查看 · 1 项');
    await ui.handleManagerClick({ target: { closest: selector => selector === '[data-view-character-table]' ? { dataset: { viewCharacterTable: 'relationships' } } : null } });
    assert.match(contents(ui.rendered), /这张表暂无已存资料/);
    assert.deepEqual(data, before); assert.deepEqual(settings, beforeSettings);
});

function fixture(loadedFloors = 145) {
    const settings = normalizeSettings(), metadata = {};
    const chat = Array.from({ length: loadedFloors }, (_, i) => ({ name: '医师', mes: `正文${i}`, gen_started: `g${i}` }));
    const store = new MemoryStore({ getMetadata: () => metadata, getChatId: () => 'a', saveMetadata() {}, onChange: (data, reason) => refreshSnapshot(data, settings, reason) });
    for (const entry of getAssistantMessages(chat).slice(-3)) store.addSummary({ messageId: entry.messageId, floor: entry.floor, event: '仅有近期三条摘要', status: 'frozen' });
    for (let start = 1; start <= 145; start += 5) store.addCheckpoint({ id: `cp-${start}`, startFloor: start, endFloor: start + 4,
        content: `[CHECKPOINT]\n[Stage Story]\n阶段${start}：医师交还钥匙，守卫承诺天亮归还。`, status: 'frozen' });
    const requests = [];
    const summarizer = new MemorySummarizer({ store, getSettings: () => settings, getChat: () => chat, apiClient: { complete: async request => {
        assert.ok(request.userContent.startsWith('[EXISTING_LONG_FACTS]'), 'only Long may be requested'); requests.push(request);
        return { content: '[STORY_ARC]\n医师与守卫围绕钥匙与护送作出承诺并执行。\n[LONG_MEMORY]\n无\n[UPDATED_FACTS]\n无\n[RETIRED_FACTS]\n无' };
    } } });
    return { store, summarizer, requests, settings, chat };
}

for (const loaded of [145, 3]) test(`Long-only synthesis uses existing CPs with ${loaded} loaded floors and no historical Summary backfill`, async () => {
    const f = fixture(loaded), before = structuredClone(f.store.current());
    const plan = f.summarizer.getMissingMemoryPlan({ onlyLong: true });
    assert.deepEqual(plan.summaries, []); assert.deepEqual(plan.checkpoints, []);
    assert.deepEqual(plan.longMemories, [{ startFloor: 1, endFloor: 50 }, { startFloor: 51, endFloor: 100 }]);
    assert.equal(memoryOverviewStats(f.store.current(), getAssistantMessages(f.chat), f.settings).longMemories.expected, 2);
    assert.equal(f.requests.length, 0);
    const result = await f.summarizer.fillMissingMemories({ onlyLong: true });
    assert.equal(result.failed, 0); assert.equal(result.created, 2); assert.equal(f.requests.length, 2);
    assert.deepEqual(f.store.current().summaries, before.summaries); assert.deepEqual(f.store.current().checkpoints, before.checkpoints);
    const blocks = f.store.current().injectionSnapshot.blocks;
    assert.deepEqual(blocks.filter(row => row.type === 'long-story').map(row => [row.startFloor, row.endFloor]), [[1,50],[51,100]]);
    assert.equal(blocks.filter(row => row.type === 'checkpoint').length, 9);
    assert.equal(blocks.find(row => row.type === 'checkpoint').startFloor, 101);
    assert.equal((await f.summarizer.fillMissingMemories({ onlyLong: true })).created, 0); assert.equal(f.requests.length, 2);
});

test('missing CP sources block only their Long range and never trigger floor or CP generation', async () => {
    const f = fixture(); f.store.current().checkpoints = f.store.current().checkpoints.filter(row => row.startFloor !== 26);
    const before = structuredClone(f.store.current()), plan = f.summarizer.getMissingMemoryPlan({ onlyLong: true });
    assert.deepEqual(plan.blockedLongMemories, [{ startFloor: 1, endFloor: 50, missingFrom: 26 }]);
    assert.deepEqual(plan.longMemories, [{ startFloor: 51, endFloor: 100 }]);
    const result = await f.summarizer.fillMissingMemories({ onlyLong: true });
    assert.equal(result.created, 1); assert.equal(f.requests.length, 1);
    assert.deepEqual(f.store.current().summaries, before.summaries); assert.deepEqual(f.store.current().checkpoints, before.checkpoints);
});

test('diagnostics explain missing Long stories and never count the supplemental facts block as a generated big summary', () => {
    const f = fixture();
    f.store.current().injectionSnapshot.blocks.push({ type: 'long', id: 'long:current-facts', text: '[LONG_MEMORY]\n独立长期事实' });
    const stats = memoryOverviewStats(f.store.current(), getAssistantMessages(f.chat), f.settings);
    assert.equal(stats.injectedLongMemories, 0); assert.match(stats.injectionExplanation, /尚缺大总结[\s\S]*1–50[\s\S]*51–100/);
});

test('the Long-only UI completes eligible ranges while reporting source gaps separately', async () => {
    const f = fixture(); f.store.current().checkpoints = f.store.current().checkpoints.filter(row => row.startFloor !== 26);
    const ui = Object.assign(Object.create(CacheMemoryUI.prototype), { store: f.store, summarizer: f.summarizer,
        persistence: { epoch: 1 }, missingCheckpointRunId: 0, missingCheckpointState: { status: 'idle' },
        renderManager() {}, renderMessageMemories() {}, showTaskProgress() {} });
    await ui.startMissingMemoryBackfill({ onlyLong: true });
    assert.equal(ui.missingCheckpointState.status, 'completed'); assert.equal(ui.missingCheckpointState.created, 1);
    assert.equal(f.requests.length, 1); assert.equal(ui.missingCheckpointController, null);
    assert.equal(f.summarizer.getMissingMemoryPlan({ onlyLong: true }).blockedLongMemories.length, 1);
});
