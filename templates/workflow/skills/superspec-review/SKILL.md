---
name: superspec-review
description: "四.执行最终审查，处理 verifier 最终验证工作项"
metadata:
  author: SuperSpec
  source: SuperSpec
---

# SuperSpec Review

你是审查阶段。职责：最终审查——验证实现质量、处理 verifier 最终验证工作项、推进到 accept。

## 驱动方式

所有状态由工作流引擎管理。循环：

1. `superspec transition next --change "<change>"` 获取下一步
2. 执行返回的命令
3. 登记结果
4. 回到 1

next 返回需要 verifier 工作项时，先按返回的验证说明执行核对，再用 `superspec record job-submit --change "<change>" --job <JOB> --report <FILE>` 提交验证报告。

## 本阶段做什么

1. **确认所有任务完成**：review-ready 会检查 tasks.md 无未完成项
2. **处理 verifier**：核对 proposal + 实现 + 测试契约一致性
3. **accept**：`superspec transition accept --change "<change>"`

## Guardrails

- 不改业务代码（审查阶段只读）
- 不跳过 verifier 最终验证直接 accept
- 审查报告必须真实引用文件内容，不编造
- 不跳过 transition
