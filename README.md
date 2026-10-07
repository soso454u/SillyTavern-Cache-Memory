# 缓存记忆 / Cache Memory

面向长篇 RP 的追加式剧情记忆扩展。正常 assistant 回复完成后，通过独立 OpenAI-compatible 接口生成楼层摘要，并增量维护 Checkpoint 世界状态、长期事实档案和 KEEP 不可丢失事项。历史记录保留为冻结快照。

当前版本 **v1.6.0**，扩展栏“缓存记忆”标题和设置弹窗标题均显示版本号。

## 手动总结与历史补齐

关闭“自动生成小总结”后，每条正常 assistant 楼层仍显示“本层记忆”入口。没有摘要时可点击“生成本层记忆”；生成中按钮禁用；失败时保留错误分类和“重试”；已有摘要可重新生成、编辑或删除。旧消息加载到页面后也会显示对应入口。

打开“记忆管理”，顶部的“历史楼层补齐”直接扫描当前聊天数据，旧楼层无需先滚动加载，也不要求聊天开始时已安装插件。选择开始／结束楼层，再选择“仅缺失”“仅失败”“缺失 + 失败”或“强制重新生成全部”。快捷按钮可补齐全部缺失、重试全部失败或总结最新层。

- 每次只处理一层，显示总数、当前楼层、成功／失败／跳过次数和进度条。
- 暂停会等当前请求结束，再停在下一层或下一次重试之前；继续从原位置处理。取消会中止当前批次请求，保留已经生成的记忆。
- 客户端超时、HTTP 429、502、503、504 最多额外重试两次，分别等待 2 秒和 5 秒；401／403／404 不自动重试。单层失败会继续后续楼层。
- 批次结束或取消后，对已成功补齐的摘要统一检查一次 Checkpoint／Long Memory。切换聊天或卸载时取消批次，迟到的成功与失败响应都不会写入新聊天。
- 补齐只写插件元数据，聊天正文和消息顺序保持不变。严格缓存模式下，批量补齐或强制替换单层摘要不刷新主 Prompt；新的 Checkpoint／Long Memory 边界成功提交时才更新注入。强制补齐不会自动重写已经冻结的阶段记忆。

默认增量 Summary／Checkpoint／Long Memory 提示词已更新，保留事实因果、人物认知差、稳定 KEEP／fact ID 和逐字证据规则。旧默认模板会迁移；自定义模板保留，也可在提示词页点击“恢复默认”。新配置默认输出上限为 4096 tokens、超时为 180000 毫秒，已有自定义值保留。已有 60000 毫秒配置需在“模型接口”手动调高；若仍约 60 秒收到 504，需要检查 ST 后端及服务器网关的超时。

## 兼容基线

1.5.1 开发时核对了 SillyTavern 官方 `release` 分支的 custom 后端路由和发送前事件；当前用户安装版本仍需联机验证。扩展使用的公开接口如下：

- `eventSource` / `event_types.GENERATION_ENDED`：正常生成完成后排队生成楼层摘要。
- `CHAT_CHANGED`、`CHAT_LOADED`、`MESSAGE_EDITED`、`MESSAGE_DELETED`、`MESSAGE_SWIPED`：同步当前聊天、消息身份和展示状态。
- `chat`：只读 assistant 正文和消息属性；插件没有任何写入 `message.mes` 的代码。
- `chat_metadata` + `saveMetadataDebounced()`：保存当前聊天独有的记忆数据。
- `extension_settings` + `saveSettingsDebounced()`：保存全局扩展设置。
- `setExtensionPrompt()` + `extension_prompt_types.IN_PROMPT`：仅在用户开启注入时添加 system 记忆块；严格模式由持久化冻结快照控制内容变化，固定位置本身不代表缓存安全。

正常助手楼层按 `!is_user && !is_system` 识别，并额外排除未经过生成的首条角色卡开场白、旁白、小型系统消息和工具调用。SillyTavern 消息目前没有通用稳定 UUID，因此插件用角色、发送时间、生成开始时间和群聊生成 ID 组成稳定指纹，旧聊天缺少这些字段时才回退到内容指纹；编辑会标记为“需要更新”，切换备选回复会按事件给出的消息位置重新绑定，删除后的记录标记为“原文已删除”，不会误配给下一条消息。

## 安装

把整个目录放到 SillyTavern 的第三方扩展目录：

```text
SillyTavern/public/scripts/extensions/third-party/cache-memory/
```

目录内应直接包含 `manifest.json`、`index.js`、`style.css` 和 `src/`。刷新 SillyTavern 后，在“扩展”设置中展开 **缓存记忆**。

扩展设置页只保留启用开关、魔法棒入口开关和两个启动按钮。完整配置优先挂载到可访问的父页面 body，并在父页面 head 加载样式；跨域访问失败时回到当前 document。窗口使用固定定位、实体浅色面板和深色模糊遮罩，可拖动标题栏移动；拖动以 requestAnimationFrame 合并 transform 更新，移动过程中不反复测量布局。长错误在限定高度的状态区内独立滚动，正文设置区也可滚动。可从扩展设置页的“打开设置”进入，也可从输入框旁的魔法棒扩展菜单点击 **缓存记忆** 进入。“在魔法棒菜单中显示”关闭后，该入口会立即隐藏。

也可以在 SillyTavern 的“下载扩展并安装”中填写：

```text
https://github.com/soso454u/SillyTavern-Cache-Memory
```

扩展 manifest 已启用仓库自动更新。

## 模型接口

在 **缓存记忆设置弹窗 → 模型接口** 中按以下顺序设置：

- 填写任意 OpenAI-compatible 接口地址和 API 密钥；
- 点击“获取模型列表”刷新候选项；手动填写模型名称，或从输入框下方的完整模型列表选择。有文字时列表也不会被过滤，获取失败保留上次成功的候选项；
- 点击“测试连接”。

纯 origin 地址（例如 `https://example.com`）会补成 `/v1`；已有 `/v1`、`/v2`、`/v3` 或 `/api/...` 等路径会保留。生成请求发送到 `POST {base}/chat/completions`，模型列表从 `GET {base}/models` 获取；填写完整 `/chat/completions` 地址也会正确推导同一 base。请求体采用 OpenAI 兼容格式，密钥通过 `Authorization: Bearer ...` 发送。

模型列表、测试连接、Summary、Checkpoint 和 Long Memory 统一使用 `requestOpenAICompatible()`，并且只允许请求 SillyTavern 同源后端。缺少 ST 上下文、CSRF 请求头或代理路由时直接失败，不会携带 Authorization 从浏览器请求第三方 URL。

- models：相对路径 `POST /api/backends/chat-completions/status`；
- completions：相对路径 `POST /api/backends/chat-completions/generate`；
- 每次实时复用最上层可访问的 ST 页面 `getContext().getRequestHeaders()`（兼容页面 getter），使用该窗口的 fetch 和同源 cookie；不缓存 headers/token，不伪造 CSRF，不发送仅有 Content-Type 的代理请求；
- 请求体使用 `chat_completion_source: custom`、保留原路径的 `custom_url`、JSON 格式的 `custom_include_headers`（ST 的 YAML 解析器兼容 JSON），以及 model/messages/temperature/输出上限；`response_format`、thinking 等兼容字段同时通过 `custom_include_body` 交给 ST 服务端合并；测试连接也调用实际生成的 `complete()`；
- 输出上限参数可选择 `max_tokens` 或 `max_completion_tokens`。收到明确的 max_tokens 参数拒绝时，统一生成函数会改用后者再试一次，不移除输出限制。

例如火山 base `https://ark.cn-beijing.volces.com/api/coding/v3` 的目标为 `/api/coding/v3/models` 与 `/api/coding/v3/chat/completions`，不会追加 `/v1`。独立记忆请求不会修改 ST 主聊天的接口配置、模型或历史。

失败显示目标 URL、代理 HTTP、可获得的上游 HTTP、错误分类、响应前 500 字和 fetch 异常。ST 的部分版本用 HTTP 200 包装 `{error: ...}`，且不透传上游状态/原始响应；插件会识别为失败并明确显示“上游未提供”，不编造 HTTP 状态。此时需查看 ST 服务端日志获得上游原始错误。console 中的响应和异常先脱敏再截断；请求头仅打印 getter 是否找到、获取是否成功及 key 列表，API Key、header value 和 CSRF token 不输出。

API 密钥仍仅存当前浏览器 `localStorage` 项 `cache_memory_api_key_v1`，不进入记忆导出或扩展设置。它不是安全密钥库，同源脚本可以读取。ST 代理成功不要求第三方 API 开放浏览器 CORS。

## 冻结边界与长期连续性（1.5.1）

新安装默认 **严格缓存模式开启 / 不注入 / Checkpoint 5 层 / Long Memory 50 层**。已有自定义间隔、长度、提示词和旧聊天记忆保留；若旧设置为 10/100，需自行改为 5/50。只让主模型读取最近约 5 层正文时，建议选择 **Checkpoint 边界**，而非保持不注入。Long 间隔会向上对齐为 CP 间隔的整数倍。

- 每个正常 assistant 正文后台生成 Summary，结构包含事件、状态、未解决事项、认知差和 KEEP；新策略长度为软目标，不硬截断。达到模型输出 token 上限会提示重试，并保留已有有效记忆。
- Checkpoint 以“上一份有效状态 + 本阶段新增摘要 + 长期事实 + KEEP”维护连续性，生成下一条冻结记录。不会后台覆盖旧 Checkpoint。
- Long Memory 等待完整的配置区间：新聊天默认 Long 001=1–50、Long 002=51–100。记录只含该阶段新增长期事实及有证据的变更，不将旧 Long 改写为截至当前的总档案。旧聊天从最后一段已冻结范围之后继续，不重新切割既有记录。
- KEEP 和长期事实的解决/替代/失效需要新增摘要中的逐字证据，原记录保留。严格注入只显示已验证的事实变更及冻结 KEEP，模型在原始输出中提出的无证据删除不会进入事实注入。
- Long 覆盖整段 CP 后，严格快照可在该 Long 边界移除重复 CP 注入，但 CP 数据仍留在聊天元数据。自动后台任务不能改写已发布冻结块的正文。用户主动编辑/删除/重新生成/导入记忆属于明确的手动更新。

## 缓存与注入行为

| 策略 | 严格模式下何时更新 |
| --- | --- |
| 不注入（默认） | 始终为空，后台记忆正常生成 |
| Checkpoint 边界 | CP 成功提交；Long 成功提交时可合并其覆盖的 CP |
| Long Memory 边界 | 只有 Long 成功提交 |

CP/Long 在同一轮自动聚合完成时合并为一次刷新。Long 失败则仍发布已成功的 CP；失败/缺失摘要不会发布未完成的块。阶段间逐字冻结，不包含滚动的近期 Summary、逐层变化的事实投影或 KEEP。旧的“近期小总结”选项在严格模式自动降级为 Checkpoint 边界，并显示警示。

除了成功的边界提交，只有用户主动修改/删除记忆、修改注入设置、切换聊天允许刷新。快照按聊天保存，重载恢复原字节；后台 Summary 完成、消息身份同步、渲染、正文编辑/切换备选回复的元数据同步都不会刷新严格注入。手动更改和停用插件可以改变前缀。

关闭严格模式后，旧版近期 Summary 窗口、增量事实/KEEP 和最新状态组合仍可动态更新，不适合优先缓存的配置。插件没有修改、删除、裁剪或移动主 RP 正文，没有向量数据库、语义召回或相关度筛选，也不操作 Author’s Note、World Info 或 Prompt Manager 的历史深度。

**追加记忆也会改变其后面的历史前缀。** 本扩展保证的是变化只发生在允许的边界，而非边界更新后仍保持全部缓存命中。ST 本身只发送最近 5 层正文时，滑动窗口也可能造成前缀变化；这不由本插件控制。

## Cache Debug

在“记忆注入”开启 **Cache Debug / 缓存诊断**，查看面板或 console 的 `CACHE DEBUG`：chat ID、已完成 assistant floor、实际模式、strict、记忆字符数、当前/上次 hash、变化原因及预计影响。

ST 提供 `CHAT_COMPLETION_SETTINGS_READY` 时，只读发送前的 `messages`，保存 role + 消息 hash + 是否含 CACHE_MEMORY，比较最长公共消息前缀、上轮可复用百分比和首个断点。没有该事件时只检查记忆快照，并明确提示 messages 不可用。数据仅存在运行时，关闭诊断/卸载会清空，不保存完整 Prompt、Authorization 或 token。

这里的消息前缀百分比按消息粒度计算，不是 token 命中率；FNV-1a hash 用于变化诊断，不是密码学证明。事件之后其他扩展或 ST 服务端的处理可能继续改变上游 Prompt。缓存效果仍需结合上游 cached input/cache read 指标确认，输入 token 增长本身不是缓存命中的证明。

详细审计结论、兼容验证范围和三轮步骤见 [CACHE_AUDIT.md](CACHE_AUDIT.md)。

## 数据位置

每个聊天的数据保存在该聊天 JSONL 头部的：

```text
chat_metadata.cache_memory
```

数据版本为 2，结构仍包含 `summaries`、`checkpoints` 和 `longMemories`。新状态记录附有 `memoryKind: state`、来源摘要 ID 和 `keepItems`；新长期记录附有 `memoryKind: facts`、`factUpdates` 和冻结 KEEP；`injectionSnapshot` 保存按聊天冻结的注入快照，旧条目原样保留。聊天之间不会共享记忆。全局开关、间隔、Prompt 和非敏感 API 配置保存在：

```text
extension_settings.cache_memory
```

“记忆管理”支持浏览、手动编辑、删除、重新生成、导出 JSON 和导入 JSON。所有替换操作都要求用户点击；后台不会自动重写已经冻结的历史块。

## 热更新兼容

版本 1.2.0 起实现了 `SillyTavern-Extension-Hot-Reload` 的生命周期协议。更新或禁用时会取消事件监听、计时器、观察器、未完成的接口请求并移除插件界面；所有本地 ES Module 导入也使用版本化地址，避免热更新后混用新旧模块。版本 1.3.0 起，旧版 provider 配置会自动迁移为统一的 OpenAI-compatible provider，并保留原有地址和模型。

## 验证

```bash
npm run check
npm test
```

测试覆盖楼层过滤、冻结历史保护、消息同步、确定性注入、聚合失败/切换聊天隔离、独立 API、实时 CSRF 及 iframe 代理、诊断脱敏、旧数据/提示词迁移、KEEP 继承/解除、事实替代和字符/token 截断保护。

v1.6.0 验证：78 项自动测试通过；50 层旧聊天关闭自动总结后补齐 1–10 层，得到 Checkpoint 001（1–5）与 002（6–10），随后手动生成第 11 层；所有聊天对象深度比对不变。浏览器模拟 ST 页面验证了版本号、无摘要入口、旧 DOM 延后加载、504 重试、暂停／继续／取消、桌面和手机布局及卸载清理。自动测试与浏览器测试使用模拟模型响应，未调用真实账户或验证部署服务器的网关配置。
