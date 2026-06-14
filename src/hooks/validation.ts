import { existsSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import type { JsonMap, Reason } from "../util.ts";
import { isObject, reason, safe_within, sha256_file } from "../util.ts";
import { superspec_dir } from "../paths.ts";

function runlogPath(changeRoot: string): string {
  return join(superspec_dir(changeRoot), "subagent-runlog.jsonl");
}

export function strictRoleRunlogReasons(changeRoot: string, ev: JsonMap): Reason[] {
  if (ev.trust !== "runtime-verified" && ev.requires_hook_runlog !== true) return [];
  const problems: Reason[] = [
    reason("hook_runlog_strict_profile_unavailable", `${ev._path}: strict hook runlog validation is unavailable until R-1 deny and hook provenance pass`),
  ];
  const target = runlogPath(changeRoot);
  if (!existsSync(target) || !statSync(target).isFile()) {
    problems.push(reason("hook_runlog_missing", `${ev._path}: strict role evidence requires SuperSpec hook subagent runlog`));
    return problems;
  }
  const records = readFileSync(target, "utf8").split(/\r?\n/u).filter(Boolean).flatMap((line) => {
    try {
      const parsed = JSON.parse(line);
      return isObject(parsed) ? [parsed] : [];
    } catch {
      return [];
    }
  });
  const agentId = String(ev.agent_id ?? "");
  const role = String(ev.agent_role ?? "");
  const starts = records.filter((item) => item.kind === "subagent_start" && item.agent_id === agentId && item.agent_type === role && item.trust === "trusted");
  const stops = records.filter((item) => item.kind === "subagent_stop" && item.agent_id === agentId && item.agent_type === role && item.trust === "trusted");
  if (starts.length === 0) problems.push(reason("hook_runlog_start_missing", `${ev._path}: strict role evidence has no trusted matching SubagentStart`, [agentId]));
  if (stops.length === 0) problems.push(reason("hook_runlog_stop_missing", `${ev._path}: strict role evidence has no trusted matching SubagentStop`, [agentId]));
  const outputRef = typeof ev.output_ref === "string" ? ev.output_ref : "";
  const outputPath = outputRef ? safe_within(changeRoot, outputRef) : null;
  const outputSha = outputPath && existsSync(outputPath) && statSync(outputPath).isFile() ? sha256_file(outputPath) : null;
  if (outputSha && stops.length > 0 && !stops.some((item) => item.output_hash === outputSha || item.output_ref === outputRef)) {
    problems.push(reason("hook_runlog_output_mismatch", `${ev._path}: strict role evidence output_ref does not match trusted SubagentStop output hash/ref`, [agentId]));
  }
  return problems;
}

export function strictRuntimeEvidenceReasons(ev: JsonMap): Reason[] {
  if (ev.trust !== "runtime-verified") return [];
  const problems: Reason[] = [
    reason("runtime_evidence_strict_profile_unavailable", `${ev._path}: strict runtime evidence is unavailable until R-1 deny and hook provenance pass`),
  ];
  if (typeof ev.hook_event_id !== "string" || !ev.hook_event_id) problems.push(reason("runtime_evidence_missing_hook_event", `${ev._path}: runtime-verified evidence requires hook_event_id`));
  if (!isObject(ev.hook_provenance) || ev.hook_provenance.validation !== "trusted") problems.push(reason("runtime_evidence_untrusted_provenance", `${ev._path}: runtime-verified evidence requires trusted hook_provenance`));
  if (!isObject(ev.token_binding)) problems.push(reason("runtime_evidence_missing_token", `${ev._path}: runtime-verified evidence requires Guard token_binding`));
  if (typeof ev.command_fingerprint !== "string" || !ev.command_fingerprint.startsWith("sha256:")) problems.push(reason("runtime_evidence_missing_command_fingerprint", `${ev._path}: runtime-verified evidence requires command_fingerprint`));
  if (!Array.isArray(ev.raw_log_pinned_refs) || ev.raw_log_pinned_refs.length === 0) problems.push(reason("runtime_evidence_missing_raw_log_pin", `${ev._path}: runtime-verified evidence requires raw_log_pinned_refs`));
  if (typeof ev.exit_code !== "number") {
    problems.push(reason("runtime_evidence_missing_exit_code", `${ev._path}: runtime-verified evidence requires numeric exit_code`));
  } else if ((ev.kind === "final_test" || ev.semantic_status === "expected_success") && ev.exit_code !== 0) {
    problems.push(reason("runtime_evidence_exit_code_mismatch", `${ev._path}: expected_success/final_test runtime evidence requires exit_code=0`));
  } else if (ev.semantic_status === "expected_failure" && ev.exit_code === 0) {
    problems.push(reason("runtime_evidence_exit_code_mismatch", `${ev._path}: RED runtime evidence requires non-zero exit_code`));
  }
  return problems;
}
