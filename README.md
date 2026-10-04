# DSH Web 与上层自主 Loop

现有 DSH 和 `agent-loop` 保留。新增的本地插件实现项目行动之间的治理循环：
选择行动、启动 Worker、确认停止、独立审核、持久化 World State、重新决策。

接入方式、Worker/Reviewer 契约和当前边界见
[autonomous-control-loop](plugins/autonomous-control-loop/README.md)。

运行验证：`npm test`。
