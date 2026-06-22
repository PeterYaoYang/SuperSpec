// SuperSpec 流程引擎 — 核心类型定义

// ===== 状态 =====
export type State =
  | "init" | "explore" | "propose" | "propose_ready"
  | "apply" | "apply_done" | "review" | "accepted" | "archive" | "abandoned";

// Phase 1 只实现前 4 个
export const PHASE1_STATES: ReadonlySet<State> = new Set(["init", "explore", "propose", "propose_ready"]);

// ===== 引用 =====
export type Ref = { path: string; sha: string };

// ===== 工作项 =====
export type JobState = "requested" | "accepted" | "rejected";

export type JobRole =
  | "critic" | "architect" | "test-engineer"
  | "executor" | "test-run" | "verifier";

export interface Job {
  job_id: string;
  role: JobRole;
  state: JobState;
  boundFiles: Ref[];
  review_evidence_digest?: string;
  packet_digest: string;
  created_from_transition: string;
  created_at: string;
}

export interface JobPacket {
  job_id: string;
  role: JobRole;
  recommended_agent?: string;
  boundFiles: Ref[];
  review_evidence_digest?: string;
  packet_digest: string;
  required_output_kind: string;
  output_contract_fields?: string[];
  output_contract_optional_fields?: string[];
  stop_conditions: string[];
  created_from_transition: string;
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
  task_structure_digest: string;
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

export interface AskUser {
  question: string;
  allowed_answers: string[];
  scope: string;
}

export type NextOutput = {
  state: State;
} & (
  | { path: "next_command"; next_command: string; reason: string; missing_inputs: MissingInput[] }
  | { path: "required_job"; required_jobs: { job_id: string; role: JobRole; packet_command: string }[]; reason: string }
  | { path: "ask_user"; ask_user: AskUser; reason: string }
  | { path: "done"; reason: string }
);

// ===== Transition 结果 =====
export interface TransitionResult {
  transition: string;
  outcome: "advanced" | "job_created";
  from_state: State;
  to_state: State;
  created_jobs: string[];
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
