// Disclosure fixed-point loop (REVIEW_DISCLOSURE_FIXED_POINT_DESIGN.md, Phases 1-3:
// explore_complete, proposal_reviewed, design_complete, invariants_reviewed,
// test_contract_drafted, tasks_complete).
// Material findings (scope / non_goal / acceptance / business_semantics / design_boundary) raised by
// role reviews must reach the user through main_review_digest + user_review_decision evidence; the
// main thread is never allowed to silently close them. Legacy evidence without review_round_id or
// findings[] stays grandfathered: the disclosure checks only activate once round-tagged evidence or
// a digest exists for the gate (P2-3) — except for gates born after the disclosure loop
// (DISCLOSURE_REQUIRED_GATES), which have no legacy population and therefore no grandfather path.
import { existsSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import type { JsonMap, Reason } from "./util.ts";
import { isObject, reason, renderList, repr, runtime, safe_within, toPosix, walkFiles } from "./util.ts";
import { normalize_gate } from "./openspec.ts";

// Explicit target map (design §7); later phases extend this table gate by gate.
// Entries containing "*" are globs enumerated at check time; set equality (P1-6) means a spec
// file added after the digest makes the digest stale even though every pinned blob still matches.
export const REVIEW_TARGETS_BY_GATE: Record<string, string[]> = {
  explore_complete: [".superspec/artifacts/discovery.md"],
  proposal_reviewed: ["proposal.md", ".superspec/artifacts/discovery.md"],
  design_complete: ["proposal.md", "design.md", "specs/**/*.md", ".superspec/artifacts/discovery.md"],
  invariants_reviewed: [".superspec/artifacts/business-invariants.md", "design.md", "specs/**/*.md"],
  test_contract_drafted: [".superspec/artifacts/test-contract.md", ".superspec/artifacts/business-invariants.md", "design.md", "specs/**/*.md"],
  tasks_complete: ["tasks.md", ".superspec/artifacts/test-contract.md", ".superspec/artifacts/business-invariants.md", "design.md", "specs/**/*.md"],
};
// Gates introduced together with (or after) the disclosure loop: round-tagged review evidence plus
// a digest are mandatory, otherwise an agent could file old-style evidence to dodge disclosure.
export const DISCLOSURE_REQUIRED_GATES = new Set(["proposal_reviewed"]);
// Legal disposition routes (design §11, P1-4). The global set bounds the schema; the per-gate
// table bounds which escape hatches a gate may use (e.g. proposal findings that prove discovery
// incomplete must route return_explore, never reopen_tasks).
export const DISCLOSURE_ROUTES = new Set([
  "stay_same_gate_fix",
  "stay_same_gate_user_decision",
  "return_explore",
  "return_explore_or_proposal_reviewed",
  "return_test_contract_drafted",
  "reopen_tasks",
  "change_update",
  "escalate_round_budget",
]);
export const DISCLOSURE_ROUTES_BY_GATE: Record<string, Set<string>> = {
  explore_complete: new Set(["stay_same_gate_fix", "stay_same_gate_user_decision", "escalate_round_budget"]),
  proposal_reviewed: new Set(["stay_same_gate_fix", "stay_same_gate_user_decision", "return_explore", "escalate_round_budget"]),
  design_complete: new Set(["stay_same_gate_fix", "stay_same_gate_user_decision", "return_explore_or_proposal_reviewed", "escalate_round_budget"]),
  invariants_reviewed: new Set(["stay_same_gate_fix", "stay_same_gate_user_decision", "return_explore_or_proposal_reviewed", "escalate_round_budget"]),
  test_contract_drafted: new Set(["stay_same_gate_fix", "stay_same_gate_user_decision", "return_explore_or_proposal_reviewed", "escalate_round_budget"]),
  tasks_complete: new Set(["stay_same_gate_fix", "return_test_contract_drafted", "escalate_round_budget"]),
};
export const MATERIAL_CATEGORIES = new Set(["scope", "non_goal", "acceptance", "business_semantics", "design_boundary"]);
export const FINDING_CATEGORIES = new Set([...MATERIAL_CATEGORIES, "test_gap", "implementation", "evidence", "process"]);
export const FINDING_TYPES = new Set(["blocker", "scope_risk", "open_question", "agent_assumption", "non_blocking_finding"]);
export const FINDING_DISPOSITIONS = new Set(["fixed", "false_positive", "accepted_deviation", "user_decided", "needs_user_decision"]);
export const USER_DECISION_OPTIONS = new Set(["option_a", "option_b", "option_c", "option_d_custom"]);
// R5 round economy: beyond this many full rounds without convergence the loop must escalate.
export const REVIEW_ROUND_BUDGET = 3;

export function review_round_number(gate: string, roundId: string): number | null {
  const match = /^(.+)-r(\d+)$/.exec(roundId);
  if (!match || match[1] !== gate) return null;
  return Number(match[2]);
}

function string_list(value: any): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string" && item.length > 0) : [];
}

function pinned_map(refs: any): Map<string, string> {
  const out = new Map<string, string>();
  for (const item of Array.isArray(refs) ? refs : []) {
    if (isObject(item) && typeof item.path === "string" && item.path) out.set(item.path, String(item.blob_sha ?? ""));
  }
  return out;
}

function non_empty_string(value: any): boolean {
  return typeof value === "string" && value.trim().length > 0;
}

function label(ev: JsonMap): string {
  return String(ev._path ?? ev.evidence_id ?? "evidence");
}

function glob_to_regexp(pattern: string): RegExp {
  // "**/" spans zero or more directory levels; "*" never crosses a slash.
  const sentinel = pattern.replace(/\*\*\//g, "\u0000").replace(/\*/g, "\u0001");
  const escaped = sentinel.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const source = escaped.replace(/\u0000/g, "(?:.*/)?").replace(/\u0001/g, "[^/]*");
  return new RegExp(`^${source}$`);
}

// Enumerates the gate's target set right now: static paths must exist (a missing artifact is the
// gate's own missing_* reason, so we bail to null and skip stale checks); glob entries contribute
// every current match so set equality catches files added after a digest (P1-6).
export function enumerate_review_targets(gate: string, changeRoot: string): Map<string, string> | null {
  const patterns = REVIEW_TARGETS_BY_GATE[normalize_gate(gate)];
  if (!patterns) return null;
  const out = new Map<string, string>();
  for (const pattern of patterns) {
    if (pattern.includes("*")) {
      const matcher = glob_to_regexp(pattern);
      const staticPrefix = pattern.slice(0, pattern.indexOf("*")).replace(/[^/]*$/, "");
      for (const abs of walkFiles(join(changeRoot, staticPrefix))) {
        const rel = toPosix(relative(changeRoot, abs));
        if (matcher.test(rel)) out.set(rel, String(runtime.file_blob_sha(abs)));
      }
    } else {
      const abs = join(changeRoot, pattern);
      if (!existsSync(abs) || !statSync(abs).isFile()) return null;
      out.set(pattern, String(runtime.file_blob_sha(abs)));
    }
  }
  return out;
}

// ── Schema validation (wired into validate_evidence_schema) ─────────────────

// findings[] entries are produced by the reviewer and are the identity source of truth (P0-2).
export function findings_schema_reasons(ev: JsonMap): Reason[] {
  const problems: Reason[] = [];
  const fail = (message: string) => problems.push(reason("review_finding_invalid", `${label(ev)}: ${message}`));
  if (!Array.isArray(ev.findings)) {
    fail("findings must be an array");
    return problems;
  }
  const gate = normalize_gate(String(ev.gate ?? ""));
  if (!non_empty_string(ev.review_round_id) || review_round_number(gate, String(ev.review_round_id)) === null) {
    fail(`evidence carrying findings[] must have review_round_id of the form ${gate}-r<N>`);
  }
  if (ev.acknowledged_accepted_deviation_uids !== undefined && !Array.isArray(ev.acknowledged_accepted_deviation_uids)) {
    fail("acknowledged_accepted_deviation_uids must be a string array");
  }
  for (const [idx, item] of ev.findings.entries()) {
    if (!isObject(item)) {
      fail(`findings[${idx}] must be an object`);
      continue;
    }
    if (!non_empty_string(item.finding_id)) fail(`findings[${idx}] missing finding_id`);
    if (!non_empty_string(item.summary)) fail(`findings[${idx}] missing summary (verbatim disclosure source, P1-1)`);
    if (!FINDING_TYPES.has(String(item.finding_type))) fail(`findings[${idx}] finding_type=${repr(item.finding_type)} not in ${renderList([...FINDING_TYPES].sort())}`);
    if (!FINDING_CATEGORIES.has(String(item.category))) fail(`findings[${idx}] category=${repr(item.category)} not in ${renderList([...FINDING_CATEGORIES].sort())}`);
    const material = item.material_categories;
    if (material !== undefined && !Array.isArray(material)) fail(`findings[${idx}] material_categories must be an array`);
    const materialList = string_list(material);
    for (const cat of materialList) {
      if (!MATERIAL_CATEGORIES.has(cat)) fail(`findings[${idx}] material category ${repr(cat)} not in ${renderList([...MATERIAL_CATEGORIES].sort())}`);
    }
    if (materialList.length > 0 && !non_empty_string(item.decision_scope_key)) fail(`findings[${idx}] material finding requires decision_scope_key`);
    const expectedUid = `${gate}:${ev.evidence_id}:${item.finding_id}`;
    if (String(item.finding_uid ?? "") !== expectedUid) fail(`findings[${idx}] finding_uid must equal ${expectedUid}`);
    if (item.supersedes_finding_uids !== undefined && !Array.isArray(item.supersedes_finding_uids)) fail(`findings[${idx}] supersedes_finding_uids must be a string array`);
  }
  return problems;
}

export function review_digest_schema_reasons(ev: JsonMap): Reason[] {
  const problems: Reason[] = [];
  const fail = (message: string) => problems.push(reason("review_digest_invalid", `${label(ev)}: ${message}`));
  const gate = normalize_gate(String(ev.gate ?? ""));
  // design §8: review_complete uses main_adjudication as its disclosure carrier, never a second digest.
  if (gate === "review_complete") fail("main_review_digest is forbidden on review_complete; main_adjudication is the final-review disclosure carrier");
  if (String(ev.created_by ?? "") !== "main-thread") fail("main_review_digest must be created_by main-thread");
  if (ev.agent_role !== undefined) fail("main_review_digest is a main-thread artifact and must not carry agent_role");
  if (!non_empty_string(ev.review_round_id) || review_round_number(gate, String(ev.review_round_id)) === null) {
    fail(`review_round_id must be of the form ${gate}-r<N>`);
  }
  const pins = pinned_map(ev.target_refs);
  if (!Array.isArray(ev.target_refs) || pins.size === 0 || pins.size !== ev.target_refs.length || [...pins.values()].some((sha) => !sha)) {
    fail("target_refs must be a non-empty list of {path, blob_sha} pins");
  }
  if (string_list(ev.source_review_evidence_refs).length === 0) fail("source_review_evidence_refs must reference every role review of this round");
  if (!Array.isArray(ev.previous_digest_refs)) fail("previous_digest_refs must be an array (empty only for round 1)");
  if (!Array.isArray(ev.finding_dispositions)) {
    fail("finding_dispositions must be an array");
    return problems;
  }
  let pending = false;
  for (const [idx, item] of ev.finding_dispositions.entries()) {
    if (!isObject(item)) {
      fail(`finding_dispositions[${idx}] must be an object`);
      continue;
    }
    for (const field of ["finding_id", "finding_uid", "origin_review_evidence_id", "summary", "rationale", "route", "route_reason"]) {
      if (!non_empty_string(item[field])) fail(`finding_dispositions[${idx}] missing ${field}`);
    }
    if (non_empty_string(item.route) && !DISCLOSURE_ROUTES.has(String(item.route))) {
      fail(`finding_dispositions[${idx}] route=${repr(item.route)} not in ${renderList([...DISCLOSURE_ROUTES].sort())}`);
    }
    if (!FINDING_TYPES.has(String(item.finding_type))) fail(`finding_dispositions[${idx}] finding_type=${repr(item.finding_type)} invalid`);
    if (!FINDING_CATEGORIES.has(String(item.category))) fail(`finding_dispositions[${idx}] category=${repr(item.category)} invalid`);
    const materialList = string_list(item.material_categories);
    if (materialList.some((cat) => !MATERIAL_CATEGORIES.has(cat))) fail(`finding_dispositions[${idx}] material_categories outside ${renderList([...MATERIAL_CATEGORIES].sort())}`);
    if (materialList.length > 0 && !non_empty_string(item.decision_scope_key)) fail(`finding_dispositions[${idx}] material disposition requires decision_scope_key`);
    const disposition = String(item.disposition ?? "");
    if (!FINDING_DISPOSITIONS.has(disposition)) {
      fail(`finding_dispositions[${idx}] disposition=${repr(item.disposition)} not in ${renderList([...FINDING_DISPOSITIONS].sort())}`);
      continue;
    }
    // per-disposition proof shape (design §4.2 proof table)
    if (disposition === "fixed" && string_list(item.artifact_update_refs).length === 0 && string_list(item.evidence_refs).length === 0) {
      fail(`finding_dispositions[${idx}] fixed requires artifact_update_refs or evidence_refs`);
    }
    if (disposition === "false_positive" && (!Array.isArray(item.source_refs) || item.source_refs.length === 0)) {
      fail(`finding_dispositions[${idx}] false_positive requires source_refs`);
    }
    if (disposition === "user_decided" && string_list(item.user_decision_refs).length === 0) {
      fail(`finding_dispositions[${idx}] user_decided requires user_decision_refs`);
    }
    if (disposition === "needs_user_decision") pending = true;
  }
  if (pending && ev.status === "pass") fail("digest with needs_user_decision dispositions must have status blocked, not pass");
  return problems;
}

export function user_decision_schema_reasons(ev: JsonMap): Reason[] {
  const problems: Reason[] = [];
  const fail = (message: string) => problems.push(reason("user_decision_invalid", `${label(ev)}: ${message}`));
  const gate = normalize_gate(String(ev.gate ?? ""));
  if (String(ev.created_by ?? "") !== "user") fail("user_review_decision must be created_by user");
  if (!USER_DECISION_OPTIONS.has(String(ev.decision))) fail(`decision=${repr(ev.decision)} not in ${renderList([...USER_DECISION_OPTIONS].sort())}`);
  if (string_list(ev.finding_uids).length === 0) fail("finding_uids must name the exact finding_uid(s) being decided");
  if (!non_empty_string(ev.decision_scope_key)) fail("decision_scope_key is required");
  if (ev.material_categories !== undefined && string_list(ev.material_categories).some((cat) => !MATERIAL_CATEGORIES.has(cat))) {
    fail(`material_categories outside ${renderList([...MATERIAL_CATEGORIES].sort())}`);
  }
  if (pinned_map(ev.confirmed_refs).size === 0) fail("confirmed_refs must pin the artifact blob the user confirmed");
  if (!non_empty_string(ev.review_round_id) || review_round_number(gate, String(ev.review_round_id)) === null) {
    fail(`review_round_id must be of the form ${gate}-r<N>`);
  }
  if (String(ev.decision) === "option_d_custom") {
    // D is a first-class disposition, not a free-text note (design §4.3).
    if (!non_empty_string(ev.user_text)) fail("option_d_custom requires user_text with the user's verbatim words");
    const structured = ev.structured_decision;
    if (!isObject(structured)) {
      fail("option_d_custom requires structured_decision");
    } else {
      for (const field of ["scope", "non_goals", "acceptance_impact", "test_impact"]) {
        if (!Array.isArray(structured[field])) fail(`structured_decision.${field} must be an array (empty when unaffected)`);
      }
      for (const field of ["requires_artifact_update", "requires_rereview"]) {
        if (typeof structured[field] !== "boolean") fail(`structured_decision.${field} must be a boolean`);
      }
    }
  }
  return problems;
}

export function standing_authorization_schema_reasons(ev: JsonMap): Reason[] {
  const problems: Reason[] = [];
  const fail = (message: string) => problems.push(reason("standing_authorization_invalid", `${label(ev)}: ${message}`));
  if (String(ev.created_by ?? "") !== "user") fail("review_standing_authorization must be created_by user; the main thread can never grant itself authority");
  if (!non_empty_string(ev.confirmation_text)) fail("confirmation_text is required");
  const allowed = string_list(ev.allowed_categories);
  if (!Array.isArray(ev.allowed_categories) || allowed.length === 0) fail("allowed_categories must be a non-empty explicit list");
  if (!Array.isArray(ev.excluded_categories)) fail("excluded_categories must be an explicit array (empty allowed)");
  const excluded = string_list(ev.excluded_categories);
  for (const cat of [...allowed, ...excluded]) {
    if (!FINDING_CATEGORIES.has(cat)) fail(`category ${repr(cat)} not in ${renderList([...FINDING_CATEGORIES].sort())}`);
  }
  const overlap = allowed.filter((cat) => excluded.includes(cat));
  if (overlap.length > 0) fail(`allowed/excluded categories conflict on ${renderList(overlap.sort())}; excluded wins, fix the authorization`);
  if (string_list(ev.valid_gates).length === 0) fail("valid_gates must be a non-empty list");
  if (ev.expires_at !== undefined && ev.expires_at !== null && (!non_empty_string(ev.expires_at) || Number.isNaN(Date.parse(String(ev.expires_at))))) {
    fail(`expires_at must be null or a parseable timestamp: ${repr(ev.expires_at)}`);
  }
  return problems;
}

// ── Append-only finding ledger (design §5) ──────────────────────────────────

export type LedgerEntry = {
  uid: string;
  finding_id: string;
  origin: string;
  round: number;
  finding_type: string;
  category: string;
  material: string[];
  scope_key: string;
  summary: string;
  mandatory: boolean;
  superseded_by: string | null;
  disposition: JsonMap | null;
  disposition_round: number;
};

// Scans ALL evidence (including superseded) so finding history can never disappear;
// dispositions come from every digest, latest round wins (live beats superseded within a round).
export function build_finding_ledger(gate: string, evidences: JsonMap[], beforeRound = Number.POSITIVE_INFINITY): LedgerEntry[] {
  const gateNorm = normalize_gate(gate);
  const gateEvs = evidences.filter((ev) => isObject(ev) && !ev._invalid && normalize_gate(String(ev.gate ?? "")) === gateNorm);
  const entries = new Map<string, LedgerEntry>();
  const supersededBy = new Map<string, string>();
  for (const ev of gateEvs) {
    if (!Array.isArray(ev.findings)) continue;
    const round = review_round_number(gateNorm, String(ev.review_round_id ?? "")) ?? 1;
    if (round >= beforeRound) continue;
    for (const item of ev.findings) {
      if (!isObject(item)) continue;
      const material = string_list(item.material_categories);
      const uid = String(item.finding_uid ?? `${gateNorm}:${ev.evidence_id}:${item.finding_id}`);
      if (!entries.has(uid)) {
        entries.set(uid, {
          uid,
          finding_id: String(item.finding_id ?? ""),
          origin: String(ev.evidence_id ?? ""),
          round,
          finding_type: String(item.finding_type ?? ""),
          category: String(item.category ?? ""),
          material,
          scope_key: String(item.decision_scope_key ?? ""),
          summary: String(item.summary ?? ""),
          mandatory: String(item.finding_type) === "blocker" || material.length > 0,
          superseded_by: null,
          disposition: null,
          disposition_round: 0,
        });
      }
      for (const oldUid of string_list(item.supersedes_finding_uids)) supersededBy.set(oldUid, uid);
    }
  }
  const orderedDigests = gateEvs
    .filter((ev) => ev.kind === "main_review_digest")
    .map((dg) => ({ dg, round: review_round_number(gateNorm, String(dg.review_round_id ?? "")) ?? 1 }))
    .filter(({ round }) => round < beforeRound)
    .sort((a, b) => (a.round - b.round) || ((a.dg.status === "superseded" ? 0 : 1) - (b.dg.status === "superseded" ? 0 : 1)));
  for (const { dg, round } of orderedDigests) {
    for (const item of Array.isArray(dg.finding_dispositions) ? dg.finding_dispositions : []) {
      if (!isObject(item) || typeof item.finding_uid !== "string") continue;
      const entry = entries.get(item.finding_uid);
      if (entry) {
        entry.disposition = item;
        entry.disposition_round = round;
      }
    }
  }
  for (const [oldUid, successor] of supersededBy) {
    const entry = entries.get(oldUid);
    if (entry && entries.has(successor)) entry.superseded_by = successor;
  }
  return [...entries.values()].sort((a, b) => a.uid.localeCompare(b.uid));
}

// Deterministic render injected into round k>1 reviewer prompts; the guard byte-compares it (R3).
export function render_finding_ledger(gate: string, entries: LedgerEntry[]): string {
  const lines = [`[SUPERSPEC-FINDING-LEDGER gate=${normalize_gate(gate)} findings=${entries.length}]`];
  for (const entry of entries) {
    const disposition = entry.superseded_by
      ? `superseded_by=${entry.superseded_by}`
      : entry.disposition
        ? String(entry.disposition.disposition ?? "unknown")
        : "open";
    lines.push(`- ${entry.uid} | type=${entry.finding_type} | category=${entry.category} | material=[${entry.material.join(",")}] | disposition=${disposition} | ${entry.summary}`);
  }
  lines.push("[/SUPERSPEC-FINDING-LEDGER]");
  return lines.join("\n");
}

// ── Cross-evidence binding checks ───────────────────────────────────────────

function user_decision_binding_reasons(gate: string, entry: LedgerEntry, disp: JsonMap, refId: string, byId: Map<string, JsonMap>): Reason[] {
  const fail = (why: string) => [reason("user_decision_unbound", `${gate}: ${entry.uid}: user decision ${refId} ${why}`, [entry.uid, refId])];
  const target = byId.get(refId);
  if (!target) return fail("does not exist");
  if (target.kind !== "user_review_decision") return fail(`is kind ${repr(target.kind)}, not user_review_decision`);
  if (String(target.created_by ?? "") !== "user") return fail("must be created_by user");
  if (target.status !== "pass") return fail(`must be status pass, got ${repr(target.status)}`);
  if (!string_list(target.finding_uids).includes(entry.uid)) return fail("does not name this finding_uid (bare finding_id matching is insufficient)");
  if (entry.scope_key && String(target.decision_scope_key ?? "") !== entry.scope_key) return fail(`decision_scope_key ${repr(target.decision_scope_key)} does not match the finding (${entry.scope_key})`);
  const decidedMaterial = new Set(string_list(target.material_categories));
  if (!entry.material.every((cat) => decidedMaterial.has(cat))) return fail("does not cover every material category of the finding");
  const decisionRound = review_round_number(gate, String(target.review_round_id ?? ""));
  if (decisionRound !== null && decisionRound < entry.round) return fail("belongs to an earlier round than the origin finding (structural ordering, P2-1)");
  // The user must have confirmed the exact artifact version the origin review pinned.
  const originPins = pinned_map(byId.get(entry.origin)?.target_refs);
  const confirmed = pinned_map(target.confirmed_refs);
  let pinOk = confirmed.size > 0;
  for (const [path, sha] of confirmed) {
    if (originPins.size > 0 && originPins.has(path) && originPins.get(path) !== sha) pinOk = false;
  }
  if (!pinOk) return fail("confirmed_refs must pin the artifact blob the origin review saw");
  const problems: Reason[] = [];
  if (String(target.decision) === "option_d_custom" && isObject(target.structured_decision)) {
    const structured = target.structured_decision;
    if (structured.requires_artifact_update === true && string_list(disp.artifact_update_refs).length === 0) {
      problems.push(reason("artifact_update_required", `${gate}: ${entry.uid}: user decision ${refId} requires an artifact update; the consuming disposition must cite artifact_update_refs`, [entry.uid, refId]));
    }
    if (structured.requires_rereview === true && (decisionRound === null || entry.disposition_round <= decisionRound)) {
      problems.push(reason("rereview_required", `${gate}: ${entry.uid}: user decision ${refId} requires a re-review; the consuming digest round must be structurally later than the decision round (P2-1)`, [entry.uid, refId]));
    }
  }
  return problems;
}

function standing_authorization_binding_reasons(gate: string, entry: LedgerEntry, refId: string, byId: Map<string, JsonMap>): Reason[] {
  const fail = (why: string) => [reason("standing_authorization_unbound", `${gate}: ${entry.uid}: standing authorization ${refId} ${why}`, [entry.uid, refId])];
  const target = byId.get(refId);
  if (!target) return fail("does not exist");
  if (target.kind !== "review_standing_authorization") return fail(`is kind ${repr(target.kind)}, not review_standing_authorization`);
  if (String(target.created_by ?? "") !== "user") return fail("must be created_by user");
  if (target.status !== "pass") return fail(`must be status pass, got ${repr(target.status)}`);
  if (entry.finding_type === "blocker") return fail("can never cover a blocker; blockers need a fix or an explicit user decision");
  if (!string_list(target.valid_gates).includes(gate)) return fail(`does not list ${gate} in valid_gates`);
  const allowed = new Set(string_list(target.allowed_categories));
  for (const cat of string_list(target.excluded_categories)) allowed.delete(cat);
  if (!allowed.has(entry.category)) return fail(`does not allow category ${repr(entry.category)} (excluded wins over allowed; generic confirmation text grants nothing)`);
  if (!entry.material.every((cat) => allowed.has(cat))) return fail("does not allow every material category of the finding");
  if (target.expires_at !== undefined && target.expires_at !== null) {
    const ts = Date.parse(String(target.expires_at));
    if (Number.isNaN(ts) || ts <= Date.now()) return fail(`expired at ${repr(target.expires_at)}`);
  }
  return [];
}

// ── Gate-level disclosure check (design §6, review_disclosure_complete) ─────

export function review_disclosure_reasons(gate: string, changeRoot: string, evidences: JsonMap[]): Reason[] {
  const targetPaths = REVIEW_TARGETS_BY_GATE[gate];
  if (!targetPaths) return [];
  const valid = evidences.filter((ev) => isObject(ev) && !ev._invalid);
  const gateEvs = valid.filter((ev) => normalize_gate(String(ev.gate ?? "")) === gate);
  const reviews = gateEvs.filter((ev) => Boolean(ev.agent_role) && (ev.review_round_id !== undefined || Array.isArray(ev.findings)));
  const digests = gateEvs.filter((ev) => ev.kind === "main_review_digest");
  // Grandfathering (P2-3): changes whose review evidence predates the disclosure loop keep the
  // legacy judgment; new round-tagged evidence or any digest switches the full check on.
  // Gates born after the loop have no legacy population, so the loop is unconditionally required.
  if (reviews.length === 0 && digests.length === 0) {
    if (!DISCLOSURE_REQUIRED_GATES.has(gate)) return [];
    return [reason("missing_review_digest", `${gate}: the disclosure loop is mandatory on this gate; need round-tagged role review evidence (review_round_id ${gate}-r1, findings[]) plus a main_review_digest`)];
  }
  const out: Reason[] = [];
  const dead = new Set(valid.filter((ev) => ev.status === "superseded" && ev.supersedes).map((ev) => String(ev.supersedes)));
  const byId = new Map<string, JsonMap>();
  for (const ev of valid) {
    if (typeof ev.evidence_id === "string" && ev.evidence_id) byId.set(ev.evidence_id, ev);
  }

  // Round continuity (§5 rule 8): <gate>-r1..rN with no gaps, judged over ALL evidence so a
  // deleted middle round cannot hide.
  const roundNumbers = new Set<number>();
  let malformedRound = false;
  for (const ev of [...reviews, ...digests]) {
    const num = review_round_number(gate, String(ev.review_round_id ?? ""));
    if (num === null) {
      malformedRound = true;
      out.push(reason("review_round_discontinuous", `${label(ev)}: review_round_id must be of the form ${gate}-r<N>: ${repr(ev.review_round_id)}`));
    } else {
      roundNumbers.add(num);
    }
  }
  const latestRound = roundNumbers.size > 0 ? Math.max(...roundNumbers) : 0;
  if (!malformedRound && latestRound > 0) {
    const missing: string[] = [];
    for (let k = 1; k <= latestRound; k++) {
      if (!roundNumbers.has(k)) missing.push(`${gate}-r${k}`);
    }
    if (missing.length > 0) out.push(reason("review_round_discontinuous", `${gate}: review rounds must be continuous r1..r${latestRound}; missing ${renderList(missing)}`, missing));
  }

  // Digest chain (previous_digest_refs) must link every digest round to its predecessor.
  const digestsByRound = new Map<number, JsonMap[]>();
  for (const dg of digests) {
    const num = review_round_number(gate, String(dg.review_round_id ?? ""));
    if (num === null) continue;
    digestsByRound.set(num, [...(digestsByRound.get(num) ?? []), dg]);
  }
  for (const [num, list] of [...digestsByRound.entries()].sort((a, b) => a[0] - b[0])) {
    if (num <= 1) continue;
    const prevIds = new Set((digestsByRound.get(num - 1) ?? []).map((dg) => String(dg.evidence_id)));
    for (const dg of list) {
      const refs = string_list(dg.previous_digest_refs);
      if (prevIds.size === 0) {
        out.push(reason("digest_chain_broken", `${label(dg)}: round ${num} digest has no round ${num - 1} digest to chain to`));
      } else if (!refs.some((id) => prevIds.has(id))) {
        out.push(reason("digest_chain_broken", `${label(dg)}: previous_digest_refs must include the round ${num - 1} digest (${renderList([...prevIds].sort())})`));
      }
    }
  }

  // Lazy stale check (R1) with set equality (P1-6): pinned set must equal the currently
  // enumerated target set (globs expanded), path by path and blob by blob.
  const currentSet = enumerate_review_targets(gate, changeRoot);
  const setMatches = (refs: any): boolean => {
    if (currentSet === null) return true;
    const pinned = pinned_map(refs);
    if (pinned.size !== currentSet.size) return false;
    for (const [rel, sha] of currentSet) {
      if (pinned.get(rel) !== sha) return false;
    }
    return true;
  };

  const liveReviews = reviews.filter((ev) => ev.status === "pass" && !dead.has(String(ev.evidence_id)));
  for (const ev of liveReviews) {
    if (!setMatches(ev.target_refs)) {
      out.push(reason("review_round_stale", `${label(ev)}: live ${gate} review must pin the current target set (${renderList(targetPaths)}); supersede it and run a new round`));
    }
  }

  // The latest round needs a live digest: that digest IS the user-visible disclosure.
  const latestDigests = (digestsByRound.get(latestRound) ?? []).filter((dg) => !dead.has(String(dg.evidence_id)) && (dg.status === "pass" || dg.status === "blocked"));
  const latestDigest = latestDigests.find((dg) => dg.status === "pass") ?? latestDigests[0] ?? null;
  const latestRoundReviews = liveReviews.filter((ev) => review_round_number(gate, String(ev.review_round_id ?? "")) === latestRound);
  if (latestRound > 0 && !latestDigest) {
    out.push(reason("missing_review_digest", `${gate}: round ${gate}-r${latestRound} has no live main_review_digest; findings must be disclosed to the user before the gate can pass`));
  }
  if (latestDigest) {
    if (!setMatches(latestDigest.target_refs)) {
      out.push(reason("review_digest_stale", `${label(latestDigest)}: digest target_refs must equal the current target set (${renderList(targetPaths)})`));
    }
    const dispositionUids = new Set(
      (Array.isArray(latestDigest.finding_dispositions) ? latestDigest.finding_dispositions : [])
        .filter(isObject)
        .map((item) => String(item.finding_uid ?? "")),
    );
    const sourceRefs = new Set(string_list(latestDigest.source_review_evidence_refs));
    for (const ev of latestRoundReviews) {
      if (!sourceRefs.has(String(ev.evidence_id))) {
        out.push(reason("review_digest_invalid", `${label(latestDigest)}: digest must reference round ${latestRound} review ${ev.evidence_id} in source_review_evidence_refs`));
      }
      for (const item of Array.isArray(ev.findings) ? ev.findings : []) {
        if (!isObject(item)) continue;
        const uid = String(item.finding_uid ?? "");
        if (!dispositionUids.has(uid)) {
          out.push(reason("finding_undisclosed", `${label(latestDigest)}: finding ${uid} from ${ev.evidence_id} has no disposition in the round ${latestRound} digest`, [uid]));
        }
      }
    }
  }

  // Append-only ledger closure: every mandatory finding in history needs a terminal disposition
  // with user anchors for material findings (rules 6-11).
  const ledger = build_finding_ledger(gate, evidences);
  const ledgerUids = new Set(ledger.map((entry) => entry.uid));
  const acceptedMaterialUids: string[] = [];
  for (const entry of ledger) {
    if (entry.superseded_by) continue;
    const disp = entry.disposition;
    if (!disp) {
      if (entry.mandatory) {
        out.push(reason("finding_unresolved", `${gate}: ${entry.uid} (${entry.finding_type}) has no terminal disposition in any main_review_digest; history cannot be erased by a clean rerun`, [entry.uid]));
      }
      continue;
    }
    const dispositionKind = String(disp.disposition ?? "");
    if (dispositionKind === "needs_user_decision") {
      out.push(reason("needs_user_decision_pending", `${gate}: ${entry.uid} is waiting for the user's A/B/C/D decision; the main thread must stop and disclose, not self-resolve`, [entry.uid]));
      continue;
    }
    // Disposition identity consistency (P0-2): classification belongs to the reviewer.
    const mismatches: string[] = [];
    if (String(disp.finding_type ?? "") !== entry.finding_type) mismatches.push("finding_type");
    if (String(disp.category ?? "") !== entry.category) mismatches.push("category");
    const dispMaterial = string_list(disp.material_categories);
    if (dispMaterial.slice().sort().join(",") !== entry.material.slice().sort().join(",")) mismatches.push("material_categories");
    if (entry.material.length > 0 && String(disp.decision_scope_key ?? "") !== entry.scope_key) mismatches.push("decision_scope_key");
    if (mismatches.length > 0) {
      out.push(reason("finding_identity_mismatch", `${gate}: disposition for ${entry.uid} rewrites ${renderList(mismatches)}; identity fields must match the origin finding verbatim (P0-2)`, [entry.uid]));
    }
    if (entry.material.length > 0 && String(disp.summary ?? "") !== entry.summary) {
      out.push(reason("finding_summary_not_verbatim", `${gate}: material disposition for ${entry.uid} must copy the origin finding summary verbatim so the user sees the reviewer's words (P1-1)`, [entry.uid]));
    }
    if (dispositionKind === "accepted_deviation" && entry.material.length > 0) acceptedMaterialUids.push(entry.uid);
    const decisionRefs = string_list(disp.user_decision_refs);
    const authRefs = string_list(disp.standing_authorization_refs);
    const baselineRefs = string_list(disp.baseline_decision_refs);
    if (entry.material.length > 0 && decisionRefs.length === 0 && authRefs.length === 0 && baselineRefs.length === 0) {
      out.push(reason("user_decision_unbound", `${gate}: material finding ${entry.uid} (${dispositionKind}) must cite user_decision_refs, standing_authorization_refs, or baseline_decision_refs; the main thread cannot close material findings on its own`, [entry.uid]));
    }
    for (const refId of decisionRefs) out.push(...user_decision_binding_reasons(gate, entry, disp, refId, byId));
    for (const refId of authRefs) out.push(...standing_authorization_binding_reasons(gate, entry, refId, byId));
    for (const refId of baselineRefs) {
      const target = byId.get(refId);
      if (!target || String(target.created_by ?? "") !== "user") {
        out.push(reason("user_decision_unbound", `${gate}: ${entry.uid}: baseline decision ${refId} must resolve to user-created evidence`, [entry.uid, refId]));
      }
    }
  }
  // Digests must not dispose findings that never existed in any review, and every disposition
  // route must be legal for this gate (P1-4): e.g. a proposal finding proving discovery is
  // incomplete must route return_explore instead of being patched in place.
  const legalRoutes = DISCLOSURE_ROUTES_BY_GATE[gate];
  for (const dg of digests) {
    for (const item of Array.isArray(dg.finding_dispositions) ? dg.finding_dispositions : []) {
      if (!isObject(item)) continue;
      if (typeof item.finding_uid === "string" && item.finding_uid && !ledgerUids.has(item.finding_uid)) {
        out.push(reason("review_digest_invalid", `${label(dg)}: disposition references unknown finding_uid ${item.finding_uid}`, [item.finding_uid]));
      }
      const route = String(item.route ?? "");
      if (legalRoutes && route && !legalRoutes.has(route)) {
        out.push(reason("finding_route_invalid", `${label(dg)}: route ${repr(route)} is not legal on ${gate}; allowed routes: ${renderList([...legalRoutes].sort())}`, [String(item.finding_uid ?? "")]));
      }
    }
  }

  // Accepted material deviations must be re-acknowledged by the clean round (P1-2).
  if (acceptedMaterialUids.length > 0) {
    for (const ev of latestRoundReviews) {
      const acked = new Set(string_list(ev.acknowledged_accepted_deviation_uids));
      const missing = acceptedMaterialUids.filter((uid) => !acked.has(uid)).sort();
      if (missing.length > 0) {
        out.push(reason("accepted_deviation_unacknowledged", `${label(ev)}: clean-round review must list accepted deviations ${renderList(missing)} in acknowledged_accepted_deviation_uids (P1-2)`, missing));
      }
    }
  }

  // Re-review prompt injection (R3): round k>1 prompts must embed the tool-rendered ledger.
  if (latestRound > 1) {
    const expected = render_finding_ledger(gate, build_finding_ledger(gate, evidences, latestRound));
    for (const ev of latestRoundReviews) {
      const promptRel = typeof ev.prompt_ref === "string" ? ev.prompt_ref : "";
      const promptAbs = promptRel ? safe_within(changeRoot, promptRel) : null;
      const content = promptAbs && existsSync(promptAbs) && statSync(promptAbs).isFile() ? readFileSync(promptAbs, "utf8") : "";
      if (!content.includes(expected)) {
        out.push(reason("ledger_injection_missing", `${label(ev)}: round ${latestRound} prompt must embed the tool-rendered finding ledger for rounds < ${latestRound} (R3); regenerate the prompt via render_finding_ledger`));
      }
    }
  }

  // A blocked digest with nothing pending is a bookkeeping contradiction; fail closed.
  if (latestDigest && latestDigest.status !== "pass" && out.length === 0) {
    out.push(reason("review_digest_invalid", `${label(latestDigest)}: digest status is ${repr(latestDigest.status)} but no findings are pending; re-issue the digest with status pass`));
  }

  // Round budget (R5): beyond the budget the only legal route is escalation to the user.
  if (latestRound > REVIEW_ROUND_BUDGET && out.length > 0) {
    out.push(reason("round_budget_exhausted", `${gate}: ${latestRound} review rounds exceed the budget of ${REVIEW_ROUND_BUDGET} without convergence; route=escalate_round_budget — stop iterating and put the open findings in front of the user`));
  }
  return out;
}
