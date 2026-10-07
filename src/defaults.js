export const MODULE_ID = 'cache_memory';
export const METADATA_KEY = 'cache_memory';
export const INJECTION_KEY = 'cache_memory_injection';
export const API_KEY_STORAGE_KEY = 'cache_memory_api_key_v1';

export const API_PROVIDERS = Object.freeze({
    OPENAI_COMPATIBLE: 'openai-compatible',
});

export const INJECTION_MODES = Object.freeze({
    NONE: 'none',
    CHECKPOINT_BOUNDARY: 'checkpoint_boundary',
    LONG_BOUNDARY: 'long_boundary',
    LONG: 'long',
    LONG_CHECKPOINT: 'long_checkpoint',
    LONG_CHECKPOINT_RECENT: 'long_checkpoint_recent',
});

export const LEGACY_PROMPTS = Object.freeze({
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

export const DEFAULT_PROMPTS = Object.freeze({
    summary: `你是长期剧情连续性的事实记录员。只记录当前这一层正文中新发生、确认或改变的事实，不用旧背景补全。
事实、因果、未解决事项、人物认知差和当前状态的完整性优先于去重与 token 节省。
每个重要事件写清：姓名 → 原因/情境 → 行动或关键台词 → 直接结果。多人物场景明确姓名，禁止用模糊代词代替实体。
明确区分客观事实与人物的猜测、谎言、误会、传闻（例如“A声称”“B误以为”）。禁止推断隐藏动机、感情、输赢；暧昧不自动升级为恋爱、原谅、依赖或臣服。
必须保留承诺、约定、秘密、未完成任务、伤害、物品去向、地点、联系方式、计划、期限和关系转折。无关日常、重复描写和纯修辞可省略。
目标长度 350–{{maxLength}} 中文字符，仅为软目标；宁可略超，也不删除关键因果和未解决事项。未知时间/地点明确标注未知。最多保留一句影响后续的原话。

输出：
[SUMMARY]
[Title]
简短标题
[Characters]
本层实际出现的人物
[Event]
按发生顺序记录关键事件和最小因果链
[State]
本层结束时新增或改变且仍有效的关系/立场、地点、计划、认知差、物品归属、身体状态和规则边界
[Open]
尚未解决的事项
[Quote]
最多一句重要原话，无则写无
[KEEP]
- 每条单独记录不能遗忘的秘密、承诺、计划、认知差、伏笔、重要物品、长期伤害或重大关系转折；脱离原文也能理解，无则写无

下一条 user 消息是本层正文。`,
    checkpoint: `你负责增量维护剧情的当前世界状态，处理第 {{startFloor}}–{{endFloor}} 层的新增摘要。
输入是上一份仍有效状态、当前长期事实、尚有效 KEEP 项及这一阶段新增的小总结。旧状态 + 新增变化 = 新状态，禁止把上一份摘要再次无限压缩。
未变化的重要信息必须继承；暂时没被提到绝不代表失效。只有明确失效、被新事实替代或明确解决且未来不再有影响时才能删除。变化的重要原因和历史后果须保留。
秘密、承诺、冲突、债务、伤害、误会、计划和人物认知差不能因久未出现而删除。区分事实、谁知道、谁不知道、谁相信错误信息和谁在隐瞒。
禁止推断隐藏心理、关系结果和未来。不要只写“关系恶化”等模糊结论，要写清谁因哪件事对谁发生何种明确变化及是否解决。
目标 800–{{maxLength}} 中文字符，仅为软目标，关键连续性不得因长度丢失。

输出：
[CHECKPOINT]
[Story So Far]
真正影响当前剧情的必要起因 → 决定/行动 → 后果
[Characters]
每人分别记录身份、明确关系、立场、认知、目标、承诺及长期边界/伤害
[Current State]
已知时间/地点、人物分布、物品归属、下一步、关系状态和现实条件
[Secrets & Knowledge]
客观事实及各人的已知/未知/误信/隐瞒
[Open Threads]
尚未结束的承诺、冲突、秘密、任务、计划、异常、伤害/损失
[Continuity Locks]
未来不能忘记或写反的事实
[KEEP]
继承所有仍有效的 KEEP 项
[RESOLVED_KEEP]
- keep-id | 正文明示的兑现/撤销/解决/失效原因 | 从本阶段新增摘要逐字复制的证据（至少4字）
没有明确证据则写无，不得仅因未提及就解除 KEEP。`,
    longMemory: `你维护跨场景长期有效的事实档案，处理第 {{startFloor}}–{{endFloor}} 层新增变化。
输入含现有事实档案、Checkpoint 状态和该阶段新增楼层摘要。只输出新增或明确改变的长期事实，不重写全部档案，不以更短的大摘要覆盖旧事实。
保留身份和明确关系、长期偏好/禁忌/边界、重大关系转折及原因、承诺/誓言、目标/计划、冲突/债务/责任、秘密和谁知道/不知道、重要谎言/误会、伤害/长期后果、重要物品/地点/规则。
普通吃饭、天气、小动作、服装、短暂情绪、无后续影响的闲聊和文学修辞不保存。不推断隐藏心理或尚未成立的关系。
旧事实久未提及仍有效。新信息补充旧信息时保留必要历史因果；明确推翻时记录当前事实及旧事实造成的重要后果。
目标长度 {{maxLength}} 中文字符是软目标；事实不丢失 > 因果 > 未解决事项 > 认知差 > 当前状态 > 去重 > token 节省。

输出以下增量格式：
[LONG_MEMORY]
- 【人物/主题｜类别】完整的新增长期事实；必要起因；当前影响。
没有新增写无。
[UPDATED_FACTS]
- fact-id | 替代后的完整事实（含仍重要的历史后果） | 从新增摘要逐字复制的变更证据（至少4字）
[RETIRED_FACTS]
- fact-id | 正文明示已失效且无后续影响的原因 | 从新增摘要逐字复制的证据（至少4字）
没有变更写无，不得自动删除未被提到的事实。只引用输入中提供的 fact-id。`,
});

export const DEFAULT_SETTINGS = Object.freeze({
    enabled: true,
    showWandButton: true,
    autoSummarize: true,
    independentApi: true,
    memoryStrategy: 'incremental',
    checkpointInterval: 5,
    longMemoryInterval: 50,
    summaryMaxLength: 500,
    checkpointMaxLength: 1500,
    longMemoryMaxLength: 3000,
    recentSummaryCount: 10,
    recentCheckpointCount: 2,
    strictCacheMode: true,
    cacheDebug: false,
    injectionMode: INJECTION_MODES.NONE,
    provider: API_PROVIDERS.OPENAI_COMPATIBLE,
    apiBaseUrl: '',
    model: '',
    temperature: 0.2,
    maxTokens: 3200,
    tokenLimitParameter: 'max_tokens',
    timeoutMs: 60000,
    prompts: DEFAULT_PROMPTS,
});

export function normalizeSettings(saved = {}) {
    const source = saved && typeof saved === 'object' ? saved : {};
    const memoryStrategy = source.memoryStrategy === 'legacy' ? 'legacy' : 'incremental';
    const defaults = memoryStrategy === 'legacy' ? LEGACY_PROMPTS : DEFAULT_PROMPTS;
    const prompts = { ...defaults, ...(source.prompts ?? {}) };
    for (const name of Object.keys(defaults)) {
        if (prompts[name] === LEGACY_PROMPTS[name] || prompts[name] === DEFAULT_PROMPTS[name]) prompts[name] = defaults[name];
    }
    const number = (value, fallback, min, max) => {
        const parsed = value === '' || value === null || value === undefined ? Number.NaN : Number(value);
        return Math.min(max, Math.max(min, Number.isFinite(parsed) ? parsed : fallback));
    };
    const checkpointInterval = Math.round(number(source.checkpointInterval, DEFAULT_SETTINGS.checkpointInterval, 1, 1000));
    let longMemoryInterval = Math.round(number(source.longMemoryInterval, DEFAULT_SETTINGS.longMemoryInterval, checkpointInterval, 10000));
    if (longMemoryInterval % checkpointInterval !== 0) {
        longMemoryInterval = Math.ceil(longMemoryInterval / checkpointInterval) * checkpointInterval;
    }
    const injectionMode = Object.values(INJECTION_MODES).includes(source.injectionMode)
        ? source.injectionMode
        : INJECTION_MODES.NONE;
    // Legacy provider values (including Doubao/Ark names) are migrated to the
    // single OpenAI-compatible implementation while preserving URL and model.
    const provider = API_PROVIDERS.OPENAI_COMPATIBLE;

    return {
        ...DEFAULT_SETTINGS,
        ...source,
        enabled: source.enabled !== false,
        showWandButton: source.showWandButton !== false,
        autoSummarize: source.autoSummarize !== false,
        independentApi: source.independentApi !== false,
        strictCacheMode: source.strictCacheMode !== false,
        cacheDebug: source.cacheDebug === true,
        memoryStrategy,
        checkpointInterval,
        longMemoryInterval,
        summaryMaxLength: Math.round(number(source.summaryMaxLength, DEFAULT_SETTINGS.summaryMaxLength, 50, 5000)),
        checkpointMaxLength: Math.round(number(source.checkpointMaxLength, 1500, 100, 12000)),
        longMemoryMaxLength: Math.round(number(source.longMemoryMaxLength, 3000, 200, 24000)),
        recentSummaryCount: Math.round(number(source.recentSummaryCount, 10, 0, 200)),
        recentCheckpointCount: Math.round(number(source.recentCheckpointCount, 2, 0, 50)),
        temperature: number(source.temperature, 0.2, 0, 2),
        tokenLimitParameter: source.tokenLimitParameter === 'max_completion_tokens' ? 'max_completion_tokens' : 'max_tokens',
        maxTokens: Math.round(number(source.maxTokens, DEFAULT_SETTINGS.maxTokens, 32, 32000)),
        timeoutMs: Math.round(number(source.timeoutMs, 60000, 1000, 300000)),
        provider,
        injectionMode,
        prompts,
    };
}
