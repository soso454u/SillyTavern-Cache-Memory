import test from 'node:test';
import assert from 'node:assert/strict';
import { CacheMemoryUI, buildLongMemoryContent, parseLongMemorySections, hasLongStory } from '../src/ui.js';
import { normalizeSettings } from '../src/defaults.js';
import { MemoryStore } from '../src/memory-store.js';
import { MemorySummarizer } from '../src/summarizer.js';
import { refreshSnapshot } from '../src/cache-control.js';

const old = '[LONG_MEMORY]\n- 医师已答应守卫保守密道秘密。\n[UPDATED_FACTS]\n- old-fact | 两人各自调查 | 明确证据\n[RETIRED_FACTS]\n无';
const story = '[STORY_ARC]\n医师把钥匙交还守卫，要求“天亮前回来”；守卫先完成护送，再依约返回。医师知道密道，守卫尚不知情。';

function fixture(ids) {
    const settings = normalizeSettings(), metadata = {}, calls = [];
    const store = new MemoryStore({ getMetadata: () => metadata, getChatId: () => 'a', saveMetadata() {},
        onChange: (data, reason) => refreshSnapshot(data, settings, reason) });
    for (let start = 1; start <= 100; start += 5) store.addCheckpoint({ id: `cp-${start}`, startFloor: start, endFloor: start + 4,
        status: 'frozen', content: `[CHECKPOINT]\n[Stage Story]\n第${start}阶段：医师交还钥匙，守卫承诺天亮前返回。` });
    for (let n = 1; n <= 2; n++) store.addLongMemory({ id: `long-00${n}`, startFloor: n * 50 - 49, endFloor: n * 50,
        memoryKind: 'facts', content: old, manualEdited: true, frozen: true, status: 'frozen', storyStartTime: '2024/10/22 10:55', storyEndTime: '2024/10/25 13:40',
        ...(n === 2 && ids ? { checkpointIds: ids } : {}) });
    const summarizer = new MemorySummarizer({ store, getChat: () => [], getSettings: () => settings, apiClient: { complete: async request => {
        calls.push(request); return { content: story };
    } } });
    const ui = Object.assign(Object.create(CacheMemoryUI.prototype), { store, summarizer, renderManager() {}, renderMessageMemories() {} });
    return { store, summarizer, ui, calls };
}

test('new Long plot is parsed, shown first, and survives editing together with old fact fields', () => {
    const text = story + '\n' + old;
    const fields = parseLongMemorySections(text);
    assert.match(fields.storyArc, /天亮前回来/); assert.match(fields.longMemory, /保守密道秘密/);
    const saved = buildLongMemoryContent({ ...fields, storyArc: fields.storyArc + '两人暂时休战。' });
    assert.ok(saved.startsWith('[STORY_ARC]')); assert.match(parseLongMemorySections(saved).storyArc, /暂时休战/);
    assert.equal(parseLongMemorySections(saved).updatedFacts, fields.updatedFacts);
    assert.equal(hasLongStory(story), true); assert.equal(hasLongStory(old), false);
});

test('Long cards expose single-range regeneration for old manually edited records and render new plot as a named section', () => {
    class Element {
        constructor(tag, text) { this.tag = tag; this.textContent = text ?? ''; this.children = []; this.dataset = {}; }
        append(...nodes) { this.children.push(...nodes); }
    }
    const f = fixture(), bodies = [];
    const context = { element: (tag, _class, text) => new Element(tag, text), store: f.store,
        longMemoryControls: () => new Element('section'), line: (label, text) => new Element('p', `${label}：${text ?? ''}`),
        isEditing: () => false, isMissingCheckpointBackfillActive: () => false,
        foldCard({ renderBody }) { const body = new Element('div'); renderBody(body); bodies.push(body); return body; } };
    CacheMemoryUI.prototype.renderLongMemoryPage.call(context);
    const descendants = node => [node, ...node.children.flatMap(descendants)];
    const body = bodies[0];
    assert.ok(descendants(body).some(node => node.dataset.managerAction === 'regenerate' && node.textContent === '重新生成本段'));
    assert.ok(descendants(body).some(node => node.textContent.includes('“生成缺失”会跳过已有记录')));
    f.store.current().longMemories[1].content = story + '\n' + old;
    bodies.length = 0; CacheMemoryUI.prototype.renderLongMemoryPage.call(context);
    const headings = descendants(bodies[0]).filter(node => node.tag === 'h5').map(node => node.textContent);
    assert.equal(headings[0], '本段剧情大总结'); assert.ok(!headings.includes('已结束的历史事实'));
});

test('explicit regeneration replaces exactly 51–100 using all current CPs even with missing, stale, or incomplete saved IDs', async () => {
    for (const ids of [undefined, ['deleted-cp'], ['cp-51']]) {
        const f = fixture(ids), before = structuredClone(f.store.current());
        const pending = f.ui.regenerate('long', 'long-002');
        await assert.rejects(f.ui.regenerate('long', 'long-001'), /正在重新生成/);
        const result = await pending;
        assert.equal(f.calls.length, 1); assert.match(f.calls[0].systemPrompt, /51–100/);
        assert.equal(result.startFloor, 51); assert.equal(result.endFloor, 100); assert.equal(result.id, 'long-002');
        assert.equal(result.checkpointIds.length, 10); assert.equal(result.manualEdited, false); assert.equal(hasLongStory(result.content), true);
        assert.equal(result.storyStartTime, before.longMemories[1].storyStartTime); assert.equal(result.storyEndTime, before.longMemories[1].storyEndTime);
        assert.deepEqual(f.store.current().checkpoints, before.checkpoints); assert.deepEqual(f.store.current().summaries, before.summaries);
        assert.deepEqual(f.store.current().longMemories[0], before.longMemories[0]); assert.equal(f.ui.regeneratingLongId, null);
    }
});

test('a fact-only response cannot replace the manual Long or silently retry under a narrative template', async () => {
    const f = fixture(), before = structuredClone(f.store.current());
    f.summarizer.apiClient.complete = async request => { f.calls.push(request); return { content: old }; };
    await assert.rejects(f.ui.regenerate('long', 'long-002'), /STORY_ARC.*原记忆保留/);
    assert.equal(f.calls.length, 1); assert.deepEqual(f.store.current(), before); assert.equal(f.ui.regeneratingLongId, null);
});

test('source gaps or overlapping CPs reject regeneration before requesting a model or shrinking the target', async () => {
    for (const overlap of [false, true]) {
        const f = fixture(['cp-51']);
        if (overlap) f.store.current().checkpoints.push({ ...f.store.current().checkpoints.find(row => row.startFloor === 51), id: 'ambiguous-cp' });
        else f.store.current().checkpoints = f.store.current().checkpoints.filter(row => row.startFloor !== 96);
        const before = structuredClone(f.store.current());
        await assert.rejects(f.ui.regenerate('long', 'long-002'), /未请求模型.*原记忆保留/);
        assert.equal(f.calls.length, 0); assert.deepEqual(f.store.current(), before);
    }
});

test('a queued regeneration cannot overwrite another edit made before its model request starts', async () => {
    const f = fixture();
    const pending = f.ui.regenerate('long', 'long-002');
    f.store.current().longMemories[1].content = '另一窗口刚确认的新内容';
    await assert.rejects(pending, /排队期间本段记忆已变化/);
    assert.equal(f.calls.length, 0); assert.equal(f.store.current().longMemories[1].content, '另一窗口刚确认的新内容');
});

test('the existing confirmation names the exact range and manual content, and cancellation makes no request', async () => {
    const f = fixture(); let dialog;
    f.ui.showPluginDialog = async value => { dialog = value; return false; };
    const card = { dataset: { memoryType: 'long', memoryId: 'long-002' } };
    const button = { dataset: { managerAction: 'regenerate' }, closest: selector => selector === '[data-memory-type]' ? card : null };
    const before = structuredClone(f.store.current());
    await f.ui.handleManagerClick({ target: { closest: selector => selector === '[data-manager-action]' ? button : null } });
    assert.match(dialog.message, /51–100/); assert.match(dialog.message, /人工编辑/); assert.match(dialog.message, /调用摘要模型/);
    assert.equal(f.calls.length, 0); assert.deepEqual(f.store.current(), before);
});
