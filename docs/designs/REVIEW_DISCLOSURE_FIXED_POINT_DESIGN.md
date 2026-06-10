# SuperSpec review disclosure fixed-point 设计

> 状态：**Revised / 2026-06-10**（按 `docs/audits/REVIEW_DISCLOSURE_FIXED_POINT_REVIEW_2026-06-10.md` v2 审查结论修订；**Stage A 完成，待用户确认后进入 Stage B 实施**）
> 目标：修复多角色交叉审查中 reviewer blocker、scope risk、open question、agent assumption 可被主线程静默吸收、重跑到 pass 后继续推进的问题。
> 前置地基（已落地）：基础 guard 修复 FIX-11（propose 期 `review_scope[]` 合同）、FIX-12（全局 `dangling_evidence_ref` 悬空引用检查）。

## 1. 问题定义

当前 SuperSpec 已在若干阶段要求 role review evidence，例如 `explore_complete` 要求 `critic`，`design_complete` 要求 `architect` / `critic` / `test-engineer`，`review_complete` 要求 `source_guidance` 与 `main_adjudication`。

但这些 review 的阶段语义不一致：

- 早期阶段的 role review 多数只是 evidence 存在性与 pass 状态检查。
- reviewer 发现的 blocker、scope risk、open question、agent assumption 没有统一进入阶段出口状态机。
- 主线程可以把 blocker 消化成 artifact 修改，再重跑 reviewer 得到 pass，历史 blocker 不再需要用户可见披露或显式裁决。
- 后续 human confirmation 只能确认已经被主线程收敛后的文本，不能保证用户见过原始 blocker 和可选裁决。

`refactor-vacation-duration-api` 暴露了该类问题：`critic` 在 explore 阶段指出“实现类”可能指 `VacationController`、候选 `VacationDurationGetAdapter` 或共享 `ScheduleActualServiceImpl#calculationVacationDuration`。主线程随后补 discovery 并把 `ScheduleActualServiceImpl` 写成 non-goal，后续 reviewer pass，流程继续推进。这个范围选择本身可能合理，但流程没有强制把该 blocker 作为用户可见 checkpoint 披露和裁决。

## 2. 目标与非目标

### 2.1 目标

- 将多角色 review 输出升级为阶段出口必须消费的结构化输入。
- 在每个多角色 review 阶段强制生成 disclosure evidence，汇总 blocker、scope risk、open question、agent assumption 和非阻断 findings。
- 对影响 scope、non-goals、验收口径、业务语义或设计边界的问题，要求用户确认或已有明确授权。
- 要求主线程按裁决修改 artifact 后重新运行同阶段 role review，直到最新 artifact 版本上没有未处置问题。
- 防止旧 blocker 被后续 pass evidence 静默抹掉；旧 blocker 必须在 append-only finding history 中拥有终态处置。
- 保留主线程整理、修复、摘要的效率，但取消其单方面裁决重大边界问题的权限。

### 2.2 非目标

- 不要求所有 minor / style / purely mechanical findings 都询问用户。
- 不把 reviewer 的意见直接等价为最终真相；主线程仍可提出 false positive 或 accepted deviation，但必须给出证据和必要确认。
- 不在 v1 证明 subagent 审查质量；本设计只强制发现项的披露、处置、重审和新鲜度。
- 不用后续阶段的 human confirmation 替代当前阶段的 review disclosure。
- 不允许通过“重跑到 pass”删除历史 blocker。
- **明确拒绝两个伪省钱捷径（R4）**：① “trivial edit 豁免”——trivial 由主线程判定，等于重开洗白通道；正确做法是用增量审查合同（R3）把重审成本压到可忽略。② “只重跑提出 finding 的角色”——scope 裁决会改变其他角色结论；clean round 上 required roles 必须齐，用 R2 并行执行消化 wall clock 成本。
- **v1 信任天花板（P0-1）**：v1 假设主线程不伪造、不删除 evidence；guard 验证的是**现存文件集合的叙事自洽性**（结构、引用、新鲜度、历史闭环），**不验证**作者在场性与历史完整性。引用完整性机检（`dangling_evidence_ref`，已由 FIX-12 落地）与 round 连续性机检只**抬高**删除式洗白成本，不消除伪造/删除通道。v2 锚定通道（git commit evidence、CLI nonce 落盘 decision、harness 签名）仅在文档中预留，本阶段不实现。

## 3. What：统一 Review Disclosure Fixed-Point Loop

所有存在多角色交叉审查的阶段都进入同一循环：

```text
artifact draft
  -> role reviews
  -> disclosure evidence
  -> user decision / standing authorization for material findings
  -> artifact updates
  -> rerun same-gate role reviews
  -> clean disclosure on current target refs
  -> gate allow
```

适用 gate：

| Gate | Required role review | Primary target refs | Notes |
| --- | --- | --- | --- |
| `explore_complete` | `critic` | `.superspec/artifacts/discovery.md` | 第一优先级；scope blocker 必须在 propose 前披露。 |
| `proposal_reviewed` | `critic` | `proposal.md`, `.superspec/artifacts/discovery.md` | 将现有 proposal advisory review 升级为 internal gate；不得继续无 guard/human pause 地修到 pass。 |
| `design_complete` | `architect`, `critic`, `test-engineer` | `proposal.md`, `design.md`, `specs/**/*.md`, `.superspec/artifacts/discovery.md` | 覆盖设计边界、non-goals 和 spec 语义。 |
| `invariants_reviewed` | `critic`, `test-engineer` | `.superspec/artifacts/business-invariants.md`, `design.md`, `specs/**/*.md` | 当前已有 artifact sha 检查，应扩展为 disclosure target map。 |
| `test_contract_drafted` | `critic`, `test-engineer` | `.superspec/artifacts/test-contract.md`, `.superspec/artifacts/business-invariants.md`, `specs/**/*.md`, `design.md` | 验收口径变化必须披露。 |
| `tasks_complete` | `critic`, `test-engineer` | `tasks.md`, `.superspec/artifacts/test-contract.md`, `.superspec/artifacts/business-invariants.md` | 当前实现没有 role review；若纳入本设计，必须新增该 gate 的 role review，不得只宣称覆盖。 |
| `review_complete` | `code-reviewer`, `architect`, `critic`, plus final `verifier` / `critic` verification | changed repo files, OpenSpec artifacts, sidecar artifacts, final test outputs | 复用 `main_adjudication` 作为 disclosure carrier，避免双重裁决。 |
| `archive_ready` | preservation review when present | archive bundle / preservation manifest / synced specs | 仅当 archive 前存在 role review 时启用 disclosure loop。 |

`proposal_reviewed` 是新增 internal gate，不是 advisory note。实现时必须：

- 在 `proposal.md` 写完并经 OpenSpec status 标为 done 后立即运行。
- 在开始 `specs/**/*.md`、`design.md`、`tasks.md` 前作为硬前置。
- 加入 `propose_complete` 的 internal subgate 列表；`propose_complete` 必须依次要求 `explore_complete`、`proposal_reviewed`、`design_complete`、`invariants_reviewed`、`test_contract_drafted`、`tasks_complete`。
- `design_complete` 必须直接 require `proposal_reviewed`。
- `invariants_reviewed` 必须 require `design_complete`；`test_contract_drafted` 必须 require `invariants_reviewed`；`tasks_complete` 必须 require `test_contract_drafted`。实现不能假定“现有 predecessor chain”已经成立；每个内部 gate 的 direct entry、route alias 和 `check-enter --gate ...` 路径都必须执行同一前置链。
- 若实现选择不依赖逐级调用链，`tasks_complete` 必须显式 require `proposal_reviewed`、`design_complete`、`invariants_reviewed`、`test_contract_drafted` 全部 allow 后才可 allow。
- 从 `superspec-propose` skill 删除“proposal review 不新增 guard gate / human confirmation pause”的旧口径。

核心规则：

1. 每一轮 role review 都产生 `review_round_id`。
2. 每个 reviewer finding 都必须有稳定 `finding_id`。
3. 每个 gate 必须有 disclosure evidence；`review_complete` 使用 `main_adjudication` 承担该职责，其它 gate 使用 `main_review_digest`。
4. disclosure evidence 必须列出每个 finding 的处置。
5. material finding 必须引用 `user_review_decision` 或明确 standing authorization。
6. disclosure evidence 绑定被审查 artifact 的 `target_refs` / blob sha。
7. **Stale 是惰性判定，不是编辑期触发器（R1）**：stale 只在 `check-enter` / gate check 时刻计算——当 round 的 pinned `target_refs` 集合与当前 target map **集合不相等**（路径集合或任一 blob sha 不同）时，该 round 不可用；编辑期间 guard 不介入。判定纯靠 sha + 集合相等，**不使用** `created_at` / 文件 mtime 排序（P2-1）。
8. 最新 round clean 前不能进入下一阶段。

### 3.1 轮次经济（Round Economy，R1–R5）

**R2 批处理协议：每 gate 标准节奏为 2 轮**

1. Round 1（全量审）：所有 required roles **并行**跑一次；
2. 一次性归集：全部 findings 进同一份 digest，全部 `needs_user_decision` material findings 合并为**一个**用户 checkpoint（一次交互逐 finding 给 A/B/C/D）；
3. 一次性修改：拿到全部裁决后批量完成所有 artifact 修改；
4. Round 2（收敛审）：再跑一轮，正常 clean，gate 过。

典型成本：每 gate 2 轮 review + 1 次用户交互。该节奏与实证审计 H-2（批量补票工作模式）兼容——用户 checkpoint 合并为单次交互是一等公民，不是对机制的妥协。

**R3 第 2 轮起使用增量审查合同**

Round k>1 的 reviewer `prompt_ref` 必须注入（guard 机检 `prompt_ref` 内容）：

- 工具命令**确定性生成**的 ledger render（如 `superspec ledger render --gate <gate>`），guard 对注入段做**逐字节**校验，主线程不得增删改；
- 上一轮全部 findings + dispositions；
- 两轮 blob 之间的 artifact diff；
- ledger 全部 `accepted_deviation` 条目。

reviewer 义务：对 `fixed` 项必须对照 diff 验证修复事实，不得采信 disposition 文字声明；必须在 `acknowledged_accepted_deviation_uids[]` 中逐一确认已知 accepted deviation（P1-2）。

**R5 轮次预算 + 升级路由**

每 gate 全量轮预算建议 **3 轮**；耗尽仍不 clean 时 guard 强制 route 到 `escalate_round_budget`（剩余未终态 findings 整体披露、逐条拍板，见 §11）。

**Standing authorization 疲劳防护**：`allowed_categories` **不得**包含 `finding_type:"blocker"` 所依赖的 material categories；blocker 永远要么修复要么用户裁决，不得用宽泛授权绕过。

## 4. How：canonical evidence 模型

以下对象都是 SuperSpec evidence，不是外部 control-state。它们必须遵守现有通用 schema：`schema_version`、`evidence_id`、`change_id`、`gate`、`kind`、`created_at`、`created_by`、`status`。顶层字段不得使用现有 forbidden field，例如 `stage`。

### 4.1 Role review findings

早期阶段扩展现有 `kind:"review"` evidence；最终 review 继续使用 `kind:"source_guidance"` 的 claims / findings。非-final role review evidence 至少包含 `review_round_id` 和 `findings[]`。

Final `source_guidance` 不新增 `findings[]`，继续使用现有 `blocking_findings` / `non_blocking_findings`。Ledger builder 必须把 final `source_guidance.blocking_findings[]` 规范化为 `finding_type:"blocker"`，把 `non_blocking_findings[]` 规范化为 `finding_type:"non_blocking_finding"`；其它 gate 读取 `findings[]`。这样只有一个 ledger normalization surface，不产生双字段真相源。

```json
{
  "schema_version": 1,
  "evidence_id": "EV-explore-r1-critic",
  "change_id": "refactor-vacation-duration-api",
  "gate": "explore_complete",
  "kind": "review",
  "created_at": "2026-06-09T00:00:00Z",
  "created_by": "native-subagent",
  "status": "blocked",
  "agent_role": "critic",
  "execution_mode": "native_subagent",
  "agent_id": "critic-1",
  "prompt_ref": ".superspec/reports/explore-r1-critic-prompt.md",
  "output_ref": ".superspec/reports/explore-r1-critic-review.md",
  "review_round_id": "explore-r1",
  "acknowledged_accepted_deviation_uids": [],
  "target_refs": [
    {"path": ".superspec/artifacts/discovery.md", "blob_sha": "..."}
  ],
  "findings": [
    {
      "finding_id": "EXP-SCOPE-001",
      "finding_uid": "explore_complete:EV-explore-r1-critic:EXP-SCOPE-001",
      "finding_type": "blocker",
      "severity": "blocker",
      "category": "scope",
      "decision_scope_key": "vacation-duration-api:implementation-class-scope",
      "material_categories": ["scope", "non_goal"],
      "summary": "“实现类”可能指 VacationController、VacationDurationGetAdapter 或 ScheduleActualServiceImpl。",
      "source_refs": [
        {"path": ".superspec/artifacts/discovery.md", "blob_sha": "..."}
      ],
      "recommended_options": ["A", "B", "C", "D"],
      "requires_user_decision": true,
      "supersedes_finding_uids": []
    }
  ]
}
```

**分类 producer 合同（P0-2 / P1-5）**：`category`、`material_categories[]`、`decision_scope_key` 的**唯一 producer 是 reviewer**——必须源自 role review evidence 原文（`findings[]` 或 final `blocking_findings[]` / `non_blocking_findings[]`），主线程不得在 digest 归一化时降级或改写。digest / adjudication 中每条 disposition 的 `finding_type`、`category`、`material_categories[]`、`decision_scope_key` 必须与 origin finding **逐字段相等**，不等即 block。reviewer prompt 模板中的分类定义使用固定 canonical 模板，guard 校验 `prompt_ref` 内容包含该模板。

**`acknowledged_accepted_deviation_uids[]`（P1-2）**：role review evidence 顶层字段。当 ledger 中存在 `accepted_deviation` 终态时，clean round 的 role review 必须在该字段中逐一列出其 `finding_uid`；缺失即该 round 不算 clean。

**`supersedes_finding_uids[]`（P1-4）**：findings 可选字段。reviewer 认为旧 finding 被新 finding 替代时必须显式映射，不能只改名。

**`decision_scope_key` 语义锚点（P2-2）**：首次出现时 reviewer 必须在 finding 中给出 `source_refs[]` 语义锚点；后续复用同一 key 时 guard 校验锚点一致，防止同 blob 内不同问题套利。

`finding_type`：

- `blocker`
- `scope_risk`
- `open_question`
- `agent_assumption`
- `non_blocking_finding`

`category`：

- `scope`
- `non_goal`
- `acceptance`
- `business_semantics`
- `design_boundary`
- `test_gap`
- `implementation`
- `evidence`
- `process`

Material categories：

- `scope`
- `non_goal`
- `acceptance`
- `business_semantics`
- `design_boundary`

Material finding 的默认处置权不属于主线程，除非用户已经给出明确 standing authorization。`scope_risk`、`open_question`、`agent_assumption` 只要影响 material categories，也必须用户可见披露并裁决。

每个 material finding 必须携带：

- `finding_uid`：`gate + origin_review_evidence_id + finding_id`。
- `decision_scope_key`：稳定描述该裁决适用的语义范围，例如 `vacation-duration-api:implementation-class-scope`。
- `material_categories[]`：命中的 material categories 子集。

`finding_id` 只在单个 origin review evidence 内唯一；跨 role / round 的机检闭环必须使用 `finding_uid`。

### 4.2 main_review_digest

除 `review_complete` 外，其它 gate 使用 `kind:"main_review_digest"` 做用户可见 disclosure 与阶段出口 proof。

```json
{
  "schema_version": 1,
  "evidence_id": "EV-explore-r1-main-review-digest",
  "change_id": "refactor-vacation-duration-api",
  "gate": "explore_complete",
  "kind": "main_review_digest",
  "created_at": "2026-06-09T00:05:00Z",
  "created_by": "main-thread",
  "status": "blocked",
  "review_round_id": "explore-r1",
  "target_refs": [
    {"path": ".superspec/artifacts/discovery.md", "blob_sha": "..."}
  ],
  "source_review_evidence_refs": [
    "EV-explore-r1-critic"
  ],
  "previous_digest_refs": [],
  "finding_dispositions": [
    {
      "finding_id": "EXP-SCOPE-001",
      "finding_uid": "explore_complete:EV-explore-r1-critic:EXP-SCOPE-001",
      "origin_review_evidence_id": "EV-explore-r1-critic",
      "finding_type": "blocker",
      "category": "scope",
      "decision_scope_key": "vacation-duration-api:implementation-class-scope",
      "material_categories": ["scope", "non_goal"],
      "disposition": "needs_user_decision",
      "rationale": "该 finding 会改变本 change 的 non-goals 和测试范围。",
      "requires_user_decision": true,
      "artifact_update_refs": [],
      "evidence_refs": [],
      "source_refs": [
        {"path": ".superspec/artifacts/discovery.md", "blob_sha": "..."}
      ],
      "user_decision_refs": [],
      "standing_authorization_refs": [],
      "baseline_decision_refs": [],
      "route": "stay_same_gate_user_decision",
      "route_reason": "scope blocker requires user A/B/C/D before propose"
    }
  ]
}
```

**用户披露渲染契约（P1-1）**：material finding 的用户可见披露必须包含 reviewer `output_ref` 中的**原文引用**；或要求 digest disposition 的 `summary` 为 origin finding `summary` 的**逐字拷贝**（guard 校验相等）。最小披露格式（写入 `superspec-explore` 等 skill 模板）：finding 原文 + A/B/C/D 选项 + 每个选项对 scope / non-goals / acceptance / tests 的影响面。

**Disposition 身份一致性（P0-2）**：`finding_dispositions[]` 中每条记录的 `finding_type`、`category`、`material_categories[]`、`decision_scope_key` 必须与 `origin_review_evidence_id` 指向的 origin finding 逐字段相等。

允许的 `disposition`：

- `fixed`
- `false_positive`
- `accepted_deviation`
- `user_decided`
- `needs_user_decision`

状态语义：

- `status:"blocked"`：存在 `needs_user_decision`、未终态 blocker、stale target refs 或缺少 required re-review。
- `status:"pass"`：所有 findings 有终态 disposition，material dispositions 已有用户确认或 standing authorization，且 target refs 是当前版本。
- `status:"superseded"`：只允许用于纠正文档错误或 schema 错误，不得作为删除 finding history 的手段。

规则：

- `fixed` 必须在 `artifact_update_refs[]` 或 `evidence_refs[]` 中引用修复后的 artifact/evidence。
- `false_positive` 必须在 `source_refs[]` 中引用可审查依据。
- `accepted_deviation` 涉及 material categories 时必须在 `user_decision_refs[]` 中引用 `user_review_decision`，或在 `standing_authorization_refs[]` 中引用有效授权。
- `user_decided` 必须在 `user_decision_refs[]` 中引用 `user_review_decision`。
- `needs_user_decision` 存在时，该 gate 必须 block。
- digest 之间必须用 `previous_digest_refs` 串起同 gate 历史。

Per-disposition proof 字段：

| Disposition | Required proof fields |
| --- | --- |
| `fixed` | non-empty `artifact_update_refs[]` or `evidence_refs[]`; if target artifacts changed, a later same-gate review round is required. |
| `false_positive` | non-empty `source_refs[]`; `rationale` must explain why the finding is invalid. |
| `accepted_deviation` | non-empty `user_decision_refs[]` for material categories, unless non-empty valid `standing_authorization_refs[]` applies. |
| `user_decided` | non-empty `user_decision_refs[]`; `rationale` maps user decision to artifact/test impact. |
| `needs_user_decision` | no terminal proof allowed; gate blocks until replaced by another disposition. |

Material findings have an additional rule: every terminal disposition, including `fixed` and `false_positive`, must cite non-empty `user_decision_refs[]`, valid `standing_authorization_refs[]`, or valid `baseline_decision_refs[]`. `source_refs[]` alone never proves a prior user-confirmed baseline.

`baseline_decision_refs[]` must point to `user_review_decision` or gate-scoped `human_confirmation` evidence that:

- has `created_by:"user"`;
- has the same `change_id` as the finding being disposed;
- has the same `gate`, unless the consuming evidence includes a valid `predecessor_decision_inheritance[]` entry for that prior gate; cross-change baseline reuse is forbidden in v1;
- predates the finding being disposed;
- covers the same `decision_scope_key`;
- covers all required `material_categories[]`;
- pins the same artifact blob through `confirmed_refs[]`, `target_refs[]`, or equivalent pinned refs.

Predecessor decision inheritance is only allowed through a machine-checkable `predecessor_decision_inheritance[]` entry on the consuming digest/adjudication:

```json
{
  "source_decision_ref": "EV-explore-r1-user-decision-scope",
  "source_gate": "explore_complete",
  "target_gate": "proposal_reviewed",
  "decision_scope_key": "vacation-duration-api:implementation-class-scope",
  "material_categories": ["scope", "non_goal"],
  "inherited_target_refs": [
    {"path": ".superspec/artifacts/discovery.md", "blob_sha": "..."}
  ]
}
```

Validation rules:

- `source_decision_ref` must also appear in `baseline_decision_refs[]`.
- `source_decision_ref` must be same-change user-created `user_review_decision` or `human_confirmation`; cross-change inheritance is forbidden in v1.
- `source_gate` / `target_gate` must match the static gate predecessor table; arbitrary cross-gate reuse blocks.
- `target_gate` must equal the consuming evidence gate.
- `decision_scope_key`, `material_categories[]`, and `inherited_target_refs[]` must match the disposed finding and the pinned artifact blob being used as baseline.

Allowed v1 inheritance pairs（P1-3 补全；`inherited_target_refs[]` 一律按 **change root** 解析 `path`，即使 final review 的 source refs 用 repo root）：

| Source gate | Target gates |
| --- | --- |
| `explore_complete` | `proposal_reviewed`, `design_complete`, `invariants_reviewed`, `test_contract_drafted`, `tasks_complete`, `review_complete`, `archive_ready` |
| `proposal_reviewed` | `design_complete`, `invariants_reviewed`, `test_contract_drafted`, `tasks_complete`, `review_complete`, `archive_ready` |
| `design_complete` | `invariants_reviewed`, `test_contract_drafted`, `tasks_complete`, `review_complete`, `archive_ready` |
| `invariants_reviewed` | `test_contract_drafted`, `tasks_complete`, `review_complete`, `archive_ready` |
| `test_contract_drafted` | `tasks_complete`, `review_complete`, `archive_ready` |
| `tasks_complete` | `review_complete`, `archive_ready` |
| `review_complete` | `archive_ready` |

**决策 lineage（P1-3）**：继承要求 pinned blob 一致。若 discovery 等在后续 gate 被合法修改，原始 decision 钉的旧 blob 失效，继承断裂；合法路径是中间 gate 的新 `user_review_decision` 成为新 baseline，决策沿 `previous_digest_refs` 链向前滚动——**不使用** `created_at` 时间序判定先后（P2-1）。

**Omnibus 审查范围合同（H-1 / FIX-11 已落地）**：跨 gate 复用同一 `output_ref` 的 role evidence 必须声明 `review_scope[]` 且覆盖本 gate 的 target artifact，否则 block `review_scope_unverified`。一次 omnibus 审查盖几个章，就要在 scope 合同里写几个 target；禁止一份 review 隐式盖多个 gate 的章。

This prevents the main thread from silently “fixing” a scope / non-goal / acceptance / business semantics / design boundary finding into the artifact without user-visible裁决.

### 4.3 user_review_decision

`user_review_decision` 记录用户对 material finding 的裁决。

```json
{
  "schema_version": 1,
  "evidence_id": "EV-explore-r1-user-decision-scope",
  "change_id": "refactor-vacation-duration-api",
  "gate": "explore_complete",
  "kind": "user_review_decision",
  "created_at": "2026-06-09T00:10:00Z",
  "created_by": "user",
  "status": "pass",
  "review_round_id": "explore-r1",
  "finding_ids": ["EXP-SCOPE-001"],
  "finding_uids": ["explore_complete:EV-explore-r1-critic:EXP-SCOPE-001"],
  "decision": "option_d_custom",
  "decision_scope_key": "vacation-duration-api:implementation-class-scope",
  "material_categories": ["scope", "non_goal"],
  "confirmed_refs": [
    {"path": ".superspec/artifacts/discovery.md", "blob_sha": "..."}
  ],
  "user_text": "只读 ScheduleActualServiceImpl 做行为锚点，不修改共享服务。",
  "structured_decision": {
    "scope": ["VacationController", "VacationDurationGetAdapter"],
    "non_goals": ["ScheduleActualServiceImpl algorithm/cache/applicationDuration"],
    "acceptance_impact": ["shared service call boundary must be tested or reviewed"],
    "test_impact": ["adapter/controller contract must cover shared service call boundary"],
    "requires_artifact_update": true,
    "requires_rereview": true
  },
  "confirmed_at": "2026-06-09T00:10:00Z"
}
```

用户 checkpoint 的默认选项：

- A：采用 reviewer 推荐的最小范围。
- B：扩大范围，并同步扩大测试、验收和影响面。
- C：先补 discovery，不进入下一阶段。
- D：自定义补充或改写裁决。

D 是一等处置，不是自由文本备注。主线程必须记录：

- 用户原文。
- 主线程结构化理解。
- 影响到的 scope / non-goals / acceptance / tests。
- 是否需要更新 artifacts。
- 是否需要重跑 role review。

如果用户的 D 选项仍有歧义，主线程只允许问一个聚焦问题；不能自行压缩成 A/B/C。

`decision` 是机检枚举：

- `option_a`
- `option_b`
- `option_c`
- `option_d_custom`

`option_d_custom` 必须额外满足：

- `user_text` 非空，保留用户原文。
- `structured_decision.scope[]`、`structured_decision.non_goals[]`、`structured_decision.acceptance_impact[]`、`structured_decision.test_impact[]` 必须存在；无影响时写空数组，不能省略字段。
- `structured_decision.requires_artifact_update` 和 `structured_decision.requires_rereview` 必须是布尔值。
- 若 `requires_artifact_update:true`，消费该 decision 的 terminal disposition 必须引用后续 artifact update；否则 block。
- 若 `requires_rereview:true`，消费该 decision 的 pass disclosure/adjudication 必须引用**结构序上晚于**该 decision 的同 gate role review round（round 的 `review_round_id` 编号更大，且 `target_refs` blob 为当前版本；**不依赖** `created_at`，P2-1）；否则 block。

Valid `user_review_decision` rules:

- `created_by` must be `user`（v1 为自声明字符串；guard 不机械证明用户真在场，见 §2.2 信任天花板）。
- It must share the same `change_id` and `gate` as the finding being decided.
- It must be **structurally after** the origin finding in the same gate round chain（`review_round_id` 不早于 origin finding 所在 round；消费它的 digest 必须通过 `previous_digest_refs` 链可追溯到该 decision，**不依赖** `created_at`）。
- `decision` must be one of `option_a | option_b | option_c | option_d_custom`.
- `finding_uids[]` must include the exact `finding_uid`; matching by bare `finding_id` is insufficient.
- `decision_scope_key` must match the finding.
- `material_categories[]` must cover every material category on the finding.
- `confirmed_refs[]` must pin the target/source artifact blob being confirmed.

Gate-scoped `human_confirmation` can serve as a baseline decision only if it exposes the same `decision_scope_key`, `material_categories[]`, and pinned `confirmed_refs[]` fields.

### 4.4 review_standing_authorization

Standing authorization 必须是用户确认派生的 canonical evidence，不能由主线程默认创造。

```json
{
  "schema_version": 1,
  "evidence_id": "EV-review-standing-auth-current-change",
  "change_id": "refactor-vacation-duration-api",
  "gate": "explore_complete",
  "kind": "review_standing_authorization",
  "created_at": "2026-06-09T00:00:00Z",
  "created_by": "user",
  "status": "pass",
  "scope": "current_change",
  "issuer": "user",
  "confirmation_text": "可自行补测试和证据，但不得自行扩大范围或改业务语义。",
  "allowed_categories": ["test_gap", "implementation", "evidence"],
  "excluded_categories": ["scope", "non_goal", "acceptance", "business_semantics", "design_boundary"],
  "valid_gates": ["explore_complete", "proposal_reviewed", "design_complete", "invariants_reviewed", "test_contract_drafted", "tasks_complete"],
  "expires_at": null
}
```

Fail-closed 规则：

- 默认不授权 material categories。
- 授权必须有 `created_by:"user"`、`confirmation_text`、`valid_gates` 和显式 category allow/deny。
- 若 `allowed_categories` 与 `excluded_categories` 冲突，以 excluded 为准并 block。
- 超出 scope、过期、gate 不匹配或 category 不匹配时不得引用。

## 5. Append-only finding history

旧 role evidence 可以按现有 `superseded` 机制退出 live 集合，但 finding history 不能消失。

因此 disclosure gate 不得只看 `live_pass()`。它必须扫描同 change 下所有 relevant role review evidence 和 all digest/adjudication evidence，构建 append-only finding ledger：

```text
finding_uid = gate + origin_review_evidence_id + finding_id
```

Ledger 规则：

1. 任一 role review evidence 中出现过的 blocker / scope risk / open question / agent assumption 都进入 ledger。
2. 任一 material-category finding 都进入 ledger，即使 `finding_type:"non_blocking_finding"`。
3. 后续 digest 必须通过 `previous_digest_refs` 串接历史，并为每个未终态 finding 给出 disposition。
4. 若 reviewer 认为旧 finding 已被新 finding 替代，必须使用 `supersedes_finding_uids` 或 `successor_finding_uid` 显式映射；不能只改名。
5. Source evidence 可被 superseded；ledger 仍保留旧 finding，直到 digest 给出终态 disposition。
6. Guard 检查的是“历史未终态 findings”，不是“当前 live source guidance 是否还有 blocker”。
7. 任何 digest 不得通过 `status:"superseded"` 删除未终态 finding；纠错 digest 必须引用并重新处置旧 finding。
8. **Round 连续性（P0-1）**：同 gate 的 `review_round_id` 必须形如 `<gate>-r1..rN` **连续编号**；digest 链长与 round 数一致。删除中间一轮必然造成编号断档或 `previous_digest_refs` 链断裂 → block。
9. **损坏 evidence 纠错（P2-5）**：若历史 evidence JSON 损坏或 schema 无效，ledger 构建不得永久 block 且无出口。允许 `kind:"correction_digest"`（用户确认后）引用损坏文件路径与文件 sha，逐条重申或作废其中 findings；guard 在存在覆盖该文件的 correction digest 时跳过原始文件解析。不允许主线程单方面跳过损坏文件。

## 6. Guard 规则

每个多角色 review gate 新增或内联 `review_disclosure_complete` 检查。

Gate 只有在以下条件全部满足时才能 allow：

1. 当前 target refs 上存在最新 `review_round_id` 的 required role review evidence。
2. 每条 role review finding 都出现在同轮 disclosure evidence。
3. Disclosure evidence 引用所有参与该轮的 role review evidence。
4. Disclosure evidence 的 `target_refs` 与当前 target map **集合相等**（路径集合 + 逐路径 blob sha 完全一致；含 glob 时枚举当前命中集合与 pinned 集合比对，新增/删除/改动任一项均 stale，P1-6）。
5. Stale 判定为惰性（R1）：仅在 gate check 时刻计算；round 的 pinned 集合 ≠ 当前 target map 集合时该 round 不可用。
6. Append-only finding ledger 中不存在未终态 blocker、material-category finding、material scope risk、material open question 或 material agent assumption。
7. 不存在 `needs_user_decision`。
8. Material finding 的任何 terminal disposition 都必须引用有效 `user_review_decision`、standing authorization，或 `baseline_decision_refs[]` 指向的 prior user-confirmed material baseline。
9. 用户 decision 或 disposition 导致 artifact 修改后，必须有修改之后的新 role review round。
10. 如果用户裁决接受一个未修复的 material deviation，必须建模为 `accepted_deviation`；clean round 的 role review 必须在 `acknowledged_accepted_deviation_uids[]` 中逐一确认（P1-2），否则不能作为 clean round。
11. 每个 disposition 必须满足 per-disposition proof 字段；缺失即 block。
12. Guard next actions 必须输出结构化 route（与 §11 枚举一致），不允许只给自由文本建议；`finding_dispositions[].route` / `route_reason` 必须合法（P1-4）。
13. **引用完整性**：任何 evidence 中 `*_evidence_refs` / `lane_evidence_refs` / `supersedes` 指向不存在的 `evidence_id` → block `dangling_evidence_ref`（已由 FIX-12 在 evidence schema 防线落地）。
14. **Round 连续性**：`review_round_id` 连续编号 + `previous_digest_refs` 链完整（§5 规则 8）。
15. **Disposition 身份一致性**：digest/adjudication disposition 的 `finding_type` / `category` / `material_categories[]` / `decision_scope_key` 与 origin finding 逐字段相等（P0-2）。
16. **Re-review prompt 注入**：Round k>1 的 `prompt_ref` 必须包含工具生成的 ledger render 段，guard 逐字节校验（R3）。
17. **用户披露**：material finding 的 digest `summary` 与 origin finding 逐字相等，或披露模板包含 `output_ref` 原文引用（P1-1）。
18. **轮次预算**：同 gate 全量 round 数超过预算（默认 3）仍不 clean → 强制 `escalate_round_budget` route（R5）。

伪代码（结构序，无时间戳）：

```text
for gate in review_disclosure_gates:
  targets = enumerate_target_set(review_targets_by_gate(gate))  # glob -> concrete path set
  ledger = build_finding_ledger(all_review_evidence(gate), all_disclosure_evidence(gate), correction_digests)
  latest_round = latest_clean_round_by_structure(gate, targets)  # sha match + round_id chain, not created_at
  require role_reviews(latest_round, targets)
  require round k>1 prompts contain tool-rendered ledger injection
  disclosure = require disclosure_for(latest_round, targets)
  require pinned_set(disclosure.target_refs) == targets
  require disposition identity fields match origin findings
  require disclosure covers every finding from role_reviews(latest_round)
  require no unresolved ledger findings
  require no needs_user_decision
  require material dispositions cite user_review_decision or authorization
  allow
```

### 6.1 Guard 规则可追溯性表（A9）

| Guard 规则 | 输入字段 | Schema 章节 | Producer |
| --- | --- | --- | --- |
| 1 最新 round role review | `review_round_id`, `target_refs`, `agent_role` | §4.1 | reviewer (native_subagent) |
| 2 finding 全覆盖 | `findings[]` / `blocking_findings[]` | §4.1 | reviewer |
| 3 disclosure 引用 reviews | `source_review_evidence_refs` | §4.2 | main thread |
| 4 target 集合相等 | `target_refs[]` | §4.2 / §7 | main thread + normalizer 枚举 glob |
| 5–6 stale 惰性 | pinned set vs current set | §3 规则 7, §7 | guard 派生 |
| 7 ledger 无未终态 | `finding_dispositions[]`, ledger | §4.2, §5 | main thread digest |
| 8 无 needs_user_decision | `disposition` | §4.2 | main thread |
| 9 material 终态 proof | `user_decision_refs[]`, etc. | §4.2, §4.3 | user + main thread |
| 10 accepted deviation 确认 | `acknowledged_accepted_deviation_uids[]` | §4.1 | reviewer |
| 11 per-disposition proof | proof 字段表 | §4.2 | main thread |
| 12 结构化 route | `route`, `route_reason` | §4.2, §11 | main thread |
| 13 引用完整性 | `*_evidence_refs` | §4.2 | main thread（FIX-12 已落地） |
| 14 round 连续性 | `review_round_id`, `previous_digest_refs` | §4.1, §4.2, §5 | main thread |
| 15 身份一致性 | `category`, `material_categories[]`, … | §4.1, §4.2 | reviewer 产出，main thread 不得改 |
| 16 ledger 注入 | `prompt_ref` 内容 | §3.1 R3 | 工具生成，reviewer 引用 |
| 17 用户披露 | `summary` / `output_ref` | §4.2 P1-1 | reviewer 原文 + main thread 逐字拷贝 |
| 18 轮次预算 | round count | §3.1 R5 | guard 派生 |

## 7. Review target map

`review_targets_by_gate` 是实现前必须落地的显式表，不允许由 agent 自由猜。

| Gate | Root | Required target refs | Stale when |
| --- | --- | --- | --- |
| `explore_complete` | change root | `.superspec/artifacts/discovery.md` | discovery blob changes after digest. |
| `proposal_reviewed` | change root | `proposal.md`, `.superspec/artifacts/discovery.md` | proposal or discovery changes after digest. |
| `design_complete` | change root | `proposal.md`, `design.md`, `specs/**/*.md`, `.superspec/artifacts/discovery.md` | any listed artifact changes after digest. |
| `invariants_reviewed` | change root | `.superspec/artifacts/business-invariants.md`, `design.md`, `specs/**/*.md` | invariants/design/specs change after digest. |
| `test_contract_drafted` | change root | `.superspec/artifacts/test-contract.md`, `.superspec/artifacts/business-invariants.md`, `design.md`, `specs/**/*.md` | test contract or upstream semantics change after digest. |
| `tasks_complete` | change root | `tasks.md`, `.superspec/artifacts/test-contract.md`, `.superspec/artifacts/business-invariants.md`, `design.md`, `specs/**/*.md` | task mapping or upstream acceptance/invariant/spec changes after digest. |
| `review_complete` | repo root for changed files; change root for OpenSpec/sidecar artifacts | merge-base diff 枚举的 changed repo files + OpenSpec/sidecar artifacts（canonical 定义：merge-base..HEAD name-only diff + untracked；未提交文件用 `git hash-object` 现算 blob sha）+ `final_test` evidence（按 `code_fingerprint` 比对，P2-4） | changed-files 指纹或 final_test `code_fingerprint` 与 adjudication 时不一致（P2-4）；或 artifact 集合不等（P1-6）。 |
| `archive_ready` | change root plus main specs root when syncing | archive preservation bundle, manifest, synced spec targets | bundle, manifest, or synced spec target changes after digest. |

`source_guidance` 可继续使用 repo-root target refs；非 final-review role evidence 使用 change-root refs。每个 gate 的 schema validation 必须知道 root，不允许混用导致 stale check 假阳性或假阴性。

**集合相等 stale 语义（P1-6）**：含 `specs/**/*.md` 等 glob 的 gate，check 时必须枚举当前 glob 命中集合，要求与 digest pinned 集合**完全一致**（路径 + blob sha）；仅“已 pin 的路径仍新鲜”不够——新增 spec 文件若未入 pinned 集合仍应 stale。

**`final_test` 身份模型（P2-4）**：`final_test` evidence 增加 `code_fingerprint`（运行时 changed-files 的 blob sha 集合或 tree sha）+ `output_sha256`。`main_adjudication` 通过 `verification_evidence_refs` 引用 `final_test` 的 **evidence_id**；stale 判定 = `final_test.code_fingerprint != 当前 changed-files 指纹`（日志 path/hash 只证明日志未改，不证明测的是当前代码）。

## 8. Final review 与 main_adjudication 的关系

`review_complete` 不新增第二份主裁决。v1 禁止为 final review 生成独立 `main_review_digest`。为避免双重口径：

- `main_adjudication` 是 final review 的 disclosure carrier。
- `main_adjudication` 必须增加或引用 `review_round_id`、`previous_digest_refs`、`user_decision_refs`、`finding_history_refs`。
- `main_adjudication` 继续使用现有 canonical `source_evidence_refs`，不得新增 `source_review_evidence_refs` 或其它别名。
- `main_adjudication` 必须包含 pinned `adjudication_target_refs[]`，覆盖 `review_targets_by_gate("review_complete")` 的当前目标指纹；该字段是 final review 的 stale-check carrier。
- `finding_adjudications` 继续使用现有枚举：`dismissed | accepted_fixed | accepted_deviation | needs_fix`。
- `finding_adjudications[]` 必须扩展 identity/proof fields：`finding_uid`、`origin_review_evidence_id`、`finding_type`、`category`、`decision_scope_key`、`material_categories[]`、`artifact_update_refs[]`、`evidence_refs[]`、`source_refs[]`、`user_decision_refs[]`、`standing_authorization_refs[]`、`baseline_decision_refs[]`。
- 通用 digest disposition 到 final review 的映射为：
  - `false_positive` -> `dismissed`
  - `fixed` -> `accepted_fixed`
  - `accepted_deviation` -> `accepted_deviation`
  - `needs_user_decision` -> `needs_fix`
  - `user_decided` -> `accepted_deviation` 或 `accepted_fixed`，按用户裁决结果映射
- Final ledger reconstruction 以 `source_guidance.blocking_findings[]` / `source_guidance.non_blocking_findings[]` 为 finding origin，以 `main_adjudication.finding_adjudications[]` 为 disposition carrier。`main_adjudication` 不能省略 material `non_blocking_findings[]`；每个 adjudication 必须通过 `finding_uid` 或 `(origin_review_evidence_id, finding_id)` 精确对应一个 origin finding。
- 若两个 final `source_guidance` 复用同一 `finding_id`，必须产生两个不同 `finding_uid`，并要求两条独立 adjudication。裸 `finding_id` 不足以关闭 final finding。
- 若发现 `gate:"review_complete"` + `kind:"main_review_digest"` 的 live/pass evidence，v1 guard 必须 block，避免双重状态漂移。
- **Final source_guidance producer 合同（P1-5）**：`blocking_findings[]` / `non_blocking_findings[]` 中每个 finding 必须带 `category`（全量枚举）；命中 material categories 时必须带 `material_categories[]` + `decision_scope_key`；`evidence.ts` 校验同步收紧。`finding_uid` 由 normalizer 机械推导，不要求 reviewer 手写。

## 9. 阶段行为

### 9.1 Explore

`explore_complete` 是最高优先级修复点，因为它决定后续 proposal 的事实层。

正确行为（R2 批处理节奏；H-2 兼容批量工作模式）：

1. `superspec-explore` 产出 discovery 草稿。
2. Round 1：`critic` 全量审查 discovery。
3. 主线程生成 digest，**一次性**归集全部 material findings，向用户展示**一个** checkpoint（每条含 finding 原文 + A/B/C/D + 影响面，P1-1）。
4. 用户逐 finding 选择 A/B/C/D（单次交互完成全部裁决）。
5. 主线程**批量**按全部裁决更新 discovery。
6. Round 2：重新运行 `critic`（prompt 注入工具生成的 ledger render + diff，R3）。
7. 最新 discovery + Round 2 critic clean（含 `acknowledged_accepted_deviation_uids[]` 若适用）+ clean digest 后，`explore_complete` 才 allow。

`refactor-vacation-duration-api` 示例 checkpoint：

- A：只重构 GET endpoint 的 controller/adapter，`ScheduleActualServiceImpl` 为 non-goal。
- B：纳入共享核心服务，扩大影响面和测试契约。
- C：先补 discovery，不进入 propose。
- D：用户自定义范围或补充裁决。

### 9.2 Proposal

现有 proposal advisory critic review 必须升级为 `proposal_reviewed` internal gate。

规则：

- proposal critic blocker 不能由主线程直接修完再重跑到 pass。
- 若 finding 影响 scope / non-goals / hidden assumptions，必须 digest + 用户 decision 或 standing authorization。
- 若 finding 证明 discovery 本身不完整，正确 route 是回 `explore_complete`，而不是在 proposal 内静默补范围。

### 9.3 Design / Invariants / Test Contract / Tasks

这些 gate 同样适用 fixed-point loop。

示例：

- design reviewer 指出 adapter 边界与 shared service 语义不清：material `design_boundary`，必须 digest + 用户确认或授权。
- test-engineer 指出验收口径缺少可执行测试路径：`acceptance` 或 `test_gap`，如果改变验收口径则必须用户确认。
- critic 指出 non-goal 被 artifact 静默扩大：`non_goal`，必须用户确认。

`tasks_complete` 当前没有 role-review requirement。若实施本设计，必须先新增 tasks review role evidence，再把它纳入 gate；否则不能宣称 tasks 阶段已受 disclosure loop 保护。

### 9.4 Final Review

现有 `source_guidance -> verification_review/final_test -> main_adjudication` 机制保留，但接入同一 finding ledger：

- `main_adjudication` 继续作为最终 allow / request_changes 的 canonical evidence。
- `main_adjudication` 承担 review disclosure 和 finding history closure。
- 若 final review 发现 material accepted deviation，仍需要 `user_review_decision`。
- 返工后可以 supersede 旧 source evidence，但 finding ledger 仍必须保留旧 blocker 的终态处置。

## 10. 升级矩阵

| Finding type | Material category? | Default handling |
| --- | --- | --- |
| `blocker` | yes | 必须用户 decision 或 standing authorization；修复后重审。 |
| `blocker` | no | 可由主线程修复；必须 digest 披露并重审。 |
| `scope_risk` | yes | 必须用户 decision；不能静默写入 non-goals。 |
| `open_question` | yes | 若本地 discovery 可回答，先补 discovery；若仍分支，必须问用户。 |
| `agent_assumption` | yes | 必须披露并确认或改写为已验证事实。 |
| `non_blocking_finding` | no | 可自动处置；digest 披露即可，不打断用户。 |

## 11. Gate route matrix

Material finding 不能由主线程自由解释路由。Disclosure guard 的 next actions 必须使用以下结构化 route：

| Current gate | Finding category / type | Legal route | Notes |
| --- | --- | --- | --- |
| `explore_complete` | `scope`, `non_goal`, material `open_question`, material `agent_assumption` | `stay_same_gate_user_decision` | 用户 A/B/C/D 裁决后更新 discovery 并重审。 |
| `proposal_reviewed` | discovery incomplete / scope unclear | `return_explore` | 回 `explore_complete`，不能在 proposal 内静默补事实层。 |
| `proposal_reviewed` | proposal wording / intent inconsistency not changing scope | `stay_same_gate_fix` | 修 proposal 后重跑 critic。 |
| `design_complete` | scope / non-goal mismatch | `return_explore_or_proposal_reviewed` | 若事实层错回 explore；若 proposal 表达错回 proposal。 |
| `design_complete` | design boundary / architecture tradeoff | `stay_same_gate_user_decision` | 用户确认设计取舍后改 design 并重审。 |
| `invariants_reviewed` | business semantics / invariant truth uncertain | `stay_same_gate_user_decision` | 不能把当前实现习惯静默升格为业务真相。 |
| `test_contract_drafted` | acceptance criteria changed | `stay_same_gate_user_decision` | 用户确认验收口径；若 spec/design 需改，回对应 gate。 |
| `tasks_complete` | task mapping/test_refs/read-write scope issue | `stay_same_gate_fix` | 修 tasks 后重审；若验收口径错，回 `test_contract_drafted`。 |
| `review_complete` | implementation completion invalid | `reopen_tasks` | 复用现有 request_changes/reopen 协议。 |
| `review_complete` | scope / requirement / design blocker | `change_update` | 回 propose / design，不得伪装成 task reopen。 |
| `archive_ready` | preservation / synced spec mismatch | `stay_same_gate_fix` or `change_update` | 取决于是否改变 accepted spec semantics。 |
| *（任意 disclosure gate）* | round budget exhausted, findings still unresolved | `escalate_round_budget` | 用户终局裁决剩余未终态 findings（R5）。 |

Route evidence 必须记录在 disclosure evidence 的 `finding_dispositions[].route` / `route_reason` 字段中；guard action 输出也必须使用同一枚举。A/B/C/D 用户选项与 route matrix **统一为一套枚举**——C 选项实质是 `return_explore` 等 route 的用户可选形式，不得平行维护两套。

## 12. 解决方案落地顺序

### Phase 1：先落地 `explore_complete` 的 schema + guard + tests

- 增加 `main_review_digest`、`user_review_decision`、`review_standing_authorization` schema validation。
- 增加 `review_targets_by_gate("explore_complete")`。
- 修改 `superspec-explore` skill，使 critic blocker 必须 digest + decision + rerun。
- 测试覆盖：
  - schema-invalid digest block。
  - critic 在 explore 发现 scope blocker，没有 digest 时 block。
  - 有 digest 但 `needs_user_decision` 时 block。
  - 用户选择 D 后 discovery 被修改，但未 rerun critic 时 block。
  - rerun critic clean 且 digest 绑定最新 blob 后 allow。
  - 后续 pass review 不能让旧 blocker 消失；旧 blocker 没有终态 disposition 时 block。
  - material `open_question` / `agent_assumption` 未终态时 block。
  - `review_standing_authorization.created_by!="user"` block。
  - `allowed_categories` 与 `excluded_categories` 冲突时 excluded 优先并 block。
  - expired / gate-mismatched / category-mismatched authorization block。
  - material scope authorization 不能从 generic confirmation text 推断。
  - valid non-material standing authorization allow-path 不应误 block。
  - `user_review_decision` 未绑定 exact `finding_uid`、target blob、decision scope 或 material categories 时 block。
  - stale / unrelated user decision with same bare `finding_id` but different `finding_uid` block。
  - `option_d_custom` 缺 `user_text`、缺 structured scope/non-goals/acceptance/test impact，或 `requires_artifact_update` / `requires_rereview` 不是布尔值时 block。
  - `option_d_custom.requires_artifact_update:true` 但 consuming disposition 未引用后续 artifact update 时 block。
  - `option_d_custom.requires_rereview:true` 但 consuming pass disclosure/adjudication 未引用 decision 后的新同 gate review round 时 block。
  - disposition 身份字段与 origin finding 不等时 block（P0-2）。
  - Round k>1 缺 ledger render 注入或注入非工具生成字节时 block（R3）。
  - `acknowledged_accepted_deviation_uids[]` 缺项时 block（P1-2）。
  - `review_round_id` 断档或 `previous_digest_refs` 链断裂时 block（P0-1）。
  - material digest `summary` 非 origin finding 逐字拷贝且无 `output_ref` 原文引用时 block（P1-1）。
  - 全量 round 超预算仍不 clean 时 block 并 route `escalate_round_budget`（R5）。

### Phase 2：纳入 `proposal_reviewed` / `design_complete`

- 将 proposal advisory review 转为 internal gate。
- `proposal_reviewed` 必须在 specs/design/tasks 前运行，并加入 `propose_complete` subgate list。
- 更新 canonical state surfaces：`ARTIFACT_ENTER_GATE`、`GATE_ROUTE` / aliases、`propose_complete` subgate list、`docs/SPEC.md`、`scripts/superspec/templates/workflow/skills/superspec-propose/SKILL.md`、安装后的 `.codex/skills/superspec-propose/SKILL.md`。
- 更新 predecessor checks：`design_complete` 直接 require `proposal_reviewed`；`invariants_reviewed` 直接 require `design_complete`；`test_contract_drafted` 直接 require `invariants_reviewed`；`tasks_complete` 直接 require `test_contract_drafted`，或显式 require `proposal_reviewed`、`design_complete`、`invariants_reviewed`、`test_contract_drafted` 全链。
- 为 design gate 增加 target map 和 finding ledger。
- 测试 proposal blocker 不能被主线程静默修掉。
- 测试缺少 `proposal_reviewed` 时 `propose_complete` block。
- 测试 proposal discovery-incomplete finding 必须 route `return_explore`。
- 测试 `proposal_reviewed` 缺少 artifact entry gate / route alias 时对应 entry path block。
- 测试缺少 `proposal_reviewed` 时直接 `check-enter --gate propose.design_reviewed` block。
- 测试直接 `check-enter --gate propose.tasks_mapped` / `tasks_complete` 在缺少前序 disclosure gate allow 时 block。

### Phase 3：推广到 invariants / test-contract / tasks

- 为每个 gate 明确 reviewer roles 和 targets。
- `tasks_complete` 只有在新增 role review 后才纳入 disclosure loop。
- 测试 upstream artifact 修改导致 digest stale。
- 测试 target root mismatch / unsafe root mismatch block。
- 测试 gate route matrix 的非法 route block。

### Phase 4：final review 与 reopen 兼容

- 将 finding ledger 接入 `main_adjudication`，避免双重裁决。
- 实现 ledger normalizer：非-final review 读取 `findings[]`；final `source_guidance` 读取 `blocking_findings[]` / `non_blocking_findings[]` 并规范化为同一 ledger record。
- 测试 final `main_adjudication` 映射、request_changes/reopen supersede 后 finding history 仍保留。
- 测试 material `accepted_deviation` 没有 user decision 时 block。
- 测试 `review_complete` 出现 live/pass `main_review_digest` 时 block。
- 测试 `source_review_evidence_refs` 等非 canonical source refs 别名 block。
- 测试 final `main_adjudication.adjudication_target_refs[]` 缺失或 stale 时 block。
- 测试 final `finding_adjudications[]` 缺 per-disposition proof fields 时 block。
- 测试 material `fixed` / `false_positive` 没有 user decision、standing authorization 或 prior user-confirmed baseline 时 block。
- 测试 `baseline_decision_refs[]` 缺失、非 user-created、时间晚于 finding、category/scope 不覆盖或未绑定同 blob 时 block。
- 测试 cross-gate baseline 缺 `predecessor_decision_inheritance[]`、source/target gate 不在静态继承表、或 inherited target blob 不匹配时 block。
- 测试 final `non_blocking_findings[]` 中 material-category finding 未终态时 block。
- 测试 final `non_blocking_findings[]` 中 material finding 缺 `finding_uid`、`category`、`material_categories[]` 或 `decision_scope_key` 时 block。
- 测试两个 final `source_guidance` 复用同一 `finding_id` 时必须用两个 `finding_uid` 分别 adjudicate。
- 测试 final material `non_blocking_findings[]` 被 `main_adjudication` 省略时 block。

### Phase 5：legacy / backfill / grandfathering

- 对已有 change 提供 review-only backfill：从旧 review reports 提取 findings，生成 digest/history。
- Backfill 不能伪造用户 decision；material unknown 必须保持 `needs_user_decision`。
- **Grandfathering（P2-3）**：按 change 的 `schema_version` 或首次 `explore_complete` allow 时间戳：升级前已通过的 gate 维持原判定口径（缺 digest 不追溯 block）；升级后**新进入**的 gate 启用 disclosure 检查。`refactor-vacation-duration-api` 等 in-flight change 的 Phase 1 验收必须验证：新 guard 不得追溯 block 已通过的历史 explore gate。

## 13. 成功标准

在 v1 信任天花板内（§2.2），机制应达到：

- 现存 evidence 叙事下，任何 gate 的 role blocker 不能在没有 ledger 终态 disposition 的情况下被“重跑到 pass”抹掉。
- 用户能在进入下一阶段前看到影响 scope / non-goals / acceptance / business semantics / design boundary 的问题、原文与 A/B/C/D 选项及影响面（P1-1）。
- 用户自定义 D 裁决被结构化记录，并驱动 artifact 更新和重审。
- 最新 artifact 版本必须经过结构序上最新的 clean role review round；旧 digest 不能背书新文本（集合相等 stale，R1）。
- 历史 finding ledger 中不存在未终态 blocker / material risk / material open question / material assumption。
- 多轮 review 在轮次预算内收敛到 fixed point，或经 `escalate_round_budget` 用户终局裁决后才允许进入下一阶段。

**不承诺**（残余风险，修完上述后仍存在）：v1 不验证作者在场性与历史完整性；主线程若伪造/删除整套自洽 evidence 仍可绕过（P0-1 v1 接受项）。Reviewer 分类质量本身不在本设计证明范围。
