import { fnv1a } from './utils.js?v=1.22.0';

export const API_CACHE_TTLS = Object.freeze(['5m', '1h']);
export const API_CACHE_COMPATIBILITY = Object.freeze({
    AUTO: 'auto',
    ANTHROPIC_BLOCKS: 'anthropic-blocks',
});

export const DEFAULT_API_CACHE_POLICY = Object.freeze({
    enabled: false,
    ttl: '5m',
    cacheStatic: true,
    cacheMemory: true,
    cacheHistory: true,
    historyDepth: 4,
    compatibility: API_CACHE_COMPATIBILITY.AUTO,
});

export function normalizeApiCachePolicy(value = {}) {
    const source = value && typeof value === 'object' ? value : {};
    const parsedDepth = Number(source.historyDepth);
    return {
        enabled: source.enabled === true,
        ttl: API_CACHE_TTLS.includes(source.ttl) ? source.ttl : DEFAULT_API_CACHE_POLICY.ttl,
        cacheStatic: source.cacheStatic !== false,
        cacheMemory: source.cacheMemory !== false,
        cacheHistory: source.cacheHistory !== false,
        historyDepth: Math.min(64, Math.max(1, Number.isFinite(parsedDepth) ? Math.round(parsedDepth) : DEFAULT_API_CACHE_POLICY.historyDepth)),
        compatibility: Object.values(API_CACHE_COMPATIBILITY).includes(source.compatibility)
            ? source.compatibility : DEFAULT_API_CACHE_POLICY.compatibility,
    };
}

export function normalizeApiCacheConnections(value) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
    return Object.fromEntries(Object.entries(value).slice(0, 100)
        .filter(([key]) => /^cm-[0-9a-z]{1,8}$/.test(key))
        .map(([key, policy]) => [key, normalizeApiCachePolicy(policy)]));
}

function safeUrlLabel(value) {
    try {
        const url = new URL(String(value || ''));
        return `${url.host}${url.pathname === '/' ? '' : url.pathname.replace(/\/$/, '')}`;
    } catch {
        return '';
    }
}

export function describeApiConnection(payload = {}) {
    const source = String(payload.chat_completion_source || 'unknown').trim().toLowerCase();
    const model = String(payload.model || 'unknown').trim();
    const endpoint = source === 'custom' ? safeUrlLabel(payload.custom_url) : safeUrlLabel(payload.reverse_proxy);
    const signature = [source, endpoint, model].join('|');
    return {
        key: `cm-${fnv1a(signature)}`,
        source,
        model,
        endpoint,
        label: `${source} · ${model}${endpoint ? ` · ${endpoint}` : ''}`,
    };
}

export function resolveApiCachePolicy(settings, connectionKey) {
    const fallback = normalizeApiCachePolicy(settings?.apiCacheDefaultPolicy);
    return normalizeApiCachePolicy(settings?.apiCacheConnections?.[connectionKey] ?? fallback);
}

function isGenerateRequest(resource, init) {
    const raw = typeof resource === 'string' ? resource : resource?.url;
    if (!raw || String(init?.method || resource?.method || 'GET').toUpperCase() !== 'POST') return false;
    try {
        const url = new URL(raw, globalThis.location?.href || 'http://localhost');
        return url.pathname === '/api/backends/chat-completions/generate';
    } catch {
        return raw === '/api/backends/chat-completions/generate';
    }
}

function parsePreviewHeader(response) {
    const raw = response?.headers?.get?.('x-cache-memory-adapter-preview');
    if (!raw) return null;
    try { return JSON.parse(decodeURIComponent(raw)); }
    catch { return null; }
}

export class ApiCacheAdapterBridge {
    constructor({ getSettings, updateSettings, fetchImpl, onStatus } = {}) {
        this.getSettings = getSettings;
        this.updateSettings = updateSettings;
        this.fetchImpl = fetchImpl;
        this.onStatus = onStatus;
        this.available = false;
        this.capabilities = null;
        this.currentConnection = null;
        this.installedTarget = null;
        this.originalFetch = null;
        this.status = { state: 'idle', message: '尚未检测服务端适配器', preview: null };
    }

    report(state, message, preview = this.status.preview) {
        this.status = { state, message, preview };
        this.onStatus?.(this.status);
    }

    async probe() {
        const fetcher = this.originalFetch ?? this.fetchImpl ?? globalThis.fetch?.bind(globalThis);
        if (!fetcher) return false;
        try {
            const response = await fetcher('/api/plugins/cache-memory-api-adapter/status', {
                method: 'GET', credentials: 'same-origin', cache: 'no-store',
            });
            if (!response.ok) throw new Error(`HTTP ${response.status}`);
            const data = await response.json();
            this.available = data?.id === 'cache-memory-api-adapter' && data?.coreDelegation === true;
            this.capabilities = data;
            this.report(this.available ? 'ready' : 'unavailable', this.available
                ? '服务端适配器已就绪；请求改写在 SillyTavern 服务端完成'
                : '服务端返回了不兼容的适配器状态');
        } catch (error) {
            this.available = false;
            this.capabilities = null;
            this.report('unavailable', `服务端适配器不可用，主请求保持原样：${error.message}`);
        }
        return this.available;
    }

    install(target = globalThis.window ?? globalThis) {
        if (this.installedTarget || typeof target?.fetch !== 'function') return;
        this.installedTarget = target;
        this.originalFetch = target.fetch.bind(target);
        const bridge = this;
        target.fetch = async function cacheMemoryFetch(resource, init = {}) {
            if (!isGenerateRequest(resource, init)) return bridge.originalFetch(resource, init);
            const settings = bridge.getSettings?.();
            if (!settings?.apiCacheAdapterEnabled || !bridge.available) return bridge.originalFetch(resource, init);
            let payload;
            try { payload = JSON.parse(String(init?.body ?? '')); }
            catch {
                bridge.report('bypassed', '主请求不是可解析的 JSON，缓存适配器已安全旁路');
                return bridge.originalFetch(resource, init);
            }
            if (payload.cache_memory_internal === true) return bridge.originalFetch(resource, init);
            const connection = describeApiConnection(payload);
            bridge.currentConnection = connection;
            if (settings.apiCacheLastConnection !== connection.key || settings.apiCacheLastConnectionLabel !== connection.label) {
                bridge.updateSettings?.({ apiCacheLastConnection: connection.key, apiCacheLastConnectionLabel: connection.label });
            }
            const policy = resolveApiCachePolicy(settings, connection.key);
            if (!policy.enabled) {
                bridge.report('bypassed', `${connection.label}：此连接的 API 缓存策略已关闭`);
                return bridge.originalFetch(resource, init);
            }
            const adaptedBody = JSON.stringify({
                ...payload,
                cache_memory_adapter: { version: 1, connection, policy },
            });
            bridge.report('working', `${connection.label}：正在由服务端构造缓存断点…`);
            let response;
            try {
                response = await bridge.originalFetch('/api/plugins/cache-memory-api-adapter/generate', { ...init, body: adaptedBody });
            } catch (error) {
                bridge.report('error', `服务端适配路由失败；为避免重复调用模型，没有自动重试：${error.message}`);
                throw error;
            }
            const preview = parsePreviewHeader(response);
            if (preview) bridge.report(preview.applied ? 'applied' : 'bypassed', preview.summary || '服务端已处理请求', preview);
            else bridge.report('error', '服务端响应缺少适配器预览；为避免重复调用模型，没有自动重试');
            return response;
        };
    }

    uninstall() {
        if (this.installedTarget && this.originalFetch) this.installedTarget.fetch = this.originalFetch;
        this.installedTarget = null;
        this.originalFetch = null;
    }

    currentPolicy() {
        const settings = this.getSettings?.() ?? {};
        const key = this.currentConnection?.key || settings.apiCacheLastConnection;
        return { key, policy: resolveApiCachePolicy(settings, key), label: this.currentConnection?.label || settings.apiCacheLastConnectionLabel || '默认策略（尚未识别主模型连接）' };
    }

    updateCurrentPolicy(patch) {
        const settings = this.getSettings?.() ?? {};
        const { key, policy } = this.currentPolicy();
        const nextPolicy = normalizeApiCachePolicy({ ...policy, ...patch });
        if (!key) return this.updateSettings?.({ apiCacheDefaultPolicy: nextPolicy });
        const connections = normalizeApiCacheConnections(settings.apiCacheConnections);
        return this.updateSettings?.({ apiCacheConnections: { ...connections, [key]: nextPolicy } });
    }

    resetCurrentPolicy() {
        const settings = this.getSettings?.() ?? {};
        const { key } = this.currentPolicy();
        if (!key) return;
        const connections = { ...normalizeApiCacheConnections(settings.apiCacheConnections) };
        delete connections[key];
        this.updateSettings?.({ apiCacheConnections: connections });
    }
}
