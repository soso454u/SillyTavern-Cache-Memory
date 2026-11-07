import { fnv1a, isNormalAssistant } from './utils.js?v=1.27.16';

export const SUMMARY_FILTER_MODES = Object.freeze({
    DEFAULT: 'default',
    CUSTOM: 'custom',
    FULL: 'full',
});

function escapeRegExp(value) {
    return String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

export function parseSummarySourceTags(value) {
    const seen = new Set();
    return String(value ?? '').split(/[,\r\n]+/).map(item => item.trim()).filter(tag => {
        const key = tag.toLowerCase();
        if (!tag || seen.has(key)) return false;
        seen.add(key);
        return true;
    });
}

export function extractTagBlocks(messageText, tagName) {
    const tag = String(tagName ?? '').trim();
    if (!tag) return [];
    const escaped = escapeRegExp(tag);
    const pattern = new RegExp(`<\\s*${escaped}(?=[\\s>])[^>]*>([\\s\\S]*?)<\\s*\\/\\s*${escaped}\\s*>`, 'gi');
    return [...String(messageText ?? '').matchAll(pattern)]
        .map(match => String(match[1] ?? '').trim())
        .filter(Boolean);
}

export function extractSummarySource(messageText, filterSettings = {}) {
    const full = String(messageText ?? '');
    const mode = Object.values(SUMMARY_FILTER_MODES).includes(filterSettings.summaryFilterMode)
        ? filterSettings.summaryFilterMode
        : SUMMARY_FILTER_MODES.DEFAULT;
    if (mode === SUMMARY_FILTER_MODES.FULL) return { text: full, source: 'full' };

    const tags = mode === SUMMARY_FILTER_MODES.CUSTOM
        ? parseSummarySourceTags(filterSettings.summaryFilterTags)
        : ['content', 'context'];
    for (const tag of tags) {
        const blocks = extractTagBlocks(full, tag);
        if (blocks.length) return { text: blocks.join('\n'), source: mode === SUMMARY_FILTER_MODES.CUSTOM ? `custom:${tag}` : tag.toLowerCase() };
    }
    return { text: full, source: 'full' };
}

// Only the user input belonging to this assistant turn is new source material.
// System/tool messages are skipped; an earlier assistant is a hard boundary.
export function summaryUserSource(chat, entry) {
    const messages = [];
    if (!Array.isArray(chat) || !Number.isInteger(entry?.messageIndex)) return { messages, fingerprint: '' };
    for (let index = entry.messageIndex - 1; index >= 0; index--) {
        const message = chat[index];
        if (!message || message.is_system || Array.isArray(message.extra?.tool_invocations)
            || message.extra?.type === 'narrator' || message.extra?.isSmallSys) continue;
        if (isNormalAssistant(message)) break;
        if (message.is_user === true && String(message.mes ?? '').trim()) messages.unshift({
            speaker: String(message.name ?? 'user'), text: String(message.mes),
        });
    }
    return { messages, fingerprint: messages.length ? fnv1a(JSON.stringify(messages)) : '' };
}

export function formatSummaryUserSource(source) {
    // JSON keeps source text (including marker-like strings) inside data values.
    return source.messages.length ? `\n\n[CURRENT_USER_INPUT]\n${JSON.stringify(source.messages)}` : '';
}
