import { parseStructuredSummary } from './summary-format.js?v=1.24.3';
import { readSection } from './continuity.js?v=1.24.3';

// Only generated responses pass through here. Stored history and source prose stay intact.
const REFUSAL = /^(?:(?:i(?:['’]m| am)\s+sorry|sorry)[,.!]?\s*(?:but\s+)?|as an? (?:ai|large language) model[, ]+)?(?:i|we)\s+(?:cannot|can['’]t|am unable to|are unable to|won['’]t|will not)\s+(?:assist|help|fulfil[l]?|comply|provide|generate|create|process|continue|engage)\b/i;
const REFUSAL_TARGET = /(?:(?:this|that|your|the) (?:request|prompt)|requested (?:content|text)|content you(?:['’]re| are) (?:asking|requesting)|(?:sexual|explicit|pornographic|violent|illegal|disallowed|unsafe) content|(?:content|safety) polic(?:y|ies)|as an? (?:ai|large language) model)/i;
const isRefusal = text => REFUSAL.test(text) && (REFUSAL_TARGET.test(text) || /\b(?:assist|help|comply|engage)\s+(?:you\s+)?(?:with\s+)?(?:that|this)[.!]?\s*$/i.test(text));
const RESPONSE_ERROR = /^(?:(?:api |upstream |generation |request )error\s*[:：]|(?:request|generation) failed\s*[:：]|HTTP\s+(?:401|403|429|5\d\d)\b|\{\s*"error"\s*:|(?:this (?:request|prompt|content)|your (?:request|prompt)) (?:violates|is (?:not allowed|blocked))\b|please (?:try (?:again|a different prompt)|rephrase your (?:request|prompt))\b)/i;
const EMPTY = /^(?:无|无新增|无更新|无退休|none|null|n\/a|\[\])[。.!]?$/i;
const hasMemoryValue = value => String(value).split('\n').some(line => {
    const text = line.trim().replace(/^(?:[-*•]|\d+[.)、])\s+/, '');
    return text && !/^```/.test(text) && !EMPTY.test(text);
});
const CHECKPOINT_FIELDS = ['Story So Far', 'Characters', 'Current State', 'Secrets & Knowledge', 'Open Threads', 'Continuity Locks', 'Events', 'Important Facts'];

export function cleanGeneratedResponse(value, source = '') {
    let text = String(value ?? '').trim();
    // Quoted/source text is preserved; unquoted reasoning markup is not plot.
    let section = '';
    const output = [];
    const lines = text.split(/\r\n|\r|\n/);
    let reasoning = false;
    for (let line of lines) {
        if (reasoning) {
            const closing = line.match(/<\/(?:think|thinking|analysis)\s*>/i);
            if (!closing) continue;
            line = line.slice(closing.index + closing[0].length);
            reasoning = false;
        }
        const marker = line.match(/^\s*\[([^\]\n]+)\]\s*$/)?.[1];
        if (marker) section = marker.toLowerCase();
        const protectedLine = /^\s*[“「『"'>]/.test(line) || line.trim() && String(source).includes(line.trim());
        if (!protectedLine) {
            if (section !== 'changes') {
                let opening;
                while ((opening = line.match(/<(think|thinking|analysis)(?:\s[^>]*)?>/i))) {
                    const before = line.slice(0, opening.index);
                    const after = line.slice(opening.index + opening[0].length);
                    const closing = after.match(new RegExp(`<\\/${opening[1]}\\s*>`, 'i'));
                    const literal = closing ? opening[0] + after.slice(0, closing.index + closing[0].length) : '';
                    if (literal && String(source).includes(literal)) break;
                    if (!closing) { output.push(before); reasoning = true; break; }
                    line = before + after.slice(closing.index + closing[0].length);
                }
            }
            if (reasoning) continue;
            const detail = line.trim().replace(/^[-*•]\s+/, '');
            if (isRefusal(detail) || RESPONSE_ERROR.test(detail)) continue;
        }
        output.push(line);
    }
    text = output.join('\n').trim();
    // Strip only an enclosing Markdown fence, preserving the complete structured payload.
    return text.replace(/^```(?:text|markdown|md|json)?\s*\n([\s\S]*?)\n```\s*$/i, '$1').trim();
}

export function prepareMemoryResponse(value, kind, { source = '', prompt = '' } = {}) {
    const text = cleanGeneratedResponse(value, source);
    const fail = () => { throw Object.assign(new Error(`${kind} 响应缺少有效剧情字段，原记忆保留`), { code: 'INVALID_MEMORY_RESPONSE' }); };
    if (!text) throw Object.assign(new Error(`${kind} 输出为空或仅含拒绝/思考内容，原记忆保留`), { code: 'INVALID_MEMORY_RESPONSE' });
    if (kind === 'Summary') {
        const parsed = parseStructuredSummary(text);
        if (parsed) {
            if (!hasMemoryValue(parsed.event)) return fail();
            return parsed.raw;
        }
        const event = text.match(/<event>\s*([\s\S]*?)\s*<\/event>/i)?.[1];
        if (event !== undefined) { if (!hasMemoryValue(event)) return fail(); return text; }
        if (/\[SUMMARY\]|\[Event\]|<event>/i.test(text) || /\[SUMMARY\]|<event>/i.test(prompt)) return fail();
    } else if (kind === 'Checkpoint') {
        const fields = CHECKPOINT_FIELDS.map(name => readSection(text, name));
        if (fields.some(hasMemoryValue)) return text;
        if (/\[CHECKPOINT\]|\[Current State\]|\[Characters\]|\[Events\]/i.test(text + '\n' + prompt)) return fail();
    } else {
        const fields = ['LONG_MEMORY', 'UPDATED_FACTS', 'RETIRED_FACTS'];
        if (fields.some(name => new RegExp(`^\\s*\\[${name}\\]\\s*$`, 'im').test(text))) {
            // All three sections may legitimately say "无" when no new fact is established.
            if (!fields.some(name => readSection(text, name).trim())) return fail();
            return text;
        }
        if (/\[(?:LONG_MEMORY|UPDATED_FACTS|RETIRED_FACTS)\]/i.test(prompt)) return fail();
    }
    // Existing custom and legacy plain-text prompts remain supported.
    return text;
}
