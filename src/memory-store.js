import { getAssistantMessages } from './utils.js?v=1.15.1';
import { extractSummaryKeepEntries, normalizeKeepText, parseFactUpdates, projectLongFacts, summaryText } from './continuity.js?v=1.15.1';

export const STORE_VERSION = 4;
const KEEP_STATUSES = new Set(['active', 'resolved', 'superseded', 'invalid']);

export function createEmptyStore(chatId = '') {
    return {
        version: STORE_VERSION,
        chatId: String(chatId ?? ''),
        summaries: {},
        checkpoints: [],
        longMemories: [],
        keepRegistry: {},
        updatedAt: new Date().toISOString(),
    };
}

export function normalizeStore(value, chatId = '') {
    const store = value && typeof value === 'object' ? value : {};
    const summaries = store.summaries && typeof store.summaries === 'object' && !Array.isArray(store.summaries) ? store.summaries : {};
    const checkpoints = Array.isArray(store.checkpoints) ? store.checkpoints : [];
    const longMemories = Array.isArray(store.longMemories) ? store.longMemories : [];
    const keepRegistry = normalizeKeepRegistry(Number(store.version) >= 3 ? store.keepRegistry : null,
        { summaries, checkpoints, longMemories, updatedAt: store.updatedAt });
    return {
        version: STORE_VERSION,
        chatId: String(chatId ?? store.chatId ?? ''),
        summaries,
        checkpoints,
        longMemories,
        keepRegistry,
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
    }

    current() {
        const metadata = this.getMetadata();
        const needsMigration = Number(metadata.cache_memory?.version) < STORE_VERSION || !metadata.cache_memory?.keepRegistry;
        const normalized = normalizeStore(metadata.cache_memory, this.getChatId());
        if (metadata.cache_memory !== normalized) {
            metadata.cache_memory = normalized;
            if (needsMigration) this.saveMetadata();
        }
        return normalized;
    }

    persist(reason = 'history metadata changed') {
        const store = this.current();
        store.updatedAt = new Date().toISOString();
        this.saveMetadata();
        const batch = this.aggregateBatches.get(store.chatId);
        if (batch && ['new checkpoint', 'new long memory', 'aggregate failed'].includes(reason)) {
            if (!batch.reason || reason === 'new long memory' || (batch.reason === 'aggregate failed' && reason === 'new checkpoint')) batch.reason = reason;
        } else this.onChange(store, reason);
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
        const unmatched = new Set(Object.keys(store.summaries));
        let changed = false;

        for (const entry of assistants) {
            const record = store.summaries[entry.messageId];
            if (!record) continue;
            unmatched.delete(entry.messageId);
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
        }

        for (const key of unmatched) {
            const record = store.summaries[key];
            if (record && record.status !== 'orphaned') {
                record.previousStatus = record.status;
                record.status = 'orphaned';
                record.orphanedAt = new Date().toISOString();
                changed = true;
            }
        }

        if (changed) this.persist();
        return assistants;
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
        store.summaries[record.messageId] = structuredClone(record);
        this.registerSummaryKeeps(store.summaries[record.messageId]);
        this.persist(replacesFrozen && !background ? 'manual edit' : 'new summary');
        return store.summaries[record.messageId];
    }

    updateSummary(messageId, updates) {
        const record = this.getSummary(messageId);
        if (!record) return null;
        Object.assign(record, structuredClone(updates), { messageId });
        this.registerSummaryKeeps(record);
        this.persist('manual edit');
        return record;
    }

    deleteSummary(messageId) {
        const store = this.current();
        if (!store.summaries[messageId]) return false;
        delete store.summaries[messageId];
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

    addCheckpoint(record, { overwrite = false } = {}) {
        const store = this.current();
        const index = store.checkpoints.findIndex(item => item.id === record.id);
        const replacesFrozen = index >= 0 && store.checkpoints[index].frozen !== false && store.checkpoints[index].status !== 'failed';
        if (index >= 0 && !overwrite) return store.checkpoints[index];
        if (index >= 0) store.checkpoints[index] = structuredClone(record);
        else store.checkpoints.push(structuredClone(record));
        store.checkpoints.sort((a, b) => a.startFloor - b.startFloor);
        this.persist(record.frozen !== false && record.status !== 'failed' ? (replacesFrozen ? 'manual edit' : 'new checkpoint') : 'aggregate failed');
        return record;
    }

    addLongMemory(record, { overwrite = false } = {}) {
        const store = this.current();
        const index = store.longMemories.findIndex(item => item.id === record.id);
        const replacesFrozen = index >= 0 && store.longMemories[index].frozen !== false && store.longMemories[index].status !== 'failed';
        if (index >= 0 && !overwrite) return store.longMemories[index];
        if (index >= 0) store.longMemories[index] = structuredClone(record);
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
        Object.assign(item, structuredClone(updates), { id });
        if (item.memoryKind === 'facts' && Object.hasOwn(updates, 'content')) {
            const evidence = Object.values(store.summaries).filter(summary => summary.floor >= item.startFloor && summary.floor <= item.endFloor)
                .map(summaryText).join('\n');
            item.factUpdates = parseFactUpdates(item.content, projectLongFacts(store, item.startFloor - 1), evidence);
        }
        this.persist('manual edit');
        return item;
    }

    deleteAggregate(type, id) {
        const store = this.current();
        const key = type === 'long' ? 'longMemories' : 'checkpoints';
        const next = store[key].filter(item => item.id !== id);
        if (next.length === store[key].length) return false;
        store[key] = next;
        this.persist('manual edit');
        return true;
    }

    clearCurrentChat() {
        const chatId = this.getChatId();
        const cleared = createEmptyStore(chatId);
        this.aggregateBatches.delete(String(chatId ?? ''));
        this.getMetadata().cache_memory = cleared;
        this.saveMetadata();
        this.onChange(cleared, 'current chat cleared');
        return cleared;
    }

    replace(imported) {
        const normalized = normalizeStore(structuredClone(imported), this.getChatId());
        this.getMetadata().cache_memory = normalized;
        this.persist('manual edit');
        return normalized;
    }
}
