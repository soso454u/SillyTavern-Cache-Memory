import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import * as defaults from '../src/defaults.js';
import * as cache from '../src/cache-control.js';
import { MemoryStore, createEmptyStore } from '../src/memory-store.js';
import { getAssistantMessages } from '../src/utils.js';

const clone = value => structuredClone(value);
const settle = () => new Promise(resolve => setImmediate(resolve));
function gate() { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; }
const storage = () => {
    const data = new Map();
    return { getItem: key => data.get(key) ?? null, setItem: (key, value) => data.set(key, value), removeItem: key => data.delete(key), key: i => [...data.keys()][i], get length() { return data.size; } };
};
const source = (await readFile(new URL('../index.js', import.meta.url), 'utf8'))
    .replace(/^import[\s\S]*?from ['"][^'"]+['"];\n/gm, '').replaceAll('export function ', 'function ');
const modules = Object.assign({}, ...await Promise.all(['defaults', 'cache-control', 'utils', 'memory-store', 'summarizer', 'persistence', 'history-handoff', 'chat-file', 'chat-branch']
    .map(name => import(`../src/${name}.js`))));
async function runtimeFixture(t, { blocked = false, invalid = false, shortHistory = false } = {}) {
    t.mock.method(console, 'info', () => {}); t.mock.method(console, 'warn', () => {});
    const chatId = JSON.stringify(['character', 'synthetic.png', 'synthetic']);
    const chat = Array.from({ length: 5 }, (_, i) => ({ mes: `运行时合成正文${i + 1}`, gen_started: `g${i}` }));
    chat[0].extra = { cache_memory_branch: { hasOpening: false } };
    const settings = defaults.normalizeSettings({ autoSummarize: false, checkpointInterval: 5, longMemoryInterval: 5,
        ...(shortHistory ? { injectionMode: defaults.INJECTION_MODES.CHECKPOINT_SHORT_HISTORY } : {}) });
    let remote = createEmptyStore(chatId);
    for (const entry of getAssistantMessages(chat)) if (entry.floor !== 2) remote.summaries[entry.messageId] = {
        floor: entry.floor, messageIndex: entry.messageIndex, messageId: entry.messageId, sourceFingerprint: entry.fingerprint,
        sourceContentFingerprint: entry.contentFingerprint, event: `原合成摘要${entry.floor}`, status: 'frozen', frozen: true,
    };
    cache.refreshSnapshot(remote, settings, 'manual reinject');
    const metadata = { cache_memory: clone(remote) }, calls = [], publications = [], statuses = [], handlers = new Map(), hold = gate();
    const context = { chatId: 'synthetic', mainApi: 'openai', characterId: 0, characters: [{ name: 'A', avatar: 'synthetic.png' }], chatMetadata: metadata, chat,
        getRequestHeaders: () => ({ 'Content-Type': 'application/json' }), saveMetadata: async () => { remote = clone(metadata.cache_memory); } };
    const window = Object.assign(new EventTarget(), { localStorage: storage(), sessionStorage: storage(), navigator: {}, setTimeout, clearTimeout,
        fetch: async () => new Response(JSON.stringify([{ chat_metadata: { cache_memory: clone(remote) } }, ...chat])) });
    const document = Object.assign(new EventTarget(), { readyState: 'complete', visibilityState: 'visible' });
    class UI {
        constructor(options) { this.callbacks = options; }
        setStatus(...args) { statuses.push(args); }
        cancelMissingCheckpointBackfill() {} mountSettings() { return true; } bindChatActions() {} renderMemorySaveState() {}
        refreshSummaryMode() {} queueManagerRender() {} queueMessageRender() {} destroy() {}
    }
    class EmptyClient { abortAll() {} install() {} probe() { return Promise.resolve(); } uninstall() {} }
    class Server extends EmptyClient { available = false; }
    class Publisher { publish(value) { publications.push(value); return {}; } supportsHistoryPlacement() { return true; } dispose() {} }
    class Client extends EmptyClient {
        async complete(request) {
            const kind = request.userContent.startsWith('[PREVIOUS_CONTEXT]') ? 'CP' : request.userContent.startsWith('[EXISTING_LONG_FACTS]') ? 'Long' : 'Summary';
            calls.push(kind);
            if (blocked && calls.length === 1) await new Promise((resolve, reject) => {
                const stop = () => reject(Object.assign(new Error('cancelled'), { code: 'REQUEST_ABORTED' }));
                request.signal.addEventListener('abort', stop, { once: true });
                if (request.signal.aborted) stop();
                hold.promise.then(() => { request.signal.removeEventListener('abort', stop); resolve(); });
            });
            return { content: invalid ? '[SUMMARY]\n[Event]\n无' : { Summary: '[SUMMARY]\n[Event]\n信使确认明天送信。',
                CP: '[CHECKPOINT]\n[Stage Story]\n信使与医师商定了通信约定。', Long: '[STORY_ARC]\n医师与信使完成通信，并约定继续合作。\n[LONG_MEMORY]\n无' }[kind] };
        }
    }
    const bindings = { ...modules, chat, chat_metadata: metadata,
        eventSource: { on: (name, fn) => handlers.set(name, fn), off: name => handlers.delete(name) }, event_types: { GENERATION_STOPPED: 'stopped' },
        extension_prompt_roles: {}, extension_prompt_types: {}, getCurrentChatId: () => context.chatId, isGenerating: () => true,
        saveSettingsDebounced() {}, setExtensionPrompt() {}, extension_settings: { [defaults.MODULE_ID]: settings }, getContext: () => context, promptManager: null,
        SummaryApiClient: Client, ApiCacheAdapterBridge: EmptyClient, CacheMemoryInjectionPublisher: Publisher, MemoryServerClient: Server, CacheMemoryUI: UI,
        window, document, requestAnimationFrame: fn => setTimeout(fn, 0), cancelAnimationFrame: clearTimeout };
    const runtime = new Function(...Object.keys(bindings), `${source}\nreturn {store, summarizer, persistence, refreshChatState, historyInterceptor, onHotUnload};`)(...Object.values(bindings));
    t.after(() => runtime.onHotUnload());
    await runtime.refreshChatState({ serverLoaded: true }); await settle();
    runtime.summarizer.retryDelay = async () => {};
    return { ...runtime, chat, context, calls, publications, statuses, handlers, hold, get remote() { return remote; } };
}

test('actual interceptor waits, saves all layers, then publishes and filters the same prompt', async t => {
    const f = await runtimeFixture(t, { blocked: true }), prompt = clone(f.chat), before = clone(f.chat), aborted = [];
    let finished = false;
    const pending = f.historyInterceptor(prompt, 10000, value => aborted.push(value), 'normal').then(() => { finished = true; });
    await settle(); assert.equal(finished, false); assert.deepEqual(prompt, before); assert.deepEqual(f.calls, ['Summary']);
    f.hold.resolve(); await pending;
    assert.deepEqual(f.calls, ['Summary', 'CP', 'Long']);
    assert.equal(f.remote.checkpoints[0].status, 'frozen'); assert.equal(f.remote.longMemories[0].status, 'frozen');
    assert.equal(Object.keys(f.remote.summaries).length, 5);
    assert.equal(prompt.length, 3); assert.deepEqual(aborted, []); assert.deepEqual(f.chat, before);
    assert.match(f.publications.at(-1), /信使确认明天送信/);
    await f.historyInterceptor(clone(f.chat), 10000, () => assert.fail('complete injection must not abort'), 'normal');
    assert.equal(f.calls.length, 3);
});

test('native stop cancels the paid preflight and aborts the main request without filtering its history', async t => {
    const f = await runtimeFixture(t, { blocked: true }), prompt = clone(f.chat), before = clone(prompt), aborted = [];
    const pending = f.historyInterceptor(prompt, 10000, value => aborted.push(value), 'normal');
    await settle(); f.handlers.get('stopped')(); await pending;
    assert.deepEqual(aborted, [true]); assert.deepEqual(prompt, before); assert.deepEqual(f.calls, ['Summary']);
    assert.equal(Object.keys(f.remote.summaries).length, 4); assert.equal(f.summarizer.injectionRecovery, null);
});

test('persistent validation errors keep the Rolling cap and report uncovered old floors', async t => {
    const f = await runtimeFixture(t, { invalid: true }), prompt = clone(f.chat), aborted = [];
    await f.historyInterceptor(prompt, 10000, value => aborted.push(value), 'normal');
    assert.deepEqual(f.calls, ['Summary', 'Summary', 'Summary', 'Summary']); assert.deepEqual(aborted, []);
    assert.deepEqual(prompt.map(row => row.mes), ['运行时合成正文3', '运行时合成正文4', '运行时合成正文5']);
    assert.ok(f.chat.some(row => row.mes === '运行时合成正文2'));
    assert.ok(f.statuses.some(([status, text]) => status === 'warning' && text.includes('下次注入')));
    assert.ok(f.statuses.some(([status, text]) => status === 'warning' && text.includes('只发送最近 3 层 char 正文')));
    assert.equal(f.remote.checkpoints.length, 0); assert.equal(f.remote.longMemories.length, 0);
});

test('Rolling caps the request while the new chat memory is still loading', async t => {
    const f = await runtimeFixture(t), prompt = clone(f.chat), publications = f.publications.length;
    f.context.chatId = 'next-chat';
    await f.historyInterceptor(prompt, 10000, () => assert.fail('window selection must not abort'), 'normal');
    assert.deepEqual(prompt, f.chat.slice(-3));
    assert.equal(f.calls.length, 0);
    assert.equal(f.publications.length, publications);
});

test('short history applies Summary replacements even with no removed rows or new frozen bytes', async t => {
    const f = await runtimeFixture(t, { shortHistory: true }), prompt = clone(f.chat), original = clone(f.chat);
    await f.historyInterceptor(prompt, 10000, () => assert.fail('short history must not abort'), 'normal');
    assert.deepEqual(f.calls, ['Summary', 'CP', 'Long']);
    assert.equal(prompt.length, 5);
    assert.deepEqual(prompt.slice(0, 2).map(row => [row.extra.type, row.mes.split('\n')[0]]), [
        ['narrator', '[SUMMARY_STORY_1]'], ['narrator', '[SUMMARY_STORY_2]'],
    ]);
    assert.deepEqual(prompt.slice(2), original.slice(2));
    assert.equal(f.publications.at(-1), '');
    assert.deepEqual(f.chat, original);
    const frozen = f.store.current().injectionSnapshot;
    await f.historyInterceptor(clone(f.chat), 10000, () => assert.fail('short history must not abort'), 'normal');
    assert.equal(f.store.current().injectionSnapshot, frozen);
    assert.equal(f.calls.length, 3);
});

test('quiet background generations skip injection completion entirely', async t => {
    const f = await runtimeFixture(t), prompt = clone(f.chat), before = clone(prompt);
    await f.historyInterceptor(prompt, 10000, () => assert.fail('quiet hook must not abort'), 'quiet');
    assert.deepEqual(f.calls, []); assert.deepEqual(prompt, before);
});

test('editing a user message during preflight aborts the captured main prompt before downstream aggregation', async t => {
    const f = await runtimeFixture(t, { blocked: true }), prompt = clone(f.chat), before = clone(prompt), aborted = [];
    const pending = f.historyInterceptor(prompt, 10000, value => aborted.push(value), 'normal');
    await settle(); f.chat.push({ mes: '等待期间新加入的用户输入', is_user: true }); f.hold.resolve(); await pending;
    assert.deepEqual(aborted, [true]); assert.deepEqual(prompt, before); assert.deepEqual(f.calls, ['Summary']);
    assert.equal(f.summarizer.aggregateDeferrals, 0);
});
