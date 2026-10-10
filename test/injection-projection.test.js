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
    store.longMemories.push(long(1, [{ action: 'add', id: 'fact-one', text: fact }]));
    store.keepRegistry['KEEP-0001'] = { text: fact, status: 'active', sourceFloor: 1 };
    store.checkpoints.push(cp(11, `[Secrets & Knowledge]\n- ${fact}\n- 医师知道主角曾经救过叛军首领`));
    const before = structuredClone(store);
    const value = buildInjection(store, normalizeSettings({ strictCacheMode: false, injectionMode: INJECTION_MODES.LONG_CHECKPOINT }));
    assert.equal(value.split(fact).length - 1, 1); assert.match(value, /医师知道/); assert.deepEqual(store, before);
});
