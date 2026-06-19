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

当前 CLI surface：

- 用 `openspec status --change "<change>" --json` 确认 OpenSpec 当前状态。
- 通过 `openspec instructions <artifact> --change "<change>" --json` 获取 proposal、spec、design、tasks 等 artifact 的写法约束。
- 基础计划文档齐全后，执行 `superspec transition propose-ready --change "<change>" --risk strict`；`minimal`、`normal`、`strict` 分别控制需要的审查 job 数量。
- `normal` 至少可能创建 `proposal-auditor`；`strict` 可能创建 `proposal-auditor`、`critic-review`、`architect-review`、`test-engineer-review`。
- 有 open job 时，用 `superspec jobs packet --change "<change>" --job "<job-id>"` 取包，再用 `superspec record job-submit --change "<change>" --job "<job-id>" --report <report.json>` 提交报告。
- 不要把 `superspec status` 的 job 计数当 propose 审查真相；以 transition 返回的 required_job 和 job packet 为准。
- 不要绕过 `openspec instructions` 徒手另造一套 OpenSpec artifact 写法。

## 本阶段做什么

### proposal.md
需求陈述、方案概述、影响范围。

### specs/
OpenSpec 能力规范增量（`openspec instructions specs` 格式）。

### design.md
技术方案、关键决策、替代方案。

### tasks.md
任务列表，格式：

```markdown
# Tasks

- [ ] TASK-001 实现登录功能 tdd_required:true
- [ ] TASK-002 更新文档 tdd_required:false no_tdd_reason:documentation-only
- [ ] TASK-003 配置变更 tdd_required:false no_tdd_reason:configuration-only
```

规则：
- `tdd_required:true`（默认）——改运行时代码/业务逻辑/数据迁移/权限/外部接口
- `tdd_required:false` 和 `no_tdd_reason` 必须写在同一条 `TASK-*` 任务行里——纯文档/配置/机械改名/生成物，例如 `no_tdd_reason:documentation-only`

### business-invariants.md
格式：

```markdown
# Business Invariants

- INV-001 用户密码必须加密存储
- INV-002 订单金额不能为负数
```

### test-contract.md
格式：

```markdown
# Test Contract

| test_id | invariant | scenario |
|---|---|---|
| TEST-001 | INV-001 | 注册时密码被加密 |
| TEST-002 | INV-002 | 订单金额为负时拒绝 |
```

## 完成条件

tasks.md 作为计划文档就绪（不是复选框全完成）+ 基础职责文档齐全 → next 返回 propose-ready 命令。

## Guardrails

- tasks.md 只列任务，不实现
- 不改业务代码
- tdd_required 标注真实
- 不跳过 transition
- `boundFiles` 不包含 `specs/**/*.md` 时，不要把该 job 当成 specs 变更的新鲜审查证据
