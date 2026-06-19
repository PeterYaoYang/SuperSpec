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

当前 CLI surface：

- 用 `openspec validate <change>` 验证 OpenSpec artifact。
- 所有任务完成后执行 `superspec transition review-ready --change "<change>"`。
- 有 final-audit job 时，用 `superspec jobs packet --change "<change>" --job "<job-id>"` 取包。
- 审查由 `code-reviewer`、`critic`、`architect`、`verifier` 视角覆盖；报告写入 `<final-audit.json>` 后执行 `superspec record job-submit --change "<change>" --job "<job-id>" --report <final-audit.json>`。
- final-audit accepted 后，执行 `superspec transition accept --change "<change>"`。

## 本阶段做什么

1. **确认所有任务完成**：review-ready 会检查 tasks.md 无未完成项
2. **处理 final-audit**：审查 proposal + 实现 + 测试契约一致性
3. **accept**：`superspec transition accept --change "<change>"`

## 当前限制

- 当前分支没有 `verify_failure_handling` record surface。
- 当前分支没有 review -> apply 的返回 transition。
- 不要对已经终态的旧 job 反复提交新 report。
- open job 还在时它不会发新 job。
- 旧 job 才会因为 `boundFiles` 失配被拒绝终态化。
- 不要指望 report 内容本身能帮你回退。
- 不绑定源码文件或测试文件的 job，不是源码 / 测试 freshness 证明。
- 如果这次修复只改了源码或测试，而没改任何 `boundFiles`，当前 engine 没有自动 invalidation 路径。
- 源码 / 测试-only 修复不能靠旧 job 的 `boundFiles` 失配来解锁。
- 如果旧 `final-audit` job 已经因为 `boundFiles` 失配或 report 拒绝而进入终态，重新执行 review-ready 获取新的 open job。

## Guardrails

- 不改业务代码（审查阶段只读）
- 不跳过 final-audit 直接 accept
- 审查报告必须真实引用文件内容，不编造
- 不跳过 transition
- 不要发明当前分支没有的 `source_guidance` / `verification_review` / `main_adjudication` / `superspec check`
