import test from 'node:test';
import assert from 'node:assert/strict';
import { DEFAULT_PROMPTS, LEGACY_PROMPTS, INJECTION_MODES, normalizeSettings } from '../src/defaults.js';
import { collectKeepItems, formatLongFacts, parseFactUpdates, projectLongFacts, resolveKeepItems } from '../src/continuity.js';
import { MemoryStore, normalizeStore } from '../src/memory-store.js';
import { MemorySummarizer, parseFloorSummary } from '../src/summarizer.js';
import { buildInjection } from '../src/injection.js';
import { getAssistantMessages } from '../src/utils.js';

function fixture() {
    const metadata = {};
    const store = new MemoryStore({ getMetadata: () => metadata, getChatId: () => 'chat-a', saveMetadata: () => {} });
    return { metadata, store };
}

function addSummary(store, floor, text) {
    const raw = `[SUMMARY]\n[Title]\nS${floor}\n[Characters]\n姜梨/陆雾\n[Event]\n${text}\n[KEEP]\n- 姜梨答应十二月前陪陆雾回巴黎见外婆`;
    store.addSummary({ messageId: `m${floor}`, floor, title: `S${floor}`, characters: '姜梨/陆雾', event: text, raw, format: 'structured', status: 'frozen', frozen: true });
}

test('old stores and custom prompts survive migration while former default prompts gain incremental rules', () => {
    const old = { version: 1, summaries: { m: { raw: 'original', event: 'legacy' } }, checkpoints: [{ id: 'checkpoint-001', content: 'old state' }], longMemories: [{ id: 'long-001', content: 'old facts' }] };
    const snapshot = structuredClone(old);
    const migrated = normalizeStore(old, 'chat-a');
    assert.deepEqual(migrated.summaries, snapshot.summaries);
    assert.deepEqual(migrated.checkpoints, snapshot.checkpoints);
    assert.deepEqual(migrated.longMemories, snapshot.longMemories);
    assert.deepEqual(old, snapshot);
    const settings = normalizeSettings({ checkpointInterval: 20, summaryMaxLength: 350, prompts: { ...LEGACY_PROMPTS, summary: 'my custom prompt' } });
    assert.equal(settings.memoryStrategy, 'incremental');
    assert.equal(settings.prompts.summary, 'my custom prompt');
    assert.equal(settings.prompts.checkpoint, DEFAULT_PROMPTS.checkpoint);
    assert.equal(settings.checkpointInterval, 20);
    assert.equal(settings.summaryMaxLength, 350);
    assert.equal(normalizeSettings().checkpointInterval, 5);
    assert.equal(normalizeSettings().summaryMaxLength, 350);
    assert.equal(migrated.version, 4);
    assert.deepEqual(migrated.keepRegistry, {});
});

test('structured summaries preserve complete state, open threads and KEEP beyond the soft target', () => {
    const text = `模型自我修改\n[SUMMARY]\n[Event]\n旧稿\n\n[SUMMARY]\n[Title]\n重要承诺\n[Characters]\n姜梨/陆雾\n[Event]\n${'重要因果'.repeat(180)}\n[State]\n陆雾尚不知道邮件已被查看\n[Open]\n旅行尚未兑现\n[Quote]\n无\n[KEEP]\n- 姜梨答应十二月前陪陆雾回巴黎见外婆`;
    const parsed = parseFloorSummary(text, 350, { preserveFull: true });
    assert.match(parsed.raw, /^\[SUMMARY\]\n\[Title\]/);
    assert.doesNotMatch(parsed.raw, /旧稿|模型自我修改/);
    assert.doesNotMatch(parsed.event, /\[State\]|陆雾尚不知道/);
    assert.equal(parsed.state, '陆雾尚不知道邮件已被查看');
    assert.equal(parsed.open, '旅行尚未兑现');
    assert.match(parsed.keep, /十二月前/);
    assert.ok(parsed.raw.length > 350);
    assert.equal(parseFloorSummary('[SUMMARY]\n[StoryTime]\n无\n[Location]\n未知\n[Event]\n事件', 350).storyTime, '');
    assert.equal(parseFloorSummary('[SUMMARY]\n[StoryTime]\n无\n[Location]\n未知\n[Event]\n事件', 350).location, '');
});

test('Summary uses full-message metadata beside filtered content and rejects model-invented metadata', async () => {
    const { store } = fixture();
    const chat = [{ name: 'A', is_user: false, mes: '<context>剧情时间：2025/01/02 10:35｜地点：湖畔酒店</context><content>姜梨走进大堂。</content>', send_date: '1', gen_started: '1' }];
    let input = '';
    const summarizer = new MemorySummarizer({ store, getSettings: () => normalizeSettings(), getChat: () => chat, apiClient: {
        complete: async request => {
            input = request.userContent;
            return { content: '[SUMMARY]\n[Title]\n抵达\n[Characters]\n姜梨\n[StoryTime]\n明天\n[Location]\n火星\n[Event]\n姜梨走进大堂。\n[State]\n无\n[Open]\n无\n[Quote]\n无\n[KEEP]\n无' };
        },
    } });
    const record = await summarizer.summarizeEntry(getAssistantMessages(chat)[0]);
    assert.match(input, /\[SOURCE_METADATA\][\s\S]*2025\/01\/02 10:35[\s\S]*湖畔酒店/);
    assert.match(input, /\[SUMMARY_SOURCE\]\n姜梨走进大堂。/);
    assert.doesNotMatch(input, /<context>/);
    assert.equal(record.storyTime, '2025/01/02 10:35');
    assert.equal(record.location, '湖畔酒店');
    assert.match(record.raw, /\[StoryTime\]\n2025\/01\/02 10:35/);
    assert.doesNotMatch(record.raw, /明天|火星/);
});

test('Store v3 migrates every legacy KEEP into an independent registry without deriving Open entries', () => {
    const old = { version: 2, summaries: {
        a: { messageId: 'a', floor: 1, format: 'structured', status: 'frozen', raw: '[SUMMARY]\n[Event]\n当前事件\n[Open]\n未读消息\n[KEEP]\n无' },
        b: { messageId: 'b', floor: 2, format: 'structured', status: 'frozen', raw: '[SUMMARY]\n[Event]\n当前事件\n[Open]\n几小时后的集合\n[KEEP]\n1.  姜梨答应保守秘密' },
        c: { messageId: 'c', floor: 3, format: 'structured', status: 'frozen', raw: '[SUMMARY]\n[Event]\n当前事件\n[KEEP]\n- 姜梨答应保守秘密' },
    }, checkpoints: [{ id: 'checkpoint-001', endFloor: 3, status: 'frozen', keepItems: [
        { id: 'old-open-id', text: '未读消息', status: 'active' },
        { id: 'old-keep-id', text: '姜梨答应保守秘密', status: 'active' },
    ] }, { id: 'checkpoint-002', endFloor: 4, status: 'frozen', keepItems: [
        { id: 'old-keep-id', text: '姜梨答应保守秘密', status: 'resolved', reason: '秘密已公开', evidence: '姜梨公开了秘密' },
    ] }], longMemories: [] };
    const store = normalizeStore(old, 'chat-a');
    const keeps = collectKeepItems(store);
    assert.equal(keeps.length, 2);
    assert.deepEqual(keeps.map(item => item.id), ['KEEP-0001', 'KEEP-0002']);
    assert.ok(keeps.some(item => item.text === '姜梨答应保守秘密'));
    assert.ok(keeps.some(item => item.text === '未读消息'));
    assert.equal(keeps.find(item => item.text === '姜梨答应保守秘密').status, 'resolved');
    assert.doesNotMatch(JSON.stringify(keeps), /几小时后的集合/);
});

test('registry KEEP ids survive edits and Summary deletion; deterministic cleanup only invalidates exact duplicates', () => {
    const { store } = fixture();
    addSummary(store, 1, '产生长期约定');
    const first = collectKeepItems(store.current())[0];
    assert.equal(first.id, 'KEEP-0001');
    store.updateKeep(first.id, { text: '姜梨仍答应十二月前陪陆雾回巴黎见外婆' });
    store.deleteSummary('m1');
    assert.equal(collectKeepItems(store.current())[0].id, first.id);
    assert.match(collectKeepItems(store.current())[0].text, /仍答应/);
    const registry = store.current().keepRegistry;
    registry['KEEP-0002'] = { ...registry[first.id], text: '  1. 姜梨仍答应十二月前陪陆雾回巴黎见外婆  ', status: 'active' };
    const result = store.organizeKeepRegistry();
    assert.equal(result.duplicates, 1);
    assert.equal(store.current().keepRegistry['KEEP-0002'].status, 'invalid');
    assert.equal(store.current().keepRegistry['KEEP-0002'].replacedBy, first.id);
});

test('saved structured raw can be reparsed locally without replacing record identity', () => {
    const { store } = fixture();
    store.addSummary({ messageId: 'm1', floor: 1, status: 'frozen', format: 'structured', event: '[Event]\n旧错误\n[State]\n旧状态',
        raw: '[SUMMARY]\n[Event]\n草稿\n\n[SUMMARY]\n[Title]\n最终\n[Characters]\n姜梨\n[Event]\n最终事件\n[State]\n最终状态\n[Open]\n无\n[Quote]\n无\n[KEEP]\n无' });
    const count = store.reparseStructuredSummaries(raw => parseFloorSummary(raw, 500, { preserveFull: true }));
    const record = store.getSummary('m1');
    assert.equal(count, 1);
    assert.equal(record.messageId, 'm1');
    assert.equal(record.event, '最终事件');
    assert.equal(record.state, '最终状态');
    assert.doesNotMatch(record.raw, /草稿/);
});

test('incremental checkpoints carry prior state and KEEP; fact extraction appends deltas without rewriting legacy records', async () => {
    const { store } = fixture();
    store.addCheckpoint({ id: 'checkpoint-001', startFloor: 1, endFloor: 20, content: '历史人物认知差', status: 'frozen', frozen: true });
    store.addLongMemory({ id: 'long-001', startFloor: 1, endFloor: 20, content: '重要旅行争执历史', status: 'frozen', frozen: true });
    const old = structuredClone(store.current());
    for (let floor = 21; floor <= 24; floor += 1) addSummary(store, floor, `本阶段第${floor}层明确发生的事件`);
    const inputs = [];
    let factCalls = 0;
    const summarizer = new MemorySummarizer({ store, getSettings: () => normalizeSettings({ checkpointInterval: 2, longMemoryInterval: 2, checkpointMaxLength: 100 }), getChat: () => [], apiClient: {
        complete: async request => {
            inputs.push(request.userContent);
            if (request.userContent.startsWith('[EXISTING_LONG_FACTS]')) {
                factCalls += 1;
                return { content: factCalls === 1 ? '[LONG_MEMORY]\n- 【姜梨/陆雾｜约定】姜梨答应十二月前陪陆雾回巴黎见外婆\n[UPDATED_FACTS]\n无\n[RETIRED_FACTS]\n无' : '[LONG_MEMORY]\n无\n[UPDATED_FACTS]\n无\n[RETIRED_FACTS]\n无' };
            }
            return { content: `[CHECKPOINT]\n[Current State]\n${'人物当前状态'.repeat(100)}` };
        },
    } });
    const first = await summarizer.generateCheckpoint(21, 22);
    await summarizer.generateDueLongMemories();
    const firstSnapshot = structuredClone(first);
    const second = await summarizer.generateCheckpoint(23, 24);
    await summarizer.generateDueLongMemories();
    const memory = store.current();
    assert.match(inputs[0], /重要旅行争执历史/);
    assert.match(inputs[2], /人物当前状态/);
    assert.equal(second.previousCheckpointId, first.id);
    assert.ok(first.content.length > 100);
    assert.equal('keepItems' in second, false);
    assert.ok(collectKeepItems(memory).filter(item => item.status === 'active').length >= 1);
    assert.deepEqual(memory.checkpoints[0], old.checkpoints[0]);
    assert.deepEqual(memory.longMemories[0], old.longMemories[0]);
    assert.deepEqual(memory.checkpoints[1], firstSnapshot);
    const projection = projectLongFacts(memory);
    assert.equal(projection.facts.filter(item => item.status === 'active').length, 1);
    assert.match(formatLongFacts(projection), /重要旅行争执历史/);
    await summarizer.generateDueLongMemories();
    assert.equal(factCalls, 2);
});

test('KEEP omission and unsupported resolutions never drop items; explicit evidence resolves without deleting history', () => {
    const items = [{ id: 'keep-1', text: '十二月前见外婆', status: 'active' }];
    assert.deepEqual(resolveKeepItems(items, '[CHECKPOINT]\n无', '没有提到承诺'), items);
    assert.deepEqual(resolveKeepItems(items, '[RESOLVED_KEEP]\n- keep-1 | 已兑现 | 凭空捏造证据', '没有提到承诺'), items);
    const resolved = resolveKeepItems(items, '[RESOLVED_KEEP]\n- keep-1 | 已兑现 | 姜梨陪陆雾见到了外婆', '姜梨陪陆雾见到了外婆，约定已兑现。');
    assert.equal(resolved[0].status, 'resolved');
    assert.equal(resolved[0].text, items[0].text);
    assert.equal(items[0].status, 'active');
    const superseded = resolveKeepItems(items, '[SUPERSEDED_KEEP]\n- KEEP-1 | 被新约定替代 | 姜梨改为明年去巴黎', '姜梨改为明年去巴黎，并取消旧日期。');
    assert.equal(superseded[0].status, 'superseded');
    assert.equal(resolveKeepItems(items, '[INVALID_KEEP]\n- keep-1 | 模型说无效 | 姜梨改为明年去巴黎', '姜梨改为明年去巴黎')[0].status, 'active');
});

test('Checkpoint lifecycle deltas update the registry and are stripped from saved state', async () => {
    const { store } = fixture();
    const records = [
        { id: 'm1', floor: 1, event: '姜梨公开了秘密', keep: '- 姜梨一直隐瞒信件内容' },
        { id: 'm2', floor: 2, event: '陆雾改为明年去巴黎', keep: '- 陆雾原计划今年去巴黎' },
    ];
    for (const item of records) store.addSummary({ messageId: item.id, floor: item.floor, title: `S${item.floor}`, characters: '姜梨/陆雾', event: item.event,
        keep: item.keep, raw: `[SUMMARY]\n[Title]\nS${item.floor}\n[Characters]\n姜梨/陆雾\n[Event]\n${item.event}\n[KEEP]\n${item.keep}`, format: 'structured', status: 'frozen', frozen: true });
    const keeps = collectKeepItems(store.current());
    const summarizer = new MemorySummarizer({ store, getSettings: () => normalizeSettings({ checkpointInterval: 2 }), getChat: () => [], apiClient: {
        complete: async () => ({ content: `[CHECKPOINT]\n[Current State]\n已更新\n[RESOLVED_KEEP]\n- ${keeps[0].id} | 秘密已公开 | 姜梨公开了秘密\n[SUPERSEDED_KEEP]\n- ${keeps[1].id} | 改为明年 | 陆雾改为明年去巴黎` }),
    } });
    const checkpoint = await summarizer.generateCheckpoint(1, 2);
    assert.doesNotMatch(checkpoint.content, /RESOLVED_KEEP|SUPERSEDED_KEEP/);
    assert.deepEqual(collectKeepItems(store.current()).map(item => item.status), ['resolved', 'superseded']);
});

test('story metadata flows from summaries into checkpoints, long memories and KEEP lifecycle without inference', async () => {
    const { store } = fixture();
    const records = [
        { id: 'm1', floor: 1, storyTime: '2025/01/02 09:16', location: '湖畔酒店', event: '姜梨答应保守秘密', keep: '- 姜梨答应保守秘密' },
        { id: 'm2', floor: 2, storyTime: '', location: '', event: '普通过场', keep: '无' },
        { id: 'm3', floor: 3, storyTime: '2025/01/02 12:24', location: '酒店露台', event: '姜梨公开了秘密', keep: '无' },
    ];
    for (const item of records) store.addSummary({ messageId: item.id, floor: item.floor, title: `S${item.floor}`, characters: '姜梨',
        storyTime: item.storyTime, location: item.location, event: item.event, keep: item.keep,
        raw: `[SUMMARY]\n[Title]\nS${item.floor}\n[Characters]\n姜梨\n[StoryTime]\n${item.storyTime || '无'}\n[Location]\n${item.location || '无'}\n[Event]\n${item.event}\n[KEEP]\n${item.keep}`,
        format: 'structured', status: 'frozen', frozen: true });
    const keep = collectKeepItems(store.current())[0];
    assert.equal(keep.sourceStoryTime, '2025/01/02 09:16');
    assert.equal(keep.sourceLocation, '湖畔酒店');

    const summarizer = new MemorySummarizer({ store, getSettings: () => normalizeSettings({ checkpointInterval: 3, longMemoryInterval: 3 }), getChat: () => [], apiClient: {
        complete: async ({ userContent }) => ({ content: userContent.startsWith('[EXISTING_LONG_FACTS]')
            ? '[LONG_MEMORY]\n- 【姜梨｜秘密】姜梨曾公开秘密\n[UPDATED_FACTS]\n无\n[RETIRED_FACTS]\n无'
            : `[CHECKPOINT]\n[Current State]\n已公开\n[RESOLVED_KEEP]\n- ${keep.id} | 秘密已公开 | 姜梨公开了秘密` }),
    } });
    const checkpoint = await summarizer.generateCheckpoint(1, 3);
    assert.deepEqual({ storyStartTime: checkpoint.storyStartTime, storyEndTime: checkpoint.storyEndTime,
        currentStoryTime: checkpoint.currentStoryTime, currentLocation: checkpoint.currentLocation }, {
        storyStartTime: '2025/01/02 09:16', storyEndTime: '2025/01/02 12:24',
        currentStoryTime: '2025/01/02 12:24', currentLocation: '酒店露台',
    });
    assert.equal(collectKeepItems(store.current())[0].resolvedStoryTime, '2025/01/02 12:24');
    await summarizer.generateDueLongMemories();
    const long = store.current().longMemories[0];
    assert.equal(long.storyStartTime, '2025/01/02 09:16');
    assert.equal(long.storyEndTime, '2025/01/02 12:24');
});

test('fact replacements require exact new-summary evidence and retain the old fact in the immutable ledger', () => {
    const projection = { legacy: [], facts: [{ id: 'fact-old', text: '陆雾不知道邮件被查看', status: 'active' }] };
    const output = '[LONG_MEMORY]\n无\n[UPDATED_FACTS]\n- fact-old | 陆雾已知姜梨看过邮件；此前隐瞒引发争执 | 姜梨向陆雾坦白看过邮件';
    assert.deepEqual(parseFactUpdates(output, projection, '本层在吃饭'), []);
    const updates = parseFactUpdates(output, projection, '姜梨向陆雾坦白看过邮件，陆雾已知情。');
    const store = { longMemories: [
        { id: 'long-001', memoryKind: 'facts', endFloor: 10, factUpdates: [{ id: 'fact-old', action: 'add', text: projection.facts[0].text }] },
        { id: 'long-002', memoryKind: 'facts', endFloor: 20, factUpdates: updates },
    ] };
    const snapshot = structuredClone(store);
    const facts = projectLongFacts(store).facts;
    assert.equal(facts.find(item => item.id === 'fact-old').status, 'superseded');
    assert.match(facts.find(item => item.status === 'active').text, /此前隐瞒引发争执/);
    assert.deepEqual(store, snapshot);
});

test('non-strict incremental injection combines active facts, KEEP, latest state and every subsequent summary deterministically', () => {
    const { store } = fixture();
    addSummary(store, 1, '旧事件');
    const keeps = collectKeepItems(store.current());
    store.addCheckpoint({ id: 'checkpoint-001', startFloor: 1, endFloor: 10, content: 'older state', memoryKind: 'state', keepItems: keeps, status: 'frozen', frozen: true });
    store.addCheckpoint({ id: 'checkpoint-002', startFloor: 11, endFloor: 20, content: 'latest state', memoryKind: 'state', keepItems: keeps, status: 'frozen', frozen: true });
    store.addLongMemory({ id: 'long-001', startFloor: 1, endFloor: 10, memoryKind: 'facts', factUpdates: [{ id: 'fact-1', action: 'add', text: '长期有效的重要事实' }], status: 'frozen', frozen: true });
    addSummary(store, 21, '最近第一件事');
    addSummary(store, 22, '最近第二件事');
    const settings = normalizeSettings({ strictCacheMode: false, injectionMode: INJECTION_MODES.LONG_CHECKPOINT_RECENT, recentSummaryCount: 1, recentCheckpointCount: 0 });
    const output = buildInjection(store.current(), settings);
    assert.equal(output, buildInjection(store.current(), settings));
    assert.match(output, /长期有效的重要事实/);
    assert.match(output, /十二月前/);
    assert.equal(output.match(/\[KEEP\]/g)?.length, 1);
    assert.match(output, /latest state/);
    assert.match(output, /最近第一件事/);
    assert.match(output, /最近第二件事/);
    assert.doesNotMatch(output, /older state|旧事件/);
    assert.equal(buildInjection(store.current(), { ...settings, injectionMode: INJECTION_MODES.NONE }), '');
});

test('manual fact edits rebuild the visible projection and evidence-based retirement keeps history', () => {
    const { store } = fixture();
    store.addLongMemory({ id: 'long-001', startFloor: 1, endFloor: 10, memoryKind: 'facts', content: '[LONG_MEMORY]\n- 陆雾尚欠江珩一笔债务', factUpdates: [{ id: 'fact-debt', action: 'add', text: '陆雾尚欠江珩一笔债务' }], status: 'frozen', frozen: true });
    store.updateAggregate('long', 'long-001', { content: '[LONG_MEMORY]\n- 陆雾尚欠江珩两笔债务', manualEdited: true });
    const projected = projectLongFacts(store.current());
    assert.match(formatLongFacts(projected), /两笔债务/);
    assert.doesNotMatch(formatLongFacts(projected), /一笔债务/);
    const fact = projected.facts[0];
    const updates = parseFactUpdates(`[LONG_MEMORY]\n无\n[RETIRED_FACTS]\n- ${fact.id} | 债务已结清且无后续责任 | 陆雾结清了全部债务`, projected, '陆雾结清了全部债务，江珩确认没有剩余责任。');
    store.addLongMemory({ id: 'long-002', startFloor: 11, endFloor: 20, memoryKind: 'facts', factUpdates: updates, status: 'frozen', frozen: true });
    assert.equal(projectLongFacts(store.current()).facts[0].status, 'retired');
    assert.equal(store.current().longMemories[0].factUpdates[0].text, '陆雾尚欠江珩两笔债务');
});

test('non-strict KEEP and new summaries are available before the first checkpoint without a recent-count gap', () => {
    const { store } = fixture();
    addSummary(store, 1, '刚刚作出的约定');
    addSummary(store, 2, '最新发生的事情');
    const output = buildInjection(store.current(), normalizeSettings({ strictCacheMode: false, injectionMode: INJECTION_MODES.LONG_CHECKPOINT_RECENT, recentSummaryCount: 0 }));
    assert.match(output, /\[KEEP\]/);
    assert.match(output, /刚刚作出的约定/);
    assert.match(output, /最新发生的事情/);
});

test('truncated model output does not replace an existing frozen summary and failed checkpoints can retry', async () => {
    const { store } = fixture();
    const chat = [{ is_user: true, mes: 'u' }, { name: 'A', mes: '正文', send_date: '1', gen_started: '1', is_user: false }];
    const entry = getAssistantMessages(chat)[0];
    store.addSummary({ ...entry, title: 'original', event: '完整内容', frozen: true, status: 'frozen' });
    const summarizer = new MemorySummarizer({ store, getSettings: () => normalizeSettings({ checkpointInterval: 1 }), getChat: () => chat,
        apiClient: { complete: async () => ({ content: 'partial', finishReason: 'length' }) } });
    await assert.rejects(summarizer.summarizeEntry(entry, { overwrite: true }), /token 上限/);
    assert.equal(store.getSummary(entry.messageId).title, 'original');
    await assert.rejects(summarizer.generateCheckpoint(1, 1), /token 上限/);
    assert.deepEqual(summarizer.getNextCheckpointRange(), { startFloor: 1, endFloor: 1 });
    summarizer.apiClient.complete = async () => ({ content: '[CHECKPOINT]\ncomplete' });
    await summarizer.generateCheckpoint(1, 1);
    assert.equal(store.current().checkpoints.length, 1);
    assert.equal(store.current().checkpoints[0].status, 'frozen');
});

test('automatic incremental stages feed new facts into the next state and never modify chat bodies', async () => {
    const { store } = fixture();
    const chat = Array.from({ length: 4 }, (_, index) => ({ name: 'A', is_user: false, mes: `正文${index}`, send_date: String(index), gen_started: String(index) }));
    const bodies = chat.map(item => item.mes);
    const stateInputs = [];
    let factCalls = 0;
    const summarizer = new MemorySummarizer({ store, getSettings: () => normalizeSettings({ checkpointInterval: 2, longMemoryInterval: 2 }), getChat: () => chat,
        apiClient: { complete: async ({ userContent }) => {
            if (userContent.startsWith('正文')) return { content: `[SUMMARY]\n[Event]\n${userContent}\n[KEEP]\n- 姜梨答应十二月前陪陆雾回巴黎见外婆` };
            if (userContent.startsWith('[EXISTING_LONG_FACTS]')) {
                factCalls += 1;
                return { content: factCalls === 1 ? '[LONG_MEMORY]\n- 【姜梨/陆雾｜约定】十二月前去巴黎' : '[LONG_MEMORY]\n无' };
            }
            stateInputs.push(userContent);
            return { content: '[CHECKPOINT]\n当前状态' };
        } } });
    for (const entry of getAssistantMessages(chat)) await summarizer.summarizeEntry(entry);
    assert.equal(store.current().checkpoints.length, 2);
    assert.equal(factCalls, 2);
    assert.match(stateInputs[1], /【姜梨\/陆雾｜约定】十二月前去巴黎/);
    assert.deepEqual(chat.map(item => item.mes), bodies);
});

test('KEEP and stable facts survive 100 incremental checkpoints through floor 1000 even when the model omits them', async () => {
    const { store } = fixture();
    addSummary(store, 1, '第一层约定');
    const summaries = store.current().summaries;
    for (let floor = 2; floor <= 1000; floor += 1) summaries[`m${floor}`] = {
        messageId: `m${floor}`, floor, title: `S${floor}`, event: '普通场景变化', status: 'frozen', frozen: true,
    };
    store.addLongMemory({ id: 'long-001', startFloor: 0, endFloor: 0, memoryKind: 'facts', factUpdates: [{ id: 'fact-stable', action: 'add', text: '陆雾不知道姜梨看过那封邮件' }], status: 'frozen', frozen: true });
    const summarizer = new MemorySummarizer({ store, getSettings: () => normalizeSettings(), getChat: () => [], apiClient: {
        complete: async ({ userContent }) => ({ content: userContent.startsWith('[EXISTING_LONG_FACTS]') ? '[LONG_MEMORY]\n无' : '[CHECKPOINT]\n当前普通场景状态' }),
    } });
    for (let end = 10; end <= 1000; end += 10) {
        await summarizer.generateCheckpoint(end - 9, end);
        await summarizer.generateDueLongMemories();
    }
    const memory = store.current();
    assert.equal(memory.checkpoints.length, 100);
    assert.equal(memory.checkpoints.at(-1).endFloor, 1000);
    assert.equal(projectLongFacts(memory).facts.filter(item => item.status === 'active').length, 1);
    assert.equal(collectKeepItems(memory).filter(item => item.status === 'active').length, 1);
    const output = buildInjection(memory, normalizeSettings({ strictCacheMode: false, injectionMode: INJECTION_MODES.LONG_CHECKPOINT_RECENT }));
    assert.match(output, /陆雾不知道姜梨看过那封邮件/);
    assert.match(output, /十二月前陪陆雾回巴黎见外婆/);
    assert.match(output, /截至第1000层/);
});
