// SuperSpec 流程引擎 — Phase 4 测试：review + accepted terminal

import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, readFileSync, symlinkSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { ensureChangeLayout, appendEvent, docRef, makeEvent, readEvents, rawFile, sha256Text } from "../src/store.ts";
import { rebuildSnapshot } from "../src/sync.ts";
import { next } from "../src/next.ts";
import { proposeReady, reviewReady, startApply, taskStart, taskComplete, reopen, accept, transitionExplore } from "../src/transition.ts";
import { jobsPacket, recordJobSubmit, recordJobSubmitContent, recordUserDecisionContent } from "../src/record.ts";
import { latestReviewHistoryForGateRole, reviewEvidenceDigest } from "../src/review.ts";
import { REVIEW_FINAL_VERIFIER_GATE } from "../src/review_job_gates.ts";
import { codeFileContentSha, dirtyCodeFiles } from "../src/git_state.ts";
import { scanCodeReviewScope } from "../src/code_review.ts";
import { phaseConfirmationForCurrentState, type PhaseDecisionAction } from "../src/phase_confirmation.ts";
import { applyPlanningBaseline, latestAcceptedProposalBaseline } from "../src/phase_plan.ts";
import type { Job, JobRole, State } from "../src/types.ts";
import { confirmCurrentPhase } from "./phase_confirmation_support.ts";

function setupApplyWithDoneTask(): { projectRoot: string; change: string; changeRoot: string; cleanup: () => void } {
  const projectRoot = mkdtempSync(join(tmpdir(), "superspec-p4-"));
  const change = "test-change";
  const changeRoot = join(projectRoot, "openspec", "changes", change);
  mkdirSync(join(changeRoot, ".superspec", "artifacts"), { recursive: true });
  // 任务已勾选
  writeFileSync(join(changeRoot, "tasks.md"), [
    "# Tasks", "",
    "- [x] TASK-001 Done",
    "  执行依据:",
    "  - 测试:",
    "  - 设计: design.md#D",
    "  - 来源: proposal.md#P",
    "  - 验收: 已完成的文档任务保持可追溯",
    "  - 边界: 不改实现代码",
    "",
  ].join("\n"));
  writeFileSync(join(changeRoot, "proposal.md"), "# P\n");
  writeFileSync(join(changeRoot, "design.md"), "# D\n");
  writeFileSync(join(changeRoot, ".superspec", "artifacts", "discovery.md"), "# D\n");
  writeFileSync(join(changeRoot, ".superspec", "artifacts", "test-contract.md"), "# TC\n");
  ensureChangeLayout(projectRoot, change);
  // seed 到 apply
  for (const [t, f, to] of [
    ["init","init","init"],["explore","init","explore"],["propose","explore","propose"],
    ["propose-ready","propose","propose_ready"],["start-apply","propose_ready","apply"],
  ] as const) {
    appendEvent(projectRoot, change, makeEvent(change, "transition_commit", {
      transition: t, from_state: f, to_state: to,
      outcome: "advanced", created_job_ids: [], reason: t,
      ...(t === "start-apply" ? { apply_planning_baseline: applyPlanningBaseline(changeRoot) } : {}),
    }, { transitionId: `T-${t}`, idempotencyKey: `${t}-key` }));
  }
  return {
    projectRoot, change, changeRoot,
    cleanup: () => rmSync(projectRoot, { recursive: true, force: true }),
  };
}

function appendTestRunEvent(
  projectRoot: string,
  change: string,
  payload: {
    test_id: string;
    attempt_id?: string | null;
    task_structure_digest: string;
    semantic_status: "expected_failure" | "expected_success" | "characterization_pass" | "unknown";
    command?: string;
    cwd?: string;
    exit_code?: number;
    covers_task_ids?: string[];
    target_fingerprint?: string | null;
  },
): void {
  appendEvent(projectRoot, change, makeEvent(change, "test_run_recorded", {
    command: payload.command ?? "npm test",
    cwd: payload.cwd ?? projectRoot,
    exit_code: payload.exit_code ?? 0,
    target_fingerprint: payload.target_fingerprint ?? null,
    raw_log_ref: null,
    ...payload,
  }));
}

function appendOpenJob(
  projectRoot: string,
  change: string,
  state: State,
  overrides: Partial<Job> & { job_id: string; role: JobRole; created_from_transition: string },
): Job {
  const job: Job = {
    ...overrides,
    job_id: overrides.job_id,
    role: overrides.role,
    state: overrides.state ?? "requested",
    boundFiles: overrides.boundFiles ?? [],
    packet_digest: overrides.packet_digest ?? "sha256:test-job",
    created_from_transition: overrides.created_from_transition,
    created_at: overrides.created_at ?? new Date().toISOString(),
  };
  appendEvent(projectRoot, change, makeEvent(change, "transition_commit", {
    transition: job.created_from_transition,
    from_state: state,
    to_state: state,
    outcome: "job_created",
    created_job_ids: [job.job_id],
    new_jobs: [job],
    reason: "test open job",
  }, { transitionId: `T-${job.job_id}`, idempotencyKey: `${job.job_id}-key` }));
  return job;
}

function packetDigestFor(projectRoot: string, change: string, jobId: string): string {
  const packet = jobsPacket(projectRoot, change, jobId);
  assert.equal(packet.found, true);
  const packetObj = packet.packet;
  assert.ok(packetObj);
  assert.equal(typeof packetObj.packet_digest, "string");
  return packetObj.packet_digest as string;
}

function checkedPathsForJob(projectRoot: string, change: string, jobId: string): string[] {
  const packet = jobsPacket(projectRoot, change, jobId);
  assert.equal(packet.found, true);
  return (packet.packet?.boundFiles ?? []).map(file => file.path);
}

test("普通审查历史：不支持历史的 verifier gate 返回空而不是抛错", () => {
  assert.equal(latestReviewHistoryForGateRole([], REVIEW_FINAL_VERIFIER_GATE, "verifier"), null);
});

function submitCodeReviewerPass(projectRoot: string, change: string, changeRoot: string, jobId: string) {
  const packet = jobsPacket(projectRoot, change, jobId);
  assert.equal(packet.found, true);
  const bound = Array.isArray(packet.packet?.boundFiles) ? packet.packet.boundFiles : [];
  const checkedPaths = bound
    .map(item => (item && typeof item === "object" && "path" in item ? (item as { path?: unknown }).path : null))
    .filter((path): path is string => typeof path === "string");
  const reportPath = join(projectRoot, `${jobId}-code-review-pass.report`);
  writeFileSync(reportPath, JSON.stringify({
    role: "code-reviewer",
    verdict: "pass",
    review_scope: {
      job_id: jobId,
      packet_digest: packet.packet?.packet_digest,
      checked_paths: checkedPaths,
      checked_docs: ["proposal.md", "design.md", "tasks.md", ".superspec/artifacts/test-contract.md"],
      unchecked: [],
    },
    findings: [],
    reviewer: { kind: "codex-subagent", id: "test-code-reviewer" },
  }));
  return recordJobSubmit(projectRoot, change, changeRoot, jobId, reportPath);
}

function submitCodeReviewerReport(
  projectRoot: string,
  change: string,
  changeRoot: string,
  jobId: string,
  report: Record<string, unknown>,
) {
  const reportPath = join(projectRoot, `${jobId}-code-review.report`);
  writeFileSync(reportPath, JSON.stringify(report));
  return recordJobSubmit(projectRoot, change, changeRoot, jobId, reportPath);
}

function withLegacyFindingAnchors(finding: unknown): unknown {
  if (!finding || typeof finding !== "object" || Array.isArray(finding)) return finding;
  const item = finding as Record<string, unknown>;
  if (item.blocking !== true || typeof item.id !== "string" || item.id.trim() === "") return finding;
  return {
    ...item,
    claim_kind: item.claim_kind ?? "breaks_existing",
    approved_refs: item.approved_refs ?? ["design.md#D"],
  };
}

function codeReviewerReport(
  projectRoot: string,
  change: string,
  jobId: string,
  verdict: "pass" | "fail",
  findings: unknown[],
  checkedPaths: string[] = [],
  options: { fillAnchors?: boolean } = {},
): Record<string, unknown> {
  const fillAnchors = options.fillAnchors !== false;
  return {
    role: "code-reviewer",
    verdict,
    review_scope: {
      job_id: jobId,
      packet_digest: packetDigestFor(projectRoot, change, jobId),
      checked_paths: checkedPaths,
      checked_docs: ["proposal.md", "design.md", "tasks.md", ".superspec/artifacts/test-contract.md"],
      unchecked: [],
    },
    findings: fillAnchors ? findings.map(withLegacyFindingAnchors) : findings,
    reviewer: { kind: "codex-subagent", id: "test-code-reviewer" },
  };
}

function initGitRepo(projectRoot: string): void {
  execFileSync("git", ["init"], { cwd: projectRoot, stdio: "ignore" });
  execFileSync("git", ["config", "user.email", "test@example.com"], { cwd: projectRoot, stdio: "ignore" });
  execFileSync("git", ["config", "user.name", "Test User"], { cwd: projectRoot, stdio: "ignore" });
}

function submitVerifierPass(projectRoot: string, change: string, changeRoot: string, jobId: string) {
  const reportPath = join(projectRoot, `${jobId}-verifier-pass.json`);
  writeFileSync(reportPath, JSON.stringify({
    role: "verifier",
    findings: [],
    verdict: "pass",
    review_scope: { checked_paths: checkedPathsForJob(projectRoot, change, jobId) },
    reviewer: { kind: "codex-subagent", id: "test-verifier" },
  }));
  return recordJobSubmit(projectRoot, change, changeRoot, jobId, reportPath);
}

function advanceApplyDoneToReview(
  projectRoot: string,
  change: string,
  changeRoot: string,
  risk: "minimal" | "normal" | "strict" = "strict",
) {
  const created = reviewReady(projectRoot, change, changeRoot, risk);
  assert.equal(created.outcome, "job_created");
  assert.equal(created.created_jobs.length, 1);
  const snap = rebuildSnapshot(projectRoot, change, changeRoot);
  const job = snap.open_jobs.find(item => item.job_id === created.created_jobs[0]);
  assert.equal(job?.role, "code-reviewer");
  const submitted = submitCodeReviewerPass(projectRoot, change, changeRoot, created.created_jobs[0]);
  assert.equal(submitted.accepted, true);
  confirmCurrentPhase(projectRoot, change, changeRoot, risk);
  const advanced = reviewReady(projectRoot, change, changeRoot, risk);
  assert.equal(advanced.outcome, "advanced");
  assert.equal(advanced.to_state, "review");
  return advanced;
}

function advanceApplyToReview(
  projectRoot: string,
  change: string,
  changeRoot: string,
  risk: "minimal" | "normal" | "strict" = "strict",
) {
  const toApplyDone = reviewReady(projectRoot, change, changeRoot, risk);
  assert.equal(toApplyDone.to_state, "apply_done");
  return advanceApplyDoneToReview(projectRoot, change, changeRoot, risk);
}

function createAndPassFinalVerifier(
  projectRoot: string,
  change: string,
  changeRoot: string,
  risk: "minimal" | "normal" | "strict" = "strict",
): string {
  const created = reviewReady(projectRoot, change, changeRoot, risk);
  assert.equal(created.outcome, "job_created");
  assert.equal(created.created_jobs.length, 1);
  const snap = rebuildSnapshot(projectRoot, change, changeRoot);
  const job = snap.open_jobs.find(item => item.job_id === created.created_jobs[0]);
  assert.equal(job?.role, "verifier");
  const submitted = submitVerifierPass(projectRoot, change, changeRoot, created.created_jobs[0]);
  assert.equal(submitted.accepted, true);
  return created.created_jobs[0];
}

function acceptAfterFinalVerifier(
  projectRoot: string,
  change: string,
  changeRoot: string,
  risk: "minimal" | "normal" | "strict" = "strict",
) {
  createAndPassFinalVerifier(projectRoot, change, changeRoot, risk);
  const accepted = accept(projectRoot, change, changeRoot);
  assert.equal(accepted.to_state, "accepted");
  return accepted;
}

test("review-ready：apply → apply_done（所有任务完成）", () => {
  const fx = setupApplyWithDoneTask();
  try {
    const result = reviewReady(fx.projectRoot, fx.change, fx.changeRoot);
    assert.equal(result.outcome, "advanced");
    assert.equal(result.to_state, "apply_done");
    const commit = readEvents(fx.projectRoot, fx.change).findLast(e =>
      e.event_type === "transition_commit" && (e.payload as { transition?: string }).transition === "review-ready"
    );
    assert.deepEqual((commit?.payload as { review_policy?: unknown }).review_policy, {
      review_risk: "normal",
      requires_verifier: true,
    });
  } finally { fx.cleanup(); }
});

test("apply_done → review：阶段确认必须精确且 direct transition 受门禁", () => {
  const fx = setupApplyWithDoneTask();
  try {
    assert.equal(reviewReady(fx.projectRoot, fx.change, fx.changeRoot, "minimal").to_state, "apply_done");
    const codeReview = reviewReady(fx.projectRoot, fx.change, fx.changeRoot, "minimal");
    assert.equal(codeReview.outcome, "job_created");
    assert.equal(submitCodeReviewerPass(fx.projectRoot, fx.change, fx.changeRoot, codeReview.created_jobs[0]).accepted, true);

    const ask = next(fx.projectRoot, fx.change, fx.changeRoot, "minimal");
    assert.equal(ask.path, "ask_user");
    assert.match(ask.ask_user.scope, /^phase_confirmation:apply_to_review:/);
    const actions = ask.ask_user.actions as PhaseDecisionAction[];
    assert.deepEqual(ask.ask_user.allowed_answers, actions.map(action => action.label));
    const advance = actions.find(action => action.decision === "advance");
    const stay = actions.find(action => action.decision === "stay");
    assert.ok(advance);
    assert.ok(stay);
    assert.equal(stay.reason, "optional");
    assert.equal(stay.resume.kind, "stop");

    const ambiguous = recordUserDecisionContent(fx.projectRoot, fx.change, JSON.stringify({
      scope: ask.ask_user.scope,
      question: ask.ask_user.question,
      answer: "好的",
    }));
    assert.equal(ambiguous.accepted, false);

    const blocked = reviewReady(fx.projectRoot, fx.change, fx.changeRoot, "minimal");
    assert.equal(blocked.events_written, 0);
    assert.match(blocked.message, /用户确认/);

    assert.equal(recordUserDecisionContent(
      fx.projectRoot,
      fx.change,
      JSON.stringify(stay.record_input),
    ).accepted, true);
    assert.equal(reviewReady(fx.projectRoot, fx.change, fx.changeRoot, "minimal").events_written, 0);
    const afterStay = next(fx.projectRoot, fx.change, fx.changeRoot, "minimal");
    assert.equal(afterStay.path, "ask_user");
    assert.equal(afterStay.ask_user.scope, ask.ask_user.scope);

    assert.equal(recordUserDecisionContent(
      fx.projectRoot,
      fx.change,
      JSON.stringify(advance.record_input),
    ).accepted, true);
    assert.equal(reviewReady(fx.projectRoot, fx.change, fx.changeRoot, "minimal").to_state, "review");
  } finally { fx.cleanup(); }
});

test("review-ready：有未完成任务拒绝", () => {
  const fx = setupApplyWithDoneTask();
  try {
    writeFileSync(join(fx.changeRoot, "tasks.md"), "# Tasks\n\n- [ ] TASK-001 Todo\n");
    const result = reviewReady(fx.projectRoot, fx.change, fx.changeRoot);
    assert.ok(result.message.includes("未完成"));
    assert.equal(result.events_written, 0);
  } finally { fx.cleanup(); }
});

test("apply_done 后补任务：reopen 复开执行并创建 fresh code-reviewer", () => {
  const fx = setupApplyWithDoneTask();
  try {
    const toApplyDone = reviewReady(fx.projectRoot, fx.change, fx.changeRoot);
    assert.equal(toApplyDone.to_state, "apply_done");

    const codeReviewGate = reviewReady(fx.projectRoot, fx.change, fx.changeRoot);
    assert.equal(codeReviewGate.outcome, "job_created");
    const staleCodeReviewJobId = codeReviewGate.created_jobs[0];

    writeFileSync(join(fx.changeRoot, "tasks.md"), "# Tasks\n\n- [x] TASK-001 Done\n- [ ] TASK-025 Fix review issue tdd_required:false no_tdd_reason:review-followup\n");

    const blocked = reviewReady(fx.projectRoot, fx.change, fx.changeRoot);
    assert.equal(blocked.events_written, 0);
    assert.match(blocked.message, /TASK-025/);

    const reopenNext = next(fx.projectRoot, fx.change, fx.changeRoot);
    assert.equal(reopenNext.path, "next_command");
    assert.equal(reopenNext.next_command, 'superspec transition reopen --change "test-change" --to apply --reason "pending tasks: TASK-025"');

    const reopened = reopen(fx.projectRoot, fx.change, fx.changeRoot, "apply", "pending tasks: TASK-025");
    assert.equal(reopened.from_state, "apply_done");
    assert.equal(reopened.to_state, "apply");

    const reopenedSnap = rebuildSnapshot(fx.projectRoot, fx.change, fx.changeRoot);
    assert.equal(reopenedSnap.state, "apply");
    assert.equal(reopenedSnap.open_jobs.some(job => job.job_id === staleCodeReviewJobId), false);

    const startNext = next(fx.projectRoot, fx.change, fx.changeRoot);
    assert.equal(startNext.path, "next_command");
    assert.equal(startNext.next_command, 'superspec transition task-start --change "test-change" --task TASK-025');

    const started = taskStart(fx.projectRoot, fx.change, fx.changeRoot, "TASK-025");
    assert.equal(started.to_state, "apply");

    const activeNext = next(fx.projectRoot, fx.change, fx.changeRoot);
    assert.equal(activeNext.path, "next_command");
    assert.equal(activeNext.next_command, 'superspec transition task-complete --change "test-change" --task TASK-025');

    const completed = taskComplete(fx.projectRoot, fx.change, fx.changeRoot, "TASK-025");
    assert.equal(completed.events_written, 2);

    const afterCompleteNext = next(fx.projectRoot, fx.change, fx.changeRoot);
    assert.equal(afterCompleteNext.path, "next_command");
    assert.match(afterCompleteNext.next_command, /review-ready/);

    const backToApplyDone = reviewReady(fx.projectRoot, fx.change, fx.changeRoot);
    assert.equal(backToApplyDone.to_state, "apply_done");

    const freshCodeReview = reviewReady(fx.projectRoot, fx.change, fx.changeRoot);
    assert.equal(freshCodeReview.outcome, "job_created");
    assert.notEqual(freshCodeReview.created_jobs[0], staleCodeReviewJobId);
    assert.equal(submitCodeReviewerPass(fx.projectRoot, fx.change, fx.changeRoot, freshCodeReview.created_jobs[0]).accepted, true);

    confirmCurrentPhase(fx.projectRoot, fx.change, fx.changeRoot);
    const advanced = reviewReady(fx.projectRoot, fx.change, fx.changeRoot);
    assert.equal(advanced.to_state, "review");
    createAndPassFinalVerifier(fx.projectRoot, fx.change, fx.changeRoot);
  } finally { fx.cleanup(); }
});

test("task-start：apply_done 状态拒绝，必须显式 reopen", () => {
  const fx = setupApplyWithDoneTask();
  try {
    reviewReady(fx.projectRoot, fx.change, fx.changeRoot);
    writeFileSync(join(fx.changeRoot, "tasks.md"), "# Tasks\n\n- [x] TASK-001 Done\n- [ ] TASK-025 Fix review issue\n");

    const result = taskStart(fx.projectRoot, fx.change, fx.changeRoot, "TASK-025");
    assert.equal(result.events_written, 0);
    assert.match(result.message, /需要 apply/);
  } finally { fx.cleanup(); }
});

test("next：active attempt 证据不足时不重复 task-start", () => {
  const fx = setupApplyWithDoneTask();
  try {
    writeFileSync(join(fx.changeRoot, "tasks.md"), "# Tasks\n\n- [ ] TASK-025 Needs TDD\n");
    taskStart(fx.projectRoot, fx.change, fx.changeRoot, "TASK-025");

    const result = next(fx.projectRoot, fx.change, fx.changeRoot);
    assert.equal(result.path, "ask_user");
    assert.match(result.ask_user.question, /RED 证据/);
    assert.match(result.ask_user.question, /GREEN 证据/);
  } finally { fx.cleanup(); }
});

test("apply reopen 后材料恢复相同：旧确认不能跨新 epoch 重放", () => {
  const fx = setupApplyWithDoneTask();
  try {
    assert.equal(reviewReady(fx.projectRoot, fx.change, fx.changeRoot, "minimal").to_state, "apply_done");
    const gate = reviewReady(fx.projectRoot, fx.change, fx.changeRoot, "minimal");
    assert.equal(gate.outcome, "job_created");
    assert.equal(submitCodeReviewerPass(fx.projectRoot, fx.change, fx.changeRoot, gate.created_jobs[0]).accepted, true);

    const initial = phaseConfirmationForCurrentState(
      fx.projectRoot,
      readEvents(fx.projectRoot, fx.change),
      rebuildSnapshot(fx.projectRoot, fx.change, fx.changeRoot),
      "minimal",
    );
    assert.ok(initial);
    const initialAdvance = initial.actions.find(action => action.decision === "advance");
    assert.ok(initialAdvance);
    const oldDecision = JSON.stringify(initialAdvance.record_input);
    assert.equal(recordUserDecisionContent(fx.projectRoot, fx.change, oldDecision).accepted, true);

    const originalTasks = readFileSync(join(fx.changeRoot, "tasks.md"), "utf8");
    writeFileSync(join(fx.changeRoot, "tasks.md"), originalTasks.replace("- [x] TASK-001", "- [ ] TASK-001"));
    assert.equal(reopen(fx.projectRoot, fx.change, fx.changeRoot, "apply", "retry task").to_state, "apply");
    writeFileSync(join(fx.changeRoot, "tasks.md"), originalTasks);
    assert.equal(reviewReady(fx.projectRoot, fx.change, fx.changeRoot, "minimal").to_state, "apply_done");

    const reentered = phaseConfirmationForCurrentState(
      fx.projectRoot,
      readEvents(fx.projectRoot, fx.change),
      rebuildSnapshot(fx.projectRoot, fx.change, fx.changeRoot),
      "minimal",
    );
    assert.ok(reentered);
    assert.equal(reentered.material_digest, initial.material_digest);
    assert.notEqual(reentered.epoch_event_id, initial.epoch_event_id);
    assert.notEqual(reentered.scope, initial.scope);

    const stale = recordUserDecisionContent(fx.projectRoot, fx.change, oldDecision);
    assert.equal(stale.accepted, false);
    assert.match(stale.message, /已失效|重新执行 next/);
    const blocked = reviewReady(fx.projectRoot, fx.change, fx.changeRoot, "minimal");
    assert.notEqual(blocked.to_state, "review");
    assert.equal(rebuildSnapshot(fx.projectRoot, fx.change, fx.changeRoot).state, "apply_done");

    const reenteredAdvance = reentered.actions.find(action => action.decision === "advance");
    assert.ok(reenteredAdvance);
    assert.equal(recordUserDecisionContent(
      fx.projectRoot,
      fx.change,
      JSON.stringify(reenteredAdvance.record_input),
    ).accepted, true);
  } finally { fx.cleanup(); }
});

test("reopen：无 pending task 时不能直回 apply；但可回 propose 重新规划", () => {
  const fx = setupApplyWithDoneTask();
  try {
    reviewReady(fx.projectRoot, fx.change, fx.changeRoot);
    const noPending = reopen(fx.projectRoot, fx.change, fx.changeRoot, "apply", "no pending");
    assert.equal(noPending.events_written, 0);
    assert.match(noPending.message, /没有未完成任务/);

    const replan = reopen(fx.projectRoot, fx.change, fx.changeRoot, "propose", "补充同一 change 的验收规则");
    assert.equal(replan.from_state, "apply_done");
    assert.equal(replan.to_state, "propose");
  } finally { fx.cleanup(); }

  const acceptedFx = setupApplyWithDoneTask();
  try {
    advanceApplyToReview(acceptedFx.projectRoot, acceptedFx.change, acceptedFx.changeRoot, "minimal");
    acceptAfterFinalVerifier(acceptedFx.projectRoot, acceptedFx.change, acceptedFx.changeRoot, "minimal");
    writeFileSync(join(acceptedFx.changeRoot, "tasks.md"), "# Tasks\n\n- [ ] TASK-025 Too late\n");

    const fromAccepted = reopen(acceptedFx.projectRoot, acceptedFx.change, acceptedFx.changeRoot, "apply", "pending tasks: TASK-025");
    assert.equal(fromAccepted.events_written, 0);
    assert.match(fromAccepted.message, /不能 reopen/);
  } finally { acceptedFx.cleanup(); }

  const archiveFx = setupApplyWithDoneTask();
  try {
    advanceApplyToReview(archiveFx.projectRoot, archiveFx.change, archiveFx.changeRoot, "minimal");
    acceptAfterFinalVerifier(archiveFx.projectRoot, archiveFx.change, archiveFx.changeRoot, "minimal");
    appendEvent(archiveFx.projectRoot, archiveFx.change, makeEvent(archiveFx.change, "transition_commit", {
      transition: "archive",
      from_state: "accepted",
      to_state: "archive",
      outcome: "advanced",
      created_job_ids: [],
      reason: "legacy archive fixture",
    }, { transitionId: "T-legacy-archive", idempotencyKey: "legacy-archive-key" }));
    writeFileSync(join(archiveFx.changeRoot, "tasks.md"), "# Tasks\n\n- [ ] TASK-025 Too late\n");

    const fromArchive = reopen(archiveFx.projectRoot, archiveFx.change, archiveFx.changeRoot, "apply", "pending tasks: TASK-025");
    assert.equal(fromArchive.events_written, 0);
    assert.match(fromArchive.message, /不能 reopen/);
  } finally { archiveFx.cleanup(); }
});

test("reopen：review 回 propose 修正计划且无 pending task 时跳过重复 Apply 确认", () => {
  const fx = setupApplyWithDoneTask();
  try {
    advanceApplyToReview(fx.projectRoot, fx.change, fx.changeRoot, "minimal");
    const verifier = reviewReady(fx.projectRoot, fx.change, fx.changeRoot, "minimal");
    assert.equal(verifier.outcome, "job_created");

    const reopened = reopen(fx.projectRoot, fx.change, fx.changeRoot, "propose", "补充非全天借调的验收规则");
    assert.equal(reopened.from_state, "review");
    assert.equal(reopened.to_state, "propose");
    assert.equal(reopened.events_written, 2);
    assert.equal(rebuildSnapshot(fx.projectRoot, fx.change, fx.changeRoot).open_jobs.length, 0);
    const lateReport = recordJobSubmitContent(
      fx.projectRoot,
      fx.change,
      fx.changeRoot,
      verifier.created_jobs[0],
      JSON.stringify({ role: "verifier", verdict: "pass", findings: [] }),
    );
    assert.equal(lateReport.accepted, false);
    assert.match(lateReport.message, /已因回退到更早阶段失效/);

    const commit = readEvents(fx.projectRoot, fx.change).findLast(event =>
      event.event_type === "transition_commit" &&
      (event.payload as { transition?: unknown }).transition === "reopen"
    );
    const payload = commit?.payload as { reopen_source?: unknown; reopen_target?: unknown; baseline_docs?: unknown };
    assert.equal(payload.reopen_source, "review");
    assert.equal(payload.reopen_target, "propose");
    assert.equal(typeof payload.baseline_docs, "object");

    assert.equal(proposeReady(fx.projectRoot, fx.change, fx.changeRoot, "minimal").to_state, "propose_ready");
    const unchanged = startApply(fx.projectRoot, fx.change, fx.changeRoot);
    assert.equal(unchanged.events_written, 0);
    assert.match(unchanged.message, /至少一个计划文档必须变化/);

    writeFileSync(join(fx.changeRoot, "proposal.md"), "# P\n\n补充非全天借调的验收规则\n");
    const resume = next(fx.projectRoot, fx.change, fx.changeRoot, "minimal");
    assert.equal(resume.path, "next_command");
    if (resume.path === "next_command") assert.match(resume.next_command, /start-apply/);
    assert.equal(startApply(fx.projectRoot, fx.change, fx.changeRoot).to_state, "apply");
    const finishEmptyApply = next(fx.projectRoot, fx.change, fx.changeRoot, "minimal");
    assert.equal(finishEmptyApply.path, "next_command");
    if (finishEmptyApply.path === "next_command") assert.match(finishEmptyApply.next_command, /review-ready/);
  } finally { fx.cleanup(); }
});

test("reopen：propose 可以回 explore，且必须更新 discovery 后才能重新推进", () => {
  const fx = setupApplyWithDoneTask();
  try {
    advanceApplyToReview(fx.projectRoot, fx.change, fx.changeRoot, "minimal");
    assert.equal(reopen(fx.projectRoot, fx.change, fx.changeRoot, "propose", "需要重新核对影响链").to_state, "propose");

    const reopened = reopen(fx.projectRoot, fx.change, fx.changeRoot, "explore", "补充借调切片的上游依赖");
    assert.equal(reopened.from_state, "propose");
    assert.equal(reopened.to_state, "explore");

    const blocked = transitionExplore(fx.projectRoot, fx.change, fx.changeRoot, "minimal");
    assert.equal(blocked.events_written, 0);
    assert.match(blocked.message, /至少一个 discovery 材料必须变化/);

    writeFileSync(join(fx.changeRoot, ".superspec", "artifacts", "discovery.md"), "# D\n\n新增借调切片依赖\n");
    const ask = next(fx.projectRoot, fx.change, fx.changeRoot, "minimal");
    assert.equal(ask.path, "ask_user");
    assert.match(ask.ask_user.scope, /^phase_confirmation:explore_to_propose:/);
    const advance = (ask.ask_user.actions as PhaseDecisionAction[]).find(action => action.decision === "advance");
    assert.ok(advance);
    assert.equal(recordUserDecisionContent(
      fx.projectRoot,
      fx.change,
      JSON.stringify(advance.record_input),
    ).accepted, true);
    const advanced = transitionExplore(fx.projectRoot, fx.change, fx.changeRoot, "minimal");
    assert.equal(advanced.to_state, "propose");
  } finally { fx.cleanup(); }
});

test("reopen：从 apply 回计划阶段会中止活跃任务尝试", () => {
  const fx = setupApplyWithDoneTask();
  try {
    writeFileSync(join(fx.changeRoot, "tasks.md"), "# Tasks\n\n- [ ] TASK-001 Pending\n");
    assert.equal(taskStart(fx.projectRoot, fx.change, fx.changeRoot, "TASK-001").to_state, "apply");

    const reopened = reopen(fx.projectRoot, fx.change, fx.changeRoot, "propose", "新增需求需要重新规划");
    assert.equal(reopened.to_state, "propose");
    assert.equal(reopened.events_written, 2);
    const snapshot = rebuildSnapshot(fx.projectRoot, fx.change, fx.changeRoot);
    assert.equal(snapshot.active_task_attempts.length, 0);
    assert.equal(snapshot.task_statuses["TASK-001"], "todo");
    assert.equal(readEvents(fx.projectRoot, fx.change).some(event => event.event_type === "task_abandoned"), true);
  } finally { fx.cleanup(); }
});

test("CLI transition reopen：apply_done + pending → apply", () => {
  const fx = setupApplyWithDoneTask();
  try {
    reviewReady(fx.projectRoot, fx.change, fx.changeRoot);
    writeFileSync(join(fx.changeRoot, "tasks.md"), "# Tasks\n\n- [x] TASK-001 Done\n- [ ] TASK-025 CLI followup\n");

    const cli = new URL("../src/cli.ts", import.meta.url).pathname;
    const output = execFileSync(process.execPath, [
      cli,
      "transition",
      "reopen",
      "--change",
      fx.change,
      "--to",
      "apply",
      "--reason",
      "pending tasks: TASK-025",
    ], {
      cwd: fx.projectRoot,
      encoding: "utf8",
    });
    const result = JSON.parse(output);
    assert.equal(result.to_state, "apply");

    const snap = rebuildSnapshot(fx.projectRoot, fx.change, fx.changeRoot);
    assert.equal(snap.state, "apply");
  } finally { fx.cleanup(); }
});

test("CLI transition reopen：self-test-fix 直接创建 Fix Task", () => {
  const fx = setupApplyWithDoneTask();
  try {
    assert.equal(reviewReady(fx.projectRoot, fx.change, fx.changeRoot).to_state, "apply_done");
    const cli = new URL("../src/cli.ts", import.meta.url).pathname;
    const output = execFileSync(process.execPath, [
      cli,
      "transition",
      "reopen",
      "--change",
      fx.change,
      "--to",
      "apply",
      "--self-test-fix",
      "TASK-001",
      "--reason",
      "CLI 自测发现空输入失败",
    ], {
      cwd: fx.projectRoot,
      encoding: "utf8",
    });
    const result = JSON.parse(output);
    assert.equal(result.to_state, "apply");
    assert.match(readFileSync(join(fx.changeRoot, "tasks.md"), "utf8"), /FIX-SELFTEST-TASK-001-/);
  } finally { fx.cleanup(); }
});

test("review 状态后补任务：next 返回 reopen 且 accept 拒绝", () => {
  const fx = setupApplyWithDoneTask();
  try {
    advanceApplyToReview(fx.projectRoot, fx.change, fx.changeRoot, "minimal");
    writeFileSync(join(fx.changeRoot, "tasks.md"), "# Tasks\n\n- [x] TASK-001 Done\n- [ ] TASK-025 Review followup\n");

    const nextResult = next(fx.projectRoot, fx.change, fx.changeRoot);
    assert.equal(nextResult.path, "next_command");
    assert.equal(nextResult.next_command, 'superspec transition reopen --change "test-change" --to apply --reason "pending tasks: TASK-025"');

    const accepted = accept(fx.projectRoot, fx.change, fx.changeRoot);
    assert.equal(accepted.events_written, 0);
    assert.match(accepted.message, /TASK-025/);
  } finally { fx.cleanup(); }
});

test("next：apply 所有任务完成时默认 review-ready 不显式输出 strict", () => {
  const fx = setupApplyWithDoneTask();
  try {
    const result = next(fx.projectRoot, fx.change, fx.changeRoot);
    assert.equal(result.path, "next_command");
    assert.ok(result.next_command.includes("review-ready"));
    assert.doesNotMatch(result.next_command, /--risk strict/);
  } finally { fx.cleanup(); }
});

test("next：apply/apply_done 不把 mode 参数暴露到 review-ready 命令", () => {
  const fx = setupApplyWithDoneTask();
  try {
    const applyResult = next(fx.projectRoot, fx.change, fx.changeRoot, "minimal");
    assert.equal(applyResult.path, "next_command");
    assert.equal(applyResult.next_command, 'superspec transition review-ready --change "test-change"');

    const transition = reviewReady(fx.projectRoot, fx.change, fx.changeRoot, "minimal");
    assert.equal(transition.to_state, "apply_done");

    const applyDoneResult = next(fx.projectRoot, fx.change, fx.changeRoot, "minimal");
    assert.equal(applyDoneResult.path, "next_command");
    assert.equal(applyDoneResult.next_command, 'superspec transition review-ready --change "test-change"');
  } finally { fx.cleanup(); }
});

test("review policy：首次 risk 生效，后续 risk 不覆盖", () => {
  const fx = setupApplyWithDoneTask();
  try {
    const toApplyDone = reviewReady(fx.projectRoot, fx.change, fx.changeRoot, "minimal");
    assert.equal(toApplyDone.to_state, "apply_done");

    const codeReview = reviewReady(fx.projectRoot, fx.change, fx.changeRoot, "strict");
    assert.equal(codeReview.outcome, "job_created");
    assert.equal(submitCodeReviewerPass(fx.projectRoot, fx.change, fx.changeRoot, codeReview.created_jobs[0]).accepted, true);
    confirmCurrentPhase(fx.projectRoot, fx.change, fx.changeRoot, "strict");
    const toReview = reviewReady(fx.projectRoot, fx.change, fx.changeRoot, "strict");
    assert.equal(toReview.to_state, "review");

    const policies = readEvents(fx.projectRoot, fx.change)
      .filter(e => e.event_type === "transition_commit")
      .map(e => (e.payload as { review_policy?: unknown }).review_policy)
      .filter(Boolean);
    assert.equal(policies.length, 1);
    assert.deepEqual(policies[0], {
      review_risk: "minimal",
      requires_verifier: false,
    });
  } finally { fx.cleanup(); }
});

test("review 状态无 policy：next 回 review-ready，accept 不直通", () => {
  const fx = setupApplyWithDoneTask();
  try {
    appendEvent(fx.projectRoot, fx.change, makeEvent(fx.change, "transition_commit", {
      transition: "legacy-review",
      from_state: "apply",
      to_state: "review",
      outcome: "advanced",
      created_job_ids: [],
      reason: "legacy review without policy",
    }, { transitionId: "T-legacy-review", idempotencyKey: "legacy-review-key" }));

    const nextResult = next(fx.projectRoot, fx.change, fx.changeRoot, "minimal");
    assert.equal(nextResult.path, "next_command");
    assert.equal(nextResult.next_command, 'superspec transition review-ready --change "test-change"');

    const blocked = accept(fx.projectRoot, fx.change, fx.changeRoot);
    assert.equal(blocked.events_written, 0);
    assert.match(blocked.message, /审查策略/);

    const eventCountBefore = readEvents(fx.projectRoot, fx.change).length;
    const policyWritten = reviewReady(fx.projectRoot, fx.change, fx.changeRoot, "minimal");
    assert.equal(policyWritten.from_state, "review");
    assert.equal(policyWritten.to_state, "review");
    assert.equal(policyWritten.events_written, 1);
    assert.equal(readEvents(fx.projectRoot, fx.change).length, eventCountBefore + 2, "prepare + commit");

    const accepted = accept(fx.projectRoot, fx.change, fx.changeRoot);
    assert.equal(accepted.to_state, "accepted");
  } finally { fx.cleanup(); }
});

test("review-ready：apply_done → 创建 code-reviewer，review → 创建 verifier final gate job", () => {
  const projectRoot = mkdtempSync(join(tmpdir(), "superspec-p4fa-"));
  const change = "test-change";
  const changeRoot = join(projectRoot, "openspec", "changes", change);
  mkdirSync(join(changeRoot, ".superspec", "artifacts"), { recursive: true });
  writeFileSync(join(changeRoot, "tasks.md"), "# Tasks\n\n- [x] TASK-001 Done\n");
  writeFileSync(join(changeRoot, "proposal.md"), "# P\n");
  writeFileSync(join(changeRoot, "design.md"), "# D\n");
  writeFileSync(join(changeRoot, ".superspec", "artifacts", "discovery.md"), "# D\n");
  writeFileSync(join(changeRoot, ".superspec", "artifacts", "test-contract.md"), "# TC\n");
  ensureChangeLayout(projectRoot, change);
  for (const [t, f, to] of [
    ["init","init","init"],["explore","init","explore"],["propose","explore","propose"],
    ["propose-ready","propose","propose_ready"],["start-apply","propose_ready","apply"],
    ["review-ready","apply","apply_done"],
  ] as const) {
    appendEvent(projectRoot, change, makeEvent(change, "transition_commit", {
      transition: t, from_state: f, to_state: to,
      outcome: "advanced", created_job_ids: [], reason: t,
    }, { transitionId: `T-${t}`, idempotencyKey: `${t}-key` }));
  }
  try {
    const result = reviewReady(projectRoot, change, changeRoot);
    assert.equal(result.outcome, "job_created");
    assert.equal(result.created_jobs.length, 1);
    const snap = rebuildSnapshot(projectRoot, change, changeRoot);
    assert.equal(snap.open_jobs[0].role, "code-reviewer");
    assert.equal(snap.open_jobs[0].created_from_transition, "review-ready");
    assert.equal(snap.open_jobs[0].gate_id, "review.code_review");

    const beforeBlockedEvents = readEvents(projectRoot, change).length;
    const blocked = reviewReady(projectRoot, change, changeRoot);
    assert.equal(blocked.outcome, "blocked");
    assert.equal(blocked.events_written, 0);
    assert.equal(blocked.required_jobs?.[0]?.job_id, result.created_jobs[0]);
    assert.deepEqual(blocked.required_jobs?.[0]?.packet_argv, [
      "superspec", "jobs", "packet", "--change", change, "--job", result.created_jobs[0],
    ]);
    assert.equal(readEvents(projectRoot, change).length, beforeBlockedEvents);

    const packet = jobsPacket(projectRoot, change, result.created_jobs[0]);
    assert.equal(packet.found, true);
    assert.equal(packet.packet?.gate_id, "review.code_review");
    assert.deepEqual(packet.packet?.output_contract_fields, ["role", "verdict", "findings", "reviewer", "review_scope"]);
    assert.equal(packet.packet?.recommended_agent, "code-reviewer");

    const recorded = submitCodeReviewerPass(projectRoot, change, changeRoot, result.created_jobs[0]);
    assert.equal(recorded.accepted, true);

    confirmCurrentPhase(projectRoot, change, changeRoot);
    const advanced = reviewReady(projectRoot, change, changeRoot);
    assert.equal(advanced.outcome, "advanced");
    assert.equal(advanced.to_state, "review");
    const passedCommit = readEvents(projectRoot, change).findLast(e =>
      e.event_type === "transition_commit" &&
      (e.payload as { from_state?: unknown; to_state?: unknown }).from_state === "apply_done" &&
      (e.payload as { from_state?: unknown; to_state?: unknown }).to_state === "review"
    );
    const passedGate = (passedCommit?.payload as { code_review_gate?: { decision?: unknown; job_id?: unknown; packet_digest?: unknown; current_head?: unknown } }).code_review_gate;
    assert.equal(passedGate?.decision, "passed");
    assert.equal(passedGate?.job_id, result.created_jobs[0]);
    assert.equal(typeof passedGate?.packet_digest, "string");
    assert.equal("current_head" in (passedGate ?? {}), true);

    const verifier = reviewReady(projectRoot, change, changeRoot);
    assert.equal(verifier.outcome, "job_created");
    const reviewSnap = rebuildSnapshot(projectRoot, change, changeRoot);
    const verifierJob = reviewSnap.open_jobs.find(job => job.job_id === verifier.created_jobs[0]);
    assert.equal(verifierJob?.role, "verifier");
    assert.equal(verifierJob?.gate_id, "review.final_verifier");
    const verifierPacket = jobsPacket(projectRoot, change, verifier.created_jobs[0]);
    assert.equal(verifierPacket.packet?.gate_id, "review.final_verifier");
    assert.deepEqual(verifierPacket.packet?.output_contract_fields, ["role", "verdict", "findings", "review_scope"]);
    assert.equal(verifierPacket.packet?.code_review_gate?.decision, "passed");
    assert.equal(verifierPacket.packet?.code_review_gate?.job_id, result.created_jobs[0]);
    assert.deepEqual(verifierPacket.packet?.task_execution_index, []);
    assert.deepEqual(verifierPacket.packet?.coverage_exemption_refs, []);
    assert.match(String(verifierPacket.packet?.output_instructions), /code_review_gate/);
    assert.match(String(verifierPacket.packet?.output_instructions), /attempt_id/);
  } finally { rmSync(projectRoot, { recursive: true, force: true }); }
});

test("code_state_check：已审 dirty 文件未变化不算差异，后续修改会使 verifier stale", () => {
  const fx = setupApplyWithDoneTask();
  try {
    initGitRepo(fx.projectRoot);
    mkdirSync(join(fx.projectRoot, "src"), { recursive: true });
    writeFileSync(join(fx.projectRoot, "src", "a.ts"), "export const value = 1;\n");
    execFileSync("git", ["add", "."], { cwd: fx.projectRoot, stdio: "ignore" });
    execFileSync("git", ["commit", "-m", "initial"], { cwd: fx.projectRoot, stdio: "ignore" });

    writeFileSync(join(fx.projectRoot, "src", "a.ts"), "export const value = 2;\n");
    assert.equal(reviewReady(fx.projectRoot, fx.change, fx.changeRoot).to_state, "apply_done");
    const codeReview = reviewReady(fx.projectRoot, fx.change, fx.changeRoot);
    assert.equal(codeReview.outcome, "job_created");
    const codeReviewPacket = jobsPacket(fx.projectRoot, fx.change, codeReview.created_jobs[0]);
    assert.deepEqual((codeReviewPacket.packet?.boundFiles as { path: string }[]).map(file => file.path), ["src/a.ts"]);

    assert.equal(submitCodeReviewerPass(fx.projectRoot, fx.change, fx.changeRoot, codeReview.created_jobs[0]).accepted, true);
    confirmCurrentPhase(fx.projectRoot, fx.change, fx.changeRoot);
    assert.equal(reviewReady(fx.projectRoot, fx.change, fx.changeRoot).to_state, "review");

    const verifier = reviewReady(fx.projectRoot, fx.change, fx.changeRoot);
    assert.equal(verifier.outcome, "job_created");
    const verifierPacket = jobsPacket(fx.projectRoot, fx.change, verifier.created_jobs[0]);
    const reviewed = rebuildSnapshot(fx.projectRoot, fx.change, fx.changeRoot).accepted_jobs.find(job => job.job_id === codeReview.created_jobs[0]);
    assert.equal(reviewed?.boundFiles[0]?.sha, codeFileContentSha(fx.projectRoot, "src/a.ts"));
    assert.equal(verifierPacket.packet?.code_review_gate?.job_id, codeReview.created_jobs[0]);
    const eventJob = readEvents(fx.projectRoot, fx.change).flatMap(event =>
      event.event_type === "transition_commit" ? (event.payload as { new_jobs?: Job[] }).new_jobs ?? [] : []
    ).find(job => job.job_id === codeReview.created_jobs[0]);
    assert.equal(eventJob?.boundFiles[0]?.sha, codeFileContentSha(fx.projectRoot, "src/a.ts"));
    assert.deepEqual(verifierPacket.packet?.code_state_check?.changed_paths, [], JSON.stringify(verifierPacket.packet?.code_state_check));

    writeFileSync(join(fx.projectRoot, "src", "a.ts"), "export const value = 3;\n");
    const submitted = submitVerifierPass(fx.projectRoot, fx.change, fx.changeRoot, verifier.created_jobs[0]);
    assert.equal(submitted.accepted, false);
    assert.match(submitted.message, /代码状态事实已变化/);
  } finally { fx.cleanup(); }
});

test("code_state_check：verifier 创建后的干净代码提交会列入差异并使旧 job stale", () => {
  const projectRoot = mkdtempSync(join(tmpdir(), "superspec-p4state-"));
  const change = "test-change";
  const changeRoot = join(projectRoot, "openspec", "changes", change);
  mkdirSync(join(changeRoot, ".superspec", "artifacts"), { recursive: true });
  writeFileSync(join(changeRoot, "tasks.md"), "# Tasks\n\n- [x] TASK-001 Done\n");
  writeFileSync(join(changeRoot, "proposal.md"), "# P\n");
  writeFileSync(join(changeRoot, "design.md"), "# D\n");
  writeFileSync(join(changeRoot, ".superspec", "artifacts", "discovery.md"), "# D\n");
  writeFileSync(join(changeRoot, ".superspec", "artifacts", "test-contract.md"), "# TC\n");
  ensureChangeLayout(projectRoot, change);
  try {
    initGitRepo(projectRoot);
    mkdirSync(join(projectRoot, "src"), { recursive: true });
    writeFileSync(join(projectRoot, "src", "a.ts"), "export const value = 1;\n");
    execFileSync("git", ["add", "."], { cwd: projectRoot, stdio: "ignore" });
    execFileSync("git", ["commit", "-m", "initial"], { cwd: projectRoot, stdio: "ignore" });
    const applyStartHead = execFileSync("git", ["rev-parse", "HEAD"], { cwd: projectRoot, encoding: "utf8" }).trim();

    for (const [t, f, to] of [
      ["init","init","init"],["explore","init","explore"],["propose","explore","propose"],
      ["propose-ready","propose","propose_ready"],
    ] as const) {
      appendEvent(projectRoot, change, makeEvent(change, "transition_commit", {
        transition: t, from_state: f, to_state: to,
        outcome: "advanced", created_job_ids: [], reason: t,
      }, { transitionId: `T-state-${t}`, idempotencyKey: `state-${t}-key` }));
    }
    appendEvent(projectRoot, change, makeEvent(change, "transition_commit", {
      transition: "start-apply",
      from_state: "propose_ready",
      to_state: "apply",
      outcome: "advanced",
      created_job_ids: [],
      reason: "start apply",
      apply_start_head: applyStartHead,
      apply_start_head_reason: "ok",
    }, { transitionId: "T-state-start-apply", idempotencyKey: "state-start-apply-key" }));
    appendEvent(projectRoot, change, makeEvent(change, "transition_commit", {
      transition: "review-ready",
      from_state: "apply",
      to_state: "apply_done",
      outcome: "advanced",
      created_job_ids: [],
      reason: "all tasks done",
    }, { transitionId: "T-state-apply-done", idempotencyKey: "state-apply-done-key" }));

    writeFileSync(join(projectRoot, "src", "a.ts"), "export const value = 2;\n");
    execFileSync("git", ["add", "src/a.ts"], { cwd: projectRoot, stdio: "ignore" });
    execFileSync("git", ["commit", "-m", "apply code"], { cwd: projectRoot, stdio: "ignore" });

    const codeReview = reviewReady(projectRoot, change, changeRoot);
    assert.equal(codeReview.outcome, "job_created");
    assert.deepEqual(jobsPacket(projectRoot, change, codeReview.created_jobs[0]).packet?.code_review_scope?.committed_paths, ["src/a.ts"]);
    assert.equal(submitCodeReviewerPass(projectRoot, change, changeRoot, codeReview.created_jobs[0]).accepted, true);
    confirmCurrentPhase(projectRoot, change, changeRoot);
    assert.equal(reviewReady(projectRoot, change, changeRoot).to_state, "review");

    const verifier = reviewReady(projectRoot, change, changeRoot);
    assert.equal(verifier.outcome, "job_created");
    assert.deepEqual(jobsPacket(projectRoot, change, verifier.created_jobs[0]).packet?.code_state_check?.changed_paths, []);

    writeFileSync(join(projectRoot, "src", "b.ts"), "export const added = true;\n");
    execFileSync("git", ["add", "src/b.ts"], { cwd: projectRoot, stdio: "ignore" });
    execFileSync("git", ["commit", "-m", "post review code"], { cwd: projectRoot, stdio: "ignore" });

    const staleSubmit = submitVerifierPass(projectRoot, change, changeRoot, verifier.created_jobs[0]);
    assert.equal(staleSubmit.accepted, false);
    assert.match(staleSubmit.message, /代码状态事实已变化/);

    const freshVerifier = reviewReady(projectRoot, change, changeRoot);
    assert.equal(freshVerifier.outcome, "job_created");
    assert.deepEqual(jobsPacket(projectRoot, change, freshVerifier.created_jobs[0]).packet?.code_state_check?.changed_paths, ["src/b.ts"]);
  } finally { rmSync(projectRoot, { recursive: true, force: true }); }
});

test("code-reviewer scope：git diff 失败时保守创建不可靠审查范围", () => {
  const projectRoot = mkdtempSync(join(tmpdir(), "superspec-p4scope-"));
  const change = "test-change";
  const changeRoot = join(projectRoot, "openspec", "changes", change);
  mkdirSync(join(changeRoot, ".superspec", "artifacts"), { recursive: true });
  writeFileSync(join(changeRoot, "tasks.md"), "# Tasks\n\n- [x] TASK-001 Done\n");
  writeFileSync(join(changeRoot, "proposal.md"), "# P\n");
  writeFileSync(join(changeRoot, "design.md"), "# D\n");
  writeFileSync(join(changeRoot, ".superspec", "artifacts", "discovery.md"), "# D\n");
  writeFileSync(join(changeRoot, ".superspec", "artifacts", "test-contract.md"), "# TC\n");
  ensureChangeLayout(projectRoot, change);
  try {
    initGitRepo(projectRoot);
    mkdirSync(join(projectRoot, "src"), { recursive: true });
    writeFileSync(join(projectRoot, "src", "a.ts"), "export const value = 1;\n");
    execFileSync("git", ["add", "."], { cwd: projectRoot, stdio: "ignore" });
    execFileSync("git", ["commit", "-m", "initial"], { cwd: projectRoot, stdio: "ignore" });

    for (const [t, f, to] of [
      ["init","init","init"],["explore","init","explore"],["propose","explore","propose"],
      ["propose-ready","propose","propose_ready"],
    ] as const) {
      appendEvent(projectRoot, change, makeEvent(change, "transition_commit", {
        transition: t, from_state: f, to_state: to,
        outcome: "advanced", created_job_ids: [], reason: t,
      }, { transitionId: `T-scope-${t}`, idempotencyKey: `scope-${t}-key` }));
    }
    appendEvent(projectRoot, change, makeEvent(change, "transition_commit", {
      transition: "start-apply",
      from_state: "propose_ready",
      to_state: "apply",
      outcome: "advanced",
      created_job_ids: [],
      reason: "bad apply head",
      apply_start_head: "0000000000000000000000000000000000000000",
      apply_start_head_reason: "test_bad_head",
    }, { transitionId: "T-scope-start-apply", idempotencyKey: "scope-start-apply-key" }));
    appendEvent(projectRoot, change, makeEvent(change, "transition_commit", {
      transition: "review-ready",
      from_state: "apply",
      to_state: "apply_done",
      outcome: "advanced",
      created_job_ids: [],
      reason: "all tasks done",
    }, { transitionId: "T-scope-apply-done", idempotencyKey: "scope-apply-done-key" }));

    const created = reviewReady(projectRoot, change, changeRoot);
    assert.equal(created.outcome, "job_created");
    const packet = jobsPacket(projectRoot, change, created.created_jobs[0]).packet;
    assert.equal(packet?.code_review_scope?.scope_reliable, false);
    assert.equal(packet?.code_review_scope?.committed_paths, null);
    assert.match(String(packet?.code_review_scope?.scope_reason), /git diff .*failed/);
    assert.ok(packet?.code_review_scope?.review_paths.includes("src/a.ts"));
  } finally { rmSync(projectRoot, { recursive: true, force: true }); }
});

test("code-reviewer gate：缺失 current_head 的 accepted scope 不能满足 passed gate", () => {
  const fx = setupApplyWithDoneTask();
  try {
    initGitRepo(fx.projectRoot);
    mkdirSync(join(fx.projectRoot, "src"), { recursive: true });
    writeFileSync(join(fx.projectRoot, "src", "a.ts"), "export const value = 1;\n");

    assert.equal(reviewReady(fx.projectRoot, fx.change, fx.changeRoot).to_state, "apply_done");
    appendOpenJob(fx.projectRoot, fx.change, "apply_done", {
      job_id: "JOB-missing-current-head",
      role: "code-reviewer",
      state: "requested",
      created_from_transition: "review-ready",
      boundFiles: [{ path: "src/a.ts", sha: "sha256:legacy" }],
      packet_digest: "sha256:missing-current-head",
      packet_context: {
        code_review_scope: {
          base_head: null,
          scope_reliable: false,
          scope_reason: "legacy unreliable scope",
          committed_paths: null,
          worktree_paths: ["src/a.ts"],
          untracked_paths: [],
          review_paths: ["src/a.ts"],
        },
        coverage_exemption_refs: [],
        task_execution_index: [],
        unattributed_paths: ["src/a.ts"],
        unknown_attribution_tasks: [],
      } as unknown as Job["packet_context"],
    });
    appendEvent(fx.projectRoot, fx.change, makeEvent(fx.change, "job_accepted", {
      job_id: "JOB-missing-current-head",
      gate_id: "review.code_review",
      role: "code-reviewer",
      packet_digest: "sha256:missing-current-head",
      result_kind: "pass",
      reason: "legacy accepted pass",
    }));

    const result = reviewReady(fx.projectRoot, fx.change, fx.changeRoot);
    assert.equal(result.outcome, "job_created");
    assert.equal(result.from_state, "apply_done");
    assert.equal(result.to_state, "apply_done");
    assert.equal(result.created_jobs.length, 1);
    assert.notEqual(result.created_jobs[0], "JOB-missing-current-head");
    const packet = jobsPacket(fx.projectRoot, fx.change, result.created_jobs[0]).packet;
    assert.equal("current_head" in (packet?.code_review_scope ?? {}), true);
  } finally { fx.cleanup(); }
});

test("CLI transition review-ready：已有 code-reviewer job 时 blocked 退出码为 0", () => {
  const fx = setupApplyWithDoneTask();
  try {
    const toApplyDone = reviewReady(fx.projectRoot, fx.change, fx.changeRoot);
    assert.equal(toApplyDone.to_state, "apply_done");
    const created = reviewReady(fx.projectRoot, fx.change, fx.changeRoot);
    assert.equal(created.outcome, "job_created");

    const cli = new URL("../src/cli.ts", import.meta.url).pathname;
    const cliResult = spawnSync(process.execPath, [
      cli,
      "transition",
      "review-ready",
      "--change",
      fx.change,
    ], {
      cwd: fx.projectRoot,
      encoding: "utf8",
    });

    assert.equal(cliResult.status, 0, cliResult.stderr || cliResult.stdout);
    const parsed = JSON.parse(cliResult.stdout);
    assert.equal(parsed.outcome, "blocked");
    assert.equal(parsed.events_written, 0);
    assert.equal(parsed.required_jobs[0].job_id, created.created_jobs[0]);
  } finally { fx.cleanup(); }
});

test("review-ready：无代码类 diff 时跳过 code-reviewer，但 review 仍创建最终 verifier", () => {
  const fx = setupApplyWithDoneTask();
  try {
    initGitRepo(fx.projectRoot);
    const toApplyDone = reviewReady(fx.projectRoot, fx.change, fx.changeRoot);
    assert.equal(toApplyDone.to_state, "apply_done");

    confirmCurrentPhase(fx.projectRoot, fx.change, fx.changeRoot);
    const toReview = reviewReady(fx.projectRoot, fx.change, fx.changeRoot);
    assert.equal(toReview.outcome, "advanced");
    assert.equal(toReview.to_state, "review");
    const commit = readEvents(fx.projectRoot, fx.change).findLast(e =>
      e.event_type === "transition_commit" &&
      (e.payload as { from_state?: unknown; to_state?: unknown }).from_state === "apply_done" &&
      (e.payload as { from_state?: unknown; to_state?: unknown }).to_state === "review"
    );
    const skippedGate = (commit?.payload as { code_review_gate?: { decision?: unknown; reason?: unknown; head?: unknown } }).code_review_gate;
    assert.equal(skippedGate?.decision, "skipped");
    assert.equal(skippedGate?.reason, "no_code_changes");
    assert.equal("head" in (skippedGate ?? {}), true);

    const verifier = reviewReady(fx.projectRoot, fx.change, fx.changeRoot);
    assert.equal(verifier.outcome, "job_created");
    const snap = rebuildSnapshot(fx.projectRoot, fx.change, fx.changeRoot);
    assert.equal(snap.open_jobs.find(job => job.job_id === verifier.created_jobs[0])?.role, "verifier");
  } finally { fx.cleanup(); }
});

test("code-reviewer：pass 报告漏覆盖时可在同一工作项重交", () => {
  const fx = setupApplyWithDoneTask();
  try {
    initGitRepo(fx.projectRoot);
    mkdirSync(join(fx.projectRoot, "src"), { recursive: true });
    writeFileSync(join(fx.projectRoot, "src", "example.ts"), "export const value = 1;\n");

    reviewReady(fx.projectRoot, fx.change, fx.changeRoot);
    const created = reviewReady(fx.projectRoot, fx.change, fx.changeRoot);
    assert.equal(created.outcome, "job_created");
    const packet = jobsPacket(fx.projectRoot, fx.change, created.created_jobs[0]);
    assert.deepEqual((packet.packet?.boundFiles as { path: string }[]).map(file => file.path), ["src/example.ts"]);
    assert.match(String(packet.packet?.output_instructions), /项目内 fallback 报告若存在解码或协议错误会终结当前工作项/);

    const rejected = recordJobSubmitContent(
      fx.projectRoot,
      fx.change,
      fx.changeRoot,
      created.created_jobs[0],
      JSON.stringify(codeReviewerReport(fx.projectRoot, fx.change, created.created_jobs[0], "pass", [])),
    );
    assert.equal(rejected.accepted, false);
    assert.match(rejected.message, /未说明是否检查了 src\/example\.ts/);
    assert.equal(rejected.job_state, "requested");
    assert.equal(rejected.events_written, 0);
    assert.equal(readEvents(fx.projectRoot, fx.change).some(e => e.event_type === "job_rejected"), false);
    assert.equal(recordJobSubmitContent(
      fx.projectRoot,
      fx.change,
      fx.changeRoot,
      created.created_jobs[0],
      JSON.stringify(codeReviewerReport(fx.projectRoot, fx.change, created.created_jobs[0], "pass", [], ["src/example.ts"])),
    ).accepted, true);
  } finally { fx.cleanup(); }
});

test("code-reviewer：pass 报告不能把绑定文件留在 unchecked", () => {
  const fx = setupApplyWithDoneTask();
  try {
    initGitRepo(fx.projectRoot);
    mkdirSync(join(fx.projectRoot, "src"), { recursive: true });
    writeFileSync(join(fx.projectRoot, "src", "example.ts"), "export const value = 1;\n");

    reviewReady(fx.projectRoot, fx.change, fx.changeRoot);
    const created = reviewReady(fx.projectRoot, fx.change, fx.changeRoot);
    assert.equal(created.outcome, "job_created");
    const packet = jobsPacket(fx.projectRoot, fx.change, created.created_jobs[0]).packet;
    const submitted = recordJobSubmitContent(
      fx.projectRoot,
      fx.change,
      fx.changeRoot,
      created.created_jobs[0],
      JSON.stringify({
        role: "code-reviewer",
        verdict: "pass",
        review_scope: {
          job_id: created.created_jobs[0],
          packet_digest: packet?.packet_digest,
          checked_paths: [],
          checked_docs: ["proposal.md", "design.md", "tasks.md", ".superspec/artifacts/test-contract.md"],
          unchecked: [{ path: "src/example.ts", reason: "未实际检查" }],
        },
        findings: [],
        reviewer: { kind: "codex-subagent", id: "test-code-reviewer" },
      }),
    );
    assert.equal(submitted.accepted, false);
    assert.equal(submitted.job_state, "requested");
    assert.match(submitted.message, /pass 时不能包含未检查/);
  } finally { fx.cleanup(); }
});

test("code-reviewer scope：首个 task 边界排除 Apply 前未变化的脏文件", () => {
  const fx = setupApplyWithDoneTask();
  try {
    initGitRepo(fx.projectRoot);
    mkdirSync(join(fx.projectRoot, "src"), { recursive: true });
    writeFileSync(join(fx.projectRoot, "src", "preexisting.ts"), "export const preexisting = 1;\n");
    writeFileSync(join(fx.projectRoot, "src", "changed.ts"), "export const changed = 1;\n");
    execFileSync("git", ["add", "."], { cwd: fx.projectRoot, stdio: "ignore" });
    execFileSync("git", ["commit", "-m", "initial"], { cwd: fx.projectRoot, stdio: "ignore" });
    writeFileSync(join(fx.projectRoot, "src", "preexisting.ts"), "export const preexisting = 2;\n");
    const startedBoundary = dirtyCodeFiles(fx.projectRoot);
    assert.equal(startedBoundary.ok, true);
    appendEvent(fx.projectRoot, fx.change, makeEvent(fx.change, "task_started", {
      task_id: "TASK-001",
      attempt_id: "ATT-scope",
      task_structure_digest: "sha256:scope",
      contract_mode: false,
      boundary_snapshot: { head: execFileSync("git", ["rev-parse", "HEAD"], { cwd: fx.projectRoot, encoding: "utf8" }).trim(), dirty_files: startedBoundary.files },
    }));
    writeFileSync(join(fx.projectRoot, "src", "changed.ts"), "export const changed = 2;\n");
    const completedBoundary = dirtyCodeFiles(fx.projectRoot);
    assert.equal(completedBoundary.ok, true);
    appendEvent(fx.projectRoot, fx.change, makeEvent(fx.change, "task_completed", {
      task_id: "TASK-001",
      attempt_id: "ATT-scope",
      boundary_snapshot: { head: execFileSync("git", ["rev-parse", "HEAD"], { cwd: fx.projectRoot, encoding: "utf8" }).trim(), dirty_files: completedBoundary.files },
    }));

    const scope = scanCodeReviewScope(fx.projectRoot, readEvents(fx.projectRoot, fx.change));
    assert.deepEqual(scope.review_paths, ["src/changed.ts"]);
  } finally { fx.cleanup(); }
});

test("code-reviewer scope：复审只包含修复增量和原 finding 的直接证据文件", () => {
  const fx = setupApplyWithDoneTask();
  try {
    initGitRepo(fx.projectRoot);
    mkdirSync(join(fx.projectRoot, "src"), { recursive: true });
    for (const name of ["a.ts", "b.ts", "c.ts"]) writeFileSync(join(fx.projectRoot, "src", name), `export const ${name[0]} = 1;\n`);
    execFileSync("git", ["add", "."], { cwd: fx.projectRoot, stdio: "ignore" });
    execFileSync("git", ["commit", "-m", "initial"], { cwd: fx.projectRoot, stdio: "ignore" });
    writeFileSync(join(fx.projectRoot, "src", "a.ts"), "export const a = 2;\n");
    writeFileSync(join(fx.projectRoot, "src", "b.ts"), "export const b = 2;\n");
    writeFileSync(join(fx.projectRoot, "src", "c.ts"), "export const c = 2;\n");
    const head = execFileSync("git", ["rev-parse", "HEAD"], { cwd: fx.projectRoot, encoding: "utf8" }).trim();
    const job: Job = {
      job_id: "JOB-incremental-review",
      role: "code-reviewer",
      state: "requested",
      gate_id: "review.code_review",
      boundFiles: ["a.ts", "b.ts", "c.ts"].map(name => ({ path: `src/${name}`, sha: codeFileContentSha(fx.projectRoot, `src/${name}`) ?? "sha256:missing" })),
      packet_digest: "sha256:incremental",
      packet_context: {
        code_review_scope: {
          base_head: head,
          current_head: head,
          scope_reliable: true,
          scope_reason: "test",
          committed_paths: [],
          worktree_paths: ["src/a.ts", "src/b.ts", "src/c.ts"],
          untracked_paths: [],
          review_paths: ["src/a.ts", "src/b.ts", "src/c.ts"],
        },
      },
      created_from_transition: "review-ready",
      created_at: new Date().toISOString(),
    };
    appendEvent(fx.projectRoot, fx.change, makeEvent(fx.change, "transition_commit", {
      transition: "review-ready",
      from_state: "apply_done",
      to_state: "apply_done",
      outcome: "job_created",
      new_jobs: [job],
      created_job_ids: [job.job_id],
      reason: "review",
    }));
    appendEvent(fx.projectRoot, fx.change, makeEvent(fx.change, "job_rejected", {
      job_id: job.job_id,
      role: "code-reviewer",
      result_kind: "review_failed",
      findings: [{ id: "CR-001", blocking: true, type: "implementation", source_refs: ["src/a.ts:1"] }],
    }));
    writeFileSync(join(fx.projectRoot, "src", "b.ts"), "export const b = 3;\n");

    const scope = scanCodeReviewScope(fx.projectRoot, readEvents(fx.projectRoot, fx.change));
    assert.deepEqual(scope.review_paths, ["src/a.ts", "src/b.ts"]);
  } finally { fx.cleanup(); }
});

test("code-reviewer：文件路径 fallback 的报告文件不算代码范围变化", () => {
  const fx = setupApplyWithDoneTask();
  try {
    initGitRepo(fx.projectRoot);
    mkdirSync(join(fx.projectRoot, "src"), { recursive: true });
    writeFileSync(join(fx.projectRoot, "src", "example.ts"), "export const value = 1;\n");

    reviewReady(fx.projectRoot, fx.change, fx.changeRoot);
    const created = reviewReady(fx.projectRoot, fx.change, fx.changeRoot);
    assert.equal(created.outcome, "job_created");
    const jobId = created.created_jobs[0];
    const packet = jobsPacket(fx.projectRoot, fx.change, jobId);
    const reportPath = join(fx.projectRoot, "report.json");
    writeFileSync(reportPath, JSON.stringify({
      role: "code-reviewer",
      verdict: "pass",
      review_scope: {
        job_id: jobId,
        packet_digest: packet.packet?.packet_digest,
        checked_paths: ["src/example.ts"],
        checked_docs: ["proposal.md", "design.md", "tasks.md", ".superspec/artifacts/test-contract.md"],
        unchecked: [],
      },
      findings: [],
      reviewer: { kind: "codex-subagent", id: "test-code-reviewer" },
    }));

    const submitted = recordJobSubmit(fx.projectRoot, fx.change, fx.changeRoot, jobId, reportPath);
    assert.equal(submitted.accepted, true);
  } finally { fx.cleanup(); }
});

test("code-reviewer：项目内文件 fallback 的 scope 错误记录路径并避免污染 fresh scope", () => {
  const fx = setupApplyWithDoneTask();
  try {
    initGitRepo(fx.projectRoot);
    mkdirSync(join(fx.projectRoot, "src"), { recursive: true });
    writeFileSync(join(fx.projectRoot, "src", "example.ts"), "export const value = 1;\n");

    reviewReady(fx.projectRoot, fx.change, fx.changeRoot);
    const created = reviewReady(fx.projectRoot, fx.change, fx.changeRoot);
    assert.equal(created.outcome, "job_created");
    const jobId = created.created_jobs[0];
    const packet = jobsPacket(fx.projectRoot, fx.change, jobId);
    const reportPath = join(fx.projectRoot, "report.json");
    writeFileSync(reportPath, JSON.stringify({
      role: "code-reviewer",
      verdict: "pass",
      review_scope: {
        job_id: jobId,
        packet_digest: packet.packet?.packet_digest,
        checked_paths: [],
        checked_docs: ["proposal.md", "design.md", "tasks.md", ".superspec/artifacts/test-contract.md"],
        unchecked: [],
      },
      findings: [],
      reviewer: { kind: "codex-subagent", id: "test-code-reviewer" },
    }));

    const rejected = recordJobSubmit(fx.projectRoot, fx.change, fx.changeRoot, jobId, reportPath);
    assert.equal(rejected.accepted, false);
    assert.match(rejected.message, /未说明是否检查了 src\/example\.ts/);
    assert.equal(rejected.job_state, "rejected");
    assert.equal((readEvents(fx.projectRoot, fx.change).findLast(e => e.event_type === "job_rejected")?.payload as { report_path?: unknown }).report_path, "report.json");

    const fresh = reviewReady(fx.projectRoot, fx.change, fx.changeRoot);
    assert.equal(fresh.outcome, "job_created");
    const freshPaths = checkedPathsForJob(fx.projectRoot, fx.change, fresh.created_jobs[0]);
    assert.deepEqual(freshPaths, ["src/example.ts"]);

    writeFileSync(reportPath, JSON.stringify(
      codeReviewerReport(fx.projectRoot, fx.change, fresh.created_jobs[0], "pass", [], freshPaths),
    ));
    const accepted = recordJobSubmit(fx.projectRoot, fx.change, fx.changeRoot, fresh.created_jobs[0], reportPath);
    assert.equal(accepted.accepted, true);
  } finally { fx.cleanup(); }
});

test("code-reviewer：代码目录内的 fallback scope 错误同样不会进入 retry 范围", () => {
  const fx = setupApplyWithDoneTask();
  try {
    initGitRepo(fx.projectRoot);
    mkdirSync(join(fx.projectRoot, "src"), { recursive: true });
    writeFileSync(join(fx.projectRoot, "src", "example.ts"), "export const value = 1;\n");

    reviewReady(fx.projectRoot, fx.change, fx.changeRoot);
    const created = reviewReady(fx.projectRoot, fx.change, fx.changeRoot);
    assert.equal(created.outcome, "job_created");
    const jobId = created.created_jobs[0];
    const packet = jobsPacket(fx.projectRoot, fx.change, jobId);
    const reportPath = join(fx.projectRoot, "src", "report.json");
    writeFileSync(reportPath, JSON.stringify({
      role: "code-reviewer",
      verdict: "pass",
      review_scope: {
        job_id: jobId,
        packet_digest: packet.packet?.packet_digest,
        checked_paths: [],
        checked_docs: ["proposal.md", "design.md", "tasks.md", ".superspec/artifacts/test-contract.md"],
        unchecked: [],
      },
      findings: [],
      reviewer: { kind: "codex-subagent", id: "test-code-reviewer" },
    }));

    const rejected = recordJobSubmit(fx.projectRoot, fx.change, fx.changeRoot, jobId, reportPath);
    assert.equal(rejected.accepted, false);
    assert.equal(rejected.job_state, "rejected");
    assert.equal((readEvents(fx.projectRoot, fx.change).findLast(e => e.event_type === "job_rejected")?.payload as { report_path?: unknown }).report_path, "src/report.json");
    const retry = reviewReady(fx.projectRoot, fx.change, fx.changeRoot);
    assert.equal(retry.outcome, "job_created");
    const retryPacket = jobsPacket(fx.projectRoot, fx.change, retry.created_jobs[0]);
    const retryPaths = (retryPacket.packet?.boundFiles as { path: string }[]).map(file => file.path);
    assert.deepEqual(retryPaths, ["src/example.ts"]);
    assert.deepEqual(retryPacket.packet?.code_review_scope?.untracked_paths, ["src/example.ts"]);

    const retryReportPath = join(fx.projectRoot, "retry.json");
    writeFileSync(retryReportPath, JSON.stringify({
      role: "code-reviewer",
      verdict: "pass",
      review_scope: {
        job_id: retry.created_jobs[0],
        packet_digest: retryPacket.packet?.packet_digest,
        checked_paths: ["src/example.ts"],
        checked_docs: ["proposal.md", "design.md", "tasks.md", ".superspec/artifacts/test-contract.md"],
        unchecked: [],
      },
      findings: [],
      reviewer: { kind: "codex-subagent", id: "test-code-reviewer" },
    }));
    assert.equal(recordJobSubmit(fx.projectRoot, fx.change, fx.changeRoot, retry.created_jobs[0], retryReportPath).accepted, true);
  } finally { fx.cleanup(); }
});

test("code-reviewer：代码目录内的有效失败报告不应使当前用户决策过期", () => {
  const fx = setupApplyWithDoneTask();
  try {
    initGitRepo(fx.projectRoot);
    mkdirSync(join(fx.projectRoot, "src"), { recursive: true });
    writeFileSync(join(fx.projectRoot, "src", "example.ts"), "export const value = 1;\n");

    assert.equal(reviewReady(fx.projectRoot, fx.change, fx.changeRoot).to_state, "apply_done");
    const created = reviewReady(fx.projectRoot, fx.change, fx.changeRoot);
    assert.equal(created.outcome, "job_created");
    const jobId = created.created_jobs[0];
    const reportPath = join(fx.projectRoot, "src", "report.json");
    writeFileSync(reportPath, JSON.stringify(codeReviewerReport(fx.projectRoot, fx.change, jobId, "fail", [{
      id: "CR-SRC-REPORT-SPEC",
      type: "spec",
      blocking: true,
      description: "当前实现与计划边界需要确认",
      evidence: "src/example.ts 与 tasks.md 的行为不一致",
      source_refs: ["src/example.ts", "tasks.md"],
      impact: "实现路线可能偏离计划",
      suggested_action: "propose",
    }], ["src/example.ts"])));
    assert.equal(recordJobSubmit(fx.projectRoot, fx.change, fx.changeRoot, jobId, reportPath).accepted, false);
    assert.equal((readEvents(fx.projectRoot, fx.change).findLast(event => event.event_type === "job_rejected")?.payload as {
      report_path?: unknown;
    }).report_path, "src/report.json");

    const ask = next(fx.projectRoot, fx.change, fx.changeRoot);
    assert.equal(ask.path, "ask_user");
    assert.equal(recordUserDecisionContent(fx.projectRoot, fx.change, JSON.stringify({
      scope: ask.ask_user.scope,
      answer: "回到计划阶段",
      reason: "需要补充实现边界",
    })).accepted, true);
  } finally { fx.cleanup(); }
});

test("code-reviewer：accepted pass 后绑定文件变化必须重新审查", () => {
  const fx = setupApplyWithDoneTask();
  try {
    initGitRepo(fx.projectRoot);
    mkdirSync(join(fx.projectRoot, "src"), { recursive: true });
    writeFileSync(join(fx.projectRoot, "src", "example.ts"), "export const value = 1;\n");

    reviewReady(fx.projectRoot, fx.change, fx.changeRoot);
    const first = reviewReady(fx.projectRoot, fx.change, fx.changeRoot);
    assert.equal(first.outcome, "job_created");
    const submitted = submitCodeReviewerReport(
      fx.projectRoot,
      fx.change,
      fx.changeRoot,
      first.created_jobs[0],
      codeReviewerReport(fx.projectRoot, fx.change, first.created_jobs[0], "pass", [], ["src/example.ts"]),
    );
    assert.equal(submitted.accepted, true);

    writeFileSync(join(fx.projectRoot, "src", "example.ts"), "export const value = 2;\n");
    const planned = next(fx.projectRoot, fx.change, fx.changeRoot);
    assert.equal(planned.path, "next_command");
    assert.match(planned.next_command, /transition review-ready/);
    const retry = reviewReady(fx.projectRoot, fx.change, fx.changeRoot);
    assert.equal(retry.outcome, "job_created");
    assert.equal(retry.to_state, "apply_done");
    assert.notEqual(retry.created_jobs[0], first.created_jobs[0]);
    assert.equal(submitCodeReviewerReport(
      fx.projectRoot,
      fx.change,
      fx.changeRoot,
      retry.created_jobs[0],
      codeReviewerReport(fx.projectRoot, fx.change, retry.created_jobs[0], "pass", [], ["src/example.ts"]),
    ).accepted, true);
    confirmCurrentPhase(fx.projectRoot, fx.change, fx.changeRoot);
    assert.equal(reviewReady(fx.projectRoot, fx.change, fx.changeRoot).to_state, "review");
  } finally { fx.cleanup(); }
});

test("code-reviewer：accepted pass 后新增代码文件必须重新审查", () => {
  const fx = setupApplyWithDoneTask();
  try {
    initGitRepo(fx.projectRoot);
    mkdirSync(join(fx.projectRoot, "src"), { recursive: true });
    writeFileSync(join(fx.projectRoot, "src", "a.ts"), "export const a = 1;\n");

    reviewReady(fx.projectRoot, fx.change, fx.changeRoot);
    const first = reviewReady(fx.projectRoot, fx.change, fx.changeRoot);
    assert.equal(first.outcome, "job_created");
    assert.equal(submitCodeReviewerReport(
      fx.projectRoot,
      fx.change,
      fx.changeRoot,
      first.created_jobs[0],
      codeReviewerReport(fx.projectRoot, fx.change, first.created_jobs[0], "pass", [], ["src/a.ts"]),
    ).accepted, true);

    writeFileSync(join(fx.projectRoot, "src", "b.ts"), "export const b = 2;\n");
    const planned = next(fx.projectRoot, fx.change, fx.changeRoot);
    assert.equal(planned.path, "next_command");
    assert.match(planned.next_command, /transition review-ready/);
    const retry = reviewReady(fx.projectRoot, fx.change, fx.changeRoot);
    assert.equal(retry.outcome, "job_created");
    assert.equal(retry.to_state, "apply_done");
    assert.notEqual(retry.created_jobs[0], first.created_jobs[0]);
    assert.deepEqual(checkedPathsForJob(fx.projectRoot, fx.change, retry.created_jobs[0]), ["src/b.ts"]);
    const retrySubmitted = submitCodeReviewerReport(
      fx.projectRoot,
      fx.change,
      fx.changeRoot,
      retry.created_jobs[0],
      codeReviewerReport(fx.projectRoot, fx.change, retry.created_jobs[0], "pass", [], ["src/b.ts"]),
    );
    assert.equal(retrySubmitted.accepted, true, retrySubmitted.message);
    confirmCurrentPhase(fx.projectRoot, fx.change, fx.changeRoot);
    assert.equal(reviewReady(fx.projectRoot, fx.change, fx.changeRoot).to_state, "review");
  } finally { fx.cleanup(); }
});

test("code-reviewer：open job 后新增代码文件会拒绝旧范围报告", () => {
  const fx = setupApplyWithDoneTask();
  try {
    initGitRepo(fx.projectRoot);
    mkdirSync(join(fx.projectRoot, "src"), { recursive: true });
    writeFileSync(join(fx.projectRoot, "src", "a.ts"), "export const a = 1;\n");

    reviewReady(fx.projectRoot, fx.change, fx.changeRoot);
    const created = reviewReady(fx.projectRoot, fx.change, fx.changeRoot);
    assert.equal(created.outcome, "job_created");

    writeFileSync(join(fx.projectRoot, "src", "b.ts"), "export const b = 2;\n");
    const rejected = submitCodeReviewerReport(
      fx.projectRoot,
      fx.change,
      fx.changeRoot,
      created.created_jobs[0],
      codeReviewerReport(fx.projectRoot, fx.change, created.created_jobs[0], "pass", [], ["src/a.ts"]),
    );
    assert.equal(rejected.accepted, false);
    assert.match(rejected.message, /代码审查范围已变化/);
    const event = readEvents(fx.projectRoot, fx.change).findLast(e => e.event_type === "job_rejected");
    assert.equal((event?.payload as { result_kind?: unknown }).result_kind, "invalid_report");

    const retry = reviewReady(fx.projectRoot, fx.change, fx.changeRoot);
    assert.equal(retry.outcome, "job_created");
    const packet = jobsPacket(fx.projectRoot, fx.change, retry.created_jobs[0]);
    assert.deepEqual((packet.packet?.boundFiles as { path: string }[]).map(file => file.path), ["src/a.ts", "src/b.ts"]);
  } finally { fx.cleanup(); }
});

test("code-reviewer：删除代码文件也保留在绑定范围", () => {
  const fx = setupApplyWithDoneTask();
  try {
    initGitRepo(fx.projectRoot);
    mkdirSync(join(fx.projectRoot, "src"), { recursive: true });
    writeFileSync(join(fx.projectRoot, "src", "deleted.ts"), "export const deleted = true;\n");
    execFileSync("git", ["add", "src/deleted.ts"], { cwd: fx.projectRoot, stdio: "ignore" });
    execFileSync("git", ["commit", "-m", "seed deleted file"], { cwd: fx.projectRoot, stdio: "ignore" });
    rmSync(join(fx.projectRoot, "src", "deleted.ts"), { force: true });

    reviewReady(fx.projectRoot, fx.change, fx.changeRoot);
    const created = reviewReady(fx.projectRoot, fx.change, fx.changeRoot);
    assert.equal(created.outcome, "job_created");
    const packet = jobsPacket(fx.projectRoot, fx.change, created.created_jobs[0]);
    assert.deepEqual(packet.packet?.boundFiles, [{ path: "src/deleted.ts", sha: "sha256:missing" }]);

    const submitted = submitCodeReviewerReport(
      fx.projectRoot,
      fx.change,
      fx.changeRoot,
      created.created_jobs[0],
      codeReviewerReport(fx.projectRoot, fx.change, created.created_jobs[0], "pass", [], ["src/deleted.ts"]),
    );
    assert.equal(submitted.accepted, true);
  } finally { fx.cleanup(); }
});

test("代码文件指纹：symlink 使用链接目标作为共享内容指纹", () => {
  const projectRoot = mkdtempSync(join(tmpdir(), "superspec-symlink-"));
  try {
    initGitRepo(projectRoot);
    mkdirSync(join(projectRoot, "src"), { recursive: true });
    writeFileSync(join(projectRoot, "src", "a.ts"), "export const a = 1;\n");
    writeFileSync(join(projectRoot, "src", "b.ts"), "export const b = 2;\n");
    symlinkSync("a.ts", join(projectRoot, "src", "link.ts"));
    execFileSync("git", ["add", "."], { cwd: projectRoot, stdio: "ignore" });
    execFileSync("git", ["commit", "-m", "seed symlink"], { cwd: projectRoot, stdio: "ignore" });

    const first = codeFileContentSha(projectRoot, "src/link.ts");
    rmSync(join(projectRoot, "src", "link.ts"), { force: true });
    symlinkSync("b.ts", join(projectRoot, "src", "link.ts"));
    const second = codeFileContentSha(projectRoot, "src/link.ts");
    assert.notEqual(first, second);
    assert.equal(second, sha256Text("b.ts"));

    const dirty = dirtyCodeFiles(projectRoot);
    assert.equal(dirty.ok, true);
    assert.deepEqual(dirty.files.find(file => file.path === "src/link.ts"), {
      path: "src/link.ts",
      status: "modified",
      sha256: sha256Text("b.ts"),
    });
  } finally { rmSync(projectRoot, { recursive: true, force: true }); }
});

test("code-reviewer：schema 错误不写历史，修正后可重交同一工作项", () => {
  const fx = setupApplyWithDoneTask();
  try {
    reviewReady(fx.projectRoot, fx.change, fx.changeRoot);
    const first = reviewReady(fx.projectRoot, fx.change, fx.changeRoot);
    assert.equal(first.outcome, "job_created");

    const rejected = recordJobSubmitContent(fx.projectRoot, fx.change, fx.changeRoot, first.created_jobs[0], JSON.stringify({
      role: "code-reviewer",
      verdict: "pass",
      findings: [],
      reviewer: { kind: "codex-subagent", id: "test-code-reviewer" },
    }));
    assert.equal(rejected.accepted, false);
    assert.equal(rejected.job_state, "requested");
    assert.equal(readEvents(fx.projectRoot, fx.change).some(e => e.event_type === "job_rejected"), false);
    assert.equal(next(fx.projectRoot, fx.change, fx.changeRoot).path, "required_job");
    assert.equal(recordJobSubmitContent(
      fx.projectRoot,
      fx.change,
      fx.changeRoot,
      first.created_jobs[0],
      JSON.stringify(codeReviewerReport(fx.projectRoot, fx.change, first.created_jobs[0], "pass", [])),
    ).accepted, true);
  } finally { fx.cleanup(); }
});

test("code-reviewer：pass 中误带 blocking finding 可在同一工作项修正重交", () => {
  const fx = setupApplyWithDoneTask();
  try {
    reviewReady(fx.projectRoot, fx.change, fx.changeRoot);
    const created = reviewReady(fx.projectRoot, fx.change, fx.changeRoot);
    assert.equal(created.outcome, "job_created");
    const jobId = created.created_jobs[0];
    const invalid = recordJobSubmitContent(
      fx.projectRoot,
      fx.change,
      fx.changeRoot,
      jobId,
      JSON.stringify(codeReviewerReport(fx.projectRoot, fx.change, jobId, "pass", [{ blocking: true }])),
    );
    assert.equal(invalid.job_state, "requested");
    assert.equal(invalid.events_written, 0);
    assert.equal(readEvents(fx.projectRoot, fx.change).some(event =>
      event.event_type === "job_rejected" && event.payload.job_id === jobId
    ), false);
    assert.equal(recordJobSubmitContent(
      fx.projectRoot,
      fx.change,
      fx.changeRoot,
      jobId,
      JSON.stringify(codeReviewerReport(fx.projectRoot, fx.change, jobId, "pass", [])),
    ).accepted, true);
  } finally { fx.cleanup(); }
});

test("code-reviewer：non-actionable 报告仍写 terminal 并交给用户处理", () => {
  const fx = setupApplyWithDoneTask();
  try {
    reviewReady(fx.projectRoot, fx.change, fx.changeRoot);
    const first = reviewReady(fx.projectRoot, fx.change, fx.changeRoot);
    assert.equal(first.outcome, "job_created");
    const nonActionable = submitCodeReviewerReport(
      fx.projectRoot,
      fx.change,
      fx.changeRoot,
      first.created_jobs[0],
      codeReviewerReport(fx.projectRoot, fx.change, first.created_jobs[0], "fail", []),
    );
    assert.equal(nonActionable.accepted, false);
    const second = reviewReady(fx.projectRoot, fx.change, fx.changeRoot);
    assert.equal(second.outcome, "job_created");
    assert.equal(submitCodeReviewerReport(
      fx.projectRoot,
      fx.change,
      fx.changeRoot,
      second.created_jobs[0],
      codeReviewerReport(fx.projectRoot, fx.change, second.created_jobs[0], "fail", []),
    ).accepted, false);
    const rejectedEvent = readEvents(fx.projectRoot, fx.change).findLast(e => e.event_type === "job_rejected");
    assert.equal((rejectedEvent?.payload as { result_kind?: unknown }).result_kind, "non_actionable_report");

    const nextResult = next(fx.projectRoot, fx.change, fx.changeRoot);
    assert.equal(nextResult.path, "ask_user");
    assert.equal(nextResult.ask_user.scope, "code_reviewer_report_repair:test-change");

    const explicitRetry = reviewReady(fx.projectRoot, fx.change, fx.changeRoot);
    assert.equal(explicitRetry.outcome, "job_created");
    const packet = jobsPacket(fx.projectRoot, fx.change, explicitRetry.created_jobs[0]);
    assert.equal((packet.packet?.previous_rejection as { result_kind?: unknown })?.result_kind, "non_actionable_report");
  } finally { fx.cleanup(); }
});

test("code-reviewer：blocking finding 的 suggested_action 必须符合 packet 枚举", () => {
  const fx = setupApplyWithDoneTask();
  try {
    reviewReady(fx.projectRoot, fx.change, fx.changeRoot);
    const created = reviewReady(fx.projectRoot, fx.change, fx.changeRoot);
    assert.equal(created.outcome, "job_created");
    const jobId = created.created_jobs[0];
    const finding = {
      id: "CR-BAD-ACTION",
      type: "spec",
      blocking: true,
      description: "方案问题但 suggested_action 非法",
      evidence: "design.md 与 tasks.md 不一致",
      source_refs: ["design.md", "tasks.md"],
      impact: "主流程无法分流",
      suggested_action: "later",
    };

    const rejected = submitCodeReviewerReport(
      fx.projectRoot,
      fx.change,
      fx.changeRoot,
      jobId,
      codeReviewerReport(fx.projectRoot, fx.change, jobId, "fail", [finding]),
    );

    assert.equal(rejected.accepted, false);
    assert.match(rejected.message, /suggested_action 必须是 apply\|propose/);
    const rejectedEvent = readEvents(fx.projectRoot, fx.change).findLast(e => e.event_type === "job_rejected");
    assert.equal((rejectedEvent?.payload as { result_kind?: unknown }).result_kind, "non_actionable_report");
  } finally { fx.cleanup(); }
});

test("code-reviewer：blocking finding id 必须是安全 token", () => {
  const fx = setupApplyWithDoneTask();
  try {
    reviewReady(fx.projectRoot, fx.change, fx.changeRoot);
    const created = reviewReady(fx.projectRoot, fx.change, fx.changeRoot);
    assert.equal(created.outcome, "job_created");
    const jobId = created.created_jobs[0];
    const finding = {
      id: "CR BAD#1",
      type: "implementation",
      blocking: true,
      description: "问题编号包含空格和 #",
      evidence: "src/example.ts:10",
      source_refs: ["src/example.ts:10"],
      impact: "会破坏 reopen 命令和审查修复任务 id",
      suggested_action: "apply",
    };

    const rejected = submitCodeReviewerReport(
      fx.projectRoot,
      fx.change,
      fx.changeRoot,
      jobId,
      codeReviewerReport(fx.projectRoot, fx.change, jobId, "fail", [finding]),
    );

    assert.equal(rejected.accepted, false);
    assert.match(rejected.message, /id 只能包含/);
    const rejectedEvent = readEvents(fx.projectRoot, fx.change).findLast(e => e.event_type === "job_rejected");
    assert.equal((rejectedEvent?.payload as { result_kind?: unknown }).result_kind, "non_actionable_report");
  } finally { fx.cleanup(); }
});

test("code-reviewer：fail 报告混入不可处理阻塞项时整体要求重出报告", () => {
  const fx = setupApplyWithDoneTask();
  try {
    reviewReady(fx.projectRoot, fx.change, fx.changeRoot);
    const created = reviewReady(fx.projectRoot, fx.change, fx.changeRoot);
    assert.equal(created.outcome, "job_created");
    const jobId = created.created_jobs[0];
    const invalidFinding = {
      blocking: true,
      type: "implementation",
      description: "缺少稳定问题编号",
      evidence: "src/example.ts:10",
      source_refs: ["src/example.ts:10"],
      impact: "主流程无法生成可追溯的回退命令",
      suggested_action: "apply",
    };
    const validFinding = {
      id: "CR-VALID-001",
      type: "implementation",
      blocking: true,
      description: "修复空输入下的边界错误",
      evidence: "src/example.ts:10 空输入会抛异常",
      source_refs: ["src/example.ts:10"],
      impact: "用户提交空输入时流程中断",
      suggested_action: "apply",
    };

    const rejected = submitCodeReviewerReport(
      fx.projectRoot,
      fx.change,
      fx.changeRoot,
      jobId,
      codeReviewerReport(fx.projectRoot, fx.change, jobId, "fail", [invalidFinding, validFinding]),
    );

    assert.equal(rejected.accepted, false);
    assert.match(rejected.message, /包含无法处理的阻塞问题/);
    const rejectedEvent = readEvents(fx.projectRoot, fx.change).findLast(e => e.event_type === "job_rejected");
    assert.equal((rejectedEvent?.payload as { result_kind?: unknown }).result_kind, "non_actionable_report");

    const nextResult = next(fx.projectRoot, fx.change, fx.changeRoot);
    assert.equal(nextResult.path, "next_command");
    assert.match(nextResult.next_command, /review-ready/);

    const retry = reviewReady(fx.projectRoot, fx.change, fx.changeRoot);
    assert.equal(retry.outcome, "job_created");
    const packet = jobsPacket(fx.projectRoot, fx.change, retry.created_jobs[0]);
    assert.equal((packet.packet?.previous_rejection as { result_kind?: unknown })?.result_kind, "non_actionable_report");
  } finally { fx.cleanup(); }
});

test("code-reviewer：无效复审重试保留未闭环 finding，并在新计划周期截断", () => {
  const fx = setupApplyWithDoneTask();
  try {
    reviewReady(fx.projectRoot, fx.change, fx.changeRoot);
    const created = reviewReady(fx.projectRoot, fx.change, fx.changeRoot);
    assert.equal(created.outcome, "job_created");
    const jobId = created.created_jobs[0];
    const finding = {
      id: "CR-001",
      type: "implementation",
      blocking: true,
      description: "修复空输入下的边界错误",
      evidence: "src/example.ts:10 空输入会抛异常",
      source_refs: ["src/example.ts:10"],
      impact: "用户提交空输入时流程中断",
      suggested_action: "apply",
    };
    const siblingFinding = {
      id: "CR-002",
      type: "implementation",
      blocking: true,
      description: "兼容调用仍会绕过空输入修复",
      evidence: "src/example.ts:20 旧入口未复用当前边界处理",
      source_refs: ["src/example.ts:20"],
      impact: "旧调用方仍可能遇到相同异常",
      suggested_action: "apply",
    };
    const rejected = submitCodeReviewerReport(
      fx.projectRoot,
      fx.change,
      fx.changeRoot,
      jobId,
      codeReviewerReport(fx.projectRoot, fx.change, jobId, "fail", [finding, siblingFinding]),
    );
    assert.equal(rejected.accepted, false);
    const rejectedEvent = readEvents(fx.projectRoot, fx.change).findLast(e => e.event_type === "job_rejected");
    assert.equal((rejectedEvent?.payload as { result_kind?: unknown }).result_kind, "review_failed");
    assert.equal((rejectedEvent?.payload as { raw_kind?: unknown }).raw_kind, "review-reports");
    const rawLines = readFileSync(rawFile(fx.projectRoot, fx.change, "review-reports"), "utf8").trim().split("\n");
    assert.deepEqual(
      JSON.parse(rawLines.at(-1) ?? "{}").findings.map((item: { id?: string }) => item.id),
      ["CR-001", "CR-002"],
    );

    const nextResult = next(fx.projectRoot, fx.change, fx.changeRoot);
    assert.equal(nextResult.path, "next_command");
    assert.match(nextResult.next_command, new RegExp(`--review-fix ${jobId}#CR-001`));

    const reopened = reopen(fx.projectRoot, fx.change, fx.changeRoot, "apply", "fix code-reviewer finding CR-001", {
      reviewFix: `${jobId}#CR-001`,
    });
    assert.equal(reopened.to_state, "apply");
    const tasks = readFileSync(join(fx.changeRoot, "tasks.md"), "utf8");
    assert.match(tasks, new RegExp(`REVIEW-FIX-${jobId}#CR-001`));
    assert.match(tasks, new RegExp(`review_fix_of:${jobId}#CR-001`));
    assert.match(tasks, /兑现 D（breaks_existing）/);
    assert.doesNotMatch(tasks, /修复空输入下的边界错误/);
    assert.doesNotMatch(tasks, /tdd_required:true/);

    const fixTaskId = `REVIEW-FIX-${jobId}#CR-001`;
    const started = taskStart(fx.projectRoot, fx.change, fx.changeRoot, fixTaskId);
    assert.equal(started.outcome, "advanced");
    const fixAttempt = rebuildSnapshot(fx.projectRoot, fx.change, fx.changeRoot).active_task_attempts[0];
    appendTestRunEvent(fx.projectRoot, fx.change, {
      test_id: fixTaskId,
      attempt_id: fixAttempt.attempt_id,
      task_structure_digest: fixAttempt.task_structure_digest,
      semantic_status: "expected_failure",
      exit_code: 1,
    });
    appendTestRunEvent(fx.projectRoot, fx.change, {
      test_id: fixTaskId,
      attempt_id: fixAttempt.attempt_id,
      task_structure_digest: fixAttempt.task_structure_digest,
      semantic_status: "expected_success",
      exit_code: 0,
    });
    const scopeNote = {
      scope_note: {
        reason: "现有公共入口是两个真实消费者共享的兼容边界，局部复制会造成行为分叉",
        changed_area: "src/example.ts:10 保留现有公共入口",
        plan_alignment: "保持已批准行为和兼容语义，不增加新能力",
        verification: ["两个现有消费者均通过同一入口完成回归验证"],
      },
    };
    const completed = taskComplete(
      fx.projectRoot,
      fx.change,
      fx.changeRoot,
      fixTaskId,
      JSON.stringify(scopeNote),
    );
    assert.equal(completed.outcome, "advanced");

    const completedTasks = readFileSync(join(fx.changeRoot, "tasks.md"), "utf8");
    assert.ok(completedTasks.includes(`- [x] ${fixTaskId} `));
    const applyDone = reviewReady(fx.projectRoot, fx.change, fx.changeRoot);
    assert.equal(applyDone.to_state, "apply_done", applyDone.message);
    const rereview = reviewReady(fx.projectRoot, fx.change, fx.changeRoot);
    assert.equal(rereview.outcome, "job_created");
    const packet = jobsPacket(fx.projectRoot, fx.change, rereview.created_jobs[0]);
    const executionIndex = packet.packet?.task_execution_index as Array<{
      task_id?: string;
      fix?: { review_finding?: { job_id?: string; finding_id?: string } };
      scope_note?: Record<string, unknown> | null;
    }>;
    const fixEntry = executionIndex.find(entry => entry.task_id === fixTaskId);
    assert.equal(fixEntry?.fix?.review_finding?.job_id, jobId);
    assert.equal(fixEntry?.fix?.review_finding?.finding_id, "CR-001");
    assert.deepEqual(fixEntry?.scope_note, scopeNote.scope_note);
    const previous = packet.packet?.previous_rejection as { findings?: Array<{ id?: string }> };
    assert.deepEqual(previous.findings?.map(item => item.id), ["CR-001", "CR-002"]);

    const rereviewJobId = rereview.created_jobs[0];
    const checkedPaths = ((packet.packet?.boundFiles ?? []) as Array<{ path?: unknown }>)
      .map(item => item.path)
      .filter((path): path is string => typeof path === "string");
    submitCodeReviewerReport(
      fx.projectRoot,
      fx.change,
      fx.changeRoot,
      rereviewJobId,
      codeReviewerReport(fx.projectRoot, fx.change, rereviewJobId, "fail", [], checkedPaths),
    );
    const retryReview = reviewReady(fx.projectRoot, fx.change, fx.changeRoot);
    assert.equal(retryReview.outcome, "job_created");
    const retryJobId = retryReview.created_jobs[0];
    const retryPacket = jobsPacket(fx.projectRoot, fx.change, retryJobId);
    const retryPrevious = retryPacket.packet?.previous_rejection as { findings?: Array<{ id?: string }> };
    assert.deepEqual(retryPrevious.findings?.map(item => item.id), ["CR-001", "CR-002"]);
    const retryCheckedPaths = ((retryPacket.packet?.boundFiles ?? []) as Array<{ path?: unknown }>)
      .map(item => item.path)
      .filter((path): path is string => typeof path === "string");
    submitCodeReviewerReport(
      fx.projectRoot,
      fx.change,
      fx.changeRoot,
      retryJobId,
      codeReviewerReport(fx.projectRoot, fx.change, retryJobId, "fail", [{
        id: "CR-SPEC-NEW",
        type: "spec",
        blocking: true,
        description: "当前计划需要重新确定兼容边界",
        evidence: "design.md 的兼容策略不足以支持正确实现",
        source_refs: ["design.md"],
        impact: "继续 Apply 会沿用已经失效的方案",
        suggested_action: "propose",
      }], retryCheckedPaths),
    );
    const ask = next(fx.projectRoot, fx.change, fx.changeRoot);
    assert.equal(ask.path, "ask_user");
    if (ask.path !== "ask_user") throw new Error("expected code review decision");
    assert.equal(recordUserDecisionContent(fx.projectRoot, fx.change, JSON.stringify({
      scope: `code_review_decision:${retryJobId}#CR-SPEC-NEW`,
      question: ask.ask_user.question,
      answer: "回到计划阶段",
      reason: "兼容边界需要重新规划",
    })).accepted, true);
    assert.equal(reopen(fx.projectRoot, fx.change, fx.changeRoot, "propose", "重新规划兼容边界", {
      reviewFinding: `${retryJobId}#CR-SPEC-NEW`,
    }).to_state, "propose");

    writeFileSync(join(fx.changeRoot, "design.md"), "# D\n\n## 新计划周期\n\n重新确认兼容边界。\n");
    assert.equal(proposeReady(fx.projectRoot, fx.change, fx.changeRoot, "minimal").to_state, "propose_ready");
    confirmCurrentPhase(fx.projectRoot, fx.change, fx.changeRoot, "minimal");
    assert.equal(startApply(fx.projectRoot, fx.change, fx.changeRoot).to_state, "apply");
    assert.equal(reviewReady(fx.projectRoot, fx.change, fx.changeRoot).to_state, "apply_done");
    const newCycleReview = reviewReady(fx.projectRoot, fx.change, fx.changeRoot);
    assert.equal(newCycleReview.outcome, "job_created");
    const newCyclePacket = jobsPacket(fx.projectRoot, fx.change, newCycleReview.created_jobs[0]);
    assert.equal(newCyclePacket.packet?.previous_rejection, undefined);
  } finally { fx.cleanup(); }
});

test("self-test-fix：已完成实现可直接回 apply，不进入 proposal 审核", () => {
  const fx = setupApplyWithDoneTask();
  try {
    assert.equal(reviewReady(fx.projectRoot, fx.change, fx.changeRoot).to_state, "apply_done");

    const reopened = reopen(fx.projectRoot, fx.change, fx.changeRoot, "apply", "自测发现空输入仍会抛错", {
      selfTestFix: "TASK-001",
    });
    assert.equal(reopened.from_state, "apply_done");
    assert.equal(reopened.to_state, "apply");
    assert.equal(rebuildSnapshot(fx.projectRoot, fx.change, fx.changeRoot).open_jobs.length, 0);

    const tasks = readFileSync(join(fx.changeRoot, "tasks.md"), "utf8");
    const fixId = /^- \[ \] (FIX-SELFTEST-TASK-001-[A-Fa-f0-9]+) /m.exec(tasks)?.[1];
    assert.ok(fixId);
    assert.match(tasks, new RegExp(`self_test_fix_of:TASK-001:${fixId}`));
    assert.doesNotMatch(tasks, /REVIEW-FIX-/);

    const commit = readEvents(fx.projectRoot, fx.change).findLast(event =>
      event.event_type === "transition_commit" &&
      (event.payload as { fix?: unknown }).fix != null
    );
    assert.deepEqual((commit?.payload as { fix?: unknown }).fix, {
      fix_id: fixId,
      source: "self_test",
      parent_task_id: "TASK-001",
      reason: "自测发现空输入仍会抛错",
    });

    const taskStarted = taskStart(fx.projectRoot, fx.change, fx.changeRoot, fixId!);
    assert.equal(taskStarted.to_state, "apply");
    assert.deepEqual((taskStarted.details?.fix as { source?: string; parent_task_id?: string } | undefined), {
      fix_id: fixId,
      source: "self_test",
      parent_task_id: "TASK-001",
      reason: "自测发现空输入仍会抛错",
    });

    const repeated = reopen(fx.projectRoot, fx.change, fx.changeRoot, "apply", "自测发现空输入仍会抛错", {
      selfTestFix: "TASK-001",
    });
    assert.equal(repeated.events_written, 0);
    assert.match(repeated.message, /尚未完成/);
    assert.equal((readFileSync(join(fx.changeRoot, "tasks.md"), "utf8").match(/self_test_fix_of:/g) ?? []).length, 1);

    const fixAttempt = rebuildSnapshot(fx.projectRoot, fx.change, fx.changeRoot).active_task_attempts.find(attempt => attempt.task_id === fixId);
    assert.ok(fixAttempt);
    appendTestRunEvent(fx.projectRoot, fx.change, {
      test_id: "TEST-SELFTEST-FIX",
      attempt_id: fixAttempt.attempt_id,
      task_structure_digest: fixAttempt.task_structure_digest,
      semantic_status: "expected_failure",
      exit_code: 1,
    });
    appendTestRunEvent(fx.projectRoot, fx.change, {
      test_id: "TEST-SELFTEST-FIX",
      attempt_id: fixAttempt.attempt_id,
      task_structure_digest: fixAttempt.task_structure_digest,
      semantic_status: "expected_success",
      exit_code: 0,
    });
    assert.equal(taskComplete(fx.projectRoot, fx.change, fx.changeRoot, fixId!).to_state, "apply");
    assert.equal(reviewReady(fx.projectRoot, fx.change, fx.changeRoot).to_state, "apply_done");
    advanceApplyDoneToReview(fx.projectRoot, fx.change, fx.changeRoot);
    const verifier = reviewReady(fx.projectRoot, fx.change, fx.changeRoot);
    assert.equal(verifier.outcome, "job_created");
    const verifierPacket = jobsPacket(fx.projectRoot, fx.change, verifier.created_jobs[0]).packet;
    assert.deepEqual(verifierPacket?.task_execution_index?.find(entry => entry.task_id === fixId)?.fix, {
      fix_id: fixId,
      source: "self_test",
      parent_task_id: "TASK-001",
      reason: "自测发现空输入仍会抛错",
    });
  } finally { fx.cleanup(); }
});

test("self-test-fix：契约模式可关联此前 Apply 轮已完成的父 task", () => {
  const fx = setupApplyWithDoneTask();
  try {
    const tasksContent = readFileSync(join(fx.changeRoot, "tasks.md"), "utf8");
    const historicalStart = makeEvent(fx.change, "transition_commit", {
      transition: "start-apply",
      from_state: "propose_ready",
      to_state: "apply",
      outcome: "advanced",
      created_job_ids: [],
      reason: "historical contract apply round",
      apply_contract_mode: true,
      execution_requirement_version: 2,
      execution_policy: "green_only",
    }, { transitionId: "T-historical-contract-apply", idempotencyKey: "historical-contract-apply" });
    appendEvent(fx.projectRoot, fx.change, historicalStart);
    appendEvent(fx.projectRoot, fx.change, makeEvent(fx.change, "task_started", {
      task_id: "TASK-001",
      attempt_id: "ATT-TASK-001-HISTORICAL",
      task_structure_digest: sha256Text(tasksContent.replace(/- \[[xX]\]/g, "- [ ]")),
      contract_mode: true,
    }, { transitionId: "T-historical-task-start" }));
    appendEvent(fx.projectRoot, fx.change, makeEvent(fx.change, "task_completed", {
      task_id: "TASK-001",
      attempt_id: "ATT-TASK-001-HISTORICAL",
      checkbox_update: { status: "applied" },
    }, { transitionId: "T-historical-task-complete" }));

    // 新 Apply round 没有再次产生 TASK-001 的完成事件。
    appendEvent(fx.projectRoot, fx.change, makeEvent(fx.change, "transition_commit", {
      transition: "start-apply",
      from_state: "propose_ready",
      to_state: "apply",
      outcome: "advanced",
      created_job_ids: [],
      reason: "current contract apply round",
      apply_contract_mode: true,
      execution_requirement_version: 2,
      execution_policy: "green_only",
    }, { transitionId: "T-current-contract-apply", idempotencyKey: "current-contract-apply" }));

    const reopened = reopen(fx.projectRoot, fx.change, fx.changeRoot, "apply", "自测发现历史实现仍有边界问题", {
      selfTestFix: "TASK-001",
    });
    assert.equal(reopened.to_state, "apply");
    assert.equal(reopened.events_written, 1);
    assert.match(readFileSync(join(fx.changeRoot, "tasks.md"), "utf8"), /FIX-SELFTEST-TASK-001-/);
  } finally { fx.cleanup(); }
});

test("Apply 计划材料冻结：遗漏修正必须回 Propose，且复用 Apply 起始基线", () => {
  const fx = setupApplyWithDoneTask();
  try {
    const frozen = applyPlanningBaseline(fx.changeRoot);
    writeFileSync(join(fx.changeRoot, "design.md"), "# D\n\n补充遗漏的公开接口约束\n");

    const selfTestRepair = reopen(fx.projectRoot, fx.change, fx.changeRoot, "apply", "计划遗漏了公开接口", {
      selfTestFix: "TASK-001",
    });
    assert.equal(selfTestRepair.events_written, 0);
    assert.doesNotMatch(readFileSync(join(fx.changeRoot, "tasks.md"), "utf8"), /FIX-SELFTEST-/);

    const review = reviewReady(fx.projectRoot, fx.change, fx.changeRoot, "minimal");
    assert.equal(review.events_written, 0);
    assert.equal(rebuildSnapshot(fx.projectRoot, fx.change, fx.changeRoot).state, "apply");

    const reopened = reopen(fx.projectRoot, fx.change, fx.changeRoot, "propose", "补齐计划遗漏");
    assert.equal(reopened.to_state, "propose");
    const commit = readEvents(fx.projectRoot, fx.change).findLast(event =>
      event.event_type === "transition_commit" &&
      (event.payload as { transition?: unknown }).transition === "reopen"
    );
    const payload = commit?.payload as { baseline_source?: unknown; baseline_docs?: Record<string, string> };
    assert.equal(payload.baseline_source, "apply");
    assert.equal(payload.baseline_docs?.["design.md"], frozen["design.md"]);

    assert.equal(proposeReady(fx.projectRoot, fx.change, fx.changeRoot, "minimal").to_state, "propose_ready");
    assert.equal(startApply(fx.projectRoot, fx.change, fx.changeRoot).to_state, "apply");
    const nextResult = next(fx.projectRoot, fx.change, fx.changeRoot, "minimal");
    assert.equal(nextResult.path, "next_command");
    if (nextResult.path === "next_command") assert.match(nextResult.next_command, /review-ready/);
  } finally { fx.cleanup(); }
});

test("Apply 计划材料冻结：活跃任务不能在计划材料变化后完成", () => {
  const fx = setupApplyWithDoneTask();
  try {
    writeFileSync(join(fx.changeRoot, "tasks.md"), "# Tasks\n\n- [ ] TASK-001 Pending\n");
    assert.equal(taskStart(fx.projectRoot, fx.change, fx.changeRoot, "TASK-001").to_state, "apply");
    writeFileSync(join(fx.changeRoot, "proposal.md"), "# P\n\n扩大交付范围\n");

    const completed = taskComplete(fx.projectRoot, fx.change, fx.changeRoot, "TASK-001");
    assert.equal(completed.events_written, 0);
    assert.equal(rebuildSnapshot(fx.projectRoot, fx.change, fx.changeRoot).active_task_attempts.length, 1);

    assert.equal(reopen(fx.projectRoot, fx.change, fx.changeRoot, "propose", "计划范围已变化").to_state, "propose");
    assert.equal(rebuildSnapshot(fx.projectRoot, fx.change, fx.changeRoot).active_task_attempts.length, 0);
  } finally { fx.cleanup(); }
});

test("Propose 返工：重新打开既有 task 时保留新的 Apply 确认", () => {
  const fx = setupApplyWithDoneTask();
  try {
    assert.equal(reopen(fx.projectRoot, fx.change, fx.changeRoot, "propose", "调整已批准需求").to_state, "propose");
    writeFileSync(join(fx.changeRoot, "design.md"), "# D\n\n默认路径调整为新位置\n");
    writeFileSync(join(fx.changeRoot, "tasks.md"), [
      "# Tasks", "",
      "- [ ] TASK-001 Update the new default path",
      "  执行依据:",
      "  - 测试:",
      "  - 设计: design.md#D",
      "  - 来源: proposal.md#P",
      "  - 验收: 文档使用新的默认路径",
      "  - 边界: 不改变其他参数语义",
      "",
    ].join("\n"));

    assert.equal(proposeReady(fx.projectRoot, fx.change, fx.changeRoot, "minimal").to_state, "propose_ready");
    const waiting = next(fx.projectRoot, fx.change, fx.changeRoot, "minimal");
    assert.equal(waiting.path, "ask_user");

    confirmCurrentPhase(fx.projectRoot, fx.change, fx.changeRoot, "minimal");
    assert.equal(startApply(fx.projectRoot, fx.change, fx.changeRoot).to_state, "apply");
    const nextResult = next(fx.projectRoot, fx.change, fx.changeRoot, "minimal");
    assert.equal(nextResult.path, "next_command");
    if (nextResult.path === "next_command") assert.match(nextResult.next_command, /task-start.*TASK-001/);
  } finally { fx.cleanup(); }
});

test("self-test-fix：同一自测问题完成后可创建新的修复发生次数", () => {
  const fx = setupApplyWithDoneTask();
  try {
    assert.equal(reviewReady(fx.projectRoot, fx.change, fx.changeRoot).to_state, "apply_done");
    const reason = "自测发现空输入仍会抛错";
    assert.equal(reopen(fx.projectRoot, fx.change, fx.changeRoot, "apply", reason, {
      selfTestFix: "TASK-001",
    }).to_state, "apply");
    const firstFix = (readEvents(fx.projectRoot, fx.change).findLast(event =>
      event.event_type === "transition_commit" && (event.payload as { fix?: unknown }).fix != null
    )?.payload as { fix?: { fix_id?: string } }).fix?.fix_id;
    assert.equal(typeof firstFix, "string");

    const started = taskStart(fx.projectRoot, fx.change, fx.changeRoot, String(firstFix));
    const attemptId = String(started.details?.attempt_id);
    appendTestRunEvent(fx.projectRoot, fx.change, {
      test_id: "TEST-SELFTEST-RECURRENCE",
      attempt_id: attemptId,
      task_structure_digest: rebuildSnapshot(fx.projectRoot, fx.change, fx.changeRoot).active_task_attempts[0].task_structure_digest,
      semantic_status: "expected_failure",
      exit_code: 1,
    });
    appendTestRunEvent(fx.projectRoot, fx.change, {
      test_id: "TEST-SELFTEST-RECURRENCE",
      attempt_id: attemptId,
      task_structure_digest: rebuildSnapshot(fx.projectRoot, fx.change, fx.changeRoot).active_task_attempts[0].task_structure_digest,
      semantic_status: "expected_success",
      exit_code: 0,
    });
    assert.equal(taskComplete(fx.projectRoot, fx.change, fx.changeRoot, String(firstFix)).to_state, "apply");
    assert.equal(reviewReady(fx.projectRoot, fx.change, fx.changeRoot).to_state, "apply_done");

    assert.equal(reopen(fx.projectRoot, fx.change, fx.changeRoot, "apply", reason, {
      selfTestFix: "TASK-001",
    }).to_state, "apply");
    const secondFix = (readEvents(fx.projectRoot, fx.change).findLast(event =>
      event.event_type === "transition_commit" && (event.payload as { fix?: unknown }).fix != null
    )?.payload as { fix?: { fix_id?: string } }).fix?.fix_id;
    assert.equal(secondFix, `${firstFix}-2`);
    assert.equal((readFileSync(join(fx.changeRoot, "tasks.md"), "utf8").match(/self_test_fix_of:/g) ?? []).length, 2);
  } finally { fx.cleanup(); }
});

test("self-test-fix：第十次之后继续使用新的发生次数而不复用 task ID", () => {
  const fx = setupApplyWithDoneTask();
  try {
    assert.equal(reviewReady(fx.projectRoot, fx.change, fx.changeRoot).to_state, "apply_done");
    const reason = "自测发现同一边界仍会回归";
    assert.equal(reopen(fx.projectRoot, fx.change, fx.changeRoot, "apply", reason, {
      selfTestFix: "TASK-001",
    }).to_state, "apply");
    const firstFix = (readEvents(fx.projectRoot, fx.change).findLast(event =>
      event.event_type === "transition_commit" && (event.payload as { fix?: unknown }).fix != null
    )?.payload as { fix?: { fix_id?: string } }).fix?.fix_id;
    assert.equal(typeof firstFix, "string");

    const tasksPath = join(fx.changeRoot, "tasks.md");
    const historicalOccurrences = Array.from({ length: 9 }, (_, index) =>
      `- [x] ${firstFix}-${index + 2} historical completed occurrence`
    );
    const completedFirst = readFileSync(tasksPath, "utf8")
      .replace(`- [ ] ${firstFix} `, `- [x] ${firstFix} `);
    writeFileSync(tasksPath, `${completedFirst}${historicalOccurrences.join("\n")}\n`);

    assert.equal(reopen(fx.projectRoot, fx.change, fx.changeRoot, "apply", reason, {
      selfTestFix: "TASK-001",
    }).to_state, "apply");
    const eleventhFix = (readEvents(fx.projectRoot, fx.change).findLast(event =>
      event.event_type === "transition_commit" && (event.payload as { fix?: unknown }).fix != null
    )?.payload as { fix?: { fix_id?: string } }).fix?.fix_id;
    assert.equal(eleventhFix, `${firstFix}-11`);
  } finally { fx.cleanup(); }
});

test("self-test-fix：新 Apply 轮保留已完成旧修复的完成态", () => {
  const fx = setupApplyWithDoneTask();
  try {
    const reason = "自测发现同一边界仍会回归";
    assert.equal(reopen(fx.projectRoot, fx.change, fx.changeRoot, "apply", reason, {
      selfTestFix: "TASK-001",
    }).to_state, "apply");
    const firstFix = (readEvents(fx.projectRoot, fx.change).findLast(event =>
      event.event_type === "transition_commit" && (event.payload as { fix?: unknown }).fix != null
    )?.payload as { fix?: { fix_id?: string } }).fix?.fix_id;
    assert.equal(typeof firstFix, "string");
    const tasksPath = join(fx.changeRoot, "tasks.md");
    writeFileSync(
      tasksPath,
      readFileSync(tasksPath, "utf8").replace(`- [ ] ${firstFix} `, `- [x] ${firstFix} `),
    );

    appendEvent(fx.projectRoot, fx.change, makeEvent(fx.change, "transition_commit", {
      transition: "start-apply",
      from_state: "propose_ready",
      to_state: "apply",
      outcome: "advanced",
      created_job_ids: [],
      reason: "new contract apply round",
      apply_contract_mode: true,
      execution_requirement_version: 2,
      execution_policy: "green_only",
    }, { transitionId: "T-new-contract-apply", idempotencyKey: "new-contract-apply" }));
    appendEvent(fx.projectRoot, fx.change, makeEvent(fx.change, "task_completed", {
      task_id: "TASK-001",
      attempt_id: "ATT-parent-current-round",
    }, { transitionId: "T-parent-current-round", idempotencyKey: "parent-current-round" }));

    assert.equal(reopen(fx.projectRoot, fx.change, fx.changeRoot, "apply", reason, {
      selfTestFix: "TASK-001",
    }).to_state, "apply");
    const secondFix = (readEvents(fx.projectRoot, fx.change).findLast(event =>
      event.event_type === "transition_commit" && (event.payload as { fix?: unknown }).fix != null
    )?.payload as { fix?: { fix_id?: string } }).fix?.fix_id;
    assert.equal(secondFix, `${firstFix}-2`);
  } finally { fx.cleanup(); }
});

test("self-test-fix：不允许绕过未处理的代码审查问题或未完成 task", () => {
  const fx = setupApplyWithDoneTask();
  try {
    writeFileSync(join(fx.changeRoot, "tasks.md"), "# Tasks\n\n- [x] TASK-001 Done\n- [ ] TASK-002 Pending\n");
    const pending = reopen(fx.projectRoot, fx.change, fx.changeRoot, "apply", "自测问题", {
      selfTestFix: "TASK-001",
    });
    assert.equal(pending.events_written, 0);
    assert.match(pending.message, /全部完成/);

    writeFileSync(join(fx.changeRoot, "tasks.md"), "# Tasks\n\n- [x] TASK-001 Done\n");
    assert.equal(reviewReady(fx.projectRoot, fx.change, fx.changeRoot).to_state, "apply_done");
    const created = reviewReady(fx.projectRoot, fx.change, fx.changeRoot);
    assert.equal(created.outcome, "job_created");
    const finding = {
      id: "CR-BLOCK-001",
      type: "implementation",
      blocking: true,
      description: "已知实现缺陷",
      evidence: "src/example.ts:10",
      source_refs: ["src/example.ts:10"],
      impact: "请求失败",
      suggested_action: "apply",
    };
    assert.equal(submitCodeReviewerReport(
      fx.projectRoot,
      fx.change,
      fx.changeRoot,
      created.created_jobs[0],
      codeReviewerReport(fx.projectRoot, fx.change, created.created_jobs[0], "fail", [finding]),
    ).accepted, false);

    const blocked = reopen(fx.projectRoot, fx.change, fx.changeRoot, "apply", "另一个自测问题", {
      selfTestFix: "TASK-001",
    });
    assert.equal(blocked.events_written, 0);
    assert.match(blocked.message, /已有未处理的代码审查问题 CR-BLOCK-001/);
  } finally { fx.cleanup(); }
});

test("self-test-fix：review 和 accepted 中均回到 apply，且 review 的旧 job 会失效", () => {
  const reviewFx = setupApplyWithDoneTask();
  try {
    advanceApplyToReview(reviewFx.projectRoot, reviewFx.change, reviewFx.changeRoot, "minimal");
    const verifier = reviewReady(reviewFx.projectRoot, reviewFx.change, reviewFx.changeRoot, "minimal");
    assert.equal(verifier.outcome, "job_created");

    const reopened = reopen(reviewFx.projectRoot, reviewFx.change, reviewFx.changeRoot, "apply", "review 后自测仍发现空输入失败", {
      selfTestFix: "TASK-001",
    });
    assert.equal(reopened.from_state, "review");
    assert.equal(reopened.to_state, "apply");
    assert.equal(rebuildSnapshot(reviewFx.projectRoot, reviewFx.change, reviewFx.changeRoot).open_jobs.some(job => job.job_id === verifier.created_jobs[0]), false);
    assert.equal(readEvents(reviewFx.projectRoot, reviewFx.change).some(event =>
      event.event_type === "job_invalidated" &&
      (event.payload as { job_id?: unknown }).job_id === verifier.created_jobs[0]
    ), true);
  } finally { reviewFx.cleanup(); }

  const acceptedFx = setupApplyWithDoneTask();
  try {
    advanceApplyToReview(acceptedFx.projectRoot, acceptedFx.change, acceptedFx.changeRoot, "minimal");
    acceptAfterFinalVerifier(acceptedFx.projectRoot, acceptedFx.change, acceptedFx.changeRoot, "minimal");
    assert.equal(rebuildSnapshot(acceptedFx.projectRoot, acceptedFx.change, acceptedFx.changeRoot).state, "accepted");

    const reopened = reopen(acceptedFx.projectRoot, acceptedFx.change, acceptedFx.changeRoot, "apply", "交付后自测仍发现空输入失败", {
      selfTestFix: "TASK-001",
    });
    assert.equal(reopened.from_state, "accepted");
    assert.equal(reopened.to_state, "apply");
  } finally { acceptedFx.cleanup(); }
});

test("code-reviewer：reopen 只能引用当前最新代码审查失败里的阻塞问题", () => {
  const fx = setupApplyWithDoneTask();
  try {
    reviewReady(fx.projectRoot, fx.change, fx.changeRoot);
    const first = reviewReady(fx.projectRoot, fx.change, fx.changeRoot);
    assert.equal(first.outcome, "job_created");
    const oldJobId = first.created_jobs[0];
    submitCodeReviewerReport(
      fx.projectRoot,
      fx.change,
      fx.changeRoot,
      oldJobId,
      codeReviewerReport(fx.projectRoot, fx.change, oldJobId, "fail", [{
        id: "CR-OLD-IMPL",
        type: "implementation",
        blocking: true,
        description: "旧实现问题",
        evidence: "src/old.ts:1",
        source_refs: ["src/old.ts:1"],
        impact: "旧问题影响",
        suggested_action: "apply",
      }]),
    );

    const latestJob = appendOpenJob(fx.projectRoot, fx.change, "apply_done", {
      job_id: "JOB-latest-code-review",
      role: "code-reviewer",
      created_from_transition: "review-ready",
    });
    submitCodeReviewerReport(
      fx.projectRoot,
      fx.change,
      fx.changeRoot,
      latestJob.job_id,
      codeReviewerReport(fx.projectRoot, fx.change, latestJob.job_id, "fail", [{
        id: "CR-LATEST-SPEC",
        type: "spec",
        blocking: true,
        description: "当前文档问题",
        evidence: "design.md 与 tasks.md 不一致",
        source_refs: ["design.md", "tasks.md"],
        impact: "当前问题需要用户判断",
        suggested_action: "propose",
      }]),
    );

    const oldReopen = reopen(fx.projectRoot, fx.change, fx.changeRoot, "apply", "不能用旧问题回 apply", {
      reviewFix: `${oldJobId}#CR-OLD-IMPL`,
    });
    assert.equal(oldReopen.events_written, 0);
    assert.match(oldReopen.message, /找不到有效的代码审查问题/);

    const ask = next(fx.projectRoot, fx.change, fx.changeRoot);
    assert.equal(ask.path, "ask_user");
    assert.equal(ask.ask_user.scope, "code_review_decision:JOB-latest-code-review#CR-LATEST-SPEC");
  } finally { fx.cleanup(); }
});

test("code-reviewer：同 id 非阻塞项不能覆盖真正阻塞 finding", () => {
  const fx = setupApplyWithDoneTask();
  try {
    reviewReady(fx.projectRoot, fx.change, fx.changeRoot);
    const created = reviewReady(fx.projectRoot, fx.change, fx.changeRoot);
    assert.equal(created.outcome, "job_created");
    const jobId = created.created_jobs[0];
    submitCodeReviewerReport(
      fx.projectRoot,
      fx.change,
      fx.changeRoot,
      jobId,
      codeReviewerReport(fx.projectRoot, fx.change, jobId, "fail", [
        {
          id: "CR-SAME-ID",
          type: "spec",
          blocking: false,
          description: "非阻塞提示不应驱动 reopen",
        },
        {
          id: "CR-SAME-ID",
          type: "implementation",
          blocking: true,
          description: "真正阻塞的实现问题",
          evidence: "src/example.ts:1",
          source_refs: ["src/example.ts:1"],
          impact: "运行时失败",
          suggested_action: "apply",
        },
      ]),
    );

    const reopened = reopen(fx.projectRoot, fx.change, fx.changeRoot, "apply", "修复真正阻塞问题", {
      reviewFix: `${jobId}#CR-SAME-ID`,
    });
    assert.equal(reopened.to_state, "apply");
    const tasks = readFileSync(join(fx.changeRoot, "tasks.md"), "utf8");
    assert.match(tasks, /兑现 D（breaks_existing）/);
    assert.doesNotMatch(tasks, /真正阻塞的实现问题/);
    assert.doesNotMatch(tasks, /非阻塞提示不应驱动 reopen/);
  } finally { fx.cleanup(); }
});

test("code-reviewer：spec 问题必须经用户决策才能 reopen propose", () => {
  const fx = setupApplyWithDoneTask();
  try {
    reviewReady(fx.projectRoot, fx.change, fx.changeRoot);
    const created = reviewReady(fx.projectRoot, fx.change, fx.changeRoot);
    assert.equal(created.outcome, "job_created");
    const jobId = created.created_jobs[0];
    const finding = {
      id: "CR-SPEC-001",
      type: "spec",
      blocking: true,
      description: "tasks 未覆盖设计里声明的降级路径",
      evidence: "design.md 提到降级路径，tasks.md 未安排实现",
      source_refs: ["design.md", "tasks.md"],
      impact: "按当前 task 实现会遗漏需求",
      suggested_action: "propose",
    };
    submitCodeReviewerReport(
      fx.projectRoot,
      fx.change,
      fx.changeRoot,
      jobId,
      codeReviewerReport(fx.projectRoot, fx.change, jobId, "fail", [finding]),
    );

    const ask = next(fx.projectRoot, fx.change, fx.changeRoot);
    assert.equal(ask.path, "ask_user");
    assert.equal(ask.ask_user.scope, `code_review_decision:${jobId}#CR-SPEC-001`);
    assert.deepEqual(ask.ask_user.allowed_answers, ["回到计划阶段", "回到实现阶段", "驳回该问题"]);

    const blocked = reopen(fx.projectRoot, fx.change, fx.changeRoot, "propose", "补充降级路径设计", {
      reviewFinding: `${jobId}#CR-SPEC-001`,
    });
    assert.equal(blocked.events_written, 0);
    assert.match(blocked.message, /缺少使用者确认/);

    const decision = recordUserDecisionContent(fx.projectRoot, fx.change, JSON.stringify({
      scope: `code_review_decision:${jobId}#CR-SPEC-001`,
      question: ask.ask_user.question,
      answer: "回到计划阶段",
      reason: "设计文档需要补充降级路径",
    }));
    assert.equal(decision.accepted, true);
    const decisionEvent = readEvents(fx.projectRoot, fx.change).findLast(event => event.event_type === "user_decision_recorded");
    const decisionRef = (decisionEvent?.payload as {
      code_review_decision?: { job_id?: unknown; finding_id?: unknown; rejection_event_id?: unknown; packet_digest?: unknown };
    }).code_review_decision;
    assert.equal(decisionRef?.job_id, jobId);
    assert.equal(decisionRef?.finding_id, "CR-SPEC-001");
    assert.equal(typeof decisionRef?.rejection_event_id, "string");
    assert.equal(typeof decisionRef?.packet_digest, "string");

    const reopened = reopen(fx.projectRoot, fx.change, fx.changeRoot, "propose", "补充降级路径设计", {
      reviewFinding: `${jobId}#CR-SPEC-001`,
    });
    assert.equal(reopened.to_state, "propose");
    const commit = readEvents(fx.projectRoot, fx.change).findLast(e =>
      e.event_type === "transition_commit" &&
      (e.payload as { transition?: unknown; reopen_target?: unknown }).transition === "reopen" &&
      (e.payload as { transition?: unknown; reopen_target?: unknown }).reopen_target === "propose"
    );
    assert.equal((commit?.payload as { source_job_id?: unknown }).source_job_id, jobId);
    assert.equal((commit?.payload as { finding_id?: unknown }).finding_id, "CR-SPEC-001");
    assert.equal(typeof (commit?.payload as { baseline_docs?: unknown }).baseline_docs, "object");
    assert.deepEqual((commit?.payload as { planning_validation_profile?: unknown }).planning_validation_profile, {
      version: 2,
      openspec: { mode: "disabled" },
      design: { schema_version: 1 },
    });

    writeFileSync(join(fx.changeRoot, "tasks.md"), [
      "# Tasks",
      "",
      "- [ ] TASK-001 First replacement plan",
      "- [ ] TASK-001 Duplicate replacement plan",
    ].join("\n"));
    const invalidPlan = proposeReady(fx.projectRoot, fx.change, fx.changeRoot, "minimal");
    assert.match(invalidPlan.message, /task ID 重复/);
  } finally { fx.cleanup(); }
});

test("code-reviewer：mixed 问题可经用户决策回 apply 修实现", () => {
  const fx = setupApplyWithDoneTask();
  try {
    reviewReady(fx.projectRoot, fx.change, fx.changeRoot);
    const created = reviewReady(fx.projectRoot, fx.change, fx.changeRoot);
    assert.equal(created.outcome, "job_created");
    const jobId = created.created_jobs[0];
    const finding = {
      id: "CR-MIX-001",
      type: "mixed",
      blocking: true,
      description: "实现与任务描述存在边界偏差，但用户确认不改文档",
      evidence: "tasks.md 要求兼容旧输入，src/example.ts 未处理",
      source_refs: ["tasks.md#TASK-001", "src/example.ts"],
      impact: "旧输入场景会失败",
      suggested_action: "apply",
    };
    submitCodeReviewerReport(
      fx.projectRoot,
      fx.change,
      fx.changeRoot,
      jobId,
      codeReviewerReport(fx.projectRoot, fx.change, jobId, "fail", [finding]),
    );

    const ask = next(fx.projectRoot, fx.change, fx.changeRoot);
    assert.equal(ask.path, "ask_user");
    assert.equal(ask.ask_user.scope, `code_review_decision:${jobId}#CR-MIX-001`);

    const blocked = reopen(fx.projectRoot, fx.change, fx.changeRoot, "apply", "用户确认文档不改，回 apply 修实现", {
      reviewFix: `${jobId}#CR-MIX-001`,
    });
    assert.equal(blocked.events_written, 0);
    assert.match(blocked.message, /缺少使用者确认/);

    const decision = recordUserDecisionContent(fx.projectRoot, fx.change, JSON.stringify({
      scope: `code_review_decision:${jobId}#CR-MIX-001`,
      question: ask.ask_user.question,
      answer: "回到实现阶段",
      reason: "文档方向不变，只修实现偏差",
    }));
    assert.equal(decision.accepted, true);

    const nextAfterDecision = next(fx.projectRoot, fx.change, fx.changeRoot);
    assert.equal(nextAfterDecision.path, "next_command");
    assert.equal(
      nextAfterDecision.next_command,
      `superspec transition reopen --change "${fx.change}" --to apply --review-fix ${jobId}#CR-MIX-001 --reason "根据代码审查问题 CR-MIX-001 回到实现阶段修复"`,
    );

    const reopened = reopen(fx.projectRoot, fx.change, fx.changeRoot, "apply", "用户确认文档不改，回 apply 修实现", {
      reviewFix: `${jobId}#CR-MIX-001`,
    });
    assert.equal(reopened.to_state, "apply");
    const tasks = readFileSync(join(fx.changeRoot, "tasks.md"), "utf8");
    assert.match(tasks, new RegExp(`REVIEW-FIX-${jobId}#CR-MIX-001`));
    assert.match(tasks, new RegExp(`review_fix_of:${jobId}#CR-MIX-001`));
  } finally { fx.cleanup(); }
});

test("record user-decision：代码审查决策必须写明原因，且不能伪造未出现的 finding", () => {
  const fx = setupApplyWithDoneTask();
  try {
    const missingReason = JSON.stringify({
      scope: "code_review_decision:JOB-test#CR-001",
      answer: "驳回该问题",
    });
    const before = readEvents(fx.projectRoot, fx.change).length;
    const rejected = recordUserDecisionContent(fx.projectRoot, fx.change, missingReason);
    assert.equal(rejected.accepted, false);
    assert.match(rejected.message, /写明原因/);
    const afterFirst = readEvents(fx.projectRoot, fx.change);
    assert.equal(afterFirst.length, before + 1);
    const event = afterFirst.at(-1);
    assert.equal(event?.event_type, "user_decision_recorded");
    assert.equal((event?.payload as { accepted?: unknown }).accepted, false);
    assert.equal(typeof (event?.payload as { input_digest?: unknown }).input_digest, "string");

    const repeated = recordUserDecisionContent(fx.projectRoot, fx.change, missingReason);
    assert.equal(repeated.accepted, false);
    assert.match(repeated.message, /幂等/);
    assert.equal(readEvents(fx.projectRoot, fx.change).length, afterFirst.length);

    const invalidAnswer = recordUserDecisionContent(fx.projectRoot, fx.change, JSON.stringify({
      scope: "code_review_decision:JOB-test#CR-001",
      answer: "ignore",
      reason: "这不是合法选择",
    }));
    assert.equal(invalidAnswer.accepted, false);
    assert.match(invalidAnswer.message, /回到计划阶段、回到实现阶段 或 驳回该问题/);

    const forged = recordUserDecisionContent(fx.projectRoot, fx.change, JSON.stringify({
      scope: "code_review_decision:JOB-test#CR-001",
      answer: "驳回该问题",
      reason: "该问题不是本次阻塞项",
    }));
    assert.equal(forged.accepted, false);
    assert.match(forged.message, /当前代码审查报告中的待决定问题/);
    const rejectedEvent = readEvents(fx.projectRoot, fx.change).at(-1);
    assert.equal((rejectedEvent?.payload as { accepted?: unknown }).accepted, false);
  } finally { fx.cleanup(); }
});

test("code-reviewer：驳回问题不允许使用旧回退决策，最后有效决策生效", () => {
  const fx = setupApplyWithDoneTask();
  try {
    reviewReady(fx.projectRoot, fx.change, fx.changeRoot);
    const created = reviewReady(fx.projectRoot, fx.change, fx.changeRoot);
    assert.equal(created.outcome, "job_created");
    const jobId = created.created_jobs[0];
    const finding = {
      id: "CR-LATEST-001",
      type: "mixed",
      blocking: true,
      description: "实现与文档边界需要判断",
      evidence: "tasks.md 与 src/example.ts 边界不一致",
      source_refs: ["tasks.md", "src/example.ts"],
      impact: "可能遗漏兼容场景",
      suggested_action: "apply",
    };
    submitCodeReviewerReport(
      fx.projectRoot,
      fx.change,
      fx.changeRoot,
      jobId,
      codeReviewerReport(fx.projectRoot, fx.change, jobId, "fail", [finding]),
    );

    const scope = `code_review_decision:${jobId}#CR-LATEST-001`;
    assert.equal(recordUserDecisionContent(fx.projectRoot, fx.change, JSON.stringify({
      scope,
      answer: "回到实现阶段",
      reason: "先确认直接修实现",
    })).accepted, true);

    assert.equal(recordUserDecisionContent(fx.projectRoot, fx.change, JSON.stringify({
      scope,
      answer: "驳回该问题",
      reason: "复核后认为已有证据覆盖",
    })).accepted, true);

    const blocked = reopen(fx.projectRoot, fx.change, fx.changeRoot, "apply", "尝试使用旧决策", {
      reviewFix: `${jobId}#CR-LATEST-001`,
    });
    assert.equal(blocked.events_written, 0);
    assert.match(blocked.message, /缺少使用者确认/);

    assert.equal(recordUserDecisionContent(fx.projectRoot, fx.change, JSON.stringify({
      scope,
      answer: "回到实现阶段",
      reason: "重新确认仍需直接修实现",
    })).accepted, true);

    const reopened = reopen(fx.projectRoot, fx.change, fx.changeRoot, "apply", "根据最新决策修实现", {
      reviewFix: `${jobId}#CR-LATEST-001`,
    });
    assert.equal(reopened.to_state, "apply");
  } finally { fx.cleanup(); }
});

test("code-reviewer：raw-only 用户决策不会驱动 reopen", () => {
  const fx = setupApplyWithDoneTask();
  try {
    reviewReady(fx.projectRoot, fx.change, fx.changeRoot);
    const created = reviewReady(fx.projectRoot, fx.change, fx.changeRoot);
    assert.equal(created.outcome, "job_created");
    const jobId = created.created_jobs[0];
    submitCodeReviewerReport(
      fx.projectRoot,
      fx.change,
      fx.changeRoot,
      jobId,
      codeReviewerReport(fx.projectRoot, fx.change, jobId, "fail", [{
        id: "CR-RAW-ONLY",
        type: "spec",
        blocking: true,
        description: "需要用户确认的文档问题",
        evidence: "design.md 与 tasks.md 不一致",
        source_refs: ["design.md", "tasks.md"],
        impact: "可能影响实现方向",
        suggested_action: "propose",
      }]),
    );

    writeFileSync(rawFile(fx.projectRoot, fx.change, "user-decisions"), JSON.stringify({
      scope: `code_review_decision:${jobId}#CR-RAW-ONLY`,
      answer: "回到计划阶段",
      reason: "raw-only 不应生效",
    }) + "\n");

    const blocked = reopen(fx.projectRoot, fx.change, fx.changeRoot, "propose", "尝试使用 raw-only 决策", {
      reviewFinding: `${jobId}#CR-RAW-ONLY`,
    });
    assert.equal(blocked.events_written, 0);
    assert.match(blocked.message, /缺少使用者确认/);
  } finally { fx.cleanup(); }
});

test("code-reviewer：未接受的决策不会覆盖之前有效决策", () => {
  const fx = setupApplyWithDoneTask();
  try {
    reviewReady(fx.projectRoot, fx.change, fx.changeRoot);
    const created = reviewReady(fx.projectRoot, fx.change, fx.changeRoot);
    assert.equal(created.outcome, "job_created");
    const jobId = created.created_jobs[0];
    submitCodeReviewerReport(
      fx.projectRoot,
      fx.change,
      fx.changeRoot,
      jobId,
      codeReviewerReport(fx.projectRoot, fx.change, jobId, "fail", [{
        id: "CR-INVALID-LATEST",
        type: "mixed",
        blocking: true,
        description: "需要确认是否直接修实现",
        evidence: "tasks.md 与 src/example.ts 不一致",
        source_refs: ["tasks.md", "src/example.ts"],
        impact: "可能遗漏兼容场景",
        suggested_action: "apply",
      }]),
    );

    const scope = `code_review_decision:${jobId}#CR-INVALID-LATEST`;
    assert.equal(recordUserDecisionContent(fx.projectRoot, fx.change, JSON.stringify({
      scope,
      answer: "回到实现阶段",
      reason: "确认直接修实现",
    })).accepted, true);
    assert.equal(recordUserDecisionContent(fx.projectRoot, fx.change, JSON.stringify({
      scope,
      answer: "驳回该问题",
    })).accepted, false);

    const reopened = reopen(fx.projectRoot, fx.change, fx.changeRoot, "apply", "无效决策不覆盖有效决策", {
      reviewFix: `${jobId}#CR-INVALID-LATEST`,
    });
    assert.equal(reopened.to_state, "apply");
  } finally { fx.cleanup(); }
});

test("code-reviewer：驳回第一个问题后 next 继续处理下一个阻塞问题", () => {
  const fx = setupApplyWithDoneTask();
  try {
    reviewReady(fx.projectRoot, fx.change, fx.changeRoot);
    const created = reviewReady(fx.projectRoot, fx.change, fx.changeRoot);
    assert.equal(created.outcome, "job_created");
    const jobId = created.created_jobs[0];
    const findings = [
      {
        id: "CR-SPEC-FIRST",
        type: "spec",
        blocking: true,
        description: "设计文档需要确认",
        evidence: "design.md 与 tasks.md 不一致",
        source_refs: ["design.md", "tasks.md"],
        impact: "可能影响实现方向",
        suggested_action: "propose",
      },
      {
        id: "CR-IMPL-SECOND",
        type: "implementation",
        blocking: true,
        description: "实现缺少空输入处理",
        evidence: "src/example.ts 没有空输入分支",
        source_refs: ["src/example.ts"],
        impact: "空输入会失败",
        suggested_action: "apply",
      },
    ];
    submitCodeReviewerReport(
      fx.projectRoot,
      fx.change,
      fx.changeRoot,
      jobId,
      codeReviewerReport(fx.projectRoot, fx.change, jobId, "fail", findings),
    );

    const ask = next(fx.projectRoot, fx.change, fx.changeRoot);
    assert.equal(ask.path, "ask_user");
    assert.equal(ask.ask_user.scope, `code_review_decision:${jobId}#CR-SPEC-FIRST`);
    assert.equal(recordUserDecisionContent(fx.projectRoot, fx.change, JSON.stringify({
      scope: `code_review_decision:${jobId}#CR-SPEC-FIRST`,
      answer: "驳回该问题",
      reason: "该文档分歧已有用户确认记录覆盖",
    })).accepted, true);

    const nextResult = next(fx.projectRoot, fx.change, fx.changeRoot);
    assert.equal(nextResult.path, "next_command");
    assert.match(nextResult.next_command, new RegExp(`--review-fix ${jobId}#CR-IMPL-SECOND`));
  } finally { fx.cleanup(); }
});

test("code-reviewer：所有阻塞问题被驳回后重新创建代码审查工作项", () => {
  const fx = setupApplyWithDoneTask();
  try {
    reviewReady(fx.projectRoot, fx.change, fx.changeRoot);
    const created = reviewReady(fx.projectRoot, fx.change, fx.changeRoot);
    assert.equal(created.outcome, "job_created");
    const jobId = created.created_jobs[0];
    const findings = [
      {
        id: "CR-DISMISS-001",
        type: "spec",
        blocking: true,
        description: "文档问题被复核驳回",
        evidence: "design.md:1",
        source_refs: ["design.md:1"],
        impact: "可能影响计划",
        suggested_action: "propose",
      },
      {
        id: "CR-DISMISS-002",
        type: "mixed",
        blocking: true,
        description: "混合问题被复核驳回",
        evidence: "tasks.md:1",
        source_refs: ["tasks.md:1"],
        impact: "可能影响实现",
        suggested_action: "apply",
      },
    ];
    submitCodeReviewerReport(
      fx.projectRoot,
      fx.change,
      fx.changeRoot,
      jobId,
      codeReviewerReport(fx.projectRoot, fx.change, jobId, "fail", findings),
    );

    for (const finding of findings) {
      assert.equal(recordUserDecisionContent(fx.projectRoot, fx.change, JSON.stringify({
        scope: `code_review_decision:${jobId}#${finding.id}`,
        answer: "驳回该问题",
        reason: `${finding.id} 已由主流程复核驳回`,
      })).accepted, true);
    }

    const nextResult = next(fx.projectRoot, fx.change, fx.changeRoot);
    assert.equal(nextResult.path, "next_command");
    assert.match(nextResult.next_command, /review-ready/);

    const retry = reviewReady(fx.projectRoot, fx.change, fx.changeRoot);
    assert.equal(retry.outcome, "job_created");
    assert.notEqual(retry.created_jobs[0], jobId);
    const packet = jobsPacket(fx.projectRoot, fx.change, retry.created_jobs[0]);
    assert.equal((packet.packet?.previous_rejection as { result_kind?: unknown })?.result_kind, "review_failed");
    const reason = String((packet.packet?.previous_rejection as { reason?: unknown })?.reason);
    assert.match(reason, /CR-DISMISS-001/);
    assert.match(reason, /CR-DISMISS-002/);
    assert.match(reason, /没有新的具体证据/);
  } finally { fx.cleanup(); }
});

test("next：review 有 pending task 时优先 reopen，再处理 verifier job", () => {
  const fx = setupApplyWithDoneTask();
  try {
    advanceApplyToReview(fx.projectRoot, fx.change, fx.changeRoot, "minimal");
    writeFileSync(join(fx.changeRoot, "tasks.md"), "# Tasks\n\n- [x] TASK-001 Done\n- [ ] TASK-025 Review followup\n");
    const job = appendOpenJob(fx.projectRoot, fx.change, "review", {
      job_id: "JOB-review-verifier",
      role: "verifier",
      created_from_transition: "review-ready",
      review_evidence_digest: reviewEvidenceDigest(readEvents(fx.projectRoot, fx.change)),
    });

    const result = next(fx.projectRoot, fx.change, fx.changeRoot);
    assert.equal(result.path, "next_command");
    assert.match(result.next_command, /transition reopen/);

    writeFileSync(join(fx.changeRoot, "tasks.md"), "# Tasks\n\n- [x] TASK-001 Done\n- [x] TASK-025 Review followup\n");

    const afterCompleted = next(fx.projectRoot, fx.change, fx.changeRoot);
    assert.equal(afterCompleted.path, "required_job");
    assert.equal(afterCompleted.required_jobs[0].job_id, job.job_id);
  } finally { fx.cleanup(); }
});

test("next：review 非阶段 open job 不抢占 pending task reopen", () => {
  const fx = setupApplyWithDoneTask();
  try {
    advanceApplyToReview(fx.projectRoot, fx.change, fx.changeRoot, "minimal");
    writeFileSync(join(fx.changeRoot, "tasks.md"), "# Tasks\n\n- [x] TASK-001 Done\n- [ ] TASK-025 Review followup\n");
    appendOpenJob(fx.projectRoot, fx.change, "review", {
      job_id: "JOB-review-executor",
      role: "executor",
      created_from_transition: "apply",
    });

    const result = next(fx.projectRoot, fx.change, fx.changeRoot);
    assert.equal(result.path, "next_command");
    assert.match(result.next_command, /reopen/);
  } finally { fx.cleanup(); }
});

test("next：accepted 和 legacy archive 有 open job 时不走普通完成路径", () => {
  const acceptedFx = setupApplyWithDoneTask();
  try {
    advanceApplyToReview(acceptedFx.projectRoot, acceptedFx.change, acceptedFx.changeRoot, "minimal");
    acceptAfterFinalVerifier(acceptedFx.projectRoot, acceptedFx.change, acceptedFx.changeRoot, "minimal");
    const job = appendOpenJob(acceptedFx.projectRoot, acceptedFx.change, "accepted", {
      job_id: "JOB-accepted-open",
      role: "executor",
      created_from_transition: "apply",
    });

    const result = next(acceptedFx.projectRoot, acceptedFx.change, acceptedFx.changeRoot);
    assert.equal(result.path, "required_job");
    assert.equal(result.required_jobs[0].job_id, job.job_id);
  } finally { acceptedFx.cleanup(); }

  const archiveFx = setupApplyWithDoneTask();
  try {
    advanceApplyToReview(archiveFx.projectRoot, archiveFx.change, archiveFx.changeRoot, "minimal");
    acceptAfterFinalVerifier(archiveFx.projectRoot, archiveFx.change, archiveFx.changeRoot, "minimal");
    appendEvent(archiveFx.projectRoot, archiveFx.change, makeEvent(archiveFx.change, "transition_commit", {
      transition: "archive",
      from_state: "accepted",
      to_state: "archive",
      outcome: "advanced",
      created_job_ids: [],
      reason: "legacy archive fixture",
    }, { transitionId: "T-legacy-archive-open", idempotencyKey: "legacy-archive-open-key" }));
    const job = appendOpenJob(archiveFx.projectRoot, archiveFx.change, "archive", {
      job_id: "JOB-archive-open",
      role: "executor",
      created_from_transition: "apply",
    });

    const result = next(archiveFx.projectRoot, archiveFx.change, archiveFx.changeRoot);
    assert.equal(result.path, "required_job");
    assert.equal(result.required_jobs[0].job_id, job.job_id);
  } finally { archiveFx.cleanup(); }
});

test("apply_done：确认后新增普通 open job 时 next 与 direct review-ready 都阻断", () => {
  const fx = setupApplyWithDoneTask();
  try {
    assert.equal(reviewReady(fx.projectRoot, fx.change, fx.changeRoot, "minimal").to_state, "apply_done");
    const codeReview = reviewReady(fx.projectRoot, fx.change, fx.changeRoot, "minimal");
    assert.equal(codeReview.outcome, "job_created");
    assert.equal(submitCodeReviewerPass(
      fx.projectRoot,
      fx.change,
      fx.changeRoot,
      codeReview.created_jobs[0],
    ).accepted, true);
    confirmCurrentPhase(fx.projectRoot, fx.change, fx.changeRoot, "minimal");
    const job = appendOpenJob(fx.projectRoot, fx.change, "apply_done", {
      job_id: "JOB-apply-done-open",
      role: "executor",
      created_from_transition: "apply",
    });

    const planned = next(fx.projectRoot, fx.change, fx.changeRoot, "minimal");
    assert.equal(planned.path, "required_job");
    assert.equal(planned.required_jobs[0].job_id, job.job_id);
    const direct = reviewReady(fx.projectRoot, fx.change, fx.changeRoot, "minimal");
    assert.equal(direct.outcome, "blocked");
    assert.equal(direct.events_written, 0);
    assert.equal(direct.to_state, "apply_done");
  } finally { fx.cleanup(); }
});

test("accepted：存在 open job 时 next 与 reopen --to propose 都阻断", () => {
  const fx = setupApplyWithDoneTask();
  try {
    advanceApplyToReview(fx.projectRoot, fx.change, fx.changeRoot, "minimal");
    acceptAfterFinalVerifier(fx.projectRoot, fx.change, fx.changeRoot, "minimal");
    const job = appendOpenJob(fx.projectRoot, fx.change, "accepted", {
      job_id: "JOB-accepted-before-reopen",
      role: "executor",
      created_from_transition: "apply",
    });

    const planned = next(fx.projectRoot, fx.change, fx.changeRoot, "minimal");
    assert.equal(planned.path, "required_job");
    assert.equal(planned.required_jobs[0].job_id, job.job_id);
    const direct = reopen(fx.projectRoot, fx.change, fx.changeRoot, "propose", "补充新的验收要求");
    assert.equal(direct.outcome, "blocked");
    assert.equal(direct.events_written, 0);
    assert.equal(direct.to_state, "accepted");
  } finally { fx.cleanup(); }
});

test("next：accepted 无 open job 时直接完成，不再返回归档确认或命令", () => {
  const fx = setupApplyWithDoneTask();
  try {
    advanceApplyToReview(fx.projectRoot, fx.change, fx.changeRoot, "minimal");
    acceptAfterFinalVerifier(fx.projectRoot, fx.change, fx.changeRoot, "minimal");

    const result = next(fx.projectRoot, fx.change, fx.changeRoot);
    assert.equal(result.path, "done");
    assert.equal(result.state, "accepted");
    assert.match(result.reason, /流程完成/);
    assert.match(result.reason, /按 continuation 自动回到 propose/);
    assert.match(result.reason, /不得要求使用者执行工作流命令/);
    assert.doesNotMatch(result.reason, /superspec transition reopen|请显式执行/);
    assert.equal("ask_user" in result, false);
    assert.equal("next_command" in result, false);
    assert.deepEqual(result.continuation, {
      kind: "accepted_material_followup",
      trigger: "material_user_followup",
      reason_source: "summarize_user_input",
      reopen_argv_template: [
        "superspec", "transition", "reopen", "--change", fx.change,
        "--to", "propose", "--reason", "{{reason}}",
      ],
      resume: {
        kind: "continue_current_phase",
        instruction: "根据用户补充更新 proposal/specs/design/tasks/test-contract；完成后重新执行 next。",
        next_argv_after_completion: ["superspec", "transition", "next", "--change", fx.change],
      },
      plan_docs_changed_since_accept: false,
    });

    const normal = next(fx.projectRoot, fx.change, fx.changeRoot, "normal");
    assert.equal(normal.path, "done");
    assert.deepEqual(normal.continuation?.resume.next_argv_after_completion, [
      "superspec", "transition", "next", "--change", fx.change,
    ]);
  } finally { fx.cleanup(); }
});

test("next：abandoned 是终态，即使存在 open job 也不继续驱动", () => {
  const fx = setupApplyWithDoneTask();
  try {
    appendEvent(fx.projectRoot, fx.change, makeEvent(fx.change, "transition_commit", {
      transition: "abandon",
      from_state: "apply",
      to_state: "abandoned",
      outcome: "advanced",
      created_job_ids: [],
      reason: "simulate abandoned state",
    }, { transitionId: "T-abandoned", idempotencyKey: "abandoned-key" }));
    appendOpenJob(fx.projectRoot, fx.change, "abandoned", {
      job_id: "JOB-abandoned-open",
      role: "executor",
      created_from_transition: "apply",
    });

    const result = next(fx.projectRoot, fx.change, fx.changeRoot);
    assert.equal(result.path, "done");
    assert.equal(result.state, "abandoned");
    assert.match(result.reason, /放弃/);
  } finally { fx.cleanup(); }
});

test("review-ready：忽略非 review-ready 来源的 verifier job", () => {
  const fx = setupApplyWithDoneTask();
  try {
    advanceApplyToReview(fx.projectRoot, fx.change, fx.changeRoot);

    const unrelatedJob = {
      job_id: "JOB-unrelated-verifier",
      role: "verifier",
      state: "requested",
      boundFiles: [],
      packet_digest: "sha256:unrelated",
      created_from_transition: "apply-verify",
      created_at: new Date().toISOString(),
    };
    appendEvent(fx.projectRoot, fx.change, makeEvent(fx.change, "transition_commit", {
      transition: "apply-verify",
      from_state: "review",
      to_state: "review",
      outcome: "job_created",
      created_job_ids: [unrelatedJob.job_id],
      new_jobs: [unrelatedJob],
      reason: "unrelated verifier",
    }, { transitionId: "T-unrelated-verifier", idempotencyKey: "unrelated-verifier-key" }));
    appendEvent(fx.projectRoot, fx.change, makeEvent(fx.change, "job_accepted", {
      job_id: unrelatedJob.job_id,
      role: "verifier",
      report_digest: "sha256:unrelated-report",
      accepted_at: new Date().toISOString(),
    }));

    const result = reviewReady(fx.projectRoot, fx.change, fx.changeRoot);
    assert.equal(result.outcome, "job_created");
    const snap = rebuildSnapshot(fx.projectRoot, fx.change, fx.changeRoot);
    const created = snap.open_jobs.find(job => job.job_id === result.created_jobs[0]);
    assert.equal(created?.role, "verifier");
    assert.equal(created?.created_from_transition, "review-ready");
  } finally { fx.cleanup(); }
});

test("review-ready：缺执行证据版本的 legacy verifier 不算最终验证", () => {
  const fx = setupApplyWithDoneTask();
  try {
    advanceApplyToReview(fx.projectRoot, fx.change, fx.changeRoot, "normal");

    const legacyJob = appendOpenJob(fx.projectRoot, fx.change, "review", {
      job_id: "JOB-legacy-verifier-no-evidence",
      role: "verifier",
      created_from_transition: "review-ready",
    });

    const result = reviewReady(fx.projectRoot, fx.change, fx.changeRoot, "normal");
    assert.equal(result.outcome, "job_created");
    assert.notEqual(result.created_jobs[0], legacyJob.job_id);

    const snap = rebuildSnapshot(fx.projectRoot, fx.change, fx.changeRoot);
    const created = snap.open_jobs.find(job => job.job_id === result.created_jobs[0]);
    assert.equal(created?.gate_id, "review.final_verifier");
    assert.equal(typeof created?.review_evidence_digest, "string");
    assert.equal(snap.open_jobs.some(job => job.job_id === legacyJob.job_id), false);

    const reportPath = join(fx.projectRoot, "legacy-verifier-no-evidence.json");
    writeFileSync(reportPath, JSON.stringify({ role: "verifier", findings: [], verdict: "pass" }));
    const submitted = recordJobSubmit(fx.projectRoot, fx.change, fx.changeRoot, legacyJob.job_id, reportPath);
    assert.equal(submitted.accepted, false);
    assert.match(submitted.message, /缺少执行证据版本/);
  } finally { fx.cleanup(); }
});

test("review-ready：verifier rejected 后创建新 job 带处理提示", () => {
  const fx = setupApplyWithDoneTask();
  try {
    advanceApplyToReview(fx.projectRoot, fx.change, fx.changeRoot, "normal");
    const created = reviewReady(fx.projectRoot, fx.change, fx.changeRoot, "normal");
    assert.equal(created.outcome, "job_created");

    const reportPath = join(fx.projectRoot, "verifier-fail.json");
    writeFileSync(reportPath, JSON.stringify({
      role: "verifier",
      findings: [{ severity: "high", message: "missing verification" }],
      verdict: "fail",
      review_scope: { checked_paths: checkedPathsForJob(fx.projectRoot, fx.change, created.created_jobs[0]) },
      reviewer: { kind: "codex-subagent", id: "test-verifier" },
    }));
    const rejected = recordJobSubmit(fx.projectRoot, fx.change, fx.changeRoot, created.created_jobs[0], reportPath);
    assert.equal(rejected.accepted, false);
    const rejectedEvent = readEvents(fx.projectRoot, fx.change).findLast(e => e.event_type === "job_rejected");
    assert.deepEqual((rejectedEvent?.payload as { findings?: unknown }).findings, [{ severity: "high", message: "missing verification" }]);
    assert.equal((rejectedEvent?.payload as { raw_kind?: unknown }).raw_kind, "review-reports");
    const rawLines = readFileSync(rawFile(fx.projectRoot, fx.change, "review-reports"), "utf8").trim().split("\n");
    assert.equal(JSON.parse(rawLines.at(-1) ?? "{}").verdict, "fail");

    const retry = reviewReady(fx.projectRoot, fx.change, fx.changeRoot, "normal");
    assert.equal(retry.outcome, "job_created");
    assert.match(String(retry.details?.advisory), /此前最终验证未通过/);
    const retryPacket = jobsPacket(fx.projectRoot, fx.change, retry.created_jobs[0]).packet;
    assert.deepEqual(retryPacket?.previous_rejection?.findings, [{ severity: "high", message: "missing verification" }]);
  } finally { fx.cleanup(); }
});

test("verifier：fail 必须给出至少一个 finding", () => {
  const fx = setupApplyWithDoneTask();
  try {
    advanceApplyToReview(fx.projectRoot, fx.change, fx.changeRoot, "normal");
    const created = reviewReady(fx.projectRoot, fx.change, fx.changeRoot, "normal");
    assert.equal(created.outcome, "job_created");
    const reportPath = join(fx.projectRoot, "verifier-empty-fail.json");
    writeFileSync(reportPath, JSON.stringify({
      role: "verifier",
      verdict: "fail",
      findings: [],
      review_scope: { checked_paths: checkedPathsForJob(fx.projectRoot, fx.change, created.created_jobs[0]) },
      reviewer: { kind: "codex-subagent", id: "test-verifier" },
    }));

    const rejected = recordJobSubmit(fx.projectRoot, fx.change, fx.changeRoot, created.created_jobs[0], reportPath);
    assert.equal(rejected.accepted, false);
    assert.match(rejected.message, /fail 时 findings 至少包含一个问题/);
  } finally { fx.cleanup(); }
});

test("jobs packet：角色输出契约和停止条件保持隔离", () => {
  const fx = setupApplyWithDoneTask();
  try {
    const boundFiles = [docRef(fx.changeRoot, "proposal.md")];
    const executor = appendOpenJob(fx.projectRoot, fx.change, "apply", {
      job_id: "JOB-executor-instructions",
      role: "executor",
      created_from_transition: "apply",
      boundFiles,
      review_targets: ["proposal.md"],
    });
    const testRun = appendOpenJob(fx.projectRoot, fx.change, "apply", {
      job_id: "JOB-test-run-instructions",
      role: "test-run",
      created_from_transition: "apply",
      boundFiles,
    });
    const proposalReviewer = appendOpenJob(fx.projectRoot, fx.change, "propose", {
      job_id: "JOB-proposal-reviewer-instructions",
      role: "critic",
      gate_id: "propose.final_review",
      created_from_transition: "propose-ready",
      boundFiles,
    });
    const codeReviewer = appendOpenJob(fx.projectRoot, fx.change, "apply_done", {
      job_id: "JOB-code-reviewer-instructions",
      role: "code-reviewer",
      gate_id: "review.code_review",
      created_from_transition: "review-ready",
      boundFiles,
    });

    const executorPacket = jobsPacket(fx.projectRoot, fx.change, executor.job_id).packet;
    const testRunPacket = jobsPacket(fx.projectRoot, fx.change, testRun.job_id).packet;
    const proposalPacket = jobsPacket(fx.projectRoot, fx.change, proposalReviewer.job_id).packet;
    const codeReviewPacket = jobsPacket(fx.projectRoot, fx.change, codeReviewer.job_id).packet;
    assert.ok(executorPacket && testRunPacket && proposalPacket && codeReviewPacket);
    assert.equal("review_targets" in executorPacket, false);
    assert.deepEqual(executorPacket.stop_conditions, ["完成绑定范围内的实现后提交执行报告，不要修改未绑定范围"]);
    assert.deepEqual(testRunPacket.stop_conditions, ["完成指定验证后提交测试报告，不要修改项目文档"]);
    assert.deepEqual(proposalPacket.output_contract_fields, ["role", "verdict", "findings", "reviewer", "review_scope"]);
    assert.deepEqual(codeReviewPacket.output_contract_fields, ["role", "verdict", "findings", "reviewer", "review_scope"]);
  } finally { fx.cleanup(); }
});

test("verifier：项目内 fallback 格式错误记录路径且不污染 fresh code_state_check", () => {
  const fx = setupApplyWithDoneTask();
  try {
    advanceApplyToReview(fx.projectRoot, fx.change, fx.changeRoot, "normal");
    const created = reviewReady(fx.projectRoot, fx.change, fx.changeRoot, "normal");
    assert.equal(created.outcome, "job_created");
    const jobId = created.created_jobs[0];
    assert.match(String(jobsPacket(fx.projectRoot, fx.change, jobId).packet?.output_instructions), /项目内 fallback 报告若存在解码或协议错误会终结当前工作项/);
    const reportPath = join(fx.projectRoot, "verifier-invalid.json");
    writeFileSync(reportPath, JSON.stringify({ role: "verifier", verdict: "pass", findings: [] }));

    const rejected = recordJobSubmit(fx.projectRoot, fx.change, fx.changeRoot, jobId, reportPath);
    assert.equal(rejected.job_state, "rejected");
    const rejectedEvent = readEvents(fx.projectRoot, fx.change).findLast(event =>
      event.event_type === "job_rejected" && event.payload.job_id === jobId
    );
    assert.equal((rejectedEvent?.payload as { report_path?: unknown }).report_path, "verifier-invalid.json");

    const retry = reviewReady(fx.projectRoot, fx.change, fx.changeRoot, "normal");
    assert.equal(retry.outcome, "job_created");
    const retryPacket = jobsPacket(fx.projectRoot, fx.change, retry.created_jobs[0]).packet;
    assert.equal(retryPacket?.packet_context?.code_state_check?.changed_paths.includes("verifier-invalid.json"), false);
    assert.equal(submitVerifierPass(fx.projectRoot, fx.change, fx.changeRoot, retry.created_jobs[0]).accepted, true);
  } finally { fx.cleanup(); }
});

test("accept：非 review-ready verifier 不能满足最终验证", () => {
  const fx = setupApplyWithDoneTask();
  try {
    reviewReady(fx.projectRoot, fx.change, fx.changeRoot, "normal");

    const unrelatedJob = {
      job_id: "JOB-unrelated-verifier",
      role: "verifier",
      state: "requested",
      boundFiles: [],
      packet_digest: "sha256:unrelated",
      created_from_transition: "apply-verify",
      created_at: new Date().toISOString(),
    };
    appendEvent(fx.projectRoot, fx.change, makeEvent(fx.change, "transition_commit", {
      transition: "apply-verify",
      from_state: "apply_done",
      to_state: "apply_done",
      outcome: "job_created",
      created_job_ids: [unrelatedJob.job_id],
      new_jobs: [unrelatedJob],
      reason: "unrelated verifier",
    }, { transitionId: "T-unrelated-verifier", idempotencyKey: "unrelated-verifier-key" }));
    appendEvent(fx.projectRoot, fx.change, makeEvent(fx.change, "job_accepted", {
      job_id: unrelatedJob.job_id,
      role: "verifier",
      report_digest: "sha256:unrelated-report",
      accepted_at: new Date().toISOString(),
    }));
    appendEvent(fx.projectRoot, fx.change, makeEvent(fx.change, "transition_commit", {
      transition: "manual-review",
      from_state: "apply_done",
      to_state: "review",
      outcome: "advanced",
      created_job_ids: [],
      reason: "simulate bad review advance",
    }, { transitionId: "T-manual-review", idempotencyKey: "manual-review-key" }));

    const blocked = accept(fx.projectRoot, fx.change, fx.changeRoot);
    assert.equal(blocked.events_written, 0);
    assert.match(blocked.message, /缺少仍然匹配当前证据的最终验证/);
  } finally { fx.cleanup(); }
});

test("accept：verifier accepted 后补登记匹配 digest 的 legacy test-run 会失效", () => {
  const fx = setupApplyWithDoneTask();
  try {
    writeFileSync(join(fx.changeRoot, "tasks.md"), "# Tasks\n\n- [ ] TASK-001 Implement\n");

    taskStart(fx.projectRoot, fx.change, fx.changeRoot, "TASK-001");
    const attempt = rebuildSnapshot(fx.projectRoot, fx.change, fx.changeRoot).active_task_attempts[0];
    assert.ok(attempt);

    appendTestRunEvent(fx.projectRoot, fx.change, {
      test_id: "TEST-RED",
      attempt_id: attempt.attempt_id,
      task_structure_digest: attempt.task_structure_digest,
      semantic_status: "expected_failure",
      exit_code: 1,
    });
    appendTestRunEvent(fx.projectRoot, fx.change, {
      test_id: "TEST-GREEN",
      attempt_id: attempt.attempt_id,
      task_structure_digest: attempt.task_structure_digest,
      semantic_status: "expected_success",
      exit_code: 0,
    });

    const completed = taskComplete(fx.projectRoot, fx.change, fx.changeRoot, "TASK-001");
    assert.equal(completed.events_written, 2);

    const toApplyDone = reviewReady(fx.projectRoot, fx.change, fx.changeRoot, "normal");
    assert.equal(toApplyDone.to_state, "apply_done");
    advanceApplyDoneToReview(fx.projectRoot, fx.change, fx.changeRoot, "normal");
    const verifier = reviewReady(fx.projectRoot, fx.change, fx.changeRoot, "normal");
    assert.equal(verifier.outcome, "job_created");
    const jobId = verifier.created_jobs[0];

    const packet = jobsPacket(fx.projectRoot, fx.change, jobId);
    assert.equal(typeof packet.packet?.review_evidence_digest, "string");
    assert.equal(packet.packet?.code_review_gate?.decision, "passed");
    assert.equal(typeof packet.packet?.code_review_gate?.job_id, "string");
    assert.equal(packet.packet?.task_execution_index?.[0]?.task_id, "TASK-001");
    assert.equal(packet.packet?.task_execution_index?.[0]?.attempt_id, attempt.attempt_id);
    assert.match(String(packet.packet?.output_instructions), /不要提交该报告；主流程会通过 next/);

    const reportPath = join(fx.projectRoot, "verifier-evidence.json");
    writeFileSync(reportPath, JSON.stringify({
      role: "verifier",
      findings: [],
      verdict: "pass",
      review_scope: { checked_paths: checkedPathsForJob(fx.projectRoot, fx.change, jobId) },
    }));
    const submit = recordJobSubmit(fx.projectRoot, fx.change, fx.changeRoot, jobId, reportPath);
    assert.equal(submit.accepted, true);

    const toReview = reviewReady(fx.projectRoot, fx.change, fx.changeRoot, "normal");
    assert.equal(toReview.to_state, "review");

    appendTestRunEvent(fx.projectRoot, fx.change, {
      test_id: "TEST-LATE-LEGACY",
      attempt_id: null,
      task_structure_digest: attempt.task_structure_digest,
      semantic_status: "expected_success",
      exit_code: 0,
    });

    const snap = rebuildSnapshot(fx.projectRoot, fx.change, fx.changeRoot);
    assert.equal(snap.accepted_jobs.some(job => job.job_id === jobId), false);

    const nextResult = next(fx.projectRoot, fx.change, fx.changeRoot);
    assert.equal(nextResult.path, "next_command");
    assert.match(nextResult.next_command, /review-ready/);

    const blocked = accept(fx.projectRoot, fx.change, fx.changeRoot);
    assert.equal(blocked.events_written, 0);
    assert.match(blocked.message, /缺少仍然匹配当前证据的最终验证/);
  } finally { fx.cleanup(); }
});

test("reviewEvidenceDigest：covers_task_ids 变化会刷新最终验证证据版本", () => {
  const fx = setupApplyWithDoneTask();
  try {
    writeFileSync(join(fx.changeRoot, "tasks.md"), "# Tasks\n\n- [ ] TASK-001 Implement\n");

    taskStart(fx.projectRoot, fx.change, fx.changeRoot, "TASK-001");
    const attempt = rebuildSnapshot(fx.projectRoot, fx.change, fx.changeRoot).active_task_attempts[0];
    assert.ok(attempt);

    appendTestRunEvent(fx.projectRoot, fx.change, {
      test_id: "TEST-RED",
      attempt_id: attempt.attempt_id,
      task_structure_digest: attempt.task_structure_digest,
      semantic_status: "expected_failure",
      exit_code: 1,
    });
    appendTestRunEvent(fx.projectRoot, fx.change, {
      test_id: "TEST-GREEN",
      attempt_id: attempt.attempt_id,
      task_structure_digest: attempt.task_structure_digest,
      semantic_status: "expected_success",
      exit_code: 0,
    });
    assert.equal(taskComplete(fx.projectRoot, fx.change, fx.changeRoot, "TASK-001").events_written, 2);

    const events = readEvents(fx.projectRoot, fx.change);
    const completedEvent = events.findLast(ev => ev.event_type === "task_completed");
    const redEvent = events.findLast(ev => ev.event_type === "test_run_recorded" && (ev.payload as { test_id?: unknown }).test_id === "TEST-RED");
    const greenEvent = events.findLast(ev => ev.event_type === "test_run_recorded" && (ev.payload as { test_id?: unknown }).test_id === "TEST-GREEN");
    assert.ok(completedEvent);
    assert.ok(redEvent);
    assert.ok(greenEvent);
    // 方案固定的 record 形态：legacy 字段只参与筛选，不进入 digest 本体
    const expectedRecords = [
      {
        kind: "task_completed",
        task_id: "TASK-001",
        attempt_id: attempt.attempt_id,
        event_id: completedEvent.event_id,
        event_digest: completedEvent.event_digest,
      },
      {
        kind: "test_run_recorded",
        test_id: "TEST-RED",
        attempt_id: attempt.attempt_id,
        semantic_status: "expected_failure",
        exit_code: 1,
        command: "npm test",
        cwd: fx.projectRoot,
        event_id: redEvent.event_id,
        event_digest: redEvent.event_digest,
      },
      {
        kind: "test_run_recorded",
        test_id: "TEST-GREEN",
        attempt_id: attempt.attempt_id,
        semantic_status: "expected_success",
        exit_code: 0,
        command: "npm test",
        cwd: fx.projectRoot,
        event_id: greenEvent.event_id,
        event_digest: greenEvent.event_digest,
      },
    ].sort((a, b) => [
      a.kind,
      "task_id" in a ? a.task_id : "",
      "test_id" in a ? a.test_id : "",
      a.attempt_id,
      a.event_id,
    ].join("\u0000").localeCompare([
      b.kind,
      "task_id" in b ? b.task_id : "",
      "test_id" in b ? b.test_id : "",
      b.attempt_id,
      b.event_id,
    ].join("\u0000")));
    const withoutCoverage = reviewEvidenceDigest(events);
    assert.equal(withoutCoverage, sha256Text(JSON.stringify(expectedRecords)));
    // covers_task_ids 等 payload 变化在真实事件里必然改变 event_digest，digest 随之刷新
    const withCoverage = reviewEvidenceDigest(events.map(ev => {
      const payload = ev.payload as Record<string, unknown>;
      if (ev.event_type !== "test_run_recorded" || payload.test_id !== "TEST-GREEN") return ev;
      return {
        ...ev,
        payload: { ...payload, covers_task_ids: ["TASK-001"] },
        event_digest: sha256Text(`${ev.event_digest}:covers_task_ids`),
      };
    }));

    assert.notEqual(withCoverage, withoutCoverage);
  } finally { fx.cleanup(); }
});

test("sync：绑定文件删除会让 open 和 accepted job stale", () => {
  const openFx = setupApplyWithDoneTask();
  try {
    advanceApplyToReview(openFx.projectRoot, openFx.change, openFx.changeRoot);
    const created = reviewReady(openFx.projectRoot, openFx.change, openFx.changeRoot);
    const jobId = created.created_jobs[0];

    rmSync(join(openFx.changeRoot, "proposal.md"), { force: true });
    const snap = rebuildSnapshot(openFx.projectRoot, openFx.change, openFx.changeRoot);
    assert.equal(snap.open_jobs.some(job => job.job_id === jobId), false);

    const reportPath = join(openFx.projectRoot, "stale-open.json");
    writeFileSync(reportPath, JSON.stringify({
      role: "verifier",
      findings: [],
      verdict: "pass",
      review_scope: { checked_paths: checkedPathsForJob(openFx.projectRoot, openFx.change, jobId) },
    }));
    const staleSubmit = recordJobSubmit(openFx.projectRoot, openFx.change, openFx.changeRoot, jobId, reportPath);
    assert.equal(staleSubmit.accepted, false);
    assert.match(staleSubmit.message, /sha256:missing/);
  } finally { openFx.cleanup(); }

  const acceptedFx = setupApplyWithDoneTask();
  try {
    advanceApplyToReview(acceptedFx.projectRoot, acceptedFx.change, acceptedFx.changeRoot);
    const created = reviewReady(acceptedFx.projectRoot, acceptedFx.change, acceptedFx.changeRoot);
    const jobId = created.created_jobs[0];
    const reportPath = join(acceptedFx.projectRoot, "fresh.json");
    writeFileSync(reportPath, JSON.stringify({
      role: "verifier",
      findings: [],
      verdict: "pass",
      review_scope: { checked_paths: checkedPathsForJob(acceptedFx.projectRoot, acceptedFx.change, jobId) },
    }));
    const accepted = recordJobSubmit(acceptedFx.projectRoot, acceptedFx.change, acceptedFx.changeRoot, jobId, reportPath);
    assert.equal(accepted.accepted, true);

    rmSync(join(acceptedFx.changeRoot, "proposal.md"), { force: true });
    const snap = rebuildSnapshot(acceptedFx.projectRoot, acceptedFx.change, acceptedFx.changeRoot);
    assert.equal(snap.accepted_jobs.some(job => job.job_id === jobId), false);
  } finally { acceptedFx.cleanup(); }
});

test("accept：review → accepted", () => {
  const fx = setupApplyWithDoneTask();
  try {
    advanceApplyToReview(fx.projectRoot, fx.change, fx.changeRoot, "minimal");
    createAndPassFinalVerifier(fx.projectRoot, fx.change, fx.changeRoot, "minimal");
    const result = accept(fx.projectRoot, fx.change, fx.changeRoot);
    assert.equal(result.to_state, "accepted");
  } finally { fx.cleanup(); }
});

test("accepted：受控 reopen 只能回到 propose，并记录计划材料基线", () => {
  const fx = setupApplyWithDoneTask();
  try {
    advanceApplyToReview(fx.projectRoot, fx.change, fx.changeRoot, "minimal");
    acceptAfterFinalVerifier(fx.projectRoot, fx.change, fx.changeRoot, "minimal");
    const acceptCommit = readEvents(fx.projectRoot, fx.change).findLast(event =>
      event.event_type === "transition_commit" &&
      (event.payload as { transition?: unknown }).transition === "accept"
    );
    const acceptedBaseline = (acceptCommit?.payload as { accepted_baseline_docs?: unknown })
      .accepted_baseline_docs;
    assert.equal(typeof acceptedBaseline, "object");

    const toApply = reopen(fx.projectRoot, fx.change, fx.changeRoot, "apply", "不能跳过计划阶段");
    assert.equal(toApply.events_written, 0);
    assert.match(toApply.message, /不能 reopen 到 apply/);

    const blankReason = reopen(fx.projectRoot, fx.change, fx.changeRoot, "propose", "   ");
    assert.equal(blankReason.events_written, 0);
    assert.match(blankReason.message, /非空 --reason/);

    const reopened = reopen(fx.projectRoot, fx.change, fx.changeRoot, "propose", "补充新的验收要求");
    assert.equal(reopened.outcome, "advanced");
    assert.equal(reopened.from_state, "accepted");
    assert.equal(reopened.to_state, "propose");

    const commit = readEvents(fx.projectRoot, fx.change).findLast(event =>
      event.event_type === "transition_commit" &&
      (event.payload as { transition?: unknown }).transition === "reopen"
    );
    const payload = commit?.payload as {
      reopen_source?: unknown;
      reopen_target?: unknown;
      baseline_source?: unknown;
      baseline_docs?: unknown;
    };
    assert.equal(payload.reopen_source, "accepted");
    assert.equal(payload.reopen_target, "propose");
    assert.equal(payload.baseline_source, "accepted");
    assert.deepEqual(payload.baseline_docs, acceptedBaseline);

    assert.equal(proposeReady(fx.projectRoot, fx.change, fx.changeRoot, "minimal").to_state, "propose_ready");
    const unchanged = startApply(fx.projectRoot, fx.change, fx.changeRoot);
    assert.equal(unchanged.events_written, 0);
    assert.match(unchanged.message, /至少一个计划文档必须变化/);

    writeFileSync(join(fx.changeRoot, "design.md"), "# D\n\n新增验收设计\n");
    assert.equal(startApply(fx.projectRoot, fx.change, fx.changeRoot).to_state, "apply");
  } finally { fx.cleanup(); }
});

test("accepted baseline：最新 accept 缺 baseline 时不复用更早轮次", () => {
  const change = "mixed-accepted-history";
  const older = makeEvent(change, "transition_commit", {
    transition: "accept",
    from_state: "review",
    to_state: "accepted",
    outcome: "advanced",
    created_job_ids: [],
    reason: "older accept",
    accepted_baseline_docs: { "proposal.md": "sha256:older" },
  });
  const latest = makeEvent(change, "transition_commit", {
    transition: "accept",
    from_state: "review",
    to_state: "accepted",
    outcome: "advanced",
    created_job_ids: [],
    reason: "latest legacy accept",
  });

  assert.equal(latestAcceptedProposalBaseline([older, latest]), null);
});

test("accepted baseline：缺 baseline 的最新 accept 使用显式保守 fallback", () => {
  const fx = setupApplyWithDoneTask();
  try {
    for (const [transition, fromState, toState] of [
      ["review-ready", "apply", "apply_done"],
      ["review-ready", "apply_done", "review"],
      ["accept", "review", "accepted"],
    ] as const) {
      appendEvent(fx.projectRoot, fx.change, makeEvent(fx.change, "transition_commit", {
        transition,
        from_state: fromState,
        to_state: toState,
        outcome: "advanced",
        created_job_ids: [],
        reason: "legacy fixture",
      }));
    }

    assert.equal(reopen(
      fx.projectRoot,
      fx.change,
      fx.changeRoot,
      "propose",
      "补充 legacy accepted 方案",
    ).to_state, "propose");
    const commit = readEvents(fx.projectRoot, fx.change).findLast(event =>
      event.event_type === "transition_commit" &&
      (event.payload as { transition?: unknown }).transition === "reopen"
    );
    assert.equal((commit?.payload as { baseline_source?: unknown }).baseline_source, "reopen_fallback");
    assert.equal(typeof (commit?.payload as { baseline_docs?: unknown }).baseline_docs, "object");
  } finally { fx.cleanup(); }
});

test("accepted reopen：reopen 前已有计划材料变化时复用 accept baseline", () => {
  const fx = setupApplyWithDoneTask();
  try {
    advanceApplyToReview(fx.projectRoot, fx.change, fx.changeRoot, "minimal");
    acceptAfterFinalVerifier(fx.projectRoot, fx.change, fx.changeRoot, "minimal");
    writeFileSync(join(fx.changeRoot, "design.md"), "# D\n\naccepted 后已补充设计约束\n");

    const done = next(fx.projectRoot, fx.change, fx.changeRoot, "minimal");
    assert.equal(done.path, "done");
    assert.equal(done.continuation?.plan_docs_changed_since_accept, true);
    assert.deepEqual(done.continuation?.resume.next_argv_after_completion, [
      "superspec", "transition", "next", "--change", fx.change,
    ]);
    assert.match(done.reason, /计划材料已变化/);

    const reopened = reopen(fx.projectRoot, fx.change, fx.changeRoot, "propose", "补充设计约束");
    assert.equal(reopened.to_state, "propose");
    assert.equal(proposeReady(fx.projectRoot, fx.change, fx.changeRoot, "minimal").to_state, "propose_ready");
    const applied = startApply(fx.projectRoot, fx.change, fx.changeRoot);
    assert.equal(applied.to_state, "apply");
  } finally { fx.cleanup(); }
});

test("accepted reopen：新 minimal planning round 不复用历史 proposal 审查角色", () => {
  const fx = setupApplyWithDoneTask();
  try {
    advanceApplyToReview(fx.projectRoot, fx.change, fx.changeRoot, "minimal");
    acceptAfterFinalVerifier(fx.projectRoot, fx.change, fx.changeRoot, "minimal");

    const historical = appendOpenJob(fx.projectRoot, fx.change, "accepted", {
      job_id: "JOB-historical-proposal-critic",
      role: "critic",
      gate_id: "propose.final_review",
      created_from_transition: "propose-ready",
      boundFiles: [docRef(fx.changeRoot, "design.md")],
    });
    appendEvent(fx.projectRoot, fx.change, makeEvent(fx.change, "job_rejected", {
      job_id: historical.job_id,
      role: historical.role,
      report_digest: "sha256:historical-proposal-critic",
      result_kind: "review_failed",
      reason: "旧周期计划审查失败",
      findings: [{ id: "OLD-CYCLE-001", evidence: "old cycle evidence" }],
    }));

    assert.equal(
      reopen(fx.projectRoot, fx.change, fx.changeRoot, "propose", "修改计划边界").to_state,
      "propose",
    );
    writeFileSync(join(fx.changeRoot, "design.md"), "# D\n\nchanged after accepted reopen\n");

    assert.equal(proposeReady(fx.projectRoot, fx.change, fx.changeRoot, "minimal").to_state, "propose_ready");
    const applied = startApply(fx.projectRoot, fx.change, fx.changeRoot);
    assert.equal(applied.outcome, "advanced");
    assert.equal(applied.to_state, "apply");
    assert.equal(rebuildSnapshot(fx.projectRoot, fx.change, fx.changeRoot).open_jobs.some(job =>
      job.job_id === historical.job_id || job.role === "critic",
    ), false);
  } finally { fx.cleanup(); }
});

test("CLI：accepted 可以显式 reopen --to propose", () => {
  const fx = setupApplyWithDoneTask();
  try {
    advanceApplyToReview(fx.projectRoot, fx.change, fx.changeRoot, "minimal");
    acceptAfterFinalVerifier(fx.projectRoot, fx.change, fx.changeRoot, "minimal");

    const cli = new URL("../src/cli.ts", import.meta.url).pathname;
    const output = execFileSync(process.execPath, [
      cli,
      "transition",
      "reopen",
      "--change",
      fx.change,
      "--to",
      "propose",
      "--reason",
      "补充新的方案约束",
    ], { cwd: fx.projectRoot, encoding: "utf8" });
    const result = JSON.parse(output);

    assert.equal(result.outcome, "advanced");
    assert.equal(result.from_state, "accepted");
    assert.equal(result.to_state, "propose");
  } finally { fx.cleanup(); }
});

test("legacy archive snapshot：只读 replay 后 next 仍返回 done", () => {
  const fx = setupApplyWithDoneTask();
  try {
    advanceApplyToReview(fx.projectRoot, fx.change, fx.changeRoot, "minimal");
    acceptAfterFinalVerifier(fx.projectRoot, fx.change, fx.changeRoot, "minimal");
    appendEvent(fx.projectRoot, fx.change, makeEvent(fx.change, "transition_commit", {
      transition: "archive",
      from_state: "accepted",
      to_state: "archive",
      outcome: "advanced",
      created_job_ids: [],
      reason: "legacy archive fixture",
    }, { transitionId: "T-legacy-archive-done", idempotencyKey: "legacy-archive-done-key" }));

    const result = next(fx.projectRoot, fx.change, fx.changeRoot);
    assert.equal(result.path, "done");
    assert.equal(result.state, "archive");
    assert.match(result.reason, /历史 archive/);
  } finally { fx.cleanup(); }
});

test("CLI：archive transition 已下线且不写事件", () => {
  const fx = setupApplyWithDoneTask();
  try {
    const before = readEvents(fx.projectRoot, fx.change).length;
    const cli = new URL("../src/cli.ts", import.meta.url).pathname;
    const result = spawnSync(process.execPath, [
      cli,
      "transition",
      "archive",
      "--change",
      fx.change,
    ], { cwd: fx.projectRoot, encoding: "utf8" });

    assert.equal(result.status, 1);
    assert.match(result.stderr, /未知的 transition 子命令：archive/);
    assert.equal(readEvents(fx.projectRoot, fx.change).length, before);
  } finally { fx.cleanup(); }
});

test("H3：verifier final gate accepted 后改文档 → stale → review-ready 创建新 job", () => {
  const projectRoot = mkdtempSync(join(tmpdir(), "superspec-p4stale-"));
  const change = "test-change";
  const changeRoot = join(projectRoot, "openspec", "changes", change);
  mkdirSync(join(changeRoot, ".superspec", "artifacts"), { recursive: true });
  writeFileSync(join(changeRoot, "tasks.md"), "# Tasks\n\n- [x] TASK-001 Done\n");
  writeFileSync(join(changeRoot, "proposal.md"), "# P\noriginal");
  writeFileSync(join(changeRoot, "design.md"), "# D\n");
  writeFileSync(join(changeRoot, ".superspec", "artifacts", "discovery.md"), "# D\n");
  writeFileSync(join(changeRoot, ".superspec", "artifacts", "test-contract.md"), "# TC\n");
  ensureChangeLayout(projectRoot, change);
  for (const [t, f, to] of [
    ["init","init","init"],["explore","init","explore"],["propose","explore","propose"],
    ["propose-ready","propose","propose_ready"],["start-apply","propose_ready","apply"],
    ["review-ready","apply","apply_done"],
  ] as const) {
    appendEvent(projectRoot, change, makeEvent(change, "transition_commit", {
      transition: t, from_state: f, to_state: to,
      outcome: "advanced", created_job_ids: [], reason: t,
    }, { transitionId: `T-${t}`, idempotencyKey: `${t}-key` }));
  }

  try {
    // 1. apply_done review-ready → code-reviewer，通过后进入 review
    const codeReview = reviewReady(projectRoot, change, changeRoot);
    assert.equal(codeReview.outcome, "job_created");
    assert.equal(submitCodeReviewerPass(projectRoot, change, changeRoot, codeReview.created_jobs[0]).accepted, true);
    confirmCurrentPhase(projectRoot, change, changeRoot);
    const toReview = reviewReady(projectRoot, change, changeRoot);
    assert.equal(toReview.to_state, "review");

    // 2. review-ready → 创建 verifier final gate
    const t1 = reviewReady(projectRoot, change, changeRoot);
    assert.equal(t1.outcome, "job_created");
    const jobId = t1.created_jobs[0];

    // 3. record job-submit → accepted
    const reportPath = join(projectRoot, "report.json");
    writeFileSync(reportPath, JSON.stringify({
      role: "verifier",
      findings: [],
      verdict: "pass",
      review_scope: { checked_paths: checkedPathsForJob(projectRoot, change, jobId) },
    }));
    recordJobSubmit(projectRoot, change, changeRoot, jobId, reportPath);

    // 4. 改 proposal.md（绑定文件变了）
    writeFileSync(join(changeRoot, "proposal.md"), "# P\nchanged");

    // 5. sync 应移除 stale accepted job
    const snap = rebuildSnapshot(projectRoot, change, changeRoot);
    assert.equal(snap.accepted_jobs.some(job => job.job_id === jobId), false, "verifier final gate 应因绑定文件变化而 stale");

    // 6. review-ready 应创建新 verifier final gate
    const t2 = reviewReady(projectRoot, change, changeRoot);
    assert.equal(t2.outcome, "job_created");
    assert.notEqual(t2.created_jobs[0], jobId, "应创建新 job（ID 不同）");
  } finally { rmSync(projectRoot, { recursive: true, force: true }); }
});
