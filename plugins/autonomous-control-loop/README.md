# 上层自主控制 Loop

保留 DSH 原来的 `@deepseek-ai/dsh-agent-loop`。本插件通过 Cordis 提供
`ctx.autonomousControl`，在 Worker 的一次行动之外运行固定治理流程：

```text
Decision → BUILDING → dispose/停止确认 → REVIEW_REQUIRED
→ REVIEWING → ACCEPTED / REJECTED → 重新 Decision
```

本插件不提供模型可调用的调度工具。只有可信 Host/策略插件调用 `create`、
`registerWorker`、`tick` 和 `run`。旧聊天和 Build 模式不受影响。

## 接入 Host

在已有 DSH composition 中挂载本地 `index.js` 插件，或由 Host 使用
`ctx.plugin(controlPlugin)` 挂载。保留原 agent-loop 和所需 subagent provider。
策略插件依赖 `autonomousControl` 服务，再使用下述 API。函数由可信 Host 提供，
不能把函数直接写入 YAML。

```js
import { createDshWorker, gitSnapshot } from './plugins/autonomous-control-loop/index.js';

// ctx 必须已挂载本插件和 DSH subagent 服务。
// parent 是 Host 拥有的实际 Agent；它的 cwd 必须对应 workspace。
const loop = ctx.autonomousControl.create({
  workspace: 'D:/your-project', // 独立、受控的 Git 根目录
  stateDir: 'D:/control-state/your-project', // 必须在 workspace 外部
  snapshot: gitSnapshot,
  decide: async (worldState, observation) => {
    // 调用独立 Decision Agent 或项目策略；每轮重查当前证据。
    // 无可执行行动时返回 null。拒审后的修复需包含 repairOf。
    return chooseNextAction(worldState, observation);
  },
  routeReview: async (action, worldState) => chooseRequiredReviewers(action, worldState),
  timeoutMs: 300_000,
  stopTimeoutMs: 30_000,
});

loop.registerWorker(createDshWorker({
  id: 'dsh-builder', identity: 'dsh-builder-policy', roles: ['build'],
  subagents: ctx.subagents, provider: 'spawn', parent,
  // 此 provider 的子 Agent composition 不得挂载 goal-round-driver。
  // 禁止 Builder 子 Agent 获得新的项目调度权限。
  request: { maxDepth: 1 }, // 根 parent 下只允许这一层子 Agent
}));

loop.registerWorker(isolatedReviewer); // 见下方 adapter 契约
await loop.run({ maxActions: 10, signal: hostAbort.signal });
await loop.close();
```

`createDshWorker` 直接调用已安装 DSH 的 `subagents.start(provider, request)`，
读取 `run.result`，随后等待 `run.dispose()`；不替换默认 Loop。
成功终止原因必须是官方契约中的 `completed`。
当前仓库未安装 Codex/OpenCode/Pi provider，本插件没有假装这些后端已经接通。
其他后端可以实现下述同一 adapter 契约。

## Worker adapter 契约

```js
const isolatedReviewer = {
  id: 'reviewer',
  identity: 'independent-review-policy', // 不得与 Builder 相同
  roles: ['review'],
  readOnly: true,
  async start({ actionId, goal, workspace, snapshot, builderResult, signal }) {
    // 在独立会话及环境里启动 Reviewer。
    // workspace 对 Reviewer 和它的所有子进程/工具必须不可写。
    // 需要测试输出时，使用独立副本及临时目录；被审源码保持不可写。
    return {
      result: reviewerResultPromise, // 返回以下结构
      async dispose() {
        // 取消工作、停止所有后代并确认不再运行，完成后才 resolve。
        // 不能用“已发 cancel”代替停止确认。
      },
    };
  },
};

// Reviewer 的结构化结果，证据建议使用实际测试/文件/日志产物路径。
const report = {
  verdict: 'pass', // 或 reject
  snapshotHash: reviewedSnapshot.hash,
  evidence: ['path/to/test-report.json', 'path/to/review-report.md'],
};
```

`readOnly` 和 `identity` 是可信 Host 对 adapter 的声明，不是 OS 权限实现。
通用 DSH bridge 明确拒绝充当只读 Reviewer：隐藏编辑工具无法阻止 shell 写文件。
实际权限隔离、进程树终止和证据有效性由后端 adapter/Host 实施。
本插件检查证据字段及版本一致性，不自动证明报告内容正确。

## 强制门禁及恢复

- 每次行动都需要审核，包括没有 diff 的行动；至少一个 Reviewer。
- 双审必须全部通过；Reviewer 身份不能重复或与 Builder 相同。
- 每次启动/等待结果都有预算，`dispose` 有独立停止预算。
- 停止未确认、启动超时或源码变化进入 `HALTED`，不能继续写入。
- 无 Reviewer、无效报告或已确认停止后的 Reviewer 失败保持待审核。
  新实例调用 `tick` 会重新审核同一快照，不会重新运行 Builder。
- 拒审后 `run` 停止；Host 的下一次 `tick` 只能选择包含
  `repairOf: rejectedAction.id` 的修复行动。
- `BUILDING` 状态重启后进入 `HALTED`。Host 必须先确认进程树已停止、
  检查现场并处理恢复；本版不自动猜测进程是否仍存活。
- JSON 状态通过临时文件、fsync 和 rename 写入；每次运行使用独占文件锁。
  崩溃后锁文件可能保留。确认记录的进程及其后代全部停止后，Host 才能删除
  `controller.lock`；不按时间自动抢锁。

`ACCEPTED` 表示治理账本接受当前工作区版本。它不会自动 commit、merge、push、
回滚或部署。Host 应使用隔离工作区，并在推广版本时再次核对快照。

内置 Git snapshot 覆盖 HEAD、暂存区、已跟踪文件、未跟踪文件、删除及符号链接。
忽略文件、外部服务和数据库不在其范围；这些项目必须提供额外 snapshot/证据 adapter。
子模块会明确报错。采样期间应由 Host 独占工作区；哈希检查不代替 OS 权限隔离。

## 验证

在仓库根目录运行 `npm test`。测试使用本地临时工作区和可控 adapter，覆盖强制审核、
停止失败、版本变化、拒审修复、重启恢复、锁竞争、DSH 契约和真实 Cordis 插件挂载。
没有调用付费模型或真实外部 Reviewer。
