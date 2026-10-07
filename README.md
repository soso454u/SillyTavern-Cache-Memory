# Cache Memory / Layer Memory

面向长篇 RP 的缓存友好型、追加式剧情记忆扩展。它在正常 assistant 回复完成后，通过完全独立的 OpenAI-compatible 接口生成楼层摘要，再逐层生成冻结的 Checkpoint 和 Long Memory。

## 兼容基线

开发时核对了工作区内 SillyTavern 前端源码，并与官方 `release` 分支 `1.19.0` 的接口约定交叉检查。扩展使用的公开接口如下：

- `eventSource` / `event_types.GENERATION_ENDED`：正常生成完成后排队生成楼层摘要。
- `CHAT_CHANGED`、`CHAT_LOADED`、`MESSAGE_EDITED`、`MESSAGE_DELETED`、`MESSAGE_SWIPED`：同步当前聊天、消息身份和展示状态。
- `chat`：只读 assistant 正文和消息属性；插件没有任何写入 `message.mes` 的代码。
- `chat_metadata` + `saveMetadataDebounced()`：保存当前聊天独有的记忆数据。
- `extension_settings` + `saveSettingsDebounced()`：保存全局扩展设置。
- `setExtensionPrompt()` + `extension_prompt_types.IN_PROMPT`：仅在用户开启注入时添加一个固定位置的 system 记忆块。

正常 assistant 楼层按 `!is_user && !is_system` 识别，并额外排除未经过生成的首条角色卡 greeting、narrator、小型系统消息和 tool invocation。SillyTavern 消息目前没有通用稳定 UUID，因此插件用角色、发送时间、生成开始时间和群聊生成 ID 组成稳定指纹，旧聊天缺少这些字段时才回退到内容指纹；编辑会标记 `Stale`，切换 swipe 会按事件给出的消息位置重新绑定，删除后的记录标记 `Orphaned`，不会误配给下一条消息。

## 安装

把整个目录放到 SillyTavern 的第三方扩展目录：

```text
SillyTavern/public/scripts/extensions/third-party/cache-memory/
```

目录内应直接包含 `manifest.json`、`index.js`、`style.css` 和 `src/`。刷新 SillyTavern 后，在“扩展”设置中展开 **Cache Memory**。

扩展设置页只保留启用开关、魔法棒入口开关和两个启动按钮。完整配置使用独立弹窗，可从扩展设置页的“打开设置”进入，也可从输入框旁的魔法棒扩展菜单点击 **Cache Memory** 进入。“在魔法棒菜单中显示”关闭后，该入口会立即隐藏。

也可以在 SillyTavern 的“下载扩展并安装”中填写：

```text
https://github.com/soso454u/SillyTavern-Cache-Memory
```

扩展 manifest 已启用仓库自动更新。

## 独立 API

在 **Cache Memory 设置弹窗 → 独立 API** 中填写：

- API Provider
- API Base URL，例如 `https://example.com/v1`
- API Key
- Model
- Temperature
- Max Tokens
- Timeout

请求直接发送到 `POST {API Base URL}/chat/completions`。如果填写的是完整 `/chat/completions` 地址，插件不会重复追加路径。请求体采用 OpenAI-compatible `model/messages/temperature/max_tokens` 格式，Key 通过 `Authorization: Bearer ...` 发送。

API Key 使用独立的浏览器 `localStorage` 项 `cache_memory_api_key_v1`，不写入聊天、`chat_metadata`、扩展设置，也不复用 SillyTavern 自带 API。这个方案与参考插件一致，但不是安全密钥库：同源网页脚本和能访问该浏览器配置的人可以读取它。目标接口还必须允许 SillyTavern 页面来源的 CORS。面板中的“测试 API”会返回连接状态、模型、HTTP 状态和耗时。

## 数据位置

每个聊天的数据保存在该聊天 JSONL 头部的：

```text
chat_metadata.cache_memory
```

结构包含 `summaries`、`checkpoints` 和 `longMemories`。聊天之间不会共享记忆。全局开关、间隔、Prompt 和非敏感 API 配置保存在：

```text
extension_settings.cache_memory
```

Memory Manager 支持浏览、手动编辑、删除、重新生成、导出 JSON 和导入 JSON。所有替换操作都要求用户点击；后台不会自动重写已经冻结的历史块。

## 缓存与注入行为

默认 `Strict Cache Mode` 开启，记忆注入关闭。实现中没有 embedding、向量检索、语义相关度筛选、随机顺序或每轮总总结。

可选注入模式为：

- 不注入
- Long Memory
- Long + Checkpoint
- Long + Checkpoint + Recent

注入内容始终按楼层从旧到新生成，并固定使用一个 `<CACHE_MEMORY>` 块。已被 Long Memory 覆盖的 Checkpoint 不重复注入。所有自动生成只追加新范围；旧摘要、旧 Checkpoint 和旧 Long Memory 不会因后续剧情变化而自动重写。

## 验证

```bash
npm run check
npm test
```

测试覆盖 assistant 楼层过滤、冻结记录不覆盖、消息移动/编辑同步、确定性注入、Checkpoint/Long 聚合、聚合失败隔离、切换聊天时丢弃迟到响应，以及独立 API URL 和 Bearer Header。
