# SuperSpec 工作流问题 2/3/4 加固设计

> 状态：Implemented / under adversarial re-review
> 范围：收敛 superspec 工作流验证中暴露的 issue 2 / 3 / 4；issue 2/3/4 均已进入实现基线，并补充本轮对抗审查发现的 traversal alias、archive identity、request_changes adjudication 和 missing-ref fail-closed 收紧项。
> 关联实现：`.codex/skills/superspec-archive/SKILL.md`、`scripts/superspec/src/gates.ts`、`scripts/superspec/src/core.ts`、`scripts/superspec/src/archive.ts`

## 1. 问题背景

在本轮 superspec 端到端验证中，归档与 review 收尾阶段暴露了三类问题：

1. **issue 2: archive skill 仍可能被 OpenSpec 交互确认阻塞。**
2. **issue 3: `next_allowed_actions` 不够精确，部分 block 情况下会给出误导性的下一步建议。**
3. **issue 4: `superspec-state.lock` 已有重试，但 `check-archive-ready` 的 preservation bundle 写入仍存在并发竞态。**

已实现基线包括：

- `superspec-archive` 已改为 `openspec archive -y "<change>"`，消除了 native CLI 的交互确认阻塞。
- `next_allowed_actions` 已按 `block_reasons.code` 规划，避免无关 repair 动作污染 review/archive 恢复路径。
- `check-archive-ready` 已把 preservation manifest/bundle materialization 纳入 `superspec-state.lock` 保护的同一事务，并在写失败时 fail-closed 为 block。
- `.superspec` 枚举和 archive bundle materialization 已跳过 symlink/hardlink alias，避免通过 filesystem alias 读取或打包 change root 之外的内容。
- `check_archived()` 已对 archive 目录名和 preservation manifest `change_id` 做精确身份校验。
- `request_changes -> task_reopen` 已要求主线程 adjudication 覆盖每条 live `source_guidance` 的 `required_load_refs`、`required_claim_ids` 和 `blocking_findings`。

本文保留原设计决策和接受标准，同时记录当前实现必须继续满足的不可回退约束。

## 2. 目标与非目标

### 2.1 目标

- 保持 archive 路径 **非交互、可自动化、仍需显式人审确认**。
- 让 `next_allowed_actions` **只来源于真实 block reason**，不再出现“当前没坏但仍建议去修”的动作。
- 让 `archive_ready` 的 preservation 产物生成与 state commit **处于同一串行化边界**。
- 对失败语义保持 **fail-closed**：bundle/materialization 失败时，gate 必须 block，不能留下“decision 允许但产物缺失”的中间态。
- 补足可回归的测试面，避免问题 2/3/4 以及本轮审查新增边界再回归。

### 2.2 非目标

- 不重写 `openspec archive` 行为本身；archive 仍通过 native CLI 完成。
- 不在本轮引入新的用户可见主阶段，也不重构 SuperSpec 整体状态模型。
- 不借机扩大 review evidence schema；本轮只解决动作推荐和 archive preservation 串行化。
- 不修改现有 block reason 的语义编码；本轮重点是 **如何消费这些 reason**，而不是重命名它们。

## 3. 原始缺陷与当前行为

### 3.1 issue 2：已修复基线

当前 `.codex/skills/superspec-archive/SKILL.md` 已固定使用：

```bash
openspec archive -y "<change>"
```

这项改动是正确方向，后续不应回退为交互式 `openspec archive "<change>"`。但该 fix 只解决了“native archive 卡在确认提示”这一层，不改变 SuperSpec 自己的归档前置约束：

- 必须先通过 `check-archive-ready`
- 必须已有 archive-scoped `human_confirmation`
- 不允许以 `-y` 替代 SuperSpec 的显式人审证据

因此，issue 2 在本设计中被定义为：**保留现状，不再设计第二套方案。**

### 3.2 issue 3：`next_allowed_actions` 与真实 blocker 脱节

原始 `scripts/superspec/src/gates.ts` 的 `check_review_complete()` 混合做了两件事：

1. 计算 `block_reasons`
2. 现场顺手拼接 `next_allowed_actions`

问题在于，动作拼接逻辑与最终 `block_reasons` 不是同一个真相源，导致两个具体偏差：

- 当 `mainAdjudications.length === 1` 时，无论是否真的存在 adjudication 结构问题，都会追加“repair main_adjudication ...”动作。
- 只要存在任何 `verification_review` evidence，就会追加“repair verification_review references ...”动作，即使本次 block 的真实原因只是 `missing_final_tests` 或 `validate_failed`。

这会产生两个后果：

1. 用户收到误导动作，去修一个当前并未阻塞流程的对象。
2. `archive_ready` 复用 `check_review_complete()` 时，也会把这类噪音动作一并带过去，污染 archive 阶段的建议。

当前实现已改为 reason-driven action planner：只有出现对应 `block_reasons.code` 时才生成 repair/handoff action，`archive_ready` 只继承 review 已规划动作并叠加 archive 自己的 confirmation/validate 动作。

### 3.3 issue 4：archive preservation 仍不在串行化边界内

原始 `scripts/superspec/src/core.ts` 的 `dispatch_once()` 顺序是：

1. 计算 `dec`
2. `recompute_and_write_state(...)`
3. 若命令是 `check-archive-ready` 且 `dec.allowed`，再调用 `write_archive_preservation_bundle(...)`

这意味着：

- `superspec-state.lock` 只保护 state/ledger 写入，不保护 `archive-preservation.json` 和 `superspec-preservation/` 的生成。
- 两个并发 `check-archive-ready` 可能交替执行 `rmSync(bundle)` 与 `copyFileSync(...)`，造成互相覆盖。
- 若 bundle 写入失败，当前实现会把 `dec` 改回 block 并再次写 state，但第一次“allowed 决策”已经落过一次 state，期间存在短暂的不一致窗口。

所以 issue 4 的本质不是“还要不要重试”，而是：**archive preservation 必须纳入单 writer 事务边界。**

当前实现已在 `check-archive-ready` 分支内持有 `superspec-state.lock` 重新加载状态/证据、重新判定 gate、生成 preservation transaction、写 state/ledger，并在任一环节失败时回滚 preservation 与 state snapshot，最终落成 block。

## 4. 设计原则

### 4.1 动作建议必须从 blocker 派生

`next_allowed_actions` 不是文案层 embellishment，而是 gate 的恢复路径提示。它必须由真实 `block_reasons.code` 驱动，而不是由某个中途分支的“看起来可能要修”驱动。

### 4.2 一个 change 只能有一个归档准备写入器

对于同一个 change，`check-archive-ready` 产生的以下副作用必须视为同一事务的一部分：

- `superspec-state.json`
- `ledger.jsonl`
- `.superspec/artifacts/archive-preservation.json`
- `superspec-preservation/manifest.json`
- `superspec-preservation/files/**`

这些副作用必须共享一个串行化边界。

### 4.3 archive `-y` 不能替代人审 gate

`openspec archive -y` 只是关闭 OpenSpec CLI 的交互提示；它不能绕过 SuperSpec 的 `archive_ready` human confirmation 证据。

### 4.4 失败必须落成最终状态，而不是中间态

任何 preservation materialization 失败，都必须在同一临界区内转成最终 block 决策。不能先把 allowed state 写出去，再在锁外补救。

## 5. 方案设计

### 5.1 issue 2：固定保留非交互 archive 基线

本项不再引入新机制，只固化以下约束：

- `superspec-archive` 必须继续使用 `openspec archive -y "<change>"`。
- archive skill 的前置 gate 仍是：
  1. 记录 archive-scoped `human_confirmation`
  2. 通过 `check-archive-ready`
  3. 再执行 native archive
- 测试中必须继续显式断言 skill 文案/脚本包含 `-y`，防止后续被回退成交互式调用。

这意味着 issue 2 的实现判断标准很简单：**archive skill 永远不依赖 OpenSpec 的交互 prompt。**

### 5.2 issue 3：把 `next_allowed_actions` 改成 reason-driven planner

#### 5.2.1 结构调整

`check_review_complete()` 不再一边判定一边顺手 append 动作，而改成两段式：

1. **Review-ready inheritance**
   - 先执行 `check_review_ready()` 的内部 evaluator
   - 把它产出的 `block_reasons`、结构化上下文、`next_allowed_actions` 一并并入 `review_complete` evaluator
   - `review_not_ready` 只作为“review_complete 受 pre-gate 阻断”的摘要 reason，不能覆盖底层 ready blocker
2. **Review evaluator**
   - 负责收集 `reasons`
   - 负责产出结构化上下文，例如：
     - `review_ready_reasons`
     - `review_ready_actions`
     - `missing_review_guidance_roles`
     - `missing_verification_roles`
     - `needs_source_guidance_field_repair`
     - `needs_main_adjudication_repair`
     - `needs_verification_ref_repair`
3. **Action planner**
   - 只读取 evaluator 产出的 `reason.code` 与结构化上下文
   - 根据映射表输出去重后的 `next_allowed_actions`
   - 严禁解析 `reason.message` 文本来猜动作

这样做的目的，是把“为何 block”与“如何恢复”都建立在同一组结构化事实之上。

#### 5.2.2 动作映射规则

`check_review_complete()` 至少按下表生成动作：

| block reason code | next action |
|---|---|
| `review_not_ready` | `pass check-review-ready for <change> first` |
| `missing_source_guidance` | `collect review_complete source_guidance from missing required roles` |
| `review_evidence_incomplete` / `missing_rollback_target` | `repair source_guidance evidence fields so every required review lane has base/head refs, reviewed_files, and rollback_targets` |
| `missing_main_adjudication` / `ambiguous_main_adjudication` | `write exactly one live main_adjudication referencing every live source_guidance evidence` |
| `source_guidance_unreferenced` / `required_claim_unadjudicated` / `required_load_unloaded` | `repair main_adjudication so it references all source_guidance evidence and covers required loads and claims` |
| `missing_final_verification_review` | `collect verification_review evidence from missing required roles` |
| `verification_evidence_incomplete` | `repair verification_review references, matrices, scope drift report, and final_test refs` |
| `scope_drift` | `resolve scope drift before review close: narrow the change or record accepted/none with evidence` |
| `missing_final_tests` | `record final_test pass evidence and reference it from verification_review` |
| `validate_failed` | `fix openspec validate failures for <change>` |

规则约束：

- 若 `check_review_ready()` 已经给出更底层的恢复动作，`review_complete` 必须优先继承这些动作，而不是把它们折叠成单一的 `pass check-review-ready for <change> first`。
- 只有在 `review_ready_actions` 为空、且调用方仍需要一个摘要兜底动作时，才允许输出 `pass check-review-ready for <change> first`。
- 同一动作只有在对应 reason code 存在时才允许出现。
- 同一动作可以由多个 reason code 触发，但最终只输出一次。
- 动作顺序固定为：前置 gate -> source_guidance -> main_adjudication -> verification -> final tests -> scope/validate。
- evaluator 若没有对应 reason code，不得为了“提示更完整”附加额外动作。

#### 5.2.3 `archive_ready` 的传播规则

`check_archive_ready()` 不再自己猜 review 修复动作，而是：

1. 先获取 review evaluator / review decision 的结果。
2. 若 review blocked：
   - 追加 `review_gate_failed`
   - 继承 review 的 `block_reasons`
   - 继承 review 的 `next_allowed_actions`
3. 再追加 archive 自己的 gate 动作：
   - `fix openspec validate failures for <change>`（仅当 archive 层新增 `validate_failed`）
   - `record archive_ready human_confirmation evidence before calling openspec archive -y`（仅当缺 final confirmation）

约束：

- 由于 `review_complete` 已继承 `check_review_ready()` 的底层动作，`archive_ready` 也必须原样继承这些 pre-gate 动作；不能把它们再次折叠成泛化的 `pass check-review-complete first`。
- `archive_ready` 不能重新生成“repair main_adjudication”/“repair verification_review”一类 review 内部动作。
- `archive_ready` 必须对 inherited actions 做去重。
- `archive_ready` 最终动作列表应该是“先修 review，再补 archive 专属缺口”，而不是重新组织一套新文案。

#### 5.2.4 接受标准

以下 block 情况下，动作必须精确：

- `tasks_incomplete` / `task_evidence_incomplete` / dirty worktree / `propose_not_complete` 在 `check_review_ready()` 中触发时，`check_review_complete()` 和 `check_archive_ready()` 必须继续保留这些底层动作，不能只剩“先过 review_ready”。
- 仅 `validate_failed` 时，不能出现 main adjudication / verification repair 动作。
- 仅 `missing_final_tests` 时，不能出现 verification ref repair 动作，除非同时存在 `verification_evidence_incomplete`。
- 仅 `missing_main_adjudication` 时，不能出现 verification repair 动作。
- `archive_ready` 因 review 失败被 block 时，动作集合必须与 `check_review_complete()` 的动作集合一致，再叠加 archive 自己的缺失项。

### 5.3 issue 4：把 archive preservation materialization 纳入 state 事务

#### 5.3.1 决策

采用 **单锁串行化**，复用现有 `superspec-state.lock`，不新增独立的 `archive-preservation.lock`。

原因：

- archive preservation 是 `check-archive-ready` 的一部分，不是独立子系统。
- 若再引入第二把锁，会带来锁顺序、死锁、双重重试和状态可见性问题。
- 当前已有 `dispatch()` 针对 `state_concurrent_update` 的统一重试逻辑，复用成本最低。

#### 5.3.2 事务边界调整

把 `check-archive-ready` 的副作用改成一个原子临界区：

1. 获取 `superspec-state.lock`
2. 在锁内做 fingerprint CAS 校验
3. 若 provisional `dec.allowed === true`：
   - 在 **`.superspec` 目录之外** 生成 manifest/bundle staging 产物
   - 完成 staging 后，按正式替换协议 promote 到最终路径
   - promote 成功后把 bundle/manifest 路径补进最终 decision summary
4. **只有在最终 manifest + 最终 bundle 都已 promote 成功后**，才允许把 allowed decision 写入 `superspec-state.json` 与 `ledger.jsonl`
5. 释放锁

关键点：

- **allowed state 必须是最后一个可见提交步骤。**
- 若 staging 或 promote 任一步失败，则在锁内直接把 decision 转成：
  - `decision: block`
  - `reason.code: missing_archive_preservation_plan`
- 然后只持久化最终 block state。

#### 5.3.3 bundle 写入方式

`write_archive_preservation_bundle()` 不能继续“删正式目录再原地重建”，而应改成 staging + swap-promote：

1. 在 `.superspec` 之外创建 staging 根目录，例如 `<change>/.superspec-staging/<run-id>/`
2. 在该 staging 根下写：
   - `archive-preservation.json`
   - `superspec-preservation/files/**`
   - `superspec-preservation/manifest.json`
3. staging 完成后，在锁内执行正式替换：
   - 若正式 `superspec-preservation/` 已存在，先 rename 到 `.superspec-staging/<run-id>/backup/superspec-preservation`
   - 若正式 `.superspec/artifacts/archive-preservation.json` 已存在，先 rename 到 `.superspec-staging/<run-id>/backup/archive-preservation.json`
   - 将 staging 中的 `superspec-preservation/` rename 为正式目录
   - 将 staging 中的 `archive-preservation.json` rename 为 `.superspec/artifacts/archive-preservation.json`
   - 对相关父目录执行 `fsync`
   - 全部成功后删除 `.superspec-staging/<run-id>/`
4. 若中途失败：
   - 若 staging 目录已经占用了正式 `superspec-preservation/` 路径，先移走或删除当前正式目录
   - 尝试把 `.superspec-staging/<run-id>/backup/*` 恢复为正式 manifest/bundle
   - 若失败事务前没有旧正式 manifest/bundle，则删除本次 promote 出来的新正式产物
   - 清理 staging 目录
   - 不发布新的 allowed state

失败语义：

- staging 目录 **不得** 位于 `.superspec/` 树内，避免被 `sidecar_manifest_entries()` 枚举进 manifest 自身。
- 任一步骤失败，只清理本次 staging 目录，并优先恢复 staging backup；不能回到“先删正式目录再重建”的协议。
- 正式 `superspec-preservation/` 与正式 `archive-preservation.json` 只会在完整 bundle 准备好后被替换。

#### 5.3.4 与现有重试逻辑的关系

保留 `dispatch()` 上层的 `state_concurrent_update` 重试。

预期行为：

- 并发 caller A/B 同时进入 `check-archive-ready`
- A 先持锁完成 bundle + state commit
- B 发现锁占用，触发现有 retry
- B 重试时重新加载最新状态/指纹，再重新计算并生成同一套一致结果

因此，重试是外层恢复机制；真正解决竞态的是“bundle 进入同一锁内事务”。

#### 5.3.5 接受标准

- 并发执行两个 `check-archive-ready`，不应出现：
  - `superspec-preservation/` 半成品
  - manifest/bundle 路径存在但文件缺失
  - state 记录为 allowed，但正式 manifest/bundle 尚未 promote
- bundle materialization 失败时：
  - 返回 block
  - `block_reasons` 含 `missing_archive_preservation_plan`
  - state 最终记录为 block
  - 不留下新的正式半成品目录

### 5.4 对抗审查追加收紧

本轮 `critic` / `code-reviewer` 对抗审查额外收紧以下边界，并纳入实现基线：

1. `.superspec` traversal 不跟随 symlink，也不纳入 hardlinked file alias。
   - `walkFiles()` 使用 `lstatSync()`，遇到 symlink 直接跳过；遇到 `nlink > 1` 的文件也跳过。
   - `index_evidence()`、`sidecar_manifest_entries()` 和 archive bundle copy 均复用该枚举行为。
   - 目的：防止 `.superspec/evidence/**`、`.superspec/raw/**` 或 archive preservation bundle 通过 filesystem alias 读取/打包 change root 之外的文件。
2. archived change 身份必须精确匹配。
   - `find_archived_change()` 只接受目录名等于 `<change>` 或 `YYYY-MM-DD-<change>`。
   - primary `.superspec/artifacts/archive-preservation.json` 与 fallback `superspec-preservation/manifest.json` 均必须包含匹配的 `change_id`。
   - archive 目录本身不能是 symlink；primary/fallback manifest 的 `kind` 必须匹配，`entries` 必须非空且包含 `.superspec/ledger.jsonl` 与 `.superspec/superspec-state.json`。
   - readback 端的 `entries[*].path` 必须是 `.superspec/**` 相对路径，并且 primary path 必须留在 archived change root 内，fallback `files_root` 与 entry path 必须留在 preservation bundle root 内。
   - 目的：避免 `2026-06-08-other-<change>` 这类 suffix match、空 manifest、恶意 `../` entry path 或 symlink archive dir 被误判为目标 change 已归档。
3. `request_changes -> task_reopen` 必须复用主线程 adjudication 完整性约束。
   - request_changes round 也必须覆盖所有 live/pass `source_guidance.required_load_refs`、`required_claim_ids` 和 `blocking_findings`。
   - `check_task_reopen()` 在允许回退 `[x] -> [ ]` 前会重新执行该完整性检查。
   - 目的：防止 review 阶段只写出“需要 reopen”的自由文本，却没有主线程实际加载关键 source、裁决 claim 和处理 blocker。
4. 缺失 pinned ref 必须结构化 block。
   - `target_refs` / `loaded_refs` 指向缺失文件时返回 `stale_review` / `stale_loaded_ref`。
   - 目的：避免 evidence schema guard 因 `runtime.file_blob_sha()` 读取缺失文件而抛异常，导致用户拿不到可恢复的 block reason。

## 6. 备选方案与取舍

### 6.1 备选：继续保留当前动作拼接，只再补几个 if

拒绝原因：

- 问题根因是“动作推荐与 reason 来源分裂”，不是“if 还不够多”。
- 继续堆 if 会让 `review_complete` 和 `archive_ready` 的逻辑更难验证，也更容易再次引入无条件动作。

### 6.2 备选：给 archive preservation 单独加一把锁

拒绝原因：

- 不能解决 state 与 bundle 的一致性窗口。
- 两把锁的顺序和重试策略更复杂，收益不如把 preservation 纳入现有 state transaction。

### 6.3 备选：bundle 写失败后在锁外补写 block state

拒绝原因：

- 这就是原始缺陷的本质，中间已经存在“allowed 落盘”的短窗口。
- fail-closed 不能依赖锁外补救。

## 7. 测试计划

### 7.1 issue 2 回归测试

- skill 测试继续断言 `.codex/skills/superspec-archive/SKILL.md` 包含 `openspec archive -y`.
- gate 测试显式断言：缺少 `archive_ready` scoped `human_confirmation` 时，`check-archive-ready` 必须 block，并返回 confirmation action。

### 7.2 issue 3 精确动作测试

新增/收紧以下断言：

- `validate_failed` only
  - `next_allowed_actions === ["fix openspec validate failures for <change>"]`
- `missing_final_tests` only
  - 不包含 main adjudication / verification ref repair 动作
- `missing_main_adjudication` only
  - 只包含 main adjudication 相关恢复动作
- `verification_evidence_incomplete` only
  - 包含 verification repair，不包含 main adjudication repair
- `tasks_incomplete` / dirty worktree / `propose_not_complete`
  - 经 `check_review_complete()` 传播后，仍保留 ready 阶段的底层修复动作
- `archive_ready` 复用 review 失败时
  - 继承 review 动作
  - 仅在缺 confirmation 时再额外包含 archive confirmation 动作

### 7.3 issue 4 并发与失败测试

- 并发 `dispatch({ command: "check-archive-ready" })`
  - 两个并发调用都能收敛为一致结果
  - 最终 manifest sha 与 bundle 内容一致
- bundle 写入异常
  - 模拟 copy/write 失败
  - 断言返回 block + `missing_archive_preservation_plan`
  - 断言 state 最终是 block
  - 断言正式 `superspec-preservation/` 未被写成半成品
- staging/swap-promote
  - 验证 staging 路径不在 `.superspec/` 枚举范围内
  - 验证已有正式目录时走 `final -> bak -> staged -> final` 替换协议
  - 验证 `.bak` / staging 路径不会泄漏为正式产物
- promote 中段失败注入
  - 模拟“正式目录替换成功，但正式 manifest 替换前失败”
  - 断言不发布 allowed state
  - 断言正式目录/manifest 要么保持旧版本，要么被完整恢复

### 7.4 对抗审查新增回归测试

- traversal alias
  - `index_evidence()` 不索引 symlink/hardlink 指向的外部 evidence。
  - `sidecar_manifest_entries()` 和 preservation bundle 不包含/复制 symlink/hardlink 指向的外部 raw 文件。
- archived identity
  - suffix-only archive 目录不能满足目标 change 的 `check_archived()`。
  - primary/fallback preservation manifest `change_id` 不匹配时必须 block。
- request_changes adjudication
  - `check_task_reopen()` 在 main adjudication 漏掉 required loads/claims/blocking findings 时必须 block。
- missing pinned refs
  - 缺失 `target_refs` 文件返回 `stale_review`。
  - 缺失 `loaded_refs` 文件返回 `stale_loaded_ref`。

## 8. 实施状态

1. `review_complete` 已重构为 reason-driven action planner。
2. `archive_ready` 已继承 review 的结构化动作，并只追加 archive 自身动作。
3. archive preservation 写入已移动到 state 锁内事务，并改成 staging + promote。
4. 精确动作、并发、rollback、archive identity、traversal alias、request_changes adjudication 和 missing-ref 测试已纳入回归套件。

该顺序仍是后续修改时的推荐维护顺序：先收敛 review planner，再收敛 archive propagation，最后处理 archive preservation 事务，避免把恢复动作和持久化语义混在一起调试。

## 9. 结论

本设计的核心决策只有两个：

1. **`next_allowed_actions` 由真实 `block_reasons.code` 驱动，不再由散落条件分支随手生成。**
2. **`check-archive-ready` 的 preservation manifest/bundle 必须进入 `superspec-state.lock` 保护的同一事务。**

issue 2/3/4 已进入实现基线。后续修改不得回退以下约束：archive 使用非交互 `openspec archive -y`，`next_allowed_actions` 只由真实 blocker 派生，archive preservation 与 state/ledger 处于同一事务，`.superspec` traversal 不跟随 symlink 且不纳入 hardlink alias，archive identity 必须精确匹配，request_changes 回退必须先完成主线程 adjudication 覆盖。
