import test from 'node:test';
import assert from 'node:assert/strict';
import { SummaryApiClient } from '../src/api-client.js';
import { CacheMemoryUI } from '../src/ui.js';
import { normalizeSettings } from '../src/defaults.js';
import { MemoryStore } from '../src/memory-store.js';
import { MemorySummarizer } from '../src/summarizer.js';
import { getAssistantMessages } from '../src/utils.js';

function fixture(t) {
    const previous = Object.getOwnPropertyDescriptor(globalThis, 'parent');
    const consoleLogs = [];
    for (const name of ['info', 'warn']) t.mock.method(console, name, (...args) => consoleLogs.push(args));
    let chatId = 'log-chat', reply = () => new Response('{"choices":[{"message":{"content":"ok"}}]}');
    const requests = [], events = [], settings = normalizeSettings({ apiBaseUrl: 'https://model.example/v1', model: 'synthetic-model', generationTransport: 'non-stream' });
    const root = { location: { href: 'https://st.example/' }, getRequestHeaders: () => ({ 'X-CSRF-Token': 'synthetic-csrf-secret', 'Content-Type': 'application/json' }),
        requestAnimationFrame: () => 1, fetch: async (url, options) => { requests.push({ url, payload: JSON.parse(options.body) }); return reply(requests.at(-1).payload); } };
    Object.defineProperty(globalThis, 'parent', { configurable: true, value: root });
    t.after(() => previous ? Object.defineProperty(globalThis, 'parent', previous) : delete globalThis.parent);
    const client = new SummaryApiClient({ getSettings: () => settings, storage: { getItem: () => 'synthetic-api-secret' }, storageKey: 'key' });
    const ui = new CacheMemoryUI({ store: { current: () => ({ chatId }) } });
    ui.root = root;
    const panel = { textContent: '', scrollHeight: 0, scrollTop: 0, clientHeight: 0, closest: () => ({ open: true }) };
    ui.config = { querySelector: () => panel };
    const onGeneration = event => { events.push(event); ui.recordGeneration({ ...event, chatId, label: 'Summary · 第 1 层' }); };
    return { client, ui, panel, settings, requests, events, consoleLogs, onGeneration, setReply: fn => { reply = fn; }, switchChat: id => { chatId = id; } };
}

function stream(parts) {
    return new Response(new ReadableStream({ start(controller) {
        const encoder = new TextEncoder();
        for (const part of parts) controller.enqueue(encoder.encode(part));
        controller.close();
    } }), { headers: { 'Content-Type': 'text/event-stream' } });
}

test('logs keep the exact sent messages and full JSON including reasoning, refusal, usage and extra choices', async t => {
    const f = fixture(t), source = '合成来源'.repeat(5000) + 'SOURCE_TAIL';
    const content = '抱歉，没有找到相关的结果。' + '正文'.repeat(7000) + 'RESPONSE_TAIL';
    const data = { id: 'synthetic-response', choices: [{ message: { content, reasoning_content: '返回的思考片段',
        tool_calls: [{ id: 'tool-result', function: { name: 'synthetic', arguments: '{}' } }] }, finish_reason: 'stop' },
        { index: 1, message: { content: '第二条返回内容' } }], usage: { total_tokens: 123 }, provider_field: '保留额外字段' };
    const raw = JSON.stringify(data);
    f.setReply(() => new Response(raw, { headers: { 'Content-Type': 'application/json', 'X-Request-Id': 'trace-id', 'Set-Cookie': 'secret-cookie' } }));
    const result = await f.client.complete({ systemPrompt: 'SYSTEM_SENTINEL', userContent: source, onGeneration: f.onGeneration });
    const sent = JSON.parse(f.events.find(event => event.type === 'request').payload);
    assert.deepEqual(sent.messages, f.requests[0].payload.messages);
    assert.equal(sent.custom_include_headers, '[REDACTED]');
    assert.match(f.requests[0].payload.custom_include_headers, /synthetic-api-secret/);
    assert.equal(f.events.find(event => event.type === 'response-body').body, raw);
    assert.equal(result.content, content);
    const text = f.ui.generationLogText();
    for (const value of ['SYSTEM_SENTINEL', 'SOURCE_TAIL', 'RESPONSE_TAIL', '返回的思考片段', '抱歉，没有找到相关的结果。',
        '第二条返回内容', 'tool-result', 'total_tokens', '保留额外字段', 'trace-id']) assert.ok(text.includes(value), value);
    assert.doesNotMatch(text, /synthetic-api-secret|synthetic-csrf-secret|secret-cookie|日志预览已达到/);
    assert.match(text, /application\/json/);
    assert.doesNotMatch(JSON.stringify(f.consoleLogs), /SYSTEM_SENTINEL|SOURCE_TAIL|返回的思考片段/);
    assert.equal(f.requests.length, 1);
    f.ui.renderGenerationLog();
    assert.equal(f.panel.textContent, text);
});

test('SSE raw frames, metadata, DONE and reasoning are retained across byte and line boundaries', async t => {
    const f = fixture(t);
    f.settings.generationTransport = 'stream';
    const raw = ': keepalive\r\ndata: {"id":"sse-id","choices":[{"delta":{"reasoning":"思考"}}]}\r\n\r\n'
        + 'data: {"choices":[{"delta":{"content":"甲"}}]}\n\ndata: {"choices":[{"delta":{"content":"乙"},"finish_reason":"stop"}]}\n\n'
        + 'data: {"choices":[],"usage":{"completion_tokens":2}}\n\ndata: [DONE]\n\n';
    f.setReply(() => stream([...raw]));
    const result = await f.client.complete({ userContent: '合成输入', onGeneration: f.onGeneration });
    assert.equal(result.content, '甲乙');
    assert.equal(f.events.find(event => event.type === 'response-body').body.trimEnd(), raw.trimEnd());
    assert.equal(f.ui.generationLog[0].attempts[0].output, '甲乙');
    assert.match(f.ui.generationLogText(), /sse-id[\s\S]*completion_tokens[\s\S]*\[DONE\]/);
    assert.match(f.ui.generationLogText(), /接口返回的思考内容\]\n思考/);
});

test('all internal attempts keep their actual payload and error body instead of overwriting the first failure', async t => {
    const f = fixture(t); f.settings.generationTransport = 'auto';
    f.settings.limitOutputTokens = true;
    f.setReply(payload => {
        if (payload.max_tokens) return new Response('{"error":{"message":"unsupported max_tokens; use max_completion_tokens"}}', { status: 400 });
        if (payload.stream) return new Response('{"error":{"message":"stream is not supported"}}', { status: 400 });
        return new Response('{"choices":[{"message":{"content":"最终响应"}}]}');
    });
    const result = await f.client.complete({ systemPrompt: 'SYSTEM', userContent: 'INPUT', maxTokens: 100, onGeneration: f.onGeneration });
    assert.equal(result.content, '最终响应');
    const attempts = f.ui.generationLog[0].attempts;
    assert.equal(attempts.length, 4);
    assert.equal(JSON.parse(attempts[0].payload).max_tokens, 100);
    assert.equal(JSON.parse(attempts[1].payload).max_completion_tokens, 100);
    assert.equal(JSON.parse(attempts[2].payload).stream, false);
    assert.equal(JSON.parse(attempts[3].payload).max_completion_tokens, 100);
    assert.match(attempts[0].body, /unsupported max_tokens/);
    assert.match(attempts[1].body, /stream is not supported/);
    assert.equal(attempts[0].error.status, 400);
});

test('HTTP and interrupted SSE errors keep all observable response data', async t => {
    const f = fixture(t), raw = '<html>' + '错误'.repeat(7000) + 'ERROR_TAIL</html>';
    f.setReply(() => new Response(raw, { status: 502 }));
    await assert.rejects(f.client.complete({ userContent: '合成输入', onGeneration: f.onGeneration }));
    assert.equal(f.ui.generationLog[0].attempts[0].body, raw);
    assert.ok(f.ui.generationLogText().includes('ERROR_TAIL'));
    f.ui.clearGenerationLog(); f.settings.generationTransport = 'stream';
    const partial = 'data: {"choices":[{"delta":{"content":"已返回片段"}}]}\n\ndata: {"error":{"message":"连接中止","status":503}}\n\n';
    f.setReply(() => stream([partial]));
    await assert.rejects(f.client.complete({ userContent: '合成输入', onGeneration: f.onGeneration }));
    assert.equal(f.ui.generationLog[0].attempts[0].body, partial);
    assert.match(f.ui.generationLogText(), /已返回片段[\s\S]*连接中止/);
});

test('known credentials and credential fields are redacted without changing the actual response', async t => {
    const f = fixture(t);
    const data = { choices: [{ message: { content: 'synthetic-api-secret synthetic-csrf-secret Bearer hidden-value' } }], api_key: 'other-secret' };
    f.setReply(() => new Response(JSON.stringify(data)));
    const result = await f.client.complete({ userContent: '正常正文', onGeneration: f.onGeneration });
    assert.ok(result.content.includes('synthetic-api-secret'));
    const logs = JSON.stringify(f.events) + f.ui.generationLogText();
    assert.doesNotMatch(logs, /synthetic-api-secret|synthetic-csrf-secret|hidden-value|other-secret/);
    assert.match(logs, /REDACTED/);
    const raw = f.events.find(event => event.type === 'response-body').body;
    assert.equal(JSON.parse(raw).api_key, '[REDACTED]');
});

test('logs stay in the current chat, retain six generations and render markup as literal text', t => {
    const f = fixture(t);
    for (let index = 0; index < 7; index++) {
        f.ui.recordGeneration({ type: 'start', chatId: 'log-chat', label: `floor-${index}` });
        f.ui.recordGeneration({ type: 'response', chatId: 'log-chat', label: `floor-${index}`, text: '</pre><script>literal</script><think>returned</think>' });
    }
    assert.equal(f.ui.generationLog.length, 6);
    assert.equal(f.ui.generationLog[0].label, 'floor-1');
    f.ui.renderGenerationLog();
    assert.ok(f.panel.textContent.includes('<script>literal</script><think>returned</think>'));
    f.switchChat('next-chat');
    f.ui.recordGeneration({ type: 'start', chatId: 'next-chat', label: 'new-generation' });
    f.ui.recordGeneration({ type: 'response', chatId: 'log-chat', label: 'floor-6', text: 'OLD_CHAT_DATA' });
    assert.equal(f.ui.generationLog.length, 1);
    assert.doesNotMatch(f.ui.generationLogText(), /literal|OLD_CHAT_DATA/);
    f.ui.clearGenerationLog();
    assert.equal(f.ui.generationLogText(), '暂无生成记录');
});

test('download uses the same complete plain-text log with the provided document', async t => {
    const f = fixture(t), handlers = {};
    const link = { click() { this.clicked = true; } };
    f.ui.doc = { createElement: tag => { assert.equal(tag, 'a'); return link; } };
    f.ui.bindSettings({ dataset: {}, addEventListener: (type, handler) => { handlers[type] = handler; }, querySelector: () => null });
    f.ui.recordGeneration({ type: 'response', chatId: 'log-chat', label: 'download', text: '完整日志正文' });
    await handlers.click({ target: { closest: selector => selector === '[data-export-generation-log]' ? {} : null } });
    assert.equal(link.clicked, true);
    assert.match(link.download, /^cache-memory-generation-log-\d+\.txt$/);
    const response = await fetch(link.href);
    assert.equal(await response.text(), f.ui.generationLogText());
    assert.match(response.headers.get('content-type'), /text\/plain/);
});

test('content-validation retries preserve the refused response and the changed system prompt in separate entries', async t => {
    const f = fixture(t), metadata = {}, chat = [{ mes: '医师收下信件。', gen_started: 'log-retry' }];
    const store = new MemoryStore({ getChatId: () => 'log-chat', getMetadata: () => metadata, saveMetadata() {} });
    f.ui.store = store;
    f.setReply(() => new Response(JSON.stringify({ choices: [{ message: { content: f.requests.length === 1
        ? '抱歉，没有找到相关的结果。' : '[SUMMARY]\n[Event]\n医师收下信件。' } }] })));
    const summarizer = new MemorySummarizer({ store, apiClient: f.client, getSettings: () => f.settings, getChat: () => chat,
        retryDelay: async () => {}, onGeneration: f.onGeneration });
    await summarizer.summarizeEntry(getAssistantMessages(chat)[0], { deferAggregates: true });
    assert.equal(f.requests.length, 2);
    assert.equal(f.ui.generationLog.length, 2);
    assert.match(f.ui.generationLog[0].attempts[0].body, /抱歉，没有找到相关的结果/);
    assert.ok(f.ui.generationLog[0].events.some(event => event.includes('重试')));
    assert.match(f.ui.generationLog[1].attempts[0].payload, /小总结输出格式重试/);
    assert.equal(store.getSummary(getAssistantMessages(chat)[0].messageId).event, '医师收下信件。');
});
