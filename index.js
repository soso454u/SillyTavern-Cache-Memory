import {
    chat,
    chat_metadata,
    eventSource,
    event_types,
    extension_prompt_roles,
    extension_prompt_types,
    getCurrentChatId,
    isGenerating,
    saveSettingsDebounced,
    setExtensionPrompt,
} from '../../../../script.js';
import { extension_settings, getContext } from '../../../extensions.js';
import { promptManager } from '../../../openai.js';
import { SummaryApiClient } from './src/api-client.js?v=1.27.8';
import { ApiCacheAdapterBridge } from './src/api-cache-adapter.js?v=1.27.8';
import { API_KEY_STORAGE_KEY, INJECTION_KEY, MODULE_ID, normalizeLoadedSettings, normalizeSettings } from './src/defaults.js?v=1.27.8';
import { CacheDiagnostics, refreshSnapshot, shouldRefreshInjection } from './src/cache-control.js?v=1.27.8';
import { CacheMemoryInjectionPublisher } from './src/injection-target.js?v=1.27.8';
import { getAssistantMessages } from './src/utils.js?v=1.27.8';
import { isUsableMemory } from './src/continuity.js?v=1.27.8';
import { MemoryStore } from './src/memory-store.js?v=1.27.8';
import { MemorySummarizer } from './src/summarizer.js?v=1.27.8';
import { CacheMemoryUI } from './src/ui.js?v=1.27.8';
import { MemoryPersistenceCoordinator, readSillyTavernRemoteStore } from './src/persistence.js?v=1.27.8';
import { MemoryServerClient } from './src/memory-server.js?v=1.27.8';
import { filterCoveredHistory, promptHistoryFloor } from './src/history-handoff.js?v=1.27.8';
import { chatFileIdentity } from './src/chat-file.js?v=1.27.8';
import { captureChatFile, chatFileDownload, prepareChatBranch, saveChatBranch } from './src/chat-branch.js?v=1.27.8';
import { memoryContentDigest } from './src/memory-store.js?v=1.27.8';

const LOG_PREFIX = '[Cache Memory]';
let settings;
let initialized = false;
let ui;
let pendingSwipeIndex = null;
let observedAssistantEntries = new Map();
const pendingMessageChanges = new Set();
let mountObserver = null;
let runtimeController = new AbortController();
const eventBindings = [];
const timers = new Set();
const frames = new Set();
const diagnostics = new CacheDiagnostics();
let activeChatId = null;
let onlineHandler = null;
let refreshRevision = 0;
let publishedMemoryValue = null;

// ST chat filenames are only unique inside a character/group, not globally.
function memoryChatId() {
    return chatFileIdentity(getContext(), getCurrentChatId());
}

const apiCacheAdapter = new ApiCacheAdapterBridge({
    getSettings: () => settings,
    updateSettings,
    fetchImpl: (...args) => window.fetch(...args),
    onStatus: status => ui?.setApiCacheAdapterStatus(status),
});

const memoryServer = new MemoryServerClient({
    fetchImpl: (...args) => window.fetch(...args),
    getHeaders: () => getContext()?.getRequestHeaders?.(),
    storage: window.localStorage,
    onStatus: (state, detail) => console.info(LOG_PREFIX, `authoritative memory ${state}: ${detail}`),
});

const injectionPublisher = new CacheMemoryInjectionPublisher({
    getPromptManager: () => promptManager,
    publishFallback: value => setExtensionPrompt(
        INJECTION_KEY,
        value,
        extension_prompt_types.IN_PROMPT,
        0,
        false,
        extension_prompt_roles.SYSTEM,
    ),
});

function schedule(callback, delay = 0) {
    const id = window.setTimeout(() => {
        timers.delete(id);
        if (!runtimeController.signal.aborted) callback();
    }, delay);
    timers.add(id);
    return id;
}

function nextFrame(callback) {
    const id = requestAnimationFrame(() => {
        frames.delete(id);
        if (!runtimeController.signal.aborted) callback();
    });
    frames.add(id);
    return id;
}

function bindEvent(name, handler) {
    if (!name) return;
    eventSource.on(name, handler);
    eventBindings.push([name, handler]);
}

function loadSettings() {
    settings = normalizeLoadedSettings(extension_settings[MODULE_ID]);
    extension_settings[MODULE_ID] = settings;
    saveSettingsDebounced();
}

function updateSettings(patch) {
    if (Object.hasOwn(patch, 'cacheDebug')) diagnostics.reset();
    settings = normalizeSettings({ ...settings, ...patch });
    extension_settings[MODULE_ID] = settings;
    saveSettingsDebounced();
    return settings;
}

function persistSettings() {
    extension_settings[MODULE_ID] = settings;
    saveSettingsDebounced();
    return saveSettingsDebounced.flush?.();
}

const persistence = new MemoryPersistenceCoordinator({
    getChatId: memoryChatId,
    getMetadata: () => chat_metadata,
    storage: window.localStorage,
    sessionStorage: window.sessionStorage,
    locks: window.navigator.locks,
    createJournalChannel: window.BroadcastChannel ? name => new window.BroadcastChannel(name) : null,
    readRemoteStore: (chatId, options) => {
        if (memoryChatId() !== chatId) throw new Error('聊天身份已变化');
        return readSillyTavernRemoteStore(getContext, getCurrentChatId(), window.fetch.bind(window), options);
    },
    saveMetadata: async chatId => {
        const context = getContext();
        if (memoryChatId() !== chatId) throw new Error('聊天已切换，取消旧聊天保存');
        await context.saveMetadata();
    },
    readAuthoritativeStore: async (chatId, options) => memoryServer.read(chatId, options),
    readAuthoritativeHistory: async chatId => memoryServer.history(chatId),
    commitAuthoritative: async (chatId, payload) => memoryServer.commit(chatId, payload),
    authoritativeAvailable: () => memoryServer.available,
    onStatus: (chatId, status) => {
        if (memoryChatId() !== chatId) return;
        queueMicrotask(() => {
            if (memoryChatId() !== chatId) return;
            ui?.renderMemorySaveState();
            if (status.state === 'confirmed' || status.state === 'conflict') {
                if (status.state === 'confirmed' && store.current().injectionSnapshot?.value !== publishedMemoryValue) updateInjection('chat changed');
                ui?.refreshSummaryMode();
                ui?.queueManagerRender();
                ui?.queueMessageRender();
            }
        });
    },
});

const store = new MemoryStore({
    getMetadata: () => chat_metadata,
    getChatId: memoryChatId,
    saveMetadata: (snapshot, reason) => {
        // Source bookkeeping during loading/rendering is not a user memory edit.
        // The next real mutation includes these updated links in its snapshot.
        if (reason === 'history metadata changed' || reason === 'store migration' && !persistence.pending.has(snapshot.chatId)) {
            persistence.noteReadOnlySnapshot(snapshot); return;
        }
        return persistence.enqueue(snapshot, reason);
    },
    onChange: (changedStore, reason) => {
        queueMicrotask(() => {
            ui?.queueMessageRender();
            ui?.queueManagerRender();
            if (store.current().chatId !== changedStore.chatId || runtimeController.signal.aborted) return;
            if (settings && shouldRefreshInjection(settings, reason)) updateInjection(reason);
        });
    },
});

const apiClient = new SummaryApiClient({
    getSettings: () => settings,
    storage: window.localStorage,
    storageKey: API_KEY_STORAGE_KEY,
});

const summarizer = new MemorySummarizer({
    store,
    apiClient,
    getSettings: () => settings,
    getChat: () => chat,
    getPersistenceState: () => persistence.getState(),
    flushMemory: chatId => persistence.flush(chatId),
    commitMemory: (mutate, assertActive) => persistence.commitReplacement(store, mutate, assertActive),
    onStatus: (state, message, error) => {
        if (state !== 'settled') ui?.setStatus(state, message, error);
        ui?.queueMessageRender();
        if (state === 'error') console.warn(LOG_PREFIX, message);
    },
});

function updateInjection(reason = 'manual edit', injectionFloor = promptHistoryFloor(chat, chat, store.current().summaries)) {
    if (!settings || !shouldRefreshInjection(settings, reason)) return;
    const current = store.current();
    const sourceStore = store.effectiveStore(chat);
    const result = refreshSnapshot(current, { ...settings, injectionFloor }, reason, sourceStore);
    // Publish this format migration once through the existing confirmed save
    // queue; ordinary reloads still never upload an unchanged window snapshot.
    const migration = reason === 'chat changed' && result.migrated;
    const readOnly = !migration && ['chat changed', 'history metadata changed', 'store migration'].includes(reason);
    if (readOnly) persistence.noteReadOnlySnapshot(current);
    if (result.changed && !readOnly) store.persist('injection snapshot', { notify: false });
    const placement = injectionPublisher.publish(result.value, { forceRelocate: reason === 'manual reinject' });
    publishedMemoryValue = result.value;
    return { ...result, placement };
}

async function refreshChatState({ serverLoaded = false } = {}) {
    if (!settings) return;
    const revision = ++refreshRevision;
    await persistence.ready;
    if (revision !== refreshRevision || !memoryChatId()) return;
    let current, rebound = false;
    try { current = store.current(); }
    catch (error) {
        if (chat_metadata.cache_memory?.chatId && chat_metadata.cache_memory.chatId !== memoryChatId()) {
            summarizer.invalidateContext();
            injectionPublisher.publish(''); publishedMemoryValue = ''; activeChatId = null;
            try { current = await persistence.rebindImportedChatMemory(); rebound = true; }
            catch (verificationError) {
                if (revision === refreshRevision) ui?.setStatus('error', verificationError.message);
                console.warn(LOG_PREFIX, verificationError); return;
            }
        } else { ui?.setStatus('error', error.message); console.warn(LOG_PREFIX, error); return; }
    }
    if (revision !== refreshRevision || memoryChatId() !== current.chatId) return;
    const chatId = current.chatId;
    if (!chatId) return;
    if (chatId !== activeChatId || serverLoaded) summarizer.invalidateContext();
    if (chatId !== activeChatId || serverLoaded) current = persistence.activate(chatId, current) ?? current;
    if (chatId !== activeChatId || serverLoaded) await persistence.loadLatest(chatId);
    if (revision !== refreshRevision || memoryChatId() !== chatId) return;
    if ((rebound || persistence.importedChatBindings.has(chatId)) && !['failed', 'conflict'].includes(persistence.getState(chatId).state)) {
        await persistence.enqueue(store.current(), 'chat file identity changed');
        await persistence.flush(chatId);
        if (revision !== refreshRevision || memoryChatId() !== chatId) return;
        if (persistence.getState(chatId).state === 'confirmed') {
            persistence.importedChatBindings.delete(chatId);
            ui?.setStatus('success', '已核对导入聊天，原有摘要、阶段总结和大总结已恢复。');
        }
    }
    store.persistMigration();
    store.syncMessages(chat);
    observedAssistantEntries = new Map(getAssistantMessages(chat).map(entry => [entry.messageIndex, entry]));
    if (revision !== refreshRevision || memoryChatId() !== chatId) return;
    const switched = chatId !== activeChatId;
    if (switched) {
        summarizer.invalidateContext();
        ui?.backfill?.cancel({ discard: true });
        ui?.cancelMissingCheckpointBackfill({ discard: true });
        activeChatId = chatId;
        updateInjection('chat changed');
    } else if (serverLoaded) updateInjection('chat changed');
    else if (!settings.strictCacheMode) updateInjection('history metadata changed');
    nextFrame(() => { ui?.refreshSummaryMode(); ui?.queueMessageRender(); ui?.queueManagerRender(); });
}

function cacheDebugSnapshot(messages) {
    if (!settings?.cacheDebug) return;
    const current = store.current();
    const snapshot = diagnostics.memory(current, settings, getAssistantMessages(chat).at(-1)?.floor ?? 0);
    snapshot.history = Array.isArray(messages) ? diagnostics.history(current.chatId, messages)
        : { unavailable: true, message: '当前 ST 未提供发送前 messages；仅检查 Cache Memory 稳定性' };
    console.info('[Cache Memory] CACHE DEBUG', snapshot);
    ui?.setCacheDebug(snapshot);
}

// ST supplies a regex-processed temporary coreChat via generate_interceptor.
// Register only while active; never change the stored chat or regex settings.
function historyInterceptor(coreChat, _contextSize, _abort, type) {
    if (!settings?.enabled || (settings.injectionMode !== 'rolling' && !settings.historyHandoff && !settings.lastUserOnly) || memoryChatId() !== activeChatId) return;
    // Publish before filtering as well: the newest summary may still be pending,
    // and a continued/edited reply may have invalidated an earlier projection.
    if (settings.injectionMode === 'rolling' && [undefined, 'normal', 'swipe', 'regenerate', 'continue'].includes(type)) updateInjection('before generation', promptHistoryFloor(coreChat, chat, store.current().summaries));
    const current = store.current();
    if (current.chatId !== activeChatId) return;
    const result = filterCoveredHistory(coreChat, chat, current.injectionSnapshot, publishedMemoryValue, {
        type, summaries: current.summaries, historyHandoff: settings.historyHandoff, lastUserOnly: settings.lastUserOnly,
        injectionMode: settings.injectionMode, recentRawFloors: settings.recentRawFloors,
    });
    if (result.removed) coreChat.splice(0, coreChat.length, ...result.messages);
    if (result.retainedOlderFloors?.length) ui?.setStatus('warning', `最近${settings.recentRawFloors}层模式：第${result.retainedOlderFloors.slice(0, 12).join('、')}层等共${result.retainedOlderFloors.length}层尚无可核实的已注入剧情，暂时保留原文；可补齐缺失摘要。`);
    if (settings.cacheDebug) console.info(LOG_PREFIX, 'HISTORY HANDOFF', { removedMessages: result.removed, reason: result.reason });
}

// Actual assistant text changes affect only the selected floor's Summary.
function reconcileMessageSummary(messageIndex) {
    const index = Number(messageIndex);
    if (!Number.isInteger(index) || index < 0) return;
    const previous = observedAssistantEntries.get(index);
    const entry = getAssistantMessages(chat).find(row => row.messageIndex === index);
    if (!entry) {
        if (previous && !String(chat[index]?.mes ?? '').trim()) store.discardDeletedSummary(previous);
        observedAssistantEntries.delete(index);
        ui?.queueMessageRender(); ui?.queueManagerRender();
        return;
    }
    const changed = Boolean(previous && previous.contentFingerprint !== entry.contentFingerprint);
    store.discardChangedSummary(entry, { previouslyDifferent: changed });
    observedAssistantEntries.set(index, entry);
    ui?.queueMessageRender(); ui?.queueManagerRender();
    if (!settings?.enabled || !settings.autoSummarize || !settings.independentApi) return;
    if (isUsableMemory(store.getSummaryForEntry(entry))) return;
    summarizer.summarizeMessage(entry.messageId, { expectedFingerprint: entry.fingerprint })
        .catch(error => console.warn(LOG_PREFIX, error.message));
}

function bindEvents() {
    if (event_types.CHAT_COMPLETION_SETTINGS_READY) {
        bindEvent(event_types.CHAT_COMPLETION_SETTINGS_READY, data => cacheDebugSnapshot(data?.messages));
    } else {
        bindEvent(event_types.GENERATION_STARTED, () => cacheDebugSnapshot());
    }
    bindEvent(event_types.GENERATION_ENDED, () => {
        const indices = new Set(pendingMessageChanges);
        pendingMessageChanges.clear();
        if (pendingSwipeIndex !== null) indices.add(pendingSwipeIndex);
        pendingSwipeIndex = null;
        schedule(() => {
            const latest = getAssistantMessages(chat).at(-1);
            if (latest) indices.add(latest.messageIndex);
            for (const index of indices) reconcileMessageSummary(index);
        }, 100);
    });
    bindEvent(event_types.CHAT_CHANGED, () => schedule(() => refreshChatState({ serverLoaded: true })));
    bindEvent(event_types.CHAT_LOADED, () => schedule(() => refreshChatState({ serverLoaded: true })));
    bindEvent(event_types.CHARACTER_MESSAGE_RENDERED, () => nextFrame(() => { store.syncMessages(chat); ui?.queueMessageRender(); }));
    bindEvent(event_types.MORE_MESSAGES_LOADED, () => nextFrame(() => { store.syncMessages(chat); ui?.queueMessageRender(); }));
    bindEvent(event_types.MESSAGE_SWIPED, messageIndex => {
        const index = Number(messageIndex);
        if (!Number.isInteger(index)) return;
        pendingSwipeIndex = index;
        schedule(() => {
            if (pendingSwipeIndex !== index || isGenerating()) return;
            pendingSwipeIndex = null;
            reconcileMessageSummary(index);
        }, 50);
    });
    bindEvent(event_types.MESSAGE_DELETED, () => {
        const current = getAssistantMessages(chat);
        const ids = new Set(current.map(row => row.messageId));
        for (const prior of observedAssistantEntries.values())
            if (!ids.has(prior.messageId)) store.discardDeletedSummary(prior);
        observedAssistantEntries = new Map(current.map(entry => [entry.messageIndex, entry]));
        store.reconcileDeletion(chat);
        schedule(refreshChatState);
    });
    for (const name of [event_types.MESSAGE_EDITED, event_types.MESSAGE_UPDATED]) {
        bindEvent(name, messageIndex => {
            const chatId = memoryChatId(), index = Number(messageIndex);
            schedule(() => {
                if (memoryChatId() !== chatId || !Number.isInteger(index)) return;
                if (isGenerating()) { pendingMessageChanges.add(index); return; }
                reconcileMessageSummary(index);
            });
        });
    }
}

function initialize() {
    if (initialized) return;
    if (runtimeController.signal.aborted) runtimeController = new AbortController();
    initialized = true;
    if (persistence.journalLockReleased) persistence.ready = persistence.claimJournal(window.navigator.locks);
    loadSettings();
    globalThis.cacheMemoryHistoryInterceptor = historyInterceptor;
    ui = new CacheMemoryUI({
        getSettings: () => settings,
        updateSettings,
        persistSettings,
        apiClient,
        store,
        summarizer,
        getChat: () => chat,
        captureChat: () => {
            if (isGenerating() || memoryChatId() !== activeChatId) throw new Error('请等待当前聊天加载及回复生成完成');
            return captureChatFile(getContext(), store.current());
        },
        exportChat: rows => chatFileDownload(rows, getCurrentChatId()),
        createChatBranch: async (rows, options) => {
            const context = getContext(), identity = memoryChatId();
            if (isGenerating() || identity !== activeChatId || rows[0].chat_metadata.cache_memory.chatId !== identity
                || memoryContentDigest(rows[0].chat_metadata.cache_memory) !== memoryContentDigest(store.current())
                || JSON.stringify(rows.slice(1)) !== JSON.stringify(chat)) throw new Error('选择期间聊天或记忆已变化，请重新打开平行线设置');
            const branch = prepareChatBranch(rows, options, settings);
            let saveGroupBranch;
            if (context.groupId !== null && context.groupId !== undefined && context.groupId !== '') {
                ({ saveGroupBookmarkChat: saveGroupBranch } = await import('../../../group-chats.js'));
            }
            return saveChatBranch({ branch, context, getContext, fetchImpl: window.fetch.bind(window), saveGroupBranch,
                openAfterCreate: options.openAfterCreate, canSwitch: () => !isGenerating() });
        },
        updateInjection,
        persistence,
        apiCacheAdapter,
    });
    if (!ui.mountSettings()) {
        mountObserver = new ui.root.MutationObserver(() => {
            if (ui.mountSettings()) {
                mountObserver?.disconnect();
                mountObserver = null;
            }
        });
        mountObserver.observe(ui.doc.body, { childList: true, subtree: true });
    }
    ui.bindChatActions();
    apiCacheAdapter.install(window);
    apiCacheAdapter.probe();
    bindEvents();
    let reconnecting = false;
    onlineHandler = async () => {
        if (reconnecting) return;
        reconnecting = true;
        try {
            await memoryServer.probe();
            if (activeChatId && memoryChatId() === activeChatId) await persistence.verify(activeChatId);
        } catch (error) { console.warn(LOG_PREFIX, error); }
        finally { reconnecting = false; }
    };
    window.addEventListener('online', onlineHandler, { signal: runtimeController.signal });
    let checkingMemory = false;
    const checkMemory = async () => {
        if (checkingMemory || document.visibilityState === 'hidden' || !memoryChatId() || memoryChatId() !== activeChatId) return;
        checkingMemory = true;
        try { await persistence.verify(); }
        finally { checkingMemory = false; }
    };
    window.addEventListener('focus', checkMemory, { signal: runtimeController.signal });
    document.addEventListener('visibilitychange', checkMemory, { signal: runtimeController.signal });
    document.addEventListener('visibilitychange', () => {
        if (document.visibilityState !== 'visible') persistence.persistPending();
    }, { signal: runtimeController.signal });
    window.addEventListener('pagehide', () => persistence.persistPending(), { signal: runtimeController.signal });
    memoryServer.probe().then(() => refreshChatState({ serverLoaded: true })).catch(error => console.warn(LOG_PREFIX, error));
    console.info(LOG_PREFIX, 'Initialized with append-only memory storage.');
}

export function onActivate() {
    if (runtimeController.signal.aborted) runtimeController = new AbortController();
    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', initialize, { once: true, signal: runtimeController.signal });
        return;
    }
    initialize();
}

export function onHotUnload() {
    runtimeController.abort();
    if (globalThis.cacheMemoryHistoryInterceptor === historyInterceptor) delete globalThis.cacheMemoryHistoryInterceptor;
    persistence.persistPending();
    persistence.releaseJournal?.();
    if (onlineHandler) window.removeEventListener('online', onlineHandler);
    onlineHandler = null;
    apiCacheAdapter.uninstall();
    mountObserver?.disconnect();
    mountObserver = null;
    for (const [name, handler] of eventBindings.splice(0)) {
        if (typeof eventSource.off === 'function') eventSource.off(name, handler);
        else if (typeof eventSource.removeListener === 'function') eventSource.removeListener(name, handler);
    }
    for (const id of timers) window.clearTimeout(id);
    for (const id of frames) cancelAnimationFrame(id);
    timers.clear();
    frames.clear();
    apiClient.abortAll();
    summarizer.invalidateContext();
    ui?.destroy();
    diagnostics.reset();
    activeChatId = null;
    publishedMemoryValue = null;
    ui = undefined;
    pendingSwipeIndex = null;
    pendingMessageChanges.clear();
    observedAssistantEntries.clear();
    injectionPublisher.dispose();
    initialized = false;
}

export function onDisable() {
    onHotUnload();
}

export function onUpdate() {}

onActivate();
