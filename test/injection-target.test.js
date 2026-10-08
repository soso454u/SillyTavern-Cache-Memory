import test from 'node:test';
import assert from 'node:assert/strict';
import {
    CACHE_MEMORY_MARKER_IDENTIFIER,
    CHAT_HISTORY_MARKER_IDENTIFIER,
    CacheMemoryInjectionPublisher,
} from '../src/injection-target.js';

function fixture({ marker = true, managerAvailable = true } = {}) {
    const fallback = [];
    const original = function () {
        return {
            collection: [
                { identifier: 'main' },
                ...(marker ? [{ identifier: CHAT_HISTORY_MARKER_IDENTIFIER }] : []),
                { identifier: CACHE_MEMORY_MARKER_IDENTIFIER, content: 'stale duplicate' },
            ],
        };
    };
    const manager = managerAvailable ? {
        getPromptCollection: original,
        getPromptById: identifier => identifier === CHAT_HISTORY_MARKER_IDENTIFIER && marker
            ? { identifier, marker: true }
            : null,
        preparePrompt: prompt => ({ ...prompt }),
    } : null;
    const publisher = new CacheMemoryInjectionPublisher({
        getPromptManager: () => manager,
        publishFallback: value => fallback.push(value),
    });
    return { publisher, manager, original, fallback };
}

test('CACHE_MEMORY uses the official chatHistory marker identifier and stays unique before it', () => {
    const { publisher, manager, fallback } = fixture();
    const placement = publisher.publish('<CACHE_MEMORY>one</CACHE_MEMORY>');
    const prompts = manager.getPromptCollection().collection;
    assert.deepEqual(placement, { target: 'chatHistory', fallback: false });
    assert.equal(fallback.at(-1), '');
    assert.equal(prompts.filter(prompt => prompt.identifier === CACHE_MEMORY_MARKER_IDENTIFIER).length, 1);
    assert.equal(prompts.findIndex(prompt => prompt.identifier === CACHE_MEMORY_MARKER_IDENTIFIER) + 1,
        prompts.findIndex(prompt => prompt.identifier === CHAT_HISTORY_MARKER_IDENTIFIER));
    assert.equal(prompts.find(prompt => prompt.identifier === CACHE_MEMORY_MARKER_IDENTIFIER).content, '<CACHE_MEMORY>one</CACHE_MEMORY>');
});

test('missing marker keeps the old relative-main behavior, and missing Prompt Manager uses legacy fallback', () => {
    const withoutMarker = fixture({ marker: false });
    withoutMarker.publisher.publish('<CACHE_MEMORY>two</CACHE_MEMORY>');
    const relative = withoutMarker.manager.getPromptCollection().collection.at(-1);
    assert.equal(relative.identifier, CACHE_MEMORY_MARKER_IDENTIFIER);
    assert.equal(relative.extension, true);
    assert.equal(relative.position, 'end');

    const withoutManager = fixture({ managerAvailable: false });
    const placement = withoutManager.publisher.publish('<CACHE_MEMORY>three</CACHE_MEMORY>');
    assert.deepEqual(placement, { target: 'legacy-relative-prompt', fallback: true });
    assert.equal(withoutManager.fallback.at(-1), '<CACHE_MEMORY>three</CACHE_MEMORY>');
});

test('forced relocation replaces the wrapper and disposal restores the official method', () => {
    const { publisher, manager, original, fallback } = fixture();
    publisher.publish('<CACHE_MEMORY>one</CACHE_MEMORY>');
    const firstWrapper = manager.getPromptCollection;
    publisher.publish('<CACHE_MEMORY>one</CACHE_MEMORY>', { forceRelocate: true });
    assert.notEqual(manager.getPromptCollection, firstWrapper);
    assert.equal(manager.getPromptCollection().collection.filter(prompt => prompt.identifier === CACHE_MEMORY_MARKER_IDENTIFIER).length, 1);
    publisher.dispose();
    assert.equal(manager.getPromptCollection, original);
    assert.equal(fallback.at(-1), '');
});
