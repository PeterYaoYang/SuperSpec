// 审查遗留意见：本轮 Apply 以来代码审查与最终验证报告中不阻塞推进的 finding 与 risks。
// 它们不进门禁，只存在于 raw 记录里；fail 轮提出、后续报告不再重复的意见也不能丢，交付时交给使用者判断。

import { readRawRecord, type RawRecordRef } from "./store.ts";
import type { Event, Job, JobRole, ReviewJobGateId, ReviewLeftoverItem, ReviewLeftovers } from "./types.ts";

const LEFTOVER_GATES: ReadonlySet<ReviewJobGateId> = new Set(["review.code_review", "review.final_verifier"]);
const SUBSTANTIVE_REJECTIONS = new Set(["review_failed", "non_actionable_report"]);
// 要求 description 之前登记的报告用过其他字段名写问题内容。
const TEXT_FIELDS = ["description", "issue", "claim", "summary", "risk", "text"] as const;

const REVIEW_LEFTOVERS_INSTRUCTION =
  "这些是本轮代码审查与最终验证中不阻塞推进的意见；较早轮次提出的可能已在后续修复中处理，交付前核对是否仍然存在，再用自然语言逐条告诉使用者，由使用者决定是否处理，不要自行当作新需求实现。";

/** finding 或 risk 写明的问题内容；只有 id 等标识时返回 null。 */
export function findingText(value: unknown): string | null {
  if (typeof value === "string") return value.trim() || null;
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  for (const field of TEXT_FIELDS) {
    const text = record[field];
    if (typeof text === "string" && text.trim()) return text.trim();
  }
  return null;
}

function jobsById(events: Event[]): Map<string, Job> {
  const jobs = new Map<string, Job>();
  for (const ev of events) {
    if (ev.event_type !== "transition_commit") continue;
    for (const job of (ev.payload as { new_jobs?: Job[] }).new_jobs ?? []) jobs.set(job.job_id, job);
  }
  return jobs;
}

function rawRefOf(payload: Record<string, unknown>): RawRecordRef | null {
  const { raw_kind, raw_index, raw_digest } = payload;
  if (typeof raw_kind !== "string" || typeof raw_index !== "number" || typeof raw_digest !== "string") return null;
  return { raw_kind, raw_index, raw_digest } as RawRecordRef;
}

function isStartApplyCommit(ev: Event): boolean {
  return ev.event_type === "transition_commit" &&
    (ev.payload as { transition?: unknown }).transition === "start-apply";
}

/** 结论已登记的报告：通过，或给出了实质结论的 fail；格式无效被终结的报告不算。 */
function isSubstantiveReport(ev: Event): boolean {
  if (ev.event_type === "job_accepted") return true;
  return ev.event_type === "job_rejected" &&
    SUBSTANTIVE_REJECTIONS.has(String((ev.payload as { result_kind?: unknown }).result_kind));
}

function reportLeftovers(role: JobRole, jobId: string, report: Record<string, unknown>): ReviewLeftoverItem[] {
  const items: ReviewLeftoverItem[] = [];
  for (const raw of Array.isArray(report.findings) ? report.findings : []) {
    if ((raw as { blocking?: unknown } | null)?.blocking === true) continue;
    const text = findingText(raw);
    if (!text) continue;
    const id = (raw as { id?: unknown }).id;
    items.push({ role, job_id: jobId, kind: "finding", ...(typeof id === "string" && id ? { id } : {}), text });
  }
  for (const raw of Array.isArray(report.risks) ? report.risks : []) {
    const text = findingText(raw);
    if (text) items.push({ role, job_id: jobId, kind: "risk", text });
  }
  return items;
}

/** 本轮 Apply 以来各次交付审查报告的遗留意见，按内容去重；没有时返回 null，调用方不输出该字段。 */
export function reviewLeftovers(projectRoot: string, change: string, events: Event[]): ReviewLeftovers | null {
  const jobs = jobsById(events);
  const items: ReviewLeftoverItem[] = [];
  const seen = new Set<string>();
  for (const ev of events.slice(Math.max(0, events.findLastIndex(isStartApplyCommit)))) {
    if (!isSubstantiveReport(ev)) continue;
    const payload = ev.payload as Record<string, unknown>;
    const job = jobs.get(String(payload.job_id ?? ""));
    if (!job?.gate_id || !LEFTOVER_GATES.has(job.gate_id as ReviewJobGateId)) continue;
    const ref = rawRefOf(payload);
    const report = ref ? readRawRecord(projectRoot, change, ref) : null;
    if (!report || typeof report !== "object" || Array.isArray(report)) continue;
    for (const item of reportLeftovers(job.role, job.job_id, report as Record<string, unknown>)) {
      const key = `${item.role}\u0000${item.kind}\u0000${item.text}`;
      if (seen.has(key)) continue;
      seen.add(key);
      items.push(item);
    }
  }
  return items.length > 0 ? { items, instruction: REVIEW_LEFTOVERS_INSTRUCTION } : null;
}
