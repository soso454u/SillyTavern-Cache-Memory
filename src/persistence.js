import { memoryContentDigest, mergeMemoryStores, normalizeStore } from './memory-store.js?v=1.20.0';

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
        this.sequence = 0;
        this.timeoutMs = timeoutMs;
        this.epoch = 0;
        this.uncertainWrites = new Map();
        this.pending = new Map();
        this.baselines = new Map();
        this.states = new Map();
        this.conflicts = new Map();
        this.running = new Map();
        this.restorePending();
    }

    restorePending() {
        if (!this.storage) return;
        try {
            const entries = JSON.parse(this.storage.getItem(STORAGE_KEY) || '[]');
            for (const entry of Array.isArray(entries) ? entries : []) {
                if (!entry?.chatId || !entry?.snapshot) continue;
                this.pending.set(String(entry.chatId), entry);
                this.sequence = Math.max(this.sequence, Number(entry.sequence) || 0);
                if (entry.conflict) this.conflicts.set(String(entry.chatId), entry.conflict);
                this.states.set(String(entry.chatId), { state: entry.conflict ? MEMORY_SAVE_STATES.CONFLICT : MEMORY_SAVE_STATES.PENDING, detail: '浏览器中有尚未确认写入服务器的记忆', at: new Date().toISOString() });
            }
        } catch (error) {
            console.warn('[Cache Memory] Unable to restore pending memory saves:', error);
        }
    }

    persistPending() {
        if (!this.storage) return true;
        try {
            this.storage.setItem(STORAGE_KEY, JSON.stringify([...this.pending.values()]));
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

    activate(chatId, loadedValue) {
        const id = String(chatId ?? '');
        if (!id) return null;
        this.epoch++;
        const loaded = normalizeStore(clone(loadedValue), id);
        const loadedDigest = memoryContentDigest(loaded);
        const pending = this.pending.get(id);
        if (pending?.conflict) {
            this.getMetadata().cache_memory = clone(pending.snapshot);
            this.setState(id, MEMORY_SAVE_STATES.CONFLICT, '已恢复尚未解决的冲突副本，请先导出并核对双方版本');
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
        if (loadedDigest !== pending.baseDigest) {
            this.conflicts.set(id, { remote: loaded, local: clone(pending.snapshot), detectedAt: new Date().toISOString() });
            this.setState(id, MEMORY_SAVE_STATES.CONFLICT, '服务器记忆已变化；本机待保存副本已保留，未覆盖服务器');
            return loaded;
        }
        this.getMetadata().cache_memory = clone(pending.snapshot);
        this.baselines.set(id, { digest: loadedDigest, revision: loaded.sync.revision, snapshot: clone(loaded) });
        this.setState(id, MEMORY_SAVE_STATES.PENDING, '已恢复本机尚未确认保存的记忆');
        queueMicrotask(() => this.flush(id));
        return this.getMetadata().cache_memory;
    }

    async sync(chatId = this.getChatId(), loadedValue = this.getMetadata().cache_memory) {
        const id = String(chatId ?? '');
        if (!id || !this.readAuthoritativeStore || !this.authoritativeAvailable() || String(this.getChatId() ?? '') !== id) return loadedValue;
        if (this.pending.has(id)) { await this.flush(id); return String(this.getChatId()) === id ? this.getMetadata().cache_memory : loadedValue; }
        const epoch = this.epoch;
        const initialDigest = memoryContentDigest(this.getMetadata().cache_memory);
        try {
            const record = await withDeadline(() => this.readAuthoritativeStore(id), this.timeoutMs);
            if (String(this.getChatId()) !== id || epoch !== this.epoch) return loadedValue;
            if (this.pending.has(id) || memoryContentDigest(this.getMetadata().cache_memory) !== initialDigest) return this.getMetadata().cache_memory;
            if (!record?.store) {
                if (this.storage) {
                    try {
                        this.storage.setItem(`${MIGRATION_BACKUP_PREFIX}${id}`, JSON.stringify({ savedAt: new Date().toISOString(), snapshot: loadedValue }));
                    } catch (error) { throw new Error(`迁移备份失败，未迁移：${error.message}`); }
                }
                this.baselines.set(id, { digest: memoryContentDigest(normalizeStore(loadedValue, id)), revision: 0, snapshot: clone(normalizeStore(loadedValue, id)) });
                if (loadedValue) this.enqueue(loadedValue, 'initial authoritative migration');
                return loadedValue;
            }
            const remote = normalizeStore(clone(record.store), id);
            remote.sync.revision = Number(record.revision || 0);
            const remoteDigest = memoryContentDigest(remote);
            // A populated metadata copy may contain records absent from the optional
            // server store (e.g. an older device still using native persistence).
            const local = normalizeStore(clone(loadedValue), id);
            const comparison = mergeMemoryStores(remote, local, id);
            if (comparison.added.total || comparison.conflicts.length) {
                this.conflicts.set(id, { remote, local, detectedAt: new Date().toISOString() });
                this.setState(id, MEMORY_SAVE_STATES.CONFLICT, '本地聊天元数据与权威库存在独有或冲突记忆，已保留双方；请检查并合并');
                return local;
            }
            const pending = this.pending.get(id);
            const pendingDigest = pending ? memoryContentDigest(normalizeStore(pending.snapshot, id)) : '';
            if (pending && pendingDigest === remoteDigest) {
                this.pending.delete(id);
                this.persistPending();
            } else if (pending && pendingDigest !== remoteDigest) {
                this.conflicts.set(id, { remote, local: clone(pending.snapshot), detectedAt: new Date().toISOString() });
                this.setState(id, MEMORY_SAVE_STATES.CONFLICT, '权威记忆库已有其他设备版本；本机副本未覆盖服务器');
                return remote;
            }
            this.getMetadata().cache_memory = remote;
            this.baselines.set(id, { digest: remoteDigest, revision: Number(record.revision || 0), snapshot: clone(remote) });
            this.pending.delete(id);
            this.persistPending();
            this.setState(id, MEMORY_SAVE_STATES.CONFIRMED, '已从服务器权威记忆库恢复最新版本');
            return remote;
        } catch (error) {
            this.setState(id, MEMORY_SAVE_STATES.FAILED, `无法读取权威记忆库：${error.message}`);
            return loadedValue;
        }
    }

    async verify(chatId = this.getChatId()) {
        const id = String(chatId ?? '');
        if (!id) return this.getState(id);
        if (this.readAuthoritativeStore && this.authoritativeAvailable()) return this.sync(id, this.getMetadata().cache_memory).then(() => this.getState(id));
        if (this.pending.has(id)) return this.flush(id);
        if (String(this.getChatId() ?? '') !== id) return this.getState(id);
        const local = normalizeStore(clone(this.getMetadata().cache_memory), id);
        const localDigest = memoryContentDigest(local);
        let remote;
        try {
            remote = normalizeStore(await withDeadline(() => this.readRemoteStore(id), this.timeoutMs), id);
        } catch (error) {
            this.setState(id, MEMORY_SAVE_STATES.UNKNOWN, `无法验证服务器持久化状态：${error.message}`);
            return this.getState(id);
        }
        if (String(this.getChatId() ?? '') !== id) return this.getState(id);
        if (this.pending.has(id)) return this.flush(id);
        if (memoryContentDigest(this.getMetadata().cache_memory) !== localDigest) {
            this.setState(id, MEMORY_SAVE_STATES.UNKNOWN, '验证期间本机记忆发生变化，等待保存队列确认');
            return this.getState(id);
        }
        const remoteDigest = memoryContentDigest(remote);
        if (remoteDigest !== localDigest) {
            this.conflicts.set(id, { remote, local, detectedAt: new Date().toISOString() });
            this.setState(id, MEMORY_SAVE_STATES.CONFLICT, '服务器与当前页面记忆不同；双方副本均已保留，未自动覆盖');
            return this.getState(id);
        }
        this.baselines.set(id, { digest: remoteDigest, revision: remote.sync.revision, snapshot: clone(remote) });
        this.setState(id, MEMORY_SAVE_STATES.CONFIRMED, '已从服务器读回并确认当前记忆');
        return this.getState(id);
    }

    enqueue(value, reason = 'memory changed') {
        const snapshot = normalizeStore(clone(value), value?.chatId || this.getChatId());
        const chatId = String(snapshot.chatId ?? '');
        if (!chatId) return Promise.resolve({ state: MEMORY_SAVE_STATES.UNKNOWN });
        const previous = this.pending.get(chatId);
        if (this.conflicts.has(chatId)) {
            const conflict = this.conflicts.get(chatId);
            // Preserve new edits as the recoverable local branch of the conflict.
            conflict.local = clone(snapshot);
        }
        const baseline = this.baselines.get(chatId);
        const entry = {
            chatId,
            snapshot,
            digest: memoryContentDigest(snapshot),
            baseDigest: previous?.baseDigest ?? baseline?.digest ?? memoryContentDigest(snapshot),
            baseSnapshot: previous?.baseSnapshot ?? baseline?.snapshot ?? clone(snapshot),
            reason,
            sequence: ++this.sequence,
            queuedAt: new Date().toISOString(),
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
        const task = this.process(id).catch(error => this.setState(id, MEMORY_SAVE_STATES.FAILED, error.message)).finally(() => this.running.delete(id));
        this.running.set(id, task);
        return task;
    }

    async process(chatId) {
        while (this.pending.has(chatId)) {
            if (String(this.getChatId() ?? '') !== chatId) {
                this.setState(chatId, MEMORY_SAVE_STATES.PENDING, '聊天已切换；等待该聊天再次激活后保存');
                return this.getState(chatId);
            }
            const entry = this.pending.get(chatId);
            const epoch = this.epoch;
            const stillActive = () => String(this.getChatId() ?? '') === chatId && epoch === this.epoch;
            const useAuthority = Boolean(this.readAuthoritativeStore && this.commitAuthoritative && this.authoritativeAvailable());
            if (this.conflicts.has(chatId)) return this.getState(chatId);
            this.setState(chatId, MEMORY_SAVE_STATES.SAVING, '正在核对服务器版本并保存');
            let remote;
            let authoritativeRecord = null;
            try {
                const authoritative = await withDeadline(() => useAuthority ? this.readAuthoritativeStore(chatId) : this.readRemoteStore(chatId), this.timeoutMs);
                authoritativeRecord = useAuthority ? authoritative : null;
                remote = normalizeStore(useAuthority ? authoritative?.store : authoritative, chatId);
                if (useAuthority) remote.sync.revision = Number(authoritativeRecord?.revision || 0);
            } catch (error) {
                this.setState(chatId, MEMORY_SAVE_STATES.FAILED, `无法读取服务器版本，已停止写入：${error.message}`);
                return this.getState(chatId);
            }
            if (!stillActive()) return this.setState(chatId, MEMORY_SAVE_STATES.PENDING, '聊天已切换或重载，旧读取结果未应用');
            if (this.pending.get(chatId)?.sequence !== entry.sequence) continue;
            const remoteDigest = memoryContentDigest(remote);
            if (remoteDigest === entry.digest) {
                this.pending.delete(chatId);
                this.persistPending();
                this.baselines.set(chatId, { digest: remoteDigest, revision: authoritativeRecord?.revision ?? remote.sync.revision, snapshot: clone(remote) });
                this.setState(chatId, MEMORY_SAVE_STATES.CONFIRMED, '服务器读回内容与当前记忆一致');
                continue;
            }
            const firstAuthoritativeWrite = Boolean(useAuthority && !authoritativeRecord?.store
                && Number(this.baselines.get(chatId)?.revision ?? 0) === 0);
            if (remoteDigest !== entry.baseDigest && !firstAuthoritativeWrite) {
                this.conflicts.set(chatId, { remote, local: clone(entry.snapshot), detectedAt: new Date().toISOString() });
                this.setState(chatId, MEMORY_SAVE_STATES.CONFLICT, '检测到另一设备写入；已阻止本机旧数据覆盖服务器');
                return this.getState(chatId);
            }
            if (this.pending.get(chatId)?.sequence !== entry.sequence) continue;
            if (this.uncertainWrites.has(chatId)) return this.setState(chatId, MEMORY_SAVE_STATES.FAILED, '前次保存超时且底层请求尚未结束；保留副本，暂不并发重写。可导出后刷新再核验');

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
                            baseSnapshot: entry.baseSnapshot,
                            baseRevision: this.baselines.get(chatId)?.revision ?? remote.sync.revision,
                            writerId: this.writerId,
                        }), this.timeoutMs);
                    } catch (error) {
                        if (error.status === 409) {
                            const conflictRemote = normalizeStore(clone(error.data?.record?.store || remote), chatId);
                            conflictRemote.sync.revision = Number(error.data?.record?.revision ?? remote.sync.revision);
                            this.conflicts.set(chatId, { remote: conflictRemote, local: clone(entry.snapshot), detectedAt: new Date().toISOString() });
                            this.setState(chatId, MEMORY_SAVE_STATES.CONFLICT, '权威记忆库检测到修订冲突；服务器版本和本机副本均已保留');
                            return this.getState(chatId);
                        }
                        throw error;
                    }
                    if (!result?.record?.store || !Number.isInteger(result.record.revision)) throw new Error('权威库未返回有效提交确认');
                    const committed = normalizeStore(clone(result.record.store), chatId);
                    if (stillActive() && this.pending.get(chatId)?.sequence === entry.sequence) this.getMetadata().cache_memory = committed;
                    this.baselines.set(chatId, { digest: memoryContentDigest(committed), revision: Number(result.record?.revision || remote.sync.revision + 1), snapshot: clone(committed) });
                    const latest = this.pending.get(chatId);
                    if (latest?.sequence === entry.sequence) this.pending.delete(chatId);
                    else if (latest) {
                        latest.baseDigest = memoryContentDigest(committed);
                        latest.baseSnapshot = clone(committed);
                    }
                    this.persistPending();
                    this.setState(chatId, MEMORY_SAVE_STATES.CONFIRMED, '已提交到服务器权威记忆库并确认原子写入');
                    continue;
                }
                const write = Promise.resolve().then(() => this.saveMetadata(chatId));
                this.uncertainWrites.set(chatId, write);
                write.then(() => this.uncertainWrites.delete(chatId), () => this.uncertainWrites.delete(chatId));
                await withDeadline(() => write, this.timeoutMs);
            } catch (error) {
                this.setState(chatId, MEMORY_SAVE_STATES.FAILED, `SillyTavern 保存调用失败：${error.message}`);
                return this.getState(chatId);
            }
            if (!stillActive()) {
                this.setState(chatId, MEMORY_SAVE_STATES.UNKNOWN, '保存期间聊天已切换；待重新读回确认');
                return this.getState(chatId);
            }
            let verified;
            try {
                verified = normalizeStore(await withDeadline(() => this.readRemoteStore(chatId), this.timeoutMs), chatId);
            } catch (error) {
                this.setState(chatId, MEMORY_SAVE_STATES.FAILED, `SillyTavern 未报告结果，且服务器读回失败：${error.message}`);
                return this.getState(chatId);
            }
            const verifiedDigest = memoryContentDigest(verified);
            if (verified.sync.writeId !== desired.sync.writeId || verifiedDigest !== entry.digest) {
                if (verifiedDigest === remoteDigest) {
                    this.setState(chatId, MEMORY_SAVE_STATES.FAILED, 'SillyTavern 保存调用已返回，但服务器内容没有变化；待保存副本已保留');
                    return this.getState(chatId);
                }
                this.conflicts.set(chatId, { remote: verified, local: clone(entry.snapshot), detectedAt: new Date().toISOString() });
                this.setState(chatId, MEMORY_SAVE_STATES.CONFLICT, '保存后读回内容不一致；双方副本均已保留');
                return this.getState(chatId);
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

    resolveConflictByMerge(chatId = this.getChatId()) {
        const id = String(chatId ?? '');
        const conflict = this.conflicts.get(id);
        if (!conflict || String(this.getChatId()) !== id) return null;
        const result = mergeMemoryStores(conflict.remote, conflict.local, id);
        if (result.conflicts.length) {
            this.setState(id, MEMORY_SAVE_STATES.CONFLICT, `有 ${result.conflicts.length} 个同 ID 内容冲突，未自动覆盖`);
            return result;
        }
        this.getMetadata().cache_memory = result.merged;
        this.conflicts.delete(id);
        this.baselines.set(id, { digest: memoryContentDigest(conflict.remote), revision: conflict.remote.sync.revision, snapshot: clone(conflict.remote) });
        this.pending.delete(id);
        this.enqueue(result.merged, 'cross-device merge');
        return result;
    }

    resolveConflictByRestore(chatId = this.getChatId()) {
        const id = String(chatId ?? '');
        const conflict = this.conflicts.get(id);
        if (!conflict || String(this.getChatId()) !== id) return null;
        this.getMetadata().cache_memory = clone(conflict.local);
        this.conflicts.delete(id);
        this.baselines.set(id, { digest: memoryContentDigest(conflict.remote), revision: conflict.remote.sync.revision, snapshot: clone(conflict.remote) });
        this.pending.delete(id);
        this.enqueue(this.getMetadata().cache_memory, 'user restored local conflict copy');
        return this.getMetadata().cache_memory;
    }
}

export async function readSillyTavernRemoteStore(getContext, chatId, fetchImpl = globalThis.fetch) {
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
