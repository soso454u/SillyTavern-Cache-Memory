import { INJECTION_MODES } from './defaults.js?v=1.24.22';
import { checkpointHistoricalFacts, collectKeepItems, formatKeepItems, formatLongFacts, isUsableMemory, projectLongFacts, readSection } from './continuity.js?v=1.24.22';
import { stripStructuredSections } from './summary-format.js?v=1.24.22';
import { isTrackedActive, isAtomicTrackedEntry, matchesTrackedFact, matchesTrackedValue, projectActiveState, reconcileTrackedCheckpoint } from './active-state.js?v=1.24.22';

// Original CP5 / Long50 coverage. Never inject all per-floor Summary Events.
export function historicalStoryBlocks(store, throughFloor, includeCP = true) {
    const valid = item => isUsableMemory(item) && item.endFloor <= throughFloor;
    const meaningful = text => Boolean(text?.trim()) && !/^(?:无|无新增|none)[。.!]?$/iu.test(text.trim());
    const arcs = store.longMemories.filter(valid).map(memory => ({
        memory, story: readSection(memory.content, 'STORY_ARC')
    })).filter(row => meaningful(row.story));
    const result = arcs.map(row => ({
        id: 'story:long:' + row.memory.id, type: 'story',
        startFloor: row.memory.startFloor, endFloor: row.memory.endFloor,
        text: '[LONG_STORY_' + row.memory.startFloor + '_' + row.memory.endFloor + ']\n' + row.story.trim()
    }));
    if (!includeCP) return result.sort((a, b) => a.startFloor - b.startFloor);
    const seen = new Set();
    let legacy = null;
    const cps = store.checkpoints.filter(valid).sort((a, b) => a.startFloor - b.startFloor || a.endFloor - b.endFloor);
    for (const cp of cps) {
        const id = cp.startFloor + ':' + cp.endFloor;
        if (seen.has(id)) continue;
        seen.add(id);
        if (arcs.some(row => row.memory.startFloor <= cp.startFloor && row.memory.endFloor >= cp.endFloor)) continue;
        const stage = readSection(cp.content, 'Stage Story') || readSection(cp.content, 'Events');
        if (meaningful(stage)) result.push({
            id: 'story:cp:' + cp.id, type: 'story', startFloor: cp.startFloor, endFloor: cp.endFloor,
            text: '[CHECKPOINT_STORY_' + cp.startFloor + '_' + cp.endFloor + ']\n' + stage.trim()
        });
        else {
            // Older checkpoints have cumulative history, not separate stage plots.
            // Retain only the most recent copy; do NOT expand floor Summaries.
            const previous = readSection(cp.content, 'Story So Far');
            if (meaningful(previous)) legacy = {
                id: 'story:legacy:' + cp.id, type: 'story', startFloor: cp.startFloor, endFloor: cp.endFloor,
                text: '[HISTORICAL_CONTEXT | 截至第' + cp.endFloor + '层]\n' + previous.trim()
            };
        }
    }
    if (legacy) result.push(legacy);
    return result.sort((a, b) => a.startFloor - b.startFloor || a.endFloor - b.endFloor);
}

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
    // Only the latest checkpoint supplies current statuses and open tasks.
    // Its story is projected separately from CP5 / Long50 narratives.
    content = stripStructuredSections(content, [...hiddenSections, 'Stage Story', 'Events', 'Story So Far']);
    const blocks = historicalStoryBlocks(store, through, checkpointModes.includes(mode));
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

export function renderInjectionBlocks(blocks) {
    return blocks.length ? `<CACHE_MEMORY>\n${blocks.map(block => block.text).join('\n\n')}\n</CACHE_MEMORY>` : '';
}

export function buildInjection(store, settings) {
    if (!settings.enabled || settings.injectionMode === INJECTION_MODES.NONE) return '';
    if (settings.strictCacheMode) return store.injectionSnapshot?.value ?? '';
    const blocks = currentInjectionBlocks(store, settings);
    return renderInjectionBlocks(blocks, store);
}
