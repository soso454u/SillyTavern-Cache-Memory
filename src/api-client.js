export const MODEL_LIST_WARNING = '无法获取模型列表，请手动填写模型名称。';
const ST_MODELS_PROXY_PATH = '/api/backends/chat-completions/status';
const ST_GENERATE_PROXY_PATH = '/api/backends/chat-completions/generate';

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

function isNetworkFailure(error) {
    return /failed to fetch|load failed|networkerror|network error|cors|cross[- ]origin/i.test(errorText(error));
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
        const cleanup = () => { clearTimeout(timeout); this.activeControllers.delete(controller); };
        const translate = error => {
            if (error?.name !== 'AbortError') return error;
            const aborted = new Error(this.cancelledControllers.has(controller) ? '请求已取消' : `请求超时（${settings.timeoutMs} 毫秒）`);
            aborted.code = this.cancelledControllers.has(controller) ? 'REQUEST_ABORTED' : 'REQUEST_TIMEOUT';
            return aborted;
        };
        try {
            const response = await fetchContext.fetch(url, { cache: 'no-cache', ...options, signal: controller.signal });
            const readText = response.text.bind(response);
            // Keep cancellation and the timeout active until the body has finished, not only the headers.
            response.text = async () => {
                try { return await readText(); }
                catch (error) { throw translate(error); }
                finally { cleanup(); }
            };
            return response;
        } catch (error) {
            cleanup();
            throw translate(error);
        }
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
            [settings.tokenLimitParameter === 'max_completion_tokens' ? 'max_completion_tokens' : 'max_tokens']: Number(maxTokens ?? settings.maxTokens),
            stream: false,
        };
    }

    // Models, test and every generation share live ST headers, URL normalization and diagnostics.
    async requestOpenAICompatible({ kind = 'completion', payload, apiKeyOverride = '' } = {}) {
        const settings = this.getSettings();
        const apiKey = String(apiKeyOverride || this.storage.getItem(this.storageKey) || '').trim();
        const endpoint = kind === 'models' ? normalizeModelsUrl(settings.apiBaseUrl) : normalizeBaseUrl(settings.apiBaseUrl);
        const path = kind === 'models' ? ST_MODELS_PROXY_PATH : ST_GENERATE_PROXY_PATH;
        const secrets = [apiKey];
        const diagnostics = {
            endpoint: safeText(safeUrl(endpoint), secrets, Infinity), direct: '未请求', directBody: '',
            directException: '', suspectedCors: false, proxy: '未请求', proxyEndpoint: path,
            proxyBody: '', proxyException: '', upstream: '未提供（ST 代理可能不透传上游状态）',
        };
        const fail = (message, code) => {
            const error = new Error(safeText(message, secrets, 1000));
            error.code = code;
            error.diagnostics = { ...diagnostics };
            console.warn('[Cache Memory] AI request failed:', error.diagnostics, error.message);
            return error;
        };
        if (!endpoint) { diagnostics.direct = '未请求：请先填写接口地址'; throw fail('请先填写接口地址'); }
        let context;
        try { context = getStRequestContext(); }
        catch (error) {
            diagnostics.proxy = '不可用';
            diagnostics.proxyException = safeText(errorText(error), secrets);
            if (error.code !== 'ST_PROXY_UNAVAILABLE') throw fail(error.message, error.code);
        }
        const consume = async (response, source) => {
            diagnostics[source] = `HTTP ${response.status}`;
            if (source === 'direct') {
                diagnostics.endpoint = safeText(safeUrl(response.url || endpoint), secrets, Infinity);
                diagnostics.upstream = `HTTP ${response.status}`;
            } else {
                diagnostics.proxyEndpoint = safeText(safeUrl(response.url || diagnostics.proxyEndpoint), secrets, Infinity);
            }
            let raw;
            try { raw = await response.text(); }
            catch (error) { diagnostics[`${source}Exception`] = safeText(errorText(error), secrets); throw fail(error.message, error.code); }
            diagnostics[`${source}Body`] = safeText(raw, secrets);
            let data;
            try { data = raw ? JSON.parse(raw) : {}; }
            catch {
                if (!response.ok) throw fail(`HTTP ${response.status}: ${diagnostics[`${source}Body`] || response.statusText}`);
                throw fail('响应不是有效 JSON');
            }
            const upstreamStatus = data?.upstream_status ?? data?.error?.status ?? data?.error?.status_code;
            if (source === 'proxy' && Number.isInteger(Number(upstreamStatus)) && Number(upstreamStatus) > 0) {
                diagnostics.upstream = `HTTP ${Number(upstreamStatus)}`;
            }
            console.info('[Cache Memory] AI request:', { kind, source, ...diagnostics });
            if (!response.ok || data?.error) {
                const detail = typeof data?.error === 'string' ? data.error : data?.error?.message ?? data?.message;
                throw fail(detail || `HTTP ${response.status}: ${diagnostics[`${source}Body`] || response.statusText}`);
            }
            return { data, response, diagnostics, source };
        };
        if (context) {
            const { root, headers } = context;
            // Header values never enter a diagnostic. Include all returned values in the redactor.
            secrets.push(...headers.values());
            diagnostics.proxyEndpoint = safeText(safeUrl(new URL(path, root.location?.href || root.location?.origin).toString()), secrets, Infinity);
            const proxyPayload = {
                ...payload, chat_completion_source: 'custom',
                custom_url: normalizeApiBaseUrl(settings.apiBaseUrl),
                custom_include_headers: JSON.stringify({ Authorization: apiKey ? `Bearer ${apiKey}` : '' }),
                ...(kind === 'completion' ? { stream: false, custom_prompt_post_processing: '' } : {}),
            };
            let response;
            try {
                response = await this.fetchResponse(path, {
                    method: 'POST', headers, credentials: 'same-origin', body: JSON.stringify(proxyPayload),
                }, root);
            } catch (error) {
                diagnostics.proxy = '未收到 HTTP 响应';
                diagnostics.proxyException = safeText(errorText(error), secrets);
                // A network failure after sending is not proof of an unavailable route; avoid duplicate generation.
                throw fail(error.message, error.code);
            }
            if (![404, 405].includes(response.status)) return consume(response, 'proxy');
            let raw;
            try { raw = await response.text(); }
            catch (error) {
                diagnostics.proxy = `HTTP ${response.status}`;
                diagnostics.proxyException = safeText(errorText(error), secrets);
                throw fail(error.message, error.code);
            }
            // A returned upstream 404 is not proof that the local ST route is missing.
            const missingRoute = response.status === 405 || /Cannot POST\s+\/api\/backends\/chat-completions\/(status|generate)/i.test(raw);
            if (!missingRoute) {
                response.text = async () => raw;
                return consume(response, 'proxy');
            }
            diagnostics.proxy = `HTTP ${response.status}（ST 路由不可用）`;
            diagnostics.proxyBody = safeText(raw, secrets);
        }
        try {
            const response = await this.fetchResponse(endpoint, {
                method: kind === 'models' ? 'GET' : 'POST', headers: this.headers(apiKey),
                ...(kind === 'completion' ? { body: JSON.stringify(payload) } : {}),
            });
            return await consume(response, 'direct');
        } catch (error) {
            if (error.diagnostics) throw error;
            if (diagnostics.direct === '未请求') diagnostics.direct = '未收到 HTTP 响应';
            diagnostics.directException = safeText(errorText(error), secrets);
            diagnostics.suspectedCors = diagnostics.direct === '未收到 HTTP 响应' && isNetworkFailure(error);
            throw fail(error.message, error.code);
        }
    }

    async complete(request) {
        const payload = this.buildPayload(request);
        let result;
        try { result = await this.requestOpenAICompatible({ payload }); }
        catch (error) {
            // Retry only an explicit rejected parameter, preserving a bounded output budget.
            if (!payload.max_tokens || !/max_tokens/.test(error.message) || !/unsupported|not supported|unknown|use.*max_completion_tokens/i.test(error.message)) throw error;
            payload.max_completion_tokens = payload.max_tokens;
            delete payload.max_tokens;
            result = await this.requestOpenAICompatible({ payload });
        }
        const { data, response, diagnostics, source } = result;
        const content = data?.choices?.[0]?.message?.content ?? data?.choices?.[0]?.text
            ?? data?.content?.[0]?.text ?? data?.response ?? '';
        if (!String(content).trim()) {
            const error = new Error('API 返回成功，但没有可用文本');
            error.diagnostics = diagnostics;
            throw error;
        }
        return { content: String(content).trim(), status: response.status, finishReason: data?.choices?.[0]?.finish_reason, diagnostics, source };
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
            if (['REQUEST_ABORTED', 'REQUEST_TIMEOUT'].includes(error.code)) throw error;
            return { models: [], source: 'unavailable', warning: MODEL_LIST_WARNING, diagnostics: error.diagnostics, error: error.message };
        }
    }

    async test() {
        const startedAt = performance.now();
        const result = await this.complete({ systemPrompt: 'Reply briefly.', userContent: 'Hi', maxTokens: 32 });
        return { ok: true, status: result.status, latencyMs: Math.round(performance.now() - startedAt), model: this.getSettings().model, source: result.source };
    }
}
