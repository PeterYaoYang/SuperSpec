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

1. `superspec transition next --change "<change>"` 获取下一步
2. 执行返回的命令
3. 回到 1

如果下一步提示还有用户确认、审查或验证事项，先完成这些事项。完成前不要归档或宣布流程完成；只说明等待确认、缺失事项或归档完成；归档完成时说关键文档和证据记录已保全，默认不展开指纹、raw 或 manifest。
如果 next 返回 `archive_confirmation`，不要自行确认；只有用户明确要求归档时才执行 archive。

## 本阶段做什么

1. **确认用户已要求归档**
2. **确认状态为 accepted**：next 会检查
3. **archive**：`superspec transition archive --change "<change>"`
   - 引擎记录当前文档指纹（proposal/tasks/design/discovery/bi/test-contract/specs）作为保全清单
   - 状态推进到 archive（终态）

## Guardrails

- 不改文档内容（归档前应已定稿）
- 不跳过 accept 直接 archive
- 不替用户确认归档
- archive 后不可逆——确认无误再提交
- 不跳过 transition
