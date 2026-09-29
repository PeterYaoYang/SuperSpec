// SuperSpec 流程引擎 — 核心类型定义

// ===== 状态 =====
export type State =
  | "init" | "explore" | "propose" | "propose_ready"
  | "apply" | "apply_done" | "review" | "accepted"
  | "archive" // legacy replay-only：新工作流不再提供进入此状态的 transition
  | "abandoned";

export type ExecutionPolicy = "tdd" | "green_only";

/** 新 change 在这两档中选择；strict 仍对历史轮次有效。 */
export type ChangeWorkflowMode = "minimal" | "normal";

export interface WorkflowModeSelection {
  mode: ChangeWorkflowMode;
  source: "agent" | "user";
  reason: string;
  /** 用户原话，仅作来源记录，不用于身份校验。 */
  user_request?: string;
}

export interface WorkflowModeStatus {
  workflow_mode: ChangeWorkflowMode | "strict" | null;
  mode_source: "agent" | "user" | "legacy" | "unselected";
  mode_reason: string;
  mode_frozen: boolean;
  /** reopen --upgrade-mode 已请求 normal，尚未登记且未被用户决定清除。 */
  mode_upgrade_pending?: true;
  mode_upgrade?: WorkflowModeUpgradeAction;
}

export interface WorkflowModeSelectionRecordInput {
  mode: ChangeWorkflowMode | null;
  source: "agent" | "user";
  reason: string | null;
  user_request?: string | null;
}

export interface WorkflowModeSelectionAction {
  allowed_modes: ChangeWorkflowMode[];
  record_argv: string[];
  record_input: WorkflowModeSelectionRecordInput;
  user_record_input: WorkflowModeSelectionRecordInput;
  instruction: string;
}

export interface WorkflowModeUpgradeAction {
  target_mode: "normal";
  reopen_argv: string[];
  instruction: string;
}
export const GREEN_ONLY_NO_TDD_REASON = "green-only";

// Phase 1 只实现前 4 个
export const PHASE1_STATES: ReadonlySet<State> = new Set(["init", "explore", "propose", "propose_ready"]);

// ===== 引用 =====
export type Ref = { path: string; sha: string };

// ===== 工作项 =====
export type JobState = "requested" | "accepted" | "rejected";

export type JobRole =
  | "critic" | "architect" | "test-engineer"
  | "executor" | "test-run" | "verifier" | "code-reviewer";

export type ReviewJobGateId =
  | "explore.discovery_review"
  | "propose.final_review"
  | "review.code_review"
  | "review.final_verifier";

export type CodeReviewResultKind = "invalid_report" | "non_actionable_report" | "review_failed";
export type CodeReviewClaimKind = "missing_approved" | "breaks_existing" | "unjustified_addition";

export interface ReviewPreviousRejection {
  result_kind: CodeReviewResultKind;
  reason: string;
  job_id: string;
  findings?: unknown[];
  findings_job_id?: string;
}

export type CodeReviewPreviousRejection = ReviewPreviousRejection;

export interface Job {
  job_id: string;
  role: JobRole;
  state: JobState;
  gate_id?: ReviewJobGateId;
  boundFiles: Ref[];
  review_targets?: string[];
  read_only_refs?: string[];
  review_evidence_digest?: string;
  packet_digest: string;
  packet_context?: JobPacketContext;
  created_from_transition: string;
  created_at: string;
  previous_rejection?: ReviewPreviousRejection;
  /** 计划材料审查工作项创建时的逐文件指纹（目录绑定展开为其中的 .md 文件），正文按指纹另存。 */
  material_manifest?: MaterialFileRef[];
  /** 同角色最近一次形成结论（通过或 fail）的审查工作项及其逐文件指纹；存在时本工作项只需审查相对它的材料变化。 */
  review_baseline?: ReviewBaseline;
}

/** 相对 change 目录的材料文件路径及内容指纹。 */
export interface MaterialFileRef {
  path: string;
  sha: string;
}

export interface ReviewBaseline {
  job_id: string;
  material_manifest: MaterialFileRef[];
  /** 缺省表示基线审查已通过；review_failed 表示它完整审查后以 fail 结论被拒，其 finding 随 previous_rejection 下发。 */
  result_kind?: "review_failed";
}

export interface EvidenceCodeFile {
  path: string;
  sha: string;
}

export interface PreviousReviewEvidence {
  job_id: string;
  verdict: "pass" | "fail";
  summary?: string;
  evidence_refs?: unknown[];
  /** 报告引用的代码文件；unchanged 表示内容与报告提交时一致。 */
  code_files: { path: string; unchanged: boolean }[];
}

export interface ConfirmedDecision {
  phase: "explore" | "propose";
  question_id: string | null;
  question: string;
  answer: string;
  /** 闭环前同一问题下需要补充的答复，与 answer 一起构成用户的完整答复。 */
  earlier_answers?: { answer: string; followup?: string }[];
  event_id: string;
}

export interface MaterialDeltaEntry {
  path: string;
  status: "added" | "removed" | "modified";
  /** 相对基线的 unified diff；缺失时 diff_unavailable 说明原因，需要完整审查该文件。 */
  diff?: string;
  diff_unavailable?: string;
}

export interface ExecutionContract {
  tests: string[];
  design: string | null;
  source: string[];
  acceptance: string | null;
  guard: string | null;
}

/**
 * task-start 将计划中的声明和本轮已冻结策略编译出的有效证据要求。
 * 这是 attempt 的不可变快照；Apply 与 task-complete 只消费它，不再解释任务行的 TDD 标记。
 */
export interface EffectiveEvidencePlan {
  test_ids: string[];
  red_required: boolean;
  green_required: boolean;
  accepted_green_statuses: Array<"expected_success" | "characterization_pass">;
}

/**
 * 状态机创建的实现修复工作项。它只纠正已批准 task 的实现，不产生新的计划需求。
 * 旧事件没有该字段时按历史行为回放。
 */
export type FixSource = "code_review" | "self_test";

export interface FixDescriptor {
  fix_id: string;
  source: FixSource;
  parent_task_id: string | null;
  reason: string;
  review_finding?: {
    job_id: string;
    finding_id: string;
    approved_refs?: string[];
    claim_kind?: CodeReviewClaimKind;
  };
}

export interface DirtyFileFingerprint {
  path: string;
  status: "added" | "modified" | "deleted";
  sha256: string | null;
}

export interface BoundarySnapshot {
  head: string | null;
  head_reason?: string;
  dirty_files_reason?: string;
  dirty_files: DirtyFileFingerprint[];
}

export interface CodeReviewScope {
  base_head: string | null;
  current_head: string | null;
  scope_reliable: boolean;
  scope_reason: string;
  committed_paths: string[] | null;
  worktree_paths: string[];
  untracked_paths: string[];
  review_paths: string[];
}

export interface CodeStateCheck {
  baseline_head: string | null;
  current_head: string | null;
  head_matches: boolean;
  changed_paths: string[];
  scope_reason: string;
}

/** 最终验证读取的最新代码审查门禁事实。 */
export interface CodeReviewGateEvidence {
  decision: "passed" | "skipped";
  job_id: string | null;
  packet_digest: string | null;
  reason?: "no_code_changes";
  /** pass 结论下的范围外未检查项：门禁事实的一部分，供最终验证与使用方判断置信边界。 */
  out_of_scope_unchecked?: { path: string; reason: string }[];
  event_id: string;
  event_digest: string;
}

export interface TaskExecutionIndexEntry {
  task_id: string;
  attempt_id: string;
  fix?: FixDescriptor | null;
  execution_policy: ExecutionPolicy;
  changed_paths: string[] | null;
  // committed 段 git diff 失败时的原因；此时 changed_paths 只含 dirty 侧对比结果
  changed_paths_partial_reason?: string;
  contract: ExecutionContract | null;
  required_evidence: EffectiveEvidencePlan | null;
  declared_tests: string[];
  scope_note: Record<string, unknown> | null;
  test_evidence: Record<string, unknown>[];
  task_completed_event_ref: string;
}

export interface TaskExecutionIndexScope {
  /** 索引收录该事件之后完成的任务；null 表示收录全部历史。 */
  since_event_id: string | null;
  /** 早于 since_event_id、因被收录的修复任务通过 parent_task_id 关联而带入的任务。 */
  carried_task_ids: string[];
}

export interface CoverageExemptionRef {
  test_id: string;
  event_id: string;
  event_digest: string;
  answer: string;
}

export interface JobPacketContext {
  code_review_scope?: CodeReviewScope;
  code_review_gate?: CodeReviewGateEvidence;
  coverage_exemption_refs?: CoverageExemptionRef[];
  task_execution_index?: TaskExecutionIndexEntry[];
  task_execution_index_scope?: TaskExecutionIndexScope;
  unattributed_paths?: string[];
  unknown_attribution_tasks?: string[];
  added_code_paths?: string[];
  structure_ledger?: StructureChangeLedger;
  code_state_check?: CodeStateCheck;
  deliverable_docs?: DirtyFileFingerprint[];
}

export interface JobPacket {
  job_id: string;
  role: JobRole;
  gate_id?: ReviewJobGateId;
  recommended_agent?: string;
  boundFiles: (Ref & { project_path?: string })[];
  review_targets?: string[];
  read_only_refs?: string[];
  review_evidence_digest?: string;
  previous_rejection?: ReviewPreviousRejection;
  code_review_scope?: CodeReviewScope;
  code_review_gate?: CodeReviewGateEvidence;
  coverage_exemption_refs?: CoverageExemptionRef[];
  task_execution_index?: TaskExecutionIndexEntry[];
  task_execution_index_scope?: TaskExecutionIndexScope;
  unattributed_paths?: string[];
  unknown_attribution_tasks?: string[];
  added_code_paths?: string[];
  structure_ledger?: StructureChangeLedger;
  code_state_check?: CodeStateCheck;
  deliverable_docs?: DirtyFileFingerprint[];
  review_baseline?: Pick<ReviewBaseline, "job_id" | "result_kind">;
  material_delta?: MaterialDeltaEntry[];
  previous_review_evidence?: PreviousReviewEvidence;
  confirmed_decisions?: ConfirmedDecision[];
  packet_digest: string;
  required_output_kind: string;
  preferred_input_mode?: "stdin" | "file";
  submission_command?: string;
  submission_argv?: string[];
  inline_submission_command?: string;
  file_fallback?: boolean;
  /** 需要落盘时的报告文件位置（项目相对路径），位于工作流记录目录而非计划材料目录。 */
  report_file_path?: string;
  output_contract_fields?: string[];
  output_contract_optional_fields?: string[];
  /** 按本工作项预填的报告骨架；完整契约见 `superspec jobs contract`。 */
  report_skeleton?: Record<string, unknown>;
  字段说明?: Record<string, string>;
  output_instructions?: string;
  stop_conditions: string[];
  created_from_transition: string;
}

export interface RequiredJobAction {
  job_id: string;
  role: JobRole;
  packet_command: string;
  packet_argv: string[];
  /** 引擎生成的派发说明（角色 prompt + 工作项契约），主流程原样交给执行该工作项的独立角色。 */
  dispatch_command: string;
  dispatch_argv: string[];
}

// ===== 事件 =====
export type EventType =
  // transition events
  | "transition_prepare" | "transition_commit"
  | "job_requested" | "job_invalidated"
  | "reopen" | "abandon"
  // task events
  | "task_started" | "task_completed" | "task_abandoned"
  // record events (don't advance state)
  | "job_accepted" | "job_rejected"
  | "user_question_presented" | "user_decision_recorded" | "test_run_recorded"
  | "workflow_mode_selected"
  | "task_activation_recorded" | "artifact_recorded";

export interface Event {
  event_id: string;
  event_type: EventType;
  change_id: string;
  transition_id: string | null;
  idempotency_key: string | null;
  created_at: string;
  actor: string;
  prev_snapshot_digest: string | null;
  input_refs: Ref[];
  output_refs: Ref[];
  payload: Record<string, unknown>;
  event_digest: string;
}

export type OpenSpecValidationProfile =
  | { mode: "disabled" }
  | { mode: "strict"; config_digest: string };

export interface PlanningValidationProfile {
  version: 2;
  openspec: OpenSpecValidationProfile;
  design?: { schema_version: 1 | 2 };
}

export interface StructureChangeEntry {
  id: string;
  category: string;
  change: string;
  basis: string;
  decision: string;
}

export interface StructureChangeLedger {
  present: boolean;
  none: boolean;
  entries: StructureChangeEntry[];
  /** 标题存在但表格无法解析时的原因；有值时 entries 为空。 */
  format_error?: string;
}

// transition_commit payload 格式
export interface TransitionCommitPayload {
  transition: string;          // "propose-ready" 等
  from_state: State;
  to_state: State;             // 状态不变时 = from_state
  outcome: "advanced" | "job_created";  // advanced=状态推进, job_created=状态不变但创建了 job
  created_job_ids: string[];   // 本次创建的 job
  new_jobs?: Job[];
  reason: string;
  review_policy?: {
    review_risk: "minimal" | "normal" | "strict";
    requires_verifier: boolean;
  };
  code_review_gate?: {
    decision: "passed" | "skipped";
    job_id?: string;
    packet_digest?: string;
    current_head?: string | null;
    head?: string | null;
    reason?: "no_code_changes";
  };
  phase_confirmation?: {
    // accepted_to_archive 仅用于读取升级前已经写入的历史 transition commit。
    boundary: "explore_to_propose" | "propose_to_apply" | "apply_to_review" | "accepted_to_archive";
    decision: "advance";
    epoch_event_id: string;
    material_digest: string;
    scope: string;
    /** 用户确认的答复事件；自动推进（mode=auto）没有用户答复，改由 auto_basis 留痕推进依据。 */
    decision_event_id?: string;
    mode?: "auto";
    auto_basis?: Record<string, unknown>;
    review_risk?: "minimal" | "normal" | "strict";
  };
  accepted_baseline_docs?: Record<string, string>;
  /** Apply 开始时冻结的计划材料摘要；tasks.md 由状态机维护，不参与冻结。 */
  apply_planning_baseline?: Record<string, string>;
  /** 新模式协议的标记；带此标记的 change 不再回落到可变项目配置。 */
  workflow_mode_version?: 1;
  /** reopen 到 explore 时显式请求 minimal → normal 升级。 */
  workflow_mode_upgrade_target?: "normal";
  /** Propose-ready / start-apply 写入的本轮 workflow mode，后续阶段只读该快照。 */
  workflow_mode?: "minimal" | "normal" | "strict";
  /** v2 起所有普通任务必须有五字段执行依据；缺失表示旧 change，沿用旧规则回放。 */
  execution_requirement_version?: 2;
  /** 新 planning round 的格式协议版本；缺失表示升级前的 v1 change。 */
  planning_validation_version?: 2;
  /** propose-ready 成功时冻结的 OpenSpec 校验 profile，start-apply 只回放此快照。 */
  planning_validation_profile?: PlanningValidationProfile;
  execution_policy?: ExecutionPolicy;
}

// ===== Snapshot =====
export interface Snapshot {
  change_id: string;
  state: State;
  openspec_status_digest: string;
  events_digest: string;
  document_digests: Record<string, string>;
  tasks_structure_digest: string | null;
  task_statuses: Record<string, "todo" | "doing" | "done">;
  open_jobs: Job[];
  accepted_jobs: Job[];
  active_task_attempts: TaskAttempt[];
  pending_user_decisions: AskUser[];
  last_transition: string | null;
  computed_at: string;
}

// ===== Task Attempt =====
export type AttemptState = "active" | "closed" | "abandoned";

export interface TaskAttempt {
  attempt_id: string;
  task_id: string;
  state: AttemptState;
  task_structure_digest: string;
  fix?: FixDescriptor | null;
  contract?: ExecutionContract | null;
  contract_mode?: boolean;
  /** task-start 编译出的有效执行要求；缺失表示历史 attempt，按旧字段回放。 */
  required_evidence?: EffectiveEvidencePlan | null;
  // 以下两个字段仅用于回放历史 task；新的执行依据模式不再写入它们。
  tdd_required?: boolean;
  no_tdd_reason?: string | null;
  execution_policy?: ExecutionPolicy;
  declared_write_scope: string[];
  pre_edit_source_fingerprint: string | null;
  pre_edit_red_ref: string | null;
  executor_packet_digest: string | null;
  executor_result_ref: string | null;
  post_edit_green_ref: string | null;
  created_at: string;
}

// ===== Test Run =====
export interface TestRun {
  test_id: string;
  attempt_id?: string | null;
  task_structure_digest?: string;
  covers_task_ids?: string[];
  command: string;
  cwd: string;
  exit_code: number;
  semantic_status: "expected_failure" | "expected_success" | "characterization_pass" | "unknown";
  target_fingerprint: string | null;
  raw_log_ref: string | null;
  created_at: string;
}

// ===== NextOutput =====
export interface MissingInput {
  field: string;
  expected: string;
  command_to_fix: string;
}

export type AskUserActionResume =
  | { kind: "next"; argv: string[] }
  | {
      kind: "continue_current_phase";
      instruction: string;
      next_argv_after_completion: string[];
    }
  | { kind: "stop" };

export interface AskUserAction {
  label: string;
  selection: "exact_label";
  reason: "none" | "required" | "optional";
  reason_prompt?: string;
  record_argv: string[];
  record_input: {
    scope: string;
    question: string;
    answer: string;
    reason?: string;
    review_risk?: "minimal" | "normal" | "strict";
  };
  resume: AskUserActionResume;
}

export type OpenQuestionClosure = "closed" | "needs_followup";

export interface OpenQuestionAnswerRecord {
  event_id: string;
  answer: string;
  closure: OpenQuestionClosure;
  followup?: string;
  /** 登记在当前问题版本（决策依据未变）上；false 表示登记在此前的版本上，不自动适用。 */
  current_revision: boolean;
}

export interface AskUser {
  question: string;
  allowed_answers: string[];
  scope: string;
  actions?: AskUserAction[];
  /** 自由文本问题的直接登记入口；固定选项继续使用 actions。 */
  record_argv?: string[];
  record_input?: {
    scope: string;
    question: string;
    answer: null;
    /** 待确认问题：答复不足以确定这件事时改为 needs_followup，并在 followup 写明还需补充什么。 */
    closure?: OpenQuestionClosure;
    followup?: null;
  };
  required_fields?: Array<"answer">;
  /** 待确认问题的登记说明：何时用 needs_followup 在同一问题下追问。 */
  instruction?: string;
  /** 本轮同一问题此前登记的答复；需要补充的答复在同一问题下继续询问。 */
  answer_history?: OpenQuestionAnswerRecord[];
}

export interface AcceptedMaterialFollowupContinuation {
  kind: "accepted_material_followup";
  trigger: "material_user_followup";
  reason_source: "summarize_user_input";
  reopen_argv_template: string[];
  resume: {
    kind: "continue_current_phase";
    instruction: string;
    next_argv_after_completion: string[];
  };
  plan_docs_changed_since_accept: boolean | null;
}

export type WorkflowArtifactKind = "discovery" | "proposal" | "specs" | "design" | "test_contract" | "tasks";

/** 当前 change 的目录与各工作流材料相对项目根的路径。 */
export type ChangeMaterialPaths = { change_root: string } & Record<WorkflowArtifactKind, string>;

export interface RequiredWorkflowArtifact {
  kind: WorkflowArtifactKind;
  /** Repository-relative canonical path owned by the workflow engine. */
  path: string;
  operation: "create_or_update";
}

export interface ArtifactRequiredResume {
  argv: string[];
}

export interface MaterialUpdateRequiredResume {
  argv: string[];
}

export interface TestEvidenceAction {
  kind: "test_run";
  test_id: string;
  record_argv: string[];
  record_input: {
    test_id: string;
    attempt_id: string;
    command: null;
    cwd: null;
    exit_code: null;
    semantic_status: "expected_failure" | "expected_success" | "characterization_pass";
  };
  required_fields: Array<"command" | "cwd" | "exit_code">;
}

/** review-fix 计划附带的原始审查问题上下文；仅供定位代码，不是实现授权。 */
export interface ReviewFindingContext {
  evidence: string;
  note: string;
}

/** 最近一次通过的代码审查 / 最终验证报告里不阻塞推进的意见；不进门禁，交付时交给使用者判断。 */
export interface ReviewLeftoverItem {
  role: JobRole;
  job_id: string;
  kind: "finding" | "risk";
  id?: string;
  text: string;
}

export interface ReviewLeftovers {
  items: ReviewLeftoverItem[];
  instruction: string;
}

export type NextOutput = {
  state: State;
} & Partial<WorkflowModeStatus> & (
  | {
      path: "next_command";
      next_command: string;
      reason: string;
      missing_inputs: MissingInput[];
      finding_context?: ReviewFindingContext;
      /** 执行 next_command 只会创建这些角色的审查工作项，状态不会推进。 */
      creates_review_jobs?: JobRole[];
      review_leftovers?: ReviewLeftovers;
    }
  | { path: "required_job"; required_jobs: RequiredJobAction[]; instruction?: string; reason: string }
  | { path: "artifact_required"; artifact: RequiredWorkflowArtifact; resume: ArtifactRequiredResume; reason: string }
  | { path: "material_update_required"; errors: string[]; resume: MaterialUpdateRequiredResume; reason: string }
  | { path: "test_rerun_required"; test_reruns: TestEvidenceAction[]; changed_paths: string[]; resume: { argv: string[] }; reason: string }
  | { path: "mode_selection_required"; selection: WorkflowModeSelectionAction; reason: string }
  | { path: "ask_user"; ask_user: AskUser; reason: string }
  | { path: "review_rejected"; review_rejection: Record<string, unknown>; reason: string }
  | { path: "done"; reason: string; continuation?: AcceptedMaterialFollowupContinuation; review_leftovers?: ReviewLeftovers }
);

/**
 * next 命令的完整输出。stop_allowed 只在等待用户答复或流程终态时为 true；
 * warnings 是不阻断当前路径、但需要主流程处理的工作区异常；material_paths
 * 是提示中提到的材料的读写位置。
 */
export type NextCommandOutput = NextOutput & {
  stop_allowed: boolean;
  material_paths: ChangeMaterialPaths;
  warnings?: string[];
};

// ===== Transition 结果 =====
export interface TransitionResult {
  transition: string;
  outcome: "advanced" | "job_created" | "blocked";
  from_state: State;
  to_state: State;
  created_jobs: string[];
  required_jobs?: RequiredJobAction[];
  message: string;
  events_written: number;
  details?: Record<string, unknown>;
}

// ===== Record 结果 =====
/**
 * 工作项报告的登记结果：accepted / review_failed / non_actionable_report 表示结论已登记为本工作项结果；
 * invalid_report 表示报告已终结但不构成结论；retryable 可修正后以同一工作项重交；
 * job_closed / job_invalidated / job_not_found 表示本次提交没有写入任何结论。
 */
export type JobSubmitResultKind =
  | "accepted"
  | "review_failed"
  | "non_actionable_report"
  | "invalid_report"
  | "retryable"
  | "job_closed"
  | "job_invalidated"
  | "job_not_found";

export interface RecordResult {
  /** 多数情况下是本次写入的事件类型，为空通常表示输入在写事件前被拒；工作项报告的登记结果以 result_kind 为准。 */
  event_type?: EventType;
  accepted: boolean;
  message: string;
  job_state?: JobState;
  events_written?: number;
  result_kind?: JobSubmitResultKind;
}
