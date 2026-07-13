// SuperSpec 流程引擎 — sync：从当前文档 + events.jsonl 重建 snapshot

import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import {
  readEvents, eventsDigest, computeDocumentDigests, sha256Text, ensureChangeLayout,
} from "./store.ts";
import { reviewEvidenceDigest } from "./review.ts";
import { invalidReasonForSnapshot } from "./job_validity.ts";
import type { Event, Snapshot, Job, State, TaskAttempt } from "./types.ts";

const TRACKED_DOCS = [
  "proposal.md", "design.md", "tasks.md", "specs/",
  ".superspec/artifacts/discovery.md",
  ".superspec/artifacts/test-contract.md",
];

/** 从 events.jsonl 推导：当前状态、jobs、attempts、pending decisions */
function replayEvents(events: Event[]): {
  state: State;
  openJobs: Job[];
  acceptedJobs: Job[];
  activeAttempts: TaskAttempt[];
  taskStatuses: Record<string, "todo" | "doing" | "done">;
  lastTransition: string | null;
} {
  let state: State = "init";
  const openJobs: Job[] = [];
  const acceptedJobs: Job[] = [];
  const activeAttempts: TaskAttempt[] = [];
  const taskStatuses: Record<string, "todo" | "doing" | "done"> = {};
  let lastTransition: string | null = null;

  for (const ev of events) {
    switch (ev.event_type) {
      case "transition_commit": {
        const p = ev.payload as { to_state: State; transition?: string };
        state = p.to_state;
        if (ev.transition_id) lastTransition = ev.transition_id;
        // HIGH 6 修复：从 commit payload replay job
        const created = (ev.payload as { created_job_ids?: string[] }).created_job_ids ?? [];
        const payloadJobs = (ev.payload as { new_jobs?: Job[] }).new_jobs ?? [];
        for (const jid of created) {
          const job = payloadJobs.find(j => j.job_id === jid);
          if (job && !openJobs.some(j => j.job_id === jid)) openJobs.push(job);
        }
        break;
      }
      // H4 修复：删除 job_requested / job_invalidated 死分支——job 只通过 transition_commit 的 new_jobs payload 创建，staleness 只在 sync 内存计算（不写事件）
      case "job_accepted": {
        const { job_id } = ev.payload as { job_id: string };
        const idx = openJobs.findIndex(j => j.job_id === job_id);
        if (idx >= 0) {
          const job = openJobs.splice(idx, 1)[0];
          job.state = "accepted";
          acceptedJobs.push(job);
        }
        break;
      }
      case "job_rejected": {
        const { job_id } = ev.payload as { job_id: string };
        const idx = openJobs.findIndex(j => j.job_id === job_id);
        if (idx >= 0) {
          openJobs.splice(idx, 1)[0]; // remove from open
        }
        break;
      }
      // H4：job_invalidated 事件从不发射（删除死分支）
      case "task_started": {
        const attempt = ev.payload as unknown as TaskAttempt;
        activeAttempts.push(attempt);
        taskStatuses[attempt.task_id] = "doing";
        break;
      }
      case "task_completed": {
        const { task_id, attempt_id } = ev.payload as { task_id: string; attempt_id: string };
        const idx = activeAttempts.findIndex(a => a.attempt_id === attempt_id);
        if (idx >= 0) activeAttempts[idx].state = "closed";
        taskStatuses[task_id] = "done";
        break;
      }
      case "task_abandoned": {
        const { attempt_id } = ev.payload as { attempt_id: string };
        const idx = activeAttempts.findIndex(a => a.attempt_id === attempt_id);
        if (idx >= 0) activeAttempts.splice(idx, 1);
        break;
      }
    }
  }
  return { state, openJobs, acceptedJobs, activeAttempts, taskStatuses, lastTransition };
}

/** 粗粒度失效：检查 job 的 boundFiles 是否仍匹配当前文档 */
function checkStaleJobs(
  jobs: Job[],
  projectRoot: string,
  changeRoot: string,
  events: Event[],
  currentReviewEvidenceDigest: string,
): { job_id: string; reason: string }[] {
  const stale: { job_id: string; reason: string }[] = [];
  for (const job of jobs) {
    const reason = invalidReasonForSnapshot({ job, projectRoot, changeRoot, events, currentReviewEvidenceDigest });
    if (reason) {
      stale.push({ job_id: job.job_id, reason });
    }
  }
  return stale;
}

/** 解析 tasks.md 结构指纹（复选框归一化） */
function tasksStructureDigest(changeRoot: string): string | null {
  const tasksPath = join(changeRoot, "tasks.md");
  if (!existsSync(tasksPath)) return null;
  const content = readFileSync(tasksPath, "utf8");
  // 复选框归一化：- [x] → - [ ]
  const normalized = content.replace(/- \[[xX]\]/g, "- [ ]");
  return sha256Text(normalized);
}

/** 重建 snapshot（sync 的核心） */
export function rebuildSnapshot(
  projectRoot: string,
  change: string,
  changeRoot: string,
  openspecStatusDigest: string = "sha256:unknown",
): Snapshot {
  ensureChangeLayout(projectRoot, change);

  const events = readEvents(projectRoot, change);
  const evDigest = eventsDigest(events);
  const documentDigests = computeDocumentDigests(changeRoot, TRACKED_DOCS);
  const tsDigest = tasksStructureDigest(changeRoot);

  const { state, openJobs, acceptedJobs, activeAttempts, taskStatuses, lastTransition } = replayEvents(events);
  const currentReviewEvidenceDigest = reviewEvidenceDigest(events);

  // 粗粒度失效检查（只读，不写事件）：open code-reviewer job 防止提交过期报告；
  // accepted code-reviewer pass 不做持续 freshness gate，避免 apply_done 循环重审。
  const staleOpenInfo = checkStaleJobs(openJobs, projectRoot, changeRoot, events, currentReviewEvidenceDigest);
  const staleAcceptedInfo = checkStaleJobs(
    acceptedJobs.filter(j => j.role !== "code-reviewer"),
    projectRoot,
    changeRoot,
    events,
    currentReviewEvidenceDigest,
  );
  const freshOpen = openJobs
    .filter(j => !staleOpenInfo.some(s => s.job_id === j.job_id))
    .filter(j => j.role !== "code-reviewer" || state === "apply_done");
  const freshAccepted = acceptedJobs.filter(j => !staleAcceptedInfo.some(s => s.job_id === j.job_id));

  return {
    change_id: change,
    state,
    openspec_status_digest: openspecStatusDigest,
    events_digest: evDigest,
    document_digests: documentDigests,
    tasks_structure_digest: tsDigest,
    task_statuses: taskStatuses,
    open_jobs: freshOpen,
    accepted_jobs: freshAccepted,
    active_task_attempts: activeAttempts,
    pending_user_decisions: [],
    last_transition: lastTransition,
    computed_at: new Date().toISOString(),
  };
}
