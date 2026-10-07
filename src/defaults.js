export const MODULE_ID = 'cache_memory';
export const METADATA_KEY = 'cache_memory';
export const INJECTION_KEY = 'cache_memory_injection';
export const API_KEY_STORAGE_KEY = 'cache_memory_api_key_v1';
export const DOUBAO_CODING_BASE_URL = 'https://ark.cn-beijing.volces.com/api/coding/v3';

export const API_PROVIDERS = Object.freeze({
    OPENAI_COMPATIBLE: 'openai-compatible',
    DOUBAO_CODING: 'doubao-coding',
});

// 方舟 Coding Plan 的模型列表接口并非在所有套餐中都可用。这里保留官方
// 推荐的稳定别名和当前文档列出的模型，远端获取失败时仍可直接选择。
export const DOUBAO_CODING_MODELS = Object.freeze([
    'ark-code-latest',
    'doubao-seed-2.1-pro',
    'doubao-seed-2.1-lite',
    'doubao-seed-2.0-mini',
    'doubao-seed-evolving',
    'glm-5.3',
    'glm-5.3-flash',
    'kimi-k3',
    'kimi-k2.8-preview',
    'deepseek-v4.1-flash',
    'deepseek-v4-flash',
    'deepseek-v4-pro',
]);

export const INJECTION_MODES = Object.freeze({
    NONE: 'none',
    LONG: 'long',
    LONG_CHECKPOINT: 'long_checkpoint',
    LONG_CHECKPOINT_RECENT: 'long_checkpoint_recent',
});

export const DEFAULT_PROMPTS = Object.freeze({
    summary: `你是剧情记忆压缩器。

请仅总结下面提供的这一条最新剧情正文。

要求：
- 总长度不超过 {{maxLength}} 个中文字符。
- 只记录当前正文明确出现的信息。
- 禁止使用此前剧情补全本段。
- 禁止推断人物隐藏想法。
- 禁止定义关系结果。
- 禁止判断谁输谁赢、谁对谁错。
- 优先保留：人物、时间、地点、重要物品、动作、约定、决定、伤势、状态变化。
- 保留最多一句重要原话。
- 接近字数上限时主动压缩。
- 如果正文没有提供具体时间或地点，请明确写“本段正文未提供具体时间/地点”。

严格输出：

<title>摘要标题</title>
<characters>本段实际出现的人物</characters>
<event>时间、地点 → 场景 → 关键动作 → 一句核心原话 → 本段结束时的客观状态</event>

正文由下一条 user 消息提供。`,
    checkpoint: `你是剧情阶段记忆压缩器。

只根据下一条 user 消息中给出的楼层小总结，生成第 {{startFloor}}-{{endFloor}} 层阶段总结。不得读取、补写或推断原始正文之外的信息。总长度不超过 {{maxLength}} 个中文字符。

严格使用以下结构：
[Range]
第{{startFloor}}-{{endFloor}}层

[Characters]
重要人物及本阶段客观状态变化

[Events]
按剧情顺序压缩的重要事件

[Important Facts]
重要约定 / 物品 / 信息 / 决定 / 状态变化

[Open Threads]
本阶段结束时仍未解决、但摘要明确存在的事情

禁止推测未来、定义感情结果、写隐藏心理、判断输赢或补写未发生的事情。`,
    longMemory: `你是长期剧情记忆压缩器。

只根据下一条 user 消息中给出的冻结 Checkpoint，生成覆盖第 {{startFloor}}-{{endFloor}} 层的长期记忆。不得重新解释原始正文，不得添加 Checkpoint 中不存在的信息。总长度不超过 {{maxLength}} 个中文字符。

按时间顺序保留：重要人物的客观变化、关键事件、约定、物品、信息、决定、伤势、状态以及仍未解决的明确事项。

禁止推测未来、定义感情结果、写隐藏心理、判断输赢或补写未发生的事情。`,
});

export const DEFAULT_SETTINGS = Object.freeze({
    enabled: true,
    showWandButton: true,
    autoSummarize: true,
    independentApi: true,
    checkpointInterval: 20,
    longMemoryInterval: 100,
    summaryMaxLength: 350,
    checkpointMaxLength: 1500,
    longMemoryMaxLength: 3000,
    recentSummaryCount: 10,
    recentCheckpointCount: 2,
    strictCacheMode: true,
    injectionMode: INJECTION_MODES.NONE,
    provider: API_PROVIDERS.OPENAI_COMPATIBLE,
    apiBaseUrl: '',
    model: '',
    temperature: 0.2,
    maxTokens: 1200,
    timeoutMs: 60000,
    prompts: DEFAULT_PROMPTS,
});

export function normalizeSettings(saved = {}) {
    const source = saved && typeof saved === 'object' ? saved : {};
    const prompts = { ...DEFAULT_PROMPTS, ...(source.prompts ?? {}) };
    const number = (value, fallback, min, max) => {
        const parsed = value === '' || value === null || value === undefined ? Number.NaN : Number(value);
        return Math.min(max, Math.max(min, Number.isFinite(parsed) ? parsed : fallback));
    };
    const checkpointInterval = Math.round(number(source.checkpointInterval, 20, 1, 1000));
    let longMemoryInterval = Math.round(number(source.longMemoryInterval, 100, checkpointInterval, 10000));
    if (longMemoryInterval % checkpointInterval !== 0) {
        longMemoryInterval = Math.ceil(longMemoryInterval / checkpointInterval) * checkpointInterval;
    }
    const injectionMode = Object.values(INJECTION_MODES).includes(source.injectionMode)
        ? source.injectionMode
        : INJECTION_MODES.NONE;
    const provider = Object.values(API_PROVIDERS).includes(source.provider)
        ? source.provider
        : API_PROVIDERS.OPENAI_COMPATIBLE;

    return {
        ...DEFAULT_SETTINGS,
        ...source,
        enabled: source.enabled !== false,
        showWandButton: source.showWandButton !== false,
        autoSummarize: source.autoSummarize !== false,
        independentApi: source.independentApi !== false,
        strictCacheMode: source.strictCacheMode !== false,
        checkpointInterval,
        longMemoryInterval,
        summaryMaxLength: Math.round(number(source.summaryMaxLength, 350, 50, 5000)),
        checkpointMaxLength: Math.round(number(source.checkpointMaxLength, 1500, 100, 12000)),
        longMemoryMaxLength: Math.round(number(source.longMemoryMaxLength, 3000, 200, 24000)),
        recentSummaryCount: Math.round(number(source.recentSummaryCount, 10, 0, 200)),
        recentCheckpointCount: Math.round(number(source.recentCheckpointCount, 2, 0, 50)),
        temperature: number(source.temperature, 0.2, 0, 2),
        maxTokens: Math.round(number(source.maxTokens, 1200, 32, 32000)),
        timeoutMs: Math.round(number(source.timeoutMs, 60000, 1000, 300000)),
        provider,
        injectionMode,
        prompts,
    };
}
