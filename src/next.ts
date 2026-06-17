// SuperSpec 流程引擎 — next：返回可执行路径

import { rebuildSnapshot } from "./sync.ts";
import type { NextOutput } from "./types.ts";

function packetCommand(change: string, jobId: string): string {
  return `superspec jobs packet --change "${change}" --job "${jobId}"`;
}

function transitionCommand(change: string, name: string, extra = ""): string {
  return `superspec transition ${name} --change "${change}"${extra ? " " + extra : ""}`;
}

/** next 命令：读 snapshot，返回唯一可执行路径 */
export function next(
  projectRoot: string,
  change: string,
  changeRoot: string,
  defaultRisk: "minimal" | "normal" | "strict" = "normal",
): NextOutput {
  const snapshot = rebuildSnapshot(projectRoot, change, changeRoot);

  switch (snapshot.state) {
    case "init":
      return {
        state: "init",
        path: "next_command",
        next_command: transitionCommand(change, "explore"),
        reason: "初始化完成，开始探索",
        missing_inputs: [],
      };

    case "explore":
      return {
        state: "explore",
        path: "next_command",
        next_command: transitionCommand(change, "explore"),
        reason: "探索完成，推进到计划阶段",
        missing_inputs: [],
      };

    case "propose": {
      if (snapshot.open_jobs.length > 0) {
        const jobs = snapshot.open_jobs.map(j => ({
          job_id: j.job_id,
          role: j.role,
          packet_command: packetCommand(change, j.job_id),
        }));
        return {
          state: "propose",
          path: "required_job",
          required_jobs: jobs,
          reason: `有 ${jobs.length} 个待完成工作项`,
        };
      }

      const riskFlag = `--risk ${defaultRisk}`;
      return {
        state: "propose",
        path: "next_command",
        next_command: transitionCommand(change, "propose-ready", riskFlag),
        reason: "计划文档就绪，提交 propose-ready",
        missing_inputs: [],
      };
    }

    case "propose_ready":
      return {
        state: "propose_ready",
        path: "done",
        reason: "Phase 1 终态：propose_ready 已达成。后续阶段（apply/review/archive）待实现。",
      };

    default:
      return {
        state: snapshot.state,
        path: "done",
        reason: `状态 ${snapshot.state} 超出 Phase 1 范围`,
      };
  }
}
