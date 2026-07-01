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
