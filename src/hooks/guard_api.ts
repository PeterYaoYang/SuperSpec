import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readdirSync,
  realpathSync,
  readFileSync,
  rmdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import type { JsonMap, Reason } from "../util.ts";
import {
  GUARD_VERSION,
  GuardError,
  isObject,
  reason,
  runtime,
  sha256_text,
  toPosix,
  trustWarnings,
} from "../util.ts";
import { artifact_status_map, repo_root_from_cwd } from "../openspec.ts";
import { index_evidence } from "../evidence.ts";
import { superspec_dir } from "../paths.ts";
import { parse_tasks, splitList } from "../tasks.ts";
import {
  check_archive_ready,
  check_review_complete,
  check_task_complete,
  check_task_edit,
  check_task_reopen,
} from "../gates.ts";
import { check_archived, find_archived_change } from "../archive.ts";
import { state_corrupt_reasons, with_state_lock } from "../state.ts";
import type { HookDecision, HookEvent, HookRunlogRecord, HookSessionRecord, HookStrictProfile, HookTrust } from "./types.ts";
import { HOOK_ADAPTER_VERSION } from "./types.ts";
import { hookManifestHash, managedHooksManifestPresent } from "./health.ts";
import {
  anyPathInScope,
  cleanRelPath,
  eventContentHash,
  extractWriteIntent,
  isSuperSpecTrustRootPath,
  normalizeHookEvent,
  pinnedFileRef,
  readHookEventRef,
  renderReasons,
} from "./policy_event.ts";

const SESSION_TTL_MS = 60 * 60 * 1000;

type HookContext = {
  change: string;
  status: JsonMap;
  repoRoot: string;
  changeRoot: string;
  evidences: JsonMap[];
  stateCorruptReasons: Reason[];
};

type ActiveSessionResult = {
  record: HookSessionRecord | null;
  enforcement_active: boolean;
  audit_only_reasons: Reason[];
  block_reasons: Reason[];
  corrupt_paths: string[];
};

function loadHookContext(change: string): HookContext {
  const [status, repoRoot, changeRoot, evidences] = runtime.load_context(change) as [JsonMap, string, string, JsonMap[]];
  return { change, status, repoRoot, changeRoot, evidences, stateCorruptReasons: state_corrupt_reasons(changeRoot) };
}

function fallbackHookStatus(repoRoot: string, changeRoot: string): JsonMap {
  return {
    changeRoot,
    planningHome: { root: repoRoot },
    artifacts: [],
    applyRequires: [],
    schemaName: "spec-driven",
  };
}

function loadArchivedHookContext(change: string): HookContext {
  const repoRoot = repo_root_from_cwd();
  const archivedRoot = find_archived_change(repoRoot, change);
  const changeRoot = archivedRoot ?? join(repoRoot, "openspec", "changes", change);
  return {
    change,
    status: fallbackHookStatus(repoRoot, changeRoot),
    repoRoot,
    changeRoot,
    evidences: index_evidence(changeRoot),
    stateCorruptReasons: state_corrupt_reasons(changeRoot),
  };
}

function hookRuntimeDir(changeRoot: string): string {
  return join(superspec_dir(changeRoot), "hook-runtime");
}

function activeSessionsDir(changeRoot: string): string {
  return join(hookRuntimeDir(changeRoot), "active-sessions");
}

function hookAuditDir(changeRoot: string): string {
  return join(superspec_dir(changeRoot), "evidence", "hook-audit");
}

function rawDir(changeRoot: string): string {
  return join(superspec_dir(changeRoot), "raw");
}

function runlogPath(changeRoot: string): string {
  return join(superspec_dir(changeRoot), "subagent-runlog.jsonl");
}

function sessionFile(changeRoot: string, sessionId: string): string {
  const digest = sha256_text(sessionId).slice("sha256:".length, "sha256:".length + 32);
  return join(activeSessionsDir(changeRoot), `${digest}.json`);
}

function nowIso(): string {
  return new Date().toISOString();
}

function expiresIso(): string {
  return new Date(Date.now() + SESSION_TTL_MS).toISOString();
}

function readJsonFile(filePath: string): JsonMap | null {
  try {
    const parsed = JSON.parse(readFileSync(filePath, "utf8"));
    return isObject(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

function realpathMaybe(pathValue: string): string {
  try {
    return realpathSync(pathValue);
  } catch {
    return resolve(pathValue);
  }
}

function samePhysicalPath(left: string, right: string): boolean {
  return realpathMaybe(left) === realpathMaybe(right);
}

function validHookSessionRecord(record: JsonMap): record is HookSessionRecord {
  const trust = record.trust;
  const strictProfile = record.strict_profile;
  const expiresAt = typeof record.expires_at === "string" ? Date.parse(record.expires_at) : NaN;
  return record.schema_version === 2
    && record.kind === "hook_active_session"
    && (trust === "audit-only" || trust === "trusted")
    && (strictProfile === "available" || strictProfile === "unavailable")
    && typeof record.change_id === "string"
    && record.change_id.length > 0
    && typeof record.repo_root === "string"
    && record.repo_root.length > 0
    && typeof record.session_id === "string"
    && record.session_id.length > 0
    && typeof record.workflow === "string"
    && record.workflow.length > 0
    && typeof record.started_at === "string"
    && Number.isFinite(Date.parse(record.started_at))
    && typeof record.expires_at === "string"
    && Number.isFinite(expiresAt)
    && typeof record.guard_version === "string"
    && typeof record.adapter_version === "string"
    && (record.hook_manifest_hash === null || typeof record.hook_manifest_hash === "string")
    && validReasonArray(record.audit_only_reasons);
}

function validReasonArray(value: unknown): boolean {
  return Array.isArray(value) && value.every((item) => (
    isObject(item)
    && typeof item.code === "string"
    && item.code.length > 0
    && typeof item.message === "string"
    && item.message.length > 0
    && Array.isArray(item.refs)
    && item.refs.every((ref) => typeof ref === "string")
  ));
}

function corruptSessionReason(ctx: HookContext, filePath: string): Reason {
  return reason("hook_session_corrupt", `active hook session record is corrupt: ${toPosix(relative(ctx.changeRoot, filePath))}`);
}

function strictUnavailableReasons(ctx: HookContext, extra: Reason[] = []): Reason[] {
  const reasons: Reason[] = [];
  if (!managedHooksManifestPresent(ctx.repoRoot)) {
    reasons.push(reason("hook_manifest_missing_or_unmanaged", "managed .codex/hooks.json is missing or does not match the SuperSpec v2 adapter baseline"));
  }
  reasons.push(reason("r1_deny_spike_not_passed", "R-1 local spike did not prove project PreToolUse deny is active for this Codex invocation"));
  reasons.push(reason("hook_provenance_unavailable", "no hook-only provenance mechanism is available in this environment; event JSON/stdin/env are replayable"));
  reasons.push(...extra);
  return reasons;
}

function strictProfile(ctx: HookContext, extra: Reason[] = []): { strict_profile: HookStrictProfile; trust: HookTrust; audit_only_reasons: Reason[] } {
  const auditOnly = strictUnavailableReasons(ctx, extra);
  return {
    strict_profile: "unavailable",
    trust: "audit-only",
    audit_only_reasons: auditOnly,
  };
}

function hookDecision(
  ctx: HookContext,
  gate: string,
  allowed: boolean,
  opts: {
    event?: HookEvent;
    enforcement?: HookDecision["enforcement"];
    block_reasons?: Reason[];
    audit_only_reasons?: Reason[];
    target_paths?: string[];
    actions?: JsonMap[];
    next_allowed_actions?: string[];
  } = {},
): HookDecision {
  const strict = strictProfile(ctx, opts.audit_only_reasons ?? []);
  const normalized = opts.event ? normalizeHookEvent(opts.event) : null;
  return {
    allowed,
    decision: allowed ? "allow" : "block",
    change_id: ctx.change,
    gate,
    strict_profile: strict.strict_profile,
    enforcement: opts.enforcement ?? (allowed ? "pass-through" : "deny"),
    trust: strict.trust,
    block_reasons: opts.block_reasons ?? [],
    audit_only_reasons: strict.audit_only_reasons,
    target_paths: opts.target_paths,
    tool_name: normalized?.tool_name,
    hook_event_name: normalized?.hook_event_name,
    hook_event_id: normalized?.hook_event_id,
    actions: opts.actions,
    next_allowed_actions: opts.next_allowed_actions ?? [],
    trust_warnings: trustWarnings(),
  };
}

function stateCorruptDecision(ctx: HookContext, gate: string): HookDecision | null {
  if (ctx.stateCorruptReasons.length === 0) return null;
  return hookDecision(ctx, gate, false, {
    enforcement: "deny",
    block_reasons: ctx.stateCorruptReasons,
    audit_only_reasons: ctx.stateCorruptReasons,
    next_allowed_actions: ["inspect the corrupt .superspec/superspec-state.json, then rerun recompute --rebuild-corrupt"],
  });
}

function statusDecision(ctx: HookContext, gate: string, opts: { actions?: JsonMap[]; audit_only_reasons?: Reason[]; allowed?: boolean } = {}): HookDecision {
  const strict = strictProfile(ctx, opts.audit_only_reasons ?? []);
  const allowed = opts.allowed ?? true;
  return {
    allowed,
    decision: "status",
    change_id: ctx.change,
    gate,
    strict_profile: strict.strict_profile,
    enforcement: "audit-only",
    trust: strict.trust,
    block_reasons: [],
    audit_only_reasons: strict.audit_only_reasons,
    actions: opts.actions,
    next_allowed_actions: [],
    trust_warnings: trustWarnings(),
  };
}

function activeSession(ctx: HookContext, event: HookEvent | null): ActiveSessionResult {
  const sessionId = event && typeof event.session_id === "string" && event.session_id ? event.session_id : "unknown-session";
  const dir = activeSessionsDir(ctx.changeRoot);
  if (!existsSync(dir)) {
    const missing = reason("hook_session_missing", "no active SuperSpec hook session for this Codex session");
    if (!existsSync(hookRuntimeDir(ctx.changeRoot))) {
      return {
        record: null,
        enforcement_active: false,
        audit_only_reasons: [missing],
        block_reasons: [],
        corrupt_paths: [],
      };
    }
    return {
      record: null,
      enforcement_active: false,
      audit_only_reasons: [missing],
      block_reasons: [missing],
      corrupt_paths: [],
    };
  }
  const files = readdirSync(dir)
    .filter((name) => name.endsWith(".json"))
    .map((name) => join(dir, name));
  if (files.length === 0) {
    const missing = reason("hook_session_missing", "no active SuperSpec hook session for this Codex session");
    return {
      record: null,
      enforcement_active: false,
      audit_only_reasons: [missing],
      block_reasons: [missing],
      corrupt_paths: [],
    };
  }

  const auditOnlyReasons: Reason[] = [];
  const blockReasons: Reason[] = [];
  const corruptPaths: string[] = [];
  let matchingRecord: HookSessionRecord | null = null;
  let sawMatchingChange = false;

  for (const filePath of files) {
    const parsed = readJsonFile(filePath);
    if (!parsed || !validHookSessionRecord(parsed)) {
      blockReasons.push(corruptSessionReason(ctx, filePath));
      corruptPaths.push(filePath);
      continue;
    }
    const record = parsed;
    if (record.change_id !== ctx.change) {
      blockReasons.push(reason("hook_session_change_mismatch", "active hook session change_id does not match request"));
      continue;
    }
    if (!samePhysicalPath(record.repo_root, ctx.repoRoot)) {
      blockReasons.push(reason("hook_session_repo_mismatch", "active hook session repo_root does not match request"));
      continue;
    }
    sawMatchingChange = true;
    if (record.session_id !== sessionId) {
      auditOnlyReasons.push(reason("hook_session_session_mismatch", "active hook session_id does not match hook event; audit-only enforcement uses repo/change lease fallback"));
    }
    if (Date.parse(record.expires_at) <= Date.now()) {
      blockReasons.push(reason("hook_session_expired", "active hook session lease expired"));
      continue;
    }
    if (record.trust !== "trusted") {
      auditOnlyReasons.push(reason("hook_session_audit_only", "active hook session exists only as audit-only because lifecycle provenance is unavailable"));
    }
    matchingRecord ??= record;
  }

  if (!sawMatchingChange && blockReasons.length === 0) {
    const missing = reason("hook_session_missing", "no active SuperSpec hook session for this Codex session");
    auditOnlyReasons.push(missing);
    blockReasons.push(missing);
  }

  return {
    record: matchingRecord,
    enforcement_active: matchingRecord !== null || blockReasons.length > 0,
    audit_only_reasons: auditOnlyReasons,
    block_reasons: blockReasons,
    corrupt_paths: corruptPaths,
  };
}

function changeRelRoot(ctx: HookContext): string {
  return cleanRelPath(relative(ctx.repoRoot, ctx.changeRoot));
}

function isProtectedTrustRoot(ctx: HookContext, pathValue: string): boolean {
  return isSuperSpecTrustRootPath(pathValue, { changeRootRel: changeRelRoot(ctx) });
}

function isOpenSpecTasks(ctx: HookContext, pathValue: string): boolean {
  return cleanRelPath(pathValue) === `${changeRelRoot(ctx)}/tasks.md`;
}

function isOpenSpecCanonical(ctx: HookContext, pathValue: string): boolean {
  const rel = cleanRelPath(pathValue);
  const changeRoot = changeRelRoot(ctx);
  return rel === `${changeRoot}/proposal.md`
    || rel === `${changeRoot}/design.md`
    || rel === `${changeRoot}/tasks.md`
    || rel.startsWith(`${changeRoot}/specs/`);
}

function matchingTaskIds(ctx: HookContext, paths: string[]): string[] {
  const tasks = parse_tasks(ctx.changeRoot);
  const ids: string[] = [];
  for (const [taskId, task] of Object.entries(tasks)) {
    const scopes = splitList(task.attrs.write_scope ?? "");
    if (scopes.length > 0 && scopes.some((scope) => anyPathInScope(paths, scope))) ids.push(taskId);
  }
  return ids.sort();
}

function decisionReasons(decision: JsonMap): Reason[] {
  return Array.isArray(decision.block_reasons) ? decision.block_reasons : [];
}

function evaluateTaskEdit(ctx: HookContext, taskId: string): JsonMap {
  return check_task_edit(ctx.change, ctx.status, ctx.changeRoot, ctx.evidences, taskId);
}

function evaluateTaskComplete(ctx: HookContext, taskId: string): JsonMap {
  return check_task_complete(ctx.change, ctx.status, ctx.changeRoot, ctx.evidences, taskId);
}

function evaluateTaskReopen(ctx: HookContext, taskId: string): JsonMap {
  return check_task_reopen(ctx.change, ctx.status, ctx.changeRoot, ctx.evidences, taskId);
}

function evaluateArchiveReady(ctx: HookContext): JsonMap {
  return check_archive_ready(ctx.change, ctx.status, ctx.changeRoot, ctx.evidences);
}

function evaluateTerminalAuthority(ctx: HookContext, endReason: string): Reason[] {
  if (endReason === "completed") {
    const review = check_review_complete(ctx.change, ctx.status, ctx.changeRoot, ctx.evidences);
    return review.allowed ? [] : [
      reason("hook_session_terminal_not_ready", "hook-session-end reason completed requires review_complete to pass"),
      ...decisionReasons(review),
    ];
  }
  if (endReason === "archived") {
    const archived = check_archived(ctx.change, ctx.repoRoot);
    return archived.allowed ? [] : [
      reason("hook_session_terminal_not_ready", "hook-session-end reason archived requires check-archived to pass"),
      ...decisionReasons(archived as unknown as JsonMap),
    ];
  }
  if (endReason === "cancelled" || endReason === "abandoned") {
    return [
      reason("hook_session_terminal_authority_unavailable", `hook-session-end reason ${endReason} requires trusted terminal provenance before it can close an audit lease`),
    ];
  }
  return [reason("hook_session_terminal_authority_unavailable", `hook-session-end reason ${endReason} has no audit-only terminal authority in this environment`)];
}

function sessionSummary(record: HookSessionRecord | null): JsonMap | null {
  if (!record) return null;
  return {
    schema_version: record.schema_version,
    kind: record.kind,
    trust: record.trust,
    change_id: record.change_id,
    repo_root: record.repo_root,
    session_id: record.session_id,
    workflow: record.workflow,
    started_at: record.started_at,
    expires_at: record.expires_at,
    guard_version: record.guard_version,
    adapter_version: record.adapter_version,
    hook_manifest_hash: record.hook_manifest_hash,
    strict_profile: record.strict_profile,
    audit_only_reasons: record.audit_only_reasons,
  };
}

function removeEmptyDir(path: string): void {
  try {
    if (existsSync(path) && readdirSync(path).length === 0) rmdirSync(path);
  } catch {
    // Best effort cleanup only; a non-empty or concurrently removed directory is not an end failure.
  }
}

function eventRefToDecision(command: string, change: string, eventRef: string, fn: (ctx: HookContext, event: HookEvent) => HookDecision): HookDecision {
  const ctx = loadHookContext(change);
  const corrupt = stateCorruptDecision(ctx, command);
  if (corrupt) return corrupt;
  try {
    const event = readHookEventRef(eventRef);
    return fn(ctx, event);
  } catch (err) {
    const message = err instanceof GuardError ? err.message : `${(err as Error).name}: ${(err as Error).message}`;
    return hookDecision(ctx, command, false, {
      enforcement: "deny",
      block_reasons: [reason("hook_event_invalid", message)],
      next_allowed_actions: ["repair the hook event payload and rerun the hook check"],
    });
  }
}

export function hookCheckWrite(change: string, eventRef: string): HookDecision {
  return eventRefToDecision("hook_check_write", change, eventRef, (ctx, event) => {
    const intent = extractWriteIntent(event, ctx.repoRoot);
    const active = activeSession(ctx, event);
    const activeEnoughForAuditEnforcement = active.enforcement_active;
    const blockReasons: Reason[] = [];
    const auditOnlyReasons: Reason[] = [...active.audit_only_reasons, ...intent.reasons];
    const toolName = typeof event.tool_name === "string" ? event.tool_name : "";

    if (intent.internal_hook_writer_command) {
      blockReasons.push(reason("hook_internal_writer_invocation", "model-controlled tool calls may not invoke SuperSpec hook writer commands"));
    }
    if (intent.unsafe_lifecycle_termination_command) {
      blockReasons.push(reason("hook_session_termination_untrusted", "model-controlled tool calls may not terminate SuperSpec hook sessions without trusted terminal authority"));
    }
    const protectedPaths = intent.target_paths.filter((path) => isProtectedTrustRoot(ctx, path));
    if (protectedPaths.length > 0) {
      blockReasons.push(reason("protected_trust_root_write", `direct writes to SuperSpec trust roots are denied: ${renderReasons(protectedPaths.map((path) => reason(path, path)))}`, protectedPaths));
    }
    if (intent.shell_write_command && intent.trust_root_text_matches.length > 0) {
      blockReasons.push(reason("protected_trust_root_write", `pathless write-capable command appears to touch SuperSpec trust roots: ${intent.trust_root_text_matches.join(", ")}`, intent.trust_root_text_matches));
    }
    if (intent.archive_command) {
      const archive = evaluateArchiveReady(ctx);
      if (!archive.allowed) {
        blockReasons.push(reason("archive_ready_missing", "openspec archive requires a fresh archive_ready allow decision"));
        blockReasons.push(...decisionReasons(archive));
      }
    }

    const scopedTaskIds = matchingTaskIds(ctx, intent.target_paths);
    const sessionSensitiveWrite = scopedTaskIds.length > 0
      || protectedPaths.length > 0
      || intent.reasons.some((item) => item.code === "target_path_outside_repo")
      || intent.reasons.some((item) => item.code === "protected_trust_root_link_source")
      || intent.reasons.some((item) => item.code === "shell_path_may_touch_trust_root")
      || intent.reasons.some((item) => item.code === "curl_config_write_target_unknown")
      || intent.reasons.some((item) => item.code === "curl_write_target_unknown")
      || intent.archive_command
      || intent.internal_hook_writer_command
      || intent.unsafe_lifecycle_termination_command
      || (intent.shell_write_command && intent.trust_root_text_matches.length > 0)
      || intent.target_paths.some((path) => isOpenSpecTasks(ctx, path))
      || intent.target_paths.some((path) => isOpenSpecCanonical(ctx, path))
      || (intent.shell_write_command && intent.target_paths.length === 0);
    const writeCapableEvent = ["apply_patch", "Edit", "Write"].includes(toolName)
      || intent.target_paths.length > 0
      || intent.shell_write_command
      || intent.unsupported_write_surface
      || intent.reasons.length > 0
      || intent.archive_command
      || intent.internal_hook_writer_command
      || intent.unsafe_lifecycle_termination_command;
    const corruptActiveSessionForWrite = active.corrupt_paths.length > 0 && writeCapableEvent;
    if (corruptActiveSessionForWrite) {
      blockReasons.push(...active.block_reasons);
    }
    const missingOrInvalidActiveSessionForSensitiveWrite = active.block_reasons.length > 0 && sessionSensitiveWrite && !corruptActiveSessionForWrite;
    if (missingOrInvalidActiveSessionForSensitiveWrite) {
      blockReasons.push(...active.block_reasons);
    }

    const failClosedIntentReasons = intent.reasons.filter((item) => (
      item.code === "unknown_patch_shape"
      || item.code === "target_path_outside_repo"
      || item.code === "protected_trust_root_link_source"
      || item.code === "shell_path_may_touch_trust_root"
      || item.code === "curl_config_write_target_unknown"
      || item.code === "curl_write_target_unknown"
    ));
    if (failClosedIntentReasons.length > 0) {
      blockReasons.push(...failClosedIntentReasons);
    }

    if (!activeEnoughForAuditEnforcement && !missingOrInvalidActiveSessionForSensitiveWrite) {
      if (blockReasons.length > 0) {
        return hookDecision(ctx, "hook_check_write", false, {
          event,
          enforcement: "deny",
          block_reasons: blockReasons,
          audit_only_reasons: auditOnlyReasons,
          target_paths: intent.target_paths,
          next_allowed_actions: ["rerun the relevant superspec check and use the expected workflow command surface"],
        });
      }
      return hookDecision(ctx, "hook_check_write", true, {
        event,
        enforcement: "pass-through",
        audit_only_reasons: auditOnlyReasons,
        target_paths: intent.target_paths,
      });
    }

    if (activeEnoughForAuditEnforcement || missingOrInvalidActiveSessionForSensitiveWrite) {
      blockReasons.push(...intent.reasons);
    }
    for (const taskId of scopedTaskIds) {
      const taskDecision = evaluateTaskEdit(ctx, taskId);
      if (!taskDecision.allowed) {
        blockReasons.push(reason("task_edit_missing", `write_scope edit for ${taskId} requires task_edit allow`, [taskId]));
        blockReasons.push(...decisionReasons(taskDecision));
      }
    }

    if (intent.target_paths.some((path) => isOpenSpecTasks(ctx, path))) {
      for (const taskId of intent.task_checkbox_completions) {
        const taskDecision = evaluateTaskComplete(ctx, taskId);
        if (!taskDecision.allowed) {
          blockReasons.push(reason("task_complete_missing", `checking ${taskId} requires task_complete allow`, [taskId]));
          blockReasons.push(...decisionReasons(taskDecision));
        }
      }
      for (const taskId of intent.task_checkbox_reopens) {
        const taskDecision = evaluateTaskReopen(ctx, taskId);
        if (!taskDecision.allowed) {
          blockReasons.push(reason("task_reopen_missing", `reopening ${taskId} requires task_reopen allow`, [taskId]));
          blockReasons.push(...decisionReasons(taskDecision));
        }
      }
      if (intent.task_checkbox_completions.length === 0 && intent.task_checkbox_reopens.length === 0) {
        blockReasons.push(reason("openspec_tasks_direct_edit", "tasks.md edits outside guarded checkbox transitions are denied during an active SuperSpec session"));
      }
    }

    const canonical = intent.target_paths.filter((path) => isOpenSpecCanonical(ctx, path) && !isOpenSpecTasks(ctx, path));
    if (canonical.length > 0 && activeEnoughForAuditEnforcement) {
      blockReasons.push(reason("openspec_canonical_direct_edit", `OpenSpec canonical artifacts require the workflow instruction surface: ${canonical.join(", ")}`, canonical));
    }

    if (intent.shell_write_command && intent.target_paths.length === 0) {
      blockReasons.push(reason("bash_write_target_unknown", "Bash command appears write-capable but target paths could not be classified"));
    }

    if (blockReasons.length > 0) {
      return hookDecision(ctx, "hook_check_write", false, {
        event,
        enforcement: "deny",
        block_reasons: blockReasons,
        audit_only_reasons: auditOnlyReasons,
        target_paths: intent.target_paths,
        next_allowed_actions: ["rerun the relevant superspec check and use the expected workflow command surface"],
      });
    }

    return hookDecision(ctx, "hook_check_write", true, {
      event,
      enforcement: activeEnoughForAuditEnforcement ? "guarded" : "pass-through",
      audit_only_reasons: auditOnlyReasons,
      target_paths: intent.target_paths,
    });
  });
}

export function hookCheckCommand(change: string, eventRef: string): HookDecision {
  return hookCheckWrite(change, eventRef);
}

export function hookHealth(change: string): HookDecision {
  const ctx = loadHookContext(change);
  const corrupt = stateCorruptDecision(ctx, "hook_health");
  if (corrupt) return corrupt;
  const strict = strictProfile(ctx);
  return statusDecision(ctx, "hook_health", {
    allowed: false,
    actions: [{
      strict_profile: strict.strict_profile,
      trust: strict.trust,
      mechanical: false,
      runtime_verified: false,
      hook_manifest_hash: hookManifestHash(ctx.repoRoot),
      managed_hooks_manifest_present: managedHooksManifestPresent(ctx.repoRoot),
      openspec_status_summary: artifact_status_map(ctx.status),
      audit_only_reasons: strict.audit_only_reasons,
    }],
  });
}

export function hookSessionBegin(change: string, workflow: string, _entrypointToken: string): HookDecision {
  const ctx = loadHookContext(change);
  const corrupt = stateCorruptDecision(ctx, "hook_session_begin");
  if (corrupt) return corrupt;
  const sessionId = process.env.CODEX_SESSION_ID || process.env.SUPERSPEC_HOOK_SESSION_ID || "manual-cli-session";
  const auditOnlyReasons = [
    reason("workflow_entrypoint_provenance_unavailable", "hook-session-begin was invoked through ordinary CLI authority; recording audit-only lease only"),
  ];
  const strict = strictProfile(ctx, auditOnlyReasons);
  const record: HookSessionRecord = {
    schema_version: 2,
    kind: "hook_active_session",
    trust: strict.trust,
    change_id: change,
    repo_root: ctx.repoRoot,
    session_id: sessionId,
    workflow,
    started_at: nowIso(),
    expires_at: expiresIso(),
    guard_version: GUARD_VERSION,
    adapter_version: HOOK_ADAPTER_VERSION,
    hook_manifest_hash: hookManifestHash(ctx.repoRoot),
    strict_profile: strict.strict_profile,
    audit_only_reasons: strict.audit_only_reasons,
  };
  with_state_lock(ctx.changeRoot, () => {
    const target = sessionFile(ctx.changeRoot, sessionId);
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, `${JSON.stringify(record, null, 2)}\n`, "utf8");
  });
  return statusDecision(ctx, "hook_session_begin", {
    audit_only_reasons: auditOnlyReasons,
    actions: [{ session: sessionSummary(record), audit_only_session_created: true, trusted_active_session_created: false }],
  });
}

export function hookSessionStatus(change: string): HookDecision {
  const ctx = loadHookContext(change);
  const corrupt = stateCorruptDecision(ctx, "hook_session_status");
  if (corrupt) return corrupt;
  const sessionId = process.env.CODEX_SESSION_ID || process.env.SUPERSPEC_HOOK_SESSION_ID || "manual-cli-session";
  const active = activeSession(ctx, { session_id: sessionId });
  return statusDecision(ctx, "hook_session_status", {
    audit_only_reasons: [...active.audit_only_reasons, ...active.block_reasons],
    actions: [{
      active: active.enforcement_active,
      session_id: sessionId,
      session: sessionSummary(active.record),
      diagnostics: [...active.audit_only_reasons, ...active.block_reasons],
      corrupt_paths: active.corrupt_paths.map((path) => toPosix(relative(ctx.changeRoot, path))),
    }],
  });
}

export function hookSessionEnd(change: string, endReason: string, _lifecycleToken: string): HookDecision {
  const ctx = endReason === "archived" ? loadArchivedHookContext(change) : loadHookContext(change);
  const corrupt = stateCorruptDecision(ctx, "hook_session_end");
  if (corrupt) return corrupt;
  const sessionId = process.env.CODEX_SESSION_ID || process.env.SUPERSPEC_HOOK_SESSION_ID || "manual-cli-session";
  const allowedReasons = new Set(["completed", "cancelled", "archived", "abandoned"]);
  const auditOnlyReasons = [
    reason("workflow_terminal_authority_unavailable", "hook-session-end was invoked through ordinary CLI authority; trusted sessions cannot be closed this way"),
  ];
  const active = activeSession(ctx, { session_id: sessionId });
  let auditOnlySessionClosed = false;
  with_state_lock(ctx.changeRoot, () => {
    const target = sessionFile(ctx.changeRoot, sessionId);
    if (!existsSync(target)) return;
    const parsed = readJsonFile(target);
    if (!parsed || !validHookSessionRecord(parsed)) {
      auditOnlyReasons.push(reason("hook_session_corrupt", "active hook session record is corrupt and was not closed"));
      return;
    }
    const record = parsed;
    if (record.change_id !== change || !samePhysicalPath(record.repo_root, ctx.repoRoot) || record.session_id !== sessionId) {
      auditOnlyReasons.push(reason("hook_session_identity_mismatch", "active hook session identity does not match the terminal request"));
      return;
    }
    if (Date.parse(record.expires_at) <= Date.now()) {
      auditOnlyReasons.push(reason("hook_session_expired", "active hook session lease expired and was not closed"));
      return;
    }
    if (!allowedReasons.has(endReason)) {
      auditOnlyReasons.push(reason("hook_session_end_reason_invalid", `unsupported hook session end reason: ${endReason}`));
      return;
    }
    if (record.trust === "trusted") {
      auditOnlyReasons.push(reason("hook_session_trusted_close_unavailable", "ordinary CLI hook-session-end authority cannot close a trusted active session"));
      return;
    }
    const terminalReasons = evaluateTerminalAuthority(ctx, endReason);
    if (terminalReasons.length > 0) {
      auditOnlyReasons.push(...terminalReasons);
      return;
    }
    rmSync(target, { force: true });
    removeEmptyDir(activeSessionsDir(ctx.changeRoot));
    removeEmptyDir(hookRuntimeDir(ctx.changeRoot));
    auditOnlySessionClosed = true;
  });
  return statusDecision(ctx, "hook_session_end", {
    audit_only_reasons: auditOnlyReasons,
    actions: [{
      trusted_active_session_closed: false,
      audit_only_session_closed: auditOnlySessionClosed,
      active_session_present: active.enforcement_active,
      reason: endReason,
    }],
  });
}

function provenanceFor(ctx: HookContext, event: HookEvent): JsonMap {
  const normalized = normalizeHookEvent(event);
  return {
    hook_event_name: normalized.hook_event_name,
    session_id: normalized.session_id,
    turn_id: typeof event.turn_id === "string" ? event.turn_id : null,
    tool_use_id: typeof event.tool_use_id === "string" ? event.tool_use_id : null,
    agent_id: typeof event.agent_id === "string" ? event.agent_id : null,
    adapter_version: HOOK_ADAPTER_VERSION,
    hook_manifest_hash: hookManifestHash(ctx.repoRoot),
    provenance_mechanism_id: "unavailable:r1-spike-failed",
    validation: "audit-only",
    event_content_hash: eventContentHash(event),
  };
}

function materializeRawLog(ctx: HookContext, event: HookEvent, prefix: string): { rel: string; ref: JsonMap | null } {
  const normalized = normalizeHookEvent(event);
  const id = normalized.hook_event_id.slice("sha256:".length, "sha256:".length + 16);
  const rel = `.superspec/raw/${prefix}-${id}.log`;
  const target = join(ctx.changeRoot, rel);
  mkdirSync(dirname(target), { recursive: true });
  writeFileSync(target, `${JSON.stringify(event, null, 2)}\n`, "utf8");
  return { rel, ref: pinnedFileRef(ctx.changeRoot, rel) };
}

function writeAuditEvidence(ctx: HookContext, evidence: JsonMap): string {
  const target = join(hookAuditDir(ctx.changeRoot), `${String(evidence.evidence_id)}.json`);
  mkdirSync(dirname(target), { recursive: true });
  writeFileSync(target, `${JSON.stringify(evidence, null, 2)}\n`, "utf8");
  return toPosix(relative(ctx.changeRoot, target));
}

export function hookRecordTest(change: string, eventRef: string): HookDecision {
  return eventRefToDecision("hook_record_test", change, eventRef, (ctx, event) => {
    const normalized = normalizeHookEvent(event);
    const toolInput = isObject(event.tool_input) ? event.tool_input : {};
    const command = typeof toolInput.command === "string" ? toolInput.command : "";
    const toolResponse = isObject(event.tool_response) ? event.tool_response : {};
    const exitCode = typeof toolResponse.exit_code === "number"
      ? toolResponse.exit_code
      : (typeof toolResponse.exitCode === "number" ? toolResponse.exitCode : null);
    const evidenceId = `EV-hook-test-${normalized.hook_event_id.slice("sha256:".length, "sha256:".length + 16)}`;
    let rel = "";
    with_state_lock(ctx.changeRoot, () => {
      const raw = materializeRawLog(ctx, event, "hook-test");
      const evidence: JsonMap = {
        schema_version: 1,
        evidence_id: evidenceId,
        change_id: change,
        gate: "hook_record_test",
        kind: "test_run",
        created_at: nowIso(),
        created_by: "superspec-hook",
        status: "blocked",
        trust: "audit-only",
        semantic_status: exitCode === 0 ? "expected_success" : "expected_failure",
        test_command: command,
        result_summary: "audit-only hook telemetry; strict runtime evidence disabled because hook provenance is unavailable",
        raw_log_refs: [raw.rel],
        raw_log_pinned_refs: raw.ref ? [raw.ref] : [],
        hook_event_id: normalized.hook_event_id,
        exit_code: exitCode,
        command_fingerprint: sha256_text(command),
        hook_provenance: provenanceFor(ctx, event),
      };
      rel = writeAuditEvidence(ctx, evidence);
    });
    return statusDecision(ctx, "hook_record_test", {
      actions: [{ trusted_runtime_evidence_written: false, audit_only_evidence_ref: rel, evidence_id: evidenceId }],
    });
  });
}

function writeRunlogRecord(ctx: HookContext, record: HookRunlogRecord): void {
  const target = runlogPath(ctx.changeRoot);
  with_state_lock(ctx.changeRoot, () => {
    mkdirSync(dirname(target), { recursive: true });
    appendFileSync(target, `${JSON.stringify(record)}\n`, "utf8");
  });
}

export function hookRecordSubagentStart(change: string, eventRef: string): HookDecision {
  return eventRefToDecision("hook_record_subagent_start", change, eventRef, (ctx, event) => {
    const normalized = normalizeHookEvent(event);
    const record: HookRunlogRecord = {
      schema_version: 2,
      kind: "subagent_start",
      trust: "audit-only",
      hook_event_id: normalized.hook_event_id,
      hook_event_name: normalized.hook_event_name,
      hook_provenance: provenanceFor(ctx, event),
      session_id: normalized.session_id,
      turn_id: typeof event.turn_id === "string" ? event.turn_id : undefined,
      run_id: typeof event.run_id === "string" ? event.run_id : String(event.agent_id ?? normalized.hook_event_id),
      agent_id: String(event.agent_id ?? ""),
      agent_type: String(event.agent_type ?? ""),
      cwd: typeof event.cwd === "string" ? event.cwd : undefined,
      prompt_hash: typeof event.prompt === "string" ? sha256_text(event.prompt) : undefined,
      prompt_ref: typeof event.prompt_ref === "string" ? event.prompt_ref : undefined,
      started_at: nowIso(),
    };
    writeRunlogRecord(ctx, record);
    return statusDecision(ctx, "hook_record_subagent_start", {
      actions: [{ trusted_runlog_record_written: false, audit_only_runlog: toPosix(relative(ctx.changeRoot, runlogPath(ctx.changeRoot))) }],
    });
  });
}

export function hookRecordSubagentStop(change: string, eventRef: string): HookDecision {
  return eventRefToDecision("hook_record_subagent_stop", change, eventRef, (ctx, event) => {
    const normalized = normalizeHookEvent(event);
    const output = typeof event.last_assistant_message === "string" ? event.last_assistant_message : "";
    const record: HookRunlogRecord = {
      schema_version: 2,
      kind: "subagent_stop",
      trust: "audit-only",
      hook_event_id: normalized.hook_event_id,
      hook_event_name: normalized.hook_event_name,
      hook_provenance: provenanceFor(ctx, event),
      session_id: normalized.session_id,
      turn_id: typeof event.turn_id === "string" ? event.turn_id : undefined,
      run_id: typeof event.run_id === "string" ? event.run_id : String(event.agent_id ?? normalized.hook_event_id),
      agent_id: String(event.agent_id ?? ""),
      agent_type: String(event.agent_type ?? ""),
      cwd: typeof event.cwd === "string" ? event.cwd : undefined,
      output_hash: output ? sha256_text(output) : undefined,
      status: typeof event.status === "string" ? event.status : "stopped",
      error: typeof event.error === "string" ? event.error : undefined,
      stopped_at: nowIso(),
    };
    writeRunlogRecord(ctx, record);
    return statusDecision(ctx, "hook_record_subagent_stop", {
      actions: [{ trusted_runlog_record_written: false, audit_only_runlog: toPosix(relative(ctx.changeRoot, runlogPath(ctx.changeRoot))) }],
    });
  });
}

export function hookInitReasons(repoRoot: string): Reason[] {
  const hookPath = join(repoRoot, ".codex", "hooks.json");
  if (!existsSync(hookPath)) return [];
  if (managedHooksManifestPresent(repoRoot)) return [];
  return [reason("hook_manifest_unmanaged", ".codex/hooks.json exists but is not the SuperSpec-managed v2 hook manifest; strict profile must downgrade")];
}
