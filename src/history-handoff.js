import { getAssistantMessages, messageIdentity } from './utils.js?v=1.26.0';

export const RECENT_RAW_FLOORS = 5;

// Publication waits for a whole stage to leave the recent raw-text window.
// The resulting snapshot stays frozen until the next normal CP/Long boundary.
export function historyPublicationLimit(store, usable) {
    const floors = [
        ...Object.values(store.summaries ?? {}).filter(usable).map(row => row.floor),
        ...store.checkpoints.filter(usable).map(row => row.endFloor),
        ...store.longMemories.filter(usable).map(row => row.endFloor),
    ];
    return Math.max(0, Math.max(0, ...floors.filter(Number.isInteger)) - RECENT_RAW_FLOORS);
}

const identity = message => `${message.is_user === true ? 'user' : 'assistant'}:${messageIdentity(message)}`;
const unique = messages => {
    const found = new Map();
    for (const message of messages) {
        const key = identity(message);
        found.set(key, found.has(key) ? null : message);
    }
    return found;
};

/** Filter only a temporary generation array, using the exact published blocks.
 * No textual guessing, maximum-covered-floor shortcut, or stored-chat writes.
 */
export function filterCoveredHistory(coreChat, chat, snapshot, publishedValue, { type, summaries = {} } = {}) {
    const unchanged = reason => ({ messages: coreChat, removed: 0, reason });
    if (!Array.isArray(coreChat) || !Array.isArray(chat) || coreChat === chat) return unchanged('not-a-prompt-copy');
    const originals = new Set(chat);
    if (coreChat.some(row => originals.has(row))) return unchanged('not-a-prompt-copy');
    if (![undefined, 'normal', 'swipe', 'regenerate', 'continue'].includes(type)) return unchanged('generation-type');
    if (snapshot?.historyHandoff !== true || !publishedValue || snapshot.value !== publishedValue) return unchanged('unpublished');
    const blocks = (snapshot.blocks ?? []).filter(block => ['checkpoint', 'long-story'].includes(block.type) && block.coversHistory === true
        && Number.isInteger(block.startFloor) && Number.isInteger(block.endFloor)
        && block.startFloor >= 1 && block.endFloor >= block.startFloor
        && block.text?.trim() && publishedValue.includes(block.text));
    if (!blocks.length) return unchanged('no-story-coverage');
    const entries = getAssistantMessages(chat);
    const limit = (entries.at(-1)?.floor ?? 0) - RECENT_RAW_FLOORS;
    const originalById = unique(chat), promptById = unique(coreChat);
    const sourceFloors = new Map(), contentFloors = new Map();
    for (const row of Object.values(summaries)) {
        for (const id of new Set([row.messageId, row.sourceMessageKey].filter(Boolean))) {
            const floors = sourceFloors.get(id) ?? new Set();
            floors.add(row.floor); sourceFloors.set(id, floors);
        }
        if (row.sourceContentFingerprint) {
            const floors = contentFloors.get(row.sourceContentFingerprint) ?? new Set();
            floors.add(row.floor); contentFloors.set(row.sourceContentFingerprint, floors);
        }
    }
    const remove = new Set();
    let previousIndex = -1;
    for (const entry of entries) {
        const known = sourceFloors.get(entry.messageId) ?? contentFloors.get(entry.contentFingerprint);
        const assistantKey = identity(entry.message);
        // A partially loaded/reordered chat must not borrow another floor's
        // coverage. Unknown or ambiguous identities keep their original turns.
        const verified = known?.size === 1 && known.has(entry.floor)
            && originalById.get(assistantKey) === entry.message && promptById.get(assistantKey);
        if (verified && entry.floor <= limit && blocks.some(block => block.startFloor <= entry.floor && block.endFloor >= entry.floor)) {
            // Historical user input travels with its generated answer. A new
            // unanswered user turn, greeting, system message or tool stays.
            for (let i = previousIndex + 1; i <= entry.messageIndex; i++) {
                const original = chat[i];
                if (i !== entry.messageIndex && original.is_user !== true) continue;
                if (original.is_system || Array.isArray(original.extra?.tool_invocations)) continue;
                const key = identity(original), candidate = promptById.get(key);
                if (originalById.get(key) === original && candidate && candidate.is_system !== true
                    && !Array.isArray(candidate.extra?.tool_invocations)) remove.add(candidate);
            }
        }
        previousIndex = entry.messageIndex;
    }
    const messages = coreChat.filter(row => !remove.has(row));
    return { messages, removed: coreChat.length - messages.length, reason: 'published-story-coverage' };
}
