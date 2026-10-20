import test from 'node:test';
import assert from 'node:assert/strict';
import { DEFAULT_PROMPTS, V1210_DEFAULT_PROMPTS, V12415_DEFAULT_PROMPTS, NORMAL_SUMMARY_LENGTH_RULES, ENSEMBLE_PROMPTS, normalizeSettings, memoryGenerationSettings } from '../src/defaults.js';
import { generationPrompt, NORMAL_STATE_EXTRACTION_RULES } from '../src/generation-prompts.js';
import { parseStateChanges, projectActiveState, stateId, reconcileTrackedCheckpoint } from '../src/active-state.js';
import { selectNormalChanges, normalCheckpointHistory, selectNormalFactUpdates } from '../src/normal-memory.js';
import { createEmptyStore, MemoryStore } from '../src/memory-store.js';
import { MemorySummarizer } from '../src/summarizer.js';
import { getAssistantMessages } from '../src/utils.js';
import { readSection } from '../src/continuity.js';
import { SUMMARY_SECTION_NAMES } from '../src/summary-format.js';

const row = (key, value, extra = {}) => ({ kind: 'state', entity: '修桥工乙', key, value, category: 'knowledge', status: 'active',
    lifetime: 'permanent', acquisition: 'obtained', evidence: '修桥工乙亲口确认消息', confirmed: true, ...extra });
const delta = change => ({ ...change, id: stateId(change) });
const parse = (rows, known = []) => parseStateChanges(JSON.stringify(rows), rows.map(item => item.evidence).join('。'), known);

test('ordinary defaults rank actual consequences, keep important NPCs and use adaptive length without copying ensemble mode', () => {
    assert.match(DEFAULT_PROMPTS.summary, /不默认 user、char 是故事主角/);
    assert.match(DEFAULT_PROMPTS.summary, /参与度、行为后果和长期影响/);
    assert.match(DEFAULT_PROMPTS.summary, /正文明示性格、关系、经历、立场、秘密和各自认知差/);
    assert.match(DEFAULT_PROMPTS.summary, /不设最低字数/);
    assert.doesNotMatch(DEFAULT_PROMPTS.summary, /280–|Event 约 140–180/);
    for (const section of SUMMARY_SECTION_NAMES) assert.ok(DEFAULT_PROMPTS.summary.includes(`[${section}]`));
    assert.match(DEFAULT_PROMPTS.checkpoint, /尚未进入 LONG_FACTS[\s\S]*PREVIOUS_STATE 传递/);
    assert.match(DEFAULT_PROMPTS.longMemory, /不因长期未出场而删除/);
    assert.notEqual(DEFAULT_PROMPTS.summary, ENSEMBLE_PROMPTS.summary);
    assert.equal(normalizeSettings().checkpointInterval, 5); assert.equal(normalizeSettings().longMemoryInterval, 50);
});

test('previous official prompts upgrade exactly while customized prompts and ensemble settings survive', () => {
    const old = { ...V1210_DEFAULT_PROMPTS, checkpoint: V1210_DEFAULT_PROMPTS.checkpoint.replace('技能升级与属性变化以最新明确状态替代旧值。',
        '技能升级与属性变化以最新明确状态替代旧值。同一任务、属性、物品或计划只在最合适的原栏目保留一条当前状态；明确被新计划替代的旧计划移出当前状态，必要历史原因仍可保留。不同人物的认知不能合并，长期未提及不等于任务结束。') };
    assert.deepEqual(normalizeSettings({ prompts: old }).prompts, DEFAULT_PROMPTS);
    const custom = `${old.summary}\n用户自己的额外规则`;
    assert.equal(normalizeSettings({ prompts: { ...old, summary: custom } }).prompts.summary, custom);
    const settings = normalizeSettings({ globalPromptMode: 'blank' });
    assert.equal(generationPrompt(settings, 'summary'), DEFAULT_PROMPTS.summary + NORMAL_STATE_EXTRACTION_RULES);
    const group = memoryGenerationSettings(settings, 'ensemble');
    for (const stage of ['summary', 'checkpoint', 'longMemory']) assert.equal(generationPrompt(group, stage), ENSEMBLE_PROMPTS[stage]);
    assert.deepEqual(memoryGenerationSettings(settings, 'normal').prompts, DEFAULT_PROMPTS);
});

test('ordinary summary budgets cover all visible fields and migrate the unbounded v1.24.15 default', () => {
    assert.deepEqual(normalizeSettings({ prompts: V12415_DEFAULT_PROMPTS }).prompts, DEFAULT_PROMPTS);
    assert.match(DEFAULT_PROMPTS.summary, /Title、Characters、Event、State、Open、Quote、KEEP 合计/);
    assert.match(DEFAULT_PROMPTS.summary, /通常合计不超过 \{\{maxLength\}\} 字/);
    assert.match(DEFAULT_PROMPTS.summary, /最多允许超过约 15%/);
    assert.doesNotMatch(DEFAULT_PROMPTS.summary, /是软目标|重要多人场景允许详细/);
    assert.equal(DEFAULT_PROMPTS.checkpoint, V12415_DEFAULT_PROMPTS.checkpoint);
    assert.equal(DEFAULT_PROMPTS.longMemory, V12415_DEFAULT_PROMPTS.longMemory);
    const settings = normalizeSettings({ globalPromptMode: 'blank' });
    assert.equal(generationPrompt(settings, 'summary').split(NORMAL_SUMMARY_LENGTH_RULES).length - 1, 1);
});

test('custom ordinary summaries receive the budget even with Changes disabled, without changing saved templates or ensemble requests', () => {
    const custom = `${V12415_DEFAULT_PROMPTS.summary}\n用户自定义规则`;
    for (const activeStateEnabled of [false, true]) {
        const settings = normalizeSettings({ prompts: { summary: custom }, activeStateEnabled, globalPromptMode: 'blank' });
        assert.equal(settings.prompts.summary, custom);
        assert.ok(generationPrompt(settings, 'summary').includes(NORMAL_SUMMARY_LENGTH_RULES));
        const group = memoryGenerationSettings(settings, 'ensemble');
        assert.equal(generationPrompt(group, 'summary'), ENSEMBLE_PROMPTS.summary);
        assert.ok(!generationPrompt(settings, 'checkpoint').includes(NORMAL_SUMMARY_LENGTH_RULES));
        assert.ok(!generationPrompt(settings, 'longMemory').includes(NORMAL_SUMMARY_LENGTH_RULES));
    }
});

test('normal extraction preserves evidenced independent NPC identities, traits, history and separate knowledge holders', () => {
    const rows = [row('职业', '渡口修桥工', { category: 'identity' }), row('性格', '一贯直率', { category: 'personality', evidence: '修桥工乙性格一贯直率' }),
        row('守桥经历', '曾守桥救过村民，获得村民信任', { category: 'history' }),
        row('暗门秘密', '修桥工乙知道桥下有暗门，医生丙不知道'),
        row('暗门秘密', '医生丙只以为桥下有仓库', { entity: '医生丙' })];
    const parsed = parse(rows), before = structuredClone(parsed);
    assert.equal(selectNormalChanges(parsed).length, 5); assert.deepEqual(parsed, before);
});

test('momentary posture, mood and mundane object position stay out of new tracked state, but task conditions and real injuries survive', () => {
    const rows = [row('坐姿', '坐在窗边', { category: 'effect', lifetime: 'temporary' }),
        row('情绪', '一时生气', { category: 'effect', lifetime: 'temporary' }), row('手机位置', '拿在手里', { category: 'item', lifetime: 'temporary' }),
        row('情绪灰条', '当前为55', { lifetime: 'temporary', condition: '任务要求结束前不能超过70' }),
        row('伤势', '骨折不能行走', { category: 'effect', lifetime: 'temporary', evidence: '修桥工乙骨折不能行走', condition: '直至骨折愈合' })];
    const result = selectNormalChanges(parse(rows));
    assert.deepEqual(result.map(item => item.key), ['情绪灰条', '伤势']);
});

test('a single outfit or gesture cannot establish personality, preference or a clothing habit', () => {
    const rows = [row('性格', '冷漠', { category: 'personality', evidence: '修桥工乙看了一眼没说话' }),
        row('偏好', '喜欢蓝色', { category: 'preference', evidence: '修桥工乙这次穿蓝色外套' }),
        row('穿衣习惯', '通常穿旧工服', { category: 'clothing', evidence: '修桥工乙通常穿旧工服' })];
    assert.deepEqual(selectNormalChanges(parse(rows)).map(item => item.key), ['穿衣习惯']);
});

test('unchanged observations do not create another delta; actual changes and closure use the same stable record', () => {
    const task = delta(row('修桥承诺', '尚未修复', { kind: 'thread', category: 'task', status: 'active', condition: '暴雨前修复木桥' }));
    const identity = delta(row('职业', '修桥工', { category: 'identity' }));
    const known = [task, identity];
    const complete = { ...task, status: 'completed', value: '木桥修复，已领取报酬', evidence: '木桥已修复并领取报酬' };
    const result = selectNormalChanges(parse([identity, complete], known), known);
    assert.equal(result.length, 1); assert.equal(result[0].id, task.id); assert.equal(result[0].status, 'completed');
    assert.deepEqual(selectNormalChanges(parse([{ ...task, status: 'active' }], [{ ...task, status: 'completed' }]), [{ ...task, status: 'completed' }]), []);
});

test('new normal CP separates active work from current settlements and keeps historical causes and quiet NPC facts', () => {
    const store = createEmptyStore('a');
    const task = delta(row('修桥承诺', '桥已修复，报酬已领取', { kind: 'thread', category: 'task', status: 'completed' }));
    const oldTask = delta(row('送信承诺', '信已送达', { kind: 'thread', category: 'task', status: 'completed' }));
    const pending = delta(row('守桥约定', '等待暴雨结束', { kind: 'thread', category: 'task', condition: '守桥直到暴雨结束' }));
    store.summaries.m1 = { messageId: 'm1', floor: 1, event: '送信完成', stateChanges: [oldTask], status: 'frozen' };
    const healed = delta(row('骨折伤势', '骨折已痊愈，恢复行走', { category: 'effect', status: 'expired', lifetime: 'temporary' }));
    store.summaries.m7 = { messageId: 'm7', floor: 7, event: '修桥并守桥', stateChanges: [task, pending, healed], status: 'frozen' };
    const before = structuredClone(store), tracked = projectActiveState(store);
    const content = '[CHECKPOINT]\n[Story So Far]\n修桥工乙曾因塌桥失去同伴，决定守住此桥\n[Characters]\n修桥工乙：渡口负责人，医生丙的兄长\n[Secrets & Knowledge]\n医生丙不知道桥下有暗门\n[Open Threads]\n无';
    const result = normalCheckpointHistory(reconcileTrackedCheckpoint(content, store, 10, 6), tracked, 6);
    assert.doesNotMatch(readSection(result, 'Open Threads'), /已结束|报酬已领取|信已送达/);
    assert.match(readSection(result, 'Open Threads'), /守桥约定/);
    assert.match(readSection(result, 'Story So Far'), /桥已修复，报酬已领取/);
    assert.match(readSection(result, 'Story So Far'), /骨折已痊愈，恢复行走/);
    assert.doesNotMatch(result, /信已送达/);
    assert.match(result, /失去同伴|渡口负责人|医生丙不知道桥下有暗门/);
    assert.deepEqual(store, before);
});

test('long fact equality removes only exact repetition and no-op replacements, preserving different observers and historical causes', () => {
    const facts = [{ id: 'f1', text: '修桥工乙知道桥下有暗门', status: 'active' }];
    const updates = [{ action: 'add', id: 'f2', text: '  修桥工乙知道桥下有暗门  ' }, { action: 'replace', previousId: 'f1', id: 'f3', text: facts[0].text },
        { action: 'add', id: 'f4', text: '医生丙不知道桥下有暗门' }, { action: 'add', id: 'f5', text: '修桥工乙因旧日塌桥救人经历而守桥' }];
    const before = structuredClone({ facts, updates });
    assert.deepEqual(selectNormalFactUpdates(updates, facts).map(item => item.id), ['f4', 'f5']);
    assert.deepEqual({ facts, updates }, before);
});

function fixture(mode = 'normal', count = 5) {
    const chat = Array.from({ length: count }, (_, i) => ({ mes: `修桥工乙今日坐在窗边。修桥工乙性格一贯直率。修桥工乙亲口确认消息。场景${i}`, gen_started: `g${i}` }));
    const metadata = { cache_memory: createEmptyStore('synthetic-quality') }, requests = [];
    metadata.cache_memory.summaryMode = mode === 'ensemble' ? 'advanced' : mode;
    metadata.cache_memory.injectionSnapshot = { value: '已经冻结的注入字节', blocks: [] };
    const settings = normalizeSettings({ globalPromptMode: 'blank' });
    const store = new MemoryStore({ getChatId: () => 'synthetic-quality', getMetadata: () => metadata, saveMetadata() {} });
    const summarizer = new MemorySummarizer({ store, getChat: () => chat, getSettings: () => settings,
        apiClient: { complete: async request => { requests.push(request); return { content: '[CHECKPOINT]\n[Story So Far]\n修桥工乙守桥的起因\n[Open Threads]\n无' }; } } });
    return { chat, metadata, requests, store, summarizer };
}

for (const mode of ['normal', 'ensemble']) test(`real Summary pipeline selects normal deltas only in its own mode and keeps one existing request (${mode})`, async () => {
    const f = fixture(mode), entry = getAssistantMessages(f.chat)[0];
    const changes = [row('坐姿', '坐在窗边', { category: 'effect', lifetime: 'temporary', evidence: '修桥工乙今日坐在窗边' }),
        row('性格', '一贯直率', { category: 'personality', evidence: '修桥工乙性格一贯直率' })];
    f.summarizer.apiClient.complete = async request => { f.requests.push(request); return { content: `[SUMMARY]\n[Title]\n守桥\n[Event]\n修桥工乙为保护村民留守木桥\n[State]\n修桥工乙坐在窗边\n[Open]\n无\n[KEEP]\n无\n[Changes]\n${JSON.stringify(changes)}` }; };
    const frozen = structuredClone(f.store.current().injectionSnapshot);
    const saved = await f.summarizer.summarizeEntry(entry, { deferAggregates: true });
    assert.equal(f.requests.length, 1); assert.match(saved.event, /保护村民/); assert.match(saved.state, /坐在窗边/);
    assert.equal(saved.stateChanges.length, mode === 'normal' ? 1 : 2);
    assert.deepEqual(f.store.current().injectionSnapshot, frozen);
    const before = structuredClone(f.store.current());
    await f.summarizer.summarizeEntry(entry); assert.equal(f.requests.length, 1); assert.deepEqual(f.store.current(), before);
});

test('real new CP generation removes repeated ended tasks without rewriting prior summaries, CP, KEEP or frozen injection', async () => {
    const f = fixture('normal', 10), entries = getAssistantMessages(f.chat);
    const task = delta(row('修桥承诺', '木桥已修复，报酬已领取', { kind: 'thread', category: 'task', status: 'completed' }));
    for (const entry of entries) f.store.addSummary({ messageId: entry.messageId, floor: entry.floor, event: '正常剧情', status: 'frozen', frozen: true,
        ...(entry.floor === 7 ? { stateChanges: [task] } : {}) });
    f.store.addCheckpoint({ id: 'cp-old', startFloor: 1, endFloor: 5, memoryKind: 'state', content: '[CHECKPOINT]\n[Characters]\n修桥工乙：渡口负责人\n[Story So Far]\n过去塌桥导致守桥约定\n[Open Threads]\n无', status: 'frozen' });
    f.store.current().keepRegistry['KEEP-0001'] = { text: '医生丙不知道桥下暗门', status: 'active', sourceFloor: 1 };
    const before = structuredClone(f.store.current());
    const cp = await f.summarizer.generateCheckpoint(6, 10);
    assert.equal(f.requests.length, 1); assert.match(readSection(cp.content, 'Story So Far'), /报酬已领取/);
    assert.doesNotMatch(readSection(cp.content, 'Open Threads'), /已结束|已领取/);
    assert.match(f.requests[0].userContent, /渡口负责人/);
    assert.deepEqual(f.store.current().summaries, before.summaries);
    assert.deepEqual(f.store.current().checkpoints[0], before.checkpoints[0]);
    assert.deepEqual(f.store.current().keepRegistry, before.keepRegistry);
    assert.deepEqual(f.store.current().injectionSnapshot, before.injectionSnapshot);
});

test('new Long reuses known NPC facts after fifty quiet floors, drops exact duplicate updates and preserves another observer without extra calls', async () => {
    const f = fixture('normal', 100), entries = getAssistantMessages(f.chat);
    const knownFact = '【修桥工乙｜身份】渡口负责人，因过去塌桥而守桥';
    for (const entry of entries) f.store.addSummary({ messageId: entry.messageId, floor: entry.floor,
        event: entry.floor === 51 ? '医生丙仍不知道桥下暗门。渡口负责人，因过去塌桥而守桥。' : '其他人物的日常剧情', status: 'frozen' });
    const completed = delta(row('暴雨守桥', '暴雨已过，报酬结算完成', { kind: 'thread', category: 'task', status: 'completed' }));
    f.store.current().summaries[entries[74].messageId].stateChanges = [completed];
    f.store.addLongMemory({ id: 'long-001', startFloor: 1, endFloor: 50, status: 'frozen', memoryKind: 'facts', content: knownFact,
        factUpdates: [{ action: 'add', id: 'fact-old-npc', text: knownFact }] });
    for (let startFloor = 51; startFloor <= 100; startFloor += 5) f.store.addCheckpoint({ id: `cp-${startFloor}`,
        startFloor, endFloor: startFloor + 4, content: '[CHECKPOINT]\n[Story So Far]\n新阶段的因果\n[Characters]\n修桥工乙：渡口负责人\n[Open Threads]\n无', status: 'frozen' });
    f.summarizer.apiClient.complete = async request => { f.requests.push(request); return { content:
        `[LONG_MEMORY]\n- ${knownFact}\n- 【医生丙｜认知差】医生丙仍不知道桥下暗门\n[UPDATED_FACTS]\n- fact-old-npc | ${knownFact} | 渡口负责人，因过去塌桥而守桥\n[RETIRED_FACTS]\n无` }; };
    const before = structuredClone(f.store.current());
    const result = await f.summarizer.generateLongMemory(f.store.current().checkpoints);
    assert.equal(f.requests.length, 1); assert.match(f.requests[0].userContent, /fact-old-npc/);
    assert.equal(result.factUpdates.some(update => update.previousId === 'fact-old-npc'), false);
    assert.doesNotMatch(readSection(result.continuityState, 'Open Threads'), /暴雨守桥|结算完成/);
    assert.match(readSection(result.continuityState, 'Story So Far'), /暴雨守桥|结算完成/);
    const withoutSummary = structuredClone(f.store.current());
    delete withoutSummary.summaries[entries[74].messageId].stateChanges;
    assert.equal(projectActiveState(withoutSummary).find(item => item.id === completed.id)?.status, 'completed');
    assert.equal(result.factUpdates.filter(update => update.action === 'add').length, 1);
    assert.match(result.factUpdates[0].text, /医生丙/);
    assert.deepEqual(f.store.current().longMemories[0], before.longMemories[0]);
    assert.deepEqual(f.store.current().summaries, before.summaries);
    assert.deepEqual(f.store.current().injectionSnapshot, before.injectionSnapshot);
});
