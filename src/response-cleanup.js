import { buildStructuredSummary, parseStructuredSummary, stripStructuredSections, SUMMARY_SECTION_NAMES } from './summary-format.js?v=1.27.38';
import { readSection } from './continuity.js?v=1.27.38';
import { isGeneratedFailureLine } from './response-quality.js?v=1.27.38';

// Only generated responses pass through here. Stored history and source prose stay intact.
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
    StoryTime: ['story time', '剧情时间', '剧情日期/时间', '时间'], Location: ['地点'], Event: ['events', '剧情', '事件', '剧情梗概', '剧情摘要', '关键事件', '正文', '摘要正文', '总结正文', '事件经过'],
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
            if (isGeneratedFailureLine(line)) continue;
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

// A missing label is not a missing story. Only recover prose outside metadata
// sections; titles, state deltas and JSON payloads alone cannot supply an Event.
function recoverSummaryProse(text, source) {
    const blocks = text.split(/^\s*\[SUMMARY\]\s*$/im);
    const block = blocks.at(-1).trim();
    const prose = cleanGeneratedResponse(block.split(/^\s*\[[^\]\n]+\]\s*$/m, 1)[0]
        .replace(/^\s*<(?:summary|content)>\s*/i, '').replace(/\s*<\/(?:summary|content)>\s*$/i, ''), source);
    const meaningful = prose.split('\n').filter(line => line.trim() && !/^\s*(?:#{1,6}\s|```)/.test(line));
    if (!meaningful.some(line => hasMemoryValue(line, true) && /[\p{L}\p{N}]/u.test(line)
        && !/^\s*[\[\]{}<>]/.test(line))) return '';
    // Data objects without a recognised story property must not become prose.
    if (/^[\[{]/.test(prose)) return '';
    return prose;
}

function summaryFields(text, event) {
    const fields = Object.fromEntries(SUMMARY_SECTION_NAMES.map(name => [name === 'StoryTime' ? 'storyTime' : name.toLowerCase(), readSection(text, name)]));
    fields.event = event;
    const changes = readSection(text, 'Changes');
    return buildStructuredSummary(fields) + (changes ? '\n[Changes]\n' + changes : '');
}

function summaryFromJSON(text) {
    if (!text.startsWith('{')) return text;
    let data;
    try { data = JSON.parse(text); } catch { return text; }
    if (!data || Array.isArray(data)) return text;
    const fields = {};
    for (const [key, value] of Object.entries(data)) {
        const name = SUMMARY_MARKERS.get(key.toLowerCase());
        if (!name) continue;
        if (name === 'Changes' && Array.isArray(value)) fields.changes = JSON.stringify(value);
        else if (typeof value === 'string') fields[name === 'SUMMARY' ? 'event' : name === 'StoryTime' ? 'storyTime' : name.toLowerCase()] = value;
    }
    if (!fields.event) return text;
    return buildStructuredSummary(fields) + (fields.changes ? '\n[Changes]\n' + fields.changes : '');
}

export function prepareMemoryResponse(value, kind, { source = '', prompt = '' } = {}) {
    const summary = kind === 'Summary';
    const raw = String(value ?? '');
    let text = cleanGeneratedResponse(normalizeMemoryMarkers(raw), source);
    if (summary && /\[(?:SUMMARY|Event)\]/i.test(prompt) && !/^\s*\[Event\]\s*$/im.test(text) && !/<event>/i.test(text)) {
        text = cleanGeneratedResponse(normalizeMemoryMarkers(raw, true), source);
    }
    if (summary) text = cleanGeneratedResponse(summaryFromJSON(text), source);
    const fail = () => { throw Object.assign(new Error(`${kind} 响应缺少有效剧情字段，原记忆保留`), { code: 'INVALID_MEMORY_RESPONSE' }); };
    if (!text) throw Object.assign(new Error(`${kind} 输出为空或仅含拒绝/思考内容，原记忆保留`), { code: 'INVALID_MEMORY_RESPONSE' });
    if (summary) {
        const failSummary = detail => {
            const rejected = normalizeMemoryMarkers(raw, true).split('\n').some(isGeneratedFailureLine);
            throw Object.assign(new Error(rejected ? '模型接口返回拒答或检索失败，未写入剧情，原记忆保留'
                : `模型返回的小总结${detail}，原记忆保留`), { code: 'INVALID_MEMORY_RESPONSE' });
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
        if (event !== undefined) {
            const plot = cleanGeneratedResponse(event, source);
            if (!hasMemoryValue(plot, true)) return failSummary('的 <event> 剧情栏为空或只有占位词');
            return text.replace(/(<event>)\s*[\s\S]*?\s*(<\/event>)/i, (_, open, close) => open + plot + close);
        }
        if (/\[(?:SUMMARY|Event)\]|<event>/i.test(text + '\n' + prompt)) {
            const prose = recoverSummaryProse(text, source);
            if (prose && !/\[Event\]|<event>/i.test(text)) return summaryFields(text, prose);
            return failSummary('没有可用的剧情正文');
        }
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
