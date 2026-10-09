const BASE = '/api/plugins/cache-memory-memory';

export class MemoryServerClient {
    constructor({ fetchImpl = globalThis.fetch, getHeaders, onStatus = () => {}, storage = null } = {}) {
        this.fetchImpl = fetchImpl;
        this.getHeaders = getHeaders;
        this.onStatus = onStatus;
        this.storage = storage;
        try { this.available = storage?.getItem('cache_memory_authority_seen_v1') === 'true'; } catch { this.available = false; }
    }

    async request(path, init = {}) {
        const authHeaders = this.getHeaders?.();
        if (!authHeaders || typeof authHeaders !== 'object') throw new Error('SillyTavern 请求头不可用，未发送权威记忆请求');
        const headers = { ...authHeaders, 'Content-Type': 'application/json' };
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), 40000);
        try {
            const response = await this.fetchImpl(`${BASE}${path}`, { ...init, signal: controller.signal, headers, credentials: 'same-origin', cache: 'no-store' });
            const data = await response.json();
            if (!response.ok) { const error = new Error(data.error || `HTTP ${response.status}`); error.status = response.status; error.data = data; throw error; }
            return data;
        } finally { clearTimeout(timer); }
    }

    async probe() {
        try {
            const data = await this.request('/status', { method: 'GET' });
            if (data.id !== 'cache-memory-memory' || !data.atomic || !data.revisionCheck || !data.userScoped) throw new Error('权威库能力校验失败');
            this.available = true;
            try { this.storage?.setItem('cache_memory_authority_seen_v1', 'true'); } catch { /* Availability remains latched in this session. */ }
            return data;
        } catch (error) {
            // A network outage must never silently change an established authority.
            this.onStatus('unavailable', error.message); return null;
        }
    }

    async read(chatId) { return this.request(`/memory/${encodeURIComponent(chatId)}`, { method: 'GET' }); }

    async commit(chatId, payload) {
        const result = await this.request(`/memory/${encodeURIComponent(chatId)}`, { method: 'POST', body: JSON.stringify(payload) });
        this.onStatus('committed', '已提交到服务器权威记忆库');
        return result;
    }
}
