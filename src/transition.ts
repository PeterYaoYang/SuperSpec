// SuperSpec 流程引擎 — transition：提交协议 + 所有 transition 处理器

import { join } from "node:path";
import { existsSync, readFileSync, writeFileSync, readdirSync } from "node:fs";
import {
  ensureChangeLayout, readEvents, appendEvent, makeEvent,
  writeSnapshot, snapshotDigest, withLock, idempotencyKey,
  sha256File, sha256Text,
} from "./store.ts";
import { rebuildSnapshot } from "./sync.ts";
import { requiredJobActions } from "./job_action.ts";
import {
  assertCommitPayloadExtension,
  isFreshReviewVerifier,
  isReviewReadyVerifier,
  readReviewPolicyFromEvents,
  reviewBoundFiles,
  reviewEvidenceDigest,
  reviewPolicyForRisk,
  REVIEW_DOC_PATHS,
} from "./review.ts";
import {
  codeReviewBoundFiles,
  codeReviewJobStaleReason,
  codeReviewPacketDigest,
  collectCodeReviewGateFacts,
  requiresFinalVerifierForCurrentReview,
  scanCodeChanges,
} from "./code_review.ts";
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
): Decision | BlockedDecision | null {
  const staleRoles: { role: JobRole; reason: string }[] = [];
  for (const role of requiredRoles) {
    const openForRole = snapshot.open_jobs.find(j => j.role === role && j.created_from_transition === transitionName);
    if (openForRole) return { blocked: true, reason: `状态未推进；已有待完成工作项 ${role}（${openForRole.job_id}）`, jobs: [openForRole] };
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

function hasRejectedReviewReadyVerifier(events: Event[]): boolean {
  const reviewReadyVerifierIds = new Set<string>();
  for (const ev of events) {
    if (ev.event_type !== "transition_commit") continue;
    const newJobs = (ev.payload as { new_jobs?: Job[] }).new_jobs ?? [];
    for (const job of newJobs) {
      if (isReviewReadyVerifier(job)) reviewReadyVerifierIds.add(job.job_id);
    }
  }
  return events.some(ev =>
    ev.event_type === "job_rejected" &&
    reviewReadyVerifierIds.has((ev.payload as { job_id?: string }).job_id ?? "")
  );
}

function createCodeReviewerJob(
  change: string,
  projectRoot: string,
  events: Event[],
): { job: Job; scanReason: string } {
  const scan = scanCodeChanges(projectRoot);
  const boundFiles = codeReviewBoundFiles(projectRoot, scan.paths);
  const facts = collectCodeReviewGateFacts(events);
  const latestRejected = facts.latestRejected;
  const previousRejection = latestRejected && latestRejected.state === "rejected"
    ? {
      result_kind: latestRejected.result_kind ?? "invalid_report",
      reason: latestRejected.reason ?? "缺少拒绝原因",
      job_id: latestRejected.job.job_id,
    }
    : undefined;
  const packetInput = {
    role: "code-reviewer" as const,
    boundFiles,
    checkedDocs: REVIEW_DOC_PATHS,
    created_from_transition: "review-ready",
    ...(previousRejection ? { previous_rejection: previousRejection } : {}),
  };
  return {
    scanReason: scan.reason,
    job: {
      job_id: newJobId(change, "code-reviewer"),
      role: "code-reviewer",
      state: "requested" as const,
      boundFiles,
      packet_digest: codeReviewPacketDigest(packetInput),
      created_from_transition: "review-ready",
      created_at: new Date().toISOString(),
      ...(previousRejection ? { previous_rejection: previousRejection } : {}),
    },
  };
}

interface CodeReviewFindingRef {
  jobId: string;
  findingId: string;
}

function parseCodeReviewFindingRef(value: string): CodeReviewFindingRef | null {
  const idx = value.indexOf("#");
  if (idx <= 0 || idx === value.length - 1) return null;
  return { jobId: value.slice(0, idx), findingId: value.slice(idx + 1) };
}

function findReviewFailedFinding(events: Event[], ref: CodeReviewFindingRef): { event: Event; finding: Record<string, unknown> } | null {
  for (let i = events.length - 1; i >= 0; i--) {
    const ev = events[i];
    if (ev.event_type !== "job_rejected") continue;
    const payload = ev.payload as { job_id?: unknown; result_kind?: unknown; findings?: unknown };
    if (payload.job_id !== ref.jobId || payload.result_kind !== "review_failed") continue;
    const findings = Array.isArray(payload.findings) ? payload.findings : [];
    for (const raw of findings) {
      if (!raw || typeof raw !== "object" || Array.isArray(raw)) continue;
      const finding = raw as Record<string, unknown>;
      if (finding.id === ref.findingId) return { event: ev, finding };
    }
  }
  return null;
}

function hasUserDecision(events: Event[], scope: string, answer: string): boolean {
  return events.some(ev =>
    ev.event_type === "user_decision_recorded" &&
    (ev.payload as { scope?: unknown; answer?: unknown }).scope === scope &&
    (ev.payload as { scope?: unknown; answer?: unknown }).answer === answer
  );
}

function reviewFixMarker(ref: CodeReviewFindingRef): string {
  return `review_fix_of:${ref.jobId}#${ref.findingId}`;
}

function reviewFixTaskId(ref: CodeReviewFindingRef): string {
  return `REVIEW-FIX-${ref.jobId}#${ref.findingId}`;
}

function appendReviewFixTask(changeRoot: string, ref: CodeReviewFindingRef, finding: Record<string, unknown>): "created" | "exists" {
  const tasksPath = join(changeRoot, "tasks.md");
  const content = readFileSync(tasksPath, "utf8");
  const marker = reviewFixMarker(ref);
  if (content.includes(marker)) return "exists";

  const description = typeof finding.description === "string" && finding.description.trim()
    ? finding.description.trim().replace(/\s+/g, " ")
    : `修复代码审查问题 ${ref.findingId}`;
  const line = `- [ ] ${reviewFixTaskId(ref)} ${description} tdd_required:true ${marker}`;
  const suffix = content.endsWith("\n") ? "" : "\n";
  writeFileSync(tasksPath, `${content}${suffix}${line}\n`);
  return "created";
}

function isFreshOpenCodeReviewerJob(job: Job, projectRoot: string): boolean {
  return codeReviewJobStaleReason(projectRoot, job) == null;
}

function documentBaseline(changeRoot: string): Record<string, string> {
  const docs = ["proposal.md", "design.md", "tasks.md", ".superspec/artifacts/test-contract.md"];
  const baseline: Record<string, string> = {};
  for (const doc of docs) {
    baseline[doc] = sha256File(join(changeRoot, doc)) ?? "sha256:missing";
  }
  return baseline;
}

function latestReopenProposeBaseline(events: Event[]): Record<string, string> | null {
  for (let i = events.length - 1; i >= 0; i--) {
    const ev = events[i];
    if (ev.event_type !== "transition_commit") continue;
    const payload = ev.payload as { transition?: unknown; reopen_target?: unknown; baseline_docs?: unknown };
    if (payload.transition !== "reopen" || payload.reopen_target !== "propose") continue;
    if (!payload.baseline_docs || typeof payload.baseline_docs !== "object" || Array.isArray(payload.baseline_docs)) return null;
    return payload.baseline_docs as Record<string, string>;
  }
  return null;
}

function proposalDocsChangedSinceBaseline(changeRoot: string, baseline: Record<string, string>): boolean {
  const current = documentBaseline(changeRoot);
  return Object.entries(baseline).some(([path, digest]) => current[path] !== digest);
}

interface Decision {
  fromState: State;
  toState: State;
  outcome: "advanced" | "job_created";
  newJobs?: Job[];
  reason: string;
  commitPayload?: Record<string, unknown>;
  extraEvents?: { type: string; payload: Record<string, unknown> }[];
  details?: Record<string, unknown>;
  postCommit?: (projectRoot: string, change: string, changeRoot: string) => void;
}

interface SkipDecision {
  skip: true;
  message: string;
}

interface BlockedDecision {
  blocked: true;
  reason: string;
  jobs: Job[];
  details?: Record<string, unknown>;
}

/**
 * 统一 transition 提交协议——所有校验在锁内。
 */
export function commitTransition(
  projectRoot: string, change: string, changeRoot: string,
  opts: {
    name: string;
    decide: (snapshot: Snapshot) => Decision | SkipDecision | BlockedDecision;
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
      const p = existing.payload as { outcome: string; from_state: State; to_state: State; created_job_ids?: string[]; new_jobs?: Job[] };
      const newJobs = p.new_jobs ?? [];
      return {
        transition: name, outcome: p.outcome as "advanced" | "job_created",
        from_state: p.from_state, to_state: p.to_state,
        created_jobs: p.created_job_ids ?? [], message: "幂等返回", events_written: 0,
        ...(newJobs.length > 0 ? { required_jobs: requiredJobActions(change, newJobs) } : {}),
      };
    }

    const decision = opts.decide(snapshot);
    if ("blocked" in decision) {
      return {
        transition: name,
        outcome: "blocked",
        from_state: snapshot.state,
        to_state: snapshot.state,
        created_jobs: [],
        required_jobs: requiredJobActions(change, decision.jobs),
        message: decision.reason,
        events_written: 0,
        ...(decision.details ? { details: decision.details } : {}),
      };
    }
    if ("skip" in decision) {
      return {
        transition: name, outcome: "advanced",
        from_state: snapshot.state, to_state: snapshot.state,
        created_jobs: [], message: decision.message, events_written: 0,
      };
    }

    const { fromState, toState, outcome, newJobs = [], reason, commitPayload = {}, extraEvents = [], details } = decision;
    assertCommitPayloadExtension(commitPayload);

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
      ...commitPayload,
    }, { transitionId, idempotencyKey: idemKey, prevSnapshotDigest: worldDigest }));

    // extra events (task_started, task_completed, etc.)
    for (const ex of extraEvents) {
      appendEvent(projectRoot, change, makeEvent(change, ex.type as Event["event_type"], ex.payload, { transitionId }));
    }

    writeSnapshot(projectRoot, change, rebuildSnapshot(projectRoot, change, changeRoot));

    return {
      transition: name, outcome, from_state: fromState, to_state: toState,
      created_jobs: newJobs.map(j => j.job_id),
      ...(newJobs.length > 0 ? { required_jobs: requiredJobActions(change, newJobs) } : {}),
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
      const events = readEvents(projectRoot, change);
      const reopenBaseline = latestReopenProposeBaseline(events);
      if (reopenBaseline && !proposalDocsChangedSinceBaseline(changeRoot, reopenBaseline)) {
        return { skip: true, message: "回到 propose 后 proposal/design/tasks/test-contract 至少一个文档必须变化" };
      }
      const reviewedRoles = historicalProposeReadyRoles(projectRoot, change);
      if (reviewedRoles.length > 0) {
        const reviewResult = checkOrCreateReviewJobs(
          snapshot, reviewedRoles, changeRoot, change, "propose-ready",
          ["proposal.md", "tasks.md", "design.md", ".superspec/artifacts/discovery.md", ".superspec/artifacts/business-invariants.md", ".superspec/artifacts/test-contract.md"],
        );
        if (reviewResult) {
          return {
            ...reviewResult,
            reason: `进入执行阶段前需要重新完成计划文档审查：${reviewResult.reason}`,
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

export function reopen(
  projectRoot: string,
  change: string,
  changeRoot: string,
  to: State,
  reason: string,
  opts: { reviewFix?: string; reviewFinding?: string } = {},
): TransitionResult {
  return commitTransition(projectRoot, change, changeRoot, {
    name: "reopen", idempotencyInputs: { to, reason, reviewFix: opts.reviewFix ?? "", reviewFinding: opts.reviewFinding ?? "" },
    decide: (snapshot) => {
      if (!reason || reason.trim() === "") return { skip: true, message: "reopen 需要非空 --reason" };
      const events = readEvents(projectRoot, change);

      if (opts.reviewFinding) {
        if (to !== "propose") return { skip: true, message: "--review-finding 只能用于回到计划阶段（reopen --to propose）" };
        if (snapshot.state !== "apply_done") return { skip: true, message: `当前状态 ${snapshot.state}，不能通过代码审查问题回到计划阶段` };
        const ref = parseCodeReviewFindingRef(opts.reviewFinding);
        if (!ref) return { skip: true, message: "--review-finding 必须是 <job_id>#<finding_id>" };
        const found = findReviewFailedFinding(events, ref);
        if (!found) return { skip: true, message: `找不到有效的代码审查问题 ${opts.reviewFinding}` };
        const type = found.finding.type;
        if (type !== "spec" && type !== "mixed") return { skip: true, message: "只有方案/需求文档问题或混合问题可以回到计划阶段" };
        const scope = `code_review_decision:${ref.jobId}#${ref.findingId}`;
        if (!hasUserDecision(events, scope, "reopen_propose")) return { skip: true, message: `缺少使用者确认：需要先确认问题 ${ref.findingId} 是否回到计划阶段` };
        return {
          fromState: "apply_done",
          toState: "propose",
          outcome: "advanced" as const,
          reason: reason.trim(),
          commitPayload: {
            reopen_target: "propose",
            source_job_id: ref.jobId,
            finding_id: ref.findingId,
            decision_scope: scope,
            baseline_docs: documentBaseline(changeRoot),
          },
        };
      }

      if (opts.reviewFix) {
        if (to !== "apply") return { skip: true, message: "--review-fix 只能用于回到实现阶段（reopen --to apply）" };
        if (snapshot.state !== "apply_done") return { skip: true, message: `当前状态 ${snapshot.state}，不能通过代码审查修复回到实现阶段` };
        const ref = parseCodeReviewFindingRef(opts.reviewFix);
        if (!ref) return { skip: true, message: "--review-fix 必须是 <job_id>#<finding_id>" };
        const found = findReviewFailedFinding(events, ref);
        if (!found) return { skip: true, message: `找不到有效的代码审查问题 ${opts.reviewFix}` };
        const type = found.finding.type;
        if (type === "spec" || type === "mixed") {
          const scope = `code_review_decision:${ref.jobId}#${ref.findingId}`;
          if (!hasUserDecision(events, scope, "fix_in_apply")) return { skip: true, message: `缺少使用者确认：需要先确认问题 ${ref.findingId} 是否直接回到实现阶段修复` };
        } else if (type !== "implementation") {
          return { skip: true, message: "这个代码审查问题不能直接回到实现阶段处理" };
        }
        return {
          fromState: "apply_done",
          toState: "apply",
          outcome: "advanced" as const,
          reason: reason.trim(),
          commitPayload: {
            review_fix_of: `${ref.jobId}#${ref.findingId}`,
            source_job_id: ref.jobId,
            finding_id: ref.findingId,
          },
          postCommit: (_pr, _ch, cr) => {
            appendReviewFixTask(cr, ref, found.finding);
          },
        };
      }

      if (to !== "apply") return { skip: true, message: `reopen 当前只支持 --to apply 或 --to propose，不支持 ${to}` };
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
      const events = readEvents(projectRoot, change);
      const storedPolicy = readReviewPolicyFromEvents(events);
      const policy = storedPolicy ?? reviewPolicyForRisk(risk);
      const policyPayload = storedPolicy ? {} : { review_policy: policy };
      const currentEvidenceDigest = reviewEvidenceDigest(events);

      // 检查是否所有任务已完成
      const pending = pendingTaskIds(changeRoot);
      if (pending.length > 0) return { skip: true, message: formatPendingTaskMessage(pending, "请先通过 next/reopen 继续执行") };

      // 如果当前是 apply，先推进到 apply_done
      if (snapshot.state === "apply") {
        return {
          fromState: "apply", toState: "apply_done", outcome: "advanced" as const,
          reason: `所有任务完成；审查策略=${policy.review_risk}`,
          commitPayload: policyPayload,
        };
      }
      if (snapshot.state === "apply_done") {
        const scan = scanCodeChanges(projectRoot);
        const facts = collectCodeReviewGateFacts(events);
        if (scan.hasCodeChanges) {
          const freshOpenJobs = facts.openJobs.filter(job => isFreshOpenCodeReviewerJob(job, projectRoot));
          if (freshOpenJobs.length > 0) {
            return {
              blocked: true,
              reason: `状态未推进；已有待完成代码审查工作项 ${freshOpenJobs[0].job_id}`,
              jobs: [freshOpenJobs[0]],
            };
          }

          const latest = facts.latestTerminal;
          if (latest?.state === "accepted") {
            return {
              fromState: "apply_done", toState: "review", outcome: "advanced" as const,
              reason: "代码审查已通过，进入最终审查阶段",
              commitPayload: {
                ...policyPayload,
                code_review_gate: { decision: "passed", job_id: latest.job.job_id },
              },
            };
          }
          if (latest?.state === "rejected" && latest.result_kind === "review_failed") {
            return {
              skip: true,
              message: "代码审查发现需要处理的问题，请先执行 next，根据提示回到实现阶段修复或让使用者决定是否回到计划阶段",
            };
          }

          const { job, scanReason } = createCodeReviewerJob(change, projectRoot, events);
          return {
            fromState: "apply_done", toState: "apply_done", outcome: "job_created" as const,
            newJobs: [job],
            reason: latest?.state === "rejected"
              ? `重新创建代码审查工作项；上一次报告未被接受，原因：${latest.reason ?? "报告不符合要求"}`
              : `创建代码审查工作项；${scanReason}`,
          };
        }

        return {
          fromState: "apply_done", toState: "review", outcome: "advanced" as const,
          reason: "没有代码类改动，直接进入最终审查阶段",
          commitPayload: {
            ...policyPayload,
            code_review_gate: { decision: "skipped", reason: "no_code_changes" },
          },
        };
      }

      if (snapshot.state === "review") {
        const verifierOpen = snapshot.open_jobs.find(isReviewReadyVerifier);
        if (verifierOpen) return { blocked: true, reason: `状态未推进；已有待完成最终验证工作项 ${verifierOpen.job_id}`, jobs: [verifierOpen] };

        const verifierAccepted = snapshot.accepted_jobs.find(job => isFreshReviewVerifier(job, changeRoot, currentEvidenceDigest));
        const finalVerifierRequired = requiresFinalVerifierForCurrentReview(events) || policy.requires_verifier;
        if (!finalVerifierRequired) {
          if (!storedPolicy) {
            return {
              fromState: "review", toState: "review", outcome: "advanced" as const,
              reason: `补写审查策略=${policy.review_risk}`,
              commitPayload: policyPayload,
            };
          }
          return { skip: true, message: "已在 review 状态，审查策略无需 verifier" };
        }

        if (!verifierAccepted) {
          const boundFiles = reviewBoundFiles(changeRoot);
          const previousVerifierRejected = hasRejectedReviewReadyVerifier(events);
          const job: Job = {
            job_id: newJobId(change, "verifier"), role: "verifier", state: "requested" as const,
            boundFiles, review_evidence_digest: currentEvidenceDigest,
            packet_digest: sha256Text(JSON.stringify({
              role: "verifier",
              boundFiles,
              review_evidence_digest: currentEvidenceDigest,
              created_from_transition: "review-ready",
            })),
            created_from_transition: "review-ready", created_at: new Date().toISOString(),
          };
          return {
            fromState: snapshot.state, toState: snapshot.state, outcome: "job_created" as const,
            newJobs: [job],
            reason: previousVerifierRejected
              ? "此前最终验证未通过；请先根据验证报告修改任务或文档，确认无需修改时再执行新的最终验证工作项"
              : "创建最终验证工作项",
            commitPayload: policyPayload,
            ...(previousVerifierRejected ? {
              details: { advisory: "此前最终验证未通过；请先根据验证报告修改任务或文档，确认无需修改时再执行新的最终验证工作项" },
            } : {}),
          };
        }

        if (!storedPolicy) {
          return {
            fromState: "review", toState: "review", outcome: "advanced" as const,
            reason: `补写审查策略=${policy.review_risk}`,
            commitPayload: policyPayload,
          };
        }
        return { skip: true, message: "已在 review 状态，最终验证仍然有效" };
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
      const events = readEvents(projectRoot, change);
      const policy = readReviewPolicyFromEvents(events);
      if (!policy) return { skip: true, message: "缺少审查策略，请先运行 review-ready" };
      if (requiresFinalVerifierForCurrentReview(events) || policy.requires_verifier) {
        const currentEvidenceDigest = reviewEvidenceDigest(events);
        const verifierAccepted = snapshot.accepted_jobs.find(job => isFreshReviewVerifier(job, changeRoot, currentEvidenceDigest));
        if (!verifierAccepted) return { skip: true, message: "缺少仍然匹配当前证据的最终验证，请先运行 review-ready" };
      }
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
