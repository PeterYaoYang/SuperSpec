// SuperSpec 流程引擎 — Phase 5 测试：skill-loop 适配循环

import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { simulateLoop } from "../src/skill_loop.ts";
import { next } from "../src/next.ts";
import { proposeReady, reviewReady, startApply, transitionExplore } from "../src/transition.ts";
import { jobsPacket, recordJobSubmitContent, recordUserDecisionContent } from "../src/record.ts";
import { appendEvent, ensureChangeLayout, makeEvent, readEvents } from "../src/store.ts";
import { rebuildSnapshot } from "../src/sync.ts";
import { phaseConfirmationForCurrentState } from "../src/phase_confirmation.ts";
import type { PhaseDecisionAction } from "../src/phase_confirmation.ts";
import { reviewRolesForGate, resolveWorkflowProfile, workflowProfileForRisk } from "../src/workflow_profile.ts";
import { PROPOSE_FINAL_REVIEW_GATE } from "../src/review_job_gates.ts";
import type { Job, NextOutput, Snapshot } from "../src/types.ts";
import { WorkflowConfigError, workflowRiskForProject } from "../src/workflow_config.ts";

const V2_DISABLED_PLANNING_PROFILE = {
  version: 2,
  openspec: { mode: "disabled" },
} as const;

test("workflow profile：默认 resolver 保持现有 gate 角色矩阵", () => {
  assert.equal(workflowProfileForRisk("minimal"), "light");
  assert.equal(workflowProfileForRisk("normal"), "normal");
  assert.equal(workflowProfileForRisk("strict"), "strict");

  assert.deepEqual(reviewRolesForGate("explore.discovery_review", "minimal"), []);
  assert.deepEqual(reviewRolesForGate("explore.discovery_review", "normal"), ["critic"]);
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

test("CLI：工作流 mode 只能由项目配置控制，不接受 --risk", () => {
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
      "strict",
    ], {
      cwd: projectRoot,
      encoding: "utf8",
    });

    assert.equal(result.status, 1);
    assert.match(result.stderr, /workflow\.mode 控制，不支持 --risk/);
    assert.equal(result.stdout.trim(), "");
  } finally {
    rmSync(projectRoot, { recursive: true, force: true });
  }
});

test("项目工作流配置：读取 mode，调用方不能临时覆盖", () => {
  const projectRoot = mkdtempSync(join(tmpdir(), "superspec-workflow-config-"));
  try {
    mkdirSync(join(projectRoot, ".superspec"), { recursive: true });
    writeFileSync(join(projectRoot, ".superspec", "config.json"), JSON.stringify({ workflow: { mode: "normal" } }));
    assert.equal(workflowRiskForProject(projectRoot), "normal");

    writeFileSync(join(projectRoot, ".superspec", "config.json"), "{not json");
    assert.throws(() => workflowRiskForProject(projectRoot), WorkflowConfigError);
  } finally {
    rmSync(projectRoot, { recursive: true, force: true });
  }
});

test("propose-ready 未显式指定 risk 时读取项目工作流配置", () => {
  const projectRoot = mkdtempSync(join(tmpdir(), "superspec-config-propose-"));
  const change = "config-propose";
  const changeRoot = join(projectRoot, "openspec", "changes", change);
  try {
    mkdirSync(join(projectRoot, ".superspec"), { recursive: true });
    writeFileSync(join(projectRoot, ".superspec", "config.json"), JSON.stringify({ workflow: { mode: "normal" } }));
    mkdirSync(join(changeRoot, ".superspec", "artifacts"), { recursive: true });
    writeFileSync(join(changeRoot, "proposal.md"), "# Proposal\n");
    writeFileSync(join(changeRoot, "design.md"), "# Design\n");
    writeFileSync(join(changeRoot, "tasks.md"), [
      "# Tasks", "",
      "- [ ] TASK-001 Documentation",
      "  执行依据:",
      "  - 测试:",
      "  - 设计: design.md#Design",
      "  - 来源: proposal.md#Proposal",
      "  - 验收: 文档说明完整",
      "  - 边界: 不改实现代码",
      "",
    ].join("\n"));
    writeFileSync(join(changeRoot, ".superspec", "artifacts", "discovery.md"), "# Discovery\n");
    writeFileSync(join(changeRoot, ".superspec", "artifacts", "test-contract.md"), "# Test Contract\n");
    ensureChangeLayout(projectRoot, change);
    for (const [transition, from, to] of [
      ["init", "init", "init"],
      ["explore", "init", "explore"],
      ["propose", "explore", "propose"],
    ] as const) {
      appendEvent(projectRoot, change, makeEvent(change, "transition_commit", {
        transition, from_state: from, to_state: to, outcome: "advanced", created_job_ids: [], reason: transition,
        ...(transition === "propose" ? {
          planning_validation_version: 2,
          planning_validation_profile: V2_DISABLED_PLANNING_PROFILE,
        } : {}),
      }, { transitionId: `T-${transition}`, idempotencyKey: `config-${transition}` }));
    }

    const result = proposeReady(projectRoot, change, changeRoot);
    assert.equal(result.outcome, "job_created");
    assert.equal(result.created_jobs.length, 1);
  } finally {
    rmSync(projectRoot, { recursive: true, force: true });
  }
});

test("mode 在 propose-ready 冻结：配置变 strict 不重审也不漂移 Apply/Review 策略", () => {
  const projectRoot = mkdtempSync(join(tmpdir(), "superspec-mode-round-"));
  const change = "mode-round";
  const changeRoot = join(projectRoot, "openspec", "changes", change);
  try {
    mkdirSync(join(projectRoot, ".superspec"), { recursive: true });
    writeFileSync(join(projectRoot, ".superspec", "config.json"), JSON.stringify({ workflow: { mode: "normal" } }));
    mkdirSync(join(changeRoot, ".superspec", "artifacts"), { recursive: true });
    writeFileSync(join(changeRoot, "proposal.md"), "# Proposal\n");
    writeFileSync(join(changeRoot, "design.md"), "# Design\n");
    writeFileSync(join(changeRoot, "tasks.md"), [
      "# Tasks", "",
      "- [x] TASK-001 Documentation update",
      "  执行依据:",
      "  - 测试:",
      "  - 设计: design.md#Design",
      "  - 来源: proposal.md#Proposal",
      "  - 验收: 文档与计划一致",
      "  - 边界: 不改实现代码",
      "",
    ].join("\n"));
    writeFileSync(join(changeRoot, ".superspec", "artifacts", "discovery.md"), "# Discovery\n");
    writeFileSync(join(changeRoot, ".superspec", "artifacts", "test-contract.md"), "# Test Contract\n");
    ensureChangeLayout(projectRoot, change);
    for (const [transition, from, to] of [
      ["init", "init", "init"],
      ["explore", "init", "explore"],
      ["propose", "explore", "propose"],
    ] as const) {
      appendEvent(projectRoot, change, makeEvent(change, "transition_commit", {
        transition, from_state: from, to_state: to, outcome: "advanced", created_job_ids: [], reason: transition,
        ...(transition === "propose" ? {
          planning_validation_version: 2,
          planning_validation_profile: V2_DISABLED_PLANNING_PROFILE,
        } : {}),
      }, { transitionId: `T-mode-${transition}`, idempotencyKey: `mode-${transition}` }));
    }

    const critic = proposeReady(projectRoot, change, changeRoot);
    assert.equal(critic.created_jobs.length, 1, "normal 只需要 critic");
    const criticPacket = jobsPacket(projectRoot, change, critic.created_jobs[0]).packet;
    assert.ok(criticPacket);
    assert.deepEqual(criticPacket.review_targets, [
      "proposal.md",
      "specs/",
      "design.md",
      "tasks.md",
      ".superspec/artifacts/test-contract.md",
    ]);
    assert.deepEqual(criticPacket.read_only_refs, [".superspec/artifacts/discovery.md"]);
    assert.ok(criticPacket.boundFiles.some(file => file.path === "design.md"));
    assert.equal(recordJobSubmitContent(projectRoot, change, changeRoot, critic.created_jobs[0], JSON.stringify({
      role: "critic",
      verdict: "pass",
      findings: [],
      review_scope: { checked_paths: criticPacket.boundFiles.map(file => file.path) },
      reviewer: { kind: "codex-subagent", id: "mode-round-critic" },
    })).accepted, true);
    assert.equal(proposeReady(projectRoot, change, changeRoot).to_state, "propose_ready");

    const ask = next(projectRoot, change, changeRoot);
    assert.equal(ask.path, "ask_user");
    const advance = (ask.ask_user.actions as PhaseDecisionAction[]).find(action => action.decision === "advance");
    assert.ok(advance);
    assert.equal(advance.record_input.review_risk, "normal");
    assert.equal(recordUserDecisionContent(projectRoot, change, JSON.stringify({
      ...advance.record_input,
      review_risk: "strict", // 外部 JSON 不能把 confirmation/round 升格。
    })).accepted, true);
    const decisionEvent = readEvents(projectRoot, change).findLast(event => event.event_type === "user_decision_recorded");
    assert.equal((decisionEvent?.payload as { phase_confirmation?: { review_risk?: unknown } }).phase_confirmation?.review_risk, "normal");

    // 配置从这里起只影响将来的 planning round，不能把已确认的 normal round 升格为 strict。
    writeFileSync(join(projectRoot, ".superspec", "config.json"), JSON.stringify({ workflow: { mode: "strict" } }));
    const applied = startApply(projectRoot, change, changeRoot);
    assert.equal(applied.to_state, "apply");
    const startCommit = readEvents(projectRoot, change).findLast(event =>
      event.event_type === "transition_commit" && (event.payload as { transition?: unknown }).transition === "start-apply",
    );
    assert.deepEqual((startCommit?.payload as { workflow_mode?: unknown }).workflow_mode, "normal");
    assert.deepEqual((startCommit?.payload as { execution_policy?: unknown }).execution_policy, "green_only");
    assert.deepEqual((startCommit?.payload as { review_policy?: unknown }).review_policy, {
      review_risk: "normal",
      requires_verifier: true,
    });

    const applyDone = reviewReady(projectRoot, change, changeRoot);
    assert.equal(applyDone.to_state, "apply_done");
  } finally {
    rmSync(projectRoot, { recursive: true, force: true });
  }
});

test("simulateLoop：done 路径立即停止", () => {
  const result = simulateLoop(
    () => ({ state: "accepted", path: "done", reason: "已完成" }) as NextOutput,
    () => true,
  );
  assert.equal(result.completed, true);
  assert.equal(result.steps.length, 1);
  assert.equal(result.finalState, "accepted");
});

test("simulateLoop：accepted 终态不会再执行推进命令", () => {
  let executed = false;
  const result = simulateLoop(
    () => ({ state: "accepted", path: "done", reason: "审查已接受，流程完成" }),
    () => {
      executed = true;
      return true;
    },
  );
  assert.equal(result.completed, true);
  assert.equal(result.steps.length, 1);
  assert.equal(result.steps[0].action, "stop");
  assert.equal(result.finalState, "accepted");
  assert.equal(executed, false);
});

test("simulateLoop：真实 next 在阶段确认处暂停，登记后只推进一个边界", () => {
  const projectRoot = mkdtempSync(join(tmpdir(), "superspec-phase-confirmation-loop-"));
  const change = "phase-confirmation-loop";
  const changeRoot = join(projectRoot, "openspec", "changes", change);
  mkdirSync(join(changeRoot, ".superspec", "artifacts"), { recursive: true });
  mkdirSync(join(projectRoot, ".superspec"), { recursive: true });
  writeFileSync(join(projectRoot, ".superspec", "config.json"), JSON.stringify({ workflow: { mode: "minimal" } }));
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
    const action = (ask.ask_user.actions as PhaseDecisionAction[])[0];
    assert.ok(action);
    assert.equal(recordUserDecisionContent(projectRoot, change, JSON.stringify(action.record_input)).accepted, true);

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
    const advance = initial.actions.find(action => action.decision === "advance");
    assert.ok(advance);
    assert.equal(recordUserDecisionContent(
      projectRoot,
      change,
      JSON.stringify(advance.record_input),
    ).accepted, true);

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
    { state: "accepted", path: "done", reason: "完成" },
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

test("simulateLoop：artifact_required 返回可执行的产物停点", () => {
  const result = simulateLoop(
    () => ({
      state: "explore",
      path: "artifact_required",
      artifact: {
        kind: "discovery",
        path: "openspec/changes/demo/.superspec/artifacts/discovery.md",
        operation: "create_or_update",
      },
      resume: { argv: ["superspec", "transition", "next", "--change", "demo"] },
      reason: "discovery.md 不存在",
    }),
    () => { throw new Error("artifact_required 不应由循环自动执行"); },
  );
  assert.equal(result.completed, false);
  assert.equal(result.steps[0].action, "artifact");
  assert.match(result.message, /artifacts\/discovery\.md/);
});

test("simulateLoop：material_update_required 返回材料修正停点", () => {
  const result = simulateLoop(
    () => ({
      state: "propose",
      path: "material_update_required",
      errors: ["tasks.md 缺少执行依据"],
      resume: { argv: ["superspec", "transition", "next", "--change", "demo"] },
      reason: "计划材料预检失败",
    }),
    () => { throw new Error("material_update_required 不应由循环自动执行"); },
  );
  assert.equal(result.completed, false);
  assert.equal(result.steps[0].action, "material_update");
  assert.match(result.message, /tasks\.md 缺少执行依据/);
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
