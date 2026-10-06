# 共同商业 Loop：当前实现与使用

保留原 DSH agent-loop 和已有项目 Loop。只有 `commercialLoop.enabled: true` 才启用新增行为。
首要用途是从目标建设新产品，已有项目改进也可使用同一 Loop。缺失功能、流程、UI 与交付条件都作为 Gap，不能仅按 Bug 修复排序。
Codex、OpenCode、Pi、DSH 是可接续的工作平台，默认保持当前平台的研究、决策和执行连续性。
独立审核始终切换身份；额度不足时的交接不允许降低审核要求。

## 配置

在已有项目配置中增加下面字段。仓库、成功标准、权限、受保护路径和 Host 测试仍然必需。

```json
{
  "commercialLoop": {
    "enabled": true,
    "worker": "opencode",
    "fetchReferences": true,
    "referenceMaxAgeMs": 3600000,
    "maxAlignmentAttempts": 2,
    "references": [
      {
        "title": "与本项目适合的成熟实现",
        "url": "https://raw.githubusercontent.com/saleor/storefront/main/README.md"
      }
    ]
  }
}
```

参考项目应与实际技术、用户、产品范围匹配。示例链接不意味着所有项目都适合电商对标。
可以直接提供 `references[].text`，作为 Host 提供的文档；只有 URL 不算已检查的来源。
默认抓取仅支持公开 HTTPS、无凭证和查询参数、443 端口，不跟随重定向。
DNS 固定并拒绝本机、内网和保留地址；单次响应限制 512KB，记录最多 16000 字符与截断状态。
引用文档是非可信资料，不能成为网页指令、扩大执行权限或更改验收标准的依据。

需要自主搜索、浏览或更深入研究时，通过插件 API 提供可信 Host 研究能力：

```js
const runtime = ctx.autonomousControl.createProject(config, {
  agents,
  async research(reference, context) {
    // reference 为 null 时，Host 根据目标与阶段发现适合的标的。
    // 有预设标的时，reference 是当前参考项，调用结果按 URL 缓存。
    // 这里接入自己的搜索/浏览服务，返回真实读取的文档与来源。
    return discoverOrRead(reference, context); // { url, title, text, retrievedAt } 或发现文档数组
  },
});
```

无预设参考时，回调每个阶段执行，接收 `stage`、`goal`、`previousAdvice`、`observation`、`action`。
回调失败、没有真实文档或缺少 HTTPS 来源会保留错误，不能通过来源 Gate。
配置 CLI 可以抓取预设来源；没有配置搜索服务时，并不具备任意网站的自主搜索或视觉浏览能力。

## 新项目起步

当前 Runtime 需要已有 Git HEAD，支持仅包含产品说明的初始提交；不要求预先生成应用源码。
先建立最小仓库与初始提交，并把产品目标、范围和可验证的核心用户流程交给 Loop。
Host 验收可以放在项目仓库之外，从工作目录检查新生成的产物，避免让 Builder 自己定义成功。
当前不会自动把没有初始提交的目录初始化成可运行项目，也不自动安装依赖；Host 仍负责配置测试和所需执行环境。
这些是当前接入边界，不能解释为产品必须已经做好才能进入 Loop。

可复现的原生入口：`node scripts/live-new-project.mjs config.local.json [输出目录]`。
它用 `createBriefFixture` 生成仅含产品说明与一次初始提交的仓库，把 Host 验收脚本放在产品仓库之外，
由原生 OpenCode 通过 `ctx.autonomousControl.createProject` 构建产品，再由非 Codex 平台独立审核。
入口先证明该 Host 验收在裸说明上失败，再要求 Builder 树与干净提交树都通过，主 checkout 未变、重启状态一致。
被接受的候选还必须由原生 OpenCode 最终实现且没有额度交接；其它 provider 接管即使达到 `MERGE_READY`
也会作为一个独立的非 PASS 检查如实呈现。这是该有限验收入口的边界，不是产品缺陷。
入口拒绝复用已存在的输出目录/stateDir，`start` 或状态读取抛出异常时也写入 FAIL 报告而不是中断。
报告 PASS 指候选达到 `MERGE_READY`，不是 `state.status === "complete"`；最终完成审核的 outcome 单独记录。
需要新的输出目录，Codex 不注册（不假设其额度可用）；额度不足时仍按交接规则处理，失败如实报告。
这只是有限、可复现的原生验收入口，不是完整商业产品交付证明，也没有替代已有项目演进实验。
从零到完整商业产品的原生多平台验收仍需另外运行；已有电商修复实验只证明演进场景。

## 本轮如何运行

1. 观察全项目，工作平台自由撰写对标、差距、建议和未知项；独立身份检查来源适用性与结论。
2. 决策读取原文与审核反馈，重新选当前最有价值的有限行动。初步分析 PARTIAL 不自动阻止决策。
3. 计划审核必须 PASS；执行前再检查路线，未通过不能启动写入。
4. 工作平台完成一个行动，Controller 确认进程停止，运行 Host 测试、冻结候选 commit。
5. 干净提交树测试、对标验收和独立代码审核都通过，才能推进 acceptedHead。
6. 下一轮重新观察。最终完成另外检查整个产品；本轮 PASS、测试全绿或预算耗尽都不代表商业化完成。

研究建议保留为 Markdown/自由文本，不要求 JSON 研究模板；安全脱敏仍适用。
商业模式下 Builder 的总结也保留为自由文本；Host 从真实文件差异建立候选，不能因总结声称成功就放行。
Host 观察到的运行环境和实际接口契约同时交给决策与 Builder，不能只留在前期分析中。
只有可执行行动边界和独立审核有机器契约。
审核可返回 PASS、BLOCKED、PARTIAL、WRONG_DIRECTION、NEED_RESEARCH、REGRESSION。
对需要补研究或调整方向的强制阶段，最多尝试配置的 1..3 次，保留前次意见。
不会无限重复，也不会为了继续而把审核失败改成 PASS。

阶段记录位于 stateDir 的 `evidence/<id>/analysis.md`、`context.json`、`alignment.json`。
重启后恢复原分析；Web 证据入口可打开分析和审核。候选审核反馈保留到下一轮全局诊断。
执行期间对标检查由工作平台完成；当前没有每次文件修改都强制切换 Reviewer 的细粒度机制。

## 额度交接与独立性

有效协议中的额度错误会直接传播，不会作为 JSON 输出噪声忽略。
在旧平台确认停止后，保存目标、提示、原分析、工作树快照与部分改动，再交给可用平台继续同一行动。
贡献过代码的所有平台身份及持久化平台 ID 都被排除于候选审核，包括重启后重建 adapter 的情况。
计划审核同样排除已选 Builder；Reviewer 不能改代码。
STOP_UNCONFIRMED 会停止 Loop，不允许新写入者接管。

OpenCode 的大上下文按文件字节数、行长度和行数切分为多个附件，适应原生 ReadTool 限制。
包装换行用于传输给模型，不保证内嵌 JSON 字符串仍是可直接解析的原始机器数据。
超出附件预算时明确失败，不静默丢弃尾部的当前测试证据。

## 自动模型路由

`models` 是 Host 提供的模型登记表；启用后每次行动按任务证据选择模型，不再只用一个静态模型。

```json
{
  "autoModelRouting": true,
  "models": [
    { "id": "opencode-go/deepseek-v4.1-flash", "provider": "opencode", "tier": "routine", "cost": 1 },
    { "id": "opencode-go/deepseek-v4.1", "provider": "opencode", "tier": "deep", "cost": 3 },
    { "id": "opencode-go/deepseek-v4-pro", "provider": "opencode", "tier": "deep", "cost": 9, "prohibited": true }
  ]
}
```

- `models[].provider` 必须与 `agents` 中的键一致；`tier` 为 `routine|deep|security`；`cost` 只是同层内的相对偏好，不是额度数量。
- 默认：普通行动选 `routine` 层（如 V4.1 Flash）；高风险或连续/恶化失败上移到 `deep`；需要 security 能力的独立审核选 `security`；同层内取成本最低者。
- 禁止项用元数据 `prohibited: true` 表示（例如 V4 Pro），绝不按模型名字匹配；`eligible: false` 同样排除。
- 失败关闭：登记表为空、格式非法、或没有符合层级的可用模型时抛出 `RoutingError`，该行动按 `FAILED` 处理；不会把 provider 标记为离线，也不会触发无意义的额度交接。
- 每次调用把 `task.model` 传给四个原生 adapter；`config.model` 只在路由关闭时作为回退。登记表存在但显式 `autoModelRouting: false` 时，静态 `config.model` 也必须是可用的登记项。
- 路由证据以 `{ selectedModel, provider, reason, inputs, at }` 保存在行动、决策与每次运行记录上，并随 `/api/state` 的 `view()` 暴露，便于核查。
- `quotaGroup` 由 Host 声明（例如把 Codex-backed Pi 与 Codex 设为同一组）；只有显式额度错误会让同组全部视为不可用，Codex 与 Pi 不会被当成两份独立预算。未声明时不做任何假设。
- 路由只为已经选定的 Worker（包括独立 Reviewer）选择模型，不改变审核者选择；Builder 仍然不能选择自己的 Reviewer，额度交接、权限与最终 Gate 都不受影响。

### 失败分类与额度交接

运行时将失败按来源分类，避免一次超时或本地启动/传输错误就推断整个账户额度耗尽：

- `timeout`：单次调用超过 `agentTimeoutMs`（消息为 `Agent run budget exceeded`）。只记为该次调用失败，不把 provider 或同 `quotaGroup` 成员标记为离线。
- `transport`/`spawn`：本地可执行文件缺失、Windows 监管进程 `CreateProcess` 失败、连接/传输错误（`ENOENT`、`ECONNREFUSED`、`ETIMEDOUT` 等）。同样不推断账户额度耗尽。
- `quota`：协议返回 `Usage limit exceeded`、`quota exceeded/exhausted`、`insufficient_quota` 等。此时才将 adapter 设为 `offline`，并通过 `quotaGroup` 传播到同组所有成员。
- `length`：OpenCode 等原生帧报告 `finishReason=length`/`max_tokens` 且可见输出为零。保留 `finishReason` 与 usage 计数器作为输出耗尽证据，不保存隐藏推理内容；普通空输出仍按原 `Empty research response` 处理。

商业 Loop 在确认 Worker 停止后才进行额度交接。交接记录保存 `from/to/attempt/failureKind` 以及下一次运行的路由证据（所选模型、原因、输入）。同一行动继续时，优先换用不同 provider 的可用模型；同 provider 失败则通过 `escalate` 尝试更强 eligible tier，不会降层、不会调用 `prohibited` 模型、也不会无限重试同一失败模型。部分工作区与 Builder 身份历史保留给接续者和审核者。

独立商业审核在确认失败 Reviewer 停止后，依次尝试所有剩余 eligible 独立 Reviewer；Builder 及所有 Builder 身份被排除，Reviewer 只读，遇到 `STOP_UNCONFIRMED` 或全部耗尽时关闭失败，不会把 NEED_RESEARCH/PARTIAL/失败审核改为 PASS。

## 尚未证明的能力

- 通用搜索、交互浏览和视觉对标需要额外 Host 能力，预设来源抓取不等于完整市场研究。
- 目前执行候选仍是代码写入；自由研究阶段不等于已实现独立的研究/实验行动类型。
- 同进程额度交接可保留部分代码；所有平台不可用或 Controller 崩溃后，尚不能保证自动恢复同一未完成写入。
  使用已有恢复入口停止残留进程、保留 checkpoint，再核对工作树后重新规划。
- 平台额度隔离目前限于当前运行实例，重启后会重新检查可用性。
- 单次有限行动验收不能证明大型商业项目无人值守长期交付；真实支付、上线运营和完整商业流程必须另有证据。

完整目标仍见 [共同 Loop 规范](shared-commercial-loop.md)。本文描述当前可运行实现，不将目标规范当作已验收能力。
