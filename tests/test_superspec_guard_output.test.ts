import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import test from "node:test";
import {
  copyFileSync,
  existsSync,
  linkSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { hostname, tmpdir } from "node:os";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import * as guard from "../superspec_guard.ts";
import { main_init } from "../src/init_cli.ts";
import { reason_message_zh, translate_action_zh } from "../src/i18n.ts";
import { project_init } from "../src/project_init.ts";
import {
  findRepoRoot,
  GUARD_ROOT,
  REPO_ROOT,
  GUARD_TS,
  GUARD_TS_URL,
  INIT_TS,
  mkdirp,
  writeText,
  readJson,
  materializeEvidenceRecord,
  codes,
  captureStdoutJson,
  captureStdoutText,
  captureMain,
  captureMainJson,
  assertSafeOutputHasNoLeaks,
  assertNoForbiddenAgentKeys,
  walkFiles,
  installOpenspecSkills,
  installSuperSpecAgents,
  createFixture,
  activeFixture,
  withFixture,
  withRuntime,
  waitForChild,
  status,
  passEvidence,
  roleEvidence,
  reviewEvidence,
  reviewGuidanceEvidences,
  legacyCodeReviewWorkflowEvidence,
  mainAdjudication,
  verifyEvidence,
  DEFAULT_RUN_LOG,
  defaultRunLog,
  redEvidence,
  greenEvidence,
  taskReopenEvidence,
  taskReopenResolvedEvidence,
  supersededEvidence,
  alternativeVerificationEvidence,
  reopenBlockingFinding,
  finalTestEvidence,
  archiveReadyEvidences,
  reopenGuidanceEvidences,
  taskReopenReadyEvidences,
  businessInvariantsText,
  testContractText,
  testContractRowsText,
  invariantMatrixText,
  proposalReviewedEvidences,
  prepareProposeComplete,
  setTaskCheckbox,
  EXPLORE_ONLY_STATUS,
  DISCOVERY_REL,
  writeDiscovery,
  discoveryBlob,
  exploreCheck,
  exploreConfirmedEvidences,
  discSchemaCodes,
  exploreFinding,
  exploreRoundReview,
  exploreRoundPrompt,
  exploreDigest,
  dispositionOf,
  userDecision,
  standingAuth,
  supersedeMarker,
  PROPOSAL_REL,
  writeProposal,
  proposalTargets,
  proposalCheck,
  proposalFinding,
  proposalRoundReview,
  proposalRoundPrompt,
  proposalDigest,
  designTargetRefs,
  targetRefList,
  gateFinding,
  roundReviewWithTargets,
  roundDigestWithTargets,
  proposeChainThroughDesign,
} from "./helpers/superspec_guard_fixture.ts";
import type { JsonMap, Fixture } from "./helpers/superspec_guard_fixture.ts";

test("decorateDecision adds Chinese workflow labels without changing reason codes", () => {
  const raw = guard.block("demo-change", "explore_complete", [
    guard.reason("needs_user_decision_pending", "explore_complete: finding is waiting for the user's A/B/C/D decision"),
  ], {
    next_actions: ["rerun check-enter --change demo-change --gate explore_complete"],
  });
  const decorated = guard.decorateDecision(raw, { command: "check-enter" });
  assert.equal(decorated.command_label_zh, "进入阶段前检查");
  assert.equal(decorated.gate_label_zh, "探索完成");
  assert.equal(decorated.decision_zh, "未通过");
  assert.equal(decorated.block_reasons[0].code, "needs_user_decision_pending");
  assert.equal(decorated.block_reasons[0].label_zh, "等待用户确认");
  assert.equal(decorated.next_allowed_actions_zh[0], "重新运行进入阶段前检查。");
  assert.ok(Array.isArray(decorated.workflow_terms_zh));
  assert.ok(decorated.workflow_terms_zh.some((item: JsonMap) => item.term === "check-enter" && item.label_zh === "进入阶段前检查"));
  assert.ok(decorated.workflow_terms_zh.some((item: JsonMap) => item.term === "acceptance" && item.label_zh === "验收标准"));
  assert.ok(decorated.workflow_terms_zh.some((item: JsonMap) => item.term === "user_review_decision" && item.label_zh === "用户确认记录"));
  assert.ok(decorated.workflow_terms_zh.some((item: JsonMap) => item.term === "main_review_digest" && item.label_zh === "审查问题记录"));
});

test("printDecision adds Chinese display fields while preserving machine-readable fields", () => {
  const raw = guard.block("demo-change", "explore_complete", [
    guard.reason("needs_user_decision_pending", "explore_complete: finding is waiting for the user's A/B/C/D decision"),
  ], {
    next_actions: ["fix project_init_failed reasons, then rerun superspec init --scope project"],
  });
  raw.actions = [
    {
      action: "install .codex/skills/superspec-explore/SKILL.md",
      status: "updated",
      detail: "existing file backed up to .codex/skills/superspec-explore/SKILL.md.bak",
    },
  ];
  const printed = captureStdoutJson(() => {
    guard.printDecision(raw, { command: "check-enter" });
  });
  assert.equal(printed.block_reasons[0].code, "needs_user_decision_pending");
  assert.match(printed.block_reasons[0].message, /finding is waiting for the user's A\/B\/C\/D decision/u);
  assert.equal(printed.block_reasons[0].message_zh, "等待用户确认：当前问题需要用户确认，请先选择 A/B/C/D 中的一项。");
  assert.equal(printed.next_allowed_actions[0], "fix project_init_failed reasons, then rerun superspec init --scope project");
  assert.equal(printed.next_allowed_actions_zh[0], "先处理项目初始化失败对应问题，然后重新运行相关命令。");
  assert.match(printed.trust_warnings[0], /audit-only\/self-reported/u);
  assert.match(printed.trust_warnings_zh[0], /审计参考|自报信息/u);
  assert.equal(printed.actions[0].action, "install .codex/skills/superspec-explore/SKILL.md");
  assert.equal(printed.actions[0].action_zh, "安装 .codex/skills/superspec-explore/SKILL.md");
  assert.equal(printed.actions[0].status, "updated");
  assert.equal(printed.actions[0].status_zh, "已更新");
  assert.equal(printed.actions[0].detail, "existing file backed up to .codex/skills/superspec-explore/SKILL.md.bak");
  assert.equal(printed.actions[0].detail_zh, "已有文件已备份到 .codex/skills/superspec-explore/SKILL.md.bak。");
  assert.ok(printed.workflow_terms_zh.some((item: JsonMap) => item.term === "user_review_decision" && item.label_zh === "用户确认记录"));
  assert.ok(printed.workflow_terms_zh.some((item: JsonMap) => item.term === "main_review_digest" && item.label_zh === "审查问题记录"));
});

test("agent output is a safe whitelist view while json keeps diagnostic fields", () => {
  const raw = guard.block("demo-change", "explore_complete", [
    guard.reason(
      "needs_user_decision_pending",
      "用户裁决：export function foo() { return needs_user_decision; } main_review_digest decision_scope_key finding_uid",
      ["function foo(", "user_review_decision"],
    ),
  ], {
    next_actions: ["AskUserQuestion then write user_review_decision with decision_scope_key and finding_uid"],
  });
  raw.actions = [{
    action: "export function foo()",
    status: "updated",
    detail: "main_review_digest function foo(",
  }];

  const jsonDiagnostic = captureStdoutJson(() => {
    guard.printDecision(raw, { command: "check-enter", format: "json" });
  });
  assert.equal(jsonDiagnostic.gate, "explore_complete");
  assert.equal(jsonDiagnostic.block_reasons[0].code, "needs_user_decision_pending");
  assert.match(jsonDiagnostic.block_reasons[0].message, /export function foo/u);
  assert.ok(Array.isArray(jsonDiagnostic.workflow_terms_zh));

  const agentText = captureStdoutText(() => {
    guard.printDecision(raw, { command: "check-enter", format: "agent" });
  });
  const agent = JSON.parse(agentText);
  assert.equal(agent.allowed, false);
  assert.equal(agent.status, "blocked");
  assert.equal(agent.workflow_action, "ask_user_confirmation");
  assertNoForbiddenAgentKeys(agent);
  assertSafeOutputHasNoLeaks(agentText);
});

test("user output hides poisoned raw messages and protocol terms", () => {
  const raw = guard.block("demo-change", "explore_complete", [
    guard.reason("needs_user_decision_pending", "用户裁决 export function foo() needs_user_decision main_review_digest", ["function foo("]),
  ], {
    next_actions: ["AskUserQuestion then write user_review_decision"],
  });
  const text = captureStdoutText(() => {
    guard.printDecision(raw, { command: "check-enter", format: "user" });
  });
  assert.match(text, /暂时不能继续/u);
  assert.match(text, /用户确认/u);
  assertSafeOutputHasNoLeaks(text);
});

test("safe output uses generic action text for evidence-kind blockers", () => {
  const cases: Array<[string, guard.AgentWorkflowAction]> = [
    ["missing_source_guidance", "collect_review_evidence"],
    ["missing_final_verification_review", "collect_review_evidence"],
    ["missing_final_tests", "collect_test_evidence"],
    ["missing_main_adjudication", "collect_review_evidence"],
  ];
  for (const [code, expectedAction] of cases) {
    const raw = guard.block("demo-change", "review_complete", [
      guard.reason(code, "review_complete requires source_guidance verification_review final_test main_adjudication evidence"),
    ], {
      next_actions: ["repair source_guidance evidence and write main_adjudication"],
    });

    const agentText = captureStdoutText(() => {
      guard.printDecision(raw, { command: "check-review-complete", format: "agent" });
    });
    const agent = JSON.parse(agentText);
    assert.equal(agent.workflow_action, expectedAction, code);
    assertNoForbiddenAgentKeys(agent);
    assertSafeOutputHasNoLeaks(agentText);

    const userText = captureStdoutText(() => {
      guard.printDecision(raw, { command: "check-review-complete", format: "user" });
    });
    assertSafeOutputHasNoLeaks(userText);
  }
});

test("agent output falls back safely for unknown reason and gate identifiers", () => {
  const raw = guard.block("demo-change", "raw_secret_gate", [
    guard.reason("raw_secret_reason", "needs_user_decision main_review_digest export function foo()", ["decision_scope_key", "function foo("]),
  ], {
    next_actions: ["AskUserQuestion user_review_decision"],
  });
  const agentText = captureStdoutText(() => {
    guard.printDecision(raw, { command: "check-enter", format: "agent" });
  });
  const agent = JSON.parse(agentText);
  assert.equal(agent.workflow_action, "inspect_diagnostics");
  assert.equal(agent.stage_label_zh, "内部流程阶段");
  assertNoForbiddenAgentKeys(agent);
  assertSafeOutputHasNoLeaks(agentText);
});

test("agent workflow action mapping is deterministic for common blocker groups", () => {
  const cases: Array<[string, guard.AgentWorkflowAction]> = [
    ["needs_user_decision_pending", "ask_user_confirmation"],
    ["missing_source_guidance", "collect_review_evidence"],
    ["missing_final_verification_review", "collect_review_evidence"],
    ["missing_main_adjudication", "collect_review_evidence"],
    ["missing_red_evidence", "collect_test_evidence"],
    ["missing_final_tests", "collect_test_evidence"],
    ["validate_failed", "collect_test_evidence"],
    ["invalid_task_graph", "fix_artifacts"],
    ["review_digest_invalid", "fix_artifacts"],
    ["state_corrupt", "inspect_diagnostics"],
    ["unknown_future_reason", "inspect_diagnostics"],
  ];
  for (const [code, expected] of cases) {
    assert.equal(guard.workflowActionForReasonCodes([code]), expected, code);
  }
  assert.equal(guard.workflowActionForReasonCodes([], true), "continue");
});

test("printDecision adds Windows PowerShell cmd shim hints for openspec and superspec commands", () => {
  const raw = guard.block("demo-change", "project_init", [
    guard.reason("openspec_native_surface_missing", "Run `openspec status --help` and then `superspec init --scope project`."),
  ]);
  const printed = captureStdoutJson(() => {
    guard.printDecision(raw, { command: "init" });
  });
  assert.deepEqual(printed.windows_powershell_command_hints, [
    "Windows PowerShell: use `openspec.cmd status --help`",
    "Windows PowerShell: use `superspec.cmd init --scope project`",
  ]);
});

test("reason_message_zh rewrites workflow-internal review terms into Chinese explanation", () => {
  const rendered = reason_message_zh("missing_source_guidance", "review_complete requires critic source_guidance evidence");
  assert.match(rendered, /缺少审查指导证据/u);
  assert.match(rendered, /审查完成/u);
  assert.match(rendered, /严格审查/u);
  assert.equal(rendered.includes("source_guidance"), false);
  assert.equal(rendered.includes("review_complete"), false);

  const mixed = reason_message_zh("user_decision_unbound", "用户确认已写入 user_review_decision 但 main_review_digest 未引用 confirmed_refs");
  assert.match(mixed, /用户确认记录/u);
  assert.match(mixed, /审查问题记录/u);
  assert.match(mixed, /已确认内容引用/u);
  assert.equal(mixed.includes("user_review_decision"), false);
  assert.equal(mixed.includes("main_review_digest"), false);
  assert.equal(mixed.includes("confirmed_refs"), false);
});

test("translate_action_zh hides workflow-internal terms in review completion actions", () => {
  assert.equal(
    translate_action_zh("collect review_complete source_guidance from missing roles: critic, verifier"),
    "补齐审查完成所缺的审查指导证据（角色：严格审查、验证审查）。",
  );
  assert.equal(
    translate_action_zh("record final_test pass evidence and reference it from verification_review"),
    "记录最终测试通过证据，并在验证审查证据中引用它。",
  );
});
