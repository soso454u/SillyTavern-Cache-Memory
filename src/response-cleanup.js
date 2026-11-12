import { parseStructuredSummary, stripStructuredSections, SUMMARY_SECTION_NAMES } from './summary-format.js?v=1.27.16';
import { readSection } from './continuity.js?v=1.27.31';

// Only generated responses pass through here. Stored history and source prose stay intact.
const REFUSAL = /^(?:(?:i(?:['’]m| am)\s+sorry|sorry)[,.!]?\s*(?:but\s+)?|as an? (?:ai|large language) model[, ]+)?(?:i|we)\s+(?:cannot|can['’]t|am unable to|are unable to|won['’]t|will not)\s+(?:assist|help|fulfil[l]?|comply|provide|generate|create|process|continue|engage)\b/i;
const REFUSAL_TARGET = /(?:(?:this|that|your|the) (?:request|prompt)|requested (?:content|text)|content you(?:['’]re| are) (?:asking|requesting)|(?:sexual|explicit|pornographic|violent|illegal|disallowed|unsafe) content|(?:content|safety) polic(?:y|ies)|as an? (?:ai|large language) model)/i;
const isRefusal = text => REFUSAL.test(text) && (REFUSAL_TARGET.test(text) || /\b(?:assist|help|comply|engage)\s+(?:you\s+)?(?:with\s+)?(?:that|this)[.!]?\s*$/i.test(text));
const CHINESE_REFUSAL = /^(?:(?:很抱歉|抱歉|对不起)[，,。！!：:]\s*)?(?:我|作为(?:一个)?(?:人工智能|AI)(?:助手|模型)?[，,]\s*我?)?(?:无法|不能|不便)(?:协助|处理|满足|完成|继续|提供|生成|总结|回应|执行)[^。！？\n]*(?:(?:这个|该|此|您的|你的)请求|(?:上述|所请求的|这类|此类)内容|相关政策|内容政策|安全政策)/i;
const RESPONSE_ERROR = /^(?:(?:api |upstream |generation |request )error\s*[:：]|(?:request|generation) failed\s*[:：]|HTTP\s+(?:401|403|429|5\d\d)\b|\{\s*"error"\s*:|(?:this (?:request|prompt|content)|your (?:request|prompt)) (?:violates|is (?:not allowed|blocked))\b|please (?:try (?:again|a different prompt)|rephrase your (?:request|prompt))\b)/i;
const EMPTY = /^(?:无|无新增|无更新|无退休|none|null|n\/a|\[\])[。.!]?$/i;
const EMPTY_SUMMARY = /^(?:暂无|未知|不详|未提供|无剧情|无事件|无有效剧情|无可总结内容|[-—–]+)[。.!]?$/;
const hasMemoryValue = (value, summary = false) => String(value).split('\n').some(line => {
    let text = line.trim().replace(/^(?:[-*•]|\d+[.)、])\s+/, '');
    if (summary) text = text.replace(/^(\*\*|__)(.+)\1$/, '$2').trim();
    return text && !/^```/.test(text) && !EMPTY.test(text) && !(summary && EMPTY_SUMMARY.test(text));
});
const CHECKPOINT_FIELDS = ['Stage Story', 'Story So Far', 'Characters', 'Current State', 'Secrets & Knowledge', 'Open Threads', 'Continuity Locks', 'Events', 'Important Facts'];
const MEMORY_MARKERS = new Map([...SUMMARY_SECTION_NAMES, 'Changes', 'SUMMARY', 'CHECKPOINT', ...CHECKPOINT_FIELDS,
    'RESOLVED_KEEP', 'SUPERSEDED_KEEP', 'STORY_ARC', 'LONG_MEMORY', 'UPDATED_FACTS', 'RETIRED_FACTS', 'STATE_RESOLUTIONS']
    .map(name => [name.toLowerCase(), name]));
const SUMMARY_MARKERS = new Map([...SUMMARY_SECTION_NAMES, 'Changes', 'SUMMARY'].map(name => [name.toLowerCase(), name]));
for (const [name, aliases] of Object.entries({ SUMMARY: ['小总结', '楼层摘要'], Title: ['标题'], Characters: ['人物', '主要人物'],
    StoryTime: ['story time', '剧情时间', '剧情日期/时间', '时间'], Location: ['地点'], Event: ['events', '剧情', '事件', '剧情梗概', '剧情摘要', '关键事件'],
    State: ['状态'], Open: ['未解决事项'], Quote: ['原话'], KEEP: ['不可丢失事项'], Changes: ['状态增量'] })) {
    for (const alias of aliases) SUMMARY_MARKERS.set(alias, name);
}

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
            if (isRefusal(detail) || CHINESE_REFUSAL.test(detail) || RESPONSE_ERROR.test(detail)) continue;
        }
        output.push(line);
    }
    text = output.join('\n').trim();
    // Strip only an enclosing Markdown fence, preserving the complete structured payload.
    return text.replace(/^```(?:text|markdown|md|json)?\s*\n([\s\S]*?)\n```\s*$/i, '$1').trim();
}

// Tolerate presentation-only deviations in known labels, not arbitrary prose.
function normalizeMemoryMarkers(text, summaryAliases = false) {
    return text.split(/\r\n?|\n/).map(line => {
        const heading = line.match(/^\s*#{1,6}\s+/);
        const trimmed = line.slice(heading?.[0].length ?? 0).trim();
        const bold = trimmed.match(/^(\*\*|__)(.+?)\1[ \t]*(.*)$/);
        const label = bold ? bold[2] : trimmed;
        const tail = bold?.[3] ?? '';
        const bracket = label.match(/^[\[【［]([^\]】］]+)[\]】］]\s*[:：]?\s*(.*)$/);
        const colon = summaryAliases && !bracket && label.match(/^([^:：]+)[:：]\s*(.*)$/);
        const key = (bracket?.[1] ?? colon?.[1] ?? ((heading || bold) && summaryAliases ? label : '')).trim().toLowerCase();
        const name = (summaryAliases && SUMMARY_MARKERS.get(key)) || (bracket && MEMORY_MARKERS.get(key));
        if (!name) return line;
        const body = [bracket?.[2] ?? colon?.[2], tail.replace(/^[:：]\s*/, '')].filter(Boolean).join(' ');
        return `[${name}]${body ? '\n' + body : ''}`;
    }).join('\n');
}

export function summaryRetryInstruction(prompt) {
    if (/\[(?:SUMMARY|Event)\]/i.test(prompt)) {
        return '\n\n【小总结输出格式重试】沿用上述模板和本轮来源。用单独一行写 [SUMMARY]，并用单独一行写 [Event]，下一行直接写有内容的剧情梗概。其余字段仍按原模板输出；[Changes]（如需）放在剧情栏之后。不要用翻译后的标题代替标记，也不要只填“无”或输出分析过程。';
    }
    return /<event>/i.test(prompt)
        ? '\n\n【小总结输出格式重试】沿用上述模板和本轮来源，把有内容的剧情梗概放在 <event> 与 </event> 之间，再完成其余已配置字段。'
        : '';
}

export function prepareMemoryResponse(value, kind, { source = '', prompt = '' } = {}) {
    const summary = kind === 'Summary';
    const raw = String(value ?? '');
    let text = cleanGeneratedResponse(normalizeMemoryMarkers(raw), source);
    if (summary && /\[(?:SUMMARY|Event)\]/i.test(prompt) && !/^\s*\[Event\]\s*$/im.test(text) && !/<event>/i.test(text)) {
        text = cleanGeneratedResponse(normalizeMemoryMarkers(raw, true), source);
    }
    const fail = () => { throw Object.assign(new Error(`${kind} 响应缺少有效剧情字段，原记忆保留`), { code: 'INVALID_MEMORY_RESPONSE' }); };
    if (!text) throw Object.assign(new Error(`${kind} 输出为空或仅含拒绝/思考内容，原记忆保留`), { code: 'INVALID_MEMORY_RESPONSE' });
    if (summary) {
        const failSummary = detail => {
            throw Object.assign(new Error(`模型返回的小总结${detail}，原记忆保留`), { code: 'INVALID_MEMORY_RESPONSE' });
        };
        if (!/^\s*\[SUMMARY\]\s*$/im.test(text) && /^\s*\[Event\]\s*$/im.test(text)) text = '[SUMMARY]\n' + text;
        const parsed = parseStructuredSummary(text);
        if (parsed) {
            // A stray auxiliary section after an empty Event does not supply plot.
            const plot = parsed.event.split(/^\s*\[(?:STATE_RESOLUTIONS|CURRENT_TRACKED_STATE|LONG_MEMORY|UPDATED_FACTS|RETIRED_FACTS)\]\s*$/im, 1)[0];
            if (!hasMemoryValue(plot, true)) return failSummary('的 [Event] 剧情栏为空或只有占位词');
            return parsed.raw;
        }
        const event = text.match(/<event>\s*([\s\S]*?)\s*<\/event>/i)?.[1];
        if (event !== undefined) { if (!hasMemoryValue(event, true)) return failSummary('的 <event> 剧情栏为空或只有占位词'); return text; }
        if (/\[(?:SUMMARY|Event)\]|<event>/i.test(text + '\n' + prompt)) return failSummary('缺少可识别的剧情栏');
        if (!hasMemoryValue(stripStructuredSections(text, ['Changes']), true)) return failSummary('没有可用剧情');
    } else if (kind === 'Checkpoint') {
        const fields = CHECKPOINT_FIELDS.map(name => readSection(text, name));
        if (fields.some(field => hasMemoryValue(field))) return text;
        if (/\[CHECKPOINT\]|\[Current State\]|\[Characters\]|\[Events\]/i.test(text + '\n' + prompt)) return fail();
    } else {
        const story = readSection(text, 'STORY_ARC');
        if (hasMemoryValue(story)) return text;
        if (/\[STORY_ARC\]/i.test(prompt)) throw Object.assign(new Error('Long Memory 响应缺少 STORY_ARC 剧情大总结，原记忆保留'), { code: 'INVALID_MEMORY_RESPONSE' });
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
