# V1 验证记录

2026-10-04，Windows，Node.js 24。GitHub CI 使用 Windows + Node.js 22。
原始本地日志和 Agent 凭证不上传；下列 JSON 是脱敏后的实际运行记录。

本页下表是 2026-10-04 的初始验收。2026-10-05 的治理修复已完成 47/47 回归测试、
Codex 边界/实际写入重测、真实动态 Loop 和独立 Pi 源码复审；详见 [最新治理修复验收](governance-repair.md)。

| 验证 | 结果 | 证据 |
| --- | --- | --- |
| 原 loop 兼容与项目治理测试 | 36/36 PASS | `npm test`，包含真进程、Git worktree 和 HTTP 测试 |
| 四个真实 Worker 修改源码 | Codex / OpenCode / Pi / DSH 全部 PASS | [live-workers.json](validation/live-workers.json) |
| 动态多 Agent E2E | PASS，拒审后重新诊断与切换 Worker | [live-e2e.json](validation/live-e2e.json) |
| 独立 Codex 启动故障修复 | PASS，Host 测试 + 另一独立 Codex 审核 | [live-recovery.json](validation/live-recovery.json) |
| 独立 Codex 控制器源码复审 | PASS，无 blocking risks，源码未改 | [runtime-review.json](validation/runtime-review.json) |
| 浏览器验证 | 实际状态、测试证据可查看；checkout 按钮可见；无 console error | 本地 in-app browser，控制台 + 已审核 fixture |
| Windows 退出后子进程 | PASS | `Windows job stops descendants even when the Worker launcher exits first` |

## 真实 E2E 的输入和边界

fixture 同时含数量计算错误、隐藏 checkout 按钮和配送回归。
系统收到 Goal、Repository、Success Criteria、权限与 Host 测试配置，没有 TODO 顺序。
一次 Builder 停止后，fixture 记录并注入配送错误，确保真实测试与 Reviewer 必须处理拒审。
决策、修改、审核结论都由真实模型产生；控制器检测测试失败，不相信 Builder 的完成声明。

记录包含拒审候选、通过候选、Reviewer 身份、commit 和重启检查。
最终通过版本的主 checkout 仍是初始版本；候选在独立分支，供人工合并。
这里的故障注入是公开声明的对抗测试，不能当成自然发生的 Agent 回归统计。

## 修复与复审

真实验证先发现 OpenCode Windows edit permission 路径匹配错误、DSH 默认只读策略、
CLI 输出包含说明文字以及审核恢复问题；修复后重测。Worker 记录保留了最初 OpenCode
失败及修复后的通过结果。

独立源码审核促成了干净 commit 测试、审核自动重试、恢复启动日志、控制器指纹锁、
临时 worktree 清理，以及 Windows Job Object。部分模型判断与实际源码不符，
通过源码和反例测试核实，而不是按 Reviewer 的断言直接修改。最终复审报告为 PASS。

## 适用范围

本版是可信本地 Host 配置下的 V1。Loop 有行动数、进程时间和审核重试预算。
本地 HTTP 通过严格 Host、Origin、自定义头和无 CORS 保护浏览器边界；它不是多用户公网服务。
候选 build checkout 保留供恢复与审查，长时间使用需要运营层归档。

恢复验收使用独立损坏启动 fixture，证明不依赖 DSH boot 的 Codex 恢复路径；
没有宣称覆盖所有 DSH 生产故障。低层 test-double 测试用于确定性验证，
四 Worker 和真实 E2E 的结果另外记录，不能互相替代。
