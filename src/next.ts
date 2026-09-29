// SuperSpec 流程引擎 — next：返回可执行路径

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { rebuildSnapshot } from "./sync.ts";
import { appendEvent, engineRoot, makeEvent, readEvents, withLock } from "./store.ts";
import { requiredJobActions } from "./job_action.ts";
import type { AskUser, Event, Job, NextCommandOutput, NextOutput, State } from "./types.ts";
import type { ReviewRisk } from "./review.ts";
import { planNextStep, type NextStepPlan } from "./phase_plan.ts";
import {
  workflowModeStatus,
  workflowRiskForChange,
} from "./workflow_config.ts";
import { currentExploreRoundId } from "./explore_round.ts";
import { currentProposeRoundId } from "./propose_round.ts";
import { changeMaterialProjectPaths } from "./openspec.ts";
import {
  discoveryQuestionDecisionBasisDigest,
  legacyDiscoveryOpenQuestionScope,
  parseDiscoveryOpenQuestions,
  collectProposeQuestions,
  proposeQuestionDecisionBasisDigest,
  legacyProposeOpenQuestionScope,
} from "./format.ts";

/** 同一 scope 下带着需要补充的答复再次询问时，问题文本不同，作为一次新的展示留痕。 */
function alreadyPresented(latest: Event | undefined, ask: AskUser): boolean {
  const payload = latest?.payload as { scope?: unknown; question?: unknown } | undefined;
  return payload?.scope === ask.scope && payload.question === ask.question;
}

function followupOf(ask: AskUser): Record<string, string> {
  const pending = ask.answer_history?.filter(record => record.current_revision && record.closure === "needs_followup") ?? [];
  return pending.length > 0 ? { followup_of: pending.at(-1)!.event_id } : {};
}

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
    if (alreadyPresented(latest, output.ask_user)) return;
    appendEvent(projectRoot, change, makeEvent(change, "user_question_presented", {
      phase: "explore",
      round_id: roundId,
      scope: output.ask_user.scope,
      legacy_scope: legacyDiscoveryOpenQuestionScope(current, roundId),
      question: output.ask_user.question,
      question_id: current.id,
      question_ordinal: current.ordinal,
      decision_basis_digest: discoveryQuestionDecisionBasisDigest(current),
      ...followupOf(output.ask_user),
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
  if (alreadyPresented(latest, output.ask_user)) return;
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
    ...followupOf(output.ask_user),
  }));
}

const REQUIRED_JOB_WAIT_INSTRUCTION = "每个工作项用 dispatch_argv 输出的派发说明原样作为任务说明，交给新开的独立角色会话执行；需要补充的背景附在说明之后，写明是主流程陈述、未经核实。派出后在当前回合内等待它返回结果，再重新运行 next；工作项尚未返回不是停止点。";

function requiredJobsOutput(state: State, change: string, jobs: Job[], reason: string): NextOutput {
  return {
    state,
    path: "required_job",
    required_jobs: requiredJobActions(change, jobs),
    instruction: REQUIRED_JOB_WAIT_INSTRUCTION,
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
    case "mode_selection_required":
      return {
        state: plan.state,
        path: "mode_selection_required",
        selection: plan.selection,
        reason: plan.reason,
      };
    case "review_rejected":
      return {
        state: plan.state,
        path: "review_rejected",
        review_rejection: plan.review_rejection,
        reason: plan.reason,
      };
    case "run_transition": {
      const findingContext = plan.reopen?.reason === "review_fix" ? plan.reopen.findingContext : undefined;
      return {
        state: plan.state,
        path: "next_command",
        next_command: transitionCommand(change, plan.transition, formatTransitionArgs(plan)),
        reason: plan.reason,
        missing_inputs: [],
        ...(findingContext ? { finding_context: findingContext } : {}),
        ...(plan.createsReviewJobs ? { creates_review_jobs: plan.createsReviewJobs } : {}),
        ...(plan.reviewLeftovers ? { review_leftovers: plan.reviewLeftovers } : {}),
        ...(plan.staleTestEvidence ? { stale_test_evidence: plan.staleTestEvidence } : {}),
      };
    }
    case "done":
      return {
        state: plan.state,
        path: "done",
        reason: plan.reason,
        ...(plan.continuation ? { continuation: plan.continuation } : {}),
        ...(plan.reviewLeftovers ? { review_leftovers: plan.reviewLeftovers } : {}),
        ...(plan.postAcceptCodeChanges ? { post_accept_code_changes: plan.postAcceptCodeChanges } : {}),
        ...(plan.knowledgeCapture ? { knowledge_capture: plan.knowledgeCapture } : {}),
      };
  }
}


/** 项目根 .superspec/ 只存放引擎状态；出现 artifacts/ 说明工作流产物写错了位置。 */
function workspaceWarnings(projectRoot: string): string[] {
  return existsSync(join(engineRoot(projectRoot), "artifacts"))
    ? ["项目根的 .superspec/artifacts/ 不属于任何 change，通常是工作流产物写错了位置；产物应写在 next 返回的项目相对路径下，确认内容已迁移后删除该目录"]
    : [];
}

function withStopSignal(projectRoot: string, changeRoot: string, output: NextOutput): NextCommandOutput {
  const warnings = workspaceWarnings(projectRoot);
  return {
    ...output,
    stop_allowed: output.path === "ask_user" || output.path === "done",
    material_paths: changeMaterialProjectPaths(changeRoot),
    ...(warnings.length > 0 ? { warnings } : {}),
  };
}

/** next 命令：读取当前状态，返回唯一可执行路径，并登记正式展示的用户问题。 */
export function next(
  projectRoot: string,
  change: string,
  changeRoot: string,
  defaultRisk?: ReviewRisk,
): NextCommandOutput {
  return withLock(projectRoot, change, () => {
    const snapshot = rebuildSnapshot(projectRoot, change, changeRoot);
    const events = readEvents(projectRoot, change);
    const risk = workflowRiskForChange(projectRoot, events, snapshot.state, defaultRisk);
    const plannedNextStep = planNextStep({
      projectRoot,
      change,
      changeRoot,
      events,
      snapshot,
      mode: { kind: "risk", risk },
    });
    // 升级入口只在 status 中提供：next 每步都返回，常驻的升级提示会被当作待办。
    const status = workflowModeStatus(events, snapshot.state, risk);
    if (plannedNextStep) {
      const output = { ...toNextOutput(change, plannedNextStep), ...status };
      recordPresentedQuestion(projectRoot, change, changeRoot, output);
      return withStopSignal(projectRoot, changeRoot, output);
    }

    return withStopSignal(projectRoot, changeRoot, {
      state: snapshot.state,
      path: "done",
      reason: `状态 ${snapshot.state} 没有可执行下一步`,
      ...status,
    });
  });
}
