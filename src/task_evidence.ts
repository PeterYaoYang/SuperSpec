import { readFileSync } from "node:fs";
import { join } from "node:path";
import { parseTasksMd } from "./format.ts";
import { readEvents, sha256Text } from "./store.ts";
import { GREEN_ONLY_NO_TDD_REASON, type TaskAttempt } from "./types.ts";

export type TaskEvidenceReadiness =
  | { ready: true; missing: [] }
  | { ready: false; missing: string[]; reason: string };

export function taskEvidenceReadiness(
  projectRoot: string,
  change: string,
  changeRoot: string,
  attempt: TaskAttempt,
): TaskEvidenceReadiness {
  // 有效证据计划是 task-start 在当时策略下冻结的事实。状态机新建的 Fix
  // 即使来自历史/v1 Apply，也必须优先按这个快照回放。
  if (attempt.required_evidence) {
    return effectiveContractTaskEvidenceReadiness(projectRoot, change, attempt);
  }
  if (attempt.contract_mode === true) {
    return contractTaskEvidenceReadiness(projectRoot, change, attempt);
  }

  const tasksContent = readFileSync(join(changeRoot, "tasks.md"), "utf8");
  const tasks = parseTasksMd(tasksContent);
  const taskInfo = tasks.find(task => task.taskId === attempt.task_id);
  const missing: string[] = [];

  if (!taskInfo) {
    missing.push(`任务 ${attempt.task_id} 不存在`);
    return { ready: false, missing, reason: missing.join("、") };
  }

  const currentDigest = sha256Text(tasksContent.replace(/- \[[xX]\]/g, "- [ ]"));
  if (currentDigest !== attempt.task_structure_digest) missing.push("任务结构指纹");

  if (!taskInfo.tddRequired) {
    if (taskInfo.noTddReason === GREEN_ONLY_NO_TDD_REASON) {
      missing.push(`${GREEN_ONLY_NO_TDD_REASON} 任务必须使用执行依据模式`);
    }
    if (!taskInfo.noTddReason) missing.push("no_tdd_reason");
    return missing.length === 0
      ? { ready: true, missing: [] }
      : { ready: false, missing, reason: missing.join("、") };
  }

  let hasRed = false;
  let hasGreen = false;
  for (const ev of readEvents(projectRoot, change)) {
    if (ev.event_type !== "test_run_recorded") continue;
    const tr = ev.payload as { task_structure_digest?: string; attempt_id?: string | null; semantic_status?: string };
    const matches = tr.attempt_id === attempt.attempt_id ||
      (!tr.attempt_id && tr.task_structure_digest === attempt.task_structure_digest);
    if (!matches) continue;
    if (tr.semantic_status === "expected_failure" || tr.semantic_status === "characterization_pass") hasRed = true;
    if (tr.semantic_status === "expected_success") hasGreen = true;
  }
  if (!hasRed) missing.push("RED 证据");
  if (!hasGreen) missing.push("GREEN 证据");

  return missing.length === 0
    ? { ready: true, missing: [] }
    : { ready: false, missing, reason: missing.join("、") };
}

function contractTaskEvidenceReadiness(
  projectRoot: string,
  change: string,
  attempt: TaskAttempt,
): TaskEvidenceReadiness {
  return legacyContractTaskEvidenceReadiness(projectRoot, change, attempt);
}

/** 新执行依据模式：只消费 task-start 冻结的有效证据计划。 */
function effectiveContractTaskEvidenceReadiness(
  projectRoot: string,
  change: string,
  attempt: TaskAttempt,
): TaskEvidenceReadiness {
  const missing: string[] = [];
  const required = attempt.required_evidence!;
  const declaredTests = required.test_ids;
  if (declaredTests.length === 0) {
    const evidence = attemptLevelEvidence(
      projectRoot,
      change,
      attempt.attempt_id,
      new Set(required.accepted_green_statuses),
    );
    if (required.red_required && !evidence.hasRed) missing.push("RED 证据");
    if (required.green_required && !evidence.hasGreen) missing.push("GREEN 证据");
    return missing.length === 0
      ? { ready: true, missing: [] }
      : { ready: false, missing, reason: missing.join("、") };
  }

  const perTest = new Map<string, {
    sawRed: boolean;
    sawGreen: boolean;
    paired: boolean;
  }>();
  for (const testId of declaredTests) {
    perTest.set(testId, { sawRed: false, sawGreen: false, paired: false });
  }

  for (const ev of readEvents(projectRoot, change)) {
    if (ev.event_type !== "test_run_recorded") continue;
    const tr = ev.payload as {
      test_id?: unknown;
      attempt_id?: unknown;
      semantic_status?: unknown;
      exit_code?: unknown;
    };
    if (tr.attempt_id !== attempt.attempt_id) continue;
    if (typeof tr.test_id !== "string") continue;
    const state = perTest.get(tr.test_id);
    if (!state) continue;

    if (tr.semantic_status === "expected_failure" && typeof tr.exit_code === "number" && tr.exit_code !== 0) {
      state.sawRed = true;
    }
    const isAcceptedGreen = typeof tr.semantic_status === "string" &&
      required.accepted_green_statuses.includes(tr.semantic_status as "expected_success" | "characterization_pass") &&
      tr.exit_code === 0;
    if (isAcceptedGreen) {
      if (state.sawRed) state.paired = true;
      state.sawGreen = true;
    }
  }

  if (required.green_required) {
    for (const [testId, state] of perTest) {
      if (!state.sawGreen) missing.push(`${testId} GREEN 证据`);
    }
  }
  if (required.red_required) {
    const hasPairedTest = [...perTest.values()].some(state => state.paired);
    if (!hasPairedTest) missing.push("同一 TEST 的 RED/GREEN 配对");
  }

  return missing.length === 0
    ? { ready: true, missing: [] }
    : { ready: false, missing, reason: missing.join("、") };
}

/** 历史执行依据模式仍按当时写入 attempt 的标记回放。 */
function legacyContractTaskEvidenceReadiness(
  projectRoot: string,
  change: string,
  attempt: TaskAttempt,
): TaskEvidenceReadiness {
  const missing: string[] = [];
  const executionPolicy = attempt.execution_policy ?? "tdd";
  const greenOnly = executionPolicy === "green_only" && attempt.no_tdd_reason === GREEN_ONLY_NO_TDD_REASON;
  if (attempt.no_tdd_reason === GREEN_ONLY_NO_TDD_REASON && !greenOnly) {
    missing.push(`${GREEN_ONLY_NO_TDD_REASON} 任务不适用于当前 TDD apply`);
  }
  const tddRequired = attempt.tdd_required !== false;
  const characterization = attempt.tdd_required === false && attempt.no_tdd_reason === "characterization";
  const declaredTests = attempt.contract?.tests ?? [];

  if (!tddRequired && !attempt.no_tdd_reason) {
    missing.push("no_tdd_reason");
  }

  if (declaredTests.length === 0) {
    if (greenOnly) {
      missing.push(`${GREEN_ONLY_NO_TDD_REASON} 任务缺少声明 TEST`);
    } else if (tddRequired) {
      const hasAttemptEvidence = attemptLevelEvidence(projectRoot, change, attempt.attempt_id, new Set(["expected_success"]));
      if (!hasAttemptEvidence.hasRed) missing.push("RED 证据");
      if (!hasAttemptEvidence.hasGreen) missing.push("GREEN 证据");
    }
    return missing.length === 0
      ? { ready: true, missing: [] }
      : { ready: false, missing, reason: missing.join("、") };
  }

  const perTest = new Map<string, {
    sawRed: boolean;
    sawGreen: boolean;
    paired: boolean;
  }>();
  for (const testId of declaredTests) {
    perTest.set(testId, { sawRed: false, sawGreen: false, paired: false });
  }

  for (const ev of readEvents(projectRoot, change)) {
    if (ev.event_type !== "test_run_recorded") continue;
    const tr = ev.payload as { test_id?: unknown; attempt_id?: unknown; semantic_status?: unknown; exit_code?: unknown };
    if (tr.attempt_id !== attempt.attempt_id || typeof tr.test_id !== "string") continue;
    const state = perTest.get(tr.test_id);
    if (!state) continue;
    if (tr.semantic_status === "expected_failure" && typeof tr.exit_code === "number" && tr.exit_code !== 0) state.sawRed = true;
    const isExpectedSuccess = tr.semantic_status === "expected_success" && tr.exit_code === 0;
    const isCharacterizationPass = characterization && tr.semantic_status === "characterization_pass" && tr.exit_code === 0;
    if (isExpectedSuccess || isCharacterizationPass) {
      if (state.sawRed) state.paired = true;
      state.sawGreen = true;
    }
  }

  for (const [testId, state] of perTest) {
    if (!state.sawGreen) missing.push(`${testId} GREEN 证据`);
  }
  if (tddRequired && !greenOnly) {
    const hasPairedTest = [...perTest.values()].some(state => state.paired);
    if (!hasPairedTest) missing.push("同一 TEST 的 RED/GREEN 配对");
  }
  return missing.length === 0
    ? { ready: true, missing: [] }
    : { ready: false, missing, reason: missing.join("、") };
}

function attemptLevelEvidence(
  projectRoot: string,
  change: string,
  attemptId: string,
  acceptedGreenStatuses: Set<"expected_success" | "characterization_pass">,
): { hasRed: boolean; hasGreen: boolean } {
  let hasRed = false;
  let hasGreen = false;
  for (const ev of readEvents(projectRoot, change)) {
    if (ev.event_type !== "test_run_recorded") continue;
    const tr = ev.payload as {
      attempt_id?: unknown;
      semantic_status?: unknown;
      exit_code?: unknown;
    };
    if (tr.attempt_id !== attemptId) continue;
    if (tr.semantic_status === "expected_failure" && typeof tr.exit_code === "number" && tr.exit_code !== 0) {
      hasRed = true;
    }
    if (typeof tr.semantic_status === "string" &&
      acceptedGreenStatuses.has(tr.semantic_status as "expected_success" | "characterization_pass") &&
      tr.exit_code === 0) {
      hasGreen = true;
    }
  }
  return { hasRed, hasGreen };
}
