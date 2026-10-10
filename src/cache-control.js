import { INJECTION_MODES } from './defaults.js?v=1.24.2';
import { buildInjection } from './injection.js?v=1.24.2';
import { collectKeepItems, formatKeepItems, isUsableMemory } from './continuity.js?v=1.24.2';
import { fnv1a } from './utils.js?v=1.24.2';
import { stripStructuredSections } from './summary-format.js?v=1.24.2';
import { omitRepeatedStateLines, reconcileTrackedCheckpoint } from './active-state.js?v=1.24.2';

export function effectiveInjectionMode(settings) {
    if (!settings.strictCacheMode) return settings.injectionMode;
    if (settings.injectionMode === INJECTION_MODES.NONE) return INJECTION_MODES.NONE;
    if ([INJECTION_MODES.LONG, INJECTION_MODES.LONG_BOUNDARY].includes(settings.injectionMode)) return INJECTION_MODES.LONG_BOUNDARY;
    return INJECTION_MODES.CHECKPOINT_BOUNDARY;
}

export function shouldRefreshInjection(settings, reason) {
    if (reason === 'summary mode changed') return false;
    if (!settings.strictCacheMode) return true;
    if (['manual edit', 'manual reinject', 'settings changed', 'chat changed', 'current chat cleared'].includes(reason)) return true;
    const mode = effectiveInjectionMode(settings);
    return (reason === 'new checkpoint' && mode === INJECTION_MODES.CHECKPOINT_BOUNDARY)
        || (reason === 'new long memory' && [INJECTION_MODES.CHECKPOINT_BOUNDARY, INJECTION_MODES.LONG_BOUNDARY].includes(mode));
}

function frozenBlocks(store, mode, settings) {
    const blocks = [];
    const add = (record, type) => {
        const delta = (record.factUpdates ?? []).map(update => update.action === 'retire'
            ? `- RETIRE ${update.previousId}: ${update.reason || update.evidence || '明确失效'}`
            : `- ${update.action.toUpperCase()} ${update.id}${update.previousId ? ` (supersedes ${update.previousId})` : ''}: ${update.text}`).join('\n');
        let content = record.memoryKind === 'facts' && Array.isArray(record.factUpdates)
            ? `[FACT_DELTA]\n${delta || '本阶段无新增或有证据的长期事实变更。'}${record.continuityState ? `\n${record.continuityState}` : ''}`
            : stripStructuredSections(record.content ?? '', ['KEEP', 'RESOLVED_KEEP', 'SUPERSEDED_KEEP']);
        if (type === 'checkpoint' && record.memoryKind === 'state' && settings.activeStateEnabled) content = reconcileTrackedCheckpoint(content, store, record.endFloor, record.startFloor);
        blocks.push({ id: `${type}:${record.id}`, type, startFloor: record.startFloor, endFloor: record.endFloor,
            text: `[${type === 'long' ? 'LONG_MEMORY' : 'CHECKPOINT'}_${String(record.id).split('-').at(-1)} | 第${record.startFloor}-${record.endFloor}层]\n${content}` });
    };
    for (const record of [...store.longMemories].filter(isUsableMemory).sort((a, b) => a.startFloor - b.startFloor)) add(record, 'long');
    if (mode === INJECTION_MODES.CHECKPOINT_BOUNDARY) {
        for (const record of [...store.checkpoints].filter(isUsableMemory).sort((a, b) => a.startFloor - b.startFloor)) add(record, 'checkpoint');
    }
    const keeps = formatKeepItems(collectKeepItems(store));
    if (keeps !== '无') blocks.push({ id: 'keep:active', type: 'keep', startFloor: 0, endFloor: 0, text: `[KEEP]\n${keeps}` });
    return blocks;
}

// Snapshot bytes belong to a chat and survive reload. Background tasks can add blocks,
// but never rewrite published text. Only a Long boundary may remove fully covered CP injection.
export function refreshSnapshot(store, settings, reason = 'manual edit', sourceStore = store) {
    if (!shouldRefreshInjection(settings, reason)) return { value: store.injectionSnapshot?.value ?? '', changed: false, skipped: true };
    const mode = effectiveInjectionMode(settings);
    const signature = JSON.stringify([settings.enabled, Boolean(settings.strictCacheMode), mode]);
    const previous = store.injectionSnapshot;
    const invalidPublishedSource = previous?.blocks?.some(block => {
        if (!['long', 'checkpoint'].includes(block.type)) return false;
        const records = block.type === 'long' ? store.longMemories : store.checkpoints;
        return !records.some(item => `${block.type}:${item.id}` === block.id && isUsableMemory(item));
    });
    if (reason === 'chat changed' && previous?.signature === signature && (!invalidPublishedSource || previous.needsRebuild)) return { value: previous.value, changed: false };
    let blocks = [];
    let value = '';
    if (settings.enabled && mode !== INJECTION_MODES.NONE) {
        if (!settings.strictCacheMode) value = buildInjection(sourceStore, settings);
        else {
            const fresh = frozenBlocks(sourceStore, mode, settings);
            const rebuild = !previous || previous.signature !== signature || (previous.needsRebuild || invalidPublishedSource || previous.budget?.clipped || previous.budget?.omitted) && ['new checkpoint', 'new long memory'].includes(reason) || ['manual edit', 'manual reinject', 'settings changed', 'chat changed', 'current chat cleared'].includes(reason);
            blocks = rebuild ? fresh : [...(previous.blocks ?? [])];
            if (!rebuild) {
                const ids = new Set(blocks.map(block => block.id));
                const freshKeep = fresh.find(block => block.id === 'keep:active');
                blocks = blocks.filter(block => block.id !== 'keep:active');
                for (const block of fresh) if (block.id !== 'keep:active' && !ids.has(block.id)) { blocks.push(block); ids.add(block.id); }
                if (freshKeep) blocks.push(freshKeep);
            }
            // Explicitly permitted compaction at a Long boundary; never delete Checkpoint data.
            const longs = blocks.filter(block => block.type === 'long');
            blocks = blocks.filter(block => block.type !== 'checkpoint' || !longs.some(long => long.startFloor <= block.startFloor && long.endFloor >= block.endFloor));
            const published = new Set(rebuild ? [] : (previous.blocks ?? []).map(block => block.id));
            const currentLines = new Map();
            blocks = blocks.map(block => {
                const text = omitRepeatedStateLines(block.text, currentLines, { omit: !published.has(block.id) });
                return text === block.text ? block : { ...block, text };
            });
            value = blocks.length ? `<CACHE_MEMORY>\n冻结块按提交顺序排列。后续有证据的事实更新优先；旧记录保留历史意义，已解决事项不要恢复为未解决。\n\n${blocks.map(block => block.text).join('\n\n')}\n\n</CACHE_MEMORY>` : '';
        }
    }
    const changed = value !== (previous?.value ?? '');
    store.injectionSnapshot = { signature, mode, blocks, value, reason: reason === 'manual reinject' ? reason : changed ? reason : previous?.reason ?? reason };
    return { value, changed };
}

export class CacheDiagnostics {
    constructor() { this.snapshots = new Map(); this.histories = new Map(); }
    reset() { this.snapshots.clear(); this.histories.clear(); }
    memory(store, settings, floor) {
        const value = store.injectionSnapshot?.value ?? '';
        const hash = fnv1a(value);
        const previous = this.snapshots.get(store.chatId);
        const changed = previous !== undefined && previous !== hash;
        this.snapshots.set(store.chatId, hash);
        return { chatId: store.chatId, floor, injectionMode: effectiveInjectionMode(settings), strictCacheMode: settings.strictCacheMode,
            memoryCharacters: value.length, memoryHash: hash, previousHash: previous ?? null, changed,
            reason: changed ? store.injectionSnapshot?.reason ?? 'unknown' : previous === undefined ? 'chat changed' : 'unchanged',
            expectedCacheImpact: previous === undefined ? '首轮基线，尚不能比较' : changed ? 'CACHE_MEMORY 更新；注入点之后的 Prompt Prefix 可能需要重新写入' : 'NONE（仅指 Cache Memory；其他 prompt/历史仍需检查）' };
    }
    history(chatId, messages) {
        const current = messages.map(message => ({ role: message.role, hash: fnv1a(JSON.stringify(message)),
            cacheMemory: JSON.stringify(message.content ?? '').includes('<CACHE_MEMORY>') }));
        const previous = this.histories.get(chatId);
        this.histories.set(chatId, current);
        if (!previous) return { baseline: true, messageCount: current.length };
        let prefix = 0;
        while (prefix < previous.length && prefix < current.length && previous[prefix].role === current[prefix].role && previous[prefix].hash === current[prefix].hash) prefix++;
        return { previousCount: previous.length, messageCount: current.length, stablePrefixMessages: prefix,
            stablePrefixPercent: previous.length ? Math.round(prefix / previous.length * 100) : 100,
            brokeAt: prefix === previous.length ? null : { index: prefix, role: current[prefix]?.role ?? 'removed',
                source: previous[prefix]?.cacheMemory || current[prefix]?.cacheMemory ? 'CACHE_MEMORY' : 'other prompt/history',
                previousHash: previous[prefix]?.hash, currentHash: current[prefix]?.hash ?? null } };
    }
}
