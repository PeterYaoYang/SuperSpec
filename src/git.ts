import { existsSync, statSync } from "node:fs";
import { dirname, isAbsolute, relative } from "node:path";
import type { JsonMap, Reason, TaskInfo } from "./util.ts";
import { GuardError, reason, renderList, runCommand, runtime } from "./util.ts";
import { splitList, task_test_evidence } from "./tasks.ts";
import { live_user_confirmations } from "./evidence.ts";

export function file_blob_sha(filePath: string): string {
  if (!existsSync(filePath) || !statSync(filePath).isFile()) throw new GuardError(`git_blob_inspection_failure: reviewed target missing: ${filePath}`);
  const proc = runCommand("git", ["hash-object", "--no-filters", filePath], { cwd: dirname(filePath), timeout: 30_000 });
  if (proc.error || proc.status !== 0) throw new GuardError(`git_blob_inspection_failure: git hash-object failed: ${proc.stderr.trim()}`);
  return proc.stdout.trim();
}

export function git_lines(repoRoot: string, ...args: string[]): string[] {
  const proc = runCommand("git", args, { cwd: repoRoot, timeout: 30_000 });
  if (proc.error || proc.status !== 0) throw new GuardError(`git_blob_inspection_failure: git ${args.join(" ")} exit ${proc.status}: ${proc.stderr.trim()}`);
  return proc.stdout.split(/\r?\n/).filter((line) => line.trim());
}

export function dirty_worktree_paths(repoRoot: string): string[] {
  const paths = new Set<string>();
  const proc = runCommand("git", ["status", "--porcelain=v1", "-z", "--no-renames"], { cwd: repoRoot, timeout: 30_000 });
  if (proc.error || proc.status !== 0) {
    throw new GuardError(`git_blob_inspection_failure: git status --porcelain=v1 -z --no-renames exit ${proc.status}: ${proc.stderr.trim()}`);
  }
  const entries = proc.stdout.split("\0").filter(Boolean);
  for (const entry of entries) {
    if (entry.length < 4) continue;
    const item = entry.slice(3);
    if (item) paths.add(item);
  }
  return [...paths].sort();
}

export function dirty_worktree_reasons(repoRoot: string, changeRoot: string, evidences: JsonMap[]): Reason[] {
  let dirty: string[];
  try {
    dirty = runtime.dirty_worktree_paths(repoRoot) as string[];
  } catch (err) {
    return [reason("dirty_worktree_unavailable", `dirty worktree paths could not be inspected: ${String((err as Error).message ?? err)}`)];
  }
  if (dirty.length === 0) return [];
  let changeRel = "";
  const rel = relative(repoRoot, changeRoot);
  if (rel && !rel.startsWith("..") && !isAbsolute(rel)) changeRel = rel;
  const unknown = dirty.filter((item) => !(changeRel && item.startsWith(`${changeRel}/`)));
  if (unknown.length === 0) return [];
  const confirmations = live_user_confirmations(evidences, "branch_handling");
  const confirmedScopes = confirmations.flatMap((ev) => (
    Array.isArray(ev.confirmed_paths) ? ev.confirmed_paths.map((item) => String(item)).filter(Boolean) : []
  ));
  const unconfirmed = unknown.filter((item) => !confirmedScopes.some((scope) => pathInScope(item, scope)));
  if (unconfirmed.length === 0) return [];
  return [reason("dirty_worktree_unattributed", `dirty/untracked files require branch/scope handling evidence with confirmed_paths before review_ready: ${renderList(unconfirmed.slice(0, 20))}`)];
}

function pathInScope(pathValue: string, scope: string): boolean {
  const normalized = scope.replace(/\/+$/, "");
  return pathValue === normalized || pathValue.startsWith(`${normalized}/`);
}

export function dirty_write_scope_red_reasons(repoRoot: string, tasks: Record<string, TaskInfo>, evidences: JsonMap[]): Reason[] {
  let dirty: string[];
  try {
    dirty = runtime.dirty_worktree_paths(repoRoot);
  } catch (err) {
    return [reason("dirty_worktree_unavailable", `dirty worktree paths could not be inspected: ${String((err as Error).message ?? err)}`)];
  }
  const reasons: Reason[] = [];
  for (const [taskId, task] of Object.entries(tasks)) {
    const scopes = splitList(task.attrs.write_scope ?? "");
    if (scopes.length === 0) continue;
    const touched = dirty.filter((item) => scopes.some((scope) => pathInScope(item, scope)));
    if (touched.length === 0) continue;
    const tddRequired = (task.attrs.tdd_required ?? "true").toLowerCase() !== "false";
    const tddMode = task.attrs.tdd_mode ?? "new-behavior";
    if (!tddRequired || tddMode === "behavior-preserving-refactor") continue;
    if (task_test_evidence(evidences, taskId, "expected_failure", "task_edit").length === 0) {
      reasons.push(reason("missing_red_evidence", `task ${taskId} write_scope changed without RED evidence: ${renderList(touched.slice(0, 20))}`, touched.slice(0, 20)));
    }
  }
  return reasons;
}

export function review_diff_paths(repoRoot: string, baseRef: string, headRef: string): string[] {
  return runtime.git_lines(repoRoot, "diff", "--name-only", `${baseRef}..${headRef}`);
}

export function review_diff_coverage_reasons(repoRoot: string, ev: JsonMap): Reason[] {
  const { base_ref: baseRef, head_ref: headRef, reviewed_files: reviewedFiles } = ev;
  if (typeof baseRef !== "string" || !baseRef || typeof headRef !== "string" || !headRef) {
    return [reason("review_evidence_incomplete", `${ev._path}: base_ref and head_ref must be non-empty strings`)];
  }
  if (!Array.isArray(reviewedFiles) || reviewedFiles.length === 0) return [];
  let diffFiles: Set<string>;
  try {
    diffFiles = new Set(runtime.review_diff_paths(repoRoot, baseRef, headRef));
  } catch (err) {
    return [reason("review_diff_unavailable", String((err as Error).message ?? err))];
  }
  const reviewed = new Set(reviewedFiles.map((item) => String(item)));
  const missing = [...diffFiles].filter((item) => !reviewed.has(item)).sort();
  if (missing.length === 0) return [];
  return [reason("review_diff_not_covered", `${ev._path}: reviewed_files missing diff paths: ${renderList(missing.slice(0, 20))}`, missing.slice(0, 20))];
}
