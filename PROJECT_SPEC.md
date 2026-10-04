# DSH Web — 项目目标与验收标准

## 1. 项目定位

DSH Web 不是新的 Coding Agent，也不替代 Codex、OpenCode、Pi 或 DeepSeek Harness。

它是一个 **Multi-Agent Autonomous Runtime / Agent Control Plane**：

- DeepSeek Harness 作为主要运行时与调度核心；
- Codex、OpenCode、Pi、DeepSeek Harness Agent 作为可替换 Worker；
- 系统基于项目当前状态动态选择 Worker；
- 每次有写入性修改后，必须进入独立 Review Gate；
- Review 结果更新 World State；
- 系统基于最新状态重新决策，而不是按固定 TODO 顺序执行；
- Harness 自身故障时，可由外部 Recovery Worker（优先 Codex）修复。

---

## 2. 最终目标

用户只需要提供：

1. Project Goal
2. Repository
3. Constraints
4. Success Criteria
5. Agent / Model / Permission 配置

系统能够持续执行以下闭环：

```text
Observe
  ↓
Diagnose
  ↓
Generate Candidate Actions
  ↓
Select Worker
  ↓
Execute One Action
  ↓
Force Independent Review
  ↓
Update World State
  ↓
Re-evaluate Entire Project
  ↓
Continue / Replan / Stop
  ↺
```

系统必须做到：

- 不依赖单一 Coding Agent；
- 不依赖 Builder 主动调用 Reviewer；
- 不依赖预先写死的任务顺序；
- 不允许 Builder 自己宣布“完成”后直接进入下一任务；
- 不允许单个 Agent 同时拥有“决策 + 执行 + 最终验收”全部权力；
- 所有关键决策、执行、审核、失败和证据均可追溯。

---

## 3. 核心原则

### 3.1 状态驱动，而不是任务队列驱动

系统不以固定 TODO 列表作为主循环。

长期保存的是：

- Goal
- Current State
- Gaps
- Evidence
- Actions
- Reviews
- Failures
- Decisions
- Agent Performance
- Commits

每次 Action 完成后，旧的“下一任务”默认失效，必须重新评估全局状态。

### 3.2 Builder 与 Reviewer 强制分离

任何产生代码、配置、数据库、UI 或项目文件修改的 Action：

```text
WRITE
↓
ACTION_COMPLETE
↓
REVIEW_REQUIRED
↓
Independent Reviewer
↓
PASS / FAIL / NEEDS_MORE_EVIDENCE
```

Builder 不得跳过 Review Gate。

### 3.3 Agent 是可替换执行器

统一抽象：

```ts
interface AgentAdapter {
  start(task): RunHandle
  send(runId, message): void
  cancel(runId): void
  status(runId): AgentStatus
  result(runId): AgentResult
}
```

第一批 Worker：

- Codex
- OpenCode
- Pi
- DeepSeek Harness

后续新增 Agent 时，不修改核心 Control Loop。

### 3.4 高风险操作优先使用高可信 Worker

初始策略：

- 复杂跨文件修改：Codex 优先
- 大型重构：Codex 优先
- Auth / 权限 / 数据库迁移：Codex 优先
- Harness 自身维修：Standalone Codex 优先
- 只读分析 / 探索：Pi / OpenCode / DSH 可参与

后续必须允许基于实际成功率动态调整，而不是永久写死。

---

## 4. 核心模块

### 4.1 Control Loop

负责：

- Observe
- Diagnose
- Generate Candidates
- Select Action
- Dispatch
- Wait
- Review Gate
- Update State
- Replan
- Stop

### 4.2 World State

最少保存：

```text
Project
Goal
Constraints
CurrentState
Gaps
Evidence
Actions
Reviews
Failures
Decisions
AgentPerformance
Commits
RiskLevel
ProjectHealth
```

### 4.3 Agent Registry

每个 Agent 至少包含：

- id
- provider
- status
- capabilities
- read/write/shell/network 权限
- trust level
- historical success rate
- cost metadata
- current availability

### 4.4 Worker Router

根据以下因素选 Worker：

- capability match
- risk
- project history
- task-type success rate
- failure history
- availability
- cost
- latency

### 4.5 Mandatory Review Gate

审核必须是系统级 Gate，而不是 Builder 的可选工具。

至少支持：

- Code Review
- Test Review
- UI / Browser Review
- Architecture Review
- Security-sensitive Review
- Regression Review

### 4.6 Recovery

Harness / Worker 异常时：

- 检测异常；
- 停止当前 Loop；
- 保存状态；
- 使用独立 Recovery Worker 处理；
- 在隔离 worktree 中修复；
- 通过测试后才允许恢复运行。

---

## 5. V1 范围

V1 的目标不是“完全自主开发商业级产品”，而是证明以下最小闭环真实可用：

```text
Project State
↓
DSH Control Loop
↓
选择 Worker
↓
Worker 修改隔离 worktree
↓
强制 Reviewer
↓
PASS / FAIL
↓
更新 World State
↓
重新决策
```

V1 必须接入：

- DeepSeek Harness
- Codex
- OpenCode
- Pi

V1 必须有 Web UI，但 UI 只服务于观察和控制，不追求完整 IDE。

---

# 6. V1 验收标准

## A. Agent 接入

### A1. Codex

PASS 条件：

- 能从 DSH Web 发起 Codex Run；
- 能指定目标仓库 / worktree；
- 能接收运行状态；
- 能获得最终结果；
- 能取消运行；
- Codex 失败不会拖死整个 Control Loop。

### A2. OpenCode

PASS 条件：

- 能从 DSH Web 发起 OpenCode Run；
- 支持独立 worktree；
- 支持状态查询、结果读取、取消；
- 异常可被 Scheduler 捕获。

### A3. Pi

PASS 条件：

- Pi 可作为独立 Worker 被调度；
- 支持多轮交互或 RPC 会话；
- 不与其他 Worker 共享未隔离的写目录。

### A4. DeepSeek Harness

PASS 条件：

- 可作为 Reasoning / Planning / General Worker 使用；
- 可被 Control Loop 启动、停止和重新调用；
- DSH 子任务失败不导致 World State 丢失。

### A5. 统一接口

PASS 条件：

- 四个 Worker 由同一 AgentAdapter 协议驱动；
- Control Loop 不包含 Codex/OpenCode/Pi 特有的业务分支；
- 新增第五个 Worker 不需要重写核心 Loop。

---

## B. 强制 Review Gate

### B1. 写操作强制审核

测试：

1. 使用 Codex 修改一个测试仓库；
2. Codex 返回 completed；
3. 检查系统状态。

PASS 条件：

- 状态必须变为 REVIEW_REQUIRED；
- 不允许直接开始下一个 Build Action；
- 必须启动 Reviewer 或等待 Reviewer。

### B2. Builder 不能自审通过

PASS 条件：

- Builder 自己输出“tests passed / task completed”不能改变最终审核状态；
- 最终 PASS 必须来自独立 Reviewer / Evaluator。

### B3. Reviewer 只读

默认 Reviewer：

- 可读代码；
- 可看 diff；
- 可跑测试；
- 可浏览 UI；
- 不允许直接修改 Builder worktree。

违反即 FAIL。

---

## C. 非顺序式 Loop

### C1. 每轮重新评估

准备 3 个 Gap：

- Gap A
- Gap B
- Gap C

第一轮完成 Gap A 后，注入一个新的高优先级 Gap D。

PASS 条件：

- 系统下一轮必须重新评估；
- 允许选择 D；
- 不得因为原计划是 B 就强制继续 B。

### C2. Action 可被放弃

PASS 条件：

系统能够：

- abandon
- retry
- split
- replace
- reprioritize

Action。

### C3. 无固定 phase 依赖

PASS 条件：

- 不要求必须 Frontend → Backend → Test；
- 当前状态变化后允许切换路线。

---

## D. World State

### D1. 持久化

关闭并重启 DSH Web。

PASS 条件：

以下信息仍存在：

- Goal
- Gaps
- 已完成 Actions
- Reviews
- Failures
- Decisions
- Evidence
- Agent 历史评分

### D2. 可追溯

任意 Action 必须能够追溯：

```text
为什么做
谁决定
谁执行
修改了什么
用了什么证据
谁审核
为什么 PASS / FAIL
对应哪个 commit
```

缺任意关键链路则 FAIL。

---

## E. 隔离与安全

### E1. Git Worktree 隔离

同时启动 Codex 和 Pi 修改同一 Repo。

PASS 条件：

- 两者不能直接修改同一个 working directory；
- 每个 Run 使用独立 worktree / branch；
- 任一 Agent 失败不会污染 main。

### E2. Merge Gate

PASS 条件：

只有满足：

- Reviewer PASS；
- 必要测试通过；
- 无阻塞风险；

才允许进入 merge-ready 状态。

### E3. 权限

至少支持：

- read-only
- write
- shell
- network
- git commit

权限必须由 Control Plane 决定，而不是 Worker 自行提升。

---

## F. Recovery

### F1. Worker 崩溃

人工 kill 一个 Worker。

PASS 条件：

- Scheduler 检测失败；
- Run 进入 failed / interrupted；
- World State 不丢；
- 可重新分配 Worker。

### F2. DSH / Harness 故障

模拟 Harness 启动失败或健康检查失败。

PASS 条件：

- 主 Loop 停止；
- 不继续进行无人监管的写操作；
- Recovery 流程可触发；
- 可以使用 Standalone Codex 在隔离 worktree 中修复；
- 修复必须经过测试后才允许恢复。

---

## G. Web UI

V1 页面至少展示：

### Project

- Goal
- Project Health
- Current State
- Current Biggest Gap
- Current Action

### Agents

- Codex
- OpenCode
- Pi
- DSH

每个显示：

- online / offline
- idle / running
- role
- permissions
- success rate
- latest run

### Loop

实时显示：

```text
OBSERVE
DECIDE
DISPATCH
BUILD
REVIEW
UPDATE
REPLAN
STOP
```

### Runs

显示：

- Agent
- task
- status
- duration
- result
- review
- commit

### Evidence

至少可查看：

- logs
- diff
- test result
- reviewer verdict

---

# 7. V1 端到端最终验收

建立一个专门的测试 Repo，故意放入：

1. 一个真实功能 Bug；
2. 一个 UI Bug；
3. 一个会在修改后触发的回归问题。

启动 DSH Web，仅提供：

- Goal
- Repository
- Success Criteria
- Permissions

不提供固定任务顺序。

系统必须完成：

```text
发现问题
↓
选择 Worker
↓
执行一次 Action
↓
强制停止 Builder
↓
启动独立 Reviewer
↓
发现 PASS / FAIL
↓
更新 World State
↓
重新评估全局
↓
继续处理当前最大 Gap
↓
所有阻塞 Gap 消失
↓
停止
```

最终必须满足：

- 3 个问题均被发现；
- 至少调用 2 种不同 Agent；
- 至少发生 1 次强制独立 Review；
- 至少发生 1 次因为 Review FAIL 而重新规划；
- 没有固定 TODO 顺序；
- main 分支未被未审核修改直接污染；
- 所有最终修改可追溯到 commit；
- World State 在重启后可恢复；
- 最终所有自动化测试通过。

全部满足，V1 才判定 PASS。

---

# 8. 明确不算完成的情况

出现以下任一情况，项目不能宣称 V1 完成：

- 只是能在 UI 里手动选择 Codex / Pi / OpenCode；
- Agent 只是排队依次执行；
- Reviewer 由 Builder 自己决定是否调用；
- Reviewer 和 Builder 实际是同一个 session / 同一个角色；
- Builder 说“完成”就直接进入下一个任务；
- 没有持久化 World State；
- 多 Agent 共用一个写目录；
- 没有失败恢复；
- 只保存聊天记录，不保存 Evidence / Decision / Review；
- 只能 Demo，无法重复跑同一套验收测试。

---

# 9. Definition of Done

DSH Web V1 完成必须同时满足：

1. 4 个 Worker 可统一调度；
2. Worker 可动态选择；
3. 写操作必走独立 Review Gate；
4. 每轮 Action 后全局 Re-evaluate；
5. World State 可持久化；
6. Agent 并行修改互相隔离；
7. 失败可恢复；
8. UI 可观察整个 Loop；
9. 自动 E2E 验收通过；
10. 所有关键修改均提交 GitHub。

达到以上 10 条后，才进入 V2：Commercial Benchmark、动态 Agent 能力学习、多 Reviewer 投票、市场研究 Agent、自主长期项目优化。
