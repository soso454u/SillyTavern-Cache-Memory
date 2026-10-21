import test from 'node:test';
import assert from 'node:assert/strict';
import { RETRY_DELAYS, retryOperation, isRetryableError, waitForRetry } from '../src/retry.js';
import { MemorySummarizer } from '../src/summarizer.js';
import { MemoryStore } from '../src/memory-store.js';
import { normalizeSettings } from '../src/defaults.js';
import { getAssistantMessages } from '../src/utils.js';

test('three retries mean four attempts; delay and reported retry counts are exact', async () => {
    let attempts = 0; const waits = [], notices = [];
    assert.equal(await retryOperation(async () => {
        if (++attempts < 4) throw Object.assign(new Error('HTTP 504 Gateway Time-out'), { status: 504 });
        return 'ok';
    }, { delay: async ms => waits.push(ms), onRetry: info => notices.push(info.attempt) }), 'ok');
    assert.equal(attempts, 4); assert.deepEqual(waits, RETRY_DELAYS); assert.deepEqual(notices, [1, 2, 3]);
    attempts = 0;
    await assert.rejects(retryOperation(async () => { attempts++; throw Object.assign(new Error('timeout'), { code: 'REQUEST_TIMEOUT' }); },
        { delay: async () => {} }), /timeout/);
    assert.equal(attempts, 4);
});

test('transient HTTP and network errors retry, cancellation/auth/source/save/format errors do not', () => {
    for (const status of [408, 429, 500, 502, 503, 504]) assert.equal(isRetryableError({ status }), true);
    for (const status of [400, 401, 403, 404, 422]) assert.equal(isRetryableError({ status, message: 'HTTP 504 in quoted HTML' }), false);
    for (const code of ['REQUEST_ABORTED', 'CHAT_CHANGED', 'SOURCE_CHANGED', 'SAVE_UNCONFIRMED', 'ST_PROXY_ROUTE_MISSING'])
        assert.equal(isRetryableError({ code, message: '504' }), false);
    assert.equal(isRetryableError({ diagnostics: { upstream: 'HTTP 503', proxy: 'HTTP 200' } }), true);
    assert.equal(isRetryableError(new TypeError('Failed to fetch')), true);
    assert.equal(isRetryableError(new Error('缺少 Event 字段')), false);
});

test('cancelling or changing source during backoff prevents the next paid request', async () => {
    for (const cancel of [true, false]) {
        let calls = 0, changed = false; const controller = new AbortController();
        await assert.rejects(retryOperation(async () => { calls++; throw Object.assign(new Error('504'), { status: 504 }); }, {
            signal: controller.signal, assertActive: () => { if (changed) throw Object.assign(new Error('changed'), { code: 'SOURCE_CHANGED' }); },
            delay: async () => { if (cancel) controller.abort(); else changed = true; },
        }), { code: cancel ? 'REQUEST_ABORTED' : 'SOURCE_CHANGED' });
        assert.equal(calls, 1);
    }
    const controller = new AbortController(); const waiting = waitForRetry(10000, controller.signal);
    controller.abort(); await assert.rejects(waiting, { code: 'REQUEST_ABORTED' });
});

function fixture(count = 1) {
    const chat = Array.from({ length: count }, (_, i) => ({ mes: `合成正文${i}`, gen_started: `g${i}` }));
    const metadata = {}, calls = [], waits = [];
    const store = new MemoryStore({ getChatId: () => 'retry-chat', getMetadata: () => metadata, saveMetadata() {} });
    const summarizer = new MemorySummarizer({ store, getChat: () => chat, getSettings: () => normalizeSettings(),
        retryDelay: async ms => waits.push(ms), apiClient: { complete: async request => {
            calls.push(request);
            if (calls.length < 4) throw Object.assign(new Error('HTTP 504'), { status: 504 });
            return { content: request.systemPrompt.includes('[CHECKPOINT]') ? '[CHECKPOINT]\n[Story So Far]\n合成阶段'
                : request.systemPrompt.includes('[LONG_MEMORY]') ? '[STORY_ARC]\n已保存阶段的剧情整合。\n[LONG_MEMORY]\n无\n[UPDATED_FACTS]\n无\n[RETIRED_FACTS]\n无'
                    : '[SUMMARY]\n[Title]\n合成摘要\n[Event]\n合成正文事件\n[KEEP]\n无' };
        } } });
    return { store, summarizer, chat, calls, waits };
}

for (const stage of ['Summary', 'Checkpoint', 'Long']) test(`${stage} uses one common retry budget, including direct and one-click generation`, async () => {
    const f = fixture(stage === 'Long' ? 50 : 5);
    const entries = getAssistantMessages(f.chat);
    if (stage !== 'Summary') for (const entry of entries) f.store.addSummary({ messageId: entry.messageId, floor: entry.floor, event: '已保存摘要', frozen: true, status: 'frozen' });
    if (stage === 'Summary') {
        // Limit the fill plan to one floor, avoiding unrelated aggregate calls.
        f.chat.splice(1);
        const result = await f.summarizer.fillMissingMemories(); assert.equal(result.created, 1); assert.equal(result.failed, 0);
    } else if (stage === 'Checkpoint') await f.summarizer.generateCheckpoint(1, 5);
    else {
        for (let start = 1; start < 50; start += 5) f.store.addCheckpoint({ id: `cp-${start}`, startFloor: start, endFloor: start + 4,
            content: '[CHECKPOINT]\n[Story So Far]\n已保存阶段', status: 'frozen', frozen: true });
        await f.summarizer.generateLongMemory(f.store.current().checkpoints);
    }
    assert.equal(f.calls.length, 4); assert.deepEqual(f.waits, RETRY_DELAYS);
    assert.equal(f.summarizer.unsavedResponses.size, 0);
});

test('an unconfirmed upload retains the generated response for manual retry without another model call', async () => {
    const f = fixture(); f.calls.length = 3; let offline = true;
    f.summarizer.commitMemory = async mutate => {
        if (offline) throw Object.assign(new Error('保存尚未确认'), { code: 'SAVE_UNCONFIRMED' });
        return mutate();
    };
    const entry = getAssistantMessages(f.chat)[0];
    await assert.rejects(f.summarizer.summarizeMessage(entry.messageId, { deferAggregates: true }), { code: 'SAVE_UNCONFIRMED' });
    assert.equal(f.calls.length, 4); assert.equal(f.summarizer.unsavedResponses.size, 1);
    offline = false;
    await f.summarizer.summarizeMessage(entry.messageId, { deferAggregates: true });
    assert.equal(f.calls.length, 4); assert.equal(f.summarizer.unsavedResponses.size, 0);
    assert.equal(f.store.getSummaryForEntry(entry).event, '合成正文事件');
});
