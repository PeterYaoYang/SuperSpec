---
name: superspec-explore
description: "1.新需求刚开始时用：先把目标、范围、风险和现有代码事实弄清楚，产出探索记录（`discovery.md`）；这一步只探索，不写正式方案，也不改代码。"
metadata:
  author: SuperSpec
  source: SuperSpec
---

# SuperSpec Explore

## 语言规则 / Language

- 默认使用简体中文撰写所有人类可读产物、分析、报告、说明和 OpenSpec 文档正文。
- 保留命令、路径、JSON 字段、gate 名、task/test id、代码标识符和外部 API 名称的原文。
- 当 OpenSpec 模板要求固定标题或字段时，保留模板结构，只将正文内容写成中文。
- 对话窗口里的解释、问题说明、总结、提问和下一步说明必须使用中文；除命令、路径、字段名、代码标识符外，不要夹带英文说明词。
- 对话窗口、AskUserQuestion 文案、进度更新和最终总结不得裸露内部证据种类、字段名或 reason code；用户确认记录、审查问题记录、审查轮次编号、问题唯一标识等都只用中文业务说法。原始协议名只允许写在证据 JSON、代码、测试、精确命令输出或用户明确要求的诊断片段中。
- 本 skill 文档中的内部协议名只用于落盘证据或运行 guard；写给用户时必须先翻译成中文业务动作，例如“记录用户确认”“记录审查问题”“完成最终审查判断”。
- 向用户转述 guard / review 输出时，不要直接贴英文 `message`、`next_allowed_actions` 或英文模板标题；应改写为中文，并仅在需要定位内部协议时保留英文 code/command 于反引号中。

## 命令执行 / Shell

- Windows PowerShell 中执行 npm 全局 bin 时，必须显式使用 `.cmd` shim：`superspec.cmd ...`、`openspec.cmd ...`；不要运行 `superspec.ps1` 或 `openspec.ps1`。
- macOS、Linux、Git Bash、cmd.exe 或其他不会优先拦截 `.ps1` 的 shell 中，继续使用文档中的 `superspec ...`、`openspec ...` 命令。

在 init 之后、编写 OpenSpec proposal package 之前使用本 skill。

## 边界 / Boundaries

- 先桥接 repo-local OpenSpec explore skill：读取 `.codex/skills/openspec-explore/SKILL.md`，并按它的探索方式工作：像需求探索搭档一样帮助用户澄清目标、调查代码、比较方案和暴露风险，不急着下结论。
- 相比 OpenSpec 的原始探索模式，SuperSpec 增加了更严格的边界：**只思考和调查，不实现**。主流程可以读代码、搜索代码，并把发现写成探索记录（`discovery.md`）作为 evidence；但不能修改应用代码，也不能在本阶段编写 OpenSpec planning artifacts。如果调查过程中发现需要沉淀 proposal/specs/design/tasks，请先记录到探索记录（`discovery.md`），再交给 `superspec-propose`，由 `openspec instructions` 生成 OpenSpec artifacts。
- Explore 只产出需求和上下文证据；不完成 OpenSpec proposal、specs、design 或 tasks。
- 需求 critique evidence 必须来自 repo-local `critic` native subagent。
- v1 evidence 是 audit-only/self-reported；除非有 OpenSpec facts 支撑，不要把它描述成强制运行时事实。

## 范围收敛透明度 / Scope Transparency

- Agent 可以在 explore/propose 前基于证据收敛范围，但不得静默收窄用户目标。
- 当用户目标、现有实现或合理利益相关方预期自然覆盖多个层级、模块、入口、流程、角色或行为，而探索记录、proposal 或 design 只准备覆盖其中一部分时，必须显式记录纳入范围、排除范围、排除理由、已知或可合理推断的影响，以及仍未知但会影响范围判断的风险。
- 不能把“本轮先做最小改动”“默认不处理其他模块”“按当前实现猜测无影响”作为隐式排除理由；这些都必须写成可审查的范围决策。
- `critic` 必须拦住未说明的关键范围收窄：如果范围收敛会改变用户合理预期、验收标准、兼容承诺、测试边界或后续实现风险，而 artifact 没有说明纳入/排除/理由/影响，则不能通过 explore/propose handoff。

## 审查问题确认循环 / Review Disclosure Loop（DISC Phase 1）

多角色审查发现的问题**不允许主流程自行处理掉**。关键问题包括：范围（`scope`）、非目标（`non_goal`）、验收标准（`acceptance`）、业务语义（`business_semantics`）、设计边界（`design_boundary`）。这些问题必须按原文展示给用户，拿到用户确认后才能继续。

- critic review evidence 必须携带 `review_round_id`（形如 `explore_complete-r<N>`，从 r1 连续编号）和结构化 `findings[]`：每条 finding 含 `finding_id`、`finding_uid`（`<gate>:<evidence_id>:<finding_id>`）、`finding_type`（`blocker|scope_risk|open_question|agent_assumption|non_blocking_finding`）、`category`、`material_categories[]`、关键问题的 `decision_scope_key`，以及 reviewer 原话 `summary`。分类字段由 reviewer 产生，主流程不得改写（P0-2）。
- 每轮审查后主流程写 `kind:"main_review_digest"` evidence（`created_by:"main-thread"`），逐条覆盖该轮所有 findings：身份字段与 `summary` **逐字拷贝**原始 finding，给出 `disposition`（`fixed|false_positive|accepted_deviation|user_decided|needs_user_decision`）、`rationale`、`route`/`route_reason` 和每种处理结果的证据；`target_refs` 固定记录当前探索记录内容；`source_review_evidence_refs` 引用本轮全部 role review；round>1 时 `previous_digest_refs` 串接上一轮记录。
- **关键 finding 一律走用户确认点**：内部先写审查问题记录 evidence（JSON kind 为 `main_review_digest`，`status:"blocked"` + `needs_user_decision`），然后把 finding 原文 + A/B/C/D 选项 +（每个选项对范围、非目标、验收标准、测试边界的影响）呈现给用户。用户确认记录 evidence 的 JSON kind 为 `user_review_decision`（`created_by:"user"`，`finding_uids` 精确到 `finding_uid`，`decision_scope_key`、`material_categories[]`、`confirmed_refs` 固定记录用户看到的 blob）。D 选项必须保留 `user_text` 原文并填 `structured_decision`（scope/non_goals/acceptance_impact/test_impact + requires_artifact_update/requires_rereview 布尔值）。
- 用户确认导致探索记录修改后：更新 artifact → supersede 过期的旧轮 review → 重跑 critic（round k>1 的 prompt **必须**内嵌工具生成的问题清单，由 `render_finding_ledger` 生成，guard 逐字校验）→ 写新一轮 `main_review_digest`（最终处理结果引用 `user_decision_refs`，artifact 修改时附 `artifact_update_refs`）。
- 关键 finding 的任何最终处理结果（含 `fixed`/`false_positive`）必须引用 `user_decision_refs[]`、有效 `standing_authorization_refs[]` 或 `baseline_decision_refs[]`；standing authorization 只能由用户创建、按 category 授权、永不覆盖 blocker。
- finding history 是 append-only：旧 blocker 不会因 clean 重审而消失，必须拿到最终处理结果；同一 gate 超过 3 轮仍未处理完成时停止迭代，把未决 findings 整体升级给用户（`escalate_round_budget`）。
- 历史 change 的旧式 critic evidence（无 `review_round_id`/`findings[]`）维持原判定口径，不被追溯 block。

## 步骤 / Steps

1. 确保项目级 SuperSpec surfaces 已存在：
   ```text
   superspec init --scope project
   ```
2. 创建或打开 native OpenSpec change root，然后确认 change-scoped guard readiness 并拉取 native context：
   ```text
   openspec new change "<change>"   # 仅当该 change 不存在时执行
   superspec guard check-init --change "<change>"
   openspec list --json
   openspec status --change "<change>" --json   # changeRoot / artifactPaths / actionContext for grounding
   ```
3. 按 OpenSpec 的探索方式工作，同时遵守 SuperSpec 输出边界：可以自由调查和澄清，但本阶段只写 SuperSpec sidecar evidence。
4. 主流程直接调查当前实现：定位相关文件、隐藏契约、约束、风险和 source anchors。
5. 启动 repo-local `critic` native subagent（round r1），审查歧义、遗漏场景、矛盾、scope risk 和范围收敛透明度；如存在未显式说明的关键范围收窄，critic 必须 block。critic 输出按上方确认循环要求落成带 `review_round_id` + `findings[]` 的 evidence。
6. 写入合并后的探索记录文件：
   ```text
   openspec/changes/<change>/.superspec/artifacts/discovery.md
   ```
7. 在 `.superspec/evidence/discovery/` 记录 critic evidence，包含 `execution_mode:"native_subagent"`、`agent_role`、`agent_id`、`output_ref`、`source_anchors` 和 `target_refs`。
8. 按确认循环处理 findings：写本轮审查问题记录；存在关键问题时**停下来向用户说明并等待用户确认**，再按用户确认更新探索记录 / 重跑 critic / 写新一轮记录，直到最新轮 clean 且问题清单里没有未处理完的问题。
9. 运行进入阶段前检查（`check-enter`），验证 explore completion：
   ```text
   superspec guard check-enter --change "<change>" --gate explore_complete
   ```

遇到任何 guard `block` 就停止。用户确认相关阻塞原因包括：缺少审查问题记录（`missing_review_digest`）、等待用户确认（`needs_user_decision_pending`）、历史 finding 未处理完（`finding_unresolved`）、用户确认未绑定（`user_decision_unbound`）、缺少 finding 问题清单（`ledger_injection_missing`）、审查轮次已达上限（`round_budget_exhausted`）等。它们的唯一合法出路是回到确认循环或升级给用户，不允许绕过。
