# DSH Web — Multi-Agent Autonomous Runtime

保留 DSH 原来的 `agent-loop`，通过 Cordis 插件增加项目控制 Loop。
控制器根据当前源码、测试、失败与审核重新诊断 Gap，再选择 Worker。
每个 Worker 只执行一次 Action；进程停止后必须进入独立 Review Gate。
Builder 的“完成”不能放行，只有 Host 测试、受保护文件检查和独立审核全部通过才产生 `MERGE_READY`。

```text
Observe → Diagnose → Candidates → Select Worker → One Action
       ↑                                       ↓
       └──── Persist World State ← Independent Review ← Stop
```

原始接口 `ctx.autonomousControl.create()` 保留；新增
`ctx.autonomousControl.createProject(config, { agents })`。
Codex、OpenCode、Pi、DSH 使用统一的 start/send/cancel/status/result 契约，
分别通过原生 CLI JSON 或 SDK/RPC 运行。控制 Loop 没有固定的 Agent 队列。

## 启动

需要 Node.js 22+、Git，以及你要启用的 CLI 和各自登录凭证。

```sh
npm ci
npm test
npm start
```

打开 http://127.0.0.1:4780。未配置项目时显示空观察界面。
复制 `config.example.json` 为 `config.local.json`，设置已有 Git 仓库、仓库外的 stateDir、
目标、成功标准、受保护测试路径和 Host 测试 argv，再运行：

```sh
npm start -- --config config.local.json
# 或运行有行动数量上限的 CLI：
node runtime/cli.mjs --config config.local.json --run
```

Windows 建议配置原生 `.exe` 的绝对路径，或 `executable: "node"` 加
`argsPrefix: ["CLI入口的绝对路径"]`；不执行 `.cmd`、`.bat` 和拼接 shell 命令。
凭证继续由各 CLI 自己管理，不写入项目配置或仓库。

## 治理与恢复

- 每次决策、构建和审核都有独立 Git worktree。审核绑定 commit 和源码快照。
- World State、日志、测试、diff、review 保存在 stateDir；写入使用原子替换。
- UI 显示目标、状态、Gap、决策、行动、Agent、测试与审核证据；支持启动、在行动边界暂停和取消。
- 默认禁用 Worker shell、网络、commit 和额外 Agent 调度。Host 执行配置中的测试并创建候选 commit。
- 高风险行动必须经过两个独立 Reviewer，其中一个具有 security 能力。
- 审核失败后重新诊断，可以修复或放弃候选；连续失败影响 Worker 评分并触发替换。
- 主 checkout 不自动合并。`acceptedHead` 指向已审核候选，人工可以检查后合并。
- 崩溃状态不能直接续写；`recoverInterruptedProject(config)` 验证 PID 指纹并停止残留 Worker，再允许重新规划。
  手动恢复入口：`node scripts/recover-project.mjs config.local.json`。
  Windows 使用 Job Object，在 Worker 执行前绑定进程组，并在正常退出或崩溃时回收子进程。
- `node scripts/watchdog.mjs recovery-config.json` 是独立于 DSH 启动的最小恢复入口。
  必须配置 `harness.executable/args` 和 `recovery.enabled/repository/codex/tests/protectedPaths`。
  独立 Codex 修复、Host 测试、另一只读 Codex 审核后，才允许从候选 worktree 重启；
  `recovery.restartFromWorktree` 默认关闭。

权限通过原生 Codex sandbox、OpenCode permission、Pi tool hook、DSH sandbox 和 tool guard 实现。
2026-10-04 的真实电商压力验收发现：原生 Codex CLI 仍继承了 MCP JS 工具，
并在 `shell: false` 时通过它启动了 `cmd.exe`。当前 Codex adapter 的 connector/plugin 禁用措施
不足，不能把 shell/network/read-only 配置视为已完整隔离；Windows Job Object 也不能约束
在外部 MCP 服务里启动的进程。在修复并验证这一边界前，应禁用原生 Codex 的执行角色
（例如配置 `"roles": []`）；同一 adapter 的恢复入口也受此限制。本次实验已隔离该通道。
这不是恶意第三方可执行文件的操作系统隔离平台；非 Codex provider 的 unrestricted shell 配置会被拒绝。
测试命令和插件属于可信 Host 配置。源码注入内容没有调度权限。

## 验证

```sh
npm test
npm run test:agents -- config.local.json
node scripts/live-workers.mjs config.local.json
npm run test:live -- config.local.json
node scripts/live-recovery.mjs config.local.json
```

自动测试包含明确标注的 test-double 决策，用于确定性验证 Gate、回归拒审、worktree、重启和恢复。
`test:agents` 使用真实 provider 验证连接；`live-workers` 验证四种真实写入及独立审核。
`test:live` 使用实际模型重新诊断，没有 TODO 顺序或预设审核结论；它在第一次 Builder 停止后
记录并注入一次配送回归，要求真实测试和 Reviewer 拒绝，再重新规划。
报告写入 `.tmp/`。恢复测试验证独立启动故障 fixture，不代表已覆盖所有生产 Harness 故障。
临时 observe/review worktree 与分支自动清理；候选 build checkout/分支保留供审查、恢复和人工合并。

最终完成标准以 [PROJECT_SPEC.md](PROJECT_SPEC.md) 为准。
具体验收记录见 [validation](docs/validation.md)。
真实项目试跑及已发现的限制见 [ecommerce stress pilot](docs/ecommerce-stress-pilot.md)。
插件接入旧 Host 的示例见 [autonomous-control-loop](plugins/autonomous-control-loop/README.md)。
