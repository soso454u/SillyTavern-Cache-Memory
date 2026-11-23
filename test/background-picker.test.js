import test from 'node:test';
import assert from 'node:assert/strict';
import { CacheMemoryUI, configTemplate } from '../src/ui.js';

// Small DOM double for event-independent picker behavior. No private chat,
// real API, browser profile or model is needed for these interactions.
class Node {
    constructor(tag = 'div') { this.tagName = tag.toUpperCase(); this.children = []; this.dataset = {}; this.attrs = {}; this.className = ''; this.value = ''; this.checked = false; this.disabled = false; this.listeners = {}; }
    addEventListener(type, listener) { (this.listeners[type] ??= []).push(listener); }
    dispatchEvent(event) { for (const listener of this.listeners[event.type] ?? []) listener(event); }
    focus() { this.focused = true; }
    append(...nodes) { for (const node of nodes) { node.parent = this; this.children.push(node); } }
    replaceChildren(...nodes) { this.children = []; this.text = ''; this.append(...nodes); }
    set textContent(value) { this.text = value; this.children = []; }
    get textContent() { return (this.text || '') + this.children.map(node => node.textContent).join(''); }
    setAttribute(key, value) { this.attrs[key] = value; }
    hasAttribute(key) {
        if (key.startsWith('data-')) return key.slice(5).replace(/-([a-z])/g, (_, letter) => letter.toUpperCase()) in this.dataset;
        return key in this.attrs;
    }
    matches(selector) {
        return selector.split(',').some(part => {
            part = part.trim();
            if (part.endsWith(':checked')) return this.checked && this.matches(part.slice(0, -8));
            if (part.startsWith('.')) return this.className.split(' ').includes(part.slice(1));
            if (part.startsWith('[')) {
                const [, key, value] = part.match(/^\[([^=\]]+)(?:="([^"]*)")?\]$/) || [];
                if (!key || !this.hasAttribute(key)) return false;
                const saved = key.startsWith('data-') ? this.dataset[key.slice(5).replace(/-([a-z])/g, (_, letter) => letter.toUpperCase())] : this.attrs[key];
                return value === undefined || saved === value;
            }
            return this.tagName.toLowerCase() === part;
        });
    }
    querySelectorAll(selector) { return this.children.flatMap(node => [...(node.matches(selector) ? [node] : []), ...node.querySelectorAll(selector)]); }
    querySelector(selector) { return this.querySelectorAll(selector)[0] ?? null; }
    closest(selector) { return this.matches(selector) ? this : this.parent?.closest(selector) ?? null; }
    get classList() { return { toggle: (value, enabled) => { const names = new Set(this.className.split(' ').filter(Boolean)); if (enabled) names.add(value); else names.delete(value); this.className = [...names].join(' '); } }; }
}

function fixture() {
    const tasks = { active: false, state: { status: 'idle' }, previewChat: async () => Array.from({ length: 25 }, (_, index) => ({ name: index % 2 ? '合成角色' : '用户', text: `消息${index + 1} <b>原文</b>` })) };
    const ui = new CacheMemoryUI({ getBackgroundTasks: () => tasks });
    ui.doc = { createElement: tag => new Node(tag) }; ui.root = { AbortController };
    ui.config = new Node(); const panel = new Node(); panel.dataset.settingsPanel = 'tools'; ui.config.append(panel);
    for (const [key, tag] of [['backgroundCharacter', 'select'], ['backgroundChats', 'div'], ['backgroundSelection', 'p'],
        ['backgroundStatus', 'p'], ['backgroundStart', 'button'], ['backgroundStop', 'button'], ['backgroundPreview', 'section']]) {
        const node = new Node(tag); node.dataset[key] = ''; panel.append(node);
    }
    panel.querySelector('[data-background-character]').value = 'synthetic.png';
    panel.querySelector('[data-background-stop]').disabled = true;
    ui.renderBackgroundChats(['合成聊天A', '合成聊天B'], 'synthetic.png');
    return { ui, panel, tasks, checks: panel.querySelectorAll('[data-background-check]') };
}

test('explicit checkbox selection, text labels and selected count agree; select-all can be undone', async () => {
    const { ui, panel, checks } = fixture();
    const count = panel.querySelector('[data-background-selection]'), start = panel.querySelector('[data-background-start]');
    assert.equal(count.textContent, '已选 0 / 共 2 份聊天'); assert.equal(start.disabled, true);
    checks[0].checked = true; ui.updateBackgroundSelection();
    assert.equal(count.textContent, '已选 1 / 共 2 份聊天'); assert.equal(start.disabled, false);
    assert.equal(checks[0].closest('.cache-memory-background-chat').querySelector('[data-background-selected-label]').textContent, '已选');
    const button = new Node('button'); panel.append(button); button.dataset.backgroundAll = '';
    await ui.handleBackgroundAction(button); assert.equal(count.textContent, '已选 2 / 共 2 份聊天');
    delete button.dataset.backgroundAll; button.dataset.backgroundNone = '';
    await ui.handleBackgroundAction(button); assert.equal(count.textContent, '已选 0 / 共 2 份聊天'); assert.equal(start.disabled, true);
    assert.doesNotMatch(configTemplate(), /select data-background-chats/);
});

test('viewing and paging a chat preserves all checkboxes; closing releases its content', async () => {
    const { ui, panel, checks } = fixture(); checks[1].checked = true; ui.updateBackgroundSelection();
    await ui.previewBackgroundChat('合成聊天A');
    const preview = panel.querySelector('[data-background-preview]');
    assert.deepEqual(checks.map(check => check.checked), [false, true]);
    assert.equal(preview.querySelectorAll('article').length, 20); assert.match(preview.textContent, /第 1\/2 页/);
    assert.match(preview.textContent, /<b>原文<\/b>/);
    const next = preview.querySelectorAll('[data-background-preview-page]')[1]; await ui.handleBackgroundAction(next);
    assert.equal(preview.querySelectorAll('article').length, 5); assert.match(preview.textContent, /消息 21–25/);
    assert.deepEqual(checks.map(check => check.checked), [false, true]);
    ui.clearBackgroundPreview(); assert.equal(ui.backgroundPreview, null); assert.equal(preview.hidden, true); assert.equal(preview.children.length, 0);
});

test('a late previous preview cannot replace a newer chat or reopen a closed preview', async () => {
    const { ui, panel, tasks } = fixture(); let resolve;
    tasks.previewChat = async (_, file) => file === '合成聊天A' ? new Promise(done => { resolve = done; }) : [{ name: '合成角色', text: '新的预览' }];
    const previous = ui.previewBackgroundChat('合成聊天A');
    await ui.previewBackgroundChat('合成聊天B');
    resolve([{ name: '用户', text: '过期内容' }]); await previous;
    assert.match(panel.querySelector('[data-background-preview]').textContent, /新的预览/);
    assert.doesNotMatch(panel.querySelector('[data-background-preview]').textContent, /过期内容/);
    const pending = ui.previewBackgroundChat('合成聊天A'); ui.clearBackgroundPreview(); resolve([]); await pending;
    assert.equal(panel.querySelector('[data-background-preview]').hidden, true);
});

test('compact summary editors keep empty legacy fields folded and retain every field for saving', () => {
    const { ui } = fixture(), body = new Node();
    ui.inlineEditor(body, ui.summaryEditorFields({ title: '合成标题', event: '合成事件', state: '', open: '', quote: '', keep: '' }));
    const extra = body.querySelector('.cache-memory-editor-extra');
    assert.equal(Boolean(extra.open), false);
    assert.equal(body.querySelectorAll('[data-edit-field]').length, 9);
    assert.equal(extra.querySelectorAll('[data-edit-field]').length, 4);
    assert.equal(body.querySelectorAll('[data-expand-editor]').length, 6);
    assert.equal(body.querySelector('[data-edit-field="event"]').dataset.memoryCompact, 'true');
    const existing = new Node(); ui.inlineEditor(existing, ui.summaryEditorFields({ title: '合成标题', event: '合成事件', keep: '保留的约定' }));
    assert.equal(existing.querySelector('.cache-memory-editor-extra').open, true);
});

test('expanded editing applies only to the draft; cancel, replaced fields and chat changes cannot overwrite it', async () => {
    const { ui } = fixture(), input = new Node('textarea'); let chatId = 'synthetic', events = 0;
    ui.store = { current: () => ({ chatId }) }; ui.setStatus = () => {};
    input.value = '原始草稿'; input.addEventListener('input', () => events++);
    ui.showPluginDialog = async options => { assert.equal(options.expandedEditor, true); return { text: '展开后的修改' }; };
    await ui.expandEditorField(input, '事件'); assert.equal(input.value, '展开后的修改'); assert.equal(events, 1);
    ui.showPluginDialog = async () => null;
    await ui.expandEditorField(input, '事件'); assert.equal(input.value, '展开后的修改');
    ui.showPluginDialog = async () => { input.value = '已经更新的本机草稿'; return { text: '较早修改' }; };
    await ui.expandEditorField(input, '事件'); assert.equal(input.value, '已经更新的本机草稿');
    ui.showPluginDialog = async () => { chatId = 'other'; return { text: '另一聊天不应接收' }; };
    await ui.expandEditorField(input, '事件'); assert.equal(input.value, '已经更新的本机草稿');
    input.isConnected = false; ui.showPluginDialog = async () => ({ text: '旧控件不应接收' });
    await ui.expandEditorField(input, '事件'); assert.equal(input.value, '已经更新的本机草稿'); assert.equal(events, 1);
});
