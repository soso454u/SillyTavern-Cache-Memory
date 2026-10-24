import test from 'node:test';
import assert from 'node:assert/strict';
import { DEFAULT_PROMPTS, V1270_DEFAULT_PROMPTS, normalizeSettings, memoryGenerationSettings } from '../src/defaults.js';
import { CacheMemoryUI, parseCheckpointSections, buildCheckpointContent, parseLongMemorySections } from '../src/ui.js';
import { MemoryStore } from '../src/memory-store.js';
import { MemorySummarizer } from '../src/summarizer.js';

const story = '第一天傍晚，旅人在渡口向守卫借船，约定“明日天亮前归还”；守卫答应，但要求保留一盏灯。\n\n翌日清晨，旅人依约还船，澄清原先的误会。守卫已知信件内容，船夫仍不知情。';
const cpText = `[CHECKPOINT]\n[Stage Story]\n${story}`;
class Element {
    constructor(tag, text = '') { this.tag = tag; this.textContent = text; this.children = []; this.dataset = {}; }
    append(...nodes) { this.children.push(...nodes); }
}
const descendants = node => [node, ...node.children.flatMap(descendants)];

test('official aggregate templates upgrade, custom prompts and existing length/token settings survive', () => {
    const settings = normalizeSettings({ prompts: V1270_DEFAULT_PROMPTS, longMemoryMaxLength: 4800, longMemoryMaxTokens: 8000 });
    assert.deepEqual(settings.prompts, DEFAULT_PROMPTS);
    assert.equal(settings.longMemoryMaxLength, 4800); assert.equal(settings.longMemoryMaxTokens, 8000);
    const custom = { ...V1270_DEFAULT_PROMPTS, checkpoint: V1270_DEFAULT_PROMPTS.checkpoint + '\n我的阶段规则', longMemory: '我的大总结格式' };
    for (const mode of ['normal', 'advanced']) {
        const actual = memoryGenerationSettings(normalizeSettings({ prompts: custom }), mode);
        assert.equal(actual.prompts.checkpoint, custom.checkpoint); assert.equal(actual.prompts.longMemory, custom.longMemory);
    }
    assert.equal(normalizeSettings().longMemoryMaxLength, 2200);
    assert.equal(normalizeSettings().longMemoryMaxTokens, 4096);
    assert.equal(DEFAULT_PROMPTS.summary, V1270_DEFAULT_PROMPTS.summary);
});

test('narrative stage sections hide wire markers, preserve paragraphs, and round-trip without adding state tables', () => {
    for (const content of [cpText, cpText.replace('[CHECKPOINT]\n', ''), cpText.replaceAll('\n', '\r\n')]) {
        const fields = parseCheckpointSections(content);
        assert.equal(fields.stageStory.replaceAll('\r\n', '\n'), story);
        assert.deepEqual(Object.keys(fields), ['stageStory']);
        const saved = buildCheckpointContent(fields);
        assert.match(saved, /^\[CHECKPOINT\]\n\[Stage Story\]\n/);
        assert.doesNotMatch(saved, /\[Characters\]|\[Current State\]|\[Open Threads\]/);
        assert.equal(parseCheckpointSections(saved).stageStory, fields.stageStory);
    }
    const body = new Element('div');
    const ui = { element: (tag, _class, text) => new Element(tag, text) };
    const record = { content: cpText, status: 'frozen' }, before = structuredClone(record);
    CacheMemoryUI.prototype.checkpointDisplay.call(ui, body, record);
    const visible = descendants(body).map(node => node.textContent).join('\n');
    assert.match(visible, /本阶段剧情总结/); assert.ok(visible.includes(story));
    assert.doesNotMatch(visible, /\[CHECKPOINT\]|\[Stage Story\]/);
    assert.deepEqual(record, before);
});

test('stage card editing exposes only the narrative and keeps protocol markers out of the textarea', () => {
    let editor;
    const item = { id: 'cp-1', startFloor: 1, endFloor: 5, content: cpText, status: 'frozen' };
    const context = {
        statusLabel: () => '已冻结', line: (name, value) => new Element('p', `${name}：${value ?? ''}`),
        foldCard: ({ renderBody }) => { const body = new Element('div'); renderBody(body); return body; },
        isEditing: () => true, inlineEditor: (_body, fields) => { editor = fields; },
    };
    CacheMemoryUI.prototype.checkpointCard.call(context, item);
    assert.equal(editor.length, 1); assert.equal(editor[0].key, 'stageStory');
    assert.equal(editor[0].value, story); assert.equal(editor[0].label, '本阶段剧情总结');
    assert.doesNotMatch(editor[0].value, /CHECKPOINT|Stage Story/);
});

test('mixed legacy fields remain editable, and unknown, duplicate or leading custom content keeps the raw editor', () => {
    const mixed = `${cpText}\n[Story So Far]\n早期必要背景\n[Current State]\n旅人正在渡口\n[RESOLVED_KEEP]\nKEEP-1 | 已归还 | 旅人归还船只`;
    const fields = parseCheckpointSections(mixed);
    assert.equal(fields.stageStory, story); assert.equal(fields.storySoFar, '早期必要背景');
    assert.equal(fields.currentState, '旅人正在渡口');
    const saved = buildCheckpointContent(fields);
    assert.equal(parseCheckpointSections(saved).currentState, fields.currentState);
    assert.doesNotMatch(saved, /RESOLVED_KEEP/);
    for (const content of [`${cpText}\n[Custom Notes]\n自定义事实`, `${cpText}\n[Stage Story]\n第二份`, `自定义前言\n${cpText}`, cpText.replace('[CHECKPOINT]', '[CHECKPOINT]\n标记下的自定义前言'), '纯文本旧总结']) {
        assert.equal(parseCheckpointSections(content), null);
    }
});

test('editing stage narrative saves the structure and leaves adjacent ranges untouched', () => {
    const metadata = {}, store = new MemoryStore({ getMetadata: () => metadata, getChatId: () => 'detail-edit', saveMetadata() {} });
    for (const end of [5, 10]) store.addCheckpoint({ id: `cp-${end}`, startFloor: end - 4, endFloor: end, content: cpText, status: 'frozen' });
    const neighbor = structuredClone(store.current().checkpoints[1]);
    const ui = Object.assign(Object.create(CacheMemoryUI.prototype), { store, isEditing: () => true,
        inlineEditValues: () => ({ stageStory: story + '\n船夫随后获知消息。' }), renderManager() {}, renderMessageMemories() {} });
    ui.saveInlineEdit({ dataset: { memoryType: 'checkpoint', memoryId: 'cp-5' } });
    const saved = store.current().checkpoints[0];
    assert.equal(saved.status, 'manual-edited'); assert.match(saved.content, /\[Stage Story\][\s\S]*船夫随后获知消息/);
    assert.deepEqual(store.current().checkpoints[1], neighbor);
});

test('Long regeneration sends all ten stages with detailed chronological rules in one unchanged-size request', async () => {
    const metadata = {}, requests = [], config = normalizeSettings({ globalPromptMode: 'blank', longMemoryMaxLength: 3200, longMemoryMaxTokens: 6500 });
    const store = new MemoryStore({ getMetadata: () => metadata, getChatId: () => 'detail-long', saveMetadata() {} });
    const paragraphs = [];
    for (let i = 0; i < 10; i++) {
        const start = i * 5 + 1, end = start + 4;
        const event = `第${start}至${end}层的独立事件：旅人与船夫约定第${i + 1}次交接，守卫澄清误会并归还信件。`;
        paragraphs.push(`第${start}–${end}层｜渡口\n${event}`);
        store.addCheckpoint({ id: `cp-${i}`, startFloor: start, endFloor: end, status: 'frozen', content: `[CHECKPOINT]\n[Stage Story]\n${event}` });
    }
    store.addLongMemory({ id: 'long-1', startFloor: 1, endFloor: 50, status: 'frozen', content: '[STORY_ARC]\n两人相识后成为朋友。' });
    const before = structuredClone(store.current().checkpoints);
    const response = `[STORY_ARC]\n${paragraphs.join('\n\n')}\n[LONG_MEMORY]\n无\n[UPDATED_FACTS]\n无\n[RETIRED_FACTS]\n无`;
    const summarizer = new MemorySummarizer({ store, getChat: () => [], getSettings: () => config,
        apiClient: { complete: async request => { requests.push(request); return { content: response }; } } });
    const result = await summarizer.generateLongMemory(store.current().checkpoints, { overwrite: true });
    assert.equal(requests.length, 1); assert.equal(requests[0].maxTokens, 6500);
    assert.match(requests[0].systemPrompt, /目标约3200字/);
    assert.match(requests[0].systemPrompt, /每一份阶段总结/);
    assert.match(requests[0].systemPrompt, /前期到末段/);
    assert.match(requests[0].systemPrompt, /约70%–100%/);
    assert.match(requests[0].systemPrompt, /已经结束的日常互动/);
    for (const paragraph of paragraphs) {
        assert.ok(requests[0].userContent.includes(paragraph.split('\n')[1]));
        assert.ok(parseLongMemorySections(result.content).storyArc.includes(paragraph));
    }
    assert.equal(result.content, response); assert.equal(result.id, 'long-1');
    assert.deepEqual(store.current().checkpoints, before);
});
