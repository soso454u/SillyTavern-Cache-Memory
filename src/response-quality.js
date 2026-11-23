import { parseStructuredSummary } from './summary-format.js?v=1.27.38';

const REFUSAL = /^(?:(?:i(?:['’]m| am)\s+sorry|sorry)[,.!]?\s*(?:but\s+)?|as an? (?:ai|large language) model[, ]+)?(?:i|we)\s+(?:cannot|can['’]t|am unable to|are unable to|won['’]t|will not)\s+(?:assist|help|fulfil[l]?|comply|provide|generate|create|process|continue|engage)\b/i;
const REFUSAL_TARGET = /(?:(?:this|that|your|the) (?:request|prompt)|requested (?:content|text)|content you(?:['’]re| are) (?:asking|requesting)|(?:sexual|explicit|pornographic|violent|illegal|disallowed|unsafe) content|(?:content|safety) polic(?:y|ies)|as an? (?:ai|large language) model)/i;
const RESPONSE_ERROR = /^(?:(?:api |upstream |generation |request )error\s*[:：]|(?:request|generation) failed\s*[:：]|HTTP\s+(?:401|403|429|5\d\d)\b|\{\s*"error"\s*:|(?:this (?:request|prompt|content)|your (?:request|prompt)) (?:violates|is (?:not allowed|blocked))\b|please (?:try (?:again|a different prompt)|rephrase your (?:request|prompt))\b)/i;
const EMPTY = /^(?:无|无新增|暂无|未知|未提供|none|null|n\/a|\[\]|[-—–]+)[。.!]?$/i;

// Match the service speaking to the user, not a character reporting an action.
// Quoted dialogue and exact source lines are protected by the response cleaner.
export function isGeneratedFailureLine(value) {
    const text = String(value ?? '').trim().replace(/^(?:[-*•]|\d+[.)、])\s+/, '')
        .replace(/^(\*\*|__)(.+)\1$/, '$2').trim();
    if (REFUSAL.test(text) && (REFUSAL_TARGET.test(text)
        || /\b(?:assist|help|comply|engage)\s+(?:you\s+)?(?:with\s+)?(?:that|this)[.!]?\s*$/i.test(text))) return true;
    if (RESPONSE_ERROR.test(text)) return true;
    const body = text.replace(/^(?:(?:你好|您好|很抱歉|非常抱歉|抱歉|对不起|很遗憾)[，,。！!：:\s]+)+/, '')
        .replace(/^(?:但|但是|不过)[，,\s]*/, '')
        .replace(/^作为(?:一个|一名)?\s*(?:人工智能|AI|语言)(?:助手|模型)[，,\s]+/i, '');
    const apology = /^(?:很抱歉|非常抱歉|抱歉|对不起|很遗憾)[，,。！!：:\s]/.test(text);
    if (/^(?:这个|该|此|您的|你的)(?:问题|请求|内容)[，,\s]*(?:我|我们)?(?:无法|不能|不便|没法)(?:回答|回复|回应|处理|满足|完成)/.test(body)) return true;
    if (/^(?:我|我们)?(?:无法|不能|不便|没法)(?:协助|处理|满足|完成|继续|提供|生成|总结|回应|执行|回答)[^。！？\n]*(?:(?:这个|该|此|您的|你的)(?:问题|请求)|(?:上述|所请求的|这类|此类)内容|相关政策|内容政策|安全政策)/.test(body)) return true;
    if (apology && /^(?:我|我们)?(?:无法|不能|不便|没法)(?:回答|回复|帮助你|帮助您|协助你|协助您|提供帮助)(?:[，,。！!\s]|$)/.test(body)) return true;
    return /^(?:没有|未能|未|没能)(?:找到|检索到|搜索到)(?:任何)?相关(?:的)?(?:结果|内容|信息|答案)[。！!\s]*$/.test(body);
}

export function isFailureOnlyText(value) {
    const lines = String(value ?? '').split(/\r\n?|\n/).map(line => line.trim()).filter(Boolean);
    return lines.some(isGeneratedFailureLine) && lines.every(line => isGeneratedFailureLine(line) || EMPTY.test(line));
}

// Read-only classification of records produced by older versions. Keep their
// bytes for recovery and replace only after a new response is confirmed saved.
export function isRejectedSummary(item) {
    if (!item || item.manualEdited || item.status === 'manual-edited' || item.startFloor !== undefined || item.endFloor !== undefined) return false;
    const placeholder = value => !String(value ?? '').trim() || EMPTY.test(String(value).trim()) || /^(?:未命名摘要|未明确|生成失败)$/.test(String(value).trim());
    if (!placeholder(item.title) || !placeholder(item.characters)) return false;
    const event = String(item.event ?? '').trim() || parseStructuredSummary(item.raw)?.event || String(item.raw ?? '').trim();
    return isFailureOnlyText(event);
}
