import test from 'node:test';
import assert from 'node:assert/strict';
import { CacheMemoryUI } from '../src/ui.js';
import { MemoryStore } from '../src/memory-store.js';
import { getAssistantMessages } from '../src/utils.js';
import { parseStructuredSummary } from '../src/summary-format.js';

function fixture() {
    let chatId = 'synthetic-message';
    const chat = [{ mes: '合成正文', gen_started: 'synthetic-generation' }];
    const store = new MemoryStore({ getChatId: () => chatId, getMetadata: () => metadata, saveMetadata: () => {} });
    const metadata = {};
    const entry = getAssistantMessages(chat)[0];
    store.addSummary({ messageId: entry.messageId, floor: 1, title: '合成标题', event: '合成事件', state: '旧版状态', open: '尚待核实的线索', quote: '合成原话', keep: '独有线索',
        sourceFingerprint: entry.fingerprint, sourceContentFingerprint: entry.contentFingerprint, status: 'frozen', frozen: true });
    const ui = new CacheMemoryUI({ store, getChat: () => chat });
    ui.doc = { querySelectorAll: () => [] };
    ui.openManager = () => { throw Error('Message editing must not open a manager'); };
    const widget = { dataset: { messageId: entry.messageId }, querySelectorAll: () => ui.summaryEditorFields(ui.messageEditing.values, { includeLegacy: false })
        .map(({ key, value }) => ({ dataset: { editField: key }, value })) };
    return { ui, store, chat, entry, widget, switchChat: () => { chatId = 'other-synthetic-chat'; delete metadata.cache_memory; } };
}

test('message editing shows five core fields and preserves hidden legacy values in the record and raw payload', () => {
    const f = fixture();
    f.ui.editSummary(f.entry.messageId);
    assert.equal(f.ui.messageExpanded.has(f.entry.messageId), true);
    f.ui.messageEditing.values.event = '人工修正的合成事件';
    assert.deepEqual(f.widget.querySelectorAll().map(row => row.dataset.editField), ['title', 'storyTime', 'location', 'characters', 'event']);
    f.ui.saveMessageEdit(f.widget);
    const saved = f.store.getSummary(f.entry.messageId);
    assert.equal(saved.event, '人工修正的合成事件');
    assert.equal(saved.quote, '合成原话');
    assert.equal(saved.keep, '独有线索');
    assert.equal(saved.state, '旧版状态');
    assert.equal(saved.open, '尚待核实的线索');
    const parsed = parseStructuredSummary(saved.raw);
    for (const key of ['state', 'open', 'quote', 'keep']) assert.equal(parsed[key], saved[key]);
    assert.equal(f.ui.summaryEditorFields(saved).length, 9); // Manager keeps access to old fields.
    assert.equal(saved.status, 'manual-edited');
    assert.equal(saved.frozen, true);
    assert.equal(saved.stateChangesNeedsReview, true);
    assert.equal(saved.sourceContentFingerprint, f.entry.contentFingerprint);
    assert.match(saved.raw, /人工修正的合成事件/);
    assert.equal(f.chat[0].mes, '合成正文');
    assert.equal(f.ui.messageEditing, null);
});

test('unsaved message drafts do not modify memory and cannot overwrite a changed body or Summary', () => {
    for (const change of ['body', 'summary', 'quote', 'state', 'chat']) {
        const f = fixture();
        f.ui.editSummary(f.entry.messageId);
        f.ui.messageEditing.values.event = '未保存草稿';
        assert.equal(f.store.getSummary(f.entry.messageId).event, '合成事件');
        if (change === 'body') f.chat[0].mes = '切换后的合成正文';
        else if (change === 'summary') f.store.updateSummary(f.entry.messageId, { event: '另一窗口修改' });
        else if (change === 'quote') f.store.updateSummary(f.entry.messageId, { quote: '另一窗口修改原话' });
        else if (change === 'state') f.store.updateSummary(f.entry.messageId, { state: '另一窗口更新旧字段' });
        else f.switchChat();
        const before = structuredClone(f.store.current());
        f.ui.saveMessageEdit(f.widget);
        assert.deepEqual(f.store.current(), before);
        assert.equal(f.ui.messageEditing.values.event, '未保存草稿');
    }
});

test('message editing uses the saved record key when the current message ID differs', () => {
    const f = fixture(), original = f.store.getSummary(f.entry.messageId);
    delete f.store.current().summaries[f.entry.messageId];
    f.store.current().summaries['legacy-key'] = { ...original, messageId: 'legacy-key' };
    f.ui.editSummary(f.entry.messageId);
    assert.equal(f.ui.messageEditing.summaryId, 'legacy-key');
    f.ui.messageEditing.values.event = '手动编辑已存摘要';
    f.ui.saveMessageEdit(f.widget);
    assert.equal(f.store.getSummary('legacy-key').event, '手动编辑已存摘要');
    assert.equal(f.store.getSummary(f.entry.messageId), null);
    assert.equal(Object.keys(f.store.current().summaries).length, 1);
});
