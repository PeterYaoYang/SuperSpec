import { currentGitHead, dirtyCodeFiles } from "./git_state.ts";
import { reviewEvidenceDigest, type ReviewRisk } from "./review.ts";
import { findLatestEvent, sha256Text } from "./store.ts";
import type { AskUser, AskUserAction, Event, Snapshot, State } from "./types.ts";

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
      payload.from_state === "init" && payload.to_state === "explore"
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

function materialDigest(
  projectRoot: string,
  events: Event[],
  snapshot: Snapshot,
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

  return sha256Text(JSON.stringify({
    documents,
    tasks_structure_digest: snapshot.tasks_structure_digest,
    accepted_jobs: acceptedJobs,
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

function nextArgv(change: string, risk: ReviewRisk): string[] {
  return [
    "superspec",
    "transition",
    "next",
    "--change",
    change,
    ...(risk === "strict" ? [] : ["--risk", risk]),
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
    record_input: { scope, question, answer: spec.label },
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
  const digest = materialDigest(projectRoot, events, snapshot);
  const scope = `${spec.scopePrefix}:${epochEventId}:${digest}`;
  const actions = buildActions(snapshot.change_id, boundary, scope, spec.question, spec.actions, risk);
  return {
    boundary,
    epoch_event_id: epochEventId,
    material_digest: digest,
    scope,
    actions,
    ask: {
      question: spec.question,
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
      phase_confirmation?: { boundary?: unknown; decision?: unknown };
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
    phase_confirmation: { decision: PhaseDecision };
  };
  return {
    event,
    scope: confirmation.scope,
    answer: payload.answer,
    decision: payload.phase_confirmation.decision,
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
    },
  };
}

export function phaseConfirmationMissingMessage(confirmation: PhaseConfirmation): string {
  const answers = confirmation.actions.map(action => action.label).join(" / ");
  return `缺少当前阶段的用户确认；请先执行 next，并按返回的 scope=${confirmation.scope} 精确选择：${answers}`;
}
