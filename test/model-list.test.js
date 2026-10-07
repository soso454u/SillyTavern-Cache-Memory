import test from 'node:test';
import assert from 'node:assert/strict';
import { SummaryApiClient } from '../src/api-client.js';
import { CacheMemoryUI, formatModelListFailure } from '../src/ui.js';

function fixture(t, apiBaseUrl = 'https://example.com/v1', apiKey = 'private/key') {
    const logs = [];
    t.mock.method(console, 'info', (...args) => logs.push(args));
    t.mock.method(console, 'warn', (...args) => logs.push(args));
    const client = new SummaryApiClient({
        getSettings: () => ({ apiBaseUrl, timeoutMs: 10 }),
        storage: { getItem: () => apiKey },
        storageKey: 'key',
    });
    return { client, logs, apiKey };
}

function setGlobal(t, name, value) {
    const original = Object.getOwnPropertyDescriptor(globalThis, name);
    Object.defineProperty(globalThis, name, { value, configurable: true, writable: true });
    t.after(() => {
        if (original) Object.defineProperty(globalThis, name, original);
        else delete globalThis[name];
    });
}

test('HTTP failure shows final URL, status and 500-character body without leaking keys at the truncation boundary', async t => {
    const { client, logs, apiKey } = fixture(t);
    const body = `permission denied ${'x'.repeat(475)}${apiKey}${'z'.repeat(600)}`;
    let calls = 0;
    t.mock.method(globalThis, 'fetch', async () => {
        calls += 1;
        return {
            url: `https://user:password@redirect.example/v1/models?api_key=${encodeURIComponent(apiKey)}`,
            ok: false, status: 403, statusText: 'Forbidden', text: async () => body,
        };
    });
    const result = await client.listModels();
    const display = formatModelListFailure(result);
    assert.equal(calls, 1);
    assert.equal(result.diagnostics.directBody.length, 500);
    assert.equal(result.diagnostics.directBody, body.replace(apiKey, '[REDACTED]').slice(0, 500));
    assert.match(display, /URL: https:\/\/redirect\.example\/v1\/models/);
    assert.match(display, /状态: HTTP 403/);
    assert.match(display, /permission denied/);
    assert.match(display, /疑似 CORS: 否/);
    const output = JSON.stringify({ result, display, logs });
    assert.equal(output.includes(apiKey), false);
    assert.equal(output.includes(encodeURIComponent(apiKey)), false);
    assert.equal(output.includes('password'), false);
    assert.equal(output.includes('private/'), false);
});

test('failed direct fetch keeps its exception and CORS hint alongside proxy HTTP diagnostics', async t => {
    const { client, logs, apiKey } = fixture(t);
    setGlobal(t, 'location', { origin: 'https://st.example' });
    setGlobal(t, 'parent', {
        location: { origin: 'https://st.example' },
        getRequestHeaders: () => ({ 'Content-Type': 'application/json', 'X-CSRF-Token': 'test-csrf' }),
        fetch: async () => new Response('permission denied', { status: 403 }),
    });
    t.mock.method(globalThis, 'fetch', async () => { throw new TypeError(`Failed to fetch: ${apiKey}`); });
    const result = await client.listModels();
    const display = formatModelListFailure(result);
    assert.equal(result.diagnostics.directException, 'Failed to fetch: [REDACTED]');
    assert.equal(result.diagnostics.suspectedCors, true);
    assert.match(display, /URL: https:\/\/example\.com\/v1\/models/);
    assert.match(display, /错误: Failed to fetch/);
    assert.match(display, /可能是 CORS 或网络限制/);
    assert.match(display, /代理 URL: https:\/\/st\.example\/api\/backends\/chat-completions\/status/);
    assert.match(display, /代理状态: HTTP 403/);
    assert.match(display, /代理响应（前 500 字）: permission denied/);
    assert.equal(JSON.stringify({ result, display, logs }).includes(apiKey), false);
});

test('proxy fetch exceptions are also displayed and redacted', async t => {
    const { client, logs, apiKey } = fixture(t);
    setGlobal(t, 'location', { origin: 'https://st.example' });
    setGlobal(t, 'parent', {
        location: { origin: 'https://st.example' },
        getRequestHeaders: () => ({ 'Content-Type': 'application/json', 'X-CSRF-Token': 'test-csrf' }),
        fetch: async () => { throw new TypeError(`Load failed: ${apiKey}`); },
    });
    t.mock.method(globalThis, 'fetch', async () => { throw new TypeError('Failed to fetch'); });
    const result = await client.listModels();
    const display = formatModelListFailure(result);
    assert.match(display, /错误: Failed to fetch/);
    assert.match(display, /代理错误: Load failed: \[REDACTED\]/);
    assert.equal(JSON.stringify({ result, display, logs }).includes(apiKey), false);
});

test('proxy response snippets are limited to 500 characters and redact an unsaved key override', async t => {
    const { client, logs } = fixture(t);
    const override = 'unsaved-key';
    const body = `upstream denied ${override} ${'x'.repeat(600)}`;
    setGlobal(t, 'location', { origin: 'https://st.example' });
    setGlobal(t, 'parent', {
        location: { origin: 'https://st.example' },
        getRequestHeaders: () => ({ 'Content-Type': 'application/json', 'X-CSRF-Token': 'test-csrf' }),
        fetch: async (_url, options) => {
            assert.match(options.body, /Authorization: Bearer unsaved-key/);
            return new Response(body, { status: 502 });
        },
    });
    t.mock.method(globalThis, 'fetch', async () => { throw new TypeError('Failed to fetch'); });
    const result = await client.listModels(override);
    const display = formatModelListFailure(result);
    assert.equal(result.diagnostics.proxyBody, body.replace(override, '[REDACTED]').slice(0, 500));
    assert.match(display, /代理状态: HTTP 502/);
    assert.equal(JSON.stringify({ result, display, logs }).includes(override), false);
});

test('JSON-escaped and URL-encoded keys in diagnostics are redacted', async t => {
    const apiKey = 'private/"key';
    const { client, logs } = fixture(t, 'https://example.com/v1', apiKey);
    t.mock.method(globalThis, 'fetch', async () => new Response(JSON.stringify({
        error: { message: `denied: ${apiKey}; ${encodeURIComponent(apiKey)}` },
    }), { status: 403 }));
    const result = await client.listModels();
    assert.match(result.diagnostics.directBody, /denied: \[REDACTED\]; \[REDACTED\]/);
    assert.equal(JSON.stringify({ result, logs }).includes('private/'), false);
    assert.equal(JSON.stringify({ result, logs }).includes(encodeURIComponent(apiKey)), false);
});

test('body-read failures retain the HTTP status and final URL', async t => {
    const { client, logs, apiKey } = fixture(t);
    t.mock.method(globalThis, 'fetch', async () => ({
        url: 'https://redirect.example/v1/models', status: 403, ok: false,
        text: async () => { throw new Error(`body read failed: ${apiKey}`); },
    }));
    const result = await client.listModels();
    const display = formatModelListFailure(result);
    assert.match(display, /状态: HTTP 403/);
    assert.match(display, /URL: https:\/\/redirect\.example\/v1\/models/);
    assert.match(display, /错误: body read failed: \[REDACTED\]/);
    assert.equal(result.diagnostics.suspectedCors, false);
    assert.equal(JSON.stringify({ result, display, logs }).includes(apiKey), false);
});

test('invalid response bodies still show the parsing or model-array error', async t => {
    const { client } = fixture(t);
    t.mock.method(globalThis, 'fetch', async () => new Response('<html>upstream error</html>', { status: 200 }));
    assert.match(formatModelListFailure(await client.listModels()), /错误: 响应不是有效 JSON/);
    t.mock.method(globalThis, 'fetch', async () => new Response('{"data":{}}', { status: 200 }));
    assert.match(formatModelListFailure(await client.listModels()), /错误: 响应中没有可识别的模型数组/);
});

test('model-list timeouts and cancellation retain diagnostics and their existing error codes', async t => {
    const { client } = fixture(t);
    t.mock.method(globalThis, 'fetch', async (_url, options) => new Promise((_resolve, reject) => {
        options.signal.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')), { once: true });
    }));
    await assert.rejects(client.listModels(), error => {
        assert.equal(error.code, 'REQUEST_TIMEOUT');
        assert.match(formatModelListFailure({ diagnostics: error.diagnostics, error: error.message }), /URL: https:\/\/example\.com\/v1\/models\n状态: 未收到 HTTP 响应\n错误: 请求超时/);
        return true;
    });
    const pending = client.listModels();
    client.abortAll();
    await assert.rejects(pending, error => error.code === 'REQUEST_ABORTED' && error.diagnostics.directException === '请求已取消');
});

test('missing API URL is reported as unconfigured rather than the current page URL', async t => {
    const { client } = fixture(t, '');
    setGlobal(t, 'location', { href: 'https://st.example/chat' });
    t.mock.method(globalThis, 'fetch', async () => { assert.fail('must not fetch'); });
    const result = await client.listModels();
    assert.equal(result.diagnostics.endpoint, '');
    assert.match(formatModelListFailure(result), /URL: 未知\n状态: 未请求：请先填写接口地址/);
});

test('model-list button displays thrown timeout diagnostics and re-enables itself', async t => {
    fixture(t);
    const status = { dataset: {}, removeAttribute() {} };
    setGlobal(t, 'document', { querySelectorAll: () => [status] });
    const error = new Error('请求超时（10 毫秒）');
    error.diagnostics = {
        endpoint: 'https://example.com/v1/models', direct: '未收到 HTTP 响应',
        directException: error.message, suspectedCors: false,
    };
    const ui = new CacheMemoryUI({ apiClient: { listModels: async () => { throw error; } } });
    const handlers = {};
    const root = {
        dataset: {}, querySelector: () => ({ value: '' }),
        addEventListener: (name, handler) => { handlers[name] = handler; },
    };
    ui.bindSettings(root);
    const button = { disabled: false };
    await handlers.click({ target: { closest: selector => ['button', '[data-list-models]'].includes(selector) ? button : null } });
    assert.equal(button.disabled, false);
    assert.equal(status.dataset.state, 'error');
    assert.match(status.textContent, /模型列表获取失败\nURL: https:\/\/example\.com\/v1\/models/);
    assert.match(status.textContent, /错误: 请求超时/);
});
