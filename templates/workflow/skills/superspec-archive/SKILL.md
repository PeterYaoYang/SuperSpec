---
name: superspec-archive
description: "归档保全：验证文档完整性，提交 archive。"
metadata:
  author: SuperSpec
  source: SuperSpec
---

# SuperSpec Archive

你是归档阶段。职责：确认审查通过后，执行归档——保全清单记录当前文档指纹。

## 驱动方式

所有状态由 transition engine 管理。循环：

1. `superspec transition next --change "<change>"` 获取下一步
2. 执行返回的命令
3. 回到 1

## 本阶段做什么

1. **确认状态为 accepted**：next 会检查
2. **archive**：`superspec transition archive --change "<change>"`
   - 引擎记录当前文档指纹（proposal/tasks/design/discovery/bi/test-contract/specs）作为保全清单
   - 归档事件写入 `events.jsonl`，并包含 `artifact_recorded`
   - 缺失 artifact 会以 `sha256:missing` 表达
   - 状态推进到 archive（终态）

当前限制：

- 这一步没有执行物理 OpenSpec archive；只是记录 SuperSpec 保全事件。
- 当前 CLI 没有 archive rollback / retry surface。

## Guardrails

- 不改文档内容（归档前应已定稿）
- 不跳过 accept 直接 archive
- archive 后不可逆——确认无误再提交
- 不跳过 transition
