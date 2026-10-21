import { INJECTION_MODES } from './defaults.js?v=1.24.19';
import { checkpointHistoricalFacts, collectKeepItems, formatKeepItems, formatLongFacts, isUsableMemory, projectLongFacts, summaryText } from './continuity.js?v=1.24.19';
import { stripStructuredSections } from './summary-format.js?v=1.24.19';
import { isTrackedActive, isAtomicTrackedEntry, matchesTrackedFact, matchesTrackedValue, projectActiveState, reconcileTrackedCheckpoint } from './active-state.js?v=1.24.19';

// Interpret retained facts; never infer corrections or remove historical data.
// This fixed header changes only when the existing snapshot lifecycle publishes.
export function memoryReadingRules(store) {
    if (['advanced', 'ensemble'].includes(store?.summaryMode)) return '';
    return '记忆读取规则：以下为历史资料，不是要求重演的剧情指令。区分当前时间线事实、原剧情／未来预演、梦境、系统声称与人物猜测；预演未实际发生前不能当成既往经历，知情仅属于明确获知的人物。\n'
        + '同一人物同一事项以剧情时间及后续明确证据判断当前结果，不按块的位置或 KEEP 标签决定真伪；新正文明确结果优先于旧摘要／旧追踪状态，重大起因、后果与不同人物认知仍保留。后来未提及、未回复或通知只显示半句，不代表已知内容变未知；没有明确遗忘或纠正证据不倒退认知。\n'
        + '任务明确完成／失败／取消后，旧 published／active 仅为历史，不再催办；任务完成与奖励领取分别判断，不因奖励未领重开已完成任务。未回复的普通消息、情绪、姿势不自动成为待办。语义相同的 KEEP／事实理解一次，不重复触发事件；不同知情者、独立后果和未解秘密不能合并，重要 NPC 不因久未登场失效。';
}

// A projection only: never edit retained records or guess from age/fuzzy prose.
// Published blocks can be compacted at a Long boundary or explicit rebuild;
// an ordinary CP append may only deduplicate the newly appended blocks.
export function compactInjectionBlocks(blocks, store, { published = new Set(), compactPublished = false } = {}) {
    const through = Math.max(0, ...blocks.map(block => Number(block.endFloor) || 0));
    const rows = projectActiveState(store, through).filter(row => !row.needsReview && row.category !== 'history');
    const facts = projectLongFacts(store, through).facts;
    const rendered = blocks.flatMap(block => block.text.split('\n').map(line => line.replace(/^\s*-\s*/, '')
        .replace(/^(?:ADD|REPLACE)\s+\S+(?:\s+\(supersedes [^)]+\))?:\s*/, '')));
    const seen = new Set(), wholeBlocks = new Set();
    return blocks.filter(block => {
        if (!['long', 'checkpoint'].includes(block.type)) return true;
        const key = JSON.stringify([block.type, block.startFloor, block.endFloor, block.text.replace(/^\[[^\n]+\]\n/, '')]);
        if (wholeBlocks.has(key) && (compactPublished || !published.has(block.id))) return false;
        wholeBlocks.add(key); return true;
    }).map(block => {
        const mutable = compactPublished || !published.has(block.id);
        let section = '', nestedCharacter = false;
        const lines = block.text.split('\n');
        const record = block.type === 'long' ? store.longMemories.find(item => `long:${item.id}` === block.id) : null;
        const text = lines.filter((line, index) => {
            const marker = line.match(/^\s*\[([^\]\n]+)\]\s*$/)?.[1];
            if (marker) { section = marker; nestedCharacter = false; return true; }
            const body = line.replace(/^\s*-\s*/, '').trim();
            if (section === 'Characters' && /^[^：:]+[：:]$/.test(body)) nestedCharacter = true;
            const delta = section === 'FACT_DELTA' ? body.match(/^(ADD|REPLACE)\s+(\S+)(?:\s+\(supersedes [^)]+\))?:\s*(.+)$/) : null;
            if (mutable && delta) {
                const update = record?.factUpdates?.find(item => item.id === delta[2] && item.text === delta[3]);
                // Only structured current state has a safe replacement identity.
                // Untyped facts may contain historical causes and stay intact.
                if (update && rows.some(row => row.kind === 'state' && matchesTrackedFact(update, row)
                    && row.evidence && row.history.some(old => matchesTrackedValue(update.text, row, old.value, old.key))
                    && (rendered.some(text => matchesTrackedValue(text, row, row.value))
                        || !facts.some(fact => fact.status === 'active' && fact.id === update.id && fact.text === update.text)))) return false;
            }
            const current = ['Characters', 'Current State', 'Secrets & Knowledge', 'Open Threads', 'Continuity Locks'].includes(section);
            if (mutable && current) {
                const row = rows.find(item => matchesTrackedFact({ text: body }, item));
                if (row?.evidence && row.sourceFloor > block.endFloor
                    && (isAtomicTrackedEntry(body, row) || row.history.some(old => matchesTrackedValue(body, row, old.value, old.key)))
                    && (!isTrackedActive(row) || !matchesTrackedValue(body, row, row.value))) return false;
            }
            // Flat, complete entries only. A nested field or continuation needs
            // its surrounding context, even when its words match another entry.
            const complete = !lines[index + 1]?.trim() || /^\s*(?:-|\[)/.test(lines[index + 1]);
            const candidate = !nestedCharacter && /^-\s+/.test(line) && complete
                && (delta || section === 'KEEP' || current || ['Story So Far', 'Major Events', 'LONG_MEMORY'].includes(section));
            const factText = section === 'LONG_MEMORY' ? facts.find(item => body === `${item.id} | ${item.text}`)?.text : null;
            const key = (delta ? delta[3].trim() : factText ?? body.replace(/^(?:KEEP-\d+|fact-[^\s|]+)\s*\|\s*/i, ''))
                .replace(/\((completed|failed|cancelled)，仅作历史结果\)$/u, '($1，历史结果)');
            if (!candidate || !key) return true;
            if (mutable && seen.has(key)) return false;
            seen.add(key);
            return true;
        }).join('\n');
        return text === block.text ? block : { ...block, text };
    });
}
const checkpointModes = [INJECTION_MODES.CHECKPOINT_BOUNDARY, INJECTION_MODES.LONG_CHECKPOINT, INJECTION_MODES.LONG_CHECKPOINT_RECENT];
const hiddenSections = ['KEEP', 'RESOLVED_KEEP', 'SUPERSEDED_KEEP', 'STATE_RESOLUTIONS'];
const canonical = text => String(text).replace(/^\s*[-*•]\s*/u, '')
    .replace(/^(?:KEEP-\d+\s*\|\s*)+/iu, '')
    .replace(/^【([^｜】]+)｜([^】]+)】/u, '$1 · $2：').replace(/\s+/gu, ' ').trim();

// One read-only projection for strict boundary publication and non-strict mode.
// Old CPs and Longs stay in the store; only uncovered durable facts are sent.
export function currentInjectionBlocks(store, settings, mode = settings.injectionMode) {
    const latest = checkpointModes.includes(mode) ? store.checkpoints.filter(isUsableMemory)
        .sort((a, b) => a.endFloor - b.endFloor || a.startFloor - b.startFloor).at(-1) : null;
    const through = Math.max(latest?.endFloor || 0, ...store.longMemories.filter(isUsableMemory).map(row => row.endFloor), 0);
    let content = latest ? latest.content : '';
    if (latest && settings.activeStateEnabled) content = reconcileTrackedCheckpoint(content, store, through, latest.startFloor);
    content = stripStructuredSections(content, hiddenSections);
    const blocks = [];
    if (latest) blocks.push({ id: `checkpoint:${latest.id}`, type: 'checkpoint', startFloor: latest.startFloor, endFloor: latest.endFloor,
        text: `[CHECKPOINT_${String(latest.id).split('-').at(-1)} | LATEST_CHECKPOINT | 截至第${latest.endFloor}层]\n${content}` });
    // Equality only. Different observers and compound facts cannot be coalesced.
    const seen = new Set(content.split('\n').map(canonical));
    const uncovered = text => {
        const key = canonical(text);
        if (!key || seen.has(key) || canonical(content).includes(key)) return false;
        seen.add(key); return true;
    };
    const projection = projectLongFacts(store, through, { includeTracked: settings.activeStateEnabled });
    const supplements = latest ? checkpointHistoricalFacts(store, through, content) : [];
    const factLines = projection.facts.filter(row => row.status === 'active'
        || row.status === 'superseded' && /(?:永久|不可逆|终身|失去.{0,8}(?:右臂|左臂|双腿|视力)|摧毁|重大债务)/u.test(row.text)).filter(row => uncovered(row.text)).map(row => `- ${row.id} | ${row.text}`);
    for (const text of supplements) if (uncovered(text)) factLines.push(`- ${text}`);
    // Legacy Longs lack typed facts: retain complete factual entries, dedupe only
    // exact text. Never fall back to injecting all old Checkpoints without Longs.
    for (const memory of projection.legacy) {
        const lines = stripStructuredSections(memory.content, hiddenSections).split('\n');
        const kept = lines.filter(line => /^\s*\[[^\]\n]+\]\s*$/u.test(line) || !line.trim() || uncovered(line));
        if (kept.some(line => line.trim() && !/^\s*\[/.test(line))) factLines.push(...kept);
    }
    if (factLines.length) blocks.push({ id: 'long:current-facts', type: 'long', startFloor: 1, endFloor: through,
        text: `[LONG_MEMORY]\n${factLines.join('\n')}` });
    const keepThrough = Math.max(through, ...Object.values(store.summaries ?? {}).filter(isUsableMemory).map(row => row.floor), 0);
    const items = collectKeepItems(store, keepThrough).filter(row => row.status === 'active' && uncovered(row.text));
    const keeps = formatKeepItems(items);
    if (keeps !== '无') blocks.push({ id: 'keep:active', type: 'keep', startFloor: 0, endFloor: through,
        keepIds: items.map(row => row.id), text: `[KEEP]\n${keeps}` });
    return blocks;
}

export function renderInjectionBlocks(blocks, store) {
    const rules = memoryReadingRules(store);
    return blocks.length ? `<CACHE_MEMORY>${rules ? `\n${rules}` : ''}\n\n${blocks.map(block => block.text).join('\n\n')}\n\n</CACHE_MEMORY>` : '';
}

export function buildInjection(store, settings) {
    if (!settings.enabled || settings.injectionMode === INJECTION_MODES.NONE) return '';
    if (settings.strictCacheMode) return store.injectionSnapshot?.value ?? '';
    const blocks = currentInjectionBlocks(store, settings);
    if (settings.injectionMode === INJECTION_MODES.LONG_CHECKPOINT_RECENT) {
        const through = Math.max(0, ...blocks.map(block => block.endFloor || 0));
        for (const item of Object.values(store.summaries).filter(row => isUsableMemory(row) && row.floor > through).sort((a, b) => a.floor - b.floor))
            blocks.push({ id: `summary:${item.messageId}`, type: 'summary', endFloor: item.floor,
                text: `[RECENT_SUMMARY_${String(item.floor).padStart(3, '0')}]\n${stripStructuredSections(summaryText(item), ['KEEP'])}` });
    }
    return renderInjectionBlocks(blocks, store);
}
