# SuperSpec 业务不变量审查改造方案

> 状态：RFC 草案，已完成 critic 子代理初审并吸收 blocker/major 意见；待人工确认后再决定是否合入 `SPEC.md`。
> 目标：把 Invariant Review 纳入现有 SuperSpec 红绿灯体系，让 RED/GREEN 不只证明“测试通过”，还证明“测试与实现没有偏离业务不变量”。

## 1. 结论

本改造不替换 TDD，不改 OpenSpec artifact graph，也不新增 OpenSpec custom artifact。它只在 SuperSpec overlay 中新增一个 sidecar artifact：

```text
openspec/changes/<change>/.superspec/artifacts/business-invariants.md
```

`business-invariants.md` 在 `propose` 阶段生成，必须早于 `test-contract.md` 和 `tasks.md`。之后 `test-contract`、`tasks`、RED/GREEN evidence、review/verification evidence 都必须引用其中的 `INV-*` id。

核心关系：

```text
business-invariants 负责定义“凭什么算业务正确”
test-contract 负责把不变量转成可执行或可审查的验证点
RED/GREEN 负责证明目标测试在正确阶段失败/通过
critic/review 负责挑战测试和实现是否漏掉或扭曲不变量
guard 负责校验文件、映射、指纹和时序，不负责判断业务语义真伪
```

critic 初审结论：本改造可以纳入 SuperSpec，但必须作为 propose 内部 sidecar gate，不能改 OpenSpec graph；必须定义 artifact、evidence、gate 和交叉引用；必须防止实现后反推不变量。

## 2. 为什么需要这层

现有 SuperSpec v0.4 已经有 `test-contract`、RED/GREEN、subagent review 和 guard evidence，但它仍有一个质量空洞：如果需求理解错了，测试也可能写成错误的。RED/GREEN 只能证明“实现满足测试”，不能证明“测试代表真实业务规则”。

业务不变量审查补的是这层：

```text
需求/现状调查 -> 提前声明业务不变量 -> 生成 test-contract -> TDD 实现 -> 不变量审查
```

对 AI 开发尤其重要，因为模型很容易先写实现，再反推一套看起来合理的测试和解释。`business-invariants.md` 的价值是把关键业务规则提前钉住，并让后续每个证据都引用它。

## 3. 与现有 SuperSpec 边界的关系

必须保持 `docs/proposals/superspec/SPEC.md` v0.4 的边界：

- 不 fork OpenSpec schema。
- 不把 `business-invariants` 放进 OpenSpec artifact graph。
- 不修改 OpenSpec `proposal/specs/design/tasks` 的 requires 链。
- 不让 `business-invariants.md` 冒充 OpenSpec 正本。
- 仍由 `openspec instructions` 产出 OpenSpec artifact，SuperSpec 只叠加 sidecar、guard 和 review gate。

`business-invariants.md` 和现有 `test-contract.md` 一样，是 SuperSpec sidecar。它是 propose 内部 gate，不是用户可见主阶段。

## 4. 新增 sidecar artifact

新增模板源：

```text
docs/proposals/superspec/templates/business-invariants.md
```

运行时路径：

```text
openspec/changes/<change>/.superspec/artifacts/business-invariants.md
```

证据目录：

```text
openspec/changes/<change>/.superspec/evidence/invariants/
```

每条不变量至少包含：

| 字段 | 含义 |
|---|---|
| `INV-ID` | 稳定 id，例如 `INV-DAILY-MULTI-SHIFT-ISOLATION` |
| `statement` | 必须始终成立的业务规则 |
| `scope` | 适用业务域、模块、数据流或 task 范围 |
| `source_anchors` | 需求、文档、源码、历史 bug、测试或人工确认 |
| `acceptance_refs` | 关联 OpenSpec Scenario、REQ 或验收条目 |
| `risk_refs` | 关联风险场景或失效模式 |
| `confidence` | `confirmed` / `source-backed` / `inferred` / `uncertain` |
| `enforcement_level` | `automated-test` / `review-checklist` / `human-confirmation` / `advisory` |
| `test_refs_or_review_only_reason` | 对应 TEST/REVIEW id，或无法自动化的理由 |
| `verification` | 自动化测试、静态检查、review checklist 或人工确认 |
| `risk_if_broken` | 破坏后的业务后果 |
| `invalidation_triggers` | 哪些变更会让这条不变量失效或需重审 |

必须保留一个 “Non-invariants / Rejected Candidates” 区域，用来记录被拒绝的候选规则。这样可以防止模型把“当前实现习惯”误升格为业务真相。

概念边界：

| 概念 | 定位 |
|---|---|
| `business invariant` | 跨场景、任务和未来重构都必须保持的业务安全属性 |
| `acceptance criteria` | 本 change 交付后必须满足的验收结果 |
| `edge case` | 用来探测边界的输入或场景 |
| `risk scenario` | 不变量可能被破坏的失效模式 |
| `test-contract` | 把不变量、验收场景和风险落成 TEST/REVIEW 证据的映射 |

## 5. 流程改造

### 5.1 explore

`superspec-explore` 继续只产出 `discovery.md` 和 critic evidence。新增要求：

- `discovery.md` 记录候选不变量来源，但不直接确认其为业务真相。
- 候选不变量必须带 source anchors。
- 不确定的规则标为 `candidate` 或 `uncertain`，不能进入强 gate。

### 5.2 propose

在 `specs` 完成后、`test-contract.md` 起草前，生成 `business-invariants.md`：

```text
design_complete
  -> invariants_reviewed
  -> test_contract_drafted
  -> test_contract_honored
  -> tasks_complete
```

新增内部 gate：

```text
invariants_reviewed
```

通过条件：

- `business-invariants.md` 存在且结构有效。
- 每条 `INV-*` 有 statement、scope、source_anchors、acceptance_refs、risk_refs、confidence、enforcement_level、test_refs_or_review_only_reason。
- `confirmed` 或 `source-backed` 的不变量可进入 test-contract 硬映射。
- `inferred` 只能进入 review checklist，不能单独作为阻塞实现的硬业务真相。
- 有 critic native-subagent evidence 审查不变量是否太抽象、不可测、伪业务规则或缺 source anchor。
- 有 test-engineer native-subagent evidence 审查 enforcement level 与 test/review 映射是否可执行。
- 高风险业务不变量需要 human confirmation evidence。v1 中该 evidence 仍是 `trust:self_reported`。

### 5.3 test-contract

`test-contract.md` 只承载映射和 RED/GREEN 契约，不重复承载完整不变量正文。扩展表格，新增 `关联 INV` 列：

```markdown
| TEST-ID | 关联 REQ/Scenario | 关联 INV | 维度 | 测试意图 | 预期 RED 原因 |
```

`test_contract_drafted` gate 扩展为：

- 覆盖 specs 中每个 `#### Scenario`。
- 每个 `confirmed/source-backed` 且命中本 change scope 的 `INV-*` 至少映射到一个 `TEST-*` 或一个 `REVIEW-*` checklist。
- 对无法自动化的 `INV-*`，必须给出 review/verification 证据类型，不能留空。

### 5.4 tasks

扩展 `tasks.md` 结构块：

```markdown
- [ ] TASK-001 Fix multi-shift daily isolation
  - requirement_refs: REQ-001
  - invariant_refs: INV-DAILY-MULTI-SHIFT-ISOLATION
  - test_refs: TEST-001
  - read_scope: ...
  - write_scope: ...
  - tdd_required: true
  - tdd_mode: new-behavior
```

`test_contract_honored` gate 扩展为：

```text
test-contract TEST ids ⊆ tasks.test_refs
business-invariants INV ids used by tests ⊆ tasks.invariant_refs
RED/GREEN evidence test_id ⊆ test-contract
RED/GREEN evidence invariant_refs ⊆ business-invariants
```

### 5.5 apply

RED/GREEN 不是一刀切地要求所有不变量“修改前红、修改后绿”。按任务类型区分：

| 场景 | 修改前 | 修改后 | 说明 |
|---|---|---|---|
| 新行为 / bug 修复 | RED | GREEN | 目标不变量当前被破坏，测试应先失败 |
| 行为保持重构 | GREEN | GREEN | 用 characterization 测试锁定不变量，重构后保持 |
| 需求澄清 | SPEC RED | SPEC GREEN | 先补齐不变量、场景、风险，再允许进入 test-contract |

apply 期 evidence 必须引用 `test_id` 和 `invariant_refs`。如果实现代码改动命中某 task 的 `write_scope`，但没有该 task 的 RED/GREEN 或批准的 no-TDD reason，guard 继续 block。

### 5.6 review

新增 `Invariant Review` 检查面：

```yaml
business_invariants_verified:
  - invariant_id: INV-...
    evidence: TEST-... / REVIEW-... / static-check / human-confirmation
    status: pass

broken_or_weak_invariants:
  - invariant_id: INV-...
    finding: ...
    disposition: fix-required / accepted-risk / split-change
```

review critic 重点不是重看代码风格，而是挑战：

- 测试是否真的覆盖了不变量。
- 实现是否只让测试通过，却破坏了未测不变量。
- 是否把当前实现习惯错当成业务规则。
- 不变量是否被实现后修改过，导致事后反推。

### 5.7 verify / archive

verification evidence 新增 `invariant_matrix_ref`。archive preservation manifest 必须包含：

```text
.superspec/artifacts/business-invariants.md
.superspec/evidence/invariants/
.superspec/evidence/reviews/*invariant*
```

## 6. Guard 可校验与不可校验的边界

Guard 可以校验：

- sidecar 文件存在、路径合法、结构有效。
- `INV-*` id 唯一且格式正确。
- `test-contract.md`、`tasks.md`、RED/GREEN evidence 引用的 `INV-*` 都存在。
- `business-invariants.md` 的 fingerprint 写入 `superspec-state.json`。
- 不变量审查 evidence 的 `target_refs[].blob_sha` 与当前文件一致。
- 不变量文件在实现后被改动时，后续 test-contract/tasks/review evidence 失效并 block。

Guard 不能校验：

- 某条业务不变量是否真的符合产品规则。
- 某个测试断言是否真正证明了不变量。
- `source-backed` 是否引用了正确语义，而不是断章取义。
- v1 中 native subagent / human confirmation evidence 是否真实不可伪造。

这些必须由 critic/test-engineer/human evidence 承担。文档和 guard 输出必须诚实标注 v1 是 `audit-only`，不能宣称 mechanical 强制。

## 7. 防止“事后反推不变量”

新增时序规则：

1. `business-invariants.md` 必须在任何 implementation write_scope 改动前生成。
2. `task_edit` gate 读取 `business-invariants` fingerprint；缺失则 block。
3. 实现开始后，如果 `business-invariants.md` 发生非追加式修订，必须重新跑 `invariants_reviewed`、`test_contract_drafted`、`test_contract_honored` 和相关 review evidence。
4. 新增不变量允许追加，但必须标明 `created_after_implementation: true`，默认不能 retroactively 满足已有 task 的 RED/GREEN gate，除非 human confirmation 明确批准“补充审查而非原始约束”。
5. review evidence 必须记录被审查的 `business-invariants.md` blob sha；blob 变化后旧 review 自动 stale。

v2 hook 可进一步把 `business-invariants` 的 fingerprint 绑定到第一次实现编辑前的 PostToolUse/PreToolUse 运行时记录。v1 不实现 hook，只做事后稽核。

## 8. 考勤项目候选不变量示例

以下只是候选示例，不是 accepted business spec。真实 change 中必须重新绑定源码、文档或人工确认。

| INV-ID | 候选 statement | 范围 | 当前 source anchor | 验证建议 |
|---|---|---|---|---|
| `INV-SIGN-RECALC-AFTER-SIGN` | 打卡计算应优先触发班段匹配链路；未走异步班段引擎时才进入日报计算。 | Sign -> BlockMatch -> Daily | `SignCalculateServiceImpl#signCalculateMultiple` 调用 `blockMatchService.sendBlockEngineMessage(...)`，否则调用 daily 计算。 | 构造 sendBlockEngineMessage true/false 两种路径，验证不会同时重复计算。 |
| `INV-BLOCK-MATCH-SCENE-CENTRALIZED` | 落卡场景识别应集中在场景识别器，策略处理器只消费识别结果并选择策略。 | Block matching | `BlockMatchSceneIdentifier#identify` 和 `MatchingProcessor#execute`。 | review checklist + 结构测试：新增场景时必须改 scene enum、identifier、processor 映射。 |
| `INV-BLOCK-MATCH-PROCESS-LIMIT` | 单个打卡记录的递归替换处理必须有上限，避免替换链无限循环。 | Block matching | `MatchingProcessor#processSignMatch` 使用 `MAX_PROCESS_COUNT = 2`。 | 单测构造循环替换，断言处理次数受限。 |
| `INV-DAILY-SPLIT-GATE` | 无班段引擎权限、标准班段为空、自定义班段为空或无真实交叉时，班段拆分必须返回原始标准班段。 | Daily block split | `ShiftBlockInfoSplitUtils#splitBlocksIfEnabled`。 | 参数化单测覆盖无权限、空数据、无交叉。 |
| `INV-DAILY-CUSTOM-BLOCK-NO-UNRELATED-WRITEBACK` | 自定义班段与当前拆分结果没有关联时，不能回写覆盖该自定义班段。 | Daily custom block mapping | `ShiftBlockInfoSplitUtils#assignCalculationResultsToBlocks` 中无关联时 `continue`。 | 构造无关联 customBlock，断言状态不变。 |
| `INV-DAILY-ABSENCE-DERIVED-FROM-BOTH-MISSING` | 标准班段上班和下班都缺失时才汇总为缺勤，并清掉单边缺卡标记。 | Daily calculation mapping | `ShiftBlockInfoSplitUtils#assignCalculationResultsToBlocks` 对 originalBlock 的映射逻辑。 | 单测覆盖双缺卡、单边缺卡、迟到早退组合。 |

不适合作为不变量的例子：

- “考勤结果必须正确”：太抽象，无法验证。
- “当前方法必须叫某某名字”：除非是外部 API 契约，否则只是实现习惯。
- “所有场景都必须自动化测试”：不现实，应该拆成 `automated-test` 与 `review-checklist`。
- “当前代码里所有 if 分支都是业务规则”：可能只是历史兼容或临时补丁。

## 9. 需要修改的 SuperSpec 产物

建议分四步落地：

1. 文档与模板
   - 新增 `docs/proposals/superspec/templates/business-invariants.md`。
   - 将本 RFC 审查通过后的核心条款合入 `docs/proposals/superspec/SPEC.md`。

2. Skill
   - `superspec-explore`：在 discovery 中收集 candidate invariants。
   - `superspec-propose`：在 specs/design 后生成 `business-invariants.md`，再生成 `test-contract.md`。
   - `superspec-apply`：RED/GREEN evidence 必须引用 `invariant_refs`。
   - `superspec-review`：新增 invariant review verdict。
   - `superspec-verify`：输出 invariant matrix。
   - `superspec-archive`：preservation manifest 纳入 invariant artifacts/evidence。

3. Guard
   - 新增 `invariants_reviewed` internal gate。
   - 扩展 `test_contract_drafted` 和 `test_contract_honored`。
   - 在 state 指纹中新增 `business_invariants_fingerprint`。
   - 新增 block codes：`missing_business_invariants`、`invalid_invariant_ref`、`stale_invariant_review`、`invariant_not_honored`、`post_implementation_invariant_backfill`。

4. Tests
   - sidecar 缺失 -> block。
   - `INV-*` 引用不存在 -> block。
   - `business-invariants.md` 修改后旧 test-contract/review evidence -> stale。
   - task 有 `test_refs` 但无 `invariant_refs` 且命中业务代码 -> block。
   - 行为保持重构允许 GREEN->GREEN，不强制 RED-first。
   - 新行为 task 缺 RED -> block。

## 10. 最小验收标准

完成改造后，一个 SuperSpec change 进入 apply 前必须能回答：

```yaml
business_invariants:
  source: .superspec/artifacts/business-invariants.md
  reviewed_by:
    - critic native-subagent
    - test-engineer native-subagent
  hard_scope:
    - confirmed
    - source-backed

test_contract:
  every_scenario_has_test_or_review: true
  every_in_scope_invariant_has_test_or_review: true

tasks:
  every_impl_task_has_invariant_refs: true
  every_impl_task_has_test_refs_or_no_tdd_reason: true

apply:
  red_green_evidence_references_invariant_refs: true

review:
  broken_or_weak_invariants_empty_or_dispositioned: true
```

如果以上任一项缺失，guard 应 block 或至少在 v1 明确输出 audit-only blocker。

## 11. Critic 初审处置

| critic 意见 | 处置 |
|---|---|
| 不能做成 OpenSpec artifact 或改 requires 链 | 已固定为 `.superspec/artifacts/business-invariants.md` sidecar |
| 不能只写说明，必须定义 artifact/evidence/gate/引用 | 已新增 `invariants_reviewed` gate、`.superspec/evidence/invariants/`、`INV-*` 引用链 |
| 防止实现后反推不变量 | 已增加实现前 fingerprint、实现后 amendment 和 stale 规则 |
| 不变量不能混同 acceptance criteria / edge case / risk scenario | 已新增 `acceptance_refs`、`risk_refs`、`enforcement_level` 字段 |
| guard 只能校验结构，不能校验业务真理 | 已明确语义正确性由 critic/test-engineer/human evidence 承担 |

仍待人工决定：

1. `inferred` 不变量是否永远只能 advisory，还是允许人工确认后升级。
2. 哪些考勤业务域默认要求 human confirmation。
3. 是否把本 RFC 的核心条款合入 `SPEC.md` v0.5。
