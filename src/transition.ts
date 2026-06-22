// SuperSpec 流程引擎 — transition：提交协议 + 所有 transition 处理器

import { join } from "node:path";
import { existsSync, readFileSync, writeFileSync, mkdirSync, readdirSync } from "node:fs";
import {
  ensureChangeLayout, readEvents, appendEvent, makeEvent,
  writeSnapshot, snapshotDigest, withLock, idempotencyKey, stagingDir,
  sha256File, sha256Text,
} from "./store.ts";
import { rebuildSnapshot } from "./sync.ts";
import { validateDiscovery, collectProposeOpenQuestions, findTaskInLines, parseTasksMd, pendingTasksInContent, tasksStructureDigest } from "./format.ts";
import type { Event, Snapshot, State, Job, JobRole, TransitionResult, Ref, TaskAttempt } from "./types.ts";

let transitionSeq = 0;
function newTransitionId(): string { return `T-${Date.now()}-${++transitionSeq}`; }
let jobSeq = 0;
function newJobId(change: string, role: string): string { return `JOB-${change.slice(0, 8)}-${role.slice(0, 4)}-${Date.now()}-${++jobSeq}`; }

const TRANSITION_REQUIREMENTS: Record<string, Record<string, JobRole[]>> = {
  "propose-ready": {
    minimal: [],
    normal:  ["critic"],
    strict:  ["critic", "architect", "test-engineer"],
  },
  "explore": {
    minimal: [],
    normal:  [],
    strict:  ["critic"],
  },
};

/**
 * 通用 job 检查/创建逻辑——任何 transition 都能调用。
 * 检查 requiredRoles 是否有 fresh accepted job；缺则创建新 job。
 * 返回 null = 全部满足；返回 Decision = 需要创建 job（状态不变）。
 */
function checkOrCreateReviewJobs(
  snapshot: Snapshot,
  requiredRoles: JobRole[],
  changeRoot: string,
  change: string,
  transitionName: string,
  bindDocPaths: string[],
): Decision | null {
  const staleRoles: { role: JobRole; reason: string }[] = [];
  for (const role of requiredRoles) {
    const openForRole = snapshot.open_jobs.find(j => j.role === role && j.created_from_transition === transitionName);
    if (openForRole) return { fromState: snapshot.state, toState: snapshot.state, outcome: "advanced" as const, reason: `工作项 ${role} 已存在（${openForRole.job_id}），请先完成它` };
    const fresh = snapshot.accepted_jobs.find(j => j.role === role && j.created_from_transition === transitionName);
    if (!fresh) {
      staleRoles.push({ role, reason: `需求 ${role} 无已接受的工作项` });
    } else {
      for (const bf of fresh.boundFiles) {
        const currentSha = sha256File(join(changeRoot, bf.path)) ?? "sha256:missing";
        if (currentSha !== bf.sha) { staleRoles.push({ role, reason: `${role} 绑定文件 ${bf.path} 已变化` }); break; }
      }
    }
  }

  if (staleRoles.length > 0) {
    const newJobs: Job[] = staleRoles.map(({ role }) => {
      const boundFiles: Ref[] = bindDocPaths.filter(p => existsSync(join(changeRoot, p))).map(p => ({ path: p, sha: sha256File(join(changeRoot, p)) ?? "sha256:missing" }));
      return { job_id: newJobId(change, role), role, state: "requested" as const, boundFiles, packet_digest: sha256Text(JSON.stringify({ role, boundFiles })), created_from_transition: transitionName, created_at: new Date().toISOString() };
    });
    return {
      fromState: snapshot.state, toState: snapshot.state, outcome: "job_created" as const,
      newJobs, reason: staleRoles.map(s => s.reason).join("; "),
    };
  }
  return null; // 全部满足
}

function historicalProposeReadyRoles(projectRoot: string, change: string): JobRole[] {
  const roles = new Set<JobRole>();
  for (const ev of readEvents(projectRoot, change)) {
    if (ev.event_type !== "transition_commit") continue;
    const newJobs = (ev.payload as { new_jobs?: Job[] }).new_jobs ?? [];
    for (const job of newJobs) {
      if (
        job.created_from_transition === "propose-ready" &&
        (job.role === "critic" || job.role === "architect" || job.role === "test-engineer")
      ) roles.add(job.role);
    }
  }
  return [...roles];
}

/**
 * 已迁移到 format.ts：findTaskInLines / parseTasksMd / tasksStructureDigest
 * 以下保留 findTaskLine 作为兼容 wrapper（内部调用 format.ts）
 */
function findTaskLine(lines: string[], taskId: string): number {
  return findTaskInLines(lines, taskId);
}

function pendingTaskIds(changeRoot: string): string[] {
  const tasksContent = readFileSync(join(changeRoot, "tasks.md"), "utf8");
  return pendingTasksInContent(tasksContent).map(task => task.taskId);
}

function formatPendingTaskMessage(ids: string[], action: string): string {
  return `尚有未完成任务：${ids.join(", ")}；${action}`;
}

interface Decision {
  fromState: State;
  toState: State;
  outcome: "advanced" | "job_created";
  newJobs?: Job[];
  reason: string;
  extraEvents?: { type: string; payload: Record<string, unknown> }[];
  details?: Record<string, unknown>;
  postCommit?: (projectRoot: string, change: string, changeRoot: string) => void;
}

/**
 * 统一 transition 提交协议——所有校验在锁内。
 */
export function commitTransition(
  projectRoot: string, change: string, changeRoot: string,
  opts: {
    name: string;
    decide: (snapshot: Snapshot) => Decision | { skip: true; message: string };
    idempotencyInputs?: Record<string, unknown>;
  }
): TransitionResult {
  const { name } = opts;

  return withLock(projectRoot, change, () => {
    ensureChangeLayout(projectRoot, change);
    const snapshot = rebuildSnapshot(projectRoot, change, changeRoot);
    const worldDigest = snapshotDigest(snapshot);

    const idemKey = idempotencyKey(name, opts.idempotencyInputs ?? {}, worldDigest);
    const events = readEvents(projectRoot, change);
    const existing = events.find(e => e.idempotency_key === idemKey && e.event_type === "transition_commit");
    if (existing) {
      const p = existing.payload as { outcome: string; from_state: State; to_state: State; created_job_ids?: string[] };
      return {
        transition: name, outcome: p.outcome as "advanced" | "job_created",
        from_state: p.from_state, to_state: p.to_state,
        created_jobs: p.created_job_ids ?? [], message: "幂等返回", events_written: 0,
      };
    }

    const decision = opts.decide(snapshot);
    if ("skip" in decision) {
      return {
        transition: name, outcome: "advanced",
        from_state: snapshot.state, to_state: snapshot.state,
        created_jobs: [], message: decision.message, events_written: 0,
      };
    }

    const { fromState, toState, outcome, newJobs = [], reason, extraEvents = [], details } = decision;

    if (fromState !== snapshot.state) {
      return {
        transition: name, outcome: "advanced",
        from_state: snapshot.state, to_state: snapshot.state,
        created_jobs: [], message: `from_state 不匹配：期望 ${fromState}，实际 ${snapshot.state}`,
        events_written: 0,
      };
    }

    const transitionId = newTransitionId();

    // prepare
    appendEvent(projectRoot, change, makeEvent(change, "transition_prepare", {
      transition: name, transition_id: transitionId, from_state: fromState, to_state: toState, reason,
    }, { transitionId, idempotencyKey: idemKey, prevSnapshotDigest: worldDigest }));

    // BLOCKER-1 修复：postCommit 在 commit 写入前执行。
    // 如果 postCommit 抛错 → 只有 prepare（无 commit）→ 幂等重试会跳过 prepare 重新执行。
    // 如果 postCommit 成功 → commit + extraEvents 写入 → 一致。
    if (decision.postCommit) {
      decision.postCommit(projectRoot, change, changeRoot);
    }

    // commit（postCommit 成功后才写）
    appendEvent(projectRoot, change, makeEvent(change, "transition_commit", {
      transition: name, from_state: fromState, to_state: toState,
      outcome, created_job_ids: newJobs.map(j => j.job_id), new_jobs: newJobs, reason,
    }, { transitionId, idempotencyKey: idemKey, prevSnapshotDigest: worldDigest }));

    // extra events (task_started, task_completed, etc.)
    for (const ex of extraEvents) {
      appendEvent(projectRoot, change, makeEvent(change, ex.type as Event["event_type"], ex.payload, { transitionId }));
    }

    writeSnapshot(projectRoot, change, rebuildSnapshot(projectRoot, change, changeRoot));

    return {
      transition: name, outcome, from_state: fromState, to_state: toState,
      created_jobs: newJobs.map(j => j.job_id),
      message: outcome === "advanced" ? `状态推进：${fromState} → ${toState}` : `状态不变（${fromState}），创建了 ${newJobs.length} 个工作项`,
      events_written: 1 + extraEvents.length,
      ...(details ? { details } : {}),
    };
  });
}

// ===== propose-ready =====

export function proposeReady(projectRoot: string, change: string, changeRoot: string, risk: "minimal" | "normal" | "strict" = "strict"): TransitionResult {
  return commitTransition(projectRoot, change, changeRoot, {
    name: "propose-ready", idempotencyInputs: { risk },
    decide: (snapshot) => {
      if (snapshot.state !== "propose") return { skip: true, message: `当前状态 ${snapshot.state}，不能 propose-ready` };

      const tasksPath = join(changeRoot, "tasks.md");
      if (!existsSync(tasksPath)) return { skip: true, message: "tasks.md 不存在" };
      const tasksContent = readFileSync(tasksPath, "utf8");
      if (!tasksContent.includes("# Tasks") && !tasksContent.includes("- [ ]")) return { skip: true, message: "tasks.md 内容不像任务计划文档" };

      const openQuestions = collectProposeOpenQuestions(changeRoot);
      if (openQuestions.openCount > 0) {
        const files = openQuestions.files.map(f => `${f.path}(${f.openCount})`).join(", ");
        return { skip: true, message: `计划文档有 ${openQuestions.openCount} 个待用户确认问题：${files}` };
      }

      if (risk !== "minimal") {
        const artifactsDir = join(changeRoot, ".superspec", "artifacts");
        for (const doc of ["discovery.md", "business-invariants.md", "test-contract.md"]) {
          if (!existsSync(join(artifactsDir, doc))) return { skip: true, message: `基础职责缺失：${doc} 不存在（risk=${risk} 需要）` };
        }
      }

      // 通用 job 检查（用提取的 helper）
      const requiredRoles = TRANSITION_REQUIREMENTS["propose-ready"]?.[risk] ?? [];
      const reviewResult = checkOrCreateReviewJobs(
        snapshot, requiredRoles, changeRoot, change, "propose-ready",
        ["proposal.md", "tasks.md", "design.md", ".superspec/artifacts/discovery.md", ".superspec/artifacts/business-invariants.md", ".superspec/artifacts/test-contract.md"],
      );
      if (reviewResult) return reviewResult;

      return { fromState: "propose", toState: "propose_ready", outcome: "advanced" as const, reason: `risk=${risk}，所有需求已满足` };
    },
  });
}

// ===== init =====

export function transitionInit(projectRoot: string, change: string, changeRoot: string): TransitionResult {
  return commitTransition(projectRoot, change, changeRoot, {
    name: "init", idempotencyInputs: { phase: "init" },
    decide: () => {
      const events = readEvents(projectRoot, change);
      if (events.length > 0) return { skip: true, message: "change 已初始化" };
      return { fromState: "init", toState: "init", outcome: "advanced" as const, reason: "引擎初始化" };
    },
  });
}

// ===== explore =====

export function transitionExplore(projectRoot: string, change: string, changeRoot: string, risk: "minimal" | "normal" | "strict" = "strict"): TransitionResult {
  return commitTransition(projectRoot, change, changeRoot, {
    name: "explore", idempotencyInputs: { phase: "explore", risk },
    decide: (snapshot) => {
      if (snapshot.state === "init") return { fromState: "init", toState: "explore", outcome: "advanced" as const, reason: "进入探索阶段" };
      if (snapshot.state === "explore") {
        const discoveryPath = join(changeRoot, ".superspec", "artifacts", "discovery.md");
        if (!existsSync(discoveryPath)) return { skip: true, message: "discovery.md 不存在" };
        // explore→propose：校验 discovery + strict 模式下的 critic 审查
        const discoveryCheck = validateDiscovery(changeRoot);
        if (!discoveryCheck.ok) return { skip: true, message: discoveryCheck.message };

        // 通用 job 审查（和 propose-ready 同一个 helper）
        const requiredRoles = TRANSITION_REQUIREMENTS["explore"]?.[risk] ?? [];
        const reviewResult = checkOrCreateReviewJobs(
          snapshot, requiredRoles, changeRoot, change, "explore",
          [".superspec/artifacts/discovery.md"],
        );
        if (reviewResult) return reviewResult;

        return { fromState: "explore", toState: "propose", outcome: "advanced" as const, reason: "探索完成" };
      }
      return { skip: true, message: `当前状态 ${snapshot.state}，explore 不适用` };
    },
  });
}

// ===== start-apply =====

export function startApply(projectRoot: string, change: string, changeRoot: string): TransitionResult {
  return commitTransition(projectRoot, change, changeRoot, {
    name: "start-apply", idempotencyInputs: { phase: "start-apply" },
    decide: (snapshot) => {
      if (snapshot.state !== "propose_ready") return { skip: true, message: `当前状态 ${snapshot.state}，需要 propose_ready` };
      const reviewedRoles = historicalProposeReadyRoles(projectRoot, change);
      if (reviewedRoles.length > 0) {
        const reviewResult = checkOrCreateReviewJobs(
          snapshot, reviewedRoles, changeRoot, change, "propose-ready",
          ["proposal.md", "tasks.md", "design.md", ".superspec/artifacts/discovery.md", ".superspec/artifacts/business-invariants.md", ".superspec/artifacts/test-contract.md"],
        );
        if (reviewResult) {
          return {
            ...reviewResult,
            reason: `进入 apply 前需要 fresh proposal 审查：${reviewResult.reason}`,
          };
        }
      }
      return { fromState: "propose_ready", toState: "apply", outcome: "advanced" as const, reason: "进入执行阶段" };
    },
  });
}

// ===== task-start =====

let attemptSeq = 0;

export function taskStart(projectRoot: string, change: string, changeRoot: string, taskId: string): TransitionResult {
  return commitTransition(projectRoot, change, changeRoot, {
    name: "task-start", idempotencyInputs: { task: taskId },
    decide: (snapshot) => {
      if (snapshot.state !== "apply") return { skip: true, message: `当前状态 ${snapshot.state}，需要 apply` };
      const tasksContent = readFileSync(join(changeRoot, "tasks.md"), "utf8");
      const lines = tasksContent.split("\n");
      const taskLineIdx = findTaskLine(lines, taskId);
      if (taskLineIdx < 0) return { skip: true, message: `任务 ${taskId} 不存在` };
      if (lines[taskLineIdx].match(/- \[x\]/)) return { skip: true, message: `任务 ${taskId} 已完成` };

      const existing = snapshot.active_task_attempts?.find(a => a.task_id === taskId && a.state === "active");
      if (existing) return { skip: true, message: `任务 ${taskId} 已有活跃尝试` };

      const structureDigest = sha256Text(tasksContent.replace(/- \[[xX]\]/g, "- [ ]"));
      const attempt: TaskAttempt = {
        attempt_id: `ATT-${taskId}-${Date.now()}-${++attemptSeq}`,
        task_id: taskId, state: "active",
        task_structure_digest: structureDigest,
        declared_write_scope: [], pre_edit_source_fingerprint: null,
        pre_edit_red_ref: null, executor_packet_digest: null,
        executor_result_ref: null, post_edit_green_ref: null,
        created_at: new Date().toISOString(),
      };

      return {
        fromState: "apply", toState: "apply", outcome: "advanced" as const,
        reason: `创建任务 ${taskId} 执行尝试`,
        extraEvents: [{ type: "task_started", payload: attempt as unknown as Record<string, unknown> }],
        details: { attempt_id: attempt.attempt_id },
      };
    },
  });
}

// ===== reopen =====

export function reopen(projectRoot: string, change: string, changeRoot: string, to: State, reason: string): TransitionResult {
  return commitTransition(projectRoot, change, changeRoot, {
    name: "reopen", idempotencyInputs: { to, reason },
    decide: (snapshot) => {
      if (to !== "apply") return { skip: true, message: `reopen 当前只支持 --to apply，不支持 ${to}` };
      if (!reason || reason.trim() === "") return { skip: true, message: "reopen 需要非空 --reason" };
      if (snapshot.state !== "apply_done" && snapshot.state !== "review") {
        return { skip: true, message: `当前状态 ${snapshot.state}，不能 reopen 到 apply` };
      }

      const pending = pendingTaskIds(changeRoot);
      if (pending.length === 0) return { skip: true, message: "没有未完成任务，不能 reopen 到 apply" };

      return {
        fromState: snapshot.state,
        toState: "apply",
        outcome: "advanced" as const,
        reason: `${reason.trim()}（pending tasks: ${pending.join(", ")}）`,
      };
    },
  });
}

// ===== review-ready =====

export function reviewReady(projectRoot: string, change: string, changeRoot: string, risk: "minimal" | "normal" | "strict" = "strict"): TransitionResult {
  return commitTransition(projectRoot, change, changeRoot, {
    name: "review-ready", idempotencyInputs: { phase: "review-ready", risk },
    decide: (snapshot) => {
      // 检查是否所有任务已完成
      const pending = pendingTaskIds(changeRoot);
      if (pending.length > 0) return { skip: true, message: formatPendingTaskMessage(pending, "请先通过 next/reopen 继续执行") };

      // 如果当前是 apply，先推进到 apply_done
      if (snapshot.state === "apply") {
        return { fromState: "apply", toState: "apply_done", outcome: "advanced" as const, reason: "所有任务完成" };
      }
      if (snapshot.state === "apply_done") {
        const isReviewReadyVerifier = (job: Job) => job.role === "verifier" && job.created_from_transition === "review-ready";
        const verifierOpen = snapshot.open_jobs.find(isReviewReadyVerifier);
        if (verifierOpen) return { skip: true, message: `有待完成的最终验证工作项 ${verifierOpen.job_id}` };

        const verifierAccepted = snapshot.accepted_jobs.find(isReviewReadyVerifier);
        // minimal 直接推进；normal/strict 需要 review-ready verifier
        if (risk !== "minimal" && !verifierAccepted) {
          const docPaths = ["proposal.md", "tasks.md", "design.md", ".superspec/artifacts/discovery.md", ".superspec/artifacts/business-invariants.md", ".superspec/artifacts/test-contract.md"];
          const boundFiles: Ref[] = docPaths.filter(p => existsSync(join(changeRoot, p))).map(p => ({ path: p, sha: sha256File(join(changeRoot, p)) ?? "sha256:missing" }));
          const job: Job = {
            job_id: newJobId(change, "verifier"), role: "verifier", state: "requested" as const,
            boundFiles, packet_digest: sha256Text(JSON.stringify({ role: "verifier", boundFiles, created_from_transition: "review-ready" })),
            created_from_transition: "review-ready", created_at: new Date().toISOString(),
          };
          return {
            fromState: "apply_done", toState: "apply_done", outcome: "job_created" as const,
            newJobs: [job], reason: "创建最终验证工作项",
          };
        }
        return { fromState: "apply_done", toState: "review", outcome: "advanced" as const, reason: "最终验证已接受，进入审查阶段" };
      }
      return { skip: true, message: `当前状态 ${snapshot.state}，review-ready 不适用` };
    },
  });
}

// ===== accept =====

export function accept(projectRoot: string, change: string, changeRoot: string): TransitionResult {
  return commitTransition(projectRoot, change, changeRoot, {
    name: "accept", idempotencyInputs: { phase: "accept" },
    decide: (snapshot) => {
      if (snapshot.state !== "review") return { skip: true, message: `当前状态 ${snapshot.state}，需要 review` };
      const pending = pendingTaskIds(changeRoot);
      if (pending.length > 0) return { skip: true, message: formatPendingTaskMessage(pending, "请先 reopen --to apply 继续执行") };
      return { fromState: "review", toState: "accepted", outcome: "advanced" as const, reason: "审查通过" };
    },
  });
}

// ===== archive =====

export function archive(projectRoot: string, change: string, changeRoot: string): TransitionResult {
  return commitTransition(projectRoot, change, changeRoot, {
    name: "archive", idempotencyInputs: { phase: "archive" },
    decide: (snapshot) => {
      if (snapshot.state !== "accepted") return { skip: true, message: `当前状态 ${snapshot.state}，需要 accepted` };
      // 构建保全清单（Phase 4 简化版：记录文档指纹 + specs/）
      const manifest: Record<string, string> = {};
      const docPaths = ["proposal.md", "tasks.md", "design.md", ".superspec/artifacts/discovery.md", ".superspec/artifacts/business-invariants.md", ".superspec/artifacts/test-contract.md"];
      for (const p of docPaths) {
        manifest[p] = sha256File(join(changeRoot, p)) ?? "sha256:missing";
      }
      // specs/ 目录
      const specsDir = join(changeRoot, "specs");
      if (existsSync(specsDir)) {
        for (const f of readdirSync(specsDir)) {
          if (f.endsWith(".md")) manifest[`specs/${f}`] = sha256File(join(specsDir, f)) ?? "sha256:missing";
        }
      }
      return {
        fromState: "accepted", toState: "archive", outcome: "advanced" as const,
        reason: "归档完成",
        extraEvents: [{ type: "artifact_recorded", payload: { kind: "archive_preservation_manifest", manifest } }],
      };
    },
  });
}

// ===== task-complete =====

export function taskComplete(projectRoot: string, change: string, changeRoot: string, taskId: string): TransitionResult {
  return commitTransition(projectRoot, change, changeRoot, {
    name: "task-complete", idempotencyInputs: { task: taskId, phase: "complete" },
    decide: (snapshot) => {
      if (snapshot.state !== "apply") return { skip: true, message: `当前状态 ${snapshot.state}，需要 apply` };
      const attempt = snapshot.active_task_attempts?.find(a => a.task_id === taskId && a.state === "active");
      if (!attempt) return { skip: true, message: `任务 ${taskId} 无活跃执行尝试` };

      const tasksContent = readFileSync(join(changeRoot, "tasks.md"), "utf8");
      const currentDigest = sha256Text(tasksContent.replace(/- \[[xX]\]/g, "- [ ]"));
      if (currentDigest !== attempt.task_structure_digest) return { skip: true, message: "任务结构指纹不匹配" };

      // 解析任务属性（委托给 format.ts 的 parseTasksMd）
      const tasks = parseTasksMd(tasksContent);
      const taskInfo = tasks.find(t => t.taskId === taskId);
      const isTdd = taskInfo?.tddRequired ?? true;
      const hasNoTddReason = taskInfo?.noTddReason != null;

      // RED/GREEN 检查（HIGH-2 修复：按 attempt_id 匹配，避免多任务 digest 碰撞）
      const events = readEvents(projectRoot, change);
      let hasRed = false, hasGreen = false;
      for (const ev of events) {
        if (ev.event_type === "test_run_recorded") {
          const tr = ev.payload as { task_structure_digest?: string; attempt_id?: string; semantic_status?: string };
          // 匹配当前 attempt（优先按 attempt_id，回退到 digest）
          const matches = tr.attempt_id === attempt.attempt_id ||
            (!tr.attempt_id && tr.task_structure_digest === attempt.task_structure_digest);
          if (matches) {
            if (tr.semantic_status === "expected_failure" || tr.semantic_status === "characterization_pass") hasRed = true;
            if (tr.semantic_status === "expected_success") hasGreen = true;
          }
        }
      }

      if (isTdd) {
        if (!hasRed) return { skip: true, message: `TDD 任务 ${taskId} 缺少 RED 证据` };
        if (!hasGreen) return { skip: true, message: `TDD 任务 ${taskId} 缺少 GREEN 证据` };
      } else {
        if (!hasNoTddReason) return { skip: true, message: `非 TDD 任务 ${taskId} 缺少 no_tdd_reason` };
      }

      // B1 修复：checkbox 写入移到 postCommit（commit 事件写入后执行）
      return {
        fromState: "apply", toState: "apply", outcome: "advanced" as const,
        reason: `任务 ${taskId} 完成`,
        extraEvents: [{ type: "task_completed", payload: { task_id: taskId, attempt_id: attempt.attempt_id } }],
        postCommit: (_pr: string, _ch: string, cr: string) => {
          const lines = readFileSync(join(cr, "tasks.md"), "utf8").split("\n");
          const idx = findTaskLine(lines, taskId);
          if (idx < 0 || !lines[idx].match(/- \[ \]/)) throw new Error(`找不到 ${taskId} 的未完成复选框`);
          // H2 修复：应用前验证结构指纹
          const beforeDigest = sha256Text(lines.join("\n").replace(/- \[[xX]\]/g, "- [ ]"));
          lines[idx] = lines[idx].replace(/- \[ \]/, "- [x]");
          writeFileSync(join(cr, "tasks.md"), lines.join("\n"));
          // H2 修复：应用后验证只有目标变了
          const afterLines = readFileSync(join(cr, "tasks.md"), "utf8").split("\n");
          const afterDigest = sha256Text(afterLines.join("\n").replace(/- \[[xX]\]/g, "- [ ]"));
          if (afterDigest !== beforeDigest) {
            afterLines[idx] = afterLines[idx].replace(/- \[x\]/, "- [ ]");
            writeFileSync(join(cr, "tasks.md"), afterLines.join("\n"));
            throw new Error(`复选框补丁导致结构变化：${taskId}`);
          }
        },
      };
    },
  });
}
