// SuperSpec 流程引擎 — task：测试运行记录 + 任务结构指纹工具

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { sha256Text, ensureChangeLayout, appendEvent, makeEvent, withLock, appendRawRecord, readEvents } from "./store.ts";
import { tasksStructureDigest as formatDigest } from "./format.ts";
import { RecordInputDecodingError, readRecordInputFile } from "./record_input.ts";
import { currentCodeStateFingerprint } from "./code_review.ts";
import { completedAttemptGreenPlan, type CompletedAttemptGreenPlan } from "./test_freshness.ts";
import { GREEN_ONLY_NO_TDD_REASON, type Event, type TaskAttempt, type TestRun } from "./types.ts";

/** tasks.md 结构指纹（委托给 format.ts 统一实现） */
export function tasksStructureDigestOf(changeRoot: string): string | null {
  const p = join(changeRoot, "tasks.md");
  if (!existsSync(p)) return null;
  const content = readFileSync(p, "utf8");
  return formatDigest(content, sha256Text);
}

type TestRunInput = Partial<TestRun> & { test_ids?: unknown };

/**
 * 一次登记覆盖的 TEST。test_ids 只用于 GREEN：同一条命令以 0 退出能证明它覆盖的每个 TEST 都通过，
 * 非 0 退出只能说明至少一个失败，不能替每个 TEST 证明 RED。
 */
function testIdsForRecord(tr: TestRunInput): { ok: true; testIds: (string | undefined)[] } | { ok: false; message: string } {
  if (tr.test_ids === undefined) return { ok: true, testIds: [tr.test_id] };
  if (tr.test_id !== undefined) return { ok: false, message: "测试 ID（test_id）与测试 ID 列表（test_ids）只能提供一个" };
  if (!Array.isArray(tr.test_ids) || tr.test_ids.length === 0 || tr.test_ids.some(id => typeof id !== "string" || id.trim() === "")) {
    return { ok: false, message: "测试 ID 列表（test_ids）必须是非空字符串组成的非空数组" };
  }
  if (tr.semantic_status !== "expected_success" && tr.semantic_status !== "characterization_pass") {
    return { ok: false, message: "测试 ID 列表（test_ids）只用于 GREEN（expected_success 或 characterization_pass）；RED 请逐个 TEST 登记" };
  }
  if (tr.exit_code !== 0) {
    return { ok: false, message: "用测试 ID 列表（test_ids）登记 GREEN 要求退出码（exit_code）为 0" };
  }
  return { ok: true, testIds: [...new Set((tr.test_ids as string[]).map(id => id.trim()))] };
}

function testRunTargetProblem(
  tr: Partial<TestRun>,
  events: Event[],
  attemptRecord: { attempt: TaskAttempt; state: "active" | "completed" | "abandoned" } | null,
  activeAttempt: TaskAttempt | null,
  rerunAttempt: TaskAttempt | null,
  rerunPlan: CompletedAttemptGreenPlan | null,
): string | null {
  if (rerunAttempt && rerunPlan) {
    const rerunCheck = validatePostCompletionRerunInput(tr, rerunAttempt, rerunPlan);
    return rerunCheck.ok ? null : rerunCheck.message;
  }
  if (attemptRecord?.attempt.contract_mode === true && attemptRecord.state !== "active") {
    return "契约测试证据只能登记到当前活跃任务尝试（attempt_id）";
  }
  if (!activeAttempt && activeContractAttemptExists(events)) {
    return "契约测试证据必须带当前活跃任务尝试 ID（attempt_id）";
  }
  if (activeAttempt?.contract_mode === true) {
    const contractCheck = validateContractTestRunInput(tr, activeAttempt);
    return contractCheck.ok ? null : contractCheck.message;
  }
  if (!tr.test_id || !tr.task_structure_digest) {
    return "缺少测试 ID（test_id）或历史任务结构指纹（task_structure_digest）";
  }
  return null;
}

function recordTestRunLoaded(
  projectRoot: string,
  change: string,
  content: string,
): { accepted: boolean; message: string } {
  let tr: TestRunInput;
  try {
    tr = JSON.parse(content);
  } catch {
    return { accepted: false, message: "无效 JSON" };
  }
  const targets = testIdsForRecord(tr);
  if (!targets.ok) return { accepted: false, message: targets.message };

  const events = readEvents(projectRoot, change);
  const attemptRecord = typeof tr.attempt_id === "string" ? attemptById(events, tr.attempt_id) : null;
  const activeAttempt = attemptRecord?.state === "active" ? attemptRecord.attempt : null;
  // 已完成尝试可以补登对当前代码重跑的 GREEN；有活跃尝试时证据仍归当前尝试。
  const rerunPlan = attemptRecord?.state === "completed" && attemptRecord.attempt.contract_mode === true && !activeAttemptExists(events)
    ? completedAttemptGreenPlan(attemptRecord.attempt)
    : null;
  const rerunAttempt = rerunPlan ? attemptRecord!.attempt : null;
  // 任一 TEST 不通过校验就整批拒收，不留下部分登记。
  for (const testId of targets.testIds) {
    const problem = testRunTargetProblem({ ...tr, test_id: testId }, events, attemptRecord, activeAttempt, rerunAttempt, rerunPlan);
    if (problem) return { accepted: false, message: targets.testIds.length > 1 ? `${testId}：${problem}` : problem };
  }

  let coversTaskIds: string[] | undefined;
  if (tr.covers_task_ids !== undefined) {
    if (!Array.isArray(tr.covers_task_ids)) {
      return { accepted: false, message: "回归覆盖任务列表（covers_task_ids）必须是字符串数组" };
    }
    if (tr.covers_task_ids.length === 0) {
      return { accepted: false, message: "回归覆盖任务列表（covers_task_ids）不能是空数组" };
    }
    for (const raw of tr.covers_task_ids) {
      if (typeof raw !== "string") return { accepted: false, message: "回归覆盖任务列表（covers_task_ids）必须是字符串数组" };
      const value = raw.trim();
      if (!value) return { accepted: false, message: "回归覆盖任务列表（covers_task_ids）不能包含空字符串" };
      (coversTaskIds ??= []).push(value);
    }
    coversTaskIds = [...new Set(coversTaskIds)].sort();
  }

  // 多个 TEST 仍逐个写成独立证据，下游按 test_id 读取证据的判定无需区分登记方式。
  const codeStateDigest = currentCodeStateFingerprint(projectRoot, events).digest;
  for (const testId of targets.testIds) {
    const normalizedTestRun = {
      test_id: testId,
      task_structure_digest: tr.task_structure_digest ?? (activeAttempt ?? rerunAttempt)?.task_structure_digest ?? "",
      attempt_id: tr.attempt_id ?? null,
      ...(coversTaskIds ? { covers_task_ids: coversTaskIds } : {}),
      command: tr.command ?? "",
      cwd: tr.cwd ?? "",
      exit_code: tr.exit_code ?? -1,
      semantic_status: tr.semantic_status ?? "unknown",
      target_fingerprint: tr.target_fingerprint ?? null,
      raw_log_ref: tr.raw_log_ref ?? null,
    };
    const rawRef = appendRawRecord(projectRoot, change, "test-runs", normalizedTestRun);
    appendEvent(projectRoot, change, makeEvent(change, "test_run_recorded", {
      ...normalizedTestRun,
      code_state_digest: codeStateDigest,
      ...(rerunAttempt ? { rerun_after_completion: true } : {}),
      ...rawRef,
    }));
  }
  return { accepted: true, message: `测试运行已登记：测试 ID（test_id）=${targets.testIds.join("、")}` };
}

function attemptById(events: Event[], attemptId: string): { attempt: TaskAttempt; state: "active" | "completed" | "abandoned" } | null {
  const attempts = new Map<string, { attempt: TaskAttempt; state: "active" | "completed" | "abandoned" }>();
  for (const ev of events) {
    if (ev.event_type === "task_started") {
      const attempt = ev.payload as unknown as TaskAttempt;
      if (typeof attempt.attempt_id === "string") attempts.set(attempt.attempt_id, { attempt, state: "active" });
    } else if (ev.event_type === "task_completed") {
      const payload = ev.payload as { attempt_id?: unknown };
      const existing = typeof payload.attempt_id === "string" ? attempts.get(payload.attempt_id) : null;
      if (existing) existing.state = "completed";
    } else if (ev.event_type === "task_abandoned") {
      const payload = ev.payload as { attempt_id?: unknown };
      const existing = typeof payload.attempt_id === "string" ? attempts.get(payload.attempt_id) : null;
      if (existing) existing.state = "abandoned";
    }
  }
  return attempts.get(attemptId) ?? null;
}

function activeAttemptExists(events: Event[]): boolean {
  const active = new Set<string>();
  for (const ev of events) {
    const attemptId = (ev.payload as { attempt_id?: unknown }).attempt_id;
    if (typeof attemptId !== "string") continue;
    if (ev.event_type === "task_started") active.add(attemptId);
    else if (ev.event_type === "task_completed" || ev.event_type === "task_abandoned") active.delete(attemptId);
  }
  return active.size > 0;
}

function validatePostCompletionRerunInput(
  tr: Partial<TestRun>,
  attempt: TaskAttempt,
  plan: CompletedAttemptGreenPlan,
): { ok: true } | { ok: false; message: string } {
  if (!tr.test_id || !tr.command || !tr.cwd || typeof tr.exit_code !== "number" || !tr.semantic_status) {
    return { ok: false, message: "测试证据缺少测试 ID（test_id）、命令（command）、工作目录（cwd）、退出码（exit_code）或语义状态（semantic_status）" };
  }
  if (plan.test_ids.length > 0 && !plan.test_ids.includes(tr.test_id)) {
    return { ok: false, message: `测试 ID（test_id=${tr.test_id}）不属于任务 ${attempt.task_id} 契约声明的测试列表` };
  }
  if (tr.semantic_status === "expected_failure") {
    return { ok: false, message: `任务 ${attempt.task_id} 已完成；完成后只登记对当前代码重跑的 GREEN，不再登记 RED（expected_failure）` };
  }
  if (!plan.accepted_green_statuses.includes(tr.semantic_status as CompletedAttemptGreenPlan["accepted_green_statuses"][number])) {
    return { ok: false, message: `任务 ${attempt.task_id} 的 GREEN 语义状态（semantic_status）只能是 ${plan.accepted_green_statuses.join(" 或 ")}` };
  }
  if (tr.exit_code !== 0) {
    return { ok: false, message: `语义状态（semantic_status=${tr.semantic_status}）要求退出码（exit_code）为 0；测试未通过时先修复代码再重跑` };
  }
  return { ok: true };
}

function activeContractAttemptExists(events: Event[]): boolean {
  const attempts = new Map<string, TaskAttempt>();
  for (const ev of events) {
    if (ev.event_type === "task_started") {
      const attempt = ev.payload as unknown as TaskAttempt;
      if (typeof attempt.attempt_id === "string") attempts.set(attempt.attempt_id, attempt);
    } else if (ev.event_type === "task_completed" || ev.event_type === "task_abandoned") {
      const payload = ev.payload as { attempt_id?: unknown };
      if (typeof payload.attempt_id === "string") attempts.delete(payload.attempt_id);
    }
  }
  return [...attempts.values()].some(attempt => attempt.contract_mode === true);
}

function validateContractTestRunInput(
  tr: Partial<TestRun>,
  attempt: TaskAttempt,
): { ok: true } | { ok: false; message: string } {
  if (!tr.test_id || !tr.command || !tr.cwd || typeof tr.exit_code !== "number" || !tr.semantic_status) {
    return { ok: false, message: "契约测试证据缺少测试 ID（test_id）、命令（command）、工作目录（cwd）、退出码（exit_code）或语义状态（semantic_status）" };
  }
  if (typeof tr.attempt_id !== "string" || tr.attempt_id !== attempt.attempt_id) {
    return { ok: false, message: "契约测试证据必须带当前活跃任务尝试 ID（attempt_id）" };
  }
  if (!["expected_failure", "expected_success", "characterization_pass"].includes(tr.semantic_status)) {
    return { ok: false, message: "语义状态（semantic_status）必须是 expected_failure、expected_success 或 characterization_pass" };
  }
  const requiredEvidence = attempt.required_evidence;
  if (tr.semantic_status === "expected_failure" && requiredEvidence && !requiredEvidence.red_required) {
    return { ok: false, message: "当前任务执行快照不要求 RED（expected_failure）；请登记声明 TEST 的 GREEN" };
  }
  if (tr.semantic_status === "expected_failure" && !requiredEvidence &&
    attempt.execution_policy === "green_only" &&
    attempt.no_tdd_reason === GREEN_ONLY_NO_TDD_REASON) {
    return { ok: false, message: "GREEN-only 任务不登记 RED（expected_failure）；请在实现后登记声明 TEST 的 GREEN" };
  }
  if (tr.semantic_status === "expected_failure" && tr.exit_code === 0) {
    return { ok: false, message: "RED 预期失败（expected_failure）要求退出码（exit_code）非 0" };
  }
  if ((tr.semantic_status === "expected_success" || tr.semantic_status === "characterization_pass") && tr.exit_code !== 0) {
    return { ok: false, message: `语义状态（semantic_status=${tr.semantic_status}）要求退出码（exit_code）为 0` };
  }
  if (tr.semantic_status === "characterization_pass" && requiredEvidence && !requiredEvidence.accepted_green_statuses.includes("characterization_pass")) {
    return { ok: false, message: "当前任务执行快照不接受特征化通过（characterization_pass）" };
  }
  if (tr.semantic_status === "characterization_pass" && !requiredEvidence && !(attempt.tdd_required === false && attempt.no_tdd_reason === "characterization")) {
    return { ok: false, message: "特征化通过（characterization_pass）只适用于无需 TDD 的特征化任务（tdd_required:false，no_tdd_reason:characterization）" };
  }
  const declaredTests = requiredEvidence?.test_ids ?? attempt.contract?.tests ?? [];
  if (declaredTests.length > 0 && !declaredTests.includes(tr.test_id)) {
    return { ok: false, message: `测试 ID（test_id=${tr.test_id}）不属于当前任务契约声明的测试列表` };
  }
  return { ok: true };
}

/** record test-run：登记测试运行记录 */
export function recordTestRun(
  projectRoot: string, change: string, inputFile: string,
): { accepted: boolean; message: string } {
  return withLock(projectRoot, change, () => {
    ensureChangeLayout(projectRoot, change);
    if (!existsSync(inputFile)) return { accepted: false, message: `文件不存在：${inputFile}` };

    try {
      return recordTestRunLoaded(projectRoot, change, readRecordInputFile(inputFile));
    } catch (err) {
      if (err instanceof RecordInputDecodingError) return { accepted: false, message: err.message };
      throw err;
    }
  });
}

/** record test-run：从 JSON 内容登记测试运行记录 */
export function recordTestRunContent(
  projectRoot: string, change: string, content: string,
): { accepted: boolean; message: string } {
  return withLock(projectRoot, change, () => {
    ensureChangeLayout(projectRoot, change);
    return recordTestRunLoaded(projectRoot, change, content);
  });
}
