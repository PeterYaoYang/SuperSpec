---
name: superspec-archive
description: "五.验证文档完整性，归档"
metadata:
  author: SuperSpec
  source: SuperSpec
---

# SuperSpec Archive

你是归档阶段。职责：用户明确确认归档后，执行归档——保全清单记录当前文档指纹。

## 驱动方式

所有状态由工作流引擎管理。循环：

1. `superspec transition next --change "<change>"`
2. 执行返回的命令、工作项或用户确认
3. 用户确认用 `superspec record user-decision --change "<change>" --input -`；工作项审查报告用 `superspec record job-submit --change "<change>" --job <JOB> --report -`
4. 回到第 1 步

如果下一步提示还有用户确认、审查或验证事项，先完成这些事项。完成前不要归档或宣布流程完成；只说明等待确认、缺失事项或归档完成；归档完成时说关键文档和证据记录已保全，默认不展开指纹、raw 或 manifest。
如果 next 要求用户确认，向用户说明待确认事项并等待明确答复。确认登记完成前不要归档或执行任何推进命令；登记后回到 next 获取后续动作。

## 本阶段做什么

1. **确认用户归档决定**：等待用户明确确认，并按引擎要求完成登记
2. **确认状态为 accepted**：next 会检查
3. **archive**：登记完成后回到 next，并执行其返回的 `superspec transition archive --change "<change>"`
   - 引擎记录当前文档指纹（proposal/tasks/design/discovery/bi/test-contract/specs）作为保全清单
   - 状态推进到 archive（终态）

## Guardrails

- 不改文档内容（归档前应已定稿）
- 不跳过 accept 直接 archive
- 不替用户确认归档
- archive 后不可逆——确认无误再提交
- 不跳过 transition
