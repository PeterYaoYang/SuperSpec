// SuperSpec 流程引擎 — 核心类型定义

// ===== 状态 =====
export type State =
  | "init" | "explore" | "propose" | "propose_ready"
  | "apply" | "apply_done" | "review" | "accepted"
  | "archive" // legacy replay-only：新工作流不再提供进入此状态的 transition
  | "abandoned";

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
}

export interface ExecutionContract {
  tests: string[];
  design: string | null;
  source: string[];
  reason: string | null;
  guard: string | null;
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

export interface TaskExecutionIndexEntry {
  task_id: string;
  attempt_id: string;
  changed_paths: string[] | null;
  // committed 段 git diff 失败时的原因；此时 changed_paths 只含 dirty 侧对比结果
  changed_paths_partial_reason?: string;
  contract: ExecutionContract | null;
  declared_tests: string[];
  scope_note: Record<string, unknown> | null;
  test_evidence: Record<string, unknown>[];
  task_completed_event_ref: string;
}

export interface CoverageExemptionRef {
  test_id: string;
  event_id: string;
  event_digest: string;
  answer: string;
}

export interface JobPacketContext {
  code_review_scope?: CodeReviewScope;
  coverage_exemption_refs?: CoverageExemptionRef[];
  task_execution_index?: TaskExecutionIndexEntry[];
  unattributed_paths?: string[];
  unknown_attribution_tasks?: string[];
  code_state_check?: CodeStateCheck;
}

export interface JobPacket {
  job_id: string;
  role: JobRole;
  gate_id?: ReviewJobGateId;
  recommended_agent?: string;
  boundFiles: Ref[];
  review_targets?: string[];
  read_only_refs?: string[];
  review_evidence_digest?: string;
  previous_rejection?: ReviewPreviousRejection;
  packet_context?: JobPacketContext;
  code_review_scope?: CodeReviewScope;
  coverage_exemption_refs?: CoverageExemptionRef[];
  task_execution_index?: TaskExecutionIndexEntry[];
  unattributed_paths?: string[];
  unknown_attribution_tasks?: string[];
  code_state_check?: CodeStateCheck;
  packet_digest: string;
  required_output_kind: string;
  preferred_input_mode?: "stdin" | "file";
  submission_command?: string;
  submission_argv?: string[];
  file_fallback?: boolean;
  output_contract_fields?: string[];
  output_contract_optional_fields?: string[];
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
  | "user_decision_recorded" | "test_run_recorded"
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
    decision_event_id: string;
  };
  accepted_baseline_docs?: Record<string, string>;
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
  contract?: ExecutionContract | null;
  contract_mode?: boolean;
  tdd_required?: boolean;
  no_tdd_reason?: string | null;
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
  };
  resume: AskUserActionResume;
}

export interface AskUser {
  question: string;
  allowed_answers: string[];
  scope: string;
  actions?: AskUserAction[];
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

export type NextOutput = {
  state: State;
} & (
  | { path: "next_command"; next_command: string; reason: string; missing_inputs: MissingInput[] }
  | { path: "required_job"; required_jobs: RequiredJobAction[]; reason: string }
  | { path: "ask_user"; ask_user: AskUser; reason: string }
  | { path: "done"; reason: string; continuation?: AcceptedMaterialFollowupContinuation }
);

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
export interface RecordResult {
  event_type: EventType;
  accepted: boolean;
  message: string;
  job_state?: JobState;
}
