export const CHAT_HISTORY_MARKER_IDENTIFIER = 'chatHistory';
export const CACHE_MEMORY_MARKER_IDENTIFIER = 'cache_memory_chat_history';

const RELATIVE_INJECTION_POSITION = 0;

function removeOwnEntries(collection) {
    if (!Array.isArray(collection?.collection)) return null;
    collection.collection = collection.collection.filter(prompt => prompt?.identifier !== CACHE_MEMORY_MARKER_IDENTIFIER);
    return collection.collection;
}

/**
 * Publishes CACHE_MEMORY immediately before SillyTavern's built-in chatHistory
 * marker without relying on its display name or Prompt Manager DOM. If the
 * runtime Prompt Manager is unavailable, the caller-provided legacy publisher
 * remains the fallback.
 */
export class CacheMemoryInjectionPublisher {
    constructor({ getPromptManager, publishFallback }) {
        this.getPromptManager = getPromptManager;
        this.publishFallback = publishFallback;
        this.value = '';
        this.manager = null;
        this.originalGetPromptCollection = null;
        this.wrapper = null;
        this.fallbackValue = null;
    }

    publish(value, { forceRelocate = false } = {}) {
        this.value = String(value ?? '');
        if (this.ensureHook(forceRelocate)) {
            this.writeFallback('', forceRelocate);
            return { target: CHAT_HISTORY_MARKER_IDENTIFIER, fallback: false };
        }
        this.writeFallback(this.value, forceRelocate);
        return { target: 'legacy-relative-prompt', fallback: true };
    }

    ensureHook(forceRelocate = false) {
        const manager = this.getPromptManager?.();
        const usable = manager && typeof manager.getPromptCollection === 'function' && typeof manager.preparePrompt === 'function';
        if (!usable) {
            this.detachHook();
            return false;
        }
        if (!forceRelocate && this.manager === manager && manager.getPromptCollection === this.wrapper) return true;

        this.detachHook();
        const owner = this;
        const original = manager.getPromptCollection;
        const wrapper = function (...args) {
            const collection = original.apply(this, args);
            owner.placeInCollection(manager, collection);
            return collection;
        };
        this.manager = manager;
        this.originalGetPromptCollection = original;
        this.wrapper = wrapper;
        manager.getPromptCollection = wrapper;
        return true;
    }

    placeInCollection(manager, collection) {
        const prompts = removeOwnEntries(collection);
        if (!prompts || !this.value) return;

        const markerDefinition = manager.getPromptById?.(CHAT_HISTORY_MARKER_IDENTIFIER);
        const markerIndex = prompts.findIndex(prompt => prompt?.identifier === CHAT_HISTORY_MARKER_IDENTIFIER);
        const hasOfficialMarker = markerDefinition?.identifier === CHAT_HISTORY_MARKER_IDENTIFIER
            && markerDefinition.marker === true && markerIndex >= 0;
        const prompt = manager.preparePrompt(hasOfficialMarker ? {
            identifier: CACHE_MEMORY_MARKER_IDENTIFIER,
            name: 'Cache Memory',
            role: 'system',
            content: this.value,
            system_prompt: false,
            injection_position: RELATIVE_INJECTION_POSITION,
            extension: false,
        } : {
            identifier: CACHE_MEMORY_MARKER_IDENTIFIER,
            name: 'Cache Memory',
            role: 'system',
            content: this.value,
            system_prompt: true,
            injection_position: RELATIVE_INJECTION_POSITION,
            position: 'end',
            extension: true,
        });
        prompts.splice(hasOfficialMarker ? markerIndex : prompts.length, 0, prompt);
    }

    writeFallback(value, force = false) {
        if (!force && this.fallbackValue === value) return;
        this.fallbackValue = value;
        this.publishFallback?.(value);
    }

    detachHook() {
        if (this.manager && this.wrapper && this.manager.getPromptCollection === this.wrapper) {
            this.manager.getPromptCollection = this.originalGetPromptCollection;
        }
        this.manager = null;
        this.originalGetPromptCollection = null;
        this.wrapper = null;
    }

    dispose() {
        this.value = '';
        this.detachHook();
        this.writeFallback('', true);
    }
}
