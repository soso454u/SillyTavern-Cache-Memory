import { aggregateVersion, summaryVersion, memoryContentDigest, mergeForCurrentChat, mergeMemoryStoresSafely, normalizeStore } from './memory-store.js?v=1.22.12';

export const MEMORY_SAVE_STATES = Object.freeze({
    PENDING: 'pending',
    SAVING: 'saving',
    CONFIRMED: 'confirmed',
    FAILED: 'failed',
    UNKNOWN: 'unknown',
    CONFLICT: 'conflict',
});

const STORAGE_KEY = 'cache_memory_pending_saves_v1';
const MIGRATION_BACKUP_PREFIX = 'cache_memory_migration_backup_v1:';

export function withDeadline(operation, timeoutMs = 45000) {
    let timer;
    return Promise.race([Promise.resolve().then(operation), new Promise((_, reject) => {
        timer = setTimeout(() => reject(Object.assign(new Error('保存/读取超时；副本已保留，请恢复网络后重试'), { code: 'SAVE_TIMEOUT' })), timeoutMs);
    })]).finally(() => clearTimeout(timer));
}

function clone(value) {
    return structuredClone(value);
}

function writerId() {
    if (globalThis.crypto?.randomUUID) return globalThis.crypto.randomUUID();
    return `writer-${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

function normalizeRemote(value, chatId) {
    if (value?.chatId && String(value.chatId) !== chatId) {
        let scope; try { scope = JSON.parse(chatId); } catch { /* Non-scoped caller. */ }
        if (!(Number(value.version) <= 4 && Array.isArray(scope) && scope.length === 3 && value.chatId === scope[2])) throw new Error('服务器记忆的聊天身份不匹配，已停止同步');
    }
    return normalizeStore(value, chatId);
}

function validateAuthoritativeRecord(record, chatId) {
    if (!record || !Object.hasOwn(record, 'store') || !Number.isInteger(record.revision) || record.revision < 0
        || record.chatId && record.chatId !== chatId || record.store?.chatId && record.store.chatId !== chatId) throw new Error('权威库返回无法验证的聊天版本');
    if (!record.store && record.revision !== 0) throw new Error('权威库已有版本但记忆为空，已停止同步');
    return record;
}

export class MemoryPersistenceCoordinator {
    constructor({ getChatId, getMetadata, readRemoteStore, saveMetadata, readAuthoritativeStore = null, commitAuthoritative = null, authoritativeAvailable = () => true, storage = null, onStatus = () => {}, timeoutMs = 45000 }) {
        this.getChatId = getChatId;
        this.getMetadata = getMetadata;
        this.readRemoteStore = readRemoteStore;
        this.saveMetadata = saveMetadata;
        this.readAuthoritativeStore = readAuthoritativeStore;
        this.commitAuthoritative = commitAuthoritative;
        this.authoritativeAvailable = authoritativeAvailable;
        this.storage = storage;
        this.onStatus = onStatus;
        this.writerId = writerId();
        this.storageKey = typeof storage?.key === 'function' ? `${STORAGE_KEY}:${this.writerId}` : STORAGE_KEY;
        this.restoredJournals = new Map();
        this.sequence = 0;
        this.timeoutMs = timeoutMs;
        this.epoch = 0;
        this.readSequence = 0;
        this.readController = null;
        this.uncertainWrites = new Map();
        this.pending = new Map();
        this.baselines = new Map();
        this.states = new Map();
        this.conflicts = new Map();
        this.running = new Map();
        this.pausedSaves = new Map();
        this.replacementStores = new Map();
        this.replacementRuns = new Map();
        this.restorePending();
    }

    restorePending() {
        if (!this.storage) return;
        const keys = new Set([STORAGE_KEY]);
        try {
            for (let i = 0; i < (this.storage.length ?? 0); i++) {
                const key = this.storage.key(i);
                if (key?.startsWith(`${STORAGE_KEY}:`)) keys.add(key);
            }
            const obsolete = [];
            for (let i = 0; i < (this.storage.length ?? 0); i++) {
                const key = this.storage.key(i);
                if (key?.startsWith(MIGRATION_BACKUP_PREFIX)) obsolete.push(key);
            }
            for (const key of obsolete) this.storage.removeItem(key);
            for (const key of keys) {
                const raw = this.storage.getItem(key);
                if (!raw) continue;
                let entries;
                try { entries = JSON.parse(raw); } catch (error) { console.warn('[Cache Memory] Pending journal retained:', error); continue; }
                if (!Array.isArray(entries)) continue;
                let complete = true;
                for (const saved of entries) {
                    if (!saved?.chatId || !saved?.snapshot) { complete = false; continue; }
                    const stripArchives = value => {
                        if (!value || typeof value !== 'object') return;
                        delete value.recovery;
                        for (const child of Object.values(value)) stripArchives(child);
                    };
                    stripArchives(saved);
                    saved.snapshot = normalizeStore(saved.snapshot, saved.chatId);
                    saved.digest = memoryContentDigest(saved.snapshot);
                    if (saved.baseSnapshot) saved.baseDigest = memoryContentDigest(saved.baseSnapshot);
                    const id = String(saved.chatId), previous = this.pending.get(id);
                    let entry = clone(previous?.digest === saved.digest && (previous.conflict || previous.restore) ? previous : saved);
                    if (previous && previous.digest !== saved.digest) {
                        const merge = mergeMemoryStoresSafely(previous.baseDigest === saved.baseDigest ? previous.baseSnapshot : null, previous.snapshot, saved.snapshot, id);
                        entry = { ...previous, snapshot: merge.merged, digest: memoryContentDigest(merge.merged) };
                        if (merge.conflicts.length || previous.restore || saved.restore || previous.conflict || saved.conflict) {
                            entry = { ...previous, snapshot: clone(previous.snapshot), conflict: { local: clone(previous.snapshot), remote: clone(saved.snapshot), recordConflicts: merge.conflicts } };
                            // Unresolved branches live only in the temporary save
                            // journal, never in the saved/exported memory JSON.
                            entry.conflict.pendingConflicts = [previous.conflict, saved.conflict].filter(Boolean).map(clone);
                            entry.digest = memoryContentDigest(entry.snapshot);
                            entry.conflict.local = clone(entry.snapshot);
                        }
                    }
                    this.pending.set(id, entry);
                    this.sequence = Math.max(this.sequence, Number(entry.sequence) || 0);
                    if (entry.conflict) this.conflicts.set(id, entry.conflict);
                    this.states.set(id, { state: entry.conflict ? MEMORY_SAVE_STATES.CONFLICT : MEMORY_SAVE_STATES.PENDING, detail: '浏览器中有尚未确认写入服务器的记忆', at: new Date().toISOString() });
                }
                if (complete) this.restoredJournals.set(key, raw);
            }
        } catch (error) { console.warn('[Cache Memory] Unable to restore pending memory saves:', error); }
    }

    persistPending() {
        if (!this.storage) return true;
        try {
            // Each window owns a separate journal. A pagehide in an old window
            // cannot replace another window's pending snapshots with an empty list.
            this.storage.setItem(this.storageKey, JSON.stringify([...this.pending.values()]));
            for (const [key, raw] of this.restoredJournals) {
                if (key !== this.storageKey && this.storage.getItem(key) === raw) {
                    if (this.storage.removeItem) this.storage.removeItem(key);
                    else this.storage.setItem(key, '[]');
                }
                this.restoredJournals.delete(key);
            }
            if (!this.pending.size) this.storage.removeItem?.(this.storageKey);
            return true;
        } catch (error) {
            console.warn('[Cache Memory] Unable to persist pending memory saves locally:', error);
            return false;
        }
    }

    setState(chatId, state, detail = '') {
        if (state === MEMORY_SAVE_STATES.CONFLICT && this.conflicts.has(chatId)) {
            const conflict = this.conflicts.get(chatId);
            const entry = this.pending.get(chatId) ?? { chatId, snapshot: clone(conflict.local), digest: memoryContentDigest(conflict.local), baseDigest: memoryContentDigest(conflict.remote), baseSnapshot: clone(conflict.remote), sequence: ++this.sequence };
            entry.conflict = clone(conflict);
            this.pending.set(chatId, entry);
            this.persistPending();
        }
        const value = { state, detail: String(detail || ''), at: new Date().toISOString() };
        this.states.set(String(chatId), value);
        try { this.onStatus(String(chatId), value); } catch (error) { console.warn('[Cache Memory] Status UI failed', error); }
        return value;
    }

    getState(chatId = this.getChatId()) {
        return this.states.get(String(chatId ?? '')) ?? { state: MEMORY_SAVE_STATES.UNKNOWN, detail: '尚未验证服务器持久化状态', at: '' };
    }

    beginRead() {
        this.readController?.abort();
        this.readController = new AbortController();
        return this.readController.signal;
    }

    activate(chatId, loadedValue) {
        const id = String(chatId ?? '');
        if (!id) return null;
        this.epoch++;
        this.readController?.abort();
        const loaded = normalizeStore(clone(loadedValue), id);
        const loadedDigest = memoryContentDigest(loaded);
        const pending = this.pending.get(id);
        if (pending?.conflict) {
            this.getMetadata().cache_memory = clone(pending.snapshot);
            this.setState(id, MEMORY_SAVE_STATES.CONFLICT, '已保留未解决冲突的双方副本；请核对后恢复');
            return this.getMetadata().cache_memory;
        }
        if (!pending) {
            this.baselines.set(id, { digest: loadedDigest, revision: loaded.sync.revision, snapshot: clone(loaded) });
            this.setState(id, MEMORY_SAVE_STATES.UNKNOWN, '当前页面记忆已加载，正在等待服务器读回验证');
            return loaded;
        }
        if (loadedDigest === pending.digest) {
            this.baselines.set(id, { digest: pending.baseDigest, revision: loaded.sync.revision, snapshot: clone(pending.baseSnapshot ?? loaded) });
            this.setState(id, MEMORY_SAVE_STATES.PENDING, '页面副本已恢复，仍需直接读回服务器确认');
            queueMicrotask(() => this.flush(id));
            return loaded;
        }
        this.getMetadata().cache_memory = clone(pending.snapshot);
        this.baselines.set(id, { digest: pending.baseDigest, revision: loaded.sync.revision, snapshot: clone(pending.baseSnapshot ?? loaded) });
        this.setState(id, MEMORY_SAVE_STATES.PENDING, '已恢复本机尚未确认保存的记忆');
        queueMicrotask(() => this.flush(id));
        return this.getMetadata().cache_memory;
    }

    async sync(chatId = this.getChatId(), loadedValue = this.getMetadata().cache_memory) {
        const id = String(chatId ?? '');
        if (this.conflicts.has(id)) return this.getMetadata().cache_memory;
        if (!id || !this.readAuthoritativeStore || !this.authoritativeAvailable() || String(this.getChatId() ?? '') !== id) return loadedValue;
        if (this.pending.has(id)) { await this.flush(id); return String(this.getChatId()) === id ? this.getMetadata().cache_memory : loadedValue; }
        const epoch = this.epoch;
        const readSequence = ++this.readSequence;
        const signal = this.beginRead();
        const initialDigest = memoryContentDigest(this.getMetadata().cache_memory);
        try {
            const record = validateAuthoritativeRecord(await withDeadline(() => this.readAuthoritativeStore(id, { signal }), this.timeoutMs), id);
            if (String(this.getChatId()) !== id || epoch !== this.epoch || readSequence !== this.readSequence) return loadedValue;
            if (this.pending.has(id) || memoryContentDigest(this.getMetadata().cache_memory) !== initialDigest) return this.getMetadata().cache_memory;
            if (!record?.store) {
                this.baselines.set(id, { digest: memoryContentDigest(normalizeStore(loadedValue, id)), revision: 0, snapshot: clone(normalizeStore(loadedValue, id)) });
                if (loadedValue) { this.enqueue(loadedValue, 'initial authoritative migration'); await this.flush(id); }
                return String(this.getChatId()) === id ? this.getMetadata().cache_memory : loadedValue;
            }
            const remote = normalizeStore(clone(record.store), id);
            remote.sync.revision = Number(record.revision || 0);
            const remoteDigest = memoryContentDigest(remote);
            // A populated metadata copy may contain records absent from the optional
            // server store (e.g. an older device still using native persistence).
            const local = normalizeStore(clone(loadedValue), id);
            const comparison = this.reconcileRead(id, local, remote, Boolean(this.baselines.get(id)?.authoritative), true);
            if (comparison.state !== MEMORY_SAVE_STATES.CONFIRMED) {
                if (!this.conflicts.has(id)) await this.flush(id);
                return this.getMetadata().cache_memory;
            }
            if (this.pending.has(id)) { await this.flush(id); return this.getMetadata().cache_memory; }
            this.getMetadata().cache_memory = remote;
            this.baselines.set(id, { digest: remoteDigest, revision: Number(record.revision || 0), snapshot: clone(remote), authoritative: true });
            this.pending.delete(id);
            this.persistPending();
            this.setState(id, MEMORY_SAVE_STATES.CONFIRMED, '已从服务器权威记忆库恢复最新版本');
            return remote;
        } catch (error) {
            if (String(this.getChatId()) !== id || epoch !== this.epoch || readSequence !== this.readSequence) return loadedValue;
            this.setState(id, MEMORY_SAVE_STATES.FAILED, `无法读取权威记忆库：${error.message}`);
            return loadedValue;
        }
    }

    reconcileRead(chatId, local, remote, useBaseline = true, authoritative = false) {
        const baseline = useBaseline ? this.baselines.get(chatId)?.snapshot : null;
        const result = mergeMemoryStoresSafely(baseline, local, remote, chatId);
        if (result.conflicts.length) return this.holdConflict(chatId, local, remote, result.conflicts);
        this.conflicts.delete(chatId);
        this.getMetadata().cache_memory = clone(result.merged);
        this.baselines.set(chatId, { digest: memoryContentDigest(remote), revision: remote.sync.revision, snapshot: clone(remote), authoritative });
        if (memoryContentDigest(result.merged) !== memoryContentDigest(remote)) {
            this.enqueue(result.merged, 'merge non-conflicting device changes');
            return this.getState(chatId);
        }
        this.conflicts.delete(chatId);
        return this.setState(chatId, MEMORY_SAVE_STATES.CONFIRMED, '已同步当前聊天记忆');
    }

    holdConflict(chatId, local, remote, recordConflicts = []) {
        this.conflicts.set(chatId, { local: clone(local), remote: clone(remote), recordConflicts: clone(recordConflicts) });
        return this.setState(chatId, MEMORY_SAVE_STATES.CONFLICT, '服务器与本机存在无法安全判定的变化；双方副本已保留，未覆盖服务器');
    }

    async verify(chatId = this.getChatId()) {
        const id = String(chatId ?? '');
        if (!id || this.conflicts.has(id)) return this.getState(id);
        if (this.readAuthoritativeStore && this.authoritativeAvailable()) return this.sync(id, this.getMetadata().cache_memory).then(() => this.getState(id));
        if (this.pending.has(id)) return this.flush(id);
        if (String(this.getChatId() ?? '') !== id) return this.getState(id);
        const epoch = this.epoch, readSequence = ++this.readSequence;
        const signal = this.beginRead();
        const active = () => String(this.getChatId()) === id && epoch === this.epoch && readSequence === this.readSequence;
        const local = normalizeStore(clone(this.getMetadata().cache_memory), id);
        const localDigest = memoryContentDigest(local);
        let remote;
        try {
            remote = normalizeRemote(await withDeadline(() => this.readRemoteStore(id, { signal }), this.timeoutMs), id);
        } catch (error) {
            if (!active()) return this.getState(id);
            this.setState(id, MEMORY_SAVE_STATES.FAILED, `无法验证服务器持久化状态：${error.message}`);
            return this.getState(id);
        }
        if (!active()) return this.getState(id);
        if (this.pending.has(id)) return this.flush(id);
        if (memoryContentDigest(this.getMetadata().cache_memory) !== localDigest) {
            this.setState(id, MEMORY_SAVE_STATES.UNKNOWN, '验证期间本机记忆发生变化，等待保存队列确认');
            return this.getState(id);
        }
        const remoteDigest = memoryContentDigest(remote);
        if (remoteDigest !== localDigest) {
            this.reconcileRead(id, local, remote);
            return this.pending.has(id) && !this.conflicts.has(id) ? this.flush(id) : this.getState(id);
        }
        this.conflicts.delete(id);
        this.baselines.set(id, { digest: remoteDigest, revision: remote.sync.revision, snapshot: clone(remote) });
        this.setState(id, MEMORY_SAVE_STATES.CONFIRMED, '已从服务器读回并确认当前记忆');
        return this.getState(id);
    }

    pauseSaves(chatId = this.getChatId()) {
        const id = String(chatId ?? '');
        this.pausedSaves.set(id, (this.pausedSaves.get(id) ?? 0) + 1);
        let released = false;
        return ({ retryPending = true } = {}) => {
            if (released) return;
            released = true;
            const remaining = this.pausedSaves.get(id) - 1;
            if (remaining) this.pausedSaves.set(id, remaining);
            else {
                this.pausedSaves.delete(id);
                if (retryPending && this.pending.has(id)) queueMicrotask(() => this.flush(id));
            }
        };
    }

    async prepareRestore(chatId = this.getChatId(), { requireSaved = false } = {}) {
        const id = String(chatId ?? ''), epoch = this.epoch;
        if (this.running.has(id)) await this.running.get(id);
        if (!id || String(this.getChatId()) !== id || this.epoch !== epoch) throw new Error('聊天已切换，未准备导入');
        const localDigest = memoryContentDigest(this.getMetadata().cache_memory);
        const sequence = this.pending.get(id)?.sequence;
        const authority = Boolean(this.readAuthoritativeStore && this.authoritativeAvailable());
        const record = await withDeadline(() => authority ? this.readAuthoritativeStore(id) : this.readRemoteStore(id), this.timeoutMs);
        if (String(this.getChatId()) !== id || this.epoch !== epoch || memoryContentDigest(this.getMetadata().cache_memory) !== localDigest
            || this.pending.get(id)?.sequence !== sequence) throw new Error('读取期间记忆发生变化，请重新选择文件');
        if (authority) validateAuthoritativeRecord(record, id);
        if (requireSaved && !(authority ? record.store : record)) throw new Error('服务器尚未保存此聊天的记忆，请先在有完整记忆的设备上传');
        const remote = normalizeRemote(clone(authority ? record.store : record), id);
        if (authority) remote.sync.revision = record.revision;
        return { chatId: id, epoch, localDigest, sequence, authority, remote, hasSaved: Boolean(authority ? record.store : record),
            pending: clone(this.pending.get(id)), conflict: clone(this.conflicts.get(id)) };
    }

    async loadLatest(chatId = this.getChatId()) {
        const id = String(chatId ?? ''), epoch = this.epoch;
        const resume = this.pauseSaves(id);
        let migrate = false;
        try {
            const prepared = await this.prepareRestore(id);
            // A newly installed authority has no record yet. Load the existing
            // ST server memory before migrating it; never initialize it empty.
            if (prepared.authority && !prepared.hasSaved) {
                const native = await withDeadline(() => this.readRemoteStore(id), this.timeoutMs);
                prepared.remote = normalizeRemote(clone(native), id);
                prepared.remote.sync.revision = 0;
                migrate = true;
            }
            this.restoreServerSnapshot(prepared);
            if (migrate) this.enqueue(prepared.remote, 'initial authoritative migration');
        } catch (error) {
            if (String(this.getChatId()) === id && this.epoch === epoch) this.setState(id, MEMORY_SAVE_STATES.FAILED, `读取最新服务器记忆失败：${error.message}`);
            migrate = false;
        } finally { resume({ retryPending: migrate }); }
        return migrate ? this.flush(id) : this.getState(id);
    }

    acceptRestoreBase(prepared) {
        const id = prepared.chatId;
        if (String(this.getChatId()) !== id || this.epoch !== prepared.epoch || this.running.has(id)
            || memoryContentDigest(this.getMetadata().cache_memory) !== prepared.localDigest
            || this.pending.get(id)?.sequence !== prepared.sequence) throw new Error('确认期间当前记忆发生变化，请重新选择文件');
        // Called only after explicit confirmation selects the replacement.
        this.baselines.set(id, { digest: memoryContentDigest(prepared.remote), revision: prepared.remote.sync.revision,
            snapshot: clone(prepared.remote), authoritative: prepared.authority });
        this.conflicts.delete(id); this.pending.delete(id);
    }

    restoreServerSnapshot(prepared) {
        this.acceptRestoreBase(prepared);
        this.readSequence++;
        this.readController?.abort();
        this.getMetadata().cache_memory = clone(prepared.remote);
        this.persistPending();
        return this.setState(prepared.chatId, MEMORY_SAVE_STATES.CONFIRMED, '已从服务器读取并恢复当前聊天记忆');
    }

    enqueue(value, reason = 'memory changed') {
        let snapshot = normalizeStore(clone(value), value?.chatId || this.getChatId());
        const chatId = String(snapshot.chatId ?? '');
        if (!chatId) return Promise.resolve({ state: MEMORY_SAVE_STATES.UNKNOWN });
        const previous = this.pending.get(chatId);
        let replacementFallback = reason === 'memory import' ? null : previous?.replacementFallback;
        if (reason === 'memory import') this.replacementStores.delete(chatId);
        if (replacementFallback && memoryContentDigest(snapshot) !== previous.digest) {
            const incoming = clone(snapshot);
            const combined = mergeMemoryStoresSafely(replacementFallback, incoming, previous.snapshot, chatId);
            // An edit made while a generated replacement is saving wins over
            // that local draft. Disjoint edits accompany it; neither is lost.
            snapshot = combined.conflicts.length ? incoming : combined.merged;
            replacementFallback = incoming;
        }
        const digest = memoryContentDigest(snapshot);
        const explicit = ['manual save', 'memory import', 'store migration', 'initial authoritative migration'].includes(reason);
        // Rendering/reloading the same snapshot must not restart a failed save.
        // An explicit upload remains available even when the content is unchanged.
        if (!explicit && (previous?.digest === digest || !previous && this.getState(chatId).state === MEMORY_SAVE_STATES.CONFIRMED
            && this.baselines.get(chatId)?.digest === digest)) return Promise.resolve(this.getState(chatId));
        if (this.conflicts.has(chatId)) {
            const conflict = this.conflicts.get(chatId);
            // Preserve new edits as the recoverable local branch of the conflict.
            conflict.local = clone(snapshot);
        }
        const baseline = this.baselines.get(chatId);
        const entry = {
            chatId,
            snapshot,
            digest,
            baseDigest: previous?.baseDigest ?? baseline?.digest ?? memoryContentDigest(snapshot),
            baseSnapshot: previous?.baseSnapshot ?? baseline?.snapshot ?? clone(snapshot),
            reason,
            restore: reason === 'memory import' || Boolean(previous?.restore),
            sequence: ++this.sequence,
            queuedAt: new Date().toISOString(),
            ...(replacementFallback ? { replacementFallback } : {}),
        };
        this.pending.set(chatId, entry);
        const locallyRetained = this.persistPending();
        this.setState(chatId, this.conflicts.has(chatId) ? MEMORY_SAVE_STATES.CONFLICT : MEMORY_SAVE_STATES.PENDING, locallyRetained ? '记忆已进入当前聊天的保存队列' : '记忆已排队，但浏览器本地待保存副本写入失败；请立即导出 JSON');
        queueMicrotask(() => this.flush(chatId));
        return Promise.resolve(this.getState(chatId));
    }

    async flush(chatId = this.getChatId()) {
        const id = String(chatId ?? '');
        if (!id || !this.pending.has(id)) return this.getState(id);
        if (this.running.has(id)) return this.running.get(id);
        if (this.pausedSaves.has(id)) return this.getState(id);
        const visible = this.replacementStores.get(id)?.store;
        if (visible && this.pending.get(id)?.replacementFallback) visible.replacementView = clone(this.pending.get(id).replacementFallback);
        const task = this.process(id).catch(error => this.setState(id, MEMORY_SAVE_STATES.FAILED, error.message)).finally(() => {
            this.running.delete(id);
            const pending = this.pending.get(id);
            if (pending?.replacementFallback && String(this.getChatId()) === id) this.getMetadata().cache_memory = clone(pending.replacementFallback);
            if (pending && visible) delete visible.replacementView;
            const replacement = this.replacementStores.get(id);
            if (!pending && replacement && String(this.getChatId()) === id && this.getState(id).state === MEMORY_SAVE_STATES.CONFIRMED) {
                this.replacementStores.delete(id);
                delete replacement.store.replacementView;
                replacement.store.persist(replacement.reason);
            }
        });
        this.running.set(id, task);
        return task;
    }

    commitReplacement(store, mutate, assertActive = () => {}) {
        const chatId = String(this.getChatId()), epoch = this.epoch;
        const previous = this.replacementRuns.get(chatId) ?? Promise.resolve();
        const task = previous.catch(() => {}).then(() => {
            if (String(this.getChatId()) !== chatId || this.epoch !== epoch) throw Object.assign(new Error('聊天已切换，取消旧聊天替换'), { code: 'CHAT_CHANGED' });
            return this.performReplacement(store, mutate, assertActive);
        }).finally(() => { if (this.replacementRuns.get(chatId) === task) this.replacementRuns.delete(chatId); });
        this.replacementRuns.set(chatId, task);
        return task;
    }

    async performReplacement(store, mutate, assertActive) {
        const chatId = String(this.getChatId()), epoch = this.epoch;
        let state = await this.flush(chatId);
        if (state.state === MEMORY_SAVE_STATES.UNKNOWN) state = await this.reread(chatId);
        if (state.state !== MEMORY_SAVE_STATES.CONFIRMED) throw Object.assign(new Error(`原记忆尚未确认，未替换：${state.detail}`), { code: 'SAVE_UNCONFIRMED' });
        if (String(this.getChatId()) !== chatId || this.epoch !== epoch) throw Object.assign(new Error('聊天已切换，取消旧聊天替换'), { code: 'CHAT_CHANGED' });
        assertActive();
        const previous = clone(store.current()), persist = store.persist;
        let candidate, result, reason = 'memory replacement';
        // Build the complete replacement without publishing/injecting it. The
        // old effective snapshot stays visible until the server confirms it.
        store.persist = why => { reason = why; return store.current(); };
        try { result = mutate(); candidate = clone(store.current()); }
        finally { store.persist = persist; this.getMetadata().cache_memory = previous; }
        store.replacementView = clone(previous);
        this.replacementStores.set(chatId, { store, reason });
        try {
            await this.enqueue(candidate, reason);
            const pending = this.pending.get(chatId);
            if (pending) {
                pending.replacementFallback = previous;
                if (!this.persistPending()) {
                    this.pending.delete(chatId); this.replacementStores.delete(chatId);
                    this.getMetadata().cache_memory = previous;
                    this.setState(chatId, MEMORY_SAVE_STATES.FAILED, '无法保留替换前的临时副本，原记忆未替换；请检查浏览器存储空间');
                    throw Object.assign(new Error(this.getState(chatId).detail), { code: 'SAVE_UNCONFIRMED' });
                }
            }
            state = await this.flush(chatId);
            if (String(this.getChatId()) !== chatId || this.epoch !== epoch) throw Object.assign(new Error('保存期间聊天已切换，未发布替换结果'), { code: 'CHAT_CHANGED' });
            if (state.state !== MEMORY_SAVE_STATES.CONFIRMED) throw Object.assign(new Error(`替换尚未确认，原记忆保留：${state.detail}`), { code: 'SAVE_UNCONFIRMED' });
            const committed = this.getMetadata().cache_memory;
            for (const section of ['summaries', 'checkpoints', 'longMemories']) {
                const map = value => Array.isArray(value[section]) ? Object.fromEntries(value[section].map(item => [item.id, item])) : value[section];
                const before = map(previous), desired = map(candidate), actual = map(committed);
                const version = item => item ? section === 'summaries' ? summaryVersion(item) : aggregateVersion(item) : null;
                for (const id of new Set([...Object.keys(before), ...Object.keys(desired)])) {
                    if (version(before[id]) !== version(desired[id]) && version(actual[id]) !== version(desired[id])) throw Object.assign(new Error('保存期间记忆被再次编辑，未采用这次生成结果'), { code: 'SAVE_UNCONFIRMED' });
                }
            }
        } finally { delete store.replacementView; }
        return result;
    }

    async process(chatId) {
        let rebases = 0;
        while (this.pending.has(chatId)) {
            if (this.pausedSaves.has(chatId)) return this.getState(chatId);
            if (String(this.getChatId() ?? '') !== chatId) {
                this.setState(chatId, MEMORY_SAVE_STATES.PENDING, '聊天已切换；等待该聊天再次激活后保存');
                return this.getState(chatId);
            }
            const entry = this.pending.get(chatId);
            const epoch = this.epoch;
            const stillActive = () => String(this.getChatId() ?? '') === chatId && epoch === this.epoch;
            const useAuthority = Boolean(this.readAuthoritativeStore && this.commitAuthoritative && this.authoritativeAvailable());
            const restoredConflict = this.conflicts.get(chatId) ?? entry.conflict;
            if (restoredConflict) return this.setState(chatId, MEMORY_SAVE_STATES.CONFLICT, '冲突副本已保留，等待明确恢复；未覆盖服务器');
            this.setState(chatId, MEMORY_SAVE_STATES.SAVING, '正在核对服务器版本并保存');
            let remote;
            let authoritativeRecord = null;
            let remoteRecovery;
            try {
                const authoritative = await withDeadline(() => useAuthority ? this.readAuthoritativeStore(chatId) : this.readRemoteStore(chatId), this.timeoutMs);
                authoritativeRecord = useAuthority ? validateAuthoritativeRecord(authoritative, chatId) : null;
                remoteRecovery = (useAuthority ? authoritative?.store : authoritative)?.recovery;
                remote = normalizeRemote(useAuthority ? authoritative?.store : authoritative, chatId);
                if (useAuthority) remote.sync.revision = Number(authoritativeRecord?.revision || 0);
            } catch (error) {
                if (!stillActive()) return this.getState(chatId);
                this.setState(chatId, MEMORY_SAVE_STATES.FAILED, `无法读取服务器版本，已停止写入：${error.message}`);
                return this.getState(chatId);
            }
            if (!stillActive()) {
                // A newer activation owns the status. Discarding this read is normal.
                if (String(this.getChatId()) === chatId && this.pending.has(chatId)) queueMicrotask(() => setTimeout(() => this.flush(chatId), 0));
                return this.getState(chatId);
            }
            if (this.pending.get(chatId)?.sequence !== entry.sequence) continue;
            const remoteDigest = memoryContentDigest(remote);
            if (remoteDigest === entry.digest && !restoredConflict && !Object.keys(remoteRecovery ?? {}).length) {
                this.getMetadata().cache_memory = clone(remote);
                this.pending.delete(chatId);
                this.persistPending();
                this.baselines.set(chatId, { digest: remoteDigest, revision: authoritativeRecord?.revision ?? remote.sync.revision, snapshot: clone(remote), authoritative: useAuthority });
                this.setState(chatId, MEMORY_SAVE_STATES.CONFIRMED, '服务器读回内容与当前记忆一致');
                continue;
            }
            const firstAuthoritativeWrite = Boolean(useAuthority && !authoritativeRecord?.store
                && Number(this.baselines.get(chatId)?.revision ?? 0) === 0);
            if (entry.restore && remoteDigest !== entry.baseDigest) return this.holdConflict(chatId, entry.snapshot, remote);
            if (!firstAuthoritativeWrite && !entry.restore) {
                const result = mergeMemoryStoresSafely(entry.baseSnapshot, entry.snapshot, remote, chatId);
                if (result.conflicts.length) return this.holdConflict(chatId, entry.snapshot, remote, result.conflicts);
                this.conflicts.delete(chatId); delete entry.conflict;
                if (memoryContentDigest(result.merged) !== entry.digest || remoteDigest !== entry.baseDigest) {
                    if (++rebases > 3) return this.setState(chatId, MEMORY_SAVE_STATES.PENDING, '其他窗口仍在保存，本机改动已保留；稍后重试保存');
                    entry.snapshot = result.merged;
                    entry.digest = memoryContentDigest(result.merged);
                    entry.baseSnapshot = clone(remote); entry.baseDigest = remoteDigest;
                    this.baselines.set(chatId, { digest: remoteDigest, revision: remote.sync.revision, snapshot: clone(remote), authoritative: useAuthority });
                    this.getMetadata().cache_memory = clone(result.merged);
                    this.persistPending();
                    // Re-read before writing, including after an automatic rebase.
                    continue;
                }
            }
            if (this.pending.get(chatId)?.sequence !== entry.sequence) continue;
            if (this.uncertainWrites.has(chatId)) return this.setState(chatId, MEMORY_SAVE_STATES.FAILED, '前次保存超时且底层请求尚未结束；保留副本，暂不并发重写。可导出后刷新再核验');

            this.baselines.set(chatId, { digest: remoteDigest, revision: remote.sync.revision, snapshot: clone(remote), authoritative: useAuthority });
            const desired = normalizeStore(clone(entry.snapshot), chatId);
            desired.sync = {
                revision: Math.max(remote.sync.revision, desired.sync.revision) + 1,
                writerId: this.writerId,
                writeId: `${this.writerId}:${Date.now()}:${entry.sequence}`,
                savedAt: new Date().toISOString(),
            };
            this.getMetadata().cache_memory = clone(desired);
            entry.snapshot = clone(desired);
            this.pending.set(chatId, entry);
            this.persistPending();
            try {
                if (useAuthority) {
                    let result;
                    try {
                        result = await withDeadline(() => this.commitAuthoritative(chatId, {
                            snapshot: desired,
                            // Legacy server plugins need the old archive map in
                            // the comparison base to delete it, never in desired.
                            baseSnapshot: remoteRecovery ? { ...entry.baseSnapshot, recovery: remoteRecovery } : entry.baseSnapshot,
                            baseRevision: this.baselines.get(chatId)?.revision ?? remote.sync.revision,
                            writerId: this.writerId,
                        }), this.timeoutMs);
                    } catch (error) {
                        if (!stillActive()) return this.getState(chatId);
                        if (error.status === 409 && error.data?.record?.store) {
                            // A revision race is not itself a record conflict. Re-read
                            // and rebase on the next pass; the CAS still guards writes.
                            if (++rebases <= 3) continue;
                            return this.setState(chatId, MEMORY_SAVE_STATES.PENDING, '服务器正在被其他窗口更新，本机改动已保留；稍后重试保存');
                        }
                        throw error;
                    }
                    if (!stillActive()) return this.getState(chatId);
                    if (!result?.record?.store || !Number.isInteger(result.record.revision)) throw new Error('权威库未返回有效提交确认');
                    if (memoryContentDigest(result.record.store) !== memoryContentDigest(desired)) throw new Error('权威库返回内容与待保存快照不同；副本保留，请检查或更新服务端插件');
                    const readback = validateAuthoritativeRecord(await withDeadline(() => this.readAuthoritativeStore(chatId), this.timeoutMs), chatId);
                    if (!stillActive()) return this.getState(chatId);
                    if (!readback?.store || readback.revision < result.record.revision) throw new Error('服务器未读回已提交版本，本机副本保留');
                    if (readback.revision !== result.record.revision || memoryContentDigest(readback.store) !== memoryContentDigest(result.record.store)) {
                        const latestRemote = normalizeStore(clone(readback.store), chatId);
                        latestRemote.sync.revision = readback.revision;
                        const latest = this.pending.get(chatId);
                        if (entry.restore) return this.holdConflict(chatId, latest?.snapshot ?? entry.snapshot, latestRemote);
                        const comparison = mergeMemoryStoresSafely(entry.snapshot, latest?.snapshot ?? entry.snapshot, latestRemote, chatId);
                        if (comparison.conflicts.length) return this.holdConflict(chatId, latest?.snapshot ?? entry.snapshot, latestRemote, comparison.conflicts);
                        if (++rebases > 3) return this.setState(chatId, MEMORY_SAVE_STATES.PENDING, '服务器仍在更新，本机副本保留；稍后重试保存');
                        latest.snapshot = comparison.merged; latest.digest = memoryContentDigest(comparison.merged);
                        latest.baseSnapshot = clone(latestRemote); latest.baseDigest = memoryContentDigest(latestRemote);
                        this.getMetadata().cache_memory = clone(comparison.merged);
                        this.baselines.set(chatId, { digest: latest.baseDigest, revision: readback.revision, snapshot: clone(latestRemote), authoritative: true });
                        this.persistPending(); continue;
                    }
                    if (Object.keys(readback.store.recovery ?? {}).length) throw new Error('服务器仍保留旧恢复数据，清理尚未确认；请重试保存');
                    const committed = normalizeStore(clone(readback.store), chatId);
                    if (stillActive() && this.pending.get(chatId)?.sequence === entry.sequence) this.getMetadata().cache_memory = committed;
                    this.baselines.set(chatId, { digest: memoryContentDigest(committed), revision: Number(result.record?.revision || remote.sync.revision + 1), snapshot: clone(committed), authoritative: true });
                    const latest = this.pending.get(chatId);
                    if (latest?.sequence === entry.sequence) this.pending.delete(chatId);
                    else if (latest) {
                        latest.baseDigest = memoryContentDigest(committed);
                        latest.baseSnapshot = clone(committed);
                    }
                    this.persistPending();
                    this.setState(chatId, MEMORY_SAVE_STATES.CONFIRMED, '已提交到服务器权威记忆库并读回确认');
                    continue;
                }
                const write = Promise.resolve().then(() => this.saveMetadata(chatId));
                this.uncertainWrites.set(chatId, write);
                write.then(() => this.uncertainWrites.delete(chatId), () => this.uncertainWrites.delete(chatId));
                await withDeadline(() => write, this.timeoutMs);
            } catch (error) {
                if (!stillActive()) return this.getState(chatId);
                this.setState(chatId, MEMORY_SAVE_STATES.FAILED, `SillyTavern 保存调用失败：${error.message}`);
                return this.getState(chatId);
            }
            if (!stillActive()) {
                this.setState(chatId, MEMORY_SAVE_STATES.UNKNOWN, '保存期间聊天已切换；待重新读回确认');
                return this.getState(chatId);
            }
            let verified;
            try {
                const readback = await withDeadline(() => this.readRemoteStore(chatId), this.timeoutMs);
                if (Object.keys(readback?.recovery ?? {}).length) throw new Error('服务器仍保留旧恢复数据，清理尚未确认；请重试保存');
                verified = normalizeRemote(readback, chatId);
            } catch (error) {
                if (!stillActive()) return this.getState(chatId);
                this.setState(chatId, MEMORY_SAVE_STATES.FAILED, `SillyTavern 未报告结果，且服务器读回失败：${error.message}`);
                return this.getState(chatId);
            }
            if (!stillActive()) return this.getState(chatId);
            const verifiedDigest = memoryContentDigest(verified);
            if (verifiedDigest !== entry.digest) {
                if (verifiedDigest === remoteDigest) {
                    this.setState(chatId, MEMORY_SAVE_STATES.FAILED, 'SillyTavern 保存调用已返回，但服务器内容没有变化；待保存副本已保留');
                    return this.getState(chatId);
                }
                const latest = this.pending.get(chatId);
                if (entry.restore) return this.holdConflict(chatId, latest?.snapshot ?? entry.snapshot, verified);
                const result = mergeMemoryStoresSafely(entry.snapshot, latest?.snapshot ?? entry.snapshot, verified, chatId);
                if (result.conflicts.length) return this.holdConflict(chatId, latest?.snapshot ?? entry.snapshot, verified, result.conflicts);
                if (++rebases > 3) return this.setState(chatId, MEMORY_SAVE_STATES.PENDING, '读回时其他窗口仍在更新，本机改动已保留；稍后重试');
                latest.snapshot = result.merged; latest.digest = memoryContentDigest(result.merged);
                latest.baseSnapshot = clone(verified); latest.baseDigest = verifiedDigest;
                this.getMetadata().cache_memory = clone(result.merged);
                this.baselines.set(chatId, { digest: verifiedDigest, revision: verified.sync.revision, snapshot: clone(verified) });
                this.persistPending(); continue;
            }
            this.baselines.set(chatId, { digest: verifiedDigest, revision: verified.sync.revision, snapshot: clone(verified) });
            const latest = this.pending.get(chatId);
            if (latest?.sequence === entry.sequence) this.pending.delete(chatId);
            else if (latest) { latest.baseDigest = verifiedDigest; latest.baseSnapshot = clone(verified); }
            this.persistPending();
            this.setState(chatId, MEMORY_SAVE_STATES.CONFIRMED, '已从服务器读回并确认保存');
        }
        return this.getState(chatId);
    }

    conflictBundle(chatId = this.getChatId()) {
        const id = String(chatId ?? '');
        const conflict = this.conflicts.get(id);
        return conflict ? { chatId: id, ...clone(conflict) } : null;
    }

    async reread(chatId = this.getChatId()) {
        const id = String(chatId ?? ''), epoch = this.epoch, sequence = ++this.readSequence;
        if (String(this.getChatId()) !== id || this.conflicts.has(id)) return this.getState(id);
        if (this.pending.has(id)) return this.flush(id);
        const signal = this.beginRead();
        const initial = memoryContentDigest(this.getMetadata().cache_memory);
        try {
            const authority = Boolean(this.readAuthoritativeStore && this.authoritativeAvailable());
            const record = await withDeadline(() => authority ? this.readAuthoritativeStore(id, { signal }) : this.readRemoteStore(id, { signal }), this.timeoutMs);
            if (String(this.getChatId()) !== id || epoch !== this.epoch || sequence !== this.readSequence) return this.getState(id);
            if (memoryContentDigest(this.getMetadata().cache_memory) !== initial) return this.getState(id);
            if (authority) validateAuthoritativeRecord(record, id);
            const remote = normalizeRemote(clone(authority ? record?.store : record), id);
            if (authority) remote.sync.revision = Number(record?.revision || 0);
            const local = normalizeStore(clone(this.getMetadata().cache_memory), id);
            if (memoryContentDigest(remote) !== memoryContentDigest(local)) {
                this.reconcileRead(id, local, remote, !authority || Boolean(this.baselines.get(id)?.authoritative), authority);
                return this.pending.has(id) && !this.conflicts.has(id) ? this.flush(id) : this.getState(id);
            }
            this.conflicts.delete(id); this.pending.delete(id); this.persistPending();
            this.baselines.set(id, { digest: initial, revision: remote.sync.revision, snapshot: clone(remote), authoritative: authority });
            return this.setState(id, MEMORY_SAVE_STATES.CONFIRMED, '已同步：服务器读回与本机一致');
        } catch (error) {
            if (String(this.getChatId()) !== id || epoch !== this.epoch || sequence !== this.readSequence) return this.getState(id);
            return this.setState(id, MEMORY_SAVE_STATES.FAILED, `服务器记忆读取失败：${error.message}`);
        }
    }

    resolveConflictByMerge(chatId = this.getChatId()) { return this.resolveConflict(chatId, 'local'); }

    async resolveConflict(chatId = this.getChatId(), preference = 'local') {
        const id = String(chatId ?? ''), epoch = this.epoch;
        if (!this.conflicts.has(id) || String(this.getChatId()) !== id) return null;
        const authority = Boolean(this.readAuthoritativeStore && this.authoritativeAvailable());
        const record = await withDeadline(() => authority ? this.readAuthoritativeStore(id) : this.readRemoteStore(id), this.timeoutMs);
        if (String(this.getChatId()) !== id || epoch !== this.epoch) return null;
        if (authority) validateAuthoritativeRecord(record, id);
        const fresh = normalizeRemote(clone(authority ? record?.store : record), id);
        if (authority) fresh.sync.revision = Number(record?.revision || 0);
        // Read the actual current chat after the asynchronous fetch. A normal
        // validation pass or a new disjoint server record must not restart a dialog.
        const local = normalizeStore(clone(this.getMetadata().cache_memory), id);
        const reviewed = this.conflicts.get(id)?.remote ?? fresh;
        const decision = preference === 'server' ? mergeForCurrentChat(null, reviewed, local, id) : mergeForCurrentChat(null, local, reviewed, id);
        const result = mergeMemoryStoresSafely(reviewed, decision.merged, fresh, id);
        if (result.conflicts.length) { this.holdConflict(id, local, fresh, result.conflicts); return null; }
        result.added = decision.added ?? { total: 0 };
        const merged = result.merged;
        if (local.injectionSnapshot) merged.injectionSnapshot = { ...clone(local.injectionSnapshot), needsRebuild: true };
        this.getMetadata().cache_memory = merged;
        this.conflicts.delete(id); this.pending.delete(id);
        this.baselines.set(id, { digest: memoryContentDigest(fresh), revision: fresh.sync.revision, snapshot: clone(fresh), authoritative: authority });
        await this.enqueue(merged, `current chat conflict policy: ${preference}`);
        await this.flush(id);
        return result;
    }

    resolveConflictByRestore(chatId = this.getChatId()) { return this.resolveConflict(chatId, 'local'); }

}

export async function readSillyTavernRemoteStore(getContext, chatId, fetchImpl = globalThis.fetch, { signal } = {}) {
    const context = getContext();
    if (String(context?.chatId ?? '') !== String(chatId ?? '')) throw new Error('当前聊天已切换');
    const headers = context?.getRequestHeaders?.();
    if (!headers) throw new Error('SillyTavern 未提供请求头，无法安全读取服务器聊天');
    let endpoint;
    let body;
    if (context.groupId) {
        endpoint = '/api/chats/group/get';
        body = { id: chatId };
    } else {
        const character = context.characters?.[context.characterId];
        if (!character) throw new Error('无法确定当前角色聊天');
        endpoint = '/api/chats/get';
        body = { ch_name: character.name, file_name: chatId, avatar_url: character.avatar };
    }
    const response = await fetchImpl(endpoint, {
        method: 'POST',
        signal,
        headers,
        credentials: 'same-origin',
        cache: 'no-store',
        body: JSON.stringify(body),
    });
    if (!response.ok) throw new Error(`服务器读取失败：HTTP ${response.status}`);
    const data = await response.json();
    if (!Array.isArray(data) || !data.length || !data[0] || !Object.hasOwn(data[0], 'chat_metadata')) {
        throw new Error('服务器返回无法验证的聊天数据');
    }
    const metadata = data[0].chat_metadata ?? {};
    const expectedIntegrity = context.chatMetadata?.integrity;
    if (expectedIntegrity && metadata.integrity && expectedIntegrity !== metadata.integrity) throw new Error('服务器聊天身份与当前页面不一致');
    return metadata.cache_memory ?? null;
}
