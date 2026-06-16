---
name: superspec-propose
description: "2.需求已经清楚后用：把探索记录（`discovery.md`）整理成正式方案包，包括方案说明（`proposal.md`）、需求规格（`specs/**`）、设计说明（`design.md`）、任务清单（`tasks.md`）、测试契约和业务约束；这一步只定方案，不写实现。"
metadata:
  author: SuperSpec
  source: SuperSpec
---

# SuperSpec Propose

## 语言规则 / Language

- 默认使用简体中文写人类可读内容；命令、路径、字段名、阶段门名、task/test id、代码标识符保留原文。
- 用户可见文案不得使用“裁决”描述用户动作；统一说“确认”“范围取舍”“处理方式选择”或“用户确认记录”。
- 不把内部证据种类、reason code、JSON 字段大全直接转述给用户；需要诊断时才引用原文。
- 普通 workflow 命令使用 `--format agent`；`--format json` 只用于诊断，不作为默认上下文。

## 命令执行 / Shell

- Windows PowerShell 中使用 `.cmd` shim：`superspec.cmd ...`、`openspec.cmd ...`；不要运行 `superspec.ps1` 或 `openspec.ps1`。
- 其他 shell 使用文档中的 `superspec ...`、`openspec ...` 命令。

## 阶段职责

Propose 把 discovery 转成 OpenSpec proposal package，并按阶段生成 SuperSpec 业务约束和测试契约辅助文档。负责产出 `proposal.md`、`specs/**/*.md`、`design.md`、`tasks.md`，以及在需要时新建或更新 `.superspec/artifacts/business-invariants.md`、`.superspec/artifacts/test-contract.md`。本阶段不改实现代码。

## 第一条必跑命令

```text
superspec check workflow-packet --change "<change>" --gate explore_complete --format agent
```

遇到 `block` 就停止，回 explore 阶段补事实或确认。

## OpenSpec 边界

- 直接使用 OpenSpec CLI surface，不读取 repo-local `openspec-*` skill 文本。
- 用 `openspec status --change "<change>" --json` 获取 artifact 顺序、状态和路径。
- OpenSpec 标准文件必须通过 `openspec instructions` 生成，不要手写绕过：

```text
openspec instructions <artifact-id> --change "<change>" --json
```

## 执行步骤

把 discovery 整理成 OpenSpec proposal package，每个正本 artifact 都通过 OpenSpec 产出引擎生成：

1. 运行 `openspec status --change "<change>" --json`，取 artifact 顺序、状态和 `resolvedOutputPath`。
2. 每个 artifact（proposal/specs/design/tasks）运行 `openspec instructions <artifact-id> --change "<change>" --json`，取回 template/rules/context/instruction/dependencies。
3. 先读 dependencies 列出的已完成 artifact，再按 template 写到 `resolvedOutputPath`；context/rules 是对作者的约束，不写进产出文件。
4. 辅助文档（`.superspec/artifacts/business-invariants.md`、`.superspec/artifacts/test-contract.md`）如果尚不存在，就按 SuperSpec 内置模板在 change 内 `.superspec/artifacts/` 新建；已存在则基于当前阶段要求更新。
5. `invariants_reviewed` 的 `workflow-packet` 会下发 `business_invariants_template` 与 `business_invariants_rules`；必须按该骨架直接填写，不得改成段落/列表。
6. `test_contract_drafted` 的 `workflow-packet` 会下发 `test_contract_template` 与 `test_contract_rules`；必须按该骨架直接填写，不得改成段落/列表。
7. `business-invariants.md` 的 `## Invariants` / `## Mapping` 和 `test-contract.md` 的 `## 测试覆盖矩阵` 必须保持 Markdown 表格，列名原样保留。

## Packet 驱动的阶段门

按 artifact 依赖顺序工作，每个门都先读检查结果，通过后才进入下一段：

```text
superspec check workflow-packet --change "<change>" --gate proposal_reviewed --format agent
superspec check workflow-packet --change "<change>" --gate design_complete --format agent
superspec check workflow-packet --change "<change>" --gate invariants_reviewed --format agent
superspec check workflow-packet --change "<change>" --gate test_contract_drafted --format agent
superspec check workflow-packet --change "<change>" --gate test_contract_honored --format agent
superspec check workflow-packet --change "<change>" --gate tasks_complete --format agent
superspec check workflow-packet --change "<change>" --gate propose_complete --format agent
superspec check workflow-packet --change "<change>" --gate apply_ready --format agent
```

`proposal_reviewed` 不是 advisory note；它是硬门。`propose.proposal_reviewed`、`propose.design_reviewed`、`propose.invariants_reviewed`、`propose.test_plan_drafted`、`propose.tasks_mapped` 是兼容别名，检查结果输出中的规范阶段门名为准。

## 专用代理边界

- proposal review 使用 repo-local `critic`。
- design review 使用 repo-local `architect`、`critic`、`test-engineer`。
- business-invariants 和 test-contract review 使用 repo-local `critic` / `test-engineer`。
- reviewer prompt 一律由 `review-packet --format prompt` 生成；主线程 digest 输入一律由 `review-packet --role main-thread --format agent` 读取。
- 第二轮及以后的审查，必须由检查命令把上一轮的问题注入提示，不手写历史 finding 清单。

## 用户确认边界

关键范围、非目标、验收标准、业务语义和设计边界问题必须停止并交给用户确认。主线程不能静默关闭这类 finding；需要回 explore 或回上游 artifact 时，按检查结果和阶段检查给出的回退路径处理。

设计选项选择、任务审查确认，以及任何会改变范围或验收标准的处理，都必须等待明确用户确认。

## 完成检查

```text
superspec check workflow-packet --change "<change>" --gate apply_ready --format agent
```

只有 apply-ready allowed 后，才进入 `superspec-apply`。
