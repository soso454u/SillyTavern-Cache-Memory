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

export async function readOpenAISse(response, { signal, onFirstChunk = () => {} } = {}) {
    if (!response?.body?.getReader) throw new Error('流式响应没有可读取的 body');
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    let content = '';
    let reasoning = '';
    let finishReason;
    let eventCount = 0;
    let firstChunkSeen = false;
    let streamDone = false;
    const consumeLine = line => {
        const trimmed = line.trimEnd();
        if (!trimmed.startsWith('data:')) return false;
        const value = trimmed.slice(5).trimStart();
        if (!value || value === '[DONE]') return value === '[DONE]';
        const data = parseJson(value);
        if (!data) return false;
        if (data.error) {
            const error = new Error(errorDetail(data, '流式接口返回错误'));
            error.status = Number(data.error?.status ?? data.error?.status_code ?? data.status) || undefined;
            error.streamPayload = data;
            throw error;
        }
        eventCount++;
        if (!firstChunkSeen) { firstChunkSeen = true; onFirstChunk(); }
        const parts = chunkParts(data);
        content += parts.content;
        reasoning += parts.reasoning;
        finishReason ??= parts.finishReason;
        return false;
    };
    try {
        while (true) {
            if (signal?.aborted) throw new DOMException('Aborted', 'AbortError');
            const { done, value } = await reader.read();
            if (done) break;
            buffer += decoder.decode(value, { stream: true });
            const lines = buffer.split(/\r?\n/);
            buffer = lines.pop() ?? '';
            for (const line of lines) {
                if (consumeLine(line)) {
                    streamDone = true;
                    break;
                }
            }
            if (streamDone) {
                await reader.cancel();
                break;
            }
        }
        if (!streamDone) {
            buffer += decoder.decode();
            if (buffer) consumeLine(buffer);
        }
        return { content, reasoning, finishReason, eventCount };
    } finally {
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
    if (code === 'REQUEST_TIMEOUT') return 'timeout';
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

    async fetchResponse(url, options = {}, fetchContext = globalThis) {
        if (!String(url).startsWith('/api/backends/chat-completions/')) {
            console.warn('[Cache Memory] blocked direct cross-origin API request');
            const blocked = new Error('已阻止浏览器直接请求第三方 API；请使用 SillyTavern 后端代理');
            blocked.code = 'DIRECT_CROSS_ORIGIN_BLOCKED';
            throw blocked;
        }
        const settings = this.getSettings();
        const controller = new AbortController();
        this.activeControllers.add(controller);
        const externalSignal = options.signal;
        const cancel = () => { this.cancelledControllers.add(controller); controller.abort(); };
        externalSignal?.addEventListener('abort', cancel, { once: true });
        if (externalSignal?.aborted) cancel();
        const timeoutMs = Number(settings.timeoutMs) || 180000;
        const timeout = setTimeout(() => controller.abort(), timeoutMs);
        const cleanup = () => { clearTimeout(timeout); externalSignal?.removeEventListener('abort', cancel); this.activeControllers.delete(controller); };
        const translate = error => {
            if (error?.name !== 'AbortError') return error;
            const aborted = new Error(this.cancelledControllers.has(controller) ? '请求已取消' : `请求超时（${timeoutMs} 毫秒）`);
            aborted.code = this.cancelledControllers.has(controller) ? 'REQUEST_ABORTED' : 'REQUEST_TIMEOUT';
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
        try { return await readOpenAISse(response, { signal: control?.signal, onFirstChunk }); }
        catch (error) { throw control?.translate(error) ?? error; }
        finally { control?.cleanup(); this.responseControls.delete(response); }
    }

    releaseResponse(response) {
        const control = this.responseControls.get(response);
        control?.cleanup();
        this.responseControls.delete(response);
    }

    buildPayload(request = {}) {
        const settings = this.getSettings();
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
    async requestOpenAICompatible({ kind = 'completion', payload, apiKeyOverride = '', signal } = {}) {
        const settings = this.getSettings();
        const startedAt = now();
        const stream = kind === 'completion' && payload?.stream === true;
        const apiKey = String(apiKeyOverride || this.storage.getItem(this.storageKey) || '').trim();
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
            model: String(payload?.model ?? ''),
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
            if (stream && /text\/event-stream/i.test(diagnostics.contentType) && response.ok) {
                let streamed;
                try {
                    streamed = await this.consumeSse(response, () => { diagnostics.ttfcMs ??= elapsed(startedAt); });
                } catch (error) {
                    diagnostics.proxyException = safeText(errorText(error), secrets);
                    const status = error.status ?? response.status;
                    throw fail(error.message, error.code, status);
                }
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
            let raw;
            try { raw = await this.consumeText(response); }
            catch (error) { diagnostics.proxyException = safeText(errorText(error), secrets); throw fail(error.message, error.code, response.status); }
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
        const payload = this.buildPayload(request);
        const settings = this.getSettings();
        const mode = ['auto', 'stream', 'non-stream'].includes(request.transportMode)
            ? request.transportMode
            : settings.generationTransport ?? 'auto';
        const run = async stream => {
            const attemptPayload = { ...payload, stream };
            try { return await this.requestOpenAICompatible({ payload: attemptPayload, signal: request.signal }); }
            catch (error) {
                // Retry only an explicit rejected parameter, preserving the selected transport and output budget.
                if (!attemptPayload.max_tokens || !/max_tokens/.test(error.message) || !/unsupported|not supported|unknown|use.*max_completion_tokens/i.test(error.message)) throw error;
                attemptPayload.max_completion_tokens = attemptPayload.max_tokens;
                delete attemptPayload.max_tokens;
                return this.requestOpenAICompatible({ payload: attemptPayload, signal: request.signal });
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
            if (['REQUEST_ABORTED', 'REQUEST_TIMEOUT'].includes(error.code)) throw error;
            return { models: [], source: 'unavailable', warning: MODEL_LIST_WARNING, diagnostics: error.diagnostics, error: error.message };
        }
    }

    async test({ stream = true } = {}) {
        const result = await this.complete({
            systemPrompt: 'Reply with exactly OK.', userContent: 'OK', maxTokens: 16,
            temperature: 0, transportMode: stream ? 'stream' : 'non-stream',
        });
        return { ok: true, status: result.status, model: this.getSettings().model, source: result.source,
            content: result.content, contentType: result.diagnostics.contentType,
            ttfbMs: result.diagnostics.ttfbMs, ttfcMs: result.diagnostics.ttfcMs,
            totalMs: result.diagnostics.totalMs, latencyMs: result.diagnostics.totalMs,
            stream: result.diagnostics.stream };
    }
}
