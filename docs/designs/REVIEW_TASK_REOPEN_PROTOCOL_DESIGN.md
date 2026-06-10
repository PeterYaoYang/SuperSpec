# superspec review-driven task reopen 协议设计

> 状态：Draft
> 目标：为当前仓库中的 superspec guard 实现一套 review-driven task reopen 协议。本文统一使用仓库当前实现名 `superspec-*`；若讨论中仍出现 `irsflow-*`，视为同一 workflow 的历史口径。实现面、CLI 包装和测试位于 `scripts/superspec/*`。

## 1. 问题定义

当前 irsflow / superspec 的 apply / review 协议有一个缺口：

- `check-task-edit` 对已勾选 task 直接返回 `task_already_done`，不允许继续编辑。
- review 通过 `main_adjudication` 明确认定“需要返工 / request_changes”后，当前 workflow 仍没有合法路径把原 task 重新打开。
- 如果 review 发现的问题不是“新需求”或“scope expansion”，而是“原 task 的验收条件并未真正满足”，当前 workflow 没有合法路径把 task 重新打开。
- 用户可见层面的直接症状是：review 可以提出 `request_changes`，但 apply 仍然只看到 `all_done` / 已勾选 tasks，于是既退不到 apply，也不能合法继续 review。

本缺口会导致两类不良行为：

1. agent 手工把 `tasks.md` 的 `[x]` 改回 `[ ]`，但 guard 无法区分这是合法返工还是越权操作。
2. 即使返工成功，旧 GREEN、旧 final verification、旧 `review_decision:"request_changes"` review evidence 仍可能继续处于 live/pass 集合中，污染后续 gate 计算。

本协议解决的不是 OpenSpec schema 问题，而是 superspec overlay 的：

- evidence schema
- gate contract
- checkbox 生命周期
- review 返工状态机

## 2. 目标与非目标

### 2.1 目标

- 在 review 阶段发现“原 task 完成证明无效”时，允许有条件地重新打开原 task。
- 返工必须以结构化 review evidence 为依据，不能只靠自由文本解释。
- 旧 evidence 必须显式失效，不能继续为已完成 task 或 review gate 背书。
- reopen 授权必须一次性消费，不能永久允许已完成 task 再次编辑。
- 协议必须兼容当前 `live_pass`、`superseded`、`task_already_done`、`review_ready` 的 guard 架构。

### 2.2 非目标

- 不修改 OpenSpec 的 `spec-driven` schema。
- 不修改 `openspec instructions apply --json` 的返回协议。
- 不把“新增需求”或“scope expansion”伪装成 reopen。
- 不在 v1 追求机械上完全禁止手工修改文件；v1 只要求能够在后续 gate fail-closed 检出未授权修改。

### 2.3 适用范围与规范性边界

- 除非显式标注为“当前 change 迁移示例（非规范性）”，本文的 reopen 规则都面向任意 superspec change。
- `.irsflow -> .superspec` materialize、review-only backfill、以及具体 task/test 映射，只属于 legacy change 迁移方案，不是通用前置条件。

## 3. 术语

### 3.1 review-driven reopen

指 review 证据明确证明某个已完成 task 的验收条件未满足，因此允许该 task 重新进入 apply 修复。

### 3.2 invalid completion

指 task 虽已被勾选完成，但支撑其完成状态的测试、验证或证据不足以满足 task 自己声明的 `test_refs` / `requirement_refs` / workflow 契约。

### 3.3 unresolved reopen

指已经创建了合法 `task_reopen` evidence，但尚未被 `task_reopen_resolved` 消耗关闭的 reopen 授权。

### 3.4 successor evidence

指带有同一 `reopen_id` 的 post-reopen GREEN / final_test / verification evidence，用来替代 pre-reopen 的完成证明。reopened task 的再次完成，不能继续依赖 pre-reopen 的 GREEN evidence，必须依赖同一 `reopen_id` 下的 successor evidence 集合。

### 3.5 单 task reopen 生命周期

v1 约束：

- 一个 `task_reopen` evidence 只能对应一个 task。
- 同一 task 在任一时刻最多只能存在一个 unresolved reopen。
- v1 同一 task 在同一个 change 内只允许创建一次 `task_reopen`。`task_reopen_resolved` 只负责关闭本轮授权，不恢复该 task 的 reopen 配额。
- 若同一 task 在本 change 内已经出现过任何 `status:"pass"` 的 `task_reopen`，后续再次 reopen 一律按 `reopen_lifecycle_exhausted` 阻断；v1 不定义“第二轮 reopen”语义，也不通过 supersede 旧 lifecycle 来换取再次 reopen。

## 4. 设计原则

1. **Review 不是直接修改 task 状态的权力来源。**
   Review 只提供结构化证据，不能直接等价于 checkbox 回退。

2. **Task reopen 必须是独立 gate。**
   不能复用 `task_edit` 语义，否则授权和普通编辑混在一起。

3. **旧 evidence 失效必须使用现有 supersede 语义。**
   当前 `live_pass` 只认 `status:"superseded"` + `supersedes` 的失效链；协议必须沿用，而不是发明只写不算的声明字段。

4. **Checkbox 变更必须可追踪。**
   合法 reopen 只能修改 `checked` 状态，不能顺手改 task 语义字段。

5. **当前 change 的 reopen 范围必须按“共享失效测试资产”外扩。**
   如果 task A 的完成证据复用了 task B 中被判无效的测试资产，则 task A 的相关 evidence 也必须退出 live 集合。

6. **v1 只能 fail-closed 检出未授权返工，不能证明时序真伪。**
   当前 evidence 体系是 audit-only / self-reported。协议必须诚实表达这一点：它能要求“没有合法 reopen 授权就不能继续 apply/review”，但不能仅凭 sha256 证明“谁先改了文件”。

## 5. 状态流

```text
tasks_complete
  -> review
    -> allow
    -> request_changes(change_update)
    -> request_changes(reopen_tasks)
         -> task_reopen
         -> apply_fix
         -> task_reopen_resolved
         -> tasks_complete
         -> review
```

状态解释：

- `request_changes(change_update)`：review 发现的是需求/范围/设计问题，应回 propose / change update，而不是 reopen 既有 task。
- `request_changes(reopen_tasks)`：review 发现的是既有 task 的完成证明失效，应回 apply 修复。
- `task_reopen`：存在合法 reopen evidence，且相关 task 的 checkbox 已按授权回退。
- `apply_fix`：reopened task 重新进入 RED/GREEN / task_complete 流程。
- `task_reopen_resolved`：返工完成，reopen 授权被消耗关闭。

## 6. 当前实现约束

### 6.1 现有 guard 现状

- `check_task_edit`：见 `scripts/superspec/src/gates.ts`，当前对 `task.checked` 直接报 `task_already_done`。
- `check_review_complete`：当前只校验 `source_guidance` / `main_adjudication` / `verification_review` / `final_test` 证据齐备，但还没有 reopen 生命周期语义。
- `live_pass`：见 `scripts/superspec/src/evidence.ts`，当前只认由 `status:"superseded"` evidence 逐条杀死旧 evidence。

### 6.2 现有 review evidence 现状

当前 reviewer evidence 仍以自由文本 findings 为主，缺少可供 gate 机器读取的：

- `affected_task_ids`
- `violated_test_ids`
- `why_completion_invalid`
- `required_fix`
- `reopen_recommendation`

因此，在 protocol 落地前，review 只能被人读懂，不能被 reopen gate 直接消费。

### 6.3 sidecar 根目录策略

v1 明确采用单根策略：

- guard、skill 和脚本只读写 `.superspec/*`
- 不在 guard 中引入 `.irsflow` / `.superspec` 双读逻辑
- 现有 `.irsflow/*` 只作为一次性迁移输入或人工溯源材料，不进入 live evidence 集合

这意味着：

- 协议实现代码只需要落在 `scripts/superspec/*`
- 当前仍使用 `.irsflow/*` 的 change，必须先完成一次性 sidecar materialize，再进入 reopen protocol

## 7. 协议设计

### 7.1 新增 evidence：`task_reopen`

文件类型：

- `gate: "task_reopen"`
- `kind: "task_reopen"`
- `status: "pass"`

建议字段：

```json
{
  "schema_version": 1,
  "evidence_id": "EV-task-reopen-20260608-001",
  "change_id": "<change>",
  "gate": "task_reopen",
  "kind": "task_reopen",
  "created_at": "<ts>",
  "created_by": "<workflow-or-agent>",
  "status": "pass",
  "reopen_id": "reopen-20260608-001",
  "source_adjudication_evidence_id": "EV-review-main-adjudication-...",
  "source_guidance_evidence_id": "EV-review-code-reviewer-guidance-...",
  "task_id": "1.1",
  "violated_test_ids": ["TEST-001", "TEST-018"],
  "violated_requirement_refs": ["REQ-request-contract"],
  "invalidated_completion_evidence_ids": [
    "EV-green-TASK-1.1-TEST-001-20260608",
    "EV-green-TASK-1.1-TEST-018-20260608"
  ],
  "required_supersede_evidence_ids": [
    "EV-green-TASK-1.1-TEST-001-20260608",
    "EV-green-TASK-1.1-TEST-018-20260608",
    "EV-final-test-20260608",
    "EV-verification-review-20260608"
  ],
  "completion_invalidity_class": "insufficient_completion_evidence",
  "scope_expansion": false,
  "why_completion_invalid": "review 证明原 task 的测试完成证据不满足 test-contract",
  "required_fix": "补强行为级测试并重跑验证",
  "before_tasks_sha256": "<sha256>",
  "after_tasks_sha256": "<sha256>"
}
```

约束：

- 必须有唯一 `reopen_id`。
- 一个 `task_reopen` evidence 只允许对应一个 task。不要一条 evidence 覆盖多个 task。
- 不允许包含 `agent_role`，避免被误识别成 subagent role evidence。
- 不作为旧 evidence 失效声明的唯一来源；旧 evidence 失效必须通过独立 superseded evidence 文件实现。
- `source_guidance_evidence_id` 必须指向同一轮 review 中的 `kind:"source_guidance"` 且 `agent_role:"code-reviewer"` evidence。
- `source_adjudication_evidence_id` 必须指向 `kind:"main_adjudication"` evidence，且其 `source_evidence_refs` 必须包含 `source_guidance_evidence_id`；不允许跨 review round 混搭 source ids。
- `source_adjudication_evidence_id` 必须带 `review_decision:"request_changes"`，并显式列出 `reopen_task_ids`；其中必须包含当前 `task_id`。
- `source_adjudication_evidence_id` 与 `source_guidance_evidence_id` 是 reopen 授权锚点；在 `check-task-reopen` 执行时它们必须仍然是 live/pass，因此二者不得出现在 `required_supersede_evidence_ids` 中。
- `violated_requirement_refs` 必须是原 task `requirement_refs` 的子集。
- `invalidated_completion_evidence_ids` 必须列出该 task 旧完成证明里不再允许继续 live 的实际 evidence id。
- `required_supersede_evidence_ids` 必须是一个显式闭包集合；gate 不推导“还应该 supersede 哪些 evidence”，只校验这个集合中的每一项都已退出 live。
- `required_supersede_evidence_ids` 必须包含 `invalidated_completion_evidence_ids` 的全集。
- `completion_invalidity_class` 只能是允许的 reopen 类别。
- `scope_expansion` 必须显式为 `false`；若为 `true`，不得走 reopen，必须回 propose / change update。

`before_tasks_sha256` / `after_tasks_sha256` 的计算规则在 v1 固定为：

- 使用 `sha256_text(readFileSync(tasks.md, "utf8"))`
- 不做空白、换行或 markdown 规范化；直接按当前 UTF-8 文本内容计算
- `before_tasks_sha256` 对应“执行 `check-task-reopen` 时的当前 tasks.md 文本”
- `after_tasks_sha256` 对应“仅把目标 task 那一行的 checkbox 从 `[x]` 改成 `[ ]` 后，其余字节完全不变”的结果文本

因此，`check-task-reopen` 是 **revert 前授权 gate**，不是 revert 后审计 gate。

### 7.2 新增 evidence：`task_reopen_resolved`

文件类型：

- `gate: "task_reopen"`
- `kind: "task_reopen_resolved"`
- `status: "pass"`

建议字段：

```json
{
  "schema_version": 1,
  "evidence_id": "EV-task-reopen-resolved-20260608-001",
  "change_id": "<change>",
  "gate": "task_reopen",
  "kind": "task_reopen_resolved",
  "created_at": "<ts>",
  "created_by": "<workflow-or-agent>",
  "status": "pass",
  "reopen_evidence_id": "EV-task-reopen-20260608-001",
  "reopen_id": "reopen-20260608-001",
  "task_id": "1.1",
  "successor_completion_evidence_ids": [
    "EV-green-TASK-1.1-TEST-001-r2-20260609",
    "EV-green-TASK-1.1-TEST-018-r2-20260609"
  ],
  "after_tasks_sha256": "<sha256>"
}
```

约束：

- 必须消费一个且仅一个 `reopen_evidence_id`。
- `reopen_id` 必须与被关闭的 `task_reopen.reopen_id` 完全一致。
- 一个 `task_reopen_resolved` 只允许关闭一个 reopen。
- `successor_completion_evidence_ids` 必须列出本轮真正用于替代旧完成证明的 evidence id；对于 `tdd_required:true` task，这些 id 指向 successor GREEN `test_run` evidence；对于 `tdd_required:false` task，这些 id 指向 successor `alternative_verification` / `manual_verification` evidence。
- 没有 resolved evidence 的 reopen，视为 unresolved reopen。

### 7.3 reopened task 的再次完成规则

对于 reopened task，`check-task-complete` 必须按纯集合/引用规则计算，不得比较 `created_at`，也不得猜测“哪条 evidence 更新”。同时，凡是被视为 post-reopen successor 的完成证明 evidence，都必须携带 `reopen_id`。v1 具体规则如下：

1. 在该 task 上收集 live/pass 的 `task_reopen` evidence，结果必须恰好为 1 条，记为 `R`。
2. 若 task 的 `tdd_required:true`：
   - 取 `required_successor_test_ids = set(R.violated_test_ids)`。
   - 在该 task 上收集 live/pass 的 `kind:"test_run"` 且 `semantic_status:"expected_success"` evidence，筛出 `reopen_id == R.reopen_id` 的子集，记为 `successor_green_set`。
   - 对 `required_successor_test_ids` 中每个 test id，`successor_green_set` 中都必须至少存在一条匹配该 test id 的 GREEN evidence。
   - 所有 pre-reopen 且命中 `required_successor_test_ids` 的 GREEN evidence 必须已经被 supersede；对于这些 test id，未带 `reopen_id` 或 `reopen_id != R.reopen_id` 的 GREEN evidence 一律不计入完成证明。
   - 对 `task.test_refs - required_successor_test_ids` 的其余 test id，继续沿用现有 `check-task-complete` 规则；只要相关 GREEN evidence 仍然 live/pass，就可以继续作为完成证明。
3. 若 task 的 `tdd_required:false`：
   - 在该 task 上收集 live/pass 的 `kind:"alternative_verification"` 与 `kind:"manual_verification"` evidence，筛出 `reopen_id == R.reopen_id` 的子集，记为 `successor_alt_verify_set`。
   - `successor_alt_verify_set` 必须至少存在 1 条 evidence。
   - `R.invalidated_completion_evidence_ids` 中列出的旧 `alternative_verification` / `manual_verification` evidence 必须全部已被 supersede。
   - 未带 `reopen_id` 或 `reopen_id != R.reopen_id` 的 alternative/manual verification evidence，不得再作为本 task 的完成证明。

换句话说，reopen 只重写被判无效的那一部分完成证明；`tdd_required:true` 重写的是命中 `violated_test_ids` 的 GREEN 子集，`tdd_required:false` 重写的是旧 alternative/manual verification 证明集合。

为避免与 `task_reopen_resolved` 产生时序矛盾，v1 定义：

- `task_reopen_resolved` 不是 `check-task-complete` 的前置输入
- `task_reopen_resolved` 是在 `check-task-complete` 通过、task 勾回 `[x]` 之后写入的生命周期关闭记录

历史实现策略曾采用以下更窄方案：

- 仅对 reopened task 增加 reopen-aware 完成规则，强制 `violated_test_ids` 的 successor 覆盖。
- 未对非 reopen task 的 declared test coverage 做全局逐项要求，以避免扩大当时实现的行为改变范围。

当前状态：上述第二条已被 `docs/audits/GUARD_PROOF_GAPS_AUDIT.md` / `SPEC.md` supersede。当前 guard 要求 task 声明的每个 `test_refs` 在对应 apply gate 中逐项兑现：`task_edit` 的 RED/characterization 必须来自 `gate:"task_edit"`，`task_complete` 的 GREEN 必须来自 `gate:"task_complete"`。reopen successor 仍额外要求匹配 `reopen_id`。

### 7.4 review evidence 结构化扩展

当前 v1 guard / apply 真正消费的 reopen 映射只要求 `code-reviewer source_guidance.blocking_findings[*].affected_task_ids` 能把被阻断的 finding 追到具体 task。最小结构可以是：

```json
{
  "severity": "HIGH",
  "file": "...",
  "line": 57,
  "issue": "...",
  "recommendation": "...",
  "affected_task_ids": ["1.1"]
}
```

没有 `affected_task_ids`，`task_reopen` 就无法把 reopen 授权绑定到具体 task。

`violated_test_ids` / `violated_requirement_refs` / `why_completion_invalid` / `required_fix` / `completion_invalidity_class` / `scope_expansion` / `reopen_recommendation` 可以保留在详细 lifecycle overlay 中，但它们不是本轮 canonical repair 的必填面，也不是当前 guard 放行 reopen 的最小前提。

同时，当前仓库真实生效的 review 协议要求主线程 `kind:"main_adjudication"` 也补充 reopen 可机判字段，至少包含：

```json
{
  "kind": "main_adjudication",
  "review_decision": "request_changes",
  "request_changes_route": "reopen_tasks",
  "source_evidence_refs": [
    "EV-review-code-reviewer-guidance-...",
    "EV-review-architect-guidance-...",
    "EV-review-critic-guidance-..."
  ],
  "blocking_source_evidence_refs": [
    "EV-review-code-reviewer-guidance-..."
  ],
  "reopen_task_ids": ["1.1", "1.2"]
}
```

约束：

- `review_decision` 取值固定为 `allow | request_changes`
- 当 `review_decision:"request_changes"` 时，必须显式声明 `request_changes_route`，v1 只允许 `reopen_tasks | change_update`
- `review_decision:"request_changes"` 时，`verification_evidence_refs` 必须保持为空；它不能伪装成 allow-path final verification
- 只有 `review_decision:"request_changes"` 才允许生成 `task_reopen`
- 只有 `request_changes_route:"reopen_tasks"` 才允许生成 `task_reopen`
- `blocking_source_evidence_refs` 必须是 `source_evidence_refs` 的子集
- 当某条 `task_reopen` 引用 `source_guidance_evidence_id` 时，`blocking_source_evidence_refs` 也必须包含该 `source_guidance_evidence_id`
- `request_changes_route:"reopen_tasks"` 时，`reopen_task_ids` 必须显式列出本轮 adjudication 认定需要 reopen 的 task；gate 不从自由文本推断
- `request_changes_route:"change_update"` 时，`reopen_task_ids` 必须为空，且不得通过 reopen 协议伪装 scope / proposal 问题
- 若同一轮 review 同时存在 reopen-compatible blocker 与必须回 propose / change update 的 blocker，则 `request_changes_route` 必须取 `change_update`；只有当所有未解决 blocker 都可由既有 task 返工闭环时，才允许取 `reopen_tasks`

### 7.5 reopen lifecycle evidence 责任归属

- `task_reopen`、其配套的 `status:"superseded"` evidence、以及 `task_reopen_resolved` 一律由 `superspec-apply` 主线程创建。
- `superspec-review` 只负责产出可机判的 `source_guidance` 与 `main_adjudication`，不直接写 reopen lifecycle evidence，也不直接修改 `tasks.md`。
- apply 在进入 reopen 分支时，必须先基于本轮 review 的结构化输出补齐 reopen package，再执行 `check-task-reopen`。

## 8. Gate 设计

### 8.1 新增 `check-task-reopen`

CLI：

```bash
superspec_guard check-task-reopen --change <change> --task-id <task-id>
```

通过条件：

1. `propose_complete` pass。
2. 目标 task 存在，且当前为 checked。
3. 恰好存在一条 live/pass `task_reopen` evidence 覆盖该 task。
4. `source_adjudication_evidence_id` 指向 live/pass 的 `kind:"main_adjudication"` evidence，且 `review_decision:"request_changes"`、`request_changes_route:"reopen_tasks"`。
5. `source_guidance_evidence_id` 指向 live/pass 的 `kind:"source_guidance"` evidence，且 `agent_role:"code-reviewer"`。
6. `source_adjudication_evidence_id.source_evidence_refs` 必须包含 `source_guidance_evidence_id`，且 `source_adjudication_evidence_id.reopen_task_ids` 必须包含当前 task。
7. `violated_test_ids` 是该 task 原 `test_refs` 的子集。
8. `violated_requirement_refs` 是该 task 原 `requirement_refs` 的子集。
9. `completion_invalidity_class` 必须属于允许的 reopen 类别。
10. `scope_expansion` 必须为 `false`。
11. 不允许新增 test id、修改 requirement、扩 write_scope。
12. 当前 `tasks.md` 的原始 UTF-8 文本 hash，必须等于 `before_tasks_sha256`。
13. 仅把目标 task 那一行的 checkbox 从 `[x]` 改为 `[ ]`、其余字节完全不变后得到的结果文本 hash，必须等于 `after_tasks_sha256`。
14. 第 12 条和第 13 条之间允许的唯一文本差异，只能是目标 task 的 `checked:true -> false`。
15. `required_supersede_evidence_ids` 中的每个 evidence id，都已经被对应的 `status:"superseded"` evidence 逐条杀出 live 集合。

阻断条件：

- source adjudication 不是 live/pass 的 `main_adjudication(request_changes)`
- source guidance 不是 live/pass 的 `code-reviewer source_guidance`
- 当前 task 不是 checked，因此不满足 revert 前授权语义
- violated test id 不属于该 task 的 `test_refs`
- 试图把新需求或 scope expansion 当 reopen
- `tasks.md` 无法由“仅切换目标 task checkbox”从 `before_tasks_sha256` 机械得到 `after_tasks_sha256`

### 8.2 修改 `check_task_edit`

现状：

- `task.checked` -> `task_already_done`

目标：

- checked 且无 unresolved reopen -> block
- checked 且存在 live/pass unresolved reopen -> 仍 block，并提示先执行授权后的 `[x] -> [ ]` revert
- unchecked 且无合法 unresolved reopen -> block
- unchecked 且当前 `tasks.md` 不匹配授权后的 `after_tasks_sha256` -> block
- unchecked 且存在合法 unresolved reopen -> 继续现有 RED / characterization 校验

执行含义：

- `check-task-reopen` 只用于 **首次** 授权 `[x] -> [ ]` revert 的 pre-revert 时刻。
- 一旦目标 task 已经处于 unchecked 且 `tasks.md` 命中 `after_tasks_sha256`，后续继续 apply 时必须直接走 reopen-aware `check_task_edit` / `check_task_complete` 续跑路径，不得重复创建 `task_reopen`，也不得再次执行 pre-revert `check-task-reopen`。

补充：

- 若同一 task 存在多条 live/pass unresolved reopen -> block
- 若同一 task 在本 change 内已经存在任何 `status:"pass"` 的 `task_reopen`，新的 reopen 直接以 `reopen_lifecycle_exhausted` 阻断；这里按全量 pass 证据集判定，不按 `live_pass` 放宽

### 8.3 修改 `check_review_ready`

新增阻断规则：

- 如果存在 unresolved reopen，则 `review_ready` block

原因：

- 返工过程未完成，不应进入 review

### 8.4 修改 `check_review_complete`

新增/强化规则：

- 旧 `review_decision:"request_changes"` 的 `main_adjudication` 只有在被 superseded 后才退出 live 集合
- 不接受“新 review 覆盖旧 review”的口头语义

### 8.5 v1 时序声明

本协议在 v1 中不宣称能够证明“先写了 reopen evidence，再改了 checkbox”。

它只保证：

- 如果没有合法 reopen 证据和授权后的 `tasks.md` 形态，则后续 gate fail-closed
- 如果旧 evidence 没有 supersede，则 review / archive 继续 block

任何“时序真伪”仍然是 audit-only / self-reported。文档和实现都不得再以 `created_at` 先后作为 reopen 合法性的机械判据。

### 8.6 当前可执行性声明

若当前仓库的 guard / skill surface 尚未同时暴露：

- `check-task-reopen`
- reopen-aware `superspec-apply` 分支

则 reopen protocol 视为**未启用**。此时 skill 必须 fail-closed，报告缺失表面；不得建议 archive，也不得手工回退 checkbox 冒充协议已生效。

## 9. Checkbox 生命周期

### 9.1 合法回退顺序

正确顺序必须是：

1. 生成 `task_reopen`
2. 生成旧 evidence 的 superseded evidence
3. 在 task 仍为 `[x]` 时执行 `check-task-reopen`
4. 把目标 task `[x] -> [ ]`
5. 当前 `tasks.md` 满足 `after_tasks_sha256`

### 9.2 非法回退处理

v1 不能机械阻止手工改文件，但必须在后续 gate fail-closed：

- 如果 `tasks.md` 已被手工改为 `[ ]`，但没有合法 `task_reopen` 和授权后的 hash，对应 `check-task-edit` / `check-review-ready` 必须 block

### 9.3 允许修改的范围

只允许修改：

- 目标 task 的 reopen / supersede / resolved evidence
- 目标 task 的 `checked` 状态
- 目标 task 既有 `write_scope` 内为完成返工所需的实现与测试

禁止修改：

- description
- requirement_refs
- test_refs
- read_scope
- write_scope
- dependencies
- 任何 attrs 值
- sibling task 的 `write_scope`

若需要编辑 sibling task 的 `write_scope`，必须对该 sibling task 单独 reopen，或回 propose / 新开 change。仅因为 sibling evidence 被判需要退出 live，并不自动授权修改 sibling 代码。

## 10. 旧 evidence 失效规则

### 10.1 失效机制

沿用当前 guard 语义：

- 通过独立 evidence 文件写入 `status:"superseded"`
- 使用单个 `supersedes` 字段逐条失效旧 evidence
- 不接受只在 `task_reopen` 中列一个声明式列表就算失效

### 10.2 必须退出 live 的 evidence

最小集合：

- 原被判无效的 GREEN evidence
- 原被判无效的 alternative/manual verification evidence
- 依赖同一批失效测试资产、因此必须退出 live 的其它 GREEN / final_test / verification evidence
- 旧 final verification evidence
- 旧 final_test evidence

v1 不要求 guard 推导这组集合。执行面必须在 `task_reopen.required_supersede_evidence_ids` 中把它显式列全，guard 只校验这些 id 是否都已经离开 live 集合。

补充时序规则：

- `source_adjudication_evidence_id` 与 `source_guidance_evidence_id` 在 reopen 授权前必须保持 live/pass，不能提前 supersede
- 这两条 source evidence 的退场时机，是返工完成后的下一轮 `superspec-review`
- 新一轮 review evidence 成功产出后，旧的 `review_decision:"request_changes"` `main_adjudication` 与其对应的 source `code-reviewer` guidance evidence 才允许被 supersede
- 使 sibling evidence 退出 live，只授权“证据退场”和后续必要的验证重建；它本身不授权 sibling `write_scope` 变更

### 10.3 successor evidence 的最低要求

对于 reopened task，必须至少重建：

- `tdd_required:true` task 的所有 `violated_test_ids` 对应 successor GREEN evidence
- `tdd_required:false` task 的 successor `alternative_verification` / `manual_verification` evidence
- 任何直接消费这些失效完成资产的 `final_test` / `verification_review` evidence

若这些失效测试还被其它任务或 final verification 复用，则相关 evidence 也必须重建或 supersede。

### 10.4 当前 change 的特别要求

critic 指出：不能只 reopen `1.1/1.2/1.3` 而不处理 `2.1/3.1` 的相关 live evidence。

原因：

- `2.1` 的行为保持证明依赖 `TEST-001..018`
- `3.1` 的 final verification 依赖同一批测试日志

因此本协议要求：

- 不一定 reopen `2.1` write_scope
- 但必须让依赖弱测试资产的 `2.1` / `3.1` 相关 evidence 退出 live 集合，并在返工后重跑/重建
- 对当前 change，不靠 guard 自动推导这批 evidence；对应 `task_reopen.required_supersede_evidence_ids` 必须显式枚举这些 `2.1` / `3.1` 相关 evidence id

## 11. Skill 协议变更

### 11.1 `superspec-review`

新增要求：

- blocking finding 必须结构化
- 命中“原 task 验收失败”时：
  - 记录 reopen recommendation
  - 由主线程 `main_adjudication` 记录 `review_decision:"request_changes"`
  - 由主线程 `main_adjudication` 显式记录 `request_changes_route:"reopen_tasks"` 与 `reopen_task_ids`
  - review 不得直接回改 `tasks.md`；只能输出结构化 reopen 授权，再交回 apply
- 命中“需求/范围/设计需要回 propose 或 change update”时：
  - 由主线程 `main_adjudication` 记录 `review_decision:"request_changes"`
  - 同时记录 `request_changes_route:"change_update"`
  - 不得伪装成 reopen 既有 task

### 11.2 `superspec-apply`

新增分支：

- 当 `openspec instructions apply` 返回 `all_done`
- 但存在 live 的 `main_adjudication(review_decision:"request_changes", request_changes_route:"reopen_tasks")`

则 apply 不得直接编辑，必须先走：

```text
check-task-reopen -> 合法 revert -> reopened task 重新进入 RED/GREEN/task_complete
```

若存在 live 的 `main_adjudication(review_decision:"request_changes", request_changes_route:"change_update")`，则 apply 不得尝试 reopen，必须停止并回 propose / change update。

若目标 task 已经处于 unchecked 且匹配 `after_tasks_sha256`，说明本轮 reopen 已经完成合法 revert；apply 必须直接按 reopened task 续跑，不得重复写 `task_reopen` 或再次执行 pre-revert `check-task-reopen`。

### 11.3 当前 change 的结构化回填（非规范性迁移示例）

当前 `.irsflow` review evidence 还不是结构化 finding，且不在 `.superspec` live evidence 集合内，因此当前 change 不能直接进入 reopen protocol。

v1 在当前仓库里只允许一种回填方式：

1. 先把当前 change 所需的 `.irsflow/artifacts/*` materialize 到 `.superspec/artifacts/*`
2. 不把旧 `.irsflow/evidence/*` 直接导入 live 集合；它们只作为人工溯源输入
3. 在 `.superspec/evidence/reviews/` 下重跑一轮 **review-only backfill**：
   - 重新运行 `code-reviewer` lane
   - 重新运行 `architect` lane
   - 重新运行 `critic` guidance
   - 重新写出新的 `main_adjudication`
   - 此轮 backfill 不生成新的 final verification evidence

本轮 backfill 产出的新 `.superspec` `source_guidance` / `main_adjudication` evidence，才是 reopen 可以引用的 source ids。旧 `.irsflow` review evidence 不再作为 live/pass source 使用。

这组新的 source ids 在 `check-task-reopen` 前必须保持 live/pass，不得写入任何 `task_reopen.required_supersede_evidence_ids`。

## 12. 测试计划

在 `scripts/superspec/tests/test_superspec_guard.test.ts` 增加：

1. checked task 无 reopen -> `task_already_done`
2. checked task 有合法 unresolved reopen 但尚未 revert -> `check_task_edit` 继续 block，并提示先执行授权后的 `[x] -> [ ]`
3. `task_reopen` source `main_adjudication.review_decision` 不是 `request_changes` -> block
4. `task_reopen` source `main_adjudication.request_changes_route` 不是 `reopen_tasks` -> block
5. `task_reopen` source `main_adjudication.source_evidence_refs` 未引用 source `code-reviewer source_guidance` -> block
6. `check-task-reopen` 只允许从当前 `[x]` 文本机械生成授权后的 `[ ]` 文本 -> 否则 block
7. violated test id 不在 task `test_refs` 中 -> block
8. 没有 superseded evidence 时旧 GREEN 仍 live -> block
9. unresolved reopen 存在时 `review_ready` block
10. 旧 `request_changes` `main_adjudication` 未 supersede 时，返工后的最终 review 不得完成
11. `task_reopen_resolved` 后 reopen 不能复用
12. `tdd_required:false` 的 reopened task 若缺少带同一 `reopen_id` 的 successor `alternative_verification` / `manual_verification` -> `check_task_complete` block
13. 当前 change 的 task/test 映射回归
14. reopened task 若只补齐部分 `violated_test_ids` successor GREEN -> `check_task_complete` 仍 block
15. reopened task 若 successor GREEN 仍引用 pre-reopen live evidence -> block
16. `check-task-reopen` 时 source `main_adjudication` / source `code-reviewer source_guidance` 必须仍为 live/pass；若提前 supersede -> block

在 skill/protocol 层至少补两类回归验证：

1. `superspec-apply` 在 `all_done + live main_adjudication(review_decision:"request_changes")` 时，不得直接进入普通 task_edit，必须先进入 `check-task-reopen -> revert` 分支
2. `superspec-review` 的 review-only backfill 只生成 `code-reviewer` / `architect` / `critic` 的 `source_guidance` 与一条 `main_adjudication`，不生成新的 final verification evidence
3. 返工完成后的新一轮 `superspec-review` 必须负责 supersede 旧的 source `main_adjudication(review_decision:"request_changes")` 与对应 `code-reviewer source_guidance`

## 13. 当前 change 迁移方案（非规范性迁移示例）

协议落地后，用它处理 `refactor-generic-api-vacations-v1-duration`：

### 13.1 sidecar materialize 与 source evidence

先执行一次性 sidecar materialize：

1. 把当前 change 需要的 `.irsflow/artifacts/*` 内容写入 `.superspec/artifacts/*`
2. 不复制旧 `.irsflow/evidence/*` 进入 `.superspec/evidence/*`
3. 保留 `.irsflow/*` 仅作历史输入；guard/skill 从这一刻开始只看 `.superspec/*`

补充约束：

- 当前 `tasks.md` 中遗留的 `.irsflow` 路径只作为历史文字引用，不参与 guard 的 sidecar 路径解析
- v1 不为了改写这些历史路径而重新打开已完成 task；实际运行时一律以 `.superspec/*` materialized 文件为准

然后执行 11.3 定义的 review-only backfill，并生成新的 source ids：

- `source_adjudication_evidence_id`: `EV-review-main-adjudication-structured-<ts>`
- `source_guidance_evidence_id`: `EV-review-code-reviewer-guidance-structured-<ts>`

这里的 `<ts>` 代表本轮 `.superspec` backfill 新生成的 evidence id；reopen 一律引用这组新 id，而不是旧 `.irsflow` id。

### 13.2 reopen 映射

- `1.1` -> `TEST-001`, `TEST-018`
- `1.2` -> `TEST-002..TEST-007`
- `1.3` -> `TEST-008..TEST-014`, `TEST-016`

每个 task 各自生成一条 `task_reopen` evidence，不共享 reopen 生命周期。

### 13.3 相关 evidence 失效

至少包括：

- 旧 `1.1/1.2/1.3` GREEN evidence
- 依赖同一批测试资产的 `2.1` 相关 GREEN evidence
- 旧 `3.1` final verification evidence

其中：

- `1.1` 的 reopen 至少要求重建 `TEST-001`、`TEST-018` 的 successor GREEN
- `2.1` 不一定 reopen write_scope，但其依赖这些测试资产的旧 GREEN evidence 不能继续 live
- 每条 `task_reopen` 都必须把自己负责杀出的具体 evidence id 写进 `required_supersede_evidence_ids`；不要在当前 change 里依赖“按类别推断”
- backfill 产出的 source `main_adjudication` / source `code-reviewer guidance` 不是这一步要杀出的对象；它们要等 13.4 的新 review round 成功后再 supersede

### 13.4 修复后的正常路径

1. 合法 reopen
2. 返工测试
3. 重新 RED/GREEN
4. 重新 `check-task-complete`
5. 勾回 `[x]`
6. 写 `task_reopen_resolved`
7. 重跑 final verification
8. 重跑 `superspec-review`，产出新的 `source_guidance` / `main_adjudication` / `verification_review` / `final_test`
9. 用新 review round 产出的 evidence supersede 旧的 source `main_adjudication(review_decision:"request_changes")` 和对应 `code-reviewer source_guidance`
10. 在旧 source evidence 退场后执行最终 `check-review-complete`

## 14. 分阶段实施计划

### Step 1

先补文档与 schema 契约：

- `superspec-review` 结构化 finding
- `task_reopen` / `task_reopen_resolved` evidence contract
- 明确不修改 `openspec/schemas/*`；本次只扩 superspec overlay，不引入新的 OpenSpec schema
- 明确 `reopen_id`、`required_supersede_evidence_ids`、raw-text hash 计算规则，以及 `tdd_required:false` 的 successor 契约

### Step 2

再补 guard：

- `check-task-reopen`
- `check_task_edit` reopen-aware
- `review_ready` / `review_complete` reopen-aware
- supersede 兼容测试

对应实现文件：

- `scripts/superspec/src/cli_args.ts`：注册 `check-task-reopen` CLI surface
- `scripts/superspec/src/core.ts`：把新 gate 接入命令分发
- `scripts/superspec/src/evidence.ts`：增加 reopen 相关 schema 校验与查询 helper
- `scripts/superspec/src/gates.ts`：实现 reopen-aware gate 逻辑
- `scripts/superspec/tests/test_superspec_guard.test.ts`：补协议回归测试
- `.codex/skills/superspec-review/SKILL.md`：增加 review-only backfill 协议
- `.codex/skills/superspec-apply/SKILL.md`：增加 `all_done + main_adjudication(request_changes)` 下的 reopen 分支

### Step 3

最后用 protocol 处理当前 change。

## 15. 决策

本设计建议：

- **先实现 protocol，再处理当前 change**

原因：

- 当前 review evidence 还不够结构化，无法直接做机器 reopen
- 旧 evidence 的 live 退场机制必须先实现，否则返工后 review/archive 语义仍然会乱
- 用户当前正在验证的是 irsflow workflow 本身，而仓库实际实现面是 superspec；这个协议缺口应优先作为 workflow 问题解决
