import test from 'node:test';
import assert from 'node:assert/strict';
import { DEFAULT_PROMPTS, V1272_DEFAULT_PROMPTS, normalizeSettings, memoryGenerationSettings } from '../src/defaults.js';
import { generationPrompt } from '../src/generation-prompts.js';
import { MemoryStore } from '../src/memory-store.js';
import { MemorySummarizer } from '../src/summarizer.js';
import { getAssistantMessages } from '../src/utils.js';
import { currentInjectionBlocks } from '../src/injection.js';

const event = '登船前，商会信使交给旅人一个木匣，内有四枚刻着各人姓名的铜制通行牌，称由守桥人连夜打制。船夫检查背面编号，确认可在北岸码头使用；修桥工暂未领牌，将自己的份额托旅人转交妹妹。旅人发现地图上旧渡口被划去，船夫解释昨夜涨水后改走东岸，并要求众人在下一个桥洞前坐回舱内。途中旅人把新路线抄给医师，医师认出补画标记出自守桥人，追问消息来源；旅人答“是他亲口告诉我的”，并约定天亮后再确认回程时间。守卫在旁听见后提醒“回程还没定，别让码头先派车”，旅人答应先撤销订车。船到东岸时，修桥工取回药箱，说明其中一瓶药须避光保存，医师接过并放入内袋。';

test('upgrade changes only the saved official floor prompt; accepted CP/Long and customized Summary stay exact', () => {
    const config = normalizeSettings({ prompts: V1272_DEFAULT_PROMPTS });
    assert.notEqual(config.prompts.summary, V1272_DEFAULT_PROMPTS.summary);
    for (const key of ['checkpoint', 'longMemory', 'state']) assert.equal(config.prompts[key], V1272_DEFAULT_PROMPTS[key]);
    assert.equal(DEFAULT_PROMPTS.checkpoint, V1272_DEFAULT_PROMPTS.checkpoint);
    assert.equal(DEFAULT_PROMPTS.longMemory, V1272_DEFAULT_PROMPTS.longMemory);
    const customized = V1272_DEFAULT_PROMPTS.summary + '\n我的摘要要求';
    assert.equal(normalizeSettings({ prompts: { ...V1272_DEFAULT_PROMPTS, summary: customized } }).prompts.summary, customized);
    for (const mode of ['normal', 'advanced']) {
        const actual = memoryGenerationSettings(config, mode);
        assert.equal(actual.summaryMaxLength, 350); assert.equal(actual.checkpointMaxLength, 1000); assert.equal(actual.longMemoryMaxLength, 2200);
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
