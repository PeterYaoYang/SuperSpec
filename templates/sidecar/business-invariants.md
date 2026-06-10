<!-- SuperSpec sidecar: write to openspec/changes/<change>/.superspec/artifacts/business-invariants.md
     This is not an OpenSpec artifact and must not enter the OpenSpec graph. -->

# 业务不变量

## Source Anchor Policy

- 每条 `INV-*` 必须有 `source_anchors`。
- `confirmed` / `source-backed` 可进入 test-contract 硬映射。
- `inferred` 只能进入 review checklist，除非补充 human confirmation。
- 实现开始后新增或重写不变量，必须标记 `created_after_implementation: true` 并重新触发相关 gate。
- `test-contract.md` 只映射 `INV-*`，不重复承载完整不变量正文。

## Invariants

| INV-ID | statement | scope | source_anchors | acceptance_refs | risk_refs | confidence | enforcement_level | test_refs_or_review_only_reason | verification | risk_if_broken | invalidation_triggers | created_after_implementation |
|---|---|---|---|---|---|---|---|---|---|---|---|---|
| INV-001 |  |  |  | REQ-001 | RISK-001 | source-backed | automated-test | TEST-001 | automated-test |  |  | false |

## Non-invariants / Rejected Candidates

| candidate | reason_rejected | reviewer |
|---|---|---|
|  |  |  |

## Mapping

| INV-ID | REQ/Scenario refs | risk refs | TEST refs | REVIEW refs | task refs |
|---|---|---|---|---|---|
| INV-001 | REQ-001 | RISK-001 | TEST-001 |  | TASK-001 |

## Review Notes

```yaml
business_invariants_verified: []
broken_or_weak_invariants: []
human_confirmations_required: []
```
