function normalizeBaseUrl(value) {
    const url = String(value ?? '').trim().replace(/\/+$/, '');
    if (!url) return '';
    return /\/chat\/completions$/i.test(url) ? url : `${url}/chat/completions`;
}

export class SummaryApiClient {
    constructor({ getSettings, storage, storageKey }) {
        this.getSettings = getSettings;
        this.storage = storage;
        this.storageKey = storageKey;
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

    buildPayload({ systemPrompt, userContent, maxTokens }) {
        const settings = this.getSettings();
        if (!settings.apiBaseUrl) throw new Error('请先填写 API Base URL');
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
        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), Number(settings.timeoutMs) || 60000);
        let response;
        try {
            const apiKey = this.storage.getItem(this.storageKey) ?? '';
            response = await fetch(normalizeBaseUrl(settings.apiBaseUrl), {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    ...(apiKey ? { Authorization: `Bearer ${apiKey}` } : {}),
                },
                cache: 'no-cache',
                body: JSON.stringify(this.buildPayload(request)),
                signal: controller.signal,
            });
        } catch (error) {
            if (error?.name === 'AbortError') throw new Error(`请求超时（${settings.timeoutMs} ms）`);
            throw error;
        } finally {
            clearTimeout(timeout);
        }

        const raw = await response.text();
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
        const content = data?.choices?.[0]?.message?.content
            ?? data?.choices?.[0]?.text
            ?? data?.content?.[0]?.text
            ?? data?.response
            ?? '';
        if (!String(content).trim()) throw new Error('API 返回成功，但没有可用文本');
        return { content: String(content).trim(), status: response.status };
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
