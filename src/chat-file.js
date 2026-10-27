import { memoryContentDigest, normalizeStore } from './memory-store.js?v=1.27.10';

export function chatFileIdentity(context, chatId = context?.chatId) {
    if (!chatId || String(context?.chatId ?? '') !== String(chatId)) return '';
    const group = context.groupId !== null && context.groupId !== undefined && context.groupId !== '';
    const owner = group ? context.groupId : context.characters?.[context.characterId]?.avatar;
    return owner === null || owner === undefined || owner === '' ? ''
        : JSON.stringify([group ? 'group' : 'character', String(owner), String(chatId)]);
}

// Compare the complete in-memory transcript with the file fetched for the
// current character/group. Rendering metadata may change while loading.
export function sameChatTranscript(left, right) {
    const body = rows => JSON.stringify(rows.map(row => [row?.is_user === true, row?.is_system === true, row?.mes]));
    return Array.isArray(left) && Array.isArray(right) && left.length > 0 && left.length === right.length && body(left) === body(right);
}

export function memoryFromChatFile(rows, chatId, context) {
    const metadata = rows?.[0]?.chat_metadata;
    const source = metadata?.cache_memory ?? null;
    if (!source?.chatId || source.chatId === chatId) return source;
    const page = context?.chatMetadata;
    // A filename change alone is insufficient. The live page and the fetched
    // native file must agree on integrity, full bodies, and the memory copy.
    // This also permits an old Summary whose body was edited before export.
    if (!chatId || !metadata.integrity || metadata.integrity !== page?.integrity
        || !sameChatTranscript(rows.slice(1), context?.chat)
        || !page?.cache_memory || ![source.chatId, chatId].includes(page.cache_memory.chatId)
        || (page.cache_memory.chatId !== chatId && memoryContentDigest(page.cache_memory) !== memoryContentDigest(source)))
        throw new Error('导入聊天的文件身份或完整正文尚未核对，原记忆保留；请等待聊天加载完成后重试');
    const rebound = normalizeStore(structuredClone(source), chatId);
    // The former authority's revision/write ID cannot become the comparison
    // base of this new chat. Memory records and frozen bytes remain unchanged.
    rebound.sync = { revision: 0, writerId: '', writeId: '', savedAt: '' };
    return rebound;
}

