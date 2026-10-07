# 缓存记忆 / Cache Memory

面向长篇 RP 的追加式剧情记忆扩展。正常 assistant 回复完成后，通过独立 OpenAI-compatible 接口生成楼层摘要，并增量维护 Checkpoint 世界状态、长期事实档案和 KEEP 不可丢失事项。历史记录保留为冻结快照。

## 兼容基线

开发时核对了工作区内 SillyTavern 前端源码，并与官方 `release` 分支 `1.19.0` 的接口约定交叉检查。扩展使用的公开接口如下：

- `eventSource` / `event_types.GENERATION_ENDED`：正常生成完成后排队生成楼层摘要。
- `CHAT_CHANGED`、`CHAT_LOADED`、`MESSAGE_EDITED`、`MESSAGE_DELETED`、`MESSAGE_SWIPED`：同步当前聊天、消息身份和展示状态。
- `chat`：只读 assistant 正文和消息属性；插件没有任何写入 `message.mes` 的代码。
- `chat_metadata` + `saveMetadataDebounced()`：保存当前聊天独有的记忆数据。
- `extension_settings` + `saveSettingsDebounced()`：保存全局扩展设置。
- `setExtensionPrompt()` + `extension_prompt_types.IN_PROMPT`：仅在用户开启注入时添加一个固定位置的 system 记忆块。

正常助手楼层按 `!is_user && !is_system` 识别，并额外排除未经过生成的首条角色卡开场白、旁白、小型系统消息和工具调用。SillyTavern 消息目前没有通用稳定 UUID，因此插件用角色、发送时间、生成开始时间和群聊生成 ID 组成稳定指纹，旧聊天缺少这些字段时才回退到内容指纹；编辑会标记为“需要更新”，切换备选回复会按事件给出的消息位置重新绑定，删除后的记录标记为“原文已删除”，不会误配给下一条消息。

## 安装

把整个目录放到 SillyTavern 的第三方扩展目录：

```text
SillyTavern/public/scripts/extensions/third-party/cache-memory/
```

目录内应直接包含 `manifest.json`、`index.js`、`style.css` 和 `src/`。刷新 SillyTavern 后，在“扩展”设置中展开 **缓存记忆**。

扩展设置页只保留启用开关、魔法棒入口开关和两个启动按钮。完整配置使用独立的高对比度中文弹窗，可拖动标题栏移动；长错误在限定高度的状态区内独立滚动，正文设置区也可滚动。可从扩展设置页的“打开设置”进入，也可从输入框旁的魔法棒扩展菜单点击 **缓存记忆** 进入。“在魔法棒菜单中显示”关闭后，该入口会立即隐藏。

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

模型列表先由浏览器直接以 `GET` 请求，若网络/CORS 层失败，会自动回退到 SillyTavern 的相对路径 `/api/backends/chat-completions/status` 代理。每次代理请求实时从最上层可访问的 SillyTavern 页面 `getContext().getRequestHeaders()`（兼容旧版页面 getter）获取当前 CSRF 请求头，并使用该页面的 fetch 和同源 cookie。拿不到有效请求头时显示“无法获取 SillyTavern CSRF 请求头”，不会发送缺少 token 的请求。失败时界面显示“模型列表获取失败”，附最终 models URL、HTTP 状态（未收到响应时明确标注）、响应正文前 500 字、fetch 异常消息及是否疑似 CORS；若尝试了代理，也会保留代理 URL、状态、响应和异常。浏览器的网络错误无法确定是否由 CORS 引起，提示仅供排查。超时和取消也会保留请求地址。开发者控制台同步输出诊断，仅记录是否获取到请求头以及 header key 列表，不输出 header value；URL、响应和异常中的 API Key、当前 CSRF token 会先脱敏再截断。部分兼容服务不开放 `/models`，此时可以手动填写模型并用“测试连接”验证聊天接口。

API 密钥使用独立的浏览器 `localStorage` 项 `cache_memory_api_key_v1`，不写入聊天、`chat_metadata`、扩展设置，也不复用 SillyTavern 自带 API。它不是安全密钥库：同源网页脚本和能访问该浏览器配置的人可以读取它。目标接口还必须允许 SillyTavern 页面来源的跨域请求。面板中的“测试连接”会返回连接状态、模型、HTTP 状态和耗时。

## 长期连续性（1.4.0）

默认策略是 **增量状态 + 长期事实 + KEEP**。新安装默认小总结目标 500 字、每 10 个 assistant 楼层生成 Checkpoint、阶段状态目标 1500 字、最大输出 3200 tokens。已有间隔、长度和自定义提示词保留；旧版原装提示词会自动换为新规则，可在“常规”选择旧版分段摘要策略。

- 楼层摘要使用 `[Event]`、`[State]`、`[Open]`、`[Quote]` 和 `[KEEP]` 结构，区分事实与猜测，记录完整因果和人物认知差。新策略的字符长度是软目标，保存时不硬截断。模型返回 `finish_reason: length` 会报错要求提高输出上限，不把截断结果当作成功记忆；重新生成失败也不会覆盖原有有效内容。
- Checkpoint 输入是上一份有效世界状态、长期事实、有效 KEEP 与本阶段新增摘要。新状态保存为下一条冻结记录，不自动改写上一条。首次从旧策略过渡时会读取保留的历史 Checkpoint 和长期记忆作为基线；既有聊天数据无需清空。
- 每个新 Checkpoint 后检查长期事实，只保存新增事实或明确变更的增量。没有新增时保留一次检查记录，不重复添加事实；不再等待固定长期楼层间隔把多个摘要压成大摘要。事实的替代/失效保留原记录及证据，不因长期未出现就删除。
- KEEP 和未解决 `[Open]` 事项独立建立稳定 ID。模型漏写不会丢掉它们；只有 `[RESOLVED_KEEP]` 引用现有 ID、给出原因和本阶段新摘要中的逐字证据，才标为已解决。历史条目仍保留。长期事实的 `[UPDATED_FACTS]` / `[RETIRED_FACTS]` 也必须提供新摘要证据。
- 选择“长期记忆 + 阶段记忆 + 近期小总结”时，固定组合当前长期事实、有效 KEEP、最新完整状态，以及该状态之后的全部有效小总结。旧版近期数量限制只用于旧策略，避免新策略在 Checkpoint 后产生摘要缺口。最近原始正文由 SillyTavern 本身的聊天上下文提供。记忆管理可查看当前事实与有效 KEEP。

事实、因果、未解决事项和人物认知差优先于 token 节省，因此上下文和独立摘要请求的用量可能增加。默认仍不自动开启记忆注入，需在“记忆注入”中选择所需范围。此策略保持固定顺序，不增加语义检索或随机召回。

## 数据位置

每个聊天的数据保存在该聊天 JSONL 头部的：

```text
chat_metadata.cache_memory
```

数据版本为 2，结构仍包含 `summaries`、`checkpoints` 和 `longMemories`。新状态记录附有 `memoryKind: state`、来源摘要 ID 和 `keepItems`；新长期记录附有 `memoryKind: facts` 和 `factUpdates`，旧条目原样保留。聊天之间不会共享记忆。全局开关、间隔、Prompt 和非敏感 API 配置保存在：

```text
extension_settings.cache_memory
```

“记忆管理”支持浏览、手动编辑、删除、重新生成、导出 JSON 和导入 JSON。所有替换操作都要求用户点击；后台不会自动重写已经冻结的历史块。

## 缓存与注入行为

默认“严格缓存模式”开启，记忆注入关闭。新策略的当前状态组合可能改变注入前缀；这里的严格模式保证历史记忆不会被后台自动覆盖，并不保证跨 Checkpoint 的注入文本前缀不变。实现中没有向量嵌入、向量检索、语义相关度筛选、随机顺序或每轮总总结。

可选注入模式为：

- 不注入
- 仅长期记忆
- 长期记忆 + 阶段记忆
- 长期记忆 + 阶段记忆 + 近期小总结

注入内容始终按楼层从旧到新生成，并固定使用一个 `<CACHE_MEMORY>` 块。已被长期记忆覆盖的阶段记忆不会重复注入。所有自动生成只追加新范围；旧摘要、旧阶段记忆和旧长期记忆不会因后续剧情变化而自动重写。

## 热更新兼容

版本 1.2.0 起实现了 `SillyTavern-Extension-Hot-Reload` 的生命周期协议。更新或禁用时会取消事件监听、计时器、观察器、未完成的接口请求并移除插件界面；所有本地 ES Module 导入也使用版本化地址，避免热更新后混用新旧模块。版本 1.3.0 起，旧版 provider 配置会自动迁移为统一的 OpenAI-compatible provider，并保留原有地址和模型。

## 验证

```bash
npm run check
npm test
```

测试覆盖楼层过滤、冻结历史保护、消息同步、确定性注入、聚合失败/切换聊天隔离、独立 API、实时 CSRF 及 iframe 代理、诊断脱敏、旧数据/提示词迁移、KEEP 继承/解除、事实替代和字符/token 截断保护。
