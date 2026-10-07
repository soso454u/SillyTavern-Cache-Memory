export const MODEL_LIST_WARNING = '无法获取模型列表，请手动填写模型名称。';
const ST_MODELS_PROXY_PATH = '/api/backends/chat-completions/status';

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
    let text = String(value ?? '').slice(0, maxLength);
    if (apiKey) text = text.split(apiKey).join('[REDACTED]');
    return text;
}

function errorText(error) {
    return String(error?.message ?? error ?? 'Unknown error');
}

function isNetworkFailure(error) {
    return /failed to fetch|load failed|networkerror|network error|cors|cross[- ]origin/i.test(errorText(error));
}

function sameOriginSillyTavernWindow() {
    try {
        const parent = globalThis.parent;
        if (parent && parent !== globalThis && parent.location.origin === globalThis.location?.origin) return parent;
    } catch {
        // Cross-origin parents are not a usable SillyTavern proxy context.
    }
    return globalThis;
}

function responseError(status, statusText, body) {
    let message = '';
    try {
        const data = body ? JSON.parse(body) : {};
        message = data?.error?.message ?? data?.message ?? '';
    } catch {
        // Keep the response body as the diagnostic when it is not JSON.
    }
    const error = new Error(`HTTP ${status}: ${message || body || statusText || 'Request failed'}`);
    error.status = status;
    error.body = body;
    return error;
}

export class SummaryApiClient {
    constructor({ getSettings, storage, storageKey }) {
        this.getSettings = getSettings;
        this.storage = storage;
        this.storageKey = storageKey;
        this.activeControllers = new Set();
        this.cancelledControllers = new WeakSet();
    }

    hasApiKey() {
        return Boolean(this.storage.getItem(this.storageKey));
    }

    async saveApiKey(value) {
        const key = String(value ?? '').trim();
        if (!key) return this.hasApiKey();
        this.storage.setItem(this.storageKey, key);
        return true;
    }

    clearApiKey() {
        this.storage.removeItem(this.storageKey);
    }

    abortAll() {
        for (const controller of this.activeControllers) {
            this.cancelledControllers.add(controller);
            controller.abort();
        }
        this.activeControllers.clear();
    }

    headers(apiKeyOverride = '') {
        const apiKey = String(apiKeyOverride || this.storage.getItem(this.storageKey) || '').trim();
        return {
            Accept: 'application/json',
            'Content-Type': 'application/json',
            ...(apiKey ? { Authorization: `Bearer ${apiKey}` } : {}),
        };
    }

    async fetchResponse(url, options = {}, fetchContext = globalThis) {
        const settings = this.getSettings();
        const controller = new AbortController();
        this.activeControllers.add(controller);
        const timeout = setTimeout(() => controller.abort(), Number(settings.timeoutMs) || 60000);
        try {
            return await fetchContext.fetch(url, { cache: 'no-cache', ...options, signal: controller.signal });
        } catch (error) {
            if (error?.name === 'AbortError') {
                const aborted = new Error(this.cancelledControllers.has(controller) ? '请求已取消' : `请求超时（${settings.timeoutMs} 毫秒）`);
                aborted.code = this.cancelledControllers.has(controller) ? 'REQUEST_ABORTED' : 'REQUEST_TIMEOUT';
                throw aborted;
            }
            throw error;
        } finally {
            clearTimeout(timeout);
            this.activeControllers.delete(controller);
        }
    }

    async fetchJson(url, options = {}) {
        const response = await this.fetchResponse(url, options);
        const raw = await response.text();
        let data;
        try {
            data = raw ? JSON.parse(raw) : {};
        } catch {
            data = {};
        }
        if (!response.ok || data?.error) throw responseError(response.status, response.statusText, raw);
        return { data, response, raw };
    }

    buildPayload({ systemPrompt, userContent, maxTokens }) {
        const settings = this.getSettings();
        if (!settings.apiBaseUrl) throw new Error('请先填写接口地址');
        if (!settings.model) throw new Error('请先填写摘要模型');
        return {
            model: settings.model,
            messages: [
                { role: 'system', content: String(systemPrompt ?? '') },
                { role: 'user', content: String(userContent ?? '') },
            ],
            temperature: Number(settings.temperature),
            max_tokens: Number(maxTokens ?? settings.maxTokens),
            stream: false,
        };
    }

    async complete(request) {
        const settings = this.getSettings();
        const { data, response } = await this.fetchJson(normalizeBaseUrl(settings.apiBaseUrl), {
            method: 'POST',
            headers: this.headers(),
            body: JSON.stringify(this.buildPayload(request)),
        });
        const content = data?.choices?.[0]?.message?.content
            ?? data?.choices?.[0]?.text
            ?? data?.content?.[0]?.text
            ?? data?.response
            ?? '';
        if (!String(content).trim()) throw new Error('API 返回成功，但没有可用文本');
        return { content: String(content).trim(), status: response.status };
    }

    async listModels(apiKeyOverride = '') {
        const settings = this.getSettings();
        const apiKey = String(apiKeyOverride || this.storage.getItem(this.storageKey) || '').trim();
        const endpoint = normalizeModelsUrl(settings.apiBaseUrl);
        const diagnostics = { endpoint: safeUrl(endpoint), direct: '未请求', proxy: '未请求' };
        console.info('[Cache Memory] model endpoint:', diagnostics.endpoint);

        if (!endpoint) {
            diagnostics.direct = '未请求：请先填写接口地址';
            console.info('[Cache Memory] direct fetch status:', diagnostics.direct);
            console.info('[Cache Memory] direct fetch response:', '');
            return { models: [], source: 'unavailable', warning: MODEL_LIST_WARNING, diagnostics };
        }

        try {
            const response = await this.fetchResponse(endpoint, {
                method: 'GET',
                headers: {
                    Accept: 'application/json',
                    ...(apiKey ? { Authorization: `Bearer ${apiKey}` } : {}),
                },
            });
            const raw = await response.text();
            const safeResponse = safeText(raw, apiKey);
            diagnostics.direct = `HTTP ${response.status}`;
            console.info('[Cache Memory] direct fetch status:', diagnostics.direct);
            console.info('[Cache Memory] direct fetch response:', safeResponse);

            if (!response.ok) {
                const error = responseError(response.status, response.statusText, safeResponse);
                return { models: [], source: 'unavailable', warning: MODEL_LIST_WARNING, diagnostics, error: error.message };
            }

            let payload;
            try {
                payload = raw ? JSON.parse(raw) : {};
            } catch {
                diagnostics.direct = `HTTP ${response.status}（JSON 解析失败）`;
                return { models: [], source: 'unavailable', warning: MODEL_LIST_WARNING, diagnostics, error: '响应不是有效 JSON' };
            }
            const models = readModels(payload);
            if (!models.length) {
                diagnostics.direct = `HTTP ${response.status}（未识别模型数组）`;
                return { models: [], source: 'unavailable', warning: MODEL_LIST_WARNING, diagnostics, error: '响应中没有可识别的模型数组' };
            }
            return { models, source: 'direct', warning: '', diagnostics };
        } catch (error) {
            if (error?.code === 'REQUEST_ABORTED' || error?.code === 'REQUEST_TIMEOUT') throw error;
            diagnostics.direct = safeText(errorText(error), apiKey, 300);
            console.info('[Cache Memory] direct fetch status:', diagnostics.direct);
            console.info('[Cache Memory] direct fetch response:', '');
            if (!isNetworkFailure(error)) {
                return { models: [], source: 'unavailable', warning: MODEL_LIST_WARNING, diagnostics, error: diagnostics.direct };
            }
        }

        const stWindow = sameOriginSillyTavernWindow();
        const proxyUrl = `${stWindow.location?.origin ?? ''}${ST_MODELS_PROXY_PATH}`;
        try {
            const response = await this.fetchResponse(proxyUrl, {
                method: 'POST',
                headers: { Accept: 'application/json', 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    chat_completion_source: 'custom',
                    custom_url: normalizeApiBaseUrl(settings.apiBaseUrl),
                    custom_include_headers: `Authorization: Bearer ${apiKey}`,
                }),
            }, stWindow);
            const raw = await response.text();
            const safeResponse = safeText(raw, apiKey);
            diagnostics.proxy = `HTTP ${response.status}`;
            console.info('[Cache Memory] proxy fetch status:', diagnostics.proxy);
            if (!response.ok) {
                return { models: [], source: 'unavailable', warning: MODEL_LIST_WARNING, diagnostics, error: responseError(response.status, response.statusText, safeResponse).message };
            }
            let payload;
            try {
                payload = raw ? JSON.parse(raw) : {};
            } catch {
                return { models: [], source: 'unavailable', warning: MODEL_LIST_WARNING, diagnostics, error: '代理响应不是有效 JSON' };
            }
            const models = readModels(payload);
            if (!models.length) {
                return { models: [], source: 'unavailable', warning: MODEL_LIST_WARNING, diagnostics, error: '代理响应中没有可识别的模型数组' };
            }
            return { models, source: 'proxy', warning: '', diagnostics };
        } catch (error) {
            if (error?.code === 'REQUEST_ABORTED' || error?.code === 'REQUEST_TIMEOUT') throw error;
            diagnostics.proxy = safeText(errorText(error), apiKey, 300);
            console.info('[Cache Memory] proxy fetch status:', diagnostics.proxy);
            return { models: [], source: 'unavailable', warning: MODEL_LIST_WARNING, diagnostics, error: diagnostics.proxy };
        }
    }

    async test() {
        const settings = this.getSettings();
        const endpoint = normalizeBaseUrl(settings.apiBaseUrl);
        if (!endpoint) throw new Error('请先填写接口地址');
        if (!settings.model) throw new Error('请先填写摘要模型');
        const startedAt = performance.now();
        const payload = { model: settings.model, messages: [{ role: 'user', content: 'Hi' }], max_tokens: 1 };
        let result;
        try {
            result = await this.fetchJson(endpoint, {
                method: 'POST',
                headers: this.headers(),
                body: JSON.stringify(payload),
            });
        } catch (error) {
            if (!/max_tokens|unsupported.*parameter|unknown.*parameter|unrecognized.*parameter/i.test(errorText(error))) throw error;
            delete payload.max_tokens;
            result = await this.fetchJson(endpoint, {
                method: 'POST',
                headers: this.headers(),
                body: JSON.stringify(payload),
            });
        }
        return {
            ok: true,
            status: result.response.status,
            latencyMs: Math.round(performance.now() - startedAt),
            model: settings.model,
        };
    }
}
