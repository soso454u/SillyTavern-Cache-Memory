import test from 'node:test';
import assert from 'node:assert/strict';
import { DEFAULT_PROMPTS, V1272_DEFAULT_PROMPTS, V1273_DEFAULT_PROMPTS, V12710_DEFAULT_PROMPTS, LAYERED_MEMORY_RULES, LONG_MEMORY_EVENT_REVIEW, normalizeSettings, memoryGenerationSettings } from '../src/defaults.js';
import { generationPrompt } from '../src/generation-prompts.js';
import { MemoryStore } from '../src/memory-store.js';
import { MemorySummarizer } from '../src/summarizer.js';
import { getAssistantMessages } from '../src/utils.js';
import { currentInjectionBlocks } from '../src/injection.js';

const event = '登船前，商会信使交给旅人一个木匣，内有四枚刻着各人姓名的铜制通行牌，称由守桥人连夜打制。船夫检查背面编号，确认可在北岸码头使用；修桥工暂未领牌，将自己的份额托旅人转交妹妹。旅人发现地图上旧渡口被划去，船夫解释昨夜涨水后改走东岸，并要求众人在下一个桥洞前坐回舱内。途中旅人把新路线抄给医师，医师认出补画标记出自守桥人，追问消息来源；旅人答“是他亲口告诉我的”，并约定天亮后再确认回程时间。守卫在旁听见后提醒“回程还没定，别让码头先派车”，旅人答应先撤销订车。船到东岸时，修桥工取回药箱，说明其中一瓶药须避光保存，医师接过并放入内袋。';

test('official narrative templates upgrade by stage while custom prompts and budgets remain exact', () => {
    for (const previous of [V1272_DEFAULT_PROMPTS, V1273_DEFAULT_PROMPTS, V12710_DEFAULT_PROMPTS]) {
        const config = normalizeSettings({ prompts: previous });
        assert.deepEqual(config.prompts, DEFAULT_PROMPTS);
        assert.equal(config.prompts.state, previous.state);
        for (const mode of ['normal', 'advanced']) {
            const actual = memoryGenerationSettings(config, mode);
            assert.deepEqual([actual.summaryMaxLength, actual.checkpointMaxLength, actual.longMemoryMaxLength], [350, 1000, 2200]);
            assert.deepEqual([actual.summaryMaxTokens, actual.checkpointMaxTokens, actual.longMemoryMaxTokens], [1024, 3072, 4096]);
        }
        for (const stage of ['summary', 'checkpoint', 'longMemory']) {
            const custom = previous[stage] + '\n我的专属要求';
            const config = normalizeSettings({ prompts: { ...previous, [stage]: custom }, summaryMaxLength: 270, checkpointMaxLength: 850,
                longMemoryMaxLength: 1900, summaryMaxTokens: 1200, checkpointMaxTokens: 3500, longMemoryMaxTokens: 5200 });
            for (const mode of ['normal', 'advanced']) {
                const actual = memoryGenerationSettings(config, mode);
                assert.equal(actual.prompts[stage], custom);
                for (const other of ['summary', 'checkpoint', 'longMemory'].filter(key => key !== stage)) assert.equal(actual.prompts[other], DEFAULT_PROMPTS[other]);
                assert.deepEqual([actual.summaryMaxLength, actual.checkpointMaxLength, actual.longMemoryMaxLength], [270, 850, 1900]);
                assert.deepEqual([actual.summaryMaxTokens, actual.checkpointMaxTokens, actual.longMemoryMaxTokens], [1200, 3500, 5200]);
            }
        }
    }
    for (const stage of ['summary', 'checkpoint', 'state']) assert.equal(DEFAULT_PROMPTS[stage], V12710_DEFAULT_PROMPTS[stage]);
    assert.equal(DEFAULT_PROMPTS.longMemory.replace(LONG_MEMORY_EVENT_REVIEW + '\n', ''), V12710_DEFAULT_PROMPTS.longMemory);
    // The migration snapshots must remain the versions users actually saved.
    assert.equal(V1273_DEFAULT_PROMPTS.checkpoint, V1272_DEFAULT_PROMPTS.checkpoint);
    assert.equal(V1273_DEFAULT_PROMPTS.longMemory, V1272_DEFAULT_PROMPTS.longMemory);
    assert.ok(!V1273_DEFAULT_PROMPTS.summary.includes(LAYERED_MEMORY_RULES.summary));
});

test('both modes send distinct compression roles without applying Long selection to a floor summary', () => {
    for (const mode of ['normal', 'advanced']) {
        const config = memoryGenerationSettings(normalizeSettings({ globalPromptMode: 'blank' }), mode);
        for (const stage of ['summary', 'checkpoint', 'longMemory']) {
            const prompt = generationPrompt(config, stage);
            assert.ok(prompt.includes(LAYERED_MEMORY_RULES[stage]));
            assert.equal(prompt.includes(LONG_MEMORY_EVENT_REVIEW), stage === 'longMemory');
            for (const other of ['summary', 'checkpoint', 'longMemory'].filter(key => key !== stage)) assert.ok(!prompt.includes(LAYERED_MEMORY_RULES[other]));
        }
        assert.match(config.prompts.summary, /不提前按长期价值筛掉日常互动/);
        assert.match(config.prompts.checkpoint, /最终约定或结果/);
        assert.match(config.prompts.checkpoint, /对象、期限、条件、例外和知情范围/);
        assert.match(config.prompts.longMemory, /不能把两者都写成仍有效/);
        assert.match(config.prompts.longMemory, /同一事实只出现一次/);
        assert.match(config.prompts.longMemory, /从前期到末段/);
    }
});

test('actual Summary contract permits multiple meaningful events, useful interaction details and contextual short quotes', () => {
    const config = memoryGenerationSettings(normalizeSettings({ globalPromptMode: 'blank' }));
    const prompt = generationPrompt(config, 'summary');
    assert.match(prompt, /一段连贯叙述/);
    assert.match(prompt, /本层存在多项有意义的事件时都应照顾/);
    assert.match(prompt, /信息是谁告诉谁/); assert.match(prompt, /物品的来源／去向/);
    assert.match(prompt, /通常选1–3个短句/);
    assert.match(prompt, /没有某类信息就不写/);
    assert.doesNotMatch(prompt, /通常只写一个关键事件|每条以1–3句|通常0–1句|合计尽量不超过40字/);
    assert.match(prompt, /不能自动当作事实/); assert.match(prompt, /不设最低字数/);
});

test('a rich single-floor narrative is saved and projected whole with both quotes and its final sub-event, in one existing call', async () => {
    assert.ok(event.length >= 250 && event.length <= 400);
    const config = normalizeSettings({ globalPromptMode: 'blank' }), metadata = {}, requests = [];
    const chat = [{ name: '旅人', mes: event, gen_started: 'synthetic-trip' }], original = structuredClone(chat);
    const store = new MemoryStore({ getMetadata: () => metadata, getChatId: () => 'single-floor-narrative', saveMetadata() {} });
    const response = `[SUMMARY]\n[Title]\n通行牌与改道\n[Characters]\n旅人、船夫、修桥工、医师、守卫\n[StoryTime]\n无\n[Location]\n无\n[Event]\n${event}`;
    const summarizer = new MemorySummarizer({ store, getSettings: () => config, getChat: () => chat,
        apiClient: { complete: async request => { requests.push(request); return { content: response }; } } });
    await summarizer.summarizeEntry(getAssistantMessages(chat)[0]);
    assert.equal(requests.length, 1); assert.equal(requests[0].maxTokens, 1024);
    assert.match(requests[0].systemPrompt, /一段连贯叙述/);
    const data = store.current(), record = Object.values(data.summaries)[0];
    assert.equal(record.event, event); assert.equal(record.quote, '');
    assert.equal(data.checkpoints.length, 0); assert.equal(data.longMemories.length, 0);
    const text = currentInjectionBlocks(data, { ...config, injectionFloor: 4 }).find(row => row.type === 'summary-story').text;
    for (const detail of ['托旅人转交妹妹', '涨水后改走东岸', '是他亲口告诉我的', '回程还没定，别让码头先派车', '医师接过并放入内袋']) assert.ok(text.includes(detail));
    assert.deepEqual(chat, original);
});

test('new prompt migration and later generation preserve previously frozen detailed memories', async () => {
    const config = normalizeSettings({ prompts: V1273_DEFAULT_PROMPTS, globalPromptMode: 'blank' });
    const metadata = {}, requests = [];
    const chat = Array.from({ length: 6 }, (_, i) => ({ name: '旅人', mes: `第${i + 1}次渡河记录`, gen_started: `trip-${i}` }));
    const entries = getAssistantMessages(chat);
    const store = new MemoryStore({ getMetadata: () => metadata, getChatId: () => 'layered-upgrade', saveMetadata() {} });
    for (const entry of entries.slice(0, 5)) store.addSummary({ messageId: entry.messageId, floor: entry.floor,
        event: '旧的详细剧情和双方回应。'.repeat(45), sourceContentFingerprint: entry.contentFingerprint, status: 'frozen', frozen: true });
    store.addCheckpoint({ id: 'cp-1', startFloor: 1, endFloor: 5, content: '[CHECKPOINT]\n[Stage Story]\n' + '旧阶段的完整经过。'.repeat(150), status: 'frozen', frozen: true });
    store.addLongMemory({ id: 'long-1', startFloor: 1, endFloor: 5, content: '[STORY_ARC]\n' + '旧大总结的重要原话与条件。'.repeat(200), status: 'frozen', frozen: true });
    const previous = structuredClone(store.current());
    const summarizer = new MemorySummarizer({ store, getSettings: () => config, getChat: () => chat,
        apiClient: { complete: async request => { requests.push(request); return { content: '[SUMMARY]\n[Title]\n新渡河记录\n[Characters]\n旅人\n[Event]\n旅人完成第六次渡河。' }; } } });
    await summarizer.summarizeEntry(entries[5], { deferAggregates: true });
    assert.equal(requests.length, 1);
    assert.ok(requests[0].systemPrompt.includes(LAYERED_MEMORY_RULES.summary));
    for (const [id, record] of Object.entries(previous.summaries)) assert.deepEqual(store.current().summaries[id], record);
    assert.deepEqual(store.current().checkpoints, previous.checkpoints);
    assert.deepEqual(store.current().longMemories, previous.longMemories);
    assert.equal(Object.keys(store.current().summaries).length, 6);
});
