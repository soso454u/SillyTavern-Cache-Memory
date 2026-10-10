export const API_PROFILE_FIELDS = Object.freeze(['apiBaseUrl', 'model', 'temperature', 'thinkingMode', 'summaryMaxTokens', 'checkpointMaxTokens', 'longMemoryMaxTokens', 'maxTokens', 'tokenLimitParameter', 'generationTransport']);

export const MODEL_LIST_WARNING = '无法获取模型列表，请手动填写模型名称。';
const ST_MODELS_PROXY_PATH = '/api/backends/chat-completions/status';
const ST_GENERATE_PROXY_PATH = '/api/backends/chat-completions/generate';
const STREAM_UNSUPPORTED_STATUS = new Set([400, 404, 405, 406, 415, 422]);

function now() {
    return globalThis.performance?.now?.() ?? Date.now();
}

function elapsed(startedAt) {
    return Math.max(0, Math.round(now() - startedAt));
}

function contentText(value) {
    if (typeof value === 'string') return value;
    if (Array.isArray(value)) return value.map(item => typeof item === 'string' ? item : item?.text ?? item?.content ?? '').join('');
    return value?.text ?? value?.content ?? '';
}

function chunkParts(payload) {
    const choice = payload?.choices?.[0] ?? {};
    const delta = choice.delta ?? choice.message ?? {};
    return {
        content: contentText(delta.content ?? choice.text ?? payload?.response),
        reasoning: contentText(delta.reasoning_content ?? delta.reasoning ?? delta.thinking
            ?? choice.reasoning_content ?? choice.reasoning ?? payload?.reasoning_content ?? payload?.reasoning ?? payload?.thinking),
        finishReason: choice.finish_reason,
    };
}

function responseContentType(response) {
    return String(response?.headers?.get?.('content-type') ?? '');
}

function parseJson(value) {
    try { return JSON.parse(value); } catch { return null; }
}

function errorDetail(data, fallback = '') {
    return typeof data?.error === 'string' ? data.error : data?.error?.message ?? data?.message ?? fallback;
}

function isExplicitStreamUnsupported(error) {
    return STREAM_UNSUPPORTED_STATUS.has(Number(error?.status))
        && /(?:stream(?:ing)?[^\n]{0,40}(?:unsupported|not supported|invalid|unknown|unavailable|not allowed)|(?:unsupported|not supported|invalid|unknown)[^\n]{0,40}stream)/i.test(error?.message ?? '');
}

export async function readOpenAISse(response, { signal, onFirstChunk = () => {}, allowJson = false } = {}) {
    if (!response?.body?.getReader) throw new Error('流式响应没有可读取的 body');
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    let content = '';
    let reasoning = '';
    let finishReason;
    let eventCount = 0;
    let streamDone = false;
    let mode = allowJson ? '' : 'sse';
    let dataLines = [];
    const consumeEvent = () => {
        const value = dataLines.join('\n').trim();
        dataLines = [];
        if (!value) return;
        if (value === '[DONE]') { streamDone = true; return; }
        const data = parseJson(value);
        if (!data) throw new Error('流式响应不是有效 JSON');
        if (data.error) {
            const error = new Error(errorDetail(data, '流式接口返回错误'));
            error.status = Number(data.error?.status ?? data.error?.status_code ?? data.status) || undefined;
            throw error;
        }
        if (!eventCount++) onFirstChunk();
        const parts = chunkParts(data);
        content += parts.content;
        reasoning += parts.reasoning;
        if (parts.finishReason != null) finishReason = parts.finishReason;
    };
    const consumeBuffer = (final = false) => {
        if (!mode) {
            const start = buffer.trimStart();
            if (/^(?:data:|event:|id:|retry:|:)/.test(start)) mode = 'sse';
            else if (start && (final || !['data:', 'event:', 'id:', 'retry:'].some(prefix => prefix.startsWith(start)))) mode = 'json';
        }
        if (mode !== 'sse') return;
        let match;
        while (!streamDone && (match = /\r\n|\r|\n/.exec(buffer))) {
            // Keep a trailing CR until the next chunk so split CRLF stays one newline.
            if (!final && match[0] === '\r' && match.index === buffer.length - 1) break;
            const line = buffer.slice(0, match.index);
            buffer = buffer.slice(match.index + match[0].length);
            if (!line.trim()) consumeEvent();
            else if (line.startsWith('data:')) {
                dataLines.push(line.slice(5).replace(/^ /, ''));
                // Some proxies omit empty separators between complete JSON frames.
                if (dataLines.length === 1 && (dataLines[0].trim() === '[DONE]' || parseJson(dataLines[0]) !== null)) consumeEvent();
            }
        }
        if (final && !streamDone) {
            if (buffer.startsWith('data:')) dataLines.push(buffer.slice(5).replace(/^ /, ''));
            buffer = '';
            consumeEvent();
        }
    };
    const cancel = () => { void reader.cancel().catch(() => {}); };
    signal?.addEventListener('abort', cancel, { once: true });
    try {
        while (!streamDone) {
            if (signal?.aborted) throw new DOMException('Aborted', 'AbortError');
            const { done, value } = await reader.read();
            if (signal?.aborted) throw new DOMException('Aborted', 'AbortError');
            if (done) break;
            buffer += decoder.decode(value, { stream: true });
            consumeBuffer();
        }
        buffer += decoder.decode();
        consumeBuffer(true);
        if (streamDone) await reader.cancel();
        return mode === 'json' ? { raw: buffer } : { content, reasoning, finishReason, eventCount };
    } catch (error) {
        cancel();
        throw error;
    } finally {
        signal?.removeEventListener('abort', cancel);
        reader.releaseLock?.();
    }
}

function trimEndpoint(value) {
    return String(value ?? '').trim().replace(/\/+$/, '');
}

export function normalizeApiBaseUrl(value) {
    const input = trimEndpoint(value);
    if (!input) return '';

    try {
        const url = new URL(input);
        url.hash = '';
        url.pathname = url.pathname.replace(/\/chat\/completions$/i, '').replace(/\/$/, '');
        if (!url.pathname || url.pathname === '/') url.pathname = '/v1';
        url.search = '';
        return url.toString().replace(/\/$/, '');
    } catch {
        const withoutCompletion = input.replace(/\/chat\/completions$/i, '');
        return withoutCompletion.replace(/^(https?:\/\/[^/]+)\/?$/i, '$1/v1');
    }
}

export function normalizeBaseUrl(value) {
    const base = normalizeApiBaseUrl(value);
    return base ? `${base}/chat/completions` : '';
}

export function normalizeModelsUrl(value) {
    const base = normalizeApiBaseUrl(value);
    return base ? `${base}/models` : '';
}

function extractModelArray(payload) {
    const candidates = [
        payload,
        payload?.data,
        payload?.models,
        payload?.data?.models,
        payload?.result?.data,
        payload?.result?.models,
        payload?.result?.data?.models,
    ];
    return candidates.find(Array.isArray) ?? [];
}

export function readModels(payload) {
    const names = extractModelArray(payload).map(item => {
        if (typeof item === 'string') return item.trim();
        if (!item || typeof item !== 'object') return '';
        return String(item.id ?? item.name ?? item.model ?? item.model_id ?? item.model_name ?? '').trim();
    }).filter(Boolean);
    return [...new Set(names)].sort((a, b) => a.localeCompare(b));
}

function safeUrl(value) {
    if (!value) return '';
    try {
        const url = new URL(value, globalThis.location?.href);
        url.username = '';
        url.password = '';
        for (const key of [...url.searchParams.keys()]) {
            if (/key|token|auth|secret/i.test(key)) url.searchParams.set(key, '[REDACTED]');
        }
        return url.toString();
    } catch {
        return String(value).replace(/([?&](?:api[_-]?key|token|auth|secret)=)[^&]*/ig, '$1[REDACTED]');
    }
}

function safeText(value, apiKey, maxLength = 500) {
    let text = String(value ?? '');
    for (const secret of Array.isArray(apiKey) ? apiKey : [apiKey]) {
        if (!secret) continue;
        for (const key of new Set([secret, encodeURIComponent(secret), JSON.stringify(secret).slice(1, -1)])) {
            text = text.split(key).join('[REDACTED]');
        }
    }
    text = text.replace(/Bearer\s+[^\s"'<>]+/gi, 'Bearer [REDACTED]');
    return text.slice(0, maxLength);
}

function errorText(error) {
    return String(error?.message ?? error ?? 'Unknown error');
}

const CUSTOM_BODY_KEYS = [
    'response_format', 'thinking', 'enable_thinking', 'reasoning_effort',
    'top_p', 'top_k', 'min_p', 'presence_penalty', 'frequency_penalty', 'repetition_penalty',
    'seed', 'stop', 'tools', 'tool_choice', 'parallel_tool_calls', 'logit_bias', 'n', 'user',
];
const ST_NATIVE_BODY_KEYS = new Set(['model', 'messages', 'temperature', 'max_tokens', 'max_completion_tokens', 'stream']);

function classifyFailure(status, message, code, proxyRouteMissing = false) {
    if (code === 'CONNECTION_CLOSED') return 'network_error';
    if (code === 'REQUEST_ABORTED') return 'cancelled';
    if (code === 'ST_PROXY_UNAVAILABLE' || code === 'ST_PROXY_ROUTE_MISSING' || code === 'ST_PROXY_HTTP_ERROR' || proxyRouteMissing) return 'proxy_error';
    const numericStatus = Number(status);
    if (numericStatus === 401) return 'authentication_error';
    if (numericStatus === 403) return 'permission_error';
    if (numericStatus === 404) return 'endpoint_error';
    if (numericStatus === 429) return 'rate_limit_error';
    if (numericStatus >= 500) return 'upstream_error';
    const detail = String(message ?? '');
    if (/\bunauthori[sz]ed\b|invalid (?:api )?key|authentication/i.test(detail)) return 'authentication_error';
    if (/\bforbidden\b|permission denied/i.test(detail)) return 'permission_error';
    if (/\bnot found\b|unknown endpoint/i.test(detail)) return 'endpoint_error';
    if (/too many requests|rate.?limit/i.test(detail)) return 'rate_limit_error';
    if (/internal server error|bad gateway|service unavailable|gateway timeout/i.test(detail)) return 'upstream_error';
    if (/request timeout|timed out/i.test(detail)) return 'timeout';
    if (/econn|enotfound|etimedout|socket|network|fetch failed|failed to fetch|load failed/i.test(detail)) return 'network_error';
    return 'proxy_error';
}

function sillyTavernWindows() {
    const windows = [globalThis];
    let current = globalThis;
    while (true) {
        try {
            const parent = current.parent;
            if (!parent || windows.includes(parent)) break;
            // Access checks also work for same-origin srcdoc frames with an opaque URL.
            void parent.location?.origin;
            windows.unshift(parent);
            current = parent;
        } catch {
            break;
        }
    }
    return windows;
}

function getStRequestContext() {
    const windows = sillyTavernWindows();
    for (const root of windows) {
        let context;
        try {
            context = root.SillyTavern?.getContext?.();
        } catch {
            // A legacy root-level getter can still be available.
        }
        const owner = typeof context?.getRequestHeaders === 'function' ? context : root;
        const getter = owner.getRequestHeaders;
        if (typeof getter !== 'function') continue;
        console.info('[Cache Memory] SillyTavern getRequestHeaders found:', true);
        let headerKeys = [];
        try {
            const headers = new Headers(getter.call(owner));
            headerKeys = [...headers.keys()];
            const token = headers.get('X-CSRF-Token');
            if (!token || token === 'undefined' || token === 'null') throw new Error();
            headers.set('Content-Type', 'application/json');
            console.info('[Cache Memory] SillyTavern CSRF headers available:', true);
            return { root, headers };
        } catch {
            console.info('[Cache Memory] SillyTavern CSRF headers available:', false);
            throw new Error('无法获取 SillyTavern CSRF 请求头');
        } finally {
            console.info('[Cache Memory] SillyTavern header keys:', headerKeys);
        }
    }
    console.info('[Cache Memory] SillyTavern getRequestHeaders found:', false);
    console.info('[Cache Memory] SillyTavern header keys:', []);
    const error = new Error('无法获取 SillyTavern CSRF 请求头');
    if (!windows.some(root => root.SillyTavern)) error.code = 'ST_PROXY_UNAVAILABLE';
    throw error;
}

export class SummaryApiClient {
    constructor({ getSettings, storage, storageKey }) {
        this.getSettings = getSettings;
        this.storage = storage;
        this.storageKey = storageKey;
        this.activeControllers = new Set();
        this.cancelledControllers = new WeakSet();
        this.responseControls = new WeakMap();
        this.connectionTokens = new Map();
        this.connectionRevision = 0;
        this.activeProfileId = null;
    }

    profileIndex() {
        const index = parseJson(this.storage.getItem(`${this.storageKey}:profiles`));
        if (!Array.isArray(index?.profiles) || !index.profiles.some(item => item.id === index.activeId)) return null;
        // A different ST window may switch profiles in the same browser. Keep
        // this client's key paired with its own currently displayed URL.
        if (!index.profiles.some(item => item.id === this.activeProfileId)) this.activeProfileId = index.activeId;
        return { ...index, activeId: this.activeProfileId };
    }

    profileSettings(settings = this.getSettings()) {
        return Object.fromEntries(API_PROFILE_FIELDS.filter(key => settings[key] !== undefined).map(key => [key, settings[key]]));
    }

    listProfiles() {
        let index = this.profileIndex();
        if (!index) {
            const connection = this.readConnection();
            const id = globalThis.crypto?.randomUUID?.() ?? `profile-${Date.now()}-${Math.random().toString(36).slice(2)}`;
            index = { activeId: id, profiles: [{ id, name: '默认配置' }] };
            this.storage.setItem(`${this.storageKey}:profile:${id}`, JSON.stringify({ ...this.profileSettings(), model: connection.model || this.getSettings().model || '', key: connection.key ?? (!normalizeApiBaseUrl(this.getSettings().apiBaseUrl) ? this.storage.getItem(this.storageKey) || '' : '') }));
            // Older versions kept one key/model per URL. Preserve those saved URLs as selectable profiles too.
            const prefix = `${this.storageKey}:connection:`;
            const oldKeys = Array.from({ length: this.storage.length ?? 0 }, (_, i) => this.storage.key(i)).filter(key => key?.startsWith(prefix));
            for (const oldKey of oldKeys) {
                let endpoint;
                try { endpoint = decodeURIComponent(oldKey.slice(prefix.length)); } catch { continue; }
                const old = parseJson(this.storage.getItem(oldKey));
                if (!endpoint || endpoint === normalizeApiBaseUrl(this.getSettings().apiBaseUrl) || !old || typeof old !== 'object') continue;
                const savedId = `${id}-${index.profiles.length}`;
                let name; try { name = new URL(endpoint).host; } catch { name = `模型${index.profiles.length + 1}`; }
                this.storage.setItem(`${this.storageKey}:profile:${savedId}`, JSON.stringify({ ...this.profileSettings(), apiBaseUrl: endpoint, model: String(old.model ?? ''), key: String(old.key ?? '') }));
                index.profiles.push({ id: savedId, name });
            }
            this.storage.setItem(`${this.storageKey}:profiles`, JSON.stringify(index));
            this.activeProfileId = id;
        }
        return index;
    }

    saveProfileSettings() {
        if (!this.profileIndex()) return;
        this.storage.setItem(this.connectionStorageKey(), JSON.stringify({ ...this.readConnection(), ...this.profileSettings() }));
    }

    selectProfile(id) {
        const index = this.listProfiles();
        if (!index.profiles.some(profile => profile.id === id)) throw new Error('接口配置不存在');
        const saved = parseJson(this.storage.getItem(`${this.storageKey}:profile:${id}`));
        if (!saved || typeof saved !== 'object') throw new Error('接口配置无法读取，当前连接保留');
        index.activeId = id;
        this.storage.setItem(`${this.storageKey}:profiles`, JSON.stringify(index));
        this.activeProfileId = id;
        return this.profileSettings(saved);
    }

    addProfile(name) {
        const index = this.listProfiles();
        const id = globalThis.crypto?.randomUUID?.() ?? `profile-${Date.now()}-${Math.random().toString(36).slice(2)}`;
        const label = String(name ?? '').trim();
        if (!label) throw new Error('请填写配置名称');
        this.storage.setItem(`${this.storageKey}:profile:${id}`, JSON.stringify({ ...this.profileSettings(), apiBaseUrl: '', model: '', key: '' }));
        index.profiles.push({ id, name: label });
        this.storage.setItem(`${this.storageKey}:profiles`, JSON.stringify(index));
        return id;
    }

    renameProfile(name) {
        const index = this.listProfiles(), label = String(name ?? '').trim();
        if (!label) throw new Error('请填写配置名称');
        index.profiles.find(item => item.id === index.activeId).name = label;
        this.storage.setItem(`${this.storageKey}:profiles`, JSON.stringify(index));
    }

    deleteProfile(id) {
        const index = this.listProfiles();
        if (index.profiles.length <= 1) throw new Error('请至少保留一套接口配置');
        if (!index.profiles.some(item => item.id === id)) throw new Error('接口配置不存在');
        const nextId = index.activeId === id ? index.profiles.find(item => item.id !== id).id : index.activeId;
        const settings = this.selectProfile(nextId);
        index.profiles = index.profiles.filter(item => item.id !== id);
        index.activeId = nextId;
        this.storage.setItem(`${this.storageKey}:profiles`, JSON.stringify(index));
        this.storage.removeItem(`${this.storageKey}:profile:${id}`);
        return settings;
    }

    connectionStorageKey(apiBaseUrl = this.getSettings().apiBaseUrl) {
        const index = this.profileIndex();
        if (index) return `${this.storageKey}:profile:${index.activeId}`;
        return `${this.storageKey}:connection:${encodeURIComponent(normalizeApiBaseUrl(apiBaseUrl))}`;
    }

    readConnection(apiBaseUrl = this.getSettings().apiBaseUrl) {
        const endpoint = normalizeApiBaseUrl(apiBaseUrl);
        if (!endpoint && !this.profileIndex()) return {};
        const saved = parseJson(this.storage.getItem(this.connectionStorageKey(endpoint)));
        if (saved && typeof saved === 'object' && !Array.isArray(saved)) return saved;
        const legacy = this.storage.getItem(this.storageKey);
        const owner = parseJson(this.storage.getItem(`${this.storageKey}:legacy-owner`))?.endpoint ?? this.legacyEndpoint;
        if (!legacy || owner && owner !== endpoint) return {};
        // Bind the former global key to one endpoint only; never reuse it for a new URL.
        this.legacyEndpoint = endpoint;
        const connection = { key: legacy, model: String(this.getSettings().model ?? '') };
        this.storage.setItem?.(`${this.storageKey}:legacy-owner`, JSON.stringify({ endpoint }));
        this.storage.setItem?.(this.connectionStorageKey(endpoint), JSON.stringify(connection));
        return connection;
    }

    saveConnectionModel(model, apiBaseUrl = this.getSettings().apiBaseUrl) {
        if (!normalizeApiBaseUrl(apiBaseUrl)) return;
        this.storage.setItem(this.connectionStorageKey(apiBaseUrl), JSON.stringify({ ...this.readConnection(apiBaseUrl), model: String(model ?? '') }));
    }

    savedConnectionModel() {
        return String(this.readConnection().model ?? '');
    }

    modelListIdentity() {
        const endpoint = `${this.profileIndex()?.activeId ?? ''}:${normalizeApiBaseUrl(this.getSettings().apiBaseUrl)}`;
        const key = this.readConnection().key ?? '';
        let token = this.connectionTokens.get(endpoint);
        if (!token || token.key !== key) {
            token = { key, revision: ++this.connectionRevision };
            this.connectionTokens.set(endpoint, token);
        }
        return `${endpoint}:${token.revision}`;
    }

    hasApiKey() {
        return Boolean(this.readConnection().key);
    }

    async saveApiKey(value) {
        const key = String(value ?? '').trim();
        if (!key) return this.hasApiKey();
        if (!normalizeApiBaseUrl(this.getSettings().apiBaseUrl) && !this.profileIndex()) return false;
        this.storage.setItem(this.connectionStorageKey(), JSON.stringify({ ...this.readConnection(), key }));
        return true;
    }

    clearApiKey() {
        this.storage.setItem(this.connectionStorageKey(), JSON.stringify({ ...this.readConnection(), key: '' }));
        const owner = parseJson(this.storage.getItem(`${this.storageKey}:legacy-owner`))?.endpoint ?? this.legacyEndpoint;
        if (owner === normalizeApiBaseUrl(this.getSettings().apiBaseUrl)) this.storage.removeItem(this.storageKey);
    }

    abortAll() {
        for (const controller of this.activeControllers) {
            this.cancelledControllers.add(controller);
            controller.abort();
        }
        this.activeControllers.clear();
    }

    async fetchResponse(url, options = {}, fetchContext = globalThis) {
        if (!String(url).startsWith('/api/backends/chat-completions/')) {
            console.warn('[Cache Memory] blocked direct cross-origin API request');
            const blocked = new Error('已阻止浏览器直接请求第三方 API；请使用 SillyTavern 后端代理');
            blocked.code = 'DIRECT_CROSS_ORIGIN_BLOCKED';
            throw blocked;
        }
        const controller = new AbortController();
        this.activeControllers.add(controller);
        const externalSignal = options.signal;
        const cancel = () => { this.cancelledControllers.add(controller); controller.abort(); };
        externalSignal?.addEventListener('abort', cancel, { once: true });
        if (externalSignal?.aborted) cancel();
        const cleanup = () => { externalSignal?.removeEventListener('abort', cancel); this.activeControllers.delete(controller); };
        const translate = error => {
            if (error?.name !== 'AbortError') return error;
            const cancelled = this.cancelledControllers.has(controller);
            const aborted = new Error(cancelled ? '请求已取消' : '上游或 SillyTavern 代理连接已中断');
            aborted.code = cancelled ? 'REQUEST_ABORTED' : 'CONNECTION_CLOSED';
            return aborted;
        };
        try {
            const response = await fetchContext.fetch(url, { cache: 'no-cache', ...options, signal: controller.signal });
            this.responseControls.set(response, { cleanup, translate, signal: controller.signal });
            return response;
        } catch (error) {
            cleanup();
            throw translate(error);
        }
    }

    async consumeText(response) {
        const control = this.responseControls.get(response);
        try { return await response.text(); }
        catch (error) { throw control?.translate(error) ?? error; }
        finally { control?.cleanup(); this.responseControls.delete(response); }
    }

    async consumeSse(response, onFirstChunk) {
        const control = this.responseControls.get(response);
        try { return await readOpenAISse(response, { signal: control?.signal, onFirstChunk, allowJson: true }); }
        catch (error) { throw control?.translate(error) ?? error; }
        finally { control?.cleanup(); this.responseControls.delete(response); }
    }

    releaseResponse(response) {
        const control = this.responseControls.get(response);
        control?.cleanup();
        this.responseControls.delete(response);
    }

    buildPayload(request = {}, settings = this.getSettings()) {
        if (!settings.apiBaseUrl) throw new Error('请先填写接口地址');
        if (!settings.model) throw new Error('请先填写摘要模型');
        const { systemPrompt, userContent, maxTokens, messages, extraBody, transportMode, signal, ...compatibility } = request;
        const payload = {};
        if (extraBody && typeof extraBody === 'object' && !Array.isArray(extraBody)) Object.assign(payload, extraBody);
        for (const key of CUSTOM_BODY_KEYS) {
            if (compatibility[key] !== undefined) payload[key] = compatibility[key];
        }
        const tokenParameter = settings.tokenLimitParameter === 'max_completion_tokens' ? 'max_completion_tokens' : 'max_tokens';
        const explicitTokenLimit = request.max_completion_tokens ?? request.max_tokens ?? maxTokens;
        return {
            ...payload,
            model: settings.model,
            messages: Array.isArray(messages) ? messages : [
                { role: 'system', content: String(systemPrompt ?? '') },
                { role: 'user', content: String(userContent ?? '') },
            ],
            temperature: Number(request.temperature ?? settings.temperature),
            [tokenParameter]: Number(explicitTokenLimit ?? settings.maxTokens),
            thinking: { type: settings.thinkingMode ?? 'disabled' },
        };
    }

    // Models, test and every generation share live ST headers, URL normalization and diagnostics.
    async requestOpenAICompatible({ kind = 'completion', payload, apiKeyOverride = '', signal, connection } = {}) {
        const settings = connection?.settings ?? { ...this.getSettings() };
        const startedAt = now();
        const stream = kind === 'completion' && payload?.stream === true;
        const apiKey = String(apiKeyOverride || (connection ? connection.key : this.readConnection().key) || '').trim();
        const endpoint = kind === 'models' ? normalizeModelsUrl(settings.apiBaseUrl) : normalizeBaseUrl(settings.apiBaseUrl);
        const path = kind === 'models' ? ST_MODELS_PROXY_PATH : ST_GENERATE_PROXY_PATH;
        const secrets = [apiKey];
        const diagnostics = {
            endpoint: safeText(safeUrl(endpoint), secrets, Infinity), direct: '已禁用', directBody: '',
            directException: '', suspectedCors: false, proxy: '未请求', proxyEndpoint: path,
            proxyBody: '', proxyException: '', upstream: '未提供（ST 代理可能不透传上游状态）',
            transport: 'sillytavern-backend', stream, contentType: '', ttfbMs: null, ttfcMs: null, totalMs: null,
        };
        const requestDebug = kind === 'completion' ? {
            transport: diagnostics.transport,
            stream,
            model: safeText(payload?.model ?? '', secrets, Infinity),
            max_tokens: payload?.max_tokens,
            max_completion_tokens: payload?.max_completion_tokens,
            temperature: payload?.temperature,
            messageCount: Array.isArray(payload?.messages) ? payload.messages.length : 0,
            systemPromptChars: (payload?.messages ?? []).filter(message => message?.role === 'system').reduce((sum, message) => sum + contentText(message.content).length, 0),
            userChars: (payload?.messages ?? []).filter(message => message?.role === 'user').reduce((sum, message) => sum + contentText(message.content).length, 0),
        } : null;
        const fail = (message, code, status, proxyRouteMissing = false) => {
            diagnostics.totalMs ??= elapsed(startedAt);
            const error = new Error(safeText(message, secrets, 1000));
            error.code = code;
            error.status = Number(status) || undefined;
            error.category = classifyFailure(status, error.message, code, proxyRouteMissing);
            error.diagnostics = { ...diagnostics };
            console.warn('[Cache Memory] AI request failed:', error.diagnostics, error.message);
            return error;
        };
        if (!endpoint) { diagnostics.direct = '未请求：请先填写接口地址'; throw fail('请先填写接口地址'); }
        console.info('[Cache Memory] transport: sillytavern-backend');
        console.info('[Cache Memory] operation:', kind === 'models' ? 'models' : 'chat-completions');
        console.info('[Cache Memory] upstream base:', safeText(safeUrl(normalizeApiBaseUrl(settings.apiBaseUrl)), secrets, Infinity));
        if (requestDebug) console.info('[Cache Memory] request diagnostics:', requestDebug);
        let context;
        try { context = getStRequestContext(); }
        catch (error) {
            diagnostics.proxy = '不可用';
            diagnostics.proxyException = safeText(errorText(error), secrets);
            throw fail(error.message, error.code || 'ST_PROXY_UNAVAILABLE');
        }
        const consume = async response => {
            diagnostics.proxy = `HTTP ${response.status}`;
            diagnostics.proxyEndpoint = safeText(safeUrl(response.url || diagnostics.proxyEndpoint), secrets, Infinity);
            diagnostics.contentType = responseContentType(response) || '未提供';
            let raw;
            if (kind === 'completion' && response.ok && response.body?.getReader) {
                let streamed;
                try {
                    streamed = await this.consumeSse(response, () => { diagnostics.ttfcMs ??= elapsed(startedAt); });
                } catch (error) {
                    diagnostics.proxyException = safeText(errorText(error), secrets);
                    const status = error.status ?? response.status;
                    if (error.status) diagnostics.upstream = `HTTP ${error.status}`;
                    throw fail(error.message, error.code, status);
                }
                if (streamed.raw !== undefined) raw = streamed.raw;
                else {
                    diagnostics.totalMs = elapsed(startedAt);
                    diagnostics.upstream = 'HTTP 200';
                    console.info('[Cache Memory] response diagnostics:', {
                        transport: diagnostics.transport, stream, http: response.status, contentType: diagnostics.contentType,
                        ttfbMs: diagnostics.ttfbMs, ttfcMs: diagnostics.ttfcMs, totalMs: diagnostics.totalMs,
                        sseEvents: streamed.eventCount, contentChars: streamed.content.length, reasoningChars: streamed.reasoning.length,
                    });
                    return {
                        data: { choices: [{ message: { content: streamed.content, reasoning_content: streamed.reasoning }, finish_reason: streamed.finishReason }] },
                        response, diagnostics, source: 'proxy', streamed: true,
                    };
                }
            }
            if (raw === undefined) {
                try { raw = await this.consumeText(response); }
                catch (error) { diagnostics.proxyException = safeText(errorText(error), secrets); throw fail(error.message, error.code, response.status); }
            }
            diagnostics.totalMs = elapsed(startedAt);
            diagnostics.proxyBody = safeText(raw, secrets);
            const proxyRouteMissing = response.status === 405
                || /Cannot POST\s+\/api\/backends\/chat-completions\/(status|generate)/i.test(raw);
            if (proxyRouteMissing) {
                const error = new Error(`SillyTavern 后端代理路由不可用：${path}`);
                error.code = 'ST_PROXY_ROUTE_MISSING';
                throw fail(error.message, error.code, response.status, true);
            }
            let data;
            try { data = raw ? JSON.parse(raw) : {}; }
            catch {
                if (!response.ok) throw fail(`HTTP ${response.status}: ${diagnostics.proxyBody || response.statusText}`, 'ST_PROXY_HTTP_ERROR', response.status);
                throw fail('响应不是有效 JSON');
            }
            const upstreamStatus = data?.upstream_status ?? data?.error?.status ?? data?.error?.status_code;
            if (Number.isInteger(Number(upstreamStatus)) && Number(upstreamStatus) > 0) {
                diagnostics.upstream = `HTTP ${Number(upstreamStatus)}`;
            } else if (response.ok && !data?.error) {
                diagnostics.upstream = 'HTTP 200';
            }
            console.info('[Cache Memory] upstream status:', diagnostics.upstream);
            if (!response.ok || data?.error) {
                const detail = typeof data?.error === 'string' ? data.error : data?.error?.message ?? data?.message;
                const code = !response.ok && !upstreamStatus ? 'ST_PROXY_HTTP_ERROR' : undefined;
                throw fail(detail || `HTTP ${response.status}: ${diagnostics.proxyBody || response.statusText}`, code, upstreamStatus || response.status);
            }
            console.info('[Cache Memory] response diagnostics:', {
                transport: diagnostics.transport, stream, http: response.status, contentType: diagnostics.contentType,
                ttfbMs: diagnostics.ttfbMs, ttfcMs: diagnostics.ttfcMs, totalMs: diagnostics.totalMs,
            });
            return { data, response, diagnostics, source: 'proxy' };
        };
        const { root, headers } = context;
        // Header values never enter a diagnostic. Include all returned values in the redactor.
        secrets.push(...headers.values());
        diagnostics.proxyEndpoint = safeText(safeUrl(new URL(path, root.location?.href || root.location?.origin).toString()), secrets, Infinity);
        const customBody = Object.fromEntries(Object.entries(payload ?? {})
            .filter(([key, value]) => !ST_NATIVE_BODY_KEYS.has(key) && value !== undefined));
        const proxyPayload = {
            ...payload, chat_completion_source: 'custom',
            cache_memory_internal: true,
            custom_url: normalizeApiBaseUrl(settings.apiBaseUrl),
            custom_include_headers: JSON.stringify({ Authorization: apiKey ? `Bearer ${apiKey}` : '' }),
            ...(kind === 'completion' ? {
                stream,
                custom_prompt_post_processing: '',
                ...(Object.keys(customBody).length ? { custom_include_body: JSON.stringify(customBody) } : {}),
            } : {}),
        };
        let response;
        try {
            response = await this.fetchResponse(path, {
                method: 'POST', headers, credentials: 'same-origin', body: JSON.stringify(proxyPayload), signal,
            }, root);
            diagnostics.ttfbMs = elapsed(startedAt);
        } catch (error) {
            if (error.diagnostics) throw error;
            diagnostics.proxy = '未收到 HTTP 响应';
            diagnostics.proxyException = safeText(errorText(error), secrets);
            throw fail(error.message, error.code);
        }
        return consume(response);
    }

    async complete(request) {
        const settings = { ...this.getSettings() };
        const connection = { settings, key: this.readConnection().key ?? '' };
        const payload = this.buildPayload(request, settings);
        const mode = ['auto', 'stream', 'non-stream'].includes(request.transportMode)
            ? request.transportMode
            : settings.generationTransport ?? 'auto';
        const run = async stream => {
            const attemptPayload = { ...payload, stream };
            try { return await this.requestOpenAICompatible({ payload: attemptPayload, signal: request.signal, connection }); }
            catch (error) {
                // Retry only an explicit rejected parameter, preserving the selected transport and output budget.
                if (!attemptPayload.max_tokens || !/max_tokens/.test(error.message) || !/unsupported|not supported|unknown|use.*max_completion_tokens/i.test(error.message)) throw error;
                attemptPayload.max_completion_tokens = attemptPayload.max_tokens;
                delete attemptPayload.max_tokens;
                return this.requestOpenAICompatible({ payload: attemptPayload, signal: request.signal, connection });
            }
        };
        const preferStream = mode !== 'non-stream';
        let result;
        try { result = await run(preferStream); }
        catch (error) {
            if (mode !== 'auto' || !preferStream || !isExplicitStreamUnsupported(error)) throw error;
            console.info('[Cache Memory] stream explicitly unsupported; retrying once with stream:false');
            result = await run(false);
            result.diagnostics.streamFallback = true;
        }
        const { data, response, diagnostics, source } = result;
        const content = data?.choices?.[0]?.message?.content ?? data?.choices?.[0]?.text
            ?? data?.content?.[0]?.text ?? data?.response ?? '';
        if (!String(content).trim()) {
            const error = new Error('API 返回成功，但没有可用文本');
            error.diagnostics = diagnostics;
            throw error;
        }
        return { content: String(content).trim(), reasoning: String(data?.choices?.[0]?.message?.reasoning_content ?? ''),
            status: response.status, finishReason: data?.choices?.[0]?.finish_reason, diagnostics, source };
    }

    async listModels(apiKeyOverride = '') {
        try {
            const result = await this.requestOpenAICompatible({ kind: 'models', apiKeyOverride });
            const models = readModels(result.data);
            if (!models.length) {
                result.diagnostics[result.source] += '（未识别模型数组）';
                return { models, source: 'unavailable', warning: MODEL_LIST_WARNING, diagnostics: result.diagnostics, error: '响应中没有可识别的模型数组' };
            }
            return { models, source: result.source, warning: '', diagnostics: result.diagnostics };
        } catch (error) {
            if (error.code === 'REQUEST_ABORTED') throw error;
            return { models: [], source: 'unavailable', warning: MODEL_LIST_WARNING, diagnostics: error.diagnostics, error: error.message };
        }
    }

    async test({ stream = true } = {}) {
        const settings = { ...this.getSettings() };
        const connection = { settings, key: this.readConnection().key ?? '' };
        // One click, one request: do not retry a paid diagnostic with other parameters.
        const payload = this.buildPayload({
            systemPrompt: 'Reply with exactly OK.', userContent: 'OK',
            maxTokens: settings.summaryMaxTokens ?? settings.maxTokens ?? 1024,
        }, settings);
        const { data, response, diagnostics, source } = await this.requestOpenAICompatible({ payload: { ...payload, stream }, connection });
        const parts = chunkParts(data);
        const content = contentText(parts.content || data?.content || data?.response).trim();
        const reasoning = parts.reasoning.trim();
        const truncated = /^(?:length|max_tokens|max_completion_tokens)$/i.test(parts.finishReason ?? '');
        let outcome = 'success';
        let warning = '';
        if (truncated) {
            outcome = reasoning && !content ? 'reasoning_truncated' : 'output_truncated';
            warning = reasoning && !content
                ? '连接成功，但思考输出达到 token 上限，尚未生成正文。可调高现有小总结 max tokens 后手动重测。'
                : '连接成功，但输出达到 token 上限，正文可能不完整。';
        } else if (reasoning && !content) {
            outcome = 'reasoning_only';
            warning = '连接成功，已收到思考内容，但未收到正文。';
        } else if (!content) {
            const error = new Error('HTTP 请求成功，但响应中没有正文或思考内容');
            error.code = 'EMPTY_RESPONSE';
            error.category = 'invalid_response';
            error.status = response.status;
            error.diagnostics = diagnostics;
            throw error;
        }
        return { ok: true, outcome, warning, status: response.status, model: settings.model, source,
            content, finishReason: parts.finishReason, contentType: diagnostics.contentType,
            ttfbMs: diagnostics.ttfbMs, ttfcMs: diagnostics.ttfcMs,
            totalMs: diagnostics.totalMs, latencyMs: diagnostics.totalMs,
            stream: diagnostics.stream };
    }
}
