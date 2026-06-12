---
name: superspec-archive
description: "5.所有审查和验证通过后用：把完成的 change 归档到 specs，并确认关键证据和历史没有丢失；这一步是流程收尾。"
metadata:
  author: SuperSpec
  source: SuperSpec
---

# SuperSpec Archive

## 语言规则 / Language

- 默认使用简体中文写人类可读内容；命令、路径、字段名、gate 名、task/test id、代码标识符保留原文。
- 用户可见文案不得使用“裁决”描述用户动作；统一说“确认”“范围取舍”“处理方式选择”或“用户确认记录”。
- 不把内部证据种类、reason code、JSON 字段大全直接转述给用户；需要诊断时才引用原文。
- 普通 workflow 命令使用 `--format agent`；`--format json` 只用于诊断，不作为默认上下文。

## 命令执行 / Shell

- Windows PowerShell 中使用 `.cmd` shim：`superspec.cmd ...`、`openspec.cmd ...`；不要运行 `superspec.ps1` 或 `openspec.ps1`。
- 其他 shell 使用文档中的 `superspec ...`、`openspec ...` 命令。

## 阶段职责

Archive 在 `review_complete` allowed 后收尾：确认 archive readiness、保全 `.superspec` 证据快照、运行 OpenSpec archive，并验证归档后的 preservation。

## 第一条必跑命令

```text
superspec guard workflow-packet --change "<change>" --gate archive_ready --format agent
```

遇到任何 guard `block` 就停止，不归档。

## OpenSpec 边界

- 直接使用 OpenSpec CLI surface，不读取 repo-local `openspec-*` skill 文本。
- 归档动作使用 native OpenSpec CLI；SuperSpec 不重新实现移动、spec sync 或 validation。
- 当前 v1 固定使用 `openspec archive -y "<change>"`，不暴露 `--no-validate` 或 skip-specs 分支。

## 用户确认边界

`archive_ready` 最终确认必须等待明确选择。若 change 不应同步 specs，先回 propose/change update 调整方案，不在 archive 阶段跳过。

## 执行步骤

确认后运行会写 preservation manifest 的 readiness check：

```text
superspec guard check-archive-ready --change "<change>" --format agent
```

然后运行 OpenSpec archive：

```text
openspec archive -y "<change>"
```

最后验证 archived sidecar preservation：

```text
superspec guard check-archived --change "<change>" --format agent
```

`.superspec/artifacts/business-invariants.md`、`.superspec/artifacts/test-contract.md`、review/verification evidence、RED/GREEN evidence 和 archive evidence 必须能从 preservation manifest 追溯。
