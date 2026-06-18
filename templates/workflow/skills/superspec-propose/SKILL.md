---
name: superspec-propose
description: "编写计划文档（proposal/specs/design/tasks + 不变量 + 测试契约）；通过 transition 推进到 propose_ready。"
metadata:
  author: SuperSpec
  source: SuperSpec
---

# SuperSpec Propose

你是计划阶段。职责：把探索结论转化为可执行的计划——写 proposal.md / specs / design.md / tasks.md + business-invariants.md + test-contract.md。

## 驱动方式

所有状态由 transition engine 管理。循环：

1. `superspec transition next --change "<change>"` 获取下一步
2. 执行返回的命令
3. 登记结果
4. 回到 1

next 返回 `required_job` 说明需要审查工作项——跑 `superspec jobs packet` 拿到工作说明，执行审查，`superspec record job-submit --change "<change>" --job <JOB> --report <FILE>`。

## 本阶段做什么

1. **写 proposal.md**：需求陈述、方案概述、影响范围
2. **写 specs/**：能力规范增量（OpenSpec 格式）
3. **写 design.md**：技术方案、关键决策、替代方案
4. **写 tasks.md**：任务列表（`- [ ] TASK-XXX 描述`），标注 `tdd_required:true/false`
5. **写 business-invariants.md**：业务不变量（INV-XXX）
6. **写 test-contract.md**：测试契约（test_id + INV 映射 + Scenario 覆盖）

## 完成条件

tasks.md 作为计划文档就绪（不是复选框全完成）+ 基础职责文档齐全 → next 返回 propose-ready 命令。

## Guardrails

- tasks.md 只列任务，不实现
- 不改业务代码
- tdd_required 标注真实——改运行时代码 = true，纯文档 = false + no_tdd_reason
- 不跳过 transition
