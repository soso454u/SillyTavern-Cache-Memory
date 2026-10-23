import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizeSettings, memoryGenerationSettings, DEFAULT_PROMPTS, V12423_DEFAULT_PROMPTS } from '../src/defaults.js';
import { generationPrompt } from '../src/generation-prompts.js';
import { normalizeCharacterTables, tableForRecord } from '../src/character-tables.js';
import { MemoryStore, createEmptyStore } from '../src/memory-store.js';
import { MemorySummarizer } from '../src/summarizer.js';
import { getAssistantMessages, replacePromptVariables } from '../src/utils.js';
import { stateId, projectActiveState } from '../src/active-state.js';
import { currentInjectionBlocks } from '../src/injection.js';
import { refreshSnapshot } from '../src/cache-control.js';
import { memoryOverviewStats, configTemplate } from '../src/ui.js';

const identity = { kind: 'state', entity: '医师', key: '身份', value: '旧城医师', status: 'active', category: 'identity', lifetime: 'permanent', evidence: '医师来自旧城', confirmed: true };
const relation = { ...identity, key: '与守卫关系', value: '守卫的姐姐', category: 'relationship', evidence: '医师是守卫的姐姐' };
const knowledge = { ...identity, key: '密道认知', value: '知道桥下密道', category: 'knowledge', evidence: '医师知道桥下密道' };
const task = { ...identity, kind: 'thread', key: '护送', value: '护送村民，奖励通行权', category: 'task', lifetime: 'temporary', condition: '天亮前送至诊所', evidence: '医师答应护送村民', acquisition: 'pending' };
const allTables = { characters: true, relationships: true, knowledge: true, tasks: true };
const settings = normalizeSettings({ injectionMode: 'checkpoint_boundary', globalPromptMode: 'blank' });

function fixture(mode = 'normal', preferences = {}) {
    const source = [identity, relation, knowledge, task].map(row => row.evidence).join('。');
    const chat = [{ name: '医师', mes: source, gen_started: 'x' }], metadata = {}, requests = [];
    const store = new MemoryStore({ getMetadata: () => metadata, getChatId: () => 'a', saveMetadata() {} });
    store.setSummaryMode(mode);
    const config = normalizeSettings({ ...settings, characterTables: preferences });
    const summarizer = new MemorySummarizer({ store, getChat: () => chat, getSettings: () => config, apiClient: { complete: async request => {
        requests.push(request);
        return { content: `[SUMMARY]\n[Title]\n桥边的承诺\n[Characters]\n医师、守卫\n[Event]\n医师拦住独自修桥的弟弟，将通行证交给他：“天亮前回来。”守卫答应先护送村民再修桥。\n[Changes]\n${JSON.stringify([identity, relation, knowledge, task])}` };
    } } });
    return { chat, store, summarizer, requests, config };
}

test('ordinary memory defaults to no tables and enabling tables cannot replace story prompts or length budgets', () => {
    const normal = memoryGenerationSettings(settings, 'normal'), advanced = memoryGenerationSettings(settings, 'advanced');
    assert.equal(normal.activeStateEnabled, false); assert.equal(advanced.activeStateEnabled, true);
    assert.deepEqual(normal.characterTables, { characters: true, relationships: false, knowledge: false, tasks: false });
    for (const stage of ['summary', 'checkpoint', 'longMemory']) {
        assert.equal(normal.prompts[stage], advanced.prompts[stage]);
        assert.equal(normal[`${stage}MaxLength`], advanced[`${stage}MaxLength`]);
    }
    assert.equal(normal.summaryMaxLength, 350); assert.equal(advanced.summaryMaxLength, 350);
});

test('actual Summary prompt includes the configured total budget, key actions and consequential quoted speech in Event', () => {
    const prompt = replacePromptVariables(generationPrompt(memoryGenerationSettings(settings), 'summary'), { maxLength: 350 });
    assert.match(prompt, /350 字/); assert.match(prompt, /15%/); assert.match(prompt, /关键动作/); assert.match(prompt, /关键台词自然放进 Event/);
    assert.match(prompt, /承诺、拒绝、威胁、秘密揭露、关键否认/);
    assert.doesNotMatch(prompt, /\[Changes\]|\[CURRENT_TRACKED_STATE\]/);
    assert.doesNotMatch(DEFAULT_PROMPTS.summary, /\[State\]|\[Open\]|\[Quote\]/);
});

test('old official long templates migrate, user custom story templates survive both modes, and old ensemble budgets do not inflate Summary', () => {
    assert.deepEqual(normalizeSettings({ prompts: V12423_DEFAULT_PROMPTS }).prompts, DEFAULT_PROMPTS);
    const config = normalizeSettings({ prompts: { summary: '自定义故事模板' }, ensembleGeneration: { summaryMaxLength: 3000, summaryMaxTokens: 20000 } });
    const advanced = memoryGenerationSettings(config, 'advanced');
    assert.equal(advanced.prompts.summary, '自定义故事模板'); assert.equal(advanced.summaryMaxLength, 350); assert.equal(advanced.summaryMaxTokens, 1024);
    assert.match(generationPrompt(advanced, 'summary'), /普通摘要总字数预算/);
});

test('all four tables can be independently selected; choosing none disables delta extraction', () => {
    assert.deepEqual(normalizeCharacterTables({ characters: false, knowledge: true }), { characters: false, relationships: false, knowledge: true, tasks: false });
    assert.equal(tableForRecord(relation), 'relationships'); assert.equal(tableForRecord(knowledge), 'knowledge'); assert.equal(tableForRecord(task), 'tasks');
    const empty = memoryGenerationSettings({ ...settings, characterTables: Object.fromEntries(Object.keys(allTables).map(key => [key, false])) }, 'advanced');
    assert.equal(empty.activeStateEnabled, false); assert.doesNotMatch(generationPrompt(empty, 'summary'), /\[Changes\]/);
});

test('ordinary Summary makes one existing request, keeps actions and a key quote, and stores no optional table delta', async () => {
    const f = fixture(); const saved = await f.summarizer.summarizeEntry(getAssistantMessages(f.chat)[0], { deferAggregates: true });
    assert.equal(f.requests.length, 1); assert.equal(saved.stateChanges, undefined);
    assert.match(saved.event, /拦住[\s\S]*通行证[\s\S]*“天亮前回来。”/);
    assert.doesNotMatch(f.requests[0].userContent, /CURRENT_TRACKED_STATE|EXISTING_LONG_FACTS/);
});

for (const mode of ['normal', 'advanced']) test(`manual same-source story regeneration preserves existing optional table records in ${mode} mode`, async () => {
    const f = fixture(mode), entry = getAssistantMessages(f.chat)[0];
    const previous = [identity, relation, knowledge, task].map(row => ({ ...row, id: stateId(row) }));
    f.store.addSummary({ messageId: entry.messageId, floor: entry.floor, event: '原来的长摘要', status: 'frozen', frozen: true,
        sourceFingerprint: entry.fingerprint, sourceContentFingerprint: entry.contentFingerprint, stateChanges: previous });
    const saved = await f.summarizer.summarizeEntry(entry, { overwrite: true, deferAggregates: true });
    assert.equal(f.requests.length, 1); assert.match(saved.event, /天亮前回来/);
    for (const row of previous) assert.ok(saved.stateChanges.some(item => item.id === row.id && item.value === row.value));
    assert.deepEqual(saved.stateChanges.filter(row => row.category !== 'identity'), previous.filter(row => row.category !== 'identity'));
    if (mode === 'normal') assert.deepEqual(saved.stateChanges, previous);
});

test('a changed original reply never inherits table evidence from the previous source during manual regeneration', async () => {
    const f = fixture(), entry = getAssistantMessages(f.chat)[0];
    f.store.addSummary({ messageId: entry.messageId, floor: 1, event: '旧的另一回复', status: 'frozen', frozen: true,
        sourceContentFingerprint: 'another-source', stateChanges: [{ ...identity, id: stateId(identity) }] });
    const saved = await f.summarizer.summarizeEntry(entry, { overwrite: true, deferAggregates: true });
    assert.equal(f.requests.length, 1); assert.equal(saved.stateChanges, undefined);
});

test('table generation background excludes unconfirmed source records', async () => {
    const f = fixture('advanced');
    f.store.current().summaries.unconfirmed = { messageId: 'unconfirmed', floor: 0, status: 'failed', frozen: false,
        stateChanges: [{ ...identity, value: '待核对的旧身份', id: stateId(identity) }] };
    await f.summarizer.summarizeEntry(getAssistantMessages(f.chat)[0], { deferAggregates: true });
    assert.equal(f.requests.length, 1); assert.doesNotMatch(f.requests[0].userContent, /待核对的旧身份|CURRENT_TRACKED_STATE/);
});

for (const [selection, expected] of [[{ characters: true }, ['identity']], [{ characters: false, relationships: true }, ['relationship']], [{ characters: false, knowledge: true }, ['knowledge']], [{ characters: false, tasks: true }, ['task']]]) {
    test(`table selection ${expected[0]} stores only its own deltas in the same single Summary request`, async () => {
        const f = fixture('advanced', selection); const before = structuredClone(f.store.current().injectionSnapshot);
        const saved = await f.summarizer.summarizeEntry(getAssistantMessages(f.chat)[0], { deferAggregates: true });
        assert.equal(f.requests.length, 1); assert.deepEqual(saved.stateChanges.map(row => row.category), expected);
        assert.equal(f.requests[0].maxTokens, f.config.summaryMaxTokens + 384);
        assert.doesNotMatch(saved.raw, /confirmed|\[Changes\]/); assert.match(saved.event, /天亮前回来/);
        assert.deepEqual(f.store.current().injectionSnapshot, before);
    });
}

test('table injection is a separate selected block and turning tables off preserves records and basic CP story', () => {
    const store = createEmptyStore('a'); store.summaryMode = 'advanced';
    store.summaries.m1 = { messageId: 'm1', floor: 1, event: '医师护送村民', status: 'frozen', stateChanges: [identity, relation, knowledge, task].map(row => ({ ...row, id: stateId(row) })) };
    store.checkpoints.push({ id: 'cp-1', startFloor: 1, endFloor: 5, content: '[CHECKPOINT]\n[Stage Story]\n医师把通行证交给守卫，并要求他天亮前归来。', status: 'frozen' });
    const original = structuredClone(store);
    const blocks = currentInjectionBlocks(store, settings);
    assert.equal(blocks.filter(row => row.type === 'checkpoint').length, 1);
    assert.match(blocks.find(row => row.type === 'table').text, /人物档案[\s\S]*旧城医师/);
    assert.doesNotMatch(blocks.find(row => row.type === 'table').text, /与守卫关系|密道认知|护送/);
    assert.doesNotMatch(blocks.find(row => row.type === 'checkpoint').text, /旧城医师|密道认知/);
    store.summaryMode = 'normal';
    assert.equal(currentInjectionBlocks(store, settings).some(row => row.type === 'table'), false);
    assert.deepEqual(store.summaries, original.summaries); assert.equal(projectActiveState(store).length, 4);
});

test('mixed legacy story CP retains necessary earlier history while retiring explicitly completed current fields', () => {
    const store = createEmptyStore('a');
    const box = { ...identity, key: '行李箱密码', value: '已成功开箱', category: 'history', lifetime: 'temporary' };
    const done = { ...task, value: '任务已完成，奖励通行权已发放', status: 'completed', acquisition: 'obtained' };
    store.summaries.m1 = { messageId: 'm1', floor: 1, status: 'frozen', event: '医师已成功开箱，任务已完成。',
        stateChanges: [box, done].map(row => ({ ...row, id: stateId(row) })) };
    store.checkpoints.push({ id: 'cp-1', startFloor: 1, endFloor: 5, status: 'frozen', content: '[CHECKPOINT]\n[Stage Story]\n医师拒收纸包。\n[Story So Far]\n早年由药师阿兰揭露密道秘密。\n[Current State]\n- 医师 · 行李箱密码：已成功开箱\n[Open Threads]\n- 医师 · 护送：护送村民，奖励通行权' });
    const original = structuredClone(store);
    const blocks = currentInjectionBlocks(store, settings), context = blocks.find(row => row.type === 'legacy-context');
    assert.match(context.text, /药师阿兰揭露密道秘密/);
    assert.doesNotMatch(context.text, /行李箱密码|\[Open Threads\]/);
    assert.match(blocks.find(row => row.type === 'checkpoint').text, /医师拒收纸包/);
    assert.deepEqual(store, original);
});

test('diagnostics count both new CP blocks and v1.24.23 story blocks and explain 3 summaries out of 147 without fabricating CPs', () => {
    const store = createEmptyStore('a'), assistants = Array.from({ length: 147 }, (_, i) => ({ messageId: `m${i+1}`, floor: i+1 }));
    for (let n=1;n<=3;n++) store.summaries[`m${n}`] = { messageId: `m${n}`, floor: n, event: '已生成摘要', status: 'frozen' };
    let stats = memoryOverviewStats(store, assistants, settings);
    assert.deepEqual(stats.summaries, { actual: 3, generated: 3, expected: 147 });
    assert.equal(stats.checkpoints.expected, 29); assert.equal(stats.injectedCheckpoints, 0); assert.match(stats.injectionExplanation, /3 条[\s\S]*5 层/);
    for (const block of [{ id: 'story:cp:cp-1', type: 'story' }, { id: 'checkpoint:cp-1', type: 'checkpoint' }]) {
        store.injectionSnapshot = { blocks: [block], value: '[CHECKPOINT_STORY_1_5]\n已注入阶段剧情' };
        stats = memoryOverviewStats(store, assistants, settings); assert.equal(stats.injectedCheckpoints, 1);
    }
});

test('the main manager offers a small story workflow and optional tables; legacy categories remain in collapsed advanced records', () => {
    const html = configTemplate(); const main = html.match(/<nav class="cache-memory-manager-tabs"[\s\S]*?<\/nav>/)[0];
    assert.deepEqual([...main.matchAll(/data-manager-view="([^"]+)"/g)].map(match => match[1]), ['overview','summaries','checkpoints','long','tables']);
    assert.doesNotMatch(main, /长期事实|KEEP|未解决事项|角色状态/);
    assert.match(html, /<details class="cache-memory-advanced-records">[\s\S]*高级资料与旧版记录/);
});

for (const tables of [false, true]) test(`55-floor end-to-end story pipeline keeps CP5/Long50 and ${tables ? 'selected tables' : 'no tables'} without extra calls`, async () => {
    const config = normalizeSettings({ injectionMode: 'checkpoint_boundary', globalPromptMode: 'blank' }), metadata = {}, requests = [];
    const chat = Array.from({ length: 55 }, (_, i) => ({ name: '医师', mes: '医师来自旧城。她当众拒收纸包，说：“我只在大堂见过他。”', gen_started: `g${i}` }));
    const original = structuredClone(chat);
    const store = new MemoryStore({ getMetadata: () => metadata, getChatId: () => 'a', saveMetadata() {},
        onChange: (current, reason) => refreshSnapshot(current, config, reason) });
    if (tables) store.setSummaryMode('advanced');
    const summarizer = new MemorySummarizer({ store, getChat: () => chat, getSettings: () => config, apiClient: { complete: async request => {
        requests.push(request);
        if (request.userContent.startsWith('[EXISTING_LONG_FACTS]')) return { content: '[STORY_ARC]\n医师在旧城调查期间拒收纸包，向守卫澄清只在大堂见过送信人。\n[LONG_MEMORY]\n无\n[UPDATED_FACTS]\n无\n[RETIRED_FACTS]\n无' };
        if (request.userContent.startsWith('[PREVIOUS_CONTEXT]')) {
            assert.doesNotMatch(request.userContent, /CURRENT_TRACKED_STATE|SUMMARY_RESULTS/);
            return { content: '[CHECKPOINT]\n[Stage Story]\n医师拒收纸包，并当众澄清与送信人仅在大堂见过。' };
        }
        return { content: `[SUMMARY]\n[Title]\n拒收纸包\n[Characters]\n医师\n[Event]\n医师当众拒收纸包，澄清：“我只在大堂见过他。”\n[Changes]\n${JSON.stringify([identity])}` };
    } } });
    for (const entry of getAssistantMessages(chat)) await summarizer.summarizeEntry(entry);
    assert.equal(requests.length, 55 + 11 + 1);
    assert.equal(store.current().checkpoints.length, 11); assert.equal(store.current().longMemories.length, 1);
    for (const cp of store.current().checkpoints) assert.doesNotMatch(cp.content, /\[Characters\]|\[Current State\]|\[Changes\]|state-/);
    assert.equal(store.current().longMemories[0].continuityState, undefined);
    const blocks = store.current().injectionSnapshot.blocks;
    assert.equal(blocks.filter(row => row.type === 'checkpoint').length, 1);
    assert.equal(blocks.filter(row => row.type === 'long-story').length, 1);
    assert.equal(blocks.filter(row => row.type === 'table').length, tables ? 1 : 0);
    const stats = memoryOverviewStats(store.current(), getAssistantMessages(chat), config);
    assert.equal(stats.injectedCheckpoints, 1);
    const frozen = store.current().injectionSnapshot.value;
    assert.equal(refreshSnapshot(store.current(), config, 'new summary').value, frozen);
    assert.deepEqual(chat, original);
});
