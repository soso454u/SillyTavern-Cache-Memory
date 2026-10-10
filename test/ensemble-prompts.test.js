import test from 'node:test';
import assert from 'node:assert/strict';
import { DEFAULT_PROMPTS, ENSEMBLE_PROMPTS, ENSEMBLE_GENERATION, normalizeLoadedSettings, normalizeSettings, memoryGenerationSettings, modePromptDefaults } from '../src/defaults.js';
import { generationPrompt } from '../src/generation-prompts.js';
import { bindDialogViewport } from '../src/ui-context.js';
import { CacheMemoryUI, configTemplate } from '../src/ui.js';
import { MemorySummarizer } from '../src/summarizer.js';
import { STATE_EXTRACTION_RULES, STATE_AGGREGATION_RULES } from '../src/active-state.js';

test('new installs and upgrades initialize independent defaults without losing ordinary custom settings', () => {
    for (const saved of [undefined, {}, { prompts: { summary: 'custom Summary', checkpoint: 'custom CP', longMemory: 'custom Long' }, summaryMaxLength: 777, checkpointMaxLength: 1777, longMemoryMaxLength: 3777, summaryMaxTokens: 555 }]) {
        const settings = normalizeLoadedSettings(saved);
        assert.deepEqual(settings.ensemblePrompts, ENSEMBLE_PROMPTS);
        assert.deepEqual(settings.ensembleGeneration, ENSEMBLE_GENERATION);
        if (saved?.prompts) {
            assert.deepEqual(settings.prompts, saved.prompts);
            for (const key of ['summaryMaxLength', 'checkpointMaxLength', 'longMemoryMaxLength', 'summaryMaxTokens']) assert.equal(settings[key], saved[key]);
        } else assert.deepEqual(settings.prompts, DEFAULT_PROMPTS);
        const reloaded = normalizeLoadedSettings(JSON.parse(JSON.stringify(settings)));
        assert.deepEqual(reloaded, settings);
    }
});

test('old advanced chat mode now selects full templates; editing and reset never touch the other mode', () => {
    let settings = normalizeSettings({ globalPromptMode: 'blank' });
    const ordinary = structuredClone(settings.prompts);
    settings = normalizeSettings({ ...settings, ensemblePrompts: { ...settings.ensemblePrompts, summary: 'group custom [Changes]' }, ensembleGeneration: { summaryMaxLength: 1000, summaryMaxTokens: 32 } });
    const group = memoryGenerationSettings(settings, 'advanced');
    assert.equal(group.summaryMode, 'ensemble');
    assert.equal(group.prompts.summary, 'group custom [Changes]');
    assert.equal(group.summaryMaxLength, 1000);
    assert.ok(group.summaryMaxTokens >= 4024);
    assert.deepEqual(memoryGenerationSettings(settings, 'normal').prompts, ordinary);
    settings = normalizeSettings({ ...settings, ensemblePrompts: { ...settings.ensemblePrompts, summary: modePromptDefaults(settings, 'ensemble').summary } });
    assert.equal(memoryGenerationSettings(settings, 'advanced').prompts.summary, ENSEMBLE_PROMPTS.summary);
    assert.deepEqual(settings.prompts, ordinary);
    assert.equal(settings.summaryMaxLength, 350);
    assert.equal(settings.checkpointInterval, 5);
    assert.equal(settings.longMemoryInterval, 50);
});

test('complete ensemble templates avoid old appended rules and retain the Changes parser contract', () => {
    const normal = normalizeSettings({ globalPromptMode: 'blank' });
    const group = memoryGenerationSettings(normal, 'advanced');
    assert.equal(generationPrompt(normal, 'summary'), normal.prompts.summary + STATE_EXTRACTION_RULES);
    assert.equal(generationPrompt(normal, 'checkpoint'), normal.prompts.checkpoint + STATE_AGGREGATION_RULES);
    for (const stage of ['summary', 'checkpoint', 'longMemory']) {
        assert.equal(generationPrompt(group, stage), ENSEMBLE_PROMPTS[stage]);
        assert.doesNotMatch(generationPrompt(group, stage), /【复杂进阶总结|【持续状态增量】/);
    }
    assert.match(generationPrompt(group, 'summary'), /\[Changes\][\s\S]*confirmed: true/);
    group.prompts.summary = 'Custom without structured deltas';
    assert.equal(generationPrompt(group, 'summary'), group.prompts.summary + STATE_EXTRACTION_RULES);
});

test('mode controls are click buttons above the main menus, and both pages share the same selection', () => {
    const html = configTemplate();
    assert.ok(html.indexOf('data-summary-mode') < html.indexOf('data-settings-tab'));
    assert.equal([...html.matchAll(/data-summary-mode="normal"/g)].length, 2);
    assert.equal([...html.matchAll(/data-summary-mode="ensemble"/g)].length, 2);
    assert.doesNotMatch(html, /<select[^>]*data-summary-mode|总结模式（当前聊天）/);
    assert.equal([...html.matchAll(/data-effective-prompt=/g)].length, 3);
});

function viewportFixture() {
    const handlers = new Map(), viewportHandlers = new Map(), frames = new Map();
    const viewport = { width: 390, height: 420, offsetLeft: 4, offsetTop: 40,
        addEventListener: (name, cb) => viewportHandlers.set(name, cb), removeEventListener: name => viewportHandlers.delete(name) };
    const root = { visualViewport: viewport, innerWidth: 390, innerHeight: 844,
        requestAnimationFrame: cb => { frames.set(1, cb); return 1; }, cancelAnimationFrame: id => frames.delete(id),
        addEventListener: (name, cb) => handlers.set(name, cb), removeEventListener: name => handlers.delete(name) };
    const overlay = { style: { setProperty(key, value) { this[key] = value; } } };
    return { root, overlay, handlers, viewportHandlers, frames };
}

test('dialogs intersect plugin bounds with offset visualViewport and clean up listeners on cancellation', () => {
    const f = viewportFixture(), controller = new AbortController();
    const anchor = { getBoundingClientRect: () => ({ left: 10, top: 20, right: 380, bottom: 800 }) };
    bindDialogViewport(f.overlay, f.root, controller.signal, anchor);
    assert.equal(f.overlay.style.left, '10px');
    assert.equal(f.overlay.style.top, '40px');
    assert.equal(f.overlay.style.width, '370px');
    assert.equal(f.overlay.style.height, '420px');
    f.root.visualViewport.height = 260;
    f.viewportHandlers.get('resize')();
    f.viewportHandlers.get('scroll')();
    assert.equal(f.frames.size, 1);
    [...f.frames.values()][0](); f.frames.clear();
    assert.equal(f.overlay.style['--cm-dialog-height'], '260px');
    f.viewportHandlers.get('resize')();
    controller.abort();
    assert.equal(f.frames.size, 0);
    assert.equal(f.handlers.size, 0);
    assert.equal(f.viewportHandlers.size, 0);
});

test('background manager notifications are coalesced into one frame and closed windows skip work', () => {
    const ui = new CacheMemoryUI({});
    const frames = [];
    ui.root = { requestAnimationFrame: cb => { frames.push(cb); return frames.length; } };
    ui.config = { hidden: false }; ui.manager = { hidden: false };
    let renders = 0; ui.renderManager = () => renders++;
    for (let i = 0; i < 20; i++) ui.queueManagerRender();
    assert.equal(frames.length, 1); frames[0](); assert.equal(renders, 1);
    ui.config.hidden = true; ui.queueManagerRender(); assert.equal(frames.length, 1);
});

test('message busy checks can reuse the render snapshot chat ID without normalizing the store per message', () => {
    let reads = 0;
    const summarizer = new MemorySummarizer({ store: { current: () => { reads++; return { chatId: 'a' }; } } });
    summarizer.inFlight.add('a:m');
    for (let i = 0; i < 200; i++) assert.equal(summarizer.isSummarizing('m', 'a'), true);
    assert.equal(reads, 0);
    assert.equal(summarizer.isSummarizing('m'), true);
    assert.equal(reads, 1);
});
