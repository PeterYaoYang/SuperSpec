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

withFixture("workflow-packet matches representative gate reality without widening the payload", (fx) => {
  const workflowKeys = new Set([
    "stage",
    "current_gate",
    "task_id",
    "status",
    "top_blockers",
    "blocker_count",
    "has_more_blockers",
    "next_action",
    "next_command",
    "openspec_cli_surfaces",
    "must_read_refs",
    "must_read_verbatim_findings",
    "must_read_verbatim_decisions",
    "diagnostic_command",
  ]);
  const proposeReady = prepareProposeComplete(fx);
  const reviewReady = archiveReadyEvidences(fx);
  const workflowCases: Array<{
    gate: string;
    taskId?: string;
    evidences: JsonMap[];
    expected: () => JsonMap;
  }> = [
    {
      gate: "explore_complete",
      evidences: proposeReady,
      expected: () => guard.check_superspec_gate("demo-change", status(fx), fx.change, proposeReady, "explore_complete"),
    },
    {
      gate: "proposal_reviewed",
      evidences: proposeReady,
      expected: () => guard.check_superspec_gate("demo-change", status(fx), fx.change, proposeReady, "proposal_reviewed"),
    },
    {
      gate: "design_complete",
      evidences: proposeReady,
      expected: () => guard.check_superspec_gate("demo-change", status(fx), fx.change, proposeReady, "design_complete"),
    },
    {
      gate: "invariants_reviewed",
      evidences: proposeReady,
      expected: () => guard.check_superspec_gate("demo-change", status(fx), fx.change, proposeReady, "invariants_reviewed"),
    },
    {
      gate: "apply_ready",
      evidences: proposeReady,
      expected: () => guard.check_apply_ready("demo-change", status(fx), fx.change, proposeReady),
    },
    {
      gate: "task_edit",
      taskId: "TASK-001",
      evidences: proposeReady,
      expected: () => guard.check_task_edit("demo-change", status(fx), fx.change, proposeReady, "TASK-001"),
    },
    {
      gate: "task_complete",
      taskId: "TASK-001",
      evidences: [...prepareProposeComplete(fx), redEvidence()],
      expected: () => guard.check_task_complete("demo-change", status(fx), fx.change, [...prepareProposeComplete(fx), redEvidence()], "TASK-001"),
    },
    {
      gate: "task_reopen",
      taskId: "TASK-001",
      evidences: taskReopenReadyEvidences(fx),
      expected: () => guard.check_task_reopen("demo-change", status(fx), fx.change, taskReopenReadyEvidences(fx), "TASK-001"),
    },
    {
      gate: "review_complete",
      evidences: reviewReady,
      expected: () => guard.check_review_complete("demo-change", status(fx), fx.change, reviewReady),
    },
    {
      gate: "archive_ready",
      evidences: reviewReady,
      expected: () => guard.check_archive_ready("demo-change", status(fx), fx.change, reviewReady),
    },
  ];

  withRuntime({
    openspec_validate: () => [true, ""],
    dirty_worktree_reasons: () => [],
    dirty_worktree_paths: () => [],
  }, () => {
    for (const item of workflowCases) {
      const expected = item.expected();
      const argv = item.taskId
        ? ["workflow-packet", "--change", "demo-change", "--gate", item.gate, "--task-id", item.taskId, "--format", "agent"]
        : ["workflow-packet", "--change", "demo-change", "--gate", item.gate, "--format", "agent"];
      const { exitCode, payload } = withRuntime({
        load_context: () => [status(fx), fx.repo, fx.change, item.evidences],
      }, () => captureMainJson(argv));
      assert.equal(exitCode, 0, item.gate);
      assert.equal(payload.current_gate, item.gate, item.gate);
      assert.equal(payload.stage, guard.gate_route_phase(item.gate), item.gate);
      assert.equal(payload.status, expected.allowed ? "allowed" : "blocked", item.gate);
      assert.equal(payload.must_read_refs.length > 0, true, item.gate);
      if (item.gate === "explore_complete") assert.ok(payload.openspec_cli_surfaces.includes('openspec list --json'), item.gate);
      if (item.gate === "apply_ready") assert.ok(payload.openspec_cli_surfaces.includes('openspec instructions apply --change "demo-change" --json'), item.gate);
      if (item.gate === "task_edit") assert.ok(payload.openspec_cli_surfaces.includes('openspec instructions apply --change "demo-change" --json'), item.gate);
      if (item.gate === "review_complete") assert.ok(payload.openspec_cli_surfaces.includes('openspec validate "demo-change"'), item.gate);
      if (item.gate === "archive_ready") assert.ok(payload.openspec_cli_surfaces.includes('openspec archive -y "demo-change"'), item.gate);
      for (const key of Object.keys(payload)) {
        assert.equal(workflowKeys.has(key), true, `${item.gate}: unexpected key ${key}`);
      }
      assert.ok(JSON.stringify(payload).length < 4000, item.gate);
      if (item.taskId) assert.equal(payload.task_id, item.taskId, item.gate);
      if (!expected.allowed) {
        const expectedCodes = [...new Set(codes(expected.block_reasons))];
        assert.deepEqual(payload.top_blockers, expectedCodes.slice(0, 5), item.gate);
      }
    }
  });
});

withFixture("workflow-packet mirrors request_changes, scope expansion, verify failure, and reopened apply paths", (fx) => {
  withRuntime({
    openspec_validate: () => [true, ""],
    dirty_worktree_reasons: () => [],
    dirty_worktree_paths: () => [],
    review_diff_paths: () => ["tasks.md", "src/service.py"],
  }, () => {
    const requestChangesGuidance = [
      ...reopenGuidanceEvidences(fx),
      reviewEvidence(fx, "critic"),
    ];
    const requestChangesEvidences = [
      ...prepareProposeComplete(fx, { checked: true }),
      greenEvidence(),
      ...requestChangesGuidance,
      mainAdjudication(fx, requestChangesGuidance, {
        review_decision: "request_changes",
        request_changes_route: "reopen_tasks",
        blocking_source_evidence_refs: ["EV-code-reviewer-guidance"],
        reopen_task_ids: ["TASK-001"],
        verification_evidence_refs: [],
      }),
    ];
    const requestChangesExpected = guard.check_review_complete("demo-change", status(fx), fx.change, requestChangesEvidences);
    const requestChangesPacket = withRuntime({
      load_context: () => [status(fx), fx.repo, fx.change, requestChangesEvidences],
    }, () => captureMainJson([
      "workflow-packet",
      "--change", "demo-change",
      "--gate", "review_complete",
      "--format", "agent",
    ]));
    assert.equal(requestChangesPacket.exitCode, 0);
    assert.equal(requestChangesPacket.payload.status, "blocked");
    assert.deepEqual(requestChangesPacket.payload.top_blockers, [...new Set(codes(requestChangesExpected.block_reasons))].slice(0, 5));

    const scopeExpansionEvidences = [...prepareProposeComplete(fx), redEvidence()];
    writeText(join(fx.change, "tasks.md"), `${readFileSync(join(fx.change, "tasks.md"), "utf8")}- [ ] TASK-002 Extra scope\n  - test_refs: TEST-001\n`);
    const scopeExpansionExpected = guard.check_task_edit("demo-change", status(fx), fx.change, scopeExpansionEvidences, "TASK-001");
    const scopeExpansionPacket = withRuntime({
      load_context: () => [status(fx), fx.repo, fx.change, scopeExpansionEvidences],
    }, () => captureMainJson([
      "workflow-packet",
      "--change", "demo-change",
      "--gate", "task_edit",
      "--task-id", "TASK-001",
      "--format", "agent",
    ]));
    assert.equal(scopeExpansionPacket.exitCode, 0);
    assert.equal(scopeExpansionPacket.payload.status, "blocked");
    assert.ok(scopeExpansionPacket.payload.top_blockers.includes("scope_expansion_unconfirmed"));
    assert.deepEqual(scopeExpansionPacket.payload.top_blockers, [...new Set(codes(scopeExpansionExpected.block_reasons))].slice(0, 5));

    const verifyFailureGuidance = [
      ...reviewGuidanceEvidences(fx, { reviewed_files: ["tasks.md", "src/service.py"] }),
      reviewEvidence(fx, "critic", { reviewed_files: ["tasks.md", "src/service.py"] }),
    ];
    writeText(join(fx.change, ".superspec", "raw", "final-test-failed.log"), "final test fail\n");
    const verifyFailureEvidences = [
      ...prepareProposeComplete(fx, { checked: true }),
      greenEvidence(),
      ...verifyFailureGuidance,
      mainAdjudication(fx, verifyFailureGuidance),
      verifyEvidence(fx, "verifier"),
      verifyEvidence(fx, "critic"),
      finalTestEvidence(fx),
      passEvidence("review_complete", "final_test", {
        evidence_id: "EV-final-test-failed",
        status: "fail",
        test_command: "test",
        output_ref: ".superspec/raw/final-test-failed.log",
        semantic_status: "expected_success",
      }),
    ];
    const verifyFailureExpected = guard.check_review_complete("demo-change", status(fx), fx.change, verifyFailureEvidences);
    const verifyFailurePacket = withRuntime({
      load_context: () => [status(fx), fx.repo, fx.change, verifyFailureEvidences],
    }, () => captureMainJson([
      "workflow-packet",
      "--change", "demo-change",
      "--gate", "review_complete",
      "--format", "agent",
    ]));
    assert.equal(verifyFailurePacket.exitCode, 0);
    assert.equal(verifyFailurePacket.payload.status, "blocked");
    assert.ok(verifyFailurePacket.payload.top_blockers.includes("verify_failure_unconfirmed"));
    assert.deepEqual(verifyFailurePacket.payload.top_blockers, [...new Set(codes(verifyFailureExpected.block_reasons))].slice(0, 5));

    const reopenedGuidance = [
      ...reopenGuidanceEvidences(fx),
      reviewEvidence(fx, "critic"),
    ];
    const reopenedEvidences = [
      ...prepareProposeComplete(fx, { checked: true }),
      ...reopenedGuidance,
      mainAdjudication(fx, reopenedGuidance, {
        review_decision: "request_changes",
        request_changes_route: "reopen_tasks",
        blocking_source_evidence_refs: ["EV-code-reviewer-guidance"],
        reopen_task_ids: ["TASK-001"],
        verification_evidence_refs: [],
      }),
      greenEvidence("TASK-001", "TEST-001", ["INV-001"], {
        evidence_id: "EV-old-green",
      }),
      supersededEvidence("EV-old-green"),
      taskReopenEvidence(fx),
      greenEvidence("TASK-001", "TEST-001", ["INV-001"], {
        evidence_id: "EV-green-successor",
        reopen_id: "reopen-001",
      }),
    ];
    setTaskCheckbox(fx.change, "TASK-001", false);
    const reopenedExpected = guard.check_task_complete("demo-change", status(fx), fx.change, reopenedEvidences, "TASK-001");
    const reopenedPacket = withRuntime({
      load_context: () => [status(fx), fx.repo, fx.change, reopenedEvidences],
    }, () => captureMainJson([
      "workflow-packet",
      "--change", "demo-change",
      "--gate", "task_complete",
      "--task-id", "TASK-001",
      "--format", "agent",
    ]));
    assert.equal(reopenedPacket.exitCode, 0);
    assert.equal(reopenedPacket.payload.status, "allowed");
    assert.equal(reopenedExpected.allowed, true);
  });
});

withFixture("review-packet serves main-thread digest and adjudication contracts with exact required refs", (fx) => {
  const reviewKeys = new Set([
    "consumer",
    "gate",
    "role",
    "round",
    "target_refs",
    "source_refs",
    "required_load_refs",
    "required_claim_ids",
    "must_read_verbatim_findings",
    "must_read_verbatim_decisions",
    "required_output_kind",
    "output_contract_fields",
    "required_review_scope",
    "stop_conditions",
  ]);

  writeDiscovery(fx);
  writeProposal(fx);
  const disclosureFinding = proposalFinding();
  const disclosureEvidences = [
    ...exploreConfirmedEvidences(fx),
    proposalRoundReview(fx, 1, [disclosureFinding]),
  ];
  const disclosurePacket = withRuntime({
    load_context: () => [status(fx), fx.repo, fx.change, disclosureEvidences],
  }, () => captureMainJson([
    "review-packet",
    "--change", "demo-change",
    "--gate", "proposal_reviewed",
    "--role", "main-thread",
    "--round", "1",
    "--format", "agent",
  ]));
  assert.equal(disclosurePacket.exitCode, 0);
  assert.equal(disclosurePacket.payload.consumer, "main-thread");
  assert.equal(disclosurePacket.payload.required_output_kind, "main_review_digest");
  assert.deepEqual(disclosurePacket.payload.required_load_refs, disclosurePacket.payload.source_refs);
  assert.ok(disclosurePacket.payload.source_refs.length > 0);
  for (const key of Object.keys(disclosurePacket.payload)) {
    assert.equal(reviewKeys.has(key), true, `proposal_reviewed: unexpected key ${key}`);
  }

  const exactRequiredLoadPath = join(fx.change, "review-input.ts");
  writeText(exactRequiredLoadPath, "export const reviewInput = true;\n");
  const exactRequiredLoadRef = {
    path: relative(fx.repo, exactRequiredLoadPath),
    blob_sha: guard.file_blob_sha(exactRequiredLoadPath),
  };
  const guidance = [
    materializeEvidenceRecord(
      fx,
      ".superspec/evidence/reviews/EV-code-reviewer-guidance.json",
      reviewEvidence(fx, "code-reviewer", {
        evidence_id: "EV-code-reviewer-guidance",
        source_refs: [exactRequiredLoadRef],
        required_load_refs: [exactRequiredLoadRef],
        blocking_findings: [{
          finding_id: "FINDING-REVIEW-001",
          finding_uid: "review_complete:EV-code-reviewer-guidance:FINDING-REVIEW-001",
          severity: "HIGH",
          summary: "critical review finding",
          affected_task_ids: ["TASK-001"],
          violated_test_ids: ["TEST-001"],
          violated_requirement_refs: [],
          why_completion_invalid: "behavior still missing proof",
          required_fix: "repair the implementation and evidence",
          completion_invalidity_class: "insufficient_completion_evidence",
          scope_expansion: false,
          reopen_recommendation: true,
        }],
      }),
    ),
    materializeEvidenceRecord(
      fx,
      ".superspec/evidence/reviews/EV-architect-guidance.json",
      reviewEvidence(fx, "architect", { evidence_id: "EV-architect-guidance" }),
    ),
    materializeEvidenceRecord(
      fx,
      ".superspec/evidence/reviews/EV-critic-guidance.json",
      reviewEvidence(fx, "critic", { evidence_id: "EV-critic-guidance" }),
    ),
  ];
  const finalReviewEvidences = [
    ...prepareProposeComplete(fx, { checked: true }),
    greenEvidence(),
    ...guidance,
    verifyEvidence(fx, "verifier"),
    verifyEvidence(fx, "critic"),
    finalTestEvidence(fx),
  ];
  const expectedLoadRefs = guidance
    .flatMap((ev) => Array.isArray(ev.required_load_refs) ? ev.required_load_refs : [])
    .map((ref) => ({ root: "repo", ...ref }));
  const expectedClaimIds = guidance.flatMap((ev) => Array.isArray(ev.required_claim_ids) ? ev.required_claim_ids.map(String) : []);
  const adjudicationPacket = withRuntime({
    load_context: () => [status(fx), fx.repo, fx.change, finalReviewEvidences],
    openspec_validate: () => [true, ""],
    dirty_worktree_reasons: () => [],
    dirty_worktree_paths: () => [],
  }, () => captureMainJson([
    "review-packet",
    "--change", "demo-change",
    "--gate", "review_complete",
    "--role", "main-thread",
    "--round", "1",
    "--format", "agent",
  ]));
  assert.equal(adjudicationPacket.exitCode, 0);
  assert.equal(adjudicationPacket.payload.consumer, "main-thread");
  assert.equal(adjudicationPacket.payload.required_output_kind, "main_adjudication");
  assert.deepEqual(adjudicationPacket.payload.required_load_refs, expectedLoadRefs);
  assert.deepEqual(adjudicationPacket.payload.required_claim_ids, expectedClaimIds);
  assert.deepEqual(adjudicationPacket.payload.must_read_verbatim_findings, [{
    evidence_id: "EV-code-reviewer-guidance",
    finding_uid: "review_complete:EV-code-reviewer-guidance:FINDING-REVIEW-001",
    evidence_ref: {
      root: "change",
      path: ".superspec/evidence/reviews/EV-code-reviewer-guidance.json",
      blob_sha: guard.file_blob_sha(join(fx.change, ".superspec/evidence/reviews/EV-code-reviewer-guidance.json")),
    },
  }]);
  assert.ok(adjudicationPacket.payload.output_contract_fields.includes("review_decision"));
  assert.ok(adjudicationPacket.payload.output_contract_fields.some((item: string) => item.startsWith("review_decision values:")));
  assert.ok(JSON.stringify(adjudicationPacket.payload).length < 7000);
  for (const key of Object.keys(adjudicationPacket.payload)) {
    assert.equal(reviewKeys.has(key), true, `review_complete: unexpected key ${key}`);
  }
});

withFixture("review-packet fails closed when review evidence contract is stale", (fx) => {
  const validSourcePath = join(fx.change, "review-source.ts");
  writeText(validSourcePath, "export const source = true;\n");
  const invalidGuidance = reviewEvidence(fx, "code-reviewer", {
    evidence_id: "EV-code-reviewer-guidance",
    source_refs: [{
      path: relative(fx.repo, validSourcePath),
      blob_sha: guard.file_blob_sha(validSourcePath),
    }],
    required_load_refs: [{
      path: "missing/review-input.ts",
      blob_sha: "sha256:stale-review-input",
    }],
  });
  const evidences = [
    ...prepareProposeComplete(fx, { checked: true }),
    greenEvidence(),
    invalidGuidance,
  ];
  const packet = withRuntime({
    load_context: () => [status(fx), fx.repo, fx.change, evidences],
  }, () => captureMainJson([
    "review-packet",
    "--change", "demo-change",
    "--gate", "review_complete",
    "--role", "main-thread",
    "--round", "1",
    "--format", "agent",
  ]));
  assert.equal(packet.exitCode, 2);
  assert.equal(packet.payload.status, "error");
  assert.equal(packet.payload.error_code, "guard_error");
  assert.match(packet.payload.message, /required_load_refs|required_load_invalid|not readable/u);
});

withFixture("review-packet supports separate critic source guidance and verification review lanes", (fx) => {
  const evidences = [
    ...prepareProposeComplete(fx, { checked: true }),
    greenEvidence(),
  ];
  withRuntime({
    load_context: () => [status(fx), fx.repo, fx.change, evidences],
    dirty_worktree_paths: () => [],
  }, () => {
    const sourceGuidance = captureMainJson([
      "review-packet",
      "--change", "demo-change",
      "--gate", "review_complete",
      "--role", "critic",
      "--round", "1",
      "--format", "agent",
    ]);
    assert.equal(sourceGuidance.exitCode, 0);
    assert.equal(sourceGuidance.payload.role, "critic");
    assert.equal(sourceGuidance.payload.required_output_kind, "source_guidance");
    assert.ok(sourceGuidance.payload.output_contract_fields.includes("blocking_findings"));

    const verification = captureMainJson([
      "review-packet",
      "--change", "demo-change",
      "--gate", "review_complete",
      "--role", "critic",
      "--round", "1",
      "--kind", "verification_review",
      "--format", "agent",
    ]);
    assert.equal(verification.exitCode, 0);
    assert.equal(verification.payload.role, "critic");
    assert.equal(verification.payload.required_output_kind, "verification_review");
    assert.ok(verification.payload.output_contract_fields.includes("openspec_validate_ref"));
    assert.ok(verification.payload.output_contract_fields.includes("scope_drift"));
    assert.equal(verification.payload.output_contract_fields.includes("blocking_findings"), false);

    const prompt = captureMain([
      "review-packet",
      "--change", "demo-change",
      "--gate", "review_complete",
      "--role", "critic",
      "--round", "1",
      "--kind", "verification_review",
      "--format", "prompt",
    ]);
    assert.equal(prompt.exitCode, 0);
    assert.ok(prompt.stdout.includes("role: critic"));
    assert.ok(prompt.stdout.includes("Required output kind: verification_review"));

    const invalidDisclosureKind = captureMainJson([
      "review-packet",
      "--change", "demo-change",
      "--gate", "proposal_reviewed",
      "--role", "critic",
      "--round", "1",
      "--kind", "verification_review",
      "--format", "agent",
    ]);
    assert.equal(invalidDisclosureKind.exitCode, 2);
    assert.equal(invalidDisclosureKind.payload.error_code, "guard_error");
    assert.match(invalidDisclosureKind.payload.message, /--kind is only supported for review_complete role lanes/u);
  });
});

withFixture("review-packet rejects unsupported gates and roles", (fx) => {
  withRuntime({
    load_context: () => [status(fx), fx.repo, fx.change, []],
  }, () => {
    const wrongGate = captureMainJson([
      "review-packet",
      "--change", "demo-change",
      "--gate", "apply_ready",
      "--role", "critic",
      "--round", "1",
      "--format", "agent",
    ]);
    assert.equal(wrongGate.exitCode, 2);
    assert.equal(wrongGate.payload.error_code, "guard_error");
    assert.match(wrongGate.payload.message, /only supports disclosure gates and review_complete/u);

    const wrongRole = captureMainJson([
      "review-packet",
      "--change", "demo-change",
      "--gate", "review_complete",
      "--role", "notarole",
      "--round", "1",
      "--format", "agent",
    ]);
    assert.equal(wrongRole.exitCode, 2);
    assert.equal(wrongRole.payload.error_code, "guard_error");
    assert.match(wrongRole.payload.message, /role notarole is not supported for gate review_complete/u);
  });
});

withFixture("packet review scopes fail closed when dirty worktree inspection fails", (fx) => {
  const loadContext = () => [status(fx), fx.repo, fx.change, []] as [JsonMap, string, string, JsonMap[]];
  withRuntime({
    load_context: loadContext,
    dirty_worktree_paths: () => { throw new Error("git unavailable"); },
    openspec_validate: () => [true, ""],
    dirty_worktree_reasons: () => [],
  }, () => {
    const workflowPacket = captureMainJson([
      "workflow-packet",
      "--change", "demo-change",
      "--gate", "review_complete",
      "--format", "agent",
    ]);
    assert.equal(workflowPacket.exitCode, 2);
    assert.equal(workflowPacket.payload.status, "error");
    assert.equal(workflowPacket.payload.error_code, "guard_error");
    assert.match(workflowPacket.payload.message, /review_complete: failed to inspect dirty worktree: git unavailable/u);

    const reviewPacket = captureMainJson([
      "review-packet",
      "--change", "demo-change",
      "--gate", "review_complete",
      "--role", "critic",
      "--round", "1",
      "--format", "agent",
    ]);
    assert.equal(reviewPacket.exitCode, 2);
    assert.equal(reviewPacket.payload.status, "error");
    assert.equal(reviewPacket.payload.error_code, "guard_error");
    assert.match(reviewPacket.payload.message, /review_complete: failed to inspect dirty worktree: git unavailable/u);
  });
});

withFixture("review-packet prompt and ledger-render share the deterministic round>1 ledger block", (fx) => {
  writeDiscovery(fx);
  writeProposal(fx);
  const finding = proposalFinding();
  const prior = [
    ...exploreConfirmedEvidences(fx),
    proposalRoundReview(fx, 1, [finding]),
    proposalDigest(fx, 1, [dispositionOf(finding)], { status: "blocked" }),
  ];
  const expectedLedger = guard.render_finding_ledger("proposal_reviewed", guard.build_finding_ledger("proposal_reviewed", prior, 2));

  const round1 = withRuntime({
    load_context: () => [status(fx), fx.repo, fx.change, prior],
  }, () => captureMain([
    "review-packet",
    "--change", "demo-change",
    "--gate", "proposal_reviewed",
    "--role", "critic",
    "--round", "1",
    "--format", "prompt",
  ]));
  assert.equal(round1.exitCode, 0);
  assert.equal(round1.stdout.includes("[SUPERSPEC-FINDING-LEDGER"), false);

  const round2 = withRuntime({
    load_context: () => [status(fx), fx.repo, fx.change, prior],
  }, () => captureMain([
    "review-packet",
    "--change", "demo-change",
    "--gate", "proposal_reviewed",
    "--role", "critic",
    "--round", "2",
    "--format", "prompt",
  ]));
  assert.equal(round2.exitCode, 0);
  assert.ok(round2.stdout.includes(expectedLedger));

  const ledger = withRuntime({
    load_context: () => [status(fx), fx.repo, fx.change, prior],
  }, () => captureMain([
    "ledger-render",
    "--change", "demo-change",
    "--gate", "proposal_reviewed",
    "--round", "2",
  ]));
  assert.equal(ledger.exitCode, 0);
  assert.equal(ledger.stdout, `${expectedLedger}\n`);
});

withFixture("packet commands are strictly read-only and do not touch state, ledger, or preservation artifacts", (fx) => {
  writeDiscovery(fx, "discovery\n");
  writeProposal(fx);
  const currentStatus = status(fx);
  const seed = guard.allow("demo-change", "recompute");
  guard.recompute_and_write_state("demo-change", fx.change, currentStatus, "propose", "apply_ready", seed);
  guard.write_archive_preservation_bundle("demo-change", fx.change);
  const statePath = join(fx.change, ".superspec", "superspec-state.json");
  const ledgerPath = join(fx.change, ".superspec", "ledger.jsonl");
  const manifestPath = join(fx.change, ".superspec", "artifacts", "archive-preservation.json");
  const bundlePath = join(fx.change, "superspec-preservation", "manifest.json");
  const before = {
    state: readFileSync(statePath, "utf8"),
    ledger: readFileSync(ledgerPath, "utf8"),
    manifest: readFileSync(manifestPath, "utf8"),
    bundle: readFileSync(bundlePath, "utf8"),
  };
  const disclosureEvidences = [
    ...exploreConfirmedEvidences(fx),
    proposalRoundReview(fx, 1, []),
    proposalDigest(fx, 1, []),
  ];
  const finalReviewEvidences = archiveReadyEvidences(fx);
  let archiveMaterializations = 0;
  const commands = [
    {
      argv: ["workflow-packet", "--change", "demo-change", "--gate", "apply_ready", "--format", "agent"],
      evidences: prepareProposeComplete(fx),
    },
    {
      argv: ["review-packet", "--change", "demo-change", "--gate", "proposal_reviewed", "--role", "main-thread", "--round", "1", "--format", "agent"],
      evidences: disclosureEvidences,
    },
    {
      argv: ["review-packet", "--change", "demo-change", "--gate", "review_complete", "--role", "main-thread", "--round", "1", "--format", "agent"],
      evidences: finalReviewEvidences,
    },
    {
      argv: ["review-packet", "--change", "demo-change", "--gate", "proposal_reviewed", "--role", "critic", "--round", "2", "--format", "prompt"],
      evidences: disclosureEvidences,
    },
    {
      argv: ["ledger-render", "--change", "demo-change", "--gate", "proposal_reviewed", "--round", "2"],
      evidences: disclosureEvidences,
    },
  ];

  for (const command of commands) {
    const { exitCode } = withRuntime({
      load_context: () => [currentStatus, fx.repo, fx.change, command.evidences],
      openspec_validate: () => [true, ""],
      dirty_worktree_reasons: () => [],
      dirty_worktree_paths: () => [],
      begin_archive_preservation_bundle: () => {
        archiveMaterializations += 1;
        throw new Error("packet command must stay read-only");
      },
    }, () => captureMain(command.argv));
    assert.equal(exitCode, 0, command.argv.join(" "));
  }

  assert.equal(archiveMaterializations, 0);
  assert.equal(readFileSync(statePath, "utf8"), before.state);
  assert.equal(readFileSync(ledgerPath, "utf8"), before.ledger);
  assert.equal(readFileSync(manifestPath, "utf8"), before.manifest);
  assert.equal(readFileSync(bundlePath, "utf8"), before.bundle);
});

// ─────────────────────────────────────────────────────────────────────────────
// DISC (disclosure design Phase 1): explore_complete review disclosure fixed point.
// Material findings raised by role reviews must reach the user via main_review_digest
// + user_review_decision instead of being silently consumed by the main thread.
// Legacy evidence without review_round_id/findings stays grandfathered (B6).
// ─────────────────────────────────────────────────────────────────────────────
