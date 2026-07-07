// SuperSpec review helpers: policy, verifier freshness, evidence digest

import { existsSync } from "node:fs";
import { join } from "node:path";
import { docRef, sha256File, sha256Text } from "./store.ts";
import { REVIEW_FINAL_VERIFIER_GATE } from "./review_job_gates.ts";
import type { Event, Job, Ref, TaskAttempt } from "./types.ts";

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
  ".superspec/artifacts/business-invariants.md",
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
  event_digest: string;
}

interface EvidenceRecord {
  kind: "task_completed" | "test_run_recorded";
  task_id?: string;
  attempt_id?: string | null;
  task_structure_digest?: string | null;
  test_id?: string | null;
  semantic_status?: string | null;
  covers_task_ids?: string[];
  command?: string;
  cwd?: string;
  exit_code?: number | null;
  target_fingerprint?: string | null;
  event_digest: string;
}

function evidenceSortKey(record: EvidenceRecord): string {
  const parts = [
    record.kind,
    record.task_id ?? "",
    record.attempt_id ?? "",
    record.task_structure_digest ?? "",
    record.test_id ?? "",
    record.semantic_status ?? "",
  ];
  if (record.covers_task_ids && record.covers_task_ids.length > 0) {
    parts.push(`covers:${JSON.stringify(record.covers_task_ids)}`);
  }
  parts.push(
    record.command ?? "",
    record.cwd ?? "",
    record.exit_code == null ? "" : String(record.exit_code),
    record.target_fingerprint ?? "",
    record.event_digest,
  );
  return parts.join("\u0000");
}

function normalizedCoveredTaskIds(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return [...new Set(
    value
      .filter((item): item is string => typeof item === "string")
      .map(item => item.trim())
      .filter(Boolean),
  )].sort();
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

  const records: EvidenceRecord[] = completed.map(item => ({
    kind: "task_completed",
    task_id: item.task_id,
    attempt_id: item.attempt_id,
    task_structure_digest: item.task_structure_digest,
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

    const coversTaskIds = normalizedCoveredTaskIds(payload.covers_task_ids);
    records.push({
      kind: "test_run_recorded",
      test_id: typeof payload.test_id === "string" ? payload.test_id : null,
      attempt_id: attemptId,
      task_structure_digest: structureDigest,
      semantic_status: typeof payload.semantic_status === "string" ? payload.semantic_status : null,
      ...(coversTaskIds.length > 0 ? { covers_task_ids: coversTaskIds } : {}),
      command: typeof payload.command === "string" ? payload.command : "",
      cwd: typeof payload.cwd === "string" ? payload.cwd : "",
      exit_code: typeof payload.exit_code === "number" ? payload.exit_code : null,
      target_fingerprint: typeof payload.target_fingerprint === "string" ? payload.target_fingerprint : null,
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

export function reviewVerifierStaleReason(job: Job, changeRoot: string, currentEvidenceDigest: string): string | null {
  return boundFilesStaleReason(job, changeRoot) ?? reviewEvidenceStaleReason(job, currentEvidenceDigest);
}

export function isFreshReviewVerifier(job: Job, changeRoot: string, currentEvidenceDigest: string): boolean {
  return isReviewReadyVerifier(job) && reviewVerifierStaleReason(job, changeRoot, currentEvidenceDigest) == null;
}
