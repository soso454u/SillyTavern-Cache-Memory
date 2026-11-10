import { INJECTION_MODES } from './defaults.js?v=1.27.21';
import { buildInjection, currentInjectionBlocks, renderInjectionBlocks } from './injection.js?v=1.27.21';
import { fnv1a } from './utils.js?v=1.27.16';
import { compareRequests, fingerprint, inspectRequest, requestReport } from '../server-plugin/cache-memory-api-adapter/request-integrity.mjs?v=1.27.17';

export function effectiveInjectionMode(settings) {
    if ([INJECTION_MODES.ROLLING, INJECTION_MODES.CHECKPOINT_SHORT_HISTORY].includes(settings.injectionMode)) return settings.injectionMode;
    if (!settings.strictCacheMode) return settings.injectionMode;
    if (settings.injectionMode === INJECTION_MODES.NONE) return INJECTION_MODES.NONE;
    if ([INJECTION_MODES.LONG, INJECTION_MODES.LONG_BOUNDARY].includes(settings.injectionMode)) return INJECTION_MODES.LONG_BOUNDARY;
    return INJECTION_MODES.CHECKPOINT_BOUNDARY;
}

export function freezesInjection(settings) {
    return settings.strictCacheMode || settings.injectionMode === INJECTION_MODES.CHECKPOINT_SHORT_HISTORY;
}

export function shouldRefreshInjection(settings, reason) {
    if (reason === 'summary mode changed') return false;
    if (settings.injectionMode === INJECTION_MODES.ROLLING) return true;
    if (!freezesInjection(settings)) return true;
    if (['manual edit', 'manual reinject', 'settings changed', 'chat changed', 'current chat cleared'].includes(reason)) return true;
    const mode = effectiveInjectionMode(settings);
    return (reason === 'new checkpoint' && [INJECTION_MODES.CHECKPOINT_BOUNDARY, INJECTION_MODES.CHECKPOINT_SHORT_HISTORY].includes(mode))
        || (reason === 'new long memory' && [INJECTION_MODES.CHECKPOINT_BOUNDARY, INJECTION_MODES.CHECKPOINT_SHORT_HISTORY, INJECTION_MODES.LONG_BOUNDARY].includes(mode));
}

// Frozen bytes survive reload, upgrades and ordinary Summary/state changes.
// Publish the complete current projection only at the existing CP/Long boundary
// or an explicit manual action; storage records are never compacted or rewritten.
export function refreshSnapshot(store, settings, reason = 'manual edit', sourceStore = store) {
    if (!shouldRefreshInjection(settings, reason)) return { value: store.injectionSnapshot?.value ?? '', changed: false, skipped: true };
    const previous = store.injectionSnapshot;
    const mode = effectiveInjectionMode(settings);
    const frozen = freezesInjection(settings);
    const historyHandoff = mode === INJECTION_MODES.ROLLING || mode === INJECTION_MODES.CHECKPOINT_SHORT_HISTORY || Boolean(settings.historyHandoff);
    const signature = JSON.stringify([settings.enabled, Boolean(frozen), mode, 4,
        mode === INJECTION_MODES.CHECKPOINT_SHORT_HISTORY || Boolean(settings.historyHandoff), settings.recentRawFloors]);
    // A plugin upgrade is not a publication boundary. Preserve even old-format
    // snapshots until the next CP/Long commit or explicit rebuild.
    let previousMode = previous?.mode;
    try { previousMode ??= JSON.parse(previous?.signature ?? 'null')?.[2]; } catch { /* Older snapshots may lack a signature. */ }
    if (reason === 'chat changed' && previous && frozen && settings.enabled && mode !== INJECTION_MODES.NONE && mode !== INJECTION_MODES.ROLLING
        && (!previousMode || previousMode === mode)) return { value: previous.value, changed: false };
    const blocks = settings.enabled && mode !== INJECTION_MODES.NONE
        ? currentInjectionBlocks(sourceStore, settings, mode) : [];
    const value = !settings.enabled || mode === INJECTION_MODES.NONE ? '' : frozen
        ? renderInjectionBlocks(blocks, sourceStore) : buildInjection(sourceStore, settings);
    const changed = value !== (previous?.value ?? '');
    const coverageChanged = mode === INJECTION_MODES.CHECKPOINT_SHORT_HISTORY && (previousMode !== mode
        || JSON.stringify(previous?.blocks) !== JSON.stringify(blocks));
    store.injectionSnapshot = { signature, mode, blocks, value, recentRawFloors: settings.recentRawFloors, historyHandoff, reason: reason === 'manual reinject' ? reason : changed ? reason : previous?.reason ?? reason };
    return { value, changed, ...(coverageChanged ? { coverageChanged: true } : {}), migrated: Boolean(previous && previous.signature !== signature) };
}

export class CacheDiagnostics {
    constructor() {
        this.snapshots = new Map();
        this.histories = new Map();
        this.requests = new Map();
        this.pending = [];
    }
    reset() {
        this.snapshots.clear();
        this.histories.clear();
        this.requests.clear();
        this.clearPending();
    }
    clearPending() { this.pending = []; }

    repeat(key, observation, expectedHash, reason) {
        const previous = this.requests.get(key);
        this.requests.delete(key);
        this.requests.set(key, { observation, expectedHash });
        if (this.requests.size > 48) this.requests.delete(this.requests.keys().next().value);
        if (!previous) return null;
        const publication = previous.expectedHash !== expectedHash ? reason : null;
        const changes = compareRequests(previous.observation, observation);
        return { publication, changes: publication && previous.observation.memory.state === 'match' && observation.memory.state === 'match'
            ? changes.filter(change => change.kind !== 'memory-text-changed') : changes };
    }

    settingsReady(key, body, expected, reference, reason, debug) {
        const observation = debug ? inspectRequest(body, expected) : null;
        const expectedHash = debug && expected !== null ? fingerprint(expected) : null;
        const repeat = observation ? this.repeat(`settings:${key}`, observation, expectedHash, reason) : null;
        const report = observation ? { expectedHash, settingsReady: requestReport(observation), repeat,
            browserFetch: '尚未观察；若绕过 fetch 桥接（如 XHR），此阶段不可验证' } : null;
        this.pending = this.pending.filter(item => Date.now() - item.time < 30_000);
        if (this.pending.length >= 16) this.clearPending();
        else this.pending.push({ key, time: Date.now(), expected, expectedHash, reference, observation, reason, report });
        return report;
    }

    browserRequest(key, body, debug) {
        const matches = this.pending.filter(item => item.key === key && Date.now() - item.time < 30_000);
        this.pending = this.pending.filter(item => item.key !== key);
        const early = matches.length === 1 ? matches[0] : null;
        const observation = debug ? inspectRequest(body, early?.expected ?? null) : null;
        return {
            reference: early?.reference,
            observation,
            early,
            report: observation ? { browserFetch: requestReport(observation),
                sinceSettingsReady: early?.observation ? compareRequests(early.observation, observation) : '缺少可唯一匹配的设置事件',
                browserRepeat: early ? this.repeat(`browser:${key}`, observation, early.expectedHash, early.reason) : null } : null,
        };
    }

    memory(store, settings, floor) {
        const value = store.injectionSnapshot?.value ?? '';
        const hash = fnv1a(value);
        const previous = this.snapshots.get(store.chatId);
        const changed = previous !== undefined && previous !== hash;
        this.snapshots.set(store.chatId, hash);
        return { chatId: store.chatId, floor, injectionMode: effectiveInjectionMode(settings), strictCacheMode: Boolean(freezesInjection(settings)),
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
