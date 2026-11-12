import { summaryStoryBlock, summaryUserSource } from './summary-source.js?v=1.27.30';
import { isUsableMemory } from './continuity.js?v=1.27.30';
import { summaryVersionMatches } from './memory-store.js?v=1.27.30';
import { getAssistantMessages, isNormalAssistant, messageFingerprint, messageIdentity } from './utils.js?v=1.27.16';
import { getOpeningSource, publishedOpeningCoverage } from './opening-source.js?v=1.27.16';

export const RECENT_RAW_FLOORS = 5;

// Publication waits for a whole stage to leave the recent raw-text window.
// The resulting snapshot stays frozen until the next normal CP/Long boundary.
export function historyPublicationLimit(store, usable) {
    const floors = [
        ...Object.values(store.summaries ?? {}).filter(usable).map(row => row.floor),
        ...store.checkpoints.filter(usable).map(row => row.endFloor),
        ...store.longMemories.filter(usable).map(row => row.endFloor),
    ];
    return Math.max(0, Math.max(0, ...floors.filter(Number.isInteger)) - RECENT_RAW_FLOORS);
}

const identity = message => `${message.is_user === true ? 'user' : 'assistant'}:${messageIdentity(message)}`;
const unique = messages => {
    const found = new Map();
    for (const message of messages) {
        const key = identity(message);
        found.set(key, found.has(key) ? null : message);
    }
    return found;
};

function hasNonTextContext(message) {
    const extra = message?.extra;
    return message?.is_system || extra?.type === 'narrator' || extra?.isSmallSys
        || extra?.media?.length || extra?.image || extra?.file || extra?.files?.length
        || Array.isArray(extra?.tool_invocations) || Object.getOwnPropertySymbols(extra ?? {}).length > 0;
}

function promptSourceResolver(chat) {
    const originalById = unique(chat);
    // ST's index is assigned before interceptors, after system filtering. It
    // also identifies undated openings whose text has been changed by regex.
    const sourceSequences = [chat.filter(row => !row.is_system),
        chat.filter(row => !row.is_system || Array.isArray(row.extra?.tool_invocations))];
    return row => {
        const direct = originalById.get(identity(row));
        if (direct) return direct;
        if (!Number.isInteger(row.index) || row.index < 0) return null;
        const candidates = sourceSequences.map(sequence => sequence[row.index]);
        const source = candidates[0];
        return source && candidates.every(candidate => candidate === source)
            && (source.is_user === true) === (row.is_user === true) ? source : null;
    };
}

function sameBodySourceFingerprints(entry) {
    const fingerprints = new Set([entry.fingerprint]);
    const message = entry.message;
    // Imports can restore the selected reply's text with a different swipe
    // index or timestamps. Only another saved copy of the exact body qualifies.
    const swipeInfo = Array.isArray(message.swipe_info) ? message.swipe_info : [];
    for (const [index, info] of swipeInfo.entries()) {
        if (!info || message.swipes?.[index] !== message.mes) continue;
        fingerprints.add(messageFingerprint({ ...message, swipe_id: index, send_date: info.send_date ?? '',
            gen_started: info.gen_started ?? '', extra: info.extra ?? {} }));
    }
    return fingerprints;
}

export function promptHistoryFloor(coreChat, chat, summaries = {}) {
    if (!Array.isArray(coreChat) || !Array.isArray(chat)) return 0;
    const sourceFor = promptSourceResolver(chat);
    const available = new Set(coreChat.map(sourceFor));
    const entries = getAssistantMessages(chat);
    // A loaded tail may start at historical floor 101, not floor 1. Use only
    // unique, body-verified anchors with a consistent offset; never infer an
    // absolute floor from the highest saved record alone.
    const offsets = new Set();
    for (const entry of entries) {
        const matches = Object.values(summaries).filter(row => Number.isInteger(row.floor)
            && (row.messageId === entry.messageId || row.sourceMessageKey === entry.sourceMessageKey || row.sourceContentFingerprint === entry.contentFingerprint)
            && (row.sourceContentFingerprint === entry.contentFingerprint || row.sourceFingerprint === entry.fingerprint));
        const floors = new Set(matches.map(row => row.floor));
        if (floors.size === 1) offsets.add(matches[0].floor - entry.floor);
    }
    const floor = entries.filter(entry => available.has(entry.message)).at(-1)?.floor ?? 0;
    return floor ? Math.max(0, floor + (offsets.size === 1 ? [...offsets][0] : 0)) : 0;
}

/** Filter only a temporary generation array. Memory coverage governs paired
 * history pruning; Rolling also caps normal assistant replies independently.
 */
export function filterCoveredHistory(coreChat, chat, snapshot, publishedValue, {
    type, summaries = {}, historyHandoff = snapshot?.historyHandoff === true, lastUserOnly = false,
    injectionMode = snapshot?.mode, recentRawFloors = snapshot?.recentRawFloors ?? 3,
} = {}) {
    const unchanged = reason => ({ messages: coreChat, removed: 0, reason });
    if (!Array.isArray(coreChat) || !Array.isArray(chat) || coreChat === chat) return unchanged('not-a-prompt-copy');
    if (![undefined, 'normal', 'swipe', 'regenerate', 'continue'].includes(type)) return unchanged('generation-type');
    const rolling = injectionMode === 'rolling';
    if (!rolling) {
        const originals = new Set(chat);
        if (coreChat.some(row => originals.has(row))) return unchanged('not-a-prompt-copy');
    }
    const shortHistory = injectionMode === 'checkpoint_short_history';
    const adaptive = rolling || shortHistory;
    if (!historyHandoff && !lastUserOnly && !adaptive) return unchanged('selection-disabled');
    if (shortHistory && (snapshot?.mode !== injectionMode || snapshot.value !== publishedValue)) return unchanged('unconfirmed-frozen-prefix');
    const originalById = unique(chat);
    const sourceFor = promptSourceResolver(chat);
    const openingMessage = getOpeningSource(chat)?.message;
    const latestUser = (adaptive ? coreChat.map(sourceFor) : chat).findLast(row => row && row !== openingMessage && row.is_user === true
        && !row.is_system && !Array.isArray(row.extra?.tool_invocations));
    const openingCovered = (!shortHistory || !hasNonTextContext(openingMessage)) && publishedOpeningCoverage(chat, snapshot, publishedValue);
    const selected = coreChat.filter(row => {
        if (row.is_system || Array.isArray(row.extra?.tool_invocations)) return true;
        const source = sourceFor(row);
        if (!source) return true;
        // Do not silently discard the only copy of the initial facts while
        // upgrading old CPs or before the first stage has been published.
        if (source === openingMessage) return !openingCovered;
        return !lastUserOnly || source.is_user !== true || source === latestUser;
    });
    const entries = getAssistantMessages(chat);
    const contentCounts = new Map();
    if (adaptive) for (const entry of entries) {
        contentCounts.set(entry.contentFingerprint, (contentCounts.get(entry.contentFingerprint) ?? 0) + 1);
    }
    const entryBySource = rolling ? new Map(entries.map(entry => [entry.message, entry])) : null;
    const separateOpening = rolling && openingMessage && !entryBySource.has(openingMessage);
    const isRollingReply = row => isNormalAssistant(row) && (!separateOpening || sourceFor(row) !== openingMessage);
    const rollingReplies = rolling ? selected.filter(isRollingReply) : [];
    const available = shortHistory ? new Set(selected.map(sourceFor)) : null;
    const recent = rolling ? new Set(rollingReplies.slice(-recentRawFloors).map(sourceFor))
        : new Set((shortHistory ? entries.filter(entry => available.has(entry.message)) : entries)
            .slice(-(shortHistory ? recentRawFloors : RECENT_RAW_FLOORS)).map(entry => entry.message));
    const retainedReasons = new Map();
    const finish = (messages, reason, replacements = new Map()) => {
        const retained = shortHistory ? new Set(messages.filter(row => !replacements.has(row)).map(sourceFor)) : null;
        const older = retained ? entries.filter(entry => !recent.has(entry.message) && retained.has(entry.message)) : [];
        const omittedOlderDetails = [];
        const rawCount = rolling ? messages.filter(isRollingReply).length : 0;
        let toOmit = Math.max(0, rawCount - recentRawFloors);
        const output = toOmit ? messages.filter(row => {
            if (!toOmit || !isRollingReply(row)) return true;
            toOmit--;
            const source = sourceFor(row);
            omittedOlderDetails.push({ floor: entryBySource.get(source)?.floor ?? null, reason: retainedReasons.get(source) ?? reason });
            return false;
        }) : messages;
        return { messages: replacements.size ? output.map(row => replacements.get(row) ?? row) : output,
            removed: coreChat.length - output.length, reason, ...(shortHistory ? { replacedWithSummaries: replacements.size } : {}),
            ...(adaptive ? { recentFloors: entries.filter(entry => recent.has(entry.message)).map(entry => entry.floor),
                retainedOlderFloors: older.map(entry => entry.floor),
                retainedOlderDetails: older.map(entry => ({ floor: entry.floor, reason: retainedReasons.get(entry.message) ?? reason })) } : {}),
            ...(rolling ? { recentRawCount: rawCount - omittedOlderDetails.length, omittedOlderDetails } : {}) };
    };
    if (!shortHistory && ((!historyHandoff && !rolling) || snapshot?.historyHandoff !== true || !publishedValue || snapshot.value !== publishedValue)) return finish(selected, 'selection-only');
    const blocks = (snapshot.blocks ?? []).filter(block => ['checkpoint', 'long-story', ...(rolling ? ['summary-story'] : [])].includes(block.type) && block.coversHistory === true
        && Number.isInteger(block.startFloor) && Number.isInteger(block.endFloor)
        && block.startFloor >= 1 && block.endFloor >= block.startFloor
        && block.text?.trim() && publishedValue.includes(block.text));
    if (!blocks.length && !shortHistory) return finish(selected, 'no-story-coverage');
    const limit = shortHistory ? Infinity : (entries.at(-1)?.floor ?? 0) - (rolling ? recentRawFloors : RECENT_RAW_FLOORS);
    const promptBySource = new Map();
    if (adaptive) {
        // Regex may change text-only identities. The original index still
        // identifies that prompt copy, but duplicate source mappings stay unsafe.
        for (const row of selected) {
            const source = sourceFor(row);
            if (!source) continue;
            promptBySource.set(source, promptBySource.has(source) ? null : row);
        }
    }
    const promptById = adaptive ? null : unique(selected);
    const promptFor = original => adaptive ? promptBySource.get(original) : promptById.get(identity(original));
    const sourceFloors = new Map(), contentFloors = new Map(), summariesByFloor = new Map();
    for (const row of Object.values(summaries)) {
        if (adaptive) {
            const rows = summariesByFloor.get(row.floor) ?? [];
            rows.push(row);
            summariesByFloor.set(row.floor, rows);
        }
        for (const id of new Set([row.messageId, row.sourceMessageKey].filter(Boolean))) {
            const floors = sourceFloors.get(id) ?? new Set();
            floors.add(row.floor); sourceFloors.set(id, floors);
        }
        if (row.sourceContentFingerprint) {
            const floors = contentFloors.get(row.sourceContentFingerprint) ?? new Set();
            floors.add(row.floor); contentFloors.set(row.sourceContentFingerprint, floors);
        }
    }
    const remove = new Set(), replacements = new Map();
    let previousIndex = -1;
    for (const entry of entries) {
        const startIndex = previousIndex + 1;
        previousIndex = entry.messageIndex;
        if (entry.floor > limit || recent.has(entry.message)) continue;
        const known = sourceFloors.get(entry.messageId) ?? contentFloors.get(entry.contentFingerprint);
        const assistantKey = identity(entry.message);
        // A partially loaded/reordered chat must not borrow another floor's
        // coverage. Unknown or ambiguous identities keep their original turns.
        const userFingerprint = adaptive ? summaryUserSource(chat, entry).fingerprint : '';
        const direct = summaries[entry.messageId];
        const changedUser = direct?.floor === entry.floor && Object.hasOwn(direct, 'userSourceFingerprint')
            && direct.userSourceFingerprint !== userFingerprint;
        let fingerprints;
        const bodyMatches = row => row.sourceContentFingerprint ? row.sourceContentFingerprint === entry.contentFingerprint
            : row.sourceFingerprint && (fingerprints ??= sameBodySourceFingerprints(entry)).has(row.sourceFingerprint);
        const sameFloor = summariesByFloor.get(entry.floor) ?? [];
        const matchingSummaries = adaptive && !changedUser ? sameFloor.filter(row =>
            (!shortHistory || isUsableMemory(row) && Boolean(row.sourceContentFingerprint || row.sourceFingerprint))
            && row.status !== 'failed' && row.frozen !== false
            && (!Object.hasOwn(row, 'userSourceFingerprint') || row.userSourceFingerprint === userFingerprint)
            && (bodyMatches(row) || !row.sourceContentFingerprint && !row.sourceFingerprint
                && (row.messageId === entry.messageId || row.sourceMessageKey === entry.sourceMessageKey))) : [];
        const assistant = promptFor(entry.message);
        const identityMatches = known?.size === 1 && known.has(entry.floor) && originalById.get(assistantKey) === entry.message;
        const uniqueBodyMatches = adaptive && contentCounts.get(entry.contentFingerprint) === 1
            && (!contentFloors.has(entry.contentFingerprint) || contentFloors.get(entry.contentFingerprint).size === 1)
            && matchingSummaries.some(bodyMatches);
        let retainedReason;
        if (!assistant || !identityMatches && !uniqueBodyMatches) retainedReason = 'source-identity-unverified';
        if (adaptive && !matchingSummaries.length) retainedReason = changedUser || sameFloor.some(row => bodyMatches(row)
            && Object.hasOwn(row, 'userSourceFingerprint') && row.userSourceFingerprint !== userFingerprint)
            ? 'user-source-changed' : sameFloor.length ? 'summary-source-unverified' : 'summary-missing';
        if ((shortHistory || !identityMatches) && (hasNonTextContext(assistant) || hasNonTextContext(entry.message))) retainedReason = 'protected-message';
        if (retainedReason) { retainedReasons.set(entry.message, retainedReason); continue; }
        const source = matchingSummaries.length === 1 ? matchingSummaries[0] : null;
        const covered = blocks.some(block => block.startFloor <= entry.floor && block.endFloor >= entry.floor
            && (!shortHistory || source && !block.missingFloors?.includes(entry.floor)
                && Object.hasOwn(block.sourceVersions ?? {}, source.messageId)
                && summaryVersionMatches(source, block.sourceVersions[source.messageId])));
        const story = shortHistory && !covered && source ? summaryStoryBlock(source) : null;
        if (!covered && !story) { retainedReasons.set(entry.message, 'no-verified-story-coverage'); continue; }
        if (story) {
            // Replace in the same history slot, after the frozen prompt.
            // Core owns token budgeting and serializes narrator rows as system.
            replacements.set(assistant, { name: assistant.name, is_user: false, mes: story.text,
                index: assistant.index, extra: { type: 'narrator' } });
        }
        // Historical user input travels with its generated answer unless
        // the independent latest-user-only selection already excluded it.
        for (let i = startIndex; i <= entry.messageIndex; i++) {
            const original = chat[i];
            if (original === openingMessage) continue; // only the opening-coverage policy may remove it
            if (i !== entry.messageIndex && original.is_user !== true) continue;
            if ((lastUserOnly || adaptive) && original === latestUser) continue;
            if (original.is_system || Array.isArray(original.extra?.tool_invocations)) continue;
            const candidate = promptFor(original);
            if (shortHistory && (hasNonTextContext(original) || hasNonTextContext(candidate)
                || i !== entry.messageIndex && (!source || !Object.hasOwn(source, 'userSourceFingerprint')))) continue;
            if ((adaptive && i === entry.messageIndex || originalById.get(identity(original)) === original) && candidate && candidate.is_system !== true
                && !Array.isArray(candidate.extra?.tool_invocations) && !replacements.has(candidate)) remove.add(candidate);
        }
    }
    const messages = selected.filter(row => !remove.has(row));
    return finish(messages, shortHistory ? 'frozen-prefix-with-summary-tail' : 'published-story-coverage', replacements);
}
