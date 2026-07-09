import { readFileSync } from "node:fs";
import { join } from "node:path";
import { parseTasksMd } from "./format.ts";
import { readEvents, sha256Text } from "./store.ts";
import type { TaskAttempt } from "./types.ts";

export type TaskEvidenceReadiness =
  | { ready: true; missing: [] }
  | { ready: false; missing: string[]; reason: string };

export function taskEvidenceReadiness(
  projectRoot: string,
  change: string,
  changeRoot: string,
  attempt: TaskAttempt,
): TaskEvidenceReadiness {
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
  const missing: string[] = [];
  const tddRequired = attempt.tdd_required !== false;
  const characterization = attempt.tdd_required === false && attempt.no_tdd_reason === "characterization";
  const declaredTests = attempt.contract?.tests ?? [];

  if (!tddRequired && !attempt.no_tdd_reason) {
    missing.push("no_tdd_reason");
  }

  if (declaredTests.length === 0) {
    if (tddRequired) {
      const hasAttemptEvidence = attemptLevelRedGreenEvidence(projectRoot, change, attempt.attempt_id);
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
  if (tddRequired) {
    const hasPairedTest = [...perTest.values()].some(state => state.paired);
    if (!hasPairedTest) missing.push("同一 TEST 的 RED/GREEN 配对");
  }

  return missing.length === 0
    ? { ready: true, missing: [] }
    : { ready: false, missing, reason: missing.join("、") };
}

function attemptLevelRedGreenEvidence(
  projectRoot: string,
  change: string,
  attemptId: string,
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
    if (tr.semantic_status === "expected_success" && tr.exit_code === 0) {
      hasGreen = true;
    }
  }
  return { hasRed, hasGreen };
}
