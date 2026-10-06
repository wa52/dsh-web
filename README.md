# DSH Web — Multi-Agent Autonomous Runtime

主要用途是从产品目标开发新项目，持续形成经过对标和独立验证的商业可用产品；同时支持接手、修复和演进已有项目。
空项目的差距包括尚未建立的核心流程、产品能力、UI/UX 和交付条件，不能只搜索已有代码里的 Bug。

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

可选的 `commercialLoop` 增加自由文本对标、阶段独立审核和额度交接。
当前工作平台持续研究、决策和执行；额度不足后确认停止，再由另一平台接续现场。
初步差距分析的 PARTIAL 会交给决策使用，计划、执行路线、候选验收和最终完成仍有独立 Gate。
配置、研究回调与边界见 [共同商业 Loop 使用说明](docs/commercial-loop-runtime.md)。

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
- 默认普通决策由 DSH 执行；高风险或连续两次行动失败时优先交给 Codex，额度耗尽的 provider 会在当前运行时中隔离。
  可以用 `decisionAgent` 显式指定偏好；省略或设为 `"auto"` 使用动态路由。
- 可选 `models` 登记表启用按行动的自动模型路由：普通行动用 routine 层，高风险或连续失败上移到 deep，security 审核用 security 层；
  `prohibited: true` 的模型（例如 V4 Pro）永不选用，无可用模型时失败关闭。`quotaGroup` 把 Codex-backed Pi 与 Codex 计为同一额度组。
  选择结果、原因与输入作为证据随 `view()` 暴露。配置、默认值与限制见[共同商业 Loop 使用说明](docs/commercial-loop-runtime.md)。
- Host 根据实际路径与敏感变更提高风险，模型不能降低这一最低等级。
- 没有源码变化的行动记为 `NO_CHANGE`，不创建 commit、不增加成功评分，也不推进 acceptedHead。
- Gap 优先级为 0..100，数值越大越紧急。观察提供源码覆盖和截断清单；完整观察独立归档，World State 保存引用。
- 审核失败后重新诊断，可以修复或放弃候选；连续失败影响 Worker 评分并触发替换。
- 主 checkout 不自动合并。`acceptedHead` 指向已审核候选，人工可以检查后合并。
- 崩溃状态不能直接续写；`recoverInterruptedProject(config)` 验证 PID 指纹并停止残留 Worker，再允许重新规划。
  手动恢复入口：`node scripts/recover-project.mjs config.local.json`。
  Windows 使用 Job Object，在 Worker 执行前绑定进程组，并在正常退出或崩溃时回收子进程。
- `node scripts/watchdog.mjs recovery-config.json` 是独立于 DSH 启动的最小恢复入口。
  必须配置 `harness.executable/args` 和 `recovery.enabled/repository/codex/tests/protectedPaths`。
  独立 Codex 修复、Host 测试、另一只读 Codex 审核后，才允许从候选 worktree 重启；
  `recovery.restartFromWorktree` 默认关闭。

## 独立连接与付费 API 授权

`agents` 的键是 Host 连接别名；`transport` 选择原生适配器（如 `opencode`），
`connectionId` 是 Host 声明的具体登录/计费连接身份，`quotaGroup` 只用于确实共用账户额度的连接。
Runtime 不会探测或伪造供应商账户余额；运维者须确保每个 alias 实际使用预期登录，
必要时为原生 CLI 配置隔离的外部账户配置目录/环境。
没有显式 `quotaGroup` 时，OpenCode Go、另一份 OpenCode 登录和直接 API 连接按独立连接路由。
模型表的 `provider` 是原生 transport，`connectionId` 是该模型所属账户；同一 API 模型 ID
可在不同明确命名的连接上重复。旧的 provider-key 配置和不含 `connectionId` 的模型表继续兼容。
CLI 会把 alias 映射为 Worker ID，并按 `transport` 构造 adapter。

DeepSeek V4.1 Flash (`deepseek-flash`) 和 GLM 5.3 Flash (`glm-5.3-flash`)
是 OpenCode 的独立 custom-provider 连接。`config.example.json` 将两者设为
`enabled: false`、模型 `eligible: false`，并通过 `DEEPSEEK_API_KEY` / `GLM_API_KEY`
环境变量名引用凭证；示例不包含真实 key。将 API key 放进连接配置、模型提示或仓库配置
不会授予花费权限。启用连接和模型后，还须在 Host 终端明确授权，例：

```sh
# 项目 stateDir 必须在仓库外；审批将绑定精确项目、连接、模型、endpoint 和到期时间。
node scripts/paid-api-authorization.mjs --state-dir ../dsh-state/example --grant \
  --project D:/projects/example --connection deepseek-api --models deepseek-flash \
  --endpoint https://api.deepseek.com --expires 2026-10-20T12:00:00Z --max-worker-runs 3
# 按提示输入 APPROVE deepseek-api。撤销时：
node scripts/paid-api-authorization.mjs --state-dir ../dsh-state/example --revoke <grant-id>
```

示例中的官方 DSH 连接也默认 `enabled: false`，相应模型为 `eligible: false`；这样默认配置
不会隐式启动可能计费的官方连接。已有订阅连接仍可按各自登录和配置使用。

授权账本在 `stateDir/paid-api/ledger.json`，不在 Worker workspace；Host 会在准备 adapter
之前原子预留一次 Worker run，并在崩溃、启动失败、重启和并发启动时保留消耗记录。超出模型、
连接、endpoint、项目、到期时间或额度范围的启动会在任何 Worker 准备/网络请求之前失败，
并报告明确的 authorization-needed 原因。配置可为 DeepSeek 与 GLM 分别创建独立 grant。
`maxWorkerRuns` 只限制已授权的 Worker 启动次数，不限制一个 Worker 发出的 API 请求数量、
token 数或货币金额；它不是 monetary spending cap，也不保证费用上限。没有活跃授权的
付费连接会从可选 Worker 和付费模型中排除，让已授权的既有订阅连接继续参与选择。
该授权入口是本地 Host 操作，不提供 Agent 工具或 HTTP grant endpoint。

### 账本锁的崩溃恢复

`stateDir/paid-api/ledger.lock` 是刻意 fail-closed 的互斥锁。若控制器在持锁时崩溃，
后续操作会等待后报错；Runtime 不根据 PID、锁龄或 owner token 自动删除锁，因为这种
恢复方式存在 ABA 竞态并可能让并发预留超过授权次数。恢复前必须停止并确认所有共享该
`stateDir` 的 DSH/Runtime 控制器都已退出，再人工删除**锁目录** `paid-api/ledger.lock`。
不要删除或重建 `ledger.json`，也不要减少已消费的 `consumedWorkerRuns`；已预留次数不会
因崩溃或启动失败退还。锁 owner 文件缺失/损坏时同样按 stale lock 处理。Windows PowerShell：

```powershell
Remove-Item -LiteralPath "<stateDir>\paid-api\ledger.lock" -Recurse -Force
```

自定义 provider 只向 `OPENCODE_CONFIG_CONTENT` 加入 OpenCode 的 provider/npm/baseURL/model
设置；权限、MCP、插件和 Worker 工具围栏由 Host 固定生成。OpenCode custom provider 使用
`@ai-sdk/openai-compatible`。启用 API 连接时，先设置对应环境变量并安装/配置 OpenCode CLI；
Node.js 22+、Git、启用的原生 CLI 和各自订阅登录仍是本机外部依赖。

## 外部 Controller Supervisor

无干预实验可由 Host 在独立进程中只启动一次 Controller。`runSupervisedController()`
观察真实子进程的 stdout/stderr、exit code、signal、spawn failure 和最后持久化 Loop phase；
输出按字节截尾并脱敏。结果原子写入独立的 `supervisor-result.json`，不会覆盖 acceptance
报告。退出码为 0 但缺少有效 final report、final report 未在本次运行中产生/更新，或报告自身为
FAIL，仍为 FAIL；只有子进程关闭后，Supervisor 才会调用
既有恢复流程停止并核实所有有 PID/launch-token 记录的 Worker。锁冲突、PID 重用或 Worker
停止无法确认时保留原状态和锁，并在 Supervisor 结果中记录恢复受阻。

CLI 配置是 JSON，路径相对配置文件所在目录解析；凭证由继承的 provider CLI 环境提供，不能写入此文件：

```json
{
  "executable": "node",
  "args": ["<unchanged SupportDesk acceptance entry point>", "<its existing arguments>"],
  "cwd": "<SupportDesk repository root>",
  "stateDir": "<the same external stateDir used by the Controller>",
  "finalReportPath": "<the unchanged acceptance entry point's final report>",
  "resultPath": "<external stateDir>/supervisor-result.json",
  "outputLimitBytes": 32768
}
```

从该配置文件目录运行：

```sh
node <path-to-this-checkout>/scripts/supervise-controller.mjs supportdesk-supervisor.json
```

API 等价接法（适用于原生 Host composition）：

```js
import { runSupervisedController } from './runtime/supervisor.mjs';
import path from 'node:path';

const result = await runSupervisedController({
  executable: process.execPath,
  args: [existingSupportDeskAcceptanceEntry, ...existingSupportDeskArguments],
  cwd: supportDeskRepositoryRoot,
  stateDir: supportDeskStateDir,
  finalReportPath: existingSupportDeskFinalReport,
  resultPath: path.join(supportDeskStateDir, 'supervisor-result.json'),
});
if (result.status !== 'PASS') process.exitCode = 1;
```

`existingSupportDeskAcceptanceEntry`、原参数、brief/API/browser checks、Controller 配置及
final-report 写入逻辑保持原样；只把原来直接启动该 entry point 的 Host 命令替换为上述 CLI
配置或 API 调用。Supervisor 不重试、不调用修复 Agent，也不更换模型。此接线修复的是进程
退出证据与安全恢复，不代表未知的 2026-10-06 DECIDE 退出触发原因已找到或 SupportDesk 已通过验收。

权限通过原生 Codex sandbox、OpenCode permission、Pi tool hook、DSH sandbox 和 tool guard 实现。
2026-10-04 的真实电商压力验收发现：原生 Codex CLI 仍继承了 MCP JS 工具，
并在 `shell: false` 时通过它启动了 `cmd.exe`。2026-10-05 修复后的 adapter 忽略用户配置，
移除继承的桌面 session 环境变量，并显式禁用 MCP、插件、JS、浏览器和额外 Agent 工具。
在 Windows / Codex CLI 0.155.1 上，原生模型请求的工具清单验证未暴露这些通道，
实际 Codex 写入也通过 Host 测试与 DSH 独立审核。详见 [治理修复验收](docs/governance-repair.md)。
Windows Job Object 仍不能约束外部 MCP 服务中的进程；工具清单验证不代表已证明所有平台和策略配置的隔离。
这不是恶意第三方可执行文件的操作系统隔离平台；非 Codex provider 的 unrestricted shell 配置会被拒绝。
测试命令和插件属于可信 Host 配置。源码注入内容没有调度权限。

## 验证

```sh
npm test
npm run test:agents -- config.local.json
node scripts/live-workers.mjs config.local.json
npm run test:live -- config.local.json
node scripts/live-recovery.mjs config.local.json
node scripts/live-new-project.mjs config.local.json
```

自动测试包含明确标注的 test-double 决策，用于确定性验证 Gate、回归拒审、worktree、重启和恢复。
`test:agents` 使用真实 provider 验证连接；`live-workers` 验证四种真实写入及独立审核。
`test:live` 使用实际模型重新诊断，没有 TODO 顺序或预设审核结论；它在第一次 Builder 停止后
记录并注入一次配送回归，要求真实测试和 Reviewer 拒绝，再重新规划。
`live-new-project` 是仅含产品说明的初始提交仓库的原生新项目验收入口：
`createBriefFixture` 只生成产品说明和一次初始提交，Host 验收脚本放在产品仓库之外并先证明它在裸说明上失败，
再由原生 OpenCode 通过 `ctx.autonomousControl.createProject` 构建产品，另用非 Codex 平台独立审核；
候选必须让 Builder 树与干净提交树都通过，主 checkout 未变且重启状态一致；被接受的候选还必须由原生
OpenCode 最终实现且没有额度交接，其它 provider 接管即使达到 `MERGE_READY` 也会作为一个独立的非 PASS
检查如实呈现，而不是静默通过。入口拒绝复用已存在的输出目录/stateDir，运行 `start` 或读取状态抛出异常时
也始终写入 FAIL 报告而不是中断。报告中的 PASS 指候选达到
`MERGE_READY`，不是 `state.status === "complete"`，最终完成审核的 outcome 单独记录。
该入口是有限、可复现的原生验收入口，不代表完整商业产品交付。
报告写入 `.tmp/`。恢复测试验证独立启动故障 fixture，不代表已覆盖所有生产 Harness 故障。
临时 observe/review worktree 与分支自动清理；候选 build checkout/分支保留供审查、恢复和人工合并。
OpenCode 的大段提示词使用 `run --file` 附件传输，避免 Windows 命令行长度限制。
附件与审核证据保存在 Host 的 artifact 目录中；其中可能包含项目源码，应与原始日志一样
限制本机访问并排除公开上传。文件的 `0600` 模式仅适用于支持 POSIX 权限的平台，不能替代 Windows ACL。

最终完成标准以 [PROJECT_SPEC.md](PROJECT_SPEC.md) 为准。
具体验收记录见 [validation](docs/validation.md)。
最新运行时修复和真实重测见 [governance repair](docs/governance-repair.md)。
真实项目试跑及已发现的限制见 [ecommerce stress pilot](docs/ecommerce-stress-pilot.md)。
真实桌面/移动端购买流程验收见 [ecommerce browser acceptance](docs/ecommerce-browser-acceptance.md)。
插件接入旧 Host 的示例见 [autonomous-control-loop](plugins/autonomous-control-loop/README.md)。
