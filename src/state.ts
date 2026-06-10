import { closeSync, existsSync, fsyncSync, openSync, readFileSync, renameSync, rmSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { hostname } from "node:os";
import { join } from "node:path";
import type { JsonMap, Reason } from "./util.ts";
import {
  GUARD_VERSION,
  GuardError,
  SCHEMA_VERSION,
  STATE_FILENAME,
  STATE_LOCK_FILENAME,
  deepEqual,
  isObject,
  now,
  reason,
  renderList,
  fingerprint_obj,
  runtime,
  sha256_file,
} from "./util.ts";
import { artifact_status_map, effective_route_phase, get_repo_root, normalize_route_phase, openspec_version, status_fingerprint } from "./openspec.ts";
import {
  config_file,
  ensure_state_layout,
  find_forbidden_aliases,
  project_config_file,
  superspec_dir,
  sidecar_business_invariants_path,
  sidecar_discovery_path,
  sidecar_test_contract_path,
} from "./paths.ts";
import { evidence_fingerprint } from "./evidence.ts";

export function state_file(changeRoot: string): string {
  return join(superspec_dir(changeRoot), STATE_FILENAME);
}

export function ledger_file(changeRoot: string): string {
  return join(superspec_dir(changeRoot), "ledger.jsonl");
}

export function load_state(changeRoot: string): JsonMap | null {
  const filePath = state_file(changeRoot);
  if (!existsSync(filePath) || !statSync(filePath).isFile()) return null;
  try {
    return JSON.parse(readFileSync(filePath, "utf8"));
  } catch {
    return null;
  }
}

// FIX-1 (audit B-2): a missing state file is a legal "first run / explicit delete",
// but an existing-yet-unparseable file means an unexpected write happened and must fail closed.
export function state_file_corrupt(changeRoot: string): boolean {
  const filePath = state_file(changeRoot);
  if (!existsSync(filePath) || !statSync(filePath).isFile()) return false;
  try {
    return !isObject(JSON.parse(readFileSync(filePath, "utf8")));
  } catch {
    return true;
  }
}

export function state_corrupt_reasons(changeRoot: string): Reason[] {
  if (!state_file_corrupt(changeRoot)) return [];
  return [reason(
    "state_corrupt",
    `.superspec/${STATE_FILENAME} exists but is not a parseable JSON object; guard state is corrupt (unexpected write, crash truncation, or manual edit). Inspect the file first, then rerun \`recompute --change <change> --rebuild-corrupt\` to explicitly rebuild guard-owned state; the rebuild is recorded in ledger.jsonl`,
  )];
}

export function read_ledger_text(changeRoot: string): string {
  ensure_state_layout(changeRoot);
  const filePath = ledger_file(changeRoot);
  if (!existsSync(filePath) || !statSync(filePath).isFile()) return "";
  return readFileSync(filePath, "utf8");
}

export function compute_fingerprints(changeRoot: string, status: JsonMap): JsonMap {
  const repoRoot = get_repo_root(status);
  return {
    openspec_status_fingerprint: status_fingerprint(status),
    project_config_fingerprint: sha256_file(project_config_file(repoRoot)),
    change_config_fingerprint: sha256_file(config_file(changeRoot)),
    forbidden_aliases_fingerprint: fingerprint_obj(find_forbidden_aliases(repoRoot, changeRoot).sort()),
    evidence_fingerprint: evidence_fingerprint(changeRoot),
    tasks_fingerprint: sha256_file(join(changeRoot, "tasks.md")),
    discovery_fingerprint: sha256_file(sidecar_discovery_path(changeRoot)),
    design_fingerprint: sha256_file(join(changeRoot, "design.md")),
    business_invariants_fingerprint: sha256_file(sidecar_business_invariants_path(changeRoot)),
    test_contract_fingerprint: sha256_file(sidecar_test_contract_path(changeRoot)),
  };
}

export function state_stale_reasons(changeRoot: string, status: JsonMap): Reason[] {
  const prev = load_state(changeRoot);
  if (prev === null) return [];
  const current = compute_fingerprints(changeRoot, status);
  const previous = isObject(prev.computed_from) ? prev.computed_from : {};
  const stale = Object.entries(current).filter(([key, value]) => previous[key] !== value).map(([key]) => key).sort();
  if (stale.length === 0) return [];
  return [reason("state_fingerprint_stale", `superspec-state fingerprints are stale: ${renderList(stale)}`)];
}

function fsyncDir(dirPath: string): void {
  let fd: number | null = null;
  try {
    fd = openSync(dirPath, "r");
    fsyncSync(fd);
  } catch {
    // Directory fsync is best-effort across platforms.
  } finally {
    if (fd !== null) closeSync(fd);
  }
}

export function materialize_ledger_event(event: JsonMap): JsonMap {
  return { ...event, event_id: `EVT-${Date.now()}-${++ledgerEventSequence}`, created_at: now() };
}

let ledgerEventSequence = 0;

export function ledger_event_line(event: JsonMap): string {
  return `${JSON.stringify(event)}\n`;
}

function appendLedgerLineUnlocked(base: string, line: string): void {
  const ledger = join(base, "ledger.jsonl");
  const fd = openSync(ledger, "a");
  try {
    writeFileSync(fd, line, "utf8");
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
}

function removeNonFilePath(path: string): void {
  if (!existsSync(path)) return;
  rmSync(path, { recursive: true, force: true });
}

function currentStateFingerprints(changeRoot: string): JsonMap | null {
  const current = load_state(changeRoot);
  if (current === null) return null;
  return isObject(current.computed_from) ? current.computed_from : {};
}

function casStateFingerprints(changeRoot: string, expected: JsonMap | null | undefined): void {
  if (expected === undefined || expected === null) return;
  const current = currentStateFingerprints(changeRoot);
  if (current === null && Object.keys(expected).length === 0) return;
  if (!deepEqual(current, expected)) throw new GuardError("state_concurrent_update: superspec-state fingerprints changed during write");
}

export function with_state_lock<T>(changeRoot: string, fn: () => T): T {
  ensure_state_layout(changeRoot);
  const base = superspec_dir(changeRoot);
  const lock = join(base, STATE_LOCK_FILENAME);
  let fd: number | null = null;
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      fd = openSync(lock, "wx");
      writeFileSync(fd, `${JSON.stringify(stateLockInfo())}\n`, "utf8");
      fsyncSync(fd);
      break;
    } catch (err: any) {
      if (err?.code !== "EEXIST") throw err;
      const stale = reclaim_stale_state_lock(lock);
      if (stale) continue;
      throw new GuardError(`state_concurrent_update: ${describe_state_lock(lock)}; if no guard process is active, remove ${STATE_LOCK_FILENAME} or rerun recompute --force-unlock`);
    }
  }
  if (fd === null) {
    throw new GuardError(`state_concurrent_update: ${STATE_LOCK_FILENAME} could not be acquired after stale lock recovery`);
  }
  try {
    return fn();
  } finally {
    if (fd !== null) closeSync(fd);
    try {
      unlinkSync(lock);
    } catch {}
  }
}

function stateLockStaleMs(): number {
  const configured = Number(process.env.SUPERSPEC_STATE_LOCK_STALE_MS);
  return Number.isFinite(configured) && configured > 0 ? configured : 5 * 60 * 1000;
}

function stateLockInfo(): JsonMap {
  return {
    pid: process.pid,
    hostname: hostname(),
    created_at: now(),
  };
}

function read_state_lock_info(lock: string): JsonMap | null {
  try {
    const text = readFileSync(lock, "utf8").trim();
    if (!text) return null;
    const parsed = JSON.parse(text);
    return isObject(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

function pid_is_alive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err: any) {
    if (err?.code === "ESRCH") return false;
    return true;
  }
}

function lock_age_ms(lock: string, info: JsonMap | null): number {
  const parsed = typeof info?.created_at === "string" ? Date.parse(info.created_at) : NaN;
  if (Number.isFinite(parsed)) return Date.now() - parsed;
  try {
    return Date.now() - statSync(lock).mtimeMs;
  } catch {
    return 0;
  }
}

function state_lock_is_stale(lock: string, info: JsonMap | null): boolean {
  const ageMs = lock_age_ms(lock, info);
  if (!info) return false;
  const pid = Number(info.pid);
  const host = String(info.hostname ?? "");
  if (host === hostname() && pid_is_alive(pid)) return false;
  if (host === hostname() && !pid_is_alive(pid)) return true;
  return ageMs > stateLockStaleMs();
}

function reclaim_stale_state_lock(lock: string): boolean {
  const info = read_state_lock_info(lock);
  if (!state_lock_is_stale(lock, info)) return false;
  const reclaimed = `${lock}.stale-${process.pid}-${Date.now()}`;
  try {
    renameSync(lock, reclaimed);
    rmSync(reclaimed, { force: true });
    return true;
  } catch {
    return false;
  }
}

function describe_state_lock(lock: string): string {
  const info = read_state_lock_info(lock);
  if (!info) return `${STATE_LOCK_FILENAME} is held by an unstructured or fresh legacy lock`;
  const details = [
    `pid=${String(info.pid ?? "unknown")}`,
    `hostname=${String(info.hostname ?? "unknown")}`,
    `created_at=${String(info.created_at ?? "unknown")}`,
  ];
  return `${STATE_LOCK_FILENAME} is held (${details.join(", ")})`;
}

export function force_unlock_state(changeRoot: string): boolean {
  ensure_state_layout(changeRoot);
  const lock = join(superspec_dir(changeRoot), STATE_LOCK_FILENAME);
  if (!existsSync(lock)) return false;
  const info = read_state_lock_info(lock);
  const pid = Number(info?.pid);
  const host = String(info?.hostname ?? "");
  if (info && host === hostname() && pid_is_alive(pid)) {
    throw new GuardError(`state_concurrent_update: refusing --force-unlock for live guard process pid=${pid}`);
  }
  rmSync(lock, { force: true });
  return true;
}

function build_recomputed_state(
  change: string,
  changeRoot: string,
  status: JsonMap,
  guardRoutePhase: string,
  activeGate: string,
  decision: JsonMap,
  opts: { config?: JsonMap | null; preset_upgrade_required?: boolean; fingerprints?: JsonMap | null } = {},
): JsonMap {
  // FIX-5 (audit B-3): reuse decision-time fingerprints when provided so a file mutated between
  // decision and write can never be absorbed as "fresh fingerprint + stale decision".
  const fps = opts.fingerprints ?? compute_fingerprints(changeRoot, status);
  const prev = load_state(changeRoot);
  let freshness = "fresh";
  if (prev !== null) {
    const prevFps = isObject(prev.computed_from) ? prev.computed_from : {};
    if (Object.entries(fps).some(([key, value]) => prevFps[key] !== value)) freshness = "recomputed";
  }
  const amap = artifact_status_map(status);
  const effectiveRoute = effective_route_phase(status, guardRoutePhase, decision);
  return {
    schema_version: SCHEMA_VERSION,
    change_id: change,
    guard_version: GUARD_VERSION,
    updated_at: now(),
    openspec: {
      version: openspec_version(),
      status_fingerprint: fps.openspec_status_fingerprint,
      status_summary: amap,
    },
    superspec: {
      guard_route_phase: effectiveRoute,
      requested_route_phase: normalize_route_phase(guardRoutePhase),
      active_gate: activeGate,
      preset: (opts.config ?? {}).preset,
      preset_upgrade_required: Boolean(opts.preset_upgrade_required),
      state_freshness: freshness,
      last_guard_decision: decision.decision,
      last_block_reasons: (decision.block_reasons ?? []).map((item: Reason) => item.code),
    },
    computed_from: {
      openspec_status_command: `openspec status --change ${change} --json`,
      ...fps,
    },
  };
}

export function prepare_recomputed_state_write(
  change: string,
  changeRoot: string,
  status: JsonMap,
  guardRoutePhase: string,
  activeGate: string,
  decision: JsonMap,
  opts: { config?: JsonMap | null; preset_upgrade_required?: boolean; fingerprints?: JsonMap | null } = {},
): JsonMap {
  const prev = load_state(changeRoot);
  const expectedFps = prev !== null && isObject(prev.computed_from) ? prev.computed_from : {};
  const state = build_recomputed_state(change, changeRoot, status, guardRoutePhase, activeGate, decision, opts);
  const ledgerEvent = materialize_ledger_event({ change_id: change, kind: "guard_decision", gate: activeGate, decision: decision.decision });
  const ledgerLine = ledger_event_line(ledgerEvent);
  return {
    state,
    state_text: `${JSON.stringify(state, null, 2)}\n`,
    expected_state_fingerprints: expectedFps,
    ledger_event: ledgerEvent,
    ledger_line: ledgerLine,
  };
}

export function write_prepared_state_locked(changeRoot: string, prepared: JsonMap): void {
  ensure_state_layout(changeRoot);
  const base = superspec_dir(changeRoot);
  casStateFingerprints(changeRoot, isObject(prepared.expected_state_fingerprints) ? prepared.expected_state_fingerprints : {});
  const stateText = typeof prepared.state_text === "string" ? prepared.state_text : `${JSON.stringify(prepared.state ?? {}, null, 2)}\n`;
  const ledgerText = typeof prepared.ledger_text === "string"
    ? prepared.ledger_text
    : `${read_ledger_text(changeRoot)}${typeof prepared.ledger_line === "string" ? prepared.ledger_line : ""}`;
  const ledgerTmp = join(base, "ledger.tmp");
  removeNonFilePath(ledgerTmp);
  const ledgerFd = openSync(ledgerTmp, "w");
  try {
    writeFileSync(ledgerFd, ledgerText, "utf8");
    fsyncSync(ledgerFd);
  } finally {
    closeSync(ledgerFd);
  }
  renameSync(ledgerTmp, ledger_file(changeRoot));
  fsyncDir(base);
  const tmp = join(base, "superspec-state.tmp");
  removeNonFilePath(tmp);
  const tmpFd = openSync(tmp, "w");
  try {
    writeFileSync(tmpFd, stateText, "utf8");
    fsyncSync(tmpFd);
  } finally {
    closeSync(tmpFd);
  }
  renameSync(tmp, state_file(changeRoot));
  fsyncDir(base);
}

export function restore_state_snapshot_locked(changeRoot: string, snapshot: { state_text: string | null; ledger_text: string }): void {
  ensure_state_layout(changeRoot);
  const base = superspec_dir(changeRoot);
  const ledgerTmp = join(base, "ledger.tmp");
  removeNonFilePath(ledgerTmp);
  const ledgerFd = openSync(ledgerTmp, "w");
  try {
    writeFileSync(ledgerFd, snapshot.ledger_text, "utf8");
    fsyncSync(ledgerFd);
  } finally {
    closeSync(ledgerFd);
  }
  renameSync(ledgerTmp, ledger_file(changeRoot));
  fsyncDir(base);
  if (snapshot.state_text === null) {
    if (existsSync(state_file(changeRoot))) rmSync(state_file(changeRoot), { force: true });
    fsyncDir(base);
    if (typeof runtime.on_state_snapshot_restored === "function") {
      runtime.on_state_snapshot_restored({ change_root: changeRoot, state_text: null, ledger_text: snapshot.ledger_text });
    }
    return;
  }
  const tmp = join(base, "superspec-state.tmp");
  removeNonFilePath(tmp);
  const tmpFd = openSync(tmp, "w");
  try {
    writeFileSync(tmpFd, snapshot.state_text, "utf8");
    fsyncSync(tmpFd);
  } finally {
    closeSync(tmpFd);
  }
  renameSync(tmp, state_file(changeRoot));
  fsyncDir(base);
  if (typeof runtime.on_state_snapshot_restored === "function") {
    runtime.on_state_snapshot_restored({ change_root: changeRoot, state_text: snapshot.state_text, ledger_text: snapshot.ledger_text });
  }
}

export function write_state_atomic(
  changeRoot: string,
  state: JsonMap,
  opts: { expected_state_fingerprints?: JsonMap | null; ledger_event?: JsonMap | null } = {},
): void {
  const ledgerEvent = opts.ledger_event ? materialize_ledger_event(opts.ledger_event) : null;
  const prepared = {
    state,
    state_text: `${JSON.stringify(state, null, 2)}\n`,
    expected_state_fingerprints: opts.expected_state_fingerprints ?? {},
    ledger_event: ledgerEvent,
    ledger_line: ledgerEvent ? ledger_event_line(ledgerEvent) : "",
  };
  with_state_lock(changeRoot, () => {
    write_prepared_state_locked(changeRoot, prepared);
  });
}

export function append_ledger(changeRoot: string, event: JsonMap): void {
  const fullEvent = materialize_ledger_event(event);
  const line = ledger_event_line(fullEvent);
  with_state_lock(changeRoot, () => {
    appendLedgerLineUnlocked(superspec_dir(changeRoot), line);
  });
}

// FIX-6 (audit C-2): the fact "evidence X was superseded by Y" must itself be auditable.
// Every observed supersede pair is appended to the ledger exactly once (dedup inside the
// state lock), independent of whether the surrounding guard decision allows or blocks.
export function record_supersede_ledger_events(change: string, changeRoot: string, evidences: JsonMap[]): void {
  const observed = evidences.filter((ev) => !ev._invalid
    && ev.status === "superseded"
    && typeof ev.supersedes === "string" && ev.supersedes
    && typeof ev.evidence_id === "string" && ev.evidence_id);
  if (observed.length === 0) return;
  with_state_lock(changeRoot, () => {
    const seen = new Set<string>();
    for (const line of read_ledger_text(changeRoot).split("\n")) {
      if (!line.trim()) continue;
      let event: unknown;
      try {
        event = JSON.parse(line);
      } catch {
        continue;
      }
      if (!isObject(event) || event.kind !== "evidence_superseded") continue;
      seen.add(`${event.superseded_by}\u0000${event.supersedes}`);
    }
    for (const ev of observed) {
      const key = `${ev.evidence_id}\u0000${ev.supersedes}`;
      if (seen.has(key)) continue;
      seen.add(key);
      const event = materialize_ledger_event({
        change_id: change,
        kind: "evidence_superseded",
        superseded_by: ev.evidence_id,
        supersedes: ev.supersedes,
        gate: ev.gate ?? null,
        supersede_reason: typeof ev.supersede_reason === "string" ? ev.supersede_reason : null,
      });
      appendLedgerLineUnlocked(superspec_dir(changeRoot), ledger_event_line(event));
    }
  });
}

export function recompute_and_write_state_locked(
  change: string,
  changeRoot: string,
  status: JsonMap,
  guardRoutePhase: string,
  activeGate: string,
  decision: JsonMap,
  opts: { config?: JsonMap | null; preset_upgrade_required?: boolean } = {},
): JsonMap {
  const prepared = prepare_recomputed_state_write(change, changeRoot, status, guardRoutePhase, activeGate, decision, opts);
  write_prepared_state_locked(changeRoot, prepared);
  return prepared.state as JsonMap;
}

export function recompute_and_write_state(
  change: string,
  changeRoot: string,
  status: JsonMap,
  guardRoutePhase: string,
  activeGate: string,
  decision: JsonMap,
  opts: { config?: JsonMap | null; preset_upgrade_required?: boolean } = {},
): JsonMap {
  let state: JsonMap = {};
  with_state_lock(changeRoot, () => {
    const prepared = prepare_recomputed_state_write(change, changeRoot, status, guardRoutePhase, activeGate, decision, opts);
    write_prepared_state_locked(changeRoot, prepared);
    state = prepared.state as JsonMap;
  });
  return state;
}
