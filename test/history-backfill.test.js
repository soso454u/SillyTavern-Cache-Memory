import test from 'node:test';
import assert from 'node:assert/strict';
import { HistoryBackfill, isRetryableSummaryError, waitForRetry } from '../src/history-backfill.js';
import { MemorySummarizer } from '../src/summarizer.js';
import { MemoryStore } from '../src/memory-store.js';
import { DEFAULT_PROMPTS, normalizeSettings, PLUGIN_VERSION } from '../src/defaults.js';
import { getAssistantMessages } from '../src/utils.js';
import { refreshSnapshot, shouldRefreshInjection } from '../src/cache-control.js';
import { formatSummaryFailure } from '../src/ui.js';

function gate() {
    let resolve, reject;
    const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
    return { promise, resolve, reject };
}

function fixture(count = 50) {
    const settings = normalizeSettings({ autoSummarize: false, injectionMode: 'checkpoint_boundary' });
    let chatId = 'old-chat';
    const metadatas = { 'old-chat': {}, 'new-chat': {} };
    let chat = Array.from({ length: count }, (_, i) => ({ name: 'A', is_user: false, mes: `正文${i + 1}`, send_date: `date${i + 1}`, gen_started: `gen${i + 1}` }));
    const original = structuredClone(chat);
    const refreshes = [];
    const store = new MemoryStore({ getMetadata: () => metadatas[chatId], getChatId: () => chatId, saveMetadata: () => {},
        onChange: (current, reason) => {
            if (shouldRefreshInjection(settings, reason)) { refreshSnapshot(current, settings, reason); refreshes.push(reason); }
        } });
    refreshSnapshot(store.current(), settings, 'chat changed');
    const calls = [];
    const apiClient = { complete: async request => {
        calls.push(request);
        if (request.systemPrompt.includes('[CHECKPOINT]')) return { content: '[CHECKPOINT]\n[Current State]\n当前状态\n[KEEP]\n无' };
        if (request.systemPrompt.includes('[LONG_MEMORY]')) return { content: '[LONG_MEMORY]\n无\n[UPDATED_FACTS]\n无\n[RETIRED_FACTS]\n无' };
        return { content: `[SUMMARY]\n[Title]\n${request.userContent}\n[Event]\n${request.userContent}\n[Open]\n无\n[KEEP]\n无` };
    } };
    const summarizer = new MemorySummarizer({ store, apiClient, getSettings: () => settings, getChat: () => chat });
    const progress = [];
    const backfill = new HistoryBackfill({ summarizer, store, getChat: () => chat, onProgress: state => progress.push(state) });
    return { settings, original, get chat() { return chat; }, store, apiClient, calls, summarizer, backfill, progress, refreshes,
        switchChat() { chatId = 'new-chat'; chat = [{ name: 'B', mes: '新聊天', gen_started: 'new' }]; } };
}

test('50-floor old chat: manual 1–10 creates two checkpoints once after the batch, then manual floor 11 works with auto off', async () => {
    const f = fixture();
    let aggregates = 0;
    const generate = f.summarizer.generateDueAggregates.bind(f.summarizer);
    f.summarizer.generateDueAggregates = (...args) => { aggregates++; return generate(...args); };
    const result = await f.backfill.start({ startFloor: 1, endFloor: 10 });
    assert.equal(result.success, 10);
    assert.equal(result.processed, 10);
    assert.equal(result.status, 'completed');
    assert.equal(aggregates, 1);
    assert.equal(f.calls.length, 12);
    assert.ok(f.calls.slice(0, 10).every(call => call.userContent.startsWith('正文')));
    assert.deepEqual(f.store.current().checkpoints.map(cp => [cp.id, cp.startFloor, cp.endFloor]), [['checkpoint-001', 1, 5], ['checkpoint-002', 6, 10]]);
    assert.deepEqual(f.refreshes, ['new checkpoint']);
    await f.summarizer.summarizeMessage(getAssistantMessages(f.chat)[10].messageId);
    assert.equal(Object.keys(f.store.current().summaries).length, 11);
    assert.equal(f.calls.length, 13);
    assert.deepEqual(f.chat, f.original);
});

test('missing Checkpoint backfill scans complete 5-floor groups, preserves every existing record and never builds Long Memory', async () => {
    const f = fixture(20);
    const entries = getAssistantMessages(f.chat);
    for (const entry of entries.filter(item => item.floor !== 12)) {
        f.store.addSummary({
            messageId: entry.messageId,
            messageIndex: entry.messageIndex,
            sourceFingerprint: entry.fingerprint,
            floor: entry.floor,
            title: `S${entry.floor}`,
            event: `E${entry.floor}`,
            raw: `S${entry.floor}`,
            status: 'frozen',
            frozen: true,
        });
    }
    const manual = { id: 'checkpoint-manual', startFloor: 6, endFloor: 10, content: '手动状态', status: 'manual-edited', manualEdited: true, frozen: true };
    const failed = { id: 'checkpoint-failed', startFloor: 16, endFloor: 20, content: '旧失败', status: 'failed', frozen: false };
    f.store.addCheckpoint(manual);
    f.store.addCheckpoint(failed);
    const before = structuredClone(f.store.current().checkpoints);
    let longCalls = 0;
    f.summarizer.generateDueLongMemories = async () => { longCalls++; };

    const plan = f.summarizer.getMissingCheckpointPlan();
    assert.deepEqual(plan.candidates, [{ startFloor: 1, endFloor: 5 }]);
    assert.deepEqual(plan.blocked, [{ startFloor: 11, endFloor: 15, missingFloors: [12] }]);
    assert.deepEqual(plan.existing.map(item => [item.startFloor, item.endFloor]), [[6, 10], [16, 20]]);

    const result = await f.summarizer.fillMissingCheckpoints();
    assert.equal(result.created, 1);
    assert.equal(result.failed, 0);
    assert.equal(longCalls, 0);
    assert.equal(f.calls.length, 1);
    assert.deepEqual(f.store.current().checkpoints.find(item => item.id === manual.id), before.find(item => item.id === manual.id));
    assert.deepEqual(f.store.current().checkpoints.find(item => item.id === failed.id), before.find(item => item.id === failed.id));
    assert.ok(f.store.current().checkpoints.some(item => item.startFloor === 1 && item.endFloor === 5 && item.status === 'frozen'));
    assert.ok(!f.store.current().checkpoints.some(item => item.startFloor === 11 && item.endFloor === 15));
});

test('missing Checkpoint backfill cancellation aborts the active request without writing a failed record', async () => {
    const f = fixture(5);
    for (const entry of getAssistantMessages(f.chat)) {
        f.store.addSummary({ messageId: entry.messageId, messageIndex: entry.messageIndex, sourceFingerprint: entry.fingerprint,
            floor: entry.floor, title: 'S', event: 'E', raw: 'S', status: 'frozen', frozen: true });
    }
    const started = gate();
    f.apiClient.complete = request => new Promise((resolve, reject) => {
        started.resolve();
        request.signal.addEventListener('abort', () => reject(Object.assign(new Error('请求已取消'), { code: 'REQUEST_ABORTED' })), { once: true });
    });
    const controller = new AbortController();
    const pending = f.summarizer.fillMissingCheckpoints({ signal: controller.signal });
    await started.promise;
    controller.abort();
    await assert.rejects(pending, error => error.code === 'REQUEST_ABORTED');
    assert.deepEqual(f.store.current().checkpoints, []);
});

test('transient failures retry at 2s/5s, persistent errors do not stop later floors; 401 is not retried', async () => {
    const f = fixture(4);
    const attempts = new Map();
    const delays = [];
    const complete = f.apiClient.complete;
    f.backfill.delay = async ms => delays.push(ms);
    f.apiClient.complete = request => {
        const body = request.userContent;
        attempts.set(body, (attempts.get(body) || 0) + 1);
        if (body === '正文1' && attempts.get(body) < 3) throw Object.assign(new Error('Gateway timeout'), { status: 504 });
        if (body === '正文2') throw Object.assign(new Error('Unauthorized'), { status: 401 });
        if (body === '正文3') throw Object.assign(new Error('请求超时'), { code: 'REQUEST_TIMEOUT' });
        return complete(request);
    };
    const result = await f.backfill.start({ endFloor: 4 });
    assert.deepEqual(delays, [2000, 5000, 2000, 5000]);
    assert.deepEqual([...attempts.values()], [3, 1, 3, 1]);
    assert.equal(result.success, 2);
    assert.equal(result.failed, 2);
    assert.equal(result.retries, 4);
    assert.deepEqual(f.chat, f.original);
});

test('missing/failed modes skip frozen records, forced batch replacements keep the strict snapshot frozen', async () => {
    const f = fixture(3);
    const entries = getAssistantMessages(f.chat);
    await f.summarizer.summarizeMessage(entries[0].messageId, { deferAggregates: true });
    f.store.addSummary({ messageId: entries[1].messageId, floor: 2, status: 'failed', frozen: false });
    let result = await f.backfill.start({ endFloor: 3, mode: 'missing' });
    assert.equal(result.success, 1);
    assert.equal(result.skipped, 2);
    result = await f.backfill.start({ endFloor: 3, mode: 'failed' });
    assert.equal(result.success, 1);
    assert.equal(result.skipped, 2);
    const snapshot = f.store.current().injectionSnapshot.value;
    result = await f.backfill.start({ endFloor: 3, mode: 'all' });
    assert.equal(result.success, 3);
    assert.equal(f.store.current().injectionSnapshot.value, snapshot);
    assert.deepEqual(f.refreshes, []);
});

test('forcing a batch with a published checkpoint preserves both the checkpoint bytes and its strict prompt', async () => {
    const f = fixture(5);
    await f.backfill.start({ endFloor: 5 });
    const prompt = f.store.current().injectionSnapshot.value;
    const checkpoint = structuredClone(f.store.current().checkpoints[0]);
    f.refreshes.length = 0;
    f.apiClient.complete = async request => ({ content: `[SUMMARY]\n[Title]\n更新\n[Event]\n${request.userContent}的更新` });
    const result = await f.backfill.start({ endFloor: 5, mode: 'all' });
    assert.equal(result.success, 5);
    assert.notEqual(prompt, '');
    assert.equal(f.store.current().injectionSnapshot.value, prompt);
    assert.equal(f.store.current().checkpoints[0].content, checkpoint.content);
    assert.equal(f.store.current().checkpoints[0].status, 'stale');
    assert.deepEqual(f.refreshes, []);
});

test('pause finishes the active request, waits before the next floor, then resumes; concurrency remains one', async () => {
    const f = fixture(3);
    const started = gate(), release = gate(), paused = gate();
    const complete = f.apiClient.complete;
    let concurrent = 0, maximum = 0;
    f.apiClient.complete = async request => {
        maximum = Math.max(maximum, ++concurrent);
        if (request.userContent === '正文1') { started.resolve(); await release.promise; }
        try { return await complete(request); } finally { concurrent--; }
    };
    f.backfill.onProgress = state => { if (state.status === 'paused') paused.resolve(); };
    const pending = f.backfill.start({ endFloor: 3 });
    await started.promise;
    f.backfill.pause();
    release.resolve();
    await paused.promise;
    assert.equal(f.calls.length, 1);
    assert.equal(f.backfill.state.success, 1);
    assert.equal(f.backfill.state.processed, 1);
    f.backfill.resume();
    assert.equal((await pending).success, 3);
    assert.equal(maximum, 1);
});

test('cancellation aborts only the active floor and aggregates the five already saved summaries once', async () => {
    const f = fixture(10);
    const started = gate();
    const complete = f.apiClient.complete;
    f.apiClient.complete = request => {
        if (request.userContent !== '正文6') return complete(request);
        return new Promise((_resolve, reject) => {
            request.signal.addEventListener('abort', () => reject(Object.assign(new Error('cancelled'), { code: 'REQUEST_ABORTED' })), { once: true });
            started.resolve();
        });
    };
    const pending = f.backfill.start({ endFloor: 10 });
    await started.promise;
    f.backfill.cancel();
    const result = await pending;
    assert.equal(result.status, 'cancelled');
    assert.equal(result.success, 5);
    assert.equal(result.failed, 0);
    assert.equal(Object.keys(f.store.current().summaries).length, 5);
    assert.equal(f.store.current().checkpoints.length, 1);
    assert.equal(f.summarizer.aggregateDeferrals, 0);
});

test('discarded backfill can reset progress without a late cancelled state overwriting idle', async () => {
    const f = fixture(3);
    const started = gate();
    f.apiClient.complete = request => new Promise((_resolve, reject) => {
        request.signal.addEventListener('abort', () => reject(Object.assign(new Error('cancelled'), { code: 'REQUEST_ABORTED' })), { once: true });
        started.resolve();
    });
    const pending = f.backfill.start({ endFloor: 3 });
    await started.promise;
    f.backfill.cancel({ discard: true });
    f.backfill.reset();
    await pending;

    assert.deepEqual(f.backfill.state, { status: 'idle', total: 0, processed: 0, success: 0, failed: 0, skipped: 0, retries: 0, currentFloor: null, error: '' });
    assert.equal(f.backfill.active, false);
    assert.equal(f.summarizer.aggregateDeferrals, 0);
});

test('switching chat during a failed request discards the error and never writes to the new chat', async () => {
    const f = fixture(3);
    const started = gate(), response = gate();
    f.apiClient.complete = () => { started.resolve(); return response.promise; };
    const pending = f.backfill.start({ endFloor: 3 });
    await started.promise;
    f.switchChat();
    response.reject(new Error('HTTP 504'));
    const result = await pending;
    assert.equal(result.status, 'cancelled');
    assert.deepEqual(f.store.current().summaries, {});
    assert.deepEqual(f.store.current().checkpoints, []);
    assert.equal(f.summarizer.aggregateDeferrals, 0);
});

test('clearing the current chat invalidates a late summary and immediately empties strict injection', async () => {
    const f = fixture(1);
    const entry = getAssistantMessages(f.chat)[0];
    f.store.addCheckpoint({ id: 'checkpoint-001', startFloor: 1, endFloor: 1, content: '旧状态', frozen: true, status: 'frozen' });
    refreshSnapshot(f.store.current(), f.settings, 'manual edit');
    assert.match(f.store.current().injectionSnapshot.value, /旧状态/);
    const started = gate();
    const response = gate();
    f.apiClient.complete = () => { started.resolve(); return response.promise; };
    const pending = f.summarizer.summarizeMessage(entry.messageId);
    const rejection = assert.rejects(pending, error => error.code === 'CHAT_CHANGED');
    await started.promise;

    f.summarizer.invalidateContext();
    f.store.clearCurrentChat();
    response.resolve({ content: '[SUMMARY]\n[Event]\n不应写回' });

    await rejection;
    const cleared = f.store.current();
    assert.deepEqual(cleared.summaries, {});
    assert.deepEqual(cleared.checkpoints, []);
    assert.deepEqual(cleared.longMemories, []);
    assert.deepEqual(cleared.keepRegistry, {});
    assert.equal(cleared.injectionSnapshot.value, '');
    assert.equal(f.refreshes.at(-1), 'current chat cleared');
});

test('late failed checkpoints and long memories are discarded after a chat switch too', async () => {
    for (const kind of ['checkpoint', 'long']) {
        const f = fixture(5);
        const entries = getAssistantMessages(f.chat);
        for (const entry of entries) f.store.addSummary({ ...entry, message: undefined, title: 'S', event: '事件', status: 'frozen', frozen: true });
        const started = gate(), response = gate();
        f.apiClient.complete = () => { started.resolve(); return response.promise; };
        const pending = kind === 'checkpoint' ? f.summarizer.generateCheckpoint(1, 5)
            : f.summarizer.generateLongMemory([{ id: 'checkpoint-001', startFloor: 1, endFloor: 5, content: '状态' }]);
        const rejection = assert.rejects(pending, error => error.code === 'CHAT_CHANGED');
        await started.promise;
        f.switchChat();
        response.reject(new Error('HTTP 504'));
        await rejection;
        assert.deepEqual(f.store.current().checkpoints, []);
        assert.deepEqual(f.store.current().longMemories, []);
    }
});

test('editing or deleting a source while summary is in flight rejects stale output', async () => {
    for (const mutate of [f => { f.chat[0].mes = '修改后的正文'; }, f => { f.chat.splice(0, 1); }]) {
        const f = fixture(1);
        const started = gate(), response = gate();
        f.apiClient.complete = () => { started.resolve(); return response.promise; };
        const pending = f.summarizer.summarizeMessage(getAssistantMessages(f.chat)[0].messageId);
        const rejection = assert.rejects(pending, error => error.code === 'SOURCE_CHANGED');
        await started.promise;
        mutate(f);
        response.resolve({ content: '[SUMMARY]\n[Event]\n旧正文的摘要' });
        await rejection;
        assert.deepEqual(f.store.current().summaries, {});
    }
});

test('manual duplicate clicks share one request and pending work is invalidated on unload/chat change', async () => {
    const f = fixture(2);
    const response = gate();
    let count = 0;
    f.apiClient.complete = () => { count++; return response.promise; };
    f.summarizer.onStatus = state => { if (state === 'success') f.summarizer.invalidateContext(); };
    const [one, two] = getAssistantMessages(f.chat);
    const first = f.summarizer.summarizeMessage(one.messageId);
    const duplicate = f.summarizer.summarizeMessage(one.messageId);
    const second = f.summarizer.summarizeMessage(two.messageId);
    const rejection = assert.rejects(second, error => error.code === 'CHAT_CHANGED');
    assert.equal(f.summarizer.isSummarizing(one.messageId), true);
    await Promise.resolve();
    response.resolve({ content: '[SUMMARY]\n[Event]\n事实' });
    await first;
    await duplicate;
    await rejection;
    assert.equal(count, 1);
});

test('retry filtering, interruptible delay and three error UI categories preserve provenance', async () => {
    for (const status of [429, 502, 503, 504]) assert.equal(isRetryableSummaryError({ status }), true);
    for (const status of [401, 403, 404, 400]) assert.equal(isRetryableSummaryError({ status, message: 'timeout 504' }), false);
    assert.equal(isRetryableSummaryError({ code: 'ST_PROXY_ROUTE_MISSING', status: 504 }), false);
    assert.equal(isRetryableSummaryError({ category: 'authentication_error', status: 200, message: 'Unauthorized timed out' }), false);
    const controller = new AbortController();
    const pending = waitForRetry(5000, controller.signal);
    controller.abort();
    await assert.rejects(pending, error => error.code === 'REQUEST_ABORTED');
    const diagnostics = { proxy: 'HTTP 504', upstream: '未提供' };
    assert.match(formatSummaryFailure({ errorCode: 'REQUEST_TIMEOUT', errorDiagnostics: diagnostics }), /客户端超时/);
    assert.match(formatSummaryFailure({ errorCategory: 'proxy_error', errorDiagnostics: diagnostics }), /SillyTavern 后端或其网关失败/);
    assert.match(formatSummaryFailure({ errorDiagnostics: { ...diagnostics, upstream: 'HTTP 504' } }), /上游 HTTP 504/);
});

test('default prompts adopt user-provided formats, new budgets apply and custom prompts/timeouts survive', () => {
    const settings = normalizeSettings();
    assert.equal(PLUGIN_VERSION, '1.20.0');
    assert.equal(settings.timeoutMs, 180000);
    assert.equal(settings.maxTokens, 4096);
    assert.deepEqual([settings.summaryMaxTokens, settings.checkpointMaxTokens, settings.longMemoryMaxTokens], [1024, 3072, 4096]);
    assert.deepEqual([settings.summaryMaxLength, settings.checkpointMaxLength, settings.longMemoryMaxLength], [350, 1000, 2200]);
    assert.match(DEFAULT_PROMPTS.summary, /\[State\][\s\S]*\[Open\]/);
    assert.match(DEFAULT_PROMPTS.summary, /keep-id 由插件分配/);
    for (const prompt of Object.values(DEFAULT_PROMPTS)) {
        assert.match(prompt, /以旁观事实记录员视角记录，只保存正文明确发生、明确说出或明确成立的信息/);
        assert.match(prompt, /人物自己的说法、判断或猜测不得自动升级为客观事实/);
        assert.match(prompt, /谁明确想到 \/ 感到 \/ 意识到 \/ 决定什么/);
        assert.match(prompt, /关系没有明确成立时，记录具体行为，关系状态保持未知/);
        assert.match(prompt, /不替人物得出统一结论/);
        assert.match(prompt, /记录证据和已成立事实，不替剧情解释人物/);
    }
    assert.match(DEFAULT_PROMPTS.summary, /照录 SOURCE_METADATA 中最完整的剧情日期 \/ 星期 \/ 时间/);
    assert.match(DEFAULT_PROMPTS.summary, /2025\/01\/01 周三 10:21/);
    assert.match(DEFAULT_PROMPTS.summary, /强 KEEP 候选[\s\S]*持续监控、调查或追踪/);
    assert.match(DEFAULT_PROMPTS.summary, /不得因为“多数楼层可以写无”而强行省略/);
    assert.match(DEFAULT_PROMPTS.summary, /已有 KEEP 或 Long Fact 再次出现时，不要重复创建/);
    assert.match(DEFAULT_PROMPTS.checkpoint, /\[RESOLVED_KEEP\][\s\S]*NEW_SUMMARIES 中的逐字证据[\s\S]*\[SUPERSEDED_KEEP\]/);
    assert.match(DEFAULT_PROMPTS.checkpoint, /【剧情日期\/时间与地点】[\s\S]*完整剧情日期时间[\s\S]*无需在 Checkpoint 正文重复计算或输出/);
    assert.doesNotMatch(DEFAULT_PROMPTS.checkpoint, /^\[KEEP\]$/m);
    assert.match(DEFAULT_PROMPTS.longMemory, /\[UPDATED_FACTS\][\s\S]*\[RETIRED_FACTS\]/);
    assert.match(DEFAULT_PROMPTS.longMemory, /【剧情日期\/时间】[\s\S]*时间范围同样使用完整剧情日期时间[\s\S]*缺失时间不得推算或补全/);
    const custom = normalizeSettings({ timeoutMs: 60000, prompts: { summary: '自定义模板' } });
    assert.equal(custom.timeoutMs, 60000);
    assert.equal(custom.prompts.summary, '自定义模板');
    const migrated = normalizeSettings({ maxTokens: 1234, summaryMaxLength: 777, checkpointMaxLength: 888, longMemoryMaxLength: 999 });
    assert.deepEqual([migrated.summaryMaxTokens, migrated.checkpointMaxTokens, migrated.longMemoryMaxTokens], [1234, 1234, 1234]);
    assert.deepEqual([migrated.summaryMaxLength, migrated.checkpointMaxLength, migrated.longMemoryMaxLength], [777, 888, 999]);
});
