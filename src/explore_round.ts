import {
  discoveryQuestionContextFingerprint,
  discoveryQuestionDecisionBasisDigest,
  discoveryQuestionKey,
  parseDiscoveryQuestions,
  type DiscoveryQuestion,
} from "./format.ts";
import type { Event } from "./types.ts";

const EXPLORE_ANSWER_REGISTRATION_VERSION = 1;

interface ExploreRoundEntry {
  event: Event;
  roundId: string;
}

interface ExploreAnswerRegistration {
  enabled: boolean;
  roundId: string;
  baselineClosedQuestionKeys: Set<string>;
}

function isExploreRoundEntry(event: Event): boolean {
  if (event.event_type !== "transition_commit") return false;
  const payload = event.payload as {
    transition?: unknown;
    from_state?: unknown;
    to_state?: unknown;
    reopen_target?: unknown;
  };
  return payload.transition === "explore" && payload.from_state === "init" && payload.to_state === "explore" ||
    payload.transition === "reopen" && payload.reopen_target === "explore";
}

function currentExploreRoundEntry(events: readonly Event[]): ExploreRoundEntry | null {
  for (let index = events.length - 1; index >= 0; index--) {
    const event = events[index];
    if (isExploreRoundEntry(event)) return { event, roundId: event.event_id };
  }
  return null;
}

/**
 * 当前 Explore 轮次的稳定标识。
 *
 * 同一轮内补充调查或创建审查工作项不会使当前确认事项失效；只有首次进入
 * Explore 或从后续阶段重新打开 Explore 时，才开始新的确认轮次。
 */
export function currentExploreRoundId(events: readonly Event[]): string {
  return currentExploreRoundEntry(events)?.roundId ?? "legacy-explore-round";
}

/** 在进入新 Explore 轮次时冻结已有已确认事项，避免升级时追溯历史答复。 */
export function exploreAnswerRegistrationPayload(discoveryContent: string | null): {
  explore_answer_registration: {
    version: number;
    baseline_closed_question_keys: string[];
  };
} {
  const baselineClosedQuestionKeys = discoveryContent == null
    ? []
    : parseDiscoveryQuestions(discoveryContent)
      .filter(question => question.status === "closed")
      .map(discoveryQuestionKey)
      .sort();
  return {
    explore_answer_registration: {
      version: EXPLORE_ANSWER_REGISTRATION_VERSION,
      baseline_closed_question_keys: baselineClosedQuestionKeys,
    },
  };
}

function currentExploreAnswerRegistration(events: readonly Event[]): ExploreAnswerRegistration {
  const entry = currentExploreRoundEntry(events);
  if (!entry) {
    return {
      enabled: false,
      roundId: "legacy-explore-round",
      baselineClosedQuestionKeys: new Set(),
    };
  }
  const payload = entry.event.payload as {
    explore_answer_registration?: {
      version?: unknown;
      baseline_closed_question_keys?: unknown;
    };
  };
  const registration = payload.explore_answer_registration;
  if (registration?.version !== EXPLORE_ANSWER_REGISTRATION_VERSION || !Array.isArray(registration.baseline_closed_question_keys)) {
    return {
      enabled: false,
      roundId: entry.roundId,
      baselineClosedQuestionKeys: new Set(),
    };
  }
  return {
    enabled: true,
    roundId: entry.roundId,
    baselineClosedQuestionKeys: new Set(registration.baseline_closed_question_keys.filter((key): key is string => typeof key === "string")),
  };
}

/** 当前确认事项已通过本轮主流程登记过答复。 */
export function exploreAnswerWasRecorded(
  events: readonly Event[],
  roundId: string,
  question: Pick<DiscoveryQuestion, "id" | "ordinal" | "text">,
  discoveryContent: string,
): boolean {
  const currentContextFingerprint = discoveryQuestionContextFingerprint(discoveryContent, question);
  if (!currentContextFingerprint) return false;
  const currentBasisDigest = discoveryQuestionDecisionBasisDigest(question);
  return events.some(event => {
    if (event.event_type !== "user_decision_recorded") return false;
    const payload = event.payload as {
      accepted?: unknown;
      explore_open_question?: {
        round_id?: unknown;
        question_id?: unknown;
        question_ordinal?: unknown;
        context_fingerprint?: unknown;
        decision_basis_digest?: unknown;
      };
    };
    const recorded = payload.explore_open_question;
    const revisionMatches = typeof recorded?.decision_basis_digest === "string"
      ? recorded.decision_basis_digest === currentBasisDigest
      : recorded?.context_fingerprint === currentContextFingerprint;
    return payload.accepted === true &&
      recorded?.round_id === roundId &&
      recorded.question_id === question.id &&
      (!question.id.startsWith("item-") || recorded.question_ordinal === question.ordinal) &&
      revisionMatches;
  });
}

/**
 * 新协议轮次中，被回写为已确认的事项必须有对应答复记录。
 * 进入本轮前已经关闭的事项作为基线保留，历史 change 因缺少协议标记整体兼容。
 */
export function unregisteredClosedExploreQuestions(events: readonly Event[], discoveryContent: string): DiscoveryQuestion[] {
  const registration = currentExploreAnswerRegistration(events);
  if (!registration.enabled) return [];
  return parseDiscoveryQuestions(discoveryContent).filter(question =>
    question.status === "closed" &&
    !registration.baselineClosedQuestionKeys.has(discoveryQuestionKey(question)) &&
    !exploreAnswerWasRecorded(events, registration.roundId, question, discoveryContent)
  );
}

/** 已正式展示但尚未登记答复的 Explore 问题不能通过删除问题行绕过。 */
export function unresolvedPresentedExploreQuestionScopes(events: readonly Event[]): string[] {
  const roundId = currentExploreRoundId(events);
  const acceptedDecisions = events.flatMap(event => {
    if (event.event_type !== "user_decision_recorded") return [];
    const payload = event.payload as {
      accepted?: unknown;
      scope?: unknown;
      explore_open_question?: {
        round_id?: unknown;
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
      question_id?: unknown;
      question_ordinal?: unknown;
      decision_basis_digest?: unknown;
    };
    if (payload.phase !== "explore" || payload.round_id !== roundId || typeof payload.scope !== "string" || typeof payload.question_id !== "string") continue;
    const identity = payload.question_id.startsWith("item-")
      ? `${payload.question_id}:${String(payload.question_ordinal)}`
      : payload.question_id;
    latestByQuestion.set(identity, {
      scope: payload.scope,
      legacyScope: typeof payload.legacy_scope === "string" ? payload.legacy_scope : null,
      questionId: payload.question_id,
      questionOrdinal: payload.question_ordinal,
      revisionDigest: payload.decision_basis_digest,
    });
  }
  return [...latestByQuestion.values()].flatMap(presented => {
    const answered = acceptedDecisions.some(decision => {
      if (decision.scope === presented.scope || decision.scope === presented.legacyScope) return true;
      const recorded = decision.explore_open_question;
      return recorded?.round_id === roundId &&
        recorded.question_id === presented.questionId &&
        (!presented.questionId.startsWith("item-") || recorded.question_ordinal === presented.questionOrdinal) &&
        typeof presented.revisionDigest === "string" &&
        recorded.decision_basis_digest === presented.revisionDigest;
    });
    return answered ? [] : [presented.scope];
  });
}
