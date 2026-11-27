import { getAssistantMessages, messageIdentity, messageContentFingerprint, messageFingerprint } from './utils.js?v=1.27.41';

// Opening is an extra source of the first stage, never a permanent prompt block
// or a renumbering of the existing assistant floors / CP5 / Long50 ranges.
export function getOpeningSource(chat) {
    const message = chat?.[0];
    if (message?.extra?.cache_memory_branch?.hasOpening === false) return null;
    if (!message || message.is_system || Array.isArray(message.extra?.tool_invocations)
        || typeof message.mes !== 'string' || !message.mes.trim()) return null;
    return { message, fingerprint: messageFingerprint(message), contentFingerprint: messageContentFingerprint(message) };
}

// Keep saved ranges stable for existing chats. The UI presents the extra
// opening summary as layer 1 and shifts ordinary reply labels by one.
export function getSummaryEntries(chat) {
    const assistants = getAssistantMessages(chat), opening = getOpeningSource(chat);
    if (!opening || assistants.some(entry => entry.message === opening.message)) return assistants;
    const messageId = messageIdentity(opening.message);
    return [{ ...opening, floor: 0, messageIndex: 0, messageId, sourceMessageKey: messageId, relatedMessageIds: [], isOpening: true }, ...assistants];
}

export function displayFloor(chat, floor) {
    return Number(floor) + (getOpeningSource(chat) && !getAssistantMessages(chat?.slice(0, 1)).length ? 1 : 0);
}

export function sourceFloor(chat, floor) {
    return Number(floor) - (getOpeningSource(chat) && !getAssistantMessages(chat?.slice(0, 1)).length ? 1 : 0);
}

export function publishedOpeningCoverage(chat, snapshot, publishedValue) {
    const opening = getOpeningSource(chat);
    return Boolean(opening && publishedValue && snapshot?.value === publishedValue
        && snapshot.blocks?.some(block => ['checkpoint', 'long-story', 'summary-story'].includes(block.type)
            && block.coversHistory === true && block.openingContentFingerprint === opening.contentFingerprint
            && block.text?.trim() && publishedValue.includes(block.text)));
}

export const stageStartLabel = item => item.openingContentFingerprint ? 0 : item.startFloor;
