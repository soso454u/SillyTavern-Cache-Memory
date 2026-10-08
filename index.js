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
import { SummaryApiClient } from './src/api-client.js?v=1.18.0';
import { ApiCacheAdapterBridge } from './src/api-cache-adapter.js?v=1.18.0';
import { API_KEY_STORAGE_KEY, INJECTION_KEY, MODULE_ID, normalizeLoadedSettings, normalizeSettings } from './src/defaults.js?v=1.18.0';
import { CacheDiagnostics, refreshSnapshot, shouldRefreshInjection } from './src/cache-control.js?v=1.18.0';
import { CacheMemoryInjectionPublisher } from './src/injection-target.js?v=1.18.0';
import { getAssistantMessages } from './src/utils.js?v=1.18.0';
import { MemoryStore } from './src/memory-store.js?v=1.18.0';
import { MemorySummarizer } from './src/summarizer.js?v=1.18.0';
import { CacheMemoryUI } from './src/ui.js?v=1.18.0';
import { MemoryPersistenceCoordinator, readSillyTavernRemoteStore } from './src/persistence.js?v=1.18.0';

const LOG_PREFIX = '[Cache Memory]';
let settings;
let initialized = false;
let ui;
let pendingSwipeIndex = null;
let mountObserver = null;
let runtimeController = new AbortController();
const eventBindings = [];
const timers = new Set();
const frames = new Set();
const diagnostics = new CacheDiagnostics();
let activeChatId = null;

const apiCacheAdapter = new ApiCacheAdapterBridge({
    getSettings: () => settings,
    updateSettings,
    fetchImpl: (...args) => window.fetch(...args),
    onStatus: status => ui?.setApiCacheAdapterStatus(status),
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
    getChatId: () => getCurrentChatId() ?? '',
    getMetadata: () => chat_metadata,
    storage: window.localStorage,
    readRemoteStore: chatId => readSillyTavernRemoteStore(getContext, chatId, window.fetch.bind(window)),
    saveMetadata: async chatId => {
        const context = getContext();
        if (String(context.chatId ?? '') !== String(chatId ?? '')) throw new Error('聊天已切换，取消旧聊天保存');
        await context.saveMetadata();
    },
    onStatus: (chatId) => {
        if (String(getCurrentChatId() ?? '') !== chatId) return;
        queueMicrotask(() => ui?.renderManager());
    },
});

const store = new MemoryStore({
    getMetadata: () => chat_metadata,
    getChatId: () => getCurrentChatId() ?? '',
    saveMetadata: (snapshot, reason) => persistence.enqueue(snapshot, reason),
    onChange: (changedStore, reason) => {
        queueMicrotask(() => {
            ui?.renderMessageMemories();
            ui?.renderManager();
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
    onStatus: (state, message, error) => {
        if (state !== 'settled') ui?.setStatus(state, message, error);
        ui?.renderMessageMemories();
        if (state === 'error') console.warn(LOG_PREFIX, message);
    },
});

function updateInjection(reason = 'manual edit') {
    if (!settings || !shouldRefreshInjection(settings, reason)) return;
    const current = store.current();
    const result = refreshSnapshot(current, settings, reason);
    if (!result.skipped) store.persist('injection snapshot', { notify: false });
    const placement = injectionPublisher.publish(result.value, { forceRelocate: reason === 'manual reinject' });
    return { ...result, placement };
}

function refreshChatState({ serverLoaded = false } = {}) {
    if (!settings) return;
    let current = store.current();
    const chatId = current.chatId;
    if (chatId !== activeChatId || serverLoaded) current = persistence.activate(chatId, current) ?? current;
    store.persistMigration();
    store.syncMessages(chat);
    if (chatId !== activeChatId) {
        summarizer.invalidateContext();
        ui?.backfill?.cancel({ discard: true });
        ui?.cancelMissingCheckpointBackfill({ discard: true });
        activeChatId = chatId;
        updateInjection('chat changed');
        persistence.verify(chatId);
    } else if (!settings.strictCacheMode) updateInjection('history metadata changed');
    nextFrame(() => ui?.renderMessageMemories());
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

function bindEvents() {
    // ST emits this immediately before sending its final Chat Completion payload. Read only.
    if (event_types.CHAT_COMPLETION_SETTINGS_READY) {
        bindEvent(event_types.CHAT_COMPLETION_SETTINGS_READY, data => cacheDebugSnapshot(data?.messages));
    } else {
        bindEvent(event_types.GENERATION_STARTED, () => cacheDebugSnapshot());
    }
    bindEvent(event_types.GENERATION_ENDED, () => {
        if (pendingSwipeIndex !== null) {
            store.rebindSummaryAtMessageIndex(pendingSwipeIndex, chat);
            pendingSwipeIndex = null;
        }
        if (!settings.enabled || !settings.autoSummarize || !settings.independentApi) return;
        schedule(() => summarizer.enqueueLatest(), 100);
    });
    bindEvent(event_types.CHAT_CHANGED, () => schedule(() => refreshChatState({ serverLoaded: true })));
    bindEvent(event_types.CHAT_LOADED, () => schedule(refreshChatState));
    bindEvent(event_types.CHARACTER_MESSAGE_RENDERED, () => nextFrame(() => ui?.renderMessageMemories()));
    bindEvent(event_types.MORE_MESSAGES_LOADED, () => nextFrame(() => ui?.renderMessageMemories()));
    bindEvent(event_types.MESSAGE_SWIPED, messageIndex => {
        pendingSwipeIndex = Number(messageIndex);
        schedule(() => {
            if (pendingSwipeIndex !== Number(messageIndex) || isGenerating()) return;
            store.rebindSummaryAtMessageIndex(messageIndex, chat);
            pendingSwipeIndex = null;
            refreshChatState();
        }, 50);
    });
    bindEvent(event_types.MESSAGE_DELETED, messageIndex => {
        store.markSummaryOrphanedAtMessageIndex(Number(messageIndex));
        schedule(refreshChatState);
    });
    for (const name of [event_types.MESSAGE_EDITED, event_types.MESSAGE_UPDATED]) {
        bindEvent(name, () => schedule(refreshChatState));
    }
}

function initialize() {
    if (initialized) return;
    if (runtimeController.signal.aborted) runtimeController = new AbortController();
    initialized = true;
    loadSettings();
    ui = new CacheMemoryUI({
        getSettings: () => settings,
        updateSettings,
        persistSettings,
        apiClient,
        store,
        summarizer,
        getChat: () => chat,
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
    refreshChatState();
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
    ui = undefined;
    pendingSwipeIndex = null;
    injectionPublisher.dispose();
    initialized = false;
}

export function onDisable() {
    onHotUnload();
}

export function onUpdate() {}

onActivate();
