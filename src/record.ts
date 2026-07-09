// SuperSpec 流程引擎 — record：工作项结果登记

import { readFileSync, existsSync } from "node:fs";
import { isAbsolute, join, relative, resolve } from "node:path";
import {
  ensureChangeLayout, readEvents, appendEvent, makeEvent,
  sha256File, sha256Text, withLock, appendRawRecord, type RawRecordRef,
} from "./store.ts";
import {
  CODE_REVIEW_DECISION_ANSWER_LABELS,
  CODE_REVIEW_DECISION_SCOPE_PREFIX,
  codeReviewDecisionAnswerLabel,
  normalizeCodeReviewDecisionAnswer,
} from "./code_review.ts";
import { invalidReasonForSubmittedReport } from "./job_validity.ts";
import { jobSubmitArgv } from "./job_action.ts";
import { REVIEW_DOC_PATHS } from "./review.ts";
import type { CodeReviewResultKind, Event, RecordResult, Job, JobPacket, JobRole, JobState } from "./types.ts";

const REVIEW_REPORT_REQUIRED_FIELDS = ["role", "verdict", "findings"] as const;
const REVIEW_REPORT_OPTIONAL_FIELDS = ["summary", "evidence_refs", "risks", "open_questions"] as const;
const REVIEWER_KINDS = new Set(["codex-subagent", "human", "external-agent"]);
const CODE_REVIEW_FINDING_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._:-]*$/;

function requiresReviewer(role: JobRole): boolean {
  return role === "critic" || role === "architect" || role === "test-engineer" || role === "code-reviewer";
}

function recommendedAgentForRole(role: JobRole): string {
  switch (role) {
    case "critic": return "critic";
    case "architect": return "architect";
    case "test-engineer": return "test-engineer";
    case "verifier": return "verifier";
    case "code-reviewer": return "code-reviewer";
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
    case "code-reviewer":
      return "审查 apply 后的代码实现质量、健壮性、性能、安全、兼容、边界条件、是否偏离 proposal/design/tasks/test-contract 以及关键测试缺口";
    case "executor":
      return "执行受限实现工作项";
    case "test-run":
      return "执行受限测试工作项";
  }
}

function asObject(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

function nonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim() !== "";
}

function stringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every(item => typeof item === "string");
}

function safeCodeReviewFindingId(value: string): boolean {
  return CODE_REVIEW_FINDING_ID_RE.test(value);
}

function uncheckedCodeReviewPaths(value: unknown, checks: string[]): Set<string> {
  const paths = new Set<string>();
  if (!Array.isArray(value)) return paths;
  for (const item of value) {
    const obj = asObject(item);
    if (!obj) {
      checks.push("代码审查覆盖范围里的未检查项必须是包含 path/reason 的对象");
      continue;
    }
    if (!nonEmptyString(obj.path)) {
      checks.push("代码审查覆盖范围里的未检查项缺少 path");
      continue;
    }
    if (!nonEmptyString(obj.reason)) {
      checks.push(`代码审查覆盖范围里的未检查项 ${obj.path} 缺少 reason`);
      continue;
    }
    paths.add(obj.path);
  }
  return paths;
}

function codeReviewResultKind(value: unknown): CodeReviewResultKind | null {
  return value === "invalid_report" || value === "non_actionable_report" || value === "review_failed"
    ? value
    : null;
}

function validateReviewer(obj: { reviewer?: unknown }, checks: string[]): void {
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

function validateCodeReviewScope(
  obj: Record<string, unknown>,
  job: Job,
  checks: string[],
): void {
  const scope = asObject(obj.review_scope);
  if (!scope) {
    checks.push("代码审查报告缺少覆盖范围字段 review_scope");
    return;
  }
  if (scope.job_id !== job.job_id) {
    checks.push(`代码审查覆盖范围里的 job_id ${String(scope.job_id)} 与工作项 ${job.job_id} 不匹配`);
  }
  if (scope.packet_digest !== job.packet_digest) {
    checks.push("代码审查覆盖范围里的 packet_digest 与工作项不匹配，请使用当前工作项说明重新生成报告");
  }
  if (!stringArray(scope.checked_paths)) checks.push("代码审查覆盖范围里的 checked_paths 必须是字符串数组");
  if (!stringArray(scope.checked_docs)) checks.push("代码审查覆盖范围里的 checked_docs 必须是字符串数组");
  if (!Array.isArray(scope.unchecked)) checks.push("代码审查覆盖范围里的 unchecked 必须是数组");
  if (stringArray(scope.checked_paths) && Array.isArray(scope.unchecked)) {
    const checkedPaths = new Set(scope.checked_paths);
    const uncheckedPaths = uncheckedCodeReviewPaths(scope.unchecked, checks);
    for (const bound of job.boundFiles) {
      if (!checkedPaths.has(bound.path) && !uncheckedPaths.has(bound.path)) {
        checks.push(`代码审查报告未说明是否检查了 ${bound.path}`);
      }
    }
  }
}

function actionableCodeReviewFindings(findings: unknown): { actionable: Record<string, unknown>[]; reasons: string[] } {
  if (!Array.isArray(findings)) return { actionable: [], reasons: ["报告字段 findings 必须是数组"] };
  const actionable: Record<string, unknown>[] = [];
  const reasons: string[] = [];
  const ids = new Set<string>();

  for (const raw of findings) {
    const finding = asObject(raw);
    if (!finding) {
      reasons.push("问题项必须是对象");
      continue;
    }
    if (finding.blocking !== true) continue;

    const id = finding.id;
    if (!nonEmptyString(id)) {
      reasons.push("阻塞问题项缺少 id");
      continue;
    }
    if (!safeCodeReviewFindingId(id)) {
      reasons.push(`阻塞问题 ${id} 的 id 只能包含字母、数字、点、下划线、冒号或短横线，且不能包含空格或 #`);
      continue;
    }
    if (ids.has(id)) {
      reasons.push(`阻塞问题项 id 重复：${id}`);
      continue;
    }
    ids.add(id);

    const findingReasons: string[] = [];
    const type = finding.type;
    if (type !== "implementation" && type !== "spec" && type !== "mixed") {
      findingReasons.push(`阻塞问题 ${id} 的分类 type 必须是 implementation|spec|mixed`);
      reasons.push(...findingReasons);
      continue;
    }
    for (const field of ["description", "evidence", "impact", "suggested_action"] as const) {
      if (!nonEmptyString(finding[field])) findingReasons.push(`阻塞问题 ${id} 缺少 ${field}`);
    }
    if (!stringArray(finding.source_refs) || finding.source_refs.length === 0) {
      findingReasons.push(`阻塞问题 ${id} 缺少 source_refs`);
    }
    if (finding.suggested_action !== "apply" && finding.suggested_action !== "propose") {
      findingReasons.push(`阻塞问题 ${id} 的 suggested_action 必须是 apply|propose`);
    }
    if (type === "implementation" && finding.suggested_action !== "apply") {
      findingReasons.push(`纯代码实现问题 ${id} 的 suggested_action 必须是 apply`);
    }
    if (findingReasons.length > 0) {
      reasons.push(...findingReasons);
      continue;
    }
    actionable.push(finding);
  }

  return { actionable, reasons };
}

function codeReviewRejectEventPayload(input: {
  jobId: string;
  job: Job;
  reportDigest: string;
  resultKind: CodeReviewResultKind;
  reason: string;
  parsedReport?: Record<string, unknown> | null;
  rawRef?: RawRecordRef | null;
  reportPath?: string | null;
}): Record<string, unknown> {
  const payload: Record<string, unknown> = {
    job_id: input.jobId,
    role: input.job.role,
    report_digest: input.reportDigest,
    result_kind: input.resultKind,
    reason: input.reason,
    ...(input.reportPath ? { report_path: input.reportPath } : {}),
    ...(input.rawRef ?? {}),
  };
  if (input.resultKind === "review_failed" && input.parsedReport) {
    payload.review_scope = input.parsedReport.review_scope ?? {};
    payload.findings = Array.isArray(input.parsedReport.findings) ? input.parsedReport.findings : [];
    payload.reviewer = input.parsedReport.reviewer ?? null;
    if (typeof input.parsedReport.summary === "string") payload.summary = input.parsedReport.summary;
  }
  return payload;
}

function failedReviewReportRejectEventPayload(input: {
  jobId: string;
  job: Job;
  reportDigest: string;
  parsedReport: Record<string, unknown>;
  rawRef: RawRecordRef;
}): Record<string, unknown> {
  const payload: Record<string, unknown> = {
    job_id: input.jobId,
    role: input.job.role,
    report_digest: input.reportDigest,
    reason: "报告结论为 fail，工作项未通过",
    findings: Array.isArray(input.parsedReport.findings) ? input.parsedReport.findings : [],
    ...input.rawRef,
  };
  for (const field of REVIEW_REPORT_OPTIONAL_FIELDS) {
    if (field in input.parsedReport) payload[field] = input.parsedReport[field];
  }
  return payload;
}

function projectRelativePath(projectRoot: string, path: string): string | null {
  const absolute = isAbsolute(path) ? path : resolve(projectRoot, path);
  const rel = relative(projectRoot, absolute).replace(/\\/g, "/");
  if (!rel || rel === ".." || rel.startsWith("../") || isAbsolute(rel)) return null;
  return rel;
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
      message: "幂等返回：同一报告已提交",
      job_state: existing.event_type === "job_accepted" ? "accepted" : "rejected",
    };
  }
  return {
    event_type: "job_rejected",
    accepted: false,
    message: `工作项 ${jobId} 已结束（${terminal}），不接受新报告。需要新工作项请重新执行对应的 transition。`,
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
  reportFile?: string,
): RecordResult {
  const checks: string[] = [];
  let parsedReport: Record<string, unknown> | null = null;

  try {
    const report = JSON.parse(reportContent);
    if (!report || typeof report !== "object" || Array.isArray(report)) {
      checks.push("报告必须是 JSON 对象");
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
        checks.push("报告结论字段 verdict 必须是 pass 或 fail");
      }
      if (!Array.isArray(obj.findings)) {
        checks.push("报告问题列表 findings 必须是数组");
      }
      if (requiresReviewer(job.role)) {
        validateReviewer(obj, checks);
      }
      if (job.role === "code-reviewer") {
        validateCodeReviewScope(parsedReport, job, checks);
      }
    }
  } catch {
    checks.push("报告必须是有效 JSON");
  }

  const reportPath = reportFile ? projectRelativePath(projectRoot, reportFile) : null;
  const invalidReason = invalidReasonForSubmittedReport(job, {
    projectRoot,
    changeRoot,
    events,
    reportPath,
  });
  if (invalidReason) {
    checks.push(invalidReason);
  }

  if (!reportContent.trim()) {
    checks.push("报告内容为空");
  }

  if (checks.length > 0) {
    const resultKind: CodeReviewResultKind | undefined = job.role === "code-reviewer" ? "invalid_report" : undefined;
    const rawRef = resultKind && parsedReport
      ? appendRawRecord(projectRoot, change, "review-reports", parsedReport)
      : null;
    const rejectEvent = makeEvent(change, "job_rejected", {
      ...(resultKind
        ? codeReviewRejectEventPayload({
          jobId,
          job,
          reportDigest,
          resultKind,
          reason: checks.join("; "),
          parsedReport,
          rawRef,
          reportPath,
        })
        : {
          job_id: jobId,
          role: job.role,
          report_digest: reportDigest,
          ...(reportPath ? { report_path: reportPath } : {}),
          reason: checks.join("; "),
        }),
    });
    appendEvent(projectRoot, change, rejectEvent);
    return {
      event_type: "job_rejected",
      accepted: false,
      message: `工作项 ${jobId} 被拒绝：${checks.join("; ")}`,
      job_state: "rejected",
    };
  }

  if (job.role !== "code-reviewer" && parsedReport?.verdict === "fail") {
    const rawRef = appendRawRecord(projectRoot, change, "review-reports", parsedReport);
    const rejectEvent = makeEvent(change, "job_rejected", failedReviewReportRejectEventPayload({
      jobId,
      job,
      reportDigest,
      parsedReport,
      rawRef,
    }));
    if (reportPath) rejectEvent.payload.report_path = reportPath;
    appendEvent(projectRoot, change, rejectEvent);
    return {
      event_type: "job_rejected",
      accepted: false,
      message: `工作项 ${jobId} 被拒绝：报告结论为 fail，工作项未通过`,
      job_state: "rejected",
    };
  }

  if (job.role === "code-reviewer" && parsedReport) {
    const verdict = parsedReport.verdict;
    const findings = parsedReport.findings;
    const blockingCount = Array.isArray(findings)
      ? findings.filter(item => asObject(item)?.blocking === true).length
      : 0;
    const { actionable, reasons } = actionableCodeReviewFindings(findings);

    if (verdict === "pass") {
      if (blockingCount > 0) {
        const reason = "报告结论为 pass 时不能包含 blocking:true 的阻塞问题";
        const rawRef = appendRawRecord(projectRoot, change, "review-reports", parsedReport);
        appendEvent(projectRoot, change, makeEvent(change, "job_rejected", codeReviewRejectEventPayload({
          jobId,
          job,
          reportDigest,
          resultKind: "invalid_report",
          reason,
          parsedReport,
          rawRef,
          reportPath,
        })));
        return {
          event_type: "job_rejected",
          accepted: false,
          message: `工作项 ${jobId} 被拒绝：${reason}`,
          job_state: "rejected",
        };
      }
    } else if (verdict === "fail") {
      const hasOnlyActionableBlockingFindings = actionable.length > 0 && reasons.length === 0;
      const resultKind: CodeReviewResultKind = hasOnlyActionableBlockingFindings ? "review_failed" : "non_actionable_report";
      const reason = hasOnlyActionableBlockingFindings
        ? `代码审查发现 ${actionable.length} 个需要处理的阻塞问题`
        : actionable.length > 0
          ? `代码审查报告包含无法处理的阻塞问题：${reasons.join("; ")}`
          : `代码审查报告没有给出可处理的阻塞问题${reasons.length > 0 ? `：${reasons.join("; ")}` : ""}`;
      const rawRef = appendRawRecord(projectRoot, change, "review-reports", parsedReport);
      appendEvent(projectRoot, change, makeEvent(change, "job_rejected", codeReviewRejectEventPayload({
        jobId,
        job,
        reportDigest,
        resultKind,
        reason,
        parsedReport,
        rawRef,
        reportPath,
      })));
      return {
        event_type: "job_rejected",
        accepted: false,
        message: `工作项 ${jobId} 被拒绝：${reason}`,
        job_state: "rejected",
      };
    }
  }

  const rawRef = appendRawRecord(projectRoot, change, "review-reports", parsedReport);
  const acceptEvent = makeEvent(change, "job_accepted", {
    job_id: jobId,
    role: job.role,
    report_digest: reportDigest,
    accepted_at: new Date().toISOString(),
    ...(reportPath ? { report_path: reportPath } : {}),
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
    return recordJobSubmitLoaded(projectRoot, change, changeRoot, jobId, job, events, reportContent, reportDigest, reportFile);
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
  const existing = events.find(
    e => e.event_type === "user_decision_recorded"
      && (e.payload as { input_digest?: string }).input_digest === inputDigest
  );
  if (existing) {
    const accepted = (existing.payload as { accepted?: unknown }).accepted !== false;
    return {
      event_type: "user_decision_recorded" as const,
      accepted,
      message: accepted ? "幂等返回：同一用户决策已登记" : "幂等返回：同一无效用户决策已登记",
    };
  }

  let decision: { scope?: unknown; question?: unknown; answer?: unknown; reason?: unknown };
  try {
    decision = JSON.parse(content);
  } catch {
    appendEvent(projectRoot, change, makeEvent(change, "user_decision_recorded", {
      accepted: false,
      reason: "invalid_json",
      input_digest: inputDigest,
    }));
    return { event_type: "user_decision_recorded" as const, accepted: false, message: "决策文件不是有效 JSON" };
  }

  if (!nonEmptyString(decision.scope) || !nonEmptyString(decision.answer)) {
    appendEvent(projectRoot, change, makeEvent(change, "user_decision_recorded", {
      accepted: false,
      reason: "missing_scope_or_answer",
      input_digest: inputDigest,
    }));
    return { event_type: "user_decision_recorded" as const, accepted: false, message: "决策文件缺少决策范围（scope）或答复内容（answer）" };
  }

  if (decision.scope.startsWith(CODE_REVIEW_DECISION_SCOPE_PREFIX)) {
    const normalizedAnswer = normalizeCodeReviewDecisionAnswer(decision.answer);
    if (!normalizedAnswer) {
      appendEvent(projectRoot, change, makeEvent(change, "user_decision_recorded", {
        accepted: false,
        scope: decision.scope,
        answer: decision.answer,
        reason: "invalid_code_review_decision_answer",
        input_digest: inputDigest,
      }));
      return {
        event_type: "user_decision_recorded" as const,
        accepted: false,
        message: `代码审查决策必须是 ${CODE_REVIEW_DECISION_ANSWER_LABELS.reopen_propose}、${CODE_REVIEW_DECISION_ANSWER_LABELS.reopen_apply} 或 ${CODE_REVIEW_DECISION_ANSWER_LABELS.dismiss}`,
      };
    }
    if (!nonEmptyString(decision.reason)) {
      appendEvent(projectRoot, change, makeEvent(change, "user_decision_recorded", {
        accepted: false,
        scope: decision.scope,
        answer: decision.answer,
        reason: "missing_reason",
        input_digest: inputDigest,
      }));
      return {
        event_type: "user_decision_recorded" as const,
        accepted: false,
        message: "代码审查决策必须写明原因",
      };
    }
  }

  const normalizedAnswer = decision.scope.startsWith(CODE_REVIEW_DECISION_SCOPE_PREFIX)
    ? normalizeCodeReviewDecisionAnswer(decision.answer)
    : null;
  const normalizedDecision = {
    scope: decision.scope,
    question: typeof decision.question === "string" ? decision.question : "",
    answer: normalizedAnswer ? codeReviewDecisionAnswerLabel(normalizedAnswer) : decision.answer,
    ...(typeof decision.reason === "string" ? { reason: decision.reason.trim() } : {}),
  };
  const rawRef = appendRawRecord(projectRoot, change, "user-decisions", normalizedDecision);
  const event = makeEvent(change, "user_decision_recorded", {
    ...normalizedDecision,
    accepted: true,
    input_digest: inputDigest,
    ...rawRef,
  });
  appendEvent(projectRoot, change, event);

  return {
    event_type: "user_decision_recorded" as const,
    accepted: true,
    message: `用户决策已登记：决策范围（scope）=${decision.scope}`,
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

function packetFieldDescriptions(): Record<string, string> {
  return {
    job_id: "工作项 ID，用于提交本次审查或验证报告。",
    packet_digest: "工作项说明摘要，用于证明报告对应的是当前这份工作项说明。",
    boundFiles: "本工作项绑定的文件清单；代码审查报告必须说明这些文件是否都看过。",
    review_scope: "报告中的审查覆盖范围，说明看了哪些文件、哪些没看及原因。",
    code_review_scope: "代码审查范围：从已审基点到当前 HEAD 的提交改动、工作区改动和未跟踪代码文件。",
    task_execution_index: "按任务汇总的执行证据：每个任务（task）的执行依据、声明测试、测试证据和改动文件。",
    contract: "任务启动时的执行依据快照：tests/design/source/reason/guard 分别对应 测试/设计/来源/原因/边界；null 表示历史任务没有执行依据。",
    changed_paths: "与某个任务（task）或代码状态检查相关的改动文件。",
    changed_paths_partial_reason: "该任务（task）的提交段 diff 失败原因；存在时 changed_paths 只包含工作区对比结果，归属可能不完整。",
    unattributed_paths: "代码审查范围中暂时无法归属到某个任务（task）的文件。",
    unknown_attribution_tasks: "因为缺少边界快照或提交段 diff 失败而无法完整计算改动归属的任务（task）。",
    coverage_exemption_refs: "测试覆盖豁免引用：说明某个 TEST 为什么没有绑定到任务（task）。",
    code_state_check: "代码状态检查：最终验证时用于判断代码审查后代码是否又发生变化。",
    event_id: "事件 ID，用于追溯证据来源。",
    event_digest: "事件摘要，用于确认引用的证据事件没有被替换。",
    attempt_id: "任务尝试 ID；执行依据模式下测试运行必须绑定当前活跃任务尝试。",
    task_structure_digest: "历史模式的任务结构指纹；仅用于兼容旧证据。",
    test_id: "测试契约里的 TEST ID。",
    semantic_status: "测试语义状态：RED 预期失败、GREEN 预期成功或特征化（characterization）通过。",
    covers_task_ids: "回归测试覆盖了哪些已完成任务（task）。",
    scope_note: "范围扩大说明；任务（task）实现超出执行依据边界时填写。",
  };
}

/** jobs packet：返回工作项执行说明 */
export function jobsPacket(
  projectRoot: string,
  change: string,
  jobId: string,
): { found: boolean; packet?: JobPacket; message: string } {
  const events = readEvents(projectRoot, change);
  const job = findJob(events, jobId);
  if (!job) {
    return { found: false, message: `工作项 ${jobId} 不存在` };
  }
  const isCodeReviewer = job.role === "code-reviewer";
  const packetContext = job.packet_context;
  return {
    found: true,
      packet: {
        job_id: job.job_id,
        role: job.role,
        ...(job.gate_id ? { gate_id: job.gate_id } : {}),
        recommended_agent: recommendedAgentForRole(job.role),
        boundFiles: job.boundFiles,
        ...(job.review_evidence_digest ? { review_evidence_digest: job.review_evidence_digest } : {}),
        ...(job.previous_rejection ? { previous_rejection: job.previous_rejection } : {}),
        ...(packetContext ? { packet_context: packetContext } : {}),
        ...(packetContext?.code_review_scope ? { code_review_scope: packetContext.code_review_scope } : {}),
        ...(packetContext?.coverage_exemption_refs ? { coverage_exemption_refs: packetContext.coverage_exemption_refs } : {}),
        ...(packetContext?.task_execution_index ? { task_execution_index: packetContext.task_execution_index } : {}),
        ...(packetContext?.unattributed_paths ? { unattributed_paths: packetContext.unattributed_paths } : {}),
        ...(packetContext?.unknown_attribution_tasks ? { unknown_attribution_tasks: packetContext.unknown_attribution_tasks } : {}),
        ...(packetContext?.code_state_check ? { code_state_check: packetContext.code_state_check } : {}),
        packet_digest: job.packet_digest,
        required_output_kind: "job_report_json",
        preferred_input_mode: "stdin",
        submission_command: `superspec record job-submit --change "${change}" --job "${job.job_id}" --report -`,
        submission_argv: jobSubmitArgv(change, job.job_id),
        file_fallback: true,
        output_contract_fields: isCodeReviewer
          ? [...REVIEW_REPORT_REQUIRED_FIELDS, "reviewer", "review_scope"]
          : requiresReviewer(job.role) ? [...REVIEW_REPORT_REQUIRED_FIELDS, "reviewer"] : [...REVIEW_REPORT_REQUIRED_FIELDS],
        output_contract_optional_fields: [...REVIEW_REPORT_OPTIONAL_FIELDS],
        字段说明: packetFieldDescriptions(),
        output_instructions:
          `${roleDescription(job.role)}。请审查 ${job.boundFiles.map(f => f.path).join(", ")}，` +
          (job.review_evidence_digest ? `本工作项对应的执行证据版本为 ${job.review_evidence_digest}，` : "") +
          (job.previous_rejection ? `上一次代码审查没有形成可推进结论，原因：${job.previous_rejection.reason}。本次请根据该原因重新审查，` : "") +
          (requiresReviewer(job.role) ? `必须由独立 ${recommendedAgentForRole(job.role)} 审查角色执行，并在审查者来源字段（reviewer.kind/id）中记录来源，` : "") +
          `产出 JSON 报告内容并优先通过 --report - 从 stdin 登记；文件路径模式仅作备用。协议字段含义见 packet 顶层“字段说明”，普通对话不要原样复述 JSON。` +
          (isCodeReviewer
            ? `最小格式：{"role":"code-reviewer","verdict":"pass|fail","review_scope":{"job_id":"${job.job_id}","packet_digest":"${job.packet_digest}","checked_paths":${JSON.stringify(job.boundFiles.map(f => f.path))},"checked_docs":${JSON.stringify(REVIEW_DOC_PATHS)},"unchecked":[]},"findings":[],"reviewer":{"kind":"codex-subagent","id":"<thread-or-agent-id>"}}；审查覆盖范围（review_scope）用来说明本次审查覆盖了哪些文件和文档，已检查路径（checked_paths）与未检查项（unchecked）必须合起来覆盖全部绑定文件（boundFiles），unchecked 条目格式为 {"path":"<path>","reason":"<reason>"}。`
              + `报告结论为 fail 时，问题列表（findings）至少包含一个可处理、可追溯的阻塞问题，字段为 {"id":"<stable-id>","blocking":true,"type":"implementation|spec|mixed","description":"<what>","evidence":"<why>","source_refs":["<path:line>"],"impact":"<impact>","suggested_action":"apply|propose"}。问题类型（type）中 implementation 表示纯代码实现问题，spec 表示方案/需求文档问题，mixed 表示需要使用者判断的混合问题。`
              + (packetContext?.task_execution_index
                ? `本工作项带任务执行索引（task_execution_index）：按 task 对照其执行依据快照（contract）审查——实现路线对照 design 引用原文、累计 diff 对照 guard 边界、测试断言对照 tests 声明的 scenario；每项的 scope_note 是执行者登记的范围扩大说明，判断其合理性与验证充分性；changed_paths 是归属线索不是结论（null 表示未知）；unattributed_paths 中的无主改动逐个判断合理性；coverage_exemption_refs 解释未绑定 task 的 TEST 豁免。`
                : "")
            : job.role === "verifier"
            ? `最小格式：{"role":"verifier","verdict":"pass|fail","findings":[]}。核对代码审查记录（code_review_gate）：passed 必须能追溯到已接受的代码审查工作项，skipped 必须能证明本次没有代码类改动。核对代码审查问题闭环：实现修复任务必须带审查修复引用（review_fix_of:<job_id>#<problem_id>），方案/混合问题必须有用户决策或后续修复证据。核对 RED/GREEN：证据须在同一已完成任务的任务尝试 ID（task_completed.attempt_id）下闭环——普通 TDD 任务至少一个同 TEST 先 RED（expected_failure）后 GREEN（expected_success）配对且每个声明 TEST 都有 GREEN；特征化任务（no_tdd_reason:characterization）可用 characterization_pass 作为通过证据，不要求 RED；测试运行证据应包含测试 ID（test_id）、命令（command）、工作目录（cwd）、退出码（exit_code）、语义状态（semantic_status）；审查修复的回归测试运行可用回归覆盖任务列表（covers_task_ids）说明覆盖了哪些已完成任务；缺少任务尝试 ID（attempt_id）的旧证据只能弱引用。` +
              (packetContext?.code_state_check
                ? `本工作项带代码状态检查（code_state_check）：head_matches 为 false 或 changed_paths 非空表示代码审查后代码又发生变化，须在报告中列出差异并交主流程与用户裁决，不自行判定无害，也不据此自动否定已接受的代码审查。`
                : "")
            : requiresReviewer(job.role)
            ? `最小格式：{"role":"${job.role}","verdict":"pass|fail","findings":[],"reviewer":{"kind":"codex-subagent","id":"<thread-or-agent-id>"}}`
            : `最小格式：{"role":"${job.role}","verdict":"pass|fail","findings":[]}`),
        stop_conditions: ["审查完成后提交报告，不要修改文档"],
        created_from_transition: job.created_from_transition,
      },
    message: `工作项 ${jobId} 的执行说明`,
  };
}
