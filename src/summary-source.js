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
