import { getAssistantMessages, messageIdentity } from './utils.js?v=1.26.1';
import { publishedOpeningCoverage } from './opening-source.js?v=1.26.1';

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
export function filterCoveredHistory(coreChat, chat, snapshot, publishedValue, {
    type, summaries = {}, historyHandoff = snapshot?.historyHandoff === true, lastUserOnly = false,
} = {}) {
    const unchanged = reason => ({ messages: coreChat, removed: 0, reason });
    if (!Array.isArray(coreChat) || !Array.isArray(chat) || coreChat === chat) return unchanged('not-a-prompt-copy');
    const originals = new Set(chat);
    if (coreChat.some(row => originals.has(row))) return unchanged('not-a-prompt-copy');
    if (![undefined, 'normal', 'swipe', 'regenerate', 'continue'].includes(type)) return unchanged('generation-type');
    if (!historyHandoff && !lastUserOnly) return unchanged('selection-disabled');
    const originalById = unique(chat);
    // ST's index is assigned before interceptors, after system filtering. It
    // also identifies undated openings whose text has been changed by regex.
    const sourceSequences = [chat.filter(row => !row.is_system),
        chat.filter(row => !row.is_system || Array.isArray(row.extra?.tool_invocations))];
    const sourceFor = row => {
        const direct = originalById.get(identity(row));
        if (direct) return direct;
        if (!Number.isInteger(row.index) || row.index < 0) return null;
        const candidates = sourceSequences.map(sequence => sequence[row.index]);
        const source = candidates[0];
        return source && candidates.every(candidate => candidate === source)
            && (source.is_user === true) === (row.is_user === true) ? source : null;
    };
    const latestUser = chat.findLast((row, index) => index > 0 && row.is_user === true
        && !row.is_system && !Array.isArray(row.extra?.tool_invocations));
    const openingCovered = publishedOpeningCoverage(chat, snapshot, publishedValue);
    const selected = coreChat.filter(row => {
        if (row.is_system || Array.isArray(row.extra?.tool_invocations)) return true;
        const source = sourceFor(row);
        if (!source) return true;
        // Do not silently discard the only copy of the initial facts while
        // upgrading old CPs or before the first stage has been published.
        if (source === chat[0]) return !openingCovered;
        return !lastUserOnly || source.is_user !== true || source === latestUser;
    });
    const finish = (messages, reason) => ({ messages, removed: coreChat.length - messages.length, reason });
    if (!historyHandoff || snapshot?.historyHandoff !== true || !publishedValue || snapshot.value !== publishedValue) return finish(selected, 'selection-only');
    const blocks = (snapshot.blocks ?? []).filter(block => ['checkpoint', 'long-story'].includes(block.type) && block.coversHistory === true
        && Number.isInteger(block.startFloor) && Number.isInteger(block.endFloor)
        && block.startFloor >= 1 && block.endFloor >= block.startFloor
        && block.text?.trim() && publishedValue.includes(block.text));
    if (!blocks.length) return finish(selected, 'no-story-coverage');
    const entries = getAssistantMessages(chat);
    const limit = (entries.at(-1)?.floor ?? 0) - RECENT_RAW_FLOORS;
    const promptById = unique(selected);
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
            // Historical user input travels with its generated answer unless
            // the independent latest-user-only selection already excluded it.
            for (let i = previousIndex + 1; i <= entry.messageIndex; i++) {
                const original = chat[i];
                if (original === chat[0]) continue; // only the opening-coverage policy may remove it
                if (i !== entry.messageIndex && original.is_user !== true) continue;
                if (lastUserOnly && original === latestUser) continue;
                if (original.is_system || Array.isArray(original.extra?.tool_invocations)) continue;
                const key = identity(original), candidate = promptById.get(key);
                if (originalById.get(key) === original && candidate && candidate.is_system !== true
                    && !Array.isArray(candidate.extra?.tool_invocations)) remove.add(candidate);
            }
        }
        previousIndex = entry.messageIndex;
    }
    const messages = selected.filter(row => !remove.has(row));
    return finish(messages, 'published-story-coverage');
}
