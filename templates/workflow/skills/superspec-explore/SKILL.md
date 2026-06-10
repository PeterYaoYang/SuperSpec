---
name: superspec-explore
description: "1.探索并澄清需求，进入 SuperSpec propose 前完成 OpenSpec explore 立场和 critic 复核。 / Explore and clarify requirements before SuperSpec propose, adopting OpenSpec's explore stance plus critic review."
---

# SuperSpec Explore

## 语言规则 / Language

- 默认使用简体中文撰写所有人类可读产物、分析、报告、说明和 OpenSpec 文档正文。
- 保留命令、路径、JSON 字段、gate 名、task/test id、代码标识符和外部 API 名称的原文。
- 当 OpenSpec 模板要求固定标题或字段时，保留模板结构，只将正文内容写成中文。

在 init 之后、编写 OpenSpec proposal package 之前使用本 skill。

## 边界 / Boundaries

- 先桥接 repo-local OpenSpec explore skill：读取 `.codex/skills/openspec-explore/SKILL.md`，并遵守其中的 explore 立场与 `OpenSpec Awareness` 指引。
- SuperSpec 在 OpenSpec explore 之上增加更严格的边界：**只思考和调查，不实现**。主线程可以读代码、搜索代码并创建 `discovery.md` evidence，但不能修改应用代码，也不能在本阶段编写 OpenSpec planning artifacts。如果 OpenSpec explore 建议把决策沉淀到 proposal/specs/design/tasks，请先记录到 discovery，再交给 `superspec-propose`，由 `openspec instructions` 生成 OpenSpec artifacts。
- Explore 只产出需求和上下文证据；不完成 OpenSpec proposal、specs、design 或 tasks。
- 需求 critique evidence 必须来自 repo-local `critic` native subagent。
- v1 evidence 是 audit-only/self-reported；除非有 OpenSpec facts 支撑，不要把它描述成强制运行时事实。

## 范围收敛透明度 / Scope Transparency

- Agent 可以在 explore/propose 前基于证据收敛范围，但不得静默收窄用户目标。
- 当用户目标、现有实现或合理利益相关方预期自然覆盖多个层级、模块、入口、流程、角色或行为，而 discovery/proposal/design 只准备覆盖其中一部分时，必须显式记录纳入范围、排除范围、排除理由、已知或可合理推断的影响，以及仍未知但会影响范围判断的风险。
- 不能把“本轮先做最小改动”“默认不处理其他模块”“按当前实现猜测无影响”作为隐式排除理由；这些都必须写成可审查的范围决策。
- `critic` 必须阻塞未说明的关键范围收窄：如果范围收敛会改变用户合理预期、验收口径、兼容承诺、测试边界或后续实现风险，而 artifact 没有说明纳入/排除/理由/影响，则不能通过 explore/propose handoff。

## 审查披露循环 / Review Disclosure Loop（DISC Phase 1）

多角色审查发现的问题**不允许主线程自行消化**。material 问题（`scope` / `non_goal` / `acceptance` / `business_semantics` / `design_boundary`）必须以原文披露给用户，拿到用户裁决后才能继续。

- critic review evidence 必须携带 `review_round_id`（形如 `explore_complete-r<N>`，从 r1 连续编号）和结构化 `findings[]`：每条 finding 含 `finding_id`、`finding_uid`（`<gate>:<evidence_id>:<finding_id>`）、`finding_type`（`blocker|scope_risk|open_question|agent_assumption|non_blocking_finding`）、`category`、`material_categories[]`、material 时的 `decision_scope_key`，以及 reviewer 原话 `summary`。分类字段的 producer 是 reviewer，主线程不得改写（P0-2）。
- 每轮审查后主线程写 `kind:"main_review_digest"` evidence（`created_by:"main-thread"`），逐条覆盖该轮所有 findings：身份字段与 `summary` **逐字拷贝** origin finding，给出 `disposition`（`fixed|false_positive|accepted_deviation|user_decided|needs_user_decision`）、`rationale`、`route`/`route_reason` 和 per-disposition proof；`target_refs` 钉住当前 discovery blob；`source_review_evidence_refs` 引用本轮全部 role review；round>1 时 `previous_digest_refs` 串接上一轮 digest。
- **material finding 一律走用户 checkpoint**：digest 先以 `status:"blocked"` + `needs_user_decision` 记录，然后把 finding 原文 + A/B/C/D 选项 +（每个选项对 scope / non-goals / acceptance / tests 的影响面）呈现给用户。用户裁决记录为 `kind:"user_review_decision"`（`created_by:"user"`，`finding_uids` 精确到 `finding_uid`，`decision_scope_key`、`material_categories[]`、`confirmed_refs` 钉住用户看到的 blob）。D 选项必须保留 `user_text` 原文并填 `structured_decision`（scope/non_goals/acceptance_impact/test_impact + requires_artifact_update/requires_rereview 布尔值）。
- 用户裁决导致 discovery 修改后：更新 artifact → supersede 过期的旧轮 review → 重跑 critic（round k>1 的 prompt **必须**内嵌工具渲染的 finding ledger，由 `render_finding_ledger` 生成，guard 逐字校验）→ 写新一轮 digest（终态 disposition 引用 `user_decision_refs`，artifact 修改时附 `artifact_update_refs`）。
- material finding 的任何终态 disposition（含 `fixed`/`false_positive`）必须引用 `user_decision_refs[]`、有效 `standing_authorization_refs[]` 或 `baseline_decision_refs[]`；standing authorization 只能由用户创建、按 category 授权、永不覆盖 blocker。
- finding history 是 append-only：旧 blocker 不会因 clean 重审而消失，必须拿到终态 disposition；同 gate 超过 3 轮仍未收敛时停止迭代，把未决 findings 整体升级给用户（`escalate_round_budget`）。
- 历史 change 的旧式 critic evidence（无 `review_round_id`/`findings[]`）维持原判定口径，不被追溯 block。

## 步骤 / Steps

1. 确保项目级 SuperSpec surfaces 已存在：
   ```bash
   "${SUPERSPEC_INIT:-./node_modules/.bin/superspec-init}"
   ```
2. 创建或打开 native OpenSpec change root，然后确认 change-scoped guard readiness 并拉取 native context：
   ```bash
   openspec new change "<change>"   # 仅当该 change 不存在时执行
   "${SUPERSPEC_GUARD:-./node_modules/.bin/superspec-guard}" check-init --change "<change>"
   openspec list --json
   openspec status --change "<change>" --json   # changeRoot / artifactPaths / actionContext for grounding
   ```
3. 保持 OpenSpec explore 立场，同时遵守 SuperSpec 输出边界：可以自由调查和澄清，但本阶段只写 SuperSpec sidecar evidence。
4. 主线程直接调查当前实现：定位相关文件、隐藏契约、约束、风险和 source anchors。
5. 启动 repo-local `critic` native subagent（round r1），审查歧义、遗漏场景、矛盾、scope risk 和范围收敛透明度；如存在未显式说明的关键范围收窄，critic 必须 block。critic 输出按上方披露循环要求落成带 `review_round_id` + `findings[]` 的 evidence。
6. 写入合并后的 discovery artifact：
   ```text
   openspec/changes/<change>/.superspec/artifacts/discovery.md
   ```
7. 在 `.superspec/evidence/discovery/` 记录 critic evidence，包含 `execution_mode:"native_subagent"`、`agent_role`、`agent_id`、`output_ref`、`source_anchors` 和 `target_refs`。
8. 按披露循环处理 findings：写本轮 `main_review_digest`；存在 material finding 时**停下来向用户披露并等待 `user_review_decision`**，再按裁决更新 discovery / 重跑 critic / 写新一轮 digest，直到最新轮 clean 且 ledger 无未终态 finding。
9. 验证 explore completion：
   ```bash
   "${SUPERSPEC_GUARD:-./node_modules/.bin/superspec-guard}" check-enter --change "<change>" --gate explore_complete
   ```

遇到任何 guard `block` 就停止。disclosure 相关 block（`missing_review_digest`、`needs_user_decision_pending`、`finding_unresolved`、`user_decision_unbound`、`ledger_injection_missing`、`round_budget_exhausted` 等）的唯一合法出路是回到披露循环或升级给用户，不允许绕过。
