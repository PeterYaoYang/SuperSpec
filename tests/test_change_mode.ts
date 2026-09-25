import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { next } from "../src/next.ts";
import { accept, proposeReady, reopen, reviewReady, startApply, taskComplete, taskStart, transitionExplore, transitionInit } from "../src/transition.ts";
import { jobsPacket, recordJobSubmitContent, recordUserDecisionContent, recordWorkflowModeContent } from "../src/record.ts";
import { appendEvent, ensureChangeLayout, makeEvent, readEvents } from "../src/store.ts";
import { rebuildSnapshot } from "../src/sync.ts";
import { workflowModeStatus, workflowRiskForChange } from "../src/workflow_config.ts";
import type { PhaseDecisionAction } from "../src/phase_confirmation.ts";
import type { JobRole, TransitionResult } from "../src/types.ts";

type Change = { projectRoot: string; change: string; changeRoot: string };

function project(t: { after: (cleanup: () => void) => void }): string {
  const root = mkdtempSync(join(tmpdir(), "superspec-change-mode-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  setProjectMode(root, "normal");
  return root;
}

function setProjectMode(root: string, mode: "minimal" | "normal" | "strict"): void {
  mkdirSync(join(root, ".superspec"), { recursive: true });
  writeFileSync(join(root, ".superspec", "config.json"), JSON.stringify({ workflow: { mode } }));
}

function changeFiles(projectRoot: string, change: string): Change {
  const changeRoot = join(projectRoot, "openspec", "changes", change);
  mkdirSync(join(changeRoot, ".superspec", "artifacts"), { recursive: true });
  writeFileSync(join(changeRoot, "proposal.md"), "# Proposal\n\nClarify the supported flag.\n");
  writeFileSync(join(changeRoot, "design.md"), "# Design\n\nOnly clarify the existing flag comment.\n\n## 结构变更清单\n\n无\n");
  writeFileSync(join(changeRoot, "tasks.md"), [
    "# Tasks", "",
    "- [ ] TASK-001 Clarify flag documentation",
    "  执行依据:",
    "  - 测试:",
    "  - 设计: design.md#Design",
    "  - 来源: proposal.md#Proposal",
    "  - 验收: 现有开关的代码注释与行为一致",
    "  - 边界: 仅改注释，不改变运行时行为", "",
  ].join("\n"));
  writeFileSync(join(changeRoot, ".superspec", "artifacts", "test-contract.md"), "# Test Contract\n\nOnly comments change; no runtime behavior changes.\n");
  return { projectRoot, change, changeRoot };
}

function discover(fx: Change, detail = "The flag behavior is already implemented; only its comment changes."): void {
  writeFileSync(join(fx.changeRoot, ".superspec", "artifacts", "discovery.md"), `# Discovery\n\n${detail}\n`);
}

/** 与 `superspec status --change` 输出的模式字段一致。 */
function modeStatus(fx: Change) {
  const events = readEvents(fx.projectRoot, fx.change);
  const state = rebuildSnapshot(fx.projectRoot, fx.change, fx.changeRoot).state;
  return workflowModeStatus(events, state, workflowRiskForChange(fx.projectRoot, events, state), fx.change);
}

function initialize(root: string, name: string): Change {
  const fx = changeFiles(root, name);
  transitionInit(root, name, fx.changeRoot);
  assert.equal(transitionExplore(root, name, fx.changeRoot).to_state, "explore");
  discover(fx);
  return fx;
}

function select(fx: Change, mode: "minimal" | "normal", source: "agent" | "user" = "agent") {
  return recordWorkflowModeContent(fx.projectRoot, fx.change, JSON.stringify({
    mode, source, reason: "依据当前 discovery 的影响范围选择",
    ...(source === "user" ? { user_request: `本次请使用 ${mode}` } : {}),
  }));
}

// 与 phase_confirmation_support 使用同一公开确认协议，但不能改项目配置：
// 这里需要验证已选 change 不受别的 change 或全局配置影响。
function confirm(fx: Change): void {
  const output = next(fx.projectRoot, fx.change, fx.changeRoot);
  assert.equal(output.path, "ask_user");
  const action = (output.ask_user.actions as PhaseDecisionAction[]).find(item => item.decision === "advance");
  assert.ok(action);
  const result = recordUserDecisionContent(fx.projectRoot, fx.change, JSON.stringify(action.record_input));
  assert.equal(result.accepted, true, result.message);
}

function expectJobs(fx: Change, result: TransitionResult, roles: JobRole[]): string[] {
  assert.equal(result.outcome, "job_created", result.message);
  assert.deepEqual(result.created_jobs.map(id => {
    const packet = jobsPacket(fx.projectRoot, fx.change, id).packet;
    assert.ok(packet);
    return packet.role;
  }).sort(), [...roles].sort());
  const output = next(fx.projectRoot, fx.change, fx.changeRoot);
  assert.equal(output.path, "required_job");
  assert.deepEqual(output.required_jobs.map(job => job.job_id).sort(), [...result.created_jobs].sort());
  return result.created_jobs;
}

function passJobs(fx: Change, ids: string[]): void {
  for (const id of ids) {
    const packet = jobsPacket(fx.projectRoot, fx.change, id).packet;
    assert.ok(packet);
    const result = recordJobSubmitContent(fx.projectRoot, fx.change, fx.changeRoot, id, JSON.stringify({
      role: packet.role, verdict: "pass", evidence_refs: ["test:evidence"], findings: [],
      review_scope: {
        checked_paths: packet.boundFiles.map(file => file.path),
        ...(packet.role === "code-reviewer" ? {
          job_id: id, packet_digest: packet.packet_digest,
          checked_docs: ["proposal.md", "design.md", "tasks.md", ".superspec/artifacts/test-contract.md"],
          unchecked: [],
        } : {}),
      },
      reviewer: { kind: "codex-subagent", id: "change-mode-test" },
    }));
    assert.equal(result.accepted, true, result.message);
  }
}

function enterPropose(fx: Change): void {
  confirm(fx);
  assert.equal(transitionExplore(fx.projectRoot, fx.change, fx.changeRoot).to_state, "propose");
}

function assertRejectedWithoutEvents(fx: Change, input: unknown): void {
  const before = readEvents(fx.projectRoot, fx.change);
  const result = recordWorkflowModeContent(fx.projectRoot, fx.change, JSON.stringify(input));
  assert.equal(result.accepted, false);
  assert.deepEqual(readEvents(fx.projectRoot, fx.change), before);
}

test("新 init 与直接 explore 均先形成 discovery，未选档不能直接跨越探索门禁", t => {
  const root = project(t);
  const initialized = changeFiles(root, "initialized");
  transitionInit(root, initialized.change, initialized.changeRoot);
  assert.equal(next(root, initialized.change, initialized.changeRoot).path, "next_command");
  assert.equal(transitionExplore(root, initialized.change, initialized.changeRoot).to_state, "explore");
  const direct = changeFiles(root, "direct-explore");
  assert.equal(transitionExplore(root, direct.change, direct.changeRoot).to_state, "explore");
  assertRejectedWithoutEvents(direct, { mode: "minimal", source: "agent", reason: "尚未调查就提前选档" });

  for (const fx of [initialized, direct]) {
    assert.equal(next(root, fx.change, fx.changeRoot).path, "artifact_required");
    discover(fx);
    assert.equal(next(root, fx.change, fx.changeRoot).path, "mode_selection_required");
    const selectionStep = next(root, fx.change, fx.changeRoot);
    if (selectionStep.path !== "mode_selection_required") throw new Error("expected mode selection");
    assert.equal(selectionStep.selection.record_input.source, "agent");
    assert.equal(selectionStep.selection.user_record_input.source, "user");
    assert.equal(selectionStep.selection.user_record_input.user_request, null);
    const before = readEvents(root, fx.change);
    assert.equal(transitionExplore(root, fx.change, fx.changeRoot).to_state, "explore");
    assert.equal(proposeReady(root, fx.change, fx.changeRoot).to_state, "explore");
    assert.equal(startApply(root, fx.change, fx.changeRoot).to_state, "explore");
    assert.deepEqual(readEvents(root, fx.change), before);
    assert.equal(select(fx, "minimal").accepted, true);
    assert.equal(rebuildSnapshot(root, fx.change, fx.changeRoot).state, "explore");
    enterPropose(fx);
  }
});

test("两个 change 独立选档，全局模式变化不增加 minimal critic 或移除 normal critic", t => {
  const root = project(t);
  const light = initialize(root, "light");
  const normal = initialize(root, "normal");
  assert.equal(select(light, "minimal").accepted, true);
  assert.equal(select(normal, "normal").accepted, true);

  setProjectMode(root, "strict");
  enterPropose(light);
  assert.equal(proposeReady(root, light.change, light.changeRoot).to_state, "propose_ready");
  const explore = expectJobs(normal, transitionExplore(root, normal.change, normal.changeRoot), ["critic"]);
  passJobs(normal, explore);

  setProjectMode(root, "minimal");
  enterPropose(normal);
  const propose = expectJobs(normal, proposeReady(root, normal.change, normal.changeRoot), ["critic"]);
  passJobs(normal, propose);
  assert.equal(proposeReady(root, normal.change, normal.changeRoot).to_state, "propose_ready");
  confirm(light);
  assert.equal(startApply(root, light.change, light.changeRoot).to_state, "apply");
  confirm(normal);
  assert.equal(startApply(root, normal.change, normal.changeRoot).to_state, "apply");
  assert.equal(next(root, light.change, light.changeRoot).workflow_mode, "minimal");
  assert.equal(next(root, normal.change, normal.changeRoot).workflow_mode, "normal");
});

test("minimal 跳过计划 critic 但代码审查和最终 verifier 仍阻止提前接受", t => {
  const root = project(t);
  mkdirSync(join(root, "src"));
  writeFileSync(join(root, "src", "settings.ts"), "export const enabled = true;\n");
  writeFileSync(join(root, ".gitignore"), ".superspec/\nopenspec/\n");
  const git = (...args: string[]) => execFileSync("git", args, { cwd: root, stdio: "ignore" });
  git("init");
  git("add", ".gitignore", "src/settings.ts");
  git("-c", "user.name=Mode Test", "-c", "user.email=mode@example.test", "-c", "commit.gpgsign=false", "commit", "-m", "fixture baseline");
  const fx = initialize(root, "minimal-review");
  assert.equal(select(fx, "minimal").accepted, true);
  enterPropose(fx);
  assert.equal(proposeReady(root, fx.change, fx.changeRoot).to_state, "propose_ready");
  confirm(fx);
  assert.equal(startApply(root, fx.change, fx.changeRoot).to_state, "apply");
  const startApplyCommit = readEvents(root, fx.change).findLast(event =>
    event.event_type === "transition_commit" && (event.payload as { transition?: string }).transition === "start-apply");
  assert.deepEqual((startApplyCommit?.payload as { review_policy?: unknown }).review_policy, {
    review_risk: "minimal",
    requires_verifier: true,
  });
  taskStart(root, fx.change, fx.changeRoot, "TASK-001");
  writeFileSync(join(root, "src", "settings.ts"), "// The supported feature is enabled.\nexport const enabled = true;\n");
  const completed = taskComplete(root, fx.change, fx.changeRoot, "TASK-001");
  assert.ok(completed.events_written > 0, completed.message);
  assert.equal(reviewReady(root, fx.change, fx.changeRoot).to_state, "apply_done");
  const codeReview = expectJobs(fx, reviewReady(root, fx.change, fx.changeRoot), ["code-reviewer"]);
  assert.equal(accept(root, fx.change, fx.changeRoot).to_state, "apply_done");
  assert.equal(reviewReady(root, fx.change, fx.changeRoot).to_state, "apply_done");
  passJobs(fx, codeReview);
  assert.equal(next(root, fx.change, fx.changeRoot).path, "next_command");
  assert.equal(reviewReady(root, fx.change, fx.changeRoot).to_state, "review");
  assert.equal(accept(root, fx.change, fx.changeRoot).to_state, "review");
  const verifier = expectJobs(fx, reviewReady(root, fx.change, fx.changeRoot), ["verifier"]);
  assert.equal(accept(root, fx.change, fx.changeRoot).to_state, "review");
  passJobs(fx, verifier);
  assert.equal(accept(root, fx.change, fx.changeRoot).to_state, "accepted");
});

test("非法模式或来源和缺失用户原话不污染事件，相同有效选择幂等", t => {
  const root = project(t);
  const fx = initialize(root, "invalid-selection");
  assertRejectedWithoutEvents(fx, { mode: "strict", source: "agent", reason: "历史档位不能新选" });
  assertRejectedWithoutEvents(fx, { mode: "normal", source: "system", reason: "未知来源" });
  assertRejectedWithoutEvents(fx, { mode: "normal", source: "user", reason: "未提供原话" });
  assertRejectedWithoutEvents(fx, { mode: "normal", source: "agent", reason: " " });
  assert.equal(next(root, fx.change, fx.changeRoot).path, "mode_selection_required");
  assert.equal(select(fx, "normal").accepted, true);
  const before = readEvents(root, fx.change);
  assert.equal(select(fx, "normal").accepted, true);
  assert.deepEqual(readEvents(root, fx.change), before);
  expectJobs(fx, transitionExplore(root, fx.change, fx.changeRoot), ["critic"]);
});

test("用户可纠正尚未发审的 agent 选择，agent 不得覆盖用户选择", t => {
  const root = project(t);
  const fx = initialize(root, "user-priority");
  assert.equal(select(fx, "normal").accepted, true);
  assert.equal(select(fx, "minimal", "user").accepted, true);
  assertRejectedWithoutEvents(fx, { mode: "normal", source: "agent", reason: "重新评估" });
  enterPropose(fx);
  assert.equal(proposeReady(root, fx.change, fx.changeRoot).to_state, "propose_ready");
});

test("normal 首次发审即冻结，reopen Explore 不能降档绕过 critic", t => {
  const root = project(t);
  const fx = initialize(root, "normal-freeze");
  assert.equal(select(fx, "normal").accepted, true);
  const original = expectJobs(fx, transitionExplore(root, fx.change, fx.changeRoot), ["critic"]);
  assertRejectedWithoutEvents(fx, { mode: "minimal", source: "user", reason: "请求轻量处理", user_request: "改成 minimal" });
  const frozen = readEvents(root, fx.change);
  assert.equal(select(fx, "normal").accepted, true);
  assert.deepEqual(readEvents(root, fx.change), frozen);
  passJobs(fx, original);
  enterPropose(fx);
  assert.equal(reopen(root, fx.change, fx.changeRoot, "explore", "补充探索证据").to_state, "explore");
  discover(fx, "The shared consumer needs an additional compatibility check.");
  assertRejectedWithoutEvents(fx, { mode: "minimal", source: "user", reason: "再次请求降档", user_request: "现在改成 minimal" });
  const reopened = expectJobs(fx, transitionExplore(root, fx.change, fx.changeRoot), ["critic"]);
  assert.notEqual(reopened[0], original[0]);
});

test("minimal 离开 Explore 后不能就地升级，reopen Explore 升级 normal 必须补两阶段 critic", t => {
  const root = project(t);
  const fx = initialize(root, "upgrade");
  assert.equal(select(fx, "minimal").accepted, true);
  enterPropose(fx);
  assert.equal(proposeReady(root, fx.change, fx.changeRoot).to_state, "propose_ready");
  assert.equal(next(root, fx.change, fx.changeRoot).mode_upgrade, undefined, "next 的逐步输出不常驻升级入口");
  const upgrade = modeStatus(fx).mode_upgrade;
  assert.equal(upgrade?.target_mode, "normal");
  const upgradeArgv = upgrade?.reopen_argv ?? [];
  assert.deepEqual(upgradeArgv.slice(0, 10), [
    "superspec", "transition", "reopen", "--change", fx.change,
    "--to", "explore", "--upgrade-mode", "normal", "--reason",
  ]);
  assert.ok(upgradeArgv.length > 10, "升级 reopen 必须带默认 reason");
  assertRejectedWithoutEvents(fx, { mode: "normal", source: "agent", reason: "发现共享影响" });
  assert.equal(reopen(root, fx.change, fx.changeRoot, "explore", "发现共享影响，需要补探索", { upgradeMode: "normal" }).to_state, "explore");
  discover(fx, "The flag is shared by another consumer, requiring compatibility review.");
  assert.equal(next(root, fx.change, fx.changeRoot).path, "mode_selection_required");
  assert.equal(select(fx, "normal").accepted, true);
  setProjectMode(root, "minimal");
  const explore = expectJobs(fx, transitionExplore(root, fx.change, fx.changeRoot), ["critic"]);
  passJobs(fx, explore);
  enterPropose(fx);
  const propose = expectJobs(fx, proposeReady(root, fx.change, fx.changeRoot), ["critic"]);
  passJobs(fx, propose);
  assert.equal(proposeReady(root, fx.change, fx.changeRoot).to_state, "propose_ready");
  confirm(fx);
  assert.equal(startApply(root, fx.change, fx.changeRoot).to_state, "apply");
  assert.equal(next(root, fx.change, fx.changeRoot).workflow_mode, "normal");
});

test("升级请求等待期间：agent 不能就地维持 minimal，用户明确维持则关闭请求", t => {
  const root = project(t);
  const declined = initialize(root, "upgrade-declined");
  assert.equal(select(declined, "minimal", "user").accepted, true);
  enterPropose(declined);
  assert.ok(modeStatus(declined).mode_upgrade);
  assert.equal(reopen(root, declined.change, declined.changeRoot, "explore", "发现共享影响", { upgradeMode: "normal" }).to_state, "explore");
  discover(declined, "The flag is shared by another consumer.");

  const pending = next(root, declined.change, declined.changeRoot);
  assert.equal(pending.path, "mode_selection_required");
  if (pending.path !== "mode_selection_required") throw new Error("expected pending upgrade selection");
  assert.deepEqual(pending.selection.allowed_modes, ["minimal", "normal"]);
  assert.equal(pending.selection.record_input.mode, "normal", "升级等待期 agent 的模板答案就是 normal");
  assert.equal(pending.mode_upgrade_pending, true);
  assertRejectedWithoutEvents(declined, { mode: "minimal", source: "agent", reason: "复核后仍属局部修改" });
  assertRejectedWithoutEvents(declined, { mode: "normal", source: "agent", reason: "共享影响已确认" });
  assert.equal(transitionExplore(root, declined.change, declined.changeRoot).events_written, 0);

  assert.equal(select(declined, "minimal", "user").accepted, true, "用户明确维持 minimal 必须被接受");
  const resumed = next(root, declined.change, declined.changeRoot);
  assert.notEqual(resumed.path, "mode_selection_required");
  assert.equal(resumed.mode_upgrade_pending, undefined);
  confirm(declined);
  assert.equal(transitionExplore(root, declined.change, declined.changeRoot).to_state, "propose");

  const upgradeAgain = initialize(root, "upgrade-agent");
  assert.equal(select(upgradeAgain, "minimal").accepted, true);
  enterPropose(upgradeAgain);
  assert.equal(reopen(root, upgradeAgain.change, upgradeAgain.changeRoot, "explore", "发现共享影响", { upgradeMode: "normal" }).to_state, "explore");
  discover(upgradeAgain, "The flag is shared by another consumer.");
  assertRejectedWithoutEvents(upgradeAgain, { mode: "minimal", source: "agent", reason: "其实只是注释" });
  assert.equal(select(upgradeAgain, "normal").accepted, true);
  assert.notEqual(next(root, upgradeAgain.change, upgradeAgain.changeRoot).path, "mode_selection_required");
});

test("未标记 legacy change 继续 strict 审查，冻结后全局降档不改变历史轮次", t => {
  const root = project(t);
  setProjectMode(root, "strict");
  const fx = changeFiles(root, "legacy-strict");
  discover(fx);
  ensureChangeLayout(root, fx.change);
  // 只有兼容回放场景允许直接建立旧事件；新 change 全部走公开初始化 API。
  for (const [transition, from, to] of [["init", "init", "init"], ["explore", "init", "explore"]] as const) {
    appendEvent(root, fx.change, makeEvent(fx.change, "transition_commit", {
      transition, from_state: from, to_state: to, outcome: "advanced", created_job_ids: [], reason: transition,
    }, { transitionId: `T-legacy-${transition}`, idempotencyKey: `legacy-${transition}` }));
  }
  assertRejectedWithoutEvents(fx, { mode: "minimal", source: "agent", reason: "尝试在首次 legacy 审查前降档" });
  const explore = expectJobs(fx, transitionExplore(root, fx.change, fx.changeRoot), ["critic"]);
  passJobs(fx, explore);
  enterPropose(fx);
  const propose = expectJobs(fx, proposeReady(root, fx.change, fx.changeRoot), ["critic", "architect", "test-engineer"]);
  passJobs(fx, propose);
  assert.equal(proposeReady(root, fx.change, fx.changeRoot).to_state, "propose_ready");
  setProjectMode(root, "minimal");
  confirm(fx);
  assert.equal(startApply(root, fx.change, fx.changeRoot).to_state, "apply");
  assert.equal(next(root, fx.change, fx.changeRoot).workflow_mode, "strict");
  assertRejectedWithoutEvents(fx, { mode: "minimal", source: "user", reason: "尝试覆盖历史轮次", user_request: "使用 minimal" });
});
