// SuperSpec 流程引擎 — next：返回可执行路径

import { rebuildSnapshot } from "./sync.ts";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { NextOutput, AskUser } from "./types.ts";

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

    case "explore": {
      // Phase 2：检查 discovery.md
      const discoveryPath = join(changeRoot, ".superspec", "artifacts", "discovery.md");
      if (!existsSync(discoveryPath)) {
        const ask: AskUser = {
          question: "请提供需求探索结果（写入 discovery.md 后继续）",
          allowed_answers: ["discovery.md 已写入"],
          scope: "explore_discovery",
        };
        return { state: "explore", path: "ask_user", ask_user: ask, reason: "discovery.md 不存在" };
      }
      // HIGH 修复：和 transitionExplore 一致——空文件也 block
      const content = readFileSync(discoveryPath, "utf8");
      if (!content.trim()) {
        const ask: AskUser = {
          question: "discovery.md 为空，请写入探索结果后继续",
          allowed_answers: ["discovery.md 已写入"],
          scope: "explore_discovery_empty",
        };
        return { state: "explore", path: "ask_user", ask_user: ask, reason: "discovery.md 为空" };
      }
      const openQs = content.match(/- \[ \]/g);
      if (openQs && openQs.length > 0) {
        const ask: AskUser = {
          question: `discovery.md 有 ${openQs.length} 个未解决的待确认问题，请逐个确认`,
          allowed_answers: ["所有问题已确认"],
          scope: "explore_open_questions",
        };
        return { state: "explore", path: "ask_user", ask_user: ask, reason: `有 ${openQs.length} 个未确认问题` };
      }
      return {
        state: "explore",
        path: "next_command",
        next_command: transitionCommand(change, "explore"),
        reason: "探索完成，推进到计划阶段",
        missing_inputs: [],
      };
    }

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
