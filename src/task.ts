// SuperSpec 流程引擎 — task：测试运行记录 + 任务结构指纹工具

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { sha256Text, ensureChangeLayout, appendEvent, makeEvent, withLock, appendRawRecord, readEvents } from "./store.ts";
import { tasksStructureDigest as formatDigest } from "./format.ts";
import { RecordInputDecodingError, readRecordInputFile } from "./record_input.ts";
import type { Event, TaskAttempt, TestRun } from "./types.ts";

/** tasks.md 结构指纹（委托给 format.ts 统一实现） */
export function tasksStructureDigestOf(changeRoot: string): string | null {
  const p = join(changeRoot, "tasks.md");
  if (!existsSync(p)) return null;
  const content = readFileSync(p, "utf8");
  return formatDigest(content, sha256Text);
}

function recordTestRunLoaded(
  projectRoot: string,
  change: string,
  content: string,
): { accepted: boolean; message: string } {
  let tr: Partial<TestRun>;
  try {
    tr = JSON.parse(content);
  } catch {
    return { accepted: false, message: "无效 JSON" };
  }

  const events = readEvents(projectRoot, change);
  const attemptRecord = typeof tr.attempt_id === "string" ? attemptById(events, tr.attempt_id) : null;
  const activeAttempt = attemptRecord?.state === "active" ? attemptRecord.attempt : null;
  if (attemptRecord?.attempt.contract_mode === true && attemptRecord.state !== "active") {
    return { accepted: false, message: "契约测试证据只能登记到当前活跃任务尝试（attempt_id）" };
  }
  if (!activeAttempt && activeContractAttemptExists(events)) {
    return { accepted: false, message: "契约测试证据必须带当前活跃任务尝试 ID（attempt_id）" };
  }
  if (activeAttempt?.contract_mode === true) {
    const contractCheck = validateContractTestRunInput(tr, activeAttempt);
    if (!contractCheck.ok) return { accepted: false, message: contractCheck.message };
  } else if (!tr.test_id || !tr.task_structure_digest) {
    return { accepted: false, message: "缺少测试 ID（test_id）或历史任务结构指纹（task_structure_digest）" };
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

  const normalizedTestRun = {
    test_id: tr.test_id,
    task_structure_digest: tr.task_structure_digest ?? activeAttempt?.task_structure_digest ?? "",
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
  const event = makeEvent(change, "test_run_recorded", {
    ...normalizedTestRun,
    ...rawRef,
  });
  appendEvent(projectRoot, change, event);
  return { accepted: true, message: `测试运行已登记：测试 ID（test_id）=${tr.test_id}` };
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
  if (tr.semantic_status === "expected_failure" && tr.exit_code === 0) {
    return { ok: false, message: "RED 预期失败（expected_failure）要求退出码（exit_code）非 0" };
  }
  if ((tr.semantic_status === "expected_success" || tr.semantic_status === "characterization_pass") && tr.exit_code !== 0) {
    return { ok: false, message: `语义状态（semantic_status=${tr.semantic_status}）要求退出码（exit_code）为 0` };
  }
  if (tr.semantic_status === "characterization_pass" && !(attempt.tdd_required === false && attempt.no_tdd_reason === "characterization")) {
    return { ok: false, message: "特征化通过（characterization_pass）只适用于无需 TDD 的特征化任务（tdd_required:false，no_tdd_reason:characterization）" };
  }
  const declaredTests = attempt.contract?.tests ?? [];
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
