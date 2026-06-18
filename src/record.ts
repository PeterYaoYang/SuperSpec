// SuperSpec 流程引擎 — record：工作项结果登记

import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import {
  ensureChangeLayout, readEvents, appendEvent, makeEvent,
  sha256File, withLock,
} from "./store.ts";
import type { Event, RecordResult, Job, JobState } from "./types.ts";

/** 从 events 中查找 job（H4 修复：job 只在 transition_commit 的 new_jobs payload 里） */
function findJob(events: Event[], jobId: string): Job | null {
  for (const ev of events) {
    if (ev.event_type === "transition_commit") {
      const newJobs = (ev.payload as { new_jobs?: Job[] }).new_jobs ?? [];
      const job = newJobs.find(j => j.job_id === jobId);
      if (job) return job;
    }
  }
  return null;
}

/** 检查 job 是否已终态 */
function jobTerminalState(events: Event[], jobId: string): JobState | null {
  for (const ev of events) {
    if (ev.event_type === "job_accepted" && (ev.payload as { job_id: string }).job_id === jobId) return "accepted";
    if (ev.event_type === "job_rejected" && (ev.payload as { job_id: string }).job_id === jobId) return "rejected";
  }
  return null;
}

/** record job-submit：登记工作项结果 */
export function recordJobSubmit(
  projectRoot: string,
  change: string,
  changeRoot: string,
  jobId: string,
  reportFile: string,
): RecordResult {
  return withLock(projectRoot, change, () => {
    ensureChangeLayout(projectRoot, change);
    const events = readEvents(projectRoot, change);

    // 查找 job
    const job = findJob(events, jobId);
    if (!job) {
      return { event_type: "job_rejected", accepted: false, message: `工作项 ${jobId} 不存在` };
    }

    // 检查终态
    const terminal = jobTerminalState(events, jobId);
    if (terminal) {
      // 幂等检查：同 report_digest → 返回旧结果
      const reportDigest = sha256File(reportFile) ?? "sha256:unknown";
      const existing = events.find(
        e => (e.event_type === "job_accepted" || e.event_type === "job_rejected")
          && (e.payload as { job_id: string }).job_id === jobId
          && (e.payload as { report_digest?: string }).report_digest === reportDigest
      );
      if (existing) {
        return {
          event_type: existing.event_type as "job_accepted" | "job_rejected",
          accepted: existing.event_type === "job_accepted",
          message: "幂等返回：同 report 已提交",
          job_state: existing.event_type === "job_accepted" ? "accepted" : "rejected",
        };
      }
      // 终态 job + 不同 report → 拒绝
      return {
        event_type: "job_rejected",
        accepted: false,
        message: `工作项 ${jobId} 已终态（${terminal}），不接受新报告。需要新工作项请重跑 transition。`,
      };
    }

    // 读报告
    if (!existsSync(reportFile)) {
      return { event_type: "job_rejected", accepted: false, message: `报告文件不存在：${reportFile}` };
    }
    const reportContent = readFileSync(reportFile, "utf8");
    const reportDigest = sha256File(reportFile) ?? "sha256:unknown";

    // acceptance checks
    const checks: string[] = [];

    // 0. 报告角色匹配（HIGH 5 修复）
    try {
      const report = JSON.parse(reportContent);
      if (report.role && report.role !== job.role) {
        checks.push(`报告角色 ${report.role} 与工作项角色 ${job.role} 不匹配`);
      }
    } catch {
      // 非 JSON 报告，Phase 1 允许（Phase 2 加正式 schema）
    }

    // 1. boundFiles 仍匹配当前文档（missing 也算不匹配）
    for (const bf of job.boundFiles) {
      const currentSha = sha256File(join(changeRoot, bf.path)) ?? "sha256:missing";
      if (currentSha !== bf.sha) {
        checks.push(`绑定文件 ${bf.path} 已变化（${bf.sha} → ${currentSha}）`);
      }
    }

    // 2. 报告格式基本校验（非空 JSON 或文本）
    if (!reportContent.trim()) {
      checks.push("报告内容为空");
    }

    if (checks.length > 0) {
      // 拒绝
      const rejectEvent = makeEvent(change, "job_rejected", {
        job_id: jobId,
        role: job.role,
        report_digest: reportDigest,
        reason: checks.join("; "),
      });
      appendEvent(projectRoot, change, rejectEvent);
      return {
        event_type: "job_rejected",
        accepted: false,
        message: `工作项 ${jobId} 被拒绝：${checks.join("; ")}`,
        job_state: "rejected",
      };
    }

    // 接受
    const acceptEvent = makeEvent(change, "job_accepted", {
      job_id: jobId,
      role: job.role,
      report_digest: reportDigest,
      accepted_at: new Date().toISOString(),
    });
    appendEvent(projectRoot, change, acceptEvent);
    return {
      event_type: "job_accepted",
      accepted: true,
      message: `工作项 ${jobId}（${job.role}）已接受`,
      job_state: "accepted",
    };
  });
}

/** record user-decision：登记用户决策 */
export function recordUserDecision(
  projectRoot: string,
  change: string,
  inputFile: string,
): RecordResult {
  return withLock(projectRoot, change, () => {
    ensureChangeLayout(projectRoot, change);

    if (!existsSync(inputFile)) {
      appendEvent(projectRoot, change, makeEvent(change, "user_decision_recorded", { accepted: false, reason: "file_not_found", path: inputFile }));
      return { event_type: "user_decision_recorded" as const, accepted: false, message: `决策文件不存在：${inputFile}` };
    }

    const content = readFileSync(inputFile, "utf8");
    let decision: { scope?: string; question?: string; answer?: string };
    try {
      decision = JSON.parse(content);
    } catch {
      appendEvent(projectRoot, change, makeEvent(change, "user_decision_recorded", { accepted: false, reason: "invalid_json" }));
      return { event_type: "user_decision_recorded" as const, accepted: false, message: "决策文件不是有效 JSON" };
    }

    if (!decision.scope || !decision.answer) {
      appendEvent(projectRoot, change, makeEvent(change, "user_decision_recorded", { accepted: false, reason: "missing_scope_or_answer" }));
      return { event_type: "user_decision_recorded" as const, accepted: false, message: "决策文件缺少 scope 或 answer" };
    }

    const event = makeEvent(change, "user_decision_recorded", {
      scope: decision.scope,
      question: decision.question ?? "",
      answer: decision.answer,
      input_digest: sha256File(inputFile) ?? "sha256:unknown",
    });
    appendEvent(projectRoot, change, event);

    return {
      event_type: "user_decision_recorded" as const,
      accepted: true,
      message: `用户决策已登记：scope=${decision.scope}`,
    };
  });
}

/** jobs list（HIGH-1 修复：从 transition_commit.new_jobs 提取，不再依赖已删除的 job_requested 事件） */
export function jobsList(
  projectRoot: string,
  change: string,
): { open: Job[]; accepted: Job[]; rejected: { job_id: string; role: string }[] } {
  const events = readEvents(projectRoot, change);
  const open: Job[] = [];
  const accepted: Job[] = [];
  const rejected: { job_id: string; role: string }[] = [];

  for (const ev of events) {
    if (ev.event_type === "transition_commit") {
      const newJobs = (ev.payload as { new_jobs?: Job[] }).new_jobs ?? [];
      for (const job of newJobs) {
        if (!open.some(j => j.job_id === job.job_id) && !accepted.some(j => j.job_id === job.job_id) && !rejected.some(r => r.job_id === job.job_id)) {
          open.push(job);
        }
      }
    } else if (ev.event_type === "job_accepted") {
      const { job_id } = ev.payload as { job_id: string };
      const idx = open.findIndex(j => j.job_id === job_id);
      if (idx >= 0) {
        const job = open.splice(idx, 1)[0];
        job.state = "accepted";
        accepted.push(job);
      }
    } else if (ev.event_type === "job_rejected") {
      const { job_id, role } = ev.payload as { job_id: string; role: string };
      const idx = open.findIndex(j => j.job_id === job_id);
      if (idx >= 0) open.splice(idx, 1)[0];
      rejected.push({ job_id, role });
    }
  }

  return { open, accepted, rejected };
}

/** jobs packet：返回工作项执行说明 */
export function jobsPacket(
  projectRoot: string,
  change: string,
  jobId: string,
): { found: boolean; packet?: Record<string, unknown>; message: string } {
  const events = readEvents(projectRoot, change);
  const job = findJob(events, jobId);
  if (!job) {
    return { found: false, message: `工作项 ${jobId} 不存在` };
  }
  return {
    found: true,
    packet: {
      job_id: job.job_id,
      role: job.role,
      boundFiles: job.boundFiles,
      packet_digest: job.packet_digest,
      required_output_kind: "report",
      output_instructions: `请审查 ${job.boundFiles.map(f => f.path).join(", ")}，产出审查报告`,
      stop_conditions: ["审查完成后提交报告，不要修改文档"],
      created_from_transition: job.created_from_transition,
    },
    message: `工作项 ${jobId} 的执行说明`,
  };
}
