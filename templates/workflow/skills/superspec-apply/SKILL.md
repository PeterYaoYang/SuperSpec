---
name: superspec-apply
description: "3.方案通过后用：按 tasks 一项项写代码、跑测试、记录证据；每个任务都要先证明测试会失败，再实现到测试通过。"
metadata:
  author: SuperSpec
  source: SuperSpec
---

# SuperSpec Apply

## 语言规则 / Language

- 默认使用简体中文写人类可读内容；命令、路径、字段名、gate 名、task/test id、代码标识符保留原文。
- 用户可见文案不得使用“裁决”描述用户动作；统一说“确认”“范围取舍”“处理方式选择”或“用户确认记录”。
- 不把内部证据种类、reason code、JSON 字段大全直接转述给用户；需要诊断时才引用原文。
- 普通 workflow 命令使用 `--format agent`；`--format json` 只用于诊断，不作为默认上下文。

## 命令执行 / Shell

- Windows PowerShell 中使用 `.cmd` shim：`superspec.cmd ...`、`openspec.cmd ...`；不要运行 `superspec.ps1` 或 `openspec.ps1`。
- 其他 shell 使用文档中的 `superspec ...`、`openspec ...` 命令。

## 阶段职责

Apply 按 OpenSpec tasks 执行实现，负责 RED/GREEN 证据、任务勾选和 review request-changes 后的 reopen 修复。不扩大范围，不改 proposal package 语义。

## 第一条必跑命令

先尝试建立当前 change 的 SuperSpec hook session。R-1/provenance 未通过时该命令只会记录 audit-only lease 和降级诊断，不代表 mechanical enforcement 已启用：

```text
superspec guard hook-session-begin --change "<change>" --workflow superspec-apply --entrypoint-token "<fresh-entrypoint-token>" --format agent
superspec guard hook-session-status --change "<change>" --format agent
```

```text
superspec guard workflow-packet --change "<change>" --gate apply_ready --format agent
```

遇到任何 guard `block` 就停止。未 allowed 前不要编辑实现。

## OpenSpec 边界

- 直接使用 OpenSpec CLI surface，不读取 repo-local `openspec-*` skill 文本。
- task list、`contextFiles`、progress 和 dynamic instruction 来自：

```text
openspec instructions apply --change "<change>" --json
```

不要自行发明 task list，也不要跳过 OpenSpec 返回的 context files。

## Task Guard 边界

实现编辑前读取 task packet：

```text
superspec guard workflow-packet --change "<change>" --gate task_edit --task-id "<task-id>" --format agent
```

勾选 task 前读取 completion packet：

```text
superspec guard workflow-packet --change "<change>" --gate task_complete --task-id "<task-id>" --format agent
```

`task_edit` 未 allowed 不得编辑实现；`task_complete` 未 allowed 不得把 checkbox 改成 done。

## Reopen 边界

如果 review 给出 `request_changes_route:"reopen_tasks"`，先生成完整 reopen package，再检查：

```text
superspec guard workflow-packet --change "<change>" --gate task_reopen --task-id "<task-id>" --format agent
```

只有 `task_reopen` allowed 后，才允许把目标 task 从 checked 改回 unchecked 并重新 RED/GREEN。修完后写 `task_reopen_resolved`，再重新进入 review。若 route 是 `change_update`，停止 apply 并回 propose/change update。

## 用户确认边界

- apply isolation 和 execution mode 必须等待明确选择。
- 分支状态、dirty worktree、scope expands 或需要改变 task scope 时必须停止并确认。
- 不要使用默认值、历史偏好或沉默作为确认。

## Native Subagent 边界

Apply 主流程负责 evidence、审核接收、task checkbox 和 `task_complete`；worker report 只是 candidate。repo-local native agents 必须来自 `.codex/agents/*.toml` 与 `.codex/prompts/*.md`，不能由主线程自审替代。

可选 RED/characterization 测试 worker：

```text
superspec guard apply-test-packet --change "<change>" --task-id "<task-id>" --test-id "<test-id>" --phase red --format prompt
```

使用 `.codex/agents/test-runner.toml` / `.codex/prompts/test-runner.md` 执行 packet 指定命令。主线程审查 test-runner report 和 raw transcript，materialize 为 pinned refs 后，才写正式 `test_run` evidence。

可选 executor-worker chain：

```text
superspec guard apply-executor-packet --change "<change>" --task-id "<task-id>" --apply-worker-chain-ref "<active-chain-ref>" --format prompt
```

使用 `.codex/agents/executor.toml` / `.codex/prompts/executor.md`。先记录 packet 的 `chain_activation_template` 为 active `apply_worker_chain` evidence；缺 active marker 不得 spawn executor。executor 只能改 packet 声明的 implementation write scope，不能写正式 evidence、不能改 task checkbox、不能做 review/verification。

executor 返回后先 materialize executor report pinned ref，再生成 task-level review：

```text
superspec guard apply-code-review-packet --change "<change>" --task-id "<task-id>" --executor-report-ref "<ref>" --format prompt
```

用 `.codex/agents/code-reviewer.toml` 检查明显缺陷、scope/protected paths、executor report 与 diff 一致性、test/invariant mapping 和 suggested GREEN checks。code-reviewer report 不是 correctness proof。

code-review 审核通过后，GREEN 只走同一 executor-worker chain：

```text
superspec guard apply-test-packet --change "<change>" --task-id "<task-id>" --test-id "<test-id>" --phase green --task-code-review-report-ref "<ref>" --format prompt
```

GREEN report 经主线程审核通过并登记为正式 evidence 后，生成 post-GREEN verification：

```text
superspec guard apply-verify-packet --change "<change>" --task-id "<task-id>" --executor-report-ref "<ref>" --task-code-review-report-ref "<ref>" --green-test-run-evidence-ref "<ref>" --red-test-run-evidence-ref "<ref>" --format prompt
```

用 `.codex/agents/verifier.toml` 检查 RED/characterization -> executor -> code-review -> GREEN -> current worktree 的证据链和 freshness。verifier report 经主线程审核通过后写 closed `apply_worker_chain` evidence，再运行 `task_complete`。中途转串行 fallback 前，先写 abandoned `apply_worker_chain` evidence，并保留恢复或 serial takeover baseline proof。
