# SuperSpec Guard 证明力缺口审计

> 历史快照提示：本文记录的是 2026-06-09 早期审计过程中的问题清单，部分结论已被后续实现和测试修正。当前权威源是 `docs/SPEC.md`、`scripts/superspec/src/*` 和 `scripts/superspec/tests/*`。不要把本文后续章节中的旧“未解决/当前行为”表述当作当前待办；涉及 GPG-001 / 002 / 003 / 008 / 009 / 010 时，以当前测试输出为准。

> 审计日期：2026-06-09
>
> 审计对象：`scripts/superspec/src/*` 中与 apply/review guard、test evidence、invariant evidence 相关的实现。
>
> 历史结论摘要：早期快照曾认为 guard 只能证明“存在一些 RED/GREEN 和 INV 引用”。当前实现已补齐多项关键 proof gap，包括 RED/GREEN gate 绑定、declared test_refs 逐项兑现、hard invariant final matrix 覆盖，以及 task_reopen lifecycle 相关负例。仍需以后续测试和 `SPEC.md` 为准。

## 1. 审计结论总览

| 编号 | 优先级 | 结论 | 主要位置 | 是否需要修改 |
| --- | --- | --- | --- | --- |
| GPG-001 | 阻断 | 已修复：RED/GREEN evidence 已绑定正确 gate | `tasks.ts` / `gates.ts` / tests | 保留回归测试 |
| GPG-002 | 阻断 | 已修复：declared `test_refs` 已逐项兑现 | `gates.ts` / tests | 保留回归测试 |
| GPG-003 | 阻断 | 已修复：final invariant matrix 已校验 hard INV 覆盖 | `evidence.ts` / `gates.ts` / tests | 保留回归测试 |
| GPG-004 | 中风险 | 真实存在，属于策略过严 | `gates.ts` / `invariants.ts` | 需要 |
| GPG-005 | 中风险 | 基本不成立，当前已覆盖主要场景 | `evidence.ts` | 暂不需要，保留回归测试即可 |
| GPG-006 | 中风险 | 部分成立，属于策略一致性问题 | `invariants.ts` / `gates.ts` | 建议 |
| GPG-007 | 中风险 | 真实存在，文档误导风险 | `docs/history/DUAL_TRACK_REFACTOR_PLAN.md` | 建议 |
| GPG-008 | 阻断 | 已修复：普通 supersede 不再隐藏 task_reopen history | `evidence.ts` / `gates.ts` / tests | 保留回归测试 |
| GPG-009 | 阻断 | 已修复：deleted/replaced task 的 resolved reopen 已全局语义校验 | `evidence.ts` / `gates.ts` / tests | 保留回归测试 |
| GPG-010 | 中风险 | 已修复：v1 单次 reopen history 约束已有负例覆盖 | `gates.ts` / tests | 保留回归测试 |
| GPG-011 | 阻断 | 已修复，`.superspec` traversal alias 可逃逸 change root | `util.ts` / `evidence.ts` / `archive.ts` | 已修复 |
| GPG-012 | 中风险 | 已修复，missing pinned refs 可导致非结构化失败 | `evidence.ts` | 已修复 |
| GPG-013 | 阻断 | 已修复，`request_changes -> task_reopen` 可绕过主线程 adjudication 覆盖 | `gates.ts` | 已修复 |
| GPG-014 | 阻断 | 已修复，archive identity 可被 suffix match 或 manifest mismatch 伪造 | `archive.ts` | 已修复 |
| GPG-015 | 阻断 | 已修复，archive preservation transaction rollback 非 fail-closed | `archive.ts` / `core.ts` | 已修复 |
| GPG-016 | 阻断 | 已修复，archive readback 接受空 manifest / unsafe path / symlink archive dir | `archive.ts` | 已修复 |
| GPG-017 | 中风险 | 已修复，`next_allowed_actions` 与真实 blocker 脱节 | `gates.ts` / `core.ts` | 已修复 |
| GPG-018 | 低风险 | 已修复，hardening 设计文档与当前实现状态不一致 | `docs/designs/WORKFLOW_HARDENING_234_DESIGN.md` | 已修复 |
| GPG-019 | 低风险 | 低风险观察，`file_overrides` 未来扩展时应显式校验 key | `archive.ts` | 建议 |
| GPG-020 | 阻断 | 已修复，`request_changes(reopen_tasks)` 错误要求重 reopen lifecycle 字段 | `gates.ts` / `test_superspec_guard.test.ts` | 已修复 |
| GPG-021 | 阻断 | 已修复，allow path 接受 unknown/non-live evidence refs | `gates.ts` / `SPEC.md` | 已修复 |
| GPG-022 | 阻断 | 已修复，schema-invalid `request_changes` 仍给 handoff action | `gates.ts` / `core.ts` | 已修复 |
| GPG-023 | 中风险 | 已修复，allow path `verification_evidence_refs` 白名单过宽 | `gates.ts` / `evidence.ts` | 已修复 |
| GPG-024 | 阻断 | 已修复，schema-invalid review `source_guidance` 仍可触发 `request_changes` handoff | `gates.ts` / `test_superspec_guard.test.ts` | 已修复 |
| GPG-025 | 阻断 | 已修复，`task_reopen` apply side 可用非 `review_complete` guidance 授权 reopen | `gates.ts` / `test_superspec_guard.test.ts` | 已修复 |
| GPG-026 | 低风险 | 观察，当前审查目标文件未被 git 跟踪，不能只依赖 `git diff` | repo state / review workflow | 已记录 |
| GPG-027 | 低风险 | 已文档对齐，guard 命令 surface 文档漏列 `check-task-reopen` / `check-review-complete` | `SPEC.md` / `cli_args.ts` / tests | 已修复 |
| GPG-028 | 低风险 | 已文档对齐，`state_freshness` 曾被误描述为包含可推进的 `stale` 持久态 | `SPEC.md` / `state.ts` | 已修复 |
| GPG-029 | 中风险 | 已文档对齐，普通 check 与 `check-archive-ready` 的锁/事务边界描述不一致 | `SPEC.md` / `core.ts` / `state.ts` | 已修复 |
| GPG-030 | 低风险 | 已文档对齐，OpenSpec floor route 文档曾高估 blocked review/archive 的有效路由 | `SPEC.md` / `openspec.ts` / `core.ts` | 已修复 |
| GPG-031 | 中风险 | 已文档对齐，archive skill/spec 对 `--skip-specs` / validate 口径不够硬 | `SPEC.md` / `superspec-archive` skill | 已修复 |
| GPG-032 | 中风险 | 已修复，proposal 缺轻量 `critic` advisory review，但不应升级成重 guard gate | `superspec-propose` skill / `SPEC.md` / skill smoke | 已修复 |
| GPG-033 | 低风险 | 已记录，已知测试覆盖缺口曾未集中列出 | `SPEC.md` / tests | 建议 |

### 1.1 历史未解决快照（已失效）

本节原为早期“当前未解决问题快照”。后续实现已修复其中多项阻断级 proof gap；本节保留为历史对照，不再作为当前待办清单。当前状态如下：

| 编号 | 优先级 | 当前状态 | 下一步 |
| --- | --- | --- | --- |
| GPG-008 | 阻断 | 已修复：`task_reopen` history 使用包含 superseded 的 pass history 防隐藏 | 保留 `task_reopen hidden by generic superseded` 回归测试 |
| GPG-009 | 阻断 | 已修复：resolved reopen 对 task 存在性、successor、hash 等执行全局语义校验 | 保留 deleted/replaced task reopen 负例 |
| GPG-001 | 阻断 | 已修复：`task_test_evidence(..., gate)` 已区分 `task_edit` / `task_complete` | 保留 wrong-gate RED/GREEN 负例 |
| GPG-002 | 阻断 | 已修复：每个 declared `TEST-*` 已要求对应 evidence 或明确例外 | 保留 declared test refs 逐项兑现测试 |
| GPG-003 | 阻断 | 已修复：final invariant matrix 已解析并覆盖 hard invariant | 保留 matrix 空表/段落 token/unknown evidence 负例 |
| GPG-010 | 中风险 | 已修复：同一 task 多 reopen history 在 v1 下会 block | 保留 multiple resolved task_reopen histories 负例 |
| GPG-004 | 中风险 | 未解决：review/human hard invariant 被强制进入 TEST 矩阵，策略过严 | 拆分 automated / review-checklist / human-confirmation 的兑现路径 |
| GPG-006 | 中风险 | 未解决：post-implementation invariant 引用策略不够一致 | 明确 late invariant 能否参与 coverage、RED/GREEN、final matrix 的规则 |
| GPG-007 | 中风险 | 未解决：历史文档仍有误导性实施优先级表述 | 清理 `docs/history/DUAL_TRACK_REFACTOR_PLAN.md` 中与当前 `SPEC.md` 冲突的实施口径 |
| GPG-019 | 低风险 | 未解决观察：`file_overrides` 未来扩展缺 key 级校验 | 当前不阻断；未来扩展前补 key 安全校验和负例 |
| GPG-033 | 低风险 | 未解决测试 backlog：已知覆盖缺口已记录但未全部补测 | 按 `SPEC.md` §17.1 逐项补 focused guard/skill smoke tests |

历史优先级原则已失效；当前待办应从最新 `SPEC.md`、测试失败和新的审查报告派生。

## 2. GPG-001：apply 阶段 RED/GREEN 证据没有限制 gate

### 优先级

阻断。

### 发生位置

- `scripts/superspec/src/tasks.ts`
- `scripts/superspec/src/gates.ts`

关键实现：

```ts
export function task_test_evidence(evidences: JsonMap[], taskId: string, semanticStatus: string): JsonMap[] {
  return live_pass(evidences, { kind: "test_run", task_id: taskId }).filter((ev) => ev.semantic_status === semanticStatus);
}
```

### 使用步骤

apply 阶段执行：

- `check-task-edit --change <change> --task-id <task>`
- `check-task-complete --change <change> --task-id <task>`

### 典型场景

一个 task 需要 TDD 证据：

1. `check-task-edit` 应该只接受本轮 apply 编辑前的 RED 证据。
2. `check-task-complete` 应该只接受 task 完成前的 GREEN 证据。
3. 证据必须绑定到正确的 gate，例如 RED 绑定 `task_edit`，GREEN 绑定 `task_complete`。

### 当前行为

`task_test_evidence()` 只筛选：

- `kind: "test_run"`
- `task_id`
- `semantic_status`

它没有限制 `gate`。因此一个错误阶段写入的 `test_run`，只要 `task_id` 和 `semantic_status` 对上，就可能被 apply guard 当成合法 RED/GREEN。

### 为什么这是问题

guard 的阶段证明被削弱：

- `review_complete`、`verify_complete` 或其他错误 gate 下的 `test_run`，可能冒充 apply 阶段 RED/GREEN。
- `check-task-edit` 不能证明 RED 是在“编辑前”采集。
- `check-task-complete` 不能证明 GREEN 是在“完成前”采集。
- 后续 review 看到的是“有 RED/GREEN”，但无法证明证据来自正确阶段。

### 复现证据

临时 fixture 复现结果：

```json
{
  "case": "wrong-gate RED accepted by check_task_edit",
  "allowed": true,
  "codes": []
}
```

复现含义：

- 构造 `gate: "review_complete"` 的 RED `test_run`。
- `task_id: "TASK-001"`。
- `semantic_status: "expected_failure"`。
- 执行 `check_task_edit()`。
- 结果为 allow。

### 建议修法

将 `task_test_evidence()` 改为显式接收 gate 或 phase policy。

建议规则：

| 调用点 | semantic_status | 应接受 gate |
| --- | --- | --- |
| `check_task_edit` 新行为 / hotfix RED | `expected_failure` | `task_edit` |
| `check_task_edit` 行为保持重构 characterization | `expected_success` | `task_edit` 或专门的 `task_characterization`，需在规范中明确 |
| `check_task_complete` GREEN | `expected_success` | `task_complete` |
| reopened task successor GREEN | `expected_success` | `task_complete`，且必须带正确 `reopen_id` |

### 验收标准

新增测试应覆盖：

- `gate:"review_complete"` 的 RED 不能满足 `check-task-edit`。
- `gate:"task_complete"` 的 RED 不能满足 `check-task-edit`，除非规范明确允许。
- `gate:"task_edit"` 的 GREEN 不能满足 `check-task-complete`。
- reopened task 的 successor evidence 也必须来自正确 gate。

## 3. GPG-002：多个 `test_refs` 未强制逐项 RED/GREEN

### 优先级

阻断。

### 发生位置

- `scripts/superspec/src/gates.ts`

关键实现区域：

- `check_task_edit()`
- `check_task_complete()`
- `check_review_ready()`

### 使用步骤

apply 阶段 task 声明多个 test refs：

```md
- [ ] TASK-001 Implement
  - invariant_refs: INV-001
  - test_refs: TEST-001, TEST-002
```

### 典型场景

`TASK-001` 声明自己要兑现两个测试：

- `TEST-001`
- `TEST-002`

按 test-contract 语义，task 完成时应能证明两个测试都已经有对应 GREEN。对于新行为 TDD，编辑前也应能证明声明范围内需要 RED 的测试已进入 RED 状态，除非存在明确的非 TDD 或 review-only 例外。

### 当前行为

当前 `check_task_complete()` 逻辑只检查：

```ts
const green = task_test_evidence(evidences, taskId, "expected_success");
if (green.length === 0) reasons.push(reason("missing_green_evidence", ...));
```

随后 `evidence_test_id_reasons()` 只校验“已有 evidence 的 `test_id` 是否在声明集合内”，但不校验“声明集合里的每个 `TEST-*` 是否都有 evidence”。

因此：

- 有一个合法 GREEN 就能满足“存在 GREEN”。
- 未跑的 `TEST-002` 不会被发现。

### 为什么这是问题

这会让 test contract 变成声明强、执行弱：

- `tasks.md` 声明了多个 `TEST-*`。
- guard 只证明其中某些测试跑过。
- review 阶段看到 checked task 和 GREEN evidence，可能误以为整个 task 的测试矩阵已兑现。

### 复现证据

临时 fixture 复现结果：

```json
{
  "case": "one GREEN satisfies task with TEST-001+TEST-002",
  "allowed": true,
  "codes": []
}
```

复现含义：

- task 声明 `TEST-001, TEST-002`。
- 只提交 `TEST-001` 的 GREEN。
- 执行 `check_task_complete()`。
- 结果为 allow。

### 建议修法

在 task 级别增加 declared test coverage 校验。

建议增加两个 helper：

- `missing_declared_test_evidence(evidences, taskId, declared, semanticStatus, gate)`
- `declared_test_evidence_by_test_id(...)`

对 `check_task_complete()`：

- 对每个 declared `TEST-*`，必须存在 `expected_success` evidence。
- evidence 必须 live/pass。
- evidence 必须属于该 `task_id`。
- evidence 必须属于正确 gate。

对 `check_task_edit()`：

- 需要结合 `tdd_mode` 决定是“每个 declared TEST 都必须 RED”，还是“至少每个会被本 task 新增/改变的 TEST 必须 RED”。
- 如果当前 workflow 暂时无法区分新增测试与已有 characterization test，至少应要求每个 declared TEST 都有明确证据或明确例外字段。

### 验收标准

新增测试应覆盖：

- task 声明 `TEST-001, TEST-002`，只有 `TEST-001` GREEN 时，`check-task-complete` block。
- task 声明 `TEST-001, TEST-002`，两个都有 GREEN 时 allow。
- GREEN 存在但 task_id 不匹配时 block。
- GREEN 存在但 gate 不匹配时 block。
- review_ready 对 checked task 也应继承同样的逐项缺口。

## 4. GPG-003：final verification 的 invariant matrix 只检查可读，不检查覆盖 hard INV

### 优先级

阻断。

### 发生位置

- `scripts/superspec/src/evidence.ts`
- `scripts/superspec/src/gates.ts`
- 规范依据：`docs/SPEC.md`

### 使用步骤

review 阶段执行：

- `check-review-complete`
- 兼容入口：`check-verify-ready`

verifier 或 critic 提交：

```json
{
  "kind": "verification_review",
  "gate": "review_complete",
  "invariant_matrix_ref": ".superspec/reports/invariant-matrix.md"
}
```

### 典型场景

`business-invariants.md` 中存在 hard invariant：

```md
| INV-001 | ... | confirmed | automated-test | ... |
```

`SPEC.md` 要求 review complete 通过前：

- 每个 hard invariant 均进入 invariant matrix。
- final verification evidence 不能只声称有矩阵文件，必须证明矩阵覆盖完整。

### 当前行为

`verify_reference_reasons()` 当前只检查引用文件：

- path 不逃逸 change root。
- 文件存在。
- 文件是普通文件。

它不解析 `invariant_matrix_ref` 内容，也不检查 hard invariant 覆盖。

### 为什么这是问题

空文件、无关文件、只写“pass”的文件都可能被当成合法 invariant matrix。

这会破坏 final verification 的核心承诺：

- verifier/critic 提交了 `invariant_matrix_ref`。
- guard 只证明文件存在。
- guard 没证明 hard invariant 是否逐项进入最终矩阵。

### 复现证据

临时 fixture 复现结果：

```json
{
  "case": "empty invariant matrix accepted by review_complete",
  "allowed": true,
  "codes": []
}
```

复现含义：

- `business-invariants.md` 含 `INV-001`。
- `verification_review.invariant_matrix_ref` 指向一个空文件。
- verifier 和 critic evidence 均存在。
- final_test evidence 存在。
- main_adjudication allow。
- 执行 `check_review_complete()`。
- 结果为 allow。

### 建议修法

增加 invariant matrix 内容校验。

最低要求：

- 读取 `business-invariants.md` 中的 hard invariant ids。
- 读取 `invariant_matrix_ref` 文件内容。
- 每个 hard `INV-*` 必须在 matrix 的结构化行中出现。
- 不能只匹配注释或普通段落中的 token。

更稳妥要求：

定义 matrix 表结构，例如：

```md
| INV-ID | verification | evidence | status | gap |
| --- | --- | --- | --- | --- |
| INV-001 | automated-test | EV-green-001 | pass | none |
```

并要求：

- `INV-ID` 覆盖所有 hard invariant。
- `status` 必须是 `pass` 或 `accepted`。
- `evidence` 必须引用 live/pass evidence id，或显式引用 review-only/human-confirmation evidence。
- `gap` 不得包含 blocking gap。

### 验收标准

新增测试应覆盖：

- 空 invariant matrix block。
- matrix 缺少某个 hard `INV-*` block。
- matrix 只在普通段落提到 `INV-*`，但表格缺失时 block。
- matrix 覆盖所有 hard `INV-*` 且引用 live/pass evidence 时 allow。
- `verifier` 和 `critic` 两条 verification_review 都应分别满足 matrix 覆盖要求，或规范明确只要求其中一条权威 matrix。

## 5. GPG-004：review-checklist / human-confirmation 型 hard invariant 被强制进入 TEST 覆盖矩阵

### 优先级

中风险。

### 发生位置

- `scripts/superspec/src/invariants.ts`
- `scripts/superspec/src/gates.ts`
- 相关设计文档：`docs/designs/INVARIANT_REVIEW_RETROFIT.md`

### 使用步骤

propose 阶段执行：

- `invariants_reviewed`
- `test_contract_drafted`

### 典型场景

某些不变量无法或不适合自动化测试，例如：

- 需要人工确认业务口径。
- 需要 code review checklist 判断。
- 需要运营或产品负责人确认。

示例：

```md
| INV-001 | Needs owner confirmation | ... | confirmed | human-confirmation | must be confirmed by owner | human confirmation evidence | ... |
```

### 当前行为

`isHardInvariant()` 将以下不变量都视为 hard：

- `confidence: confirmed`
- `confidence: source-backed`
- 且 `enforcement_level !== advisory`

这意味着：

- `automated-test` 是 hard。
- `review-checklist` 也是 hard。
- `human-confirmation` 也是 hard。

随后 `test_contract_drafted` 要求所有 hard invariant 都出现在 test-contract 的 `TEST-*` 覆盖矩阵中。

### 为什么这是问题

`docs/designs/INVARIANT_REVIEW_RETROFIT.md` 已经承认存在 `review-checklist` / `human-confirmation`：

- 它们可以是强约束。
- 但它们不一定能通过 `TEST-*` 自动化覆盖。

当前实现把“hard”与“必须自动化测试”绑定，可能误挡合法的人审型不变量。

### 复现证据

临时 fixture 复现结果：

```json
{
  "allowed": false,
  "codes": ["invariant_not_honored"],
  "messages": [
    "test-contract missing hard business invariants: ['INV-001']"
  ]
}
```

复现含义：

- `INV-001` 是 `human-confirmation`。
- `invariants_reviewed` 已提交 human confirmation evidence。
- test-contract 中没有把 `INV-001` 放进 `TEST-*` 行。
- `test_contract_drafted` block。

### 建议修法

将 hard invariant 拆成两类：

| 类型 | enforcement_level | 要求 |
| --- | --- | --- |
| automated hard invariant | `automated-test` | 必须进入 `TEST-*` 覆盖矩阵 |
| review hard invariant | `review-checklist` | 必须进入 `REVIEW-*` checklist 或 verification matrix |
| human hard invariant | `human-confirmation` | 必须有 human_confirmation evidence，并进入 final invariant matrix |
| advisory | `advisory` | 不作为阻断约束 |

`test_contract_drafted` 应只强制 automated hard invariant 进入 `TEST-*`。review/human 类型应进入另一张矩阵或同一矩阵的非 TEST 行。

### 验收标准

新增测试应覆盖：

- `automated-test` hard invariant 缺 TEST 行时 block。
- `human-confirmation` hard invariant 有 human evidence 且有 REVIEW/HUMAN matrix 行时 allow。
- `human-confirmation` hard invariant 无 human evidence 时 block。
- `review-checklist` hard invariant 无 checklist evidence 时 block。
- final invariant matrix 覆盖 automated/review/human 三类 hard invariant。

## 6. GPG-005：target_refs 指向删除文件可能直接抛异常

### 优先级

中风险，当前判断为基本不成立。

### 发生位置

- `scripts/superspec/src/evidence.ts`
- `scripts/superspec/src/git.ts`

### 使用步骤

任意 role evidence schema 校验：

```json
{
  "agent_role": "critic",
  "target_refs": [
    { "path": "missing-design.md", "blob_sha": "sha256:missing" }
  ]
}
```

### 原始担忧

如果 `target_refs` 指向的文件被删除或不存在，guard 可能直接抛异常，而不是返回结构化 block reason，例如 `stale_review`。

### 当前实现证据

当前 `pinned_ref_reasons()` 在调用 `runtime.file_blob_sha()` 前先做了：

- `safe_within()`。
- `existsSync()`。
- `statSync().isFile()`。

文件不存在时返回 `stale_review`，不会进入 hash 逻辑。

现有测试也覆盖：

- role evidence missing target file blocks without throwing。
- main adjudication missing loaded ref file blocks without throwing。

### 当前结论

该问题对主要 evidence 路径不成立。

### 保留风险

`git.ts` 中 `file_blob_sha()` 本身仍会在文件缺失时抛 `GuardError`。如果未来新增调用点没有先检查存在性，仍可能复发。

### 建议动作

暂不作为阻断修复项。

建议保留或增强回归测试：

- `target_refs` missing file 返回 `stale_review`。
- `loaded_refs` missing file 返回 `stale_loaded_ref`。
- `source_refs` missing file 返回结构化 reason。
- `required_load_refs` missing file 返回结构化 reason。

## 7. GPG-006：`created_after_implementation:true` 的 post-implementation invariant 策略不够一致

### 优先级

中风险，当前判断为部分成立。

### 发生位置

- `scripts/superspec/src/invariants.ts`
- `scripts/superspec/src/gates.ts`

### 使用步骤

实现后追加业务不变量：

```md
| INV-POST | Added late | ... | confirmed | automated-test | TEST-001 | ... | true |
```

### 当前行为

hard post-implementation invariant 当前会被挡住：

- `business_invariant_validation_reasons()` 对 hard + `created_after_implementation:true` 返回 `post_implementation_invariant_backfill`。
- `test_contract_drafted` 也会 block 将 post-implementation invariant 映射进 test-contract 的情况。

临时复现结果为 block，并包含：

```json
[
  "post_implementation_invariant_backfill",
  "test_contract_drafted_failed",
  "invariants_not_reviewed"
]
```

### 实际问题

阻断级绕过没有复现。当前 hard backfill 会被挡住。

剩余问题是策略一致性：

- hard post invariant 被明确挡住。
- 非 hard 或 advisory post invariant 仍可能作为 `invariant_refs` 装饰性出现。
- guard 对“晚加 INV 是否允许被 task/evidence 引用”没有一套统一策略。

### 为什么这是问题

`created_after_implementation:true` 的语义是：

- 它不是原始约束。
- 默认不能 retroactively 满足已有 task 的 RED/GREEN gate。
- 如果要作为补充审查，应有 human confirmation 或 change_update 路径。

如果某些 post invariant 被 evidence 引用但不参与阻断，后续读者可能误以为它是原始 test contract 的一部分。

### 建议修法

明确 post invariant 引用策略：

1. hard post invariant：继续 block，除非进入 change_update 或有专门 human confirmation 批准。
2. review/human post invariant：允许作为补充审查，但必须标记为 post-implementation，并进入 final invariant matrix 的补充区。
3. advisory post invariant：允许引用，但不得用于满足 RED/GREEN 或 test-contract coverage。

### 验收标准

新增测试应覆盖：

- hard `created_after_implementation:true` 不能满足 RED/GREEN。
- advisory post invariant 可以被记录，但不计入 required coverage。
- review/human post invariant 必须有 human/review evidence。
- final invariant matrix 必须区分 original invariant 与 post-implementation invariant。

## 8. GPG-007：历史文档顶部声明与正文实施优先级冲突

### 优先级

中风险。

### 发生位置

- `docs/history/DUAL_TRACK_REFACTOR_PLAN.md`

### 当前状态

文件顶部已经写明：

```md
Historical note: 本文是早期 refactor 草案，保留用于设计取舍追溯。当前实现规范以 `docs/SPEC.md` 为准。
```

但正文仍保留旧表述：

```text
本次 SuperSpec 改造以本文为实施方案。
DESIGN.md 保留为原设计稿和对照材料。
凡 DESIGN.md 中与本文冲突的内容，必须作为后续同步项处理，不能直接照旧实现。
```

### 为什么这是问题

未来 agent 或人类读到正文时，可能忽略顶部 historical note，并误以为该文件仍是实施方案。

这类误导对 workflow 类项目尤其危险：

- agent 可能按旧 artifact graph 实现。
- agent 可能按旧状态机约束实现。
- agent 可能与当前 `SPEC.md` 冲突。

### 建议修法

将旧实施优先级块改为历史说明，例如：

```text
历史状态：
本文曾作为 SuperSpec 改造实施方案。
当前不再作为实施依据；实现和修改必须以 SPEC.md 为准。
本文仅用于追溯旧设计取舍。
```

### 验收标准

文档中不应再出现无上下文的：

- “以本文为实施方案”
- “必须作为后续同步项处理”
- “不能直接照旧实现”

如果保留这些句子，必须明确标为“历史原文”或“已废弃”。

## 9. GPG-008：`task_reopen` 可被普通 `superseded` evidence 隐藏

### 优先级

阻断。

### 发生位置

- `scripts/superspec/src/evidence.ts`
- `scripts/superspec/src/gates.ts`

关键实现区域：

- `live_pass()`
- `live_task_reopens()`
- `task_reopen_history()`
- `check_task_complete()`

### 使用步骤

review 打回既有 task 后进入 apply reopen：

1. review 写出 `request_changes(reopen_tasks)`。
2. apply 写出 `task_reopen`。
3. 后续执行 `check-task-complete` 或 `check-review-ready`。

### 典型场景

`TASK-001` 已经被 review 打回，并存在一条合法 `task_reopen`：

```json
{
  "kind": "task_reopen",
  "evidence_id": "EV-task-reopen",
  "task_id": "TASK-001",
  "reopen_id": "reopen-001"
}
```

攻击或错误实现随后写入普通 supersede evidence：

```json
{
  "status": "superseded",
  "supersedes": "EV-task-reopen"
}
```

但没有写入合法 `task_reopen_resolved`，也没有 successor GREEN / alternative verification。

### 当前行为

`live_pass()` 会把任何被 `status:"superseded"` + `supersedes` 命中的 evidence 从 live 集合移除。

`live_task_reopens()` 基于 `live_pass()`，因此 `EV-task-reopen` 被普通 supersede 后，不再出现在 live reopen 集合。

`check_task_complete()` 对 checked task 的 reopen 校验依赖：

- `history.unresolvedLive.length > 0`
- `history.liveResolved.length > 0`

如果 `task_reopen` 被普通 supersede 隐藏，且没有 `task_reopen_resolved`，这两个条件都可能为 false，checked task 会回到 ordinary completion path。

### 为什么这是问题

`task_reopen` 是生命周期授权，不应由普通 supersede 关闭。

如果普通 supersede 可以隐藏 `task_reopen`：

- reopen 授权可以在没有 resolution 的情况下消失。
- successor proof 可以被绕过。
- `review_ready` 可能把“被打回但未重新证明完成”的 task 当成普通 checked task。

这与 reopen 协议中的“`task_reopen_resolved` 只负责关闭本轮授权”相冲突。

### 复现证据

critic subagent 审查指出：

```text
Generic supersession can hide a task_reopen without any task_reopen_resolved.
live_pass() drops any evidence id named by status:"superseded".
```

复现含义：

- 写入 `task_reopen`。
- 写入 `superseded` evidence 指向 `task_reopen.evidence_id`。
- 不写 `task_reopen_resolved`。
- checked task 可能不再触发 reopen-aware successor 校验。

### 建议修法

不要用普通 `live_task_reopens()` 作为 reopen 生命周期真实性的唯一来源。

建议规则：

1. `task_reopen` lifecycle evidence 不允许被普通 supersede 关闭；只能被合法 `task_reopen_resolved` 消耗。
2. 或者在 checked-task / review-ready 路径中，从 `pass_task_reopens()` 出发计算所有 reopen history，直到找到绑定且语义合法的 `task_reopen_resolved`。
3. 若某条 `task_reopen` 只有普通 supersede、没有合法 resolved，应视为 unresolved 或 invalid lifecycle，必须 block。

### 验收标准

新增测试应覆盖：

- `supersededEvidence("EV-task-reopen")` 不能关闭 reopen。
- 被普通 supersede 隐藏的 `task_reopen` 仍会让 `check-task-complete` block。
- 被普通 supersede 隐藏的 `task_reopen` 仍会让 `check-review-ready` block。
- 合法 `task_reopen_resolved` 可以关闭 reopen，但普通 supersede 不能替代它。

## 10. GPG-009：task 被删除或替换后，resolved reopen 语义校验不会执行

### 优先级

阻断。

### 发生位置

- `scripts/superspec/src/evidence.ts`
- `scripts/superspec/src/gates.ts`

关键实现区域：

- `unresolved_live_task_reopens()`
- `check_review_ready()`
- `task_reopen_resolution_reasons()`

### 使用步骤

review 打回 `TASK-001` 后：

1. apply 写入 `task_reopen`。
2. `tasks.md` 中的 `TASK-001` 被删除、重命名或替换。
3. 写入字段匹配的 `task_reopen_resolved`。
4. 执行 `check-review-ready`。

### 典型场景

原始 reopen：

```json
{
  "kind": "task_reopen",
  "evidence_id": "EV-task-reopen",
  "task_id": "TASK-001",
  "reopen_id": "reopen-001"
}
```

当前 `tasks.md` 不再包含 `TASK-001`。

随后写入：

```json
{
  "kind": "task_reopen_resolved",
  "reopen_evidence_id": "EV-task-reopen",
  "task_id": "TASK-001",
  "reopen_id": "reopen-001",
  "successor_completion_evidence_ids": ["EV-fake"]
}
```

### 当前行为

`check_review_ready()` 遍历当前 `tasks.md` 中解析出的 checked task，并对这些 task 调用 `check_task_complete()`。

如果 `TASK-001` 已不在当前 `tasks.md` 中：

- 不会调用 `check_task_complete("TASK-001")`。
- 不会调用 `task_reopen_resolution_reasons("TASK-001")`。
- `unresolved_live_task_reopens()` 仍可能因为 `reopen_evidence_id` / `reopen_id` / `task_id` 字段匹配，把 `EV-task-reopen` 从 unresolved 集合移除。

因此 successor evidence 是否存在、task 是否仍存在、`tasks.md` hash 是否匹配，都可能被跳过。

### 为什么这是问题

删除或替换 task 是比普通 completion 更危险的生命周期变化。

guard 应能证明：

- 被 reopen 的 task 仍存在。
- resolution 确实关闭的是当前 task。
- successor evidence 真实存在且绑定同一个 reopen。

如果 task 不存在时仍能把 reopen 视为 resolved，`review_ready` 就会把“返工对象消失”误判成“返工已闭环”。

### 复现证据

code-reviewer subagent 用 schema-valid 临时 fixture 复现：

```text
evidence_schema_guard returned no problems,
then check_review_ready returned allowed: true
for a live TASK-001 reopen after TASK-001 was removed from tasks.md,
with matching task_reopen_resolved whose successor_completion_evidence_ids pointed to nonexistent EV-fake.
```

### 建议修法

`review_ready` 必须全局校验 reopen lifecycle，而不能只通过当前 parsed checked tasks 间接触发。

建议规则：

1. `check_review_ready()` 收集所有 `pass_task_reopens()` 和 live/pass `task_reopen_resolved`。
2. 对每个 reopen lifecycle 执行语义校验。
3. 若 reopen.task_id 不存在于当前 `tasks.md`，返回 `unknown_task` 或专门的 `task_reopen_lifecycle_invalid`。
4. `unresolved_live_task_reopens()` 只能在 resolution 通过完整语义校验后，才把 reopen 视为 closed；否则 fail-closed。

### 验收标准

新增测试应覆盖：

- reopened task 从 `tasks.md` 删除后，即使有字段匹配的 `task_reopen_resolved`，`check-review-ready` 也必须 block。
- successor id 不存在时 block。
- task 被重命名或替换时 block。
- resolution 的 `after_tasks_sha256` 与当前 `tasks.md` 不匹配时 block。
- 只有 task 存在、successor live/pass、同 task、同 reopen_id、hash 匹配时 allow。

## 11. GPG-010：resolved 多 reopen history 未执行 v1 单次 reopen 约束

### 优先级

中风险。

### 发生位置

- `scripts/superspec/src/gates.ts`

关键实现区域：

- `active_task_reopen_reasons()`
- `task_reopen_apply_state()`
- `task_reopen_resolution_reasons()`

### 使用步骤

同一个 task 在同一个 change 中出现多条 reopen history：

1. `TASK-001` 创建第一条 `task_reopen`。
2. 写入第一条合法 `task_reopen_resolved`。
3. 又创建第二条 `task_reopen`。
4. 写入第二条 `task_reopen_resolved`。
5. 执行 `check-review-ready`。

### 典型场景

同一 task 出现两组 lifecycle：

```json
{ "kind": "task_reopen", "evidence_id": "EV-reopen-1", "task_id": "TASK-001" }
{ "kind": "task_reopen_resolved", "reopen_evidence_id": "EV-reopen-1", "task_id": "TASK-001" }
{ "kind": "task_reopen", "evidence_id": "EV-reopen-2", "task_id": "TASK-001" }
{ "kind": "task_reopen_resolved", "reopen_evidence_id": "EV-reopen-2", "task_id": "TASK-001" }
```

### 当前行为

`active_task_reopen_reasons()` 对 active unresolved reopen 路径有：

```text
history.pass.length > 1 -> reopen_lifecycle_exhausted
```

但 checked-task resolved path 主要校验 resolution 本身是否合法，没有明确拒绝“同一 task 已经有多条 pass task_reopen history”。

因此多条 reopen 如果都被 resolution 配对，可能绕过 v1 “同一 task 在同一个 change 内只允许创建一次 `task_reopen`”的约束。

### 为什么这是问题

v1 没有定义第二轮 reopen 的语义。

如果 resolved 多 reopen history 被允许：

- guard 无法判断 successor evidence 属于哪一轮最终完成证明。
- 旧 review request_changes 与新 review request_changes 的 supersede/ownership 关系会变得模糊。
- 后续 archive/review proof 中的 reopen lifecycle 不再是单值状态机。

### 复现证据

critic subagent 审查指出：

```text
The v1 “one reopen history” rule is enforced only while processing an active unresolved reopen.
Once multiple reopens are each paired with live resolutions, the checked-task path validates resolutions
but does not reject multiple resolved reopen histories.
```

### 建议修法

把 v1 单次 reopen 约束提升为 task lifecycle 全局约束。

建议规则：

1. 对每个 task，`pass_task_reopens(evidences, taskId).length > 1` 时直接 block。
2. 该规则不因 `task_reopen_resolved` 或 ordinary supersede 放宽。
3. 如果未来支持第二轮 reopen，必须先设计新的 reopen round / supersede / review round 归属模型。

### 验收标准

新增测试应覆盖：

- 同一 task 两条 pass `task_reopen`，即使都有合法 resolved，也必须 block。
- 同一 task 第二条 reopen 被 superseded，也仍按 v1 block，除非规范明确改变。
- 不同 task 各自一条 reopen 不应互相 block。
- block reason 应明确为 `reopen_lifecycle_exhausted` 或同等生命周期错误。

## 12. GPG-011：`.superspec` traversal alias 可逃逸 change root

### 优先级

阻断，已修复。

### 发生位置

- `scripts/superspec/src/util.ts`
- `scripts/superspec/src/evidence.ts`
- `scripts/superspec/src/archive.ts`
- `scripts/superspec/tests/test_superspec_guard.test.ts`

### 使用步骤

任意流程读取 `.superspec` 证据或生成 archive preservation bundle：

- `index_evidence(changeRoot)`
- `sidecar_manifest_entries(changeRoot)`
- `write_archive_preservation_bundle(...)`
- `check-archive-ready`

### 典型场景

`.superspec/evidence/**` 或 `.superspec/raw/**` 下放入 symlink / hardlink，指向 change root 之外的文件。

### 原始行为

`walkFiles()` 早期使用会跟随 symlink 的文件状态判断。这样 evidence indexing 或 archive bundle 枚举时，可能把外部 JSON evidence 或 raw file 纳入 SuperSpec proof。

### 为什么这是问题

guard 不能证明证据来自 change root 内的 sidecar。外部文件被枚举后，可能：

- 被当作 live/pass evidence。
- 被 archive manifest 记录 hash。
- 被 preservation bundle 复制。

### 修复后行为

`walkFiles()` 改为使用 `lstatSync()`：

- symlink 直接跳过。
- `nlink > 1` 的 hardlinked file 也跳过。
- `index_evidence()` 与 archive manifest/bundle 生成共用该枚举行为。

### 验收标准

新增测试已覆盖：

- `evidence index skips symlinked and hardlinked evidence entries`
- `archive preservation skips symlinked and hardlinked sidecar files`

## 13. GPG-012：missing pinned refs 可导致非结构化失败

### 优先级

中风险，已修复。

### 发生位置

- `scripts/superspec/src/evidence.ts`
- `scripts/superspec/tests/test_superspec_guard.test.ts`

### 使用步骤

role evidence 或 main adjudication 携带 pinned refs：

- `target_refs`
- `loaded_refs`
- `source_refs`
- `required_load_refs`

### 典型场景

某条 evidence 写入：

```json
{
  "target_refs": [
    { "path": "missing-design.md", "blob_sha": "sha256:missing" }
  ]
}
```

或：

```json
{
  "loaded_refs": [
    { "path": "missing-loaded-ref.md", "blob_sha": "sha256:missing" }
  ]
}
```

### 原始行为

部分 pinned ref 校验路径在 hash 前没有先确认目标文件存在，可能让 guard 以异常形式失败，而不是输出结构化 block reason。

### 为什么这是问题

guard 应该 fail-closed，并给出可恢复的 reason code。非结构化异常会让调用者无法判断下一步是重新加载文件、更新 blob sha，还是修复 evidence schema。

### 修复后行为

`pinned_ref_reasons()` 在调用 `runtime.file_blob_sha()` 前先检查：

- `safe_within()` 不逃逸。
- 文件存在。
- 目标是普通文件。

缺失文件返回：

- `stale_review`
- `stale_loaded_ref`

### 验收标准

新增测试已覆盖：

- `role evidence missing target file blocks without throwing`
- `main adjudication missing loaded ref file blocks without throwing`

## 14. GPG-013：`request_changes -> task_reopen` 可绕过主线程 adjudication 覆盖

### 优先级

阻断，已修复。

### 发生位置

- `scripts/superspec/src/gates.ts`
- `scripts/superspec/tests/test_superspec_guard.test.ts`

### 使用步骤

review 阶段写出：

```json
{
  "kind": "main_adjudication",
  "review_decision": "request_changes",
  "request_changes_route": "reopen_tasks"
}
```

随后 apply 阶段执行：

- `check-task-reopen --change <change> --task-id <task>`

### 典型场景

source guidance 要求主线程加载关键 refs、裁决 claims、处理 blocking findings，但 main adjudication 只写了 reopen route，未覆盖这些字段。

### 原始行为

allow path 的 `review_complete` 会检查 required loads / claims / blocking findings，但 request_changes path 可提前返回，后续 `task_reopen` 只看 route/source linkage，可能继续往 apply 走。

### 为什么这是问题

review 打回不是自由文本通知。它必须证明主线程确实阅读关键 source、处理 claim、确认 blocker。否则 apply reopen 会建立在未裁决的 review guidance 上。

### 修复后行为

新增共享检查：

- 所有 live/pass `source_guidance.required_load_refs` 必须被 `main_adjudication.loaded_refs` 覆盖。
- 所有 `required_claim_ids` 必须被 `claim_adjudications` 精确覆盖。
- 所有 `blocking_findings[*].finding_id` 必须被 `finding_adjudications` 精确覆盖，且不能停在 `needs_fix`。

`check_task_reopen()` 在允许回退前也执行该 request_changes round 检查。

### 验收标准

新增测试已覆盖：

- `task reopen blocks under-adjudicated request_changes guidance`
- `dispatch request_changes with verification refs does not hand off`
- `dispatch request_changes missing route does not hand off`

## 15. GPG-014：archive identity 可被 suffix match 或 manifest mismatch 伪造

### 优先级

阻断，已修复。

### 发生位置

- `scripts/superspec/src/archive.ts`
- `scripts/superspec/tests/test_superspec_guard.test.ts`

### 使用步骤

归档后执行：

- `check-archived --change <change>`

### 典型场景

archive 目录存在：

```text
openspec/changes/archive/2026-06-08-other-demo-change
```

调用：

```text
check_archived("demo-change")
```

或 preservation manifest 的 `change_id` 与目标 change 不匹配。

### 原始行为

旧匹配逻辑可能使用 suffix 判断 archive directory，且 archive manifest readback 没有强制 `change_id === change`。

### 为什么这是问题

错误 change 的 archive preservation 可能被当作目标 change 的归档证明。archive proof 的对象身份会失效。

### 修复后行为

`find_archived_change()` 只接受：

- 目录名等于 `<change>`。
- 目录名等于 `YYYY-MM-DD-<change>`。

并且：

- primary manifest 必须 `change_id === change`。
- fallback manifest 必须 `change_id === change`。
- archive dir symlink 会被跳过。

### 验收标准

新增测试已覆盖：

- `check archived ignores suffix-only archive directory matches`
- `check archived ignores symlinked archive directory matches`
- `check archived blocks primary manifest change id mismatch`
- `check archived blocks fallback manifest change id mismatch`

## 16. GPG-015：archive preservation transaction rollback 非 fail-closed

### 优先级

阻断，已修复。

### 发生位置

- `scripts/superspec/src/archive.ts`
- `scripts/superspec/src/core.ts`
- `scripts/superspec/tests/test_superspec_guard.test.ts`

### 使用步骤

archive-ready 阶段执行：

- `check-archive-ready --change <change>`

内部会生成：

- `.superspec/artifacts/archive-preservation.json`
- `superspec-preservation/manifest.json`
- `superspec-preservation/files/**`

### 典型场景

首次 archive-ready 没有旧 preservation artifacts，`begin_archive_preservation_bundle()` 已 promote 新 manifest/bundle，随后 state CAS 失败或 promote 中段失败。

### 原始行为

rollback 只在 backup 存在时恢复旧文件。首次执行没有 backup 时，本次 promote 出来的正式 manifest/bundle 可能残留。这样最终 state 可以是 block，但正式 preservation artifacts 已可见。

### 为什么这是问题

archive-ready 的承诺是 fail-closed：

- 不允许 block state 旁边残留本次失败事务的新正式 preservation 产物。
- 不允许 manifest/bundle 半成品对后续 archive readback 形成误导。

### 修复后行为

promotion state 现在记录：

- `had_final_manifest`
- `had_final_bundle`

rollback 规则：

- 有旧 backup：恢复旧 manifest/bundle。
- 原先没有 final：删除本次 promote 的 final manifest/bundle。
- commit cleanup 是 best-effort，不会在 cleanup 失败后触发错误 rollback。

同时 `check-archive-ready` 在 state lock 内生成 preservation transaction，并在失败时恢复 state/ledger snapshot，再写最终 block state。

### 验收标准

新增测试已覆盖：

- `archive preservation transaction rollback restores previous manifest and bundle`
- `archive preservation first-run rollback removes promoted manifest and bundle`
- `archive preservation promote failure after bundle rename removes promoted artifacts`
- `archive ready blocks and restores state snapshot when state write CAS fails`
- `archive ready state write failure without previous preservation removes promoted artifacts`

## 17. GPG-016：archive readback 接受空 manifest / unsafe path / symlink archive dir

### 优先级

阻断，已修复。

### 发生位置

- `scripts/superspec/src/archive.ts`
- `scripts/superspec/tests/test_superspec_guard.test.ts`

### 使用步骤

执行：

- `check-archived --change <change>`

读取：

- primary `.superspec/artifacts/archive-preservation.json`
- fallback `superspec-preservation/manifest.json`

### 典型场景

恶意或损坏 manifest：

```json
{
  "change_id": "demo-change",
  "kind": "superspec_archive_preservation",
  "entries": []
}
```

或 entry path 使用 `../` 逃逸 archive root，fallback `files_root` 指向 bundle 外部。

### 原始行为

readback 端只循环 `manifest.entries ?? []`。空 entries 会直接 allow；entry path 和 fallback `files_root` 也没有统一安全边界校验。

### 为什么这是问题

archive proof 不只要证明 manifest 存在，还要证明它描述的是完整、内部、可读且身份匹配的 `.superspec` preservation surface。

### 修复后行为

primary/fallback manifest 现在必须满足：

- `kind` 与 manifest 类型匹配。
- `entries` 是非空数组。
- 必含 `.superspec/ledger.jsonl`。
- 必含 `.superspec/superspec-state.json`。
- 每个 entry path 必须是 `.superspec/**`。
- primary entry 必须留在 archived change root 内。
- fallback `files_root` 必须留在 `superspec-preservation/` 内。
- fallback entry 必须留在 `files_root` 内。
- readback 文件不能是 symlink 或 hardlink alias。

### 验收标准

新增测试已覆盖：

- `check archived blocks empty primary manifest with matching change id`
- `check archived blocks primary manifest entry path escape`
- `check archived blocks empty fallback manifest with matching change id`
- `check archived blocks fallback files root escape`
- `check archived blocks fallback manifest entry path escape`
- `check archived allows preservation bundle when sidecar missing`

## 18. GPG-017：`next_allowed_actions` 与真实 blocker 脱节

### 优先级

中风险，已修复。

### 发生位置

- `scripts/superspec/src/gates.ts`
- `scripts/superspec/src/core.ts`
- `scripts/superspec/tests/test_superspec_guard.test.ts`

### 使用步骤

任意 gate block 时读取：

- `decision.block_reasons`
- `decision.next_allowed_actions`

重点路径：

- `check-review-complete`
- `check-archive-ready`

### 典型场景

`validate_failed` 是唯一 blocker，但 action 里出现无关的 `repair main_adjudication` 或 `repair verification_review`。

### 原始行为

部分 action 由对象是否存在驱动，而不是由最终 `block_reasons.code` 驱动。archive_ready 继承 review actions 时也会传播噪音。

### 为什么这是问题

block 后的下一步建议会误导使用者。workflow 可能被带去修一个并非当前 blocker 的对象。

### 修复后行为

review/archive action planner 改为 reason-driven：

- 只有出现对应 reason code 时才输出对应 action。
- `review_ready` 的底层动作优先继承。
- `request_changes` 只在 request_changes round 本身结构完整时给 handoff action。
- `missing_archive_preservation_plan` 有明确的 rerun/fix filesystem action。

### 验收标准

新增测试已覆盖：

- `review complete validate failure only recommends validate fix`
- `review complete missing final tests does not suggest verification repair`
- `review complete preserves review_ready actions without generic fallback`
- `archive ready preserves inherited review actions without generic fallback`
- `archive ready blocks when preservation bundle cannot be written`

## 19. GPG-018：hardening 设计文档与当前实现状态不一致

### 优先级

低风险，已修复。

### 发生位置

- `docs/designs/WORKFLOW_HARDENING_234_DESIGN.md`

### 当前状态

原设计文档曾保留 Draft / residual gap 口径，且部分 rollback backup 描述与当前 staging backup 实现不一致。

### 为什么这是问题

SuperSpec workflow 依赖 agent 读取文档执行。如果文档把已实现约束描述成待实现，或把 backup 路径描述成旧方案，后续修改容易回退实现。

### 修复后行为

文档已更新为：

- `Implemented / under adversarial re-review`
- 记录 traversal alias、archive identity、request_changes adjudication、missing-ref fail-closed 等已实现基线。
- backup 位置同步为 `.superspec-staging/<run-id>/backup/*`。
- archive readback 校验规则同步到设计约束。

### 验收标准

已扫描确认文档不再命中：

- `Draft`
- `残留`
- `未解决`
- `待实现`
- `superspec-preservation.bak`

## 20. GPG-019：低风险观察，`file_overrides` 未来扩展时应显式校验 key

### 优先级

低风险观察。

### 发生位置

- `scripts/superspec/src/archive.ts`
- `scripts/superspec/src/core.ts`

### 当前状态

`begin_archive_preservation_bundle()` 支持 `file_overrides`，当前正常 workflow 只从 `core.ts` 传入固定两项：

- `.superspec/superspec-state.json`
- `.superspec/ledger.jsonl`

当前调用路径是安全的，critic/code-reviewer 已通过。

### 为什么仍记录

如果未来把 `begin_archive_preservation_bundle()` 暴露给更多调用方，任意 override key 可能影响 manifest path 语义。虽然当前没有实际漏洞，但这是一个可预见的扩展风险。

### 建议动作

未来扩展前给 `file_overrides` keys 增加同等校验：

- 必须是 `.superspec/**` 相对路径。
- 必须通过 `safe_within(changeRoot, key)`。
- 不允许覆盖 `.superspec/artifacts/archive-preservation.json`、lock/tmp 文件。
- 不允许通过 `..`、absolute path、symlink/hardlink alias 影响 change root 外部内容。

### 验收标准

当前不需要阻断实现。

建议未来新增测试：

- `file_overrides` key 为 `../escape` 时 block/throw structured error。
- `file_overrides` key 为 absolute path 时 block/throw structured error。
- 合法 `.superspec/superspec-state.json` 与 `.superspec/ledger.jsonl` override 继续 allow。

## 21. GPG-020：`request_changes(reopen_tasks)` 错误要求重 reopen lifecycle 字段

### 优先级

阻断，已修复。

### 发生位置

- `scripts/superspec/src/gates.ts`
- `scripts/superspec/tests/test_superspec_guard.test.ts`
- `.codex/skills/superspec-review/SKILL.md`
- `docs/designs/REVIEW_TASK_REOPEN_PROTOCOL_DESIGN.md`

### 使用步骤

review 阶段写出：

```json
{
  "kind": "main_adjudication",
  "review_decision": "request_changes",
  "request_changes_route": "reopen_tasks",
  "blocking_source_evidence_refs": ["EV-code-reviewer-guidance"],
  "reopen_task_ids": ["TASK-001"]
}
```

其中被选中的 code-reviewer `source_guidance.blocking_findings[*]` 只包含 v1 canonical 最小映射：

```json
{
  "finding_id": "FINDING-REOPEN-MINIMAL",
  "affected_task_ids": ["TASK-001"]
}
```

### 原始行为

`request_changes_round_reasons()` 通过 reopen-compatible 判断要求 blocking finding 同时具备：

- `violated_test_ids`
- `violated_requirement_refs`
- `why_completion_invalid`
- `required_fix`
- `completion_invalidity_class`
- `scope_expansion:false`
- `reopen_recommendation:true`

这把 review `source_guidance` 收紧成了完整 `task_reopen` lifecycle payload。

### 为什么这是问题

v1 guard / apply 真正消费的 reopen authorization 最小面只有：

- 被主线程选入 `blocking_source_evidence_refs` 的 live/pass `code-reviewer source_guidance`
- 其 `blocking_findings[*].affected_task_ids` 覆盖待 reopen task

重 lifecycle 字段属于后续 `task_reopen` evidence，不应成为 review route authorization 的必填项。否则 subagent 又被迫承担 apply lifecycle 的裁决细节，违背“subagent 是导游，不是最终裁决者”的设计。

### 修复后行为

`request_changes_round_reasons()` 现在只用 `affected_task_ids` 做 route authorization 覆盖判断：

- source 必须是 live/pass `gate:"review_complete"`、`kind:"source_guidance"`。
- source 必须是 `agent_role:"code-reviewer"`。
- blocking finding 必须有非空 `affected_task_ids`。
- 每个 `reopen_task_ids[*]` 必须被 `affected_task_ids` 覆盖。

`task_reopen` evidence 自身仍保留完整 lifecycle 字段校验。

### 验收标准

新增/更新测试已覆盖：

- `request_changes reopen route allows minimal affected task ids mapping`
- `request_changes reopen route blocks blocker missing affected task ids`
- `task reopen requires code-reviewer affected_task_ids coverage`

## 22. GPG-021：allow path 接受 unknown/non-live evidence refs

### 优先级

阻断，已修复。

### 发生位置

- `scripts/superspec/src/gates.ts`
- `scripts/superspec/tests/test_superspec_guard.test.ts`
- `docs/SPEC.md`

### 使用步骤

review allow path 写出合法 source guidance、verification review、final test 后，`main_adjudication` 额外引用不存在或非 live 的 evidence id：

```json
{
  "review_decision": "allow",
  "source_evidence_refs": ["EV-code-reviewer-guidance", "EV-architect-guidance", "EV-critic-guidance", "EV-fake-guidance"],
  "verification_evidence_refs": ["EV-verifier-verification", "EV-critic-verification", "EV-final-test", "EV-fake-final"]
}
```

### 原始行为

allow path 只检查“所有 live source/verification evidence 是否被引用”，未检查“引用集合是否只包含允许的 live/pass evidence”。

因此额外 fake/non-live id 可能随合法 id 一起进入 `main_adjudication` 而不触发 block。

### 为什么这是问题

`main_adjudication` 是主线程最终裁决 proof。它的 refs 如果允许混入 fake id：

- 后续 agent 可能误以为主线程加载/裁决了不存在的材料。
- review proof 的 source/verification 追溯集合不再可机判。
- allow path 的“主线程读过关键材料”承诺被削弱。

### 修复后行为

allow path 现在同时校验：

- `source_evidence_refs` 必须精确来自 live/pass `review_complete source_guidance`。
- `verification_evidence_refs` 必须来自 live/pass `review_complete verification_review | final_test`。
- 缺失引用和额外 unknown/non-live id 都 block。

为避免误导动作，在缺 `final_test` 或缺 verification role 时，unknown verification ref 的 repair action 不抢占 `missing_final_tests` 的下一步建议。

### 验收标准

新增测试已覆盖：

- `review complete blocks unknown source evidence refs on allow path`
- `review complete blocks unknown verification evidence refs on allow path`
- `review complete missing final tests does not suggest verification repair`

`SPEC.md` 也已同步为“缺失引用或额外 unknown / non-live id 都必须 block”。

## 23. GPG-022：schema-invalid `request_changes` 仍给 handoff action

### 优先级

阻断，已修复。

### 发生位置

- `scripts/superspec/src/gates.ts`
- `scripts/superspec/src/core.ts`
- `scripts/superspec/tests/test_superspec_guard.test.ts`

### 使用步骤

`main_adjudication.review_decision:"request_changes"` 本身 schema-invalid，例如：

- 缺 `request_changes_route`。
- `request_changes` 下错误携带非空 `verification_evidence_refs`。
- `change_update` 路由错误携带 `reopen_task_ids`。

### 原始行为

`check_review_complete()` 在本地只看到 `review_requests_changes`，先生成 handoff `next_allowed_actions`。随后 `dispatch()` 才追加 `validate_evidence_schema()` 的 `main_adjudication_invalid`，但不会重新计算或清理已生成的 handoff action。

因此最终 decision 可能同时出现：

- `block_reasons`: `review_requests_changes` + `main_adjudication_invalid`
- `next_allowed_actions`: `stop review completion and hand off to apply task_reopen ...`

### 为什么这是问题

无效的 request_changes 轮次不能驱动 apply/propose 下游。否则下游 agent 可能按 `next_allowed_actions` 进入错误路线，把未闭合的主线程 proof 当成真实 handoff。

### 修复后行为

`check_review_complete()` 的 request_changes 分支在计算 `requestChangeOnly` 前纳入：

- `validate_evidence_schema(adjudication, ...)`
- `request_changes_round_reasons(evidences)`

只有 block reason 集合里除了 `review_requests_changes` 没有其他问题时，才追加 handoff action。

### 验收标准

新增测试已覆盖：

- `dispatch request_changes with verification refs does not hand off`
- `dispatch request_changes missing route does not hand off`
- `request_changes handoff requires live source guidance`

## 24. GPG-023：allow path `verification_evidence_refs` 白名单过宽

### 优先级

中风险，已修复。

### 发生位置

- `scripts/superspec/src/evidence.ts`
- `scripts/superspec/src/gates.ts`
- `scripts/superspec/tests/test_superspec_guard.test.ts`

### 使用步骤

构造一条 live/pass `gate:"review_complete"` evidence：

```json
{
  "kind": "review",
  "agent_role": "verifier",
  "evidence_id": "EV-wrong-kind-verifier"
}
```

并把它加入 allow path：

```json
{
  "verification_evidence_refs": [
    "EV-verifier-verification",
    "EV-critic-verification",
    "EV-final-test",
    "EV-wrong-kind-verifier"
  ]
}
```

### 原始行为

`final_verification_evidences()` 是宽搜索，会包含：

- `kind:"final_test"`
- `kind:"verification_review"`
- `agent_role:"verifier"`
- 或带 verification required fields 的 evidence

allow path 曾用这个宽集合做 `verification_evidence_refs` 的允许集合，导致 wrong-kind verification-like evidence 可能被当成合法 final proof ref。

### 为什么这是问题

宽搜索适合发现 verification-like evidence 的缺字段或 repair gap，但 allow path 的 proof refs 必须更窄。规范要求 allow refs 只能指向本轮 live/pass：

- `kind:"verification_review"`
- `kind:"final_test"`

### 修复后行为

`check_review_complete()` 现在拆分：

- `verifications = final_verification_evidences(evidences)`：继续用于发现 verification-like 缺字段。
- `verificationProofs = live_pass(...).filter(kind === "verification_review" || kind === "final_test")`：只用于 allow path ref 白名单。

### 验收标准

新增测试已覆盖：

- `review complete blocks wrong-kind verification evidence refs on allow path`
- `review complete ignores verification evidence recorded only under verify_complete gate`
- `review complete blocks unknown verification evidence refs on allow path`

## 25. GPG-024：schema-invalid review `source_guidance` 仍可触发 request_changes handoff

### 优先级

阻断，已修复。

### 发生位置

- `scripts/superspec/src/gates.ts`
- `scripts/superspec/src/core.ts`
- `scripts/superspec/tests/test_superspec_guard.test.ts`

### 使用步骤

`main_adjudication` 本身是合法 `request_changes(reopen_tasks)`，但其依赖的 live/pass review `source_guidance` schema-invalid，例如：

```json
{
  "kind": "source_guidance",
  "agent_role": "code-reviewer",
  "source_refs": [],
  "required_load_refs": [],
  "blocking_findings": [
    {
      "finding_id": "FINDING-REOPEN-MALFORMED-SOURCE",
      "affected_task_ids": ["TASK-001"]
    }
  ]
}
```

### 原始行为

`check_review_complete()` request_changes 分支只把 `main_adjudication` schema 纳入本地 `requestChangeOnly` 判断。`source_guidance` 的 schema 问题仍由 `dispatch()` 事后追加，因此 handoff action 可能已经生成。

### 为什么这是问题

request_changes round 依赖的不只是 `main_adjudication`，还包括被引用的 `source_guidance`。如果 `source_guidance` 本身不是有效 proof，主线程不能把它作为可靠 handoff source。

### 修复后行为

`check_review_complete()` request_changes 分支在计算 `requestChangeOnly` 前，把全部 live `sourceGuidance` 执行：

```ts
sourceGuidance.flatMap((ev) => validate_evidence_schema(ev, change, changeRoot, repoRoot))
```

有任意 source guidance schema 问题时，不追加 `request_changes_handoff_actions()`。

### 验收标准

新增测试已覆盖：

- `dispatch request_changes with malformed source guidance does not hand off`

## 26. GPG-025：`task_reopen` apply side 可用非 `review_complete` guidance 授权 reopen

### 优先级

阻断，已修复。

### 发生位置

- `scripts/superspec/src/gates.ts`
- `scripts/superspec/tests/test_superspec_guard.test.ts`

### 使用步骤

构造一条 live/pass 但非本轮 review 的 evidence：

```json
{
  "gate": "design_complete",
  "kind": "source_guidance",
  "agent_role": "code-reviewer",
  "evidence_id": "EV-old-code-reviewer-guidance",
  "blocking_findings": [
    {
      "finding_id": "FINDING-OLD-REOPEN",
      "affected_task_ids": ["TASK-001"]
    }
  ]
}
```

然后让 `main_adjudication.blocking_source_evidence_refs` 或 `task_reopen.source_guidance_evidence_id` 指向它。

### 原始行为

`request_changes_round_reasons()` 和 `active_task_reopen_reasons()` 按全局 `live_pass(evidences)` 查 id，只校验：

- `kind:"source_guidance"`
- `agent_role:"code-reviewer"`
- `affected_task_ids` 覆盖 task

没有要求 `gate:"review_complete"`。

### 为什么这是问题

reopen 授权必须来自当前 review round 的 code-reviewer `source_guidance`。旧 gate / 错 gate guidance 不能被复用来授权 apply 回退，否则 apply side 不是 fail-closed。

### 修复后行为

`request_changes_round_reasons()` 现在只用：

```ts
live_pass(evidences, { gate: "review_complete", kind: "source_guidance" })
```

建立 source guidance 白名单，并要求：

- `source_evidence_refs` 只引用该白名单。
- `blocking_source_evidence_refs` 只引用该白名单。

`active_task_reopen_reasons()` 现在只接受：

- live/pass `gate:"review_complete"`、`kind:"main_adjudication"` 的 `source_adjudication_evidence_id`
- live/pass `gate:"review_complete"`、`kind:"source_guidance"`、`agent_role:"code-reviewer"` 的 `source_guidance_evidence_id`

### 验收标准

新增测试已覆盖：

- `task reopen rejects non-review source guidance authorization`
- `request_changes reopen route blocks blocker guidance omitted from source evidence refs`
- `dispatch check-task-reopen routes through reopen gate`

## 27. GPG-026：审查目标文件未被 git 跟踪，不能只依赖 `git diff`

### 优先级

低风险观察，已记录。

### 发生位置

- 当前 repository state
- review workflow

### 当前状态

本轮目标文件在当前 worktree 中显示为 untracked：

- `docs/SPEC.md`
- `scripts/superspec/src/gates.ts`
- `scripts/superspec/tests/test_superspec_guard.test.ts`

因此普通 `git diff -- <path>` 不会显示这些文件内容。

### 为什么仍记录

这不是 guard 运行时漏洞，但会影响审查质量：

- reviewer 如果只看 `git diff`，会误以为没有改动。
- subagent 需要直接读取当前磁盘文件，或使用 `git diff --no-index /dev/null <path>` / `git status --short` 补足 untracked 文件上下文。

### 当前处理

本轮 final critic / code-reviewer 都明确按当前磁盘文件读取，而不是依赖普通 `git diff`。

### 建议动作

后续审查未跟踪文件时，review prompt 应明确说明：

- 当前目标文件可能 untracked。
- 普通 `git diff` 不足以作为唯一审查材料。
- 必须读取当前磁盘文件或显式处理 untracked diff。

## 28. GPG-027：guard 命令 surface 文档漏列 `check-task-reopen` / `check-review-complete`

### 优先级

低风险，已文档对齐。

### 发生位置

- `docs/SPEC.md`
- `scripts/superspec/src/cli_args.ts`
- `scripts/superspec/tests/test_superspec_guard.test.ts`

### 原始缺口

实现和测试已经存在：

- `check-task-reopen`
- `check-review-complete`

但规范中的命令 surface 曾没有完整列出这些入口，容易让后续 agent 误以为：

- reopen 只能靠手工改 `tasks.md`。
- review 完成仍通过旧 `check-verify-ready` 作为主入口。

### 为什么这是问题

SuperSpec 的流程安全很依赖“显式命令 surface”。文档漏列命令时，后续 skill 或实现者可能绕过正确 gate，转而使用旧别名或手工状态变更。

### 当前处理

`SPEC.md` 已补齐命令列表，明确：

- `check-task-reopen --change <c> --task-id <t>`
- `check-review-complete --change <c>`

测试中已有命令 surface 覆盖，包括：

- `command surface includes check-task-reopen`
- `command surface keeps check-verify-ready compatibility alias`

### 后续要求

新增 guard 命令时，必须同步：

- `cli_args.ts`
- `SPEC.md` command surface
- command surface smoke test
- 对应 user-visible skill 或明确说明该命令仅内部使用

## 29. GPG-028：`state_freshness` 文档曾误描述可推进的 `stale` 持久态

### 优先级

低风险，已文档对齐。

### 发生位置

- `docs/SPEC.md`
- `scripts/superspec/src/state.ts`
- `scripts/superspec/tests/test_superspec_guard.test.ts`

### 原始缺口

早期文档容易让读者理解为 `state_freshness` 可能持久化：

- `fresh`
- `stale`
- `recomputed`

但当前实现实际只持久化：

- `fresh`
- `recomputed`

过期状态通过 block reason 表达：

- `state_fingerprint_stale`

### 为什么这是问题

如果把 `stale` 当成一种可持久化、可继续推进的状态，后续 agent 可能尝试在状态文件里“承认 stale 但继续走流程”。这会削弱 Sync Guard 的核心承诺：指纹失配必须 fail-closed。

### 当前处理

`SPEC.md` 已明确：

- `state_freshness` 只持久化 `fresh | recomputed`。
- 指纹过期以 `state_fingerprint_stale` block reason 表达。
- 重算写入后才可标为 `recomputed`。

现有测试覆盖：

- `state fingerprint stale blocks after evidence change`
- `dispatch recompute writes state`

### 后续要求

不要新增 `state_freshness:"stale"` 作为持久化状态。若未来需要展示 stale，只能作为派生 UI/diagnostic 信息，不能作为 guard 可推进状态。

## 30. GPG-029：普通 check 与 `check-archive-ready` 的锁/事务边界描述不一致

### 优先级

中风险，已文档对齐。

### 发生位置

- `docs/SPEC.md`
- `scripts/superspec/src/core.ts`
- `scripts/superspec/src/state.ts`
- `scripts/superspec/src/archive.ts`

### 原始缺口

文档曾把所有 `check-*` 都描述成同一种锁内判定模型，容易混淆当前实现的两个路径：

1. 普通 `check-*`：先现场判定，再通过 CAS 在 `superspec-state.lock` 内写 state/ledger。
2. `check-archive-ready`：因为会 materialize preservation manifest/bundle，必须在锁内重新读取 status/evidence/tasks/config、重新判定，并在同一事务里提交 state/ledger/preservation。

### 为什么这是问题

如果把普通 check 的 CAS 写入和 archive-ready 的 preservation 事务混为一谈，后续实现可能：

- 给普通 check 引入不必要的锁内重算复杂度。
- 或更危险地，把 archive preservation 又移回锁外，重新引入已修复的并发窗口。

### 当前处理

`SPEC.md` 已拆开描述：

- 普通 check 判定后 CAS 写 state/ledger。
- `check-archive-ready` 在锁内重读、重判、写 preservation bundle，并最终提交 state/ledger。

现有测试覆盖：

- `concurrent check archive ready dispatches converge on coherent preservation artifacts`
- `archive ready blocks and restores state snapshot when state write CAS fails`
- `archive ready state write failure without previous preservation removes promoted artifacts`

### 后续要求

不得把 `check-archive-ready` 的 preservation materialization 移出 `superspec-state.lock` 保护的事务边界。

## 31. GPG-030：OpenSpec floor route 文档曾高估 blocked review/archive 的有效路由

### 优先级

低风险，已文档对齐。

### 发生位置

- `docs/SPEC.md`
- `scripts/superspec/src/openspec.ts`
- `scripts/superspec/src/core.ts`
- `scripts/superspec/tests/test_superspec_guard.test.ts`

### 原始缺口

文档曾容易让读者以为 tasks done 后，route floor 会自然进入：

- `review`
- `archive`

但当前 v1 的 OpenSpec floor derivation 只从原生 OpenSpec artifact facts 推导到 `apply`。当 review/archive 仍 blocked 时，`guard_route_phase` 会保守夹回 `apply`；只有对应 gate allow 后，有效路由才进入 `review` 或 `archive`。

### 为什么这是问题

如果文档把 blocked review/archive 描述成有效路由，agent 可能误以为：

- review block 后仍可以处于 review 路由继续推进。
- archive block 后可以跳过 apply/review 修复路线。

这会让 `next_allowed_actions` 与 route phase 产生误导。

### 当前处理

`SPEC.md` 已明确：

- `openspec_minimum` 不满足时 route phase 只能下调，不能上调。
- blocked review/archive 保守夹回 `apply`。
- `review` / `archive` 作为有效路由只在对应 gate allow 后写入。

现有测试覆盖：

- `dispatch clamps blocked route to openspec floor`

### 后续要求

后续若要让 floor route 更细分到 review/archive，必须先让 route derivation 能证明对应 SuperSpec gate 已 allow，不能只看 OpenSpec artifacts done。

## 32. GPG-031：archive skill/spec 对 `--skip-specs` / validate 口径不够硬

### 优先级

中风险，已文档对齐。

### 发生位置

- `.codex/skills/superspec-archive/SKILL.md`
- `docs/SPEC.md`
- `scripts/superspec/tests/test_superspec_skills.test.ts`

### 原始缺口

早期 archive 口径留下过“是否跳过 spec sync”的选择空间。当前验证后的 v1 设计不应暴露这个分支：

- archive 固定使用 `openspec archive -y "<change>"`。
- 依赖 OpenSpec 原生 delta -> main spec sync 和 validate。
- 不暴露 `--skip-specs`。
- 不允许 `--no-validate`。

如果某个 change 不应同步 specs，应回到 propose/change update 调整 OpenSpec 包，而不是在 archive 阶段跳过。

### 为什么这是问题

archive 是不可逆性最强的阶段。给 archive skill 暴露 `--skip-specs` 会让 agent 在最后一步绕过 OpenSpec 的主规格同步语义，造成：

- change 已 archive，但 main specs 未同步。
- SuperSpec preservation 证明存在，但 OpenSpec canonical specs 不一致。
- 后续审计难以判断偏差是有意接受还是流程绕过。

### 当前处理

`SPEC.md` 和 `superspec-archive` skill 已明确：

- 固定 `openspec archive -y "<change>"`。
- 不询问也不使用 `--skip-specs`。
- 不允许 `--no-validate`。
- repo-local `openspec-archive-change` 的手工 `mkdir`/`mv` 流程只可参考 guardrails，不能替代 native archive CLI。

skill smoke test 已覆盖：

- `openspec archive -y`
- `--no-validate`
- native archive handoff 文案

### 后续要求

如未来确实需要“archive 但不同步 specs”的模式，必须作为新的 change/update 流程设计，不得直接在 `superspec-archive` 中加 `--skip-specs` 快捷分支。

## 33. GPG-032：proposal 缺轻量 `critic` advisory review，但不应升级成重 guard gate

### 优先级

中风险，已修复。

### 发生位置

- `.codex/skills/superspec-propose/SKILL.md`
- `docs/SPEC.md`
- `scripts/superspec/tests/test_superspec_skills.test.ts`

### 原始缺口

proposal 曾只依赖：

- `superspec-explore` 的 discovery / critic evidence
- 后续 design/tasks 的人审确认

这能避免流程过重，但也留下一个实际质量缺口：`proposal.md` 是 WHY/WHAT 和 scope/non-goals 的第一份 OpenSpec planning artifact，如果没有独立 `critic` 看一眼，scope 收窄、隐性假设或 non-goals 漏写可能被带到 specs/design。

### 为什么这是问题

这不是 v1 guard proof gap，而是 workflow advisory proof gap：

- proposal 不需要独立 human confirmation。
- proposal 不需要新 state/command/gate。
- 但 proposal 仍需要一个低成本对抗视角，防止后续 artifacts 建在错误 scope 上。

### 当前处理

`superspec-propose` 现在要求：

- `proposal.md` 由 `openspec instructions proposal --change "<change>" --json` 产出并经 `openspec status` 确认为 `done`。
- 随后启动 `critic` native-subagent 做 advisory review。
- advisory 范围限定为 scope / intent / non-goals / hidden assumptions。
- 若存在 blocker，主线程重新通过 `openspec instructions proposal` 取约束并修订 proposal，再重跑 advisory review。
- 非阻塞建议进入 specs/design/tasks/discovery handoff。
- 不调用 `check-enter`，不新增 guard gate/state route/command/human confirmation pause。

`SPEC.md` 已同步角色矩阵、§11.4 propose overlay、§14 人审阻塞点。

skill smoke test 已锁定：

- `critic`
- `advisory`
- `不新增 guard gate`

### 后续要求

不要把 proposal advisory review 扩成硬 gate，除非后续明确设计新的 guard state 和恢复路径。当前 v1 选择是轻量审查，不是流程管控。

## 34. GPG-033：已知测试覆盖缺口曾未集中列出

### 优先级

低风险，已记录；仍建议补测试。

### 发生位置

- `docs/SPEC.md`
- `scripts/superspec/tests/*`

### 原始缺口

测试套件已经覆盖大量主路径和 block path，但仍存在一些已知回归边界。早期规范没有把这些缺口集中列出来，容易造成两种误判：

- 看到 `npm test` 全绿就误以为所有 guard proof gaps 都已关闭。
- 后续扩展时不知道哪些边界只是“当前没测”，而不是“设计上允许”。

### 当前处理

`SPEC.md` 已新增 `17.1 已知测试覆盖缺口`，集中记录当前仍建议补齐的测试边界：

- 禁用配置/状态别名覆盖全量黑名单，而不是只抽样。
- `check-archived` manifest 存在但内容/sha 不匹配的负例。
- `dispatch` 证明调用方无法通过伪造 status 影响判定。
- skill smoke 负向断言：不能在保留 `openspec instructions` 文案的同时新增徒手 Write/update OpenSpec artifact 的步骤。

### 后续要求

这些是 test backlog，不是当前 allow/block 语义的放行依据。补测试时应优先写成 focused guard/skill smoke tests，避免把测试套件变成新的文档解释层。

## 35. 本轮修复验证结论

本轮针对 GPG-011 至 GPG-018，以及 GPG-020 至 GPG-025 的实现修复，已完成以下验证：

- `cd scripts/superspec && npm run typecheck` 通过。
- `cd scripts/superspec && npm test` 通过，`180/180`。
- fresh `critic` 对抗复审：`VERDICT: OKAY`。
- fresh `code-reviewer` 复审：`VERDICT: OKAY`。

本轮针对 GPG-027 至 GPG-033 的文档/skill 对齐，已完成以下验证：

- `cd scripts/superspec && npm run typecheck` 通过。
- `cd scripts/superspec && npm test` 通过，`180/180`。
- skill smoke 已覆盖 proposal `critic` advisory 且 `不新增 guard gate`。

## 36. 建议修复顺序

建议按证明力风险排序：

1. 修 GPG-008：`task_reopen` lifecycle 不能被普通 supersede 隐藏。
2. 修 GPG-009：`review_ready` 必须全局校验 reopen lifecycle，task 被删除/替换时 fail-closed。
3. 修 GPG-001：RED/GREEN evidence 必须绑定正确 gate。
4. 修 GPG-002：每个 declared `TEST-*` 必须有对应 RED/GREEN 或明确例外。
5. 修 GPG-003：final invariant matrix 必须覆盖所有 hard invariant。
6. 修 GPG-010：同一 task resolved 多 reopen history 必须按 v1 block。
7. 修 GPG-004：拆分 automated / review / human invariant 的兑现路径。
8. 修 GPG-006：明确 post-implementation invariant 的引用和计入策略。
9. 修 GPG-007：清理历史文档误导。
10. GPG-005 暂作为已覆盖回归项维护。
11. GPG-019 作为未来扩展观察项维护；当前不阻断。
12. GPG-026 作为 review workflow 观察项维护；当前不阻断。
13. GPG-027 至 GPG-032 已通过文档/skill/smoke 对齐，作为防回归项维护。
14. GPG-033 按 `SPEC.md` §17.1 逐项补测试；当前不阻断，但不应遗忘。

## 37. 最小回归测试清单

建议新增以下 guard 单元测试：

| 测试名建议 | 预期 |
| --- | --- |
| `task reopen cannot be closed by generic superseded evidence` | block |
| `review ready blocks resolved reopen when task was removed from tasks` | block |
| `review ready blocks resolved reopen with nonexistent successor evidence` | block |
| `resolved reopen requires current task hash to match restored tasks md` | block |
| `resolved reopen rejects multiple reopen histories for same task in v1` | block |
| `task edit rejects red evidence from wrong gate` | block |
| `task complete rejects green evidence from wrong gate` | block |
| `task complete requires green for every declared test ref` | block |
| `task complete allows when every declared test ref has green` | allow |
| `review ready propagates missing declared test evidence` | block |
| `review complete rejects empty invariant matrix` | block |
| `review complete rejects invariant matrix missing hard invariant` | block |
| `test contract drafted allows human confirmation invariant outside TEST matrix when human evidence exists` | allow |
| `test contract drafted blocks automated hard invariant outside TEST matrix` | block |
| `post implementation invariant cannot satisfy original red green contract` | block |
| `command surface documents task reopen and review complete` | pass |
| `state freshness never persists stale as an advanceable state` | pass |
| `archive skill does not expose skip specs or no validate branches` | pass |
| `propose skill keeps proposal critic advisory outside guard gates` | pass |
| `skill smoke rejects hand-written OpenSpec artifact steps without instructions` | block |

## 38. 修复后的目标证明

修复完成后，SuperSpec guard 应能证明：

1. `task_reopen` lifecycle 只能由合法 `task_reopen_resolved` 关闭，不能被普通 supersede 隐藏。
2. reopened task 即使从 `tasks.md` 中被删除或替换，也会在 `review_ready` fail-closed。
3. 同一 task 在 v1 中只有一条 reopen history。
4. RED/GREEN 证据来自正确 gate。
5. 每个 task 声明的 `TEST-*` 都被逐项兑现。
6. 每个 `TEST-*` 对应的 `INV-*` 映射被逐项兑现。
7. 每个 hard invariant 都进入最终 verification matrix。
8. 人审型 hard invariant 通过 review/human evidence 兑现，而不是被强迫伪装成 automated test。
9. late-added invariant 不会 retroactively 满足原始 apply gate。
10. 历史文档不会误导未来实现者偏离 `SPEC.md`。
11. `.superspec` evidence / raw / archive preservation 枚举不会通过 symlink 或 hardlink alias 逃逸 change root。
12. `request_changes(reopen_tasks)` 只有在主线程完整裁决 required loads、claims 和 blocking findings 后，才能授权 task reopen。
13. archive preservation 的 manifest/bundle 与 state/ledger 处于同一 fail-closed 事务；失败时不会发布 allowed state，也不会残留本次失败 promote 的正式产物。
14. archive readback 只能接受身份匹配、kind 匹配、entries 非空、path 安全且包含最低 preservation surface 的 manifest。
15. block 后的 `next_allowed_actions` 由真实 `block_reasons.code` 派生，不给无关修复建议。
16. `file_overrides` 当前只作为固定内部 override 使用；未来扩展前需要补 key 级安全校验。
17. `request_changes(reopen_tasks)` 的 review route authorization 只消费本轮 live/pass code-reviewer `source_guidance.blocking_findings[*].affected_task_ids`，不要求 subagent 提供完整 `task_reopen` lifecycle payload。
18. allow path 的 `source_evidence_refs` / `verification_evidence_refs` 只能指向本轮 live/pass 且 kind 正确的 proof evidence，不接受 unknown、non-live、wrong-kind ref。
19. schema-invalid `request_changes` 或 schema-invalid review `source_guidance` 不会产生 apply/propose handoff action。
20. `task_reopen` apply side 只能使用本轮 `review_complete` 的 main adjudication 和 code-reviewer source guidance 授权 reopen，不能复用旧 gate / 错 gate evidence。
21. 未跟踪文件参与审查时，review 必须直接读取磁盘内容或显式处理 untracked diff，不能只依赖普通 `git diff`。
22. guard command surface、SPEC 和 skill smoke 对 `check-task-reopen` / `check-review-complete` 保持一致。
23. `state_freshness` 只表达 `fresh | recomputed`；过期状态只能通过 `state_fingerprint_stale` block reason 表达。
24. 普通 check 的 CAS 写入与 `check-archive-ready` 的锁内 preservation 事务边界不再混淆。
25. blocked review/archive 的 route phase 保守夹回 OpenSpec floor，不把 blocked 阶段伪装成可推进 route。
26. archive v1 固定走 `openspec archive -y`，不暴露 `--skip-specs` / `--no-validate`。
27. proposal 由 `critic` 做 advisory 复核，但不新增 guard gate/state/command/human confirmation。
28. 已知测试覆盖缺口集中记录，后续补测不再依赖口头记忆。
