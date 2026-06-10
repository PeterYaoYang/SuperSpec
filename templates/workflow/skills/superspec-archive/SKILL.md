---
name: superspec-archive
description: "5.通过原生 `openspec archive` 归档 SuperSpec OpenSpec change，并执行 SuperSpec preservation checks。 / Archive an SuperSpec OpenSpec change via native `openspec archive` with SuperSpec preservation checks."
---

# SuperSpec Archive

## 语言规则 / Language

- 默认使用简体中文撰写所有人类可读产物、分析、报告、说明和 OpenSpec 文档正文。
- 保留命令、路径、JSON 字段、gate 名、task/test id、代码标识符和外部 API 名称的原文。
- 当 OpenSpec 模板要求固定标题或字段时，保留模板结构，只将正文内容写成中文。

仅在 `review_complete` passes（其中已经包含 final verification）后使用本 skill。

## 边界 / Boundaries

- 通过 native CLI 桥接 OpenSpec archive，不手动重实现 archive。可以读取 repo-local `.codex/skills/openspec-archive-change/SKILL.md` 来获取 selection/status guardrails，但其中手动 `mkdir`/`mv` archive procedure 在这里由 `openspec archive` 取代。
- Archive 仍是 native `openspec archive`：它会移动 change、**更新 main specs（delta->main sync）**，并默认 **validates**。当前 SuperSpec v1 固定使用 `openspec archive -y "<change>"`，不暴露 `--skip-specs` 分支，且不允许 `--no-validate`。
- SuperSpec 只检查 `archive_ready` 和 archived sidecar preservation；不重新实现移动、spec sync 或 validation。
- preservation manifest 必须覆盖 `.superspec/artifacts/business-invariants.md`、`.superspec/artifacts/test-contract.md`、`.superspec/evidence/invariants/`、`.superspec/evidence/test-contract/`、RED/GREEN evidence、review/verification evidence，以及 archive evidence 本身。
- v1 archive control 通过显式 guard checks 和 preservation verification 执行。

## 步骤 / Steps

1. 对 final `archive_ready` confirmation 使用 AskUserQuestion，等待明确选择。记录 archive-scoped human-confirmation evidence。当前 v1 不询问也不使用 `--skip-specs`；若 change 不应同步 specs，应先回到 propose/change update 调整 OpenSpec 包，而不是在 archive 阶段跳过。
2. 检查 archive readiness 并生成 preservation manifest：
   ```text
   superspec guard check-archive-ready --change "<change>"
   ```
   生成的 manifest 是 archive 前证据快照，必须能追踪 business-invariants、test-contract 和对应 invariant review evidence 的 sha256。
3. 运行 native OpenSpec archive（移动 change、同步 delta->main specs、执行 validation）：
   ```text
   openspec archive -y "<change>"
   ```
4. 根据 manifest 验证 archived `.superspec/` preservation：
   ```text
   superspec guard check-archived --change "<change>"
   ```

遇到任何 guard `block` 就停止。
