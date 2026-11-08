import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { CacheDiagnostics } from '../src/cache-control.js';
import { ApiCacheAdapterBridge } from '../src/api-cache-adapter.js';
import { compareRequests, inspectRequest, requestReport } from '../server-plugin/cache-memory-api-adapter/request-integrity.mjs';
import { verifyInboundIntegrity } from '../server-plugin/cache-memory-api-adapter/index.mjs';

const memory = '<CACHE_MEMORY>冻结记忆。</CACHE_MEMORY>';
const system = content => ({ role: 'system', content });
const user = content => ({ role: 'user', content });
const body = (prefix = '固定提示', value = memory, history = ['甲', '乙', '丙']) => ({
    messages: [system(prefix), system(value), ...history.map(user)],
});

test('integrity separates exact memory bytes, merged prefix, and text appended after the memory tag', () => {
    const before = inspectRequest({ messages: [system('固定提示\n' + memory), user('继续')] }, memory);
    const input = { messages: [system([
        { type: 'text', text: '固定提示 <!--随机-->\n<CACHE_MEMORY>冻结' },
        { type: 'text', text: '记忆。 </CACHE_MEMORY><!--附加-->' },
    ]), user('继续')] };
    const original = structuredClone(input);
    const actual = inspectRequest(input, memory);
    assert.equal(actual.memory.state, 'changed');
    assert.equal(actual.memory.firstDifference, memory.indexOf('</CACHE_MEMORY>'));
    assert.deepEqual(compareRequests(before, actual).map(change => change.kind),
        ['memory-text-changed', 'memory-message-suffix-changed', 'prefix-changed']);
    assert.equal(compareRequests(before, requestReport(actual)).at(-1).messageIndex, 0);
    assert.deepEqual(input, original);
    assert.doesNotMatch(JSON.stringify(requestReport(actual)), /固定提示|冻结记忆|附加/);
});

test('cache_control has its own fingerprint and path without changing the prompt fingerprint', () => {
    const input = body();
    const before = inspectRequest(input, memory);
    input.messages[0].content = [{ type: 'text', text: '固定提示', cache_control: { ttl: '1h' } }];
    input.custom_include_headers = '{"Authorization":"secret","anthropic-beta":"prompt-caching-2024-07-31","Cache-Control":"no-cache"}';
    const actual = inspectRequest(input, memory);
    assert.equal(before.messagesHash, actual.messagesHash);
    assert.deepEqual(compareRequests(before, actual), [{
        kind: 'cache-parameters-changed', locations: ['custom_include_headers.anthropic-beta', 'messages[0].content[0].cache_control'],
    }]);
    assert.doesNotMatch(JSON.stringify(actual), /secret|2024-07-31/);
});

test('normal CP publication and history roll are distinct from a same-request prefix rewrite', () => {
    const debug = new CacheDiagnostics();
    const key = 'chat:connection:normal';
    const initial = body();
    const published = '<CACHE_MEMORY>新阶段。</CACHE_MEMORY>';
    debug.settingsReady(key, initial, memory, undefined, 'new checkpoint', true);
    assert.deepEqual(debug.browserRequest(key, initial, true).report.sinceSettingsReady, []);
    const next = body('固定提示', published, ['乙', '丙', '丁']);
    const early = debug.settingsReady(key, next, published, undefined, 'new checkpoint', true);
    assert.deepEqual(early.repeat, { publication: 'new checkpoint', changes: [{ kind: 'history-window-rolled' }] });
    const browser = debug.browserRequest(key, body('固定 提示', published, ['乙', '丙', '丁']), true).report;
    assert.deepEqual(browser.sinceSettingsReady, [{ kind: 'prefix-changed', messageIndex: 0 }]);
    assert.equal(browser.browserFetch.memory.state, 'match');
    assert.equal(browser.browserRepeat.publication, 'new checkpoint');
});

test('ambiguous request association does not reuse a different request baseline or saved reference', () => {
    const debug = new CacheDiagnostics();
    debug.settingsReady('main', body(), memory, { chatId: 'a', revision: 1 }, 'chat changed', true);
    debug.settingsReady('main', body(), memory, { chatId: 'b', revision: 1 }, 'chat changed', true);
    const actual = debug.browserRequest('main', body(), true);
    assert.equal(actual.reference, undefined);
    assert.equal(actual.observation.memory.state, 'unverified');
    assert.equal(debug.browserRequest('main', body(), true).reference, undefined);
});

test('server verifies against the saved authenticated revision and rejects only an identifiable rewrite when opted in', async () => {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'cm-integrity-'));
    let authority, adapter;
    try {
        await fs.cp(new URL('../server-plugin/', import.meta.url), path.join(directory, 'plugins'), { recursive: true });
        await fs.mkdir(path.join(directory, 'src/endpoints/backends'), { recursive: true });
        await fs.writeFile(path.join(directory, 'package.json'), '{"type":"module"}');
        await fs.writeFile(path.join(directory, 'src/util.js'), 'export const getConfigValue = (_key, fallback) => fallback;');
        await fs.writeFile(path.join(directory, 'src/endpoints/backends/chat-completions.js'),
            'export const router = { handle(request, response) { return response.json({ delegated: request.body }); } };');
        const oldDir = process.env.SILLYTAVERN_DATA_DIR;
        process.env.SILLYTAVERN_DATA_DIR = directory;
        try {
            const plugin = name => import(pathToFileURL(path.join(directory, 'plugins', name, 'index.mjs')).href);
            adapter = await plugin('cache-memory-api-adapter');
            const adapterRoutes = new Map();
            await adapter.init({ get() {}, post(route, handler) { adapterRoutes.set(route, handler); } });
            authority = await plugin('cache-memory-memory');
            const routes = new Map();
            await authority.init({ get() {}, post(route, handler) { routes.set(route, handler); } });
            const account = { profile: { handle: 'test-user' } };
            const chatId = 'example-chat';
            await verifySavedRequests({ authority, routes, account, chatId, generate: adapterRoutes.get('/generate') });
        } finally {
            if (oldDir === undefined) delete process.env.SILLYTAVERN_DATA_DIR;
            else process.env.SILLYTAVERN_DATA_DIR = oldDir;
        }
    } finally {
        await adapter?.exit();
        await authority?.exit();
        await fs.rm(directory, { recursive: true, force: true });
    }

    async function verifySavedRequests({ authority, routes, account, chatId, generate }) {
        const saved = { chatId, summaries: {}, checkpoints: [], longMemories: [], keepRegistry: {},
            injectionSnapshot: { signature: '[true,true,"checkpoint_boundary",4,false,3]', mode: 'checkpoint_boundary', value: memory } };
        const response = { json(data) { return data; } };
        const record = await routes.get('/memory/:chatId')({ user: account, params: { chatId }, body: { snapshot: saved } }, response);
        assert.equal(record.record.revision, 1);
        const metadata = { snapshot: { chatId, revision: 1, expectedHash: 'untrusted' },
            policy: { enabled: true, rejectFrozenMemoryChanges: true } };
        const verify = (payload, user = account, reference = metadata) => verifyInboundIntegrity(
            { user, body: { ...payload, cache_memory_adapter: reference } }, authority.readSavedFrozenSnapshot);
        const good = await verify(body('prefix changed', memory));
        assert.equal(good.inbound.memory.state, 'match');
        assert.equal(good.rejected, false);
        assert.equal(good.upstream, 'unobserved');
        const changed = body('固定提示', memory.replace('冻结', '定格'));
        const bad = await verify(changed);
        assert.equal(bad.authority.state, 'saved-frozen-snapshot');
        assert.notEqual(bad.authority.expectedHash, metadata.snapshot.expectedHash);
        assert.equal(bad.inbound.memory.state, 'changed');
        assert.equal(bad.rejected, true);
        assert.equal((await verify(changed, account, { ...metadata, policy: { enabled: true } })).rejected, false);
        assert.equal((await verify(body('固定提示', 'no memory marker'))).rejected, false);
        assert.equal((await verify(body('固定提示', memory + memory))).inbound.memory.state, 'ambiguous');
        assert.equal((await verify(changed, account, { ...metadata, snapshot: { chatId, revision: 2 } })).authority.reason, 'saved-revision-changed');
        const other = await verify(changed, { profile: { handle: 'other-user' } });
        assert.equal(other.authority.state, 'unverifiable');
        assert.equal(other.rejected, false);
        const noStore = await verifyInboundIntegrity({ body: { ...changed, cache_memory_adapter: metadata } }, null);
        assert.equal(noStore.authority.reason, 'authority-store-unavailable');
        assert.equal(noStore.inbound.memory.state, 'unverified');
        assert.equal(noStore.rejected, false);

        const dispatch = async (payload, reference = metadata) => {
            const response = { statusCode: 200, headers: {}, status(code) { this.statusCode = code; return this; },
                setHeader(name, value) { this.headers[name] = value; }, json(data) { this.data = data; return this; } };
            await generate({ url: '/generate', user: account, body: { ...payload, cache_memory_adapter: reference } }, response, error => { throw error; });
            const preview = JSON.parse(decodeURIComponent(response.headers['x-cache-memory-adapter-preview']));
            return { response, preview };
        };
        const blocked = await dispatch(changed);
        assert.equal(blocked.response.statusCode, 409);
        assert.equal(blocked.response.data.delegated, undefined);
        assert.equal(blocked.preview.integrity.rejected, true);
        const delegated = await dispatch(changed, { ...metadata, policy: { enabled: true } });
        assert.equal(delegated.response.statusCode, 200);
        assert.deepEqual(delegated.response.data.delegated.messages, changed.messages);
        assert.equal(delegated.response.data.delegated.cache_memory_adapter, undefined);
        assert.equal(delegated.preview.integrity.inbound.memory.state, 'changed');

        const shortSnapshot = structuredClone(saved);
        shortSnapshot.injectionSnapshot.mode = 'checkpoint_short_history';
        shortSnapshot.injectionSnapshot.signature = '[true,true,"checkpoint_short_history",4,true,3]';
        await routes.get('/memory/:chatId')({ user: account, params: { chatId },
            body: { snapshot: shortSnapshot, baseRevision: 1 } }, response);
        const short = await verify(body(), account, { ...metadata, snapshot: { chatId, revision: 2 } });
        assert.equal(short.inbound.memory.state, 'match');
    }
});

test('independent requests remain on the original route and report an altered payload or missing observation', async () => {
    const requests = [];
    const reports = [];
    const target = { fetch: async (url, init) => { requests.push({ url, init }); return new Response('{}'); } };
    const bridge = new ApiCacheAdapterBridge({ getSettings: () => ({
        cacheDebug: true, apiCacheAdapterEnabled: true, apiCacheDefaultPolicy: { enabled: true },
    }), onInternal: report => reports.push(report) });
    bridge.available = true;
    bridge.install(target);
    const signal = new AbortController().signal;
    const original = { cache_memory_internal: true, messages: [user('原始独立请求')] };
    const finish = bridge.trackInternal(signal, original);
    const init = { method: 'POST', signal, body: JSON.stringify({ messages: [user('修改后的独立请求')] }) };
    await target.fetch('/api/backends/chat-completions/generate', init);
    finish();
    assert.equal(requests[0].url, '/api/backends/chat-completions/generate');
    assert.equal(requests[0].init, init);
    assert.deepEqual(reports[0].changes.map(change => change.kind), ['messages-changed', 'internal-marker-changed']);
    bridge.trackInternal(new AbortController().signal, original)();
    assert.match(reports[1].browserFetch, /不可验证/);

    const observedFetch = target.fetch;
    const laterWrapper = (...args) => observedFetch(...args);
    target.fetch = laterWrapper;
    bridge.uninstall();
    assert.equal(target.fetch, laterWrapper);
    await target.fetch('/api/backends/chat-completions/generate', init);
    assert.equal(requests.length, 2);
});
