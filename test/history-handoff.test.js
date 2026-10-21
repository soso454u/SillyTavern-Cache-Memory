import test from 'node:test';
import assert from 'node:assert/strict';
import { createEmptyStore } from '../src/memory-store.js';
import { normalizeSettings } from '../src/defaults.js';
import { refreshSnapshot, shouldRefreshInjection } from '../src/cache-control.js';
import { filterCoveredHistory } from '../src/history-handoff.js';
import { getAssistantMessages, messageIdentity, messageContentFingerprint } from '../src/utils.js';

const cp = (startFloor, endFloor) => ({ id: `checkpoint-${endFloor}`, startFloor, endFloor,
    status: 'frozen', content: `[CHECKPOINT]\n[Stage Story]\n合成历史${startFloor}至${endFloor}：旅人交出钥匙，守卫答应天亮前归还。` });
function addTurn(chat, floor) {
    chat.push({ name: '旅人', is_user: true, send_date: `u${floor}`, mes: `请求${floor}` },
        { name: '守卫', is_user: false, send_date: `a${floor}`, gen_started: `g${floor}`, mes: `答复${floor}` });
}
const pendingUser = { name: '旅人', is_user: true, send_date: 'new', mes: '新的请求' };
function setup(floors = 10) {
    const chat = [{ name: '守卫', is_user: false, mes: '角色卡开场白', send_date: 'greeting' }];
    const store = createEmptyStore('a'), settings = normalizeSettings({ historyHandoff: true });
    for (let floor = 1; floor <= floors; floor++) {
        addTurn(chat, floor);
        const id = messageIdentity(chat.at(-1));
        store.summaries[id] = { messageId: id, floor, event: `事件${floor}`, status: 'frozen' };
        if (floor % 5 === 0) store.checkpoints.push(cp(floor - 4, floor));
    }
    chat.push(structuredClone(pendingUser));
    refreshSnapshot(store, settings, 'settings changed');
    return { chat, store, settings };
}
const filter = (chat, store, options, core = structuredClone(chat)) => filterCoveredHistory(core, chat,
    store.injectionSnapshot, store.injectionSnapshot.value, { summaries: store.summaries, ...options });

test('normal conversations have exactly one story source per floor from 1 through 55, frozen between boundaries', () => {
    const { chat, store, settings } = setup(0);
    chat.pop();
    let prior = '', longAt50;
    for (let floor = 1; floor <= 55; floor++) {
        addTurn(chat, floor);
        const id = messageIdentity(chat.at(-1));
        store.summaries[id] = { messageId: id, floor, event: `事件${floor}`, status: 'frozen' };
        if (floor % 5 === 0) store.checkpoints.push(cp(floor - 4, floor));
        if (floor === 50) store.longMemories.push(longAt50 = { id: 'long-50', startFloor: 1, endFloor: 50,
            status: 'frozen', content: '[STORY_ARC]\n旅人与守卫履行承诺并归还钥匙。' });
        const reason = floor % 5 === 0 ? 'new checkpoint' : 'new summary';
        if (shouldRefreshInjection(settings, reason)) refreshSnapshot(store, settings, reason);
        if (floor % 5 !== 0) assert.equal(store.injectionSnapshot.value, prior);
        prior = store.injectionSnapshot.value;
        const original = structuredClone(chat);
        const source = [...chat, structuredClone(pendingUser)];
        const result = filter(source, store);
        const raw = getAssistantMessages(result.messages).map(entry => Number(entry.message.mes.replace('答复', '')));
        const blocks = store.injectionSnapshot.blocks.filter(block => ['checkpoint', 'long-story'].includes(block.type));
        for (let f = 1; f <= floor; f++) {
            const sources = Number(raw.includes(f)) + blocks.filter(block => block.startFloor <= f && block.endFloor >= f).length;
            assert.equal(sources, 1, `floor ${floor}, historical floor ${f}`);
        }
        assert.ok(raw.length >= Math.min(floor, 5));
        assert.ok(raw.length <= 9);
        assert.equal(result.messages.at(-1).mes, pendingUser.mes);
        assert.equal(result.messages[0].mes, '角色卡开场白');
        assert.deepEqual(chat, original);
        if (floor === 50) assert.equal(blocks.some(block => block.type === 'long-story'), false);
    }
    assert.ok(store.injectionSnapshot.blocks.some(block => block.type === 'long-story' && block.endFloor === 50));
    assert.equal(store.longMemories[0], longAt50);
    assert.equal(store.checkpoints.length, 11);
});

test('missing CP ranges retain their original turns; KEEP, role tables and facts never establish story coverage', () => {
    const { chat, store, settings } = setup(20);
    store.checkpoints = store.checkpoints.filter(row => row.startFloor !== 6);
    refreshSnapshot(store, settings, 'manual reinject');
    const result = filter(chat, store);
    for (let f = 6; f <= 10; f++) {
        assert.ok(result.messages.some(row => row.mes === `答复${f}`));
        assert.ok(result.messages.some(row => row.mes === `请求${f}`));
    }
    assert.equal(result.messages.some(row => row.mes === '答复11'), false);
    store.injectionSnapshot.blocks = store.injectionSnapshot.blocks.map(block => ({ ...block, type: 'keep' }));
    assert.equal(filter(chat, store).removed, 0);
});

test('unpublished, mismatched and legacy snapshots never remove history; recent text is protected', () => {
    const { chat, store } = setup();
    const snapshot = store.injectionSnapshot;
    assert.equal(filterCoveredHistory(structuredClone(chat), chat, snapshot, 'other prompt').removed, 0);
    assert.equal(filterCoveredHistory(structuredClone(chat), chat, { ...snapshot, historyHandoff: false }, snapshot.value).removed, 0);
    const unprinted = { ...snapshot, blocks: [...snapshot.blocks, { type: 'checkpoint', startFloor: 6, endFloor: 10, text: '未发布' }] };
    const result = filterCoveredHistory(structuredClone(chat), chat, unprinted, snapshot.value, { summaries: store.summaries });
    assert.equal(result.removed, 10);
    assert.ok(result.messages.some(row => row.mes === '答复10'));
    assert.equal(filterCoveredHistory(chat, chat, snapshot, snapshot.value).removed, 0);
});

test('swipe, continue, system/tool entries, ambiguous identities and regex-processed prompt copies', () => {
    const { chat, store } = setup();
    chat.splice(3, 0, { name: '系统', is_system: true, mes: '系统注入' });
    chat.splice(5, 0, { name: '守卫', send_date: 'tool', extra: { tool_invocations: [] }, mes: '工具调用' });
    const core = structuredClone(chat).map((row, index) => ({ ...row, mes: row.is_user ? '' : `正则处理：${row.mes}`, index }));
    const result = filter(chat, store, { type: 'normal' }, core);
    assert.equal(result.removed, 10);
    assert.ok(result.messages.some(row => row.is_system));
    assert.ok(result.messages.some(row => row.extra?.tool_invocations));
    assert.equal(result.messages.at(-1).send_date, 'new');
    for (const type of ['swipe', 'continue', 'regenerate']) {
        const prompt = structuredClone(chat);
        if (type === 'swipe') prompt.splice(prompt.findLastIndex(row => row.send_date === 'a10'), 1);
        const filtered = filter(chat, store, { type }, prompt);
        assert.ok(filtered.messages.some(row => row.send_date === 'a6'));
        if (type !== 'swipe') assert.ok(filtered.messages.some(row => row.send_date === 'a10'));
    }
    for (const type of ['quiet', 'impersonate', 'unsupported']) assert.equal(filter(chat, store, { type }).removed, 0);
    const duplicate = structuredClone(chat.find(row => row.send_date === 'a1'));
    chat.push(duplicate);
    assert.equal(filter(chat, store).messages.filter(row => row.send_date === 'a1').length, 2);
});

test('feature is opt-in; enabling rebuilds only injection and disabling preserves the original full projection', () => {
    const { store } = setup();
    const old = normalizeSettings();
    assert.equal(old.historyHandoff, false);
    const records = structuredClone({ summaries: store.summaries, checkpoints: store.checkpoints });
    refreshSnapshot(store, old, 'settings changed');
    assert.match(store.injectionSnapshot.value, /CHECKPOINT_10/);
    refreshSnapshot(store, normalizeSettings({ historyHandoff: true }), 'settings changed');
    assert.doesNotMatch(store.injectionSnapshot.value, /CHECKPOINT_10/);
    assert.match(store.injectionSnapshot.value, /CHECKPOINT_5/);
    assert.deepEqual({ summaries: store.summaries, checkpoints: store.checkpoints }, records);
});

test('partially loaded, reordered or unidentified floors and state-only legacy CPs keep their raw history', () => {
    const { chat, store, settings } = setup(20);
    const partial = chat.filter(row => !/^[ua][1-9]$/.test(row.send_date ?? ''));
    assert.equal(filter(partial, store).removed, 0);
    const unknown = structuredClone(chat).map(row => ({ ...row, send_date: `unknown-${row.send_date}`, mes: `未知正文${row.mes}` }));
    assert.equal(filter(unknown, store).removed, 0);
    store.checkpoints = [cp(1, 5)];
    store.checkpoints[0].content = '[CHECKPOINT]\n[Current State]\n守卫正在门口。';
    refreshSnapshot(store, settings, 'manual reinject');
    assert.equal(filter(chat, store).removed, 0);
});

test('imported message IDs may differ when a unique exact body fingerprint confirms the same floor', () => {
    const { chat, store } = setup();
    for (const entry of getAssistantMessages(chat)) {
        const record = store.summaries[entry.messageId];
        record.sourceContentFingerprint = messageContentFingerprint(entry.message);
        record.messageId = `imported-${entry.messageId}`;
    }
    assert.equal(filter(chat, store).removed, 10);
    // An identical text attributed to two different floors cannot anchor one.
    const entry = getAssistantMessages(chat)[0];
    store.summaries.ambiguous = { messageId: 'ambiguous', floor: 2, sourceContentFingerprint: entry.contentFingerprint };
    assert.ok(filter(chat, store).messages.some(row => row.mes === '答复1'));
});
