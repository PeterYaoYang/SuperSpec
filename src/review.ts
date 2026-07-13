// SuperSpec review helpers: policy, verifier freshness, evidence digest

import { existsSync } from "node:fs";
import { join } from "node:path";
import { docRef, sha256File, sha256Text } from "./store.ts";
import {
  EXPLORE_DISCOVERY_REVIEW_GATE_ID,
  PROPOSE_FINAL_REVIEW_GATE,
  PROPOSE_FINAL_REVIEW_GATE_ID,
  REVIEW_FINAL_VERIFIER_GATE,
  type ReviewGateRule,
} from "./review_job_gates.ts";
import type { CodeReviewResultKind, Event, Job, JobRole, Ref, ReviewPreviousRejection, State, TaskAttempt } from "./types.ts";
import { computeCodeStateCheck, effectiveCoverageExemptionRefsFromEvents } from "./code_review.ts";

export type ReviewRisk = "minimal" | "normal" | "strict";

export interface ReviewPolicy {
  review_risk: ReviewRisk;
  requires_verifier: boolean;
}

export const REVIEW_DOC_PATHS = [
  "proposal.md",
  "tasks.md",
  "design.md",
  "specs/",
  ".superspec/artifacts/discovery.md",
  ".superspec/artifacts/test-contract.md",
];

const CORE_COMMIT_FIELDS = new Set([
  "transition",
  "from_state",
  "to_state",
  "outcome",
  "created_job_ids",
  "new_jobs",
  "reason",
]);

export function assertCommitPayloadExtension(payload: Record<string, unknown>): void {
  for (const key of Object.keys(payload)) {
    if (CORE_COMMIT_FIELDS.has(key)) {
      throw new Error(`commitPayload 不能覆盖核心字段：${key}`);
    }
  }
}

export function reviewPolicyForRisk(risk: ReviewRisk): ReviewPolicy {
  return {
    review_risk: risk,
    requires_verifier: risk !== "minimal",
  };
}

function isReviewPolicy(value: unknown): value is ReviewPolicy {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const obj = value as { review_risk?: unknown; requires_verifier?: unknown };
  return (
    (obj.review_risk === "minimal" || obj.review_risk === "normal" || obj.review_risk === "strict") &&
    typeof obj.requires_verifier === "boolean"
  );
}

export function readReviewPolicyFromEvents(events: Event[]): ReviewPolicy | null {
  for (const ev of events) {
    if (ev.event_type !== "transition_commit") continue;
    const payload = ev.payload as { transition?: unknown; review_policy?: unknown };
    if (payload.transition !== "review-ready") continue;
    if (isReviewPolicy(payload.review_policy)) return payload.review_policy;
  }
  return null;
}

function reviewResultKind(value: unknown): CodeReviewResultKind | null {
  return value === "invalid_report" || value === "non_actionable_report" || value === "review_failed"
    ? value
    : null;
}

export const REVIEW_REJECTION_OVERRIDE_SCOPE_PREFIX = "review_rejection_override:";
export const REVIEW_REJECTION_OVERRIDE_ANSWER = "do_not_block";

export type ReviewRejectionDecisionSource = "main_process" | "user";

export interface ReviewRejectionOverrideAudit {
  job_id: string;
  role: JobRole;
  gate_id: ReviewGateRule["gate_id"];
  packet_digest: string;
  decision_source: ReviewRejectionDecisionSource;
  reason: string;
  decision_event_id: string;
  decision_event_digest: string;
}

export function reviewRejectionOverrideScope(jobId: string): string {
  return `${REVIEW_REJECTION_OVERRIDE_SCOPE_PREFIX}${jobId}`;
}

export function parseReviewRejectionOverrideScope(scope: string): string | null {
  if (!scope.startsWith(REVIEW_REJECTION_OVERRIDE_SCOPE_PREFIX)) return null;
  const jobId = scope.slice(REVIEW_REJECTION_OVERRIDE_SCOPE_PREFIX.length).trim();
  return jobId === "" ? null : jobId;
}

function reviewCycleState(gate: ReviewGateRule): State | null {
  if (gate.gate_id === EXPLORE_DISCOVERY_REVIEW_GATE_ID) return "explore";
  if (gate.gate_id === PROPOSE_FINAL_REVIEW_GATE_ID) return "propose";
  return null;
}

function currentReviewGateCycleStart(events: Event[], gate: ReviewGateRule): number | null {
  const state = reviewCycleState(gate);
  if (!state) return null;
  for (let i = events.length - 1; i >= 0; i--) {
    const event = events[i];
    if (event.event_type !== "transition_commit") continue;
    const payload = event.payload as { from_state?: unknown; to_state?: unknown };
    if (payload.to_state === state && payload.from_state !== state) return i;
  }
  return 0;
}

export interface ReviewTerminalResult {
  job: Job;
  event: Event;
  state: "accepted" | "rejected";
  result_kind?: CodeReviewResultKind;
  reason?: string;
  findings?: unknown[];
}

function reviewTerminalResultsForGateRole(
  events: Event[],
  gate: ReviewGateRule,
  role: JobRole,
): ReviewTerminalResult[] {
  const cycleStartIndex = currentReviewGateCycleStart(events, gate);
  if (cycleStartIndex == null) return [];
  const jobsById = new Map<string, Job>();

  for (let i = cycleStartIndex; i < events.length; i++) {
    const event = events[i];
    if (event.event_type !== "transition_commit") continue;
    const jobs = (event.payload as { new_jobs?: Job[] }).new_jobs ?? [];
    for (const job of jobs) {
      if (job.role === role && gate.isJobForGate(job)) jobsById.set(job.job_id, job);
    }
  }

  const results: ReviewTerminalResult[] = [];
  for (let i = cycleStartIndex; i < events.length; i++) {
    const event = events[i];
    if (event.event_type !== "job_accepted" && event.event_type !== "job_rejected") continue;
    const payload = event.payload as { job_id?: unknown; result_kind?: unknown; reason?: unknown; findings?: unknown };
    if (typeof payload.job_id !== "string") continue;
    const job = jobsById.get(payload.job_id);
    if (!job) continue;
    const findings = Array.isArray(payload.findings) ? payload.findings : undefined;
    results.push({
      job,
      event,
      state: event.event_type === "job_accepted" ? "accepted" : "rejected",
      ...(event.event_type === "job_rejected"
        ? { result_kind: reviewResultKind(payload.result_kind) ?? (findings ? "review_failed" : "invalid_report") }
        : {}),
      ...(typeof payload.reason === "string" && payload.reason.trim() !== "" ? { reason: payload.reason } : {}),
      ...(findings ? { findings } : {}),
    });
  }
  return results;
}

export function latestReviewTerminalForGateRole(
  events: Event[],
  gate: ReviewGateRule,
  role: JobRole,
): ReviewTerminalResult | null {
  return reviewTerminalResultsForGateRole(events, gate, role).at(-1) ?? null;
}

function validReviewRejectionOverridePayload(
  event: Event,
  terminal: ReviewTerminalResult,
  gate: ReviewGateRule,
): ReviewRejectionOverrideAudit | null {
  if (event.event_type !== "user_decision_recorded") return null;
  const payload = event.payload as {
    accepted?: unknown;
    scope?: unknown;
    answer?: unknown;
    reason?: unknown;
    decision_source?: unknown;
    review_rejection_override?: unknown;
  };
  if (
    payload.accepted !== true ||
    payload.scope !== reviewRejectionOverrideScope(terminal.job.job_id) ||
    payload.answer !== REVIEW_REJECTION_OVERRIDE_ANSWER ||
    (payload.decision_source !== "main_process" && payload.decision_source !== "user") ||
    typeof payload.reason !== "string" || payload.reason.trim() === "" ||
    !payload.review_rejection_override ||
    typeof payload.review_rejection_override !== "object" ||
    Array.isArray(payload.review_rejection_override)
  ) return null;
  const audit = payload.review_rejection_override as {
    job_id?: unknown;
    role?: unknown;
    gate_id?: unknown;
    packet_digest?: unknown;
  };
  if (
    audit.job_id !== terminal.job.job_id ||
    audit.role !== terminal.job.role ||
    audit.gate_id !== gate.gate_id ||
    audit.packet_digest !== terminal.job.packet_digest
  ) return null;
  return {
    job_id: terminal.job.job_id,
    role: terminal.job.role,
    gate_id: gate.gate_id,
    packet_digest: terminal.job.packet_digest,
    decision_source: payload.decision_source,
    reason: payload.reason.trim(),
    decision_event_id: event.event_id,
    decision_event_digest: event.event_digest,
  };
}

export function effectiveReviewRejectionOverride(
  events: Event[],
  gate: ReviewGateRule,
  terminal: ReviewTerminalResult,
): ReviewRejectionOverrideAudit | null {
  const cycleStartIndex = currentReviewGateCycleStart(events, gate);
  if (cycleStartIndex == null) return null;
  const terminalIndex = events.findIndex(event => event.event_id === terminal.event.event_id);
  if (terminalIndex < cycleStartIndex) return null;
  for (let i = events.length - 1; i > terminalIndex; i--) {
    const audit = validReviewRejectionOverridePayload(events[i], terminal, gate);
    if (audit) return audit;
  }
  return null;
}

export type ReviewGateRoleResolution =
  | { kind: "none" }
  | { kind: "stale"; terminal: ReviewTerminalResult; stale_reason: string }
  | { kind: "accepted"; terminal: ReviewTerminalResult }
  | { kind: "rejected_invalid"; terminal: ReviewTerminalResult }
  | { kind: "rejected_pending"; terminal: ReviewTerminalResult }
  | { kind: "overridden"; terminal: ReviewTerminalResult; override: ReviewRejectionOverrideAudit };

export function reviewGateRoleResolution(
  events: Event[],
  changeRoot: string,
  gate: ReviewGateRule,
  role: JobRole,
): ReviewGateRoleResolution {
  const terminal = latestReviewTerminalForGateRole(events, gate, role);
  if (!terminal) return { kind: "none" };
  const staleReason = boundFilesStaleReason(terminal.job, changeRoot);
  if (staleReason) return { kind: "stale", terminal, stale_reason: staleReason };
  if (terminal.state === "accepted") return { kind: "accepted", terminal };
  if (terminal.result_kind !== "review_failed") return { kind: "rejected_invalid", terminal };
  const override = effectiveReviewRejectionOverride(events, gate, terminal);
  return override
    ? { kind: "overridden", terminal, override }
    : { kind: "rejected_pending", terminal };
}

export function latestReviewHistoryForGateRole(
  events: Event[],
  gate: ReviewGateRule,
  role: JobRole,
): ReviewPreviousRejection | null {
  const terminalResults = reviewTerminalResultsForGateRole(events, gate, role);
  const latest = terminalResults.at(-1);
  if (!latest || latest.state === "accepted") return null;

  const resultKind = latest.result_kind ?? "invalid_report";
  const reason = latest.reason ?? (
    resultKind === "review_failed"
      ? "报告结论为 fail，工作项未通过"
      : "审查报告无效，工作项未通过"
  );
  if (resultKind === "review_failed" && latest.findings && latest.findings.length > 0) {
    return {
      result_kind: resultKind,
      reason,
      job_id: latest.job.job_id,
      ...(latest.findings ? { findings: latest.findings } : {}),
    };
  }

  for (let i = terminalResults.length - 2; i >= 0; i--) {
    const previous = terminalResults[i];
    if (previous.state === "accepted") break;
    if (previous.result_kind !== "review_failed" || !previous.findings || previous.findings.length === 0) continue;
    return {
      result_kind: resultKind,
      reason,
      job_id: latest.job.job_id,
      ...(previous.findings ? { findings: previous.findings } : {}),
      findings_job_id: previous.job.job_id,
    };
  }

  return {
    result_kind: resultKind,
    reason,
    job_id: latest.job.job_id,
  };
}

export function historicalProposeReadyRoles(events: Event[]): JobRole[] {
  const roles = new Set<JobRole>();
  for (const event of events) {
    if (event.event_type !== "transition_commit") continue;
    const jobs = (event.payload as { new_jobs?: Job[] }).new_jobs ?? [];
    for (const job of jobs) {
      if (
        PROPOSE_FINAL_REVIEW_GATE.isJobForGate(job) &&
        (job.role === "critic" || job.role === "architect" || job.role === "test-engineer")
      ) roles.add(job.role);
    }
  }
  return [...roles];
}

export function isReviewReadyVerifier(job: Job): boolean {
  return job.role === "verifier" && REVIEW_FINAL_VERIFIER_GATE.isJobForGate(job);
}

export function reviewBoundFiles(changeRoot: string): Ref[] {
  // 目录路径（以 / 结尾）始终绑定聚合指纹，与 boundFilesStaleReason 的 docRef 比对保持一致
  return REVIEW_DOC_PATHS
    .filter(path => path.endsWith("/") || existsSync(join(changeRoot, path)))
    .map(path => docRef(changeRoot, path));
}

interface CompletedAttempt {
  task_id: string;
  attempt_id: string;
  task_structure_digest: string | null;
  event_id: string;
  event_digest: string;
}

// 方案固定的 records 形态：只序列化方案规定的字段；
// legacy 字段（task_structure_digest / covers_task_ids / target_fingerprint）只参与筛选，不进入 digest 本体
interface EvidenceRecord {
  kind: "task_completed" | "test_run_recorded" | "coverage_exemption" | "code_review_gate";
  event_id?: string;
  task_id?: string;
  attempt_id?: string | null;
  test_id?: string | null;
  decision?: string | null;
  job_id?: string | null;
  packet_digest?: string | null;
  semantic_status?: string | null;
  command?: string;
  cwd?: string;
  exit_code?: number | null;
  event_digest: string;
}

// 方案排序键：kind → task_id → test_id → attempt_id → event_id；缺失字段按空字符串。
// event_id 全局唯一，作为末位排序键足以保证稳定。
function evidenceSortKey(record: EvidenceRecord): string {
  return [
    record.kind,
    record.task_id ?? "",
    record.test_id ?? "",
    record.attempt_id ?? "",
    record.event_id ?? "",
  ].join("\u0000");
}

export function reviewEvidenceDigest(events: Event[]): string {
  const attemptsById = new Map<string, TaskAttempt>();
  const completed: CompletedAttempt[] = [];

  for (const ev of events) {
    if (ev.event_type === "task_started") {
      const attempt = ev.payload as unknown as TaskAttempt;
      attemptsById.set(attempt.attempt_id, attempt);
    } else if (ev.event_type === "task_completed") {
      const payload = ev.payload as { task_id?: unknown; attempt_id?: unknown };
      if (typeof payload.task_id !== "string" || typeof payload.attempt_id !== "string") continue;
      const attempt = attemptsById.get(payload.attempt_id);
      completed.push({
        task_id: payload.task_id,
        attempt_id: payload.attempt_id,
        task_structure_digest: attempt?.task_structure_digest ?? null,
        event_id: ev.event_id,
        event_digest: ev.event_digest,
      });
    }
  }

  const completedAttemptIds = new Set(completed.map(item => item.attempt_id));
  const completedStructureDigests = new Set(
    completed
      .map(item => item.task_structure_digest)
      .filter((digest): digest is string => typeof digest === "string" && digest.length > 0),
  );

  // scope_note / boundary_snapshot / checkbox_update 属于 task_completed 事件 payload，已由 event_digest 覆盖
  const records: EvidenceRecord[] = completed.map(item => ({
    kind: "task_completed",
    task_id: item.task_id,
    attempt_id: item.attempt_id,
    event_id: item.event_id,
    event_digest: item.event_digest,
  }));

  for (const ev of events) {
    if (ev.event_type !== "test_run_recorded") continue;
    const payload = ev.payload as {
      test_id?: unknown;
      attempt_id?: unknown;
      task_structure_digest?: unknown;
      semantic_status?: unknown;
      covers_task_ids?: unknown;
      command?: unknown;
      cwd?: unknown;
      exit_code?: unknown;
      target_fingerprint?: unknown;
    };
    const attemptId = typeof payload.attempt_id === "string" ? payload.attempt_id : null;
    const structureDigest = typeof payload.task_structure_digest === "string" ? payload.task_structure_digest : null;
    const matchesCompletedAttempt = attemptId != null && completedAttemptIds.has(attemptId);
    const matchesLegacyDigest = attemptId == null && structureDigest != null && completedStructureDigests.has(structureDigest);
    if (!matchesCompletedAttempt && !matchesLegacyDigest) continue;

    records.push({
      kind: "test_run_recorded",
      test_id: typeof payload.test_id === "string" ? payload.test_id : null,
      attempt_id: attemptId,
      semantic_status: typeof payload.semantic_status === "string" ? payload.semantic_status : null,
      exit_code: typeof payload.exit_code === "number" ? payload.exit_code : null,
      command: typeof payload.command === "string" ? payload.command : "",
      cwd: typeof payload.cwd === "string" ? payload.cwd : "",
      event_id: ev.event_id,
      event_digest: ev.event_digest,
    });
  }

  for (const ref of effectiveCoverageExemptionRefsFromEvents(events)) {
    records.push({
      kind: "coverage_exemption",
      test_id: ref.test_id,
      event_id: ref.event_id,
      event_digest: ref.event_digest,
    });
  }

  for (const ev of events) {
    if (ev.event_type !== "transition_commit") continue;
    const payload = ev.payload as { transition?: unknown; from_state?: unknown; to_state?: unknown; code_review_gate?: unknown };
    if (payload.transition !== "review-ready" || payload.from_state !== "apply_done" || payload.to_state !== "review") continue;
    const gate = payload.code_review_gate as { decision?: unknown; job_id?: unknown; packet_digest?: unknown } | undefined;
    if (!gate || (gate.decision !== "passed" && gate.decision !== "skipped")) continue;
    records.push({
      kind: "code_review_gate",
      decision: gate.decision,
      job_id: typeof gate.job_id === "string" ? gate.job_id : null,
      packet_digest: typeof gate.packet_digest === "string" ? gate.packet_digest : null,
      event_id: ev.event_id,
      event_digest: ev.event_digest,
    });
  }

  records.sort((a, b) => evidenceSortKey(a).localeCompare(evidenceSortKey(b)));
  return sha256Text(JSON.stringify(records));
}

export function boundFilesStaleReason(job: Job, changeRoot: string): string | null {
  for (const bf of job.boundFiles) {
    // 目录绑定（path 以 / 结尾）比对聚合指纹，覆盖目录内文件的增/删/改
    const current = docRef(changeRoot, bf.path).sha;
    if (current !== bf.sha) {
      return `绑定文件 ${bf.path} 已变化（${bf.sha} → ${current}）`;
    }
  }
  return null;
}

export function reviewEvidenceStaleReason(job: Job, currentDigest: string): string | null {
  if (!isReviewReadyVerifier(job)) return null;
  if (!job.review_evidence_digest) return "最终验证工作项缺少执行证据版本";
  if (job.review_evidence_digest !== currentDigest) {
    return `最终验证执行证据版本已变化（${job.review_evidence_digest} → ${currentDigest}）`;
  }
  return null;
}

export function codeStateCheckStaleReason(
  job: Job,
  projectRoot: string | undefined,
  events: Event[] | undefined,
  ignoredCodePaths: string[] = [],
): string | null {
  if (!isReviewReadyVerifier(job)) return null;
  if (!job.packet_context?.code_state_check) return null;
  if (!projectRoot || !events) return null;
  const current = computeCodeStateCheck(projectRoot, events, ignoredCodePaths);
  if (JSON.stringify(current) !== JSON.stringify(job.packet_context.code_state_check)) {
    return "最终验证工作项的代码状态事实已变化";
  }
  return null;
}

export function reviewVerifierStaleReason(
  job: Job,
  changeRoot: string,
  currentEvidenceDigest: string,
  projectRoot?: string,
  events?: Event[],
  ignoredCodePaths: string[] = [],
): string | null {
  return boundFilesStaleReason(job, changeRoot)
    ?? reviewEvidenceStaleReason(job, currentEvidenceDigest)
    ?? codeStateCheckStaleReason(job, projectRoot, events, ignoredCodePaths);
}

export function isFreshReviewVerifier(
  job: Job,
  changeRoot: string,
  currentEvidenceDigest: string,
  projectRoot?: string,
  events?: Event[],
): boolean {
  return isReviewReadyVerifier(job) && reviewVerifierStaleReason(job, changeRoot, currentEvidenceDigest, projectRoot, events) == null;
}
