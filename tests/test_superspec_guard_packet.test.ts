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
import { read_discovery_template } from "../src/packet_render.ts";
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

function isJsonMap(value: unknown): value is JsonMap {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function safeWorkerName(value: string): string {
  return value.replace(/[^A-Za-z0-9_.-]/g, "_");
}

function writePinnedWorkerReportRef(fx: Fixture, role: string, chainId: string, overrides: JsonMap = {}): string {
  const taskId = overrides.task_id ?? "TASK-001";
  const refBasename = safeWorkerName(typeof overrides.ref_basename === "string" && overrides.ref_basename ? overrides.ref_basename : `${role}-${chainId}`);
  const localOverrides = { ...overrides };
  delete localOverrides.ref_basename;
  const declaredTaskWriteScope = Array.isArray(overrides.declared_task_write_scope)
    ? overrides.declared_task_write_scope.map(String).filter(Boolean)
    : ["src/feature.ts"];
  delete localOverrides.declared_task_write_scope;
  const dir = join(fx.change, ".superspec", "reports", "apply", taskId);
  mkdirp(dir);
  const reportRel = `.superspec/reports/apply/${taskId}/${refBasename}-report.json`;
  const refRel = `.superspec/reports/apply/${taskId}/${refBasename}-ref.json`;
  const reportPath = join(fx.change, reportRel);
  const implementationFingerprint = withRuntime(
    { dirty_worktree_paths: () => [] },
    () => guard.apply_worker_implementation_fingerprint(fx.repo, fx.change, [], { declaredTaskWriteScope }),
  );
  const originPacketFingerprint = String(overrides.origin_packet_fingerprint ?? (role === "executor" ? "sha256:executor-packet" : "sha256:packet"));
  const inputRefDigest = String(overrides.input_ref_digest ?? "sha256:input");
  const runtimeRef = `runtime://${role}/${taskId}/${chainId}`;
  const guardArtifactFingerprint = { fingerprint_digest: "sha256:guard-artifact" };
  const roleDefaults: JsonMap = role === "test-runner" ? {
    command: "npm test -- TEST-001",
    command_source: "test_command",
    cwd: fx.repo,
    phase: "green",
    test_id: "TEST-001",
    exit_code: 0,
    semantic_status_candidate: "expected_success",
    result_summary: "TEST-001 passed",
    runtime_raw_transcript_ref: `${runtimeRef}/raw`,
    repo_head: "unknown",
    pre_dirty_state: {},
    post_dirty_state: {},
    changed_files: [],
    untracked_files: [],
    invariant_refs: ["INV-001"],
    source_refs: [{ path: ".superspec/artifacts/test-contract.md" }],
  } : role === "executor" ? {
    cwd: fx.repo,
    repo_head: "unknown",
    changed_files: ["src/feature.ts"],
    suggested_green_checks: ["TEST-001"],
    test_invariant_mapping: { "TEST-001": ["INV-001"] },
    runtime_artifact_refs: [`${runtimeRef}/report`],
    risk_notes: [],
  } : role === "code-reviewer" ? {
    cwd: fx.repo,
    repo_head: "unknown",
    executor_report_ref: isJsonMap(localOverrides.executor_report_ref) ? localOverrides.executor_report_ref : { path: "executor-ref.json" },
    actual_changed_files: ["src/feature.ts"],
    changed_files: ["src/feature.ts"],
    untracked_files: [],
    implementation_dirty_file_list: ["src/feature.ts"],
    implementation_fingerprint: implementationFingerprint,
    guard_artifact_manifest_fingerprint: guardArtifactFingerprint,
    executor_report_mismatch: { status: "none" },
    test_invariant_mapping_verdict: "pass",
    suggested_green_test_ids: ["TEST-001"],
    risk_notes: [],
    runtime_raw_git_status_transcript_ref: `${runtimeRef}/git-status`,
    runtime_raw_git_diff_name_status_transcript_ref: `${runtimeRef}/git-diff-name-status`,
    runtime_path_scoped_diff_transcript_refs: [`${runtimeRef}/path-diff`],
  } : role === "verifier" ? {
    completion_proof_kind: "green_tests",
    pre_edit_proof_kind: "red_or_characterization",
    task_completion_verdict: "pass",
    chain_consistency_verdict: "pass",
    acceptance_coverage_verdict: "pass",
    invariant_coverage_verdict: "pass",
    test_coverage_verdict: "pass",
    cwd: fx.repo,
    repo_head: "unknown",
    expected_freshness_fingerprint: overrides.observed_freshness_fingerprint ?? "sha256:observed",
    freshness_verdict: "pass",
    red_test_run_evidence_refs: ["EV-red-worker"],
    green_test_run_evidence_refs: ["EV-green-worker"],
    executor_report_ref: { path: "executor-ref.json" },
    task_code_review_report_ref: { path: "code-review-ref.json" },
    actual_changed_files: ["src/feature.ts"],
    changed_files: ["src/feature.ts"],
    untracked_files: [],
    implementation_dirty_file_list: ["src/feature.ts"],
    implementation_fingerprint: implementationFingerprint,
    guard_artifact_manifest_fingerprint: guardArtifactFingerprint,
    unexpected_guard_owned_dirty_paths: [],
    executor_code_review_mismatch: { status: "none" },
    test_evidence_mismatch: { status: "none" },
    runtime_raw_git_status_transcript_ref: `${runtimeRef}/git-status`,
    runtime_raw_git_diff_name_status_transcript_ref: `${runtimeRef}/git-diff-name-status`,
    runtime_path_scoped_diff_transcript_refs: [`${runtimeRef}/path-diff`],
    diff_summary_refs: [`${runtimeRef}/diff-summary`],
    risk_notes: [],
    triggered_stop_conditions: [],
  } : {};
  const report: JsonMap = {
    role,
    task_id: taskId,
    apply_worker_chain_id: chainId,
    guard_fingerprint: originPacketFingerprint,
    origin_packet_fingerprint: originPacketFingerprint,
    source_implementation_fingerprint: { fingerprint_digest: "sha256:source" },
    input_ref_digest: inputRefDigest,
    unverified_items: [],
    ok: true,
    ...roleDefaults,
    ...(role === "executor" ? {
      produced_implementation_fingerprint: implementationFingerprint,
    } : {
      observed_implementation_fingerprint: implementationFingerprint,
    }),
    ...(role === "code-reviewer" ? {
      review_status_candidate: "pass",
      scope_verdict: "pass",
      protected_path_verdict: "pass",
    } : {}),
    ...(role === "verifier" ? {
      verification_status_candidate: "pass",
      scope_verdict: "pass",
      protected_path_verdict: "pass",
      observed_freshness_fingerprint: overrides.observed_freshness_fingerprint ?? "sha256:observed",
    } : {}),
    ...localOverrides,
  };
  writeText(reportPath, `${JSON.stringify(report, null, 2)}\n`);
  const reportSize = statSync(reportPath).size;
  writeText(join(fx.change, refRel), `${JSON.stringify({
    root: "change",
    path: reportRel,
    blob_sha: guard.file_blob_sha(reportPath),
    size_bytes: reportSize,
    kind: "worker_report",
    role,
    task_id: taskId,
    created_at: "2026-06-12T00:00:00.000Z",
    worker_chain_context: "executor_worker",
    apply_worker_chain_id: chainId,
    guard_fingerprint: report.guard_fingerprint,
    origin_packet_fingerprint: report.origin_packet_fingerprint,
    source_implementation_fingerprint: report.source_implementation_fingerprint,
    input_ref_digest: report.input_ref_digest,
    ...(role === "executor" ? { produced_implementation_fingerprint: report.produced_implementation_fingerprint } : { observed_implementation_fingerprint: report.observed_implementation_fingerprint }),
    ...(role === "code-reviewer" ? { observed_implementation_fingerprint: report.observed_implementation_fingerprint } : {}),
    ...(role === "verifier" ? { observed_freshness_fingerprint: report.observed_freshness_fingerprint } : {}),
    ...localOverrides,
  }, null, 2)}\n`);
  return refRel;
}

function pinnedWorkerReportObject(fx: Fixture, role: string, chainId: string, overrides: JsonMap = {}): JsonMap {
  return JSON.parse(readFileSync(join(fx.change, writePinnedWorkerReportRef(fx, role, chainId, overrides)), "utf8"));
}

function pinnedRawTranscriptRef(fx: Fixture, chainId: string, taskId = "TASK-001", testId = "TEST-001"): JsonMap {
  const dir = join(fx.change, ".superspec", "raw", "apply", taskId);
  mkdirp(dir);
  const logRel = `.superspec/raw/apply/${taskId}/test-runner-${testId}.log`;
  const logPath = join(fx.change, logRel);
  writeText(logPath, `test runner transcript: ${testId} executed for ${taskId}\n`);
  return {
    root: "change",
    path: logRel,
    blob_sha: guard.file_blob_sha(logPath),
    size_bytes: statSync(logPath).size,
    kind: "raw_transcript",
    role: "test-runner",
    task_id: taskId,
    created_at: "2026-06-12T00:00:00.000Z",
    worker_chain_context: "executor_worker",
    apply_worker_chain_id: chainId,
    guard_fingerprint: "sha256:test-runner-packet",
    origin_packet_fingerprint: "sha256:test-runner-packet",
    input_ref_digest: "sha256:test-runner-input",
    source_implementation_fingerprint: { fingerprint_digest: "sha256:source" },
    observed_implementation_fingerprint: { fingerprint_digest: "sha256:observed" },
    command: `npm test -- ${testId}`,
    cwd: fx.repo,
    phase: "green",
    test_id: testId,
    exit_code: 0,
  };
}

function pinnedStandaloneTestRunnerReportRef(fx: Fixture, taskId = "TASK-001", testId = "TEST-001", phase = "red"): JsonMap {
  const dir = join(fx.change, ".superspec", "reports", "apply", taskId);
  mkdirp(dir);
  const reportRel = `.superspec/reports/apply/${taskId}/test-runner-${phase}-${testId}-report.json`;
  const reportPath = join(fx.change, reportRel);
  const semanticStatus = phase === "red" ? "expected_failure" : "expected_success";
  const exitCode = phase === "red" ? 1 : 0;
  const packetFingerprint = `sha256:test-runner-${phase}-packet`;
  const inputDigest = `sha256:test-runner-${phase}-input`;
  const implementationFingerprint = withRuntime(
    { dirty_worktree_paths: () => [] },
    () => guard.apply_worker_implementation_fingerprint(fx.repo, fx.change),
  );
  writeText(reportPath, `${JSON.stringify({
    role: "test-runner",
    task_id: taskId,
    command: `npm test -- ${testId}`,
    command_source: "test_command",
    cwd: fx.repo,
    phase,
    test_id: testId,
    exit_code: exitCode,
    semantic_status_candidate: semanticStatus,
    result_summary: `${testId} ${phase} completed`,
    runtime_raw_transcript_ref: `runtime://test-runner/${phase}/raw`,
    repo_head: "unknown",
    pre_dirty_state: {},
    post_dirty_state: {},
    changed_files: [],
    untracked_files: [],
    invariant_refs: ["INV-001"],
    source_refs: [{ path: ".superspec/artifacts/test-contract.md" }],
    guard_fingerprint: packetFingerprint,
    origin_packet_fingerprint: packetFingerprint,
    input_ref_digest: inputDigest,
    source_implementation_fingerprint: { fingerprint_digest: "sha256:source" },
    observed_implementation_fingerprint: implementationFingerprint,
    unverified_items: [],
  }, null, 2)}\n`);
  return {
    root: "change",
    path: reportRel,
    blob_sha: guard.file_blob_sha(reportPath),
    size_bytes: statSync(reportPath).size,
    kind: "worker_report",
    role: "test-runner",
    task_id: taskId,
    created_at: "2026-06-12T00:00:00.000Z",
    worker_chain_context: "none",
    guard_fingerprint: packetFingerprint,
    origin_packet_fingerprint: packetFingerprint,
    input_ref_digest: inputDigest,
    source_implementation_fingerprint: { fingerprint_digest: "sha256:source" },
    observed_implementation_fingerprint: implementationFingerprint,
  };
}

function pinnedStandaloneRawTranscriptRef(fx: Fixture, taskId = "TASK-001", testId = "TEST-001", phase = "red"): JsonMap {
  const dir = join(fx.change, ".superspec", "raw", "apply", taskId);
  mkdirp(dir);
  const logRel = `.superspec/raw/apply/${taskId}/test-runner-${phase}-${testId}.log`;
  const logPath = join(fx.change, logRel);
  writeText(logPath, `test runner transcript: ${testId} ${phase} executed for ${taskId}\n`);
  return {
    root: "change",
    path: logRel,
    blob_sha: guard.file_blob_sha(logPath),
    size_bytes: statSync(logPath).size,
    kind: "raw_transcript",
    role: "test-runner",
    task_id: taskId,
    created_at: "2026-06-12T00:00:00.000Z",
    worker_chain_context: "none",
    guard_fingerprint: `sha256:test-runner-${phase}-packet`,
    origin_packet_fingerprint: `sha256:test-runner-${phase}-packet`,
    input_ref_digest: `sha256:test-runner-${phase}-input`,
    source_implementation_fingerprint: { fingerprint_digest: "sha256:source" },
    observed_implementation_fingerprint: { fingerprint_digest: "sha256:observed" },
    command: `npm test -- ${testId}`,
    cwd: fx.repo,
    phase,
    test_id: testId,
    exit_code: phase === "red" ? 1 : 0,
  };
}

function workerRedEvidence(fx: Fixture, overrides: JsonMap = {}): JsonMap {
  const taskId = String(overrides.task_id ?? "TASK-001");
  const testId = String(overrides.test_id ?? "TEST-001");
  const rawLogRef = pinnedStandaloneRawTranscriptRef(fx, taskId, testId, "red");
  const testRunnerReportRef = pinnedStandaloneTestRunnerReportRef(fx, taskId, testId, "red");
  const implementationFingerprint = withRuntime(
    { dirty_worktree_paths: () => [] },
    () => guard.apply_worker_implementation_fingerprint(fx.repo, fx.change, [rawLogRef, testRunnerReportRef], { declaredTaskWriteScope: ["src/feature.ts"] }),
  );
  const guardArtifactFingerprint = guard.apply_worker_guard_artifact_manifest_fingerprint({ raw_log_pinned_refs: [rawLogRef], accepted_test_runner_report_ref: testRunnerReportRef });
  return redEvidence(taskId, testId, ["INV-001"], {
    evidence_id: "EV-red-worker-test-runner",
    phase: "red",
    runner_origin: "test-runner",
    raw_log_refs: [String(rawLogRef.path)],
    accepted_test_runner_report_ref: testRunnerReportRef,
    raw_log_pinned_refs: [rawLogRef],
    command: rawLogRef.command,
    cwd: fx.repo,
    exit_code: 1,
    repo_head: "unknown",
    pre_dirty_state: {},
    post_dirty_state: {},
    changed_files: [],
    untracked_files: [],
    source_refs: [{ path: ".superspec/artifacts/test-contract.md" }],
    guard_fingerprint: "sha256:test-runner-red-packet",
    implementation_fingerprint: implementationFingerprint,
    guard_artifact_manifest_fingerprint: guardArtifactFingerprint,
    ...overrides,
  });
}

function workerCharacterizationEvidence(fx: Fixture, overrides: JsonMap = {}): JsonMap {
  const taskId = String(overrides.task_id ?? "TASK-001");
  const testId = String(overrides.test_id ?? "TEST-001");
  const rawLogRef = pinnedStandaloneRawTranscriptRef(fx, taskId, testId, "characterization");
  const testRunnerReportRef = pinnedStandaloneTestRunnerReportRef(fx, taskId, testId, "characterization");
  const implementationFingerprint = withRuntime(
    { dirty_worktree_paths: () => [] },
    () => guard.apply_worker_implementation_fingerprint(fx.repo, fx.change, [rawLogRef, testRunnerReportRef], { declaredTaskWriteScope: ["src/feature.ts"] }),
  );
  const guardArtifactFingerprint = guard.apply_worker_guard_artifact_manifest_fingerprint({ raw_log_pinned_refs: [rawLogRef], accepted_test_runner_report_ref: testRunnerReportRef });
  return passEvidence("task_edit", "test_run", {
    task_id: taskId,
    test_id: testId,
    invariant_refs: ["INV-001"],
    semantic_status: "expected_success",
    evidence_id: "EV-characterization-worker-test-runner",
    phase: "characterization",
    runner_origin: "test-runner",
    raw_log_refs: [String(rawLogRef.path)],
    accepted_test_runner_report_ref: testRunnerReportRef,
    raw_log_pinned_refs: [rawLogRef],
    command: rawLogRef.command,
    cwd: fx.repo,
    exit_code: 0,
    repo_head: "unknown",
    pre_dirty_state: {},
    post_dirty_state: {},
    changed_files: [],
    untracked_files: [],
    source_refs: [{ path: ".superspec/artifacts/test-contract.md" }],
    guard_fingerprint: "sha256:test-runner-characterization-packet",
    implementation_fingerprint: implementationFingerprint,
    guard_artifact_manifest_fingerprint: guardArtifactFingerprint,
    ...overrides,
  });
}

function workerGreenEvidence(fx: Fixture, chainId = "CHAIN-001", overrides: JsonMap = {}): JsonMap {
  const taskId = String(overrides.task_id ?? "TASK-001");
  const testId = String(overrides.test_id ?? "TEST-001");
  const testRunnerRefBasename = typeof overrides.test_runner_ref_basename === "string" && overrides.test_runner_ref_basename
    ? overrides.test_runner_ref_basename
    : "test-runner";
  const localOverrides = { ...overrides };
  delete localOverrides.test_runner_ref_basename;
  const rawLogRef = pinnedRawTranscriptRef(fx, chainId, taskId, testId);
  const testRunnerReportRef = pinnedWorkerReportObject(fx, "test-runner", chainId, {
    task_id: taskId,
    test_id: testId,
    ref_basename: testRunnerRefBasename,
    command: rawLogRef.command,
    cwd: fx.repo,
    phase: "green",
    exit_code: 0,
    semantic_status_candidate: "expected_success",
    origin_packet_fingerprint: "sha256:test-runner-packet",
    guard_fingerprint: "sha256:test-runner-packet",
  });
  const implementationFingerprint = withRuntime(
    { dirty_worktree_paths: () => [] },
    () => guard.apply_worker_implementation_fingerprint(fx.repo, fx.change, [rawLogRef, testRunnerReportRef], { declaredTaskWriteScope: ["src/feature.ts"] }),
  );
  const guardArtifactFingerprint = guard.apply_worker_guard_artifact_manifest_fingerprint({ raw_log_pinned_refs: [rawLogRef] });
  return greenEvidence(taskId, testId, ["INV-001"], {
    evidence_id: "EV-green-worker",
    phase: "green",
    runner_origin: "test-runner",
    apply_execution_chain: "executor_worker",
    apply_worker_chain_id: chainId,
    raw_log_refs: [String(rawLogRef.path)],
    accepted_test_runner_report_ref: testRunnerReportRef,
    raw_log_pinned_refs: [rawLogRef],
    command: rawLogRef.command,
    cwd: fx.repo,
    exit_code: 0,
    repo_head: "unknown",
    pre_dirty_state: {},
    post_dirty_state: {},
    changed_files: [],
    untracked_files: [],
    source_refs: [{ path: ".superspec/artifacts/test-contract.md" }],
    guard_fingerprint: "sha256:test-runner-packet",
    implementation_fingerprint: implementationFingerprint,
    guard_artifact_manifest_fingerprint: guardArtifactFingerprint,
    ...localOverrides,
  });
}

function pinnedStatusReportRef(fx: Fixture, chainId = "CHAIN-001", taskId = "TASK-001"): JsonMap {
  const dir = join(fx.change, ".superspec", "reports", "apply", taskId);
  mkdirp(dir);
  const reportRel = `.superspec/reports/apply/${taskId}/serial-takeover-baseline.json`;
  const reportPath = join(fx.change, reportRel);
  const implementationFingerprint = withRuntime(
    { dirty_worktree_paths: () => [] },
    () => guard.apply_worker_implementation_fingerprint(fx.repo, fx.change),
  );
  writeText(reportPath, `${JSON.stringify({ task_id: taskId, chain_id: chainId, baseline: true, implementation_fingerprint: implementationFingerprint }, null, 2)}\n`);
  return {
    root: "change",
    path: reportRel,
    blob_sha: guard.file_blob_sha(reportPath),
    size_bytes: statSync(reportPath).size,
    kind: "status_report",
    role: "verifier",
    task_id: taskId,
    created_at: "2026-06-12T00:00:00.000Z",
    worker_chain_context: "executor_worker",
    apply_worker_chain_id: chainId,
    guard_fingerprint: "sha256:verifier-status-packet",
    origin_packet_fingerprint: "sha256:verifier-status-packet",
    input_ref_digest: "sha256:verifier-status-input",
    source_implementation_fingerprint: { fingerprint_digest: "sha256:source" },
    observed_implementation_fingerprint: implementationFingerprint,
  };
}

function serialTakeoverConfirmation(active: JsonMap, baselineRef: JsonMap, overrides: JsonMap = {}): JsonMap {
  return passEvidence("serial_takeover", "human_confirmation", {
    evidence_id: "EV-serial-takeover-confirmation",
    confirmed_refs: [String(active.evidence_id ?? ""), String(baselineRef.path ?? "")].filter(Boolean),
    confirmation_text: "user explicitly authorizes serial takeover from the active worker chain to the pinned baseline",
    ...overrides,
  });
}

function activeChainEvidence(chainId = "CHAIN-001", preEditEvidenceRefs: string[] = ["EV-red-worker"], overrides: JsonMap = {}): JsonMap {
  return passEvidence("task_complete", "apply_worker_chain", {
    evidence_id: `EV-chain-active-${chainId}`,
    task_id: "TASK-001",
    apply_worker_chain_id: chainId,
    chain_state: "active",
    executor_packet_fingerprint: "sha256:executor-packet",
    source_implementation_fingerprint: { fingerprint_digest: "sha256:source" },
    declared_task_write_scope: ["src/feature.ts"],
    pre_edit_evidence_refs: preEditEvidenceRefs,
    ...overrides,
  });
}

function closedChainEvidence(fx: Fixture, chainId = "CHAIN-001", greenEvidenceId = "EV-green-worker", overrides: JsonMap = {}, evidenceContext: JsonMap[] = []): JsonMap {
  const completionProofKind = String(overrides.completion_proof_kind ?? "green_tests");
  const greenEvidenceRefs = Array.isArray(overrides.green_test_run_evidence_refs)
    ? overrides.green_test_run_evidence_refs.map(String).filter(Boolean).sort()
    : (completionProofKind === "green_tests" ? [greenEvidenceId] : []);
  const alternativeEvidenceRefs = Array.isArray(overrides.alternative_verification_evidence_refs)
    ? overrides.alternative_verification_evidence_refs.map(String).filter(Boolean).sort()
    : (typeof overrides.alternative_verification_evidence_ref === "string" ? [overrides.alternative_verification_evidence_ref] : []);
  const active = evidenceContext.find((ev) => ev.kind === "apply_worker_chain" && ev.chain_state === "active" && ev.apply_worker_chain_id === chainId);
  const executorReportRef = isJsonMap(overrides.executor_report_ref)
    ? overrides.executor_report_ref
    : pinnedWorkerReportObject(fx, "executor", chainId, active ? {
      input_ref_digest: guard.apply_worker_executor_input_ref_digest(evidenceContext, active),
    } : {});
  const codeReviewReportRef = isJsonMap(overrides.task_code_review_report_ref)
    ? overrides.task_code_review_report_ref
    : pinnedWorkerReportObject(fx, "code-reviewer", chainId, {
      input_ref_digest: guard.worker_input_ref_digest([executorReportRef]),
      executor_report_ref: executorReportRef,
    });
  const observedFreshness = guard.compute_apply_worker_freshness(fx.repo, fx.change, evidenceContext, "TASK-001", chainId, {
    executor_report_ref: executorReportRef,
    task_code_review_report_ref: codeReviewReportRef,
    ...(completionProofKind === "green_tests" ? {
      green_test_run_evidence_ref: greenEvidenceId,
      green_test_run_evidence_refs: greenEvidenceRefs,
      completion_proof_kind: "green_tests" as const,
    } : {
      alternative_verification_evidence_refs: alternativeEvidenceRefs,
      completion_proof_kind: "alternative_verification" as const,
    }),
  });
  const preEditInputRefs = Array.isArray(active?.pre_edit_evidence_refs)
    ? active.pre_edit_evidence_refs.map((evidenceId: unknown) => {
      const ev = evidenceContext.find((item) => String(item.evidence_id ?? "") === String(evidenceId));
      return ev
        ? { kind: "test_run", evidence_id: String(evidenceId), phase: ev.phase, semantic_status: ev.semantic_status }
        : { kind: "test_run", evidence_id: String(evidenceId) };
    })
    : [];
  const activeInputRef = active ? {
    kind: "apply_worker_chain",
    evidence_id: active.evidence_id,
    task_id: active.task_id,
    apply_worker_chain_id: active.apply_worker_chain_id,
    pre_edit_proof_kind: active.pre_edit_proof_kind ?? "red_or_characterization",
    pre_edit_evidence_refs: Array.isArray(active.pre_edit_evidence_refs) ? active.pre_edit_evidence_refs.map(String).filter(Boolean).sort() : [],
    ...(active.apply_execution_surface !== undefined ? { apply_execution_surface: active.apply_execution_surface } : {}),
    ...(active.tdd_required !== undefined ? { tdd_required: active.tdd_required } : {}),
    ...(active.no_tdd_reason !== undefined ? { no_tdd_reason: active.no_tdd_reason } : {}),
  } : null;
  const verifierInputRefs = completionProofKind === "green_tests"
    ? [
      executorReportRef,
      codeReviewReportRef,
      ...greenEvidenceRefs.map((evidenceId) => ({ kind: "test_run", evidence_id: evidenceId, phase: "green", semantic_status: "expected_success" })),
      ...preEditInputRefs,
    ]
    : [
      executorReportRef,
      codeReviewReportRef,
      ...alternativeEvidenceRefs.map((evidenceId) => {
        const ev = evidenceContext.find((item) => String(item.evidence_id ?? "") === evidenceId);
        return { kind: ev?.kind ?? "alternative_verification", evidence_id: evidenceId, gate: ev?.gate ?? "task_complete", task_id: ev?.task_id ?? "TASK-001" };
      }),
      ...(activeInputRef ? [activeInputRef] : []),
    ];
  const verifierReportRef = pinnedWorkerReportObject(fx, "verifier", chainId, {
    observed_freshness_fingerprint: observedFreshness,
    input_ref_digest: guard.worker_input_ref_digest(verifierInputRefs),
    completion_proof_kind: completionProofKind,
    pre_edit_proof_kind: active?.pre_edit_proof_kind ?? (completionProofKind === "green_tests" ? "red_or_characterization" : "no_tdd_declared"),
    ...(completionProofKind === "green_tests" ? {
      green_test_run_evidence_refs: greenEvidenceRefs,
      red_test_run_evidence_refs: Array.isArray(active?.pre_edit_evidence_refs) ? active.pre_edit_evidence_refs.map(String).filter(Boolean) : ["EV-red-worker"],
    } : {
      green_test_run_evidence_refs: [],
      red_test_run_evidence_refs: [],
      characterization_test_run_evidence_refs: [],
      alternative_verification_evidence_refs: alternativeEvidenceRefs,
      apply_execution_surface: active?.apply_execution_surface ?? "implementation",
      tdd_required: false,
      no_tdd_reason: active?.no_tdd_reason ?? "mechanical-rename",
    }),
  });
  const proofFields = completionProofKind === "green_tests" ? {
    green_test_run_evidence_ref: greenEvidenceId,
    green_test_run_evidence_refs: greenEvidenceRefs,
  } : {
    alternative_verification_evidence_ref: alternativeEvidenceRefs[0],
    alternative_verification_evidence_refs: alternativeEvidenceRefs,
  };
  return passEvidence("task_complete", "apply_worker_chain", {
    evidence_id: `EV-chain-closed-${chainId}`,
    task_id: "TASK-001",
    apply_worker_chain_id: chainId,
    chain_state: "closed",
    completion_proof_kind: completionProofKind,
    executor_report_ref: executorReportRef,
    task_code_review_report_ref: codeReviewReportRef,
    verifier_report_ref: verifierReportRef,
    ...proofFields,
    observed_freshness_fingerprint: observedFreshness,
    ...overrides,
  });
}

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
    "discovery_template",
    "discovery_rules",
    "tasks_structure_hash",
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
      if (item.gate === "explore_complete") {
        assert.equal(typeof payload.discovery_template, "string", item.gate);
        assert.ok(String(payload.discovery_template).includes("## 待确认问题"), item.gate);
        assert.ok(Array.isArray(payload.discovery_rules) && payload.discovery_rules.length > 0, item.gate);
      } else {
        assert.equal(payload.discovery_template, undefined, `${item.gate}: should not carry discovery_template`);
        assert.equal(payload.discovery_rules, undefined, `${item.gate}: should not carry discovery_rules`);
      }
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

test("B read_discovery_template returns packaged template and null for missing path", { concurrency: false }, () => {
  const tpl = read_discovery_template();
  assert.equal(typeof tpl, "string");
  assert.ok(String(tpl).includes("## 待确认问题"));
  assert.ok(String(tpl).includes("- [ ]"));
  // inject an empty dir → null (unreadable path omits the field rather than throwing)
  const tmp = mkdtempSync(join(tmpdir(), "superspec-empty-pkg-"));
  try {
    assert.equal(read_discovery_template(tmp), null);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
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
    assert.equal(reopenedPacket.payload.status, "blocked");
    assert.equal(reopenedExpected.allowed, false);
    assert.deepEqual(reopenedPacket.payload.top_blockers, [...new Set(codes(reopenedExpected.block_reasons))].slice(0, 5));
  });
});

withFixture("apply worker packets render ready and blocked worker prompts", (fx) => {
  const commandContract = [
    "## 测试覆盖矩阵",
    "",
    "| TEST-ID | 关联 REQ/Scenario | 关联 INV |",
    "|---|---|---|",
    "| TEST-001 | Scenario A | INV-001 |",
    "",
    "## 红绿灯契约",
    "",
    "### TEST-001",
    "- `test_command`: <如 mvn test -Dtest=XxxTest#method>",
    "- `expected_red`: missing behavior",
    "- `expected_green`: passes",
    "",
  ].join("\n");
  const evidences = prepareProposeComplete(fx, {
    testContract: commandContract,
    tasksText: "- [ ] TASK-001 Implement\n  - invariant_refs: INV-001\n  - test_refs: TEST-001\n  - write_scope: src/feature.ts\n",
  });
  const red = withRuntime({
    load_context: () => [status(fx), fx.repo, fx.change, evidences],
    dirty_worktree_paths: () => [],
  }, () => captureMainJson([
    "apply-test-packet",
    "--change", "demo-change",
    "--task-id", "TASK-001",
    "--test-id", "TEST-001",
    "--phase", "red",
    "--format", "agent",
  ]));
  assert.equal(red.exitCode, 0);
  assert.equal(red.payload.packet_kind, "apply_test");
  assert.equal(red.payload.worker_state, "ready");
  assert.equal(red.payload.worker_chain_context, "none");
  assert.equal(red.payload.allowed_test_command, "<如 mvn test -Dtest=XxxTest#method>");
  assert.deepEqual(red.payload.expected_worktree_side_effects, []);
  assert.deepEqual(red.payload.required_invariant_refs, ["INV-001"]);

  const redPrompt = withRuntime({
    load_context: () => [status(fx), fx.repo, fx.change, evidences],
    dirty_worktree_paths: () => [],
  }, () => captureMain([
    "apply-test-packet",
    "--change", "demo-change",
    "--task-id", "TASK-001",
    "--test-id", "TEST-001",
    "--phase", "red",
    "--format", "prompt",
  ]));
  assert.equal(redPrompt.exitCode, 0);
  assert.match(redPrompt.stdout, /Do not let the main thread run or forge formal RED\/characterization\/GREEN evidence/u);

  const characterizationPrompt = withRuntime({
    load_context: () => [status(fx), fx.repo, fx.change, evidences],
    dirty_worktree_paths: () => [],
  }, () => captureMain([
    "apply-test-packet",
    "--change", "demo-change",
    "--task-id", "TASK-001",
    "--test-id", "TEST-001",
    "--phase", "characterization",
    "--format", "prompt",
  ]));
  assert.equal(characterizationPrompt.exitCode, 0);
  assert.match(characterizationPrompt.stdout, /Do not let the main thread run or forge formal RED\/characterization\/GREEN evidence/u);

  const workerRed = workerRedEvidence(fx);
  const greenPrompt = withRuntime({
    load_context: () => [status(fx), fx.repo, fx.change, [...evidences, workerRed]],
    dirty_worktree_paths: () => [],
  }, () => captureMain([
    "apply-test-packet",
    "--change", "demo-change",
    "--task-id", "TASK-001",
    "--test-id", "TEST-001",
    "--phase", "green",
    "--format", "prompt",
  ]));
  assert.equal(greenPrompt.exitCode, 0);
  assert.match(greenPrompt.stdout, /^DO NOT SPAWN TEST-RUNNER/u);
  assert.match(greenPrompt.stdout, /task-code-review-report-ref/u);

  const executor = withRuntime({
    load_context: () => [status(fx), fx.repo, fx.change, [...evidences, workerRed]],
    dirty_worktree_paths: () => [],
  }, () => captureMainJson([
    "apply-executor-packet",
    "--change", "demo-change",
    "--task-id", "TASK-001",
    "--format", "agent",
  ]));
  assert.equal(executor.exitCode, 0);
  assert.equal(executor.payload.packet_kind, "apply_executor");
  assert.equal(executor.payload.worker_state, "ready");
  assert.equal(executor.payload.worker_chain_context, "executor_worker");
  assert.ok(executor.payload.apply_worker_chain_id);
  assert.equal(executor.payload.chain_activation_template.kind, "apply_worker_chain");
  assert.equal(executor.payload.chain_activation_template.chain_state, "active");

  const executorPrompt = withRuntime({
    load_context: () => [status(fx), fx.repo, fx.change, [...evidences, workerRed]],
    dirty_worktree_paths: () => [],
  }, () => captureMain([
    "apply-executor-packet",
    "--change", "demo-change",
    "--task-id", "TASK-001",
    "--format", "prompt",
  ]));
  assert.equal(executorPrompt.exitCode, 0);
  assert.match(executorPrompt.stdout, /^DO NOT SPAWN IMPLEMENTATION EXECUTOR/u);
  assert.match(executorPrompt.stdout, /apply-worker-chain-ref/u);

  const activeChain = passEvidence("task_complete", "apply_worker_chain", {
    ...executor.payload.chain_activation_template,
    evidence_id: `EV-chain-active-${executor.payload.apply_worker_chain_id}`,
  });
  const executorReadyPrompt = withRuntime({
    load_context: () => [status(fx), fx.repo, fx.change, [...evidences, workerRed, activeChain]],
    dirty_worktree_paths: () => [],
  }, () => captureMain([
    "apply-executor-packet",
    "--change", "demo-change",
    "--task-id", "TASK-001",
    "--apply-worker-chain-ref", activeChain.evidence_id,
    "--format", "prompt",
  ]));
  assert.equal(executorReadyPrompt.exitCode, 0);
  assert.doesNotMatch(executorReadyPrompt.stdout, /^DO NOT SPAWN IMPLEMENTATION EXECUTOR/u);
  assert.match(executorReadyPrompt.stdout, /CHAIN ACTIVATION VERIFIED FOR IMPLEMENTATION EXECUTOR/u);
  assert.match(executorReadyPrompt.stdout, /chain_activation_template/u);
  assert.match(executorReadyPrompt.stdout, /Packet JSON:/u);

  const scopeMismatchActiveChain = passEvidence("task_complete", "apply_worker_chain", {
    ...executor.payload.chain_activation_template,
    evidence_id: `EV-chain-active-scope-mismatch-${executor.payload.apply_worker_chain_id}`,
    declared_task_write_scope: ["src/other.ts"],
  });
  const scopeMismatchPrompt = withRuntime({
    load_context: () => [status(fx), fx.repo, fx.change, [...evidences, workerRed, scopeMismatchActiveChain]],
    dirty_worktree_paths: () => [],
  }, () => captureMain([
    "apply-executor-packet",
    "--change", "demo-change",
    "--task-id", "TASK-001",
    "--apply-worker-chain-ref", scopeMismatchActiveChain.evidence_id,
    "--format", "prompt",
  ]));
  assert.equal(scopeMismatchPrompt.exitCode, 0);
  assert.match(scopeMismatchPrompt.stdout, /^DO NOT SPAWN IMPLEMENTATION EXECUTOR/u);
  assert.match(scopeMismatchPrompt.stdout, /declared_task_write_scope mismatch/u);

  const preEditMismatchEvidenceId = `EV-chain-active-pre-edit-mismatch-${executor.payload.apply_worker_chain_id}`;
  const preEditMismatchActiveChain = passEvidence("task_complete", "apply_worker_chain", {
    ...executor.payload.chain_activation_template,
    evidence_id: preEditMismatchEvidenceId,
    pre_edit_evidence_refs: [preEditMismatchEvidenceId],
  });
  const preEditMismatchPrompt = withRuntime({
    load_context: () => [status(fx), fx.repo, fx.change, [...evidences, workerRed, preEditMismatchActiveChain]],
    dirty_worktree_paths: () => [],
  }, () => captureMain([
    "apply-executor-packet",
    "--change", "demo-change",
    "--task-id", "TASK-001",
    "--apply-worker-chain-ref", preEditMismatchActiveChain.evidence_id,
    "--format", "prompt",
  ]));
  assert.equal(preEditMismatchPrompt.exitCode, 0);
  assert.match(preEditMismatchPrompt.stdout, /^DO NOT SPAWN IMPLEMENTATION EXECUTOR/u);
  assert.match(preEditMismatchPrompt.stdout, /pre_edit_evidence_refs mismatch/u);
});

withFixture("apply-executor-packet exposes apply execution surface", (fx) => {
  const implementationEvidences = prepareProposeComplete(fx, {
    tasksText:
      "- [ ] TASK-001 Implement\n" +
      "  - invariant_refs: INV-001\n" +
      "  - test_refs: TEST-001\n" +
      "  - write_scope: src/feature.ts\n",
  });
  const implementationRed = workerRedEvidence(fx, {
    evidence_id: "EV-red-implementation-surface",
  });
  const implementation = withRuntime({
    load_context: () => [status(fx), fx.repo, fx.change, [...implementationEvidences, implementationRed]],
    dirty_worktree_paths: () => [],
  }, () => captureMainJson([
    "apply-executor-packet",
    "--change", "demo-change",
    "--task-id", "TASK-001",
    "--format", "agent",
  ]));
  assert.equal(implementation.exitCode, 0);
  assert.equal(implementation.payload.apply_execution_surface, "implementation");
  assert.equal(implementation.payload.worker_state, "ready", JSON.stringify(implementation.payload.block_reasons ?? []));
  assert.deepEqual(implementation.payload.declared_task_write_scope, ["src/feature.ts"]);

  const noTddImplementationEvidences = prepareProposeComplete(fx, {
    tasksText:
      "- [ ] TASK-001 Implement without TDD\n" +
      "  - invariant_refs: INV-001\n" +
      "  - test_refs: TEST-001\n" +
      "  - write_scope: src/feature.ts\n" +
      "  - tdd_required: false\n" +
      "  - no_tdd_reason: mechanical-rename\n",
  });
  const noTddImplementation = withRuntime({
    load_context: () => [status(fx), fx.repo, fx.change, noTddImplementationEvidences],
    dirty_worktree_paths: () => [],
  }, () => captureMainJson([
    "apply-executor-packet",
    "--change", "demo-change",
    "--task-id", "TASK-001",
    "--format", "agent",
  ]));
  assert.equal(noTddImplementation.exitCode, 0);
  assert.equal(noTddImplementation.payload.apply_execution_surface, "implementation");
  assert.equal(noTddImplementation.payload.worker_state, "ready", JSON.stringify(noTddImplementation.payload.block_reasons ?? []));
  assert.equal(noTddImplementation.payload.chain_activation_template.pre_edit_proof_kind, "no_tdd_declared");
  assert.deepEqual(noTddImplementation.payload.chain_activation_template.pre_edit_evidence_refs, []);
  assert.equal(noTddImplementation.payload.chain_activation_template.tdd_required, false);
  assert.equal(noTddImplementation.payload.chain_activation_template.no_tdd_reason, "mechanical-rename");

  const noCodeEvidences = prepareProposeComplete(fx, {
    tasksText:
      "- [ ] TASK-001 No code\n" +
      "  - invariant_refs: INV-001\n" +
      "  - test_refs: TEST-001\n" +
      "  - tdd_required: false\n" +
      "  - no_tdd_reason: non-executable-spec-change\n" +
      "  - apply_execution_surface: no_code\n",
  });
  const noCode = withRuntime({
    load_context: () => [status(fx), fx.repo, fx.change, noCodeEvidences],
    dirty_worktree_paths: () => [],
  }, () => captureMainJson([
    "apply-executor-packet",
    "--change", "demo-change",
    "--task-id", "TASK-001",
    "--format", "agent",
  ]));
  assert.equal(noCode.exitCode, 0);
  assert.equal(noCode.payload.apply_execution_surface, "no_code");
  assert.ok(noCode.payload.blockers.includes("executor_handoff_not_required"), JSON.stringify(noCode.payload.block_reasons));
});

withFixture("apply-test-packet blocks missing or untrusted test contract commands", (fx) => {
  const prefixCollisionContract = [
    "## 测试覆盖矩阵",
    "",
    "| TEST-ID | 关联 REQ/Scenario | 关联 INV |",
    "|---|---|---|",
    "| TEST-001 | Scenario A | INV-001 |",
    "",
    "## 红绿灯契约",
    "",
    "### TEST-001-A",
    "- `test_command`: npm test -- TEST-001-A",
    "",
    "### TEST-001",
    "- `test_command`: npm test -- TEST-001",
    "",
  ].join("\n");
  const prefixCollisionEvidences = prepareProposeComplete(fx, {
    testContract: prefixCollisionContract,
    tasksText: "- [ ] TASK-001 Implement\n  - invariant_refs: INV-001\n  - test_refs: TEST-001\n  - write_scope: src/feature.ts\n",
  });
  const prefixCollision = withRuntime({
    load_context: () => [status(fx), fx.repo, fx.change, prefixCollisionEvidences],
  }, () => captureMainJson([
    "apply-test-packet",
    "--change", "demo-change",
    "--task-id", "TASK-001",
    "--test-id", "TEST-001",
    "--phase", "red",
    "--format", "agent",
  ]));
  assert.equal(prefixCollision.payload.worker_state, "ready");
  assert.equal(prefixCollision.payload.allowed_test_command, "npm test -- TEST-001");

  const noCommandContract = [
    "## 测试覆盖矩阵",
    "",
    "| TEST-ID | 关联 REQ/Scenario | 关联 INV |",
    "|---|---|---|",
    "| TEST-001 | Scenario A | INV-001 |",
    "",
    "## 红绿灯契约",
    "",
    "### TEST-001",
    "- `expected_red`: missing behavior",
    "- `expected_green`: passes",
    "",
  ].join("\n");
  const evidences = prepareProposeComplete(fx, { testContract: noCommandContract });
  const blocked = withRuntime({
    load_context: () => [status(fx), fx.repo, fx.change, evidences],
  }, () => captureMainJson([
    "apply-test-packet",
    "--change", "demo-change",
    "--task-id", "TASK-001",
    "--test-id", "TEST-001",
    "--phase", "red",
    "--format", "agent",
  ]));
  assert.equal(blocked.exitCode, 0);
  assert.equal(blocked.payload.worker_state, "blocked");
  assert.ok(blocked.payload.blockers.includes("missing_test_command"));
});

withFixture("RED evidence must match expected failure signature and classifier", (fx) => {
  prepareProposeComplete(fx, {
    testContract: [
      "## 测试覆盖矩阵",
      "",
      "| TEST-ID | 关联 REQ/Scenario | 关联 INV |",
      "|---|---|---|",
      "| TEST-001 | Scenario A | INV-001 |",
      "",
      "## 红绿灯契约",
      "",
      "### TEST-001",
      "- `test_command`: npm test -- TEST-001",
      "- `expected_failure_signature`: AssertionError: expected missing behavior",
      "- `expected_failure_classifier`: assertion",
      "",
    ].join("\n"),
  });
  const wrongLogRel = ".superspec/raw/apply/TASK-001/red-wrong-signature.log";
  writeText(join(fx.change, wrongLogRel), "TEST-001 failed because module import exploded\n");
  const wrongSignature = redEvidence("TASK-001", "TEST-001", ["INV-001"], {
    raw_log_refs: [wrongLogRel],
    expected_failure_signature: "AssertionError: expected missing behavior",
    expected_failure_classifier: "assertion",
  });
  const wrongProblems = guard.validate_evidence_schema(wrongSignature, "demo-change", fx.change, fx.repo);
  assert.ok(codes(wrongProblems).includes("test_run_wrong_failure_reason"), JSON.stringify(wrongProblems));

  const rightLogRel = ".superspec/raw/apply/TASK-001/red-right-signature.log";
  writeText(join(fx.change, rightLogRel), "TEST-001 AssertionError: expected missing behavior\n");
  const wrongClassifier = redEvidence("TASK-001", "TEST-001", ["INV-001"], {
    raw_log_refs: [rightLogRel],
    expected_failure_signature: "AssertionError: expected missing behavior",
    expected_failure_classifier: "environment",
  });
  const classifierProblems = guard.validate_evidence_schema(wrongClassifier, "demo-change", fx.change, fx.repo);
  assert.ok(codes(classifierProblems).includes("test_run_wrong_failure_reason"), JSON.stringify(classifierProblems));

  const ok = redEvidence("TASK-001", "TEST-001", ["INV-001"], {
    raw_log_refs: [rightLogRel],
    expected_failure_signature: "AssertionError: expected missing behavior",
    expected_failure_classifier: "assertion",
  });
  assert.equal(codes(guard.validate_evidence_schema(ok, "demo-change", fx.change, fx.repo)).includes("test_run_wrong_failure_reason"), false);
});

withFixture("non-chain test-runner red evidence remains valid for task_edit", (fx) => {
  const evidences = prepareProposeComplete(fx, {
    tasksText: "- [ ] TASK-001 Implement\n  - invariant_refs: INV-001\n  - test_refs: TEST-001\n  - write_scope: src/feature.ts\n",
  });
  const red = workerRedEvidence(fx);
  const problems = guard.validate_evidence_schema(red, "demo-change", fx.change, fx.repo);
  assert.equal(codes(problems).includes("test_run_worker_ref_missing"), false, JSON.stringify(problems));
  assert.equal(codes(problems).includes("test_run_runner_origin_invalid"), false, JSON.stringify(problems));
  const decision = guard.check_task_edit("demo-change", status(fx), fx.change, [...evidences, red], "TASK-001");
  assert.equal(decision.allowed, true, JSON.stringify(decision.block_reasons));
});

withFixture("non-chain test-runner characterization evidence remains valid for task_edit", (fx) => {
  const evidences = prepareProposeComplete(fx, {
    tasksText:
      "- [ ] TASK-001 Refactor\n" +
      "  - invariant_refs: INV-001\n" +
      "  - test_refs: TEST-001\n" +
      "  - write_scope: src/feature.ts\n" +
      "  - tdd_mode: behavior-preserving-refactor\n",
  });
  const characterization = workerCharacterizationEvidence(fx);
  const problems = guard.validate_evidence_schema(characterization, "demo-change", fx.change, fx.repo);
  assert.equal(codes(problems).includes("test_run_worker_ref_missing"), false, JSON.stringify(problems));
  assert.equal(codes(problems).includes("test_run_runner_origin_invalid"), false, JSON.stringify(problems));
  const decision = guard.check_task_edit("demo-change", status(fx), fx.change, [...evidences, characterization], "TASK-001");
  assert.equal(decision.allowed, true, JSON.stringify(decision.block_reasons));
});

withFixture("worker test_run evidence must match accepted report and raw transcript refs", (fx) => {
  const green = workerGreenEvidence(fx, "CHAIN-001");
  const okProblems = guard.validate_evidence_schema(green, "demo-change", fx.change, fx.repo);
  assert.equal(codes(okProblems).includes("test_run_worker_ref_missing"), false, JSON.stringify(okProblems));

  for (const [field, value] of [
    ["test_id", "TEST-002"],
    ["phase", "red"],
    ["exit_code", 1],
    ["guard_fingerprint", "sha256:wrong-test-runner-packet"],
    ["source_refs", [{ path: ".superspec/artifacts/other-contract.md" }]],
    ["pre_dirty_state", { dirty: true }],
    ["changed_files", ["src/other.ts"]],
  ] as const) {
    const bad = { ...green, evidence_id: `EV-green-worker-${field}-mismatch`, [field]: value };
    const problems = guard.validate_evidence_schema(bad, "demo-change", fx.change, fx.repo);
    assert.ok(codes(problems).includes("test_run_worker_ref_missing"), `${field}: ${JSON.stringify(problems)}`);
  }
});

withFixture("apply worker downstream packets validate active chain and typed refs", (fx) => {
  const chainId = "CHAIN-001";
  const commandContract = [
    "## 测试覆盖矩阵",
    "",
    "| TEST-ID | 关联 REQ/Scenario | 关联 INV |",
    "|---|---|---|",
    "| TEST-001 | Scenario A | INV-001 |",
    "",
    "## 红绿灯契约",
    "",
    "### TEST-001",
    "- `test_command`: npm test -- --test-name-pattern=TEST-001",
    "- `expected_red`: missing behavior",
    "- `expected_green`: passes",
    "",
  ].join("\n");
  const base = prepareProposeComplete(fx, {
    testContract: commandContract,
    tasksText: "- [ ] TASK-001 Implement\n  - invariant_refs: INV-001\n  - test_refs: TEST-001\n  - write_scope: src/feature.ts\n",
  });
  writeText(join(fx.change, DEFAULT_RUN_LOG), "test run output: TEST-001 executed\n");
  const red = workerRedEvidence(fx, {
    evidence_id: "EV-red-worker",
  });
  const green = workerGreenEvidence(fx, chainId, { test_runner_ref_basename: "test-runner-green-main" });
  const chain = activeChainEvidence(chainId);
  const executorRef = writePinnedWorkerReportRef(fx, "executor", chainId, {
    input_ref_digest: guard.apply_worker_executor_input_ref_digest([...base, red, chain], chain),
  });
  const executorRefObject = readJson(join(fx.change, executorRef));
  const codeReviewRef = writePinnedWorkerReportRef(fx, "code-reviewer", chainId, {
    input_ref_digest: guard.worker_input_ref_digest([executorRefObject]),
    executor_report_ref: executorRefObject,
  });
  const wrongRoleRef = writePinnedWorkerReportRef(fx, "code-reviewer", chainId, { ref_basename: "wrong-role", executor_report_ref: executorRefObject });
  const missingObservedCodeReviewRef = writePinnedWorkerReportRef(fx, "code-reviewer", chainId, {
    ref_basename: "code-reviewer-missing-observed",
    input_ref_digest: guard.worker_input_ref_digest([executorRefObject]),
    executor_report_ref: executorRefObject,
    observed_implementation_fingerprint: undefined,
  });

  const greenReady = withRuntime({
    load_context: () => [status(fx), fx.repo, fx.change, [...base, red, chain]],
    dirty_worktree_paths: () => [],
  }, () => captureMainJson([
    "apply-test-packet",
    "--change", "demo-change",
    "--task-id", "TASK-001",
    "--test-id", "TEST-001",
    "--phase", "green",
    "--task-code-review-report-ref", codeReviewRef,
    "--format", "agent",
  ]));
  assert.equal(greenReady.exitCode, 0);
  assert.equal(greenReady.payload.worker_state, "ready");
  assert.equal(greenReady.payload.apply_worker_chain_id, chainId);
  assert.ok(greenReady.payload.post_code_review_worktree_fingerprint?.fingerprint_digest);

  const staleExecutorInputObject = pinnedWorkerReportObject(fx, "executor", chainId, {
    ref_basename: "executor-stale-for-green",
    input_ref_digest: "sha256:stale-executor-input",
  });
  const staleExecutorBoundCodeReviewRef = writePinnedWorkerReportRef(fx, "code-reviewer", chainId, {
    ref_basename: "code-reviewer-stale-executor-binding",
    input_ref_digest: guard.worker_input_ref_digest([staleExecutorInputObject]),
    executor_report_ref: staleExecutorInputObject,
  });
  const greenStaleExecutorBinding = withRuntime({
    load_context: () => [status(fx), fx.repo, fx.change, [...base, red, chain]],
    dirty_worktree_paths: () => [],
  }, () => captureMainJson([
    "apply-test-packet",
    "--change", "demo-change",
    "--task-id", "TASK-001",
    "--test-id", "TEST-001",
    "--phase", "green",
    "--task-code-review-report-ref", staleExecutorBoundCodeReviewRef,
    "--format", "agent",
  ]));
  assert.equal(greenStaleExecutorBinding.payload.worker_state, "blocked");
  assert.ok(greenStaleExecutorBinding.payload.blockers.includes("worker_report_input_ref_mismatch"));

  const redWithCodeReviewRef = withRuntime({
    load_context: () => [status(fx), fx.repo, fx.change, base],
    dirty_worktree_paths: () => [],
  }, () => captureMainJson([
    "apply-test-packet",
    "--change", "demo-change",
    "--task-id", "TASK-001",
    "--test-id", "TEST-001",
    "--phase", "red",
    "--task-code-review-report-ref", codeReviewRef,
    "--format", "agent",
  ]));
  assert.equal(redWithCodeReviewRef.payload.worker_state, "blocked");
  assert.ok(redWithCodeReviewRef.payload.blockers.includes("unexpected_task_code_review_report_ref"));

  const staleCodeReviewRef = writePinnedWorkerReportRef(fx, "code-reviewer", chainId, {
    ref_basename: "code-reviewer-stale",
    input_ref_digest: guard.worker_input_ref_digest([executorRefObject]),
    executor_report_ref: executorRefObject,
    observed_implementation_fingerprint: { fingerprint_digest: "sha256:stale-implementation" },
  });
  const greenStaleCodeReview = withRuntime({
    load_context: () => [status(fx), fx.repo, fx.change, [...base, red, chain]],
    dirty_worktree_paths: () => [],
  }, () => captureMainJson([
    "apply-test-packet",
    "--change", "demo-change",
    "--task-id", "TASK-001",
    "--test-id", "TEST-001",
    "--phase", "green",
    "--task-code-review-report-ref", staleCodeReviewRef,
    "--format", "agent",
  ]));
  assert.equal(greenStaleCodeReview.payload.worker_state, "blocked");
  assert.ok(greenStaleCodeReview.payload.blockers.includes("post_code_review_worktree_fingerprint_mismatch"));

  const badPreEditChainId = "CHAIN-BAD-PRE-EDIT";
  const badPreEditGreen = greenEvidence("TASK-001", "TEST-001", ["INV-001"], {
    evidence_id: "EV-green-bad-pre-edit",
    phase: "green",
  });
  const badPreEditChain = activeChainEvidence(badPreEditChainId, ["EV-green-bad-pre-edit"]);
  const badPreEditExecutorRef = writePinnedWorkerReportRef(fx, "executor", badPreEditChainId, {
    ref_basename: "executor-bad-pre-edit",
    input_ref_digest: guard.apply_worker_executor_input_ref_digest([...base, red, badPreEditGreen, badPreEditChain], badPreEditChain),
  });
  const badPreEditExecutorRefObject = readJson(join(fx.change, badPreEditExecutorRef));
  const badPreEditCodeReviewRef = writePinnedWorkerReportRef(fx, "code-reviewer", badPreEditChainId, {
    ref_basename: "code-reviewer-bad-pre-edit",
    input_ref_digest: guard.worker_input_ref_digest([badPreEditExecutorRefObject]),
    executor_report_ref: badPreEditExecutorRefObject,
  });
  const greenBadPreEditActive = withRuntime({
    load_context: () => [status(fx), fx.repo, fx.change, [...base, red, badPreEditGreen, badPreEditChain]],
    dirty_worktree_paths: () => [],
  }, () => captureMainJson([
    "apply-test-packet",
    "--change", "demo-change",
    "--task-id", "TASK-001",
    "--test-id", "TEST-001",
    "--phase", "green",
    "--task-code-review-report-ref", badPreEditCodeReviewRef,
    "--format", "agent",
  ]));
  assert.equal(greenBadPreEditActive.payload.worker_state, "blocked");
  assert.ok(greenBadPreEditActive.payload.blockers.includes("apply_worker_chain_active_invalid"));

  const codeReviewBadPreEditActive = withRuntime({
    load_context: () => [status(fx), fx.repo, fx.change, [...base, red, badPreEditGreen, badPreEditChain]],
    dirty_worktree_paths: () => [],
  }, () => captureMainJson([
    "apply-code-review-packet",
    "--change", "demo-change",
    "--task-id", "TASK-001",
    "--executor-report-ref", badPreEditExecutorRef,
    "--format", "agent",
  ]));
  assert.equal(codeReviewBadPreEditActive.payload.worker_state, "blocked");
  assert.ok(codeReviewBadPreEditActive.payload.blockers.includes("apply_worker_chain_active_invalid"));

  const greenMissingObservedCodeReview = withRuntime({
    load_context: () => [status(fx), fx.repo, fx.change, [...base, red, chain]],
    dirty_worktree_paths: () => [],
  }, () => captureMainJson([
    "apply-test-packet",
    "--change", "demo-change",
    "--task-id", "TASK-001",
    "--test-id", "TEST-001",
    "--phase", "green",
    "--task-code-review-report-ref", missingObservedCodeReviewRef,
    "--format", "agent",
  ]));
  assert.equal(greenMissingObservedCodeReview.payload.worker_state, "blocked");
  assert.ok(greenMissingObservedCodeReview.payload.blockers.includes("pinned_artifact_ref_invalid"));
  assert.ok(greenMissingObservedCodeReview.payload.blockers.includes("post_code_review_worktree_fingerprint_missing"));

  const missingActive = withRuntime({
    load_context: () => [status(fx), fx.repo, fx.change, [...base, red]],
    dirty_worktree_paths: () => [],
  }, () => captureMainJson([
    "apply-test-packet",
    "--change", "demo-change",
    "--task-id", "TASK-001",
    "--test-id", "TEST-001",
    "--phase", "green",
    "--task-code-review-report-ref", codeReviewRef,
    "--format", "agent",
  ]));
  assert.equal(missingActive.payload.worker_state, "blocked");
  assert.ok(missingActive.payload.blockers.includes("missing_apply_worker_chain_active"));

  const invalidTerminal = withRuntime({
    dirty_worktree_paths: () => [],
  }, () => closedChainEvidence(fx, chainId, "EV-green-worker", {
    evidence_id: "EV-chain-closed-invalid-packet-entry",
    observed_freshness_fingerprint: "sha256:mismatch",
  }, [...base, red, green, chain]));
  const executorInvalidTerminal = withRuntime({
    load_context: () => [status(fx), fx.repo, fx.change, [...base, red, green, chain, invalidTerminal]],
    dirty_worktree_paths: () => [],
  }, () => captureMainJson([
    "apply-executor-packet",
    "--change", "demo-change",
    "--task-id", "TASK-001",
    "--format", "agent",
  ]));
  assert.equal(executorInvalidTerminal.payload.worker_state, "blocked");
  assert.ok(executorInvalidTerminal.payload.blockers.includes("apply_worker_chain_terminal_invalid"), JSON.stringify(executorInvalidTerminal.payload));

  const greenInvalidTerminal = withRuntime({
    load_context: () => [status(fx), fx.repo, fx.change, [...base, red, green, chain, invalidTerminal]],
    dirty_worktree_paths: () => [],
  }, () => captureMainJson([
    "apply-test-packet",
    "--change", "demo-change",
    "--task-id", "TASK-001",
    "--test-id", "TEST-001",
    "--phase", "green",
    "--task-code-review-report-ref", codeReviewRef,
    "--format", "agent",
  ]));
  assert.equal(greenInvalidTerminal.payload.worker_state, "blocked");
  assert.ok(greenInvalidTerminal.payload.blockers.includes("apply_worker_chain_terminal_invalid"), JSON.stringify(greenInvalidTerminal.payload));

  const validTerminal = withRuntime({
    dirty_worktree_paths: () => [],
  }, () => closedChainEvidence(fx, chainId, "EV-green-worker", {
    evidence_id: "EV-chain-closed-valid-packet-entry",
  }, [...base, red, green, chain]));
  const executorAfterValidTerminal = withRuntime({
    load_context: () => [status(fx), fx.repo, fx.change, [...base, red, green, chain, validTerminal]],
    dirty_worktree_paths: () => [],
  }, () => captureMainJson([
    "apply-executor-packet",
    "--change", "demo-change",
    "--task-id", "TASK-001",
    "--format", "agent",
  ]));
  assert.equal(executorAfterValidTerminal.payload.worker_state, "ready", JSON.stringify(executorAfterValidTerminal.payload));
  assert.equal(executorAfterValidTerminal.payload.blockers, undefined);
  assert.notEqual(executorAfterValidTerminal.payload.apply_worker_chain_id, chainId);

  const duplicateActivePacket = withRuntime({
    load_context: () => [status(fx), fx.repo, fx.change, [
      ...base,
      red,
      chain,
      { ...activeChainEvidence(chainId), evidence_id: "EV-chain-active-duplicate-packet-entry" },
    ]],
    dirty_worktree_paths: () => [],
  }, () => captureMainJson([
    "apply-code-review-packet",
    "--change", "demo-change",
    "--task-id", "TASK-001",
    "--executor-report-ref", executorRef,
    "--format", "agent",
  ]));
  assert.equal(duplicateActivePacket.payload.worker_state, "blocked");
  assert.ok(duplicateActivePacket.payload.blockers.includes("apply_worker_chain_active_conflict"), JSON.stringify(duplicateActivePacket.payload));

  const parallelActivePacket = withRuntime({
    load_context: () => [status(fx), fx.repo, fx.change, [...base, red, chain, activeChainEvidence("CHAIN-PARALLEL-PACKET")]],
    dirty_worktree_paths: () => [],
  }, () => captureMainJson([
    "apply-verify-packet",
    "--change", "demo-change",
    "--task-id", "TASK-001",
    "--executor-report-ref", executorRef,
    "--task-code-review-report-ref", codeReviewRef,
    "--green-test-run-evidence-ref", "EV-green-worker",
    "--red-test-run-evidence-ref", "EV-red-worker",
    "--format", "agent",
  ]));
  assert.equal(parallelActivePacket.payload.worker_state, "blocked");
  assert.ok(parallelActivePacket.payload.blockers.includes("apply_worker_chain_active_conflict"), JSON.stringify(parallelActivePacket.payload));

  const codeReviewReady = withRuntime({
    load_context: () => [status(fx), fx.repo, fx.change, [...base, red, chain]],
    dirty_worktree_paths: () => [],
  }, () => captureMainJson([
    "apply-code-review-packet",
    "--change", "demo-change",
    "--task-id", "TASK-001",
    "--executor-report-ref", executorRef,
    "--format", "agent",
  ]));
  assert.equal(codeReviewReady.payload.worker_state, "ready");
  assert.equal(codeReviewReady.payload.apply_worker_chain_id, chainId);
  assert.deepEqual(codeReviewReady.payload.task_test_refs, ["TEST-001"]);
  assert.deepEqual(codeReviewReady.payload.task_invariant_refs, ["INV-001"]);
  assert.ok(codeReviewReady.payload.task_content_ref);
  assert.ok(Array.isArray(codeReviewReady.payload.current_worktree_refs));
  assert.ok(Array.isArray(codeReviewReady.payload.code_review_checks));
  assert.equal(typeof codeReviewReady.payload.scope_diff_review_policy, "object");

  const staleCodeReview = withRuntime({
    load_context: () => [status(fx), fx.repo, fx.change, [...base, red, chain]],
    dirty_worktree_paths: () => [],
  }, () => captureMainJson([
    "apply-test-packet",
    "--change", "demo-change",
    "--task-id", "TASK-001",
    "--test-id", "TEST-001",
    "--phase", "green",
    "--task-code-review-report-ref", ".superspec/reports/apply/TASK-001/missing-ref.json",
    "--format", "agent",
  ]));
  assert.equal(staleCodeReview.payload.worker_state, "blocked");
  assert.ok(staleCodeReview.payload.blockers.includes("ref_not_readable"));

  const codeReviewWrongRole = withRuntime({
    load_context: () => [status(fx), fx.repo, fx.change, [...base, red, chain]],
    dirty_worktree_paths: () => [],
  }, () => captureMainJson([
    "apply-code-review-packet",
    "--change", "demo-change",
    "--task-id", "TASK-001",
    "--executor-report-ref", wrongRoleRef,
    "--format", "agent",
  ]));
  assert.equal(codeReviewWrongRole.payload.worker_state, "blocked");
  assert.ok(codeReviewWrongRole.payload.blockers.includes("pinned_artifact_ref_invalid"));

  const forgedGreenEvidenceRef = ".superspec/reports/apply/TASK-001/forged-green-evidence-ref.json";
  writeText(join(fx.change, forgedGreenEvidenceRef), `${JSON.stringify({
    kind: "test_run",
    task_id: "TASK-001",
    evidence_id: "EV-green-worker",
    phase: "green",
    semantic_status: "expected_success",
    apply_execution_chain: "executor_worker",
    apply_worker_chain_id: chainId,
  }, null, 2)}\n`);
  const verifyForgedGreenRef = withRuntime({
    load_context: () => [status(fx), fx.repo, fx.change, [...base, red, green, chain]],
    dirty_worktree_paths: () => [],
  }, () => captureMainJson([
    "apply-verify-packet",
    "--change", "demo-change",
    "--task-id", "TASK-001",
    "--executor-report-ref", executorRef,
    "--task-code-review-report-ref", codeReviewRef,
    "--green-test-run-evidence-ref", forgedGreenEvidenceRef,
    "--red-test-run-evidence-ref", "EV-red-worker",
    "--format", "agent",
  ]));
  assert.equal(verifyForgedGreenRef.payload.worker_state, "blocked");
  assert.ok(verifyForgedGreenRef.payload.blockers.includes("pinned_evidence_ref_invalid"));

  const unrelatedRed = workerRedEvidence(fx, {
    evidence_id: "EV-red-unrelated",
    test_id: "TEST-UNRELATED",
  });
  const verifyWrongPreEdit = withRuntime({
    load_context: () => [status(fx), fx.repo, fx.change, [...base, red, unrelatedRed, green, chain]],
    dirty_worktree_paths: () => [],
  }, () => captureMainJson([
    "apply-verify-packet",
    "--change", "demo-change",
    "--task-id", "TASK-001",
    "--executor-report-ref", executorRef,
    "--task-code-review-report-ref", codeReviewRef,
    "--green-test-run-evidence-ref", "EV-green-worker",
    "--red-test-run-evidence-ref", "EV-red-unrelated",
    "--format", "agent",
  ]));
  assert.equal(verifyWrongPreEdit.payload.worker_state, "blocked", JSON.stringify(verifyWrongPreEdit.payload));
  assert.ok(verifyWrongPreEdit.payload.blockers.includes("pinned_evidence_ref_invalid"));

  const verifyMissingObservedCodeReview = withRuntime({
    load_context: () => [status(fx), fx.repo, fx.change, [...base, red, green, chain]],
    dirty_worktree_paths: () => [],
  }, () => captureMainJson([
    "apply-verify-packet",
    "--change", "demo-change",
    "--task-id", "TASK-001",
    "--executor-report-ref", executorRef,
    "--task-code-review-report-ref", missingObservedCodeReviewRef,
    "--green-test-run-evidence-ref", "EV-green-worker",
    "--red-test-run-evidence-ref", "EV-red-worker",
    "--format", "agent",
  ]));
  assert.equal(verifyMissingObservedCodeReview.payload.worker_state, "blocked");
  assert.ok(verifyMissingObservedCodeReview.payload.blockers.includes("pinned_artifact_ref_invalid"));

  const verifyStaleObservedCodeReview = withRuntime({
    load_context: () => [status(fx), fx.repo, fx.change, [...base, red, green, chain]],
    dirty_worktree_paths: () => [],
  }, () => captureMainJson([
    "apply-verify-packet",
    "--change", "demo-change",
    "--task-id", "TASK-001",
    "--executor-report-ref", executorRef,
    "--task-code-review-report-ref", staleCodeReviewRef,
    "--green-test-run-evidence-ref", "EV-green-worker",
    "--red-test-run-evidence-ref", "EV-red-worker",
    "--format", "agent",
  ]));
  assert.equal(verifyStaleObservedCodeReview.payload.worker_state, "blocked");
  assert.ok(verifyStaleObservedCodeReview.payload.blockers.includes("task_code_review_implementation_fingerprint_mismatch"));

  const verifyReady = withRuntime({
    load_context: () => [status(fx), fx.repo, fx.change, [...base, red, green, chain]],
    dirty_worktree_paths: () => [],
  }, () => captureMainJson([
    "apply-verify-packet",
    "--change", "demo-change",
    "--task-id", "TASK-001",
    "--executor-report-ref", executorRef,
    "--task-code-review-report-ref", codeReviewRef,
    "--green-test-run-evidence-ref", "EV-green-worker",
    "--red-test-run-evidence-ref", "EV-red-worker",
    "--format", "agent",
  ]));
  assert.equal(verifyReady.exitCode, 0);
  assert.equal(verifyReady.payload.worker_state, "ready");
  assert.equal(verifyReady.payload.apply_worker_chain_id, chainId);
  assert.ok(verifyReady.payload.expected_freshness_fingerprint?.fingerprint_digest);
  assert.ok(Array.isArray(verifyReady.payload.current_worktree_refs));
  assert.ok(Array.isArray(verifyReady.payload.verification_checks));
  assert.ok(Array.isArray(verifyReady.payload.executor_report_required_fields));
  assert.ok(Array.isArray(verifyReady.payload.code_review_report_required_fields));
  assert.ok(Array.isArray(verifyReady.payload.verifier_report_required_fields));
  assert.ok(Array.isArray(verifyReady.payload.test_evidence_required_fields));
  assert.ok(verifyReady.payload.executor_report_required_fields.includes("changed_files"));
  assert.ok(verifyReady.payload.code_review_report_required_fields.includes("executor_report_mismatch"));
  assert.ok(verifyReady.payload.verifier_report_required_fields.includes("observed_freshness_fingerprint"));
  assert.ok(Array.isArray(verifyReady.payload.protected_path_refs));
  assert.equal(typeof verifyReady.payload.scope_diff_review_policy, "object");

  const implementationPath = join(fx.repo, "src", "feature.ts");
  mkdirp(dirname(implementationPath));
  writeText(implementationPath, "export const changedAfterGreen = true;\n");
  const verifyChangedImplementation = withRuntime({
    load_context: () => [status(fx), fx.repo, fx.change, [...base, red, green, chain]],
    dirty_worktree_paths: () => ["src/feature.ts"],
  }, () => captureMainJson([
    "apply-verify-packet",
    "--change", "demo-change",
    "--task-id", "TASK-001",
    "--executor-report-ref", executorRef,
    "--task-code-review-report-ref", codeReviewRef,
    "--green-test-run-evidence-ref", "EV-green-worker",
    "--red-test-run-evidence-ref", "EV-red-worker",
    "--format", "agent",
  ]));
  assert.equal(verifyChangedImplementation.payload.worker_state, "blocked");
  assert.ok(verifyChangedImplementation.payload.blockers.includes("green_implementation_fingerprint_mismatch"));

  const protectedRel = relative(fx.repo, join(fx.change, "specs", "new-protected", "spec.md"));
  const verifyProtectedDirty = withRuntime({
    load_context: () => [status(fx), fx.repo, fx.change, [...base, red, green, chain]],
    dirty_worktree_paths: () => [protectedRel],
  }, () => captureMainJson([
    "apply-verify-packet",
    "--change", "demo-change",
    "--task-id", "TASK-001",
    "--executor-report-ref", executorRef,
    "--task-code-review-report-ref", codeReviewRef,
    "--green-test-run-evidence-ref", "EV-green-worker",
    "--red-test-run-evidence-ref", "EV-red-worker",
    "--format", "agent",
  ]));
  assert.equal(verifyProtectedDirty.payload.worker_state, "blocked", JSON.stringify(verifyProtectedDirty.payload));
  assert.ok(verifyProtectedDirty.payload.blockers.includes("protected_path_dirty"));
  assert.ok(verifyProtectedDirty.payload.protected_path_refs.length > 0);
});

withFixture("apply worker chain terminal marker must be same-chain and pinned", (fx) => {
  const chainId = "CHAIN-001";
  const baseActive = activeChainEvidence(chainId);
  const evidences = [
    ...prepareProposeComplete(fx, {
      tasksText: "- [ ] TASK-001 Implement\n  - invariant_refs: INV-001\n  - test_refs: TEST-001\n  - write_scope: src/feature.ts\n",
    }),
    workerRedEvidence(fx, {
      evidence_id: "EV-red-worker",
    }),
    workerGreenEvidence(fx, chainId),
    baseActive,
  ];

  const forgedClosed = passEvidence("task_complete", "apply_worker_chain", {
    evidence_id: "EV-chain-closed-forged",
    task_id: "TASK-001",
    apply_worker_chain_id: chainId,
    chain_state: "closed",
    executor_report_ref: {},
    task_code_review_report_ref: {},
    verifier_report_ref: {},
    green_test_run_evidence_ref: "EV-green-worker",
    observed_freshness_fingerprint: "sha256:observed",
  });
  const forgedProblems = guard.validate_evidence_schema(forgedClosed, "demo-change", fx.change, fx.repo);
  assert.ok(codes(forgedProblems).includes("pinned_artifact_ref_invalid"), JSON.stringify(forgedProblems));
  assert.ok(codes(forgedProblems).includes("apply_worker_chain_invalid"), JSON.stringify(forgedProblems));

  const forgedDecision = guard.check_task_complete("demo-change", status(fx), fx.change, [...evidences, forgedClosed], "TASK-001");
  assert.equal(forgedDecision.allowed, false);
  assert.ok(codes(forgedDecision.block_reasons).includes("apply_worker_chain_terminal_invalid"), JSON.stringify(forgedDecision.block_reasons));
  assert.ok(codes(forgedDecision.block_reasons).includes("apply_worker_chain_active"), JSON.stringify(forgedDecision.block_reasons));

  const mismatchedFreshness = closedChainEvidence(fx, chainId, "EV-green-worker", {
    evidence_id: "EV-chain-closed-mismatch",
    observed_freshness_fingerprint: "sha256:mismatch",
  }, evidences);
  const mismatchDecision = guard.check_task_complete("demo-change", status(fx), fx.change, [...evidences, mismatchedFreshness], "TASK-001");
  assert.equal(mismatchDecision.allowed, false);
  assert.ok(codes(mismatchDecision.block_reasons).includes("apply_worker_chain_terminal_invalid"), JSON.stringify(mismatchDecision.block_reasons));

  const staleHashClosed = closedChainEvidence(fx, chainId, "EV-green-worker", {
    evidence_id: "EV-chain-closed-stale-hash",
    executor_report_ref: {
      ...closedChainEvidence(fx, chainId, "EV-green-worker", {}, evidences).executor_report_ref,
      blob_sha: "sha256:stale",
    },
  }, evidences);
  const staleHashDecision = guard.check_task_complete("demo-change", status(fx), fx.change, [...evidences, staleHashClosed], "TASK-001");
  assert.equal(staleHashDecision.allowed, false);
  assert.ok(codes(staleHashDecision.block_reasons).includes("apply_worker_chain_terminal_invalid"), JSON.stringify(staleHashDecision.block_reasons));

  const staleSizeClosed = closedChainEvidence(fx, chainId, "EV-green-worker", {
    evidence_id: "EV-chain-closed-stale-size",
    task_code_review_report_ref: {
      ...closedChainEvidence(fx, chainId, "EV-green-worker", {}, evidences).task_code_review_report_ref,
      size_bytes: 999999,
    },
  }, evidences);
  const staleSizeDecision = guard.check_task_complete("demo-change", status(fx), fx.change, [...evidences, staleSizeClosed], "TASK-001");
  assert.equal(staleSizeDecision.allowed, false);
  assert.ok(codes(staleSizeDecision.block_reasons).includes("apply_worker_chain_terminal_invalid"), JSON.stringify(staleSizeDecision.block_reasons));

  const missingPathClosed = closedChainEvidence(fx, chainId, "EV-green-worker", {
    evidence_id: "EV-chain-closed-missing-path",
    verifier_report_ref: {
      ...closedChainEvidence(fx, chainId, "EV-green-worker", {}, evidences).verifier_report_ref,
      path: ".superspec/reports/apply/TASK-001/missing-verifier-report.json",
    },
  }, evidences);
  const missingPathDecision = guard.check_task_complete("demo-change", status(fx), fx.change, [...evidences, missingPathClosed], "TASK-001");
  assert.equal(missingPathDecision.allowed, false);
  assert.ok(codes(missingPathDecision.block_reasons).includes("apply_worker_chain_terminal_invalid"), JSON.stringify(missingPathDecision.block_reasons));

  const badReportRel = ".superspec/reports/apply/TASK-001/bad-executor-report.json";
  const badReportPath = join(fx.change, badReportRel);
  writeText(badReportPath, `${JSON.stringify({
    role: "verifier",
    task_id: "TASK-001",
    apply_worker_chain_id: chainId,
    origin_packet_fingerprint: "sha256:packet",
    input_ref_digest: "sha256:input",
  }, null, 2)}\n`);
  const badReportClosed = closedChainEvidence(fx, chainId, "EV-green-worker", {
    evidence_id: "EV-chain-closed-bad-report-content",
    executor_report_ref: {
      ...closedChainEvidence(fx, chainId, "EV-green-worker", {}, evidences).executor_report_ref,
      path: badReportRel,
      blob_sha: guard.file_blob_sha(badReportPath),
      size_bytes: statSync(badReportPath).size,
    },
  }, evidences);
  const badReportProblems = guard.validate_evidence_schema(badReportClosed, "demo-change", fx.change, fx.repo);
  assert.ok(codes(badReportProblems).includes("pinned_artifact_ref_invalid"), JSON.stringify(badReportProblems));
  const badReportDecision = guard.check_task_complete("demo-change", status(fx), fx.change, [...evidences, badReportClosed], "TASK-001");
  assert.equal(badReportDecision.allowed, false);
  assert.ok(codes(badReportDecision.block_reasons).includes("apply_worker_chain_terminal_invalid"), JSON.stringify(badReportDecision.block_reasons));

  const inlineRawLogReportRef = pinnedWorkerReportObject(fx, "executor", chainId, {
    ref_basename: "executor-inline-raw-log",
    raw_log: "full test output must be a raw artifact ref, not inline report text",
  });
  const inlineRawLogClosed = closedChainEvidence(fx, chainId, "EV-green-worker", {
    evidence_id: "EV-chain-closed-inline-raw-log-report",
    executor_report_ref: inlineRawLogReportRef,
  }, evidences);
  const inlineRawLogProblems = guard.validate_evidence_schema(inlineRawLogClosed, "demo-change", fx.change, fx.repo);
  assert.ok(codes(inlineRawLogProblems).includes("pinned_artifact_ref_invalid"), JSON.stringify(inlineRawLogProblems));
  const inlineRawLogDecision = guard.check_task_complete("demo-change", status(fx), fx.change, [...evidences, inlineRawLogClosed], "TASK-001");
  assert.equal(inlineRawLogDecision.allowed, false);
  assert.ok(codes(inlineRawLogDecision.block_reasons).includes("apply_worker_chain_terminal_invalid"), JSON.stringify(inlineRawLogDecision.block_reasons));

  const rawMismatchGreen = workerGreenEvidence(fx, chainId, {
    evidence_id: "EV-green-worker-raw-mismatch",
    test_id: "TEST-RAW-MISMATCH",
    test_runner_ref_basename: "test-runner-raw-mismatch",
    raw_log_refs: [DEFAULT_RUN_LOG],
  });
  const rawMismatchProblems = guard.validate_evidence_schema(rawMismatchGreen, "demo-change", fx.change, fx.repo);
  assert.ok(codes(rawMismatchProblems).includes("test_run_worker_ref_missing"), JSON.stringify(rawMismatchProblems));
  const rawMismatchClosed = closedChainEvidence(fx, chainId, "EV-green-worker-raw-mismatch", {
    evidence_id: "EV-chain-closed-raw-mismatch",
  }, [...evidences.filter((item) => item.evidence_id !== "EV-green-worker"), rawMismatchGreen]);
  const rawMismatchDecision = guard.check_task_complete("demo-change", status(fx), fx.change, [
    ...evidences.filter((item) => item.evidence_id !== "EV-green-worker"),
    rawMismatchGreen,
    rawMismatchClosed,
  ], "TASK-001");
  assert.equal(rawMismatchDecision.allowed, false);
  assert.ok(codes(rawMismatchDecision.block_reasons).includes("apply_worker_chain_terminal_invalid"), JSON.stringify(rawMismatchDecision.block_reasons));

  const unpinnedWorkerGreen = greenEvidence("TASK-001", "TEST-001", ["INV-001"], {
    evidence_id: "EV-green-worker-unpinned",
    phase: "green",
    apply_execution_chain: "executor_worker",
    apply_worker_chain_id: chainId,
  });
  const unpinnedClosed = closedChainEvidence(fx, chainId, "EV-green-worker-unpinned", {
    evidence_id: "EV-chain-closed-unpinned-green",
  }, [...evidences.filter((item) => item.evidence_id !== "EV-green-worker"), unpinnedWorkerGreen]);
  const unpinnedDecision = guard.check_task_complete("demo-change", status(fx), fx.change, [
    ...evidences.filter((item) => item.evidence_id !== "EV-green-worker"),
    unpinnedWorkerGreen,
    unpinnedClosed,
  ], "TASK-001");
  assert.equal(unpinnedDecision.allowed, false);
  assert.ok(codes(unpinnedDecision.block_reasons).includes("apply_worker_chain_terminal_invalid"), JSON.stringify(unpinnedDecision.block_reasons));

  const forgedAbandoned = passEvidence("task_complete", "apply_worker_chain", {
    evidence_id: "EV-chain-abandoned-forged",
    task_id: "TASK-001",
    apply_worker_chain_id: chainId,
    chain_state: "abandoned",
    serial_takeover_baseline_ref: "not-a-validated-baseline",
  });
  const abandonedProblems = guard.validate_evidence_schema(forgedAbandoned, "demo-change", fx.change, fx.repo);
  assert.ok(codes(abandonedProblems).includes("apply_worker_chain_invalid"), JSON.stringify(abandonedProblems));
  const abandonedDecision = guard.check_task_complete("demo-change", status(fx), fx.change, [...evidences, forgedAbandoned], "TASK-001");
  assert.equal(abandonedDecision.allowed, false);
  assert.ok(codes(abandonedDecision.block_reasons).includes("apply_worker_chain_terminal_invalid"), JSON.stringify(abandonedDecision.block_reasons));

  const restoredAbandoned = passEvidence("task_complete", "apply_worker_chain", {
    evidence_id: "EV-chain-abandoned-restored",
    task_id: "TASK-001",
    apply_worker_chain_id: chainId,
    chain_state: "abandoned",
    restored_implementation_fingerprint: { fingerprint_digest: "sha256:source" },
  });
  const restoredDecision = guard.check_task_complete("demo-change", status(fx), fx.change, [...evidences, restoredAbandoned], "TASK-001");
  assert.equal(restoredDecision.allowed, false);
  assert.ok(codes(restoredDecision.block_reasons).includes("apply_worker_chain_terminal_invalid"), JSON.stringify(restoredDecision.block_reasons));

  const takeoverBaselineRef = pinnedStatusReportRef(fx, chainId);
  const baselineAbandoned = passEvidence("task_complete", "apply_worker_chain", {
    evidence_id: "EV-chain-abandoned-baseline",
    task_id: "TASK-001",
    apply_worker_chain_id: chainId,
    chain_state: "abandoned",
    serial_takeover_baseline_ref: takeoverBaselineRef,
    successor_green_evidence_refs: ["EV-green-serial-after-abandoned"],
  });
  const baselineAbandonedWithConfirmationId = {
    ...baselineAbandoned,
    evidence_id: "EV-chain-abandoned-baseline-confirmed",
    takeover_confirmation_evidence_id: "EV-serial-takeover-confirmation",
  };
  const baselineDecision = guard.check_task_complete("demo-change", status(fx), fx.change, [...evidences, baselineAbandoned], "TASK-001");
  assert.equal(baselineDecision.allowed, false);
  assert.ok(codes(baselineDecision.block_reasons).includes("apply_worker_chain_terminal_invalid"), JSON.stringify(baselineDecision.block_reasons));

  const oldSerialSameFingerprint = greenEvidence("TASK-001", "TEST-001", ["INV-001"], {
    evidence_id: "EV-green-old-serial-same-fingerprint",
    runner_origin: "main-thread",
    implementation_fingerprint: withRuntime(
      { dirty_worktree_paths: () => [] },
      () => guard.apply_worker_implementation_fingerprint(fx.repo, fx.change),
    ),
  });
  const baselineWithOldSerialDecision = guard.check_task_complete("demo-change", status(fx), fx.change, [
    ...evidences,
    baselineAbandonedWithConfirmationId,
    oldSerialSameFingerprint,
  ], "TASK-001");
  assert.equal(baselineWithOldSerialDecision.allowed, false);
  assert.ok(codes(baselineWithOldSerialDecision.block_reasons).includes("apply_worker_chain_terminal_invalid"), JSON.stringify(baselineWithOldSerialDecision.block_reasons));

  const serialAfterAbandoned = greenEvidence("TASK-001", "TEST-001", ["INV-001"], {
    evidence_id: "EV-green-serial-after-abandoned",
    runner_origin: "main-thread",
    implementation_fingerprint: withRuntime(
      { dirty_worktree_paths: () => [] },
      () => guard.apply_worker_implementation_fingerprint(fx.repo, fx.change),
    ),
  });
  const baselineWithSerialDecision = guard.check_task_complete("demo-change", status(fx), fx.change, [
    ...evidences,
    baselineAbandonedWithConfirmationId,
    serialAfterAbandoned,
  ], "TASK-001");
  assert.equal(baselineWithSerialDecision.allowed, false);
  assert.ok(codes(baselineWithSerialDecision.block_reasons).includes("apply_worker_chain_terminal_invalid"), JSON.stringify(baselineWithSerialDecision.block_reasons));

  const uncoveredTakeoverConfirmation = serialTakeoverConfirmation(baseActive, takeoverBaselineRef, {
    evidence_id: "EV-serial-takeover-confirmation-uncovered",
    confirmed_refs: [String(takeoverBaselineRef.path ?? "")],
  });
  const uncoveredTakeoverDecision = guard.check_task_complete("demo-change", status(fx), fx.change, [
    ...evidences,
    {
      ...baselineAbandoned,
      evidence_id: "EV-chain-abandoned-baseline-uncovered",
      takeover_confirmation_evidence_id: "EV-serial-takeover-confirmation-uncovered",
    },
    serialAfterAbandoned,
    uncoveredTakeoverConfirmation,
  ], "TASK-001");
  assert.equal(uncoveredTakeoverDecision.allowed, false);
  assert.ok(codes(uncoveredTakeoverDecision.block_reasons).includes("apply_worker_chain_terminal_invalid"), JSON.stringify(uncoveredTakeoverDecision.block_reasons));

  const wrongGateTakeoverConfirmation = serialTakeoverConfirmation(baseActive, takeoverBaselineRef, {
    evidence_id: "EV-serial-takeover-confirmation-wrong-gate",
    gate: "branch_handling",
  });
  const wrongGateTakeoverDecision = guard.check_task_complete("demo-change", status(fx), fx.change, [
    ...evidences,
    {
      ...baselineAbandoned,
      evidence_id: "EV-chain-abandoned-baseline-wrong-gate",
      takeover_confirmation_evidence_id: "EV-serial-takeover-confirmation-wrong-gate",
    },
    wrongGateTakeoverConfirmation,
  ], "TASK-001");
  assert.equal(wrongGateTakeoverDecision.allowed, false);
  assert.ok(codes(wrongGateTakeoverDecision.block_reasons).includes("apply_worker_chain_terminal_invalid"), JSON.stringify(wrongGateTakeoverDecision.block_reasons));

  const failedTakeoverConfirmation = serialTakeoverConfirmation(baseActive, takeoverBaselineRef, {
    evidence_id: "EV-serial-takeover-confirmation-failed",
    status: "fail",
  });
  const failedTakeoverDecision = guard.check_task_complete("demo-change", status(fx), fx.change, [
    ...evidences,
    {
      ...baselineAbandoned,
      evidence_id: "EV-chain-abandoned-baseline-failed-confirmation",
      takeover_confirmation_evidence_id: "EV-serial-takeover-confirmation-failed",
    },
    failedTakeoverConfirmation,
  ], "TASK-001");
  assert.equal(failedTakeoverDecision.allowed, false);
  assert.ok(codes(failedTakeoverDecision.block_reasons).includes("apply_worker_chain_terminal_invalid"), JSON.stringify(failedTakeoverDecision.block_reasons));

  const takeoverConfirmation = serialTakeoverConfirmation(baseActive, takeoverBaselineRef);
  const confirmedTakeoverDecision = guard.check_task_complete("demo-change", status(fx), fx.change, [
    ...evidences,
    baselineAbandonedWithConfirmationId,
    serialAfterAbandoned,
    takeoverConfirmation,
  ], "TASK-001");
  assert.equal(confirmedTakeoverDecision.allowed, false);
  assert.equal(codes(confirmedTakeoverDecision.block_reasons).includes("apply_worker_chain_terminal_invalid"), false, JSON.stringify(confirmedTakeoverDecision.block_reasons));
  assert.ok(codes(confirmedTakeoverDecision.block_reasons).includes("missing_green_evidence"), JSON.stringify(confirmedTakeoverDecision.block_reasons));

  const restoredCurrentFingerprint = withRuntime({
    dirty_worktree_paths: () => [],
  }, () => guard.apply_worker_implementation_fingerprint(fx.repo, fx.change, [], { declaredTaskWriteScope: ["src/feature.ts"] }));
  const restoredRed = redEvidence("TASK-001", "TEST-001", ["INV-001"], {
    evidence_id: "EV-red-restored",
    phase: "red",
  });
  const restoredGreen = greenEvidence("TASK-001", "TEST-001", ["INV-001"], {
    evidence_id: "EV-green-restored-serial",
    runner_origin: "main-thread",
    implementation_fingerprint: restoredCurrentFingerprint,
  });
  const restoredActive = passEvidence("task_complete", "apply_worker_chain", {
    evidence_id: "EV-chain-active-restored",
    task_id: "TASK-001",
    apply_worker_chain_id: "CHAIN-RESTORED",
    chain_state: "active",
    executor_packet_fingerprint: "sha256:executor-packet",
    source_implementation_fingerprint: restoredCurrentFingerprint,
    declared_task_write_scope: ["src/feature.ts"],
    pre_edit_evidence_refs: ["EV-red-restored"],
  });
  const restoredBaselineAbandoned = passEvidence("task_complete", "apply_worker_chain", {
    evidence_id: "EV-chain-abandoned-restored-baseline",
    task_id: "TASK-001",
	    apply_worker_chain_id: "CHAIN-RESTORED",
	    chain_state: "abandoned",
	    restored_implementation_fingerprint: restoredCurrentFingerprint,
	  });
  const restoredBaselineDecision = withRuntime({
    dirty_worktree_paths: () => [],
  }, () => guard.check_task_complete("demo-change", status(fx), fx.change, [
    ...prepareProposeComplete(fx, {
      tasksText: "- [ ] TASK-001 Implement\n  - invariant_refs: INV-001\n  - test_refs: TEST-001\n  - write_scope: src/feature.ts\n",
    }),
    restoredRed,
    restoredGreen,
    restoredActive,
    restoredBaselineAbandoned,
	  ], "TASK-001"));
  assert.equal(restoredBaselineDecision.allowed, false);
  assert.ok(codes(restoredBaselineDecision.block_reasons).includes("missing_green_evidence"), JSON.stringify(restoredBaselineDecision.block_reasons));

  const mixedRestoredSerialBaselineRef = pinnedStatusReportRef(fx, "CHAIN-RESTORED");
  const mixedRestoredSerialAbandoned = passEvidence("task_complete", "apply_worker_chain", {
    evidence_id: "EV-chain-abandoned-restored-and-serial",
    task_id: "TASK-001",
    apply_worker_chain_id: "CHAIN-RESTORED",
    chain_state: "abandoned",
    restored_implementation_fingerprint: restoredCurrentFingerprint,
    serial_takeover_baseline_ref: mixedRestoredSerialBaselineRef,
    takeover_confirmation_evidence_id: "EV-serial-takeover-restored",
  });
  const mixedRestoredSerialProblems = guard.validate_evidence_schema(mixedRestoredSerialAbandoned, "demo-change", fx.change, fx.repo);
  assert.ok(codes(mixedRestoredSerialProblems).includes("apply_worker_chain_invalid"), JSON.stringify(mixedRestoredSerialProblems));
  const mixedRestoredSerialDecision = withRuntime({
    dirty_worktree_paths: () => [],
  }, () => guard.check_task_complete("demo-change", status(fx), fx.change, [
    ...prepareProposeComplete(fx, {
      tasksText: "- [ ] TASK-001 Implement\n  - invariant_refs: INV-001\n  - test_refs: TEST-001\n  - write_scope: src/feature.ts\n",
    }),
    restoredRed,
    restoredActive,
    mixedRestoredSerialAbandoned,
    serialTakeoverConfirmation(restoredActive, mixedRestoredSerialBaselineRef, {
      evidence_id: "EV-serial-takeover-restored",
    }),
  ], "TASK-001"));
  assert.equal(mixedRestoredSerialDecision.allowed, false);
  assert.ok(codes(mixedRestoredSerialDecision.block_reasons).includes("apply_worker_chain_terminal_invalid"), JSON.stringify(mixedRestoredSerialDecision.block_reasons));

  const semanticChainId = "CHAIN-PRE-SEMANTIC";
  const semanticGreen = workerGreenEvidence(fx, semanticChainId, {
    evidence_id: "EV-green-semantic",
    test_runner_ref_basename: "test-runner-semantic",
  });
  const semanticActive = activeChainEvidence(semanticChainId, ["EV-green-worker"]);
  const semanticClosed = closedChainEvidence(fx, semanticChainId, "EV-green-semantic", {
    evidence_id: "EV-chain-closed-bad-pre-edit",
  }, [...evidences, semanticGreen, semanticActive]);
  const semanticDecision = guard.check_task_complete("demo-change", status(fx), fx.change, [...evidences, semanticGreen, semanticActive, semanticClosed], "TASK-001");
  assert.equal(semanticDecision.allowed, false);
  assert.ok(codes(semanticDecision.block_reasons).includes("apply_worker_chain_terminal_invalid"), JSON.stringify(semanticDecision.block_reasons));

  const mainThreadPreEditChainId = "CHAIN-MAIN-PRE";
  const mainThreadPreEditRed = redEvidence("TASK-001", "TEST-001", ["INV-001"], {
    evidence_id: "EV-red-main-thread-pre-edit",
    phase: "red",
    runner_origin: "main-thread",
  });
  const mainThreadPreEditGreen = workerGreenEvidence(fx, mainThreadPreEditChainId, {
    evidence_id: "EV-green-main-thread-pre-edit",
    test_runner_ref_basename: "test-runner-main-thread-pre-edit",
  });
  const mainThreadPreEditActive = activeChainEvidence(mainThreadPreEditChainId, ["EV-red-main-thread-pre-edit"]);
  const mainThreadPreEditClosed = closedChainEvidence(fx, mainThreadPreEditChainId, "EV-green-main-thread-pre-edit", {
    evidence_id: "EV-chain-closed-main-thread-pre-edit",
  }, [...evidences, mainThreadPreEditRed, mainThreadPreEditGreen, mainThreadPreEditActive]);
  const mainThreadPreEditDecision = guard.check_task_complete("demo-change", status(fx), fx.change, [
    ...evidences,
    mainThreadPreEditRed,
    mainThreadPreEditGreen,
    mainThreadPreEditActive,
    mainThreadPreEditClosed,
  ], "TASK-001");
  assert.equal(mainThreadPreEditDecision.allowed, false);
  assert.ok(codes(mainThreadPreEditDecision.block_reasons).includes("apply_worker_chain_terminal_invalid"), JSON.stringify(mainThreadPreEditDecision.block_reasons));

  const mainThreadCharacterizationChainId = "CHAIN-MAIN-CHAR";
  const mainThreadPreEditCharacterization = passEvidence("task_edit", "test_run", {
    evidence_id: "EV-characterization-main-thread-pre-edit",
    task_id: "TASK-001",
    test_id: "TEST-001",
    invariant_refs: ["INV-001"],
    semantic_status: "expected_success",
    phase: "characterization",
    runner_origin: "main-thread",
    raw_log_refs: [DEFAULT_RUN_LOG],
    result_summary: "main-thread characterization must not satisfy worker pre-edit proof",
  });
  const mainThreadCharacterizationGreen = workerGreenEvidence(fx, mainThreadCharacterizationChainId, {
    evidence_id: "EV-green-main-thread-characterization",
    test_runner_ref_basename: "test-runner-main-thread-characterization",
  });
  const mainThreadCharacterizationActive = activeChainEvidence(mainThreadCharacterizationChainId, ["EV-characterization-main-thread-pre-edit"]);
  const mainThreadCharacterizationClosed = closedChainEvidence(fx, mainThreadCharacterizationChainId, "EV-green-main-thread-characterization", {
    evidence_id: "EV-chain-closed-main-thread-characterization",
  }, [...evidences, mainThreadPreEditCharacterization, mainThreadCharacterizationGreen, mainThreadCharacterizationActive]);
  const mainThreadCharacterizationDecision = guard.check_task_complete("demo-change", status(fx), fx.change, [
    ...evidences,
    mainThreadPreEditCharacterization,
    mainThreadCharacterizationGreen,
    mainThreadCharacterizationActive,
    mainThreadCharacterizationClosed,
  ], "TASK-001");
  assert.equal(mainThreadCharacterizationDecision.allowed, false);
  assert.ok(codes(mainThreadCharacterizationDecision.block_reasons).includes("apply_worker_chain_terminal_invalid"), JSON.stringify(mainThreadCharacterizationDecision.block_reasons));

  const staleObservedCodeReviewRef = pinnedWorkerReportObject(fx, "code-reviewer", chainId, {
    ref_basename: "code-reviewer-closed-stale-observed",
    observed_implementation_fingerprint: { fingerprint_digest: "sha256:stale-old-impl" },
  });
  const staleObservedClosed = withRuntime({
    dirty_worktree_paths: () => [],
  }, () => closedChainEvidence(fx, chainId, "EV-green-worker", {
    evidence_id: "EV-chain-closed-stale-code-review-observed",
    task_code_review_report_ref: staleObservedCodeReviewRef,
  }, evidences));
  const staleObservedDecision = withRuntime({
    dirty_worktree_paths: () => [],
  }, () => guard.check_task_complete("demo-change", status(fx), fx.change, [...evidences, staleObservedClosed], "TASK-001"));
  assert.equal(staleObservedDecision.allowed, false);
  assert.ok(codes(staleObservedDecision.block_reasons).includes("apply_worker_chain_terminal_invalid"), JSON.stringify(staleObservedDecision.block_reasons));

  const staleExecutorOriginRef = pinnedWorkerReportObject(fx, "executor", chainId, {
    ref_basename: "executor-closed-stale-origin",
    origin_packet_fingerprint: "sha256:stale-executor-packet",
  });
  const staleExecutorOriginClosed = withRuntime({
    dirty_worktree_paths: () => [],
  }, () => closedChainEvidence(fx, chainId, "EV-green-worker", {
    evidence_id: "EV-chain-closed-stale-executor-origin",
    executor_report_ref: staleExecutorOriginRef,
  }, evidences));
  const staleExecutorOriginDecision = withRuntime({
    dirty_worktree_paths: () => [],
  }, () => guard.check_task_complete("demo-change", status(fx), fx.change, [...evidences, staleExecutorOriginClosed], "TASK-001"));
  assert.equal(staleExecutorOriginDecision.allowed, false);
  assert.ok(codes(staleExecutorOriginDecision.block_reasons).includes("apply_worker_chain_terminal_invalid"), JSON.stringify(staleExecutorOriginDecision.block_reasons));

  const staleCodeReviewInputRef = pinnedWorkerReportObject(fx, "code-reviewer", chainId, {
    ref_basename: "code-reviewer-closed-stale-input",
    input_ref_digest: "sha256:stale-input",
  });
  const staleCodeReviewInputClosed = withRuntime({
    dirty_worktree_paths: () => [],
  }, () => closedChainEvidence(fx, chainId, "EV-green-worker", {
    evidence_id: "EV-chain-closed-stale-code-review-input",
    task_code_review_report_ref: staleCodeReviewInputRef,
  }, evidences));
  const staleCodeReviewInputDecision = withRuntime({
    dirty_worktree_paths: () => [],
  }, () => guard.check_task_complete("demo-change", status(fx), fx.change, [...evidences, staleCodeReviewInputClosed], "TASK-001"));
  assert.equal(staleCodeReviewInputDecision.allowed, false);
  assert.ok(codes(staleCodeReviewInputDecision.block_reasons).includes("apply_worker_chain_terminal_invalid"), JSON.stringify(staleCodeReviewInputDecision.block_reasons));

  const redEvidenceFile = materializeEvidenceRecord(fx, ".superspec/evidence/TASK-001/EV-red-worker.json", evidences.find((item) => item.evidence_id === "EV-red-worker") ?? {});
  const greenEvidenceFile = materializeEvidenceRecord(fx, ".superspec/evidence/TASK-001/EV-green-worker.json", evidences.find((item) => item.evidence_id === "EV-green-worker") ?? {});
  const activeChainFile = materializeEvidenceRecord(fx, ".superspec/evidence/TASK-001/EV-chain-active.json", evidences.find((item) => item.evidence_id === `EV-chain-active-${chainId}`) ?? {});
  const evidencesWithFiles = evidences.map((item) => {
    if (item.evidence_id === redEvidenceFile.evidence_id) return redEvidenceFile;
    if (item.evidence_id === greenEvidenceFile.evidence_id) return greenEvidenceFile;
    if (item.evidence_id === activeChainFile.evidence_id) return activeChainFile;
    return item;
  });
  const closedWithEvidenceFiles = withRuntime({
    dirty_worktree_paths: () => [],
  }, () => closedChainEvidence(fx, chainId, "EV-green-worker", {
    evidence_id: "EV-chain-closed-evidence-dirty",
  }, evidencesWithFiles));
  const evidenceDirtyPaths = [redEvidenceFile, greenEvidenceFile, activeChainFile]
    .map((item) => relative(fx.repo, join(fx.change, String(item._path ?? ""))).split("\\").join("/"));
  const evidenceDirtyDecision = withRuntime({
    dirty_worktree_paths: () => evidenceDirtyPaths,
  }, () => guard.check_task_complete("demo-change", status(fx), fx.change, [...evidencesWithFiles, closedWithEvidenceFiles], "TASK-001"));
  assert.equal(evidenceDirtyDecision.allowed, true, JSON.stringify(evidenceDirtyDecision.block_reasons));

  const closed = withRuntime({
    dirty_worktree_paths: () => [],
  }, () => closedChainEvidence(fx, chainId, "EV-green-worker", {}, evidences));
  const closedProblems = guard.validate_evidence_schema(closed, "demo-change", fx.change, fx.repo);
  assert.equal(codes(closedProblems).includes("pinned_artifact_ref_invalid"), false, JSON.stringify(closedProblems));
  assert.equal(codes(closedProblems).includes("apply_worker_chain_invalid"), false, JSON.stringify(closedProblems));
  const closedDecision = withRuntime({
    dirty_worktree_paths: () => [],
  }, () => guard.check_task_complete("demo-change", status(fx), fx.change, [...evidences, closed], "TASK-001"));
  assert.equal(closedDecision.allowed, true, JSON.stringify(closedDecision.block_reasons));

  const duplicateActiveDecision = withRuntime({
    dirty_worktree_paths: () => [],
  }, () => guard.check_task_complete("demo-change", status(fx), fx.change, [
    ...evidences,
    { ...activeChainEvidence(chainId), evidence_id: "EV-chain-active-duplicate" },
    closed,
  ], "TASK-001"));
  assert.equal(duplicateActiveDecision.allowed, true, JSON.stringify(duplicateActiveDecision.block_reasons));

  const parallelActiveDecision = withRuntime({
    dirty_worktree_paths: () => [],
  }, () => guard.check_task_complete("demo-change", status(fx), fx.change, [
    ...evidences,
    activeChainEvidence("CHAIN-PARALLEL"),
    closed,
  ], "TASK-001"));
  assert.equal(parallelActiveDecision.allowed, false);
  assert.ok(codes(parallelActiveDecision.block_reasons).includes("apply_worker_chain_active"), JSON.stringify(parallelActiveDecision.block_reasons));
  assert.equal(codes(parallelActiveDecision.block_reasons).includes("apply_worker_chain_active_conflict"), false, JSON.stringify(parallelActiveDecision.block_reasons));

  const duplicateTerminalDecision = withRuntime({
    dirty_worktree_paths: () => [],
  }, () => guard.check_task_complete("demo-change", status(fx), fx.change, [
    ...evidences,
    closed,
    { ...closed, evidence_id: "EV-chain-closed-duplicate" },
  ], "TASK-001"));
  assert.equal(duplicateTerminalDecision.allowed, false);
  assert.ok(codes(duplicateTerminalDecision.block_reasons).includes("apply_worker_chain_terminal_conflict"), JSON.stringify(duplicateTerminalDecision.block_reasons));

  const mixedTerminalAbandoned = passEvidence("task_complete", "apply_worker_chain", {
    evidence_id: "EV-chain-abandoned-after-closed",
    task_id: "TASK-001",
	    apply_worker_chain_id: chainId,
	    chain_state: "abandoned",
	    serial_takeover_baseline_ref: pinnedStatusReportRef(fx, chainId),
	    successor_green_evidence_refs: ["EV-green-serial-after-abandoned"],
	  });
  const mixedTerminalDecision = withRuntime({
    dirty_worktree_paths: () => [],
  }, () => guard.check_task_complete("demo-change", status(fx), fx.change, [
    ...evidences,
    closed,
    mixedTerminalAbandoned,
  ], "TASK-001"));
  assert.equal(mixedTerminalDecision.allowed, false);
  assert.ok(codes(mixedTerminalDecision.block_reasons).includes("apply_worker_chain_terminal_conflict"), JSON.stringify(mixedTerminalDecision.block_reasons));

  const implementationPath = join(fx.repo, "src", "feature.ts");
  mkdirp(dirname(implementationPath));
  writeText(implementationPath, "export const changedAfterGreen = true;\n");
  const changedImplementationDecision = withRuntime({
    dirty_worktree_paths: () => ["src/feature.ts"],
  }, () => guard.check_task_complete("demo-change", status(fx), fx.change, [...evidences, closed], "TASK-001"));
  assert.equal(changedImplementationDecision.allowed, false);
  assert.ok(codes(changedImplementationDecision.block_reasons).includes("apply_worker_chain_terminal_invalid"), JSON.stringify(changedImplementationDecision.block_reasons));

  const regeneratedAfterImplementationChange = withRuntime({
    dirty_worktree_paths: () => ["src/feature.ts"],
  }, () => closedChainEvidence(fx, chainId, "EV-green-worker", {
    evidence_id: "EV-chain-closed-regenerated-after-change",
  }, evidences));
  const regeneratedAfterImplementationChangeDecision = withRuntime({
    dirty_worktree_paths: () => ["src/feature.ts"],
  }, () => guard.check_task_complete("demo-change", status(fx), fx.change, [...evidences, regeneratedAfterImplementationChange], "TASK-001"));
  assert.equal(regeneratedAfterImplementationChangeDecision.allowed, false);
  assert.ok(codes(regeneratedAfterImplementationChangeDecision.block_reasons).includes("apply_worker_chain_terminal_invalid"), JSON.stringify(regeneratedAfterImplementationChangeDecision.block_reasons));

  const protectedProposalPath = join(fx.change, "proposal.md");
  writeText(protectedProposalPath, "proposal changed after GREEN\n");
  const protectedProposalRel = relative(fx.repo, protectedProposalPath);
  const protectedDirtyDecision = withRuntime({
    dirty_worktree_paths: () => [protectedProposalRel],
  }, () => guard.check_task_complete("demo-change", status(fx), fx.change, [...evidences, closed], "TASK-001"));
  assert.equal(protectedDirtyDecision.allowed, false);
  assert.ok(codes(protectedDirtyDecision.block_reasons).includes("apply_worker_chain_terminal_invalid"), JSON.stringify(protectedDirtyDecision.block_reasons));

  const unexpectedRawRel = ".superspec/raw/apply/TASK-001/unexpected.log";
  const unexpectedRawPath = join(fx.change, unexpectedRawRel);
  writeText(unexpectedRawPath, "unexpected apply worker artifact\n");
  const unexpectedRepoRel = relative(fx.repo, unexpectedRawPath);
  const unexpectedGuardDecision = withRuntime({
    dirty_worktree_paths: () => [unexpectedRepoRel],
  }, () => guard.check_task_complete("demo-change", status(fx), fx.change, [...evidences, closed], "TASK-001"));
  assert.equal(unexpectedGuardDecision.allowed, false);
  assert.ok(codes(unexpectedGuardDecision.block_reasons).includes("apply_worker_chain_terminal_invalid"), JSON.stringify(unexpectedGuardDecision.block_reasons));

});

withFixture("apply worker chain completion binds every GREEN ref to the same closed chain", (fx) => {
  const chainId = "CHAIN-MULTI-GREEN";
  const contract = [
    "## 测试覆盖矩阵",
    "",
    "| TEST-ID | 关联 REQ/Scenario | 关联 INV |",
    "|---|---|---|",
    "| TEST-001 | Scenario A | INV-001 |",
    "| TEST-002 | Scenario B | INV-001 |",
    "",
    "## 红绿灯契约",
    "",
    "### TEST-001",
    "- `test_command`: npm test -- TEST-001",
    "",
    "### TEST-002",
    "- `test_command`: npm test -- TEST-002",
    "",
  ].join("\n");
  const red = workerRedEvidence(fx, {
    evidence_id: "EV-red-worker",
  });
  const redTwo = workerRedEvidence(fx, {
    evidence_id: "EV-red-worker-2",
    test_id: "TEST-002",
  });
  const greenOne = workerGreenEvidence(fx, chainId, {
    evidence_id: "EV-green-worker-1",
    test_id: "TEST-001",
    test_runner_ref_basename: "test-runner-green-1",
  });
  const greenTwo = workerGreenEvidence(fx, chainId, {
    evidence_id: "EV-green-worker-2",
    test_id: "TEST-002",
    test_runner_ref_basename: "test-runner-green-2",
  });
  const active = activeChainEvidence(chainId, ["EV-red-worker", "EV-red-worker-2"]);
  const evidences = [
    ...prepareProposeComplete(fx, {
      testContract: contract,
      tasksText: "- [ ] TASK-001 Implement\n  - invariant_refs: INV-001\n  - test_refs: TEST-001 TEST-002\n  - write_scope: src/feature.ts\n",
    }),
    red,
    redTwo,
    greenOne,
    greenTwo,
    active,
  ];
  const executorRef = writePinnedWorkerReportRef(fx, "executor", chainId, {
    ref_basename: "executor-multi-green",
    input_ref_digest: guard.apply_worker_executor_input_ref_digest(evidences, active),
  });
  const executorRefObject = readJson(join(fx.change, executorRef));
  const codeReviewRef = writePinnedWorkerReportRef(fx, "code-reviewer", chainId, {
    ref_basename: "code-reviewer-multi-green",
    input_ref_digest: guard.worker_input_ref_digest([executorRefObject]),
    executor_report_ref: executorRefObject,
  });
  const verifyForward = withRuntime({
    load_context: () => [status(fx), fx.repo, fx.change, evidences],
    dirty_worktree_paths: () => [],
  }, () => captureMainJson([
    "apply-verify-packet",
    "--change", "demo-change",
    "--task-id", "TASK-001",
    "--executor-report-ref", executorRef,
    "--task-code-review-report-ref", codeReviewRef,
    "--green-test-run-evidence-ref", "EV-green-worker-1",
    "--green-test-run-evidence-ref", "EV-green-worker-2",
    "--red-test-run-evidence-ref", "EV-red-worker",
    "--red-test-run-evidence-ref", "EV-red-worker-2",
    "--format", "agent",
  ]));
  const verifyReverse = withRuntime({
    load_context: () => [status(fx), fx.repo, fx.change, evidences],
    dirty_worktree_paths: () => [],
  }, () => captureMainJson([
    "apply-verify-packet",
    "--change", "demo-change",
    "--task-id", "TASK-001",
    "--executor-report-ref", executorRef,
    "--task-code-review-report-ref", codeReviewRef,
    "--green-test-run-evidence-ref", "EV-green-worker-2",
    "--green-test-run-evidence-ref", "EV-green-worker-1",
    "--red-test-run-evidence-ref", "EV-red-worker",
    "--red-test-run-evidence-ref", "EV-red-worker-2",
    "--format", "agent",
  ]));
  assert.equal(verifyForward.payload.worker_state, "ready", JSON.stringify(verifyForward.payload));
  assert.equal(verifyReverse.payload.worker_state, "ready", JSON.stringify(verifyReverse.payload));
  assert.deepEqual(verifyForward.payload.expected_verifier_input_ref_digest, verifyReverse.payload.expected_verifier_input_ref_digest);
  assert.equal(verifyForward.payload.expected_freshness_fingerprint.fingerprint_digest, verifyReverse.payload.expected_freshness_fingerprint.fingerprint_digest);

  const closed = withRuntime({
    dirty_worktree_paths: () => [],
  }, () => closedChainEvidence(fx, chainId, "EV-green-worker-1", {
    green_test_run_evidence_refs: ["EV-green-worker-1", "EV-green-worker-2"],
  }, evidences));
  const decision = withRuntime({
    dirty_worktree_paths: () => [],
  }, () => guard.check_task_complete("demo-change", status(fx), fx.change, [...evidences, closed], "TASK-001"));
  assert.equal(decision.allowed, true, JSON.stringify(decision.block_reasons));

  const closedOnlyFirstGreen = withRuntime({
    dirty_worktree_paths: () => [],
  }, () => closedChainEvidence(fx, chainId, "EV-green-worker-1", {
    evidence_id: "EV-chain-closed-only-first-green",
  }, evidences));
  const closedOnlyFirstDecision = withRuntime({
    dirty_worktree_paths: () => [],
  }, () => guard.check_task_complete("demo-change", status(fx), fx.change, [...evidences, closedOnlyFirstGreen], "TASK-001"));
  assert.equal(closedOnlyFirstDecision.allowed, false);
  assert.ok(codes(closedOnlyFirstDecision.block_reasons).includes("missing_declared_test_evidence"), JSON.stringify(closedOnlyFirstDecision.block_reasons));

  const serialGreen = greenEvidence("TASK-001", "TEST-002", ["INV-001"], {
    evidence_id: "EV-green-serial-mixed",
    runner_origin: "main-thread",
    implementation_fingerprint: withRuntime(
      { dirty_worktree_paths: () => [] },
      () => guard.apply_worker_implementation_fingerprint(fx.repo, fx.change),
    ),
  });
  const mixedClosed = withRuntime({
    dirty_worktree_paths: () => [],
  }, () => closedChainEvidence(fx, chainId, "EV-green-worker-1", {
    evidence_id: "EV-chain-closed-mixed-green",
    green_test_run_evidence_refs: ["EV-green-worker-1", "EV-green-serial-mixed"],
  }, [...evidences, serialGreen]));
  const mixedDecision = withRuntime({
    dirty_worktree_paths: () => [],
  }, () => guard.check_task_complete("demo-change", status(fx), fx.change, [...evidences, serialGreen, mixedClosed], "TASK-001"));
  assert.equal(mixedDecision.allowed, false);
  assert.ok(codes(mixedDecision.block_reasons).includes("apply_worker_chain_terminal_invalid"), JSON.stringify(mixedDecision.block_reasons));
});

withFixture("no-TDD implementation completion requires closed alternative worker chain proof", (fx) => {
  const chainId = "CHAIN-NO-TDD-ALT";
  const active = activeChainEvidence(chainId, [], {
    pre_edit_proof_kind: "no_tdd_declared",
    apply_execution_surface: "implementation",
    tdd_required: false,
    no_tdd_reason: "mechanical-rename",
  });
  const alternative = alternativeVerificationEvidence("TASK-001", {
    evidence_id: "EV-alt-worker",
  });
  const evidences = [
    ...prepareProposeComplete(fx, {
      tasksText:
        "- [ ] TASK-001 Implement without TDD\n" +
        "  - invariant_refs: INV-001\n" +
        "  - test_refs: TEST-001\n" +
        "  - write_scope: src/feature.ts\n" +
        "  - tdd_required: false\n" +
        "  - no_tdd_reason: mechanical-rename\n",
    }),
    alternative,
    active,
  ];
  const executorRef = writePinnedWorkerReportRef(fx, "executor", chainId, {
    ref_basename: "executor-no-tdd-alt",
    input_ref_digest: guard.apply_worker_executor_input_ref_digest(evidences, active),
  });
  const executorRefObject = readJson(join(fx.change, executorRef));
  const codeReviewRef = writePinnedWorkerReportRef(fx, "code-reviewer", chainId, {
    ref_basename: "code-reviewer-no-tdd-alt",
    input_ref_digest: guard.worker_input_ref_digest([executorRefObject]),
    executor_report_ref: executorRefObject,
  });

  const verifyReady = withRuntime({
    load_context: () => [status(fx), fx.repo, fx.change, evidences],
    dirty_worktree_paths: () => [],
  }, () => captureMainJson([
    "apply-verify-packet",
    "--change", "demo-change",
    "--task-id", "TASK-001",
    "--executor-report-ref", executorRef,
    "--task-code-review-report-ref", codeReviewRef,
    "--alternative-verification-evidence-ref", "EV-alt-worker",
    "--format", "agent",
  ]));
  assert.equal(verifyReady.payload.worker_state, "ready", JSON.stringify(verifyReady.payload));
  assert.equal(verifyReady.payload.completion_proof_kind, "alternative_verification");
  assert.equal(verifyReady.payload.pre_edit_proof_kind, "no_tdd_declared");
  assert.equal(verifyReady.payload.tdd_required, false);
  assert.equal(verifyReady.payload.apply_execution_surface, "implementation");
  assert.ok(verifyReady.payload.expected_freshness_fingerprint?.fingerprint_digest);
  assert.equal(typeof verifyReady.payload.expected_verifier_input_ref_digest, "string");
  assert.deepEqual(verifyReady.payload.green_test_run_evidence_refs, []);
  assert.deepEqual(verifyReady.payload.red_test_run_evidence_refs, []);

  const validClosed = withRuntime({
    dirty_worktree_paths: () => [],
  }, () => closedChainEvidence(fx, chainId, "EV-unused-green", {
    completion_proof_kind: "alternative_verification",
    alternative_verification_evidence_refs: ["EV-alt-worker"],
  }, evidences));
  const validDecision = withRuntime({
    dirty_worktree_paths: () => [],
  }, () => guard.check_task_complete("demo-change", status(fx), fx.change, [...evidences, validClosed], "TASK-001"));
  assert.equal(validDecision.allowed, true, JSON.stringify(validDecision.block_reasons));

  const supersededClosedDecision = withRuntime({
    dirty_worktree_paths: () => [],
  }, () => guard.check_task_complete("demo-change", status(fx), fx.change, [...evidences, validClosed, supersededEvidence(String(validClosed.evidence_id))], "TASK-001"));
  assert.equal(supersededClosedDecision.allowed, false, JSON.stringify(supersededClosedDecision));
  assert.ok(codes(supersededClosedDecision.block_reasons).includes("missing_alternative_verification"), JSON.stringify(supersededClosedDecision.block_reasons));

  const metadataMismatchChainId = "CHAIN-NO-TDD-METADATA-MISMATCH";
  const metadataMismatchActive = activeChainEvidence(metadataMismatchChainId, [], {
    pre_edit_proof_kind: "no_tdd_declared",
    apply_execution_surface: "runtime_config",
    tdd_required: false,
    no_tdd_reason: "configuration-only",
  });
  const metadataMismatchContext = [
    ...prepareProposeComplete(fx, {
      tasksText:
        "- [ ] TASK-001 Implement without TDD\n" +
        "  - invariant_refs: INV-001\n" +
        "  - test_refs: TEST-001\n" +
        "  - write_scope: src/feature.ts\n" +
        "  - tdd_required: false\n" +
        "  - no_tdd_reason: mechanical-rename\n",
    }),
    alternative,
    metadataMismatchActive,
  ];
  const metadataMismatchClosed = withRuntime({
    dirty_worktree_paths: () => [],
  }, () => closedChainEvidence(fx, metadataMismatchChainId, "EV-unused-green", {
    completion_proof_kind: "alternative_verification",
    alternative_verification_evidence_refs: ["EV-alt-worker"],
  }, metadataMismatchContext));
  const metadataMismatchDecision = withRuntime({
    dirty_worktree_paths: () => [],
  }, () => guard.check_task_complete("demo-change", status(fx), fx.change, [...metadataMismatchContext, metadataMismatchClosed], "TASK-001"));
  assert.equal(metadataMismatchDecision.allowed, false, JSON.stringify(metadataMismatchDecision));
  assert.ok(codes(metadataMismatchDecision.block_reasons).includes("apply_worker_chain_active_invalid"), JSON.stringify(metadataMismatchDecision.block_reasons));

  const schemaProblems = guard.validate_evidence_schema(validClosed, "demo-change", fx.change, fx.repo);
  assert.equal(codes(schemaProblems).includes("apply_worker_chain_invalid"), false, JSON.stringify(schemaProblems));
  assert.equal(codes(schemaProblems).includes("pinned_artifact_ref_invalid"), false, JSON.stringify(schemaProblems));

  const assertInvalidClosed = (label: string, context: JsonMap[], closed: JsonMap): void => {
    const decision = withRuntime({
      dirty_worktree_paths: () => [],
    }, () => guard.check_task_complete("demo-change", status(fx), fx.change, [...context, closed], "TASK-001"));
    assert.equal(decision.allowed, false, label);
    assert.ok(codes(decision.block_reasons).includes("apply_worker_chain_terminal_invalid"), `${label}: ${JSON.stringify(decision.block_reasons)}`);
  };

  const failAlternative = alternativeVerificationEvidence("TASK-001", {
    evidence_id: "EV-alt-fail",
    status: "fail",
  });
  assertInvalidClosed("fail alternative ref blocks", [...evidences, failAlternative], withRuntime({
    dirty_worktree_paths: () => [],
  }, () => closedChainEvidence(fx, chainId, "EV-unused-green", {
    evidence_id: "EV-chain-closed-alt-fail-ref",
    completion_proof_kind: "alternative_verification",
    alternative_verification_evidence_refs: ["EV-alt-fail"],
  }, [...evidences, failAlternative])));

  const wrongTaskAlternative = alternativeVerificationEvidence("TASK-OTHER", {
    evidence_id: "EV-alt-wrong-task",
  });
  assertInvalidClosed("wrong task alternative ref blocks", [...evidences, wrongTaskAlternative], withRuntime({
    dirty_worktree_paths: () => [],
  }, () => closedChainEvidence(fx, chainId, "EV-unused-green", {
    evidence_id: "EV-chain-closed-alt-wrong-task",
    completion_proof_kind: "alternative_verification",
    alternative_verification_evidence_refs: ["EV-alt-wrong-task"],
  }, [...evidences, wrongTaskAlternative])));

  const wrongKindAlternative = passEvidence("task_complete", "review", {
    evidence_id: "EV-alt-wrong-kind",
    task_id: "TASK-001",
  });
  assertInvalidClosed("wrong kind alternative ref blocks", [...evidences, wrongKindAlternative], withRuntime({
    dirty_worktree_paths: () => [],
  }, () => closedChainEvidence(fx, chainId, "EV-unused-green", {
    evidence_id: "EV-chain-closed-alt-wrong-kind",
    completion_proof_kind: "alternative_verification",
    alternative_verification_evidence_refs: ["EV-alt-wrong-kind"],
  }, [...evidences, wrongKindAlternative])));

  assertInvalidClosed("superseded alternative ref blocks", [...evidences, supersededEvidence("EV-alt-worker")], withRuntime({
    dirty_worktree_paths: () => [],
  }, () => closedChainEvidence(fx, chainId, "EV-unused-green", {
    evidence_id: "EV-chain-closed-alt-superseded",
    completion_proof_kind: "alternative_verification",
    alternative_verification_evidence_refs: ["EV-alt-worker"],
  }, [...evidences, supersededEvidence("EV-alt-worker")])));

  const badVerifierRef = pinnedWorkerReportObject(fx, "verifier", chainId, {
    ref_basename: "verifier-no-tdd-alt-bad-input",
    observed_freshness_fingerprint: validClosed.observed_freshness_fingerprint,
    input_ref_digest: "sha256:not-bound-to-alternative",
    completion_proof_kind: "alternative_verification",
    pre_edit_proof_kind: "no_tdd_declared",
    green_test_run_evidence_refs: [],
    red_test_run_evidence_refs: [],
    characterization_test_run_evidence_refs: [],
    alternative_verification_evidence_refs: ["EV-alt-worker"],
    apply_execution_surface: "implementation",
    tdd_required: false,
    no_tdd_reason: "mechanical-rename",
  });
  assertInvalidClosed("verifier digest missing alternative binding blocks", evidences, {
    ...validClosed,
    evidence_id: "EV-chain-closed-alt-bad-verifier-input",
    verifier_report_ref: badVerifierRef,
  });
});

withFixture("no-TDD alternative worker chain proof-kind matrix fails closed", (fx) => {
  const base = prepareProposeComplete(fx, {
    tasksText:
      "- [ ] TASK-001 Implement without TDD\n" +
      "  - invariant_refs: INV-001\n" +
      "  - test_refs: TEST-001\n" +
      "  - write_scope: src/feature.ts\n" +
      "  - tdd_required: false\n" +
      "  - no_tdd_reason: mechanical-rename\n",
  });
  const alternative = alternativeVerificationEvidence("TASK-001", {
    evidence_id: "EV-alt-matrix",
  });
  const red = workerRedEvidence(fx, {
    evidence_id: "EV-red-matrix",
  });
  const green = workerGreenEvidence(fx, "CHAIN-GREEN-NO-TDD", {
    evidence_id: "EV-green-matrix",
  });
  const noTddActive = activeChainEvidence("CHAIN-GREEN-NO-TDD", [], {
    pre_edit_proof_kind: "no_tdd_declared",
    apply_execution_surface: "implementation",
    tdd_required: false,
    no_tdd_reason: "mechanical-rename",
  });
  const greenWithNoTddActive = withRuntime({
    dirty_worktree_paths: () => [],
  }, () => closedChainEvidence(fx, "CHAIN-GREEN-NO-TDD", "EV-green-matrix", {}, [...base, alternative, red, green, noTddActive]));
  const greenWithNoTddDecision = withRuntime({
    dirty_worktree_paths: () => [],
  }, () => guard.check_task_complete("demo-change", status(fx), fx.change, [...base, alternative, red, green, noTddActive, greenWithNoTddActive], "TASK-001"));
  assert.equal(greenWithNoTddDecision.allowed, false);
  assert.ok(codes(greenWithNoTddDecision.block_reasons).includes("apply_worker_chain_terminal_invalid"), JSON.stringify(greenWithNoTddDecision.block_reasons));

  const redOrCharacterizationActive = activeChainEvidence("CHAIN-ALT-RED-PRE", ["EV-red-matrix"]);
  const altWithRedPreEdit = withRuntime({
    dirty_worktree_paths: () => [],
  }, () => closedChainEvidence(fx, "CHAIN-ALT-RED-PRE", "EV-unused-green", {
    completion_proof_kind: "alternative_verification",
    alternative_verification_evidence_refs: ["EV-alt-matrix"],
  }, [...base, alternative, red, redOrCharacterizationActive]));
  const altWithRedPreEditDecision = withRuntime({
    dirty_worktree_paths: () => [],
  }, () => guard.check_task_complete("demo-change", status(fx), fx.change, [...base, alternative, red, redOrCharacterizationActive, altWithRedPreEdit], "TASK-001"));
  assert.equal(altWithRedPreEditDecision.allowed, false);
  assert.ok(codes(altWithRedPreEditDecision.block_reasons).includes("apply_worker_chain_terminal_invalid"), JSON.stringify(altWithRedPreEditDecision.block_reasons));

  const tddTrueActive = activeChainEvidence("CHAIN-ALT-TDD-TRUE", [], {
    pre_edit_proof_kind: "no_tdd_declared",
    apply_execution_surface: "implementation",
    tdd_required: true,
    no_tdd_reason: "mechanical-rename",
  });
  const altWithTddTrue = withRuntime({
    dirty_worktree_paths: () => [],
  }, () => closedChainEvidence(fx, "CHAIN-ALT-TDD-TRUE", "EV-unused-green", {
    completion_proof_kind: "alternative_verification",
    alternative_verification_evidence_refs: ["EV-alt-matrix"],
  }, [...base, alternative, tddTrueActive]));
  const altWithTddTrueDecision = withRuntime({
    dirty_worktree_paths: () => [],
  }, () => guard.check_task_complete("demo-change", status(fx), fx.change, [...base, alternative, tddTrueActive, altWithTddTrue], "TASK-001"));
  assert.equal(altWithTddTrueDecision.allowed, false);
  assert.ok(codes(altWithTddTrueDecision.block_reasons).includes("apply_worker_chain_terminal_invalid"), JSON.stringify(altWithTddTrueDecision.block_reasons));

  const noTddNonEmptyPreEditActive = activeChainEvidence("CHAIN-ALT-NONEMPTY-PRE", ["EV-red-matrix"], {
    pre_edit_proof_kind: "no_tdd_declared",
    apply_execution_surface: "implementation",
    tdd_required: false,
    no_tdd_reason: "mechanical-rename",
  });
  const altWithNonEmptyPreEdit = withRuntime({
    dirty_worktree_paths: () => [],
  }, () => closedChainEvidence(fx, "CHAIN-ALT-NONEMPTY-PRE", "EV-unused-green", {
    completion_proof_kind: "alternative_verification",
    alternative_verification_evidence_refs: ["EV-alt-matrix"],
  }, [...base, alternative, red, noTddNonEmptyPreEditActive]));
  const altWithNonEmptyPreEditDecision = withRuntime({
    dirty_worktree_paths: () => [],
  }, () => guard.check_task_complete("demo-change", status(fx), fx.change, [...base, alternative, red, noTddNonEmptyPreEditActive, altWithNonEmptyPreEdit], "TASK-001"));
  assert.equal(altWithNonEmptyPreEditDecision.allowed, false);
  assert.ok(codes(altWithNonEmptyPreEditDecision.block_reasons).includes("apply_worker_chain_terminal_invalid"), JSON.stringify(altWithNonEmptyPreEditDecision.block_reasons));
});

const noTddImplementationTasksText =
  "- [ ] TASK-001 Implement without TDD\n" +
  "  - invariant_refs: INV-001\n" +
  "  - test_refs: TEST-001\n" +
  "  - write_scope: src/feature.ts\n" +
  "  - tdd_required: false\n" +
  "  - no_tdd_reason: mechanical-rename\n";

withFixture("no-TDD alternative closed chain requires non-empty alternative verification refs", (fx) => {
  const chainId = "CHAIN-NO-TDD-EMPTY-ALT";
  const active = activeChainEvidence(chainId, [], {
    pre_edit_proof_kind: "no_tdd_declared",
    apply_execution_surface: "implementation",
    tdd_required: false,
    no_tdd_reason: "mechanical-rename",
  });
  const context = [...prepareProposeComplete(fx, { tasksText: noTddImplementationTasksText }), active];
  const emptyClosed = withRuntime({ dirty_worktree_paths: () => [] }, () =>
    closedChainEvidence(fx, chainId, "EV-unused-green", {
      completion_proof_kind: "alternative_verification",
      alternative_verification_evidence_refs: [],
    }, context));
  const decision = withRuntime({ dirty_worktree_paths: () => [] }, () =>
    guard.check_task_complete("demo-change", status(fx), fx.change, [...context, emptyClosed], "TASK-001"));
  assert.equal(decision.allowed, false);
  assert.ok(codes(decision.block_reasons).includes("apply_worker_chain_terminal_invalid"), JSON.stringify(decision.block_reasons));
});

withFixture("no-TDD alternative closed chain fails when code-review observed implementation fingerprint drifts", (fx) => {
  const chainId = "CHAIN-NO-TDD-ALT-STALE-CR";
  const active = activeChainEvidence(chainId, [], {
    pre_edit_proof_kind: "no_tdd_declared",
    apply_execution_surface: "implementation",
    tdd_required: false,
    no_tdd_reason: "mechanical-rename",
  });
  const alternative = alternativeVerificationEvidence("TASK-001", { evidence_id: "EV-alt-stale-cr" });
  const context = [...prepareProposeComplete(fx, { tasksText: noTddImplementationTasksText }), alternative, active];
  const executorRef = pinnedWorkerReportObject(fx, "executor", chainId, {
    ref_basename: "executor-no-tdd-stale-cr",
    input_ref_digest: guard.apply_worker_executor_input_ref_digest(context, active),
  });
  const staleCodeReviewRef = pinnedWorkerReportObject(fx, "code-reviewer", chainId, {
    ref_basename: "code-reviewer-no-tdd-stale-cr",
    input_ref_digest: guard.worker_input_ref_digest([executorRef]),
    executor_report_ref: executorRef,
    observed_implementation_fingerprint: { fingerprint_digest: "sha256:stale-alternative-implementation" },
  });
  const staleClosed = withRuntime({ dirty_worktree_paths: () => [] }, () =>
    closedChainEvidence(fx, chainId, "EV-unused-green", {
      completion_proof_kind: "alternative_verification",
      alternative_verification_evidence_refs: ["EV-alt-stale-cr"],
      task_code_review_report_ref: staleCodeReviewRef,
    }, context));
  const decision = withRuntime({ dirty_worktree_paths: () => [] }, () =>
    guard.check_task_complete("demo-change", status(fx), fx.change, [...context, staleClosed], "TASK-001"));
  assert.equal(decision.allowed, false);
  assert.ok(codes(decision.block_reasons).includes("apply_worker_chain_terminal_invalid"), JSON.stringify(decision.block_reasons));
});

withFixture("green_tests verifier report rejects no_tdd_declared pre_edit_proof_kind", (fx) => {
  const chainId = "CHAIN-GREEN-BAD-VERIFIER";
  const red = workerRedEvidence(fx, { evidence_id: "EV-red-bad-verifier" });
  const green = workerGreenEvidence(fx, chainId, { evidence_id: "EV-green-bad-verifier" });
  const active = activeChainEvidence(chainId, ["EV-red-bad-verifier"]);
  const context = [...prepareProposeComplete(fx), red, green, active];
  const badVerifier = pinnedWorkerReportObject(fx, "verifier", chainId, {
    ref_basename: "verifier-green-bad-pre-edit",
    completion_proof_kind: "green_tests",
    pre_edit_proof_kind: "no_tdd_declared",
  });
  const closedBadVerifier = withRuntime({ dirty_worktree_paths: () => [] }, () =>
    closedChainEvidence(fx, chainId, "EV-green-bad-verifier", {
      verifier_report_ref: badVerifier,
    }, context));
  const schemaProblems = guard.validate_evidence_schema(closedBadVerifier, "demo-change", fx.change, fx.repo);
  assert.ok(codes(schemaProblems).includes("pinned_artifact_ref_invalid"), JSON.stringify(schemaProblems));

  const correctVerifier = pinnedWorkerReportObject(fx, "verifier", chainId, {
    ref_basename: "verifier-green-correct-pre-edit",
    completion_proof_kind: "green_tests",
    pre_edit_proof_kind: "red_or_characterization",
  });
  const closedCorrectVerifier = withRuntime({ dirty_worktree_paths: () => [] }, () =>
    closedChainEvidence(fx, chainId, "EV-green-correct-verifier", {
      verifier_report_ref: correctVerifier,
    }, context));
  const correctSchemaProblems = guard.validate_evidence_schema(closedCorrectVerifier, "demo-change", fx.change, fx.repo);
  assert.equal(codes(correctSchemaProblems).includes("pinned_artifact_ref_invalid"), false, JSON.stringify(correctSchemaProblems));
});

withFixture("abandoned apply worker takeover does not complete with successor serial GREEN coverage", (fx) => {
  const chainId = "CHAIN-TAKEOVER-COVERAGE";
  const contract = [
    "## 测试覆盖矩阵",
    "",
    "| TEST-ID | 关联 REQ/Scenario | 关联 INV |",
    "|---|---|---|",
    "| TEST-001 | Scenario A | INV-001 |",
    "| TEST-002 | Scenario B | INV-001 |",
    "",
    "## 红绿灯契约",
    "",
    "### TEST-001",
    "- `test_command`: npm test -- TEST-001",
    "",
    "### TEST-002",
    "- `test_command`: npm test -- TEST-002",
    "",
  ].join("\n");
  const redOne = workerRedEvidence(fx, {
    evidence_id: "EV-red-takeover-1",
  });
  const redTwo = workerRedEvidence(fx, {
    evidence_id: "EV-red-takeover-2",
    test_id: "TEST-002",
  });
  const active = activeChainEvidence(chainId, ["EV-red-takeover-1", "EV-red-takeover-2"]);
  const baselineRef = pinnedStatusReportRef(fx, chainId);
  const baselineFingerprint = readJson(join(fx.change, String(baselineRef.path))).implementation_fingerprint;
  const successorGreenOne = greenEvidence("TASK-001", "TEST-001", ["INV-001"], {
    evidence_id: "EV-green-takeover-successor-1",
    runner_origin: "main-thread",
    implementation_fingerprint: baselineFingerprint,
  });
  const unlistedGreenTwo = greenEvidence("TASK-001", "TEST-002", ["INV-001"], {
    evidence_id: "EV-green-takeover-unlisted-2",
    runner_origin: "main-thread",
    implementation_fingerprint: baselineFingerprint,
  });
  const successorGreenTwo = greenEvidence("TASK-001", "TEST-002", ["INV-001"], {
    evidence_id: "EV-green-takeover-successor-2",
    runner_origin: "main-thread",
    implementation_fingerprint: baselineFingerprint,
  });
  const proposeAndRed = [
    ...prepareProposeComplete(fx, {
      testContract: contract,
      tasksText: "- [ ] TASK-001 Implement\n  - invariant_refs: INV-001\n  - test_refs: TEST-001 TEST-002\n  - write_scope: src/feature.ts\n",
    }),
    redOne,
    redTwo,
    active,
  ];
  const partialTakeover = passEvidence("task_complete", "apply_worker_chain", {
    evidence_id: "EV-chain-abandoned-takeover-partial",
    task_id: "TASK-001",
    apply_worker_chain_id: chainId,
    chain_state: "abandoned",
    serial_takeover_baseline_ref: baselineRef,
    successor_green_evidence_refs: ["EV-green-takeover-successor-1"],
    takeover_confirmation_evidence_id: "EV-serial-takeover-confirmation-partial",
  });
  const partialTakeoverConfirmation = serialTakeoverConfirmation(active, baselineRef, {
    evidence_id: "EV-serial-takeover-confirmation-partial",
    confirmed_refs: [String(active.evidence_id ?? "")],
  });
  const partialDecision = withRuntime({
    dirty_worktree_paths: () => [],
  }, () => guard.check_task_complete("demo-change", status(fx), fx.change, [
    ...proposeAndRed,
    partialTakeover,
    successorGreenOne,
    unlistedGreenTwo,
    partialTakeoverConfirmation,
  ], "TASK-001"));
  assert.equal(partialDecision.allowed, false);
  assert.ok(codes(partialDecision.block_reasons).includes("apply_worker_chain_terminal_invalid"), JSON.stringify(partialDecision.block_reasons));

  const completeTakeover = passEvidence("task_complete", "apply_worker_chain", {
    ...partialTakeover,
    evidence_id: "EV-chain-abandoned-takeover-complete",
    successor_green_evidence_refs: ["EV-green-takeover-successor-1", "EV-green-takeover-successor-2"],
    takeover_confirmation_evidence_id: "EV-serial-takeover-confirmation-complete",
  });
  const completeTakeoverConfirmation = serialTakeoverConfirmation(active, baselineRef, {
    evidence_id: "EV-serial-takeover-confirmation-complete",
  });
  const completeDecision = withRuntime({
    dirty_worktree_paths: () => [],
  }, () => guard.check_task_complete("demo-change", status(fx), fx.change, [
    ...proposeAndRed,
    completeTakeover,
    successorGreenOne,
    successorGreenTwo,
    completeTakeoverConfirmation,
  ], "TASK-001"));
  assert.equal(completeDecision.allowed, false);
  assert.equal(codes(completeDecision.block_reasons).includes("apply_worker_chain_terminal_invalid"), false, JSON.stringify(completeDecision.block_reasons));
  assert.ok(codes(completeDecision.block_reasons).includes("missing_green_evidence"), JSON.stringify(completeDecision.block_reasons));
});

withFixture("apply worker fingerprints bind semantic inputs and dirty file content", (fx) => {
  const contract = [
    "## 测试覆盖矩阵",
    "",
    "| TEST-ID | 关联 REQ/Scenario | 关联 INV |",
    "|---|---|---|",
    "| TEST-001 | Scenario A | INV-001 |",
    "| TEST-002 | Scenario B | INV-001 |",
    "",
    "## 红绿灯契约",
    "",
    "### TEST-001",
    "- `test_command`: npm test -- TEST-001",
    "",
    "### TEST-002",
    "- `test_command`: npm test -- TEST-002",
    "",
  ].join("\n");
  const evidences = prepareProposeComplete(fx, {
    testContract: contract,
    tasksText: "- [ ] TASK-001 Implement\n  - invariant_refs: INV-001\n  - test_refs: TEST-001 TEST-002\n  - write_scope: src/feature.ts\n",
  });
  const packetOne = withRuntime({
    load_context: () => [status(fx), fx.repo, fx.change, evidences],
    dirty_worktree_paths: () => [],
  }, () => captureMainJson([
    "apply-test-packet",
    "--change", "demo-change",
    "--task-id", "TASK-001",
    "--test-id", "TEST-001",
    "--phase", "red",
    "--format", "agent",
  ]));
  const packetTwo = withRuntime({
    load_context: () => [status(fx), fx.repo, fx.change, evidences],
    dirty_worktree_paths: () => [],
  }, () => captureMainJson([
    "apply-test-packet",
    "--change", "demo-change",
    "--task-id", "TASK-001",
    "--test-id", "TEST-002",
    "--phase", "red",
    "--format", "agent",
  ]));
  assert.notEqual(packetOne.payload.guard_fingerprint, packetTwo.payload.guard_fingerprint);

  const sourcePath = join(fx.repo, "src", "feature.ts");
  mkdirp(dirname(sourcePath));
  writeText(sourcePath, "export const value = 'v1';\n");
  const firstExecutor = withRuntime({
    load_context: () => [status(fx), fx.repo, fx.change, [...evidences, redEvidence()]],
    dirty_worktree_paths: () => ["src/feature.ts"],
  }, () => captureMainJson([
    "apply-executor-packet",
    "--change", "demo-change",
    "--task-id", "TASK-001",
    "--format", "agent",
  ]));
  writeText(sourcePath, "export const value = 'v2';\n");
  const secondExecutor = withRuntime({
    load_context: () => [status(fx), fx.repo, fx.change, [...evidences, redEvidence()]],
    dirty_worktree_paths: () => ["src/feature.ts"],
  }, () => captureMainJson([
    "apply-executor-packet",
    "--change", "demo-change",
    "--task-id", "TASK-001",
    "--format", "agent",
  ]));
  assert.notEqual(
    firstExecutor.payload.chain_activation_template.source_implementation_fingerprint.fingerprint_digest,
    secondExecutor.payload.chain_activation_template.source_implementation_fingerprint.fingerprint_digest,
  );
  assert.deepEqual(firstExecutor.payload.chain_activation_template.source_implementation_fingerprint.declared_task_write_scope, ["src/feature.ts"]);
  assert.ok(Array.isArray(firstExecutor.payload.chain_activation_template.source_implementation_fingerprint.protected_path_refs));
  assert.deepEqual(firstExecutor.payload.chain_activation_template.source_implementation_fingerprint.implementation_dirty_file_list, ["src/feature.ts"]);
  assert.match(firstExecutor.payload.chain_activation_template.source_implementation_fingerprint.scoped_name_status_transcript_digest, /^sha256:/u);
  assert.match(firstExecutor.payload.chain_activation_template.source_implementation_fingerprint.scoped_diff_transcript_digest, /^sha256:/u);

  const codexPromptPath = join(fx.repo, ".codex", "prompts", "executor.md");
  mkdirp(dirname(codexPromptPath));
  writeText(codexPromptPath, "executor prompt v1\n");
  const firstCodexPromptFingerprint = withRuntime({
    load_context: () => [status(fx), fx.repo, fx.change, [...evidences, redEvidence()]],
    dirty_worktree_paths: () => [".codex/prompts/executor.md"],
  }, () => captureMainJson([
    "apply-executor-packet",
    "--change", "demo-change",
    "--task-id", "TASK-001",
    "--format", "agent",
  ]));
  writeText(codexPromptPath, "executor prompt v2\n");
  const secondCodexPromptFingerprint = withRuntime({
    load_context: () => [status(fx), fx.repo, fx.change, [...evidences, redEvidence()]],
    dirty_worktree_paths: () => [".codex/prompts/executor.md"],
  }, () => captureMainJson([
    "apply-executor-packet",
    "--change", "demo-change",
    "--task-id", "TASK-001",
    "--format", "agent",
  ]));
  assert.notEqual(
    firstCodexPromptFingerprint.payload.chain_activation_template.source_implementation_fingerprint.fingerprint_digest,
    secondCodexPromptFingerprint.payload.chain_activation_template.source_implementation_fingerprint.fingerprint_digest,
  );

  writeText(codexPromptPath, "executor prompt v3\n");
  const ignoredCodexFingerprintOne = guard.apply_worker_implementation_fingerprint(fx.repo, fx.change);
  writeText(codexPromptPath, "executor prompt v4\n");
  const ignoredCodexFingerprintTwo = guard.apply_worker_implementation_fingerprint(fx.repo, fx.change);
  assert.notEqual(
    ignoredCodexFingerprintOne.fingerprint_digest,
    ignoredCodexFingerprintTwo.fingerprint_digest,
  );
  assert.ok(ignoredCodexFingerprintTwo.codex_managed_paths.includes(".codex/prompts/executor.md"));
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

withFixture("review-packet exposes nested findings contract for disclosure review lanes", (fx) => {
  const evidences = [
    ...exploreConfirmedEvidences(fx),
  ];
  withRuntime({
    load_context: () => [status(fx), fx.repo, fx.change, evidences],
  }, () => {
    const packet = captureMainJson([
      "review-packet",
      "--change", "demo-change",
      "--gate", "proposal_reviewed",
      "--role", "critic",
      "--round", "1",
      "--format", "agent",
    ]);
    assert.equal(packet.exitCode, 0);
    assert.equal(packet.payload.required_output_kind, "review");
    const fields = packet.payload.output_contract_fields as string[];
    const required = [
      "review_round_id format: <gate>-r<round>",
      "findings[] object fields: finding_id, finding_uid, finding_type, category, summary",
      "finding_uid format: <gate>:<evidence_id>:<finding_id>",
      "decision_scope_key required when material_categories is non-empty",
      "summary must be verbatim disclosure source text",
      "acknowledged_accepted_deviation_uids must be a string array when present",
      "findings[].supersedes_finding_uids must be a string array when present",
    ];
    for (const item of required) assert.ok(fields.includes(item), item);
    assert.ok(fields.some((item) => item.startsWith("finding_type values:") && item.includes("blocker") && item.includes("non_blocking_finding")));
    assert.ok(fields.some((item) => item.startsWith("category values:") && item.includes("business_semantics") && item.includes("process")));
    assert.ok(fields.some((item) => item.startsWith("material_categories values:") && item.includes("design_boundary") && item.includes("scope")));

    const prompt = captureMain([
      "review-packet",
      "--change", "demo-change",
      "--gate", "proposal_reviewed",
      "--role", "critic",
      "--round", "1",
      "--format", "prompt",
    ]);
    assert.equal(prompt.exitCode, 0);
    assert.ok(prompt.stdout.includes("- review_round_id format: <gate>-r<round>"));
    assert.ok(prompt.stdout.includes("- findings[] object fields: finding_id, finding_uid, finding_type, category, summary"));
    assert.ok(prompt.stdout.includes("- finding_uid format: <gate>:<evidence_id>:<finding_id>"));
    assert.ok(prompt.stdout.includes("finding_type values:"));
    assert.ok(prompt.stdout.includes("category values:"));
    assert.ok(prompt.stdout.includes("material_categories values:"));
    assert.ok(prompt.stdout.includes("- summary must be verbatim disclosure source text"));
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
      argv: ["apply-test-packet", "--change", "demo-change", "--task-id", "TASK-001", "--test-id", "TEST-001", "--phase", "red", "--format", "agent"],
      evidences: prepareProposeComplete(fx),
    },
    {
      argv: ["apply-executor-packet", "--change", "demo-change", "--task-id", "TASK-001", "--format", "agent"],
      evidences: prepareProposeComplete(fx),
    },
    {
      argv: ["apply-code-review-packet", "--change", "demo-change", "--task-id", "TASK-001", "--executor-report-ref", ".superspec/reports/apply/TASK-001/missing-executor-ref.json", "--format", "agent"],
      evidences: prepareProposeComplete(fx),
    },
    {
      argv: [
        "apply-verify-packet",
        "--change", "demo-change",
        "--task-id", "TASK-001",
        "--executor-report-ref", ".superspec/reports/apply/TASK-001/missing-executor-ref.json",
        "--task-code-review-report-ref", ".superspec/reports/apply/TASK-001/missing-code-review-ref.json",
        "--green-test-run-evidence-ref", "EV-green",
        "--red-test-run-evidence-ref", "EV-red",
        "--format", "agent",
      ],
      evidences: prepareProposeComplete(fx),
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
