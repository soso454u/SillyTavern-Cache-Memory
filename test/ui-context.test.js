import test from 'node:test';
import assert from 'node:assert/strict';
import { resolveUIRoot, viewportSize } from '../src/ui-context.js';
import { buildCheckpointContent, CacheMemoryUI, configTemplate, estimateTokenCount, memoryOverviewStats, parseCheckpointSections } from '../src/ui.js';

test('overview reports expected memory counts, injection size and broken chains locally', () => {
    const assistants = Array.from({ length: 10 }, (_, index) => ({ floor: index + 1, messageId: `m${index + 1}` }));
    const summaries = Object.fromEntries(assistants.filter(entry => entry.floor !== 8)
        .map(entry => [entry.messageId, { floor: entry.floor, status: 'frozen', frozen: true }]));
    const store = {
        summaries,
        checkpoints: [{ id: 'checkpoint-001', startFloor: 1, endFloor: 5, status: 'frozen', frozen: true }],
        longMemories: [],
        keepRegistry: { 'KEEP-0001': { status: 'active', sourceFloor: 1 } },
        injectionSnapshot: { blocks: [{ type: 'checkpoint' }], value: '<CACHE_MEMORY>\n[CHECKPOINT_001]\n中文 memory\n</CACHE_MEMORY>' },
    };
    const stats = memoryOverviewStats(store, assistants, { checkpointInterval: 5, longMemoryInterval: 10 });
    assert.deepEqual(stats.summaries, { actual: 9, expected: 10 });
    assert.deepEqual(stats.checkpoints, { actual: 1, expected: 2 });
    assert.deepEqual(stats.longMemories, { actual: 0, expected: 1 });
    assert.equal(stats.activeKeeps, 1);
    assert.equal(stats.injectedCheckpoints, 1);
    assert.ok(stats.estimatedTokens > 0);
    assert.match(stats.issues.join('\n'), /Summary 缺失[\s\S]*Checkpoint 无法自动生成/);
    assert.match(stats.issues.join('\n'), /Checkpoint 缺失[\s\S]*Long Memory 无法自动生成/);
    assert.equal(estimateTokenCount(''), 0);
});

test('memory manager is a settings tab instead of a second dialog', () => {
    const html = configTemplate();
    assert.match(html, /data-settings-tab="manager"/);
    assert.match(html, /id="cache-memory-manager"[^>]+data-settings-panel="manager"/);
    assert.doesNotMatch(html, /data-manager-back|data-manager-close|aria-label="记忆管理"/);
    assert.match(html, /data-save-settings/);
    assert.match(html, /data-settings-save-state[^>]*>已保存/);
});

test('explicit settings save re-persists current realtime settings and clears dirty feedback', async () => {
    let saves = 0;
    const output = { dataset: {}, textContent: '' };
    const ui = new CacheMemoryUI({ persistSettings: async () => { saves++; } });
    ui.config = { querySelectorAll: selector => selector === '[data-settings-save-state]' ? [output] : [] };
    ui.markSettingsDirty();
    assert.equal(output.textContent, '有未保存修改');
    await ui.saveSettingsNow();
    assert.equal(saves, 1);
    assert.equal(output.textContent, '已保存');
    assert.equal(output.dataset.state, 'saved');
});

test('KEEP selection stays hidden until batch editing is enabled', async () => {
    const ui = new CacheMemoryUI({});
    let renders = 0;
    ui.renderManager = () => { renders++; };
    ui.keepSelection.add('KEEP-0001');
    const target = { closest: selector => selector === '[data-keep-batch-mode]' ? {} : null };
    await ui.handleManagerClick({ target });
    assert.equal(ui.keepBatchMode, true);
    assert.equal(ui.keepSelection.size, 0);
    assert.equal(renders, 1);
    await ui.handleManagerClick({ target });
    assert.equal(ui.keepBatchMode, false);
    assert.equal(renders, 2);
});

test('overview reinject action refreshes locally with the manual reinject reason', async () => {
    const reasons = [];
    const ui = new CacheMemoryUI({ updateInjection: reason => reasons.push(reason) });
    ui.renderManager = () => {};
    const target = { closest: selector => selector === '[data-reinject]' ? {} : null };
    await ui.handleManagerClick({ target });
    assert.deepEqual(reasons, ['manual reinject']);
});

test('Checkpoint cards parse and rebuild only the six visible structured sections', () => {
    const content = '[CHECKPOINT]\n[Story So Far]\n必要前情\n[Characters]\n人物状态\n[Current State]\n当前世界\n[Secrets & Knowledge]\n认知差\n[Open Threads]\n未解决\n[Continuity Locks]\n锁定\n[RESOLVED_KEEP]\nKEEP-0001 | 已解决 | 证据文本';
    const fields = parseCheckpointSections(content);
    assert.deepEqual(fields, { storySoFar: '必要前情', characters: '人物状态', currentState: '当前世界', secretsKnowledge: '认知差', openThreads: '未解决', continuityLocks: '锁定' });
    const rebuilt = buildCheckpointContent({ ...fields, openThreads: '' });
    assert.match(rebuilt, /\[Open Threads\]\n无/);
    assert.doesNotMatch(rebuilt, /RESOLVED_KEEP|SUPERSEDED_KEEP/);
    assert.equal(parseCheckpointSections('旧格式纯文本'), null);
});

test('UI parent mounting probes document inside try/catch, and cross-origin falls back', () => {
    const root = { document: {} };
    const current = { document: {}, parent: root };
    assert.equal(resolveUIRoot(current), root);
    current.parent = { get document() { throw new DOMException('Blocked', 'SecurityError'); } };
    assert.equal(resolveUIRoot(current), current);
    current.parent = null;
    assert.equal(resolveUIRoot(current), current);
});

test('viewport prefers parent visualViewport, including keyboard/zoom offsets', () => {
    const root = { innerWidth: 1200, innerHeight: 900, visualViewport: { width: 390, height: 440, offsetLeft: 5, offsetTop: 30 } };
    assert.deepEqual(viewportSize(root), { width: 390, height: 440, left: 5, top: 30 });
    delete root.visualViewport;
    assert.deepEqual(viewportSize(root), { width: 1200, height: 900, left: 0, top: 0 });
});

test('100 pointer moves measure layout once and queue one compositor frame; abort cancels frame/capture/listeners', t => {
    const previous = Object.getOwnPropertyDescriptor(globalThis, 'window');
    let frameId = 0;
    const frames = new Map();
    const cancelled = [];
    const root = { document: {}, innerWidth: 1200, innerHeight: 900, AbortController,
        requestAnimationFrame: callback => { frames.set(++frameId, callback); return frameId; },
        cancelAnimationFrame: id => { frames.delete(id); cancelled.push(id); }, addEventListener() {} };
    Object.defineProperty(globalThis, 'window', { configurable: true, value: root });
    t.after(() => previous ? Object.defineProperty(globalThis, 'window', previous) : delete globalThis.window);
    const handlers = {};
    let captured = null, measurements = 0;
    const classes = { add() {}, remove() {} };
    const handle = { addEventListener: (name, callback, options) => { handlers[name] = { callback, signal: options.signal }; },
        classList: classes, setPointerCapture: id => { captured = id; }, hasPointerCapture: id => captured === id,
        releasePointerCapture: () => { captured = null; } };
    const panel = { style: { removeProperty(key) { delete this[key.replace(/-([a-z])/g, (_, letter) => letter.toUpperCase())]; } }, querySelector: () => handle,
        getBoundingClientRect: () => { measurements++; return { left: 100, top: 100, right: 1000, bottom: 800 }; } };
    const overlay = { querySelector: () => panel, classList: classes };
    const ui = new CacheMemoryUI({});
    ui.bindDialogDrag(overlay);
    handlers.pointerdown.callback({ button: 0, pointerId: 1, clientX: 300, clientY: 130, target: { closest: () => null }, preventDefault() {} });
    for (let move = 1; move <= 100; move++) handlers.pointermove.callback({ pointerId: 1, clientX: 300 + move, clientY: 130 + move });
    assert.equal(measurements, 1);
    assert.equal(frames.size, 1);
    assert.equal(panel.style.transform, undefined);
    const callback = [...frames.values()][0]; frames.clear(); callback();
    assert.equal(panel.style.transform, 'translate3d(100px, 100px, 0)');
    handlers.pointermove.callback({ pointerId: 1, clientX: 450, clientY: 280 });
    ui.controller.abort();
    assert.equal(frames.size, 0);
    assert.equal(captured, null);
    assert.equal(panel.style.willChange, undefined);
    assert.ok(Object.values(handlers).every(item => item.signal.aborted));
    assert.equal(measurements, 1);
    assert.ok(cancelled.length);
});
