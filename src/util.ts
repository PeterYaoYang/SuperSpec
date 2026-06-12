import { createHash } from "node:crypto";
import { existsSync, lstatSync, readFileSync, readdirSync, realpathSync, statSync } from "node:fs";
import { dirname, extname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { spawnSync } from "node:child_process";
import { action_detail_zh, action_label_zh, action_status_zh, command_zh, decision_zh, gate_zh, reason_message_zh, reason_zh, translate_action_zh, trust_warning_zh, workflow_terms_zh_for, type WorkflowTermHint } from "./i18n.ts";

export const SCHEMA_VERSION = 1;
export const GUARD_VERSION = "superspec-guard@1";
export const CONFIG_FILENAME = "config.yaml";
export const STATE_FILENAME = "superspec-state.json";
export const STATE_LOCK_FILENAME = "superspec-state.lock";

export const PROJECT_CONFIG_ALIASES = [
  ".superspec.yaml",
  ".superspec.yml",
  "superspec.yaml",
  "superspec.yml",
  "superspec.json",
  ".superspecrc",
  ".superspec/config.json",
] as const;
export const CHANGE_CONFIG_ALIASES = PROJECT_CONFIG_ALIASES;
export const STATE_ALIASES = [
  ".superspec/state.json",
  ".superspec/state.lock",
  ".superspec/superspec_state.json",
  ".superspec/superspec-state.yaml",
] as const;
export const REQUIRED_SIDECAR_DIRS = [
  "artifacts",
  "evidence/discovery",
  "evidence/design",
  "evidence/invariants",
  "evidence/test-contract",
  "evidence/tasks",
  "evidence/red",
  "evidence/green",
  "evidence/reviews",
  "evidence/verification",
  "evidence/archive",
  "handoffs",
  "reports",
  "raw",
] as const;

export type JsonMap = Record<string, any>;
export type Reason = { code: string; message: string; refs: string[]; label_zh?: string; hint_zh?: string; message_zh?: string };
export type Decision = {
  allowed: boolean;
  decision: "allow" | "block" | "status";
  change_id: string;
  gate: string;
  task_id: string | null;
  openspec_status_summary: Record<string, string>;
  superspec_gate_summary: Record<string, any>;
  block_reasons: Reason[];
  next_allowed_actions: string[];
  trust_warnings: string[];
  actions?: JsonMap[];
  decision_zh?: string;
  gate_label_zh?: string;
  gate_hint_zh?: string;
  command?: string;
  command_label_zh?: string;
  command_hint_zh?: string;
  next_allowed_actions_zh?: string[];
  trust_warnings_zh?: string[];
  workflow_terms_zh?: WorkflowTermHint[];
};
export type DecisionOutputFormat = "json" | "agent" | "user";
export type PacketOutputFormat = "agent" | "prompt";
export type AgentWorkflowAction =
  | "continue"
  | "fix_artifacts"
  | "ask_user_confirmation"
  | "collect_review_evidence"
  | "collect_test_evidence"
  | "repair_evidence"
  | "rerun_check"
  | "inspect_diagnostics";
export type TaskInfo = { task_id: string; checked: boolean; desc: string; attrs: Record<string, string> };

export const BUILTIN_CONFIG: JsonMap = {
  preset: "full",
  commands: {},
  roles: {},
  rules: {},
  trust: { v1_evidence: "audit-only" },
  archive: {},
};
export const ALLOWED_CONFIG_KEYS = new Set(Object.keys(BUILTIN_CONFIG));
export const EVIDENCE_STATUSES = new Set(["pass", "fail", "blocked", "superseded"]);
// FIX-7 (audit C-3): kind whitelist assembled from every kind the guard recognizes plus the
// conventional role-report kinds. A typo'd kind must fail loudly (evidence_unknown_kind)
// instead of silently surfacing as "missing evidence" at some downstream gate.
export const EVIDENCE_KINDS = new Set([
  "review",
  "subagent_report",
  "workflow_review",
  "source_guidance",
  "main_adjudication",
  "verification_review",
  "final_test",
  "test_run",
  "alternative_verification",
  "manual_verification",
  "apply_worker_chain",
  "task_reopen",
  "task_reopen_resolved",
  "human_confirmation",
  "superseded",
  // Disclosure fixed-point loop (DISC Phase 1): user-visible review disclosure evidence.
  "main_review_digest",
  "user_review_decision",
  "review_standing_authorization",
]);
// FIX-7 (audit C-3): gates where the guard consumes human_confirmation evidence.
// A confirmation recorded against any other gate is unreachable and therefore a mistake.
// FIX-8 (audit A-5) adds the previously anchor-less human pause points:
// apply isolation choice, apply-phase scope expansion, and verify-failure disposition.
export const HUMAN_CONFIRMATION_GATES = new Set([
  "explore_complete",
  "design_complete",
  "invariants_reviewed",
  "archive_ready",
  "preset_upgrade",
  "branch_handling",
  "apply_isolation",
  "scope_expansion",
  "verify_failure_handling",
]);
export const NO_TDD_REASONS = new Set([
  "documentation-only",
  "configuration-only",
  "test-only-refactor",
  "mechanical-rename",
  "generated-artifact-only",
  "non-executable-spec-change",
]);
export const TDD_MODES = new Set(["new-behavior", "behavior-preserving-refactor", "hotfix"]);
export const ROLE_EVIDENCE_FIELDS = ["agent_role", "agent_id", "prompt_ref", "output_ref", "source_anchors", "target_refs"] as const;
export const SELF_REVIEW_MARKERS = new Set(["main", "main-thread", "current-agent", "self", "lead", "leader", "orchestrator", "codex_exec"]);
export const REVIEW_EVIDENCE_REQUIRED_FIELDS = ["base_ref", "head_ref", "reviewed_files"] as const;
export const VERIFY_EVIDENCE_REQUIRED_FIELDS = ["openspec_validate_ref", "task_matrix_ref", "invariant_matrix_ref", "scope_drift_ref", "test_evidence_refs"] as const;
export const REVIEW_GUIDANCE_ROLES = ["code-reviewer", "architect", "critic"] as const;
export const FINAL_VERIFICATION_ROLES = ["verifier", "critic"] as const;
export const SOURCE_GUIDANCE_REQUIRED_FIELDS = ["source_refs", "required_load_refs", "required_claim_ids"] as const;
export const MAIN_ADJUDICATION_REQUIRED_FIELDS = ["output_ref", "source_evidence_refs", "verification_evidence_refs", "loaded_refs", "claim_adjudications", "finding_adjudications"] as const;
export const MAIN_ADJUDICATION_DECISIONS = ["allow", "request_changes"] as const;
export const REQUEST_CHANGES_ROUTES = ["reopen_tasks", "change_update"] as const;
export const CLAIM_ADJUDICATION_DECISIONS = ["accept", "reject", "needs_fix"] as const;
export const FINDING_ADJUDICATION_DECISIONS = ["dismissed", "accepted_fixed", "accepted_deviation", "needs_fix"] as const;
export const FINAL_TEST_REQUIRED_FIELDS = ["test_command", "output_ref"] as const;
export const TASK_REOPEN_REQUIRED_FIELDS = [
  "task_id",
  "reopen_id",
  "source_adjudication_evidence_id",
  "source_guidance_evidence_id",
  "violated_test_ids",
  "violated_requirement_refs",
  "invalidated_completion_evidence_ids",
  "required_supersede_evidence_ids",
  "completion_invalidity_class",
  "scope_expansion",
  "why_completion_invalid",
  "required_fix",
  "before_tasks_sha256",
  "after_tasks_sha256",
] as const;
export const TASK_REOPEN_RESOLVED_REQUIRED_FIELDS = [
  "reopen_evidence_id",
  "reopen_id",
  "task_id",
  "successor_completion_evidence_ids",
  "after_tasks_sha256",
] as const;
export const TASK_REOPEN_INVALIDITY_CLASSES = ["insufficient_completion_evidence"] as const;
export const FORBIDDEN_FIELDS = new Set([
  "current",
  "current_phase",
  "current_stage",
  "stage",
  "stage_order",
  "allowed_next",
  "completed_phases",
  "openspec_artifact_done",
  "artifact_status",
]);
export const OPENSPEC_ARTIFACTS = new Set(["proposal", "specs", "design", "tasks"]);
// Compatibility export for callers that imported the old repo-local OpenSpec bridge list.
// Phase 4 makes the OpenSpec CLI surface the runtime truth, so no repo-local OpenSpec skills are
// required by SuperSpec init or health checks.
export const REQUIRED_OPENSPEC_CODEX_SKILLS = [] as const;
// D4 (audit G-2): SuperSpec's own workflow skills are part of the init health surface — a deleted
// or renamed superspec-* skill must be visible at check-init, not discovered mid-workflow.
export const REQUIRED_SUPERSPEC_WORKFLOW_SKILLS = [
  "superspec-explore",
  "superspec-propose",
  "superspec-apply",
  "superspec-review",
  "superspec-archive",
] as const;
export const REQUIRED_SUPERSPEC_AGENT_ROLES = [
  "architect",
  "critic",
  "executor",
  "test-runner",
  "test-engineer",
  "code-reviewer",
  "verifier",
] as const;
export const REQUIRED_OPENSPEC_CLI_SURFACES = [
  ["list", "--help"],
  ["instructions", "--help"],
  ["archive", "--help"],
  ["validate", "--help"],
  ["status", "--help"],
] as const;
export const ARTIFACT_ENTER_GATE: Record<string, string> = {
  proposal: "explore_complete",
  // DISC Phase 2: specs/design authoring cannot start before the proposal critic review
  // has been run and its findings disclosed.
  specs: "proposal_reviewed",
  design: "proposal_reviewed",
  tasks: "test_contract_drafted",
};
export const ROUTE_ORDER: Record<string, number> = {
  init: 0,
  explore: 1,
  propose: 2,
  apply: 3,
  review: 4,
  archive: 5,
};
export const ROUTE_ALIASES: Record<string, string> = {
  start: "init",
  proposal: "propose",
  specs: "propose",
  design: "propose",
  tasks: "propose",
  "test-contract": "propose",
  "test-contract-drafted": "propose",
  "test-contract-honored": "propose",
  "business-invariants": "propose",
  "invariants-reviewed": "propose",
  "tasks-complete": "propose",
  "apply-ready": "propose",
  verify: "review",
  verification: "review",
  "archive-ready": "archive",
  archived: "archive",
  recompute: "init",
};
export const GATE_ALIASES: Record<string, string> = {
  "propose.explore_linked": "explore_complete",
  "propose.proposal_reviewed": "proposal_reviewed",
  "propose.design_reviewed": "design_complete",
  "propose.invariants_reviewed": "invariants_reviewed",
  "propose.test_plan_drafted": "test_contract_drafted",
  "propose.tasks_mapped": "tasks_complete",
  "propose.apply_ready": "apply_ready",
  apply_ready: "apply_ready",
};
export const GATE_ROUTE: Record<string, string> = {
  explore_complete: "explore",
  proposal_reviewed: "propose",
  design_complete: "propose",
  invariants_reviewed: "propose",
  test_contract_drafted: "propose",
  test_contract_honored: "propose",
  tasks_complete: "propose",
  propose_complete: "propose",
  apply_ready: "propose",
  review_complete: "review",
  verify_complete: "review",
  archive_ready: "archive",
};

export class GuardError extends Error {}

export const runtime: JsonMap = {};

export function parseDecisionOutputFormat(raw: string): DecisionOutputFormat {
  if (raw === "json" || raw === "agent" || raw === "user") return raw;
  throw new GuardError("--format 只允许 json、agent 或 user");
}

export function parsePacketOutputFormat(raw: string, opts: { allowPrompt?: boolean } = {}): PacketOutputFormat {
  if (raw === "agent") return raw;
  if (opts.allowPrompt && raw === "prompt") return raw;
  throw new GuardError(opts.allowPrompt ? "--format 只允许 agent 或 prompt" : "--format 只允许 agent");
}

export function reason(code: string, message: string, refs: string[] | null = null): Reason {
  const zh = reason_zh(code);
  return { code, message, refs: refs ?? [], label_zh: zh.label_zh, hint_zh: zh.hint_zh };
}

export function pinned_ref_key(item: JsonMap): string {
  return `${String(item.path)}\u0000${String(item.blob_sha)}`;
}

export function trustWarnings(): string[] {
  return [
    "v1 evidence is audit-only/self-reported unless explicitly backed by OpenSpec facts",
    "v1 role evidence cannot mechanically prove a native subagent ran; it only checks schema, freshness, output refs, and non-direct authorship markers",
  ];
}

export function allow(
  change: string,
  gate: string,
  opts: { task_id?: string | null; openspec_summary?: Record<string, string>; gate_summary?: Record<string, any> } = {},
): Decision {
  return {
    allowed: true,
    decision: "allow",
    change_id: change,
    gate,
    task_id: opts.task_id ?? null,
    openspec_status_summary: opts.openspec_summary ?? {},
    superspec_gate_summary: opts.gate_summary ?? {},
    block_reasons: [],
    next_allowed_actions: [],
    trust_warnings: trustWarnings(),
  };
}

export function block(
  change: string,
  gate: string,
  reasons: Reason[],
  opts: {
    task_id?: string | null;
    openspec_summary?: Record<string, string>;
    gate_summary?: Record<string, any>;
    next_actions?: string[];
  } = {},
): Decision {
  return {
    allowed: false,
    decision: "block",
    change_id: change,
    gate,
    task_id: opts.task_id ?? null,
    openspec_status_summary: opts.openspec_summary ?? {},
    superspec_gate_summary: opts.gate_summary ?? {},
    block_reasons: reasons,
    next_allowed_actions: opts.next_actions ?? [],
    trust_warnings: trustWarnings(),
  };
}

export function decorateDecision(decision: JsonMap, opts: { command?: string } = {}): JsonMap {
  const gateInfo = gate_zh(String(decision.gate ?? ""));
  const command = opts.command ?? (typeof decision.command === "string" ? String(decision.command) : "");
  const commandInfo = command ? command_zh(command) : null;
  const reasons = Array.isArray(decision.block_reasons)
    ? decision.block_reasons.map((item: unknown) => {
      const base = item && typeof item === "object" ? { ...(item as JsonMap) } : { code: String(item), message: "", refs: [] };
      const zh = reason_zh(String(base.code ?? ""));
      return { ...base, label_zh: zh.label_zh, hint_zh: zh.hint_zh };
    })
    : [];
  const nextActions = Array.isArray(decision.next_allowed_actions) ? decision.next_allowed_actions.map((item: unknown) => String(item)) : [];
  const windowsPowerShellHints = windowsPowerShellCommandHints([
    ...nextActions,
    ...reasons.map((item: JsonMap) => String(item.message ?? "")),
  ]);
  return {
    ...decision,
    command: command || decision.command,
    decision_zh: decision_zh(String(decision.decision ?? "")),
    gate_label_zh: gateInfo.label_zh,
    gate_hint_zh: gateInfo.hint_zh,
    command_label_zh: commandInfo?.label_zh,
    command_hint_zh: commandInfo?.hint_zh,
    block_reasons: reasons,
    next_allowed_actions_zh: nextActions.map((item) => translate_action_zh(item)),
    windows_powershell_command_hints: windowsPowerShellHints.length > 0 ? windowsPowerShellHints : undefined,
    trust_warnings_zh: Array.isArray(decision.trust_warnings) ? decision.trust_warnings.map((item: unknown) => trust_warning_zh(String(item))) : [],
    workflow_terms_zh: workflow_terms_zh_for(command || undefined, String(decision.gate ?? ""), reasons.map((item: JsonMap) => String(item.code ?? ""))),
  };
}

function windowsPowerShellCommandHints(texts: string[]): string[] {
  const hints = new Set<string>();
  for (const text of texts) {
    for (const match of text.matchAll(/`((?:superspec|openspec)\s+[^`]+)`/giu)) {
      const command = match[1]?.trim();
      if (!command) continue;
      hints.add(`Windows PowerShell: use \`${command.replace(/^(superspec|openspec)\b/iu, "$1.cmd")}\``);
    }
  }
  return [...hints];
}

function sanitizeReasonForOutput(item: JsonMap): JsonMap {
  const refs = Array.isArray(item.refs) ? item.refs.map((ref: unknown) => String(ref)) : [];
  return {
    ...item,
    refs,
    message: String(item.message ?? ""),
    message_zh: reason_message_zh(String(item.code ?? ""), String(item.message ?? ""), refs),
  };
}

function sanitizeDecisionForOutput(decision: JsonMap): JsonMap {
  const reasons = Array.isArray(decision.block_reasons) ? decision.block_reasons.map((item: unknown) => sanitizeReasonForOutput(item as JsonMap)) : [];
  const nextActions = Array.isArray(decision.next_allowed_actions)
    ? decision.next_allowed_actions.map((item: unknown) => String(item))
    : [];
  const nextActionsZh = Array.isArray(decision.next_allowed_actions_zh)
    ? decision.next_allowed_actions_zh.map((item: unknown) => String(item))
    : [];
  const trustWarnings = Array.isArray(decision.trust_warnings)
    ? decision.trust_warnings.map((item: unknown) => String(item))
    : [];
  const trustWarningsZh = Array.isArray(decision.trust_warnings_zh)
    ? decision.trust_warnings_zh.map((item: unknown) => String(item))
    : [];
  const actions = Array.isArray(decision.actions)
    ? decision.actions.map((item: unknown) => {
      const base: JsonMap = item && typeof item === "object" ? { ...(item as JsonMap) } : { action: String(item) };
      const action = String(base.action ?? "");
      const status = typeof base.status === "string" ? String(base.status) : "";
      const detail = typeof base.detail === "string" ? String(base.detail) : "";
      return {
        ...base,
        action,
        status: status || base.status,
        detail: detail || base.detail,
        action_zh: action_label_zh(action),
        status_zh: status ? action_status_zh(status) : undefined,
        detail_zh: detail ? action_detail_zh(detail) : undefined,
      };
    })
    : decision.actions;
  return {
    ...decision,
    block_reasons: reasons,
    next_allowed_actions: nextActions,
    next_allowed_actions_zh: nextActionsZh,
    trust_warnings: trustWarnings,
    trust_warnings_zh: trustWarningsZh,
    actions,
  };
}

function userFacingLine(value: unknown): string {
  return String(value ?? "").replace(/\s+/gu, " ").trim();
}

const SAFE_TEXT_REPLACEMENTS: Array<[RegExp, string]> = [
  [/\bneeds_user_decision_pending\b/giu, "等待用户确认"],
  [/\bneeds_user_decision\b/giu, "等待用户确认"],
  [/\buser_review_decision\b/giu, "用户确认记录"],
  [/\bmain_review_digest\b/giu, "审查问题记录"],
  [/\breview_standing_authorization\b/giu, "长期授权记录"],
  [/\bdecision_scope_key\b/giu, "确认范围"],
  [/\bfinding_uid\b/giu, "问题标识"],
  [/\bexport\s+function\s+[A-Za-z_$][\w$]*\s*\([^)]*\)/gu, "内部实现细节"],
  [/\bfunction\s+[A-Za-z_$][\w$]*\s*\([^)]*\)/gu, "内部实现细节"],
  [/\b[A-Za-z_$][\w$]*\s*\([^)]*\)/gu, "内部调用细节"],
  [/裁决/gu, "确认"],
];

function safeDisplayText(value: unknown): string {
  let out = userFacingLine(value);
  for (const [pattern, replacement] of SAFE_TEXT_REPLACEMENTS) out = out.replace(pattern, replacement);
  return out;
}

function fallbackReasonForWorkflowAction(action: AgentWorkflowAction): string {
  const fallbacks: Record<AgentWorkflowAction, string> = {
    continue: "当前检查已通过。",
    ask_user_confirmation: "需要用户确认后才能继续。",
    collect_review_evidence: "需要补齐审查或验证复核记录。",
    collect_test_evidence: "需要补齐测试或校验证据。",
    fix_artifacts: "需要修正方案、任务或证据结构。",
    repair_evidence: "需要修复证据记录。",
    rerun_check: "需要重新运行当前检查。",
    inspect_diagnostics: "需要查看诊断输出后处理。",
  };
  return fallbacks[action];
}

function safeReasonText(_item: JsonMap, action: AgentWorkflowAction = "inspect_diagnostics"): string {
  return fallbackReasonForWorkflowAction(action);
}

const WORKFLOW_ACTION_BY_REASON: Array<[Set<string>, AgentWorkflowAction]> = [
  [new Set([
    "needs_user_decision_pending",
    "user_decision_unbound",
    "missing_review_digest",
    "missing_human_confirmation",
    "apply_isolation_unconfirmed",
    "scope_expansion_unconfirmed",
    "finding_unresolved",
    "round_budget_exhausted",
  ]), "ask_user_confirmation"],
  [new Set([
    "missing_source_guidance",
    "missing_verification_review",
    "missing_final_verification_review",
    "missing_roles",
    "missing_native_subagent_evidence",
    "missing_invariant_review",
    "missing_test_contract_review",
    "missing_architect_review",
    "missing_critic_review",
    "missing_test-engineer_review",
    "missing_code-reviewer_review",
    "missing_verifier_review",
    "missing_main_adjudication",
    "proposal_reviewed_failed",
    "review_not_ready",
    "missing_proposal_review",
  ]), "collect_review_evidence"],
  [new Set([
    "missing_red_evidence",
    "missing_green_evidence",
    "missing_characterization",
    "test_contract_not_honored",
    "validate_failed",
    "missing_final_tests",
    "verify_failure_unconfirmed",
  ]), "collect_test_evidence"],
  [new Set([
    "missing_discovery",
    "missing_proposal",
    "missing_design",
    "missing_tasks",
    "invalid_task_graph",
    "invalid_business_invariants",
    "review_finding_invalid",
    "review_digest_invalid",
    "user_decision_invalid",
    "human_confirmation_invalid",
    "standing_authorization_invalid",
    "evidence_unknown_kind",
    "evidence_missing_field",
    "artifact_update_required",
    "rereview_required",
  ]), "fix_artifacts"],
  [new Set([
    "state_concurrent_update",
    "state_fingerprint_stale",
  ]), "rerun_check"],
  [new Set([
    "state_corrupt",
    "openspec_cli_unavailable",
    "openspec_native_surface_missing",
    "dirty_worktree_unavailable",
    "guard_error",
    "guard_internal_error",
    "unknown_gate",
    "unknown_artifact",
    "not_openspec_artifact",
  ]), "inspect_diagnostics"],
];

export function workflowActionForReasonCodes(reasonCodes: string[], allowed = false): AgentWorkflowAction {
  if (allowed) return "continue";
  const codes = new Set(reasonCodes);
  for (const [matches, action] of WORKFLOW_ACTION_BY_REASON) {
    for (const code of matches) {
      if (codes.has(code)) return action;
    }
  }
  return "inspect_diagnostics";
}

function summaryForWorkflowAction(action: AgentWorkflowAction, allowed: boolean): string {
  if (allowed || action === "continue") return "当前检查已通过，可以继续下一步。";
  const summaries: Record<Exclude<AgentWorkflowAction, "continue">, string> = {
    ask_user_confirmation: "当前阶段需要用户确认一个范围或处理方式选择后才能继续。",
    collect_review_evidence: "当前阶段缺少必要审查或验证复核记录，补齐后再继续。",
    collect_test_evidence: "当前阶段缺少测试或校验证据，补齐后再继续。",
    fix_artifacts: "当前阶段的方案、任务或证据结构需要修正后再继续。",
    repair_evidence: "当前证据记录需要修复后再继续。",
    rerun_check: "当前检查需要在输入稳定后重新运行。",
    inspect_diagnostics: "当前检查需要查看诊断输出后处理。",
  };
  return summaries[action];
}

function nextStepsForWorkflowAction(action: AgentWorkflowAction, allowed: boolean): string[] {
  if (allowed || action === "continue") return ["继续执行下一步。"];
  const steps: Record<Exclude<AgentWorkflowAction, "continue">, string[]> = {
    ask_user_confirmation: ["向用户展示待确认的问题与选项，记录选择后重新运行检查。"],
    collect_review_evidence: ["补齐所需审查或验证复核记录，然后重新运行检查。"],
    collect_test_evidence: ["补齐失败/通过测试或校验证据，然后重新运行检查。"],
    fix_artifacts: ["修正相关方案、任务或证据结构，然后重新运行检查。"],
    repair_evidence: ["修复证据记录中的结构或引用问题，然后重新运行检查。"],
    rerun_check: ["等待输入稳定后重新运行当前检查。"],
    inspect_diagnostics: ["使用诊断输出查看内部细节，再按对应问题处理。"],
  };
  return steps[action];
}

const DIAGNOSTIC_HINT = "需要排查内部细节时使用 --format json。";

export function renderAgentDecision(decision: JsonMap, opts: { command?: string } = {}): JsonMap {
  const decorated = sanitizeDecisionForOutput(decorateDecision(decision, opts));
  const reasons = Array.isArray(decorated.block_reasons) ? decorated.block_reasons : [];
  const reasonCodes = reasons.map((item: JsonMap) => String(item.code ?? ""));
  const allowed = Boolean(decorated.allowed);
  const workflowAction = workflowActionForReasonCodes(reasonCodes, allowed);
  const renderedReasons = reasons.map((item: JsonMap) => safeReasonText(item, workflowAction)).filter(Boolean);
  return {
    allowed,
    status: allowed ? "allowed" : "blocked",
    workflow_action: workflowAction,
    stage_label_zh: safeDisplayText(decorated.gate_label_zh) || "当前阶段",
    check_label_zh: safeDisplayText(decorated.command_label_zh) || "当前检查",
    summary_zh: safeDisplayText(summaryForWorkflowAction(workflowAction, allowed)),
    reasons_zh: renderedReasons.length > 0 ? renderedReasons : undefined,
    next_steps_zh: nextStepsForWorkflowAction(workflowAction, allowed).map(safeDisplayText),
    diagnostic_hint: DIAGNOSTIC_HINT,
  };
}

export function renderUserFacingDecision(decision: JsonMap, opts: { command?: string } = {}): string {
  const decorated = sanitizeDecisionForOutput(decorateDecision(decision, opts));
  const agentView = renderAgentDecision(decorated, opts);
  const gate = safeDisplayText(decorated.gate_label_zh) || "当前检查";
  const command = safeDisplayText(decorated.command_label_zh);
  const lines: string[] = [];

  if (decorated.allowed) {
    lines.push(`检查通过：${gate}。`);
  } else {
    lines.push(`暂时不能继续：${gate}。`);
  }

  if (command && command !== gate) {
    lines.push(`检查项：${command}。`);
  }

  const reasons = Array.isArray(decorated.block_reasons) ? decorated.block_reasons : [];
  if (!decorated.allowed && reasons.length > 0) {
    lines.push("原因：");
    for (const item of reasons) {
      const reasonText = safeReasonText(item as JsonMap, agentView.workflow_action as AgentWorkflowAction);
      lines.push(`- ${reasonText}`);
    }
  }

  const nextActions = Array.isArray(agentView.next_steps_zh) ? agentView.next_steps_zh.map(safeDisplayText).filter(Boolean) : [];
  if (nextActions.length > 0) {
    lines.push("下一步：");
    for (const action of nextActions) lines.push(`- ${action}`);
  }
  lines.push(`诊断：${DIAGNOSTIC_HINT}`);

  return `${lines.join("\n")}\n`;
}

export function printDecision(decision: JsonMap, opts: { command?: string; format?: DecisionOutputFormat } = {}): void {
  const decorated = decorateDecision(decision, opts);
  if (opts.format === "user") {
    process.stdout.write(renderUserFacingDecision(decorated, opts));
    return;
  }
  if (opts.format === "agent") {
    process.stdout.write(`${JSON.stringify(renderAgentDecision(decorated, opts), null, 2)}\n`);
    return;
  }
  process.stdout.write(`${JSON.stringify(sanitizeDecisionForOutput(decorated), null, 2)}\n`);
}

export function printPacket(payload: JsonMap | string, opts: { format: PacketOutputFormat }): void {
  if (opts.format === "prompt") {
    process.stdout.write(String(payload));
    if (!String(payload).endsWith("\n")) process.stdout.write("\n");
    return;
  }
  process.stdout.write(`${JSON.stringify(payload, null, 2)}\n`);
}

export function printPacketError(code: string, message: string): void {
  process.stdout.write(`${JSON.stringify({ status: "error", error_code: code, message }, null, 2)}\n`);
}

export function runCommand(
  cmd: string,
  args: string[],
  opts: { cwd?: string; timeout?: number; platform?: NodeJS.Platform } = {},
): { status: number | null; stdout: string; stderr: string; error?: Error } {
  const platform = opts.platform ?? process.platform;
  const invocation = platform === "win32" ? windowsCommandInvocation(cmd, args, opts.cwd) : { cmd, args };
  const result = spawnSync(invocation.cmd, invocation.args, {
    cwd: opts.cwd,
    encoding: "utf8",
    timeout: opts.timeout,
  });
  return {
    status: result.status,
    stdout: typeof result.stdout === "string" ? result.stdout : "",
    stderr: typeof result.stderr === "string" ? result.stderr : "",
    error: result.error,
  };
}

export function sha256_text(text: string): string {
  return `sha256:${createHash("sha256").update(Buffer.from(text, "utf8")).digest("hex")}`;
}

export function sha256_file(filePath: string): string | null {
  if (!existsSync(filePath) || !statSync(filePath).isFile()) return null;
  return `sha256:${createHash("sha256").update(readFileSync(filePath)).digest("hex")}`;
}

export function fingerprint_obj(obj: any): string {
  return sha256_text(stableJson(obj));
}

export function safe_within(base: string, candidate: string): string | null {
  if (isAbsolute(candidate) || candidate.split(/[\\/]+/).includes("..")) return null;
  const baseReal = realpathMaybe(base);
  const resolved = resolve(base, candidate);
  const candidateReal = resolveExistingPrefix(resolved);
  const rel = relative(baseReal, candidateReal);
  if (rel === "" || (!rel.startsWith("..") && !isAbsolute(rel))) return candidateReal;
  return null;
}

export function now(): string {
  return new Date().toISOString().replace(/\.\d{3}Z$/, "Z");
}

export function isObject(value: any): value is JsonMap {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function repr(value: any): string {
  if (typeof value === "string") return `'${value}'`;
  if (value === null) return "None";
  if (value === undefined) return "None";
  return JSON.stringify(value);
}

export function renderList(items: any[]): string {
  return `[${items.map((item) => (typeof item === "string" ? `'${item}'` : String(item))).join(", ")}]`;
}

function stableJson(value: any): string {
  if (value === null) return "null";
  if (typeof value === "boolean") return value ? "true" : "false";
  if (typeof value === "number") return JSON.stringify(value);
  if (typeof value === "string") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map((item) => stableJson(item)).join(", ")}]`;
  if (isObject(value)) {
    const parts = Object.keys(value).sort().map((key) => `${JSON.stringify(key)}: ${stableJson(value[key])}`);
    return `{${parts.join(", ")}}`;
  }
  return JSON.stringify(value);
}

function realpathMaybe(filePath: string): string {
  try {
    return realpathSync(filePath);
  } catch {
    return resolve(filePath);
  }
}

function resolveExistingPrefix(filePath: string): string {
  const abs = resolve(filePath);
  if (existsSync(abs)) return realpathMaybe(abs);
  const tail: string[] = [];
  let cur = abs;
  while (!existsSync(cur)) {
    const parent = dirname(cur);
    if (parent === cur) return abs;
    tail.unshift(cur.split(sep).at(-1) ?? "");
    cur = parent;
  }
  return resolve(realpathMaybe(cur), ...tail);
}

export function walkFiles(root: string): string[] {
  const out: string[] = [];
  if (!existsSync(root)) return out;
  for (const name of readdirSync(root)) {
    const item = join(root, name);
    const stat = lstatSync(item);
    if (stat.isSymbolicLink()) continue;
    if (stat.isDirectory()) out.push(...walkFiles(item));
    // Hardlinked files can alias content outside the change root; skip them like symlinks.
    else if (stat.isFile() && stat.nlink <= 1) out.push(item);
  }
  return out;
}

export function toPosix(pathValue: string): string {
  return pathValue.split(sep).join("/");
}

export function commandLookupInvocation(cmd: string, platform: NodeJS.Platform = process.platform): { cmd: string; args: string[]; shell: boolean } {
  if (platform === "win32") return { cmd: "where.exe", args: [cmd], shell: false };
  return { cmd: "sh", args: ["-c", `command -v ${cmd}`], shell: false };
}

export function selectWindowsCommandCandidate(cmd: string, whereStdout: string): string {
  const candidates = whereStdout.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  return candidates.find((candidate) => /\.(?:cmd|bat)$/i.test(candidate)) ?? candidates[0] ?? cmd;
}

function resolveWindowsCommand(cmd: string, cwd?: string): string {
  if (cmd.includes("\\") || cmd.includes("/") || extname(cmd)) return cmd;
  const lookup = spawnSync("where.exe", [cmd], {
    cwd,
    encoding: "utf8",
    timeout: 5_000,
  });
  if (lookup.status !== 0 || typeof lookup.stdout !== "string") return cmd;
  return selectWindowsCommandCandidate(cmd, lookup.stdout);
}

export function windowsShellEscapeArg(arg: string): string {
  let escaped = String(arg);
  escaped = escaped.replace(/(\\*)"/g, "$1$1\\\"");
  escaped = escaped.replace(/(\\*)$/g, "$1$1");
  escaped = `"${escaped}"`;
  return escaped.replace(/([()[\]{}^=;!'+,`~&|<>%" *?])/g, "^$1");
}

export function windowsCmdShimInvocation(cmdPath: string, args: string[], comspec = "cmd.exe"): { cmd: string; args: string[] } {
  return {
    cmd: comspec,
    args: ["/d", "/c", cmdPath, ...args],
  };
}

function windowsCommandInvocation(cmd: string, args: string[], cwd?: string): { cmd: string; args: string[] } {
  const resolved = resolveWindowsCommand(cmd, cwd);
  if (/\.(?:cmd|bat)$/i.test(resolved)) return windowsCmdShimInvocation(resolved, args);
  return { cmd: resolved, args };
}

export function commandExists(cmd: string, opts: { cwd?: string; platform?: NodeJS.Platform } = {}): boolean {
  const lookup = commandLookupInvocation(cmd, opts.platform);
  const proc = spawnSync(lookup.cmd, lookup.args, {
    cwd: opts.cwd,
    encoding: "utf8",
    timeout: 5_000,
    shell: lookup.shell,
  });
  return !proc.error && proc.status === 0;
}

export function deepEqual(a: any, b: any): boolean {
  return stableJson(a) === stableJson(b);
}
