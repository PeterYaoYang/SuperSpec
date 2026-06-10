---
name: superspec-apply
description: "3.在 SuperSpec RED/GREEN guard 检查下执行 tasks，并从 OpenSpec `openspec instructions apply` 获取任务上下文、顺序和进度。 / Apply tasks under SuperSpec RED/GREEN guard checks, delegating task context, ordering, and progress to OpenSpec `openspec instructions apply`."
---

# SuperSpec Apply

## 语言规则 / Language

- 默认使用简体中文撰写所有人类可读产物、分析、报告、说明和 OpenSpec 文档正文。
- 保留命令、路径、JSON 字段、gate 名、task/test id、代码标识符和外部 API 名称的原文。
- 当 OpenSpec 模板要求固定标题或字段时，保留模板结构，只将正文内容写成中文。
- 对话窗口里的解释、总结、提问和下一步说明必须使用中文；除命令、路径、字段名、代码标识符外，不要夹带英文说明词。
- 向用户转述 guard / review 输出时，不要直接贴英文 `message`、`next_allowed_actions` 或英文模板标题；应改写为中文，并仅在需要定位内部协议时保留英文 code/command 于反引号中。

在 propose package 完成后使用本 skill 执行实现任务。**Task context、ordering 和 progress 来自 OpenSpec native apply instructions**（`openspec instructions apply`）；SuperSpec 为每个 task 包上一层 RED/GREEN guard checks。

## 边界 / Boundaries

- 先桥接 repo-local OpenSpec apply skill：读取 `.codex/skills/openspec-apply-change/SKILL.md`，并复用其中的 change status、`contextFiles`、task list、progress 和 dynamic instruction 协议。
- SuperSpec 覆盖 OpenSpec apply skill 的直接实现循环：对应 SuperSpec RED/GREEN guard 允许之前，不要编辑实现，也不要勾选 task。
- Apply 只能在 propose package 完成后开始。
- Task list、`contextFiles` 和 dynamic instruction **必须**来自 `openspec instructions apply --json`。不要自行发明 task list，也不要跳过 native context files。
- 主线程负责编排和编辑；role review evidence 仍必须来自 native subagents。
- `check-task-edit` 允许之前，不得进行 task 的实现编辑。`check-task-complete` 允许之前，不得勾选 task checkbox。
- `openspec instructions apply --json` 返回 `state:"all_done"` 只表示 `tasks.md` 当前全部勾选；它不等于 workflow 已经通过 review。若存在 live/pass 的 `kind:"main_adjudication"` 且 `review_decision:"request_changes"`，必须先按其路由决定是 reopen 既有 task，还是停止并回 propose / change update。
- 若存在 live/pass 的 `main_adjudication(review_decision:"request_changes")` 或 unresolved `task_reopen`，apply 必须把 reopen 分支视为高优先级状态；此时忽略 OpenSpec `state:"all_done"` 的归档建议，不得结束 apply。
- 对已完成 task 的合法回退路径固定为：补齐 reopen package（`task_reopen` + 配套 `status:"superseded"` evidence）-> `check-task-reopen` -> 仅把目标 task 的 checkbox 从 `[x]` 改回 `[ ]` -> 重新 RED/GREEN -> `check-task-complete` -> 勾回 `[x]` -> `task_reopen_resolved`。这些 reopen lifecycle evidence 一律由 `superspec-apply` 主线程创建。不要把 reopen 当普通 pending task，也不要绕过 guard 直接手工回退。
- 若当前仓库尚未暴露 `check-task-reopen` 或等效 reopen-aware apply surface，本 skill 必须 fail-closed：报告协议未启用，不得建议 archive，也不得手工回退 checkbox。
- v1 evidence 是 audit-only/self-reported；实际命令输出应尽量记录到 `.superspec/raw/`。

## 步骤 / Steps

1. 对 apply isolation 和 execution mode 使用 AskUserQuestion，并等待明确选择。
2. 当 dirty worktree、untracked files 或 branch state 需要决策时，使用 AskUserQuestion 处理 branch handling。
3. 验证 apply readiness：
   ```text
   superspec guard check-apply-ready --change "<change>"
   ```
4. 获取 native apply context 和 task list：
   ```text
   openspec instructions apply --change "<change>" --json
   ```
   读取 `contextFiles` 下的每个路径，遵守 `openspec-apply-change` 的要求。把返回的 task list、progress 和 dynamic instruction 作为实现 source of truth，并按 `tasks.md` 的结构化字段（`dependencies`、`parallel_group`、`read_scope`、`write_scope`、`test_refs`、`invariant_refs`）判断串行/并行顺序。
5. 先判断是否进入 review 驱动的 reopen 分支：
   - 如果 native apply 返回 `state:"all_done"`，但当前 change 仍有 live/pass 的 `kind:"main_adjudication"` 且 `review_decision:"request_changes"`，或已经存在 unresolved `task_reopen`，不要把它当成“可归档”。
   - 若 `request_changes_route:"reopen_tasks"`，读取 `reopen_task_ids`，逐个判断当前 task 所处阶段：
     - 如果该 task 仍是 `[x]`，说明还处于首次回退前；先由主线程基于本轮 review 的结构化 output 写出该 task 的 `task_reopen` evidence 与配套 `status:"superseded"` evidence，形成完整 reopen package，再执行：
     ```text
     superspec guard check-task-reopen --change "<change>" --task-id "<task-id>"
     ```
       只有该 guard `allow` 后，才允许把对应 task 从 `- [x]` 改为 `- [ ]`，并把它重新纳入本轮 apply。
     - 如果该 task 已经是 `[ ]`，且当前 `tasks.md` 已匹配授权后的 `after_tasks_sha256`，说明它已经处于合法 reopened apply；此时直接续跑 `check-task-edit -> RED/GREEN -> check-task-complete`，不要重复创建 `task_reopen`，也不要再次执行 pre-revert `check-task-reopen`。
   - 若 `request_changes_route:"change_update"`，停止 apply，回 propose / change update；不要试图通过 reopen 继续实现。
6. 对每个 pending task（包括刚刚合法 reopen 的 task），在任何实现编辑前执行任务编辑前检查（`check-task-edit`）：
   ```text
   superspec guard check-task-edit --change "<change>" --task-id "<task-id>"
   ```
7. 在 runtime/business implementation edits 前产出 RED evidence，除非有允许的 `no_tdd_reason` 或处于现状锁定测试模式（`characterization mode`）。这里的 `characterization` 指“先把当前真实行为测出来并锁住，重构后保持一致”。RED/GREEN evidence 必须引用 task 的 `test_refs`，并在 task 声明 `invariant_refs` 时同步记录 `invariant_refs`。若 task 来自 reopen，本轮 successor GREEN / alternative verification / manual verification 必须携带同一 `reopen_id`。
8. 按 native dynamic instruction 和 `contextFiles` 指引，实现最小 task scope。
9. 产出 GREEN evidence，保留 `test_id`、`invariant_refs`、命令、输出摘要和 raw log ref。
10. 勾选 task 前执行任务完成检查（`check-task-complete`）：
   ```text
   superspec guard check-task-complete --change "<change>" --task-id "<task-id>"
   ```
   然后按 native apply semantics 将 task 从 `- [ ]` 改为 `- [x]`。
11. 如果该 task 来自 reopen，在重新勾回 `[x]` 后写入 `kind:"task_reopen_resolved"` evidence，关闭本轮 reopen 授权；不要复用旧 reopen 生命周期。reopen 只授权：
    - 写该 task 的 reopen / supersede / resolved evidence
    - 回退并恢复该 task 的 checkbox
    - 在该 task 既有 `write_scope` 内返工
    若需要修改 sibling task 的 `write_scope`，停止并对 sibling 单独 reopen，或回 propose / 新开 change。
12. 如果 scope expands，停止并通过 AskUserQuestion 重新设计或拆分新 change。

遇到任何 guard `block` 就停止。
