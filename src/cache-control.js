import { INJECTION_MODES } from './defaults.js?v=1.27.3';
import { buildInjection, currentInjectionBlocks, renderInjectionBlocks } from './injection.js?v=1.27.3';
import { fnv1a } from './utils.js?v=1.27.3';

export function effectiveInjectionMode(settings) {
    if (settings.injectionMode === INJECTION_MODES.ROLLING) return INJECTION_MODES.ROLLING;
    if (!settings.strictCacheMode) return settings.injectionMode;
    if (settings.injectionMode === INJECTION_MODES.NONE) return INJECTION_MODES.NONE;
    if ([INJECTION_MODES.LONG, INJECTION_MODES.LONG_BOUNDARY].includes(settings.injectionMode)) return INJECTION_MODES.LONG_BOUNDARY;
    return INJECTION_MODES.CHECKPOINT_BOUNDARY;
}

export function shouldRefreshInjection(settings, reason) {
    if (reason === 'summary mode changed') return false;
    if (settings.injectionMode === INJECTION_MODES.ROLLING) return true;
    if (!settings.strictCacheMode) return true;
    if (['manual edit', 'manual reinject', 'settings changed', 'chat changed', 'current chat cleared'].includes(reason)) return true;
    const mode = effectiveInjectionMode(settings);
    return (reason === 'new checkpoint' && mode === INJECTION_MODES.CHECKPOINT_BOUNDARY)
        || (reason === 'new long memory' && [INJECTION_MODES.CHECKPOINT_BOUNDARY, INJECTION_MODES.LONG_BOUNDARY].includes(mode));
}

// Frozen bytes survive reload, upgrades and ordinary Summary/state changes.
// Publish the complete current projection only at the existing CP/Long boundary
// or an explicit manual action; storage records are never compacted or rewritten.
export function refreshSnapshot(store, settings, reason = 'manual edit', sourceStore = store) {
    if (!shouldRefreshInjection(settings, reason)) return { value: store.injectionSnapshot?.value ?? '', changed: false, skipped: true };
    const previous = store.injectionSnapshot;
    const mode = effectiveInjectionMode(settings);
    const signature = JSON.stringify([settings.enabled, Boolean(settings.strictCacheMode), mode, 4, Boolean(settings.historyHandoff), settings.recentRawFloors]);
    // A plugin upgrade is not a publication boundary. Preserve even old-format
    // snapshots until the next CP/Long commit or explicit rebuild.
    let previousMode = previous?.mode;
    try { previousMode ??= JSON.parse(previous?.signature ?? 'null')?.[2]; } catch { /* Older snapshots may lack a signature. */ }
    if (reason === 'chat changed' && previous && settings.strictCacheMode && settings.enabled && mode !== INJECTION_MODES.NONE && mode !== INJECTION_MODES.ROLLING
        && (!previousMode || previousMode === mode)) return { value: previous.value, changed: false };
    const blocks = settings.enabled && mode !== INJECTION_MODES.NONE
        ? currentInjectionBlocks(sourceStore, settings, mode) : [];
    const value = !settings.enabled || mode === INJECTION_MODES.NONE ? '' : settings.strictCacheMode
        ? renderInjectionBlocks(blocks, sourceStore) : buildInjection(sourceStore, settings);
    const changed = value !== (previous?.value ?? '');
    store.injectionSnapshot = { signature, mode, blocks, value, recentRawFloors: settings.recentRawFloors, historyHandoff: mode === INJECTION_MODES.ROLLING || Boolean(settings.historyHandoff), reason: reason === 'manual reinject' ? reason : changed ? reason : previous?.reason ?? reason };
    return { value, changed, migrated: Boolean(previous && previous.signature !== signature) };
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
