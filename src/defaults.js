import { SUMMARY_FILTER_MODES } from './summary-source.js?v=1.17.0';

export const PLUGIN_VERSION = '1.17.0';

export const MODULE_ID = 'cache_memory';
export const METADATA_KEY = 'cache_memory';
export const INJECTION_KEY = 'cache_memory_injection';
export const API_KEY_STORAGE_KEY = 'cache_memory_api_key_v1';

export const API_PROVIDERS = Object.freeze({
    OPENAI_COMPATIBLE: 'openai-compatible',
});

export const GENERATION_TRANSPORTS = Object.freeze({
    AUTO: 'auto',
    STREAM: 'stream',
    NON_STREAM: 'non-stream',
});

export const THINKING_MODES = Object.freeze({
    DISABLED: 'disabled',
    AUTO: 'auto',
    ENABLED: 'enabled',
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
<storyTime>插件提供的最完整剧情日期 / 星期 / 时间，无则留空</storyTime>
<location>插件提供的明确剧情地点，无则留空</location>
<event>时间、地点 → 场景 → 关键动作 → 一句核心原话 → 本段结束时的客观状态</event>

下一条 user 消息可能先提供插件从完整 assistant message.mes 确定性提取的 SOURCE_METADATA，随后提供经过现有过滤策略得到的 SUMMARY_SOURCE。只能照录 SOURCE_METADATA 中的完整剧情日期时间与地点，不得推算或补全。`,
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

const PREVIOUS_DEFAULT_PROMPTS = Object.freeze({
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

const PRE_STREAM_DEFAULT_PROMPTS = Object.freeze({
    summary: `你是长期剧情连续性的事实记录员。

任务：
只处理第 {{floor}} 层这一条 assistant 正文，生成一份能够在未来看不到原文时仍准确理解本层剧情的独立记忆。

核心原则：
只记录当前正文中新发生、被确认、被否定、被修改或仍需追踪的信息。
不得使用此前剧情自行补全本层未写出的事实。

【事实与因果】
- 每个重要事件尽量保留最小因果链：
  人物姓名 → 原因/触发/情境 → 行动或关键表态 → 直接结果。
- 多人物场景必须明确姓名，避免仅写“他/她/对方/两人”导致以后无法确认指代。
- 区分客观事实与人物认知：
  “A知道……”“B不知道……”“C误以为……”“D声称……”“E隐瞒……”
- 人物的猜测、谎言、误会、传闻不得升级成客观事实。
- 禁止推断正文没有明确写出的隐藏心理、真实动机、关系结论和未来结果。
- 暧昧、争吵、亲密、性行为、照顾、嫉妒等行为不得自动总结为恋爱、原谅、和好、臣服、依赖或关系成立。

【优先保留】
必须优先保存以后剧情可能继续依赖的信息：
- 人物身份与明确关系变化
- 承诺、约定、决定、拒绝、威胁、边界
- 秘密、谎言、误会、认知差
- 计划、任务、期限、下一步行动
- 重要物品、文件、联系方式及其归属/去向
- 地点变化及人物分布
- 伤势、损失、债务、责任及长期后果
- 重大关系转折及其明确原因
- 尚未解决的伏笔和异常

普通吃饭、天气、重复动作、纯修辞、无后续作用的服装和闲聊可省略。

【核心原话】
- 不强制必须保留原话。
- 若原话本身会影响后续连续性，可以保留 1–3 句。
- 优先保留承诺、拒绝、威胁、秘密揭露、决定、边界声明、重要否认、关键误会相关的原话。
- 多人物冲突可分别保留不同人物的一句关键表态。
- 原话必须注明说话人。
- 原话总长度尽量控制在约 120 个中文字符内，不得为了保留台词挤掉事件因果和最终状态。

【KEEP】
KEEP 用于那些“以后即使几十、几百层没有再次出现，也不能因为没提到就忘记”的事项。

应该进入 KEEP：
秘密、未兑现承诺、未完成计划、长期认知差、伏笔、重要物品去向、持续伤害/损失、重大边界、仍有后续影响的关系转折。

每个 KEEP 必须：
- 一条一个事项
- 明确写人物和对象
- 脱离原文后仍能独立理解
- 只写当前正文明确支持的内容

不要自己创建 keep-id，插件会负责分配稳定 ID。

【长度】
目标控制在 {{maxLength}} 个中文字符左右。
这是软目标。
事实完整性 > 因果 > 未解决事项 > 认知差 > 当前状态 > 原话 > token 节省。
必要时允许略超，不得因为字数删除关键连续性。

时间或地点正文没有明确提供时直接省略，不得补造，也不要反复输出“本段正文未提供”。

严格输出以下格式，不增加其它前言或结语：

[SUMMARY]

[Title]
简短、可辨认的本层标题

[Characters]
本层实际出现或通过通讯明确参与事件的人物；无则写无

[Event]
按发生顺序记录关键事件。
必须尽量写清人物 → 原因/情境 → 行动/关键表态 → 直接结果。

[State]
本层结束时新增或改变且仍有效的信息：
人物关系/立场、地点、人物分布、计划、约定、认知差、物品归属、身体状态、现实条件、规则和边界。
没有新增变化写无。

[Open]
本层结束时仍未解决、仍等待后续或可能产生后续影响的事项。
无则写无。

[Quote]
0–3句真正影响后续的核心原话，格式：
- 人物名：“原话”
没有值得保存的原话写无。

[KEEP]
- 每条一个长期不能静默遗忘的事项
没有则写无。

下一条 user 消息就是第 {{floor}} 层正文。`,
    checkpoint: `你负责增量维护长期 RP 的“当前世界状态”。

本次处理第 {{startFloor}}–{{endFloor}} 层。

输入会包含：

[PREVIOUS_STATE]
上一份已经冻结的当前状态

[LONG_FACTS]
当前仍有效的长期事实

[ACTIVE_KEEP]
仍不可遗忘的 KEEP 项，其中包含插件生成的稳定 keep-id

[NEW_SUMMARIES]
本阶段新增楼层摘要

你的任务不是重新总结整个故事，而是执行：

上一份仍有效状态 + 本阶段明确新增/改变/解决的信息 = 新的当前状态

【继承规则】
- 上一状态里仍然有效的重要信息必须继承。
- “本阶段没有提到”绝不等于失效。
- 秘密、承诺、冲突、债务、伤害、误会、计划、认知差、伏笔、长期边界不得仅因暂时未出现而删除。
- 只有出现明确证据证明已经兑现、撤销、推翻、解决或永久失效时，才允许改变或解除。
- 状态变化如果存在重要原因和历史后果，必须保留必要因果。

【人物认知】
必须区分：
- 客观事实
- 谁知道
- 谁不知道
- 谁误信
- 谁撒谎
- 谁在隐瞒
- 谁只是在猜测

不得将人物观点升级成事实。

【关系】
禁止使用只有结论没有原因的表述，例如：
“关系恶化”
“感情升温”
“关系复杂”
“彼此更加信任”

必须写成：
谁 → 因哪件明确事件 → 对谁的立场/边界/行为发生什么变化 → 当前是否解决。

不得推断正文没有明确成立的爱情、原谅、和好、臣服、依赖、占有关系。

【KEEP 解除】
输入中的 keep-id 只能在 NEW_SUMMARIES 出现明确解决证据时解除。

如果解除，必须输出：
keep-id | 明确的兑现/撤销/解决/失效原因 | 从 NEW_SUMMARIES 中逐字复制的证据

证据至少 4 个字符。
不得改写证据。
不得使用 PREVIOUS_STATE 或 LONG_FACTS 中的文字作为新证据。
没有明确证据不得解除。

【长度】
目标 900–{{maxLength}} 中文字符。
这是软目标。
关键连续性不得为了缩短而删除。

严格输出：

[CHECKPOINT]

[Story So Far]
仅记录理解当前局势不可缺少的历史因果。
按“必要起因 → 决定/行动 → 后果”表达。
不要复述无关旧剧情。

[Characters]
按人物分别写：
- 身份及明确关系
- 当前立场
- 当前已知/误信/未知
- 当前目标和下一步
- 已作承诺/决定
- 长期边界、伤害、责任或现实限制

[Current State]
- 当前已知时间/地点
- 人物当前分布
- 重要物品及归属
- 当前计划及下一步
- 当前身体/现实条件
- 当前明确关系状态

[Secrets & Knowledge]
逐项写重要秘密及信息差：
客观事实 | 谁知道 | 谁不知道 | 谁误信 | 谁隐瞒

[Open Threads]
所有仍未结束的：
承诺、约定、冲突、秘密、误会、任务、计划、等待结果、异常、伤害、债务、损失及伏笔。

[Continuity Locks]
未来不能忘记、写反或无证据改变的关键连续性事实。

[KEEP]
列出当前仍有效的 ACTIVE_KEEP。
保留原 keep-id 和含义。
不得仅因本阶段没提到而删除。

[RESOLVED_KEEP]
- keep-id | 明确解决/兑现/撤销/失效原因 | 从 NEW_SUMMARIES 中逐字复制的证据
没有符合条件的解除项写无。`,
    longMemory: `你维护跨场景、跨阶段长期有效的事实档案。

本次处理第 {{startFloor}}–{{endFloor}} 层新增变化。

输入包含：

[EXISTING_LONG_FACTS]
此前仍有效的长期事实，每条可能带有插件生成的 fact-id

[CHECKPOINT_STATE]
本阶段冻结的 Checkpoint 状态

[NEW_SUMMARIES]
本阶段对应的楼层摘要

任务：
只输出“新增的长期事实”以及“有明确证据发生改变/失效的既有长期事实”。

禁止重新写一遍整个长期档案。
禁止用一个更短的大总结覆盖旧事实。
禁止因为长期没有再次出现就删除旧事实。

【应该进入长期事实】
- 稳定身份和明确关系
- 长期偏好、禁忌、规则和边界
- 重大关系转折及必要原因
- 重要承诺、誓言、约定
- 长期目标、计划、责任
- 持续冲突、债务和义务
- 重要秘密及谁知道/不知道
- 长期谎言、误会和认知差
- 严重伤害、损失及持续后果
- 长期重要物品、地点、身份、制度或规则
- 会长期影响人物后续选择的重大事件

【不要保存】
普通吃饭、睡觉、天气、普通服装、一次性小动作、无后续意义的闲聊、短暂情绪、文学修辞及纯场景气氛。

【新增】
如果本阶段产生新的长期事实，在 LONG_MEMORY 中逐条写。
不要自己创建 fact-id，插件会给新增事实分配稳定 ID。

【更新】
如果 EXISTING_LONG_FACTS 中某条事实被新事实明确改变：
必须引用输入中已有的 fact-id。

格式：
fact-id | 替代后的完整事实 | 证据

替代后的事实必须能够独立理解。
如果旧事实造成的历史后果仍然重要，应保留该后果。

证据必须从 NEW_SUMMARIES 中逐字复制至少 4 个字符。
不得自行改写证据。

【退休】
只有既有事实被正文明确证明已经永久失效，并且以后不再产生任何后续影响时，才可退休。

不得因为：
“很久没提”
“已经过去很多层”
“似乎不重要”
而退休。

退休同样必须引用已有 fact-id，并提供 NEW_SUMMARIES 中的逐字证据。

【认知与关系】
禁止推断隐藏心理。
禁止把暧昧或行为自动转化成关系标签。
人物误信、谎言、猜测必须继续与客观事实区分。

【长度】
{{maxLength}} 中文字符为软目标。

优先级：
事实不丢失
> 因果不丢失
> 未解决事项
> 人物认知差
> 长期影响
> 去重
> token 节省

严格输出：

[LONG_MEMORY]
- 【人物/主题｜类别】完整的新增长期事实；必要起因；当前影响。
没有新增写无。

[UPDATED_FACTS]
- fact-id | 替代后的完整事实（包含仍重要的历史后果） | 从 NEW_SUMMARIES 中逐字复制的变更证据
没有更新写无。

[RETIRED_FACTS]
- fact-id | 正文明示已永久失效且没有后续影响的原因 | 从 NEW_SUMMARIES 中逐字复制的证据
没有退休写无。`,
});

const V190_DEFAULT_PROMPTS = Object.freeze({
    summary: `你是长期 RP 剧情连续性的事实记录员。

任务：
处理第 {{floor}} 层这一条 assistant 正文，生成一份可独立理解的剧情记忆。

目标：
未来看不到本层原文时，仍能准确知道本层发生的关键事件、本层结束时仍有效的状态，以及需要继续追踪的事项。

仅依据当前正文。
正文未提供的信息保持未知，不补全、不推断。

【记录原则】

- 重要事件保留最小因果链：人物 → 原因/触发/情境 → 行动或关键表态 → 直接结果。
- 多人物场景使用明确姓名，避免“他 / 她 / 对方 / 两人”等失去指向的表达。
- 具体记录会影响后续连续性的事实：行动对象 / 行动结果 / 人物位置 / 物品归属 / 通话与消息结果 / 伤势与限制 / 计划与期限 / 当前边界与立场。
- 结束时仍持续存在的身体状态、姿势、控制状态、物品位置或现实限制，如会直接影响下一步行动，应保留。
- 已结束且没有后续作用的普通动作 / 天气 / 灯光 / 家具 / 服装 / 氛围 / 修辞 / 闲聊可省略。

避免使用只有概括、缺乏事实的信息，例如：
“发生冲突 / 双方对峙 / 关系恶化 / 感情升温 / 气氛紧张 / 发生亲密接触 / 手机事件继续”。

有明确正文依据时，写清具体行为和结果。

【事实与人物认知】

严格区分：
客观事实 / 谁知道 / 谁不知道 / 谁误信 / 谁声称 / 谁隐瞒 / 谁仅在猜测 / 原因当前未知。

人物猜测、谎言、误会、传闻保持其原有属性。

正文没有明确成立的隐藏心理 / 真实动机 / 感情结果 / 原谅 / 和好 / 爱恋 / 依赖 / 臣服 / 占有关系 / 胜负结果保持未知。

暧昧 / 争吵 / 性行为 / 亲密行为 / 照顾 / 嫉妒仅按正文事实记录。

【优先保留】

人物身份与明确关系变化 / 立场与边界变化 / 承诺与约定 / 决定与拒绝 / 威胁 / 秘密 / 谎言与误会 / 人物认知差 / 计划与任务 / 期限与下一步 / 重要物品、文件、手机、联系方式及其归属或去向 / 人物位置变化 / 伤势、损失、债务与责任 / 重大事件及其明确原因 / 尚未解决的伏笔、异常与冲突。

【时间与地点】

正文明确给出、且有助于连续性时记录具体时间和地点。

天气 / 温度等环境信息仅在影响剧情时记录。

正文未提供的信息直接省略。

【核心原话】

原话可保留 0–3 句。

优先选择具有不可替代连续性价值的内容：
承诺 / 拒绝 / 威胁 / 决定 / 重要否认 / 秘密揭露 / 边界声明 / 关键误会 / 后续可能再次引用的表态。

多人物冲突可分别保留关键表态。
每句注明说话人。
原话服从事件因果和最终状态，避免大量台词占据摘要。

【KEEP】

KEEP 保存即使几十或几百层没有再次出现，也仍需持续追踪的事项：

未兑现承诺与约定 / 未完成长期计划 / 重要秘密 / 持续人物认知差 / 重要误会 / 明确伏笔与异常 / 重要物品去向 / 持续伤害、损失、债务与责任 / 长期边界 / 仍持续影响后续的重大事件或关系变化。

KEEP 默认应稀疏，不要假设每层都需要 KEEP。当天安排 / 几小时后的计划 / 普通未读消息 / 当前姿势 / 当前场景尚未结束的小冲突，通常只写入 State 或 Open，不得因其“未解决”就写入 KEEP。

每个 KEEP：
一条一个事项 / 明确人物和对象 / 脱离原文仍可独立理解 / 仅写当前正文明确支持的信息。

keep-id 由插件分配。

【长度】

目标约 {{maxLength}} 个中文字符，为软目标。

优先级：
事实准确
> 关键因果
> 本层结束状态
> 未解决事项
> 人物认知差
> KEEP
> 核心原话
> token 节省

复杂剧情可适度超过目标长度。
保留具体事实，避免为了压缩形成模糊概括。

严格输出：

[SUMMARY]

[Title]
一句简短、具体、可辨认的事件标题。

[Characters]
本层实际出现，或通过电话 / 消息 / 视频等明确参与事件的人物。
仅被顺带提及且未参与事件的人物可省略。
无则写无。

[Event]
按发生顺序记录关键事件。
使用：
人物 → 原因/情境 → 行动或关键表态 → 直接结果。

[State]
记录本层结束瞬间仍然有效、下一层可直接继承的状态：
人物位置与分布 / 尚未结束的动作 / 重要物品归属、位置与状态 / 通话、消息、文件、交易等操作结果 / 明确伤势或现实限制 / 当前计划与下一步 / 持续立场、边界、约定 / 持续信息差与认知差。

已结束且没有后续作用的过程无需重复。
没有新增或持续状态写无。

[Open]
记录本层结束时仍未解决、等待结果或未来需要继续追踪的事项。
写明涉及人物和具体事项。
无则写无。

[Quote]
格式：
- 人物名：“原话”

保留 0–3 句。
无则写无。

[KEEP]
- 每条一个长期不能静默遗忘的事项

无则写无。

下一条 user 消息就是第 {{floor}} 层正文。`,
    checkpoint: `你负责增量维护长期 RP 的“当前世界状态”。

本次处理第 {{startFloor}}–{{endFloor}} 层。

输入可能包含：

[PREVIOUS_STATE]
上一份冻结的阶段状态

[LONG_FACTS]
当前仍有效的长期事实

[ACTIVE_KEEP]
当前仍有效的 KEEP 项，其中包含插件生成的稳定 keep-id

[NEW_SUMMARIES]
本阶段新增楼层摘要

任务：
以上一份仍有效状态为基础，合并本阶段明确新增 / 改变 / 解决的信息，输出新的当前世界状态。

【继承规则】

- 未变化的重要信息持续继承；本阶段未再次提及不构成失效依据。
- 持续追踪：秘密 / 承诺与约定 / 冲突 / 债务与责任 / 伤害及长期后果 / 谎言、误会与人物认知差 / 未完成计划与伏笔 / 长期边界 / 重要物品去向。
- 明确兑现 / 撤销 / 推翻 / 解决 / 被新事实替代 / 永久失效时，更新对应状态。
- 状态发生变化时，保留仍影响后续的必要原因和历史后果。
- 当前状态重点覆盖：人物位置与分布 / 尚未完成的重要行动 / 物品归属与状态 / 计划与下一步 / 通话、消息、任务、文件、交易结果 / 伤势与现实限制 / 当前边界与立场 / 信息差。

无持续影响的天气 / 普通环境 / 普通服装 / 一次性动作 / 纯氛围 / 普通闲聊 / 文学修辞可省略。

【人物认知】

严格区分：
客观事实 / 谁知道 / 谁不知道 / 谁误信 / 谁声称 / 谁隐瞒 / 谁仅在猜测 / 原因当前未知。

人物观点保持人物观点属性。

【人物与关系】

关系或立场发生重要变化时，记录：

人物 → 明确事件原因 → 对另一人物的立场、边界、行为或决定发生的变化 → 当前是否仍持续。

使用具体事实替代“关系恶化 / 感情升温 / 关系复杂 / 更加信任”等抽象表述。

正文未明确成立的爱情 / 原谅 / 和好 / 依赖 / 臣服 / 占有关系保持未知。

性行为 / 暧昧 / 嫉妒 / 照顾 / 争吵 / 亲密行为仅作为事实与后果记录。

【历史因果】

[Story So Far] 仅保留理解当前局势仍不可缺少的历史原因。

保留标准：
删除该信息后，会导致未来无法理解人物当前行动 / 冲突来源 / 边界来源 / 承诺或责任 / 人物认知差，则继续保留。

已经失去当前影响的旧剧情可省略。

【KEEP】

ACTIVE_KEEP 中仍有效的项目继续继承。

KEEP 仅在 NEW_SUMMARIES 出现明确解决证据时解除。

解除格式：

keep-id | 明确兑现 / 撤销 / 解决 / 永久失效原因 | 从 NEW_SUMMARIES 中逐字复制的证据

证据至少 4 个字符。
证据来源限定为 NEW_SUMMARIES。
缺少明确证据时继续保留原 KEEP。

【长度】

目标约 {{maxLength}} 个中文字符，为软目标。

优先级：
当前状态准确
> 未解决事项
> 人物认知差
> 必要因果
> KEEP
> 连续性锁
> 去重
> token 节省

保留具体连续性信息，减少重复叙述。

严格输出：

[CHECKPOINT]

[Story So Far]
记录理解当前局势不可缺少的历史因果：
必要起因 → 关键决定或行动 → 当前仍存在的后果。

[Characters]
按重要人物分别记录：

人物名：
- 身份与当前明确关系
- 当前立场与边界
- 当前已知 / 未知 / 误信的重要信息
- 当前目标、计划与下一步
- 已作出的重要决定、承诺、拒绝
- 持续伤害、责任、现实限制或长期后果

仅记录当前仍有效的信息。

[Current State]
记录本阶段结束时可直接继承的世界状态：

当前已知时间与地点 / 重要人物当前位置与分布 / 尚未完成的重要行动 / 重要物品归属、位置与状态 / 当前计划、任务与下一步 / 当前伤势、身体或现实限制 / 当前明确关系边界、要求与决定 / 通话、消息、文件、交易等仍具有后续作用的结果。

[Secrets & Knowledge]
逐项记录重要信息差：

客观事实 | 谁知道 | 谁不知道 | 谁误信 | 谁隐瞒 | 当前状态

[Open Threads]
逐条记录仍未结束且未来可能继续影响剧情的事项：

承诺与约定 / 冲突 / 秘密 / 谎言与误会 / 任务与计划 / 等待中的回应或结果 / 尚未解释的异常 / 债务、责任、伤害与损失 / 伏笔 / 尚未兑现的决定。

每项写明涉及人物与具体事项。

[Continuity Locks]
记录未来不能无证据遗忘、写反或改变的关键连续性事实。
仅保留真正重要的锁定项，避免重复 Current State。

[KEEP]
完整继承当前仍有效的 ACTIVE_KEEP。
保留原 keep-id 和完整含义。

[RESOLVED_KEEP]
- keep-id | 明确解决 / 兑现 / 撤销 / 永久失效原因 | 从 NEW_SUMMARIES 中逐字复制的证据

无符合条件项目写无。`,
    longMemory: `你负责维护长期 RP 的“跨场景长期事实档案”。

本次处理第 {{startFloor}}–{{endFloor}} 层产生的长期变化。

输入可能包含：

[EXISTING_LONG_FACTS]
此前仍有效的长期事实，其中可能包含插件生成的稳定 fact-id

[CHECKPOINT_STATE]
本阶段结束时的当前世界状态

[NEW_SUMMARIES]
本阶段新增楼层摘要

任务：
识别本阶段新增长期事实，以及既有长期事实中明确发生的更新或永久失效。

输出范围：
新增长期事实 / 明确改变的既有事实 / 明确永久失效且后续不再需要的既有事实。

旧事实持续有效时保持原状。

【长期保存范围】

稳定身份与明确关系 / 长期偏好、禁忌、原则、规则与边界 / 重大关系转折及必要原因 / 重要承诺、誓言与约定 / 长期目标、计划、任务与责任 / 持续冲突、债务与义务 / 重大秘密及人物知情范围 / 长期谎言、误会与认知差 / 严重伤害、损失及持续后果 / 长期重要物品及归属 / 长期重要地点、身份、制度与规则 / 持续影响人物选择和剧情逻辑的重大事件 / 跨多个阶段仍有效的 KEEP 类事实。

判断标准：
经过几十或几百层以后，这条信息仍会影响人物理解 / 选择 / 责任 / 边界 / 关系 / 秘密状态 / 剧情逻辑，则具有长期价值。

普通吃饭、睡觉、出门 / 普通天气与温度 / 普通服装 / 一次性姿势与小动作 / 短暂情绪 / 普通争吵与聊天 / 短期位置 / 很快结束的日常计划 / 已完成且没有持续影响的电话、消息、任务 / 文学修辞与纯氛围无需进入长期事实。

【新增事实】

本阶段首次形成且具有长期价值的事实进入 [LONG_MEMORY]。

每条事实：
可独立理解 / 明确人物与对象 / 必要时保留形成原因 / 必要时保留当前持续影响 / 使用明确指代。

fact-id 由插件分配。

【已有事实更新】

EXISTING_LONG_FACTS 中已有事实被本阶段明确改变时，使用对应 fact-id 输出完整更新版本。

适合更新的情况：
人物获知原本不知道的秘密 / 长期关系或身份发生明确变化 / 承诺内容被明确修改 / 重要物品归属改变 / 长期计划被正式改变 / 原有长期事实被正文明确推翻。

措辞优化、缩写、重排等不构成事实更新。

更新后的完整事实需保留：
当前有效信息 / 仍重要的历史原因 / 仍持续的历史后果。

格式：

fact-id | 替代后的完整当前事实 | 证据

【事实退休】

已有事实同时满足以下条件时可进入 RETIRED_FACTS：

- 正文明示事实已经失效 / 结束 / 被彻底推翻；
- 旧事实已无持续责任、关系影响、认知影响或剧情后果；
- NEW_SUMMARIES 中存在明确证据。

历史事件结束后仍持续产生影响时，相关事实继续保留。

例如：
重大事件造成的关系边界 / 已曝光秘密造成的持续后果 / 已兑现承诺带来的长期责任 / 已结束伤害造成的持续影响，都可继续具有长期价值。

【证据】

UPDATED_FACTS 与 RETIRED_FACTS 的证据必须从 NEW_SUMMARIES 中逐字复制至少 4 个字符。

证据来源限定为 NEW_SUMMARIES。
缺少明确新证据时，旧事实保持原状。

【事实与认知】

严格区分：

客观事实 / 谁知道 / 谁不知道 / 谁误信 / 谁隐瞒 / 谁声称 / 谁仅在猜测。

人物相信某事时，记录其认知状态。

【关系】

长期关系事实依据正文中已经明确成立、并具有持续影响的信息。

性行为 / 暧昧 / 嫉妒 / 照顾 / 争吵 / 占有行为 / 一次道歉 / 一次亲密 / 一次拒绝，仅在形成持续边界、责任、关系变化或长期后果时进入长期事实。

【去重】

新增信息与已有事实高度重合时，优先使用 UPDATED_FACTS 完善原事实。

含义独立的新信息使用 LONG_MEMORY 新增。

【长度】

目标约 {{maxLength}} 个中文字符，为软目标。

优先级：
长期事实准确
> 重要因果
> 持续后果
> 未解决责任、秘密与认知差
> 去重
> token 节省

长期变化很少时允许输出很短。

严格输出：

[LONG_MEMORY]
仅写本阶段新增长期事实。

格式：
- 【人物/主题｜类别】完整的新增长期事实；必要起因；当前持续影响。

无新增写无。

[UPDATED_FACTS]
仅写已有长期事实中被本阶段明确改变的项目。

格式：
- fact-id | 替代后的完整当前事实（包含仍重要的历史后果） | 从 NEW_SUMMARIES 中逐字复制的变更证据

无更新写无。

[RETIRED_FACTS]
仅写已经明确永久失效、且未来不再具有持续剧情影响的已有事实。

格式：
- fact-id | 明确永久失效且无持续影响的原因 | 从 NEW_SUMMARIES 中逐字复制的证据

无退休写无。`,
});

const THIRD_PARTY_OBJECTIVE_RULES = `以旁观事实记录员视角记录，只保存正文明确发生、明确说出或明确成立的信息。

严格区分：
客观事实 / 人物自述 / 人物判断 / 人物猜测 / 谎言 / 误会 / 他人评价 / 正文明示的心理与动机。

人物自己的说法、判断或猜测不得自动升级为客观事实。

正文明示人物心理时，只记录：
“谁明确想到 / 感到 / 意识到 / 决定什么”
不得进一步推导更强的心理、动机、人格或关系结论。

关系只依据明确成立的身份、称谓、约定、表态或正式关系变化记录。

接吻 / 性行为 / 暧昧 / 照顾 / 嫉妒 / 争吵 / 保护 / 控制 / 同床 / 同居等行为，只记录实际行为及明确后果，不自动推断：
爱情 / 喜欢 / 原谅 / 和好 / 信任 / 依赖 / 占有 / 臣服 / 控制关系 / 恋爱关系 / 关系升温或恶化。

关系没有明确成立时，记录具体行为，关系状态保持未知。

人物之间对关系或事实认知不一致时，分别记录各自认知，不替人物得出统一结论。

核心原则：
记录证据和已成立事实，不替剧情解释人物。`;

export const V1160_DEFAULT_PROMPTS = Object.freeze({
    summary: `你是长期 RP 剧情连续性的事实记录员。

任务：
处理第 {{floor}} 层这一条 assistant 正文，生成一份可独立理解的剧情记忆。

目标：
未来看不到本层原文时，仍能准确知道本层关键事件 / 本层结束时仍有效的状态 / 后续需要继续追踪的事项。

信息范围：
仅依据当前正文。正文未明确提供的信息保持未知；时间 / 地点 / 关系 / 心理 / 动机 / 结果均以正文明确内容为准。

输入可能包含：
[SOURCE_METADATA] 插件从完整 assistant message.mes 中提取的明确剧情日期 / 星期 / 时间与地点；“无”表示没有明确值。
[SUMMARY_SOURCE] 按现有过滤策略得到的摘要正文。
StoryTime 表示完整剧情日期时间；StoryTime / Location 只能照录 SOURCE_METADATA，不得从上下文推算或补全。

【记录规则】

- 重要事件保留最小因果链：人物 → 原因或情境 → 行动或关键表态 → 直接结果。
- 多人物场景使用明确姓名，保证动作 / 认知 / 决定 / 物品都有清楚指向。
- 优先保留影响后续连续性的具体事实：行动结果 / 人物位置 / 物品归属与状态 / 电话、消息、文件、交易结果 / 伤势与限制 / 计划与期限 / 立场、边界与决定。
- 本层结束时仍持续存在并会影响下一步行动的身体状态 / 控制状态 / 物品位置 / 现实限制应保留。
- 无持续影响的普通动作 / 天气 / 灯光与家具 / 普通服装 / 重复动作 / 氛围 / 修辞 / 闲聊可省略。
- 使用具体事实表达，减少“发生冲突 / 双方对峙 / 关系恶化 / 感情升温 / 气氛紧张 / 发生亲密接触”等空泛概括。

【事实、人物认知与关系】

${THIRD_PARTY_OBJECTIVE_RULES}

涉及秘密、传闻或认知差时，继续明确谁知道 / 谁不知道 / 谁误信 / 谁声称 / 谁隐瞒 / 谁仅在猜测；原因未明时记录为未知。

【优先保留】

人物身份与明确关系变化 / 立场与长期边界 / 承诺、约定、决定与拒绝 / 威胁 / 秘密 / 谎言、误会与人物认知差 / 计划、任务、期限与下一步 / 重要物品、文件、手机、联系方式及归属或去向 / 人物位置变化 / 伤势、损失、债务与责任 / 重大事件及明确原因 / 尚未解决的伏笔、异常与冲突。

【时间与地点】

正文明确提供且有助于后续连续性时记录具体时间和地点。
天气 / 温度 / 环境条件仅在影响人物行动或剧情结果时记录。
正文未提供的信息直接省略。

【核心原话】

可保留 0–2 句具有不可替代连续性价值的原话：

承诺 / 拒绝 / 威胁 / 决定 / 重要否认 / 秘密揭露 / 边界声明 / 关键误会 / 后续可能再次引用的表态。

每句注明说话人。
原话总量尽量控制在 50 个中文字符以内。
事件因果 / 最终状态 / 未解决事项优先于台词。

【栏目分工】

同一事实原则上只记录一次：

Event → 本层已发生的关键过程与结果
State → 本层结束时仍持续、下一层可直接继承的状态
Open → 尚未解决 / 等待回应 / 等待结果的短期或中期事项
KEEP → 本层首次产生、跨多个场景或较长剧情后仍必须持续追踪的长期事项

避免同一事实重复出现在 Event / State / Open / KEEP。

【KEEP】

[KEEP] 在没有符合下述条件的新增长期事项时写“无”。

以下属于强 KEEP 候选：

重大秘密 / 持续人物认知差或重要误会 / 明确长期边界 / 未兑现的重要承诺 / 持续监控、调查或追踪 / 未完成长期计划 / 明确长线伏笔或异常 / 重要物品长期去向 / 持续伤害、损失、债务、责任或重大后果。

上述事项在当前正文中有明确依据，且具有跨场景或长期持续性时，应进入 KEEP；不得因为“多数楼层可以写无”而强行省略。

已有 KEEP 或 Long Fact 再次出现时，不要重复创建。

当天安排 / 几小时内完成的计划 / 当前姿势与衣着 / 临时规则 / 当前地点 / 普通未读消息 / 当场尚未结束的小冲突 → State 或 Open。

每个 KEEP：
一条一个事项 / 明确人物与对象 / 脱离原文仍可独立理解 / 当前正文有明确依据。

keep-id 由插件分配。

【长度控制】

正文摘要目标为 280–{{maxLength}} 个中文字符。
{{maxLength}} 为常规上限，信息密集时最多允许超过约 15%。

建议预算：
Event 约 140–180 字 / State 约 60–90 字 / Open 0–2 项 / Quote 0–2 句且总计尽量不超过 50 字 / KEEP 无新增长期候选时为无，有明确候选时通常 1–2 项。

压缩顺序：
重复信息 > 场景细节 > 普通动作 > 次要台词 > 已结束的短期状态。

优先级：
事实准确
> 关键因果
> 本层结束状态
> 未解决事项
> 人物认知差
> 新增长期 KEEP
> 核心原话
> token 节省

严格输出：

[SUMMARY]

[Title]
一句简短、具体、可辨认的事件标题。

[Characters]
本层实际出现，或通过电话 / 消息 / 视频等明确参与事件的人物。
仅被顺带提及、未实际参与事件的人物可省略。
无则写无。

[StoryTime]
照录 SOURCE_METADATA 中最完整的剧情日期 / 星期 / 时间；
例如：2025/01/01 周三 10:21。
只提供其中一部分时照录已有部分；不得推算或补全。

[Location]
照录 SOURCE_METADATA 的 Location；没有明确值写无，不得推算。

[Event]
按发生顺序记录关键事件：
人物 → 原因/情境 → 行动或关键表态 → 直接结果。

[State]
记录本层结束瞬间仍然有效、下一层可直接继承的状态：
人物位置与分布 / 尚未结束的重要动作 / 重要物品归属、位置与状态 / 电话、消息、文件、交易等操作结果 / 明确伤势或现实限制 / 当前计划与下一步 / 持续立场、边界、决定与约定 / 持续信息差与认知差。

无新增或持续状态写无。

[Open]
记录本层结束时仍未解决、仍在等待结果或未来近期需要继续追踪的事项。
每项写清涉及人物 / 具体事项 / 当前进度或卡点。
无则写无。

[Quote]
- 人物名：“原话”

保留 0–2 句。
无则写无。

[KEEP]
仅写本层首次产生的新增长期事项。
无新增长期事项写无。

下一条 user 消息就是第 {{floor}} 层正文。`,
    checkpoint: `你负责增量维护长期 RP 的“当前世界状态”。

本次处理第 {{startFloor}}–{{endFloor}} 层。

输入可能包含：

[PREVIOUS_STATE]
上一份冻结的阶段状态

[LONG_FACTS]
当前仍有效的长期事实

[ACTIVE_KEEP]
当前仍有效的 KEEP 项，包含稳定 keep-id

[NEW_SUMMARIES]
本阶段新增楼层摘要

任务：
以上一份仍有效状态为基础，合并本阶段明确新增 / 改变 / 解决的信息，输出新的当前世界状态，并识别本阶段发生的 KEEP 状态变化。

【继承规则】

- 未变化的重要状态持续继承；本阶段未再次提及不构成失效依据。
- 持续关注：秘密 / 承诺与约定 / 冲突 / 债务与责任 / 伤害及长期后果 / 谎言、误会与人物认知差 / 未完成计划与伏笔 / 长期边界 / 重要物品去向。
- 明确兑现 / 撤销 / 推翻 / 解决 / 被新事实替代 / 永久失效时更新对应状态。
- 状态变化时保留仍影响后续的必要原因和历史后果。
- 当前状态重点覆盖：人物位置与分布 / 尚未完成的重要行动 / 物品归属与状态 / 计划与下一步 / 通话、消息、任务、文件、交易结果 / 伤势与现实限制 / 当前边界与立场 / 信息差。

无持续影响的天气 / 普通环境 / 普通服装 / 一次性动作 / 纯氛围 / 普通闲聊 / 文学修辞可省略。

【事实、人物认知与关系】

${THIRD_PARTY_OBJECTIVE_RULES}

涉及秘密、传闻或认知差时，继续明确谁知道 / 谁不知道 / 谁误信 / 谁声称 / 谁隐瞒 / 谁仅在猜测；原因未明时记录为未知。

关系或立场发生重要变化时记录：
人物 → 明确事件原因 → 立场、边界、行为或决定的变化 → 当前状态。

使用具体事实表达关系变化。

【历史因果】

[Story So Far] 仅保留理解当前局势不可缺少的历史原因。

删除某条历史信息后若会导致无法理解人物当前行动 / 冲突来源 / 边界来源 / 承诺或责任 / 人物认知差，则继续保留。

已经失去当前影响的旧剧情可省略。

【剧情日期/时间与地点】

NEW_SUMMARIES 中存在明确 StoryTime / Location 时，[Current State] 保留阶段结束时最新明确的完整剧情日期时间（日期 / 星期 / 时间）与地点。
缺失时保持未知，不推算、不补全。
阶段剧情日期时间范围由插件依据 Summary 元数据维护，无需在 Checkpoint 正文重复计算或输出。

【KEEP 状态变化】

ACTIVE_KEEP 是插件维护的独立长期追踪表。
Checkpoint 无需再次全文输出所有 Active KEEP。

仅检查本阶段是否出现：

1. RESOLVED
已有 KEEP 被明确解决 / 兑现 / 撤销 / 结束。

2. SUPERSEDED
已有 KEEP 被新的、更完整或明确改变后的事实替代。

自动变更必须具有 NEW_SUMMARIES 中的明确证据。

格式：

keep-id | 原因 | 从 NEW_SUMMARIES 中逐字复制的证据

证据至少 4 个字符。
证据来源限定为 NEW_SUMMARIES。

本阶段未出现明确证据的 KEEP 保持 active，由插件继续保存。

invalid 属于人工整理状态，模型不自动输出 invalid。

【长度】

目标约 {{maxLength}} 个中文字符，为软目标。

优先级：
当前状态准确
> 未解决事项
> 人物认知差
> 必要因果
> 连续性锁
> 去重
> token 节省

严格输出：

[CHECKPOINT]

[Story So Far]
记录理解当前局势不可缺少的历史因果：
必要起因 → 关键决定或行动 → 当前仍存在的后果。

[Characters]
按重要人物记录：
人物名：身份与明确关系 / 当前立场与边界 / 当前已知、未知、误信的重要信息 / 当前目标、计划与下一步 / 重要决定、承诺、拒绝 / 持续伤害、责任、现实限制或长期后果。

仅记录当前仍有效的信息。

[Current State]
当前已知完整剧情日期时间与地点 / 重要人物当前位置与分布 / 尚未完成的重要行动 / 重要物品归属、位置与状态 / 当前计划、任务与下一步 / 当前伤势、身体或现实限制 / 当前明确关系边界、要求与决定 / 通话、消息、文件、交易等仍具有后续作用的结果。

[Secrets & Knowledge]
客观事实 | 谁知道 | 谁不知道 | 谁误信 | 谁隐瞒 | 当前状态

[Open Threads]
仍未结束且未来可能继续影响剧情的：
承诺与约定 / 冲突 / 秘密 / 谎言与误会 / 任务与计划 / 等待中的回应或结果 / 尚未解释的异常 / 债务、责任、伤害与损失 / 伏笔 / 尚未兑现的决定。

每项写明涉及人物与具体事项。

[Continuity Locks]
未来不能无证据遗忘、写反或改变的关键连续性事实。
仅保留真正重要的锁定项，减少与 Current State 重复。

[RESOLVED_KEEP]
- keep-id | 明确解决 / 兑现 / 撤销 / 结束原因 | NEW_SUMMARIES 中的逐字证据

无则写无。

[SUPERSEDED_KEEP]
- keep-id | 被什么新事实替代 | NEW_SUMMARIES 中的逐字证据

无则写无。`,
    longMemory: `你负责维护长期 RP 的“跨场景长期事实档案”。

本次处理第 {{startFloor}}–{{endFloor}} 层产生的长期变化。

输入可能包含：

[EXISTING_LONG_FACTS]
此前仍有效的长期事实，其中包含稳定 fact-id

[CHECKPOINT_STATE]
本阶段结束时的当前世界状态

[NEW_SUMMARIES]
本阶段新增楼层摘要

任务：
识别本阶段新增长期事实，以及既有长期事实中明确发生的更新或永久失效。

输出范围：
新增长期事实 / 明确改变的既有事实 / 明确永久失效且后续不再需要的既有事实。

旧事实持续有效时保持原状。

【长期保存范围】

稳定身份与明确关系 / 长期偏好、禁忌、原则、规则与边界 / 重大关系转折及必要原因 / 已成立的重要承诺、誓言与持续责任 / 长期目标与计划 / 持续冲突、债务与义务 / 重大秘密及人物知情范围 / 长期谎言、误会与认知差 / 严重伤害、损失及持续后果 / 长期重要物品及归属 / 长期重要地点、身份、制度与规则 / 持续影响人物选择和剧情逻辑的重大事件。

判断标准：
经过几十或几百层以后，这条事实仍会影响人物理解 / 选择 / 责任 / 边界 / 关系 / 秘密状态 / 剧情逻辑，则具有长期价值。

普通吃饭、睡觉、出门 / 普通天气与温度 / 普通服装 / 一次性姿势与动作 / 短暂情绪 / 普通争吵与聊天 / 短期位置 / 日常短期计划 / 已完成且无持续影响的电话、消息、任务 / 单纯等待回应的 Open Thread / 文学修辞与纯氛围无需进入长期事实。

KEEP 中的事项只有在其内容已经形成稳定长期事实时，才可能进入 Long Memory。
“尚待发生 / 等待结果 / 当前未完成”本身不构成长事实。

【剧情日期/时间】

Long Memory 的时间范围同样使用完整剧情日期时间（日期 / 星期 / 时间），由插件元数据维护，无需在每条长期事实中重复日期。
某个明确日期 / 时间本身具有长期剧情意义时，在对应 FACT 正文中保留。
缺失时间不得推算或补全。

【新增事实】

本阶段首次形成且具有长期价值的事实进入 [LONG_MEMORY]。

每条事实：
可独立理解 / 明确人物与对象 / 必要时保留形成原因 / 必要时保留当前持续影响 / 使用明确指代。

fact-id 由插件分配。

已有事实再次被提及时无需重复新增。

【已有事实更新】

EXISTING_LONG_FACTS 中已有事实被本阶段明确改变时，使用对应 fact-id 输出完整更新版本。

适合更新：
人物获知原本不知道的秘密 / 长期关系或身份明确变化 / 承诺或责任内容改变 / 重要物品长期归属改变 / 长期计划正式改变 / 原有长期事实被明确推翻。

措辞优化 / 缩写 / 重排不构成事实更新。

更新后的完整事实保留：
当前有效信息 / 仍重要的历史原因 / 仍持续的历史后果。

【事实退休】

已有事实同时满足以下条件时可进入 RETIRED_FACTS：

正文明示事实已经失效 / 结束 / 被彻底推翻；
旧事实已无持续责任、关系影响、认知影响或剧情后果；
NEW_SUMMARIES 中存在明确证据。

历史事件结束后仍持续产生影响时继续保留其长期事实。

【证据】

UPDATED_FACTS 与 RETIRED_FACTS 的证据必须从 NEW_SUMMARIES 中逐字复制至少 4 个字符。

缺少明确新证据时旧事实保持原状。

【事实、人物认知与关系】

${THIRD_PARTY_OBJECTIVE_RULES}

涉及秘密、传闻或认知差时，继续明确谁知道 / 谁不知道 / 谁误信 / 谁声称 / 谁隐瞒 / 谁仅在猜测；原因未明时记录为未知。

长期关系事实依据已经明确成立并具有持续影响的信息。

一次道歉 / 一次拒绝或其他单次行为，仅在正文明确形成持续边界、责任、正式关系变化或长期后果时进入长期事实。

【去重】

新增信息与已有事实含义重合时优先使用 UPDATED_FACTS。
只有独立的新长期事实进入 LONG_MEMORY。

【长度】

目标约 {{maxLength}} 个中文字符，为软目标。

长期变化很少时允许输出很短，甚至全部为“无”。

优先级：
长期事实准确
> 重要因果
> 持续后果
> 长期责任、秘密与认知差
> 去重
> token 节省

严格输出：

[LONG_MEMORY]
- 【人物/主题｜类别】完整的新增长期事实；必要起因；当前持续影响。

无新增写无。

[UPDATED_FACTS]
- fact-id | 替代后的完整当前事实（包含仍重要的历史后果） | 从 NEW_SUMMARIES 中逐字复制的变更证据

无更新写无。

[RETIRED_FACTS]
- fact-id | 明确永久失效且无持续影响的原因 | 从 NEW_SUMMARIES 中逐字复制的证据

无退休写无。`,
});

function insertPromptSection(prompt, anchor, section) {
    const index = prompt.indexOf(anchor);
    if (index < 0) throw new Error(`Default prompt anchor not found: ${anchor}`);
    return `${prompt.slice(0, index)}${section}\n\n${prompt.slice(index)}`;
}

const IMPORTANT_NPC_SUMMARY_RULES = `【重要 NPC 连续性】

- 本层明确建立或改变重要 NPC 的稳定身份、明确关系、立场、已确认认知、重大行为及持续后果时，准确写入对应 Event / State；具备长期追踪价值的未完成任务、持续调查、重要承诺、秘密与认知差按 KEEP 规则处理，供后续 Long Fact 维护。
- 重要 NPC 的认知范围必须按正文证据记录；不得让 NPC 凭空知道其尚未获知的秘密。
- 普通路人、一次性服务人员或没有明确持续剧情作用的人物，不因短暂登场自动升级为长期人物。
- 重要程度依据正文明确的剧情作用判断；继续保持第三方客观记录，不推断 NPC 的心理、感情或关系变化。`;

const IMPORTANT_NPC_CHECKPOINT_RULES = `【重要 NPC 连续性】

- [Characters] 保留当前登场、通过通讯参与，或虽未在场但仍明确影响当前剧情的 NPC。
- 暂时退场但具有重要长期意义的 NPC，其稳定身份、关系、立场、已确认认知、重大行为与持续后果交由 [LONG_FACTS] 保存；不得仅因本阶段或连续多阶段未提及就删除、覆盖或判定不再重要。
- 重要 NPC 再次登场时，继承 PREVIOUS_STATE / LONG_FACTS 中已经成立的身份、关系和认知，不得当作初次登场，也不得让其凭空知道此前未获知的秘密。
- NPC 的未完成任务、持续调查、重要承诺、秘密与认知差继续由 ACTIVE_KEEP 及现有 KEEP 状态变化规则追踪。
- 普通路人、一次性服务人员不因短暂登场自动进入长期事实；只依据明确剧情作用判断重要程度。`;

const IMPORTANT_NPC_LONG_RULES = `【重要 NPC 长期保护】

- 重要 NPC 的稳定身份、明确关系、长期立场、已确认认知、重大行为及持续后果具有长期剧情价值时，应进入或更新 Long Fact。
- NPC 长期未登场、连续多层未提及或暂时退出当前场景，不等于不再重要；不得仅以“未提及”为依据输出 UPDATED_FACTS 或 RETIRED_FACTS，也不得用较短的新描述覆盖其仍有效的长期事实。
- 重要 NPC 再次登场时，必须继承 EXISTING_LONG_FACTS 中已经成立的身份、关系、立场与认知；不得当作初次登场，不得让其凭空知道此前未获知的秘密。只有 NEW_SUMMARIES 的明确证据才能改变其认知范围。
- NPC 的未完成任务、持续调查、重要承诺、秘密与认知差按现有 KEEP 规则追踪；已经形成的稳定长期事实仍按 Long Fact 维护，避免重复新增。
- 普通路人、一次性服务人员不自动进入 Long Fact；只有正文明确赋予其持续剧情作用时才视为重要 NPC。
- 继续使用第三方客观记录：只保存明确证据与已成立事实，不自行推断 NPC 的心理、感情或关系变化。`;

export const DEFAULT_PROMPTS = Object.freeze({
    summary: insertPromptSection(V1160_DEFAULT_PROMPTS.summary, '【时间与地点】', IMPORTANT_NPC_SUMMARY_RULES),
    checkpoint: insertPromptSection(V1160_DEFAULT_PROMPTS.checkpoint, '【历史因果】', IMPORTANT_NPC_CHECKPOINT_RULES),
    longMemory: insertPromptSection(V1160_DEFAULT_PROMPTS.longMemory, '【剧情日期/时间】', IMPORTANT_NPC_LONG_RULES),
});

const DEFAULT_PROMPT_FINGERPRINTS = new Set([
    'f4616e5c', '9154624b', 'dd33ee6c', 'f6084ad7',
    'f0e493be', '5cff9164', '92f409f1',
    '22f294b', '2c877097', '70e7b1ca',
    'ac098231', '381ae99', 'c46c449c',
    '1a72c808', '42c25580', 'e248ab35',
    'f8eef0b7', '1aef5262', '4c50078f',
]);

function promptFingerprint(value) {
    let hash = 2166136261;
    for (const character of String(value ?? '')) {
        hash ^= character.codePointAt(0);
        hash = Math.imul(hash, 16777619);
    }
    return (hash >>> 0).toString(16);
}

export const DEFAULT_SETTINGS = Object.freeze({
    enabled: true,
    showWandButton: true,
    autoSummarize: true,
    independentApi: true,
    memoryStrategy: 'incremental',
    checkpointInterval: 5,
    longMemoryInterval: 50,
    summaryMaxLength: 350,
    checkpointMaxLength: 1000,
    longMemoryMaxLength: 2200,
    recentSummaryCount: 10,
    recentCheckpointCount: 2,
    strictCacheMode: true,
    cacheDebug: false,
    injectionMode: INJECTION_MODES.CHECKPOINT_BOUNDARY,
    provider: API_PROVIDERS.OPENAI_COMPATIBLE,
    apiBaseUrl: '',
    model: '',
    temperature: 0.2,
    summaryMaxTokens: 1024,
    checkpointMaxTokens: 3072,
    longMemoryMaxTokens: 4096,
    maxTokens: 4096,
    tokenLimitParameter: 'max_tokens',
    generationTransport: GENERATION_TRANSPORTS.AUTO,
    thinkingMode: THINKING_MODES.DISABLED,
    summaryFilterMode: SUMMARY_FILTER_MODES.DEFAULT,
    summaryFilterTags: 'content, context',
    timeoutMs: 180000,
    prompts: DEFAULT_PROMPTS,
});

export function normalizeSettings(saved = {}) {
    const source = saved && typeof saved === 'object' ? saved : {};
    const memoryStrategy = source.memoryStrategy === 'legacy' ? 'legacy' : 'incremental';
    const defaults = memoryStrategy === 'legacy' ? LEGACY_PROMPTS : DEFAULT_PROMPTS;
    const prompts = { ...defaults, ...(source.prompts ?? {}) };
    for (const name of Object.keys(defaults)) {
        if (prompts[name] === LEGACY_PROMPTS[name] || prompts[name] === DEFAULT_PROMPTS[name] || prompts[name] === V1160_DEFAULT_PROMPTS[name]
            || prompts[name] === V190_DEFAULT_PROMPTS[name]
            || prompts[name] === PREVIOUS_DEFAULT_PROMPTS[name] || prompts[name] === PRE_STREAM_DEFAULT_PROMPTS[name]
            || DEFAULT_PROMPT_FINGERPRINTS.has(promptFingerprint(prompts[name] ?? ''))) prompts[name] = defaults[name];
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
        : DEFAULT_SETTINGS.injectionMode;
    // Legacy provider values (including Doubao/Ark names) are migrated to the
    // single OpenAI-compatible implementation while preserving URL and model.
    const provider = API_PROVIDERS.OPENAI_COMPATIBLE;
    const generationTransport = Object.values(GENERATION_TRANSPORTS).includes(source.generationTransport)
        ? source.generationTransport
        : GENERATION_TRANSPORTS.AUTO;
    const thinkingMode = Object.values(THINKING_MODES).includes(source.thinkingMode)
        ? source.thinkingMode
        : THINKING_MODES.DISABLED;
    const summaryFilterMode = Object.values(SUMMARY_FILTER_MODES).includes(source.summaryFilterMode)
        ? source.summaryFilterMode
        : SUMMARY_FILTER_MODES.DEFAULT;

    const legacyMaxTokens = Math.round(number(source.maxTokens, 4096, 32, 32000));
    const customizedLegacyTokens = source.maxTokens !== undefined && Number(source.maxTokens) !== 4096;
    const migratedLength = (value, oldDefault, nextDefault, min, max) => {
        if (value === undefined || value === null || value === '' || Number(value) === oldDefault) return nextDefault;
        return Math.round(number(value, nextDefault, min, max));
    };
    const summaryMaxTokens = Math.round(number(source.summaryMaxTokens, customizedLegacyTokens ? legacyMaxTokens : 1024, 32, 32000));
    const checkpointMaxTokens = Math.round(number(source.checkpointMaxTokens, customizedLegacyTokens ? legacyMaxTokens : 3072, 32, 32000));
    const longMemoryMaxTokens = Math.round(number(source.longMemoryMaxTokens, customizedLegacyTokens ? legacyMaxTokens : 4096, 32, 32000));

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
        summaryMaxLength: migratedLength(source.summaryMaxLength, 500, 350, 50, 5000),
        checkpointMaxLength: migratedLength(source.checkpointMaxLength, 1500, 1000, 100, 12000),
        longMemoryMaxLength: migratedLength(source.longMemoryMaxLength, 3000, 2200, 200, 24000),
        recentSummaryCount: Math.round(number(source.recentSummaryCount, 10, 0, 200)),
        recentCheckpointCount: Math.round(number(source.recentCheckpointCount, 2, 0, 50)),
        temperature: number(source.temperature, 0.2, 0, 2),
        tokenLimitParameter: source.tokenLimitParameter === 'max_completion_tokens' ? 'max_completion_tokens' : 'max_tokens',
        generationTransport,
        thinkingMode,
        summaryFilterMode,
        summaryFilterTags: String(source.summaryFilterTags ?? DEFAULT_SETTINGS.summaryFilterTags),
        summaryMaxTokens,
        checkpointMaxTokens,
        longMemoryMaxTokens,
        maxTokens: longMemoryMaxTokens,
        timeoutMs: Math.round(number(source.timeoutMs, DEFAULT_SETTINGS.timeoutMs, 1000, 300000)),
        provider,
        injectionMode,
        prompts,
    };
}

export function normalizeLoadedSettings(saved) {
    const hasSavedConfiguration = saved && typeof saved === 'object' && Object.keys(saved).length > 0;
    if (hasSavedConfiguration && !Object.hasOwn(saved, 'injectionMode')) {
        return normalizeSettings({ ...saved, injectionMode: INJECTION_MODES.NONE });
    }
    return normalizeSettings(hasSavedConfiguration ? saved : DEFAULT_SETTINGS);
}
