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
import { recordJobSubmit } from "../src/record.ts";
import { recordTestRun, tasksStructureDigestOf } from "../src/task.ts";

// ===== 夹具：seed 到 propose_ready =====

function setupApply(): { projectRoot: string; change: string; changeRoot: string; cleanup: () => void } {
  const projectRoot = mkdtempSync(join(tmpdir(), "superspec-p3-"));
  const change = "test-change";
  const changeRoot = join(projectRoot, "openspec", "changes", change);
  mkdirSync(join(changeRoot, ".superspec", "artifacts"), { recursive: true });
  writeFileSync(join(changeRoot, "proposal.md"), "# Proposal\n");
  writeFileSync(join(changeRoot, "tasks.md"), "# Tasks\n\n- [ ] TASK-001 Do something\n- [ ] TASK-002 Do more\n");
  writeFileSync(join(changeRoot, "design.md"), "# Design\n");
  writeFileSync(join(changeRoot, ".superspec", "artifacts", "discovery.md"), "# Discovery\n");
  writeFileSync(join(changeRoot, ".superspec", "artifacts", "business-invariants.md"), "# BI\n");
  writeFileSync(join(changeRoot, ".superspec", "artifacts", "test-contract.md"), "# TC\n");
  ensureChangeLayout(projectRoot, change);

  // seed 到 propose_ready
  for (const [t, f, to] of [["init","init","init"],["explore","init","explore"],["propose","explore","propose"],["propose-ready","propose","propose_ready"]] as const) {
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
  writeFileSync(join(changeRoot, ".superspec", "artifacts", "business-invariants.md"), "# BI\n");
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

function reviewerReport(role: "critic" | "architect" | "test-engineer" = "critic"): string {
  return JSON.stringify({
    role,
    verdict: "pass",
    findings: [],
    reviewer: { kind: "codex-subagent", id: "test-reviewer" },
  });
}

function rawDirFiles(projectRoot: string, change: string): string[] {
  return readdirSync(join(projectRoot, ".superspec", "changes", change, "raw")).sort();
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
    writeFileSync(reportPath, reviewerReport("critic"));
    const accepted = recordJobSubmit(fx.projectRoot, fx.change, fx.changeRoot, t1.created_jobs[0], reportPath);
    assert.equal(accepted.accepted, true);
    const t2 = proposeReady(fx.projectRoot, fx.change, fx.changeRoot, "normal");
    assert.equal(t2.to_state, "propose_ready");

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
    writeFileSync(reportPath, reviewerReport("critic"));
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
    assert.equal(JSON.parse(rawLines[0]).semantic_status, "expected_failure");
    assert.deepEqual(rawDirFiles(fx.projectRoot, fx.change), ["test-runs.jsonl"]);

    const event = readEvents(fx.projectRoot, fx.change).findLast(e => e.event_type === "test_run_recorded");
    assert.ok(event);
    assert.equal(event.payload.raw_kind, "test-runs");
    assert.equal(event.payload.raw_index, 0);
    assert.equal(event.payload.raw_digest, sha256Text(rawLines[0]));
  } finally { fx.cleanup(); }
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
  writeFileSync(join(changeRoot, ".superspec", "artifacts", "business-invariants.md"), "# BI\n");
  writeFileSync(join(changeRoot, ".superspec", "artifacts", "test-contract.md"), "# TC\n");
  ensureChangeLayout(projectRoot, change);
  for (const [t, f, to] of [["init","init","init"],["explore","init","explore"],["propose","explore","propose"],["propose-ready","propose","propose_ready"]] as const) {
    appendEvent(projectRoot, change, makeEvent(change, "transition_commit", {
      transition: t, from_state: f, to_state: to,
      outcome: "advanced", created_job_ids: [], reason: t,
    }, { transitionId: `T-${t}`, idempotencyKey: `${t}-key` }));
  }
  try {
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
  writeFileSync(join(changeRoot, ".superspec", "artifacts", "business-invariants.md"), "# BI\n");
  writeFileSync(join(changeRoot, ".superspec", "artifacts", "test-contract.md"), "# TC\n");
  ensureChangeLayout(projectRoot, change);
  for (const [t, f, to] of [["init","init","init"],["explore","init","explore"],["propose","explore","propose"],["propose-ready","propose","propose_ready"]] as const) {
    appendEvent(projectRoot, change, makeEvent(change, "transition_commit", {
      transition: t, from_state: f, to_state: to,
      outcome: "advanced", created_job_ids: [], reason: t,
    }, { transitionId: `T-${t}`, idempotencyKey: `${t}-key` }));
  }
  try {
    startApply(projectRoot, change, changeRoot);
    taskStart(projectRoot, change, changeRoot, "TASK-001");
    const result = taskComplete(projectRoot, change, changeRoot, "TASK-001");
    assert.equal(result.events_written, 2); // commit + task_completed
    const after = readFileSync(join(changeRoot, "tasks.md"), "utf8");
    assert.ok(after.match(/- \[x\].*TASK-001/), "TASK-001 应已勾选");
  } finally { rmSync(projectRoot, { recursive: true, force: true }); }
});
