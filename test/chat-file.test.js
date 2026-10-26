import test from 'node:test';
import assert from 'node:assert/strict';
import { chatFileIdentity, memoryFromChatFile } from '../src/chat-file.js';
import { createEmptyStore, memoryContentDigest, MemoryStore, normalizeStore } from '../src/memory-store.js';
import { MemoryPersistenceCoordinator, readSillyTavernRemoteStore } from '../src/persistence.js';
import { getAssistantMessages } from '../src/utils.js';

function fixture(group = false) {
    const chat = [{ is_user: false, mes: '合成开场', send_date: 'opening' }];
    for (let i = 1; i <= 3; i++) chat.push({ is_user: true, mes: `合成问题${i}`, extra: { preserved: true } },
        { is_user: false, mes: `合成正文${i}\n第二行`, gen_started: `generation-${i}`, swipes: [`合成正文${i}\n第二行`], swipe_info: [{ send_date: `date-${i}` }] });
    const oldId = JSON.stringify([group ? 'group' : 'character', group ? 'old-group' : 'original.png', 'original-chat']);
    const source = createEmptyStore(oldId);
    for (const entry of getAssistantMessages(chat)) source.summaries[entry.messageId] = { messageId: entry.messageId,
        floor: entry.floor, messageIndex: entry.messageIndex, sourceContentFingerprint: entry.contentFingerprint, event: `摘要${entry.floor}`, status: 'frozen', frozen: true };
    // A stale historical source is valid exported data, not proof of another chat.
    Object.values(source.summaries)[1].sourceContentFingerprint = 'before-a-body-edit';
    source.checkpoints.push({ id: 'cp-1', startFloor: 1, endFloor: 3, content: '合成阶段', status: 'frozen', frozen: true });
    source.longMemories.push({ id: 'long-1', startFloor: 1, endFloor: 3, content: '合成大总结', status: 'manual-edited', frozen: true });
    source.keepRegistry['KEEP-0001'] = { text: '长期约定', status: 'active' };
    source.stateOverrides.one = { value: '旧状态' };
    source.tombstones['Summary:retired'] = { sourceFloor: 2 };
    source.injectionSnapshot = { value: '冻结注入原文', blocks: [], signature: 'preserved-signature' };
    source.sync = { revision: 443, writerId: 'old-writer', writeId: 'old-write', savedAt: 'old-date' };
    const nativeHeader = { user_name: '合成用户', character_name: '合成角色', chat_metadata: { integrity: 'file-integrity', note_prompt: '保留作者注释', cache_memory: normalizeStore(source, oldId) } };
    const metadata = structuredClone(nativeHeader.chat_metadata);
    const context = { chatId: 'new-imported-chat', groupId: group ? 'new-group' : null, characterId: 0,
        characters: [{ name: '合成角色', avatar: 'imported-avatar.png' }], chat, chatMetadata: metadata,
        getRequestHeaders: () => ({ 'Content-Type': 'application/json' }) };
    const rows = () => structuredClone([nativeHeader, ...chat]);
    return { chat, oldId, metadata, context, rows, nativeHeader, id: chatFileIdentity(context) };
}

for (const group of [false, true]) test(`native file verifies a renamed import without changing any memory records (group=${group})`, async () => {
    const f = fixture(group), original = structuredClone(f.rows());
    const result = await readSillyTavernRemoteStore(() => f.context, f.context.chatId,
        async (_url, init) => { assert.equal(JSON.parse(init.body)[group ? 'id' : 'file_name'], f.context.chatId); return new Response(JSON.stringify(f.rows())); });
    assert.equal(result.chatId, f.id);
    assert.deepEqual(result.sync, { revision: 0, writerId: '', writeId: '', savedAt: '' });
    assert.equal(memoryContentDigest(result), memoryContentDigest(original[0].chat_metadata.cache_memory));
    assert.deepEqual(f.rows(), original);
    assert.deepEqual(result.injectionSnapshot, original[0].chat_metadata.cache_memory.injectionSnapshot);
});

for (const change of ['integrity', 'partial chat', 'different body', 'different role', 'different memory', 'missing integrity']) {
    test(`renamed-file binding rejects ${change} without mutating the page or file`, () => {
        const f = fixture(), rows = f.rows();
        if (change === 'integrity') f.context.chatMetadata.integrity = 'another-chat';
        if (change === 'missing integrity') delete f.context.chatMetadata.integrity;
        if (change === 'partial chat') f.context.chat = f.chat.slice(2);
        if (change === 'different body') f.context.chat = f.chat.map((x, i) => i === 2 ? { ...x, mes: '另一段正文' } : x);
        if (change === 'different role') f.context.chat = f.chat.map((x, i) => i === 2 ? { ...x, is_user: true } : x);
        if (change === 'different memory') Object.values(f.metadata.cache_memory.summaries)[0].event = '另一窗口编辑';
        const before = structuredClone({ rows, metadata: f.metadata });
        assert.throws(() => memoryFromChatFile(rows, f.id, f.context), /核对/);
        assert.deepEqual({ rows, metadata: f.metadata }, before);
    });
}

test('native reader rejects a character switch even if both characters have the same chat filename', async () => {
    const f = fixture();
    await assert.rejects(() => readSillyTavernRemoteStore(() => f.context, f.context.chatId, async () => {
        f.context.characters = [{ name: '另一角色', avatar: 'different.png' }];
        return new Response(JSON.stringify(f.rows()));
    }), /聊天已切换/);
});

for (const authority of [false, true]) test(`import recovery survives persistence, export and a second renamed import (authority=${authority})`, async () => {
    const f = fixture();
    let authoritative = { chatId: f.id, revision: 0, store: null }, nativeWrites = 0;
    const read = async () => readSillyTavernRemoteStore(() => f.context, f.context.chatId, async () => new Response(JSON.stringify(f.rows())));
    const p = new MemoryPersistenceCoordinator({ getChatId: () => chatFileIdentity(f.context), getMetadata: () => f.metadata,
        readRemoteStore: read, saveMetadata: async id => { assert.equal(id, f.id); nativeWrites++; f.nativeHeader.chat_metadata = structuredClone(f.metadata); },
        ...(authority ? { readAuthoritativeStore: async id => { assert.equal(id, f.id); return structuredClone(authoritative); },
            commitAuthoritative: async (id, payload) => { assert.equal(id, f.id); assert.equal(payload.baseRevision, authoritative.revision);
                authoritative = { chatId: id, revision: authoritative.revision + 1, store: structuredClone(payload.snapshot) }; return { record: structuredClone(authoritative) }; } } : {}),
    });
    const store = new MemoryStore({ getChatId: () => f.id, getMetadata: () => f.metadata, saveMetadata() {} });
    const before = memoryContentDigest(f.metadata.cache_memory);
    assert.throws(() => store.current(), /聊天身份不匹配/);
    const adopted = await p.rebindImportedChatMemory();
    p.activate(f.id, adopted);
    assert.equal((await p.loadLatest(f.id)).state, 'confirmed');
    await p.enqueue(store.current(), 'chat file identity changed');
    assert.equal((await p.flush(f.id)).state, 'confirmed');
    assert.equal(memoryContentDigest(store.current()), before);
    assert.equal(authority ? authoritative.store.chatId : f.nativeHeader.chat_metadata.cache_memory.chatId, f.id);
    if (!authority) assert.equal(nativeWrites, 1);
    // Native export/automatic backup is header + messages, with no plugin wrapper.
    const backup = [{ ...f.nativeHeader, chat_metadata: structuredClone(f.metadata) }, ...f.chat].map(JSON.stringify).join('\n');
    const rows = backup.split('\n').map(JSON.parse);
    assert.deepEqual(rows.slice(1), f.chat);
    const nextContext = { ...f.context, chatId: 'imported-again', chatMetadata: rows[0].chat_metadata };
    const restored = memoryFromChatFile(rows, chatFileIdentity(nextContext), nextContext);
    assert.equal(memoryContentDigest(restored), before);
    assert.equal(restored.sync.revision, 0);
});

test('import recovery discards a late read after a switch or page edit', async () => {
    for (const change of ['switch', 'edit']) {
        const f = fixture();
        let release;
        const wait = new Promise(resolve => { release = resolve; });
        const rebound = memoryFromChatFile(f.rows(), f.id, f.context);
        const p = new MemoryPersistenceCoordinator({ getChatId: () => chatFileIdentity(f.context), getMetadata: () => f.metadata,
            readRemoteStore: async () => { await wait; return rebound; } });
        const recovering = p.rebindImportedChatMemory();
        await Promise.resolve();
        if (change === 'switch') f.context.chatId = 'another-file';
        else Object.values(f.metadata.cache_memory.summaries)[0].event = '新的本机编辑';
        const before = structuredClone(f.metadata);
        release();
        await assert.rejects(recovering, /聊天或记忆已变化/);
        assert.deepEqual(f.metadata, before);
    }
});

test('a swallowed native identity save retains the pending copy and succeeds after retry', async () => {
    const f = fixture();
    const p = new MemoryPersistenceCoordinator({ getChatId: () => f.id, getMetadata: () => f.metadata,
        readRemoteStore: async () => readSillyTavernRemoteStore(() => f.context, f.context.chatId, async () => new Response(JSON.stringify(f.rows()))),
        saveMetadata: async () => {},
    });
    const adopted = await p.rebindImportedChatMemory();
    p.activate(f.id, adopted);
    await p.loadLatest(f.id);
    await p.enqueue(f.metadata.cache_memory, 'chat file identity changed');
    assert.equal((await p.flush(f.id)).state, 'failed');
    assert.ok(p.pending.has(f.id));
    assert.equal(f.nativeHeader.chat_metadata.cache_memory.chatId, f.oldId);
    p.saveMetadata = async () => { f.nativeHeader.chat_metadata = structuredClone(f.metadata); };
    assert.equal((await p.flush(f.id)).state, 'confirmed');
    assert.equal(f.nativeHeader.chat_metadata.cache_memory.chatId, f.id);
    assert.equal(p.pending.has(f.id), false);
});
