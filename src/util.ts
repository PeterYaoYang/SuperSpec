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
export const REQUIRED_OPENSPEC_CODEX_SKILLS = [
  "openspec-explore",
  "openspec-propose",
  "openspec-apply-change",
  "openspec-archive-change",
] as const;
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
  "test-engineer",
  "code-reviewer",
  "verifier",
] as const;
export const REQUIRED_OPENSPEC_CLI_SURFACES = [
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
  "propose.apply_ready": "propose_complete",
  apply_ready: "propose_complete",
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
  review_complete: "review",
  verify_complete: "review",
  archive_ready: "archive",
};

export class GuardError extends Error {}

export const runtime: JsonMap = {};

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
    trust_warnings_zh: Array.isArray(decision.trust_warnings) ? decision.trust_warnings.map((item: unknown) => trust_warning_zh(String(item))) : [],
    workflow_terms_zh: workflow_terms_zh_for(command || undefined, String(decision.gate ?? ""), reasons.map((item: JsonMap) => String(item.code ?? ""))),
  };
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

export function printDecision(decision: JsonMap, opts: { command?: string } = {}): void {
  const decorated = decorateDecision(decision, opts);
  process.stdout.write(`${JSON.stringify(sanitizeDecisionForOutput(decorated), null, 2)}\n`);
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

function resolveWindowsCommand(cmd: string, cwd?: string): string {
  if (cmd.includes("\\") || cmd.includes("/") || extname(cmd)) return cmd;
  const lookup = spawnSync("where.exe", [cmd], {
    cwd,
    encoding: "utf8",
    timeout: 5_000,
  });
  if (lookup.status !== 0 || typeof lookup.stdout !== "string") return cmd;
  return lookup.stdout.split(/\r?\n/).map((line) => line.trim()).find(Boolean) ?? cmd;
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
    args: ["/d", "/s", "/c", [windowsShellEscapeArg(cmdPath), ...args.map(windowsShellEscapeArg)].join(" ")],
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
