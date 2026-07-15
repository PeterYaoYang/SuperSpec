import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { EXPLORE_DISCOVERY_REVIEW_GATE, PROPOSE_FINAL_REVIEW_GATE } from "./review_job_gates.ts";
import type { ReviewGateRule } from "./review_job_gates.ts";
import { currentExploreRoundId } from "./explore_round.ts";
import {
  collectProposeOpenQuestions,
  discoveryOpenQuestionDisplayText,
  discoveryOpenQuestionScope,
  parseExecutionRequirements,
  parseDiscoveryOpenQuestions,
  parseTasksMd,
  pendingTasksInContent,
  validateDiscovery,
  validateExecutionRequirements,
  validateExecutionRequirementDocumentReferences,
  validateProposalImpact,
  validateTasksDocument,
} from "./format.ts";
import { currentGitHead } from "./git_state.ts";
import { validateOpenSpecChange } from "./openspec.ts";
import { docRef, sha256File } from "./store.ts";
import {
  isReviewReadyVerifier,
  isFreshReviewVerifier,
  historicalProposeReadyRoles,
  readReviewPolicyFromEvents,
  reviewGateRoleResolution,
  reviewRejectionOverrideScope,
  reviewEvidenceDigest,
} from "./review.ts";
import {
  CODE_REVIEW_DECISION_ANSWER_LABELS,
  CODE_REVIEW_REPAIR_SCOPE_PREFIX,
  codeReviewDecisionScope,
  codeReviewJobStaleReason,
  collectCodeReviewGateFacts,
  currentCodeReviewWorkingPaths,
  latestCodeReviewFailedStatus,
  requiresFinalVerifierForCurrentReview,
  scanCodeChangesForReview,
} from "./code_review.ts";
import {
  isPhaseAdvanceAuthorized,
  latestAcceptedPhaseDecision,
  phaseConfirmationCommitPayload,
  phaseConfirmationForBoundary,
  phaseConfirmationMissingMessage,
  type PhaseBoundary,
} from "./phase_confirmation.ts";
import { taskEvidenceReadiness } from "./task_evidence.ts";
import type {
  AcceptedMaterialFollowupContinuation,
  AskUser,
  Event,
  ExecutionPolicy,
  Job,
  JobRole,
  PlanningValidationProfile,
  State,
} from "./types.ts";
import type { Snapshot } from "./types.ts";
import type { ReviewRisk } from "./review.ts";
import { workflowRiskForProposeRound, workflowRiskForState } from "./workflow_config.ts";

export type TransitionName =
  | "explore"
  | "propose-ready"
  | "start-apply"
  | "task-start"
  | "task-complete"
  | "review-ready"
  | "reopen"
  | "accept";

export type WorkflowMode = { kind: "risk"; risk: ReviewRisk };

export interface PhasePlanContext {
  projectRoot: string;
  change: string;
  changeRoot: string;
  events: Event[];
  snapshot: Snapshot;
  mode: WorkflowMode;
}

export interface TransitionPlanContext extends PhasePlanContext {}

export type ReopenNextStep =
  | { to: "apply"; reason: "pending_tasks"; taskIds: string[] }
  | { to: "apply"; reason: "review_fix"; jobId: string; findingId: string; reopenReason: string }
  | { to: "propose"; reason: "review_finding"; jobId: string; findingId: string };

export type NextStepPlan =
  | { kind: "required_jobs"; state: State; jobs: Job[]; reason: string }
  | { kind: "ask_user"; state: State; ask: AskUser; reason: string }
  | { kind: "run_transition"; state: State; transition: TransitionName; reason: string; risk?: ReviewRisk; taskId?: string; reopen?: ReopenNextStep }
  | {
      kind: "done";
      state: State;
      reason: string;
      continuation?: AcceptedMaterialFollowupContinuation;
    };

export type TransitionDecisionPlan =
  | { kind: "skip"; message: string }
  | { kind: "blocked"; jobs: Job[]; reason: string; details?: Record<string, unknown> }
  | { kind: "create_gate_jobs"; gate: ReviewGateRule; roles: JobRole[]; reason: string }
  | { kind: "advance"; fromState: State; toState: State; reason: string; payload?: Record<string, unknown> };

export interface ApplyPendingTaskStatus {
  mode: "legacy" | "contract";
  pending: string[];
  needsCompletionEvent: string[];
  completedByEvent: string[];
}

type ReviewGatePlanResult = Extract<TransitionDecisionPlan, { kind: "blocked" | "create_gate_jobs" }>;

function requiredJobs(state: State, jobs: Job[], reason: string): NextStepPlan {
  return { kind: "required_jobs", state, jobs, reason };
}

function phaseConfirmationStep(
  context: PhasePlanContext,
  boundary: PhaseBoundary,
  reason: string,
): NextStepPlan | null {
  // 进入 propose_ready / apply 后，mode 来自本轮快照而非当前配置。
  const risk = workflowRiskForState(context.events, context.snapshot.state, context.mode.risk);
  const confirmation = phaseConfirmationForBoundary(
    context.projectRoot,
    context.events,
    context.snapshot,
    boundary,
    risk,
  );
  if (!confirmation || isPhaseAdvanceAuthorized(context.events, confirmation)) return null;
  return {
    kind: "ask_user",
    state: context.snapshot.state,
    ask: confirmation.ask,
    reason,
  };
}

function reviewGatePlan(
  snapshot: Snapshot,
  events: Event[],
  changeRoot: string,
  gate: ReviewGateRule,
  requiredRoles: JobRole[],
): ReviewGatePlanResult | null {
  const missingRoles: { role: JobRole; reason: string }[] = [];
  for (const role of requiredRoles) {
    const openForRole = snapshot.open_jobs.find(job => gate.isJobForGate(job) && job.role === role);
    if (openForRole) {
      return { kind: "blocked", reason: `状态未推进；已有待完成工作项 ${role}（${openForRole.job_id}）`, jobs: [openForRole] };
    }

    const resolution = reviewGateRoleResolution(events, changeRoot, gate, role);
    if (resolution.kind === "accepted" || resolution.kind === "overridden") continue;
    if (resolution.kind === "rejected_pending") {
      const terminal = resolution.terminal;
      const overrideScope = reviewRejectionOverrideScope(terminal.job.job_id);
      return {
        kind: "blocked",
        jobs: [],
        reason: `状态未推进；${role} 审查工作项 ${terminal.job.job_id} 已拒绝。请修改绑定材料、在整份报告没有有效 blocker 时登记整体裁决，或在涉及业务决定时询问用户`,
        details: {
          review_rejection: {
            job_id: terminal.job.job_id,
            role,
            gate_id: gate.gate_id,
            packet_digest: terminal.job.packet_digest,
            result_kind: terminal.result_kind,
            reason: terminal.reason ?? "报告结论为 fail，工作项未通过",
            override_scope: overrideScope,
            allowed_actions: ["modify_materials", "record_override", "ask_user"],
            record_input: {
              scope: overrideScope,
              answer: "do_not_block",
              reason: "<说明整份报告为何没有有效 blocker>",
              decision_source: "main_process",
            },
          },
        },
      };
    }
    const reason = resolution.kind === "stale"
      ? `需求 ${role} 的最新审查工作项已过期：${resolution.stale_reason}`
      : resolution.kind === "rejected_invalid"
        ? `需求 ${role} 的最新审查报告无效，不能通过整体裁决绕过`
        : `需求 ${role} 无已接受的工作项`;
    missingRoles.push({ role, reason });
  }

  if (missingRoles.length > 0) {
    return {
      kind: "create_gate_jobs",
      gate,
      roles: missingRoles.map(item => item.role),
      reason: missingRoles.map(item => item.reason).join("; "),
    };
  }
  return null;
}

function validateTasksPlan(changeRoot: string, executionRequirementVersion: 1 | 2): string | null {
  const tasksPath = join(changeRoot, "tasks.md");
  if (!existsSync(tasksPath)) return "tasks.md 不存在";
  const tasksContent = readFileSync(tasksPath, "utf8");
  if (executionRequirementVersion === 1) {
    return tasksContent.includes("# Tasks") || tasksContent.includes("- [ ]")
      ? null
      : "tasks.md 内容不像任务计划文档";
  }
  const errors = validateTasksDocument(tasksContent);
  if (errors.length > 0) return errors.join("；");
  return null;
}

export function executionPolicyForRisk(risk: ReviewRisk): ExecutionPolicy {
  return risk === "strict" ? "tdd" : "green_only";
}

export function executionPolicyForCurrentRound(events: Event[]): ExecutionPolicy {
  const index = latestStartApplyIndex(events);
  if (index < 0) return "tdd";
  const payload = events[index].payload as { execution_policy?: unknown };
  return payload.execution_policy === "green_only" || payload.execution_policy === "tdd"
    ? payload.execution_policy
    : "tdd";
}

function validateExecutionRequirementPlan(
  changeRoot: string,
  executionPolicy: ExecutionPolicy,
  executionRequirementVersion: 1 | 2 = 2,
): { ok: true; mode: boolean } | { ok: false; message: string; mode: boolean } {
  const tasksPath = join(changeRoot, "tasks.md");
  if (!existsSync(tasksPath)) return { ok: true, mode: false };
  const tasksContent = readFileSync(tasksPath, "utf8");
  const testContractPath = join(changeRoot, ".superspec", "artifacts", "test-contract.md");
  const testContractContent = existsSync(testContractPath) ? readFileSync(testContractPath, "utf8") : null;
  const validation = validateExecutionRequirements(
    tasksContent,
    testContractContent,
    executionPolicy,
    executionRequirementVersion,
  );
  return validation.ok
    ? { ok: true, mode: validation.mode }
    : { ok: false, mode: validation.mode, message: validation.errors.join("；") };
}

function missingBaseArtifact(changeRoot: string, risk: ReviewRisk): string | null {
  if (risk === "minimal") return null;
  const artifactsDir = join(changeRoot, ".superspec", "artifacts");
  for (const doc of ["discovery.md", "test-contract.md"]) {
    if (!existsSync(join(artifactsDir, doc))) return `基础职责缺失：${doc} 不存在（risk=${risk} 需要）`;
  }
  return null;
}

/** OpenSpec strict gate 只在当前 planning round 冻结为 strict 时执行。 */
function validateOpenSpecPlanningDocuments(
  projectRoot: string,
  change: string,
  changeRoot: string,
  profile: PlanningValidationProfile | null,
): string | null {
  if (profile == null || profile.openspec.mode !== "strict") return null;
  const currentConfigDigest = sha256File(join(projectRoot, "openspec", "config.yaml"));
  if (currentConfigDigest !== profile.openspec.config_digest) {
    return "OpenSpec 配置自本 planning round 起已变化；请恢复原配置或 reopen --to propose 创建新的计划轮";
  }
  const tasksPath = join(changeRoot, "tasks.md");
  const referenceErrors = validateExecutionRequirementDocumentReferences(
    changeRoot,
    parseExecutionRequirements(readFileSync(tasksPath, "utf8")),
  );
  if (referenceErrors.length > 0) return referenceErrors.join("；");
  const proposalPath = join(changeRoot, "proposal.md");
  if (!existsSync(proposalPath)) return "proposal.md 不存在";
  const impact = validateProposalImpact(readFileSync(proposalPath, "utf8"));
  if (!impact.ok) return impact.message;

  const native = validateOpenSpecChange(projectRoot, change);
  return native.ok ? null : native.message;
}

function validatePlanningPreflight(
  projectRoot: string,
  change: string,
  changeRoot: string,
  risk: ReviewRisk,
  executionPolicy: ExecutionPolicy,
  profile: PlanningValidationProfile | null,
): { error: string | null; contractMode: boolean } {
  const executionRequirementVersion = profile?.version ?? 1;
  const tasksPlanError = validateTasksPlan(changeRoot, executionRequirementVersion);
  if (tasksPlanError) return { error: tasksPlanError, contractMode: false };

  const executionRequirementPlan = validateExecutionRequirementPlan(changeRoot, executionPolicy, executionRequirementVersion);
  if (!executionRequirementPlan.ok) return { error: executionRequirementPlan.message, contractMode: false };

  const missingArtifact = missingBaseArtifact(changeRoot, risk);
  if (missingArtifact) return { error: missingArtifact, contractMode: false };

  return {
    error: validateOpenSpecPlanningDocuments(projectRoot, change, changeRoot, profile),
    contractMode: executionRequirementPlan.mode,
  };
}

export function proposalDocsBaseline(changeRoot: string): Record<string, string> {
  // 与 Propose gate 的可修改审查目标保持同一来源：specs/ 用目录聚合指纹，避免 reopen 基线漏掉任一个可修改的计划材料。
  const docs = PROPOSE_FINAL_REVIEW_GATE.reviewTargets;
  const baseline: Record<string, string> = {};
  for (const doc of docs) {
    baseline[doc] = docRef(changeRoot, doc).sha;
  }
  return baseline;
}

export function discoveryDocsBaseline(changeRoot: string): Record<string, string> {
  // 与 Explore gate 使用同一组审查目标。回退到 explore 后，至少要更新一项
  // discovery 材料，才允许重新进入 propose，避免把一次纯状态回退误当作新探索轮次。
  const baseline: Record<string, string> = {};
  for (const doc of EXPLORE_DISCOVERY_REVIEW_GATE.reviewTargets) {
    baseline[doc] = docRef(changeRoot, doc).sha;
  }
  return baseline;
}

function isDigestMap(value: unknown): value is Record<string, string> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const entries = Object.entries(value as Record<string, unknown>);
  return entries.length > 0 && entries.every(([, digest]) => typeof digest === "string");
}

export function latestAcceptedProposalBaseline(events: Event[]): Record<string, string> | null {
  for (let i = events.length - 1; i >= 0; i--) {
    const ev = events[i];
    if (ev.event_type !== "transition_commit") continue;
    const payload = ev.payload as {
      transition?: unknown;
      from_state?: unknown;
      to_state?: unknown;
      accepted_baseline_docs?: unknown;
    };
    if (
      payload.transition !== "accept" ||
      payload.from_state !== "review" ||
      payload.to_state !== "accepted"
    ) continue;
    return isDigestMap(payload.accepted_baseline_docs)
      ? payload.accepted_baseline_docs
      : null;
  }
  return null;
}

export function latestReopenProposeBaseline(events: Event[]): Record<string, string> | null {
  for (let i = events.length - 1; i >= 0; i--) {
    const ev = events[i];
    if (ev.event_type !== "transition_commit") continue;
    const payload = ev.payload as { transition?: unknown; reopen_target?: unknown; baseline_docs?: unknown };
    if (payload.transition !== "reopen" || payload.reopen_target !== "propose") continue;
    if (!payload.baseline_docs || typeof payload.baseline_docs !== "object" || Array.isArray(payload.baseline_docs)) return null;
    return payload.baseline_docs as Record<string, string>;
  }
  return null;
}

export function latestReopenExploreBaseline(events: Event[]): Record<string, string> | null {
  for (let i = events.length - 1; i >= 0; i--) {
    const ev = events[i];
    if (ev.event_type !== "transition_commit") continue;
    const payload = ev.payload as { transition?: unknown; reopen_target?: unknown; baseline_docs?: unknown };
    if (payload.transition !== "reopen" || payload.reopen_target !== "explore") continue;
    if (!payload.baseline_docs || typeof payload.baseline_docs !== "object" || Array.isArray(payload.baseline_docs)) return null;
    return payload.baseline_docs as Record<string, string>;
  }
  return null;
}

export function proposalDocsChangedSinceBaseline(changeRoot: string, baseline: Record<string, string>): boolean {
  const current = proposalDocsBaseline(changeRoot);
  return Object.entries(baseline).some(([path, digest]) => current[path] !== digest);
}

export function discoveryDocsChangedSinceBaseline(changeRoot: string, baseline: Record<string, string>): boolean {
  const current = discoveryDocsBaseline(changeRoot);
  return Object.entries(baseline).some(([path, digest]) => current[path] !== digest);
}

export function pendingTaskIds(changeRoot: string): string[] {
  const tasksContent = readFileSync(join(changeRoot, "tasks.md"), "utf8");
  return pendingTasksInContent(tasksContent).map(task => task.taskId);
}

function latestStartApplyIndex(events: Event[]): number {
  for (let i = events.length - 1; i >= 0; i--) {
    const ev = events[i];
    if (ev.event_type !== "transition_commit") continue;
    const payload = ev.payload as { transition?: unknown; to_state?: unknown };
    if (payload.transition === "start-apply" && payload.to_state === "apply") return i;
  }
  return -1;
}

function executionRequirementVersionFromPayload(payload: Record<string, unknown>): 1 | 2 {
  return payload.execution_requirement_version === 2 ? 2 : 1;
}

/** 当前 Apply round 的规则版本；缺失版本的历史 event 保持 v1 回放。 */
export function executionRequirementVersionForCurrentRound(events: Event[]): 1 | 2 {
  const index = latestStartApplyIndex(events);
  return index < 0 ? 1 : executionRequirementVersionFromPayload(events[index].payload);
}

/** Propose-ready 的规则版本决定随后 start-apply 是否采用新的全任务声明要求。 */
function executionRequirementVersionForProposeRound(events: Event[]): 1 | 2 {
  for (let i = events.length - 1; i >= 0; i--) {
    const event = events[i];
    if (event.event_type !== "transition_commit") continue;
    const payload = event.payload as { transition?: unknown; to_state?: unknown };
    if (payload.transition === "propose-ready" && payload.to_state === "propose_ready") {
      return executionRequirementVersionFromPayload(event.payload);
    }
  }
  return 1;
}

function isPlanningValidationProfile(value: unknown): value is PlanningValidationProfile {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const profile = value as { version?: unknown; openspec?: { mode?: unknown; config_digest?: unknown } };
  if (profile.version !== 2 || !profile.openspec || typeof profile.openspec !== "object") return false;
  return profile.openspec.mode === "disabled" ||
    profile.openspec.mode === "strict" && typeof profile.openspec.config_digest === "string";
}

/** 新 planning round 在进入 propose 时冻结当前 OpenSpec 校验契约。 */
export function planningValidationProfileForNewRound(projectRoot: string): PlanningValidationProfile {
  const configDigest = sha256File(join(projectRoot, "openspec", "config.yaml"));
  return configDigest == null
    ? { version: 2, openspec: { mode: "disabled" } }
    : { version: 2, openspec: { mode: "strict", config_digest: configDigest } };
}

/** propose 状态尚未 ready 时，从进入本 planning round 的事件读取冻结 profile。 */
function planningValidationProfileForPendingProposeRound(events: Event[]): PlanningValidationProfile | null {
  for (let i = events.length - 1; i >= 0; i--) {
    const event = events[i];
    if (event.event_type !== "transition_commit") continue;
    const payload = event.payload as {
      transition?: unknown;
      to_state?: unknown;
      reopen_target?: unknown;
      planning_validation_profile?: unknown;
    };
    // 只读取“进入 propose”的边界事件。propose-ready 创建审查 job 时也会
    // 保持在 propose；若把它误当作新的 planning round，便会覆盖此前冻结的
    // profile 并把当前轮错误降级为 v1。
    const entersPropose = payload.to_state === "propose" && (
      payload.transition === "explore" ||
      payload.transition === "propose" ||
      payload.transition === "reopen" && payload.reopen_target === "propose"
    );
    if (!entersPropose) continue;
    return isPlanningValidationProfile(payload.planning_validation_profile)
      ? payload.planning_validation_profile
      : null;
  }
  return null;
}

/** 已完成 propose-ready 的 round 只回放当时冻结的 profile。 */
function planningValidationProfileForReadyProposeRound(events: Event[]): PlanningValidationProfile | null {
  for (let i = events.length - 1; i >= 0; i--) {
    const event = events[i];
    if (event.event_type !== "transition_commit") continue;
    const payload = event.payload as { transition?: unknown; to_state?: unknown; planning_validation_profile?: unknown };
    if (payload.transition !== "propose-ready" || payload.to_state !== "propose_ready") continue;
    if (isPlanningValidationProfile(payload.planning_validation_profile)) return payload.planning_validation_profile;
    // 过渡期已写 v2 执行依据、但尚未带 profile 的事件保持 v2 tasks 契约，
    // 但不在 start-apply 追溯新增 strict gate。
    return executionRequirementVersionFromPayload(event.payload) === 2
      ? { version: 2, openspec: { mode: "disabled" } }
      : null;
  }
  return null;
}

export function applyRequirementModeForCurrentRound(events: Event[]): boolean {
  const index = latestStartApplyIndex(events);
  if (index < 0) return false;
  const payload = events[index].payload as { apply_contract_mode?: unknown; execution_requirement_mode?: unknown };
  return payload.apply_contract_mode === true || payload.execution_requirement_mode === true;
}

export function pendingTaskStatusForApply(changeRoot: string, events: Event[]): ApplyPendingTaskStatus {
  const tasksContent = readFileSync(join(changeRoot, "tasks.md"), "utf8");
  const tasks = parseTasksMd(tasksContent);
  if (!applyRequirementModeForCurrentRound(events)) {
    return {
      mode: "legacy",
      pending: tasks.filter(task => !task.done).map(task => task.taskId),
      needsCompletionEvent: [],
      completedByEvent: [],
    };
  }

  const startIndex = latestStartApplyIndex(events);
  const completedAttemptKeys = new Set<string>();
  const completedByTask = new Set<string>();
  const startedByTask = new Map<string, string[]>();
  for (const ev of events.slice(startIndex + 1)) {
    if (ev.event_type === "task_started") {
      const payload = ev.payload as { task_id?: unknown; attempt_id?: unknown };
      if (typeof payload.task_id !== "string" || typeof payload.attempt_id !== "string") continue;
      const attempts = startedByTask.get(payload.task_id) ?? [];
      attempts.push(payload.attempt_id);
      startedByTask.set(payload.task_id, attempts);
    } else if (ev.event_type === "task_completed") {
      const payload = ev.payload as { task_id?: unknown; attempt_id?: unknown };
      if (typeof payload.task_id !== "string" || typeof payload.attempt_id !== "string") continue;
      completedAttemptKeys.add(`${payload.task_id}\u0000${payload.attempt_id}`);
      completedByTask.add(payload.task_id);
    }
  }

  const pending: string[] = [];
  const needsCompletionEvent: string[] = [];
  const completedByEvent: string[] = [];
  for (const task of tasks) {
    const startedAttempts = startedByTask.get(task.taskId) ?? [];
    const hasActiveCurrentAttempt = startedAttempts.some(attemptId => !completedAttemptKeys.has(`${task.taskId}\u0000${attemptId}`));
    if (hasActiveCurrentAttempt) {
      pending.push(task.taskId);
      needsCompletionEvent.push(task.taskId);
      continue;
    }
    if (completedByTask.has(task.taskId)) {
      completedByEvent.push(task.taskId);
      continue;
    }
    if (!task.done) pending.push(task.taskId);
  }

  return {
    mode: "contract",
    pending,
    needsCompletionEvent,
    completedByEvent,
  };
}

export function formatPendingTaskMessage(ids: string[], action: string): string {
  return `尚有未完成任务：${ids.join(", ")}；${action}`;
}

function nextArgv(change: string, _risk: ReviewRisk): string[] {
  return [
    "superspec",
    "transition",
    "next",
    "--change",
    change,
  ];
}

function acceptedMaterialFollowup(
  change: string,
  risk: ReviewRisk,
  planDocsChangedSinceAccept: boolean | null,
): AcceptedMaterialFollowupContinuation {
  return {
    kind: "accepted_material_followup",
    trigger: "material_user_followup",
    reason_source: "summarize_user_input",
    reopen_argv_template: [
      "superspec",
      "transition",
      "reopen",
      "--change",
      change,
      "--to",
      "propose",
      "--reason",
      "{{reason}}",
    ],
    resume: {
      kind: "continue_current_phase",
      instruction: "根据用户补充更新 proposal/specs/design/tasks/test-contract；完成后重新执行 next。",
      next_argv_after_completion: nextArgv(change, risk),
    },
    plan_docs_changed_since_accept: planDocsChangedSinceAccept,
  };
}

export function planNextStep(context: PhasePlanContext): NextStepPlan | null {
  const { change, changeRoot, events, mode, snapshot } = context;

  switch (snapshot.state) {
    case "init":
      if (snapshot.open_jobs.length > 0) {
        return requiredJobs("init", snapshot.open_jobs, `有 ${snapshot.open_jobs.length} 个待完成工作项`);
      }
      return { kind: "run_transition", state: "init", transition: "explore", reason: "初始化完成，开始探索" };

    case "explore": {
      const reopenBaseline = latestReopenExploreBaseline(events);
      if (reopenBaseline && !discoveryDocsChangedSinceBaseline(changeRoot, reopenBaseline)) {
        return {
          kind: "run_transition",
          state: "explore",
          transition: "explore",
          reason: "回到 explore 后至少一个 discovery 材料必须变化",
        };
      }
      const discoveryCheck = validateDiscovery(changeRoot);
      if (!discoveryCheck.ok) {
        const ask: AskUser = {
          question: discoveryCheck.message + "，请处理后继续",
          allowed_answers: ["已处理"],
          scope: "explore_discovery",
        };
        return { kind: "ask_user", state: "explore", ask, reason: discoveryCheck.message };
      }

      const content = readFileSync(join(changeRoot, ".superspec", "artifacts", "discovery.md"), "utf8");
      const currentQuestion = parseDiscoveryOpenQuestions(content)[0];
      if (currentQuestion) {
        const questionText = discoveryOpenQuestionDisplayText(currentQuestion);
        const ask: AskUser = {
          question: `现在有一件事需要你确认：${questionText}\n\n请只回答这一件事。主流程会先登记答复，再将结论回写 discovery.md；回写完成前会继续询问这一件事。`,
          // 用户可以接受建议、选择其他方向或补充事实；状态机不解释答案语义。
          allowed_answers: [],
          scope: discoveryOpenQuestionScope(currentQuestion, currentExploreRoundId(events)),
        };
        return { kind: "ask_user", state: "explore", ask, reason: "等待用户确认" };
      }

      // 先让用户澄清当前 Discovery，再审查材料；否则 critic 会审查一份仍有
      // 关键业务未知的文档。正常创建的 job 已绑定 discovery 指纹，材料变化后
      // 会由 snapshot freshness 自动失效。
      const exploreReviewJobs = EXPLORE_DISCOVERY_REVIEW_GATE.openJobsForGate(snapshot);
      if (exploreReviewJobs.length > 0) {
        return requiredJobs("explore", exploreReviewJobs, `有 ${exploreReviewJobs.length} 个待完成探索审查工作项`);
      }

      const requiredRoles = EXPLORE_DISCOVERY_REVIEW_GATE.requiredRolesForRisk(mode.risk);
      if (!reviewGatePlan(snapshot, events, changeRoot, EXPLORE_DISCOVERY_REVIEW_GATE, requiredRoles)) {
        const confirmation = phaseConfirmationStep(context, "explore_to_propose", "探索完成，等待用户确认进入计划阶段");
        if (confirmation) return confirmation;
      }

      return {
        kind: "run_transition",
        state: "explore",
        transition: "explore",
        reason: "探索完成，推进到计划阶段",
        risk: mode.risk,
      };
    }

    case "propose": {
      const openQuestions = collectProposeOpenQuestions(changeRoot);
      if (openQuestions.openCount > 0) {
        const files = openQuestions.files.map(f => `${f.path}(${f.openCount})`).join(", ");
        const ask: AskUser = {
          question: `计划文档有 ${openQuestions.openCount} 个待用户确认问题：${files}。请确认并更新计划文档后继续`,
          allowed_answers: ["所有问题已确认"],
          scope: "propose_open_questions",
        };
        return { kind: "ask_user", state: "propose", ask, reason: `有 ${openQuestions.openCount} 个 propose 未确认问题` };
      }

      const proposalReviewJobs = PROPOSE_FINAL_REVIEW_GATE.openJobsForGate(snapshot);
      if (proposalReviewJobs.length > 0) {
        return requiredJobs("propose", proposalReviewJobs, `有 ${proposalReviewJobs.length} 个待完成 proposal 审查工作项`);
      }

      return {
        kind: "run_transition",
        state: "propose",
        transition: "propose-ready",
        reason: "计划文档就绪，提交 propose-ready",
        risk: mode.risk,
      };
    }

    case "propose_ready": {
      const proposalReviewJobs = PROPOSE_FINAL_REVIEW_GATE.openJobsForGate(snapshot);
      if (proposalReviewJobs.length > 0) {
        return requiredJobs("propose_ready", proposalReviewJobs, `有 ${proposalReviewJobs.length} 个待完成 proposal 审查工作项`);
      }
      const startApplyPlan = planStartApplyTransition(context, false);
      if (startApplyPlan.kind === "advance") {
        const confirmation = phaseConfirmationStep(context, "propose_to_apply", "计划阶段完成，等待用户确认开始实现");
        if (confirmation) return confirmation;
      }
      // 尚未获得用户确认时，按本次 next 的候选风险预检失败不能退回默认 strict
      // 的 start-apply 命令；否则 normal/minimal 的策略不匹配会被静默改写为 strict。
      if (startApplyPlan.kind === "skip") {
        const ask: AskUser = {
          question: `${startApplyPlan.message}。请更新计划材料后重新执行 next。`,
          allowed_answers: ["计划已更新"],
          scope: "propose_apply_preflight",
        };
        return { kind: "ask_user", state: "propose_ready", ask, reason: startApplyPlan.message };
      }
      return { kind: "run_transition", state: "propose_ready", transition: "start-apply", reason: "计划就绪，开始执行" };
    }

    case "apply":
      return planApplyNext(context);

    case "apply_done":
      return planApplyDoneNext(context);

    case "review":
      return planReviewNext(context);

    case "accepted":
      if (snapshot.open_jobs.length > 0) {
        return requiredJobs("accepted", snapshot.open_jobs, `有 ${snapshot.open_jobs.length} 个待完成工作项，暂不结束流程`);
      }
      {
        const acceptedBaseline = latestAcceptedProposalBaseline(events);
        const planDocsChanged = acceptedBaseline
          ? proposalDocsChangedSinceBaseline(changeRoot, acceptedBaseline)
          : null;
        const driftNote = planDocsChanged === true
          ? "检测到 accepted 后计划材料已变化；当前完成结论仍对应 accepted 时冻结的版本。"
          : "";
        return {
          kind: "done",
          state: "accepted",
          reason: `${driftNote}审查已接受，流程完成；后续若使用者补充或修改需求、方案、验收或实现约束，按 continuation 自动回到 propose 后继续，不得要求使用者执行工作流命令`,
          continuation: acceptedMaterialFollowup(change, mode.risk, planDocsChanged),
        };
      }

    case "archive":
      if (snapshot.open_jobs.length > 0) {
        return requiredJobs("archive", snapshot.open_jobs, `历史 archive 状态仍有 ${snapshot.open_jobs.length} 个待完成工作项`);
      }
      return { kind: "done", state: "archive", reason: "历史 archive 状态，流程已结束。" };

    case "abandoned":
      return { kind: "done", state: "abandoned", reason: "变更已放弃，流程终止。" };

    default:
      return null;
  }
}

function planApplyNext(context: PhasePlanContext): NextStepPlan {
  const { change, changeRoot, events, mode, projectRoot, snapshot } = context;
  if (snapshot.open_jobs.length > 0) {
    return requiredJobs("apply", snapshot.open_jobs, `有 ${snapshot.open_jobs.length} 个待完成工作项`);
  }

  const pendingStatus = pendingTaskStatusForApply(changeRoot, events);
  const pending = pendingStatus.pending;
  if (pending.length > 0) {
    const activePending = snapshot.active_task_attempts.find(attempt =>
      attempt.state === "active" && pending.includes(attempt.task_id)
    );
    if (activePending) {
      const readiness = taskEvidenceReadiness(projectRoot, change, changeRoot, activePending);
      if (readiness.ready) {
        return {
          kind: "run_transition",
          state: "apply",
          transition: "task-complete",
          taskId: activePending.task_id,
          reason: `任务 ${activePending.task_id} 证据已登记，可以完成`,
        };
      }
      const ask: AskUser = {
        question: `任务 ${activePending.task_id} 已开始，请先登记 ${readiness.missing.join("、")} 后继续`,
        allowed_answers: ["证据已登记"],
        scope: `apply_active_task_${activePending.task_id}`,
      };
      return { kind: "ask_user", state: "apply", ask, reason: `任务 ${activePending.task_id} 缺少完成证据` };
    }
    return {
      kind: "run_transition",
      state: "apply",
      transition: "task-start",
      taskId: pending[0],
      reason: `执行中：下一个未完成任务 ${pending[0]}`,
    };
  }

  return {
    kind: "run_transition",
    state: "apply",
    transition: "review-ready",
    risk: mode.risk,
    reason: "所有任务完成，进入审查",
  };
}

export function blockingJobsForApplyDone(
  projectRoot: string,
  events: Event[],
  snapshot: Snapshot,
): Job[] {
  const facts = collectCodeReviewGateFacts(events);
  const currentWorkingPaths = currentCodeReviewWorkingPaths(projectRoot, events);
  const freshCodeReviewJobIds = new Set(
    facts.openJobs
      .filter(job => codeReviewJobStaleReason(projectRoot, job, currentWorkingPaths) == null)
      .map(job => job.job_id),
  );
  return snapshot.open_jobs.filter(job =>
    job.role !== "code-reviewer" || freshCodeReviewJobIds.has(job.job_id)
  );
}

function planApplyDoneNext(context: PhasePlanContext): NextStepPlan {
  const { change, changeRoot, events, mode, snapshot } = context;
  const pendingTasks = pendingTaskStatusForApply(changeRoot, events).pending;
  if (pendingTasks.length > 0) {
    return {
      kind: "run_transition",
      state: "apply_done",
      transition: "reopen",
      reopen: { to: "apply", reason: "pending_tasks", taskIds: pendingTasks },
      reason: `发现未完成任务 ${pendingTasks[0]}，回到执行阶段`,
    };
  }

  const facts = collectCodeReviewGateFacts(events);
  const currentWorkingPaths = currentCodeReviewWorkingPaths(context.projectRoot, events);
  const relevantOpenJobs = blockingJobsForApplyDone(context.projectRoot, events, snapshot);
  if (relevantOpenJobs.length > 0) {
    return requiredJobs("apply_done", relevantOpenJobs, `有 ${relevantOpenJobs.length} 个待完成工作项`);
  }

  const latest = facts.latestTerminal;
  if (latest?.state === "rejected" && latest.result_kind === "review_failed") {
    const status = latestCodeReviewFailedStatus(events);
    const pendingFinding = status?.unresolved[0] ?? null;
    if (status && status.findings.length > 0 && !pendingFinding) {
      return {
        kind: "run_transition",
        state: "apply_done",
        transition: "review-ready",
        risk: mode.risk,
        reason: "代码审查问题已被主流程复核驳回，重新发起代码审查",
      };
    }

    const findingId = pendingFinding?.id ?? "";
    const type = pendingFinding?.type;
    const decision = pendingFinding?.decision;
    if (findingId && type === "implementation") {
      return {
        kind: "run_transition",
        state: "apply_done",
        transition: "reopen",
        reopen: {
          to: "apply",
          reason: "review_fix",
          jobId: latest.job.job_id,
          findingId,
          reopenReason: `修复代码审查问题 ${findingId}`,
        },
        reason: `代码审查发现纯代码实现问题 ${findingId}，回到实现阶段修复`,
      };
    }

    if (findingId && (type === "spec" || type === "mixed")) {
      if (decision?.answer === "reopen_propose") {
        return {
          kind: "run_transition",
          state: "apply_done",
          transition: "reopen",
          reopen: { to: "propose", reason: "review_finding", jobId: latest.job.job_id, findingId },
          reason: `使用者已确认问题 ${findingId} 需要回到计划阶段`,
        };
      }
      if (decision?.answer === "reopen_apply") {
        return {
          kind: "run_transition",
          state: "apply_done",
          transition: "reopen",
          reopen: {
            to: "apply",
            reason: "review_fix",
            jobId: latest.job.job_id,
            findingId,
            reopenReason: `根据代码审查问题 ${findingId} 回到实现阶段修复`,
          },
          reason: `使用者已确认问题 ${findingId} 直接回到实现阶段修复`,
        };
      }
      const problemKind = type === "spec"
        ? "方案或需求文档可能需要调整"
        : "代码实现和方案文档都可能有关";
      const ask: AskUser = {
        question: `代码审查发现问题 ${findingId}：${problemKind}。请选择回到计划阶段修改文档、确认现有文档方向不变并回到实现阶段修代码，或驳回该问题；无论选择哪一项都必须写明原因。`,
        allowed_answers: [
          CODE_REVIEW_DECISION_ANSWER_LABELS.reopen_propose,
          CODE_REVIEW_DECISION_ANSWER_LABELS.reopen_apply,
          CODE_REVIEW_DECISION_ANSWER_LABELS.dismiss,
        ],
        scope: codeReviewDecisionScope(latest.job.job_id, findingId),
      };
      return { kind: "ask_user", state: "apply_done", ask, reason: `代码审查发现需要使用者判断的问题 ${findingId}` };
    }

    const ask: AskUser = {
      question: "代码审查报告里缺少可用于处理问题的编号或分类。请修正审查报告后重新执行 review-ready。",
      allowed_answers: ["报告已修正"],
      scope: `${CODE_REVIEW_REPAIR_SCOPE_PREFIX}${change}`,
    };
    return { kind: "ask_user", state: "apply_done", ask, reason: "代码审查报告中的阻塞问题无法处理" };
  }

  if (
    latest?.state === "rejected" &&
    (latest.result_kind === "invalid_report" || latest.result_kind === "non_actionable_report") &&
    facts.consecutiveRejected >= 2
  ) {
    const ask: AskUser = {
      question: "代码审查报告连续两次不符合要求，或者没有给出可处理的问题。请先修正报告生成方式、模板或审查口径；修正后仍可显式执行 review-ready。",
      allowed_answers: ["已修正"],
      scope: `${CODE_REVIEW_REPAIR_SCOPE_PREFIX}${change}`,
    };
    return { kind: "ask_user", state: "apply_done", ask, reason: "代码审查报告连续不符合要求或没有可处理问题" };
  }

  const codeScan = scanCodeChangesForReview(context.projectRoot, events);
  const acceptedScope = latest?.state === "accepted"
    ? latest.job.packet_context?.code_review_scope
    : undefined;
  const acceptedCurrentHead = acceptedScope?.current_head;
  const acceptedReviewReady = latest?.state === "accepted" &&
    codeReviewJobStaleReason(context.projectRoot, latest.job, currentWorkingPaths) == null && (
    acceptedCurrentHead === null ||
    (typeof acceptedCurrentHead === "string" && acceptedCurrentHead.trim() !== "")
  );
  if (!codeScan.hasCodeChanges || acceptedReviewReady) {
    const confirmation = phaseConfirmationStep(context, "apply_to_review", "Apply 与代码审查完成，等待用户确认进入最终审查");
    if (confirmation) return confirmation;
  }

  return {
    kind: "run_transition",
    state: "apply_done",
    transition: "review-ready",
    risk: mode.risk,
    reason: "所有任务完成，进入审查",
  };
}

function planReviewNext(context: PhasePlanContext): NextStepPlan {
  const { changeRoot, events, mode, projectRoot, snapshot } = context;
  const pending = pendingTaskStatusForApply(changeRoot, events).pending;
  if (pending.length > 0) {
    return {
      kind: "run_transition",
      state: "review",
      transition: "reopen",
      reopen: { to: "apply", reason: "pending_tasks", taskIds: pending },
      reason: `发现未完成任务 ${pending[0]}，回到执行阶段`,
    };
  }

  const reviewVerifierJobs = snapshot.open_jobs.filter(isReviewReadyVerifier);
  if (reviewVerifierJobs.length > 0) {
    return requiredJobs("review", reviewVerifierJobs, `有 ${reviewVerifierJobs.length} 个待完成最终验证工作项`);
  }

  const policy = readReviewPolicyFromEvents(events);
  if (!policy) {
    return {
      kind: "run_transition",
      state: "review",
      transition: "review-ready",
      risk: mode.risk,
      reason: "缺少审查策略，先补 review-ready",
    };
  }

  if (requiresFinalVerifierForCurrentReview(events) || policy.requires_verifier) {
    const currentEvidenceDigest = reviewEvidenceDigest(events);
    const verifierAccepted = snapshot.accepted_jobs.find(job => isFreshReviewVerifier(job, changeRoot, currentEvidenceDigest, projectRoot, events));
    if (!verifierAccepted) {
      return {
        kind: "run_transition",
        state: "review",
        transition: "review-ready",
        risk: mode.risk,
        reason: "最终验证已经缺失或不再匹配当前证据，先补最终验证",
      };
    }
  }

  return { kind: "run_transition", state: "review", transition: "accept", reason: "审查完成，提交接受" };
}

export function planTransition(name: "explore" | "propose-ready" | "start-apply" | "accept", context: TransitionPlanContext): TransitionDecisionPlan {
  switch (name) {
    case "explore":
      return planExploreTransition(context);
    case "propose-ready":
      return planProposeReadyTransition(context);
    case "start-apply":
      return planStartApplyTransition(context);
    case "accept":
      return planAcceptTransition(context);
  }
}

function planExploreTransition(context: TransitionPlanContext): TransitionDecisionPlan {
  const { changeRoot, events, mode, projectRoot, snapshot } = context;
  if (snapshot.state === "init") {
    return { kind: "advance", fromState: "init", toState: "explore", reason: "进入探索阶段" };
  }
  if (snapshot.state !== "explore") {
    return { kind: "skip", message: `当前状态 ${snapshot.state}，explore 不适用` };
  }

  const reopenBaseline = latestReopenExploreBaseline(events);
  if (reopenBaseline && !discoveryDocsChangedSinceBaseline(changeRoot, reopenBaseline)) {
    return { kind: "skip", message: "回到 explore 后至少一个 discovery 材料必须变化" };
  }

  const discoveryCheck = validateDiscovery(changeRoot);
  if (!discoveryCheck.ok) return { kind: "skip", message: discoveryCheck.message };

  const discoveryContent = readFileSync(join(changeRoot, ".superspec", "artifacts", "discovery.md"), "utf8");
  const currentQuestion = parseDiscoveryOpenQuestions(discoveryContent)[0];
  if (currentQuestion) {
    return { kind: "skip", message: "discovery.md 仍有需要确认的事项，请先完成确认并回写 discovery.md" };
  }

  const requiredRoles = EXPLORE_DISCOVERY_REVIEW_GATE.requiredRolesForRisk(mode.risk);
  const gatePlan = reviewGatePlan(snapshot, events, changeRoot, EXPLORE_DISCOVERY_REVIEW_GATE, requiredRoles);
  if (gatePlan) return gatePlan;

  const confirmation = phaseConfirmationForBoundary(projectRoot, events, snapshot, "explore_to_propose", mode.risk);
  const decision = confirmation ? latestAcceptedPhaseDecision(events, confirmation) : null;
  if (!confirmation || decision?.decision !== "advance") {
    return { kind: "skip", message: confirmation ? phaseConfirmationMissingMessage(confirmation) : "无法建立 Explore 阶段确认范围" };
  }
  return {
    kind: "advance",
    fromState: "explore",
    toState: "propose",
    reason: "探索完成",
    payload: {
      ...phaseConfirmationCommitPayload(confirmation, decision),
      planning_validation_version: 2,
      planning_validation_profile: planningValidationProfileForNewRound(projectRoot),
    },
  };
}

function planProposeReadyTransition(context: TransitionPlanContext): TransitionDecisionPlan {
  const { changeRoot, mode, snapshot } = context;
  const risk = mode.risk;
  if (snapshot.state !== "propose") return { kind: "skip", message: `当前状态 ${snapshot.state}，不能 propose-ready` };
  const planningProfile = planningValidationProfileForPendingProposeRound(context.events);

  const preflight = validatePlanningPreflight(
    context.projectRoot,
    context.change,
    changeRoot,
    risk,
    executionPolicyForRisk(risk),
    planningProfile,
  );
  if (preflight.error) return { kind: "skip", message: preflight.error };

  const openQuestions = collectProposeOpenQuestions(changeRoot);
  if (openQuestions.openCount > 0) {
    const files = openQuestions.files.map(f => `${f.path}(${f.openCount})`).join(", ");
    return { kind: "skip", message: `计划文档有 ${openQuestions.openCount} 个待用户确认问题：${files}` };
  }

  const requiredRoles = PROPOSE_FINAL_REVIEW_GATE.requiredRolesForRisk(risk);
  const gatePlan = reviewGatePlan(snapshot, context.events, changeRoot, PROPOSE_FINAL_REVIEW_GATE, requiredRoles);
  if (gatePlan) return gatePlan;

  return {
    kind: "advance",
    fromState: "propose",
    toState: "propose_ready",
    reason: `risk=${risk}，所有需求已满足`,
    payload: {
      workflow_mode: risk,
      ...(planningProfile ? {
        execution_requirement_version: 2,
        planning_validation_version: 2,
        planning_validation_profile: planningProfile,
      } : {}),
    },
  };
}

function acceptedProposeToApplyConfirmation(context: TransitionPlanContext, risk: ReviewRisk) {
  const confirmation = phaseConfirmationForBoundary(
    context.projectRoot,
    context.events,
    context.snapshot,
    "propose_to_apply",
    risk,
  );
  const decision = confirmation ? latestAcceptedPhaseDecision(context.events, confirmation) : null;
  return confirmation && decision?.decision === "advance" ? { confirmation, decision } : null;
}

function planStartApplyTransition(
  context: TransitionPlanContext,
  enforceConfirmation = true,
): TransitionDecisionPlan {
  const { changeRoot, events, projectRoot, snapshot } = context;
  if (snapshot.state !== "propose_ready") return { kind: "skip", message: `当前状态 ${snapshot.state}，需要 propose_ready` };

  const reopenBaseline = latestReopenProposeBaseline(events);
  if (reopenBaseline && !proposalDocsChangedSinceBaseline(changeRoot, reopenBaseline)) {
    // 按基线实际键名提示：升级前留下的旧基线可能不含 specs/，静态清单会误导
    return { kind: "skip", message: `回到 propose 后至少一个计划文档必须变化（基线绑定：${Object.keys(reopenBaseline).join("、")}）` };
  }

  const risk = workflowRiskForProposeRound(events, context.mode.risk);
  const planningProfile = planningValidationProfileForReadyProposeRound(events);
  const executionRequirementVersion = planningProfile?.version ?? executionRequirementVersionForProposeRound(events);
  const executionPolicy = executionPolicyForRisk(risk);
  const preflight = validatePlanningPreflight(
    projectRoot,
    context.change,
    changeRoot,
    risk,
    executionPolicy,
    planningProfile,
  );
  if (preflight.error) return { kind: "skip", message: preflight.error };

  const requiredRoles = executionRequirementVersion === 2
    ? PROPOSE_FINAL_REVIEW_GATE.requiredRolesForRisk(risk)
    : historicalProposeReadyRoles(events);
  const gatePlan = reviewGatePlan(snapshot, events, changeRoot, PROPOSE_FINAL_REVIEW_GATE, requiredRoles);
  if (gatePlan) {
    return {
      ...gatePlan,
      reason: `进入执行阶段前需要重新完成计划文档审查：${gatePlan.reason}`,
    };
  }

  const acceptedConfirmation = enforceConfirmation
    ? acceptedProposeToApplyConfirmation(context, risk)
    : null;
  if (enforceConfirmation && !acceptedConfirmation) {
    const confirmation = phaseConfirmationForBoundary(projectRoot, events, snapshot, "propose_to_apply", risk);
    return {
      kind: "skip",
      message: confirmation ? phaseConfirmationMissingMessage(confirmation) : "无法建立 Propose 阶段确认范围",
    };
  }
  const gitHead = currentGitHead(projectRoot);
  return {
    kind: "advance",
    fromState: "propose_ready",
    toState: "apply",
    reason: "进入执行阶段",
    payload: {
      apply_start_head: gitHead.head,
      apply_start_head_reason: gitHead.reason,
      apply_contract_mode: preflight.contractMode,
      ...(executionRequirementVersion === 2 ? { execution_requirement_version: 2 } : {}),
      execution_policy: executionPolicy,
      workflow_mode: risk,
      review_policy: {
        review_risk: risk,
        requires_verifier: risk !== "minimal",
      },
      ...(acceptedConfirmation ? phaseConfirmationCommitPayload(
        acceptedConfirmation.confirmation,
        acceptedConfirmation.decision,
      ) : {}),
    },
  };
}

function planAcceptTransition(context: TransitionPlanContext): TransitionDecisionPlan {
  const { changeRoot, events, projectRoot, snapshot } = context;
  if (snapshot.state !== "review") return { kind: "skip", message: `当前状态 ${snapshot.state}，需要 review` };

  const pending = pendingTaskStatusForApply(changeRoot, events).pending;
  if (pending.length > 0) {
    return { kind: "skip", message: formatPendingTaskMessage(pending, "请先 reopen --to apply 继续执行") };
  }

  const policy = readReviewPolicyFromEvents(events);
  if (!policy) return { kind: "skip", message: "缺少审查策略，请先运行 review-ready" };

  if (requiresFinalVerifierForCurrentReview(events) || policy.requires_verifier) {
    const currentEvidenceDigest = reviewEvidenceDigest(events);
    const verifierAccepted = snapshot.accepted_jobs.find(job => isFreshReviewVerifier(job, changeRoot, currentEvidenceDigest, projectRoot, events));
    if (!verifierAccepted) return { kind: "skip", message: "缺少仍然匹配当前证据的最终验证，请先运行 review-ready" };
  }

  return {
    kind: "advance",
    fromState: "review",
    toState: "accepted",
    reason: "审查通过",
    payload: { accepted_baseline_docs: proposalDocsBaseline(changeRoot) },
  };
}
