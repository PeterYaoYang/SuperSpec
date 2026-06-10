# superspec review contract repair plan

> 状态：Draft
> 目标：修复当前 superspec review 契约中 `request_changes` / `review_complete` / `main_adjudication` 的分叉与误放行问题，并把规范、guard、测试重新收敛到同一个最小实现面。

## 1. 问题摘要

当前仓库已经把 `source_guidance -> verification_review/final_test -> main_adjudication` 的主链落了一半，但还有三个真实断点：

1. `review_complete` 可能误放行非终局裁决。
2. `main_adjudication` 的 canonical 主线程作者边界没有被 guard 机检。
3. `SPEC.md`、`superspec-review` skill、`REVIEW_TASK_REOPEN_PROTOCOL_DESIGN.md` 对 `request_changes` / reopen 的关系没有单一答案。

结果是：

- allow path 与 request-changes path 混在一起；
- 规范要求和 guard 行为不一致；
- 测试把偏离规范的实现一起锁成了“通过”。

## 2. 目标与非目标

### 2.1 本次目标

- 明确 `review_complete` 是 **allow-only gate**。
- 明确 `request_changes` 是 **结构化 review 输出**，但不是 `review_complete` 的通过态。
- 把 `main_adjudication` 的 canonical 作者边界、字段要求、allow/request-changes 路径规则做成可机检契约。
- 让 `task_reopen` 继续消费 `request_changes` 裁决，但不在本次修补中扩写新的顶层阶段、命令或状态机。
- 用 focused tests 锁住 allow path、request-changes path、作者边界和 reopen 路由边界。

### 2.2 本次非目标

- 不新增新的 user-visible workflow 阶段。
- 不新增新的 evidence kind。
- 不实现完整的 reopen 生命周期扩展，例如多轮 reopen 配额、自动 supersede 波次、额外回退阶段。
- 不改 OpenSpec schema，也不改 `openspec instructions` / `openspec validate` surface。

## 3. 关键决策

### 3.1 `review_complete` 只表示 allow

`review_complete` 只对应“本轮 review 已完成且允许进入 archive-ready / archive”的结果。

因此：

- `main_adjudication.review_decision:"allow"` 才允许 `check-review-complete` 返回 allow。
- `review_decision:"request_changes"` 是合法 review 输出，但它的正确出口是 handoff，不是 `review_complete` allow。
- `check-archive-ready` 只能建立在 allow path 的 `review_complete` 之上。

### 3.2 `request_changes` 保留为结构化输出，但不扩成第二套 review 模式

本次不删除 `request_changes`，也不把 reopen 设计硬塞回自由文本。

最小一致方案是：

- `main_adjudication.review_decision` 只允许 `allow | request_changes`。
- 删除 `comment` 这个会制造“非终局但不失败”灰区的取值。
- 当 `review_decision:"request_changes"` 时，必须显式带 `request_changes_route`：
  - `reopen_tasks`
  - `change_update`
- 该分支写出结构化 handoff 信息，但 **不调用** `check-review-complete`，也不补 allow 向 final verification 证据。
- `check-review-complete` 只服务 allow path；request-changes path 的合法性由 `main_adjudication` schema、`task_reopen` 消费端和后续 supersede 规则共同保证。

### 3.3 reopen 详细生命周期继续放在专门协议里，但 canonical schema 保留当前消费者真正需要的最小字段

本次不把 `REVIEW_TASK_REOPEN_PROTOCOL_DESIGN.md` 的全部生命周期细节抄进 `SPEC.md`。

canonical 文档只保留当前 guard / apply 消费端必须知道的最小字段：

- `review_decision`
- `request_changes_route`
- `blocking_source_evidence_refs`
- `reopen_task_ids`

并且补一条最小映射规则：

- `request_changes_route:"reopen_tasks"` 时，`blocking_source_evidence_refs` 必须包含能够授权本次 reopen 的 `code-reviewer source_guidance` evidence；
- `source_guidance.blocking_findings[*].affected_task_ids` 必须显式列出受影响 task，供 apply 把单个 `task_reopen` package 绑定到一个具体的 `source_guidance_evidence_id`。

其余 reopen 生命周期、supersede 时序、successor evidence 规则，继续留在 `REVIEW_TASK_REOPEN_PROTOCOL_DESIGN.md` 里做详细设计。

### 3.4 `main_adjudication` 的作者边界要硬校验

对 canonical allow / request-changes 两条路径都统一要求：

- `execution_mode:"direct"`
- `created_by:"main-thread"`
- 禁止出现 `agent_role`
- 禁止出现 `agent_id`
- 禁止出现 `prompt_ref`

这不是风格规则，而是 review 不能被角色 evidence 伪装的防线。

## 4. 规范收敛方案

### 4.1 `SPEC.md`

更新 `review` / `review_complete` / `main_adjudication` 契约：

1. 明确 `review_complete` 是 allow-only gate。
2. 把 `main_adjudication` 的 canonical schema 扩到：
   - `review_decision`
   - `request_changes_route`（仅 request-changes path）
   - `source_evidence_refs`
   - `verification_evidence_refs`（仅 allow path 必填）
   - `blocking_source_evidence_refs`（仅 request-changes path 使用）
   - `reopen_task_ids`（仅 `reopen_tasks` 使用）
   - `loaded_refs`
   - `claim_adjudications`
   - `finding_adjudications`
3. 明确 allow path 与 request-changes path 的字段差异：
   - allow path：必须有 final verification refs，且才能满足 `review_complete`
   - request-changes path：不得伪装成 `review_complete` allow
4. 在 `Guard 单元` / `Integration` / `E2E fixture` 中加入：
   - `request_changes` 不得满足 `review_complete`
   - `comment` 非法
   - canonical 作者边界缺失即 block

### 4.2 `superspec-review` skill

收敛成单一规范口径：

1. allow path：
   - `source_guidance`
   - final verification
   - `main_adjudication(review_decision:"allow")`
   - `check-review-complete`
2. request-changes path：
   - `source_guidance`
   - 主线程 `main_adjudication(review_decision:"request_changes")`
   - 停在 `reopen_tasks` 或 `change_update` handoff
   - 不把本轮写成 `review_complete`
   - 不补 allow 向 `verification_review` / `final_test`
3. 明确 skill 只写 canonical 最小字段，不重复 reopen 设计文档里更长的生命周期细节。

### 4.3 `REVIEW_TASK_REOPEN_PROTOCOL_DESIGN.md`

只做对齐，不做大改：

1. 把 `review_decision` 从 `allow | comment | request_changes` 收敛为 `allow | request_changes`。
2. 明确它依赖 canonical `main_adjudication` 字段命名，不再另起口径。
3. 明确该文是 detailed lifecycle overlay，不覆盖 `SPEC.md` 的 canonical gate 定义。
4. 显式改写 verification 相关段落：
   - `review-only backfill` / `request_changes` path 不产出 allow 向 `verification_review` / `final_test`
   - 返工完成后的新一轮 allow-path review 才重新产出 `verification_review` / `final_test`
   - `verification_evidence_refs` 只属于 allow path；request-changes path 保持为空

## 5. 实现改造方案

### 5.1 `util.ts`

收敛常量定义：

- `MAIN_ADJUDICATION_DECISIONS = ["allow", "request_changes"]`
- 增加 `REQUEST_CHANGES_ROUTES = ["reopen_tasks", "change_update"]`
- 保留已有 claim/finding adjudication decision 集合

### 5.2 `evidence.ts`

对 `main_adjudication` 增加硬校验：

1. 强制：
   - `execution_mode === "direct"`
   - `created_by === "main-thread"`
2. 显式拒绝：
   - `agent_role`
   - `agent_id`
   - `prompt_ref`
3. 强制 `review_decision`
4. 当 `review_decision:"allow"` 时：
   - `verification_evidence_refs` 必填且非空
5. 当 `review_decision:"request_changes"` 时：
   - `request_changes_route` 必填
   - `verification_evidence_refs` 必须为空
   - `request_changes_route:"reopen_tasks"` 时 `reopen_task_ids` 必须非空
   - `request_changes_route:"change_update"` 时 `reopen_task_ids` 必须为空
   - `blocking_source_evidence_refs` 必须非空，并且必须来自 `source_evidence_refs`
6. `blocking_source_evidence_refs` 只允许在 request-changes path 使用，并且必须是 `source_evidence_refs` 子集

### 5.3 `gates.ts`

修改 `check_review_complete`：

1. 明确它是 **allow-only gate**：
   - 只面向 allow path 调用
   - 不为 request-changes path 输出 handoff 语义
2. 若发现单条 live `main_adjudication.review_decision:"request_changes"`，必须先短路到 route-specific block / next action：
   - `reopen_tasks` -> 回 apply / task_reopen
   - `change_update` -> 回 propose / change update
   - 同时抑制 `missing_final_verification_review` / `missing_final_tests` / `validate_failed` 这类 allow-path 修复建议
3. allow path 才继续校验：
   - `source_guidance`
   - `verification_review`
   - `final_test`
   - refs/load/claim/finding 闭环
4. 终局裁决分支新增：
   - `review_decision` 必须存在且等于 `allow`
   - 非 `allow` 的 adjudication 不得满足 `review_complete`
5. `request_changes` path 不在这里消费 final verification，也不在这里表达 allow-path 修复动作；它由 skill 在 review 阶段提前停止，并由后续 apply / propose 路径消费。
6. `check_archive_ready` 无需新增分支，只继续信任 allow-only 的 `review_complete`

### 5.4 reopen 兼容点

不重写整个 reopen 协议，只修正当前消费者与 canonical schema 对齐：

- `task_reopen` 继续从 `main_adjudication(review_decision:"request_changes")` 读取 reopen 授权
- 若存在 `request_changes_route:"change_update"`，apply 不得尝试 reopen
- 若存在 `request_changes_route:"reopen_tasks"`，`reopen_task_ids` 决定允许 reopen 哪些 task；`blocking_source_evidence_refs` 决定允许 apply 选用哪些 `code-reviewer source_guidance` 作为 `source_guidance_evidence_id`
- `superspec-apply` 在为单个 task 生成 `task_reopen` package 时，必须从 `blocking_source_evidence_refs` 中选出一个仍为 live/pass 的 `code-reviewer source_guidance`，并要求其 `blocking_findings[*].affected_task_ids` 覆盖当前 task
- 返工成功后的下一轮 allow-path review，必须 supersede 旧的 `request_changes main_adjudication` 与它的 `blocking_source_evidence_refs`，否则旧裁决继续留在 live/pass 集合中污染后续 gate

## 6. 测试方案

补齐当前缺失的负例：

1. `review_decision:"request_changes"` 不能满足 `check-review-complete`
2. `review_decision:"comment"` 非法
3. allow path 缺 `verification_evidence_refs` -> block
4. request-changes path 非空 `verification_evidence_refs` -> block
5. `request_changes_route` 缺失 -> block
6. `reopen_tasks` + 空 `reopen_task_ids` -> block
7. `change_update` + 非空 `reopen_task_ids` -> block
8. `request_changes` path 进入 `check-review-complete` 时不得返回 allow
9. `main_adjudication` 缺：
   - `execution_mode:"direct"`
   - `created_by:"main-thread"`
   - 或携带 `agent_id` / `prompt_ref`
   均应 block
10. `task_reopen` 读取 `request_changes_route:"change_update"` 时应拒绝 reopen
11. `task_reopen` 找不到可用的 `code-reviewer source_guidance_evidence_id` 或 `affected_task_ids` 不覆盖当前 task -> block
12. 返工后新一轮 allow-path review 若未 supersede 旧 `request_changes` adjudication -> block / 不得形成唯一 live 主裁决
13. `test_superspec_skills.test.ts` 锁住文本契约：
   - `review_complete` 是 allow-only
   - `request_changes_route` 必须出现在 request-changes path 契约中
   - canonical 作者边界必须明确写出 `execution_mode:"direct"` + `created_by:"main-thread"`
   - request-changes path 不产出 allow 向 final verification

保留并更新现有 allow-path 正例，确保不是通过“放宽 guard”来让测试过。

## 7. 改动边界

本次预计只改这些面：

- `docs/proposals/superspec/SPEC.md`
- `.codex/skills/superspec-review/SKILL.md`
- `docs/proposals/superspec/REVIEW_TASK_REOPEN_PROTOCOL_DESIGN.md`
- `scripts/superspec/src/util.ts`
- `scripts/superspec/src/evidence.ts`
- `scripts/superspec/src/gates.ts`
- `scripts/superspec/tests/test_superspec_guard.test.ts`
- `scripts/superspec/tests/test_superspec_skills.test.ts`

如无新证据，不扩到新的 CLI 命令、新阶段或新的 evidence kind。

## 8. 完成标准

以下条件同时满足才算完成：

1. `SPEC.md`、`superspec-review` skill、`REVIEW_TASK_REOPEN_PROTOCOL_DESIGN.md` 三者对 `review_decision` / `request_changes_route` / `verification_evidence_refs` / canonical 作者边界口径一致
2. `check_review_complete` 只会在 allow path 返回 allow
3. `main_adjudication` 的 canonical 作者边界被 schema guard 机检
4. request-changes path 与 allow path 不再共用一套 gate 语义，也不会误入 archive-ready
5. 新增负例测试覆盖上述边界
6. `scripts/superspec` 下测试通过

## 9. 备注

这份方案故意不把 reopen 做成第二套 review 模式，也不在本次把 detailed lifecycle 全部实现完。先把 canonical contract 收回一致，再让 reopen 细节在单独协议里继续演进，复杂度才可控。
