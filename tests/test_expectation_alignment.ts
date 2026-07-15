import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { ensureChangeLayout, appendEvent, makeEvent, readEvents } from "../src/store.ts";
import { next } from "../src/next.ts";
import { jobsPacket, recordUserDecisionContent } from "../src/record.ts";
import { recordTestRunContent } from "../src/task.ts";
import { proposeReady, reviewReady, startApply, taskComplete, taskStart } from "../src/transition.ts";
import { pendingTaskStatusForApply, planningValidationProfileForNewRound } from "../src/phase_plan.ts";
import { diffFingerprints } from "../src/git_state.ts";
import { codeReviewPacketContext } from "../src/code_review.ts";
import { reviewEvidenceDigest } from "../src/review.ts";
import {
  parseExecutionRequirements,
  parseTestContractEntries,
  tasksStructureDigest,
  validateExecutionRequirementDocumentReferences,
  validateExecutionRequirements,
} from "../src/format.ts";
import { validateOpenSpecChange } from "../src/openspec.ts";
import { sha256Text } from "../src/store.ts";
import type { Event } from "../src/types.ts";
import { phaseConfirmationForBoundary, type PhaseDecisionAction } from "../src/phase_confirmation.ts";
import { rebuildSnapshot } from "../src/sync.ts";
import { confirmCurrentPhase } from "./phase_confirmation_support.ts";

const V2_DISABLED_PLANNING_PROFILE = {
  version: 2,
  openspec: { mode: "disabled" },
} as const;

function setupChange(
  tasks: string,
  testContract = "# Test Contract\n",
  _workflowMode: "minimal" | "normal" | "strict" = "strict",
): { projectRoot: string; change: string; changeRoot: string; cleanup: () => void } {
  const projectRoot = mkdtempSync(join(tmpdir(), "superspec-align-"));
  const change = "align-change";
  const changeRoot = join(projectRoot, "openspec", "changes", change);
  mkdirSync(join(changeRoot, ".superspec", "artifacts"), { recursive: true });
  writeFileSync(join(changeRoot, "proposal.md"), "# Proposal\n");
  writeFileSync(join(changeRoot, "design.md"), "# Design\n");
  writeFileSync(join(changeRoot, "tasks.md"), tasks);
  writeFileSync(join(changeRoot, ".superspec", "artifacts", "discovery.md"), "# Discovery\n");
  writeFileSync(join(changeRoot, ".superspec", "artifacts", "test-contract.md"), testContract);
  ensureChangeLayout(projectRoot, change);
  for (const [transition, from, to] of [
    ["init", "init", "init"],
    ["explore", "init", "explore"],
    ["propose", "explore", "propose"],
    ["propose-ready", "propose", "propose_ready"],
  ] as const) {
    appendEvent(projectRoot, change, makeEvent(change, "transition_commit", {
      transition,
      from_state: from,
      to_state: to,
      outcome: "advanced",
      created_job_ids: [],
      reason: transition,
    }, { transitionId: `T-${transition}`, idempotencyKey: `${transition}-key` }));
  }
  return {
    projectRoot,
    change,
    changeRoot,
    cleanup: () => rmSync(projectRoot, { recursive: true, force: true }),
  };
}

function setupProposeChange(tasks: string, testContract = "# Test Contract\n"): { projectRoot: string; change: string; changeRoot: string; cleanup: () => void } {
  const fx = setupChange(tasks, testContract);
  rmSync(join(fx.projectRoot, ".superspec", "changes", fx.change, "events.jsonl"), { force: true });
  ensureChangeLayout(fx.projectRoot, fx.change);
  for (const [transition, from, to] of [
    ["init", "init", "init"],
    ["explore", "init", "explore"],
    ["propose", "explore", "propose"],
  ] as const) {
    appendEvent(fx.projectRoot, fx.change, makeEvent(fx.change, "transition_commit", {
      transition,
      from_state: from,
      to_state: to,
      outcome: "advanced",
      created_job_ids: [],
      reason: transition,
      ...(transition === "propose" ? {
        planning_validation_version: 2,
        planning_validation_profile: V2_DISABLED_PLANNING_PROFILE,
      } : {}),
    }, { transitionId: `T-propose-${transition}`, idempotencyKey: `propose-${transition}-key` }));
  }
  return fx;
}

function initGitRepo(projectRoot: string): void {
  execFileSync("git", ["init"], { cwd: projectRoot, stdio: "ignore" });
  execFileSync("git", ["config", "user.email", "test@example.com"], { cwd: projectRoot, stdio: "ignore" });
  execFileSync("git", ["config", "user.name", "Test User"], { cwd: projectRoot, stdio: "ignore" });
}

function startApplyConfirmed(
  projectRoot: string,
  change: string,
  changeRoot: string,
  risk: "minimal" | "normal" | "strict" = "strict",
) {
  const tasks = readFileSync(join(changeRoot, "tasks.md"), "utf8");
  // 这些 evidence-focused fixtures 不构造完整的 Proposal reviewer 历史；直接落入
  // v2 Apply snapshot，避免让 fixture 的历史 gate 形状掩盖要验证的 task 语义。
  if (tasks.includes("执行依据")) {
    appendEvent(projectRoot, change, makeEvent(change, "transition_commit", {
      transition: "start-apply",
      from_state: "propose_ready",
      to_state: "apply",
      outcome: "advanced",
      created_job_ids: [],
      reason: "test v2 apply snapshot",
      apply_contract_mode: true,
      execution_requirement_version: 2,
      execution_policy: risk === "strict" ? "tdd" : "green_only",
      workflow_mode: risk,
      review_policy: { review_risk: risk, requires_verifier: risk !== "minimal" },
    }, { transitionId: `T-v2-start-${risk}`, idempotencyKey: `v2-start-${risk}` }));
    return { to_state: "apply" };
  }
  confirmCurrentPhase(projectRoot, change, changeRoot, risk);
  return startApply(projectRoot, change, changeRoot);
}

test("推进校验：propose-ready 和 start-apply 都拒绝执行依据模式下缺执行依据的普通 TDD task", () => {
  const tasks = [
    "# Tasks",
    "",
    "- [ ] TASK-001 Has contract tdd_required:true",
    "  执行依据:",
    "  - 测试: test-contract.md#TEST-001",
    "  - 设计: design.md#Route",
    "  - 来源: proposal.md#Impact",
    "  - 验收: 独立验收行为",
    "  - 边界: 不改持久化",
    "- [ ] TASK-002 Missing contract tdd_required:true",
    "",
  ].join("\n");
  const testContract = [
    "# Test Contract",
    "",
    "| test_id | scenario |",
    "|---|---|",
    "| TEST-001 | behavior works |",
    "",
  ].join("\n");

  const proposeFx = setupProposeChange(tasks, testContract);
  try {
    const blocked = proposeReady(proposeFx.projectRoot, proposeFx.change, proposeFx.changeRoot, "minimal");
    assert.equal(blocked.events_written, 0);
    assert.match(blocked.message, /TASK-002 缺少执行依据/);
  } finally {
    proposeFx.cleanup();
  }

  const applyFx = setupChange(tasks, testContract);
  try {
    const blocked = startApply(applyFx.projectRoot, applyFx.change, applyFx.changeRoot);
    assert.equal(blocked.events_written, 0);
    assert.match(blocked.message, /TASK-002 缺少执行依据/);
  } finally {
    applyFx.cleanup();
  }
});

test("执行依据：测试字段必须显式声明；空字段可表示非行为 task，声明的 TEST 必须存在", () => {
  const missingTestField = [
    "# Tasks",
    "",
    "- [ ] TASK-001 Missing test field tdd_required:true",
    "  执行依据:",
    "  - 设计: design.md#Route",
    "  - 来源: proposal.md#Impact",
    "  - 原因: 独立验收行为",
    "  - 边界: 不改持久化",
    "",
  ].join("\n");
  const unknownTest = missingTestField.replace("  - 设计:", "  - 测试: test-contract.md#TEST-999\n  - 设计:");
  const emptyTestField = missingTestField.replace("  - 设计:", "  - 测试:\n  - 设计:");
  const testContract = [
    "# Test Contract",
    "",
    "| test_id | scenario |",
    "|---|---|",
    "| TEST-001 | behavior works |",
    "",
  ].join("\n");

  const missingFx = setupProposeChange(missingTestField, testContract);
  try {
    const blocked = proposeReady(missingFx.projectRoot, missingFx.change, missingFx.changeRoot, "minimal");
    assert.equal(blocked.events_written, 0);
    assert.match(blocked.message, /缺少测试字段/);
  } finally {
    missingFx.cleanup();
  }

  const emptyFx = setupProposeChange(emptyTestField, testContract);
  try {
    const advanced = proposeReady(emptyFx.projectRoot, emptyFx.change, emptyFx.changeRoot, "minimal");
    assert.equal(advanced.to_state, "propose_ready");
  } finally {
    emptyFx.cleanup();
  }

  const unknownFx = setupChange(unknownTest, testContract);
  try {
    const blocked = startApply(unknownFx.projectRoot, unknownFx.change, unknownFx.changeRoot);
    assert.equal(blocked.events_written, 0);
    assert.match(blocked.message, /不存在的 TEST ID：TEST-999/);
  } finally {
    unknownFx.cleanup();
  }
});

test("执行依据：设计与来源引用由状态机要求使用可定位文档格式", () => {
  const tasks = [
    "# Tasks",
    "",
    "- [ ] TASK-001 Invalid refs",
    "  执行依据:",
    "  - 测试: TEST-001",
    "  - 设计: Route",
    "  - 来源: proposal.md#Impact；CHAIN-001",
    "  - 验收: 可检查的结果",
    "  - 边界: 不改持久化",
  ].join("\n");
  const testContract = [
    "# Test Contract",
    "",
    "| test_id | scenario |",
    "|---|---|",
    "| TEST-001 | behavior works |",
  ].join("\n");

  const result = validateExecutionRequirements(tasks, testContract, "tdd", 2);
  assert.equal(result.ok, false);
  assert.match(result.errors.join("；"), /设计必须使用 文件\.md#标题/);
  assert.match(result.errors.join("；"), /来源必须使用 文件\.md#标题 的可定位引用：CHAIN-001/);
});

test("执行依据：同一文档的多个 CHAIN/IDC 锚点分别解析，discovery 使用 artifact 路径", () => {
  const tasks = [
    "# Tasks",
    "",
    "- [ ] TASK-001 Resolve grouped anchors",
    "  执行依据:",
    "  - 测试:",
    "  - 设计: design.md#Route",
    "  - 来源: discovery.md#CHAIN-001,IDC-001",
    "  - 验收: 可检查的结果",
    "  - 边界: 不改持久化",
  ].join("\n");
  const fx = setupChange(tasks);
  try {
    writeFileSync(join(fx.changeRoot, "design.md"), "# Design\n\n## Route\n");
    writeFileSync(join(fx.changeRoot, ".superspec", "artifacts", "discovery.md"), "# Discovery\n\nCHAIN-001\nIDC-001\n");
    assert.deepEqual(
      validateExecutionRequirementDocumentReferences(fx.changeRoot, parseExecutionRequirements(tasks)),
      [],
    );
  } finally {
    fx.cleanup();
  }
});

test("历史 v1 计划：即使项目已初始化 OpenSpec，start-apply 不追加 v2 的 Impact/strict gate", () => {
  const fx = setupChange("# Tasks\n\n- [ ] TASK-001 Historical documentation tdd_required:false no_tdd_reason:documentation-only\n");
  try {
    writeFileSync(join(fx.projectRoot, "openspec", "config.yaml"), "schema: spec-driven\n");
    const result = startApply(fx.projectRoot, fx.change, fx.changeRoot);
    assert.doesNotMatch(result.message, /Impact|OpenSpec strict/);
  } finally {
    fx.cleanup();
  }
});

test("历史 v1 计划：保留旧 tasks 形态，不要求 v2 顶级标题或任务格式", () => {
  const fx = setupChange("## Historical plan\n\n  - [ ] TASK-001 Nested legacy task\n");
  try {
    writeFileSync(join(fx.projectRoot, "openspec", "config.yaml"), "schema: spec-driven\n");
    const result = startApply(fx.projectRoot, fx.change, fx.changeRoot);
    assert.doesNotMatch(result.message, /tasks\.md 内容不像任务计划文档|缺少执行依据|Impact|OpenSpec strict/);
  } finally {
    fx.cleanup();
  }
});

test("v2 disabled profile：propose-ready 后新增 OpenSpec 配置不追溯增加 strict gate", () => {
  const tasks = [
    "# Tasks",
    "",
    "- [ ] TASK-001 Document behavior",
    "  执行依据:",
    "  - 测试:",
    "  - 设计: design.md#Design",
    "  - 来源: proposal.md#Proposal",
    "  - 验收: 文档可阅读",
    "  - 边界: 不改代码",
  ].join("\n");
  const fx = setupChange(tasks);
  try {
    appendEvent(fx.projectRoot, fx.change, makeEvent(fx.change, "transition_commit", {
      transition: "propose-ready",
      from_state: "propose_ready",
      to_state: "propose_ready",
      outcome: "advanced",
      created_job_ids: [],
      reason: "seed v2 disabled profile",
      execution_requirement_version: 2,
      planning_validation_version: 2,
      planning_validation_profile: V2_DISABLED_PLANNING_PROFILE,
    }, { transitionId: "T-v2-disabled-ready", idempotencyKey: "v2-disabled-ready" }));
    writeFileSync(join(fx.projectRoot, "openspec", "config.yaml"), "schema: spec-driven\n");

    const result = startApply(fx.projectRoot, fx.change, fx.changeRoot);
    assert.doesNotMatch(result.message, /Impact|OpenSpec strict|配置自本 planning round 起已变化/);
  } finally {
    fx.cleanup();
  }
});

test("v2 strict profile：OpenSpec 配置变化后必须 reopen 计划轮", () => {
  const tasks = [
    "# Tasks",
    "",
    "- [ ] TASK-001 Document behavior",
    "  执行依据:",
    "  - 测试:",
    "  - 设计: design.md#Design",
    "  - 来源: proposal.md#Proposal",
    "  - 验收: 文档可阅读",
    "  - 边界: 不改代码",
  ].join("\n");
  const fx = setupChange(tasks);
  try {
    writeFileSync(join(fx.projectRoot, "openspec", "config.yaml"), "schema: spec-driven\n");
    const profile = planningValidationProfileForNewRound(fx.projectRoot);
    appendEvent(fx.projectRoot, fx.change, makeEvent(fx.change, "transition_commit", {
      transition: "propose-ready",
      from_state: "propose_ready",
      to_state: "propose_ready",
      outcome: "advanced",
      created_job_ids: [],
      reason: "seed v2 strict profile",
      execution_requirement_version: 2,
      planning_validation_version: 2,
      planning_validation_profile: profile,
    }, { transitionId: "T-v2-strict-ready", idempotencyKey: "v2-strict-ready" }));
    writeFileSync(join(fx.projectRoot, "openspec", "config.yaml"), "schema: spec-driven\nchanged: true\n");

    const result = startApply(fx.projectRoot, fx.change, fx.changeRoot);
    assert.match(result.message, /配置自本 planning round 起已变化.*reopen --to propose/);
  } finally {
    fx.cleanup();
  }
});

test("过渡期 v2 event：只有执行版本时保留 v2 tasks gate，但不追溯 strict gate", () => {
  const tasks = [
    "# Tasks",
    "",
    "- [ ] TASK-001 Document behavior",
    "  执行依据:",
    "  - 测试:",
    "  - 设计: design.md#Design",
    "  - 来源: proposal.md#Proposal",
    "  - 验收: 文档可阅读",
    "  - 边界: 不改代码",
  ].join("\n");
  const fx = setupChange(tasks);
  try {
    writeFileSync(join(fx.projectRoot, "openspec", "config.yaml"), "schema: spec-driven\n");
    appendEvent(fx.projectRoot, fx.change, makeEvent(fx.change, "transition_commit", {
      transition: "propose-ready",
      from_state: "propose_ready",
      to_state: "propose_ready",
      outcome: "advanced",
      created_job_ids: [],
      reason: "seed transitional v2 event",
      execution_requirement_version: 2,
    }, { transitionId: "T-v2-transitional-ready", idempotencyKey: "v2-transitional-ready" }));

    const result = startApply(fx.projectRoot, fx.change, fx.changeRoot);
    assert.doesNotMatch(result.message, /Impact|OpenSpec strict|配置自本 planning round 起已变化/);
  } finally {
    fx.cleanup();
  }
});

test("执行依据锚点：描述性锚点必须是精确标题，ID 不能匹配更长的子串", () => {
  const routeTasks = [
    "# Tasks",
    "",
    "- [ ] TASK-001 Route reference",
    "  执行依据:",
    "  - 测试:",
    "  - 设计: design.md#Route",
    "  - 来源: proposal.md#Impact",
    "  - 验收: 引用可定位",
    "  - 边界: 不改代码",
  ].join("\n");
  const routeFx = setupChange(routeTasks);
  try {
    writeFileSync(join(routeFx.changeRoot, "design.md"), "# Design\n\nRoute appears in ordinary text.\n");
    writeFileSync(join(routeFx.changeRoot, "proposal.md"), "# Proposal\n\n## Impact\n");
    assert.deepEqual(
      validateExecutionRequirementDocumentReferences(routeFx.changeRoot, parseExecutionRequirements(routeTasks)),
      ["TASK-001 的引用锚点不存在：design.md#Route"],
    );
    writeFileSync(join(routeFx.changeRoot, "design.md"), "# Design\n\n## Route ##\n");
    assert.deepEqual(
      validateExecutionRequirementDocumentReferences(routeFx.changeRoot, parseExecutionRequirements(routeTasks)),
      [],
    );
  } finally {
    routeFx.cleanup();
  }

  const idTasks = routeTasks.replace("design.md#Route", "design.md#Design").replace("proposal.md#Impact", "discovery.md#CHAIN-001");
  const idFx = setupChange(idTasks);
  try {
    writeFileSync(join(idFx.changeRoot, "design.md"), "# Design\n");
    writeFileSync(join(idFx.changeRoot, ".superspec", "artifacts", "discovery.md"), "# Discovery\n\nCHAIN-0012\n");
    assert.deepEqual(
      validateExecutionRequirementDocumentReferences(idFx.changeRoot, parseExecutionRequirements(idTasks)),
      ["TASK-001 的引用锚点不存在：discovery.md#CHAIN-001"],
    );
  } finally {
    idFx.cleanup();
  }
});

test("执行依据引用：符号链接解析到 change 外部时必须拒绝", (t) => {
  if (process.platform === "win32") {
    t.skip("Windows 创建文件符号链接可能需要管理员权限");
    return;
  }
  const tasks = [
    "# Tasks",
    "",
    "- [ ] TASK-001 External link",
    "  执行依据:",
    "  - 测试:",
    "  - 设计: design.md#Route",
    "  - 来源: proposal.md#Proposal",
    "  - 验收: 引用属于当前 change",
    "  - 边界: 不改代码",
  ].join("\n");
  const fx = setupChange(tasks);
  const external = join(fx.projectRoot, "external-design.md");
  try {
    writeFileSync(external, "# External\n\n## Route\n");
    rmSync(join(fx.changeRoot, "design.md"));
    symlinkSync(external, join(fx.changeRoot, "design.md"));
    assert.deepEqual(
      validateExecutionRequirementDocumentReferences(fx.changeRoot, parseExecutionRequirements(tasks)),
      ["TASK-001 的引用越出 change 目录：design.md#Route"],
    );
  } finally {
    fx.cleanup();
  }
});

test("test-contract：表格行缺少 test_id 不得被静默跳过", () => {
  const parsed = parseTestContractEntries([
    "# Test Contract",
    "",
    "| test_id | scenario |",
    "|---|---|",
    "|  | still has a scenario |",
  ].join("\n"));
  assert.equal(parsed.ok, false);
  if (!parsed.ok) assert.match(parsed.message, /第 5 行缺少 test_id/);
});

test("OpenSpec strict：合法 delta 通过，缺 Scenario 的 delta 失败", (t) => {
  if (spawnSync("openspec", ["--version"], { stdio: "ignore" }).status !== 0) {
    t.skip("openspec CLI 不可用");
    return;
  }

  const projectRoot = mkdtempSync(join(tmpdir(), "superspec-openspec-strict-"));
  const change = "valid-fixture";
  const specPath = join(projectRoot, "openspec", "changes", change, "specs", "sample-capability", "spec.md");
  try {
    mkdirSync(join(projectRoot, "openspec"), { recursive: true });
    mkdirSync(join(projectRoot, "openspec", "changes", change, "specs", "sample-capability"), { recursive: true });
    writeFileSync(join(projectRoot, "openspec", "config.yaml"), "schema: spec-driven\n");
    writeFileSync(specPath, [
      "## ADDED Requirements",
      "",
      "### Requirement: Sample behavior",
      "The system SHALL expose the sample behavior.",
      "",
      "#### Scenario: Successful use",
      "- **WHEN** a valid request arrives",
      "- **THEN** the behavior completes",
    ].join("\n"));

    assert.deepEqual(validateOpenSpecChange(projectRoot, change), {
      checked: true,
      ok: true,
      message: "OpenSpec 原生结构校验通过",
    });

    writeFileSync(specPath, [
      "## ADDED Requirements",
      "",
      "### Requirement: Sample behavior",
      "The system SHALL expose the sample behavior.",
    ].join("\n"));
    const invalid = validateOpenSpecChange(projectRoot, change);
    assert.equal(invalid.checked, true);
    assert.equal(invalid.ok, false);
    assert.match(invalid.message, /OpenSpec strict 校验失败/);
  } finally {
    rmSync(projectRoot, { recursive: true, force: true });
  }
});

test("执行依据模式：task-start 输出契约，test-run 不要求 task_structure_digest，tasks.md 编辑不使 attempt 失效", () => {
  const fx = setupChange([
    "# Tasks",
    "",
    "- [ ] TASK-001 Implement behavior tdd_required:true",
    "  执行依据:",
    "  - 测试: test-contract.md#TEST-001",
    "  - 设计: design.md#Route",
    "  - 来源: proposal.md#Impact",
    "  - 原因: 独立验收行为",
    "  - 边界: 不改持久化",
    "",
  ].join("\n"), [
    "# Test Contract",
    "",
    "| test_id | scenario |",
    "|---|---|",
    "| TEST-001 | behavior works |",
    "",
  ].join("\n"));
  try {
    const startedApply = startApplyConfirmed(fx.projectRoot, fx.change, fx.changeRoot);
    assert.equal(startedApply.to_state, "apply");
    const startCommit = readEvents(fx.projectRoot, fx.change).findLast(ev =>
      ev.event_type === "transition_commit" && (ev.payload as { transition?: unknown }).transition === "start-apply"
    );
    assert.equal((startCommit?.payload as { apply_contract_mode?: unknown }).apply_contract_mode, true);
    assert.equal((startCommit?.payload as { execution_policy?: unknown }).execution_policy, "tdd");

    const started = taskStart(fx.projectRoot, fx.change, fx.changeRoot, "TASK-001");
    assert.deepEqual(started.details?.contract, {
      tests: ["TEST-001"],
      design: "design.md#Route",
      source: ["proposal.md#Impact"],
      acceptance: "独立验收行为",
      guard: "不改持久化",
    });
    assert.equal(started.details?.execution_policy, "tdd");
    assert.deepEqual(started.details?.required_evidence, {
      test_ids: ["TEST-001"],
      red_required: true,
      green_required: true,
      accepted_green_statuses: ["expected_success"],
    });
    const attemptId = started.details?.attempt_id;
    assert.equal(typeof attemptId, "string");

    assert.equal(recordTestRunContent(fx.projectRoot, fx.change, JSON.stringify({
      test_id: "TEST-001",
      task_structure_digest: "sha256:legacy",
      command: "npm test",
      cwd: fx.projectRoot,
      exit_code: 1,
      semantic_status: "expected_failure",
    })).accepted, false);
    assert.equal(recordTestRunContent(fx.projectRoot, fx.change, JSON.stringify({
      test_id: "TEST-001",
      attempt_id: "ATT-missing",
      task_structure_digest: "sha256:legacy",
      command: "npm test",
      cwd: fx.projectRoot,
      exit_code: 1,
      semantic_status: "expected_failure",
    })).accepted, false);

    assert.equal(recordTestRunContent(fx.projectRoot, fx.change, JSON.stringify({
      test_id: "TEST-001",
      attempt_id: attemptId,
      command: "npm test",
      cwd: fx.projectRoot,
      exit_code: 1,
      semantic_status: "expected_failure",
    })).accepted, true);
    assert.equal(recordTestRunContent(fx.projectRoot, fx.change, JSON.stringify({
      test_id: "TEST-001",
      attempt_id: attemptId,
      command: "npm test",
      cwd: fx.projectRoot,
      exit_code: 0,
      semantic_status: "expected_success",
    })).accepted, true);

    writeFileSync(join(fx.changeRoot, "tasks.md"), readFileSync(join(fx.changeRoot, "tasks.md"), "utf8").replace("Implement behavior", "Implement behavior with edited wording"));
    const completed = taskComplete(fx.projectRoot, fx.change, fx.changeRoot, "TASK-001");
    assert.equal(completed.outcome, "advanced");
    assert.equal(completed.events_written, 2);

    const eventCountAfterComplete = readEvents(fx.projectRoot, fx.change).length;
    const lateEvidence = recordTestRunContent(fx.projectRoot, fx.change, JSON.stringify({
      test_id: "TEST-001",
      attempt_id: attemptId,
      task_structure_digest: "sha256:legacy",
      command: "npm test",
      cwd: fx.projectRoot,
      exit_code: 0,
      semantic_status: "expected_success",
    }));
    assert.equal(lateEvidence.accepted, false);
    assert.match(lateEvidence.message, /当前活跃任务尝试/);
    assert.equal(readEvents(fx.projectRoot, fx.change).length, eventCountAfterComplete);
  } finally {
    fx.cleanup();
  }
});

test("normal/minimal：冻结 GREEN-only 策略，只要求声明 TEST 的 GREEN", () => {
  const tasks = [
    "# Tasks",
    "",
    "- [ ] TASK-001 Implement behavior",
    "  执行依据:",
    "  - 测试: test-contract.md#TEST-001",
    "  - 设计: design.md#Route",
    "  - 来源: proposal.md#Impact",
    "  - 原因: normal/minimal 测试后置",
    "  - 边界: 不改持久化",
    "",
  ].join("\n");
  const testContract = [
    "# Test Contract",
    "",
    "| test_id | scenario |",
    "|---|---|",
    "| TEST-001 | behavior works |",
    "",
  ].join("\n");

  for (const risk of ["normal", "minimal"] as const) {
    const fx = setupChange(tasks, testContract, risk);
    try {
      const startedApply = startApplyConfirmed(fx.projectRoot, fx.change, fx.changeRoot, risk);
      assert.equal(startedApply.to_state, "apply");
      const startCommit = readEvents(fx.projectRoot, fx.change).findLast(event =>
        event.event_type === "transition_commit" &&
        (event.payload as { transition?: unknown }).transition === "start-apply"
      );
      assert.equal((startCommit?.payload as { execution_policy?: unknown }).execution_policy, "green_only");

      const started = taskStart(fx.projectRoot, fx.change, fx.changeRoot, "TASK-001");
      const attemptId = started.details?.attempt_id;
      assert.equal(typeof attemptId, "string");
      assert.equal(started.details?.execution_policy, "green_only");
      assert.equal(recordTestRunContent(fx.projectRoot, fx.change, JSON.stringify({
        test_id: "TEST-001",
        attempt_id: attemptId,
        command: "npm test",
        cwd: fx.projectRoot,
        exit_code: 1,
        semantic_status: "expected_failure",
      })).accepted, false);
      const missingGreen = taskComplete(fx.projectRoot, fx.change, fx.changeRoot, "TASK-001");
      assert.equal(missingGreen.events_written, 0);
      assert.match(missingGreen.message, /TEST-001 GREEN 证据/);
      assert.equal(recordTestRunContent(fx.projectRoot, fx.change, JSON.stringify({
        test_id: "TEST-001",
        attempt_id: attemptId,
        command: "npm test",
        cwd: fx.projectRoot,
        exit_code: 0,
        semantic_status: "expected_success",
      })).accepted, true);
      assert.equal(taskComplete(fx.projectRoot, fx.change, fx.changeRoot, "TASK-001").outcome, "advanced");
      const completion = readEvents(fx.projectRoot, fx.change).findLast(event => event.event_type === "task_completed");
      assert.equal((completion?.payload as { execution_policy?: unknown }).execution_policy, "green_only");
      const reviewContext = codeReviewPacketContext(fx.changeRoot, fx.projectRoot, {
        base_head: null,
        current_head: null,
        scope_reliable: false,
        scope_reason: "test",
        committed_paths: null,
        worktree_paths: [],
        untracked_paths: [],
        review_paths: [],
      }, readEvents(fx.projectRoot, fx.change));
      assert.equal(reviewContext.task_execution_index?.[0].execution_policy, "green_only");
    } finally {
      fx.cleanup();
    }
  }
});

test("执行依据不携带模式：新契约轮缺少契约仍阻断，模式由 task-start 编译", () => {
  const missingContract = [
    "# Tasks",
    "",
    "- [ ] TASK-001 Missing contract",
    "- [ ] TASK-002 Declares the round",
    "  执行依据:",
    "  - 测试: test-contract.md#TEST-001",
    "  - 设计: design.md#Route",
    "  - 来源: proposal.md#Impact",
    "  - 原因: 使本轮进入执行依据模式",
    "  - 边界: 不改持久化",
    "",
  ].join("\n");
  const testContract = "# Test Contract\n\n| test_id | scenario |\n|---|---|\n| TEST-001 | behavior works |\n";

  const normalFx = setupProposeChange(missingContract, testContract);
  try {
    const blocked = proposeReady(normalFx.projectRoot, normalFx.change, normalFx.changeRoot, "normal");
    assert.equal(blocked.events_written, 0);
    assert.match(blocked.message, /缺少执行依据/);
  } finally {
    normalFx.cleanup();
  }

  const missingTest = setupProposeChange([
    "# Tasks",
    "",
    "- [ ] TASK-001 Missing TEST",
    "  执行依据:",
    "  - 设计: design.md#Route",
    "  - 来源: proposal.md#Impact",
    "  - 原因: no test is invalid",
    "  - 边界: no persistence",
    "",
  ].join("\n"), testContract);
  try {
    const blocked = proposeReady(missingTest.projectRoot, missingTest.change, missingTest.changeRoot, "normal");
    assert.equal(blocked.events_written, 0);
    assert.match(blocked.message, /缺少测试字段/);
  } finally {
    missingTest.cleanup();
  }

  const legacyInvalidGreenOnly = setupProposeChange([
    "# Tasks",
    "",
    "- [ ] TASK-001 Wrong TDD flag no_tdd_reason:green-only",
    "  执行依据:",
    "  - 测试: test-contract.md#TEST-001",
    "  - 设计: design.md#Route",
    "  - 来源: proposal.md#Impact",
    "  - 原因: the flag is required",
    "  - 边界: no persistence",
    "",
  ].join("\n"), testContract);
  try {
    const blocked = proposeReady(legacyInvalidGreenOnly.projectRoot, legacyInvalidGreenOnly.change, legacyInvalidGreenOnly.changeRoot, "normal");
    assert.equal(blocked.events_written, 0);
    assert.match(blocked.message, /必须同时声明 tdd_required:false/);
  } finally {
    legacyInvalidGreenOnly.cleanup();
  }

  const strictFx = setupProposeChange([
    "# Tasks",
    "",
    "- [ ] TASK-001 Green only tdd_required:false no_tdd_reason:green-only",
    "  执行依据:",
    "  - 测试: test-contract.md#TEST-001",
    "  - 设计: design.md#Route",
    "  - 来源: proposal.md#Impact",
    "  - 原因: should be rejected in strict",
    "  - 边界: no persistence",
    "",
  ].join("\n"), testContract);
  try {
    const blocked = proposeReady(strictFx.projectRoot, strictFx.change, strictFx.changeRoot, "strict");
    assert.equal(blocked.events_written, 0);
    assert.match(blocked.message, /只允许用于 GREEN-only apply/);
  } finally {
    strictFx.cleanup();
  }
});

test("normal/minimal 的普通 task 与审查修复都由 task-start 编译为 GREEN-only", () => {
  const ordinaryTdd = [
    "# Tasks",
    "",
    "- [ ] TASK-001 Ordinary TDD tdd_required:true",
    "  执行依据:",
    "  - 测试: test-contract.md#TEST-001",
    "  - 设计: design.md#Route",
    "  - 来源: proposal.md#Impact",
    "  - 原因: 由 task-start 决定证据口径",
    "  - 边界: 不改持久化",
    "",
  ].join("\n");
  const testContract = "# Test Contract\n\n| test_id | scenario |\n|---|---|\n| TEST-001 | behavior works |\n";
  const proposeFx = setupProposeChange(ordinaryTdd, testContract);
  try {
    const advanced = proposeReady(proposeFx.projectRoot, proposeFx.change, proposeFx.changeRoot, "minimal");
    assert.equal(advanced.to_state, "propose_ready");
  } finally {
    proposeFx.cleanup();
  }

  const applyFx = setupChange(ordinaryTdd, testContract, "normal");
  try {
    assert.equal(startApplyConfirmed(applyFx.projectRoot, applyFx.change, applyFx.changeRoot, "normal").to_state, "apply");
    const started = taskStart(applyFx.projectRoot, applyFx.change, applyFx.changeRoot, "TASK-001");
    assert.deepEqual(started.details?.required_evidence, {
      test_ids: ["TEST-001"],
      red_required: false,
      green_required: true,
      accepted_green_statuses: ["expected_success"],
    });
  } finally {
    applyFx.cleanup();
  }

  const reviewFixFx = setupChange([
    "# Tasks",
    "",
    "- [x] TASK-001 Document-only prerequisite tdd_required:false no_tdd_reason:documentation-only",
    "  执行依据:",
    "  - 测试: test-contract.md#TEST-001",
    "  - 设计: design.md#Route",
    "  - 来源: proposal.md#Impact",
    "  - 原因: establish contract mode",
    "  - 边界: no persistence",
    "",
  ].join("\n"), testContract, "normal");
  try {
    assert.equal(startApplyConfirmed(reviewFixFx.projectRoot, reviewFixFx.change, reviewFixFx.changeRoot, "normal").to_state, "apply");
    writeFileSync(join(reviewFixFx.changeRoot, "tasks.md"), readFileSync(join(reviewFixFx.changeRoot, "tasks.md"), "utf8") +
      "- [ ] REVIEW-FIX-JOB-1#F1 Repair review issue review_fix_of:JOB-1#F1\n");
    const started = taskStart(reviewFixFx.projectRoot, reviewFixFx.change, reviewFixFx.changeRoot, "REVIEW-FIX-JOB-1#F1");
    const attemptId = String(started.details?.attempt_id);
    assert.equal(started.details?.execution_policy, "green_only");
    assert.deepEqual(started.details?.required_evidence, {
      test_ids: [],
      red_required: false,
      green_required: true,
      accepted_green_statuses: ["expected_success"],
    });
    assert.equal(recordTestRunContent(reviewFixFx.projectRoot, reviewFixFx.change, JSON.stringify({
      test_id: "TEST-REPAIR",
      attempt_id: attemptId,
      command: "npm test -- review-fix",
      cwd: reviewFixFx.projectRoot,
      exit_code: 1,
      semantic_status: "expected_failure",
    })).accepted, false);
    assert.equal(recordTestRunContent(reviewFixFx.projectRoot, reviewFixFx.change, JSON.stringify({
      test_id: "TEST-REPAIR",
      attempt_id: attemptId,
      command: "npm test -- review-fix",
      cwd: reviewFixFx.projectRoot,
      exit_code: 0,
      semantic_status: "expected_success",
    })).accepted, true);
    assert.equal(taskComplete(reviewFixFx.projectRoot, reviewFixFx.change, reviewFixFx.changeRoot, "REVIEW-FIX-JOB-1#F1").outcome, "advanced");
    const completion = readEvents(reviewFixFx.projectRoot, reviewFixFx.change).findLast(event => event.event_type === "task_completed");
    assert.equal((completion?.payload as { execution_policy?: unknown }).execution_policy, "green_only");
    const reviewContext = codeReviewPacketContext(reviewFixFx.changeRoot, reviewFixFx.projectRoot, {
      base_head: null,
      current_head: null,
      scope_reliable: false,
      scope_reason: "test",
      committed_paths: null,
      worktree_paths: [],
      untracked_paths: [],
      review_paths: [],
    }, readEvents(reviewFixFx.projectRoot, reviewFixFx.change));
    assert.equal(reviewContext.task_execution_index?.[0].execution_policy, "green_only");
  } finally {
    reviewFixFx.cleanup();
  }
});

test("propose_to_apply 确认范围绑定 review risk，不能改写冻结策略", () => {
  const fx = setupChange([
    "# Tasks",
    "",
    "- [ ] TASK-001 Implement behavior tdd_required:false no_tdd_reason:green-only",
    "  执行依据:",
    "  - 测试: test-contract.md#TEST-001",
    "  - 设计: design.md#Route",
    "  - 来源: proposal.md#Impact",
    "  - 原因: normal policy",
    "  - 边界: no persistence",
    "",
  ].join("\n"), [
    "# Test Contract",
    "",
    "| test_id | scenario |",
    "|---|---|",
    "| TEST-001 | behavior works |",
    "",
  ].join("\n"), "normal");
  try {
    writeFileSync(join(fx.projectRoot, ".superspec", "config.json"), JSON.stringify({ workflow: { mode: "normal" } }));
    const ask = next(fx.projectRoot, fx.change, fx.changeRoot, "normal");
    assert.equal(ask.path, "ask_user");
    const action = (ask.ask_user.actions as Array<PhaseDecisionAction>).find(item => item.decision === "advance");
    assert.ok(action);
    const forged = {
      ...action.record_input,
      review_risk: "strict",
    };
    const accepted = recordUserDecisionContent(fx.projectRoot, fx.change, JSON.stringify(forged));
    assert.equal(accepted.accepted, true);
    const decision = readEvents(fx.projectRoot, fx.change).findLast(event => event.event_type === "user_decision_recorded");
    assert.equal((decision?.payload as { phase_confirmation?: { review_risk?: unknown } }).phase_confirmation?.review_risk, "normal");

    const started = startApply(fx.projectRoot, fx.change, fx.changeRoot);
    assert.equal(started.to_state, "apply");
    const commit = readEvents(fx.projectRoot, fx.change).findLast(event =>
      event.event_type === "transition_commit" &&
      (event.payload as { transition?: unknown }).transition === "start-apply"
    );
    assert.equal((commit?.payload as { execution_policy?: unknown }).execution_policy, "green_only");
  } finally {
    fx.cleanup();
  }
});

test("执行依据模式：同一 apply 轮后续活跃 attempt 不会被较早完成记录遮蔽", () => {
  const fx = setupChange([
    "# Tasks",
    "",
    "- [x] TASK-001 Implement behavior tdd_required:true",
    "  执行依据:",
    "  - 测试: test-contract.md#TEST-001",
    "  - 设计: design.md#Route",
    "  - 来源: proposal.md#Impact",
    "  - 原因: 独立验收行为",
    "  - 边界: 不改持久化",
    "",
  ].join("\n"), [
    "# Test Contract",
    "",
    "| test_id | scenario |",
    "|---|---|",
    "| TEST-001 | behavior works |",
    "",
  ].join("\n"));
  try {
    assert.equal(startApplyConfirmed(fx.projectRoot, fx.change, fx.changeRoot).to_state, "apply");
    appendEvent(fx.projectRoot, fx.change, makeEvent(fx.change, "task_started", {
      task_id: "TASK-001",
      attempt_id: "ATT-old",
      task_structure_digest: "sha256:old",
      contract_mode: true,
    }));
    appendEvent(fx.projectRoot, fx.change, makeEvent(fx.change, "task_completed", {
      task_id: "TASK-001",
      attempt_id: "ATT-old",
    }));
    appendEvent(fx.projectRoot, fx.change, makeEvent(fx.change, "task_started", {
      task_id: "TASK-001",
      attempt_id: "ATT-new",
      task_structure_digest: "sha256:new",
      contract_mode: true,
    }));

    const status = pendingTaskStatusForApply(fx.changeRoot, readEvents(fx.projectRoot, fx.change));
    assert.equal(status.mode, "contract");
    assert.deepEqual(status.pending, ["TASK-001"]);
    assert.deepEqual(status.needsCompletionEvent, ["TASK-001"]);
    assert.deepEqual(status.completedByEvent, []);

    const blocked = reviewReady(fx.projectRoot, fx.change, fx.changeRoot);
    assert.equal(blocked.to_state, "apply");
    assert.match(blocked.message, /TASK-001/);
  } finally {
    fx.cleanup();
  }
});

test("历史 start-apply 缺 apply_start_head 时只审当前工作区，不把 HEAD 全树当 committed diff", () => {
  const fx = setupChange("# Tasks\n\n- [x] TASK-001 Done\n");
  try {
    initGitRepo(fx.projectRoot);
    mkdirSync(join(fx.projectRoot, "src"), { recursive: true });
    writeFileSync(join(fx.projectRoot, "src", "existing.ts"), "export const existing = 1;\n");
    execFileSync("git", ["add", "."], { cwd: fx.projectRoot, stdio: "ignore" });
    execFileSync("git", ["commit", "-m", "initial"], { cwd: fx.projectRoot, stdio: "ignore" });

    appendEvent(fx.projectRoot, fx.change, makeEvent(fx.change, "transition_commit", {
      transition: "start-apply",
      from_state: "propose_ready",
      to_state: "apply",
      outcome: "advanced",
      created_job_ids: [],
      reason: "legacy start apply",
    }, { transitionId: "T-legacy-start-apply", idempotencyKey: "legacy-start-apply" }));

    assert.equal(reviewReady(fx.projectRoot, fx.change, fx.changeRoot).to_state, "apply_done");
    confirmCurrentPhase(fx.projectRoot, fx.change, fx.changeRoot);
    const skipped = reviewReady(fx.projectRoot, fx.change, fx.changeRoot);
    assert.equal(skipped.outcome, "advanced");
    assert.equal(skipped.to_state, "review");
    const gate = (readEvents(fx.projectRoot, fx.change).findLast(ev =>
      ev.event_type === "transition_commit" && (ev.payload as { transition?: unknown }).transition === "review-ready"
    )?.payload as { code_review_gate?: { decision?: unknown } }).code_review_gate;
    assert.equal(gate?.decision, "skipped");
  } finally {
    fx.cleanup();
  }
});

test("boundary_snapshot：仓库尚无 commit 时保留 dirty_files 归属线索", () => {
  const fx = setupChange("# Tasks\n\n- [ ] TASK-001 Docs tdd_required:false no_tdd_reason:documentation-only\n");
  try {
    initGitRepo(fx.projectRoot);
    mkdirSync(join(fx.projectRoot, "src"), { recursive: true });
    writeFileSync(join(fx.projectRoot, "src", "a.ts"), "export const value = 1;\n");

    assert.equal(startApplyConfirmed(fx.projectRoot, fx.change, fx.changeRoot).to_state, "apply");
    assert.equal(taskStart(fx.projectRoot, fx.change, fx.changeRoot, "TASK-001").outcome, "advanced");
    const startedEvent = readEvents(fx.projectRoot, fx.change).findLast(ev => ev.event_type === "task_started");
    const boundary = (startedEvent?.payload as { boundary_snapshot?: unknown }).boundary_snapshot as {
      head?: unknown;
      head_reason?: unknown;
      dirty_files?: Array<{ path: string; status: string; sha256: string | null }>;
    };
    assert.equal(boundary.head, null);
    assert.equal(typeof boundary.head_reason, "string");
    assert.ok(boundary.dirty_files?.some(file => file.path === "src/a.ts" && file.status === "added"));
  } finally {
    fx.cleanup();
  }
});

test("执行依据模式：checkbox 已勾选但缺 task_completed 时 next 引导补 task-complete", () => {
  const fx = setupChange([
    "# Tasks",
    "",
    "- [ ] TASK-001 Documentation tdd_required:false no_tdd_reason:documentation-only",
    "  执行依据:",
    "  - 测试:",
    "  - 设计: design.md#Docs",
    "  - 来源: proposal.md#Docs",
    "  - 原因: 文档任务",
    "  - 边界: 不改代码",
    "",
  ].join("\n"));
  try {
    startApplyConfirmed(fx.projectRoot, fx.change, fx.changeRoot);
    const started = taskStart(fx.projectRoot, fx.change, fx.changeRoot, "TASK-001");
    assert.equal(started.outcome, "advanced");
    writeFileSync(join(fx.changeRoot, "tasks.md"), readFileSync(join(fx.changeRoot, "tasks.md"), "utf8").replace("- [ ] TASK-001", "- [x] TASK-001"));

    const planned = next(fx.projectRoot, fx.change, fx.changeRoot);
    assert.equal(planned.path, "next_command");
    assert.equal(planned.next_command, 'superspec transition task-complete --change "align-change" --task TASK-001');

    const completed = taskComplete(fx.projectRoot, fx.change, fx.changeRoot, "TASK-001");
    assert.equal(completed.outcome, "advanced");
    const event = readEvents(fx.projectRoot, fx.change).findLast(ev => ev.event_type === "task_completed");
    assert.deepEqual((event?.payload as { checkbox_update?: unknown }).checkbox_update, { status: "applied" });
  } finally {
    fx.cleanup();
  }
});

test("执行依据模式：task_completed 事件优先于 checkbox，已完成 task 不会重复启动", () => {
  const fx = setupChange([
    "# Tasks",
    "",
    "- [ ] TASK-001 Documentation tdd_required:false no_tdd_reason:documentation-only",
    "  执行依据:",
    "  - 测试:",
    "  - 设计: design.md#Docs",
    "  - 来源: proposal.md#Docs",
    "  - 原因: 文档任务",
    "  - 边界: 不改代码",
    "",
  ].join("\n"));
  try {
    startApplyConfirmed(fx.projectRoot, fx.change, fx.changeRoot);
    const started = taskStart(fx.projectRoot, fx.change, fx.changeRoot, "TASK-001");
    assert.equal(started.outcome, "advanced");

    const completed = taskComplete(fx.projectRoot, fx.change, fx.changeRoot, "TASK-001");
    assert.equal(completed.outcome, "advanced");
    writeFileSync(join(fx.changeRoot, "tasks.md"), readFileSync(join(fx.changeRoot, "tasks.md"), "utf8").replace("- [x] TASK-001", "- [ ] TASK-001"));

    const restart = taskStart(fx.projectRoot, fx.change, fx.changeRoot, "TASK-001");
    assert.equal(restart.events_written, 0);
    assert.match(restart.message, /已通过完成事件完成/);
  } finally {
    fx.cleanup();
  }
});

test("review-ready：apply 期间只有已提交代码变化且工作区干净时仍创建 code-reviewer", () => {
  const fx = setupChange("# Tasks\n\n- [x] TASK-001 Done\n");
  try {
    initGitRepo(fx.projectRoot);
    mkdirSync(join(fx.projectRoot, "src"), { recursive: true });
    writeFileSync(join(fx.projectRoot, "src", "a.ts"), "export const value = 1;\n");
    execFileSync("git", ["add", "."], { cwd: fx.projectRoot, stdio: "ignore" });
    execFileSync("git", ["commit", "-m", "initial"], { cwd: fx.projectRoot, stdio: "ignore" });

    startApplyConfirmed(fx.projectRoot, fx.change, fx.changeRoot);
    writeFileSync(join(fx.projectRoot, "src", "a.ts"), "export const value = 2;\n");
    execFileSync("git", ["add", "src/a.ts"], { cwd: fx.projectRoot, stdio: "ignore" });
    execFileSync("git", ["commit", "-m", "apply code"], { cwd: fx.projectRoot, stdio: "ignore" });

    assert.equal(reviewReady(fx.projectRoot, fx.change, fx.changeRoot).to_state, "apply_done");
    const created = reviewReady(fx.projectRoot, fx.change, fx.changeRoot);
    assert.equal(created.outcome, "job_created");
    const packet = jobsPacket(fx.projectRoot, fx.change, created.created_jobs[0]);
    assert.deepEqual(packet.packet?.code_review_scope?.committed_paths, ["src/a.ts"]);
    assert.deepEqual(packet.packet?.code_review_scope?.worktree_paths, []);
    assert.deepEqual(packet.packet?.code_review_scope?.untracked_paths, []);
  } finally {
    fx.cleanup();
  }
});

test("code-reviewer packet：按 task 展示 changed_paths、test_evidence 和 coverage exemption", () => {
  const fx = setupChange([
    "# Tasks",
    "",
    "- [ ] TASK-001 Implement behavior tdd_required:true",
    "  执行依据:",
    "  - 测试: test-contract.md#TEST-001",
    "  - 设计: design.md#Route",
    "  - 来源: proposal.md#Impact",
    "  - 原因: 独立验收行为",
    "  - 边界: 不改持久化",
    "",
  ].join("\n"), [
    "# Test Contract",
    "",
    "| test_id | scenario |",
    "|---|---|",
    "| TEST-001 | behavior works |",
    "| TEST-002 | separate path is intentionally covered elsewhere |",
    "",
  ].join("\n"));
  try {
    initGitRepo(fx.projectRoot);
    execFileSync("git", ["add", "."], { cwd: fx.projectRoot, stdio: "ignore" });
    execFileSync("git", ["commit", "-m", "initial"], { cwd: fx.projectRoot, stdio: "ignore" });

    startApplyConfirmed(fx.projectRoot, fx.change, fx.changeRoot);
    const started = taskStart(fx.projectRoot, fx.change, fx.changeRoot, "TASK-001");
    const attemptId = String(started.details?.attempt_id);
    mkdirSync(join(fx.projectRoot, "src"), { recursive: true });
    writeFileSync(join(fx.projectRoot, "src", "a.ts"), "export const value = 1;\n");
    assert.equal(recordTestRunContent(fx.projectRoot, fx.change, JSON.stringify({
      test_id: "TEST-001",
      attempt_id: attemptId,
      command: "npm test",
      cwd: fx.projectRoot,
      exit_code: 1,
      semantic_status: "expected_failure",
    })).accepted, true);
    assert.equal(recordTestRunContent(fx.projectRoot, fx.change, JSON.stringify({
      test_id: "TEST-001",
      attempt_id: attemptId,
      command: "npm test",
      cwd: fx.projectRoot,
      exit_code: 0,
      semantic_status: "expected_success",
    })).accepted, true);
    assert.equal(taskComplete(fx.projectRoot, fx.change, fx.changeRoot, "TASK-001").outcome, "advanced");

    const blocked = reviewReady(fx.projectRoot, fx.change, fx.changeRoot);
    assert.match(blocked.message, /TEST-002/);
    assert.equal(blocked.events_written, 0);

    assert.equal(recordUserDecisionContent(fx.projectRoot, fx.change, JSON.stringify({
      scope: "test_coverage_exemption:TEST-002",
      question: "TEST-002 为什么不绑定 task？",
      answer: "TEST-001 覆盖同一验收路径，本 change 不单独实现",
    })).accepted, true);

    assert.equal(reviewReady(fx.projectRoot, fx.change, fx.changeRoot).to_state, "apply_done");
    const created = reviewReady(fx.projectRoot, fx.change, fx.changeRoot);
    assert.equal(created.outcome, "job_created");
    const packet = jobsPacket(fx.projectRoot, fx.change, created.created_jobs[0]).packet;
    assert.deepEqual(packet?.coverage_exemption_refs?.map(ref => ref.test_id), ["TEST-002"]);
    assert.deepEqual(packet?.unattributed_paths, []);
    assert.deepEqual(packet?.unknown_attribution_tasks, []);
    assert.equal(packet?.task_execution_index?.length, 1);
    assert.deepEqual(packet?.task_execution_index?.[0].changed_paths, ["src/a.ts"]);
    assert.equal(packet?.task_execution_index?.[0].test_evidence.length, 1);
    assert.equal(packet?.task_execution_index?.[0].test_evidence[0].test_id, "TEST-001");
    assert.equal(typeof packet?.task_execution_index?.[0].test_evidence[0].red_event_ref, "string");
    assert.equal(typeof packet?.task_execution_index?.[0].test_evidence[0].green_event_ref, "string");
  } finally {
    fx.cleanup();
  }
});

test("执行依据模式：task-start 拒绝 apply 期间被改坏的执行依据", () => {
  const fx = setupChange([
    "# Tasks",
    "",
    "- [ ] TASK-001 Implement behavior tdd_required:true",
    "  执行依据:",
    "  - 测试: test-contract.md#TEST-001",
    "  - 设计: design.md#Route",
    "  - 来源: proposal.md#Impact",
    "  - 原因: 独立验收行为",
    "  - 边界: 不改持久化",
    "",
  ].join("\n"), [
    "# Test Contract",
    "",
    "| test_id | scenario |",
    "|---|---|",
    "| TEST-001 | behavior works |",
    "",
  ].join("\n"));
  try {
    assert.equal(startApplyConfirmed(fx.projectRoot, fx.change, fx.changeRoot).to_state, "apply");
    writeFileSync(join(fx.changeRoot, "tasks.md"), [
      "# Tasks",
      "",
      "- [ ] TASK-001 Implement behavior tdd_required:true",
      "  执行依据:",
      "  - 测试: test-contract.md#TEST-001",
      "  - 测试: test-contract.md#TEST-999",
      "  - 设计: design.md#Route",
      "  - 来源: proposal.md#Impact",
      "  - 原因: 独立验收行为",
      "  - 边界: 不改持久化",
      "",
    ].join("\n"));
    const started = taskStart(fx.projectRoot, fx.change, fx.changeRoot, "TASK-001");
    assert.equal(started.events_written, 0);
    assert.match(started.message, /字段重复|不存在的 TEST/);
  } finally {
    fx.cleanup();
  }
});

test("执行依据模式：REVIEW-FIX task 没有执行依据时仍要求回归 RED/GREEN 证据", () => {
  const fx = setupChange([
    "# Tasks",
    "",
    "- [x] TASK-001 Existing task tdd_required:true",
    "  执行依据:",
    "  - 测试: test-contract.md#TEST-001",
    "  - 设计: design.md#Route",
    "  - 来源: proposal.md#Impact",
    "  - 原因: 已完成任务",
    "  - 边界: 不改持久化",
    "",
    "- [ ] REVIEW-FIX-JOB-1#F1 Fix review issue tdd_required:true review_fix_of:JOB-1#F1",
    "",
  ].join("\n"), [
    "# Test Contract",
    "",
    "| test_id | scenario |",
    "|---|---|",
    "| TEST-001 | behavior works |",
    "",
  ].join("\n"));
  try {
    assert.equal(startApplyConfirmed(fx.projectRoot, fx.change, fx.changeRoot).to_state, "apply");
    const started = taskStart(fx.projectRoot, fx.change, fx.changeRoot, "REVIEW-FIX-JOB-1#F1");
    const attemptId = String(started.details?.attempt_id);
    const blocked = taskComplete(fx.projectRoot, fx.change, fx.changeRoot, "REVIEW-FIX-JOB-1#F1");
    assert.match(blocked.message, /RED 证据/);

    assert.equal(recordTestRunContent(fx.projectRoot, fx.change, JSON.stringify({
      test_id: "TEST-REPAIR",
      attempt_id: attemptId,
      command: "npm test -- review-fix",
      cwd: fx.projectRoot,
      exit_code: 1,
      semantic_status: "expected_failure",
    })).accepted, true);
    assert.equal(recordTestRunContent(fx.projectRoot, fx.change, JSON.stringify({
      test_id: "TEST-REPAIR",
      attempt_id: attemptId,
      command: "npm test -- review-fix",
      cwd: fx.projectRoot,
      exit_code: 0,
      semantic_status: "expected_success",
    })).accepted, true);
    assert.equal(taskComplete(fx.projectRoot, fx.change, fx.changeRoot, "REVIEW-FIX-JOB-1#F1").outcome, "advanced");
  } finally {
    fx.cleanup();
  }
});

test("指纹原语：diffFingerprints 按 path/status/sha256 对比并按路径字典序输出", () => {
  const left = [
    { path: "src/b.ts", status: "modified" as const, sha256: "sha256:1" },
    { path: "src/a.ts", status: "modified" as const, sha256: "sha256:2" },
    { path: "src/gone.ts", status: "modified" as const, sha256: "sha256:3" },
    { path: "src/same.ts", status: "added" as const, sha256: "sha256:4" },
  ];
  const right = [
    { path: "src/a.ts", status: "modified" as const, sha256: "sha256:2" },
    { path: "src/b.ts", status: "modified" as const, sha256: "sha256:changed" },
    { path: "src/new.ts", status: "added" as const, sha256: "sha256:5" },
    { path: "src/same.ts", status: "deleted" as const, sha256: null },
  ];
  // b.ts 内容变化、gone.ts 消失、new.ts 新增、same.ts status 变化；a.ts 完全一致不算变化
  assert.deepEqual(diffFingerprints(left, right), ["src/b.ts", "src/gone.ts", "src/new.ts", "src/same.ts"]);
  assert.deepEqual(diffFingerprints(left, left), []);
});

function makeAttemptWindowEvents(change: string, startHead: string | null, completeHead: string | null): Event[] {
  return [
    makeEvent(change, "task_started", {
      task_id: "TASK-001",
      attempt_id: "ATT-1",
      contract: { tests: [], design: null, source: [], reason: null, guard: null },
      boundary_snapshot: {
        head: startHead,
        dirty_files: [{ path: "src/dirty.ts", status: "modified", sha256: "sha256:before" }],
      },
    }, { transitionId: "T-ts", idempotencyKey: "ts-key" }),
    makeEvent(change, "task_completed", {
      task_id: "TASK-001",
      attempt_id: "ATT-1",
      boundary_snapshot: {
        head: completeHead,
        dirty_files: [{ path: "src/dirty.ts", status: "modified", sha256: "sha256:after" }],
      },
    }, { transitionId: "T-tc", idempotencyKey: "tc-key" }),
  ] as Event[];
}

test("changed_paths：committed 段 diff 失败时保留 dirty 对比结果并进入 unknown_attribution_tasks", () => {
  const fx = setupChange("# Tasks\n\n- [ ] TASK-001 Implement tdd_required:true\n");
  try {
    initGitRepo(fx.projectRoot);
    writeFileSync(join(fx.projectRoot, "keep.ts"), "export const keep = 1;\n");
    execFileSync("git", ["add", "."], { cwd: fx.projectRoot, stdio: "ignore" });
    execFileSync("git", ["commit", "-m", "initial"], { cwd: fx.projectRoot, stdio: "ignore" });

    // 两端 head 为不存在的 commit，git diff 必然失败
    const events = makeAttemptWindowEvents(fx.change, "0".repeat(40), "1".repeat(40));
    const scope = {
      base_head: null,
      current_head: null,
      scope_reliable: true,
      scope_reason: "ok",
      committed_paths: [],
      worktree_paths: ["src/dirty.ts", "src/other.ts"],
      untracked_paths: [],
      review_paths: ["src/dirty.ts", "src/other.ts"],
    };
    const context = codeReviewPacketContext(fx.changeRoot, fx.projectRoot, scope, events);
    const entry = context.task_execution_index?.[0];
    // dirty 侧的确定事实保留，不因 diff 失败整项置 null
    assert.deepEqual(entry?.changed_paths, ["src/dirty.ts"]);
    assert.match(String(entry?.changed_paths_partial_reason), /git diff/);
    // 归属不完整的 task 进入 unknown_attribution_tasks，dirty 侧归属仍然生效
    assert.deepEqual(context.unknown_attribution_tasks, ["TASK-001"]);
    assert.deepEqual(context.unattributed_paths, ["src/other.ts"]);
  } finally {
    fx.cleanup();
  }
});

test("changed_paths：committed 段 diff 只收代码文件，非代码文件不进入归属", () => {
  const fx = setupChange("# Tasks\n\n- [ ] TASK-001 Implement tdd_required:true\n");
  try {
    initGitRepo(fx.projectRoot);
    writeFileSync(join(fx.projectRoot, "code.ts"), "export const v = 1;\n");
    writeFileSync(join(fx.projectRoot, "notes.md"), "# before\n");
    execFileSync("git", ["add", "."], { cwd: fx.projectRoot, stdio: "ignore" });
    execFileSync("git", ["commit", "-m", "start"], { cwd: fx.projectRoot, stdio: "ignore" });
    const startHead = execFileSync("git", ["rev-parse", "HEAD"], { cwd: fx.projectRoot, encoding: "utf8" }).trim();

    writeFileSync(join(fx.projectRoot, "code.ts"), "export const v = 2;\n");
    writeFileSync(join(fx.projectRoot, "notes.md"), "# after\n");
    execFileSync("git", ["add", "."], { cwd: fx.projectRoot, stdio: "ignore" });
    execFileSync("git", ["commit", "-m", "complete"], { cwd: fx.projectRoot, stdio: "ignore" });
    const completeHead = execFileSync("git", ["rev-parse", "HEAD"], { cwd: fx.projectRoot, encoding: "utf8" }).trim();

    const events = makeAttemptWindowEvents(fx.change, startHead, completeHead);
    const scope = {
      base_head: startHead,
      current_head: completeHead,
      scope_reliable: true,
      scope_reason: "ok",
      committed_paths: ["code.ts"],
      worktree_paths: ["src/dirty.ts"],
      untracked_paths: [],
      review_paths: ["code.ts", "src/dirty.ts"],
    };
    const context = codeReviewPacketContext(fx.changeRoot, fx.projectRoot, scope, events);
    const entry = context.task_execution_index?.[0];
    // notes.md 是过程文档，不进入 changed_paths；dirty 与 committed 取并集
    assert.deepEqual(entry?.changed_paths, ["code.ts", "src/dirty.ts"]);
    assert.equal(entry?.changed_paths_partial_reason, undefined);
    assert.deepEqual(context.unknown_attribution_tasks, []);
  } finally {
    fx.cleanup();
  }
});

test("review_evidence_digest：排序稳定（事件顺序无关）且对证据内容敏感", () => {
  const change = "digest-change";
  const base = (semantic: string, eventKey: string) => makeEvent(change, "test_run_recorded", {
    test_id: "TEST-001",
    attempt_id: "ATT-1",
    semantic_status: semantic,
    exit_code: semantic === "expected_failure" ? 1 : 0,
    command: "npm test",
    cwd: "/tmp",
  }, { transitionId: `T-${eventKey}`, idempotencyKey: eventKey }) as Event;
  const completedEvent = makeEvent(change, "task_completed", {
    task_id: "TASK-001",
    attempt_id: "ATT-1",
  }, { transitionId: "T-done", idempotencyKey: "done" }) as Event;
  const startedEvent = makeEvent(change, "task_started", {
    task_id: "TASK-001",
    attempt_id: "ATT-1",
  }, { transitionId: "T-start", idempotencyKey: "start" }) as Event;

  const red = base("expected_failure", "red");
  const green = base("expected_success", "green");
  const forward = reviewEvidenceDigest([startedEvent, red, green, completedEvent]);
  const shuffled = reviewEvidenceDigest([completedEvent, green, startedEvent, red]);
  assert.equal(forward, shuffled);

  // 改变证据语义应改变 digest
  const mutated = reviewEvidenceDigest([startedEvent, red, base("characterization_pass", "green"), completedEvent]);
  assert.notEqual(forward, mutated);
});

const CONTRACT_BLOCK_TAIL = [
  "  - 测试: test-contract.md#TEST-001",
  "  - 设计: design.md#Route",
  "  - 来源: proposal.md#Impact",
  "  - 原因: 独立验收行为",
  "  - 边界: 不改持久化",
  "",
].join("\n");

const TEST_CONTRACT_TABLE = [
  "# Test Contract",
  "",
  "| test_id | scenario |",
  "|---|---|",
  "| TEST-001 | behavior works |",
  "",
].join("\n");

function contractTasksWithHeader(opts: { beforeHeader?: string; blankLineBeforeHeader?: boolean } = {}): string {
  const middle: string[] = [];
  if (opts.blankLineBeforeHeader) middle.push("");
  if (opts.beforeHeader) middle.push(opts.beforeHeader);
  middle.push("  执行依据:");
  return [
    "# Tasks",
    "",
    "- [ ] TASK-001 Implement behavior tdd_required:true",
    ...middle,
    CONTRACT_BLOCK_TAIL,
  ].join("\n");
}

function appendLegacyStartApply(projectRoot: string, change: string): void {
  appendEvent(projectRoot, change, makeEvent(change, "transition_commit", {
    transition: "start-apply",
    from_state: "propose_ready",
    to_state: "apply",
    outcome: "advanced",
    created_job_ids: [],
    reason: "legacy apply without contract mode",
    apply_start_head: null,
    apply_start_head_reason: "no git",
  }, { transitionId: "T-legacy-start-apply", idempotencyKey: "legacy-start-apply-key" }));
}

test("执行依据绑定：task 与块头之间允许一个空行，仍进入契约模式", () => {
  const tasks = contractTasksWithHeader({ blankLineBeforeHeader: true });
  const validation = validateExecutionRequirements(tasks, TEST_CONTRACT_TABLE);
  assert.equal(validation.mode, true);
  assert.equal(validation.ok, true);
  assert.equal(validation.errors.length, 0);

  const fx = setupProposeChange(tasks, TEST_CONTRACT_TABLE);
  try {
    const ready = proposeReady(fx.projectRoot, fx.change, fx.changeRoot, "strict");
    assert.equal(ready.outcome, "job_created");
    assert.equal(ready.to_state, "propose");
    assert.equal(ready.events_written, 1);
  } finally {
    fx.cleanup();
  }
});

test("执行依据绑定：块头与 task 之间夹说明文字时阻断（孤儿块）", () => {
  const tasks = contractTasksWithHeader({ beforeHeader: "  先写一段说明，再挂执行依据" });
  const validation = validateExecutionRequirements(tasks, TEST_CONTRACT_TABLE);
  assert.equal(validation.ok, false);
  assert.match(validation.errors.join("；"), /没有绑定到任何 task/);

  const fx = setupProposeChange(tasks, TEST_CONTRACT_TABLE);
  try {
    const blocked = proposeReady(fx.projectRoot, fx.change, fx.changeRoot, "minimal");
    assert.equal(blocked.events_written, 0);
    assert.match(blocked.message, /没有绑定到任何 task/);
  } finally {
    fx.cleanup();
  }
});

test("执行依据绑定：全角冒号块头可被识别", () => {
  const tasks = [
    "# Tasks",
    "",
    "- [ ] TASK-001 Implement behavior tdd_required:true",
    "  执行依据：",
    CONTRACT_BLOCK_TAIL,
  ].join("\n");
  const validation = validateExecutionRequirements(tasks, TEST_CONTRACT_TABLE);
  assert.equal(validation.mode, true);
  assert.equal(validation.ok, true);
});

test("历史 apply 轮：tasks 带执行依据文本但 contract_mode 为 false 时 task-start 不输出契约", () => {
  const tasks = contractTasksWithHeader();
  const fx = setupChange(tasks, TEST_CONTRACT_TABLE);
  try {
    appendLegacyStartApply(fx.projectRoot, fx.change);
    const started = taskStart(fx.projectRoot, fx.change, fx.changeRoot, "TASK-001");
    assert.equal(started.details?.contract, null);
    assert.equal(started.details?.legacy_contract, true);
    assert.equal(started.details?.execution_policy, "tdd");

    const structureDigest = tasksStructureDigest(readFileSync(join(fx.changeRoot, "tasks.md"), "utf8"), sha256Text);
    const attemptId = started.details?.attempt_id;
    assert.equal(typeof attemptId, "string");

    assert.equal(recordTestRunContent(fx.projectRoot, fx.change, JSON.stringify({
      test_id: "TEST-001",
      attempt_id: attemptId,
      command: "npm test",
      cwd: fx.projectRoot,
      exit_code: 1,
      semantic_status: "expected_failure",
    })).accepted, false);

    assert.equal(recordTestRunContent(fx.projectRoot, fx.change, JSON.stringify({
      test_id: "TEST-001",
      task_structure_digest: structureDigest,
      command: "npm test",
      cwd: fx.projectRoot,
      exit_code: 1,
      semantic_status: "expected_failure",
    })).accepted, true);
    const blocked = taskComplete(fx.projectRoot, fx.change, fx.changeRoot, "TASK-001");
    assert.equal(blocked.events_written, 0);
    assert.match(blocked.message, /GREEN 证据/);
  } finally {
    fx.cleanup();
  }
});

test("历史 v1 契约轮：无执行依据的 documentation task 仍按旧 tdd 标记回放", () => {
  const tasks = "# Tasks\n\n- [ ] TASK-001 Legacy documentation tdd_required:false no_tdd_reason:documentation-only\n";
  const fx = setupChange(tasks);
  try {
    appendEvent(fx.projectRoot, fx.change, makeEvent(fx.change, "transition_commit", {
      transition: "start-apply",
      from_state: "propose_ready",
      to_state: "apply",
      outcome: "advanced",
      created_job_ids: [],
      reason: "legacy contract apply",
      apply_contract_mode: true,
    }, { transitionId: "T-legacy-contract-v1", idempotencyKey: "legacy-contract-v1" }));

    const started = taskStart(fx.projectRoot, fx.change, fx.changeRoot, "TASK-001");
    assert.equal(started.to_state, "apply");
    assert.equal(started.details?.required_evidence, undefined);
    const completed = taskComplete(fx.projectRoot, fx.change, fx.changeRoot, "TASK-001");
    assert.equal(completed.events_written, 2);
  } finally {
    fx.cleanup();
  }
});

test("历史 v1 契约轮：普通 TDD task 在 Apply 中丢失执行依据仍被 task-start 阻断", () => {
  const tasks = contractTasksWithHeader();
  const fx = setupChange(tasks, TEST_CONTRACT_TABLE);
  try {
    appendEvent(fx.projectRoot, fx.change, makeEvent(fx.change, "transition_commit", {
      transition: "start-apply",
      from_state: "propose_ready",
      to_state: "apply",
      outcome: "advanced",
      created_job_ids: [],
      reason: "legacy contract apply",
      apply_contract_mode: true,
    }, { transitionId: "T-legacy-contract-tdd", idempotencyKey: "legacy-contract-tdd" }));
    writeFileSync(join(fx.changeRoot, "tasks.md"), "# Tasks\n\n- [ ] TASK-001 Implement behavior tdd_required:true\n");

    const started = taskStart(fx.projectRoot, fx.change, fx.changeRoot, "TASK-001");
    assert.equal(started.events_written, 0);
    assert.match(started.message, /普通 TDD 任务.*缺少执行依据/);
  } finally {
    fx.cleanup();
  }
});

test("task_execution_index：历史 attempt 带 contract 字段但 contract_mode 为 false 时不展示契约", () => {
  const fx = setupChange("# Tasks\n\n- [ ] TASK-001 Implement tdd_required:true\n");
  try {
    const events = [
      makeEvent(fx.change, "task_started", {
        task_id: "TASK-001",
        attempt_id: "ATT-legacy",
        contract_mode: false,
        contract: {
          tests: ["TEST-001"],
          design: "design.md#Route",
          source: ["proposal.md#Impact"],
          reason: "历史脏数据",
          guard: "边界",
        },
        boundary_snapshot: { head: null, dirty_files: [] },
      }, { transitionId: "T-legacy-ts", idempotencyKey: "legacy-ts" }),
      makeEvent(fx.change, "task_completed", {
        task_id: "TASK-001",
        attempt_id: "ATT-legacy",
        boundary_snapshot: { head: null, dirty_files: [] },
      }, { transitionId: "T-legacy-tc", idempotencyKey: "legacy-tc" }),
    ] as Event[];
    const scope = {
      base_head: null,
      current_head: null,
      scope_reliable: true,
      scope_reason: "ok",
      committed_paths: [] as string[],
      worktree_paths: [] as string[],
      untracked_paths: [] as string[],
      review_paths: [] as string[],
    };
    const context = codeReviewPacketContext(fx.changeRoot, fx.projectRoot, scope, events);
    const entry = context.task_execution_index?.[0];
    assert.equal(entry?.contract, null);
    assert.deepEqual(entry?.declared_tests, []);
  } finally {
    fx.cleanup();
  }
});
