import { next } from "../src/next.ts";
import type { PhaseDecisionAction } from "../src/phase_confirmation.ts";
import { recordUserDecisionContent } from "../src/record.ts";
import type { NextOutput } from "../src/types.ts";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export function confirmCurrentPhase(
  projectRoot: string,
  change: string,
  changeRoot: string,
  risk: "minimal" | "normal" | "strict" = "strict",
): Extract<NextOutput, { path: "ask_user" }> {
  // 测试中的 risk 参数模拟项目配置；生产 CLI 不接受 --risk。
  mkdirSync(join(projectRoot, ".superspec"), { recursive: true });
  writeFileSync(join(projectRoot, ".superspec", "config.json"), JSON.stringify({ workflow: { mode: risk } }));
  const output = next(projectRoot, change, changeRoot, risk);
  if (output.path !== "ask_user") {
    const jobs = output.path === "required_job"
      ? ` jobs=${output.required_jobs.map(job => `${job.job_id}:${job.role}`).join(",")}`
      : "";
    throw new Error(`当前阶段没有可确认边界：path=${output.path} reason=${output.reason}${jobs}`);
  }
  const actions = output.ask_user.actions as PhaseDecisionAction[] | undefined;
  const action = actions?.find(item => item.decision === "advance");
  if (!action) throw new Error("阶段确认缺少 advance action");
  const result = recordUserDecisionContent(projectRoot, change, JSON.stringify(action.record_input));
  if (!result.accepted) {
    throw new Error(`阶段确认登记失败：${result.message}`);
  }
  return output;
}
