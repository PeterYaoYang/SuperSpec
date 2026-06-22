// SuperSpec 流程引擎 — 存储层：路径、指纹、事件日志、快照、锁

import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync, openSync, closeSync, unlinkSync, statSync, renameSync } from "node:fs";
import { join, dirname } from "node:path";
import { hostname } from "node:os";
import type { Event, Snapshot, Ref } from "./types.ts";

// ===== 路径 =====

export const RAW_RECORD_KINDS = ["test-runs", "review-reports", "user-decisions"] as const;
export type RawRecordKind = typeof RAW_RECORD_KINDS[number];

export interface RawRecordRef {
  raw_kind: RawRecordKind;
  raw_index: number;
  raw_digest: string;
}

export function engineRoot(projectRoot: string): string {
  return join(projectRoot, ".superspec");
}

export function changeDir(projectRoot: string, change: string): string {
  return join(engineRoot(projectRoot), "changes", change);
}

export function eventsFile(projectRoot: string, change: string): string {
  return join(changeDir(projectRoot, change), "events.jsonl");
}

export function rawFile(projectRoot: string, change: string, kind: RawRecordKind): string {
  return join(changeDir(projectRoot, change), "raw", `${kind}.jsonl`);
}

export function snapshotFile(projectRoot: string, change: string): string {
  return join(changeDir(projectRoot, change), "snapshot.json");
}

export function lockFile(projectRoot: string, change: string): string {
  return join(changeDir(projectRoot, change), "lock");
}

export function stagingDir(projectRoot: string, change: string, transitionId: string): string {
  return join(changeDir(projectRoot, change), "staging", transitionId);
}

export function jobsDir(projectRoot: string, change: string): string {
  return join(changeDir(projectRoot, change), "jobs");
}

export function ensureChangeLayout(projectRoot: string, change: string): void {
  const dir = changeDir(projectRoot, change);
  mkdirSync(dir, { recursive: true });
  mkdirSync(join(dir, "jobs"), { recursive: true });
  mkdirSync(join(dir, "staging"), { recursive: true });
  mkdirSync(join(dir, "raw"), { recursive: true });
  const ef = eventsFile(projectRoot, change);
  if (!existsSync(ef)) writeFileSync(ef, "", "utf8");
}

// ===== 指纹 =====

export function sha256Text(text: string): string {
  return "sha256:" + createHash("sha256").update(text, "utf8").digest("hex");
}

export function sha256File(filePath: string): string | null {
  if (!existsSync(filePath) || !statSync(filePath).isFile()) return null;
  return "sha256:" + createHash("sha256").update(readFileSync(filePath)).digest("hex");
}

export function computeDocumentDigests(
  changeRoot: string,
  docPaths: string[]
): Record<string, string> {
  const digests: Record<string, string> = {};
  for (const p of docPaths) {
    const full = join(changeRoot, p);
    digests[p] = sha256File(full) ?? "sha256:missing";
  }
  return digests;
}

export function digestOf(obj: unknown): string {
  const keys = Object.keys(obj as object).sort();
  return sha256Text(JSON.stringify(obj, keys));
}

// ===== 事件日志 =====

let eventSeq = 0;

export function appendEvent(projectRoot: string, change: string, event: Event): void {
  const line = JSON.stringify(event) + "\n";
  const ef = eventsFile(projectRoot, change);
  // append
  const fd = openSync(ef, "a");
  try {
    writeFileSync(fd, line, "utf8");
  } finally {
    closeSync(fd);
  }
}

export function readEvents(projectRoot: string, change: string): Event[] {
  const ef = eventsFile(projectRoot, change);
  if (!existsSync(ef)) return [];
  const content = readFileSync(ef, "utf8");
  // H3 修复：逐行解析，跳过损坏行（截断 JSON），不整体崩溃
  const events: Event[] = [];
  for (const line of content.split("\n")) {
    if (!line.trim()) continue;
    try {
      events.push(JSON.parse(line) as Event);
    } catch {
      // 截断/损坏行跳过（崩溃恢复：最后一条可能是半写入的）
    }
  }
  return events;
}

export function makeEvent(
  change: string,
  eventType: Event["event_type"],
  payload: Record<string, unknown>,
  opts: {
    transitionId?: string | null;
    idempotencyKey?: string | null;
    prevSnapshotDigest?: string | null;
    inputRefs?: Ref[];
    outputRefs?: Ref[];
  } = {}
): Event {
  const base = {
    change_id: change,
    event_type: eventType,
    transition_id: opts.transitionId ?? null,
    idempotency_key: opts.idempotencyKey ?? null,
    created_at: new Date().toISOString(),
    actor: process.env.SUPERSPEC_ACTOR ?? "cli",
    prev_snapshot_digest: opts.prevSnapshotDigest ?? null,
    input_refs: opts.inputRefs ?? [],
    output_refs: opts.outputRefs ?? [],
    payload,
  };
  const event_digest = digestOf(base);
  const event_id = `EVT-${Date.now()}-${++eventSeq}`;
  return { event_id, ...base, event_digest } as Event;
}

export function eventsDigest(events: Event[]): string {
  return sha256Text(events.map(e => e.event_digest).join("\n"));
}

// ===== Raw 归档 =====

function countValidJsonlRecords(filePath: string): number {
  if (!existsSync(filePath)) return 0;
  let count = 0;
  for (const line of readFileSync(filePath, "utf8").split("\n")) {
    if (!line.trim()) continue;
    try {
      JSON.parse(line);
      count++;
    } catch {
      // raw JSONL 与 events.jsonl 一样容忍截断/损坏行；raw_index 按有效记录计数。
    }
  }
  return count;
}

/**
 * Append an accepted record input to the raw archive.
 *
 * Contract: call only while holding the per-change lock. The returned raw_index
 * is the zero-based valid-record index, not necessarily the physical line.
 */
export function appendRawRecord(
  projectRoot: string,
  change: string,
  kind: RawRecordKind,
  record: unknown,
): RawRecordRef {
  if (!(RAW_RECORD_KINDS as readonly string[]).includes(kind)) {
    throw new Error(`Unsupported raw record kind: ${kind}`);
  }
  const rf = rawFile(projectRoot, change, kind);
  mkdirSync(dirname(rf), { recursive: true });
  const rawIndex = countValidJsonlRecords(rf);
  const line = JSON.stringify(record);
  const rawDigest = sha256Text(line);
  const fd = openSync(rf, "a");
  try {
    writeFileSync(fd, line + "\n", "utf8");
  } finally {
    closeSync(fd);
  }
  return {
    raw_kind: kind,
    raw_index: rawIndex,
    raw_digest: rawDigest,
  };
}

// ===== 快照 =====

export function writeSnapshot(projectRoot: string, change: string, snapshot: Snapshot): void {
  writeFileSync(snapshotFile(projectRoot, change), JSON.stringify(snapshot, null, 2) + "\n", "utf8");
}

export function readSnapshot(projectRoot: string, change: string): Snapshot | null {
  const sf = snapshotFile(projectRoot, change);
  if (!existsSync(sf)) return null;
  try {
    return JSON.parse(readFileSync(sf, "utf8")) as Snapshot;
  } catch {
    // H3 修复：损坏的 snapshot.json 返回 null（让调用方走 sync 重建）
    return null;
  }
}

export function snapshotDigest(snapshot: Snapshot): string {
  return sha256Text(JSON.stringify({
    state: snapshot.state,
    events_digest: snapshot.events_digest,
    document_digests: snapshot.document_digests,
    tasks_structure_digest: snapshot.tasks_structure_digest,
    open_jobs: snapshot.open_jobs.map(j => j.job_id),
    accepted_jobs: snapshot.accepted_jobs.map(j => j.job_id),
    // H5 修复：纳入 task 状态（否则幂等键不反映任务世界状态）
    active_task_attempts: (snapshot.active_task_attempts ?? []).map(a => a.attempt_id),
    task_statuses: snapshot.task_statuses,
  }));
}

// ===== 锁（per-change 文件锁，PID + staleness 回收）=====

const LOCK_STALE_MS = 5 * 60 * 1000;

interface LockInfo {
  pid: number;
  hostname: string;
  created_at: string;
}

export function acquireLock(projectRoot: string, change: string): void {
  ensureChangeLayout(projectRoot, change); // 确保 change 目录存在（含 events.jsonl）
  const lf = lockFile(projectRoot, change);
  const info: LockInfo = {
    pid: process.pid,
    hostname: hostname(),
    created_at: new Date().toISOString(),
  };
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const fd = openSync(lf, "wx");
      try {
        writeFileSync(fd, JSON.stringify(info) + "\n", "utf8");
      } finally {
        closeSync(fd);
      }
      return;
    } catch (err: any) {
      if (err.code !== "EEXIST") throw err;
      // 尝试回收 stale lock
      const existing = readLockInfo(lf);
      if (existing && isLockStale(existing)) {
        unlinkSync(lf);
        continue; // retry
      }
      throw new Error(
        `Lock contention: ${lf} held by pid=${existing?.pid} on ${existing?.hostname}. ` +
        `If no engine process is active, remove the lock file manually.`
      );
    }
  }
  throw new Error(`Failed to acquire lock after stale recovery: ${lf}`);
}

export function releaseLock(projectRoot: string, change: string): void {
  try { unlinkSync(lockFile(projectRoot, change)); } catch { /* best effort */ }
}

function readLockInfo(lf: string): LockInfo | null {
  try {
    return JSON.parse(readFileSync(lf, "utf8")) as LockInfo;
  } catch {
    return null;
  }
}

function isLockStale(info: LockInfo): boolean {
  const age = Date.now() - new Date(info.created_at).getTime();
  return age > LOCK_STALE_MS;
}

export function withLock<T>(projectRoot: string, change: string, fn: () => T): T {
  acquireLock(projectRoot, change);
  try {
    return fn();
  } finally {
    releaseLock(projectRoot, change);
  }
}

// ===== 幂等键 =====

export function idempotencyKey(
  transitionName: string,
  inputs: Record<string, unknown>,
  prevSnapshotDigest: string | null
): string {
  // strip 时间戳/审计字段；保留安全前提 digest
  const stripped = { transition: transitionName, ...inputs, _world: prevSnapshotDigest };
  return sha256Text(JSON.stringify(stripped, Object.keys(stripped).sort()));
}

// ===== 工具 =====

export function ref(path: string, projectRoot: string): Ref {
  return { path, sha: sha256File(join(projectRoot, path)) ?? "sha256:missing" };
}
