// SuperSpec 流程引擎 — next：返回可执行路径

import { rebuildSnapshot } from "./sync.ts";
import { readEvents } from "./store.ts";
import { requiredJobActions } from "./job_action.ts";
import type { Job, NextOutput, AskUser, State } from "./types.ts";
import { planNextStep, type NextStepPlan } from "./phase_plan.ts";

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

function riskFlag(risk: "minimal" | "normal" | "strict"): string {
  return risk === "strict" ? "" : `--risk ${risk}`;
}

function riskArg(risk: "minimal" | "normal" | "strict" | undefined): string {
  return risk ? riskFlag(risk) : "";
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
  return riskArg(plan.risk);
}

function toNextOutput(change: string, plan: NextStepPlan): NextOutput {
  switch (plan.kind) {
    case "required_jobs":
      return requiredJobsOutput(plan.state, change, plan.jobs, plan.reason);
    case "ask_user":
      return { state: plan.state, path: "ask_user", ask_user: plan.ask, reason: plan.reason };
    case "ask_archive_confirmation": {
      const ask: AskUser = {
        question: `审查已通过，流程停在 accepted。确认归档时请执行 ${transitionCommand(change, "archive")}`,
        allowed_answers: ["确认归档"],
        scope: "archive_confirmation",
      };
      return { state: "accepted", path: "ask_user", ask_user: ask, reason: plan.reason };
    }
    case "run_transition":
      return {
        state: plan.state,
        path: "next_command",
        next_command: transitionCommand(change, plan.transition, formatTransitionArgs(plan)),
        reason: plan.reason,
        missing_inputs: [],
      };
    case "done":
      return { state: plan.state, path: "done", reason: plan.reason };
  }
}

/** next 命令：读 snapshot，返回唯一可执行路径 */
export function next(
  projectRoot: string,
  change: string,
  changeRoot: string,
  defaultRisk: "minimal" | "normal" | "strict" = "strict",
): NextOutput {
  const snapshot = rebuildSnapshot(projectRoot, change, changeRoot);
  const events = readEvents(projectRoot, change);
  const plannedNextStep = planNextStep({ projectRoot, change, changeRoot, events, snapshot, mode: { kind: "risk", risk: defaultRisk } });
  if (plannedNextStep) return toNextOutput(change, plannedNextStep);

  return {
    state: snapshot.state,
    path: "done",
    reason: `状态 ${snapshot.state} 没有可执行下一步`,
  };
}
