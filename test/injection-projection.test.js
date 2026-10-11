import test from 'node:test';
import assert from 'node:assert/strict';
import { createEmptyStore } from '../src/memory-store.js';
import { refreshSnapshot } from '../src/cache-control.js';
import { buildInjection } from '../src/injection.js';
import { normalizeSettings, INJECTION_MODES } from '../src/defaults.js';
import { stateId } from '../src/active-state.js';

const skill = { kind: 'state', entity: '主角', key: '洞察', value: 'Lv.2', status: 'active', category: 'skill', lifetime: 'permanent', evidence: '系统确认能力升级' };
const task = { kind: 'thread', entity: '主角', key: '送信', value: '去旧城送信', status: 'active', evidence: '系统正式发布任务' };
const summary = (floor, changes) => ({ messageId: `m${floor}`, floor, event: '合成事件', status: 'frozen', frozen: true, stateChanges: changes.map(change => ({ ...change, id: stateId(change) })) });
const cp = (n, content) => ({ id: `checkpoint-${n}`, startFloor: n * 5 - 4, endFloor: n * 5, memoryKind: 'state', content, status: 'frozen', frozen: true });
const long = (n, updates, continuityState = '') => ({ id: `long-${n}`, startFloor: n * 50 - 49, endFloor: n * 50, memoryKind: 'facts', content: '完整原始模型输出', factUpdates: updates, continuityState, status: 'frozen', frozen: true });

test('Long boundary compacts only proven old states and exact facts, retaining major history and independent knowledge', () => {
    const store = createEmptyStore('a'), settings = normalizeSettings();
    store.summaries.m1 = summary(1, [skill, task]);
    const history = '旧城因救援失败被永久摧毁，主角失去右臂';
    const knowledge = '守卫不知道主角曾经救过叛军首领';
    const independent = '医师知道主角曾经救过叛军首领';
    store.longMemories.push(long(1, [{ action: 'add', id: stateId(skill), stateId: stateId(skill), text: '主角 · 洞察：Lv.2' },
        { action: 'add', id: 'major-event', text: history }, { action: 'add', id: 'secret', text: knowledge }], '[Open Threads]\n- 主角 · 送信：去旧城送信'));
    refreshSnapshot(store, settings, 'new long memory');
    const first = store.injectionSnapshot.value;
    store.summaries.m51 = summary(51, [{ ...skill, value: 'Lv.3' }, { ...task, status: 'completed', value: '已送达，永久获封旧城救援者' }]);
    for (let floor = 52; floor < 55; floor++) {
        store.summaries[`m${floor}`] = summary(floor, []);
        assert.equal(refreshSnapshot(store, settings, 'new summary').value, first);
    }
    store.checkpoints.push(cp(11, `[Story So Far]\n- ${history}\n[Open Threads]\n- 主角 · 送信：去旧城送信\n[Secrets & Knowledge]\n- ${independent}`));
    refreshSnapshot(store, settings, 'new checkpoint');
    assert.equal(store.injectionSnapshot.blocks.find(block => block.id === 'long:long-1').text, first.split('\n\n')[1]);
    store.longMemories.push(long(2, [{ action: 'replace', id: stateId(skill), previousId: stateId(skill), stateId: stateId(skill), text: '主角 · 洞察：Lv.3' },
        { action: 'add', id: 'major-repeat', text: history }, { action: 'add', id: 'other-observer', text: independent }], '[Open Threads]\n- 已结束 主角 · 送信：已送达，永久获封旧城救援者 (completed，历史结果)'));
    store.keepRegistry['KEEP-0001'] = { text: knowledge, status: 'active', sourceFloor: 1 };
    store.keepRegistry['KEEP-0002'] = { text: '主角欠医师一条命，承诺归还传家戒指', status: 'active', sourceFloor: 1 };
    const before = structuredClone(store);
    const value = refreshSnapshot(store, settings, 'new long memory').value;
    assert.doesNotMatch(value, /Lv\.2|去旧城送信/);
    for (const text of [history, knowledge, independent, '永久获封旧城救援者', '承诺归还传家戒指']) assert.ok(value.includes(text), text);
    assert.equal(value.split(history).length - 1, 1); assert.equal(value.split(knowledge).length - 1, 1);
    for (const key of ['summaries', 'checkpoints', 'longMemories', 'keepRegistry']) assert.deepEqual(store[key], before[key]);
    for (const reason of ['new summary', 'history metadata changed', 'chat changed']) assert.equal(refreshSnapshot(store, settings, reason).value, value);
});

test('ambiguous historical facts and multiline or nested entries survive injection projection', () => {
    const store = createEmptyStore('a'), settings = normalizeSettings();
    store.longMemories.push(long(1, [{ action: 'add', id: 'cause', text: '主角曾以失去右臂为代价拯救旧城居民' }]));
    store.longMemories.push(long(2, [{ action: 'replace', id: 'result', previousId: 'cause', text: '主角后来获得机械义肢，但仍承担旧城救援责任' }]));
    store.checkpoints.push(cp(21, '[Characters]\n医师：\n- 身份：秘密组织的长期联络者\n守卫：\n- 身份：秘密组织的长期联络者\n[Story So Far]\n- 没有追踪状态的旧任务过程仍有独立历史因果\n  影响旧城的政治格局'));
    const value = refreshSnapshot(store, settings, 'manual reinject').value;
    assert.match(value, /失去右臂/); assert.match(value, /机械义肢/); assert.match(value, /政治格局/);
    assert.equal(value.split('身份：秘密组织的长期联络者').length - 1, 2);
});

test('non-strict injection deduplicates exact Long Facts, KEEP and checkpoint facts without changing storage', () => {
    const store = createEmptyStore('a');
    const fact = '守卫不知道主角曾经救过叛军首领';
    store.longMemories.push(long(1, [{ action: 'add', id: 'custom-fact-identity', text: fact }]));
    store.keepRegistry['KEEP-0001'] = { text: fact, status: 'active', sourceFloor: 1 };
    store.checkpoints.push(cp(11, `[Secrets & Knowledge]\n- ${fact}\n- 医师知道主角曾经救过叛军首领`));
    const before = structuredClone(store);
    const value = buildInjection(store, normalizeSettings({ strictCacheMode: false, injectionMode: INJECTION_MODES.LONG_CHECKPOINT }));
    assert.equal(value.split(fact).length - 1, 1); assert.match(value, /医师知道/); assert.deepEqual(store, before);
});

test('identical Long/CP blocks and short exact facts are sent once while all originals stay saved', () => {
    const store = createEmptyStore('a'), fact = '甲持有戒指';
    const first = long(1, [{ action: 'add', id: 'fact-ring', text: fact }]);
    store.longMemories = [first, { ...structuredClone(first), id: 'long-copy' }];
    const stage = cp(11, `[Story So Far]\n- ${fact}\n- 城门已永久毁坏`);
    store.checkpoints = [stage, { ...structuredClone(stage), id: 'checkpoint-copy' }];
    store.keepRegistry['KEEP-0001'] = { text: fact, status: 'active', sourceFloor: 1 };
    const before = structuredClone(store);
    const output = refreshSnapshot(store, normalizeSettings(), 'manual reinject').value;
    assert.equal(output.split(fact).length - 1, 1);
    assert.equal(store.injectionSnapshot.blocks.filter(b => b.type === 'long').length, 1);
    assert.equal(store.injectionSnapshot.blocks.filter(b => b.type === 'checkpoint').length, 1);
    assert.match(output, /城门已永久毁坏/);
    for (const key of ['longMemories', 'checkpoints', 'keepRegistry']) assert.deepEqual(store[key], before[key]);
});

test('non-strict incremental injection also omits identical legacy Long and CP copies', () => {
    const store = createEmptyStore('a');
    const legacy = { id: 'long-1', startFloor: 1, endFloor: 50, content: '保留完整重大历史', status: 'frozen' };
    store.longMemories = [legacy, { ...legacy, id: 'long-copy' }];
    const stage = cp(11, '[Story So Far]\n- 未覆盖阶段的独立后果');
    store.checkpoints = [stage, { ...stage, id: 'checkpoint-copy' }];
    const before = structuredClone(store);
    const output = buildInjection(store, normalizeSettings({ strictCacheMode: false, injectionMode: INJECTION_MODES.LONG_CHECKPOINT }));
    for (const text of ['保留完整重大历史', '未覆盖阶段的独立后果']) assert.equal(output.split(text).length - 1, 1);
    assert.deepEqual(store, before);
});

test('latest evidenced equipment, levels, points and task results replace current fields, preserving causes and compound secrets', () => {
    const store = createEmptyStore('a'), settings = normalizeSettings();
    const equipment = { ...skill, key: '装备', category: 'item', value: '木剑' };
    const points = { ...skill, key: '系统点数', category: 'attribute', value: '10' };
    store.summaries.m1 = summary(1, [skill, equipment, points, task]);
    store.summaries.m60 = summary(60, [{ ...skill, value: 'Lv.3' }, { ...equipment, value: '银剑' },
        { ...points, value: '20' }, { ...task, status: 'completed', value: '任务已完成，永久获得通行权', evidence: '系统确认送信任务已完成' }]);
    store.longMemories.push(long(1, [skill, equipment, points].map(row => ({ action: 'add', id: stateId(row), stateId: stateId(row), text: `${row.entity} · ${row.key}：${row.value}` }))));
    const compound = '主角 · 洞察：Lv.2，曾救下医师；守卫对此仍不知情';
    store.checkpoints.push(cp(13, `[Current State]\n- 主角 · 装备：木剑\n- 主角 · 系统点数：10\n- ${compound}\n[Open Threads]\n- 主角 · 送信：去旧城送信\n[Story So Far]\n- 主角曾以失去右臂的代价救下医师\n[Secrets & Knowledge]\n- 医师知道主角的身份\n- 守卫不知道主角的身份`));
    store.keepRegistry['KEEP-0001'] = { text: '主角 · 洞察：Lv.2', status: 'active', sourceFloor: 1 };
    store.keepRegistry['KEEP-0002'] = { text: '主角仍欠医师一个独立承诺', status: 'active', sourceFloor: 1 };
    const before = structuredClone(store), output = refreshSnapshot(store, settings, 'manual reinject').value;
    assert.doesNotMatch(output, /装备：木剑|系统点数：10|去旧城送信/);
    for (const text of ['装备：银剑', '系统点数：20', '永久获得通行权', compound, '失去右臂', '医师知道主角的身份', '守卫不知道主角的身份', '独立承诺']) assert.ok(output.includes(text), text);
    // A compound knowledge statement is not reduced to a bare level entry.
    assert.equal(output.split('洞察：Lv.2').length - 1, 1);
    for (const key of ['summaries', 'longMemories', 'checkpoints', 'keepRegistry']) assert.deepEqual(store[key], before[key]);
});

test('non-strict modes cover CPs by exact Long ranges and retain uncovered gaps without historical Summary fallback', () => {
    for (const memoryStrategy of ['legacy', 'incremental']) {
        const store = createEmptyStore('a');
        store.longMemories = [{ id: 'long-1', startFloor: 51, endFloor: 100, content: '后半段长期历史', status: 'frozen' }];
        store.checkpoints = [cp(1, '[Story So Far]\n- 尚未覆盖的重大历史'), cp(11, '被覆盖的阶段'), cp(21, '最新阶段')];
        store.summaryRepairRanges = [{ startFloor: 1, endFloor: 238 }];
        store.summaries = Object.fromEntries(Array.from({ length: 238 }, (_, i) => [`m${i + 1}`, summary(i + 1, [])]));
        const output = buildInjection(store, normalizeSettings({ strictCacheMode: false, memoryStrategy, injectionMode: INJECTION_MODES.LONG_CHECKPOINT }));
        assert.match(output, /尚未覆盖的重大历史|后半段长期历史/); assert.match(output, /最新阶段/);
        assert.doesNotMatch(output, /被覆盖的阶段|RECENT_SUMMARY/);
    }
});
