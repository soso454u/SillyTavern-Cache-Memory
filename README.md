# 缓存记忆 / Cache Memory

面向长篇 RP 的缓存友好型、追加式剧情记忆扩展。它在正常 assistant 回复完成后，通过完全独立的 OpenAI-compatible 接口生成楼层摘要，再逐层生成冻结的 Checkpoint 和 Long Memory。

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

扩展设置页只保留启用开关、魔法棒入口开关和两个启动按钮。完整配置使用独立的高对比度中文弹窗，可从扩展设置页的“打开设置”进入，也可从输入框旁的魔法棒扩展菜单点击 **缓存记忆** 进入。“在魔法棒菜单中显示”关闭后，该入口会立即隐藏。

也可以在 SillyTavern 的“下载扩展并安装”中填写：

```text
https://github.com/soso454u/SillyTavern-Cache-Memory
```

扩展 manifest 已启用仓库自动更新。

## 模型接口

在 **缓存记忆设置弹窗 → 模型接口** 中按以下顺序设置：

- 选择“OpenAI 兼容接口”或“豆包方舟 Coding Plan”；
- 填写接口地址和 API 密钥；选择豆包时会自动填写 `https://ark.cn-beijing.volces.com/api/coding/v3`；
- 点击“获取模型列表”，然后选择或手动填写摘要模型；
- 点击“测试连接”。

生成请求直接发送到 `POST {接口地址}/chat/completions`，模型列表从 `GET {接口地址}/models` 获取。如果填写的是完整 `/chat/completions` 地址，插件不会重复追加路径。请求体采用 OpenAI 兼容的 `model/messages/temperature/max_tokens` 格式，密钥通过 `Authorization: Bearer ...` 发送。

方舟 Coding Plan 的模型列表接口并非在所有套餐中开放。远端列表不可用时，插件会自动提供一组官方文档中的预设模型，并优先推荐稳定别名 `ark-code-latest`。火山方舟官方同时说明，Coding Plan 个人版权益仅限 AI 编程工具使用；请先确认你的账号与套餐允许在 SillyTavern 插件中调用，避免产生额外费用或账号风险。

API 密钥使用独立的浏览器 `localStorage` 项 `cache_memory_api_key_v1`，不写入聊天、`chat_metadata`、扩展设置，也不复用 SillyTavern 自带 API。它不是安全密钥库：同源网页脚本和能访问该浏览器配置的人可以读取它。目标接口还必须允许 SillyTavern 页面来源的跨域请求。面板中的“测试连接”会返回连接状态、模型、HTTP 状态和耗时。

## 数据位置

每个聊天的数据保存在该聊天 JSONL 头部的：

```text
chat_metadata.cache_memory
```

结构包含 `summaries`、`checkpoints` 和 `longMemories`。聊天之间不会共享记忆。全局开关、间隔、Prompt 和非敏感 API 配置保存在：

```text
extension_settings.cache_memory
```

“记忆管理”支持浏览、手动编辑、删除、重新生成、导出 JSON 和导入 JSON。所有替换操作都要求用户点击；后台不会自动重写已经冻结的历史块。

## 缓存与注入行为

默认“严格缓存模式”开启，记忆注入关闭。实现中没有向量嵌入、向量检索、语义相关度筛选、随机顺序或每轮总总结。

可选注入模式为：

- 不注入
- 仅长期记忆
- 长期记忆 + 阶段记忆
- 长期记忆 + 阶段记忆 + 近期小总结

注入内容始终按楼层从旧到新生成，并固定使用一个 `<CACHE_MEMORY>` 块。已被长期记忆覆盖的阶段记忆不会重复注入。所有自动生成只追加新范围；旧摘要、旧阶段记忆和旧长期记忆不会因后续剧情变化而自动重写。

## 热更新兼容

版本 1.2.0 起实现了 `SillyTavern-Extension-Hot-Reload` 的生命周期协议。更新或禁用时会取消事件监听、计时器、观察器、未完成的接口请求并移除插件界面；所有本地 ES Module 导入也使用版本化地址，避免热更新后混用新旧模块。

## 验证

```bash
npm run check
npm test
```

测试覆盖 assistant 楼层过滤、冻结记录不覆盖、消息移动/编辑同步、确定性注入、Checkpoint/Long 聚合、聚合失败隔离、切换聊天时丢弃迟到响应，以及独立 API URL 和 Bearer Header。
