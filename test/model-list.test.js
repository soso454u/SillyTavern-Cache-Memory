import test from 'node:test';
import assert from 'node:assert/strict';
import { SummaryApiClient } from '../src/api-client.js';
import { CacheMemoryUI, formatModelListFailure } from '../src/ui.js';

function setGlobal(t, name, value) {
    const original = Object.getOwnPropertyDescriptor(globalThis, name);
    Object.defineProperty(globalThis, name, { value, configurable: true, writable: true });
    t.after(() => original ? Object.defineProperty(globalThis, name, original) : delete globalThis[name]);
}

function fixture(t, apiBaseUrl = 'https://example.com/v1', apiKey = 'private/key') {
    const logs = [];
    t.mock.method(console, 'info', (...args) => logs.push(args));
    t.mock.method(console, 'warn', (...args) => logs.push(args));
    const root = {
        location: { href: 'https://st.example/chat', origin: 'https://st.example' },
        getRequestHeaders: () => ({ 'Content-Type': 'application/json', 'X-CSRF-Token': 'test-csrf' }),
        fetch: async () => new Response('{"data":[{"id":"model-a"}]}'),
    };
    setGlobal(t, 'parent', root);
    setGlobal(t, 'location', { href: 'https://frame.example/', origin: 'https://frame.example' });
    t.mock.method(globalThis, 'fetch', async () => assert.fail('browser must not request a third-party API'));
    const client = new SummaryApiClient({
        getSettings: () => ({ apiBaseUrl, timeoutMs: 10 }),
        storage: { getItem: () => apiKey }, storageKey: 'key',
    });
    return { client, logs, apiKey, root };
}

test('proxy HTTP failure shows upstream URL, proxy status and a 500-character redacted body', async t => {
    const { client, logs, apiKey, root } = fixture(t);
    const body = `permission denied ${'x'.repeat(475)}${apiKey}${'z'.repeat(600)}`;
    root.fetch = async (url, options) => {
        assert.equal(url, '/api/backends/chat-completions/status');
        assert.equal(options.headers.get('X-CSRF-Token'), 'test-csrf');
        return new Response(body, { status: 403 });
    };
    const result = await client.listModels();
    const display = formatModelListFailure(result);
    assert.equal(result.diagnostics.proxyBody.length, 500);
    assert.equal(result.diagnostics.proxyBody, body.replace(apiKey, '[REDACTED]').slice(0, 500));
    assert.match(display, /URL: https:\/\/example\.com\/v1\/models/);
    assert.match(display, /状态: HTTP 403/);
    assert.match(display, /permission denied/);
    assert.match(display, /疑似 CORS: 否（请求由 SillyTavern 同源后端转发）/);
    assert.equal(result.diagnostics.direct, '已禁用');
    assert.equal(JSON.stringify({ result, display, logs }).includes(apiKey), false);
});

test('proxy fetch exceptions are displayed and redacted without direct fallback', async t => {
    const { client, logs, apiKey, root } = fixture(t);
    root.fetch = async () => { throw new TypeError(`Load failed: ${apiKey}`); };
    const result = await client.listModels();
    const display = formatModelListFailure(result);
    assert.match(display, /状态: 未收到 HTTP 响应/);
    assert.match(display, /错误: Load failed: \[REDACTED\]/);
    assert.doesNotMatch(display, /可能是 CORS/);
    assert.equal(JSON.stringify({ result, display, logs }).includes(apiKey), false);
});

test('proxy response snippets redact saved, unsaved, escaped and URL-encoded keys', async t => {
    const apiKey = 'private/"key';
    const { client, logs, root } = fixture(t, 'https://example.com/v1', apiKey);
    const override = 'unsaved-key';
    root.fetch = async (_url, options) => {
        assert.equal(JSON.parse(JSON.parse(options.body).custom_include_headers).Authorization, 'Bearer unsaved-key');
        return new Response(JSON.stringify({ error: { message: `denied: ${override}; ${encodeURIComponent(override)} ${'x'.repeat(600)}` } }));
    };
    const result = await client.listModels(override);
    assert.equal(result.diagnostics.proxyBody.length, 500);
    assert.match(result.diagnostics.proxyBody, /denied: \[REDACTED\]; \[REDACTED\]/);
    assert.equal(JSON.stringify({ result, logs }).includes(override), false);
    assert.equal(JSON.stringify({ result, logs }).includes(apiKey), false);
});

test('body-read failures retain proxy HTTP status and sanitized exception', async t => {
    const { client, logs, apiKey, root } = fixture(t);
    root.fetch = async () => ({
        url: 'https://st.example/api/backends/chat-completions/status', status: 403, ok: false,
        text: async () => { throw new Error(`body read failed: ${apiKey}`); },
    });
    const result = await client.listModels();
    const display = formatModelListFailure(result);
    assert.match(display, /状态: HTTP 403/);
    assert.match(display, /代理 URL: https:\/\/st\.example\/api\/backends\/chat-completions\/status/);
    assert.match(display, /错误: body read failed: \[REDACTED\]/);
    assert.equal(JSON.stringify({ result, display, logs }).includes(apiKey), false);
});

test('invalid proxy response bodies show parsing or model-array errors', async t => {
    const { client, root } = fixture(t);
    root.fetch = async () => new Response('<html>upstream error</html>', { status: 200 });
    assert.match(formatModelListFailure(await client.listModels()), /错误: 响应不是有效 JSON/);
    root.fetch = async () => new Response('{"data":{}}', { status: 200 });
    assert.match(formatModelListFailure(await client.listModels()), /错误: 响应中没有可识别的模型数组/);
});

test('model-list timeout and cancellation retain diagnostics and error codes', async t => {
    const { client, root } = fixture(t);
    root.fetch = async (_url, options) => new Promise((_resolve, reject) => {
        options.signal.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')), { once: true });
    });
    await assert.rejects(client.listModels(), error => {
        assert.equal(error.code, 'REQUEST_TIMEOUT');
        assert.match(formatModelListFailure({ diagnostics: error.diagnostics, error: error.message }), /状态: 未收到 HTTP 响应/);
        assert.match(error.message, /请求超时/);
        return true;
    });
    const pending = client.listModels();
    client.abortAll();
    await assert.rejects(pending, error => error.code === 'REQUEST_ABORTED' && error.diagnostics.proxyException === '请求已取消');
});

test('missing API URL is reported before any request', async t => {
    const { client } = fixture(t, '');
    const result = await client.listModels();
    assert.equal(result.diagnostics.endpoint, '');
    assert.match(formatModelListFailure(result), /URL: 未知/);
    assert.match(formatModelListFailure(result), /错误: 请先填写接口地址/);
});

test('model-list button displays thrown timeout diagnostics and re-enables itself', async t => {
    fixture(t);
    const status = { dataset: {}, removeAttribute() {} };
    setGlobal(t, 'document', { querySelectorAll: () => [status] });
    const error = new Error('请求超时（10 毫秒）');
    error.diagnostics = { endpoint: 'https://example.com/v1/models', proxy: '未收到 HTTP 响应', proxyException: error.message };
    const ui = new CacheMemoryUI({ apiClient: { listModels: async () => { throw error; } } });
    const handlers = {};
    const root = { dataset: {}, querySelector: () => ({ value: '' }), addEventListener: (name, handler) => { handlers[name] = handler; } };
    ui.bindSettings(root);
    const button = { disabled: false };
    await handlers.click({ target: { closest: selector => ['button', '[data-list-models]'].includes(selector) ? button : null } });
    assert.equal(button.disabled, false);
    assert.equal(status.dataset.state, 'error');
    assert.match(status.textContent, /模型列表获取失败\nURL: https:\/\/example\.com\/v1\/models/);
    assert.match(status.textContent, /错误: 请求超时/);
});
