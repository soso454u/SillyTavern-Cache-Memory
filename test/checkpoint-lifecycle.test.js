import test from 'node:test';
import assert from 'node:assert/strict';
import { createEmptyStore, MemoryStore } from '../src/memory-store.js';
import { stateId, projectActiveState, reconcileTrackedCheckpoint, trackedFactUpdates, isTrackedActive } from '../src/active-state.js';
import { checkpointHistoricalFacts, readSection } from '../src/continuity.js';
import { currentInjectionBlocks, buildInjection } from '../src/injection.js';
import { refreshSnapshot } from '../src/cache-control.js';
import { normalizeSettings } from '../src/defaults.js';
import { MemorySummarizer } from '../src/summarizer.js';
import { getAssistantMessages } from '../src/utils.js';

const settings = normalizeSettings();
const state = (key, value, extra = {}) => ({ kind: 'state', entity: '旅人', key, value, category: 'effect',
    lifetime: 'temporary', status: 'active', evidence: '来源的明确证据', ...extra });
function put(store, floor, changes, event = '', fields = {}) {
    store.summaries[`m${floor}`] = { messageId: `m${floor}`, floor, event, characters: '旅人、医师、守卫',
        frozen: true, status: 'frozen', ...fields, stateChanges: changes.map(row => ({ ...row, id: row.id || stateId(row) })) };
}
const cp = (n, content) => ({ id: `checkpoint-${n}`, startFloor: n * 5 - 4, endFloor: n * 5, memoryKind: 'state', frozen: true, status: 'frozen', content });

test('27 saved CPs without Long publish one latest CP; reload and ordinary updates preserve old snapshot bytes', () => {
    const store = createEmptyStore('a');
    for (let n = 1; n <= 27; n++) store.checkpoints.push(cp(n, `[Current State]\n当前地点${n}\n[Secrets & Knowledge]\n守卫不知道密道`));
    store.checkpoints[0].content += '\n[Characters]\n医师：秘密组织的联络者\n[Story So Far]\n旧城永久毁灭，旅人因救援失去右臂';
    put(store, 1, [state('身份', '救援队长', { category: 'identity', lifetime: 'permanent' })]);
    store.keepRegistry.k = { text: '旅人承诺归还医师的戒指', status: 'active', sourceFloor: 1 };
    store.keepRegistry.empty = { text: '无（本层未形成独立长期事项。）', status: 'active', sourceFloor: 5 };
    store.injectionSnapshot = { mode: settings.injectionMode, signature: 'old', value: '旧冻结全文', blocks: [] };
    const before = structuredClone(store);
    assert.equal(refreshSnapshot(store, settings, 'chat changed').value, '旧冻结全文');
    put(store, 136, []); assert.equal(refreshSnapshot(store, settings, 'new summary').value, '旧冻结全文');
    const text = refreshSnapshot(store, settings, 'new checkpoint').value;
    assert.equal(store.injectionSnapshot.blocks.filter(row => row.type === 'checkpoint').length, 1);
    for (const value of ['当前地点27', '守卫不知道密道', '秘密组织的联络者', '旧城永久毁灭', '救援队长', '承诺归还医师的戒指']) assert.ok(text.includes(value), value);
    assert.doesNotMatch(text, /当前地点26|CHECKPOINT_26|本层未形成独立/);
    for (const section of ['checkpoints', 'longMemories', 'keepRegistry']) assert.deepEqual(store[section], before[section]);
    assert.equal(buildInjection(store, { ...settings, strictCacheMode: false }), text);
});

test('completed temporary actions leave the role projection and CP current fields while unknown injuries and secrets survive quiet floors', () => {
    const store = createEmptyStore('a');
    const opened = state('行李箱密码', '告知密码', { category: 'knowledge' });
    put(store, 1, [opened, state('伤势', '左腿骨折'), state('秘密', '医师不知道密道', { category: 'knowledge', lifetime: 'permanent' })]);
    put(store, 3, [{ ...opened, category: 'history', value: '已成功开箱（密码0412），正在整理物品' }]);
    put(store, 135, []);
    const rows = projectActiveState(store);
    assert.equal(rows.find(row => row.key === '行李箱密码').status, 'expired');
    assert.equal(rows.find(row => row.key === '伤势').status, 'active');
    assert.equal(rows.find(row => row.key === '秘密').status, 'active');
    const result = reconcileTrackedCheckpoint('[Current State]\n- 旅人 · 行李箱密码：已成功开箱（密码0412），正在整理物品', store, 135, 131);
    assert.doesNotMatch(result, /行李箱密码/);
    assert.match(result, /左腿骨折|医师不知道密道/);
    assert.equal(store.summaries.m3.stateChanges[0].status, 'active');
});

test('explicit Summary settlements and executed plans override old progress without inferring expiry from deadlines or reward collection', () => {
    const store = createEmptyStore('a');
    const task = state('送信', '送信给医师，奖励通行权', { kind: 'thread', status: 'published', acquisition: 'pending', category: 'task' });
    const plan = state('明早防撞头计划', '计划用毛巾缠梁', { category: 'plan' });
    put(store, 1, [task, plan]);
    put(store, 2, [], '旅人已完成缠梁防撞头。系统结算【送信】任务，永久通行权已发放。');
    put(store, 3, [task]); // stale progress must not resurrect completion
    const before = structuredClone(store);
    const rows = projectActiveState(store);
    assert.equal(rows.find(row => row.kind === 'thread').status, 'completed');
    assert.equal(rows.find(row => row.key === plan.key).status, 'expired');
    const content = reconcileTrackedCheckpoint('[Open Threads]\n- 旅人 · 送信：送信给医师，奖励通行权（尚未领取）\n[Current State]\n- 旅人 · 明早防撞头计划：计划用毛巾缠梁', store, 5);
    assert.doesNotMatch(readSection(content, 'Open Threads'), /送信/);
    assert.doesNotMatch(readSection(content, 'Current State'), /防撞头计划/);
    assert.match(readSection(content, 'Story So Far'), /永久通行权/);
    assert.deepEqual(store, before);
    for (const event of ['旅人计划完成【送信】任务', '旅人【送信】任务尚未完成', '旅人【送信】完成条件为亲手送达', '旅人【送信】任务完成度核算中']) {
        const uncertain = createEmptyStore('u'); put(uncertain, 1, [task]); put(uncertain, 2, [], event);
        assert.ok(isTrackedActive(projectActiveState(uncertain)[0]), event);
    }
});

test('same task for different people and each knowledge holder remain separate; unsupported CP resolutions are ignored', () => {
    const store = createEmptyStore('a');
    const task = state('送信', '尚未送达', { kind: 'thread', category: 'task' });
    put(store, 1, [task, { ...task, entity: '医师' }, state('密道认知', '知道密道', { category: 'knowledge', lifetime: 'permanent' }),
        state('密道认知', '不知道密道', { entity: '守卫', category: 'knowledge', lifetime: 'permanent' })]);
    put(store, 2, [], '系统结算【送信】任务。'); // cannot decide which character
    const unsupported = { ...task, id: stateId(task), status: 'completed', value: '已完成', evidence: '没有出现过的完成证据', confirmed: true };
    store.checkpoints.push(cp(1, `[STATE_RESOLUTIONS]\n${JSON.stringify([unsupported])}`));
    assert.equal(projectActiveState(store).filter(row => row.kind === 'thread' && isTrackedActive(row)).length, 2);
    const result = reconcileTrackedCheckpoint('[Secrets & Knowledge]\n无', store, 5);
    assert.match(result, /旅人 · 密道认知：知道密道/); assert.match(result, /守卫 · 密道认知：不知道密道/);
});

test('CP response resolves temporary states in the existing request and the same projection survives reload, injection and Long selection', async () => {
    const metadata = {}, chat = Array.from({ length: 5 }, (_, i) => ({ name: '旅人', mes: `正文${i}`, gen_started: `g${i}` }));
    const store = new MemoryStore({ getMetadata: () => metadata, getChatId: () => 'a', saveMetadata() {} });
    const injury = state('伤势', '左腿骨折'); const entries = getAssistantMessages(chat);
    for (const entry of entries) store.addSummary({ messageId: entry.messageId, floor: entry.floor, event: entry.floor === 5 ? '旅人左腿骨折已痊愈，恢复行走。' : '旅人受伤休养。',
        stateChanges: entry.floor === 1 ? [{ ...injury, id: stateId(injury) }] : [], status: 'frozen', frozen: true });
    const before = structuredClone(store.current()); let calls = 0;
    const resolution = { ...injury, id: stateId(injury), value: '左腿骨折已痊愈，恢复行走', status: 'expired', confirmed: true, evidence: '左腿骨折已痊愈，恢复行走' };
    const summarizer = new MemorySummarizer({ store, getSettings: () => settings, getChat: () => chat, apiClient: { complete: async request => {
        calls++; assert.match(request.systemPrompt, /STATE_RESOLUTIONS/); assert.match(request.userContent, /SUMMARY_RESULTS/);
        return { content: `[CHECKPOINT]\n[Current State]\n- 旅人 · 伤势：左腿骨折\n[STATE_RESOLUTIONS]\n${JSON.stringify([resolution])}` };
    } } });
    await summarizer.generateCheckpoint(1, 5);
    assert.equal(calls, 1);
    assert.equal(projectActiveState(JSON.parse(JSON.stringify(store.current())))[0].status, 'expired');
    assert.doesNotMatch(currentInjectionBlocks(store.current(), settings)[0].text, /STATE_RESOLUTIONS|左腿骨折/);
    assert.deepEqual(trackedFactUpdates([], store.current(), 5), []);
    assert.deepEqual(store.current().summaries, before.summaries);
    assert.deepEqual(store.current().stateOverrides, before.stateOverrides);
    assert.deepEqual(store.current().injectionSnapshot, before.injectionSnapshot);
});

test('role UI renders completed transient states in a separate history group instead of the current character table', async () => {
    const { CacheMemoryUI } = await import('../src/ui.js');
    const store = createEmptyStore('a'); store.summaryMode = 'advanced';
    put(store, 1, [state('行李箱密码', '已成功开箱（密码0412）', { category: 'history' }),
        state('身份', '医师', { category: 'identity', lifetime: 'permanent' })]);
    class Element {
        constructor(tag, text = '') { this.dataset = {}; this.tag = tag; this.textContent = text; this.children = []; }
        append(...items) { this.children.push(...items); }
        setAttribute() {}
        addEventListener() {}
        querySelector(tag) { return this.children.find(child => child.tag === tag); }
    }
    const context = { element: (tag, _class, text) => new Element(tag, text), controller: new AbortController(),
        getChat: () => [], store: { current: () => store, effectiveStore: () => store } };
    const root = CacheMemoryUI.prototype.renderTrackedPage.call(context, 'state');
    const groups = root.children.filter(child => child.tag === 'details' && child.children.some(row => row.tag === 'table'));
    const current = groups.find(group => group.children[0].textContent.endsWith('· 当前记录'));
    const history = groups.find(group => group.children[0].textContent.endsWith('· 已结束 / 历史结果'));
    assert.ok(current); assert.ok(history);
    const values = node => [node.textContent, ...node.children.map(values)].join(' ');
    assert.match(values(history), /行李箱密码/); assert.doesNotMatch(values(current), /行李箱密码/);
    assert.match(values(current), /医师/);
});

test('expired transient Long facts are retired without creating a replacement or modifying the old Long', async () => {
    const { projectLongFacts } = await import('../src/continuity.js');
    const store = createEmptyStore('a'), opened = state('开箱', '正在开箱', { category: 'history' });
    put(store, 1, [opened]);
    store.longMemories.push({ id: 'long-1', startFloor: 1, endFloor: 50, memoryKind: 'facts', status: 'frozen',
        factUpdates: [{ action: 'add', id: 'fact-box', stateId: stateId(opened), text: '旅人 · 开箱：正在开箱' }] });
    put(store, 51, [{ ...opened, value: '已成功开箱，物品已归位' }]);
    const before = structuredClone(store);
    assert.equal(projectLongFacts(store).facts[0].status, 'retired');
    assert.deepEqual(trackedFactUpdates([], store, 55, [{ id: 'fact-box', stateId: stateId(opened), text: '旅人 · 开箱：正在开箱', status: 'active', floor: 50 }]).map(row => row.action), ['retire']);
    assert.deepEqual(store, before);
});

test('obtained rewards cannot leave an old pending task line active when its value contains conditions and punctuation', () => {
    const store = createEmptyStore('a');
    const task = state('调查', '已发布：亲眼查看文件，不得被发现；奖励通行权', { kind: 'thread', category: 'task', acquisition: 'pending', condition: '今晚完成，保密' });
    put(store, 1, [task]);
    put(store, 3, [{ ...task, status: 'completed', acquisition: 'obtained', value: '已完成，永久通行权已发放', condition: '新条件已结算' }]);
    const content = '[Open Threads]\n- 旅人 · 调查：已发布：亲眼查看文件，不得被发现；奖励通行权（尚未领取）；条件：今晚完成，保密';
    const result = reconcileTrackedCheckpoint(content, store, 5);
    assert.doesNotMatch(readSection(result, 'Open Threads'), /调查|尚未领取/);
    assert.match(readSection(result, 'Story So Far'), /永久通行权/);
});

test('a saved snapshot cannot bypass an explicit disabled injection choice on chat reload', () => {
    const store = createEmptyStore('a'); store.checkpoints.push(cp(1, '[Current State]\n当前剧情'));
    refreshSnapshot(store, settings, 'new checkpoint');
    assert.equal(refreshSnapshot(store, { ...settings, injectionMode: 'none' }, 'chat changed').value, '');
});


test('legacy-format chats also generate a cumulative next CP without rewriting their old aggregate', async () => {
    const metadata = {}, chat = Array.from({ length: 10 }, (_, i) => ({ name: '旅人', mes: `正文${i}`, gen_started: `legacy${i}` }));
    const store = new MemoryStore({ getMetadata: () => metadata, getChatId: () => 'legacy', saveMetadata() {} });
    for (const entry of getAssistantMessages(chat)) store.addSummary({ messageId: entry.messageId, floor: entry.floor, event: '新剧情', status: 'frozen' });
    const old = { id: 'checkpoint-1', startFloor: 1, endFloor: 5, content: '医师是旅人的恩人，旅人承诺偿还债务', status: 'frozen' };
    store.addCheckpoint(old); const previous = structuredClone(store.current().checkpoints[0]);
    let calls = 0;
    const summarizer = new MemorySummarizer({ store, getChat: () => chat, getSettings: () => ({ ...settings, memoryStrategy: 'legacy' }), apiClient: { complete: async request => {
        calls++; assert.match(request.userContent, /PREVIOUS_STATE[\s\S]*承诺偿还债务/);
        return { content: '[CHECKPOINT]\n[Story So Far]\n医师是旅人的恩人\n[Open Threads]\n旅人承诺偿还债务' };
    } } });
    const next = await summarizer.generateCheckpoint(6, 10);
    assert.equal(next.memoryKind, 'state'); assert.equal(calls, 1);
    assert.deepEqual(store.current().checkpoints[0], previous);
});

test('historical story uses every CP interval but live state only from final CP', () => {
    const store = createEmptyStore('a');
    for (let n = 1; n <= 10; n++) put(store, n, [], n < 6 ? '使者向城主呈交旧城密信' : '守卫公开证词，城主撤销逮捕令');
    store.checkpoints.push(cp(1, '[CHECKPOINT]\n[Story So Far]\n过去收到密信\n[Current State]\n客栈旧地点\n[Open Threads]\n旧任务待办'));
    store.checkpoints.push(cp(2, '[CHECKPOINT]\n[Stage Story]\n守卫出面证明城主判断错误，逮捕令被撤销。\n[Current State]\n王宫最新地点\n[Open Threads]\n追查信件来源'));
    const earlier = structuredClone(store);
    const text = buildInjection(store, { ...settings, strictCacheMode: false });
    assert.match(text, /HISTORICAL_STORY_1_5[\s\S]*使者向城主呈交旧城密信/);
    assert.match(text, /HISTORICAL_STORY_6_10[\s\S]*守卫出面证明/);
    assert.match(text, /王宫最新地点|追查信件来源/);
    assert.doesNotMatch(text, /客栈旧地点|旧任务待办|记忆读取规则/);
    assert.deepEqual(store, earlier);
});
test('Long50 story arc replaces only its covered staged narrative', () => {
    const store = createEmptyStore('a');
    for (let n = 1; n <= 11; n++) store.checkpoints.push(cp(n, `[Stage Story]\n第${n}阶段重要事件\n[Current State]\n旧地点${n}`));
    store.longMemories.push({ id: 'long-1', startFloor: 1, endFloor: 50,
        content: '[STORY_ARC]\n第一至五十层间，密信引发调查、公开审问，守卫最终推翻指控。\n[LONG_MEMORY]\n- 医师保管密信',
        memoryKind: 'facts', factUpdates: [{ action:'add',id:'fact-a',text:'医师保管密信' }], status:'frozen', frozen:true });
    const text = buildInjection(store, { ...settings, strictCacheMode: false });
    assert.match(text, /HISTORICAL_STORY_1_50[\s\S]*密信引发调查/);
    assert.match(text, /HISTORICAL_STORY_51_55[\s\S]*第11阶段重要事件/);
    assert.doesNotMatch(text, /HISTORICAL_STORY_1_5|旧地点1|旧地点10|记忆读取规则/);
    assert.match(text, /旧地点11|医师保管密信/);
});
