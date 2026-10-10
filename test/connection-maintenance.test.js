import test from 'node:test';
import assert from 'node:assert/strict';
import { SummaryApiClient, readOpenAISse } from '../src/api-client.js';
import { normalizeSettings } from '../src/defaults.js';
import { configTemplate, formatConnectionFailure } from '../src/ui.js';

function fixture(t) {
    const settings = normalizeSettings({ apiBaseUrl: 'https://synthetic.invalid/v1', model: 'synthetic-thinking', thinkingMode: 'enabled', summaryMaxTokens: 3072 });
    const client = new SummaryApiClient({ getSettings: () => settings, storage: { getItem: () => null }, storageKey: 'synthetic' });
    const requests = [];
    const root = { location: { href: 'https://st.invalid/' }, getRequestHeaders: () => ({ 'X-CSRF-Token': 'synthetic' }),
        fetch: async (_url, options) => { requests.push(JSON.parse(options.body)); return new Response('{"choices":[{"message":{"content":"OK"}}]}'); } };
    const previous = Object.getOwnPropertyDescriptor(globalThis, 'parent');
    Object.defineProperty(globalThis, 'parent', { configurable: true, value: root });
    t.after(() => previous ? Object.defineProperty(globalThis, 'parent', previous) : delete globalThis.parent);
    t.mock.method(globalThis, 'fetch', () => assert.fail('No external API calls allowed'));
    t.mock.method(console, 'info', () => {});
    t.mock.method(console, 'warn', () => {});
    return { settings, client, requests, root };
}

function response(text, contentType, { splitBytes = false, close = true, cancelled = () => {} } = {}) {
    const bytes = new TextEncoder().encode(text);
    return new Response(new ReadableStream({
        start(controller) {
            if (splitBytes) for (const byte of bytes) controller.enqueue(Uint8Array.of(byte));
            else controller.enqueue(bytes);
            if (close) controller.close();
        }, cancel: cancelled,
    }), { headers: contentType ? { 'Content-Type': contentType } : {} });
}

const sse = (content, reasoning = '', finish = 'stop') => [
    ': heartbeat', 'event: message', `data: ${JSON.stringify({ choices: [{ delta: { reasoning_content: reasoning } }] })}`, '',
    `data: ${JSON.stringify({ choices: [{ delta: { content }, finish_reason: finish }] })}`, '', 'data: [DONE]', '', '',
].join('\r\n');

test('SSE detection handles missing/wrong headers, byte boundaries, UTF-8, CRLF and both selected transports', async t => {
    const { client, root } = fixture(t);
    let calls = 0;
    for (const stream of [true, false]) for (const type of [undefined, 'application/json', 'text/plain', 'text/event-stream']) {
        root.fetch = async () => { calls++; return response(sse('正文 OK', '思考💡'), type, { splitBytes: true }); };
        const result = await client.test({ stream });
        assert.equal(result.content, '正文 OK');
        assert.equal(result.outcome, 'success');
        assert.equal(result.stream, stream);
        assert.equal(typeof result.ttfcMs, 'number');
        assert.equal(client.activeControllers.size, 0);
    }
    assert.equal(calls, 8);
});

test('JSON bodies are accepted under an SSE header without retrying, including structured text and reasoning', async t => {
    const { client, root } = fixture(t);
    root.fetch = async () => response(JSON.stringify({ choices: [{ message: { content: [{ type: 'text', text: 'OK' }], reasoning: '分析' }, finish_reason: 'stop' }] }), 'text/event-stream', { splitBytes: true });
    const result = await client.test();
    assert.equal(result.content, 'OK');
    assert.equal(result.outcome, 'success');
    assert.equal(result.ttfcMs, null);
});

test('SSE supports multiline data events, lone CR delimiters and a final event without newline', async () => {
    for (const newline of ['\n', '\r', '\r\n']) {
        const text = ['data: {"choices": [', 'data: {"delta":{"content":"OK"},"finish_reason":"stop"}]}'].join(newline);
        const result = await readOpenAISse(response(text, undefined, { splitBytes: true }));
        assert.equal(result.content, 'OK');
        assert.equal(result.finishReason, 'stop');
    }
});

test('SSE accepts complete data frames without blank separators and DONE with a single newline', async t => {
    const { client, root } = fixture(t);
    root.fetch = async () => response('data: {"choices":[{"delta":{"content":"OK"}}]}\ndata: [DONE]\n', 'application/json', { close: false, splitBytes: true });
    assert.equal((await client.test()).content, 'OK');
});

test('DONE stops an open stream and cancels its reader without waiting for upstream EOF', async t => {
    const { client, root } = fixture(t);
    let cancelled = 0;
    root.fetch = async () => response(`${sse('OK')}data: not JSON\n\n`, undefined, { close: false, cancelled: () => cancelled++ });
    assert.equal((await client.test()).content, 'OK');
    assert.equal(cancelled, 1);
    assert.equal(client.activeControllers.size, 0);
});

test('thinking truncation, thinking-only output, complete text and empty output have distinct results in both transports', async t => {
    const { client, root } = fixture(t);
    for (const stream of [true, false]) for (const [content, reasoning, finish, outcome] of [
        ['', '仍在思考', 'length', 'reasoning_truncated'],
        ['', '只有思考', 'stop', 'reasoning_only'],
        ['部分正文', '思考', 'length', 'output_truncated'],
        ['OK', '', 'stop', 'success'],
        ['', '', 'stop', 'empty'],
    ]) {
        let calls = 0;
        root.fetch = async () => {
            calls++;
            return stream ? response(sse(content, reasoning, finish)) : new Response(JSON.stringify({ choices: [{ message: { content, reasoning_content: reasoning }, finish_reason: finish }] }));
        };
        if (outcome === 'empty') await assert.rejects(client.test({ stream }), error => error.code === 'EMPTY_RESPONSE'
            && error.category === 'invalid_response' && !formatConnectionFailure(error).startsWith('连接失败'));
        else {
            const result = await client.test({ stream });
            assert.equal(result.ok, true);
            assert.equal(result.outcome, outcome);
            assert.equal(Boolean(result.warning), outcome !== 'success');
        }
        assert.equal(calls, 1);
    }
});

test('each diagnostic uses existing token/Thinking/temperature settings and never retries rejected parameters or transport', async t => {
    const { client, root, requests, settings } = fixture(t);
    settings.temperature = 0.7;
    settings.tokenLimitParameter = 'max_completion_tokens';
    for (const stream of [true, false]) await client.test({ stream });
    assert.equal(requests.length, 2);
    assert.ok(requests.every(body => body.max_completion_tokens === 3072 && body.max_tokens === undefined
        && body.thinking.type === 'enabled' && body.temperature === 0.7));
    for (const message of ['Unsupported parameter max_tokens; use max_completion_tokens', 'stream is not supported']) {
        let calls = 0;
        root.fetch = async () => { calls++; return new Response(JSON.stringify({ error: { message, status: 400 } }), { status: 400 }); };
        await assert.rejects(client.test());
        assert.equal(calls, 1);
    }
});

test('HTTP errors, SSE errors, malformed frames and broken bodies fail once and release controllers', async t => {
    const { client, root } = fixture(t);
    for (const create of [
        () => new Response('Gateway timeout', { status: 504 }),
        () => response('data: {"error":{"message":"upstream failed","status":503}}\n\n'),
        () => response('data: {broken}\n\n'),
        () => new Response('<html>broken proxy</html>'),
        () => new Response(new ReadableStream({ start(controller) { controller.error(new TypeError('terminated socket')); } })),
    ]) {
        let calls = 0;
        root.fetch = async () => { calls++; return create(); };
        await assert.rejects(client.test(), error => Boolean(error.diagnostics));
        assert.equal(calls, 1);
        assert.equal(client.activeControllers.size, 0);
    }
    root.fetch = async () => { throw new DOMException('Disconnected', 'AbortError'); };
    await assert.rejects(client.test(), error => error.code === 'CONNECTION_CLOSED' && error.category === 'network_error');
});

test('legacy timeout values cannot abort waiting headers or bodies even beyond 300 seconds', async t => {
    t.mock.timers.enable({ apis: ['setTimeout'] });
    const { client, root, settings } = fixture(t);
    for (const stream of [true, false]) for (const timeoutMs of [1000, 60000, 180000, 300000]) {
        settings.timeoutMs = timeoutMs; // Even settings supplied by an older caller must be inert.
        let releaseHeaders, releaseBody, signal;
        const body = new ReadableStream({ start(controller) { releaseBody = () => { controller.enqueue(new TextEncoder().encode(stream ? sse('OK') : '{"choices":[{"message":{"content":"OK"}}]}')); controller.close(); }; } });
        root.fetch = async (_url, options) => { signal = options.signal; return new Promise(resolve => { releaseHeaders = () => resolve(new Response(body)); }); };
        const pending = client.test({ stream });
        t.mock.timers.tick(600001);
        assert.equal(signal.aborted, false);
        assert.equal(client.activeControllers.size, 1);
        releaseHeaders();
        await Promise.resolve(); await Promise.resolve(); await Promise.resolve();
        t.mock.timers.tick(600001);
        assert.equal(signal.aborted, false);
        assert.equal(client.activeControllers.size, 1);
        releaseBody();
        assert.equal((await pending).content, 'OK');
        assert.equal(client.activeControllers.size, 0);
    }
    assert.equal(Object.hasOwn(normalizeSettings({ timeoutMs: 60000 }), 'timeoutMs'), false);
    assert.doesNotMatch(configTemplate(), /data-setting="timeoutMs"|默认超时 180000/);
});

test('manual stop/chat switch cancels a pending SSE read even if the stream does not observe the signal', async t => {
    const { client, root } = fixture(t);
    let reading, cancelled = 0;
    const started = new Promise(resolve => { reading = resolve; });
    root.fetch = async () => new Response(new ReadableStream({ pull() { reading(); }, cancel() { cancelled++; } }));
    const pending = client.test();
    await started;
    client.abortAll();
    await assert.rejects(pending, error => error.code === 'REQUEST_ABORTED');
    assert.equal(cancelled, 1);
    assert.equal(client.activeControllers.size, 0);
});
