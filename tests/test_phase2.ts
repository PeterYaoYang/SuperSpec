// SuperSpec 流程引擎 — Phase 2 测试：explore + propose + 基础职责

import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, existsSync, readFileSync, readdirSync, symlinkSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { ensureChangeLayout, readEvents, appendEvent, makeEvent, rawFile, sha256File, sha256Text } from "../src/store.ts";
import { rebuildSnapshot } from "../src/sync.ts";
import { next } from "../src/next.ts";
import { proposeReady, transitionExplore } from "../src/transition.ts";
import { recordUserDecision, recordJobSubmit, jobsPacket } from "../src/record.ts";
import { countDiscoveryOpenQuestions, countProposeOpenQuestionsInContent, validateDiscovery, validateDiscoveryChainCoverage } from "../src/format.ts";
import type { Job, JobRole, State } from "../src/types.ts";

// ===== 夹具 =====

function setupExplore(): { projectRoot: string; change: string; changeRoot: string; cleanup: () => void } {
  const projectRoot = mkdtempSync(join(tmpdir(), "superspec-p2-"));
  const change = "test-change";
  const changeRoot = join(projectRoot, "openspec", "changes", change);
  mkdirSync(join(changeRoot, ".superspec", "artifacts"), { recursive: true });
  writeFileSync(join(changeRoot, "proposal.md"), "# Proposal\n\nTest.\n");
  writeFileSync(join(changeRoot, "tasks.md"), "# Tasks\n\n- [ ] TASK-001\n");
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

function reviewerReport(role: "critic" | "architect" | "test-engineer" = "critic"): string {
  return JSON.stringify({
    role,
    verdict: "pass",
    findings: [],
    reviewer: { kind: "codex-subagent", id: "test-reviewer" },
    summary: "通过",
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

test("validateDiscovery：未知阻塞即使有待确认项也阻断推进", () => {
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
    assert.equal(result.ok, false);
    assert.match(result.message, /未确认问题/);
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
    assert.ok(result.message.includes("未确认"), result.message);
    assert.equal(result.events_written, 0);
  } finally { fx.cleanup(); }
});

test("explore→propose normal：discovery.md 无未确认问题时推进", () => {
  const fx = setupPropose();
  try {
    const result = transitionExplore(fx.projectRoot, fx.change, fx.changeRoot, "normal");
    assert.equal(result.outcome, "advanced");
    assert.equal(result.to_state, "propose");

    const snapshot = rebuildSnapshot(fx.projectRoot, fx.change, fx.changeRoot);
    assert.equal(snapshot.state, "propose");
  } finally { fx.cleanup(); }
});

test("next 在 explore 无 discovery 时返回 ask_user", () => {
  const fx = setupExplore();
  try {
    const result = next(fx.projectRoot, fx.change, fx.changeRoot);
    assert.equal(result.path, "ask_user");
    assert.ok(result.ask_user.scope.includes("explore"));
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

test("next 在 explore 显式 normal 风险时返回带 risk 的 transition 命令", () => {
  const fx = setupPropose();
  try {
    const result = next(fx.projectRoot, fx.change, fx.changeRoot, "normal");
    assert.equal(result.path, "next_command");
    assert.ok(result.next_command.includes('transition explore --change "test-change" --risk normal'));
  } finally { fx.cleanup(); }
});

test("next 在 propose 待用户确认问题优先于审查 job", () => {
  const fx = setupPropose();
  try {
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
    assert.equal(result.ask_user.scope, "propose_open_questions");

    writeFileSync(join(fx.changeRoot, "proposal.md"), [
      "# Proposal",
      "",
      "## 待用户确认",
      "",
      "- [x] DEC-001 是否兼容旧 API？",
    ].join("\n"));

    const afterConfirmed = next(fx.projectRoot, fx.change, fx.changeRoot);
    assert.equal(afterConfirmed.path, "required_job");
    assert.equal(afterConfirmed.required_jobs[0].job_id, job.job_id);
    assert.equal(afterConfirmed.required_jobs[0].role, "critic");
    assert.deepEqual(afterConfirmed.required_jobs[0].packet_argv, [
      "superspec", "jobs", "packet", "--change", fx.change, "--job", job.job_id,
    ]);
  } finally { fx.cleanup(); }
});

test("next 在 explore 有阶段 critic job 时优先于 discovery 校验", () => {
  const fx = setupExplore();
  try {
    const job = appendOpenJob(fx.projectRoot, fx.change, "explore", {
      job_id: "JOB-explore-critic",
      role: "critic",
      created_from_transition: "explore",
    });

    const result = next(fx.projectRoot, fx.change, fx.changeRoot);
    assert.equal(result.path, "required_job");
    assert.equal(result.required_jobs[0].job_id, job.job_id);
  } finally { fx.cleanup(); }
});

test("next 在 explore 不让非阶段 open job 抢占 discovery 校验", () => {
  const fx = setupExplore();
  try {
    appendOpenJob(fx.projectRoot, fx.change, "explore", {
      job_id: "JOB-proposal-critic-too-early",
      role: "critic",
      created_from_transition: "propose-ready",
    });

    const result = next(fx.projectRoot, fx.change, fx.changeRoot);
    assert.equal(result.path, "ask_user");
    assert.equal(result.ask_user.scope, "explore_discovery");
  } finally { fx.cleanup(); }
});

test("next 在 propose 不让非阶段 open job 抢占正常推进", () => {
  const fx = setupPropose();
  try {
    const entered = transitionExplore(fx.projectRoot, fx.change, fx.changeRoot, "normal");
    assert.equal(entered.to_state, "propose");
    appendOpenJob(fx.projectRoot, fx.change, "propose", {
      job_id: "JOB-apply-executor-too-early",
      role: "executor",
      created_from_transition: "apply",
    });

    const result = next(fx.projectRoot, fx.change, fx.changeRoot);
    assert.equal(result.path, "next_command");
    assert.match(result.next_command, /propose-ready/);
  } finally { fx.cleanup(); }
});

test("next 在 propose 不把 tasks 普通 checklist 当成待用户确认", () => {
  const fx = setupPropose();
  try {
    const entered = transitionExplore(fx.projectRoot, fx.change, fx.changeRoot, "normal");
    assert.equal(entered.to_state, "propose");
    writeFileSync(join(fx.changeRoot, "tasks.md"), "# Tasks\n\n- [ ] TASK-001 tdd_required:true\n");

    const result = next(fx.projectRoot, fx.change, fx.changeRoot);
    assert.equal(result.path, "next_command");
    assert.match(result.next_command, /propose-ready/);
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
    assert.equal(packet.packet?.recommended_agent, "critic");
    assert.equal(packet.packet?.required_output_kind, "job_report_json");
    assert.equal(packet.packet?.preferred_input_mode, "stdin");
    assert.equal(packet.packet?.submission_command, `superspec record job-submit --change "${fx.change}" --job "${first.created_jobs[0]}" --report -`);
    assert.deepEqual(packet.packet?.submission_argv, [
      "superspec", "record", "job-submit", "--change", fx.change, "--job", first.created_jobs[0], "--report", "-",
    ]);
    assert.equal(packet.packet?.file_fallback, true);
    assert.deepEqual(packet.packet?.output_contract_fields, ["role", "verdict", "findings", "reviewer"]);

    const reportPath = join(fx.projectRoot, "critic.json");
    writeFileSync(reportPath, reviewerReport("critic"));
    const record = recordJobSubmit(fx.projectRoot, fx.change, fx.changeRoot, first.created_jobs[0], reportPath);
    assert.equal(record.accepted, true);

    const second = transitionExplore(fx.projectRoot, fx.change, fx.changeRoot);
    assert.equal(second.outcome, "advanced");
    assert.equal(second.to_state, "propose");

    snapshot = rebuildSnapshot(fx.projectRoot, fx.change, fx.changeRoot);
    assert.equal(snapshot.state, "propose");
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
  writeFileSync(join(changeRoot, "tasks.md"), "# Tasks\n\n- [ ] TASK-001\n");
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
  writeFileSync(join(changeRoot, "tasks.md"), "# Tasks\n\n- [ ] TASK-001\n");
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
  writeFileSync(join(changeRoot, "tasks.md"), "# Tasks\n\n- [ ] TASK-001\n");
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
  writeFileSync(join(changeRoot, "tasks.md"), "# Tasks\n\n- [ ] TASK-001\n");
  // 只写 bi + tc，故意不写 discovery
  writeFileSync(join(changeRoot, ".superspec", "artifacts", "business-invariants.md"), "# BI\n");
  writeFileSync(join(changeRoot, ".superspec", "artifacts", "test-contract.md"), "# TC\n");
  ensureChangeLayout(projectRoot, change);
  // seed 到 propose
  for (const [t, f, to] of [["init","init","init"],["explore","init","explore"],["propose","explore","propose"]] as const) {
    appendEvent(projectRoot, change, makeEvent(change, "transition_commit", {
      transition: t, from_state: f, to_state: to,
      outcome: "advanced", created_job_ids: [], reason: t,
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

test("propose-ready --risk normal：基础职责全满足 + critic accepted → 推进", () => {
  const projectRoot = mkdtempSync(join(tmpdir(), "superspec-p2c-"));
  const change = "test-change";
  const changeRoot = join(projectRoot, "openspec", "changes", change);
  mkdirSync(join(changeRoot, ".superspec", "artifacts"), { recursive: true });
  writeFileSync(join(changeRoot, "proposal.md"), "# Proposal\n");
  writeFileSync(join(changeRoot, "tasks.md"), "# Tasks\n\n- [ ] TASK-001\n");
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

  try {
    // 1. propose-ready normal → 创建 critic
    const t1 = proposeReady(projectRoot, change, changeRoot, "normal");
    assert.equal(t1.outcome, "job_created");
    const jobId = t1.created_jobs[0];

    // 2. record job-submit → accepted
    const reportPath = join(projectRoot, "report.json");
    writeFileSync(reportPath, reviewerReport("critic"));
    const r1 = recordJobSubmit(projectRoot, change, changeRoot, jobId, reportPath);
    assert.equal(r1.accepted, true);

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
  writeFileSync(join(changeRoot, "tasks.md"), "# Tasks\n\n- [ ] TASK-001\n");
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
  } finally {
    rmSync(projectRoot, { recursive: true, force: true });
  }
});

test("propose-ready strict：同一 gate 下 critic 不能满足 architect 或 test-engineer", () => {
  const fx = setupPropose();
  try {
    transitionExplore(fx.projectRoot, fx.change, fx.changeRoot, "normal");
    writeFileSync(join(fx.changeRoot, "design.md"), "# Design\n");
    writeFileSync(join(fx.changeRoot, ".superspec", "artifacts", "business-invariants.md"), "# BI\n");
    writeFileSync(join(fx.changeRoot, ".superspec", "artifacts", "test-contract.md"), "# TC\n");

    const normal = proposeReady(fx.projectRoot, fx.change, fx.changeRoot, "normal");
    assert.equal(normal.outcome, "job_created");
    const reportPath = join(fx.projectRoot, "critic.json");
    writeFileSync(reportPath, reviewerReport("critic"));
    assert.equal(recordJobSubmit(fx.projectRoot, fx.change, fx.changeRoot, normal.created_jobs[0], reportPath).accepted, true);

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
    transitionExplore(fx.projectRoot, fx.change, fx.changeRoot, "normal");
    writeFileSync(join(fx.changeRoot, "design.md"), "# Design\n");
    writeFileSync(join(fx.changeRoot, ".superspec", "artifacts", "business-invariants.md"), "# BI\n");
    writeFileSync(join(fx.changeRoot, ".superspec", "artifacts", "test-contract.md"), "# TC\n");

    const job = appendOpenJob(fx.projectRoot, fx.change, "propose", {
      job_id: "JOB-legacy-propose-critic",
      role: "critic",
      created_from_transition: "propose-ready",
      boundFiles: ["proposal.md", "tasks.md", "design.md", ".superspec/artifacts/discovery.md", ".superspec/artifacts/business-invariants.md", ".superspec/artifacts/test-contract.md"]
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

test("propose-ready strict：explore 阶段 critic accepted 不能满足 proposal critic", () => {
  const fx = setupPropose();
  try {
    const first = transitionExplore(fx.projectRoot, fx.change, fx.changeRoot, "strict");
    assert.equal(first.outcome, "job_created");
    const reportPath = join(fx.projectRoot, "explore-critic.json");
    writeFileSync(reportPath, reviewerReport("critic"));
    const record = recordJobSubmit(fx.projectRoot, fx.change, fx.changeRoot, first.created_jobs[0], reportPath);
    assert.equal(record.accepted, true);

    const second = transitionExplore(fx.projectRoot, fx.change, fx.changeRoot, "strict");
    assert.equal(second.to_state, "propose");

    writeFileSync(join(fx.changeRoot, "design.md"), "# Design\n");
    writeFileSync(join(fx.changeRoot, ".superspec", "artifacts", "business-invariants.md"), "# BI\n");
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
  writeFileSync(join(changeRoot, "tasks.md"), "# Tasks\n\n- [ ] TASK-001\n");
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
    writeFileSync(join(changeRoot, ".superspec", "artifacts", "business-invariants.md"), "# BI\n");
    writeFileSync(join(changeRoot, ".superspec", "artifacts", "test-contract.md"), "# TC\n");

    // explore→propose
    const exploreResult = transitionExplore(projectRoot, change, changeRoot, "normal");
    assert.equal(exploreResult.to_state, "propose");

    // propose-ready normal → 创建 job
    const t1 = proposeReady(projectRoot, change, changeRoot, "normal");
    assert.equal(t1.outcome, "job_created");

    // record job-submit → accepted
    const jobId = t1.created_jobs[0];
    const reportPath = join(projectRoot, "report.json");
    writeFileSync(reportPath, reviewerReport("critic"));
    recordJobSubmit(projectRoot, change, changeRoot, jobId, reportPath);

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

test("BLOCKER 修复：改 business-invariants.md 后 accepted job 失效", () => {
  const projectRoot = mkdtempSync(join(tmpdir(), "superspec-p2bi-"));
  const change = "test-change";
  const changeRoot = join(projectRoot, "openspec", "changes", change);
  mkdirSync(join(changeRoot, ".superspec", "artifacts"), { recursive: true });
  writeFileSync(join(changeRoot, "proposal.md"), "# Proposal\n");
  writeFileSync(join(changeRoot, "tasks.md"), "# Tasks\n\n- [ ] TASK-001\n");
  writeFileSync(join(changeRoot, "design.md"), "# Design\n");
  writeFileSync(join(changeRoot, ".superspec", "artifacts", "discovery.md"), "# Discovery\n");
  writeFileSync(join(changeRoot, ".superspec", "artifacts", "business-invariants.md"), "# BI\noriginal");
  writeFileSync(join(changeRoot, ".superspec", "artifacts", "test-contract.md"), "# TC\n");
  ensureChangeLayout(projectRoot, change);
  for (const [t, f, to] of [["init","init","init"],["explore","init","explore"],["propose","explore","propose"]] as const) {
    appendEvent(projectRoot, change, makeEvent(change, "transition_commit", {
      transition: t, from_state: f, to_state: to,
      outcome: "advanced", created_job_ids: [], reason: t,
    }, { transitionId: `T-${t}`, idempotencyKey: `${t}-key` }));
  }

  try {
    const t1 = proposeReady(projectRoot, change, changeRoot, "normal");
    const jobId = t1.created_jobs[0];
    const reportPath = join(projectRoot, "report.json");
    writeFileSync(reportPath, reviewerReport("critic"));
    recordJobSubmit(projectRoot, change, changeRoot, jobId, reportPath);

    writeFileSync(join(changeRoot, ".superspec", "artifacts", "business-invariants.md"), "# BI\nchanged");

    const snapshot = rebuildSnapshot(projectRoot, change, changeRoot);
    assert.equal(snapshot.accepted_jobs.length, 0, "bi 变了后 accepted job 应失效");

    const t2 = proposeReady(projectRoot, change, changeRoot, "normal");
    assert.equal(t2.outcome, "job_created");
  } finally {
    rmSync(projectRoot, { recursive: true, force: true });
  }
});

test("CLI status：区分 fresh/historical/stale accepted jobs", () => {
  const projectRoot = mkdtempSync(join(tmpdir(), "superspec-p2status-"));
  const change = "test-change";
  const changeRoot = join(projectRoot, "openspec", "changes", change);
  mkdirSync(join(changeRoot, ".superspec", "artifacts"), { recursive: true });
  writeFileSync(join(changeRoot, "proposal.md"), "# Proposal\noriginal");
  writeFileSync(join(changeRoot, "tasks.md"), "# Tasks\n\n- [ ] TASK-001\n");
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

  try {
    const t1 = proposeReady(projectRoot, change, changeRoot, "normal");
    const reportPath = join(projectRoot, "critic.json");
    writeFileSync(reportPath, reviewerReport("critic"));
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
  writeFileSync(join(fx.changeRoot, ".superspec", "artifacts", "business-invariants.md"), "# BI\n");
  writeFileSync(join(fx.changeRoot, ".superspec", "artifacts", "test-contract.md"), "# TC\n");
  mkdirSync(join(fx.changeRoot, "specs", "auth"), { recursive: true });
  writeFileSync(join(fx.changeRoot, "specs", "auth", "spec.md"), "# Auth Spec\n\n## ADDED Requirements\n");
  return fx;
}

function acceptAllProposeJobs(fx: { projectRoot: string; change: string; changeRoot: string }): void {
  const snapshot = rebuildSnapshot(fx.projectRoot, fx.change, fx.changeRoot);
  for (const job of snapshot.open_jobs) {
    const reportPath = join(fx.projectRoot, `${job.role}.json`);
    writeFileSync(reportPath, reviewerReport(job.role as "critic" | "architect" | "test-engineer"));
    assert.equal(recordJobSubmit(fx.projectRoot, fx.change, fx.changeRoot, job.job_id, reportPath).accepted, true);
  }
}

test("specs 绑定：propose-ready job 的 boundFiles 含 specs/ 目录聚合指纹", () => {
  const fx = setupProposeWithSpecs();
  try {
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
    transitionExplore(fx.projectRoot, fx.change, fx.changeRoot, "normal");
    proposeReady(fx.projectRoot, fx.change, fx.changeRoot, "normal");
    acceptAllProposeJobs(fx);
    assert.equal(rebuildSnapshot(fx.projectRoot, fx.change, fx.changeRoot).accepted_jobs.length, 1);

    writeFileSync(join(fx.changeRoot, "specs", "auth", "spec.md"), "# Auth Spec\n\n## ADDED Requirements\n\n改动\n");
    const snap = rebuildSnapshot(fx.projectRoot, fx.change, fx.changeRoot);
    assert.equal(snap.accepted_jobs.length, 0, "修改 specs 文件应作废已通过的计划审查");
  } finally { fx.cleanup(); }
});

test("specs freshness：审查通过后新增 specs 文件同样作废审查", () => {
  const fx = setupProposeWithSpecs();
  try {
    transitionExplore(fx.projectRoot, fx.change, fx.changeRoot, "normal");
    proposeReady(fx.projectRoot, fx.change, fx.changeRoot, "normal");
    acceptAllProposeJobs(fx);

    mkdirSync(join(fx.changeRoot, "specs", "billing"), { recursive: true });
    writeFileSync(join(fx.changeRoot, "specs", "billing", "spec.md"), "# Billing Spec\n");
    const snap = rebuildSnapshot(fx.projectRoot, fx.change, fx.changeRoot);
    assert.equal(snap.accepted_jobs.length, 0, "新增 specs 文件应作废已通过的计划审查");
  } finally { fx.cleanup(); }
});

test("specs freshness：删除 specs 文件同样作废审查", () => {
  const fx = setupProposeWithSpecs();
  try {
    transitionExplore(fx.projectRoot, fx.change, fx.changeRoot, "normal");
    proposeReady(fx.projectRoot, fx.change, fx.changeRoot, "normal");
    acceptAllProposeJobs(fx);

    rmSync(join(fx.changeRoot, "specs", "auth", "spec.md"));
    const snap = rebuildSnapshot(fx.projectRoot, fx.change, fx.changeRoot);
    assert.equal(snap.accepted_jobs.length, 0, "删除 specs 文件应作废已通过的计划审查");
  } finally { fx.cleanup(); }
});

test("specs freshness：审查时无 specs 目录、通过后新建 specs 同样作废审查", () => {
  const fx = setupPropose();
  try {
    writeFileSync(join(fx.changeRoot, "design.md"), "# Design\n");
    writeFileSync(join(fx.changeRoot, ".superspec", "artifacts", "business-invariants.md"), "# BI\n");
    writeFileSync(join(fx.changeRoot, ".superspec", "artifacts", "test-contract.md"), "# TC\n");
    transitionExplore(fx.projectRoot, fx.change, fx.changeRoot, "normal");
    proposeReady(fx.projectRoot, fx.change, fx.changeRoot, "normal");
    const openSnap = rebuildSnapshot(fx.projectRoot, fx.change, fx.changeRoot);
    assert.ok(openSnap.open_jobs[0].boundFiles.some(f => f.path === "specs/"), "无 specs 目录时也应绑定空指纹");
    acceptAllProposeJobs(fx);

    mkdirSync(join(fx.changeRoot, "specs", "auth"), { recursive: true });
    writeFileSync(join(fx.changeRoot, "specs", "auth", "spec.md"), "# Auth Spec\n");
    const snap = rebuildSnapshot(fx.projectRoot, fx.change, fx.changeRoot);
    assert.equal(snap.accepted_jobs.length, 0, "审查后新建 specs 目录应作废已通过的计划审查");
  } finally { fx.cleanup(); }
});

test("specs freshness：specs 未变化时审查保持 accepted 不误伤", () => {
  const fx = setupProposeWithSpecs();
  try {
    transitionExplore(fx.projectRoot, fx.change, fx.changeRoot, "normal");
    proposeReady(fx.projectRoot, fx.change, fx.changeRoot, "normal");
    acceptAllProposeJobs(fx);

    const snap = rebuildSnapshot(fx.projectRoot, fx.change, fx.changeRoot);
    assert.equal(snap.accepted_jobs.length, 1, "specs 未变化不应误判 stale");
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
