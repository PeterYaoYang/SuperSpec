import type { JsonMap, Reason } from "./util.ts";
import { isObject, reason, renderList, repr } from "./util.ts";
import { find_pass, live_pass } from "./evidence.ts";
import {
  apply_worker_implementation_fingerprint,
  apply_worker_executor_input_ref_digest,
  compute_apply_worker_freshness,
  fingerprint_matches,
  pinned_artifact_ref_reasons as shared_pinned_artifact_ref_reasons,
  pre_edit_evidence_ref_reasons,
  read_pinned_artifact_json,
  worker_input_ref_digest,
  worker_test_run_reasons,
} from "./apply_worker_chain.ts";

export type ApplyWorkerChainLifecycleState = {
  completionReasons: Reason[];
  packetBlockers: Reason[];
  activeBlockingReasons: Reason[];
  activePresence: "none" | "single_open" | "blocked";
  active: JsonMap | null;
  openActiveChainIds: Set<string>;
  validTerminalChainIds: Set<string>;
  validClosedChainIds: Set<string>;
  validClosedGreenEvidenceIds: Set<string>;
  takeoverBaselines: { fingerprint: unknown; successorGreenRefs: string[] }[];
};

function pinned_artifact_ref_matches(changeRoot: string, refItem: unknown, role: string, taskId: string, chainId: string, kind = "worker_report"): boolean {
  return shared_pinned_artifact_ref_reasons(changeRoot, refItem, `${role}_ref`, { kind, role, taskId, chainId }).length === 0;
}

function executor_worker_test_run_refs_valid(changeRoot: string, ev: JsonMap, taskId: string, chainId: string): boolean {
  return worker_test_run_reasons(changeRoot, ev, taskId, chainId).length === 0;
}

function report_origin_matches(refItem: unknown, expected: unknown): boolean {
  return isObject(refItem) && typeof expected === "string" && refItem.origin_packet_fingerprint === expected;
}

function report_input_refs_match(refItem: unknown, refs: unknown[]): boolean {
  return isObject(refItem) && refItem.input_ref_digest === worker_input_ref_digest(refs);
}

function report_input_digest_matches(refItem: unknown, expectedDigest: string): boolean {
  return isObject(refItem) && refItem.input_ref_digest === expectedDigest;
}

function chain_green_ids(ev: JsonMap): string[] {
  if (Array.isArray(ev.green_test_run_evidence_refs)) {
    return ev.green_test_run_evidence_refs.map(String).filter(Boolean).sort();
  }
  const greenId = isObject(ev.green_test_run_evidence_ref)
    ? String(ev.green_test_run_evidence_ref.evidence_id ?? "")
    : String(ev.green_test_run_evidence_ref ?? "");
  return greenId ? [greenId] : [];
}

function active_pre_edit_input_refs(evidences: JsonMap[], active: JsonMap): JsonMap[] {
  const preIds = Array.isArray(active.pre_edit_evidence_refs) ? active.pre_edit_evidence_refs.map(String) : [];
  return preIds.map((evidenceId) => {
    const ev = live_pass(evidences, { kind: "test_run" }).find((item) => String(item.evidence_id ?? "") === evidenceId);
    return ev
      ? { kind: "test_run", evidence_id: evidenceId, phase: ev.phase, semantic_status: ev.semantic_status }
      : { kind: "test_run", evidence_id: evidenceId };
  });
}

function closed_apply_worker_chain_valid(repoRoot: string, changeRoot: string, ev: JsonMap, evidences: JsonMap[], taskId: string, chainId: string): boolean {
  const active = live_pass(evidences, { gate: "task_complete", kind: "apply_worker_chain", task_id: taskId })
    .find((item) => item.chain_state === "active" && item.apply_worker_chain_id === chainId);
  if (!active) return false;
  if (pre_edit_evidence_ref_reasons(evidences, active, taskId).length > 0) return false;
  if (!pinned_artifact_ref_matches(changeRoot, ev.executor_report_ref, "executor", taskId, chainId)) return false;
  if (!pinned_artifact_ref_matches(changeRoot, ev.task_code_review_report_ref, "code-reviewer", taskId, chainId)) return false;
  if (!pinned_artifact_ref_matches(changeRoot, ev.verifier_report_ref, "verifier", taskId, chainId)) return false;
  if (!report_origin_matches(ev.executor_report_ref, active.executor_packet_fingerprint)) return false;
  if (!report_input_digest_matches(ev.executor_report_ref, apply_worker_executor_input_ref_digest(evidences, active))) return false;
  if (!report_input_refs_match(ev.task_code_review_report_ref, [ev.executor_report_ref])) return false;
  if (typeof ev.observed_freshness_fingerprint !== "string" && !(isObject(ev.observed_freshness_fingerprint) && typeof ev.observed_freshness_fingerprint.fingerprint_digest === "string")) return false;
  const verifierReport = read_pinned_artifact_json(changeRoot, ev.verifier_report_ref);
  const verifierObserved = verifierReport?.observed_freshness_fingerprint ?? (isObject(ev.verifier_report_ref) ? ev.verifier_report_ref.observed_freshness_fingerprint : undefined);
  if (!fingerprint_matches(verifierObserved, ev.observed_freshness_fingerprint)) return false;
  const greenIds = chain_green_ids(ev);
  if (greenIds.length === 0) return false;
  const greenRuns = greenIds.map((greenId) => live_pass(evidences, { gate: "task_complete", kind: "test_run", task_id: taskId }).find((item) => (
    String(item.evidence_id ?? "") === greenId
      && item.semantic_status === "expected_success"
      && (item.phase === undefined || item.phase === "green")
      && item.apply_execution_chain === "executor_worker"
      && item.apply_worker_chain_id === chainId
      && executor_worker_test_run_refs_valid(changeRoot, item, taskId, chainId)
  ))).filter((item): item is JsonMap => isObject(item));
  if (greenRuns.length !== greenIds.length) return false;
  if (!report_input_refs_match(ev.verifier_report_ref, [
    ev.executor_report_ref,
    ev.task_code_review_report_ref,
    ...greenRuns.map((green) => ({ kind: "test_run", evidence_id: String(green.evidence_id ?? ""), phase: green.phase, semantic_status: green.semantic_status })),
    ...active_pre_edit_input_refs(evidences, active),
  ])) return false;
  const currentFreshness = compute_apply_worker_freshness(repoRoot, changeRoot, evidences, taskId, chainId, {
    executor_report_ref: ev.executor_report_ref,
    task_code_review_report_ref: ev.task_code_review_report_ref,
    green_test_run_evidence_ref: greenIds[0],
    green_test_run_evidence_refs: greenIds,
    verifier_report_ref: ev.verifier_report_ref,
  });
  if (Array.isArray(currentFreshness.unexpected_guard_owned_dirty_paths) && currentFreshness.unexpected_guard_owned_dirty_paths.length > 0) return false;
  if (Array.isArray(currentFreshness.protected_dirty_paths) && currentFreshness.protected_dirty_paths.length > 0) return false;
  if (!greenRuns.every((green) => fingerprint_matches(green.implementation_fingerprint, currentFreshness.implementation_fingerprint))) return false;
  if (!fingerprint_matches(
    isObject(ev.task_code_review_report_ref) ? ev.task_code_review_report_ref.observed_implementation_fingerprint : undefined,
    currentFreshness.implementation_fingerprint,
  )) return false;
  return fingerprint_matches(currentFreshness, verifierObserved);
}

function pinned_takeover_baseline_valid(changeRoot: string, refItem: unknown, taskId: string, chainId: string): boolean {
  return shared_pinned_artifact_ref_reasons(changeRoot, refItem, "serial_takeover_baseline_ref", { kind: "status_report", role: "verifier", taskId, chainId }).length === 0;
}

function abandoned_apply_worker_chain_valid(repoRoot: string, changeRoot: string, ev: JsonMap, active: JsonMap | undefined, taskId: string, chainId: string): boolean {
  if (!active) return false;
  if ("restored_implementation_fingerprint" in ev) {
    const activeScope = Array.isArray(active.declared_task_write_scope) ? active.declared_task_write_scope.map(String).filter(Boolean) : [];
    const current = apply_worker_implementation_fingerprint(repoRoot, changeRoot, [], { declaredTaskWriteScope: activeScope });
    if (fingerprint_matches(ev.restored_implementation_fingerprint, active.source_implementation_fingerprint)
      && fingerprint_matches(current, active.source_implementation_fingerprint)) return true;
  }
  if ("serial_takeover_baseline_ref" in ev) {
    return pinned_takeover_baseline_valid(changeRoot, ev.serial_takeover_baseline_ref, taskId, chainId)
      && Array.isArray(ev.successor_green_evidence_refs)
      && ev.successor_green_evidence_refs.length > 0
      && ev.successor_green_evidence_refs.every((item: unknown) => typeof item === "string" && item.length > 0);
  }
  return false;
}

export function serial_completion_green(ev: JsonMap): boolean {
  return (ev.runner_origin === undefined || ev.runner_origin === "main-thread")
    && ev.apply_execution_chain !== "executor_worker"
    && typeof ev.apply_worker_chain_id !== "string";
}

export function apply_worker_chain_lifecycle_state(repoRoot: string, changeRoot: string, evidences: JsonMap[], taskId: string): ApplyWorkerChainLifecycleState {
  const chains = find_pass(evidences, { gate: "task_complete", kind: "apply_worker_chain", task_id: taskId });
  const activeByChain = new Map<string, JsonMap>();
  const activeCounts = new Map<string, JsonMap[]>();
  for (const ev of chains) {
    if (String(ev.chain_state ?? "") !== "active") continue;
    const chainId = String(ev.apply_worker_chain_id ?? "");
    if (!chainId) continue;
    const bucket = activeCounts.get(chainId) ?? [];
    bucket.push(ev);
    activeCounts.set(chainId, bucket);
    if (!activeByChain.has(chainId)) activeByChain.set(chainId, ev);
  }
  const chainIdsWithActive = new Set([...activeByChain.keys()]);
  const terminalValidity = new Map<JsonMap, boolean>();
  const chainIdsWithTerminal = new Set(
    chains
      .filter((ev) => {
        const chainId = String(ev.apply_worker_chain_id ?? "");
        if (!chainId) return false;
        let valid = false;
        if (String(ev.chain_state ?? "") === "closed") valid = closed_apply_worker_chain_valid(repoRoot, changeRoot, ev, evidences, taskId, chainId);
        if (String(ev.chain_state ?? "") === "abandoned") valid = abandoned_apply_worker_chain_valid(repoRoot, changeRoot, ev, activeByChain.get(chainId), taskId, chainId);
        terminalValidity.set(ev, valid);
        return valid;
      })
      .map((ev) => String(ev.apply_worker_chain_id ?? ""))
      .filter(Boolean),
  );
  const openActiveChainIds = new Set([...activeByChain.keys()].filter((chainId) => !chainIdsWithTerminal.has(chainId)));
  const validClosedChainIds = new Set(
    chains
      .filter((ev) => {
        const chainId = String(ev.apply_worker_chain_id ?? "");
        const valid = String(ev.chain_state ?? "") === "closed" && (terminalValidity.get(ev) ?? closed_apply_worker_chain_valid(repoRoot, changeRoot, ev, evidences, taskId, chainId));
        return chainId && valid;
      })
      .map((ev) => String(ev.apply_worker_chain_id ?? ""))
      .filter(Boolean),
  );
  const validClosedGreenEvidenceIds = new Set(
    chains
      .filter((ev) => {
        const chainId = String(ev.apply_worker_chain_id ?? "");
        const valid = String(ev.chain_state ?? "") === "closed" && (terminalValidity.get(ev) ?? closed_apply_worker_chain_valid(repoRoot, changeRoot, ev, evidences, taskId, chainId));
        return chainId && valid;
      })
      .flatMap(chain_green_ids),
  );
  const takeoverBaselines: { fingerprint: unknown; successorGreenRefs: string[] }[] = [];
  const completionReasons: Reason[] = [];
  const duplicateActives = [...activeCounts.entries()]
    .filter(([chainId]) => openActiveChainIds.has(chainId))
    .map(([, items]) => items)
    .filter((items) => items.length > 1)
    .flatMap((items) => items.map((ev) => String(ev.evidence_id ?? ev.apply_worker_chain_id ?? "")))
    .filter(Boolean)
    .sort();
  const openActiveValues = [...openActiveChainIds].map((chainId) => activeByChain.get(chainId)).filter((ev): ev is JsonMap => isObject(ev));
  const parallelActives = openActiveValues.length > 1
    ? openActiveValues.map((ev) => String(ev.evidence_id ?? ev.apply_worker_chain_id ?? "")).filter(Boolean).sort()
    : [];
  const activeConflicts = [...new Set([...duplicateActives, ...parallelActives])].sort();
  if (activeConflicts.length > 0) {
    completionReasons.push(reason("apply_worker_chain_active_conflict", `task ${taskId} has conflicting active apply worker chain markers: ${renderList(activeConflicts)}`, activeConflicts));
  }
  const terminalsByChain = new Map<string, JsonMap[]>();
  for (const ev of chains) {
    const state = String(ev.chain_state ?? "");
    if (state !== "closed" && state !== "abandoned") continue;
    const chainId = String(ev.apply_worker_chain_id ?? "");
    if (!chainId) continue;
    const bucket = terminalsByChain.get(chainId) ?? [];
    bucket.push(ev);
    terminalsByChain.set(chainId, bucket);
  }
  const duplicateTerminals = [...terminalsByChain.values()]
    .filter((items) => items.length > 1)
    .flatMap((items) => items.map((ev) => String(ev.evidence_id ?? ev.apply_worker_chain_id ?? "")))
    .filter(Boolean)
    .sort();
  if (duplicateTerminals.length > 0) {
    completionReasons.push(reason("apply_worker_chain_terminal_conflict", `task ${taskId} has duplicate apply worker chain terminal markers: ${renderList(duplicateTerminals)}`, duplicateTerminals));
  }
  const invalidTerminals = chains
    .filter((ev) => String(ev.chain_state ?? "") === "closed" || String(ev.chain_state ?? "") === "abandoned")
    .filter((ev) => {
      const chainId = String(ev.apply_worker_chain_id ?? "");
      if (!chainId) return true;
      if (String(ev.chain_state ?? "") === "closed") return !(terminalValidity.get(ev) ?? closed_apply_worker_chain_valid(repoRoot, changeRoot, ev, evidences, taskId, chainId));
      const valid = terminalValidity.get(ev) ?? abandoned_apply_worker_chain_valid(repoRoot, changeRoot, ev, activeByChain.get(chainId), taskId, chainId);
      if (valid && isObject(ev.serial_takeover_baseline_ref)) {
        const baseline = read_pinned_artifact_json(changeRoot, ev.serial_takeover_baseline_ref);
        if (baseline?.implementation_fingerprint !== undefined) {
          takeoverBaselines.push({
            fingerprint: baseline.implementation_fingerprint,
            successorGreenRefs: Array.isArray(ev.successor_green_evidence_refs) ? ev.successor_green_evidence_refs.map(String).filter(Boolean) : [],
          });
        }
      }
      return !valid;
    })
    .map((ev) => String(ev.evidence_id ?? ev.apply_worker_chain_id ?? ""))
    .filter(Boolean)
    .sort();
  if (invalidTerminals.length > 0) {
    completionReasons.push(reason("apply_worker_chain_terminal_invalid", `task ${taskId} has invalid apply worker chain terminal markers: ${renderList(invalidTerminals)}`, invalidTerminals));
  }
  for (const chainId of [...openActiveChainIds].sort()) {
    if (!chainIdsWithTerminal.has(chainId)) {
      completionReasons.push(reason("apply_worker_chain_active", `task ${taskId} has active apply worker chain and cannot use non-chain task completion: ${chainId}`, [chainId]));
    }
  }
  for (const ev of evidences) {
    if (!isObject(ev) || ev._invalid || ev.status !== "pass" || ev.task_id !== taskId) continue;
    const chainId = typeof ev.apply_worker_chain_id === "string" ? ev.apply_worker_chain_id : "";
    if (!chainId) continue;
    if (!chainIdsWithActive.has(chainId)) {
      completionReasons.push(reason("apply_worker_chain_missing_active", `task ${taskId} references apply_worker_chain_id=${repr(chainId)} without a matching active marker`, [chainId]));
    }
  }
  if (duplicateTerminals.length > 0 || activeConflicts.length > 0) {
    validClosedChainIds.clear();
    validClosedGreenEvidenceIds.clear();
  }
  const activeBlockingReasons = completionReasons.filter((item) => (
    item.code === "apply_worker_chain_active_conflict"
      || item.code === "apply_worker_chain_terminal_conflict"
      || item.code === "apply_worker_chain_terminal_invalid"
      || item.code === "apply_worker_chain_missing_active"
  ));
  const activePresence = activeBlockingReasons.length > 0
    ? "blocked"
    : openActiveValues.length === 1
      ? "single_open"
      : "none";
  return {
    completionReasons,
    packetBlockers: activeBlockingReasons,
    activeBlockingReasons,
    activePresence,
    active: activePresence === "single_open" ? openActiveValues[0] : null,
    openActiveChainIds,
    validTerminalChainIds: chainIdsWithTerminal,
    validClosedChainIds,
    validClosedGreenEvidenceIds,
    takeoverBaselines,
  };
}

export function apply_worker_chain_lifecycle_reasons(repoRoot: string, changeRoot: string, evidences: JsonMap[], taskId: string): Reason[] {
  return apply_worker_chain_lifecycle_state(repoRoot, changeRoot, evidences, taskId).completionReasons;
}
