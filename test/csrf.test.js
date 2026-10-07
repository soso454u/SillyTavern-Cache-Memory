import test from 'node:test';
import assert from 'node:assert/strict';
import { SummaryApiClient } from '../src/api-client.js';

function setGlobal(t, name, value) {
    const original = Object.getOwnPropertyDescriptor(globalThis, name);
    Object.defineProperty(globalThis, name, { configurable: true, writable: true, value });
    t.after(() => original ? Object.defineProperty(globalThis, name, original) : delete globalThis[name]);
}

function fixture(t) {
    const logs = [];
    for (const name of ['info', 'warn']) t.mock.method(console, name, (...args) => logs.push(args));
    setGlobal(t, 'location', { href: 'https://frame.example/frame', origin: 'https://frame.example' });
    t.mock.method(globalThis, 'fetch', async () => { throw new TypeError('Failed to fetch'); });
    const client = new SummaryApiClient({
        getSettings: () => ({ apiBaseUrl: 'https://provider.example/v1' }),
        storage: { getItem: () => 'private-api-key' }, storageKey: 'key',
    });
    return { client, logs };
}

test('nested frames use the topmost accessible ST window, live headers, and a relative same-origin proxy request', async t => {
    const { client, logs } = fixture(t);
    const requests = [];
    let generation = 0;
    const root = {
        location: { origin: 'https://st.example', href: 'https://st.example/chat' },
        SillyTavern: { getContext: () => ({ getRequestHeaders() {
            generation += 1;
            return { 'Content-Type': 'application/json', 'X-CSRF-Token': `private-csrf-${generation}`, 'X-Test': 'private-header-value' };
        } }) },
        fetch: async (url, options) => {
            requests.push({ url, options });
            return new Response('{"data":[{"id":"rp-model"}]}');
        },
    };
    root.parent = root;
    setGlobal(t, 'parent', { parent: root, location: { origin: 'null' }, getRequestHeaders: () => { assert.fail('must use top ST window'); } });
    assert.equal((await client.listModels()).source, 'proxy');
    assert.equal((await client.listModels()).source, 'proxy');
    assert.equal(generation, 2);
    assert.deepEqual(requests.map(item => item.url), ['/api/backends/chat-completions/status', '/api/backends/chat-completions/status']);
    for (const [index, { options }] of requests.entries()) {
        assert.equal(options.headers.get('X-CSRF-Token'), `private-csrf-${index + 1}`);
        assert.equal(options.headers.get('X-Test'), 'private-header-value');
        assert.equal(options.headers.get('Content-Type'), 'application/json');
        assert.equal(options.credentials, 'same-origin');
        assert.equal(options.method, 'POST');
        assert.equal(JSON.parse(JSON.parse(options.body).custom_include_headers).Authorization, 'Bearer private-api-key');
    }
    assert.match(JSON.stringify(logs), /getRequestHeaders found/);
    assert.match(JSON.stringify(logs), /x-csrf-token/);
    assert.doesNotMatch(JSON.stringify(logs), /private-(csrf|api-key|header-value)/);
});

test('missing, throwing, or tokenless ST getters fail clearly without sending a proxy request', async t => {
    const { client, logs } = fixture(t);
    let requests = 0;
    const root = { location: { origin: 'https://st.example' }, fetch: async () => { requests += 1; } };
    setGlobal(t, 'parent', root);
    for (const getter of [undefined, () => { throw new Error('private-csrf-leak'); }, () => ({ 'Content-Type': 'application/json' })]) {
        root.getRequestHeaders = getter;
        const result = await client.listModels();
        assert.equal(result.source, 'unavailable');
        assert.equal(result.diagnostics.proxyException, '无法获取 SillyTavern CSRF 请求头');
    }
    assert.equal(requests, 0);
    assert.doesNotMatch(JSON.stringify(logs), /private-csrf-leak/);
});

test('cross-origin ancestors are skipped and response/exception diagnostics redact current CSRF tokens', async t => {
    const { client, logs } = fixture(t);
    const token = 'secret-csrf-value';
    setGlobal(t, 'parent', { get location() { throw new DOMException('Blocked', 'SecurityError'); } });
    setGlobal(t, 'SillyTavern', { getContext: () => ({ getRequestHeaders: () => new Headers({ 'X-CSRF-Token': token }) }) });
    let requests = 0;
    t.mock.method(globalThis, 'fetch', async url => {
        if (!url.startsWith('/')) throw new TypeError('Failed to fetch');
        requests += 1;
        if (requests === 1) return new Response(`Forbidden: ${token}`, { status: 403 });
        throw new Error(`proxy failed ${token}`);
    });
    const first = await client.listModels();
    const second = await client.listModels();
    assert.equal(first.diagnostics.proxyEndpoint, 'https://frame.example/api/backends/chat-completions/status');
    assert.equal(first.diagnostics.proxyBody, 'Forbidden: [REDACTED]');
    assert.equal(second.diagnostics.proxyException, 'proxy failed [REDACTED]');
    assert.equal(JSON.stringify({ first, second, logs }).includes(token), false);
});
