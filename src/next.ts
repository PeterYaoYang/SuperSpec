// SuperSpec 流程引擎 — next：返回可执行路径

import { rebuildSnapshot } from "./sync.ts";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { readEvents, sha256Text } from "./store.ts";
import { isFreshReviewVerifier, isReviewReadyVerifier, readReviewPolicyFromEvents, reviewEvidenceDigest } from "./review.ts";
import {
  CODE_REVIEW_DECISION_ANSWER_LABELS,
  CODE_REVIEW_REPAIR_SCOPE_PREFIX,
  codeReviewDecisionScope,
  collectCodeReviewGateFacts,
  latestCodeReviewFailedStatus,
  requiresFinalVerifierForCurrentReview,
} from "./code_review.ts";
import { requiredJobActions } from "./job_action.ts";
import type { Job, NextOutput, AskUser, TaskAttempt, State } from "./types.ts";
import { validateDiscovery, countDiscoveryOpenQuestions, collectProposeOpenQuestions, parseTasksMd, pendingTasksInContent } from "./format.ts";

const ACTIVE_PROPOSAL_REVIEW_ROLES = new Set(["critic", "architect", "test-engineer"]);

function isActiveProposalReviewJob(job: Job): boolean {
  return job.created_from_transition === "propose-ready" && ACTIVE_PROPOSAL_REVIEW_ROLES.has(job.role);
}

function isExploreReviewJob(job: Job): boolean {
  return job.created_from_transition === "explore" && job.role === "critic";
}

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
      if (snapshot.open_jobs.length > 0) {
        return requiredJobsOutput("init", change, snapshot.open_jobs, `有 ${snapshot.open_jobs.length} 个待完成工作项`);
      }
      return {
        state: "init",
        path: "next_command",
        next_command: transitionCommand(change, "explore"),
        reason: "初始化完成，开始探索",
        missing_inputs: [],
      };

    case "explore": {
      const exploreReviewJobs = snapshot.open_jobs.filter(isExploreReviewJob);
      if (exploreReviewJobs.length > 0) {
        return requiredJobsOutput("explore", change, exploreReviewJobs, `有 ${exploreReviewJobs.length} 个待完成探索审查工作项`);
      }
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
        return requiredJobsOutput("propose", change, proposalReviewJobs, `有 ${proposalReviewJobs.length} 个待完成 proposal 审查工作项`);
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
        return requiredJobsOutput("propose_ready", change, proposalReviewJobs, `有 ${proposalReviewJobs.length} 个待完成 proposal 审查工作项`);
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
      if (snapshot.open_jobs.length > 0) {
        return requiredJobsOutput("apply", change, snapshot.open_jobs, `有 ${snapshot.open_jobs.length} 个待完成工作项`);
      }
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
        return requiredJobsOutput("apply_done", change, snapshot.open_jobs, `有 ${snapshot.open_jobs.length} 个待完成工作项`);
      }
      const events = readEvents(projectRoot, change);
      const facts = collectCodeReviewGateFacts(events);
      const latest = facts.latestTerminal;
      if (latest?.state === "rejected" && latest.result_kind === "review_failed") {
        const status = latestCodeReviewFailedStatus(events);
        const pending = status?.unresolved[0] ?? null;
        if (status && status.findings.length > 0 && !pending) {
          return {
            state: "apply_done",
            path: "next_command",
            next_command: transitionCommand(change, "review-ready", riskFlag(defaultRisk)),
            reason: "代码审查问题已被主流程复核驳回，重新发起代码审查",
            missing_inputs: [],
          };
        }
        const findingId = pending?.id ?? "";
        const type = pending?.type;
        const decision = pending?.decision;
        if (findingId && type === "implementation") {
          return {
            state: "apply_done",
            path: "next_command",
            next_command: transitionCommand(
              change,
              "reopen",
              `--to apply --review-fix ${latest.job.job_id}#${findingId} --reason "修复代码审查问题 ${findingId}"`,
            ),
            reason: `代码审查发现纯代码实现问题 ${findingId}，回到实现阶段修复`,
            missing_inputs: [],
          };
        }
        if (findingId && (type === "spec" || type === "mixed")) {
          if (decision?.answer === "reopen_propose") {
            return {
              state: "apply_done",
              path: "next_command",
              next_command: transitionCommand(
                change,
                "reopen",
                `--to propose --review-finding ${latest.job.job_id}#${findingId} --reason "根据代码审查问题 ${findingId} 回到计划阶段"`,
              ),
              reason: `使用者已确认问题 ${findingId} 需要回到计划阶段`,
              missing_inputs: [],
            };
          }
          if (decision?.answer === "reopen_apply") {
            return {
              state: "apply_done",
              path: "next_command",
              next_command: transitionCommand(
                change,
                "reopen",
                `--to apply --review-fix ${latest.job.job_id}#${findingId} --reason "根据代码审查问题 ${findingId} 回到实现阶段修复"`,
              ),
              reason: `使用者已确认问题 ${findingId} 直接回到实现阶段修复`,
              missing_inputs: [],
            };
          }
          const problemKind = type === "spec"
            ? "方案或需求文档可能需要调整"
            : "代码实现和方案文档都可能有关";
          const ask: AskUser = {
            question: `代码审查发现问题 ${findingId}：${problemKind}。请选择回到计划阶段修改文档、确认现有文档方向不变并回到实现阶段修代码，或驳回该问题；无论选择哪一项都必须写明原因。`,
            allowed_answers: [
              CODE_REVIEW_DECISION_ANSWER_LABELS.reopen_propose,
              CODE_REVIEW_DECISION_ANSWER_LABELS.reopen_apply,
              CODE_REVIEW_DECISION_ANSWER_LABELS.dismiss,
            ],
            scope: codeReviewDecisionScope(latest.job.job_id, findingId),
          };
          return { state: "apply_done", path: "ask_user", ask_user: ask, reason: `代码审查发现需要使用者判断的问题 ${findingId}` };
        }
        const ask: AskUser = {
          question: "代码审查报告里缺少可用于处理问题的编号或分类。请修正审查报告后重新执行 review-ready。",
          allowed_answers: ["报告已修正"],
          scope: `${CODE_REVIEW_REPAIR_SCOPE_PREFIX}${change}`,
        };
        return { state: "apply_done", path: "ask_user", ask_user: ask, reason: "代码审查报告中的阻塞问题无法处理" };
      }
      if (
        latest?.state === "rejected" &&
        (latest.result_kind === "invalid_report" || latest.result_kind === "non_actionable_report") &&
        facts.consecutiveRejected >= 2
      ) {
        const ask: AskUser = {
          question: "代码审查报告连续两次不符合要求，或者没有给出可处理的问题。请先修正报告生成方式、模板或审查口径；修正后仍可显式执行 review-ready。",
          allowed_answers: ["已修正"],
          scope: `${CODE_REVIEW_REPAIR_SCOPE_PREFIX}${change}`,
        };
        return { state: "apply_done", path: "ask_user", ask_user: ask, reason: "代码审查报告连续不符合要求或没有可处理问题" };
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
      const reviewVerifierJobs = snapshot.open_jobs.filter(isReviewReadyVerifier);
      if (reviewVerifierJobs.length > 0) {
        return requiredJobsOutput("review", change, reviewVerifierJobs, `有 ${reviewVerifierJobs.length} 个待完成最终验证工作项`);
      }
      const events = readEvents(projectRoot, change);
      const policy = readReviewPolicyFromEvents(events);
      if (!policy) {
        return {
          state: "review",
          path: "next_command",
          next_command: transitionCommand(change, "review-ready", riskFlag(defaultRisk)),
          reason: "缺少审查策略，先补 review-ready",
          missing_inputs: [],
        };
      }
      if (requiresFinalVerifierForCurrentReview(events) || policy.requires_verifier) {
        const currentEvidenceDigest = reviewEvidenceDigest(events);
        const verifierAccepted = snapshot.accepted_jobs.find(job => isFreshReviewVerifier(job, changeRoot, currentEvidenceDigest));
        if (!verifierAccepted) {
          return {
            state: "review",
            path: "next_command",
            next_command: transitionCommand(change, "review-ready", riskFlag(defaultRisk)),
            reason: "最终验证已经缺失或不再匹配当前证据，先补最终验证",
            missing_inputs: [],
          };
        }
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
      if (snapshot.open_jobs.length > 0) {
        return requiredJobsOutput("accepted", change, snapshot.open_jobs, `有 ${snapshot.open_jobs.length} 个待完成工作项，暂不归档`);
      }
      const ask: AskUser = {
        question: `审查已通过，流程停在 accepted。确认归档时请执行 ${transitionCommand(change, "archive")}`,
        allowed_answers: ["确认归档"],
        scope: "archive_confirmation",
      };
      return {
        state: "accepted",
        path: "ask_user",
        ask_user: ask,
        reason: "审查通过，等待用户确认归档",
      };

    case "archive":
      if (snapshot.open_jobs.length > 0) {
        return requiredJobsOutput("archive", change, snapshot.open_jobs, `有 ${snapshot.open_jobs.length} 个待完成工作项，暂不结束`);
      }
      return {
        state: "archive",
        path: "done",
        reason: "已归档，流程完成。",
      };

    case "abandoned":
      return {
        state: "abandoned",
        path: "done",
        reason: "变更已放弃，流程终止。",
      };

    default:
      return {
        state: snapshot.state,
        path: "done",
        reason: `状态 ${snapshot.state} 超出 Phase 1 范围`,
      };
  }
}
