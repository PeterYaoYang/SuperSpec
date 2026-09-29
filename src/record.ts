// SuperSpec 流程引擎 — record：工作项结果登记

import { existsSync, readFileSync } from "node:fs";
import { isAbsolute, join, relative, resolve } from "node:path";
import {
  ensureChangeLayout, readEvents, appendEvent, makeEvent,
  sha256File, sha256Text, withLock, appendRawRecord, type RawRecordRef,
} from "./store.ts";
import { rebuildSnapshot } from "./sync.ts";
import { CHANGE_MATERIAL_RELATIVE_PATHS, changeMaterialProjectPath, changeRoot as openspecChangeRoot } from "./openspec.ts";
import { currentPlanSize, currentPlanSizeBudgetScope, PLAN_SIZE_BUDGET_ANSWERS, PLAN_SIZE_BUDGET_SCOPE_PREFIX } from "./phase_plan.ts";
import { latestWorkflowModeSelection, workflowModeSelectionError, workflowModeUpgradePending } from "./workflow_config.ts";
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
  codeReviewFindingNeedsUserDecision,
  codeReviewJobStaleReason,
  codeReviewDecisionAnswerLabel,
  currentCodeReviewWorkingPaths,
  isReviewFixCapReached,
  latestCodeReviewFailedStatus,
  normalizeCodeReviewDecisionAnswer,
  parseCodeReviewDecisionScope,
} from "./code_review.ts";
import { invalidReasonForSubmittedReport } from "./job_validity.ts";
import { jobPacketCommand, jobSubmitArgv } from "./job_action.ts";
import { isCodeLikePath } from "./git_state.ts";
import { workflowRolePrompt, type WorkflowRole } from "./install.ts";
import {
  hasBehaviorAnchor,
  isCodeReviewClaimKind,
  resolveApprovedRefs,
} from "./approved_ref.ts";
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
import { materialDelta } from "./material_snapshot.ts";
import { confirmedDecisions, evidenceCodeFiles, previousReviewEvidence } from "./review_context.ts";
import { RecordInputDecodingError, readRecordInputFile } from "./record_input.ts";
import { currentExploreRoundId, exploreQuestionAnswerHistory } from "./explore_round.ts";
import {
  currentProposeOpenQuestion,
  currentProposeQuestionContent,
  currentProposeRoundId,
  proposeQuestionAnswerHistory,
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
  openQuestionDecisionClosure,
  PROPOSE_OPEN_QUESTION_SCOPE_PREFIX,
  validateDiscovery,
  type DiscoveryOpenQuestion,
  type OpenQuestionAnswerRecord,
  type OpenQuestionClosure,
  type ProposeQuestion,
} from "./format.ts";
import type { CodeReviewResultKind, Event, RecordResult, Job, JobPacket, JobRole, JobState, JobSubmitResultKind, State, WorkflowModeSelection } from "./types.ts";
import {
  COVERAGE_MESSAGES,
  REVIEWER_KINDS,
  outOfScopeUncheckedFromReport,
  REVIEW_REPORT_OPTIONAL_FIELDS,
  REVIEW_REPORT_REQUIRED_FIELDS,
  hasEvidenceRef,
  isReviewRole,
  requiresReviewer,
  requiresReviewScope,
  reportSchemaForJob,
  reportSkeletonFillItems,
  reportSkeletonForJob,
  reportedPathAliases,
  requiredCheckedBoundPaths,
  type ReportSchemaContract,
} from "./report_contract.ts";

const CODE_REVIEW_FINDING_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._:-]*$/;

function projectLocalInvalidReportMustTerminate(job: Job): boolean {
  return job.role === "code-reviewer" || job.packet_context?.code_state_check !== undefined;
}

/** 只有会被代码范围扫描当成改动的报告文件才必须终结工作项；report_file_path 等非代码路径可修正重交。 */
function invalidReportFileMustTerminate(job: Job, reportPath: string | null): reportPath is string {
  return projectLocalInvalidReportMustTerminate(job) && reportPath !== null && isCodeLikePath(reportPath);
}

function isOrdinaryReviewer(role: JobRole): boolean {
  return role === "critic" || role === "architect" || role === "test-engineer";
}

function recommendedAgentForRole(role: JobRole): WorkflowRole {
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
      return "独立审查实现是否以最小语义影响兑现已批准计划，找出真实缺陷、边界条件、安全/性能/兼容问题与关键测试缺口，并区分漏做与计划或验收没有要求的改动";
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
  const incremental = Boolean(job.review_baseline);
  if (!previous.findings || previous.findings.length === 0) {
    return incremental
      ? `${reason}上一轮没有可复核的历史 finding；不要把拒绝原因当作需求或验收标准，`
      : `${reason}上一轮没有可复核的历史 finding；请按当前 gate 的完整范围独立审查，不要把拒绝原因当作需求或验收标准，`;
  }
  const identityRule = job.role === "code-reviewer"
    ? "逐项核对修复 task 的代码变化、scope_note 和验证证据；实现者用可核实证据说明被质疑实现确有必要时，独立验证后关闭原问题。证据不能支撑必要性且问题仍存在时复用原 finding ID；legacy finding 没有 ID 时沿用原始语义并补一个稳定 ID；同一批准行为的直接消费者若因本次修正暴露出新的遗漏，可以提出新的稳定 finding，但必须给出修正变化或直接消费者链路的因果证据；"
    : "已解决或已由等价证据闭环的问题不要重复报告，不得通过更换标题或措辞重复同一问题；";
  const findingScope = incremental
    ? "先覆盖 material_delta 的全部变化及其与未变化材料的一致性，再逐项核对历史 finding，所在内容没有变化的 finding 同样要判断是否仍成立；不得把 delta 里与旧 finding 无关的变化排除出审查。新 blocker 必须能说明与本次材料变化或同一批准行为的因果链。"
    : "默认围绕历史 finding 及其直接影响链路复核；新 blocker 必须能说明“本次修正或同一批准行为 → 当前问题”的因果链，不得展开无关的故障模型、消费者或架构议题。";
  return `${reason}本轮是修复复核：逐项判断本工作项附带的上一次同角色 finding 是否仍成立。Finding 中的 recommendation 只是非绑定建议，不是需求或验收标准；先独立核对 underlying problem、直接证据和本次验收，不得因原建议指定了某种架构就要求照做。修正不得通过缩小已确认范围、改写用户决定或删除验收来让 finding 字面消失；这类偏离属于本次修正直接引入的回归。${identityRule}${findingScope}`;
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

function reviewScopeInstruction(
  job: Job,
  reviewTargets: string[],
  readOnlyRefs: string[],
  projectPath: (path: string) => string,
): string {
  if (reviewTargets.length === 0 && readOnlyRefs.length === 0) {
    return `请审查 ${job.boundFiles.map(file => projectPath(file.path)).join(", ")}，`;
  }
  const targets = reviewTargets.length > 0 ? `本 gate 可提出修改建议的审查目标为 ${reviewTargets.map(projectPath).join(", ")}。` : "";
  const refs = readOnlyRefs.length > 0
    ? `只读上游引用为 ${readOnlyRefs.map(projectPath).join(", ")}；只允许读取和核对一致性，不得要求在当前阶段修改、追加、删除、重排或格式化这些文件。只读引用中与本次目标或绑定上游事实无直接因果关系的历史质量问题不得作为本 gate 的 fail。如果本次审查目标或 boundFiles 中绑定的上游事实直接造成变更包跨文档不一致，并且会影响明确验收或实施落地，可以 fail；finding 必须锚定为当前变更包未完成一致性闭环，required outcome 只要求消除矛盾，不得指定必须修改哪份文档或采用哪种技术方案。`
    : "";
  return targets + refs;
}

const REVIEWER_SELF_SUBMISSION_INSTRUCTION = "完成审查后由你自己运行 submission_command，经 stdin 登记 JSON 报告；宿主只放行单条 superspec 命令（不允许 heredoc、管道、重定向或 cd 前缀）时，改用 inline_submission_command，把报告压成单行 JSON 放进单引号参数，JSON 字符串中的单引号写成 \\u0027。登记前绑定材料或代码一旦变化，报告就会作废，登记后本工作项即结束。登记结果以返回的 result_kind 为准；两种方式都无法运行时，把完整报告 JSON 原样交回主流程，由主流程加 --on-behalf 代为登记。";
const PREVIOUS_REVIEW_EVIDENCE_INSTRUCTION = "previous_review_evidence 是上一轮同角色审查记录的证据与结论：code_files 中 unchanged 为 true 的代码文件自那次核实后内容未变，除非本轮材料变化直接涉及，可以沿用其核实结论而不必重新逐行核对；unchanged 为 false 或未列出的文件需要重新核实。";
const CONFIRMED_DECISIONS_INSTRUCTION = "confirmed_decisions 是已登记的用户答复原文，核对材料中的已确认结论时以它为准，不必再到事件日志中查找。";
const PLAN_REVIEW_PASS_FINDINGS_INSTRUCTION = "verdict=pass 表示当前材料可以进入下一步，随 pass 报告列出的 finding 与 risks 是不阻塞推进的遗留意见，不要写成进入下一步前必须完成的修改；认为不修改就不能推进的问题按 blocker 判 fail。";

function genericReviewCoverageInstruction(job: Job): string {
  if (!requiresReviewScope(job)) return "";
  if (job.review_baseline) {
    const failedBaseline = job.review_baseline.result_kind === "review_failed";
    const baselineFact = failedBaseline
      ? `本工作项是同角色审查以 fail 被拒后的复审：${job.review_baseline.job_id} 已完整审查 material_delta 之外的材料内容，它提出的 finding 见 previous_rejection。`
      : `本工作项是同角色审查通过后的复审：${job.review_baseline.job_id} 已审查通过 material_delta 之外的材料内容。`;
    return `${baselineFact}审查 material_delta 中的全部变化，以及这些变化与未变化材料之间的一致性和对已批准结论的影响，不因发现第一个 blocker 停止；未变化的绑定文件只在核对这种一致性${failedBaseline ? "或历史 finding" : ""}时读取，可以不列入 checked_paths；diff_unavailable 或新增的文件需要完整阅读。read_only_refs 只在核对本次问题与上下游一致性时读取。review_scope.checked_paths 只填写本次实际浏览并完成语义审查的绑定文件，覆盖回执不能代替语义审查，也不扩大可报告问题的范围。`;
  }
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
  return `${encoding}report_file_path 之外的项目内报告文件会被代码状态检查当作改动，若存在解码或协议错误会终结当前工作项；需要落盘时使用 report_file_path，可修正后以同一工作项重交。`;
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
        ? `这件事已有已登记答复，请先回写 ${changeMaterialProjectPath(openspecChangeRoot(projectRoot, change), CHANGE_MATERIAL_RELATIVE_PATHS.discovery)} 后重新执行 next`
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

/** 每条 finding（含非阻塞）都要带问题描述：只剩编号的 finding 登记后无人能处理，等于丢失审查发现。 */
function findingDescriptionChecks(findings: unknown[]): string[] {
  const checks: string[] = [];
  findings.forEach((raw, index) => {
    const finding = asObject(raw);
    const label = finding && nonEmptyString(finding.id) ? `问题 ${finding.id}` : `第 ${index + 1} 个问题`;
    if (!finding) {
      checks.push(`${label} 必须是对象`);
    } else if (!nonEmptyString(finding.description)) {
      checks.push(`${label} 缺少 description：用一句话写清问题本身，非阻塞问题同样需要`);
    }
  });
  return checks;
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
      checks.push(COVERAGE_MESSAGES.uncheckedItemNotObject);
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
    if (typeof reviewer.kind !== "string" || !(REVIEWER_KINDS as readonly string[]).includes(reviewer.kind)) {
      checks.push(`报告 reviewer.kind 必须是 ${REVIEWER_KINDS.join("|")} 之一`);
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
  changePrefix: string,
): void {
  const scope = asObject(obj.review_scope);
  if (!scope) {
    checks.push(COVERAGE_MESSAGES.codeReviewScopeMissing);
    return;
  }
  if (scope.job_id !== job.job_id) {
    checks.push(`代码审查覆盖范围里的 job_id ${String(scope.job_id)} 与工作项 ${job.job_id} 不匹配`);
  }
  if (scope.packet_digest !== job.packet_digest) {
    checks.push("代码审查覆盖范围里的 packet_digest 与工作项不匹配，请使用当前工作项说明重新生成报告");
  }
  if (!stringArray(scope.checked_paths)) checks.push(COVERAGE_MESSAGES.checkedPathsNotStringArray);
  if (!stringArray(scope.checked_docs)) checks.push(COVERAGE_MESSAGES.checkedDocsNotStringArray);
  if (!Array.isArray(scope.unchecked)) checks.push(COVERAGE_MESSAGES.uncheckedNotArray);
  if (stringArray(scope.checked_paths) && Array.isArray(scope.unchecked)) {
    const checkedPaths = reportedPathAliases(scope.checked_paths, changePrefix);
    const uncheckedPaths = reportedPathAliases(uncheckedCodeReviewPaths(scope.unchecked, checks), changePrefix);
    for (const bound of job.boundFiles) {
      if (!checkedPaths.has(bound.path) && !uncheckedPaths.has(bound.path)) {
        checks.push(`代码审查报告未说明是否检查了 ${bound.path}`);
      }
    }
    // 只有绑定文件被列为未检查时才阻塞 pass：范围外观察（未跑构建、无关文件）写进
    // unchecked 是诚实记录，不应让 pass 结论无法提交。
    if (obj.verdict === "pass" && job.boundFiles.some(bound => uncheckedPaths.has(bound.path))) {
      checks.push(COVERAGE_MESSAGES.passWithUncheckedBoundFile);
    }
  }
}

function validateReviewScope(
  obj: Record<string, unknown>,
  job: Job,
  checks: string[],
  changePrefix: string,
): void {
  const scope = asObject(obj.review_scope);
  if (!scope) {
    checks.push(COVERAGE_MESSAGES.reviewScopeMissing);
    return;
  }
  if (!stringArray(scope.checked_paths)) {
    checks.push(COVERAGE_MESSAGES.reviewCheckedPathsNotStringArray);
    return;
  }
  const checkedPaths = reportedPathAliases(scope.checked_paths, changePrefix);
  for (const path of requiredCheckedBoundPaths(job)) {
    if (!checkedPaths.has(path)) {
      checks.push(`审查报告未说明已检查 ${path}`);
    }
  }
}

function actionableCodeReviewFindings(
  findings: unknown,
  changeRoot: string,
): { actionable: Record<string, unknown>[]; reasons: string[] } {
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
    if (!isCodeReviewClaimKind(finding.claim_kind)) {
      findingReasons.push(`阻塞问题 ${id} 的 claim_kind 必须是 missing_approved|breaks_existing|unjustified_addition`);
    }
    const resolved = resolveApprovedRefs(changeRoot, finding.approved_refs);
    if (!resolved.ok) {
      findingReasons.push(...resolved.reasons.map((reason: string) => `阻塞问题 ${id} ${reason}`));
    } else if (
      finding.claim_kind === "missing_approved"
      && finding.suggested_action === "apply"
      && !hasBehaviorAnchor(resolved.values)
    ) {
      findingReasons.push(`阻塞问题 ${id} 的 missing_approved 在 suggested_action=apply 时必须引用可解析的 TEST 或 spec Requirement；若缺口属于计划或验收本身的问题，改用 type=mixed 且 suggested_action=propose 交使用者裁决`);
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

/** 计划材料审查报告引用的代码文件在提交时的内容指纹，供下一轮判断已核实证据是否仍然成立。 */
function ordinaryReviewEvidencePayload(projectRoot: string, job: Job, parsedReport: Record<string, unknown>): Record<string, unknown> {
  if (!isOrdinaryReviewer(job.role)) return {};
  const files = evidenceCodeFiles(projectRoot, parsedReport);
  return files.length > 0 ? { evidence_code_files: files } : {};
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

function invalidatedJobMessage(events: Event[], jobId: string): string | null {
  const event = events.findLast(ev =>
    ev.event_type === "job_invalidated" &&
    (ev.payload as { job_id?: unknown }).job_id === jobId
  );
  if (!event) return null;
  const payload = event.payload as { reason?: unknown; superseded_by?: unknown };
  if (Array.isArray(payload.superseded_by) && payload.superseded_by.length > 0) {
    return `工作项 ${jobId} 已作废（${String(payload.reason ?? "绑定事实已变化")}），已由 ${payload.superseded_by.join(", ")} 取代，不接受新报告；请停止本次审查。`;
  }
  return `工作项 ${jobId} 已因回退到更早阶段失效，不接受新报告。`;
}

export interface JobSubmitOptions {
  /** 主流程代为登记（人工或外部审查来源，或审查角色无法执行登记命令）；写入事件留痕。 */
  onBehalf?: boolean;
}

function submitterPayload(options: JobSubmitOptions): Record<string, unknown> {
  return options.onBehalf ? { submitted_by: "main_process" } : {};
}

/** 结论已登记为工作项结果（含 fail）；登记命令据此返回成功，避免调用方把已登记的 fail 当成登记失败而重交。 */
export function jobSubmitConclusionRecorded(result: RecordResult): boolean {
  return result.result_kind === "accepted" || result.result_kind === "review_failed" || result.result_kind === "non_actionable_report";
}

function rejectedResultKind(value: unknown): JobSubmitResultKind {
  return value === "review_failed" || value === "non_actionable_report" ? value : "invalid_report";
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
      events_written: 0,
      result_kind: existing.event_type === "job_accepted"
        ? "accepted"
        : rejectedResultKind((existing.payload as { result_kind?: unknown }).result_kind),
    };
  }
  return {
    event_type: "job_rejected",
    accepted: false,
    message: `工作项 ${jobId} 已结束（${terminal}），不接受新报告。需要新工作项请重新执行对应的 transition。`,
    events_written: 0,
    result_kind: "job_closed",
  };
}

function retryableJobSubmitResult(jobId: string, checks: string[]): RecordResult {
  return {
    accepted: false,
    message: `工作项 ${jobId} 的报告未接受，可修正后以同一工作项重新提交：${checks.join("; ")}`,
    job_state: "requested",
    events_written: 0,
    result_kind: "retryable",
  };
}

/** 过期报告的 fail 结论仍是对上一版本材料的审查，保留问题供下一轮复核；代码审查问题由 review-fix 闭环，不经这里。 */
function staleReportFindings(job: Job, report: Record<string, unknown> | null): unknown[] | null {
  if (job.role === "code-reviewer" || report?.verdict !== "fail") return null;
  return Array.isArray(report.findings) && report.findings.length > 0 ? report.findings : null;
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
  staleFindings?: unknown[] | null;
  submitter: Record<string, unknown>;
}): RecordResult {
  const rawRef = input.parsedReport && (input.job.role === "code-reviewer" || input.staleFindings)
    ? appendRawRecord(input.projectRoot, input.change, "review-reports", input.parsedReport)
    : null;
  appendEvent(input.projectRoot, input.change, makeEvent(input.change, "job_rejected", {
    ...codeReviewRejectEventPayload({
      jobId: input.jobId,
      job: input.job,
      reportDigest: input.reportDigest,
      resultKind: "invalid_report",
      reason: input.reason,
      parsedReport: input.parsedReport,
      rawRef,
      reportPath: input.reportPath,
    }),
    ...(input.staleFindings
      ? {
        stale_report: true,
        findings: input.staleFindings,
        ...(typeof input.parsedReport?.summary === "string" ? { summary: input.parsedReport.summary } : {}),
      }
      : {}),
    ...input.submitter,
  }));
  return {
    event_type: "job_rejected",
    accepted: false,
    message: `工作项 ${input.jobId} 被拒绝：${input.reason}`,
    job_state: "rejected",
    result_kind: "invalid_report",
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
  reportFile: string | undefined,
  options: JobSubmitOptions,
): RecordResult {
  const checks: string[] = [];
  let parsedReport: Record<string, unknown> | null = null;
  const submitter = submitterPayload(options);
  const changePrefix = relative(projectRoot, changeRoot).replace(/\\/g, "/");

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
      } else {
        if ((isOrdinaryReviewer(job.role) || job.role === "verifier") && obj.verdict === "fail" && obj.findings.length === 0) {
          checks.push("审查报告结论为 fail 时 findings 至少包含一个问题");
        }
        if (isReviewRole(job.role)) checks.push(...findingDescriptionChecks(obj.findings));
      }
      if (requiresReviewer(job.role)) {
        validateReviewer(obj, checks);
      }
      if (isReviewRole(job.role) && obj.verdict === "pass" && !hasEvidenceRef(parsedReport.evidence_refs)) {
        checks.push(COVERAGE_MESSAGES.passWithoutEvidence);
      }
      if (job.role === "code-reviewer") {
        validateCodeReviewScope(parsedReport, job, checks, changePrefix);
      } else if (requiresReviewScope(job)) {
        validateReviewScope(parsedReport, job, checks, changePrefix);
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
      staleFindings: checks.length === 0 ? staleReportFindings(job, parsedReport) : null,
      submitter,
    });
  }

  // Code-state-sensitive review jobs must record project-local fallback paths for later scope scans.
  if (checks.length > 0 && invalidReportFileMustTerminate(job, reportPath)) {
    return terminalInvalidReportResult({
      projectRoot, change, jobId, job, reportDigest, reason: checks.join("; "), parsedReport, reportPath, submitter,
    });
  }
  if (checks.length > 0) return retryableJobSubmitResult(jobId, checks);

  if (job.role !== "code-reviewer" && parsedReport?.verdict === "fail") {
    const rawRef = appendRawRecord(projectRoot, change, "review-reports", parsedReport);
    const rejectEvent = makeEvent(change, "job_rejected", {
      ...failedReviewReportRejectEventPayload({
        jobId,
        job,
        reportDigest,
        parsedReport,
        rawRef,
      }),
      ...ordinaryReviewEvidencePayload(projectRoot, job, parsedReport),
      ...submitter,
    });
    if (reportPath) rejectEvent.payload.report_path = reportPath;
    appendEvent(projectRoot, change, rejectEvent);
    return {
      event_type: "job_rejected",
      accepted: false,
      message: `工作项 ${jobId} 被拒绝：报告结论为 fail，工作项未通过`,
      job_state: "rejected",
      result_kind: "review_failed",
    };
  }

  if (job.role === "code-reviewer" && parsedReport) {
    const verdict = parsedReport.verdict;
    const findings = parsedReport.findings;
    const blockingCount = Array.isArray(findings)
      ? findings.filter(item => asObject(item)?.blocking === true).length
      : 0;
    const { actionable, reasons } = actionableCodeReviewFindings(findings, changeRoot);

    if (verdict === "pass") {
      if (blockingCount > 0) {
        const reason = "报告结论为 pass 时不能包含 blocking:true 的阻塞问题";
        if (invalidReportFileMustTerminate(job, reportPath)) {
          return terminalInvalidReportResult({
            projectRoot, change, jobId, job, reportDigest, reason, parsedReport, reportPath, submitter,
          });
        }
        return retryableJobSubmitResult(jobId, [reason]);
      }
    } else if (verdict === "fail") {
      // 阻塞问题的字段或锚点写法不合格属于报告格式问题：留在同一工作项修正重交，
      // 终结工作项会让同一份报告里其余已写出的发现一起丢失。
      if (blockingCount > 0 && reasons.length > 0) {
        if (invalidReportFileMustTerminate(job, reportPath)) {
          return terminalInvalidReportResult({
            projectRoot, change, jobId, job, reportDigest, reason: reasons.join("; "), parsedReport, reportPath, submitter,
          });
        }
        return retryableJobSubmitResult(jobId, reasons);
      }
      const resultKind: CodeReviewResultKind = actionable.length > 0 ? "review_failed" : "non_actionable_report";
      const reason = actionable.length > 0
        ? `代码审查发现 ${actionable.length} 个需要处理的阻塞问题`
        : `代码审查报告没有给出可处理的阻塞问题${reasons.length > 0 ? `：${reasons.join("; ")}` : ""}`;
      const rawRef = appendRawRecord(projectRoot, change, "review-reports", parsedReport);
      appendEvent(projectRoot, change, makeEvent(change, "job_rejected", {
        ...codeReviewRejectEventPayload({
          jobId,
          job,
          reportDigest,
          resultKind,
          reason,
          parsedReport,
          rawRef,
          reportPath,
        }),
        ...submitter,
      }));
      return {
        event_type: "job_rejected",
        accepted: false,
        message: `工作项 ${jobId} 被拒绝：${reason}`,
        job_state: "rejected",
        result_kind: resultKind,
      };
    }
  }

  const rawRef = appendRawRecord(projectRoot, change, "review-reports", parsedReport);
  // pass 结论下的范围外未检查项不进门禁，但必须留在决策面：只翻 raw 才能看到
  // 会让「pass 但未跑构建 / 未覆盖范围外文件」这一事实在流程里消失。
  const outOfScopeUnchecked = job.role === "code-reviewer"
    ? outOfScopeUncheckedFromReport(parsedReport, job.boundFiles, changePrefix)
    : [];
  const acceptEvent = makeEvent(change, "job_accepted", {
    job_id: jobId,
    role: job.role,
    report_digest: reportDigest,
    accepted_at: new Date().toISOString(),
    ...(outOfScopeUnchecked.length > 0 ? { out_of_scope_unchecked: outOfScopeUnchecked } : {}),
    ...(reportPath ? { report_path: reportPath } : {}),
    ...(parsedReport && isOrdinaryReviewer(job.role)
      ? {
        ...(typeof parsedReport.summary === "string" ? { summary: parsedReport.summary } : {}),
        ...(Array.isArray(parsedReport.evidence_refs) ? { evidence_refs: parsedReport.evidence_refs } : {}),
        ...ordinaryReviewEvidencePayload(projectRoot, job, parsedReport),
      }
      : {}),
    ...rawRef,
    ...submitter,
  });
  appendEvent(projectRoot, change, acceptEvent);
  return {
    event_type: "job_accepted",
    accepted: true,
    message: `工作项 ${jobId}（${job.role}）已接受${misplacedReportFileNote(change, reportPath)}`,
    job_state: "accepted",
    result_kind: "accepted",
  };
}

/** 报告文件的推荐落盘位置：工作流记录目录，不进入计划材料。 */
export function jobReportFilePath(change: string, jobId: string): string {
  return `.superspec/changes/${change}/jobs/${jobId}.report.json`;
}

/** 报告内容已存入 raw 记录；文件若写在 openspec change 目录里会跟计划材料一起进版本库，提示清理。 */
function misplacedReportFileNote(change: string, reportPath: string | null): string {
  if (!reportPath) return "";
  const normalized = reportPath.replace(/\\/g, "/");
  if (!normalized.startsWith(`openspec/changes/${change}/`)) return "";
  return `；报告内容已存入工作流记录，${normalized} 位于计划材料目录，请删除该文件（落盘位置见 packet 的 report_file_path）`;
}

/** record job-submit：登记工作项结果 */
function unknownJobResult(jobId: string): RecordResult {
  return { event_type: "job_rejected", accepted: false, message: `工作项 ${jobId} 不存在`, events_written: 0, result_kind: "job_not_found" };
}

function invalidatedJobResult(message: string): RecordResult {
  return { accepted: false, message, events_written: 0, result_kind: "job_invalidated" };
}

export function recordJobSubmit(
  projectRoot: string,
  change: string,
  changeRoot: string,
  jobId: string,
  reportFile: string,
  options: JobSubmitOptions = {},
): RecordResult {
  return withLock(projectRoot, change, () => {
    ensureChangeLayout(projectRoot, change);
    const events = readEvents(projectRoot, change);

    const job = findJob(events, jobId);
    if (!job) return unknownJobResult(jobId);

    const invalidatedMessage = invalidatedJobMessage(events, jobId);
    if (invalidatedMessage) return invalidatedJobResult(invalidatedMessage);
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
        if (invalidReportFileMustTerminate(job, reportPath)) {
          return terminalInvalidReportResult({
            projectRoot, change, jobId, job, reportDigest, reason: err.message, parsedReport: null, reportPath,
            submitter: submitterPayload(options),
          });
        }
        return retryableJobSubmitResult(jobId, [err.message]);
      }
      throw err;
    }
    return recordJobSubmitLoaded(projectRoot, change, changeRoot, jobId, job, events, reportContent, reportDigest, reportFile, options);
  });
}

/** record job-submit：从 JSON 内容登记工作项结果 */
export function recordJobSubmitContent(
  projectRoot: string,
  change: string,
  changeRoot: string,
  jobId: string,
  reportContent: string,
  options: JobSubmitOptions = {},
): RecordResult {
  return withLock(projectRoot, change, () => {
    ensureChangeLayout(projectRoot, change);
    const events = readEvents(projectRoot, change);

    const job = findJob(events, jobId);
    if (!job) return unknownJobResult(jobId);

    const invalidatedMessage = invalidatedJobMessage(events, jobId);
    if (invalidatedMessage) return invalidatedJobResult(invalidatedMessage);
    const reportDigest = sha256Text(reportContent);
    const terminal = jobTerminalState(events, jobId);
    if (terminal) {
      return terminalJobSubmitResult(events, jobId, terminal, reportDigest);
    }

    return recordJobSubmitLoaded(projectRoot, change, changeRoot, jobId, job, events, reportContent, reportDigest, undefined, options);
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
    closure?: unknown;
    followup?: unknown;
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
  const closureRejection = decision.closure != null && decision.closure !== "closed" && decision.closure !== "needs_followup"
    ? { reason: "invalid_closure", message: "closure 只能是 closed 或 needs_followup" }
    : decision.closure === "needs_followup" && !isExploreOpenQuestionScope(decision.scope) && !isProposeOpenQuestionScope(decision.scope)
      ? { reason: "closure_not_supported", message: "只有 Explore / Propose 待确认问题的答复可以标记为 needs_followup" }
      : decision.closure === "needs_followup" && !nonEmptyString(decision.followup)
        ? { reason: "missing_followup", message: "标记为 needs_followup 时必须在 followup 中写明还需要用户补充什么" }
        : null;
  if (closureRejection) {
    appendEvent(projectRoot, change, makeEvent(change, "user_decision_recorded", {
      accepted: false,
      scope: decision.scope,
      answer: decision.answer,
      reason: closureRejection.reason,
      input_digest: inputDigest,
    }));
    return { event_type: "user_decision_recorded" as const, accepted: false, message: closureRejection.message };
  }
  // 计划规模确认按原文逐字消费：这里拒收不匹配的答复，避免“已登记”却不生效。
  const budgetRejection = decision.scope.startsWith(PLAN_SIZE_BUDGET_SCOPE_PREFIX)
    ? decision.scope !== currentPlanSizeBudgetScope(openspecChangeRoot(projectRoot, change), events)
      ? { reason: "stale_plan_size_budget_scope", message: "计划规模已变化或当前没有待确认的规模问题，请重新执行 next 获取当前问题" }
      : !PLAN_SIZE_BUDGET_ANSWERS.includes(decision.answer.trim())
        ? {
            reason: "invalid_plan_size_budget_answer",
            message: `计划规模确认的 answer 必须精确为：${PLAN_SIZE_BUDGET_ANSWERS.join("、")}；用户给出的理由写在 reason 字段`,
          }
        : null
    : null;
  if (budgetRejection) {
    const existingPayload = existing?.payload as { accepted?: unknown; reason?: unknown } | undefined;
    if (existingPayload?.accepted === false && existingPayload.reason === budgetRejection.reason) {
      return { event_type: "user_decision_recorded" as const, accepted: false, message: budgetRejection.message };
    }
    appendEvent(projectRoot, change, makeEvent(change, "user_decision_recorded", {
      accepted: false,
      scope: decision.scope,
      answer: decision.answer,
      reason: budgetRejection.reason,
      input_digest: inputDigest,
    }));
    return { event_type: "user_decision_recorded" as const, accepted: false, message: budgetRejection.message };
  }
  const closure: OpenQuestionClosure = decision.closure === "needs_followup" ? "needs_followup" : "closed";
  const followup = closure === "needs_followup" ? (decision.followup as string).trim() : null;
  const sameOpenQuestionAnswer = (latest: Event): boolean => {
    const payload = latest.payload as { answer?: unknown; followup?: unknown };
    return payload.answer === decision.answer &&
      openQuestionDecisionClosure(payload) === closure &&
      (closure === "closed" || payload.followup === followup);
  };
  let earlierAnswers: Array<{ answer: string; followup?: string; event_id: string }> = [];
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
    const latestForQuestion = latestAcceptedExploreOpenQuestionDecision(events, expectedScopes, {
      roundId: exploreRoundId,
      questionId: current!.id,
      questionOrdinal: current!.ordinal,
      decisionBasisDigest: currentBasisDigest,
    });
    if (latestForQuestion && sameOpenQuestionAnswer(latestForQuestion)) {
      return {
        event_type: "user_decision_recorded" as const,
        accepted: true,
        message: closure === "needs_followup"
          ? "幂等返回：该事项已登记为需要补充，本次输入没有改变登记内容"
          : `幂等返回：该事项的答复已登记，本次输入没有改变登记内容；答复绑定 ${changeMaterialProjectPath(openspecChangeRoot(projectRoot, change), CHANGE_MATERIAL_RELATIVE_PATHS.discovery)} 中该事项行的原文，回写时只把 [ ] 改为 [x]，结论写在该行之外`,
      };
    }
    if (latestForQuestion && openQuestionDecisionClosure(latestForQuestion.payload) === "closed") {
      return invalidExploreOpenQuestionResult(
        projectRoot,
        change,
        inputDigest,
        existing,
        { scope: decision.scope, answer: decision.answer },
        "explore_open_question_already_recorded",
      );
    }
    if (closure === "closed") {
      earlierAnswers = pendingFollowupAnswers(exploreQuestionAnswerHistory(events, exploreRoundId, current!));
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
    const latestForQuestion = latestAcceptedProposeOpenQuestionDecision(events, expectedScopes, {
      roundId: proposeRoundId,
      path: current!.path,
      questionId: current!.id,
      questionOrdinal: current!.ordinal,
      decisionBasisDigest: currentBasisDigest,
    });
    if (latestForQuestion && sameOpenQuestionAnswer(latestForQuestion)) {
      return {
        event_type: "user_decision_recorded",
        accepted: true,
        message: closure === "needs_followup"
          ? "幂等返回：该设计决定已登记为需要补充，本次输入没有改变登记内容"
          : "幂等返回：该设计决定的答复已登记，本次输入没有改变登记内容；答复绑定 design 中该问题行的原文，回写时只把 [ ] 改为 [x]，结论写在该行之外",
      };
    }
    if (latestForQuestion && openQuestionDecisionClosure(latestForQuestion.payload) === "closed") {
      return invalidProposeOpenQuestionResult(
        projectRoot,
        change,
        inputDigest,
        existing,
        { scope: decision.scope, answer: decision.answer },
        "propose_open_question_already_recorded",
      );
    }
    if (closure === "closed") {
      earlierAnswers = pendingFollowupAnswers(proposeQuestionAnswerHistory(events, proposeRoundId, current!));
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
  // 计划规模答复已按当前 scope 重新校验；同一输入此前因规模变化被拒、规模恢复后应能登记。
  const revalidatedBudgetInput = decision.scope.startsWith(PLAN_SIZE_BUDGET_SCOPE_PREFIX)
    && (existing?.payload as { accepted?: unknown } | undefined)?.accepted === false;
  if (existing && !phaseAction && !exploreOpenQuestion && !revalidatedBudgetInput) {
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
    const reviewFixCapReached = isReviewFixCapReached(projectRoot, events);
    const finding = ref && status?.terminal.job.job_id === ref.jobId
      ? status.findings.find(item => item.id === ref.findingId && codeReviewFindingNeedsUserDecision(item.type, reviewFixCapReached))
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
        question_text: exploreOpenQuestion.text,
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
        question_text: proposeOpenQuestion.text,
      },
    } : {}),
    ...(phaseAction ? {
      phase_confirmation: {
        boundary: phaseAction.boundary,
        decision: phaseAction.decision,
        review_risk: phaseReviewRisk ?? "strict",
      },
    } : {}),
    ...(exploreOpenQuestion || proposeOpenQuestion ? {
      closure,
      ...(followup ? { followup } : {}),
      ...(earlierAnswers.length > 0 ? { earlier_answers: earlierAnswers } : {}),
    } : {}),
    // 记下被确认的规模：之后规模不超过它就不再重复询问。
    ...(decision.scope.startsWith(PLAN_SIZE_BUDGET_SCOPE_PREFIX)
      ? { plan_size: currentPlanSize(openspecChangeRoot(projectRoot, change)) }
      : {}),
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
    message: closure === "needs_followup"
      ? "已登记为需要补充：这件事尚未闭环，不要回写结论；重新执行 next，会在同一事项下带着已收到的答复和需要补充的内容继续询问"
      : exploreOpenQuestion
        ? "这件事的答复已登记"
        : `用户决策已登记：决策范围（scope）=${decision.scope}`,
  };
}

/** 当前问题版本上尚未闭环的答复，闭环登记时一并留痕。 */
function pendingFollowupAnswers(history: OpenQuestionAnswerRecord[]): Array<{ answer: string; followup?: string; event_id: string }> {
  return history
    .filter(record => record.current_revision && record.closure === "needs_followup")
    .map(record => ({ answer: record.answer, ...(record.followup ? { followup: record.followup } : {}), event_id: record.event_id }));
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

/** 模式选择是 change 本地事实，不是执行授权。 */
export function recordWorkflowModeContent(projectRoot: string, change: string, content: string): RecordResult {
  return withLock(projectRoot, change, () => {
    const reject = (message: string): RecordResult => ({ accepted: false, message, events_written: 0 });
    let input: Record<string, unknown> | null;
    try {
      input = asObject(JSON.parse(content));
    } catch {
      return reject("模式选择必须是有效 JSON 对象");
    }
    if (!input || Object.keys(input).some(key => !["mode", "source", "reason", "user_request"].includes(key))) {
      return reject("模式选择仅接受 mode、source、reason 和 user_request");
    }
    const { mode, source, reason, user_request } = input;
    if (mode !== "minimal" && mode !== "normal") return reject("当前 change 只能选择 minimal 或 normal");
    if (source !== "agent" && source !== "user") return reject("source 必须为 agent 或 user");
    if (!nonEmptyString(reason)) return reject("reason 必须说明本次选档的实际依据");
    if (source === "user" && !nonEmptyString(user_request)) return reject("用户明确指定时必须保留真实 user_request");
    if (source === "agent" && user_request !== undefined) return reject("agent 自动选档不能附带伪装成用户选择的 user_request");
    if (source === "agent") {
      const discovery = validateDiscovery(openspecChangeRoot(projectRoot, change));
      if (!discovery.ok) return reject(`agent 自动选档前必须完成有效 discovery：${discovery.message}`);
      if (discovery.openCount > 0) return reject("agent 自动选档前必须先完成 discovery 中的待确认事项");
    }
    const selection: WorkflowModeSelection = {
      mode, source, reason: reason.trim(),
      ...(source === "user" ? { user_request: (user_request as string).trim() } : {}),
    };
    const events = readEvents(projectRoot, change);
    const latestCommit = events.findLast(event => event.event_type === "transition_commit");
    if (!latestCommit) return reject("请先通过 transition init 或 explore 初始化 change");
    const previous = latestWorkflowModeSelection(events);
    // 升级请求未决时，重复选择是一次新决定而不是幂等重放：必须落事件，否则用户无法维持 minimal。
    if (!workflowModeUpgradePending(events) && previous && JSON.stringify(previous) === JSON.stringify(selection)) {
      return { accepted: true, message: "当前 change 的相同模式选择已登记", events_written: 0 };
    }
    const state = latestCommit.payload.to_state as State;
    const error = workflowModeSelectionError(events, state, selection);
    if (error) return reject(error);
    appendEvent(projectRoot, change, makeEvent(change, "workflow_mode_selected", { ...selection }));
    return { event_type: "workflow_mode_selected", accepted: true, message: `当前 change 使用 ${mode}`, events_written: 1 };
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
    boundFiles: "本工作项绑定的文件清单；审查报告必须说明这些文件是否都看过。计划材料的 path 相对 change 目录，代码文件的 path 相对项目根；project_path 统一是同一文件相对项目根的路径；回执时两种写法都接受。",
    review_scope: "报告中的审查覆盖范围；普通 reviewer/verifier 无 review_baseline 时用 checked_paths 回执全部绑定文件，有 review_baseline 时只需回执相对基线发生变化的绑定文件；code-reviewer 还需按专用协议说明未检查项。",
    code_review_scope: "代码审查范围：从已审基点到当前 HEAD 的提交改动、工作区改动和未跟踪代码文件。",
    task_execution_index: "按任务汇总的执行证据：每个任务（task）的执行依据、有效证据要求、声明测试、测试证据和改动文件。",
    task_execution_index_scope: "任务执行索引的收录范围：since_event_id 之后完成的任务（代码审查为本审查周期，最终验证为本次验收周期；null 表示全部历史），加上被这些任务中的修复任务通过 parent_task_id 关联而带入的更早任务（carried_task_ids）；tasks.md 中更早完成的任务已在此前的代码审查放行或 change 验收中闭环，不因未出现在索引中而视为缺少证据。",
    contract: "任务启动时的执行依据快照：tests/design/source/acceptance/guard 分别对应 测试/设计/来源/验收/边界；null 表示历史任务没有执行依据。",
    required_evidence: "task-start 结合冻结策略编译并写入 attempt 的有效证据要求：test_ids、red_required、green_required 和允许的 GREEN 语义状态；null 表示历史任务按旧记录回放。",
    changed_paths: "与某个任务（task）或代码状态检查相关的改动文件。",
    changed_paths_partial_reason: "该任务（task）的提交段 diff 失败原因；存在时 changed_paths 只包含工作区对比结果，归属可能不完整。",
    unattributed_paths: "代码审查范围中暂时无法归属到某个任务（task）的文件。",
    added_code_paths: "相对本次代码审查基点新建的代码文件，供判断是否服务已批准行为。",
    structure_ledger: "design.md 中已批准的结构变更清单；清单是已批准结构的边界，清单外结构按 unjustified_addition 处理。",
    claim_kind: "阻塞问题相对已批准计划的关系：漏做、破坏已有行为、或计划或验收没有要求的改动。",
    approved_refs: "指向当前 change 已批准材料的引用：TEST-ID、结构变更清单的 SC-ID、design 待用户确认中的 DEC-ID，或 文件#标题（spec 写 specs/<能力>/spec.md#Requirement: <标题>）；引擎只检查能否解析，apply 漏做还需要 TEST 或 spec Requirement。",
    unknown_attribution_tasks: "因为缺少边界快照或提交段 diff 失败而无法完整计算改动归属的任务（task）。",
    coverage_exemption_refs: "测试覆盖豁免引用：说明某个 TEST 为什么没有绑定到任务（task）。",
    report_file_path: "报告需要落盘时的文件位置（项目相对路径），位于工作流记录目录；报告内容登记后由引擎存入 raw 记录，不属于计划材料。",
    inline_submission_command: "单条命令形式的登记入口：报告以单行 JSON 作为 --report-json 参数传入，适用于宿主只放行单条 superspec 命令的环境；登记语义与 submission_command 相同。",
    submission_command: "登记本工作项报告的命令，由执行本工作项的角色在完成后自己运行；返回的 result_kind 说明登记结果：accepted、review_failed、non_actionable_report 表示结论已登记为本工作项结果，retryable 表示可修正后以同一工作项重交，invalid_report、job_closed、job_invalidated、job_not_found 表示本次没有形成结论。",
    report_skeleton: "按本工作项预填的报告骨架（job_id / packet_digest / 空数组，verdict 留空）；逐字段填写即可，不要自行设计结构。",
    report_schema: "报告契约（字段形状、取值、条件、提示消息）；由 `superspec jobs contract --change <C> --job <J>` 输出，提交校验引用同一份定义。",
    code_review_gate: "最终验证读取的代码审查门禁事实：passed 指向已接受的代码审查工作项，skipped 表示本轮没有代码类改动。",
    code_state_check: "代码状态检查：最终验证时用于判断代码审查后代码是否又发生变化。",
    deliverable_docs: "本审查周期改动的普通文档（计划与工作流材料之外）及其内容指纹；纯文档改动的交付物在这里，登记前它们再变化会使本工作项作废。",
    stale_test_evidence: "测试证据登记早于当前代码的 TEST、对应任务和此后改动的文件；引擎不因此阻塞流程，由你判断现有证据是否仍能证明当前代码，证据不足时如实写进结论。",
    review_baseline: "同角色最近一次形成结论的审查工作项；存在时本工作项是相对它的材料复审。result_kind 为 review_failed 表示那次审查完整审过后以 fail 结论被拒，其 finding 见 previous_rejection。",
    material_delta: "相对 review_baseline 的逐文件材料变化：path 与 boundFiles 的 path 同一基准（计划材料相对 change 目录），status 为 added/removed/modified，diff 为 unified diff；diff_unavailable 说明为何没有差异、需要完整阅读该文件。",
    review_targets: "本 gate 可提出修改建议的材料，path 相对 change 目录；对应的项目相对路径见 boundFiles 中同一文件的 project_path。",
    read_only_refs: "只读上游材料，path 相对 change 目录；对应的项目相对路径见 boundFiles 中同一文件的 project_path。",
    previous_review_evidence: "上一轮同角色审查（通过或 fail）记录的 summary、evidence_refs，以及报告引用的代码文件自那次提交后是否未变化（code_files[].unchanged）。",
    confirmed_decisions: "工作项创建前已登记且已闭环的 Explore/Propose 问题答复：phase、question_id、问题原文、答复与登记事件 ID；earlier_answers 是闭环前同一问题下需要补充的答复，与 answer 一起构成用户的完整答复。",
    event_id: "事件 ID，用于追溯证据来源。",
    event_digest: "事件摘要，用于确认引用的证据事件没有被替换。",
    attempt_id: "任务尝试 ID；执行依据模式下测试运行必须绑定当前活跃任务尝试。",
    task_structure_digest: "历史模式的任务结构指纹；仅用于兼容旧证据。",
    test_id: "测试契约里的 TEST ID。",
    semantic_status: "测试语义状态：RED 预期失败、GREEN 预期成功或特征化（characterization）通过。",
    covers_task_ids: "回归测试覆盖了哪些已完成任务（task）。",
    scope_note: "实施范围说明；任务（task）实现超出执行依据边界，或代码审查修复保留被质疑实现时，填写原因、影响区域、计划一致性和验证依据。",
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
  const isPlanReview = [EXPLORE_DISCOVERY_REVIEW_GATE, PROPOSE_FINAL_REVIEW_GATE].some(gate => gate.isJobForGate(job));
  const previousEvidence = isPlanReview ? previousReviewEvidence(projectRoot, events, job) : null;
  const decisions = isPlanReview ? confirmedDecisions(events, job) : [];
  const changePrefix = relative(projectRoot, openspecChangeRoot(projectRoot, change)).replace(/\\/g, "/");
  return {
    found: true,
    packet: {
      job_id: job.job_id,
      role: job.role,
      ...(job.gate_id ? { gate_id: job.gate_id } : {}),
      recommended_agent: recommendedAgentForRole(job.role),
      boundFiles: job.boundFiles.map(file => ({
        ...file,
        project_path: isCodeReviewer ? file.path : `${changePrefix}/${file.path}`,
      })),
        ...(isReviewer && reviewTargets.length > 0 ? { review_targets: reviewTargets } : {}),
        ...(isReviewer && readOnlyRefs.length > 0 ? { read_only_refs: readOnlyRefs } : {}),
        ...(job.review_evidence_digest ? { review_evidence_digest: job.review_evidence_digest } : {}),
        ...(job.previous_rejection ? { previous_rejection: job.previous_rejection } : {}),
        ...(packetContext?.code_review_scope ? { code_review_scope: packetContext.code_review_scope } : {}),
        ...(packetContext?.code_review_gate ? { code_review_gate: packetContext.code_review_gate } : {}),
        ...(packetContext?.coverage_exemption_refs ? { coverage_exemption_refs: packetContext.coverage_exemption_refs } : {}),
        ...(packetContext?.task_execution_index ? { task_execution_index: packetContext.task_execution_index } : {}),
        ...(packetContext?.task_execution_index_scope ? { task_execution_index_scope: packetContext.task_execution_index_scope } : {}),
        ...(packetContext?.unattributed_paths ? { unattributed_paths: packetContext.unattributed_paths } : {}),
        ...(packetContext?.unknown_attribution_tasks ? { unknown_attribution_tasks: packetContext.unknown_attribution_tasks } : {}),
        ...(packetContext?.added_code_paths ? { added_code_paths: packetContext.added_code_paths } : {}),
        ...(packetContext?.structure_ledger ? { structure_ledger: packetContext.structure_ledger } : {}),
        ...(packetContext?.code_state_check ? { code_state_check: packetContext.code_state_check } : {}),
        ...(packetContext?.deliverable_docs ? { deliverable_docs: packetContext.deliverable_docs } : {}),
        ...(packetContext?.stale_test_evidence ? { stale_test_evidence: packetContext.stale_test_evidence } : {}),
        ...(job.review_baseline
          ? {
              review_baseline: {
                job_id: job.review_baseline.job_id,
                ...(job.review_baseline.result_kind ? { result_kind: job.review_baseline.result_kind } : {}),
              },
              material_delta: materialDelta(projectRoot, change, job),
            }
          : {}),
        ...(previousEvidence ? { previous_review_evidence: previousEvidence } : {}),
        ...(decisions.length > 0 ? { confirmed_decisions: decisions } : {}),
        packet_digest: job.packet_digest,
        required_output_kind: "job_report_json",
        preferred_input_mode: "stdin",
        submission_command: `superspec record job-submit --change "${change}" --job "${job.job_id}" --report -`,
        submission_argv: jobSubmitArgv(change, job.job_id),
        inline_submission_command: `superspec record job-submit --change "${change}" --job "${job.job_id}" --report-json '<单行报告 JSON>'`,
        file_fallback: true,
        report_file_path: jobReportFilePath(change, job.job_id),
        output_contract_fields: isCodeReviewer
          ? [...REVIEW_REPORT_REQUIRED_FIELDS, "reviewer", "review_scope"]
          : [
              ...REVIEW_REPORT_REQUIRED_FIELDS,
              ...(requiresReviewer(job.role) ? ["reviewer"] : []),
              ...(hasReviewScope ? ["review_scope"] : []),
            ],
        output_contract_optional_fields: [...REVIEW_REPORT_OPTIONAL_FIELDS],
        report_skeleton: reportSkeletonForJob(job),
        字段说明: packetFieldDescriptions(),
        output_instructions:
          `${roleDescription(job.role)}。本工作项的报告结构以 packet 顶层 report_skeleton 为准（完整契约：superspec jobs contract --change "${change}" --job "${job.job_id}"）：按骨架逐字段填写，job_id / packet_digest 已按本工作项预填，不要改写，也不要用上一轮报告里的值。` +
          (isReviewer
            ? reviewScopeInstruction(job, reviewTargets, readOnlyRefs, path => isCodeReviewer ? path : `${changePrefix}/${path}`)
            : "") +
          (isReviewer ? migrationEvidenceInstruction(job) : "") +
          (job.review_evidence_digest ? `本工作项对应的执行证据版本为 ${job.review_evidence_digest}，` : "") +
          (isReviewer ? genericReviewCoverageInstruction(job) + proposalIncrementalReviewInstruction(job) + previousRejectionInstruction(job) : "") +
          (previousEvidence ? PREVIOUS_REVIEW_EVIDENCE_INSTRUCTION : "") +
          (decisions.length > 0 ? CONFIRMED_DECISIONS_INSTRUCTION : "") +
          (isPlanReview ? PLAN_REVIEW_PASS_FINDINGS_INSTRUCTION : "") +
          (requiresReviewer(job.role) ? `必须由独立 ${recommendedAgentForRole(job.role)} 审查角色执行，并在审查者来源字段（reviewer.kind/id）中记录来源，` : "") +
          (isReviewer ? REVIEWER_SELF_SUBMISSION_INSTRUCTION : "产出 JSON 报告内容并优先通过 --report - 从 stdin 登记；") +
          `需要落盘时写到 report_file_path，不要写进 openspec/changes 或 .superspec/artifacts 等计划材料目录。${recordInputInstruction(job)}协议字段含义见 packet 顶层“字段说明”，普通对话不要原样复述 JSON。` +
          (isCodeReviewer
            ? `格式骨架：${JSON.stringify(reportSkeletonForJob(job))}。提交前按真实审查结果填写数组；不得从 boundFiles 自动复制 checked_paths。verdict 只能为 pass 或 fail；审查覆盖范围（review_scope）用来说明本次审查覆盖了哪些文件和文档，已检查路径（checked_paths）与未检查项（unchecked）必须合起来覆盖全部绑定文件（boundFiles），unchecked 条目格式为 {"path":"<path>","reason":"<reason>"}；pass 不允许仍有未检查的绑定文件。`
              + `报告结论为 fail 时，问题列表（findings）至少包含一个可处理、可追溯的阻塞问题，字段为 {"id":"<stable-id>","blocking":true,"type":"implementation|spec|mixed","claim_kind":"missing_approved|breaks_existing|unjustified_addition","approved_refs":["TEST-001"],"description":"<what>","evidence":"<why>","source_refs":["<path:line>"],"impact":"<impact>","suggested_action":"apply|propose"}。问题类型（type）中 implementation 表示纯代码实现问题，spec 表示方案/需求文档问题，mixed 表示需要使用者判断的混合问题；claim_kind 与 approved_refs 见字段说明。`
              + (packetContext?.task_execution_index
                ? `本工作项带任务执行索引（task_execution_index）：按 task 对照其执行依据快照（contract）审查——实现路线对照 design 引用原文、累计 diff 对照 guard 边界、测试断言对照 tests 声明的 scenario；每项的 required_evidence 是 task-start 冻结的证据口径，red_required/green_required 分别说明是否需要 RED/GREEN；fix 非空表示状态机创建的实现修复，source、parent_task_id 和 reason 说明其归属，code_review 来源还需核对 review_finding；scope_note 既可能解释必要的范围扩大，也可能说明代码审查修复为何保留原实现，均需结合 Diff、调用链和验证证据独立判断；changed_paths 是归属线索不是结论（null 表示未知）；unattributed_paths 中的无主改动和 added_code_paths 中的新建代码文件，均需判断是否服务已批准行为：放行其中任何计划外文件，都必须写明它服务于哪条已批准锚点、为何无法避免，说不出依据的按 unjustified_addition 收缩；coverage_exemption_refs 解释未绑定 task 的 TEST 豁免。当前 packet 的 boundFiles 是本轮冻结的审查范围；若它来自前一轮审查后的增量，只复核本轮变化及其直接影响链路，不要求重复审查未变化文件，但仍要判断批准行为是否完整闭合。`
                : "")
            : job.role === "verifier"
            ? `最小格式：${JSON.stringify(reportSkeletonForJob(job))}。verdict 只能为 pass 或 fail；核对代码审查记录（code_review_gate）：passed 必须能追溯到已接受的代码审查工作项，skipped 必须能证明本次没有代码类改动。核对修复闭环：task_execution_index.fix.source=code_review 时必须核对 review_finding 对应问题是否关闭；source=self_test 时必须核对 parent_task_id、记录的自测原因、本次 attempt 验证和最新代码审查是否共同闭环。方案/混合问题必须有用户决策或后续修复证据。按 task_execution_index 的 required_evidence 核对测试证据：red_required 时需要同一 TEST 的 RED（expected_failure）后 GREEN；green_required 时每个声明 TEST 都需要允许的 GREEN 语义状态；测试运行证据应包含测试 ID（test_id）、命令（command）、工作目录（cwd）、退出码（exit_code）、语义状态（semantic_status）。修复 task 的回归测试运行可用回归覆盖任务列表（covers_task_ids）说明覆盖了哪些已完成任务；缺少任务尝试 ID（attempt_id）的旧证据只能弱引用。`
            : isReviewer
            ? `最小格式：${JSON.stringify(reportSkeletonForJob(job))}。verdict 只能为 pass 或 fail。`
            : `最小格式：${JSON.stringify(reportSkeletonForJob(job))}。verdict 只能为 pass 或 fail。`),
        stop_conditions: isReviewer
          ? ["用 submission_command 登记本工作项报告后结束，不要修改文档或代码"]
          : job.role === "executor"
          ? ["完成绑定范围内的实现后提交执行报告，不要修改未绑定范围"]
          : ["完成指定验证后提交测试报告，不要修改项目文档"],
        created_from_transition: job.created_from_transition,
      },
    message: `工作项 ${jobId} 的执行说明`,
  };
}

/**
 * jobs contract：单独取报告契约（默认）或可填骨架（--skeleton）。
 *
 * 与 packet 顶层的 report_skeleton 同源，供审查角色在产出报告前自查结构，
 * 不必从 packet 的长段落里提取。
 */
export function jobsContract(
  projectRoot: string,
  change: string,
  jobId: string,
  opts: { skeleton?: boolean } = {},
): {
  found: boolean;
  job_id?: string;
  role?: JobRole;
  report_schema?: ReportSchemaContract;
  report_skeleton?: Record<string, unknown>;
  fill_items?: string[];
  contract_command?: string;
  skeleton_command?: string;
  message: string;
} {
  const job = findJob(readEvents(projectRoot, change), jobId);
  if (!job) return { found: false, message: `工作项 ${jobId} 不存在` };
  const base = ["superspec", "jobs", "contract", "--change", change, "--job", job.job_id];
  return {
    found: true,
    job_id: job.job_id,
    role: job.role,
    report_schema: reportSchemaForJob(job),
    report_skeleton: reportSkeletonForJob(job),
    fill_items: reportSkeletonFillItems(job),
    contract_command: base.join(" "),
    skeleton_command: [...base, "--skeleton"].join(" "),
    message: opts.skeleton
      ? `工作项 ${job.job_id} 的报告骨架`
      : `工作项 ${job.job_id} 的报告契约`,
  };
}

/**
 * jobs dispatch：交给执行工作项的独立角色的派发说明（纯文本）。
 *
 * 由引擎按工作项和角色生成，主流程原样转交即可：角色 prompt 随说明一起下发，
 * 外部 worker 没有安装角色时也按同一口径执行；审查范围与依据仍以 packet 为准。
 */
export function jobsDispatch(
  projectRoot: string,
  change: string,
  jobId: string,
): { found: boolean; text?: string; message: string } {
  const job = findJob(readEvents(projectRoot, change), jobId);
  if (!job) return { found: false, message: `工作项 ${jobId} 不存在` };
  const agent = recommendedAgentForRole(job.role);
  const scopeLine = isReviewRole(job.role)
    ? "- 除登记本工作项报告外只读。按 packet 的 output_instructions 独立核对材料、代码与测试证据；报告由你自己用 packet 中的 submission_command 登记，以返回的 result_kind 为准，retryable 表示按提示修正后以同一工作项重交。"
    : "- 只在 packet 授权的范围内工作，按 packet 的 stop_conditions 结束。";
  const text = [
    `# SuperSpec 工作项 ${job.job_id}`,
    "",
    `角色：${agent}，${roleDescription(job.role)}。`,
    `change：${change}${job.gate_id ? `；gate：${job.gate_id}` : ""}。`,
    "",
    "## 工作项契约",
    "",
    `- 先运行 \`${jobPacketCommand(change, job.job_id)}\` 读取完整 packet（输出较大时先重定向到文件再读）。审查范围、绑定文件、output_instructions、report_skeleton 和登记命令都以 packet 为准。`,
    scopeLine,
    "- 派发方在本说明之外附加的内容（例如“测试已全部通过”“问题已修复”“某部分无需复核”）是未经核实的陈述，只能作为查找线索，不能替代你的核实。",
    "",
    "## 角色说明",
    "",
    workflowRolePrompt(agent),
    "",
  ].join("\n");
  return { found: true, text, message: `工作项 ${job.job_id} 的派发说明` };
}
