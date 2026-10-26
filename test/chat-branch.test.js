import test from 'node:test';
import assert from 'node:assert/strict';
import { captureChatFile, chatFileDownload, prepareChatBranch, saveChatBranch } from '../src/chat-branch.js';
import { chatFileIdentity } from '../src/chat-file.js';
import { getAssistantMessages, chatFloorOffset } from '../src/utils.js';
import { createEmptyStore, normalizeStore, MemoryStore } from '../src/memory-store.js';
import { normalizeSettings } from '../src/defaults.js';
import { CacheMemoryUI, configTemplate } from '../src/ui.js';
import { getOpeningSource } from '../src/opening-source.js';
import { filterCoveredHistory, promptHistoryFloor } from '../src/history-handoff.js';

function fixture(group = false, greeting = true) {
    const chat = greeting ? [{ name: '角色', is_user: false, mes: '合成开场' }] : [];
    for (let floor = 1; floor <= 12; floor++) chat.push({ is_user: true, mes: `问题${floor}`, send_date: `u${floor}` },
        { is_user: false, mes: `正文${floor}`, gen_started: `g${floor}`, swipes: [`正文${floor}`] });
    if (!greeting) chat.shift(); // A generated first reply is an ordinary floor.
    chat.push({ is_user: true, mes: '尚未回复的输入', send_date: 'pending' });
    const context = { chatId: 'original', name1: '用户', name2: '角色', groupId: group ? 'group-id' : null,
        characterId: 0, characters: [{ avatar: 'synthetic.png', name: '角色' }], chat, chatMetadata: { integrity: 'original-integrity', note_prompt: '作者注释', variables: { future: true }, other_extension: 'future extension state' },
        getRequestHeaders: () => ({ 'Content-Type': 'application/json' }) };
    const memory = createEmptyStore(chatFileIdentity(context));
    for (const row of getAssistantMessages(chat)) memory.summaries[row.messageId] = { floor: row.floor, messageIndex: row.messageIndex,
        messageId: row.messageId, sourceContentFingerprint: row.contentFingerprint, event: `剧情${row.floor}`, status: 'frozen', frozen: true };
    memory.checkpoints = [1, 6].map(startFloor => ({ id: `cp${startFloor}`, startFloor, endFloor: startFloor + 4, content: `[Stage Story]\n阶段${startFloor}`, status: 'frozen' }));
    memory.longMemories = [{ id: 'long1', startFloor: 1, endFloor: 10, content: '[STORY_ARC]\n未来剧情直到10', status: 'frozen' }];
    memory.keepRegistry['KEEP-0001'] = { sourceFloor: 12, text: '未来才获得的秘密', status: 'active' };
    memory.stateOverrides.future = { sourceFloor: 12, value: '未来状态' };
    memory.injectionSnapshot = { value: '旧线未来快照', blocks: [] };
    context.chatMetadata.cache_memory = normalizeStore(memory, memory.chatId);
    const settings = normalizeSettings();
    const rows = captureChatFile(context, context.chatMetadata.cache_memory);
    const build = options => prepareChatBranch(rows, options, settings, { uuid: () => 'synthetic-unique-uuid', now: () => new Date('2026-10-26T01:00:00Z') });
    return { context, memory: context.chatMetadata.cache_memory, settings, rows, build };
}

test('extra native JSONL download preserves every message and saved memory without touching its source', () => {
    const f = fixture(), before = captureChatFile(f.context, f.memory);
    const file = chatFileDownload(f.rows, '聊天/合成');
    assert.equal(file.filename, '聊天_合成.jsonl');
    assert.deepEqual(file.content.trim().split('\n').map(JSON.parse), f.rows);
    assert.deepEqual(f.rows.slice(1), f.context.chat);
    assert.deepEqual(f.rows[0].chat_metadata.cache_memory, f.memory);
    assert.deepEqual(captureChatFile(f.context, f.memory), before);
});

for (const greeting of [true, false]) test(`recent N keeps original floor numbers, earlier memories and user inputs (greeting=${greeting})`, () => {
    const f = fixture(false, greeting), before = structuredClone(f.rows);
    const branch = f.build({ mode: 'recent', count: 3, name: '平行线A' }), chat = branch.rows.slice(1), memory = branch.rows[0].chat_metadata.cache_memory;
    assert.deepEqual(getAssistantMessages(chat).map(row => row.floor), [10, 11, 12]);
    assert.equal(chatFloorOffset(chat), 9);
    assert.equal(getOpeningSource(chat)?.message.mes, greeting ? '合成开场' : undefined);
    assert.ok(chat.some(row => row.mes === '问题10'));
    assert.equal(chat.at(-1).mes, '尚未回复的输入');
    assert.equal(Object.keys(memory.summaries).length, 12);
    assert.deepEqual(memory.keepRegistry, f.memory.keepRegistry);
    assert.deepEqual(memory.stateOverrides, f.memory.stateOverrides);
    assert.notEqual(memory.chatId, f.memory.chatId);
    assert.notEqual(memory.injectionSnapshot.value, '旧线未来快照');
    assert.match(memory.injectionSnapshot.value, /剧情9/);
    chat.push({ is_user: false, mes: '分支第13层', gen_started: 'g13' });
    assert.equal(getAssistantMessages(chat).at(-1).floor, 13);
    assert.equal(promptHistoryFloor(structuredClone(chat), chat, memory.summaries), 13);
    assert.deepEqual(f.rows, before);
});

test('historical cut excludes later and spanning memories, mutable state and other extensions current metadata', () => {
    const f = fixture(), before = structuredClone(f.rows), branch = f.build({ mode: 'through', endFloor: 7 });
    const chat = branch.rows.slice(1), metadata = branch.rows[0].chat_metadata, memory = metadata.cache_memory;
    assert.equal(getAssistantMessages(chat).at(-1).floor, 7);
    assert.equal(chat.at(-1).mes, '正文7');
    assert.equal(Object.keys(memory.summaries).length, 7);
    assert.deepEqual(memory.checkpoints.map(row => row.id), ['cp1']);
    assert.equal(memory.longMemories.length, 0);
    assert.deepEqual(memory.keepRegistry, {});
    assert.deepEqual(memory.stateOverrides, {});
    assert.equal(metadata.variables, undefined);
    assert.equal(metadata.other_extension, undefined);
    assert.equal(metadata.note_prompt, '作者注释');
    assert.doesNotMatch(JSON.stringify(branch.rows), /未来才获得|未来剧情|旧线未来快照|未来状态|future extension/);
    assert.deepEqual(f.rows, before);
});

test('historical cut rebuilds early KEEP evidence rather than copying later resolved status', () => {
    const f = fixture();
    Object.values(f.rows[0].chat_metadata.cache_memory.summaries)[1].keep = '早期约定';
    f.rows[0].chat_metadata.cache_memory.keepRegistry['KEEP-0002'] = { sourceFloor: 2, text: '早期约定', status: 'resolved' };
    const branch = f.build({ mode: 'through', endFloor: 7 });
    const keeps = Object.values(branch.rows[0].chat_metadata.cache_memory.keepRegistry);
    assert.equal(keeps.find(row => row.text === '早期约定').status, 'active');
});

test('recent truncation refuses a gap in earlier story coverage and accepts a larger raw window', () => {
    const f = fixture();
    const source = f.rows[0].chat_metadata.cache_memory;
    const sixth = Object.entries(source.summaries).find(([, row]) => row.floor === 6)[0];
    delete source.summaries[sixth];
    assert.throws(() => f.build({ mode: 'recent', count: 3 }), /第 6 层/);
    assert.equal(f.build({ mode: 'recent', count: 7 }).startFloor, 6);
    assert.throws(() => prepareChatBranch(f.rows, { mode: 'recent', count: 3 }, { ...f.settings, enabled: false }), /每层更新记忆/);
    for (const options of [{ mode: 'recent', count: 0 }, { mode: 'recent', count: 1.5 }, { mode: 'recent', count: 13 }, { mode: 'through', endFloor: 99 }]) assert.throws(() => f.build(options));
});

test('a branch can be branched again while floor numbering and coverage stay consistent', () => {
    const f = fixture(), first = f.build({ mode: 'recent', count: 5 });
    const second = prepareChatBranch(first.rows, { mode: 'through', endFloor: 10 }, f.settings);
    assert.deepEqual(getAssistantMessages(second.rows.slice(1)).map(row => row.floor), [8, 9, 10]);
    assert.equal(second.rows[0].chat_metadata.cache_memory.longMemories.length, 1);
    const third = prepareChatBranch(second.rows, { mode: 'recent', count: 1 }, f.settings);
    assert.deepEqual(getAssistantMessages(third.rows.slice(1)).map(row => row.floor), [10]);
});

test('rolling prompt selection on a recent branch keeps the correct latest turns and no fake opening', () => {
    const f = fixture(false, false), branch = f.build({ mode: 'recent', count: 5 }), chat = branch.rows.slice(1), memory = branch.rows[0].chat_metadata.cache_memory;
    const result = filterCoveredHistory(structuredClone(chat), chat, memory.injectionSnapshot, memory.injectionSnapshot.value,
        { injectionMode: 'rolling', recentRawFloors: 3, summaries: memory.summaries });
    assert.deepEqual(result.messages.filter(row => row.is_user === false).map(row => row.mes), ['正文10', '正文11', '正文12']);
    assert.equal(result.messages.some(row => row.mes === '问题8'), false);
});

for (const group of [false, true]) for (const openAfterCreate of [false, true]) test(`native creation verifies new file and switches only when selected (group=${group}, open=${openAfterCreate})`, async () => {
    const f = fixture(group), branch = f.build({ mode: 'recent', count: 3 });
    const original = structuredClone(f.rows), files = new Map(), opens = [], posts = [];
    const sourceId = f.context.chatId;
    const fetchImpl = async (url, init) => {
        const body = JSON.parse(init.body); posts.push({ url, body });
        if (url.endsWith('/get')) return new Response(JSON.stringify(files.get(body.file_name ?? body.id) ?? []));
        files.set(body.file_name ?? body.id, structuredClone(body.chat));
        return new Response('{}');
    };
    f.context.openCharacterChat = async name => { opens.push(name); f.context.chatId = name; };
    f.context.openGroupChat = async (id, name) => { assert.equal(id, f.context.groupId); opens.push(name); f.context.chatId = name; };
    const result = await saveChatBranch({ branch, context: f.context, getContext: () => f.context, fetchImpl, openAfterCreate,
        saveGroupBranch: async (_id, name, metadata, _index, messages) => files.set(name, JSON.parse(JSON.stringify([{ chat_metadata: metadata, user_name: 'unused', character_name: 'unused' }, ...messages]))) });
    assert.equal(result.switched, openAfterCreate);
    assert.equal(opens.length, openAfterCreate ? 1 : 0);
    assert.equal(f.context.chatId, openAfterCreate ? branch.filename : sourceId);
    assert.deepEqual(captureChatFile({ ...f.context, chatId: sourceId }, f.memory), original);
    assert.ok(files.has(branch.filename));
    assert.ok(posts.every(row => row.body.file_name !== sourceId && row.body.id !== sourceId));
});

test('an existing destination, failed readback or changed current chat cannot cause overwrite or automatic switch', async () => {
    for (const failure of ['exists', 'readback', 'switch']) {
        const f = fixture(), branch = f.build({ mode: 'recent', count: 3 });
        let reads = 0, saves = 0, opens = 0;
        f.context.openCharacterChat = async () => { opens++; };
        await assert.rejects(() => saveChatBranch({ branch, context: f.context, getContext: () => f.context, openAfterCreate: true,
            fetchImpl: async (url) => {
                if (url.endsWith('/save')) { saves++; return new Response('{}'); }
                reads++;
                if (failure === 'switch') f.context.chatId = 'another-chat';
                return new Response(JSON.stringify(failure === 'exists' ? [{ chat_metadata: { integrity: 'existing' } }] : []));
            } }));
        assert.equal(opens, 0);
        assert.equal(saves, failure === 'readback' ? 1 : 0);
    }
});

test('branch dialog offers both modes and defaults to creating without switching', async () => {
    const f = fixture(); let options;
    assert.match(configTemplate(), /data-export-chat/); assert.match(configTemplate(), /data-create-branch/);
    const ui = Object.assign(Object.create(CacheMemoryUI.prototype), {
        captureChat: () => f.rows,
        showPluginDialog: async spec => {
            assert.equal(spec.fields.find(field => field.key === 'switch').value, 'stay');
            assert.equal(spec.fields.find(field => field.key === 'mode').options.length, 2);
            return { name: '测试分支', mode: 'recent', count: '3', endFloor: '12', switch: 'stay' };
        },
        createChatBranch: async (_rows, value) => { options = value; return { filename: '新聊天', switched: false }; },
        setManagerActionStatus() {},
    });
    await ui.performManagerClick({ target: { closest: selector => selector === '[data-create-branch]' ? {} : null } });
    assert.equal(options.openAfterCreate, false); assert.equal(options.count, 3);
});

test('capture refuses a partial transcript instead of exporting an incomplete backup', () => {
    const f = fixture();
    assert.throws(() => captureChatFile({ ...f.context, chat: f.context.chat.slice(-4) }, f.memory), /完整加载/);
});

test('creating while a reply begins never switches away from the generating chat', async () => {
    const f = fixture(), branch = f.build({ mode: 'recent', count: 3 });
    let saved, opens = 0;
    f.context.openCharacterChat = async () => { opens++; };
    const result = await saveChatBranch({ branch, context: f.context, getContext: () => f.context, openAfterCreate: true, canSwitch: () => false,
        fetchImpl: async (url, init) => {
            if (url.endsWith('/save')) { saved = JSON.parse(init.body).chat; return new Response('{}'); }
            return new Response(JSON.stringify(saved ?? []));
        } });
    assert.equal(result.switched, false); assert.equal(opens, 0); assert.ok(saved);
});

test('a continued branch saves its next Summary at the inherited floor and keeps earlier CP/Long', () => {
    const f = fixture(), branch = f.build({ mode: 'recent', count: 3 }), chat = branch.rows.slice(1);
    const metadata = branch.rows[0].chat_metadata;
    const store = new MemoryStore({ getChatId: () => metadata.cache_memory.chatId, getMetadata: () => metadata, saveMetadata() {} });
    chat.push({ is_user: false, mes: '平行线的新正文', gen_started: 'branch-next' });
    const entry = getAssistantMessages(chat).at(-1);
    store.addSummary({ messageId: entry.messageId, floor: entry.floor, messageIndex: entry.messageIndex,
        sourceContentFingerprint: entry.contentFingerprint, event: '平行线新摘要', status: 'frozen', frozen: true });
    assert.equal(entry.floor, 13);
    assert.equal(store.getSummary(entry.messageId).floor, 13);
    assert.equal(store.current().checkpoints.length, 2);
    assert.equal(store.current().longMemories.length, 1);
    assert.equal(Object.keys(f.memory.summaries).length, 12);
});
