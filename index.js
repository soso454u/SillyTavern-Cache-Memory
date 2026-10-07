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
import { SummaryApiClient } from './src/api-client.js';
import { API_KEY_STORAGE_KEY, DEFAULT_SETTINGS, INJECTION_KEY, MODULE_ID, normalizeSettings } from './src/defaults.js';
import { buildInjection } from './src/injection.js';
import { MemoryStore } from './src/memory-store.js';
import { MemorySummarizer } from './src/summarizer.js';
import { CacheMemoryUI } from './src/ui.js';

const LOG_PREFIX = '[Cache Memory]';
let settings;
let initialized = false;
let ui;
let pendingSwipeIndex = null;

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
    requestAnimationFrame(() => ui?.renderMessageMemories());
}

function bindEvents() {
    eventSource.on(event_types.GENERATION_ENDED, () => {
        if (pendingSwipeIndex !== null) {
            store.rebindSummaryAtMessageIndex(pendingSwipeIndex, chat);
            pendingSwipeIndex = null;
        }
        if (!settings.enabled || !settings.autoSummarize || !settings.independentApi) return;
        window.setTimeout(() => summarizer.enqueueLatest(), 100);
    });
    eventSource.on(event_types.CHAT_CHANGED, () => window.setTimeout(refreshChatState, 0));
    eventSource.on(event_types.CHAT_LOADED, () => window.setTimeout(refreshChatState, 0));
    eventSource.on(event_types.CHARACTER_MESSAGE_RENDERED, () => requestAnimationFrame(() => ui?.renderMessageMemories()));
    eventSource.on(event_types.MORE_MESSAGES_LOADED, () => requestAnimationFrame(() => ui?.renderMessageMemories()));
    eventSource.on(event_types.MESSAGE_SWIPED, messageIndex => {
        pendingSwipeIndex = Number(messageIndex);
        window.setTimeout(() => {
            if (pendingSwipeIndex !== Number(messageIndex) || isGenerating()) return;
            store.rebindSummaryAtMessageIndex(messageIndex, chat);
            pendingSwipeIndex = null;
            refreshChatState();
        }, 50);
    });
    for (const name of [event_types.MESSAGE_EDITED, event_types.MESSAGE_UPDATED, event_types.MESSAGE_DELETED]) {
        if (name) eventSource.on(name, () => window.setTimeout(refreshChatState, 0));
    }
}

function initialize() {
    if (initialized) return;
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
        const observer = new MutationObserver(() => {
            if (ui.mountSettings()) observer.disconnect();
        });
        observer.observe(document.body, { childList: true, subtree: true });
    }
    ui.bindChatActions();
    bindEvents();
    refreshChatState();
    console.info(LOG_PREFIX, 'Initialized with append-only memory storage.');
}

if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', initialize, { once: true });
} else {
    initialize();
}
