#!/usr/bin/env node
export * from "./util.ts";
export * from "./openspec.ts";
export * from "./paths.ts";
export * from "./disclosure.ts";
export * from "./evidence.ts";
export * from "./tasks.ts";
export * from "./invariants.ts";
export * from "./git.ts";
export * from "./state.ts";
export * from "./archive.ts";
export * from "./gates.ts";
export * from "./install_engine.ts";

import { existsSync, readFileSync, statSync } from "node:fs";
import { relative } from "node:path";
import type { ParsedArgs } from "./cli_args.ts";
import type { JsonMap, Reason } from "./util.ts";
import { GuardError, allow, block, deepEqual, reason, runtime, toPosix, trustWarnings } from "./util.ts";
import {
  artifact_status_map,
  gate_route_phase,
  get_change_root,
  get_repo_root,
  openspec_status,
  openspec_status_shape_reasons,
  openspec_validate,
  openspec_version,
  repo_root_from_cwd,
} from "./openspec.ts";
import { config_file, load_config, project_config_file } from "./paths.ts";
import { index_evidence, live_user_confirmations } from "./evidence.ts";
import { tasks_structure_hash } from "./tasks.ts";
import {
  dirty_worktree_paths,
  dirty_worktree_reasons,
  dirty_write_scope_red_reasons,
  file_blob_sha,
  git_lines,
  review_diff_coverage_reasons,
  review_diff_paths,
} from "./git.ts";
import {
  append_ledger,
  load_state,
  compute_fingerprints,
  prepare_recomputed_state_write,
  read_ledger_text,
  record_supersede_ledger_events,
  restore_state_snapshot_locked,
  state_corrupt_reasons,
  state_file,
  state_file_corrupt,
  state_stale_reasons,
  force_unlock_state,
  with_state_lock,
  write_prepared_state_locked,
} from "./state.ts";
import {
  archive_manifest_path,
  begin_archive_preservation_bundle,
  check_archived,
  preset_upgrade_reasons,
  preset_upgrade_required_from_context,
  write_archive_preservation_bundle,
} from "./archive.ts";
import {
  check_archive_ready,
  check_apply_ready,
  check_artifact,
  check_init,
  check_superspec_gate,
  check_review_complete,
  check_review_ready,
  check_task_complete,
  check_task_edit,
  check_task_reopen,
  check_verify_complete,
  evidence_schema_guard,
  superspec_agent_reasons,
  superspec_workflow_skill_reasons,
  openspec_cli_capability_reasons,
  openspec_init_reasons,
} from "./gates.ts";

const RETRY_WAIT = new Int32Array(new SharedArrayBuffer(4));
const DEFAULT_MAX_STATE_WRITE_RETRIES = 5;

function sleep_ms(ms: number): void {
  Atomics.wait(RETRY_WAIT, 0, 0, ms);
}

function is_retryable_state_error(err: unknown): boolean {
  return err instanceof GuardError && err.message.startsWith("state_concurrent_update:");
}

function max_state_write_retries(): number {
  const configured = Number(runtime.max_state_write_retries);
  return Number.isInteger(configured) && configured > 0 ? configured : DEFAULT_MAX_STATE_WRITE_RETRIES;
}

export function load_context(change: string): [JsonMap, string, string, JsonMap[]] {
  const status = runtime.openspec_status(change);
  const changeRoot = get_change_root(status);
  const repoRoot = get_repo_root(status);
  const evidences = index_evidence(changeRoot);
  return [status, repoRoot, changeRoot, evidences];
}

export function cmd_status(change: string): JsonMap {
  const [status, repoRoot, changeRoot] = runtime.load_context(change) as [JsonMap, string, string, JsonMap[]];
  const amap = artifact_status_map(status);
  const st = load_state(changeRoot);
  const [config, configProblems] = load_config(repoRoot, changeRoot);
  const version = openspec_version();
  const dataProblems = [...configProblems, ...openspec_status_shape_reasons(status), ...state_corrupt_reasons(changeRoot)];
  return {
    allowed: dataProblems.length === 0,
    decision: dataProblems.length === 0 ? "status" : "block",
    change_id: change,
    gate: "status",
    openspec_status_summary: amap,
    superspec_gate_summary: {
      state_present: st !== null,
      guard_route_phase: st?.superspec?.guard_route_phase ?? null,
      config_preset: config.preset,
      // FIX-8: surfaced so agents can copy the exact hash into apply_isolation/scope_expansion confirmations.
      tasks_structure_hash: tasks_structure_hash(changeRoot),
      openspec_version: version,
      project_config_present: existsSync(project_config_file(repoRoot)) && statSync(project_config_file(repoRoot)).isFile(),
      change_config_present: existsSync(config_file(changeRoot)) && statSync(config_file(changeRoot)).isFile(),
    },
    block_reasons: dataProblems,
    next_allowed_actions: status.nextSteps ?? [],
    trust_warnings: trustWarnings(),
  };
}

function write_guard_state_checked(
  change: string,
  changeRoot: string,
  status: JsonMap,
  route: string,
  decision: JsonMap,
  opts: { config?: JsonMap | null; preset_upgrade_required?: boolean; allow_corrupt_state_rebuild?: boolean } = {},
): JsonMap {
  const expectedInputs = compute_fingerprints(changeRoot, status);
  let finalDecision = decision;
  with_state_lock(changeRoot, () => {
    if (!opts.allow_corrupt_state_rebuild && state_file_corrupt(changeRoot)) {
      finalDecision = block(change, decision.gate ?? "guard_error", state_corrupt_reasons(changeRoot), {
        task_id: decision.task_id,
        openspec_summary: decision.openspec_status_summary,
        next_actions: ["inspect .superspec/superspec-state.json, then rerun recompute --rebuild-corrupt to explicitly rebuild guard-owned state"],
      });
      return;
    }
    const [lockedStatus, , lockedChangeRoot] = runtime.load_context(change) as [JsonMap, string, string, JsonMap[]];
    const currentInputs = compute_fingerprints(lockedChangeRoot, lockedStatus);
    if (!deepEqual(currentInputs, expectedInputs)) {
      finalDecision = block(change, decision.gate ?? "guard_error", [
        reason("state_concurrent_update", "guard inputs changed between decision and state write; rerun the guard command"),
      ], {
        task_id: decision.task_id,
        openspec_summary: decision.openspec_status_summary,
        next_actions: ["rerun the guard command after the concurrent artifact/evidence change settles"],
      });
    }
    const prepared = prepare_recomputed_state_write(
      change,
      lockedChangeRoot,
      lockedStatus,
      route,
      finalDecision.gate,
      finalDecision,
      { ...opts, fingerprints: currentInputs },
    );
    write_prepared_state_locked(lockedChangeRoot, prepared);
  });
  return finalDecision;
}

export function cmd_init_summary(change: string, changeRoot: string, decision: JsonMap): JsonMap {
  return {
    allowed: Boolean(decision.allowed),
    decision: decision.decision,
    change_id: change,
    gate: "init",
    initialized: Boolean(decision.allowed),
    sidecar: {
      root: ".superspec",
      state: toPosix(relative(changeRoot, state_file(changeRoot))),
      ledger: ".superspec/ledger.jsonl",
    },
    block_reasons: decision.block_reasons ?? [],
    next_allowed_actions: decision.allowed ? ["continue with superspec-explore/propose/apply guard checks"] : decision.next_allowed_actions ?? [],
  };
}

function dispatch_once(args: ParsedArgs): [JsonMap, string] {
  const change = args.change;
  const cmd = args.command;
  if (cmd === "check-archived") return [check_archived(change, repo_root_from_cwd()), "archive"];
  const [status, repoRoot, changeRoot, evidences] = runtime.load_context(change) as [JsonMap, string, string, JsonMap[]];
  if (cmd === "recompute" && args.force_unlock) force_unlock_state(changeRoot);
  const rebuildCorrupt = cmd === "recompute" && Boolean(args.rebuild_corrupt);
  const corruptProblems = rebuildCorrupt ? [] : state_corrupt_reasons(changeRoot);
  const [config, configProblems] = load_config(repoRoot, changeRoot);
  const evProblems = evidence_schema_guard(change, changeRoot, repoRoot, evidences);
  const shapeProblems = openspec_status_shape_reasons(status);
  if (cmd === "status") return [cmd_status(change), "status"];
  let presetRequired = false;
  let presetProblems: Reason[] = [];
  let staleProblems: Reason[] = [];
  if (cmd !== "recompute") {
    const changedPaths = String(config.preset ?? "full") !== "full" ? runtime.dirty_worktree_paths(repoRoot) : [];
    presetRequired = preset_upgrade_required_from_context(config, changedPaths);
    const presetHumanConfirmed = live_user_confirmations(evidences, "preset_upgrade").length > 0;
    presetProblems = preset_upgrade_reasons(config, changedPaths, presetHumanConfirmed);
    if (cmd !== "init") staleProblems = state_stale_reasons(changeRoot, status);
  }
  let dec: JsonMap;
  let route: string;
  if (cmd === "init") {
    if (!args.create) throw new GuardError("init requires --create");
    dec = check_init(change, status, repoRoot, changeRoot);
    route = "init";
  } else if (cmd === "recompute") {
    if (rebuildCorrupt && state_file_corrupt(changeRoot)) {
      append_ledger(changeRoot, {
        change_id: change,
        kind: "state_corrupt_rebuilt",
        note: "corrupt superspec-state.json explicitly rebuilt via recompute --rebuild-corrupt",
      });
    }
    dec = allow(change, "recompute", { openspec_summary: artifact_status_map(status) });
    route = "init";
  } else if (cmd === "check-init") {
    dec = check_init(change, status, repoRoot, changeRoot);
    route = "init";
  } else if (cmd === "check-artifact") {
    dec = check_artifact(change, status, changeRoot, evidences, args.artifact ?? "");
    route = "propose";
  } else if (cmd === "check-enter") {
    dec = check_superspec_gate(change, status, changeRoot, evidences, args.gate ?? "");
    route = gate_route_phase(args.gate ?? "");
  } else if (cmd === "check-apply-ready") {
    dec = check_apply_ready(change, status, changeRoot, evidences);
    route = "propose";
  } else if (cmd === "check-task-edit") {
    dec = check_task_edit(change, status, changeRoot, evidences, args.task_id ?? "");
    route = "apply";
  } else if (cmd === "check-task-reopen") {
    dec = check_task_reopen(change, status, changeRoot, evidences, args.task_id ?? "");
    route = "apply";
  } else if (cmd === "check-task-complete") {
    dec = check_task_complete(change, status, changeRoot, evidences, args.task_id ?? "");
    route = "apply";
  } else if (cmd === "check-review-ready") {
    dec = check_review_ready(change, status, changeRoot, evidences);
    route = "review";
  } else if (cmd === "check-review-complete") {
    dec = check_review_complete(change, status, changeRoot, evidences);
    route = "review";
  } else if (cmd === "check-verify-ready") {
    dec = check_verify_complete(change, status, changeRoot, evidences);
    route = "review";
  } else if (cmd === "check-archive-ready") {
    dec = check_archive_ready(change, status, changeRoot, evidences);
    route = "archive";
  } else {
    throw new GuardError(`unknown command: ${cmd}`);
  }
  if (corruptProblems.length > 0) {
    // FIX-1 fail-closed: block on corrupt state and never write over the corrupted file.
    if (dec.allowed) {
      dec = block(change, dec.gate, corruptProblems, {
        task_id: dec.task_id,
        openspec_summary: dec.openspec_status_summary,
        next_actions: ["inspect .superspec/superspec-state.json, then rerun recompute --rebuild-corrupt to explicitly rebuild guard-owned state"],
      });
    } else {
      dec.block_reasons.push(...corruptProblems);
    }
    return [cmd === "init" ? cmd_init_summary(change, changeRoot, dec) : dec, route];
  }
  // FIX-6: record observed supersede facts in the ledger before any state write,
  // regardless of whether the decision below allows or blocks.
  record_supersede_ledger_events(change, changeRoot, evidences);
  if (cmd === "check-archive-ready") {
    with_state_lock(changeRoot, () => {
      const [lockedStatus, lockedRepoRoot, lockedChangeRoot, lockedEvidences] = runtime.load_context(change) as [JsonMap, string, string, JsonMap[]];
      const [lockedConfig, lockedConfigProblems] = load_config(lockedRepoRoot, lockedChangeRoot);
      const lockedEvProblems = evidence_schema_guard(change, lockedChangeRoot, lockedRepoRoot, lockedEvidences);
      const lockedShapeProblems = openspec_status_shape_reasons(lockedStatus);
      const lockedChangedPaths = String(lockedConfig.preset ?? "full") !== "full" ? runtime.dirty_worktree_paths(lockedRepoRoot) : [];
      const lockedPresetRequired = preset_upgrade_required_from_context(lockedConfig, lockedChangedPaths);
      const lockedPresetHumanConfirmed = live_user_confirmations(lockedEvidences, "preset_upgrade").length > 0;
      const lockedPresetProblems = preset_upgrade_reasons(lockedConfig, lockedChangedPaths, lockedPresetHumanConfirmed);
      const lockedStaleProblems = state_stale_reasons(lockedChangeRoot, lockedStatus);
      const lockedCorruptProblems = state_corrupt_reasons(lockedChangeRoot);
      dec = check_archive_ready(change, lockedStatus, lockedChangeRoot, lockedEvidences);
      // FIX-5: pin decision-time fingerprints so the written computed_from matches what was judged.
      const lockedFps = compute_fingerprints(lockedChangeRoot, lockedStatus);
      const lockedDataProblems = [...lockedShapeProblems, ...lockedConfigProblems, ...lockedEvProblems, ...lockedStaleProblems, ...lockedPresetProblems, ...lockedCorruptProblems];
      if (lockedDataProblems.length > 0) {
        if (dec.allowed) dec = block(change, dec.gate, lockedDataProblems, { task_id: dec.task_id, openspec_summary: dec.openspec_status_summary });
        else dec.block_reasons.push(...lockedDataProblems);
      }
      // FIX-1 fail-closed: never write state/ledger over a corrupted state file.
      if (lockedCorruptProblems.length > 0) return;
      if (!dec.allowed) {
        const blockedPrepared = prepare_recomputed_state_write(change, lockedChangeRoot, lockedStatus, route, dec.gate, dec, {
          config: lockedConfig,
          preset_upgrade_required: lockedPresetRequired,
          fingerprints: lockedFps,
        });
        write_prepared_state_locked(lockedChangeRoot, blockedPrepared);
        return;
      }
      const allowedPrepared = prepare_recomputed_state_write(change, lockedChangeRoot, lockedStatus, route, dec.gate, dec, {
        config: lockedConfig,
        preset_upgrade_required: lockedPresetRequired,
        fingerprints: lockedFps,
      });
      const previousStateText = existsSync(state_file(lockedChangeRoot)) && statSync(state_file(lockedChangeRoot)).isFile()
        ? readFileSync(state_file(lockedChangeRoot), "utf8")
        : null;
      const previousLedgerText = read_ledger_text(lockedChangeRoot);
      const futureLedgerText = `${read_ledger_text(lockedChangeRoot)}${String(allowedPrepared.ledger_line ?? "")}`;
      let txn: { manifest_path: string; bundle_manifest_path: string; commit: () => void; rollback: () => void } | null = null;
      try {
        txn = runtime.begin_archive_preservation_bundle(change, lockedChangeRoot, {
          file_overrides: {
            ".superspec/superspec-state.json": String(allowedPrepared.state_text),
            ".superspec/ledger.jsonl": futureLedgerText,
          },
        });
        if (txn === null) throw new Error("archive preservation transaction missing");
        const activeTxn = txn;
        dec.superspec_gate_summary.archive_manifest = toPosix(relative(lockedChangeRoot, activeTxn.manifest_path));
        dec.superspec_gate_summary.archive_preservation_bundle = toPosix(relative(lockedChangeRoot, activeTxn.bundle_manifest_path));
        write_prepared_state_locked(lockedChangeRoot, allowedPrepared);
        activeTxn.commit();
      } catch (err) {
        if (txn !== null) {
          try {
            txn.rollback();
            restore_state_snapshot_locked(lockedChangeRoot, { state_text: previousStateText, ledger_text: previousLedgerText });
          } catch (rollbackErr) {
            throw new Error(
              `archive preservation bundle/state commit failed: ${(err as Error).message}; rollback failed: ${(rollbackErr as Error).message}`,
            );
          }
        }
        dec = block(change, "archive_ready", [reason("missing_archive_preservation_plan", `archive preservation manifest/bundle could not be written: ${(err as Error).message}`)], {
          next_actions: ["fix archive preservation filesystem/materialization failure, then rerun check-archive-ready before openspec archive -y"],
        });
        const blockedPrepared = prepare_recomputed_state_write(change, lockedChangeRoot, lockedStatus, route, dec.gate, dec, {
          config: lockedConfig,
          preset_upgrade_required: lockedPresetRequired,
          fingerprints: lockedFps,
        });
        write_prepared_state_locked(lockedChangeRoot, blockedPrepared);
      }
    });
    return [dec, route];
  }
  const dataProblems = [...shapeProblems, ...configProblems, ...evProblems, ...staleProblems, ...presetProblems];
  if (dataProblems.length > 0) {
    if (dec.allowed) dec = block(change, dec.gate, dataProblems, { task_id: dec.task_id, openspec_summary: dec.openspec_status_summary });
    else dec.block_reasons.push(...dataProblems);
  }
  dec = write_guard_state_checked(change, changeRoot, status, route, dec, { config, preset_upgrade_required: presetRequired, allow_corrupt_state_rebuild: rebuildCorrupt });
  if (cmd === "init") return [cmd_init_summary(change, changeRoot, dec), route];
  return [dec, route];
}

export function dispatch(args: ParsedArgs): [JsonMap, string] {
  const retryLimit = max_state_write_retries();
  for (let attempt = 0; attempt < retryLimit; attempt++) {
    try {
      return dispatch_once(args);
    } catch (err) {
      if (!is_retryable_state_error(err) || attempt === retryLimit - 1) throw err;
      if (typeof runtime.on_state_retry === "function") {
        runtime.on_state_retry({
          attempt: attempt + 1,
          error: String((err as Error)?.message ?? err),
        });
      }
      sleep_ms(50 * (attempt + 1));
    }
  }
  throw new GuardError("state_concurrent_update: retry budget exhausted");
}

Object.assign(runtime, {
  openspec_status,
  openspec_validate,
  openspec_cli_capability_reasons,
  openspec_init_reasons,
  superspec_agent_reasons,
  superspec_workflow_skill_reasons,
  file_blob_sha,
  git_lines,
  dirty_worktree_paths,
  dirty_worktree_reasons,
  dirty_write_scope_red_reasons,
  review_diff_paths,
  review_diff_coverage_reasons,
  begin_archive_preservation_bundle,
  write_archive_preservation_bundle,
  load_context,
});
