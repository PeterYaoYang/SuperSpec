// SuperSpec 流程引擎 — next：返回可执行路径

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { rebuildSnapshot } from "./sync.ts";
import { appendEvent, makeEvent, readEvents, withLock } from "./store.ts";
import { requiredJobActions } from "./job_action.ts";
import type { Job, NextOutput, State } from "./types.ts";
import { planNextStep, type NextStepPlan } from "./phase_plan.ts";
import { workflowRiskForProject } from "./workflow_config.ts";
import { currentExploreRoundId } from "./explore_round.ts";
import { currentProposeRoundId } from "./propose_round.ts";
import {
  discoveryQuestionDecisionBasisDigest,
  legacyDiscoveryOpenQuestionScope,
  parseDiscoveryOpenQuestions,
  collectProposeQuestions,
  proposeQuestionDecisionBasisDigest,
  legacyProposeOpenQuestionScope,
} from "./format.ts";

function recordPresentedQuestion(projectRoot: string, change: string, changeRoot: string, output: NextOutput): void {
  if (output.path !== "ask_user") return;
  const isExplore = output.ask_user.scope.startsWith("explore_open_question:");
  const isPropose = output.ask_user.scope.startsWith("propose_open_question:");
  if (!isExplore && !isPropose) return;
  const events = readEvents(projectRoot, change);
  if (isExplore) {
    const current = parseDiscoveryOpenQuestions(readFileSync(join(changeRoot, ".superspec", "artifacts", "discovery.md"), "utf8"))[0];
    if (!current) return;
    const roundId = currentExploreRoundId(events);
    const latest = [...events].reverse().find(event => {
      if (event.event_type !== "user_question_presented") return false;
      const payload = event.payload as { phase?: unknown; round_id?: unknown; question_id?: unknown; question_ordinal?: unknown };
      return payload.phase === "explore" && payload.round_id === roundId && payload.question_id === current.id &&
        (!current.id.startsWith("item-") || payload.question_ordinal === current.ordinal);
    });
    if ((latest?.payload as { scope?: unknown } | undefined)?.scope === output.ask_user.scope) return;
    appendEvent(projectRoot, change, makeEvent(change, "user_question_presented", {
      phase: "explore",
      round_id: roundId,
      scope: output.ask_user.scope,
      legacy_scope: legacyDiscoveryOpenQuestionScope(current, roundId),
      question: output.ask_user.question,
      question_id: current.id,
      question_ordinal: current.ordinal,
      decision_basis_digest: discoveryQuestionDecisionBasisDigest(current),
    }));
    return;
  }
  const current = collectProposeQuestions(changeRoot).find(question => question.status === "open");
  if (!current) return;
  const roundId = currentProposeRoundId(events);
  const latest = [...events].reverse().find(event => {
    if (event.event_type !== "user_question_presented") return false;
    const payload = event.payload as { phase?: unknown; round_id?: unknown; path?: unknown; question_id?: unknown; question_ordinal?: unknown };
    return payload.phase === "propose" && payload.round_id === roundId && payload.path === current.path && payload.question_id === current.id &&
      (!current.id.startsWith("item-") || payload.question_ordinal === current.ordinal);
  });
  if ((latest?.payload as { scope?: unknown } | undefined)?.scope === output.ask_user.scope) return;
  appendEvent(projectRoot, change, makeEvent(change, "user_question_presented", {
    phase: "propose",
    round_id: roundId,
    scope: output.ask_user.scope,
    legacy_scope: legacyProposeOpenQuestionScope(current, roundId),
    question: output.ask_user.question,
    path: current.path,
    question_id: current.id,
    question_ordinal: current.ordinal,
    decision_basis_digest: proposeQuestionDecisionBasisDigest(current),
  }));
}

function requiredJobsOutput(state: State, change: string, jobs: Job[], reason: string): NextOutput {
  return {
    state,
    path: "required_job",
    required_jobs: requiredJobActions(change, jobs),
    reason,
  };
}

function transitionCommand(change: string, name: string, extra = ""): string {
  return `superspec transition ${name} --change "${change}"${extra ? " " + extra : ""}`;
}

function formatTransitionArgs(plan: Extract<NextStepPlan, { kind: "run_transition" }>): string {
  if (plan.taskId) return `--task ${plan.taskId}`;
  if (plan.reopen?.reason === "pending_tasks") {
    return `--to apply --reason "pending tasks: ${plan.reopen.taskIds.join(", ")}"`;
  }
  if (plan.reopen?.reason === "review_fix") {
    return `--to apply --review-fix ${plan.reopen.jobId}#${plan.reopen.findingId} --reason "${plan.reopen.reopenReason}"`;
  }
  if (plan.reopen?.reason === "review_finding") {
    return `--to propose --review-finding ${plan.reopen.jobId}#${plan.reopen.findingId} --reason "根据代码审查问题 ${plan.reopen.findingId} 回到计划阶段"`;
  }
  return "";
}

function toNextOutput(change: string, plan: NextStepPlan): NextOutput {
  switch (plan.kind) {
    case "required_jobs":
      return requiredJobsOutput(plan.state, change, plan.jobs, plan.reason);
    case "artifact_required":
      return {
        state: plan.state,
        path: "artifact_required",
        artifact: plan.artifact,
        resume: plan.resume,
        reason: plan.reason,
      };
    case "ask_user":
      return { state: plan.state, path: "ask_user", ask_user: plan.ask, reason: plan.reason };
    case "material_update_required":
      return {
        state: plan.state,
        path: "material_update_required",
        errors: plan.errors,
        resume: { argv: ["superspec", "transition", "next", "--change", change] },
        reason: plan.reason,
      };
    case "run_transition":
      return {
        state: plan.state,
        path: "next_command",
        next_command: transitionCommand(change, plan.transition, formatTransitionArgs(plan)),
        reason: plan.reason,
        missing_inputs: [],
      };
    case "done":
      return {
        state: plan.state,
        path: "done",
        reason: plan.reason,
        ...(plan.continuation ? { continuation: plan.continuation } : {}),
      };
  }
}

/** next 命令：读取当前状态，返回唯一可执行路径，并登记正式展示的用户问题。 */
export function next(
  projectRoot: string,
  change: string,
  changeRoot: string,
  defaultRisk = workflowRiskForProject(projectRoot),
): NextOutput {
  return withLock(projectRoot, change, () => {
    const snapshot = rebuildSnapshot(projectRoot, change, changeRoot);
    const events = readEvents(projectRoot, change);
    const plannedNextStep = planNextStep({ projectRoot, change, changeRoot, events, snapshot, mode: { kind: "risk", risk: defaultRisk } });
    if (plannedNextStep) {
      const output = toNextOutput(change, plannedNextStep);
      recordPresentedQuestion(projectRoot, change, changeRoot, output);
      return output;
    }

    return {
      state: snapshot.state,
      path: "done",
      reason: `状态 ${snapshot.state} 没有可执行下一步`,
    };
  });
}
