import type { JsonMap, Reason } from "../util.ts";

export const HOOK_ADAPTER_VERSION = "superspec-hook@2";

export type HookTrust = "trusted" | "audit-only" | "untrusted";
export type HookStrictProfile = "available" | "unavailable";

export type HookEvent = JsonMap & {
  hook_event_name?: string;
  session_id?: string;
  turn_id?: string;
  cwd?: string;
  tool_name?: string;
  tool_use_id?: string;
  tool_input?: JsonMap;
  tool_response?: JsonMap;
  agent_id?: string;
  agent_type?: string;
};

export type HookDecision = {
  allowed: boolean;
  decision: "allow" | "block" | "status";
  change_id: string;
  gate: string;
  strict_profile: HookStrictProfile;
  enforcement: "pass-through" | "guarded" | "deny" | "audit-only";
  trust: HookTrust;
  block_reasons: Reason[];
  audit_only_reasons: Reason[];
  target_paths?: string[];
  tool_name?: string;
  hook_event_name?: string;
  hook_event_id?: string;
  actions?: JsonMap[];
  next_allowed_actions: string[];
  trust_warnings: string[];
};

export type HookSessionRecord = {
  schema_version: 2;
  kind: "hook_active_session";
  trust: HookTrust;
  change_id: string;
  repo_root: string;
  session_id: string;
  workflow: string;
  started_at: string;
  expires_at: string;
  guard_version: string;
  adapter_version: string;
  hook_manifest_hash: string | null;
  strict_profile: HookStrictProfile;
  audit_only_reasons: Reason[];
};

export type HookRunlogRecord = {
  schema_version: 2;
  kind: "subagent_start" | "subagent_stop";
  trust: HookTrust;
  hook_event_id: string;
  hook_event_name: string;
  hook_provenance: JsonMap;
  session_id: string;
  turn_id?: string;
  run_id: string;
  agent_id: string;
  agent_type: string;
  cwd?: string;
  prompt_hash?: string;
  prompt_ref?: string;
  output_ref?: string;
  output_hash?: string;
  status?: string;
  error?: string;
  started_at?: string;
  stopped_at?: string;
};
