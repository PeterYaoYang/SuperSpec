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

withFixture("archive ready requires archive confirmation gate", (fx) => {
  const guidance = [
    ...reviewGuidanceEvidences(fx),
    reviewEvidence(fx, "critic"),
  ];
  const evidences = [
    ...prepareProposeComplete(fx, { checked: true }),
    greenEvidence(),
    ...guidance,
    mainAdjudication(fx, guidance),
    verifyEvidence(fx, "verifier"),
    verifyEvidence(fx, "critic"),
    finalTestEvidence(fx),
    passEvidence("design_complete", "human_confirmation"),
  ];
  withRuntime({ openspec_validate: () => [true, ""], dirty_worktree_reasons: () => [] }, () => {
    const decision = guard.check_archive_ready("demo-change", status(fx), fx.change, evidences);
    assert.equal(decision.allowed, false);
    assert.ok(codes(decision.block_reasons).includes("missing_final_confirmation"));
    assert.ok(decision.next_allowed_actions.some((item: string) => item.includes("archive_ready human_confirmation")));
  });
});

withFixture("archive ready preserves inherited review actions without generic fallback", (fx) => {
  const guidance = [
    ...reviewGuidanceEvidences(fx),
    reviewEvidence(fx, "critic"),
  ];
  const evidences = [
    ...prepareProposeComplete(fx, { checked: false }),
    ...guidance,
    mainAdjudication(fx, guidance),
    verifyEvidence(fx, "verifier"),
    verifyEvidence(fx, "critic"),
    finalTestEvidence(fx),
    passEvidence("archive_ready", "human_confirmation"),
  ];
  withRuntime({ openspec_validate: () => [true, ""], dirty_worktree_reasons: () => [] }, () => {
    const decision = guard.check_archive_ready("demo-change", status(fx), fx.change, evidences);
    assert.equal(decision.allowed, false);
    assert.ok(decision.next_allowed_actions.includes("finish remaining unchecked tasks and mark them complete only after check-task-complete passes"));
    assert.ok(!decision.next_allowed_actions.some((item: string) => item.includes("pass check-review-complete")));
  });
});

withFixture("dispatch retries transient state lock contention", (fx) => {
  guard.ensure_sidecar_layout(fx.change);
  const lock = join(fx.change, ".superspec", "superspec-state.lock");
  writeText(lock, "");
  const releaser = spawn("sh", ["-c", `sleep 0.1 && rm -f ${JSON.stringify(lock)}`], { stdio: "ignore" });
  releaser.unref();
  withRuntime({ load_context: () => [status(fx), fx.repo, fx.change, []] }, () => {
    const [decision] = guard.dispatch({ command: "recompute", change: "demo-change" });
    assert.equal(decision.allowed, true, JSON.stringify(decision));
  });
});

withFixture("A-2 stale lock is reclaimed after holder death", (fx) => {
  guard.ensure_sidecar_layout(fx.change);
  const lock = join(fx.change, ".superspec", "superspec-state.lock");
  writeText(lock, `${JSON.stringify({
    pid: 999_999_999,
    hostname: hostname(),
    created_at: new Date().toISOString(),
  })}\n`);
  withRuntime({ load_context: () => [status(fx), fx.repo, fx.change, []] }, () => {
    const [decision] = guard.dispatch({ command: "recompute", change: "demo-change" });
    assert.equal(decision.allowed, true, JSON.stringify(decision));
    assert.equal(existsSync(lock), false);
  });
});

withFixture("A-2 live aged state lock is not reclaimed", (fx) => {
  guard.ensure_sidecar_layout(fx.change);
  const lock = join(fx.change, ".superspec", "superspec-state.lock");
  writeText(lock, `${JSON.stringify({
    pid: process.pid,
    hostname: hostname(),
    created_at: "2000-01-01T00:00:00.000Z",
  })}\n`);
  withRuntime({
    load_context: () => [status(fx), fx.repo, fx.change, []],
    max_state_write_retries: 1,
  }, () => {
    assert.throws(
      () => guard.dispatch({ command: "recompute", change: "demo-change" }),
      /state_concurrent_update:/,
    );
    assert.equal(existsSync(lock), true);
  });
});

withFixture("A-2 recompute force-unlock removes fresh state lock", (fx) => {
  guard.ensure_sidecar_layout(fx.change);
  const lock = join(fx.change, ".superspec", "superspec-state.lock");
  writeText(lock, `${JSON.stringify({
    pid: process.pid,
    hostname: "localhost",
    created_at: new Date().toISOString(),
  })}\n`);
  withRuntime({ load_context: () => [status(fx), fx.repo, fx.change, []] }, () => {
    const [decision] = guard.dispatch({ command: "recompute", change: "demo-change", force_unlock: true });
    assert.equal(decision.allowed, true, JSON.stringify(decision));
    assert.equal(existsSync(lock), false);
  });
});

withFixture("A-2 recompute force-unlock rejects live state lock", (fx) => {
  guard.ensure_sidecar_layout(fx.change);
  const lock = join(fx.change, ".superspec", "superspec-state.lock");
  writeText(lock, `${JSON.stringify({
    pid: process.pid,
    hostname: hostname(),
    created_at: "2000-01-01T00:00:00.000Z",
  })}\n`);
  withRuntime({ load_context: () => [status(fx), fx.repo, fx.change, []] }, () => {
    assert.throws(
      () => guard.dispatch({ command: "recompute", change: "demo-change", force_unlock: true }),
      /refusing --force-unlock for live guard process/,
    );
    assert.equal(existsSync(lock), true);
  });
});

test("A-4c ledger created_at and event_id cannot be overridden by caller", () => {
  const event = guard.materialize_ledger_event({
    event_id: "EVT-user",
    created_at: "2000-01-01T00:00:00.000Z",
    kind: "guard_decision",
  });
  assert.notEqual(event.event_id, "EVT-user");
  assert.notEqual(event.created_at, "2000-01-01T00:00:00.000Z");
  assert.equal(event.kind, "guard_decision");
});

test("A-4a ledger event ids are unique within the same millisecond", () => {
  const originalNow = Date.now;
  Date.now = () => 42;
  try {
    const first = guard.materialize_ledger_event({ kind: "guard_decision" });
    const second = guard.materialize_ledger_event({ kind: "guard_decision" });
    assert.notEqual(first.event_id, second.event_id);
  } finally {
    Date.now = originalNow;
  }
});

withFixture("role evidence direct execution blocks", (fx) => {
  writeText(join(fx.change, ".superspec", "reports", "critic.md"), "pass\n");
  const ev = passEvidence("design_complete", "review", {
    agent_role: "critic",
    execution_mode: "direct",
    agent_id: "agent-1",
    prompt_ref: ".superspec/reports/prompt.md",
    output_ref: ".superspec/reports/critic.md",
    source_anchors: [],
    target_refs: [],
  });
  const problems = guard.validate_evidence_schema(ev, "demo-change", fx.change, fx.repo);
  assert.ok(codes(problems).includes("self_review_not_allowed"));
});

withFixture("role evidence main thread marker blocks", (fx) => {
  const ev = roleEvidence(fx, "design_complete", "critic", { created_by: "leader" });
  const problems = guard.validate_evidence_schema(ev, "demo-change", fx.change, fx.repo);
  assert.ok(codes(problems).includes("self_review_not_allowed"));
});

withFixture("role evidence stale target blob blocks", (fx) => {
  writeText(join(fx.change, "design.md"), "v1\n");
  const ev = roleEvidence(fx, "design_complete", "critic", {
    target_refs: [{ path: "design.md", blob_sha: "0000000000000000000000000000000000000000" }],
  });
  const problems = guard.validate_evidence_schema(ev, "demo-change", fx.change, fx.repo);
  assert.ok(codes(problems).includes("stale_review"));
});

withFixture("role evidence missing target file blocks without throwing", (fx) => {
  const ev = roleEvidence(fx, "design_complete", "critic", {
    target_refs: [{ path: "missing-design.md", blob_sha: "sha256:missing" }],
  });
  const problems = guard.validate_evidence_schema(ev, "demo-change", fx.change, fx.repo);
  assert.ok(codes(problems).includes("stale_review"));
});

withFixture("A-7 role evidence with empty output_ref is rejected", (fx) => {
  const ev = roleEvidence(fx, "design_complete", "critic", {
    output_ref: ".superspec/reports/empty-review.md",
  });
  writeText(join(fx.change, ".superspec", "reports", "empty-review.md"), "");
  const problems = guard.validate_evidence_schema(ev, "demo-change", fx.change, fx.repo);
  assert.ok(codes(problems).includes("evidence_output_empty"));
});

withFixture("A-7 role evidence output_ref cannot point at a reviewed target", (fx) => {
  const outputRef = ".superspec/reports/reviewed-target.md";
  const ev = roleEvidence(fx, "design_complete", "critic", {
    output_ref: outputRef,
  });
  ev.target_refs = [{ path: outputRef, blob_sha: guard.file_blob_sha(join(fx.change, outputRef)) }];
  const problems = guard.validate_evidence_schema(ev, "demo-change", fx.change, fx.repo);
  assert.ok(codes(problems).includes("evidence_output_ref_invalid"));
});

withFixture("A-7 role evidence output_ref hardlink cannot point at a reviewed target", (fx) => {
  const targetRel = ".superspec/reports/reviewed-target.md";
  const hardlinkRel = ".superspec/reports/reviewed-target-hardlink.md";
  const ev = roleEvidence(fx, "design_complete", "critic", {
    output_ref: hardlinkRel,
  });
  const targetPath = join(fx.change, targetRel);
  const hardlinkPath = join(fx.change, hardlinkRel);
  writeText(targetPath, "reviewed target\n");
  unlinkSync(hardlinkPath);
  linkSync(targetPath, hardlinkPath);
  ev.target_refs = [{ path: targetRel, blob_sha: guard.file_blob_sha(targetPath) }];
  const problems = guard.validate_evidence_schema(ev, "demo-change", fx.change, fx.repo);
  assert.ok(codes(problems).includes("evidence_output_ref_invalid"));
});

withFixture("role evidence fresh target blob allows", (fx) => {
  const target = join(fx.change, "design.md");
  writeText(target, "v1\n");
  const ev = roleEvidence(fx, "design_complete", "critic", {
    target_refs: [{ path: "design.md", blob_sha: guard.file_blob_sha(target) }],
  });
  assert.deepEqual(guard.validate_evidence_schema(ev, "demo-change", fx.change, fx.repo), []);
});

test("A-6 file_blob_sha ignores git clean filters", () => {
  const tmp = mkdtempSync(join(tmpdir(), "superspec-filter-"));
  try {
    spawnSync("git", ["init"], { cwd: tmp, stdio: "ignore" });
    writeText(join(tmp, ".gitattributes"), "*.txt filter=upper\n");
    spawnSync("git", ["config", "filter.upper.clean", "tr a-z A-Z"], { cwd: tmp, stdio: "ignore" });
    const filePath = join(tmp, "file.txt");
    const upperPath = join(tmp, "upper.txt");
    writeText(filePath, "abc\n");
    writeText(upperPath, "ABC\n");

    const raw = spawnSync("git", ["hash-object", "--no-filters", filePath], { cwd: tmp, encoding: "utf8" }).stdout.trim();
    const filtered = spawnSync("git", ["hash-object", "--path=file.txt", filePath], { cwd: tmp, encoding: "utf8" }).stdout.trim();
    const upper = spawnSync("git", ["hash-object", "--no-filters", upperPath], { cwd: tmp, encoding: "utf8" }).stdout.trim();

    assert.notEqual(raw, filtered);
    assert.equal(filtered, upper);
    assert.equal(guard.file_blob_sha(filePath), raw);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

withFixture("source guidance invalid source ref blocks", (fx) => {
  const ev = reviewEvidence(fx, "critic", { source_refs: [{ path: "../escape.md", blob_sha: "sha1" }] });
  const problems = guard.validate_evidence_schema(ev, "demo-change", fx.change, fx.repo);
  assert.ok(codes(problems).includes("evidence_unsafe_ref"));
});

withFixture("main adjudication stale loaded ref blocks", (fx) => {
  const guidance = [
    ...reviewGuidanceEvidences(fx),
    reviewEvidence(fx, "critic"),
  ];
  const ev = mainAdjudication(fx, guidance, {
    loaded_refs: guidance
      .flatMap((item) => item.required_load_refs)
      .map((refItem: JsonMap) => ({ path: refItem.path, blob_sha: "0000000000000000000000000000000000000000" })),
  });
  const problems = guard.validate_evidence_schema(ev, "demo-change", fx.change, fx.repo);
  assert.ok(codes(problems).includes("stale_loaded_ref"));
});

withFixture("main adjudication missing loaded ref file blocks without throwing", (fx) => {
  const guidance = [
    ...reviewGuidanceEvidences(fx),
    reviewEvidence(fx, "critic"),
  ];
  const ev = mainAdjudication(fx, guidance, {
    loaded_refs: [{ path: "missing-loaded-ref.md", blob_sha: "sha256:missing" }],
  });
  const problems = guard.validate_evidence_schema(ev, "demo-change", fx.change, fx.repo);
  assert.ok(codes(problems).includes("stale_loaded_ref"));
});

withFixture("main adjudication request_changes requires route", (fx) => {
  const guidance = [
    ...reviewGuidanceEvidences(fx),
    reviewEvidence(fx, "critic"),
  ];
  const ev = mainAdjudication(fx, guidance, {
    review_decision: "request_changes",
    blocking_source_evidence_refs: ["EV-code-reviewer-guidance"],
    verification_evidence_refs: [],
  });
  const problems = guard.validate_evidence_schema(ev, "demo-change", fx.change, fx.repo);
  assert.ok(codes(problems).includes("main_adjudication_invalid"));
});

withFixture("main adjudication rejects comment verdict", (fx) => {
  const guidance = [
    ...reviewGuidanceEvidences(fx),
    reviewEvidence(fx, "critic"),
  ];
  const ev = mainAdjudication(fx, guidance, { review_decision: "comment" });
  const problems = guard.validate_evidence_schema(ev, "demo-change", fx.change, fx.repo);
  assert.ok(codes(problems).includes("main_adjudication_invalid"));
});

withFixture("main adjudication requires canonical main-thread author boundary", (fx) => {
  const guidance = [
    ...reviewGuidanceEvidences(fx),
    reviewEvidence(fx, "critic"),
  ];
  const wrongMode = mainAdjudication(fx, guidance, { execution_mode: "workflow" });
  const wrongAuthor = mainAdjudication(fx, guidance, { created_by: "critic" });
  const forgedAgent = mainAdjudication(fx, guidance, { agent_id: "agent-critic" });
  assert.ok(codes(guard.validate_evidence_schema(wrongMode, "demo-change", fx.change, fx.repo)).includes("main_adjudication_invalid"));
  assert.ok(codes(guard.validate_evidence_schema(wrongAuthor, "demo-change", fx.change, fx.repo)).includes("main_adjudication_invalid"));
  assert.ok(codes(guard.validate_evidence_schema(forgedAgent, "demo-change", fx.change, fx.repo)).includes("main_adjudication_invalid"));
});

withFixture("main adjudication allow requires verification evidence refs", (fx) => {
  const guidance = [
    ...reviewGuidanceEvidences(fx),
    reviewEvidence(fx, "critic"),
  ];
  const ev = mainAdjudication(fx, guidance, { verification_evidence_refs: [] });
  const problems = guard.validate_evidence_schema(ev, "demo-change", fx.change, fx.repo);
  assert.ok(codes(problems).includes("main_adjudication_invalid"));
});

withFixture("main adjudication request_changes allows empty verification evidence refs", (fx) => {
  const guidance = [
    ...reopenGuidanceEvidences(fx),
    reviewEvidence(fx, "critic"),
  ];
  const ev = mainAdjudication(fx, guidance, {
    review_decision: "request_changes",
    request_changes_route: "reopen_tasks",
    blocking_source_evidence_refs: ["EV-code-reviewer-guidance"],
    reopen_task_ids: ["TASK-001"],
    verification_evidence_refs: [],
  });
  const problems = guard.validate_evidence_schema(ev, "demo-change", fx.change, fx.repo);
  assert.ok(!codes(problems).includes("main_adjudication_invalid"), JSON.stringify(problems));
});

withFixture("main adjudication request_changes rejects verification evidence refs", (fx) => {
  const guidance = [
    ...reviewGuidanceEvidences(fx),
    reviewEvidence(fx, "critic"),
  ];
  const ev = mainAdjudication(fx, guidance, {
    review_decision: "request_changes",
    request_changes_route: "reopen_tasks",
    blocking_source_evidence_refs: ["EV-code-reviewer-guidance"],
    reopen_task_ids: ["TASK-001"],
    verification_evidence_refs: ["EV-verifier-verification"],
  });
  const problems = guard.validate_evidence_schema(ev, "demo-change", fx.change, fx.repo);
  assert.ok(codes(problems).includes("main_adjudication_invalid"));
});

withFixture("review complete blocks request_changes and hands off to apply", (fx) => {
  const guidance = [
    ...reopenGuidanceEvidences(fx),
    reviewEvidence(fx, "critic"),
  ];
  const evidences = [
    ...prepareProposeComplete(fx, { checked: true }),
    greenEvidence(),
    ...guidance,
    mainAdjudication(fx, guidance, {
      review_decision: "request_changes",
      request_changes_route: "reopen_tasks",
      blocking_source_evidence_refs: ["EV-code-reviewer-guidance"],
      reopen_task_ids: ["TASK-001"],
    }),
  ];
  withRuntime({ openspec_validate: () => [true, ""], dirty_worktree_reasons: () => [] }, () => {
    const decision = guard.check_review_complete("demo-change", status(fx), fx.change, evidences);
    const reasonSet = codes(decision.block_reasons);
    assert.equal(decision.allowed, false);
    assert.ok(reasonSet.includes("review_requests_changes"));
    assert.ok(!reasonSet.includes("missing_final_verification_review"));
    assert.ok(!reasonSet.includes("missing_final_tests"));
    assert.ok(decision.next_allowed_actions.some((item: string) => item.includes("task_reopen")));
  });
});

withFixture("dispatch review complete request_changes survives schema guard and hands off", (fx) => {
  const guidance = [
    ...reopenGuidanceEvidences(fx),
    reviewEvidence(fx, "critic"),
  ];
  const evidences = [
    ...prepareProposeComplete(fx, { checked: true }),
    greenEvidence(),
    ...guidance,
    mainAdjudication(fx, guidance, {
      review_decision: "request_changes",
      request_changes_route: "reopen_tasks",
      blocking_source_evidence_refs: ["EV-code-reviewer-guidance"],
      reopen_task_ids: ["TASK-001"],
    }),
  ];
  withRuntime({
    load_context: () => [status(fx), fx.repo, fx.change, evidences],
    openspec_validate: () => [true, ""],
    dirty_worktree_reasons: () => [],
  }, () => {
    const [decision, route] = guard.dispatch({ command: "check-review-complete", change: "demo-change" });
    assert.equal(route, "review");
    assert.equal(decision.allowed, false);
    assert.ok(codes(decision.block_reasons).includes("review_requests_changes"));
    assert.ok(!codes(decision.block_reasons).includes("main_adjudication_invalid"), JSON.stringify(decision.block_reasons));
    assert.ok(decision.next_allowed_actions.some((item: string) => item.includes("task_reopen")));
  });
});

withFixture("dispatch request_changes with verification refs does not hand off", (fx) => {
  const guidance = [
    ...reopenGuidanceEvidences(fx),
    reviewEvidence(fx, "critic"),
  ];
  const evidences = [
    ...prepareProposeComplete(fx, { checked: true }),
    greenEvidence(),
    ...guidance,
    mainAdjudication(fx, guidance, {
      review_decision: "request_changes",
      request_changes_route: "reopen_tasks",
      blocking_source_evidence_refs: ["EV-code-reviewer-guidance"],
      reopen_task_ids: ["TASK-001"],
      verification_evidence_refs: ["EV-verifier-verification"],
    }),
  ];
  withRuntime({
    load_context: () => [status(fx), fx.repo, fx.change, evidences],
    openspec_validate: () => [true, ""],
    dirty_worktree_reasons: () => [],
  }, () => {
    const [decision] = guard.dispatch({ command: "check-review-complete", change: "demo-change" });
    const reasonSet = codes(decision.block_reasons);
    assert.equal(decision.allowed, false);
    assert.ok(reasonSet.includes("review_requests_changes"));
    assert.ok(reasonSet.includes("main_adjudication_invalid"));
    assert.ok(!decision.next_allowed_actions.some((item: string) => item.includes("hand off")));
    assert.ok(!decision.next_allowed_actions.some((item: string) => item.includes("task_reopen")));
  });
});

withFixture("dispatch request_changes missing route does not hand off", (fx) => {
  const guidance = [
    ...reopenGuidanceEvidences(fx),
    reviewEvidence(fx, "critic"),
  ];
  const evidences = [
    ...prepareProposeComplete(fx, { checked: true }),
    greenEvidence(),
    ...guidance,
    mainAdjudication(fx, guidance, {
      review_decision: "request_changes",
      blocking_source_evidence_refs: ["EV-code-reviewer-guidance"],
      verification_evidence_refs: [],
    }),
  ];
  withRuntime({
    load_context: () => [status(fx), fx.repo, fx.change, evidences],
    openspec_validate: () => [true, ""],
    dirty_worktree_reasons: () => [],
  }, () => {
    const [decision] = guard.dispatch({ command: "check-review-complete", change: "demo-change" });
    const reasonSet = codes(decision.block_reasons);
    assert.equal(decision.allowed, false);
    assert.ok(reasonSet.includes("review_requests_changes"));
    assert.ok(reasonSet.includes("main_adjudication_invalid"));
    assert.ok(!decision.next_allowed_actions.some((item: string) => item.includes("hand off")));
  });
});

withFixture("dispatch request_changes with malformed source guidance does not hand off", (fx) => {
  const guidance = [
    ...reviewGuidanceEvidences(fx, {
      lane_overrides: {
        "code-reviewer": {
          source_refs: [],
          required_load_refs: [],
          blocking_findings: [
            {
              finding_id: "FINDING-REOPEN-MALFORMED-SOURCE",
              affected_task_ids: ["TASK-001"],
            },
          ],
        },
      },
    }),
    reviewEvidence(fx, "critic"),
  ];
  const evidences = [
    ...prepareProposeComplete(fx, { checked: true }),
    greenEvidence(),
    ...guidance,
    mainAdjudication(fx, guidance, {
      review_decision: "request_changes",
      request_changes_route: "reopen_tasks",
      blocking_source_evidence_refs: ["EV-code-reviewer-guidance"],
      reopen_task_ids: ["TASK-001"],
      verification_evidence_refs: [],
    }),
  ];
  withRuntime({
    load_context: () => [status(fx), fx.repo, fx.change, evidences],
    openspec_validate: () => [true, ""],
    dirty_worktree_reasons: () => [],
  }, () => {
    const [decision] = guard.dispatch({ command: "check-review-complete", change: "demo-change" });
    const reasonSet = codes(decision.block_reasons);
    assert.equal(decision.allowed, false);
    assert.ok(reasonSet.includes("review_requests_changes"));
    assert.ok(reasonSet.includes("evidence_missing_field"));
    assert.ok(!decision.next_allowed_actions.some((item: string) => item.includes("hand off")));
    assert.ok(!decision.next_allowed_actions.some((item: string) => item.includes("task_reopen")));
  });
});

withFixture("task reopen blocks under-adjudicated request_changes guidance", (fx) => {
  const guidance = [
    ...reopenGuidanceEvidences(fx),
    reviewEvidence(fx, "critic"),
  ];
  const evidences = [
    ...prepareProposeComplete(fx, { checked: true }),
    ...guidance,
    mainAdjudication(fx, guidance, {
      review_decision: "request_changes",
      request_changes_route: "reopen_tasks",
      blocking_source_evidence_refs: ["EV-code-reviewer-guidance"],
      reopen_task_ids: ["TASK-001"],
      verification_evidence_refs: [],
      loaded_refs: [],
      claim_adjudications: [
        { claim_id: "CLAIM-CODE-REVIEWER-001", decision: "accept", rationale: "accepted" },
      ],
      finding_adjudications: [],
    }),
    taskReopenEvidence(fx),
  ];
  const decision = guard.check_task_reopen("demo-change", status(fx), fx.change, evidences, "TASK-001");
  const reasonSet = codes(decision.block_reasons);
  assert.equal(decision.allowed, false);
  assert.ok(reasonSet.includes("required_load_unloaded"), JSON.stringify(decision.block_reasons));
  assert.ok(reasonSet.includes("required_claim_unadjudicated"), JSON.stringify(decision.block_reasons));
  assert.ok(reasonSet.includes("blocking_findings_open"), JSON.stringify(decision.block_reasons));
});

withFixture("task reopen blocks without user-confirmed apply isolation", (fx) => {
  const evidences = taskReopenReadyEvidences(fx);
  const allowed = guard.check_task_reopen("demo-change", status(fx), fx.change, evidences, "TASK-001");
  assert.equal(allowed.allowed, true, JSON.stringify(allowed));

  const missingIsolation = evidences.filter((ev) => ev.gate !== "apply_isolation");
  const missing = guard.check_task_reopen("demo-change", status(fx), fx.change, missingIsolation, "TASK-001");
  assert.equal(missing.allowed, false, JSON.stringify(missing));
  assert.ok(codes(missing.block_reasons).includes("apply_isolation_unconfirmed"), JSON.stringify(missing.block_reasons));
  assert.ok(!codes(missing.block_reasons).includes("task_reopen_invalid"), JSON.stringify(missing.block_reasons));

  const nonUserIsolation = evidences.map((ev) => (
    ev.gate === "apply_isolation" ? { ...ev, created_by: "main-thread" } : ev
  ));
  const nonUser = guard.check_task_reopen("demo-change", status(fx), fx.change, nonUserIsolation, "TASK-001");
  assert.equal(nonUser.allowed, false, JSON.stringify(nonUser));
  assert.ok(codes(nonUser.block_reasons).includes("apply_isolation_unconfirmed"), JSON.stringify(nonUser.block_reasons));
  assert.ok(!codes(nonUser.block_reasons).includes("task_reopen_invalid"), JSON.stringify(nonUser.block_reasons));
});

withFixture("task reopen rejects non-review source guidance authorization", (fx) => {
  const guidance = [
    ...reopenGuidanceEvidences(fx),
    reviewEvidence(fx, "critic"),
  ];
  const oldGuidance = reviewEvidence(fx, "code-reviewer", {
    evidence_id: "EV-old-code-reviewer-guidance",
    gate: "design_complete",
    blocking_findings: [
      {
        finding_id: "FINDING-OLD-REOPEN",
        affected_task_ids: ["TASK-001"],
      },
    ],
  });
  const evidences = [
    ...prepareProposeComplete(fx, { checked: true }),
    ...guidance,
    oldGuidance,
    mainAdjudication(fx, guidance, {
      review_decision: "request_changes",
      request_changes_route: "reopen_tasks",
      source_evidence_refs: [...guidance.map((ev) => ev.evidence_id), "EV-old-code-reviewer-guidance"],
      blocking_source_evidence_refs: ["EV-code-reviewer-guidance", "EV-old-code-reviewer-guidance"],
      reopen_task_ids: ["TASK-001"],
      verification_evidence_refs: [],
    }),
    taskReopenEvidence(fx, { source_guidance_evidence_id: "EV-old-code-reviewer-guidance" }),
  ];
  const schemaProblems = guard.evidence_schema_guard("demo-change", fx.change, fx.repo, evidences);
  assert.ok(codes(schemaProblems).includes("main_adjudication_invalid"), JSON.stringify(schemaProblems));
  const decision = guard.check_task_reopen("demo-change", status(fx), fx.change, evidences, "TASK-001");
  const reasonSet = codes(decision.block_reasons);
  assert.equal(decision.allowed, false);
  assert.ok(reasonSet.includes("main_adjudication_invalid"), JSON.stringify(decision.block_reasons));
  assert.ok(reasonSet.includes("task_reopen_invalid"), JSON.stringify(decision.block_reasons));
});

withFixture("request_changes handoff requires live source guidance", (fx) => {
  const evidences = [
    ...prepareProposeComplete(fx, { checked: true }),
    greenEvidence(),
    mainAdjudication(fx, [], {
      review_decision: "request_changes",
      request_changes_route: "change_update",
      source_evidence_refs: ["EV-fake-guidance"],
      blocking_source_evidence_refs: ["EV-fake-guidance"],
    }),
  ];
  withRuntime({
    load_context: () => [status(fx), fx.repo, fx.change, evidences],
    openspec_validate: () => [true, ""],
    dirty_worktree_reasons: () => [],
  }, () => {
    const [decision] = guard.dispatch({ command: "check-review-complete", change: "demo-change" });
    const reasonSet = codes(decision.block_reasons);
    assert.equal(decision.allowed, false);
    assert.ok(reasonSet.includes("missing_source_guidance"));
    assert.ok(reasonSet.includes("source_guidance_unreferenced"));
    assert.ok(!decision.next_allowed_actions.some((item: string) => item.includes("hand off")));
  });
});

withFixture("task edit blocks when live request_changes route is change_update", (fx) => {
  const guidance = [
    ...reopenGuidanceEvidences(fx),
    reviewEvidence(fx, "critic"),
  ];
  const evidences = [
    ...prepareProposeComplete(fx, { checked: false }),
    greenEvidence(),
    ...guidance,
    mainAdjudication(fx, guidance, {
      review_decision: "request_changes",
      request_changes_route: "change_update",
      blocking_source_evidence_refs: ["EV-code-reviewer-guidance"],
    }),
  ];
  const decision = guard.check_task_edit("demo-change", status(fx), fx.change, evidences, "TASK-001");
  assert.equal(decision.allowed, false);
  assert.ok(codes(decision.block_reasons).includes("change_update_required"));
});

withFixture("task complete blocks when live request_changes route is change_update", (fx) => {
  const guidance = [
    ...reopenGuidanceEvidences(fx),
    reviewEvidence(fx, "critic"),
  ];
  const evidences = [
    ...prepareProposeComplete(fx, { checked: false }),
    greenEvidence(),
    ...guidance,
    mainAdjudication(fx, guidance, {
      review_decision: "request_changes",
      request_changes_route: "change_update",
      blocking_source_evidence_refs: ["EV-code-reviewer-guidance"],
    }),
  ];
  const decision = guard.check_task_complete("demo-change", status(fx), fx.change, evidences, "TASK-001");
  assert.equal(decision.allowed, false);
  assert.ok(codes(decision.block_reasons).includes("change_update_required"));
});

withFixture("task reopen blocks when source adjudication route is change_update", (fx) => {
  const guidance = [
    ...reopenGuidanceEvidences(fx),
    reviewEvidence(fx, "critic"),
  ];
  const evidences = [
    ...prepareProposeComplete(fx, { checked: true }),
    ...guidance,
    mainAdjudication(fx, guidance, {
      review_decision: "request_changes",
      request_changes_route: "change_update",
      blocking_source_evidence_refs: ["EV-code-reviewer-guidance"],
      verification_evidence_refs: [],
    }),
    taskReopenEvidence(fx),
  ];
  const decision = guard.check_task_reopen("demo-change", status(fx), fx.change, evidences, "TASK-001");
  assert.equal(decision.allowed, false);
  assert.ok(codes(decision.block_reasons).includes("task_reopen_invalid"));
});

withFixture("task reopen missing task id blocks schema", (fx) => {
  prepareProposeComplete(fx, { checked: true });
  const ev = taskReopenEvidence(fx);
  delete ev.task_id;
  const problems = guard.validate_evidence_schema(ev, "demo-change", fx.change, fx.repo);
  assert.ok(codes(problems).includes("evidence_missing_field"));
});

withFixture("task reopen wrong gate blocks schema", (fx) => {
  prepareProposeComplete(fx, { checked: true });
  const ev = taskReopenEvidence(fx, { gate: "review_complete" });
  const problems = guard.validate_evidence_schema(ev, "demo-change", fx.change, fx.repo);
  assert.ok(codes(problems).includes("task_reopen_invalid"));
});

withFixture("task reopen resolved wrong gate blocks schema", (fx) => {
  prepareProposeComplete(fx, { checked: true });
  const ev = taskReopenResolvedEvidence(fx, { gate: "review_complete" });
  const problems = guard.validate_evidence_schema(ev, "demo-change", fx.change, fx.repo);
  assert.ok(codes(problems).includes("task_reopen_resolved_invalid"));
});

withFixture("request_changes reopen route blocks mixed blockers", (fx) => {
  const guidance = [
    ...reopenGuidanceEvidences(fx),
    reviewEvidence(fx, "critic", {
      blocking_findings: [{ finding_id: "FINDING-CRITIC-SCOPE", summary: "needs change update" }],
      finding_dispositions: [{ finding_id: "FINDING-CRITIC-SCOPE", recommendation: "fix", rationale: "return to propose" }],
    }),
  ];
  const evidences = [
    ...guidance,
    mainAdjudication(fx, guidance, {
      review_decision: "request_changes",
      request_changes_route: "reopen_tasks",
      blocking_source_evidence_refs: ["EV-code-reviewer-guidance", "EV-critic-guidance"],
      reopen_task_ids: ["TASK-001"],
      verification_evidence_refs: [],
    }),
  ];
  const problems = guard.evidence_schema_guard("demo-change", fx.change, fx.repo, evidences);
  assert.ok(codes(problems).includes("mixed_request_changes_route"), JSON.stringify(problems));
});

withFixture("request_changes reopen route allows minimal affected task ids mapping", (fx) => {
  const guidance = [
    ...reviewGuidanceEvidences(fx, {
      lane_overrides: {
        "code-reviewer": {
          blocking_findings: [
            {
              finding_id: "FINDING-REOPEN-MINIMAL",
              affected_task_ids: ["TASK-001"],
            },
          ],
        },
      },
    }),
    reviewEvidence(fx, "critic"),
  ];
  const evidences = [
    ...guidance,
    mainAdjudication(fx, guidance, {
      review_decision: "request_changes",
      request_changes_route: "reopen_tasks",
      blocking_source_evidence_refs: ["EV-code-reviewer-guidance"],
      reopen_task_ids: ["TASK-001"],
      verification_evidence_refs: [],
    }),
  ];
  const problems = guard.evidence_schema_guard("demo-change", fx.change, fx.repo, evidences);
  assert.ok(!codes(problems).includes("mixed_request_changes_route"), JSON.stringify(problems));
  assert.ok(!codes(problems).includes("main_adjudication_invalid"), JSON.stringify(problems));
});

withFixture("request_changes reopen route blocks blocker missing affected task ids", (fx) => {
  const guidance = [
    ...reviewGuidanceEvidences(fx, {
      lane_overrides: {
        "code-reviewer": {
          blocking_findings: [
            {
              finding_id: "FINDING-REOPEN-MISSING-TASK",
            },
          ],
        },
      },
    }),
    reviewEvidence(fx, "critic"),
  ];
  const evidences = [
    ...guidance,
    mainAdjudication(fx, guidance, {
      review_decision: "request_changes",
      request_changes_route: "reopen_tasks",
      blocking_source_evidence_refs: ["EV-code-reviewer-guidance"],
      reopen_task_ids: ["TASK-001"],
      verification_evidence_refs: [],
    }),
  ];
  const problems = guard.evidence_schema_guard("demo-change", fx.change, fx.repo, evidences);
  assert.ok(codes(problems).includes("mixed_request_changes_route"), JSON.stringify(problems));
});

withFixture("request_changes reopen route blocks omitted blocker source guidance", (fx) => {
  const guidance = [
    ...reopenGuidanceEvidences(fx),
    reviewEvidence(fx, "critic", {
      blocking_findings: [{ finding_id: "FINDING-CRITIC-SCOPE", summary: "needs change update" }],
      finding_dispositions: [{ finding_id: "FINDING-CRITIC-SCOPE", recommendation: "fix", rationale: "return to propose" }],
    }),
  ];
  const evidences = [
    ...guidance,
    mainAdjudication(fx, guidance, {
      review_decision: "request_changes",
      request_changes_route: "reopen_tasks",
      blocking_source_evidence_refs: ["EV-code-reviewer-guidance"],
      reopen_task_ids: ["TASK-001"],
      verification_evidence_refs: [],
    }),
  ];
  const problems = guard.evidence_schema_guard("demo-change", fx.change, fx.repo, evidences);
  const reasonSet = codes(problems);
  assert.ok(reasonSet.includes("main_adjudication_invalid") || reasonSet.includes("mixed_request_changes_route"));
});

withFixture("request_changes reopen route blocks blocker guidance omitted from source evidence refs", (fx) => {
  const guidance = [
    ...reopenGuidanceEvidences(fx),
    reviewEvidence(fx, "critic", {
      blocking_findings: [{ finding_id: "FINDING-CRITIC-SCOPE", summary: "needs change update" }],
      finding_dispositions: [{ finding_id: "FINDING-CRITIC-SCOPE", recommendation: "fix", rationale: "return to propose" }],
    }),
  ];
  const evidences = [
    ...guidance,
    mainAdjudication(fx, guidance, {
      review_decision: "request_changes",
      request_changes_route: "reopen_tasks",
      source_evidence_refs: ["EV-code-reviewer-guidance", "EV-architect-guidance"],
      blocking_source_evidence_refs: ["EV-code-reviewer-guidance"],
      reopen_task_ids: ["TASK-001"],
      verification_evidence_refs: [],
    }),
  ];
  const problems = guard.evidence_schema_guard("demo-change", fx.change, fx.repo, evidences);
  assert.ok(codes(problems).includes("main_adjudication_invalid"), JSON.stringify(problems));
});

withFixture("dispatch check-task-reopen routes through reopen gate", (fx) => {
  const guidance = [
    ...reopenGuidanceEvidences(fx),
    reviewEvidence(fx, "critic"),
  ];
  const evidences = [
    ...prepareProposeComplete(fx, { checked: true }),
    ...guidance,
    mainAdjudication(fx, guidance, {
      review_decision: "request_changes",
      request_changes_route: "change_update",
      blocking_source_evidence_refs: ["EV-code-reviewer-guidance"],
      verification_evidence_refs: [],
    }),
    taskReopenEvidence(fx),
  ];
  withRuntime({ load_context: () => [status(fx), fx.repo, fx.change, evidences] }, () => {
    const [decision, route] = guard.dispatch({ command: "check-task-reopen", change: "demo-change", task_id: "TASK-001" });
    assert.equal(route, "apply");
    assert.equal(decision.gate, "task_reopen");
    assert.equal(decision.allowed, false);
    assert.ok(codes(decision.block_reasons).includes("task_reopen_invalid"));
  });
});

withFixture("task reopen requires code-reviewer affected_task_ids coverage", (fx) => {
  const guidance = [
    ...reviewGuidanceEvidences(fx, {
      lane_overrides: {
        "code-reviewer": {
          blocking_findings: [
            {
              finding_id: "FINDING-REOPEN-002",
              affected_task_ids: ["TASK-999"],
            },
          ],
        },
      },
    }),
    reviewEvidence(fx, "critic"),
  ];
  const evidences = [
    ...prepareProposeComplete(fx, { checked: true }),
    ...guidance,
    mainAdjudication(fx, guidance, {
      review_decision: "request_changes",
      request_changes_route: "reopen_tasks",
      blocking_source_evidence_refs: ["EV-code-reviewer-guidance"],
      reopen_task_ids: ["TASK-001"],
    }),
    taskReopenEvidence(fx),
  ];
  const decision = guard.check_task_reopen("demo-change", status(fx), fx.change, evidences, "TASK-001");
  assert.equal(decision.allowed, false);
  assert.ok(codes(decision.block_reasons).includes("task_reopen_invalid"));
});

withFixture("task edit blocks unchecked task referenced by request_changes without task reopen", (fx) => {
  const guidance = [
    ...reopenGuidanceEvidences(fx),
    reviewEvidence(fx, "critic"),
  ];
  const evidences = [
    ...prepareProposeComplete(fx),
    ...guidance,
    mainAdjudication(fx, guidance, {
      review_decision: "request_changes",
      request_changes_route: "reopen_tasks",
      blocking_source_evidence_refs: ["EV-code-reviewer-guidance"],
      reopen_task_ids: ["TASK-001"],
      verification_evidence_refs: [],
    }),
  ];
  const decision = guard.check_task_edit("demo-change", status(fx), fx.change, evidences, "TASK-001");
  assert.equal(decision.allowed, false);
  assert.ok(codes(decision.block_reasons).includes("missing_task_reopen"));
});

withFixture("task edit rejects wrong-gate task reopen", (fx) => {
  const guidance = [
    ...reopenGuidanceEvidences(fx),
    reviewEvidence(fx, "critic"),
  ];
  const evidences = [
    ...prepareProposeComplete(fx, { checked: true }),
    ...guidance,
    mainAdjudication(fx, guidance, {
      review_decision: "request_changes",
      request_changes_route: "reopen_tasks",
      blocking_source_evidence_refs: ["EV-code-reviewer-guidance"],
      reopen_task_ids: ["TASK-001"],
      verification_evidence_refs: [],
    }),
    taskReopenEvidence(fx, { gate: "review_complete" }),
    redEvidence(),
  ];
  setTaskCheckbox(fx.change, "TASK-001", false);
  const decision = guard.check_task_edit("demo-change", status(fx), fx.change, evidences, "TASK-001");
  assert.equal(decision.allowed, false);
  assert.ok(codes(decision.block_reasons).includes("missing_task_reopen"));
});

withFixture("task edit allows resumed reopened apply after authorized revert", (fx) => {
  const guidance = [
    ...reopenGuidanceEvidences(fx),
    reviewEvidence(fx, "critic"),
  ];
  const evidences = [
    ...prepareProposeComplete(fx, { checked: true }),
    ...guidance,
    mainAdjudication(fx, guidance, {
      review_decision: "request_changes",
      request_changes_route: "reopen_tasks",
      blocking_source_evidence_refs: ["EV-code-reviewer-guidance"],
      reopen_task_ids: ["TASK-001"],
      verification_evidence_refs: [],
    }),
    taskReopenEvidence(fx),
    redEvidence(),
  ];
  setTaskCheckbox(fx.change, "TASK-001", false);
  const decision = guard.check_task_edit("demo-change", status(fx), fx.change, evidences, "TASK-001");
  assert.equal(decision.allowed, true, JSON.stringify(decision));
});

withFixture("task complete blocks reopened task without successor evidence", (fx) => {
  const guidance = [
    ...reopenGuidanceEvidences(fx),
    reviewEvidence(fx, "critic"),
  ];
  const evidences = [
    ...prepareProposeComplete(fx, { checked: true }),
    ...guidance,
    mainAdjudication(fx, guidance, {
      review_decision: "request_changes",
      request_changes_route: "reopen_tasks",
      blocking_source_evidence_refs: ["EV-code-reviewer-guidance"],
      reopen_task_ids: ["TASK-001"],
      verification_evidence_refs: [],
    }),
    taskReopenEvidence(fx),
  ];
  setTaskCheckbox(fx.change, "TASK-001", false);
  const decision = guard.check_task_complete("demo-change", status(fx), fx.change, evidences, "TASK-001");
  assert.equal(decision.allowed, false);
  assert.ok(codes(decision.block_reasons).includes("missing_reopen_successor"));
});

withFixture("task complete blocks reopened task with stale pre-reopen green still live", (fx) => {
  const guidance = [
    ...reopenGuidanceEvidences(fx),
    reviewEvidence(fx, "critic"),
  ];
  const evidences = [
    ...prepareProposeComplete(fx, { checked: true }),
    ...guidance,
    mainAdjudication(fx, guidance, {
      review_decision: "request_changes",
      request_changes_route: "reopen_tasks",
      blocking_source_evidence_refs: ["EV-code-reviewer-guidance"],
      reopen_task_ids: ["TASK-001"],
      verification_evidence_refs: [],
    }),
    taskReopenEvidence(fx, {
      invalidated_completion_evidence_ids: [],
      required_supersede_evidence_ids: [],
    }),
    greenEvidence("TASK-001", "TEST-001", ["INV-001"], { evidence_id: "EV-old-green" }),
    greenEvidence("TASK-001", "TEST-001", ["INV-001"], {
      evidence_id: "EV-green-successor",
      reopen_id: "reopen-001",
    }),
  ];
  setTaskCheckbox(fx.change, "TASK-001", false);
  const decision = guard.check_task_complete("demo-change", status(fx), fx.change, evidences, "TASK-001");
  assert.equal(decision.allowed, false);
  assert.ok(codes(decision.block_reasons).includes("stale_reopen_successor"));
});

withFixture("task complete allows reopened task with superseded old green and successor green", (fx) => {
  const guidance = [
    ...reopenGuidanceEvidences(fx),
    reviewEvidence(fx, "critic"),
  ];
  const evidences = [
    ...prepareProposeComplete(fx, { checked: true }),
    ...guidance,
    mainAdjudication(fx, guidance, {
      review_decision: "request_changes",
      request_changes_route: "reopen_tasks",
      blocking_source_evidence_refs: ["EV-code-reviewer-guidance"],
      reopen_task_ids: ["TASK-001"],
      verification_evidence_refs: [],
    }),
    passEvidence("task_complete", "test_run", {
      evidence_id: "EV-old-green",
      task_id: "TASK-001",
      test_id: "TEST-001",
      invariant_refs: ["INV-001"],
      semantic_status: "expected_success",
    }),
    supersededEvidence("EV-old-green"),
    taskReopenEvidence(fx),
    greenEvidence("TASK-001", "TEST-001", ["INV-001"], {
      evidence_id: "EV-green-successor",
      reopen_id: "reopen-001",
    }),
  ];
  setTaskCheckbox(fx.change, "TASK-001", false);
  const decision = guard.check_task_complete("demo-change", status(fx), fx.change, evidences, "TASK-001");
  assert.equal(decision.allowed, true, JSON.stringify(decision));
});

withFixture("review ready blocks unresolved task reopen", (fx) => {
  const guidance = [
    ...reopenGuidanceEvidences(fx),
    reviewEvidence(fx, "critic"),
  ];
  const evidences = [
    ...prepareProposeComplete(fx, { checked: true }),
    greenEvidence(),
    ...guidance,
    mainAdjudication(fx, guidance, {
      review_decision: "request_changes",
      request_changes_route: "reopen_tasks",
      blocking_source_evidence_refs: ["EV-code-reviewer-guidance"],
      reopen_task_ids: ["TASK-001"],
      verification_evidence_refs: [],
    }),
    taskReopenEvidence(fx),
  ];
  withRuntime({
    openspec_validate: () => [true, ""],
    dirty_worktree_reasons: () => [],
  }, () => {
    const decision = guard.check_review_ready("demo-change", status(fx), fx.change, evidences);
    assert.equal(decision.allowed, false);
    assert.ok(codes(decision.block_reasons).includes("unresolved_task_reopen"));
  });
});

withFixture("task complete blocks task_reopen hidden by generic superseded evidence", (fx) => {
  const guidance = [
    ...reopenGuidanceEvidences(fx),
    reviewEvidence(fx, "critic"),
  ];
  const evidences = [
    ...prepareProposeComplete(fx, { checked: true }),
    greenEvidence(),
    ...guidance,
    mainAdjudication(fx, guidance, {
      review_decision: "request_changes",
      request_changes_route: "reopen_tasks",
      blocking_source_evidence_refs: ["EV-code-reviewer-guidance"],
      reopen_task_ids: ["TASK-001"],
      verification_evidence_refs: [],
    }),
    taskReopenEvidence(fx, {
      invalidated_completion_evidence_ids: [],
      required_supersede_evidence_ids: [],
    }),
    supersededEvidence("EV-task-reopen"),
  ];
  const decision = guard.check_task_complete("demo-change", status(fx), fx.change, evidences, "TASK-001");
  assert.equal(decision.allowed, false);
  assert.ok(codes(decision.block_reasons).includes("unresolved_task_reopen"));
});

withFixture("review ready blocks task_reopen hidden by generic superseded evidence", (fx) => {
  const guidance = [
    ...reopenGuidanceEvidences(fx),
    reviewEvidence(fx, "critic"),
  ];
  const evidences = [
    ...prepareProposeComplete(fx, { checked: true }),
    greenEvidence(),
    ...guidance,
    mainAdjudication(fx, guidance, {
      review_decision: "request_changes",
      request_changes_route: "reopen_tasks",
      blocking_source_evidence_refs: ["EV-code-reviewer-guidance"],
      reopen_task_ids: ["TASK-001"],
      verification_evidence_refs: [],
    }),
    taskReopenEvidence(fx, {
      invalidated_completion_evidence_ids: [],
      required_supersede_evidence_ids: [],
    }),
    supersededEvidence("EV-task-reopen"),
  ];
  withRuntime({ openspec_validate: () => [true, ""], dirty_worktree_reasons: () => [] }, () => {
    const decision = guard.check_review_ready("demo-change", status(fx), fx.change, evidences);
    assert.equal(decision.allowed, false);
    assert.ok(codes(decision.block_reasons).includes("unresolved_task_reopen"));
  });
});

withFixture("FIX-6 supersede blocks dangling target evidence id", (fx) => {
  const evidences = [
    greenEvidence("TASK-001", "TEST-001", ["INV-001"], { evidence_id: "EV-old-green" }),
    supersededEvidence("EV-not-there"),
  ];
  const problems = guard.evidence_schema_guard("demo-change", fx.change, fx.repo, evidences);
  assert.ok(codes(problems).includes("supersede_target_missing"), JSON.stringify(problems));
});

withFixture("FIX-6 cross-gate supersede without reason blocks supersede_unauthorized", (fx) => {
  const evidences = [
    greenEvidence("TASK-001", "TEST-001", ["INV-001"], { evidence_id: "EV-old-green" }),
    passEvidence("task_reopen", "superseded", {
      evidence_id: "EV-kill",
      status: "superseded",
      supersedes: "EV-old-green",
    }),
  ];
  const problems = guard.evidence_schema_guard("demo-change", fx.change, fx.repo, evidences);
  assert.ok(codes(problems).includes("supersede_unauthorized"), JSON.stringify(problems));
});

withFixture("FIX-6 same-gate supersede without reason is authorized", (fx) => {
  const evidences = [
    greenEvidence("TASK-001", "TEST-001", ["INV-001"], { evidence_id: "EV-old-green" }),
    passEvidence("task_complete", "superseded", {
      evidence_id: "EV-kill",
      status: "superseded",
      supersedes: "EV-old-green",
    }),
  ];
  const problems = guard.evidence_schema_guard("demo-change", fx.change, fx.repo, evidences);
  assert.ok(!codes(problems).includes("supersede_unauthorized"), JSON.stringify(problems));
  assert.ok(!codes(problems).includes("supersede_target_missing"), JSON.stringify(problems));
});

withFixture("FIX-6 cross-gate supersede with non-empty reason is authorized", (fx) => {
  const evidences = [
    greenEvidence("TASK-001", "TEST-001", ["INV-001"], { evidence_id: "EV-old-green" }),
    supersededEvidence("EV-old-green"),
  ];
  const problems = guard.evidence_schema_guard("demo-change", fx.change, fx.repo, evidences);
  assert.ok(!codes(problems).includes("supersede_unauthorized"), JSON.stringify(problems));
  assert.ok(!codes(problems).includes("supersede_target_missing"), JSON.stringify(problems));
});

withFixture("FIX-6 empty supersede_reason does not authorize cross-gate supersede", (fx) => {
  const evidences = [
    greenEvidence("TASK-001", "TEST-001", ["INV-001"], { evidence_id: "EV-old-green" }),
    passEvidence("task_reopen", "superseded", {
      evidence_id: "EV-kill",
      status: "superseded",
      supersedes: "EV-old-green",
      supersede_reason: "   ",
    }),
  ];
  const problems = guard.evidence_schema_guard("demo-change", fx.change, fx.repo, evidences);
  assert.ok(codes(problems).includes("supersede_unauthorized"), JSON.stringify(problems));
});

withFixture("FIX-6 dispatch records evidence_superseded ledger event exactly once", (fx) => {
  const evidences = [
    greenEvidence("TASK-001", "TEST-001", ["INV-001"], { evidence_id: "EV-old-green" }),
    passEvidence("task_complete", "superseded", {
      evidence_id: "EV-kill",
      status: "superseded",
      supersedes: "EV-old-green",
    }),
  ];
  withRuntime({ load_context: () => [status(fx), fx.repo, fx.change, evidences] }, () => {
    guard.dispatch({ command: "recompute", change: "demo-change" });
    guard.dispatch({ command: "recompute", change: "demo-change" });
  });
  const events = readFileSync(join(fx.change, ".superspec", "ledger.jsonl"), "utf8")
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line))
    .filter((event) => event.kind === "evidence_superseded");
  assert.equal(events.length, 1, JSON.stringify(events));
  assert.equal(events[0].superseded_by, "EV-kill");
  assert.equal(events[0].supersedes, "EV-old-green");
  assert.equal(events[0].change_id, "demo-change");
});

withFixture("FIX-7 unknown evidence kind blocks evidence_unknown_kind", (fx) => {
  const evidences = [
    passEvidence("task_complete", "test_rnu", {
      evidence_id: "EV-typo-kind",
      task_id: "TASK-001",
    }),
  ];
  const problems = guard.evidence_schema_guard("demo-change", fx.change, fx.repo, evidences);
  assert.ok(codes(problems).includes("evidence_unknown_kind"), JSON.stringify(problems));
});

withFixture("FIX-7 whitelisted evidence kinds do not report unknown kind", (fx) => {
  const kinds = [
    "review",
    "subagent_report",
    "workflow_review",
    "source_guidance",
    "main_adjudication",
    "verification_review",
    "final_test",
    "test_run",
    "alternative_verification",
    "manual_verification",
    "task_reopen",
    "task_reopen_resolved",
    "human_confirmation",
    "superseded",
  ];
  for (const kind of kinds) {
    const problems = guard.evidence_schema_guard("demo-change", fx.change, fx.repo, [
      passEvidence("design_complete", kind, { evidence_id: `EV-kind-${kind}` }),
    ]);
    assert.ok(!codes(problems).includes("evidence_unknown_kind"), `${kind}: ${JSON.stringify(problems)}`);
  }
});

withFixture("FIX-7 human confirmation requires non-empty confirmation_text", (fx) => {
  const evidences = [
    passEvidence("design_complete", "human_confirmation", {
      evidence_id: "EV-hc",
      confirmed_refs: ["design.md"],
      confirmation_text: "  ",
    }),
  ];
  const problems = guard.evidence_schema_guard("demo-change", fx.change, fx.repo, evidences);
  assert.ok(codes(problems).includes("human_confirmation_invalid"), JSON.stringify(problems));
});

withFixture("FIX-7 human confirmation requires non-empty confirmed_refs", (fx) => {
  const evidences = [
    passEvidence("design_complete", "human_confirmation", {
      evidence_id: "EV-hc",
      confirmation_text: "confirmed design trade-offs",
      confirmed_refs: [],
    }),
  ];
  const problems = guard.evidence_schema_guard("demo-change", fx.change, fx.repo, evidences);
  assert.ok(codes(problems).includes("human_confirmation_invalid"), JSON.stringify(problems));
});

withFixture("FIX-7 human confirmation gate must be a recognized confirmation gate", (fx) => {
  const evidences = [
    passEvidence("task_complete", "human_confirmation", {
      evidence_id: "EV-hc",
      confirmation_text: "confirmed",
      confirmed_refs: ["tasks.md"],
    }),
  ];
  const problems = guard.evidence_schema_guard("demo-change", fx.change, fx.repo, evidences);
  assert.ok(codes(problems).includes("human_confirmation_invalid"), JSON.stringify(problems));
});

withFixture("FIX-7 complete human confirmation passes minimal schema", (fx) => {
  const evidences = [
    passEvidence("design_complete", "human_confirmation", {
      evidence_id: "EV-hc",
      confirmation_text: "confirmed design trade-offs",
      confirmed_refs: ["design.md"],
    }),
  ];
  const problems = guard.evidence_schema_guard("demo-change", fx.change, fx.repo, evidences);
  assert.ok(!codes(problems).includes("human_confirmation_invalid"), JSON.stringify(problems));
});

withFixture("FIX-7 human confirmation must be user-authored", (fx) => {
  const problems = guard.evidence_schema_guard("demo-change", fx.change, fx.repo, [
    passEvidence("design_complete", "human_confirmation", {
      evidence_id: "EV-hc-main-thread",
      created_by: "main-thread",
      confirmation_text: "confirmed design trade-offs",
      confirmed_refs: ["design.md"],
    }),
  ]);
  assert.ok(codes(problems).includes("human_confirmation_invalid"), JSON.stringify(problems));
});

withFixture("FIX-7 branch handling confirmation uses confirmed_paths pattern", (fx) => {
  const evidences = [
    passEvidence("branch_handling", "human_confirmation", {
      evidence_id: "EV-hc-branch",
      confirmation_text: "unrelated dirty files acknowledged",
      confirmed_paths: ["unrelated.txt"],
    }),
  ];
  const problems = guard.evidence_schema_guard("demo-change", fx.change, fx.repo, evidences);
  assert.ok(!codes(problems).includes("human_confirmation_invalid"), JSON.stringify(problems));
  const missingPaths = guard.evidence_schema_guard("demo-change", fx.change, fx.repo, [
    passEvidence("branch_handling", "human_confirmation", {
      evidence_id: "EV-hc-branch-2",
      confirmation_text: "unrelated dirty files acknowledged",
    }),
  ]);
  assert.ok(codes(missingPaths).includes("human_confirmation_invalid"), JSON.stringify(missingPaths));
});

withFixture("FIX-8 apply isolation confirmation requires tasks_structure_hash", (fx) => {
  const problems = guard.evidence_schema_guard("demo-change", fx.change, fx.repo, [
    passEvidence("apply_isolation", "human_confirmation", { evidence_id: "EV-iso-no-hash" }),
  ]);
  assert.ok(codes(problems).includes("human_confirmation_invalid"), JSON.stringify(problems));
  const ok = guard.evidence_schema_guard("demo-change", fx.change, fx.repo, [
    passEvidence("apply_isolation", "human_confirmation", { evidence_id: "EV-iso-hash", tasks_structure_hash: "sha256:abc" }),
    passEvidence("scope_expansion", "human_confirmation", { evidence_id: "EV-scope-hash", tasks_structure_hash: "sha256:def" }),
    passEvidence("verify_failure_handling", "human_confirmation", { evidence_id: "EV-vfh" }),
  ]);
  assert.ok(!codes(ok).includes("human_confirmation_invalid"), JSON.stringify(ok));
});

withFixture("FIX-8 task edit blocks without apply isolation confirmation", (fx) => {
  const evidences = [
    ...prepareProposeComplete(fx).filter((ev) => ev.gate !== "apply_isolation"),
    redEvidence(),
  ];
  const decision = guard.check_task_edit("demo-change", status(fx), fx.change, evidences, "TASK-001");
  assert.equal(decision.allowed, false);
  assert.ok(codes(decision.block_reasons).includes("apply_isolation_unconfirmed"), JSON.stringify(decision.block_reasons));
});

withFixture("FIX-8 task edit allows with live apply isolation confirmation", (fx) => {
  const decision = guard.check_task_edit("demo-change", status(fx), fx.change, [
    ...prepareProposeComplete(fx),
    redEvidence(),
  ], "TASK-001");
  assert.equal(decision.allowed, true, JSON.stringify(decision));
});

withFixture("FIX-8 task gates block tasks structure change without scope re-approval", (fx) => {
  const evidences = [...prepareProposeComplete(fx), redEvidence()];
  const tasksPath = join(fx.change, "tasks.md");
  writeText(tasksPath, readFileSync(tasksPath, "utf8") + "- [ ] TASK-002 Extra scope\n  - test_refs: TEST-001\n");
  const blocked = guard.check_task_edit("demo-change", status(fx), fx.change, evidences, "TASK-001");
  assert.equal(blocked.allowed, false);
  assert.ok(codes(blocked.block_reasons).includes("scope_expansion_unconfirmed"), JSON.stringify(blocked.block_reasons));
  const reapproved = guard.check_task_edit("demo-change", status(fx), fx.change, [
    ...evidences,
    passEvidence("scope_expansion", "human_confirmation", {
      evidence_id: "EV-scope-reapproval",
      tasks_structure_hash: guard.tasks_structure_hash(fx.change),
    }),
  ], "TASK-001");
  assert.ok(!codes(reapproved.block_reasons ?? []).includes("scope_expansion_unconfirmed"), JSON.stringify(reapproved));
  assert.ok(!codes(reapproved.block_reasons ?? []).includes("apply_isolation_unconfirmed"), JSON.stringify(reapproved));
});

withFixture("FIX-8 checkbox toggles do not require scope re-approval", (fx) => {
  const evidences = [...prepareProposeComplete(fx), redEvidence(), greenEvidence()];
  const before = guard.tasks_structure_hash(fx.change);
  setTaskCheckbox(fx.change, "TASK-001", true);
  assert.equal(guard.tasks_structure_hash(fx.change), before);
  const decision = guard.check_task_complete("demo-change", status(fx), fx.change, evidences, "TASK-001");
  assert.ok(!codes(decision.block_reasons ?? []).includes("scope_expansion_unconfirmed"), JSON.stringify(decision));
  assert.ok(!codes(decision.block_reasons ?? []).includes("apply_isolation_unconfirmed"), JSON.stringify(decision));
});

withFixture("FIX-8 review complete blocks failed verification without user disposition", (fx) => {
  const guidance = [
    ...reviewGuidanceEvidences(fx, { reviewed_files: ["tasks.md", "src/service.py"] }),
    reviewEvidence(fx, "critic", { reviewed_files: ["tasks.md", "src/service.py"] }),
  ];
  writeText(join(fx.change, ".superspec", "raw", "final-test-failed.log"), "final test fail\n");
  const evidences = [
    ...prepareProposeComplete(fx, { checked: true }),
    greenEvidence(),
    ...guidance,
    mainAdjudication(fx, guidance),
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
  withRuntime({
    openspec_validate: () => [true, ""],
    dirty_worktree_reasons: () => [],
    review_diff_paths: () => ["tasks.md", "src/service.py"],
  }, () => {
    const blocked = guard.check_review_complete("demo-change", status(fx), fx.change, evidences);
    assert.equal(blocked.allowed, false);
    assert.ok(codes(blocked.block_reasons).includes("verify_failure_unconfirmed"), JSON.stringify(blocked.block_reasons));
    const confirmed = guard.check_review_complete("demo-change", status(fx), fx.change, [
      ...evidences,
      passEvidence("verify_failure_handling", "human_confirmation", {
        evidence_id: "EV-verify-failure-disposition",
        confirmation_text: "user chose: fix and rerun final tests",
        confirmed_refs: ["EV-final-test-failed"],
      }),
    ]);
    assert.equal(confirmed.allowed, true, JSON.stringify(confirmed));
  });
});

withFixture("FIX-8 superseding a failed verification does not erase disposition duty", (fx) => {
  const guidance = [
    ...reviewGuidanceEvidences(fx, { reviewed_files: ["tasks.md", "src/service.py"] }),
    reviewEvidence(fx, "critic", { reviewed_files: ["tasks.md", "src/service.py"] }),
  ];
  writeText(join(fx.change, ".superspec", "raw", "final-test-failed.log"), "final test fail\n");
  const evidences = [
    ...prepareProposeComplete(fx, { checked: true }),
    greenEvidence(),
    ...guidance,
    mainAdjudication(fx, guidance),
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
    passEvidence("review_complete", "superseded", {
      evidence_id: "EV-hide-failure",
      status: "superseded",
      supersedes: "EV-final-test-failed",
    }),
  ];
  withRuntime({
    openspec_validate: () => [true, ""],
    dirty_worktree_reasons: () => [],
    review_diff_paths: () => ["tasks.md", "src/service.py"],
  }, () => {
    const blocked = guard.check_review_complete("demo-change", status(fx), fx.change, evidences);
    assert.equal(blocked.allowed, false);
    assert.ok(codes(blocked.block_reasons).includes("verify_failure_unconfirmed"), JSON.stringify(blocked.block_reasons));
  });
});

withFixture("FIX-9 role evidence prompt_ref must be readable and non-empty", (fx) => {
  const ev = roleEvidence(fx, "design_complete", "architect", {
    evidence_id: "EV-prompt-check",
    prompt_ref: ".superspec/reports/custom-prompt.md",
  });
  const missing = guard.evidence_schema_guard("demo-change", fx.change, fx.repo, [ev]);
  assert.ok(codes(missing).includes("evidence_prompt_missing"), JSON.stringify(missing));
  writeText(join(fx.change, ".superspec", "reports", "custom-prompt.md"), "   \n");
  const empty = guard.evidence_schema_guard("demo-change", fx.change, fx.repo, [ev]);
  assert.ok(codes(empty).includes("evidence_prompt_empty"), JSON.stringify(empty));
  writeText(join(fx.change, ".superspec", "reports", "custom-prompt.md"), "review the design against discovery\n");
  const ok = guard.evidence_schema_guard("demo-change", fx.change, fx.repo, [ev]);
  assert.ok(!codes(ok).includes("evidence_prompt_missing"), JSON.stringify(ok));
  assert.ok(!codes(ok).includes("evidence_prompt_empty"), JSON.stringify(ok));
});

withFixture("FIX-9 prompt_ref escaping the change root is unsafe", (fx) => {
  const ev = roleEvidence(fx, "design_complete", "architect", {
    evidence_id: "EV-prompt-escape",
    prompt_ref: "../outside-prompt.md",
  });
  const problems = guard.evidence_schema_guard("demo-change", fx.change, fx.repo, [ev]);
  assert.ok(codes(problems).includes("evidence_unsafe_ref"), JSON.stringify(problems));
});

withFixture("FIX-9 duplicate evidence_id blocks evidence_id_duplicate", (fx) => {
  const problems = guard.evidence_schema_guard("demo-change", fx.change, fx.repo, [
    passEvidence("design_complete", "human_confirmation", { evidence_id: "EV-dup" }),
    greenEvidence("TASK-001", "TEST-001", ["INV-001"], { evidence_id: "EV-dup" }),
  ]);
  assert.ok(codes(problems).includes("evidence_id_duplicate"), JSON.stringify(problems));
  const ok = guard.evidence_schema_guard("demo-change", fx.change, fx.repo, [
    passEvidence("design_complete", "human_confirmation", { evidence_id: "EV-unique-a" }),
    greenEvidence("TASK-001", "TEST-001", ["INV-001"], { evidence_id: "EV-unique-b" }),
  ]);
  assert.ok(!codes(ok).includes("evidence_id_duplicate"), JSON.stringify(ok));
});

withFixture("FIX-10 test_run requires raw_log_refs and result_summary", (fx) => {
  const bare = passEvidence("task_complete", "test_run", {
    evidence_id: "EV-run-bare",
    task_id: "TASK-001",
    test_id: "TEST-001",
    semantic_status: "expected_success",
    raw_log_refs: undefined,
    result_summary: undefined,
  });
  const problems = guard.evidence_schema_guard("demo-change", fx.change, fx.repo, [bare]);
  assert.ok(codes(problems).includes("test_run_log_missing"), JSON.stringify(problems));
  assert.ok(codes(problems).includes("test_run_summary_missing"), JSON.stringify(problems));
});

withFixture("FIX-10 test_run log must be readable, non-empty, and inside the change root", (fx) => {
  const make = (id: string, refs: string[]): JsonMap => passEvidence("task_complete", "test_run", {
    evidence_id: id,
    task_id: "TASK-001",
    test_id: "TEST-001",
    semantic_status: "expected_success",
    raw_log_refs: refs,
    result_summary: "1 test passed",
  });
  const missing = guard.evidence_schema_guard("demo-change", fx.change, fx.repo, [make("EV-run-missing", [".superspec/raw/nope.log"])]);
  assert.ok(codes(missing).includes("test_run_log_missing"), JSON.stringify(missing));
  writeText(join(fx.change, ".superspec", "raw", "empty.log"), "   \n");
  const empty = guard.evidence_schema_guard("demo-change", fx.change, fx.repo, [make("EV-run-empty", [".superspec/raw/empty.log"])]);
  assert.ok(codes(empty).includes("test_run_log_missing"), JSON.stringify(empty));
  const escape = guard.evidence_schema_guard("demo-change", fx.change, fx.repo, [make("EV-run-escape", ["../escape.log"])]);
  assert.ok(codes(escape).includes("evidence_unsafe_ref"), JSON.stringify(escape));
});

withFixture("FIX-10 claimed test_id must appear in a referenced raw log", (fx) => {
  writeText(join(fx.change, ".superspec", "raw", "run.log"), "JUnit: TEST-001 passed\n");
  const liar = passEvidence("task_complete", "test_run", {
    evidence_id: "EV-run-liar",
    task_id: "TASK-001",
    test_id: "TEST-999",
    semantic_status: "expected_success",
    raw_log_refs: [".superspec/raw/run.log"],
    result_summary: "claims TEST-999",
  });
  const problems = guard.evidence_schema_guard("demo-change", fx.change, fx.repo, [liar]);
  assert.ok(codes(problems).includes("test_id_not_in_log"), JSON.stringify(problems));
  const honest = passEvidence("task_complete", "test_run", {
    evidence_id: "EV-run-honest",
    task_id: "TASK-001",
    test_id: "TEST-001",
    semantic_status: "expected_success",
    raw_log_refs: [".superspec/raw/run.log"],
    result_summary: "TEST-001 passed",
  });
  const ok = guard.evidence_schema_guard("demo-change", fx.change, fx.repo, [honest]);
  assert.ok(!codes(ok).includes("test_id_not_in_log"), JSON.stringify(ok));
});

withFixture("FIX-10 per-run consolidated test_run with test_ids list is valid", (fx) => {
  writeText(join(fx.change, ".superspec", "raw", "batch.log"), "TEST-001 ok\nTEST-002 ok\n");
  const run = passEvidence("task_complete", "test_run", {
    evidence_id: "EV-run-batch",
    task_id: "TASK-001",
    test_ids: ["TEST-001", "TEST-002"],
    semantic_status: "expected_success",
    raw_log_refs: [".superspec/raw/batch.log"],
    result_summary: "2 tests passed in one run",
  });
  const ok = guard.evidence_schema_guard("demo-change", fx.change, fx.repo, [run]);
  assert.ok(!codes(ok).some((code) => code.startsWith("test_run_") || code === "test_id_not_in_log"), JSON.stringify(ok));
  const partial = passEvidence("task_complete", "test_run", {
    evidence_id: "EV-run-partial",
    task_id: "TASK-001",
    test_ids: ["TEST-001", "TEST-404"],
    semantic_status: "expected_success",
    raw_log_refs: [".superspec/raw/batch.log"],
    result_summary: "claims a test the log never ran",
  });
  const problems = guard.evidence_schema_guard("demo-change", fx.change, fx.repo, [partial]);
  assert.ok(codes(problems).includes("test_id_not_in_log"), JSON.stringify(problems));
});

withFixture("FIX-11 same-gate role evidence must not reuse output_ref", (fx) => {
  const evidences = prepareProposeComplete(fx);
  const shared = ".superspec/reports/design-shared.md";
  writeText(join(fx.change, shared), "one report stamped by two roles\n");
  for (const ev of evidences) {
    if (ev.gate === "design_complete" && (ev.agent_role === "architect" || ev.agent_role === "critic")) {
      ev.output_ref = shared;
    }
  }
  const decision = guard.check_superspec_gate("demo-change", status(fx), fx.change, evidences, "design_complete");
  assert.equal(decision.allowed, false);
  assert.ok(codes(decision.block_reasons).includes("evidence_output_ref_duplicate"), JSON.stringify(decision.block_reasons));
});

withFixture("FIX-11 cross-gate output_ref reuse without review_scope blocks review_scope_unverified", (fx) => {
  const evidences = prepareProposeComplete(fx);
  const omnibus = ".superspec/reports/refresh-critic-review.md";
  writeText(join(fx.change, omnibus), "omnibus refresh review of everything\n");
  for (const ev of evidences) {
    if (ev.agent_role === "critic" && (ev.gate === "explore_complete" || ev.gate === "design_complete")) {
      ev.output_ref = omnibus;
    }
  }
  const explore = guard.check_superspec_gate("demo-change", status(fx), fx.change, evidences, "explore_complete");
  assert.equal(explore.allowed, false);
  assert.ok(codes(explore.block_reasons).includes("review_scope_unverified"), JSON.stringify(explore.block_reasons));
  const design = guard.check_superspec_gate("demo-change", status(fx), fx.change, evidences, "design_complete");
  assert.equal(design.allowed, false);
  assert.ok(codes(design.block_reasons).includes("review_scope_unverified"), JSON.stringify(design.block_reasons));
});

withFixture("FIX-11 omnibus reuse with review_scope covering gate targets is allowed", (fx) => {
  const evidences = prepareProposeComplete(fx);
  const omnibus = ".superspec/reports/refresh-critic-review.md";
  writeText(join(fx.change, omnibus), "omnibus refresh review with declared scope\n");
  for (const ev of evidences) {
    if (ev.agent_role === "critic" && (ev.gate === "explore_complete" || ev.gate === "design_complete")) {
      ev.output_ref = omnibus;
      ev.review_scope = [".superspec/artifacts/discovery.md", "design.md"];
    }
  }
  const explore = guard.check_superspec_gate("demo-change", status(fx), fx.change, evidences, "explore_complete");
  assert.ok(!codes(explore.block_reasons).includes("review_scope_unverified"), JSON.stringify(explore.block_reasons));
  assert.equal(explore.allowed, true, JSON.stringify(explore.block_reasons));
  const design = guard.check_superspec_gate("demo-change", status(fx), fx.change, evidences, "design_complete");
  assert.ok(!codes(design.block_reasons).includes("review_scope_unverified"), JSON.stringify(design.block_reasons));
  assert.equal(design.allowed, true, JSON.stringify(design.block_reasons));
});

withFixture("FIX-11 review_scope missing this gate's target artifact still blocks", (fx) => {
  const evidences = prepareProposeComplete(fx);
  const omnibus = ".superspec/reports/refresh-critic-review.md";
  writeText(join(fx.change, omnibus), "omnibus refresh review with partial scope\n");
  for (const ev of evidences) {
    if (ev.agent_role === "critic" && (ev.gate === "explore_complete" || ev.gate === "design_complete")) {
      ev.output_ref = omnibus;
      // Scope covers discovery only; the design_complete stamp is outside the declared contract.
      ev.review_scope = [".superspec/artifacts/discovery.md"];
    }
  }
  const explore = guard.check_superspec_gate("demo-change", status(fx), fx.change, evidences, "explore_complete");
  assert.ok(!codes(explore.block_reasons).includes("review_scope_unverified"), JSON.stringify(explore.block_reasons));
  const design = guard.check_superspec_gate("demo-change", status(fx), fx.change, evidences, "design_complete");
  assert.equal(design.allowed, false);
  assert.ok(codes(design.block_reasons).includes("review_scope_unverified"), JSON.stringify(design.block_reasons));
});

withFixture("FIX-12 dangling *_evidence_refs blocks dangling_evidence_ref", (fx) => {
  const adjudication = passEvidence("review_complete", "main_adjudication", {
    evidence_id: "EV-adjudication",
    execution_mode: "direct",
    created_by: "main-thread",
    review_decision: "allow",
    source_evidence_refs: ["EV-ghost-guidance"],
    verification_evidence_refs: ["EV-verifier-verification"],
  });
  const verification = verifyEvidence(fx, "verifier");
  const finalTest = finalTestEvidence(fx);
  const problems = guard.evidence_schema_guard("demo-change", fx.change, fx.repo, [adjudication, verification, finalTest]);
  assert.ok(codes(problems).includes("dangling_evidence_ref"), JSON.stringify(problems));
  const dangling = problems.filter((item) => item.code === "dangling_evidence_ref");
  assert.equal(dangling.length, 1, JSON.stringify(dangling));
  assert.ok(dangling[0].message.includes("EV-ghost-guidance"), JSON.stringify(dangling));
});

withFixture("FIX-12 dangling lane_evidence_refs object values block dangling_evidence_ref", (fx) => {
  const workflow = roleEvidence(fx, "review_complete", "code-reviewer", {
    evidence_id: "EV-workflow",
    workflow: "code-review",
    execution_mode: "workflow",
    lane_evidence_refs: { "code-reviewer": "EV-ghost-lane", architect: "EV-architect-lane" },
  });
  const architectLane = roleEvidence(fx, "review_complete", "architect", { evidence_id: "EV-architect-lane" });
  const problems = guard.evidence_schema_guard("demo-change", fx.change, fx.repo, [workflow, architectLane]);
  const dangling = problems.filter((item) => item.code === "dangling_evidence_ref");
  assert.equal(dangling.length, 1, JSON.stringify(problems));
  assert.ok(dangling[0].message.includes("EV-ghost-lane"), JSON.stringify(dangling));
});

withFixture("FIX-12 fully resolved evidence refs do not report dangling", (fx) => {
  const guidance = roleEvidence(fx, "review_complete", "critic", { evidence_id: "EV-critic-guidance" });
  const adjudication = passEvidence("review_complete", "main_adjudication", {
    evidence_id: "EV-adjudication",
    execution_mode: "direct",
    created_by: "main-thread",
    review_decision: "allow",
    source_evidence_refs: ["EV-critic-guidance"],
  });
  const problems = guard.evidence_schema_guard("demo-change", fx.change, fx.repo, [guidance, adjudication]);
  assert.ok(!codes(problems).includes("dangling_evidence_ref"), JSON.stringify(problems));
});

// FIX-13 (audit F-1): backfill tests for previously-untested reason codes, grouped by defense line.

withFixture("FIX-13 evidence schema base defenses", (fx) => {
  const problems = guard.evidence_schema_guard("demo-change", fx.change, fx.repo, [
    { _invalid: true, _path: "evidence/bad.json" },
    passEvidence("design_complete", "review", { evidence_id: "EV-bad-status", status: "maybe" }),
    passEvidence("design_complete", "review", { evidence_id: "EV-wrong-change", change_id: "other-change" }),
    passEvidence("design_complete", "review", { evidence_id: "EV-forbidden", current_stage: "apply" }),
  ]);
  const reasonSet = codes(problems);
  for (const code of ["evidence_unparsable", "evidence_bad_status", "evidence_change_mismatch", "evidence_forbidden_field"]) {
    assert.ok(reasonSet.includes(code), `${code}: ${JSON.stringify(problems)}`);
  }
});

withFixture("FIX-13 role evidence schema defenses", (fx) => {
  const problems = guard.evidence_schema_guard("demo-change", fx.change, fx.repo, [
    roleEvidence(fx, "design_complete", "architect", { target_refs: [] }),
    roleEvidence(fx, "design_complete", "critic", { execution_mode: "remote_api" }),
  ]);
  const reasonSet = codes(problems);
  assert.ok(reasonSet.includes("missing_target_refs"), JSON.stringify(problems));
  assert.ok(reasonSet.includes("missing_native_subagent_evidence"), JSON.stringify(problems));
});

withFixture("FIX-13 source guidance contract defenses", (fx) => {
  const problems = guard.evidence_schema_guard("demo-change", fx.change, fx.repo, [
    reviewEvidence(fx, "intern"),
    reviewEvidence(fx, "critic", {
      evidence_id: "EV-bad-load",
      required_load_refs: [{ path: "not-in-sources.md", blob_sha: "deadbeef" }],
    }),
    reviewEvidence(fx, "architect", {
      evidence_id: "EV-bad-findings",
      blocking_findings: [{}],
    }),
    reviewEvidence(fx, "code-reviewer", {
      evidence_id: "EV-bad-dispositions",
      blocking_findings: [{ finding_id: "FINDING-001", affected_task_ids: ["TASK-001"] }],
      finding_dispositions: [],
    }),
  ]);
  const reasonSet = codes(problems);
  for (const code of ["review_guidance_role_invalid", "required_load_invalid", "blocking_findings_invalid", "finding_disposition_invalid"]) {
    assert.ok(reasonSet.includes(code), `${code}: ${JSON.stringify(problems)}`);
  }
});

withFixture("FIX-13 adjudication entry defenses", (fx) => {
  const problems = guard.evidence_schema_guard("demo-change", fx.change, fx.repo, [
    mainAdjudication(fx, [], {
      claim_adjudications: [{}],
      finding_adjudications: [{}],
    }),
  ]);
  const reasonSet = codes(problems);
  assert.ok(reasonSet.includes("claim_adjudication_invalid"), JSON.stringify(problems));
  assert.ok(reasonSet.includes("finding_adjudication_invalid"), JSON.stringify(problems));
});

withFixture("FIX-13 verification evidence defenses", (fx) => {
  const problems = guard.evidence_schema_guard("demo-change", fx.change, fx.repo, [
    verifyEvidence(fx, "intern"),
    passEvidence("review_complete", "final_test", { evidence_id: "EV-bare-final-test" }),
    verifyEvidence(fx, "verifier", { openspec_validate_ref: "../../escape.txt", create_refs: false }),
  ]);
  const reasonSet = codes(problems);
  for (const code of ["verification_role_invalid", "verification_evidence_incomplete", "verification_ref_invalid"]) {
    assert.ok(reasonSet.includes(code), `${code}: ${JSON.stringify(problems)}`);
  }
});

withFixture("FIX-13 code-review workflow evidence defenses", (fx) => {
  const schemaProblems = guard.evidence_schema_guard("demo-change", fx.change, fx.repo, [
    passEvidence("review_complete", "workflow_review", {
      evidence_id: "EV-bad-workflow",
      workflow: "perf-review",
      execution_mode: "direct",
    }),
    passEvidence("review_complete", "workflow_review", {
      evidence_id: "EV-incomplete-workflow",
      workflow: "code-review",
      execution_mode: "workflow",
    }),
  ]);
  const schemaSet = codes(schemaProblems);
  assert.ok(schemaSet.includes("workflow_evidence_invalid"), JSON.stringify(schemaProblems));
  assert.ok(schemaSet.includes("code_review_workflow_incomplete"), JSON.stringify(schemaProblems));

  const architectLane = passEvidence("review_complete", "review", {
    evidence_id: "EV-arch-lane",
    agent_role: "critic",
    execution_mode: "native_subagent",
  });
  const workflowEv = passEvidence("review_complete", "workflow_review", {
    evidence_id: "EV-workflow",
    workflow: "code-review",
    execution_mode: "workflow",
    lane_evidence_refs: { "code-reviewer": "EV-missing-lane", architect: "EV-arch-lane" },
  });
  const laneProblems = guard.code_review_lane_evidence_reasons(workflowEv, [workflowEv, architectLane]);
  const laneSet = codes(laneProblems);
  assert.ok(laneSet.includes("code_review_lane_evidence_missing"), JSON.stringify(laneProblems));
  assert.ok(laneSet.includes("code_review_lane_role_mismatch"), JSON.stringify(laneProblems));
});

withFixture("FIX-13 init surface defenses", (fx) => {
  writeText(join(fx.repo, ".codex", "hooks.json"), "{}\n");
  writeText(join(fx.repo, "openspec", "schemas", "superspec", "schema.yaml"), "custom\n");
  const brokenStatus = {
    ...status(fx),
    artifacts: [
      { id: "proposal", status: "done", missingDeps: [] },
      { id: "specs", status: "done", missingDeps: [] },
      { id: "design", status: "done", missingDeps: [] },
      { id: "epics", status: "done", missingDeps: [] },
    ],
    applyRequires: [],
  };
  const decision = guard.check_init("demo-change", brokenStatus, fx.repo, fx.change);
  assert.equal(decision.allowed, false);
  const reasonSet = codes(decision.block_reasons);
  for (const code of ["missing_openspec_artifacts", "unexpected_openspec_artifacts", "unexpected_apply_requires", "v1_hook_artifact_present", "custom_superspec_schema_present"]) {
    assert.ok(reasonSet.includes(code), `${code}: ${JSON.stringify(decision.block_reasons)}`);
  }
});

withFixture("FIX-13 artifact entry defenses", (fx) => {
  const bogus = guard.check_artifact("demo-change", status(fx), fx.change, [], "bogus");
  assert.equal(bogus.allowed, false);
  assert.ok(codes(bogus.block_reasons).includes("not_openspec_artifact"));

  const missingDesign = { ...status(fx), artifacts: status(fx).artifacts.filter((item: JsonMap) => item.id !== "design") };
  const unknown = guard.check_artifact("demo-change", missingDesign, fx.change, [], "design");
  assert.equal(unknown.allowed, false);
  assert.ok(codes(unknown.block_reasons).includes("unknown_artifact"));

  const blockedDesign = {
    ...status(fx),
    artifacts: status(fx).artifacts.map((item: JsonMap) => item.id === "design" ? { ...item, status: "blocked", missingDeps: ["proposal"] } : item),
  };
  const blocked = guard.check_artifact("demo-change", blockedDesign, fx.change, [], "design");
  assert.equal(blocked.allowed, false);
  assert.ok(codes(blocked.block_reasons).includes("openspec_blocked"));
});

withFixture("FIX-13 gate routing defenses", (fx) => {
  const unknownGate = guard.check_superspec_gate("demo-change", status(fx), fx.change, [], "no_such_gate");
  assert.equal(unknownGate.allowed, false);
  assert.ok(codes(unknownGate.block_reasons).includes("unknown_gate"));

  const design = guard.check_superspec_gate("demo-change", status(fx, { design: "ready" }), fx.change, [], "design_complete");
  assert.ok(codes(design.block_reasons).includes("missing_design"));

  const drafted = guard.check_superspec_gate("demo-change", status(fx), fx.change, [], "test_contract_drafted");
  assert.ok(codes(drafted.block_reasons).includes("invariants_not_reviewed"));

  writeText(join(fx.change, ".superspec", "artifacts", "business-invariants.md"), "free prose with no table\n");
  const invariants = guard.check_superspec_gate("demo-change", status(fx), fx.change, [], "invariants_reviewed");
  assert.ok(codes(invariants.block_reasons).includes("invalid_business_invariants"));

  writeText(join(fx.change, "tasks.md"), "notes only, no structured tasks\n");
  const tasksGate = guard.check_superspec_gate("demo-change", status(fx), fx.change, [], "tasks_complete");
  assert.ok(codes(tasksGate.block_reasons).includes("invalid_task_graph"));
});

withFixture("agent output hides unknown dispatch gate identifiers", (fx) => {
  const decision = withRuntime({ load_context: () => [status(fx), fx.repo, fx.change, []] }, () => {
    const [result] = guard.dispatch({ command: "check-enter", change: "demo-change", gate: "raw_secret_gate", format: "agent" });
    return result;
  });
  const agentText = captureStdoutText(() => {
    guard.printDecision(decision, { command: "check-enter", format: "agent" });
  });
  const agent = JSON.parse(agentText);
  assert.equal(agent.workflow_action, "inspect_diagnostics");
  assertNoForbiddenAgentKeys(agent);
  assertSafeOutputHasNoLeaks(agentText);
});

withFixture("FIX-13 review readiness defenses", (fx) => {
  writeText(join(fx.change, "tasks.md"), "- [ ] TASK-001 Implement\n  - test_refs: TEST-001\n");
  const ready = withRuntime({ openspec_validate: () => [true, ""], dirty_worktree_reasons: () => [] }, () =>
    guard.check_review_ready("demo-change", status(fx, { proposal: "ready" }), fx.change, []));
  assert.equal(ready.allowed, false);
  const readySet = codes(ready.block_reasons);
  assert.ok(readySet.includes("artifacts_incomplete"), JSON.stringify(ready.block_reasons));
  assert.ok(readySet.includes("tasks_incomplete"), JSON.stringify(ready.block_reasons));

  const complete = withRuntime({ openspec_validate: () => [true, ""], dirty_worktree_reasons: () => [] }, () =>
    guard.check_review_complete("demo-change", status(fx, { proposal: "ready" }), fx.change, []));
  assert.equal(complete.allowed, false);
  assert.ok(codes(complete.block_reasons).includes("review_not_ready"), JSON.stringify(complete.block_reasons));

  const archive = withRuntime({ openspec_validate: () => [true, ""], dirty_worktree_reasons: () => [] }, () =>
    guard.check_archive_ready("demo-change", status(fx), fx.change, []));
  assert.equal(archive.allowed, false);
  assert.ok(codes(archive.block_reasons).includes("review_gate_failed"), JSON.stringify(archive.block_reasons));
});

withFixture("FIX-13 TDD enumeration defenses", (fx) => {
  const evidences = prepareProposeComplete(fx, {
    tasksText:
      "- [ ] TASK-101 Bad mode\n" +
      "  - tdd_mode: time-travel\n" +
      "  - test_refs: TEST-001\n" +
      "  - invariant_refs: INV-001\n" +
      "- [ ] TASK-102 Bad exemption\n" +
      "  - tdd_required: false\n" +
      "  - no_tdd_reason: vibes\n" +
      "- [ ] TASK-103 Refactor\n" +
      "  - tdd_mode: behavior-preserving-refactor\n" +
      "  - test_refs: TEST-001\n" +
      "  - invariant_refs: INV-001\n" +
      "- [x] TASK-104 Done already\n",
  });
  const cases: Array<[string, string]> = [
    ["TASK-101", "invalid_tdd_mode"],
    ["TASK-102", "invalid_no_tdd_reason"],
    ["TASK-103", "missing_characterization"],
    ["TASK-104", "task_already_done"],
  ];
  for (const [taskId, code] of cases) {
    const decision = guard.check_task_edit("demo-change", status(fx), fx.change, evidences, taskId);
    assert.equal(decision.allowed, false, taskId);
    assert.ok(codes(decision.block_reasons).includes(code), `${taskId} ${code}: ${JSON.stringify(codes(decision.block_reasons))}`);
  }
});

withFixture("FIX-13 RED evidence id and invariant defenses", (fx) => {
  const evidences = [
    ...prepareProposeComplete(fx),
    redEvidence("TASK-001", "", ["INV-001"], { evidence_id: "EV-red-no-test-id" }),
    redEvidence("TASK-001", "TEST-999", ["INV-001"], { evidence_id: "EV-red-unknown-test" }),
    redEvidence("TASK-001", "TEST-001", [], { evidence_id: "EV-red-no-invariants" }),
    redEvidence("TASK-001", "TEST-001", ["INV-999"], { evidence_id: "EV-red-unknown-invariant" }),
  ];
  const decision = guard.check_task_edit("demo-change", status(fx), fx.change, evidences, "TASK-001");
  assert.equal(decision.allowed, false);
  const reasonSet = codes(decision.block_reasons);
  for (const code of ["missing_test_id", "test_contract_not_honored", "missing_invariant_ref", "invalid_invariant_ref"]) {
    assert.ok(reasonSet.includes(code), `${code}: ${JSON.stringify(reasonSet)}`);
  }
});

withFixture("FIX-13 reopen lifecycle defenses", (fx) => {
  const checkedEvidences = [
    ...prepareProposeComplete(fx, { checked: true }),
    taskReopenEvidence(fx),
  ];
  const pending = guard.check_task_edit("demo-change", status(fx), fx.change, checkedEvidences, "TASK-001");
  assert.equal(pending.allowed, false);
  assert.ok(codes(pending.block_reasons).includes("task_reopen_pending_revert"), JSON.stringify(codes(pending.block_reasons)));

  const ambiguousEvidences = [
    ...checkedEvidences,
    taskReopenEvidence(fx, { evidence_id: "EV-task-reopen-2", reopen_id: "reopen-002" }),
  ];
  setTaskCheckbox(fx.change, "TASK-001", false);
  const ambiguous = guard.check_task_edit("demo-change", status(fx), fx.change, ambiguousEvidences, "TASK-001");
  assert.equal(ambiguous.allowed, false);
  assert.ok(codes(ambiguous.block_reasons).includes("ambiguous_task_reopen"), JSON.stringify(codes(ambiguous.block_reasons)));
});

withFixture("FIX-13 scope expansion cannot ride task_reopen", (fx) => {
  const evidences = [
    ...prepareProposeComplete(fx, { checked: true }),
    taskReopenEvidence(fx, { scope_expansion: true }),
  ];
  const decision = guard.check_task_reopen("demo-change", status(fx), fx.change, evidences, "TASK-001");
  assert.equal(decision.allowed, false);
  assert.ok(codes(decision.block_reasons).includes("scope_expansion_requires_propose"), JSON.stringify(codes(decision.block_reasons)));
});

withFixture("FIX-13 ambiguous main adjudication blocks review_complete", (fx) => {
  const guidance = [
    ...reviewGuidanceEvidences(fx),
    reviewEvidence(fx, "critic"),
  ];
  const evidences = [
    ...prepareProposeComplete(fx, { checked: true }),
    greenEvidence(),
    ...guidance,
    mainAdjudication(fx, guidance),
    mainAdjudication(fx, guidance, { evidence_id: "EV-main-adjudication-2" }),
    verifyEvidence(fx, "verifier"),
    verifyEvidence(fx, "critic"),
    finalTestEvidence(fx),
  ];
  const decision = withRuntime({ openspec_validate: () => [true, ""], dirty_worktree_reasons: () => [] }, () =>
    guard.check_review_complete("demo-change", status(fx), fx.change, evidences));
  assert.equal(decision.allowed, false);
  assert.ok(codes(decision.block_reasons).includes("ambiguous_main_adjudication"), JSON.stringify(codes(decision.block_reasons)));
});

withFixture("FIX-13 review completion disposition defenses", (fx) => {
  const guidance = [
    ...reviewGuidanceEvidences(fx),
    reviewEvidence(fx, "critic", { rollback_targets: [] }),
  ];
  const claims = guidance.flatMap((ev) => Array.isArray(ev.required_claim_ids) ? ev.required_claim_ids : []);
  const evidences = [
    ...prepareProposeComplete(fx, { checked: true }),
    greenEvidence(),
    ...guidance,
    mainAdjudication(fx, guidance, {
      claim_adjudications: claims.map((claimId: string) => ({ claim_id: claimId, decision: "needs_fix", rationale: "unresolved" })),
    }),
    verifyEvidence(fx, "verifier", { scope_drift: "expanded" }),
    verifyEvidence(fx, "critic"),
    finalTestEvidence(fx),
  ];
  const decision = withRuntime({ openspec_validate: () => [true, ""], dirty_worktree_reasons: () => [] }, () =>
    guard.check_review_complete("demo-change", status(fx), fx.change, evidences));
  assert.equal(decision.allowed, false);
  const reasonSet = codes(decision.block_reasons);
  for (const code of ["claim_adjudication_blocked", "missing_rollback_target", "scope_drift"]) {
    assert.ok(reasonSet.includes(code), `${code}: ${JSON.stringify(reasonSet)}`);
  }
});

withFixture("FIX-13 infra failure defenses", (fx) => {
  assert.ok(codes(guard.openspec_status_shape_reasons({})).includes("openspec_status_incompatible"));

  const diffProblems = withRuntime({
    review_diff_paths: () => {
      throw new Error("git unavailable");
    },
  }, () => guard.review_diff_coverage_reasons(fx.repo, { _path: "ev", base_ref: "a", head_ref: "b", reviewed_files: ["tasks.md"] }));
  assert.ok(codes(diffProblems).includes("review_diff_unavailable"), JSON.stringify(diffProblems));

  const writes: string[] = [];
  const savedWrite = process.stdout.write;
  process.stdout.write = ((chunk: any) => {
    writes.push(String(chunk));
    return true;
  }) as typeof process.stdout.write;
  let exitCode: number;
  try {
    exitCode = withRuntime({
      load_context: () => {
        throw new TypeError("boom");
      },
    }, () => guard.main(["status", "--change", "demo-change"]));
  } finally {
    process.stdout.write = savedWrite;
  }
  assert.equal(exitCode, 2);
  const printed = JSON.parse(writes.join(""));
  assert.ok(codes(printed.block_reasons).includes("guard_internal_error"), JSON.stringify(printed.block_reasons));
});

withFixture("FIX-13 missing openspec CLI defenses", (fx) => {
  const savedPath = process.env.PATH;
  process.env.PATH = "";
  try {
    assert.ok(codes(guard.openspec_cli_capability_reasons()).includes("openspec_cli_unavailable"));
    const summary = project_init(fx.repo);
    assert.equal(summary.allowed, false);
    assert.ok(codes(summary.block_reasons).includes("project_init_failed"), JSON.stringify(summary.block_reasons));
    assert.match(String(summary.block_reasons[0].message), /OpenSpec CLI/);
  } finally {
    process.env.PATH = savedPath;
  }
});

withFixture("FIX-6 corrupt state suppresses supersede ledger recording", (fx) => {
  guard.ensure_sidecar_layout(fx.change);
  writeText(join(fx.change, ".superspec", "superspec-state.json"), "{not json\n");
  const ledgerBefore = existsSync(join(fx.change, ".superspec", "ledger.jsonl"))
    ? readFileSync(join(fx.change, ".superspec", "ledger.jsonl"), "utf8")
    : "";
  const evidences = [
    greenEvidence("TASK-001", "TEST-001", ["INV-001"], { evidence_id: "EV-old-green" }),
    passEvidence("task_complete", "superseded", {
      evidence_id: "EV-kill",
      status: "superseded",
      supersedes: "EV-old-green",
    }),
  ];
  withRuntime({ load_context: () => [status(fx), fx.repo, fx.change, evidences] }, () => {
    const [decision] = guard.dispatch({ command: "check-task-complete", change: "demo-change", task_id: "TASK-001" });
    assert.equal(decision.allowed, false);
    assert.ok(codes(decision.block_reasons).includes("state_corrupt"));
  });
  const ledgerAfter = existsSync(join(fx.change, ".superspec", "ledger.jsonl"))
    ? readFileSync(join(fx.change, ".superspec", "ledger.jsonl"), "utf8")
    : "";
  assert.equal(ledgerAfter, ledgerBefore);
});

withFixture("review ready blocks forged task reopen resolution without successor evidence", (fx) => {
  const guidance = [
    ...reopenGuidanceEvidences(fx),
    reviewEvidence(fx, "critic"),
  ];
  const evidences = [
    ...prepareProposeComplete(fx, { checked: true }),
    greenEvidence("TASK-001", "TEST-001", ["INV-001"], { evidence_id: "EV-old-green" }),
    ...guidance,
    mainAdjudication(fx, guidance, {
      review_decision: "request_changes",
      request_changes_route: "reopen_tasks",
      blocking_source_evidence_refs: ["EV-code-reviewer-guidance"],
      reopen_task_ids: ["TASK-001"],
      verification_evidence_refs: [],
    }),
    taskReopenEvidence(fx),
    taskReopenResolvedEvidence(fx, {
      successor_completion_evidence_ids: ["EV-forged-missing-successor"],
    }),
  ];
  withRuntime({ openspec_validate: () => [true, ""], dirty_worktree_reasons: () => [] }, () => {
    const decision = guard.check_review_ready("demo-change", status(fx), fx.change, evidences);
    assert.equal(decision.allowed, false);
    assert.ok(codes(decision.block_reasons).includes("task_reopen_resolved_invalid"));
    assert.ok(codes(decision.block_reasons).includes("missing_reopen_successor"));
  });
});

withFixture("review ready blocks resolved task_reopen when task was removed from tasks", (fx) => {
  const guidance = [
    ...reopenGuidanceEvidences(fx),
    reviewEvidence(fx, "critic"),
  ];
  const baseEvidences = prepareProposeComplete(fx, { checked: true });
  const reopen = taskReopenEvidence(fx, {
    invalidated_completion_evidence_ids: [],
    required_supersede_evidence_ids: [],
  });
  writeText(
    join(fx.change, "tasks.md"),
    "- [x] TASK-002 Replacement\n" +
      "  - invariant_refs: INV-001\n" +
      "  - test_refs: TEST-001\n",
  );
  const evidences = [
    ...baseEvidences,
    greenEvidence("TASK-002", "TEST-001", ["INV-001"], { evidence_id: "EV-task-002-green" }),
    ...guidance,
    mainAdjudication(fx, guidance, {
      review_decision: "request_changes",
      request_changes_route: "reopen_tasks",
      blocking_source_evidence_refs: ["EV-code-reviewer-guidance"],
      reopen_task_ids: ["TASK-001"],
      verification_evidence_refs: [],
    }),
    reopen,
    greenEvidence("TASK-001", "TEST-001", ["INV-001"], {
      evidence_id: "EV-green-successor",
      reopen_id: "reopen-001",
    }),
    taskReopenResolvedEvidence(fx),
  ];
  withRuntime({ openspec_validate: () => [true, ""], dirty_worktree_reasons: () => [] }, () => {
    const decision = guard.check_review_ready("demo-change", status(fx), fx.change, evidences);
    assert.equal(decision.allowed, false);
    assert.ok(codes(decision.block_reasons).includes("unknown_task"));
  });
});

withFixture("review ready rejects wrong-gate task reopen resolution", (fx) => {
  const guidance = [
    ...reopenGuidanceEvidences(fx),
    reviewEvidence(fx, "critic"),
  ];
  const evidences = [
    ...prepareProposeComplete(fx, { checked: true }),
    greenEvidence("TASK-001", "TEST-001", ["INV-001"], { evidence_id: "EV-old-green" }),
    supersededEvidence("EV-old-green"),
    ...guidance,
    mainAdjudication(fx, guidance, {
      review_decision: "request_changes",
      request_changes_route: "reopen_tasks",
      blocking_source_evidence_refs: ["EV-code-reviewer-guidance"],
      reopen_task_ids: ["TASK-001"],
      verification_evidence_refs: [],
    }),
    taskReopenEvidence(fx),
    greenEvidence("TASK-001", "TEST-001", ["INV-001"], {
      evidence_id: "EV-green-successor",
      reopen_id: "reopen-001",
    }),
    taskReopenResolvedEvidence(fx, {
      gate: "review_complete",
    }),
  ];
  withRuntime({ openspec_validate: () => [true, ""], dirty_worktree_reasons: () => [] }, () => {
    const decision = guard.check_review_ready("demo-change", status(fx), fx.change, evidences);
    assert.equal(decision.allowed, false);
    assert.ok(codes(decision.block_reasons).includes("unresolved_task_reopen"));
  });
});

withFixture("task complete rejects wrong-gate task reopen resolution", (fx) => {
  const guidance = [
    ...reopenGuidanceEvidences(fx),
    reviewEvidence(fx, "critic"),
  ];
  const evidences = [
    ...prepareProposeComplete(fx, { checked: true }),
    greenEvidence("TASK-001", "TEST-001", ["INV-001"], { evidence_id: "EV-old-green" }),
    supersededEvidence("EV-old-green"),
    ...guidance,
    mainAdjudication(fx, guidance, {
      review_decision: "request_changes",
      request_changes_route: "reopen_tasks",
      blocking_source_evidence_refs: ["EV-code-reviewer-guidance"],
      reopen_task_ids: ["TASK-001"],
      verification_evidence_refs: [],
    }),
    taskReopenEvidence(fx),
    greenEvidence("TASK-001", "TEST-001", ["INV-001"], {
      evidence_id: "EV-green-successor",
      reopen_id: "reopen-001",
    }),
    taskReopenResolvedEvidence(fx, {
      gate: "review_complete",
    }),
  ];
  const decision = guard.check_task_complete("demo-change", status(fx), fx.change, evidences, "TASK-001");
  assert.equal(decision.allowed, false);
  assert.ok(codes(decision.block_reasons).includes("unresolved_task_reopen"));
});

withFixture("review ready blocks task reopen resolution with mismatched reopen id", (fx) => {
  const guidance = [
    ...reopenGuidanceEvidences(fx),
    reviewEvidence(fx, "critic"),
  ];
  const evidences = [
    ...prepareProposeComplete(fx, { checked: true }),
    greenEvidence("TASK-001", "TEST-001", ["INV-001"], { evidence_id: "EV-old-green" }),
    supersededEvidence("EV-old-green"),
    ...guidance,
    mainAdjudication(fx, guidance, {
      review_decision: "request_changes",
      request_changes_route: "reopen_tasks",
      blocking_source_evidence_refs: ["EV-code-reviewer-guidance"],
      reopen_task_ids: ["TASK-001"],
      verification_evidence_refs: [],
    }),
    taskReopenEvidence(fx),
    greenEvidence("TASK-001", "TEST-001", ["INV-001"], {
      evidence_id: "EV-green-successor",
      reopen_id: "reopen-001",
    }),
    taskReopenResolvedEvidence(fx, {
      reopen_id: "wrong-reopen-id",
    }),
  ];
  withRuntime({ openspec_validate: () => [true, ""], dirty_worktree_reasons: () => [] }, () => {
    const decision = guard.check_review_ready("demo-change", status(fx), fx.change, evidences);
    assert.equal(decision.allowed, false);
    assert.ok(codes(decision.block_reasons).includes("task_reopen_resolved_invalid"));
    assert.ok(codes(decision.block_reasons).includes("unresolved_task_reopen"));
  });
});

withFixture("review ready blocks cross-task task reopen resolution from closing another task", (fx) => {
  const guidance = [
    ...reopenGuidanceEvidences(fx),
    reviewEvidence(fx, "critic"),
  ];
  const evidences = [
    ...prepareProposeComplete(fx, { checked: true }),
    greenEvidence("TASK-001", "TEST-001", ["INV-001"], { evidence_id: "EV-old-green" }),
    supersededEvidence("EV-old-green"),
    ...guidance,
    mainAdjudication(fx, guidance, {
      review_decision: "request_changes",
      request_changes_route: "reopen_tasks",
      blocking_source_evidence_refs: ["EV-code-reviewer-guidance"],
      reopen_task_ids: ["TASK-001"],
      verification_evidence_refs: [],
    }),
    taskReopenEvidence(fx),
    greenEvidence("TASK-001", "TEST-001", ["INV-001"], {
      evidence_id: "EV-green-successor",
      reopen_id: "reopen-001",
    }),
    taskReopenResolvedEvidence(fx, {
      task_id: "TASK-999",
    }),
  ];
  withRuntime({ openspec_validate: () => [true, ""], dirty_worktree_reasons: () => [] }, () => {
    const decision = guard.check_review_ready("demo-change", status(fx), fx.change, evidences);
    assert.equal(decision.allowed, false);
    assert.ok(codes(decision.block_reasons).includes("unresolved_task_reopen"));
  });
});

withFixture("review ready blocks multiple resolved task_reopen histories for same task", (fx) => {
  const guidance = [
    ...reopenGuidanceEvidences(fx),
    reviewEvidence(fx, "critic"),
  ];
  const evidences = [
    ...prepareProposeComplete(fx, { checked: true }),
    ...guidance,
    mainAdjudication(fx, guidance, {
      review_decision: "request_changes",
      request_changes_route: "reopen_tasks",
      blocking_source_evidence_refs: ["EV-code-reviewer-guidance"],
      reopen_task_ids: ["TASK-001"],
      verification_evidence_refs: [],
    }),
    taskReopenEvidence(fx, {
      evidence_id: "EV-task-reopen-1",
      reopen_id: "reopen-001",
      invalidated_completion_evidence_ids: [],
      required_supersede_evidence_ids: [],
    }),
    taskReopenEvidence(fx, {
      evidence_id: "EV-task-reopen-2",
      reopen_id: "reopen-002",
      invalidated_completion_evidence_ids: [],
      required_supersede_evidence_ids: [],
    }),
    greenEvidence("TASK-001", "TEST-001", ["INV-001"], {
      evidence_id: "EV-green-successor-1",
      reopen_id: "reopen-001",
    }),
    greenEvidence("TASK-001", "TEST-001", ["INV-001"], {
      evidence_id: "EV-green-successor-2",
      reopen_id: "reopen-002",
    }),
    taskReopenResolvedEvidence(fx, {
      evidence_id: "EV-task-reopen-resolved-1",
      reopen_evidence_id: "EV-task-reopen-1",
      reopen_id: "reopen-001",
      successor_completion_evidence_ids: ["EV-green-successor-1"],
    }),
    taskReopenResolvedEvidence(fx, {
      evidence_id: "EV-task-reopen-resolved-2",
      reopen_evidence_id: "EV-task-reopen-2",
      reopen_id: "reopen-002",
      successor_completion_evidence_ids: ["EV-green-successor-2"],
    }),
  ];
  withRuntime({ openspec_validate: () => [true, ""], dirty_worktree_reasons: () => [] }, () => {
    const decision = guard.check_review_ready("demo-change", status(fx), fx.change, evidences);
    assert.equal(decision.allowed, false);
    assert.ok(codes(decision.block_reasons).includes("reopen_lifecycle_exhausted"));
  });
});

withFixture("review ready allows task reopen resolution with bound successor evidence", (fx) => {
  const guidance = [
    ...reopenGuidanceEvidences(fx),
    reviewEvidence(fx, "critic"),
  ];
  const evidences = [
    ...prepareProposeComplete(fx, { checked: true }),
    greenEvidence("TASK-001", "TEST-001", ["INV-001"], { evidence_id: "EV-old-green" }),
    supersededEvidence("EV-old-green"),
    ...guidance,
    mainAdjudication(fx, guidance, {
      review_decision: "request_changes",
      request_changes_route: "reopen_tasks",
      blocking_source_evidence_refs: ["EV-code-reviewer-guidance"],
      reopen_task_ids: ["TASK-001"],
      verification_evidence_refs: [],
    }),
    taskReopenEvidence(fx),
    greenEvidence("TASK-001", "TEST-001", ["INV-001"], {
      evidence_id: "EV-green-successor",
      reopen_id: "reopen-001",
    }),
    taskReopenResolvedEvidence(fx),
  ];
  withRuntime({ openspec_validate: () => [true, ""], dirty_worktree_reasons: () => [] }, () => {
    const decision = guard.check_review_ready("demo-change", status(fx), fx.change, evidences);
    assert.equal(decision.allowed, true, JSON.stringify(decision));
  });
});

withFixture("review evidence requiring raw artifacts blocks when missing", (fx) => {
  const ev = reviewEvidence(fx, "critic", {
    requires_raw_artifact_refs: true,
  });
  delete ev.raw_artifact_refs;
  const problems = guard.validate_evidence_schema(ev, "demo-change", fx.change, fx.repo);
  assert.ok(codes(problems).includes("raw_artifact_refs_required"));
});

withFixture("dirty worktree unknown source blocks without human confirmation", (fx) => {
  withRuntime({ dirty_worktree_paths: () => ["unrelated.txt"] }, () => {
    const reasons = guard.dirty_worktree_reasons(fx.repo, fx.change, []);
    assert.deepEqual(codes(reasons), ["dirty_worktree_unattributed"]);
  });
});

withFixture("dirty worktree human confirmation allows attribution", (fx) => {
  withRuntime({ dirty_worktree_paths: () => ["unrelated.txt"] }, () => {
    const reasons = guard.dirty_worktree_reasons(fx.repo, fx.change, [passEvidence("branch_handling", "human_confirmation", { confirmed_paths: ["unrelated.txt"] })]);
    assert.deepEqual(reasons, []);
  });
});

withFixture("A-3 human_confirmation only waives its declared paths", (fx) => {
  withRuntime({ dirty_worktree_paths: () => ["unrelated-a.txt", "unrelated-b.txt"] }, () => {
    const reasons = guard.dirty_worktree_reasons(fx.repo, fx.change, [passEvidence("branch_handling", "human_confirmation", { confirmed_paths: ["unrelated-a.txt"] })]);
    assert.deepEqual(codes(reasons), ["dirty_worktree_unattributed"]);
    assert.deepEqual(reasons[0].refs, []);
    assert.ok(reasons[0].message.includes("unrelated-b.txt"));
  });
});

withFixture("dirty worktree parses porcelain z paths with spaces", (fx) => {
  writeText(join(fx.repo, "unrelated file.txt"), "dirty\n");
  assert.ok(guard.dirty_worktree_paths(fx.repo).includes("unrelated file.txt"));
});

withFixture("dirty worktree expands rename source paths for write scope checks", (fx) => {
  writeText(join(fx.repo, "src", "old.txt"), "old\n");
  assert.equal(spawnSync("git", ["add", "src/old.txt"], { cwd: fx.repo }).status, 0);
  assert.equal(spawnSync("git", ["-c", "user.name=Test", "-c", "user.email=test@example.com", "commit", "-m", "base"], { cwd: fx.repo, stdio: "ignore" }).status, 0);
  mkdirp(join(fx.repo, "dst"));
  assert.equal(spawnSync("git", ["mv", "src/old.txt", "dst/new name.txt"], { cwd: fx.repo }).status, 0);

  const dirty = guard.dirty_worktree_paths(fx.repo);
  assert.ok(dirty.includes("src/old.txt"));
  assert.ok(dirty.includes("dst/new name.txt"));

  const tasks = {
    "TASK-001": {
      task_id: "TASK-001",
      checked: false,
      desc: "Implement",
      attrs: { write_scope: "src" },
    },
  };
  assert.ok(codes(guard.dirty_write_scope_red_reasons(fx.repo, tasks, [])).includes("missing_red_evidence"));

  const attributionReasons = guard.dirty_worktree_reasons(
    fx.repo,
    fx.change,
    [passEvidence("branch_handling", "human_confirmation", { confirmed_paths: ["dst"] })],
  );
  assert.deepEqual(codes(attributionReasons), ["dirty_worktree_unattributed"]);
  assert.ok(attributionReasons[0].message.includes("src/old.txt"));
});

withFixture("workflow dirty write scope inspection fails closed", (fx) => {
  const tasks = {
    "TASK-001": {
      task_id: "TASK-001",
      checked: false,
      desc: "Implement",
      attrs: { write_scope: "src" },
    },
  };
  withRuntime({ dirty_worktree_paths: () => { throw new Error("git unavailable"); } }, () => {
    const reasons = guard.dirty_write_scope_red_reasons(fx.repo, tasks, []);
    assert.deepEqual(codes(reasons), ["dirty_worktree_unavailable"]);
  });
});

withFixture("review ready dirty worktree inspection fails closed", (fx) => {
  withRuntime({
    dirty_worktree_paths: () => { throw new Error("git unavailable"); },
    openspec_validate: () => [true, ""],
  }, () => {
    const decision = guard.check_review_ready("demo-change", status(fx), fx.change, []);
    assert.equal(decision.allowed, false);
    assert.ok(codes(decision.block_reasons).includes("dirty_worktree_unavailable"));
  });
});

withFixture("A-7 review_complete rejects duplicate output_ref", (fx) => {
  const sharedOutput = ".superspec/reports/shared-review.md";
  const guidance = [
    reviewEvidence(fx, "code-reviewer", { output_ref: sharedOutput }),
    reviewEvidence(fx, "architect", { output_ref: sharedOutput }),
    reviewEvidence(fx, "critic"),
  ];
  const evidences = [
    ...prepareProposeComplete(fx, { checked: true }),
    greenEvidence(),
    ...guidance,
    mainAdjudication(fx, guidance),
    verifyEvidence(fx, "verifier"),
    verifyEvidence(fx, "critic"),
    finalTestEvidence(fx),
  ];
  withRuntime({ openspec_validate: () => [true, ""], dirty_worktree_reasons: () => [] }, () => {
    const decision = guard.check_review_complete("demo-change", status(fx), fx.change, evidences);
    assert.equal(decision.allowed, false);
    assert.ok(codes(decision.block_reasons).includes("evidence_output_ref_duplicate"));
  });
});

withFixture("A-7 review_complete rejects path-aliased duplicate output_ref", (fx) => {
  const guidance = [
    reviewEvidence(fx, "code-reviewer", { output_ref: ".superspec/reports/shared-review.md" }),
    reviewEvidence(fx, "architect", { output_ref: ".superspec/reports/./shared-review.md" }),
    reviewEvidence(fx, "critic"),
  ];
  const evidences = [
    ...prepareProposeComplete(fx, { checked: true }),
    greenEvidence(),
    ...guidance,
    mainAdjudication(fx, guidance),
    verifyEvidence(fx, "verifier"),
    verifyEvidence(fx, "critic"),
    finalTestEvidence(fx),
  ];
  withRuntime({ openspec_validate: () => [true, ""], dirty_worktree_reasons: () => [] }, () => {
    const decision = guard.check_review_complete("demo-change", status(fx), fx.change, evidences);
    assert.equal(decision.allowed, false);
    assert.ok(codes(decision.block_reasons).includes("evidence_output_ref_duplicate"));
  });
});

withFixture("check verify ready compatibility alias recomputes review gate", (fx) => {
  writeText(join(fx.change, "tasks.md"), "- [x] TASK-001 Implement\n  - test_refs: TEST-001\n");
  const evidences = [
    passEvidence("review_complete"),
    verifyEvidence(fx, "verifier"),
    verifyEvidence(fx, "critic"),
    finalTestEvidence(fx),
  ];
  withRuntime({ openspec_validate: () => [true, ""], dirty_worktree_reasons: () => [] }, () => {
    const decision = guard.check_verify_complete("demo-change", status(fx), fx.change, evidences);
    assert.equal(decision.allowed, false);
    assert.equal(decision.gate, "review_complete");
    assert.ok(codes(decision.block_reasons).includes("missing_source_guidance"));
  });
});

withFixture("archive ready blocks when openspec validate fails", (fx) => {
  writeText(join(fx.change, "tasks.md"), "- [x] TASK-001 Implement\n  - test_refs: TEST-001\n");
  const guidance = [
    ...reviewGuidanceEvidences(fx),
    reviewEvidence(fx, "critic"),
  ];
  const evidences = [
    ...prepareProposeComplete(fx, { checked: true }),
    greenEvidence(),
    ...guidance,
    mainAdjudication(fx, guidance),
    verifyEvidence(fx, "verifier"),
    verifyEvidence(fx, "critic"),
    finalTestEvidence(fx),
    passEvidence("archive_ready", "human_confirmation"),
  ];
  withRuntime({ openspec_validate: () => [false, "invalid"], dirty_worktree_reasons: () => [] }, () => {
    const decision = guard.check_archive_ready("demo-change", status(fx), fx.change, evidences);
    assert.equal(decision.allowed, false);
    assert.ok(codes(decision.block_reasons).includes("validate_failed"));
  });
});

withFixture("dispatch clamps blocked route to openspec floor", (fx) => {
  const blockedStatus = status(fx, { specs: "blocked", design: "blocked", tasks: "blocked" });
  withRuntime({
    load_context: () => [blockedStatus, fx.repo, fx.change, []],
    openspec_validate: () => [true, ""],
    dirty_worktree_reasons: () => [],
  }, () => {
    const [decision] = guard.dispatch({ command: "check-review-ready", change: "demo-change" });
    const state = readJson(join(fx.change, ".superspec", "superspec-state.json"));
    assert.equal(decision.allowed, false);
    assert.equal(state.superspec.guard_route_phase, "init");
    assert.equal(state.superspec.requested_route_phase, "review");
  });
});

withFixture("state recompute after delete", (fx) => {
  const currentStatus = status(fx);
  const decision = guard.allow("demo-change", "recompute");
  guard.recompute_and_write_state("demo-change", fx.change, currentStatus, "tasks", "recompute", decision);
  rmSync(join(fx.change, ".superspec", "superspec-state.json"));
  guard.recompute_and_write_state("demo-change", fx.change, currentStatus, "tasks", "recompute", decision);
  assert.equal(statSync(join(fx.change, ".superspec", "superspec-state.json")).isFile(), true);
});

withFixture("dispatch recompute writes state", (fx) => {
  withRuntime({ load_context: () => [status(fx), fx.repo, fx.change, []] }, () => {
    const [decision] = guard.dispatch({ command: "recompute", change: "demo-change" });
    assert.equal(decision.allowed, true, JSON.stringify(decision));
    assert.equal(statSync(join(fx.change, ".superspec", "superspec-state.json")).isFile(), true);
  });
});
