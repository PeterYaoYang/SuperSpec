---
name: superspec-propose
description: "2.需求已经清楚后用：把探索记录（`discovery.md`）整理成正式方案包，包括方案说明（`proposal.md`）、需求规格（`specs/**`）、设计说明（`design.md`）、任务清单（`tasks.md`）、测试契约和业务约束；这一步只定方案，不写实现。"
metadata:
  author: SuperSpec
  source: SuperSpec
---

# SuperSpec Propose

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

在 explore 完成后使用本 skill，用于把探索记录整理成可执行的正式方案包。OpenSpec 负责生成标准方案文件，具体写法必须通过它自带的指令（`openspec instructions`）获取；SuperSpec 负责在外层增加审查门禁（gates）、业务约束（`business-invariants.md`）、测试契约（`test-contract.md`）和任务元数据。

## 边界 / Boundaries

- 先读取项目里的 OpenSpec propose 说明：`.codex/skills/openspec-propose/SKILL.md`。方案文件的生成顺序、`openspec status` 和 `openspec instructions` 的用法以它为准。
- SuperSpec 不采用“一次性把所有方案文件都生成完”的做法。本阶段不创建或选择 change，也不能绕过 SuperSpec 门禁检查一次性完成所有产物。`superspec-explore` 负责创建 change 和探索记录（`discovery.md`）；本 skill 负责按阶段检查来编写正式方案文件。
- OpenSpec 标准方案文件（`proposal.md`、`specs/**/*.md`、`design.md`、`tasks.md`）**必须**通过 `openspec instructions <artifact> --json` 编写，使用其返回的 `template`/`rules`/`context`。**不要手写这些文件绕过 OpenSpec 自带指令**，否则会丢失标准模板、项目上下文和校验一致性。
- Propose 阶段还要生成 SuperSpec 补充方案文件：`.superspec/artifacts/business-invariants.md` 和 `.superspec/artifacts/test-contract.md`。任务依赖、读写范围、TDD 元数据和映射关系直接写入 `tasks.md` 的结构化字段，不再维护单独的 JSON 任务图文件。
- 本阶段门禁检查包括：探索完成 `explore_complete`、方案说明已审查 `proposal_reviewed`（`propose.proposal_reviewed`）、设计已审查 `design_complete`（`propose.design_reviewed`）、业务约束已审查 `invariants_reviewed`（`propose.invariants_reviewed`）、测试契约已起草 `test_contract_drafted`（`propose.test_plan_drafted`）、任务映射已完成 `tasks_complete`（`propose.tasks_mapped`），以及最终 `propose_complete`。
- `proposal_reviewed` 是硬性 internal gate（DISC Phase 2），不是 advisory note：`proposal.md` 完成后必须运行带 `review_round_id`（`proposal_reviewed-r<N>`）和 `findings[]` 的 `critic` review，并由主流程记录审查问题记录（内部 evidence kind 为 `main_review_digest`）。guard 对该 gate 不提供 legacy 豁免——没有 round-tagged review + digest 一律 block。审查问题确认循环规则（关键 findings 必须经用户确认、findings 问题清单不可抹除、digest 链与轮次连续性）与 `superspec-explore` skill 的「审查问题确认循环 / Review Disclosure Loop」一节完全一致。
- `design_complete`、`invariants_reviewed`、`test_contract_drafted` 在出现 round-tagged review evidence 后进入同一确认循环（DISC Phase 3）；旧式无 `review_round_id`/`findings[]` 的 review evidence 维持 grandfathered 口径（P2-3），但**新写的 review 必须走完整确认循环**。
- `tasks_complete` 仅在新增 round-tagged role review 后才纳入确认循环（本 gate 本身不强制 role review；一旦 agent 为 tasks 写了带 findings 的 review，就必须完成 digest + 用户确认）。
- proposal review 的 route 约束：若 finding 证明探索记录本身不完整或范围（`scope`）不清，处理 route 必须是 `return_explore`（回 `superspec-explore` 补事实层），不得在 proposal 内静默补范围；仅措辞/意图不一致且不改范围时才可 `stay_same_gate_fix`。
- design review 的 route 约束：scope / non-goal 与上游不一致时用 `return_explore_or_proposal_reviewed`；设计边界/架构取舍用 `stay_same_gate_user_decision`。
- invariants / test-contract review 的 route 约束：业务语义/不变量真相不确定、验收标准（`acceptance`）变更等关键 finding 用 `stay_same_gate_user_decision`；若需回改 spec/design 表达，用 `return_explore_or_proposal_reviewed`。
- tasks review 的 route 约束：task 映射 / test_refs / read-write scope 问题用 `stay_same_gate_fix`；若验收标准本身错了，用 `return_test_contract_drafted` 回 test-contract gate，不得静默改 tasks 来处理关键 acceptance 问题。
- Role-gate evidence 必须来自 native subagents。v1 evidence 是 audit-only/self-reported；除非有 OpenSpec facts 支撑，不要把它描述成强制运行时事实。

## 步骤 / Steps

1. 运行前置门禁检查（`check-enter`），确认探索阶段已经完成：
   ```text
   superspec guard check-enter --change "<change>" --gate explore_complete
   ```
2. 从 OpenSpec 获取方案文件生成顺序：
   ```text
   openspec status --change "<change>" --json
   ```
   按 `openspec-propose` 的说明解析 `applyRequires`、`artifacts`（status + dependencies）、`planningHome`、`changeRoot`、`artifactPaths` 和 `actionContext`。按依赖顺序编写方案文件（proposal -> specs -> design -> tasks）。
3. 对每个状态为 `ready` 的 OpenSpec 方案文件，都通过 OpenSpec 自带指令编写：
   ```text
   openspec instructions <artifact-id> --change "<change>" --json
   ```
   - 读取依赖的方案文件和探索记录 `.superspec/artifacts/discovery.md` 作为上下文。
   - 使用 `template` 写入 `resolvedOutputPath`；把 `context`/`rules` 当约束使用，不要复制进产物正文。
   - 重新运行 `openspec status --change "<change>" --json`，确认该方案文件变为 `done`，再执行对应 SuperSpec 层。
4. 方案说明 `proposal.md` 编写并经 `openspec status` 确认为 `done` 后、开始 `specs/**`/`design.md` 前：执行 `proposal_reviewed` 确认循环：
   - 启动 `critic` native-subagent review，范围限定在方案范围、意图、非目标和隐藏假设；evidence 必须带 `review_round_id`（`proposal_reviewed-r<N>`）、`findings[]` 和 pinned `target_refs`（`proposal.md` + `.superspec/artifacts/discovery.md`）。
   - 主流程记录审查问题记录，给每个 finding 写处理结果：关键 findings（范围、非目标、验收标准、业务语义、设计边界）必须进入用户确认并停下来，用 AskUserQuestion 把原文和 A/B/C/D 选项展示给用户，拿到用户确认后才能继续；发现探索记录不完整时 route 用 `return_explore` 回 explore，不得自行补范围。
   - 修订 `proposal.md` 后必须重跑 `critic`（新一轮 round），直到 clean round + digest 通过，然后验证：
   ```text
   superspec guard check-enter --change "<change>" --gate propose.proposal_reviewed
   ```
   guard 未通过前不要开始编写 `specs/**` 或 `design.md`（两者的入口门禁都是 `proposal_reviewed`）。
5. 设计说明 `design.md` 编写后：获取 `architect`、`critic`、`test-engineer` 的 native-subagent review evidence（带 `review_round_id` `design_complete-r<N>` + `findings[]` + 全量 pinned target：`proposal.md` + `design.md` + `specs/**/*.md` + 探索记录）。主流程记录审查问题记录；关键问题必须停下来向用户说明并等待用户确认，按用户确认改 design/specs 后 supersede 旧轮并重审。对于设计选项选择和最终设计确认，使用 AskUserQuestion 并等待明确选择；记录 human-confirmation evidence，然后验证：
   ```text
   superspec guard check-enter --change "<change>" --gate propose.design_reviewed
   ```
6. 需求规格 `specs/**` 和设计说明 `design.md` 编写后、测试契约 `test-contract.md` 编写前：起草业务约束 `.superspec/artifacts/business-invariants.md`。每条 `INV-*` 必须有 statement、scope、source anchors、acceptance_refs、risk_refs、confidence、enforcement_level、test_refs_or_review_only_reason；记录 rejected candidates，防止把当前实现习惯误升格为业务真相。获取 `critic` + `test-engineer` review evidence（带 `review_round_id` `invariants_reviewed-r<N>` + `findings[]` + pinned target：business-invariants + design + specs glob）。主流程记录审查问题记录；关键业务语义问题必须进入用户确认，不得把实现习惯静默升格为 invariant 真相。然后验证：
   ```text
   superspec guard check-enter --change "<change>" --gate propose.invariants_reviewed
   ```
7. 业务约束 `business-invariants.md` 完成后、任务清单 `tasks.md` 编写前：起草测试契约 `.superspec/artifacts/test-contract.md`，覆盖 specs 中每个 `#### Scenario` 和命中本 change scope 的 hard `INV-*`，包含 TEST ids、关联 INV ids、预期 RED reasons、预期 GREEN criteria 和 commands。获取 `test-engineer` + `critic` review evidence（带 `review_round_id` `test_contract_drafted-r<N>` + `findings[]` + pinned target：test-contract + invariants + design + specs glob）。主流程记录审查问题记录；验收标准变更等关键问题必须用户确认。然后验证：
   ```text
   superspec guard check-enter --change "<change>" --gate propose.test_plan_drafted
   ```
8. 通过 `openspec instructions tasks` 编写任务清单 `tasks.md` 时：为每个 task 补充 `requirement_refs`、`invariant_refs`（必须是 business-invariants `INV-*` ids 的子集）、`test_refs`（必须是 test-contract TEST ids 的子集）、`read_scope`、`write_scope`、dependencies、TDD metadata，以及需要时的 parallel group。若 reviewer 对 task 映射提出 round-tagged findings，走 `tasks_complete-r<N>` 确认循环（pinned target：tasks + test-contract + invariants + design + specs glob）；验收标准问题 route 用 `return_test_contract_drafted`，映射问题用 `stay_same_gate_fix`。对于任务审查确认，使用 AskUserQuestion 并等待明确选择；记录 human-confirmation evidence，然后验证：
   ```text
   superspec guard check-enter --change "<change>" --gate propose.tasks_mapped
   ```
9. 验证 apply readiness：
   ```text
   superspec guard check-apply-ready --change "<change>"
   ```

遇到任何 guard `block` 就停止。
