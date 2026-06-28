// SuperSpec 流程引擎 — task：测试运行记录 + 任务结构指纹工具

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { sha256Text, ensureChangeLayout, appendEvent, makeEvent, withLock, appendRawRecord } from "./store.ts";
import { tasksStructureDigest as formatDigest } from "./format.ts";
import type { TestRun } from "./types.ts";

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

  if (!tr.test_id || !tr.task_structure_digest) {
    return { accepted: false, message: "缺少 test_id 或 task_structure_digest" };
  }

  let coversTaskIds: string[] | undefined;
  if (tr.covers_task_ids !== undefined) {
    if (!Array.isArray(tr.covers_task_ids)) {
      return { accepted: false, message: "covers_task_ids 必须是字符串数组" };
    }
    if (tr.covers_task_ids.length === 0) {
      return { accepted: false, message: "covers_task_ids 不能是空数组" };
    }
    for (const raw of tr.covers_task_ids) {
      if (typeof raw !== "string") return { accepted: false, message: "covers_task_ids 必须是字符串数组" };
      const value = raw.trim();
      if (!value) return { accepted: false, message: "covers_task_ids 不能包含空字符串" };
      (coversTaskIds ??= []).push(value);
    }
    coversTaskIds = [...new Set(coversTaskIds)].sort();
  }

  const normalizedTestRun = {
    test_id: tr.test_id,
    task_structure_digest: tr.task_structure_digest,
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
  return { accepted: true, message: `测试运行已登记：test_id=${tr.test_id}` };
}

/** record test-run：登记测试运行记录 */
export function recordTestRun(
  projectRoot: string, change: string, inputFile: string,
): { accepted: boolean; message: string } {
  return withLock(projectRoot, change, () => {
    ensureChangeLayout(projectRoot, change);
    if (!existsSync(inputFile)) return { accepted: false, message: `文件不存在：${inputFile}` };

    return recordTestRunLoaded(projectRoot, change, readFileSync(inputFile, "utf8"));
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
