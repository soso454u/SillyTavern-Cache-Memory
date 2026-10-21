import test from 'node:test';
import assert from 'node:assert/strict';
import { DEFAULT_PROMPTS, ENSEMBLE_PROMPTS, ENSEMBLE_GENERATION, normalizeLoadedSettings, normalizeSettings, memoryGenerationSettings, modePromptDefaults } from '../src/defaults.js';
import { generationPrompt, NORMAL_STATE_EXTRACTION_RULES } from '../src/generation-prompts.js';
import { bindDialogViewport } from '../src/ui-context.js';
import { CacheMemoryUI, configTemplate } from '../src/ui.js';
import { MemorySummarizer } from '../src/summarizer.js';
import { STATE_EXTRACTION_RULES, STATE_AGGREGATION_RULES, CHECKPOINT_LIFECYCLE_RULES } from '../src/active-state.js';

test('enabling tables shares ordinary story prompts and budgets while retaining old saved settings', () => {
    const settings = normalizeSettings({ prompts: { summary: 'custom story' }, ensembleGeneration: { summaryMaxLength: 1200 } });
    const group = memoryGenerationSettings(settings, 'advanced'), normal = memoryGenerationSettings(settings, 'normal');
    assert.equal(group.prompts.summary, 'custom story'); assert.equal(group.summaryMaxLength, normal.summaryMaxLength);
    assert.equal(group.activeStateEnabled, true); assert.equal(normal.activeStateEnabled, false);
    assert.equal(settings.ensembleGeneration.summaryMaxLength, 1200);
    assert.equal(modePromptDefaults(settings, 'ensemble'), DEFAULT_PROMPTS);
});

test('plain Summary has a total budget and optional table extraction appears only when enabled', () => {
    const settings = normalizeSettings({ globalPromptMode: 'blank' });
    const normal = memoryGenerationSettings(settings, 'normal'), group = memoryGenerationSettings(settings, 'advanced');
    assert.match(generationPrompt(normal, 'summary'), /普通摘要总字数预算/);
    assert.doesNotMatch(generationPrompt(normal, 'summary'), /\[Changes\]/);
    assert.match(generationPrompt(group, 'summary'), /\[Changes\]/);
    assert.equal(generationPrompt(group, 'checkpoint'), generationPrompt(normal, 'checkpoint'));
});

test('mode controls are click buttons above the main menus, and both pages share the same selection', () => {
    const html = configTemplate();
    assert.ok(html.indexOf('data-summary-mode') < html.indexOf('data-settings-tab'));
    assert.equal([...html.matchAll(/data-summary-mode="normal"/g)].length, 2);
    assert.equal([...html.matchAll(/data-summary-mode="ensemble"/g)].length, 2);
    assert.doesNotMatch(html, /<select[^>]*data-summary-mode|总结模式（当前聊天）/);
    assert.equal([...html.matchAll(/data-effective-prompt=/g)].length, 4);
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
    f.overlay.contains = () => false; f.overlay.dataset = {};
    f.overlay.addEventListener = () => {}; f.overlay.removeEventListener = () => {};
    f.root.innerWidth = 1200; f.root.visualViewport.width = 1200;
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
    summarizer.inFlight.add('a:m:source');
    for (let i = 0; i < 200; i++) assert.equal(summarizer.isSummarizing('m', 'a'), true);
    assert.equal(reads, 0);
    assert.equal(summarizer.isSummarizing('m'), true);
    assert.equal(reads, 1);
});
