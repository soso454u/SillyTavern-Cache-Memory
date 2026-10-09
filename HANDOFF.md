# 接续说明（2026-10-09，v1.21.0）

仓库：https://github.com/soso454u/SillyTavern-Cache-Memory 。目录 `/Volumes/Soivt39/sillytavern脚本插件合集/记忆总结`。先读本文件、P1_MAINTENANCE.md、git status/log；不要重复 P0 全仓重构，不用子代理、私人聊天或付费 API 测试。提交与推送以实际 git 结果为准。

本轮基于 a0b461f/v1.20.0，更新至 v1.21.0，Store 仍为 v6。已完成任务发布/结算/待领奖/失败语义、三份实际默认提示词、服务器重读/正常取消、同 ID 冲突的明确选择/备份/重新核对/读回、v6 导入预览与替换确认、CP 依赖版本/可证明的 stale 重验/有费用确认的单条与批量更新、状态与缺链原因分离、单一滚动及仅固定冻结提示和一级菜单。删除标记防旧副本合并复活记录，服务端插件也增加 tombstones 合并；旧服务端丢字段时停止虚报成功。详情与使用方式在 P1_MAINTENANCE.md / README.md。

缓存保持原默认 CP5/Long50、Strict Cache/Checkpoint Boundary、预算和 New API 配置。维护/导入/冲突选择只标记 snapshot.needsRebuild，value 字节保持到下个既有发布边界。不能新增默认付费调用或独立注入栏目。

仍需现场验收：实际 CP-033/035/036、第187层与8段CP的数据原因、真实手机后台/断网/ST部署、真实Claude token与缓存命中；没有读取私聊，不能唯一归因或声称永久丢失。旧 CP 缺完整历史校验时不擅自解除 stale；旧 JSON 身份无法证明时拒绝自动认领。原生 ST 无CAS，可选库仅单Node进程锁，历史备份受浏览器容量限制；不宣称严格跨设备事务或断电持久化。

测试与合成 UI 记录在 P1_MAINTENANCE.md；最终执行结果以本轮实际输出为准。可继续完善逐条冲突选择、旧作用域JSON显式身份确认等，但避免无关功能扩展。后续SQLite/零配置安装/任意楼层复制/完整聊天打包暂缓。
