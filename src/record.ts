// SuperSpec 流程引擎 — record：工作项结果登记

import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import {
  ensureChangeLayout, readEvents, appendEvent, makeEvent,
  sha256File, sha256Text, withLock, appendRawRecord,
} from "./store.ts";
import { reviewEvidenceDigest, reviewVerifierStaleReason } from "./review.ts";
import { jobSubmitArgv } from "./job_action.ts";
import type { Event, RecordResult, Job, JobRole, JobState } from "./types.ts";

const REVIEW_REPORT_REQUIRED_FIELDS = ["role", "verdict", "findings"] as const;
const REVIEW_REPORT_OPTIONAL_FIELDS = ["summary", "evidence_refs", "risks", "open_questions"] as const;
const REVIEWER_KINDS = new Set(["codex-subagent", "human", "external-agent"]);

function requiresReviewer(role: JobRole): boolean {
  return role === "critic" || role === "architect" || role === "test-engineer";
}

function recommendedAgentForRole(role: JobRole): string {
  switch (role) {
    case "critic": return "critic";
    case "architect": return "architect";
    case "test-engineer": return "test-engineer";
    case "verifier": return "verifier";
    case "executor": return "executor";
    case "test-run": return "test-runner";
  }
}

function roleDescription(role: JobRole): string {
  switch (role) {
    case "critic":
      return "从反方角度审查需求澄清或计划材料中的隐藏假设、范围漂移、验收漏洞和证据缺口";
    case "architect":
      return "审查架构边界、接口契约、长期维护风险和设计取舍";
    case "test-engineer":
      return "审查测试契约、覆盖策略、RED/GREEN 可信度和验收场景映射";
    case "verifier":
      return "验证 proposal、实现状态、任务完成、测试契约和 SuperSpec 证据是否足以支撑完成结论";
    case "executor":
      return "执行受限实现工作项";
    case "test-run":
      return "执行受限测试工作项";
  }
}

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

function terminalJobSubmitResult(
  events: Event[],
  jobId: string,
  terminal: JobState,
  reportDigest: string,
): RecordResult {
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
  return {
    event_type: "job_rejected",
    accepted: false,
    message: `工作项 ${jobId} 已终态（${terminal}），不接受新报告。需要新工作项请重跑 transition。`,
  };
}

function recordJobSubmitLoaded(
  projectRoot: string,
  change: string,
  changeRoot: string,
  jobId: string,
  job: Job,
  events: Event[],
  reportContent: string,
  reportDigest: string,
): RecordResult {
  const checks: string[] = [];
  let parsedReport: Record<string, unknown> | null = null;

  try {
    const report = JSON.parse(reportContent);
    if (!report || typeof report !== "object" || Array.isArray(report)) {
      checks.push("报告必须是 JSON object");
    } else {
      parsedReport = report as Record<string, unknown>;
      const obj = parsedReport as { role?: unknown; verdict?: unknown; findings?: unknown; reviewer?: unknown };
      for (const field of REVIEW_REPORT_REQUIRED_FIELDS) {
        if (!(field in obj)) checks.push(`报告缺少必填字段 ${field}`);
      }
      if (obj.role !== job.role) {
        checks.push(`报告角色 ${String(obj.role)} 与工作项角色 ${job.role} 不匹配`);
      }
      if (obj.verdict !== "pass" && obj.verdict !== "fail") {
        checks.push("报告 verdict 必须是 pass 或 fail");
      }
      if (!Array.isArray(obj.findings)) {
        checks.push("报告 findings 必须是数组");
      }
      if (obj.verdict === "fail") {
        checks.push("报告 verdict=fail，工作项未通过");
      }
      if (requiresReviewer(job.role)) {
        if (!("reviewer" in obj)) checks.push("报告缺少必填字段 reviewer");
        const reviewer = obj.reviewer as { kind?: unknown; id?: unknown } | undefined;
        if (!reviewer || typeof reviewer !== "object" || Array.isArray(reviewer)) {
          checks.push("报告 reviewer 必须是包含 kind/id 的对象");
        } else {
          if (typeof reviewer.kind !== "string" || !REVIEWER_KINDS.has(reviewer.kind)) {
            checks.push(`报告 reviewer.kind 必须是 ${[...REVIEWER_KINDS].join("|")} 之一`);
          }
          if (typeof reviewer.id !== "string" || reviewer.id.trim() === "") {
            checks.push("报告 reviewer.id 必须是非空字符串");
          }
        }
      }
    }
  } catch {
    checks.push("报告必须是有效 JSON");
  }

  for (const bf of job.boundFiles) {
    const currentSha = sha256File(join(changeRoot, bf.path)) ?? "sha256:missing";
    if (currentSha !== bf.sha) {
      checks.push(`绑定文件 ${bf.path} 已变化（${bf.sha} → ${currentSha}）`);
    }
  }
  const reviewStaleReason = reviewVerifierStaleReason(job, changeRoot, reviewEvidenceDigest(events));
  if (reviewStaleReason && !checks.includes(reviewStaleReason)) {
    checks.push(reviewStaleReason);
  }

  if (!reportContent.trim()) {
    checks.push("报告内容为空");
  }

  if (checks.length > 0) {
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

  const rawRef = appendRawRecord(projectRoot, change, "review-reports", parsedReport);
  const acceptEvent = makeEvent(change, "job_accepted", {
    job_id: jobId,
    role: job.role,
    report_digest: reportDigest,
    accepted_at: new Date().toISOString(),
    ...rawRef,
  });
  appendEvent(projectRoot, change, acceptEvent);
  return {
    event_type: "job_accepted",
    accepted: true,
    message: `工作项 ${jobId}（${job.role}）已接受`,
    job_state: "accepted",
  };
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

    const job = findJob(events, jobId);
    if (!job) {
      return { event_type: "job_rejected", accepted: false, message: `工作项 ${jobId} 不存在` };
    }

    const terminal = jobTerminalState(events, jobId);
    if (terminal) {
      const reportDigest = sha256File(reportFile) ?? "sha256:unknown";
      return terminalJobSubmitResult(events, jobId, terminal, reportDigest);
    }

    if (!existsSync(reportFile)) {
      return { event_type: "job_rejected", accepted: false, message: `报告文件不存在：${reportFile}` };
    }
    const reportContent = readFileSync(reportFile, "utf8");
    const reportDigest = sha256File(reportFile) ?? "sha256:unknown";
    return recordJobSubmitLoaded(projectRoot, change, changeRoot, jobId, job, events, reportContent, reportDigest);
  });
}

/** record job-submit：从 JSON 内容登记工作项结果 */
export function recordJobSubmitContent(
  projectRoot: string,
  change: string,
  changeRoot: string,
  jobId: string,
  reportContent: string,
): RecordResult {
  return withLock(projectRoot, change, () => {
    ensureChangeLayout(projectRoot, change);
    const events = readEvents(projectRoot, change);

    const job = findJob(events, jobId);
    if (!job) {
      return { event_type: "job_rejected", accepted: false, message: `工作项 ${jobId} 不存在` };
    }

    const reportDigest = sha256Text(reportContent);
    const terminal = jobTerminalState(events, jobId);
    if (terminal) {
      return terminalJobSubmitResult(events, jobId, terminal, reportDigest);
    }

    return recordJobSubmitLoaded(projectRoot, change, changeRoot, jobId, job, events, reportContent, reportDigest);
  });
}

function recordUserDecisionLoaded(
  projectRoot: string,
  change: string,
  events: Event[],
  content: string,
  inputDigest: string,
): RecordResult {
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

  const existing = events.find(
    e => e.event_type === "user_decision_recorded"
      && (e.payload as { input_digest?: string }).input_digest === inputDigest
  );
  if (existing) {
    return {
      event_type: "user_decision_recorded" as const,
      accepted: true,
      message: "幂等返回：同 user decision 已登记",
    };
  }

  const normalizedDecision = {
    scope: decision.scope,
    question: decision.question ?? "",
    answer: decision.answer,
  };
  const rawRef = appendRawRecord(projectRoot, change, "user-decisions", normalizedDecision);
  const event = makeEvent(change, "user_decision_recorded", {
    ...normalizedDecision,
    input_digest: inputDigest,
    ...rawRef,
  });
  appendEvent(projectRoot, change, event);

  return {
    event_type: "user_decision_recorded" as const,
    accepted: true,
    message: `用户决策已登记：scope=${decision.scope}`,
  };
}

/** record user-decision：登记用户决策 */
export function recordUserDecision(
  projectRoot: string,
  change: string,
  inputFile: string,
): RecordResult {
  return withLock(projectRoot, change, () => {
    ensureChangeLayout(projectRoot, change);
    const events = readEvents(projectRoot, change);

    if (!existsSync(inputFile)) {
      appendEvent(projectRoot, change, makeEvent(change, "user_decision_recorded", { accepted: false, reason: "file_not_found", path: inputFile }));
      return { event_type: "user_decision_recorded" as const, accepted: false, message: `决策文件不存在：${inputFile}` };
    }

    const content = readFileSync(inputFile, "utf8");
    const inputDigest = sha256File(inputFile) ?? "sha256:unknown";
    return recordUserDecisionLoaded(projectRoot, change, events, content, inputDigest);
  });
}

/** record user-decision：从 JSON 内容登记用户决策 */
export function recordUserDecisionContent(
  projectRoot: string,
  change: string,
  content: string,
): RecordResult {
  return withLock(projectRoot, change, () => {
    ensureChangeLayout(projectRoot, change);
    const events = readEvents(projectRoot, change);
    return recordUserDecisionLoaded(projectRoot, change, events, content, sha256Text(content));
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
        recommended_agent: recommendedAgentForRole(job.role),
        boundFiles: job.boundFiles,
        ...(job.review_evidence_digest ? { review_evidence_digest: job.review_evidence_digest } : {}),
        packet_digest: job.packet_digest,
        required_output_kind: "job_report_json",
        preferred_input_mode: "stdin",
        submission_command: `superspec record job-submit --change "${change}" --job "${job.job_id}" --report -`,
        submission_argv: jobSubmitArgv(change, job.job_id),
        file_fallback: true,
        output_contract_fields: requiresReviewer(job.role) ? [...REVIEW_REPORT_REQUIRED_FIELDS, "reviewer"] : [...REVIEW_REPORT_REQUIRED_FIELDS],
        output_contract_optional_fields: [...REVIEW_REPORT_OPTIONAL_FIELDS],
        output_instructions:
          `${roleDescription(job.role)}。请审查 ${job.boundFiles.map(f => f.path).join(", ")}，` +
          (job.review_evidence_digest ? `本工作项绑定的执行证据版本为 ${job.review_evidence_digest}，` : "") +
          (requiresReviewer(job.role) ? `必须由独立 ${recommendedAgentForRole(job.role)} reviewer 执行并在 reviewer.kind/id 中记录来源，` : "") +
          `产出 JSON 报告内容并优先通过 --report - 从 stdin 登记；文件路径模式仍可作为 fallback。` +
          (requiresReviewer(job.role)
            ? `最小格式：{"role":"${job.role}","verdict":"pass|fail","findings":[],"reviewer":{"kind":"codex-subagent","id":"<thread-or-agent-id>"}}`
            : `最小格式：{"role":"${job.role}","verdict":"pass|fail","findings":[]}`),
        stop_conditions: ["审查完成后提交报告，不要修改文档"],
        created_from_transition: job.created_from_transition,
      },
    message: `工作项 ${jobId} 的执行说明`,
  };
}
