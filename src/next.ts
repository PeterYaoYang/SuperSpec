// SuperSpec 流程引擎 — next：返回可执行路径

import { rebuildSnapshot } from "./sync.ts";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { readEvents, sha256Text } from "./store.ts";
import type { Job, NextOutput, AskUser, TaskAttempt } from "./types.ts";
import { validateDiscovery, countDiscoveryOpenQuestions, collectProposeOpenQuestions, parseTasksMd, pendingTasksInContent } from "./format.ts";

const ACTIVE_PROPOSAL_REVIEW_ROLES = new Set(["critic", "architect", "test-engineer"]);

function isActiveProposalReviewJob(job: Job): boolean {
  return job.created_from_transition === "propose-ready" && ACTIVE_PROPOSAL_REVIEW_ROLES.has(job.role);
}

function packetCommand(change: string, jobId: string): string {
  return `superspec jobs packet --change "${change}" --job "${jobId}"`;
}

function transitionCommand(change: string, name: string, extra = ""): string {
  return `superspec transition ${name} --change "${change}"${extra ? " " + extra : ""}`;
}

function riskFlag(risk: "minimal" | "normal" | "strict"): string {
  return risk === "strict" ? "" : `--risk ${risk}`;
}

function pendingTaskIds(changeRoot: string): string[] {
  const tasksContent = readFileSync(join(changeRoot, "tasks.md"), "utf8");
  return pendingTasksInContent(tasksContent).map(task => task.taskId);
}

function reopenCommand(change: string, pending: string[]): string {
  return transitionCommand(change, "reopen", `--to apply --reason "pending tasks: ${pending.join(", ")}"`);
}

function taskCompletionReadiness(
  projectRoot: string,
  change: string,
  changeRoot: string,
  attempt: TaskAttempt,
): { ready: boolean; missing: string[] } {
  const tasksContent = readFileSync(join(changeRoot, "tasks.md"), "utf8");
  const tasks = parseTasksMd(tasksContent);
  const taskInfo = tasks.find(task => task.taskId === attempt.task_id);
  const missing: string[] = [];

  if (!taskInfo) return { ready: false, missing: [`任务 ${attempt.task_id} 不存在`] };

  const currentDigest = sha256Text(tasksContent.replace(/- \[[xX]\]/g, "- [ ]"));
  // Keep the wording aligned with task-complete; no command should be suggested if it would fail this guard.
  if (currentDigest !== attempt.task_structure_digest) missing.push("任务结构指纹");

  if (!taskInfo.tddRequired) {
    if (!taskInfo.noTddReason) missing.push("no_tdd_reason");
    return { ready: missing.length === 0, missing };
  }

  let hasRed = false;
  let hasGreen = false;
  for (const ev of readEvents(projectRoot, change)) {
    if (ev.event_type !== "test_run_recorded") continue;
    const tr = ev.payload as { task_structure_digest?: string; attempt_id?: string | null; semantic_status?: string };
    const matches = tr.attempt_id === attempt.attempt_id ||
      (!tr.attempt_id && tr.task_structure_digest === attempt.task_structure_digest);
    if (!matches) continue;
    if (tr.semantic_status === "expected_failure" || tr.semantic_status === "characterization_pass") hasRed = true;
    if (tr.semantic_status === "expected_success") hasGreen = true;
  }
  if (!hasRed) missing.push("RED 证据");
  if (!hasGreen) missing.push("GREEN 证据");

  return { ready: missing.length === 0, missing };
}

/** next 命令：读 snapshot，返回唯一可执行路径 */
export function next(
  projectRoot: string,
  change: string,
  changeRoot: string,
  defaultRisk: "minimal" | "normal" | "strict" = "strict",
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
      const discoveryCheck = validateDiscovery(changeRoot);
      if (!discoveryCheck.ok) {
        const ask: AskUser = {
          question: discoveryCheck.message + "，请处理后继续",
          allowed_answers: ["已处理"],
          scope: "explore_discovery",
        };
        return { state: "explore", path: "ask_user", ask_user: ask, reason: discoveryCheck.message };
      }
      // 检查"待确认问题"段（用 format.ts 的段感知解析）
      const content = readFileSync(join(changeRoot, ".superspec", "artifacts", "discovery.md"), "utf8");
      const openQs = countDiscoveryOpenQuestions(content);
      if (openQs > 0) {
        const ask: AskUser = {
          question: `discovery.md 有 ${openQs} 个未解决的待确认问题，请逐个确认`,
          allowed_answers: ["所有问题已确认"],
          scope: "explore_open_questions",
        };
        return { state: "explore", path: "ask_user", ask_user: ask, reason: `有 ${openQs} 个未确认问题` };
      }
      return {
        state: "explore",
        path: "next_command",
        next_command: transitionCommand(change, "explore", riskFlag(defaultRisk)),
        reason: "探索完成，推进到计划阶段",
        missing_inputs: [],
      };
    }

    case "propose": {
      const openQuestions = collectProposeOpenQuestions(changeRoot);
      if (openQuestions.openCount > 0) {
        const files = openQuestions.files.map(f => `${f.path}(${f.openCount})`).join(", ");
        const ask: AskUser = {
          question: `计划文档有 ${openQuestions.openCount} 个待用户确认问题：${files}。请确认并更新计划文档后继续`,
          allowed_answers: ["所有问题已确认"],
          scope: "propose_open_questions",
        };
        return { state: "propose", path: "ask_user", ask_user: ask, reason: `有 ${openQuestions.openCount} 个 propose 未确认问题` };
      }

      const proposalReviewJobs = snapshot.open_jobs.filter(isActiveProposalReviewJob);
      if (proposalReviewJobs.length > 0) {
        const jobs = proposalReviewJobs.map(j => ({
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

      return {
        state: "propose",
        path: "next_command",
        next_command: transitionCommand(change, "propose-ready", riskFlag(defaultRisk)),
        reason: "计划文档就绪，提交 propose-ready",
        missing_inputs: [],
      };
    }

    case "propose_ready": {
      const proposalReviewJobs = snapshot.open_jobs.filter(isActiveProposalReviewJob);
      if (proposalReviewJobs.length > 0) {
        return {
          state: "propose_ready",
          path: "required_job",
          required_jobs: proposalReviewJobs.map(j => ({
            job_id: j.job_id,
            role: j.role,
            packet_command: packetCommand(change, j.job_id),
          })),
          reason: `有 ${proposalReviewJobs.length} 个待完成 proposal 审查工作项`,
        };
      }
      return {
        state: "propose_ready",
        path: "next_command",
        next_command: transitionCommand(change, "start-apply"),
        reason: "计划就绪，开始执行",
        missing_inputs: [],
      };
    }

    case "apply": {
      // 检查是否所有任务已完成
      const pending = pendingTaskIds(changeRoot);
      if (pending.length > 0) {
        const activePending = snapshot.active_task_attempts.find(attempt =>
          attempt.state === "active" && pending.includes(attempt.task_id)
        );
        if (activePending) {
          const readiness = taskCompletionReadiness(projectRoot, change, changeRoot, activePending);
          if (readiness.ready) {
            return {
              state: "apply",
              path: "next_command",
              next_command: transitionCommand(change, "task-complete", `--task ${activePending.task_id}`),
              reason: `任务 ${activePending.task_id} 证据已登记，可以完成`,
              missing_inputs: [],
            };
          }
          const ask: AskUser = {
            question: `任务 ${activePending.task_id} 已开始，请先登记 ${readiness.missing.join("、")} 后继续`,
            allowed_answers: ["证据已登记"],
            scope: `apply_active_task_${activePending.task_id}`,
          };
          return { state: "apply", path: "ask_user", ask_user: ask, reason: `任务 ${activePending.task_id} 缺少完成证据` };
        }
        return {
          state: "apply",
          path: "next_command",
          next_command: transitionCommand(change, "task-start", `--task ${pending[0]}`),
          reason: `执行中：下一个未完成任务 ${pending[0]}`,
          missing_inputs: [],
        };
      }
      // 有 open job → 做
      if (snapshot.open_jobs.length > 0) {
        return {
          state: "apply",
          path: "required_job",
          required_jobs: snapshot.open_jobs.map(j => ({ job_id: j.job_id, role: j.role, packet_command: packetCommand(change, j.job_id) })),
          reason: `有 ${snapshot.open_jobs.length} 个待完成工作项`,
        };
      }
      return {
        state: "apply",
        path: "next_command",
        next_command: transitionCommand(change, "review-ready", riskFlag(defaultRisk)),
        reason: "所有任务完成，进入审查",
        missing_inputs: [],
      };
    }

    case "apply_done": {
      const pending = pendingTaskIds(changeRoot);
      if (pending.length > 0) {
        return {
          state: "apply_done",
          path: "next_command",
          next_command: reopenCommand(change, pending),
          reason: `发现未完成任务 ${pending[0]}，回到执行阶段`,
          missing_inputs: [],
        };
      }
      if (snapshot.open_jobs.length > 0) {
        return {
          state: "apply_done",
          path: "required_job",
          required_jobs: snapshot.open_jobs.map(j => ({ job_id: j.job_id, role: j.role, packet_command: packetCommand(change, j.job_id) })),
          reason: `有 ${snapshot.open_jobs.length} 个待完成工作项`,
        };
      }
      return {
        state: "apply_done",
        path: "next_command",
        next_command: transitionCommand(change, "review-ready", riskFlag(defaultRisk)),
        reason: "所有任务完成，进入审查",
        missing_inputs: [],
      };
    }

    case "review": {
      const pending = pendingTaskIds(changeRoot);
      if (pending.length > 0) {
        return {
          state: "review",
          path: "next_command",
          next_command: reopenCommand(change, pending),
          reason: `发现未完成任务 ${pending[0]}，回到执行阶段`,
          missing_inputs: [],
        };
      }
      return {
        state: "review",
        path: "next_command",
        next_command: transitionCommand(change, "accept"),
        reason: "审查完成，提交接受",
        missing_inputs: [],
      };
    }

    case "accepted":
      return {
        state: "accepted",
        path: "next_command",
        next_command: transitionCommand(change, "archive"),
        reason: "审查通过，提交归档",
        missing_inputs: [],
      };

    case "archive":
      return {
        state: "archive",
        path: "done",
        reason: "已归档，流程完成。",
      };

    default:
      return {
        state: snapshot.state,
        path: "done",
        reason: `状态 ${snapshot.state} 超出 Phase 1 范围`,
      };
  }
}
