// SuperSpec 流程引擎 — 测试证据新鲜度：最近一次通过的测试登记之后代码又有改动时，如实交给审查者与使用者

import { currentCodeStateFingerprint } from "./code_review.ts";
import type { EffectiveEvidencePlan, Event, StaleTestEvidence, TaskAttempt } from "./types.ts";

type GreenStatus = EffectiveEvidencePlan["accepted_green_statuses"][number];

/** 已完成任务尝试仍需对当前代码成立的 GREEN 要求；test_ids 为空表示按尝试整体要求一次 GREEN。 */
export interface CompletedAttemptGreenPlan {
  test_ids: string[];
  accepted_green_statuses: GreenStatus[];
}

/**
 * 按 task-start 冻结的证据计划回放完成时要求的 GREEN；不要求 GREEN 的尝试返回 null。
 * 只有契约尝试能按 attempt_id 补登记重跑，历史模式的尝试（含其中的 Fix）不参与。
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

function isPassingTestRun(ev: Event): boolean {
  return ev.event_type === "test_run_recorded" && (ev.payload as { exit_code?: unknown }).exit_code === 0;
}

/**
 * 最近一次通过的测试登记早于当前代码时返回它的时间；只提供事实，不阻塞流程。
 *
 * 代码状态指纹按审查周期计算，只能与本周期内的登记比较：本周期没有一次通过的登记对应当前代码，
 * 且本周期确有代码改动时，才视为改动之后没有测试验证。整个 change 从未有通过的测试登记时不提示。
 */
export function staleTestEvidence(projectRoot: string, events: Event[]): StaleTestEvidence | null {
  const passingRuns = events.filter(isPassingTestRun);
  if (passingRuns.length === 0) return null;
  const current = currentCodeStateFingerprint(projectRoot, events);
  if (current.files.length === 0) return null;
  const cycleStart = current.cycle_start == null ? 0 : Math.max(0, events.findIndex(ev => ev.event_id === current.cycle_start));
  const verifiesCurrentCode = events.slice(cycleStart).some(ev =>
    isPassingTestRun(ev) && (ev.payload as { code_state_digest?: unknown }).code_state_digest === current.digest
  );
  if (verifiesCurrentCode) return null;
  return { last_green_at: passingRuns[passingRuns.length - 1].created_at };
}
