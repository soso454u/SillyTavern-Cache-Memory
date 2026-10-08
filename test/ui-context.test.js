import test from 'node:test';
import assert from 'node:assert/strict';
import { resolveUIRoot, viewportSize } from '../src/ui-context.js';
import { buildCheckpointContent, CacheMemoryUI, parseCheckpointSections } from '../src/ui.js';

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
