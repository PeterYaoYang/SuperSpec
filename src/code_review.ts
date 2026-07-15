// SuperSpec code-reviewer gate helpers.

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { findLatestEvent, sha256File, sha256Text } from "./store.ts";
import { REVIEW_CODE_REVIEW_GATE } from "./review_job_gates.ts";
import {
  codeFileContentSha,
  currentGitHead,
  diffFingerprints,
  dirtyCodePaths,
  gitLines,
  isCodeLikePath,
  projectHasReadableDirectory,
  walkCodeFiles,
} from "./git_state.ts";
import { parseExecutionRequirements, parseTestContractEntries } from "./format.ts";
import type { BoundarySnapshot, CodeReviewGateEvidence, CodeReviewResultKind, CodeReviewScope, CodeStateCheck, CoverageExemptionRef, DirtyFileFingerprint, Event, Job, JobPacketContext, Ref, ReviewPreviousRejection, TaskAttempt, TaskExecutionIndexEntry } from "./types.ts";

export const CODE_REVIEW_REPAIR_SCOPE_PREFIX = "code_reviewer_report_repair:";
export const CODE_REVIEW_DECISION_SCOPE_PREFIX = "code_review_decision:";
export const TEST_COVERAGE_EXEMPTION_SCOPE_PREFIX = "test_coverage_exemption:";
export type CodeReviewDecisionAnswer = "reopen_propose" | "reopen_apply" | "dismiss";
export const CODE_REVIEW_DECISION_ANSWER_LABELS: Record<CodeReviewDecisionAnswer, string> = {
  reopen_propose: "回到计划阶段",
  reopen_apply: "回到实现阶段",
  dismiss: "驳回该问题",
};

export interface CodeChangeScan {
  reliable: boolean;
  hasCodeChanges: boolean;
  paths: string[];
  reason: string;
  scope?: CodeReviewScope;
}

export interface CodeReviewTerminalResult {
  job: Job;
  event: Event;
  state: "accepted" | "rejected";
  result_kind?: CodeReviewResultKind;
  reason?: string;
}

export interface CodeReviewDecision {
  answer: CodeReviewDecisionAnswer;
  reason: string;
  event: Event;
}

export interface CodeReviewFindingStatus {
  id: string;
  type: "implementation" | "spec" | "mixed";
  finding: Record<string, unknown>;
  decision: CodeReviewDecision | null;
}

export interface CodeReviewFailedStatus {
  terminal: CodeReviewTerminalResult;
  findings: CodeReviewFindingStatus[];
  unresolved: CodeReviewFindingStatus[];
  dismissed: CodeReviewFindingStatus[];
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

export function scanCodeChanges(projectRoot: string): CodeChangeScan {
  const git = dirtyCodePaths(projectRoot);
  if (!git.ok) {
    const paths = projectHasReadableDirectory(projectRoot)
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

export function currentCodeReviewWorkingPaths(projectRoot: string, events: Event[], extraIgnoredPaths: string[] = []): string[] {
  const ignored = new Set(extraIgnoredPaths.map(path => path.replace(/\\/g, "/")));
  for (const path of knownCodeReviewReportPaths(projectRoot, events)) ignored.add(path);
  return scanCodeChanges(projectRoot).paths.filter(path => !ignored.has(path));
}

function uniqSorted(paths: string[]): string[] {
  return [...new Set(paths)].filter(isCodeLikePath).sort();
}

function normalizeKnownPath(path: string): string {
  return path.trim().replace(/\\/g, "/");
}

export function knownCodeReviewReportPaths(projectRoot: string, events: Event[]): Set<string> {
  const paths = new Set<string>();
  for (const ev of events) {
    if (ev.event_type !== "job_accepted" && ev.event_type !== "job_rejected") continue;
    const payload = ev.payload as { report_path?: unknown; report_digest?: unknown; role?: unknown };
    if (payload.role !== "code-reviewer") continue;
    if (typeof payload.report_digest !== "string" || payload.report_digest.trim() === "") continue;
    if (typeof payload.report_path === "string" && payload.report_path.trim() !== "") {
      const reportPath = normalizeKnownPath(payload.report_path);
      if (sha256File(join(projectRoot, reportPath)) === payload.report_digest) {
        paths.add(reportPath);
      }
    }
  }
  return paths;
}

function excludeKnownPaths(paths: string[], ignored: Set<string>): string[] {
  if (ignored.size === 0) return paths;
  return paths.filter(path => !ignored.has(path));
}

function firstStartApplyHead(events: Event[]): { present: boolean; head: string | null; reason: string } {
  for (const ev of events) {
    if (ev.event_type !== "transition_commit") continue;
    const payload = ev.payload as { transition?: unknown; apply_start_head?: unknown; apply_start_head_reason?: unknown };
    if (payload.transition !== "start-apply") continue;
    if (!Object.prototype.hasOwnProperty.call(payload, "apply_start_head")) {
      return { present: false, head: null, reason: "missing_apply_start_head" };
    }
    return {
      present: true,
      head: typeof payload.apply_start_head === "string" ? payload.apply_start_head : null,
      reason: typeof payload.apply_start_head_reason === "string" ? payload.apply_start_head_reason : "missing_apply_start_head",
    };
  }
  return { present: false, head: null, reason: "没有 apply_start_head" };
}

function latestReviewedHead(events: Event[]): { head: string | null; present: boolean } {
  for (let i = events.length - 1; i >= 0; i--) {
    const ev = events[i];
    if (ev.event_type !== "transition_commit") continue;
    const payload = ev.payload as { code_review_gate?: unknown };
    const gate = payload.code_review_gate as { decision?: unknown; current_head?: unknown; head?: unknown } | undefined;
    if (!gate) continue;
    if (gate.decision === "passed") {
      if (typeof gate.current_head !== "string" || gate.current_head.trim() === "") continue;
      return { present: true, head: gate.current_head };
    }
    if (gate.decision === "skipped") {
      if (typeof gate.head !== "string" || gate.head.trim() === "") continue;
      return { present: true, head: gate.head };
    }
  }
  return { present: false, head: null };
}

export function selectCodeReviewBase(events: Event[]): { base_head: string | null; kind: "reviewed" | "start_apply" | "empty_tree" | "history_missing"; reason: string } {
  const reviewed = latestReviewedHead(events);
  if (reviewed.present) return { base_head: reviewed.head, kind: "reviewed", reason: "latest_code_review_gate" };
  const firstStart = firstStartApplyHead(events);
  if (!firstStart.present) return { base_head: null, kind: "history_missing", reason: firstStart.reason };
  if (firstStart.head == null) return { base_head: null, kind: "empty_tree", reason: firstStart.reason };
  return { base_head: firstStart.head, kind: "start_apply", reason: "first_start_apply" };
}

function scanCodeReviewScopeFromBase(
  projectRoot: string,
  base: { base_head: string | null; kind: "reviewed" | "start_apply" | "empty_tree" | "history_missing"; reason: string },
  ignoredPaths: Set<string> = new Set(),
): CodeReviewScope {
  const currentHead = currentGitHead(projectRoot);
  let scopeReliable = true;
  let scopeReason = base.kind === "history_missing" ? base.reason : "ok";
  let committedPaths: string[] | null = [];

  if (base.kind !== "history_missing") {
    if (base.base_head && currentHead.head) {
      const diff = gitLines(projectRoot, ["diff", "--name-only", `${base.base_head}..HEAD`]);
      if (diff.ok) committedPaths = excludeKnownPaths(uniqSorted(diff.lines), ignoredPaths);
      else {
        scopeReliable = false;
        scopeReason = `git diff ${base.base_head}..HEAD failed: ${diff.reason}`;
        committedPaths = null;
      }
    } else if (base.kind === "empty_tree" && currentHead.head) {
      const tree = gitLines(projectRoot, ["ls-tree", "-r", "--name-only", "HEAD"]);
      if (tree.ok) committedPaths = excludeKnownPaths(uniqSorted(tree.lines), ignoredPaths);
      else {
        scopeReliable = false;
        scopeReason = `git ls-tree HEAD failed: ${tree.reason}`;
        committedPaths = null;
      }
    }
  }

  const staged = gitLines(projectRoot, ["diff", "--name-only", "--cached"]);
  const unstaged = gitLines(projectRoot, ["diff", "--name-only"]);
  const untracked = gitLines(projectRoot, ["ls-files", "--others", "--exclude-standard"]);
  if (!staged.ok || !unstaged.ok || !untracked.ok) {
    scopeReliable = false;
    scopeReason = [scopeReason, !staged.ok ? staged.reason : "", !unstaged.ok ? unstaged.reason : "", !untracked.ok ? untracked.reason : ""]
      .filter(Boolean)
      .join("; ");
  }

  const worktreePaths = excludeKnownPaths(uniqSorted([...(staged.ok ? staged.lines : []), ...(unstaged.ok ? unstaged.lines : [])]), ignoredPaths);
  const untrackedPaths = excludeKnownPaths(uniqSorted(untracked.ok ? untracked.lines : []), ignoredPaths);
  const fallbackPaths = projectHasReadableDirectory(projectRoot)
    ? excludeKnownPaths(walkCodeFiles(projectRoot).sort(), ignoredPaths)
    : [];
  const reviewPaths = committedPaths == null || !scopeReliable
    ? uniqSorted([...fallbackPaths, ...worktreePaths, ...untrackedPaths])
    : uniqSorted([...committedPaths, ...worktreePaths, ...untrackedPaths]);

  return {
    base_head: base.base_head,
    current_head: currentHead.head,
    scope_reliable: scopeReliable,
    scope_reason: scopeReason || base.reason,
    committed_paths: committedPaths,
    worktree_paths: worktreePaths,
    untracked_paths: untrackedPaths,
    review_paths: reviewPaths,
  };
}

export function scanCodeReviewScope(projectRoot: string, events: Event[]): CodeReviewScope {
  return scanCodeReviewScopeFromBase(projectRoot, selectCodeReviewBase(events), knownCodeReviewReportPaths(projectRoot, events));
}

export function scanCodeChangesForReview(projectRoot: string, events: Event[]): CodeChangeScan {
  const scope = scanCodeReviewScope(projectRoot, events);
  const hasCodeChanges = !scope.scope_reliable ||
    scope.committed_paths == null ||
    scope.committed_paths.length > 0 ||
    scope.worktree_paths.length > 0 ||
    scope.untracked_paths.length > 0;
  return {
    reliable: scope.scope_reliable,
    hasCodeChanges,
    paths: scope.review_paths,
    reason: hasCodeChanges ? "检测到代码类改动" : "没有代码类改动",
    scope,
  };
}

export function codeReviewBoundFiles(projectRoot: string, paths: string[]): Ref[] {
  return paths.map(path => ({ path, sha: codeFileContentSha(projectRoot, path) ?? "sha256:missing" }));
}

function samePathSet(left: string[], right: string[]): boolean {
  const a = [...new Set(left)].sort();
  const b = [...new Set(right)].sort();
  return a.length === b.length && a.every((path, index) => path === b[index]);
}

export function codeReviewJobStaleReason(projectRoot: string, job: Job, currentPaths?: string[]): string | null {
  if (!isCodeReviewerJob(job)) return null;
  const frozenScope = job.packet_context?.code_review_scope;
  if (frozenScope) {
    const currentHead = currentGitHead(projectRoot);
    if (frozenScope.current_head !== currentHead.head) {
      return `代码审查创建后的 HEAD 已变化（原记录：${frozenScope.current_head ?? "<none>"}；当前：${currentHead.head ?? "<none>"}）`;
    }
    const currentWorkingPaths = currentPaths ?? scanCodeChanges(projectRoot).paths;
    const frozenWorkingPaths = uniqSorted([...frozenScope.worktree_paths, ...frozenScope.untracked_paths]);
    if (!samePathSet(frozenWorkingPaths, currentWorkingPaths)) {
      return `代码审查范围已变化：工作区范围已变化（原范围：${frozenWorkingPaths.join(", ") || "<none>"}；当前范围：${currentWorkingPaths.join(", ") || "<none>"}）`;
    }
    for (const bound of job.boundFiles) {
      const currentSha = codeFileContentSha(projectRoot, bound.path) ?? "sha256:missing";
      if (currentSha !== bound.sha) {
        return `代码审查范围内的文件 ${bound.path} 已变化（原记录：${bound.sha}；当前：${currentSha}）`;
      }
    }
    return null;
  }
  const scanPaths = currentPaths ?? scanCodeChanges(projectRoot).paths;
  const boundPaths = job.boundFiles.map(file => file.path);
  if (!samePathSet(boundPaths, scanPaths)) {
    return `代码审查范围已变化（原范围：${boundPaths.join(", ") || "<none>"}；当前范围：${scanPaths.join(", ") || "<none>"}）`;
  }
  for (const bound of job.boundFiles) {
    const currentSha = codeFileContentSha(projectRoot, bound.path) ?? "sha256:missing";
    if (currentSha !== bound.sha) {
      return `代码审查范围内的文件 ${bound.path} 已变化（原记录：${bound.sha}；当前：${currentSha}）`;
    }
  }
  return null;
}

export function codeReviewPacketDigest(input: {
  role: "code-reviewer";
  gate_id?: "review.code_review";
  boundFiles: Ref[];
  checkedDocs: string[];
  created_from_transition: string;
  packet_context?: JobPacketContext;
  previous_rejection?: ReviewPreviousRejection;
}): string {
  return sha256Text(JSON.stringify(input));
}

export function codeReviewPacketContext(changeRoot: string, projectRoot: string, scope: CodeReviewScope, events: Event[]): JobPacketContext {
  const taskExecutionIndex = taskExecutionIndexFromEvents(projectRoot, events);
  // changed_paths 未知（快照缺失）或不完整（committed 段 diff 失败）的 task
  // 都进入 unknown_attribution_tasks，提示 code-reviewer 扩大对照范围
  const unknownAttributionTasks = taskExecutionIndex
    .filter(item => item.changed_paths == null || item.changed_paths_partial_reason != null)
    .map(item => item.task_id)
    .sort();
  const attributedPaths = new Set<string>();
  for (const item of taskExecutionIndex) {
    for (const path of item.changed_paths ?? []) attributedPaths.add(path);
  }
  return {
    code_review_scope: scope,
    coverage_exemption_refs: coverageExemptionRefs(changeRoot, events),
    task_execution_index: taskExecutionIndex,
    unattributed_paths: scope.review_paths.filter(path => !attributedPaths.has(path)).sort(),
    unknown_attribution_tasks: unknownAttributionTasks,
  };
}

export function effectiveCoverageExemptionRefsFromEvents(events: Event[]): CoverageExemptionRef[] {
  const latest = new Map<string, CoverageExemptionRef>();
  for (const ev of events) {
    if (ev.event_type !== "user_decision_recorded") continue;
    const payload = ev.payload as { scope?: unknown; answer?: unknown; accepted?: unknown };
    if (payload.accepted === false) continue;
    if (typeof payload.scope !== "string" || !payload.scope.startsWith(TEST_COVERAGE_EXEMPTION_SCOPE_PREFIX)) continue;
    const testId = payload.scope.slice(TEST_COVERAGE_EXEMPTION_SCOPE_PREFIX.length);
    if (!/^TEST-[A-Za-z0-9_-]+$/.test(testId)) continue;
    if (typeof payload.answer !== "string" || payload.answer.trim() === "") continue;
    latest.set(testId, {
      test_id: testId,
      event_id: ev.event_id,
      event_digest: ev.event_digest,
      answer: payload.answer.trim(),
    });
  }
  return [...latest.values()].sort((a, b) => a.test_id.localeCompare(b.test_id));
}

function currentTaskDeclaredTestIds(changeRoot: string): Set<string> {
  const tasksPath = join(changeRoot, "tasks.md");
  if (!existsSync(tasksPath)) return new Set();
  return new Set(parseExecutionRequirements(readFileSync(tasksPath, "utf8")).flatMap(item => item.contract.tests));
}

function currentTestContractIds(changeRoot: string): string[] {
  const testContractPath = join(changeRoot, ".superspec", "artifacts", "test-contract.md");
  if (!existsSync(testContractPath)) return [];
  const parsed = parseTestContractEntries(readFileSync(testContractPath, "utf8"));
  return parsed.ok ? parsed.entries.map(entry => entry.test_id).sort() : [];
}

export function missingCoverageExemptionTestIds(changeRoot: string, events: Event[]): string[] {
  const declared = currentTaskDeclaredTestIds(changeRoot);
  const effective = new Set(effectiveCoverageExemptionRefsFromEvents(events).map(ref => ref.test_id));
  return currentTestContractIds(changeRoot)
    .filter(testId => !declared.has(testId) && !effective.has(testId))
    .sort();
}

function coverageExemptionRefs(changeRoot: string, events: Event[]): CoverageExemptionRef[] {
  const declared = currentTaskDeclaredTestIds(changeRoot);
  const unbound = new Set(currentTestContractIds(changeRoot).filter(testId => !declared.has(testId)));
  return effectiveCoverageExemptionRefsFromEvents(events)
    .filter(ref => unbound.has(ref.test_id))
    .sort((a, b) => a.test_id.localeCompare(b.test_id));
}

interface StartedAttemptRecord {
  attempt: TaskAttempt;
  boundary: BoundarySnapshot | null;
}

function boundaryFromPayload(payload: Record<string, unknown>): BoundarySnapshot | null {
  const boundary = payload.boundary_snapshot;
  if (!boundary || typeof boundary !== "object" || Array.isArray(boundary)) return null;
  const obj = boundary as Partial<BoundarySnapshot>;
  if (!Array.isArray(obj.dirty_files)) return null;
  if (typeof (obj as { dirty_files_reason?: unknown }).dirty_files_reason === "string") return null;
  return {
    head: typeof obj.head === "string" ? obj.head : null,
    ...(typeof obj.head_reason === "string" ? { head_reason: obj.head_reason } : {}),
    dirty_files: obj.dirty_files,
  };
}

interface ChangedPathsResult {
  paths: string[];
  // committed 段 diff 失败时记录原因：dirty 侧对比结果仍然有效，但归属可能不完整
  partial_reason: string | null;
}

function changedPathsBetweenSnapshots(
  projectRoot: string,
  start: BoundarySnapshot | null,
  completed: BoundarySnapshot | null,
): ChangedPathsResult | null {
  if (!start || !completed) return null;

  // 两端 dirty_files 用共享指纹原语对比，再过滤出代码类路径
  const changed = new Set(diffFingerprints(start.dirty_files, completed.dirty_files).filter(isCodeLikePath));
  let partialReason: string | null = null;

  if (start.head && completed.head && start.head !== completed.head) {
    const diff = gitLines(projectRoot, ["diff", "--name-only", `${start.head}..${completed.head}`]);
    if (diff.ok) {
      // 方案要求 committed 段只收代码文件，uniqSorted 内含 isCodeLikePath 过滤
      for (const path of uniqSorted(diff.lines)) changed.add(path);
    } else {
      // diff 失败不丢弃 dirty 侧的确定事实，只标记 committed 段缺失
      partialReason = `git diff ${start.head}..${completed.head} failed: ${diff.reason}`;
    }
  }

  return { paths: [...changed].sort(), partial_reason: partialReason };
}

function testEvidenceForAttempt(events: Event[], attempt: TaskAttempt): Record<string, unknown>[] {
  const declaredTests = attempt.contract_mode === true
    ? attempt.required_evidence?.test_ids ?? attempt.contract?.tests ?? []
    : [];
  const eventsByTest = new Map<string, Event[]>();
  for (const ev of events) {
    if (ev.event_type !== "test_run_recorded") continue;
    const payload = ev.payload as { attempt_id?: unknown; test_id?: unknown };
    if (payload.attempt_id !== attempt.attempt_id || typeof payload.test_id !== "string") continue;
    if (declaredTests.length > 0 && !declaredTests.includes(payload.test_id)) continue;
    const list = eventsByTest.get(payload.test_id) ?? [];
    list.push(ev);
    eventsByTest.set(payload.test_id, list);
  }

  const testIds = declaredTests.length > 0 ? declaredTests : [...eventsByTest.keys()].sort();
  const evidence: Record<string, unknown>[] = [];
  for (const testId of testIds) {
    let red: Event | null = null;
    let green: Event | null = null;
    let pairedRed: Event | null = null;
    for (const ev of eventsByTest.get(testId) ?? []) {
      const payload = ev.payload as { semantic_status?: unknown; exit_code?: unknown };
      if (payload.semantic_status === "expected_failure" && typeof payload.exit_code === "number" && payload.exit_code !== 0) {
        if (!red) red = ev;
        continue;
      }
      const isGreen = (payload.semantic_status === "expected_success" || payload.semantic_status === "characterization_pass") && payload.exit_code === 0;
      if (isGreen && !green) {
        green = ev;
        pairedRed = red;
      }
    }
    if (!green && !pairedRed) continue;
    evidence.push({
      test_id: testId,
      ...(pairedRed ? { red_event_ref: pairedRed.event_id, red_event_digest: pairedRed.event_digest } : {}),
      ...(green ? { green_event_ref: green.event_id, green_event_digest: green.event_digest } : {}),
    });
  }
  return evidence.sort((a, b) => String(a.test_id).localeCompare(String(b.test_id)));
}

function taskExecutionIndexFromEvents(projectRoot: string, events: Event[]): TaskExecutionIndexEntry[] {
  const attempts = new Map<string, StartedAttemptRecord>();
  const entries: TaskExecutionIndexEntry[] = [];
  for (const ev of events) {
    if (ev.event_type === "task_started") {
      const attempt = ev.payload as unknown as TaskAttempt;
      if (typeof attempt.attempt_id === "string") {
        attempts.set(attempt.attempt_id, {
          attempt,
          boundary: boundaryFromPayload(ev.payload),
        });
      }
    } else if (ev.event_type === "task_completed") {
      const payload = ev.payload as { task_id?: unknown; attempt_id?: unknown; scope_note?: unknown };
      if (typeof payload.task_id !== "string" || typeof payload.attempt_id !== "string") continue;
      const started = attempts.get(payload.attempt_id);
      const attempt = started?.attempt;
      const effectiveContract = attempt?.contract_mode === true ? attempt.contract ?? null : null;
      const requiredEvidence = attempt?.required_evidence ?? null;
      const changedResult = changedPathsBetweenSnapshots(projectRoot, started?.boundary ?? null, boundaryFromPayload(ev.payload));
      entries.push({
        task_id: payload.task_id,
        attempt_id: payload.attempt_id,
        ...(attempt?.fix ? { fix: attempt.fix } : {}),
        execution_policy: attempt?.execution_policy ?? "tdd",
        changed_paths: changedResult ? changedResult.paths : null,
        ...(changedResult?.partial_reason ? { changed_paths_partial_reason: changedResult.partial_reason } : {}),
        contract: effectiveContract,
        required_evidence: requiredEvidence,
        declared_tests: requiredEvidence?.test_ids ?? effectiveContract?.tests ?? [],
        scope_note: payload.scope_note && typeof payload.scope_note === "object" && !Array.isArray(payload.scope_note)
          ? payload.scope_note as Record<string, unknown>
          : null,
        test_evidence: attempt ? testEvidenceForAttempt(events, attempt) : [],
        task_completed_event_ref: ev.event_id,
      });
    }
  }
  entries.sort((a, b) => a.task_id.localeCompare(b.task_id) || a.attempt_id.localeCompare(b.attempt_id));
  return entries;
}

/** Read-only execution evidence projected for code review and final verification. */
export function taskExecutionIndexForReview(projectRoot: string, events: Event[]): TaskExecutionIndexEntry[] {
  return taskExecutionIndexFromEvents(projectRoot, events);
}

function isCodeReviewerJob(job: Job): boolean {
  return job.role === "code-reviewer" && REVIEW_CODE_REVIEW_GATE.isJobForGate(job);
}

function codeReviewResultKind(value: unknown): CodeReviewResultKind | undefined {
  return value === "invalid_report" || value === "non_actionable_report" || value === "review_failed"
    ? value
    : undefined;
}

export function codeReviewDecisionScope(jobId: string, findingId: string): string {
  return `${CODE_REVIEW_DECISION_SCOPE_PREFIX}${jobId}#${findingId}`;
}

export function isCodeReviewDecisionAnswer(value: unknown): value is CodeReviewDecisionAnswer {
  return value === "reopen_propose" || value === "reopen_apply" || value === "dismiss";
}

export function codeReviewDecisionAnswerLabel(answer: CodeReviewDecisionAnswer): string {
  return CODE_REVIEW_DECISION_ANSWER_LABELS[answer];
}

export function normalizeCodeReviewDecisionAnswer(value: unknown): CodeReviewDecisionAnswer | null {
  if (isCodeReviewDecisionAnswer(value)) return value;
  if (value === CODE_REVIEW_DECISION_ANSWER_LABELS.reopen_propose) return "reopen_propose";
  if (value === CODE_REVIEW_DECISION_ANSWER_LABELS.reopen_apply) return "reopen_apply";
  if (value === CODE_REVIEW_DECISION_ANSWER_LABELS.dismiss) return "dismiss";
  return null;
}

export function latestCodeReviewDecision(events: Event[], scope: string): CodeReviewDecision | null {
  const event = findLatestEvent(events, "user_decision_recorded", ev => {
    const payload = ev.payload as { scope?: unknown; answer?: unknown; accepted?: unknown; reason?: unknown };
    if (payload.scope !== scope) return false;
    if (payload.accepted === false) return false;
    if (!normalizeCodeReviewDecisionAnswer(payload.answer)) return false;
    if (typeof payload.reason !== "string" || payload.reason.trim() === "") return false;
    return true;
  });
  if (!event) return null;
  const payload = event.payload as { answer: unknown; reason?: unknown };
  const answer = normalizeCodeReviewDecisionAnswer(payload.answer);
  if (!answer) return null;
  return {
    answer,
    reason: typeof payload.reason === "string" ? payload.reason.trim() : "",
    event,
  };
}

function blockingFindingsFromReviewFailed(event: Event, jobId: string, events: Event[]): CodeReviewFindingStatus[] {
  const payload = event.payload as { findings?: unknown };
  const findings = Array.isArray(payload.findings) ? payload.findings : [];
  const result: CodeReviewFindingStatus[] = [];
  for (const raw of findings) {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) continue;
    const finding = raw as Record<string, unknown>;
    if (finding.blocking !== true) continue;
    if (typeof finding.id !== "string" || finding.id.trim() === "") continue;
    if (finding.type !== "implementation" && finding.type !== "spec" && finding.type !== "mixed") continue;
    const id = finding.id;
    result.push({
      id,
      type: finding.type,
      finding,
      decision: latestCodeReviewDecision(events, codeReviewDecisionScope(jobId, id)),
    });
  }
  return result;
}

export function latestCodeReviewFailedStatus(events: Event[]): CodeReviewFailedStatus | null {
  const facts = collectCodeReviewGateFacts(events);
  const terminal = facts.latestTerminal;
  if (!terminal || terminal.state !== "rejected" || terminal.result_kind !== "review_failed") return null;
  const findings = blockingFindingsFromReviewFailed(terminal.event, terminal.job.job_id, events);
  const dismissed = findings.filter(item => item.decision?.answer === "dismiss");
  const unresolved = findings.filter(item => item.decision?.answer !== "dismiss");
  return { terminal, findings, unresolved, dismissed };
}

export function dismissedCodeReviewSummary(status: CodeReviewFailedStatus): string {
  const details = status.dismissed
    .map(item => `${item.id}：${item.decision?.reason || "主流程已驳回该问题"}`)
    .join("；");
  return details
    ? `上一次代码审查提出的问题已被主流程复核驳回：${details}。没有新的具体证据时，不要重复提出同一问题。`
    : "上一次代码审查提出的问题已被主流程复核驳回。没有新的具体证据时，不要重复提出同一问题。";
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

/** Latest code-review gate fact for the current review cycle, frozen into verifier packets. */
export function latestCodeReviewGateEvidence(events: Event[]): CodeReviewGateEvidence | null {
  for (let i = events.length - 1; i >= 0; i--) {
    const event = events[i];
    if (event.event_type !== "transition_commit") continue;
    const payload = event.payload as {
      transition?: unknown;
      from_state?: unknown;
      to_state?: unknown;
      code_review_gate?: unknown;
    };
    if (payload.transition !== "review-ready" || payload.from_state !== "apply_done" || payload.to_state !== "review") continue;
    const gate = payload.code_review_gate as { decision?: unknown; job_id?: unknown; packet_digest?: unknown; reason?: unknown } | undefined;
    if (!gate || (gate.decision !== "passed" && gate.decision !== "skipped")) return null;
    return {
      decision: gate.decision,
      job_id: typeof gate.job_id === "string" ? gate.job_id : null,
      packet_digest: typeof gate.packet_digest === "string" ? gate.packet_digest : null,
      ...(gate.reason === "no_code_changes" ? { reason: gate.reason } : {}),
      event_id: event.event_id,
      event_digest: event.event_digest,
    };
  }
  return null;
}

export function requiresFinalVerifierForCurrentReview(events: Event[]): boolean {
  return latestApplyDoneToReviewGate(events) != null;
}

function findJobInEvents(events: Event[], jobId: string): Job | null {
  for (const ev of events) {
    if (ev.event_type !== "transition_commit") continue;
    const jobs = (ev.payload as { new_jobs?: Job[] }).new_jobs ?? [];
    const job = jobs.find(item => item.job_id === jobId);
    if (job) return job;
  }
  return null;
}

function latestApplyDoneToReviewGatePayload(events: Event[]): { decision: "passed" | "skipped"; job_id?: string; current_head?: string | null; head?: string | null } | null {
  for (let i = events.length - 1; i >= 0; i--) {
    const ev = events[i];
    if (ev.event_type !== "transition_commit") continue;
    const payload = ev.payload as { transition?: unknown; from_state?: unknown; to_state?: unknown; code_review_gate?: unknown };
    if (payload.transition !== "review-ready" || payload.from_state !== "apply_done" || payload.to_state !== "review") continue;
    const gate = payload.code_review_gate as { decision?: unknown; job_id?: unknown; current_head?: unknown; head?: unknown } | undefined;
    if (!gate || (gate.decision !== "passed" && gate.decision !== "skipped")) return null;
    return {
      decision: gate.decision,
      ...(typeof gate.job_id === "string" ? { job_id: gate.job_id } : {}),
      ...(typeof gate.current_head === "string" || gate.current_head === null ? { current_head: gate.current_head } : {}),
      ...(typeof gate.head === "string" || gate.head === null ? { head: gate.head } : {}),
    };
  }
  return null;
}

export function computeCodeStateCheck(projectRoot: string, events: Event[], ignoredCodePaths: string[] = []): CodeStateCheck {
  const gate = latestApplyDoneToReviewGatePayload(events);
  const currentHead = currentGitHead(projectRoot);
  const baselineHead = gate?.decision === "passed" ? gate.current_head ?? null : gate?.head ?? null;
  const changed = new Set<string>();
  const ignored = new Set(ignoredCodePaths);
  const reviewedJob = gate?.decision === "passed" && gate.job_id ? findJobInEvents(events, gate.job_id) : null;
  for (const ev of events) {
    if (ev.event_type !== "job_accepted" && ev.event_type !== "job_rejected") continue;
    const payload = ev.payload as { report_path?: unknown };
    if (typeof payload.report_path === "string") ignored.add(payload.report_path);
  }
  let scopeReason = gate ? "ok" : "missing_code_review_gate";

  if (baselineHead && currentHead.head && baselineHead !== currentHead.head) {
    const diff = gitLines(projectRoot, ["diff", "--name-only", `${baselineHead}..HEAD`]);
    if (diff.ok) {
      for (const path of uniqSorted(diff.lines)) changed.add(path);
    } else {
      scopeReason = `git diff ${baselineHead}..HEAD failed: ${diff.reason}`;
    }
  } else if (!baselineHead && gate && currentHead.head) {
    const tree = gitLines(projectRoot, ["ls-tree", "-r", "--name-only", "HEAD"]);
    if (tree.ok) {
      for (const path of uniqSorted(tree.lines)) changed.add(path);
    } else {
      scopeReason = `git ls-tree HEAD failed: ${tree.reason}`;
    }
  }

  // bound 基线与当前磁盘状态共用 {path,status,sha256} 指纹原语对比：
  // 基线是 code review 时点的 bound 文件指纹；当前侧取 bound 路径与脏代码文件的并集。
  // gate skipped 时基线为空，任何脏代码文件都会作为差异列出。
  const baselineFingerprints: DirtyFileFingerprint[] = (reviewedJob?.boundFiles ?? [])
    .map(bound => ({ path: bound.path, status: "modified" as const, sha256: bound.sha }));
  const baselinePaths = new Set(baselineFingerprints.map(file => file.path));
  // ignored（审查报告文件等）只豁免 bound 集合之外的新脏文件，bound 文件本身的变化仍需暴露
  const currentPaths = new Set([
    ...baselinePaths,
    ...scanCodeChanges(projectRoot).paths.filter(path => !ignored.has(path)),
  ]);
  // 缺失文件用与 bound 基线一致的 "sha256:missing" 占位：review 时点就缺失、现在仍缺失的文件不算差异
  const currentFingerprints: DirtyFileFingerprint[] = [...currentPaths].map(path => ({
    path,
    status: "modified" as const,
    sha256: codeFileContentSha(projectRoot, path) ?? "sha256:missing",
  }));
  for (const path of diffFingerprints(baselineFingerprints, currentFingerprints)) changed.add(path);

  return {
    baseline_head: baselineHead,
    current_head: currentHead.head,
    head_matches: baselineHead === currentHead.head,
    changed_paths: [...changed].filter(isCodeLikePath).sort(),
    scope_reason: scopeReason,
  };
}
