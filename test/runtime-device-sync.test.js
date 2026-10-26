import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import * as defaults from '../src/defaults.js';
import * as cache from '../src/cache-control.js';
import { MemoryStore, createEmptyStore, memoryContentDigest } from '../src/memory-store.js';
import { MemoryPersistenceCoordinator, readSillyTavernRemoteStore } from '../src/persistence.js';
import { captureChatFile, chatFileDownload, prepareChatBranch, saveChatBranch } from '../src/chat-branch.js';
import { chatFileIdentity } from '../src/chat-file.js';
import { getAssistantMessages } from '../src/utils.js';
import { filterCoveredHistory, promptHistoryFloor } from '../src/history-handoff.js';
import { getOpeningSource } from '../src/opening-source.js';

const clone = value => structuredClone(value);
const settle = () => new Promise(resolve => setImmediate(resolve));
const storage = () => { const data = new Map(); return {getItem: key => data.get(key) ?? null, setItem: (key, value) => data.set(key, value), removeItem: key => data.delete(key), key: i => [...data.keys()][i], get length() {return data.size;}}; };
const source = (await readFile(new URL('../index.js', import.meta.url), 'utf8')).replace(/^import[\s\S]*?from ['"][^'"]+['"];\n/gm, '').replaceAll('export function ', 'function ');

const scenarios = ['checkpoint_boundary', 'rolling'].flatMap(injectionMode => [false, true].flatMap(strictCacheMode => [false, true].flatMap(historyHandoff => [false, true].map(lastUserOnly => ({ injectionMode, strictCacheMode, historyHandoff, lastUserOnly, imported: false })))));
scenarios.push({ injectionMode: 'rolling', strictCacheMode: true, historyHandoff: false, lastUserOnly: false, imported: true });
for (const { injectionMode, strictCacheMode, historyHandoff, lastUserOnly, imported } of scenarios) test(`runtime loading, source rebinding and focus stay read-only; actual editing saves (mode=${injectionMode}, strict=${strictCacheMode}, handoff=${historyHandoff}, lastUser=${lastUserOnly}, imported=${imported})`, async () => {
    const chatId = JSON.stringify(['character', 'synthetic.png', 'synthetic']);
    const chat = [{name:'A',mes:'开场白'}, ...Array.from({length: 10}, (_, i) => [
        {name:'U',is_user:true,mes:`输入${i}`,send_date:`u${i}`},
        {name:'A',mes:`合成正文${i}`,gen_started:`g${i}`},
    ]).flat(), {name:'U',is_user:true,mes:'最后输入',send_date:'pending'}];
    const settings = defaults.normalizeSettings({injectionMode, strictCacheMode, historyHandoff, lastUserOnly});
    let remote = createEmptyStore(imported ? JSON.stringify(['character', 'original-avatar.png', 'original-filename']) : chatId), writes = 0;
    for (const entry of getAssistantMessages(chat)) remote.summaries[entry.messageId] = {messageId:entry.messageId, floor:entry.floor, event:`合成事件${entry.floor}`, status:'frozen', frozen:true, sourceFingerprint:entry.fingerprint, sourceContentFingerprint:entry.contentFingerprint};
    remote.checkpoints.push({id:'checkpoint-1', startFloor:1, endFloor:5, content:'已保存历史', status:'frozen', openingContentFingerprint:getOpeningSource(chat).contentFingerprint});
    cache.refreshSnapshot(remote, settings, 'manual reinject');
    const metadata = {integrity: 'synthetic-file-integrity', cache_memory: clone(remote)};
    if (!imported) metadata.cache_memory.summaries[getAssistantMessages(chat)[0].messageId].event = '旧窗口缓存';
    const published = [], branchFiles = new Map();
    const window = Object.assign(new EventTarget(), {localStorage:storage(), sessionStorage:storage(), navigator:{}, setTimeout, clearTimeout,
        fetch: async (url, init) => {
            const body = JSON.parse(init.body);
            if (url === '/api/chats/save') { branchFiles.set(body.file_name, clone(body.chat)); return new Response('{}'); }
            if (body.file_name !== 'synthetic') return new Response(JSON.stringify(branchFiles.get(body.file_name) ?? []));
            return new Response(JSON.stringify([{chat_metadata:{integrity:'synthetic-file-integrity',cache_memory:clone(remote)}}, ...chat]));
        }});
    const document = Object.assign(new EventTarget(), {readyState:'complete', visibilityState:'visible'});
    const handlers = new Map();
    const context = {chatId:'synthetic', characterId:0, characters:[{name:'A', avatar:'synthetic.png'}], chatMetadata:metadata, chat,
        getRequestHeaders: () => ({'Content-Type':'application/json'}), saveMetadata: async () => {writes++;remote=clone(metadata.cache_memory);} };
    class UI {constructor(options){this.callbacks=options;}setStatus(){}cancelMissingCheckpointBackfill(){}mountSettings(){return true;}bindChatActions(){}renderMemorySaveState(){}refreshSummaryMode(){}queueManagerRender(){}queueMessageRender(){}destroy(){}}
    class EmptyClient {abortAll(){}install(){}probe(){return Promise.resolve();}uninstall(){}invalidateContext(){}}
    class Server extends EmptyClient {available=false;}
    class Publisher {publish(value){published.push(value);return {};}dispose(){}}
    const bindings = {chat, chat_metadata:metadata, eventSource:{on:(name, fn)=>handlers.set(name,fn), off:name=>handlers.delete(name)}, event_types:{CHAT_CHANGED:'changed', CHAT_LOADED:'loaded'}, extension_prompt_roles:{}, extension_prompt_types:{}, getCurrentChatId:()=> 'synthetic', isGenerating:()=>false, saveSettingsDebounced:()=>{}, setExtensionPrompt:()=>{}, extension_settings:{[defaults.MODULE_ID]:settings}, getContext:()=>context, promptManager:null,
        SummaryApiClient:EmptyClient, ApiCacheAdapterBridge:EmptyClient, CacheMemoryInjectionPublisher:Publisher, MemoryStore, MemorySummarizer:EmptyClient, CacheMemoryUI:UI, MemoryPersistenceCoordinator, readSillyTavernRemoteStore, chatFileIdentity, captureChatFile, chatFileDownload, prepareChatBranch, saveChatBranch, memoryContentDigest, MemoryServerClient:Server, getAssistantMessages, window, document,
        requestAnimationFrame:fn=>setTimeout(fn,0), cancelAnimationFrame:clearTimeout,
        API_KEY_STORAGE_KEY:defaults.API_KEY_STORAGE_KEY, INJECTION_KEY:defaults.INJECTION_KEY, MODULE_ID:defaults.MODULE_ID, normalizeLoadedSettings:defaults.normalizeLoadedSettings, normalizeSettings:defaults.normalizeSettings,
        CacheDiagnostics:cache.CacheDiagnostics, refreshSnapshot:cache.refreshSnapshot, shouldRefreshInjection:cache.shouldRefreshInjection, filterCoveredHistory, promptHistoryFloor};
    const runtime = new Function(...Object.keys(bindings), `${source}\nreturn {store, persistence, refreshChatState, onHotUnload, updateSettings, ui};`)(...Object.values(bindings));
    try {
        await runtime.refreshChatState({serverLoaded:true}); await settle();
        assert.equal(writes,imported ? 1 : 0); assert.equal(runtime.persistence.conflicts.size,0);
        assert.equal(metadata.cache_memory.summaries[getAssistantMessages(chat)[0].messageId].event,'合成事件1');
        assert.equal(metadata.cache_memory.chatId, chatId);
        assert.equal(remote.chatId, chatId);
        if (imported) {
            const snapshot = runtime.ui.callbacks.captureChat();
            const downloaded = runtime.ui.callbacks.exportChat(snapshot);
            assert.deepEqual(downloaded.content.trim().split('\n').map(JSON.parse).slice(1), chat);
            const sourceBefore = clone(metadata);
            const created = await runtime.ui.callbacks.createChatBranch(snapshot, { mode: 'recent', count: 3, name: 'runtime-branch', openAfterCreate: false });
            assert.equal(created.switched, false);
            assert.equal(branchFiles.size, 1);
            assert.deepEqual(getAssistantMessages(branchFiles.get(created.filename).slice(1)).map(row=>row.floor), [8,9,10]);
            assert.deepEqual(metadata, sourceBefore);
            assert.equal(context.chatId, 'synthetic');
        }
        const originalChat = clone(chat), prompt = clone(chat);
        globalThis.cacheMemoryHistoryInterceptor(prompt, 10000, () => {}, 'normal');
        assert.equal(prompt.filter(row=>!row.is_user).length, injectionMode === 'rolling' ? 3 : historyHandoff ? 5 : lastUserOnly ? 10 : 11);
        assert.equal(prompt.filter(row=>row.is_user).length, lastUserOnly ? 1 : injectionMode === 'rolling' ? 4 : historyHandoff ? 6 : 11);
        assert.deepEqual(chat, originalChat);
        const snapshotBefore = clone(runtime.store.current().injectionSnapshot);
        runtime.updateSettings({lastUserOnly:!lastUserOnly});
        const toggled = clone(chat);
        globalThis.cacheMemoryHistoryInterceptor(toggled,10000,()=>{},'normal');
        assert.equal(toggled.filter(row=>row.is_user).length,!lastUserOnly ? 1 : injectionMode === 'rolling' ? 4 : historyHandoff ? 6 : 11);
        assert.deepEqual(runtime.store.current().injectionSnapshot,snapshotBefore);
        runtime.updateSettings({lastUserOnly});
        remote.checkpoints[0].content='服务器最新重大历史';cache.refreshSnapshot(remote, settings,'manual reinject');
        window.dispatchEvent(new Event('focus'));await settle();
        assert.equal(writes,imported ? 1 : 0);assert.equal(published.at(-1),remote.injectionSnapshot.value);
        handlers.get('loaded')();await new Promise(resolve=>setTimeout(resolve,5));await settle();assert.equal(writes,imported ? 1 : 0);
        runtime.store.updateSummary(getAssistantMessages(chat)[0].messageId,{event:'用户实际修改'});
        await settle();await runtime.persistence.flush();await settle();await runtime.persistence.flush();
        assert.ok(writes>0);assert.equal(remote.summaries[getAssistantMessages(chat)[0].messageId].event,'用户实际修改');
        assert.equal(runtime.persistence.conflicts.size,0);
    } finally {runtime.onHotUnload(); assert.equal(globalThis.cacheMemoryHistoryInterceptor, undefined);}
});
