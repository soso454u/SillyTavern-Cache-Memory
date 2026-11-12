import { fnv1a, isNormalAssistant } from './utils.js?v=1.27.16';
import { parseStructuredSummary } from './summary-format.js?v=1.27.16';

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

export function timeJumpEvidence(source) {
    const jump = /^(?:(?:(?:时间)?(?:过去了?|转眼(?:就)?过了?))?[零〇一二两三四五六七八九十百\d]+(?:个)?(?:年|月|周|天)(?:过去了?|以后|后)|(?:时间)?(?:过去了?|转眼(?:就)?过了?)[零〇一二两三四五六七八九十百\d]+(?:个)?(?:年|月|周|天)|(?:one|two|three|a|an|\d+) (?:years?|months?|weeks?|days?) (?:later|(?:has |have )?passed))(?=[\s,，。.!！:：]|$)/iu;
    for (const { text } of source.messages) {
        const line = text.trim().split(/\r?\n/u)[0];
        if (!jump.test(line)) continue;
        const beforeScene = line.split(/[,，。；;]\s*(?=今天|此刻|眼下|镜头|[Tt]oday\b|[Rr]ight now\b)/u, 1)[0];
        if (beforeScene.length <= 360) return beforeScene;
        const window = beforeScene.slice(0, 360);
        return window.slice(0, Math.max(window.lastIndexOf('。'), window.lastIndexOf('，'), window.lastIndexOf(';'), window.lastIndexOf('.')) + 1) || line.match(jump)[0];
    }
    return '';
}

// Only leading, explicit out-of-story corrections can authorize replacing a
// previously confirmed history item. Dialogue and ordinary later denials cannot.
export function playerCorrectionEvidence(source) {
    return source.messages.flatMap(({ text }) => text.split(/\r?\n/u).map(line => line.trim())
        .filter(line => line.length <= 360 && (
            /^(?:(?:设定)?(?:纠正|更正|修正)|设定更新|更改设定|retcon|correction)\s*[:：]/iu.test(line)
            || /^(?:之前|先前|上一版)[^，。；!?！？]{0,32}(?:设定|说法|记录)(?:作废|有误|写错了)(?:[，。；：]|$)/u.test(line)
        ))).slice(0, 3);
}

export function summaryStoryBlock(row) {
    const fields = { ...(parseStructuredSummary(row.raw) ?? {}), ...row };
    const meaningful = text => text && !/^(?:无|none)[。.]?$/iu.test(String(text).trim());
    if (!meaningful(fields.event)) return null;
    const story = [['标题', fields.title], ['人物', fields.characters], ['时间', fields.storyTime], ['地点', fields.location],
        ['事件', fields.event], ['原话', fields.quote]].filter(([, text]) => meaningful(text)).map(([label, text]) => `${label}：${text}`).join('\n');
    return { id: `summary:${row.messageId ?? row.floor}`, type: 'summary-story', coversHistory: true,
        startFloor: row.floor, endFloor: row.floor, text: `[SUMMARY_STORY_${row.floor}]\n${story}` };
}
