# Review Disclosure Fixed-Point 修订与实施交接 2026-06-10

> 用途：本文档是 disclosure 工作流的交接指令。与 `FIX_HANDOFF_2026-06-10.md`（基础 guard 修复）是两条独立工作线。
> **要解决的原始痛点**：子代理（reviewer）返回的 blocker / scope risk / open question / assumption 中，凡是需要用户裁决的内容，当前可以被主线程静默消化——主线程自行修改 artifact、重跑 reviewer 到 pass，用户从头到尾没见过原始问题和可选项就"被推进"了。隐藏手法有三种（见审查文档）：改分类降级（P0-2）、转述洗白（P1-1）、伪造用户决策（P0-1）。本工作线的全部产出都服务于：**需要用户确认的内容必须原文披露给用户、用户裁决必须被结构化记录并驱动重审，且历史 blocker 不可被重跑抹掉。**
> **前置依赖**：基础修复的 FIX-11（review_scope 合同）、FIX-12（悬空引用检查）应先落地或至少同会话先行实现——它们是本设计的地基。
> 必读输入（按顺序）：
> 1. `docs/proposals/superspec/REVIEW_DISCLOSURE_FIXED_POINT_DESIGN.md`——原设计稿（codex 起草，**含已知缺陷，不得直接实施**）。
> 2. `docs/proposals/superspec/REVIEW_DISCLOSURE_FIXED_POINT_REVIEW_2026-06-10.md`（v2）——对设计稿的专项审查：2 个 P0、6 个 P1、5 个 P2、轮次经济五规则（R1-R5）、可追溯性检查方法。**本文档是修订的权威依据。**
> 3. `docs/proposals/superspec/WORKFLOW_FULL_AUDIT_2026-06-10.md` 的 §9（实证审计）——特别是 H-1（omnibus refresh）与 H-2（批量补票），设计必须吸收这两个实证形态。
> 4. `docs/proposals/superspec/SPEC.md`——v1 audit-only 定位红线。

## Stage A：修订设计文档（纯文档工作，先于一切代码）

按 REVIEW 文档 §6 的清单逐项修订 `REVIEW_DISCLOSURE_FIXED_POINT_DESIGN.md`：

**"Phase 1 动工前必须完成"的 9 项**：

- [x] A1 P0-1 信任假设声明（覆盖删除/伪造/损坏三通道）+ 第 13 节成功标准措辞修正 + 引用完整性/round 连续性机检写入 §6 guard 规则 + v2 锚定通道预留。→ §2.2、§5 规则 8–9、§6 规则 13–14、§13。
- [x] A2 P0-2/P1-5 合并：分类 producer 合同 + disposition 身份字段逐字段相等 guard 规则。→ §4.1、§4.2、§6 规则 15、§8。
- [x] A3 P1-4 schema 字段补全：`route`/`route_reason`、`acknowledged_accepted_deviation_uids[]`、`supersedes_finding_uids[]`。→ §4.1、§4.2 示例与规则。
- [x] A4 P1-2/R3：ledger render 逐字节机检 + reviewer diff 验证义务。→ §3.1 R3、§6 规则 10/16、Phase 1 测试清单。
- [x] A5 P1-1 用户披露渲染契约。→ §4.2、§9.1（skill 模板待 Stage B4 落地）。
- [x] A6 P1-6 集合相等 stale 语义。→ §3 规则 7、§6 规则 4–5、§7。
- [x] A7 P2-1/R1：排序去时间化 + stale 惰性措辞。→ §3 规则 7、§4.2/§4.3 baseline 规则、§6 伪代码。
- [x] A8 轮次经济 R1–R5 + R4 写入非目标。→ §2.2、§3.1、§11 `escalate_round_budget`。
- [x] A9 可追溯性表。→ §6.1（18 条规则，含 FIX-12 已落地项标注）。

**Phase 4 语义但必须现在改文档的 2 项**：

- [x] A10 P1-3 继承表补 `review_complete`/`archive_ready` + change root 解析 + 决策 lineage。→ §4.2 继承表与 lineage 段。
- [x] A11 P2-4 final_test `code_fingerprint` 身份模型。→ §7、`§8` adjudication 引用方式。

**吸收实证发现的 2 项**：

- [x] A12 吸收 H-1：`review_scope[]` 合同（FIX-11 已代码落地，设计稿交叉引用）。→ §4.2 omnibus 段。
- [x] A13 吸收 H-2：批处理兼容、单次用户 checkpoint。→ §3.1 R2、§9.1。

**Stage A 出口**：✅ 2026-06-10 修订完成，见下方摘要。**暂停等用户确认**后才进入 Stage B。

### Stage A 修订摘要（2026-06-10）

| 主题 | 修订要点 |
| --- | --- |
| 信任模型 | v1 显式声明自报告天花板；引用完整性（FIX-12）+ round 连续性只加价不消除；v2 git/CLI 预留 |
| 分类防篡改 | reviewer 唯一 producer；disposition 身份逐字段相等机检 |
| Schema 补全 | `route`/`route_reason`、`acknowledged_accepted_deviation_uids[]`、`supersedes_finding_uids[]`、`code_fingerprint` |
| 收敛性 | ledger 工具渲染逐字节注入；accepted deviation 确认字段；3 轮预算 + `escalate_round_budget` |
| Stale 语义 | 集合相等（glob 闭合）；惰性判定；去时间化 |
| 轮次经济 | R2 两轮标准节奏；R3 增量合同；R4 拒绝伪捷径；R5 预算升级 |
| 继承/终局 | 继承表补至 `review_complete`→`archive_ready`；change root 解析；决策 lineage |
| 实证吸收 | H-1 review_scope（FIX-11）；H-2 批处理 checkpoint |
| 可追溯性 | §6.1 18 条 guard→schema→producer 映射表 |
| Grandfathering | Phase 5 补 P2-3 规则 |

## Stage B：实施 Phase 1（仅 `explore_complete`）

严格按修订后设计文档的 Phase 1 范围：

- [x] B1 schema 校验：`main_review_digest`、`user_review_decision`、`review_standing_authorization` 三种新 kind（注意与基础修复 FIX-7 的 kind 白名单合流）。→ `src/disclosure.ts` 四个 schema 函数（含 reviewer `findings[]` 校验），接入 `validate_evidence_schema`，kind 白名单已扩展。
- [x] B2 `review_targets_by_gate("explore_complete")` 显式表 + 集合相等 stale 判定。→ `REVIEW_TARGETS_BY_GATE` + `setMatches`（路径集合 + 逐路径 blob 完全相等，P1-6）。
- [x] B3 finding ledger 构建器（append-only，扫描含 superseded 的全部 evidence）+ `review_disclosure_complete` guard 检查。→ `build_finding_ledger` / `render_finding_ledger` / `review_disclosure_reasons`，内联进 `check_superspec_gate` 的 explore 分支。
- [x] B4 `superspec-explore` skill 修订：critic blocker → digest → 用户 A/B/C/D checkpoint → 改 discovery → rerun → clean 后过门。→ 模板与 `.codex/skills/superspec-explore/SKILL.md` 同步新增"审查披露循环"章节 + 步骤 8。
- [x] B5 测试：设计文档 Phase 1 测试清单全部 + 审查文档新增项（分类一致性 block、ledger 注入缺失 block、集合 stale、round 连续性等）。→ 18 个 `DISC` 测试组，覆盖全部 21 个新 reason code 的 block 路径 + 3 条 allow 路径（完整 D 选项闭环 / standing auth 单轮关闭 / grandfathered）；`npm test` 320/320 全绿。
- [x] B6 对真实 change `refactor-vacation-duration-api` 做 grandfathering 验证：新 guard 不得追溯 block 已通过的 explore gate（缺 digest 的历史 gate 维持原判定口径）。→ `check-enter --gate explore_complete` 仅剩用户已拍板接受的 3 个既有追溯 block（`human_confirmation_invalid`/`test_run_log_missing`/`review_scope_unverified`），无任何 disclosure 新码。

**Stage B 出口**：✅ 2026-06-10 完成。新 reason code 共 21 个：`review_finding_invalid`、`review_digest_invalid`、`user_decision_invalid`、`standing_authorization_invalid`、`missing_review_digest`、`needs_user_decision_pending`、`finding_unresolved`、`finding_undisclosed`、`review_round_stale`、`review_digest_stale`、`review_round_discontinuous`、`digest_chain_broken`、`finding_identity_mismatch`、`finding_summary_not_verbatim`、`user_decision_unbound`、`standing_authorization_unbound`、`artifact_update_required`、`rereview_required`、`accepted_deviation_unacknowledged`、`ledger_injection_missing`、`round_budget_exhausted`，全部有测试断言（延续 FIX-13 的 0 缺口对账口径）。round id 规范格式固定为 `<gate>-r<N>`（设计文档示例中的 `explore-r1` 简写以此为准）。

## Stage C：实施 Phase 2（`proposal_reviewed` / `design_complete`）

严格按修订后设计文档的 Phase 2 范围：

- [x] C1 `proposal_reviewed` 升级为 internal gate（不再是 advisory note）：`gates.ts` 新分支（require `explore_complete` + proposal done + critic review + 披露循环）；`propose_complete` 子门列表加入；`design_complete` 直接 require `proposal_reviewed`。
- [x] C2 Canonical state surfaces 全部更新：`ARTIFACT_ENTER_GATE`（`specs`/`design` → `proposal_reviewed`）、`GATE_ALIASES`（`propose.proposal_reviewed`）、`GATE_ROUTE`（→ `propose`）、`PROPOSE_REVIEW_TARGET_ARTIFACTS`（FIX-11 查重扩入 proposal→`proposal.md`）、`default_gate_next_actions`。
- [x] C3 Born-disclosure 强制：`DISCLOSURE_REQUIRED_GATES` 含 `proposal_reviewed`——无 round-tagged review + digest 一律 `missing_review_digest`，封死"用旧式 evidence 绕过披露"的洞（新 gate 无 legacy 人群，无 grandfather 路径）。
- [x] C4 design gate target map + 披露循环：`REVIEW_TARGETS_BY_GATE` 增加 `proposal_reviewed`（proposal+discovery）与 `design_complete`（proposal+design+`specs/**/*.md` glob+discovery）；`enumerate_review_targets` 支持 glob 枚举，集合相等（P1-6）使 digest 后新增 spec 文件即 stale。legacy design evidence 维持 grandfathered（P2-3）。
- [x] C5 route 合法性（P1-4，规则 12）：`DISCLOSURE_ROUTES` 全局枚举（schema 外 → `review_digest_invalid`）+ `DISCLOSURE_ROUTES_BY_GATE` 每 gate 子集（越界 → 新码 `finding_route_invalid`；proposal 的 discovery-incomplete 合法 route 是 `return_explore`）。
- [x] C6 skill 修订：`superspec-propose`（模板 + `.codex` 安装副本）删除"proposal review 不新增 guard gate / human confirmation pause"旧口径，新增 `proposal_reviewed` 披露循环步骤与 `check-enter --gate propose.proposal_reviewed`。
- [x] C7 测试：设计文档 Phase 2 清单全覆盖——6 个 `DISC2` 测试组（强制披露 / 静默修复 block / route 合法性 / design+specs+propose+tasks+artifact entry 全路径 require / glob 集合相等 stale / legacy grandfathered），加上既有 fixture（`prepareProposeComplete` 等）注入 proposal 披露 evidence 后全量回归。

**Stage C 出口**：✅ 2026-06-10 完成。新 reason code 2 个：`missing_proposal_review`、`finding_route_invalid`（其余复用 Phase 1 的 21 个码，`proposal_reviewed_failed` 为前置链 code），全部有测试断言。

## Stage D：实施 Phase 3（`invariants_reviewed` / `test_contract_drafted` / `tasks_complete`）

严格按修订后设计文档的 Phase 3 范围：

- [x] D1 `REVIEW_TARGETS_BY_GATE` 扩表：`invariants_reviewed`（business-invariants + design + specs glob）、`test_contract_drafted`（test-contract + invariants + design + specs glob）、`tasks_complete`（tasks + test-contract + invariants + design + specs glob）。
- [x] D2 `DISCLOSURE_ROUTES_BY_GATE` 扩表 + 全局新增 `return_test_contract_drafted`（tasks 验收口径问题回 test-contract gate）。
- [x] D3 `review_disclosure_reasons` 接入 `invariants_reviewed`、`test_contract_drafted`、`tasks_complete` 三个 gate 分支（legacy grandfathered；tasks 仅在有 round-tagged review 时激活）。
- [x] D4 `superspec-propose` skill 修订：design / invariants / test-contract / tasks 各步披露循环 + route 约束（模板 + `.codex` 安装副本同步）。
- [x] D5 测试：7 个 `DISC3` 测试组（invariants 强制披露 / upstream stale / route 矩阵 / test-contract glob stale / legacy grandfathered / tasks 条件激活 + legal route / root-mismatch 与逃逸 pinned path 集合不等 fail-closed——补齐设计 Phase 3 清单的 "target root mismatch" 项）。
- [x] D6 全量回归：`npm test` 326/326 全绿（含 skill smoke）。

**Stage D 出口**：✅ 2026-06-10 完成。Phase 3 无新增 reason code（复用 Phase 1-2 的 23 个码 + `return_test_contract_drafted` 作为 route 枚举扩展）。propose 期六个 disclosure gate 中已有五个接入（explore / proposal / design / invariants / test-contract / tasks 条件激活）。

> **用户裁决 2026-06-10（晚于 Stage D）**：真实 change `refactor-vacation-duration-api` 的历史现场（proposal/specs/design/tasks 与 `.superspec/` evidence、artifacts、旧 ledger）已由**用户有意清空**——该 change 仅为测试用途，旧式 evidence 无法补新结构字段，留着没有意义。自此各 Phase 的"真实 change 回归"基线不复存在，grandfathering 语义只靠测试 fixture（DISC/DISC2/DISC3 的 legacy grandfathered 用例）兜底；后续会话见到该 change 为空目录属预期，**不是事故，不要尝试恢复**。

## 明确不做

- Phase 4-5（final review 接入 main_adjudication、backfill/grandfathering 工具）——Phase 3 验收后另起。
- v2 可信通道（CLI nonce/签名、harness hook、git 锚定）——只在文档中预留，不实现。
- 修改真实 change 的历史 evidence。

## 验收

1. Stage A：修订后的设计文档通过审查文档 §6 清单逐项对照（可自查打勾），用户确认。✅
2. Stage B：`npm test` 全绿；新增测试覆盖 Phase 1 清单；真实 change 回归无追溯 block。✅ 2026-06-10（320/320；18 个 DISC 测试组；B6 无 disclosure 码）。
3. SPEC.md 同步：新增 evidence kinds、block codes、`explore_complete` 判定矩阵行更新。✅ §5.5 披露不动点条目 + §6.5 矩阵行 + §17 Guard 单元测试清单。
4. Stage C：`npm test` 全绿（含 6 个 DISC2 测试组）；SPEC.md §5.5/§6.5/§17 同步 Phase 2（`proposal_reviewed` 矩阵行、主链拓扑、route 枚举）；真实 change `refactor-vacation-duration-api` 的 explore gate 不受影响（注意：该 change 若要继续走 design/propose，需按新链先过 `proposal_reviewed`——用户已确认该 change 仅为测试用途，不处理）。✅ 2026-06-10。
5. Stage D：`npm test` 全绿（含 7 个 DISC3 测试组）；SPEC.md §5.5/§6.5/§17 同步 Phase 3（invariants/test-contract/tasks 矩阵行 + route `return_test_contract_drafted`）；legacy propose evidence 不被追溯 block。✅ 2026-06-10。
   > 续会修正 2026-06-10：上个会话挂掉时实际为 332 个测试 3 失败（C1 把 `proposal_reviewed` 插入主链后，3 个旧 fixture 未补链路证据：`review ready preserves propose actions` 的 next_actions 字符串、两个 `test contract drafted` allow fixture）。已修复并补 root-mismatch 测试，最终 333/333 全绿（修复时 332/332 + 新增 1）。
