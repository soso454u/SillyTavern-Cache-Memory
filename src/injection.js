import { INJECTION_MODES } from './defaults.js?v=1.24.14';
import { collectKeepItems, formatKeepItems, formatLongFacts, isUsableMemory, projectLongFacts, summaryText } from './continuity.js?v=1.24.14';
import { stripStructuredSections } from './summary-format.js?v=1.24.14';
import { isTrackedActive, isAtomicTrackedEntry, matchesTrackedFact, matchesTrackedValue, projectActiveState, reconcileTrackedCheckpoint } from './active-state.js?v=1.24.14';

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
function fullInjection(blocks, store) {
    if (store) {
        const through = Math.max(0, ...Object.values(store.summaries).map(item => item.floor),
            ...store.checkpoints.map(item => item.endFloor), ...store.longMemories.map(item => item.endFloor));
        blocks = compactInjectionBlocks(blocks.map((text, id) => {
            const record = [...store.longMemories, ...store.checkpoints].find(item => text.startsWith(`[${String(item.id).toUpperCase().replaceAll('-', '_')}]`)
                || text.startsWith(`[LATEST_CHECKPOINT | 截至第${item.endFloor}层]`));
            return { id, text, startFloor: record?.startFloor, endFloor: record?.endFloor ?? through,
                type: record ? store.longMemories.includes(record) ? 'long' : 'checkpoint' : undefined };
        }), store, { compactPublished: true }).map(block => block.text);
    }
    const rules = memoryReadingRules(store);
    return blocks.length ? `<CACHE_MEMORY>${rules ? `\n${rules}` : ''}\n\n${blocks.join('\n\n')}\n\n</CACHE_MEMORY>` : '';
}

function byRange(a, b) {
    return Number(a.startFloor ?? a.floor) - Number(b.startFloor ?? b.floor);
}

export function buildInjection(store, settings) {
    if (!settings.enabled || settings.injectionMode === INJECTION_MODES.NONE) return '';
    if (settings.strictCacheMode) return store.injectionSnapshot?.value ?? '';
    const states = store.checkpoints.filter(item => isUsableMemory(item) && item.memoryKind === 'state').sort(byRange);
    const latest = states.at(-1);
    if (settings.memoryStrategy !== 'legacy' && (store.version >= 2 || latest || store.longMemories.some(item => item.memoryKind === 'facts'))) {
        const blocks = [];
        const legacyLatest = store.checkpoints.filter(isUsableMemory).sort(byRange).at(-1);
        const stateEnd = Math.max(0, latest?.endFloor ?? legacyLatest?.endFloor ?? 0, ...store.longMemories.filter(isUsableMemory).map(item => item.endFloor));
        const facts = formatLongFacts(projectLongFacts(store, Infinity, { includeTracked: settings.activeStateEnabled }));
        if (facts !== '无') blocks.push(`[LONG_MEMORY]\n${facts}`);
        const keeps = formatKeepItems(collectKeepItems(store));
        if (keeps !== '无') blocks.push(`[KEEP]\n${keeps}`);
        if ([INJECTION_MODES.CHECKPOINT_BOUNDARY, INJECTION_MODES.LONG_CHECKPOINT, INJECTION_MODES.LONG_CHECKPOINT_RECENT].includes(settings.injectionMode)) {
            const longs = store.longMemories.filter(isUsableMemory);
            const checkpoints = store.checkpoints.filter(item => isUsableMemory(item)
                && !longs.some(long => long.startFloor <= item.startFloor && long.endFloor >= item.endFloor)).sort(byRange);
            for (const item of checkpoints) {
                let state = item.content;
                if (settings.activeStateEnabled && item.memoryKind === 'state') state = reconcileTrackedCheckpoint(state, store, item.endFloor, item.startFloor);
                const label = item === checkpoints.at(-1) ? `LATEST_CHECKPOINT | 截至第${item.endFloor}层` : String(item.id).toUpperCase().replaceAll('-', '_');
                blocks.push(`[${label}]\n${stripStructuredSections(state, ['KEEP', 'RESOLVED_KEEP', 'SUPERSEDED_KEEP'])}`);
            }
        }
        if (settings.injectionMode === INJECTION_MODES.LONG_CHECKPOINT_RECENT) {
            // Include every summary after the latest checkpoint; count limits must not create a gap.
            const summaries = Object.values(store.summaries).filter(item => isUsableMemory(item) && item.floor > stateEnd)
                .sort((a, b) => a.floor - b.floor);
            for (const item of summaries) blocks.push(`[RECENT_SUMMARY_${String(item.floor).padStart(3, '0')}]\n${stripStructuredSections(summaryText(item), ['KEEP'])}`);
        }
        return fullInjection(blocks, store);
    }
    const blocks = [];
    const longs = [...store.longMemories]
        .filter(isUsableMemory)
        .sort(byRange);
    for (const item of longs) blocks.push(`[${String(item.id).toUpperCase().replaceAll('-', '_')}]\n${item.content}`);

    if ([INJECTION_MODES.CHECKPOINT_BOUNDARY, INJECTION_MODES.LONG_CHECKPOINT, INJECTION_MODES.LONG_CHECKPOINT_RECENT].includes(settings.injectionMode)) {
        const checkpoints = [...store.checkpoints]
            .filter(item => isUsableMemory(item) && !longs.some(long => long.startFloor <= item.startFloor && long.endFloor >= item.endFloor))
            .sort(byRange);
        for (const item of checkpoints) blocks.push(`[${String(item.id).toUpperCase().replaceAll('-', '_')}]\n${item.content}`);
    }

    if (settings.injectionMode === INJECTION_MODES.LONG_CHECKPOINT_RECENT) {
        const coveredThrough = Math.max(0, ...store.checkpoints.filter(item => isUsableMemory(item)).map(item => item.endFloor), ...longs.map(item => item.endFloor));
        const summaries = Object.values(store.summaries)
            .filter(item => item.floor > coveredThrough && isUsableMemory(item))
            .sort((a, b) => a.floor - b.floor)
            .slice(-settings.recentSummaryCount);
        for (const item of summaries) {
            blocks.push(`[RECENT_SUMMARY_${String(item.floor).padStart(3, '0')}]\n${item.title}\n人物：${item.characters}\n事件：${item.event}`);
        }
    }

    return fullInjection(blocks, store);
}
