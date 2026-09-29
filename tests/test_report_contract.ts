// SuperSpec：报告契约单源（report_schema / report_skeleton）、骨架填写与 code-reviewer 覆盖判据

import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { ensureChangeLayout, appendEvent, makeEvent, readEvents } from "../src/store.ts";
import { accept, reviewReady, reopen } from "../src/transition.ts";
import { jobsContract, jobsDispatch, jobsList, jobsPacket, recordJobSubmit, recordJobSubmitContent } from "../src/record.ts";
import { next } from "../src/next.ts";
import { workflowRolePrompt } from "../src/install.ts";
import { applyPlanningBaseline } from "../src/phase_plan.ts";
import { COVERAGE_MESSAGES, reportSkeletonForJob } from "../src/report_contract.ts";
import type { Job, JobPacket } from "../src/types.ts";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

function setupChange(): { projectRoot: string; change: string; changeRoot: string; cleanup: () => void } {
  const projectRoot = mkdtempSync(join(tmpdir(), "superspec-report-contract-"));
  const change = "test-change";
  const changeRoot = join(projectRoot, "openspec", "changes", change);
  mkdirSync(join(changeRoot, ".superspec", "artifacts"), { recursive: true });
  mkdirSync(join(changeRoot, "specs", "rest"), { recursive: true });
  mkdirSync(join(projectRoot, "src"), { recursive: true });
  writeFileSync(join(projectRoot, "src", "example.ts"), "export const value = 1;\n");
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

function openCodeReviewer(projectRoot: string, change: string, changeRoot: string): string {
  reviewReady(projectRoot, change, changeRoot);
  const created = reviewReady(projectRoot, change, changeRoot);
  assert.equal(created.outcome, "job_created", created.message ?? "");
  return created.created_jobs[0];
}

function submitReport(
  projectRoot: string,
  change: string,
  changeRoot: string,
  jobId: string,
  report: Record<string, unknown>,
) {
  const reportPath = join(projectRoot, `${jobId}-${Math.random().toString(36).slice(2)}.report.json`);
  writeFileSync(reportPath, JSON.stringify(report));
  return recordJobSubmit(projectRoot, change, changeRoot, jobId, reportPath);
}

function passingReport(packet: JobPacket, jobId: string, unchecked: unknown[], checkedPaths?: string[]): Record<string, unknown> {
  return {
    role: "code-reviewer",
    verdict: "pass",
    evidence_refs: ["test:evidence"],
    reviewer: { kind: "subagent", id: "test-code-reviewer" },
    review_scope: {
      job_id: jobId,
      packet_digest: packet.packet_digest,
      checked_paths: checkedPaths ?? packet.boundFiles.map(file => file.path),
      checked_docs: ["proposal.md", "design.md"],
      unchecked,
    },
    findings: [],
  };
}

test("jobs contract 输出骨架：常量预填、checked_paths 为空、review_scope 字段齐全", () => {
  const fx = setupChange();
  try {
    const jobId = openCodeReviewer(fx.projectRoot, fx.change, fx.changeRoot);
    const contract = jobsContract(fx.projectRoot, fx.change, jobId);
    assert.equal(contract.found, true);
    const skeleton = contract.report_skeleton as Record<string, unknown>;
    const scope = skeleton.review_scope as Record<string, unknown>;
    assert.equal(scope.job_id, jobId);
    assert.equal(scope.packet_digest, jobsPacket(fx.projectRoot, fx.change, jobId).packet?.packet_digest);
    assert.deepEqual(scope.checked_paths, []);
    assert.deepEqual(scope.unchecked, []);
    assert.equal(contract.report_schema?.required_fields.includes("reviewer"), true);
    assert.equal(contract.report_schema?.required_fields.includes("review_scope"), true);
    const scopeFields = Object.keys(contract.report_schema?.fields ?? {}).filter(key => key.startsWith("review_scope."));
    assert.deepEqual(scopeFields.sort(), [
      "review_scope.checked_docs",
      "review_scope.checked_paths",
      "review_scope.job_id",
      "review_scope.packet_digest",
      "review_scope.unchecked",
    ]);
    assert.equal(contract.report_schema?.fields["review_scope.job_id"]?.required, true);
    assert.deepEqual(scope.checked_docs, []);
  } finally { fx.cleanup(); }
});

test("packet 只带 report_skeleton，完整契约由 jobs contract 输出且与骨架同源", () => {
  const fx = setupChange();
  try {
    const jobId = openCodeReviewer(fx.projectRoot, fx.change, fx.changeRoot);
    const packet = jobsPacket(fx.projectRoot, fx.change, jobId).packet as JobPacket;
    assert.ok(packet.report_skeleton);
    assert.equal("report_schema" in packet, false);
    const contract = jobsContract(fx.projectRoot, fx.change, jobId);
    assert.deepEqual(packet.report_skeleton, contract.report_skeleton);
    assert.ok(contract.report_schema);
  } finally { fx.cleanup(); }
});

test("pass 报告允许记录范围外未检查项，不再因此拒收", () => {
  const fx = setupChange();
  try {
    const jobId = openCodeReviewer(fx.projectRoot, fx.change, fx.changeRoot);
    const packet = jobsPacket(fx.projectRoot, fx.change, jobId).packet as JobPacket;
    const result = submitReport(fx.projectRoot, fx.change, fx.changeRoot, jobId, passingReport(packet, jobId, [
      { path: "src/other.ts", reason: "范围外观察：未纳入本轮判定" },
      { path: "unverified", reason: "未执行构建/测试（任务约束为只读核对）" },
    ]));
    assert.equal(result.accepted, true, result.message);
    // 范围外未检查项虽不阻塞 pass，但必须留在决策面（事件流可读）
    const accepted = readEvents(fx.projectRoot, fx.change).findLast(event => event.event_type === "job_accepted");
    assert.deepEqual((accepted?.payload as { out_of_scope_unchecked?: unknown }).out_of_scope_unchecked, [
      { path: "src/other.ts", reason: "范围外观察：未纳入本轮判定" },
      { path: "unverified", reason: "未执行构建/测试（任务约束为只读核对）" },
    ]);
  } finally { fx.cleanup(); }
});

test("已接受报告的结构（review_scope 常量 + 非阻塞 finding）仍可通过", () => {
  const fx = setupChange();
  try {
    const jobId = openCodeReviewer(fx.projectRoot, fx.change, fx.changeRoot);
    const packet = jobsPacket(fx.projectRoot, fx.change, jobId).packet as JobPacket;
    const report = passingReport(packet, jobId, []);
    report.findings = [
      {
        id: "CR-01",
        blocking: false,
        type: "implementation",
        claim_kind: "missing_approved",
        description: "已批准的验证项未落地",
        evidence: "src/example.ts:1",
        impact: "回归覆盖缺口",
        suggested_action: "apply",
        source_refs: ["src/example.ts:1"],
      },
    ];
    const result = submitReport(fx.projectRoot, fx.change, fx.changeRoot, jobId, report);
    assert.equal(result.accepted, true, result.message);
  } finally { fx.cleanup(); }
});

test("pass 报告把绑定文件列为未检查时仍拒收，消息与判定一致", () => {
  const fx = setupChange();
  try {
    const jobId = openCodeReviewer(fx.projectRoot, fx.change, fx.changeRoot);
    const packet = jobsPacket(fx.projectRoot, fx.change, jobId).packet as JobPacket;
    const bound = packet.boundFiles[0].path;
    const result = submitReport(fx.projectRoot, fx.change, fx.changeRoot, jobId, passingReport(
      packet,
      jobId,
      [{ path: bound, reason: "未看" }],
      packet.boundFiles.slice(1).map(file => file.path),
    ));
    assert.equal(result.accepted, false);
    const rejected = readEvents(fx.projectRoot, fx.change).findLast(event => event.event_type === "job_rejected");
    assert.match(String((rejected?.payload as { reason?: string }).reason), new RegExp(COVERAGE_MESSAGES.passWithUncheckedBoundFile));
  } finally { fx.cleanup(); }
});

test("沿用上一轮报告结构（顶层 job_id、unchecked 字符串、缺 checked_docs）仍被拒收", () => {
  const fx = setupChange();
  try {
    const jobId = openCodeReviewer(fx.projectRoot, fx.change, fx.changeRoot);
    const packet = jobsPacket(fx.projectRoot, fx.change, jobId).packet as JobPacket;
    const result = submitReport(fx.projectRoot, fx.change, fx.changeRoot, jobId, {
      role: "code-reviewer",
      verdict: "pass",
      evidence_refs: ["test:evidence"],
      job_id: jobId,
      packet_digest: packet.packet_digest,
      findings: [],
      reviewer: { kind: "subagent", id: "test-code-reviewer" },
      review_scope: {
        checked_paths: packet.boundFiles.map(file => file.path),
        unchecked: ["未执行构建/测试"],
      },
    });
    assert.equal(result.accepted, false);
    const rejected = readEvents(fx.projectRoot, fx.change).findLast(event => event.event_type === "job_rejected");
    const reason = String((rejected?.payload as { reason?: string }).reason);
    assert.match(reason, /job_id/);
    assert.match(reason, /checked_docs/);
    assert.match(reason, /未检查项/);
  } finally { fx.cleanup(); }
});

test("reopen --to apply 作废未提交的审查工作项", () => {
  const fx = setupChange();
  try {
    const jobId = openCodeReviewer(fx.projectRoot, fx.change, fx.changeRoot);
    writeFileSync(join(fx.changeRoot, "tasks.md"), [
      "# Tasks", "",
      "- [x] TASK-001 Done",
      "  执行依据:",
      "  - 测试: TEST-001",
      "  - 设计: design.md#设计目标",
      "  - 来源: proposal.md#What Changes",
      "  - 验收: 已完成",
      "  - 边界: 不改无关代码",
      "",
      "- [ ] TASK-002 Pending",
      "  执行依据:",
      "  - 测试: TEST-001",
      "  - 设计: design.md#设计目标",
      "  - 来源: proposal.md#What Changes",
      "  - 验收: 待完成",
      "  - 边界: 不改无关代码",
      "",
    ].join("\n"));
    const reopened = reopen(fx.projectRoot, fx.change, fx.changeRoot, "apply", "口径收窄重新实现");
    assert.equal(reopened.outcome, "advanced", reopened.message ?? "");
    const invalidated = readEvents(fx.projectRoot, fx.change)
      .findLast(event => event.event_type === "job_invalidated" && (event.payload as { job_id?: string }).job_id === jobId);
    assert.ok(invalidated, "未提交的审查工作项应被 job_invalidated 关闭");
    assert.equal(jobsList(fx.projectRoot, fx.change).open.some(job => job.job_id === jobId), false);
  } finally { fx.cleanup(); }
});

test("verifier 骨架按既有协议预填绑定文件，且不带 reviewer 字段", () => {
  const job: Job = {
    job_id: "JOB-verifier-test-1",
    role: "verifier",
    state: "requested",
    boundFiles: [
      { path: "src/a.ts", sha: "sha256:a" },
      { path: "src/b.ts", sha: "sha256:b" },
    ],
    packet_digest: "sha256:packet",
    created_from_transition: "review-ready",
    created_at: new Date().toISOString(),
  };
  const skeleton = reportSkeletonForJob(job) as Record<string, unknown>;
  assert.deepEqual((skeleton.review_scope as { checked_paths: string[] }).checked_paths, ["src/a.ts", "src/b.ts"]);
  assert.equal("reviewer" in skeleton, false);
});

test("fail 报告：完整 blocking 问题按 review_failed 处理，范围外 unchecked 不改变结论", () => {
  const fx = setupChange();
  try {
    const jobId = openCodeReviewer(fx.projectRoot, fx.change, fx.changeRoot);
    const packet = jobsPacket(fx.projectRoot, fx.change, jobId).packet as JobPacket;
    const report = passingReport(packet, jobId, [{ path: "docs/notes.md", reason: "范围外文档，未纳入判断" }]);
    report.verdict = "fail";
    report.findings = [
      {
        id: "CR-01",
        blocking: true,
        type: "implementation",
        claim_kind: "missing_approved",
        approved_refs: ["TEST-001"],
        description: "已批准行为未实现",
        evidence: "src/example.ts:1",
        impact: "验收不成立",
        suggested_action: "apply",
        source_refs: ["src/example.ts:1"],
      },
    ];
    const result = submitReport(fx.projectRoot, fx.change, fx.changeRoot, jobId, report);
    assert.equal(result.accepted, false);
    const rejected = readEvents(fx.projectRoot, fx.change).findLast(event => event.event_type === "job_rejected");
    const payload = rejected?.payload as { reason?: string; result_kind?: string };
    assert.equal(payload.result_kind, "review_failed");
    assert.match(String(payload.reason), /需要处理的阻塞问题/);
  } finally { fx.cleanup(); }
});

test("fail 报告：blocking 问题缺 claim_kind 时退回同一工作项修正重交", () => {
  const fx = setupChange();
  try {
    const jobId = openCodeReviewer(fx.projectRoot, fx.change, fx.changeRoot);
    const packet = jobsPacket(fx.projectRoot, fx.change, jobId).packet as JobPacket;
    const report = passingReport(packet, jobId, []);
    report.verdict = "fail";
    report.findings = [
      {
        id: "CR-02",
        blocking: true,
        type: "implementation",
        description: "缺 claim_kind",
        evidence: "src/example.ts:1",
        impact: "无法归因",
        suggested_action: "apply",
        source_refs: ["src/example.ts:1"],
      },
    ];
    const result = recordJobSubmitContent(fx.projectRoot, fx.change, fx.changeRoot, jobId, JSON.stringify(report));
    assert.equal(result.accepted, false);
    assert.equal(result.result_kind, "retryable");
    assert.match(result.message, /claim_kind/);
    assert.equal(readEvents(fx.projectRoot, fx.change).some(event => event.event_type === "job_rejected"), false);
  } finally { fx.cleanup(); }
});

test("CLI：jobs contract 输出契约/骨架，缺 --job 与非存在工作项的退出码", () => {
  const fx = setupChange();
  try {
    const jobId = openCodeReviewer(fx.projectRoot, fx.change, fx.changeRoot);
    const cliPath = fileURLToPath(new URL("../src/cli.ts", import.meta.url));
    const skeleton = spawnSync(process.execPath, [
      cliPath, "jobs", "contract", "--change", fx.change, "--job", jobId, "--skeleton",
    ], { cwd: fx.projectRoot, encoding: "utf8" });
    assert.equal(skeleton.status, 0, skeleton.stderr || skeleton.stdout);
    const parsed = JSON.parse(skeleton.stdout) as { review_scope: { job_id: string; checked_paths: string[] } };
    assert.equal(parsed.review_scope.job_id, jobId);
    assert.deepEqual(parsed.review_scope.checked_paths, []);

    const missingJob = spawnSync(process.execPath, [
      cliPath, "jobs", "contract", "--change", fx.change,
    ], { cwd: fx.projectRoot, encoding: "utf8" });
    assert.equal(missingJob.status, 1);

    const unknownJob = spawnSync(process.execPath, [
      cliPath, "jobs", "contract", "--change", fx.change, "--job", "JOB-missing-1",
    ], { cwd: fx.projectRoot, encoding: "utf8" });
    assert.equal(unknownJob.status, 1);
  } finally { fx.cleanup(); }
});

test("pass 的范围外未检查项经 code_review_gate 透出到最终验证 packet", () => {
  const fx = setupChange();
  try {
    const jobId = openCodeReviewer(fx.projectRoot, fx.change, fx.changeRoot);
    const packet = jobsPacket(fx.projectRoot, fx.change, jobId).packet as JobPacket;
    const accepted = submitReport(fx.projectRoot, fx.change, fx.changeRoot, jobId, passingReport(packet, jobId, [
      { path: "docs/notes.md", reason: "范围外文档，未纳入判断" },
    ]));
    assert.equal(accepted.accepted, true, accepted.message);

    // apply_done → review 的门禁事实应带上置信边界
    const advanced = reviewReady(fx.projectRoot, fx.change, fx.changeRoot);
    assert.equal(advanced.outcome, "advanced", advanced.message ?? "");
    const verifier = reviewReady(fx.projectRoot, fx.change, fx.changeRoot);
    assert.equal(verifier.outcome, "job_created", verifier.message ?? "");
    const verifierId = verifier.created_jobs[0];
    const verifierPacket = jobsPacket(fx.projectRoot, fx.change, verifierId).packet as JobPacket;
    assert.deepEqual(verifierPacket.code_review_gate?.out_of_scope_unchecked, [
      { path: "docs/notes.md", reason: "范围外文档，未纳入判断" },
    ]);
  } finally { fx.cleanup(); }
});

test("CLI：经管道读取超过 64KB 的输出保持完整", () => {
  const fx = setupChange();
  try {
    const jobs: Job[] = Array.from({ length: 300 }, (_, index) => ({
      job_id: `JOB-bulk-${index}`,
      role: "critic",
      state: "requested",
      boundFiles: Array.from({ length: 3 }, (_, file) => ({
        path: `src/modules/very/long/package/path/for/bulk/output/${index}/generated-file-${file}-${"x".repeat(40)}.ts`,
        sha: `sha256:${"0".repeat(64)}`,
      })),
      packet_digest: `sha256:bulk-${index}`,
      created_from_transition: "propose-ready",
      created_at: new Date().toISOString(),
    }));
    appendEvent(fx.projectRoot, fx.change, makeEvent(fx.change, "transition_commit", {
      transition: "propose-ready", from_state: "apply", to_state: "apply",
      outcome: "job_created", created_job_ids: jobs.map(job => job.job_id), new_jobs: jobs, reason: "bulk jobs",
    }, { transitionId: "T-bulk", idempotencyKey: "bulk-key" }));

    const expected = `${JSON.stringify(jobsList(fx.projectRoot, fx.change), null, 2)}\n`;
    assert.ok(Buffer.byteLength(expected) > 65536, "夹具输出需要超过 64KB 才能覆盖管道截断");

    const cliPath = fileURLToPath(new URL("../src/cli.ts", import.meta.url));
    const run = spawnSync(process.execPath, [cliPath, "jobs", "list", "--change", fx.change], {
      cwd: fx.projectRoot,
      encoding: "utf8",
      maxBuffer: 16 * 1024 * 1024,
    });
    assert.equal(run.status, 0, run.stderr);
    assert.equal(Buffer.byteLength(run.stdout), Buffer.byteLength(expected));
    const parsed = JSON.parse(run.stdout) as { open: Job[] };
    assert.equal(parsed.open.length, jobs.length);
  } finally { fx.cleanup(); }
});

test("jobs dispatch：派发说明由引擎生成，带角色 prompt 与取 packet 的命令，next 给出 dispatch_argv", () => {
  const fx = setupChange();
  try {
    const jobId = openCodeReviewer(fx.projectRoot, fx.change, fx.changeRoot);
    const dispatch = jobsDispatch(fx.projectRoot, fx.change, jobId);
    assert.equal(dispatch.found, true);
    const text = dispatch.text ?? "";
    assert.ok(text.includes(jobId));
    assert.ok(text.includes(`superspec jobs packet --change "${fx.change}" --job "${jobId}"`));
    assert.ok(text.includes(workflowRolePrompt("code-reviewer")));

    const nextResult = next(fx.projectRoot, fx.change, fx.changeRoot);
    assert.equal(nextResult.path, "required_job");
    assert.deepEqual(nextResult.required_jobs[0].dispatch_argv, [
      "superspec", "jobs", "dispatch", "--change", fx.change, "--job", jobId,
    ]);

    const cliPath = fileURLToPath(new URL("../src/cli.ts", import.meta.url));
    const run = spawnSync(process.execPath, [cliPath, "jobs", "dispatch", "--change", fx.change, "--job", jobId], {
      cwd: fx.projectRoot,
      encoding: "utf8",
    });
    assert.equal(run.status, 0, run.stderr);
    assert.equal(run.stdout, `${text}\n`);

    const unknown = spawnSync(process.execPath, [cliPath, "jobs", "dispatch", "--change", fx.change, "--job", "JOB-missing-1"], {
      cwd: fx.projectRoot,
      encoding: "utf8",
    });
    assert.equal(unknown.status, 1);
    assert.equal(jobsDispatch(fx.projectRoot, fx.change, "JOB-missing-1").found, false);
  } finally { fx.cleanup(); }
});

test("报告骨架不预填结论：verdict 留空，未填写时退回同一工作项重交", () => {
  const fx = setupChange();
  try {
    const jobId = openCodeReviewer(fx.projectRoot, fx.change, fx.changeRoot);
    const contract = jobsContract(fx.projectRoot, fx.change, jobId);
    assert.equal((contract.report_skeleton as { verdict?: unknown }).verdict, null);
    const packet = jobsPacket(fx.projectRoot, fx.change, jobId).packet as JobPacket;
    const unfilled = { ...passingReport(packet, jobId, []), verdict: null };
    const result = recordJobSubmitContent(fx.projectRoot, fx.change, fx.changeRoot, jobId, JSON.stringify(unfilled));
    assert.equal(result.result_kind, "retryable");
    assert.match(result.message, /verdict/);
    const filled = recordJobSubmitContent(fx.projectRoot, fx.change, fx.changeRoot, jobId, JSON.stringify(passingReport(packet, jobId, [])));
    assert.equal(filled.accepted, true, filled.message);
  } finally { fx.cleanup(); }
});

function acceptThroughVerifier(fx: { projectRoot: string; change: string; changeRoot: string }): void {
  const jobId = openCodeReviewer(fx.projectRoot, fx.change, fx.changeRoot);
  const packet = jobsPacket(fx.projectRoot, fx.change, jobId).packet as JobPacket;
  const reviewed = recordJobSubmitContent(fx.projectRoot, fx.change, fx.changeRoot, jobId, JSON.stringify(passingReport(packet, jobId, [])));
  assert.equal(reviewed.accepted, true, reviewed.message);
  assert.equal(reviewReady(fx.projectRoot, fx.change, fx.changeRoot).outcome, "advanced");
  const verifier = reviewReady(fx.projectRoot, fx.change, fx.changeRoot);
  assert.equal(verifier.outcome, "job_created", verifier.message ?? "");
  const verifierId = verifier.created_jobs[0];
  const skeleton = jobsPacket(fx.projectRoot, fx.change, verifierId).packet?.report_skeleton as { review_scope?: unknown };
  const verified = recordJobSubmitContent(fx.projectRoot, fx.change, fx.changeRoot, verifierId, JSON.stringify({
    role: "verifier",
    verdict: "pass",
    evidence_refs: ["test:evidence"],
    findings: [],
    review_scope: skeleton.review_scope,
  }));
  assert.equal(verified.accepted, true, verified.message);
  assert.equal(accept(fx.projectRoot, fx.change, fx.changeRoot).to_state, "accepted");
}

test("accepted 后本 change 已审查的代码变化：done 给出自测修复出口，未变化时不输出", () => {
  const fx = setupChange();
  try {
    acceptThroughVerifier(fx);
    const clean = next(fx.projectRoot, fx.change, fx.changeRoot);
    assert.equal(clean.path, "done");
    assert.equal("post_accept_code_changes" in clean, false);

    writeFileSync(join(fx.projectRoot, "src", "example.ts"), "export const value = 2;\n");
    const drifted = next(fx.projectRoot, fx.change, fx.changeRoot);
    assert.equal(drifted.path, "done");
    assert.deepEqual(drifted.post_accept_code_changes?.paths, ["src/example.ts"]);
    assert.ok(drifted.post_accept_code_changes?.self_test_fix_argv_template.includes("--self-test-fix"));
  } finally { fx.cleanup(); }
});

test("自测修复被计划冻结挡下时，指出变化的材料与两条出路", () => {
  const fx = setupChange();
  try {
    acceptThroughVerifier(fx);
    writeFileSync(join(fx.changeRoot, "design.md"), "# 设计\n\n## 设计目标\ncollection\n\n## 非目标\n- 不加锁\n\n实现期修正记录\n");
    const blocked = reopen(fx.projectRoot, fx.change, fx.changeRoot, "apply", "恢复已批准的判定落点", {
      selfTestFix: "TASK-001",
    });
    assert.equal(blocked.events_written, 0);
    assert.match(blocked.message ?? "", /design\.md/);
    assert.match(blocked.message ?? "", /reopen --to propose/);
  } finally { fx.cleanup(); }
});

test("非阻塞 finding 只有编号时退回重交，写清 description 后正常登记", () => {
  const fx = setupChange();
  try {
    const jobId = openCodeReviewer(fx.projectRoot, fx.change, fx.changeRoot);
    const packet = jobsPacket(fx.projectRoot, fx.change, jobId).packet as JobPacket;
    const bare = { ...passingReport(packet, jobId, []), findings: [{ id: "F1" }] };
    const rejected = recordJobSubmitContent(fx.projectRoot, fx.change, fx.changeRoot, jobId, JSON.stringify(bare));
    assert.equal(rejected.result_kind, "retryable");
    assert.match(rejected.message, /F1/);
    assert.equal(readEvents(fx.projectRoot, fx.change).some(event => event.event_type === "job_rejected"), false);

    const described = {
      ...passingReport(packet, jobId, []),
      findings: [{ id: "F1", description: "HR 清除卡点时不触发当日重算" }],
    };
    const accepted = recordJobSubmitContent(fx.projectRoot, fx.change, fx.changeRoot, jobId, JSON.stringify(described));
    assert.equal(accepted.accepted, true, accepted.message);
  } finally { fx.cleanup(); }
});
