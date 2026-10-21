import { fnv1a } from './utils.js?v=1.26.0';
import { buildStructuredSummary, parseStructuredSummary, stripStructuredSections } from './summary-format.js?v=1.26.0';
import { storyTimeForEvidence } from './story-metadata.js?v=1.26.0';
import { isTrackedActive, isAtomicTrackedEntry, matchesTrackedFact, matchesTrackedValue, projectActiveState } from './active-state.js?v=1.26.0';

export const hasAggregateContent = item => Boolean(String(item?.content ?? '').trim() || item?.memoryKind === 'facts' && Array.isArray(item.factUpdates));

export const isUsableMemory = item => item && item.frozen !== false && ['frozen', 'manual-edited', 'stale', 'orphaned'].includes(item.status ?? 'frozen')
    && (item.startFloor !== undefined || item.endFloor !== undefined || item.memoryKind === 'facts'
        ? hasAggregateContent(item) : ['raw', 'event', 'state', 'open', 'keep', 'quote'].some(key => String(item[key] ?? '').trim()));

export function readSection(text, name) {
    const sections = String(text ?? '').split(/^\s*\[([^\]\n[{}"]+)\]\s*$/m);
    for (let index = 1; index < sections.length; index += 2) {
        if (sections[index].toLowerCase() === name.toLowerCase()) return sections[index + 1].trim();
    }
    return '';
}

function lines(text) {
    return String(text).split('\n').map(line => line.replace(/^\s*[-*]\s*/, '').trim())
        .filter(line => line && !/^(无|暂无|none|\[none\])。?$/i.test(line));
}

export function summaryText(item) {
    // Manual edits and legacy XML records use their current visible fields.
    return item.format === 'structured'
        ? buildStructuredSummary(parseStructuredSummary(item.raw) ?? item)
        : `${item.title}\n人物：${item.characters}\n事件：${item.event}`;
}

export function normalizeKeepText(value) {
    return String(value ?? '').trim()
        .replace(/^\s*(?:(?:[-*•]+)|(?:\d+[.)、:])|(?:[（(]?\d+[）)]))\s*/, '')
        .replace(/\s+/g, ' ')
        .trim();
}

export function extractSummaryKeepEntries(item) {
    const parsed = item.format === 'structured' ? parseStructuredSummary(item.raw) : null;
    const entries = lines(item.keep ?? parsed?.keep ?? readSection(summaryText(item), 'KEEP')).map(normalizeKeepText).filter(text => text && !isEmptyKeepText(text));
    return [...new Set(entries)];
}

export function collectKeepItems(store, throughFloor = Infinity) {
    const state = projectActiveState(store, throughFloor).filter(item => !item.needsReview);
    return Object.entries(store?.keepRegistry ?? {}).map(([id, item]) => {
        const latest = state.find(row => row.sourceFloor > (Number(item.sourceFloor) || 0)
            && (isAtomicTrackedEntry(item.text, row) || row.history.some(old => matchesTrackedValue(item.text, row, old.value, old.key))));
        if (item.status !== 'active' || !latest || !latest.evidence) return { ...item, id };
        const ended = !isTrackedActive(latest);
        const changed = !matchesTrackedValue(item.text, latest, latest.value)
            && (isAtomicTrackedEntry(item.text, latest) || latest.history.some(old => matchesTrackedValue(item.text, latest, old.value, old.key)));
        return ended || changed ? { ...item, id, status: ended ? 'resolved' : 'superseded', reason: latest.value, evidence: latest.evidence } : { ...item, id };
    })
        .filter(item => (Number(item.sourceFloor) || 0) <= throughFloor)
        .sort((a, b) => {
            const left = Number(String(a.id).match(/\d+/)?.[0]) || 0;
            const right = Number(String(b.id).match(/\d+/)?.[0]) || 0;
            return left - right;
        });
}

function evidencedChanges(text, section, source) {
    return lines(readSection(text, section)).flatMap(line => {
        const [id, value, evidence] = line.split('|').map(part => part.trim());
        // A model may not remove an item merely by omitting it or claiming it is old.
        if (!id || !value || !evidence || evidence.length < 4 || !source.includes(evidence)) return [];
        return [{ id, value, evidence }];
    });
}

export function resolveKeepItems(items, output, newSummaries, summaries = []) {
    const resolutions = new Map(evidencedChanges(output, 'RESOLVED_KEEP', newSummaries).map(item => [item.id.toUpperCase(), item]));
    const superseded = new Map(evidencedChanges(output, 'SUPERSEDED_KEEP', newSummaries).map(item => [item.id.toUpperCase(), item]));
    const now = new Date().toISOString();
    return items.map(item => {
        const resolution = resolutions.get(String(item.id).toUpperCase());
        const replacement = superseded.get(String(item.id).toUpperCase());
        if (item.status !== 'active') return { ...item };
        if (resolution) return { ...item, status: 'resolved', reason: resolution.value, evidence: resolution.evidence,
            resolvedStoryTime: storyTimeForEvidence(summaries, resolution.evidence), updatedAt: now };
        if (replacement) return { ...item, status: 'superseded', reason: replacement.value, evidence: replacement.evidence,
            resolvedStoryTime: storyTimeForEvidence(summaries, replacement.evidence), updatedAt: now };
        return { ...item };
    });
}

export const isEmptyKeepText = value => /^(?:无|暂无|none)(?:[（(][\s\S]*[）)])?[。.]?$/iu.test(normalizeKeepText(value));

export function formatKeepItems(items) {
    const seen = new Set();
    return items.filter(item => item.status === 'active' && !isEmptyKeepText(item.text) && normalizeKeepText(item.text) && !seen.has(normalizeKeepText(item.text)) && seen.add(normalizeKeepText(item.text)))
        .map(item => `- ${item.id} | ${item.text}`).join('\n') || '无';
}

// Recover only durable, attributable facts from retained data. This is a
// read-only supplement, never whole old CP blocks or a byte/character budget.
export function checkpointHistoricalFacts(store, throughFloor, content = '') {
    const facts = [];
    const seen = new Set();
    const normalized = value => String(value).replace(/^\s*[-*•]\s*/u, '').replace(/\s+/gu, ' ').trim();
    const covered = normalized(content);
    const add = text => {
        const key = normalized(text);
        if (!key || seen.has(key) || covered.includes(key) || covered.includes(key.replace(/^历史前因：/u, ''))) return;
        seen.add(key); facts.push(key);
    };
    for (const row of projectActiveState(store, throughFloor)) {
        if (row.needsReview || row.kind !== 'state' || !isTrackedActive(row) || row.lifetime === 'temporary'
            || row.acquisition === 'pending') continue;
        if (![row, ...row.history].some(old => matchesTrackedValue(content, row, old.value, old.key)))
            add(`${row.entity} · ${row.key}：${row.value}`);
    }
    const durable = /(?:身份|之妻|丈夫|之子|之女|助理|导演|嘉宾|律师|医生|秘书|发小|外交官|造型师|男模|帮佣|宠物|父亲|二婶|组织|阵营|绑定|秘密|不知情|不知道|误信|隐瞒|认知差|永久|不可逆|终身|股权|股份|残疾|债务|承诺|誓言)/u;
    const transient = /(?:当前|此刻|位于|正在|情绪|姿势|今晚|明早|明日|计划|待|未拆|未回复|体温|点数|余额)/u;
    const recoveredCharacters = new Set();
    for (const cp of store.checkpoints.filter(item => isUsableMemory(item) && item.endFloor <= throughFloor).sort((a, b) => b.endFloor - a.endFloor)) {
        // Name + stable identity clause; no wholesale old character paragraphs.
        for (const line of readSection(cp.content, 'Characters').split('\n')) {
            const match = line.replace(/^\s*[-*•]\s*/u, '').match(/^([^：:·\n]+)[：:]([^\n]+)/u);
            if (!match) continue;
            const name = match[1].trim();
            if (recoveredCharacters.has(name)) continue;
            // A newer complete character entry owns its identity and relations.
            if (new RegExp(`(?:^|\\n)\\s*(?:-\\s*)?${name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}[：:]`, 'u').test(content)) continue;
            const clauses = match[2].split(/[。；;]/u).map(text => text.trim()).filter(clause => durable.test(clause) && !transient.test(clause));
            if (clauses.length) { recoveredCharacters.add(name); add(`${name}：${clauses.join('；')}`); }
        }
        // Explicit irreversible causes survive even in legacy records without Changes.
        for (const line of readSection(cp.content, 'Story So Far').split('\n')) {
            for (const clause of line.split(/(?<=[。])/u)) {
                if (/(?:永久|不可逆|终身|灭亡|垮台|失去.{0,8}(?:右臂|左臂|双腿|视力)|重大债务)/u.test(clause)
                    && !/(?:原剧情|预演|将会|未来|梦境|假如|计划)/u.test(clause)) add(`历史前因：${clause.trim()}`);
            }
        }
    }
    return facts;
}

export function previousState(store, startFloor) {
    const checkpoints = store.checkpoints.filter(item => isUsableMemory(item) && item.endFloor < startFloor)
        .sort((a, b) => a.endFloor - b.endFloor);
    const latest = checkpoints.at(-1);
    if (latest?.memoryKind === 'state') return { id: latest.id, content: stripStructuredSections(latest.content, ['KEEP', 'RESOLVED_KEEP', 'SUPERSEDED_KEEP', 'STATE_RESOLUTIONS']) };
    // First incremental checkpoint seeds from all retained legacy aggregate ranges.
    const longs = store.longMemories.filter(item => isUsableMemory(item) && item.endFloor < startFloor && item.memoryKind !== 'facts');
    return {
        id: latest?.id ?? '',
        content: [...longs, ...checkpoints].map(item => `[${item.id} | 第${item.startFloor}-${item.endFloor}层]\n${item.content}`).join('\n\n') || '无上一份状态',
    };
}

export function projectLongFacts(store, throughFloor = Infinity, { includeTracked = false } = {}) {
    const facts = new Map();
    const legacy = [];
    const memories = store.longMemories.filter(item => isUsableMemory(item) && item.endFloor <= throughFloor)
        .sort((a, b) => a.endFloor - b.endFloor);
    for (const memory of memories) {
        if (memory.memoryKind !== 'facts') {
            legacy.push(memory);
            continue;
        }
        const updates = memory.factUpdates ?? [];
        for (const update of updates) {
            if (update.previousId && facts.has(update.previousId)) {
                facts.set(update.previousId, { ...facts.get(update.previousId), status: update.action === 'retire' ? 'retired' : 'superseded', reason: update.reason, evidence: update.evidence,
                    resolvedBy: memory.id, resolvedFloor: memory.endFloor });
            }
            if (update.action !== 'retire') facts.set(update.id, {
                id: update.id, stateId: update.stateId, text: update.text, status: 'active', floor: memory.endFloor,
                sourceId: memory.id, startFloor: memory.startFloor, endFloor: memory.endFloor,
                storyStartTime: memory.storyStartTime ?? '', storyEndTime: memory.storyEndTime ?? '', createdAt: memory.createdAt ?? '',
            });
        }
    }
    // A terminal transient must also retire an old typed Long entry in the
    // projection, even though temporary states never create new Long facts.
    for (const item of projectActiveState(store, throughFloor).filter(row => !row.needsReview && !isTrackedActive(row))) {
        for (const fact of facts.values()) {
            if (fact.status !== 'active' || fact.floor > item.sourceFloor) continue;
            if (fact.stateId === item.id || isAtomicTrackedEntry(fact.text, item)
                || [...item.history, item].some(old => matchesTrackedValue(fact.text, item, old.value, old.key)))
                facts.set(fact.id, { ...fact, status: 'retired', reason: item.value, evidence: item.evidence });
        }
    }
    if (includeTracked) {
        for (const item of projectActiveState(store, throughFloor).filter(row => row.kind === 'state' && !row.needsReview && row.lifetime !== 'temporary' && row.acquisition !== 'pending')) {
            const matches = [...facts.values()].filter(fact => fact.status === 'active' && (fact.stateId === item.id
                || isAtomicTrackedEntry(fact.text, item) || [...item.history, item].some(old => matchesTrackedValue(fact.text, item, old.value, old.key))));
            if (matches.some(fact => fact.floor > item.sourceFloor)) continue;
            if (includeTracked === 'existing' && !matches.length) continue;
            const id = matches[0]?.id ?? item.id;
            for (const duplicate of matches.slice(1)) facts.set(duplicate.id, { ...duplicate, status: 'superseded' });
            facts.set(id, { id, stateId: item.id, text: `【${item.entity}｜${item.key}】${item.value}`, status: item.needsReview ? 'needs-review' : item.status === 'active' ? 'active' : 'retired',
                floor: item.sourceFloor, sourceId: item.sourceId, tracked: true, evidence: item.evidence });
        }
    }
    return { legacy, facts: [...facts.values()] };
}

export function formatLongFacts(projection) {
    const seen = new Set();
    return [
        ...projection.legacy.filter(item => {
            const key = JSON.stringify([item.startFloor, item.endFloor, item.content]);
            if (seen.has(key)) return false;
            seen.add(key); return true;
        }).map(item => `[历史长期记忆 ${item.id}]\n${item.content}`),
        ...projection.facts.filter(item => item.status === 'active').map(item => `- ${item.id} | ${item.text}`),
    ].join('\n') || '无';
}

export function parseFactUpdates(output, projection, newSummaries) {
    const active = new Map(projection.facts.filter(item => item.status === 'active').map(item => [item.id, item]));
    const updates = [];
    for (const text of lines(readSection(output, 'LONG_MEMORY'))) {
        if (![...active.values()].some(item => item.text === text)) updates.push({ action: 'add', id: `fact-${fnv1a(text)}`, text });
    }
    for (const section of ['UPDATED_FACTS', 'RETIRED_FACTS']) {
        for (const change of evidencedChanges(output, section, newSummaries)) {
            if (!active.has(change.id)) continue;
            updates.push({
                action: section === 'UPDATED_FACTS' ? 'replace' : 'retire',
                previousId: change.id,
                id: `fact-${fnv1a(change.value)}`,
                text: change.value, reason: change.value, evidence: change.evidence,
            });
            active.delete(change.id);
        }
    }
    if (!updates.length && !/\[(LONG_MEMORY|UPDATED_FACTS|RETIRED_FACTS)\]/i.test(output) && String(output).trim()) {
        // Preserve custom prompt output instead of silently discarding it.
        const text = String(output).trim();
        if (![...active.values()].some(item => item.text === text)) updates.push({ action: 'add', id: `fact-${fnv1a(text)}`, text });
    }
    const revised = new Set(updates.filter(item => item.action === 'replace').map(item => item.text));
    const seen = new Set();
    return updates.filter(item => {
        if (item.action === 'add' && revised.has(item.text)) return false;
        const key = JSON.stringify([item.action, item.id, item.previousId]);
        if (seen.has(key)) return false;
        seen.add(key); return true;
    });
}
