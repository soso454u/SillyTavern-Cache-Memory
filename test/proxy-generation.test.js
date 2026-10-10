import test from 'node:test';
import assert from 'node:assert/strict';
import { SummaryApiClient } from '../src/api-client.js';
import { normalizeSettings } from '../src/defaults.js';
import { MemoryStore } from '../src/memory-store.js';
import { MemorySummarizer } from '../src/summarizer.js';
import { getAssistantMessages } from '../src/utils.js';
import { formatConnectionFailure } from '../src/ui.js';

function setGlobal(t, key, value) {
    const previous = Object.getOwnPropertyDescriptor(globalThis, key);
    Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
    t.after(() => previous ? Object.defineProperty(globalThis, key, previous) : delete globalThis[key]);
}
function fixture(t) {
    const logs = [];
    for (const name of ['info', 'warn']) t.mock.method(console, name, (...args) => logs.push(args));
    const settings = normalizeSettings({ apiBaseUrl: 'https://ark.cn-beijing.volces.com/api/coding/v3', model: 'ark-test-model' });
    const client = new SummaryApiClient({ getSettings: () => settings, storage: { getItem: () => 'private-ark-key' }, storageKey: 'key' });
    const requests = [];
    let token = 0;
    const root = { location: { href: 'https://st.example/chat' }, SillyTavern: { getContext: () => ({ getRequestHeaders: () => ({ 'X-CSRF-Token': `csrf-${++token}` }) }) },
        fetch: async (url, options) => { requests.push({ url, options }); return new Response(url.endsWith('/status') ? '{"data":[{"id":"ark-test-model"}]}' : '{"choices":[{"message":{"content":"[SUMMARY]\\n[Event]\\nminimal fact"},"finish_reason":"stop"}]}'); } };
    setGlobal(t, 'parent', root);
    t.mock.method(globalThis, 'fetch', () => assert.fail('proxy environment must never fetch third-party from browser'));
    return { client, requests, root, logs, settings };
}

function sseResponse(chunks, { status = 200 } = {}) {
    const encoder = new TextEncoder();
    return new Response(new ReadableStream({
        start(controller) {
            for (const chunk of chunks) controller.enqueue(encoder.encode(chunk));
            controller.close();
        },
    }), { status, headers: { 'Content-Type': 'text/event-stream; charset=utf-8' } });
}

test('Ark models, test and a real floor summarizer share ST transport, fresh CSRF and the unchanged coding/v3 base', async t => {
    const { client, requests, settings, logs } = fixture(t);
    assert.equal((await client.listModels()).source, 'proxy');
    assert.equal((await client.test()).ok, true);
    const metadata = {};
    const store = new MemoryStore({ getMetadata: () => metadata, getChatId: () => 'chat-a', saveMetadata: () => {} });
    const chat = [{ is_user: true, mes: 'Hi' }, { is_user: false, name: 'A', mes: '正文', gen_started: 'now', send_date: 'now' }];
    const summarizer = new MemorySummarizer({ store, apiClient: client, getSettings: () => settings, getChat: () => chat });
    await summarizer.summarizeEntry(getAssistantMessages(chat)[0]);
    assert.equal(store.current().summaries[getAssistantMessages(chat)[0].messageId].status, 'frozen');
    assert.deepEqual(requests.map(item => item.url), ['/api/backends/chat-completions/status', '/api/backends/chat-completions/generate', '/api/backends/chat-completions/generate']);
    requests.forEach(({ options }, index) => {
        const body = JSON.parse(options.body);
        assert.equal(options.headers.get('X-CSRF-Token'), `csrf-${index + 1}`);
        assert.equal(options.credentials, 'same-origin');
        assert.equal(body.custom_url, settings.apiBaseUrl);
        assert.equal(body.chat_completion_source, 'custom');
        assert.equal(JSON.parse(body.custom_include_headers).Authorization, 'Bearer private-ark-key');
        if (index) { assert.equal(body.stream, true); assert.equal(body.model, settings.model); assert.ok(body.messages.length); assert.ok(body.max_tokens > 0); }
    });
    assert.doesNotMatch(JSON.stringify(logs), /private-ark-key|csrf-1|csrf-2|csrf-3|正文/);
});

test('manual summary, automatic summary, checkpoint and long memory all use the same ST generate route', async t => {
    const { client, requests, root, settings } = fixture(t);
    Object.assign(settings, { enabled: true, autoSummarize: true, independentApi: true, checkpointInterval: 2, longMemoryInterval: 2 });
    root.fetch = async (url, options) => {
        requests.push({ url, options });
        if (url.endsWith('/status')) return new Response('{"data":[{"id":"ark-test-model"}]}');
        const system = JSON.parse(options.body).messages?.[0]?.content ?? '';
        if (system.includes('[CHECKPOINT]')) return new Response(JSON.stringify({ choices: [{ message: { content: '[CHECKPOINT]\n[Current State]\n状态已冻结' } }] }));
        if (system.includes('[LONG_MEMORY]')) return new Response(JSON.stringify({ choices: [{ message: { content: '[LONG_MEMORY]\n- 【人物｜状态】长期事实。' } }] }));
        return new Response(JSON.stringify({ choices: [{ message: { content: '[SUMMARY]\n[Event]\n新增事实\n[State]\n状态\n[Open]\n无\n[KEEP]\n无' } }] }));
    };
    await client.listModels();
    await client.test();
    const metadata = {};
    const chat = [{ is_user: true, mes: 'U1' }, { is_user: false, name: 'A', mes: 'A1', gen_started: '1', send_date: '1' }];
    const store = new MemoryStore({ getMetadata: () => metadata, getChatId: () => 'chat-a', saveMetadata: () => {} });
    const summarizer = new MemorySummarizer({ store, apiClient: client, getSettings: () => settings, getChat: () => chat });
    await summarizer.summarizeMessage(getAssistantMessages(chat)[0].messageId);
    chat.push({ is_user: true, mes: 'U2' }, { is_user: false, name: 'A', mes: 'A2', gen_started: '2', send_date: '2' });
    await summarizer.summarizeLatest();
    assert.equal(Object.keys(store.current().summaries).length, 2);
    assert.equal(store.current().checkpoints.length, 1);
    assert.equal(store.current().longMemories.length, 1);
    assert.deepEqual(requests.map(item => item.url), [
        '/api/backends/chat-completions/status',
        '/api/backends/chat-completions/generate',
        '/api/backends/chat-completions/generate',
        '/api/backends/chat-completions/generate',
        '/api/backends/chat-completions/generate',
        '/api/backends/chat-completions/generate',
    ]);
    assert.ok(requests.every(({ options }) => JSON.parse(options.body).custom_url === settings.apiBaseUrl));
});

test('proxy HTTP200 error is a failure, upstream status is not invented, all secret values are redacted', async t => {
    const { client, root, logs } = fixture(t);
    root.fetch = async () => new Response('{"error":{"message":"Forbidden private-ark-key csrf-1"}}');
    await assert.rejects(client.test(), error => {
        const display = formatConnectionFailure(error);
        assert.match(display, /代理状态：HTTP 200/);
        assert.match(display, /上游 HTTP：未提供/);
        assert.match(display, /Forbidden \[REDACTED\] \[REDACTED\]/);
        assert.doesNotMatch(JSON.stringify({ display, logs }), /private-ark-key|csrf-1/);
        return true;
    });
});

test('connection failures expose authentication, permission, endpoint, rate-limit and upstream categories', async t => {
    const { client, root } = fixture(t);
    for (const [status, category] of [[401, 'authentication_error'], [403, 'permission_error'], [404, 'endpoint_error'], [429, 'rate_limit_error'], [503, 'upstream_error']]) {
        root.fetch = async () => new Response(JSON.stringify({ error: { status, message: `upstream ${status}` } }));
        await assert.rejects(client.test(), error => error.category === category
            && error.diagnostics.upstream === `HTTP ${status}`
            && formatConnectionFailure(error).includes(`上游 HTTP：${status}`));
    }
});

test('proxy 403, network failures and a missing route all fail closed without direct generation', async t => {
    const { client, root } = fixture(t);
    root.fetch = async () => new Response('Invalid CSRF token', { status: 403 });
    await assert.rejects(client.test(), /HTTP 403/);
    root.fetch = async () => { throw new TypeError('Failed to fetch'); };
    await assert.rejects(client.test(), /Failed to fetch/);
    root.fetch = async () => new Response('Cannot POST /api/backends/chat-completions/generate', { status: 404 });
    await assert.rejects(client.test(), error => error.code === 'ST_PROXY_ROUTE_MISSING'
        && error.category === 'proxy_error'
        && error.diagnostics.direct === '已禁用');
});

test('absent ST and broken ST headers both fail closed before any third-party request', async t => {
    const { client, root } = fixture(t);
    setGlobal(t, 'parent', null);
    await assert.rejects(client.test(), error => error.category === 'proxy_error'
        && error.diagnostics.direct === '已禁用'
        && !/CORS/.test(formatConnectionFailure(error)));
    setGlobal(t, 'parent', root);
    root.SillyTavern.getContext = () => ({});
    await assert.rejects(client.test(), /无法获取 SillyTavern CSRF 请求头/);
});

test('hot unload cancellation remains active while reading the response body and retains proxy HTTP status', async t => {
    const { client, root } = fixture(t);
    let started;
    const reading = new Promise(resolve => { started = resolve; });
    root.fetch = async (_url, options) => ({ status: 200, ok: true, url: 'https://st.example/api/backends/chat-completions/generate',
        text: async () => new Promise((_resolve, reject) => {
            options.signal.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')), { once: true });
            started();
        }) });
    const pending = client.test();
    await reading;
    assert.equal(client.activeControllers.size, 1);
    client.abortAll();
    await assert.rejects(pending, error => error.code === 'REQUEST_ABORTED' && error.diagnostics.proxy === 'HTTP 200');
    assert.equal(client.activeControllers.size, 0);
});

test('a selected max_completion_tokens budget is forwarded by both actual generation and connection test', async t => {
    const { client, settings, requests } = fixture(t);
    settings.tokenLimitParameter = 'max_completion_tokens';
    await client.complete({ systemPrompt: 'system', userContent: 'minimal summary', maxTokens: 64 });
    await client.test();
    const bodies = requests.map(item => JSON.parse(item.options.body));
    assert.equal(bodies[0].max_completion_tokens, 64);
    assert.equal(bodies[1].max_completion_tokens, settings.summaryMaxTokens);
    assert.ok(bodies.every(body => !Object.hasOwn(body, 'max_tokens')));
});

test('OpenAI-compatible response_format and the configured thinking mode reach the ST transport', async t => {
    const { client, requests, settings } = fixture(t);
    settings.thinkingMode = 'enabled';
    await client.complete({
        messages: [{ role: 'user', content: 'structured' }], maxTokens: 64,
        response_format: { type: 'json_object' }, enable_thinking: true,
        top_p: 0.8, extraBody: { provider_extension: 'kept' },
    });
    const body = JSON.parse(requests[0].options.body);
    assert.deepEqual(body.messages, [{ role: 'user', content: 'structured' }]);
    assert.deepEqual(body.response_format, { type: 'json_object' });
    assert.deepEqual(JSON.parse(body.custom_include_body), {
        provider_extension: 'kept', response_format: { type: 'json_object' }, thinking: { type: 'enabled' },
        enable_thinking: true, top_p: 0.8,
    });
});

test('an upstream-style JSON404 is not a missing-route fallback; unreadable404 errors are sanitized', async t => {
    const { client, root, logs } = fixture(t);
    root.fetch = async () => new Response('{"error":{"message":"model not found"}}', { status: 404 });
    await assert.rejects(client.test(), error => error.diagnostics.proxy === 'HTTP 404' && /model not found/.test(error.message));
    root.fetch = async () => ({ status: 404, ok: false, text: async () => { throw new Error('read failed private-ark-key csrf-2'); } });
    await assert.rejects(client.test(), error => {
        assert.doesNotMatch(JSON.stringify({ error: error.message, diagnostics: error.diagnostics, logs }), /private-ark-key|csrf-2/);
        assert.equal(error.diagnostics.proxy, 'HTTP 404');
        return true;
    });
});

test('per-request cancellation aborts one response body without cancelling a separate request', async t => {
    const { client, root } = fixture(t);
    let started;
    const reading = new Promise(resolve => { started = resolve; });
    root.fetch = async (_url, options) => {
        const body = JSON.parse(options.body);
        if (body.messages[1].content === 'independent') return new Response('{"choices":[{"message":{"content":"ok"}}]}');
        return { status: 200, ok: true, text: () => new Promise((_resolve, reject) => {
            options.signal.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')), { once: true });
            started();
        }) };
    };
    const controller = new AbortController();
    const pending = client.complete({ userContent: 'cancel me', signal: controller.signal });
    await reading;
    assert.equal((await client.complete({ userContent: 'independent' })).content, 'ok');
    controller.abort();
    await assert.rejects(pending, error => error.code === 'REQUEST_ABORTED');
    assert.equal(client.activeControllers.size, 0);
});

test('proxy gateway504 and confirmed upstream504 keep distinct diagnostics and retryable status', async t => {
    const { client, root } = fixture(t);
    root.fetch = async () => new Response('<html>504 Gateway Time-out / openresty</html>', { status: 504 });
    await assert.rejects(client.test(), error => error.status === 504 && error.category === 'proxy_error'
        && error.diagnostics.proxy === 'HTTP 504' && error.diagnostics.upstream.startsWith('未提供'));
    root.fetch = async () => new Response('{"error":{"status":504,"message":"Gateway timeout"}}');
    await assert.rejects(client.test(), error => error.status === 504 && error.category === 'upstream_error'
        && error.diagnostics.proxy === 'HTTP 200' && error.diagnostics.upstream === 'HTTP 504');
});

test('SSE chunks are joined across transport boundaries; reasoning-only chunks are tolerated and measured', async t => {
    const { client, root, logs } = fixture(t);
    root.fetch = async () => sseResponse([
        'data: {"choices":[{"delta":{"reasoning_content":"先分析"}}]}\n\n',
        'data: {"choices":[{"del',
        'ta":{"content":"[SUMMARY]\\n"}}]}\r\n\r\n',
        'data: {"choices":[{"delta":{"thinking":"内部思考","content":"[Event]\\n事实"},"finish_reason":"stop"}]}\n\n',
        'data: [DONE]\n\n',
        'data: {"choices":[{"delta":{"content":"不应读取"}}]}\n\n',
    ]);
    const result = await client.complete({ systemPrompt: '只返回摘要', userContent: '私密正文' });
    assert.equal(result.content, '[SUMMARY]\n[Event]\n事实');
    assert.equal(result.reasoning, '先分析内部思考');
    assert.equal(result.finishReason, 'stop');
    assert.equal(result.diagnostics.stream, true);
    assert.match(result.diagnostics.contentType, /text\/event-stream/);
    assert.equal(typeof result.diagnostics.ttfbMs, 'number');
    assert.equal(typeof result.diagnostics.ttfcMs, 'number');
    assert.equal(typeof result.diagnostics.totalMs, 'number');
    assert.doesNotMatch(JSON.stringify(logs), /private-ark-key|私密正文|只返回摘要/);
    assert.match(JSON.stringify(logs), /systemPromptChars|userChars|ttfbMs|ttfcMs|totalMs/);
});

test('an SSE stream with reasoning but no ordinary content fails only after DONE', async t => {
    const { client, root } = fixture(t);
    root.fetch = async () => sseResponse([
        'data: {"choices":[{"delta":{"reasoning":"有思考但没有正文"}}]}\n\n',
        'data: [DONE]\n\n',
    ]);
    await assert.rejects(client.complete({ userContent: 'body' }), /没有可用文本/);
});

test('auto transport falls back once only for an explicit unsupported-stream 4xx', async t => {
    const { client, root } = fixture(t);
    const streams = [];
    root.fetch = async (_url, options) => {
        const body = JSON.parse(options.body);
        streams.push(body.stream);
        if (body.stream) return new Response('{"error":{"status":400,"message":"stream is not supported by this endpoint"}}', {
            headers: { 'Content-Type': 'application/json' },
        });
        return new Response('{"choices":[{"message":{"content":"fallback ok"}}]}', { headers: { 'Content-Type': 'application/json' } });
    };
    const result = await client.complete({ userContent: 'body' });
    assert.equal(result.content, 'fallback ok');
    assert.equal(result.diagnostics.streamFallback, true);
    assert.deepEqual(streams, [true, false]);
});

test('auto transport never falls back to non-streaming for 504, timeout or vague 4xx', async t => {
    const { client, root } = fixture(t);
    for (const response of [
        () => new Response('504 Gateway Time-out / openresty', { status: 504 }),
        () => new Response('{"error":{"status":400,"message":"bad request"}}', { headers: { 'Content-Type': 'application/json' } }),
    ]) {
        let requests = 0;
        root.fetch = async () => { requests++; return response(); };
        await assert.rejects(client.complete({ userContent: 'body' }));
        assert.equal(requests, 1);
    }
});

test('forced stream and non-stream modes send the selected body; Ark auto mode prefers stream', async t => {
    const { client, root, settings } = fixture(t);
    const streams = [];
    root.fetch = async (_url, options) => {
        streams.push(JSON.parse(options.body).stream);
        return new Response('{"choices":[{"message":{"content":"OK"}}]}', { headers: { 'Content-Type': 'application/json' } });
    };
    await client.complete({ userContent: 'auto' });
    await client.complete({ userContent: 'stream', transportMode: 'stream' });
    await client.complete({ userContent: 'non-stream', transportMode: 'non-stream' });
    assert.match(settings.apiBaseUrl, /ark\.cn-beijing\.volces\.com\/api\/coding\/v3/);
    assert.deepEqual(streams, [true, true, false]);
});

test('Summary, Checkpoint and Long Memory all consume SSE through the ST backend', async t => {
    const { client, root, settings, requests } = fixture(t);
    Object.assign(settings, { checkpointInterval: 1, longMemoryInterval: 1 });
    root.fetch = async (url, options) => {
        requests.push({ url, options });
        const prompt = JSON.parse(options.body).messages[0].content;
        const content = prompt.includes('[CHECKPOINT]') ? '[CHECKPOINT]\n[Current State]\n状态'
            : prompt.includes('[LONG_MEMORY]') ? '[LONG_MEMORY]\n- 【人物｜状态】事实'
                : '[SUMMARY]\n[Title]\n标题\n[Event]\n事件\n[KEEP]\n无';
        return sseResponse([
            `data: ${JSON.stringify({ choices: [{ delta: { reasoning_content: 'think' } }] })}\n\n`,
            `data: ${JSON.stringify({ choices: [{ delta: { content }, finish_reason: 'stop' }] })}\n\n`,
            'data: [DONE]\n\n',
        ]);
    };
    const metadata = {};
    const chat = [{ name: 'A', mes: '正文', is_user: false, gen_started: '1', send_date: '1' }];
    const store = new MemoryStore({ getMetadata: () => metadata, getChatId: () => 'chat', saveMetadata: () => {} });
    const summarizer = new MemorySummarizer({ store, apiClient: client, getSettings: () => settings, getChat: () => chat });
    await summarizer.summarizeMessage(getAssistantMessages(chat)[0].messageId);
    assert.equal(store.current().summaries[getAssistantMessages(chat)[0].messageId].status, 'frozen');
    assert.equal(store.current().checkpoints.length, 1);
    assert.equal(store.current().longMemories.length, 1);
    assert.equal(requests.length, 3);
    assert.ok(requests.every(item => item.url === '/api/backends/chat-completions/generate'
        && JSON.parse(item.options.body).stream === true
        && JSON.parse(item.options.body).thinking.type === 'disabled'
        && JSON.parse(JSON.parse(item.options.body).custom_include_body).thinking.type === 'disabled'));
});

test('streaming and non-streaming connection tests use the configured Summary budget and expose timing plus final text', async t => {
    const { client, root, requests } = fixture(t);
    root.fetch = async (url, options) => {
        requests.push({ url, options });
        const stream = JSON.parse(options.body).stream;
        return stream ? sseResponse(['data: {"choices":[{"delta":{"content":"OK"}}]}\n\ndata: [DONE]\n\n'])
            : new Response('{"choices":[{"message":{"content":"OK"}}]}', { headers: { 'Content-Type': 'application/json' } });
    };
    const streamed = await client.test({ stream: true });
    const nonStreamed = await client.test({ stream: false });
    assert.equal(streamed.content, 'OK');
    assert.equal(nonStreamed.content, 'OK');
    assert.equal(streamed.stream, true);
    assert.equal(nonStreamed.stream, false);
    assert.equal(typeof streamed.ttfcMs, 'number');
    assert.equal(nonStreamed.ttfcMs, null);
    const bodies = requests.map(item => JSON.parse(item.options.body));
    assert.ok(bodies.every(body => body.max_tokens === 1024 && body.temperature === 0.2
        && body.thinking.type === 'disabled'
        && JSON.parse(body.custom_include_body).thinking.type === 'disabled'
        && body.messages[0].content === 'Reply with exactly OK.' && body.messages[1].content === 'OK'));
});
