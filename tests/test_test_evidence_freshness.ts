import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { appendEvent, ensureChangeLayout, makeEvent, readEvents } from "../src/store.ts";
import { next } from "../src/next.ts";
import { jobsPacket, recordJobSubmitContent } from "../src/record.ts";
import { recordTestRunContent } from "../src/task.ts";
import { accept, reviewReady, taskComplete, taskStart } from "../src/transition.ts";
import { applyPlanningBaseline } from "../src/phase_plan.ts";
import type { NextCommandOutput } from "../src/types.ts";
import { confirmCurrentPhase, useTestWorkflowMode } from "./phase_confirmation_support.ts";

interface Fixture {
  projectRoot: string;
  change: string;
  changeRoot: string;
  cleanup: () => void;
}

function git(projectRoot: string, args: string[]): void {
  execFileSync("git", args, { cwd: projectRoot, stdio: "ignore" });
}

function taskBlock(taskId: string, title: string, testId: string): string[] {
  return [
    `- [ ] ${taskId} ${title} tdd_required:true`,
    "  执行依据:",
    `  - 测试: test-contract.md#${testId}`,
    "  - 设计: design.md#Calc",
    "  - 来源: proposal.md#Impact",
    `  - 验收: ${title}`,
    "  - 边界: 不改其他模块",
    "",
  ];
}

function setupApply(): Fixture {
  const projectRoot = mkdtempSync(join(tmpdir(), "superspec-freshness-"));
  const change = "freshness-change";
  const changeRoot = join(projectRoot, "openspec", "changes", change);
  mkdirSync(join(changeRoot, ".superspec", "artifacts"), { recursive: true });
  mkdirSync(join(projectRoot, "src"), { recursive: true });
  writeFileSync(join(projectRoot, "src", "calc.ts"), "export const version = 0;\n");
  writeFileSync(join(changeRoot, "proposal.md"), "# Proposal\n\n## Impact\n\n计算器\n");
  writeFileSync(join(changeRoot, "design.md"), "# Design\n\n## Calc\n\n加减法\n\n## 结构变更清单\n\n无\n");
  writeFileSync(join(changeRoot, "tasks.md"), [
    "# Tasks",
    "",
    ...taskBlock("TASK-001", "实现加法", "TEST-001"),
    ...taskBlock("TASK-002", "实现减法", "TEST-002"),
  ].join("\n"));
  writeFileSync(join(changeRoot, ".superspec", "artifacts", "discovery.md"), "# Discovery\n");
  writeFileSync(join(changeRoot, ".superspec", "artifacts", "test-contract.md"), [
    "# Test Contract",
    "",
    "| test_id | scenario |",
    "|---|---|",
    "| TEST-001 | 加法正确 |",
    "| TEST-002 | 减法正确 |",
    "",
  ].join("\n"));
  git(projectRoot, ["init"]);
  git(projectRoot, ["config", "user.email", "test@example.com"]);
  git(projectRoot, ["config", "user.name", "Test User"]);
  git(projectRoot, ["add", "-A"]);
  git(projectRoot, ["commit", "-m", "init"]);

  ensureChangeLayout(projectRoot, change);
  useTestWorkflowMode(projectRoot, "strict");
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
  appendEvent(projectRoot, change, makeEvent(change, "transition_commit", {
    transition: "start-apply",
    from_state: "propose_ready",
    to_state: "apply",
    outcome: "advanced",
    created_job_ids: [],
    reason: "freshness fixture",
    apply_contract_mode: true,
    execution_requirement_version: 2,
    execution_policy: "tdd",
    workflow_mode: "strict",
    review_policy: { review_risk: "strict", requires_verifier: true },
    apply_planning_baseline: applyPlanningBaseline(changeRoot),
  }, { transitionId: "T-start-apply", idempotencyKey: "start-apply-key" }));
  return { projectRoot, change, changeRoot, cleanup: () => rmSync(projectRoot, { recursive: true, force: true }) };
}

function testRun(fx: Fixture, testId: string, attemptId: string, status: "expected_failure" | "expected_success") {
  return recordTestRunContent(fx.projectRoot, fx.change, JSON.stringify({
    test_id: testId,
    attempt_id: attemptId,
    command: `node --test ${testId}`,
    cwd: fx.projectRoot,
    exit_code: status === "expected_failure" ? 1 : 0,
    semantic_status: status,
  }));
}

function completeTask(fx: Fixture, taskId: string, testId: string, code: string): string {
  const started = taskStart(fx.projectRoot, fx.change, fx.changeRoot, taskId);
  assert.equal(started.outcome, "advanced", started.message);
  const attemptId = String(started.details?.attempt_id);
  assert.equal(testRun(fx, testId, attemptId, "expected_failure").accepted, true);
  writeFileSync(join(fx.projectRoot, "src", "calc.ts"), code);
  assert.equal(testRun(fx, testId, attemptId, "expected_success").accepted, true);
  const completed = taskComplete(fx.projectRoot, fx.change, fx.changeRoot, taskId);
  assert.equal(completed.outcome, "advanced", completed.message);
  return attemptId;
}

const ADD = "export const add = (a: number, b: number) => a + b;\n";
const ADD_SUB = `${ADD}export const sub = (a: number, b: number) => a - b;\n`;

function completeAllTasks(fx: Fixture): { first: string; second: string } {
  const first = completeTask(fx, "TASK-001", "TEST-001", ADD);
  const second = completeTask(fx, "TASK-002", "TEST-002", ADD_SUB);
  const toApplyDone = reviewReady(fx.projectRoot, fx.change, fx.changeRoot);
  assert.equal(toApplyDone.to_state, "apply_done", toApplyDone.message);
  return { first, second };
}

function nextOutput(fx: Fixture): NextCommandOutput {
  return next(fx.projectRoot, fx.change, fx.changeRoot);
}

function submitPass(fx: Fixture, jobId: string): void {
  const packet = jobsPacket(fx.projectRoot, fx.change, jobId).packet;
  assert.ok(packet);
  const checkedPaths = packet.boundFiles.map(file => file.path);
  const report = packet.role === "code-reviewer"
    ? {
      role: "code-reviewer",
      verdict: "pass",
      evidence_refs: ["src/calc.ts:1"],
      review_scope: {
        job_id: jobId,
        packet_digest: packet.packet_digest,
        checked_paths: checkedPaths,
        checked_docs: ["proposal.md", "design.md", "tasks.md", ".superspec/artifacts/test-contract.md"],
        unchecked: [],
      },
      findings: [],
      reviewer: { kind: "codex-subagent", id: "freshness-code-reviewer" },
    }
    : {
      role: packet.role,
      verdict: "pass",
      evidence_refs: ["src/calc.ts:1"],
      review_scope: { checked_paths: checkedPaths },
      findings: [],
      reviewer: { kind: "codex-subagent", id: `freshness-${packet.role}` },
    };
  const submitted = recordJobSubmitContent(fx.projectRoot, fx.change, fx.changeRoot, jobId, JSON.stringify(report));
  assert.equal(submitted.accepted, true, submitted.message);
}

function advanceApplyDoneToReview(fx: Fixture): void {
  const codeReview = reviewReady(fx.projectRoot, fx.change, fx.changeRoot);
  assert.equal(codeReview.outcome, "job_created", codeReview.message);
  submitPass(fx, codeReview.created_jobs[0]);
  let advanced = reviewReady(fx.projectRoot, fx.change, fx.changeRoot);
  if (advanced.to_state !== "review") {
    confirmCurrentPhase(fx.projectRoot, fx.change, fx.changeRoot, "strict");
    advanced = reviewReady(fx.projectRoot, fx.change, fx.changeRoot);
  }
  assert.equal(advanced.to_state, "review", advanced.message);
}

function passFinalVerifier(fx: Fixture): void {
  const verifier = reviewReady(fx.projectRoot, fx.change, fx.changeRoot);
  assert.equal(verifier.outcome, "job_created", verifier.message);
  submitPass(fx, verifier.created_jobs[0]);
}

test("测试证据新鲜度：任务完成后改代码，next 要求按模板重跑已完成任务的 TEST，review-ready 在补齐前不推进", () => {
  const fx = setupApply();
  try {
    const attempts = completeAllTasks(fx);
    writeFileSync(join(fx.projectRoot, "src", "calc.ts"), `${ADD_SUB}export const mul = (a: number, b: number) => a * b;\n`);

    const stale = nextOutput(fx);
    assert.equal(stale.path, "test_rerun_required");
    assert.equal(stale.stop_allowed, false);
    if (stale.path !== "test_rerun_required") return;
    assert.deepEqual(stale.changed_paths, ["src/calc.ts"]);
    assert.deepEqual(
      stale.test_reruns.map(action => [action.test_id, action.record_input.attempt_id, action.record_input.semantic_status]),
      [["TEST-001", attempts.first, "expected_success"], ["TEST-002", attempts.second, "expected_success"]],
    );

    const eventsBefore = readEvents(fx.projectRoot, fx.change).length;
    const blocked = reviewReady(fx.projectRoot, fx.change, fx.changeRoot);
    assert.equal(blocked.events_written, 0);
    assert.equal(blocked.to_state, "apply_done");
    assert.equal(readEvents(fx.projectRoot, fx.change).length, eventsBefore);

    assert.equal(testRun(fx, "TEST-001", attempts.first, "expected_failure").accepted, false);
    assert.equal(testRun(fx, "TEST-002", attempts.first, "expected_success").accepted, false);

    const firstRerun = stale.test_reruns[0].record_input;
    assert.equal(recordTestRunContent(fx.projectRoot, fx.change, JSON.stringify({
      ...firstRerun,
      command: "node --test TEST-001",
      cwd: fx.projectRoot,
      exit_code: 0,
    })).accepted, true);
    const partial = nextOutput(fx);
    assert.equal(partial.path, "test_rerun_required");
    if (partial.path === "test_rerun_required") {
      assert.deepEqual(partial.test_reruns.map(action => action.test_id), ["TEST-002"]);
    }
    assert.equal(testRun(fx, "TEST-001", attempts.first, "expected_success").accepted, false);

    assert.equal(testRun(fx, "TEST-002", attempts.second, "expected_success").accepted, true);
    assert.notEqual(nextOutput(fx).path, "test_rerun_required");
    const codeReview = reviewReady(fx.projectRoot, fx.change, fx.changeRoot);
    assert.equal(codeReview.outcome, "job_created", codeReview.message);
  } finally {
    fx.cleanup();
  }
});

test("测试证据新鲜度：代码内容未变时不要求重跑；提交改动和登记审查结论都不算代码变化", () => {
  const fx = setupApply();
  try {
    const attempts = completeAllTasks(fx);
    assert.notEqual(nextOutput(fx).path, "test_rerun_required");
    assert.equal(testRun(fx, "TEST-001", attempts.first, "expected_success").accepted, false);

    git(fx.projectRoot, ["add", "-A"]);
    git(fx.projectRoot, ["commit", "-m", "implement calc"]);
    assert.notEqual(nextOutput(fx).path, "test_rerun_required");

    advanceApplyDoneToReview(fx);
    assert.notEqual(nextOutput(fx).path, "test_rerun_required");
    passFinalVerifier(fx);
    assert.equal(accept(fx.projectRoot, fx.change, fx.changeRoot).to_state, "accepted");
  } finally {
    fx.cleanup();
  }
});

test("测试证据新鲜度：最终验证通过后再改代码，accept 被阻止；重跑登记后重新最终验证才能接受", () => {
  const fx = setupApply();
  try {
    const attempts = completeAllTasks(fx);
    advanceApplyDoneToReview(fx);
    passFinalVerifier(fx);

    writeFileSync(join(fx.projectRoot, "src", "calc.ts"), `${ADD_SUB}// 最终验证之后的改动\n`);
    const blocked = accept(fx.projectRoot, fx.change, fx.changeRoot);
    assert.equal(blocked.events_written, 0);
    assert.equal(blocked.to_state, "review");
    assert.equal(reviewReady(fx.projectRoot, fx.change, fx.changeRoot).events_written, 0);

    const stale = nextOutput(fx);
    assert.equal(stale.path, "test_rerun_required");
    if (stale.path === "test_rerun_required") {
      assert.deepEqual(stale.test_reruns.map(action => action.test_id), ["TEST-001", "TEST-002"]);
    }
    assert.equal(testRun(fx, "TEST-001", attempts.first, "expected_success").accepted, true);
    assert.equal(testRun(fx, "TEST-002", attempts.second, "expected_success").accepted, true);

    const afterRerun = nextOutput(fx);
    assert.equal(afterRerun.path, "next_command");
    if (afterRerun.path === "next_command") assert.match(afterRerun.next_command, /transition review-ready/);
    passFinalVerifier(fx);
    assert.equal(accept(fx.projectRoot, fx.change, fx.changeRoot).to_state, "accepted");
  } finally {
    fx.cleanup();
  }
});

test("CLI record：--input - 收到空 stdin 时直接报错，不登记任何记录", () => {
  const fx = setupApply();
  try {
    const cli = new URL("../src/cli.ts", import.meta.url).pathname;
    const eventsBefore = readEvents(fx.projectRoot, fx.change).length;
    for (const [subcommand, input] of [["user-decision", ""], ["test-run", "  \n"], ["workflow-mode", ""]] as const) {
      const run = spawnSync(process.execPath, [cli, "record", subcommand, "--change", fx.change, "--input", "-"], {
        cwd: fx.projectRoot,
        encoding: "utf8",
        input,
      });
      assert.equal(run.status, 1, `${subcommand}: ${run.stdout}`);
      assert.equal(run.stdout, "");
      assert.notEqual(run.stderr.trim(), "");
    }
    assert.equal(readEvents(fx.projectRoot, fx.change).length, eventsBefore);
  } finally {
    fx.cleanup();
  }
});
