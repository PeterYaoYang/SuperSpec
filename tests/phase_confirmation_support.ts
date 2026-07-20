import { next } from "../src/next.ts";
import { transitionExplore } from "../src/transition.ts";
import type { PhaseDecisionAction } from "../src/phase_confirmation.ts";
import { jobsPacket, recordJobSubmitContent, recordUserDecisionContent } from "../src/record.ts";
import type { NextOutput } from "../src/types.ts";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export function confirmCurrentPhase(
  projectRoot: string,
  change: string,
  changeRoot: string,
  risk: "minimal" | "normal" | "strict" = "strict",
): Extract<NextOutput, { path: "ask_user" }> {
  const output = prepareCurrentPhaseConfirmation(projectRoot, change, changeRoot, risk);
  const actions = output.ask_user.actions as PhaseDecisionAction[] | undefined;
  const action = actions?.find(item => item.decision === "advance");
  if (!action) throw new Error("阶段确认缺少 advance action");
  const result = recordUserDecisionContent(projectRoot, change, JSON.stringify(action.record_input));
  if (!result.accepted) {
    throw new Error(`阶段确认登记失败：${result.message}`);
  }
  return output;
}

export function prepareCurrentPhaseConfirmation(
  projectRoot: string,
  change: string,
  changeRoot: string,
  risk: "minimal" | "normal" | "strict" = "strict",
): Extract<NextOutput, { path: "ask_user" }> {
  // 测试中的 risk 参数模拟项目配置；生产 CLI 不接受 --risk。
  mkdirSync(join(projectRoot, ".superspec"), { recursive: true });
  writeFileSync(join(projectRoot, ".superspec", "config.json"), JSON.stringify({ workflow: { mode: risk } }));
  let output = next(projectRoot, change, changeRoot, risk);
  for (let attempts = 0; attempts < 10; attempts += 1) {
    if (output.path === "next_command" && /transition\s+explore/.test(output.next_command)) {
      transitionExplore(projectRoot, change, changeRoot, risk);
      output = next(projectRoot, change, changeRoot, risk);
      continue;
    }
    if (output.path === "required_job") {
      for (const required of output.required_jobs) {
        const packet = jobsPacket(projectRoot, change, required.job_id).packet;
        if (!packet) throw new Error(`无法读取测试审查工作项：${required.job_id}`);
        const submitted = recordJobSubmitContent(projectRoot, change, changeRoot, required.job_id, JSON.stringify({
          role: packet.role,
          verdict: "pass",
          findings: [],
          review_scope: { checked_paths: packet.boundFiles.map(file => file.path) },
          reviewer: { kind: "codex-subagent", id: "phase-confirmation-support" },
        }));
        if (!submitted.accepted) throw new Error(`测试审查工作项提交失败：${submitted.message}`);
      }
      output = next(projectRoot, change, changeRoot, risk);
      continue;
    }
    break;
  }
  if (output.path !== "ask_user") {
    const jobs = output.path === "required_job"
      ? ` jobs=${output.required_jobs.map(job => `${job.job_id}:${job.role}`).join(",")}`
      : "";
    throw new Error(`当前阶段没有可确认边界：path=${output.path} reason=${output.reason}${jobs}`);
  }
  return output;
}
