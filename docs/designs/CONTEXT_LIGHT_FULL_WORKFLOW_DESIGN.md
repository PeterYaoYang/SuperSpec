# SuperSpec Context-Light Full Workflow Design

> Status: Draft, approved by critic + architect review in-thread
> Scope: Reduce model context load without changing the current full workflow semantics
> Relation: This is an implementation design for SuperSpec v1 workflow ergonomics. It does not change the normative workflow contract in `docs/SPEC.md`.

## 1. Problem

Current SuperSpec execution is context-heavy not mainly because the workflow has many gates, but because a large part of the workflow contract is duplicated inside the workflow skills themselves.

Today the model often has to carry all of the following in active context:

- stage intent and sequencing
- guard result interpretation
- evidence schema details
- disclosure loop rules
- review/adjudication field contracts
- branch logic for block / reroute / reopen paths

This creates two coupled problems:

1. `explore` and `propose` consume context too quickly and trigger repeated compression.
2. workflow control logic exists in both code and skill prose, which risks drift.

The current full workflow semantics are already enforced mostly in guard / evidence / disclosure code rather than in skill text. The right fix is therefore not to remove gates first, but to move workflow control and protocol detail out of default model context.

## 2. Goals

### 2.1 Goals

- Preserve the current user-visible workflow:
  - `init -> explore -> propose -> apply -> review -> archive`
- Preserve the current full gate semantics:
  - `explore_complete`
  - `proposal_reviewed`
  - `design_complete`
  - `invariants_reviewed`
  - `test_contract_drafted`
  - `tasks_complete`
  - `propose_complete`
  - `apply_ready`
  - `review_complete`
  - `archive_ready`
- Reduce default model context load in `explore` and `propose`.
- Move workflow routing and protocol interpretation from skill prose into a CLI/guard-controlled surface.
- Keep disclosure, review, and evidence audit guarantees intact.

### 2.2 Non-goals

- Do not reduce or skip full workflow gates in this design.
- Do not change OpenSpec canonical artifact ownership.
- Do not weaken disclosure, review, or adjudication requirements.
- Do not implement lightweight preset semantics here.
- Do not replace existing `superspec guard ...` command surfaces.

## 3. Non-breaking invariants

The following are hard constraints for this design:

1. OpenSpec remains the canonical artifact source of truth for `proposal/specs/design/tasks`.
2. OpenSpec artifacts must still be generated through `openspec instructions`.
3. Full disclosure loop guarantees remain in force for material findings.
4. `review_complete` remains allow-only and keeps its current full contract:
   - `source_guidance` from `code-reviewer`, `architect`, `critic`
   - `verification_review` from `verifier`, `critic`
   - `final_test`
   - unique `main_adjudication`
5. Exact pinned refs remain the audit primitive; no downgrade to loose path-only references is allowed.
6. Existing mutating guard paths remain the only writers of:
   - state
   - ledger
   - archive preservation materialization

## 4. Design summary

The design changes responsibility boundaries, not workflow semantics.

### 4.1 New responsibility split

`CLI / guard` becomes the workflow controller:

- current gate
- allow / block evaluation
- next action routing
- required reads
- required subagent roles
- required evidence skeleton kinds
- exact pinned refs and selectors

`Model` becomes the semantic executor:

- write artifact content
- interpret code and requirements
- choose dispositions for findings
- write rationale and summaries
- ask user questions when required
- implement code and tests

### 4.2 High-level flow

```text
thin skill
  -> superspec workflow next
      -> read current context
      -> evaluate current gate state (read-only)
      -> emit minimal context packet
  -> model executes exactly one step
  -> superspec evidence scaffold / validate
  -> superspec guard check-...
```

The model should no longer need to remember the full workflow protocol in order to perform the next step correctly.

## 5. Thin workflow skills

The five `superspec-*` skills are reduced to thin stage entrypoints.

Each skill keeps only:

- stage purpose
- required first command: `superspec workflow next ...`
- requirement to use `openspec instructions`
- stop on workflow / guard block
- user confirmation boundaries
- native subagent boundary

Each skill removes:

- full evidence schema listings
- route matrix prose
- long disclosure loop contract text
- long adjudication field documentation
- repeated step-by-step block handling prose

Target: each workflow skill should be short enough to act as an execution wrapper rather than a protocol handbook.

## 6. Read-only workflow packet surface

## 6.1 New command

Introduce a new read-only orchestration surface:

```bash
superspec workflow next --change "<change>" --stage <stage> --format agent
```

This command is additive. It does not replace existing guard entrypoints in phase 1.

## 6.2 Read-only / no-side-effect contract

`workflow next` must be strictly read-only.

It must not:

- call the mutating `dispatch` path
- write `.superspec/superspec-state.json`
- append ledger events
- materialize archive preservation files
- perform any other side effect that changes workflow state

It may only compose read-only context loading and in-memory evaluation helpers.

For archive phase specifically:

- `workflow next` may report that the next mutating command is `superspec guard check-archive-ready`
- `workflow next` may not itself materialize archive preservation bundles or manifests

## 6.3 Packet shape

The agent-facing packet should remain intentionally small, but it must use exact references for audit-relevant reads.

Suggested minimal packet:

```ts
type pinned_ref = {
  root: "repo" | "change";
  path: string;
  blob_sha: string;
};

type finding_selector = {
  evidence_id: string;
  finding_uid: string;
  evidence_ref: pinned_ref;
};

type decision_selector = {
  evidence_id: string;
  decision_scope_key: string;
  evidence_ref: pinned_ref;
};

type workflow_next_packet = {
  stage: string;
  current_gate: string;
  status: "allowed" | "blocked";
  top_blockers?: string[];
  blocker_count?: number;
  has_more_blockers?: boolean;
  next_action: string;
  next_command?: string;
  must_read_refs: pinned_ref[];
  must_read_verbatim_findings?: finding_selector[];
  must_read_verbatim_decisions?: decision_selector[];
  must_write_artifacts?: string[];
  required_subagent_roles?: string[];
  evidence_skeleton_kinds?: string[];
  diagnostic_command?: string;
};
```

## 6.4 Why exact selectors matter

Default summaries are acceptable for routing, but not for audit-critical disclosure.

When the current step depends on:

- verbatim reviewer `findings[].summary`
- material finding user choice
- exact `required_load_refs`
- exact disclosure target binding

the packet must point to exact sources using pinned refs and selectors rather than only emitting safe summaries.

This preserves:

- verbatim disclosure requirements
- pinned-ref freshness guarantees
- `required_load_refs -> loaded_refs` exact matching

## 7. Reference pack

Long protocol material moves out of default workflow skills into versioned references.

Logical layout:

```text
.codex/superspec/references/
  workflow/
    explore.md
    propose.md
    apply.md
    review.md
    archive.md
  contracts/
    evidence.md
    disclosure.md
    review.md
```

The model should not load these by default during ordinary stage entry.

These references must be:

- included in the install map
- included in the manifest
- validated by `check-init`

This prevents the system from silently losing protocol detail after the skills are thinned.

## 8. Evidence scaffold / validate commands

Introduce a new additive CLI family:

```bash
superspec evidence scaffold ...
superspec evidence validate ...
```

These commands produce and validate evidence skeletons, but they do not decide workflow outcomes on behalf of the main thread.

## 8.1 Phase 1 evidence coverage

Phase 1 must cover not only happy-path evidence, but the existing full workflow surface:

- `source_guidance`
- `verification_review`
- `main_review_digest`
- `user_review_decision`
- `review_standing_authorization`
- `human_confirmation`
- `test_run`
- `final_test`
- `main_adjudication`
- `task_reopen`
- `task_reopen_resolved`

## 8.2 CLI-owned mechanical fields

The CLI owns generation of mechanical fields such as:

- `evidence_id`
- `created_at`
- `review_round_id`
- `target_refs`
- `blob_sha`
- `previous_digest_refs`
- path safety
- schema skeleton

The model fills only semantic fields such as:

- `summary`
- `rationale`
- `decision`
- `claim_adjudications`
- `finding_adjudications`
- `test_command`

## 8.3 Non-goal of scaffold commands

The scaffold / validate surface must not:

- infer allow / block workflow transitions
- generate final adjudication decisions automatically
- replace the main thread's reasoning role

## 9. Subagent output dual-layer model

Subagent reporting remains two-layered.

### 9.1 Long report

Long report remains in `output_ref` for:

- audit traceability
- disagreement inspection
- deep diagnostics

### 9.2 Short structured summary

Gate-driving evidence should also carry a compact structure containing:

- decision
- top findings
- `required_load_refs`
- `required_claim_ids`
- blocking finding ids
- `reviewed_files`

Ordinary main-thread operation should default to this short structure plus exact pinned refs, not to full report ingestion.

## 10. Full-path coverage requirement

This design is not complete unless it supports the existing non-happy-path full workflow as well.

Phase 1 must explicitly support:

- `request_changes -> reopen_tasks`
- `task_reopen`
- `task_reopen_resolved`
- `review_standing_authorization`
- `verify_failure_handling`
- `scope_expansion`
- `human_confirmation` at every currently consumed gate

For these paths, `workflow next` must return:

- exact contract refs
- exact selectors when verbatim source is required
- the relevant scaffold kind(s)

The goal is `context-light full`, not `happy-path full`.

## 11. Migration strategy

### Phase 1: workflow packet contract

- implement `superspec workflow next`
- keep it read-only
- define and test exact packet shape

### Phase 2: reference pack and distribution

- add external reference pack
- wire into install map and manifest
- extend `check-init` to validate discoverability and presence

### Phase 3: evidence scaffold / validate

- add first-batch scaffold coverage for all required full-path evidence kinds

### Phase 4: thin skills

- shrink the five workflow skills
- have them call `superspec workflow next`
- keep existing skill names and install targets unchanged

### Phase 5: test migration

- replace tests that require large protocol dumps in skill text
- add packet, parity, and width tests

### Phase 6: separate lightweight preset design

- after context-light full is stable
- in a separate design and change

## 12. Test requirements

## 12.1 Parity tests

`workflow next` must not drift from existing gate semantics.

At minimum, parity tests must cover:

- `proposal_reviewed` disclosure path
- `review_complete` allow path
- `request_changes -> reopen_tasks` path

The new packet surface must agree with existing `check_*` workflow reality.

## 12.2 Packet width tests

Add tests that enforce:

- field whitelist
- truncation / bounded summaries
- no schema dump regression

This prevents the new packet from becoming another large protocol surface.

## 12.3 Thin skill tests

Move skill tests away from requiring inlined long protocol text.

Test instead that:

- skills are thin entrypoints
- `workflow next` is invoked
- references are discoverable
- full workflow contracts remain preserved

## 13. Acceptance criteria

This design is considered successful when all of the following are true:

1. Default loading of any `superspec-*` skill no longer pulls full schema / route / field contract prose into context.
2. `superspec workflow next --format agent` is sufficient to drive the next ordinary step.
3. Audit-critical verbatim disclosure still uses exact selectors and pinned refs.
4. Existing full gate semantics are unchanged.
5. Existing OpenSpec boundaries are unchanged.
6. The full non-happy-path workflow still has scaffold and packet support.
7. `explore` and `propose` no longer require default ingestion of the entire protocol body.

## 14. Follow-up work intentionally deferred

The following remain explicitly out of scope for this design:

- gate reduction for `hotfix` / `tweak`
- role reduction in `review_complete`
- lightweight preset eligibility rules
- assurance-level downgrade design

Those belong to a separate `lightweight preset` design after `Context-Light Full` is stable.
