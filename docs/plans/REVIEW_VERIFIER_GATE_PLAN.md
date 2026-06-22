# SuperSpec Review Verifier Gate 修改方案

## 状态

- 日期：2026-06-23
- 状态：architect + critic 最终复审通过，等待实施
- 范围：只优化 review/verifier/accept 协议；不修改 apply/test-run 语义。

## 核心原则

最不容易出问题的代码通常是最少的代码。

本方案只补当前 review 协议的真实缺口：

- 复用现有 `transition`、`job`、`snapshot`、`events.jsonl`。
- 不移动 verifier 的阶段位置。
- 不新增默认 code-reviewer/architect/critic 审查。
- 不自动生成 follow-up task。
- 不要求 raw log、仓库级指纹、实现 diff 指纹或 write-scope 检查。
- 不处理 raw JSON/JSONL 存储清理；当前 `record` 追加到 `raw/*.jsonl` 是既有基线，本方案不新增 raw 文件类型，也不回退该行为。

## 当前实现事实

用户工作流语义：

```text
apply: 编码 + RED/GREEN
review: verifier 最终验证 + accept
```

当前内部状态机：

```text
apply
  -> review-ready
apply_done
  -> review-ready 创建 verifier job
apply_done
  -> verifier pass 后 review-ready 推进到 review
review
  -> accept
accepted
```

这个分层可以接受：`apply_done` 是“实现已完成但还没接受”的位置，适合 verifier 做最终验收。

## 当前问题

### 1. `review-ready --risk` 没有持久化成最终审查策略

现在 `review-ready` 接收 `--risk minimal|normal|strict`，但这个 risk 没有成为后续 `next` 和 `accept` 的单一事实来源。

风险：

- 第一次 `review-ready --risk minimal` 从 `apply` 进入 `apply_done` 后，后续 `next` 默认 risk 可能又变成 strict。
- `accept` 不知道当前变更是否应该要求 verifier。

### 2. `accept` 没有复查 verifier

当前 `accept` 只检查：

```text
state == review
tasks.md 没有 pending task
```

它没有检查：

- 当前审查策略是否要求 verifier
- 是否存在 accepted verifier
- verifier 是否来自 `review-ready`
- verifier 绑定文件是否仍然 fresh

### 3. `next` 在 `review` 状态过于乐观

当前 `review` 状态下：

```text
pending task -> reopen
otherwise -> accept
```

它没有处理：

- open verifier
- missing verifier
- stale verifier
- rejected verifier 后需要重新创建 verifier

### 4. `review-ready` 不能在 `review` 状态补 verifier

如果已经进入 `review` 后 verifier 失效，当前 `review-ready` 不适用。

为了保持协议闭环，`review-ready` 应允许：

```text
review -> job_created(verifier)
review -> review no-op
```

### 5. fresh verifier 现在只绑定文档，不能绑定执行证据版本

当前 verifier job 的 `boundFiles` 只覆盖 proposal、design、tasks 和 `.superspec/artifacts/*`。

这能发现文档变更后的 verifier 过期，但不能发现这些情况：

- verifier 通过后，又通过 `reopen -> apply -> task-complete` 产生了新的执行证据。
- verifier 通过后，又补登记了新的 RED/GREEN test-run 证据。

本方案只封闭 SuperSpec 流程内能观察到的变化：任务完成证据、测试运行证据、绑定文档。它不声称能发现绕过 SuperSpec 的裸文件修改；要做裸文件修改检测，需要引入 write-scope 或实现指纹，那属于 apply 层增强，不放进这个 review MVP。

## MVP 修改方案

### 1. 在 `review-ready` 持久化审查策略

新增一个轻量审查策略，作为后续 `next` 和 `accept` 的唯一依据。

建议直接写入 `review-ready` 的 `transition_commit.payload.review_policy`：

```json
{
  "review_risk": "minimal|normal|strict",
  "requires_verifier": true
}
```

落地时只给 `commitTransition` 增加一个可选的 `commitPayload` 扩展字段，并在写 `transition_commit` 时浅合并进去。默认值为空，不影响其他 transition。扩展字段不能覆盖 `transition`、`from_state`、`to_state`、`outcome`、`created_job_ids`、`new_jobs`、`reason` 这些核心字段。

规则：

- 第一次完成 apply 后运行 `review-ready` 时创建审查策略。
- 同一个 change 内，如果历史事件里已经存在审查策略，后续 `review-ready` 忽略新的 risk 参数，继续使用已持久化策略。
- 读取优先级固定为：当前 change 的 events 中，最早一个包含 `review_policy` 的 `review-ready` commit。也就是“首次策略生效，之后不可覆盖”。
- 新 change 有独立 events 文件，所以策略天然重置，不会跨 change 污染。
- `minimal` 写入 `requires_verifier:false`。
- `normal` 写入 `requires_verifier:true`。
- MVP 中 `strict` 等同 normal：都要求 verifier，但不启用额外检查。用户文档要明确这一点，避免误解为 strict 已经有更重审查。
- `accept` 不新增 `--risk` 参数。
- 无审查策略时，`accept` 一律不直接放行，避免“新流程异常缺 policy”变成绕过口。
- legacy `apply_done` 或 `review` 如果没有审查策略，下一次 `review-ready` 用本次传入 risk 创建策略；因此旧变更不会卡死，只是需要补一次 `review-ready`。

### 2. `review-ready` 按 policy 创建或复用 verifier

`review-ready` 支持状态：

```text
apply -> apply_done
apply_done -> job_created(verifier)
apply_done -> review
review -> job_created(verifier)
review -> review no-op
```

行为：

- pending task 存在时仍然拒绝，交给 `next` 返回 `reopen`。
- 如果 policy 不要求 verifier：
  - `apply_done -> review`
  - `review -> review` no-op，使用 skip 返回，不写事件
- 如果 policy 要求 verifier：
  - 有 open verifier：不重复创建，提示先完成现有 job。
  - 没有 fresh accepted verifier：创建新的 verifier job。
  - 有 fresh accepted verifier：`apply_done -> review`；如果已经在 `review`，返回 no-op skip，不写事件。
- rejected verifier 不复用；下一次 `review-ready` 创建新 verifier。

fresh verifier 定义：

```text
role == verifier
created_from_transition == review-ready
state == accepted
boundFiles 仍匹配当前文件 hash
review_evidence_digest 仍匹配当前已登记执行证据版本
```

`boundFiles` 继续复用当前 review-ready 绑定文件集合：

```text
proposal.md
tasks.md
design.md
.superspec/artifacts/discovery.md
.superspec/artifacts/business-invariants.md
.superspec/artifacts/test-contract.md
```

同时给 review-ready verifier 增加一个轻量的 `review_evidence_digest` 字段，并纳入 `packet_digest`。它只由现有事件计算，不新增用户命令。

落点：

- `Job` 类型增加可选字段 `review_evidence_digest?: string`。
- `reviewReady` 创建 verifier job 时写入该字段。
- `jobs packet` 输出该字段，让 verifier 能看到自己审查的证据版本。
- fresh 检查 helper 同时检查 `boundFiles` 和 `review_evidence_digest`。

建议计算输入：

```text
所有 task_completed 事件：
  task_id
  attempt_id
  task_structure_digest（从对应 task_started attempt 解析）
  event_digest

与这些已完成任务匹配的 test_run_recorded 事件：
  test_id
  attempt_id
  task_structure_digest
  semantic_status
  command
  cwd
  exit_code
  target_fingerprint
  event_digest
```

排序后生成一个稳定 digest。

匹配规则必须和当前 apply 判定一致：

- 优先匹配 `test_run_recorded.attempt_id == task_completed.attempt_id`。
- 兼容旧记录：如果 test-run 的 `attempt_id == null`，且 `task_structure_digest` 匹配该已完成 attempt，也纳入 digest。
- 不匹配任何已完成 attempt 的 test-run 不纳入 digest，因为它不是当前任务完成证据的一部分。

它的作用不是证明源码绝对没被手改，而是证明 verifier 审查时看到的“任务完成 + RED/GREEN 证据版本”没有被流程内的新证据替换。如果 verifier 通过后重新 reopen/apply，或者补登记测试证据，digest 会变化，旧 verifier 不能再满足 `accept`。

为避免过度设计，MVP 不要求每个 test-run 都必须有 `target_fingerprint`。已有就纳入 digest；没有就按现有语义处理。

### 3. `next` 在 `review` 状态按 verifier 状态路由

`apply_done`：

```text
pending task -> reopen --to apply
open job -> required_job
otherwise -> review-ready
```

`review`：

```text
pending task -> reopen --to apply
open verifier -> required_job
no policy -> review-ready
policy requires verifier 且没有 fresh accepted verifier -> review-ready
otherwise -> accept
```

不做 rejected 次数统计，不做三次失败升级。

如果此前 verifier 是 rejected，`next` 或 `review-ready` 的提示里应带上“此前 verifier 未通过，请先根据 findings 修改任务或文档；确认无需修改时再重新创建 verifier”。只做提示，不自动生成 task。

### 4. `accept` 要求 fresh verifier

`accept` 规则：

```text
if state != review:
  reject

if pending tasks:
  reject and point to reopen

if no review policy:
  reject and point to review-ready

if policy.requires_verifier == false:
  accept

if policy.requires_verifier == true:
  require fresh accepted verifier from review-ready
```

如果 verifier 缺失、rejected 或 stale：

```text
accept writes no event
message points to review-ready
```

`accept` 拒绝时必须保持只读，不写 `transition_prepare`、`transition_commit` 或其他事件。

### 5. 不自动新增 follow-up task

verifier fail 后：

```text
job_rejected
state remains apply_done or review
```

主流程根据 verifier findings 决定是否修改 `tasks.md` 添加 follow-up task。

已有机制继续负责回退：

```text
tasks.md 出现 pending task
next -> reopen --to apply
```

不让引擎自动改 `tasks.md`，避免把 verifier 变成任务规划器。

## 不改的内容

- 不改 `record test-run` 字段。
- 不改 `task-complete` RED/GREEN 规则。
- 不强制 `raw_log_ref`。
- 不强制仓库级指纹、实现 diff 指纹或 write-scope。
- 不新增 final code-reviewer/architect/critic job。
- 不把 verifier 从 `apply_done` 挪到别的状态。
- 不自动生成 follow-up task。
- 不检测绕过 SuperSpec 流程的裸文件修改；如果未来要做，应作为 apply 层的 write-scope/实现指纹方案单独设计。

## 测试计划

新增针对性测试：

- `review-ready` 从 `apply` 进入 `apply_done` 时持久化 review policy。
- policy 已存在时，再次 `review-ready` 不被新 risk 参数覆盖。
- 多个 `review-ready` commit 里，以最早持久化的 review policy 为准。
- 先 `review-ready --risk minimal` 写入 policy 后，再用 `--risk strict` 重跑，仍按首次 minimal policy 执行。
- `review-ready --risk minimal` 后续不创建 verifier。
- `review-ready --risk normal` 创建 verifier。
- verifier accepted 后 `review-ready` 推进到 `review`。
- verifier rejected 后再次 `review-ready` 创建新 verifier。
- `review-ready` 在 `review` 状态可创建 verifier。
- `review-ready` 有 open verifier 时不重复创建。
- `review-ready` 在 `review` 状态 no-op 时不写事件。
- `next` 在 `review` 状态有 open verifier 时返回 `required_job`。
- `next` 在 `review` 状态 verifier stale/missing 时返回 `review-ready`。
- `next` 在无 policy 的 legacy `review` 状态返回 `review-ready`。
- `review-ready` 能在无 policy 的 legacy `review` 状态补策略。
- `accept` 不允许新流程意外走到无 policy accept。
- `accept` 在 policy 要求 verifier 且缺 verifier 时拒绝。
- `accept` 在 verifier stale 时拒绝。
- `accept` 在 verifier accepted 后文档变化时拒绝。
- `accept` 在 verifier accepted 后出现新的 task/test-run 证据版本时拒绝。
- `accept` 在 verifier accepted 后补登记 `attempt_id:null` 且 `task_structure_digest` 匹配的 test-run 时拒绝。
- 非 `review-ready` 创建的 accepted verifier 不能满足 `accept`。
- `accept` 在 fresh verifier 存在时通过。
- `accept` 拒绝时不写事件。

## 实施顺序

1. 给 `commitTransition` 增加可选 `commitPayload` 扩展，默认空对象。
2. 增加审查策略读取/写入 helper：最早策略生效，后续不可覆盖。
3. 修改 `reviewReady`：持久化 policy，并支持 `review` 状态创建 verifier。
4. 增加 `review_evidence_digest` helper：只读取现有 task/test-run 事件，不改变 apply/test-run。
5. 修改 `next`：在 `review` 状态识别 open/missing/stale verifier。
6. 修改 `accept`：按 policy 检查 fresh verifier。
7. 更新 `superspec-review` 技能说明：明确该技能覆盖 `apply_done -> verifier -> review -> accept`，并说明 MVP 中 strict 等同 normal。

步骤 3、5、6 应同一批落地，避免出现 `accept` 已变严但 `next` 仍建议直接 accept 的中间状态。

## 验收标准

- 默认 normal/strict 路径下，没有 fresh verifier 不能进入 `accepted`。
- fresh verifier 同时绑定文档版本和已登记执行证据版本。
- minimal 路径仍可跳过 verifier。
- verifier fail 后不会自动改任务，但添加 pending task 后现有 `reopen` 路径可用。
- `apply` 和 test-run 相关行为保持不变。
- 现有 legacy `review` 状态不会被强制卡死：无策略时走 `review-ready` 补策略，而不是直接 `accept`。

## 审查结论

architect 初审：通过，无阻塞问题。采纳建议：

- 明确审查策略读取优先级：同一 change 内最早策略生效。
- 增加非 `review-ready` verifier 不能满足 `accept` 的测试。
- 在用户文档中说明 strict 在 MVP 中等同 normal。

critic 初审：未通过，指出两个阻塞问题。已修订：

- fresh verifier 从只绑定文档，改为绑定文档版本 + 已登记执行证据版本。
- 明确策略生命周期：同一 change 内首次策略生效，新 change 自动重置；无策略时不直接 `accept`，统一回到 `review-ready` 补策略。

architect 最终复审：通过，无阻塞问题。确认：

- `commitPayload` 扩展边界清楚，且不能覆盖核心 transition 字段。
- 无 `review_policy` 时统一回 `review-ready`，不再有 legacy 直通 `accept` 的旁路。
- `review_evidence_digest` 作为 `Job` 字段、packet 输出和 fresh 检查依据，能封闭 SuperSpec 流程内的证据变化。

critic 最终复审：通过，无阻塞问题。确认：

- `review_evidence_digest` 已和当前 RED/GREEN 兼容规则对齐，包括 `attempt_id:null` 且 `task_structure_digest` 匹配的旧 test-run 记录。
- `review` 状态 no-op 使用 skip，不写事件。
- 剩余裸文件修改检测明确排除在本 MVP 外。

剩余边界：

- 本方案不检测绕过 SuperSpec 流程的裸文件修改。这个能力需要 apply 层的 write-scope 或实现指纹，不适合塞进 review MVP。
