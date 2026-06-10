# SuperSpec 双轨同步改造方案

> Historical note: 本文是早期 refactor 草案，保留用于设计取舍追溯。当前实现规范以 `docs/proposals/superspec/SPEC.md` 为准。本文中把 `test-contract.md` 作为 OpenSpec 自定义 artifact 的方案已经被 v0.4 sidecar overlay 方案取代，请勿按本文实现。

## 0. 文档状态

本文是历史改造方案，不覆盖、不修改 `docs/proposals/superspec/DESIGN.md`，也不再作为当前实现依据。当前实现、修改和审查必须以 `docs/proposals/superspec/SPEC.md` 为准。

历史状态：

```text
本文曾作为 SuperSpec 改造实施方案。
当前不再作为实施依据；实现和修改必须以 SPEC.md 为准。
本文仅用于追溯旧设计取舍。
```

当前已知冲突：

- `DESIGN.md` 倾向把 `review.md` / `verification.md` 放入 OpenSpec artifact graph。
- 本文要求 `review` / `verification` 固定为 post-apply evidence gates，不作为普通 pre-apply OpenSpec artifact。
- `DESIGN.md` 倾向零平行状态机。
- 本文要求引入受 OpenSpec 同步约束的 `guard_route_phase`。

历史风险：若脱离顶部 historical note 阅读本文，执行者可能按旧“零状态”或旧 review/verification artifact graph 理解早期方案；当前不得据此覆盖 `SPEC.md`。

目标：把现有 `yourflow` 与 `workflow` 的经验收敛成一套基于 OpenSpec 的增强工作流。它不是替代 OpenSpec，也不是把全部流程控制无条件交给 OpenSpec，而是建立一个受同步约束的双轨模型：

```text
OpenSpec 正本轨：负责最小规范生命周期和阶段顺序
SuperSpec 控制轨：负责增强状态、质量门禁、证据链、subagent 审查和 TDD 纪律
Sync Guard：每次推进时同时读取 OpenSpec status、SuperSpec state 与 evidence，任一不满足就阻塞
```

核心原则：

```text
SuperSpec 可以比 OpenSpec 多，但不能比 OpenSpec 少。
```

关键修正：

```text
引入状态没问题，问题是状态必须受 OpenSpec 约束。
OpenSpec 是正本 artifact 状态来源。
SuperSpec 可以保存 guard-owned control state，但不能保存自说自话的 OpenSpec artifact 状态。
```

## 1. 背景判断

### 1.1 完全交给 OpenSpec 的问题

OpenSpec 能管理 artifact 顺序、依赖和最小生命周期，但它不负责判断：

- 设计是否经过 architect/critic/test-engineer 的真实审查。
- RED 测试是否按预期原因失败。
- GREEN 是否覆盖了对应 task。
- subagent 输出是否真实存在且可追溯。
- post-apply code review、final verification、archive preservation 是否完成。

所以只依赖 OpenSpec，增强流程会失去质量控制权。

### 1.2 完全自建状态机的问题

`.yourflow/state.json.current_phase` 或 `.ai-workflow/gate-ledger.current.stage` 这类 sidecar 状态容易和 `openspec status` 漂移。

已观察到的典型失败模式：

```text
sidecar 自称进入 design / apply
但 OpenSpec 正本 design.md 或 tasks.md 仍缺失
openspec status 仍显示 blocked
```

所以 SuperSpec 不能再维护不受 OpenSpec 约束的平行阶段状态机。

状态本身不是问题。没有状态会让恢复、暂停点、用户决策、task 会话和 review disposition 难以管理。真正的问题是：

```text
状态能否被 OpenSpec status 和 evidence 重新校验。
```

能被重新校验、只能由 guard 写入的状态，是控制工具。
不能被重新校验、可以覆盖 OpenSpec 事实的状态，是漂移来源。

### 1.3 最终模型

最终模型是：

```text
OpenSpec 正本阶段 + SuperSpec guard-owned control state + append-only evidence + Sync Guard
```

其中：

- OpenSpec 决定正本 artifact 是否 ready/done/blocked。
- SuperSpec state 记录增强流程控制事实，例如 guard route phase、active gate、pause point、task session、review disposition。
- SuperSpec evidence 证明增强 gate 是否满足。
- Sync Guard 每次现场读取 OpenSpec status、SuperSpec state 和 evidence，计算 `allowed/block`。
- 没有任何 SuperSpec state 字段可以覆盖 OpenSpec status。

## 2. 不变量

这些规则必须写进实现、测试和技能提示词。

### 2.1 OpenSpec 不变量

1. OpenSpec 是唯一正本 artifact 状态来源。
2. OpenSpec 正本 artifact 必须位于 `openspec/changes/<change>/` 下。
3. SuperSpec 不允许伪造、覆盖或回写 OpenSpec artifact 状态。
4. Sync Guard 必须自己执行 `openspec status --change <change> --json`。
5. 调用方传入的 OpenSpec status 快照只能作为 debug 信息，不能作为判定输入。

### 2.2 SuperSpec 不变量

1. `.superspec/` 可以保存 state、evidence、handoff、report、raw logs。
2. `.superspec/state.json` 只能由 Sync Guard 写入。
3. `.superspec/state.json` 必须带 OpenSpec status 指纹和 evidence 指纹。
4. `.superspec/state.json` 中的 `guard_route_phase` / active gate / next action 只是受控流程状态，不是 OpenSpec artifact 状态。
5. `.superspec/` 不声明 OpenSpec artifact done。
6. `.superspec/` evidence 可以证明增强 gate 通过，但不能替代 OpenSpec artifact。

禁止在 evidence/ledger 中出现的字段：

```text
current
current_phase
current_stage
stage
stage_order
allowed_next
completed_phases
openspec_artifact_done
artifact_status
```

`state.json` 中允许出现受控字段：

```text
guard_route_phase
phase_floor
active_gate
pause_point
last_guard_decision
last_block_reasons
recovery_bookmark
task_sessions
review_dispositions
computed_from
openspec_status_fingerprint
evidence_fingerprint
state_freshness
```

允许 evidence 字段：

```text
evidence_id
change_id
kind
gate
task_id
test_id
created_at
created_by
refs
status
summary
```

### 2.3 同步不变量

有效推进结果永远是：

```text
effective_allowed = OpenSpec minimum satisfied AND SuperSpec extra gates satisfied
```

示例：

| OpenSpec status | SuperSpec evidence | effective |
|---|---|---|
| `design.md` missing | design review pass | block |
| `tasks.md` done | task graph evidence missing | block |
| `applyRequires` done | RED evidence missing | block |
| all artifacts done | code review blocked | block |
| all artifacts done | all SuperSpec gates pass | allow |

## 3. 总体架构

```text
┌────────────────────────────────────────────────────────────┐
│ L1 OpenSpec Canonical Track                                │
│ proposal.md -> specs/**/spec.md -> design.md               │
│ -> test-contract.md -> tasks.md -> archive                 │
│ source of truth: openspec status --json                    │
└────────────────────────────────────────────────────────────┘
                         │
                         │ read-only status
                         ▼
┌────────────────────────────────────────────────────────────┐
│ L2 SuperSpec Evidence Track                                  │
│ guard-owned state / append-only evidence / red-green         │
│ active gate is control state, OpenSpec artifacts stay canon  │
└────────────────────────────────────────────────────────────┘
                         │
                         │ synchronized decision
                         ▼
┌────────────────────────────────────────────────────────────┐
│ L3 Sync Guard                                              │
│ compute allow/block from OpenSpec status + evidence matrix  │
└────────────────────────────────────────────────────────────┘
```

## 4. OpenSpec 正本轨

### 4.1 正本 artifact

SuperSpec v1 固定使用以下 OpenSpec artifact：

```text
openspec/changes/<change>/proposal.md
openspec/changes/<change>/specs/**/spec.md
openspec/changes/<change>/design.md
openspec/changes/<change>/test-contract.md
openspec/changes/<change>/tasks.md
```

`test-contract.md` 必须是 OpenSpec 自定义 artifact，而不是 sidecar 替代品。

`.superspec/evidence/` 可以保存覆盖矩阵、评审输出和测试日志，但不能替代 `test-contract.md`。

### 4.2 正本顺序

推荐 OpenSpec schema 顺序：

```text
proposal + specs -> design -> test-contract -> tasks -> apply -> archive
```

约束：

- `design` requires `proposal` and `specs`。
- `test-contract` requires `design`。
- `tasks` requires `specs`, `design`, and `test-contract`。
- `apply` requires `tasks`。
- `archive` requires OpenSpec archive 条件和 SuperSpec `archive_ready` gate。

注意：如果当前 OpenSpec 版本对 custom artifact 的 archive gate 支持有限，archive gate 仍由 Sync Guard 控制；不能把 post-apply gate 伪装成 pre-apply artifact。

### 4.3 post-apply gate 不进入 OpenSpec pre-apply artifact graph

以下内容不作为普通 OpenSpec pre-apply artifact：

```text
review
verification
archive-preservation
```

原因：

- 它们依赖实现后的代码 diff、测试结果、task checkbox 和审查结论。
- OpenSpec artifact graph 主要根据 artifact 依赖和文件状态推进，不能天然表达“实现完成后才允许 review pass”。

这些 gate 固定保存在：

```text
openspec/changes/<change>/.superspec/evidence/reviews/
openspec/changes/<change>/.superspec/evidence/verification/
openspec/changes/<change>/.superspec/evidence/archive/
```

## 5. SuperSpec evidence 轨

### 5.1 目录结构

```text
openspec/changes/<change>/.superspec/
  state.json
  ledger.jsonl
  evidence/
    discovery/
    design/
    test-contract/
    tasks/
    red/
    green/
    reviews/
    verification/
    archive/
  handoffs/
  reports/
  raw/
```

`state.json` 是 guard-owned control state，用于恢复、路由和暂停点管理。

`ledger.jsonl` 是 append-only 索引，不是状态机。

每一行只能引用一条 evidence：

```json
{"event_id":"EVT-001","change_id":"example-change","evidence_id":"EV-red-001","kind":"evidence_recorded","created_at":"2026-06-07T00:00:00Z"}
```

禁止在 `ledger.jsonl` 中写入：

```json
{"current_stage":"superspec-apply"}
```

### 5.2 state.json schema

`state.json` 可以存在，但必须满足：

- 只能由 Sync Guard 写入。
- 每次写入都必须重新读取 OpenSpec status。
- 每次写入都必须记录 OpenSpec status 指纹。
- 状态失配时只能标记 stale/block，不能继续放行。
- 任何 skill 或 agent 不能手写 state transition。

推荐结构：

```json
{
  "schema_version": 1,
  "change_id": "example-change",
  "guard_version": "superspec-guard@1",
  "updated_at": "2026-06-07T00:00:00Z",
  "openspec": {
    "status_fingerprint": "sha256-of-openspec-status-and-artifact-paths",
    "phase_floor": "tasks",
    "status_summary": {
      "proposal": "done",
      "specs": "done",
      "design": "done",
      "test-contract": "done",
      "tasks": "done"
    }
  },
  "superspec": {
    "guard_route_phase": "apply",
    "active_gate": "task_edit",
    "pause_point": null,
    "state_freshness": "fresh",
    "last_guard_decision": "block",
    "last_block_reasons": ["missing_red_evidence"],
    "recovery_bookmark": {
      "task_id": "TASK-001",
      "next_command": "superspec_guard check-task-edit --change example-change --task-id TASK-001"
    }
  },
  "computed_from": {
    "openspec_status_command": "openspec status --change example-change --json",
    "openspec_status_fingerprint": "sha256-of-openspec-status-and-artifact-paths",
    "evidence_fingerprint": "sha256-of-evidence-index",
    "tasks_fingerprint": "sha256-of-tasks-md",
    "test_contract_fingerprint": "sha256-of-test-contract-md"
  },
  "fingerprints": {
    "evidence_fingerprint": "sha256-of-evidence-index",
    "tasks_fingerprint": "sha256-of-tasks-md"
  }
}
```

字段语义：

- `guard_route_phase` 是 SuperSpec 路由/恢复阶段，不是 OpenSpec artifact phase。
- `active_gate` 是 SuperSpec 当前门禁，不是 OpenSpec 阶段。
- `phase_floor` 是当前 SuperSpec phase 允许依赖的最低 OpenSpec 正本 artifact 状态。
- `status_summary` 是最近一次 OpenSpec status 的镜像摘要，不能作为最终判定输入。
- `status_fingerprint` 用于检测缓存是否过期。
- `computed_from` 记录本次 state 由哪些 canonical inputs 计算得出。
- `state_freshness=stale` 时，所有推进命令必须先 recompute。
- `recovery_bookmark` 只能用于恢复提示，不能绕过 guard。

命名规则：

- 禁止使用 `phase` 表示 OpenSpec artifact 状态。
- 如果实现中保留短名 `phase`，必须等价于 `guard_route_phase`，并在 schema 注释中声明 `phase != OpenSpec artifact phase`。
- `guard_route_phase` 不能作为 done source；只能作为 command routing / recovery source。

推荐 `guard_route_phase` 枚举：

```text
start
explore
design
test-contract
tasks
apply
review
verify
archive-ready
archived
```

Phase floor 映射：

| guard_route_phase | OpenSpec minimum |
|---|---|
| `start` | change root exists |
| `explore` | `proposal` + `specs` ready/done |
| `design` | `proposal` + `specs` done |
| `test-contract` | `design` done |
| `tasks` | `test-contract` done |
| `apply` | `tasks` done |
| `review` | `tasks` done and all task evidence complete |
| `verify` | review gate complete |
| `archive-ready` | verify gate complete + `openspec validate` pass |
| `archived` | OpenSpec archive observed |

If OpenSpec minimum is not satisfied, Guard must block and lower/stale the route phase instead of advancing.

状态写入规则：

```text
read openspec status
read state.json if exists
read ledger/evidence/tasks
compute effective decision
if source fingerprints mismatch -> mark stale/block
if guard decision allow/block is final -> write state.json atomically
append transition/evidence event to ledger.jsonl
```

原子写和并发规则：

```text
acquire .superspec/state.lock
read current state and fingerprints
read OpenSpec status from CLI
read evidence/tasks/test-contract
compare-and-swap expected fingerprints
write state.tmp
fsync state.tmp where available
rename state.tmp -> state.json
append ledger event
release lock
```

If lock acquisition fails or fingerprints change during transition, Guard must block with `state_concurrent_update` and ask caller to recompute.

### 5.3 evidence 基础 schema

所有 evidence 必须具备最小字段：

```json
{
  "schema_version": 1,
  "evidence_id": "EV-001",
  "change_id": "example-change",
  "gate": "design_review",
  "kind": "subagent_report",
  "created_at": "2026-06-07T00:00:00Z",
  "created_by": "agent-or-user",
  "status": "pass",
  "summary": "short summary",
  "refs": []
}
```

字段规则：

- `change_id` 必须等于目录 change id。
- `status` 只能是 `pass`, `fail`, `blocked`, `superseded`。
- `refs` 必须是相对 change root 的路径。
- evidence 文件必须位于 `.superspec/` 内。
- raw log 可以放在 `.superspec/raw/`，由 evidence 引用。

### 5.4 path/ref 安全规则

Sync Guard 必须校验：

- 禁止绝对路径。
- 禁止 `..` path traversal。
- 禁止 symlink 跳出 change root。
- OpenSpec artifact ref 必须匹配 `openspec status` 返回的 artifact 路径。
- sidecar evidence ref 必须位于 `openspec/changes/<change>/.superspec/` 内。
- `subagent:critic` 这类简写不能单独作为 pass evidence，必须有 `prompt_ref` 和 `output_ref`。

Canonicalization 顺序：

1. 以 change root 为基准解析相对路径。
2. lexical normalize，拒绝包含 `..` 的结果。
3. resolve realpath。
4. 确认 realpath 仍位于 change root 内。
5. 如果是 OpenSpec artifact ref，确认 realpath 等于 `openspec status` 中对应 artifact path。
6. 如果是 evidence/raw/handoff ref，确认 realpath 位于 `.superspec/` 内。
7. 任一步失败都 block。

## 6. Sync Guard

### 6.1 职责

Sync Guard 是唯一状态写入器和唯一放行器。

它允许：

- 读取 OpenSpec status。
- 读取 OpenSpec instructions。
- 读取和写入 `.superspec/state.json`。
- append `.superspec/ledger.jsonl`。
- 读取 `.superspec/` evidence。
- 校验 schema、路径、时间顺序、task/evidence 映射。
- 输出 `allow/block`。

它禁止：

- 写业务代码。
- 生成 OpenSpec artifact。
- 修改 `tasks.md` checkbox。
- 移动 archive 目录。
- 把 sidecar 状态写回 OpenSpec。
- 让 state 覆盖 OpenSpec status。
- 接受 skill/agent 手写的 state transition。

### 6.2 输入来源

Guard 必须自己执行：

```bash
openspec status --change <change> --json
```

必要时执行：

```bash
openspec instructions <artifact> --change <change> --json
openspec validate <change>
```

Guard 读取：

```text
openspec/changes/<change>/.superspec/state.json
openspec/changes/<change>/.superspec/ledger.jsonl
openspec/changes/<change>/.superspec/evidence/**
openspec/changes/<change>/.superspec/handoffs/**
openspec/changes/<change>/tasks.md
```

### 6.3 命令接口

推荐命令：

```bash
superspec_guard status --change <change>
superspec_guard recompute --change <change>
superspec_guard check-enter --change <change> --gate <gate>
superspec_guard check-artifact --change <change> --artifact <artifact>
superspec_guard check-task-edit --change <change> --task-id <task-id>
superspec_guard check-task-complete --change <change> --task-id <task-id>
superspec_guard check-review-ready --change <change>
superspec_guard check-verify-ready --change <change>
superspec_guard check-archive-ready --change <change>
superspec_guard check-archived --change <change>
```

单个 `--stage` 不足以表达 task-level RED/GREEN，所以 implementation gate 必须按 task 检查。

所有 `check-*` 命令都必须：

1. 重新读取 OpenSpec status。
2. 重新计算 evidence/task 指纹。
3. 对比 `state.json` 中的旧指纹。
4. 指纹失配时先写入 `state_freshness=stale` 并 block 或 recompute。
5. 判定完成后原子写入新的 `state.json`。

### 6.4 判定输出

```json
{
  "allowed": false,
  "decision": "block",
  "change_id": "example-change",
  "gate": "task_edit",
  "task_id": "TASK-001",
  "openspec_status_summary": {},
  "superspec_gate_summary": {},
  "block_reasons": [
    {
      "code": "missing_red_evidence",
      "message": "TASK-001 requires RED evidence before implementation edit",
      "refs": []
    }
  ],
  "next_allowed_actions": [
    "record RED evidence for TASK-001"
  ]
}
```

### 6.5 判定矩阵

| Gate | OpenSpec minimum | SuperSpec evidence required | Typical block codes |
|---|---|---|---|
| `start` | change root exists, schema resolvable | none | `missing_change`, `schema_not_resolved` |
| `explore_complete` | `proposal` done, `specs` done | discovery report, requirement critic report | `missing_proposal`, `missing_specs`, `missing_discovery`, `missing_requirement_critic` |
| `design_enter` | `proposal` done, `specs` done | `explore_complete` evidence pass | `openspec_blocked`, `explore_gate_failed` |
| `design_complete` | `design` done | architect report, critic report, test-engineer review, human confirmation | `missing_design`, `missing_architect_review`, `missing_human_confirmation` |
| `test_contract_enter` | `design` done | `design_complete` evidence pass | `missing_design`, `design_gate_failed` |
| `test_contract_complete` | `test-contract` done | coverage matrix, RED/GREEN contract review, critic report | `missing_test_contract`, `missing_coverage_matrix`, `missing_test_contract_review` |
| `tasks_enter` | `test-contract` done | `test_contract_complete` evidence pass | `missing_test_contract`, `test_contract_gate_failed` |
| `tasks_complete` | `tasks` done | task graph parse valid, requirement/test/task mapping valid, write-scope conflict check pass | `missing_tasks`, `invalid_task_graph`, `write_scope_conflict` |
| `task_edit` | `tasks` done, target task unchecked | task has RED pass or approved no-TDD alternative | `missing_tasks`, `task_already_done`, `missing_red_evidence`, `invalid_no_tdd_reason` |
| `task_complete` | `tasks` done | GREEN pass for task, or alternate verification for non-TDD task | `missing_green_evidence`, `unexpected_green_failure`, `task_evidence_mismatch` |
| `review_ready` | all OpenSpec artifacts done, tasks all checked | all task evidence complete, `openspec validate` pass | `tasks_incomplete`, `validate_failed`, `missing_task_evidence` |
| `review_complete` | review_ready allowed | code-review workflow synthesis pass, `code-reviewer`/`architect` lane evidence pass, independent critic review pass, final verifier/critic evidence, final test evidence, blocking findings disposed, rollback target recorded | `missing_code_review_workflow`, `missing_native_subagent_evidence`, `blocking_findings_open`, `missing_rollback_target`, `missing_final_verifier`, `missing_final_tests` |
| `verify_complete` | compatibility alias for review_complete | recomputes `review_complete`; final verification evidence belongs to review_complete | `review_gate_failed`, `missing_final_verifier`, `scope_drift`, `missing_final_tests` |
| `archive_ready` | OpenSpec artifacts complete, tasks complete, validate pass | verify_complete pass, human confirmation | `missing_final_confirmation`, `verify_gate_failed` |
| `archived` | OpenSpec archive executed and archived change found | `.superspec` preservation evidence | `archive_not_found`, `superspec_not_preserved` |

## 7. Subagent evidence

### 7.1 基础结构

```json
{
  "schema_version": 1,
  "evidence_id": "EV-review-001",
  "change_id": "example-change",
  "gate": "design_complete",
  "kind": "subagent_report",
  "execution_mode": "native_subagent",
  "agent_role": "critic",
  "agent_id": "019ea28f-e3d0-72e1-abd3-b527dd74ba0c",
  "prompt_ref": ".superspec/evidence/design/EV-review-001.prompt.md",
  "output_ref": ".superspec/evidence/design/EV-review-001.output.md",
  "source_anchors": [
    {
      "path": "design.md",
      "line": 42
    }
  ],
  "status": "pass",
  "confidence": "medium",
  "findings": []
}
```

规则：

- `execution_mode` 必须是 `native_subagent`。
- 主线程自评不能作为 critic/review/final verifier gate evidence。
- subagent evidence 必须有 `agent_id`、`prompt_ref`、`output_ref`。
- `output_ref` 必须可读。
- `source_anchors` 必须指向 OpenSpec artifact 或实际代码文件。
- subagent 不可用时 gate 必须 block，不能降级为主线程审查。

### 7.2 角色矩阵

| Gate | 必须角色 | 说明 |
|---|---|---|
| explore | `critic` | 主线程负责事实调查，critic 负责需求边界对抗审查 |
| design | `architect`, `critic`, `test-engineer` | 架构、风险、可测性并行审查 |
| test-contract | `test-engineer`, `critic` | 覆盖矩阵和红绿契约审查 |
| tasks | `critic` | 主线程负责模块触点/依赖事实核对，critic 负责并行写冲突与边界风险审查 |
| apply | — | 主线程按 test-contract 和任务触点选择/运行测试；可选 test-engineer 诊断不作为硬 gate |
| review | `code-reviewer`, `architect`, `critic`, `verifier` | `code-reviewer`/`architect` 组成内联 code-review workflow lane；独立 `critic` 审查 SuperSpec scope/evidence；`verifier` 和最终 `critic` 复核 completion evidence、final tests 和 scope drift |
| verify | compatibility alias | 不再是独立 user-visible 阶段；兼容入口必须重新计算 review_complete |

如果要引入 `security-reviewer`，必须先定义该 agent role。未定义前由 `code-reviewer` 覆盖 security findings domain。

## 8. TDD 与 task 映射

### 8.1 tasks.md 格式

`tasks.md` 必须保持 OpenSpec checkbox 可解析，同时增加固定结构块，供 guard 检查。

推荐格式：

```markdown
## 1. Core Implementation

- [ ] TASK-001 Extract duration service
  - requirement_refs: REQ-001, REQ-002
  - test_refs: TEST-001, TEST-002
  - read_scope: path/A.java, path/B.java
  - write_scope: path/C.java
  - dependencies: []
  - parallel_group: PG-001
  - tdd_required: true

- [ ] TASK-002 Update docs
  - requirement_refs: REQ-003
  - test_refs: []
  - write_scope: docs/example.md
  - dependencies: [TASK-001]
  - parallel_group: PG-002
  - tdd_required: false
  - no_tdd_reason: documentation-only
```

`no_tdd_reason` 必须使用固定枚举：

```text
documentation-only
configuration-only
test-only-refactor
mechanical-rename
generated-artifact-only
non-executable-spec-change
```

非枚举值必须 block。任何会改变运行时代码路径、业务规则、数据迁移、权限、外部接口或错误处理的 task，不允许使用 `tdd_required: false`。

### 8.2 RED evidence

```json
{
  "schema_version": 1,
  "evidence_id": "EV-red-001",
  "change_id": "example-change",
  "gate": "task_edit",
  "kind": "test_run",
  "task_id": "TASK-001",
  "test_id": "TEST-001",
  "command": "mvn test -Dtest=ExampleTest",
  "cwd": "project-root",
  "exit_code": 1,
  "status": "pass",
  "semantic_status": "expected_failure",
  "expected_reason": "new behavior not implemented",
  "actual_summary": "assertion failed as expected",
  "raw_log_ref": ".superspec/raw/EV-red-001.log"
}
```

RED pass 的含义不是命令成功，而是失败原因符合预期。

### 8.3 GREEN evidence

```json
{
  "schema_version": 1,
  "evidence_id": "EV-green-001",
  "change_id": "example-change",
  "gate": "task_complete",
  "kind": "test_run",
  "task_id": "TASK-001",
  "test_id": "TEST-001",
  "command": "mvn test -Dtest=ExampleTest",
  "cwd": "project-root",
  "exit_code": 0,
  "status": "pass",
  "semantic_status": "expected_success",
  "actual_summary": "test passed",
  "raw_log_ref": ".superspec/raw/EV-green-001.log"
}
```

### 8.4 Iron Law 执行规则

每个实现型 task：

1. 根据 `tasks.md` 解析 `task_id`、`test_refs`、`write_scope`。
2. 写或确认最小失败测试。
3. 运行 RED，记录 RED evidence。
4. 调用 `superspec_guard check-task-edit --task-id <task>`。
5. guard allow 后，才允许编辑 `write_scope` 内实现代码。
6. 执行最小实现。
7. 运行 GREEN，记录 GREEN evidence。
8. 调用 `superspec_guard check-task-complete --task-id <task>`。
9. guard allow 后，才允许勾选该 task。

规则：

```text
没有对应 RED evidence，不允许 workflow skill 编辑实现代码。
没有对应 GREEN evidence，不允许 workflow skill 勾选 task。
```

外部编辑器或人工直接修改文件无法被 guard 物理阻止，但 workflow 后续推进必须检测并阻塞：

- task 勾选但无 GREEN evidence -> block。
- 代码 diff 涉及 task write_scope 但无 RED evidence -> block。
- evidence 时间早于 task/test-contract 定义 -> block。
- GREEN 引用的 test_id 不在 task `test_refs` 中 -> block。

Diff 检测定义：

```text
base_ref = task_start_ref
head_ref = current_worktree_ref
changed_files = git diff --name-only base_ref...head_ref plus staged/unstaged worktree diff
```

规则：

- `task_start_ref` 在开始 task 前记录到 `.superspec/evidence/tasks/EV-task-start-<task>.json`。
- `current_worktree_ref` 是当前 `HEAD` 加 staged/unstaged diff 的工作区状态描述。
- 如果 `changed_files` 命中 task `write_scope`，必须存在该 task 的 RED evidence。
- 如果 `changed_files` 超出所有 active task `write_scope`，必须 block 为 `scope_drift`。
- 如果一个文件同时属于多个 parallel group 的 write_scope，必须 block 为 `write_scope_conflict`。

## 9. a / Verification evidence

### 9.1 code review evidence

`code-review` 在 SuperSpec 中是内联 workflow gate，不调用全局/独立 skill。workflow synthesis 是 `execution_mode:"workflow"`，但它不能替代 lane proof；必须引用两条结构化 native-subagent lane evidence。

#### Lane evidence: code-reviewer

```json
{
  "schema_version": 1,
  "evidence_id": "EV-code-review-001",
  "change_id": "example-change",
  "gate": "review_complete",
  "kind": "subagent_report",
  "execution_mode": "native_subagent",
  "agent_role": "code-reviewer",
  "agent_id": "subagent-id",
  "base_ref": "task-plan-approved-ref",
  "head_ref": "current-review-ref",
  "reviewed_files": ["src/example/File.java"],
  "blocking_findings": [],
  "non_blocking_findings": [],
  "finding_dispositions": [],
  "rollback_targets": ["src/example/File.java"],
  "rerun_evidence_refs": [".superspec/evidence/green/EV-green-001.json"],
  "prompt_ref": ".superspec/evidence/reviews/EV-code-review-001.prompt.md",
  "output_ref": ".superspec/evidence/reviews/EV-code-review-001.output.md",
  "status": "pass"
}
```

Review gate 通过要求：

- `code-reviewer` 是 native subagent。
- `base_ref` 必须是 tasks/test-contract 批准后、实现开始前的 git ref 或工作区快照 id。
- `head_ref` 必须是 review 时包含全部 staged/unstaged 实现 diff 的快照 id。
- 所有 blocking finding 已关闭或有明确 disposition。
- 有 rollback target。
- review 覆盖本次 diff。
- `architect` lane 使用同等严格的 native-subagent evidence contract，并额外输出 `architectural_status`（`CLEAR` / `WATCH` / `BLOCK`）。

#### Workflow synthesis evidence

```json
{
  "schema_version": 1,
  "evidence_id": "EV-code-review-workflow-001",
  "change_id": "example-change",
  "gate": "review_complete",
  "kind": "workflow_review",
  "workflow": "code-review",
  "execution_mode": "workflow",
  "lane_evidence_refs": {
    "code-reviewer": "EV-code-review-001",
    "architect": "EV-code-review-architect-001"
  },
  "base_ref": "task-plan-approved-ref",
  "head_ref": "current-review-ref",
  "reviewed_files": ["src/example/File.java"],
  "rollback_targets": ["src/example/File.java"],
  "output_ref": ".superspec/evidence/reviews/EV-code-review-workflow-001.output.md",
  "final_verdict": "COMMENT",
  "architectural_status": "WATCH",
  "status": "pass"
}
```

Workflow gate 通过要求：

- `lane_evidence_refs.code-reviewer` 和 `lane_evidence_refs.architect` 必须指向 live/pass evidence id。
- 被引用 lane evidence 必须属于 `gate:"review_complete"` 且 `execution_mode:"native_subagent"`。
- `lane_refs` 如存在，只能作为人类可读报告链接，不能作为 gate proof。
- synthesis 规则：architect `BLOCK` 或 code-reviewer `REQUEST CHANGES` => `REQUEST CHANGES`；architect `WATCH` => `COMMENT`；否则 final follows code-reviewer lane recommendation。

### 9.2 verification evidence

```json
{
  "schema_version": 1,
  "evidence_id": "EV-final-verify-001",
  "change_id": "example-change",
  "gate": "verify_complete",
  "kind": "subagent_report",
  "execution_mode": "native_subagent",
  "agent_role": "verifier",
  "agent_id": "subagent-id",
  "openspec_validate_ref": ".superspec/raw/openspec-validate-final.log",
  "task_matrix_ref": ".superspec/evidence/verification/task-matrix.json",
  "scope_drift_ref": ".superspec/evidence/verification/scope-drift.json",
  "test_evidence_refs": [
    ".superspec/evidence/green/EV-green-001.json"
  ],
  "source_anchors": [
    {
      "path": "tasks.md",
      "line": 12
    }
  ],
  "status": "pass"
}
```

Verification gate 通过要求：

- `openspec validate <change>` 通过。
- OpenSpec tasks 全部完成。
- 所有 implementation task 有 RED/GREEN 或替代验证。
- 无 scope drift。
- verifier 和 critic 均 pass。

## 10. Archive 策略

区分两个状态：

```text
archive_ready: 可以执行 OpenSpec archive
archived: 已执行 archive，并观察到 evidence 保留
```

`archive_ready` 需要：

- OpenSpec artifacts complete。
- OpenSpec tasks complete。
- `openspec validate <change>` pass。
- review_complete pass。
- verify_complete pass。
- final human confirmation pass。

`archived` 需要：

- OpenSpec archive 已执行。
- 定位 archived change root。
- 观察 `.superspec/` 被保留或按规则迁移到 archive 位置。
- 写 preservation evidence。

Archive preservation evidence：

```json
{
  "schema_version": 1,
  "evidence_id": "EV-archive-001",
  "change_id": "example-change",
  "gate": "archived",
  "kind": "archive_preservation",
  "archived_change_path": "openspec/archive/2026-06-07-example-change",
  "superspec_preserved": true,
  "preserved_refs": [
    ".superspec/ledger.jsonl",
    ".superspec/evidence/verification/EV-final-verify-001.json"
  ],
  "status": "pass"
}
```

## 11. 旧流程处理策略

当前 `yourflow` / `workflow` 都还是测试期产物，尚未投入使用，因此不做兼容迁移。

处理原则：

- 不迁移旧 `.yourflow/` 或 `.ai-workflow/` 状态。
- 不把旧流程里的 review、task graph、test contract 自动转为 SuperSpec pass evidence。
- 不保留旧流程的 sidecar current state 语义。
- 不为了兼容旧流程而放宽 SuperSpec guard。

旧流程只允许两种用途：

1. 作为反例 fixture，验证 sidecar 漂移时 Sync Guard 会 block。
2. 作为源码参考，人工复制少量无状态校验逻辑或测试思路。

可参考但必须重写边界：

- RED/GREEN `semantic_status` 思路。
- BLOCKER_DOMAINS。
- rollback target。
- invalidation 概念。
- guard 测试思路。

禁止复用：

- `STAGE_ORDER`
- `current.stage`
- `current_phase`
- `allowed_next`
- mutation transition state
- 任何不经过 Sync Guard、没有 OpenSpec status 指纹校验的 current state 逻辑

退役方式：

```text
build SuperSpec from clean schema
keep old flows only as negative fixtures until SuperSpec E2E passes
then remove or quarantine old yourflow/workflow skills
```

## 12. Comet 借鉴边界

Comet 的长期扩展性来自 phase authority、central transition writer、guard、handoff、recover 和 archive sync。SuperSpec 应借鉴这些控制面，但必须加强同步约束。

可以借鉴：

- phase authority 用于路由和恢复。
- 单一 transition writer。
- 每阶段 entry/exit guard。
- 机器生成 handoff context。
- source hash / fingerprint 防漂移。
- `status` / `recover` 命令给出下一步。
- archive sync 自动化。

不可照搬：

- 不带 OpenSpec status fingerprint 的 phase transition。
- caller-supplied OpenSpec status snapshot。
- phase-first routing 绕过 OpenSpec minimum。
- shell 里用 grep/sed 解析复杂 schema 的实现方式。
- 把 review/verification 伪装成 pre-apply OpenSpec artifact。

SuperSpec 的加强版同步要求：

```text
phase transition = OpenSpec status check + evidence check + fingerprint compare + atomic state write
```

这意味着 phase 可以成为 SuperSpec 流程路由权威，但不能成为 OpenSpec artifact 状态权威。

## 13. 测试计划

### 13.1 Schema tests

- `openspec schema validate superspec`
- `openspec schema which superspec`
- `openspec instructions test-contract --change <fixture> --json`
- custom artifact status smoke test。

### 13.2 Guard unit tests

- OpenSpec artifact missing -> block。
- OpenSpec status 快照由调用方传入 -> ignored。
- `.superspec` evidence missing -> block。
- 两轨都满足 -> allow。
- ledger 含 `current_stage` -> block。
- 非 Sync Guard 写入的 `state.json` -> block 或 mark stale。
- `state.json` 的 OpenSpec status fingerprint 过期 -> mark stale + recompute。
- `guard_route_phase` 领先 OpenSpec minimum -> block。
- `guard_route_phase` 被当作 OpenSpec artifact done source -> block。
- `state.json.active_gate` 与 OpenSpec minimum 冲突 -> block。
- `state.json` 声称 OpenSpec artifact done -> block。
- 非 native_subagent review -> block。
- subagent 缺 `agent_id` / `output_ref` -> block。
- RED unexpected success -> block。
- RED expected failure reason 不匹配 -> block。
- GREEN missing -> block。
- task checkbox without GREEN evidence -> block。
- evidence path traversal -> block。
- OpenSpec artifact ref 不匹配 status artifact path -> block。
- parallel group write scope conflict -> block。
- review blocking finding open -> block。
- archive_ready 不等于 archived。

### 13.3 Integration tests

- `openspec status` 字段变化时 guard 只依赖稳定字段或明确兼容层。
- 删除 `state.json` 后 guard 可从 OpenSpec status + evidence 完整重建状态。
- `guard_route_phase=review` 但 OpenSpec tasks 缺失或未 done -> block。
- 手动篡改 `state.json.active_gate` 后不能绕过 OpenSpec/evidence 判定。
- `test-contract.md` 缺失时 `tasks_enter` block。
- `.superspec` 有完整 test-contract evidence 但 OpenSpec `test-contract.md` 缺失时 block。
- review/verification evidence 存在但 tasks 未完成时 block。
- archive 后 `.superspec` preservation evidence 缺失时 `archived` block。

### 13.4 E2E fixture

建立最小 change：

```text
proposal -> specs -> design -> test-contract -> tasks
-> RED -> GREEN -> review -> verify -> archive_ready -> archived
```

每个 gate 测两次：

1. 缺 OpenSpec artifact 或 evidence 时 block。
2. 补齐后 allow。

## 14. 实施路线

1. 定稿本方案。
2. 定义 OpenSpec `superspec` schema，把 `test-contract.md` 固定为 pre-apply artifact。
3. 定义 `.superspec/state.json`、evidence JSON schema 和 ledger JSONL schema。
4. 实现 guard-owned control state 的 Sync Guard。
5. 实现 `superspec-*` skills，所有推进都先调用 guard。
6. 接入 native subagent evidence 保存规范。
7. 编写 schema/unit/integration/e2e fixture。
8. 用旧 `yourflow-*` / `workflow-*` 构造负例 fixture，确认漂移会被 block。
9. 用一个真实 change 跑通。
10. SuperSpec 验证通过后，移除或隔离旧 `yourflow-*` / `workflow-*`。

## 15. 验收标准

- OpenSpec 正本 artifact 不被 sidecar 替代。
- `test-contract.md` 是 OpenSpec 正本 artifact，不降级为 sidecar。
- `.superspec/state.json` 只能由 Sync Guard 写入。
- `.superspec/state.json` 中的 `guard_route_phase` / active gate 不能覆盖 OpenSpec status。
- `.superspec/ledger.jsonl` 不包含 current/current_phase/current_stage/allowed_next。
- 任意推进都现场读取 OpenSpec status。
- OpenSpec 缺 artifact 时 SuperSpec 必须 block。
- SuperSpec 缺 evidence 时必须 block。
- subagent 审查必须可追溯到 native subagent 输出。
- RED/GREEN 和 task checkbox 有明确绑定。
- post-apply review/verification 不再误作为普通 pre-apply artifact。
- archive_ready 与 archived 明确分离。
- 旧 `.yourflow` / `.ai-workflow` 不做兼容迁移，只能作为负例 fixture 或退役对象。

## 16. 最终建议

采用：

```text
OpenSpec 正本轨 + SuperSpec guard-owned control state + append-only evidence + Sync Guard
```

不要采用：

```text
OpenSpec 状态机 + 不受约束的 SuperSpec 平行状态机
```

这既保留 OpenSpec 的规范生命周期，也保留 SuperSpec 对质量流程的控制权。控制权来自受控状态和同步判定矩阵，而不是可以覆盖 OpenSpec 事实的 sidecar 阶段真相。
