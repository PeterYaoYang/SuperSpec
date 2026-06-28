// SuperSpec 流程引擎 — Phase 4 测试：review + archive

import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { ensureChangeLayout, appendEvent, makeEvent, readEvents, rawFile } from "../src/store.ts";
import { rebuildSnapshot } from "../src/sync.ts";
import { next } from "../src/next.ts";
import { reviewReady, taskStart, taskComplete, reopen, accept, archive } from "../src/transition.ts";
import { jobsPacket, recordJobSubmit, recordUserDecisionContent } from "../src/record.ts";
import { reviewEvidenceDigest } from "../src/review.ts";
import type { Job, JobRole, State } from "../src/types.ts";

function setupApplyWithDoneTask(): { projectRoot: string; change: string; changeRoot: string; cleanup: () => void } {
  const projectRoot = mkdtempSync(join(tmpdir(), "superspec-p4-"));
  const change = "test-change";
  const changeRoot = join(projectRoot, "openspec", "changes", change);
  mkdirSync(join(changeRoot, ".superspec", "artifacts"), { recursive: true });
  // 任务已勾选
  writeFileSync(join(changeRoot, "tasks.md"), "# Tasks\n\n- [x] TASK-001 Done\n");
  writeFileSync(join(changeRoot, "proposal.md"), "# P\n");
  writeFileSync(join(changeRoot, "design.md"), "# D\n");
  writeFileSync(join(changeRoot, ".superspec", "artifacts", "discovery.md"), "# D\n");
  writeFileSync(join(changeRoot, ".superspec", "artifacts", "business-invariants.md"), "# BI\n");
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

function codeReviewerReport(
  projectRoot: string,
  change: string,
  jobId: string,
  verdict: "pass" | "fail",
  findings: unknown[],
  checkedPaths: string[] = [],
): Record<string, unknown> {
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
    findings,
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
  writeFileSync(reportPath, JSON.stringify({ role: "verifier", findings: [], verdict: "pass" }));
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
      review_risk: "strict",
      requires_verifier: true,
    });
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

test("reopen：无 pending task 或终态来源时拒绝", () => {
  const fx = setupApplyWithDoneTask();
  try {
    reviewReady(fx.projectRoot, fx.change, fx.changeRoot);
    const noPending = reopen(fx.projectRoot, fx.change, fx.changeRoot, "apply", "no pending");
    assert.equal(noPending.events_written, 0);
    assert.match(noPending.message, /没有未完成任务/);
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
    archive(archiveFx.projectRoot, archiveFx.change, archiveFx.changeRoot);
    writeFileSync(join(archiveFx.changeRoot, "tasks.md"), "# Tasks\n\n- [ ] TASK-025 Too late\n");

    const fromArchive = reopen(archiveFx.projectRoot, archiveFx.change, archiveFx.changeRoot, "apply", "pending tasks: TASK-025");
    assert.equal(fromArchive.events_written, 0);
    assert.match(fromArchive.message, /不能 reopen/);
  } finally { archiveFx.cleanup(); }
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

test("next：apply/apply_done 显式 minimal 会传播到 review-ready", () => {
  const fx = setupApplyWithDoneTask();
  try {
    const applyResult = next(fx.projectRoot, fx.change, fx.changeRoot, "minimal");
    assert.equal(applyResult.path, "next_command");
    assert.ok(applyResult.next_command.includes('review-ready --change "test-change" --risk minimal'));

    const transition = reviewReady(fx.projectRoot, fx.change, fx.changeRoot, "minimal");
    assert.equal(transition.to_state, "apply_done");

    const applyDoneResult = next(fx.projectRoot, fx.change, fx.changeRoot, "minimal");
    assert.equal(applyDoneResult.path, "next_command");
    assert.ok(applyDoneResult.next_command.includes('review-ready --change "test-change" --risk minimal'));
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
    assert.equal(nextResult.next_command, 'superspec transition review-ready --change "test-change" --risk minimal');

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
  writeFileSync(join(changeRoot, ".superspec", "artifacts", "business-invariants.md"), "# BI\n");
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
    assert.deepEqual(packet.packet?.output_contract_fields, ["role", "verdict", "findings", "reviewer", "review_scope"]);
    assert.equal(packet.packet?.recommended_agent, "code-reviewer");

    const recorded = submitCodeReviewerPass(projectRoot, change, changeRoot, result.created_jobs[0]);
    assert.equal(recorded.accepted, true);

    const advanced = reviewReady(projectRoot, change, changeRoot);
    assert.equal(advanced.outcome, "advanced");
    assert.equal(advanced.to_state, "review");
    const passedCommit = readEvents(projectRoot, change).findLast(e =>
      e.event_type === "transition_commit" &&
      (e.payload as { from_state?: unknown; to_state?: unknown }).from_state === "apply_done" &&
      (e.payload as { from_state?: unknown; to_state?: unknown }).to_state === "review"
    );
    assert.deepEqual((passedCommit?.payload as { code_review_gate?: unknown }).code_review_gate, {
      decision: "passed",
      job_id: result.created_jobs[0],
    });

    const verifier = reviewReady(projectRoot, change, changeRoot);
    assert.equal(verifier.outcome, "job_created");
    const reviewSnap = rebuildSnapshot(projectRoot, change, changeRoot);
    const verifierJob = reviewSnap.open_jobs.find(job => job.job_id === verifier.created_jobs[0]);
    assert.equal(verifierJob?.role, "verifier");
    const verifierPacket = jobsPacket(projectRoot, change, verifier.created_jobs[0]);
    assert.deepEqual(verifierPacket.packet?.output_contract_fields, ["role", "verdict", "findings"]);
    assert.match(String(verifierPacket.packet?.output_instructions), /code_review_gate/);
    assert.match(String(verifierPacket.packet?.output_instructions), /attempt_id/);
  } finally { rmSync(projectRoot, { recursive: true, force: true }); }
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

    const toReview = reviewReady(fx.projectRoot, fx.change, fx.changeRoot);
    assert.equal(toReview.outcome, "advanced");
    assert.equal(toReview.to_state, "review");
    const commit = readEvents(fx.projectRoot, fx.change).findLast(e =>
      e.event_type === "transition_commit" &&
      (e.payload as { from_state?: unknown; to_state?: unknown }).from_state === "apply_done" &&
      (e.payload as { from_state?: unknown; to_state?: unknown }).to_state === "review"
    );
    assert.deepEqual((commit?.payload as { code_review_gate?: unknown }).code_review_gate, {
      decision: "skipped",
      reason: "no_code_changes",
    });

    const verifier = reviewReady(fx.projectRoot, fx.change, fx.changeRoot);
    assert.equal(verifier.outcome, "job_created");
    const snap = rebuildSnapshot(fx.projectRoot, fx.change, fx.changeRoot);
    assert.equal(snap.open_jobs.find(job => job.job_id === verifier.created_jobs[0])?.role, "verifier");
  } finally { fx.cleanup(); }
});

test("code-reviewer：pass 报告必须覆盖绑定代码路径", () => {
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

    const rejected = submitCodeReviewerReport(
      fx.projectRoot,
      fx.change,
      fx.changeRoot,
      created.created_jobs[0],
      codeReviewerReport(fx.projectRoot, fx.change, created.created_jobs[0], "pass", []),
    );
    assert.equal(rejected.accepted, false);
    assert.match(rejected.message, /未说明是否检查了 src\/example\.ts/);
    const event = readEvents(fx.projectRoot, fx.change).findLast(e => e.event_type === "job_rejected");
    assert.equal((event?.payload as { result_kind?: unknown }).result_kind, "invalid_report");
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

test("code-reviewer：accepted pass 后绑定文件变化仍进入 review", () => {
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
    const retry = reviewReady(fx.projectRoot, fx.change, fx.changeRoot);
    assert.equal(retry.outcome, "advanced");
    assert.equal(retry.to_state, "review");
    const event = readEvents(fx.projectRoot, fx.change).findLast(e => e.event_type === "transition_commit");
    const gate = (event?.payload as { code_review_gate?: { decision?: string; job_id?: string } }).code_review_gate;
    assert.equal(gate?.decision, "passed");
    assert.equal(gate?.job_id, first.created_jobs[0]);
    const snap = rebuildSnapshot(fx.projectRoot, fx.change, fx.changeRoot);
    assert.equal(snap.state, "review");
    assert.equal(snap.accepted_jobs.some(job => job.job_id === first.created_jobs[0]), true);
  } finally { fx.cleanup(); }
});

test("code-reviewer：accepted pass 后新增代码文件仍进入 review", () => {
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
    const retry = reviewReady(fx.projectRoot, fx.change, fx.changeRoot);
    assert.equal(retry.outcome, "advanced");
    assert.equal(retry.to_state, "review");
    const event = readEvents(fx.projectRoot, fx.change).findLast(e => e.event_type === "transition_commit");
    const gate = (event?.payload as { code_review_gate?: { decision?: string; job_id?: string } }).code_review_gate;
    assert.equal(gate?.decision, "passed");
    assert.equal(gate?.job_id, first.created_jobs[0]);
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

test("code-reviewer：invalid_report 后 retry 会携带上次拒绝原因", () => {
  const fx = setupApplyWithDoneTask();
  try {
    reviewReady(fx.projectRoot, fx.change, fx.changeRoot);
    const first = reviewReady(fx.projectRoot, fx.change, fx.changeRoot);
    assert.equal(first.outcome, "job_created");

    const rejected = submitCodeReviewerReport(fx.projectRoot, fx.change, fx.changeRoot, first.created_jobs[0], {
      role: "code-reviewer",
      verdict: "pass",
      findings: [],
      reviewer: { kind: "codex-subagent", id: "test-code-reviewer" },
    });
    assert.equal(rejected.accepted, false);
    const rejectedEvent = readEvents(fx.projectRoot, fx.change).findLast(e => e.event_type === "job_rejected");
    assert.equal((rejectedEvent?.payload as { result_kind?: unknown }).result_kind, "invalid_report");

    const nextResult = next(fx.projectRoot, fx.change, fx.changeRoot);
    assert.equal(nextResult.path, "next_command");
    assert.match(nextResult.next_command, /review-ready/);

    const retry = reviewReady(fx.projectRoot, fx.change, fx.changeRoot);
    assert.equal(retry.outcome, "job_created");
    const packet = jobsPacket(fx.projectRoot, fx.change, retry.created_jobs[0]);
    assert.deepEqual((packet.packet?.previous_rejection as { result_kind?: unknown; job_id?: unknown })?.result_kind, "invalid_report");
    assert.equal((packet.packet?.previous_rejection as { job_id?: unknown })?.job_id, first.created_jobs[0]);
  } finally { fx.cleanup(); }
});

test("code-reviewer：连续 invalid/non-actionable 后 next 交给用户修正报告生成方式", () => {
  const fx = setupApplyWithDoneTask();
  try {
    reviewReady(fx.projectRoot, fx.change, fx.changeRoot);
    const first = reviewReady(fx.projectRoot, fx.change, fx.changeRoot);
    assert.equal(first.outcome, "job_created");
    submitCodeReviewerReport(fx.projectRoot, fx.change, fx.changeRoot, first.created_jobs[0], {
      role: "code-reviewer",
      verdict: "pass",
      findings: [],
      reviewer: { kind: "codex-subagent", id: "test-code-reviewer" },
    });

    const second = reviewReady(fx.projectRoot, fx.change, fx.changeRoot);
    assert.equal(second.outcome, "job_created");
    const nonActionable = submitCodeReviewerReport(
      fx.projectRoot,
      fx.change,
      fx.changeRoot,
      second.created_jobs[0],
      codeReviewerReport(fx.projectRoot, fx.change, second.created_jobs[0], "fail", []),
    );
    assert.equal(nonActionable.accepted, false);
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

test("code-reviewer：实现问题可 reopen apply 并追加审查修复 task", () => {
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
    const rejected = submitCodeReviewerReport(
      fx.projectRoot,
      fx.change,
      fx.changeRoot,
      jobId,
      codeReviewerReport(fx.projectRoot, fx.change, jobId, "fail", [finding]),
    );
    assert.equal(rejected.accepted, false);
    const rejectedEvent = readEvents(fx.projectRoot, fx.change).findLast(e => e.event_type === "job_rejected");
    assert.equal((rejectedEvent?.payload as { result_kind?: unknown }).result_kind, "review_failed");
    assert.equal((rejectedEvent?.payload as { raw_kind?: unknown }).raw_kind, "review-reports");
    const rawLines = readFileSync(rawFile(fx.projectRoot, fx.change, "review-reports"), "utf8").trim().split("\n");
    assert.equal(JSON.parse(rawLines.at(-1) ?? "{}").findings[0].id, "CR-001");

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
    assert.match(tasks, /tdd_required:true/);
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
    assert.deepEqual(ask.ask_user.allowed_answers, ["reopen_propose", "fix_in_apply"]);

    const blocked = reopen(fx.projectRoot, fx.change, fx.changeRoot, "propose", "补充降级路径设计", {
      reviewFinding: `${jobId}#CR-SPEC-001`,
    });
    assert.equal(blocked.events_written, 0);
    assert.match(blocked.message, /缺少使用者确认/);

    const decision = recordUserDecisionContent(fx.projectRoot, fx.change, JSON.stringify({
      scope: `code_review_decision:${jobId}#CR-SPEC-001`,
      question: ask.ask_user.question,
      answer: "reopen_propose",
    }));
    assert.equal(decision.accepted, true);

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
      answer: "fix_in_apply",
    }));
    assert.equal(decision.accepted, true);

    const reopened = reopen(fx.projectRoot, fx.change, fx.changeRoot, "apply", "用户确认文档不改，回 apply 修实现", {
      reviewFix: `${jobId}#CR-MIX-001`,
    });
    assert.equal(reopened.to_state, "apply");
    const tasks = readFileSync(join(fx.changeRoot, "tasks.md"), "utf8");
    assert.match(tasks, new RegExp(`REVIEW-FIX-${jobId}#CR-MIX-001`));
    assert.match(tasks, new RegExp(`review_fix_of:${jobId}#CR-MIX-001`));
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

test("next：accepted 和 archive 有 open job 时不走普通完成路径", () => {
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
    archive(archiveFx.projectRoot, archiveFx.change, archiveFx.changeRoot);
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

test("next：accepted 无 open job 时等待用户确认归档", () => {
  const fx = setupApplyWithDoneTask();
  try {
    advanceApplyToReview(fx.projectRoot, fx.change, fx.changeRoot, "minimal");
    acceptAfterFinalVerifier(fx.projectRoot, fx.change, fx.changeRoot, "minimal");

    const result = next(fx.projectRoot, fx.change, fx.changeRoot);
    assert.equal(result.path, "ask_user");
    assert.equal(result.state, "accepted");
    assert.equal(result.ask_user.scope, "archive_confirmation");
    assert.match(result.ask_user.question, /确认归档/);
    assert.match(result.reason, /等待用户确认归档/);
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

    const reportPath = join(fx.projectRoot, "verifier-evidence.json");
    writeFileSync(reportPath, JSON.stringify({ role: "verifier", findings: [], verdict: "pass" }));
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
    writeFileSync(reportPath, JSON.stringify({ role: "verifier", findings: [], verdict: "pass" }));
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
    writeFileSync(reportPath, JSON.stringify({ role: "verifier", findings: [], verdict: "pass" }));
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

test("archive：accepted → archive + 保全清单", () => {
  const projectRoot = mkdtempSync(join(tmpdir(), "superspec-p4ar-"));
  const change = "test-change";
  const changeRoot = join(projectRoot, "openspec", "changes", change);
  mkdirSync(join(changeRoot, ".superspec", "artifacts"), { recursive: true });
  writeFileSync(join(changeRoot, "tasks.md"), "# Tasks\n");
  writeFileSync(join(changeRoot, "proposal.md"), "# P\n");
  ensureChangeLayout(projectRoot, change);
  for (const [t, f, to] of [
    ["init","init","init"],["explore","init","explore"],["propose","explore","propose"],
    ["propose-ready","propose","propose_ready"],["start-apply","propose_ready","apply"],
    ["review-ready","apply","apply_done"],["review-ready2","apply_done","review"],
    ["accept","review","accepted"],
  ] as const) {
    appendEvent(projectRoot, change, makeEvent(change, "transition_commit", {
      transition: t, from_state: f, to_state: to,
      outcome: "advanced", created_job_ids: [], reason: t,
    }, { transitionId: `T-${t}`, idempotencyKey: `${t}-key` }));
  }
  try {
    const result = archive(projectRoot, change, changeRoot);
    assert.equal(result.to_state, "archive");
    assert.ok(result.events_written >= 1);

    // 验证 events 含保全清单
    const events = readEvents(projectRoot, change);
    const hasManifest = events.some(e => e.event_type === "artifact_recorded");
    assert.ok(hasManifest, "应有保全清单事件");

    // H3 修复：验证 manifest 内容（文档键 + 指纹正确）
    const manifestEv = events.find(e => e.event_type === "artifact_recorded");
    const manifest = manifestEv?.payload as { manifest?: Record<string,string> };
    assert.ok(manifest?.manifest?.["proposal.md"], "manifest 应含 proposal.md");
    assert.ok(manifest?.manifest?.["tasks.md"], "manifest 应含 tasks.md");
    assert.ok(manifest?.manifest?.["proposal.md"]?.startsWith("sha256:"), "指纹应以 sha256: 开头");
  } finally { rmSync(projectRoot, { recursive: true, force: true }); }
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
  writeFileSync(join(changeRoot, ".superspec", "artifacts", "business-invariants.md"), "# BI\n");
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
    const toReview = reviewReady(projectRoot, change, changeRoot);
    assert.equal(toReview.to_state, "review");

    // 2. review-ready → 创建 verifier final gate
    const t1 = reviewReady(projectRoot, change, changeRoot);
    assert.equal(t1.outcome, "job_created");
    const jobId = t1.created_jobs[0];

    // 3. record job-submit → accepted
    const reportPath = join(projectRoot, "report.json");
    writeFileSync(reportPath, JSON.stringify({ role: "verifier", findings: [], verdict: "pass" }));
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
