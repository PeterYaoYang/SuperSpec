// SuperSpec P2：结构变更清单契约（§8、§13、§14.1）

import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { ensureChangeLayout, appendEvent, makeEvent, readEvents } from "../src/store.ts";
import { next } from "../src/next.ts";
import { proposeReady, reviewReady } from "../src/transition.ts";
import { jobsPacket, recordJobSubmit, recordUserDecisionContent } from "../src/record.ts";
import { applyPlanningBaseline } from "../src/phase_plan.ts";
import { resolveApprovedRef } from "../src/approved_ref.ts";
import { prepareCurrentPhaseConfirmation } from "./phase_confirmation_support.ts";

const V2_PLANNING_PROFILE = {
  version: 2,
  openspec: { mode: "disabled" },
  design: { schema_version: 2 },
} as const;

const V1_PLANNING_PROFILE = {
  version: 2,
  openspec: { mode: "disabled" },
  design: { schema_version: 1 },
} as const;

const DOCUMENTATION_TASKS = [
  "# Tasks",
  "",
  "- [ ] TASK-001 Documentation fixture",
  "  执行依据:",
  "  - 测试:",
  "  - 设计: design.md#Design",
  "  - 来源: proposal.md#Proposal",
  "  - 验收: 文档说明完整",
  "  - 边界: 不改实现代码",
  "",
].join("\n");

function structureLedgerTable(
  rows: Array<{ id: string; category: string; change: string; basis: string; decision: string }>,
): string {
  return [
    "| ID | 类别 | 变更 | 需求依据 | 决定 |",
    "|---|---|---|---|---|",
    ...rows.map(row => `| ${row.id} | ${row.category} | ${row.change} | ${row.basis} | ${row.decision} |`),
    "",
  ].join("\n");
}

function designBody(options: { ledger?: string; extra?: string; decSection?: string }): string {
  const parts = ["# Design", ""];
  if (options.extra) parts.push(options.extra, "");
  if (options.decSection) parts.push(options.decSection, "");
  if (options.ledger != null) {
    parts.push("## 结构变更清单", "", options.ledger);
  }
  return parts.join("\n");
}

function setupV2Propose(options: {
  designContent: string;
  tasks?: string;
  profile?: typeof V2_PLANNING_PROFILE;
}): { projectRoot: string; change: string; changeRoot: string; cleanup: () => void } {
  const projectRoot = mkdtempSync(join(tmpdir(), "superspec-sc-ledger-"));
  const change = "test-change";
  const changeRoot = join(projectRoot, "openspec", "changes", change);
  mkdirSync(join(changeRoot, ".superspec", "artifacts"), { recursive: true });
  mkdirSync(join(changeRoot, "specs", "demo"), { recursive: true });
  writeFileSync(join(changeRoot, "proposal.md"), [
    "# Proposal",
    "",
    "## What Changes",
    "demo change",
    "",
    "## Impact",
    "",
    "| Area | Reason |",
    "|---|---|",
    "| api | demo |",
    "",
  ].join("\n"));
  writeFileSync(join(changeRoot, "design.md"), options.designContent);
  writeFileSync(join(changeRoot, "tasks.md"), options.tasks ?? DOCUMENTATION_TASKS);
  writeFileSync(join(changeRoot, ".superspec", "artifacts", "discovery.md"), "# Discovery\n");
  writeFileSync(join(changeRoot, ".superspec", "artifacts", "test-contract.md"), [
    "# Test Contract",
    "",
    "| test_id | scenario |",
    "|---|---|",
    "| TEST-001 | demo scenario |",
    "",
  ].join("\n"));
  writeFileSync(join(changeRoot, "specs", "demo", "spec.md"), [
    "## ADDED Requirements",
    "",
    "### Requirement: demo requirement",
    "demo behavior",
    "",
  ].join("\n"));
  ensureChangeLayout(projectRoot, change);
  const profile = options.profile ?? V2_PLANNING_PROFILE;
  for (const [t, f, to] of [["init", "init", "init"], ["explore", "init", "explore"], ["propose", "explore", "propose"]] as const) {
    appendEvent(projectRoot, change, makeEvent(change, "transition_commit", {
      transition: t,
      from_state: f,
      to_state: to,
      outcome: "advanced",
      created_job_ids: [],
      reason: t,
      ...(t === "propose" ? {
        planning_validation_version: 2,
        planning_validation_profile: profile,
      } : {}),
    }, { transitionId: `T-${t}`, idempotencyKey: `${t}-key` }));
  }
  return {
    projectRoot,
    change,
    changeRoot,
    cleanup: () => rmSync(projectRoot, { recursive: true, force: true }),
  };
}

function setupV1Apply(): { projectRoot: string; change: string; changeRoot: string; cleanup: () => void } {
  const projectRoot = mkdtempSync(join(tmpdir(), "superspec-sc-v1-"));
  const change = "test-change";
  const changeRoot = join(projectRoot, "openspec", "changes", change);
  mkdirSync(join(changeRoot, ".superspec", "artifacts"), { recursive: true });
  writeFileSync(join(changeRoot, "tasks.md"), [
    "# Tasks",
    "",
    "- [x] TASK-001 Done",
    "  执行依据:",
    "  - 测试:",
    "  - 设计: design.md#D",
    "  - 来源: proposal.md#P",
    "  - 验收: done",
    "  - 边界: none",
    "",
  ].join("\n"));
  writeFileSync(join(changeRoot, "proposal.md"), "# P\n");
  writeFileSync(join(changeRoot, "design.md"), "# D\n\nno ledger section\n");
  writeFileSync(join(changeRoot, ".superspec", "artifacts", "discovery.md"), "# D\n");
  writeFileSync(join(changeRoot, ".superspec", "artifacts", "test-contract.md"), "# TC\n");
  ensureChangeLayout(projectRoot, change);
  for (const [t, f, to] of [
    ["init", "init", "init"],
    ["explore", "init", "explore"],
    ["propose", "explore", "propose"],
    ["propose-ready", "propose", "propose_ready"],
    ["start-apply", "propose_ready", "apply"],
  ] as const) {
    appendEvent(projectRoot, change, makeEvent(change, "transition_commit", {
      transition: t,
      from_state: f,
      to_state: to,
      outcome: "advanced",
      created_job_ids: [],
      reason: t,
      ...(t === "propose" ? {
        planning_validation_version: 2,
        planning_validation_profile: V1_PLANNING_PROFILE,
      } : {}),
      ...(t === "start-apply" ? { apply_planning_baseline: applyPlanningBaseline(changeRoot) } : {}),
    }, { transitionId: `T-${t}`, idempotencyKey: `${t}-key` }));
  }
  return { projectRoot, change, changeRoot, cleanup: () => rmSync(projectRoot, { recursive: true, force: true }) };
}

function setupV2ApplyWithLedger(): ReturnType<typeof setupV1Apply> {
  const ledgerDesign = designBody({
    ledger: structureLedgerTable([{
      id: "SC-001",
      category: "新增公共类型",
      change: "DemoVo",
      basis: "proposal.md#What Changes",
      decision: "—",
    }]),
  });
  const fx = setupV2Propose({
    designContent: ledgerDesign,
    tasks: [
      "# Tasks",
      "",
      "- [x] TASK-001 Done",
      "  执行依据:",
      "  - 测试: TEST-001",
      "  - 设计: design.md#Design",
      "  - 来源: proposal.md#Proposal",
      "  - 验收: done",
      "  - 边界: none",
      "",
    ].join("\n"),
  });
  for (const [t, f, to] of [
    ["propose-ready", "propose", "propose_ready"],
    ["start-apply", "propose_ready", "apply"],
  ] as const) {
    appendEvent(fx.projectRoot, fx.change, makeEvent(fx.change, "transition_commit", {
      transition: t,
      from_state: f,
      to_state: to,
      outcome: "advanced",
      created_job_ids: [],
      reason: t,
      ...(t === "propose-ready" ? {
        planning_validation_version: 2,
        planning_validation_profile: V2_PLANNING_PROFILE,
      } : {}),
      ...(t === "start-apply" ? { apply_planning_baseline: applyPlanningBaseline(fx.changeRoot) } : {}),
    }, { transitionId: `T-${t}`, idempotencyKey: `${t}-key` }));
  }
  return fx;
}

function submitFinding(
  projectRoot: string,
  change: string,
  changeRoot: string,
  jobId: string,
  finding: Record<string, unknown>,
) {
  const packet = jobsPacket(projectRoot, change, jobId);
  const reportPath = join(projectRoot, `${jobId}.report.json`);
  writeFileSync(reportPath, JSON.stringify({
    role: "code-reviewer",
    verdict: "fail",
    review_scope: {
      job_id: jobId,
      packet_digest: packet.packet?.packet_digest,
      checked_paths: (packet.packet?.boundFiles ?? []).map(file => file.path),
      checked_docs: ["design.md"],
      unchecked: [],
    },
    findings: [finding],
    reviewer: { kind: "codex-subagent", id: "structure-ledger-test" },
  }));
  return recordJobSubmit(projectRoot, change, changeRoot, jobId, reportPath);
}

function payloadResultKind(payload: unknown): unknown {
  if (payload && typeof payload === "object" && "result_kind" in payload) {
    return payload.result_kind;
  }
  return undefined;
}

function openCodeReviewer(projectRoot: string, change: string, changeRoot: string): string {
  reviewReady(projectRoot, change, changeRoot);
  const created = reviewReady(projectRoot, change, changeRoot);
  assert.equal(created.outcome, "job_created", created.message);
  return created.created_jobs[0];
}

test("v2 round：design 无结构变更清单 → material_update_required；补无后通过；无 openspec/config.yaml", () => {
  const fx = setupV2Propose({ designContent: "# Design\n\n## 背景\n\nno ledger section\n" });
  try {
    assert.equal(existsSync(join(fx.projectRoot, "openspec", "config.yaml")), false);
    const blocked = next(fx.projectRoot, fx.change, fx.changeRoot, "minimal");
    assert.equal(blocked.path, "material_update_required");
    if (blocked.path !== "material_update_required") throw new Error("expected ledger gate");
    assert.match(blocked.errors.join("；"), /结构变更清单/);

    writeFileSync(join(fx.changeRoot, "design.md"), designBody({ ledger: "无" }));
    const ready = next(fx.projectRoot, fx.change, fx.changeRoot, "minimal");
    assert.notEqual(ready.path, "material_update_required");
    assert.equal(proposeReady(fx.projectRoot, fx.change, fx.changeRoot, "minimal").to_state, "propose_ready");
  } finally { fx.cleanup(); }
});

test("v2 round：改既有公共签名缺 DEC → propose-ready skip；补 DEC 并登记答复后通过", () => {
  const fx = setupV2Propose({
    designContent: designBody({
      ledger: structureLedgerTable([{
        id: "SC-002",
        category: "改既有公共签名",
        change: "Utils.calc 改为接收集合",
        basis: "TEST-001",
        decision: "—",
      }]),
    }),
  });
  try {
    const skipped = proposeReady(fx.projectRoot, fx.change, fx.changeRoot, "minimal");
    assert.equal(skipped.events_written, 0);
    assert.match(skipped.message, /SC-002.*改既有公共签名.*DEC/);

    writeFileSync(join(fx.changeRoot, "design.md"), designBody({
      ledger: structureLedgerTable([{
        id: "SC-002",
        category: "改既有公共签名",
        change: "Utils.calc 改为接收集合",
        basis: "TEST-001",
        decision: "DEC-001",
      }]),
      decSection: [
        "## 待用户确认",
        "",
        "- [ ] DEC-001 是否改签名？",
      ].join("\n"),
    }));

    const ask = next(fx.projectRoot, fx.change, fx.changeRoot, "minimal");
    assert.equal(ask.path, "ask_user");
    if (ask.path !== "ask_user") throw new Error("expected DEC ask");
    assert.match(ask.ask_user.scope, /:DEC-001$/);
    assert.equal(recordUserDecisionContent(fx.projectRoot, fx.change, JSON.stringify({
      scope: ask.ask_user.scope,
      answer: "改签名",
    })).accepted, true);

    writeFileSync(join(fx.changeRoot, "design.md"), designBody({
      ledger: structureLedgerTable([{
        id: "SC-002",
        category: "改既有公共签名",
        change: "Utils.calc 改为接收集合",
        basis: "TEST-001",
        decision: "DEC-001",
      }]),
      decSection: [
        "## 待用户确认",
        "",
        "- [x] DEC-001 是否改签名？",
      ].join("\n"),
    }));

    assert.notEqual(next(fx.projectRoot, fx.change, fx.changeRoot, "minimal").path, "material_update_required");
    assert.equal(proposeReady(fx.projectRoot, fx.change, fx.changeRoot, "minimal").to_state, "propose_ready");
  } finally { fx.cleanup(); }
});

test("v2 round：需决定条目依据 proposal.md#Impact 拒绝", () => {
  const fx = setupV2Propose({
    designContent: designBody({
      ledger: structureLedgerTable([{
        id: "SC-001",
        category: "新增持久化结构",
        change: "new_table",
        basis: "proposal.md#Impact",
        decision: "DEC-001",
      }]),
      decSection: "## 待用户确认\n\n- [x] DEC-001 ok\n",
    }),
  });
  try {
    const blocked = next(fx.projectRoot, fx.change, fx.changeRoot, "minimal");
    assert.equal(blocked.path, "material_update_required");
    if (blocked.path !== "material_update_required") throw new Error("expected impact rejection");
    assert.match(blocked.errors.join("；"), /SC-001.*proposal\.md#Impact/);
  } finally { fx.cleanup(); }
});

test("v2 round：需决定条目依据 Requirement 通过", () => {
  const fx = setupV2Propose({
    designContent: designBody({
      ledger: structureLedgerTable([{
        id: "SC-001",
        category: "新增持久化结构",
        change: "new_column",
        basis: "specs/demo/spec.md#Requirement: demo requirement",
        decision: "DEC-001",
      }]),
      decSection: "## 待用户确认\n\n- [x] DEC-001 ok\n",
    }),
  });
  try {
    assert.notEqual(next(fx.projectRoot, fx.change, fx.changeRoot, "minimal").path, "material_update_required");
    assert.equal(proposeReady(fx.projectRoot, fx.change, fx.changeRoot, "minimal").to_state, "propose_ready");
  } finally { fx.cleanup(); }
});

test("v2 round：仅展示条目依据 proposal.md#What Changes 通过", () => {
  const fx = setupV2Propose({
    designContent: designBody({
      ledger: structureLedgerTable([{
        id: "SC-004",
        category: "新增公共类型",
        change: "DemoVo",
        basis: "proposal.md#What Changes",
        decision: "—",
      }]),
    }),
  });
  try {
    assert.notEqual(next(fx.projectRoot, fx.change, fx.changeRoot, "minimal").path, "material_update_required");
    assert.equal(proposeReady(fx.projectRoot, fx.change, fx.changeRoot, "minimal").to_state, "propose_ready");
  } finally { fx.cleanup(); }
});

test("v2 round：两条 SC 共用一个 DEC 通过", () => {
  const fx = setupV2Propose({
    designContent: designBody({
      ledger: structureLedgerTable([
        {
          id: "SC-002",
          category: "改既有公共签名",
          change: "Utils.calc 改为接收集合",
          basis: "TEST-001",
          decision: "DEC-002",
        },
        {
          id: "SC-003",
          category: "删除既有路径",
          change: "移除旧读取回退",
          basis: "specs/demo/spec.md#Requirement: demo requirement",
          decision: "DEC-002",
        },
      ]),
      decSection: "## 待用户确认\n\n- [x] DEC-002 shared decision\n",
    }),
  });
  try {
    assert.notEqual(next(fx.projectRoot, fx.change, fx.changeRoot, "minimal").path, "material_update_required");
    assert.equal(proposeReady(fx.projectRoot, fx.change, fx.changeRoot, "minimal").to_state, "propose_ready");
  } finally { fx.cleanup(); }
});

test("propose_to_apply 确认问题含 SC 原文", () => {
  const fx = setupV2Propose({
    designContent: designBody({
      ledger: structureLedgerTable([{
        id: "SC-001",
        category: "新增持久化结构",
        change: "schedule_shift_block 新增 rest_periods 列",
        basis: "specs/demo/spec.md#Requirement: demo requirement",
        decision: "DEC-001",
      }]),
      decSection: "## 待用户确认\n\n- [x] DEC-001 ok\n",
    }),
  });
  try {
    assert.equal(proposeReady(fx.projectRoot, fx.change, fx.changeRoot, "minimal").to_state, "propose_ready");
    const confirmation = prepareCurrentPhaseConfirmation(fx.projectRoot, fx.change, fx.changeRoot, "minimal");
    assert.match(confirmation.ask_user.question, /SC-001/);
    assert.match(confirmation.ask_user.question, /schedule_shift_block 新增 rest_periods 列/);
    assert.match(confirmation.ask_user.question, /结构变更清单/);
  } finally { fx.cleanup(); }
});

test("propose_to_apply 确认问题：清单为无时含结构变更：无", () => {
  const fx = setupV2Propose({ designContent: designBody({ ledger: "无" }) });
  try {
    assert.equal(proposeReady(fx.projectRoot, fx.change, fx.changeRoot, "minimal").to_state, "propose_ready");
    const confirmation = prepareCurrentPhaseConfirmation(fx.projectRoot, fx.change, fx.changeRoot, "minimal");
    assert.match(confirmation.ask_user.question, /结构变更：无/);
  } finally { fx.cleanup(); }
});

test("v1 round：不拦截清单且 packet 无 structure_ledger", () => {
  const fx = setupV1Apply();
  try {
    const jobId = openCodeReviewer(fx.projectRoot, fx.change, fx.changeRoot);
    const packet = jobsPacket(fx.projectRoot, fx.change, jobId).packet;
    assert.ok(packet);
    assert.equal("structure_ledger" in packet, false);
    assert.equal(packet.structure_ledger, undefined);
  } finally { fx.cleanup(); }
});

test("v2 round：code-reviewer packet 顶层含 structure_ledger", () => {
  const fx = setupV2ApplyWithLedger();
  try {
    const jobId = openCodeReviewer(fx.projectRoot, fx.change, fx.changeRoot);
    const packet = jobsPacket(fx.projectRoot, fx.change, jobId).packet;
    assert.ok(packet?.structure_ledger);
    assert.equal(packet.structure_ledger?.entries.some(entry => entry.id === "SC-001"), true);
  } finally { fx.cleanup(); }
});

test("approved_refs：design.md#SC-001 可解析为 structure", () => {
  const fx = setupV2ApplyWithLedger();
  try {
    const resolved = resolveApprovedRef(fx.changeRoot, "design.md#SC-001");
    assert.equal(resolved.ok, true);
    if (resolved.ok) {
      assert.equal(resolved.value.kind, "structure");
      assert.equal(resolved.value.short, "SC-001");
    }
  } finally { fx.cleanup(); }
});

test("code-reviewer：missing_approved 只引用 SC 不可执行", () => {
  const fx = setupV2ApplyWithLedger();
  try {
    const jobId = openCodeReviewer(fx.projectRoot, fx.change, fx.changeRoot);
    const rejected = submitFinding(fx.projectRoot, fx.change, fx.changeRoot, jobId, {
      id: "CR-SC-001",
      type: "implementation",
      blocking: true,
      claim_kind: "missing_approved",
      approved_refs: ["design.md#SC-001"],
      description: "missing structure",
      evidence: "src/DemoVo.ts:1",
      source_refs: ["src/DemoVo.ts:1"],
      impact: "gap",
      suggested_action: "apply",
    });
    assert.equal(rejected.accepted, false);
    const event = readEvents(fx.projectRoot, fx.change).findLast(item => item.event_type === "job_rejected");
    assert.equal(payloadResultKind(event?.payload), "non_actionable_report");
  } finally { fx.cleanup(); }
});
