import { getAssistantMessages } from './utils.js?v=1.6.0';
import { parseFactUpdates, projectLongFacts, summaryText } from './continuity.js?v=1.6.0';

export const STORE_VERSION = 2;

export function createEmptyStore(chatId = '') {
    return {
        version: STORE_VERSION,
        chatId: String(chatId ?? ''),
        summaries: {},
        checkpoints: [],
        longMemories: [],
        updatedAt: new Date().toISOString(),
    };
}

export function normalizeStore(value, chatId = '') {
    const store = value && typeof value === 'object' ? value : {};
    return {
        version: STORE_VERSION,
        chatId: String(chatId ?? store.chatId ?? ''),
        summaries: store.summaries && typeof store.summaries === 'object' && !Array.isArray(store.summaries)
            ? store.summaries
            : {},
        checkpoints: Array.isArray(store.checkpoints) ? store.checkpoints : [],
        longMemories: Array.isArray(store.longMemories) ? store.longMemories : [],
        ...(store.injectionSnapshot && typeof store.injectionSnapshot.value === 'string' && Array.isArray(store.injectionSnapshot.blocks) ? { injectionSnapshot: store.injectionSnapshot } : {}),
        updatedAt: store.updatedAt ?? new Date().toISOString(),
    };
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
        const normalized = normalizeStore(metadata.cache_memory, this.getChatId());
        if (metadata.cache_memory !== normalized) metadata.cache_memory = normalized;
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
        this.persist(replacesFrozen && !background ? 'manual edit' : 'new summary');
        return store.summaries[record.messageId];
    }

    updateSummary(messageId, updates) {
        const record = this.getSummary(messageId);
        if (!record) return null;
        Object.assign(record, structuredClone(updates), { messageId });
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

    replace(imported) {
        const normalized = normalizeStore(structuredClone(imported), this.getChatId());
        this.getMetadata().cache_memory = normalized;
        this.persist('manual edit');
        return normalized;
    }
}
