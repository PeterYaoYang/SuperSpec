// SuperSpec 流程引擎 — transition：提交协议 + 所有 transition 处理器

import { join } from "node:path";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import {
  ensureChangeLayout, readEvents, appendEvent, makeEvent,
  writeSnapshot, snapshotDigest, withLock, idempotencyKey,
  docRef, sha256Text,
} from "./store.ts";
import { rebuildSnapshot } from "./sync.ts";
import { requiredJobActions } from "./job_action.ts";
import {
  assertCommitPayloadExtension,
  isFreshReviewVerifier,
  isReviewReadyVerifier,
  latestReviewHistoryForGateRole,
  readReviewPolicyFromEvents,
  reviewBoundFiles,
  reviewEvidenceDigest,
  reviewPolicyForRisk,
  REVIEW_DOC_PATHS,
  type ReviewPolicy, type ReviewRisk,
} from "./review.ts";
import {
  REVIEW_CODE_REVIEW_GATE_ID,
  REVIEW_FINAL_VERIFIER_GATE,
  REVIEW_FINAL_VERIFIER_GATE_ID,
  reviewScopeForGateRole,
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
  effectiveCoverageExemptionRefsFromEvents,
  latestCodeReviewGateEvidence,
  latestCodeReviewDecision,
  latestCodeReviewFailedStatus,
  missingCoverageExemptionTestIds,
  requiresFinalVerifierForCurrentReview,
  scanCodeChangesForReview,
  taskExecutionIndexForReview,
} from "./code_review.ts";
import { taskEvidenceReadiness } from "./task_evidence.ts";
import {
  adoptedContractForTask,
  findTaskInLines,
  isFixTaskId,
  parseTasksMd,
  parseTestContractEntries,
  type ParsedExecutionRequirement,
} from "./format.ts";
import {
  applyRequirementModeForCurrentRound,
  applyPlanningDocsChangedSinceBaseline,
  executionRequirementVersionForCurrentRound,
  blockingJobsForApplyDone,
  executionPolicyForCurrentRound,
  formatPendingTaskMessage,
  latestAcceptedProposalBaseline,
  pendingTaskStatusForApply,
  planningValidationProfileForNewRound,
  planTransition,
  discoveryDocsBaseline,
  exploreAnswerRegistrationPayloadForChange,
  proposeAnswerRegistrationPayloadForChange,
  proposalDocsBaseline,
  type TransitionDecisionPlan,
} from "./phase_plan.ts";
import {
  latestAcceptedPhaseDecision,
  phaseConfirmationCommitPayload,
  phaseConfirmationForBoundary,
  phaseConfirmationMissingMessage,
  type PhaseBoundary,
} from "./phase_confirmation.ts";
import { currentGitHead, dirtyCodeFiles, stageProductionJavaFilesSince } from "./git_state.ts";
import { workflowRiskForProject } from "./workflow_config.ts";
import type { CodeReviewScope, Event, Snapshot, State, Job, JobRole, TransitionResult, Ref, TaskAttempt, BoundarySnapshot, EffectiveEvidencePlan, ExecutionPolicy, FixDescriptor, ReviewPreviousRejection, TestEvidenceAction } from "./types.ts";

let transitionSeq = 0;
function newTransitionId(): string { return `T-${Date.now()}-${++transitionSeq}`; }
let jobSeq = 0;
function newJobId(change: string, role: string): string { return `JOB-${change.slice(0, 8)}-${role.slice(0, 4)}-${Date.now()}-${++jobSeq}`; }

function createReviewJobsForGate(
  state: State,
  gate: ReviewGateRule,
  roles: JobRole[],
  requiredRoles: JobRole[],
  changeRoot: string,
  change: string,
  reason: string,
  events: Event[],
): Decision {
  const newJobs: Job[] = roles.map(role => {
    const scope = reviewScopeForGateRole(gate, role, requiredRoles);
    // 角色职责目标和显式 freshness 路径绑定时点指纹：单文件缺失使用 sha256:missing，目录缺失使用稳定空指纹。
    const boundPaths = [...new Set(scope.boundPaths)];
    const boundFiles: Ref[] = boundPaths
      .map(p => docRef(changeRoot, p));
    const previousRejection = latestReviewHistoryForGateRole(events, gate, role);
    return {
      job_id: newJobId(change, role),
      role,
      state: "requested" as const,
      gate_id: gate.gate_id,
      boundFiles,
      ...(scope.reviewTargets.length > 0 ? { review_targets: [...scope.reviewTargets] } : {}),
      ...(scope.readOnlyRefs.length > 0 ? { read_only_refs: [...scope.readOnlyRefs] } : {}),
      packet_digest: sha256Text(JSON.stringify({
        role,
        gate_id: gate.gate_id,
        boundFiles,
        review_targets: scope.reviewTargets,
        read_only_refs: scope.readOnlyRefs,
        created_from_transition: gate.created_from_transition,
        ...(previousRejection ? { previous_rejection: previousRejection } : {}),
      })),
      created_from_transition: gate.created_from_transition,
      created_at: new Date().toISOString(),
      ...(previousRejection ? { previous_rejection: previousRejection } : {}),
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

function boundarySnapshotForTaskAttempt(events: Event[], attemptId: string): BoundarySnapshot | null {
  const start = events.findLast(event =>
    event.event_type === "task_started" &&
    (event.payload as { attempt_id?: unknown }).attempt_id === attemptId
  );
  const boundary = (start?.payload as { boundary_snapshot?: unknown } | undefined)?.boundary_snapshot;
  if (!boundary || typeof boundary !== "object" || Array.isArray(boundary)) return null;
  const value = boundary as Partial<BoundarySnapshot>;
  if (!Array.isArray(value.dirty_files)) return null;
  return value as BoundarySnapshot;
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
  parsedContract: ParsedExecutionRequirement,
): string | null {
  if (parsedContract.errors.length > 0) return parsedContract.errors.join("；");
  if (!parsedContract.declaredFields.includes("tests")) return `${taskId} 的执行依据缺少测试字段`;
  if (!parsedContract.contract.design) return `${taskId} 的执行依据缺少设计`;
  if (parsedContract.contract.source.length === 0) return `${taskId} 的执行依据缺少来源`;
  if (!parsedContract.contract.acceptance) return `${taskId} 的执行依据缺少验收目标`;
  if (!parsedContract.contract.guard) return `${taskId} 的执行依据缺少边界`;
  if (parsedContract.contract.tests.length === 0) return null;

  const testContractPath = join(changeRoot, ".superspec", "artifacts", "test-contract.md");
  if (!existsSync(testContractPath)) return "test-contract.md 不存在，无法校验执行依据测试引用";
  const parsed = parseTestContractEntries(readFileSync(testContractPath, "utf8"));
  if (!parsed.ok) return parsed.message;
  const known = new Set(parsed.entries.map(entry => entry.test_id));
  const missing = parsedContract.contract.tests.filter(testId => !known.has(testId));
  return missing.length > 0 ? `执行依据引用了不存在的 TEST ID：${missing.join(", ")}` : null;
}

/**
 * v1 只回放旧 contract 约束：普通 TDD task 必须保有执行依据和 TEST 引用，
 * 但不要求 v2 新增的五字段，避免阻断历史 documentation-only task。
 */
function validateLegacyTaskStartContract(
  changeRoot: string,
  taskId: string,
  tddRequired: boolean,
  parsedContract: ParsedExecutionRequirement | null,
): string | null {
  if (!parsedContract) {
    return tddRequired && !isFixTaskId(taskId)
      ? `执行依据模式下，普通 TDD 任务 ${taskId} 缺少执行依据`
      : null;
  }
  if (parsedContract.errors.length > 0) return parsedContract.errors.join("；");
  if (tddRequired && !isFixTaskId(taskId) && parsedContract.contract.tests.length === 0) {
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

/**
 * 只在 task-start 编译新模式 task 的有效证据要求。Propose 只声明 TEST，
 * RED 是否要求由这里读取已冻结的 execution_policy 决定，之后不再依赖 tasks.md。
 */
function compileRequiredEvidence(
  executionPolicy: ExecutionPolicy,
  testIds: string[],
  requiresVerificationWithoutDeclaredTest: boolean,
): EffectiveEvidencePlan {
  // Fix task 没有计划阶段声明的 TEST，但仍必须登记一次真实回归验证。
  // 是否需要 RED 始终由已冻结的 execution_policy 决定。
  const requiresVerification = testIds.length > 0 || requiresVerificationWithoutDeclaredTest;
  return {
    test_ids: testIds,
    red_required: executionPolicy === "tdd" && requiresVerification,
    green_required: requiresVerification,
    accepted_green_statuses: ["expected_success"],
  };
}

function evidenceActionsForAttempt(
  change: string,
  attemptId: string,
  fallbackTestId: string,
  required: EffectiveEvidencePlan,
): TestEvidenceAction[] {
  const testIds = required.test_ids.length > 0 ? required.test_ids : [fallbackTestId];
  const statuses: TestEvidenceAction["record_input"]["semantic_status"][] = [];
  if (required.red_required) statuses.push("expected_failure");
  if (required.green_required) statuses.push(required.accepted_green_statuses[0] ?? "expected_success");

  return testIds.flatMap(testId => statuses.map(semanticStatus => ({
    kind: "test_run" as const,
    test_id: testId,
    record_argv: ["superspec", "record", "test-run", "--change", change, "--input", "-"],
    record_input: {
      test_id: testId,
      attempt_id: attemptId,
      command: null,
      cwd: null,
      exit_code: null,
      semantic_status: semanticStatus,
    },
    required_fields: ["command", "cwd", "exit_code"],
  })));
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

function repairedCodeReviewPreviousRejection(
  events: Event[],
  packetContext: ReturnType<typeof codeReviewPacketContext>,
): ReviewPreviousRejection | undefined {
  const eventOrder = new Map(events.map((event, index) => [event.event_id, index]));
  const codeReviewJobIds = new Set<string>();
  for (const event of events) {
    if (event.event_type !== "transition_commit") continue;
    for (const job of (event.payload as { new_jobs?: Job[] }).new_jobs ?? []) {
      if (job.role === "code-reviewer") codeReviewJobIds.add(job.job_id);
    }
  }
  const latestAcceptedIndex = events.findLastIndex(event =>
    event.event_type === "job_accepted" &&
    codeReviewJobIds.has(String((event.payload as { job_id?: unknown }).job_id ?? ""))
  );
  const latestStartApplyIndex = events.findLastIndex(event =>
    event.event_type === "transition_commit" &&
    (event.payload as { transition?: unknown }).transition === "start-apply"
  );
  const historyBoundary = Math.max(latestAcceptedIndex, latestStartApplyIndex);
  const repairedEntries = [...(packetContext.task_execution_index ?? [])]
    .filter(entry =>
      entry.fix?.source === "code_review" &&
      entry.fix.review_finding &&
      (eventOrder.get(entry.task_completed_event_ref) ?? -1) > historyBoundary
    )
    .sort((left, right) =>
      (eventOrder.get(right.task_completed_event_ref) ?? -1) -
      (eventOrder.get(left.task_completed_event_ref) ?? -1)
    );
  const latestRef = repairedEntries[0]?.fix?.review_finding;
  if (!latestRef) return undefined;

  const rejection = events.findLast(event =>
    event.event_type === "job_rejected" &&
    (event.payload as { job_id?: unknown }).job_id === latestRef.job_id
  );
  const payload = rejection?.payload as { findings?: unknown; reason?: unknown } | undefined;
  const findings = Array.isArray(payload?.findings)
    ? payload.findings.filter(item => {
      if (!item || typeof item !== "object" || Array.isArray(item)) return false;
      const finding = item as { id?: unknown; blocking?: unknown };
      if (finding.blocking !== true || typeof finding.id !== "string") return false;
      return latestCodeReviewDecision(
        events,
        codeReviewDecisionScope(latestRef.job_id, finding.id),
      )?.answer !== "dismiss";
    })
    : [];
  if (findings.length === 0) return undefined;

  return {
    result_kind: "review_failed",
    reason: typeof payload?.reason === "string" && payload.reason.trim()
      ? payload.reason
      : "复核已执行的代码审查修复",
    job_id: latestRef.job_id,
    findings_job_id: latestRef.job_id,
    findings,
  };
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
  const repairedPreviousRejection = repairedCodeReviewPreviousRejection(events, packetContext);
  const previousRejection = latestRejected && latestRejected.state === "rejected"
    ? {
      result_kind: latestRejected.result_kind ?? "invalid_report",
      reason: latestRejected.result_kind === "review_failed" && reviewFailedStatus && reviewFailedStatus.unresolved.length === 0 && reviewFailedStatus.dismissed.length > 0
        ? dismissedCodeReviewSummary(reviewFailedStatus)
        : latestRejected.reason ?? "缺少拒绝原因",
      job_id: latestRejected.job.job_id,
      ...(
        latestRejected.result_kind !== "review_failed" && repairedPreviousRejection?.findings?.length
          ? {
            findings: repairedPreviousRejection.findings,
            findings_job_id: repairedPreviousRejection.findings_job_id,
          }
          : {}
      ),
    }
    : repairedPreviousRejection;
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

function reviewFixDescriptor(ref: CodeReviewFindingRef, finding: Record<string, unknown>): FixDescriptor {
  const reason = typeof finding.description === "string" && finding.description.trim()
    ? finding.description.trim().replace(/\s+/g, " ")
    : `修复代码审查问题 ${ref.findingId}`;
  return {
    fix_id: `REVIEW-FIX-${ref.jobId}#${ref.findingId}`,
    source: "code_review",
    parent_task_id: null,
    reason,
    review_finding: { job_id: ref.jobId, finding_id: ref.findingId },
  };
}

function selfTestFixBaseId(parentTaskId: string, reason: string): string {
  const normalizedReason = reason.trim().replace(/\s+/g, " ");
  const normalizedTaskId = parentTaskId.replace(/[^A-Za-z0-9_-]/g, "-");
  const digest = sha256Text(`${parentTaskId}\n${normalizedReason}`).replace(/^sha256:/, "").slice(0, 12);
  return `FIX-SELFTEST-${normalizedTaskId}-${digest}`;
}

function selfTestFixDescriptor(parentTaskId: string, reason: string, occurrence: number): FixDescriptor {
  const normalizedReason = reason.trim().replace(/\s+/g, " ");
  const baseId = selfTestFixBaseId(parentTaskId, normalizedReason);
  return {
    fix_id: occurrence === 1 ? baseId : `${baseId}-${occurrence}`,
    source: "self_test",
    parent_task_id: parentTaskId,
    reason: normalizedReason,
  };
}

function selfTestFixOccurrence(taskId: string, baseId: string): number | null {
  if (taskId === baseId) return 1;
  const suffix = taskId.slice(baseId.length + 1);
  if (!taskId.startsWith(`${baseId}-`) || !/^\d+$/.test(suffix)) return null;
  const occurrence = Number(suffix);
  return Number.isSafeInteger(occurrence) && occurrence >= 2 ? occurrence : null;
}

function nextSelfTestFixDescriptor(
  changeRoot: string,
  events: Event[],
  parentTaskId: string,
  reason: string,
): { fix: FixDescriptor } | { activeFixTaskId: string } {
  const normalizedReason = reason.trim().replace(/\s+/g, " ");
  const baseId = selfTestFixBaseId(parentTaskId, normalizedReason);
  let maxOccurrence = 0;
  const completion = pendingTaskStatusForApply(changeRoot, events);
  const pendingTaskIds = new Set(completion.pending);

  const taskInfos = parseTasksMd(readFileSync(join(changeRoot, "tasks.md"), "utf8"));
  for (const task of taskInfos) {
    const occurrence = selfTestFixOccurrence(task.taskId, baseId);
    if (occurrence == null) continue;
    maxOccurrence = Math.max(maxOccurrence, occurrence);
    if (pendingTaskIds.has(task.taskId)) return { activeFixTaskId: task.taskId };
  }

  for (const event of events) {
    if (event.event_type !== "transition_commit") continue;
    const fix = (event.payload as { fix?: unknown }).fix;
    if (!fix || typeof fix !== "object" || Array.isArray(fix)) continue;
    const candidate = fix as Partial<FixDescriptor>;
    if (candidate.source !== "self_test" || candidate.parent_task_id !== parentTaskId || candidate.reason !== normalizedReason) continue;
    if (typeof candidate.fix_id !== "string") continue;
    const occurrence = selfTestFixOccurrence(candidate.fix_id, baseId);
    if (occurrence != null) maxOccurrence = Math.max(maxOccurrence, occurrence);
  }

  return { fix: selfTestFixDescriptor(parentTaskId, normalizedReason, maxOccurrence + 1) };
}

function fixMarker(fix: FixDescriptor): string {
  if (fix.source === "code_review" && fix.review_finding) {
    return `review_fix_of:${fix.review_finding.job_id}#${fix.review_finding.finding_id}`;
  }
  return `self_test_fix_of:${fix.parent_task_id ?? "unknown"}:${fix.fix_id}`;
}

function appendFixTask(changeRoot: string, fix: FixDescriptor): "created" | "exists" {
  const tasksPath = join(changeRoot, "tasks.md");
  const content = readFileSync(tasksPath, "utf8");
  const marker = fixMarker(fix);
  if (content.includes(marker)) {
    const matchingTask = content.split("\n").some(line =>
      line.includes(marker) && line.startsWith(`- [ ] ${fix.fix_id} `)
    );
    if (matchingTask) return "exists";
    throw new Error(`修复标记 ${marker} 已被其它 task 占用，拒绝创建 ${fix.fix_id}`);
  }
  if (parseTasksMd(content).some(task => task.taskId === fix.fix_id)) {
    throw new Error(`修复 task ID ${fix.fix_id} 已被其它任务占用，拒绝创建重复修复`);
  }

  const description = fix.source === "self_test"
    ? `修复自测问题（关联 ${fix.parent_task_id}）：${fix.reason}`
    : fix.reason;
  const line = `- [ ] ${fix.fix_id} ${description} ${marker}`;
  const suffix = content.endsWith("\n") ? "" : "\n";
  writeFileSync(tasksPath, `${content}${suffix}${line}\n`);
  return "created";
}

function fixDescriptorForTask(events: Event[], taskId: string): FixDescriptor | null {
  for (let i = events.length - 1; i >= 0; i--) {
    const event = events[i];
    if (event.event_type !== "transition_commit") continue;
    const fix = (event.payload as { fix?: unknown }).fix;
    if (!fix || typeof fix !== "object" || Array.isArray(fix)) continue;
    const candidate = fix as Partial<FixDescriptor>;
    if (candidate.fix_id !== taskId) continue;
    if (candidate.source !== "code_review" && candidate.source !== "self_test") continue;
    if (typeof candidate.parent_task_id !== "string" && candidate.parent_task_id !== null) continue;
    if (typeof candidate.reason !== "string") continue;
    return candidate as FixDescriptor;
  }
  // 兼容发布前已写入 tasks.md、但 transition payload 尚未保存修复描述符的记录。
  const legacy = /^REVIEW-FIX-(.+)#([^#]+)$/.exec(taskId);
  return legacy
    ? {
        fix_id: taskId,
        source: "code_review",
        parent_task_id: null,
        reason: "历史代码审查修复任务",
        review_finding: { job_id: legacy[1], finding_id: legacy[2] },
      }
    : null;
}

function isFreshOpenCodeReviewerJob(job: Job, projectRoot: string, events: Event[], currentWorkingPaths?: string[]): boolean {
  return codeReviewJobStaleReason(projectRoot, job, currentWorkingPaths, events) == null;
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
    const freshOpenJobs = facts.openJobs.filter(job => isFreshOpenCodeReviewerJob(job, input.projectRoot, input.events, currentWorkingPaths));
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
      const staleReason = codeReviewJobStaleReason(input.projectRoot, latest.job, currentWorkingPaths, input.events);
      if (staleReason || !hasFrozenCodeReviewCurrentHead(acceptedScope)) {
        const { job, scanReason } = createCodeReviewerJob(input.change, input.projectRoot, input.changeRoot, input.events);
        return {
          fromState: "apply_done",
          toState: "apply_done",
          outcome: "job_created" as const,
          newJobs: [job],
          reason: staleReason
            ? `已接受代码审查工作项不再匹配当前代码状态，重新创建代码审查工作项；${staleReason}；${scanReason}`
            : `已接受代码审查工作项缺少冻结 current_head，重新创建代码审查工作项；${scanReason}`,
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
      const staleReason = codeReviewJobStaleReason(input.projectRoot, latest.job, currentWorkingPaths, input.events);
      if (staleReason) {
        const { job, scanReason } = createCodeReviewerJob(input.change, input.projectRoot, input.changeRoot, input.events);
        return {
          fromState: "apply_done",
          toState: "apply_done",
          outcome: "job_created" as const,
          newJobs: [job],
          reason: `代码审查结论已不再匹配当前代码状态，重新创建代码审查工作项；${staleReason}；${scanReason}`,
        };
      }
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
  const codeReviewGate = latestCodeReviewGateEvidence(events);
  const packetContext = {
    code_state_check: computeCodeStateCheck(projectRoot, events),
    coverage_exemption_refs: effectiveCoverageExemptionRefsFromEvents(events),
    task_execution_index: taskExecutionIndexForReview(projectRoot, events),
    ...(codeReviewGate ? { code_review_gate: codeReviewGate } : {}),
  };
  const previousRejection = latestReviewHistoryForGateRole(events, REVIEW_FINAL_VERIFIER_GATE, "verifier");
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
      ...(previousRejection ? { previous_rejection: previousRejection } : {}),
    })),
    created_from_transition: "review-ready",
    created_at: new Date().toISOString(),
    ...(previousRejection ? { previous_rejection: previousRejection } : {}),
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

function authorizePhaseAdvance(input: {
  projectRoot: string;
  events: Event[];
  snapshot: Snapshot;
  boundary: PhaseBoundary;
  risk: ReviewRisk;
  decision: Decision;
}): Decision | SkipDecision {
  const confirmation = phaseConfirmationForBoundary(
    input.projectRoot,
    input.events,
    input.snapshot,
    input.boundary,
    input.risk,
  );
  const phaseDecision = confirmation
    ? latestAcceptedPhaseDecision(input.events, confirmation)
    : null;
  if (!confirmation || phaseDecision?.decision !== "advance") {
    return {
      skip: true,
      message: confirmation
        ? phaseConfirmationMissingMessage(confirmation)
        : `无法建立 ${input.boundary} 阶段确认范围`,
    };
  }
  return {
    ...input.decision,
    commitPayload: {
      ...(input.decision.commitPayload ?? {}),
      ...phaseConfirmationCommitPayload(confirmation, phaseDecision),
    },
  };
}

function transitionPlanToDecision(
  snapshot: Snapshot,
  changeRoot: string,
  change: string,
  plan: TransitionDecisionPlan,
  events: Event[],
): Decision | SkipDecision | BlockedDecision {
  switch (plan.kind) {
    case "skip":
      return { skip: true, message: plan.message };
    case "blocked":
      return { blocked: true, reason: plan.reason, jobs: plan.jobs, ...(plan.details ? { details: plan.details } : {}) };
    case "create_gate_jobs":
      return createReviewJobsForGate(snapshot.state, plan.gate, plan.roles, plan.requiredRoles, changeRoot, change, plan.reason, events);
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
        ...(decision.jobs.length > 0 ? { required_jobs: requiredJobActions(change, decision.jobs) } : {}),
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

export function proposeReady(projectRoot: string, change: string, changeRoot: string, risk = workflowRiskForProject(projectRoot)): TransitionResult {
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
      return transitionPlanToDecision(snapshot, changeRoot, change, plan, events);
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

export function transitionExplore(projectRoot: string, change: string, changeRoot: string, risk = workflowRiskForProject(projectRoot)): TransitionResult {
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
      return transitionPlanToDecision(snapshot, changeRoot, change, plan, events);
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
        mode: { kind: "risk", risk: workflowRiskForProject(projectRoot) },
      });
      return transitionPlanToDecision(snapshot, changeRoot, change, plan, events);
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
      if (applyPlanningMaterialsChanged(changeRoot, events)) {
        return { skip: true, message: "Apply 期间计划材料已变化；请回到 Propose 核对并重新批准计划后再继续任务" };
      }
      const tasksContent = readFileSync(join(changeRoot, "tasks.md"), "utf8");
      const lines = tasksContent.split("\n");
      const taskLineIdx = findTaskLine(lines, taskId);
      if (taskLineIdx < 0) return { skip: true, message: `任务 ${taskId} 不存在` };
      const contractMode = applyRequirementModeForCurrentRound(events);
      const executionRequirementVersion = executionRequirementVersionForCurrentRound(events);
      const executionPolicy = executionPolicyForCurrentRound(events);
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
      const fix = fixDescriptorForTask(events, taskId);
      const isFixTask = isFixTaskId(taskId);
      if (isFixTask && !fix) {
        return { skip: true, message: `Fix task ${taskId} 缺少状态机创建记录，不能直接手工追加` };
      }
      if (contractMode && executionRequirementVersion === 2 && !isFixTask && !adopted.parsed) {
        return { skip: true, message: `执行依据模式下，任务 ${taskId} 缺少执行依据` };
      }
      if (contractMode && executionRequirementVersion === 2 && !isFixTask && adopted.parsed) {
        const contractError = validateTaskStartContract(changeRoot, taskId, adopted.parsed);
        if (contractError) return { skip: true, message: contractError };
      }
      if (contractMode && executionRequirementVersion === 1) {
        const contractError = validateLegacyTaskStartContract(
          changeRoot,
          taskId,
          taskInfo.tddRequired,
          adopted.parsed,
        );
        if (contractError) return { skip: true, message: contractError };
      }

      const structureDigest = sha256Text(tasksContent.replace(/- \[[xX]\]/g, "- [ ]"));
      const effectivePolicy = executionPolicy;
      const requiredEvidence = isFixTask || (contractMode && executionRequirementVersion === 2)
        ? compileRequiredEvidence(effectivePolicy, adopted.contract?.tests ?? [], isFixTask)
        : null;
      const attempt: TaskAttempt = {
        attempt_id: `ATT-${taskId}-${Date.now()}-${++attemptSeq}`,
        task_id: taskId, state: "active",
        task_structure_digest: structureDigest,
        ...(fix ? { fix } : {}),
        contract_mode: contractMode,
        contract: adopted.contract,
        ...(requiredEvidence ? { required_evidence: requiredEvidence } : {
          // 非 Fix 的历史模式以及 v1 契约轮继续使用 task 行标记回放；新建 Fix
          // 无论来自哪个版本，均只消费本轮冻结的有效证据要求。
          tdd_required: taskInfo.tddRequired,
          no_tdd_reason: taskInfo.noTddReason,
        }),
        // REVIEW-FIX 没有计划阶段测试契约，但有效证据要求仍由本轮冻结策略编译。
        execution_policy: effectivePolicy,
        declared_write_scope: [], pre_edit_source_fingerprint: null,
        pre_edit_red_ref: null, executor_packet_digest: null,
        executor_result_ref: null, post_edit_green_ref: null,
        created_at: new Date().toISOString(),
      };
      const eventPayload = {
        ...attempt,
        ...boundarySnapshotPayload(projectRoot),
      };
      const evidenceActions = requiredEvidence
        ? evidenceActionsForAttempt(change, attempt.attempt_id, taskId, requiredEvidence)
        : null;

      return {
        fromState: "apply", toState: "apply", outcome: "advanced" as const,
        reason: `创建任务 ${taskId} 执行尝试`,
        extraEvents: [{ type: "task_started", payload: eventPayload as unknown as Record<string, unknown> }],
        details: {
          attempt_id: attempt.attempt_id,
          task_id: taskId,
          execution_policy: effectivePolicy,
          contract: adopted.contract,
          ...(fix ? { fix } : {}),
          ...(requiredEvidence ? { required_evidence: requiredEvidence } : {}),
          ...(evidenceActions ? { evidence_actions: evidenceActions } : {}),
          // legacy 轮统一标注历史模式（无论有无执行依据文本）；契约轮无块时标 false（如 Fix task）
          ...(adopted.contract ? {} : { legacy_contract: !contractMode }),
        },
      };
    },
  });
}

// ===== reopen =====

function abandonActiveTaskAttempts(snapshot: Snapshot, to: "explore" | "propose", reason: string): NonNullable<Decision["extraEvents"]> {
  return snapshot.active_task_attempts
    .filter(attempt => attempt.state === "active")
    .map(attempt => ({
      type: "task_abandoned",
      payload: {
        attempt_id: attempt.attempt_id,
        task_id: attempt.task_id,
        reason: `reopen --to ${to}：${reason}`,
      },
    }));
}

function invalidateOpenJobs(snapshot: Snapshot, to: State, reason: string): NonNullable<Decision["extraEvents"]> {
  return snapshot.open_jobs.map(job => ({
    type: "job_invalidated",
    payload: {
      job_id: job.job_id,
      role: job.role,
      reason: `reopen --to ${to}：${reason}`,
    },
  }));
}

function latestApplyPlanningBaseline(events: Event[]): Record<string, string> | null {
  for (let index = events.length - 1; index >= 0; index--) {
    const event = events[index];
    if (event.event_type !== "transition_commit") continue;
    const payload = event.payload as { transition?: unknown; apply_planning_baseline?: unknown };
    if (payload.transition !== "start-apply") continue;
    const baseline = payload.apply_planning_baseline;
    if (!baseline || typeof baseline !== "object" || Array.isArray(baseline)) return null;
    const entries = Object.entries(baseline as Record<string, unknown>);
    return entries.every(([, digest]) => typeof digest === "string")
      ? Object.fromEntries(entries) as Record<string, string>
      : null;
  }
  return null;
}

function applyPlanningMaterialsChanged(changeRoot: string, events: Event[]): boolean {
  const baseline = latestApplyPlanningBaseline(events);
  return baseline != null && applyPlanningDocsChangedSinceBaseline(changeRoot, baseline);
}

/**
 * self-test-fix 由使用者明确指定已完成的父 task；它可以修复早于当前
 * Apply round 的实现问题。普通 Apply 仍只消费当前轮完成事件，这个查询
 * 只用于自测修复的人工关联，不改变任务完成判定。
 */
function hasHistoricalTaskCompletion(events: Event[], taskId: string): boolean {
  return events.some(event => {
    if (event.event_type !== "task_completed") return false;
    const payload = event.payload as {
      task_id?: unknown;
      attempt_id?: unknown;
      checkbox_update?: unknown;
    };
    if (payload.task_id !== taskId || typeof payload.attempt_id !== "string") return false;
    const checkboxUpdate = payload.checkbox_update;
    if (!checkboxUpdate || typeof checkboxUpdate !== "object" || Array.isArray(checkboxUpdate)) return true;
    return (checkboxUpdate as { status?: unknown }).status !== "failed";
  });
}

function proposalReopenBaseline(changeRoot: string, events: Event[], source: State): {
  baseline: Record<string, string>;
  source: "apply" | "reopen_fallback";
} {
  const applyBaseline = ["apply", "apply_done", "review"].includes(source)
    ? latestApplyPlanningBaseline(events)
    : null;
  return applyBaseline
    ? { baseline: { ...proposalDocsBaseline(changeRoot), ...applyBaseline }, source: "apply" }
    : { baseline: proposalDocsBaseline(changeRoot), source: "reopen_fallback" };
}

function planningReopenExtraEvents(snapshot: Snapshot, to: "explore" | "propose", reason: string): NonNullable<Decision["extraEvents"]> {
  return [
    ...invalidateOpenJobs(snapshot, to, reason),
    ...abandonActiveTaskAttempts(snapshot, to, reason),
  ];
}

function canReopenToExplore(from: State): boolean {
  return from === "propose" || from === "propose_ready" || from === "apply" ||
    from === "apply_done" || from === "review" || from === "accepted";
}

function canReopenToPropose(from: State): boolean {
  return from === "propose_ready" || from === "apply" || from === "apply_done" ||
    from === "review" || from === "accepted";
}

export function reopen(
  projectRoot: string,
  change: string,
  changeRoot: string,
  to: State,
  reason: string,
  opts: { reviewFix?: string; reviewFinding?: string; selfTestFix?: string } = {},
): TransitionResult {
  return commitTransition(projectRoot, change, changeRoot, {
    name: "reopen", idempotencyInputs: {
      to,
      reason,
      reviewFix: opts.reviewFix ?? "",
      reviewFinding: opts.reviewFinding ?? "",
      selfTestFix: opts.selfTestFix ?? "",
    },
    decide: (snapshot) => {
      if (!reason || reason.trim() === "") return { skip: true, message: "reopen 需要非空 --reason" };
      const events = readEvents(projectRoot, change);
      const specialFixCount = [opts.reviewFix, opts.reviewFinding, opts.selfTestFix].filter(Boolean).length;
      if (specialFixCount > 1) return { skip: true, message: "一次 reopen 只能指定一种修复或审查引用" };

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
            planning_validation_version: 2,
            planning_validation_profile: planningValidationProfileForNewRound(projectRoot),
            ...proposeAnswerRegistrationPayloadForChange(changeRoot),
          },
        };
      }

      if (opts.reviewFix) {
        if (to !== "apply") return { skip: true, message: "--review-fix 只能用于回到实现阶段（reopen --to apply）" };
        if (snapshot.state !== "apply_done") return { skip: true, message: `当前状态 ${snapshot.state}，不能通过代码审查修复回到实现阶段` };
        if (applyPlanningMaterialsChanged(changeRoot, events)) {
          return { skip: true, message: "计划材料已变化，不能作为纯实现问题回到 Apply；请 reopen --to propose" };
        }
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
        const fix = reviewFixDescriptor(ref, found.finding);
        return {
          fromState: "apply_done",
          toState: "apply",
          outcome: "advanced" as const,
          reason: reason.trim(),
          commitPayload: {
            review_fix_of: `${ref.jobId}#${ref.findingId}`,
            source_job_id: ref.jobId,
            finding_id: ref.findingId,
            fix,
          },
          postCommit: (_pr, _ch, cr) => {
            appendFixTask(cr, fix);
          },
        };
      }

      if (opts.selfTestFix) {
        if (to !== "apply") return { skip: true, message: "--self-test-fix 只能用于回到实现阶段（reopen --to apply）" };
        const allowedStates: State[] = ["apply", "apply_done", "review", "accepted"];
        if (!allowedStates.includes(snapshot.state)) {
          return { skip: true, message: `当前状态 ${snapshot.state}，不能通过自测问题回到实现阶段` };
        }

        const parentTaskId = opts.selfTestFix.trim();
        if (applyPlanningMaterialsChanged(changeRoot, events)) {
          return { skip: true, message: "计划材料已变化，不能作为纯实现问题创建 self-test 修复；请 reopen --to propose" };
        }
        const parentTask = parseTasksMd(readFileSync(join(changeRoot, "tasks.md"), "utf8"))
          .find(task => task.taskId === parentTaskId);
        if (!parentTask) return { skip: true, message: `自测修复关联的 task ${parentTaskId} 不存在` };
        const nextFix = nextSelfTestFixDescriptor(changeRoot, events, parentTaskId, reason);
        if ("activeFixTaskId" in nextFix) {
          return { skip: true, message: `同一自测问题的修复 ${nextFix.activeFixTaskId} 尚未完成，不能重复创建` };
        }
        const fix = nextFix.fix;

        const pendingStatus = pendingTaskStatusForApply(changeRoot, events);
        if (pendingStatus.pending.length > 0 || snapshot.active_task_attempts.some(attempt => attempt.state === "active")) {
          return { skip: true, message: "自测修复只允许在当前 task 全部完成且没有活跃执行尝试后创建" };
        }
        if (
          pendingStatus.mode === "contract" &&
          !pendingStatus.completedByEvent.includes(parentTaskId) &&
          !hasHistoricalTaskCompletion(events, parentTaskId)
        ) {
          return { skip: true, message: `自测修复关联的 task ${parentTaskId} 缺少完成事件，不能只依赖 checkbox` };
        }
        if (pendingStatus.mode === "legacy" && !parentTask.done) {
          return { skip: true, message: `自测修复关联的 task ${parentTaskId} 尚未完成` };
        }

        const failedReview = latestCodeReviewFailedStatus(events);
        if (failedReview?.unresolved.length) {
          return {
            skip: true,
            message: `已有未处理的代码审查问题 ${failedReview.unresolved[0].id}；请先按 next 返回的 --review-fix 处理`,
          };
        }

        return {
          fromState: snapshot.state,
          toState: "apply",
          outcome: "advanced" as const,
          reason: reason.trim(),
          commitPayload: { fix },
          extraEvents: invalidateOpenJobs(snapshot, "apply", reason.trim()),
          postCommit: (_pr, _ch, cr) => {
            appendFixTask(cr, fix);
          },
        };
      }

      if (to === "explore") {
        if (!canReopenToExplore(snapshot.state)) {
          return { skip: true, message: `当前状态 ${snapshot.state}，不能 reopen 到 explore` };
        }
        return {
          fromState: snapshot.state,
          toState: "explore",
          outcome: "advanced" as const,
          reason: reason.trim(),
          commitPayload: {
            reopen_target: "explore",
            reopen_source: snapshot.state,
            baseline_docs: discoveryDocsBaseline(changeRoot),
            ...exploreAnswerRegistrationPayloadForChange(changeRoot),
          },
          extraEvents: planningReopenExtraEvents(snapshot, "explore", reason.trim()),
        };
      }

      if (to === "propose") {
        if (!canReopenToPropose(snapshot.state)) {
          return { skip: true, message: `当前状态 ${snapshot.state}，不能 reopen 到 propose` };
        }
        if (snapshot.state === "accepted" && snapshot.open_jobs.length > 0) {
          return {
            blocked: true,
            reason: `状态未推进；accepted 状态仍有 ${snapshot.open_jobs.length} 个待完成工作项`,
            jobs: snapshot.open_jobs,
          };
        }
        const currentBaseline = proposalDocsBaseline(changeRoot);
        const acceptedBaseline = snapshot.state === "accepted" ? latestAcceptedProposalBaseline(events) : null;
        // 旧版 accepted 事件的基线可能缺少后来纳入 Propose gate 的材料。保留其已冻结
        // 的摘要，并用 reopen 当刻的摘要补齐缺项，确保本轮之后对任一审查目标的修改都能被检测。
        const baselineNeedsBackfill = acceptedBaseline !== null && Object.keys(currentBaseline)
          .some(path => !Object.prototype.hasOwnProperty.call(acceptedBaseline, path));
        const applyReopenBaseline = acceptedBaseline ? null : proposalReopenBaseline(changeRoot, events, snapshot.state);
        const baselineDocs = acceptedBaseline
          ? Object.fromEntries(Object.entries(currentBaseline).map(([path, digest]) => [
            path,
            Object.prototype.hasOwnProperty.call(acceptedBaseline, path) ? acceptedBaseline[path] : digest,
          ]))
          : applyReopenBaseline!.baseline;
        return {
          fromState: snapshot.state,
          toState: "propose",
          outcome: "advanced" as const,
          reason: reason.trim(),
          commitPayload: {
            reopen_target: "propose",
            reopen_source: snapshot.state,
            baseline_source: acceptedBaseline
              ? (baselineNeedsBackfill ? "accepted_backfill" : "accepted")
              : applyReopenBaseline!.source,
            baseline_docs: baselineDocs,
            planning_validation_version: 2,
            planning_validation_profile: planningValidationProfileForNewRound(projectRoot),
          },
          extraEvents: planningReopenExtraEvents(snapshot, "propose", reason.trim()),
        };
      }

      if (to !== "apply") return { skip: true, message: `reopen 当前只支持 --to explore、--to propose 或 --to apply，不支持 ${to}` };
      if (snapshot.state !== "apply_done" && snapshot.state !== "review") {
        return { skip: true, message: `当前状态 ${snapshot.state}，不能 reopen 到 apply` };
      }
      if (applyPlanningMaterialsChanged(changeRoot, events)) {
        return { skip: true, message: "计划材料已变化，不能直接回到 Apply；请 reopen --to propose" };
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

export function reviewReady(projectRoot: string, change: string, changeRoot: string, risk = workflowRiskForProject(projectRoot)): TransitionResult {
  return commitTransition(projectRoot, change, changeRoot, {
    name: "review-ready", idempotencyInputs: { phase: "review-ready", risk },
    decide: (snapshot) => {
      const events = readEvents(projectRoot, change);
      const storedPolicy = readReviewPolicyFromEvents(events);
      const policy = storedPolicy ?? reviewPolicyForRisk(risk);
      const policyPayload = storedPolicy ? {} : { review_policy: policy };
      const currentEvidenceDigest = reviewEvidenceDigest(events);

      if (snapshot.state === "apply" && applyPlanningMaterialsChanged(changeRoot, events)) {
        return { skip: true, message: "Apply 期间计划材料已变化，不能进入 Review；请回到 Propose 核对并重新批准计划" };
      }

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
        const blockingJobs = blockingJobsForApplyDone(projectRoot, events, snapshot);
        if (blockingJobs.length > 0) {
          return {
            blocked: true,
            reason: `状态未推进；有 ${blockingJobs.length} 个待完成工作项`,
            jobs: blockingJobs,
          };
        }
        const codeReviewDecision = evaluateApplyDoneCodeReviewGate({
          events,
          projectRoot,
          changeRoot,
          change,
          policyPayload,
        });
        if (
          !("skip" in codeReviewDecision) &&
          !("blocked" in codeReviewDecision) &&
          codeReviewDecision.fromState === "apply_done" &&
          codeReviewDecision.toState === "review"
        ) {
          return authorizePhaseAdvance({
            projectRoot,
            events,
          snapshot,
          boundary: "apply_to_review",
          risk: policy.review_risk,
          decision: codeReviewDecision,
          });
        }
        return codeReviewDecision;
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
        mode: { kind: "risk", risk: workflowRiskForProject(projectRoot) },
      });
      return transitionPlanToDecision(snapshot, changeRoot, change, plan, events);
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

      const events = readEvents(projectRoot, change);
      if (applyPlanningMaterialsChanged(changeRoot, events)) {
        return { skip: true, message: "Apply 期间计划材料已变化，不能完成当前任务；请回到 Propose 核对并重新批准计划" };
      }

      // task_completed 与 tasks.md 的完成标记必须作为一个可重试的提交边界；
      // 先确认目标仍是实际 checkbox 任务，避免契约模式只凭 attempt 记录完成事件。
      const taskLines = readFileSync(join(changeRoot, "tasks.md"), "utf8").split("\n");
      const taskLine = findTaskLine(taskLines, taskId);
      if (taskLine < 0) {
        return { skip: true, message: `tasks.md 中找不到任务 ${taskId}，未登记完成事件` };
      }

      const readiness = taskEvidenceReadiness(projectRoot, change, changeRoot, attempt);
      if (!readiness.ready) return { skip: true, message: `任务 ${taskId} 无法完成：${readiness.reason}` };
      const taskStartBoundary = boundarySnapshotForTaskAttempt(events, attempt.attempt_id);

      const completedPayload: Record<string, unknown> = {
        task_id: taskId,
        attempt_id: attempt.attempt_id,
        execution_policy: attempt.execution_policy ?? "tdd",
        ...boundarySnapshotPayload(projectRoot),
        checkbox_update: { status: "pending" },
        ...(scopeInput.value ? { scope_note: scopeInput.value } : {}),
      };

      return {
        fromState: "apply", toState: "apply", outcome: "advanced" as const,
        reason: `任务 ${taskId} 完成`,
        extraEvents: [{ type: "task_completed", payload: completedPayload }],
        postCommit: (pr: string, _ch: string, cr: string) => {
          const lines = readFileSync(join(cr, "tasks.md"), "utf8").split("\n");
          const idx = findTaskLine(lines, taskId);
          if (idx < 0) {
            throw new Error(`任务 ${taskId} 完成失败：tasks.md 中找不到任务行，未写入完成事件`);
          }
          if (lines[idx].match(/- \[[xX]\]/)) {
            completedPayload.checkbox_update = { status: "applied" };
          } else {
            if (!lines[idx].match(/- \[ \]/)) {
              throw new Error(`任务 ${taskId} 完成失败：tasks.md 中找不到可勾选复选框，未写入完成事件`);
            }
            lines[idx] = lines[idx].replace(/- \[ \]/, "- [x]");
            writeFileSync(join(cr, "tasks.md"), lines.join("\n"));
            completedPayload.checkbox_update = { status: "applied" };
          }
          completedPayload.java_staging = stageProductionJavaFilesSince(pr, taskStartBoundary);
        },
      };
    },
  });
}
