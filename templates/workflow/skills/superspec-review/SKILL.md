---
name: superspec-review
description: "4.代码任务做完后用：让 reviewer、architect 和 critic 检查实现，跑最终验证，判断能不能进入归档；有问题就退回修。"
metadata:
  author: SuperSpec
  source: SuperSpec
---

# SuperSpec Review

在 implementation tasks 完成后使用本 skill。它完成一个合并后的 review 阶段：实现代码审查 guidance、SuperSpec critic guidance、最终验证、主流程最终判断（`main_adjudication`）和 `review_complete` guard 检查。旧 `superspec-verify` / `check-verify-ready` 只是兼容入口，不再作为独立 user-visible workflow。

## 语言规则 / Language

- 默认使用简体中文撰写所有人类可读产物、分析、报告、说明和 OpenSpec 文档正文。
- 保留命令、路径、JSON 字段、gate 名、task/test id、代码标识符和外部 API 名称的原文。
- 当 OpenSpec 模板要求固定标题或字段时，保留模板结构，只将正文内容写成中文。
- 对话窗口里的解释、审查结论、验证结论、提问和下一步说明必须使用中文；除命令、路径、字段名、代码标识符外，不要夹带英文说明词。
- 对话窗口、AskUserQuestion 文案、进度更新和最终总结不得裸露内部证据种类、字段名或 reason code；用户确认记录、审查问题记录、审查轮次编号、问题唯一标识等都只用中文业务说法。原始协议名只允许写在证据 JSON、代码、测试、精确命令输出或用户明确要求的诊断片段中。
- 本 skill 文档中的内部协议名只用于落盘证据或运行 guard；写给用户时必须先翻译成中文业务动作，例如“记录用户确认”“记录审查问题”“完成最终审查判断”。
- 用户可见文案不得使用“裁决”描述用户动作；统一说“确认”“范围取舍”“处理方式选择”或“用户确认记录”。
- 普通 workflow 命令使用 `--format agent` 读取 guard/init 输出；`--format json` 只用于诊断 evidence/schema/guard 内部，不得作为默认模型上下文或直接转述给用户。
- 向用户转述 guard / review / verification 输出时，不要直接贴英文 `message`、`next_allowed_actions`、`Summary`、`Justification`、`PASS/FAIL` 等模板词；应改写为中文，并仅在需要定位内部协议时保留英文 code/command 于反引号中。

## 命令执行 / Shell

- Windows PowerShell 中执行 npm 全局 bin 时，必须显式使用 `.cmd` shim：`superspec.cmd ...`、`openspec.cmd ...`；不要运行 `superspec.ps1` 或 `openspec.ps1`。
- macOS、Linux、Git Bash、cmd.exe 或其他不会优先拦截 `.ps1` 的 shell 中，继续使用文档中的 `superspec ...`、`openspec ...` 命令。

## 上下文读取纪律 / Context Budget

- guard 可以在本地读取完整 `.superspec/evidence/**/*.json` 并重算判定；主流程默认不要打开完整 evidence JSON，除非正在排查 guard block、修复 schema，或用户明确要求诊断原文。
- 主流程默认只读取 guard decision、当前 review 必要 artifact、native subagent `output_ref` 的摘要/结论段、`required_load_refs` 指向的关键 source，以及 final verification 的摘要。
- `source_refs` 只是可追溯来源，不等于必须读取；只有 `required_load_refs` 是主流程必须亲自读取并写入 `loaded_refs` 的内容。
- raw log、长报告和历史 superseded evidence 默认只作为引用、hash 或摘要保留；不要把全文复制进对话上下文或新的 evidence。
- guard-only read 不能替代主流程的 `loaded_refs`：凡进入 `required_load_refs` 的材料，主流程必须真实读取后再写 `main_adjudication`。

## 硬边界

- `review_complete` 是 allow-only gate。只有 `main_adjudication.review_decision:"allow"` 才允许进入 `check-review-complete` / `archive_ready`。
- allow path 的 `review_complete` 必须包含 `kind:"source_guidance"`（`code-reviewer`、`architect`、`critic`）、`kind:"verification_review"`（`verifier`、`critic`）、`kind:"final_test"` 和非角色 `kind:"main_adjudication"`；其中 `openspec validate` 输出必须被 `verification_review.openspec_validate_ref` 引用。`request_changes` 分支不应伪装成 `review_complete`。
- `superspec-review` 直接拥有并执行 repo-local review 协议：本阶段必须先启动 `code-reviewer`、`architect`、`critic` native subagent 产出 `source_guidance`；若走 allow path，再完成 final verification；随后由主流程读取关键 source 与必要的 verification evidence，写出唯一 `main_adjudication`。
- 不要把 code review 外包给全局/独立 `code-review` skill、OMX runtime workflow 或普通 markdown 报告；不需要单独安装 `code-review` skill。全局 `code-review` skill 只能作为机制参考，gate 只认 repo-local SuperSpec role surfaces 和 `.superspec` evidence schema。
- 所有 review / critic / verifier role evidence 都必须来自 repo-local native subagents。不要用 main-thread self-review、同名 global prompt、普通 markdown 报告或 `execution_mode:"direct"` 替代。
- review-phase native subagent 只能给 guidance，不能替代主流程最终判断。主流程必须在读取关键 source 与 verification evidence 之后，通过 `main_adjudication` 显式记录：看了哪些关键 source、采纳或驳回了哪些 claim、最终为什么 allow/block。
- `main_adjudication` 的作者边界固定为 `execution_mode:"direct"` + `created_by:"main-thread"`；它不得携带 `agent_role`、`agent_id`、`prompt_ref`。不要留“像主流程”的自由格式。
- review 没有直接回改 `tasks.md` 的权限。若 review 认定“原已完成 task 的完成证明失效”，主流程只能写出结构化 `request_changes` 判断，为 apply 提供 reopen 授权；不要在 review 阶段直接把 task 从 `[x]` 改回 `[ ]`。
- `review_decision:"request_changes"` 必须显式声明路由：`request_changes_route:"reopen_tasks"` 表示回 apply 返工既有 task；`request_changes_route:"change_update"` 表示回 propose / change update。不要把需求/范围/设计问题伪装成 task reopen。
- `review_decision:"request_changes"` 时，`verification_evidence_refs` 必须为空；不要在 request-changes round 里补写 allow-path verification 再尝试过 `review_complete`。
- 路由判断遵循单值优先级：只要同一轮 review 中仍存在任何必须回 propose / change update 的 blocker，`request_changes_route` 就必须取 `change_update`；只有当所有未解决 blocker 都可由既有 task 返工处理完时，才允许取 `reopen_tasks`。
- `task_reopen`、配套 `status:"superseded"` evidence 和 `task_reopen_resolved` 不由 review 写入；它们的作者边界固定在 `superspec-apply` 主流程。
- 阻塞 findings 必须有 dispositions 和 rollback targets。遇到任何 guard `block` 就停止。
- 如果 verification fails，且需要在修复与接受偏差之间做选择，使用 structured user input / AskUserQuestion；不要使用默认值、历史偏好或沉默作为确认。

## 仓库本地角色入口

Review 前必须确认这些 SuperSpec distribution files 存在；缺失、无效或当前 Codex surface 无法从它们启动 native subagents 时，review gate 必须 block：

```text
superspec guard check-init --change "<change>" --format agent
```

Required project-scope files: `.codex/agents/code-reviewer.toml`、`.codex/prompts/code-reviewer.md`、`.codex/agents/architect.toml`、`.codex/prompts/architect.md`、`.codex/agents/critic.toml`、`.codex/prompts/critic.md`、`.codex/agents/verifier.toml`、`.codex/prompts/verifier.md`。

## 执行步骤

1. 检查 review readiness：
   ```text
   superspec guard check-review-ready --change "<change>" --format agent
   ```
2. 从 guard decision、`git diff`、OpenSpec artifacts、tasks、business invariants、test contract、RED/GREEN 摘要和 live role output 摘要构建审查范围；不要默认打开完整 `.superspec/evidence/**/*.json`。
3. 运行 repo-local review guidance：
   - 启动 repo-local `code-reviewer` native subagent，记录审查指导证据（内部 JSON kind 为 `source_guidance`）。
   - 启动 repo-local `architect` native subagent，记录审查指导证据（内部 JSON kind 为 `source_guidance`）。
   - 启动独立 repo-local `critic` native subagent，审查 superspec-specific scope drift、隐藏假设、业务不变量是否被测试/实现扭曲、遗漏的 rollback targets 和 evidence 充分性，并记录审查指导证据（内部 JSON kind 为 `source_guidance`）。
4. 主流程读取关键 source，准备 `main_adjudication` 输入：
   - 从每条 `source_guidance.source_refs` 中判断哪些内容确实需要亲自加载，不要把所有来源自动升级为必须读取。
   - `source_refs` / `required_load_refs` 使用 `pinned_ref = {path, blob_sha}`；其中 `pinned_ref.path` 一律是 repo-root relative path。`required_load_refs` 必须按 `(path, blob_sha)` 精确包含于 `source_refs`。
   - 对所有 `required_load_refs` 做真实读取，并在 `loaded_refs` 中记录同样的 `pinned_ref`；`loaded_refs` 必须按 `(path, blob_sha)` 精确覆盖全部 `required_load_refs`，同一路径不同 blob 不算已加载。
   - 对所有 `required_claim_ids` 写出结构化 `claim_adjudications[] = {claim_id, decision, rationale}`。
   - 对所有 `blocking_findings[*].finding_id` 写出结构化 `finding_adjudications[] = {finding_id, decision, rationale}`。
   - `claim_adjudications[].decision` 使用 `accept | reject | needs_fix`；`needs_fix` 不是 allow 最终状态。
   - `finding_adjudications[].decision` 使用 `dismissed | accepted_fixed | accepted_deviation | needs_fix`；只有前三者是 allow 最终状态。
5. 先判断本轮是否进入 `reopen_authorization` 分支：
   - 当 blocking finding 已具备 `completion_invalidity_class`，且 `scope_expansion:false`，并且问题指向“既有 task 的完成证明失效”时，本轮 review 进入 `reopen_authorization`。
   - 若同一轮 review 仍存在任何 scope / requirement / design / artifact blocker 需要回 propose 或 change update，则不得进入 `reopen_authorization`；此时 `request_changes_route` 必须改为 `change_update`。
   - 在 `reopen_authorization` 分支中：
     - 供 v1 guard / apply 消费的最小 reopen 映射只有一条：被主流程选入 `blocking_source_evidence_refs` 的 `code-reviewer source_guidance`，其 `blocking_findings[*].affected_task_ids` 必须覆盖待 reopen 的 task。
     - 主流程稍后写出的 `main_adjudication` 必须包含 `review_decision:"request_changes"`、`request_changes_route:"reopen_tasks"`、`blocking_source_evidence_refs`、`reopen_task_ids`
     - 不调用 `check-review-complete`
     - 不生成面向 allow 的 `verification_review` / `final_test` evidence
6. 仅在 allow 评估路径执行 final verification：
   ```text
   openspec validate "<change>"
   ```
   - 运行 test contract 要求的项目/test commands，并记录 `kind:"final_test"` evidence；最小字段为 `gate:"review_complete"`、`test_command`、可读的 `output_ref`，并依赖 canonical evidence `status:"pass"` 作为通过状态。
   - 生成 task matrix、invariant matrix 和 scope drift assessment。
   - 启动 repo-local `verifier` native subagent，复核 completion evidence、测试充分性、OpenSpec validation 和 task matrix，并记录 `kind:"verification_review"`。
   - 启动 repo-local `critic` native subagent，复核 scope drift、accepted deviations 和 evidence 充分性，并记录 `kind:"verification_review"`。
   - `verification_review` 只提供 proof/gap，不替代主流程最终判断；若发现新的 blocking issue，则本轮 review 保持 block，修复后重跑 verification，再进入最终判断。
7. 主流程写入唯一一条最终审查判断证据（内部 JSON kind 为 `main_adjudication`）：
   - allow path 必须同时引用 `source_guidance` 和 `verification_review` / `final_test` evidence。
   - 若任何 verification gap 仍未处理完，不得写出 allow 所需的最终判断记录。
   - 若结论是 `review_decision:"request_changes"`，必须同时写清 `request_changes_route`：
     - `reopen_tasks`：显式列出 `reopen_task_ids`，把问题退回 apply 修复既有 task。
     - `change_update`：显式说明需要回 propose / change update；此时 `reopen_task_ids` 必须为空。
   - `request_changes` 只负责给出结构化回退方向，不直接修改 task checkbox。
8. 仅在 allow path 检查 review completion：
   ```text
   superspec guard check-review-complete --change "<change>" --format agent
   ```
   - 只有最终 allow path 才应执行并通过这一步。
   - 如果本轮 `main_adjudication.review_decision:"request_changes"`，则本轮 review 的正确出口是停止并回到对应路由；不要把 `request_changes` 轮次伪装成 `review_complete`。

## Review Guidance 协议

`superspec-review` 直接拥有 review guidance 协议。本阶段必须启动 repo-local `code-reviewer`、`architect`、`critic` native subagents，记录结构化 `source_guidance` evidence；allow path 还要补齐 final verification，然后由主流程写出唯一一条 `main_adjudication`。

不要为 code review 调用另一个 skill 或 workflow。不要用 `$code-review`、global skills、OMX runtime workflows、main-thread self-review 或普通 markdown 报告替代这些 guidance lanes。

## Review 到 Apply 的回退协议

- 当 review 发现的是“既有 task 的验收条件没有真正满足”，主流程必须把这类问题写成可机判的 `request_changes` 判断，而不是留在自由文本里等待人工理解。
- `request_changes_route:"reopen_tasks"` 是唯一允许进入 `task_reopen -> apply_fix` 的 review 路由；对应 `reopen_task_ids` 必须明确列出受影响 task。
- `request_changes_route:"change_update"` 表示问题属于需求、范围、设计或 artifact 边界，正确出口是回 propose / change update，而不是 reopen 现有 task。
- 若同一轮 review 同时存在 reopen-compatible blocker 与 change-update blocker，必须按 `change_update` 判断；不要把混合 blocker 压缩成 reopen。
- 返工完成后的新一轮 review，必须 supersede 旧的 `request_changes` `main_adjudication` 以及它依赖的相关 source evidence，避免旧阻塞判断继续留在 live/pass 集合中。
- 对仍停留在 legacy `.irsflow/*` review evidence 的 change，进入 reopen 协议前应先执行一次 review-only backfill：在 `.superspec/evidence/reviews/` 下重跑结构化 `source_guidance` 与 `main_adjudication`，但不要把旧 `.irsflow` evidence 直接并入 live 集合。
- review 不负责创建 `task_reopen` / `status:"superseded"` / `task_reopen_resolved`；这些 lifecycle evidence 由 apply 主流程接管。

### 必需 native subagent guidance

`code-reviewer` guidance 负责实现审查：

- 规格一致性：实现匹配 OpenSpec requirements、tasks 和 test contract。
- 正确性：业务行为、边界条件、回归风险、错误处理和数据一致性。
- 安全性：硬编码密钥、注入风险、XSS/CSRF、认证/授权绕过和敏感数据泄露。
- 测试充分性：red/green evidence 可信度、关键路径覆盖和 changed-diff coverage。
- 代码质量：复杂度、重复、命名、可维护性、性能热点、N+1 以及掩盖问题的 fallback/workaround code。

`architect` guidance 负责设计审查：

- 边界与接口：系统边界、契约、模块耦合和数据流。
- 取舍风险：长期维护风险、隐藏依赖、扩展成本和回滚难度。
- 反方论证：反对原样 approve 的最强理由。
`critic` guidance 负责反方论证：

- 质疑主流程可能忽略的边界、范围漂移、证据跳读和 accepted deviation。
- 标记哪些 source 必须由主流程亲自加载，而不是只看 summary。
- 把“subagent 只提供审查建议，不做最终判断”落实成可机检的 claims / loads。

### 严重级别

- `CRITICAL`：安全漏洞、数据丢失、权限绕过或严重生产事故风险。
- `HIGH`：明确 bug、主要业务回归、验收阻断或严重架构风险。
- `MEDIUM`：次要缺陷、可维护性问题、测试缺口、性能风险或边界风险。
- `LOW`：风格、命名或小型可读性建议。

### 综合规则

- subagent 可以报告风险、缺口、建议和推荐动作，但不能直接决定 `review_complete` allow。
- `review_complete` 只接受主流程 `main_adjudication` 作为最终判断 proof；没有它即使所有 subagent 都写了 “pass” 也必须 block。
- `required_load_refs` 必须被主流程真实读取并记录到 `loaded_refs`，并且按 `(path, blob_sha)` 精确匹配，否则 block。
- `required_claim_ids` 必须被主流程显式处理，否则 block。
- 每个 `blocking_findings[*].finding_id` 都必须被主流程显式处理；有 blocker 没有 `finding_adjudications[]`、或 decision 仍是 `needs_fix` 时，直接 block。

## 证据契约

每个 evidence file 都必须包含通用 schema 字段：

- `schema_version`
- `evidence_id`
- `change_id`
- `gate`
- `kind`
- `created_at`
- `created_by`
- `status:"pass"|"fail"|"blocked"|"superseded"`

每条 review native-subagent `kind:"source_guidance"` evidence 都必须包含：

- `gate:"review_complete"`
- `kind:"source_guidance"`
- `execution_mode:"native_subagent"`
- `agent_role`（仅 `code-reviewer`、`architect`、`critic`）
- `agent_id`
- `prompt_ref`
- `output_ref`
- `source_anchors`
- `target_refs`：非空 `{path, blob_sha}` 列表，指向被审查目标，并且在 evidence 创建时保持 fresh；对于 review-phase `source_guidance`，其中 `path` 一律是 repo-root relative path
- `source_refs`：主流程可进一步读取的原始 source/artifact/log refs，使用 `pinned_ref = {path, blob_sha}`，其中 `path` 一律是 repo-root relative path
- `required_load_refs`：主流程必须亲自读取的关键 refs，使用 `pinned_ref = {path, blob_sha}`，并且必须是 `source_refs` 的精确子集
- `required_claim_ids`：主流程必须在 `main_adjudication` 中显式处理的 claim ids
- `base_ref`
- `head_ref`
- `reviewed_files`：repo-root relative path 列表
- `blocking_findings`
- `non_blocking_findings`
- `finding_dispositions[] = {finding_id, recommendation, rationale}`，并且必须对每个 `blocking_findings[*].finding_id` 恰好覆盖一次
- `rollback_targets`

若某条 `blocking_findings[*]` 用于 `reopen_authorization`，则该 finding 还必须包含：

- `affected_task_ids`

`violated_test_ids` / `violated_requirement_refs` / `why_completion_invalid` / `required_fix` 等更重的 reopen lifecycle 字段可以作为详细 overlay 保留在专门设计文档中，但不属于 v1 canonical guard 必填项。

主流程 `kind:"main_adjudication"` evidence 必须包含：

- `gate:"review_complete"`
- `kind:"main_adjudication"`
- `execution_mode:"direct"`
- `created_by:"main-thread"`
- `output_ref`
- `review_decision`
- `request_changes_route`（当 `review_decision:"request_changes"` 时必填，v1 仅允许 `reopen_tasks | change_update`）
- `source_evidence_refs`
- `blocking_source_evidence_refs`
- `reopen_task_ids`（仅 `request_changes_route:"reopen_tasks"` 时允许非空）
- `verification_evidence_refs`（allow path 必填且必须覆盖本轮 `verification_review` / `final_test`；`reopen_authorization` path 允许为空）
- `loaded_refs`（`pinned_ref = {path, blob_sha}`，其 `path` 同样必须是 repo-root relative path，并且必须精确覆盖全部 `required_load_refs`）
- `claim_adjudications[] = {claim_id, decision, rationale}`
- `finding_adjudications[] = {finding_id, decision, rationale}`
- `raw_artifact_refs`（仅在高风险/冲突/accepted deviation/无法复现实验等需要原始材料时强制）

`source_evidence_refs` 必须指向对应 `source_guidance` 的 live/pass evidence id；allow path 的 `verification_evidence_refs` 必须指向本轮 `verification_review` / `final_test` 的 live/pass evidence id，`reopen_authorization` path 则保持为空。普通 markdown 链接只能作为人类可读材料，不能满足 gate proof。`main_adjudication` 不得携带 `agent_role`、`agent_id`、`prompt_ref`。每个 `required_claim_id` 必须被 `claim_adjudications[]` 恰好处理一次；每个 `blocking_findings[*].finding_id` 必须被 `finding_adjudications[]` 恰好处理一次。

补充约束：

- `blocking_source_evidence_refs` 必须是 `source_evidence_refs` 的子集。
- `review_decision:"request_changes"` 时必须显式写出 `request_changes_route`；不要让 apply 从自由文本猜测回退方向。
- `request_changes_route:"reopen_tasks"` 时，`reopen_task_ids` 必须非空，并且只包含当前 review 明确认定完成证明失效的 task。
- `request_changes_route:"change_update"` 时，`reopen_task_ids` 必须为空。

最终验证 native-subagent role evidence 应使用 `kind:"verification_review"`，并且必须包含：

- `openspec_validate_ref`
- `task_matrix_ref`
- `invariant_matrix_ref`
- `scope_drift_ref`
- `test_evidence_refs`
- `scope_drift`

`kind:"final_test"` evidence 必须至少包含：

- `gate:"review_complete"`
- `test_command`
- `output_ref`

并依赖 canonical evidence `status:"pass"` 作为 allow 所需的成功状态；`output_ref` 必须指向本次最终测试运行的可读日志/结果。

在 `review_complete` 判定中，只接受 `gate:"review_complete"` 的 `verification_review` / `final_test` 证据。`check-verify-ready` / `verify_complete` 只是兼容命令别名，不得单独扩大证据来源。

## 停止条件

- 任一 guard command 返回 `block` 时立即停止。
- 任何 `required_load_refs` 未被主流程读取、任何 `required_claim_ids` 未被主流程处理、任何 `blocking_findings[*].finding_id` 未被 `finding_adjudications[]` 恰好处理一次、其 decision 仍为 `needs_fix` 时，必须停止并补证据；若当前走 allow path，任何 final verification proof 缺失同样必须停止并补证据。
- 如果本轮 `main_adjudication.review_decision:"request_changes"`，停止在 route 明确后的 handoff 上：`reopen_tasks` 回 apply，`change_update` 回 propose / change update。
- 只有 `check-review-complete` 返回 `allow` 后才算完成。
