import test from 'node:test';
import assert from 'node:assert/strict';
import { cleanGeneratedResponse, prepareMemoryResponse } from '../src/response-cleanup.js';
import { MemoryStore, createEmptyStore, memoryContentDigest, mergeMemoryStoresThreeWay } from '../src/memory-store.js';
import { MemorySummarizer } from '../src/summarizer.js';
import { normalizeSettings, DEFAULT_PROMPTS, ENSEMBLE_PROMPTS } from '../src/defaults.js';
import { getAssistantMessages } from '../src/utils.js';
import { parseStateChanges, projectActiveState, trackedFactUpdates, STATE_EXTRACTION_RULES, STATE_AGGREGATION_RULES } from '../src/active-state.js';
import { shouldRefreshInjection } from '../src/cache-control.js';
import { threeWayMerge } from '../server-plugin/cache-memory-memory/index.mjs';

const refusal = "I'm sorry, but I cannot fulfill this request.";
const cp = '[CHECKPOINT]\n[Story So Far]\n张医生交给林青一封信。\n[Current State]\n林青仍在诊室。';
const long = '[LONG_MEMORY]\n- 【张医生｜身份】张医生是林青的主治医生。\n[UPDATED_FACTS]\n无\n[RETIRED_FACTS]\n无';
const summary = '[SUMMARY]\n[Title]\n诊室\n[Characters]\n林青、张医生\n[Event]\n张医生交给林青一封信。\n[Quote]\n"Keep it safe."';

for (const [kind, text, prompt] of [['Summary', summary, DEFAULT_PROMPTS.summary], ['Checkpoint', cp, DEFAULT_PROMPTS.checkpoint], ['Long Memory', long, DEFAULT_PROMPTS.longMemory]]) {
    test(`${kind} keeps structured plot fields and removes mixed refusal/errors/reasoning`, () => {
        const mixed = `<think>review\nsecret reasoning\n</think>\n${refusal}\n${text}\nAPI error: upstream refused\n${refusal}`;
        const result = prepareMemoryResponse(mixed, kind, { prompt });
        assert.doesNotMatch(result, /secret reasoning|API error|cannot fulfill|<think>/);
        assert.match(result, /张医生/);
    });
    test(`${kind} rejects refusal-only, thinking-only and missing required fields`, () => {
        for (const bad of [refusal, '<think>only reasoning</think>', 'API error: blocked', '[Title]\n一个标题', '[SUMMARY]\n[Event]\n无']) {
            assert.throws(() => prepareMemoryResponse(bad, kind, { prompt }), { code: 'INVALID_MEMORY_RESPONSE' });
        }
    });
}

test('normal English and quoted refusal or literal thought tags from source remain intact', () => {
    const source = `林青说：“I cannot help you leave the hospital.”\n张医生说：“Keep it safe.”\n<think>这是人物在纸上写下的标签</think>`;
    const body = `[SUMMARY]\n[Event]\n林青说：“I cannot help you leave the hospital.”\nThe doctor keeps the letter safe.\n[Quote]\n"I cannot help you leave the hospital."\n<think>这是人物在纸上写下的标签</think>`;
    const result = prepareMemoryResponse(body, 'Summary', { source, prompt: DEFAULT_PROMPTS.summary });
    assert.match(result, /The doctor keeps/);
    assert.match(result, /"I cannot help you leave/);
    assert.match(result, /<think>这是人物/);
    assert.equal(cleanGeneratedResponse('I cannot help you leave the hospital.', 'I cannot help you leave the hospital.'), 'I cannot help you leave the hospital.');
});

test('inline and fragmented multi-line thought markup leaves valid Event content', () => {
    const result = prepareMemoryResponse('[SUMMARY]\n[Event]\n张医生交信。<think>private\nreasoning\n</think>林青收下。\n[State]\n林青离开诊室。', 'Summary', { prompt: DEFAULT_PROMPTS.summary });
    assert.match(result, /张医生交信。\n林青收下/);
    assert.doesNotMatch(result, /private|reasoning|think/);
    assert.equal(cleanGeneratedResponse('<think>x</think><analysis>y</analysis>正常正文'), '正常正文');
});

test('valid no-new-facts Long result and existing custom plain output stay compatible', () => {
    assert.equal(prepareMemoryResponse('[LONG_MEMORY]\n无\n[UPDATED_FACTS]\n无\n[RETIRED_FACTS]\n无', 'Long Memory', { prompt: DEFAULT_PROMPTS.longMemory }).startsWith('[LONG_MEMORY]'), true);
    assert.equal(prepareMemoryResponse('The doctor returns to work.', 'Summary', { prompt: '直接输出一句剧情总结' }), 'The doctor returns to work.');
});

function fixture() {
    let chatId = 'chat-a';
    const chats = { 'chat-a': { cache_memory: createEmptyStore('chat-a') }, 'chat-b': { cache_memory: createEmptyStore('chat-b') } };
    const chat = [{ name: '合成人物', mes: '张医生明确说自己喜欢蓝色，并且一贯性格温和。', gen_started: 'g1' }];
    const store = new MemoryStore({ getMetadata: () => chats[chatId], getChatId: () => chatId, saveMetadata() {} });
    const entry = getAssistantMessages(chat)[0];
    const settings = normalizeSettings();
    const requests = [];
    const summarizer = new MemorySummarizer({ store, getChat: () => chat, getSettings: () => settings, apiClient: { complete: async request => { requests.push(request); return { content: summary }; } } });
    return { store, chat, entry, settings, summarizer, requests, switchChat: id => { chatId = id; } };
}

test('all failed replacements preserve original frozen records, and first invalid output is never frozen', async () => {
    const f = fixture();
    const original = await f.summarizer.summarizeEntry(f.entry, { deferAggregates: true });
    f.store.addCheckpoint({ id: 'checkpoint-001', startFloor: 1, endFloor: 1, content: cp, status: 'frozen', frozen: true });
    f.store.addLongMemory({ id: 'long-001', startFloor: 1, endFloor: 1, content: long, status: 'frozen', frozen: true });
    const before = structuredClone(f.store.current());
    f.summarizer.apiClient.complete = async () => ({ content: refusal });
    await assert.rejects(f.summarizer.summarizeEntry(f.entry, { overwrite: true, deferAggregates: true }), /原记忆保留/);
    await assert.rejects(f.summarizer.generateCheckpoint(1, 1, { overwrite: true }), /原记忆保留/);
    await assert.rejects(f.summarizer.generateLongMemory(f.store.current().checkpoints, { overwrite: true }), /原记忆保留/);
    assert.deepEqual(f.store.getSummary(f.entry.messageId), original);
    assert.deepEqual(f.store.current().checkpoints, before.checkpoints);
    assert.deepEqual(f.store.current().longMemories, before.longMemories);
    const fresh = fixture();
    fresh.summarizer.apiClient.complete = async () => ({ content: '<think>no plot</think>' });
    await assert.rejects(fresh.summarizer.summarizeEntry(fresh.entry), /原记忆保留/);
    assert.equal(fresh.store.getSummary(fresh.entry.messageId).frozen, false);
});

test('chat mode persists independently, synchronizes and leaves frozen snapshot bytes untouched', () => {
    const f = fixture();
    f.store.current().injectionSnapshot = { value: '冻结字节', blocks: [] };
    const before = structuredClone(f.store.current());
    const digest = memoryContentDigest(before);
    f.store.setSummaryMode('advanced');
    assert.notEqual(memoryContentDigest(f.store.current()), digest);
    assert.deepEqual(f.store.current().injectionSnapshot, before.injectionSnapshot);
    assert.equal(shouldRefreshInjection(f.settings, 'summary mode changed'), false);
    assert.equal(shouldRefreshInjection({ strictCacheMode: false }, 'summary mode changed'), false);
    const remote = structuredClone(before); remote.keepRegistry = { keep: { text: '既有事实', status: 'active' } };
    assert.equal(mergeMemoryStoresThreeWay(before, f.store.current(), remote, 'chat-a').merged.summaryMode, 'advanced');
    assert.equal(threeWayMerge(before, f.store.current(), remote).merged.summaryMode, 'advanced');
    f.switchChat('chat-b'); assert.equal(f.store.current().summaryMode, 'normal');
    f.switchChat('chat-a'); assert.equal(f.store.current().summaryMode, 'advanced');
    f.store.clearCurrentChat(); assert.equal(f.store.current().summaryMode, 'advanced');
});

test('ordinary custom prompts survive while advanced requests use independent full templates', async () => {
    const f = fixture();
    await f.summarizer.summarizeEntry(f.entry, { deferAggregates: true });
    assert.equal(f.requests.length, 1);
    assert.equal(f.requests[0].systemPrompt.endsWith(STATE_EXTRACTION_RULES), true);
    assert.doesNotMatch(f.requests[0].systemPrompt, /【复杂进阶总结/);
    const stored = structuredClone(f.store.current().summaries);
    const defaults = { ...f.settings.prompts };
    f.store.setSummaryMode('advanced');
    assert.deepEqual(f.store.current().summaries, stored);
    assert.deepEqual(f.settings.prompts, defaults);
    f.settings.prompts.summary = '用户自定义：仍用 [SUMMARY] / [Event] 结构';
    await f.summarizer.summarizeEntry(f.entry, { overwrite: true, deferAggregates: true });
    assert.equal(f.requests.length, 2);
    assert.match(f.requests.at(-1).systemPrompt, /长期群像 RP/);
    assert.doesNotMatch(f.requests.at(-1).systemPrompt, /用户自定义|【复杂进阶总结|【持续状态增量】/);
    assert.match(f.requests.at(-1).userContent, /EXISTING_LONG_FACTS/);
    assert.match(f.requests.at(-1).systemPrompt, /450–800/);
    assert.equal(f.requests.at(-1).maxTokens, 4096);
    assert.equal(f.settings.prompts.summary, '用户自定义：仍用 [SUMMARY] / [Event] 结构');
    f.summarizer.apiClient.complete = async request => { f.requests.push(request); return { content: request.userContent.startsWith('[EXISTING_LONG_FACTS]') ? long : cp }; };
    await f.summarizer.generateCheckpoint(1, 1);
    await f.summarizer.generateLongMemory(f.store.current().checkpoints);
    assert.equal(f.requests.length, 4);
    for (const [index, length, tokens] of [[2, 2000, 8192], [3, 3500, 12288]]) {
        assert.match(f.requests[index].systemPrompt, new RegExp(`目标约? ${length}`));
        assert.equal(f.requests[index].maxTokens, tokens);
        assert.doesNotMatch(f.requests[index].systemPrompt, /{{maxLength}}/);
        assert.match(f.requests[index].systemPrompt, /长期群像 RP/);
        assert.doesNotMatch(f.requests[index].systemPrompt, /【复杂进阶总结/);
        assert.equal(f.requests[index].systemPrompt.includes(STATE_AGGREGATION_RULES), false);
    }
    assert.equal(f.settings.ensemblePrompts.summary, ENSEMBLE_PROMPTS.summary);
});

test('advanced state updates keep absent NPCs, require explicit traits and replace latest fact by same stable id', () => {
    const source = '张医生明确说自己喜欢蓝色，并且一贯性格温和。林青只在这一天微笑了一次。';
    const state = { kind: 'state', entity: '张医生', key: '颜色喜好', value: '蓝色', category: 'preference', evidence: '张医生明确说自己喜欢蓝色', confirmed: true };
    const inferred = { ...state, entity: '林青', key: '性格', value: '开朗', category: 'personality', evidence: '林青只在这一天微笑了一次' };
    const changes = parseStateChanges(JSON.stringify([state, inferred]), source, [], { advanced: true });
    assert.equal(changes.length, 1);
    const store = createEmptyStore('synthetic');
    store.summaries.s1 = { messageId: 's1', floor: 1, frozen: true, status: 'frozen', stateChanges: changes };
    store.summaries.s100 = { messageId: 's100', floor: 100, frozen: true, status: 'frozen', stateChanges: [] };
    assert.equal(projectActiveState(store, 100)[0].value, '蓝色');
    const updated = parseStateChanges(JSON.stringify([{ ...state, id: changes[0].id, value: '绿色', evidence: '张医生说现在更喜欢绿色' }]), '张医生说现在更喜欢绿色', projectActiveState(store), { advanced: true });
    store.summaries.s101 = { messageId: 's101', floor: 101, frozen: true, status: 'frozen', stateChanges: updated };
    assert.equal(projectActiveState(store).length, 1);
    assert.equal(projectActiveState(store)[0].value, '绿色');
    const updates = trackedFactUpdates([], store, 101, [{ id: 'fact-old', stateId: changes[0].id, text: '张医生 · 颜色喜好：蓝色', status: 'active', floor: 1 }]);
    assert.equal(updates.length, 1); assert.equal(updates[0].action, 'replace'); assert.match(updates[0].text, /绿色/);
});


test('unquoted normal English is not mistaken for a refusal just because it starts with I cannot', () => {
    for (const line of ['I cannot continue walking because of my wound.', 'I cannot help you leave the hospital.', 'I will not provide the guard with a key.', 'Error: he had misread the letter.']) {
        assert.equal(cleanGeneratedResponse(line), line);
    }
    assert.equal(cleanGeneratedResponse("I'm sorry, but I cannot assist with that."), '');
    assert.equal(cleanGeneratedResponse('I cannot generate the requested content.'), '');
});

test('empty placeholder lists and empty legacy events never become frozen plot fields', () => {
    for (const value of ['[SUMMARY]\n[Event]\n- 无', '<event>none</event>', '[CHECKPOINT]\n[Current State]\n- 无']) {
        const kind = value.startsWith('[CHECKPOINT]') ? 'Checkpoint' : 'Summary';
        assert.throws(() => prepareMemoryResponse(value, kind, { prompt: DEFAULT_PROMPTS[kind === 'Summary' ? 'summary' : 'checkpoint'] }), { code: 'INVALID_MEMORY_RESPONSE' });
    }
});

test('unquoted reasoning appended to Quote is removed, while literal tags in paraphrased plot survive', () => {
    const text = summary + '\n<think>private thought</think>';
    assert.doesNotMatch(prepareMemoryResponse(text, 'Summary', { prompt: DEFAULT_PROMPTS.summary }), /private thought/);
    const literal = '<think>在这里写字</think>';
    const narrative = '张医生改写了纸上的 ' + literal + ' 标记。';
    assert.equal(cleanGeneratedResponse(narrative, '纸上原本写着 ' + literal), narrative);
});
