import { currentGitHead, dirtyCodeFiles } from "./git_state.ts";
import { reviewEvidenceDigest } from "./review.ts";
import { findLatestEvent, sha256Text } from "./store.ts";
import type { AskUser, Event, Snapshot, State } from "./types.ts";

export const PHASE_CONFIRMATION_SCOPE_PREFIX = "phase_confirmation:";

export type PhaseBoundary =
  | "explore_to_propose"
  | "propose_to_apply"
  | "apply_to_review"
  | "accepted_to_archive";

interface PhaseBoundarySpec {
  state: State;
  answer: string;
  question: string;
  epoch: (events: Event[]) => Event | null;
  scopePrefix: string;
}

export interface PhaseConfirmation {
  boundary: PhaseBoundary;
  epoch_event_id: string;
  material_digest: string;
  scope: string;
  answer: string;
  ask: AskUser;
}

export interface PhaseConfirmationDecision {
  event: Event;
  scope: string;
  answer: string;
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
    answer: "确认进入计划阶段",
    question: "探索与探索审查已完成。只有明确确认进入计划阶段，工作流才会继续生成 Proposal / Specs / Design / Tasks。",
    scopePrefix: `${PHASE_CONFIRMATION_SCOPE_PREFIX}explore_to_propose`,
    epoch: events => latestTransition(events, payload =>
      payload.from_state === "init" && payload.to_state === "explore"
    ),
  },
  propose_to_apply: {
    state: "propose_ready",
    answer: "确认开始实现",
    question: "计划文档与计划审查已完成。只有明确确认开始实现，工作流才会进入 Apply。",
    scopePrefix: `${PHASE_CONFIRMATION_SCOPE_PREFIX}propose_to_apply`,
    epoch: events => latestTransition(events, payload => payload.to_state === "propose_ready"),
  },
  apply_to_review: {
    state: "apply_done",
    answer: "确认进入最终审查",
    question: "实现、测试证据与代码审查已完成。只有明确确认进入最终审查，工作流才会进入 Review。",
    scopePrefix: `${PHASE_CONFIRMATION_SCOPE_PREFIX}apply_to_review`,
    epoch: events => latestTransition(events, payload =>
      payload.from_state === "apply" && payload.to_state === "apply_done"
    ),
  },
  accepted_to_archive: {
    state: "accepted",
    answer: "确认归档",
    question: "最终验证已通过，流程停在 accepted。只有明确确认归档，工作流才会执行不可逆的 Archive。",
    scopePrefix: `${PHASE_CONFIRMATION_SCOPE_PREFIX}accepted_to_archive`,
    epoch: events => latestTransition(events, payload =>
      payload.from_state === "review" && payload.to_state === "accepted"
    ),
  },
};

function boundaryForState(state: State): PhaseBoundary | null {
  switch (state) {
    case "explore": return "explore_to_propose";
    case "propose_ready": return "propose_to_apply";
    case "apply_done": return "apply_to_review";
    case "accepted": return "accepted_to_archive";
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

export function isPhaseConfirmationScope(value: unknown): value is string {
  return typeof value === "string" && value.startsWith(PHASE_CONFIRMATION_SCOPE_PREFIX);
}

export function phaseConfirmationForBoundary(
  projectRoot: string,
  events: Event[],
  snapshot: Snapshot,
  boundary: PhaseBoundary,
): PhaseConfirmation | null {
  const spec = SPECS[boundary];
  if (snapshot.state !== spec.state) return null;
  const epoch = spec.epoch(events);
  const epochEventId = epoch?.event_id ?? `legacy-${spec.state}`;
  const digest = materialDigest(projectRoot, events, snapshot);
  const scope = `${spec.scopePrefix}:${epochEventId}:${digest}`;
  return {
    boundary,
    epoch_event_id: epochEventId,
    material_digest: digest,
    scope,
    answer: spec.answer,
    ask: {
      question: spec.question,
      allowed_answers: [spec.answer],
      scope,
    },
  };
}

export function phaseConfirmationForCurrentState(
  projectRoot: string,
  events: Event[],
  snapshot: Snapshot,
): PhaseConfirmation | null {
  const boundary = boundaryForState(snapshot.state);
  return boundary
    ? phaseConfirmationForBoundary(projectRoot, events, snapshot, boundary)
    : null;
}

export function latestPhaseConfirmationDecision(
  events: Event[],
  confirmation: PhaseConfirmation,
): PhaseConfirmationDecision | null {
  const event = findLatestEvent(events, "user_decision_recorded", candidate => {
    const payload = candidate.payload as { scope?: unknown; answer?: unknown; accepted?: unknown };
    return payload.accepted !== false &&
      payload.scope === confirmation.scope &&
      payload.answer === confirmation.answer;
  });
  return event
    ? { event, scope: confirmation.scope, answer: confirmation.answer }
    : null;
}

export function phaseConfirmationCommitPayload(
  confirmation: PhaseConfirmation,
  decision: PhaseConfirmationDecision,
): Record<string, unknown> {
  return {
    phase_confirmation: {
      boundary: confirmation.boundary,
      epoch_event_id: confirmation.epoch_event_id,
      material_digest: confirmation.material_digest,
      scope: confirmation.scope,
      decision_event_id: decision.event.event_id,
    },
  };
}

export function phaseConfirmationMissingMessage(confirmation: PhaseConfirmation): string {
  return `缺少当前阶段的用户确认；请先执行 next，并按返回的 scope=${confirmation.scope}、answer=${confirmation.answer} 登记 user-decision`;
}
