import { getAssistantMessages } from './utils.js?v=1.3.2';

export const STORE_VERSION = 1;

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
        updatedAt: store.updatedAt ?? new Date().toISOString(),
    };
}

export class MemoryStore {
    constructor({ getMetadata, getChatId, saveMetadata, onChange = () => {} }) {
        this.getMetadata = getMetadata;
        this.getChatId = getChatId;
        this.saveMetadata = saveMetadata;
        this.onChange = onChange;
    }

    current() {
        const metadata = this.getMetadata();
        const normalized = normalizeStore(metadata.cache_memory, this.getChatId());
        if (metadata.cache_memory !== normalized) metadata.cache_memory = normalized;
        return normalized;
    }

    persist() {
        const store = this.current();
        store.updatedAt = new Date().toISOString();
        this.saveMetadata();
        this.onChange(store);
        return store;
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

    addSummary(record, { overwrite = false } = {}) {
        const store = this.current();
        if (store.summaries[record.messageId] && !overwrite) return store.summaries[record.messageId];
        store.summaries[record.messageId] = structuredClone(record);
        this.persist();
        return store.summaries[record.messageId];
    }

    updateSummary(messageId, updates) {
        const record = this.getSummary(messageId);
        if (!record) return null;
        Object.assign(record, structuredClone(updates), { messageId });
        this.persist();
        return record;
    }

    deleteSummary(messageId) {
        const store = this.current();
        if (!store.summaries[messageId]) return false;
        delete store.summaries[messageId];
        this.persist();
        return true;
    }

    addCheckpoint(record, { overwrite = false } = {}) {
        const store = this.current();
        const index = store.checkpoints.findIndex(item => item.id === record.id);
        if (index >= 0 && !overwrite) return store.checkpoints[index];
        if (index >= 0) store.checkpoints[index] = structuredClone(record);
        else store.checkpoints.push(structuredClone(record));
        store.checkpoints.sort((a, b) => a.startFloor - b.startFloor);
        this.persist();
        return record;
    }

    addLongMemory(record, { overwrite = false } = {}) {
        const store = this.current();
        const index = store.longMemories.findIndex(item => item.id === record.id);
        if (index >= 0 && !overwrite) return store.longMemories[index];
        if (index >= 0) store.longMemories[index] = structuredClone(record);
        else store.longMemories.push(structuredClone(record));
        store.longMemories.sort((a, b) => a.startFloor - b.startFloor);
        this.persist();
        return record;
    }

    updateAggregate(type, id, updates) {
        const list = type === 'long' ? this.current().longMemories : this.current().checkpoints;
        const item = list.find(entry => entry.id === id);
        if (!item) return null;
        Object.assign(item, structuredClone(updates), { id });
        this.persist();
        return item;
    }

    deleteAggregate(type, id) {
        const store = this.current();
        const key = type === 'long' ? 'longMemories' : 'checkpoints';
        const next = store[key].filter(item => item.id !== id);
        if (next.length === store[key].length) return false;
        store[key] = next;
        this.persist();
        return true;
    }

    replace(imported) {
        const normalized = normalizeStore(structuredClone(imported), this.getChatId());
        this.getMetadata().cache_memory = normalized;
        this.persist();
        return normalized;
    }
}
