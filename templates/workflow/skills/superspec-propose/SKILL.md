---
name: superspec-propose
description: "2.生成 SuperSpec propose 包，将 artifact 编写委托给 OpenSpec `openspec instructions`，并叠加 SuperSpec design review / business-invariants / test-contract / tasks gates。 / Produce the SuperSpec propose package by delegating artifact authoring to OpenSpec `openspec instructions`, with SuperSpec design review / business-invariants / test-contract / tasks gates layered on top."
---

# SuperSpec Propose

## 语言规则 / Language

- 默认使用简体中文撰写所有人类可读产物、分析、报告、说明和 OpenSpec 文档正文。
- 保留命令、路径、JSON 字段、gate 名、task/test id、代码标识符和外部 API 名称的原文。
- 当 OpenSpec 模板要求固定标题或字段时，保留模板结构，只将正文内容写成中文。

在 explore 完成后使用本 skill，用于生成完整 OpenSpec planning package。Artifact 编写必须委托给 OpenSpec native instruction engine（`openspec instructions`）；SuperSpec 只在其外层增加 adversarial review gates、sidecar business invariants、sidecar test contract 和 tasks metadata。

## 边界 / Boundaries

- 先桥接 repo-local OpenSpec propose skill：读取 `.codex/skills/openspec-propose/SKILL.md`，并复用其中的 artifact-order / `openspec status` / `openspec instructions` 编写协议。
- SuperSpec 覆盖 OpenSpec propose skill 的 one-shot completion 形态：本阶段不创建或选择 change，也不能不经 SuperSpec gates 一次性完成所有 artifacts。`superspec-explore` 负责 change 创建和 discovery；本 skill 负责 gated artifact authoring。
- OpenSpec artifacts（`proposal.md`、`specs/**/*.md`、`design.md`、`tasks.md`）**必须**通过 `openspec instructions <artifact> --json` 编写，使用其返回的 `template`/`rules`/`context`。**不要手写 OpenSpec artifacts 绕过 native engine**，否则会丢失 schema template、project context 和 validation alignment。
- Propose 阶段拥有 SuperSpec sidecar planning artifacts：`.superspec/artifacts/business-invariants.md`、`.superspec/artifacts/test-contract.md`。任务依赖、读写范围、TDD 元数据和映射关系直接写入 `tasks.md` 的结构化字段，不再维护单独的 JSON 任务图文件。
- Internal propose gates：`explore_complete`、`proposal_reviewed`（`propose.proposal_reviewed`）、`design_complete`（`propose.design_reviewed`）、`invariants_reviewed`（`propose.invariants_reviewed`）、`test_contract_drafted`（`propose.test_plan_drafted`）、`tasks_complete`（`propose.tasks_mapped`）、最终 `propose_complete`。
- `proposal_reviewed` 是硬性 internal gate（DISC Phase 2），不是 advisory note：`proposal.md` 完成后必须运行带 `review_round_id`（`proposal_reviewed-r<N>`）和 `findings[]` 的 `critic` review，并由主线程记录 `main_review_digest`。guard 对该 gate 不提供 legacy 豁免——没有 round-tagged review + digest 一律 block。审查披露循环规则（material findings 必须经 `user_review_decision` 用户裁决、findings ledger 不可抹除、digest 链与轮次连续性）与 `superspec-explore` skill 的「审查披露循环 / Review Disclosure Loop」一节完全一致。
- `design_complete`、`invariants_reviewed`、`test_contract_drafted` 在出现 round-tagged review evidence 后进入同一披露循环（DISC Phase 3）；旧式无 `review_round_id`/`findings[]` 的 review evidence 维持 grandfathered 口径（P2-3），但**新写的 review 必须走完整披露**。
- `tasks_complete` 仅在新增 round-tagged role review 后才纳入披露循环（本 gate 本身不强制 role review；一旦 agent 为 tasks 写了带 findings 的 review，就必须 digest + 用户裁决闭环）。
- proposal review 的 route 约束：若 finding 证明 discovery 本身不完整或 scope 不清，处置 route 必须是 `return_explore`（回 `superspec-explore` 补事实层），不得在 proposal 内静默补范围；仅措辞/意图不一致且不改 scope 时才可 `stay_same_gate_fix`。
- design review 的 route 约束：scope / non-goal 与上游不一致时用 `return_explore_or_proposal_reviewed`；设计边界/架构取舍用 `stay_same_gate_user_decision`。
- invariants / test-contract review 的 route 约束：业务语义/不变量真相不确定、验收口径变更等 material finding 用 `stay_same_gate_user_decision`；若需回改 spec/design 表达，用 `return_explore_or_proposal_reviewed`。
- tasks review 的 route 约束：task 映射 / test_refs / read-write scope 问题用 `stay_same_gate_fix`；若验收口径本身错了，用 `return_test_contract_drafted` 回 test-contract gate，不得静默改 tasks 消化 material acceptance 问题。
- Role-gate evidence 必须来自 native subagents。v1 evidence 是 audit-only/self-reported；除非有 OpenSpec facts 支撑，不要把它描述成强制运行时事实。

## 步骤 / Steps

1. 验证 explore completion：
   ```bash
   "${SUPERSPEC_GUARD:-./node_modules/.bin/superspec-guard}" check-enter --change "<change>" --gate explore_complete
   ```
2. 从 OpenSpec 获取 artifact build order：
   ```bash
   openspec status --change "<change>" --json
   ```
   按 `openspec-propose` 的说明解析 `applyRequires`、`artifacts`（status + dependencies）、`planningHome`、`changeRoot`、`artifactPaths` 和 `actionContext`。按依赖顺序编写 artifacts（proposal -> specs -> design -> tasks）。
3. 对每个状态为 `ready` 的 OpenSpec artifact，都通过 native engine 编写：
   ```bash
   openspec instructions <artifact-id> --change "<change>" --json
   ```
   - 读取 `dependencies` artifacts 和 `.superspec/artifacts/discovery.md` 作为上下文。
   - 使用 `template` 写入 `resolvedOutputPath`；把 `context`/`rules` 当约束使用，不要复制进产物正文。
   - 重新运行 `openspec status --change "<change>" --json`，确认 artifact 变为 `done`，再执行对应 SuperSpec 层。
4. `proposal.md` 编写并经 `openspec status` 确认为 `done` 后、开始 `specs/**`/`design.md` 前：执行 `proposal_reviewed` 披露循环：
   - 启动 `critic` native-subagent review，范围限定在 proposal 的 scope / intent / non-goals / hidden assumptions；evidence 必须带 `review_round_id`（`proposal_reviewed-r<N>`）、`findings[]` 和 pinned `target_refs`（`proposal.md` + `.superspec/artifacts/discovery.md`）。
   - 主线程记录 `main_review_digest`，给每个 finding 写处置：material findings（scope / non_goal / acceptance / business_semantics / design_boundary）必须 `needs_user_decision` 并停下来，用 AskUserQuestion 把原文和 A/B/C/D 选项抛给用户，拿到 `user_review_decision` 后才能继续；发现 discovery 不完整时 route 用 `return_explore` 回 explore，不得自行补范围。
   - 修订 `proposal.md` 后必须重跑 `critic`（新一轮 round），直到 clean round + digest 通过，然后验证：
   ```bash
   "${SUPERSPEC_GUARD:-./node_modules/.bin/superspec-guard}" check-enter --change "<change>" --gate propose.proposal_reviewed
   ```
   guard 未放行前不要开始编写 `specs/**` 或 `design.md`（两者的 artifact entry gate 都是 `proposal_reviewed`）。
5. `design.md` 编写后：获取 `architect`、`critic`、`test-engineer` 的 native-subagent review evidence（带 `review_round_id` `design_complete-r<N>` + `findings[]` + 全量 pinned target：`proposal.md` + `design.md` + `specs/**/*.md` + discovery）。主线程记录 `main_review_digest`；material findings 必须停下来向用户披露并等待 `user_review_decision`，按裁决改 design/specs 后 supersede 旧轮并重审。对于 design option selection 和 final design confirmation，使用 AskUserQuestion 并等待明确选择；记录 human-confirmation evidence，然后验证：
   ```bash
   "${SUPERSPEC_GUARD:-./node_modules/.bin/superspec-guard}" check-enter --change "<change>" --gate propose.design_reviewed
   ```
6. `specs/**` 和 `design.md` 编写后、`test-contract.md` 编写前：起草 `.superspec/artifacts/business-invariants.md`。每条 `INV-*` 必须有 statement、scope、source anchors、acceptance_refs、risk_refs、confidence、enforcement_level、test_refs_or_review_only_reason；记录 rejected candidates，防止把当前实现习惯误升格为业务真相。获取 `critic` + `test-engineer` review evidence（带 `review_round_id` `invariants_reviewed-r<N>` + `findings[]` + pinned target：business-invariants + design + specs glob）。主线程记录 `main_review_digest`；material 业务语义 finding 必须 `needs_user_decision` 并等待用户裁决，不得把实现习惯静默升格为 invariant 真相。然后验证：
   ```bash
   "${SUPERSPEC_GUARD:-./node_modules/.bin/superspec-guard}" check-enter --change "<change>" --gate propose.invariants_reviewed
   ```
7. `business-invariants.md` 完成后、`tasks.md` 编写前：起草 `.superspec/artifacts/test-contract.md`，覆盖 specs 中每个 `#### Scenario` 和命中本 change scope 的 hard `INV-*`，包含 TEST ids、关联 INV ids、预期 RED reasons、预期 GREEN criteria 和 commands。获取 `test-engineer` + `critic` review evidence（带 `review_round_id` `test_contract_drafted-r<N>` + `findings[]` + pinned target：test-contract + invariants + design + specs glob）。主线程记录 `main_review_digest`；验收口径变更等 material finding 必须用户裁决。然后验证：
   ```bash
   "${SUPERSPEC_GUARD:-./node_modules/.bin/superspec-guard}" check-enter --change "<change>" --gate propose.test_plan_drafted
   ```
8. 通过 `openspec instructions tasks` 编写 `tasks.md` 时：为每个 task 补充 `requirement_refs`、`invariant_refs`（必须是 business-invariants `INV-*` ids 的子集）、`test_refs`（必须是 test-contract TEST ids 的子集）、`read_scope`、`write_scope`、dependencies、TDD metadata，以及需要时的 parallel group。若 reviewer 对 task 映射提出 round-tagged findings，走 `tasks_complete-r<N>` 披露循环（pinned target：tasks + test-contract + invariants + design + specs glob）；验收口径问题 route 用 `return_test_contract_drafted`，映射问题用 `stay_same_gate_fix`。对于 tasks review confirmation，使用 AskUserQuestion 并等待明确选择；记录 human-confirmation evidence，然后验证：
   ```bash
   "${SUPERSPEC_GUARD:-./node_modules/.bin/superspec-guard}" check-enter --change "<change>" --gate propose.tasks_mapped
   ```
9. 验证 apply readiness：
   ```bash
   "${SUPERSPEC_GUARD:-./node_modules/.bin/superspec-guard}" check-apply-ready --change "<change>"
   ```

遇到任何 guard `block` 就停止。
