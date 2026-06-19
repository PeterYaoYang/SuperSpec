#!/usr/bin/env node
// SuperSpec 流程引擎 — CLI 入口

import { writeFileSync, mkdirSync, existsSync } from "node:fs";
import { join } from "node:path";
import { writeSnapshot } from "./store.ts";
import { rebuildSnapshot } from "./sync.ts";
import { next as nextCmd } from "./next.ts";
import { proposeReady, commitTransition, transitionInit, transitionExplore, startApply, taskStart, taskComplete, reviewReady, accept, archive } from "./transition.ts";
import { recordJobSubmit, recordUserDecision, jobsList, jobsPacket } from "./record.ts";
import { recordTestRun } from "./task.ts";
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

async function main(argv: string[]): Promise<number> {
  // --help / 无参数 → 打印用法
  if (argv.length === 0 || argv.includes("--help") || argv.includes("-h")) {
    console.log(`SuperSpec 流程引擎 0.1.15-alpha

用法：superspec <命令> [选项]

命令：
  status --change <C>              查看状态
  transition <子命令> --change <C>  状态流转（见下）
  record <子命令> --change <C>      登记证据（见下）
  jobs <子命令> --change <C>        工作项管理（见下）
  install [--global]               安装到项目或全局
  update                           更新 SuperSpec
  version                          版本号

transition 子命令：
  init / explore / sync / next / propose-ready / start-apply
  task-start --task <T> / task-complete --task <T>
  review-ready / accept / archive

record 子命令：
  job-submit --job <J> --report <F>
  user-decision --input <F>
  test-run --input <F>

jobs 子命令：
  list / packet --job <J>
`);
    return 0;
  }

  // version
  if (argv[0] === "version" || argv[0] === "--version" || argv[0] === "-v") {
    console.log("SuperSpec 0.1.15-alpha");
    return 0;
  }

  const { command, subcommand, opts } = parseArgs(argv);
  const projectRoot = process.cwd();

  // install / update 不需要 --change
  if (command === "install") {
    const { mkdirSync, writeFileSync, existsSync, readdirSync, readFileSync } = await import("node:fs");
    const engineDir = join(projectRoot, ".superspec");

    // 检测老版残留（0.x 的 superspec-state.json / superspec-state.lock）
    const oldStateFiles = ["superspec-state.json", "superspec-state.lock", "ledger.jsonl"];
    const foundOld = oldStateFiles.some(f => existsSync(join(projectRoot, "openspec", "changes")) &&
      readdirSync(join(projectRoot, "openspec", "changes")).some(c =>
        existsSync(join(projectRoot, "openspec", "changes", c, ".superspec", f))));
    if (foundOld) {
      console.log(JSON.stringify({
        ok: false,
        message: "检测到老版 SuperSpec (0.x) 的状态文件。\n" +
          "SuperSpec 0.1.15-alpha 是全新引擎，不兼容 0.x 的状态格式。\n" +
          "请先用老版（0.1.x）完成或归档现有 change，再安装 0.1.15-alpha。\n" +
          "或在全新项目目录中安装。",
      }));
      return 1;
    }

    if (!existsSync(engineDir)) mkdirSync(join(engineDir, "changes"), { recursive: true });
    const gitignorePath = join(engineDir, ".gitignore");
    if (!existsSync(gitignorePath)) writeFileSync(gitignorePath, "changes/\n*.log\n*.tmp\n");
    console.log(JSON.stringify({ ok: true, message: "SuperSpec 0.1.15-alpha 已安装" }));
    return 0;
  }
  if (command === "update") {
    // 检测是否从老版 update 过来
    const { existsSync } = await import("node:fs");
    const isLegacyUpdate = !existsSync(join(projectRoot, ".superspec", "changes"));
    if (isLegacyUpdate) {
      console.log(JSON.stringify({
        ok: false,
        message: "SuperSpec 0.1.15-alpha 是全新引擎，不能从 0.x 直接 update。\n" +
          "请用 npm install -g @peterxiaoyang/superspec@0.1.15-alpha 手动安装。\n" +
          "现有 change 请先用 0.1.x 完成归档。",
      }));
      return 1;
    }
    console.log(JSON.stringify({ ok: true, message: "已是最新版本 0.1.15-alpha" }));
    return 0;
  }

  const change = opts.change;
  if (!change && command !== "status") {
    console.error("错误：缺少 --change（用 --help 查看用法）");
    return 1;
  }

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
            return result.events_written === 0 && result.message.includes("不能") ? 1 : 0;
          }

          case "start-apply": {
            const result = startApply(projectRoot, change, cr);
            console.log(JSON.stringify(result, null, 2));
            return result.events_written === 0 ? 1 : 0;
          }

          case "task-start": {
            const taskId = opts.task;
            if (!taskId) { console.error("task-start 需要 --task"); return 1; }
            const result = taskStart(projectRoot, change, cr, taskId);
            console.log(JSON.stringify(result, null, 2));
            return result.events_written === 0 ? 1 : 0;
          }

          case "task-complete": {
            const taskId = opts.task;
            if (!taskId) { console.error("task-complete 需要 --task"); return 1; }
            const result = taskComplete(projectRoot, change, cr, taskId);
            console.log(JSON.stringify(result, null, 2));
            return result.events_written === 0 ? 1 : 0;
          }

          case "review-ready": {
            const risk = (opts.risk as "minimal" | "normal" | "strict") ?? "normal";
            const result = reviewReady(projectRoot, change, cr, risk);
            console.log(JSON.stringify(result, null, 2));
            return result.events_written === 0 ? 1 : 0;
          }

          case "accept": {
            const result = accept(projectRoot, change, cr);
            console.log(JSON.stringify(result, null, 2));
            return result.events_written === 0 ? 1 : 0;
          }

          case "archive": {
            const result = archive(projectRoot, change, cr);
            console.log(JSON.stringify(result, null, 2));
            return result.events_written === 0 ? 1 : 0;
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

          case "user-decision": {
            const inputFile = opts.input;
            if (!inputFile) {
              console.error("record user-decision 需要 --input");
              return 1;
            }
            const result = recordUserDecision(projectRoot, change, inputFile);
            console.log(JSON.stringify(result, null, 2));
            return result.accepted ? 0 : 1;
          }

          case "test-run": {
            const inputFile = opts.input;
            if (!inputFile) { console.error("record test-run 需要 --input"); return 1; }
            const result = recordTestRun(projectRoot, change, inputFile);
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
main(process.argv.slice(2)).then(exitCode => process.exit(exitCode));
