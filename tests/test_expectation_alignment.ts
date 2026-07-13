import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { ensureChangeLayout, appendEvent, makeEvent, readEvents } from "../src/store.ts";
import { next } from "../src/next.ts";
import { jobsPacket, recordUserDecisionContent } from "../src/record.ts";
import { recordTestRunContent } from "../src/task.ts";
import { proposeReady, reviewReady, startApply, taskComplete, taskStart } from "../src/transition.ts";
import { pendingTaskStatusForApply } from "../src/phase_plan.ts";
import { diffFingerprints } from "../src/git_state.ts";
import { codeReviewPacketContext } from "../src/code_review.ts";
import { reviewEvidenceDigest } from "../src/review.ts";
import { validateExecutionRequirements, tasksStructureDigest } from "../src/format.ts";
import { sha256Text } from "../src/store.ts";
import type { Event } from "../src/types.ts";
import { confirmCurrentPhase } from "./phase_confirmation_support.ts";

function setupChange(tasks: string, testContract = "# Test Contract\n"): { projectRoot: string; change: string; changeRoot: string; cleanup: () => void } {
  const projectRoot = mkdtempSync(join(tmpdir(), "superspec-align-"));
  const change = "align-change";
  const changeRoot = join(projectRoot, "openspec", "changes", change);
  mkdirSync(join(changeRoot, ".superspec", "artifacts"), { recursive: true });
  writeFileSync(join(changeRoot, "proposal.md"), "# Proposal\n");
  writeFileSync(join(changeRoot, "design.md"), "# Design\n");
  writeFileSync(join(changeRoot, "tasks.md"), tasks);
  writeFileSync(join(changeRoot, ".superspec", "artifacts", "discovery.md"), "# Discovery\n");
  writeFileSync(join(changeRoot, ".superspec", "artifacts", "test-contract.md"), testContract);
  ensureChangeLayout(projectRoot, change);
  for (const [transition, from, to] of [
    ["init", "init", "init"],
    ["explore", "init", "explore"],
    ["propose", "explore", "propose"],
    ["propose-ready", "propose", "propose_ready"],
  ] as const) {
    appendEvent(projectRoot, change, makeEvent(change, "transition_commit", {
      transition,
      from_state: from,
      to_state: to,
      outcome: "advanced",
      created_job_ids: [],
      reason: transition,
    }, { transitionId: `T-${transition}`, idempotencyKey: `${transition}-key` }));
  }
  return {
    projectRoot,
    change,
    changeRoot,
    cleanup: () => rmSync(projectRoot, { recursive: true, force: true }),
  };
}

function setupProposeChange(tasks: string, testContract = "# Test Contract\n"): { projectRoot: string; change: string; changeRoot: string; cleanup: () => void } {
  const fx = setupChange(tasks, testContract);
  rmSync(join(fx.projectRoot, ".superspec", "changes", fx.change, "events.jsonl"), { force: true });
  ensureChangeLayout(fx.projectRoot, fx.change);
  for (const [transition, from, to] of [
    ["init", "init", "init"],
    ["explore", "init", "explore"],
    ["propose", "explore", "propose"],
  ] as const) {
    appendEvent(fx.projectRoot, fx.change, makeEvent(fx.change, "transition_commit", {
      transition,
      from_state: from,
      to_state: to,
      outcome: "advanced",
      created_job_ids: [],
      reason: transition,
    }, { transitionId: `T-propose-${transition}`, idempotencyKey: `propose-${transition}-key` }));
  }
  return fx;
}

function initGitRepo(projectRoot: string): void {
  execFileSync("git", ["init"], { cwd: projectRoot, stdio: "ignore" });
  execFileSync("git", ["config", "user.email", "test@example.com"], { cwd: projectRoot, stdio: "ignore" });
  execFileSync("git", ["config", "user.name", "Test User"], { cwd: projectRoot, stdio: "ignore" });
}

function startApplyConfirmed(projectRoot: string, change: string, changeRoot: string) {
  confirmCurrentPhase(projectRoot, change, changeRoot);
  return startApply(projectRoot, change, changeRoot);
}

test("推进校验：propose-ready 和 start-apply 都拒绝执行依据模式下缺执行依据的普通 TDD task", () => {
  const tasks = [
    "# Tasks",
    "",
    "- [ ] TASK-001 Has contract tdd_required:true",
    "  执行依据:",
    "  - 测试: test-contract.md#TEST-001",
    "  - 设计: design.md#Route",
    "  - 来源: proposal.md#Impact",
    "  - 原因: 独立验收行为",
    "  - 边界: 不改持久化",
    "- [ ] TASK-002 Missing contract tdd_required:true",
    "",
  ].join("\n");
  const testContract = [
    "# Test Contract",
    "",
    "| test_id | scenario |",
    "|---|---|",
    "| TEST-001 | behavior works |",
    "",
  ].join("\n");

  const proposeFx = setupProposeChange(tasks, testContract);
  try {
    const blocked = proposeReady(proposeFx.projectRoot, proposeFx.change, proposeFx.changeRoot, "minimal");
    assert.equal(blocked.events_written, 0);
    assert.match(blocked.message, /TASK-002 缺少执行依据/);
  } finally {
    proposeFx.cleanup();
  }

  const applyFx = setupChange(tasks, testContract);
  try {
    const blocked = startApply(applyFx.projectRoot, applyFx.change, applyFx.changeRoot);
    assert.equal(blocked.events_written, 0);
    assert.match(blocked.message, /TASK-002 缺少执行依据/);
  } finally {
    applyFx.cleanup();
  }
});

test("推进校验：普通 TDD 执行依据必须声明存在于 test-contract 的 TEST", () => {
  const missingTestField = [
    "# Tasks",
    "",
    "- [ ] TASK-001 Missing test field tdd_required:true",
    "  执行依据:",
    "  - 设计: design.md#Route",
    "  - 来源: proposal.md#Impact",
    "  - 原因: 独立验收行为",
    "  - 边界: 不改持久化",
    "",
  ].join("\n");
  const unknownTest = missingTestField.replace("  - 设计:", "  - 测试: test-contract.md#TEST-999\n  - 设计:");
  const testContract = [
    "# Test Contract",
    "",
    "| test_id | scenario |",
    "|---|---|",
    "| TEST-001 | behavior works |",
    "",
  ].join("\n");

  const missingFx = setupProposeChange(missingTestField, testContract);
  try {
    const blocked = proposeReady(missingFx.projectRoot, missingFx.change, missingFx.changeRoot, "minimal");
    assert.equal(blocked.events_written, 0);
    assert.match(blocked.message, /执行依据缺少测试/);
  } finally {
    missingFx.cleanup();
  }

  const unknownFx = setupChange(unknownTest, testContract);
  try {
    const blocked = startApply(unknownFx.projectRoot, unknownFx.change, unknownFx.changeRoot);
    assert.equal(blocked.events_written, 0);
    assert.match(blocked.message, /不存在的 TEST ID：TEST-999/);
  } finally {
    unknownFx.cleanup();
  }
});

test("执行依据模式：task-start 输出契约，test-run 不要求 task_structure_digest，tasks.md 编辑不使 attempt 失效", () => {
  const fx = setupChange([
    "# Tasks",
    "",
    "- [ ] TASK-001 Implement behavior tdd_required:true",
    "  执行依据:",
    "  - 测试: test-contract.md#TEST-001",
    "  - 设计: design.md#Route",
    "  - 来源: proposal.md#Impact",
    "  - 原因: 独立验收行为",
    "  - 边界: 不改持久化",
    "",
  ].join("\n"), [
    "# Test Contract",
    "",
    "| test_id | scenario |",
    "|---|---|",
    "| TEST-001 | behavior works |",
    "",
  ].join("\n"));
  try {
    const startedApply = startApplyConfirmed(fx.projectRoot, fx.change, fx.changeRoot);
    assert.equal(startedApply.to_state, "apply");
    const startCommit = readEvents(fx.projectRoot, fx.change).findLast(ev =>
      ev.event_type === "transition_commit" && (ev.payload as { transition?: unknown }).transition === "start-apply"
    );
    assert.equal((startCommit?.payload as { apply_contract_mode?: unknown }).apply_contract_mode, true);

    const started = taskStart(fx.projectRoot, fx.change, fx.changeRoot, "TASK-001");
    assert.deepEqual(started.details?.contract, {
      tests: ["TEST-001"],
      design: "design.md#Route",
      source: ["proposal.md#Impact"],
      reason: "独立验收行为",
      guard: "不改持久化",
    });
    const attemptId = started.details?.attempt_id;
    assert.equal(typeof attemptId, "string");

    assert.equal(recordTestRunContent(fx.projectRoot, fx.change, JSON.stringify({
      test_id: "TEST-001",
      task_structure_digest: "sha256:legacy",
      command: "npm test",
      cwd: fx.projectRoot,
      exit_code: 1,
      semantic_status: "expected_failure",
    })).accepted, false);
    assert.equal(recordTestRunContent(fx.projectRoot, fx.change, JSON.stringify({
      test_id: "TEST-001",
      attempt_id: "ATT-missing",
      task_structure_digest: "sha256:legacy",
      command: "npm test",
      cwd: fx.projectRoot,
      exit_code: 1,
      semantic_status: "expected_failure",
    })).accepted, false);

    assert.equal(recordTestRunContent(fx.projectRoot, fx.change, JSON.stringify({
      test_id: "TEST-001",
      attempt_id: attemptId,
      command: "npm test",
      cwd: fx.projectRoot,
      exit_code: 1,
      semantic_status: "expected_failure",
    })).accepted, true);
    assert.equal(recordTestRunContent(fx.projectRoot, fx.change, JSON.stringify({
      test_id: "TEST-001",
      attempt_id: attemptId,
      command: "npm test",
      cwd: fx.projectRoot,
      exit_code: 0,
      semantic_status: "expected_success",
    })).accepted, true);

    writeFileSync(join(fx.changeRoot, "tasks.md"), readFileSync(join(fx.changeRoot, "tasks.md"), "utf8").replace("Implement behavior", "Implement behavior with edited wording"));
    const completed = taskComplete(fx.projectRoot, fx.change, fx.changeRoot, "TASK-001");
    assert.equal(completed.outcome, "advanced");
    assert.equal(completed.events_written, 2);

    const eventCountAfterComplete = readEvents(fx.projectRoot, fx.change).length;
    const lateEvidence = recordTestRunContent(fx.projectRoot, fx.change, JSON.stringify({
      test_id: "TEST-001",
      attempt_id: attemptId,
      task_structure_digest: "sha256:legacy",
      command: "npm test",
      cwd: fx.projectRoot,
      exit_code: 0,
      semantic_status: "expected_success",
    }));
    assert.equal(lateEvidence.accepted, false);
    assert.match(lateEvidence.message, /当前活跃任务尝试/);
    assert.equal(readEvents(fx.projectRoot, fx.change).length, eventCountAfterComplete);
  } finally {
    fx.cleanup();
  }
});

test("执行依据模式：同一 apply 轮后续活跃 attempt 不会被较早完成记录遮蔽", () => {
  const fx = setupChange([
    "# Tasks",
    "",
    "- [x] TASK-001 Implement behavior tdd_required:true",
    "  执行依据:",
    "  - 测试: test-contract.md#TEST-001",
    "  - 设计: design.md#Route",
    "  - 来源: proposal.md#Impact",
    "  - 原因: 独立验收行为",
    "  - 边界: 不改持久化",
    "",
  ].join("\n"), [
    "# Test Contract",
    "",
    "| test_id | scenario |",
    "|---|---|",
    "| TEST-001 | behavior works |",
    "",
  ].join("\n"));
  try {
    assert.equal(startApplyConfirmed(fx.projectRoot, fx.change, fx.changeRoot).to_state, "apply");
    appendEvent(fx.projectRoot, fx.change, makeEvent(fx.change, "task_started", {
      task_id: "TASK-001",
      attempt_id: "ATT-old",
      task_structure_digest: "sha256:old",
      contract_mode: true,
    }));
    appendEvent(fx.projectRoot, fx.change, makeEvent(fx.change, "task_completed", {
      task_id: "TASK-001",
      attempt_id: "ATT-old",
    }));
    appendEvent(fx.projectRoot, fx.change, makeEvent(fx.change, "task_started", {
      task_id: "TASK-001",
      attempt_id: "ATT-new",
      task_structure_digest: "sha256:new",
      contract_mode: true,
    }));

    const status = pendingTaskStatusForApply(fx.changeRoot, readEvents(fx.projectRoot, fx.change));
    assert.equal(status.mode, "contract");
    assert.deepEqual(status.pending, ["TASK-001"]);
    assert.deepEqual(status.needsCompletionEvent, ["TASK-001"]);
    assert.deepEqual(status.completedByEvent, []);

    const blocked = reviewReady(fx.projectRoot, fx.change, fx.changeRoot);
    assert.equal(blocked.to_state, "apply");
    assert.match(blocked.message, /TASK-001/);
  } finally {
    fx.cleanup();
  }
});

test("历史 start-apply 缺 apply_start_head 时只审当前工作区，不把 HEAD 全树当 committed diff", () => {
  const fx = setupChange("# Tasks\n\n- [x] TASK-001 Done\n");
  try {
    initGitRepo(fx.projectRoot);
    mkdirSync(join(fx.projectRoot, "src"), { recursive: true });
    writeFileSync(join(fx.projectRoot, "src", "existing.ts"), "export const existing = 1;\n");
    execFileSync("git", ["add", "."], { cwd: fx.projectRoot, stdio: "ignore" });
    execFileSync("git", ["commit", "-m", "initial"], { cwd: fx.projectRoot, stdio: "ignore" });

    appendEvent(fx.projectRoot, fx.change, makeEvent(fx.change, "transition_commit", {
      transition: "start-apply",
      from_state: "propose_ready",
      to_state: "apply",
      outcome: "advanced",
      created_job_ids: [],
      reason: "legacy start apply",
    }, { transitionId: "T-legacy-start-apply", idempotencyKey: "legacy-start-apply" }));

    assert.equal(reviewReady(fx.projectRoot, fx.change, fx.changeRoot).to_state, "apply_done");
    confirmCurrentPhase(fx.projectRoot, fx.change, fx.changeRoot);
    const skipped = reviewReady(fx.projectRoot, fx.change, fx.changeRoot);
    assert.equal(skipped.outcome, "advanced");
    assert.equal(skipped.to_state, "review");
    const gate = (readEvents(fx.projectRoot, fx.change).findLast(ev =>
      ev.event_type === "transition_commit" && (ev.payload as { transition?: unknown }).transition === "review-ready"
    )?.payload as { code_review_gate?: { decision?: unknown } }).code_review_gate;
    assert.equal(gate?.decision, "skipped");
  } finally {
    fx.cleanup();
  }
});

test("boundary_snapshot：仓库尚无 commit 时保留 dirty_files 归属线索", () => {
  const fx = setupChange("# Tasks\n\n- [ ] TASK-001 Docs tdd_required:false no_tdd_reason:documentation-only\n");
  try {
    initGitRepo(fx.projectRoot);
    mkdirSync(join(fx.projectRoot, "src"), { recursive: true });
    writeFileSync(join(fx.projectRoot, "src", "a.ts"), "export const value = 1;\n");

    assert.equal(startApplyConfirmed(fx.projectRoot, fx.change, fx.changeRoot).to_state, "apply");
    assert.equal(taskStart(fx.projectRoot, fx.change, fx.changeRoot, "TASK-001").outcome, "advanced");
    const startedEvent = readEvents(fx.projectRoot, fx.change).findLast(ev => ev.event_type === "task_started");
    const boundary = (startedEvent?.payload as { boundary_snapshot?: unknown }).boundary_snapshot as {
      head?: unknown;
      head_reason?: unknown;
      dirty_files?: Array<{ path: string; status: string; sha256: string | null }>;
    };
    assert.equal(boundary.head, null);
    assert.equal(typeof boundary.head_reason, "string");
    assert.ok(boundary.dirty_files?.some(file => file.path === "src/a.ts" && file.status === "added"));
  } finally {
    fx.cleanup();
  }
});

test("执行依据模式：checkbox 已勾选但缺 task_completed 时 next 引导补 task-complete", () => {
  const fx = setupChange([
    "# Tasks",
    "",
    "- [ ] TASK-001 Documentation tdd_required:false no_tdd_reason:documentation-only",
    "  执行依据:",
    "  - 设计: design.md#Docs",
    "  - 来源: proposal.md#Docs",
    "  - 原因: 文档任务",
    "  - 边界: 不改代码",
    "",
  ].join("\n"));
  try {
    startApplyConfirmed(fx.projectRoot, fx.change, fx.changeRoot);
    const started = taskStart(fx.projectRoot, fx.change, fx.changeRoot, "TASK-001");
    assert.equal(started.outcome, "advanced");
    writeFileSync(join(fx.changeRoot, "tasks.md"), readFileSync(join(fx.changeRoot, "tasks.md"), "utf8").replace("- [ ] TASK-001", "- [x] TASK-001"));

    const planned = next(fx.projectRoot, fx.change, fx.changeRoot);
    assert.equal(planned.path, "next_command");
    assert.equal(planned.next_command, 'superspec transition task-complete --change "align-change" --task TASK-001');

    const completed = taskComplete(fx.projectRoot, fx.change, fx.changeRoot, "TASK-001");
    assert.equal(completed.outcome, "advanced");
    const event = readEvents(fx.projectRoot, fx.change).findLast(ev => ev.event_type === "task_completed");
    assert.deepEqual((event?.payload as { checkbox_update?: unknown }).checkbox_update, { status: "applied" });
  } finally {
    fx.cleanup();
  }
});

test("执行依据模式：task_completed 事件优先于 checkbox，已完成 task 不会重复启动", () => {
  const fx = setupChange([
    "# Tasks",
    "",
    "- [ ] TASK-001 Documentation tdd_required:false no_tdd_reason:documentation-only",
    "  执行依据:",
    "  - 设计: design.md#Docs",
    "  - 来源: proposal.md#Docs",
    "  - 原因: 文档任务",
    "  - 边界: 不改代码",
    "",
  ].join("\n"));
  try {
    startApplyConfirmed(fx.projectRoot, fx.change, fx.changeRoot);
    const started = taskStart(fx.projectRoot, fx.change, fx.changeRoot, "TASK-001");
    assert.equal(started.outcome, "advanced");

    const completed = taskComplete(fx.projectRoot, fx.change, fx.changeRoot, "TASK-001");
    assert.equal(completed.outcome, "advanced");
    writeFileSync(join(fx.changeRoot, "tasks.md"), readFileSync(join(fx.changeRoot, "tasks.md"), "utf8").replace("- [x] TASK-001", "- [ ] TASK-001"));

    const restart = taskStart(fx.projectRoot, fx.change, fx.changeRoot, "TASK-001");
    assert.equal(restart.events_written, 0);
    assert.match(restart.message, /已通过完成事件完成/);
  } finally {
    fx.cleanup();
  }
});

test("review-ready：apply 期间只有已提交代码变化且工作区干净时仍创建 code-reviewer", () => {
  const fx = setupChange("# Tasks\n\n- [x] TASK-001 Done\n");
  try {
    initGitRepo(fx.projectRoot);
    mkdirSync(join(fx.projectRoot, "src"), { recursive: true });
    writeFileSync(join(fx.projectRoot, "src", "a.ts"), "export const value = 1;\n");
    execFileSync("git", ["add", "."], { cwd: fx.projectRoot, stdio: "ignore" });
    execFileSync("git", ["commit", "-m", "initial"], { cwd: fx.projectRoot, stdio: "ignore" });

    startApplyConfirmed(fx.projectRoot, fx.change, fx.changeRoot);
    writeFileSync(join(fx.projectRoot, "src", "a.ts"), "export const value = 2;\n");
    execFileSync("git", ["add", "src/a.ts"], { cwd: fx.projectRoot, stdio: "ignore" });
    execFileSync("git", ["commit", "-m", "apply code"], { cwd: fx.projectRoot, stdio: "ignore" });

    assert.equal(reviewReady(fx.projectRoot, fx.change, fx.changeRoot).to_state, "apply_done");
    const created = reviewReady(fx.projectRoot, fx.change, fx.changeRoot);
    assert.equal(created.outcome, "job_created");
    const packet = jobsPacket(fx.projectRoot, fx.change, created.created_jobs[0]);
    assert.deepEqual(packet.packet?.code_review_scope?.committed_paths, ["src/a.ts"]);
    assert.deepEqual(packet.packet?.code_review_scope?.worktree_paths, []);
    assert.deepEqual(packet.packet?.code_review_scope?.untracked_paths, []);
  } finally {
    fx.cleanup();
  }
});

test("code-reviewer packet：按 task 展示 changed_paths、test_evidence 和 coverage exemption", () => {
  const fx = setupChange([
    "# Tasks",
    "",
    "- [ ] TASK-001 Implement behavior tdd_required:true",
    "  执行依据:",
    "  - 测试: test-contract.md#TEST-001",
    "  - 设计: design.md#Route",
    "  - 来源: proposal.md#Impact",
    "  - 原因: 独立验收行为",
    "  - 边界: 不改持久化",
    "",
  ].join("\n"), [
    "# Test Contract",
    "",
    "| test_id | scenario |",
    "|---|---|",
    "| TEST-001 | behavior works |",
    "| TEST-002 | separate path is intentionally covered elsewhere |",
    "",
  ].join("\n"));
  try {
    initGitRepo(fx.projectRoot);
    execFileSync("git", ["add", "."], { cwd: fx.projectRoot, stdio: "ignore" });
    execFileSync("git", ["commit", "-m", "initial"], { cwd: fx.projectRoot, stdio: "ignore" });

    startApplyConfirmed(fx.projectRoot, fx.change, fx.changeRoot);
    const started = taskStart(fx.projectRoot, fx.change, fx.changeRoot, "TASK-001");
    const attemptId = String(started.details?.attempt_id);
    mkdirSync(join(fx.projectRoot, "src"), { recursive: true });
    writeFileSync(join(fx.projectRoot, "src", "a.ts"), "export const value = 1;\n");
    assert.equal(recordTestRunContent(fx.projectRoot, fx.change, JSON.stringify({
      test_id: "TEST-001",
      attempt_id: attemptId,
      command: "npm test",
      cwd: fx.projectRoot,
      exit_code: 1,
      semantic_status: "expected_failure",
    })).accepted, true);
    assert.equal(recordTestRunContent(fx.projectRoot, fx.change, JSON.stringify({
      test_id: "TEST-001",
      attempt_id: attemptId,
      command: "npm test",
      cwd: fx.projectRoot,
      exit_code: 0,
      semantic_status: "expected_success",
    })).accepted, true);
    assert.equal(taskComplete(fx.projectRoot, fx.change, fx.changeRoot, "TASK-001").outcome, "advanced");

    const blocked = reviewReady(fx.projectRoot, fx.change, fx.changeRoot);
    assert.match(blocked.message, /TEST-002/);
    assert.equal(blocked.events_written, 0);

    assert.equal(recordUserDecisionContent(fx.projectRoot, fx.change, JSON.stringify({
      scope: "test_coverage_exemption:TEST-002",
      question: "TEST-002 为什么不绑定 task？",
      answer: "TEST-001 覆盖同一验收路径，本 change 不单独实现",
    })).accepted, true);

    assert.equal(reviewReady(fx.projectRoot, fx.change, fx.changeRoot).to_state, "apply_done");
    const created = reviewReady(fx.projectRoot, fx.change, fx.changeRoot);
    assert.equal(created.outcome, "job_created");
    const packet = jobsPacket(fx.projectRoot, fx.change, created.created_jobs[0]).packet;
    assert.deepEqual(packet?.coverage_exemption_refs?.map(ref => ref.test_id), ["TEST-002"]);
    assert.deepEqual(packet?.unattributed_paths, []);
    assert.deepEqual(packet?.unknown_attribution_tasks, []);
    assert.equal(packet?.task_execution_index?.length, 1);
    assert.deepEqual(packet?.task_execution_index?.[0].changed_paths, ["src/a.ts"]);
    assert.equal(packet?.task_execution_index?.[0].test_evidence.length, 1);
    assert.equal(packet?.task_execution_index?.[0].test_evidence[0].test_id, "TEST-001");
    assert.equal(typeof packet?.task_execution_index?.[0].test_evidence[0].red_event_ref, "string");
    assert.equal(typeof packet?.task_execution_index?.[0].test_evidence[0].green_event_ref, "string");
  } finally {
    fx.cleanup();
  }
});

test("执行依据模式：task-start 拒绝 apply 期间被改坏的执行依据", () => {
  const fx = setupChange([
    "# Tasks",
    "",
    "- [ ] TASK-001 Implement behavior tdd_required:true",
    "  执行依据:",
    "  - 测试: test-contract.md#TEST-001",
    "  - 设计: design.md#Route",
    "  - 来源: proposal.md#Impact",
    "  - 原因: 独立验收行为",
    "  - 边界: 不改持久化",
    "",
  ].join("\n"), [
    "# Test Contract",
    "",
    "| test_id | scenario |",
    "|---|---|",
    "| TEST-001 | behavior works |",
    "",
  ].join("\n"));
  try {
    assert.equal(startApplyConfirmed(fx.projectRoot, fx.change, fx.changeRoot).to_state, "apply");
    writeFileSync(join(fx.changeRoot, "tasks.md"), [
      "# Tasks",
      "",
      "- [ ] TASK-001 Implement behavior tdd_required:true",
      "  执行依据:",
      "  - 测试: test-contract.md#TEST-001",
      "  - 测试: test-contract.md#TEST-999",
      "  - 设计: design.md#Route",
      "  - 来源: proposal.md#Impact",
      "  - 原因: 独立验收行为",
      "  - 边界: 不改持久化",
      "",
    ].join("\n"));
    const started = taskStart(fx.projectRoot, fx.change, fx.changeRoot, "TASK-001");
    assert.equal(started.events_written, 0);
    assert.match(started.message, /字段重复|不存在的 TEST/);
  } finally {
    fx.cleanup();
  }
});

test("执行依据模式：REVIEW-FIX task 没有执行依据时仍要求回归 RED/GREEN 证据", () => {
  const fx = setupChange([
    "# Tasks",
    "",
    "- [x] TASK-001 Existing task tdd_required:true",
    "  执行依据:",
    "  - 测试: test-contract.md#TEST-001",
    "  - 设计: design.md#Route",
    "  - 来源: proposal.md#Impact",
    "  - 原因: 已完成任务",
    "  - 边界: 不改持久化",
    "",
    "- [ ] REVIEW-FIX-JOB-1#F1 Fix review issue tdd_required:true review_fix_of:JOB-1#F1",
    "",
  ].join("\n"), [
    "# Test Contract",
    "",
    "| test_id | scenario |",
    "|---|---|",
    "| TEST-001 | behavior works |",
    "",
  ].join("\n"));
  try {
    assert.equal(startApplyConfirmed(fx.projectRoot, fx.change, fx.changeRoot).to_state, "apply");
    const started = taskStart(fx.projectRoot, fx.change, fx.changeRoot, "REVIEW-FIX-JOB-1#F1");
    const attemptId = String(started.details?.attempt_id);
    const blocked = taskComplete(fx.projectRoot, fx.change, fx.changeRoot, "REVIEW-FIX-JOB-1#F1");
    assert.match(blocked.message, /RED 证据/);

    assert.equal(recordTestRunContent(fx.projectRoot, fx.change, JSON.stringify({
      test_id: "TEST-REPAIR",
      attempt_id: attemptId,
      command: "npm test -- review-fix",
      cwd: fx.projectRoot,
      exit_code: 1,
      semantic_status: "expected_failure",
    })).accepted, true);
    assert.equal(recordTestRunContent(fx.projectRoot, fx.change, JSON.stringify({
      test_id: "TEST-REPAIR",
      attempt_id: attemptId,
      command: "npm test -- review-fix",
      cwd: fx.projectRoot,
      exit_code: 0,
      semantic_status: "expected_success",
    })).accepted, true);
    assert.equal(taskComplete(fx.projectRoot, fx.change, fx.changeRoot, "REVIEW-FIX-JOB-1#F1").outcome, "advanced");
  } finally {
    fx.cleanup();
  }
});

test("指纹原语：diffFingerprints 按 path/status/sha256 对比并按路径字典序输出", () => {
  const left = [
    { path: "src/b.ts", status: "modified" as const, sha256: "sha256:1" },
    { path: "src/a.ts", status: "modified" as const, sha256: "sha256:2" },
    { path: "src/gone.ts", status: "modified" as const, sha256: "sha256:3" },
    { path: "src/same.ts", status: "added" as const, sha256: "sha256:4" },
  ];
  const right = [
    { path: "src/a.ts", status: "modified" as const, sha256: "sha256:2" },
    { path: "src/b.ts", status: "modified" as const, sha256: "sha256:changed" },
    { path: "src/new.ts", status: "added" as const, sha256: "sha256:5" },
    { path: "src/same.ts", status: "deleted" as const, sha256: null },
  ];
  // b.ts 内容变化、gone.ts 消失、new.ts 新增、same.ts status 变化；a.ts 完全一致不算变化
  assert.deepEqual(diffFingerprints(left, right), ["src/b.ts", "src/gone.ts", "src/new.ts", "src/same.ts"]);
  assert.deepEqual(diffFingerprints(left, left), []);
});

function makeAttemptWindowEvents(change: string, startHead: string | null, completeHead: string | null): Event[] {
  return [
    makeEvent(change, "task_started", {
      task_id: "TASK-001",
      attempt_id: "ATT-1",
      contract: { tests: [], design: null, source: [], reason: null, guard: null },
      boundary_snapshot: {
        head: startHead,
        dirty_files: [{ path: "src/dirty.ts", status: "modified", sha256: "sha256:before" }],
      },
    }, { transitionId: "T-ts", idempotencyKey: "ts-key" }),
    makeEvent(change, "task_completed", {
      task_id: "TASK-001",
      attempt_id: "ATT-1",
      boundary_snapshot: {
        head: completeHead,
        dirty_files: [{ path: "src/dirty.ts", status: "modified", sha256: "sha256:after" }],
      },
    }, { transitionId: "T-tc", idempotencyKey: "tc-key" }),
  ] as Event[];
}

test("changed_paths：committed 段 diff 失败时保留 dirty 对比结果并进入 unknown_attribution_tasks", () => {
  const fx = setupChange("# Tasks\n\n- [ ] TASK-001 Implement tdd_required:true\n");
  try {
    initGitRepo(fx.projectRoot);
    writeFileSync(join(fx.projectRoot, "keep.ts"), "export const keep = 1;\n");
    execFileSync("git", ["add", "."], { cwd: fx.projectRoot, stdio: "ignore" });
    execFileSync("git", ["commit", "-m", "initial"], { cwd: fx.projectRoot, stdio: "ignore" });

    // 两端 head 为不存在的 commit，git diff 必然失败
    const events = makeAttemptWindowEvents(fx.change, "0".repeat(40), "1".repeat(40));
    const scope = {
      base_head: null,
      current_head: null,
      scope_reliable: true,
      scope_reason: "ok",
      committed_paths: [],
      worktree_paths: ["src/dirty.ts", "src/other.ts"],
      untracked_paths: [],
      review_paths: ["src/dirty.ts", "src/other.ts"],
    };
    const context = codeReviewPacketContext(fx.changeRoot, fx.projectRoot, scope, events);
    const entry = context.task_execution_index?.[0];
    // dirty 侧的确定事实保留，不因 diff 失败整项置 null
    assert.deepEqual(entry?.changed_paths, ["src/dirty.ts"]);
    assert.match(String(entry?.changed_paths_partial_reason), /git diff/);
    // 归属不完整的 task 进入 unknown_attribution_tasks，dirty 侧归属仍然生效
    assert.deepEqual(context.unknown_attribution_tasks, ["TASK-001"]);
    assert.deepEqual(context.unattributed_paths, ["src/other.ts"]);
  } finally {
    fx.cleanup();
  }
});

test("changed_paths：committed 段 diff 只收代码文件，非代码文件不进入归属", () => {
  const fx = setupChange("# Tasks\n\n- [ ] TASK-001 Implement tdd_required:true\n");
  try {
    initGitRepo(fx.projectRoot);
    writeFileSync(join(fx.projectRoot, "code.ts"), "export const v = 1;\n");
    writeFileSync(join(fx.projectRoot, "notes.md"), "# before\n");
    execFileSync("git", ["add", "."], { cwd: fx.projectRoot, stdio: "ignore" });
    execFileSync("git", ["commit", "-m", "start"], { cwd: fx.projectRoot, stdio: "ignore" });
    const startHead = execFileSync("git", ["rev-parse", "HEAD"], { cwd: fx.projectRoot, encoding: "utf8" }).trim();

    writeFileSync(join(fx.projectRoot, "code.ts"), "export const v = 2;\n");
    writeFileSync(join(fx.projectRoot, "notes.md"), "# after\n");
    execFileSync("git", ["add", "."], { cwd: fx.projectRoot, stdio: "ignore" });
    execFileSync("git", ["commit", "-m", "complete"], { cwd: fx.projectRoot, stdio: "ignore" });
    const completeHead = execFileSync("git", ["rev-parse", "HEAD"], { cwd: fx.projectRoot, encoding: "utf8" }).trim();

    const events = makeAttemptWindowEvents(fx.change, startHead, completeHead);
    const scope = {
      base_head: startHead,
      current_head: completeHead,
      scope_reliable: true,
      scope_reason: "ok",
      committed_paths: ["code.ts"],
      worktree_paths: ["src/dirty.ts"],
      untracked_paths: [],
      review_paths: ["code.ts", "src/dirty.ts"],
    };
    const context = codeReviewPacketContext(fx.changeRoot, fx.projectRoot, scope, events);
    const entry = context.task_execution_index?.[0];
    // notes.md 是过程文档，不进入 changed_paths；dirty 与 committed 取并集
    assert.deepEqual(entry?.changed_paths, ["code.ts", "src/dirty.ts"]);
    assert.equal(entry?.changed_paths_partial_reason, undefined);
    assert.deepEqual(context.unknown_attribution_tasks, []);
  } finally {
    fx.cleanup();
  }
});

test("review_evidence_digest：排序稳定（事件顺序无关）且对证据内容敏感", () => {
  const change = "digest-change";
  const base = (semantic: string, eventKey: string) => makeEvent(change, "test_run_recorded", {
    test_id: "TEST-001",
    attempt_id: "ATT-1",
    semantic_status: semantic,
    exit_code: semantic === "expected_failure" ? 1 : 0,
    command: "npm test",
    cwd: "/tmp",
  }, { transitionId: `T-${eventKey}`, idempotencyKey: eventKey }) as Event;
  const completedEvent = makeEvent(change, "task_completed", {
    task_id: "TASK-001",
    attempt_id: "ATT-1",
  }, { transitionId: "T-done", idempotencyKey: "done" }) as Event;
  const startedEvent = makeEvent(change, "task_started", {
    task_id: "TASK-001",
    attempt_id: "ATT-1",
  }, { transitionId: "T-start", idempotencyKey: "start" }) as Event;

  const red = base("expected_failure", "red");
  const green = base("expected_success", "green");
  const forward = reviewEvidenceDigest([startedEvent, red, green, completedEvent]);
  const shuffled = reviewEvidenceDigest([completedEvent, green, startedEvent, red]);
  assert.equal(forward, shuffled);

  // 改变证据语义应改变 digest
  const mutated = reviewEvidenceDigest([startedEvent, red, base("characterization_pass", "green"), completedEvent]);
  assert.notEqual(forward, mutated);
});

const CONTRACT_BLOCK_TAIL = [
  "  - 测试: test-contract.md#TEST-001",
  "  - 设计: design.md#Route",
  "  - 来源: proposal.md#Impact",
  "  - 原因: 独立验收行为",
  "  - 边界: 不改持久化",
  "",
].join("\n");

const TEST_CONTRACT_TABLE = [
  "# Test Contract",
  "",
  "| test_id | scenario |",
  "|---|---|",
  "| TEST-001 | behavior works |",
  "",
].join("\n");

function contractTasksWithHeader(opts: { beforeHeader?: string; blankLineBeforeHeader?: boolean } = {}): string {
  const middle: string[] = [];
  if (opts.blankLineBeforeHeader) middle.push("");
  if (opts.beforeHeader) middle.push(opts.beforeHeader);
  middle.push("  执行依据:");
  return [
    "# Tasks",
    "",
    "- [ ] TASK-001 Implement behavior tdd_required:true",
    ...middle,
    CONTRACT_BLOCK_TAIL,
  ].join("\n");
}

function appendLegacyStartApply(projectRoot: string, change: string): void {
  appendEvent(projectRoot, change, makeEvent(change, "transition_commit", {
    transition: "start-apply",
    from_state: "propose_ready",
    to_state: "apply",
    outcome: "advanced",
    created_job_ids: [],
    reason: "legacy apply without contract mode",
    apply_start_head: null,
    apply_start_head_reason: "no git",
  }, { transitionId: "T-legacy-start-apply", idempotencyKey: "legacy-start-apply-key" }));
}

test("执行依据绑定：task 与块头之间允许一个空行，仍进入契约模式", () => {
  const tasks = contractTasksWithHeader({ blankLineBeforeHeader: true });
  const validation = validateExecutionRequirements(tasks, TEST_CONTRACT_TABLE);
  assert.equal(validation.mode, true);
  assert.equal(validation.ok, true);
  assert.equal(validation.errors.length, 0);

  const fx = setupProposeChange(tasks, TEST_CONTRACT_TABLE);
  try {
    const ready = proposeReady(fx.projectRoot, fx.change, fx.changeRoot, "minimal");
    assert.equal(ready.to_state, "propose_ready");
    assert.equal(ready.events_written, 1);
  } finally {
    fx.cleanup();
  }
});

test("执行依据绑定：块头与 task 之间夹说明文字时阻断（孤儿块）", () => {
  const tasks = contractTasksWithHeader({ beforeHeader: "  先写一段说明，再挂执行依据" });
  const validation = validateExecutionRequirements(tasks, TEST_CONTRACT_TABLE);
  assert.equal(validation.ok, false);
  assert.match(validation.errors.join("；"), /没有绑定到任何 task/);

  const fx = setupProposeChange(tasks, TEST_CONTRACT_TABLE);
  try {
    const blocked = proposeReady(fx.projectRoot, fx.change, fx.changeRoot, "minimal");
    assert.equal(blocked.events_written, 0);
    assert.match(blocked.message, /没有绑定到任何 task/);
  } finally {
    fx.cleanup();
  }
});

test("执行依据绑定：全角冒号块头可被识别", () => {
  const tasks = [
    "# Tasks",
    "",
    "- [ ] TASK-001 Implement behavior tdd_required:true",
    "  执行依据：",
    CONTRACT_BLOCK_TAIL,
  ].join("\n");
  const validation = validateExecutionRequirements(tasks, TEST_CONTRACT_TABLE);
  assert.equal(validation.mode, true);
  assert.equal(validation.ok, true);
});

test("历史 apply 轮：tasks 带执行依据文本但 contract_mode 为 false 时 task-start 不输出契约", () => {
  const tasks = contractTasksWithHeader();
  const fx = setupChange(tasks, TEST_CONTRACT_TABLE);
  try {
    appendLegacyStartApply(fx.projectRoot, fx.change);
    const started = taskStart(fx.projectRoot, fx.change, fx.changeRoot, "TASK-001");
    assert.equal(started.details?.contract, null);
    assert.equal(started.details?.legacy_contract, true);

    const structureDigest = tasksStructureDigest(readFileSync(join(fx.changeRoot, "tasks.md"), "utf8"), sha256Text);
    const attemptId = started.details?.attempt_id;
    assert.equal(typeof attemptId, "string");

    assert.equal(recordTestRunContent(fx.projectRoot, fx.change, JSON.stringify({
      test_id: "TEST-001",
      attempt_id: attemptId,
      command: "npm test",
      cwd: fx.projectRoot,
      exit_code: 1,
      semantic_status: "expected_failure",
    })).accepted, false);

    assert.equal(recordTestRunContent(fx.projectRoot, fx.change, JSON.stringify({
      test_id: "TEST-001",
      task_structure_digest: structureDigest,
      command: "npm test",
      cwd: fx.projectRoot,
      exit_code: 1,
      semantic_status: "expected_failure",
    })).accepted, true);
  } finally {
    fx.cleanup();
  }
});

test("task_execution_index：历史 attempt 带 contract 字段但 contract_mode 为 false 时不展示契约", () => {
  const fx = setupChange("# Tasks\n\n- [ ] TASK-001 Implement tdd_required:true\n");
  try {
    const events = [
      makeEvent(fx.change, "task_started", {
        task_id: "TASK-001",
        attempt_id: "ATT-legacy",
        contract_mode: false,
        contract: {
          tests: ["TEST-001"],
          design: "design.md#Route",
          source: ["proposal.md#Impact"],
          reason: "历史脏数据",
          guard: "边界",
        },
        boundary_snapshot: { head: null, dirty_files: [] },
      }, { transitionId: "T-legacy-ts", idempotencyKey: "legacy-ts" }),
      makeEvent(fx.change, "task_completed", {
        task_id: "TASK-001",
        attempt_id: "ATT-legacy",
        boundary_snapshot: { head: null, dirty_files: [] },
      }, { transitionId: "T-legacy-tc", idempotencyKey: "legacy-tc" }),
    ] as Event[];
    const scope = {
      base_head: null,
      current_head: null,
      scope_reliable: true,
      scope_reason: "ok",
      committed_paths: [] as string[],
      worktree_paths: [] as string[],
      untracked_paths: [] as string[],
      review_paths: [] as string[],
    };
    const context = codeReviewPacketContext(fx.changeRoot, fx.projectRoot, scope, events);
    const entry = context.task_execution_index?.[0];
    assert.equal(entry?.contract, null);
    assert.deepEqual(entry?.declared_tests, []);
  } finally {
    fx.cleanup();
  }
});
