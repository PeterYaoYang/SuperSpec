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
- `tdd_required:false` + `no_tdd_reason:xxx`——纯文档/配置/机械改名/生成物

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
