// SuperSpec code-reviewer gate helpers.

import { execFileSync } from "node:child_process";
import { existsSync, readdirSync, statSync } from "node:fs";
import { join, extname } from "node:path";
import { sha256File, sha256Text } from "./store.ts";
import type { CodeReviewResultKind, Event, Job, Ref } from "./types.ts";

export const CODE_REVIEW_REPAIR_SCOPE_PREFIX = "code_reviewer_report_repair:";

const PROCESS_DOC_RE = /^(?:openspec\/changes\/[^/]+\/)?(?:proposal|design|tasks)\.md$/;
const PROCESS_ARTIFACT_RE = /^(?:openspec\/changes\/[^/]+\/)?\.superspec\/artifacts\/(?:discovery|business-invariants|test-contract)\.md$/;
const CODE_EXTENSIONS = new Set([
  ".c", ".cc", ".cpp", ".cs", ".css", ".go", ".h", ".hpp", ".html", ".java", ".js", ".jsx",
  ".json", ".kt", ".mjs", ".mts", ".php", ".py", ".rb", ".rs", ".scss", ".sh", ".sql",
  ".swift", ".toml", ".ts", ".tsx", ".yaml", ".yml",
]);
const CODE_BASENAMES = new Set([
  "Dockerfile", "Makefile", "package.json", "package-lock.json", "pnpm-lock.yaml", "yarn.lock",
  "tsconfig.json", "tsconfig.build.json", "eslint.config.js", "vite.config.ts", "webpack.config.js",
]);
const WALK_SKIP_DIRS = new Set([".git", "node_modules", "dist", "build", ".superspec", ".omx"]);

export interface CodeChangeScan {
  reliable: boolean;
  hasCodeChanges: boolean;
  paths: string[];
  reason: string;
}

export interface CodeReviewTerminalResult {
  job: Job;
  event: Event;
  state: "accepted" | "rejected";
  result_kind?: CodeReviewResultKind;
  reason?: string;
}

export interface CodeReviewGateFacts {
  cycleStartIndex: number;
  jobs: Job[];
  openJobs: Job[];
  terminalResults: CodeReviewTerminalResult[];
  latestTerminal: CodeReviewTerminalResult | null;
  latestRejected: CodeReviewTerminalResult | null;
  consecutiveRejected: number;
}

function normalizeGitPath(rawPath: string): string {
  const trimmed = rawPath.trim();
  const unquoted = trimmed.startsWith('"') && trimmed.endsWith('"')
    ? trimmed.slice(1, -1).replace(/\\"/g, '"')
    : trimmed;
  const renamed = unquoted.includes(" -> ") ? unquoted.split(" -> ").pop() ?? unquoted : unquoted;
  return renamed.replace(/\\/g, "/");
}

function gitChangedPaths(projectRoot: string): { ok: true; paths: string[] } | { ok: false; reason: string } {
  try {
    const output = execFileSync("git", ["-C", projectRoot, "status", "--porcelain", "--untracked-files=all"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    });
    const paths = output
      .split("\n")
      .map(line => line.trimEnd())
      .filter(Boolean)
      .map(line => normalizeGitPath(line.slice(3)))
      .filter(Boolean);
    return { ok: true, paths: [...new Set(paths)].sort() };
  } catch (err) {
    return { ok: false, reason: err instanceof Error ? err.message : "git status failed" };
  }
}

function isProcessOrOrdinaryDoc(path: string): boolean {
  if (path.startsWith(".superspec/") || path.startsWith(".omx/")) return true;
  if (path.includes("/.superspec/") || path.includes("/.omx/")) return true;
  if (PROCESS_DOC_RE.test(path) || PROCESS_ARTIFACT_RE.test(path)) return true;
  return extname(path).toLowerCase() === ".md";
}

export function isCodeLikePath(path: string): boolean {
  const normalized = path.replace(/\\/g, "/");
  if (!normalized || isProcessOrOrdinaryDoc(normalized)) return false;
  const base = normalized.split("/").pop() ?? normalized;
  if (CODE_BASENAMES.has(base)) return true;
  return CODE_EXTENSIONS.has(extname(base).toLowerCase());
}

function walkCodeFiles(root: string, dir = root, out: string[] = []): string[] {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.isDirectory()) {
      if (WALK_SKIP_DIRS.has(entry.name)) continue;
      walkCodeFiles(root, join(dir, entry.name), out);
      continue;
    }
    if (!entry.isFile()) continue;
    const full = join(dir, entry.name);
    const rel = full.slice(root.length + 1).replace(/\\/g, "/");
    if (isCodeLikePath(rel)) out.push(rel);
  }
  return out;
}

export function scanCodeChanges(projectRoot: string): CodeChangeScan {
  const git = gitChangedPaths(projectRoot);
  if (!git.ok) {
    const paths = existsSync(projectRoot) && statSync(projectRoot).isDirectory()
      ? walkCodeFiles(projectRoot).sort()
      : [];
    return {
      reliable: false,
      hasCodeChanges: true,
      paths,
      reason: `无法读取 git 状态，已按当前代码文件范围发起审查：${git.reason}`,
    };
  }
  const paths = git.paths.filter(isCodeLikePath);
  return {
    reliable: true,
    hasCodeChanges: paths.length > 0,
    paths,
    reason: paths.length > 0 ? "检测到代码类改动" : "没有代码类改动",
  };
}

export function codeReviewBoundFiles(projectRoot: string, paths: string[]): Ref[] {
  return paths.map(path => ({ path, sha: sha256File(join(projectRoot, path)) ?? "sha256:missing" }));
}

function samePathSet(left: string[], right: string[]): boolean {
  const a = [...new Set(left)].sort();
  const b = [...new Set(right)].sort();
  return a.length === b.length && a.every((path, index) => path === b[index]);
}

export function codeReviewJobStaleReason(projectRoot: string, job: Job, currentPaths?: string[]): string | null {
  if (!isCodeReviewerJob(job)) return null;
  const scanPaths = currentPaths ?? scanCodeChanges(projectRoot).paths;
  const boundPaths = job.boundFiles.map(file => file.path);
  if (!samePathSet(boundPaths, scanPaths)) {
    return `代码审查范围已变化（原范围：${boundPaths.join(", ") || "<none>"}；当前范围：${scanPaths.join(", ") || "<none>"}）`;
  }
  for (const bound of job.boundFiles) {
    const currentSha = sha256File(join(projectRoot, bound.path)) ?? "sha256:missing";
    if (currentSha !== bound.sha) {
      return `代码审查范围内的文件 ${bound.path} 已变化（原记录：${bound.sha}；当前：${currentSha}）`;
    }
  }
  return null;
}

export function codeReviewPacketDigest(input: {
  role: "code-reviewer";
  boundFiles: Ref[];
  checkedDocs: string[];
  created_from_transition: string;
  previous_rejection?: { result_kind: CodeReviewResultKind; reason: string; job_id: string };
}): string {
  return sha256Text(JSON.stringify(input));
}

function isCodeReviewerJob(job: Job): boolean {
  return job.role === "code-reviewer" && job.created_from_transition === "review-ready";
}

function codeReviewResultKind(value: unknown): CodeReviewResultKind | undefined {
  return value === "invalid_report" || value === "non_actionable_report" || value === "review_failed"
    ? value
    : undefined;
}

export function currentApplyDoneCycleStart(events: Event[]): number {
  for (let i = events.length - 1; i >= 0; i--) {
    const ev = events[i];
    if (ev.event_type !== "transition_commit") continue;
    const payload = ev.payload as { from_state?: unknown; to_state?: unknown };
    if (payload.to_state === "apply_done" && payload.from_state !== "apply_done") return i;
  }
  return 0;
}

export function collectCodeReviewGateFacts(events: Event[]): CodeReviewGateFacts {
  const cycleStartIndex = currentApplyDoneCycleStart(events);
  const jobs: Job[] = [];
  const jobsById = new Map<string, Job>();
  const terminalResults: CodeReviewTerminalResult[] = [];
  const terminalJobIds = new Set<string>();

  for (let i = cycleStartIndex; i < events.length; i++) {
    const ev = events[i];
    if (ev.event_type !== "transition_commit") continue;
    const newJobs = (ev.payload as { new_jobs?: Job[] }).new_jobs ?? [];
    for (const job of newJobs) {
      if (!isCodeReviewerJob(job)) continue;
      jobs.push(job);
      jobsById.set(job.job_id, job);
    }
  }

  for (let i = cycleStartIndex; i < events.length; i++) {
    const ev = events[i];
    if (ev.event_type !== "job_accepted" && ev.event_type !== "job_rejected") continue;
    const payload = ev.payload as { job_id?: unknown; result_kind?: unknown; reason?: unknown };
    if (typeof payload.job_id !== "string") continue;
    const job = jobsById.get(payload.job_id);
    if (!job) continue;
    terminalJobIds.add(job.job_id);
    terminalResults.push({
      job,
      event: ev,
      state: ev.event_type === "job_accepted" ? "accepted" : "rejected",
      result_kind: ev.event_type === "job_rejected"
        ? codeReviewResultKind(payload.result_kind) ?? "invalid_report"
        : undefined,
      reason: typeof payload.reason === "string" ? payload.reason : undefined,
    });
  }

  let consecutiveRejected = 0;
  for (let i = terminalResults.length - 1; i >= 0; i--) {
    const result = terminalResults[i];
    if (result.state !== "rejected") break;
    if (result.result_kind !== "invalid_report" && result.result_kind !== "non_actionable_report") break;
    consecutiveRejected += 1;
  }

  const latestTerminal = terminalResults.at(-1) ?? null;
  const latestRejected = [...terminalResults].reverse().find(result => result.state === "rejected") ?? null;
  return {
    cycleStartIndex,
    jobs,
    openJobs: jobs.filter(job => !terminalJobIds.has(job.job_id)),
    terminalResults,
    latestTerminal,
    latestRejected,
    consecutiveRejected,
  };
}

export function latestApplyDoneToReviewGate(events: Event[]): { decision: "passed" | "skipped"; job_id?: string; reason?: string } | null {
  for (let i = events.length - 1; i >= 0; i--) {
    const ev = events[i];
    if (ev.event_type !== "transition_commit") continue;
    const payload = ev.payload as {
      transition?: unknown;
      from_state?: unknown;
      to_state?: unknown;
      code_review_gate?: unknown;
    };
    if (payload.transition !== "review-ready") continue;
    if (payload.from_state !== "apply_done" || payload.to_state !== "review") continue;
    const gate = payload.code_review_gate as { decision?: unknown; job_id?: unknown; reason?: unknown } | undefined;
    if (!gate || (gate.decision !== "passed" && gate.decision !== "skipped")) return null;
    return {
      decision: gate.decision,
      ...(typeof gate.job_id === "string" ? { job_id: gate.job_id } : {}),
      ...(typeof gate.reason === "string" ? { reason: gate.reason } : {}),
    };
  }
  return null;
}

export function requiresFinalVerifierForCurrentReview(events: Event[]): boolean {
  return latestApplyDoneToReviewGate(events) != null;
}
