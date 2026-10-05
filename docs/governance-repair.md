# 运行时治理修复验收

2026-10-05，Windows，Codex CLI 0.155.1。保留原 `agent-loop`，修复新增项目 Loop 的治理边界。
私有项目源码、凭证、完整模型日志和本机路径不公开。公开 JSON 只保留本仓库测试 fixture 的脱敏结果。

## 修复内容

- Codex 忽略用户配置和规则，清除除认证目录外的继承 `CODEX_*` 环境变量；禁用 MCP、插件、hook、JS、浏览器和额外 Agent 通道。
  Windows 显式配置原生 sandbox，防止忽略用户配置后写任务意外降为只读。原生额度错误立即失败并隔离 provider。
- 默认普通全局决策优先 DSH；高风险或连续两轮失败时优先 Codex。显式 `decisionAgent` 偏好仍可保留，离线或额度耗尽时选择其他 reasoner。
- 优先级统一为 0..100，越大越紧急。拒绝非写入类型的执行候选和未注册/合并成字符串的 capability。
- Builder 没改源码时记为 `NO_CHANGE`，不创建假进展 commit，不推进 acceptedHead。
- Host 用实际敏感路径和变更内容提升风险。高风险审核先分配 security Reviewer，再分配一般 Reviewer，避免抢占唯一 security provider；两者都独立于 Builder。
- 审核同时提供本次行动 delta 和相对已接受版本的累计 diff。行动文件范围约束适用于本次 delta，整体产品验收仍适用于累计候选。
- 测试通过但候选尚未独立接受时，决策模型的 complete 会被拒绝；原有 Host 完成 Gate 继续生效。
- 源码预算按 UTF-8 字节计算并在目录间分配，提供缺失/截断清单；认证源码可以进入观察，凭证文件仍排除。
  观察存入独立 artifact，World State 保存引用，模型测试输出截断但完整 Host 日志保留。

## 实际验证

| 验证 | 结果 | 证据 |
| --- | --- | --- |
| 完整运行时回归 | 47/47 PASS | `npm test`，含实际 Windows 进程、Git worktree 和 HTTP 检查 |
| Codex 原生工具暴露边界 | PASS | [工具清单](validation/governance-codex-boundary.json) |
| Codex 实际写入 + DSH 独立审核 | PASS | [写入记录](validation/governance-codex-worker.json) |
| 真实自主 Loop，失败/拒审后重新规划 | PASS，7 个验收检查通过 | [E2E](validation/governance-e2e.json) |
| 修复源码独立 Pi 审核 | PASS，无 blockingRisks/findings | [独立审核](validation/governance-review.json) |

工具清单检查启动真实 Codex CLI，把模型请求送到本地模拟推理端点读取实际工具清单；该检查没有调用真实模型。
它确认 shell、MCP/cua、JS、浏览器、web search 和 subagent 工具未暴露，同时写任务的原生权限是 workspace-write。
另一次真实 Codex Worker 写入完成了源码修改、Host 测试和 DSH 审核，验证正常工作能力。

真实 E2E 使用 `decisionAgent: auto`，没有 TODO 顺序或预设模型 verdict。
它有数量计算错误、隐藏 checkout 按钮，并在 Builder 停止后明确记录和注入一次配送故障。

| 轮次 | Builder | 结果 | Reviewer |
| --- | --- | --- | --- |
| 1 | DSH | FAILED，重新诊断 | 尚未进入审核 |
| 2 | OpenCode | REJECTED | Pi |
| 3 | Pi | MERGE_READY | DSH |

最后重新观察项目才宣布完成，7 个检查包括强制审核、拒审后重规划、可追溯 commit、主 checkout 未修改、重启状态保留。
最终候选 commit 为 `1a7700ca4592d22b5160983000d1d8663c20cb93`，这是本地 fixture commit，不是 GitHub 产品提交。
本轮 E2E 配置隔离了已耗尽额度的 Codex；Codex 的实际写入能力由上面的单独试跑验证，不能把两次实验说成同一次四 Worker E2E。

复测保留了失败记录：旧响应中 `code/debug` 合并能力名称无法调度；旧审核把继承变更错误归入本次行动范围；
旧决策在绿色测试但候选已拒审时尝试宣布完成，被 Host 拒绝。修复后重新启动完整实验，没有修改失败 verdict 来制造 PASS。
两次 DSH 源码审核未在预算内返回完整报告，之后使用独立 Pi 审核成功；超时不计为通过。

## 边界

这次验收证明本地 V1 治理修复，不代表商业项目无人值守运行一天已经达标。
风险识别是 Host 最低保护的启发式规则，仍可能漏掉语义层面的敏感变更；源码摘要有明确覆盖范围，并非完整项目理解。
观察归档降低重复持久化，但行动历史、artifact 和保留 worktree 仍需要长期归档策略。
工具边界验证限于当前 Windows/CLI 版本；外部 MCP 进程仍不能由 Worker Job Object 管理，其他部署策略需另测。
原电商压力验收和浏览器验收记录仍是独立实验，未把本轮 fixture 结果替代成电商全量重测。

复现入口：`npm test`、`node scripts/live-workers.mjs config.local.json codex`、
`npm run test:live -- config.local.json`。真实模型实验需要自己的 CLI 凭证和额度，结果可能因模型选择而不同。
