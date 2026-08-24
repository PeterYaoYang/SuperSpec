// SuperSpec：代码审查锚点契约、REVIEW-FIX 任务行与 added_code_paths

import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { ensureChangeLayout, appendEvent, makeEvent, readEvents } from "../src/store.ts";
import { next } from "../src/next.ts";
import { reviewReady, reopen } from "../src/transition.ts";
import { jobsPacket, recordJobSubmit } from "../src/record.ts";
import { applyPlanningBaseline } from "../src/phase_plan.ts";
import { addedCodePathsForScope, codeReviewPacketContext } from "../src/code_review.ts";
import { resolveApprovedRef, reviewFixReason } from "../src/approved_ref.ts";
import type { CodeReviewScope, NextOutput } from "../src/types.ts";

function nextCommand(output: NextOutput): string {
  return "next_command" in output ? output.next_command : "";
}

function payloadResultKind(payload: unknown): unknown {
  if (payload && typeof payload === "object" && "result_kind" in payload) {
    return payload.result_kind;
  }
  return undefined;
}

function setupChange(): { projectRoot: string; change: string; changeRoot: string; cleanup: () => void } {
  const projectRoot = mkdtempSync(join(tmpdir(), "superspec-overscope-"));
  const change = "test-change";
  const changeRoot = join(projectRoot, "openspec", "changes", change);
  mkdirSync(join(changeRoot, ".superspec", "artifacts"), { recursive: true });
  mkdirSync(join(changeRoot, "specs", "rest"), { recursive: true });
  writeFileSync(join(changeRoot, "tasks.md"), [
    "# Tasks", "",
    "- [x] TASK-001 Done",
    "  执行依据:",
    "  - 测试: TEST-001",
    "  - 设计: design.md#设计目标",
    "  - 来源: proposal.md#What Changes",
    "  - 验收: 已完成",
    "  - 边界: 不改无关代码",
    "",
  ].join("\n"));
  writeFileSync(join(changeRoot, "proposal.md"), [
    "# Proposal", "",
    "## Why", "need", "",
    "## What Changes", "rest collection", "",
    "## Impact", "",
    "| Area | Reason |",
    "|---|---|",
    "| api | rest |",
    "",
  ].join("\n"));
  writeFileSync(join(changeRoot, "design.md"), [
    "# 设计", "",
    "## 设计目标", "collection", "",
    "## 非目标", "- 不加锁", "",
  ].join("\n"));
  writeFileSync(join(changeRoot, ".superspec", "artifacts", "discovery.md"), "# Discovery\n");
  writeFileSync(join(changeRoot, ".superspec", "artifacts", "test-contract.md"), [
    "# Test Contract", "",
    "| test_id | scenario |",
    "|---|---|",
    "| TEST-001 | 完整休息集合被扣除 |",
    "",
  ].join("\n"));
  writeFileSync(join(changeRoot, "specs", "rest", "spec.md"), [
    "## ADDED Requirements", "",
    "### Requirement: 按完整集合扣休息",
    "调用方看到完整集合被扣除。",
    "",
  ].join("\n"));
  ensureChangeLayout(projectRoot, change);
  for (const [t, f, to] of [
    ["init", "init", "init"],
    ["explore", "init", "explore"],
    ["propose", "explore", "propose"],
    ["propose-ready", "propose", "propose_ready"],
    ["start-apply", "propose_ready", "apply"],
  ] as const) {
    appendEvent(projectRoot, change, makeEvent(change, "transition_commit", {
      transition: t, from_state: f, to_state: to,
      outcome: "advanced", created_job_ids: [], reason: t,
      ...(t === "start-apply" ? { apply_planning_baseline: applyPlanningBaseline(changeRoot) } : {}),
    }, { transitionId: `T-${t}`, idempotencyKey: `${t}-key` }));
  }
  return {
    projectRoot, change, changeRoot,
    cleanup: () => rmSync(projectRoot, { recursive: true, force: true }),
  };
}

function submitFinding(
  projectRoot: string,
  change: string,
  changeRoot: string,
  jobId: string,
  finding: Record<string, unknown>,
) {
  const packet = jobsPacket(projectRoot, change, jobId);
  const reportPath = join(projectRoot, `${jobId}.report`);
  writeFileSync(reportPath, JSON.stringify({
    role: "code-reviewer",
    verdict: "fail",
    review_scope: {
      job_id: jobId,
      packet_digest: packet.packet?.packet_digest,
      checked_paths: (packet.packet?.boundFiles ?? []).map(file => file.path),
      checked_docs: ["proposal.md", "design.md", "tasks.md", ".superspec/artifacts/test-contract.md"],
      unchecked: [],
    },
    findings: [finding],
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

const baseFinding = {
  id: "CR-001",
  type: "implementation" as const,
  blocking: true,
  description: "应加谱系锁保证并发",
  evidence: "src/example.ts:1",
  source_refs: ["src/example.ts:1"],
  impact: "并发窗口",
  suggested_action: "apply" as const,
};

test("approved_refs：TEST、Requirement、task、design 标题可解析，非法形式拒绝", () => {
  const fx = setupChange();
  try {
    assert.equal(resolveApprovedRef(fx.changeRoot, "TEST-001").ok, true);
    assert.equal(resolveApprovedRef(fx.changeRoot, "specs/rest/spec.md#Requirement: 按完整集合扣休息").ok, true);
    assert.equal(resolveApprovedRef(fx.changeRoot, "tasks.md#TASK-001").ok, true);
    assert.equal(resolveApprovedRef(fx.changeRoot, "design.md#非目标").ok, true);
    assert.equal(resolveApprovedRef(fx.changeRoot, "TEST-999").ok, false);
    assert.equal(reviewFixReason("missing_approved", ["TEST-001"]), "兑现 TEST-001（missing_approved）");
  } finally { fx.cleanup(); }
});

test("code-reviewer：缺 claim_kind 或 approved_refs 的 fail 是 non_actionable，next 不 review-fix", () => {
  const fx = setupChange();
  try {
    const jobId = openCodeReviewer(fx.projectRoot, fx.change, fx.changeRoot);
    const rejected = submitFinding(fx.projectRoot, fx.change, fx.changeRoot, jobId, baseFinding);
    assert.equal(rejected.accepted, false);
    const event = readEvents(fx.projectRoot, fx.change).findLast(item => item.event_type === "job_rejected");
    assert.equal(payloadResultKind(event?.payload), "non_actionable_report");
    const nextResult = next(fx.projectRoot, fx.change, fx.changeRoot);
    assert.equal(nextResult.path, "next_command");
    assert.match(nextCommand(nextResult), /review-ready/);
    assert.doesNotMatch(nextCommand(nextResult), /review-fix/);
  } finally { fx.cleanup(); }
});

test("code-reviewer：missing_approved 只引用 design 或 tasks 不可执行", () => {
  const fx = setupChange();
  try {
    const jobId = openCodeReviewer(fx.projectRoot, fx.change, fx.changeRoot);
    const rejected = submitFinding(fx.projectRoot, fx.change, fx.changeRoot, jobId, {
      ...baseFinding,
      claim_kind: "missing_approved",
      approved_refs: ["design.md#设计目标", "tasks.md#TASK-001"],
    });
    assert.equal(rejected.accepted, false);
    const event = readEvents(fx.projectRoot, fx.change).findLast(item => item.event_type === "job_rejected");
    assert.equal(payloadResultKind(event?.payload), "non_actionable_report");
  } finally { fx.cleanup(); }
});

test("code-reviewer：missing_approved 引用 TEST 后可 REVIEW-FIX，任务行不复制架构建议", () => {
  const fx = setupChange();
  try {
    const jobId = openCodeReviewer(fx.projectRoot, fx.change, fx.changeRoot);
    const rejected = submitFinding(fx.projectRoot, fx.change, fx.changeRoot, jobId, {
      ...baseFinding,
      id: "CR-MISS-001",
      claim_kind: "missing_approved",
      approved_refs: ["TEST-001"],
    });
    assert.equal(rejected.accepted, false);
    const event = readEvents(fx.projectRoot, fx.change).findLast(item => item.event_type === "job_rejected");
    assert.equal(payloadResultKind(event?.payload), "review_failed");
    const reopened = reopen(fx.projectRoot, fx.change, fx.changeRoot, "apply", "fix missing rest", {
      reviewFix: `${jobId}#CR-MISS-001`,
    });
    assert.equal(reopened.to_state, "apply");
    const tasks = readFileSync(join(fx.changeRoot, "tasks.md"), "utf8");
    assert.match(tasks, /兑现 TEST-001（missing_approved）/);
    assert.doesNotMatch(tasks, /应加谱系锁/);
  } finally { fx.cleanup(); }
});

test("code-reviewer：mixed 且锚点合法仍走用户裁决，不自动 apply", () => {
  const fx = setupChange();
  try {
    const jobId = openCodeReviewer(fx.projectRoot, fx.change, fx.changeRoot);
    const rejected = submitFinding(fx.projectRoot, fx.change, fx.changeRoot, jobId, {
      ...baseFinding,
      id: "CR-MIX-LOCK",
      type: "mixed",
      claim_kind: "missing_approved",
      approved_refs: ["TEST-001"],
      suggested_action: "propose",
    });
    assert.equal(rejected.accepted, false);
    const nextResult = next(fx.projectRoot, fx.change, fx.changeRoot);
    assert.equal(nextResult.path, "ask_user");
  } finally { fx.cleanup(); }
});

test("code-reviewer：unjustified_addition 合法锚点可 REVIEW-FIX，任务行不含架构建议", () => {
  const fx = setupChange();
  try {
    const jobId = openCodeReviewer(fx.projectRoot, fx.change, fx.changeRoot);
    const rejected = submitFinding(fx.projectRoot, fx.change, fx.changeRoot, jobId, {
      ...baseFinding,
      id: "CR-ADD-LOCK",
      claim_kind: "unjustified_addition",
      approved_refs: ["design.md#非目标"],
      description: "应加谱系锁保证并发",
    });
    assert.equal(rejected.accepted, false);
    const event = readEvents(fx.projectRoot, fx.change).findLast(item => item.event_type === "job_rejected");
    assert.equal(payloadResultKind(event?.payload), "review_failed");
    const reopened = reopen(fx.projectRoot, fx.change, fx.changeRoot, "apply", "contract extra lock", {
      reviewFix: `${jobId}#CR-ADD-LOCK`,
    });
    assert.equal(reopened.to_state, "apply");
    const tasks = readFileSync(join(fx.changeRoot, "tasks.md"), "utf8");
    assert.match(tasks, /兑现 非目标（unjustified_addition）/);
    assert.doesNotMatch(tasks, /应加谱系锁/);
  } finally { fx.cleanup(); }
});


test("packet：基点可用时 added_code_paths 含新建代码文件", () => {
  const fx = setupChange();
  try {
    execFileSync("git", ["init"], { cwd: fx.projectRoot, stdio: "ignore" });
    execFileSync("git", ["config", "user.email", "test@example.com"], { cwd: fx.projectRoot, stdio: "ignore" });
    execFileSync("git", ["config", "user.name", "Test User"], { cwd: fx.projectRoot, stdio: "ignore" });
    mkdirSync(join(fx.projectRoot, "src"), { recursive: true });
    writeFileSync(join(fx.projectRoot, "src", "keep.ts"), "export const keep = 1;\n");
    execFileSync("git", ["add", "."], { cwd: fx.projectRoot, stdio: "ignore" });
    execFileSync("git", ["commit", "-m", "base"], { cwd: fx.projectRoot, stdio: "ignore" });
    const base = execFileSync("git", ["rev-parse", "HEAD"], { cwd: fx.projectRoot, encoding: "utf8" }).trim();
    writeFileSync(join(fx.projectRoot, "src", "LineageLock.ts"), "export class LineageLock {}\n");
    execFileSync("git", ["add", "."], { cwd: fx.projectRoot, stdio: "ignore" });
    execFileSync("git", ["commit", "-m", "add lock"], { cwd: fx.projectRoot, stdio: "ignore" });
    const head = execFileSync("git", ["rev-parse", "HEAD"], { cwd: fx.projectRoot, encoding: "utf8" }).trim();
    const scope: CodeReviewScope = {
      base_head: base,
      current_head: head,
      scope_reliable: true,
      scope_reason: "ok",
      committed_paths: ["src/LineageLock.ts"],
      worktree_paths: [],
      untracked_paths: [],
      review_paths: ["src/LineageLock.ts"],
    };
    assert.deepEqual(addedCodePathsForScope(fx.projectRoot, scope), ["src/LineageLock.ts"]);
    const context = codeReviewPacketContext(fx.changeRoot, fx.projectRoot, scope, []);
    assert.deepEqual(context.added_code_paths, ["src/LineageLock.ts"]);

    writeFileSync(join(fx.projectRoot, "src", "example.ts"), "export const value = 1;\n");
    const jobId = openCodeReviewer(fx.projectRoot, fx.change, fx.changeRoot);
    const packet = jobsPacket(fx.projectRoot, fx.change, jobId);
    const added = packet.packet?.added_code_paths;
    assert.ok(Array.isArray(added), "jobsPacket 顶层必须带 added_code_paths");
    assert.ok(added.includes("src/example.ts"));
  } finally { fx.cleanup(); }
});

test("next：review-fix 计划附带原问题上下文，其余计划不携带", () => {
  const fx = setupChange();
  try {
    const before = next(fx.projectRoot, fx.change, fx.changeRoot);
    assert.equal(before.path, "next_command");
    assert.ok(!("finding_context" in before));

    const jobId = openCodeReviewer(fx.projectRoot, fx.change, fx.changeRoot);
    submitFinding(fx.projectRoot, fx.change, fx.changeRoot, jobId, {
      ...baseFinding,
      id: "CR-CTX-001",
      claim_kind: "unjustified_addition",
      approved_refs: ["design.md#非目标"],
      evidence: "src/LineageLock.ts:1",
    });
    const nextResult = next(fx.projectRoot, fx.change, fx.changeRoot);
    assert.equal(nextResult.path, "next_command");
    assert.match(nextCommand(nextResult), /--review-fix/);
    const context = "finding_context" in nextResult ? nextResult.finding_context : undefined;
    assert.ok(context);
    assert.ok(!("description" in context));
    assert.equal(context?.evidence, "src/LineageLock.ts:1");
    assert.match(context?.note ?? "", /非授权上下文/);
  } finally { fx.cleanup(); }
});

test("approved_refs 加固：控制字符锚点拒绝，目录路径不崩溃", () => {
  const fx = setupChange();
  try {
    const multiline = resolveApprovedRef(fx.changeRoot, "design.md#非目标\n- [ ] 伪造任务");
    assert.equal(multiline.ok, false);
    if (!multiline.ok) assert.match(multiline.reason, /控制字符/);
    const dirRef = resolveApprovedRef(fx.changeRoot, ".#x");
    assert.equal(dirRef.ok, false);
    if (!dirRef.ok) assert.match(dirRef.reason, /在当前 change 中不存在/);
  } finally { fx.cleanup(); }
});
