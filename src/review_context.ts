// 计划材料审查的上下文：上一轮同角色审查已核实的证据与用户已确认的决定，供审查者复用而不必重新查找。

import { existsSync, statSync } from "node:fs";
import { isAbsolute, join, relative, resolve } from "node:path";
import { codeFileContentSha, gitLines, isCodeLikePath } from "./git_state.ts";
import { openQuestionDecisionClosure } from "./format.ts";
import type { ConfirmedDecision, EvidenceCodeFile, Event, Job, PreviousReviewEvidence } from "./types.ts";

const MAX_EVIDENCE_CODE_FILES = 300;
const PATH_TOKEN_RE = /[A-Za-z0-9_\-./]*[A-Za-z0-9_-]\.[A-Za-z][A-Za-z0-9]{0,7}(?![A-Za-z0-9])/g;

function collectStrings(value: unknown, out: string[], depth = 0): void {
  if (depth > 6) return;
  if (typeof value === "string") out.push(value);
  else if (Array.isArray(value)) for (const item of value) collectStrings(item, out, depth + 1);
  else if (value && typeof value === "object") for (const item of Object.values(value)) collectStrings(item, out, depth + 1);
}

function isProjectFile(projectRoot: string, path: string): boolean {
  const absolute = resolve(projectRoot, path);
  const relativePath = relative(projectRoot, absolute).replace(/\\/g, "/");
  if (!relativePath || relativePath === ".." || relativePath.startsWith("../") || isAbsolute(relativePath)) return false;
  return existsSync(absolute) && statSync(absolute).isFile();
}

/**
 * 报告正文中引用的代码文件及其当前内容指纹。引用可能只写文件名或路径后缀，
 * 按项目文件唯一匹配解析；无法唯一确定的引用不记录。
 */
export function evidenceCodeFiles(projectRoot: string, report: Record<string, unknown>): EvidenceCodeFile[] {
  const texts: string[] = [];
  for (const field of ["summary", "evidence_refs", "findings", "risks"] as const) collectStrings(report[field], texts);
  const candidates = new Set<string>();
  for (const text of texts) {
    for (const match of text.matchAll(PATH_TOKEN_RE)) {
      const token = match[0].replace(/^\.\//, "").replace(/^\/+/, "");
      if (isCodeLikePath(token)) candidates.add(token);
      if (candidates.size >= MAX_EVIDENCE_CODE_FILES) break;
    }
  }
  if (candidates.size === 0) return [];

  let byBasename: Map<string, string[]> | null = null;
  const resolveBySuffix = (token: string): string | null => {
    if (!byBasename) {
      byBasename = new Map();
      const listed = gitLines(projectRoot, ["ls-files", "--cached", "--others", "--exclude-standard"]);
      for (const file of listed.ok ? listed.lines : []) {
        const base = file.split("/").pop() ?? file;
        byBasename.set(base, [...(byBasename.get(base) ?? []), file]);
      }
    }
    const base = token.split("/").pop() ?? token;
    const matches = (byBasename.get(base) ?? []).filter(file => file === token || file.endsWith(`/${token}`));
    return matches.length === 1 ? matches[0] : null;
  };

  const files = new Map<string, string>();
  for (const token of candidates) {
    const path = isProjectFile(projectRoot, token) ? token : resolveBySuffix(token);
    if (!path || files.has(path)) continue;
    const sha = codeFileContentSha(projectRoot, path);
    if (sha) files.set(path, sha);
  }
  return [...files.entries()].map(([path, sha]) => ({ path, sha })).sort((a, b) => a.path.localeCompare(b.path));
}

function jobCreationIndex(events: Event[], jobId: string): number {
  const index = events.findIndex(ev =>
    ev.event_type === "transition_commit" &&
    ((ev.payload as { new_jobs?: Job[] }).new_jobs ?? []).some(job => job.job_id === jobId)
  );
  return index >= 0 ? index : events.length;
}

/** 工作项创建前，同 gate、同角色最近一次形成结论（通过或 review_failed）的审查所记录的证据。 */
export function previousReviewEvidence(projectRoot: string, events: Event[], job: Job): PreviousReviewEvidence | null {
  const priorEvents = events.slice(0, jobCreationIndex(events, job.job_id));
  const peers = new Set<string>();
  for (const ev of priorEvents) {
    if (ev.event_type !== "transition_commit") continue;
    for (const candidate of (ev.payload as { new_jobs?: Job[] }).new_jobs ?? []) {
      if (candidate.role === job.role && candidate.gate_id === job.gate_id) peers.add(candidate.job_id);
    }
  }
  const terminal = priorEvents.findLast(ev => {
    if (ev.event_type !== "job_accepted" && ev.event_type !== "job_rejected") return false;
    const payload = ev.payload as { job_id?: unknown; result_kind?: unknown };
    if (!peers.has(String(payload.job_id ?? ""))) return false;
    return ev.event_type === "job_accepted" || payload.result_kind === "review_failed";
  });
  if (!terminal) return null;
  const payload = terminal.payload as { job_id: string; summary?: unknown; evidence_refs?: unknown; evidence_code_files?: unknown };
  const recorded = Array.isArray(payload.evidence_code_files)
    ? payload.evidence_code_files.filter((item): item is EvidenceCodeFile =>
      !!item && typeof (item as EvidenceCodeFile).path === "string" && typeof (item as EvidenceCodeFile).sha === "string")
    : [];
  const summary = typeof payload.summary === "string" && payload.summary.trim() !== "" ? payload.summary : undefined;
  const evidenceRefs = Array.isArray(payload.evidence_refs) && payload.evidence_refs.length > 0 ? payload.evidence_refs : undefined;
  if (!summary && !evidenceRefs && recorded.length === 0) return null;
  return {
    job_id: payload.job_id,
    verdict: terminal.event_type === "job_accepted" ? "pass" : "fail",
    ...(summary ? { summary } : {}),
    ...(evidenceRefs ? { evidence_refs: evidenceRefs } : {}),
    code_files: recorded.map(file => ({ path: file.path, unchanged: codeFileContentSha(projectRoot, file.path) === file.sha })),
  };
}

/** 工作项创建前已登记的 Explore/Propose 问题答复，同一问题取最近一次有效登记。 */
export function confirmedDecisions(events: Event[], job: Job): ConfirmedDecision[] {
  const priorEvents = events.slice(0, jobCreationIndex(events, job.job_id));
  const latest = new Map<string, ConfirmedDecision>();
  for (const ev of priorEvents) {
    if (ev.event_type !== "user_decision_recorded") continue;
    const payload = ev.payload as Record<string, unknown>;
    if (payload.accepted !== true || typeof payload.scope !== "string" || openQuestionDecisionClosure(payload) !== "closed") continue;
    const phase = payload.scope.startsWith("explore_open_question:")
      ? "explore"
      : payload.scope.startsWith("propose_open_question:") ? "propose" : null;
    if (!phase || typeof payload.answer !== "string" || payload.answer.trim() === "") continue;
    const identity = payload[`${phase}_open_question`] as { question_id?: unknown } | undefined;
    const earlierAnswers = Array.isArray(payload.earlier_answers)
      ? payload.earlier_answers.flatMap(item => {
        const earlier = item as { answer?: unknown; followup?: unknown };
        return typeof earlier.answer === "string"
          ? [{ answer: earlier.answer, ...(typeof earlier.followup === "string" ? { followup: earlier.followup } : {}) }]
          : [];
      })
      : [];
    latest.set(payload.scope, {
      phase,
      question_id: typeof identity?.question_id === "string" ? identity.question_id : null,
      question: typeof payload.question === "string" ? payload.question : "",
      answer: payload.answer,
      ...(earlierAnswers.length > 0 ? { earlier_answers: earlierAnswers } : {}),
      event_id: ev.event_id,
    });
  }
  return [...latest.values()];
}
