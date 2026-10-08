# Prompt Cache 专项审计（1.5.1，本地未提交）

审计对象：`index.js`、`src/api-client.js`、`src/injection.js`、`src/cache-control.js`、`src/memory-store.js`、`src/summarizer.js`、`src/continuity.js`、`src/ui.js`、`src/utils.js` 与默认设置。主模型缓存优先于记忆丰富度。

## 修改前发现

1. `complete()` 和 `test()` 仍 direct 请求第三方 completions；models 的 CSRF 代理与它们不共用运输实现。
2. MemoryStore 每次 persist 都经 onChange 调用 updateInjection，Summary 生成也触发，strictCacheMode 没有运行时阻挡。
3. 增量 buildInjection 每轮重新投影事实、KEEP、最新状态和 CP 后的小总结；旧版还有 recentSummaryCount / recentCheckpointCount 滑动窗口。它们在历史前的 IN_PROMPT 位置改变内容，可能使后续历史前缀失去缓存复用。固定位置不等于缓存安全。
4. 增量 Long Memory 每个 CP 后提取一份 fact delta，未按配置的 50 层分段；虽然没覆盖旧记录，注入投影仍变化。
5. 弹窗使用当前 document；拖动 pointermove 每次读面板和遮罩布局，再写 left/top/width，造成重排及模糊背景重绘。

未发现旧消息正文修改、聊天历史删除/截断/重排、语义召回、相关度评分、向量数据库、Author’s Note / World Info 内容修改、Prompt Manager 动态深度或历史搬移。对记忆集合的 sort/filter/slice 不能等同为聊天历史裁剪；MessageStore 同步仅标记记忆 stale/orphaned，不删除正常聊天。

## 修改后结论

| 用户问题 | 结论 |
| --- | --- |
| 1. 默认配置每轮改变主 RP Prompt？ | 不会。新默认 strict=true、injection=none；已有非默认配置保留。建议最近只读 5 层的场景选严格 CP 边界。 |
| 2. Summary 回写 assistant 原消息？ | 不会，正文只读，写入 chat_metadata.cache_memory。 |
| 3. 主聊天历史裁剪/重排？ | 不会，插件不实现 history window，不删除/移动/排序 chat。 |
| 4. 严格注入多久变一次？ | none 不变；CP 模式默认每 5 层成功提交，Long 模式每 50 层成功提交。缺失/失败会延后；间隔可配置。手动操作/切聊天为例外。 |
| 5. 哪些设置导致逐轮变化？ | strict=false 且开启动态事实/KEEP/状态或近期 Summary 模式。API 地址/密钥/模型/温度变化不会主动刷新主记忆注入。 |
| 6. 最安全的设置？ | strict=true + none；实际只读最近 5 层时建议 strict=true + CP boundary、CP5/Long50，接受固定边界重建。 |
| 7. recent summary 滚动窗口？ | 旧兼容非严格策略保留；严格模式禁用，旧 recent 模式自动降级。 |
| 8. 动态召回？ | 无；不根据本轮 user 文本挑选历史记忆。 |
| 9. 向量数据库？ | 无；存储为当前聊天元数据。 |
| 10. 相关度筛选？ | 无；仅用固定楼层范围和有效状态确定来源。 |
| 11. 旧消息删除？ | 无。管理器“删除”删除的是插件记忆，聊天正文不受影响。 |
| 12. 总总结自动重写？ | 不覆盖旧 CP/Long，不逐轮重写“截至当前”总档案。后台 CP 用旧有效状态加本阶段摘要生成一个新状态版本；Long 按区间追加事实变更记录。 |

每层后台 Summary 完成时，严格分支不会调用 updateInjection。CP5 情况下，1–4 层的 CACHE_MEMORY 逐字/hash 一致，第5层 CP 完成后才更新，第6–9层再次冻结。主请求上的变化出现在第5层完成之后的下一次 RP 请求。第50层同时成功的 CP/Long 自动聚合只发布一次快照；Long 失败时仍发布已完成的 CP。

已经进入 Prompt 的旧冻结块，后台新增时复用其已发布正文，不重新从当前记录取内容。Long 001 不会变为 1–60、1–70；旧 Long 字节不因新的 fact replacement 消失，新块记录明确更新/失效。原始输出里未通过证据验证的 retirement 不进入严格事实注入。允许的边界压缩例外是新 Long 替代其完整覆盖的 CP **注入**，旧 CP 记录不删除。用户手动编辑/删除/重生成、改注入策略及切聊天允许明确刷新。

新默认区间是 5/50，旧自定义值及旧不规则分段完整保留；旧聊天从最后已提交范围之后继续，不为了对齐新默认重写旧历史。

## 网络实现与上游错误限制

统一 `requestOpenAICompatible()`，models/test/Summary/CP/Long 都复用同一个 live CSRF getter、ST window.fetch、credentials 和 base normalization。浏览器只允许访问 ST 的相对代理路径；没有 ST、没有有效 CSRF 或代理路由不存在时失败关闭，不再 direct 请求第三方 API。

核对的官方实现：

- [ST 原生 custom 后端路由](https://github.com/SillyTavern/SillyTavern/blob/release/src/endpoints/backends/chat-completions.js)：`/status` 与 `/generate`，`chat_completion_source=custom`、`custom_url`、`custom_include_headers`；custom header 的 YAML 解析兼容 JSON，显式 Authorization 可覆盖 ST 自身 custom 密钥。
- [ST 原生请求与发送前事件](https://github.com/SillyTavern/SillyTavern/blob/release/public/scripts/openai.js)：`/api/backends/chat-completions/generate`、实时 getRequestHeaders、`CHAT_COMPLETION_SETTINGS_READY`。

代理带回 `{error:...}` 即使 HTTP200 也判失败。官方部分版本丢弃了上游原始响应和 HTTP code；客户端只能展示代理实际返回的 body，无法恢复被服务端丢掉的信息。UI 明确区分代理状态与“上游未提供”，不将代理200伪装成上游200。若返回 upstream_status/error.status/error.status_code，才展示对应值。诊断中 API Key、CSRF、header value 不输出。

火山目标验证为 base `https://ark.cn-beijing.volces.com/api/coding/v3` 加 `/models` / `/chat/completions`，不加 `/v1`。真实 ST 服务端版本与真实火山账户仍需联机确认，自动测试未使用真实 Key。

## 诊断范围

Cache Debug 仅在启用时读主 RP 的发送前事件；独立记忆 API 不触发该事件，不混入主聊天历史诊断。记录消息 hash，不保留全文，不修改 payload。最长公共前缀按消息粒度衡量；共同系统消息内部的部分前缀无法凭单个 hash 精确计数。断点可定位到含 CACHE_MEMORY 的消息或 other prompt/history，不能仅凭 hash 推断具体哪个第三方插件改动。

没有发送前事件的 ST 版本降级为 memory hash 诊断，并显示 messages 不可用。客户端事件之后其他扩展或服务端转换可能仍改变最终上游 Prompt，诊断不是上游缓存命中率测量。固定前缀应同时保持位置和内容稳定。

## 三轮验证（问题13）

1. 设置 strict=true、Checkpoint boundary、CP=5、Long=50、Cache Debug=ON。已有设置为 10/100 时手动调整；用新测试聊天，准备到已完成第4个有效 assistant 楼层。不要在三轮之间编辑角色卡、世界书、注入设置或旧记忆。
2. 连续生成第5、6、7层，每层等后台任务完成后再发下一轮。三次主 RP 发送前的 floor 应为 **4、5、6**，memory hash 应为 **A、B、B**：第一轮基线；第二轮记录 new checkpoint；第三轮 Changed=false。1–4和6–9字节恒定还由自动测试覆盖。
3. 若未滑动/触及上下文上限，第二轮可能因边界重建前缀，第三轮对上一轮应保持 100% 已有消息前缀（正常追加）。同时检查上游 cached input/cache read。输入 token 递增是辅助现象，不能单独证明缓存命中。

用户当前配置只发送最近约5层正文：即使 memory hash=B、B，正文窗口本身仍可能滑动，Stable Prefix 会在 other prompt/history 断开；输入 token 也可能无法持续增长。本插件没有增加第二次裁剪。要验证整个历史的连续增长，需要 ST 同时允许增长的历史并有足够 Context Size；不能靠插件的冻结记忆消除本体窗口变化。遇到断点依次排查 context size、滑动历史、RAG/向量、World Info、Author’s Note、Prompt Manager 和其他扩展。

## 已完成验证

- `npm run check`、`npm test`：统一运输、活 CSRF、secret 脱敏、代理200错误、任何失败都禁止direct、body阶段取消、两种输出上限及兼容请求体；严格模式1–4/6–9 hash、CP追加、Long覆盖CP但存档保留、已发布字节保护、失败重试、reload恢复、debug LCP。
- 完整105层后台测试：105 Summary、21 CP、2段 Long（1–50、51–100），主聊天对象深度比对不变；自动边界共21次刷新，50/100的双提交合并。
- 浏览器 UI 验证：1280×900桌面、390×844手机、180×90同源iframe的父级挂载、长错误滚动、已填模型的完整下拉选择、拖动松手清理、卸载后modal/style/scrollLock归零、重新挂载无重复。
- cross-origin parent 安全fallback与 visualViewport 参数有单元测试；100次 pointermove只测一次布局、只排队一个frame。
- TauriTavern 与真实火山请求未在当前环境联机验证。实现不依赖浏览器专用插件或直接第三方跨域；Tauri仍需提供对应原生ST路由和当前CSRF getter。

## v1.6.0 维护审查（2026-10-08）

- 修复无摘要楼层没有手动入口；手动生成与 autoSummarize 解耦，DOM 后加载时可显示已补齐摘要。
- 新增纯聊天数据驱动的历史补齐、串行队列、重复点击合并、暂停／继续／取消及两次限量重试。
- 批次通过 deferAggregates 延后聚合；强制补齐的 Summary 替换也以后台变更保存，不触发严格 Prompt 刷新。批次完成后以一次聚合事务提交新的冻结边界。
- 修复 Summary、Checkpoint、Long 的网络失败分支缺少聊天归属检查的问题；源正文在请求期间编辑／删除／切换 swipe 时不提交过期 Summary。热卸载同时使尚在队列中的任务失效。
- 单请求 AbortSignal 只中止该请求；批次取消不影响独立连接测试。诊断区分客户端 timeout、ST 后端／其网关失败以及代理明确透传的上游 504，未提供上游状态时不编造来源。
- 78 项测试通过，涵盖原有 105 层缓存回归和新增 50 层历史补齐验收；浏览器模拟页面验证桌面 1280×900、手机 390×844、版本标签、无摘要按钮、历史 DOM 延后加载、504 重试、暂停／继续／取消和卸载清理。聊天对象深度比对保持不变。
- 本轮未访问真实模型账户，不能据此确认部署服务器的 504 已消失；既有 60 秒设置保留，需要用户按实际服务配置调整。

## v1.7.0 流式传输审查（2026-10-08）

- v1.6.0 的 `buildPayload()` 与 ST `proxyPayload` 均硬编码 `stream:false`。v1.7.0 移除双重硬编码，自动模式和 Ark Coding Plan 均优先 `stream:true`。
- Summary、Checkpoint、Long Memory 和极速连接测试共用同一流式传输与 SSE 解析器；最终完整文本仍进入原有记忆解析流程。
- SSE 按 Content-Type 分流，支持跨网络 chunk 的 JSON 行、CRLF、`[DONE]`、普通 content 与 reasoning/thinking 字段。只有普通 content 在流结束后仍为空才失败。
- 自动回退要求受控 4xx 和明确的 stream 不支持错误同时成立；504、timeout、路由缺失、鉴权错误不回退。
- 所有生成继续只请求 ST 相对代理路径，不存在浏览器直连 Ark 的 fallback。Strict Cache、Checkpoint Boundary、聊天正文和注入刷新规则未改动。
- 对照的 shujuku `spv5.5.7` 独立 API 路径同样通过 ST `/generate`，其 `streamingEnabled` 开启时发送流式请求并用 reader/decoder 拼接 `delta.content`；该版本默认配置的流式开关为关闭。它还提供 TavernHelper 主 API和连接预设路径，这两种模式不适合直接复制到独立 Cache Memory 配置。
- 自动测试使用模拟 SSE/JSON 响应验证两种传输和计时字段，没有使用用户真实 Ark Key，无法代替部署环境中的同模型 504 对照测试。

## v1.12.0 维护审查（2026-10-08）

- 记忆管理与设置共用 `bindDialogDrag()`；标题栏内按钮和输入控件被排除在拖动起点之外。
- 清空当前聊天改用插件内确认弹窗，确认后仍调用既有 `clearCurrentChat()`；取消补齐、失效上下文、终止请求和清空注入的顺序未改变。
- 四类列表共用分页构造器，增加首页/末页/受限页码跳转与 Enter；既有筛选只改变展示集合，不影响 Store。
- Summary 完整编辑只调用 `updateSummary()`，同步结构化字段与 `raw`，不写 `message.mes`、不调用 API、不触发聚合；`registerSummaryKeeps()` 仍只新增，不因 Summary 修改或删除回删 Registry。
- 剧情时间/地点从完整 assistant `message.mes` 的明确标签、字段或数值时间中确定性提取；发送给模型的正文仍来自既有过滤器。模型返回的时间/地点不会覆盖提取值，缺失时保持空字符串。
- Checkpoint、Long Memory 和 KEEP 的元数据由来源 Summary 确定性投影；Store v3→v4 只补 KEEP 元数据空字段，不调用模型或重建旧 Summary/Checkpoint/Long Memory。
- Strict Cache、Checkpoint Boundary、注入投影、历史补齐、KEEP Registry 状态机和 API transport 的控制路径未改变。100 项模拟自动测试、语法检查与补丁空白检查通过；未调用真实模型 API。

## v1.13.0 维护审查（2026-10-08）

- Checkpoint 展示改为 Story So Far、Characters、Current State、Secrets & Knowledge、Open Threads、Continuity Locks 六个结构化栏目；KEEP 生命周期增量不进入普通正文栏目。
- Summary、Checkpoint、Long Fact/旧 Long Memory 与 KEEP 全部在当前展开卡片内切换编辑表单；保存后原地恢复，取消不写 Store。Summary 同步重建 `raw`，Checkpoint 同步重建结构化 `content`，Fact 编辑保持 fact-id 与来源字段不变。
- 移除 UI 中的浏览器原生 `prompt/confirm`；编辑不调用模型、不改 `message.mes`、不自动重算其他记忆层。Summary 删除或修改 KEEP 仍不回删 Registry。
- 各记忆页隐藏 `createdAt/updatedAt`，仅展示明确剧情时间、剧情时间范围与地点；缺失值显示“未提供”。数据字段仍原样保留。
- 默认 Checkpoint/Long Memory 提示词补充时间元数据约束，旧默认提示词指纹会自动迁移，用户自定义提示词保持不变。
- Summary、Checkpoint、Long Memory 三个默认 Prompt 共用同一段第三方客观记录约束；人物认知不升级为事实，明示心理保留主体归属，具体亲密/冲突行为不自动推导关系结论。
- 定向语法检查、Checkpoint 结构解析/重建、Fact 身份与来源保持、提示词迁移及相关记忆链路测试通过；未调用真实模型 API。

## v1.14.0 维护审查（2026-10-08）

- 记忆管理由独立可拖动弹窗改为设置窗口第五个顶部页签；原侧栏入口仍保留，但只负责打开设置并切换页签。
- 管理页继续使用原有概览、摘要、Checkpoint、长期事实与 KEEP 内部分页，导入、导出、清空、编辑及历史补齐逻辑未改变。
- KEEP 卡片默认不再预留选择框；点击“批量编辑”后才显示当前页选择框、全选/清空选择及批量状态操作，退出时清空临时选择。
- JavaScript 语法、页签模板、KEEP 批量模式切换及补丁空白检查通过；未调用模型 API。
