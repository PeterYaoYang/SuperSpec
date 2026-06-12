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

withFixture("sidecar layout creates required v1 directories", (fx) => {
  guard.ensure_sidecar_layout(fx.change);
  const base = join(fx.change, ".superspec");
  assert.equal(statSync(join(base, "ledger.jsonl")).isFile(), true);
  for (const rel of guard.REQUIRED_SIDECAR_DIRS) {
    assert.equal(statSync(join(base, rel)).isDirectory(), true, rel);
  }
  assert.equal(statSync(join(base, "handoffs")).isDirectory(), true);
  assert.equal(statSync(join(base, "reports")).isDirectory(), true);
  assert.equal(statSync(join(base, "raw")).isDirectory(), true);
});

withFixture("state filename is superspec-state", (fx) => {
  guard.write_state_atomic(fx.change, {
    schema_version: 1,
    change_id: "demo-change",
    guard_version: "test",
  });
  const base = join(fx.change, ".superspec");
  assert.equal(statSync(join(base, "superspec-state.json")).isFile(), true);
  assert.equal(existsSync(join(base, "state.json")), false);
  assert.equal(existsSync(join(base, "state.lock")), false);
  assert.equal(readJson(join(base, "superspec-state.json")).change_id, "demo-change");
});

withFixture("state write CAS blocks on fingerprint mismatch", (fx) => {
  const initial = { schema_version: 1, change_id: "demo-change", computed_from: { openspec_status_fingerprint: "sha256:old" } };
  const replacement = { schema_version: 1, change_id: "demo-change", computed_from: { openspec_status_fingerprint: "sha256:new" } };
  guard.write_state_atomic(fx.change, initial);
  assert.throws(() => guard.write_state_atomic(fx.change, replacement, {
    expected_state_fingerprints: { openspec_status_fingerprint: "sha256:other" },
  }), guard.GuardError);
  assert.equal(readJson(join(fx.change, ".superspec", "superspec-state.json")).computed_from.openspec_status_fingerprint, "sha256:old");
});

withFixture("ledger and state written atomically", (fx) => {
  const initial = { schema_version: 1, change_id: "demo-change", computed_from: { openspec_status_fingerprint: "sha256:old" } };
  const replacement = { schema_version: 1, change_id: "demo-change", computed_from: { openspec_status_fingerprint: "sha256:new" } };
  guard.write_state_atomic(fx.change, initial);
  const ledger = join(fx.change, ".superspec", "ledger.jsonl");
  const beforeLedger = readFileSync(ledger, "utf8");
  assert.throws(() => guard.write_state_atomic(fx.change, replacement, {
    expected_state_fingerprints: { openspec_status_fingerprint: "sha256:other" },
    ledger_event: { change_id: "demo-change", kind: "guard_decision", gate: "x", decision: "allow" },
  }), guard.GuardError);
  assert.equal(readFileSync(ledger, "utf8"), beforeLedger);
  assert.equal(readJson(join(fx.change, ".superspec", "superspec-state.json")).computed_from.openspec_status_fingerprint, "sha256:old");
});

withFixture("project config is optional and uses defaults", (fx) => {
  const [config, problems] = guard.load_config(fx.repo, fx.change);
  assert.deepEqual(problems, []);
  assert.equal(config.preset, "full");
  assert.equal(config.trust.v1_evidence, "audit-only");
});

withFixture("change config overrides project config", (fx) => {
  writeText(join(fx.repo, ".superspec", "config.yaml"), "preset: hotfix\ncommands:\n  test: project-test\n");
  writeText(join(fx.change, ".superspec", "config.yaml"), "preset: tweak\ncommands:\n  test: change-test\n");
  const [config, problems] = guard.load_config(fx.repo, fx.change);
  assert.deepEqual(problems, []);
  assert.equal(config.preset, "tweak");
  assert.equal(config.commands.test, "change-test");
});

withFixture("unknown config key blocks unless x namespace", (fx) => {
  writeText(join(fx.change, ".superspec", "config.yaml"), "unknown: value\nx-local: allowed\n");
  const [, problems] = guard.load_config(fx.repo, fx.change);
  assert.deepEqual(codes(problems), ["unknown_config_key"]);
});

withFixture("config and state aliases are rejected", (fx) => {
  writeText(join(fx.repo, ".superspec.yaml"), "preset: full\n");
  writeText(join(fx.change, ".superspec", "config.json"), "{}\n");
  writeText(join(fx.change, ".superspec", "state.json"), "{}\n");
  const [, problems] = guard.load_config(fx.repo, fx.change);
  assert.deepEqual(codes(problems), ["forbidden_alias_path", "forbidden_alias_path", "forbidden_alias_path"]);
});

withFixture("safe_within rejects absolute parent and symlink escape", (fx) => {
  const outside = join(fx.repo, "outside");
  mkdirp(outside);
  const sidecar = join(fx.change, ".superspec");
  mkdirp(sidecar);
  symlinkSync(outside, join(sidecar, "escape"), "dir");
  assert.equal(guard.safe_within(fx.change, "/tmp/x"), null);
  assert.equal(guard.safe_within(fx.change, "../x"), null);
  assert.equal(guard.safe_within(fx.change, ".superspec/escape/file.txt"), null);
});

withFixture("evidence index skips symlinked and hardlinked evidence entries", (fx) => {
  const outside = join(fx.tmp, "outside-evidence");
  mkdirp(outside);
  writeText(join(outside, "EV-external.json"), `${JSON.stringify(passEvidence("design_complete"), null, 2)}\n`);
  writeText(join(outside, "EV-hardlink.json"), `${JSON.stringify(passEvidence("design_complete", "review", { evidence_id: "EV-hardlink" }), null, 2)}\n`);
  mkdirp(join(fx.change, ".superspec", "evidence"));
  symlinkSync(outside, join(fx.change, ".superspec", "evidence", "design"), "dir");
  mkdirp(join(fx.change, ".superspec", "evidence", "reviews"));
  linkSync(join(outside, "EV-hardlink.json"), join(fx.change, ".superspec", "evidence", "reviews", "EV-hardlink.json"));
  const direct = passEvidence("explore_complete", "review", { evidence_id: "EV-direct" });
  writeText(join(fx.change, ".superspec", "evidence", "discovery", "EV-direct.json"), `${JSON.stringify(direct, null, 2)}\n`);

  const indexed = guard.index_evidence(fx.change);
  assert.deepEqual(indexed.map((item: JsonMap) => item.evidence_id).sort(), ["EV-direct"]);
});

withFixture("archive preservation skips symlinked and hardlinked sidecar files", (fx) => {
  guard.ensure_sidecar_layout(fx.change);
  const outside = join(fx.tmp, "external-raw.log");
  const outsideHardlink = join(fx.tmp, "external-hardlink.log");
  writeText(outside, "external raw\n");
  writeText(outsideHardlink, "external hardlink raw\n");
  symlinkSync(outside, join(fx.change, ".superspec", "raw", "external.log"));
  linkSync(outsideHardlink, join(fx.change, ".superspec", "raw", "external-hardlink.log"));
  writeText(join(fx.change, ".superspec", "raw", "local.log"), "local raw\n");

  const manifestEntries = guard.sidecar_manifest_entries(fx.change).map((entry: JsonMap) => entry.path);
  assert.ok(manifestEntries.includes(".superspec/raw/local.log"));
  assert.ok(!manifestEntries.includes(".superspec/raw/external.log"));
  assert.ok(!manifestEntries.includes(".superspec/raw/external-hardlink.log"));

  guard.write_archive_preservation_bundle("demo-change", fx.change);
  const bundleManifest = readJson(join(fx.change, "superspec-preservation", "manifest.json"));
  const bundleEntries = bundleManifest.entries.map((entry: JsonMap) => entry.path);
  assert.ok(bundleEntries.includes(".superspec/raw/local.log"));
  assert.ok(!bundleEntries.includes(".superspec/raw/external.log"));
  assert.ok(!bundleEntries.includes(".superspec/raw/external-hardlink.log"));
  assert.equal(existsSync(join(fx.change, "superspec-preservation", "files", ".superspec", "raw", "external.log")), false);
  assert.equal(existsSync(join(fx.change, "superspec-preservation", "files", ".superspec", "raw", "external-hardlink.log")), false);
});

test("command surface includes check-archived", () => {
  const args = guard.parse_argv(["check-archived", "--change", "demo-change"]);
  assert.equal(args.command, "check-archived");
  assert.equal(args.change, "demo-change");
});

test("command surface includes init and apply-ready", () => {
  const init = guard.parse_argv(["init", "--change", "demo-change", "--create"]);
  assert.equal(init.command, "init");
  assert.equal(init.create, true);
  assert.equal(guard.parse_argv(["check-init", "--change", "demo-change"]).command, "check-init");
  assert.equal(guard.parse_argv(["check-apply-ready", "--change", "demo-change"]).command, "check-apply-ready");
});

test("command surface accepts safe output formats", () => {
  assert.equal(guard.parse_argv(["check-init", "--change", "demo-change", "--format", "agent"]).format, "agent");
  assert.equal(guard.parse_argv(["check-init", "--change", "demo-change", "--format", "user"]).format, "user");
  assert.equal(guard.parse_argv(["check-init", "--change", "demo-change", "--user-facing"]).format, "user");
  assert.equal(guard.parse_argv(["check-init", "--change", "demo-change"]).format, "json");
  assert.throws(
    () => guard.parse_argv(["check-init", "--change", "demo-change", "--format", "raw"]),
    /--format 只允许 json、agent 或 user/u,
  );
  assert.throws(
    () => guard.parse_argv(["check-init", "--change", "demo-change", "--format"]),
    /--format 缺少取值/u,
  );
  assert.throws(
    () => guard.parse_argv(["check-init", "--change", "demo-change", "--format", "--user-facing"]),
    /--format 缺少取值/u,
  );
  assert.throws(
    () => guard.parse_argv(["check-init", "--change", "demo-change", "--format", "agent", "--format"]),
    /--format 缺少取值/u,
  );
  assert.throws(
    () => guard.parse_argv(["check-init", "--change", "demo-change", "--format", "raw", "--user-facing"]),
    /--format 只允许 json、agent 或 user/u,
  );
});

test("command surface keeps check-verify-ready compatibility alias", () => {
  assert.equal(guard.parse_argv(["check-verify-ready", "--change", "demo-change"]).command, "check-verify-ready");
});

test("packet command surface parses dedicated packet commands", () => {
  const workflow = guard.parse_argv(["workflow-packet", "--change", "demo-change", "--gate", "explore_complete", "--format", "agent"]);
  assert.equal(workflow.command, "workflow-packet");
  assert.equal(workflow.gate, "explore_complete");
  assert.equal(workflow.packet_format, "agent");

  const review = guard.parse_argv([
    "review-packet",
    "--change", "demo-change",
    "--gate", "proposal_reviewed",
    "--role", "critic",
    "--round", "2",
    "--format", "prompt",
  ]);
  assert.equal(review.command, "review-packet");
  assert.equal(review.role, "critic");
  assert.equal(review.round, 2);
  assert.equal(review.packet_format, "prompt");
  const verificationReview = guard.parse_argv([
    "review-packet",
    "--change", "demo-change",
    "--gate", "review_complete",
    "--role", "critic",
    "--round", "1",
    "--kind", "verification_review",
    "--format", "prompt",
  ]);
  assert.equal(verificationReview.evidence_kind, "verification_review");

  const ledger = guard.parse_argv(["ledger-render", "--change", "demo-change", "--gate", "proposal_reviewed", "--round", "2"]);
  assert.equal(ledger.command, "ledger-render");
  assert.equal(ledger.gate, "proposal_reviewed");
  assert.equal(ledger.round, 2);

  const redPacket = guard.parse_argv([
    "apply-test-packet",
    "--change", "demo-change",
    "--task-id", "TASK-001",
    "--test-id", "TEST-001",
    "--phase", "red",
    "--format", "prompt",
  ]);
  assert.equal(redPacket.command, "apply-test-packet");
  assert.equal(redPacket.task_id, "TASK-001");
  assert.equal(redPacket.test_id, "TEST-001");
  assert.equal(redPacket.phase, "red");
  assert.equal(redPacket.packet_format, "prompt");

  const greenPacket = guard.parse_argv([
    "apply-test-packet",
    "--change", "demo-change",
    "--task-id", "TASK-001",
    "--test-id", "TEST-001",
    "--phase", "green",
    "--task-code-review-report-ref", ".superspec/reports/apply/TASK-001/code-review.json",
    "--format", "agent",
  ]);
  assert.equal(greenPacket.command, "apply-test-packet");
  assert.equal(greenPacket.task_code_review_report_refs?.[0], ".superspec/reports/apply/TASK-001/code-review.json");

  const verifyPacket = guard.parse_argv([
    "apply-verify-packet",
    "--change", "demo-change",
    "--task-id", "TASK-001",
    "--executor-report-ref", ".superspec/reports/apply/TASK-001/executor.json",
    "--task-code-review-report-ref", ".superspec/reports/apply/TASK-001/code-review.json",
    "--green-test-run-evidence-ref", "EV-green-1",
    "--green-test-run-evidence-ref", "EV-green-2",
    "--red-test-run-evidence-ref", "EV-red",
    "--format", "agent",
  ]);
  assert.equal(verifyPacket.command, "apply-verify-packet");
  assert.deepEqual(verifyPacket.green_test_run_evidence_refs, ["EV-green-1", "EV-green-2"]);
});

test("packet command surface validates packet formats and task-scoped requirements", () => {
  assert.throws(
    () => guard.parse_argv(["workflow-packet", "--change", "demo-change", "--gate", "explore_complete", "--format", "prompt"]),
    /--format 只允许 agent/u,
  );
  assert.throws(
    () => guard.parse_argv([
      "workflow-packet",
      "--change", "demo-change",
      "--gate", "explore_complete",
      "--format", "agent",
      "--format", "prompt",
    ]),
    /--format 只允许 agent/u,
  );
  assert.throws(
    () => guard.parse_argv(["review-packet", "--change", "demo-change", "--gate", "proposal_reviewed", "--role", "critic", "--round", "1", "--format", "json"]),
    /--format 只允许 agent 或 prompt/u,
  );
  assert.throws(
    () => guard.parse_argv([
      "review-packet",
      "--change", "demo-change",
      "--gate", "proposal_reviewed",
      "--role", "critic",
      "--round", "1",
      "--format", "agent",
      "--format", "json",
    ]),
    /--format 只允许 agent 或 prompt/u,
  );
  assert.throws(
    () => guard.parse_argv(["workflow-packet", "--change", "demo-change", "--gate", "task_edit", "--format", "agent"]),
    /workflow-packet 缺少必填参数 --task-id/u,
  );
  assert.throws(
    () => guard.parse_argv(["ledger-render", "--change", "demo-change", "--gate", "proposal_reviewed", "--round", "0"]),
    /--round 必须是大于等于 1 的整数/u,
  );
  assert.throws(
    () => guard.parse_argv(["apply-test-packet", "--change", "demo-change", "--task-id", "TASK-001", "--test-id", "TEST-001", "--phase", "blue", "--format", "agent"]),
    /--phase 只允许 red、characterization 或 green/u,
  );
  assert.throws(
    () => guard.parse_argv(["apply-executor-packet", "--change", "demo-change", "--format", "agent"]),
    /apply-executor-packet 缺少必填参数 --task-id/u,
  );
  assert.throws(
    () => guard.parse_argv(["review-packet", "--change", "demo-change", "--gate", "review_complete", "--role", "critic", "--round", "1", "--kind", "final", "--format", "agent"]),
    /--kind 只允许 source_guidance 或 verification_review/u,
  );
});

test("A-2 command surface accepts recompute force-unlock", () => {
  const args = guard.parse_argv(["recompute", "--change", "demo-change", "--force-unlock"]);
  assert.equal(args.command, "recompute");
  assert.equal(args.force_unlock, true);
});

withFixture("apply_worker_chain active marker blocks non-chain task completion", (fx) => {
  const evidences = [
    ...prepareProposeComplete(fx),
    greenEvidence("TASK-001", "TEST-001", ["INV-001"], {
      runner_origin: "main-thread",
    }),
    passEvidence("task_complete", "apply_worker_chain", {
      evidence_id: "EV-chain-active",
      task_id: "TASK-001",
      apply_worker_chain_id: "CHAIN-001",
      chain_state: "active",
      executor_packet_fingerprint: "sha256:executor-packet",
      source_implementation_fingerprint: { fingerprint_digest: "sha256:source" },
      declared_task_write_scope: ["src/feature.ts"],
      pre_edit_evidence_refs: ["EV-red"],
    }),
    supersededEvidence("EV-chain-active"),
  ];
  const decision = guard.check_task_complete("demo-change", status(fx), fx.change, evidences, "TASK-001");
  assert.equal(decision.allowed, false);
  assert.ok(codes(decision.block_reasons).includes("apply_worker_chain_active"), JSON.stringify(decision.block_reasons));
});

withFixture("apply_worker_chain schema rejects malformed lifecycle fields", (fx) => {
  const malformed = passEvidence("task_complete", "apply_worker_chain", {
    evidence_id: "EV-chain-malformed",
    task_id: "TASK-001",
    apply_worker_chain_id: "CHAIN-001",
    chain_state: "active",
    executor_packet_fingerprint: {},
    source_implementation_fingerprint: null,
    declared_task_write_scope: [{}],
    pre_edit_evidence_refs: [{}],
  });
  const problems = guard.validate_evidence_schema(malformed, "demo-change", fx.change, fx.repo);
  assert.ok(codes(problems).includes("apply_worker_chain_invalid"), JSON.stringify(problems));
});

withFixture("test_run runner_origin test-runner requires pinned worker refs without breaking legacy logs", (fx) => {
  const legacy = greenEvidence("TASK-001", "TEST-001", ["INV-001"]);
  assert.equal(codes(guard.validate_evidence_schema(legacy, "demo-change", fx.change, fx.repo)).includes("test_run_worker_ref_missing"), false);

  const workerRun = greenEvidence("TASK-001", "TEST-001", ["INV-001"], {
    evidence_id: "EV-green-worker",
    runner_origin: "test-runner",
  });
  const problems = guard.validate_evidence_schema(workerRun, "demo-change", fx.change, fx.repo);
  assert.ok(codes(problems).includes("test_run_worker_ref_missing"), JSON.stringify(problems));
  assert.ok(codes(problems).includes("test_run_runner_origin_invalid"), JSON.stringify(problems));

  const nonChainWorkerGreen = greenEvidence("TASK-001", "TEST-001", ["INV-001"], {
    evidence_id: "EV-green-worker-non-chain",
    runner_origin: "test-runner",
    phase: "green",
  });
  const nonChainWorkerGreenProblems = guard.validate_evidence_schema(nonChainWorkerGreen, "demo-change", fx.change, fx.repo);
  assert.ok(codes(nonChainWorkerGreenProblems).includes("test_run_runner_origin_invalid"), JSON.stringify(nonChainWorkerGreenProblems));

  const completionDecision = guard.check_task_complete("demo-change", status(fx), fx.change, [
    ...prepareProposeComplete(fx),
    nonChainWorkerGreen,
  ], "TASK-001");
  assert.equal(completionDecision.allowed, false);
  assert.ok(codes(completionDecision.block_reasons).includes("missing_green_evidence"), JSON.stringify(completionDecision.block_reasons));

  const executorWorkerRun = greenEvidence("TASK-001", "TEST-001", ["INV-001"], {
    evidence_id: "EV-green-executor-worker",
    apply_execution_chain: "executor_worker",
    apply_worker_chain_id: "CHAIN-001",
  });
  const executorProblems = guard.validate_evidence_schema(executorWorkerRun, "demo-change", fx.change, fx.repo);
  assert.ok(codes(executorProblems).includes("test_run_runner_origin_invalid"), JSON.stringify(executorProblems));
  assert.ok(codes(executorProblems).includes("test_run_worker_ref_missing"), JSON.stringify(executorProblems));
});

withFixture("apply worker artifact materializer writes typed refs and rejects unsafe inputs", (fx) => {
  const sourceFingerprint = { fingerprint_digest: "sha256:source" };
  const producedFingerprint = { fingerprint_digest: "sha256:produced" };
  const executorReport = {
    role: "executor",
    task_id: "TASK-001",
    apply_worker_chain_id: "CHAIN-001",
    guard_fingerprint: "sha256:executor-packet",
    origin_packet_fingerprint: "sha256:executor-packet",
    source_implementation_fingerprint: sourceFingerprint,
    produced_implementation_fingerprint: producedFingerprint,
    input_ref_digest: "sha256:input",
    cwd: fx.repo,
    repo_head: "unknown",
    changed_files: ["src/feature.ts"],
    suggested_green_checks: ["TEST-001"],
    test_invariant_mapping: { "TEST-001": ["INV-001"] },
    runtime_artifact_refs: ["runtime://executor/report"],
    risk_notes: [],
    unverified_items: [],
  };
  const executorRef = guard.materialize_apply_worker_artifact_ref(fx.change, {
    taskId: "TASK-001",
    kind: "worker_report",
    role: "executor",
    filename: "executor-report.json",
    content: executorReport,
    workerChainContext: "executor_worker",
    applyWorkerChainId: "CHAIN-001",
    originPacketFingerprint: "sha256:executor-packet",
    sourceImplementationFingerprint: sourceFingerprint,
    producedImplementationFingerprint: producedFingerprint,
    inputRefDigest: "sha256:input",
  });
  assert.equal(executorRef.path, ".superspec/reports/apply/TASK-001/executor-report.json");
  assert.equal(executorRef.ref_path, ".superspec/reports/apply/TASK-001/executor-report.ref.json");
  assert.equal(existsSync(join(fx.change, executorRef.path)), true);
  assert.equal(existsSync(join(fx.change, executorRef.ref_path)), true);
  assert.deepEqual(
    guard.pinned_artifact_ref_reasons(fx.change, executorRef, "executor_report_ref", {
      kind: "worker_report",
      role: "executor",
      taskId: "TASK-001",
      chainId: "CHAIN-001",
    }),
    [],
  );
  const incompleteExecutorRef = guard.materialize_apply_worker_artifact_ref(fx.change, {
    taskId: "TASK-001",
    kind: "worker_report",
    role: "executor",
    filename: "executor-report-incomplete.json",
    content: { ...executorReport, changed_files: undefined },
    workerChainContext: "executor_worker",
    applyWorkerChainId: "CHAIN-001",
    originPacketFingerprint: "sha256:executor-packet",
    sourceImplementationFingerprint: sourceFingerprint,
    producedImplementationFingerprint: producedFingerprint,
    inputRefDigest: "sha256:input",
  });
  const incompleteProblems = guard.pinned_artifact_ref_reasons(fx.change, incompleteExecutorRef, "executor_report_ref", {
    kind: "worker_report",
    role: "executor",
    taskId: "TASK-001",
    chainId: "CHAIN-001",
  });
  assert.ok(incompleteProblems.some((item) => item.code === "pinned_artifact_ref_invalid" && item.message.includes("changed_files")), JSON.stringify(incompleteProblems));

  assert.throws(() => guard.materialize_apply_worker_artifact_ref(fx.change, {
    taskId: "TASK-001",
    kind: "worker_report",
    role: "executor",
    filename: "executor-report-invalid-refpath.json",
    content: executorReport,
    refPath: ".superspec/evidence/TASK-001/executor-report.ref.json",
    workerChainContext: "executor_worker",
    applyWorkerChainId: "CHAIN-001",
    originPacketFingerprint: "sha256:executor-packet",
    sourceImplementationFingerprint: sourceFingerprint,
    producedImplementationFingerprint: producedFingerprint,
    inputRefDigest: "sha256:input",
  }), /refPath must stay under/u);
  assert.equal(existsSync(join(fx.change, ".superspec/reports/apply/TASK-001/executor-report-invalid-refpath.json")), false);

  const rawRef = guard.materialize_apply_worker_artifact_ref(fx.change, {
    taskId: "TASK-001",
    kind: "raw_transcript",
    role: "test-runner",
    filename: "test-runner.log",
    content: "TEST-001 passed\n",
    workerChainContext: "none",
    originPacketFingerprint: "sha256:test-packet",
    sourceImplementationFingerprint: sourceFingerprint,
    observedImplementationFingerprint: { fingerprint_digest: "sha256:observed" },
    inputRefDigest: "sha256:raw-input",
    command: "npm test -- TEST-001",
    cwd: fx.repo,
    phase: "green",
    testId: "TEST-001",
    exitCode: 0,
  });
  assert.deepEqual(
    guard.pinned_artifact_ref_reasons(fx.change, rawRef, "raw_log_pinned_refs", {
      kind: "raw_transcript",
      role: "test-runner",
      taskId: "TASK-001",
    }),
    [],
  );
  const minimalRawRef = {
    root: "change",
    path: rawRef.path,
    blob_sha: rawRef.blob_sha,
    size_bytes: rawRef.size_bytes,
    kind: "raw_transcript",
    role: "test-runner",
    task_id: "TASK-001",
    command: rawRef.command,
    cwd: rawRef.cwd,
    phase: rawRef.phase,
    test_id: rawRef.test_id,
    exit_code: rawRef.exit_code,
  };
  const minimalRawProblems = guard.pinned_artifact_ref_reasons(fx.change, minimalRawRef, "raw_log_pinned_refs", {
    kind: "raw_transcript",
    role: "test-runner",
    taskId: "TASK-001",
  });
  assert.ok(minimalRawProblems.some((item) => item.message.includes("created_at")), JSON.stringify(minimalRawProblems));
  assert.ok(minimalRawProblems.some((item) => item.message.includes("origin_packet_fingerprint")), JSON.stringify(minimalRawProblems));
  assert.ok(minimalRawProblems.some((item) => item.message.includes("input_ref_digest")), JSON.stringify(minimalRawProblems));
  assert.ok(minimalRawProblems.some((item) => item.message.includes("source_implementation_fingerprint")), JSON.stringify(minimalRawProblems));
  assert.ok(minimalRawProblems.some((item) => item.message.includes("observed_implementation_fingerprint")), JSON.stringify(minimalRawProblems));

  assert.throws(
    () => guard.materialize_apply_worker_artifact_ref(fx.change, {
      taskId: "TASK-001",
      kind: "raw_transcript",
      role: "test-runner",
      filename: "test-runner-command-override.log",
      content: "TEST-001 passed\n",
      workerChainContext: "none",
      originPacketFingerprint: "sha256:test-packet",
      sourceImplementationFingerprint: sourceFingerprint,
      observedImplementationFingerprint: { fingerprint_digest: "sha256:observed" },
      inputRefDigest: "sha256:raw-input",
      command: "npm test -- TEST-001",
      cwd: fx.repo,
      phase: "green",
      testId: "TEST-001",
      exitCode: 0,
      metadata: { command: "forged command" },
    }),
    /metadata must not override command/u,
  );
  assert.equal(existsSync(join(fx.change, ".superspec/raw/apply/TASK-001/test-runner-command-override.log")), false);
  assert.equal(existsSync(join(fx.change, ".superspec/raw/apply/TASK-001/test-runner-command-override.ref.json")), false);

  assert.throws(
    () => guard.materialize_apply_worker_artifact_ref(fx.change, {
      taskId: "TASK-001",
      kind: "raw_transcript",
      role: "test-runner",
      path: "../escape.log",
      content: "bad\n",
      workerChainContext: "none",
      originPacketFingerprint: "sha256:test-packet",
      sourceImplementationFingerprint: sourceFingerprint,
      observedImplementationFingerprint: { fingerprint_digest: "sha256:observed" },
      inputRefDigest: "sha256:raw-input",
      command: "npm test -- TEST-001",
      cwd: fx.repo,
      phase: "green",
      testId: "TEST-001",
      exitCode: 0,
    }),
    /apply_worker_artifact_materialize_invalid/u,
  );
  assert.throws(
    () => guard.materialize_apply_worker_artifact_ref(fx.change, {
      taskId: "TASK-001",
      kind: "worker_report",
      role: "executor",
      content: "",
      workerChainContext: "executor_worker",
      applyWorkerChainId: "CHAIN-001",
      originPacketFingerprint: "sha256:executor-packet",
      sourceImplementationFingerprint: sourceFingerprint,
      producedImplementationFingerprint: producedFingerprint,
      inputRefDigest: "sha256:input",
    }),
    /content is empty/u,
  );
  assert.throws(
    () => guard.materialize_apply_worker_artifact_ref(fx.change, {
      taskId: "TASK-001",
      kind: "worker_report",
      role: "executor",
      content: executorReport,
      workerChainContext: "executor_worker",
      applyWorkerChainId: "CHAIN-001",
      originPacketFingerprint: "sha256:executor-packet",
      sourceImplementationFingerprint: sourceFingerprint,
      producedImplementationFingerprint: producedFingerprint,
      inputRefDigest: "sha256:input",
      metadata: { path: ".superspec/reports/apply/TASK-001/forged.json" },
    }),
    /metadata must not override path/u,
  );
  assert.equal(existsSync(join(fx.change, ".superspec/reports/apply/TASK-001/executor-worker_report.json")), false);
  assert.equal(existsSync(join(fx.change, ".superspec/reports/apply/TASK-001/executor-worker_report.ref.json")), false);

  const blockedRefParent = join(fx.change, ".superspec/reports/apply/TASK-001/ref-parent");
  mkdirp(dirname(blockedRefParent));
  writeFileSync(blockedRefParent, "not a directory\n");
  assert.throws(
    () => guard.materialize_apply_worker_artifact_ref(fx.change, {
      taskId: "TASK-001",
      kind: "worker_report",
      role: "executor",
      filename: "executor-report-ref-write-fails.json",
      content: executorReport,
      refPath: ".superspec/reports/apply/TASK-001/ref-parent/executor-report.ref.json",
      workerChainContext: "executor_worker",
      applyWorkerChainId: "CHAIN-001",
      originPacketFingerprint: "sha256:executor-packet",
      sourceImplementationFingerprint: sourceFingerprint,
      producedImplementationFingerprint: producedFingerprint,
      inputRefDigest: "sha256:input",
    }),
    /EEXIST|ENOTDIR/u,
  );
  assert.equal(existsSync(join(fx.change, ".superspec/reports/apply/TASK-001/executor-report-ref-write-fails.json")), false);
});

test("command surface includes check-task-reopen", () => {
  const args = guard.parse_argv(["check-task-reopen", "--change", "demo-change", "--task-id", "TASK-001"]);
  assert.equal(args.command, "check-task-reopen");
  assert.equal(args.task_id, "TASK-001");
});

test("cli root help matches argparse-style surface", () => {
  const proc = spawnSync(process.execPath, [GUARD_TS, "--help"], { encoding: "utf8" });
  assert.equal(proc.status, 0);
  assert.equal(proc.stderr, "");
  assert.ok(proc.stdout.includes("usage: superspec_guard [-h]"));
  assert.ok(proc.stdout.includes("SuperSpec 守护检查（v1）"));
  assert.ok(proc.stdout.includes("check-task-complete"));
  assert.ok(proc.stdout.includes("check-task-reopen"));
  assert.ok(proc.stdout.includes("workflow-packet"));
  assert.ok(proc.stdout.includes("review-packet"));
  assert.ok(proc.stdout.includes("ledger-render"));
  assert.equal(proc.stdout.includes("show this help message and exit"), false);
});

test("cli missing command emits usage to stderr", () => {
  const proc = spawnSync(process.execPath, [GUARD_TS], { encoding: "utf8" });
  assert.equal(proc.status, 2);
  assert.equal(proc.stdout, "");
  assert.ok(proc.stderr.includes("usage: superspec_guard [-h]"));
  assert.ok(proc.stderr.includes("缺少必填参数：command"));
  assert.equal(proc.stderr.includes("guard_error"), false);
  assert.equal(proc.stderr.includes("the following arguments are required"), false);
});

test("cli unknown command emits argparse-style invalid choice", () => {
  const proc = spawnSync(process.execPath, [GUARD_TS, "nope"], { encoding: "utf8" });
  assert.equal(proc.status, 2);
  assert.equal(proc.stdout, "");
  assert.ok(proc.stderr.includes("命令无效：'nope'"));
  assert.equal(proc.stderr.includes("guard_error"), false);
  assert.equal(proc.stderr.includes("invalid choice"), false);
});

test("cli invalid format reports a non-internal guard error", () => {
  const proc = spawnSync(process.execPath, [GUARD_TS, "check-init", "--change", "demo-change", "--format", "raw"], { encoding: "utf8" });
  assert.equal(proc.status, 2);
  assert.equal(proc.stderr, "");
  const printed = JSON.parse(proc.stdout);
  assert.equal(printed.decision, "block");
  assert.equal(printed.block_reasons[0].code, "guard_error");
  assert.match(printed.block_reasons[0].message, /--format 只允许 json、agent 或 user/u);
  assert.equal(proc.stdout.includes("guard_internal_error"), false);
});

test("cli missing format value reports a non-internal guard error", () => {
  const proc = spawnSync(process.execPath, [GUARD_TS, "check-init", "--change", "demo-change", "--format"], { encoding: "utf8" });
  assert.equal(proc.status, 2);
  assert.equal(proc.stderr, "");
  const printed = JSON.parse(proc.stdout);
  assert.equal(printed.decision, "block");
  assert.equal(printed.block_reasons[0].code, "guard_error");
  assert.match(printed.block_reasons[0].message, /--format 缺少取值/u);
  assert.equal(proc.stdout.includes("guard_internal_error"), false);

  const withUserFacing = spawnSync(process.execPath, [GUARD_TS, "check-init", "--change", "demo-change", "--format", "--user-facing"], { encoding: "utf8" });
  assert.equal(withUserFacing.status, 2);
  assert.equal(withUserFacing.stderr, "");
  const userFacingPrinted = JSON.parse(withUserFacing.stdout);
  assert.equal(userFacingPrinted.block_reasons[0].code, "guard_error");
  assert.match(userFacingPrinted.block_reasons[0].message, /--format 缺少取值/u);
  assert.equal(withUserFacing.stdout.includes("guard_internal_error"), false);

  const duplicate = spawnSync(process.execPath, [GUARD_TS, "check-init", "--change", "demo-change", "--format", "agent", "--format"], { encoding: "utf8" });
  assert.equal(duplicate.status, 2);
  assert.equal(duplicate.stderr, "");
  const duplicatePrinted = JSON.parse(duplicate.stdout);
  assert.equal(duplicatePrinted.block_reasons[0].code, "guard_error");
  assert.match(duplicatePrinted.block_reasons[0].message, /--format 缺少取值/u);
  assert.equal(duplicate.stdout.includes("guard_internal_error"), false);
});

test("cli subcommand help emits usage to stdout", () => {
  const proc = spawnSync(process.execPath, [GUARD_TS, "check-artifact", "--help"], { encoding: "utf8" });
  assert.equal(proc.status, 0);
  assert.equal(proc.stderr, "");
  assert.ok(proc.stdout.includes("usage: superspec_guard check-artifact [-h] --change CHANGE --artifact ARTIFACT"));
});

test("packet subcommand help shows packet-specific options", () => {
  const workflow = spawnSync(process.execPath, [GUARD_TS, "workflow-packet", "--help"], { encoding: "utf8" });
  assert.equal(workflow.status, 0);
  assert.equal(workflow.stderr, "");
  assert.ok(workflow.stdout.includes("usage: superspec_guard workflow-packet [-h] --change CHANGE --gate GATE --format {agent} [--task-id TASK_ID]"));

  const review = spawnSync(process.execPath, [GUARD_TS, "review-packet", "--help"], { encoding: "utf8" });
  assert.equal(review.status, 0);
  assert.equal(review.stderr, "");
  assert.ok(review.stdout.includes("usage: superspec_guard review-packet [-h] --change CHANGE --gate GATE --role ROLE --round ROUND --format {agent,prompt} [--kind KIND]"));

  const ledger = spawnSync(process.execPath, [GUARD_TS, "ledger-render", "--help"], { encoding: "utf8" });
  assert.equal(ledger.status, 0);
  assert.equal(ledger.stderr, "");
  assert.ok(ledger.stdout.includes("usage: superspec_guard ledger-render [-h] --change CHANGE --gate GATE [--round ROUND]"));
});

test("packet parse failures use packet-specific stdout contract", () => {
  const invalidFormat = captureMainJson(["workflow-packet", "--change", "demo-change", "--gate", "explore_complete", "--format", "prompt"]);
  assert.equal(invalidFormat.exitCode, 2);
  assert.deepEqual(invalidFormat.payload, {
    status: "error",
    error_code: "guard_error",
    message: "--format 只允许 agent",
  });

  const missingTaskId = captureMainJson(["workflow-packet", "--change", "demo-change", "--gate", "task_edit", "--format", "agent"]);
  assert.equal(missingTaskId.exitCode, 2);
  assert.equal(missingTaskId.payload.status, "error");
  assert.equal(missingTaskId.payload.error_code, "guard_error");
  assert.match(missingTaskId.payload.message, /workflow-packet 缺少必填参数 --task-id/u);

  const missingChange = captureMainJson(["ledger-render", "--gate", "proposal_reviewed"]);
  assert.equal(missingChange.exitCode, 2);
  assert.equal(missingChange.payload.status, "error");
  assert.equal(missingChange.payload.error_code, "guard_error");
  assert.match(missingChange.payload.message, /缺少必填参数 --change/u);
});

test("standalone init help emits init-specific usage", () => {
  const proc = spawnSync(process.execPath, [INIT_TS, "--help"], { encoding: "utf8" });
  assert.equal(proc.status, 0);
  assert.equal(proc.stderr, "");
  assert.ok(proc.stdout.includes("usage: superspec init [-h] [--scope {project,user}]"));
  assert.ok(proc.stdout.includes("可选参数："));
  assert.ok(proc.stdout.includes("--format {json,agent,user}"));
  assert.ok(proc.stdout.includes("--user"));
  assert.equal(proc.stdout.includes("show this help message and exit"), false);
});

test("openspec status golden fixture matches 1.4.1 shape", () => {
  const fixture = join(GUARD_ROOT, "tests", "fixtures", "openspec-status-1.4.1.json");
  const currentStatus = readJson(fixture);
  assert.deepEqual(guard.openspec_status_shape_reasons(currentStatus), []);
  assert.equal(guard.artifact_status_map(currentStatus).tasks, "done");
  assert.equal(
    guard.status_fingerprint(currentStatus),
    "sha256:5a3e2b1ad8ae1791bf92ddbc5de392794d5a8d90002f9fe2203564adc91e690c",
  );
});

withFixture("init rejects non-default openspec schema", (fx) => {
  const decision = guard.check_init("demo-change", { ...status(fx), schemaName: "superspec" }, fx.repo, fx.change);
  assert.equal(decision.allowed, false);
  assert.equal(decision.block_reasons[0].code, "non_default_openspec_schema");
});

withFixture("init ignores missing openspec codex skills when CLI surfaces are available", (fx) => {
  const decision = guard.check_init("demo-change", status(fx), fx.repo, fx.change);
  assert.equal(decision.allowed, true, JSON.stringify(decision));
  assert.equal(codes(decision.block_reasons).includes("openspec_init_missing"), false);
});

withFixture("init ignores stale openspec codex skill frontmatter", (fx) => {
  writeText(join(fx.repo, ".codex", "skills", "openspec-propose", "SKILL.md"), "---\nname: not-openspec-propose\n---\n");
  const decision = guard.check_init("demo-change", status(fx), fx.repo, fx.change);
  assert.equal(decision.allowed, true, JSON.stringify(decision));
  assert.equal(codes(decision.block_reasons).includes("openspec_native_surface_invalid"), false);
});

withFixture("init blocks when openspec cli surface missing", (fx) => {
  withRuntime({
    openspec_cli_capability_reasons: () => [
      guard.reason("openspec_native_surface_missing", "`openspec instructions --help` failed"),
    ],
  }, () => {
    const decision = guard.check_init("demo-change", status(fx), fx.repo, fx.change);
    assert.equal(decision.allowed, false);
    assert.ok(codes(decision.block_reasons).includes("openspec_native_surface_missing"));
  });
});

withFixture("init blocks when superspec agent definitions are missing", (fx) => {
  unlinkSync(join(fx.repo, ".codex", "agents", "critic.toml"));
  const decision = guard.check_init("demo-change", status(fx), fx.repo, fx.change);
  assert.equal(decision.allowed, false);
  assert.ok(codes(decision.block_reasons).includes("superspec_agent_missing"));
  const missing = decision.block_reasons.find((item: JsonMap) => item.code === "superspec_agent_missing");
  assert.ok(missing);
  assert.ok(missing.refs.includes("critic"));
});

withFixture("init blocks when superspec agent name is invalid", (fx) => {
  writeText(join(fx.repo, ".codex", "agents", "critic.toml"), 'name = "not-critic"\n');
  const decision = guard.check_init("demo-change", status(fx), fx.repo, fx.change);
  assert.equal(decision.allowed, false);
  assert.ok(codes(decision.block_reasons).includes("superspec_agent_invalid"));
});

withFixture("init blocks when superspec role prompts are missing", (fx) => {
  unlinkSync(join(fx.repo, ".codex", "prompts", "critic.md"));
  const decision = guard.check_init("demo-change", status(fx), fx.repo, fx.change);
  assert.equal(decision.allowed, false);
  assert.ok(codes(decision.block_reasons).includes("superspec_prompt_missing"));
  const missing = decision.block_reasons.find((item: JsonMap) => item.code === "superspec_prompt_missing");
  assert.ok(missing);
  assert.ok(missing.refs.includes("critic"));
});

withFixture("init blocks when superspec role prompt is empty", (fx) => {
  writeText(join(fx.repo, ".codex", "prompts", "critic.md"), "");
  const decision = guard.check_init("demo-change", status(fx), fx.repo, fx.change);
  assert.equal(decision.allowed, false);
  assert.ok(codes(decision.block_reasons).includes("superspec_prompt_invalid"));
});

withFixture("init allows when openspec CLI surfaces exist", (fx) => {
  const decision = guard.check_init("demo-change", status(fx), fx.repo, fx.change);
  assert.equal(decision.allowed, true, JSON.stringify(decision));
});

withFixture("init blocks when a superspec workflow skill is missing", (fx) => {
  // D4 (audit G-2): deleting .codex/skills/superspec-* must surface at check-init.
  rmSync(join(fx.repo, ".codex", "skills", "superspec-propose"), { recursive: true, force: true });
  const decision = guard.check_init("demo-change", status(fx), fx.repo, fx.change);
  assert.equal(decision.allowed, false);
  const missing = decision.block_reasons.find((item: JsonMap) => item.code === "superspec_init_missing");
  assert.ok(missing, JSON.stringify(decision.block_reasons));
  assert.ok(missing.refs.includes("superspec-propose"));
});

withFixture("init blocks when a superspec workflow skill has invalid front matter", (fx) => {
  writeText(join(fx.repo, ".codex", "skills", "superspec-review", "SKILL.md"), "---\nname: not-superspec-review\n---\n");
  const decision = guard.check_init("demo-change", status(fx), fx.repo, fx.change);
  assert.equal(decision.allowed, false);
  assert.ok(codes(decision.block_reasons).includes("superspec_skill_invalid"), JSON.stringify(decision.block_reasons));
});

withFixture("guard init compatibility creates only state and ledger", (fx) => {
  withRuntime({ load_context: () => [status(fx, { proposal: "blocked", specs: "blocked", design: "blocked", tasks: "blocked" }), fx.repo, fx.change, []] }, () => {
    const [summary] = guard.dispatch({ command: "init", change: "demo-change", create: true });
    assert.equal(summary.allowed, true, JSON.stringify(summary));
    assert.deepEqual(summary.sidecar, {
      root: ".superspec",
      state: ".superspec/superspec-state.json",
      ledger: ".superspec/ledger.jsonl",
    });
    const sidecarEntries = readdirSync(join(fx.change, ".superspec")).sort();
    assert.deepEqual(sidecarEntries, ["ledger.jsonl", "superspec-state.json"]);
  });
});

test("standalone project init creates missing project surfaces without a change", () => {
  const tmp = mkdtempSync(join(tmpdir(), "superspec-project-init-"));
  const writes: string[] = [];
  const savedWrite = process.stdout.write;
  let summary: JsonMap;
  process.stdout.write = ((chunk: any, ...args: any[]) => {
    writes.push(String(chunk));
    return true;
  }) as typeof process.stdout.write;
  try {
    assert.equal(main_init(["--path", tmp]), 0);
    summary = JSON.parse(writes.join(""));
    assert.equal(summary.allowed, true, JSON.stringify(summary));
    assert.equal(summary.gate, "project_init");
    assert.equal(summary.gate_label_zh, "项目初始化");
    assert.equal(summary.change_id, null);
    assert.equal(existsSync(join(tmp, ".codex", "skills", "openspec-explore", "SKILL.md")), false);
    for (const name of guard.REQUIRED_SUPERSPEC_AGENT_ROLES) {
      assert.equal(existsSync(join(tmp, ".codex", "agents", `${name}.toml`)), true, name);
      assert.equal(existsSync(join(tmp, ".codex", "prompts", `${name}.md`)), true, name);
    }
    const changesDir = join(tmp, "openspec", "changes");
    assert.deepEqual(existsSync(changesDir) ? readdirSync(changesDir).filter((name) => !name.startsWith(".") && name !== "archive") : [], []);
    assert.equal(existsSync(join(tmp, ".superspec")), false);
  } finally {
    process.stdout.write = savedWrite;
    rmSync(tmp, { recursive: true, force: true });
  }
});

test("standalone project init supports agent output format", () => {
  const tmp = mkdtempSync(join(tmpdir(), "superspec-project-init-agent-"));
  try {
    const text = captureStdoutText(() => {
      assert.equal(main_init(["--path", tmp, "--format", "agent"]), 0);
    });
    const agent = JSON.parse(text);
    assert.equal(agent.allowed, true);
    assert.equal(agent.workflow_action, "continue");
    assertNoForbiddenAgentKeys(agent);
    assertSafeOutputHasNoLeaks(text);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test("standalone project init rejects missing format value even with user-facing override", () => {
  const tmp = mkdtempSync(join(tmpdir(), "superspec-project-init-format-"));
  try {
    const text = captureStdoutText(() => {
      assert.equal(main_init(["--path", tmp, "--format", "--user-facing"]), 2);
    });
    const printed = JSON.parse(text);
    assert.equal(printed.block_reasons[0].code, "guard_error");
    assert.match(printed.block_reasons[0].message, /--format 缺少取值/u);
    assert.equal(text.includes("guard_internal_error"), false);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

withFixture("sidecar output directories are lazy-created on write", (fx) => {
  const base = join(fx.change, ".superspec");
  guard.write_state_atomic(fx.change, { schema_version: 1, change_id: "demo-change" });
  assert.deepEqual(readdirSync(base).sort(), ["ledger.jsonl", "superspec-state.json"]);

  guard.write_sidecar_json(fx.change, "evidence/discovery/EV-discovery.json", passEvidence("explore_complete"));
  assert.equal(statSync(join(base, "evidence", "discovery", "EV-discovery.json")).isFile(), true);
  assert.equal(existsSync(join(base, "reports")), false);
  assert.equal(existsSync(join(base, "raw")), false);

  guard.write_sidecar_text(fx.change, "reports/explore.md", "pass\n");
  guard.write_sidecar_text(fx.change, "raw/openspec-status.json", "{}\n");
  guard.write_sidecar_text(fx.change, "handoffs/apply.md", "handoff\n");
  assert.equal(statSync(join(base, "reports", "explore.md")).isFile(), true);
  assert.equal(statSync(join(base, "raw", "openspec-status.json")).isFile(), true);
  assert.equal(statSync(join(base, "handoffs", "apply.md")).isFile(), true);
});

withFixture("explore complete requires discovery sidecar", (fx) => {
  const decision = guard.check_superspec_gate("demo-change", status(fx, { proposal: "blocked", specs: "blocked", design: "blocked", tasks: "blocked" }), fx.change, [
    roleEvidence(fx, "explore_complete", "critic"),
  ], "explore_complete");
  assert.equal(decision.allowed, false);
  assert.ok(codes(decision.block_reasons).includes("missing_discovery"));
  assert.ok(decision.next_allowed_actions.length > 0);
});

withFixture("explore complete blocks until discovery is human confirmed", (fx) => {
  writeText(join(fx.change, ".superspec", "artifacts", "discovery.md"), "source anchors and facts\n");
  const blocked = guard.check_superspec_gate("demo-change", status(fx, { proposal: "blocked", specs: "blocked", design: "blocked", tasks: "blocked" }), fx.change, [
    roleEvidence(fx, "explore_complete", "critic"),
  ], "explore_complete");
  assert.equal(blocked.allowed, false, JSON.stringify(blocked));
  assert.ok(codes(blocked.block_reasons).includes("missing_human_confirmation"));
  const nonUser = guard.check_superspec_gate("demo-change", status(fx, { proposal: "blocked", specs: "blocked", design: "blocked", tasks: "blocked" }), fx.change, [
    roleEvidence(fx, "explore_complete", "critic"),
    passEvidence("explore_complete", "human_confirmation", { created_by: "main-thread" }),
  ], "explore_complete");
  assert.equal(nonUser.allowed, false, JSON.stringify(nonUser));
  assert.ok(codes(nonUser.block_reasons).includes("missing_human_confirmation"));
  const allowed = guard.check_superspec_gate("demo-change", status(fx, { proposal: "blocked", specs: "blocked", design: "blocked", tasks: "blocked" }), fx.change, [
    roleEvidence(fx, "explore_complete", "critic"),
    passEvidence("explore_complete", "human_confirmation"),
  ], "explore_complete");
  assert.equal(allowed.allowed, true, JSON.stringify(allowed));
});

withFixture("FIX-4 explore complete blocks stale discovery review after discovery edit", (fx) => {
  const discoveryPath = join(fx.change, ".superspec", "artifacts", "discovery.md");
  writeText(discoveryPath, "discovery v1 facts\n");
  const evidences = [
    roleEvidence(fx, "explore_complete", "critic"),
    passEvidence("explore_complete", "human_confirmation"),
  ];
  const exploreStatus = status(fx, { proposal: "blocked", specs: "blocked", design: "blocked", tasks: "blocked" });
  const before = guard.check_superspec_gate("demo-change", exploreStatus, fx.change, evidences, "explore_complete");
  assert.equal(before.allowed, true, JSON.stringify(before));
  writeText(discoveryPath, "discovery v2 facts changed after review\n");
  const after = guard.check_superspec_gate("demo-change", exploreStatus, fx.change, evidences, "explore_complete");
  assert.equal(after.allowed, false);
  assert.ok(codes(after.block_reasons).includes("stale_explore_review"), JSON.stringify(after.block_reasons));
});

withFixture("FIX-4 design complete blocks stale design review after design edit", (fx) => {
  writeText(join(fx.change, ".superspec", "artifacts", "discovery.md"), "discovery facts\n");
  const designPath = join(fx.change, "design.md");
  writeText(designPath, "design v1\n");
  const evidences = [
    ...exploreConfirmedEvidences(fx),
    ...proposalReviewedEvidences(fx),
    roleEvidence(fx, "design_complete", "architect"),
    roleEvidence(fx, "design_complete", "critic"),
    roleEvidence(fx, "design_complete", "test-engineer"),
    passEvidence("design_complete", "human_confirmation"),
  ];
  const before = guard.check_superspec_gate("demo-change", status(fx), fx.change, evidences, "design_complete");
  assert.equal(before.allowed, true, JSON.stringify(before));
  writeText(designPath, "design v2 changed after review\n");
  const after = guard.check_superspec_gate("demo-change", status(fx), fx.change, evidences, "design_complete");
  assert.equal(after.allowed, false);
  assert.ok(codes(after.block_reasons).includes("stale_design_review"), JSON.stringify(after.block_reasons));
});

withFixture("FIX-4 test contract drafted blocks stale contract review after contract edit", (fx) => {
  const evidences = prepareProposeComplete(fx);
  const before = guard.check_superspec_gate("demo-change", status(fx), fx.change, evidences, "test_contract_drafted");
  assert.equal(before.allowed, true, JSON.stringify(before));
  const contractPath = join(fx.change, ".superspec", "artifacts", "test-contract.md");
  writeText(contractPath, `${testContractText()}\n<!-- edited after review -->\n`);
  const after = guard.check_superspec_gate("demo-change", status(fx), fx.change, evidences, "test_contract_drafted");
  assert.equal(after.allowed, false);
  assert.ok(codes(after.block_reasons).includes("stale_test_contract_review"), JSON.stringify(after.block_reasons));
});

withFixture("FIX-4 state fingerprints cover discovery and design artifacts", (fx) => {
  writeText(join(fx.change, ".superspec", "artifacts", "discovery.md"), "discovery v1\n");
  writeText(join(fx.change, "design.md"), "design v1\n");
  const currentStatus = status(fx);
  const decision = guard.allow("demo-change", "recompute");
  guard.recompute_and_write_state("demo-change", fx.change, currentStatus, "tasks", "recompute", decision);
  const state = readJson(join(fx.change, ".superspec", "superspec-state.json"));
  assert.ok(String(state.computed_from.discovery_fingerprint ?? "").startsWith("sha256:"), JSON.stringify(state.computed_from));
  assert.ok(String(state.computed_from.design_fingerprint ?? "").startsWith("sha256:"), JSON.stringify(state.computed_from));
  writeText(join(fx.change, ".superspec", "artifacts", "discovery.md"), "discovery v2\n");
  assert.deepEqual(codes(guard.state_stale_reasons(fx.change, currentStatus)), ["state_fingerprint_stale"]);
  guard.recompute_and_write_state("demo-change", fx.change, currentStatus, "tasks", "recompute", decision);
  assert.deepEqual(guard.state_stale_reasons(fx.change, currentStatus), []);
  writeText(join(fx.change, "design.md"), "design v2\n");
  assert.deepEqual(codes(guard.state_stale_reasons(fx.change, currentStatus)), ["state_fingerprint_stale"]);
});

withFixture("FIX-2 design complete blocks when explore_complete not satisfied", (fx) => {
  writeText(join(fx.change, "design.md"), "design\n");
  const decision = guard.check_superspec_gate("demo-change", status(fx), fx.change, [
    roleEvidence(fx, "design_complete", "architect"),
    roleEvidence(fx, "design_complete", "critic"),
    roleEvidence(fx, "design_complete", "test-engineer"),
    passEvidence("design_complete", "human_confirmation"),
  ], "design_complete");
  assert.equal(decision.allowed, false);
  const decisionCodes = codes(decision.block_reasons);
  assert.ok(decisionCodes.includes("explore_complete_failed"), JSON.stringify(decisionCodes));
  assert.ok(decisionCodes.includes("missing_discovery"), JSON.stringify(decisionCodes));
});

withFixture("FIX-2 design complete allows when explore_complete satisfied", (fx) => {
  writeText(join(fx.change, ".superspec", "artifacts", "discovery.md"), "source anchors and facts\n");
  writeText(join(fx.change, "design.md"), "design\n");
  const decision = guard.check_superspec_gate("demo-change", status(fx), fx.change, [
    ...exploreConfirmedEvidences(fx),
    ...proposalReviewedEvidences(fx),
    roleEvidence(fx, "design_complete", "architect"),
    roleEvidence(fx, "design_complete", "critic"),
    roleEvidence(fx, "design_complete", "test-engineer"),
    passEvidence("design_complete", "human_confirmation"),
  ], "design_complete");
  assert.equal(decision.allowed, true, JSON.stringify(decision));
});

withFixture("test contract drafted blocks until design is user-confirmed", (fx) => {
  writeText(join(fx.change, ".superspec", "artifacts", "discovery.md"), "source anchors and facts\n");
  writeText(join(fx.change, "design.md"), "design\n");
  writeText(join(fx.change, ".superspec", "artifacts", "business-invariants.md"), businessInvariantsText());
  writeText(join(fx.change, ".superspec", "artifacts", "test-contract.md"), testContractText());
  writeText(join(fx.change, "specs", "attendance", "spec.md"), "#### Scenario: Scenario A\n");
  const base = [
    ...exploreConfirmedEvidences(fx),
    ...proposalReviewedEvidences(fx),
    roleEvidence(fx, "design_complete", "architect"),
    roleEvidence(fx, "design_complete", "critic"),
    roleEvidence(fx, "design_complete", "test-engineer"),
    roleEvidence(fx, "invariants_reviewed", "critic"),
    roleEvidence(fx, "invariants_reviewed", "test-engineer"),
    roleEvidence(fx, "test_contract_drafted", "test-engineer"),
    roleEvidence(fx, "test_contract_drafted", "critic"),
  ];
  const missing = guard.check_superspec_gate("demo-change", status(fx, { tasks: "blocked" }), fx.change, base, "test_contract_drafted");
  assert.equal(missing.allowed, false, JSON.stringify(missing));
  assert.ok(codes(missing.block_reasons).includes("design_complete_failed"), JSON.stringify(missing.block_reasons));
  assert.ok(codes(missing.block_reasons).includes("missing_human_confirmation"), JSON.stringify(missing.block_reasons));
  const nonUser = guard.check_superspec_gate("demo-change", status(fx, { tasks: "blocked" }), fx.change, [
    ...base,
    passEvidence("design_complete", "human_confirmation", { created_by: "main-thread" }),
  ], "test_contract_drafted");
  assert.equal(nonUser.allowed, false, JSON.stringify(nonUser));
  assert.ok(codes(nonUser.block_reasons).includes("missing_human_confirmation"), JSON.stringify(nonUser.block_reasons));
});

withFixture("test contract drafted passes without tasks", (fx) => {
  writeText(join(fx.change, ".superspec", "artifacts", "discovery.md"), "source anchors and facts\n");
  writeText(join(fx.change, "design.md"), "design\n");
  writeText(join(fx.change, ".superspec", "artifacts", "business-invariants.md"), businessInvariantsText());
  writeText(join(fx.change, ".superspec", "artifacts", "test-contract.md"), testContractText());
  const decision = guard.check_superspec_gate("demo-change", status(fx, { tasks: "blocked" }), fx.change, [
    ...exploreConfirmedEvidences(fx),
    ...proposalReviewedEvidences(fx),
    roleEvidence(fx, "design_complete", "architect"),
    roleEvidence(fx, "design_complete", "critic"),
    roleEvidence(fx, "design_complete", "test-engineer"),
    passEvidence("design_complete", "human_confirmation"),
    roleEvidence(fx, "invariants_reviewed", "critic"),
    roleEvidence(fx, "invariants_reviewed", "test-engineer"),
    roleEvidence(fx, "test_contract_drafted", "test-engineer"),
    roleEvidence(fx, "test_contract_drafted", "critic"),
  ], "test_contract_drafted");
  assert.equal(decision.allowed, true, JSON.stringify(decision));
});

withFixture("test contract drafted blocks missing scenario coverage", (fx) => {
  writeText(join(fx.change, ".superspec", "artifacts", "business-invariants.md"), businessInvariantsText());
  writeText(join(fx.change, ".superspec", "artifacts", "test-contract.md"), testContractText("TEST-001", "unrelated", "INV-001"));
  writeText(join(fx.change, "specs", "attendance", "spec.md"), "#### Scenario: Clock in validates policy\n");
  const decision = guard.check_superspec_gate("demo-change", status(fx, { tasks: "blocked" }), fx.change, [
    roleEvidence(fx, "design_complete", "architect"),
    roleEvidence(fx, "design_complete", "critic"),
    roleEvidence(fx, "design_complete", "test-engineer"),
    passEvidence("design_complete", "human_confirmation"),
    roleEvidence(fx, "invariants_reviewed", "critic"),
    roleEvidence(fx, "invariants_reviewed", "test-engineer"),
    roleEvidence(fx, "test_contract_drafted", "test-engineer"),
    roleEvidence(fx, "test_contract_drafted", "critic"),
  ], "test_contract_drafted");
  assert.equal(decision.allowed, false);
  assert.ok(codes(decision.block_reasons).includes("missing_coverage_matrix"));
});

withFixture("invariants reviewed requires business invariants sidecar", (fx) => {
  const decision = guard.check_superspec_gate("demo-change", status(fx), fx.change, [
    roleEvidence(fx, "design_complete", "architect"),
    roleEvidence(fx, "design_complete", "critic"),
    roleEvidence(fx, "design_complete", "test-engineer"),
    passEvidence("design_complete", "human_confirmation"),
    roleEvidence(fx, "invariants_reviewed", "critic"),
    roleEvidence(fx, "invariants_reviewed", "test-engineer"),
  ], "invariants_reviewed");
  assert.equal(decision.allowed, false);
  assert.ok(codes(decision.block_reasons).includes("missing_business_invariants"));
});

withFixture("invariants reviewed requires critic and test engineer", (fx) => {
  writeText(join(fx.change, ".superspec", "artifacts", "business-invariants.md"), businessInvariantsText());
  const decision = guard.check_superspec_gate("demo-change", status(fx), fx.change, [
    roleEvidence(fx, "design_complete", "architect"),
    roleEvidence(fx, "design_complete", "critic"),
    roleEvidence(fx, "design_complete", "test-engineer"),
    passEvidence("design_complete", "human_confirmation"),
    roleEvidence(fx, "invariants_reviewed", "critic"),
  ], "invariants_reviewed");
  assert.equal(decision.allowed, false);
  assert.ok(codes(decision.block_reasons).includes("missing_invariant_review"));
});

withFixture("invariants reviewed evidence must target current business invariants", (fx) => {
  writeText(join(fx.change, ".superspec", "artifacts", "business-invariants.md"), businessInvariantsText());
  const unrelated = join(fx.change, "unrelated.md");
  writeText(unrelated, "not the invariant file\n");
  const decision = guard.check_superspec_gate("demo-change", status(fx), fx.change, [
    roleEvidence(fx, "design_complete", "architect"),
    roleEvidence(fx, "design_complete", "critic"),
    roleEvidence(fx, "design_complete", "test-engineer"),
    passEvidence("design_complete", "human_confirmation"),
    roleEvidence(fx, "invariants_reviewed", "critic", {
      target_refs: [{ path: "unrelated.md", blob_sha: guard.file_blob_sha(unrelated) }],
    }),
    roleEvidence(fx, "invariants_reviewed", "test-engineer"),
  ], "invariants_reviewed");
  assert.equal(decision.allowed, false);
  assert.ok(codes(decision.block_reasons).includes("stale_invariant_review"));
});

withFixture("invariants reviewed blocks hard post implementation backfill", (fx) => {
  writeText(join(fx.change, ".superspec", "artifacts", "business-invariants.md"), businessInvariantsText("INV-001", { created_after_implementation: "true" }));
  const decision = guard.check_superspec_gate("demo-change", status(fx), fx.change, [
    roleEvidence(fx, "design_complete", "architect"),
    roleEvidence(fx, "design_complete", "critic"),
    roleEvidence(fx, "design_complete", "test-engineer"),
    passEvidence("design_complete", "human_confirmation"),
    roleEvidence(fx, "invariants_reviewed", "critic"),
    roleEvidence(fx, "invariants_reviewed", "test-engineer"),
  ], "invariants_reviewed");
  assert.equal(decision.allowed, false);
  assert.ok(codes(decision.block_reasons).includes("post_implementation_invariant_backfill"));
});

withFixture("invariants reviewed requires human confirmation for human-confirmation invariants", (fx) => {
  writeText(join(fx.change, ".superspec", "artifacts", "business-invariants.md"), businessInvariantsText("INV-001", { enforcement_level: "human-confirmation", verification: "human confirmation evidence" }));
  const decision = guard.check_superspec_gate("demo-change", status(fx), fx.change, [
    roleEvidence(fx, "design_complete", "architect"),
    roleEvidence(fx, "design_complete", "critic"),
    roleEvidence(fx, "design_complete", "test-engineer"),
    passEvidence("design_complete", "human_confirmation"),
    roleEvidence(fx, "invariants_reviewed", "critic"),
    roleEvidence(fx, "invariants_reviewed", "test-engineer"),
  ], "invariants_reviewed");
  assert.equal(decision.allowed, false);
  assert.ok(codes(decision.block_reasons).includes("missing_human_confirmation"));
});

withFixture("test contract drafted allows human-confirmation invariant outside TEST matrix with human evidence", (fx) => {
  writeText(join(fx.change, ".superspec", "artifacts", "discovery.md"), "source anchors and facts\n");
  writeText(join(fx.change, "design.md"), "design\n");
  writeText(join(fx.change, ".superspec", "artifacts", "business-invariants.md"), businessInvariantsText("INV-HUMAN", { enforcement_level: "human-confirmation", verification: "human confirmation evidence" }));
  writeText(join(fx.change, ".superspec", "artifacts", "test-contract.md"), testContractText("TEST-001", "Scenario A", ""));
  writeText(join(fx.change, "specs", "attendance", "spec.md"), "#### Scenario: Scenario A\n");
  const decision = guard.check_superspec_gate("demo-change", status(fx, { tasks: "blocked" }), fx.change, [
    ...exploreConfirmedEvidences(fx),
    ...proposalReviewedEvidences(fx),
    roleEvidence(fx, "design_complete", "architect"),
    roleEvidence(fx, "design_complete", "critic"),
    roleEvidence(fx, "design_complete", "test-engineer"),
    passEvidence("design_complete", "human_confirmation"),
    roleEvidence(fx, "invariants_reviewed", "critic"),
    roleEvidence(fx, "invariants_reviewed", "test-engineer"),
    passEvidence("invariants_reviewed", "human_confirmation", { invariant_refs: ["INV-HUMAN"] }),
    roleEvidence(fx, "test_contract_drafted", "test-engineer"),
    roleEvidence(fx, "test_contract_drafted", "critic"),
  ], "test_contract_drafted");
  assert.equal(decision.allowed, true, JSON.stringify(decision));
});

withFixture("test contract drafted blocks automated hard invariant outside TEST matrix", (fx) => {
  writeText(join(fx.change, ".superspec", "artifacts", "business-invariants.md"), businessInvariantsText("INV-001", { enforcement_level: "automated-test" }));
  writeText(join(fx.change, ".superspec", "artifacts", "test-contract.md"), testContractText("TEST-001", "Scenario A", ""));
  writeText(join(fx.change, "specs", "attendance", "spec.md"), "#### Scenario: Scenario A\n");
  const decision = guard.check_superspec_gate("demo-change", status(fx, { tasks: "blocked" }), fx.change, [
    roleEvidence(fx, "design_complete", "architect"),
    roleEvidence(fx, "design_complete", "critic"),
    roleEvidence(fx, "design_complete", "test-engineer"),
    passEvidence("design_complete", "human_confirmation"),
    roleEvidence(fx, "invariants_reviewed", "critic"),
    roleEvidence(fx, "invariants_reviewed", "test-engineer"),
    roleEvidence(fx, "test_contract_drafted", "test-engineer"),
    roleEvidence(fx, "test_contract_drafted", "critic"),
  ], "test_contract_drafted");
  assert.equal(decision.allowed, false);
  assert.ok(codes(decision.block_reasons).includes("invariant_not_honored"));
});

withFixture("test contract drafted ignores ids outside coverage matrix", (fx) => {
  writeText(join(fx.change, ".superspec", "artifacts", "business-invariants.md"), businessInvariantsText());
  writeText(join(fx.change, ".superspec", "artifacts", "test-contract.md"), "## Notes\n\nTEST-001 Scenario A INV-001\n");
  const decision = guard.check_superspec_gate("demo-change", status(fx, { tasks: "blocked" }), fx.change, [
    roleEvidence(fx, "design_complete", "architect"),
    roleEvidence(fx, "design_complete", "critic"),
    roleEvidence(fx, "design_complete", "test-engineer"),
    passEvidence("design_complete", "human_confirmation"),
    roleEvidence(fx, "invariants_reviewed", "critic"),
    roleEvidence(fx, "invariants_reviewed", "test-engineer"),
    roleEvidence(fx, "test_contract_drafted", "test-engineer"),
    roleEvidence(fx, "test_contract_drafted", "critic"),
  ], "test_contract_drafted");
  assert.equal(decision.allowed, false);
  assert.ok(codes(decision.block_reasons).includes("missing_coverage_matrix"));
});

withFixture("check artifact requires test contract before tasks", (fx) => {
  const decision = guard.check_artifact("demo-change", status(fx, { tasks: "ready" }), fx.change, [], "tasks");
  assert.equal(decision.allowed, false);
  assert.ok(codes(decision.block_reasons).includes("test_contract_drafted_failed"));
  assert.ok(codes(decision.block_reasons).includes("missing_test_contract"));
});

withFixture("check artifact allows tasks after test contract drafted", (fx) => {
  const decision = guard.check_artifact("demo-change", status(fx, { tasks: "ready" }), fx.change, prepareProposeComplete(fx), "tasks");
  assert.equal(decision.allowed, true, JSON.stringify(decision));
});

withFixture("FIX-3 test contract honored blocks when test_contract_drafted not satisfied", (fx) => {
  const evidences = prepareProposeComplete(fx).filter((ev) => ev.gate !== "test_contract_drafted");
  const decision = guard.check_superspec_gate("demo-change", status(fx), fx.change, evidences, "test_contract_honored");
  assert.equal(decision.allowed, false);
  const decisionCodes = codes(decision.block_reasons);
  assert.ok(decisionCodes.includes("test_contract_drafted_failed"), JSON.stringify(decisionCodes));
  assert.ok(decisionCodes.includes("missing_test_contract_review"), JSON.stringify(decisionCodes));
});

withFixture("FIX-3 test contract honored allows when test_contract_drafted satisfied", (fx) => {
  const decision = guard.check_superspec_gate("demo-change", status(fx), fx.change, prepareProposeComplete(fx), "test_contract_honored");
  assert.equal(decision.allowed, true, JSON.stringify(decision));
});

withFixture("test contract honored blocks before tasks", (fx) => {
  writeText(join(fx.change, ".superspec", "artifacts", "test-contract.md"), testContractText("TEST-001", "Scenario A", ""));
  const decision = guard.check_superspec_gate("demo-change", status(fx, { tasks: "blocked" }), fx.change, [], "test_contract_honored");
  assert.ok(codes(decision.block_reasons).includes("missing_tasks"));
});

withFixture("test contract honored requires task test refs", (fx) => {
  writeText(join(fx.change, ".superspec", "artifacts", "test-contract.md"), testContractText("TEST-001", "Scenario A", ""));
  writeText(join(fx.change, "tasks.md"), "- [ ] TASK-001 Implement\n  - test_refs: TEST-002\n");
  const decision = guard.check_superspec_gate("demo-change", status(fx), fx.change, [], "test_contract_honored");
  assert.equal(decision.allowed, false);
  assert.ok(codes(decision.block_reasons).includes("missing_task_test_refs"));
});

withFixture("test contract honored allows mapped test refs", (fx) => {
  const evidences = prepareProposeComplete(fx);
  const decision = guard.check_superspec_gate("demo-change", status(fx), fx.change, evidences, "test_contract_honored");
  assert.equal(decision.allowed, true, JSON.stringify(decision));
});

withFixture("test contract honored requires task invariant refs", (fx) => {
  writeText(join(fx.change, ".superspec", "artifacts", "business-invariants.md"), businessInvariantsText());
  writeText(join(fx.change, ".superspec", "artifacts", "test-contract.md"), testContractText());
  writeText(join(fx.change, "tasks.md"), "- [ ] TASK-001 Implement\n  - test_refs: TEST-001\n");
  const decision = guard.check_superspec_gate("demo-change", status(fx), fx.change, [], "test_contract_honored");
  assert.equal(decision.allowed, false);
  assert.ok(codes(decision.block_reasons).includes("missing_task_invariant_refs"));
});

withFixture("test contract honored requires invariant refs on matching test task", (fx) => {
  writeText(join(fx.change, ".superspec", "artifacts", "business-invariants.md"), businessInvariantsText());
  writeText(join(fx.change, ".superspec", "artifacts", "test-contract.md"), testContractText());
  writeText(join(fx.change, "tasks.md"),
    "- [ ] TASK-001 Different test owns invariant\n" +
      "  - test_refs: TEST-999\n" +
      "  - invariant_refs: INV-001\n" +
      "- [ ] TASK-002 Contract test lacks invariant\n" +
      "  - test_refs: TEST-001\n");
  const decision = guard.check_superspec_gate("demo-change", status(fx), fx.change, [], "test_contract_honored");
  assert.equal(decision.allowed, false);
  assert.ok(codes(decision.block_reasons).includes("missing_task_invariant_refs"));
});

withFixture("task edit requires evidence invariant refs to match test contract row", (fx) => {
  const evidences = prepareProposeComplete(fx);
  writeText(
    join(fx.change, "tasks.md"),
    "- [ ] TASK-001 Implement\n" +
      "  - invariant_refs: INV-001, INV-002\n" +
      "  - test_refs: TEST-001\n",
  );
  const decision = guard.check_task_edit("demo-change", status(fx), fx.change, [
    ...evidences,
    passEvidence("task_edit", "test_run", { task_id: "TASK-001", test_id: "TEST-001", invariant_refs: ["INV-002"], semantic_status: "expected_failure" }),
  ], "TASK-001");
  assert.equal(decision.allowed, false);
  assert.ok(codes(decision.block_reasons).includes("invariant_not_honored"));
});

withFixture("tasks complete blocks parallel write scope conflict", (fx) => {
  writeText(join(fx.change, ".superspec", "artifacts", "test-contract.md"), testContractText("TEST-001", "Scenario A", ""));
  writeText(join(fx.change, "tasks.md"),
    "- [ ] TASK-001 Implement A\n" +
      "  - test_refs: TEST-001\n" +
      "  - parallel_group: G1\n" +
      "  - write_scope: src/service.py\n" +
      "- [ ] TASK-002 Implement B\n" +
      "  - test_refs: TEST-001\n" +
      "  - parallel_group: G1\n" +
      "  - write_scope: src/service.py\n");
  const decision = guard.check_superspec_gate("demo-change", status(fx), fx.change, [], "tasks_complete");
  assert.equal(decision.allowed, false);
  assert.ok(codes(decision.block_reasons).includes("write_scope_conflict"));
});

withFixture("propose complete requires all internal gates", (fx) => {
  const decision = guard.check_superspec_gate("demo-change", status(fx), fx.change, [], "propose_complete");
  assert.equal(decision.allowed, false);
  const decisionCodes = codes(decision.block_reasons);
  assert.ok(decisionCodes.includes("explore_complete_failed"));
  assert.ok(decisionCodes.includes("design_complete_failed"));
  assert.ok(decisionCodes.includes("invariants_reviewed_failed"));
  assert.ok(decisionCodes.includes("test_contract_drafted_failed"));
  assert.ok(decisionCodes.includes("tasks_complete_failed"));
});

withFixture("propose gate aliases map to internal gates", (fx) => {
  const evidences = prepareProposeComplete(fx);
  assert.equal(guard.GATE_ALIASES["propose.apply_ready"], "apply_ready");
  const decision = guard.check_superspec_gate("demo-change", status(fx), fx.change, evidences, "propose.apply_ready");
  assert.equal(decision.allowed, true, JSON.stringify(decision));
});

withFixture("apply-ready blocks until apply isolation is user-confirmed", (fx) => {
  const evidences = prepareProposeComplete(fx).filter((ev) => ev.gate !== "apply_isolation");
  const decision = guard.check_apply_ready("demo-change", status(fx), fx.change, evidences);
  assert.equal(decision.allowed, false, JSON.stringify(decision));
  assert.ok(codes(decision.block_reasons).includes("apply_isolation_unconfirmed"), JSON.stringify(decision.block_reasons));
  const nonUser = prepareProposeComplete(fx).map((ev) => (
    ev.gate === "apply_isolation" ? { ...ev, created_by: "main-thread" } : ev
  ));
  const nonUserDecision = guard.check_apply_ready("demo-change", status(fx), fx.change, nonUser);
  assert.equal(nonUserDecision.allowed, false, JSON.stringify(nonUserDecision));
  assert.ok(codes(nonUserDecision.block_reasons).includes("apply_isolation_unconfirmed"), JSON.stringify(nonUserDecision.block_reasons));
  const aliasDecision = guard.check_superspec_gate("demo-change", status(fx), fx.change, evidences, "propose.apply_ready");
  assert.equal(aliasDecision.allowed, false, JSON.stringify(aliasDecision));
  assert.ok(codes(aliasDecision.block_reasons).includes("apply_isolation_unconfirmed"), JSON.stringify(aliasDecision.block_reasons));
  withRuntime({ load_context: () => [status(fx), fx.repo, fx.change, evidences] }, () => {
    const [ready] = guard.dispatch({ command: "check-apply-ready", change: "demo-change" });
    assert.equal(ready.allowed, false, JSON.stringify(ready));
    assert.ok(codes(ready.block_reasons).includes("apply_isolation_unconfirmed"), JSON.stringify(ready.block_reasons));
    const [enter] = guard.dispatch({ command: "check-enter", change: "demo-change", gate: "apply_ready" });
    assert.equal(enter.allowed, false, JSON.stringify(enter));
    assert.ok(codes(enter.block_reasons).includes("apply_isolation_unconfirmed"), JSON.stringify(enter.block_reasons));
    const [aliasEnter] = guard.dispatch({ command: "check-enter", change: "demo-change", gate: "propose.apply_ready" });
    assert.equal(aliasEnter.allowed, false, JSON.stringify(aliasEnter));
    assert.ok(codes(aliasEnter.block_reasons).includes("apply_isolation_unconfirmed"), JSON.stringify(aliasEnter.block_reasons));
  });
});

withFixture("task edit blocks when propose not complete", (fx) => {
  writeText(join(fx.change, "tasks.md"), "- [ ] TASK-001 Implement\n  - test_refs: TEST-001\n");
  const decision = guard.check_task_edit("demo-change", status(fx), fx.change, [], "TASK-001");
  assert.equal(decision.allowed, false);
  assert.ok(codes(decision.block_reasons).includes("propose_not_complete"));
});

withFixture("task edit after propose complete requires red", (fx) => {
  const decision = guard.check_task_edit("demo-change", status(fx), fx.change, prepareProposeComplete(fx), "TASK-001");
  assert.equal(decision.allowed, false);
  assert.ok(codes(decision.block_reasons).includes("missing_red_evidence"));
});

withFixture("task edit rejects red evidence from wrong gate", (fx) => {
  const evidences = [
    ...prepareProposeComplete(fx),
    passEvidence("review_complete", "test_run", {
      task_id: "TASK-001",
      test_id: "TEST-001",
      invariant_refs: ["INV-001"],
      semantic_status: "expected_failure",
    }),
  ];
  const decision = guard.check_task_edit("demo-change", status(fx), fx.change, evidences, "TASK-001");
  assert.equal(decision.allowed, false);
  assert.ok(codes(decision.block_reasons).includes("missing_red_evidence"));
});

withFixture("task complete after propose complete requires green", (fx) => {
  const evidences = [
    ...prepareProposeComplete(fx),
    passEvidence("task_edit", "test_run", { task_id: "TASK-001", test_id: "TEST-001", invariant_refs: ["INV-001"], semantic_status: "expected_failure" }),
  ];
  const decision = guard.check_task_complete("demo-change", status(fx), fx.change, evidences, "TASK-001");
  assert.equal(decision.allowed, false);
  assert.ok(codes(decision.block_reasons).includes("missing_green_evidence"));
});

withFixture("task complete rejects green evidence from wrong gate", (fx) => {
  const evidences = [
    ...prepareProposeComplete(fx),
    redEvidence(),
    passEvidence("task_edit", "test_run", {
      task_id: "TASK-001",
      test_id: "TEST-001",
      invariant_refs: ["INV-001"],
      semantic_status: "expected_success",
    }),
  ];
  const decision = guard.check_task_complete("demo-change", status(fx), fx.change, evidences, "TASK-001");
  assert.equal(decision.allowed, false);
  assert.ok(codes(decision.block_reasons).includes("missing_green_evidence"));
});

withFixture("task complete requires green for every declared test ref", (fx) => {
  const evidences = prepareProposeComplete(fx);
  writeText(join(fx.change, ".superspec", "artifacts", "test-contract.md"), testContractRowsText([
    { test_id: "TEST-001", scenario: "Scenario A", invariant_refs: "INV-001" },
    { test_id: "TEST-002", scenario: "Scenario A", invariant_refs: "INV-001" },
  ]));
  writeText(
    join(fx.change, "tasks.md"),
    "- [ ] TASK-001 Implement\n" +
      "  - invariant_refs: INV-001\n" +
      "  - test_refs: TEST-001, TEST-002\n",
  );
  const decision = guard.check_task_complete("demo-change", status(fx), fx.change, [
    ...evidences,
    greenEvidence("TASK-001", "TEST-001", ["INV-001"]),
  ], "TASK-001");
  assert.equal(decision.allowed, false);
  assert.ok(codes(decision.block_reasons).includes("missing_declared_test_evidence"));
});

withFixture("task complete allows when every declared test ref has green", (fx) => {
  const evidences = prepareProposeComplete(fx, {
    testContract: testContractRowsText([
      { test_id: "TEST-001", scenario: "Scenario A", invariant_refs: "INV-001" },
      { test_id: "TEST-002", scenario: "Scenario A", invariant_refs: "INV-001" },
    ]),
    tasksText:
      "- [ ] TASK-001 Implement\n" +
      "  - invariant_refs: INV-001\n" +
      "  - test_refs: TEST-001, TEST-002\n",
  });
  const decision = guard.check_task_complete("demo-change", status(fx), fx.change, [
    ...evidences,
    greenEvidence("TASK-001", "TEST-001", ["INV-001"]),
    greenEvidence("TASK-001", "TEST-002", ["INV-001"], { evidence_id: "EV-green-002" }),
  ], "TASK-001");
  assert.equal(decision.allowed, true, JSON.stringify(decision));
});

withFixture("task complete no tdd requires alternative verification", (fx) => {
  const evidences = prepareProposeComplete(fx);
  writeText(join(fx.change, "tasks.md"),
    "- [ ] TASK-001 Docs\n" +
      "  - invariant_refs: INV-001\n" +
      "  - test_refs: TEST-001\n" +
      "  - tdd_required: false\n" +
      "  - no_tdd_reason: documentation-only\n");
  const decision = guard.check_task_complete("demo-change", status(fx), fx.change, evidences, "TASK-001");
  assert.equal(decision.allowed, false);
  assert.ok(codes(decision.block_reasons).includes("missing_alternative_verification"));
});

withFixture("review ready blocks checked task without green", (fx) => {
  const evidences = prepareProposeComplete(fx, { checked: true });
  withRuntime({
    openspec_validate: () => [true, ""],
    dirty_worktree_reasons: () => [],
  }, () => {
    const decision = guard.check_review_ready("demo-change", status(fx), fx.change, evidences);
    assert.equal(decision.allowed, false);
    assert.ok(codes(decision.block_reasons).includes("task_evidence_incomplete"));
    assert.ok(decision.next_allowed_actions.length > 0);
  });
});

withFixture("review ready propagates missing declared test evidence", (fx) => {
  const evidences = prepareProposeComplete(fx, { checked: true });
  writeText(join(fx.change, ".superspec", "artifacts", "test-contract.md"), testContractRowsText([
    { test_id: "TEST-001", scenario: "Scenario A", invariant_refs: "INV-001" },
    { test_id: "TEST-002", scenario: "Scenario A", invariant_refs: "INV-001" },
  ]));
  writeText(
    join(fx.change, "tasks.md"),
    "- [x] TASK-001 Implement\n" +
      "  - invariant_refs: INV-001\n" +
      "  - test_refs: TEST-001, TEST-002\n",
  );
  withRuntime({ openspec_validate: () => [true, ""], dirty_worktree_reasons: () => [] }, () => {
    const decision = guard.check_review_ready("demo-change", status(fx), fx.change, [
      ...evidences,
      greenEvidence("TASK-001", "TEST-001", ["INV-001"]),
    ]);
    assert.equal(decision.allowed, false);
    assert.ok(codes(decision.block_reasons).includes("missing_declared_test_evidence"));
  });
});

withFixture("review ready blocks write scope change without red", (fx) => {
  const evidences = [...prepareProposeComplete(fx, { checked: true }), greenEvidence()];
  writeText(join(fx.change, "tasks.md"), "- [x] TASK-001 Implement\n  - invariant_refs: INV-001\n  - test_refs: TEST-001\n  - write_scope: src/service.py\n");
  withRuntime({
    openspec_validate: () => [true, ""],
    dirty_worktree_reasons: () => [],
    dirty_worktree_paths: () => ["src/service.py"],
  }, () => {
    const decision = guard.check_review_ready("demo-change", status(fx), fx.change, evidences);
    assert.equal(decision.allowed, false);
    assert.ok(codes(decision.block_reasons).includes("missing_red_evidence"));
  });
});

withFixture("review ready allows write scope change with red and green", (fx) => {
  const evidences = [
    ...prepareProposeComplete(fx, {
      checked: true,
      tasksText: "- [x] TASK-001 Implement\n  - invariant_refs: INV-001\n  - test_refs: TEST-001\n  - write_scope: src/service.py\n",
    }),
    passEvidence("task_edit", "test_run", { task_id: "TASK-001", test_id: "TEST-001", invariant_refs: ["INV-001"], semantic_status: "expected_failure" }),
    greenEvidence("TASK-001", "TEST-001", ["INV-001"]),
  ];
  withRuntime({
    openspec_validate: () => [true, ""],
    dirty_worktree_reasons: () => [],
    dirty_worktree_paths: () => ["src/service.py"],
  }, () => {
    const decision = guard.check_review_ready("demo-change", status(fx), fx.change, evidences);
    assert.equal(decision.allowed, true, JSON.stringify(decision));
  });
});
