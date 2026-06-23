// SuperSpec 流程引擎 — Phase 2 测试：explore + propose + 基础职责

import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { ensureChangeLayout, readEvents, appendEvent, makeEvent, rawFile, sha256Text } from "../src/store.ts";
import { rebuildSnapshot } from "../src/sync.ts";
import { next } from "../src/next.ts";
import { proposeReady, transitionExplore } from "../src/transition.ts";
import { recordUserDecision, recordJobSubmit, jobsPacket } from "../src/record.ts";
import { countDiscoveryOpenQuestions, countProposeOpenQuestionsInContent } from "../src/format.ts";

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

test("next 在 propose 有待用户确认问题时返回 ask_user 且优先于审查 job", () => {
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
    assert.match(result.ask_user.question, /proposal\.md/);
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

    let snapshot = rebuildSnapshot(fx.projectRoot, fx.change, fx.changeRoot);
    assert.equal(snapshot.state, "explore");
    assert.equal(snapshot.open_jobs[0].role, "critic");

    const packet = jobsPacket(fx.projectRoot, fx.change, first.created_jobs[0]);
    assert.equal(packet.found, true);
    assert.equal(packet.packet?.role, "critic");
    assert.equal(packet.packet?.recommended_agent, "critic");
    assert.equal(packet.packet?.required_output_kind, "job_report_json");
    assert.equal(packet.packet?.preferred_input_mode, "stdin");
    assert.equal(packet.packet?.submission_command, `superspec record job-submit --change "${fx.change}" --job "${first.created_jobs[0]}" --report -`);
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
  } finally {
    rmSync(projectRoot, { recursive: true, force: true });
  }
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
