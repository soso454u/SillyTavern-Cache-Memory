import { fnv1a } from './utils.js?v=1.7.0';

export const isUsableMemory = item => item.frozen !== false && ['frozen', 'manual-edited'].includes(item.status ?? 'frozen');

export function readSection(text, name) {
    const sections = String(text ?? '').split(/^\s*\[([^\]\n]+)\]\s*$/m);
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
    return item.format === 'structured' && !item.manualEdited
        ? item.raw
        : `${item.title}\n人物：${item.characters}\n事件：${item.event}`;
}

function keepFromRecord(item) {
    const text = summaryText(item);
    const entries = [...lines(readSection(text, 'KEEP')), ...lines(readSection(text, 'Open'))];
    return [...new Set(entries)].map(text => ({
        id: `keep-${fnv1a(`${item.messageId ?? item.id}:${text}`)}`,
        text, floor: item.floor ?? item.endFloor, status: 'active',
    }));
}

export function collectKeepItems(store, throughFloor = Infinity) {
    const map = new Map();
    const checkpoints = store.checkpoints.filter(item => isUsableMemory(item) && item.endFloor <= throughFloor)
        .sort((a, b) => a.endFloor - b.endFloor);
    for (const item of Object.values(store.summaries).filter(item => isUsableMemory(item) && item.floor <= throughFloor)) {
        for (const keep of keepFromRecord(item)) map.set(keep.id, keep);
    }
    for (const checkpoint of checkpoints) {
        for (const keep of checkpoint.keepItems ?? []) map.set(keep.id, { ...keep });
    }
    return [...map.values()];
}

function evidencedChanges(text, section, source) {
    return lines(readSection(text, section)).flatMap(line => {
        const [id, value, evidence] = line.split('|').map(part => part.trim());
        // A model may not remove an item merely by omitting it or claiming it is old.
        if (!id || !value || !evidence || evidence.length < 4 || !source.includes(evidence)) return [];
        return [{ id, value, evidence }];
    });
}

export function resolveKeepItems(items, output, newSummaries) {
    const resolutions = new Map(evidencedChanges(output, 'RESOLVED_KEEP', newSummaries).map(item => [item.id, item]));
    return items.map(item => {
        const resolution = resolutions.get(item.id);
        return item.status === 'active' && resolution
            ? { ...item, status: 'resolved', reason: resolution.value, evidence: resolution.evidence }
            : { ...item };
    });
}

export function formatKeepItems(items) {
    return items.filter(item => item.status === 'active').map(item => `- ${item.id} | ${item.text}`).join('\n') || '无';
}

export function previousState(store, startFloor) {
    const checkpoints = store.checkpoints.filter(item => isUsableMemory(item) && item.endFloor < startFloor)
        .sort((a, b) => a.endFloor - b.endFloor);
    const latest = checkpoints.at(-1);
    if (latest?.memoryKind === 'state') return { id: latest.id, content: latest.content };
    // First incremental checkpoint seeds from all retained legacy aggregate ranges.
    const longs = store.longMemories.filter(item => isUsableMemory(item) && item.endFloor < startFloor && item.memoryKind !== 'facts');
    return {
        id: latest?.id ?? '',
        content: [...longs, ...checkpoints].map(item => `[${item.id} | 第${item.startFloor}-${item.endFloor}层]\n${item.content}`).join('\n\n') || '无上一份状态',
    };
}

export function projectLongFacts(store, throughFloor = Infinity) {
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
                facts.set(update.previousId, { ...facts.get(update.previousId), status: update.action === 'retire' ? 'retired' : 'superseded', reason: update.reason, evidence: update.evidence });
            }
            if (update.action !== 'retire') facts.set(update.id, {
                id: update.id, text: update.text, status: 'active', floor: memory.endFloor,
            });
        }
    }
    return { legacy, facts: [...facts.values()] };
}

export function formatLongFacts(projection) {
    return [
        ...projection.legacy.map(item => `[历史长期记忆 ${item.id}]\n${item.content}`),
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
    return updates;
}
