# SuperSpec 审计修复交接 2026-06-10

> 用途：本文档是给修复会话的工作指令。审计已完成，无需重新审计；按本文档顺序执行修复。
> 必读输入（按顺序）：
> 1. `docs/audits/WORKFLOW_FULL_AUDIT_2026-06-10.md`——主审计报告，31 项发现（A-1~H-8），每条带 file:line 证据与修复方案。
> 2. `docs/audits/REVIEW_DISCLOSURE_FIXED_POINT_REVIEW_2026-06-10.md`——disclosure 设计稿专项审查（本次修复**不实施**该设计稿，仅在修复与其交叉的项时参考，如 D-3 悬空引用）。
> 3. `docs/SPEC.md`——规范源，修复不得违背其 v1 audit-only 定位与红线（不 fork OpenSpec schema、guard 唯一状态写入器、fail-closed）。

## 工作范围与边界

**只做第一批 + 第二批**（见下）。第三批是产品决策项（git 跟踪策略、preset 语义、安装引擎等），**不要动手**，留给用户拍板。

代码位置：`scripts/superspec/`（TypeScript，`npm test` 跑 node:test）。修复必须：

- 每项修复先写失败测试（block path + allow path 至少各一），再改实现；
- 不破坏现有 238 个测试；新增 block reason code 时同步更新 SPEC.md §6.5/§17 对应表项；
- 遵循现有代码风格（reason code 蛇形命名、`reason()` helper、fail-closed 默认）；
- 每完成一项在本文档勾选并简注改动文件。

## 第一批：红线修复（按此顺序）

- [x] **FIX-1（审计 B-2，P0）state 损坏 fail-closed** ✅ 2026-06-10
  `state.ts:40-48` `load_state()` 解析失败返回 null 被当"首次运行"。改为：文件存在但不可解析 → 所有 check 命令 block `state_corrupt`，输出修复指引；`recompute` 加显式确认参数（如 `--rebuild-corrupt`）才允许重建，重建事件写 ledger。注意区分"文件不存在"（合法，可重建）与"存在但损坏"（block）。
  改动：`src/state.ts`（新增 `state_file_corrupt` / `state_corrupt_reasons`，"存在但非 JSON object"判定为损坏）；`src/cli_args.ts`（recompute 新增可选 `--rebuild-corrupt`）；`src/core.ts`（dispatch 预检 block `state_corrupt` 且不写 state、`cmd_status` 同步上报、`write_guard_state_checked` 与 archive 锁内复检防 mid-flight 覆盖、recompute 重建写 `state_corrupt_rebuilt` ledger 事件）；`tests/test_superspec_guard.test.ts`（7 个新测试：block×4 + allow×2 + 参数解析）；SPEC.md §6.3/§6.4/§17 已更新。

- [x] **FIX-2（审计 A-1，P0）`design_complete` require `explore_complete`** ✅ 2026-06-10
  `gates.ts:526-531` 的 design_complete 分支头部加 `check_superspec_gate(..., "explore_complete")` 前置（照抄 `invariants_reviewed` 对 `design_complete` 的写法，`gates.ts:532-537`）。测试：无 discovery/critic 证据时 `check-enter --gate design_complete` 必须 block `explore_complete_failed`。
  改动：`src/gates.ts`（design_complete 分支头部加 explore_complete 前置，失败注入 `explore_complete_failed` + 子原因）；`tests/test_superspec_guard.test.ts`（FIX-2 block/allow 各 1 个新测试；两个既有 allow-path 测试补 discovery.md + explore critic 证据）；SPEC.md §6.5/§17 已更新。

- [x] **FIX-3（审计 A-2，P1）`test_contract_honored` require `test_contract_drafted`** ✅ 2026-06-10
  `gates.ts:589-617` 同上模式补前置。测试：跳过 drafted 直接构造 honored 条件时 block。
  改动：`src/gates.ts`（test_contract_honored 分支头部加 test_contract_drafted 前置，失败注入 `test_contract_drafted_failed` + 子原因）；`tests/test_superspec_guard.test.ts`（FIX-3 block/allow 各 1 个新测试；"allows mapped test refs" 改用 prepareProposeComplete 全链 setup）；SPEC.md §6.5 判定矩阵 + 主链拓扑说明 + §17 已更新。

- [x] **FIX-4（审计 C-1，P1）三处 stale blob 检查 + state 指纹补全** ✅ 2026-06-10
  照抄 `invariants_reviewed` 的 current-blob 检查模式（`gates.ts:545-552`）：
  - `explore_complete`：critic evidence 必须 target 当前 `.superspec/artifacts/discovery.md` blob；
  - `design_complete`：三角色 evidence 必须 target 当前 `design.md` blob；
  - `test_contract_drafted`：reviewer evidence 必须 target 当前 `.superspec/artifacts/test-contract.md` blob。
  另：`state.ts:57-68` `compute_fingerprints` 增加 `discovery_fingerprint`、`design_fingerprint`。注意会影响现有测试 fixture（需给 helper 生成的 evidence 补正确 blob）。
  改动：`src/gates.ts`（新增公共 `stale_artifact_review_reasons` helper，三 gate 接入，block codes：`stale_explore_review`/`stale_design_review`/`stale_test_contract_review`；`invariants_reviewed` 原检查改用同一 helper）；`src/state.ts`（`compute_fingerprints` 增加 `discovery_fingerprint`/`design_fingerprint`）；`tests/test_superspec_guard.test.ts`（4 个新测试：三 gate 各一个 allow→编辑→block 对照 + 指纹 stale 测试；`roleEvidence` helper 改为按 gate 绑定真实 artifact blob；`prepareProposeComplete` 支持自定义 contract/tasks；3 个旧 fixture 修复）；SPEC.md §5.3/§6.5/§17 已更新。

- [x] **FIX-5（审计 B-3，P2）写入 computed_from 使用判定时指纹** ✅ 2026-06-10
  `core.ts:136-159` + `state.ts:301-321`：锁内第二次重算指纹后若与判定时不一致，必须把 decision 改写为 block（或直接复用判定时指纹写入，不重算）。测试：构造"判定后、写入前文件变化"的窗口（测试中可直接在两步间改文件）断言不会写出 新指纹+旧allow。
  改动：`src/state.ts`（`build_recomputed_state`/`prepare_recomputed_state_write` 接受 `opts.fingerprints`，提供时不再写入时重算）；`src/core.ts`（`write_guard_state_checked` 传锁内已校验的 `currentInputs`；archive 锁内流程统一用一次性 `lockedFps` 供三处 prepare）；`tests/test_superspec_guard.test.ts`（2 个新测试：指纹 verbatim 复用 + 判定后突变不被吸收且下次 check 报 stale）；SPEC.md §5.4/§17 已更新。

## 第二批：机制收紧（第一批全绿后再开始）

- [x] **FIX-6（C-2）supersede 授权模型** ✅ 2026-06-10
  要求 supersede 证据：目标 evidence_id 必须存在（悬空→block `supersede_target_missing`）、必须同 gate 或携带非空 `supersede_reason`（空白字符串不算，否则 block `supersede_unauthorized`）；dispatch 观察到的每对 `(superseded_by, supersedes)` 以 `evidence_superseded` 事件入 ledger（锁内去重恰好一次，state 损坏时不写）。`pass_task_reopens` 走文档化豁免（而非改 live_pass）：task_reopen 是历史 blocker 记录，supersede 不得抹掉 reopen 义务——既有测试"task_reopen hidden by generic superseded evidence"已固化该语义。
  改动：`src/evidence.ts`（新增 `supersede_reasons` 跨证据校验；`pass_task_reopens` 补豁免理由注释）；`src/gates.ts`（`evidence_schema_guard` 接入 `supersede_reasons`）；`src/state.ts`（新增 `record_supersede_ledger_events`，锁内去重追加）；`src/core.ts`（dispatch 在 corrupt 早退之后、写 state 之前记录 supersede 事件）；`tests/test_superspec_guard.test.ts`（7 个新测试：悬空目标/跨gate无理由/空白理由 block，同gate/带理由 allow，ledger 恰好一次，corrupt 不写 ledger；`supersededEvidence` helper 默认携带 supersede_reason）；SPEC.md §5.5/§17 已更新。
- [x] **FIX-7（C-3）kind 白名单 + human_confirmation 最小 schema** ✅ 2026-06-10
  未知 kind → block `evidence_unknown_kind`（白名单从现有代码识别的 kind 集合整理）；`human_confirmation` 要求 `confirmation_text` 非空 + `gate` 匹配 + `confirmed_refs[]`（沿用 branch_handling 的 confirmed_paths 模式）。
  改动：`src/util.ts`（新增 `EVIDENCE_KINDS` 白名单 + `HUMAN_CONFIRMATION_GATES` 消费集合）；`src/evidence.ts`（schema 防线接入 `evidence_unknown_kind`；新增 `human_confirmation_reasons`：gate 消费集合 + confirmation_text 非空 + confirmed_refs/confirmed_paths 非空，block `human_confirmation_invalid`）；`tests/test_superspec_guard.test.ts`（8 个新测试：未知 kind block、全白名单 allow、缺 text/缺 refs/错 gate block、字段齐备 allow、branch_handling confirmed_paths 双向；`passEvidence` helper 为 human_confirmation 补默认 schema 字段）；SPEC.md §5.5/§17 已更新。
- [x] **FIX-8（A-5）四个无锚点人审阻塞点补 evidence** ✅ 2026-06-10
  apply 隔离方式选择、verify 失败处置、范围膨胀处置、preset 升级确认——在对应 gate 增加 human_confirmation 要求。preset 升级确认经核实已有锚点（`core.ts` dispatch 级 `preset_upgrade_requires_human_confirmation`，FIX-7 已把 `preset_upgrade` 纳入消费 gate 集合），本项实际新增三个锚点：① `apply_isolation`——task_edit/task_complete 要求 live human_confirmation 且 pin `tasks_structure_hash`（checkbox 不敏感的 tasks.md 结构指纹），缺失 block `apply_isolation_unconfirmed`；② `scope_expansion`——tasks.md 结构在批准后变化即 block `scope_expansion_unconfirmed`，须用户重批（pin 新 hash）或重设计/拆 change；③ `verify_failure_handling`——review_complete 对任何 fail 状态 verification evidence（supersede 不可抹）要求 confirmation 的 confirmed_refs 覆盖其 evidence_id，否则 block `verify_failure_unconfirmed`。
  改动：`src/tasks.ts`（新增 `tasks_structure_hash`）；`src/util.ts`（HUMAN_CONFIRMATION_GATES 扩三 gate）；`src/evidence.ts`（apply_isolation/scope_expansion confirmation 须带 tasks_structure_hash）；`src/gates.ts`（`apply_scope_confirmation_reasons` 接入两 task gate；review_complete 失败处置检查；next_actions 提示）；`src/core.ts`（status 输出 `tasks_structure_hash` 便于 agent 抄写）；`tests/test_superspec_guard.test.ts`（7 个新测试 block/allow 双向 + supersede 不可抹；`prepareProposeComplete` 补 apply_isolation confirmation；1 个旧 fixture 改为经 opts 写 tasks.md）；SPEC.md §6.5/§14/§17 已更新。
- [x] **FIX-9（C-4）prompt_ref 存在性 + evidence_id 唯一性** ✅ 2026-06-10
  prompt_ref 比照 output_ref 校验（可读非空）；同 change 内重复 evidence_id → block `evidence_id_duplicate`。
  改动：`src/evidence.ts`（`output_ref_reasons` 参数化 reason codes；role evidence 分支接入 prompt_ref 校验，block `evidence_prompt_missing`/`evidence_prompt_empty`/`evidence_unsafe_ref`；新增跨证据 `duplicate_evidence_id_reasons`）；`src/gates.ts`（`evidence_schema_guard` 接入查重）；`tests/test_superspec_guard.test.ts`（3 个新测试：missing/empty/ok 三态、路径逃逸、查重 block/allow；`roleEvidence` helper 默认写 prompt 文件且默认 id 改为 `EV-<gate>-<role>` 防止多角色同 gate 撞 id）；SPEC.md §5.5/§17 已更新。
- [x] **FIX-10（C-5/H-4）test_run 按运行建档** ✅ 2026-06-10
  test_run 必填 `raw_log_refs[]`（change-root 解析，修正 H-4 的 repo-root 前缀混用/C-7；逃逸→`evidence_unsafe_ref`，缺失/不可读/空→block `test_run_log_missing`）+ `result_summary`（缺→block `test_run_summary_missing`）；声称的 `test_id`（及可选 `test_ids[]` 合并清单）须在引用日志中以字符串出现（grep 级），否则 block `test_id_not_in_log`。per-test 扇出仍合法，按运行建档形态被显式测试支持。
  改动：`src/evidence.ts`（新增 `test_run_reasons` 接入 `validate_evidence_schema`；旧 repo-root `raw_log_refs` 通用检查对 `kind:"test_run"` 让位，其余 kind 保留）；`tests/test_superspec_guard.test.ts`（4 个新测试：必填字段、日志可读/非空/不逃逸、test_id 在日志可寻、按运行建档 allow；`redEvidence`/`greenEvidence` 默认带 `raw_log_refs`+`result_summary`，经 `activeFixture` 懒写共享默认日志，保住 init/sidecar 懒创建测试的纯净 `.superspec`）；SPEC.md §5.5/§17 已更新。
- [x] **FIX-11（H-1）propose 期 role evidence output_ref 查重** ✅ 2026-06-10
  四个 propose 审查 gate（explore/design/invariants/test-contract）逐 gate 复用 `duplicate_output_ref_reasons`（dev:ino 实体判同）→同 gate 复用 block `evidence_output_ref_duplicate`；跨 gate 复用（omnibus refresh 形态）要求 evidence 声明 `review_scope[]` 且覆盖本 gate 的 target artifact，否则 block `review_scope_unverified`。
  改动：`src/gates.ts`（新增 `PROPOSE_REVIEW_TARGET_ARTIFACTS` 映射 + `propose_review_output_ref_reasons`，统一挂在 `check_superspec_gate` 尾部）；`tests/test_superspec_guard.test.ts`（4 个新测试：同 gate 复用 block、跨 gate 无 scope 两 gate 双向 block、带完整 scope allow、scope 缺本 gate target 仍 block）；SPEC.md §5.5/§6.5（四 gate 矩阵行补 block codes）/§17 已更新。
- [x] **FIX-12（D-3）全局悬空引用检查** ✅ 2026-06-10
  任何 `*_evidence_refs` 字段（字符串列表或 `lane_evidence_refs` 这类 lane→id 映射）引用不存在的 evidence_id → block `dangling_evidence_ref`，挂在 evidence schema 防线（任何 check 触发）。`supersedes` 悬空已由 FIX-6 `supersede_target_missing` 覆盖，不重复报；review_complete 既有 live/pass 级 unknown-ref 检查保持不变（两层互补）。
  改动：`src/evidence.ts`（新增 `dangling_evidence_ref_reasons`）；`src/gates.ts`（`evidence_schema_guard` 接入）；`tests/test_superspec_guard.test.ts`（3 个新测试：列表悬空 block、lane 映射悬空 block、全可解析不报）；SPEC.md §5.5/§17 已更新。
- [x] **FIX-13（F-1）补测 50 个未测 reason code** ✅ 2026-06-10
  按"src 中 `reason("<code>")` 全集 vs 测试文件字符串全集"重新对账，FIX-6~12 落地后剩余 56 个未测 code，全部补齐（含审计点名的高风险一档：evidence schema 防线四裸奔 code、init 防线、TDD 枚举、test_contract_not_honored、review 防线）。补测后 diff 归零。
  改动：`tests/test_superspec_guard.test.ts`（18 个新测试，按防线分组：evidence schema 基础（unparsable/bad_status/change_mismatch/forbidden_field）、role evidence（missing_target_refs、missing_native_subagent_evidence）、source_guidance 契约（role/load/findings/dispositions）、adjudication 条目（claim/finding invalid）、verification（role/incomplete/ref_invalid）、code-review workflow（invalid/incomplete/lane missing/lane mismatch）、init 防线 5 code、artifact entry 3 code、gate 路由（unknown_gate/missing_design/invariants_not_reviewed/invalid_business_invariants/invalid_task_graph）、review readiness（artifacts_incomplete/tasks_incomplete/review_not_ready/review_gate_failed）、TDD 枚举（invalid_tdd_mode/invalid_no_tdd_reason/missing_characterization/task_already_done）、RED 证据 id/invariant（missing_test_id/test_contract_not_honored/missing_invariant_ref/invalid_invariant_ref）、reopen 生命周期（task_reopen_pending_revert/ambiguous_task_reopen/scope_expansion_requires_propose）、review 终局（ambiguous_main_adjudication/claim_adjudication_blocked/missing_rollback_target/scope_drift）、infra（openspec_status_incompatible/review_diff_unavailable/guard_internal_error/openspec_cli_unavailable/project_init_failed））。实现零改动（纯补测）。

## 验收

1. `npm test` 全绿（`scripts/superspec/` 下）。
2. 对真实 change `refactor-vacation-duration-api` 跑 `scripts/superspec_guard status --change refactor-vacation-duration-api` 与几个 check 命令：确认新检查不会对这个历史 change 产生**无法修复的追溯 block**（若有，说明缺 grandfathering，停下来报告而不是硬改历史 evidence）。
   > 2026-06-10 已按此条停下报告：FIX-7 schema 追溯命中该 change 两份历史 human_confirmation（缺 confirmation_text / confirmed_refs），追加式修复无法消除。**用户裁决：该 change 是测试用的，不做 grandfathering，接受其被追溯 block**；`status` 命令不受影响。后续 FIX-9/10 按原设计做全量 evidence schema 检查。
3. 更新 SPEC.md：§6.5 判定矩阵补新增 block codes；§17 测试计划补新增测试项；A-2 要求的主链拓扑说明（`test_contract_honored` 的位置）。
4. 在本文档勾选完成项，简注每项改动的文件清单。

> **验收记录 2026-06-10（FIX-6~13 全部完成后）**：
> 1. `npm test` 302/302 全绿（含 18 个 FIX-13 补测）；`tsc --noEmit` 干净。
> 2. 真实 change `refactor-vacation-duration-api`：`status` 仍 allow（0 block）；`check-task-edit`/`check-review-complete` 按用户裁决出现追溯 block——除 FIX-7 的 `human_confirmation_invalid` 外，新增 FIX-8 `apply_isolation_unconfirmed`、FIX-10 `test_run_log_missing`（历史 raw_log_refs 用 repo-root 前缀，新 change-root 语义下不可解析，正是 H-4/C-7 实证）、FIX-11 `review_scope_unverified`（历史 omnibus refresh 复用 output_ref，正是 H-1 实证）。均属同一裁决覆盖范围（测试用 change，不做 grandfathering），无新增"无法修复"类别。
> 3. SPEC.md §5.5/§6.5/§14/§17/§17.1 已随各项更新；FIX-13 后 reason code 测试覆盖 diff 归零（口径见 §17.1）。

## 明确不做

- 第三批全部（H-3 git 跟踪、E-1 preset、G-1/G-2 安装引擎、D-2 archive 锚点、F-4 真实 CLI 冒烟、H-7 route 语义）——需用户决策。
- REVIEW_DISCLOSURE_FIXED_POINT 设计稿的实施——独立工作线，见 `docs/plans/DISCLOSURE_IMPL_HANDOFF_2026-06-10.md`（其 Stage B 依赖本文档的 FIX-11/FIX-12 先落地）。
- 任何 v2 hook 相关内容。
- 修改真实 change `refactor-vacation-duration-api` 的历史 evidence 文件。
