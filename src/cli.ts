#!/usr/bin/env node
// SuperSpec 流程引擎 — CLI 入口

import { writeFileSync, mkdirSync, existsSync } from "node:fs";
import { join } from "node:path";
import { writeSnapshot } from "./store.ts";
import { rebuildSnapshot } from "./sync.ts";
import { next as nextCmd } from "./next.ts";
import { proposeReady, commitTransition, transitionInit, transitionExplore } from "./transition.ts";
import { recordJobSubmit, jobsList, jobsPacket } from "./record.ts";
import { probeOpenSpec, openspecStatus, changeRoot } from "./openspec.ts";

// ===== 参数解析 =====

function parseArgs(argv: string[]): { command: string; subcommand?: string; opts: Record<string, string> } {
  const [command, subcommand, ...rest] = argv;
  const opts: Record<string, string> = {};
  for (let i = 0; i < rest.length; i++) {
    if (rest[i].startsWith("--")) {
      const key = rest[i].slice(2);
      const val = rest[i + 1] && !rest[i + 1].startsWith("--") ? rest[++i] : "true";
      opts[key] = val;
    }
  }
  // 如果 subcommand 以 -- 开头，说明没有 subcommand
  if (subcommand && subcommand.startsWith("--")) {
    Object.entries(parseFlags([subcommand, ...rest])).forEach(([k, v]) => { opts[k] = v; });
    return { command, opts };
  }
  return { command, subcommand, opts };
}

function parseFlags(args: string[]): Record<string, string> {
  const opts: Record<string, string> = {};
  for (let i = 0; i < args.length; i++) {
    if (args[i].startsWith("--")) {
      const key = args[i].slice(2);
      const val = args[i + 1] && !args[i + 1].startsWith("--") ? args[++i] : "true";
      opts[key] = val;
    }
  }
  return opts;
}

// ===== 初始化 transition init =====

// ===== init/explore 现在在 transition.ts 中（走统一锁内路径）=====

// ===== 主分发 =====

function main(argv: string[]): number {
  const { command, subcommand, opts } = parseArgs(argv);

  const change = opts.change;
  if (!change && command !== "status") {
    console.error("错误：缺少 --change");
    return 1;
  }

  const projectRoot = process.cwd();

  try {
    switch (command) {
      case "status": {
        if (!change) {
          // 全局 status
          const probe = probeOpenSpec(projectRoot);
          console.log(JSON.stringify({ openspec: probe }, null, 2));
          return 0;
        }
        const cr = changeRoot(projectRoot, change);
        const snapshot = rebuildSnapshot(projectRoot, change, cr);
        const jobs = jobsList(projectRoot, change);
        console.log(JSON.stringify({
          change,
          state: snapshot.state,
          open_jobs: jobs.open.length,
          accepted_jobs: jobs.accepted.length,
          rejected_jobs: jobs.rejected.length,
          document_digests: snapshot.document_digests,
          last_transition: snapshot.last_transition,
        }, null, 2));
        return 0;
      }

      case "transition": {
        const cr = changeRoot(projectRoot, change);

        switch (subcommand) {
          case "init":
            console.log(JSON.stringify(transitionInit(projectRoot, change, cr), null, 2));
            return 0;

          case "explore":
            console.log(JSON.stringify(transitionExplore(projectRoot, change, cr), null, 2));
            return 0;

          case "sync": {
            const snapshot = rebuildSnapshot(projectRoot, change, cr, openspecStatus(projectRoot, change));
            writeSnapshot(projectRoot, change, snapshot);
            console.log(JSON.stringify({
              ok: true,
              state: snapshot.state,
              message: "snapshot 已重建",
              stale_accepted_removed: 0, // sync 不报告具体移除（轻量）
            }, null, 2));
            return 0;
          }

          case "next": {
            const risk = (opts.risk as "minimal" | "normal" | "strict") ?? "normal";
            const result = nextCmd(projectRoot, change, cr, risk);
            console.log(JSON.stringify(result, null, 2));
            return 0;
          }

          case "propose-ready": {
            const risk = (opts.risk as "minimal" | "normal" | "strict") ?? "normal";
            const result = proposeReady(projectRoot, change, cr, risk);
            console.log(JSON.stringify(result, null, 2));
            // skip（状态不变 + 无事件写入）不是失败，退出码 0
            return result.events_written === 0 && result.message.includes("不能") ? 1 : 0;
          }

          default:
            console.error(`未知的 transition 子命令：${subcommand}`);
            return 1;
        }
      }

      case "record": {
        const cr = changeRoot(projectRoot, change);

        switch (subcommand) {
          case "job-submit": {
            const jobId = opts.job;
            const report = opts.report;
            if (!jobId || !report) {
              console.error("record job-submit 需要 --job 和 --report");
              return 1;
            }
            const result = recordJobSubmit(projectRoot, change, cr, jobId, report);
            console.log(JSON.stringify(result, null, 2));
            return result.accepted ? 0 : 1;
          }

          default:
            console.error(`未知的 record 子命令：${subcommand}`);
            return 1;
        }
      }

      case "jobs": {
        switch (subcommand) {
          case "list": {
            const result = jobsList(projectRoot, change);
            console.log(JSON.stringify(result, null, 2));
            return 0;
          }

          case "packet": {
            const jobId = opts.job;
            if (!jobId) { console.error("jobs packet 需要 --job"); return 1; }
            const result = jobsPacket(projectRoot, change, jobId);
            console.log(JSON.stringify(result, null, 2));
            return result.found ? 0 : 1;
          }

          default:
            console.error(`未知的 jobs 子命令：${subcommand}`);
            return 1;
        }
      }

      default:
        console.error(`未知命令：${command}。可用：status, transition, record, jobs`);
        return 1;
    }
  } catch (err) {
    console.error(`错误：${(err as Error).message}`);
    return 2;
  }
}

// 入口
const exitCode = main(process.argv.slice(2));
process.exit(exitCode);
