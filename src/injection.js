import { characterTablesEnabled, selectedTableRecords, CHARACTER_TABLES, tableForRecord } from './character-tables.js?v=1.27.5';
import { INJECTION_MODES } from './defaults.js?v=1.27.5';
import { checkpointHistoricalFacts, collectKeepItems, formatKeepItems, formatLongFacts, isUsableMemory, projectLongFacts, readSection } from './continuity.js?v=1.27.5';
import { parseStructuredSummary, stripStructuredSections } from './summary-format.js?v=1.27.5';
import { hasLastingResult, isTrackedActive, isAtomicTrackedEntry, matchesTrackedFact, matchesTrackedValue, projectActiveState, reconcileTrackedCheckpoint } from './active-state.js?v=1.27.5';
import { historyPublicationLimit } from './history-handoff.js?v=1.27.5';
import { stageStartLabel } from './opening-source.js?v=1.27.5';

export function memoryReadingRules() { return '历史事件用于继承，不要求重演；当前结果以明确的新证据为准，逐人区分认知，任务完成与奖励领取分别判断。'; }

// Original CP5 / Long50 coverage. Never inject all per-floor Summary Events.
export function historicalStoryBlocks(store, throughFloor, includeCP = true) {
    const valid = item => isUsableMemory(item) && item.endFloor <= throughFloor;
    const meaningful = text => Boolean(text?.trim()) && !/^(?:无|无新增|none)[。.!]?$/iu.test(text.trim());
    const arcKeys = new Set();
    const arcs = store.longMemories.filter(valid).map(memory => ({ memory, story: readSection(memory.content, 'STORY_ARC') || (memory.memoryKind !== 'facts' ? stripStructuredSections(memory.content, hiddenSections) : '') }))
        .filter(row => {
            const key = JSON.stringify([row.memory.startFloor, row.memory.endFloor, row.story?.trim()]);
            if (!meaningful(row.story) || arcKeys.has(key)) return false; arcKeys.add(key); return true;
        });
    const result = arcs.map(({ memory, story }) => ({ id: `story:long:${memory.id}`, type: 'long-story', coversHistory: true,
        ...(memory.openingContentFingerprint ? { openingContentFingerprint: memory.openingContentFingerprint } : {}),
        startFloor: memory.startFloor, endFloor: memory.endFloor,
        text: `[LONG_STORY_${stageStartLabel(memory)}_${memory.endFloor}]\n${story.trim()}` }));
    if (!includeCP) return result.sort((a, b) => a.startFloor - b.startFloor);
    const seen = new Set();
    for (const cp of store.checkpoints.filter(valid).sort((a, b) => a.startFloor - b.startFloor || a.endFloor - b.endFloor)) {
        const key = `${cp.startFloor}:${cp.endFloor}`;
        if (seen.has(key) || arcs.some(({ memory }) => memory.startFloor <= cp.startFloor && memory.endFloor >= cp.endFloor)) continue;
        seen.add(key);
        const story = readSection(cp.content, 'Stage Story') || readSection(cp.content, 'Events') || readSection(cp.content, 'Story So Far');
        // Every uncovered CP keeps its own place in the timeline, including old
        // cumulative formats. Remove repeated role sheets, never whole stages.
        const prose = stripStructuredSections(cp.content,
            [...hiddenSections, 'Characters', 'Current State', 'Secrets & Knowledge', 'Open Threads', 'Continuity Locks']);
        // Some very old CPs have no story field at all. Their only record is
        // retained as dated history instead of silently losing the whole range.
        const narrative = story || (meaningful(prose.replace(/^\s*\[CHECKPOINT\]\s*/iu, '')) ? prose
            : stripStructuredSections(cp.content, hiddenSections).replace(/\[(Characters|Current State|Secrets & Knowledge|Open Threads|Continuity Locks)\]/gu, '[历史记录 · $1]'));
        const block = { id: `checkpoint:${cp.id}`, type: 'checkpoint', startFloor: cp.startFloor, endFloor: cp.endFloor,
            coversHistory: Boolean(story || meaningful(prose.replace(/^\s*\[CHECKPOINT\]\s*/iu, ''))),
            ...(cp.openingContentFingerprint ? { openingContentFingerprint: cp.openingContentFingerprint } : {}),
            text: `[CHECKPOINT_${String(cp.id).split('-').at(-1)} | 第${stageStartLabel(cp)}–${cp.endFloor}层 · 历史剧情]\n${narrative}` };
        if (meaningful(narrative.replace(/^\s*\[CHECKPOINT\]\s*/iu, ''))) result.push(block);
    }
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
const checkpointModes = [INJECTION_MODES.ROLLING, INJECTION_MODES.CHECKPOINT_BOUNDARY, INJECTION_MODES.LONG_CHECKPOINT, INJECTION_MODES.LONG_CHECKPOINT_RECENT];
const hiddenSections = ['KEEP', 'RESOLVED_KEEP', 'SUPERSEDED_KEEP', 'STATE_RESOLUTIONS'];
const canonical = text => String(text).replace(/^\s*[-*•]\s*/u, '')
    .replace(/^(?:KEEP-\d+\s*\|\s*)+/iu, '')
    .replace(/^【([^｜】]+)｜([^】]+)】/u, '$1 · $2：').replace(/\s+/gu, ' ').trim();

// One read-only projection for strict boundary publication and non-strict mode.
// Old CPs and Longs stay in the store; only uncovered durable facts are sent.
// Publish only real enduring/relevant deltas. Never turn routine temporary
// states into an ever-growing role sheet in the cache prompt.
export function relevantSnapshotRows(store, throughFloor) {
    const durable = /^(?:identity|relationship|knowledge|skill|attribute|reward|history|personality|preference)$/u;
    const important = /(?:伤|疾病|毒|昏迷|限制|禁令|身份|关系|认知|秘密|调查|证据|能力|技能|等级|积分|点数|余额|股份|股权|债务|契约|承诺|禁忌|任务|计划|线索|物品归属|监控|药效|影响|危险|异能)/u;
    const trivialDone = /(?:行李箱密码|便签位置|便利贴位置|临时站位|当前姿势|普通衣着|已成功开箱|已收拾完毕)/u;
    return projectActiveState(store, throughFloor).filter(item => {
        if (item.needsReview || !isTrackedActive(item) || item.category === 'history') return false;
        if (item.kind === 'thread') return !/^(?:普通消息|随手问候|等待回复)$/u.test(item.key);
        if (trivialDone.test(item.key + item.value) && item.lifetime === 'temporary') return false;
        return durable.test(item.category ?? '') || important.test(item.key + ' ' + item.value);
    });
}

export function currentInjectionBlocks(store, settings, mode = settings.injectionMode) {
    const useCP = checkpointModes.includes(mode);
    const rolling = mode === INJECTION_MODES.ROLLING;
    const completed = settings.injectionFloor ?? Math.max(0,
        ...Object.values(store.summaries ?? {}).filter(isUsableMemory).map(row => row.floor),
        ...store.checkpoints.filter(isUsableMemory).map(row => row.endFloor),
        ...store.longMemories.filter(isUsableMemory).map(row => row.endFloor));
    const limit = rolling ? Math.max(0, completed - settings.recentRawFloors)
        : settings.historyHandoff ? historyPublicationLimit(store, isUsableMemory) : Infinity;
    const eligible = item => isUsableMemory(item) && item.endFloor <= limit;
    const latest = useCP ? store.checkpoints.filter(eligible)
        .sort((a, b) => a.endFloor - b.endFloor || a.startFloor - b.startFloor).at(-1) : null;
    const through = rolling ? limit : Math.max(latest?.endFloor || 0, ...store.longMemories.filter(eligible).map(row => row.endFloor), 0);
    // One CP5/Long50 story per uncovered range; never all per-floor Summary.
    const blocks = historicalStoryBlocks(store, through, useCP);
    if (rolling) {
        const covered = floor => blocks.some(block => block.coversHistory && block.startFloor <= floor && block.endFloor >= floor);
        const seen = new Set();
        for (const row of Object.values(store.summaries ?? {}).filter(isUsableMemory).sort((a, b) => a.floor - b.floor)) {
            if (!Number.isInteger(row.floor) || row.floor < 1 || row.floor > limit || covered(row.floor) || seen.has(row.floor)) continue;
            const fields = { ...(parseStructuredSummary(row.raw) ?? {}), ...row };
            const meaningful = text => text && !/^(?:无|none)[。.]?$/iu.test(String(text).trim());
            if (!meaningful(fields.event)) continue;
            seen.add(row.floor);
            const story = [['标题', fields.title], ['人物', fields.characters], ['时间', fields.storyTime], ['地点', fields.location],
                ['事件', fields.event], ['原话', fields.quote]].filter(([, text]) => meaningful(text)).map(([label, text]) => `${label}：${text}`).join('\n');
            blocks.push({ id: `summary:${row.messageId ?? row.floor}`, type: 'summary-story', coversHistory: true,
                startFloor: row.floor, endFloor: row.floor, text: `[SUMMARY_STORY_${row.floor}]\n${story}` });
        }
        blocks.sort((a, b) => a.startFloor - b.startFloor || a.endFloor - b.endFloor);
    }
    // Old CPs contain repeated role sheets in addition to plot. Keep their
    // latest current context once, alongside ALL uncovered stage stories.
    if (latest) {
        const names = [...(readSection(latest.content, 'Stage Story') ? ['Story So Far'] : []),
            'Characters', 'Current State', 'Secrets & Knowledge', 'Open Threads', 'Continuity Locks']
            .filter(name => { const text = readSection(latest.content, name); return text && !/^(?:无|none)[。.]?$/iu.test(text.trim()); });
        const projected = names.length ? reconcileTrackedCheckpoint(latest.content, store, through, latest.startFloor) : '';
        const latestStory = canonical(blocks.find(block => block.id === `checkpoint:${latest.id}`)?.text ?? '');
        const contextNames = names.length ? [...new Set([...names,
            'Characters', 'Current State', 'Secrets & Knowledge', 'Open Threads', 'Continuity Locks'])] : [];
        const context = contextNames.flatMap(name => {
            // Keep the original historical causes, but reconcile current fields
            // against explicit results. Do not append a new role sheet to a
            // story-only CP or add repeated historical task rows here.
            const text = readSection(name === 'Story So Far' ? latest.content : projected, name);
            return text && !/^(?:无|none)[。.]?$/iu.test(text.trim()) && !latestStory.includes(canonical(text)) ? [`[${name}]\n${text}`] : [];
        });
        if (context.length) blocks.push({ id: 'legacy:latest-context', type: 'legacy-context', startFloor: latest.startFloor,
            endFloor: latest.endFloor, text: '[LEGACY_CONTEXT]\n' + context.join('\n') });
    }
    // Tables are optional, separately labelled, and frozen at the same CP/Long
    // boundary. Never append their rows into Summary, CP or Long prose.
    if (characterTablesEnabled(store, settings)) {
        const records = selectedTableRecords(relevantSnapshotRows(store, through), settings);
        const tables = CHARACTER_TABLES.flatMap(table => {
            const lines = records.filter(row => tableForRecord(row) === table.key).map(row =>
                `- ${row.entity} · ${row.key}：${row.value}${row.condition ? `；条件：${row.condition}` : ''}${row.acquisition === 'pending' ? '（未领取）' : ''}`);
            return lines.length ? [`【${table.label}】`, ...lines] : [];
        });
        if (tables.length) blocks.push({ id: 'tables:current', type: 'table', startFloor: through, endFloor: through,
            text: `[CHARACTER_TABLES | 截至第${through}层]\n${tables.join('\n')}` });
    }
    const printed = blocks.map(row => row.text).join('\n');
    const seen = new Set(printed.split('\n').map(canonical));
    const uncovered = text => {
        const key = canonical(text);
        if (!key || seen.has(key) || canonical(printed).includes(key)) return false;
        seen.add(key); return true;
    };
    const projection = projectLongFacts(store, through, { includeTracked: 'existing' });
    const facts = projection.facts.filter(row => row.status === 'active'
        || row.status === 'superseded' && /(?:永久|不可逆|终身|失去.{0,8}(?:右臂|左臂|双腿|视力)|摧毁|重大损失|重大债务)/u.test(row.text))
        .filter(row => uncovered(row.text)).map(row => '- ' + row.id + ' | ' + row.text);
    if (latest && !readSection(latest.content, 'Stage Story')) {
        for (const text of checkpointHistoricalFacts(store, through, printed)) if (uncovered(text)) facts.push('- ' + text);
        // Preserve lasting settlement results once when separating legacy CP
        // history from its current fields; ordinary finished actions stay out.
        for (const row of projectActiveState(store, through).filter(row => !row.needsReview && !isTrackedActive(row) && hasLastingResult(row))) {
            const text = `${row.entity} · ${row.key}：${row.value}`;
            if (uncovered(text)) facts.push(`- ${text}（已结束，长期结果）`);
        }
    }
    // Legacy Long formats may contain important durable history.
    for (const memory of projection.legacy) {
        const lines = stripStructuredSections(memory.content, hiddenSections).split('\n');
        for (const line of lines) if (line.trim() && !/^\s*\[/.test(line) && uncovered(line)) facts.push('- ' + line.trim());
    }
    if (facts.length) blocks.push({
        id: 'long:current-facts', type: 'long', startFloor: 1, endFloor: through,
        text: '[LONG_MEMORY]\n' + facts.join('\n')
    });
    const keepThrough = Math.max(through, ...Object.values(store.summaries ?? {}).filter(isUsableMemory).map(row => row.floor), 0);
    const keeps = collectKeepItems(store, keepThrough).filter(row => row.status === 'active' && uncovered(row.text));
    const formatted = formatKeepItems(keeps);
    if (formatted !== '无') blocks.push({
        id: 'keep:active', type: 'keep', startFloor: 0, endFloor: through,
        keepIds: keeps.map(row => row.id), text: '[KEEP]\n' + formatted
    });
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
