import { next } from "../src/next.ts";
import { recordUserDecisionContent } from "../src/record.ts";
import type { NextOutput } from "../src/types.ts";

export function confirmCurrentPhase(
  projectRoot: string,
  change: string,
  changeRoot: string,
  risk: "minimal" | "normal" | "strict" = "strict",
): Extract<NextOutput, { path: "ask_user" }> {
  const output = next(projectRoot, change, changeRoot, risk);
  if (output.path !== "ask_user") {
    const jobs = output.path === "required_job"
      ? ` jobs=${output.required_jobs.map(job => `${job.job_id}:${job.role}`).join(",")}`
      : "";
    throw new Error(`当前阶段没有可确认边界：path=${output.path} reason=${output.reason}${jobs}`);
  }
  const answer = output.ask_user.allowed_answers[0];
  const result = recordUserDecisionContent(projectRoot, change, JSON.stringify({
    scope: output.ask_user.scope,
    question: output.ask_user.question,
    answer,
  }));
  if (!result.accepted) {
    throw new Error(`阶段确认登记失败：${result.message}`);
  }
  return output;
}
