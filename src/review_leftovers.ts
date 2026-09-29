// 审查遗留意见：最近一次通过的代码审查与最终验证报告中不阻塞推进的 finding 与 risks。
// 它们不进门禁，但 pass 之后只存在于 raw 记录里，交付时必须交给使用者判断。

import { readRawRecord, type RawRecordRef } from "./store.ts";
import type { Event, Job, JobRole, ReviewJobGateId, ReviewLeftoverItem, ReviewLeftovers } from "./types.ts";

const LEFTOVER_GATES: ReviewJobGateId[] = ["review.code_review", "review.final_verifier"];
const TEXT_FIELDS = ["description", "issue", "claim", "summary", "risk", "text"] as const;

const REVIEW_LEFTOVERS_INSTRUCTION =
  "这些是最近一次通过的代码审查与最终验证中不阻塞推进的意见；交付时用自然语言逐条告诉使用者，由使用者决定是否处理，不要自行当作新需求实现。";

function textOf(value: unknown): string | null {
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

function reportLeftovers(role: JobRole, jobId: string, report: Record<string, unknown>): ReviewLeftoverItem[] {
  const items: ReviewLeftoverItem[] = [];
  for (const raw of Array.isArray(report.findings) ? report.findings : []) {
    if ((raw as { blocking?: unknown } | null)?.blocking === true) continue;
    const text = textOf(raw);
    if (!text) continue;
    const id = (raw as { id?: unknown }).id;
    items.push({ role, job_id: jobId, kind: "finding", ...(typeof id === "string" && id ? { id } : {}), text });
  }
  for (const raw of Array.isArray(report.risks) ? report.risks : []) {
    const text = textOf(raw);
    if (text) items.push({ role, job_id: jobId, kind: "risk", text });
  }
  return items;
}

/** 每个交付 gate 取最近一次被接受的报告；没有任何遗留意见时返回 null，调用方不输出该字段。 */
export function reviewLeftovers(projectRoot: string, change: string, events: Event[]): ReviewLeftovers | null {
  const jobs = jobsById(events);
  const items: ReviewLeftoverItem[] = [];
  for (const gate of LEFTOVER_GATES) {
    const accepted = events.findLast(ev => {
      if (ev.event_type !== "job_accepted") return false;
      const job = jobs.get(String((ev.payload as { job_id?: unknown }).job_id ?? ""));
      return job?.gate_id === gate;
    });
    if (!accepted) continue;
    const payload = accepted.payload as Record<string, unknown>;
    const job = jobs.get(String(payload.job_id))!;
    const ref = rawRefOf(payload);
    const report = ref ? readRawRecord(projectRoot, change, ref) : null;
    if (!report || typeof report !== "object" || Array.isArray(report)) continue;
    items.push(...reportLeftovers(job.role, job.job_id, report as Record<string, unknown>));
  }
  return items.length > 0 ? { items, instruction: REVIEW_LEFTOVERS_INSTRUCTION } : null;
}
