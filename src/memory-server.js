const BASE = '/api/plugins/cache-memory-memory';

export class MemoryServerClient {
    constructor({ fetchImpl = globalThis.fetch, getHeaders, onStatus = () => {} } = {}) {
        this.fetchImpl = fetchImpl;
        this.getHeaders = getHeaders;
        this.onStatus = onStatus;
        this.available = false;
    }

    async request(path, init = {}) {
        const authHeaders = this.getHeaders?.();
        if (!authHeaders || typeof authHeaders !== 'object') throw new Error('SillyTavern 请求头不可用，未发送权威记忆请求');
        const headers = { ...authHeaders, 'Content-Type': 'application/json' };
        const response = await this.fetchImpl(`${BASE}${path}`, { ...init, headers, credentials: 'same-origin', cache: 'no-store' });
        const data = await response.json().catch(() => ({}));
        if (!response.ok) { const error = new Error(data.error || `HTTP ${response.status}`); error.status = response.status; error.data = data; throw error; }
        return data;
    }

    async probe() {
        try { const data = await this.request('/status', { method: 'GET' }); this.available = data.id === 'cache-memory-memory' && data.atomic && data.revisionCheck && data.userScoped; return data; }
        catch (error) { this.available = false; this.onStatus('unavailable', error.message); return null; }
    }

    async read(chatId) { return this.request(`/memory/${encodeURIComponent(chatId)}`, { method: 'GET' }); }

    async commit(chatId, payload) {
        const result = await this.request(`/memory/${encodeURIComponent(chatId)}`, { method: 'POST', body: JSON.stringify(payload) });
        this.onStatus('committed', '已提交到服务器权威记忆库');
        return result;
    }
}
