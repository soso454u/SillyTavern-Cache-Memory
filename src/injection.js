import { INJECTION_MODES } from './defaults.js?v=1.24.6';
import { collectKeepItems, formatKeepItems, formatLongFacts, isUsableMemory, previousState, projectLongFacts, sourceFallbackSummaries, summaryText } from './continuity.js?v=1.24.6';
import { stripStructuredSections } from './summary-format.js?v=1.24.6';
import { isTrackedActive, matchesTrackedFact, projectActiveState, reconcileTrackedCheckpoint } from './active-state.js?v=1.24.6';

// A projection only: never edit retained records or guess from age/fuzzy prose.
// Published blocks can be compacted at a Long boundary or explicit rebuild;
// an ordinary CP append may only deduplicate the newly appended blocks.
export function compactInjectionBlocks(blocks, store, { published = new Set(), compactPublished = false } = {}) {
    const through = Math.max(0, ...blocks.map(block => Number(block.endFloor) || 0));
    const rows = projectActiveState(store, through).filter(row => !row.needsReview && row.category !== 'history');
    const facts = projectLongFacts(store, through).facts;
    const seen = new Set();
    return blocks.map(block => {
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
                    && row.history.some(old => /^(?:Lv\.?\s*\d+|\d+(?:\.\d+)?(?:点|级|枚|个|金币|银币|%|％)?)$/i.test(old.value)
                        && [`${row.entity} · ${old.key || row.key}：${old.value}`, `【${row.entity}｜${old.key || row.key}】${old.value}`].includes(update.text)))
                    && !facts.some(fact => fact.status === 'active' && fact.id === update.id && fact.text === update.text)) return false;
            }
            const current = ['Characters', 'Current State', 'Secrets & Knowledge', 'Open Threads', 'Continuity Locks'].includes(section);
            if (mutable && current) {
                const row = rows.find(item => matchesTrackedFact({ text: body }, item));
                if (row && row.sourceFloor > block.endFloor && (!isTrackedActive(row)
                    || row.history.some(old => old.value && body.includes(old.value)) && !body.includes(row.value))) return false;
            }
            // Flat, complete entries only. A nested field or continuation needs
            // its surrounding context, even when its words match another entry.
            const complete = !lines[index + 1]?.trim() || /^\s*(?:-|\[)/.test(lines[index + 1]);
            const candidate = !nestedCharacter && /^-\s+/.test(line) && complete
                && (delta || section === 'KEEP' || current || ['Story So Far', 'Major Events', 'LONG_MEMORY'].includes(section));
            const key = delta ? delta[3].trim() : body.replace(/^(?:KEEP-\d+|fact-[^\s|]+)\s*\|\s*/i, '');
            if (!candidate || key.length < 12) return true;
            if (mutable && seen.has(key)) return false;
            seen.add(key);
            return true;
        }).join('\n');
        return text === block.text ? block : { ...block, text };
    });
}
function fullInjection(blocks, store, settings) {
    if (store) {
        const fallback = [INJECTION_MODES.CHECKPOINT_BOUNDARY, INJECTION_MODES.LONG_CHECKPOINT, INJECTION_MODES.LONG_CHECKPOINT_RECENT].includes(settings.injectionMode) ? sourceFallbackSummaries(store) : [];
        blocks = [...blocks, ...fallback.map(item => `[RECENT_SUMMARY_${String(item.floor).padStart(3, '0')}]\n${stripStructuredSections(summaryText(item), ['KEEP'])}`)];
        const through = Math.max(0, ...fallback.map(item => item.floor), ...store.checkpoints.map(item => item.endFloor), ...store.longMemories.map(item => item.endFloor));
        blocks = compactInjectionBlocks(blocks.map((text, id) => ({ id, text, endFloor: through })), store, { compactPublished: true }).map(block => block.text);
    }
    return blocks.length ? `<CACHE_MEMORY>\n\n${blocks.join('\n\n')}\n\n</CACHE_MEMORY>` : '';
}

function byRange(a, b) {
    return Number(a.startFloor ?? a.floor) - Number(b.startFloor ?? b.floor);
}

export function buildInjection(store, settings) {
    if (!settings.enabled || settings.injectionMode === INJECTION_MODES.NONE) return '';
    if (settings.strictCacheMode) return store.injectionSnapshot?.value ?? '';
    const fallbackIds = new Set(sourceFallbackSummaries(store).map(item => item.messageId));
    const states = store.checkpoints.filter(item => isUsableMemory(item) && item.memoryKind === 'state').sort(byRange);
    const latest = states.at(-1);
    if (settings.memoryStrategy !== 'legacy' && (store.version >= 2 || latest || store.longMemories.some(item => item.memoryKind === 'facts'))) {
        const blocks = [];
        const legacyLatest = store.checkpoints.filter(isUsableMemory).sort(byRange).at(-1);
        const stateEnd = latest?.endFloor ?? legacyLatest?.endFloor ?? 0;
        const facts = formatLongFacts(projectLongFacts(store, Infinity, { includeTracked: settings.activeStateEnabled }));
        if (facts !== '无') blocks.push(`[LONG_MEMORY]\n${facts}`);
        const keeps = formatKeepItems(collectKeepItems(store));
        if (keeps !== '无') blocks.push(`[KEEP]\n${keeps}`);
        if ([INJECTION_MODES.CHECKPOINT_BOUNDARY, INJECTION_MODES.LONG_CHECKPOINT, INJECTION_MODES.LONG_CHECKPOINT_RECENT].includes(settings.injectionMode) && stateEnd) {
            let state = latest?.content ?? previousState({ ...store, summaryRepairRanges: [] }, stateEnd + 1).content;
            if (settings.activeStateEnabled) state = reconcileTrackedCheckpoint(state, store, stateEnd, latest?.startFloor ?? 1);
            blocks.push(`[LATEST_CHECKPOINT | 截至第${stateEnd}层]\n${stripStructuredSections(state, ['KEEP', 'RESOLVED_KEEP', 'SUPERSEDED_KEEP'])}`);
        }
        if (settings.injectionMode === INJECTION_MODES.LONG_CHECKPOINT_RECENT) {
            // Include every summary after the latest checkpoint; count limits must not create a gap.
            const summaries = Object.values(store.summaries).filter(item => isUsableMemory(item) && !fallbackIds.has(item.messageId) && item.floor > stateEnd)
                .sort((a, b) => a.floor - b.floor);
            for (const item of summaries) blocks.push(`[RECENT_SUMMARY_${String(item.floor).padStart(3, '0')}]\n${stripStructuredSections(summaryText(item), ['KEEP'])}`);
        }
        return fullInjection(blocks, store, settings);
    }
    const blocks = [];
    const longs = [...store.longMemories]
        .filter(isUsableMemory)
        .sort(byRange);
    for (const item of longs) blocks.push(`[${String(item.id).toUpperCase().replaceAll('-', '_')}]\n${item.content}`);

    if ([INJECTION_MODES.CHECKPOINT_BOUNDARY, INJECTION_MODES.LONG_CHECKPOINT, INJECTION_MODES.LONG_CHECKPOINT_RECENT].includes(settings.injectionMode)) {
        const coveredThrough = longs.at(-1)?.endFloor ?? 0;
        const checkpoints = [...store.checkpoints]
            .filter(item => isUsableMemory(item) && item.endFloor > coveredThrough)
            .sort(byRange)
            .slice(-settings.recentCheckpointCount);
        for (const item of checkpoints) blocks.push(`[${String(item.id).toUpperCase().replaceAll('-', '_')}]\n${item.content}`);
    }

    if (settings.injectionMode === INJECTION_MODES.LONG_CHECKPOINT_RECENT) {
        const coveredThrough = Math.max(0, ...store.checkpoints.filter(item => !item.sourceReplaced && isUsableMemory(item)).map(item => item.endFloor), ...longs.map(item => item.endFloor));
        const summaries = Object.values(store.summaries)
            .filter(item => item.floor > coveredThrough && !fallbackIds.has(item.messageId) && isUsableMemory(item))
            .sort((a, b) => a.floor - b.floor)
            .slice(-settings.recentSummaryCount);
        for (const item of summaries) {
            blocks.push(`[RECENT_SUMMARY_${String(item.floor).padStart(3, '0')}]\n${item.title}\n人物：${item.characters}\n事件：${item.event}`);
        }
    }

    return fullInjection(blocks, store, settings);
}
