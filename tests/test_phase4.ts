// SuperSpec 流程引擎 — Phase 4 测试：review + archive

import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { ensureChangeLayout, appendEvent, makeEvent, readEvents } from "../src/store.ts";
import { rebuildSnapshot } from "../src/sync.ts";
import { reviewReady, accept, archive } from "../src/transition.ts";
import { recordJobSubmit } from "../src/record.ts";
import { tasksStructureDigestOf } from "../src/task.ts";

function setupApplyWithDoneTask(): { projectRoot: string; change: string; changeRoot: string; cleanup: () => void } {
  const projectRoot = mkdtempSync(join(tmpdir(), "superspec-p4-"));
  const change = "test-change";
  const changeRoot = join(projectRoot, "openspec", "changes", change);
  mkdirSync(join(changeRoot, ".superspec", "artifacts"), { recursive: true });
  // 任务已勾选
  writeFileSync(join(changeRoot, "tasks.md"), "# Tasks\n\n- [x] TASK-001 Done\n");
  writeFileSync(join(changeRoot, "proposal.md"), "# P\n");
  writeFileSync(join(changeRoot, "design.md"), "# D\n");
  writeFileSync(join(changeRoot, ".superspec", "artifacts", "discovery.md"), "# D\n");
  writeFileSync(join(changeRoot, ".superspec", "artifacts", "business-invariants.md"), "# BI\n");
  writeFileSync(join(changeRoot, ".superspec", "artifacts", "test-contract.md"), "# TC\n");
  ensureChangeLayout(projectRoot, change);
  // seed 到 apply
  for (const [t, f, to] of [
    ["init","init","init"],["explore","init","explore"],["propose","explore","propose"],
    ["propose-ready","propose","propose_ready"],["start-apply","propose_ready","apply"],
  ] as const) {
    appendEvent(projectRoot, change, makeEvent(change, "transition_commit", {
      transition: t, from_state: f, to_state: to,
      outcome: "advanced", created_job_ids: [], reason: t,
    }, { transitionId: `T-${t}`, idempotencyKey: `${t}-key` }));
  }
  return {
    projectRoot, change, changeRoot,
    cleanup: () => rmSync(projectRoot, { recursive: true, force: true }),
  };
}

test("review-ready：apply → apply_done（所有任务完成）", () => {
  const fx = setupApplyWithDoneTask();
  try {
    const result = reviewReady(fx.projectRoot, fx.change, fx.changeRoot);
    assert.equal(result.outcome, "advanced");
    assert.equal(result.to_state, "apply_done");
  } finally { fx.cleanup(); }
});

test("review-ready：有未完成任务拒绝", () => {
  const fx = setupApplyWithDoneTask();
  try {
    writeFileSync(join(fx.changeRoot, "tasks.md"), "# Tasks\n\n- [ ] TASK-001 Todo\n");
    const result = reviewReady(fx.projectRoot, fx.change, fx.changeRoot);
    assert.ok(result.message.includes("未完成"));
    assert.equal(result.events_written, 0);
  } finally { fx.cleanup(); }
});

test("review-ready：apply_done → 创建 final-audit job", () => {
  const projectRoot = mkdtempSync(join(tmpdir(), "superspec-p4fa-"));
  const change = "test-change";
  const changeRoot = join(projectRoot, "openspec", "changes", change);
  mkdirSync(join(changeRoot, ".superspec", "artifacts"), { recursive: true });
  writeFileSync(join(changeRoot, "tasks.md"), "# Tasks\n\n- [x] TASK-001 Done\n");
  writeFileSync(join(changeRoot, "proposal.md"), "# P\n");
  writeFileSync(join(changeRoot, "design.md"), "# D\n");
  writeFileSync(join(changeRoot, ".superspec", "artifacts", "discovery.md"), "# D\n");
  writeFileSync(join(changeRoot, ".superspec", "artifacts", "business-invariants.md"), "# BI\n");
  writeFileSync(join(changeRoot, ".superspec", "artifacts", "test-contract.md"), "# TC\n");
  ensureChangeLayout(projectRoot, change);
  for (const [t, f, to] of [
    ["init","init","init"],["explore","init","explore"],["propose","explore","propose"],
    ["propose-ready","propose","propose_ready"],["start-apply","propose_ready","apply"],
    ["review-ready","apply","apply_done"],
  ] as const) {
    appendEvent(projectRoot, change, makeEvent(change, "transition_commit", {
      transition: t, from_state: f, to_state: to,
      outcome: "advanced", created_job_ids: [], reason: t,
    }, { transitionId: `T-${t}`, idempotencyKey: `${t}-key` }));
  }
  try {
    const result = reviewReady(projectRoot, change, changeRoot);
    assert.equal(result.outcome, "job_created");
    assert.equal(result.created_jobs.length, 1);
    const snap = rebuildSnapshot(projectRoot, change, changeRoot);
    assert.equal(snap.open_jobs[0].role, "final-audit");
  } finally { rmSync(projectRoot, { recursive: true, force: true }); }
});

test("accept：review → accepted", () => {
  const projectRoot = mkdtempSync(join(tmpdir(), "superspec-p4ac-"));
  const change = "test-change";
  const changeRoot = join(projectRoot, "openspec", "changes", change);
  mkdirSync(join(changeRoot, ".superspec", "artifacts"), { recursive: true });
  writeFileSync(join(changeRoot, "tasks.md"), "# Tasks\n");
  ensureChangeLayout(projectRoot, change);
  for (const [t, f, to] of [
    ["init","init","init"],["explore","init","explore"],["propose","explore","propose"],
    ["propose-ready","propose","propose_ready"],["start-apply","propose_ready","apply"],
    ["review-ready","apply","apply_done"],["review-ready2","apply_done","review"],
  ] as const) {
    appendEvent(projectRoot, change, makeEvent(change, "transition_commit", {
      transition: t, from_state: f, to_state: to,
      outcome: "advanced", created_job_ids: [], reason: t,
    }, { transitionId: `T-${t}`, idempotencyKey: `${t}-key` }));
  }
  try {
    const result = accept(projectRoot, change, changeRoot);
    assert.equal(result.to_state, "accepted");
  } finally { rmSync(projectRoot, { recursive: true, force: true }); }
});

test("archive：accepted → archive + 保全清单", () => {
  const projectRoot = mkdtempSync(join(tmpdir(), "superspec-p4ar-"));
  const change = "test-change";
  const changeRoot = join(projectRoot, "openspec", "changes", change);
  mkdirSync(join(changeRoot, ".superspec", "artifacts"), { recursive: true });
  writeFileSync(join(changeRoot, "tasks.md"), "# Tasks\n");
  writeFileSync(join(changeRoot, "proposal.md"), "# P\n");
  ensureChangeLayout(projectRoot, change);
  for (const [t, f, to] of [
    ["init","init","init"],["explore","init","explore"],["propose","explore","propose"],
    ["propose-ready","propose","propose_ready"],["start-apply","propose_ready","apply"],
    ["review-ready","apply","apply_done"],["review-ready2","apply_done","review"],
    ["accept","review","accepted"],
  ] as const) {
    appendEvent(projectRoot, change, makeEvent(change, "transition_commit", {
      transition: t, from_state: f, to_state: to,
      outcome: "advanced", created_job_ids: [], reason: t,
    }, { transitionId: `T-${t}`, idempotencyKey: `${t}-key` }));
  }
  try {
    const result = archive(projectRoot, change, changeRoot);
    assert.equal(result.to_state, "archive");
    assert.ok(result.events_written >= 1);

    // 验证 events 含保全清单
    const events = readEvents(projectRoot, change);
    const hasManifest = events.some(e => e.event_type === "artifact_recorded");
    assert.ok(hasManifest, "应有保全清单事件");

    // H3 修复：验证 manifest 内容（文档键 + 指纹正确）
    const manifestEv = events.find(e => e.event_type === "artifact_recorded");
    const manifest = manifestEv?.payload as { manifest?: Record<string,string> };
    assert.ok(manifest?.manifest?.["proposal.md"], "manifest 应含 proposal.md");
    assert.ok(manifest?.manifest?.["tasks.md"], "manifest 应含 tasks.md");
    assert.ok(manifest?.manifest?.["proposal.md"]?.startsWith("sha256:"), "指纹应以 sha256: 开头");
  } finally { rmSync(projectRoot, { recursive: true, force: true }); }
});

test("H3：final-audit accepted 后改文档 → stale → review-ready 创建新 job", () => {
  const projectRoot = mkdtempSync(join(tmpdir(), "superspec-p4stale-"));
  const change = "test-change";
  const changeRoot = join(projectRoot, "openspec", "changes", change);
  mkdirSync(join(changeRoot, ".superspec", "artifacts"), { recursive: true });
  writeFileSync(join(changeRoot, "tasks.md"), "# Tasks\n\n- [x] TASK-001 Done\n");
  writeFileSync(join(changeRoot, "proposal.md"), "# P\noriginal");
  writeFileSync(join(changeRoot, "design.md"), "# D\n");
  writeFileSync(join(changeRoot, ".superspec", "artifacts", "discovery.md"), "# D\n");
  writeFileSync(join(changeRoot, ".superspec", "artifacts", "business-invariants.md"), "# BI\n");
  writeFileSync(join(changeRoot, ".superspec", "artifacts", "test-contract.md"), "# TC\n");
  ensureChangeLayout(projectRoot, change);
  for (const [t, f, to] of [
    ["init","init","init"],["explore","init","explore"],["propose","explore","propose"],
    ["propose-ready","propose","propose_ready"],["start-apply","propose_ready","apply"],
    ["review-ready","apply","apply_done"],
  ] as const) {
    appendEvent(projectRoot, change, makeEvent(change, "transition_commit", {
      transition: t, from_state: f, to_state: to,
      outcome: "advanced", created_job_ids: [], reason: t,
    }, { transitionId: `T-${t}`, idempotencyKey: `${t}-key` }));
  }

  try {
    // 1. review-ready → 创建 final-audit
    const t1 = reviewReady(projectRoot, change, changeRoot);
    assert.equal(t1.outcome, "job_created");
    const jobId = t1.created_jobs[0];

    // 2. record job-submit → accepted
    const reportPath = join(projectRoot, "report.json");
    writeFileSync(reportPath, JSON.stringify({ role: "final-audit", findings: [], verdict: "pass" }));
    recordJobSubmit(projectRoot, change, changeRoot, jobId, reportPath);

    // 3. 改 proposal.md（绑定文件变了）
    writeFileSync(join(changeRoot, "proposal.md"), "# P\nchanged");

    // 4. sync 应移除 stale accepted job
    const snap = rebuildSnapshot(projectRoot, change, changeRoot);
    assert.equal(snap.accepted_jobs.length, 0, "final-audit 应因绑定文件变化而 stale");

    // 5. review-ready 应创建新 final-audit
    const t2 = reviewReady(projectRoot, change, changeRoot);
    assert.equal(t2.outcome, "job_created");
    assert.notEqual(t2.created_jobs[0], jobId, "应创建新 job（ID 不同）");
  } finally { rmSync(projectRoot, { recursive: true, force: true }); }
});
