// SuperSpec 流程引擎 — Phase 3 测试：apply + RED/GREEN + 复选框

import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { ensureChangeLayout, appendEvent, makeEvent, readEvents, rawFile, sha256Text } from "../src/store.ts";
import { rebuildSnapshot } from "../src/sync.ts";
import { next } from "../src/next.ts";
import { proposeReady, startApply, taskStart, taskComplete } from "../src/transition.ts";
import { jobsPacket, recordJobSubmit, recordUserDecisionContent } from "../src/record.ts";
import { recordTestRun, tasksStructureDigestOf } from "../src/task.ts";
import type { PhaseDecisionAction } from "../src/phase_confirmation.ts";
import type { Job, JobRole, State } from "../src/types.ts";
import { confirmCurrentPhase } from "./phase_confirmation_support.ts";

// ===== 夹具：seed 到 propose_ready =====

function setupApply(confirmBoundary = true): { projectRoot: string; change: string; changeRoot: string; cleanup: () => void } {
  const projectRoot = mkdtempSync(join(tmpdir(), "superspec-p3-"));
  const change = "test-change";
  const changeRoot = join(projectRoot, "openspec", "changes", change);
  mkdirSync(join(changeRoot, ".superspec", "artifacts"), { recursive: true });
  writeFileSync(join(changeRoot, "proposal.md"), "# Proposal\n");
  writeFileSync(join(changeRoot, "tasks.md"), "# Tasks\n\n- [ ] TASK-001 Do something\n- [ ] TASK-002 Do more\n");
  writeFileSync(join(changeRoot, "design.md"), "# Design\n");
  writeFileSync(join(changeRoot, ".superspec", "artifacts", "discovery.md"), "# Discovery\n");
  writeFileSync(join(changeRoot, ".superspec", "artifacts", "test-contract.md"), "# TC\n");
  ensureChangeLayout(projectRoot, change);

  // seed 到 propose_ready
  for (const [t, f, to] of [["init","init","init"],["explore","init","explore"],["propose","explore","propose"],["propose-ready","propose","propose_ready"]] as const) {
    appendEvent(projectRoot, change, makeEvent(change, "transition_commit", {
      transition: t, from_state: f, to_state: to,
      outcome: "advanced", created_job_ids: [], reason: t,
    }, { transitionId: `T-${t}`, idempotencyKey: `${t}-key` }));
  }
  if (confirmBoundary) confirmCurrentPhase(projectRoot, change, changeRoot);

  return {
    projectRoot, change, changeRoot,
    cleanup: () => rmSync(projectRoot, { recursive: true, force: true }),
  };
}

function setupTaskInProgress(): ReturnType<typeof setupApply> & { taskId: string; attemptId: string } {
  const fx = setupApply();
  // start-apply
  startApply(fx.projectRoot, fx.change, fx.changeRoot);
  // task-start
  const started = taskStart(fx.projectRoot, fx.change, fx.changeRoot, "TASK-001");
  const attemptId = started.details?.attempt_id;
  if (typeof attemptId !== "string") throw new Error("task-start should return attempt_id");
  return { ...fx, taskId: "TASK-001", attemptId };
}

function setupPropose(): ReturnType<typeof setupApply> {
  const projectRoot = mkdtempSync(join(tmpdir(), "superspec-p3-propose-"));
  const change = "test-change";
  const changeRoot = join(projectRoot, "openspec", "changes", change);
  mkdirSync(join(changeRoot, ".superspec", "artifacts"), { recursive: true });
  writeFileSync(join(changeRoot, "proposal.md"), "# Proposal\n");
  writeFileSync(join(changeRoot, "tasks.md"), "# Tasks\n\n- [ ] TASK-001 Do something\n");
  writeFileSync(join(changeRoot, "design.md"), "# Design\n");
  writeFileSync(join(changeRoot, ".superspec", "artifacts", "discovery.md"), "# Discovery\n");
  writeFileSync(join(changeRoot, ".superspec", "artifacts", "test-contract.md"), "# TC\n");
  ensureChangeLayout(projectRoot, change);
  for (const [t, f, to] of [["init","init","init"],["explore","init","explore"],["propose","explore","propose"]] as const) {
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

function reviewerReportForJob(projectRoot: string, change: string, jobId: string): string {
  const packet = jobsPacket(projectRoot, change, jobId).packet;
  assert.ok(packet);
  return JSON.stringify({
    role: packet.role,
    verdict: "pass",
    findings: [],
    review_scope: { checked_paths: packet.boundFiles.map(file => file.path) },
    reviewer: { kind: "codex-subagent", id: "test-reviewer" },
  });
}

function rawDirFiles(projectRoot: string, change: string): string[] {
  return readdirSync(join(projectRoot, ".superspec", "changes", change, "raw")).sort();
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

// ===== 测试 =====

test("start-apply：propose_ready → apply", () => {
  const fx = setupApply();
  try {
    const result = startApply(fx.projectRoot, fx.change, fx.changeRoot);
    assert.equal(result.outcome, "advanced");
    assert.equal(result.to_state, "apply");

    const snap = rebuildSnapshot(fx.projectRoot, fx.change, fx.changeRoot);
    assert.equal(snap.state, "apply");
  } finally { fx.cleanup(); }
});

test("start-apply：未确认时直接调用被拒绝，只有精确确认才能推进", () => {
  const fx = setupApply(false);
  try {
    const blocked = startApply(fx.projectRoot, fx.change, fx.changeRoot);
    assert.equal(blocked.events_written, 0);
    assert.match(blocked.message, /用户确认/);

    const ask = next(fx.projectRoot, fx.change, fx.changeRoot);
    assert.equal(ask.path, "ask_user");
    assert.match(ask.ask_user.scope, /^phase_confirmation:propose_to_apply:/);
    const actions = ask.ask_user.actions as PhaseDecisionAction[];
    assert.deepEqual(ask.ask_user.allowed_answers, actions.map(action => action.label));
    const advance = actions.find(action => action.decision === "advance");
    const stay = actions.find(action => action.decision === "stay");
    assert.ok(advance);
    assert.ok(stay);
    assert.equal(stay.reason, "required");
    assert.equal(stay.resume.kind, "continue_current_phase");

    const ambiguous = recordUserDecisionContent(fx.projectRoot, fx.change, JSON.stringify({
      scope: ask.ask_user.scope,
      question: ask.ask_user.question,
      answer: "继续",
    }));
    assert.equal(ambiguous.accepted, false);
    assert.match(ambiguous.message, /必须精确/);

    assert.equal(recordUserDecisionContent(
      fx.projectRoot,
      fx.change,
      JSON.stringify(stay.record_input),
    ).accepted, false);
    assert.equal(recordUserDecisionContent(fx.projectRoot, fx.change, JSON.stringify({
      ...stay.record_input,
      reason: "继续补充回滚方案",
    })).accepted, true);
    assert.equal(startApply(fx.projectRoot, fx.change, fx.changeRoot).events_written, 0);

    const confirmed = recordUserDecisionContent(
      fx.projectRoot,
      fx.change,
      JSON.stringify(advance.record_input),
    );
    assert.equal(confirmed.accepted, true);

    const advanced = startApply(fx.projectRoot, fx.change, fx.changeRoot);
    assert.equal(advanced.outcome, "advanced");
    assert.equal(advanced.to_state, "apply");
  } finally { fx.cleanup(); }
});

test("start-apply：minimal 无历史 proposal 审查时可进入 apply", () => {
  const fx = setupApply();
  try {
    const result = startApply(fx.projectRoot, fx.change, fx.changeRoot);
    assert.equal(result.outcome, "advanced");
    assert.equal(result.to_state, "apply");
  } finally { fx.cleanup(); }
});

test("start-apply：fresh proposal review accepted 后可进入 apply", () => {
  const fx = setupPropose();
  try {
    const t1 = proposeReady(fx.projectRoot, fx.change, fx.changeRoot, "normal");
    assert.equal(t1.outcome, "job_created");
    const reportPath = join(fx.projectRoot, "critic.json");
    writeFileSync(reportPath, reviewerReportForJob(fx.projectRoot, fx.change, t1.created_jobs[0]));
    const accepted = recordJobSubmit(fx.projectRoot, fx.change, fx.changeRoot, t1.created_jobs[0], reportPath);
    assert.equal(accepted.accepted, true);
    const t2 = proposeReady(fx.projectRoot, fx.change, fx.changeRoot, "normal");
    assert.equal(t2.to_state, "propose_ready");

    confirmCurrentPhase(fx.projectRoot, fx.change, fx.changeRoot, "normal");
    const result = startApply(fx.projectRoot, fx.change, fx.changeRoot);
    assert.equal(result.outcome, "advanced");
    assert.equal(result.to_state, "apply");
  } finally { fx.cleanup(); }
});

test("start-apply：proposal review stale 时创建 fresh job，next 返回 required_job", () => {
  const fx = setupPropose();
  try {
    const t1 = proposeReady(fx.projectRoot, fx.change, fx.changeRoot, "normal");
    const reportPath = join(fx.projectRoot, "critic.json");
    writeFileSync(reportPath, reviewerReportForJob(fx.projectRoot, fx.change, t1.created_jobs[0]));
    const accepted = recordJobSubmit(fx.projectRoot, fx.change, fx.changeRoot, t1.created_jobs[0], reportPath);
    assert.equal(accepted.accepted, true);
    const t2 = proposeReady(fx.projectRoot, fx.change, fx.changeRoot, "normal");
    assert.equal(t2.to_state, "propose_ready");

    writeFileSync(join(fx.changeRoot, "proposal.md"), "# Proposal\n\nchanged\n");

    const result = startApply(fx.projectRoot, fx.change, fx.changeRoot);
    assert.equal(result.outcome, "job_created");
    assert.equal(result.to_state, "propose_ready");
    assert.equal(result.created_jobs.length, 1);

    const snap = rebuildSnapshot(fx.projectRoot, fx.change, fx.changeRoot);
    assert.equal(snap.state, "propose_ready");
    assert.equal(snap.open_jobs.length, 1);
    assert.equal(snap.open_jobs[0].role, "critic");

    const nextResult = next(fx.projectRoot, fx.change, fx.changeRoot, "normal");
    assert.equal(nextResult.path, "required_job");
    assert.equal(nextResult.required_jobs[0].role, "critic");
  } finally { fx.cleanup(); }
});

test("propose stay：修改 design 后 strict 只重新审查 architect", () => {
  const fx = setupPropose();
  try {
    const first = proposeReady(fx.projectRoot, fx.change, fx.changeRoot, "strict");
    assert.equal(first.outcome, "job_created");
    assert.equal(first.created_jobs.length, 3);
    const firstJobs = rebuildSnapshot(fx.projectRoot, fx.change, fx.changeRoot).open_jobs;
    for (const job of firstJobs) {
      assert.ok(job.role === "critic" || job.role === "architect" || job.role === "test-engineer");
      const reportPath = join(fx.projectRoot, `${job.role}.json`);
      writeFileSync(reportPath, reviewerReportForJob(fx.projectRoot, fx.change, job.job_id));
      assert.equal(recordJobSubmit(
        fx.projectRoot,
        fx.change,
        fx.changeRoot,
        job.job_id,
        reportPath,
      ).accepted, true);
    }
    assert.equal(proposeReady(fx.projectRoot, fx.change, fx.changeRoot, "strict").to_state, "propose_ready");

    const ask = next(fx.projectRoot, fx.change, fx.changeRoot, "strict");
    assert.equal(ask.path, "ask_user");
    const stay = (ask.ask_user.actions as PhaseDecisionAction[]).find(action => action.decision === "stay");
    assert.ok(stay);
    assert.equal(recordUserDecisionContent(fx.projectRoot, fx.change, JSON.stringify({
      ...stay.record_input,
      reason: "继续补充设计边界",
    })).accepted, true);

    writeFileSync(join(fx.changeRoot, "design.md"), "# Design\n\nchanged after stay\n");
    const recheck = startApply(fx.projectRoot, fx.change, fx.changeRoot);
    assert.equal(recheck.outcome, "job_created");
    assert.equal(recheck.to_state, "propose_ready");
    const roles = rebuildSnapshot(fx.projectRoot, fx.change, fx.changeRoot).open_jobs
      .map(job => job.role)
      .sort();
    assert.deepEqual(roles, ["architect"]);
  } finally { fx.cleanup(); }
});

test("start-apply：非 propose_ready 状态拒绝", () => {
  const fx = setupApply();
  try {
    // 先 start-apply
    startApply(fx.projectRoot, fx.change, fx.changeRoot);
    // 再跑一次
    const result = startApply(fx.projectRoot, fx.change, fx.changeRoot);
    assert.equal(result.events_written, 0);
    assert.ok(result.message.includes("需要 propose_ready"));
  } finally { fx.cleanup(); }
});

test("task-start：创建 task_attempt", () => {
  const fx = setupApply();
  try {
    startApply(fx.projectRoot, fx.change, fx.changeRoot);
    const result = taskStart(fx.projectRoot, fx.change, fx.changeRoot, "TASK-001");
    assert.equal(result.events_written, 2); // commit + task_started
    assert.equal(typeof result.details?.attempt_id, "string");

    const snap = rebuildSnapshot(fx.projectRoot, fx.change, fx.changeRoot);
    assert.ok(snap.active_task_attempts);
    assert.equal(snap.active_task_attempts.length, 1);
    assert.equal(snap.active_task_attempts[0].task_id, "TASK-001");
    assert.equal(snap.active_task_attempts[0].state, "active");
  } finally { fx.cleanup(); }
});

test("next：apply 有 open job 时优先于 pending task", () => {
  const fx = setupApply();
  try {
    startApply(fx.projectRoot, fx.change, fx.changeRoot);
    const job = appendOpenJob(fx.projectRoot, fx.change, "apply", {
      job_id: "JOB-apply-executor",
      role: "executor",
      created_from_transition: "apply",
    });

    const result = next(fx.projectRoot, fx.change, fx.changeRoot, "normal");
    assert.equal(result.path, "required_job");
    assert.equal(result.required_jobs[0].job_id, job.job_id);
    assert.deepEqual(result.required_jobs[0].packet_argv, [
      "superspec", "jobs", "packet", "--change", fx.change, "--job", job.job_id,
    ]);
  } finally { fx.cleanup(); }
});

test("next：apply_done 有 pending task 时优先 reopen，再处理 open job", () => {
  const fx = setupApply();
  try {
    startApply(fx.projectRoot, fx.change, fx.changeRoot);
    appendEvent(fx.projectRoot, fx.change, makeEvent(fx.change, "transition_commit", {
      transition: "review-ready",
      from_state: "apply",
      to_state: "apply_done",
      outcome: "advanced",
      created_job_ids: [],
      reason: "simulate apply_done with pending task",
    }, { transitionId: "T-apply-done-pending", idempotencyKey: "apply-done-pending-key" }));
    const job = appendOpenJob(fx.projectRoot, fx.change, "apply_done", {
      job_id: "JOB-apply-done-executor",
      role: "executor",
      created_from_transition: "apply",
    });

    const result = next(fx.projectRoot, fx.change, fx.changeRoot, "normal");
    assert.equal(result.path, "next_command");
    assert.match(result.next_command, /transition reopen/);

    writeFileSync(join(fx.changeRoot, "tasks.md"), "# Tasks\n\n- [x] TASK-001 Do something\n- [x] TASK-002 Do more\n");

    const afterCompleted = next(fx.projectRoot, fx.change, fx.changeRoot, "normal");
    assert.equal(afterCompleted.path, "required_job");
    assert.equal(afterCompleted.required_jobs[0].job_id, job.job_id);
  } finally { fx.cleanup(); }
});

test("grouped tasks：next 支持标题分组下的顶格任务", () => {
  const fx = setupApply();
  try {
    writeFileSync(join(fx.changeRoot, "tasks.md"), [
      "# Tasks",
      "",
      "## Group A",
      "",
      "- [ ] 1.1 first task tdd_required:false no_tdd_reason:documentation-only",
      "  - ordinary note",
      "",
      "## Group B",
      "",
      "- [ ] 1.2 second task tdd_required:false no_tdd_reason:documentation-only",
      "",
    ].join("\n"));

    confirmCurrentPhase(fx.projectRoot, fx.change, fx.changeRoot);
    startApply(fx.projectRoot, fx.change, fx.changeRoot);

    const first = next(fx.projectRoot, fx.change, fx.changeRoot, "normal");
    assert.equal(first.path, "next_command");
    assert.equal(first.next_command, 'superspec transition task-start --change "test-change" --task 1.1');

    const start = taskStart(fx.projectRoot, fx.change, fx.changeRoot, "1.1");
    assert.equal(start.outcome, "advanced");

    const completeNext = next(fx.projectRoot, fx.change, fx.changeRoot, "normal");
    assert.equal(completeNext.path, "next_command");
    assert.equal(completeNext.next_command, 'superspec transition task-complete --change "test-change" --task 1.1');

    const complete = taskComplete(fx.projectRoot, fx.change, fx.changeRoot, "1.1");
    assert.equal(complete.outcome, "advanced");

    const second = next(fx.projectRoot, fx.change, fx.changeRoot, "normal");
    assert.equal(second.path, "next_command");
    assert.equal(second.next_command, 'superspec transition task-start --change "test-change" --task 1.2');
  } finally { fx.cleanup(); }
});

test("task-start：已完成任务拒绝", () => {
  const fx = setupApply();
  try {
    // 手动勾选 TASK-001
    const tasks = readFileSync(join(fx.changeRoot, "tasks.md"), "utf8");
    writeFileSync(join(fx.changeRoot, "tasks.md"), tasks.replace("TASK-001", "- [x] TASK-001").replace("- [ ] - [x]", "- [x]"));
    confirmCurrentPhase(fx.projectRoot, fx.change, fx.changeRoot);
    startApply(fx.projectRoot, fx.change, fx.changeRoot);
    const result = taskStart(fx.projectRoot, fx.change, fx.changeRoot, "TASK-001");
    assert.ok(result.message.includes("已完成"), `应报"已完成"，实际：${result.message}`);
  } finally { fx.cleanup(); }
});

test("record test-run：RED 登记", () => {
  const fx = setupTaskInProgress();
  try {
    const structDigest = tasksStructureDigestOf(fx.changeRoot);
    const testFile = join(fx.projectRoot, "red.json");
    writeFileSync(testFile, JSON.stringify({
      test_id: "TEST-001",
      attempt_id: fx.attemptId,
      task_structure_digest: structDigest,
      command: "npm test",
      cwd: fx.projectRoot,
      exit_code: 1,
      semantic_status: "expected_failure",
    }));
    const result = recordTestRun(fx.projectRoot, fx.change, testFile);
    assert.equal(result.accepted, true);

    const rawPath = rawFile(fx.projectRoot, fx.change, "test-runs");
    const rawLines = readFileSync(rawPath, "utf8").trim().split("\n");
    assert.equal(rawLines.length, 1);
    const raw = JSON.parse(rawLines[0]);
    assert.equal(raw.semantic_status, "expected_failure");
    assert.equal("covers_task_ids" in raw, false);
    assert.deepEqual(rawDirFiles(fx.projectRoot, fx.change), ["test-runs.jsonl", "user-decisions.jsonl"]);

    const event = readEvents(fx.projectRoot, fx.change).findLast(e => e.event_type === "test_run_recorded");
    assert.ok(event);
    assert.equal("covers_task_ids" in event.payload, false);
    assert.equal(event.payload.raw_kind, "test-runs");
    assert.equal(event.payload.raw_index, 0);
    assert.equal(event.payload.raw_digest, sha256Text(rawLines[0]));
  } finally { fx.cleanup(); }
});

test("record test-run：covers_task_ids 规范化后写入 raw 和 event", () => {
  const fx = setupTaskInProgress();
  try {
    const structDigest = tasksStructureDigestOf(fx.changeRoot);
    const testFile = join(fx.projectRoot, "regression.json");
    writeFileSync(testFile, JSON.stringify({
      test_id: "REGRESSION-001",
      attempt_id: fx.attemptId,
      task_structure_digest: structDigest,
      command: "npm test",
      cwd: fx.projectRoot,
      exit_code: 0,
      semantic_status: "expected_success",
      covers_task_ids: ["TASK-002", " TASK-001 ", "TASK-002"],
    }));
    const result = recordTestRun(fx.projectRoot, fx.change, testFile);
    assert.equal(result.accepted, true);

    const rawPath = rawFile(fx.projectRoot, fx.change, "test-runs");
    const rawLine = readFileSync(rawPath, "utf8").trim().split("\n").at(-1);
    assert.ok(rawLine);
    assert.deepEqual(JSON.parse(rawLine).covers_task_ids, ["TASK-001", "TASK-002"]);

    const event = readEvents(fx.projectRoot, fx.change).findLast(e => e.event_type === "test_run_recorded");
    assert.ok(event);
    assert.deepEqual(event.payload.covers_task_ids, ["TASK-001", "TASK-002"]);
  } finally { fx.cleanup(); }
});

test("record test-run：covers_task_ids 非法输入拒绝", () => {
  const cases = [
    { name: "not-array", value: "TASK-001" },
    { name: "empty-array", value: [] },
    { name: "non-string", value: ["TASK-001", 123] },
    { name: "blank-string", value: ["TASK-001", " "] },
  ];

  for (const item of cases) {
    const fx = setupTaskInProgress();
    try {
      const structDigest = tasksStructureDigestOf(fx.changeRoot);
      const testFile = join(fx.projectRoot, `${item.name}.json`);
      writeFileSync(testFile, JSON.stringify({
        test_id: "REGRESSION-001",
        attempt_id: fx.attemptId,
        task_structure_digest: structDigest,
        command: "npm test",
        cwd: fx.projectRoot,
        exit_code: 0,
        semantic_status: "expected_success",
        covers_task_ids: item.value,
      }));
      const result = recordTestRun(fx.projectRoot, fx.change, testFile);
      assert.equal(result.accepted, false, item.name);
      assert.equal(readEvents(fx.projectRoot, fx.change).some(e => e.event_type === "test_run_recorded"), false);
    } finally { fx.cleanup(); }
  }
});

test("record test-run：raw_index 跳过损坏 JSONL 行", () => {
  const fx = setupTaskInProgress();
  try {
    const rawPath = rawFile(fx.projectRoot, fx.change, "test-runs");
    writeFileSync(rawPath, `${JSON.stringify({ seed: true })}\n{ bad json\n`, "utf8");
    const structDigest = tasksStructureDigestOf(fx.changeRoot);
    const testFile = join(fx.projectRoot, "red.json");
    writeFileSync(testFile, JSON.stringify({
      test_id: "TEST-001",
      attempt_id: fx.attemptId,
      task_structure_digest: structDigest,
      command: "npm test",
      cwd: fx.projectRoot,
      exit_code: 1,
      semantic_status: "expected_failure",
    }));

    const result = recordTestRun(fx.projectRoot, fx.change, testFile);
    assert.equal(result.accepted, true);

    const event = readEvents(fx.projectRoot, fx.change).findLast(e => e.event_type === "test_run_recorded");
    assert.ok(event);
    assert.equal(event.payload.raw_index, 1);
  } finally { fx.cleanup(); }
});

test("raw JSONL orphan 行不作为任务完成证据", () => {
  const fx = setupTaskInProgress();
  try {
    const rawPath = rawFile(fx.projectRoot, fx.change, "test-runs");
    writeFileSync(rawPath, [
      JSON.stringify({ test_id: "TEST-001", semantic_status: "expected_failure" }),
      JSON.stringify({ test_id: "TEST-001", semantic_status: "expected_success" }),
      "",
    ].join("\n"), "utf8");

    const snap = rebuildSnapshot(fx.projectRoot, fx.change, fx.changeRoot);
    assert.equal(snap.active_task_attempts.length, 1);

    const nextResult = next(fx.projectRoot, fx.change, fx.changeRoot, "normal");
    assert.equal(nextResult.path, "ask_user");
    assert.ok(nextResult.reason.includes("缺少完成证据"));

    const complete = taskComplete(fx.projectRoot, fx.change, fx.changeRoot, "TASK-001");
    assert.equal(complete.events_written, 0);
    assert.ok(complete.message.includes("RED"));
  } finally { fx.cleanup(); }
});

test("record test-run：raw append 失败时不写 accepted event", () => {
  const fx = setupTaskInProgress();
  try {
    const rawPath = rawFile(fx.projectRoot, fx.change, "test-runs");
    mkdirSync(rawPath);
    const structDigest = tasksStructureDigestOf(fx.changeRoot);
    const testFile = join(fx.projectRoot, "red.json");
    writeFileSync(testFile, JSON.stringify({
      test_id: "TEST-001",
      attempt_id: fx.attemptId,
      task_structure_digest: structDigest,
      command: "npm test",
      cwd: fx.projectRoot,
      exit_code: 1,
      semantic_status: "expected_failure",
    }));

    assert.throws(() => recordTestRun(fx.projectRoot, fx.change, testFile));
    assert.equal(readEvents(fx.projectRoot, fx.change).some(e => e.event_type === "test_run_recorded"), false);
  } finally { fx.cleanup(); }
});

test("task-complete：缺 RED 拒绝", () => {
  const fx = setupTaskInProgress();
  try {
    const result = taskComplete(fx.projectRoot, fx.change, fx.changeRoot, "TASK-001");
    assert.ok(result.message.includes("RED"));
    assert.equal(result.events_written, 0);
  } finally { fx.cleanup(); }
});

test("task-complete：RED + GREEN → 完成 + 勾选", () => {
  const fx = setupTaskInProgress();
  try {
    const structDigest = tasksStructureDigestOf(fx.changeRoot);

    // RED
    const redFile = join(fx.projectRoot, "red.json");
    writeFileSync(redFile, JSON.stringify({
      test_id: "TEST-001", attempt_id: fx.attemptId, task_structure_digest: structDigest,
      command: "npm test", cwd: fx.projectRoot, exit_code: 1, semantic_status: "expected_failure",
    }));
    recordTestRun(fx.projectRoot, fx.change, redFile);

    // GREEN
    const greenFile = join(fx.projectRoot, "green.json");
    writeFileSync(greenFile, JSON.stringify({
      test_id: "TEST-001", attempt_id: fx.attemptId, task_structure_digest: structDigest,
      command: "npm test", cwd: fx.projectRoot, exit_code: 0, semantic_status: "expected_success",
      covers_task_ids: ["TASK-001"],
    }));
    recordTestRun(fx.projectRoot, fx.change, greenFile);

    // complete
    const result = taskComplete(fx.projectRoot, fx.change, fx.changeRoot, "TASK-001");
    assert.equal(result.events_written, 2); // commit + task_completed

    // 验证 checkbox 已勾
    const after = readFileSync(join(fx.changeRoot, "tasks.md"), "utf8");
    assert.ok(after.match(/- \[x\].*TASK-001/), "TASK-001 应已勾选");

    // 验证 attempt 已 closed
    const snap = rebuildSnapshot(fx.projectRoot, fx.change, fx.changeRoot);
    const attempt = snap.active_task_attempts?.find(a => a.task_id === "TASK-001");
    assert.ok(attempt, "应有 attempt 记录");
    assert.equal(attempt.state, "closed");
  } finally { fx.cleanup(); }
});

test("task-complete：结构指纹不匹配拒绝", () => {
  const fx = setupTaskInProgress();
  try {
    // 改 task 文本（结构变了）
    const tasks = readFileSync(join(fx.changeRoot, "tasks.md"), "utf8");
    writeFileSync(join(fx.changeRoot, "tasks.md"), tasks.replace("Do something", "Do something else"));

    const result = taskComplete(fx.projectRoot, fx.change, fx.changeRoot, "TASK-001");
    assert.ok(result.message.includes("结构指纹"));
    assert.equal(result.events_written, 0);
  } finally { fx.cleanup(); }
});

test("双 task-start：同任务已有活跃尝试时拒绝", () => {
  const fx = setupTaskInProgress();
  try {
    const result = taskStart(fx.projectRoot, fx.change, fx.changeRoot, "TASK-001");
    assert.equal(result.events_written, 0);
    assert.ok(result.message.includes("活跃尝试"), result.message);
  } finally { fx.cleanup(); }
});

test("no-TDD 任务：缺 no_tdd_reason 拒绝", () => {
  const projectRoot = mkdtempSync(join(tmpdir(), "superspec-p3nt-"));
  const change = "test-change";
  const changeRoot = join(projectRoot, "openspec", "changes", change);
  mkdirSync(join(changeRoot, ".superspec", "artifacts"), { recursive: true });
  // no-TDD 任务：tdd_required:false 但无 no_tdd_reason
  writeFileSync(join(changeRoot, "tasks.md"), "# Tasks\n\n- [ ] TASK-001 docs only tdd_required:false\n");
  writeFileSync(join(changeRoot, "proposal.md"), "# P\n");
  writeFileSync(join(changeRoot, "design.md"), "# D\n");
  writeFileSync(join(changeRoot, ".superspec", "artifacts", "discovery.md"), "# D\n");
  writeFileSync(join(changeRoot, ".superspec", "artifacts", "test-contract.md"), "# TC\n");
  ensureChangeLayout(projectRoot, change);
  for (const [t, f, to] of [["init","init","init"],["explore","init","explore"],["propose","explore","propose"],["propose-ready","propose","propose_ready"]] as const) {
    appendEvent(projectRoot, change, makeEvent(change, "transition_commit", {
      transition: t, from_state: f, to_state: to,
      outcome: "advanced", created_job_ids: [], reason: t,
    }, { transitionId: `T-${t}`, idempotencyKey: `${t}-key` }));
  }
  try {
    confirmCurrentPhase(projectRoot, change, changeRoot);
    startApply(projectRoot, change, changeRoot);
    taskStart(projectRoot, change, changeRoot, "TASK-001");
    const result = taskComplete(projectRoot, change, changeRoot, "TASK-001");
    assert.ok(result.message.includes("no_tdd_reason"), result.message);
    assert.equal(result.events_written, 0);
  } finally { rmSync(projectRoot, { recursive: true, force: true }); }
});

test("no-TDD 任务：有 no_tdd_reason 可完成", () => {
  const projectRoot = mkdtempSync(join(tmpdir(), "superspec-p3nt2-"));
  const change = "test-change";
  const changeRoot = join(projectRoot, "openspec", "changes", change);
  mkdirSync(join(changeRoot, ".superspec", "artifacts"), { recursive: true });
  writeFileSync(join(changeRoot, "tasks.md"), "# Tasks\n\n- [ ] TASK-001 docs tdd_required:false no_tdd_reason:documentation-only\n");
  writeFileSync(join(changeRoot, "proposal.md"), "# P\n");
  writeFileSync(join(changeRoot, "design.md"), "# D\n");
  writeFileSync(join(changeRoot, ".superspec", "artifacts", "discovery.md"), "# D\n");
  writeFileSync(join(changeRoot, ".superspec", "artifacts", "test-contract.md"), "# TC\n");
  ensureChangeLayout(projectRoot, change);
  for (const [t, f, to] of [["init","init","init"],["explore","init","explore"],["propose","explore","propose"],["propose-ready","propose","propose_ready"]] as const) {
    appendEvent(projectRoot, change, makeEvent(change, "transition_commit", {
      transition: t, from_state: f, to_state: to,
      outcome: "advanced", created_job_ids: [], reason: t,
    }, { transitionId: `T-${t}`, idempotencyKey: `${t}-key` }));
  }
  try {
    confirmCurrentPhase(projectRoot, change, changeRoot);
    startApply(projectRoot, change, changeRoot);
    taskStart(projectRoot, change, changeRoot, "TASK-001");
    const result = taskComplete(projectRoot, change, changeRoot, "TASK-001");
    assert.equal(result.events_written, 2); // commit + task_completed
    const after = readFileSync(join(changeRoot, "tasks.md"), "utf8");
    assert.ok(after.match(/- \[x\].*TASK-001/), "TASK-001 应已勾选");
  } finally { rmSync(projectRoot, { recursive: true, force: true }); }
});
