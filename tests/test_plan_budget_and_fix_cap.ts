// SuperSpec P3：计划规模预算与 review-fix 自动修复上限

import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";

import { ensureChangeLayout, appendEvent, makeEvent, readEvents } from "../src/store.ts";
import { next } from "../src/next.ts";
import { proposeReady, reviewReady, reopen } from "../src/transition.ts";
import { jobsPacket, recordJobSubmit, recordUserDecisionContent } from "../src/record.ts";
import {
  applyPlanningBaseline,
  planSizeBudgetScope,
  PLAN_SIZE_BUDGET_CONFIRM_ANSWER,
  PLAN_SIZE_BUDGET_SHRINK_ANSWER,
} from "../src/phase_plan.ts";
import { CODE_REVIEW_DECISION_ANSWER_LABELS, countReviewFixReopensSinceStartApply } from "../src/code_review.ts";
import type { NextOutput } from "../src/types.ts";

function writeWorkflowConfig(projectRoot: string, workflow: Record<string, unknown>): void {
  const configPath = join(projectRoot, ".superspec", "config.json");
  mkdirSync(dirname(configPath), { recursive: true });
  writeFileSync(configPath, JSON.stringify({ workflow }, null, 2));
}

function makeTaskLines(count: number, options: { includeFixTasks?: number } = {}): string {
  const lines = ["# Tasks", ""];
  for (let i = 1; i <= count; i++) {
    lines.push(`- [ ] TASK-${String(i).padStart(3, "0")} Do something`);
    lines.push("  执行依据:");
    lines.push("  - 测试:");
    lines.push("  - 设计: design.md#Design");
    lines.push("  - 来源: proposal.md#Proposal");
    lines.push("  - 验收: done");
    lines.push("  - 边界: none");
    lines.push("");
  }
  const fixCount = options.includeFixTasks ?? 0;
  for (let i = 1; i <= fixCount; i++) {
    lines.push(`- [ ] REVIEW-FIX-JOB-${i}#F${i} Fix review issue`);
    lines.push("");
  }
  return lines.join("\n");
}

function makeTestContract(count: number): string {
  const lines = [
    "# Test Contract",
    "",
    "| test_id | scenario |",
    "|---|---|",
  ];
  for (let i = 1; i <= count; i++) {
    lines.push(`| TEST-${String(i).padStart(3, "0")} | scenario ${i} |`);
  }
  lines.push("");
  return lines.join("\n");
}

function setupProposeBudget(options: {
  taskCount: number;
  testCount?: number;
  includeFixTasks?: number;
  workflow?: Record<string, unknown>;
}): { projectRoot: string; change: string; changeRoot: string; cleanup: () => void } {
  const projectRoot = mkdtempSync(join(tmpdir(), "superspec-budget-"));
  const change = "test-change";
  const changeRoot = join(projectRoot, "openspec", "changes", change);
  mkdirSync(join(changeRoot, ".superspec", "artifacts"), { recursive: true });
  writeFileSync(join(changeRoot, "proposal.md"), "# Proposal\n");
  writeFileSync(join(changeRoot, "design.md"), "# Design\n\n## 结构变更清单\n\n无\n");
  writeFileSync(join(changeRoot, "tasks.md"), makeTaskLines(options.taskCount, { includeFixTasks: options.includeFixTasks }));
  writeFileSync(join(changeRoot, ".superspec", "artifacts", "discovery.md"), "# Discovery\n");
  writeFileSync(join(changeRoot, ".superspec", "artifacts", "test-contract.md"), makeTestContract(options.testCount ?? 1));
  writeWorkflowConfig(projectRoot, {
    mode: "normal",
    budget: { tasks: 10, tests: 20, review_fix_rounds: 2 },
    ...options.workflow,
  });
  ensureChangeLayout(projectRoot, change);
  // 与生产事件形态一致：explore → propose 的边界事件 transition 为 "explore"，它决定 propose round id。
  for (const [t, f, to] of [["init", "init", "init"], ["explore", "init", "explore"], ["explore", "explore", "propose"]] as const) {
    appendEvent(projectRoot, change, makeEvent(change, "transition_commit", {
      transition: t,
      from_state: f,
      to_state: to,
      outcome: "advanced",
      created_job_ids: [],
      reason: `${t}→${to}`,
      ...(to === "propose" ? {
        planning_validation_version: 2,
        planning_validation_profile: { version: 2, openspec: { mode: "disabled" }, design: { schema_version: 2 } },
      } : {}),
    }, { transitionId: `T-${t}-${to}`, idempotencyKey: `${t}-${to}-key` }));
  }
  return {
    projectRoot,
    change,
    changeRoot,
    cleanup: () => rmSync(projectRoot, { recursive: true, force: true }),
  };
}

function setupApplyDone(): { projectRoot: string; change: string; changeRoot: string; cleanup: () => void } {
  const projectRoot = mkdtempSync(join(tmpdir(), "superspec-fix-cap-"));
  const change = "test-change";
  const changeRoot = join(projectRoot, "openspec", "changes", change);
  mkdirSync(join(changeRoot, ".superspec", "artifacts"), { recursive: true });
  writeFileSync(join(changeRoot, "tasks.md"), [
    "# Tasks", "",
    "- [x] TASK-001 Done",
    "  执行依据:",
    "  - 测试:",
    "  - 设计: design.md#D",
    "  - 来源: proposal.md#P",
    "  - 验收: done",
    "  - 边界: none",
    "",
  ].join("\n"));
  writeFileSync(join(changeRoot, "proposal.md"), "# P\n");
  writeFileSync(join(changeRoot, "design.md"), "# D\n");
  writeFileSync(join(changeRoot, ".superspec", "artifacts", "discovery.md"), "# D\n");
  writeFileSync(join(changeRoot, ".superspec", "artifacts", "test-contract.md"), "# TC\n");
  writeWorkflowConfig(projectRoot, { mode: "normal", budget: { tasks: 10, tests: 20, review_fix_rounds: 2 } });
  ensureChangeLayout(projectRoot, change);
  for (const [t, f, to] of [
    ["init", "init", "init"],
    ["explore", "init", "explore"],
    ["propose", "explore", "propose"],
    ["propose-ready", "propose", "propose_ready"],
    ["start-apply", "propose_ready", "apply"],
  ] as const) {
    appendEvent(projectRoot, change, makeEvent(change, "transition_commit", {
      transition: t,
      from_state: f,
      to_state: to,
      outcome: "advanced",
      created_job_ids: [],
      reason: t,
      ...(t === "start-apply" ? { apply_planning_baseline: applyPlanningBaseline(changeRoot) } : {}),
    }, { transitionId: `T-${t}`, idempotencyKey: `${t}-key` }));
  }
  return { projectRoot, change, changeRoot, cleanup: () => rmSync(projectRoot, { recursive: true, force: true }) };
}

function appendReviewFixReopen(
  projectRoot: string,
  change: string,
  jobId: string,
  findingId: string,
): void {
  appendEvent(projectRoot, change, makeEvent(change, "transition_commit", {
    transition: "reopen",
    from_state: "apply_done",
    to_state: "apply",
    outcome: "advanced",
    review_fix_of: `${jobId}#${findingId}`,
    reason: `fix ${findingId}`,
  }, { transitionId: `T-fix-${findingId}-${Date.now()}`, idempotencyKey: `fix-${findingId}-${Date.now()}` }));
}

function submitImplementationFinding(
  projectRoot: string,
  change: string,
  changeRoot: string,
  jobId: string,
  findingId: string,
) {
  const packet = jobsPacket(projectRoot, change, jobId);
  const reportPath = join(projectRoot, `${jobId}.report`);
  writeFileSync(reportPath, JSON.stringify({
    role: "code-reviewer",
    verdict: "fail",
    review_scope: {
      job_id: jobId,
      packet_digest: packet.packet?.packet_digest,
      checked_paths: [],
      checked_docs: ["proposal.md", "design.md", "tasks.md"],
      unchecked: [],
    },
    findings: [{
      id: findingId,
      type: "implementation",
      blocking: true,
      description: "implementation issue",
      evidence: "src/example.ts:1",
      source_refs: ["src/example.ts:1"],
      impact: "breaks",
      suggested_action: "apply",
      claim_kind: "breaks_existing",
      approved_refs: ["design.md#D"],
    }],
    reviewer: { kind: "codex-subagent", id: "test-code-reviewer" },
  }));
  return recordJobSubmit(projectRoot, change, changeRoot, jobId, reportPath);
}

function openCodeReviewer(projectRoot: string, change: string, changeRoot: string): string {
  reviewReady(projectRoot, change, changeRoot);
  const created = reviewReady(projectRoot, change, changeRoot);
  assert.equal(created.outcome, "job_created");
  return created.created_jobs[0];
}

test("计划规模预算：11 个任务含 2 个 REVIEW-FIX 只计 9，预算 10 时不询问", () => {
  const fx = setupProposeBudget({ taskCount: 9, includeFixTasks: 2 });
  try {
    const result = next(fx.projectRoot, fx.change, fx.changeRoot);
    assert.notEqual(result.path, "ask_user");
    if (result.path === "ask_user") {
      assert.notEqual(result.ask_user.scope.startsWith("plan_size_budget:"), true);
    }
  } finally { fx.cleanup(); }
});

test("计划规模预算：11 个非 fix 任务超预算时询问", () => {
  const fx = setupProposeBudget({ taskCount: 11 });
  try {
    const result = next(fx.projectRoot, fx.change, fx.changeRoot);
    assert.equal(result.path, "ask_user");
    if (result.path !== "ask_user") throw new Error("expected budget ask");
    assert.match(result.ask_user.scope, /^plan_size_budget:/);
    assert.deepEqual(result.ask_user.allowed_answers, [
      PLAN_SIZE_BUDGET_CONFIRM_ANSWER,
      PLAN_SIZE_BUDGET_SHRINK_ANSWER,
    ]);
  } finally { fx.cleanup(); }
});

test("计划规模预算：确认规模合理后进入 propose-ready", () => {
  const fx = setupProposeBudget({ taskCount: 11 });
  try {
    const ask = next(fx.projectRoot, fx.change, fx.changeRoot);
    assert.equal(ask.path, "ask_user");
    if (ask.path !== "ask_user") throw new Error("expected budget ask");
    assert.equal(recordUserDecisionContent(fx.projectRoot, fx.change, JSON.stringify({
      scope: ask.ask_user.scope,
      answer: PLAN_SIZE_BUDGET_CONFIRM_ANSWER,
      reason: "规模可接受",
    })).accepted, true);
    const after = next(fx.projectRoot, fx.change, fx.changeRoot);
    assert.equal(after.path, "next_command");
    assert.match(after.next_command, /propose-ready/);
  } finally { fx.cleanup(); }
});

test("计划规模预算：登记回去收缩且规模未变时 material_update_required", () => {
  const fx = setupProposeBudget({ taskCount: 11 });
  try {
    const ask = next(fx.projectRoot, fx.change, fx.changeRoot);
    assert.equal(ask.path, "ask_user");
    if (ask.path !== "ask_user") throw new Error("expected budget ask");
    assert.equal(recordUserDecisionContent(fx.projectRoot, fx.change, JSON.stringify({
      scope: ask.ask_user.scope,
      answer: PLAN_SIZE_BUDGET_SHRINK_ANSWER,
      reason: "需要收缩",
    })).accepted, true);
    const blocked = next(fx.projectRoot, fx.change, fx.changeRoot);
    assert.equal(blocked.path, "material_update_required");
    if (blocked.path !== "material_update_required") throw new Error("expected material update");
    assert.ok(blocked.errors.some(error => error.includes("10")));
  } finally { fx.cleanup(); }
});

test("计划规模预算：budget.tasks 为 null 时不询问", () => {
  const fx = setupProposeBudget({
    taskCount: 11,
    workflow: { budget: { tasks: null, tests: 20, review_fix_rounds: 2 } },
  });
  try {
    const result = next(fx.projectRoot, fx.change, fx.changeRoot);
    assert.notEqual(result.path, "ask_user");
  } finally { fx.cleanup(); }
});

test("计划规模预算：minimal 模式不询问", () => {
  const fx = setupProposeBudget({ taskCount: 11, workflow: { mode: "minimal" } });
  try {
    const result = next(fx.projectRoot, fx.change, fx.changeRoot);
    assert.notEqual(result.path, "ask_user");
  } finally { fx.cleanup(); }
});

test("计划规模预算：存在 open DEC 时不询问", () => {
  const fx = setupProposeBudget({ taskCount: 11 });
  try {
    writeFileSync(join(fx.changeRoot, "design.md"), [
      "# Design",
      "",
      "## 结构变更清单",
      "",
      "无",
      "",
      "## 待用户确认",
      "",
      "- [ ] DEC-001 是否采用子表？",
      "",
    ].join("\n"));
    const result = next(fx.projectRoot, fx.change, fx.changeRoot);
    assert.equal(result.path, "ask_user");
    if (result.path !== "ask_user") throw new Error("expected DEC ask");
    assert.match(result.ask_user.scope, /DEC-001/);
    assert.doesNotMatch(result.ask_user.scope, /^plan_size_budget:/);
  } finally { fx.cleanup(); }
});

test("propose-ready：超预算且无确认时 skip", () => {
  const fx = setupProposeBudget({ taskCount: 11 });
  try {
    const result = proposeReady(fx.projectRoot, fx.change, fx.changeRoot);
    assert.equal(result.events_written, 0);
    assert.match(result.message, /预算/);
  } finally { fx.cleanup(); }
});

test("review-fix 上限：两次自动修复后第三个 implementation 问题改 ask_user", () => {
  const fx = setupApplyDone();
  try {
    const jobId = "JOB-cap-test";
    appendReviewFixReopen(fx.projectRoot, fx.change, jobId, "CR-FIX-1");
    appendReviewFixReopen(fx.projectRoot, fx.change, jobId, "CR-FIX-2");
    assert.equal(countReviewFixReopensSinceStartApply(readEvents(fx.projectRoot, fx.change)), 2);

    reviewReady(fx.projectRoot, fx.change, fx.changeRoot);
    const created = reviewReady(fx.projectRoot, fx.change, fx.changeRoot);
    assert.equal(created.outcome, "job_created");
    const reviewJobId = created.created_jobs[0];
    submitImplementationFinding(fx.projectRoot, fx.change, fx.changeRoot, reviewJobId, "CR-IMPL-3");

    const ask = next(fx.projectRoot, fx.change, fx.changeRoot);
    assert.equal(ask.path, "ask_user");
    if (ask.path !== "ask_user") throw new Error("expected user decision");
    assert.equal(ask.ask_user.scope, `code_review_decision:${reviewJobId}#CR-IMPL-3`);
    assert.deepEqual(ask.ask_user.allowed_answers, [
      CODE_REVIEW_DECISION_ANSWER_LABELS.reopen_propose,
      CODE_REVIEW_DECISION_ANSWER_LABELS.reopen_apply,
      CODE_REVIEW_DECISION_ANSWER_LABELS.dismiss,
    ]);
  } finally { fx.cleanup(); }
});

test("review-fix 上限：未登记决定时 reopen --review-fix skip", () => {
  const fx = setupApplyDone();
  try {
    const jobId = "JOB-cap-skip";
    appendReviewFixReopen(fx.projectRoot, fx.change, jobId, "CR-FIX-1");
    appendReviewFixReopen(fx.projectRoot, fx.change, jobId, "CR-FIX-2");
    reviewReady(fx.projectRoot, fx.change, fx.changeRoot);
    const created = reviewReady(fx.projectRoot, fx.change, fx.changeRoot);
    const reviewJobId = created.created_jobs[0];
    submitImplementationFinding(fx.projectRoot, fx.change, fx.changeRoot, reviewJobId, "CR-IMPL-3");

    const blocked = reopen(fx.projectRoot, fx.change, fx.changeRoot, "apply", "try fix", {
      reviewFix: `${reviewJobId}#CR-IMPL-3`,
    });
    assert.equal(blocked.events_written, 0);
    assert.match(blocked.message, /缺少使用者确认/);
  } finally { fx.cleanup(); }
});

test("review-fix 上限：登记 reopen_apply 后可创建 REVIEW-FIX", () => {
  const fx = setupApplyDone();
  try {
    const jobId = "JOB-cap-apply";
    appendReviewFixReopen(fx.projectRoot, fx.change, jobId, "CR-FIX-1");
    appendReviewFixReopen(fx.projectRoot, fx.change, jobId, "CR-FIX-2");
    reviewReady(fx.projectRoot, fx.change, fx.changeRoot);
    const created = reviewReady(fx.projectRoot, fx.change, fx.changeRoot);
    const reviewJobId = created.created_jobs[0];
    submitImplementationFinding(fx.projectRoot, fx.change, fx.changeRoot, reviewJobId, "CR-IMPL-3");
    const scope = `code_review_decision:${reviewJobId}#CR-IMPL-3`;

    assert.equal(recordUserDecisionContent(fx.projectRoot, fx.change, JSON.stringify({
      scope,
      answer: CODE_REVIEW_DECISION_ANSWER_LABELS.reopen_apply,
      reason: "继续修实现",
    })).accepted, true);

    const reopened = reopen(fx.projectRoot, fx.change, fx.changeRoot, "apply", "cap override fix", {
      reviewFix: `${reviewJobId}#CR-IMPL-3`,
    });
    assert.equal(reopened.to_state, "apply");
    const tasks = readFileSync(join(fx.changeRoot, "tasks.md"), "utf8");
    assert.match(tasks, new RegExp(`REVIEW-FIX-${reviewJobId}#CR-IMPL-3`));
  } finally { fx.cleanup(); }
});

test("review-fix 上限：新一轮 start-apply 后计数重置", () => {
  const fx = setupApplyDone();
  try {
    appendReviewFixReopen(fx.projectRoot, fx.change, "JOB-old", "CR-FIX-1");
    appendReviewFixReopen(fx.projectRoot, fx.change, "JOB-old", "CR-FIX-2");
    assert.equal(countReviewFixReopensSinceStartApply(readEvents(fx.projectRoot, fx.change)), 2);

    appendEvent(fx.projectRoot, fx.change, makeEvent(fx.change, "transition_commit", {
      transition: "start-apply",
      from_state: "propose_ready",
      to_state: "apply",
      outcome: "advanced",
      created_job_ids: [],
      reason: "second apply round",
      apply_planning_baseline: applyPlanningBaseline(fx.changeRoot),
    }, { transitionId: "T-start-apply-2", idempotencyKey: "start-apply-2-key" }));
    assert.equal(countReviewFixReopensSinceStartApply(readEvents(fx.projectRoot, fx.change)), 0);

    reviewReady(fx.projectRoot, fx.change, fx.changeRoot);
    const created = reviewReady(fx.projectRoot, fx.change, fx.changeRoot);
    assert.equal(created.outcome, "job_created");
    const reviewJobId = created.created_jobs[0];
    submitImplementationFinding(fx.projectRoot, fx.change, fx.changeRoot, reviewJobId, "CR-IMPL-NEW");

    const plan = next(fx.projectRoot, fx.change, fx.changeRoot) as NextOutput & { path: "next_command" };
    assert.equal(plan.path, "next_command");
    assert.match(plan.next_command, new RegExp(`--review-fix ${reviewJobId}#CR-IMPL-NEW`));
  } finally { fx.cleanup(); }
});

test("planSizeBudgetScope 随任务与 TEST 数量变化", () => {
  const roundId = "round-1";
  const scopeA = planSizeBudgetScope(roundId, 11, 1);
  const scopeB = planSizeBudgetScope(roundId, 10, 1);
  assert.notEqual(scopeA, scopeB);
  assert.equal(planSizeBudgetScope(roundId, 11, 1), scopeA);
});
