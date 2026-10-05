# 共同商业 Loop：当前实现与使用

保留原 DSH agent-loop 和已有项目 Loop。只有 `commercialLoop.enabled: true` 才启用新增行为。
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

## 尚未证明的能力

- 通用搜索、交互浏览和视觉对标需要额外 Host 能力，预设来源抓取不等于完整市场研究。
- 目前执行候选仍是代码写入；自由研究阶段不等于已实现独立的研究/实验行动类型。
- 同进程额度交接可保留部分代码；所有平台不可用或 Controller 崩溃后，尚不能保证自动恢复同一未完成写入。
  使用已有恢复入口停止残留进程、保留 checkpoint，再核对工作树后重新规划。
- 平台额度隔离目前限于当前运行实例，重启后会重新检查可用性。
- 单次有限行动验收不能证明大型商业项目无人值守长期交付；真实支付、上线运营和完整商业流程必须另有证据。

完整目标仍见 [共同 Loop 规范](shared-commercial-loop.md)。本文描述当前可运行实现，不将目标规范当作已验收能力。
