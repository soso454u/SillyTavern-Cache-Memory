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
import { extension_settings, saveMetadataDebounced } from '../../../extensions.js';
import { SummaryApiClient } from './src/api-client.js?v=1.3.1';
import { API_KEY_STORAGE_KEY, DEFAULT_SETTINGS, INJECTION_KEY, MODULE_ID, normalizeSettings } from './src/defaults.js?v=1.3.1';
import { buildInjection } from './src/injection.js?v=1.3.1';
import { MemoryStore } from './src/memory-store.js?v=1.3.1';
import { MemorySummarizer } from './src/summarizer.js?v=1.3.1';
import { CacheMemoryUI } from './src/ui.js?v=1.3.1';

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
    settings = normalizeSettings(extension_settings[MODULE_ID] ?? DEFAULT_SETTINGS);
    extension_settings[MODULE_ID] = settings;
    saveSettingsDebounced();
}

function updateSettings(patch) {
    settings = normalizeSettings({ ...settings, ...patch });
    extension_settings[MODULE_ID] = settings;
    saveSettingsDebounced();
    return settings;
}

const store = new MemoryStore({
    getMetadata: () => chat_metadata,
    getChatId: () => getCurrentChatId() ?? '',
    saveMetadata: () => saveMetadataDebounced(),
    onChange: () => {
        queueMicrotask(() => {
            ui?.renderMessageMemories();
            ui?.renderManager();
            updateInjection();
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
    onStatus: (state, message) => {
        ui?.setStatus(state, message);
        if (state === 'error') console.warn(LOG_PREFIX, message);
    },
});

function updateInjection() {
    const value = settings?.enabled ? buildInjection(store.current(), settings) : '';
    setExtensionPrompt(
        INJECTION_KEY,
        value,
        extension_prompt_types.IN_PROMPT,
        0,
        false,
        extension_prompt_roles.SYSTEM,
    );
}

function refreshChatState() {
    if (!settings) return;
    store.syncMessages(chat);
    updateInjection();
    nextFrame(() => ui?.renderMessageMemories());
}

function bindEvents() {
    bindEvent(event_types.GENERATION_ENDED, () => {
        if (pendingSwipeIndex !== null) {
            store.rebindSummaryAtMessageIndex(pendingSwipeIndex, chat);
            pendingSwipeIndex = null;
        }
        if (!settings.enabled || !settings.autoSummarize || !settings.independentApi) return;
        schedule(() => summarizer.enqueueLatest(), 100);
    });
    bindEvent(event_types.CHAT_CHANGED, () => schedule(refreshChatState));
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
    for (const name of [event_types.MESSAGE_EDITED, event_types.MESSAGE_UPDATED, event_types.MESSAGE_DELETED]) {
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
        apiClient,
        store,
        summarizer,
        getChat: () => chat,
        updateInjection,
    });
    if (!ui.mountSettings()) {
        mountObserver = new MutationObserver(() => {
            if (ui.mountSettings()) {
                mountObserver?.disconnect();
                mountObserver = null;
            }
        });
        mountObserver.observe(document.body, { childList: true, subtree: true });
    }
    ui.bindChatActions();
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
    ui?.destroy();
    ui = undefined;
    pendingSwipeIndex = null;
    setExtensionPrompt(INJECTION_KEY, '', extension_prompt_types.IN_PROMPT, 0, false, extension_prompt_roles.SYSTEM);
    initialized = false;
}

export function onDisable() {
    onHotUnload();
}

export function onUpdate() {}

onActivate();
