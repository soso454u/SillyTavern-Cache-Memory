import test from 'node:test';
import assert from 'node:assert/strict';
import { DEFAULT_PROMPTS, V1270_DEFAULT_PROMPTS, V1271_DEFAULT_PROMPTS, OBJECTIVE_RECAP_RULES, OBJECTIVE_SUMMARY_RULES, LAYERED_MEMORY_RULES, LONG_MEMORY_EVENT_REVIEW, normalizeSettings, memoryGenerationSettings } from '../src/defaults.js';
import { generationPrompt } from '../src/generation-prompts.js';
import { parseStructuredSummary } from '../src/summary-format.js';
import { readSection } from '../src/continuity.js';
import { MemoryStore } from '../src/memory-store.js';
import { MemorySummarizer } from '../src/summarizer.js';
import { getAssistantMessages } from '../src/utils.js';
import { currentInjectionBlocks } from '../src/injection.js';
import { CacheMemoryUI } from '../src/ui.js';

const quote = '先交押金，明日天亮前归还。';
const event = `关键事件（借船约定）：旅人支付押金后借到船，双方约定次日天亮前归还。\n重要细节：守卫已收到押金。\n核心原话：守卫“${quote}”`;
const cp = `[CHECKPOINT]\n[Stage Story]\n- 时间：当天傍晚\n  ${event.replaceAll('\n', '\n  ')}`;
const long = `[STORY_ARC]\n- 时间：当天傍晚\n  ${event.replaceAll('\n', '\n  ')}\n[LONG_MEMORY]\n无\n[UPDATED_FACTS]\n无\n[RETIRED_FACTS]\n无`;
const summary = `[SUMMARY]\n[Title]\n借船约定\n[Characters]\n旅人、守卫\n[StoryTime]\n无\n[Location]\n无\n[Event]\n${event}`;

test('both official generations migrate every stage to objective recaps while edited prompts and all budgets remain intact', () => {
    for (const previous of [V1270_DEFAULT_PROMPTS, V1271_DEFAULT_PROMPTS]) {
        const settings = normalizeSettings({ prompts: previous, summaryMaxLength: 220, checkpointMaxLength: 600, longMemoryMaxLength: 1800, summaryMaxTokens: 1100, checkpointMaxTokens: 2400, longMemoryMaxTokens: 4600 });
        assert.deepEqual(settings.prompts, DEFAULT_PROMPTS);
        assert.deepEqual([settings.summaryMaxLength, settings.checkpointMaxLength, settings.longMemoryMaxLength], [220, 600, 1800]);
        assert.deepEqual([settings.summaryMaxTokens, settings.checkpointMaxTokens, settings.longMemoryMaxTokens], [1100, 2400, 4600]);
        const custom = Object.fromEntries(Object.entries(previous).map(([key, value]) => [key, value + '\n保留我的自定义要求']));
        for (const mode of ['normal', 'advanced']) assert.deepEqual(memoryGenerationSettings(normalizeSettings({ prompts: custom }), mode).prompts, custom);
    }
});

test('all prompts stay objective while Summary uses narrative and aggregates keep event entries', () => {
    for (const mode of ['normal', 'advanced']) {
        const config = memoryGenerationSettings(normalizeSettings({ globalPromptMode: 'blank' }), mode);
        for (const stage of ['summary', 'checkpoint', 'longMemory']) {
            const prompt = generationPrompt(config, stage);
            assert.ok(prompt.includes(stage === 'summary' ? OBJECTIVE_SUMMARY_RULES : OBJECTIVE_RECAP_RULES));
            if (stage === 'summary') assert.match(prompt, /一段连贯叙述/);
            else assert.match(prompt, /关键事件（/);
            assert.match(prompt, /核心/);
            assert.match(prompt, /同一事实只出现一次/); assert.match(prompt, /不能自动当作事实/);
            assert.match(prompt, /不能拼接或删掉否定、条件、对象/);
            assert.match(prompt, /不设最低字数/); assert.doesNotMatch(prompt, /约70%–100%|尽量接近|应接近/);
        }
    }
});

test('recap labels and the exact core quote stay inside the existing Event field without duplicate Quote storage', () => {
    const parsed = parseStructuredSummary(summary);
    assert.equal(parsed.event, event); assert.equal(parsed.quote, '');
    assert.ok(parsed.event.length < 220);
    assert.equal(parsed.event.split(quote).length - 1, 1);
    assert.ok(readSection(cp, 'Stage Story').includes(quote));
    assert.ok(readSection(long, 'STORY_ARC').includes(quote));
});

for (const mode of ['normal', 'advanced']) test(`summary → CP → Long keeps recap facts and core quotes with the existing three calls (${mode})`, async () => {
    const metadata = {}, requests = [], settings = normalizeSettings({ globalPromptMode: 'blank', checkpointInterval: 1, longMemoryInterval: 1, summaryMaxLength: 220, checkpointMaxLength: 600, longMemoryMaxLength: 1200 });
    const chat = [{ name: '守卫', mes: `旅人来到渡口。守卫说：“${quote}”旅人支付押金，守卫将船交给旅人。`, gen_started: 'synthetic' }];
    const original = structuredClone(chat);
    const store = new MemoryStore({ getMetadata: () => metadata, getChatId: () => 'objective-recap', saveMetadata() {} });
    store.setSummaryMode(mode);
    const summarizer = new MemorySummarizer({ store, getSettings: () => settings, getChat: () => chat, apiClient: { complete: async request => {
        requests.push(request);
        return { content: request.userContent.startsWith('[EXISTING_LONG_FACTS]') ? long : request.userContent.startsWith('[PREVIOUS_CONTEXT]') ? cp : summary };
    } } });
    await summarizer.summarizeEntry(getAssistantMessages(chat)[0]);
    assert.equal(requests.length, 3);
    assert.deepEqual(requests.map(row => row.maxTokens), [settings.summaryMaxTokens + (mode === 'advanced' ? 384 : 0), settings.checkpointMaxTokens, settings.longMemoryMaxTokens]);
    for (const [index, request] of requests.entries()) {
        assert.ok(request.systemPrompt.includes(index === 0 ? OBJECTIVE_SUMMARY_RULES : OBJECTIVE_RECAP_RULES));
        assert.ok(request.systemPrompt.includes(LAYERED_MEMORY_RULES[['summary', 'checkpoint', 'longMemory'][index]]));
        assert.equal(request.systemPrompt.includes(LONG_MEMORY_EVENT_REVIEW), index === 2);
    }
    const data = store.current();
    assert.equal(Object.values(data.summaries)[0].event, event);
    assert.ok(data.checkpoints[0].content.includes(quote)); assert.ok(data.longMemories[0].content.includes(quote));
    const blocks = currentInjectionBlocks(data, { ...settings, injectionFloor: 4 });
    assert.ok(blocks.some(block => block.type === 'long-story' && block.text.includes(quote)));
    assert.equal(blocks.filter(block => block.coversHistory).length, 1);
    assert.deepEqual(chat, original);
});

test('core quote in a concise stage is visible without showing wire markers or changing the source record', () => {
    class Element { constructor(text = '') { this.textContent = text; this.children = []; } append(...rows) { this.children.push(...rows); } }
    const body = new Element(), record = { status: 'frozen', content: cp }, before = structuredClone(record);
    CacheMemoryUI.prototype.checkpointDisplay.call({ element: (_tag, _class, text) => new Element(text) }, body, record);
    const text = node => node.textContent + node.children.map(text).join('\n');
    assert.ok(text(body).includes('核心原话')); assert.ok(text(body).includes(quote));
    assert.doesNotMatch(text(body), /\[CHECKPOINT\]|\[Stage Story\]/);
    assert.deepEqual(record, before);
});
