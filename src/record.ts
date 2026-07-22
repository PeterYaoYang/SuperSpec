// SuperSpec 流程引擎 — record：工作项结果登记

import { existsSync, readFileSync } from "node:fs";
import { isAbsolute, join, relative, resolve } from "node:path";
import {
  ensureChangeLayout, readEvents, appendEvent, makeEvent,
  sha256File, sha256Text, withLock, appendRawRecord, type RawRecordRef,
} from "./store.ts";
import { rebuildSnapshot } from "./sync.ts";
import { changeRoot as openspecChangeRoot } from "./openspec.ts";
import {
  isPhaseConfirmationScope,
  phaseActionForAnswer,
  phaseConfirmationForCurrentState,
  workflowRiskForPhaseConfirmation,
  type PhaseConfirmation,
  type PhaseDecisionAction,
} from "./phase_confirmation.ts";
import {
  CODE_REVIEW_DECISION_ANSWER_LABELS,
  CODE_REVIEW_DECISION_SCOPE_PREFIX,
  codeReviewJobStaleReason,
  codeReviewDecisionAnswerLabel,
  currentCodeReviewWorkingPaths,
  latestCodeReviewFailedStatus,
  normalizeCodeReviewDecisionAnswer,
  parseCodeReviewDecisionScope,
} from "./code_review.ts";
import { invalidReasonForSubmittedReport } from "./job_validity.ts";
import { jobSubmitArgv } from "./job_action.ts";
import {
  REVIEW_DOC_PATHS,
  REVIEW_REJECTION_OVERRIDE_SCOPE_PREFIX,
  REVIEW_REJECTION_OVERRIDE_ANSWER,
  parseReviewRejectionOverrideScope,
  reviewGateRoleResolution,
  reviewRejectionOverrideScope,
  type ReviewRejectionDecisionSource,
} from "./review.ts";
import { EXPLORE_DISCOVERY_REVIEW_GATE, PROPOSE_FINAL_REVIEW_GATE, type ReviewGateRule } from "./review_job_gates.ts";
import { RecordInputDecodingError, readRecordInputFile } from "./record_input.ts";
import { currentExploreRoundId } from "./explore_round.ts";
import {
  currentProposeOpenQuestion,
  currentProposeQuestionContent,
  currentProposeRoundId,
} from "./propose_round.ts";
import {
  discoveryOpenQuestionDisplayText,
  discoveryQuestionContextFingerprint,
  discoveryQuestionDecisionBasisDigest,
  discoveryOpenQuestionScope,
  legacyDiscoveryOpenQuestionScope,
  EXPLORE_OPEN_QUESTION_SCOPE_PREFIX,
  parseDiscoveryOpenQuestions,
  proposeOpenQuestionDisplayText,
  proposeOpenQuestionScope,
  proposeQuestionContextFingerprint,
  proposeQuestionDecisionBasisDigest,
  legacyProposeOpenQuestionScope,
  PROPOSE_OPEN_QUESTION_SCOPE_PREFIX,
  type DiscoveryOpenQuestion,
  type ProposeQuestion,
} from "./format.ts";
import type { CodeReviewResultKind, Event, RecordResult, Job, JobPacket, JobRole, JobState } from "./types.ts";

const REVIEW_REPORT_REQUIRED_FIELDS = ["role", "verdict", "findings"] as const;
const REVIEW_REPORT_OPTIONAL_FIELDS = ["summary", "evidence_refs", "risks", "open_questions"] as const;
const REVIEWER_KINDS = new Set(["codex-subagent", "human", "external-agent"]);
const CODE_REVIEW_FINDING_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._:-]*$/;

function isReviewRole(role: JobRole): boolean {
  return role === "critic" || role === "architect" || role === "test-engineer" || role === "code-reviewer" || role === "verifier";
}

function requiresReviewer(role: JobRole): boolean {
  return role === "critic" || role === "architect" || role === "test-engineer" || role === "code-reviewer";
}

/** All review reports with bound material acknowledge full file coverage. */
function requiresReviewScope(job: Job): boolean {
  return job.boundFiles.length > 0 && isReviewRole(job.role);
}

function projectLocalInvalidReportMustTerminate(job: Job): boolean {
  return job.role === "code-reviewer" || job.packet_context?.code_state_check !== undefined;
}

function isOrdinaryReviewer(role: JobRole): boolean {
  return role === "critic" || role === "architect" || role === "test-engineer";
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

function previousRejectionInstruction(job: Job): string {
  const previous = job.previous_rejection;
  if (!previous) return "";
  const reason = `上一次同角色审查没有形成可推进结论，原因：${previous.reason}。`;
  if (!previous.findings || previous.findings.length === 0) {
    return `${reason}上一轮没有可复核的历史 finding；请按当前 gate 的完整范围独立审查，不要把拒绝原因当作需求或验收标准，`;
  }
  const identityRule = job.role === "code-reviewer"
    ? "同一问题仍存在时复用原 finding ID；legacy finding 没有 ID 时沿用原始语义并补一个稳定 ID；"
    : "已解决或已由等价证据闭环的问题不要重复报告，不得通过更换标题或措辞重复同一问题；";
  return `${reason}本轮是修复复核：逐项判断本工作项附带的上一次同角色 finding 是否仍成立。Finding 中的 recommendation 只是非绑定建议，不是需求或验收标准；先独立核对 underlying problem、直接证据和本次验收，不得因原建议指定了某种架构就要求照做。修正不得通过缩小已确认范围、改写用户决定或删除验收来让 finding 字面消失；这类偏离属于本次修正直接引入的回归。${identityRule}默认只复核历史 finding；新 blocker 仅允许是本次修正直接引入的回归，并必须说明“修正动作 → 新问题”的因果链，不得展开无关的故障模型、消费者或架构议题。`;
}

function reviewScopeForJob(job: Job): { reviewTargets: string[]; readOnlyRefs: string[] } {
  if (job.review_targets !== undefined || job.read_only_refs !== undefined) {
    return {
      reviewTargets: job.review_targets ?? [],
      readOnlyRefs: job.read_only_refs ?? [],
    };
  }
  const gate = [EXPLORE_DISCOVERY_REVIEW_GATE, PROPOSE_FINAL_REVIEW_GATE]
    .find(candidate => candidate.isJobForGate(job));
  return gate
    ? { reviewTargets: [...gate.reviewTargets], readOnlyRefs: [...gate.readOnlyRefs] }
    : { reviewTargets: [], readOnlyRefs: [] };
}

function reviewScopeInstruction(job: Job, reviewTargets: string[], readOnlyRefs: string[]): string {
  if (reviewTargets.length === 0 && readOnlyRefs.length === 0) {
    return `请审查 ${job.boundFiles.map(file => file.path).join(", ")}，`;
  }
  const targets = reviewTargets.length > 0 ? `本 gate 可提出修改建议的审查目标为 ${reviewTargets.join(", ")}。` : "";
  const refs = readOnlyRefs.length > 0
    ? `只读上游引用为 ${readOnlyRefs.join(", ")}；只允许读取和核对一致性，不得要求在当前阶段修改、追加、删除、重排或格式化这些文件。只读引用中与本次目标或绑定上游事实无直接因果关系的历史质量问题不得作为本 gate 的 fail。如果本次审查目标或 boundFiles 中绑定的上游事实直接造成变更包跨文档不一致，并且会影响明确验收或实施落地，可以 fail；finding 必须锚定为当前变更包未完成一致性闭环，required outcome 只要求消除矛盾，不得指定必须修改哪份文档或采用哪种技术方案。`
    : "";
  return targets + refs;
}

function genericReviewCoverageInstruction(job: Job): string {
  if (!requiresReviewScope(job)) return "";
  return "完整审查全部 boundFiles，不因发现第一个 blocker 停止；read_only_refs 只在核对本次问题与上下游一致性时读取。review_scope.checked_paths 只填写本次实际浏览并完成语义审查的绑定文件，不能根据 packet 预填；未检查项如实写入 unchecked。覆盖回执不能代替语义审查，也不扩大可报告问题的范围。";
}

function proposalIncrementalReviewInstruction(job: Job): string {
  if (!PROPOSE_FINAL_REVIEW_GATE.isJobForGate(job)) return "";
  return "若 proposal.md 有“需求变化”，以其中记录的受影响能力、直接修改章节和保持不变范围作为增量审查锚点；新 finding 必须由该变化、其直接修改或由此造成的跨文档矛盾引起，并说明因果链。此前已通过且明确保持不变的设计不得重新打开为 blocker；Recommendation 只描述需要补足的结果、契约或证据，不得把未经 proposal、design 或用户决定选定的新基础设施写成 required fix。";
}

function migrationEvidenceInstruction(job: Job): string {
  const isProposeReview = PROPOSE_FINAL_REVIEW_GATE.isJobForGate(job);
  if (!isProposeReview) return "";
  return "迁移与环境证据按阶段分层：Explore 记录迁移风险、兼容约束和外部未知；Propose 只需审查迁移策略、回滚/兼容设计、任务与可执行测试计划；Apply/Review 才记录实际 datasource、制品 SHA、Flyway history、审计日志和运行证据。可因策略、计划或文档矛盾而 fail；不得只因实际环境证据尚未产生而 fail。";
}

function recordInputInstruction(job: Job): string {
  const encoding = "stdin 请传 UTF-8 JSON；Windows PowerShell 请设置 $OutputEncoding 和 [Console]::OutputEncoding 为 UTF-8，文件备用方式请使用 Set-Content -Encoding utf8。为兼容旧版 PowerShell，带 BOM 的 UTF-16LE 文件也可接受。";
  if (!projectLocalInvalidReportMustTerminate(job)) return encoding;
  return `${encoding}项目内 fallback 报告若存在解码或协议错误会终结当前工作项，以免被后续代码状态检查当作改动；如需保留同一工作项重交，请使用 stdin 或工作区外临时文件。`;
}

function asObject(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

function nonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim() !== "";
}

function currentDiscoveryOpenQuestion(projectRoot: string, change: string): DiscoveryOpenQuestion | null {
  const discoveryPath = join(openspecChangeRoot(projectRoot, change), ".superspec", "artifacts", "discovery.md");
  if (!existsSync(discoveryPath)) return null;
  return parseDiscoveryOpenQuestions(readFileSync(discoveryPath, "utf8"))[0] ?? null;
}

function latestAcceptedExploreOpenQuestionDecision(
  events: Event[],
  scopes: readonly string[],
  identity: { roundId: string; questionId: string; questionOrdinal: number; decisionBasisDigest: string },
): Event | null {
  return [...events].reverse().find(event => {
    if (event.event_type !== "user_decision_recorded") return false;
    const payload = event.payload as {
      scope?: unknown;
      accepted?: unknown;
      explore_open_question?: {
        round_id?: unknown;
        question_id?: unknown;
        question_ordinal?: unknown;
        decision_basis_digest?: unknown;
      };
    };
    if (payload.accepted === false) return false;
    const recorded = payload.explore_open_question;
    if (recorded && typeof recorded.decision_basis_digest === "string") {
      return recorded.round_id === identity.roundId &&
        recorded.question_id === identity.questionId &&
        (!identity.questionId.startsWith("item-") || recorded.question_ordinal === identity.questionOrdinal) &&
        recorded.decision_basis_digest === identity.decisionBasisDigest;
    }
    return typeof payload.scope === "string" && scopes.includes(payload.scope);
  }) ?? null;
}

function isExploreOpenQuestionScope(scope: string): boolean {
  return scope.startsWith(EXPLORE_OPEN_QUESTION_SCOPE_PREFIX);
}

function isWellFormedExploreOpenQuestionScope(scope: string): boolean {
  return /^explore_open_question:sha256:[a-f0-9]{64}:(?:Q-[A-Za-z0-9][A-Za-z0-9_-]*|item-[1-9]\d*)$/.test(scope);
}

function invalidExploreOpenQuestionResult(
  projectRoot: string,
  change: string,
  inputDigest: string,
  existing: Event | undefined,
  decision: { scope: string; answer: string },
  reason:
    | "invalid_explore_open_question_scope"
    | "stale_explore_open_question_scope"
    | "explore_open_question_already_recorded",
): RecordResult {
  const existingPayload = existing?.payload as { accepted?: unknown; reason?: unknown } | undefined;
  if (existingPayload?.accepted === false && existingPayload.reason === reason) {
    return {
      event_type: "user_decision_recorded" as const,
      accepted: false,
      message: "幂等返回：同一无效待确认问题答复已登记",
    };
  }
  appendEvent(projectRoot, change, makeEvent(change, "user_decision_recorded", {
    accepted: false,
    scope: decision.scope,
    answer: decision.answer,
    reason,
    input_digest: inputDigest,
  }));
  return {
    event_type: "user_decision_recorded" as const,
    accepted: false,
    message: reason === "invalid_explore_open_question_scope"
      ? "确认事项的内部标识无效，请重新执行 next 获取当前事项"
      : reason === "explore_open_question_already_recorded"
        ? "这件事已有已登记答复，请先回写 discovery.md 后重新执行 next"
      : "需要确认的事项已变化或已完成，请重新执行 next 获取当前事项",
  };
}

function latestAcceptedProposeOpenQuestionDecision(
  events: Event[],
  scopes: readonly string[],
  identity: { roundId: string; path: string; questionId: string; questionOrdinal: number; decisionBasisDigest: string },
): Event | null {
  return [...events].reverse().find(event => {
    if (event.event_type !== "user_decision_recorded") return false;
    const payload = event.payload as {
      scope?: unknown;
      accepted?: unknown;
      propose_open_question?: {
        round_id?: unknown;
        path?: unknown;
        question_id?: unknown;
        question_ordinal?: unknown;
        decision_basis_digest?: unknown;
      };
    };
    if (payload.accepted === false) return false;
    const recorded = payload.propose_open_question;
    if (recorded && typeof recorded.decision_basis_digest === "string") {
      return recorded.round_id === identity.roundId &&
        recorded.path === identity.path &&
        recorded.question_id === identity.questionId &&
        (!identity.questionId.startsWith("item-") || recorded.question_ordinal === identity.questionOrdinal) &&
        recorded.decision_basis_digest === identity.decisionBasisDigest;
    }
    return typeof payload.scope === "string" && scopes.includes(payload.scope);
  }) ?? null;
}

function isProposeOpenQuestionScope(scope: string): boolean {
  return scope.startsWith(PROPOSE_OPEN_QUESTION_SCOPE_PREFIX);
}

function isWellFormedProposeOpenQuestionScope(scope: string): boolean {
  return /^propose_open_question:sha256:[a-f0-9]{64}:(?:DEC-[A-Za-z0-9][A-Za-z0-9_-]*|item-[1-9]\d*)$/.test(scope);
}

function invalidProposeOpenQuestionResult(
  projectRoot: string,
  change: string,
  inputDigest: string,
  existing: Event | undefined,
  decision: { scope: string; answer: string },
  reason:
    | "invalid_propose_open_question_scope"
    | "stale_propose_open_question_scope"
    | "propose_open_question_already_recorded",
): RecordResult {
  const existingPayload = existing?.payload as { accepted?: unknown; reason?: unknown } | undefined;
  if (existingPayload?.accepted === false && existingPayload.reason === reason) {
    return { event_type: "user_decision_recorded", accepted: false, message: "幂等返回：同一无效设计决定答复已登记" };
  }
  appendEvent(projectRoot, change, makeEvent(change, "user_decision_recorded", {
    accepted: false,
    scope: decision.scope,
    answer: decision.answer,
    reason,
    input_digest: inputDigest,
  }));
  return {
    event_type: "user_decision_recorded",
    accepted: false,
    message: reason === "invalid_propose_open_question_scope"
      ? "设计决定的内部标识无效，请重新执行 next 获取当前事项"
      : reason === "propose_open_question_already_recorded"
        ? "这项设计决定已有答复，请先回写计划材料后重新执行 next"
        : "需要确认的设计决定已变化或已完成，请重新执行 next 获取当前事项",
  };
}

function invalidCodeReviewDecisionResult(
  projectRoot: string,
  change: string,
  inputDigest: string,
  existing: Event | undefined,
  decision: { scope: string; answer: unknown },
  reason: string,
  message: string,
): RecordResult {
  const existingPayload = existing?.payload as { accepted?: unknown; reason?: unknown } | undefined;
  if (existingPayload?.accepted === false && existingPayload.reason === reason) {
    return { event_type: "user_decision_recorded", accepted: false, message: "幂等返回：同一无效代码审查决策已登记" };
  }
  appendEvent(projectRoot, change, makeEvent(change, "user_decision_recorded", {
    accepted: false,
    scope: decision.scope,
    answer: decision.answer,
    reason,
    input_digest: inputDigest,
  }));
  return { event_type: "user_decision_recorded", accepted: false, message };
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
    if (obj.verdict === "pass" && uncheckedPaths.size > 0) {
      checks.push("代码审查结论为 pass 时不能包含未检查的绑定文件");
    }
  }
}

function validateReviewScope(
  obj: Record<string, unknown>,
  job: Job,
  checks: string[],
): void {
  const scope = asObject(obj.review_scope);
  if (!scope) {
    checks.push("审查报告缺少覆盖范围字段 review_scope");
    return;
  }
  if (!stringArray(scope.checked_paths)) {
    checks.push("审查报告覆盖范围里的 checked_paths 必须是字符串数组");
    return;
  }
  const checkedPaths = new Set(scope.checked_paths);
  for (const bound of job.boundFiles) {
    if (!checkedPaths.has(bound.path)) {
      checks.push(`审查报告未说明已检查 ${bound.path}`);
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
    result_kind: "review_failed",
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

function ordinaryReviewGateForJob(job: Job): ReviewGateRule | null {
  return [EXPLORE_DISCOVERY_REVIEW_GATE, PROPOSE_FINAL_REVIEW_GATE]
    .find(gate => gate.isJobForGate(job)) ?? null;
}

function invalidReviewRejectionOverrideResult(
  projectRoot: string,
  change: string,
  inputDigest: string,
  decision: { scope: string; answer: unknown; decision_source?: unknown },
  reason: string,
  message: string,
): RecordResult {
  appendEvent(projectRoot, change, makeEvent(change, "user_decision_recorded", {
    accepted: false,
    scope: decision.scope,
    answer: decision.answer,
    ...(decision.decision_source !== undefined ? { decision_source: decision.decision_source } : {}),
    reason,
    input_digest: inputDigest,
  }));
  return { event_type: "user_decision_recorded", accepted: false, message };
}

/** 检查 job 是否已终态 */
function jobTerminalState(events: Event[], jobId: string): JobState | null {
  for (const ev of events) {
    if (ev.event_type === "job_accepted" && (ev.payload as { job_id: string }).job_id === jobId) return "accepted";
    if (ev.event_type === "job_rejected" && (ev.payload as { job_id: string }).job_id === jobId) return "rejected";
  }
  return null;
}

function jobInvalidated(events: Event[], jobId: string): boolean {
  return events.some(ev =>
    ev.event_type === "job_invalidated" &&
    (ev.payload as { job_id?: unknown }).job_id === jobId
  );
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

function retryableJobSubmitResult(jobId: string, checks: string[]): RecordResult {
  return {
    accepted: false,
    message: `工作项 ${jobId} 的报告未接受，可修正后以同一工作项重新提交：${checks.join("; ")}`,
    job_state: "requested",
    events_written: 0,
  };
}

function terminalInvalidReportResult(input: {
  projectRoot: string;
  change: string;
  jobId: string;
  job: Job;
  reportDigest: string;
  reason: string;
  parsedReport: Record<string, unknown> | null;
  reportPath: string | null;
}): RecordResult {
  const rawRef = input.job.role === "code-reviewer" && input.parsedReport
    ? appendRawRecord(input.projectRoot, input.change, "review-reports", input.parsedReport)
    : null;
  appendEvent(input.projectRoot, input.change, makeEvent(input.change, "job_rejected", codeReviewRejectEventPayload({
    jobId: input.jobId,
    job: input.job,
    reportDigest: input.reportDigest,
    resultKind: "invalid_report",
    reason: input.reason,
    parsedReport: input.parsedReport,
    rawRef,
    reportPath: input.reportPath,
  })));
  return {
    event_type: "job_rejected",
    accepted: false,
    message: `工作项 ${input.jobId} 被拒绝：${input.reason}`,
    job_state: "rejected",
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
      } else if ((isOrdinaryReviewer(job.role) || job.role === "verifier") && obj.verdict === "fail" && obj.findings.length === 0) {
        checks.push("审查报告结论为 fail 时 findings 至少包含一个问题");
      }
      if (requiresReviewer(job.role)) {
        validateReviewer(obj, checks);
      }
      if (job.role === "code-reviewer") {
        validateCodeReviewScope(parsedReport, job, checks);
      } else if (requiresReviewScope(job)) {
        validateReviewScope(parsedReport, job, checks);
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
  if (!reportContent.trim() && !checks.includes("报告内容为空")) {
    checks.push("报告内容为空");
  }

  if (invalidReason) {
    return terminalInvalidReportResult({
      projectRoot, change, jobId, job, reportDigest, reason: invalidReason, parsedReport, reportPath,
    });
  }

  // Code-state-sensitive review jobs must record project-local fallback paths for later scope scans.
  if (checks.length > 0 && projectLocalInvalidReportMustTerminate(job) && reportPath) {
    return terminalInvalidReportResult({
      projectRoot, change, jobId, job, reportDigest, reason: checks.join("; "), parsedReport, reportPath,
    });
  }
  if (checks.length > 0) return retryableJobSubmitResult(jobId, checks);

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
        if (projectLocalInvalidReportMustTerminate(job) && reportPath) {
          return terminalInvalidReportResult({
            projectRoot, change, jobId, job, reportDigest, reason, parsedReport, reportPath,
          });
        }
        return retryableJobSubmitResult(jobId, [reason]);
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

    if (jobInvalidated(events, jobId)) {
      return { accepted: false, message: `工作项 ${jobId} 已因回退到更早阶段失效，不接受新报告。` };
    }
    const terminal = jobTerminalState(events, jobId);
    if (terminal) {
      const reportDigest = sha256File(reportFile) ?? "sha256:unknown";
      return terminalJobSubmitResult(events, jobId, terminal, reportDigest);
    }

    if (!existsSync(reportFile)) {
      return retryableJobSubmitResult(jobId, [`报告文件不存在：${reportFile}`]);
    }
    const reportDigest = sha256File(reportFile) ?? "sha256:unknown";
    let reportContent: string;
    try {
      reportContent = readRecordInputFile(reportFile);
    } catch (err) {
      if (err instanceof RecordInputDecodingError) {
        const reportPath = projectRelativePath(projectRoot, reportFile);
        if (projectLocalInvalidReportMustTerminate(job) && reportPath) {
          return terminalInvalidReportResult({
            projectRoot, change, jobId, job, reportDigest, reason: err.message, parsedReport: null, reportPath,
          });
        }
        return retryableJobSubmitResult(jobId, [err.message]);
      }
      throw err;
    }
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

    if (jobInvalidated(events, jobId)) {
      return { accepted: false, message: `工作项 ${jobId} 已因回退到更早阶段失效，不接受新报告。` };
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
  const existing = [...events].reverse().find(
    e => e.event_type === "user_decision_recorded"
      && (e.payload as { input_digest?: string }).input_digest === inputDigest
  );

  let decision: {
    scope?: unknown;
    question?: unknown;
    answer?: unknown;
    reason?: unknown;
    decision_source?: unknown;
    review_risk?: unknown;
  };
  try {
    decision = JSON.parse(content);
  } catch {
    if (existing) {
      const accepted = (existing.payload as { accepted?: unknown }).accepted !== false;
      return {
        event_type: "user_decision_recorded" as const,
        accepted,
        message: accepted ? "幂等返回：同一用户决策已登记" : "幂等返回：同一无效用户决策已登记",
      };
    }
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
  // Explore 的用户答复只能绑定当前文档顺序中的第一项。这里不判断答案是否
  // “正确”，只机械校验当前项、Discovery 决策上下文和 Explore 轮次仍与 next
  // 返回时一致。决定身份绑定问题项中明确写出的 basis；其它文档内容不参与当前
  // scope，避免无关材料编辑触发重复提问。
  let exploreOpenQuestion: DiscoveryOpenQuestion | null = null;
  let exploreOpenQuestionRoundId: string | null = null;
  let exploreOpenQuestionContextFingerprint: string | null = null;
  let exploreOpenQuestionBasisDigest: string | null = null;
  if (isExploreOpenQuestionScope(decision.scope)) {
    if (!isWellFormedExploreOpenQuestionScope(decision.scope)) {
      return invalidExploreOpenQuestionResult(
        projectRoot,
        change,
        inputDigest,
        existing,
        { scope: decision.scope, answer: decision.answer },
        "invalid_explore_open_question_scope",
      );
    }
    const current = currentDiscoveryOpenQuestion(projectRoot, change);
    const exploreRoundId = currentExploreRoundId(events);
    const expectedScopes = current
      ? [discoveryOpenQuestionScope(current, exploreRoundId), legacyDiscoveryOpenQuestionScope(current, exploreRoundId)]
      : [];
    if (!expectedScopes.includes(decision.scope)) {
      return invalidExploreOpenQuestionResult(
        projectRoot,
        change,
        inputDigest,
        existing,
        { scope: decision.scope, answer: decision.answer },
        "stale_explore_open_question_scope",
      );
    }
    const currentBasisDigest = current ? discoveryQuestionDecisionBasisDigest(current) : "";
    const acceptedForCurrentScope = latestAcceptedExploreOpenQuestionDecision(events, expectedScopes, {
      roundId: exploreRoundId,
      questionId: current!.id,
      questionOrdinal: current!.ordinal,
      decisionBasisDigest: currentBasisDigest,
    });
    if (acceptedForCurrentScope) {
      const previousAnswer = (acceptedForCurrentScope.payload as { answer?: unknown }).answer;
      if (previousAnswer === decision.answer) {
        return {
          event_type: "user_decision_recorded" as const,
          accepted: true,
          message: "幂等返回：同一用户决策已登记",
        };
      }
      return invalidExploreOpenQuestionResult(
        projectRoot,
        change,
        inputDigest,
        existing,
        { scope: decision.scope, answer: decision.answer },
        "explore_open_question_already_recorded",
      );
    }
    exploreOpenQuestion = current;
    exploreOpenQuestionRoundId = exploreRoundId;
    const discoveryPath = join(openspecChangeRoot(projectRoot, change), ".superspec", "artifacts", "discovery.md");
    exploreOpenQuestionContextFingerprint = current
      ? discoveryQuestionContextFingerprint(readFileSync(discoveryPath, "utf8"), current)
      : null;
    exploreOpenQuestionBasisDigest = currentBasisDigest;
  }

  let proposeOpenQuestion: ProposeQuestion | null = null;
  let proposeOpenQuestionRoundId: string | null = null;
  let proposeOpenQuestionContextFingerprint: string | null = null;
  let proposeOpenQuestionBasisDigest: string | null = null;
  if (isProposeOpenQuestionScope(decision.scope)) {
    if (!isWellFormedProposeOpenQuestionScope(decision.scope)) {
      return invalidProposeOpenQuestionResult(
        projectRoot,
        change,
        inputDigest,
        existing,
        { scope: decision.scope, answer: decision.answer },
        "invalid_propose_open_question_scope",
      );
    }
    const changeRoot = openspecChangeRoot(projectRoot, change);
    const current = currentProposeOpenQuestion(changeRoot);
    const proposeRoundId = currentProposeRoundId(events);
    const expectedScopes = current
      ? [proposeOpenQuestionScope(current, proposeRoundId), legacyProposeOpenQuestionScope(current, proposeRoundId)]
      : [];
    if (!expectedScopes.includes(decision.scope)) {
      return invalidProposeOpenQuestionResult(
        projectRoot,
        change,
        inputDigest,
        existing,
        { scope: decision.scope, answer: decision.answer },
        "stale_propose_open_question_scope",
      );
    }
    const currentBasisDigest = current ? proposeQuestionDecisionBasisDigest(current) : "";
    const acceptedForCurrentScope = latestAcceptedProposeOpenQuestionDecision(events, expectedScopes, {
      roundId: proposeRoundId,
      path: current!.path,
      questionId: current!.id,
      questionOrdinal: current!.ordinal,
      decisionBasisDigest: currentBasisDigest,
    });
    if (acceptedForCurrentScope) {
      const previousAnswer = (acceptedForCurrentScope.payload as { answer?: unknown }).answer;
      if (previousAnswer === decision.answer) {
        return { event_type: "user_decision_recorded", accepted: true, message: "幂等返回：同一用户决策已登记" };
      }
      return invalidProposeOpenQuestionResult(
        projectRoot,
        change,
        inputDigest,
        existing,
        { scope: decision.scope, answer: decision.answer },
        "propose_open_question_already_recorded",
      );
    }
    const content = current ? currentProposeQuestionContent(changeRoot, current) : null;
    proposeOpenQuestion = current;
    proposeOpenQuestionRoundId = proposeRoundId;
    proposeOpenQuestionContextFingerprint = current && content
      ? proposeQuestionContextFingerprint(content, current)
      : null;
    proposeOpenQuestionBasisDigest = currentBasisDigest;
  }

  let phaseConfirmation: PhaseConfirmation | null = null;
  let phaseAction: PhaseDecisionAction | null = null;
  let phaseReviewRisk: "minimal" | "normal" | "strict" | null = null;
  if (isPhaseConfirmationScope(decision.scope)) {
    const existingAccepted = existing &&
      (existing.payload as { accepted?: unknown }).accepted !== false;
    const latestAcceptedForScope = [...events].reverse().find(event => {
      if (event.event_type !== "user_decision_recorded") return false;
      const payload = event.payload as {
        scope?: unknown;
        accepted?: unknown;
        phase_confirmation?: unknown;
      };
      return payload.accepted !== false &&
        payload.scope === decision.scope &&
        payload.phase_confirmation != null;
    });
    const changeRoot = openspecChangeRoot(projectRoot, change);
    const snapshot = rebuildSnapshot(projectRoot, change, changeRoot);
    // mode 是状态机从配置/round 快照推导的输入，不接受 user-decision JSON 注入。
    const decisionRisk = workflowRiskForPhaseConfirmation(projectRoot, events, snapshot);
    const current = phaseConfirmationForCurrentState(projectRoot, events, snapshot, decisionRisk);
    if (
      existingAccepted &&
      current?.scope === decision.scope &&
      latestAcceptedForScope?.event_id === existing.event_id
    ) {
      return {
        event_type: "user_decision_recorded" as const,
        accepted: true,
        message: "幂等返回：同一用户决策已登记",
      };
    }
    const action = current ? phaseActionForAnswer(current, decision.answer) : null;
    const rejectionReason = !current
      ? "phase_confirmation_not_pending"
      : decision.scope !== current.scope
        ? "stale_phase_confirmation_scope"
        : !action
          ? "invalid_phase_confirmation_answer"
          : action.reason === "required" && !nonEmptyString(decision.reason)
            ? "missing_phase_confirmation_reason"
          : null;
    if (rejectionReason) {
      if (
        existing &&
        (existing.payload as { accepted?: unknown; reason?: unknown }).accepted === false &&
        (existing.payload as { reason?: unknown }).reason === rejectionReason
      ) {
        return {
          event_type: "user_decision_recorded" as const,
          accepted: false,
          message: "幂等返回：同一无效阶段确认已登记",
        };
      }
      appendEvent(projectRoot, change, makeEvent(change, "user_decision_recorded", {
        accepted: false,
        scope: decision.scope,
        answer: decision.answer,
        reason: rejectionReason,
        input_digest: inputDigest,
      }));
      const message = rejectionReason === "invalid_phase_confirmation_answer" && current
        ? `阶段确认答复必须精确为：${current.ask.allowed_answers.join("、")}`
        : rejectionReason === "missing_phase_confirmation_reason" && action
          ? action.reason_prompt ?? "当前选择必须写明原因"
          : "阶段确认已失效或当前没有待确认的阶段边界，请重新执行 next";
      return { event_type: "user_decision_recorded" as const, accepted: false, message };
    }
    phaseConfirmation = current;
    phaseAction = action;
    phaseReviewRisk = decisionRisk;
  }

  // Explore scope 已在上面按当前问题和同 scope 的已接受答复完成校验。此前同一
  // input 曾因 stale 被拒绝、但材料后来回到完全相同的当前项时，不能让旧拒绝
  // 记录永久吞掉一次现在有效的登记。
  if (existing && !phaseAction && !exploreOpenQuestion) {
    const accepted = (existing.payload as { accepted?: unknown }).accepted !== false;
    return {
      event_type: "user_decision_recorded" as const,
      accepted,
      message: accepted ? "幂等返回：同一用户决策已登记" : "幂等返回：同一无效用户决策已登记",
    };
  }

  let reviewRejectionOverride: {
    job_id: string;
    role: JobRole;
    gate_id: NonNullable<Job["gate_id"]>;
    packet_digest: string;
  } | null = null;
  let reviewRejectionDecisionSource: ReviewRejectionDecisionSource | null = null;
  if (decision.scope.startsWith(REVIEW_REJECTION_OVERRIDE_SCOPE_PREFIX)) {
    const jobId = parseReviewRejectionOverrideScope(decision.scope);
    if (!jobId) {
      return invalidReviewRejectionOverrideResult(
        projectRoot, change, inputDigest,
        { scope: decision.scope, answer: decision.answer, decision_source: decision.decision_source },
        "invalid_review_rejection_override_scope",
        "审查拒绝裁决 scope 必须包含有效 job ID",
      );
    }
    if (decision.scope !== reviewRejectionOverrideScope(jobId)) {
      return invalidReviewRejectionOverrideResult(
        projectRoot, change, inputDigest,
        { scope: decision.scope, answer: decision.answer, decision_source: decision.decision_source },
        "invalid_review_rejection_override_scope",
        `审查拒绝裁决 scope 必须精确为 ${reviewRejectionOverrideScope(jobId)}`,
      );
    }
    if (decision.answer !== REVIEW_REJECTION_OVERRIDE_ANSWER) {
      return invalidReviewRejectionOverrideResult(
        projectRoot, change, inputDigest,
        { scope: decision.scope, answer: decision.answer, decision_source: decision.decision_source },
        "invalid_review_rejection_override_answer",
        `审查拒绝裁决 answer 必须是 ${REVIEW_REJECTION_OVERRIDE_ANSWER}`,
      );
    }
    if (decision.decision_source !== "main_process" && decision.decision_source !== "user") {
      return invalidReviewRejectionOverrideResult(
        projectRoot, change, inputDigest,
        { scope: decision.scope, answer: decision.answer, decision_source: decision.decision_source },
        "invalid_review_rejection_override_source",
        "审查拒绝裁决 decision_source 必须是 main_process 或 user",
      );
    }
    if (!nonEmptyString(decision.reason)) {
      return invalidReviewRejectionOverrideResult(
        projectRoot, change, inputDigest,
        { scope: decision.scope, answer: decision.answer, decision_source: decision.decision_source },
        "missing_review_rejection_override_reason",
        "审查拒绝裁决必须写明原因",
      );
    }
    const job = findJob(events, jobId);
    const gate = job ? ordinaryReviewGateForJob(job) : null;
    if (!job || !gate || !isOrdinaryReviewer(job.role)) {
      return invalidReviewRejectionOverrideResult(
        projectRoot, change, inputDigest,
        { scope: decision.scope, answer: decision.answer, decision_source: decision.decision_source },
        "review_rejection_override_job_not_found",
        "审查拒绝裁决必须指向当前 Explore / Propose gate 的普通 Reviewer job",
      );
    }
    const changeRoot = openspecChangeRoot(projectRoot, change);
    const snapshot = rebuildSnapshot(projectRoot, change, changeRoot);
    const gateIsCurrent = gate.gate_id === EXPLORE_DISCOVERY_REVIEW_GATE.gate_id
      ? snapshot.state === "explore"
      : snapshot.state === "propose" || snapshot.state === "propose_ready";
    if (!gateIsCurrent) {
      return invalidReviewRejectionOverrideResult(
        projectRoot, change, inputDigest,
        { scope: decision.scope, answer: decision.answer, decision_source: decision.decision_source },
        "review_rejection_override_gate_not_current",
        "审查拒绝裁决只能在对应 Explore / Propose gate 仍为当前阶段时登记",
      );
    }
    const resolution = reviewGateRoleResolution(events, changeRoot, gate, job.role);
    if (resolution.kind === "none" || resolution.terminal.job.job_id !== job.job_id) {
      return invalidReviewRejectionOverrideResult(
        projectRoot, change, inputDigest,
        { scope: decision.scope, answer: decision.answer, decision_source: decision.decision_source },
        "review_rejection_override_not_latest_terminal",
        "审查拒绝裁决只能指向当前 gate cycle 中该角色最新的 terminal job",
      );
    }
    if (resolution.kind === "stale") {
      return invalidReviewRejectionOverrideResult(
        projectRoot, change, inputDigest,
        { scope: decision.scope, answer: decision.answer, decision_source: decision.decision_source },
        "stale_review_rejection_override_job",
        `审查拒绝裁决指向的 job 已过期：${resolution.stale_reason}`,
      );
    }
    if (resolution.kind === "accepted") {
      return invalidReviewRejectionOverrideResult(
        projectRoot, change, inputDigest,
        { scope: decision.scope, answer: decision.answer, decision_source: decision.decision_source },
        "review_rejection_override_job_not_rejected",
        "审查拒绝裁决只能指向 rejected job",
      );
    }
    if (resolution.kind === "rejected_invalid") {
      return invalidReviewRejectionOverrideResult(
        projectRoot, change, inputDigest,
        { scope: decision.scope, answer: decision.answer, decision_source: decision.decision_source },
        "review_rejection_override_not_review_failed",
        "只有 result_kind=review_failed 的拒绝报告可以裁决；无效报告必须修正后重新提交",
      );
    }
    reviewRejectionOverride = {
      job_id: job.job_id,
      role: job.role,
      gate_id: gate.gate_id,
      packet_digest: job.packet_digest,
    };
    reviewRejectionDecisionSource = decision.decision_source;
  }

  let codeReviewDecisionReference: {
    job_id: string;
    finding_id: string;
    rejection_event_id: string;
    rejection_event_digest: string;
    packet_digest: string;
  } | null = null;
  if (decision.scope.startsWith(CODE_REVIEW_DECISION_SCOPE_PREFIX)) {
    const normalizedAnswer = normalizeCodeReviewDecisionAnswer(decision.answer);
    if (!normalizedAnswer) {
      return invalidCodeReviewDecisionResult(
        projectRoot,
        change,
        inputDigest,
        existing,
        { scope: decision.scope, answer: decision.answer },
        "invalid_code_review_decision_answer",
        `代码审查决策必须是 ${CODE_REVIEW_DECISION_ANSWER_LABELS.reopen_propose}、${CODE_REVIEW_DECISION_ANSWER_LABELS.reopen_apply} 或 ${CODE_REVIEW_DECISION_ANSWER_LABELS.dismiss}`,
      );
    }
    if (!nonEmptyString(decision.reason)) {
      return invalidCodeReviewDecisionResult(
        projectRoot,
        change,
        inputDigest,
        existing,
        { scope: decision.scope, answer: decision.answer },
        "missing_reason",
        "代码审查决策必须写明原因",
      );
    }

    const ref = parseCodeReviewDecisionScope(decision.scope);
    const changeRoot = openspecChangeRoot(projectRoot, change);
    const snapshot = rebuildSnapshot(projectRoot, change, changeRoot);
    const status = latestCodeReviewFailedStatus(events);
    const finding = ref && status?.terminal.job.job_id === ref.jobId
      ? status.findings.find(item => item.id === ref.findingId && (item.type === "spec" || item.type === "mixed"))
      : null;
    const staleReason = status && ref && status.terminal.job.job_id === ref.jobId
      ? codeReviewJobStaleReason(projectRoot, status.terminal.job, currentCodeReviewWorkingPaths(projectRoot, events), events)
      : null;
    if (!ref || snapshot.state !== "apply_done" || !status || !finding || staleReason) {
      const reason = !ref
        ? "invalid_code_review_decision_scope"
        : snapshot.state !== "apply_done"
          ? "code_review_decision_not_current"
          : staleReason
            ? "stale_code_review_decision_target"
            : "code_review_decision_target_not_found";
      const message = staleReason
        ? "代码审查材料已不再匹配当前代码，请先重新执行 review-ready 获取新的审查结论"
        : "代码审查决策只能关联当前代码审查报告中的待决定问题，请先执行 next 获取当前选择";
      return invalidCodeReviewDecisionResult(
        projectRoot,
        change,
        inputDigest,
        existing,
        { scope: decision.scope, answer: decision.answer },
        reason,
        message,
      );
    }
    codeReviewDecisionReference = {
      job_id: status.terminal.job.job_id,
      finding_id: finding.id,
      rejection_event_id: status.terminal.event.event_id,
      rejection_event_digest: status.terminal.event.event_digest,
      packet_digest: status.terminal.job.packet_digest,
    };
  }

  const normalizedAnswer = decision.scope.startsWith(CODE_REVIEW_DECISION_SCOPE_PREFIX)
    ? normalizeCodeReviewDecisionAnswer(decision.answer)
    : null;
  const normalizedDecision = {
    scope: decision.scope,
    question: phaseConfirmation
      ? phaseConfirmation.ask.question
      : exploreOpenQuestion
        ? discoveryOpenQuestionDisplayText(exploreOpenQuestion)
        : proposeOpenQuestion
          ? proposeOpenQuestionDisplayText(proposeOpenQuestion)
        : typeof decision.question === "string" ? decision.question : "",
    answer: phaseAction
      ? phaseAction.label
      : normalizedAnswer ? codeReviewDecisionAnswerLabel(normalizedAnswer) : decision.answer,
    ...(typeof decision.reason === "string" ? { reason: decision.reason.trim() } : {}),
    ...(reviewRejectionDecisionSource ? { decision_source: reviewRejectionDecisionSource } : {}),
    ...(reviewRejectionOverride ? { review_rejection_override: reviewRejectionOverride } : {}),
    ...(codeReviewDecisionReference ? { code_review_decision: codeReviewDecisionReference } : {}),
    ...(exploreOpenQuestion && exploreOpenQuestionRoundId && exploreOpenQuestionContextFingerprint && exploreOpenQuestionBasisDigest ? {
      explore_open_question: {
        round_id: exploreOpenQuestionRoundId,
        question_id: exploreOpenQuestion.id,
        question_ordinal: exploreOpenQuestion.ordinal,
        document_fingerprint: exploreOpenQuestion.documentFingerprint,
        context_fingerprint: exploreOpenQuestionContextFingerprint,
        decision_basis_digest: exploreOpenQuestionBasisDigest,
      },
    } : {}),
    ...(proposeOpenQuestion && proposeOpenQuestionRoundId && proposeOpenQuestionContextFingerprint && proposeOpenQuestionBasisDigest ? {
      propose_open_question: {
        round_id: proposeOpenQuestionRoundId,
        path: proposeOpenQuestion.path,
        question_id: proposeOpenQuestion.id,
        question_ordinal: proposeOpenQuestion.ordinal,
        document_fingerprint: proposeOpenQuestion.documentFingerprint,
        context_fingerprint: proposeOpenQuestionContextFingerprint,
        decision_basis_digest: proposeOpenQuestionBasisDigest,
      },
    } : {}),
    ...(phaseAction ? {
      phase_confirmation: {
        boundary: phaseAction.boundary,
        decision: phaseAction.decision,
        review_risk: phaseReviewRisk ?? "strict",
      },
    } : {}),
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
    message: exploreOpenQuestion
      ? "这件事的答复已登记"
      : `用户决策已登记：决策范围（scope）=${decision.scope}`,
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

    let content: string;
    try {
      content = readRecordInputFile(inputFile);
    } catch (err) {
      if (err instanceof RecordInputDecodingError) {
        return { accepted: false, message: err.message, events_written: 0 };
      }
      throw err;
    }
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

/** jobs list（job 从 transition_commit.new_jobs 提取；reopen 可用 job_invalidated 关闭未完成工作项） */
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
    } else if (ev.event_type === "job_invalidated") {
      const { job_id } = ev.payload as { job_id: string };
      const idx = open.findIndex(j => j.job_id === job_id);
      if (idx >= 0) open.splice(idx, 1);
    }
  }

  return { open, accepted, rejected };
}

function packetFieldDescriptions(): Record<string, string> {
  return {
    job_id: "工作项 ID，用于提交本次审查或验证报告。",
    packet_digest: "工作项说明摘要，用于证明报告对应的是当前这份工作项说明。",
    boundFiles: "本工作项绑定的文件清单；审查报告必须说明这些文件是否都看过。",
    review_scope: "报告中的审查覆盖范围；普通 reviewer/verifier 用 checked_paths 回执全部绑定文件，code-reviewer 还需按专用协议说明未检查项。",
    code_review_scope: "代码审查范围：从已审基点到当前 HEAD 的提交改动、工作区改动和未跟踪代码文件。",
    task_execution_index: "按任务汇总的执行证据：每个任务（task）的执行依据、有效证据要求、声明测试、测试证据和改动文件。",
    contract: "任务启动时的执行依据快照：tests/design/source/acceptance/guard 分别对应 测试/设计/来源/验收/边界；null 表示历史任务没有执行依据。",
    required_evidence: "task-start 结合冻结策略编译并写入 attempt 的有效证据要求：test_ids、red_required、green_required 和允许的 GREEN 语义状态；null 表示历史任务按旧记录回放。",
    changed_paths: "与某个任务（task）或代码状态检查相关的改动文件。",
    changed_paths_partial_reason: "该任务（task）的提交段 diff 失败原因；存在时 changed_paths 只包含工作区对比结果，归属可能不完整。",
    unattributed_paths: "代码审查范围中暂时无法归属到某个任务（task）的文件。",
    unknown_attribution_tasks: "因为缺少边界快照或提交段 diff 失败而无法完整计算改动归属的任务（task）。",
    coverage_exemption_refs: "测试覆盖豁免引用：说明某个 TEST 为什么没有绑定到任务（task）。",
    code_review_gate: "最终验证读取的代码审查门禁事实：passed 指向已接受的代码审查工作项，skipped 表示本轮没有代码类改动。",
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
  const isReviewer = isReviewRole(job.role);
  const hasReviewScope = requiresReviewScope(job);
  const packetContext = job.packet_context;
  const { reviewTargets, readOnlyRefs } = reviewScopeForJob(job);
  return {
    found: true,
      packet: {
        job_id: job.job_id,
        role: job.role,
        ...(job.gate_id ? { gate_id: job.gate_id } : {}),
        recommended_agent: recommendedAgentForRole(job.role),
        boundFiles: job.boundFiles,
        ...(isReviewer && reviewTargets.length > 0 ? { review_targets: reviewTargets } : {}),
        ...(isReviewer && readOnlyRefs.length > 0 ? { read_only_refs: readOnlyRefs } : {}),
        ...(job.review_evidence_digest ? { review_evidence_digest: job.review_evidence_digest } : {}),
        ...(job.previous_rejection ? { previous_rejection: job.previous_rejection } : {}),
        ...(packetContext ? { packet_context: packetContext } : {}),
        ...(packetContext?.code_review_scope ? { code_review_scope: packetContext.code_review_scope } : {}),
        ...(packetContext?.code_review_gate ? { code_review_gate: packetContext.code_review_gate } : {}),
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
          : [
              ...REVIEW_REPORT_REQUIRED_FIELDS,
              ...(requiresReviewer(job.role) ? ["reviewer"] : []),
              ...(hasReviewScope ? ["review_scope"] : []),
            ],
        output_contract_optional_fields: [...REVIEW_REPORT_OPTIONAL_FIELDS],
        字段说明: packetFieldDescriptions(),
        output_instructions:
          `${roleDescription(job.role)}。` +
          (isReviewer ? reviewScopeInstruction(job, reviewTargets, readOnlyRefs) : "") +
          (isReviewer ? migrationEvidenceInstruction(job) : "") +
          (job.review_evidence_digest ? `本工作项对应的执行证据版本为 ${job.review_evidence_digest}，` : "") +
          (isReviewer ? genericReviewCoverageInstruction(job) + proposalIncrementalReviewInstruction(job) + previousRejectionInstruction(job) : "") +
          (requiresReviewer(job.role) ? `必须由独立 ${recommendedAgentForRole(job.role)} 审查角色执行，并在审查者来源字段（reviewer.kind/id）中记录来源，` : "") +
          `产出 JSON 报告内容并优先通过 --report - 从 stdin 登记；文件路径模式仅作备用。${recordInputInstruction(job)}协议字段含义见 packet 顶层“字段说明”，普通对话不要原样复述 JSON。` +
          (isCodeReviewer
            ? `格式骨架：{"role":"code-reviewer","verdict":"pass","review_scope":{"job_id":"${job.job_id}","packet_digest":"${job.packet_digest}","checked_paths":[],"checked_docs":[],"unchecked":[]},"findings":[],"reviewer":{"kind":"codex-subagent","id":"<thread-or-agent-id>"}}。提交前按真实审查结果填写数组；不得从 boundFiles 自动复制 checked_paths。verdict 只能为 pass 或 fail；审查覆盖范围（review_scope）用来说明本次审查覆盖了哪些文件和文档，已检查路径（checked_paths）与未检查项（unchecked）必须合起来覆盖全部绑定文件（boundFiles），unchecked 条目格式为 {"path":"<path>","reason":"<reason>"}；pass 不允许仍有未检查的绑定文件。`
              + `报告结论为 fail 时，问题列表（findings）至少包含一个可处理、可追溯的阻塞问题，字段为 {"id":"<stable-id>","blocking":true,"type":"implementation|spec|mixed","description":"<what>","evidence":"<why>","source_refs":["<path:line>"],"impact":"<impact>","suggested_action":"apply|propose"}。问题类型（type）中 implementation 表示纯代码实现问题，spec 表示方案/需求文档问题，mixed 表示需要使用者判断的混合问题。`
              + (packetContext?.task_execution_index
                ? `本工作项带任务执行索引（task_execution_index）：按 task 对照其执行依据快照（contract）审查——实现路线对照 design 引用原文、累计 diff 对照 guard 边界、测试断言对照 tests 声明的 scenario；每项的 required_evidence 是 task-start 冻结的证据口径，red_required/green_required 分别说明是否需要 RED/GREEN；fix 非空表示状态机创建的实现修复，source、parent_task_id 和 reason 说明其归属，code_review 来源还需核对 review_finding；每项的 scope_note 是执行者登记的范围扩大说明，判断其合理性与验证充分性；changed_paths 是归属线索不是结论（null 表示未知）；unattributed_paths 中的无主改动逐个判断合理性；coverage_exemption_refs 解释未绑定 task 的 TEST 豁免。`
                : "")
            : job.role === "verifier"
            ? `最小格式：{"role":"verifier","verdict":"pass","findings":[]${hasReviewScope ? `,"review_scope":{"checked_paths":${JSON.stringify(job.boundFiles.map(file => file.path))}}` : ""}}。verdict 只能为 pass 或 fail；核对代码审查记录（code_review_gate）：passed 必须能追溯到已接受的代码审查工作项，skipped 必须能证明本次没有代码类改动。核对修复闭环：task_execution_index.fix.source=code_review 时必须核对 review_finding 对应问题是否关闭；source=self_test 时必须核对 parent_task_id、记录的自测原因、本次 attempt 验证和最新代码审查是否共同闭环。方案/混合问题必须有用户决策或后续修复证据。按 task_execution_index 的 required_evidence 核对测试证据：red_required 时需要同一 TEST 的 RED（expected_failure）后 GREEN；green_required 时每个声明 TEST 都需要允许的 GREEN 语义状态；测试运行证据应包含测试 ID（test_id）、命令（command）、工作目录（cwd）、退出码（exit_code）、语义状态（semantic_status）。修复 task 的回归测试运行可用回归覆盖任务列表（covers_task_ids）说明覆盖了哪些已完成任务；缺少任务尝试 ID（attempt_id）的旧证据只能弱引用。` +
              (packetContext?.code_state_check
                ? `本工作项带代码状态检查（code_state_check），它是创建 packet 时的快照：验证期间若代码状态已变化，不要提交该报告；主流程会通过 next 创建携带最新事实的验证工作项。`
                : "")
            : isReviewer
            ? `最小格式：{"role":"${job.role}","verdict":"pass","findings":[]${hasReviewScope ? `,"review_scope":{"checked_paths":${JSON.stringify(job.boundFiles.map(file => file.path))}}` : ""},"reviewer":{"kind":"codex-subagent","id":"<thread-or-agent-id>"}}。verdict 只能为 pass 或 fail。`
            : `最小格式：{"role":"${job.role}","verdict":"pass","findings":[]}。verdict 只能为 pass 或 fail。`),
        stop_conditions: isReviewer
          ? ["完成审查后提交报告，不要修改文档"]
          : job.role === "executor"
          ? ["完成绑定范围内的实现后提交执行报告，不要修改未绑定范围"]
          : ["完成指定验证后提交测试报告，不要修改项目文档"],
        created_from_transition: job.created_from_transition,
      },
    message: `工作项 ${jobId} 的执行说明`,
  };
}
