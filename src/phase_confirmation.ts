import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { currentGitHead, dirtyCodeFiles } from "./git_state.ts";
import { historicalProposeReadyRoles, reviewEvidenceDigest, reviewGateRoleResolution, type ReviewRisk } from "./review.ts";
import { EXPLORE_DISCOVERY_REVIEW_GATE, PROPOSE_FINAL_REVIEW_GATE, type ReviewGateRule } from "./review_job_gates.ts";
import { changeRoot as openspecChangeRoot } from "./openspec.ts";
import { findLatestEvent, sha256Text } from "./store.ts";
import { parseExecutionRequirements, parseTasksMd, parseTestContractEntries, type ParsedTask } from "./format.ts";
import type { AskUser, AskUserAction, Event, JobRole, Snapshot, State } from "./types.ts";
import {
  hasFrozenWorkflowModeForProposeRound,
  workflowRiskForProject,
  workflowRiskForState,
} from "./workflow_config.ts";

export const PHASE_CONFIRMATION_SCOPE_PREFIX = "phase_confirmation:";

export type PhaseBoundary =
  | "explore_to_propose"
  | "propose_to_apply"
  | "apply_to_review";

export type PhaseDecision = "advance" | "stay";

type PhaseActionResumeSpec =
  | { kind: "next" }
  | { kind: "continue_current_phase"; instruction: string }
  | { kind: "stop" };

interface PhaseActionSpec {
  decision: PhaseDecision;
  label: string;
  reason: "none" | "required" | "optional";
  reasonPrompt?: string;
  resume: PhaseActionResumeSpec;
}

interface PhaseBoundarySpec {
  state: State;
  question: string;
  actions: readonly PhaseActionSpec[];
  epoch: (events: Event[]) => Event | null;
  scopePrefix: string;
}

function taskTitle(content: string, task: ParsedTask): string {
  const line = content.split("\n")[task.lineIdx] ?? "";
  return line.replace(/^-\s+\[[ xX]\]\s+\S+\s*/, "").trim() || task.taskId;
}

function taskSummaryField(lines: string[], task: ParsedTask, labels: readonly string[]): string | null {
  for (let index = task.lineIdx + 1; index < lines.length; index++) {
    const line = lines[index];
    if (/^-\s+\[[ xX]\]\s+\S+/.test(line) || /^#{1,6}\s+/.test(line)) break;
    const match = /^\s*-\s*([^:：]+)\s*[:：]\s*(.+?)\s*$/.exec(line);
    if (match && labels.includes(match[1].trim())) return match[2].trim();
  }
  return null;
}

/**
 * 这是阶段确认的临时阅读面，不是新的计划格式或 gate。优先读取 task 已声明的
 * 交付/依赖/验收；缺省项如实标为未声明，避免将任务顺序臆造成真实依赖。
 */
function proposeTaskDeliverySummary(changeRoot: string): string | null {
  const tasksPath = join(changeRoot, "tasks.md");
  if (!existsSync(tasksPath)) return null;
  const tasksContent = readFileSync(tasksPath, "utf8");
  const tasks = parseTasksMd(tasksContent);
  if (tasks.length === 0) return null;

  const contracts = new Map(parseExecutionRequirements(tasksContent).map(item => [item.taskId, item.contract]));
  const testContractPath = join(changeRoot, ".superspec", "artifacts", "test-contract.md");
  const parsedTests = existsSync(testContractPath)
    ? parseTestContractEntries(readFileSync(testContractPath, "utf8"))
    : null;
  const scenarios = parsedTests?.ok
    ? new Map(parsedTests.entries.map(entry => [entry.test_id, entry.scenario]))
    : new Map<string, string>();
  const lines = tasksContent.split("\n");

  // Propose 展示的是当前计划，不是旧 Apply 轮的执行历史。重新打开同一 task 时，
  // 当前 tasks.md 中的未勾选状态明确表示它已重新纳入本轮待实施范围。
  const pendingTasks = tasks.filter(task => !task.done);
  const completedCount = tasks.length - pendingTasks.length;
  const items = pendingTasks.map((task, index) => {
    const contract = contracts.get(task.taskId);
    const explicitDelivery = taskSummaryField(lines, task, ["交付", "Delivery"]);
    const explicitDependency = taskSummaryField(lines, task, ["依赖", "Dependencies", "Depends On"]);
    const firstTest = contract?.tests[0];
    const testScenario = firstTest ? scenarios.get(firstTest) : null;
    const delivery = explicitDelivery ?? contract?.acceptance ?? taskTitle(tasksContent, task);
    const dependency = explicitDependency ?? "无明确前置交付";
    const acceptance = contract?.acceptance
      ?? (testScenario ? `${firstTest}：${testScenario}` : "计划未单独声明验收");
    return [
      `${index + 1}. ${task.taskId} ${taskTitle(tasksContent, task)}`,
      `   - 交付：${delivery}`,
      `   - 依赖：${dependency}`,
      `   - 验收：${acceptance}`,
    ].join("\n");
  });

  const status = completedCount === 0
    ? ""
    : `已完成 ${completedCount} 项；${pendingTasks.length === 0 ? "当前没有待实施任务。" : `以下 ${pendingTasks.length} 项仍待实施或调整。`}\n\n`;
  return `执行计划概览\n\n${status}${items.join("\n\n")}`;
}

export interface PhaseDecisionAction extends AskUserAction {
  boundary: PhaseBoundary;
  decision: PhaseDecision;
}

export interface PhaseConfirmation {
  boundary: PhaseBoundary;
  epoch_event_id: string;
  material_digest: string;
  scope: string;
  actions: PhaseDecisionAction[];
  ask: AskUser;
}

export interface PhaseConfirmationDecision {
  event: Event;
  scope: string;
  answer: string;
  decision: PhaseDecision;
  review_risk: ReviewRisk;
}

function latestTransition(
  events: Event[],
  predicate: (payload: Record<string, unknown>) => boolean,
): Event | null {
  return findLatestEvent(events, "transition_commit", event => predicate(event.payload));
}

const SPECS: Record<PhaseBoundary, PhaseBoundarySpec> = {
  explore_to_propose: {
    state: "explore",
    question: "探索与探索审查已完成，请选择进入计划阶段，或留在探索阶段继续完善。",
    actions: [
      { decision: "advance", label: "确认进入计划阶段", reason: "none", resume: { kind: "next" } },
      {
        decision: "stay",
        label: "留在探索阶段继续完善",
        reason: "required",
        reasonPrompt: "请说明还需要补充或核对哪些探索信息。",
        resume: {
          kind: "continue_current_phase",
          instruction: "根据用户说明继续完善 discovery；完成后重新执行 next。",
        },
      },
    ],
    scopePrefix: `${PHASE_CONFIRMATION_SCOPE_PREFIX}explore_to_propose`,
    epoch: events => latestTransition(events, payload =>
      payload.to_state === "explore" && payload.from_state !== "explore"
    ),
  },
  propose_to_apply: {
    state: "propose_ready",
    question: "计划文档与计划审查已完成，请选择开始实现，或留在计划阶段继续完善。",
    actions: [
      { decision: "advance", label: "确认开始实现", reason: "none", resume: { kind: "next" } },
      {
        decision: "stay",
        label: "留在计划阶段继续完善",
        reason: "required",
        reasonPrompt: "请说明还需要调整哪些计划内容。",
        resume: {
          kind: "continue_current_phase",
          instruction: "根据用户说明继续完善绑定计划材料；完成后重新执行 next。",
        },
      },
    ],
    scopePrefix: `${PHASE_CONFIRMATION_SCOPE_PREFIX}propose_to_apply`,
    epoch: events => latestTransition(events, payload => payload.to_state === "propose_ready"),
  },
  apply_to_review: {
    state: "apply_done",
    question: "实现、测试证据与代码审查已完成，请选择进入最终审查，或暂不进入最终审查。",
    actions: [
      { decision: "advance", label: "确认进入最终审查", reason: "none", resume: { kind: "next" } },
      { decision: "stay", label: "暂不进入最终审查", reason: "optional", resume: { kind: "stop" } },
    ],
    scopePrefix: `${PHASE_CONFIRMATION_SCOPE_PREFIX}apply_to_review`,
    epoch: events => latestTransition(events, payload =>
      payload.from_state === "apply" && payload.to_state === "apply_done"
    ),
  },
};

function boundaryForState(state: State): PhaseBoundary | null {
  switch (state) {
    case "explore": return "explore_to_propose";
    case "propose_ready": return "propose_to_apply";
    case "apply_done": return "apply_to_review";
    default: return null;
  }
}

function ordinaryReviewRolesForBoundary(
  events: Event[],
  boundary: PhaseBoundary,
  gate: ReviewGateRule,
  risk: ReviewRisk,
): JobRole[] {
  // 历史 plan 没有冻结 mode，当时的 gate 只能按实际创建过的角色回放。
  if (boundary === "propose_to_apply" && !hasFrozenWorkflowModeForProposeRound(events)) {
    return historicalProposeReadyRoles(events);
  }
  return gate.requiredRolesForRisk(risk);
}

/**
 * 阶段确认不是 mode 的输入。它只读取当前 planning/apply round 的冻结快照；
 * 仍处于 Explore/Propose 时才从项目配置获取候选 mode。
 */
export function workflowRiskForPhaseConfirmation(
  projectRoot: string,
  events: Event[],
  snapshot: Snapshot,
): ReviewRisk {
  return workflowRiskForState(events, snapshot.state, workflowRiskForProject(projectRoot));
}

function materialDigest(
  projectRoot: string,
  events: Event[],
  snapshot: Snapshot,
  boundary: PhaseBoundary,
  risk: ReviewRisk,
): string {
  const head = currentGitHead(projectRoot);
  const dirty = dirtyCodeFiles(projectRoot);
  const acceptedJobs = snapshot.accepted_jobs
    .map(job => ({
      job_id: job.job_id,
      role: job.role,
      gate_id: job.gate_id ?? null,
      packet_digest: job.packet_digest,
      review_evidence_digest: job.review_evidence_digest ?? null,
    }))
    .sort((a, b) => a.job_id.localeCompare(b.job_id));
  const documents = Object.entries(snapshot.document_digests)
    .sort(([left], [right]) => left.localeCompare(right));
  const ordinaryReviewGate: ReviewGateRule | null = boundary === "explore_to_propose"
    ? EXPLORE_DISCOVERY_REVIEW_GATE
    : boundary === "propose_to_apply"
      ? PROPOSE_FINAL_REVIEW_GATE
      : null;
  const currentChangeRoot = openspecChangeRoot(projectRoot, snapshot.change_id);
  const overriddenReviewJobs = ordinaryReviewGate
    ? ordinaryReviewRolesForBoundary(events, boundary, ordinaryReviewGate, risk)
      .map(role => reviewGateRoleResolution(
        events,
        currentChangeRoot,
        ordinaryReviewGate,
        role,
      ))
      .filter(resolution => resolution.kind === "overridden")
      .map(resolution => ({
        job_id: resolution.override.job_id,
        role: resolution.override.role,
        gate_id: resolution.override.gate_id,
        packet_digest: resolution.override.packet_digest,
        decision_event_id: resolution.override.decision_event_id,
        decision_event_digest: resolution.override.decision_event_digest,
      }))
      .sort((left, right) => `${left.gate_id}\u0000${left.role}\u0000${left.job_id}`.localeCompare(
        `${right.gate_id}\u0000${right.role}\u0000${right.job_id}`,
      ))
    : [];

  return sha256Text(JSON.stringify({
    review_risk: risk,
    documents,
    tasks_structure_digest: snapshot.tasks_structure_digest,
    accepted_jobs: acceptedJobs,
    ...(overriddenReviewJobs.length > 0 ? { overridden_review_jobs: overriddenReviewJobs } : {}),
    review_evidence_digest: reviewEvidenceDigest(events),
    code_state: {
      head: head.head,
      head_reason: head.reason,
      dirty_files: dirty.files,
      ...(dirty.ok ? {} : { dirty_files_reason: dirty.reason }),
    },
  }));
}

function phaseRecordArgv(change: string): string[] {
  return ["superspec", "record", "user-decision", "--change", change, "--input", "-"];
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

function buildActions(
  change: string,
  boundary: PhaseBoundary,
  scope: string,
  question: string,
  specs: readonly PhaseActionSpec[],
  risk: ReviewRisk,
): PhaseDecisionAction[] {
  if (specs.length < 2) throw new Error(`${boundary} 至少需要两个 phase actions`);
  const labels = new Set<string>();
  for (const spec of specs) {
    if (labels.has(spec.label)) throw new Error(`${boundary} 存在重复 action label：${spec.label}`);
    labels.add(spec.label);
  }
  if (!specs.some(action => action.decision === "advance")) {
    throw new Error(`${boundary} 缺少 advance action`);
  }
  if (!specs.some(action => action.decision === "stay")) {
    throw new Error(`${boundary} 缺少 stay action`);
  }

  return specs.map(spec => ({
    boundary,
    decision: spec.decision,
    label: spec.label,
    selection: "exact_label",
    reason: spec.reason,
    ...(spec.reasonPrompt ? { reason_prompt: spec.reasonPrompt } : {}),
    record_argv: phaseRecordArgv(change),
    record_input: { scope, question, answer: spec.label, review_risk: risk },
    resume: spec.resume.kind === "next"
      ? { kind: "next", argv: nextArgv(change, risk) }
      : spec.resume.kind === "continue_current_phase"
        ? {
            kind: "continue_current_phase",
            instruction: spec.resume.instruction,
            next_argv_after_completion: nextArgv(change, risk),
          }
        : { kind: "stop" },
  }));
}

export function isPhaseConfirmationScope(value: unknown): value is string {
  return typeof value === "string" && value.startsWith(PHASE_CONFIRMATION_SCOPE_PREFIX);
}

export function phaseConfirmationForBoundary(
  projectRoot: string,
  events: Event[],
  snapshot: Snapshot,
  boundary: PhaseBoundary,
  risk: ReviewRisk = "strict",
): PhaseConfirmation | null {
  const spec = SPECS[boundary];
  if (snapshot.state !== spec.state) return null;
  const epoch = spec.epoch(events);
  const epochEventId = epoch?.event_id ?? `legacy-${spec.state}`;
  const digest = materialDigest(projectRoot, events, snapshot, boundary, risk);
  const scope = `${spec.scopePrefix}:${epochEventId}:${digest}`;
  const summary = boundary === "propose_to_apply"
    ? proposeTaskDeliverySummary(openspecChangeRoot(projectRoot, snapshot.change_id))
    : null;
  const question = summary ? `${summary}\n\n${spec.question}` : spec.question;
  const actions = buildActions(snapshot.change_id, boundary, scope, question, spec.actions, risk);
  return {
    boundary,
    epoch_event_id: epochEventId,
    material_digest: digest,
    scope,
    actions,
    ask: {
      question,
      allowed_answers: actions.map(action => action.label),
      scope,
      actions,
    },
  };
}

export function phaseConfirmationForCurrentState(
  projectRoot: string,
  events: Event[],
  snapshot: Snapshot,
  risk: ReviewRisk = "strict",
): PhaseConfirmation | null {
  const boundary = boundaryForState(snapshot.state);
  return boundary
    ? phaseConfirmationForBoundary(projectRoot, events, snapshot, boundary, risk)
    : null;
}

export function phaseActionForAnswer(
  confirmation: PhaseConfirmation,
  answer: unknown,
): PhaseDecisionAction | null {
  return typeof answer === "string"
    ? confirmation.actions.find(action => action.label === answer) ?? null
    : null;
}

export function latestAcceptedPhaseDecision(
  events: Event[],
  confirmation: PhaseConfirmation,
): PhaseConfirmationDecision | null {
  const event = findLatestEvent(events, "user_decision_recorded", candidate => {
    const payload = candidate.payload as {
      scope?: unknown;
      answer?: unknown;
      accepted?: unknown;
      phase_confirmation?: { boundary?: unknown; decision?: unknown; review_risk?: unknown };
    };
    const phase = payload.phase_confirmation;
    return payload.accepted !== false &&
      payload.scope === confirmation.scope &&
      phase?.boundary === confirmation.boundary &&
      (phase.decision === "advance" || phase.decision === "stay");
  });
  if (!event) return null;
  const payload = event.payload as {
    answer: string;
    phase_confirmation: { decision: PhaseDecision; review_risk?: unknown };
  };
  return {
    event,
    scope: confirmation.scope,
    answer: payload.answer,
    decision: payload.phase_confirmation.decision,
    review_risk: payload.phase_confirmation.review_risk === "minimal" ||
      payload.phase_confirmation.review_risk === "normal" ||
      payload.phase_confirmation.review_risk === "strict"
      ? payload.phase_confirmation.review_risk
      : "strict",
  };
}

export function isPhaseAdvanceAuthorized(
  events: Event[],
  confirmation: PhaseConfirmation,
): boolean {
  return latestAcceptedPhaseDecision(events, confirmation)?.decision === "advance";
}

export function phaseConfirmationCommitPayload(
  confirmation: PhaseConfirmation,
  decision: PhaseConfirmationDecision,
): Record<string, unknown> {
  if (decision.decision !== "advance") {
    throw new Error(`${confirmation.boundary} 的 stay decision 不能写入阶段推进 commit`);
  }
  return {
    phase_confirmation: {
      boundary: confirmation.boundary,
      decision: decision.decision,
      epoch_event_id: confirmation.epoch_event_id,
      material_digest: confirmation.material_digest,
      scope: confirmation.scope,
      decision_event_id: decision.event.event_id,
      review_risk: decision.review_risk,
    },
  };
}

export function phaseConfirmationMissingMessage(confirmation: PhaseConfirmation): string {
  const answers = confirmation.actions.map(action => action.label).join(" / ");
  return `缺少当前阶段的用户确认；请先执行 next，并按返回的 scope=${confirmation.scope} 精确选择：${answers}`;
}
