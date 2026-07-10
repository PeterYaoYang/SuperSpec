// SuperSpec 流程引擎 — Phase 5 测试：skill-loop 适配循环

import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { simulateLoop } from "../src/skill_loop.ts";
import { next } from "../src/next.ts";
import { transitionExplore } from "../src/transition.ts";
import { recordUserDecisionContent } from "../src/record.ts";
import { appendEvent, ensureChangeLayout, makeEvent, readEvents } from "../src/store.ts";
import { rebuildSnapshot } from "../src/sync.ts";
import { phaseConfirmationForCurrentState } from "../src/phase_confirmation.ts";
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
      ask_user: { question: "审查已通过，确认归档时请执行 superspec transition archive", allowed_answers: ["确认归档"], scope: "phase_confirmation:accepted_to_archive:test-epoch:sha256:test" },
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

test("simulateLoop：真实 next 在阶段确认处暂停，登记后只推进一个边界", () => {
  const projectRoot = mkdtempSync(join(tmpdir(), "superspec-phase-confirmation-loop-"));
  const change = "phase-confirmation-loop";
  const changeRoot = join(projectRoot, "openspec", "changes", change);
  mkdirSync(join(changeRoot, ".superspec", "artifacts"), { recursive: true });
  writeFileSync(join(changeRoot, "proposal.md"), "# Proposal\n");
  writeFileSync(join(changeRoot, "tasks.md"), "# Tasks\n");
  writeFileSync(join(changeRoot, ".superspec", "artifacts", "discovery.md"), "# Discovery\n");
  ensureChangeLayout(projectRoot, change);
  for (const [transition, from, to] of [
    ["init", "init", "init"],
    ["explore", "init", "explore"],
  ] as const) {
    appendEvent(projectRoot, change, makeEvent(change, "transition_commit", {
      transition,
      from_state: from,
      to_state: to,
      outcome: "advanced",
      created_job_ids: [],
      reason: transition,
    }, { transitionId: `T-${transition}`, idempotencyKey: `K-${transition}` }));
  }

  try {
    const paused = simulateLoop(
      () => next(projectRoot, change, changeRoot, "minimal"),
      () => { throw new Error("ask_user 不应执行命令"); },
    );
    assert.equal(paused.completed, false);
    assert.equal(paused.steps.length, 1);
    assert.equal(paused.steps[0].action, "ask");

    const ask = next(projectRoot, change, changeRoot, "minimal");
    assert.equal(ask.path, "ask_user");
    assert.equal(recordUserDecisionContent(projectRoot, change, JSON.stringify({
      scope: ask.ask_user.scope,
      question: ask.ask_user.question,
      answer: ask.ask_user.allowed_answers[0],
    })).accepted, true);

    const afterDecision = next(projectRoot, change, changeRoot, "minimal");
    assert.equal(afterDecision.path, "next_command");
    assert.match(afterDecision.next_command, /transition explore/);
    assert.equal(transitionExplore(projectRoot, change, changeRoot, "minimal").to_state, "propose");
    assert.equal(next(projectRoot, change, changeRoot, "minimal").state, "propose");
  } finally {
    rmSync(projectRoot, { recursive: true, force: true });
  }
});

test("阶段确认：授权事件不改变 scope，coverage exemption 会改变 scope", () => {
  const projectRoot = mkdtempSync(join(tmpdir(), "superspec-phase-confirmation-digest-"));
  const change = "phase-confirmation-digest";
  const changeRoot = join(projectRoot, "openspec", "changes", change);
  mkdirSync(join(changeRoot, ".superspec", "artifacts"), { recursive: true });
  writeFileSync(join(changeRoot, "proposal.md"), "# Proposal\n");
  writeFileSync(join(changeRoot, "tasks.md"), "# Tasks\n");
  writeFileSync(join(changeRoot, ".superspec", "artifacts", "discovery.md"), "# Discovery\n");
  ensureChangeLayout(projectRoot, change);
  for (const [transition, from, to] of [
    ["init", "init", "init"],
    ["explore", "init", "explore"],
  ] as const) {
    appendEvent(projectRoot, change, makeEvent(change, "transition_commit", {
      transition,
      from_state: from,
      to_state: to,
      outcome: "advanced",
      created_job_ids: [],
      reason: transition,
    }, { transitionId: `T-${transition}`, idempotencyKey: `K-${transition}` }));
  }

  try {
    const currentConfirmation = () => {
      const confirmation = phaseConfirmationForCurrentState(
        projectRoot,
        readEvents(projectRoot, change),
        rebuildSnapshot(projectRoot, change, changeRoot),
      );
      assert.ok(confirmation);
      return confirmation;
    };

    const initial = currentConfirmation();
    assert.equal(recordUserDecisionContent(projectRoot, change, JSON.stringify({
      scope: initial.scope,
      question: initial.ask.question,
      answer: initial.answer,
    })).accepted, true);

    const afterConfirmation = currentConfirmation();
    assert.equal(afterConfirmation.scope, initial.scope);
    assert.equal(afterConfirmation.material_digest, initial.material_digest);

    assert.equal(recordUserDecisionContent(projectRoot, change, JSON.stringify({
      scope: "test_coverage_exemption:TEST-001",
      question: "为什么不为 TEST-001 单独绑定任务？",
      answer: "已有等价覆盖，无需重复实现",
    })).accepted, true);

    const afterExemption = currentConfirmation();
    assert.notEqual(afterExemption.scope, initial.scope);
    assert.notEqual(afterExemption.material_digest, initial.material_digest);
  } finally {
    rmSync(projectRoot, { recursive: true, force: true });
  }
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
