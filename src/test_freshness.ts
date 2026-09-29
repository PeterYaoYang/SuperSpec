// SuperSpec 流程引擎 — 测试证据新鲜度：任务完成后代码又有变化时，已登记的 GREEN 不再证明当前代码

import { currentCodeStateFingerprint, type CodeStateFingerprint } from "./code_review.ts";
import type { EffectiveEvidencePlan, Event, Ref, StaleTestEvidence, TaskAttempt } from "./types.ts";

type GreenStatus = EffectiveEvidencePlan["accepted_green_statuses"][number];

/** 已完成任务尝试仍需对当前代码成立的 GREEN 要求；test_ids 为空表示按尝试整体要求一次 GREEN。 */
export interface CompletedAttemptGreenPlan {
  test_ids: string[];
  accepted_green_statuses: GreenStatus[];
}

export interface TestRerunRequirement {
  test_id: string;
  attempt_id: string;
  task_id: string;
  semantic_status: GreenStatus;
}

export type TestEvidenceFreshness =
  | { fresh: true }
  | { fresh: false; reruns: TestRerunRequirement[]; changed_paths: string[]; baseline_task_ids: string[] };

/**
 * 按 task-start 冻结的证据计划回放完成时要求的 GREEN；不要求 GREEN 的尝试返回 null。
 * 只有契约尝试能按 attempt_id 补登记重跑，历史模式的尝试（含其中的 Fix）不参与新鲜度要求。
 */
export function completedAttemptGreenPlan(attempt: TaskAttempt): CompletedAttemptGreenPlan | null {
  if (attempt.contract_mode !== true) return null;
  const required = attempt.required_evidence;
  if (required) {
    return required.green_required
      ? { test_ids: required.test_ids, accepted_green_statuses: required.accepted_green_statuses }
      : null;
  }
  const tests = attempt.contract?.tests ?? [];
  if (tests.length === 0 && attempt.tdd_required === false) return null;
  const characterization = attempt.tdd_required === false && attempt.no_tdd_reason === "characterization";
  return {
    test_ids: tests,
    accepted_green_statuses: characterization ? ["expected_success", "characterization_pass"] : ["expected_success"],
  };
}

function isStartApplyCommit(ev: Event): boolean {
  return ev.event_type === "transition_commit" &&
    (ev.payload as { transition?: unknown }).transition === "start-apply";
}

function taskCodeState(payload: unknown): CodeStateFingerprint | null {
  const value = (payload as { code_state?: unknown } | undefined)?.code_state as Partial<CodeStateFingerprint> | undefined;
  if (!value || typeof value.digest !== "string" || !Array.isArray(value.files)) return null;
  return {
    digest: value.digest,
    cycle_start: typeof value.cycle_start === "string" ? value.cycle_start : null,
    files: value.files as Ref[],
  };
}

function changedPaths(before: Ref[], after: Ref[]): string[] {
  const left = new Map(before.map(file => [file.path, file.sha]));
  const right = new Map(after.map(file => [file.path, file.sha]));
  return [...new Set([...left.keys(), ...right.keys()])]
    .filter(path => left.get(path) !== right.get(path))
    .sort();
}

/**
 * 当前 Apply round 中，某个已完成尝试完成之后代码又有变化（包括后续任务的改动）时，它声明的每个 TEST
 * 都需要一次对当前代码登记的 GREEN。task_completed 没有代码状态或不属于同一审查周期时无法比较，视为新鲜。
 */
export function testEvidenceFreshness(projectRoot: string, events: Event[]): TestEvidenceFreshness {
  const roundEvents = events.slice(Math.max(0, events.findLastIndex(isStartApplyCommit)));
  if (!roundEvents.some(ev => ev.event_type === "task_completed" && taskCodeState(ev.payload))) return { fresh: true };
  const current = currentCodeStateFingerprint(projectRoot, events);

  const started = new Map<string, TaskAttempt>();
  const plans = new Map<string, CompletedAttemptGreenPlan>();
  const byTest = new Map<string, TestRerunRequirement>();
  const attemptLevel: TestRerunRequirement[] = [];
  const staleBaselines: { task_id: string; files: Ref[] }[] = [];
  for (const ev of roundEvents) {
    if (ev.event_type === "task_started") {
      const attempt = ev.payload as unknown as TaskAttempt;
      if (typeof attempt.attempt_id === "string") started.set(attempt.attempt_id, attempt);
      continue;
    }
    if (ev.event_type !== "task_completed") continue;
    const attemptId = (ev.payload as { attempt_id?: unknown }).attempt_id;
    const attempt = typeof attemptId === "string" ? started.get(attemptId) : undefined;
    const plan = attempt ? completedAttemptGreenPlan(attempt) : null;
    if (!attempt || !plan) continue;
    plans.set(attempt.attempt_id, plan);
    const completedState = taskCodeState(ev.payload);
    if (!completedState || completedState.cycle_start !== current.cycle_start || completedState.digest === current.digest) {
      for (const testId of plan.test_ids) byTest.delete(testId);
      continue;
    }
    staleBaselines.push({ task_id: attempt.task_id, files: completedState.files });
    const requirement = (testId: string): TestRerunRequirement => ({
      test_id: testId,
      attempt_id: attempt.attempt_id,
      task_id: attempt.task_id,
      semantic_status: plan.accepted_green_statuses[0] ?? "expected_success",
    });
    if (plan.test_ids.length === 0) attemptLevel.push(requirement(attempt.task_id));
    for (const testId of plan.test_ids) byTest.set(testId, requirement(testId));
  }

  const currentRuns = roundEvents.flatMap(ev => {
    if (ev.event_type !== "test_run_recorded") return [];
    const run = ev.payload as { test_id?: unknown; attempt_id?: unknown; exit_code?: unknown; semantic_status?: unknown; code_state_digest?: unknown };
    if (run.code_state_digest !== current.digest || run.exit_code !== 0 || typeof run.attempt_id !== "string") return [];
    const plan = plans.get(run.attempt_id);
    if (!plan || !plan.accepted_green_statuses.includes(run.semantic_status as GreenStatus)) return [];
    return [{ test_id: run.test_id, attempt_id: run.attempt_id, plan }];
  });
  const reruns = [
    ...[...byTest.values()].filter(req =>
      !currentRuns.some(run => run.test_id === req.test_id && run.plan.test_ids.includes(req.test_id))
    ),
    ...attemptLevel.filter(req => !currentRuns.some(run => run.attempt_id === req.attempt_id)),
  ];
  if (reruns.length === 0) return { fresh: true };
  const staleTaskIds = new Set(reruns.map(req => req.task_id));
  const baselines = staleBaselines.filter(baseline => staleTaskIds.has(baseline.task_id));
  return {
    fresh: false,
    reruns,
    changed_paths: [...new Set(baselines.flatMap(baseline => changedPaths(baseline.files, current.files)))].sort(),
    baseline_task_ids: [...new Set(baselines.map(baseline => baseline.task_id))],
  };
}

/**
 * 证据登记早于当前代码的 TEST 与相关改动文件。
 *
 * 测试结果由执行者自报时，要求逐条重登只会产生没有信息量的登记；这里只把事实交给
 * 审查者和使用者判断，不阻塞流程。
 */
export function staleTestEvidence(projectRoot: string, events: Event[]): StaleTestEvidence | null {
  const freshness = testEvidenceFreshness(projectRoot, events);
  if (freshness.fresh) return null;
  return {
    test_ids: [...new Set(freshness.reruns.map(req => req.test_id))],
    task_ids: freshness.baseline_task_ids,
    changed_paths: freshness.changed_paths,
  };
}
