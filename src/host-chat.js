import { chatFileIdentity } from './chat-file.js?v=1.27.42';

// TT can leave null historical slots in the full-index array. Hydrate only
// those slots through its public backend API; never overwrite a loaded draft.
export async function hydrateHostChat(getContext, root = globalThis.window) {
    const context = getContext(), chat = context?.chat;
    if (!Array.isArray(chat) || !chat.some(row => row == null)) return;
    const api = root?.__TAURITAVERN__?.api?.chat;
    if (!api?.current?.handle) throw new Error('聊天历史尚未完整加载，请先加载历史后重试总结');
    const identity = chatFileIdentity(context), handle = api.current.handle();
    const rows = new Map();
    let page = await handle.history.tail({ limit: 200 });
    for (;;) {
        if (!page || !Number.isSafeInteger(page.startIndex) || page.startIndex < 0 || !Array.isArray(page.messages) || !page.messages.length)
            throw new Error('TT 历史接口返回不完整，已停止总结');
        for (const [offset, row] of page.messages.entries()) rows.set(page.startIndex + offset, row);
        if (!page.hasMoreBefore) break;
        const next = await handle.history.before(page, { limit: 200 });
        if (!next || next.startIndex >= page.startIndex) throw new Error('TT 历史分页未前进，已停止总结');
        page = next;
    }
    const live = getContext();
    if (chatFileIdentity(live) !== identity || live.chat !== chat || rows.size !== chat.length)
        throw new Error('读取历史期间聊天已变化，请重试');
    for (let index = 0; index < chat.length; index++) {
        const saved = rows.get(index), loaded = chat[index];
        if (!saved || typeof saved.mes !== 'string' || loaded && (loaded.mes !== saved.mes
            || Boolean(loaded.is_user) !== Boolean(saved.is_user) || Boolean(loaded.is_system) !== Boolean(saved.is_system)))
            throw new Error('TT 后端历史与当前正文不一致，未覆盖页面内容');
    }
    for (let index = 0; index < chat.length; index++) if (chat[index] == null) chat[index] = structuredClone(rows.get(index));
}
