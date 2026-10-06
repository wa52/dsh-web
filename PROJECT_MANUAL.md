# DSH Web 详细项目说明书

> 仓库：`wa52/dsh-web`  
> 基线：main @ `12a785849f4372e16112e029ae80981ca24eab58`  
> 项目定位：Multi-Agent Autonomous Runtime / Agent Control Plane  
> 本说明书依据仓库当前 README、PROJECT_SPEC、runtime、plugins、tests 与 validation 文档整理。

## 1. 项目目标

DSH Web 的目标不是再造一个 Coding Agent，而是在 Codex、OpenCode、Pi、DeepSeek Harness 等执行器之上建立一个长期运行的项目控制层。用户提供项目目标、代码仓库、约束、成功标准以及 Agent/权限配置后，系统持续观察项目状态，发现当前最大差距，选择合适 Worker 执行一次有限行动，再强制进入独立审核；审核结果写回 World State，随后重新评估整个项目。

核心闭环：

```text
Observe
  -> Diagnose
  -> Generate Candidate Actions
  -> Select Worker
  -> Execute One Action
  -> Force Independent Review
  -> Persist World State
  -> Re-evaluate Entire Project
  -> Continue / Replan / Stop
```

项目尤其强调“状态驱动”而不是固定 TODO 队列。已经不存在的任务、突然出现的新风险、测试回归、UI 差距、商业化差距，都可以改变下一轮行动优先级。

## 2. 解决的问题

传统单 Agent 开发常见问题包括：Builder 自己宣布完成、没有强制独立审核、按预先任务列表机械推进、不同 Coding Agent 之间无法统一调度、失败状态无法可靠恢复，以及长期 Loop 中缺少可追溯的决策与证据。

DSH Web 将这些问题拆成系统级能力：

- Builder 与 Reviewer 强制分离；
- 每次写操作使用独立 Git worktree；
- Host 负责测试、候选 commit 与受保护路径检查；
- Worker 不拥有最终放行权；
- World State 持久化目标、Gap、证据、行动、审核、失败、决策和 commit；
- Worker 可替换，核心 Loop 不依赖单一平台；
- 高风险行动提高审核深度；
- Harness 或 Worker 崩溃时走独立 Recovery；
- Web UI 用于观察与控制，而不是代替 IDE。

## 3. 总体架构

### 3.1 Control Plane

核心运行时代码位于 `runtime/`。主要职责如下：

- `project.mjs`：项目级 Loop 生命周期与状态推进；
- `decision.mjs`：根据当前状态、Gap、风险和历史选择下一行动；
- `registry.mjs`：Agent 注册、能力和可用状态；
- `adapters.mjs`：Codex、OpenCode、Pi、DSH 的统一执行适配；
- `governance.mjs` / `permissions.mjs`：权限边界、风险和治理规则；
- `worktrees.mjs`：隔离工作区与候选变更；
- `store.mjs`：World State、日志、审核证据等持久化；
- `recovery.mjs`：中断检测、残留 Worker 回收和恢复；
- `commercial.mjs` / `research.mjs`：商业化共同 Loop 与研究能力；
- `server.mjs`：Web UI 与运行时交互入口；
- `cli.mjs`：命令行运行入口。

### 3.2 Agent Adapter

所有执行器使用统一的 start/send/cancel/status/result 契约。设计目的不是把所有 Agent 能力做成一样，而是让 Control Loop 不需要为每个平台重写业务流程。

当前首批 Worker：

- Codex
- OpenCode
- Pi
- DeepSeek Harness

路由时可考虑能力匹配、风险、失败历史、成功率、可用性、成本和延迟。默认普通决策由 DSH 执行；高风险或连续失败时可以提高 Codex 优先级；也支持显式指定 decisionAgent。

### 3.3 World State

World State 是长期 Loop 的核心，不只是“任务列表”。至少包含：

- Project / Goal / Constraints
- Current State
- Gaps
- Evidence
- Actions
- Reviews
- Failures
- Decisions
- Agent Performance
- Commits
- Risk Level
- Project Health

每次 Action 后重新诊断，旧的“下一任务”默认不具有继续执行权。

### 3.4 Mandatory Review Gate

任何会写代码、配置、数据库、UI 或其他项目文件的动作，都必须经历：

```text
WRITE
 -> ACTION_COMPLETE
 -> REVIEW_REQUIRED
 -> Independent Reviewer
 -> PASS / FAIL / NEEDS_MORE_EVIDENCE
```

Builder 输出“完成”“测试通过”等文字不能改变最终审核状态。Reviewer 默认只读，可查看 diff、运行测试、浏览 UI，但不能直接修改 Builder 的 worktree。

### 3.5 Git Worktree 隔离

每次决策、构建和审核都绑定独立 worktree / commit / 源码快照。这样可以避免两个 Agent 直接污染同一 working directory，也能保证失败候选不会直接进入 main。

系统不会自动把候选合并进主 checkout。通过 Host 测试、保护路径检查和独立审核后，只产生 `MERGE_READY` / `acceptedHead`，最终仍保留人工检查空间。

## 4. 商业化共同 Loop

仓库已经加入 `commercialLoop` 与共同商业 Loop 文档。它的目的不是“做完功能就停止”，而是让项目持续研究成熟产品、发现产品能力/UI/交付条件差距，并在平台额度或可用性变化时保存现场并交接。

核心原则：

1. 当前平台可用时保持工作连续性；
2. 额度耗尽或平台故障后，保存现场并由另一平台接续；
3. 研究和对标可以自由表达，但可执行行动必须通过 Host 契约；
4. 风险决定审核深度，不把任务永久绑定给某个平台；
5. 独立审核是系统生命周期的一部分，不能因为缺少 Reviewer 就自审通过；
6. 空项目的“Gap”也包括尚未建立的核心用户流程、产品能力、UI/UX 和交付条件。

## 5. 治理与安全

DSH Web 当前不是恶意第三方代码的完整 OS 沙箱，而是面向可信开发环境的治理层。仓库已经针对原生 Codex CLI 继承外部工具通道的问题做过修复与真实验证：adapter 会移除继承的桌面 session 环境变量，并显式限制 MCP、插件、JS、浏览器和额外 Agent 通道。

重要安全边界：

- Worker 的 shell、network、commit 和额外 Agent 调度默认禁用或受控；
- 高风险行动需要更严格 Reviewer，仓库规则要求两个独立 Reviewer，其中一个具备 security 能力；
- Host 可以基于真实路径和敏感变更提高风险等级，模型不能把最低风险降下去；
- 无源码变化的行动记为 `NO_CHANGE`，不会创建 commit 或虚增成功评分；
- 受保护测试和关键路径由 Host 配置；
- Windows Job Object 用于 Worker 进程组回收，但不能约束外部 MCP 服务里的进程；
- 测试命令与插件本身属于可信 Host 配置范围。

## 6. Recovery 机制

Recovery 面向两类故障：

### 6.1 Worker 故障

Worker 被 kill、超时或崩溃后，Scheduler 记录 failed/interrupted，保留 World State，再决定 retry、replace、split 或 abandon。

### 6.2 Harness / 主运行时故障

系统停止无人监管的写操作，验证 PID 指纹，清理残留 Worker，再允许重新规划。仓库提供：

```bash
node scripts/recover-project.mjs config.local.json
node scripts/watchdog.mjs recovery-config.json
```

独立 Recovery Worker 可在隔离 worktree 中修复，经过 Host 测试和独立审核后才允许恢复运行。仓库同时明确：崩溃状态不能直接续写。

## 7. Web UI

Web UI 位于 `web/`，用于显示和控制项目运行状态。V1 目标不是完整 IDE，而是让用户看到：

- Project Goal / Health / Current State / Biggest Gap / Current Action
- Codex / OpenCode / Pi / DSH 在线与运行状态
- Agent 权限、角色、成功率和最近运行
- Loop 当前处于 Observe / Decide / Dispatch / Build / Review / Update / Replan / Stop 哪一步
- 每次 Run 的 Agent、任务、状态、耗时、结果、review 与 commit
- logs、diff、test result、reviewer verdict 等证据

系统支持启动、在 Action 边界暂停和取消。

## 8. 安装与启动

前置要求：

- Node.js 22+
- Git
- 需要使用的 Coding Agent CLI
- 各 CLI 自己的登录凭证

安装：

```bash
npm ci
npm test
npm start
```

默认 Web 地址：

```text
http://127.0.0.1:4780
```

复制配置：

```bash
cp config.example.json config.local.json
```

Windows 下建议使用原生 `.exe` 绝对路径，或 `executable: "node"` 配合 `argsPrefix` 指定 CLI 入口。项目明确不建议通过 `.cmd` / `.bat` 或拼接 shell 命令绕开治理。

## 9. 项目配置

配置至少需要表达：

- repository
- stateDir（建议放在项目仓库外）
- project goal
- constraints
- success criteria
- protected test paths
- Host test argv
- Agent/provider 配置
- permissions
- 可选 commercialLoop / decisionAgent / recovery 配置

凭证仍由各 CLI 自己管理，不写入仓库配置。

## 10. 运行方式

普通 Web 运行：

```bash
npm start -- --config config.local.json
```

带行动数量上限的 CLI：

```bash
node runtime/cli.mjs --config config.local.json --run
```

运行时每次只允许 Worker 执行一个 Action，结束后强制进入 Review Gate。

## 11. 测试与验收

仓库已有多层测试：

```bash
npm test
npm run test:agents -- config.local.json
node scripts/live-workers.mjs config.local.json
npm run test:live -- config.local.json
node scripts/live-recovery.mjs config.local.json
node scripts/live-new-project.mjs config.local.json
```

其中：

- `npm test`：确定性测试和契约验证；
- `test:agents`：真实 provider 连接；
- `live-workers`：四种真实写入与独立审核；
- `test:live`：实际模型重新诊断、制造回归、Reviewer 拒绝并重新规划；
- `live-recovery`：恢复路径；
- `live-new-project`：仅有产品说明的最小初始仓库，从产品目标开始构建。

最终 V1 验收要求至少覆盖：真实功能 Bug、UI Bug、修改后回归问题，且系统不能使用固定任务顺序；必须出现强制独立 Review、Review FAIL 后重新规划、World State 重启恢复、main 未被未审核候选污染，以及最终测试全部通过。

## 12. 当前完成度与边界

当前仓库已经具备可运行的多 Agent 控制 Loop、统一 Adapter、World State、worktree 隔离、Review Gate、Host 测试、Web UI、恢复入口、商业化共同 Loop 和一系列真实验收记录。

但仓库文档同时明确以下边界：

- V1 证明的是自主开发/审核闭环，不等于完整商业产品自动交付；
- Windows Job Object 无法约束外部 MCP 服务进程；
- 工具清单验证不代表已证明所有平台和策略配置都完全隔离；
- Recovery fixture 和真实试跑只覆盖已测试场景；
- 主分支不会自动合并候选；
- 多平台全部按最新共同商业 Loop 规范完成统一改造仍属于持续演进目标。

## 13. 推荐的实际使用方式

把 DSH Web 当作“项目控制平面”，而不是聊天窗口。

典型过程：

```text
用户定义目标
 -> DSH 读取仓库与当前状态
 -> 找最大 Gap
 -> 选择 Worker
 -> Worker 在隔离 worktree 修改
 -> Host 测试
 -> 独立 Reviewer
 -> PASS：更新 acceptedHead / World State
 -> FAIL：记录失败并重新诊断
 -> 下一轮重新评估全局
```

最适合长期运行的场景是：已有目标但任务路径无法提前完全确定、需要多个 Coding Agent 接力、需要强制审核和失败记录、希望持续朝商业可用状态推进的项目。

## 14. 维护与二次开发入口

新增 Agent：实现现有 Adapter 契约并注册到 registry，不应修改核心 Control Loop。

新增审核类型：扩展 Review Gate 与 Evidence 类型，而不是让 Builder 自行判断。

新增 UI：从 World State 和 Evidence 中读取状态，不应绕过 Host 直接控制 Worker。

新增商业化策略：应作为 Diagnose / Research / Candidate Action 的输入，不应重新退化成固定 phase/TODO 队列。

新增安全能力：优先加强 Host 权限、process sandbox、protected paths 与 Reviewer 规则，不依赖 Prompt 约束代替系统级 Gate。

---

这份说明书描述的是当前 GitHub 仓库实现与已记录边界。README、`PROJECT_SPEC.md`、`docs/shared-commercial-loop.md`、`docs/governance-repair.md` 与 `docs/validation/` 仍是运行时事实和验收记录的最终来源。
