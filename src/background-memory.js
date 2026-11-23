import { MemoryStore, normalizeStore, memoryContentDigest } from './memory-store.js?v=1.27.38';
import { MemorySummarizer } from './summarizer.js?v=1.27.38';
import { MemoryPersistenceCoordinator } from './persistence.js?v=1.27.38';
import { chatFileIdentity } from './chat-file.js?v=1.27.38';
import { trimBranchTimeline } from './utils.js?v=1.27.38';

const clone = value => structuredClone(value);
const filename = value => String(value ?? '').replace(/\.jsonl$/iu, '');
const stopped = message => Object.assign(new Error(message), { code: 'REQUEST_ABORTED' });

// Independent contexts: no openCharacterChat, global chat assignment, prompt
// injection or use of the foreground model client's abort controller.
export class BackgroundMemoryTasks {
    constructor({ getContext, getSettings, createApiClient, fetchImpl = globalThis.fetch, memoryServer, onChange = () => {} }) {
        Object.assign(this, { getContext, getSettings, createApiClient, fetchImpl, memoryServer, onChange });
        this.state = { status: 'idle', message: '选择其他角色的聊天，在本页面后台补全记忆。' };
    }

    publish(patch) { Object.assign(this.state, patch); this.onChange({ ...this.state }); }

    async request(path, body, signal) {
        const headers = this.getContext()?.getRequestHeaders?.();
        if (!headers) throw new Error('当前酒馆未提供聊天接口请求头');
        const response = await this.fetchImpl(path, { method: 'POST', headers, signal, credentials: 'same-origin', cache: 'no-store', body: JSON.stringify(body) });
        if (!response.ok) throw new Error(`聊天接口失败：HTTP ${response.status}`);
        const value = await response.json();
        if (value?.error) throw new Error(`聊天接口返回错误：${value.error}`);
        return value;
    }

    characters() {
        return (this.getContext()?.characters ?? []).filter(row => row?.avatar)
            .map(row => ({ avatar: row.avatar, name: row.name || row.avatar }));
    }

    async listChats(avatar) {
        if (!this.characters().some(row => row.avatar === avatar)) throw new Error('所选角色已不存在，请刷新角色列表');
        const rows = await this.request('/api/characters/chats', { avatar_url: avatar, simple: true });
        if (!Array.isArray(rows) && (!rows || typeof rows !== 'object')) throw new Error('酒馆未返回有效聊天列表');
        const files = (Array.isArray(rows) ? rows : Object.values(rows)).map(row => filename(row?.file_name ?? row?.file_id)).filter(Boolean);
        return [...new Set(files)].sort((a, b) => a.localeCompare(b));
    }

    async previewChat(avatar, file, { signal } = {}) {
        const character = this.characters().find(row => row.avatar === avatar);
        if (!character || !file || typeof file !== 'string') throw new Error('请选择有效的角色聊天');
        const rows = await this.request('/api/chats/get', { avatar_url: avatar, ch_name: character.name, file_name: file }, signal);
        if (!Array.isArray(rows) || !rows[0]?.chat_metadata
            || rows.slice(1).some(row => !row || typeof row.mes !== 'string')) throw new Error('聊天内容读取不完整，请重试');
        // Preview needs no metadata, memory, Swipe alternatives or generated
        // markup. Keep just the visible transcript in the current page.
        return rows.slice(1).map(row => ({ text: row.mes,
            name: String(row.name || (row.is_system ? '系统' : row.is_user ? '用户' : character.name)) }));
    }

    cancel() {
        this.controller?.abort(); this.client?.abortAll(); this.summarizer?.invalidateContext();
    }

    stopIfOpened() {
        if (this.active && chatFileIdentity(this.getContext()) === this.targetId) this.cancel();
    }

    async start(avatar, files) {
        if (this.active) throw new Error('后台任务正在运行，请先停止');
        const character = this.characters().find(row => row.avatar === avatar);
        if (!character || !Array.isArray(files) || !files.length) throw new Error('请选择角色与聊天');
        files = [...new Set(files)];
        const settings = clone(this.getSettings());
        if (!settings.independentApi) throw new Error('请先启用独立总结接口并配置模型');
        this.controller = new AbortController();
        this.active = true;
        this.publish({ status: 'running', completed: 0, total: files.length, message: '正在启动后台总结…' });
        try {
            this.client = this.createApiClient(() => settings);
            const available = new Set(await this.listChats(avatar));
            if (files.some(file => !available.has(file))) throw new Error('聊天列表已变化，请重新选择');
            for (const file of files) {
                this.targetId = JSON.stringify(['character', avatar, file]);
                this.assertRunning();
                this.publish({ message: `正在处理「${character.name} / ${file}」` });
                await this.runChat(character, file, settings);
                this.publish({ completed: this.state.completed + 1 });
            }
            this.publish({ status: 'completed', message: `已完成 ${files.length} 份聊天，记忆已分别保存并读回确认。` });
        } catch (error) {
            this.publish({ status: this.controller.signal.aborted ? 'cancelled' : 'failed', message: `已完成 ${this.state.completed}/${files.length} 份；${error.message}` });
        } finally {
            this.client?.abortAll(); this.summarizer?.invalidateContext();
            this.active = false; this.targetId = null;
        }
        return { ...this.state };
    }

    assertRunning() {
        if (this.controller?.signal.aborted) throw stopped('后台总结已停止，已确认的记忆保留');
        if (chatFileIdentity(this.getContext()) === this.targetId) throw stopped('目标聊天已在前台打开，后台任务停止；可在该聊天继续补全');
    }

    async runChat(character, file, settings) {
        const id = this.targetId, signal = this.controller.signal;
        const body = { avatar_url: character.avatar, ch_name: character.name, file_name: file };
        const read = () => this.request('/api/chats/get', body, signal);
        const original = await read();
        if (!Array.isArray(original) || !original.length || !original[0]?.chat_metadata
            || original.slice(1).some(row => !row || typeof row.mes !== 'string')) throw new Error('聊天正文读取不完整，未生成或覆盖');
        let transcript = JSON.stringify(original.slice(1));
        const integrity = original[0].chat_metadata.integrity;
        const readChecked = async () => {
            this.assertRunning();
            const rows = await read();
            this.assertRunning();
            if (!Array.isArray(rows) || !rows[0]?.chat_metadata || JSON.stringify(rows.slice(1)) !== transcript
                || rows[0].chat_metadata.integrity !== integrity) throw new Error('目标聊天正文或文件身份已变化，后台任务停止');
            return rows;
        };
        if (original[0].chat_metadata.cache_memory?.chatId && original[0].chat_metadata.cache_memory.chatId !== id)
            throw new Error('该聊天的记忆身份尚未迁移，请先在酒馆打开它完成核对');
        const metadata = clone(original[0].chat_metadata), chat = clone(original.slice(1));
        metadata.cache_memory = normalizeStore(metadata.cache_memory, id);
        let nativeBase;
        const readNative = async () => {
            const rows = await readChecked();
            const memory = rows[0].chat_metadata.cache_memory;
            if (memory?.chatId && memory.chatId !== id) throw new Error('服务器记忆身份已变化');
            nativeBase = normalizeStore(memory, id);
            return nativeBase;
        };
        await readNative();
        const saveNative = async snapshot => {
            const rows = await readChecked();
            const remote = normalizeStore(rows[0].chat_metadata.cache_memory, id);
            if (memoryContentDigest(remote) !== memoryContentDigest(nativeBase)) throw new Error('聊天记忆已被其他窗口修改，停止后台保存');
            rows[0].chat_metadata.cache_memory = clone(snapshot);
            // Only branch numbering metadata can differ from the captured raw
            // transcript here; the messages themselves are never regenerated.
            const desiredTranscript = JSON.stringify(chat);
            if (desiredTranscript !== transcript) rows.splice(1, rows.length - 1, ...clone(chat));
            this.assertRunning();
            await this.request('/api/chats/save', { ...body, chat: rows, force: false }, signal);
            transcript = desiredTranscript;
            const saved = await readChecked();
            if (memoryContentDigest(saved[0].chat_metadata.cache_memory) !== memoryContentDigest(snapshot)) throw new Error('目标聊天记忆尚未通过读回确认');
            nativeBase = clone(snapshot);
        };
        const server = this.memoryServer;
        const coordinator = new MemoryPersistenceCoordinator({
            getChatId: () => id, getMetadata: () => metadata, storage: null, durableStorage: null,
            readRemoteStore: readNative,
            saveMetadata: () => saveNative(metadata.cache_memory),
            readAuthoritativeStore: server ? async () => { await readChecked(); return server.read(id, { signal }); } : null,
            commitAuthoritative: server ? async (_, payload) => {
                await readChecked(); this.assertRunning();
                const result = await server.commit(id, payload);
                await saveNative(result.record.store);
                return result;
            } : null,
            authoritativeAvailable: () => Boolean(server?.available),
        });
        this.coordinator = coordinator;
        const store = new MemoryStore({ getChatId: () => id, getMetadata: () => metadata,
            saveMetadata: (snapshot, reason) => coordinator.enqueue(snapshot, reason) });
        await coordinator.ready;
        coordinator.activate(id, store.current());
        await coordinator.loadLatest(id);
        if (['failed', 'conflict'].includes(coordinator.getState(id).state)) throw new Error(coordinator.getState(id).detail);
        const changedFloor = store.changedTimelineFloor(chat);
        if (changedFloor !== null) {
            trimBranchTimeline(chat, changedFloor);
            store.discardTimelineFrom(changedFloor);
            const saved = await coordinator.flush(id);
            if (saved.state !== 'confirmed') throw new Error(saved.detail);
        }
        const client = this.client;
        this.summarizer = new MemorySummarizer({ store, getChat: () => chat, getSettings: () => settings,
            apiClient: { complete: async request => {
                await readChecked();
                const response = await client.complete(request);
                await readChecked();
                return response;
            } },
            getPersistenceState: () => coordinator.getState(id), flushMemory: () => coordinator.flush(id),
            commitMemory: (mutate, assertActive) => coordinator.commitReplacement(store, mutate, () => { this.assertRunning(); assertActive(); }),
        });
        const result = await this.summarizer.fillMissingMemories({ signal, onProgress: progress => {
            this.publish({ message: `「${character.name} / ${file}」${progress.phase}：${progress.processed}/${progress.total}` });
        } });
        const remaining = this.summarizer.getMissingMemoryPlan();
        if (result.failed || remaining.summaries.length || remaining.checkpoints.length || remaining.longMemories.length)
            throw new Error(result.errors?.join('；') || '该聊天仍有待处理记忆，请检查模型接口后重试');
        await saveNative(store.current());
    }
}
