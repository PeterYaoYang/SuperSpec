// SuperSpec：编号引用完整性、路径回执、pass 证据、next 停止点信号与答复闭环

import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { appendEvent, ensureChangeLayout, makeEvent, readEvents } from "../src/store.ts";
import { next } from "../src/next.ts";
import { transitionExplore } from "../src/transition.ts";
import { jobsPacket, recordJobSubmitContent, recordUserDecisionContent } from "../src/record.ts";
import { COVERAGE_MESSAGES } from "../src/report_contract.ts";
import { exploreAnswerRegistrationPayload } from "../src/explore_round.ts";
import type { Event, NextCommandOutput } from "../src/types.ts";
import { confirmCurrentPhase } from "./phase_confirmation_support.ts";

type Fixture = { projectRoot: string; change: string; changeRoot: string; cleanup: () => void };

function setupChange(state: "init" | "explore"): Fixture {
  const projectRoot = mkdtempSync(join(tmpdir(), "superspec-contract-fixes-"));
  const change = "test-change";
  const changeRoot = join(projectRoot, "openspec", "changes", change);
  mkdirSync(join(changeRoot, ".superspec", "artifacts"), { recursive: true });
  writeFileSync(join(changeRoot, "proposal.md"), "# Proposal\n\nTest.\n");
  ensureChangeLayout(projectRoot, change);
  appendEvent(projectRoot, change, makeEvent(change, "transition_commit", {
    transition: "init", from_state: "init", to_state: "init",
    outcome: "advanced", created_job_ids: [], reason: "init",
  }, { transitionId: "T-init", idempotencyKey: "init-key" }));
  if (state === "explore") {
    appendEvent(projectRoot, change, makeEvent(change, "transition_commit", {
      transition: "explore", from_state: "init", to_state: "explore",
      outcome: "advanced", created_job_ids: [], reason: "enter explore",
      ...exploreAnswerRegistrationPayload(null),
    }, { transitionId: "T-explore", idempotencyKey: "explore-key" }));
  }
  return { projectRoot, change, changeRoot, cleanup: () => rmSync(projectRoot, { recursive: true, force: true }) };
}

function writeDiscovery(fx: Fixture, content: string): void {
  writeFileSync(join(fx.changeRoot, ".superspec", "artifacts", "discovery.md"), content);
}

function openExploreCritic(fx: Fixture): string {
  writeDiscovery(fx, "# Discovery\n\nFound stuff.\n");
  const created = transitionExplore(fx.projectRoot, fx.change, fx.changeRoot);
  assert.equal(created.outcome, "job_created", created.message);
  return created.created_jobs[0];
}

test("transition explore 进入 explore 时返回 discovery.md 的项目相对路径", () => {
  const fx = setupChange("init");
  try {
    const result = transitionExplore(fx.projectRoot, fx.change, fx.changeRoot);
    assert.equal(result.to_state, "explore");
    assert.deepEqual(result.details?.next_artifact, {
      kind: "discovery",
      path: `openspec/changes/${fx.change}/.superspec/artifacts/discovery.md`,
      operation: "create_or_update",
    });
  } finally { fx.cleanup(); }
});

test("next：只有问用户和终态是停止点；项目根游离的 .superspec/artifacts 给出提示但不阻断", () => {
  const fx = setupChange("explore");
  try {
    const missing = next(fx.projectRoot, fx.change, fx.changeRoot, "normal");
    assert.equal(missing.path, "artifact_required");
    assert.equal(missing.stop_allowed, false);
    assert.equal(missing.warnings, undefined);

    mkdirSync(join(fx.projectRoot, ".superspec", "artifacts"), { recursive: true });
    writeFileSync(join(fx.projectRoot, ".superspec", "artifacts", "discovery.md"), "# misplaced\n");
    const warned = next(fx.projectRoot, fx.change, fx.changeRoot, "normal");
    assert.equal(warned.path, "artifact_required");
    assert.equal(warned.warnings?.length, 1);

    writeDiscovery(fx, "# Discovery\n\n## 待确认问题\n\n- [ ] Q-001 合计按什么口径舍入？\n");
    const asking = next(fx.projectRoot, fx.change, fx.changeRoot, "normal");
    assert.equal(asking.path, "ask_user");
    assert.equal(asking.stop_allowed, true);
  } finally { fx.cleanup(); }
});

test("discovery 引用未定义的问题编号时先修材料，不提问也不创建审查", () => {
  const fx = setupChange("explore");
  try {
    writeDiscovery(fx, [
      "# Discovery", "",
      "合计口径见 Q-002 的结论。", "",
      "## 待确认问题", "",
      "- [ ] Q-001 负数金额是否在范围内？", "",
    ].join("\n"));
    const blocked = next(fx.projectRoot, fx.change, fx.changeRoot, "normal");
    assert.equal(blocked.path, "material_update_required");
    if (blocked.path !== "material_update_required") throw new Error("expected material update");
    assert.ok(blocked.errors.some(error => error.includes("Q-002")));
    assert.equal(blocked.errors.some(error => error.includes("Q-001")), false);
    assert.equal(blocked.stop_allowed, false);

    const transition = transitionExplore(fx.projectRoot, fx.change, fx.changeRoot);
    assert.equal(transition.created_jobs.length, 0);
    assert.match(transition.message, /Q-002/);

    writeDiscovery(fx, [
      "# Discovery", "",
      "合计口径见 Q-002 的结论。", "",
      "## 待确认问题", "",
      "- [ ] Q-001 负数金额是否在范围内？",
      "- [ ] Q-002 合计按各行舍入后求和还是原始和舍入？", "",
    ].join("\n"));
    assert.equal(next(fx.projectRoot, fx.change, fx.changeRoot, "normal").path, "ask_user");
  } finally { fx.cleanup(); }
});

test("discovery 引用未在留待计划阶段定义的推迟项编号时先修材料", () => {
  const fx = setupChange("explore");
  try {
    const discovery = (deferred: string[]) => [
      "# Discovery", "",
      "## 风险和边界", "",
      "- 合计舍入路线见 D-002。", "",
      "## 留待计划阶段", "",
      ...deferred, "",
    ].join("\n");
    writeDiscovery(fx, discovery(["- D-001 旧导出接口的兼容方式"]));
    const blocked = next(fx.projectRoot, fx.change, fx.changeRoot, "normal");
    assert.equal(blocked.path, "material_update_required");
    if (blocked.path !== "material_update_required") throw new Error("expected material update");
    assert.ok(blocked.errors.some(error => error.includes("D-002") && !error.includes("D-001")));

    writeDiscovery(fx, discovery(["- D-001 旧导出接口的兼容方式", "- D-002 合计舍入路线"]));
    assert.notEqual(next(fx.projectRoot, fx.change, fx.changeRoot, "normal").path, "material_update_required");
  } finally { fx.cleanup(); }
});

test("discovery 编号核对：待确认条目编号带粗体或标签时视为已定义；无留待计划段时不核对 D 编号；代码块不参与核对", () => {
  const fx = setupChange("explore");
  try {
    writeDiscovery(fx, [
      "# Discovery", "",
      "## 仓库事实", "",
      "- 旧版本号 D-1 的接口保持不变；合计口径见 Q-001，展示方式见 Q-002。", "",
      "```text",
      "Q-099 只是日志样例",
      "```", "",
      "## 待确认问题", "",
      "- [ ] **Q-001** 合计按各行舍入后求和还是原始和舍入？",
      "- [ ] [展示] Q-002 金额是否显示千分位？", "",
    ].join("\n"));
    const result = next(fx.projectRoot, fx.change, fx.changeRoot, "normal");
    assert.equal(result.path, "ask_user", result.path === "material_update_required" ? result.errors.join("\n") : result.reason);
  } finally { fx.cleanup(); }
});

test("propose 计划材料引用未定义的 DEC/SC 编号时 next 返回材料修复", () => {
  const fx = setupChange("explore");
  try {
    writeDiscovery(fx, "# Discovery\n\nFound stuff.\n");
    confirmCurrentPhase(fx.projectRoot, fx.change, fx.changeRoot, "normal");
    assert.equal(transitionExplore(fx.projectRoot, fx.change, fx.changeRoot, "normal").to_state, "propose");
    writeFileSync(join(fx.changeRoot, "design.md"), [
      "# Design", "",
      "合计时机沿用 DEC-009 的结论，并按 SC-003 调整入口。", "",
      "## 结构变更清单", "",
      "无", "",
    ].join("\n"));
    writeFileSync(join(fx.changeRoot, ".superspec", "artifacts", "test-contract.md"), "# Test Contract\n");
    writeFileSync(join(fx.changeRoot, "tasks.md"), "# Tasks\n\n- [ ] TASK-001 first\n");

    const result = next(fx.projectRoot, fx.change, fx.changeRoot);
    assert.equal(result.path, "material_update_required");
    if (result.path !== "material_update_required") throw new Error("expected material update");
    const referenceError = result.errors.find(error => error.startsWith("design.md"));
    assert.ok(referenceError, result.errors.join("\n"));
    assert.ok(referenceError.includes("DEC-009") && referenceError.includes("SC-003"));

    const design = (checkbox: " " | "x") => [
      "# Design", "",
      "合计时机沿用 DEC-009 的结论。", "",
      "## 待用户确认", "",
      `- [${checkbox}] **DEC-009** 合计在提交时计算还是保存时计算？`, "",
      "## 结构变更清单", "",
      "无", "",
    ].join("\n");
    writeFileSync(join(fx.changeRoot, "design.md"), design(" "));
    const ask = askUser(next(fx.projectRoot, fx.change, fx.changeRoot));
    assert.equal(recordUserDecisionContent(fx.projectRoot, fx.change, JSON.stringify({ scope: ask.scope, answer: "提交时计算" })).accepted, true);
    writeFileSync(join(fx.changeRoot, "design.md"), design("x"));
    const fixed = next(fx.projectRoot, fx.change, fx.changeRoot);
    const errors = fixed.path === "material_update_required" ? fixed.errors : [];
    assert.equal(errors.some(error => error.includes("DEC-009")), false, errors.join("\n"));
  } finally { fx.cleanup(); }
});

test("计划审查 packet 给出 project_path，回执用项目相对路径同样有效", () => {
  const fx = setupChange("explore");
  try {
    const jobId = openExploreCritic(fx);
    const packet = jobsPacket(fx.projectRoot, fx.change, jobId).packet;
    assert.ok(packet);
    const discovery = packet.boundFiles.find(file => file.path === ".superspec/artifacts/discovery.md");
    assert.equal(discovery?.project_path, `openspec/changes/${fx.change}/.superspec/artifacts/discovery.md`);

    const result = recordJobSubmitContent(fx.projectRoot, fx.change, fx.changeRoot, jobId, JSON.stringify({
      role: packet.role,
      verdict: "pass",
      evidence_refs: ["openspec/changes/test-change/.superspec/artifacts/discovery.md:1"],
      findings: [],
      review_scope: { checked_paths: packet.boundFiles.map(file => file.project_path) },
      reviewer: { kind: "subagent", id: "critic-project-path" },
    }));
    assert.equal(result.accepted, true, result.message);
  } finally { fx.cleanup(); }
});

test("审查 pass 报告缺少证据引用时可修正重交，补上证据后接受", () => {
  const fx = setupChange("explore");
  try {
    const jobId = openExploreCritic(fx);
    const packet = jobsPacket(fx.projectRoot, fx.change, jobId).packet;
    assert.ok(packet);
    assert.deepEqual(packet.report_skeleton?.evidence_refs, []);
    const report = {
      role: packet.role,
      verdict: "pass",
      findings: [],
      review_scope: { checked_paths: packet.boundFiles.map(file => file.path) },
      reviewer: { kind: "subagent", id: "critic-evidence" },
    };

    const missing = recordJobSubmitContent(fx.projectRoot, fx.change, fx.changeRoot, jobId, JSON.stringify(report));
    assert.equal(missing.accepted, false);
    assert.equal(missing.result_kind, "retryable");
    assert.ok(missing.message.includes(COVERAGE_MESSAGES.passWithoutEvidence));

    const blank = recordJobSubmitContent(fx.projectRoot, fx.change, fx.changeRoot, jobId, JSON.stringify({ ...report, evidence_refs: [" "] }));
    assert.equal(blank.result_kind, "retryable");

    const emptyObject = recordJobSubmitContent(fx.projectRoot, fx.change, fx.changeRoot, jobId, JSON.stringify({ ...report, evidence_refs: [{}] }));
    assert.equal(emptyObject.result_kind, "retryable");

    const fixed = recordJobSubmitContent(fx.projectRoot, fx.change, fx.changeRoot, jobId, JSON.stringify({
      ...report,
      evidence_refs: [".superspec/artifacts/discovery.md:3 结论与仓库事实一致"],
    }));
    assert.equal(fixed.accepted, true, fixed.message);
  } finally { fx.cleanup(); }
});

const REMEMBER_ME_DISCOVERY = (checkbox: " " | "x", question = "记住我登录保持多久？选项：A 指定一个更长时长 / B 仅要求比 7 天长。建议：A") => [
  "# Discovery", "",
  "## 需求理解", "",
  "- 用户目标：延长记住我的有效期", "",
  "## 待确认问题", "",
  `- [${checkbox}] Q-001 ${question}`, "",
].join("\n");

function askUser(output: NextCommandOutput) {
  assert.equal(output.path, "ask_user");
  if (output.path !== "ask_user") throw new Error("expected ask_user");
  return output.ask_user;
}

function decisionEvents(fx: Fixture): Event[] {
  return readEvents(fx.projectRoot, fx.change).filter(event => event.event_type === "user_decision_recorded" && event.payload.accepted === true);
}

test("答复需要补充时在同一问题和 scope 下追问，闭环答复带上此前的答复，回写前不再重复提问", () => {
  const fx = setupChange("explore");
  try {
    writeDiscovery(fx, REMEMBER_ME_DISCOVERY(" "));
    const first = askUser(next(fx.projectRoot, fx.change, fx.changeRoot));
    assert.ok(first.instruction, "待确认问题的提问输出自带追问登记说明，不依赖 AGENTS.md 或 Skill");
    const partial = { scope: first.scope, question: first.question, answer: "选择 A", closure: "needs_followup", followup: "A 需要一个具体天数" };

    assert.equal(recordUserDecisionContent(fx.projectRoot, fx.change, JSON.stringify(partial)).accepted, true);
    const eventCount = readEvents(fx.projectRoot, fx.change).length;
    assert.equal(recordUserDecisionContent(fx.projectRoot, fx.change, JSON.stringify(partial)).accepted, true);
    assert.equal(readEvents(fx.projectRoot, fx.change).length, eventCount);

    const followup = next(fx.projectRoot, fx.change, fx.changeRoot);
    const followupAsk = askUser(followup);
    assert.equal(followup.stop_allowed, true);
    assert.equal(followupAsk.scope, first.scope);
    assert.notEqual(followupAsk.question, first.question);
    assert.deepEqual(followupAsk.answer_history?.map(record => [record.answer, record.closure, record.current_revision]), [["选择 A", "needs_followup", true]]);
    const presentations = readEvents(fx.projectRoot, fx.change).filter(event => event.event_type === "user_question_presented");
    assert.equal(presentations.length, 2);
    assert.equal(presentations[1].payload.followup_of, decisionEvents(fx)[0].event_id);

    writeDiscovery(fx, REMEMBER_ME_DISCOVERY("x"));
    assert.equal(next(fx.projectRoot, fx.change, fx.changeRoot).path, "material_update_required");
    writeDiscovery(fx, REMEMBER_ME_DISCOVERY(" "));

    const closed = recordUserDecisionContent(fx.projectRoot, fx.change, JSON.stringify({ scope: first.scope, question: first.question, answer: "保持 30 天" }));
    assert.equal(closed.accepted, true, closed.message);
    const closing = decisionEvents(fx).at(-1)!;
    assert.equal(closing.payload.closure, "closed");
    assert.deepEqual((closing.payload.earlier_answers as Array<{ answer: string; followup?: string }>).map(item => [item.answer, item.followup]), [["选择 A", "A 需要一个具体天数"]]);

    const awaitingWriteback = next(fx.projectRoot, fx.change, fx.changeRoot);
    assert.equal(awaitingWriteback.path, "material_update_required");
    assert.equal(awaitingWriteback.stop_allowed, false);
    assert.equal(recordUserDecisionContent(fx.projectRoot, fx.change, JSON.stringify({ scope: first.scope, answer: "保持 60 天" })).accepted, false);
    assert.equal(recordUserDecisionContent(fx.projectRoot, fx.change, JSON.stringify({ ...partial, answer: "再想想" })).accepted, false);

    writeDiscovery(fx, REMEMBER_ME_DISCOVERY("x"));
    assert.notEqual(next(fx.projectRoot, fx.change, fx.changeRoot).path, "material_update_required");
  } finally { fx.cleanup(); }
});

test("审查 packet 的已确认决定只含闭环答复，并带上闭环前需要补充的答复", () => {
  const fx = setupChange("explore");
  try {
    writeDiscovery(fx, REMEMBER_ME_DISCOVERY(" "));
    const ask = askUser(next(fx.projectRoot, fx.change, fx.changeRoot));
    recordUserDecisionContent(fx.projectRoot, fx.change, JSON.stringify({ scope: ask.scope, answer: "选择 A", closure: "needs_followup", followup: "A 需要一个具体天数" }));
    recordUserDecisionContent(fx.projectRoot, fx.change, JSON.stringify({ scope: ask.scope, answer: "保持 30 天" }));
    writeDiscovery(fx, REMEMBER_ME_DISCOVERY("x"));
    const created = transitionExplore(fx.projectRoot, fx.change, fx.changeRoot);
    assert.equal(created.outcome, "job_created", created.message);

    const packet = jobsPacket(fx.projectRoot, fx.change, created.created_jobs[0]).packet;
    assert.deepEqual(packet?.confirmed_decisions?.map(decision => [decision.answer, decision.earlier_answers?.map(item => item.answer)]), [["保持 30 天", ["选择 A"]]]);
  } finally { fx.cleanup(); }
});

test("问题修订后，此前的答复作为上下文随新问题展示，但不自动视为新问题的答案", () => {
  const fx = setupChange("explore");
  try {
    writeDiscovery(fx, REMEMBER_ME_DISCOVERY(" "));
    const first = askUser(next(fx.projectRoot, fx.change, fx.changeRoot));
    recordUserDecisionContent(fx.projectRoot, fx.change, JSON.stringify({ scope: first.scope, answer: "选择 A" }));

    writeDiscovery(fx, REMEMBER_ME_DISCOVERY(" ", "记住我登录保持多少天？建议值：30 天"));
    const revised = askUser(next(fx.projectRoot, fx.change, fx.changeRoot));
    assert.notEqual(revised.scope, first.scope);
    assert.deepEqual(revised.answer_history?.map(record => [record.answer, record.current_revision]), [["选择 A", false]]);

    writeDiscovery(fx, REMEMBER_ME_DISCOVERY("x", "记住我登录保持多少天？建议值：30 天"));
    assert.equal(next(fx.projectRoot, fx.change, fx.changeRoot).path, "material_update_required");
  } finally { fx.cleanup(); }
});

test("closure 取值、followup 和适用范围不合法时拒绝登记", () => {
  const fx = setupChange("explore");
  try {
    writeDiscovery(fx, REMEMBER_ME_DISCOVERY(" "));
    const ask = askUser(next(fx.projectRoot, fx.change, fx.changeRoot));
    const record = (input: Record<string, unknown>) => recordUserDecisionContent(fx.projectRoot, fx.change, JSON.stringify(input));

    assert.equal(record({ scope: ask.scope, answer: "选择 A", closure: "partial" }).accepted, false);
    assert.equal(record({ scope: ask.scope, answer: "选择 A", closure: "needs_followup" }).accepted, false);
    assert.equal(record({ scope: ask.scope, answer: "选择 A", closure: "needs_followup", followup: " " }).accepted, false);
    assert.equal(record({ scope: "test_coverage_exemption:TEST-001", answer: "无需测试", closure: "needs_followup", followup: "原因不明" }).accepted, false);
    assert.equal(decisionEvents(fx).length, 0);
    assert.equal(askUser(next(fx.projectRoot, fx.change, fx.changeRoot)).scope, ask.scope);
  } finally { fx.cleanup(); }
});

test("Propose 设计决定同样支持需要补充的答复，闭环后等待回写", () => {
  const fx = setupChange("explore");
  try {
    writeDiscovery(fx, "# Discovery\n\nFound stuff.\n");
    confirmCurrentPhase(fx.projectRoot, fx.change, fx.changeRoot, "normal");
    assert.equal(transitionExplore(fx.projectRoot, fx.change, fx.changeRoot, "normal").to_state, "propose");
    const design = (checkbox: " " | "x") => `# Design\n\n## 待用户确认\n\n- [${checkbox}] DEC-001 兼容策略：A 双写迁移 / B 读时回退。建议：A\n`;
    writeFileSync(join(fx.changeRoot, "design.md"), design(" "));

    const ask = askUser(next(fx.projectRoot, fx.change, fx.changeRoot));
    assert.equal(recordUserDecisionContent(fx.projectRoot, fx.change, JSON.stringify({ scope: ask.scope, answer: "都行", closure: "needs_followup", followup: "需要在两种策略中选一种，或说明其他要求" })).accepted, true);
    const followupAsk = askUser(next(fx.projectRoot, fx.change, fx.changeRoot));
    assert.equal(followupAsk.scope, ask.scope);
    assert.equal(followupAsk.answer_history?.length, 1);

    assert.equal(recordUserDecisionContent(fx.projectRoot, fx.change, JSON.stringify({ scope: ask.scope, answer: "选 B" })).accepted, true);
    assert.equal(next(fx.projectRoot, fx.change, fx.changeRoot).path, "material_update_required");
    writeFileSync(join(fx.changeRoot, "design.md"), design("x"));
    assert.notEqual(next(fx.projectRoot, fx.change, fx.changeRoot).path, "ask_user");
  } finally { fx.cleanup(); }
});
