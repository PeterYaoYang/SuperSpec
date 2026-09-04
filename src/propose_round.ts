import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import {
  collectProposeQuestions,
  parseProposeQuestions,
  proposeQuestionContextFingerprint,
  proposeQuestionDecisionBasisDigest,
  proposeQuestionKey,
  type ProposeQuestion,
} from "./format.ts";
import type { Event, PlanningValidationProfile } from "./types.ts";

const PROPOSE_ANSWER_REGISTRATION_VERSION = 1;

// ===== planning validation profile =====
//
// profile 在进入 propose 的边界事件上冻结，propose-ready 时复制到 propose_ready
// 事件。所有读取方共用这里的判定，避免各处复制一份而在升级时漏改。

export function isPlanningValidationProfile(value: unknown): value is PlanningValidationProfile {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const profile = value as {
    version?: unknown;
    openspec?: { mode?: unknown; config_digest?: unknown };
    design?: { schema_version?: unknown };
  };
  if (profile.version !== 2 || !profile.openspec || typeof profile.openspec !== "object") return false;
  const designValid = profile.design == null
    || profile.design.schema_version === 1
    || profile.design.schema_version === 2;
  return designValid && (profile.openspec.mode === "disabled" ||
    profile.openspec.mode === "strict" && typeof profile.openspec.config_digest === "string");
}

/**
 * 当前 planning round 的冻结 profile：优先取最近一次 propose-ready 写入的快照，
 * 否则取进入 propose 的边界事件。两者都没有时是升级前的 v1 change。
 */
export function planningValidationProfileForCurrentRound(events: readonly Event[]): PlanningValidationProfile | null {
  for (let index = events.length - 1; index >= 0; index--) {
    const event = events[index];
    if (event.event_type !== "transition_commit") continue;
    const payload = event.payload as {
      transition?: unknown;
      to_state?: unknown;
      planning_validation_profile?: unknown;
    };
    const isReady = payload.transition === "propose-ready" && payload.to_state === "propose_ready";
    if (!isReady && !isProposeRoundEntry(event)) continue;
    return isPlanningValidationProfile(payload.planning_validation_profile)
      ? payload.planning_validation_profile
      : null;
  }
  return null;
}

interface ProposeRoundEntry {
  event: Event;
  roundId: string;
}

function isProposeRoundEntry(event: Event): boolean {
  if (event.event_type !== "transition_commit") return false;
  const payload = event.payload as {
    transition?: unknown;
    from_state?: unknown;
    to_state?: unknown;
    reopen_target?: unknown;
  };
  return payload.to_state === "propose" && (
    payload.transition === "explore" && payload.from_state === "explore" ||
    payload.transition === "reopen" && payload.reopen_target === "propose"
  );
}

function currentProposeRoundEntry(events: readonly Event[]): ProposeRoundEntry | null {
  for (let index = events.length - 1; index >= 0; index--) {
    const event = events[index];
    if (isProposeRoundEntry(event)) return { event, roundId: event.event_id };
  }
  return null;
}

export function currentProposeRoundId(events: readonly Event[]): string {
  return currentProposeRoundEntry(events)?.roundId ?? "legacy-propose-round";
}

export function proposeAnswerRegistrationPayload(changeRoot: string): {
  propose_answer_registration: {
    version: number;
    baseline_closed_question_keys: string[];
  };
} {
  return {
    propose_answer_registration: {
      version: PROPOSE_ANSWER_REGISTRATION_VERSION,
      baseline_closed_question_keys: collectProposeQuestions(changeRoot)
        .filter(question => question.status === "closed")
        .map(proposeQuestionKey)
        .sort(),
    },
  };
}

function currentRegistration(events: readonly Event[]): {
  enabled: boolean;
  roundId: string;
  baselineClosedQuestionKeys: Set<string>;
} {
  const entry = currentProposeRoundEntry(events);
  if (!entry) return { enabled: false, roundId: "legacy-propose-round", baselineClosedQuestionKeys: new Set() };
  const payload = entry.event.payload as {
    propose_answer_registration?: {
      version?: unknown;
      baseline_closed_question_keys?: unknown;
    };
  };
  const registration = payload.propose_answer_registration;
  if (registration?.version !== PROPOSE_ANSWER_REGISTRATION_VERSION || !Array.isArray(registration.baseline_closed_question_keys)) {
    return { enabled: false, roundId: entry.roundId, baselineClosedQuestionKeys: new Set() };
  }
  return {
    enabled: true,
    roundId: entry.roundId,
    baselineClosedQuestionKeys: new Set(registration.baseline_closed_question_keys.filter((key): key is string => typeof key === "string")),
  };
}

function questionContent(changeRoot: string, question: ProposeQuestion): string | null {
  const path = join(changeRoot, question.path);
  return existsSync(path) ? readFileSync(path, "utf8") : null;
}

export function proposeAnswerWasRecorded(
  events: readonly Event[],
  roundId: string,
  question: ProposeQuestion,
  content: string,
): boolean {
  const contextFingerprint = proposeQuestionContextFingerprint(content, question);
  if (!contextFingerprint) return false;
  const currentBasisDigest = proposeQuestionDecisionBasisDigest(question);
  return events.some(event => {
    if (event.event_type !== "user_decision_recorded") return false;
    const payload = event.payload as {
      accepted?: unknown;
      propose_open_question?: {
        round_id?: unknown;
        path?: unknown;
        question_id?: unknown;
        question_ordinal?: unknown;
        context_fingerprint?: unknown;
        decision_basis_digest?: unknown;
      };
    };
    const recorded = payload.propose_open_question;
    const revisionMatches = typeof recorded?.decision_basis_digest === "string"
      ? recorded.decision_basis_digest === currentBasisDigest
      : recorded?.context_fingerprint === contextFingerprint;
    return payload.accepted === true &&
      recorded?.round_id === roundId &&
      recorded.path === question.path &&
      recorded.question_id === question.id &&
      (!question.id.startsWith("item-") || recorded.question_ordinal === question.ordinal) &&
      revisionMatches;
  });
}

export function unregisteredClosedProposeQuestions(events: readonly Event[], changeRoot: string): ProposeQuestion[] {
  const registration = currentRegistration(events);
  if (!registration.enabled) return [];
  return collectProposeQuestions(changeRoot).filter(question => {
    if (question.status !== "closed" || registration.baselineClosedQuestionKeys.has(proposeQuestionKey(question))) return false;
    const content = questionContent(changeRoot, question);
    return content != null && !proposeAnswerWasRecorded(events, registration.roundId, question, content);
  });
}

export function currentProposeOpenQuestion(changeRoot: string): ProposeQuestion | null {
  return collectProposeQuestions(changeRoot).find(question => question.status === "open") ?? null;
}

export function currentProposeQuestionContent(changeRoot: string, question: ProposeQuestion): string | null {
  const path = join(changeRoot, question.path);
  if (!existsSync(path)) return null;
  const content = readFileSync(path, "utf8");
  return parseProposeQuestions(content, question.path).some(candidate => candidate.id === question.id && candidate.ordinal === question.ordinal)
    ? content
    : null;
}

/** 已正式展示但尚未登记答复的 Propose 问题不能通过删除问题行绕过。 */
export function unresolvedPresentedProposeQuestionScopes(events: readonly Event[]): string[] {
  const roundId = currentProposeRoundId(events);
  const acceptedDecisions = events.flatMap(event => {
    if (event.event_type !== "user_decision_recorded") return [];
    const payload = event.payload as {
      accepted?: unknown;
      scope?: unknown;
      propose_open_question?: {
        round_id?: unknown;
        path?: unknown;
        question_id?: unknown;
        question_ordinal?: unknown;
        decision_basis_digest?: unknown;
      };
    };
    return payload.accepted === true ? [payload] : [];
  });
  const latestByQuestion = new Map<string, {
    scope: string;
    legacyScope: string | null;
    path: string;
    questionId: string;
    questionOrdinal: unknown;
    revisionDigest: unknown;
  }>();
  for (const event of events) {
    if (event.event_type !== "user_question_presented") continue;
    const payload = event.payload as {
      phase?: unknown;
      round_id?: unknown;
      scope?: unknown;
      legacy_scope?: unknown;
      path?: unknown;
      question_id?: unknown;
      question_ordinal?: unknown;
      decision_basis_digest?: unknown;
    };
    if (payload.phase !== "propose" || payload.round_id !== roundId || typeof payload.scope !== "string" || typeof payload.path !== "string" || typeof payload.question_id !== "string") continue;
    const ordinal = payload.question_id.startsWith("item-") ? `:${String(payload.question_ordinal)}` : "";
    latestByQuestion.set(`${payload.path}:${payload.question_id}${ordinal}`, {
      scope: payload.scope,
      legacyScope: typeof payload.legacy_scope === "string" ? payload.legacy_scope : null,
      path: payload.path,
      questionId: payload.question_id,
      questionOrdinal: payload.question_ordinal,
      revisionDigest: payload.decision_basis_digest,
    });
  }
  return [...latestByQuestion.values()].flatMap(presented => {
    const answered = acceptedDecisions.some(decision => {
      if (decision.scope === presented.scope || decision.scope === presented.legacyScope) return true;
      const recorded = decision.propose_open_question;
      return recorded?.round_id === roundId &&
        recorded.path === presented.path &&
        recorded.question_id === presented.questionId &&
        (!presented.questionId.startsWith("item-") || recorded.question_ordinal === presented.questionOrdinal) &&
        typeof presented.revisionDigest === "string" &&
        recorded.decision_basis_digest === presented.revisionDigest;
    });
    return answered ? [] : [presented.scope];
  });
}
