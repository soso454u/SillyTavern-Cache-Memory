import test from 'node:test';
import assert from 'node:assert/strict';
import { MemorySummarizer, parseFloorSummary } from '../src/summarizer.js';
import { MemoryStore } from '../src/memory-store.js';
import { normalizeSettings } from '../src/defaults.js';
import { getAssistantMessages } from '../src/utils.js';
import { prepareMemoryResponse } from '../src/response-cleanup.js';
import { RETRY_DELAYS } from '../src/retry.js';

const summary = '[SUMMARY]\n[Event]\n信使把信交给医师，两人约定天亮前见面。';
const checkpoint = '[CHECKPOINT]\n[Stage Story]\n信使交信后离开，医师留下等待。';
const long = '[STORY_ARC]\n信使与医师建立通信约定，后来如期会面。\n[LONG_MEMORY]\n无';
function fixture(count = 1) {
    const chat = Array.from({ length: count }, (_, i) => ({ mes: `合成正文${i + 1}`, gen_started: `g${i}` }));
    const metadata = {}, waits = [], calls = [], statuses = [], settings = normalizeSettings();
    const store = new MemoryStore({ getChatId: () => 'recovery-chat', getMetadata: () => metadata, saveMetadata() {} });
    const summarizer = new MemorySummarizer({ store, getChat: () => chat, getSettings: () => settings,
        retryDelay: async ms => waits.push(ms), onStatus: (...args) => statuses.push(args),
        apiClient: { complete: async request => {
            const kind = request.userContent.startsWith('[PREVIOUS_CONTEXT]') ? 'Checkpoint'
                : request.userContent.startsWith('[EXISTING_LONG_FACTS]') ? 'Long' : 'Summary';
            calls.push({ kind, request });
            return { content: { Summary: summary, Checkpoint: checkpoint, Long: long }[kind] };
        } } });
    const seedSummaries = () => {
        for (const entry of getAssistantMessages(chat)) store.addSummary({
            messageId: entry.messageId, floor: entry.floor, messageIndex: entry.messageIndex,
            sourceFingerprint: entry.fingerprint, sourceContentFingerprint: entry.contentFingerprint,
            event: `原摘要${entry.floor}`, frozen: true, status: 'frozen',
        });
    };
    return { chat, store, summarizer, waits, calls, statuses, settings, seedSummaries };
}

for (const stage of ['Summary', 'Checkpoint', 'Long']) {
    test(`${stage}: invalid responses retry and share the network retry budget`, async () => {
        const f = fixture(5);
        if (stage !== 'Summary') f.seedSummaries();
        if (stage === 'Long') f.store.addCheckpoint({ id: 'cp-1', startFloor: 1, endFloor: 5, content: checkpoint, frozen: true, status: 'frozen' });
        let attempts = 0;
        f.summarizer.apiClient.complete = async () => {
            attempts++;
            if (attempts === 1) throw Object.assign(new Error('HTTP 503'), { status: 503 });
            return { content: attempts < 4 ? '[Title]\n只有标题' : { Summary: summary, Checkpoint: checkpoint, Long: long }[stage] };
        };
        const result = stage === 'Summary' ? await f.summarizer.summarizeMessage(getAssistantMessages(f.chat)[0].messageId, { deferAggregates: true })
            : stage === 'Checkpoint' ? await f.summarizer.generateCheckpoint(1, 5)
                : await f.summarizer.generateLongMemory(f.store.current().checkpoints);
        assert.equal(result.status, 'frozen'); assert.equal(attempts, 4);
        assert.deepEqual(f.waits, RETRY_DELAYS); assert.equal(f.summarizer.unsavedResponses.size, 0);
    });

    test(`${stage}: unconfirmed saves reuse the validated output without another model call`, async () => {
        const f = fixture(5); if (stage !== 'Summary') f.seedSummaries();
        if (stage === 'Long') f.store.addCheckpoint({ id: 'cp-1', startFloor: 1, endFloor: 5, content: checkpoint, status: 'frozen' });
        const generate = () => stage === 'Summary' ? f.summarizer.summarizeMessage(getAssistantMessages(f.chat)[0].messageId, { deferAggregates: true })
            : stage === 'Checkpoint' ? f.summarizer.generateCheckpoint(1, 5) : f.summarizer.generateLongMemory(f.store.current().checkpoints);
        f.summarizer.commitMemory = async () => { throw Object.assign(new Error('保存未确认'), { code: 'SAVE_UNCONFIRMED' }); };
        await assert.rejects(generate(), { code: 'SAVE_UNCONFIRMED' });
        assert.equal(f.calls.length, 1); assert.equal(f.summarizer.unsavedResponses.size, 1);
        f.summarizer.commitMemory = async mutate => mutate();
        await generate(); assert.equal(f.calls.length, 1); assert.equal(f.summarizer.unsavedResponses.size, 0);
    });
}

test('minor marker deviations keep real events without another request', () => {
    for (const text of ['[Event]\n医师收下信件。', '**[SUMMARY]**\n### [Event]: 医师收下信件。', '【summary】\n［event］：医师收下信件。']) {
        const result = prepareMemoryResponse(text, 'Summary', { prompt: '[SUMMARY]\n[Event]' });
        assert.match(result, /\[SUMMARY\]/); assert.match(result, /\[Event\]\n医师收下信件。/);
    }
    assert.match(prepareMemoryResponse('**[CHECKPOINT]**\n[Stage Story]: 医师收到信件。', 'Checkpoint'), /\[Stage Story\]\n医师收到信件。/);
    assert.match(prepareMemoryResponse('### 【STORY_ARC】：医师与信使如期会面。', 'Long Memory', { prompt: '[STORY_ARC]' }), /\[STORY_ARC\]\n医师/);
    for (const text of ['[Event]: 无', '**[Event]**: I cannot generate the requested content.', '[Event]: <think>只有思考</think>', '[Title]: 只有标题']) {
        assert.throws(() => prepareMemoryResponse(text, 'Summary', { prompt: '[SUMMARY]\n[Event]' }), { code: 'INVALID_MEMORY_RESPONSE' });
    }
});

test('translated and Markdown Summary headings recover only explicitly labelled plot', () => {
    const prompt = '[SUMMARY]\n[Event]';
    for (const text of [
        '## 楼层摘要\n标题：交信\n**剧情梗概：** 医师收下信件。\n### 未解决事项\n寄信人仍不明。',
        '[SUMMARY]\r[Title] 交信\r**[Event]:** 医师收下信件。\r[Open] 寄信人仍不明。',
        '### Summary\n__Title: 交信__\n### Event\n医师收下信件。\nOpen: 寄信人仍不明。',
    ]) {
        const record = parseFloorSummary(prepareMemoryResponse(text, 'Summary', { prompt }));
        assert.equal(record.title, '交信');
        assert.equal(record.event, '医师收下信件。');
        assert.equal(record.open, '寄信人仍不明。');
    }
    for (const text of ['医师收下信件。', '标题：交信', '剧情：暂无\n**状态增量：** []', '[Event]\n[STATE_RESOLUTIONS]\n[]',
        '### Event\n抱歉，我无法完成此请求。', '[Event]\n**暂无**']) {
        assert.throws(() => prepareMemoryResponse(text, 'Summary', { prompt }), { code: 'INVALID_MEMORY_RESPONSE' });
    }
    const narrative = '医师收下信件。\n时间：信上写着明天见。';
    assert.equal(parseFloorSummary(prepareMemoryResponse(`[SUMMARY]\n[Event]\n${narrative}`, 'Summary', { prompt })).event, narrative);
    assert.equal(prepareMemoryResponse('标题：交信\n剧情：医师收下信件。', 'Summary', { prompt: '输出两行纯文本' }), '标题：交信\n剧情：医师收下信件。');
});

test('a Summary format error changes the next prompt, preserving the source and retry budget', async () => {
    const f = fixture(), requests = [];
    f.summarizer.apiClient.complete = async request => {
        requests.push(request);
        if (requests.length === 1) throw Object.assign(new Error('HTTP 503'), { status: 503 });
        if (requests.length === 2) return { content: '[SUMMARY]\n[Title]\n只有标题' };
        assert.match(request.systemPrompt, /小总结输出格式重试.*\[Event\]/);
        return { content: summary };
    };
    const entry = getAssistantMessages(f.chat)[0];
    const record = await f.summarizer.summarizeMessage(entry.messageId, { deferAggregates: true });
    assert.equal(record.event, '信使把信交给医师，两人约定天亮前见面。');
    assert.equal(requests[0].systemPrompt, requests[1].systemPrompt);
    assert.ok(requests[2].systemPrompt.startsWith(requests[1].systemPrompt));
    assert.ok(requests.every(request => request.userContent === requests[0].userContent && request.maxTokens === requests[0].maxTokens));
    assert.deepEqual(f.waits, RETRY_DELAYS.slice(0, 2));
    assert.ok(f.statuses.some(([state, message]) => state === 'busy' && /第 1 层.*缺少可识别的剧情栏/.test(message)));
});

test('persistent format failures retain existing memory and point to the generation log', async () => {
    const f = fixture(); f.seedSummaries();
    const entry = getAssistantMessages(f.chat)[0], before = structuredClone(f.store.getSummary(entry.messageId));
    const requests = [];
    f.summarizer.apiClient.complete = async request => { requests.push(request); return { content: '[Event]\n无' }; };
    await assert.rejects(f.summarizer.summarizeMessage(entry.messageId, { overwrite: true, deferAggregates: true }), { code: 'INVALID_MEMORY_RESPONSE' });
    assert.deepEqual(f.store.getSummary(entry.messageId), before);
    assert.deepEqual(f.waits, RETRY_DELAYS);
    assert.equal(requests.length, 4);
    assert.ok(requests.slice(1).every(request => request.systemPrompt === requests[1].systemPrompt));
    assert.ok(f.statuses.some(([state, message]) => state === 'error' && /第 1 层.*占位词.*生成日志/.test(message)));
});

function screenshotFixture() {
    const f = fixture(153); f.seedSummaries();
    const entries = getAssistantMessages(f.chat);
    for (const floor of [107, 153]) delete f.store.current().summaries[entries[floor - 1].messageId];
    Object.assign(f.store.current().summaries[entries[149].messageId], { status: 'failed', frozen: false, event: '', error: '缺少有效剧情字段' });
    for (let start = 1; start <= 105; start += 5) f.store.addCheckpoint({ id: `cp-${start}`, startFloor: start, endFloor: start + 4, content: `原阶段${start}`, status: 'frozen' });
    for (const start of [1, 51]) f.store.addLongMemory({ id: `long-${start}`, startFloor: start, endFloor: start + 49, content: `原长期${start}`, status: 'frozen' });
    return f;
}

test('153-floor screenshot: automatic updates repair old holes then catch up all nine CPs and the missing Long', async () => {
    const f = screenshotFixture(), before = structuredClone(f.store.current());
    const latest = getAssistantMessages(f.chat).at(-1);
    await f.summarizer.summarizeMessage(latest.messageId, { expectedFingerprint: latest.fingerprint, recoverPending: true });
    assert.deepEqual(f.calls.filter(call => call.kind === 'Summary').map(call => Number(call.request.userContent.match(/^\[SUMMARY_SOURCE\]\n合成正文(\d+)/)[1])), [153, 107, 150]);
    assert.equal(f.calls.filter(call => call.kind === 'Checkpoint').length, 9);
    assert.equal(f.calls.filter(call => call.kind === 'Long').length, 1);
    assert.equal(f.store.current().checkpoints.length, 30); assert.equal(f.store.current().longMemories.length, 3);
    assert.deepEqual(f.summarizer.getMissingMemoryPlan().summaries, []);
    assert.deepEqual(f.store.current().checkpoints.slice(0, 21), before.checkpoints);
    assert.deepEqual(f.store.current().longMemories.slice(0, 2), before.longMemories);
    for (const row of Object.values(before.summaries).filter(row => row.status !== 'failed')) assert.deepEqual(f.store.getSummary(row.messageId), row);
    assert.equal(f.summarizer.aggregateDeferrals, 0);
});

test('a repeatedly invalid old floor never blocks the latest summary and is tried again on the next update', async () => {
    const f = screenshotFixture(), complete = f.summarizer.apiClient.complete;
    f.summarizer.apiClient.complete = async request => /^\[SUMMARY_SOURCE\]\n合成正文150(?:\n|$)/.test(request.userContent)
        ? (f.calls.push({ kind: 'bad', request }), { content: '[SUMMARY]\n[Title]\n缺少正文' }) : complete(request);
    await f.summarizer.summarizeLatest();
    assert.equal(f.calls.filter(call => call.kind === 'bad').length, 4);
    assert.equal(f.store.current().checkpoints.length, 29);
    assert.equal(f.store.getSummaryForEntry(getAssistantMessages(f.chat).at(-1)).status, 'frozen');
    assert.equal(f.store.current().longMemories.length, 2);
    assert.equal(f.summarizer.unsavedResponses.size, 0);
    assert.ok(f.statuses.some(([status, text]) => status === 'warning' && text.includes('下次自动更新')));
    f.chat.push({ mes: '合成正文154', gen_started: 'g154' });
    f.summarizer.apiClient.complete = complete;
    await f.summarizer.summarizeLatest();
    assert.equal(f.store.current().checkpoints.length, 30); assert.equal(f.store.current().longMemories.length, 3);
    assert.equal(f.summarizer.getMissingMemoryPlan().summaries.length, 0);
});

test('automatic recovery respects installation boundary and disabled automatic generation', async () => {
    const f = fixture(153);
    await f.summarizer.summarizeLatest();
    assert.equal(f.calls.length, 1); assert.equal(Object.keys(f.store.current().summaries).length, 1);
    f.chat.push({ mes: '合成正文154', gen_started: 'g154' });
    f.settings.autoSummarize = false;
    await f.summarizer.summarizeLatest(); assert.equal(f.calls.length, 1);
});

test('content retry stops before another request when cancelled, edited, or switched to a different chat revision', async () => {
    for (const action of ['cancel', 'edit', 'switch']) {
        const f = fixture(), controller = new AbortController(); let calls = 0;
        f.summarizer.apiClient.complete = async () => { calls++; return { content: '[SUMMARY]\n[Event]\n无' }; };
        f.summarizer.retryDelay = async () => {
            if (action === 'cancel') controller.abort();
            else if (action === 'edit') f.chat[0].mes = '修改后的正文';
            else f.summarizer.invalidateContext();
        };
        await assert.rejects(f.summarizer.summarizeMessage(getAssistantMessages(f.chat)[0].messageId, { signal: controller.signal }),
            { code: { cancel: 'REQUEST_ABORTED', edit: 'SOURCE_CHANGED', switch: 'CHAT_CHANGED' }[action] });
        assert.equal(calls, 1); assert.equal(Object.keys(f.store.current().summaries).length, 0);
        assert.equal(f.summarizer.unsavedResponses.size, 0);
    }
});

test('one-click completion continues after an invalid floor, leaving only dependent ranges pending', async () => {
    const f = fixture(10), complete = f.summarizer.apiClient.complete; let invalid = 0;
    f.summarizer.apiClient.complete = async request => /^\[SUMMARY_SOURCE\]\n合成正文1(?:\n|$)/.test(request.userContent)
        ? (invalid++, { content: '[SUMMARY]\n[Event]\n无' }) : complete(request);
    const result = await f.summarizer.fillMissingMemories();
    assert.equal(invalid, 4); assert.equal(result.failed, 1); assert.equal(result.created, 10);
    assert.equal(result.processed, result.total); assert.equal(result.skipped, 1);
    assert.deepEqual(f.store.current().checkpoints.map(row => [row.startFloor, row.endFloor]), [[6, 10]]);
    assert.equal(f.summarizer.aggregateDeferrals, 0);
});

test('save failures mentioning the network still stop one-click completion before downstream generation', async () => {
    const f = fixture(10);
    f.seedSummaries();
    f.summarizer.flushMemory = async () => ({ state: 'failed', detail: '网络断开，HTTP 503' });
    const result = await f.summarizer.fillMissingMemories();
    assert.equal(result.failed, 1); assert.match(result.errors[0], /保存/);
    assert.deepEqual(f.calls.map(call => call.kind), ['Checkpoint']);
});

test('automatic recovery stops on authentication or save failure without starting historical requests', async () => {
    for (const code of ['AUTH_FAILED', 'SAVE_UNCONFIRMED']) {
        const f = screenshotFixture();
        if (code === 'AUTH_FAILED') f.summarizer.apiClient.complete = async request => {
            f.calls.push({ request }); throw Object.assign(new Error('Unauthorized'), { code, category: 'authentication_error', status: 401 });
        };
        else f.summarizer.commitMemory = async () => { throw Object.assign(new Error('网络错误，保存未确认'), { code }); };
        await assert.rejects(f.summarizer.summarizeLatest(), { code });
        assert.equal(f.calls.length, 1); assert.equal(f.summarizer.aggregateDeferrals, 0);
    }
});
