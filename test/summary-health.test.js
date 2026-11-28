import test from 'node:test';
import assert from 'node:assert/strict';
import { CacheMemoryUI, memoryOverviewStats, summaryHealthDetails } from '../src/ui.js';
import { getSummaryEntries } from '../src/opening-source.js';
import { normalizeSettings } from '../src/defaults.js';

function fixture({ opening = true, count = 4 } = {}) {
    const chat = [ ...(opening ? [{ mes: '开场约定', send_date: 'opening' }] : []),
        ...Array.from({ length: count }, (_, i) => ({ mes: `合成正文${i + 1}`, gen_started: `g${i}` })) ];
    const entries = getSummaryEntries(chat), settings = normalizeSettings();
    const store = { summaries: {}, checkpoints: [], longMemories: [], keepRegistry: {} };
    return { chat, entries, settings, store };
}

class Element {
    constructor(tag, className = '', textContent = '') { Object.assign(this, { tag, className, textContent, dataset: {}, children: [] }); }
    append(...nodes) { this.children.push(...nodes); }
    setAttribute(name, value) { this[name] = value; }
}
const descendants = node => [node, ...node.children.flatMap(descendants)];
function renderOverview(f) {
    const ui = new CacheMemoryUI({ getChat: () => f.chat, getSettings: () => f.settings, store: { current: () => f.store } });
    ui.element = (...args) => new Element(...args);
    ui.manager = { querySelector: () => null };
    ui.showSummaryHealthDetails = true;
    for (const method of ['backfillPanel', 'aggregationPanel', 'longMemoryControls']) ui[method] = () => new Element('div');
    return ui.renderOverview();
}
function renderHealth(f) { return descendants(renderOverview(f)).find(node => node.className === 'cache-memory-health'); }

test('screenshot: missing opening and replies show consecutive visible floors and a repair action', () => {
    const f = fixture(), before = structuredClone(f.store);
    const stats = memoryOverviewStats(f.store, f.entries, f.settings);
    assert.deepEqual(stats.summaries, { actual: 0, generated: 0, expected: 5 });
    assert.match(stats.issues[0], /第1层（开场白）/);
    assert.match(stats.issues[0], /第5层/);
    assert.doesNotMatch(stats.issues[0], /第0层/);
    const details = descendants(renderHealth(f)).find(node => node.className === 'cache-memory-summary-health-details');
    const rows = descendants(details).filter(node => node.tag === 'li').map(node => node.textContent);
    assert.deepEqual(rows, Array.from({ length: 5 }, (_, i) => `第 ${i + 1} 层${i === 0 ? ' · 开场白' : ''} · 尚未生成摘要，可补全`));
    assert.match(stats.injectionExplanation, /开场白也计入此上限/);
    assert.match(stats.injectionExplanation, /缺少摘要时，旧正文仍会按上限省略/);
    assert.match(stats.repairExplanation, /一键补全所有记忆[\s\S]*连接测试[\s\S]*生成日志/);
    assert.deepEqual(f.store, before);
});

test('disabling opening auto-summaries hides only the opening from overview completion counts', () => {
    const f = fixture(); f.store.autoSummarizeOpening = false;
    const stats = memoryOverviewStats(f.store, f.entries, f.settings);
    assert.deepEqual(stats.summaries, { actual: 0, generated: 0, expected: 4 });
    assert.doesNotMatch(stats.issues.join('\n'), /开场白/);
    assert.deepEqual(stats.summaryDetails.map(row => row.floor), [1, 2, 3, 4]);
    const checkbox = descendants(renderOverview(f)).find(node => node.dataset.openingAutosummary === '');
    assert.equal(checkbox.checked, false);
    assert.equal(checkbox.disabled, false);
});

test('overview opening preference change is saved for this chat and rerenders without altering memory', () => {
    const f = fixture(); let renders = 0, status = '';
    const ui = new CacheMemoryUI({ getChat: () => f.chat, getSettings: () => f.settings, store: {
        current: () => f.store,
        setAutoSummarizeOpening: value => { f.store.autoSummarizeOpening = value; },
    } });
    ui.renderManager = () => { renders++; };
    ui.setManagerActionStatus = (_state, message) => { status = message; };
    const target = { checked: false, dataset: { openingAutosummary: '' }, matches: selector => selector === '[data-opening-autosummary]' };
    ui.handleManagerInput({ type: 'change', target });
    assert.equal(f.store.autoSummarizeOpening, false);
    assert.equal(renders, 1);
    assert.match(status, /不会删除/);
});

test('a failed opening keeps its actual error while usable saved summaries stay untouched', () => {
    const f = fixture();
    for (const entry of f.entries) f.store.summaries[entry.messageId] = {
        messageId: entry.messageId, floor: entry.floor, event: '已保存的约定', status: 'frozen', sourceContentFingerprint: entry.contentFingerprint,
    };
    Object.assign(f.store.summaries[f.entries[0].messageId], { event: '', status: 'failed', error: '独立接口连接失败' });
    const before = structuredClone(f.store);
    const stats = memoryOverviewStats(f.store, f.entries, f.settings);
    assert.equal(stats.summaries.generated, 4);
    assert.equal(stats.summaryDetails.length, 1);
    assert.match(stats.issues[0], /第1层（开场白）：生成失败：独立接口连接失败/);
    assert.deepEqual(f.store, before);
});

test('chats with a generated first reply keep their original visible floor numbering', () => {
    const f = fixture({ opening: false });
    const stats = memoryOverviewStats(f.store, f.entries, f.settings);
    assert.match(stats.issues[0], /第1层：/);
    assert.match(stats.issues[0], /第4层：/);
    assert.doesNotMatch(stats.issues[0], /开场白|第5层/);
    const rows = descendants(renderHealth(f)).filter(node => node.tag === 'li');
    assert.ok(rows.some(node => node.textContent === '第 1 层 · 尚未生成摘要，可补全'));
});

test('stored floor zero and a record without a floor remain distinct in diagnostics', () => {
    const f = fixture();
    f.store.summaries.oldOpening = { floor: 0, status: 'failed', error: '旧错误记录' };
    f.store.summaries.unloaded = { event: '来源未加载', status: 'frozen' };
    const details = summaryHealthDetails(f.store, f.entries);
    assert.equal(details.find(row => row.messageId === 'oldOpening').floor, 0);
    assert.equal(details.find(row => row.messageId === 'unloaded').floor, null);
    const rows = descendants(renderHealth(f)).filter(node => node.tag === 'li').map(node => node.textContent);
    assert.ok(rows.some(text => text.startsWith('楼层未定位 · 来源消息当前未加载')));
    assert.ok(rows.some(text => text.startsWith('第 1 层 · 来源消息当前未加载')));
    assert.ok(rows.every(text => !text.includes('未知') && !text.includes('第 0 层')));
});

test('overview stage and long gaps use visible ranges while stored grouping stays stable', () => {
    const f = fixture({ count: 10 }); f.settings.longMemoryInterval = 5;
    const stats = memoryOverviewStats(f.store, f.entries, f.settings);
    assert.match(stats.issues[1], /第1–6层[\s\S]*第7–11层/);
    assert.match(stats.issues[2], /第1–6层[\s\S]*第7–11层/);
    assert.deepEqual(stats.aggregateDetails.filter(row => row.type === 'Checkpoint').map(row => [row.startFloor, row.endFloor]), [[1, 5], [6, 10]]);
    f.store.checkpoints.push({ id: 'cp1', startFloor: 1, endFloor: 5, content: '已保存的阶段', status: 'frozen' });
    f.settings.injectionMode = 'checkpoint_boundary';
    assert.match(memoryOverviewStats(f.store, f.entries, f.settings).injectionExplanation, /尚缺大总结：第1–6层、第7–11层/);
});

test('healthy summaries do not show a missing-summary repair explanation', () => {
    const f = fixture();
    for (const entry of f.entries) f.store.summaries[entry.messageId] = { floor: entry.floor, event: '已有事实', status: 'frozen' };
    const stats = memoryOverviewStats(f.store, f.entries, f.settings);
    assert.equal(stats.repairExplanation, '');
    assert.deepEqual(stats.summaryDetails, []);
});
