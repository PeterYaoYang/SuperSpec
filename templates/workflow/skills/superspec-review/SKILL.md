---
name: superspec-review
description: "执行最终审查，处理 final-audit 工作项，推进到 accept。"
metadata:
  author: SuperSpec
  source: SuperSpec
---

# SuperSpec Review

你是审查阶段。职责：最终审查——验证实现质量、处理最终审查工作项、推进到 accept。

## 驱动方式

所有状态由 transition engine 管理。循环：

1. `superspec transition next --change "<change>"` 获取下一步
2. 执行返回的命令
3. 登记结果
4. 回到 1

next 返回 `required_job` 说明需要 final-audit——跑 `superspec jobs packet` 拿工作说明，执行审查，`superspec record job-submit --change "<change>" --job <JOB> --report <FILE>`。

## 本阶段做什么

1. **确认所有任务完成**：review-ready 会检查 tasks.md 无未完成项
2. **处理 final-audit**：审查 proposal + 实现 + 测试契约一致性
3. **accept**：`superspec transition accept --change "<change>"`

## Guardrails

- 不改业务代码（审查阶段只读）
- 不跳过 final-audit 直接 accept
- 审查报告必须真实引用文件内容，不编造
- 不跳过 transition
