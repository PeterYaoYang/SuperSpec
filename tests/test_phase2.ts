// SuperSpec 流程引擎 — Phase 2 测试：explore + propose + 基础职责

import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { ensureChangeLayout, readEvents, appendEvent, makeEvent } from "../src/store.ts";
import { rebuildSnapshot } from "../src/sync.ts";
import { next } from "../src/next.ts";
import { proposeReady, transitionExplore } from "../src/transition.ts";
import { recordUserDecision, recordJobSubmit, jobsPacket } from "../src/record.ts";

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

// ===== 测试 =====

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

test("explore→propose：discovery.md 无未确认问题时推进", () => {
  const fx = setupPropose();
  try {
    const result = transitionExplore(fx.projectRoot, fx.change, fx.changeRoot);
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
  } finally { fx.cleanup(); }
});

test("next 在 explore strict 风险时返回带 risk 的 transition 命令", () => {
  const fx = setupPropose();
  try {
    const result = next(fx.projectRoot, fx.change, fx.changeRoot, "strict");
    assert.equal(result.path, "next_command");
    assert.ok(result.next_command.includes('transition explore --change "test-change" --risk strict'));
  } finally { fx.cleanup(); }
});

test("explore→propose strict：创建 critic，接受 JSON 报告后推进", () => {
  const fx = setupPropose();
  try {
    const first = transitionExplore(fx.projectRoot, fx.change, fx.changeRoot, "strict");
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
    assert.deepEqual(packet.packet?.output_contract_fields, ["role", "verdict", "findings"]);

    const reportPath = join(fx.projectRoot, "critic.json");
    writeFileSync(reportPath, JSON.stringify({
      role: "critic",
      verdict: "pass",
      findings: [],
      summary: "discovery 可进入 propose",
    }));
    const record = recordJobSubmit(fx.projectRoot, fx.change, fx.changeRoot, first.created_jobs[0], reportPath);
    assert.equal(record.accepted, true);

    const second = transitionExplore(fx.projectRoot, fx.change, fx.changeRoot, "strict");
    assert.equal(second.outcome, "advanced");
    assert.equal(second.to_state, "propose");

    snapshot = rebuildSnapshot(fx.projectRoot, fx.change, fx.changeRoot);
    assert.equal(snapshot.state, "propose");
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
  } finally { fx.cleanup(); }
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

test("propose-ready --risk normal：基础职责全满足 + proposal-auditor accepted → 推进", () => {
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
    // 1. propose-ready normal → 创建 proposal-auditor
    const t1 = proposeReady(projectRoot, change, changeRoot, "normal");
    assert.equal(t1.outcome, "job_created");
    const jobId = t1.created_jobs[0];

    // 2. record job-submit → accepted
    const reportPath = join(projectRoot, "report.json");
    writeFileSync(reportPath, JSON.stringify({ role: "proposal-auditor", findings: [], verdict: "pass" }));
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

test("propose-ready --risk strict：创建 proposal-auditor + critic + architect + test 审核工作项", () => {
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
    const result = proposeReady(projectRoot, change, changeRoot, "strict");
    assert.equal(result.outcome, "job_created");
    assert.equal(result.created_jobs.length, 4);

    const snapshot = rebuildSnapshot(projectRoot, change, changeRoot);
    assert.deepEqual(snapshot.open_jobs.map(j => j.role).sort(), [
      "architect",
      "critic",
      "proposal-auditor",
      "test-engineer",
    ]);
  } finally {
    rmSync(projectRoot, { recursive: true, force: true });
  }
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
    const exploreResult = transitionExplore(projectRoot, change, changeRoot);
    assert.equal(exploreResult.to_state, "propose");

    // propose-ready normal → 创建 job
    const t1 = proposeReady(projectRoot, change, changeRoot, "normal");
    assert.equal(t1.outcome, "job_created");

    // record job-submit → accepted
    const jobId = t1.created_jobs[0];
    const reportPath = join(projectRoot, "report.json");
    writeFileSync(reportPath, JSON.stringify({ role: "proposal-auditor", findings: [], verdict: "pass" }));
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
    writeFileSync(reportPath, JSON.stringify({ role: "proposal-auditor", findings: [], verdict: "pass" }));
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
