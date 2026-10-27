import { messageContentFingerprint, messageFingerprint } from './utils.js?v=1.27.9';

// Opening is an extra source of the first stage, never a permanent prompt block
// or a renumbering of the existing assistant floors / CP5 / Long50 ranges.
export function getOpeningSource(chat) {
    const message = chat?.[0];
    if (message?.extra?.cache_memory_branch?.hasOpening === false) return null;
    if (!message || message.is_system || Array.isArray(message.extra?.tool_invocations)
        || typeof message.mes !== 'string' || !message.mes.trim()) return null;
    return { message, fingerprint: messageFingerprint(message), contentFingerprint: messageContentFingerprint(message) };
}

export function publishedOpeningCoverage(chat, snapshot, publishedValue) {
    const opening = getOpeningSource(chat);
    return Boolean(opening && publishedValue && snapshot?.value === publishedValue
        && snapshot.blocks?.some(block => ['checkpoint', 'long-story'].includes(block.type)
            && block.coversHistory === true && block.openingContentFingerprint === opening.contentFingerprint
            && block.text?.trim() && publishedValue.includes(block.text)));
}

export const stageStartLabel = item => item.openingContentFingerprint ? 0 : item.startFloor;
