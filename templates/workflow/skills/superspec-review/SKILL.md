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

`record job-submit` 沿用现有 raw 归档：报告追加到 `raw/review-reports.jsonl`，不会为 review gate 新增 raw 文件类型。

## 本阶段做什么

1. **确认所有任务完成**：review-ready 会检查 tasks.md 无未完成项
2. **处理 verifier**：核对 proposal + 实现 + 测试契约一致性
3. **accept**：`superspec transition accept --change "<change>"`

## verifier gate 规则

- `review-ready` 首次运行会持久化审查策略；后续 risk 参数不会覆盖首次策略。
- `minimal` 不要求 verifier；`normal` 和 `strict` 要求 verifier。
- 当前 MVP 中 `strict` 等同 `normal`，不启用额外检查。
- 如果 review 状态缺少审查策略，先运行 `review-ready` 补策略，不直接 accept。
- verifier 工作项 packet 会包含绑定文档和 `review_evidence_digest`，用于确认审查对应的任务完成与 RED/GREEN 证据版本。
- verifier 通过后，如果绑定文档或已登记执行证据版本变化，需要重新运行 `review-ready` 创建新的 verifier。

## Guardrails

- 不改业务代码（审查阶段只读）
- 不跳过 verifier 最终验证直接 accept
- 审查报告必须真实引用文件内容，不编造
- 不跳过 transition
