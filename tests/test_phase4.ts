// SuperSpec 流程引擎 — Phase 4 测试：review + archive

import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { ensureChangeLayout, appendEvent, makeEvent, readEvents } from "../src/store.ts";
import { rebuildSnapshot } from "../src/sync.ts";
import { next } from "../src/next.ts";
import { reviewReady, taskStart, taskComplete, reopen, accept, archive } from "../src/transition.ts";
import { jobsPacket, recordJobSubmit } from "../src/record.ts";

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

test("apply_done 后补任务：reopen 复开执行并创建 fresh verifier", () => {
  const fx = setupApplyWithDoneTask();
  try {
    const toApplyDone = reviewReady(fx.projectRoot, fx.change, fx.changeRoot);
    assert.equal(toApplyDone.to_state, "apply_done");

    const verifierGate = reviewReady(fx.projectRoot, fx.change, fx.changeRoot);
    assert.equal(verifierGate.outcome, "job_created");
    const staleVerifierJobId = verifierGate.created_jobs[0];

    writeFileSync(join(fx.changeRoot, "tasks.md"), "# Tasks\n\n- [x] TASK-001 Done\n- [ ] TASK-025 Fix review issue tdd_required:false no_tdd_reason:review-followup\n");

    const blocked = reviewReady(fx.projectRoot, fx.change, fx.changeRoot);
    assert.equal(blocked.events_written, 0);
    assert.match(blocked.message, /TASK-025/);

    const reopenNext = next(fx.projectRoot, fx.change, fx.changeRoot);
    assert.equal(reopenNext.path, "next_command");
    assert.equal(reopenNext.next_command, 'superspec transition reopen --change "test-change" --to apply --reason "pending tasks: TASK-025"');

    const reopened = reopen(fx.projectRoot, fx.change, fx.changeRoot, "apply", "pending tasks: TASK-025");
    assert.equal(reopened.from_state, "apply_done");
    assert.equal(reopened.to_state, "apply");

    const reopenedSnap = rebuildSnapshot(fx.projectRoot, fx.change, fx.changeRoot);
    assert.equal(reopenedSnap.state, "apply");
    assert.equal(reopenedSnap.open_jobs.some(job => job.job_id === staleVerifierJobId), false);

    const startNext = next(fx.projectRoot, fx.change, fx.changeRoot);
    assert.equal(startNext.path, "next_command");
    assert.equal(startNext.next_command, 'superspec transition task-start --change "test-change" --task TASK-025');

    const started = taskStart(fx.projectRoot, fx.change, fx.changeRoot, "TASK-025");
    assert.equal(started.to_state, "apply");

    const activeNext = next(fx.projectRoot, fx.change, fx.changeRoot);
    assert.equal(activeNext.path, "next_command");
    assert.equal(activeNext.next_command, 'superspec transition task-complete --change "test-change" --task TASK-025');

    const completed = taskComplete(fx.projectRoot, fx.change, fx.changeRoot, "TASK-025");
    assert.equal(completed.events_written, 2);

    const afterCompleteNext = next(fx.projectRoot, fx.change, fx.changeRoot);
    assert.equal(afterCompleteNext.path, "next_command");
    assert.match(afterCompleteNext.next_command, /review-ready/);

    const backToApplyDone = reviewReady(fx.projectRoot, fx.change, fx.changeRoot);
    assert.equal(backToApplyDone.to_state, "apply_done");

    const freshVerifier = reviewReady(fx.projectRoot, fx.change, fx.changeRoot);
    assert.equal(freshVerifier.outcome, "job_created");
    assert.notEqual(freshVerifier.created_jobs[0], staleVerifierJobId);

    const oldReportPath = join(fx.projectRoot, "old-verifier.json");
    writeFileSync(oldReportPath, JSON.stringify({ role: "verifier", findings: [], verdict: "pass" }));
    const oldSubmit = recordJobSubmit(fx.projectRoot, fx.change, fx.changeRoot, staleVerifierJobId, oldReportPath);
    assert.equal(oldSubmit.accepted, false);
    assert.match(oldSubmit.message, /绑定文件 tasks\.md 已变化/);

    const freshReportPath = join(fx.projectRoot, "fresh-verifier.json");
    writeFileSync(freshReportPath, JSON.stringify({ role: "verifier", findings: [], verdict: "pass" }));
    const freshSubmit = recordJobSubmit(fx.projectRoot, fx.change, fx.changeRoot, freshVerifier.created_jobs[0], freshReportPath);
    assert.equal(freshSubmit.accepted, true);

    const advanced = reviewReady(fx.projectRoot, fx.change, fx.changeRoot);
    assert.equal(advanced.to_state, "review");
  } finally { fx.cleanup(); }
});

test("task-start：apply_done 状态拒绝，必须显式 reopen", () => {
  const fx = setupApplyWithDoneTask();
  try {
    reviewReady(fx.projectRoot, fx.change, fx.changeRoot);
    writeFileSync(join(fx.changeRoot, "tasks.md"), "# Tasks\n\n- [x] TASK-001 Done\n- [ ] TASK-025 Fix review issue\n");

    const result = taskStart(fx.projectRoot, fx.change, fx.changeRoot, "TASK-025");
    assert.equal(result.events_written, 0);
    assert.match(result.message, /需要 apply/);
  } finally { fx.cleanup(); }
});

test("next：active attempt 证据不足时不重复 task-start", () => {
  const fx = setupApplyWithDoneTask();
  try {
    writeFileSync(join(fx.changeRoot, "tasks.md"), "# Tasks\n\n- [ ] TASK-025 Needs TDD\n");
    taskStart(fx.projectRoot, fx.change, fx.changeRoot, "TASK-025");

    const result = next(fx.projectRoot, fx.change, fx.changeRoot);
    assert.equal(result.path, "ask_user");
    assert.match(result.ask_user.question, /RED 证据/);
    assert.match(result.ask_user.question, /GREEN 证据/);
  } finally { fx.cleanup(); }
});

test("reopen：无 pending task 或终态来源时拒绝", () => {
  const fx = setupApplyWithDoneTask();
  try {
    reviewReady(fx.projectRoot, fx.change, fx.changeRoot);
    const noPending = reopen(fx.projectRoot, fx.change, fx.changeRoot, "apply", "no pending");
    assert.equal(noPending.events_written, 0);
    assert.match(noPending.message, /没有未完成任务/);
  } finally { fx.cleanup(); }

  const acceptedFx = setupApplyWithDoneTask();
  try {
    reviewReady(acceptedFx.projectRoot, acceptedFx.change, acceptedFx.changeRoot, "minimal");
    reviewReady(acceptedFx.projectRoot, acceptedFx.change, acceptedFx.changeRoot, "minimal");
    accept(acceptedFx.projectRoot, acceptedFx.change, acceptedFx.changeRoot);
    writeFileSync(join(acceptedFx.changeRoot, "tasks.md"), "# Tasks\n\n- [ ] TASK-025 Too late\n");

    const fromAccepted = reopen(acceptedFx.projectRoot, acceptedFx.change, acceptedFx.changeRoot, "apply", "pending tasks: TASK-025");
    assert.equal(fromAccepted.events_written, 0);
    assert.match(fromAccepted.message, /不能 reopen/);
  } finally { acceptedFx.cleanup(); }

  const archiveFx = setupApplyWithDoneTask();
  try {
    reviewReady(archiveFx.projectRoot, archiveFx.change, archiveFx.changeRoot, "minimal");
    reviewReady(archiveFx.projectRoot, archiveFx.change, archiveFx.changeRoot, "minimal");
    accept(archiveFx.projectRoot, archiveFx.change, archiveFx.changeRoot);
    archive(archiveFx.projectRoot, archiveFx.change, archiveFx.changeRoot);
    writeFileSync(join(archiveFx.changeRoot, "tasks.md"), "# Tasks\n\n- [ ] TASK-025 Too late\n");

    const fromArchive = reopen(archiveFx.projectRoot, archiveFx.change, archiveFx.changeRoot, "apply", "pending tasks: TASK-025");
    assert.equal(fromArchive.events_written, 0);
    assert.match(fromArchive.message, /不能 reopen/);
  } finally { archiveFx.cleanup(); }
});

test("CLI transition reopen：apply_done + pending → apply", () => {
  const fx = setupApplyWithDoneTask();
  try {
    reviewReady(fx.projectRoot, fx.change, fx.changeRoot);
    writeFileSync(join(fx.changeRoot, "tasks.md"), "# Tasks\n\n- [x] TASK-001 Done\n- [ ] TASK-025 CLI followup\n");

    const cli = new URL("../src/cli.ts", import.meta.url).pathname;
    const output = execFileSync(process.execPath, [
      cli,
      "transition",
      "reopen",
      "--change",
      fx.change,
      "--to",
      "apply",
      "--reason",
      "pending tasks: TASK-025",
    ], {
      cwd: fx.projectRoot,
      encoding: "utf8",
    });
    const result = JSON.parse(output);
    assert.equal(result.to_state, "apply");

    const snap = rebuildSnapshot(fx.projectRoot, fx.change, fx.changeRoot);
    assert.equal(snap.state, "apply");
  } finally { fx.cleanup(); }
});

test("review 状态后补任务：next 返回 reopen 且 accept 拒绝", () => {
  const fx = setupApplyWithDoneTask();
  try {
    reviewReady(fx.projectRoot, fx.change, fx.changeRoot, "minimal");
    reviewReady(fx.projectRoot, fx.change, fx.changeRoot, "minimal");
    writeFileSync(join(fx.changeRoot, "tasks.md"), "# Tasks\n\n- [x] TASK-001 Done\n- [ ] TASK-025 Review followup\n");

    const nextResult = next(fx.projectRoot, fx.change, fx.changeRoot);
    assert.equal(nextResult.path, "next_command");
    assert.equal(nextResult.next_command, 'superspec transition reopen --change "test-change" --to apply --reason "pending tasks: TASK-025"');

    const accepted = accept(fx.projectRoot, fx.change, fx.changeRoot);
    assert.equal(accepted.events_written, 0);
    assert.match(accepted.message, /TASK-025/);
  } finally { fx.cleanup(); }
});

test("next：apply 所有任务完成时默认 review-ready 不显式输出 strict", () => {
  const fx = setupApplyWithDoneTask();
  try {
    const result = next(fx.projectRoot, fx.change, fx.changeRoot);
    assert.equal(result.path, "next_command");
    assert.ok(result.next_command.includes("review-ready"));
    assert.doesNotMatch(result.next_command, /--risk strict/);
  } finally { fx.cleanup(); }
});

test("next：apply/apply_done 显式 minimal 会传播到 review-ready", () => {
  const fx = setupApplyWithDoneTask();
  try {
    const applyResult = next(fx.projectRoot, fx.change, fx.changeRoot, "minimal");
    assert.equal(applyResult.path, "next_command");
    assert.ok(applyResult.next_command.includes('review-ready --change "test-change" --risk minimal'));

    const transition = reviewReady(fx.projectRoot, fx.change, fx.changeRoot, "minimal");
    assert.equal(transition.to_state, "apply_done");

    const applyDoneResult = next(fx.projectRoot, fx.change, fx.changeRoot, "minimal");
    assert.equal(applyDoneResult.path, "next_command");
    assert.ok(applyDoneResult.next_command.includes('review-ready --change "test-change" --risk minimal'));
  } finally { fx.cleanup(); }
});

test("review-ready：apply_done → 创建 verifier final gate job", () => {
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
    assert.equal(snap.open_jobs[0].role, "verifier");
    assert.equal(snap.open_jobs[0].created_from_transition, "review-ready");

    const packet = jobsPacket(projectRoot, change, result.created_jobs[0]);
    assert.equal(packet.found, true);
    assert.deepEqual(packet.packet?.output_contract_fields, ["role", "verdict", "findings"]);
    assert.equal((packet.packet?.output_contract_fields as string[]).includes("reviewer"), false);

    const reportPath = join(projectRoot, "verifier.json");
    writeFileSync(reportPath, JSON.stringify({ role: "verifier", findings: [], verdict: "pass" }));
    const recorded = recordJobSubmit(projectRoot, change, changeRoot, result.created_jobs[0], reportPath);
    assert.equal(recorded.accepted, true);

    const advanced = reviewReady(projectRoot, change, changeRoot);
    assert.equal(advanced.outcome, "advanced");
    assert.equal(advanced.to_state, "review");
  } finally { rmSync(projectRoot, { recursive: true, force: true }); }
});

test("review-ready：忽略非 review-ready 来源的 verifier job", () => {
  const fx = setupApplyWithDoneTask();
  try {
    const toApplyDone = reviewReady(fx.projectRoot, fx.change, fx.changeRoot);
    assert.equal(toApplyDone.to_state, "apply_done");

    const unrelatedJob = {
      job_id: "JOB-unrelated-verifier",
      role: "verifier",
      state: "requested",
      boundFiles: [],
      packet_digest: "sha256:unrelated",
      created_from_transition: "apply-verify",
      created_at: new Date().toISOString(),
    };
    appendEvent(fx.projectRoot, fx.change, makeEvent(fx.change, "transition_commit", {
      transition: "apply-verify",
      from_state: "apply_done",
      to_state: "apply_done",
      outcome: "job_created",
      created_job_ids: [unrelatedJob.job_id],
      new_jobs: [unrelatedJob],
      reason: "unrelated verifier",
    }, { transitionId: "T-unrelated-verifier", idempotencyKey: "unrelated-verifier-key" }));
    appendEvent(fx.projectRoot, fx.change, makeEvent(fx.change, "job_accepted", {
      job_id: unrelatedJob.job_id,
      role: "verifier",
      report_digest: "sha256:unrelated-report",
      accepted_at: new Date().toISOString(),
    }));

    const result = reviewReady(fx.projectRoot, fx.change, fx.changeRoot);
    assert.equal(result.outcome, "job_created");
    const snap = rebuildSnapshot(fx.projectRoot, fx.change, fx.changeRoot);
    const created = snap.open_jobs.find(job => job.job_id === result.created_jobs[0]);
    assert.equal(created?.role, "verifier");
    assert.equal(created?.created_from_transition, "review-ready");
  } finally { fx.cleanup(); }
});

test("sync：绑定文件删除会让 open 和 accepted job stale", () => {
  const openFx = setupApplyWithDoneTask();
  try {
    reviewReady(openFx.projectRoot, openFx.change, openFx.changeRoot);
    const created = reviewReady(openFx.projectRoot, openFx.change, openFx.changeRoot);
    const jobId = created.created_jobs[0];

    rmSync(join(openFx.changeRoot, "proposal.md"), { force: true });
    const snap = rebuildSnapshot(openFx.projectRoot, openFx.change, openFx.changeRoot);
    assert.equal(snap.open_jobs.some(job => job.job_id === jobId), false);

    const reportPath = join(openFx.projectRoot, "stale-open.json");
    writeFileSync(reportPath, JSON.stringify({ role: "verifier", findings: [], verdict: "pass" }));
    const staleSubmit = recordJobSubmit(openFx.projectRoot, openFx.change, openFx.changeRoot, jobId, reportPath);
    assert.equal(staleSubmit.accepted, false);
    assert.match(staleSubmit.message, /sha256:missing/);
  } finally { openFx.cleanup(); }

  const acceptedFx = setupApplyWithDoneTask();
  try {
    reviewReady(acceptedFx.projectRoot, acceptedFx.change, acceptedFx.changeRoot);
    const created = reviewReady(acceptedFx.projectRoot, acceptedFx.change, acceptedFx.changeRoot);
    const jobId = created.created_jobs[0];
    const reportPath = join(acceptedFx.projectRoot, "fresh.json");
    writeFileSync(reportPath, JSON.stringify({ role: "verifier", findings: [], verdict: "pass" }));
    const accepted = recordJobSubmit(acceptedFx.projectRoot, acceptedFx.change, acceptedFx.changeRoot, jobId, reportPath);
    assert.equal(accepted.accepted, true);

    rmSync(join(acceptedFx.changeRoot, "proposal.md"), { force: true });
    const snap = rebuildSnapshot(acceptedFx.projectRoot, acceptedFx.change, acceptedFx.changeRoot);
    assert.equal(snap.accepted_jobs.some(job => job.job_id === jobId), false);
  } finally { acceptedFx.cleanup(); }
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

test("H3：verifier final gate accepted 后改文档 → stale → review-ready 创建新 job", () => {
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
    // 1. review-ready → 创建 verifier final gate
    const t1 = reviewReady(projectRoot, change, changeRoot);
    assert.equal(t1.outcome, "job_created");
    const jobId = t1.created_jobs[0];

    // 2. record job-submit → accepted
    const reportPath = join(projectRoot, "report.json");
    writeFileSync(reportPath, JSON.stringify({ role: "verifier", findings: [], verdict: "pass" }));
    recordJobSubmit(projectRoot, change, changeRoot, jobId, reportPath);

    // 3. 改 proposal.md（绑定文件变了）
    writeFileSync(join(changeRoot, "proposal.md"), "# P\nchanged");

    // 4. sync 应移除 stale accepted job
    const snap = rebuildSnapshot(projectRoot, change, changeRoot);
    assert.equal(snap.accepted_jobs.length, 0, "verifier final gate 应因绑定文件变化而 stale");

    // 5. review-ready 应创建新 verifier final gate
    const t2 = reviewReady(projectRoot, change, changeRoot);
    assert.equal(t2.outcome, "job_created");
    assert.notEqual(t2.created_jobs[0], jobId, "应创建新 job（ID 不同）");
  } finally { rmSync(projectRoot, { recursive: true, force: true }); }
});
