// SuperSpec 流程引擎 — Phase 2 测试：explore + propose + 基础职责

import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, existsSync, readFileSync, readdirSync, symlinkSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { ensureChangeLayout, readEvents, appendEvent, makeEvent, rawFile, sha256File, sha256Text, docRef } from "../src/store.ts";
import { rebuildSnapshot } from "../src/sync.ts";
import { next } from "../src/next.ts";
import { proposeReady, startApply, transitionExplore } from "../src/transition.ts";
import { recordUserDecision, recordUserDecisionContent, recordJobSubmit, recordJobSubmitContent, jobsPacket } from "../src/record.ts";
import {
  countDiscoveryOpenQuestions,
  countProposeOpenQuestionsInContent,
  collectProposeQuestions,
  discoveryQuestionContextFingerprint,
  legacyDiscoveryOpenQuestionScope,
  legacyProposeOpenQuestionScope,
  parseDiscoveryOpenQuestions,
  parseTestContractEntries,
  proposeQuestionContextFingerprint,
  validateDiscovery,
  validateDiscoveryChainCoverage,
  validateProposalImpact,
  validateTasksDocument,
} from "../src/format.ts";
import { phaseConfirmationForBoundary, type PhaseDecisionAction } from "../src/phase_confirmation.ts";
import { currentExploreRoundId, exploreAnswerRegistrationPayload } from "../src/explore_round.ts";
import { currentProposeRoundId } from "../src/propose_round.ts";
import type { Job, JobRole, State } from "../src/types.ts";
import { confirmCurrentPhase, prepareCurrentPhaseConfirmation } from "./phase_confirmation_support.ts";
import { planningValidationProfileForNewRound } from "../src/phase_plan.ts";

// ===== 夹具 =====

const DOCUMENTATION_TASKS = [
  "# Tasks", "",
  "- [ ] TASK-001 Documentation fixture",
  "  执行依据:",
  "  - 测试:",
  "  - 设计: design.md#Design",
  "  - 来源: proposal.md#Test",
  "  - 验收: 文档说明完整",
  "  - 边界: 不改实现代码",
  "",
].join("\n");

const V2_DISABLED_PLANNING_PROFILE = {
  version: 2,
  openspec: { mode: "disabled" },
} as const;

const STRICT_DESIGN = [
  "# 设计",
  "",
  "## 背景",
  "",
  "## 设计目标",
  "",
  "## 非目标",
  "",
  "## 总体方案",
  "",
  "## 实现方案",
  "",
].join("\n");

function setupExplore(): { projectRoot: string; change: string; changeRoot: string; cleanup: () => void } {
  const projectRoot = mkdtempSync(join(tmpdir(), "superspec-p2-"));
  const change = "test-change";
  const changeRoot = join(projectRoot, "openspec", "changes", change);
  mkdirSync(join(changeRoot, ".superspec", "artifacts"), { recursive: true });
  writeFileSync(join(changeRoot, "proposal.md"), "# Proposal\n\nTest.\n");
  writeFileSync(join(changeRoot, "tasks.md"), DOCUMENTATION_TASKS);
  ensureChangeLayout(projectRoot, change);
  // seed 到 explore 状态
  appendEvent(projectRoot, change, makeEvent(change, "transition_commit", {
    transition: "init", from_state: "init", to_state: "init",
    outcome: "advanced", created_job_ids: [], reason: "init",
  }, { transitionId: "T-init", idempotencyKey: "init-key" }));
  appendEvent(projectRoot, change, makeEvent(change, "transition_commit", {
    transition: "explore", from_state: "init", to_state: "explore",
    outcome: "advanced", created_job_ids: [], reason: "enter explore",
  }, { transitionId: "T-explore", idempotencyKey: "explore-key" }));
  return {
    projectRoot, change, changeRoot,
    cleanup: () => rmSync(projectRoot, { recursive: true, force: true }),
  };
}

function setupPropose(): { projectRoot: string; change: string; changeRoot: string; cleanup: () => void } {
  const fx = setupExplore();
  // 写 discovery.md（无未确认问题）
  writeFileSync(join(fx.changeRoot, ".superspec", "artifacts", "discovery.md"), "# Discovery\n\nFound stuff.\n");
  return fx;
}

function reviewerReport(
  role: "critic" | "architect" | "test-engineer" = "critic",
  checkedPaths: string[] = [],
): string {
  return JSON.stringify({
    role,
    verdict: "pass",
    findings: [],
    review_scope: { checked_paths: checkedPaths },
    reviewer: { kind: "codex-subagent", id: "test-reviewer" },
    summary: "通过",
  });
}

function reviewerReportForJob(projectRoot: string, change: string, jobId: string): string {
  const packet = jobsPacket(projectRoot, change, jobId).packet;
  assert.ok(packet);
  return reviewerReport(
    packet.role as "critic" | "architect" | "test-engineer",
    packet.boundFiles.map(file => file.path),
  );
}

function failedReviewerReportForJob(projectRoot: string, change: string, jobId: string, findingId = "REVIEW-001"): string {
  const packet = jobsPacket(projectRoot, change, jobId).packet;
  assert.ok(packet);
  return JSON.stringify({
    role: packet.role,
    verdict: "fail",
    findings: [{ id: findingId, evidence: "direct evidence", description: "blocking issue" }],
    review_scope: { checked_paths: packet.boundFiles.map(file => file.path) },
    reviewer: { kind: "codex-subagent", id: "test-reviewer" },
  });
}

function reviewScopeForJob(projectRoot: string, change: string, jobId: string): { checked_paths: string[] } {
  const packet = jobsPacket(projectRoot, change, jobId).packet;
  assert.ok(packet);
  return { checked_paths: packet.boundFiles.map(file => file.path) };
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

test("propose 待用户确认 parser：只统计指定段落内未确认项", () => {
  assert.equal(countProposeOpenQuestionsInContent([
    "# Proposal",
    "",
    "- [ ] 普通 checklist 不应计数",
    "",
    "## 待用户确认",
    "",
    "- [ ] DEC-001 需要用户确认",
    "- [x] DEC-002 已确认",
    "",
    "## 其它段落",
    "",
    "- [ ] 不应计数",
  ].join("\n")), 1);

  assert.equal(countProposeOpenQuestionsInContent([
    "# Design",
    "",
    "## Open Questions",
    "",
    "- [ ] Confirm compatibility policy",
  ].join("\n")), 1);

  assert.equal(countProposeOpenQuestionsInContent([
    "# Tasks",
    "",
    "- [ ] TASK-001 tdd_required:true",
  ].join("\n")), 0);
});

test("discovery parser：新增章节中的 checklist 不作为待确认问题", () => {
  assert.equal(countDiscoveryOpenQuestions([
    "# Discovery",
    "",
    "## 当前代码事实",
    "",
    "- [ ] 普通事实 checklist 不应阻塞",
    "- src/transition.ts:284 explore 状态推进入口",
    "",
    "## 影响范围候选",
    "",
    "- [ ] 普通影响范围 checklist 不应阻塞",
    "",
    "## 待确认问题",
    "",
    "- [ ] DEC-001 需要用户确认",
    "- [x] DEC-002 已确认",
    "",
    "## 风险和边界",
    "",
    "- [ ] 这里已经不是待确认段，不应阻塞",
  ].join("\n")), 1);
});

test("discovery 链路五要素：legacy 缺段不硬失败", () => {
  const result = validateDiscoveryChainCoverage("# Discovery\n\nFound stuff.\n");
  assert.equal(result.ok, true);
  assert.equal(result.present, false);
});

test("discovery 链路五要素：缺必需列时失败", () => {
  const result = validateDiscoveryChainCoverage([
    "# Discovery",
    "",
    "## 链路五要素",
    "",
    "| ID | 发现方式 | 上游来源 | 证据 | 状态 |",
    "|---|---|---|---|---|",
    "| CHAIN-001 | rg 字段名 + 调用方反查 | 表单输入 | src/a.ts:10 | 已确认 |",
  ].join("\n"));
  assert.equal(result.ok, false);
  assert.match(result.message, /规则变形/);
});

test("discovery 链路五要素：空表失败", () => {
  const result = validateDiscoveryChainCoverage([
    "# Discovery",
    "",
    "## 链路五要素",
    "",
    "| ID | 发现方式 | 上游来源 | 规则变形 | 持久化语义 | 下游消费者 | 视图差异 | 未知/排除 | 证据 | 状态 |",
    "|---|---|---|---|---|---|---|---|---|---|",
  ].join("\n"));
  assert.equal(result.ok, false);
  assert.match(result.message, /至少需要一行/);
});

test("discovery 链路五要素：行级缺证据或状态失败", () => {
  const missingEvidence = validateDiscoveryChainCoverage([
    "# Discovery",
    "",
    "## 链路五要素",
    "",
    "| ID | 发现方式 | 上游来源 | 规则变形 | 持久化语义 | 下游消费者 | 视图差异 | 未知/排除 | 证据 | 状态 |",
    "|---|---|---|---|---|---|---|---|---|---|",
    "| CHAIN-001 | rg 字段名 + 调用方反查 | 表单输入 | 无 | 不落库 | 保存接口 | 无 | 无 |  | 已确认 |",
  ].join("\n"));
  assert.equal(missingEvidence.ok, false);
  assert.match(missingEvidence.message, /缺少证据/);

  const missingStatus = validateDiscoveryChainCoverage([
    "# Discovery",
    "",
    "## 链路五要素",
    "",
    "| ID | 发现方式 | 上游来源 | 规则变形 | 持久化语义 | 下游消费者 | 视图差异 | 未知/排除 | 证据 | 状态 |",
    "|---|---|---|---|---|---|---|---|---|---|",
    "| CHAIN-001 | rg 字段名 + 调用方反查 | 表单输入 | 无 | 不落库 | 保存接口 | 无 | 无 | src/a.ts:10 |  |",
  ].join("\n"));
  assert.equal(missingStatus.ok, false);
  assert.match(missingStatus.message, /缺少状态/);
  assert.match(missingStatus.message, /状态必须是 已确认、未知阻塞 或 未知非阻塞/);
});

test("discovery 链路五要素：行级缺核心列或未知排除失败", () => {
  const missingUpstream = validateDiscoveryChainCoverage([
    "# Discovery",
    "",
    "## 链路五要素",
    "",
    "| ID | 发现方式 | 上游来源 | 规则变形 | 持久化语义 | 下游消费者 | 视图差异 | 未知/排除 | 证据 | 状态 |",
    "|---|---|---|---|---|---|---|---|---|---|",
    "| CHAIN-001 | rg 字段名 + 调用方反查 |  | 无 | 不落库 | 保存接口 | 无 | 无 | src/a.ts:10 | 已确认 |",
  ].join("\n"));
  assert.equal(missingUpstream.ok, false);
  assert.match(missingUpstream.message, /缺少上游来源/);

  const missingUnknownExclusion = validateDiscoveryChainCoverage([
    "# Discovery",
    "",
    "## 链路五要素",
    "",
    "| ID | 发现方式 | 上游来源 | 规则变形 | 持久化语义 | 下游消费者 | 视图差异 | 未知/排除 | 证据 | 状态 |",
    "|---|---|---|---|---|---|---|---|---|---|",
    "| CHAIN-001 | rg 字段名 + 调用方反查 | 表单输入 | 无 | 不落库 | 保存接口 | 无 |  | src/a.ts:10 | 已确认 |",
  ].join("\n"));
  assert.equal(missingUnknownExclusion.ok, false);
  assert.match(missingUnknownExclusion.message, /缺少未知\/排除/);
});

test("discovery 链路五要素：未知阻塞必须进入待确认问题", () => {
  const result = validateDiscoveryChainCoverage([
    "# Discovery",
    "",
    "## 链路五要素",
    "",
    "| ID | 发现方式 | 上游来源 | 规则变形 | 持久化语义 | 下游消费者 | 视图差异 | 未知/排除 | 证据 | 状态 |",
    "|---|---|---|---|---|---|---|---|---|---|",
    "| CHAIN-001 | rg 字段名 + 调用方反查 | 表单输入 | 未知 | 不落库 | 保存接口 | 无 | 规则变形未知 | src/a.ts:10 | 未知阻塞 |",
  ].join("\n"));
  assert.equal(result.ok, false);
  assert.match(result.message, /未知阻塞/);
});

test("discovery 链路五要素：状态必须使用状态机枚举", () => {
  const result = validateDiscoveryChainCoverage([
    "# Discovery",
    "",
    "## 链路五要素",
    "",
    "| ID | 发现方式 | 上游来源 | 规则变形 | 持久化语义 | 下游消费者 | 视图差异 | 未知/排除 | 证据 | 状态 |",
    "|---|---|---|---|---|---|---|---|---|---|",
    "| CHAIN-001 | rg 字段名 | 表单输入 | 无 | 不落库 | 保存接口 | 无 | 无 | src/a.ts:10 | 已确认（已核实） |",
  ].join("\n"));
  assert.equal(result.ok, false);
  assert.match(result.message, /状态必须是/);
});

test("计划文档格式：状态机拒绝重复 task、隐藏 checkbox 与无效测试契约行", () => {
  assert.deepEqual(validateTasksDocument([
    "# Tasks",
    "",
    "- [ ] 1.1 First",
    "  - [ ] hidden task",
    "- [ ] 1.1 Duplicate",
  ].join("\n")), [
    "tasks.md task ID 重复：1.1",
    "tasks.md 第 4 行存在缩进 checkbox；只有顶格 checkbox 可以作为可执行 task",
  ]);

  const invalidId = parseTestContractEntries([
    "# Test Contract",
    "",
    "| test_id | scenario |",
    "|---|---|",
    "| TEST-001 | |",
  ].join("\n"));
  assert.equal(invalidId.ok, false);
  assert.match(invalidId.message, /缺少 scenario/);
});

test("proposal Impact：状态机只校验表结构，不判断影响理由的业务真伪", () => {
  assert.equal(validateProposalImpact([
    "# Proposal",
    "",
    "## Impact",
    "",
    "| Area | Reason |",
    "|---|---|",
    "| src/a.ts | 一段可由 Critic 审查的理由 |",
  ].join("\n")).ok, true);
  assert.match(validateProposalImpact("# Proposal\n").message, /Impact/);
});

test("discovery 链路五要素：发现方式空泛与否由 critic 审查，引擎不拦截", () => {
  const result = validateDiscoveryChainCoverage([
    "# Discovery",
    "",
    "## 链路五要素",
    "",
    "| ID | 发现方式 | 上游来源 | 规则变形 | 持久化语义 | 下游消费者 | 视图差异 | 未知/排除 | 证据 | 状态 |",
    "|---|---|---|---|---|---|---|---|---|---|",
    "| CHAIN-001 | 代码审查 | 表单输入 | 无 | 不落库 | 保存接口 | 无 | 无 | src/a.ts:10 | 已确认 |",
  ].join("\n"));
  assert.equal(result.ok, true);
});

test("discovery parser：按段落顺序返回 Q 标识、历史兼容标识和文档指纹", () => {
  const questions = parseDiscoveryOpenQuestions([
    "# Discovery",
    "",
    "## 待确认问题",
    "",
    "- [x] Q-000 已解决问题",
    "- [ ] Q-001 当前业务选择",
    "- [ ] 没有 ID 的历史问题",
    "",
    "## 其它章节",
    "- [ ] 不应被解析",
  ].join("\n"));

  assert.deepEqual(questions.map(question => [question.id, question.ordinal, question.text]), [
    ["Q-001", 2, "Q-001 当前业务选择"],
    ["item-3", 3, "没有 ID 的历史问题"],
  ]);
  assert.match(questions[0].documentFingerprint, /^sha256:[a-f0-9]{64}$/);
  assert.equal(questions[0].documentFingerprint, questions[1].documentFingerprint);
});

test("discovery 链路五要素：单元格内转义竖线不破坏解析", () => {
  const result = validateDiscoveryChainCoverage([
    "# Discovery",
    "",
    "## 链路五要素",
    "",
    "| ID | 发现方式 | 上游来源 | 规则变形 | 持久化语义 | 下游消费者 | 视图差异 | 未知/排除 | 证据 | 状态 |",
    "|---|---|---|---|---|---|---|---|---|---|",
    "| CHAIN-001 | rg \"status\\|flag\" + 调用方反查 | 表单输入 | 无 | 不落库 | 保存接口 | 无 | 无 | src/a.ts:10 | 已确认 |",
  ].join("\n"));
  assert.equal(result.ok, true);
});

test("validateDiscovery：合法链路五要素可通过", () => {
  const fx = setupExplore();
  try {
    writeFileSync(join(fx.changeRoot, ".superspec", "artifacts", "discovery.md"), [
      "# Discovery",
      "",
      "## 链路五要素",
      "",
      "| ID | 发现方式 | 上游来源 | 规则变形 | 持久化语义 | 下游消费者 | 视图差异 | 未知/排除 | 证据 | 状态 |",
      "|---|---|---|---|---|---|---|---|---|---|",
      "| CHAIN-001 | rg 字段名 + 调用方反查 | 表单输入 | 无 | 不落库 | 保存接口 | 无 | 无 | src/a.ts:10 | 已确认 |",
      "",
      "## 待确认问题",
      "",
    ].join("\n"));
    const result = validateDiscovery(fx.changeRoot);
    assert.equal(result.ok, true);
  } finally { fx.cleanup(); }
});

test("validateDiscovery：未知阻塞有待确认项时结构有效，交由当前问题处理", () => {
  const fx = setupExplore();
  try {
    writeFileSync(join(fx.changeRoot, ".superspec", "artifacts", "discovery.md"), [
      "# Discovery",
      "",
      "## 链路五要素",
      "",
      "| ID | 发现方式 | 上游来源 | 规则变形 | 持久化语义 | 下游消费者 | 视图差异 | 未知/排除 | 证据 | 状态 |",
      "|---|---|---|---|---|---|---|---|---|---|",
      "| CHAIN-001 | rg 字段名 + 调用方反查 | 表单输入 | 未知 | 不落库 | 保存接口 | 无 | 规则变形未知 | src/a.ts:10 | 未知阻塞 |",
      "",
      "## 待确认问题",
      "",
      "- [ ] CHAIN-001 规则变形是否存在？",
    ].join("\n"));
    const result = validateDiscovery(fx.changeRoot);
    assert.equal(result.ok, true);
    assert.equal(result.openCount, 1);
    assert.match(result.message, /待确认问题/);
  } finally { fx.cleanup(); }
});

test("validateDiscovery：声明链路五要素的新格式会执行结构校验", () => {
  const fx = setupExplore();
  try {
    writeFileSync(join(fx.changeRoot, ".superspec", "artifacts", "discovery.md"), [
      "# Discovery",
      "",
      "## 链路五要素",
      "",
      "| ID | 证据 | 状态 |",
      "|---|---|---|",
      "| CHAIN-001 | src/a.ts:10 | 已确认 |",
    ].join("\n"));
    const result = validateDiscovery(fx.changeRoot);
    assert.equal(result.ok, false);
    assert.match(result.message, /发现方式/);
  } finally { fx.cleanup(); }
});

test("explore→propose：无 discovery.md 时不推进", () => {
  const fx = setupExplore();
  try {
    const result = transitionExplore(fx.projectRoot, fx.change, fx.changeRoot);
    assert.ok(result.message.includes("discovery.md 不存在"), result.message);
    assert.equal(result.events_written, 0);

    const snapshot = rebuildSnapshot(fx.projectRoot, fx.change, fx.changeRoot);
    assert.equal(snapshot.state, "explore"); // 状态不变
  } finally { fx.cleanup(); }
});

test("explore→propose：discovery.md 有未确认问题时不推进", () => {
  const fx = setupExplore();
  try {
    writeFileSync(join(fx.changeRoot, ".superspec", "artifacts", "discovery.md"),
      "# Discovery\n\n## 待确认问题\n\n- [ ] 问题1的描述\n");
    const result = transitionExplore(fx.projectRoot, fx.change, fx.changeRoot);
    assert.match(result.message, /仍有需要确认的事项/);
    assert.equal(result.events_written, 0);
  } finally { fx.cleanup(); }
});

test("explore→propose normal：完成后须确认才推进", () => {
  const fx = setupPropose();
  try {
    const review = transitionExplore(fx.projectRoot, fx.change, fx.changeRoot, "normal");
    assert.equal(review.outcome, "job_created");
    assert.equal(review.required_jobs?.[0]?.role, "critic");
    confirmCurrentPhase(fx.projectRoot, fx.change, fx.changeRoot, "normal");
    const result = transitionExplore(fx.projectRoot, fx.change, fx.changeRoot, "normal");
    assert.equal(result.outcome, "advanced");
    assert.equal(result.to_state, "propose");

    const snapshot = rebuildSnapshot(fx.projectRoot, fx.change, fx.changeRoot);
    assert.equal(snapshot.state, "propose");
  } finally { fx.cleanup(); }
});

test("next 在 explore 无 discovery 时返回 canonical artifact_required", () => {
  const fx = setupExplore();
  try {
    const result = next(fx.projectRoot, fx.change, fx.changeRoot);
    assert.deepEqual(result, {
      state: "explore",
      path: "artifact_required",
      artifact: {
        kind: "discovery",
        path: "openspec/changes/test-change/.superspec/artifacts/discovery.md",
        operation: "create_or_update",
      },
      resume: {
        argv: ["superspec", "transition", "next", "--change", "test-change"],
      },
      reason: "discovery.md 不存在",
    });
  } finally { fx.cleanup(); }
});

test("next 在 explore 有 discovery 无问题时返回 transition 命令", () => {
  const fx = setupPropose();
  try {
    const result = next(fx.projectRoot, fx.change, fx.changeRoot);
    assert.equal(result.path, "next_command");
    assert.ok(result.next_command.includes("explore"));
    assert.doesNotMatch(result.next_command, /--risk strict/);
  } finally { fx.cleanup(); }
});

test("next 在 explore 显式 normal 风险时返回阶段确认", () => {
  const fx = setupPropose();
  try {
    const result = prepareCurrentPhaseConfirmation(fx.projectRoot, fx.change, fx.changeRoot, "normal");
    assert.equal(result.path, "ask_user");
    assert.match(result.ask_user.scope, /^phase_confirmation:explore_to_propose:/);
    const actions = result.ask_user.actions as PhaseDecisionAction[];
    assert.deepEqual(result.ask_user.allowed_answers, actions.map(action => action.label));
    assert.deepEqual(actions.map(action => [action.decision, action.label]), [
      ["advance", "确认进入计划阶段"],
      ["stay", "留在探索阶段继续完善"],
    ]);
    const [advance, stay] = actions;
    assert.deepEqual(advance.record_argv, [
      "superspec", "record", "user-decision", "--change", fx.change, "--input", "-",
    ]);
    assert.deepEqual(advance.record_input, {
      scope: result.ask_user.scope,
      question: result.ask_user.question,
      answer: advance.label,
      review_risk: "normal",
    });
    assert.equal(advance.resume.kind, "next");
    assert.deepEqual(advance.resume.argv, [
      "superspec", "transition", "next", "--change", fx.change,
    ]);
    assert.equal(stay.reason, "required");
    assert.equal(stay.resume.kind, "continue_current_phase");
    assert.deepEqual(stay.resume.next_argv_after_completion, [
      "superspec", "transition", "next", "--change", fx.change,
    ]);
  } finally { fx.cleanup(); }
});

test("阶段确认 action resume 保留 minimal risk", () => {
  const fx = setupPropose();
  try {
    const result = next(fx.projectRoot, fx.change, fx.changeRoot, "minimal");
    assert.equal(result.path, "ask_user");
    const actions = result.ask_user.actions as PhaseDecisionAction[];
    const advance = actions.find(action => action.decision === "advance");
    const stay = actions.find(action => action.decision === "stay");
    assert.ok(advance);
    assert.ok(stay);
    assert.equal(advance.resume.kind, "next");
    assert.deepEqual(advance.resume.argv, [
      "superspec", "transition", "next", "--change", fx.change,
    ]);
    assert.equal(stay.resume.kind, "continue_current_phase");
    assert.deepEqual(stay.resume.next_argv_after_completion, [
      "superspec", "transition", "next", "--change", fx.change,
    ]);
  } finally { fx.cleanup(); }
});

test("阶段确认：仅接受精确答复，材料变化后旧 scope 失效", () => {
  const fx = setupPropose();
  try {
    writeFileSync(join(fx.projectRoot, ".superspec", "config.json"), JSON.stringify({ workflow: { mode: "normal" } }));
    const ask = prepareCurrentPhaseConfirmation(fx.projectRoot, fx.change, fx.changeRoot, "normal");
    assert.equal(ask.path, "ask_user");
    const actions = ask.ask_user.actions as PhaseDecisionAction[];
    const advance = actions.find(action => action.decision === "advance");
    const stay = actions.find(action => action.decision === "stay");
    assert.ok(advance);
    assert.ok(stay);
    const acceptedInput = JSON.stringify(advance.record_input);

    const ambiguous = recordUserDecisionContent(fx.projectRoot, fx.change, JSON.stringify({
      scope: ask.ask_user.scope,
      question: ask.ask_user.question,
      answer: "继续",
      review_risk: "normal",
    }));
    assert.equal(ambiguous.accepted, false);
    assert.match(ambiguous.message, /必须精确/);

    const invalidRisk = recordUserDecisionContent(fx.projectRoot, fx.change, JSON.stringify({
      ...advance.record_input,
      review_risk: "unknown",
      answer: "继续",
    }));
    assert.equal(invalidRisk.accepted, false);
    assert.match(invalidRisk.message, /必须精确/);

    const missingReason = recordUserDecisionContent(
      fx.projectRoot,
      fx.change,
      JSON.stringify(stay.record_input),
    );
    assert.equal(missingReason.accepted, false);
    assert.match(missingReason.message, /补充|核对|原因/);

    const blocked = transitionExplore(fx.projectRoot, fx.change, fx.changeRoot, "normal");
    assert.equal(blocked.events_written, 0);
    assert.match(blocked.message, /用户确认/);

    const recorded = recordUserDecisionContent(fx.projectRoot, fx.change, acceptedInput);
    assert.equal(recorded.accepted, true);
    const repeated = recordUserDecisionContent(fx.projectRoot, fx.change, acceptedInput);
    assert.equal(repeated.accepted, true);
    assert.match(repeated.message, /幂等/);

    const stayInput = JSON.stringify({ ...stay.record_input, reason: "继续核对调用链" });
    assert.equal(recordUserDecisionContent(fx.projectRoot, fx.change, stayInput).accepted, true);
    const stayEvent = readEvents(fx.projectRoot, fx.change).findLast(event =>
      event.event_type === "user_decision_recorded" &&
      (event.payload as { accepted?: unknown }).accepted === true
    );
    assert.deepEqual(stayEvent?.payload.phase_confirmation, {
      boundary: "explore_to_propose",
      decision: "stay",
      review_risk: "normal",
    });
    assert.equal(stayEvent?.payload.reason, "继续核对调用链");
    assert.equal(transitionExplore(fx.projectRoot, fx.change, fx.changeRoot, "normal").events_written, 0);

    const changedMind = recordUserDecisionContent(fx.projectRoot, fx.change, acceptedInput);
    assert.equal(changedMind.accepted, true);
    assert.doesNotMatch(changedMind.message, /幂等/);
    const acceptedPhaseDecisions = readEvents(fx.projectRoot, fx.change).filter(event =>
      event.event_type === "user_decision_recorded" &&
      (event.payload as { accepted?: unknown; phase_confirmation?: unknown }).accepted === true &&
      (event.payload as { phase_confirmation?: unknown }).phase_confirmation != null
    );
    assert.deepEqual(acceptedPhaseDecisions.map(event =>
      (event.payload.phase_confirmation as { decision: string }).decision
    ), ["advance", "stay", "advance"]);

    writeFileSync(join(fx.changeRoot, ".superspec", "artifacts", "discovery.md"), "# Discovery\n\nChanged after confirmation.\n");
    const stale = recordUserDecisionContent(fx.projectRoot, fx.change, acceptedInput);
    assert.equal(stale.accepted, false);
    assert.match(stale.message, /已失效|重新执行 next/);

    const refreshed = prepareCurrentPhaseConfirmation(fx.projectRoot, fx.change, fx.changeRoot, "normal");
    assert.equal(refreshed.path, "ask_user");
    assert.notEqual(refreshed.ask_user.scope, ask.ask_user.scope);
  } finally { fx.cleanup(); }
});

test("next 在 propose 待用户确认问题优先于审查 job", () => {
  const fx = setupPropose();
  try {
    confirmCurrentPhase(fx.projectRoot, fx.change, fx.changeRoot, "normal");
    const entered = transitionExplore(fx.projectRoot, fx.change, fx.changeRoot, "normal");
    assert.equal(entered.to_state, "propose");
    writeFileSync(join(fx.changeRoot, "proposal.md"), [
      "# Proposal",
      "",
      "## 待用户确认",
      "",
      "- [ ] DEC-001 是否兼容旧 API？",
    ].join("\n"));

    const job = {
      job_id: "JOB-propose-critic",
      role: "critic",
      state: "requested",
      boundFiles: [],
      packet_digest: "sha256:review",
      created_from_transition: "propose-ready",
      created_at: new Date().toISOString(),
    };
    appendEvent(fx.projectRoot, fx.change, makeEvent(fx.change, "transition_commit", {
      transition: "propose-ready",
      from_state: "propose",
      to_state: "propose",
      outcome: "job_created",
      created_job_ids: [job.job_id],
      new_jobs: [job],
      reason: "review job",
    }, { transitionId: "T-propose-job", idempotencyKey: "propose-job-key" }));

    const result = next(fx.projectRoot, fx.change, fx.changeRoot);
    assert.equal(result.path, "ask_user");
    assert.match(result.ask_user.scope, /^propose_open_question:sha256:[a-f0-9]{64}:DEC-001$/);
    assert.match(result.ask_user.question, /是否兼容旧 API/);
    assert.deepEqual(result.ask_user.record_argv, [
      "superspec", "record", "user-decision", "--change", fx.change, "--input", "-",
    ]);
    assert.deepEqual(result.ask_user.record_input, {
      scope: result.ask_user.scope,
      question: result.ask_user.question,
      answer: null,
    });
    assert.deepEqual(result.ask_user.required_fields, ["answer"]);

    const recorded = recordUserDecisionContent(fx.projectRoot, fx.change, JSON.stringify({
      scope: result.ask_user.scope,
      answer: "保留旧 API 兼容层",
    }));
    assert.equal(recorded.accepted, true);
    const currentDecision = collectProposeQuestions(fx.changeRoot).find(question => question.status === "open");
    assert.ok(currentDecision);
    const legacyScope = legacyProposeOpenQuestionScope(currentDecision, currentProposeRoundId(readEvents(fx.projectRoot, fx.change)));
    assert.equal(recordUserDecisionContent(fx.projectRoot, fx.change, JSON.stringify({
      scope: legacyScope,
      answer: "保留旧 API 兼容层",
    })).accepted, true);
    assert.equal(recordUserDecisionContent(fx.projectRoot, fx.change, JSON.stringify({
      scope: legacyScope,
      answer: "移除旧 API",
    })).accepted, false);
    const beforeWriteback = next(fx.projectRoot, fx.change, fx.changeRoot);
    assert.equal(beforeWriteback.path, "ask_user");
    assert.equal(beforeWriteback.ask_user.scope, result.ask_user.scope);

    writeFileSync(join(fx.changeRoot, "proposal.md"), [
      "# Proposal",
      "",
      "## 待用户确认",
      "",
      "- [x] DEC-001 是否兼容旧 API？",
    ].join("\n"));
    writeFileSync(join(fx.changeRoot, ".superspec", "artifacts", "test-contract.md"), "# Test Contract\n");

    const afterConfirmed = next(fx.projectRoot, fx.change, fx.changeRoot);
    assert.equal(afterConfirmed.path, "required_job");
    assert.equal(afterConfirmed.required_jobs[0].job_id, job.job_id);
    assert.equal(afterConfirmed.required_jobs[0].role, "critic");
    assert.deepEqual(afterConfirmed.required_jobs[0].packet_argv, [
      "superspec", "jobs", "packet", "--change", fx.change, "--job", job.job_id,
    ]);
    const decision = readEvents(fx.projectRoot, fx.change).find(event =>
      event.event_type === "user_decision_recorded" &&
      (event.payload as { propose_open_question?: unknown }).propose_open_question != null
    );
    assert.equal((decision?.payload as { propose_open_question?: { question_id?: unknown } }).propose_open_question?.question_id, "DEC-001");
  } finally { fx.cleanup(); }
});

test("Propose 设计决定：无关材料变化不重复提问，问题修订后旧 scope 失效", () => {
  const fx = setupPropose();
  try {
    confirmCurrentPhase(fx.projectRoot, fx.change, fx.changeRoot, "normal");
    const entered = transitionExplore(fx.projectRoot, fx.change, fx.changeRoot, "normal");
    assert.equal(entered.to_state, "propose");
    writeFileSync(join(fx.changeRoot, "design.md"), [
      "# Design",
      "",
      "## 待用户确认",
      "",
      "- [ ] DEC-001 兼容策略：A 迁移 / B fallback。建议：A",
      "- [ ] DEC-002 发布方式：A 一次 / B 分批。建议：B",
    ].join("\n"));

    const first = next(fx.projectRoot, fx.change, fx.changeRoot);
    assert.equal(first.path, "ask_user");
    assert.match(first.ask_user.scope, /:DEC-001$/);

    writeFileSync(join(fx.changeRoot, "design.md"), [
      "# Design",
      "",
      "## 背景",
      "新增事实使原决定上下文变化。",
      "",
      "## 待用户确认",
      "",
      "- [ ] DEC-001 兼容策略：A 迁移 / B fallback。建议：A",
      "- [ ] DEC-002 发布方式：A 一次 / B 分批。建议：B",
    ].join("\n"));
    const unchanged = next(fx.projectRoot, fx.change, fx.changeRoot);
    assert.equal(unchanged.path, "ask_user");
    if (unchanged.path !== "ask_user") throw new Error("expected unchanged Propose decision");
    assert.equal(unchanged.ask_user.scope, first.ask_user.scope);

    writeFileSync(join(fx.changeRoot, "design.md"), [
      "# Design",
      "",
      "## 背景",
      "新增事实使原决定上下文变化。",
      "",
      "## 待用户确认",
      "",
      "- [ ] DEC-001 兼容策略：A 双写迁移 / B fallback。建议：A",
      "- [ ] DEC-002 发布方式：A 一次 / B 分批。建议：B",
    ].join("\n"));
    const stale = recordUserDecisionContent(fx.projectRoot, fx.change, JSON.stringify({ scope: first.ask_user.scope, answer: "选择 A" }));
    assert.equal(stale.accepted, false);

    const refreshed = next(fx.projectRoot, fx.change, fx.changeRoot);
    assert.equal(refreshed.path, "ask_user");
    if (refreshed.path !== "ask_user") throw new Error("expected refreshed Propose decision");
    assert.notEqual(refreshed.ask_user.scope, first.ask_user.scope);
    assert.equal(recordUserDecisionContent(fx.projectRoot, fx.change, JSON.stringify({ scope: refreshed.ask_user.scope, answer: "选择 A" })).accepted, true);

    writeFileSync(join(fx.changeRoot, "design.md"), [
      "# Design",
      "",
      "## 背景",
      "新增事实使原决定上下文变化。",
      "",
      "## 待用户确认",
      "",
      "- [x] DEC-001 兼容策略：A 迁移 / B fallback。建议：A",
      "- [ ] DEC-002 发布方式：A 一次 / B 分批。建议：B",
    ].join("\n"));
    const second = next(fx.projectRoot, fx.change, fx.changeRoot);
    assert.equal(second.path, "ask_user");
    if (second.path !== "ask_user") throw new Error("expected second Propose decision");
    assert.match(second.ask_user.scope, /:DEC-002$/);

    writeFileSync(join(fx.changeRoot, "design.md"), [
      "# Design",
      "",
      "## 背景",
      "新增事实使原决定上下文变化。",
      "",
      "## 待用户确认",
      "",
      "- [x] DEC-001 兼容策略：A 迁移 / B fallback。建议：A",
      "- [x] DEC-002 未经登记直接勾选",
    ].join("\n"));
    const missingRegistration = next(fx.projectRoot, fx.change, fx.changeRoot);
    assert.equal(missingRegistration.path, "material_update_required");
  } finally { fx.cleanup(); }
});

test("Propose 决策身份：legacy 答复在无关材料变化后仍阻止冲突 v2 答复", () => {
  const fx = setupPropose();
  try {
    confirmCurrentPhase(fx.projectRoot, fx.change, fx.changeRoot, "normal");
    transitionExplore(fx.projectRoot, fx.change, fx.changeRoot, "normal");
    const proposalPath = join(fx.changeRoot, "proposal.md");
    const content = "# Proposal\n\n## 背景\n\n旧接口位于模块 A。\n\n## 待用户确认\n\n- [ ] DEC-001 是否兼容旧 API？\n";
    writeFileSync(proposalPath, content);
    const presented = next(fx.projectRoot, fx.change, fx.changeRoot);
    assert.equal(presented.path, "ask_user");
    const current = collectProposeQuestions(fx.changeRoot).find(question => question.status === "open");
    assert.ok(current);
    const legacyScope = legacyProposeOpenQuestionScope(current, currentProposeRoundId(readEvents(fx.projectRoot, fx.change)));
    assert.equal(recordUserDecisionContent(fx.projectRoot, fx.change, JSON.stringify({ scope: legacyScope, answer: "保留兼容" })).accepted, true);

    writeFileSync(proposalPath, content.replace("旧接口位于模块 A。", "旧接口位于模块 A，另有一处调用。"));
    const stable = next(fx.projectRoot, fx.change, fx.changeRoot);
    assert.equal(stable.path, "ask_user");
    assert.equal(stable.ask_user.scope, presented.ask_user.scope);
    assert.equal(recordUserDecisionContent(fx.projectRoot, fx.change, JSON.stringify({ scope: stable.ask_user.scope, answer: "移除兼容" })).accepted, false);
  } finally { fx.cleanup(); }
});

test("Propose 决策身份：升级前 legacy accepted 事件阻止冲突 v2 答复", () => {
  const fx = setupPropose();
  try {
    confirmCurrentPhase(fx.projectRoot, fx.change, fx.changeRoot, "normal");
    transitionExplore(fx.projectRoot, fx.change, fx.changeRoot, "normal");
    const proposalPath = join(fx.changeRoot, "proposal.md");
    writeFileSync(proposalPath, "# Proposal\n\n## 待用户确认\n\n- [ ] DEC-001 是否兼容旧 API？\n");
    const events = readEvents(fx.projectRoot, fx.change);
    const current = collectProposeQuestions(fx.changeRoot).find(question => question.status === "open");
    assert.ok(current);
    const roundId = currentProposeRoundId(events);
    const legacyScope = legacyProposeOpenQuestionScope(current, roundId);
    appendEvent(fx.projectRoot, fx.change, makeEvent(fx.change, "user_decision_recorded", {
      scope: legacyScope,
      question: "是否兼容旧 API？",
      answer: "保留兼容",
      accepted: true,
      propose_open_question: {
        round_id: roundId,
        path: current.path,
        question_id: current.id,
        question_ordinal: current.ordinal,
        context_fingerprint: proposeQuestionContextFingerprint(readFileSync(proposalPath, "utf8"), current),
      },
    }));
    const presented = next(fx.projectRoot, fx.change, fx.changeRoot);
    assert.equal(presented.path, "ask_user");
    assert.equal(recordUserDecisionContent(fx.projectRoot, fx.change, JSON.stringify({ scope: presented.ask_user.scope, answer: "移除兼容" })).accepted, false);
    writeFileSync(proposalPath, "# Proposal\n\n## 待用户确认\n\n- [x] DEC-001 是否兼容旧 API？\n");
    assert.notEqual(next(fx.projectRoot, fx.change, fx.changeRoot).path, "material_update_required");
  } finally { fx.cleanup(); }
});

test("Explore 决策 basis：A→B→A 不用 B 的答复关闭 A", () => {
  const fx = setupExplore();
  try {
    const discoveryPath = join(fx.changeRoot, ".superspec", "artifacts", "discovery.md");
    const a = "# Discovery\n\n## 待确认问题\n\n- [ ] Q-001 兼容策略：A 保留 / B 移除。建议：A。\n";
    const b = a.replace("建议：A。", "新增证据支持移除，建议：B。");
    writeFileSync(discoveryPath, a);
    const firstA = next(fx.projectRoot, fx.change, fx.changeRoot);
    assert.equal(firstA.path, "ask_user");
    writeFileSync(discoveryPath, b);
    const shownB = next(fx.projectRoot, fx.change, fx.changeRoot);
    assert.equal(shownB.path, "ask_user");
    assert.notEqual(shownB.ask_user.scope, firstA.ask_user.scope);
    assert.equal(recordUserDecisionContent(fx.projectRoot, fx.change, JSON.stringify({ scope: shownB.ask_user.scope, answer: "选择 B" })).accepted, true);

    writeFileSync(discoveryPath, a);
    const returnedA = next(fx.projectRoot, fx.change, fx.changeRoot);
    assert.equal(returnedA.path, "ask_user");
    assert.equal(returnedA.ask_user.scope, firstA.ask_user.scope);
    const latestPresented = readEvents(fx.projectRoot, fx.change).findLast(event => event.event_type === "user_question_presented");
    assert.equal((latestPresented?.payload as { scope?: unknown }).scope, returnedA.ask_user.scope);
    writeFileSync(discoveryPath, a.replace("- [ ]", "- [x]"));
    assert.equal(next(fx.projectRoot, fx.change, fx.changeRoot).path, "material_update_required");

    writeFileSync(discoveryPath, a);
    assert.equal(recordUserDecisionContent(fx.projectRoot, fx.change, JSON.stringify({ scope: returnedA.ask_user.scope, answer: "选择 A" })).accepted, true);
    writeFileSync(discoveryPath, a.replace("- [ ]", "- [x]"));
    assert.notEqual(next(fx.projectRoot, fx.change, fx.changeRoot).path, "material_update_required");
  } finally { fx.cleanup(); }
});

test("Propose 决策 basis：A→B→A 不用 B 的答复关闭 A", () => {
  const fx = setupPropose();
  try {
    confirmCurrentPhase(fx.projectRoot, fx.change, fx.changeRoot, "normal");
    transitionExplore(fx.projectRoot, fx.change, fx.changeRoot, "normal");
    const proposalPath = join(fx.changeRoot, "proposal.md");
    const a = "# Proposal\n\n## 待用户确认\n\n- [ ] DEC-001 兼容策略：A 保留 / B 移除。建议：A。\n";
    const b = a.replace("建议：A。", "新增证据支持移除，建议：B。");
    writeFileSync(proposalPath, a);
    const firstA = next(fx.projectRoot, fx.change, fx.changeRoot);
    assert.equal(firstA.path, "ask_user");
    writeFileSync(proposalPath, b);
    const shownB = next(fx.projectRoot, fx.change, fx.changeRoot);
    assert.equal(shownB.path, "ask_user");
    assert.equal(recordUserDecisionContent(fx.projectRoot, fx.change, JSON.stringify({ scope: shownB.ask_user.scope, answer: "选择 B" })).accepted, true);

    writeFileSync(proposalPath, a);
    const returnedA = next(fx.projectRoot, fx.change, fx.changeRoot);
    assert.equal(returnedA.path, "ask_user");
    const latestPresented = readEvents(fx.projectRoot, fx.change).findLast(event => event.event_type === "user_question_presented");
    assert.equal((latestPresented?.payload as { scope?: unknown }).scope, returnedA.ask_user.scope);
    writeFileSync(proposalPath, a.replace("- [ ]", "- [x]"));
    assert.equal(next(fx.projectRoot, fx.change, fx.changeRoot).path, "material_update_required");

    writeFileSync(proposalPath, a);
    assert.equal(recordUserDecisionContent(fx.projectRoot, fx.change, JSON.stringify({ scope: returnedA.ask_user.scope, answer: "选择 A" })).accepted, true);
    writeFileSync(proposalPath, a.replace("- [ ]", "- [x]"));
    assert.notEqual(next(fx.projectRoot, fx.change, fx.changeRoot).path, "material_update_required");
  } finally { fx.cleanup(); }
});

test("next 在 explore 先要求 discovery artifact，再返回阶段 critic job", () => {
  const fx = setupExplore();
  try {
    appendOpenJob(fx.projectRoot, fx.change, "explore", {
      job_id: "JOB-explore-critic",
      role: "critic",
      created_from_transition: "explore",
    });

    const result = next(fx.projectRoot, fx.change, fx.changeRoot);
    assert.equal(result.path, "artifact_required");
    assert.equal(result.artifact.kind, "discovery");
  } finally { fx.cleanup(); }
});

test("next 在 explore 有当前 Q 时优先于已有 critic job", () => {
  const fx = setupPropose();
  try {
    const discoveryPath = join(fx.changeRoot, ".superspec", "artifacts", "discovery.md");
    writeFileSync(discoveryPath, "# Discovery\n\n## 待确认问题\n\n- [ ] Q-001 是否保留旧行为？\n");
    appendOpenJob(fx.projectRoot, fx.change, "explore", {
      job_id: "JOB-legacy-explore-critic",
      role: "critic",
      created_from_transition: "explore",
    });

    const result = next(fx.projectRoot, fx.change, fx.changeRoot);
    assert.equal(result.path, "ask_user");
    assert.match(result.ask_user.scope, /^explore_open_question:sha256:[a-f0-9]{64}:Q-001$/);
  } finally { fx.cleanup(); }
});

test("并发 transition next：锁竞争不重复登记用户问题，重试保持幂等", async () => {
  const fx = setupExplore();
  try {
    writeFileSync(join(fx.changeRoot, ".superspec", "artifacts", "discovery.md"), [
      "# Discovery",
      "",
      "## 待确认问题",
      "",
      "- [ ] Q-001 兼容策略：A 保留 / B 移除。建议：A；影响旧调用方。",
    ].join("\n"));
    const cli = new URL("../src/cli.ts", import.meta.url).pathname;
    const runNext = () => new Promise<{ code: number | null; stdout: string; stderr: string }>((resolve, reject) => {
      const child = spawn(process.execPath, [cli, "transition", "next", "--change", fx.change], {
        cwd: fx.projectRoot,
        stdio: ["ignore", "pipe", "pipe"],
      });
      let stdout = "";
      let stderr = "";
      child.stdout.setEncoding("utf8").on("data", chunk => { stdout += chunk; });
      child.stderr.setEncoding("utf8").on("data", chunk => { stderr += chunk; });
      child.on("error", reject);
      child.on("close", code => resolve({ code, stdout, stderr }));
    });

    const [first, second] = await Promise.all([runNext(), runNext()]);
    const successful = [first, second].filter(result => result.code === 0);
    const contended = [first, second].filter(result => result.code !== 0);
    assert.ok(successful.length >= 1);
    assert.ok(contended.length <= 1);
    for (const result of contended) assert.match(result.stderr, /Lock contention/);
    const successfulOutputs = successful.map(result => JSON.parse(result.stdout) as { path: string; ask_user: { scope: string } });
    const firstOutput = successfulOutputs[0];
    assert.equal(firstOutput.path, "ask_user");
    for (const output of successfulOutputs) {
      assert.equal(output.path, "ask_user");
      assert.equal(output.ask_user.scope, firstOutput.ask_user.scope);
    }
    const retryOutput = JSON.parse(execFileSync(process.execPath, [cli, "transition", "next", "--change", fx.change], {
      cwd: fx.projectRoot,
      encoding: "utf8",
    })) as { path: string; ask_user: { scope: string } };
    assert.equal(retryOutput.path, "ask_user");
    assert.equal(retryOutput.ask_user.scope, firstOutput.ask_user.scope);
    const presented = readEvents(fx.projectRoot, fx.change).filter(event => event.event_type === "user_question_presented");
    assert.equal(presented.length, 1);
  } finally { fx.cleanup(); }
});

test("next 在 explore 没有 Q 时仍返回新鲜 critic job", () => {
  const fx = setupPropose();
  try {
    const job = appendOpenJob(fx.projectRoot, fx.change, "explore", {
      job_id: "JOB-fresh-explore-critic",
      role: "critic",
      created_from_transition: "explore",
      boundFiles: [docRef(fx.changeRoot, ".superspec/artifacts/discovery.md")],
    });

    const result = next(fx.projectRoot, fx.change, fx.changeRoot);
    assert.equal(result.path, "required_job");
    assert.equal(result.required_jobs[0].job_id, job.job_id);
  } finally { fx.cleanup(); }
});

test("Explore Q 回写后，绑定旧 Discovery 的 critic job 自动重建", () => {
  const fx = setupPropose();
  try {
    const first = transitionExplore(fx.projectRoot, fx.change, fx.changeRoot, "strict");
    assert.equal(first.outcome, "job_created");
    const firstJobId = first.created_jobs[0];
    const firstJob = rebuildSnapshot(fx.projectRoot, fx.change, fx.changeRoot).open_jobs
      .find(job => job.job_id === firstJobId);
    assert.ok(firstJob);
    const firstDiscoveryRef = firstJob.boundFiles.find(file => file.path === ".superspec/artifacts/discovery.md");
    assert.ok(firstDiscoveryRef);

    const discoveryPath = join(fx.changeRoot, ".superspec", "artifacts", "discovery.md");
    writeFileSync(discoveryPath, "# Discovery\n\n## 待确认问题\n\n- [ ] Q-001 是否保留旧行为？\n");
    const question = next(fx.projectRoot, fx.change, fx.changeRoot, "strict");
    assert.equal(question.path, "ask_user");
    assert.match(question.ask_user.scope, /^explore_open_question:sha256:[a-f0-9]{64}:Q-001$/);
    assert.equal(rebuildSnapshot(fx.projectRoot, fx.change, fx.changeRoot).open_jobs
      .some(job => job.job_id === firstJobId), false);

    assert.equal(recordUserDecisionContent(fx.projectRoot, fx.change, JSON.stringify({
      scope: question.ask_user.scope,
      answer: "保留旧行为",
    })).accepted, true);
    writeFileSync(discoveryPath, "# Discovery\n\n## 待确认问题\n\n- [x] Q-001 保留旧行为。\n");

    const rebuilt = transitionExplore(fx.projectRoot, fx.change, fx.changeRoot, "strict");
    assert.equal(rebuilt.outcome, "job_created");
    assert.notEqual(rebuilt.created_jobs[0], firstJobId);
    const rebuiltJob = rebuildSnapshot(fx.projectRoot, fx.change, fx.changeRoot).open_jobs
      .find(job => job.job_id === rebuilt.created_jobs[0]);
    assert.ok(rebuiltJob);
    const rebuiltDiscoveryRef = rebuiltJob.boundFiles.find(file => file.path === ".superspec/artifacts/discovery.md");
    assert.ok(rebuiltDiscoveryRef);
    assert.notEqual(rebuiltDiscoveryRef.sha, firstDiscoveryRef.sha);
  } finally { fx.cleanup(); }
});

test("next 在 explore 不让非阶段 open job 抢占 discovery artifact", () => {
  const fx = setupExplore();
  try {
    appendOpenJob(fx.projectRoot, fx.change, "explore", {
      job_id: "JOB-proposal-critic-too-early",
      role: "critic",
      created_from_transition: "propose-ready",
    });

    const result = next(fx.projectRoot, fx.change, fx.changeRoot);
    assert.equal(result.path, "artifact_required");
    assert.equal(result.artifact.kind, "discovery");
  } finally { fx.cleanup(); }
});

test("next 在 explore 一次只返回当前问题，登记后必须回写才能进入下一项", () => {
  const fx = setupExplore();
  try {
    const discoveryPath = join(fx.changeRoot, ".superspec", "artifacts", "discovery.md");
    writeFileSync(discoveryPath, [
      "# Discovery",
      "",
      "## 待确认问题",
      "",
      "- [ ] Q-001 是否保留旧行为？",
      "- [ ] Q-002 默认展示什么内容？",
    ].join("\n"));

    const first = next(fx.projectRoot, fx.change, fx.changeRoot);
    assert.equal(first.path, "ask_user");
    assert.match(first.ask_user.scope, /^explore_open_question:sha256:[a-f0-9]{64}:Q-001$/);
    assert.match(first.ask_user.question, /现在有一件事需要你确认/);
    assert.doesNotMatch(first.ask_user.question, /Q-001/);
    assert.doesNotMatch(first.ask_user.question, /Q-002/);
    assert.deepEqual(first.ask_user.allowed_answers, []);
    assert.deepEqual(first.ask_user.record_argv, [
      "superspec", "record", "user-decision", "--change", fx.change, "--input", "-",
    ]);
    assert.deepEqual(first.ask_user.record_input, {
      scope: first.ask_user.scope,
      question: first.ask_user.question,
      answer: null,
    });
    assert.deepEqual(first.ask_user.required_fields, ["answer"]);

    const firstInput = JSON.stringify({
      scope: first.ask_user.scope,
      question: first.ask_user.question,
      answer: "保留旧行为",
    });
    const registered = recordUserDecisionContent(fx.projectRoot, fx.change, firstInput);
    assert.equal(registered.accepted, true);
    assert.equal(registered.message, "这件事的答复已登记");
    assert.doesNotMatch(registered.message, /Q-001|scope/);
    const duplicate = recordUserDecisionContent(fx.projectRoot, fx.change, firstInput);
    assert.equal(duplicate.accepted, true);
    assert.match(duplicate.message, /幂等/);
    const conflicting = recordUserDecisionContent(fx.projectRoot, fx.change, JSON.stringify({
      scope: first.ask_user.scope,
      question: first.ask_user.question,
      answer: "不保留旧行为",
    }));
    assert.equal(conflicting.accepted, false);
    assert.match(conflicting.message, /已有已登记答复/);
    const forged = recordUserDecisionContent(fx.projectRoot, fx.change, JSON.stringify({
      scope: first.ask_user.scope.replace(/Q-001$/, "Q-002"),
      question: first.ask_user.question,
      answer: "伪造后续问题答复",
    }));
    assert.equal(forged.accepted, false);
    assert.match(forged.message, /已变化|已完成/);
    assert.equal(readEvents(fx.projectRoot, fx.change).filter(event =>
      event.event_type === "user_decision_recorded" && event.payload.accepted === true && event.payload.scope === first.ask_user.scope
    ).length, 1);
    const recorded = readEvents(fx.projectRoot, fx.change).findLast(event =>
      event.event_type === "user_decision_recorded" && event.payload.accepted === true
    );
    assert.equal(recorded?.payload.question, "是否保留旧行为？");

    const beforeRewrite = next(fx.projectRoot, fx.change, fx.changeRoot);
    assert.equal(beforeRewrite.path, "ask_user");
    assert.equal(beforeRewrite.ask_user.scope, first.ask_user.scope);

    writeFileSync(discoveryPath, [
      "# Discovery",
      "",
      "## 待确认问题",
      "",
      "- [x] Q-001 是否保留旧行为？",
      "- [ ] Q-002 默认展示什么内容？",
    ].join("\n"));
    const second = next(fx.projectRoot, fx.change, fx.changeRoot);
    assert.equal(second.path, "ask_user");
    assert.match(second.ask_user.scope, /^explore_open_question:sha256:[a-f0-9]{64}:Q-002$/);
    assert.notEqual(second.ask_user.scope, first.ask_user.scope);
    const staleFirst = recordUserDecisionContent(fx.projectRoot, fx.change, firstInput);
    assert.equal(staleFirst.accepted, false);
    assert.match(staleFirst.message, /已变化|已完成/);
    const staleEventCount = readEvents(fx.projectRoot, fx.change).length;
    const staleAgain = recordUserDecisionContent(fx.projectRoot, fx.change, firstInput);
    assert.equal(staleAgain.accepted, false);
    assert.match(staleAgain.message, /幂等/);
    assert.equal(readEvents(fx.projectRoot, fx.change).length, staleEventCount);

    const blocked = transitionExplore(fx.projectRoot, fx.change, fx.changeRoot);
    assert.equal(blocked.events_written, 0);
    assert.match(blocked.message, /仍有需要确认的事项/);
  } finally { fx.cleanup(); }
});

test("Explore 新轮次：直接勾选确认事项不能绕过答复登记", () => {
  const fx = setupExplore();
  try {
    const discoveryPath = join(fx.changeRoot, ".superspec", "artifacts", "discovery.md");
    const openDiscovery = [
      "# Discovery",
      "",
      "## 待确认问题",
      "",
      "- [ ] Q-001 是否保留旧行为？",
    ].join("\n");
    writeFileSync(discoveryPath, openDiscovery);
    appendEvent(fx.projectRoot, fx.change, makeEvent(fx.change, "transition_commit", {
      transition: "reopen",
      from_state: "explore",
      to_state: "explore",
      outcome: "advanced",
      created_job_ids: [],
      reason: "test registered explore round",
      reopen_target: "explore",
      ...exploreAnswerRegistrationPayload(openDiscovery),
    }, { transitionId: "T-registered-explore-round", idempotencyKey: "registered-explore-round" }));

    writeFileSync(discoveryPath, openDiscovery.replace("- [ ]", "- [x]").replace("是否保留旧行为？", "保留旧行为。"));
    const blocked = next(fx.projectRoot, fx.change, fx.changeRoot);
    assert.equal(blocked.path, "material_update_required");
    assert.match(blocked.reason, /未登记答复/);

    const transition = transitionExplore(fx.projectRoot, fx.change, fx.changeRoot);
    assert.equal(transition.events_written, 0);
    assert.match(transition.message, /缺少对应答复登记/);
  } finally { fx.cleanup(); }
});

test("Explore 已展示问题：删除问题行不能绕过答复登记", () => {
  const fx = setupExplore();
  try {
    const discoveryPath = join(fx.changeRoot, ".superspec", "artifacts", "discovery.md");
    writeFileSync(discoveryPath, [
      "# Discovery",
      "",
      "## 待确认问题",
      "",
      "- [ ] Q-001 团队规则按查看者匹配还是按成员匹配？",
    ].join("\n"));

    const presented = next(fx.projectRoot, fx.change, fx.changeRoot);
    assert.equal(presented.path, "ask_user");
    assert.match(presented.ask_user.scope, /^explore_open_question:/);
    assert.ok(readEvents(fx.projectRoot, fx.change).some(event => event.event_type === "user_question_presented"));

    writeFileSync(discoveryPath, "# Discovery\n\n团队规则按查看者匹配。\n");
    const blocked = next(fx.projectRoot, fx.change, fx.changeRoot);
    assert.equal(blocked.path, "material_update_required");
    assert.match(blocked.errors.join("\n"), /已从 discovery\.md 消失/);

    const transition = transitionExplore(fx.projectRoot, fx.change, fx.changeRoot);
    assert.equal(transition.events_written, 0);
    assert.match(transition.message, /缺少答复登记且已从 discovery\.md 消失/);

    appendEvent(fx.projectRoot, fx.change, makeEvent(fx.change, "transition_commit", {
      transition: "reopen",
      from_state: "explore",
      to_state: "explore",
      outcome: "advanced",
      created_job_ids: [],
      reason: "start a new explore round",
      reopen_target: "explore",
      ...exploreAnswerRegistrationPayload("# Discovery\n\n团队规则按查看者匹配。\n"),
    }, { transitionId: "T-new-explore-round", idempotencyKey: "new-explore-round" }));
    const newRound = next(fx.projectRoot, fx.change, fx.changeRoot);
    assert.notEqual(newRound.path === "ask_user" ? newRound.ask_user.scope : "", "explore_answer_registration");
  } finally { fx.cleanup(); }
});

test("Explore 升级兼容：新 scope 已展示后仍可用同题 legacy scope 完成登记", () => {
  const fx = setupExplore();
  try {
    const discoveryPath = join(fx.changeRoot, ".superspec", "artifacts", "discovery.md");
    const openDiscovery = "# Discovery\n\n## 调查\n\n旧实现位于模块 A。\n\n## 待确认问题\n\n- [ ] Q-001 是否保留旧行为？\n";
    writeFileSync(discoveryPath, openDiscovery);

    const presented = next(fx.projectRoot, fx.change, fx.changeRoot);
    assert.equal(presented.path, "ask_user");
    const current = parseDiscoveryOpenQuestions(openDiscovery)[0];
    const events = readEvents(fx.projectRoot, fx.change);
    const legacyScope = legacyDiscoveryOpenQuestionScope(current, currentExploreRoundId(events));
    assert.notEqual(legacyScope, presented.path === "ask_user" ? presented.ask_user.scope : "");
    assert.equal(recordUserDecisionContent(fx.projectRoot, fx.change, JSON.stringify({
      scope: legacyScope,
      answer: "保留旧行为",
    })).accepted, true);
    writeFileSync(discoveryPath, openDiscovery.replace("旧实现位于模块 A。", "旧实现位于模块 A，另有一处调用。"));
    const afterUnrelatedChange = next(fx.projectRoot, fx.change, fx.changeRoot);
    assert.equal(afterUnrelatedChange.path, "ask_user");
    assert.equal(afterUnrelatedChange.ask_user.scope, presented.path === "ask_user" ? presented.ask_user.scope : "");
    assert.equal(recordUserDecisionContent(fx.projectRoot, fx.change, JSON.stringify({
      scope: afterUnrelatedChange.ask_user.scope,
      answer: "保留旧行为",
    })).accepted, true);
    assert.equal(recordUserDecisionContent(fx.projectRoot, fx.change, JSON.stringify({
      scope: afterUnrelatedChange.ask_user.scope,
      answer: "不保留旧行为",
    })).accepted, false);

    writeFileSync(discoveryPath, openDiscovery.replace("旧实现位于模块 A。", "旧实现位于模块 A，另有一处调用。").replace("- [ ]", "- [x]"));
    const afterWriteback = next(fx.projectRoot, fx.change, fx.changeRoot);
    assert.notEqual(afterWriteback.path, "material_update_required");
  } finally { fx.cleanup(); }
});

test("Explore 决策身份：升级前 legacy accepted 事件阻止冲突 v2 答复", () => {
  const fx = setupExplore();
  try {
    const discoveryPath = join(fx.changeRoot, ".superspec", "artifacts", "discovery.md");
    const content = "# Discovery\n\n## 待确认问题\n\n- [ ] Q-001 是否保留旧行为？\n";
    writeFileSync(discoveryPath, content);
    const events = readEvents(fx.projectRoot, fx.change);
    const current = parseDiscoveryOpenQuestions(content)[0];
    const roundId = currentExploreRoundId(events);
    const legacyScope = legacyDiscoveryOpenQuestionScope(current, roundId);
    appendEvent(fx.projectRoot, fx.change, makeEvent(fx.change, "user_decision_recorded", {
      scope: legacyScope,
      question: "是否保留旧行为？",
      answer: "保留旧行为",
      accepted: true,
      explore_open_question: {
        round_id: roundId,
        question_id: current.id,
        question_ordinal: current.ordinal,
        context_fingerprint: discoveryQuestionContextFingerprint(content, current),
      },
    }));
    const presented = next(fx.projectRoot, fx.change, fx.changeRoot);
    assert.equal(presented.path, "ask_user");
    assert.equal(recordUserDecisionContent(fx.projectRoot, fx.change, JSON.stringify({ scope: presented.ask_user.scope, answer: "不保留旧行为" })).accepted, false);
    writeFileSync(discoveryPath, content.replace("- [ ]", "- [x]"));
    assert.notEqual(next(fx.projectRoot, fx.change, fx.changeRoot).path, "material_update_required");
  } finally { fx.cleanup(); }
});

test("Explore 新轮次：登记答复后回写通过，轮次开始前的已确认事项保持兼容", () => {
  const fx = setupExplore();
  try {
    const discoveryPath = join(fx.changeRoot, ".superspec", "artifacts", "discovery.md");
    const openDiscovery = [
      "# Discovery",
      "",
      "## 待确认问题",
      "",
      "- [ ] Q-001 是否保留旧行为？",
    ].join("\n");
    writeFileSync(discoveryPath, openDiscovery);
    appendEvent(fx.projectRoot, fx.change, makeEvent(fx.change, "transition_commit", {
      transition: "reopen",
      from_state: "explore",
      to_state: "explore",
      outcome: "advanced",
      created_job_ids: [],
      reason: "test registered explore round",
      reopen_target: "explore",
      ...exploreAnswerRegistrationPayload(openDiscovery),
    }, { transitionId: "T-registered-explore-answer", idempotencyKey: "registered-explore-answer" }));

    const question = next(fx.projectRoot, fx.change, fx.changeRoot);
    assert.equal(question.path, "ask_user");
    assert.equal(recordUserDecisionContent(fx.projectRoot, fx.change, JSON.stringify({
      scope: question.ask_user.scope,
      answer: "保留旧行为",
    })).accepted, true);
    const decision = readEvents(fx.projectRoot, fx.change).findLast(event => event.event_type === "user_decision_recorded");
    assert.equal((decision?.payload as { explore_open_question?: { question_id?: unknown } }).explore_open_question?.question_id, "Q-001");

    writeFileSync(discoveryPath, openDiscovery.replace("- [ ]", "- [x]"));
    const afterRewrite = next(fx.projectRoot, fx.change, fx.changeRoot);
    assert.notEqual(afterRewrite.path, "material_update_required");

    const historicalClosed = [
      "# Discovery",
      "",
      "## 待确认问题",
      "",
      "- [x] Q-001 之前已确认的旧行为。",
    ].join("\n");
    writeFileSync(discoveryPath, historicalClosed);
    appendEvent(fx.projectRoot, fx.change, makeEvent(fx.change, "transition_commit", {
      transition: "reopen",
      from_state: "explore",
      to_state: "explore",
      outcome: "advanced",
      created_job_ids: [],
      reason: "test historical closed baseline",
      reopen_target: "explore",
      ...exploreAnswerRegistrationPayload(historicalClosed),
    }, { transitionId: "T-registered-explore-baseline", idempotencyKey: "registered-explore-baseline" }));
    const historical = next(fx.projectRoot, fx.change, fx.changeRoot);
    assert.notEqual(historical.path === "ask_user" ? historical.ask_user.scope : "", "explore_answer_registration");
  } finally { fx.cleanup(); }
});

test("Explore 新轮次：无关调查材料变化不使已登记答复失效", () => {
  const fx = setupExplore();
  try {
    const discoveryPath = join(fx.changeRoot, ".superspec", "artifacts", "discovery.md");
    const openDiscovery = [
      "# Discovery",
      "",
      "## 需求理解",
      "",
      "- 补充调查：旧实现由同一模块维护",
      "",
      "## 待确认问题",
      "",
      "- [ ] Q-001 是否保留旧行为？",
    ].join("\n");
    writeFileSync(discoveryPath, openDiscovery);
    appendEvent(fx.projectRoot, fx.change, makeEvent(fx.change, "transition_commit", {
      transition: "reopen",
      from_state: "explore",
      to_state: "explore",
      outcome: "advanced",
      created_job_ids: [],
      reason: "test stale explore answer",
      reopen_target: "explore",
      ...exploreAnswerRegistrationPayload(openDiscovery),
    }, { transitionId: "T-stale-explore", idempotencyKey: "stale-explore" }));

    const question = next(fx.projectRoot, fx.change, fx.changeRoot);
    assert.equal(question.path, "ask_user");
    assert.equal(recordUserDecisionContent(fx.projectRoot, fx.change, JSON.stringify({
      scope: question.ask_user.scope,
      answer: "保留旧行为",
    })).accepted, true);

    const closed = openDiscovery
      .replace("补充调查：旧实现由同一模块维护", "补充调查：旧实现还有另一处调用")
      .replace("- [ ]", "- [x]");
    writeFileSync(discoveryPath, closed);
    const afterWriteback = next(fx.projectRoot, fx.change, fx.changeRoot);
    assert.notEqual(afterWriteback.path, "material_update_required");
  } finally { fx.cleanup(); }
});

test("Explore 问题修订或轮次变化后，同一问题可以登记新的答复", () => {
  const fx = setupExplore();
  try {
    const discoveryPath = join(fx.changeRoot, ".superspec", "artifacts", "discovery.md");
    const original = [
      "# Discovery",
      "",
      "## 需求理解",
      "- 当前差异：旧的兼容口径",
      "",
      "## 待确认问题",
      "",
      "- [ ] Q-001 是否保留旧行为？",
    ].join("\n");
    writeFileSync(discoveryPath, original);

    const first = next(fx.projectRoot, fx.change, fx.changeRoot);
    assert.equal(first.path, "ask_user");
    assert.equal(recordUserDecisionContent(fx.projectRoot, fx.change, JSON.stringify({
      scope: first.ask_user.scope,
      answer: "保留旧行为",
    })).accepted, true);

    writeFileSync(discoveryPath, original.replace("旧的兼容口径", "新需求要求统一新行为"));
    const afterContextChange = next(fx.projectRoot, fx.change, fx.changeRoot);
    assert.equal(afterContextChange.path, "ask_user");
    assert.equal(afterContextChange.ask_user.scope, first.ask_user.scope);

    writeFileSync(discoveryPath, original
      .replace("旧的兼容口径", "新需求要求统一新行为")
      .replace("是否保留旧行为？", "是否继续保留旧行为及兼容入口？"));
    const afterQuestionChange = next(fx.projectRoot, fx.change, fx.changeRoot);
    assert.equal(afterQuestionChange.path, "ask_user");
    assert.notEqual(afterQuestionChange.ask_user.scope, first.ask_user.scope);
    assert.equal(recordUserDecisionContent(fx.projectRoot, fx.change, JSON.stringify({
      scope: afterQuestionChange.ask_user.scope,
      answer: "不保留旧行为",
    })).accepted, true);

    appendEvent(fx.projectRoot, fx.change, makeEvent(fx.change, "transition_commit", {
      transition: "propose", from_state: "explore", to_state: "propose",
      outcome: "advanced", created_job_ids: [], reason: "test leave explore",
    }));
    appendEvent(fx.projectRoot, fx.change, makeEvent(fx.change, "transition_commit", {
      transition: "reopen", from_state: "propose", to_state: "explore",
      outcome: "advanced", created_job_ids: [], reason: "test reopen explore",
      reopen_target: "explore",
      baseline_docs: { ".superspec/artifacts/discovery.md": sha256File(discoveryPath) },
    }));
    writeFileSync(discoveryPath, original);

    const afterReopen = next(fx.projectRoot, fx.change, fx.changeRoot);
    assert.equal(afterReopen.path, "ask_user");
    assert.notEqual(afterReopen.ask_user.scope, first.ask_user.scope);
    assert.notEqual(afterReopen.ask_user.scope, afterQuestionChange.ask_user.scope);
    assert.equal(recordUserDecisionContent(fx.projectRoot, fx.change, JSON.stringify({
      scope: afterReopen.ask_user.scope,
      answer: "重新确认后保留旧行为",
    })).accepted, true);
  } finally { fx.cleanup(); }
});

test("Explore 历史无 Q-ID 文档以 item-N 完成一次一题流转", () => {
  const fx = setupExplore();
  try {
    const discoveryPath = join(fx.changeRoot, ".superspec", "artifacts", "discovery.md");
    writeFileSync(discoveryPath, [
      "# Discovery",
      "",
      "## 待确认问题",
      "",
      "- [ ] 是否继续兼容旧格式？",
      "- [ ] 默认排序规则是什么？",
    ].join("\n"));

    const first = next(fx.projectRoot, fx.change, fx.changeRoot);
    assert.equal(first.path, "ask_user");
    assert.match(first.ask_user.scope, /^explore_open_question:sha256:[a-f0-9]{64}:item-1$/);
    assert.match(first.ask_user.question, /是否继续兼容旧格式/);
    assert.doesNotMatch(first.ask_user.question, /item-1/);
    const registered = recordUserDecisionContent(fx.projectRoot, fx.change, JSON.stringify({
      scope: first.ask_user.scope,
      answer: "继续兼容",
    }));
    assert.equal(registered.accepted, true);
    assert.equal(registered.message, "这件事的答复已登记");
    assert.doesNotMatch(registered.message, /item-1|scope/);

    writeFileSync(discoveryPath, [
      "# Discovery",
      "",
      "## 待确认问题",
      "",
      "- [x] 继续兼容旧格式。",
      "- [ ] 默认排序规则是什么？",
    ].join("\n"));
    const second = next(fx.projectRoot, fx.change, fx.changeRoot);
    assert.equal(second.path, "ask_user");
    assert.match(second.ask_user.scope, /^explore_open_question:sha256:[a-f0-9]{64}:item-2$/);
    assert.equal(recordUserDecisionContent(fx.projectRoot, fx.change, JSON.stringify({
      scope: first.ask_user.scope,
      answer: "旧 scope 不应通过",
    })).accepted, false);
  } finally { fx.cleanup(); }
});

test("next 在 propose 不让非阶段 open job 抢占正常推进", () => {
  const fx = setupPropose();
  try {
    confirmCurrentPhase(fx.projectRoot, fx.change, fx.changeRoot, "normal");
    const entered = transitionExplore(fx.projectRoot, fx.change, fx.changeRoot, "normal");
    assert.equal(entered.to_state, "propose");
    appendOpenJob(fx.projectRoot, fx.change, "propose", {
      job_id: "JOB-apply-executor-too-early",
      role: "executor",
      created_from_transition: "apply",
    });
    writeFileSync(join(fx.changeRoot, ".superspec", "artifacts", "test-contract.md"), "# Test Contract\n");

    const result = next(fx.projectRoot, fx.change, fx.changeRoot);
    assert.equal(result.path, "next_command");
    assert.match(result.next_command, /propose-ready/);
  } finally { fx.cleanup(); }
});

test("next 在 propose 不把 tasks 普通 checklist 解析成设计决定", () => {
  const fx = setupPropose();
  try {
    confirmCurrentPhase(fx.projectRoot, fx.change, fx.changeRoot, "normal");
    const entered = transitionExplore(fx.projectRoot, fx.change, fx.changeRoot, "normal");
    assert.equal(entered.to_state, "propose");
    writeFileSync(join(fx.changeRoot, "tasks.md"), "# Tasks\n\n- [ ] TASK-001 tdd_required:true\n");
    writeFileSync(join(fx.changeRoot, ".superspec", "artifacts", "test-contract.md"), "# Test Contract\n");

    const result = next(fx.projectRoot, fx.change, fx.changeRoot);
    assert.equal(result.path, "material_update_required");
    if (result.path !== "material_update_required") throw new Error("expected planning preflight feedback");
    assert.ok(result.errors.length > 0);
    assert.deepEqual(result.resume.argv, ["superspec", "transition", "next", "--change", fx.change]);
  } finally { fx.cleanup(); }
});

test("next 在 propose 缺 test-contract 时返回 canonical artifact_required", () => {
  const fx = setupPropose();
  try {
    confirmCurrentPhase(fx.projectRoot, fx.change, fx.changeRoot, "normal");
    assert.equal(transitionExplore(fx.projectRoot, fx.change, fx.changeRoot, "normal").to_state, "propose");

    const result = next(fx.projectRoot, fx.change, fx.changeRoot);
    assert.deepEqual(result, {
      state: "propose",
      path: "artifact_required",
      artifact: {
        kind: "test_contract",
        path: "openspec/changes/test-change/.superspec/artifacts/test-contract.md",
        operation: "create_or_update",
      },
      resume: {
        argv: ["superspec", "transition", "next", "--change", "test-change"],
      },
      reason: "test-contract.md 不存在",
    });
  } finally { fx.cleanup(); }
});

test("next 在 propose 缺 tasks 时返回 canonical artifact_required", () => {
  const fx = setupPropose();
  try {
    confirmCurrentPhase(fx.projectRoot, fx.change, fx.changeRoot, "normal");
    assert.equal(transitionExplore(fx.projectRoot, fx.change, fx.changeRoot, "normal").to_state, "propose");
    writeFileSync(join(fx.changeRoot, ".superspec", "artifacts", "test-contract.md"), "# Test Contract\n");
    rmSync(join(fx.changeRoot, "tasks.md"));

    const result = next(fx.projectRoot, fx.change, fx.changeRoot);
    assert.deepEqual(result, {
      state: "propose",
      path: "artifact_required",
      artifact: {
        kind: "tasks",
        path: "openspec/changes/test-change/tasks.md",
        operation: "create_or_update",
      },
      resume: {
        argv: ["superspec", "transition", "next", "--change", "test-change"],
      },
      reason: "tasks.md 不存在",
    });
  } finally { fx.cleanup(); }
});

test("next 在 propose 宣称计划就绪前复用 propose-ready 预检", () => {
  const fx = setupPropose();
  try {
    confirmCurrentPhase(fx.projectRoot, fx.change, fx.changeRoot, "normal");
    assert.equal(transitionExplore(fx.projectRoot, fx.change, fx.changeRoot, "normal").to_state, "propose");
    writeFileSync(join(fx.changeRoot, ".superspec", "artifacts", "test-contract.md"), "# Test Contract\n");
    writeFileSync(join(fx.changeRoot, "tasks.md"), [
      "# Tasks",
      "",
      "- [ ] TASK-001 first",
      "- [ ] TASK-001 duplicate",
    ].join("\n"));

    const result = next(fx.projectRoot, fx.change, fx.changeRoot);
    assert.equal(result.path, "material_update_required");
    if (result.path !== "material_update_required") throw new Error("expected planning preflight feedback");
    assert.ok(result.errors.some(error => /TASK-001/.test(error)));
    assert.match(result.reason, /TASK-001/);
  } finally { fx.cleanup(); }
});

test("explore→propose 默认完整审查：创建 critic，接受 JSON 报告后推进", () => {
  const fx = setupPropose();
  try {
    const first = transitionExplore(fx.projectRoot, fx.change, fx.changeRoot);
    assert.equal(first.outcome, "job_created");
    assert.equal(first.to_state, "explore");
    assert.equal(first.created_jobs.length, 1);
    assert.equal(first.required_jobs?.[0]?.job_id, first.created_jobs[0]);
    assert.deepEqual(first.required_jobs?.[0]?.packet_argv, [
      "superspec", "jobs", "packet", "--change", fx.change, "--job", first.created_jobs[0],
    ]);

    let snapshot = rebuildSnapshot(fx.projectRoot, fx.change, fx.changeRoot);
    assert.equal(snapshot.state, "explore");
    assert.equal(snapshot.open_jobs[0].role, "critic");
    assert.equal(snapshot.open_jobs[0].gate_id, "explore.discovery_review");

    const packet = jobsPacket(fx.projectRoot, fx.change, first.created_jobs[0]);
    assert.equal(packet.found, true);
    assert.equal(packet.packet?.role, "critic");
    assert.equal(packet.packet?.gate_id, "explore.discovery_review");
    assert.deepEqual(packet.packet?.review_targets, [".superspec/artifacts/discovery.md"]);
    assert.equal(packet.packet?.read_only_refs, undefined);
    assert.equal(packet.packet?.recommended_agent, "critic");
    assert.equal(packet.packet?.required_output_kind, "job_report_json");
    assert.equal(packet.packet?.preferred_input_mode, "stdin");
    assert.equal(packet.packet?.submission_command, `superspec record job-submit --change "${fx.change}" --job "${first.created_jobs[0]}" --report -`);
    assert.deepEqual(packet.packet?.submission_argv, [
      "superspec", "record", "job-submit", "--change", fx.change, "--job", first.created_jobs[0], "--report", "-",
    ]);
    assert.equal(packet.packet?.file_fallback, true);
    assert.deepEqual(packet.packet?.output_contract_fields, ["role", "verdict", "findings", "reviewer", "review_scope"]);
    const reportPath = join(fx.projectRoot, "critic.json");
    writeFileSync(reportPath, reviewerReportForJob(fx.projectRoot, fx.change, first.created_jobs[0]));
    const record = recordJobSubmit(fx.projectRoot, fx.change, fx.changeRoot, first.created_jobs[0], reportPath);
    assert.equal(record.accepted, true);

    confirmCurrentPhase(fx.projectRoot, fx.change, fx.changeRoot);
    const second = transitionExplore(fx.projectRoot, fx.change, fx.changeRoot);
    assert.equal(second.outcome, "advanced");
    assert.equal(second.to_state, "propose");

    snapshot = rebuildSnapshot(fx.projectRoot, fx.change, fx.changeRoot);
    assert.equal(snapshot.state, "propose");
  } finally { fx.cleanup(); }
});

test("普通 reviewer：缺少 review_scope 时不关闭 job，补全后可用同一 job 提交", () => {
  const fx = setupPropose();
  try {
    const created = transitionExplore(fx.projectRoot, fx.change, fx.changeRoot, "strict");
    const jobId = created.created_jobs[0];
    const eventCount = readEvents(fx.projectRoot, fx.change).length;
    const missingScope = recordJobSubmitContent(fx.projectRoot, fx.change, fx.changeRoot, jobId, JSON.stringify({
      role: "critic",
      verdict: "pass",
      findings: [],
      reviewer: { kind: "codex-subagent", id: "critic-missing-scope" },
    }));
    assert.equal(missingScope.accepted, false);
    assert.equal(missingScope.job_state, "requested");
    assert.equal(missingScope.events_written, 0);
    assert.match(missingScope.message, /缺少覆盖范围字段 review_scope/);
    assert.equal(readEvents(fx.projectRoot, fx.change).length, eventCount);
    assert.equal(recordJobSubmitContent(
      fx.projectRoot,
      fx.change,
      fx.changeRoot,
      jobId,
      reviewerReportForJob(fx.projectRoot, fx.change, jobId),
    ).accepted, true);
  } finally { fx.cleanup(); }
});

test("job-submit：不存在的报告文件不伪装为 job_rejected，补全后可重交", () => {
  const fx = setupPropose();
  try {
    const created = transitionExplore(fx.projectRoot, fx.change, fx.changeRoot, "strict");
    const jobId = created.created_jobs[0];
    const missing = recordJobSubmit(
      fx.projectRoot,
      fx.change,
      fx.changeRoot,
      jobId,
      join(fx.projectRoot, "does-not-exist.json"),
    );
    assert.equal(missing.accepted, false);
    assert.equal(missing.event_type, undefined);
    assert.equal(missing.job_state, "requested");
    assert.equal(missing.events_written, 0);
    assert.equal(recordJobSubmitContent(
      fx.projectRoot,
      fx.change,
      fx.changeRoot,
      jobId,
      reviewerReportForJob(fx.projectRoot, fx.change, jobId),
    ).accepted, true);
  } finally { fx.cleanup(); }
});

test("explore critic retry：继承历史 findings；malformed 可在同一工作项重交", () => {
  const fx = setupPropose();
  try {
    const first = transitionExplore(fx.projectRoot, fx.change, fx.changeRoot, "strict");
    const firstJobId = first.created_jobs[0];
    const firstPacket = jobsPacket(fx.projectRoot, fx.change, firstJobId).packet;
    const finding = { id: "DISC-001", description: "缺少反向调用证据", evidence: "未列出入口面搜索结果" };
    assert.equal(recordJobSubmitContent(fx.projectRoot, fx.change, fx.changeRoot, firstJobId, JSON.stringify({
      role: "critic",
      verdict: "fail",
      findings: [finding],
      review_scope: reviewScopeForJob(fx.projectRoot, fx.change, firstJobId),
      reviewer: { kind: "codex-subagent", id: "critic-first" },
    })).accepted, false);
    const firstRejected = readEvents(fx.projectRoot, fx.change).findLast(event =>
      event.event_type === "job_rejected" && event.payload.job_id === firstJobId
    );
    assert.equal(firstRejected?.payload.result_kind, "review_failed");

    writeFileSync(
      join(fx.changeRoot, ".superspec", "artifacts", "discovery.md"),
      "# Discovery\n\nAdded reverse lookup evidence.\n",
    );

    const second = transitionExplore(fx.projectRoot, fx.change, fx.changeRoot, "strict");
    const secondJobId = second.created_jobs[0];
    const secondPacket = jobsPacket(fx.projectRoot, fx.change, secondJobId).packet;
    assert.deepEqual(secondPacket?.previous_rejection, {
      result_kind: "review_failed",
      reason: "报告结论为 fail，工作项未通过",
      job_id: firstJobId,
      findings: [finding],
    });
    assert.notEqual(secondPacket?.packet_digest, firstPacket?.packet_digest);

    const eventCountBeforeMalformed = readEvents(fx.projectRoot, fx.change).length;
    const malformed = recordJobSubmitContent(
      fx.projectRoot,
      fx.change,
      fx.changeRoot,
      secondJobId,
      "{",
    );
    assert.equal(malformed.accepted, false);
    assert.equal(malformed.job_state, "requested");
    assert.equal(malformed.events_written, 0);
    assert.equal(readEvents(fx.projectRoot, fx.change).length, eventCountBeforeMalformed);
    assert.equal(transitionExplore(fx.projectRoot, fx.change, fx.changeRoot, "strict").required_jobs?.[0]?.job_id, secondJobId);

    assert.equal(recordJobSubmitContent(
      fx.projectRoot,
      fx.change,
      fx.changeRoot,
      secondJobId,
      reviewerReportForJob(fx.projectRoot, fx.change, secondJobId),
    ).accepted, true);
    writeFileSync(
      join(fx.changeRoot, ".superspec", "artifacts", "discovery.md"),
      "# Discovery\n\nChanged after accepted review.\n",
    );
    const third = transitionExplore(fx.projectRoot, fx.change, fx.changeRoot, "strict");
    assert.equal(jobsPacket(fx.projectRoot, fx.change, third.created_jobs[0]).packet?.previous_rejection, undefined);
  } finally { fx.cleanup(); }
});

test("explore stay：修改 discovery 后 strict critic 重新审查", () => {
  const fx = setupPropose();
  try {
    const first = transitionExplore(fx.projectRoot, fx.change, fx.changeRoot, "strict");
    assert.equal(first.outcome, "job_created");
    const reportPath = join(fx.projectRoot, "critic-stay.json");
    writeFileSync(reportPath, reviewerReportForJob(fx.projectRoot, fx.change, first.created_jobs[0]));
    assert.equal(recordJobSubmit(
      fx.projectRoot,
      fx.change,
      fx.changeRoot,
      first.created_jobs[0],
      reportPath,
    ).accepted, true);

    const ask = next(fx.projectRoot, fx.change, fx.changeRoot, "strict");
    assert.equal(ask.path, "ask_user");
    const stay = (ask.ask_user.actions as PhaseDecisionAction[]).find(action => action.decision === "stay");
    assert.ok(stay);
    assert.equal(recordUserDecisionContent(fx.projectRoot, fx.change, JSON.stringify({
      ...stay.record_input,
      reason: "继续补充反向调用证据",
    })).accepted, true);

    writeFileSync(
      join(fx.changeRoot, ".superspec", "artifacts", "discovery.md"),
      "# Discovery\n\nupdated after stay\n",
    );
    const recheck = transitionExplore(fx.projectRoot, fx.change, fx.changeRoot, "strict");
    assert.equal(recheck.outcome, "job_created");
    assert.equal(recheck.to_state, "explore");
    assert.notEqual(recheck.created_jobs[0], first.created_jobs[0]);
  } finally { fx.cleanup(); }
});

test("explore→propose strict：旧 accepted critic job 无 gate_id 仍可满足探索审查", () => {
  const fx = setupPropose();
  try {
    const job = appendOpenJob(fx.projectRoot, fx.change, "explore", {
      job_id: "JOB-legacy-explore-critic",
      role: "critic",
      created_from_transition: "explore",
      boundFiles: [{
        path: ".superspec/artifacts/discovery.md",
        sha: sha256File(join(fx.changeRoot, ".superspec", "artifacts", "discovery.md")) ?? "sha256:missing",
      }],
    });
    appendEvent(fx.projectRoot, fx.change, makeEvent(fx.change, "job_accepted", {
      job_id: job.job_id,
      role: job.role,
      report_digest: "sha256:legacy-explore-report",
      accepted_at: new Date().toISOString(),
    }));

    confirmCurrentPhase(fx.projectRoot, fx.change, fx.changeRoot);
    const result = transitionExplore(fx.projectRoot, fx.change, fx.changeRoot, "strict");
    assert.equal(result.outcome, "advanced");
    assert.equal(result.to_state, "propose");
    assert.equal(result.created_jobs.length, 0);
  } finally { fx.cleanup(); }
});

test("explore 已有 open critic 时 transition 返回 blocked 且不写事件", () => {
  const fx = setupPropose();
  try {
    const first = transitionExplore(fx.projectRoot, fx.change, fx.changeRoot);
    assert.equal(first.outcome, "job_created");
    const beforeEvents = readEvents(fx.projectRoot, fx.change).length;
    const beforeLastTransition = rebuildSnapshot(fx.projectRoot, fx.change, fx.changeRoot).last_transition;

    const second = transitionExplore(fx.projectRoot, fx.change, fx.changeRoot);
    assert.equal(second.outcome, "blocked");
    assert.equal(second.events_written, 0);
    assert.deepEqual(second.created_jobs, []);
    assert.equal(second.required_jobs?.[0]?.job_id, first.created_jobs[0]);
    assert.deepEqual(second.required_jobs?.[0]?.packet_argv, [
      "superspec", "jobs", "packet", "--change", fx.change, "--job", first.created_jobs[0],
    ]);
    assert.equal(readEvents(fx.projectRoot, fx.change).length, beforeEvents);
    assert.equal(rebuildSnapshot(fx.projectRoot, fx.change, fx.changeRoot).last_transition, beforeLastTransition);

    const cli = new URL("../src/cli.ts", import.meta.url).pathname;
    const output = execFileSync(process.execPath, [cli, "transition", "explore", "--change", fx.change], {
      cwd: fx.projectRoot,
      encoding: "utf8",
    });
    const cliResult = JSON.parse(output);
    assert.equal(cliResult.outcome, "blocked");
    assert.equal(readEvents(fx.projectRoot, fx.change).length, beforeEvents);
  } finally { fx.cleanup(); }
});

test("packet argv 字段保留包含空格和括号的 change/job token", () => {
  const projectRoot = mkdtempSync(join(tmpdir(), "superspec-p2argv-"));
  const change = "change with space(1)";
  const changeRoot = join(projectRoot, "openspec", "changes", change);
  mkdirSync(join(changeRoot, ".superspec", "artifacts"), { recursive: true });
  writeFileSync(join(changeRoot, "proposal.md"), "# Proposal\n");
  writeFileSync(join(changeRoot, "tasks.md"), DOCUMENTATION_TASKS);
  writeFileSync(join(changeRoot, ".superspec", "artifacts", "discovery.md"), "# Discovery\n\nDone.\n");
  ensureChangeLayout(projectRoot, change);
  appendEvent(projectRoot, change, makeEvent(change, "transition_commit", {
    transition: "init",
    from_state: "init",
    to_state: "init",
    outcome: "advanced",
    created_job_ids: [],
    reason: "init",
  }, { transitionId: "T-init", idempotencyKey: "init-key" }));
  appendEvent(projectRoot, change, makeEvent(change, "transition_commit", {
    transition: "explore",
    from_state: "init",
    to_state: "explore",
    outcome: "advanced",
    created_job_ids: [],
    reason: "enter explore",
  }, { transitionId: "T-explore", idempotencyKey: "explore-key" }));

  try {
    const result = transitionExplore(projectRoot, change, changeRoot);
    assert.equal(result.outcome, "job_created");
    const jobId = result.created_jobs[0];
    assert.deepEqual(result.required_jobs?.[0]?.packet_argv, [
      "superspec", "jobs", "packet", "--change", change, "--job", jobId,
    ]);

    const packet = jobsPacket(projectRoot, change, jobId);
    assert.deepEqual(packet.packet?.submission_argv, [
      "superspec", "record", "job-submit", "--change", change, "--job", jobId, "--report", "-",
    ]);
  } finally {
    rmSync(projectRoot, { recursive: true, force: true });
  }
});

test("explore review override：fresh rejected 稳定 blocked，整体裁决后 gate 满足", () => {
  const fx = setupPropose();
  try {
    const created = transitionExplore(fx.projectRoot, fx.change, fx.changeRoot, "strict");
    const jobId = created.created_jobs[0];
    assert.equal(recordJobSubmitContent(
      fx.projectRoot,
      fx.change,
      fx.changeRoot,
      jobId,
      failedReviewerReportForJob(fx.projectRoot, fx.change, jobId, "DISC-OVERRIDE-001"),
    ).accepted, false);

    const eventCount = readEvents(fx.projectRoot, fx.change).length;
    const blocked = transitionExplore(fx.projectRoot, fx.change, fx.changeRoot, "strict");
    assert.equal(blocked.outcome, "blocked");
    assert.deepEqual(blocked.created_jobs, []);
    assert.equal(Object.hasOwn(blocked, "required_jobs"), false);
    const details = blocked.details?.review_rejection as {
      job_id: string;
      packet_digest: string;
      override_scope: string;
      allowed_actions: string[];
      record_input: Record<string, unknown>;
    } | undefined;
    assert.ok(details);
    assert.equal(details.job_id, jobId);
    assert.equal(details.override_scope, `review_rejection_override:${jobId}`);
    assert.deepEqual(details.allowed_actions, ["modify_materials", "record_override", "ask_user"]);
    assert.equal(details.record_input.answer, "do_not_block");
    assert.equal(details.record_input.decision_source, "main_process");
    assert.equal(readEvents(fx.projectRoot, fx.change).length, eventCount);

    const repeated = transitionExplore(fx.projectRoot, fx.change, fx.changeRoot, "strict");
    assert.equal(repeated.outcome, "blocked");
    assert.equal(Object.hasOwn(repeated, "required_jobs"), false);
    assert.equal(readEvents(fx.projectRoot, fx.change).length, eventCount);

    const firstInput = JSON.stringify({
      scope: details.override_scope,
      answer: "do_not_block",
      reason: "该报告只要求补充与本次 change 无直接因果关系的通用可靠性设计",
      decision_source: "main_process",
    });
    const recorded = recordUserDecisionContent(fx.projectRoot, fx.change, firstInput);
    assert.equal(recorded.accepted, true);
    const overrideEvent = readEvents(fx.projectRoot, fx.change).findLast(event =>
      event.event_type === "user_decision_recorded" &&
      event.payload.scope === details.override_scope &&
      event.payload.accepted === true
    );
    assert.equal(overrideEvent?.payload.answer, "do_not_block");
    assert.equal(overrideEvent?.payload.decision_source, "main_process");
    assert.deepEqual(overrideEvent?.payload.review_rejection_override, {
      job_id: jobId,
      role: "critic",
      gate_id: "explore.discovery_review",
      packet_digest: details.packet_digest,
    });

    const phaseAsk1 = next(fx.projectRoot, fx.change, fx.changeRoot, "strict");
    assert.equal(phaseAsk1.path, "ask_user");
    assert.match(phaseAsk1.ask_user.scope, /^phase_confirmation:explore_to_propose:/);

    const secondInput = JSON.stringify({
      scope: details.override_scope,
      answer: "do_not_block",
      reason: "用户确认该通用可靠性能力不属于本次范围",
      decision_source: "user",
    });
    assert.equal(recordUserDecisionContent(fx.projectRoot, fx.change, secondInput).accepted, true);
    const phaseAsk2 = next(fx.projectRoot, fx.change, fx.changeRoot, "strict");
    assert.equal(phaseAsk2.path, "ask_user");
    assert.notEqual(phaseAsk2.ask_user.scope, phaseAsk1.ask_user.scope, "effective override 变化应使旧阶段确认失效");

    const beforeIdempotent = readEvents(fx.projectRoot, fx.change).length;
    const idempotent = recordUserDecisionContent(fx.projectRoot, fx.change, secondInput);
    assert.equal(idempotent.accepted, true);
    assert.match(idempotent.message, /幂等/);
    assert.equal(readEvents(fx.projectRoot, fx.change).length, beforeIdempotent);

    const advance = (phaseAsk2.ask_user.actions as PhaseDecisionAction[]).find(action => action.decision === "advance");
    assert.ok(advance);
    assert.equal(recordUserDecisionContent(fx.projectRoot, fx.change, JSON.stringify(advance.record_input)).accepted, true);
    const advanced = transitionExplore(fx.projectRoot, fx.change, fx.changeRoot, "strict");
    assert.equal(advanced.to_state, "propose");
  } finally { fx.cleanup(); }
});

test("phase confirmation：normal Explore 绑定现有 critic override", () => {
  const fx = setupPropose();
  try {
    const created = transitionExplore(fx.projectRoot, fx.change, fx.changeRoot, "strict");
    const jobId = created.created_jobs[0];
    assert.equal(recordJobSubmitContent(
      fx.projectRoot, fx.change, fx.changeRoot, jobId,
      failedReviewerReportForJob(fx.projectRoot, fx.change, jobId),
    ).accepted, false);
    assert.equal(recordUserDecisionContent(fx.projectRoot, fx.change, JSON.stringify({
      scope: `review_rejection_override:${jobId}`,
      answer: "do_not_block",
      reason: "strict critic override 1",
      decision_source: "main_process",
    })).accepted, true);

    writeFileSync(join(fx.projectRoot, ".superspec", "config.json"), JSON.stringify({ workflow: { mode: "normal" } }));
    const ask1 = next(fx.projectRoot, fx.change, fx.changeRoot, "normal");
    assert.equal(ask1.path, "ask_user");
    const advance = (ask1.ask_user.actions as PhaseDecisionAction[]).find(action => action.decision === "advance");
    assert.ok(advance);
    assert.equal(advance.record_input.review_risk, "normal");

    assert.equal(recordUserDecisionContent(fx.projectRoot, fx.change, JSON.stringify({
      scope: `review_rejection_override:${jobId}`,
      answer: "do_not_block",
      reason: "strict critic override 2",
      decision_source: "user",
    })).accepted, true);
    const ask2 = next(fx.projectRoot, fx.change, fx.changeRoot, "normal");
    assert.equal(ask2.path, "ask_user");
    assert.notEqual(ask2.ask_user.scope, ask1.ask_user.scope, "normal gate 使用 critic，override 更新应使阶段确认失效");

    const advance2 = (ask2.ask_user.actions as PhaseDecisionAction[]).find(action => action.decision === "advance");
    assert.ok(advance2);
    assert.equal(recordUserDecisionContent(
      fx.projectRoot, fx.change, JSON.stringify(advance2.record_input),
    ).accepted, true);
    assert.equal(transitionExplore(fx.projectRoot, fx.change, fx.changeRoot, "normal").to_state, "propose");
  } finally { fx.cleanup(); }
});

test("review override 登记：非法输入、stale job 和旧 terminal job 均拒绝", () => {
  const fx = setupPropose();
  try {
    const created = transitionExplore(fx.projectRoot, fx.change, fx.changeRoot, "strict");
    const firstJobId = created.created_jobs[0];
    assert.equal(recordJobSubmitContent(
      fx.projectRoot,
      fx.change,
      fx.changeRoot,
      firstJobId,
      failedReviewerReportForJob(fx.projectRoot, fx.change, firstJobId),
    ).accepted, false);
    const base = {
      scope: `review_rejection_override:${firstJobId}`,
      answer: "do_not_block",
      reason: "越界问题",
      decision_source: "main_process",
    };
    assert.equal(recordUserDecisionContent(fx.projectRoot, fx.change, JSON.stringify({ ...base, answer: "dismiss" })).accepted, false);
    assert.equal(recordUserDecisionContent(fx.projectRoot, fx.change, JSON.stringify({ ...base, reason: "" })).accepted, false);
    assert.equal(recordUserDecisionContent(fx.projectRoot, fx.change, JSON.stringify({ ...base, decision_source: "reviewer" })).accepted, false);

    writeFileSync(
      join(fx.changeRoot, ".superspec", "artifacts", "discovery.md"),
      "# Discovery\n\nchanged after rejection\n",
    );
    const stale = recordUserDecisionContent(fx.projectRoot, fx.change, JSON.stringify({ ...base, reason: "stale" }));
    assert.equal(stale.accepted, false);
    assert.match(stale.message, /过期/);

    const retry = transitionExplore(fx.projectRoot, fx.change, fx.changeRoot, "strict");
    const secondJobId = retry.created_jobs[0];
    assert.equal(recordJobSubmitContent(
      fx.projectRoot,
      fx.change,
      fx.changeRoot,
      secondJobId,
      failedReviewerReportForJob(fx.projectRoot, fx.change, secondJobId, "DISC-002"),
    ).accepted, false);
    const oldTerminal = recordUserDecisionContent(fx.projectRoot, fx.change, JSON.stringify({ ...base, reason: "old terminal" }));
    assert.equal(oldTerminal.accepted, false);
    assert.match(oldTerminal.message, /最新的 terminal job/);
  } finally { fx.cleanup(); }
});

test("review override 登记：invalid_report 和非当前 gate 不可裁决", () => {
  const fx = setupPropose();
  try {
    const created = transitionExplore(fx.projectRoot, fx.change, fx.changeRoot, "strict");
    const jobId = created.created_jobs[0];
    appendEvent(fx.projectRoot, fx.change, makeEvent(fx.change, "job_rejected", {
      job_id: jobId,
      role: "critic",
      result_kind: "invalid_report",
      reason: "invalid report",
    }));
    const input = JSON.stringify({
      scope: `review_rejection_override:${jobId}`,
      answer: "do_not_block",
      reason: "不能绕过格式校验",
      decision_source: "main_process",
    });
    const invalidReport = recordUserDecisionContent(fx.projectRoot, fx.change, input);
    assert.equal(invalidReport.accepted, false);
    assert.match(invalidReport.message, /review_failed|无效报告/);

    appendEvent(fx.projectRoot, fx.change, makeEvent(fx.change, "transition_commit", {
      transition: "propose", from_state: "explore", to_state: "propose",
      outcome: "advanced", created_job_ids: [], reason: "leave explore",
    }));
    const notCurrent = recordUserDecisionContent(fx.projectRoot, fx.change, JSON.stringify({
      ...JSON.parse(input),
      reason: "gate no longer current",
    }));
    assert.equal(notCurrent.accepted, false);
    assert.match(notCurrent.message, /当前阶段/);
  } finally { fx.cleanup(); }
});

test("review override freshness：材料变化后旧裁决失效并创建新 packet", () => {
  const fx = setupPropose();
  try {
    const created = transitionExplore(fx.projectRoot, fx.change, fx.changeRoot, "strict");
    const jobId = created.created_jobs[0];
    const firstPacket = jobsPacket(fx.projectRoot, fx.change, jobId).packet;
    assert.ok(firstPacket);
    assert.equal(recordJobSubmitContent(
      fx.projectRoot,
      fx.change,
      fx.changeRoot,
      jobId,
      failedReviewerReportForJob(fx.projectRoot, fx.change, jobId),
    ).accepted, false);
    assert.equal(recordUserDecisionContent(fx.projectRoot, fx.change, JSON.stringify({
      scope: `review_rejection_override:${jobId}`,
      answer: "do_not_block",
      reason: "整份报告均为越界建议",
      decision_source: "main_process",
    })).accepted, true);

    writeFileSync(
      join(fx.changeRoot, ".superspec", "artifacts", "discovery.md"),
      "# Discovery\n\nnew packet material\n",
    );
    const retry = transitionExplore(fx.projectRoot, fx.change, fx.changeRoot, "strict");
    assert.equal(retry.outcome, "job_created");
    assert.equal(retry.created_jobs.length, 1);
    const retryPacket = jobsPacket(fx.projectRoot, fx.change, retry.created_jobs[0]).packet;
    assert.ok(retryPacket);
    assert.notEqual(retryPacket.packet_digest, firstPacket.packet_digest);
    assert.equal(retryPacket.previous_rejection?.job_id, jobId);
  } finally { fx.cleanup(); }
});

test("phase confirmation：apply_to_review 不绑定历史 ordinary review override", () => {
  const fx = setupPropose();
  try {
    const created = transitionExplore(fx.projectRoot, fx.change, fx.changeRoot, "strict");
    const jobId = created.created_jobs[0];
    const packet = jobsPacket(fx.projectRoot, fx.change, jobId).packet;
    assert.ok(packet);
    assert.equal(recordJobSubmitContent(
      fx.projectRoot,
      fx.change,
      fx.changeRoot,
      jobId,
      failedReviewerReportForJob(fx.projectRoot, fx.change, jobId),
    ).accepted, false);
    assert.equal(recordUserDecisionContent(fx.projectRoot, fx.change, JSON.stringify({
      scope: `review_rejection_override:${jobId}`,
      answer: "do_not_block",
      reason: "first override",
      decision_source: "main_process",
    })).accepted, true);

    appendEvent(fx.projectRoot, fx.change, makeEvent(fx.change, "transition_commit", {
      transition: "review-ready", from_state: "apply", to_state: "apply_done",
      outcome: "advanced", created_job_ids: [], reason: "test apply boundary",
    }));
    const beforeEvents = readEvents(fx.projectRoot, fx.change);
    const beforeSnapshot = rebuildSnapshot(fx.projectRoot, fx.change, fx.changeRoot);
    const before = phaseConfirmationForBoundary(
      fx.projectRoot, beforeEvents, beforeSnapshot, "apply_to_review", "strict",
    );
    assert.ok(before);

    appendEvent(fx.projectRoot, fx.change, makeEvent(fx.change, "user_decision_recorded", {
      accepted: true,
      scope: `review_rejection_override:${jobId}`,
      answer: "do_not_block",
      reason: "later historical override",
      decision_source: "user",
      review_rejection_override: {
        job_id: jobId,
        role: "critic",
        gate_id: "explore.discovery_review",
        packet_digest: packet.packet_digest,
      },
      input_digest: "sha256:later-override",
    }));
    const afterEvents = readEvents(fx.projectRoot, fx.change);
    const afterSnapshot = rebuildSnapshot(fx.projectRoot, fx.change, fx.changeRoot);
    const after = phaseConfirmationForBoundary(
      fx.projectRoot, afterEvents, afterSnapshot, "apply_to_review", "strict",
    );
    assert.ok(after);
    assert.equal(after.material_digest, before.material_digest);
    assert.equal(after.scope, before.scope);
  } finally { fx.cleanup(); }
});

test("CLI transition explore 默认完整审查：创建 critic job", () => {
  const fx = setupPropose();
  try {
    const cli = new URL("../src/cli.ts", import.meta.url).pathname;
    const output = execFileSync(process.execPath, [cli, "transition", "explore", "--change", fx.change], {
      cwd: fx.projectRoot,
      encoding: "utf8",
    });
    const result = JSON.parse(output);
    assert.equal(result.outcome, "job_created");
    assert.equal(result.created_jobs.length, 1);

    const snapshot = rebuildSnapshot(fx.projectRoot, fx.change, fx.changeRoot);
    assert.equal(snapshot.open_jobs[0].role, "critic");

    const nextOutput = execFileSync(process.execPath, [cli, "transition", "next", "--change", fx.change], {
      cwd: fx.projectRoot,
      encoding: "utf8",
    });
    const nextResult = JSON.parse(nextOutput);
    assert.equal(nextResult.path, "required_job");
    assert.equal(nextResult.required_jobs[0].job_id, result.created_jobs[0]);
    assert.deepEqual(nextResult.required_jobs[0].packet_argv, [
      "superspec", "jobs", "packet", "--change", fx.change, "--job", result.created_jobs[0],
    ]);
  } finally { fx.cleanup(); }
});

test("record user-decision：合法决策登记成功", () => {
  const fx = setupPropose();
  try {
    const decisionFile = join(fx.projectRoot, "decision.json");
    writeFileSync(decisionFile, JSON.stringify({
      scope: "enter_propose",
      question: "是否进入计划阶段？",
      answer: "yes",
    }));
    const result = recordUserDecision(fx.projectRoot, fx.change, decisionFile);
    assert.equal(result.accepted, true);
    assert.ok(result.message.includes("enter_propose"));

    const rawPath = rawFile(fx.projectRoot, fx.change, "user-decisions");
    const rawLines = readFileSync(rawPath, "utf8").trim().split("\n");
    assert.equal(rawLines.length, 1);
    assert.deepEqual(JSON.parse(rawLines[0]), {
      scope: "enter_propose",
      question: "是否进入计划阶段？",
      answer: "yes",
    });
    assert.deepEqual(rawDirFiles(fx.projectRoot, fx.change), ["user-decisions.jsonl"]);

    const event = readEvents(fx.projectRoot, fx.change).findLast(e => e.event_type === "user_decision_recorded");
    assert.ok(event);
    assert.equal(event.payload.raw_kind, "user-decisions");
    assert.equal(event.payload.raw_index, 0);
    assert.equal(event.payload.raw_digest, sha256Text(rawLines[0]));
  } finally { fx.cleanup(); }
});

test("record user-decision：同输入幂等且不重复写 raw", () => {
  const fx = setupPropose();
  try {
    const decisionFile = join(fx.projectRoot, "decision.json");
    writeFileSync(decisionFile, JSON.stringify({
      scope: "enter_propose",
      question: "是否进入计划阶段？",
      answer: "yes",
    }));

    const first = recordUserDecision(fx.projectRoot, fx.change, decisionFile);
    assert.equal(first.accepted, true);
    const rawPath = rawFile(fx.projectRoot, fx.change, "user-decisions");
    assert.equal(readFileSync(rawPath, "utf8").trim().split("\n").length, 1);
    const eventCount = readEvents(fx.projectRoot, fx.change).filter(e => e.event_type === "user_decision_recorded").length;

    const second = recordUserDecision(fx.projectRoot, fx.change, decisionFile);
    assert.equal(second.accepted, true);
    assert.ok(second.message.includes("幂等"));
    assert.equal(readFileSync(rawPath, "utf8").trim().split("\n").length, 1);
    assert.equal(readEvents(fx.projectRoot, fx.change).filter(e => e.event_type === "user_decision_recorded").length, eventCount);
  } finally { fx.cleanup(); }
});

test("record user-decision：raw append 失败时不写 accepted event", () => {
  const fx = setupPropose();
  try {
    const decisionFile = join(fx.projectRoot, "decision.json");
    writeFileSync(decisionFile, JSON.stringify({
      scope: "enter_propose",
      question: "是否进入计划阶段？",
      answer: "yes",
    }));
    mkdirSync(rawFile(fx.projectRoot, fx.change, "user-decisions"));

    assert.throws(() => recordUserDecision(fx.projectRoot, fx.change, decisionFile));
    assert.equal(readEvents(fx.projectRoot, fx.change).some(e => e.event_type === "user_decision_recorded"), false);
  } finally { fx.cleanup(); }
});

test("record user-decision：缺 scope 拒绝", () => {
  const fx = setupPropose();
  try {
    const decisionFile = join(fx.projectRoot, "decision.json");
    writeFileSync(decisionFile, JSON.stringify({ answer: "yes" }));
    const result = recordUserDecision(fx.projectRoot, fx.change, decisionFile);
    assert.equal(result.accepted, false);
    assert.ok(result.message.includes("scope"));
    assert.deepEqual(rawDirFiles(fx.projectRoot, fx.change), []);
  } finally { fx.cleanup(); }
});

test("record user-decision：非法 JSON 不写 raw archive", () => {
  const fx = setupPropose();
  try {
    const decisionFile = join(fx.projectRoot, "decision.json");
    writeFileSync(decisionFile, "{ not json\n");
    const result = recordUserDecision(fx.projectRoot, fx.change, decisionFile);
    assert.equal(result.accepted, false);
    assert.ok(result.message.includes("有效 JSON"));
    assert.deepEqual(rawDirFiles(fx.projectRoot, fx.change), []);
  } finally { fx.cleanup(); }
});

test("propose-ready：有待用户确认问题时不创建审查 job", () => {
  const projectRoot = mkdtempSync(join(tmpdir(), "superspec-p2proposeask-"));
  const change = "test-change";
  const changeRoot = join(projectRoot, "openspec", "changes", change);
  mkdirSync(join(changeRoot, ".superspec", "artifacts"), { recursive: true });
  writeFileSync(join(changeRoot, "proposal.md"), [
    "# Proposal",
    "",
    "## 待用户确认",
    "",
    "- [ ] DEC-001 是否保留兼容层？",
  ].join("\n"));
  writeFileSync(join(changeRoot, "tasks.md"), DOCUMENTATION_TASKS);
  writeFileSync(join(changeRoot, "design.md"), "# Design\n");
  writeFileSync(join(changeRoot, ".superspec", "artifacts", "discovery.md"), "# Discovery\n");
  writeFileSync(join(changeRoot, ".superspec", "artifacts", "test-contract.md"), "# TC\n");
  ensureChangeLayout(projectRoot, change);
  for (const [t, f, to] of [["init","init","init"],["explore","init","explore"],["propose","explore","propose"]] as const) {
    appendEvent(projectRoot, change, makeEvent(change, "transition_commit", {
      transition: t, from_state: f, to_state: to,
      outcome: "advanced", created_job_ids: [], reason: t,
      ...(t === "propose" ? {
        planning_validation_version: 2,
        planning_validation_profile: V2_DISABLED_PLANNING_PROFILE,
      } : {}),
    }, { transitionId: `T-${t}`, idempotencyKey: `${t}-key` }));
  }

  try {
    const before = readEvents(projectRoot, change).length;
    const result = proposeReady(projectRoot, change, changeRoot, "normal");
    assert.match(result.message, /待用户确认/);
    assert.equal(result.events_written, 0);
    assert.equal(result.created_jobs.length, 0);
    assert.equal(readEvents(projectRoot, change).length, before);
  } finally {
    rmSync(projectRoot, { recursive: true, force: true });
  }
});

test("propose-ready：已确认项不阻断审查 job 创建", () => {
  const projectRoot = mkdtempSync(join(tmpdir(), "superspec-p2proposeconfirmed-"));
  const change = "test-change";
  const changeRoot = join(projectRoot, "openspec", "changes", change);
  mkdirSync(join(changeRoot, ".superspec", "artifacts"), { recursive: true });
  writeFileSync(join(changeRoot, "proposal.md"), [
    "# Proposal",
    "",
    "## 待用户确认",
    "",
    "- [x] DEC-001 已确认兼容策略",
  ].join("\n"));
  writeFileSync(join(changeRoot, "tasks.md"), DOCUMENTATION_TASKS);
  writeFileSync(join(changeRoot, "design.md"), "# Design\n");
  writeFileSync(join(changeRoot, ".superspec", "artifacts", "discovery.md"), "# Discovery\n");
  writeFileSync(join(changeRoot, ".superspec", "artifacts", "test-contract.md"), "# TC\n");
  ensureChangeLayout(projectRoot, change);
  for (const [t, f, to] of [["init","init","init"],["explore","init","explore"],["propose","explore","propose"]] as const) {
    appendEvent(projectRoot, change, makeEvent(change, "transition_commit", {
      transition: t, from_state: f, to_state: to,
      outcome: "advanced", created_job_ids: [], reason: t,
      ...(t === "propose" ? {
        planning_validation_version: 2,
        planning_validation_profile: V2_DISABLED_PLANNING_PROFILE,
      } : {}),
    }, { transitionId: `T-${t}`, idempotencyKey: `${t}-key` }));
  }

  try {
    const result = proposeReady(projectRoot, change, changeRoot, "normal");
    assert.equal(result.outcome, "job_created");
    assert.equal(result.created_jobs.length, 1);
  } finally {
    rmSync(projectRoot, { recursive: true, force: true });
  }
});

test("propose-ready --risk normal：缺 discovery.md 时 block（基础职责）", () => {
  // 先把状态推到 propose（手动 seed）
  const projectRoot = mkdtempSync(join(tmpdir(), "superspec-p2b-"));
  const change = "test-change";
  const changeRoot = join(projectRoot, "openspec", "changes", change);
  mkdirSync(join(changeRoot, ".superspec", "artifacts"), { recursive: true });
  writeFileSync(join(changeRoot, "proposal.md"), "# Proposal\n");
  writeFileSync(join(changeRoot, "tasks.md"), DOCUMENTATION_TASKS);
  // 只写 test-contract，故意不写 discovery
  writeFileSync(join(changeRoot, ".superspec", "artifacts", "test-contract.md"), "# TC\n");
  ensureChangeLayout(projectRoot, change);
  // seed 到 propose
  for (const [t, f, to] of [["init","init","init"],["explore","init","explore"],["propose","explore","propose"]] as const) {
    appendEvent(projectRoot, change, makeEvent(change, "transition_commit", {
      transition: t, from_state: f, to_state: to,
      outcome: "advanced", created_job_ids: [], reason: t,
      ...(t === "propose" ? {
        planning_validation_version: 2,
        planning_validation_profile: V2_DISABLED_PLANNING_PROFILE,
      } : {}),
    }, { transitionId: `T-${t}`, idempotencyKey: `${t}-key` }));
  }

  try {
    const result = proposeReady(projectRoot, change, changeRoot, "normal");
    assert.ok(result.message.includes("discovery.md"), `应报缺 discovery，实际：${result.message}`);
    assert.equal(result.events_written, 0);
  } finally {
    rmSync(projectRoot, { recursive: true, force: true });
  }
});

test("propose-ready 与 start-apply：格式预检先于审查 job，拒绝重复 task ID", () => {
  const fx = setupPropose();
  try {
    appendEvent(fx.projectRoot, fx.change, makeEvent(fx.change, "transition_commit", {
      transition: "propose", from_state: "explore", to_state: "propose",
      outcome: "advanced", created_job_ids: [], reason: "seed propose",
      planning_validation_version: 2,
      planning_validation_profile: V2_DISABLED_PLANNING_PROFILE,
    }, { transitionId: "T-seed-propose", idempotencyKey: "seed-propose" }));
    writeFileSync(join(fx.changeRoot, "tasks.md"), [
      "# Tasks",
      "",
      "- [ ] TASK-001 First",
      "- [ ] TASK-001 Duplicate",
    ].join("\n"));

    const propose = proposeReady(fx.projectRoot, fx.change, fx.changeRoot, "normal");
    assert.match(propose.message, /task ID 重复/);
    assert.equal(propose.created_jobs.length, 0);

    appendEvent(fx.projectRoot, fx.change, makeEvent(fx.change, "transition_commit", {
      transition: "propose-ready", from_state: "propose", to_state: "propose_ready",
      outcome: "advanced", created_job_ids: [], reason: "seed malformed plan",
      workflow_mode: "minimal", execution_requirement_version: 2,
      planning_validation_version: 2,
      planning_validation_profile: V2_DISABLED_PLANNING_PROFILE,
    }, { transitionId: "T-seed-propose-ready", idempotencyKey: "seed-propose-ready" }));

    const apply = startApply(fx.projectRoot, fx.change, fx.changeRoot);
    assert.match(apply.message, /task ID 重复/);
    assert.equal(apply.created_jobs.length, 0);
  } finally {
    fx.cleanup();
  }
});

test("已初始化 v2 工作流：propose-ready 与 start-apply 解析执行依据文件和锚点", () => {
  const fx = setupPropose();
  try {
    writeFileSync(join(fx.projectRoot, "openspec", "config.yaml"), "schema: spec-driven\n");
    const planningProfile = planningValidationProfileForNewRound(fx.projectRoot);
    appendEvent(fx.projectRoot, fx.change, makeEvent(fx.change, "transition_commit", {
      transition: "propose", from_state: "explore", to_state: "propose",
      outcome: "advanced", created_job_ids: [], reason: "seed propose",
      planning_validation_version: 2,
      planning_validation_profile: planningProfile,
    }, { transitionId: "T-ref-propose", idempotencyKey: "ref-propose" }));
    writeFileSync(join(fx.changeRoot, "proposal.md"), [
      "# Proposal",
      "",
      "## Impact",
      "",
      "| Area | Reason |",
      "|---|---|",
      "| src/a.ts | 验证引用解析 |",
    ].join("\n"));
    writeFileSync(join(fx.changeRoot, "design.md"), "# Design\n");
    writeFileSync(join(fx.changeRoot, ".superspec", "artifacts", "test-contract.md"), "# Test Contract\n");
    writeFileSync(join(fx.changeRoot, "tasks.md"), [
      "# Tasks",
      "",
      "- [ ] TASK-001 Reference check",
      "  执行依据:",
      "  - 测试:",
      "  - 设计: design.md#Missing route",
      "  - 来源: proposal.md#Impact",
      "  - 验收: 可检查的结果",
      "  - 边界: 不改持久化",
    ].join("\n"));

    const invalidDesign = proposeReady(fx.projectRoot, fx.change, fx.changeRoot, "normal");
    assert.match(invalidDesign.message, /design\.md 缺少稳定结构标题：# 设计/);
    assert.match(invalidDesign.message, /design\.md 缺少稳定结构标题：## 实现方案/);
    assert.match(invalidDesign.message, /引用锚点不存在：design\.md#Missing route/);
    assert.equal(invalidDesign.created_jobs.length, 0);

    writeFileSync(join(fx.changeRoot, "design.md"), STRICT_DESIGN);
    const propose = proposeReady(fx.projectRoot, fx.change, fx.changeRoot, "normal");
    assert.match(propose.message, /引用锚点不存在：design\.md#Missing route/);
    assert.equal(propose.created_jobs.length, 0);

    appendEvent(fx.projectRoot, fx.change, makeEvent(fx.change, "transition_commit", {
      transition: "propose-ready", from_state: "propose", to_state: "propose_ready",
      outcome: "advanced", created_job_ids: [], reason: "seed invalid refs",
      workflow_mode: "normal", execution_requirement_version: 2,
      planning_validation_version: 2,
      planning_validation_profile: planningProfile,
    }, { transitionId: "T-ref-propose-ready", idempotencyKey: "ref-propose-ready" }));

    const apply = startApply(fx.projectRoot, fx.change, fx.changeRoot);
    assert.match(apply.message, /引用锚点不存在：design\.md#Missing route/);
    assert.equal(apply.created_jobs.length, 0);
  } finally {
    fx.cleanup();
  }
});

test("历史 v2 strict planning round 不追溯要求新版 design 结构", () => {
  const fx = setupPropose();
  try {
    writeFileSync(join(fx.projectRoot, "openspec", "config.yaml"), "schema: spec-driven\n");
    const currentProfile = planningValidationProfileForNewRound(fx.projectRoot);
    const historicalProfile = { version: 2, openspec: currentProfile.openspec } as const;
    appendEvent(fx.projectRoot, fx.change, makeEvent(fx.change, "transition_commit", {
      transition: "propose", from_state: "explore", to_state: "propose",
      outcome: "advanced", created_job_ids: [], reason: "seed historical v2 propose",
      planning_validation_version: 2,
      planning_validation_profile: historicalProfile,
    }, { transitionId: "T-historical-v2-propose", idempotencyKey: "historical-v2-propose" }));
    writeFileSync(join(fx.changeRoot, "proposal.md"), [
      "# Proposal",
      "",
      "## Impact",
      "",
      "| Area | Reason |",
      "|---|---|",
      "| src/a.ts | Historical compatibility |",
    ].join("\n"));
    writeFileSync(join(fx.changeRoot, "design.md"), "# Design\n\n## Route\n");
    writeFileSync(join(fx.changeRoot, ".superspec", "artifacts", "test-contract.md"), "# Test Contract\n");
    writeFileSync(join(fx.changeRoot, "tasks.md"), [
      "# Tasks",
      "",
      "- [ ] TASK-001 Historical design",
      "  执行依据:",
      "  - 测试:",
      "  - 设计: design.md#Route",
      "  - 来源: proposal.md#Impact",
      "  - 验收: 历史结构可继续推进",
      "  - 边界: 不改业务代码",
    ].join("\n"));

    const result = proposeReady(fx.projectRoot, fx.change, fx.changeRoot, "normal");
    assert.doesNotMatch(result.message, /design\.md .*稳定结构|design\.md 缺少稳定结构标题/);
  } finally {
    fx.cleanup();
  }
});

test("propose-ready --risk normal：基础职责全满足 + critic accepted → 推进", () => {
  const projectRoot = mkdtempSync(join(tmpdir(), "superspec-p2c-"));
  const change = "test-change";
  const changeRoot = join(projectRoot, "openspec", "changes", change);
  mkdirSync(join(changeRoot, ".superspec", "artifacts"), { recursive: true });
  writeFileSync(join(changeRoot, "proposal.md"), "# Proposal\n");
  writeFileSync(join(changeRoot, "tasks.md"), DOCUMENTATION_TASKS);
  writeFileSync(join(changeRoot, "design.md"), "# Design\n");
  writeFileSync(join(changeRoot, ".superspec", "artifacts", "discovery.md"), "# Discovery\n");
  writeFileSync(join(changeRoot, ".superspec", "artifacts", "test-contract.md"), "# TC\n");
  ensureChangeLayout(projectRoot, change);
  for (const [t, f, to] of [["init","init","init"],["explore","init","explore"],["propose","explore","propose"]] as const) {
    appendEvent(projectRoot, change, makeEvent(change, "transition_commit", {
      transition: t, from_state: f, to_state: to,
      outcome: "advanced", created_job_ids: [], reason: t,
      ...(t === "propose" ? {
        planning_validation_version: 2,
        planning_validation_profile: V2_DISABLED_PLANNING_PROFILE,
      } : {}),
    }, { transitionId: `T-${t}`, idempotencyKey: `${t}-key` }));
  }

  try {
    // 1. propose-ready normal → 创建 critic
    const t1 = proposeReady(projectRoot, change, changeRoot, "normal");
    assert.equal(t1.outcome, "job_created");
    assert.deepEqual(rebuildSnapshot(projectRoot, change, changeRoot).open_jobs.map(job => job.role), ["critic"]);

    // 2. normal 模式的计划审查 accepted
    acceptAllProposeJobs({ projectRoot, change, changeRoot });

    // 3. propose-ready normal → 推进到 propose_ready
    const t2 = proposeReady(projectRoot, change, changeRoot, "normal");
    assert.equal(t2.outcome, "advanced");
    assert.equal(t2.to_state, "propose_ready");
  } finally {
    rmSync(projectRoot, { recursive: true, force: true });
  }
});

test("propose-ready 默认完整审查：创建 critic + architect + test 审核工作项", () => {
  const projectRoot = mkdtempSync(join(tmpdir(), "superspec-p2strict-"));
  const change = "test-change";
  const changeRoot = join(projectRoot, "openspec", "changes", change);
  mkdirSync(join(changeRoot, ".superspec", "artifacts"), { recursive: true });
  writeFileSync(join(changeRoot, "proposal.md"), "# Proposal\n");
  writeFileSync(join(changeRoot, "tasks.md"), DOCUMENTATION_TASKS);
  writeFileSync(join(changeRoot, "design.md"), "# Design\n");
  writeFileSync(join(changeRoot, ".superspec", "artifacts", "discovery.md"), "# Discovery\n");
  writeFileSync(join(changeRoot, ".superspec", "artifacts", "test-contract.md"), "# TC\n");
  ensureChangeLayout(projectRoot, change);
  for (const [t, f, to] of [["init","init","init"],["explore","init","explore"],["propose","explore","propose"]] as const) {
    appendEvent(projectRoot, change, makeEvent(change, "transition_commit", {
      transition: t, from_state: f, to_state: to,
      outcome: "advanced", created_job_ids: [], reason: t,
      ...(t === "propose" ? {
        planning_validation_version: 2,
        planning_validation_profile: V2_DISABLED_PLANNING_PROFILE,
      } : {}),
    }, { transitionId: `T-${t}`, idempotencyKey: `${t}-key` }));
  }

  try {
    const result = proposeReady(projectRoot, change, changeRoot);
    assert.equal(result.outcome, "job_created");
    assert.equal(result.created_jobs.length, 3);

    const snapshot = rebuildSnapshot(projectRoot, change, changeRoot);
    assert.deepEqual(snapshot.open_jobs.map(j => j.role).sort(), [
      "architect",
      "critic",
      "test-engineer",
    ]);
    assert.deepEqual([...new Set(snapshot.open_jobs.map(j => j.gate_id))], ["propose.final_review"]);
    const packets = result.created_jobs.map(jobId => jobsPacket(projectRoot, change, jobId).packet);
    const byRole = new Map(packets.map(packet => [packet?.role, packet]));

    const critic = byRole.get("critic");
    assert.deepEqual(critic?.review_targets, [
      "proposal.md",
      "specs/",
      "tasks.md",
    ]);
    assert.deepEqual(critic?.read_only_refs, [
      "design.md",
      ".superspec/artifacts/test-contract.md",
      ".superspec/artifacts/discovery.md",
    ]);
    assert.deepEqual(critic?.boundFiles.map(file => file.path), [
      "proposal.md",
      "specs/",
      "tasks.md",
      ".superspec/artifacts/discovery.md",
    ]);

    const architect = byRole.get("architect");
    assert.deepEqual(architect?.review_targets, ["design.md"]);
    assert.deepEqual(architect?.read_only_refs, [
      "proposal.md",
      "specs/",
      "tasks.md",
      ".superspec/artifacts/discovery.md",
      ".superspec/artifacts/test-contract.md",
    ]);
    assert.deepEqual(architect?.boundFiles.map(file => file.path), ["design.md"]);

    const testEngineer = byRole.get("test-engineer");
    assert.deepEqual(testEngineer?.review_targets, [
      ".superspec/artifacts/test-contract.md",
      "tasks.md",
    ]);
    assert.deepEqual(testEngineer?.read_only_refs, [
      "proposal.md",
      "specs/",
      "design.md",
      ".superspec/artifacts/discovery.md",
    ]);
    assert.deepEqual(testEngineer?.boundFiles.map(file => file.path), [
      ".superspec/artifacts/test-contract.md",
      "tasks.md",
    ]);

    assert.match(critic?.output_instructions ?? "", /不得指定必须修改哪份文档或采用哪种技术方案/);
    assert.match(critic?.output_instructions ?? "", /read_only_refs 只在核对本次问题与上下游一致性时读取/);
    assert.match(critic?.output_instructions ?? "", /Propose 只需审查迁移策略、回滚\/兼容设计、任务与可执行测试计划/);
    assert.match(critic?.output_instructions ?? "", /不得只因实际环境证据尚未产生而 fail/);
    assert.match(critic?.output_instructions ?? "", /未经 proposal、design 或用户决定选定的新基础设施/);
  } finally {
    rmSync(projectRoot, { recursive: true, force: true });
  }
});

test("propose reviewer freshness：单文档变化只重启职责角色", () => {
  const cases: {
    name: string;
    mutate(changeRoot: string): void;
    staleRoles: JobRole[];
  }[] = [
    {
      name: "proposal",
      mutate: changeRoot => writeFileSync(join(changeRoot, "proposal.md"), "# Proposal\n\nchanged\n"),
      staleRoles: ["critic"],
    },
    {
      name: "specs",
      mutate: changeRoot => writeFileSync(join(changeRoot, "specs", "auth", "spec.md"), "# Spec\n\nchanged\n"),
      staleRoles: ["critic"],
    },
    {
      name: "design",
      mutate: changeRoot => writeFileSync(join(changeRoot, "design.md"), "# Design\n\nchanged\n"),
      staleRoles: ["architect"],
    },
    {
      name: "test-contract",
      mutate: changeRoot => writeFileSync(join(changeRoot, ".superspec", "artifacts", "test-contract.md"), "# TC\n\nchanged\n"),
      staleRoles: ["test-engineer"],
    },
    {
      name: "tasks",
      mutate: changeRoot => writeFileSync(
        join(changeRoot, "tasks.md"),
        DOCUMENTATION_TASKS.replace("Documentation fixture", "changed"),
      ),
      staleRoles: ["critic", "test-engineer"],
    },
    {
      name: "discovery",
      mutate: changeRoot => writeFileSync(join(changeRoot, ".superspec", "artifacts", "discovery.md"), "# Discovery\n\nchanged\n"),
      staleRoles: ["critic"],
    },
  ];

  for (const scenario of cases) {
    const fx = setupPropose();
    try {
      writeFileSync(join(fx.changeRoot, "design.md"), "# Design\n");
      writeFileSync(join(fx.changeRoot, ".superspec", "artifacts", "test-contract.md"), "# TC\n");
      mkdirSync(join(fx.changeRoot, "specs", "auth"), { recursive: true });
      writeFileSync(join(fx.changeRoot, "specs", "auth", "spec.md"), "# Spec\n");
      confirmCurrentPhase(fx.projectRoot, fx.change, fx.changeRoot, "normal");
      transitionExplore(fx.projectRoot, fx.change, fx.changeRoot, "normal");
      assert.equal(proposeReady(fx.projectRoot, fx.change, fx.changeRoot, "strict").created_jobs.length, 3);
      acceptAllProposeJobs(fx);

      scenario.mutate(fx.changeRoot);

      const staleSet = new Set(scenario.staleRoles);
      const expectedFresh = ["critic", "architect", "test-engineer"]
        .filter(role => !staleSet.has(role as JobRole))
        .sort();
      const freshRoles = rebuildSnapshot(fx.projectRoot, fx.change, fx.changeRoot).accepted_jobs
        .filter(job => job.created_from_transition === "propose-ready")
        .map(job => job.role)
        .sort();
      assert.deepEqual(freshRoles, expectedFresh, `${scenario.name} 的 fresh 角色不正确`);

      const retry = proposeReady(fx.projectRoot, fx.change, fx.changeRoot, "strict");
      assert.equal(retry.outcome, "job_created", `${scenario.name} 应创建复审 job`);
      const retryRoles = rebuildSnapshot(fx.projectRoot, fx.change, fx.changeRoot).open_jobs
        .map(job => job.role)
        .sort();
      assert.deepEqual(retryRoles, [...scenario.staleRoles].sort(), `${scenario.name} 的复审角色不正确`);
    } finally { fx.cleanup(); }
  }
});

test("propose reviewer retry：只继承当前 gate 的同角色 findings", () => {
  const fx = setupPropose();
  try {
    confirmCurrentPhase(fx.projectRoot, fx.change, fx.changeRoot, "normal");
    assert.equal(transitionExplore(fx.projectRoot, fx.change, fx.changeRoot, "normal").to_state, "propose");
    writeFileSync(join(fx.changeRoot, "design.md"), "# Design\n");
    writeFileSync(join(fx.changeRoot, ".superspec", "artifacts", "test-contract.md"), "# TC\n");

    const first = proposeReady(fx.projectRoot, fx.change, fx.changeRoot, "strict");
    assert.equal(first.created_jobs.length, 3);
    const firstByRole = new Map<JobRole, { jobId: string; digest: string }>();
    for (const jobId of first.created_jobs) {
      const packet = jobsPacket(fx.projectRoot, fx.change, jobId).packet;
      assert.ok(packet);
      firstByRole.set(packet.role, { jobId, digest: packet.packet_digest });
      const finding = { id: `${packet.role}-001`, evidence: `${packet.role} evidence` };
      assert.equal(recordJobSubmitContent(fx.projectRoot, fx.change, fx.changeRoot, jobId, JSON.stringify({
        role: packet.role,
        verdict: "fail",
        findings: [finding],
        review_scope: { checked_paths: packet.boundFiles.map(file => file.path) },
        reviewer: { kind: "codex-subagent", id: `${packet.role}-first` },
      })).accepted, false);
    }

    writeFileSync(join(fx.changeRoot, "proposal.md"), "# Proposal\n\nchanged\n");
    writeFileSync(join(fx.changeRoot, "design.md"), "# Design\n\nchanged\n");
    writeFileSync(join(fx.changeRoot, ".superspec", "artifacts", "test-contract.md"), "# TC\n\nchanged\n");

    const retry = proposeReady(fx.projectRoot, fx.change, fx.changeRoot, "strict");
    assert.equal(retry.created_jobs.length, 3);
    for (const jobId of retry.created_jobs) {
      const packet = jobsPacket(fx.projectRoot, fx.change, jobId).packet;
      assert.ok(packet);
      const firstJob = firstByRole.get(packet.role);
      assert.ok(firstJob);
      assert.equal(packet.previous_rejection?.job_id, firstJob.jobId);
      assert.deepEqual(packet.previous_rejection?.findings, [{
        id: `${packet.role}-001`,
        evidence: `${packet.role} evidence`,
      }]);
      assert.notEqual(packet.packet_digest, firstJob.digest);
      const otherRoles = ["critic", "architect", "test-engineer"].filter(role => role !== packet.role);
      for (const otherRole of otherRoles) {
        assert.doesNotMatch(JSON.stringify(packet.previous_rejection), new RegExp(`${otherRole}-001`));
      }
    }
  } finally { fx.cleanup(); }
});

test("propose review override：只裁决 rejected 角色，其他角色仍须 accepted", () => {
  const fx = setupPropose();
  try {
    confirmCurrentPhase(fx.projectRoot, fx.change, fx.changeRoot, "normal");
    assert.equal(transitionExplore(fx.projectRoot, fx.change, fx.changeRoot, "normal").to_state, "propose");
    writeFileSync(join(fx.changeRoot, "design.md"), "# Design\n");
    writeFileSync(join(fx.changeRoot, ".superspec", "artifacts", "test-contract.md"), "# TC\n");
    const created = proposeReady(fx.projectRoot, fx.change, fx.changeRoot, "strict");
    assert.equal(created.created_jobs.length, 3);
    let architectJobId = "";
    for (const jobId of created.created_jobs) {
      const packet = jobsPacket(fx.projectRoot, fx.change, jobId).packet;
      assert.ok(packet);
      if (packet.role === "architect") {
        architectJobId = jobId;
        assert.equal(recordJobSubmitContent(
          fx.projectRoot,
          fx.change,
          fx.changeRoot,
          jobId,
          failedReviewerReportForJob(fx.projectRoot, fx.change, jobId, "ARCH-OVERRIDE-001"),
        ).accepted, false);
      } else {
        assert.equal(recordJobSubmitContent(
          fx.projectRoot,
          fx.change,
          fx.changeRoot,
          jobId,
          reviewerReportForJob(fx.projectRoot, fx.change, jobId),
        ).accepted, true);
      }
    }
    assert.notEqual(architectJobId, "");

    const blocked = proposeReady(fx.projectRoot, fx.change, fx.changeRoot, "strict");
    assert.equal(blocked.outcome, "blocked");
    assert.equal(Object.hasOwn(blocked, "required_jobs"), false);
    assert.equal((blocked.details?.review_rejection as { job_id?: string })?.job_id, architectJobId);

    assert.equal(recordUserDecisionContent(fx.projectRoot, fx.change, JSON.stringify({
      scope: `review_rejection_override:${architectJobId}`,
      answer: "do_not_block",
      reason: "该问题是未由本次 change 引入的通用架构增强建议",
      decision_source: "main_process",
    })).accepted, true);

    const advanced = proposeReady(fx.projectRoot, fx.change, fx.changeRoot, "strict");
    assert.equal(advanced.to_state, "propose_ready");
    const snapshot = rebuildSnapshot(fx.projectRoot, fx.change, fx.changeRoot);
    assert.equal(snapshot.accepted_jobs.some(job => job.job_id === architectJobId), false);
    assert.deepEqual(
      snapshot.accepted_jobs
        .filter(job => job.created_from_transition === "propose-ready")
        .map(job => job.role)
        .sort(),
      ["critic", "test-engineer"],
    );
  } finally { fx.cleanup(); }
});

test("review gate：更新的 rejected terminal 不能被旧 accepted job 越过", () => {
  const fx = setupPropose();
  try {
    confirmCurrentPhase(fx.projectRoot, fx.change, fx.changeRoot, "normal");
    assert.equal(transitionExplore(fx.projectRoot, fx.change, fx.changeRoot, "normal").to_state, "propose");
    writeFileSync(join(fx.changeRoot, "design.md"), "# Design\n");
    writeFileSync(join(fx.changeRoot, ".superspec", "artifacts", "test-contract.md"), "# TC\n");
    const first = proposeReady(fx.projectRoot, fx.change, fx.changeRoot, "normal");
    const acceptedJobId = first.created_jobs[0];
    assert.equal(recordJobSubmitContent(
      fx.projectRoot,
      fx.change,
      fx.changeRoot,
      acceptedJobId,
      reviewerReportForJob(fx.projectRoot, fx.change, acceptedJobId),
    ).accepted, true);
    const acceptedJob = jobsPacket(fx.projectRoot, fx.change, acceptedJobId).packet;
    assert.ok(acceptedJob);

    const newerJob = appendOpenJob(fx.projectRoot, fx.change, "propose", {
      job_id: "JOB-newer-rejected-critic",
      role: "critic",
      gate_id: "propose.final_review",
      created_from_transition: "propose-ready",
      boundFiles: acceptedJob.boundFiles,
      review_targets: acceptedJob.review_targets,
      read_only_refs: acceptedJob.read_only_refs,
      packet_digest: "sha256:newer-rejected-packet",
    });
    assert.equal(recordJobSubmitContent(
      fx.projectRoot,
      fx.change,
      fx.changeRoot,
      newerJob.job_id,
      failedReviewerReportForJob(fx.projectRoot, fx.change, newerJob.job_id),
    ).accepted, false);

    const blocked = proposeReady(fx.projectRoot, fx.change, fx.changeRoot, "normal");
    assert.equal(blocked.outcome, "blocked");
    assert.equal((blocked.details?.review_rejection as { job_id?: string })?.job_id, newerJob.job_id);
    assert.equal(Object.hasOwn(blocked, "required_jobs"), false);
  } finally { fx.cleanup(); }
});

test("phase confirmation：start-apply 复用 propose-ready 冻结的 strict mode", () => {
  const fx = setupPropose();
  try {
    confirmCurrentPhase(fx.projectRoot, fx.change, fx.changeRoot, "normal");
    assert.equal(transitionExplore(fx.projectRoot, fx.change, fx.changeRoot, "normal").to_state, "propose");
    writeFileSync(join(fx.changeRoot, "design.md"), "# Design\n");
    writeFileSync(join(fx.changeRoot, ".superspec", "artifacts", "test-contract.md"), "# TC\n");
    const strict = proposeReady(fx.projectRoot, fx.change, fx.changeRoot, "strict");
    assert.equal(strict.created_jobs.length, 3);
    const rejectedByRole = new Map<string, string>();
    for (const jobId of strict.created_jobs) {
      const packet = jobsPacket(fx.projectRoot, fx.change, jobId).packet;
      assert.ok(packet);
      if (packet.role === "critic") {
        assert.equal(recordJobSubmitContent(
          fx.projectRoot, fx.change, fx.changeRoot, jobId,
          reviewerReportForJob(fx.projectRoot, fx.change, jobId),
        ).accepted, true);
      } else {
        assert.equal(recordJobSubmitContent(
          fx.projectRoot, fx.change, fx.changeRoot, jobId,
          failedReviewerReportForJob(fx.projectRoot, fx.change, jobId, `${packet.role}-HISTORICAL`),
        ).accepted, false);
        rejectedByRole.set(packet.role, jobId);
        assert.equal(recordUserDecisionContent(fx.projectRoot, fx.change, JSON.stringify({
          scope: `review_rejection_override:${jobId}`,
          answer: "do_not_block",
          reason: `${packet.role} historical override 1`,
          decision_source: "main_process",
        })).accepted, true);
      }
    }

    const advanced = proposeReady(fx.projectRoot, fx.change, fx.changeRoot, "strict");
    assert.equal(advanced.to_state, "propose_ready");
    const ask1 = next(fx.projectRoot, fx.change, fx.changeRoot, "strict");
    assert.equal(ask1.path, "ask_user");
    const architectJobId = rejectedByRole.get("architect");
    assert.ok(architectJobId);
    assert.equal(recordUserDecisionContent(fx.projectRoot, fx.change, JSON.stringify({
      scope: `review_rejection_override:${architectJobId}`,
      answer: "do_not_block",
      reason: "architect historical override 2",
      decision_source: "user",
    })).accepted, true);
    const ask2 = next(fx.projectRoot, fx.change, fx.changeRoot, "strict");
    assert.equal(ask2.path, "ask_user");
    assert.notEqual(ask2.ask_user.scope, ask1.ask_user.scope, "start-apply 会继续要求的历史角色 override 必须进入确认摘要");
  } finally { fx.cleanup(); }
});

test("phase confirmation：角色 recheck 不丢失原 required role 的 override", () => {
  const fx = setupPropose();
  try {
    confirmCurrentPhase(fx.projectRoot, fx.change, fx.changeRoot, "normal");
    assert.equal(transitionExplore(fx.projectRoot, fx.change, fx.changeRoot, "normal").to_state, "propose");
    writeFileSync(join(fx.changeRoot, "design.md"), "# Design\n");
    writeFileSync(join(fx.changeRoot, ".superspec", "artifacts", "test-contract.md"), "# TC\n");
    const strict = proposeReady(fx.projectRoot, fx.change, fx.changeRoot, "strict");
    let criticJobId = "";
    for (const jobId of strict.created_jobs) {
      const packet = jobsPacket(fx.projectRoot, fx.change, jobId).packet;
      assert.ok(packet);
      if (packet.role === "critic") {
        criticJobId = jobId;
        assert.equal(recordJobSubmitContent(
          fx.projectRoot, fx.change, fx.changeRoot, jobId,
          failedReviewerReportForJob(fx.projectRoot, fx.change, jobId, "CRITIC-OVERRIDE"),
        ).accepted, false);
        assert.equal(recordUserDecisionContent(fx.projectRoot, fx.change, JSON.stringify({
          scope: `review_rejection_override:${jobId}`,
          answer: "do_not_block",
          reason: "critic override before recheck",
          decision_source: "main_process",
        })).accepted, true);
      } else {
        assert.equal(recordJobSubmitContent(
          fx.projectRoot, fx.change, fx.changeRoot, jobId,
          reviewerReportForJob(fx.projectRoot, fx.change, jobId),
        ).accepted, true);
      }
    }
    assert.notEqual(criticJobId, "");
    assert.equal(proposeReady(fx.projectRoot, fx.change, fx.changeRoot, "strict").to_state, "propose_ready");

    writeFileSync(join(fx.changeRoot, "design.md"), "# Design\n\nrecheck\n");
    const recheck = startApply(fx.projectRoot, fx.change, fx.changeRoot);
    assert.equal(recheck.outcome, "job_created");
    assert.equal(recheck.created_jobs.length, 1);
    const recheckPacket = jobsPacket(fx.projectRoot, fx.change, recheck.created_jobs[0]).packet;
    assert.equal(recheckPacket?.role, "architect");
    assert.equal(recordJobSubmitContent(
      fx.projectRoot, fx.change, fx.changeRoot, recheck.created_jobs[0],
      reviewerReportForJob(fx.projectRoot, fx.change, recheck.created_jobs[0]),
    ).accepted, true);

    const ask1 = next(fx.projectRoot, fx.change, fx.changeRoot, "strict");
    assert.equal(ask1.path, "ask_user");
    assert.equal(recordUserDecisionContent(fx.projectRoot, fx.change, JSON.stringify({
      scope: `review_rejection_override:${criticJobId}`,
      answer: "do_not_block",
      reason: "critic override updated after architect recheck",
      decision_source: "user",
    })).accepted, true);
    const ask2 = next(fx.projectRoot, fx.change, fx.changeRoot, "strict");
    assert.equal(ask2.path, "ask_user");
    assert.notEqual(ask2.ask_user.scope, ask1.ask_user.scope, "原 required role override 仍应绑定阶段确认");
  } finally { fx.cleanup(); }
});

test("propose reviewer history：legacy 无 gate_id 的同角色失败仍可继承", () => {
  const fx = setupPropose();
  try {
    confirmCurrentPhase(fx.projectRoot, fx.change, fx.changeRoot, "normal");
    assert.equal(transitionExplore(fx.projectRoot, fx.change, fx.changeRoot, "normal").to_state, "propose");
    writeFileSync(join(fx.changeRoot, "design.md"), "# Design\n");
    writeFileSync(join(fx.changeRoot, ".superspec", "artifacts", "test-contract.md"), "# TC\n");
    const legacy = appendOpenJob(fx.projectRoot, fx.change, "propose", {
      job_id: "JOB-legacy-propose-history",
      role: "critic",
      created_from_transition: "propose-ready",
      boundFiles: [docRef(fx.changeRoot, "proposal.md")],
    });
    const legacyPacket = jobsPacket(fx.projectRoot, fx.change, legacy.job_id).packet;
    assert.deepEqual(legacyPacket?.review_targets, [
      "proposal.md",
      "tasks.md",
      "design.md",
      "specs/",
      ".superspec/artifacts/test-contract.md",
    ]);
    assert.deepEqual(legacyPacket?.read_only_refs, [".superspec/artifacts/discovery.md"]);
    assert.match(legacyPacket?.output_instructions ?? "", /不得指定必须修改哪份文档或采用哪种技术方案/);
    const finding = { id: "LEGACY-001", evidence: "legacy evidence" };
    assert.equal(recordJobSubmitContent(fx.projectRoot, fx.change, fx.changeRoot, legacy.job_id, JSON.stringify({
      role: "critic",
      verdict: "fail",
      findings: [finding],
      review_scope: { checked_paths: ["proposal.md"] },
      reviewer: { kind: "codex-subagent", id: "legacy-critic" },
    })).accepted, false);

    writeFileSync(join(fx.changeRoot, "proposal.md"), "# Proposal\n\nchanged\n");

    const retry = proposeReady(fx.projectRoot, fx.change, fx.changeRoot, "normal");
    const packet = jobsPacket(fx.projectRoot, fx.change, retry.created_jobs[0]).packet;
    assert.equal(packet?.previous_rejection?.job_id, legacy.job_id);
    assert.deepEqual(packet?.previous_rejection?.findings, [finding]);
  } finally { fx.cleanup(); }
});

test("explore critic fail 空 findings：可在同一工作项修正重交", () => {
  const fx = setupPropose();
  try {
    const first = transitionExplore(fx.projectRoot, fx.change, fx.changeRoot, "strict");
    const firstJobId = first.created_jobs[0];
    const finding = { id: "DISC-001", evidence: "missing reverse lookup" };
    assert.equal(recordJobSubmitContent(fx.projectRoot, fx.change, fx.changeRoot, firstJobId, JSON.stringify({
      role: "critic",
      verdict: "fail",
      findings: [finding],
      review_scope: reviewScopeForJob(fx.projectRoot, fx.change, firstJobId),
      reviewer: { kind: "codex-subagent", id: "critic-first" },
    })).accepted, false);

    writeFileSync(
      join(fx.changeRoot, ".superspec", "artifacts", "discovery.md"),
      "# Discovery\n\nchanged\n",
    );

    const second = transitionExplore(fx.projectRoot, fx.change, fx.changeRoot, "strict");
    const secondJobId = second.created_jobs[0];
    const emptyFail = recordJobSubmitContent(fx.projectRoot, fx.change, fx.changeRoot, secondJobId, JSON.stringify({
      role: "critic",
      verdict: "fail",
      findings: [],
      review_scope: reviewScopeForJob(fx.projectRoot, fx.change, secondJobId),
      reviewer: { kind: "codex-subagent", id: "critic-empty" },
    }));
    assert.equal(emptyFail.accepted, false);
    assert.match(emptyFail.message, /findings 至少包含一个问题/);
    assert.equal(emptyFail.job_state, "requested");
    assert.equal(readEvents(fx.projectRoot, fx.change).some(event =>
      event.event_type === "job_rejected" && event.payload.job_id === secondJobId
    ), false);
    assert.equal(transitionExplore(fx.projectRoot, fx.change, fx.changeRoot, "strict").required_jobs?.[0]?.job_id, secondJobId);
  } finally { fx.cleanup(); }
});

test("propose-ready strict：同一 gate 下 critic 不能满足 architect 或 test-engineer", () => {
  const fx = setupPropose();
  try {
    confirmCurrentPhase(fx.projectRoot, fx.change, fx.changeRoot, "normal");
    transitionExplore(fx.projectRoot, fx.change, fx.changeRoot, "normal");
    writeFileSync(join(fx.changeRoot, "design.md"), "# Design\n");
    writeFileSync(join(fx.changeRoot, ".superspec", "artifacts", "test-contract.md"), "# TC\n");

    const normal = proposeReady(fx.projectRoot, fx.change, fx.changeRoot, "normal");
    assert.equal(normal.outcome, "job_created");
    acceptAllProposeJobs(fx);

    const strict = proposeReady(fx.projectRoot, fx.change, fx.changeRoot, "strict");
    assert.equal(strict.outcome, "job_created");
    const snapshot = rebuildSnapshot(fx.projectRoot, fx.change, fx.changeRoot);
    assert.deepEqual(snapshot.open_jobs.map(job => job.role).sort(), ["architect", "test-engineer"]);
    assert.deepEqual([...new Set(snapshot.open_jobs.map(job => job.gate_id))], ["propose.final_review"]);
  } finally { fx.cleanup(); }
});

test("propose-ready normal：旧 accepted critic job 无 gate_id 仍可满足最终计划审查", () => {
  const fx = setupPropose();
  try {
    confirmCurrentPhase(fx.projectRoot, fx.change, fx.changeRoot, "normal");
    transitionExplore(fx.projectRoot, fx.change, fx.changeRoot, "normal");
    writeFileSync(join(fx.changeRoot, "design.md"), "# Design\n");
    writeFileSync(join(fx.changeRoot, ".superspec", "artifacts", "test-contract.md"), "# TC\n");

    const job = appendOpenJob(fx.projectRoot, fx.change, "propose", {
      job_id: "JOB-legacy-propose-critic",
      role: "critic",
      created_from_transition: "propose-ready",
      boundFiles: ["proposal.md", "tasks.md", "design.md", ".superspec/artifacts/discovery.md", ".superspec/artifacts/test-contract.md"]
        .map(path => ({ path, sha: sha256File(join(fx.changeRoot, path)) ?? "sha256:missing" })),
    });
    appendEvent(fx.projectRoot, fx.change, makeEvent(fx.change, "job_accepted", {
      job_id: job.job_id,
      role: job.role,
      report_digest: "sha256:legacy-propose-report",
      accepted_at: new Date().toISOString(),
    }));

    const result = proposeReady(fx.projectRoot, fx.change, fx.changeRoot, "normal");
    assert.equal(result.outcome, "advanced");
    assert.equal(result.to_state, "propose_ready");
    assert.equal(result.created_jobs.length, 0);
  } finally { fx.cleanup(); }
});

test("legacy propose job：已取消历史绑定路径缺失时仅 stale，且新 job 不恢复旧路径", () => {
  const fx = setupPropose();
  try {
    confirmCurrentPhase(fx.projectRoot, fx.change, fx.changeRoot, "normal");
    transitionExplore(fx.projectRoot, fx.change, fx.changeRoot, "normal");
    writeFileSync(join(fx.changeRoot, "design.md"), "# Design\n");
    writeFileSync(join(fx.changeRoot, ".superspec", "artifacts", "test-contract.md"), "# TC\n");
    const legacyPath = ".superspec/artifacts/business-invariants.md";
    writeFileSync(join(fx.changeRoot, legacyPath), "# Legacy\n");

    const boundPaths = [
      "proposal.md",
      "tasks.md",
      "design.md",
      "specs/",
      ".superspec/artifacts/discovery.md",
      legacyPath,
      ".superspec/artifacts/test-contract.md",
    ];
    const job = appendOpenJob(fx.projectRoot, fx.change, "propose", {
      job_id: "JOB-legacy-retired-path",
      role: "critic",
      created_from_transition: "propose-ready",
      boundFiles: boundPaths.map(path => docRef(fx.changeRoot, path)),
    });
    appendEvent(fx.projectRoot, fx.change, makeEvent(fx.change, "job_accepted", {
      job_id: job.job_id,
      role: job.role,
      report_digest: "sha256:legacy-retired-path-report",
      accepted_at: new Date().toISOString(),
    }));
    assert.equal(
      rebuildSnapshot(fx.projectRoot, fx.change, fx.changeRoot).accepted_jobs
        .filter(accepted => accepted.created_from_transition === "propose-ready").length,
      1,
    );

    rmSync(join(fx.changeRoot, legacyPath));
    assert.equal(
      rebuildSnapshot(fx.projectRoot, fx.change, fx.changeRoot).accepted_jobs
        .filter(accepted => accepted.created_from_transition === "propose-ready").length,
      0,
    );

    const retry = proposeReady(fx.projectRoot, fx.change, fx.changeRoot, "normal");
    assert.equal(retry.outcome, "job_created");
    const packet = jobsPacket(fx.projectRoot, fx.change, retry.created_jobs[0]).packet;
    assert.ok(packet);
    assert.equal(packet.boundFiles.some(file => file.path === legacyPath), false);
  } finally { fx.cleanup(); }
});

test("propose-ready strict：explore 阶段 critic accepted 不能满足 proposal critic", () => {
  const fx = setupPropose();
  try {
    const first = transitionExplore(fx.projectRoot, fx.change, fx.changeRoot, "strict");
    assert.equal(first.outcome, "job_created");
    const reportPath = join(fx.projectRoot, "explore-critic.json");
    writeFileSync(reportPath, reviewerReportForJob(fx.projectRoot, fx.change, first.created_jobs[0]));
    const record = recordJobSubmit(fx.projectRoot, fx.change, fx.changeRoot, first.created_jobs[0], reportPath);
    assert.equal(record.accepted, true);

    confirmCurrentPhase(fx.projectRoot, fx.change, fx.changeRoot);
    const second = transitionExplore(fx.projectRoot, fx.change, fx.changeRoot, "strict");
    assert.equal(second.to_state, "propose");

    writeFileSync(join(fx.changeRoot, "design.md"), "# Design\n");
    writeFileSync(join(fx.changeRoot, ".superspec", "artifacts", "test-contract.md"), "# TC\n");

    const result = proposeReady(fx.projectRoot, fx.change, fx.changeRoot, "strict");
    assert.equal(result.outcome, "job_created");
    const snapshot = rebuildSnapshot(fx.projectRoot, fx.change, fx.changeRoot);
    assert.ok(snapshot.open_jobs.some(j => j.role === "critic" && j.created_from_transition === "propose-ready"));
  } finally { fx.cleanup(); }
});

test("完整 e2e（Phase 2）：init→explore→写 discovery→propose→propose-ready normal→job→accept→propose_ready", () => {
  const projectRoot = mkdtempSync(join(tmpdir(), "superspec-p2e2e-"));
  const change = "test-change";
  const changeRoot = join(projectRoot, "openspec", "changes", change);
  mkdirSync(join(changeRoot, ".superspec", "artifacts"), { recursive: true });
  writeFileSync(join(changeRoot, "proposal.md"), "# Proposal\n");
  writeFileSync(join(changeRoot, "tasks.md"), DOCUMENTATION_TASKS);
  writeFileSync(join(changeRoot, "design.md"), "# Design\n");
  ensureChangeLayout(projectRoot, change);

  try {
    // init
    appendEvent(projectRoot, change, makeEvent(change, "transition_commit", {
      transition: "init", from_state: "init", to_state: "init",
      outcome: "advanced", created_job_ids: [], reason: "init",
    }, { transitionId: "T-init", idempotencyKey: "init-key" }));

    // explore（init→explore）
    transitionExplore(projectRoot, change, changeRoot);
    let snap = rebuildSnapshot(projectRoot, change, changeRoot);
    assert.equal(snap.state, "explore");

    // 写 discovery.md + 基础职责文档
    writeFileSync(join(changeRoot, ".superspec", "artifacts", "discovery.md"), "# Discovery\n\nDone.\n");
    writeFileSync(join(changeRoot, ".superspec", "artifacts", "test-contract.md"), "# TC\n");

    // explore→propose
    confirmCurrentPhase(projectRoot, change, changeRoot, "normal");
    const exploreResult = transitionExplore(projectRoot, change, changeRoot, "normal");
    assert.equal(exploreResult.to_state, "propose");

    // propose-ready normal → 创建 job
    const t1 = proposeReady(projectRoot, change, changeRoot, "normal");
    assert.equal(t1.outcome, "job_created");

    // record job-submit → accepted
    acceptAllProposeJobs({ projectRoot, change, changeRoot });

    // propose-ready normal → 推进
    const t2 = proposeReady(projectRoot, change, changeRoot, "normal");
    assert.equal(t2.to_state, "propose_ready");

    snap = rebuildSnapshot(projectRoot, change, changeRoot);
    assert.equal(snap.state, "propose_ready");
  } finally {
    rmSync(projectRoot, { recursive: true, force: true });
  }
});

test("next 在 explore 有空 discovery.md 时返回 ask_user", () => {
  const fx = setupExplore();
  try {
    writeFileSync(join(fx.changeRoot, ".superspec", "artifacts", "discovery.md"), "");
    const result = next(fx.projectRoot, fx.change, fx.changeRoot);
    assert.equal(result.path, "ask_user");
    assert.ok(result.reason.includes("为空"), `应报"为空"，实际：${result.reason}`);
  } finally { fx.cleanup(); }
});

test("next 在 explore 已有但结构无效的 discovery 时仍返回校验反馈", () => {
  const fx = setupExplore();
  try {
    writeFileSync(join(fx.changeRoot, ".superspec", "artifacts", "discovery.md"), [
      "# Discovery",
      "",
      "## 链路五要素",
      "| ID | 状态 |",
      "|---|---|",
      "| CHAIN-001 | 错误状态 |",
      "",
    ].join("\n"));
    const result = next(fx.projectRoot, fx.change, fx.changeRoot);
    assert.equal(result.path, "ask_user");
    assert.notEqual(result.path, "artifact_required");
    assert.match(result.reason, /链路五要素/);
  } finally { fx.cleanup(); }
});

test("architect 审查时 design 缺失：新建后仅 architect accepted job 失效", () => {
  const fx = setupPropose();
  try {
    confirmCurrentPhase(fx.projectRoot, fx.change, fx.changeRoot, "normal");
    assert.equal(transitionExplore(fx.projectRoot, fx.change, fx.changeRoot, "normal").to_state, "propose");
    writeFileSync(join(fx.changeRoot, ".superspec", "artifacts", "test-contract.md"), "# TC\n");

    assert.equal(proposeReady(fx.projectRoot, fx.change, fx.changeRoot, "strict").created_jobs.length, 3);
    const firstJobId = rebuildSnapshot(fx.projectRoot, fx.change, fx.changeRoot).open_jobs
      .find(job => job.role === "architect")?.job_id;
    assert.ok(firstJobId);
    const firstPacket = jobsPacket(fx.projectRoot, fx.change, firstJobId).packet;
    assert.deepEqual(firstPacket?.boundFiles.find(file => file.path === "design.md"), {
      path: "design.md",
      sha: "sha256:missing",
    });
    acceptAllProposeJobs(fx);

    writeFileSync(join(fx.changeRoot, "design.md"), "# Design\n");
    assert.deepEqual(
      rebuildSnapshot(fx.projectRoot, fx.change, fx.changeRoot).accepted_jobs
        .filter(job => job.created_from_transition === "propose-ready")
        .map(job => job.role)
        .sort(),
      ["critic", "test-engineer"],
    );
    const retry = proposeReady(fx.projectRoot, fx.change, fx.changeRoot, "strict");
    assert.equal(retry.outcome, "job_created");
    const retryJob = rebuildSnapshot(fx.projectRoot, fx.change, fx.changeRoot).open_jobs[0];
    assert.equal(retryJob.role, "architect");
    assert.notEqual(retryJob.job_id, firstJobId);
  } finally { fx.cleanup(); }
});

test("CLI status：区分 fresh/historical/stale accepted jobs", () => {
  const projectRoot = mkdtempSync(join(tmpdir(), "superspec-p2status-"));
  const change = "test-change";
  const changeRoot = join(projectRoot, "openspec", "changes", change);
  mkdirSync(join(changeRoot, ".superspec", "artifacts"), { recursive: true });
  writeFileSync(join(changeRoot, "proposal.md"), "# Proposal\noriginal");
  writeFileSync(join(changeRoot, "tasks.md"), DOCUMENTATION_TASKS);
  writeFileSync(join(changeRoot, "design.md"), "# Design\n");
  writeFileSync(join(changeRoot, ".superspec", "artifacts", "discovery.md"), "# Discovery\n");
  writeFileSync(join(changeRoot, ".superspec", "artifacts", "test-contract.md"), "# TC\n");
  ensureChangeLayout(projectRoot, change);
  for (const [t, f, to] of [["init","init","init"],["explore","init","explore"],["propose","explore","propose"]] as const) {
    appendEvent(projectRoot, change, makeEvent(change, "transition_commit", {
      transition: t, from_state: f, to_state: to,
      outcome: "advanced", created_job_ids: [], reason: t,
      ...(t === "propose" ? {
        planning_validation_version: 2,
        planning_validation_profile: V2_DISABLED_PLANNING_PROFILE,
      } : {}),
    }, { transitionId: `T-${t}`, idempotencyKey: `${t}-key` }));
  }

  try {
    const t1 = proposeReady(projectRoot, change, changeRoot, "normal");
    const reportPath = join(projectRoot, "critic.json");
    writeFileSync(reportPath, reviewerReportForJob(projectRoot, change, t1.created_jobs[0]));
    const record = recordJobSubmit(projectRoot, change, changeRoot, t1.created_jobs[0], reportPath);
    assert.equal(record.accepted, true);

    writeFileSync(join(changeRoot, "proposal.md"), "# Proposal\nchanged");

    const cli = new URL("../src/cli.ts", import.meta.url).pathname;
    const output = execFileSync(process.execPath, [cli, "status", "--change", change], {
      cwd: projectRoot,
      encoding: "utf8",
    });
    const status = JSON.parse(output);
    assert.equal(status.accepted_jobs, 0);
    assert.equal(status.historical_accepted_jobs, 1);
    assert.equal(status.stale_accepted_jobs, 1);
  } finally {
    rmSync(projectRoot, { recursive: true, force: true });
  }
});

// ===== specs/ 目录绑定与 freshness =====

function setupProposeWithSpecs(): ReturnType<typeof setupPropose> {
  const fx = setupPropose();
  writeFileSync(join(fx.changeRoot, "design.md"), "# Design\n");
  writeFileSync(join(fx.changeRoot, ".superspec", "artifacts", "test-contract.md"), "# TC\n");
  mkdirSync(join(fx.changeRoot, "specs", "auth"), { recursive: true });
  writeFileSync(join(fx.changeRoot, "specs", "auth", "spec.md"), "# Auth Spec\n\n## ADDED Requirements\n");
  return fx;
}

function acceptAllProposeJobs(fx: { projectRoot: string; change: string; changeRoot: string }): void {
  const snapshot = rebuildSnapshot(fx.projectRoot, fx.change, fx.changeRoot);
  for (const job of snapshot.open_jobs) {
    const reportPath = join(fx.projectRoot, `${job.role}.json`);
    writeFileSync(reportPath, reviewerReportForJob(fx.projectRoot, fx.change, job.job_id));
    assert.equal(recordJobSubmit(fx.projectRoot, fx.change, fx.changeRoot, job.job_id, reportPath).accepted, true);
  }
}

test("specs 绑定：propose-ready job 的 boundFiles 含 specs/ 目录聚合指纹", () => {
  const fx = setupProposeWithSpecs();
  try {
    confirmCurrentPhase(fx.projectRoot, fx.change, fx.changeRoot, "normal");
    transitionExplore(fx.projectRoot, fx.change, fx.changeRoot, "normal");
    const result = proposeReady(fx.projectRoot, fx.change, fx.changeRoot, "normal");
    assert.equal(result.outcome, "job_created");
    const snapshot = rebuildSnapshot(fx.projectRoot, fx.change, fx.changeRoot);
    const specsRef = snapshot.open_jobs[0].boundFiles.find(f => f.path === "specs/");
    assert.ok(specsRef, "boundFiles 应包含 specs/");
    assert.match(specsRef.sha, /^sha256:/);
  } finally { fx.cleanup(); }
});

test("specs freshness：审查通过后修改 specs 文件，accepted job 变 stale", () => {
  const fx = setupProposeWithSpecs();
  try {
    confirmCurrentPhase(fx.projectRoot, fx.change, fx.changeRoot, "normal");
    transitionExplore(fx.projectRoot, fx.change, fx.changeRoot, "normal");
    proposeReady(fx.projectRoot, fx.change, fx.changeRoot, "normal");
    acceptAllProposeJobs(fx);
    assert.equal(
      rebuildSnapshot(fx.projectRoot, fx.change, fx.changeRoot).accepted_jobs
        .filter(job => job.created_from_transition === "propose-ready").length,
      1,
    );

    writeFileSync(join(fx.changeRoot, "specs", "auth", "spec.md"), "# Auth Spec\n\n## ADDED Requirements\n\n改动\n");
    const snap = rebuildSnapshot(fx.projectRoot, fx.change, fx.changeRoot);
    assert.equal(
      snap.accepted_jobs.filter(job => job.created_from_transition === "propose-ready").length,
      0,
      "修改 specs 文件应作废已通过的计划审查",
    );
  } finally { fx.cleanup(); }
});

test("specs freshness：审查通过后新增 specs 文件同样作废审查", () => {
  const fx = setupProposeWithSpecs();
  try {
    confirmCurrentPhase(fx.projectRoot, fx.change, fx.changeRoot, "normal");
    transitionExplore(fx.projectRoot, fx.change, fx.changeRoot, "normal");
    proposeReady(fx.projectRoot, fx.change, fx.changeRoot, "normal");
    acceptAllProposeJobs(fx);

    mkdirSync(join(fx.changeRoot, "specs", "billing"), { recursive: true });
    writeFileSync(join(fx.changeRoot, "specs", "billing", "spec.md"), "# Billing Spec\n");
    const snap = rebuildSnapshot(fx.projectRoot, fx.change, fx.changeRoot);
    assert.equal(
      snap.accepted_jobs.filter(job => job.created_from_transition === "propose-ready").length,
      0,
      "新增 specs 文件应作废已通过的计划审查",
    );
  } finally { fx.cleanup(); }
});

test("specs freshness：删除 specs 文件同样作废审查", () => {
  const fx = setupProposeWithSpecs();
  try {
    confirmCurrentPhase(fx.projectRoot, fx.change, fx.changeRoot, "normal");
    transitionExplore(fx.projectRoot, fx.change, fx.changeRoot, "normal");
    proposeReady(fx.projectRoot, fx.change, fx.changeRoot, "normal");
    acceptAllProposeJobs(fx);

    rmSync(join(fx.changeRoot, "specs", "auth", "spec.md"));
    const snap = rebuildSnapshot(fx.projectRoot, fx.change, fx.changeRoot);
    assert.equal(
      snap.accepted_jobs.filter(job => job.created_from_transition === "propose-ready").length,
      0,
      "删除 specs 文件应作废已通过的计划审查",
    );
  } finally { fx.cleanup(); }
});

test("specs freshness：审查时无 specs 目录、通过后新建 specs 同样作废审查", () => {
  const fx = setupPropose();
  try {
    writeFileSync(join(fx.changeRoot, "design.md"), "# Design\n");
    writeFileSync(join(fx.changeRoot, ".superspec", "artifacts", "test-contract.md"), "# TC\n");
    confirmCurrentPhase(fx.projectRoot, fx.change, fx.changeRoot, "normal");
    transitionExplore(fx.projectRoot, fx.change, fx.changeRoot, "normal");
    proposeReady(fx.projectRoot, fx.change, fx.changeRoot, "normal");
    const openSnap = rebuildSnapshot(fx.projectRoot, fx.change, fx.changeRoot);
    assert.ok(openSnap.open_jobs[0].boundFiles.some(f => f.path === "specs/"), "无 specs 目录时也应绑定空指纹");
    acceptAllProposeJobs(fx);

    mkdirSync(join(fx.changeRoot, "specs", "auth"), { recursive: true });
    writeFileSync(join(fx.changeRoot, "specs", "auth", "spec.md"), "# Auth Spec\n");
    const snap = rebuildSnapshot(fx.projectRoot, fx.change, fx.changeRoot);
    assert.equal(
      snap.accepted_jobs.filter(job => job.created_from_transition === "propose-ready").length,
      0,
      "审查后新建 specs 目录应作废已通过的计划审查",
    );
  } finally { fx.cleanup(); }
});

test("specs freshness：specs 未变化时审查保持 accepted 不误伤", () => {
  const fx = setupProposeWithSpecs();
  try {
    confirmCurrentPhase(fx.projectRoot, fx.change, fx.changeRoot, "normal");
    transitionExplore(fx.projectRoot, fx.change, fx.changeRoot, "normal");
    proposeReady(fx.projectRoot, fx.change, fx.changeRoot, "normal");
    acceptAllProposeJobs(fx);

    const snap = rebuildSnapshot(fx.projectRoot, fx.change, fx.changeRoot);
    assert.equal(
      snap.accepted_jobs.filter(job => job.created_from_transition === "propose-ready").length,
      1,
      "specs 未变化不应误判 stale",
    );
  } finally { fx.cleanup(); }
});

test("specs 容错：specs/ 含损坏 symlink 时 rebuildSnapshot 不崩溃，异常项不参与指纹", () => {
  const fx = setupProposeWithSpecs();
  try {
    const before = rebuildSnapshot(fx.projectRoot, fx.change, fx.changeRoot).document_digests["specs/"];
    symlinkSync(join(fx.changeRoot, "specs", "no-such-target.md"), join(fx.changeRoot, "specs", "broken-link.md"));
    const after = rebuildSnapshot(fx.projectRoot, fx.change, fx.changeRoot).document_digests["specs/"];
    assert.equal(after, before, "损坏 symlink 应被跳过，不影响 specs/ 聚合指纹");
  } finally { fx.cleanup(); }
});

test("specs 容错：specs/ 中指向外部目录的 symlink 不参与指纹", () => {
  const fx = setupProposeWithSpecs();
  try {
    mkdirSync(join(fx.projectRoot, "outside-specs"), { recursive: true });
    writeFileSync(join(fx.projectRoot, "outside-specs", "external.md"), "# External\n");
    const before = rebuildSnapshot(fx.projectRoot, fx.change, fx.changeRoot).document_digests["specs/"];
    symlinkSync(join(fx.projectRoot, "outside-specs"), join(fx.changeRoot, "specs", "outside-link"));
    const after = rebuildSnapshot(fx.projectRoot, fx.change, fx.changeRoot).document_digests["specs/"];
    assert.equal(after, before, "目录 symlink 应被跳过，不应把 specs/ 外部 Markdown 算进聚合指纹");
  } finally { fx.cleanup(); }
});
