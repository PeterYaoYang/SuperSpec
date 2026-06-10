import { dirname, join, resolve, sep } from "node:path";
import { existsSync } from "node:fs";
import type { JsonMap, Reason } from "./util.ts";
import {
  GATE_ALIASES,
  GATE_ROUTE,
  GuardError,
  ROUTE_ALIASES,
  ROUTE_ORDER,
  fingerprint_obj,
  isObject,
  reason,
  repr,
  runCommand,
} from "./util.ts";

export function openspec_status(change: string): JsonMap {
  const proc = runCommand("openspec", ["status", "--change", change, "--json"], { timeout: 30_000 });
  if (proc.error) {
    throw new GuardError(`openspec_unavailable: status failed: ${proc.error.message}`);
  }
  if (proc.status !== 0) {
    throw new GuardError(`openspec_unavailable: status exit ${proc.status}: ${proc.stderr.trim()}`);
  }
  try {
    return JSON.parse(proc.stdout);
  } catch (err) {
    throw new GuardError(`openspec_unavailable: status json parse failed`);
  }
}

export function openspec_validate(change: string): [boolean, string] {
  const proc = runCommand("openspec", ["validate", change], { timeout: 60_000 });
  if (proc.error) {
    throw new GuardError(`openspec_unavailable: validate failed: ${proc.error.message}`);
  }
  return [proc.status === 0, `${proc.stdout}${proc.stderr}`.trim()];
}

export function openspec_version(): string {
  const proc = runCommand("openspec", ["--version"], { timeout: 15_000 });
  if (proc.error || proc.status !== 0) return "unknown";
  const raw = (proc.stdout || proc.stderr).trim();
  const match = raw.match(/\d+\.\d+\.\d+/);
  return match ? match[0] : raw || "unknown";
}

export function openspec_status_shape_reasons(status: JsonMap): Reason[] {
  const problems: Reason[] = [];
  if (typeof status.changeRoot !== "string" || !status.changeRoot) {
    problems.push(reason("openspec_status_incompatible", "status.changeRoot missing or not a string"));
  }
  const planningHome = status.planningHome;
  if (!isObject(planningHome) || typeof planningHome.root !== "string") {
    problems.push(reason("openspec_status_incompatible", "status.planningHome.root missing or not a string"));
  }
  const artifacts = status.artifacts;
  if (!Array.isArray(artifacts)) {
    problems.push(reason("openspec_status_incompatible", "status.artifacts missing or not a list"));
  } else {
    artifacts.forEach((artifact: any, idx: number) => {
      if (!isObject(artifact)) {
        problems.push(reason("openspec_status_incompatible", `status.artifacts[${idx}] is not an object`));
        return;
      }
      if (typeof artifact.id !== "string") {
        problems.push(reason("openspec_status_incompatible", `status.artifacts[${idx}].id missing`));
      }
      if (!["done", "ready", "blocked"].includes(String(artifact.status))) {
        problems.push(reason("openspec_status_incompatible", `status.artifacts[${idx}].status unsupported: ${repr(artifact.status)}`));
      }
      if ("missingDeps" in artifact && !Array.isArray(artifact.missingDeps)) {
        problems.push(reason("openspec_status_incompatible", `status.artifacts[${idx}].missingDeps must be a list`));
      }
    });
  }
  if (!Array.isArray(status.applyRequires)) {
    problems.push(reason("openspec_status_incompatible", "status.applyRequires missing or not a list"));
  }
  return problems;
}

export function artifact_status_map(status: JsonMap): Record<string, string> {
  const out: Record<string, string> = {};
  for (const artifact of Array.isArray(status.artifacts) ? status.artifacts : []) {
    if (isObject(artifact) && typeof artifact.id === "string") {
      out[artifact.id] = String(artifact.status ?? "unknown");
    }
  }
  return out;
}

export function is_ready_or_done(status: JsonMap, artifact: string): boolean {
  return ["ready", "done"].includes(artifact_status_map(status)[artifact]);
}

export function is_done(status: JsonMap, artifact: string): boolean {
  return artifact_status_map(status)[artifact] === "done";
}

export function all_done(status: JsonMap): boolean {
  const values = Object.values(artifact_status_map(status));
  return values.length > 0 && values.every((item) => item === "done");
}

export function openspec_floor_route(status: JsonMap): string {
  if (is_done(status, "tasks")) return "apply";
  if (is_done(status, "design")) return "propose";
  if (is_done(status, "proposal") && is_done(status, "specs")) return "propose";
  if (is_ready_or_done(status, "proposal") && is_ready_or_done(status, "specs")) return "propose";
  return "init";
}

export function normalize_route_phase(route: string): string {
  return ROUTE_ALIASES[route] ?? route;
}

export function normalize_gate(gate: string): string {
  return GATE_ALIASES[gate] ?? gate;
}

export function gate_route_phase(gate: string): string {
  return GATE_ROUTE[normalize_gate(gate)] ?? "propose";
}

export function effective_route_phase(status: JsonMap, requestedRoute: string, decision: JsonMap): string {
  const requested = normalize_route_phase(requestedRoute);
  if (decision.allowed) return requested;
  const floor = openspec_floor_route(status);
  const requestedOrder = ROUTE_ORDER[requested];
  if (requestedOrder === undefined) return floor;
  return requestedOrder <= ROUTE_ORDER[floor] ? requested : floor;
}

export function status_fingerprint(status: JsonMap): string {
  const artifacts = (Array.isArray(status.artifacts) ? status.artifacts : [])
    .map((artifact: any) => ({
      id: artifact.id,
      status: artifact.status,
      missingDeps: [...(Array.isArray(artifact.missingDeps) ? artifact.missingDeps : [])].sort(),
    }))
    .sort((a: JsonMap, b: JsonMap) => String(a.id).localeCompare(String(b.id)));
  const core = {
    artifacts,
    applyRequires: [...(Array.isArray(status.applyRequires) ? status.applyRequires : [])].sort(),
  };
  return fingerprint_obj(core);
}

export function get_change_root(status: JsonMap): string {
  if (!status.changeRoot) throw new GuardError("openspec_unavailable: status missing changeRoot");
  return resolve(String(status.changeRoot));
}

export function get_repo_root(status: JsonMap): string {
  const root = isObject(status.planningHome) ? status.planningHome.root : undefined;
  if (root) return resolve(String(root));
  const changeRoot = get_change_root(status);
  const parts = changeRoot.split(sep);
  if (parts.length < 3) throw new GuardError("openspec_unavailable: cannot derive repo root");
  return resolve(changeRoot, "..", "..", "..");
}

export function repo_root_from_cwd(start: string = process.cwd()): string {
  let dir = resolve(start);
  while (true) {
    if (existsSync(join(dir, "openspec", "changes"))) return dir;
    const parent = dirname(dir);
    if (parent === dir) return resolve(start);
    dir = parent;
  }
}
