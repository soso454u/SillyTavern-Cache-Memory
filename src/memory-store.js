import { fnv1a, getAssistantMessages } from './utils.js?v=1.21.0';
import { extractSummaryKeepEntries, normalizeKeepText, parseFactUpdates, projectLongFacts, summaryText } from './continuity.js?v=1.21.0';
import { projectActiveState, stateId, ACTIVE_THREAD_STATUSES, activeStateVersion } from './active-state.js?v=1.21.0';

export const STORE_VERSION = 6;
const KEEP_STATUSES = new Set(['active', 'resolved', 'superseded', 'invalid']);

export function createEmptyStore(chatId = '') {
    return {
        version: STORE_VERSION,
        chatId: String(chatId ?? ''),
        summaries: {},
        checkpoints: [],
        longMemories: [],
        keepRegistry: {},
        stateOverrides: {},
        recovery: {},
        tombstones: {},
        sync: { revision: 0, writerId: '', writeId: '', savedAt: '' },
        updatedAt: new Date().toISOString(),
    };
}

export function normalizeStore(value, chatId = '') {
    if (value != null && (typeof value !== 'object' || Array.isArray(value))) throw new Error('记忆数据格式异常，已停止初始化；原数据未清空');
    const store = value && typeof value === 'object' ? value : {};
    const summaries = store.summaries && typeof store.summaries === 'object' && !Array.isArray(store.summaries) ? store.summaries : {};
    const checkpoints = Array.isArray(store.checkpoints) ? store.checkpoints : [];
    const longMemories = Array.isArray(store.longMemories) ? store.longMemories : [];
    const keepRegistry = normalizeKeepRegistry(Number(store.version) >= 3 ? store.keepRegistry : null,
        { summaries, checkpoints, longMemories, updatedAt: store.updatedAt });
    return {
        ...store,
        version: Math.max(STORE_VERSION, Number(store.version) || 0),
        chatId: String(chatId ?? store.chatId ?? ''),
        summaries,
        checkpoints,
        longMemories,
        keepRegistry,
        stateOverrides: store.stateOverrides && typeof store.stateOverrides === 'object' ? store.stateOverrides : {},
        recovery: {
            ...(store.version && Number(store.version) < STORE_VERSION ? { [`migration-v${store.version}`]: { kind: 'migration', snapshot: structuredClone(store) } } : {}),
            ...(store.recovery ?? {}),
        },
        tombstones: store.tombstones ?? {},
        sync: {
            revision: Math.max(0, Math.floor(Number(store.sync?.revision) || 0)),
            writerId: String(store.sync?.writerId ?? ''),
            writeId: String(store.sync?.writeId ?? ''),
            savedAt: String(store.sync?.savedAt ?? ''),
        },
        ...(store.injectionSnapshot && typeof store.injectionSnapshot.value === 'string' && Array.isArray(store.injectionSnapshot.blocks) ? { injectionSnapshot: store.injectionSnapshot } : {}),
        updatedAt: store.updatedAt ?? new Date().toISOString(),
    };
}

function normalizedKeepRecord(item, id, fallbackTime) {
    const now = fallbackTime ?? new Date().toISOString();
    return {
        text: String(item?.text ?? '').trim(),
        sourceFloor: Number(item?.sourceFloor ?? item?.floor) || 0,
        sourceId: String(item?.sourceId ?? ''),
        sourceStoryTime: String(item?.sourceStoryTime ?? ''),
        sourceLocation: String(item?.sourceLocation ?? ''),
        resolvedStoryTime: String(item?.resolvedStoryTime ?? ''),
        status: KEEP_STATUSES.has(item?.status) ? item.status : 'active',
        reason: String(item?.reason ?? ''),
        evidence: String(item?.evidence ?? ''),
        createdAt: item?.createdAt ?? now,
        updatedAt: item?.updatedAt ?? item?.createdAt ?? now,
        replacedBy: String(item?.replacedBy ?? ''),
    };
}

function nextKeepId(registry) {
    const maximum = Object.keys(registry).reduce((current, id) => Math.max(current, Number(String(id).match(/^KEEP-(\d+)$/i)?.[1]) || 0), 0);
    return `KEEP-${String(maximum + 1).padStart(4, '0')}`;
}

function normalizeKeepRegistry(registry, legacy) {
    if (registry && typeof registry === 'object' && !Array.isArray(registry)) {
        const fields = ['text', 'sourceFloor', 'sourceId', 'sourceStoryTime', 'sourceLocation', 'resolvedStoryTime', 'status', 'reason', 'evidence', 'createdAt', 'updatedAt', 'replacedBy'];
        const alreadyNormalized = Object.entries(registry).every(([id, item]) => id === id.toUpperCase()
            && item && typeof item === 'object' && fields.every(field => Object.hasOwn(item, field)) && KEEP_STATUSES.has(item.status));
        if (alreadyNormalized) return registry;
        return Object.fromEntries(Object.entries(registry).map(([id, item]) => [String(id).toUpperCase(), normalizedKeepRecord(item, id, legacy.updatedAt)]));
    }
    const migrated = {};
    const identities = new Map();
    const remember = (item, identity) => {
        if (!item?.text) return;
        const existingId = identities.get(identity);
        if (existingId) {
            const existing = migrated[existingId];
            if (KEEP_STATUSES.has(item.status)) Object.assign(existing, {
                status: item.status,
                reason: String(item.reason ?? existing.reason ?? ''),
                evidence: String(item.evidence ?? existing.evidence ?? ''),
                replacedBy: String(item.replacedBy ?? existing.replacedBy ?? ''),
                updatedAt: item.updatedAt ?? item.createdAt ?? existing.updatedAt,
            });
            return;
        }
        const id = nextKeepId(migrated);
        identities.set(identity, id);
        migrated[id] = normalizedKeepRecord(item, id, legacy.updatedAt);
    };
    // Old checkpoint/long-memory snapshots already contain the plugin's legacy
    // identity and status. Collapse repeated snapshots by that identity only.
    for (const aggregate of [...legacy.checkpoints, ...legacy.longMemories]) {
        for (const item of aggregate?.keepItems ?? []) {
            const identity = item.id ? `id:${String(item.id).toLowerCase()}` : `snapshot:${aggregate.id}:${normalizeKeepText(item.text)}`;
            remember(item, identity);
        }
    }
    // Add explicit Summary [KEEP] entries that never reached an aggregate.
    for (const summary of Object.values(legacy.summaries).sort((a, b) => (a.floor ?? 0) - (b.floor ?? 0))) {
        for (const text of extractSummaryKeepEntries(summary)) {
            const normalized = normalizeKeepText(text);
            const existing = Object.values(migrated).find(item => normalizeKeepText(item.text) === normalized);
            if (existing) {
                if (!existing.sourceFloor) existing.sourceFloor = Number(summary.floor) || 0;
                if (!existing.sourceId) existing.sourceId = String(summary.messageId ?? '');
                continue;
            }
            remember({ text, sourceFloor: summary.floor, sourceId: summary.messageId, sourceStoryTime: summary.storyTime,
                sourceLocation: summary.location, status: 'active', createdAt: summary.createdAt }, `summary:${summary.messageId}:${normalized}`);
        }
    }
    return migrated;
}

export class MemoryStore {
    constructor({ getMetadata, getChatId, saveMetadata, onChange = () => {} }) {
        this.getMetadata = getMetadata;
        this.getChatId = getChatId;
        this.saveMetadata = saveMetadata;
        this.onChange = onChange;
        this.aggregateBatches = new Map();
        this.pendingMigrations = new Set();
    }

    current() {
        const metadata = this.getMetadata();
        const needsMigration = Number(metadata.cache_memory?.version) < STORE_VERSION || !metadata.cache_memory?.keepRegistry;
        const normalized = normalizeStore(metadata.cache_memory, this.getChatId());
        if (metadata.cache_memory !== normalized) {
            metadata.cache_memory = normalized;
            if (needsMigration) this.pendingMigrations.add(normalized.chatId);
        }
        return normalized;
    }

    persistMigration() {
        const store = this.current();
        if (!this.pendingMigrations.delete(store.chatId)) return false;
        this.persist('store migration');
        return true;
    }

    persist(reason = 'history metadata changed', { notify = true } = {}) {
        if (this.maintenanceDepth && ['new checkpoint', 'new long memory', 'manual edit', 'aggregate failed'].includes(reason)) reason = 'memory maintenance';
        const store = this.current();
        if (['memory maintenance', 'memory import', 'state management'].includes(reason) && store.injectionSnapshot) store.injectionSnapshot.needsRebuild = true;
        store.updatedAt = new Date().toISOString();
        this.saveMetadata(store, reason);
        const batch = this.aggregateBatches.get(store.chatId);
        if (batch && ['new checkpoint', 'new long memory', 'aggregate failed'].includes(reason)) {
            if (!batch.reason || reason === 'new long memory' || (batch.reason === 'aggregate failed' && reason === 'new checkpoint')) batch.reason = reason;
        } else if (notify) this.onChange(store, reason);
        return store;
    }

    async withAggregateBatch(callback) {
        const chatId = this.current().chatId;
        const batch = this.aggregateBatches.get(chatId) ?? { depth: 0, reason: null };
        batch.depth++;
        this.aggregateBatches.set(chatId, batch);
        try { return await callback(); }
        finally {
            if (--batch.depth === 0) {
                this.aggregateBatches.delete(chatId);
                if (batch.reason && this.current().chatId === chatId) this.onChange(this.current(), batch.reason);
            }
        }
    }

    syncMessages(chat) {
        const store = this.current();
        const assistants = getAssistantMessages(chat);
        let changed = false;
        const matched = new Set();

        for (const entry of assistants) {
            let record = store.summaries[entry.messageId];
            let recordKey = entry.messageId;
            if (!record && entry.fingerprint) {
                const matches = Object.entries(store.summaries).filter(([key, candidate]) => !matched.has(key) && candidate?.sourceFingerprint === entry.fingerprint);
                const match = matches.length === 1 ? matches[0] : null;
                if (match) {
                    recordKey = match[0];
                    record = match[1];
                    delete store.summaries[recordKey];
                    store.summaries[entry.messageId] = record;
                    for (const keep of Object.values(store.keepRegistry)) if (keep.sourceId === recordKey) keep.sourceId = entry.messageId;
                    for (const aggregate of [...store.checkpoints, ...store.longMemories]) {
                        if (aggregate.sourceVersions?.[recordKey]) { aggregate.sourceVersions[entry.messageId] = aggregate.sourceVersions[recordKey]; delete aggregate.sourceVersions[recordKey]; }
                        if (aggregate.summaryIds) aggregate.summaryIds = aggregate.summaryIds.map(id => id === recordKey ? entry.messageId : id);
                    }
                    for (const override of Object.values(store.stateOverrides)) if (override.sourceId === recordKey) override.sourceId = entry.messageId;
                    changed = true;
                }
            }
            if (!record) continue;
            matched.add(entry.messageId);
            const validity = record.sourceFingerprint ? (record.sourceFingerprint === entry.fingerprint ? 'valid' : 'changed') : 'unverified';
            if (record.sourceValidity !== validity) { record.sourceValidity = validity; changed = true; }
            if (record.floor !== entry.floor || record.messageIndex !== entry.messageIndex || record.messageId !== entry.messageId) {
                for (const keep of Object.values(store.keepRegistry)) if (keep.sourceId === record.messageId) keep.sourceFloor = entry.floor;
                record.floor = entry.floor;
                record.messageIndex = entry.messageIndex;
                record.messageId = entry.messageId;
                changed = true;
            }
            if (record.sourceFingerprint && record.sourceFingerprint !== entry.fingerprint && record.status !== 'stale') {
                record.status = 'stale';
                record.staleAt = new Date().toISOString();
                changed = true;
            }
            if (['orphaned', 'stale'].includes(record.status) && record.sourceFingerprint === entry.fingerprint) {
                record.status = record.previousStatus && record.previousStatus !== 'orphaned' ? record.previousStatus : 'frozen';
                delete record.previousStatus;
                delete record.orphanedAt;
                changed = true;
            }
        }

        for (const [id, record] of Object.entries(store.summaries)) {
            if (!matched.has(id) && record.sourceValidity !== 'unmatched') { record.sourceValidity = 'unmatched'; changed = true; }
        }
        if (assistants.length) changed = this.validateDependencies(store) || changed;

        // A chat array may be temporarily incomplete while SillyTavern is loading.
        // Unmatched records are kept unchanged; only an explicit deletion event may
        // mark a Summary as orphaned.

        if (changed) this.persist();
        return assistants;
    }

    archive(store, kind, record) {
        if (!record) return;
        const copy = structuredClone(record);
        const id = `${kind}:${fnv1a(JSON.stringify(copy))}`;
        store.recovery[id] = { kind, record: copy };
    }

    validateDependencies(store = this.current()) {
        let changed = false;
        const checkpoints = [...store.checkpoints].sort((a, b) => a.startFloor - b.startFloor);
        for (const aggregate of [...checkpoints, ...store.longMemories].sort((a, b) => a.endFloor - b.endFloor || (store.checkpoints.includes(a) ? -1 : 1))) {
            if (aggregate.status === 'failed') continue;
            const before = JSON.stringify(aggregate);
            const sources = aggregate.sourceVersions;
            const sourceRecords = sources ? Object.keys(sources).map(id => store.summaries[id])
                : Object.values(store.summaries).filter(item => item.floor >= aggregate.startFloor && item.floor <= aggregate.endFloor);
            const dependencyIds = [...(aggregate.checkpointIds ?? []), ...(aggregate.previousCheckpointId ? [aggregate.previousCheckpointId] : [])];
            const dependencies = dependencyIds.map(id => [...checkpoints, ...store.longMemories].find(item => item.id === id));
            const reasons = [];
            if (aggregate.trackedStateVersion && aggregate.trackedStateVersion !== activeStateVersion(store, aggregate.endFloor)) reasons.push('任务或角色状态的人工纠错/来源版本已改变');
            if (sourceRecords.some(item => !item)) reasons.push('来源摘要记录不存在');
            if (sourceRecords.some(item => item?.sourceValidity === 'changed' || ['stale', 'orphaned'].includes(item?.status))) reasons.push('来源消息已改变或删除');
            if (sourceRecords.some(item => item?.status === 'failed')) reasons.push('来源摘要生成失败');
            if (sourceRecords.some(item => ['unmatched', 'unverified'].includes(item?.sourceValidity))) reasons.push('来源消息未加载或缺少指纹，待核对');
            if (sources && Object.entries(sources).some(([id, version]) => store.summaries[id] && !summaryVersionMatches(store.summaries[id], version))) reasons.push('来源摘要版本或校验信息不一致');
            if (sources) for (let floor = aggregate.startFloor; floor <= aggregate.endFloor; floor++) {
                if (!sourceRecords.some(item => item?.floor === floor)) { reasons.push('来源摘要楼层覆盖不完整'); break; }
            }
            if (dependencies.some(item => !item || !summaryIsCurrent(item))) reasons.push('前序或来源 Checkpoint 不存在或需要更新');
            if (aggregate.checkpointVersions && Object.entries(aggregate.checkpointVersions).some(([id, version]) => aggregateVersion([...checkpoints, ...store.longMemories].find(item => item.id === id)) !== version)) reasons.push('前序或来源 Checkpoint 内容版本已改变');
            const provable = Boolean(sources && sourceRecords.length && sourceRecords.every(summaryIsCurrent)
                && (!dependencyIds.length || aggregate.checkpointVersions && dependencyIds.every(id => Object.hasOwn(aggregate.checkpointVersions, id))));
            if (reasons.length) {
                if (aggregate.status !== 'stale') aggregate.previousStatus = aggregate.status ?? 'frozen';
                aggregate.status = 'stale'; aggregate.staleReason = reasons.join('；');
                aggregate.sourceValidity = reasons.some(reason => /未加载|缺少指纹/.test(reason)) ? 'unmatched' : 'changed';
            } else if (aggregate.status === 'stale' && provable) {
                aggregate.status = aggregate.previousStatus === 'manual-edited' || aggregate.manualEdited ? 'manual-edited' : 'frozen';
                delete aggregate.previousStatus; delete aggregate.staleReason;
                aggregate.sourceValidity = 'valid';
            } else if (aggregate.status === 'stale') {
                aggregate.sourceValidity = 'unverified'; aggregate.staleReason = '旧版本缺少完整来源/前序校验信息，无法证明一致；原内容保留';
            } else if (aggregate.sourceValidity === 'unmatched' && provable) aggregate.sourceValidity = 'valid';
            if (JSON.stringify(aggregate) !== before) changed = true;
        }
        return changed;
    }

    revalidate(chat) {
        this.syncMessages(chat);
        if (this.validateDependencies()) this.persist('memory maintenance');
        return this.current().checkpoints.filter(item => !summaryIsCurrent(item));
    }

    reconcileDeletion(chat) {
        const ids = new Set(getAssistantMessages(chat).map(item => item.messageId));
        const store = this.current();
        for (const record of Object.values(store.summaries)) {
            if (!ids.has(record.messageId) && record.status !== 'orphaned') {
                record.previousStatus = record.status;
                record.status = 'orphaned'; record.sourceValidity = 'unmatched';
            }
        }
        this.validateDependencies(store);
        this.persist('manual edit');
    }

    markSummaryOrphanedAtMessageIndex(messageIndex) {
        if (!Number.isInteger(Number(messageIndex))) return null;
        const store = this.current();
        const record = Object.values(store.summaries).find(item => Number(item?.messageIndex) === Number(messageIndex));
        if (!record || record.status === 'orphaned') return record ?? null;
        record.previousStatus = record.status;
        record.status = 'orphaned';
        record.orphanedAt = new Date().toISOString();
        this.persist('history metadata changed');
        return record;
    }

    rebindSummaryAtMessageIndex(messageIndex, chat) {
        const assistants = getAssistantMessages(chat);
        const entry = assistants.find(item => item.messageIndex === Number(messageIndex));
        if (!entry) return null;
        const store = this.current();
        if (store.summaries[entry.messageId]) return store.summaries[entry.messageId];
        const previousKey = Object.keys(store.summaries).find(key => store.summaries[key]?.messageIndex === Number(messageIndex));
        if (!previousKey) return null;
        const record = store.summaries[previousKey];
        this.archive(store, 'summary', record);
        delete store.summaries[previousKey];
        Object.assign(record, {
            messageId: entry.messageId,
            floor: entry.floor,
            messageIndex: entry.messageIndex,
            status: 'stale',
            staleAt: new Date().toISOString(),
        });
        store.summaries[entry.messageId] = record;
        for (const keep of Object.values(store.keepRegistry)) if (keep.sourceId === previousKey) keep.sourceId = entry.messageId;
        this.persist();
        return record;
    }

    getSummary(messageId) {
        return this.current().summaries[messageId] ?? null;
    }

    addSummary(record, { overwrite = false, background = false } = {}) {
        const store = this.current();
        if (store.summaries[record.messageId] && !overwrite) return store.summaries[record.messageId];
        const replacesFrozen = store.summaries[record.messageId]?.frozen !== false && ['frozen', 'manual-edited'].includes(store.summaries[record.messageId]?.status);
        if (overwrite) this.archive(store, 'summary', store.summaries[record.messageId]);
        delete store.tombstones[`Summary:${record.messageId}`];
        store.summaries[record.messageId] = structuredClone(record);
        this.registerSummaryKeeps(store.summaries[record.messageId]);
        this.validateDependencies(store);
        this.persist(replacesFrozen && !background ? 'manual edit' : 'new summary');
        return store.summaries[record.messageId];
    }

    updateSummary(messageId, updates) {
        const record = this.getSummary(messageId);
        if (!record) return null;
        this.archive(this.current(), 'summary', record);
        Object.assign(record, structuredClone(updates), { messageId });
        this.registerSummaryKeeps(record);
        this.validateDependencies();
        this.persist('manual edit');
        return record;
    }

    deleteSummary(messageId) {
        const store = this.current();
        if (!store.summaries[messageId]) return false;
        this.archive(store, 'summary', store.summaries[messageId]);
        store.tombstones[`Summary:${messageId}`] = { deletedAt: new Date().toISOString() };
        delete store.summaries[messageId];
        this.validateDependencies(store);
        this.persist('manual edit');
        return true;
    }

    reparseStructuredSummaries(parser) {
        const store = this.current();
        let updated = 0;
        for (const record of Object.values(store.summaries)) {
            if (!record?.raw || (record.format !== 'structured' && !/^\s*\[SUMMARY\]/im.test(record.raw))) continue;
            const parsed = parser(record.raw);
            if (!parsed || parsed.format !== 'structured') continue;
            Object.assign(record, parsed);
            this.registerSummaryKeeps(record);
            updated++;
        }
        if (updated) this.persist('summary reparse');
        return updated;
    }

    registerSummaryKeeps(record) {
        const store = this.current();
        const existing = new Set(Object.values(store.keepRegistry).map(item => normalizeKeepText(item.text)).filter(Boolean));
        for (const text of extractSummaryKeepEntries(record)) {
            const normalized = normalizeKeepText(text);
            if (!normalized || existing.has(normalized)) continue;
            const id = nextKeepId(store.keepRegistry);
            const now = new Date().toISOString();
            store.keepRegistry[id] = normalizedKeepRecord({
                text, sourceFloor: record.floor, sourceId: record.messageId, sourceStoryTime: record.storyTime,
                sourceLocation: record.location, status: 'active', createdAt: now, updatedAt: now,
            }, id, now);
            existing.add(normalized);
        }
    }

    editTrackedState(updates) {
        const store = this.current();
        const existing = projectActiveState(store).find(item => item.id === updates.id);
        const source = Object.values(store.summaries).find(item => item.floor === Number(updates.sourceFloor) && summaryIsCurrent(item));
        if (!source) throw new Error('请选择具有有效摘要的来源楼层；来源被编辑时先核对摘要');
        const item = { ...existing, ...structuredClone(updates), entity: String(updates.entity ?? existing?.entity ?? '').trim(), key: String(updates.key ?? existing?.key ?? '').trim() };
        if (!item.entity || !item.key || !String(item.value ?? '').trim()) throw new Error('人物身份、事项/技能名称和当前进度/数值不能为空');
        if (!['thread', 'state'].includes(item.kind)) throw new Error('未知状态类型');
        const allowed = item.kind === 'thread' ? [...ACTIVE_THREAD_STATUSES, 'completed', 'failed', 'cancelled'] : ['active', 'expired'];
        if (!allowed.includes(item.status)) throw new Error('未知事项状态');
        item.id = existing?.id ?? stateId(item);
        item.sourceId = source.messageId; item.sourceFingerprint = source.sourceFingerprint;
        item.originSourceId = source.messageId; // Explicit correction re-anchors reviewed evidence.
        item.manual = true; item.evidence = '用户手动确认';
        item.sequence = Math.max(0, ...Object.values(store.stateOverrides).map(row => Number(row.sequence) || 0)) + 1;
        delete item.history;
        store.stateOverrides[`${item.id}:${item.sequence}`] = item;
        for (const aggregate of [...store.checkpoints, ...store.longMemories]) if (aggregate.endFloor >= source.floor && !aggregate.trackedStateVersion) aggregate.trackedStateVersion = 'unverified-before-correction';
        this.validateDependencies(store);
        this.persist('state management');
        return item;
    }

    updateKeep(id, updates, { persist = true } = {}) {
        const store = this.current();
        const key = String(id).toUpperCase();
        const record = store.keepRegistry[key];
        if (!record) return null;
        const allowed = ['text', 'status', 'reason', 'evidence', 'replacedBy', 'resolvedStoryTime'];
        for (const field of allowed) if (Object.hasOwn(updates, field)) record[field] = String(updates[field] ?? '').trim();
        if (!KEEP_STATUSES.has(record.status)) record.status = 'active';
        record.updatedAt = new Date().toISOString();
        if (persist) this.persist('manual edit');
        return { ...record, id: key };
    }

    applyKeepItems(items, { persist = true } = {}) {
        const store = this.current();
        let changed = 0;
        for (const item of items) {
            const key = String(item.id).toUpperCase();
            const current = store.keepRegistry[key];
            if (!current || !KEEP_STATUSES.has(item.status)) continue;
            if (['status', 'reason', 'evidence', 'replacedBy', 'resolvedStoryTime'].some(field => String(current[field] ?? '') !== String(item[field] ?? ''))) {
                Object.assign(current, { status: item.status, reason: item.reason ?? '', evidence: item.evidence ?? '', replacedBy: item.replacedBy ?? '',
                    resolvedStoryTime: item.resolvedStoryTime ?? '', updatedAt: item.updatedAt ?? new Date().toISOString() });
                changed++;
            }
        }
        if (changed && persist) this.persist('keep lifecycle');
        return changed;
    }

    setKeepStatus(ids, status, details = {}) {
        if (!KEEP_STATUSES.has(status)) throw new Error('未知 KEEP 状态');
        const store = this.current();
        let changed = 0;
        for (const id of ids) {
            const record = store.keepRegistry[String(id).toUpperCase()];
            if (!record) continue;
            Object.assign(record, {
                status,
                reason: status === 'active' ? '' : String(details.reason ?? record.reason ?? ''),
                evidence: status === 'active' ? '' : String(details.evidence ?? record.evidence ?? ''),
                replacedBy: status === 'active' ? '' : String(details.replacedBy ?? record.replacedBy ?? ''),
                resolvedStoryTime: status === 'active' ? '' : String(details.resolvedStoryTime ?? record.resolvedStoryTime ?? ''),
                updatedAt: new Date().toISOString(),
            });
            changed++;
        }
        if (changed) this.persist('manual edit');
        return changed;
    }

    organizeKeepRegistry() {
        const store = this.current();
        const groups = new Map();
        let normalized = 0;
        let duplicates = 0;
        for (const [id, record] of Object.entries(store.keepRegistry)) {
            const text = normalizeKeepText(record.text);
            if (text !== record.text) { record.text = text; normalized++; }
            if (!text) {
                record.status = 'invalid';
                record.reason = '本地整理：空白 KEEP';
                record.updatedAt = new Date().toISOString();
                duplicates++;
                continue;
            }
            const group = groups.get(text) ?? [];
            group.push(id);
            groups.set(text, group);
        }
        const priority = { active: 0, resolved: 1, superseded: 2, invalid: 3 };
        for (const ids of groups.values()) {
            if (ids.length < 2) continue;
            ids.sort((left, right) => (priority[store.keepRegistry[left].status] ?? 9) - (priority[store.keepRegistry[right].status] ?? 9)
                || (Number(left.match(/\d+/)?.[0]) || 0) - (Number(right.match(/\d+/)?.[0]) || 0));
            const first = ids[0];
            for (const id of ids.slice(1)) {
                const record = store.keepRegistry[id];
                if (record.status === 'invalid' && record.replacedBy === first) continue;
                record.status = 'invalid';
                record.reason = `本地整理：与 ${first} 完全重复`;
                record.evidence = '';
                record.replacedBy = first;
                record.updatedAt = new Date().toISOString();
                duplicates++;
            }
        }
        if (normalized || duplicates) this.persist('manual edit');
        return { normalized, duplicates, total: Object.keys(store.keepRegistry).length };
    }

    invalidateCheckpointDependents(id, store = this.current()) {
        const changedIds = new Set([id]);
        for (const cp of [...store.checkpoints].sort((a, b) => a.startFloor - b.startFloor)) if (changedIds.has(cp.previousCheckpointId)) {
            cp.status = 'stale'; cp.staleReason = '前序 Checkpoint 内容已更新'; changedIds.add(cp.id);
        }
        for (const memory of store.longMemories) if (memory.checkpointIds?.some(key => changedIds.has(key))) {
            memory.status = 'stale'; memory.staleReason = '来源 Checkpoint 内容已更新';
        }
    }

    addCheckpoint(record, { overwrite = false } = {}) {
        const store = this.current();
        const index = store.checkpoints.findIndex(item => item.id === record.id);
        const replacesFrozen = index >= 0 && store.checkpoints[index].frozen !== false && store.checkpoints[index].status !== 'failed';
        if (index >= 0 && !overwrite) return store.checkpoints[index];
        if (index >= 0 && aggregateVersion(store.checkpoints[index]) !== aggregateVersion(record)) this.invalidateCheckpointDependents(record.id, store);
        if (index >= 0) { this.archive(store, 'checkpoint', store.checkpoints[index]); store.checkpoints[index] = structuredClone(record); }
        else store.checkpoints.push(structuredClone(record));
        delete store.tombstones[`Checkpoint:${record.id}`];
        store.checkpoints.sort((a, b) => a.startFloor - b.startFloor);
        this.validateDependencies(store);
        this.persist(record.frozen !== false && record.status !== 'failed' ? (replacesFrozen ? 'manual edit' : 'new checkpoint') : 'aggregate failed');
        return record;
    }

    addLongMemory(record, { overwrite = false } = {}) {
        const store = this.current();
        const index = store.longMemories.findIndex(item => item.id === record.id);
        const replacesFrozen = index >= 0 && store.longMemories[index].frozen !== false && store.longMemories[index].status !== 'failed';
        if (index >= 0 && !overwrite) return store.longMemories[index];
        if (index >= 0) { this.archive(store, 'long', store.longMemories[index]); store.longMemories[index] = structuredClone(record); }
        else store.longMemories.push(structuredClone(record));
        store.longMemories.sort((a, b) => a.startFloor - b.startFloor);
        this.persist(record.frozen !== false && record.status !== 'failed' ? (replacesFrozen ? 'manual edit' : 'new long memory') : 'aggregate failed');
        return record;
    }

    updateFact(id, text) {
        const store = this.current();
        const key = String(id ?? '');
        const value = String(text ?? '').trim();
        if (!key || !value) return null;
        for (const memory of store.longMemories) {
            const update = memory.factUpdates?.find(item => item.id === key && item.action !== 'retire');
            if (!update) continue;
            const previousText = String(update.text ?? '');
            update.text = value;
            if (previousText && String(memory.content ?? '').includes(previousText)) {
                memory.content = memory.content.replace(previousText, value);
            }
            Object.assign(memory, {
                manualEdited: true,
                frozen: true,
                status: 'manual-edited',
                editedAt: new Date().toISOString(),
            });
            this.persist('manual edit');
            return { ...update };
        }
        return null;
    }

    updateAggregate(type, id, updates) {
        const store = this.current();
        const list = type === 'long' ? store.longMemories : store.checkpoints;
        const item = list.find(entry => entry.id === id);
        if (!item) return null;
        this.archive(store, type, item);
        if (type !== 'long' && updates.content !== undefined && updates.content !== item.content) this.invalidateCheckpointDependents(id, store);
        Object.assign(item, structuredClone(updates), { id });
        if (item.memoryKind === 'facts' && Object.hasOwn(updates, 'content')) {
            const evidence = Object.values(store.summaries).filter(summary => summary.floor >= item.startFloor && summary.floor <= item.endFloor)
                .map(summaryText).join('\n');
            item.factUpdates = parseFactUpdates(item.content, projectLongFacts(store, item.startFloor - 1), evidence);
        }
        this.validateDependencies(store);
        this.persist('manual edit');
        return item;
    }

    deleteAggregate(type, id) {
        const store = this.current();
        const key = type === 'long' ? 'longMemories' : 'checkpoints';
        const next = store[key].filter(item => item.id !== id);
        if (next.length === store[key].length) return false;
        this.archive(store, type, store[key].find(item => item.id === id));
        store.tombstones[`${type === 'long' ? 'Long Memory' : 'Checkpoint'}:${id}`] = { deletedAt: new Date().toISOString() };
        store[key] = next;
        this.validateDependencies(store);
        this.persist('manual edit');
        return true;
    }

    clearCurrentChat() {
        const chatId = this.getChatId();
        const previous = this.current();
        const cleared = createEmptyStore(chatId);
        cleared.recovery = { ...previous.recovery, [`cleared:${memoryContentDigest(previous)}`]: { kind: 'clear-backup', snapshot: structuredClone(previous) } };
        cleared.tombstones = { ...previous.tombstones };
        for (const [type, ids] of [['Summary', Object.keys(previous.summaries)], ['Checkpoint', previous.checkpoints.map(item => item.id)], ['Long Memory', previous.longMemories.map(item => item.id)], ['KEEP', Object.keys(previous.keepRegistry)], ['stateOverrides', Object.keys(previous.stateOverrides)]]) {
            for (const id of ids) cleared.tombstones[`${type}:${id}`] = { deletedAt: new Date().toISOString() };
        }
        this.aggregateBatches.delete(String(chatId ?? ''));
        this.getMetadata().cache_memory = cleared;
        this.saveMetadata(cleared, 'current chat cleared');
        this.onChange(cleared, 'current chat cleared');
        return cleared;
    }

    replace(imported, reason = 'memory import') {
        const normalized = normalizeStore(structuredClone(imported), this.getChatId());
        this.getMetadata().cache_memory = normalized;
        this.validateDependencies(normalized);
        this.persist(reason);
        return normalized;
    }

    merge(imported) {
        const current = this.current();
        const result = mergeMemoryStores(current, imported, current.chatId);
        for (const conflict of result.conflicts) this.archive(result.merged, `import-${conflict.type}`, conflict.incoming);
        this.getMetadata().cache_memory = result.merged;
        if (result.added.total || result.conflicts.length) this.persist('manual edit');
        return result;
    }
}

export const summaryIsCurrent = item => item && !['stale', 'orphaned', 'failed'].includes(item.status)
    && !['changed', 'unmatched', 'unverified'].includes(item.sourceValidity);
const summaryFields = item => [item?.sourceFingerprint, item?.raw, item?.event, item?.state, item?.open, item?.stateChanges, item?.keep];
export const summaryVersion = item => `s2:${fnv1a(JSON.stringify(stableClone([...summaryFields(item), item?.floor, item?.title, item?.characters, item?.storyTime, item?.location])))}`;
export const summaryVersionMatches = (item, version) => summaryVersion(item) === version || (!String(version).startsWith('s2:') && fnv1a(JSON.stringify(summaryFields(item))) === version);
export const aggregateVersion = item => item ? fnv1a(JSON.stringify(stableClone([item.id, item.startFloor, item.endFloor, item.content, item.factUpdates, item.continuityState]))) : '';
export function memoryHealth(item) {
    if (!item) return { code: 'missing', label: '尚未生成 / 记录不存在（先读取服务器或检查恢复副本）' };
    if (item.status === 'failed') return { code: 'failed', label: `生成失败：${item.error || '未提供错误'}` };
    if (item.status === 'orphaned') return { code: 'orphaned', label: '来源消息已明确删除，原记录保留' };
    if (item.status === 'stale') return { code: 'stale', label: `已生成但需要更新：${item.staleReason || '来源消息或版本已改变'}` };
    if (['unmatched', 'unverified', 'changed'].includes(item.sourceValidity)) return { code: item.sourceValidity, label: item.sourceValidity === 'unmatched' ? '来源消息当前未加载，待核对' : item.sourceValidity === 'unverified' ? '版本或校验信息缺失，待核对' : '来源消息已改变' };
    return { code: 'valid', label: item.sourceValidity === 'valid' || item.sourceVersions ? '已验证有效 / 已冻结' : '已冻结（旧版未记录完整校验）' };
}

const VOLATILE_RECORD_FIELDS = new Set(['createdAt', 'updatedAt', 'editedAt', 'staleAt', 'orphanedAt', 'sourceValidity']);

function stableClone(value, { omitVolatile = false } = {}) {
    if (Array.isArray(value)) return value.map(item => stableClone(item, { omitVolatile }));
    if (!value || typeof value !== 'object') return value;
    return Object.fromEntries(Object.keys(value).filter(key => !omitVolatile || !VOLATILE_RECORD_FIELDS.has(key)).sort()
        .map(key => [key, stableClone(value[key], { omitVolatile })]));
}

export function memoryContentDigest(value) {
    const store = value && typeof value === 'object' ? value : {};
    const serialized = JSON.stringify(stableClone({
        summaries: store.summaries ?? {},
        checkpoints: [...(store.checkpoints ?? [])].sort((a, b) => String(a.id).localeCompare(String(b.id))),
        longMemories: [...(store.longMemories ?? [])].sort((a, b) => String(a.id).localeCompare(String(b.id))),
        keepRegistry: store.keepRegistry ?? {},
        stateOverrides: store.stateOverrides ?? {},
        recovery: store.recovery ?? {},
        tombstones: store.tombstones ?? {},
        injectionSnapshot: store.injectionSnapshot ?? null,
    }));
    return `${serialized.length}:${fnv1a(serialized)}`;
}

function sameRecord(left, right) {
    return JSON.stringify(stableClone(left, { omitVolatile: true })) === JSON.stringify(stableClone(right, { omitVolatile: true }));
}

export function mergeMemoryStores(currentValue, importedValue, chatId = '') {
    const current = normalizeStore(structuredClone(currentValue), chatId);
    const imported = normalizeStore(structuredClone(importedValue), chatId);
    const merged = structuredClone(current);
    merged.tombstones = { ...imported.tombstones, ...current.tombstones };
    let conflicts = [];
    const added = { summaries: 0, checkpoints: 0, longMemories: 0, keeps: 0, stateOverrides: 0, recovery: 0, total: 0 };

    const summaryIds = new Map(Object.entries(merged.summaries).map(([key, item]) => [String(item?.messageId || key), key]));
    for (const [sourceKey, item] of Object.entries(imported.summaries)) {
        const id = String(item?.messageId || sourceKey);
        const existingKey = summaryIds.get(id);
        if (!existingKey) {
            merged.summaries[id] = structuredClone({ ...item, messageId: id });
            summaryIds.set(id, id);
            added.summaries++;
        } else if (!sameRecord(merged.summaries[existingKey], item)) {
            conflicts.push({ type: 'Summary', id, current: structuredClone(merged.summaries[existingKey]), incoming: structuredClone(item) });
        }
    }

    const mergeList = (key, label, counter) => {
        const byId = new Map(merged[key].map(item => [String(item.id), item]));
        for (const item of imported[key]) {
            const id = String(item?.id ?? '');
            if (!id) continue;
            const existing = byId.get(id);
            if (!existing) {
                const copy = structuredClone(item);
                merged[key].push(copy);
                byId.set(id, copy);
                added[counter]++;
            } else if (!sameRecord(existing, item)) conflicts.push({ type: label, id, current: structuredClone(existing), incoming: structuredClone(item) });
        }
    };
    mergeList('checkpoints', 'Checkpoint', 'checkpoints');
    mergeList('longMemories', 'Long Memory', 'longMemories');
    merged.checkpoints.sort((a, b) => (a.startFloor ?? 0) - (b.startFloor ?? 0));
    merged.longMemories.sort((a, b) => (a.startFloor ?? 0) - (b.startFloor ?? 0));

    for (const [sourceId, item] of Object.entries(imported.keepRegistry)) {
        const id = String(sourceId).toUpperCase();
        const existing = merged.keepRegistry[id];
        if (!existing) {
            merged.keepRegistry[id] = structuredClone(item);
            added.keeps++;
        } else if (!sameRecord(existing, item)) conflicts.push({ type: 'KEEP', id, current: structuredClone(existing), incoming: structuredClone(item) });
    }
    for (const section of ['stateOverrides', 'recovery']) {
        for (const [id, item] of Object.entries(imported[section])) {
            if (!merged[section][id]) { merged[section][id] = structuredClone(item); added[section]++; }
            else if (!sameRecord(merged[section][id], item)) conflicts.push({ type: section, id, current: structuredClone(merged[section][id]), incoming: structuredClone(item) });
        }
    }
    applyMemoryTombstones(merged);
    conflicts = conflicts.filter(row => !merged.tombstones[`${row.type}:${row.id}`]);
    added.total = added.summaries + added.checkpoints + added.longMemories + added.keeps + added.stateOverrides + added.recovery;
    merged.updatedAt = new Date().toISOString();
    return { merged, conflicts, added };
}

export function applyMemoryTombstones(store) {
    for (const key of Object.keys(store.tombstones ?? {})) {
        const colon = key.indexOf(':'), type = key.slice(0, colon), id = key.slice(colon + 1);
        const section = { Summary: 'summaries', Checkpoint: 'checkpoints', 'Long Memory': 'longMemories', KEEP: 'keepRegistry', stateOverrides: 'stateOverrides' }[type];
        if (!section) continue;
        const list = Array.isArray(store[section]);
        const record = list ? store[section].find(item => item.id === id) : store[section][id];
        if (record) store.recovery[`deleted:${key}:${fnv1a(JSON.stringify(record))}`] = { kind: 'deleted-merge', record };
        if (list) store[section] = store[section].filter(item => item.id !== id); else delete store[section][id];
    }
    return store;
}
