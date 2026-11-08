// Shared by the browser extension and the standalone server adapter. These
// fingerprints are diagnostic. Authority checks compare saved text directly.
const OPEN = '<CACHE_MEMORY>';
const CLOSE = '</CACHE_MEMORY>';
const CACHE_KEY = /^(?:cache[-_]control|cache[-_]ttl|prompt[-_]cach(?:e(?:[-_](?:key|retention|ttl))?|ing)|extended[-_]cache[-_]ttl|cache[-_]breakpoints)$/i;

function stableJson(value, omitCache = false) {
    return JSON.stringify(value, (_key, item) => {
        if (!item || typeof item !== 'object' || Array.isArray(item)) return item;
        return Object.fromEntries(Object.keys(item).sort()
            .filter(key => !omitCache || !CACHE_KEY.test(key)).map(key => [key, item[key]]));
    });
}

export function fingerprint(value) {
    // Two 32-bit words keep the diagnostic cheap on long prompts. Each word
    // uses a different multiplier and byte order.
    let low = 0x84222325, high = 0xcbf29ce4;
    for (let index = 0; index < value.length; index++) {
        const code = value.charCodeAt(index);
        low = Math.imul(low ^ code, 0x01000193);
        high = Math.imul(high ^ ((code >>> 8) | (code << 16)), 0x01000157);
    }
    return (high >>> 0).toString(16).padStart(8, '0') + (low >>> 0).toString(16).padStart(8, '0');
}

export function cacheFields(body) {
    const entries = [];
    const visit = (value, path, headers = false) => {
        if (!value || typeof value !== 'object') return;
        for (const [key, child] of Object.entries(value)) {
            const location = Array.isArray(value) ? `${path}[${key}]` : `${path}.${/^(?:content|cache_control)$/i.test(key) || CACHE_KEY.test(key) ? key : '*'}`;
            const beta = headers && /^anthropic-beta$/i.test(key) && /prompt-caching|extended-cache-ttl/i.test(String(child));
            if (beta || CACHE_KEY.test(key) && !(headers && /^cache-control$/i.test(key))) {
                entries.push([beta ? `${path}.anthropic-beta` : location, stableJson(child)]);
            } else if (!headers) visit(child, location);
        }
    };
    visit(body.messages, 'messages');
    for (const [key, value] of Object.entries(body)) {
        if (CACHE_KEY.test(key)) entries.push([key, stableJson(value)]);
    }
    for (const field of ['custom_include_body', 'custom_include_headers', 'custom_exclude_body']) {
        const value = body[field];
        const headers = field === 'custom_include_headers';
        if (value && typeof value === 'object') visit(value, field, headers);
        else if (typeof value === 'string') {
            let parsed;
            try { parsed = JSON.parse(value); } catch { /* ST also accepts YAML. */ }
            if (parsed && typeof parsed === 'object' && field !== 'custom_exclude_body') visit(parsed, field, headers);
            else if (field === 'custom_exclude_body') {
                for (const key of value.match(/[\w-]+/g) ?? []) if (CACHE_KEY.test(key)) entries.push([`${field}.${key}`, 'excluded']);
            } else {
                for (const [, key, fieldValue] of value.matchAll(/^[ \t]*["']?([a-z][\w-]*)["']?[ \t]*:[ \t]*([^\n]*)/gim)) {
                    visit({ [key]: fieldValue }, field, headers);
                }
            }
        }
    }
    entries.sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0);
    return { hash: fingerprint(stableJson(entries)), count: entries.length,
        locations: entries.slice(0, 6).map(([path]) => path.slice(0, 100)),
        controlLocation: entries.find(([path]) => /(?:^|\.)cache[-_]control$/i.test(path))?.[0].slice(0, 100) };
}

function messageParts(message) {
    if (typeof message?.content === 'string') return [{ type: 'text', text: message.content }];
    return Array.isArray(message?.content) ? message.content : [];
}

function messageHash(message) {
    const content = typeof message?.content === 'string' ? messageParts(message) : message?.content;
    return fingerprint(stableJson({ ...message, content }, true));
}

function locateMemory(messages, expected) {
    const candidates = [];
    for (const [messageIndex, message] of messages.entries()) {
        if (message?.role !== 'system') continue;
        const parts = messageParts(message);
        for (let index = 0; index < parts.length;) {
            const run = [];
            let text = '';
            while (parts[index]?.type === 'text' && typeof parts[index].text === 'string') {
                run.push({ index, start: text.length });
                text += parts[index++].text;
            }
            if (!run.length) { index++; continue; }
            const tag = expected && !expected.startsWith(OPEN) ? expected : OPEN;
            for (let start = text.indexOf(tag); start >= 0;) {
                const close = text.indexOf(CLOSE, start + tag.length);
                const next = text.indexOf(OPEN, start + tag.length);
                const end = expected && text.startsWith(expected, start) ? start + expected.length
                    : close >= 0 && (next < 0 || close < next) ? close + CLOSE.length : next >= 0 ? next : text.length;
                const first = run.findLast(part => part.start <= start);
                const last = run.findLast(part => part.start < end);
                candidates.push({ messageIndex, first, last, start, end, value: text.slice(start, end) });
                if (candidates.length > 1) return candidates;
                start = text.indexOf(tag, end);
            }
        }
    }
    return candidates;
}

function sliceMessage(message, part, offset, before) {
    const parts = messageParts(message);
    const text = before ? parts[part].text.slice(0, offset) : parts[part].text.slice(offset);
    const partial = text ? [{ ...parts[part], text }] : [];
    const content = before ? [...parts.slice(0, part), ...partial] : [...partial, ...parts.slice(part + 1)];
    return content.length ? [{ ...message, content }] : [];
}

export function inspectRequest(body, expected = null) {
    const cache = cacheFields(body);
    const parameters = ['model', 'chat_completion_source', 'stream', 'custom_prompt_post_processing',
        'custom_include_body', 'max_tokens', 'max_completion_tokens', 'temperature', 'top_p'];
    const parametersHash = fingerprint(stableJson(parameters.map(key => body[key])));
    if (!Array.isArray(body.messages)) return { messagesHash: null, memory: { state: 'unavailable' }, prefixHash: null, historyHash: null, cache, parametersHash };
    const messages = body.messages;
    const hashes = messages.map(messageHash);
    const candidates = locateMemory(messages, expected);
    const memory = { anchor: ['missing', 'located', 'ambiguous'][candidates.length],
        state: expected === '' ? 'not-published' : expected === null ? 'unverified'
        : candidates.length > 1 ? 'ambiguous' : candidates.length === 0 ? 'missing'
            : candidates[0].value === expected ? 'match' : 'changed' };
    const result = { messagesHash: fingerprint(stableJson(hashes)), memory, prefixHash: null, historyHash: null, cache, hashes, parametersHash };
    if (candidates.length !== 1) return result;

    const { messageIndex, first, last, start, end, value } = candidates[0];
    const location = { messageIndex, blockIndex: first.index, offset: start - first.start };
    Object.assign(memory, { location, hash: fingerprint(value), characters: value.length });
    if (memory.state === 'changed') {
        let offset = 0;
        while (offset < expected.length && offset < value.length && expected[offset] === value[offset]) offset++;
        memory.firstDifference = offset;
    }
    const prefix = [...hashes.slice(0, messageIndex),
        ...sliceMessage(messages[messageIndex], first.index, start - first.start, true).map(messageHash)];
    const memorySuffix = sliceMessage(messages[messageIndex], last.index, end - last.start, false).map(messageHash);
    const history = hashes.slice(messageIndex + 1);
    return { ...result, prefixHash: fingerprint(stableJson(prefix)), prefix, memorySuffixHash: fingerprint(stableJson(memorySuffix)),
        historyHash: fingerprint(stableJson(history)), history };
}

export function requestReport({ hashes, prefix, history, ...report }) {
    return { ...report, ...(prefix ? { prefix: prefix.slice(0, 24), prefixCount: prefix.length } : {}) };
}

function firstDifference(before, after, beforeCount = before?.length, afterCount = after?.length) {
    if (!before || !after) return null;
    const length = Math.min(before.length, after.length);
    for (let index = 0; index < length; index++) if (before[index] !== after[index]) return index;
    return beforeCount !== afterCount && Math.min(beforeCount, afterCount) === length ? length : null;
}

export function compareRequests(before, after) {
    if (!before?.messagesHash || !after?.messagesHash) return [{ kind: 'comparison-unavailable' }];
    const changes = [];
    if (before.memory.hash && after.memory.hash && before.memory.hash !== after.memory.hash) {
        changes.push({ kind: 'memory-text-changed', location: after.memory.location });
    }
    if (before.memorySuffixHash && after.memorySuffixHash && before.memorySuffixHash !== after.memorySuffixHash) {
        changes.push({ kind: 'memory-message-suffix-changed', location: after.memory.location });
    }
    if (before.prefixHash && after.prefixHash && before.prefixHash !== after.prefixHash) {
        changes.push({ kind: 'prefix-changed', messageIndex: firstDifference(before.prefix, after.prefix, before.prefixCount, after.prefixCount) });
    }
    if (before.memory.hash && after.memory.anchor === 'missing') changes.push({ kind: 'memory-no-longer-found', location: before.memory.location });
    if (before.cache.hash !== after.cache.hash) changes.push({ kind: 'cache-parameters-changed', locations: [...new Set([...after.cache.locations, ...before.cache.locations])].slice(0, 6) });
    if (before.historyHash && after.historyHash && before.historyHash !== after.historyHash) {
        const offset = before.history?.indexOf(after.history?.[0]) ?? -1;
        const overlap = offset > 0 && before.history.length - offset >= 2
            && before.history.slice(offset).every((hash, i) => hash === after.history[i]);
        changes.push({ kind: overlap ? 'history-window-rolled' : 'history-changed' });
    }
    if (before.messagesHash !== after.messagesHash && !changes.some(change => change.kind !== 'cache-parameters-changed')) {
        changes.push({ kind: 'messages-changed', messageIndex: firstDifference(before.hashes, after.hashes) });
    }
    if (before.parametersHash !== after.parametersHash) changes.push({ kind: 'other-parameters-changed' });
    return changes;
}
