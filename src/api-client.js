import { API_PROVIDERS, DOUBAO_CODING_MODELS } from './defaults.js?v=1.2.0';

export function normalizeBaseUrl(value) {
    const url = String(value ?? '').trim().replace(/\/+$/, '');
    if (!url) return '';
    return /\/chat\/completions$/i.test(url) ? url : `${url}/chat/completions`;
}

export function normalizeModelsUrl(value) {
    const url = String(value ?? '').trim().replace(/\/+$/, '').replace(/\/chat\/completions$/i, '');
    return url ? `${url}/models` : '';
}

function readModels(data) {
    const source = Array.isArray(data) ? data : data?.data ?? data?.models ?? data?.result?.data ?? [];
    if (!Array.isArray(source)) return [];
    return [...new Set(source.map(item => String(typeof item === 'string' ? item : item?.id ?? item?.name ?? '').trim()).filter(Boolean))]
        .sort((a, b) => a.localeCompare(b));
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
            'Content-Type': 'application/json',
            ...(apiKey ? { Authorization: `Bearer ${apiKey}` } : {}),
        };
    }

    async fetchJson(url, options = {}) {
        const settings = this.getSettings();
        const controller = new AbortController();
        this.activeControllers.add(controller);
        const timeout = setTimeout(() => controller.abort(), Number(settings.timeoutMs) || 60000);
        let response;
        let raw;
        try {
            response = await fetch(url, { cache: 'no-cache', ...options, signal: controller.signal });
            raw = await response.text();
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

        let data;
        try {
            data = raw ? JSON.parse(raw) : {};
        } catch {
            data = {};
        }
        if (!response.ok || data?.error) {
            const detail = data?.error?.message ?? data?.message ?? raw ?? response.statusText;
            const error = new Error(`HTTP ${response.status}: ${detail}`);
            error.status = response.status;
            throw error;
        }
        return { data, response };
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
        if (!settings.apiBaseUrl) throw new Error('请先填写接口地址');
        let remoteModels = [];
        let remoteError = null;
        try {
            const { data } = await this.fetchJson(normalizeModelsUrl(settings.apiBaseUrl), {
                method: 'GET',
                headers: this.headers(apiKeyOverride),
            });
            remoteModels = readModels(data);
            if (!remoteModels.length) remoteError = new Error('接口返回成功，但没有模型数据');
        } catch (error) {
            if (error?.code === 'REQUEST_ABORTED') throw error;
            remoteError = error;
        }

        if (settings.provider === API_PROVIDERS.DOUBAO_CODING) {
            const models = [...new Set([...remoteModels, ...DOUBAO_CODING_MODELS])];
            return { models, source: remoteModels.length ? 'remote-and-preset' : 'preset', warning: remoteError?.message ?? '' };
        }
        if (remoteError) throw remoteError;
        return { models: remoteModels, source: 'remote', warning: '' };
    }

    async test() {
        const startedAt = performance.now();
        const result = await this.complete({
            systemPrompt: '只回复 OK。',
            userContent: 'ping',
            maxTokens: 8,
        });
        return {
            ok: true,
            status: result.status,
            latencyMs: Math.round(performance.now() - startedAt),
            model: this.getSettings().model,
        };
    }
}
