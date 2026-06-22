// SuperSpec 流程引擎 — Phase 1 测试

import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { ensureChangeLayout, readEvents, appendEvent, makeEvent, writeSnapshot, readSnapshot, acquireLock, releaseLock, rawFile, sha256Text } from "../src/store.ts";
import { rebuildSnapshot } from "../src/sync.ts";
import { next } from "../src/next.ts";
import { proposeReady, commitTransition } from "../src/transition.ts";
import { recordJobSubmit, jobsList, jobsPacket } from "../src/record.ts";

// ===== 测试夹具 =====

interface Fixture {
  projectRoot: string;
  change: string;
  changeRoot: string;
  cleanup: () => void;
}

function setupFixture(state: "init" | "explore" | "propose" = "propose"): Fixture {
  const projectRoot = mkdtempSync(join(tmpdir(), "superspec-test-"));
  const change = "test-change";
  const changeRoot = join(projectRoot, "openspec", "changes", change);

  // 创建 OpenSpec 变更目录 + 文档
  mkdirSync(join(changeRoot, ".superspec", "artifacts"), { recursive: true });
  writeFileSync(join(changeRoot, "proposal.md"), "# Proposal\n\nTest change.\n");
  writeFileSync(join(changeRoot, "tasks.md"), "# Tasks\n\n- [ ] TASK-001 Do something\n");
  writeFileSync(join(changeRoot, "design.md"), "# Design\n\nDesign doc.\n");
  writeFileSync(join(changeRoot, ".superspec", "artifacts", "discovery.md"), "# Discovery\n\nFound stuff.\n");
  writeFileSync(join(changeRoot, ".superspec", "artifacts", "business-invariants.md"), "# Invariants\n\nINV-001.\n");
  writeFileSync(join(changeRoot, ".superspec", "artifacts", "test-contract.md"), "# Test Contract\n\nTC-001.\n");

  // 初始化引擎运行时
  ensureChangeLayout(projectRoot, change);

  // seed events 到指定状态
  if (state === "init") {
    const initEv = makeEvent(change, "transition_commit", {
      transition: "init", from_state: "init", to_state: "init",
      outcome: "advanced", created_job_ids: [], reason: "init",
    }, { transitionId: "T-init", idempotencyKey: `init-${change}` });
    appendEvent(projectRoot, change, initEv);
  } else if (state === "explore") {
    const initEv = makeEvent(change, "transition_commit", {
      transition: "init", from_state: "init", to_state: "init",
      outcome: "advanced", created_job_ids: [], reason: "init",
    }, { transitionId: "T-init", idempotencyKey: `init-${change}` });
    const exploreEv = makeEvent(change, "transition_commit", {
      transition: "explore", from_state: "init", to_state: "explore",
      outcome: "advanced", created_job_ids: [], reason: "enter explore",
    }, { transitionId: "T-explore", idempotencyKey: `explore-${change}` });
    appendEvent(projectRoot, change, initEv);
    appendEvent(projectRoot, change, exploreEv);
  } else {
    // propose
    const initEv = makeEvent(change, "transition_commit", {
      transition: "init", from_state: "init", to_state: "init",
      outcome: "advanced", created_job_ids: [], reason: "init",
    }, { transitionId: "T-init", idempotencyKey: `init-${change}` });
    const exploreEv = makeEvent(change, "transition_commit", {
      transition: "explore", from_state: "init", to_state: "explore",
      outcome: "advanced", created_job_ids: [], reason: "enter explore",
    }, { transitionId: "T-explore", idempotencyKey: `explore-${change}` });
    const proposeEv = makeEvent(change, "transition_commit", {
      transition: "explore", from_state: "explore", to_state: "propose",
      outcome: "advanced", created_job_ids: [], reason: "enter propose",
    }, { transitionId: "T-propose", idempotencyKey: `propose-${change}` });
    appendEvent(projectRoot, change, initEv);
    appendEvent(projectRoot, change, exploreEv);
    appendEvent(projectRoot, change, proposeEv);
  }

  return {
    projectRoot,
    change,
    changeRoot,
    cleanup: () => rmSync(projectRoot, { recursive: true, force: true }),
  };
}

function reviewerReport(role: "critic" | "architect" | "test-engineer" = "critic"): string {
  return JSON.stringify({
    role,
    findings: [],
    verdict: "pass",
    reviewer: { kind: "codex-subagent", id: "test-reviewer" },
  });
}

function rawDirFiles(projectRoot: string, change: string): string[] {
  return readdirSync(join(projectRoot, ".superspec", "changes", change, "raw")).sort();
}

// ===== 测试 =====

test("snapshot 可从 events + 文档重建", () => {
  const fx = setupFixture("propose");
  try {
    const snapshot = rebuildSnapshot(fx.projectRoot, fx.change, fx.changeRoot);
    assert.equal(snapshot.state, "propose");
    assert.ok(snapshot.document_digests["tasks.md"]);
    assert.ok(snapshot.document_digests["proposal.md"]);
    assert.equal(snapshot.open_jobs.length, 0);
    assert.equal(snapshot.accepted_jobs.length, 0);
  } finally { fx.cleanup(); }
});

test("删除 snapshot 后 sync 重建一致", () => {
  const fx = setupFixture("propose");
  try {
    // 先建一次 snapshot
    const s1 = rebuildSnapshot(fx.projectRoot, fx.change, fx.changeRoot);
    writeSnapshot(fx.projectRoot, fx.change, s1);

    // 删除
    rmSync(join(fx.projectRoot, ".superspec", "changes", fx.change, "snapshot.json"));

    // 重建
    const s2 = rebuildSnapshot(fx.projectRoot, fx.change, fx.changeRoot);
    assert.equal(s2.state, s1.state);
    assert.deepEqual(s2.document_digests, s1.document_digests);
    assert.equal(s2.open_jobs.length, s1.open_jobs.length);
  } finally { fx.cleanup(); }
});

test("init → explore → propose 状态流转", () => {
  const fx = setupFixture("init");
  try {
    let snapshot = rebuildSnapshot(fx.projectRoot, fx.change, fx.changeRoot);
    assert.equal(snapshot.state, "init");

    const exploreResult = commitTransition(fx.projectRoot, fx.change, fx.changeRoot, {
      name: "explore",
      decide: () => ({ fromState: "init" as const, toState: "explore" as const, outcome: "advanced" as const, reason: "test" }),
    });
    assert.equal(exploreResult.outcome, "advanced");
    assert.equal(exploreResult.to_state, "explore");

    snapshot = rebuildSnapshot(fx.projectRoot, fx.change, fx.changeRoot);
    assert.equal(snapshot.state, "explore");

    const proposeResult = commitTransition(fx.projectRoot, fx.change, fx.changeRoot, {
      name: "explore",
      decide: () => ({ fromState: "explore" as const, toState: "propose" as const, outcome: "advanced" as const, reason: "test" }),
    });
    assert.equal(proposeResult.to_state, "propose");

    snapshot = rebuildSnapshot(fx.projectRoot, fx.change, fx.changeRoot);
    assert.equal(snapshot.state, "propose");
  } finally { fx.cleanup(); }
});

test("propose-ready --risk minimal：无 job 需求，直接推进", () => {
  const fx = setupFixture("propose");
  try {
    const result = proposeReady(fx.projectRoot, fx.change, fx.changeRoot, "minimal");
    assert.equal(result.outcome, "advanced");
    assert.equal(result.to_state, "propose_ready");
    assert.equal(result.created_jobs.length, 0);

    const snapshot = rebuildSnapshot(fx.projectRoot, fx.change, fx.changeRoot);
    assert.equal(snapshot.state, "propose_ready");
  } finally { fx.cleanup(); }
});

test("propose-ready --risk normal：创建 critic job，状态不变", () => {
  const fx = setupFixture("propose");
  try {
    const result = proposeReady(fx.projectRoot, fx.change, fx.changeRoot, "normal");
    assert.equal(result.outcome, "job_created");
    assert.equal(result.to_state, "propose"); // 状态不变
    assert.equal(result.created_jobs.length, 1);

    const snapshot = rebuildSnapshot(fx.projectRoot, fx.change, fx.changeRoot);
    assert.equal(snapshot.state, "propose"); // 仍 propose
    assert.equal(snapshot.open_jobs.length, 1);
    assert.equal(snapshot.open_jobs[0].role, "critic");
  } finally { fx.cleanup(); }
});

test("next 返回 required_job 当有 open job", () => {
  const fx = setupFixture("propose");
  try {
    // 先创建 job
    proposeReady(fx.projectRoot, fx.change, fx.changeRoot, "normal");

    const result = next(fx.projectRoot, fx.change, fx.changeRoot, "normal");
    assert.equal(result.path, "required_job");
    assert.ok(result.required_jobs.length > 0);
    assert.equal(result.required_jobs[0].role, "critic");
    assert.ok(result.required_jobs[0].packet_command.includes("jobs packet"));
  } finally { fx.cleanup(); }
});

test("record job-submit：接受合格报告", () => {
  const fx = setupFixture("propose");
  try {
    // 创建 job
    const tResult = proposeReady(fx.projectRoot, fx.change, fx.changeRoot, "normal");
    const jobId = tResult.created_jobs[0];

    // 写报告
    const reportPath = join(fx.projectRoot, "report.json");
    writeFileSync(reportPath, reviewerReport("critic"));

    // 提交
    const rResult = recordJobSubmit(fx.projectRoot, fx.change, fx.changeRoot, jobId, reportPath);
    assert.equal(rResult.accepted, true);
    assert.equal(rResult.job_state, "accepted");

    const rawPath = rawFile(fx.projectRoot, fx.change, "review-reports");
    const rawLines = readFileSync(rawPath, "utf8").trim().split("\n");
    assert.equal(rawLines.length, 1);
    assert.equal(JSON.parse(rawLines[0]).role, "critic");
    assert.deepEqual(rawDirFiles(fx.projectRoot, fx.change), ["review-reports.jsonl"]);

    const accepted = readEvents(fx.projectRoot, fx.change).findLast(e => e.event_type === "job_accepted");
    assert.ok(accepted);
    assert.equal(accepted.payload.raw_kind, "review-reports");
    assert.equal(accepted.payload.raw_index, 0);
    assert.equal(accepted.payload.raw_digest, sha256Text(rawLines[0]));
  } finally { fx.cleanup(); }
});

test("record job-submit：critic 缺 reviewer 会拒绝", () => {
  const fx = setupFixture("propose");
  try {
    const tResult = proposeReady(fx.projectRoot, fx.change, fx.changeRoot, "normal");
    const jobId = tResult.created_jobs[0];
    const reportPath = join(fx.projectRoot, "report.json");
    writeFileSync(reportPath, JSON.stringify({ role: "critic", findings: [], verdict: "pass" }));

    const rResult = recordJobSubmit(fx.projectRoot, fx.change, fx.changeRoot, jobId, reportPath);
    assert.equal(rResult.accepted, false);
    assert.ok(rResult.message.includes("reviewer"));
    assert.deepEqual(rawDirFiles(fx.projectRoot, fx.change), []);
  } finally { fx.cleanup(); }
});

test("record job-submit：critic reviewer kind/id 非法会拒绝", () => {
  const fx = setupFixture("propose");
  try {
    const tResult = proposeReady(fx.projectRoot, fx.change, fx.changeRoot, "normal");
    const jobId = tResult.created_jobs[0];
    const reportPath = join(fx.projectRoot, "report.json");
    writeFileSync(reportPath, JSON.stringify({
      role: "critic",
      findings: [],
      verdict: "pass",
      reviewer: { kind: "self", id: "" },
    }));

    const rResult = recordJobSubmit(fx.projectRoot, fx.change, fx.changeRoot, jobId, reportPath);
    assert.equal(rResult.accepted, false);
    assert.ok(rResult.message.includes("reviewer.kind"));
    assert.ok(rResult.message.includes("reviewer.id"));
    assert.deepEqual(rawDirFiles(fx.projectRoot, fx.change), []);
  } finally { fx.cleanup(); }
});

test("record job-submit：raw append 失败时不写 accepted event", () => {
  const fx = setupFixture("propose");
  try {
    const tResult = proposeReady(fx.projectRoot, fx.change, fx.changeRoot, "normal");
    const jobId = tResult.created_jobs[0];
    const reportPath = join(fx.projectRoot, "report.json");
    writeFileSync(reportPath, reviewerReport("critic"));
    mkdirSync(rawFile(fx.projectRoot, fx.change, "review-reports"));

    assert.throws(() => recordJobSubmit(fx.projectRoot, fx.change, fx.changeRoot, jobId, reportPath));
    assert.equal(readEvents(fx.projectRoot, fx.change).some(e => e.event_type === "job_accepted"), false);
  } finally { fx.cleanup(); }
});

test("完整 e2e：propose → job → accept → propose_ready", () => {
  const fx = setupFixture("propose");
  try {
    // 1. propose-ready normal → 创建 job
    const step1 = proposeReady(fx.projectRoot, fx.change, fx.changeRoot, "normal");
    assert.equal(step1.outcome, "job_created");
    const jobId = step1.created_jobs[0];

    // 2. next → required_job
    const step2 = next(fx.projectRoot, fx.change, fx.changeRoot, "normal");
    assert.equal(step2.path, "required_job");

    // 3. jobs packet → 拿到执行说明
    const step3 = jobsPacket(fx.projectRoot, fx.change, jobId);
    assert.equal(step3.found, true);

    // 4. record job-submit → accepted
    const reportPath = join(fx.projectRoot, "report.json");
    writeFileSync(reportPath, reviewerReport("critic"));
    const step4 = recordJobSubmit(fx.projectRoot, fx.change, fx.changeRoot, jobId, reportPath);
    assert.equal(step4.accepted, true);

    // 5. propose-ready normal → 推进到 propose_ready
    const step5 = proposeReady(fx.projectRoot, fx.change, fx.changeRoot, "normal");
    assert.equal(step5.outcome, "advanced");
    assert.equal(step5.to_state, "propose_ready");

    // 6. next → next_command（propose_ready 不再是终态，指向 start-apply）
    const step6 = next(fx.projectRoot, fx.change, fx.changeRoot, "normal");
    assert.equal(step6.path, "next_command");
    assert.ok(step6.next_command.includes("start-apply"));
  } finally { fx.cleanup(); }
});

test("文档变化后 accepted job 失效 → transition 创建新 job", () => {
  const fx = setupFixture("propose");
  try {
    // 1. 创建 + 接受 job
    const t1 = proposeReady(fx.projectRoot, fx.change, fx.changeRoot, "normal");
    const jobId1 = t1.created_jobs[0];
    const reportPath = join(fx.projectRoot, "report.json");
    writeFileSync(reportPath, reviewerReport("critic"));
    recordJobSubmit(fx.projectRoot, fx.change, fx.changeRoot, jobId1, reportPath);

    // 2. 修改 proposal.md（绑定文件变了）
    writeFileSync(join(fx.changeRoot, "proposal.md"), "# Proposal\n\nCHANGED CONTENT.\n");

    // 3. sync 检测到 stale → accepted_jobs 中该 job 被移除
    const snapshot = rebuildSnapshot(fx.projectRoot, fx.change, fx.changeRoot);
    assert.equal(snapshot.accepted_jobs.length, 0, "stale job 应被 sync 从 accepted 移除");

    // 4. propose-ready → 发现缺 fresh job → 创建新的
    const t2 = proposeReady(fx.projectRoot, fx.change, fx.changeRoot, "normal");
    assert.equal(t2.outcome, "job_created");
    assert.equal(t2.created_jobs.length, 1);
    assert.notEqual(t2.created_jobs[0], jobId1, "新 job id 应不同于旧 job");
  } finally { fx.cleanup(); }
});

test("幂等：同 idempotency_key 的 transition 返回旧结果", () => {
  const fx = setupFixture("propose");
  try {
    // 第一次 propose-ready minimal → 推进
    const r1 = proposeReady(fx.projectRoot, fx.change, fx.changeRoot, "minimal");
    assert.equal(r1.outcome, "advanced");

    // 手动再跑同 idempotency（重建 snapshot 会发现状态已不在 propose）
    const snapshot = rebuildSnapshot(fx.projectRoot, fx.change, fx.changeRoot);
    assert.equal(snapshot.state, "propose_ready");

    // 再跑 propose-ready → 状态不对，不会推进
    const r2 = proposeReady(fx.projectRoot, fx.change, fx.changeRoot, "minimal");
    assert.equal(r2.events_written, 0, "不应再写事件");
  } finally { fx.cleanup(); }
});

test("record job-submit 幂等：同 report 返回旧结果", () => {
  const fx = setupFixture("propose");
  try {
    const t = proposeReady(fx.projectRoot, fx.change, fx.changeRoot, "normal");
    const jobId = t.created_jobs[0];
    const reportPath = join(fx.projectRoot, "report.json");
    writeFileSync(reportPath, reviewerReport("critic"));

    const r1 = recordJobSubmit(fx.projectRoot, fx.change, fx.changeRoot, jobId, reportPath);
    assert.equal(r1.accepted, true);
    const rawPath = rawFile(fx.projectRoot, fx.change, "review-reports");
    assert.equal(readFileSync(rawPath, "utf8").trim().split("\n").length, 1);

    // 重复提交同报告 → 幂等返回
    const r2 = recordJobSubmit(fx.projectRoot, fx.change, fx.changeRoot, jobId, reportPath);
    assert.equal(r2.accepted, true);
    assert.ok(r2.message.includes("幂等"));
    assert.equal(readFileSync(rawPath, "utf8").trim().split("\n").length, 1);
  } finally { fx.cleanup(); }
});

test("锁竞争保护", () => {
  const fx = setupFixture("propose");
  try {
    acquireLock(fx.projectRoot, fx.change);

    assert.throws(() => {
      acquireLock(fx.projectRoot, fx.change);
    }, /Lock contention/);

    releaseLock(fx.projectRoot, fx.change);
    acquireLock(fx.projectRoot, fx.change); // 不抛
    releaseLock(fx.projectRoot, fx.change);
  } finally { fx.cleanup(); }
});
