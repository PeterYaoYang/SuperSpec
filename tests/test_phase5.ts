// SuperSpec 流程引擎 — Phase 5 测试：skill-loop 适配循环

import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { simulateLoop } from "../src/skill_loop.ts";
import { reviewRolesForGate, resolveWorkflowProfile, workflowProfileForRisk } from "../src/workflow_profile.ts";
import { PROPOSE_FINAL_REVIEW_GATE } from "../src/review_job_gates.ts";
import type { Job, NextOutput, Snapshot } from "../src/types.ts";

test("workflow profile：默认 resolver 保持现有 gate 角色矩阵", () => {
  assert.equal(workflowProfileForRisk("minimal"), "light");
  assert.equal(workflowProfileForRisk("normal"), "normal");
  assert.equal(workflowProfileForRisk("strict"), "strict");

  assert.deepEqual(reviewRolesForGate("explore.discovery_review", "minimal"), []);
  assert.deepEqual(reviewRolesForGate("explore.discovery_review", "normal"), []);
  assert.deepEqual(reviewRolesForGate("explore.discovery_review", "strict"), ["critic"]);

  assert.deepEqual(reviewRolesForGate("propose.final_review", "minimal"), []);
  assert.deepEqual(reviewRolesForGate("propose.final_review", "normal"), ["critic"]);
  assert.deepEqual(reviewRolesForGate("propose.final_review", "strict"), ["critic", "architect", "test-engineer"]);

  assert.deepEqual(reviewRolesForGate("review.code_review", "minimal"), ["code-reviewer"]);
  assert.deepEqual(reviewRolesForGate("review.final_verifier", "strict"), ["verifier"]);
});

test("workflow profile：resolver 返回角色副本，调用方不能污染默认矩阵", () => {
  const resolved = resolveWorkflowProfile("normal");
  resolved.reviewRolesByGate["propose.final_review"]?.push("architect");

  assert.deepEqual(reviewRolesForGate("propose.final_review", "normal"), ["critic"]);
});

test("review gate：gate_id 不能绕过角色边界", () => {
  const wrongRoleJob: Job = {
    job_id: "JOB-wrong-role",
    role: "verifier",
    state: "requested",
    gate_id: "propose.final_review",
    boundFiles: [],
    packet_digest: "sha256:wrong-role",
    created_from_transition: "propose-ready",
    created_at: new Date().toISOString(),
  };
  const snapshot: Snapshot = {
    change_id: "test-change",
    state: "propose",
    openspec_status_digest: "sha256:test",
    events_digest: "sha256:test",
    document_digests: {},
    tasks_structure_digest: null,
    task_statuses: {},
    open_jobs: [wrongRoleJob],
    accepted_jobs: [],
    active_task_attempts: [],
    pending_user_decisions: [],
    last_transition: null,
    computed_at: new Date().toISOString(),
  };

  assert.equal(PROPOSE_FINAL_REVIEW_GATE.isJobForGate(wrongRoleJob), false);
  assert.deepEqual(PROPOSE_FINAL_REVIEW_GATE.openJobsForGate(snapshot), []);
});

test("CLI：非法 risk 不会进入 profile resolver", () => {
  const projectRoot = mkdtempSync(join(tmpdir(), "superspec-risk-"));
  try {
    const cli = new URL("../src/cli.ts", import.meta.url).pathname;
    const result = spawnSync(process.execPath, [
      cli,
      "transition",
      "next",
      "--change",
      "test-change",
      "--risk",
      "ultra-strict",
    ], {
      cwd: projectRoot,
      encoding: "utf8",
    });

    assert.equal(result.status, 1);
    assert.match(result.stderr, /--risk 只能是 minimal、normal 或 strict/);
    assert.equal(result.stdout.trim(), "");
  } finally {
    rmSync(projectRoot, { recursive: true, force: true });
  }
});

test("simulateLoop：done 路径立即停止", () => {
  const result = simulateLoop(
    () => ({ state: "archive", path: "done", reason: "已完成" }) as NextOutput,
    () => true,
  );
  assert.equal(result.completed, true);
  assert.equal(result.steps.length, 1);
  assert.equal(result.finalState, "archive");
});

test("simulateLoop：accepted 归档确认会暂停", () => {
  const outputs: NextOutput[] = [
    {
      state: "accepted",
      path: "ask_user",
      ask_user: { question: "审查已通过，确认归档时请执行 superspec transition archive", allowed_answers: ["确认归档"], scope: "archive_confirmation" },
      reason: "等待确认",
    },
  ];
  const result = simulateLoop(
    () => outputs[0],
    () => true,
  );
  assert.equal(result.completed, false);
  assert.equal(result.steps.length, 1);
  assert.equal(result.steps[0].action, "ask");
  assert.equal(result.finalState, "accepted");
  assert.match(result.message, /需要用户确认/);
});

test("simulateLoop：required_job → next_command → done", () => {
  let callCount = 0;
  const outputs: NextOutput[] = [
    {
      state: "propose",
      path: "required_job",
      required_jobs: [{
        job_id: "JOB-1",
        role: "critic",
        packet_command: "superspec jobs packet --change test-change --job JOB-1",
        packet_argv: ["superspec", "jobs", "packet", "--change", "test-change", "--job", "JOB-1"],
      }],
      reason: "需要审查",
    },
    { state: "propose", path: "next_command", next_command: "superspec transition propose-ready", reason: "推进", missing_inputs: [] },
    { state: "propose_ready", path: "next_command", next_command: "superspec transition start-apply", reason: "执行", missing_inputs: [] },
    { state: "archive", path: "done", reason: "完成" },
  ];
  const result = simulateLoop(
    () => outputs[callCount++],
    () => true,
  );
  assert.equal(result.completed, true);
  assert.equal(result.steps.length, 4);
  assert.equal(result.steps[0].action, "job");
  assert.equal(result.steps[1].action, "execute");
});

test("simulateLoop：ask_user 暂停", () => {
  const result = simulateLoop(
    () => ({ state: "explore", path: "ask_user", ask_user: { question: "请确认", allowed_answers: ["yes"], scope: "explore" }, reason: "需确认" }) as NextOutput,
    () => true,
  );
  assert.equal(result.completed, false);
  assert.equal(result.steps.length, 1);
  assert.ok(result.message.includes("请确认"));
});

test("simulateLoop：execute 失败立即停止", () => {
  const result = simulateLoop(
    () => ({ state: "apply", path: "next_command", next_command: "superspec transition task-complete", reason: "完成", missing_inputs: [] }) as NextOutput,
    () => false,
  );
  assert.equal(result.completed, false);
  assert.ok(result.message.includes("失败"));
});

test("simulateLoop：达到 maxSteps 停止", () => {
  let count = 0;
  const result = simulateLoop(
    () => ({ state: "apply", path: "next_command", next_command: `cmd-${count++}`, reason: "循环", missing_inputs: [] }) as NextOutput,
    () => true,
    3,
  );
  assert.equal(result.completed, false);
  assert.equal(result.steps.length, 3);
  assert.ok(result.message.includes("最大步数"));
});
