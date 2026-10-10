import test from 'node:test';
import assert from 'node:assert/strict';
import { createEmptyStore, MemoryStore } from '../src/memory-store.js';
import { stateId, parseStateChanges, projectActiveState, reconcileTrackedCheckpoint } from '../src/active-state.js';
import { refreshSnapshot } from '../src/cache-control.js';
import { formatKeepItems } from '../src/continuity.js';
import { normalizeSettings } from '../src/defaults.js';
import { getAssistantMessages } from '../src/utils.js';

const task = { kind: 'thread', entity: '角色甲', key: '新手任务：归还书本', value: '尚待结算', status: 'active', acquisition: 'pending', evidence: '系统正式发布归还书本任务' };
const attribute = { kind: 'state', entity: '角色乙', category: 'attribute', key: '警戒值', value: '46', status: 'active', evidence: '警戒值显示为46', acquisition: 'obtained' };
function put(store, floor, changes, extra = {}) {
    store.summaries[`m${floor}`] = { messageId: `m${floor}`, floor, status: 'frozen', event: '合成剧情', sourceFingerprint: `fp${floor}`,
        stateChanges: changes.map(row => ({ id: stateId(row), ...row })), ...extra };
}
function longResult(status = 'completed', extra = {}) {
    return { id: 'long-001', startFloor: 1, endFloor: 50, status: 'frozen', memoryKind: 'facts', factUpdates: [],
        continuityState: `[Open Threads]\n- 已结束 角色甲 · 新手任务：归还书本：任务结算已结束 (${status}，历史结果)`, ...extra };
}

test('beginner task wrappers share one identity and ended results match plain or bracketed checkpoint lines', () => {
    const store = createEmptyStore('a'); put(store, 14, [task]);
    put(store, 15, [{ ...task, key: '归还书本', id: 'other-legacy-id', status: 'completed', value: '已完成并领取奖励' }]);
    put(store, 200, [{ ...task, key: '任务：【归还书本】' }]);
    const rows = projectActiveState(store);
    assert.equal(rows.length, 1); assert.equal(rows[0].status, 'completed');
    const change = { ...task, key: '归还书本', confirmed: true };
    assert.equal(parseStateChanges(JSON.stringify([change]), task.evidence, rows)[0].id, rows[0].id);
    const result = reconcileTrackedCheckpoint('[Story So Far]\n过去归还书本引发误会\n[Open Threads]\n- 角色甲 · 归还书本：尚未领取\n- 角色甲 · 任务：【归还书本】：尚未领取\n- 角色丙 · 归还书本：尚未领取\n- 角色甲 · 归还书本（第二次）：新任务', store, 205, 201);
    assert.doesNotMatch(result, /角色甲 · (?:归还书本：|任务：【归还书本】)/);
    assert.match(result, /过去归还书本引发误会/); assert.match(result, /角色丙 · 归还书本/); assert.match(result, /第二次/);
});

test('the displayed numeric alias inherits the latest evidenced value without merging independent attributes', () => {
    const store = createEmptyStore('a'); put(store, 30, [attribute]);
    put(store, 190, [{ ...attribute, id: 'display-alias-id', key: '警戒值/红字数值', value: '100%（由80%升至100%）', evidence: '红字警戒值变成100%' }]);
    const rows = projectActiveState(store); assert.equal(rows.length, 1); assert.equal(rows[0].sourceFloor, 190);
    const delta = { ...attribute, id: rows[0].id, key: '警戒值/红字数值', value: '101%', confirmed: true, evidence: '警戒值变成101%' };
    delete delta.category;
    assert.equal(parseStateChanges(JSON.stringify([delta]), delta.evidence, rows)[0].id, rows[0].id);
    const text = '[Story So Far]\n早先警戒值46时曾放行\n[Current State]\n- 角色乙 · 警戒值：46\n- 角色乙 · 警戒值/红字数值：100%\n- 角色丙 · 警戒值：46';
    const result = reconcileTrackedCheckpoint(text, store, 205, 201);
    assert.match(result, /早先警戒值46时曾放行/); assert.doesNotMatch(result, /角色乙 · 警戒值：46/);
    assert.equal((result.match(/角色乙 · 警戒值/g) ?? []).length, 1); assert.match(result, /角色丙 · 警戒值：46/);
    assert.notEqual(stateId({ ...attribute, key: '生命/魔力' }), stateId({ ...attribute, key: '生命' }));
});

test('orphaned deltas cannot replace a verified current value or task settlement', () => {
    const store = createEmptyStore('a'); put(store, 1, [attribute, { ...task, status: 'completed' }]);
    put(store, 2, [{ ...attribute, value: '999' }, task], { status: 'orphaned' });
    const rows = projectActiveState(store);
    assert.equal(rows.find(x => x.kind === 'state').value, '46');
    assert.equal(rows.find(x => x.kind === 'thread').status, 'completed');
    assert.ok(rows.every(x => !x.needsReview));
});

test('a verified structured Long settlement closes a task whose old completion Summary is unavailable', () => {
    const store = createEmptyStore('a'); put(store, 14, [{ ...task, key: '归还书本' }]);
    store.longMemories.push(longResult());
    assert.equal(projectActiveState(store, 49)[0].status, 'active');
    assert.equal(projectActiveState(store, 205)[0].status, 'completed');
    assert.equal(projectActiveState(store, 205)[0].needsReview, false);
    store.longMemories[0].sourceReplaced = true;
    assert.equal(projectActiveState(store, 205)[0].status, 'active');
    store.longMemories[0] = longResult('completed', { continuityState: '据说任务可能已经完成' });
    assert.equal(projectActiveState(store, 205)[0].status, 'active');
});

test('failed and cancelled tasks also stay ended; explicit manual corrections keep priority over Long fallback', () => {
    for (const status of ['failed', 'cancelled']) {
        const store = createEmptyStore('a'); put(store, 1, [{ ...task, status }]); put(store, 2, [task]);
        assert.equal(projectActiveState(store)[0].status, status);
    }
    const store = createEmptyStore('a'); put(store, 1, [task]);
    store.stateOverrides.correction = { ...task, id: stateId(task), sourceId: 'm1', sourceFingerprint: 'fp1', sourceFloor: 1, sequence: 1, manual: true, value: '人工纠正：仍未完成' };
    store.longMemories.push(longResult());
    assert.equal(projectActiveState(store)[0].value, '人工纠正：仍未完成');
});

test('manual reinjection uses matching Summary deltas and Long settlements while background publication stays frozen', () => {
    const chat = Array.from({ length: 205 }, (_, i) => ({ name: 'A', mes: `合成正文${i + 1}`, gen_started: `g${i}` }));
    const metadata = {}, store = new MemoryStore({ getMetadata: () => metadata, getChatId: () => 'a', saveMetadata() {} });
    const data = store.current(), entries = getAssistantMessages(chat);
    for (const [floor, changes] of [[14, [{ ...task, key: '归还书本' }]], [30, [attribute]], [190, [{ ...attribute, key: '警戒值/红字数值', value: '100%', evidence: '警戒值已明确升至100%' }]]]) {
        const entry = entries[floor - 1];
        data.summaries[entry.messageId] = { messageId: entry.messageId, floor, status: 'frozen', event: '合成摘要', sourceContentFingerprint: entry.contentFingerprint,
            stateChanges: changes.map(row => ({ ...row, id: stateId(row) })) };
    }
    data.summaries.old = { messageId: 'old', floor: 200, status: 'frozen', event: '旧 Swipe', sourceContentFingerprint: 'old-body', stateChanges: [{ ...attribute, id: stateId(attribute), value: '999' }] };
    data.longMemories.push(longResult());
    const content = '[Story So Far]\n历史警戒值46造成误会\n[Current State]\n- 角色乙 · 警戒值：46\n- 角色乙 · 警戒值/红字数值：100%\n[Open Threads]\n- 角色甲 · 归还书本：尚未领取';
    data.checkpoints.push({ id: 'checkpoint-041', startFloor: 201, endFloor: 205, memoryKind: 'state', status: 'frozen', content });
    const settings = normalizeSettings();
    data.injectionSnapshot = { signature: JSON.stringify([settings.enabled, true, settings.injectionMode]), value: 'original published bytes', blocks: [] };
    assert.equal(refreshSnapshot(data, settings, 'new summary').value, 'original published bytes');
    const sourceView = { ...data, summaries: Object.fromEntries(store.currentSummaries(chat).map(row => [row.messageId, row])) };
    const before = JSON.stringify({ summaries: data.summaries, longMemories: data.longMemories, checkpoints: data.checkpoints });
    const output = refreshSnapshot(data, settings, 'manual reinject', sourceView).value;
    assert.doesNotMatch(output, /尚未领取|警戒值：46|999/); assert.match(output, /历史警戒值46造成误会/); assert.match(output, /警戒值\/红字数值：100%/);
    assert.equal(JSON.stringify({ summaries: data.summaries, longMemories: data.longMemories, checkpoints: data.checkpoints }), before);
});

test('overlapping KEEP entries retain unique causes and observer knowledge; only exact duplicates are omitted', () => {
    const items = [
        { id: 'KEEP-0001', status: 'active', text: '后台草稿考虑角色乙离场；修复机制寻找新锚点，角色乙可能消失。' },
        { id: 'KEEP-0002', status: 'active', text: '后台草稿考虑角色乙离场，角色甲知晓，角色乙不知情。' },
        { id: 'KEEP-0003', status: 'active', text: '角色甲觉醒剧情并绑定系统，知晓角色丙图谋家产。' },
        { id: 'KEEP-0004', status: 'active', text: '角色甲觉醒剧情并绑定系统，知晓原定结局及剧情偏移原因。' },
    ];
    const before = structuredClone(items), result = formatKeepItems([...items, { ...items[0], id: 'KEEP-0005' }]);
    for (const row of items) assert.ok(result.includes(row.text));
    assert.doesNotMatch(result, /KEEP-0005/); assert.deepEqual(items, before);
});
