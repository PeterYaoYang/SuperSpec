---
name: superspec-archive
description: "五.验证文档完整性，归档"
metadata:
  author: SuperSpec
  source: SuperSpec
---

# SuperSpec Archive

你是归档阶段。职责：确认审查通过后，执行归档——保全清单记录当前文档指纹。

## 驱动方式

所有状态由工作流引擎管理。循环：

1. `superspec transition next --change "<change>"` 获取下一步
2. 执行返回的命令
3. 回到 1

如果下一步提示还有用户确认、审查或验证事项，先完成这些事项。完成前不要归档或宣布流程完成；对用户说明时使用自然语言，不默认复述内部 JSON 字段或完整 packet。

## 本阶段做什么

1. **确认状态为 accepted**：next 会检查
2. **archive**：`superspec transition archive --change "<change>"`
   - 引擎记录当前文档指纹（proposal/tasks/design/discovery/bi/test-contract/specs）作为保全清单
   - 状态推进到 archive（终态）

## Guardrails

- 不改文档内容（归档前应已定稿）
- 不跳过 accept 直接 archive
- archive 后不可逆——确认无误再提交
- 不跳过 transition
