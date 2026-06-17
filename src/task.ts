// SuperSpec 流程引擎 — task：测试运行记录 + 任务解析工具

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import {
  ensureChangeLayout, appendEvent, makeEvent, withLock, sha256Text,
} from "./store.ts";
import type { TestRun } from "./types.ts";

/** tasks.md 结构指纹（复选框归一化） */
export function tasksStructureDigestOf(changeRoot: string): string | null {
  const p = join(changeRoot, "tasks.md");
  if (!existsSync(p)) return null;
  const content = readFileSync(p, "utf8");
  return sha256Text(content.replace(/- \[[xX]\]/g, "- [ ]"));
}

/** record test-run：登记测试运行记录 */
export function recordTestRun(
  projectRoot: string, change: string, inputFile: string,
): { accepted: boolean; message: string } {
  return withLock(projectRoot, change, () => {
    ensureChangeLayout(projectRoot, change);
    if (!existsSync(inputFile)) return { accepted: false, message: `文件不存在：${inputFile}` };

    let tr: Partial<TestRun>;
    try {
      tr = JSON.parse(readFileSync(inputFile, "utf8"));
    } catch {
      return { accepted: false, message: "无效 JSON" };
    }

    if (!tr.test_id || !tr.task_structure_digest) {
      return { accepted: false, message: "缺少 test_id 或 task_structure_digest" };
    }

    const event = makeEvent(change, "test_run_recorded", {
      test_id: tr.test_id,
      task_structure_digest: tr.task_structure_digest,
      command: tr.command ?? "",
      cwd: tr.cwd ?? "",
      exit_code: tr.exit_code ?? -1,
      semantic_status: tr.semantic_status ?? "unknown",
      target_fingerprint: tr.target_fingerprint ?? null,
      raw_log_ref: tr.raw_log_ref ?? null,
    });
    appendEvent(projectRoot, change, event);
    return { accepted: true, message: `测试运行已登记：test_id=${tr.test_id}` };
  });
}
