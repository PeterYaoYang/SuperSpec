import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import test from "node:test";
import {
  copyFileSync,
  existsSync,
  linkSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { hostname, tmpdir } from "node:os";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import * as guard from "../superspec_guard.ts";
import { main_init } from "../src/init_cli.ts";
import { reason_message_zh, translate_action_zh } from "../src/i18n.ts";
import { project_init } from "../src/project_init.ts";
import {
  findRepoRoot,
  GUARD_ROOT,
  REPO_ROOT,
  GUARD_TS,
  GUARD_TS_URL,
  INIT_TS,
  mkdirp,
  writeText,
  readJson,
  materializeEvidenceRecord,
  codes,
  captureStdoutJson,
  captureStdoutText,
  captureMain,
  captureMainJson,
  assertSafeOutputHasNoLeaks,
  assertNoForbiddenAgentKeys,
  walkFiles,
  installOpenspecSkills,
  installSuperSpecAgents,
  createFixture,
  activeFixture,
  withFixture,
  withRuntime,
  waitForChild,
  LEGACY_MACHINE_STRING_FIELDS,
  LEGACY_MACHINE_STRING_LIST_FIELDS,
  LEGACY_MACHINE_PATH_OBJECT_LIST_FIELDS,
  rewriteLegacySidecarString,
  rewriteLegacyJson,
  importLegacyIrsflowFixture,
  status,
  passEvidence,
  roleEvidence,
  reviewEvidence,
  reviewGuidanceEvidences,
  legacyCodeReviewWorkflowEvidence,
  mainAdjudication,
  verifyEvidence,
  DEFAULT_RUN_LOG,
  defaultRunLog,
  redEvidence,
  greenEvidence,
  taskReopenEvidence,
  taskReopenResolvedEvidence,
  supersededEvidence,
  alternativeVerificationEvidence,
  reopenBlockingFinding,
  finalTestEvidence,
  archiveReadyEvidences,
  reopenGuidanceEvidences,
  taskReopenReadyEvidences,
  businessInvariantsText,
  testContractText,
  testContractRowsText,
  invariantMatrixText,
  proposalReviewedEvidences,
  prepareProposeComplete,
  setTaskCheckbox,
  EXPLORE_ONLY_STATUS,
  DISCOVERY_REL,
  writeDiscovery,
  discoveryBlob,
  exploreCheck,
  exploreConfirmedEvidences,
  discSchemaCodes,
  exploreFinding,
  exploreRoundReview,
  exploreRoundPrompt,
  exploreDigest,
  dispositionOf,
  userDecision,
  standingAuth,
  supersedeMarker,
  PROPOSAL_REL,
  writeProposal,
  proposalTargets,
  proposalCheck,
  proposalFinding,
  proposalRoundReview,
  proposalRoundPrompt,
  proposalDigest,
  designTargetRefs,
  targetRefList,
  gateFinding,
  roundReviewWithTargets,
  roundDigestWithTargets,
  proposeChainThroughDesign,
} from "./helpers/superspec_guard_fixture.ts";
import type { JsonMap, Fixture } from "./helpers/superspec_guard_fixture.ts";

withFixture("review complete requires diff contract fields", (fx) => {
  const guidance = [
    ...reviewGuidanceEvidences(fx, { lane_overrides: { "code-reviewer": { base_ref: undefined } } }),
    reviewEvidence(fx, "critic"),
  ];
  const evidences = [
    ...prepareProposeComplete(fx, {
      checked: true,
      tasksText:
        "- [x] TASK-001 Implement\n" +
        "  - invariant_refs: INV-001\n" +
        "  - test_refs: TEST-001\n" +
        "  - tdd_required: false\n" +
        "  - no_tdd_reason: non-executable-spec-change\n",
    }),
    alternativeVerificationEvidence("TASK-001"),
    ...guidance,
    mainAdjudication(fx, guidance),
    verifyEvidence(fx, "verifier"),
    verifyEvidence(fx, "critic"),
    finalTestEvidence(fx),
  ];
  withRuntime({ openspec_validate: () => [true, ""], dirty_worktree_reasons: () => [] }, () => {
    const decision = guard.check_review_complete("demo-change", status(fx), fx.change, evidences);
    assert.equal(decision.allowed, false);
    assert.ok(codes(decision.block_reasons).includes("review_evidence_incomplete"));
  });
});

withFixture("review complete blocks when reviewed files miss diff", (fx) => {
  const guidance = [
    ...reviewGuidanceEvidences(fx, { reviewed_files: ["tasks.md"] }),
    reviewEvidence(fx, "critic", { reviewed_files: ["tasks.md", "src/service.py"] }),
  ];
  const evidences = [
    ...prepareProposeComplete(fx, {
      checked: true,
      tasksText:
        "- [x] TASK-001 Implement\n" +
        "  - invariant_refs: INV-001\n" +
        "  - test_refs: TEST-001\n" +
        "  - tdd_required: false\n" +
        "  - no_tdd_reason: non-executable-spec-change\n",
    }),
    alternativeVerificationEvidence("TASK-001"),
    ...guidance,
    mainAdjudication(fx, guidance),
    verifyEvidence(fx, "verifier"),
    verifyEvidence(fx, "critic"),
    finalTestEvidence(fx),
  ];
  withRuntime({
    openspec_validate: () => [true, ""],
    dirty_worktree_reasons: () => [],
    review_diff_paths: () => ["tasks.md", "src/service.py"],
  }, () => {
    const decision = guard.check_review_complete("demo-change", status(fx), fx.change, evidences);
    assert.equal(decision.allowed, false);
    assert.ok(codes(decision.block_reasons).includes("review_diff_not_covered"));
  });
});

withFixture("review complete blocks non-string base and head refs", (fx) => {
  const guidance = [
    reviewEvidence(fx, "code-reviewer", { base_ref: { sha: "base" } }),
    reviewEvidence(fx, "architect"),
    reviewEvidence(fx, "critic"),
  ];
  const evidences = [
    ...prepareProposeComplete(fx, {
      checked: true,
      tasksText:
        "- [x] TASK-001 Implement\n" +
        "  - invariant_refs: INV-001\n" +
        "  - test_refs: TEST-001\n" +
        "  - tdd_required: false\n" +
        "  - no_tdd_reason: non-executable-spec-change\n",
    }),
    alternativeVerificationEvidence("TASK-001"),
    ...guidance,
    mainAdjudication(fx, guidance),
    verifyEvidence(fx, "verifier"),
    verifyEvidence(fx, "critic"),
    finalTestEvidence(fx),
  ];
  withRuntime({ openspec_validate: () => [true, ""], dirty_worktree_reasons: () => [] }, () => {
    const decision = guard.check_review_complete("demo-change", status(fx), fx.change, evidences);
    assert.equal(decision.allowed, false);
    assert.ok(codes(decision.block_reasons).includes("review_evidence_incomplete"));
  });
});

withFixture("review complete allows when reviewed files cover diff", (fx) => {
  const guidance = [
    ...reviewGuidanceEvidences(fx, { reviewed_files: ["tasks.md", "src/service.py"] }),
    reviewEvidence(fx, "critic", { reviewed_files: ["tasks.md", "src/service.py"] }),
  ];
  const evidences = [
    ...prepareProposeComplete(fx, {
      checked: true,
      tasksText:
        "- [x] TASK-001 Implement\n" +
        "  - invariant_refs: INV-001\n" +
        "  - test_refs: TEST-001\n" +
        "  - tdd_required: false\n" +
        "  - no_tdd_reason: non-executable-spec-change\n",
    }),
    alternativeVerificationEvidence("TASK-001"),
    ...guidance,
    mainAdjudication(fx, guidance),
    verifyEvidence(fx, "verifier"),
    verifyEvidence(fx, "critic"),
    finalTestEvidence(fx),
  ];
  withRuntime({
    openspec_validate: () => [true, ""],
    dirty_worktree_reasons: () => [],
    review_diff_paths: () => ["tasks.md", "src/service.py"],
  }, () => {
    const decision = guard.check_review_complete("demo-change", status(fx), fx.change, evidences);
    assert.equal(decision.allowed, true, JSON.stringify(decision));
  });
});

withFixture("review complete blocks missing architect guidance", (fx) => {
  const guidance = [
    reviewEvidence(fx, "code-reviewer", { reviewed_files: ["tasks.md", "src/service.py"] }),
    reviewEvidence(fx, "critic", { reviewed_files: ["tasks.md", "src/service.py"] }),
  ];
  const evidences = [
    ...prepareProposeComplete(fx, {
      checked: true,
      tasksText:
        "- [x] TASK-001 Implement\n" +
        "  - invariant_refs: INV-001\n" +
        "  - test_refs: TEST-001\n" +
        "  - tdd_required: false\n" +
        "  - no_tdd_reason: non-executable-spec-change\n",
    }),
    alternativeVerificationEvidence("TASK-001"),
    ...guidance,
    mainAdjudication(fx, guidance),
    verifyEvidence(fx, "verifier"),
    verifyEvidence(fx, "critic"),
    finalTestEvidence(fx),
  ];
  withRuntime({
    openspec_validate: () => [true, ""],
    dirty_worktree_reasons: () => [],
    review_diff_paths: () => ["tasks.md", "src/service.py"],
  }, () => {
    const decision = guard.check_review_complete("demo-change", status(fx), fx.change, evidences);
    assert.equal(decision.allowed, false);
    assert.ok(codes(decision.block_reasons).includes("missing_source_guidance"));
    const collectAction = decision.next_allowed_actions.find((item: string) => item.includes("collect review_complete source_guidance from missing roles:"));
    assert.ok(collectAction?.includes("architect"));
    assert.ok(!collectAction?.includes("code-reviewer"));
    assert.ok(!collectAction?.includes("critic"));
  });
});

withFixture("review ready preserves propose actions without generic fallback", (fx) => {
  withRuntime({ openspec_validate: () => [true, ""], dirty_worktree_reasons: () => [] }, () => {
    const decision = guard.check_review_ready("demo-change", status(fx), fx.change, []);
    assert.equal(decision.allowed, false);
    assert.ok(decision.next_allowed_actions.includes("pass explore_complete, proposal_reviewed, design_complete, invariants_reviewed, test_contract_drafted, and tasks_complete"));
    assert.ok(!decision.next_allowed_actions.some((item: string) => item.includes("pass check-apply-ready")));
  });
});

withFixture("review complete blocks legacy workflow evidence without main adjudication", (fx) => {
  const evidences = [
    ...prepareProposeComplete(fx, {
      checked: true,
      tasksText:
        "- [x] TASK-001 Implement\n" +
        "  - invariant_refs: INV-001\n" +
        "  - test_refs: TEST-001\n" +
        "  - tdd_required: false\n" +
        "  - no_tdd_reason: non-executable-spec-change\n",
    }),
    alternativeVerificationEvidence("TASK-001"),
    legacyCodeReviewWorkflowEvidence(fx),
    reviewEvidence(fx, "critic"),
    verifyEvidence(fx, "verifier"),
    verifyEvidence(fx, "critic"),
    finalTestEvidence(fx),
  ];
  withRuntime({ openspec_validate: () => [true, ""], dirty_worktree_reasons: () => [] }, () => {
    const decision = guard.check_review_complete("demo-change", status(fx), fx.change, evidences);
    assert.equal(decision.allowed, false);
    assert.ok(codes(decision.block_reasons).includes("missing_main_adjudication"));
  });
});

withFixture("review complete blocks when main adjudication omits required claim", (fx) => {
  const guidance = [
    ...reviewGuidanceEvidences(fx),
    reviewEvidence(fx, "critic", { required_claim_ids: ["CLAIM-CRITIC-001", "CLAIM-CRITIC-002"] }),
  ];
  const evidences = [
    ...prepareProposeComplete(fx, {
      checked: true,
      tasksText:
        "- [x] TASK-001 Implement\n" +
        "  - invariant_refs: INV-001\n" +
        "  - test_refs: TEST-001\n" +
        "  - tdd_required: false\n" +
        "  - no_tdd_reason: non-executable-spec-change\n",
    }),
    alternativeVerificationEvidence("TASK-001"),
    ...guidance,
    mainAdjudication(fx, guidance, {
      claim_adjudications: [
        { claim_id: "CLAIM-CODE-REVIEWER-001", decision: "accept", rationale: "accepted" },
        { claim_id: "CLAIM-ARCHITECT-001", decision: "accept", rationale: "accepted" },
        { claim_id: "CLAIM-CRITIC-001", decision: "accept", rationale: "accepted" },
      ],
    }),
    verifyEvidence(fx, "verifier"),
    verifyEvidence(fx, "critic"),
    finalTestEvidence(fx),
  ];
  withRuntime({ openspec_validate: () => [true, ""], dirty_worktree_reasons: () => [] }, () => {
    const decision = guard.check_review_complete("demo-change", status(fx), fx.change, evidences);
    assert.equal(decision.allowed, false);
    assert.ok(codes(decision.block_reasons).includes("required_claim_unadjudicated"));
  });
});

withFixture("A-5 request_changes uses shared adjudication coverage helper", (fx) => {
  const guidance = [
    ...reopenGuidanceEvidences(fx),
    reviewEvidence(fx, "critic", { required_claim_ids: ["CLAIM-CRITIC-001", "CLAIM-CRITIC-002"] }),
  ];
  const evidences = [
    ...prepareProposeComplete(fx, {
      checked: true,
      tasksText:
        "- [x] TASK-001 Implement\n" +
        "  - invariant_refs: INV-001\n" +
        "  - test_refs: TEST-001\n" +
        "  - tdd_required: false\n" +
        "  - no_tdd_reason: non-executable-spec-change\n",
    }),
    alternativeVerificationEvidence("TASK-001"),
    ...guidance,
    mainAdjudication(fx, guidance, {
      review_decision: "request_changes",
      request_changes_route: "reopen_tasks",
      blocking_source_evidence_refs: ["EV-code-reviewer-guidance"],
      reopen_task_ids: ["TASK-001"],
      claim_adjudications: [
        { claim_id: "CLAIM-CODE-REVIEWER-001", decision: "accept", rationale: "accepted" },
        { claim_id: "CLAIM-ARCHITECT-001", decision: "accept", rationale: "accepted" },
        { claim_id: "CLAIM-CRITIC-001", decision: "accept", rationale: "accepted" },
      ],
    }),
  ];
  withRuntime({ openspec_validate: () => [true, ""], dirty_worktree_reasons: () => [] }, () => {
    const decision = guard.check_review_complete("demo-change", status(fx), fx.change, evidences);
    assert.equal(decision.allowed, false);
    assert.ok(codes(decision.block_reasons).includes("required_claim_unadjudicated"));
    assert.ok(!decision.next_allowed_actions.some((item: string) => item.includes("task_reopen")));
  });
});

withFixture("review complete blocks when main adjudication omits required load", (fx) => {
  const guidance = [
    ...reviewGuidanceEvidences(fx),
    reviewEvidence(fx, "critic"),
  ];
  const missingLoad = guidance[2].required_load_refs[0];
  const evidences = [
    ...prepareProposeComplete(fx, {
      checked: true,
      tasksText:
        "- [x] TASK-001 Implement\n" +
        "  - invariant_refs: INV-001\n" +
        "  - test_refs: TEST-001\n" +
        "  - tdd_required: false\n" +
        "  - no_tdd_reason: non-executable-spec-change\n",
    }),
    alternativeVerificationEvidence("TASK-001"),
    ...guidance,
    mainAdjudication(fx, guidance, {
      loaded_refs: guidance
        .flatMap((ev) => Array.isArray(ev.required_load_refs) ? ev.required_load_refs : [])
        .filter((refItem: JsonMap) => refItem.path !== missingLoad.path || refItem.blob_sha !== missingLoad.blob_sha)
        .map((refItem: JsonMap) => ({ ...refItem })),
    }),
    verifyEvidence(fx, "verifier"),
    verifyEvidence(fx, "critic"),
    finalTestEvidence(fx),
  ];
  withRuntime({ openspec_validate: () => [true, ""], dirty_worktree_reasons: () => [] }, () => {
    const decision = guard.check_review_complete("demo-change", status(fx), fx.change, evidences);
    assert.equal(decision.allowed, false);
    assert.ok(codes(decision.block_reasons).includes("required_load_unloaded"));
  });
});

withFixture("review complete blocks when main adjudication omits verification evidence refs", (fx) => {
  const guidance = [
    ...reviewGuidanceEvidences(fx),
    reviewEvidence(fx, "critic"),
  ];
  const evidences = [
    ...prepareProposeComplete(fx, {
      checked: true,
      tasksText:
        "- [x] TASK-001 Implement\n" +
        "  - invariant_refs: INV-001\n" +
        "  - test_refs: TEST-001\n" +
        "  - tdd_required: false\n" +
        "  - no_tdd_reason: non-executable-spec-change\n",
    }),
    alternativeVerificationEvidence("TASK-001"),
    ...guidance,
    mainAdjudication(fx, guidance, { verification_evidence_refs: ["EV-verifier-verification", "EV-final-test"] }),
    verifyEvidence(fx, "verifier"),
    verifyEvidence(fx, "critic"),
    finalTestEvidence(fx),
  ];
  withRuntime({ openspec_validate: () => [true, ""], dirty_worktree_reasons: () => [] }, () => {
    const decision = guard.check_review_complete("demo-change", status(fx), fx.change, evidences);
    assert.equal(decision.allowed, false);
    assert.ok(codes(decision.block_reasons).includes("verification_evidence_unreferenced"));
  });
});

withFixture("review complete blocks unknown source evidence refs on allow path", (fx) => {
  const guidance = [
    ...reviewGuidanceEvidences(fx),
    reviewEvidence(fx, "critic"),
  ];
  const evidences = [
    ...prepareProposeComplete(fx, {
      checked: true,
      tasksText:
        "- [x] TASK-001 Implement\n" +
        "  - invariant_refs: INV-001\n" +
        "  - test_refs: TEST-001\n" +
        "  - tdd_required: false\n" +
        "  - no_tdd_reason: non-executable-spec-change\n",
    }),
    alternativeVerificationEvidence("TASK-001"),
    ...guidance,
    mainAdjudication(fx, guidance, {
      source_evidence_refs: [...guidance.map((ev) => ev.evidence_id), "EV-fake-guidance"],
    }),
    verifyEvidence(fx, "verifier"),
    verifyEvidence(fx, "critic"),
    finalTestEvidence(fx),
  ];
  withRuntime({ openspec_validate: () => [true, ""], dirty_worktree_reasons: () => [] }, () => {
    const decision = guard.check_review_complete("demo-change", status(fx), fx.change, evidences);
    assert.equal(decision.allowed, false);
    assert.ok(codes(decision.block_reasons).includes("source_guidance_unreferenced"));
  });
});

withFixture("review complete blocks unknown verification evidence refs on allow path", (fx) => {
  const guidance = [
    ...reviewGuidanceEvidences(fx),
    reviewEvidence(fx, "critic"),
  ];
  const evidences = [
    ...prepareProposeComplete(fx, {
      checked: true,
      tasksText:
        "- [x] TASK-001 Implement\n" +
        "  - invariant_refs: INV-001\n" +
        "  - test_refs: TEST-001\n" +
        "  - tdd_required: false\n" +
        "  - no_tdd_reason: non-executable-spec-change\n",
    }),
    alternativeVerificationEvidence("TASK-001"),
    ...guidance,
    mainAdjudication(fx, guidance, {
      verification_evidence_refs: ["EV-verifier-verification", "EV-critic-verification", "EV-final-test", "EV-fake-final"],
    }),
    verifyEvidence(fx, "verifier"),
    verifyEvidence(fx, "critic"),
    finalTestEvidence(fx),
  ];
  withRuntime({ openspec_validate: () => [true, ""], dirty_worktree_reasons: () => [] }, () => {
    const decision = guard.check_review_complete("demo-change", status(fx), fx.change, evidences);
    assert.equal(decision.allowed, false);
    assert.ok(codes(decision.block_reasons).includes("verification_evidence_unreferenced"));
  });
});

withFixture("review complete blocks wrong-kind verification evidence refs on allow path", (fx) => {
  const guidance = [
    ...reviewGuidanceEvidences(fx),
    reviewEvidence(fx, "critic"),
  ];
  const wrongKindVerification = passEvidence("review_complete", "review", {
    evidence_id: "EV-wrong-kind-verifier",
    agent_role: "verifier",
  });
  const evidences = [
    ...prepareProposeComplete(fx, {
      checked: true,
      tasksText:
        "- [x] TASK-001 Implement\n" +
        "  - invariant_refs: INV-001\n" +
        "  - test_refs: TEST-001\n" +
        "  - tdd_required: false\n" +
        "  - no_tdd_reason: non-executable-spec-change\n",
    }),
    alternativeVerificationEvidence("TASK-001"),
    ...guidance,
    mainAdjudication(fx, guidance, {
      verification_evidence_refs: ["EV-verifier-verification", "EV-critic-verification", "EV-final-test", "EV-wrong-kind-verifier"],
    }),
    verifyEvidence(fx, "verifier"),
    verifyEvidence(fx, "critic"),
    finalTestEvidence(fx),
    wrongKindVerification,
  ];
  withRuntime({ openspec_validate: () => [true, ""], dirty_worktree_reasons: () => [] }, () => {
    const decision = guard.check_review_complete("demo-change", status(fx), fx.change, evidences);
    assert.equal(decision.allowed, false);
    assert.ok(codes(decision.block_reasons).includes("verification_evidence_unreferenced"));
  });
});

withFixture("review complete blocks when blocking finding lacks adjudication", (fx) => {
  const guidance = [
    ...reviewGuidanceEvidences(fx),
    reviewEvidence(fx, "critic", {
      blocking_findings: [{ finding_id: "FINDING-001", summary: "critical issue" }],
      finding_dispositions: [{ finding_id: "FINDING-001", recommendation: "fix", rationale: "must fix" }],
    }),
  ];
  const evidences = [
    ...prepareProposeComplete(fx, {
      checked: true,
      tasksText:
        "- [x] TASK-001 Implement\n" +
        "  - invariant_refs: INV-001\n" +
        "  - test_refs: TEST-001\n" +
        "  - tdd_required: false\n" +
        "  - no_tdd_reason: non-executable-spec-change\n",
    }),
    alternativeVerificationEvidence("TASK-001"),
    ...guidance,
    mainAdjudication(fx, guidance, { finding_adjudications: [] }),
    verifyEvidence(fx, "verifier"),
    verifyEvidence(fx, "critic"),
    finalTestEvidence(fx),
  ];
  withRuntime({ openspec_validate: () => [true, ""], dirty_worktree_reasons: () => [] }, () => {
    const decision = guard.check_review_complete("demo-change", status(fx), fx.change, evidences);
    assert.equal(decision.allowed, false);
    assert.ok(codes(decision.block_reasons).includes("blocking_findings_open"));
  });
});

withFixture("review complete requires final test evidence", (fx) => {
  const guidance = [
    ...reviewGuidanceEvidences(fx),
    reviewEvidence(fx, "critic"),
  ];
  const evidences = [
    ...prepareProposeComplete(fx, {
      checked: true,
      tasksText:
        "- [x] TASK-001 Implement\n" +
        "  - invariant_refs: INV-001\n" +
        "  - test_refs: TEST-001\n" +
        "  - tdd_required: false\n" +
        "  - no_tdd_reason: non-executable-spec-change\n",
    }),
    alternativeVerificationEvidence("TASK-001"),
    ...guidance,
    mainAdjudication(fx, guidance),
    verifyEvidence(fx, "verifier"),
    verifyEvidence(fx, "critic"),
  ];
  withRuntime({ openspec_validate: () => [true, ""], dirty_worktree_reasons: () => [] }, () => {
    const decision = guard.check_review_complete("demo-change", status(fx), fx.change, evidences);
    assert.equal(decision.allowed, false);
    assert.ok(codes(decision.block_reasons).includes("missing_final_tests"));
  });
});

withFixture("review complete preserves review_ready actions without generic fallback", (fx) => {
  withRuntime({ dirty_worktree_reasons: () => [] }, () => {
    const decision = guard.check_review_complete("demo-change", status(fx), fx.change, prepareProposeComplete(fx, { checked: false }));
    assert.equal(decision.allowed, false);
    assert.ok(decision.next_allowed_actions.includes("finish remaining unchecked tasks and mark them complete only after check-task-complete passes"));
    assert.ok(!decision.next_allowed_actions.some((item: string) => item.includes("pass check-review-ready")));
  });
});

withFixture("review complete validate failure only recommends validate fix", (fx) => {
  const guidance = [
    ...reviewGuidanceEvidences(fx),
    reviewEvidence(fx, "critic"),
  ];
  const evidences = [
    ...prepareProposeComplete(fx, {
      checked: true,
      tasksText:
        "- [x] TASK-001 Implement\n" +
        "  - invariant_refs: INV-001\n" +
        "  - test_refs: TEST-001\n" +
        "  - tdd_required: false\n" +
        "  - no_tdd_reason: non-executable-spec-change\n",
    }),
    alternativeVerificationEvidence("TASK-001"),
    ...guidance,
    mainAdjudication(fx, guidance),
    verifyEvidence(fx, "verifier"),
    verifyEvidence(fx, "critic"),
    finalTestEvidence(fx),
  ];
  withRuntime({ openspec_validate: () => [false, "invalid"], dirty_worktree_reasons: () => [] }, () => {
    const decision = guard.check_review_complete("demo-change", status(fx), fx.change, evidences);
    assert.equal(decision.allowed, false);
    assert.deepEqual(decision.next_allowed_actions, ["fix openspec validate failures for demo-change"]);
  });
});

withFixture("review complete missing final tests does not suggest verification repair", (fx) => {
  const guidance = [
    ...reviewGuidanceEvidences(fx),
    reviewEvidence(fx, "critic"),
  ];
  const evidences = [
    ...prepareProposeComplete(fx, {
      checked: true,
      tasksText:
        "- [x] TASK-001 Implement\n" +
        "  - invariant_refs: INV-001\n" +
        "  - test_refs: TEST-001\n" +
        "  - tdd_required: false\n" +
        "  - no_tdd_reason: non-executable-spec-change\n",
    }),
    alternativeVerificationEvidence("TASK-001"),
    ...guidance,
    mainAdjudication(fx, guidance),
    verifyEvidence(fx, "verifier", { test_evidence_refs: ["EV-task_complete"] }),
    verifyEvidence(fx, "critic", { test_evidence_refs: ["EV-task_complete"] }),
  ];
  withRuntime({ openspec_validate: () => [true, ""], dirty_worktree_reasons: () => [] }, () => {
    const decision = guard.check_review_complete("demo-change", status(fx), fx.change, evidences);
    assert.equal(decision.allowed, false);
    assert.ok(decision.next_allowed_actions.includes("record final_test pass evidence and reference it from verification_review"));
    assert.ok(!decision.next_allowed_actions.some((item: string) => item.includes("repair verification_review references")));
    assert.ok(!decision.next_allowed_actions.some((item: string) => item.includes("repair main_adjudication")));
  });
});

withFixture("review complete ignores verification evidence recorded only under verify_complete gate", (fx) => {
  const guidance = [
    ...reviewGuidanceEvidences(fx),
    reviewEvidence(fx, "critic"),
  ];
  const evidences = [
    ...prepareProposeComplete(fx, {
      checked: true,
      tasksText:
        "- [x] TASK-001 Implement\n" +
        "  - invariant_refs: INV-001\n" +
        "  - test_refs: TEST-001\n" +
        "  - tdd_required: false\n" +
        "  - no_tdd_reason: non-executable-spec-change\n",
    }),
    alternativeVerificationEvidence("TASK-001"),
    ...guidance,
    mainAdjudication(fx, guidance, { verification_evidence_refs: [] }),
    verifyEvidence(fx, "verifier", { gate: "verify_complete" }),
    verifyEvidence(fx, "critic", { gate: "verify_complete" }),
    finalTestEvidence(fx, { gate: "verify_complete" }),
  ];
  withRuntime({ openspec_validate: () => [true, ""], dirty_worktree_reasons: () => [] }, () => {
    const decision = guard.check_review_complete("demo-change", status(fx), fx.change, evidences);
    assert.equal(decision.allowed, false);
    assert.ok(codes(decision.block_reasons).includes("missing_final_verification_review"));
    assert.ok(codes(decision.block_reasons).includes("missing_final_tests"));
  });
});

withFixture("review complete blocks missing verification reference file", (fx) => {
  const guidance = [
    ...reviewGuidanceEvidences(fx),
    reviewEvidence(fx, "critic"),
  ];
  const evidences = [
    ...prepareProposeComplete(fx, {
      checked: true,
      tasksText:
        "- [x] TASK-001 Implement\n" +
        "  - invariant_refs: INV-001\n" +
        "  - test_refs: TEST-001\n" +
        "  - tdd_required: false\n" +
        "  - no_tdd_reason: non-executable-spec-change\n",
    }),
    alternativeVerificationEvidence("TASK-001"),
    ...guidance,
    mainAdjudication(fx, guidance),
    verifyEvidence(fx, "verifier", {
      create_refs: false,
      openspec_validate_ref: ".superspec/raw/verifier-missing-validate.txt",
      task_matrix_ref: ".superspec/reports/verifier-missing-task-matrix.md",
      scope_drift_ref: ".superspec/reports/verifier-missing-scope-drift.md",
    }),
    verifyEvidence(fx, "critic"),
    finalTestEvidence(fx),
  ];
  withRuntime({ openspec_validate: () => [true, ""], dirty_worktree_reasons: () => [] }, () => {
    const decision = guard.check_review_complete("demo-change", status(fx), fx.change, evidences);
    assert.equal(decision.allowed, false);
    assert.ok(codes(decision.block_reasons).includes("verification_ref_missing"));
  });
});

withFixture("review complete requires invariant matrix reference", (fx) => {
  const guidance = [
    ...reviewGuidanceEvidences(fx),
    reviewEvidence(fx, "critic"),
  ];
  const verifier = verifyEvidence(fx, "verifier", { invariant_matrix_ref: ".superspec/reports/verifier-invariant-matrix.md" });
  unlinkSync(join(fx.change, ".superspec", "reports", "verifier-invariant-matrix.md"));
  const evidences = [
    ...prepareProposeComplete(fx, {
      checked: true,
      tasksText:
        "- [x] TASK-001 Implement\n" +
        "  - invariant_refs: INV-001\n" +
        "  - test_refs: TEST-001\n" +
        "  - tdd_required: false\n" +
        "  - no_tdd_reason: non-executable-spec-change\n",
    }),
    alternativeVerificationEvidence("TASK-001"),
    ...guidance,
    mainAdjudication(fx, guidance),
    verifier,
    verifyEvidence(fx, "critic"),
    finalTestEvidence(fx),
  ];
  withRuntime({ openspec_validate: () => [true, ""], dirty_worktree_reasons: () => [] }, () => {
    const decision = guard.check_review_complete("demo-change", status(fx), fx.change, evidences);
    assert.equal(decision.allowed, false);
    assert.ok(codes(decision.block_reasons).includes("verification_ref_missing"));
  });
});

withFixture("review complete rejects empty invariant matrix", (fx) => {
  const guidance = [
    ...reviewGuidanceEvidences(fx),
    reviewEvidence(fx, "critic"),
  ];
  const verifier = verifyEvidence(fx, "verifier", { invariant_matrix_ref: ".superspec/reports/verifier-invariant-matrix.md" });
  writeText(join(fx.change, ".superspec", "reports", "verifier-invariant-matrix.md"), "");
  const evidences = [
    ...prepareProposeComplete(fx, {
      checked: true,
      tasksText:
        "- [x] TASK-001 Implement\n" +
        "  - invariant_refs: INV-001\n" +
        "  - test_refs: TEST-001\n" +
        "  - tdd_required: false\n" +
        "  - no_tdd_reason: non-executable-spec-change\n",
    }),
    alternativeVerificationEvidence("TASK-001"),
    ...guidance,
    mainAdjudication(fx, guidance),
    verifier,
    verifyEvidence(fx, "critic"),
    finalTestEvidence(fx),
  ];
  withRuntime({ openspec_validate: () => [true, ""], dirty_worktree_reasons: () => [] }, () => {
    const decision = guard.check_review_complete("demo-change", status(fx), fx.change, evidences);
    assert.equal(decision.allowed, false);
    assert.ok(codes(decision.block_reasons).includes("invariant_matrix_incomplete"));
  });
});

withFixture("review complete rejects invariant matrix paragraph token without table row", (fx) => {
  const guidance = [
    ...reviewGuidanceEvidences(fx),
    reviewEvidence(fx, "critic"),
  ];
  const verifier = verifyEvidence(fx, "verifier", { invariant_matrix_ref: ".superspec/reports/verifier-invariant-matrix.md" });
  writeText(join(fx.change, ".superspec", "reports", "verifier-invariant-matrix.md"), "INV-001 pass EV-final-test\n");
  const evidences = [
    ...prepareProposeComplete(fx, {
      checked: true,
      tasksText:
        "- [x] TASK-001 Implement\n" +
        "  - invariant_refs: INV-001\n" +
        "  - test_refs: TEST-001\n" +
        "  - tdd_required: false\n" +
        "  - no_tdd_reason: non-executable-spec-change\n",
    }),
    alternativeVerificationEvidence("TASK-001"),
    ...guidance,
    mainAdjudication(fx, guidance),
    verifier,
    verifyEvidence(fx, "critic"),
    finalTestEvidence(fx),
  ];
  withRuntime({ openspec_validate: () => [true, ""], dirty_worktree_reasons: () => [] }, () => {
    const decision = guard.check_review_complete("demo-change", status(fx), fx.change, evidences);
    assert.equal(decision.allowed, false);
    assert.ok(codes(decision.block_reasons).includes("invariant_matrix_incomplete"));
  });
});

withFixture("review complete rejects invariant matrix confirmed status", (fx) => {
  const guidance = [
    ...reviewGuidanceEvidences(fx),
    reviewEvidence(fx, "critic"),
  ];
  const verifier = verifyEvidence(fx, "verifier", { invariant_matrix_ref: ".superspec/reports/verifier-invariant-matrix.md" });
  writeText(join(fx.change, ".superspec", "reports", "verifier-invariant-matrix.md"), invariantMatrixText([{ status: "confirmed", evidence: "EV-final-test" }]));
  const evidences = [
    ...prepareProposeComplete(fx, {
      checked: true,
      tasksText:
        "- [x] TASK-001 Implement\n" +
        "  - invariant_refs: INV-001\n" +
        "  - test_refs: TEST-001\n" +
        "  - tdd_required: false\n" +
        "  - no_tdd_reason: non-executable-spec-change\n",
    }),
    alternativeVerificationEvidence("TASK-001"),
    ...guidance,
    mainAdjudication(fx, guidance),
    verifier,
    verifyEvidence(fx, "critic"),
    finalTestEvidence(fx),
  ];
  withRuntime({ openspec_validate: () => [true, ""], dirty_worktree_reasons: () => [] }, () => {
    const decision = guard.check_review_complete("demo-change", status(fx), fx.change, evidences);
    assert.equal(decision.allowed, false);
    assert.ok(codes(decision.block_reasons).includes("invariant_matrix_incomplete"));
  });
});

withFixture("review complete rejects invariant matrix unknown evidence id", (fx) => {
  const guidance = [
    ...reviewGuidanceEvidences(fx),
    reviewEvidence(fx, "critic"),
  ];
  const verifier = verifyEvidence(fx, "verifier", { invariant_matrix_ref: ".superspec/reports/verifier-invariant-matrix.md" });
  writeText(join(fx.change, ".superspec", "reports", "verifier-invariant-matrix.md"), invariantMatrixText([{ evidence: "EV-missing-final-test" }]));
  const evidences = [
    ...prepareProposeComplete(fx, {
      checked: true,
      tasksText:
        "- [x] TASK-001 Implement\n" +
        "  - invariant_refs: INV-001\n" +
        "  - test_refs: TEST-001\n" +
        "  - tdd_required: false\n" +
        "  - no_tdd_reason: non-executable-spec-change\n",
    }),
    alternativeVerificationEvidence("TASK-001"),
    ...guidance,
    mainAdjudication(fx, guidance),
    verifier,
    verifyEvidence(fx, "critic"),
    finalTestEvidence(fx),
  ];
  withRuntime({ openspec_validate: () => [true, ""], dirty_worktree_reasons: () => [] }, () => {
    const decision = guard.check_review_complete("demo-change", status(fx), fx.change, evidences);
    assert.equal(decision.allowed, false);
    assert.ok(codes(decision.block_reasons).includes("invariant_matrix_incomplete"));
  });
});

withFixture("review complete validates verifier and critic invariant matrices independently", (fx) => {
  const guidance = [
    ...reviewGuidanceEvidences(fx),
    reviewEvidence(fx, "critic"),
  ];
  const criticVerification = verifyEvidence(fx, "critic", { invariant_matrix_ref: ".superspec/reports/critic-invariant-matrix.md" });
  writeText(join(fx.change, ".superspec", "reports", "critic-invariant-matrix.md"), invariantMatrixText([{ inv_id: "INV-OTHER", evidence: "EV-final-test" }]));
  const evidences = [
    ...prepareProposeComplete(fx, {
      checked: true,
      tasksText:
        "- [x] TASK-001 Implement\n" +
        "  - invariant_refs: INV-001\n" +
        "  - test_refs: TEST-001\n" +
        "  - tdd_required: false\n" +
        "  - no_tdd_reason: non-executable-spec-change\n",
    }),
    alternativeVerificationEvidence("TASK-001"),
    ...guidance,
    mainAdjudication(fx, guidance),
    verifyEvidence(fx, "verifier"),
    criticVerification,
    finalTestEvidence(fx),
  ];
  withRuntime({ openspec_validate: () => [true, ""], dirty_worktree_reasons: () => [] }, () => {
    const decision = guard.check_review_complete("demo-change", status(fx), fx.change, evidences);
    assert.equal(decision.allowed, false);
    assert.ok(codes(decision.block_reasons).includes("invariant_matrix_incomplete"));
  });
});

withFixture("review complete accepts non EV-prefixed evidence id in invariant matrix", (fx) => {
  const guidance = [
    ...reviewGuidanceEvidences(fx),
    reviewEvidence(fx, "critic"),
  ];
  const finalTest = finalTestEvidence(fx, { evidence_id: "final-test-custom" });
  const verifier = verifyEvidence(fx, "verifier", {
    test_evidence_refs: ["final-test-custom"],
    invariant_matrix_ref: ".superspec/reports/verifier-invariant-matrix.md",
  });
  const criticVerification = verifyEvidence(fx, "critic", {
    test_evidence_refs: ["final-test-custom"],
    invariant_matrix_ref: ".superspec/reports/critic-invariant-matrix.md",
  });
  writeText(join(fx.change, ".superspec", "reports", "verifier-invariant-matrix.md"), invariantMatrixText([{ evidence: "`final-test-custom`" }]));
  writeText(join(fx.change, ".superspec", "reports", "critic-invariant-matrix.md"), invariantMatrixText([{ evidence: "[final-test-custom](../raw/final-test.log)" }]));
  const evidences = [
    ...prepareProposeComplete(fx, {
      checked: true,
      tasksText:
        "- [x] TASK-001 Implement\n" +
        "  - invariant_refs: INV-001\n" +
        "  - test_refs: TEST-001\n" +
        "  - tdd_required: false\n" +
        "  - no_tdd_reason: non-executable-spec-change\n",
    }),
    alternativeVerificationEvidence("TASK-001"),
    ...guidance,
    mainAdjudication(fx, guidance, { verification_evidence_refs: ["EV-verifier-verification", "EV-critic-verification", "final-test-custom"] }),
    verifier,
    criticVerification,
    finalTest,
  ];
  withRuntime({ openspec_validate: () => [true, ""], dirty_worktree_reasons: () => [] }, () => {
    const decision = guard.check_review_complete("demo-change", status(fx), fx.change, evidences);
    assert.equal(decision.allowed, true, JSON.stringify(decision));
  });
});

withFixture("review complete blocks unknown test evidence ref", (fx) => {
  const guidance = [
    ...reviewGuidanceEvidences(fx),
    reviewEvidence(fx, "critic"),
  ];
  const evidences = [
    ...prepareProposeComplete(fx, {
      checked: true,
      tasksText:
        "- [x] TASK-001 Implement\n" +
        "  - invariant_refs: INV-001\n" +
        "  - test_refs: TEST-001\n" +
        "  - tdd_required: false\n" +
        "  - no_tdd_reason: non-executable-spec-change\n",
    }),
    alternativeVerificationEvidence("TASK-001"),
    ...guidance,
    mainAdjudication(fx, guidance),
    verifyEvidence(fx, "verifier", { test_evidence_refs: ["EV-missing"] }),
    verifyEvidence(fx, "critic"),
    finalTestEvidence(fx),
  ];
  withRuntime({ openspec_validate: () => [true, ""], dirty_worktree_reasons: () => [] }, () => {
    const decision = guard.check_review_complete("demo-change", status(fx), fx.change, evidences);
    assert.equal(decision.allowed, false);
    assert.ok(codes(decision.block_reasons).includes("test_evidence_ref_missing"));
  });
});
