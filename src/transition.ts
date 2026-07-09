// SuperSpec 流程引擎 — transition：提交协议 + 所有 transition 处理器

import { join } from "node:path";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import {
  ensureChangeLayout, readEvents, appendEvent, makeEvent,
  writeSnapshot, snapshotDigest, withLock, idempotencyKey,
  docRef, listMarkdownFiles, sha256File, sha256Text,
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
  type ReviewPolicy,
} from "./review.ts";
import {
  REVIEW_CODE_REVIEW_GATE_ID,
  REVIEW_FINAL_VERIFIER_GATE_ID,
  type ReviewGateRule,
} from "./review_job_gates.ts";
import {
  codeReviewBoundFiles,
  codeReviewDecisionScope,
  codeReviewJobStaleReason,
  codeReviewPacketContext,
  codeReviewPacketDigest,
  collectCodeReviewGateFacts,
  computeCodeStateCheck,
  currentCodeReviewWorkingPaths,
  dismissedCodeReviewSummary,
  latestCodeReviewDecision,
  latestCodeReviewFailedStatus,
  missingCoverageExemptionTestIds,
  requiresFinalVerifierForCurrentReview,
  scanCodeChangesForReview,
} from "./code_review.ts";
import { taskEvidenceReadiness } from "./task_evidence.ts";
import {
  adoptedContractForTask,
  findTaskInLines,
  isReviewFixTaskId,
  parseTasksMd,
  parseTestContractEntries,
  type ParsedExecutionRequirement,
} from "./format.ts";
import {
  applyRequirementModeForCurrentRound,
  formatPendingTaskMessage,
  pendingTaskStatusForApply,
  planTransition,
  proposalDocsBaseline,
  type TransitionDecisionPlan,
} from "./phase_plan.ts";
import { currentGitHead, dirtyCodeFiles } from "./git_state.ts";
import type { CodeReviewScope, Event, Snapshot, State, Job, JobRole, TransitionResult, Ref, TaskAttempt, BoundarySnapshot } from "./types.ts";

let transitionSeq = 0;
function newTransitionId(): string { return `T-${Date.now()}-${++transitionSeq}`; }
let jobSeq = 0;
function newJobId(change: string, role: string): string { return `JOB-${change.slice(0, 8)}-${role.slice(0, 4)}-${Date.now()}-${++jobSeq}`; }

function createReviewJobsForGate(
  state: State,
  gate: ReviewGateRule,
  roles: JobRole[],
  changeRoot: string,
  change: string,
  reason: string,
): Decision {
  const newJobs: Job[] = roles.map(role => {
    // 目录路径（以 / 结尾）始终绑定聚合指纹：审查时不存在、审查后新建同样视为变化
    const boundFiles: Ref[] = gate.reviewedDocPaths
      .filter(p => p.endsWith("/") || existsSync(join(changeRoot, p)))
      .map(p => docRef(changeRoot, p));
    return {
      job_id: newJobId(change, role),
      role,
      state: "requested" as const,
      gate_id: gate.gate_id,
      boundFiles,
      packet_digest: sha256Text(JSON.stringify({
        role,
        gate_id: gate.gate_id,
        boundFiles,
        created_from_transition: gate.created_from_transition,
      })),
      created_from_transition: gate.created_from_transition,
      created_at: new Date().toISOString(),
    };
  });
  return {
    fromState: state,
    toState: state,
    outcome: "job_created",
    newJobs,
    reason,
  };
}

/**
 * 已迁移到 format.ts：findTaskInLines / parseTasksMd / tasksStructureDigest
 * 以下保留 findTaskLine 作为兼容 wrapper（内部调用 format.ts）
 */
function findTaskLine(lines: string[], taskId: string): number {
  return findTaskInLines(lines, taskId);
}

function boundarySnapshotResult(projectRoot: string): { snapshot: BoundarySnapshot | null; reason?: string } {
  const head = currentGitHead(projectRoot);
  const dirty = dirtyCodeFiles(projectRoot);
  if (!dirty.ok) return { snapshot: null, reason: dirty.reason };
  return {
    snapshot: {
      head: head.head,
      ...(head.reason !== "ok" ? { head_reason: head.reason } : {}),
      dirty_files: dirty.files,
    },
  };
}

function boundarySnapshotPayload(projectRoot: string): { boundary_snapshot: BoundarySnapshot | null; boundary_snapshot_reason?: string } {
  const result = boundarySnapshotResult(projectRoot);
  return {
    boundary_snapshot: result.snapshot,
    ...(result.reason ? { boundary_snapshot_reason: result.reason } : {}),
  };
}

function parseScopeNoteInput(inputContent: string | null): { ok: true; value: Record<string, unknown> | null; digest: string | null } | { ok: false; message: string; digest: string | null } {
  if (inputContent == null) return { ok: true, value: null, digest: null };
  const digest = sha256Text(inputContent);
  if (inputContent.trim() === "") return { ok: false, message: "范围扩大说明（scope_note）输入不能为空", digest };
  let parsed: unknown;
  try {
    parsed = JSON.parse(inputContent);
  } catch {
    return { ok: false, message: "范围扩大说明（scope_note）输入必须是有效 JSON", digest };
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    return { ok: false, message: "范围扩大说明（scope_note）输入顶层必须是 JSON object", digest };
  }
  const obj = parsed as Record<string, unknown>;
  const keys = Object.keys(obj);
  if (keys.some(key => key !== "scope_note")) {
    return { ok: false, message: "范围扩大说明（scope_note）输入包含未知顶层字段", digest };
  }
  const note = obj.scope_note;
  if (!note || typeof note !== "object" || Array.isArray(note)) {
    return { ok: false, message: "范围扩大说明（scope_note）必须是对象", digest };
  }
  const noteObj = note as Record<string, unknown>;
  const allowed = new Set(["reason", "changed_area", "plan_alignment", "verification"]);
  if (Object.keys(noteObj).some(key => !allowed.has(key))) {
    return { ok: false, message: "范围扩大说明（scope_note）包含未知字段", digest };
  }
  for (const field of ["reason", "changed_area", "plan_alignment"] as const) {
    if (typeof noteObj[field] !== "string" || noteObj[field].trim() === "") {
      return { ok: false, message: `范围扩大说明里的 ${field} 字段（scope_note.${field}）必须是非空字符串`, digest };
    }
  }
  if (!Array.isArray(noteObj.verification) || noteObj.verification.length === 0 || !noteObj.verification.every(item => typeof item === "string" && item.trim() !== "")) {
    return { ok: false, message: "范围扩大说明里的验证字段（scope_note.verification）必须是非空字符串数组", digest };
  }
  return {
    ok: true,
    digest,
    value: {
      reason: noteObj.reason,
      changed_area: noteObj.changed_area,
      plan_alignment: noteObj.plan_alignment,
      verification: noteObj.verification,
    },
  };
}

function validateTaskStartContract(
  changeRoot: string,
  taskId: string,
  tddRequired: boolean,
  parsedContract: ParsedExecutionRequirement | null,
): string | null {
  if (!parsedContract) return null;
  if (parsedContract.errors.length > 0) return parsedContract.errors.join("；");
  if (tddRequired && !isReviewFixTaskId(taskId) && parsedContract.contract.tests.length === 0) {
    return `${taskId} 是普通 TDD 任务，执行依据缺少测试`;
  }
  if (parsedContract.contract.tests.length === 0) return null;

  const testContractPath = join(changeRoot, ".superspec", "artifacts", "test-contract.md");
  if (!existsSync(testContractPath)) return "test-contract.md 不存在，无法校验执行依据测试引用";
  const parsed = parseTestContractEntries(readFileSync(testContractPath, "utf8"));
  if (!parsed.ok) return parsed.message;
  const known = new Set(parsed.entries.map(entry => entry.test_id));
  const missing = parsedContract.contract.tests.filter(testId => !known.has(testId));
  return missing.length > 0 ? `执行依据引用了不存在的 TEST ID：${missing.join(", ")}` : null;
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
  changeRoot: string,
  events: Event[],
): { job: Job; scanReason: string } {
  const scan = scanCodeChangesForReview(projectRoot, events);
  const boundFiles = codeReviewBoundFiles(projectRoot, scan.paths);
  const packetContext = codeReviewPacketContext(changeRoot, projectRoot, scan.scope!, events);
  const facts = collectCodeReviewGateFacts(events);
  const latestRejected = facts.latestRejected;
  const reviewFailedStatus = latestCodeReviewFailedStatus(events);
  const previousRejection = latestRejected && latestRejected.state === "rejected"
    ? {
      result_kind: latestRejected.result_kind ?? "invalid_report",
      reason: latestRejected.result_kind === "review_failed" && reviewFailedStatus && reviewFailedStatus.unresolved.length === 0 && reviewFailedStatus.dismissed.length > 0
        ? dismissedCodeReviewSummary(reviewFailedStatus)
        : latestRejected.reason ?? "缺少拒绝原因",
      job_id: latestRejected.job.job_id,
    }
    : undefined;
  const packetInput = {
    role: "code-reviewer" as const,
    gate_id: REVIEW_CODE_REVIEW_GATE_ID,
    boundFiles,
    checkedDocs: REVIEW_DOC_PATHS,
    packet_context: packetContext,
    created_from_transition: "review-ready",
    ...(previousRejection ? { previous_rejection: previousRejection } : {}),
  };
  return {
    scanReason: scan.reason,
    job: {
      job_id: newJobId(change, "code-reviewer"),
      role: "code-reviewer",
      state: "requested" as const,
      gate_id: REVIEW_CODE_REVIEW_GATE_ID,
      boundFiles,
      packet_context: packetContext,
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
  const status = latestCodeReviewFailedStatus(events);
  if (!status || status.terminal.job.job_id !== ref.jobId) return null;
  const finding = status.findings.find(item => item.id === ref.findingId)?.finding;
  if (!finding) return null;
  return { event: status.terminal.event, finding };
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

function isFreshOpenCodeReviewerJob(job: Job, projectRoot: string, currentWorkingPaths?: string[]): boolean {
  return codeReviewJobStaleReason(projectRoot, job, currentWorkingPaths) == null;
}

function hasFrozenCodeReviewCurrentHead(scope: CodeReviewScope | undefined): scope is CodeReviewScope {
  if (!scope || typeof scope !== "object") return false;
  if (!Object.prototype.hasOwnProperty.call(scope, "current_head")) return false;
  const currentHead = (scope as { current_head?: unknown }).current_head;
  return currentHead === null || (typeof currentHead === "string" && currentHead.trim() !== "");
}

function evaluateApplyDoneCodeReviewGate(input: {
  events: Event[];
  projectRoot: string;
  changeRoot: string;
  change: string;
  policyPayload: Record<string, unknown>;
}): Decision | BlockedDecision | SkipDecision {
  const scan = scanCodeChangesForReview(input.projectRoot, input.events);
  const facts = collectCodeReviewGateFacts(input.events);
  if (scan.hasCodeChanges) {
    const currentWorkingPaths = currentCodeReviewWorkingPaths(input.projectRoot, input.events);
    const freshOpenJobs = facts.openJobs.filter(job => isFreshOpenCodeReviewerJob(job, input.projectRoot, currentWorkingPaths));
    if (freshOpenJobs.length > 0) {
      return {
        blocked: true,
        reason: `状态未推进；已有待完成代码审查工作项 ${freshOpenJobs[0].job_id}`,
        jobs: [freshOpenJobs[0]],
      };
    }

    const latest = facts.latestTerminal;
    if (latest?.state === "accepted") {
      const acceptedScope = latest.job.packet_context?.code_review_scope;
      if (!hasFrozenCodeReviewCurrentHead(acceptedScope)) {
        const { job, scanReason } = createCodeReviewerJob(input.change, input.projectRoot, input.changeRoot, input.events);
        return {
          fromState: "apply_done",
          toState: "apply_done",
          outcome: "job_created" as const,
          newJobs: [job],
          reason: `已接受代码审查工作项缺少冻结 current_head，重新创建代码审查工作项；${scanReason}`,
        };
      }
      return {
        fromState: "apply_done",
        toState: "review",
        outcome: "advanced" as const,
        reason: "代码审查已通过，进入最终审查阶段",
        commitPayload: {
          ...input.policyPayload,
          code_review_gate: {
            decision: "passed",
            job_id: latest.job.job_id,
            packet_digest: latest.job.packet_digest,
            current_head: acceptedScope.current_head,
          },
        },
      };
    }
    if (latest?.state === "rejected" && latest.result_kind === "review_failed") {
      const reviewFailedStatus = latestCodeReviewFailedStatus(input.events);
      if (reviewFailedStatus && reviewFailedStatus.findings.length > 0 && reviewFailedStatus.unresolved.length === 0) {
        const { job, scanReason } = createCodeReviewerJob(input.change, input.projectRoot, input.changeRoot, input.events);
        return {
          fromState: "apply_done",
          toState: "apply_done",
          outcome: "job_created" as const,
          newJobs: [job],
          reason: `重新创建代码审查工作项；${scanReason}；上一次阻塞问题已被主流程复核驳回`,
        };
      }
      return {
        skip: true,
        message: "代码审查发现需要处理的问题，请先执行 next，根据提示回到实现阶段修复或让使用者决定是否回到计划阶段",
      };
    }

    const { job, scanReason } = createCodeReviewerJob(input.change, input.projectRoot, input.changeRoot, input.events);
    return {
      fromState: "apply_done",
      toState: "apply_done",
      outcome: "job_created" as const,
      newJobs: [job],
      reason: latest?.state === "rejected"
        ? `重新创建代码审查工作项；上一次报告未被接受，原因：${latest.reason ?? "报告不符合要求"}`
        : `创建代码审查工作项；${scanReason}`,
    };
  }

  return {
    fromState: "apply_done",
    toState: "review",
    outcome: "advanced" as const,
    reason: "没有代码类改动，直接进入最终审查阶段",
    commitPayload: {
      ...input.policyPayload,
      code_review_gate: {
        decision: "skipped",
        reason: "no_code_changes",
        head: scan.scope?.current_head ?? null,
      },
    },
  };
}

function createFinalVerifierJob(
  change: string,
  projectRoot: string,
  changeRoot: string,
  events: Event[],
  currentEvidenceDigest: string,
): Job {
  const boundFiles = reviewBoundFiles(changeRoot);
  const packetContext = {
    code_state_check: computeCodeStateCheck(projectRoot, events),
  };
  return {
    job_id: newJobId(change, "verifier"),
    role: "verifier",
    state: "requested" as const,
    gate_id: REVIEW_FINAL_VERIFIER_GATE_ID,
    boundFiles,
    review_evidence_digest: currentEvidenceDigest,
    packet_context: packetContext,
    packet_digest: sha256Text(JSON.stringify({
      role: "verifier",
      gate_id: REVIEW_FINAL_VERIFIER_GATE_ID,
      boundFiles,
      review_evidence_digest: currentEvidenceDigest,
      packet_context: packetContext,
      created_from_transition: "review-ready",
    })),
    created_from_transition: "review-ready",
    created_at: new Date().toISOString(),
  };
}

function evaluateFinalVerifierGate(input: {
  snapshot: Snapshot;
  events: Event[];
  change: string;
  projectRoot: string;
  changeRoot: string;
  currentEvidenceDigest: string;
  policy: ReviewPolicy;
  policyPayload: Record<string, unknown>;
  hasStoredPolicy: boolean;
}): Decision | BlockedDecision | SkipDecision {
  const verifierOpen = input.snapshot.open_jobs.find(isReviewReadyVerifier);
  if (verifierOpen) {
    return {
      blocked: true,
      reason: `状态未推进；已有待完成最终验证工作项 ${verifierOpen.job_id}`,
      jobs: [verifierOpen],
    };
  }

  const verifierAccepted = input.snapshot.accepted_jobs.find(job =>
    isFreshReviewVerifier(job, input.changeRoot, input.currentEvidenceDigest, input.projectRoot, input.events)
  );
  const finalVerifierRequired = requiresFinalVerifierForCurrentReview(input.events) || input.policy.requires_verifier;
  if (!finalVerifierRequired) {
    if (!input.hasStoredPolicy) {
      return {
        fromState: "review",
        toState: "review",
        outcome: "advanced" as const,
        reason: `补写审查策略=${input.policy.review_risk}`,
        commitPayload: input.policyPayload,
      };
    }
    return { skip: true, message: "已在 review 状态，审查策略无需 verifier" };
  }

  if (!verifierAccepted) {
    const previousVerifierRejected = hasRejectedReviewReadyVerifier(input.events);
    const job = createFinalVerifierJob(input.change, input.projectRoot, input.changeRoot, input.events, input.currentEvidenceDigest);
    return {
      fromState: input.snapshot.state,
      toState: input.snapshot.state,
      outcome: "job_created" as const,
      newJobs: [job],
      reason: previousVerifierRejected
        ? "此前最终验证未通过；请先根据验证报告修改任务或文档，确认无需修改时再执行新的最终验证工作项"
        : "创建最终验证工作项",
      commitPayload: input.policyPayload,
      ...(previousVerifierRejected ? {
        details: { advisory: "此前最终验证未通过；请先根据验证报告修改任务或文档，确认无需修改时再执行新的最终验证工作项" },
      } : {}),
    };
  }

  if (!input.hasStoredPolicy) {
    return {
      fromState: "review",
      toState: "review",
      outcome: "advanced" as const,
      reason: `补写审查策略=${input.policy.review_risk}`,
      commitPayload: input.policyPayload,
    };
  }
  return { skip: true, message: "已在 review 状态，最终验证仍然有效" };
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

function transitionPlanToDecision(
  snapshot: Snapshot,
  changeRoot: string,
  change: string,
  plan: TransitionDecisionPlan,
): Decision | SkipDecision | BlockedDecision {
  switch (plan.kind) {
    case "skip":
      return { skip: true, message: plan.message };
    case "blocked":
      return { blocked: true, reason: plan.reason, jobs: plan.jobs };
    case "create_gate_jobs":
      return createReviewJobsForGate(snapshot.state, plan.gate, plan.roles, changeRoot, change, plan.reason);
    case "advance":
      return {
        fromState: plan.fromState,
        toState: plan.toState,
        outcome: "advanced",
        reason: plan.reason,
        commitPayload: plan.payload,
      };
  }
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
      const events = readEvents(projectRoot, change);
      const plan = planTransition("propose-ready", {
        projectRoot,
        change,
        changeRoot,
        events,
        snapshot,
        mode: { kind: "risk", risk },
      });
      return transitionPlanToDecision(snapshot, changeRoot, change, plan);
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
      const events = readEvents(projectRoot, change);
      const plan = planTransition("explore", {
        projectRoot,
        change,
        changeRoot,
        events,
        snapshot,
        mode: { kind: "risk", risk },
      });
      return transitionPlanToDecision(snapshot, changeRoot, change, plan);
    },
  });
}

// ===== start-apply =====

export function startApply(projectRoot: string, change: string, changeRoot: string): TransitionResult {
  return commitTransition(projectRoot, change, changeRoot, {
    name: "start-apply", idempotencyInputs: { phase: "start-apply" },
    decide: (snapshot) => {
      const events = readEvents(projectRoot, change);
      const plan = planTransition("start-apply", {
        projectRoot,
        change,
        changeRoot,
        events,
        snapshot,
        mode: { kind: "risk", risk: "strict" },
      });
      return transitionPlanToDecision(snapshot, changeRoot, change, plan);
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
      const events = readEvents(projectRoot, change);
      const tasksContent = readFileSync(join(changeRoot, "tasks.md"), "utf8");
      const lines = tasksContent.split("\n");
      const taskLineIdx = findTaskLine(lines, taskId);
      if (taskLineIdx < 0) return { skip: true, message: `任务 ${taskId} 不存在` };
      const contractMode = applyRequirementModeForCurrentRound(events);
      if (contractMode && pendingTaskStatusForApply(changeRoot, events).completedByEvent.includes(taskId)) {
        return { skip: true, message: `任务 ${taskId} 已通过完成事件完成` };
      }
      if (lines[taskLineIdx].match(/- \[[xX]\]/)) return { skip: true, message: `任务 ${taskId} 已完成` };
      const taskInfo = parseTasksMd(tasksContent).find(task => task.taskId === taskId);
      if (!taskInfo) return { skip: true, message: `任务 ${taskId} 不存在` };

      const existing = snapshot.active_task_attempts?.find(a => a.task_id === taskId && a.state === "active");
      if (existing) return { skip: true, message: `任务 ${taskId} 已有活跃尝试` };

      // 统一出口：adopted.contract 非 null 当且仅当契约模式下有绑定块；
      // legacy 轮即使 task 带执行依据文本也输出 null，避免"看似契约、实按 legacy 校验"的误导态
      const adopted = adoptedContractForTask(tasksContent, taskId, contractMode);
      if (contractMode && taskInfo.tddRequired && !isReviewFixTaskId(taskId) && !adopted.parsed) {
        return { skip: true, message: `执行依据模式下，普通 TDD 任务 ${taskId} 缺少执行依据` };
      }
      if (contractMode) {
        const contractError = validateTaskStartContract(changeRoot, taskId, taskInfo.tddRequired, adopted.parsed);
        if (contractError) return { skip: true, message: contractError };
      }

      const structureDigest = sha256Text(tasksContent.replace(/- \[[xX]\]/g, "- [ ]"));
      const attempt: TaskAttempt = {
        attempt_id: `ATT-${taskId}-${Date.now()}-${++attemptSeq}`,
        task_id: taskId, state: "active",
        task_structure_digest: structureDigest,
        contract_mode: contractMode,
        contract: adopted.contract,
        tdd_required: taskInfo.tddRequired,
        no_tdd_reason: taskInfo.noTddReason,
        declared_write_scope: [], pre_edit_source_fingerprint: null,
        pre_edit_red_ref: null, executor_packet_digest: null,
        executor_result_ref: null, post_edit_green_ref: null,
        created_at: new Date().toISOString(),
      };
      const eventPayload = {
        ...attempt,
        ...boundarySnapshotPayload(projectRoot),
      };

      return {
        fromState: "apply", toState: "apply", outcome: "advanced" as const,
        reason: `创建任务 ${taskId} 执行尝试`,
        extraEvents: [{ type: "task_started", payload: eventPayload as unknown as Record<string, unknown> }],
        details: {
          attempt_id: attempt.attempt_id,
          task_id: taskId,
          contract: adopted.contract,
          // legacy 轮统一标注历史模式（无论有无执行依据文本）；契约轮无块时标 false（如 REVIEW-FIX）
          ...(adopted.contract ? {} : { legacy_contract: !contractMode }),
        },
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
        const scope = codeReviewDecisionScope(ref.jobId, ref.findingId);
        const decision = latestCodeReviewDecision(events, scope);
        if (decision?.answer !== "reopen_propose") return { skip: true, message: `缺少使用者确认：需要先确认问题 ${ref.findingId} 是否回到计划阶段` };
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
            baseline_docs: proposalDocsBaseline(changeRoot),
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
          const scope = codeReviewDecisionScope(ref.jobId, ref.findingId);
          const decision = latestCodeReviewDecision(events, scope);
          if (decision?.answer !== "reopen_apply") return { skip: true, message: `缺少使用者确认：需要先确认问题 ${ref.findingId} 是否直接回到实现阶段修复` };
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

      const pending = pendingTaskStatusForApply(changeRoot, events).pending;
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
      const pending = pendingTaskStatusForApply(changeRoot, events).pending;
      if (pending.length > 0) return { skip: true, message: formatPendingTaskMessage(pending, "请先通过 next/reopen 继续执行") };
      if (applyRequirementModeForCurrentRound(events)) {
        const missingExemptions = missingCoverageExemptionTestIds(changeRoot, events);
        if (missingExemptions.length > 0) {
          return {
            skip: true,
            message: `test-contract 中存在未绑定任务且缺少覆盖豁免的 TEST：${missingExemptions.join(", ")}；请先向用户确认原因（不要代替用户决策），再执行 superspec record user-decision --change "${change}" --input - 登记，stdin 传入 JSON：{"scope":"test_coverage_exemption:${missingExemptions[0]}","question":"<向用户提出的问题>","answer":"<用户给出的豁免原因>"}`,
          };
        }
      }

      // 如果当前是 apply，先推进到 apply_done
      if (snapshot.state === "apply") {
        return {
          fromState: "apply", toState: "apply_done", outcome: "advanced" as const,
          reason: `所有任务完成；审查策略=${policy.review_risk}`,
          commitPayload: policyPayload,
        };
      }
      if (snapshot.state === "apply_done") {
        return evaluateApplyDoneCodeReviewGate({
          events,
          projectRoot,
          changeRoot,
          change,
          policyPayload,
        });
      }

      if (snapshot.state === "review") {
        return evaluateFinalVerifierGate({
          snapshot,
          events,
          change,
          projectRoot,
          changeRoot,
          currentEvidenceDigest,
          policy,
          policyPayload,
          hasStoredPolicy: Boolean(storedPolicy),
        });
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
      const events = readEvents(projectRoot, change);
      const plan = planTransition("accept", {
        projectRoot,
        change,
        changeRoot,
        events,
        snapshot,
        mode: { kind: "risk", risk: "strict" },
      });
      return transitionPlanToDecision(snapshot, changeRoot, change, plan);
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
      // specs/ 目录：递归收录 .md（覆盖 specs/<capability>/spec.md 布局）
      const specsDir = join(changeRoot, "specs");
      for (const rel of listMarkdownFiles(specsDir)) {
        manifest[`specs/${rel}`] = sha256File(join(specsDir, rel)) ?? "sha256:missing";
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

export function taskComplete(projectRoot: string, change: string, changeRoot: string, taskId: string, inputContent: string | null = null): TransitionResult {
  const scopeInput = parseScopeNoteInput(inputContent);
  return commitTransition(projectRoot, change, changeRoot, {
    name: "task-complete", idempotencyInputs: { task: taskId, phase: "complete", scope_note_digest: scopeInput.digest ?? "" },
    decide: (snapshot) => {
      if (!scopeInput.ok) return { skip: true, message: scopeInput.message };
      if (snapshot.state !== "apply") return { skip: true, message: `当前状态 ${snapshot.state}，需要 apply` };
      const attempt = snapshot.active_task_attempts?.find(a => a.task_id === taskId && a.state === "active");
      if (!attempt) return { skip: true, message: `任务 ${taskId} 无活跃执行尝试` };

      const readiness = taskEvidenceReadiness(projectRoot, change, changeRoot, attempt);
      if (!readiness.ready) return { skip: true, message: `任务 ${taskId} 无法完成：${readiness.reason}` };

      const completedPayload: Record<string, unknown> = {
        task_id: taskId,
        attempt_id: attempt.attempt_id,
        ...boundarySnapshotPayload(projectRoot),
        checkbox_update: { status: "pending" },
        ...(scopeInput.value ? { scope_note: scopeInput.value } : {}),
      };

      return {
        fromState: "apply", toState: "apply", outcome: "advanced" as const,
        reason: `任务 ${taskId} 完成`,
        extraEvents: [{ type: "task_completed", payload: completedPayload }],
        postCommit: (_pr: string, _ch: string, cr: string) => {
          const lines = readFileSync(join(cr, "tasks.md"), "utf8").split("\n");
          const idx = findTaskLine(lines, taskId);
          if (idx < 0) {
            completedPayload.checkbox_update = { status: "failed", reason: `找不到 ${taskId} 的任务行` };
            return;
          }
          if (lines[idx].match(/- \[[xX]\]/)) {
            completedPayload.checkbox_update = { status: "applied" };
            return;
          }
          if (!lines[idx].match(/- \[ \]/)) {
            completedPayload.checkbox_update = { status: "failed", reason: `找不到 ${taskId} 的未完成复选框` };
            return;
          }
          lines[idx] = lines[idx].replace(/- \[ \]/, "- [x]");
          writeFileSync(join(cr, "tasks.md"), lines.join("\n"));
          completedPayload.checkbox_update = { status: "applied" };
        },
      };
    },
  });
}
