import { createEmptyStore, normalizeStore } from './memory-store.js?v=1.27.8';
import { chatFileIdentity } from './chat-file.js?v=1.27.8';
import { chatFloorOffset, getAssistantMessages } from './utils.js?v=1.27.8';
import { currentInjectionBlocks } from './injection.js?v=1.27.8';
import { refreshSnapshot } from './cache-control.js?v=1.27.8';
import { getOpeningSource } from './opening-source.js?v=1.27.8';
import { isUsableMemory } from './continuity.js?v=1.27.8';

const clone = value => structuredClone(value);
function uniqueId() {
    if (globalThis.crypto?.randomUUID) return globalThis.crypto.randomUUID();
    if (globalThis.crypto?.getRandomValues) return [...globalThis.crypto.getRandomValues(new Uint32Array(4))].map(value => value.toString(16).padStart(8, '0')).join('');
    return `${Math.random().toString(36).slice(2)}-${Date.now().toString(36)}`;
}
const safeName = name => String(name).replace(/[\\/:*?"<>|\u0000-\u001f]/g, '_').trim().slice(0, 100);
const canonical = value => JSON.stringify(value, function (_key, child) {
    return child && typeof child === 'object' && !Array.isArray(child)
        ? Object.fromEntries(Object.keys(child).sort().map(key => [key, child[key]])) : child;
});

export function captureChatFile(context, memory) {
    const id = chatFileIdentity(context);
    if (!id || memory?.chatId !== id || !Array.isArray(context.chat) || !context.chat.length) throw new Error('请等待聊天与记忆加载完成');
    const latest = getAssistantMessages(context.chat).at(-1)?.floor ?? 0;
    const recorded = Math.max(0, ...Object.values(memory.summaries).filter(isUsableMemory).map(row => row.floor),
        ...[...memory.checkpoints, ...memory.longMemories].filter(isUsableMemory).map(row => row.endFloor));
    if (recorded > latest) throw new Error('聊天正文尚未完整加载，或记忆包含已移除的后续楼层；请先核对再导出或创建分支');
    return clone([{ user_name: context.name1 ?? 'unused', character_name: context.name2 ?? 'unused',
        chat_metadata: { ...context.chatMetadata, cache_memory: memory } }, ...context.chat]);
}

export function chatFileDownload(rows, name) {
    return { filename: `${safeName(name || '聊天与记忆')}.jsonl`, content: rows.map(row => JSON.stringify(row)).join('\n') + '\n' };
}

export function prepareChatBranch(rows, { mode, count, endFloor, name = '平行线' }, settings,
    { uuid = uniqueId, now = () => new Date() } = {}) {
    const original = rows[0].chat_metadata.cache_memory, chat = rows.slice(1), entries = getAssistantMessages(chat);
    if (!entries.length) throw new Error('当前聊天还没有可选择的正常 char 楼层');
    const latest = entries.at(-1).floor;
    let start = entries[0].floor, end = latest, selected;
    if (mode === 'recent') {
        if (!Number.isSafeInteger(count) || count < 1 || count > entries.length) throw new Error(`最近楼层数须为 1–${entries.length} 的整数`);
        const first = entries.at(-count), previous = entries[entries.length - count - 1];
        start = first.floor;
        const sliceStart = previous ? previous.messageIndex + 1 : 0;
        selected = chat.slice(sliceStart);
        const opening = getOpeningSource(chat)?.message;
        // A generated first reply is a normal floor, not an extra greeting.
        if (sliceStart > 0 && opening && !entries.some(row => row.message === opening)) selected.unshift(opening);
    } else if (mode === 'through') {
        if (!Number.isSafeInteger(endFloor) || !entries.some(row => row.floor === endFloor)) throw new Error(`分叉楼层须在当前可见原文第 ${entries[0].floor}–${latest} 层内`);
        end = endFloor;
        selected = chat.slice(0, entries.find(row => row.floor === end).messageIndex + 1);
    } else throw new Error('请选择最近 N 层或截至第 N 层');
    selected = clone(selected);
    const offset = mode === 'recent' ? start - 1 : chatFloorOffset(chat);
    const memory = end === latest ? normalizeStore(clone(original), original.chatId) : normalizeStore(clone({
        ...createEmptyStore(original.chatId), version: 2, summaryMode: original.summaryMode,
        summaries: Object.fromEntries(Object.entries(original.summaries).filter(([, row]) => row.floor <= end)),
        checkpoints: original.checkpoints.filter(row => row.endFloor <= end),
        longMemories: original.longMemories.filter(row => row.endFloor <= end),
    }), original.chatId);
    if (offset > 0) {
        if (!settings.enabled || settings.injectionMode !== 'rolling') throw new Error('只保留近期正文时，请先启用“最近正文＋每层更新记忆”，以保留更早剧情');
        const blocks = currentInjectionBlocks(memory, { ...settings, injectionFloor: offset + 1, recentRawFloors: 1 }, 'rolling')
            .filter(row => row.coversHistory).sort((a, b) => a.startFloor - b.startFloor);
        let next = 1;
        for (const block of blocks) { if (block.startFloor > next) break; next = Math.max(next, block.endFloor + 1); }
        if (next <= offset) throw new Error(`第 ${next} 层起尚无完整剧情记忆，请先补齐记忆或保留更多正文`);
    }
    const hasOpening = getOpeningSource(chat)?.message === chat[0] && !entries.some(row => row.message === chat[0]);
    selected[0].extra = { ...selected[0].extra, cache_memory_branch: { version: 1, floorOffset: offset, hasOpening } };
    for (const entry of getAssistantMessages(selected)) for (const row of Object.values(memory.summaries)) {
        if (row.floor === entry.floor) row.messageIndex = entry.messageIndex;
    }
    const stamp = now().toISOString().replace(/[:.]/g, '-');
    const filename = `${safeName(name) || '平行线'} - ${stamp}-${uuid().slice(0, 8)}`;
    const scope = JSON.parse(original.chatId);
    memory.chatId = JSON.stringify([scope[0], scope[1], filename]);
    memory.sync = { revision: 0, writerId: '', writeId: '', savedAt: '' };
    delete memory.injectionSnapshot;
    refreshSnapshot(memory, { ...settings, injectionFloor: end }, 'manual reinject');
    const stable = ['note_prompt', 'note_interval', 'note_position', 'note_depth', 'note_role', 'persona'];
    const metadata = end === latest ? clone(rows[0].chat_metadata)
        : Object.fromEntries(stable.filter(key => Object.hasOwn(rows[0].chat_metadata, key)).map(key => [key, clone(rows[0].chat_metadata[key])]));
    delete metadata.main_chat;
    delete metadata.bookmark_link;
    metadata.integrity = uuid();
    metadata.cache_memory = memory;
    return { filename, rows: [{ ...rows[0], ...(scope[0] === 'group' ? { user_name: 'unused', character_name: 'unused' } : {}), chat_metadata: metadata }, ...selected], startFloor: start, endFloor: end };
}

export async function saveChatBranch({ branch, context, getContext, fetchImpl = fetch, saveGroupBranch, openAfterCreate = false, canSwitch = () => true }) {
    const originalId = chatFileIdentity(context), scope = JSON.parse(originalId);
    const group = scope[0] === 'group', filename = branch.filename;
    const headers = context.getRequestHeaders?.();
    if (!headers) throw new Error('酒馆请求头不可用，未创建聊天');
    const request = async (url, body) => {
        const response = await fetchImpl(url, { method: 'POST', headers, credentials: 'same-origin', cache: 'no-store', body: JSON.stringify(body) });
        if (!response.ok) throw new Error(`创建平行线失败：HTTP ${response.status}`);
        return response.json();
    };
    const read = () => request(group ? '/api/chats/group/get' : '/api/chats/get', group ? { id: filename }
        : { file_name: filename, avatar_url: scope[1], ch_name: context.characters[context.characterId].name });
    if (group && !saveGroupBranch) throw new Error('当前酒馆版本无法创建群聊分支');
    if (chatFileIdentity(getContext()) !== originalId) throw new Error('聊天已切换，未创建平行线');
    const existing = await read();
    if ((Array.isArray(existing) && existing.length) || (!Array.isArray(existing) && Object.keys(existing ?? {}).length)) throw new Error('同名聊天已存在，请重新创建');
    if (chatFileIdentity(getContext()) !== originalId) throw new Error('聊天已切换，未创建平行线');
    if (group) {
        // The native helper merges metadata; explicitly remove excluded keys.
        const metadata = { ...Object.fromEntries(Object.keys(context.chatMetadata).map(key => [key, undefined])), ...branch.rows[0].chat_metadata };
        await saveGroupBranch(context.groupId, filename, metadata, undefined, branch.rows.slice(1));
    } else await request('/api/chats/save', { file_name: filename, avatar_url: scope[1], chat: branch.rows, force: false });
    const saved = await read();
    if (!Array.isArray(saved) || canonical(saved) !== canonical(branch.rows))
        throw new Error(`新聊天「${filename}」尚未通过读回核对；请查看酒馆聊天列表，原聊天保留`);
    let switched = false;
    if (openAfterCreate && canSwitch() && chatFileIdentity(getContext()) === originalId) {
        if (group) await getContext().openGroupChat(context.groupId, filename);
        else await getContext().openCharacterChat(filename);
        switched = chatFileIdentity(getContext()) === branch.rows[0].chat_metadata.cache_memory.chatId;
    }
    return { filename, switched };
}
