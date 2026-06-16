---
name: superspec-apply
description: "3.方案通过后用：按 tasks 一项项写代码、跑测试、记录证据；每个任务都要先证明测试会失败，再实现到测试通过。"
metadata:
  author: SuperSpec
  source: SuperSpec
---

# SuperSpec Apply

## 语言规则 / Language

- 默认使用简体中文写人类可读内容；命令、路径、字段名、阶段门名、task/test id、代码标识符保留原文。
- 用户可见文案不得使用“裁决”描述用户动作；统一说“确认”“范围取舍”“处理方式选择”或“用户确认记录”。
- 不把内部证据种类、reason code、JSON 字段大全直接转述给用户；需要诊断时才引用原文。
- 普通 workflow 命令使用 `--format agent`；`--format json` 只用于诊断，不作为默认上下文。

## 命令执行 / Shell

- Windows PowerShell 中使用 `.cmd` shim：`superspec.cmd ...`、`openspec.cmd ...`；不要运行 `superspec.ps1` 或 `openspec.ps1`。
- 其他 shell 使用文档中的 `superspec ...`、`openspec ...` 命令。

## 阶段职责

Apply 按 OpenSpec tasks 实现，负责 RED/GREEN 证据、任务勾选和 review request-changes 后的 reopen 修复；不扩大范围，不改 proposal package 语义。

## 第一条必跑命令

```text
superspec check workflow-packet --change "<change>" --gate apply_ready --format agent
```

遇到任何返回状态为 `block` 就停止；未 allowed 前不要编辑实现。

## OpenSpec 边界

- 直接使用 OpenSpec CLI surface，不读取 repo-local `openspec-*` skill 文本。
- task list、`contextFiles`、progress、dynamic instruction 来自：

```text
openspec instructions apply --change "<change>" --json
```

不要发明 task list，也不要跳过 OpenSpec 返回的 context files。

## Task Guard 边界

实现编辑前读取 `task_edit` 检查结果；勾选 task 前读取 `task_complete` 检查结果：

```text
superspec check workflow-packet --change "<change>" --gate task_edit --task-id "<task-id>" --format agent
superspec check workflow-packet --change "<change>" --gate task_complete --task-id "<task-id>" --format agent
```

`task_edit` 未 allowed 不得编辑实现；`task_complete` 未 allowed 不得把 checkbox 改成 done。

## Reopen 边界

review 给出 `request_changes_route:"reopen_tasks"` 时，先生成完整 reopen package，再检查：

```text
superspec check workflow-packet --change "<change>" --gate task_reopen --task-id "<task-id>" --format agent
```

只有 `task_reopen` allowed 后，才允许把目标 task 从 checked 改回 unchecked 并重新 RED/GREEN。修完写 `task_reopen_resolved`，再进 review。若 route 是 `change_update`，停止 apply 并回 propose/change update。

## 用户确认边界

- apply isolation 和 execution mode 必须等待明确选择。
- 分支状态、dirty worktree、scope expands 或需要改变 task scope 时必须停止并确认。
- 不要使用默认值、历史偏好或沉默作为确认。

## 专用代理边界

主线程只负责用检查命令生成各角色提示、分派专用代理、审核代理报告、登记证据、推进任务勾选。专用代理来自 `.codex/agents/*.toml` 与 `.codex/prompts/*.md`，不能由主线程自审替代。代理报告只是候选材料，通过检查的才是正式证据。当前 CLI 没有登记证据的命令；代理报告返回后，由主线程按检查命令的 output contract 字段手动写入 `.superspec/evidence/` 对应目录。

RED/characterization/GREEN 测试必须由 `.codex/agents/test-runner.toml` + `.codex/prompts/test-runner.md` 执行；主线程不得代跑或伪造 formal `test_run` evidence。新增或修改测试文件时用 `test-engineer` 专用代理。

```text
superspec check apply-test-packet --change "<change>" --task-id "<task-id>" --test-id "<test-id>" --phase red --format prompt
```

用 test-runner 执行检查命令指定的测试命令；主线程审核报告/原始日志并登记为证据后，才写正式 `test_run` 证据。

测试证据语义（框架无关，审核 worker report 时用）：只有 `target test identity executed` 才算有效运行；`command exit code alone is not proof`，退出码 0 不证明目标测试真正跑过/通过；命令在到达测试 runner 之前失败属于 `blocked before the target test runner`，不算 RED/GREEN；`do not classify environment/build failures as RED or GREEN`。

`apply_execution_surface`：缺省有 `write_scope` 为 `implementation`，无 `write_scope` 为 `no_code`；显式允许 `implementation`、`runtime_config`、`docs_generated`、`no_code`。`implementation` / `runtime_config` 必须走 executor-worker chain；`tdd_required:false` 也只能用 closed `apply_worker_chain` 的 `completion_proof_kind:"alternative_verification"` 完成。`docs_generated` / `no_code` 可用 direct alternative/manual verification。

编码实现必须由 `.codex/agents/executor.toml` + `.codex/prompts/executor.md` 执行，并通过 active -> closed `apply_worker_chain` 收敛；主线程不得直接改实现代码来完成 task。

```text
superspec check apply-executor-packet --change "<change>" --task-id "<task-id>" --apply-worker-chain-ref "<active-chain-ref>" --format prompt
```

使用 `.codex/agents/executor.toml` / `.codex/prompts/executor.md`。先把检查命令给出的激活模板登记为工作链证据；缺激活标记不能启动 executor。TDD 与 no-TDD 的激活标记不同（具体字段以检查命令输出为准）。executor 只能改检查命令声明的实现写范围（implementation/runtime_config write scope），不能写正式 evidence，不能改 task checkbox，不能做 review/verification。

executor 返回后把报告登记为证据，再生成任务级审查：

```text
superspec check apply-code-review-packet --change "<change>" --task-id "<task-id>" --executor-report-ref "<ref>" --format prompt
```

用 `.codex/agents/code-reviewer.toml` 检查 scope/protected paths、executor report 与 diff、test/invariant mapping 和 suggested GREEN checks。

code-review 通过后，GREEN 只走同一 executor-worker chain：

```text
superspec check apply-test-packet --change "<change>" --task-id "<task-id>" --test-id "<test-id>" --phase green --task-code-review-report-ref "<ref>" --format prompt
```

GREEN report 审核并登记为 evidence 后，生成 GREEN verification：

```text
superspec check apply-verify-packet --change "<change>" --task-id "<task-id>" --executor-report-ref "<ref>" --task-code-review-report-ref "<ref>" --green-test-run-evidence-ref "<ref>" --red-test-run-evidence-ref "<ref>" --format prompt
```

no-TDD implementation/runtime_config 先登记 live/pass `alternative_verification` 或 `manual_verification`，再生成 alternative verification：

```text
superspec check apply-verify-packet --change "<change>" --task-id "<task-id>" --executor-report-ref "<ref>" --task-code-review-report-ref "<ref>" --alternative-verification-evidence-ref "<ref>" --format prompt
```

用 `.codex/agents/verifier.toml` 检查完成方式分支：GREEN 绑定 RED/characterization、GREEN 和当前工作区；alternative 绑定 no-TDD 激活标记、实际替代/人工验证引用、surface/no-TDD 元数据和当前工作区。审核 verifier 报告后写关闭的工作链证据，再跑 `task_complete`。异常终止只取消旧工作链，不授权完成。

## 完成检查

每个 task 的证据链（RED/characterization → executor → code-review → GREEN 或替代验证 → verifier）齐全后，运行任务完成检查：

```text
superspec check workflow-packet --change "<change>" --gate task_complete --task-id "<task-id>" --format agent
```

只有检查结果显示通过后，才把该 task 的 checkbox 改为 done。所有 task 完成后进入 `superspec-review`。

## 异常恢复

状态文件损坏时重建：

```text
superspec check recompute --change "<change>" --rebuild-corrupt
```

状态指纹过期时，重跑对应检查命令即可（检查命令会自动重算并刷新指纹）；不要手写状态文件。
