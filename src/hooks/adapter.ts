import { randomUUID } from "node:crypto";
import { readFileSync, readdirSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { tmpdir } from "node:os";
import type { JsonMap } from "../util.ts";
import { isObject } from "../util.ts";
import {
  hookCheckCommand,
  hookCheckWrite,
  hookRecordSubagentStart,
  hookRecordSubagentStop,
  hookRecordTest,
} from "./guard_api.ts";
import { commandLooksLikeTestValidation, extractWriteIntent, isSuperSpecTrustRootPath } from "./policy_event.ts";
import type { HookDecision, HookEvent } from "./types.ts";

type ActiveSessionInference =
  | { state: "unique"; change: string }
  | { state: "ambiguous"; changes: string[] }
  | { state: "none" };

function parseArgs(argv: string[]): { change: string | null } {
  let change = process.env.SUPERSPEC_CHANGE || null;
  for (let idx = 0; idx < argv.length; idx += 1) {
    if (argv[idx] === "--change") change = argv[idx + 1] || null;
  }
  return { change };
}

function isDir(path: string): boolean {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
}

function readJson(path: string): JsonMap | null {
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8"));
    return isObject(parsed) ? parsed : null;
  } catch {
    return null;
  }
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

function validActiveSessionRecord(path: string, change: string, repoRoot: string, event: HookEvent): boolean {
  const record = readJson(path);
  if (!record) return false;
  if (record.schema_version !== 2 || record.kind !== "hook_active_session") return false;
  if (record.trust !== "audit-only" && record.trust !== "trusted") return false;
  if (record.strict_profile !== "available" && record.strict_profile !== "unavailable") return false;
  if (record.change_id !== change) return false;
  if (resolve(String(record.repo_root ?? "")) !== resolve(repoRoot)) return false;
  if (typeof record.session_id !== "string" || !record.session_id) return false;
  if (!validReasonArray(record.audit_only_reasons)) return false;
  const eventSessionId = typeof event.session_id === "string" && event.session_id ? event.session_id : "";
  const auditRepoChangeLeaseFallback = record.trust === "audit-only"
    && record.strict_profile === "unavailable"
    && record.session_id === "manual-cli-session";
  if (eventSessionId && record.session_id !== eventSessionId && !auditRepoChangeLeaseFallback) return false;
  const expiresAt = Date.parse(String(record.expires_at ?? ""));
  if (!Number.isFinite(expiresAt) || expiresAt <= Date.now()) return false;
  return true;
}

function inferChangeFromActiveSessions(event: HookEvent): ActiveSessionInference {
  const repoRoot = findRepoRootFromCwd(event);
  const changesDir = join(repoRoot, "openspec", "changes");
  if (!isDir(changesDir)) return { state: "none" };
  const candidates = readdirSync(changesDir).filter((change) => {
    const runtimeDir = join(changesDir, change, ".superspec", "hook-runtime");
    const activeDir = join(changesDir, change, ".superspec", "hook-runtime", "active-sessions");
    if (isDir(activeDir) && readdirSync(activeDir).some((name) => (
      name.endsWith(".json") && validActiveSessionRecord(join(activeDir, name), change, repoRoot, event)
    ))) return true;
    return isDir(runtimeDir);
  });
  const unique = [...new Set(candidates)];
  if (unique.length === 1) return { state: "unique", change: unique[0] };
  if (unique.length > 1) return { state: "ambiguous", changes: unique.sort() };
  return { state: "none" };
}

function cwdRoot(event: HookEvent): string {
  return typeof event.cwd === "string" && event.cwd ? resolve(event.cwd) : process.cwd();
}

function findRepoRootFromCwd(event: HookEvent): string {
  let dir = cwdRoot(event);
  while (true) {
    if ((isDir(join(dir, "openspec")) || isDir(join(dir, ".codex"))) && statMaybe(join(dir, "package.json")) === "file") return dir;
    if (isDir(join(dir, "openspec", "changes")) || isDir(join(dir, ".codex"))) return dir;
    if (statMaybe(join(dir, ".git"))) return dir;
    const parent = dirname(dir);
    if (parent === dir) return cwdRoot(event);
    dir = parent;
  }
}

function passThrough(message: string): JsonMap {
  return {
    hookSpecificOutput: {
      hookEventName: "PreToolUse",
      additionalContext: message,
    },
  };
}

function statMaybe(path: string): "file" | "dir" | null {
  try {
    const st = statSync(path);
    if (st.isFile()) return "file";
    if (st.isDirectory()) return "dir";
    return null;
  } catch {
    return null;
  }
}

function denyPreToolUse(reason: string): JsonMap {
  return {
    hookSpecificOutput: {
      hookEventName: "PreToolUse",
      permissionDecision: "deny",
      permissionDecisionReason: reason,
    },
  };
}

function isTestValidationCommand(event: HookEvent): boolean {
  if (String(event.tool_name ?? "") !== "Bash") return false;
  const toolInput = isObject(event.tool_input) ? event.tool_input : {};
  const command = typeof toolInput.command === "string" ? toolInput.command : "";
  return commandLooksLikeTestValidation(command);
}

function inertPostToolUseOutput(): JsonMap {
  return {
    systemMessage: "SuperSpec hook ignored non-test command; no test telemetry was recorded.",
    hookSpecificOutput: {
      hookEventName: "PostToolUse",
      additionalContext: "SuperSpec runtime telemetry is inert for non-test commands.",
    },
  };
}

function noChangeFallback(event: HookEvent, inference: ActiveSessionInference): JsonMap {
  if (String(event.hook_event_name ?? "PreToolUse") !== "PreToolUse") {
    return { systemMessage: "SuperSpec hook inert: SUPERSPEC_CHANGE/--change not set" };
  }
  const intent = extractWriteIntent(event, findRepoRootFromCwd(event));
  const writeCapable = intent.target_paths.length > 0
    || intent.archive_command
    || intent.internal_hook_writer_command
    || intent.unsupported_write_surface
    || intent.shell_write_command
    || intent.reasons.length > 0
    || ["apply_patch", "Edit", "Write"].includes(String(event.tool_name ?? ""));
  if (inference.state === "ambiguous" && writeCapable) {
    return denyPreToolUse(`blocked by SuperSpec hook policy: multiple active SuperSpec sessions (${inference.changes.join(", ")}); set SUPERSPEC_CHANGE or close stale leases`);
  }
  if (intent.internal_hook_writer_command) {
    return denyPreToolUse("blocked by SuperSpec hook policy: internal hook writer invocation requires Guard-owned hook authority");
  }
  if (intent.unsafe_lifecycle_termination_command) {
    return denyPreToolUse("blocked by SuperSpec hook policy: hook session cancellation requires trusted terminal authority");
  }
  if (intent.reasons.some((item) => item.code === "target_path_outside_repo")) {
    return denyPreToolUse("blocked by SuperSpec hook policy: write target escapes the current repository root");
  }
  if (intent.reasons.some((item) => item.code === "protected_trust_root_link_source")) {
    return denyPreToolUse("blocked by SuperSpec hook policy: link source points at a SuperSpec trust root");
  }
  if (intent.reasons.some((item) => item.code === "shell_path_may_touch_trust_root")) {
    return denyPreToolUse("blocked by SuperSpec hook policy: shell-expanded path may touch SuperSpec trust roots");
  }
  if (intent.reasons.some((item) => item.code === "curl_config_write_target_unknown")) {
    return denyPreToolUse("blocked by SuperSpec hook policy: curl config-driven writes have unknown targets");
  }
  if (intent.reasons.some((item) => item.code === "curl_write_target_unknown")) {
    return denyPreToolUse("blocked by SuperSpec hook policy: curl write options have unknown targets");
  }
  if (intent.target_paths.some((path) => isSuperSpecTrustRootPath(path))) {
    return denyPreToolUse("blocked by SuperSpec hook policy: direct writes to SuperSpec trust roots require an active Guard context");
  }
  if (intent.shell_write_command && intent.trust_root_text_matches.length > 0) {
    return denyPreToolUse("blocked by SuperSpec hook policy: pathless write-capable command appears to touch SuperSpec trust roots");
  }
  if (intent.archive_command) {
    return denyPreToolUse("blocked by SuperSpec hook policy: openspec archive requires an active Guard context and archive_ready allow");
  }
  return passThrough("SuperSpec hook inert: SUPERSPEC_CHANGE/--change not set");
}

function preToolUseOutput(decision: HookDecision): JsonMap {
  if (!decision.allowed) {
    return {
      hookSpecificOutput: {
        hookEventName: "PreToolUse",
        permissionDecision: "deny",
        permissionDecisionReason: decision.block_reasons.map((item) => item.message).join("; ") || "blocked by SuperSpec hook policy",
      },
    };
  }
  return {
    hookSpecificOutput: {
      hookEventName: "PreToolUse",
      additionalContext: `SuperSpec hook ${decision.enforcement}; strict_profile=${decision.strict_profile}; trust=${decision.trust}`,
    },
  };
}

function postToolUseOutput(decision: HookDecision): JsonMap {
  return {
    systemMessage: `SuperSpec hook telemetry recorded as ${decision.trust}; strict_profile=${decision.strict_profile}`,
    hookSpecificOutput: {
      hookEventName: "PostToolUse",
      additionalContext: `SuperSpec runtime evidence is ${decision.strict_profile === "available" ? "runtime-verified" : "audit-only"}.`,
    },
  };
}

function isSubagentHookEvent(eventName: string): boolean {
  return eventName === "SubagentStart" || eventName === "SubagentStop";
}

function subagentOutput(decision: HookDecision, eventName: string): JsonMap {
  if (!decision.allowed) {
    return {
      systemMessage: `SuperSpec ${eventName} runlog skipped; ${decision.block_reasons.map((item) => item.message).join("; ") || "audit telemetry unavailable"}`,
      hookSpecificOutput: {
        hookEventName: eventName,
        additionalContext: "SuperSpec subagent telemetry is best-effort and did not block the workflow.",
      },
    };
  }
  return {
    systemMessage: `SuperSpec ${eventName} runlog recorded as ${decision.trust}; strict_profile=${decision.strict_profile}`,
  };
}

function inertSubagentOutput(eventName: string, message: string): JsonMap {
  return {
    systemMessage: message,
    hookSpecificOutput: {
      hookEventName: eventName,
      additionalContext: "SuperSpec subagent telemetry is best-effort and did not block the workflow.",
    },
  };
}

function writeTempEvent(event: HookEvent): string {
  const path = join(tmpdir(), `superspec-hook-event-${randomUUID()}.json`);
  writeFileSync(path, `${JSON.stringify(event)}\n`, { encoding: "utf8", mode: 0o600, flag: "wx" });
  return path;
}

function validateHookEvent(event: HookEvent): string | null {
  const eventName = typeof event.hook_event_name === "string" ? event.hook_event_name : "";
  if (!eventName) return "hook event missing required hook_event_name";
  if (!["PreToolUse", "PostToolUse", "SubagentStart", "SubagentStop"].includes(eventName)) {
    return `unsupported hook_event_name: ${eventName}`;
  }
  if ((eventName === "PreToolUse" || eventName === "PostToolUse") && (typeof event.cwd !== "string" || !event.cwd)) {
    return "hook event missing required cwd";
  }
  if (eventName === "PreToolUse") {
    if (typeof event.tool_name !== "string" || !event.tool_name) return "PreToolUse hook event missing required tool_name";
    if (!isObject(event.tool_input)) return "PreToolUse hook event missing required tool_input object";
  }
  return null;
}

export function runHookAdapter(argv: string[] = process.argv.slice(2), stdin = readFileSync(0, "utf8")): { code: number; stdout: string; stderr: string } {
  const parsedArgs = parseArgs(argv);
  let event: HookEvent;
  let eventNameForFailure = "";
  try {
    if (!stdin.trim()) throw new Error("hook stdin is empty");
    const parsed = JSON.parse(stdin);
    if (!isObject(parsed)) throw new Error("hook stdin must be a JSON object");
    event = parsed as HookEvent;
    eventNameForFailure = typeof event.hook_event_name === "string" ? event.hook_event_name : "";
    const validationError = validateHookEvent(event);
    if (validationError) throw new Error(validationError);
  } catch (err) {
    if (isSubagentHookEvent(eventNameForFailure)) {
      const payload = inertSubagentOutput(eventNameForFailure, `SuperSpec ${eventNameForFailure} runlog skipped: ${(err as Error).message}`);
      return { code: 0, stdout: `${JSON.stringify(payload)}\n`, stderr: "" };
    }
    return { code: 2, stdout: "", stderr: `SuperSpec hook event parse failed: ${(err as Error).message}\n` };
  }

  const inference = parsedArgs.change ? { state: "unique" as const, change: parsedArgs.change } : inferChangeFromActiveSessions(event);
  const change = inference.state === "unique" ? inference.change : null;
  if (!change) {
    const payload = noChangeFallback(event, inference);
    return { code: 0, stdout: `${JSON.stringify(payload)}\n`, stderr: "" };
  }

  let eventRef: string | null = null;
  try {
    eventRef = writeTempEvent(event);
    const eventName = String(event.hook_event_name ?? "");
    let payload: JsonMap;
    if (eventName === "PreToolUse") {
      const toolName = String(event.tool_name ?? "");
      const decision = toolName === "Bash" ? hookCheckCommand(change, eventRef) : hookCheckWrite(change, eventRef);
      payload = preToolUseOutput(decision);
    } else if (eventName === "PostToolUse") {
      payload = isTestValidationCommand(event) ? postToolUseOutput(hookRecordTest(change, eventRef)) : inertPostToolUseOutput();
    } else if (eventName === "SubagentStart") {
      payload = subagentOutput(hookRecordSubagentStart(change, eventRef), "SubagentStart");
    } else if (eventName === "SubagentStop") {
      payload = subagentOutput(hookRecordSubagentStop(change, eventRef), "SubagentStop");
    } else {
      payload = { systemMessage: `SuperSpec hook ignored unsupported event ${eventName}` };
    }
    return { code: 0, stdout: `${JSON.stringify(payload)}\n`, stderr: "" };
  } catch (err) {
    if (isSubagentHookEvent(String(event.hook_event_name ?? ""))) {
      const eventName = String(event.hook_event_name ?? "");
      const payload = inertSubagentOutput(eventName, `SuperSpec ${eventName} runlog skipped: ${(err as Error).message}`);
      return { code: 0, stdout: `${JSON.stringify(payload)}\n`, stderr: "" };
    }
    return { code: 2, stdout: "", stderr: `SuperSpec hook failed closed: ${(err as Error).message}\n` };
  } finally {
    if (eventRef) {
      try {
        unlinkSync(resolve(eventRef));
      } catch {
        // best effort temp cleanup
      }
    }
  }
}
