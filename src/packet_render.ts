import { existsSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { load_config, sidecar_business_invariants_path, sidecar_discovery_path, sidecar_test_contract_path } from "./paths.ts";
import { type ParsedArgs } from "./cli_args.ts";
import type { PacketDispatchResult, ReviewPacket, WorkflowPacket, PinnedRef, FindingSelector, DecisionSelector } from "./packet_schema.ts";
import {
  CLAIM_ADJUDICATION_DECISIONS,
  FINDING_ADJUDICATION_DECISIONS,
  fingerprint_obj,
  GuardError,
  MAIN_ADJUDICATION_REQUIRED_FIELDS,
  MAIN_ADJUDICATION_DECISIONS,
  REQUEST_CHANGES_ROUTES,
  REVIEW_EVIDENCE_REQUIRED_FIELDS,
  ROLE_EVIDENCE_FIELDS,
  SOURCE_GUIDANCE_REQUIRED_FIELDS,
  VERIFY_EVIDENCE_REQUIRED_FIELDS,
  allow,
  block,
  deepEqual,
  isObject,
  reason,
  renderList,
  runtime,
  safe_within,
  sha256_text,
  type JsonMap,
  type Reason,
} from "./util.ts";
import {
  artifact_status_map,
  gate_route_phase,
  get_change_root,
  get_repo_root,
  normalize_gate,
  openspec_status,
  openspec_status_shape_reasons,
} from "./openspec.ts";
import {
  build_finding_ledger,
  enumerate_review_targets,
  render_finding_ledger,
  REVIEW_TARGETS_BY_GATE,
  review_round_number,
} from "./disclosure.ts";
import {
  evidence_schema_guard,
  check_apply_ready,
  check_archive_ready,
  check_review_complete,
  check_superspec_gate,
  check_task_complete,
  check_task_edit,
  check_task_reopen,
} from "./gates.ts";
import { final_verification_evidences, index_evidence, live_pass, live_user_confirmations } from "./evidence.ts";
import { file_blob_sha, dirty_worktree_paths } from "./git.ts";
import { preset_upgrade_reasons, preset_upgrade_required_from_context } from "./archive.ts";
import { state_corrupt_reasons, state_stale_reasons } from "./state.ts";
import { parse_tasks, resolve_test_contract_command, splitList, test_contract_invariant_refs_by_test } from "./tasks.ts";
import {
  APPLY_CODE_REVIEW_REPORT_REQUIRED_FIELDS,
  APPLY_EXECUTOR_REPORT_REQUIRED_FIELDS,
  APPLY_TEST_RUNNER_REPORT_REQUIRED_FIELDS,
  APPLY_VERIFIER_REPORT_REQUIRED_FIELDS,
  apply_worker_implementation_fingerprint,
  apply_worker_executor_input_ref_digest,
  apply_worker_protected_path_refs,
  compute_apply_worker_freshness,
  fingerprint_digest,
  fingerprint_matches,
  pinned_artifact_ref_reasons as shared_pinned_artifact_ref_reasons,
  pre_edit_evidence_ref_reasons,
  read_pinned_artifact_json,
  worker_input_ref_digest,
  worker_test_run_reasons,
} from "./apply_worker_chain.ts";
import { apply_worker_chain_lifecycle_state } from "./apply_worker_chain_lifecycle.ts";

type PacketContext = {
  change: string;
  status: JsonMap;
  repoRoot: string;
  changeRoot: string;
  evidences: JsonMap[];
};

function load_packet_context(change: string): PacketContext {
  if (typeof runtime.load_context === "function") {
    const [status, repoRoot, changeRoot, evidences] = runtime.load_context(change) as [JsonMap, string, string, JsonMap[]];
    return { change, status, repoRoot, changeRoot, evidences };
  }
  const status = openspec_status(change);
  return {
    change,
    repoRoot: get_repo_root(status),
    changeRoot: get_change_root(status),
    evidences: index_evidence(get_change_root(status)),
    status,
  };
}

function change_pinned_ref(changeRoot: string, relPath: string): PinnedRef | null {
  const absPath = join(changeRoot, relPath);
  if (!existsSync(absPath) || !statSync(absPath).isFile()) return null;
  return { root: "change", path: relPath, blob_sha: file_blob_sha(absPath) };
}

function repo_pinned_ref(repoRoot: string, relPath: string): PinnedRef | null {
  const absPath = join(repoRoot, relPath);
  if (!existsSync(absPath) || !statSync(absPath).isFile()) return null;
  return { root: "repo", path: relPath, blob_sha: file_blob_sha(absPath) };
}

function collect_change_refs(changeRoot: string, relPaths: string[]): PinnedRef[] {
  const refs: PinnedRef[] = [];
  for (const relPath of relPaths) {
    const ref = change_pinned_ref(changeRoot, relPath);
    if (ref) refs.push(ref);
  }
  return refs;
}

function collect_repo_refs(repoRoot: string, relPaths: string[]): PinnedRef[] {
  const refs: PinnedRef[] = [];
  for (const relPath of relPaths) {
    const ref = repo_pinned_ref(repoRoot, relPath);
    if (ref) refs.push(ref);
  }
  return refs;
}

function unique_pinned_refs(refs: PinnedRef[]): PinnedRef[] {
  const seen = new Set<string>();
  const out: PinnedRef[] = [];
  for (const ref of refs) {
    const key = `${ref.root}\u0000${ref.path}\u0000${ref.blob_sha}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(ref);
  }
  return out;
}

function unique_strings(items: string[]): string[] {
  return [...new Set(items.filter(Boolean))];
}

function evidence_pinned_ref(root: "repo" | "change", item: JsonMap): PinnedRef | null {
  if (!isObject(item)) return null;
  if (typeof item.path !== "string" || !item.path) return null;
  if (typeof item.blob_sha !== "string" || !item.blob_sha) return null;
  return { root, path: item.path, blob_sha: item.blob_sha };
}

function dirty_repo_refs(ctx: PacketContext, reason: string): PinnedRef[] {
  try {
    const dirtyPaths = typeof runtime.dirty_worktree_paths === "function"
      ? runtime.dirty_worktree_paths(ctx.repoRoot) as string[]
      : dirty_worktree_paths(ctx.repoRoot);
    return collect_repo_refs(ctx.repoRoot, dirtyPaths);
  } catch (err) {
    throw new GuardError(`${reason}: ${(err as Error).message}`);
  }
}

function packet_data_problems(ctx: PacketContext): Reason[] {
  const { change, status, repoRoot, changeRoot, evidences } = ctx;
  const [config, configProblems] = load_config(repoRoot, changeRoot);
  const shapeProblems = openspec_status_shape_reasons(status);
  const evidenceProblems = evidence_schema_guard(change, changeRoot, repoRoot, evidences);
  const changedPaths = String(config.preset ?? "full") !== "full"
    ? (typeof runtime.dirty_worktree_paths === "function" ? runtime.dirty_worktree_paths(repoRoot) as string[] : dirty_worktree_paths(repoRoot))
    : [];
  const presetRequired = preset_upgrade_required_from_context(config, changedPaths);
  const presetHumanConfirmed = live_user_confirmations(evidences, "preset_upgrade").length > 0;
  const presetProblems = preset_upgrade_reasons(config, changedPaths, presetHumanConfirmed);
  return [
    ...shapeProblems,
    ...configProblems,
    ...evidenceProblems,
    ...state_corrupt_reasons(changeRoot),
    ...state_stale_reasons(changeRoot, status),
    ...(presetRequired ? presetProblems : presetProblems),
  ];
}

function packet_contract_problems(ctx: PacketContext): Reason[] {
  const { change, status, repoRoot, changeRoot, evidences } = ctx;
  const [, configProblems] = load_config(repoRoot, changeRoot);
  const shapeProblems = openspec_status_shape_reasons(status);
  const evidenceProblems = evidence_schema_guard(change, changeRoot, repoRoot, evidences);
  return [...shapeProblems, ...configProblems, ...evidenceProblems];
}

function assert_packet_context_clean(ctx: PacketContext): void {
  const problems = packet_contract_problems(ctx);
  if (problems.length === 0) return;
  throw new GuardError(problems[0].message);
}

function apply_data_problems(change: string, decision: JsonMap, dataProblems: Reason[]): JsonMap {
  if (dataProblems.length === 0) return decision;
  if (decision.allowed) {
    return block(change, String(decision.gate ?? "guard_error"), dataProblems, {
      task_id: decision.task_id,
      openspec_summary: decision.openspec_status_summary,
    });
  }
  return {
    ...decision,
    block_reasons: [...(Array.isArray(decision.block_reasons) ? decision.block_reasons : []), ...dataProblems],
  };
}

function evaluate_workflow_decision(ctx: PacketContext, gateRaw: string, taskId?: string): JsonMap {
  const gate = normalize_gate(gateRaw);
  let decision: JsonMap;
  if (gate === "apply_ready") {
    decision = check_apply_ready(ctx.change, ctx.status, ctx.changeRoot, ctx.evidences);
  } else if (gate === "task_edit") {
    decision = check_task_edit(ctx.change, ctx.status, ctx.changeRoot, ctx.evidences, taskId ?? "");
  } else if (gate === "task_complete") {
    decision = check_task_complete(ctx.change, ctx.status, ctx.changeRoot, ctx.evidences, taskId ?? "");
  } else if (gate === "task_reopen") {
    decision = check_task_reopen(ctx.change, ctx.status, ctx.changeRoot, ctx.evidences, taskId ?? "");
  } else if (gate === "review_complete") {
    decision = check_review_complete(ctx.change, ctx.status, ctx.changeRoot, ctx.evidences);
  } else if (gate === "archive_ready") {
    decision = check_archive_ready(ctx.change, ctx.status, ctx.changeRoot, ctx.evidences);
  } else {
    decision = check_superspec_gate(ctx.change, ctx.status, ctx.changeRoot, ctx.evidences, gate);
  }
  return apply_data_problems(ctx.change, decision, packet_data_problems(ctx));
}

function gate_recheck_command(change: string, gate: string, taskId?: string, diagnostic = false): string {
  const format = diagnostic ? "json" : "agent";
  if (gate === "apply_ready") return `superspec guard check-apply-ready --change "${change}" --format ${format}`;
  if (gate === "review_complete") return `superspec guard check-review-complete --change "${change}" --format ${format}`;
  if (gate === "archive_ready") return `superspec guard check-archive-ready --change "${change}" --format ${format}`;
  if (gate === "task_edit") return `superspec guard check-task-edit --change "${change}" --task-id "${taskId ?? ""}" --format ${format}`;
  if (gate === "task_complete") return `superspec guard check-task-complete --change "${change}" --task-id "${taskId ?? ""}" --format ${format}`;
  if (gate === "task_reopen") return `superspec guard check-task-reopen --change "${change}" --task-id "${taskId ?? ""}" --format ${format}`;
  return `superspec guard check-enter --change "${change}" --gate "${gate}" --format ${format}`;
}

function default_allowed_next_action(gate: string): string {
  if (gate === "review_complete") return "current review gate already passes; continue with archive-ready work.";
  if (gate === "archive_ready") return "current archive gate already passes; continue with archive handoff.";
  if (gate === "apply_ready") return "current apply gate already passes; continue with OpenSpec apply instructions and task execution.";
  if (gate === "task_edit") return "current task is clear to enter implementation edits.";
  if (gate === "task_complete") return "current task has enough completion proof to be checked off.";
  if (gate === "task_reopen") return "current task is authorized for a guarded reopen.";
  return "current gate already passes; continue with the next workflow step.";
}

function openspec_cli_surfaces_for_gate(change: string, gate: string): string[] {
  if (gate === "explore_complete") {
    return [
      "openspec list --json",
      `openspec status --change "${change}" --json`,
    ];
  }
  if (gate === "apply_ready" || gate === "task_edit" || gate === "task_complete" || gate === "task_reopen") {
    return [`openspec instructions apply --change "${change}" --json`];
  }
  if (gate === "proposal_reviewed" || gate === "design_complete" || gate === "invariants_reviewed" || gate === "test_contract_drafted" || gate === "tasks_complete") {
    return [
      `openspec status --change "${change}" --json`,
      `openspec instructions <artifact-id> --change "${change}" --json`,
    ];
  }
  if (gate === "review_complete") return [`openspec validate "${change}"`];
  if (gate === "archive_ready") {
    return [
      `openspec validate "${change}"`,
      `openspec archive -y "${change}"`,
    ];
  }
  return [];
}

function workflow_gate_refs(ctx: PacketContext, gate: string): PinnedRef[] {
  const reviewTargets = enumerate_review_targets(gate, ctx.changeRoot);
  if (reviewTargets) {
    return unique_pinned_refs([...reviewTargets.keys()].map((path) => change_pinned_ref(ctx.changeRoot, path)).filter(Boolean) as PinnedRef[]);
  }
  if (gate === "apply_ready" || gate === "task_edit" || gate === "task_complete" || gate === "task_reopen") {
    return unique_pinned_refs(collect_change_refs(ctx.changeRoot, [
      "tasks.md",
      "design.md",
      ".superspec/artifacts/business-invariants.md",
      ".superspec/artifacts/test-contract.md",
    ]));
  }
  if (gate === "review_complete" || gate === "archive_ready") {
    const changeRefs = collect_change_refs(ctx.changeRoot, [
      "tasks.md",
      "design.md",
      ".superspec/artifacts/business-invariants.md",
      ".superspec/artifacts/test-contract.md",
    ]);
    const repoRefs = dirty_repo_refs(ctx, `${gate}: failed to inspect dirty worktree`);
    return unique_pinned_refs([...changeRefs, ...repoRefs]);
  }
  if (gate === "explore_complete") return collect_change_refs(ctx.changeRoot, [".superspec/artifacts/discovery.md"]);
  return [];
}

function evidence_ref_selector(changeRoot: string, ev: JsonMap): PinnedRef | null {
  if (typeof ev._path !== "string" || !ev._path) return null;
  return change_pinned_ref(changeRoot, ev._path);
}

function decision_selectors_for_gate(ctx: PacketContext, gate: string): DecisionSelector[] {
  const selectors: DecisionSelector[] = [];
  for (const ev of ctx.evidences) {
    if (!isObject(ev) || ev._invalid) continue;
    if (normalize_gate(String(ev.gate ?? "")) !== gate) continue;
    const evidenceRef = evidence_ref_selector(ctx.changeRoot, ev);
    if (!evidenceRef) continue;
    if (typeof ev.decision_scope_key === "string" && ev.decision_scope_key) {
      selectors.push({
        evidence_id: String(ev.evidence_id ?? ""),
        decision_scope_key: ev.decision_scope_key,
        evidence_ref: evidenceRef,
      });
    }
    for (const item of Array.isArray(ev.finding_dispositions) ? ev.finding_dispositions : []) {
      if (!isObject(item)) continue;
      if (typeof item.decision_scope_key !== "string" || !item.decision_scope_key) continue;
      selectors.push({
        evidence_id: String(ev.evidence_id ?? ""),
        decision_scope_key: item.decision_scope_key,
        evidence_ref: evidenceRef,
      });
    }
  }
  return selectors;
}

function finding_selectors_for_gate(ctx: PacketContext, gate: string, round?: number): FindingSelector[] {
  const selectors: FindingSelector[] = [];
  for (const ev of ctx.evidences) {
    if (!isObject(ev) || ev._invalid) continue;
    if (normalize_gate(String(ev.gate ?? "")) !== gate) continue;
    if (!Array.isArray(ev.findings)) continue;
    const evidenceRef = evidence_ref_selector(ctx.changeRoot, ev);
    if (!evidenceRef) continue;
    if (round !== undefined) {
      const roundNumber = review_round_number(gate, String(ev.review_round_id ?? ""));
      if (roundNumber !== round) continue;
    }
    for (const item of ev.findings) {
      if (!isObject(item) || typeof item.finding_uid !== "string" || !item.finding_uid) continue;
      selectors.push({
        evidence_id: String(ev.evidence_id ?? ""),
        finding_uid: item.finding_uid,
        evidence_ref: evidenceRef,
      });
    }
  }
  return selectors;
}

function review_complete_finding_selectors(ctx: PacketContext): FindingSelector[] {
  const selectors: FindingSelector[] = [];
  for (const ev of live_pass(ctx.evidences, { gate: "review_complete", kind: "source_guidance" })) {
    const evidenceRef = evidence_ref_selector(ctx.changeRoot, ev);
    if (!evidenceRef) continue;
    for (const item of Array.isArray(ev.blocking_findings) ? ev.blocking_findings : []) {
      if (!isObject(item)) continue;
      const findingUid = typeof item.finding_uid === "string" && item.finding_uid
        ? item.finding_uid
        : (typeof item.finding_id === "string" && item.finding_id
          ? `review_complete:${String(ev.evidence_id ?? "")}:${item.finding_id}`
          : "");
      if (!findingUid) continue;
      selectors.push({
        evidence_id: String(ev.evidence_id ?? ""),
        finding_uid: findingUid,
        evidence_ref: evidenceRef,
      });
    }
  }
  return selectors;
}

const REVIEW_PACKET_ROLES_BY_GATE: Record<string, string[]> = {
  explore_complete: ["critic"],
  proposal_reviewed: ["critic"],
  design_complete: ["architect", "critic", "test-engineer"],
  invariants_reviewed: ["critic", "test-engineer"],
  test_contract_drafted: ["critic", "test-engineer"],
  tasks_complete: ["critic"],
  review_complete: ["code-reviewer", "architect", "critic", "verifier"],
};

function validate_review_packet_gate_and_role(gate: string, role: string): void {
  if (gate !== "review_complete" && !(gate in REVIEW_TARGETS_BY_GATE)) {
    throw new GuardError(`review-packet only supports disclosure gates and review_complete, got ${gate}`);
  }
  if (role === "main-thread") return;
  const allowedRoles = REVIEW_PACKET_ROLES_BY_GATE[gate] ?? [];
  if (!allowedRoles.includes(role)) {
    throw new GuardError(`review-packet role ${role} is not supported for gate ${gate}; expected one of ${renderList([...allowedRoles, "main-thread"])}`);
  }
}

function workflow_packet(ctx: PacketContext, gateRaw: string, taskId?: string): WorkflowPacket {
  const gate = normalize_gate(gateRaw);
  const decision = evaluate_workflow_decision(ctx, gate, taskId);
  const reasonCodes = unique_strings((Array.isArray(decision.block_reasons) ? decision.block_reasons : []).map((item: Reason) => item.code));
  const topBlockers = reasonCodes.slice(0, 5);
  const nextActions = Array.isArray(decision.next_allowed_actions) ? decision.next_allowed_actions.filter((item: unknown) => typeof item === "string" && item.length > 0) : [];
  const packet: WorkflowPacket = {
    stage: gate_route_phase(gate),
    current_gate: gate,
    status: decision.allowed ? "allowed" : "blocked",
    next_action: nextActions[0] ?? default_allowed_next_action(gate),
    next_command: gate_recheck_command(ctx.change, gate, taskId, false),
    diagnostic_command: gate_recheck_command(ctx.change, gate, taskId, true),
    must_read_refs: workflow_gate_refs(ctx, gate),
  };
  const cliSurfaces = openspec_cli_surfaces_for_gate(ctx.change, gate);
  if (cliSurfaces.length > 0) packet.openspec_cli_surfaces = cliSurfaces;
  if (taskId) packet.task_id = taskId;
  if (!decision.allowed) {
    packet.top_blockers = topBlockers;
    packet.blocker_count = reasonCodes.length;
    packet.has_more_blockers = reasonCodes.length > topBlockers.length;
  }
  const findings = finding_selectors_for_gate(ctx, gate);
  if (findings.length > 0) packet.must_read_verbatim_findings = findings;
  const decisions = decision_selectors_for_gate(ctx, gate);
  if (decisions.length > 0) packet.must_read_verbatim_decisions = decisions;
  return packet;
}

function live_output_refs(changeRoot: string, evidences: JsonMap[]): PinnedRef[] {
  const refs: PinnedRef[] = [];
  for (const ev of evidences) {
    if (!isObject(ev)) continue;
    if (typeof ev.output_ref !== "string" || !ev.output_ref) continue;
    const ref = change_pinned_ref(changeRoot, ev.output_ref);
    if (ref) refs.push(ref);
  }
  return unique_pinned_refs(refs);
}

function disclosure_round_reviews(ctx: PacketContext, gate: string, round: number): JsonMap[] {
  return ctx.evidences.filter((ev) =>
    isObject(ev)
    && !ev._invalid
    && normalize_gate(String(ev.gate ?? "")) === gate
    && Boolean(ev.agent_role)
    && review_round_number(gate, String(ev.review_round_id ?? "")) === round
  );
}

function review_complete_role_target_refs(ctx: PacketContext): PinnedRef[] {
  const repoRefs = dirty_repo_refs(ctx, "review_complete: failed to inspect dirty worktree");
  return unique_pinned_refs([
    ...repoRefs,
    ...collect_change_refs(ctx.changeRoot, [
      "tasks.md",
      "design.md",
      ".superspec/artifacts/business-invariants.md",
      ".superspec/artifacts/test-contract.md",
    ]),
  ]);
}

function verification_output_fields(): string[] {
  return [...ROLE_EVIDENCE_FIELDS, ...VERIFY_EVIDENCE_REQUIRED_FIELDS, "scope_drift"];
}

function review_output_fields(): string[] {
  return [...ROLE_EVIDENCE_FIELDS, "review_round_id", "findings", "acknowledged_accepted_deviation_uids"];
}

function source_guidance_output_fields(): string[] {
  return [
    ...ROLE_EVIDENCE_FIELDS,
    ...SOURCE_GUIDANCE_REQUIRED_FIELDS,
    ...REVIEW_EVIDENCE_REQUIRED_FIELDS,
    "blocking_findings",
    "non_blocking_findings",
    "finding_dispositions",
    "rollback_targets",
  ];
}

function main_review_digest_fields(): string[] {
  return [
    "review_round_id",
    "target_refs",
    "source_review_evidence_refs",
    "previous_digest_refs",
    "finding_dispositions",
  ];
}

function main_adjudication_fields(): string[] {
  return [
    ...MAIN_ADJUDICATION_REQUIRED_FIELDS,
    "review_decision",
    "request_changes_route",
    "blocking_source_evidence_refs",
    "reopen_task_ids",
    `review_decision values: ${renderList([...MAIN_ADJUDICATION_DECISIONS])}`,
    `request_changes_route values: ${renderList([...REQUEST_CHANGES_ROUTES])}`,
    `claim_adjudications decision values: ${renderList([...CLAIM_ADJUDICATION_DECISIONS])}`,
    `finding_adjudications decision values: ${renderList([...FINDING_ADJUDICATION_DECISIONS])}`,
  ];
}

function review_packet(ctx: PacketContext, gateRaw: string, role: string, round: number, requestedKind?: string): ReviewPacket {
  const gate = normalize_gate(gateRaw);
  const consumer = role === "main-thread" ? "main-thread" : "role";
  validate_review_packet_gate_and_role(gate, role);
  let targetRefs: PinnedRef[] = [];
  let sourceRefs: PinnedRef[] = [];
  let requiredLoadRefs: PinnedRef[] = [];
  let requiredClaimIds: string[] = [];
  let requiredOutputKind = "review";
  let outputContractFields = review_output_fields();
  let stopConditions: string[] = [];

  if (gate === "review_complete") {
    targetRefs = review_complete_role_target_refs(ctx);
    if (consumer === "main-thread") {
      if (requestedKind !== undefined) throw new GuardError("review-packet --kind is only supported for review_complete role lanes");
      const sourceGuidance = live_pass(ctx.evidences, { gate: "review_complete", kind: "source_guidance" });
      const verification = final_verification_evidences(ctx.evidences);
      sourceRefs = unique_pinned_refs([
        ...live_output_refs(ctx.changeRoot, sourceGuidance),
        ...live_output_refs(ctx.changeRoot, verification),
      ]);
      requiredLoadRefs = unique_pinned_refs(
        sourceGuidance.flatMap((ev) =>
          Array.isArray(ev.required_load_refs)
            ? ev.required_load_refs.map((item: JsonMap) => evidence_pinned_ref("repo", item)).filter(Boolean) as PinnedRef[]
            : []
        ),
      );
      requiredClaimIds = unique_strings(sourceGuidance.flatMap((ev) => Array.isArray(ev.required_claim_ids) ? ev.required_claim_ids.map(String) : []));
      requiredOutputKind = "main_adjudication";
      outputContractFields = main_adjudication_fields();
      stopConditions = [
        "Stop if any required_load_refs item has not been actually read by the main thread.",
        "Stop if any required_claim_ids entry is left unadjudicated.",
        "Stop if any blocking finding remains needs_fix.",
        "Stop if request_changes_route='change_update'; hand off back to propose instead of forcing review_complete.",
      ];
    } else if (role === "verifier" || (role === "critic" && requestedKind === "verification_review")) {
      if (role === "verifier" && requestedKind !== undefined && requestedKind !== "verification_review") {
        throw new GuardError("review-packet role verifier only supports --kind verification_review");
      }
      sourceRefs = targetRefs;
      requiredOutputKind = "verification_review";
      outputContractFields = verification_output_fields();
      stopConditions = [
        "Stop after writing verification_review only; do not write main_adjudication.",
        "Stop if validation or evidence gaps remain unresolved.",
      ];
    } else {
      if (requestedKind !== undefined && requestedKind !== "source_guidance") {
        throw new GuardError(`review-packet role ${role} cannot write ${requestedKind} for gate ${gate}`);
      }
      sourceRefs = targetRefs;
      requiredOutputKind = "source_guidance";
      outputContractFields = source_guidance_output_fields();
      stopConditions = [
        "Stop after writing source_guidance only; do not write main_adjudication.",
        "Stop if reviewed_files does not cover the implementation diff.",
        "Stop if rollback_targets are missing.",
      ];
    }
  } else if (consumer === "main-thread") {
    if (requestedKind !== undefined) throw new GuardError("review-packet --kind is only supported for review_complete role lanes");
    const roundReviews = disclosure_round_reviews(ctx, gate, round);
    const targetSet = enumerate_review_targets(gate, ctx.changeRoot);
    targetRefs = targetSet ? unique_pinned_refs([...targetSet.keys()].map((path) => change_pinned_ref(ctx.changeRoot, path)).filter(Boolean) as PinnedRef[]) : [];
    sourceRefs = live_output_refs(ctx.changeRoot, roundReviews);
    requiredLoadRefs = sourceRefs;
    requiredOutputKind = "main_review_digest";
    outputContractFields = main_review_digest_fields();
    stopConditions = [
      "Stop if any finding from the round lacks a disposition in the digest.",
      "Stop if any material finding lacks a user decision, standing authorization, or baseline decision anchor.",
      "Stop if a round>1 digest is missing the deterministic ledger block.",
    ];
  } else {
    if (requestedKind !== undefined) throw new GuardError("review-packet --kind is only supported for review_complete role lanes");
    const targetSet = enumerate_review_targets(gate, ctx.changeRoot);
    targetRefs = targetSet ? unique_pinned_refs([...targetSet.keys()].map((path) => change_pinned_ref(ctx.changeRoot, path)).filter(Boolean) as PinnedRef[]) : [];
    sourceRefs = targetRefs;
    requiredOutputKind = "review";
    outputContractFields = review_output_fields();
    stopConditions = [
      "Stop after writing role review evidence only; do not write main_review_digest or main_adjudication.",
      "Stop if target_refs do not pin the current gate target set.",
    ];
  }

  const packet: ReviewPacket = {
    consumer,
    gate,
    role,
    round,
    target_refs: targetRefs,
    source_refs: sourceRefs,
    required_output_kind: requiredOutputKind,
    output_contract_fields: outputContractFields,
    required_review_scope: targetRefs.map((item) => item.path),
    stop_conditions: stopConditions,
  };
  if (requiredLoadRefs.length > 0) packet.required_load_refs = requiredLoadRefs;
  if (requiredClaimIds.length > 0) packet.required_claim_ids = requiredClaimIds;
  const findingSelectors = gate === "review_complete"
    ? (consumer === "main-thread" ? review_complete_finding_selectors(ctx) : [])
    : finding_selectors_for_gate(ctx, gate, round);
  if (findingSelectors.length > 0) packet.must_read_verbatim_findings = findingSelectors;
  const decisionSelectors = decision_selectors_for_gate(ctx, gate);
  if (decisionSelectors.length > 0) packet.must_read_verbatim_decisions = decisionSelectors;
  return packet;
}

function decision_status(decision: JsonMap): "allowed" | "blocked" {
  return decision.allowed ? "allowed" : "blocked";
}

function safe_decision_status(ctx: PacketContext, gate: string, taskId: string): "allowed" | "blocked" {
  try {
    return decision_status(evaluate_workflow_decision(ctx, gate, taskId));
  } catch {
    return "blocked";
  }
}

function decision_reasons(decision: JsonMap): Reason[] {
  return Array.isArray(decision.block_reasons) ? decision.block_reasons : [];
}

function apply_worker_report_policy(): JsonMap {
  return {
    max_inline_report_chars: 12000,
    artifact_ref_policy: "raw transcripts, diffs, logs, and long outputs must be returned as refs",
    truncation_policy: "fail_closed",
  };
}

function without_audit_metadata(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(without_audit_metadata);
  if (!isObject(value)) return value;
  const out: JsonMap = {};
  for (const [key, child] of Object.entries(value)) {
    if (key === "computed_at") continue;
    out[key] = without_audit_metadata(child);
  }
  return out;
}

function apply_worker_stop_conditions(kind: string): string[] {
  if (kind === "apply_test") {
    return [
      "Stop after reporting the bounded test command result only.",
      "Do not change implementation files.",
      "Return raw logs as pinned artifact refs when output is long.",
    ];
  }
  if (kind === "apply_executor") {
    return [
      "Stay inside declared_task_write_scope.",
      "Stop after implementation report; do not mark tasks complete.",
      "Do not write OpenSpec artifacts or .superspec evidence directly.",
    ];
  }
  if (kind === "apply_code_review") {
    return [
      "Review only the task-local executor output and current diff.",
      "Stop after implementation code-review report.",
      "Do not write GREEN evidence or task completion state.",
    ];
  }
  return [
    "Verify the accepted worker chain and GREEN evidence only.",
    "Stop after verifier report.",
    "Do not mark tasks complete or enter change-level review.",
  ];
}

function apply_worker_packet_fingerprint(packet: JsonMap): string {
  const {
    generated_at,
    guard_fingerprint,
    block_reasons,
    apply_worker_chain_refs,
    apply_worker_chain_active_refs,
    ...stable
  } = packet;
  const blockerCodes = Array.isArray(block_reasons) ? block_reasons.map((item: Reason) => item.code).sort() : [];
  return fingerprint_obj(without_audit_metadata({ ...stable, blocker_codes: blockerCodes }));
}

function finalize_apply_worker_packet(packet: JsonMap): JsonMap {
  packet.guard_fingerprint = apply_worker_packet_fingerprint(packet);
  return packet;
}

function apply_packet_common(ctx: PacketContext, packetKind: string, taskId: string, workerChainContext: "none" | "executor_worker", blockers: Reason[]): JsonMap {
  const applyReady = evaluate_workflow_decision(ctx, "apply_ready");
  const packet: JsonMap = {
    packet_kind: packetKind,
    change: ctx.change,
    task_id: taskId,
    generated_at: new Date().toISOString(),
    worker_chain_context: workerChainContext,
    worker_state: blockers.length === 0 ? "ready" : "blocked",
    apply_ready: decision_status(applyReady),
    openspec_context_file_refs: collect_change_refs(ctx.changeRoot, [
      "proposal.md",
      "design.md",
      "tasks.md",
      ".superspec/artifacts/business-invariants.md",
      ".superspec/artifacts/test-contract.md",
    ]),
    openspec_dynamic_instructions: openspec_cli_surfaces_for_gate(ctx.change, "task_edit"),
    task_refs: collect_change_refs(ctx.changeRoot, ["tasks.md"]),
    test_contract_refs: collect_change_refs(ctx.changeRoot, [".superspec/artifacts/test-contract.md"]),
    common_worker_report_policy: apply_worker_report_policy(),
    stop_conditions: apply_worker_stop_conditions(packetKind),
  };
  if (blockers.length > 0) {
    packet.blockers = unique_strings(blockers.map((item) => item.code));
    packet.block_reasons = blockers;
  }
  return packet;
}

function task_lookup_blockers(ctx: PacketContext, taskId: string): { task: ReturnType<typeof parse_tasks>[string] | null; blockers: Reason[] } {
  const task = parse_tasks(ctx.changeRoot)[taskId];
  if (!task) return { task: null, blockers: [reason("unknown_task", `task ${taskId} not found`)] };
  return { task, blockers: [] };
}

function active_apply_worker_chain_id(ctx: PacketContext, taskId: string): string | null {
  const active = active_apply_worker_chain(ctx, taskId).active;
  return active ? String(active.apply_worker_chain_id) : null;
}

function apply_worker_chain_packet_state(ctx: PacketContext, taskId: string): { active: JsonMap | null; blockers: Reason[] } {
  const state = apply_worker_chain_lifecycle_state(ctx.repoRoot, ctx.changeRoot, ctx.evidences, taskId);
  return { active: state.active, blockers: state.packetBlockers };
}

function active_apply_worker_chain(ctx: PacketContext, taskId: string): { active: JsonMap | null; blockers: Reason[] } {
  return apply_worker_chain_packet_state(ctx, taskId);
}

function require_active_apply_worker_chain(ctx: PacketContext, taskId: string, blockers: Reason[]): string | null {
  const state = active_apply_worker_chain(ctx, taskId);
  blockers.push(...state.blockers);
  const active = state.active;
  const chainId = active ? String(active.apply_worker_chain_id) : null;
  if (!chainId) {
    blockers.push(reason("missing_apply_worker_chain_active", `task ${taskId} requires an active apply_worker_chain marker before downstream worker packet generation`));
  } else {
    blockers.push(...pre_edit_evidence_ref_reasons(ctx.evidences, active, taskId, "apply_worker_chain_active_invalid"));
  }
  return chainId;
}

function generated_apply_worker_chain_id(ctx: PacketContext, taskId: string, writeScope: string[] = []): string {
  const digest = sha256_text(`${ctx.change}\n${taskId}\n${writeScope.join("\n")}`).slice("sha256:".length, "sha256:".length + 16);
  const base = `CHAIN-${taskId}-${digest}`;
  const used = new Set(ctx.evidences
    .filter((ev) => isObject(ev) && ev.kind === "apply_worker_chain" && ev.task_id === taskId && typeof ev.apply_worker_chain_id === "string")
    .map((ev) => String(ev.apply_worker_chain_id)));
  if (!used.has(base)) return base;
  for (let idx = 2; idx < 1000; idx += 1) {
    const candidate = `${base}-R${idx}`;
    if (!used.has(candidate)) return candidate;
  }
  return `${base}-R${sha256_text([...used].sort().join("\n")).slice("sha256:".length, "sha256:".length + 8)}`;
}

function implementation_fingerprint(ctx: PacketContext, declaredTaskWriteScope: string[] = []): JsonMap {
  return apply_worker_implementation_fingerprint(ctx.repoRoot, ctx.changeRoot, [], { declaredTaskWriteScope });
}

function read_json_ref(ctx: PacketContext, ref: string): { value: JsonMap | null; blockers: Reason[] } {
  const target = safe_within(ctx.changeRoot, ref);
  if (target === null) return { value: null, blockers: [reason("ref_path_unsafe", `ref escapes change root: ${ref}`, [ref])] };
  if (!existsSync(target) || !statSync(target).isFile()) return { value: null, blockers: [reason("ref_not_readable", `ref is not readable: ${ref}`, [ref])] };
  if (statSync(target).size <= 0) return { value: null, blockers: [reason("ref_empty", `ref is empty: ${ref}`, [ref])] };
  try {
    const value = JSON.parse(readFileSync(target, "utf8"));
    return isObject(value) ? { value, blockers: [] } : { value: null, blockers: [reason("ref_type_mismatch", `ref must contain a JSON object: ${ref}`, [ref])] };
  } catch {
    return { value: null, blockers: [reason("ref_type_mismatch", `ref must contain valid JSON: ${ref}`, [ref])] };
  }
}

function validate_pinned_artifact_ref_object(
  ctx: PacketContext,
  item: unknown,
  label: string,
  expected: { role: string; taskId: string; chainId?: string | null; kind?: string },
  code = "pinned_artifact_ref_invalid",
): Reason[] {
  return shared_pinned_artifact_ref_reasons(ctx.changeRoot, item, label, {
    kind: expected.kind ?? "worker_report",
    role: expected.role,
    taskId: expected.taskId,
    chainId: expected.chainId,
  }, code);
}

function validate_pinned_artifact_ref(
  ctx: PacketContext,
  ref: string,
  expected: { role: string; taskId: string; chainId?: string | null; kind?: string },
): { ref: JsonMap | null; blockers: Reason[] } {
  const loaded = read_json_ref(ctx, ref);
  if (loaded.blockers.length > 0 || !loaded.value) return { ref: null, blockers: loaded.blockers };
  const item = loaded.value;
  const blockers = validate_pinned_artifact_ref_object(ctx, item, ref, expected);
  return { ref: blockers.length === 0 ? item : null, blockers };
}

function validate_worker_report_refs(
  ctx: PacketContext,
  refs: string[],
  expected: { role: string; taskId: string; chainId?: string | null; missingCode: string; missingMessage: string },
): { refs: JsonMap[]; blockers: Reason[] } {
  if (refs.length === 0) return { refs: [], blockers: [reason(expected.missingCode, expected.missingMessage)] };
  const resolved: JsonMap[] = [];
  const blockers: Reason[] = [];
  for (const ref of refs) {
    const result = validate_pinned_artifact_ref(ctx, ref, { role: expected.role, taskId: expected.taskId, chainId: expected.chainId });
    blockers.push(...result.blockers);
    if (result.ref) resolved.push(result.ref);
  }
  return { refs: resolved, blockers };
}

function worker_report_origin_blockers(refItem: unknown, expectedOrigin: unknown, label: string): Reason[] {
  if (!isObject(refItem) || typeof expectedOrigin !== "string" || !expectedOrigin.startsWith("sha256:")) return [];
  return refItem.origin_packet_fingerprint === expectedOrigin
    ? []
    : [reason("worker_report_origin_mismatch", `${label} origin_packet_fingerprint must match active apply_worker_chain executor_packet_fingerprint`, [])];
}

function worker_report_input_blockers(refItem: unknown, refs: unknown[], label: string): Reason[] {
  if (!isObject(refItem)) return [];
  const expected = worker_input_ref_digest(refs);
  return refItem.input_ref_digest === expected
    ? []
    : [reason("worker_report_input_ref_mismatch", `${label} input_ref_digest must match upstream refs`, [])];
}

function worker_report_input_digest_blockers(refItem: unknown, expectedDigest: string, label: string): Reason[] {
  if (!isObject(refItem)) return [];
  return refItem.input_ref_digest === expectedDigest
    ? []
    : [reason("worker_report_input_ref_mismatch", `${label} input_ref_digest must match active executor packet inputs`, [])];
}

function code_review_executor_binding_blockers(ctx: PacketContext, codeReviewRef: JsonMap, activeChain: JsonMap | null | undefined, taskId: string, chainId: string): Reason[] {
  const blockers: Reason[] = [];
  const report = read_pinned_artifact_json(ctx.changeRoot, codeReviewRef);
  if (!report) return [reason("worker_report_content_invalid", "task_code_review_report_ref content must be readable before spawning GREEN test-runner", [])];
  const executorReportRef = report.executor_report_ref;
  blockers.push(...validate_pinned_artifact_ref_object(ctx, executorReportRef, "task_code_review_report_ref.executor_report_ref", {
    role: "executor",
    taskId,
    chainId,
  }));
  if (isObject(executorReportRef)) {
    blockers.push(...worker_report_origin_blockers(executorReportRef, activeChain?.executor_packet_fingerprint, "task_code_review_report_ref.executor_report_ref"));
    if (activeChain) {
      blockers.push(...worker_report_input_digest_blockers(
        executorReportRef,
        apply_worker_executor_input_ref_digest(ctx.evidences, activeChain),
        "task_code_review_report_ref.executor_report_ref",
      ));
    }
    blockers.push(...worker_report_input_blockers(codeReviewRef, [executorReportRef], "task_code_review_report_ref"));
  }
  return blockers;
}

function validate_executor_worker_test_run_refs(ctx: PacketContext, ev: JsonMap, ref: string, taskId: string, chainId: string): Reason[] {
  return worker_test_run_reasons(ctx.changeRoot, ev, taskId, chainId, "pinned_evidence_ref_invalid")
    .map((item) => ({ ...item, refs: [ref] }));
}

function validate_test_run_evidence_refs(
  ctx: PacketContext,
  refs: string[],
  expected: { taskId: string; gate: "task_edit" | "task_complete"; phase: "red" | "characterization" | "green"; semanticStatus: "expected_failure" | "expected_success"; chainId?: string | null; missingCode: string; missingMessage: string },
): { refs: JsonMap[]; blockers: Reason[] } {
  if (refs.length === 0) return { refs: [], blockers: [reason(expected.missingCode, expected.missingMessage)] };
  const resolved: JsonMap[] = [];
  const blockers: Reason[] = [];
  for (const ref of refs) {
    let evidenceId = ref;
    const maybePath = safe_within(ctx.changeRoot, ref);
    if (maybePath !== null && existsSync(maybePath) && statSync(maybePath).isFile()) {
      const loaded = read_json_ref(ctx, ref);
      blockers.push(...loaded.blockers);
      if (loaded.value) {
        if (loaded.value.kind !== "test_run") blockers.push(reason("pinned_evidence_ref_invalid", `${ref}: kind must be test_run`, [ref]));
        if (normalize_gate(String(loaded.value.gate ?? "")) !== expected.gate) blockers.push(reason("pinned_evidence_ref_invalid", `${ref}: gate must be ${expected.gate}`, [ref]));
        if (loaded.value.task_id !== expected.taskId) blockers.push(reason("pinned_evidence_ref_invalid", `${ref}: task_id must be ${expected.taskId}`, [ref]));
        if (loaded.value.phase !== undefined && loaded.value.phase !== expected.phase) blockers.push(reason("pinned_evidence_ref_invalid", `${ref}: phase must be ${expected.phase}`, [ref]));
        if (loaded.value.semantic_status !== expected.semanticStatus) blockers.push(reason("pinned_evidence_ref_invalid", `${ref}: semantic_status must be ${expected.semanticStatus}`, [ref]));
        if (expected.chainId && loaded.value.apply_worker_chain_id !== expected.chainId) blockers.push(reason("pinned_evidence_ref_invalid", `${ref}: apply_worker_chain_id mismatch`, [ref]));
        if (typeof loaded.value.evidence_id === "string" && loaded.value.evidence_id) evidenceId = loaded.value.evidence_id;
        if (expected.chainId) blockers.push(...validate_executor_worker_test_run_refs(ctx, loaded.value, ref, expected.taskId, expected.chainId));
      }
    }
    const ev = live_pass(ctx.evidences, { kind: "test_run", task_id: expected.taskId })
      .find((item) => String(item.evidence_id ?? "") === evidenceId);
    if (!ev) {
      blockers.push(reason("pinned_evidence_ref_invalid", `test_run evidence ref is not live/pass for ${expected.taskId}: ${ref}`, [ref]));
      continue;
    }
    if (normalize_gate(String(ev.gate ?? "")) !== expected.gate) blockers.push(reason("pinned_evidence_ref_invalid", `${ref}: gate must be ${expected.gate}`, [ref]));
    if (ev.semantic_status !== expected.semanticStatus) blockers.push(reason("pinned_evidence_ref_invalid", `${ref}: semantic_status must be ${expected.semanticStatus}`, [ref]));
    if (ev.phase !== undefined && ev.phase !== expected.phase) blockers.push(reason("pinned_evidence_ref_invalid", `${ref}: phase must be ${expected.phase}`, [ref]));
    if (expected.chainId) {
      if (ev.apply_execution_chain !== "executor_worker") blockers.push(reason("pinned_evidence_ref_invalid", `${ref}: apply_execution_chain must be executor_worker`, [ref]));
      if (ev.apply_worker_chain_id !== expected.chainId) blockers.push(reason("pinned_evidence_ref_invalid", `${ref}: apply_worker_chain_id mismatch`, [ref]));
      blockers.push(...validate_executor_worker_test_run_refs(ctx, ev, ref, expected.taskId, expected.chainId));
    }
    resolved.push(ev);
  }
  return { refs: resolved, blockers };
}

function validate_active_apply_worker_chain_refs(
  ctx: PacketContext,
  refs: string[],
  taskId: string,
  expectedChainId: string,
  expectedPacketFingerprint: string,
  expectedSourceImplementationFingerprint: unknown,
  expectedDeclaredTaskWriteScope: string[],
  expectedPreEditEvidenceRefs: string[],
): { refs: JsonMap[]; blockers: Reason[] } {
  if (refs.length === 0) {
    return {
      refs: [],
      blockers: [reason(
        "missing_apply_worker_chain_ref",
        "apply-executor-packet --format prompt requires --apply-worker-chain-ref pointing at the recorded active apply_worker_chain evidence",
      )],
    };
  }
  const resolved: JsonMap[] = [];
  const blockers: Reason[] = [];
  const hasTerminal = ctx.evidences.some((ev) => isObject(ev)
    && !ev._invalid
    && ev.status === "pass"
    && ev.gate === "task_complete"
    && ev.kind === "apply_worker_chain"
    && ev.task_id === taskId
    && ev.apply_worker_chain_id === expectedChainId
    && (ev.chain_state === "closed" || ev.chain_state === "abandoned"));
  if (hasTerminal) {
    blockers.push(reason("apply_worker_chain_ref_invalid", `apply_worker_chain ${expectedChainId} already has a terminal marker and cannot authorize executor spawn`, [expectedChainId]));
  }
  const stringList = (value: unknown): string[] => Array.isArray(value)
    ? value.map(String).filter(Boolean).sort()
    : [];
  const activeListBindingBlockers = (value: JsonMap, ref: string): Reason[] => {
    const fieldBlockers: Reason[] = [];
    if (!deepEqual(stringList(value.declared_task_write_scope), stringList(expectedDeclaredTaskWriteScope))) {
      fieldBlockers.push(reason("apply_worker_chain_ref_invalid", `${ref}: declared_task_write_scope mismatch`, [ref]));
    }
    if (!deepEqual(stringList(value.pre_edit_evidence_refs), stringList(expectedPreEditEvidenceRefs))) {
      fieldBlockers.push(reason("apply_worker_chain_ref_invalid", `${ref}: pre_edit_evidence_refs mismatch`, [ref]));
    }
    return fieldBlockers;
  };
  for (const ref of refs) {
    let evidenceId = ref;
    const maybePath = safe_within(ctx.changeRoot, ref);
    if (maybePath !== null && existsSync(maybePath) && statSync(maybePath).isFile()) {
      const loaded = read_json_ref(ctx, ref);
      blockers.push(...loaded.blockers);
      if (loaded.value) {
        if (loaded.value.kind !== "apply_worker_chain") blockers.push(reason("apply_worker_chain_ref_invalid", `${ref}: kind must be apply_worker_chain`, [ref]));
        if (normalize_gate(String(loaded.value.gate ?? "")) !== "task_complete") blockers.push(reason("apply_worker_chain_ref_invalid", `${ref}: gate must be task_complete`, [ref]));
        if (loaded.value.task_id !== taskId) blockers.push(reason("apply_worker_chain_ref_invalid", `${ref}: task_id must be ${taskId}`, [ref]));
        if (loaded.value.chain_state !== "active") blockers.push(reason("apply_worker_chain_ref_invalid", `${ref}: chain_state must be active`, [ref]));
        if (loaded.value.apply_worker_chain_id !== expectedChainId) blockers.push(reason("apply_worker_chain_ref_invalid", `${ref}: apply_worker_chain_id mismatch`, [ref]));
        if (loaded.value.executor_packet_fingerprint !== expectedPacketFingerprint) blockers.push(reason("apply_worker_chain_ref_invalid", `${ref}: executor_packet_fingerprint mismatch`, [ref]));
        if (!fingerprint_matches(loaded.value.source_implementation_fingerprint, expectedSourceImplementationFingerprint)) {
          blockers.push(reason("apply_worker_chain_ref_invalid", `${ref}: source_implementation_fingerprint mismatch`, [ref]));
        }
        blockers.push(...activeListBindingBlockers(loaded.value, ref));
        if (typeof loaded.value.evidence_id === "string" && loaded.value.evidence_id) evidenceId = loaded.value.evidence_id;
      }
    }
    const ev = live_pass(ctx.evidences, { gate: "task_complete", kind: "apply_worker_chain", task_id: taskId })
      .find((item) => String(item.evidence_id ?? "") === evidenceId);
    if (!ev) {
      blockers.push(reason("apply_worker_chain_ref_invalid", `apply_worker_chain ref is not live/pass for ${taskId}: ${ref}`, [ref]));
      continue;
    }
    if (ev.chain_state !== "active") blockers.push(reason("apply_worker_chain_ref_invalid", `${ref}: chain_state must be active`, [ref]));
    if (ev.apply_worker_chain_id !== expectedChainId) blockers.push(reason("apply_worker_chain_ref_invalid", `${ref}: apply_worker_chain_id mismatch`, [ref]));
    if (ev.executor_packet_fingerprint !== expectedPacketFingerprint) blockers.push(reason("apply_worker_chain_ref_invalid", `${ref}: executor_packet_fingerprint mismatch`, [ref]));
    if (!fingerprint_matches(ev.source_implementation_fingerprint, expectedSourceImplementationFingerprint)) {
      blockers.push(reason("apply_worker_chain_ref_invalid", `${ref}: source_implementation_fingerprint mismatch`, [ref]));
    }
    blockers.push(...activeListBindingBlockers(ev, ref));
    resolved.push(ev);
  }
  return { refs: resolved, blockers };
}

function pre_edit_refs_bound_to_active_chain(ctx: PacketContext, active: JsonMap | null, refs: JsonMap[], label: string, taskId: string): Reason[] {
  const allowed = new Set(Array.isArray(active?.pre_edit_evidence_refs) ? active.pre_edit_evidence_refs.map(String) : []);
  if (allowed.size === 0) return [reason("pinned_evidence_ref_invalid", `task ${taskId} active apply_worker_chain has no pre_edit_evidence_refs`)];
  const blockers: Reason[] = [];
  for (const ev of refs) {
    const evidenceId = String(ev.evidence_id ?? "");
    if (!allowed.has(evidenceId)) blockers.push(reason("pinned_evidence_ref_invalid", `${label} evidence ref is not part of active apply_worker_chain pre_edit_evidence_refs: ${evidenceId}`, [evidenceId]));
  }
  blockers.push(...pre_edit_evidence_ref_reasons(ctx.evidences, active, taskId, "pinned_evidence_ref_invalid"));
  return blockers;
}

function write_scope_blockers(taskId: string, writeScope: string[]): Reason[] {
  const blockers: Reason[] = [];
  if (writeScope.length === 0) {
    blockers.push(reason("missing_write_scope", `task ${taskId} requires declared write_scope before executor worker handoff`));
    return blockers;
  }
  const forbidden = writeScope.filter((item) =>
    item === "."
    || item === ""
    || item.startsWith("/")
    || item.includes("..")
    || item === "proposal.md"
    || item === "design.md"
    || item === "tasks.md"
    || item.startsWith("specs/")
    || item.startsWith(".superspec/")
  );
  if (forbidden.length > 0) {
    blockers.push(reason("unsafe_write_scope", `task ${taskId} has unsafe executor write_scope entries: ${renderList(forbidden)}`, forbidden));
  }
  return blockers;
}

function pre_edit_evidence_refs(ctx: PacketContext, taskId: string): string[] {
  return live_pass(ctx.evidences, { gate: "task_edit", kind: "test_run", task_id: taskId })
    .filter((ev) => ev.semantic_status === "expected_failure" || ev.semantic_status === "expected_success")
    .map((ev) => String(ev.evidence_id ?? ""))
    .filter(Boolean)
    .sort();
}

function apply_task_context_fields(ctx: PacketContext, taskId: string, task: ReturnType<typeof parse_tasks>[string] | null, writeScope: string[], expectedGuardRefs: unknown[] = []): JsonMap {
  return {
    task_content_ref: change_pinned_ref(ctx.changeRoot, "tasks.md"),
    task_acceptance_refs: task ? splitList(task.attrs.requirement_refs ?? "") : [],
    task_invariant_refs: task ? splitList(task.attrs.invariant_refs ?? "") : [],
    task_test_refs: task ? splitList(task.attrs.test_refs ?? "") : [],
    business_invariant_refs: collect_change_refs(ctx.changeRoot, [".superspec/artifacts/business-invariants.md"]),
    test_contract_refs: collect_change_refs(ctx.changeRoot, [".superspec/artifacts/test-contract.md"]),
    pre_edit_evidence_refs: pre_edit_evidence_refs(ctx, taskId),
    current_worktree_refs: dirty_repo_refs(ctx, `apply worker current worktree refs for ${taskId}`),
    protected_path_refs: apply_worker_protected_path_refs(ctx.repoRoot, ctx.changeRoot, expectedGuardRefs),
    scope_diff_review_policy: {
      declared_task_write_scope: writeScope,
      forbidden_paths: ["proposal.md", "design.md", "tasks.md", "specs/", ".superspec/"],
      require_scope_verdict: true,
      mismatch_behavior: "fail_closed",
    },
  };
}

function apply_test_packet(ctx: PacketContext, args: ParsedArgs): JsonMap {
  const taskId = args.task_id ?? "";
  const testId = args.test_id ?? "";
  const phase = args.phase ?? "red";
  const blockers: Reason[] = [];
  const applyReady = evaluate_workflow_decision(ctx, "apply_ready");
  if (!applyReady.allowed) blockers.push(...decision_reasons(applyReady));
  const { task, blockers: taskBlockers } = task_lookup_blockers(ctx, taskId);
  blockers.push(...taskBlockers);
  const declaredTests = new Set(task ? splitList(task.attrs.test_refs ?? "") : []);
  if (task && !declaredTests.has(testId)) {
    blockers.push(reason("test_not_declared_for_task", `test ${testId} is not declared in task ${taskId} test_refs`, [testId]));
  }
  const [config, configProblems] = load_config(ctx.repoRoot, ctx.changeRoot);
  blockers.push(...configProblems);
  const command = resolve_test_contract_command(ctx.changeRoot, testId, config);
  blockers.push(...command.blockers);
  const invariantRefs = [...(test_contract_invariant_refs_by_test(ctx.changeRoot).get(testId) ?? new Set<string>())].sort();
  if (invariantRefs.length === 0) blockers.push(reason("missing_invariant_refs", `test ${testId} requires invariant refs in test contract`, [testId]));
  if (phase === "green") {
    const taskEdit = evaluate_workflow_decision(ctx, "task_edit", taskId);
    if (!taskEdit.allowed) blockers.push(...decision_reasons(taskEdit));
    if ((args.task_code_review_report_refs ?? []).length === 0) {
      blockers.push(reason("missing_task_code_review_report_ref", "apply-test-packet --phase green requires --task-code-review-report-ref before spawning test-runner"));
    }
  } else if ((args.task_code_review_report_refs ?? []).length > 0) {
    blockers.push(reason("unexpected_task_code_review_report_ref", "apply-test-packet --phase red/characterization must not consume --task-code-review-report-ref"));
  }
  const workerChainContext = phase === "green" ? "executor_worker" : "none";
  const packet = apply_packet_common(ctx, "apply_test", taskId, workerChainContext, blockers);
  packet.test_id = testId;
  packet.phase = phase;
  packet.expected_semantic_status = phase === "red" ? "expected_failure" : "expected_success";
  packet.test_runner_report_required_fields = [...APPLY_TEST_RUNNER_REPORT_REQUIRED_FIELDS];
  packet.required_invariant_refs = invariantRefs;
  packet.allowed_test_command = command.command;
  packet.test_command_source = command.source;
  packet.expected_worktree_side_effects = [];
  if (command.command_ref) packet.test_command_ref = command.command_ref;
  if (command.expected_failure_signature) packet.expected_failure_signature = command.expected_failure_signature;
  if (command.expected_failure_classifier) packet.expected_failure_classifier = command.expected_failure_classifier;
  if (workerChainContext === "executor_worker") {
    const chainId = require_active_apply_worker_chain(ctx, taskId, blockers);
    if (chainId) {
      const reviewRefs = validate_worker_report_refs(ctx, args.task_code_review_report_refs ?? [], {
        role: "code-reviewer",
        taskId,
        chainId,
        missingCode: "missing_task_code_review_report_ref",
        missingMessage: "apply-test-packet --phase green requires --task-code-review-report-ref before spawning test-runner",
      });
      blockers.push(...reviewRefs.blockers);
      packet.apply_worker_chain_id = chainId;
      packet.task_code_review_report_pinned_refs = reviewRefs.refs;
      packet.task_code_review_report_refs = args.task_code_review_report_refs ?? [];
      const activeChain = active_apply_worker_chain(ctx, taskId).active;
      if (reviewRefs.refs[0]) {
        const reviewReport = read_pinned_artifact_json(ctx.changeRoot, reviewRefs.refs[0]);
        if (isObject(reviewReport?.executor_report_ref)) packet.executor_report_pinned_refs = [reviewReport.executor_report_ref];
        blockers.push(...code_review_executor_binding_blockers(ctx, reviewRefs.refs[0], activeChain, taskId, chainId));
      }
      const activeScope = Array.isArray(activeChain?.declared_task_write_scope) ? activeChain.declared_task_write_scope.map(String).filter(Boolean) : [];
      const currentImplementation = apply_worker_implementation_fingerprint(ctx.repoRoot, ctx.changeRoot, reviewRefs.refs, { declaredTaskWriteScope: activeScope });
      packet.post_code_review_worktree_fingerprint = currentImplementation;
      const observedDigest = fingerprint_digest(reviewRefs.refs[0]?.observed_implementation_fingerprint);
      if (!observedDigest) {
        blockers.push(reason("post_code_review_worktree_fingerprint_missing", "apply-test-packet --phase green requires code-review report observed_implementation_fingerprint"));
      } else if (observedDigest !== currentImplementation.fingerprint_digest) {
        blockers.push(reason("post_code_review_worktree_fingerprint_mismatch", "apply-test-packet --phase green requires code-review report observed implementation fingerprint to match current worktree"));
      }
    } else if ((args.task_code_review_report_refs ?? []).length === 0) {
      blockers.push(reason("missing_task_code_review_report_ref", "apply-test-packet --phase green requires --task-code-review-report-ref before spawning test-runner"));
    }
  }
  packet.worker_state = blockers.length === 0 ? "ready" : "blocked";
  if (blockers.length > 0) {
    packet.blockers = unique_strings(blockers.map((item) => item.code));
    packet.block_reasons = blockers;
  }
  return finalize_apply_worker_packet(packet);
}

function apply_executor_packet(ctx: PacketContext, args: ParsedArgs): JsonMap {
  const taskId = args.task_id ?? "";
  const blockers: Reason[] = [];
  const applyReady = evaluate_workflow_decision(ctx, "apply_ready");
  if (!applyReady.allowed) blockers.push(...decision_reasons(applyReady));
  const taskEdit = evaluate_workflow_decision(ctx, "task_edit", taskId);
  if (!taskEdit.allowed) blockers.push(...decision_reasons(taskEdit));
  const { task, blockers: taskBlockers } = task_lookup_blockers(ctx, taskId);
  blockers.push(...taskBlockers);
  const writeScope = task ? splitList(task.attrs.write_scope ?? "") : [];
  blockers.push(...write_scope_blockers(taskId, writeScope));
  if (task && (task.attrs.tdd_required ?? "true").toLowerCase() === "false") {
    blockers.push(reason("unsupported_executor_tdd_mode", `task ${taskId} has tdd_required:false and must stay on main-thread apply path`));
  }
  blockers.push(...apply_worker_chain_packet_state(ctx, taskId).blockers);
  const packet = apply_packet_common(ctx, "apply_executor", taskId, "executor_worker", blockers);
  const chainId = active_apply_worker_chain_id(ctx, taskId) ?? generated_apply_worker_chain_id(ctx, taskId, writeScope);
  packet.worker_chain_context = "executor_worker";
  packet.apply_worker_chain_id = chainId;
  packet.declared_task_write_scope = writeScope;
  packet.task_edit = decision_status(taskEdit);
  packet.task_complete = safe_decision_status(ctx, "task_complete", taskId);
  Object.assign(packet, apply_task_context_fields(ctx, taskId, task, writeScope));
  packet.required_test_refs = task ? splitList(task.attrs.test_refs ?? "") : [];
  packet.executor_report_required_fields = [...APPLY_EXECUTOR_REPORT_REQUIRED_FIELDS];
  packet.executor_runtime_policy = {
    initial_wait_seconds: 60,
    max_running_seconds: 7200,
    status_request_after_seconds: 300,
    max_silent_seconds: 900,
    stale_after_seconds: 1800,
  };
  packet.chain_activation_template = {
    kind: "apply_worker_chain",
    gate: "task_complete",
    status: "pass",
    task_id: taskId,
    apply_worker_chain_id: chainId,
    chain_state: "active",
    executor_packet_fingerprint: "",
    source_implementation_fingerprint: implementation_fingerprint(ctx, writeScope),
    declared_task_write_scope: writeScope,
    pre_edit_evidence_refs: pre_edit_evidence_refs(ctx, taskId),
  };
  if (args.packet_format === "prompt") {
    const expectedPacketFingerprint = apply_worker_packet_fingerprint(packet);
    const activeRefs = validate_active_apply_worker_chain_refs(
      ctx,
      args.apply_worker_chain_refs ?? [],
      taskId,
      chainId,
      expectedPacketFingerprint,
      packet.chain_activation_template.source_implementation_fingerprint,
      packet.chain_activation_template.declared_task_write_scope,
      packet.chain_activation_template.pre_edit_evidence_refs,
    );
    blockers.push(...activeRefs.blockers);
    packet.apply_worker_chain_refs = args.apply_worker_chain_refs ?? [];
    packet.apply_worker_chain_active_refs = activeRefs.refs;
  }
  packet.worker_state = blockers.length === 0 ? "ready" : "blocked";
  if (blockers.length > 0) {
    packet.blockers = unique_strings(blockers.map((item) => item.code));
    packet.block_reasons = blockers;
  }
  finalize_apply_worker_packet(packet);
  packet.chain_activation_template.executor_packet_fingerprint = packet.guard_fingerprint;
  return packet;
}

function apply_code_review_packet(ctx: PacketContext, args: ParsedArgs): JsonMap {
  const taskId = args.task_id ?? "";
  const blockers: Reason[] = [];
  const applyReady = evaluate_workflow_decision(ctx, "apply_ready");
  if (!applyReady.allowed) blockers.push(...decision_reasons(applyReady));
  const taskEdit = evaluate_workflow_decision(ctx, "task_edit", taskId);
  if (!taskEdit.allowed) blockers.push(...decision_reasons(taskEdit));
  const { task, blockers: taskBlockers } = task_lookup_blockers(ctx, taskId);
  blockers.push(...taskBlockers);
  const writeScope = task ? splitList(task.attrs.write_scope ?? "") : [];
  blockers.push(...write_scope_blockers(taskId, writeScope));
  const chainId = require_active_apply_worker_chain(ctx, taskId, blockers);
  const activeChain = active_apply_worker_chain(ctx, taskId).active;
  if (chainId) {
    const executorRefs = validate_worker_report_refs(ctx, args.executor_report_refs ?? [], {
      role: "executor",
      taskId,
      chainId,
      missingCode: "missing_executor_report_ref",
      missingMessage: "apply-code-review-packet requires --executor-report-ref",
    });
    blockers.push(...executorRefs.blockers);
    if (executorRefs.refs[0]) {
      blockers.push(...worker_report_origin_blockers(executorRefs.refs[0], activeChain?.executor_packet_fingerprint, "executor_report_ref"));
      if (activeChain) {
        blockers.push(...worker_report_input_digest_blockers(executorRefs.refs[0], apply_worker_executor_input_ref_digest(ctx.evidences, activeChain), "executor_report_ref"));
      }
    }
    const packet = apply_packet_common(ctx, "apply_code_review", taskId, "executor_worker", blockers);
    packet.apply_worker_chain_id = chainId;
    packet.declared_task_write_scope = writeScope;
    packet.executor_report_pinned_refs = executorRefs.refs;
    packet.executor_report_refs = args.executor_report_refs ?? [];
    packet.expected_executor_origin_packet_fingerprint = activeChain?.executor_packet_fingerprint;
    if (activeChain) packet.expected_executor_input_ref_digest = apply_worker_executor_input_ref_digest(ctx.evidences, activeChain);
    packet.executor_report_required_fields = [...APPLY_EXECUTOR_REPORT_REQUIRED_FIELDS];
    packet.code_review_report_required_fields = [...APPLY_CODE_REVIEW_REPORT_REQUIRED_FIELDS];
    packet.task_edit = decision_status(taskEdit);
    Object.assign(packet, apply_task_context_fields(ctx, taskId, task, writeScope, executorRefs.refs));
    packet.code_review_checks = [
      "executor_report_matches_current_diff",
      "changed_files_within_declared_task_write_scope",
      "protected_paths_unchanged",
      "test_and_invariant_mapping_supported",
      "suggest_green_test_ids",
    ];
    packet.worker_state = blockers.length === 0 ? "ready" : "blocked";
    if (blockers.length > 0) {
      packet.blockers = unique_strings(blockers.map((item) => item.code));
      packet.block_reasons = blockers;
    }
    return finalize_apply_worker_packet(packet);
  }
  const packet = apply_packet_common(ctx, "apply_code_review", taskId, "executor_worker", blockers);
  packet.declared_task_write_scope = writeScope;
  packet.executor_report_refs = args.executor_report_refs ?? [];
  packet.executor_report_required_fields = [...APPLY_EXECUTOR_REPORT_REQUIRED_FIELDS];
  packet.code_review_report_required_fields = [...APPLY_CODE_REVIEW_REPORT_REQUIRED_FIELDS];
  packet.task_edit = decision_status(taskEdit);
  Object.assign(packet, apply_task_context_fields(ctx, taskId, task, writeScope));
  return finalize_apply_worker_packet(packet);
}

function apply_verify_packet(ctx: PacketContext, args: ParsedArgs): JsonMap {
  const taskId = args.task_id ?? "";
  const blockers: Reason[] = [];
  const applyReady = evaluate_workflow_decision(ctx, "apply_ready");
  if (!applyReady.allowed) blockers.push(...decision_reasons(applyReady));
  const taskEdit = evaluate_workflow_decision(ctx, "task_edit", taskId);
  if (!taskEdit.allowed) blockers.push(...decision_reasons(taskEdit));
  const { task, blockers: taskBlockers } = task_lookup_blockers(ctx, taskId);
  blockers.push(...taskBlockers);
  const writeScope = task ? splitList(task.attrs.write_scope ?? "") : [];
  blockers.push(...write_scope_blockers(taskId, writeScope));
  const chainId = require_active_apply_worker_chain(ctx, taskId, blockers);
  const activeChain = active_apply_worker_chain(ctx, taskId).active;
  const packet = apply_packet_common(ctx, "apply_verify", taskId, "executor_worker", blockers);
  if (chainId) {
    const executorRefs = validate_worker_report_refs(ctx, args.executor_report_refs ?? [], {
      role: "executor",
      taskId,
      chainId,
      missingCode: "missing_executor_report_ref",
      missingMessage: "apply-verify-packet requires --executor-report-ref",
    });
    const codeReviewRefs = validate_worker_report_refs(ctx, args.task_code_review_report_refs ?? [], {
      role: "code-reviewer",
      taskId,
      chainId,
      missingCode: "missing_task_code_review_report_ref",
      missingMessage: "apply-verify-packet requires --task-code-review-report-ref",
    });
    const greenRefs = validate_test_run_evidence_refs(ctx, args.green_test_run_evidence_refs ?? [], {
      taskId,
      gate: "task_complete",
      phase: "green",
      semanticStatus: "expected_success",
      chainId,
      missingCode: "missing_green_test_run_evidence_ref",
      missingMessage: "apply-verify-packet requires --green-test-run-evidence-ref",
    });
    const redRefs = validate_test_run_evidence_refs(ctx, args.red_test_run_evidence_refs ?? [], {
      taskId,
      gate: "task_edit",
      phase: "red",
      semanticStatus: "expected_failure",
      chainId: null,
      missingCode: "missing_red_test_run_evidence_ref",
      missingMessage: "apply-verify-packet requires --red-test-run-evidence-ref",
    });
    const characterizationRefs = validate_test_run_evidence_refs(ctx, args.characterization_test_run_evidence_refs ?? [], {
      taskId,
      gate: "task_edit",
      phase: "characterization",
      semanticStatus: "expected_success",
      chainId: null,
      missingCode: "missing_characterization_test_run_evidence_ref",
      missingMessage: "apply-verify-packet requires --characterization-test-run-evidence-ref",
    });
    blockers.push(...executorRefs.blockers, ...codeReviewRefs.blockers, ...greenRefs.blockers);
    if (executorRefs.refs[0]) {
      blockers.push(...worker_report_origin_blockers(executorRefs.refs[0], activeChain?.executor_packet_fingerprint, "executor_report_ref"));
      if (activeChain) {
        blockers.push(...worker_report_input_digest_blockers(executorRefs.refs[0], apply_worker_executor_input_ref_digest(ctx.evidences, activeChain), "executor_report_ref"));
      }
    }
    if (executorRefs.refs[0] && codeReviewRefs.refs[0]) {
      blockers.push(...worker_report_input_blockers(codeReviewRefs.refs[0], [executorRefs.refs[0]], "task_code_review_report_ref"));
    }
    if ((args.red_test_run_evidence_refs ?? []).length === 0 && (args.characterization_test_run_evidence_refs ?? []).length === 0) {
      blockers.push(reason("missing_pre_edit_test_run_evidence_ref", "apply-verify-packet requires --red-test-run-evidence-ref or --characterization-test-run-evidence-ref"));
    } else {
      if ((args.red_test_run_evidence_refs ?? []).length > 0) blockers.push(...redRefs.blockers, ...pre_edit_refs_bound_to_active_chain(ctx, activeChain, redRefs.refs, "red", taskId));
      if ((args.characterization_test_run_evidence_refs ?? []).length > 0) blockers.push(...characterizationRefs.blockers, ...pre_edit_refs_bound_to_active_chain(ctx, activeChain, characterizationRefs.refs, "characterization", taskId));
    }
    packet.apply_worker_chain_id = chainId;
    packet.executor_report_pinned_refs = executorRefs.refs;
    packet.task_code_review_report_pinned_refs = codeReviewRefs.refs;
    packet.green_test_run_evidence_pinned_refs = greenRefs.refs;
    packet.red_test_run_evidence_pinned_refs = redRefs.refs;
    packet.characterization_test_run_evidence_pinned_refs = characterizationRefs.refs;
    if (executorRefs.refs[0]) packet.expected_executor_origin_packet_fingerprint = activeChain?.executor_packet_fingerprint;
    if (executorRefs.refs[0] && activeChain) packet.expected_executor_input_ref_digest = apply_worker_executor_input_ref_digest(ctx.evidences, activeChain);
    if (executorRefs.refs[0] && codeReviewRefs.refs[0]) {
      packet.expected_code_review_input_ref_digest = worker_input_ref_digest([executorRefs.refs[0]]);
    }
    if (executorRefs.refs[0] && codeReviewRefs.refs[0] && greenRefs.refs[0]) {
      const canonicalGreenRefs = [...greenRefs.refs].sort((a: JsonMap, b: JsonMap) => String(a.evidence_id ?? "").localeCompare(String(b.evidence_id ?? "")));
      const expectedFreshness = compute_apply_worker_freshness(ctx.repoRoot, ctx.changeRoot, ctx.evidences, taskId, chainId, {
        executor_report_ref: executorRefs.refs[0],
        task_code_review_report_ref: codeReviewRefs.refs[0],
        green_test_run_evidence_ref: String(canonicalGreenRefs[0].evidence_id ?? ""),
        green_test_run_evidence_refs: canonicalGreenRefs.map((ev) => String(ev.evidence_id ?? "")).filter(Boolean),
      });
      packet.expected_freshness_fingerprint = expectedFreshness;
      const preEditRefs = [
        ...(Array.isArray(packet.red_test_run_evidence_pinned_refs) ? packet.red_test_run_evidence_pinned_refs : []),
        ...(Array.isArray(packet.characterization_test_run_evidence_pinned_refs) ? packet.characterization_test_run_evidence_pinned_refs : []),
      ];
      packet.expected_verifier_input_ref_digest = worker_input_ref_digest([
        executorRefs.refs[0],
        codeReviewRefs.refs[0],
        ...canonicalGreenRefs.map((ev: JsonMap) => ({ kind: "test_run", evidence_id: String(ev.evidence_id ?? ""), phase: ev.phase, semantic_status: ev.semantic_status })),
        ...preEditRefs.map((ev: JsonMap) => ({ kind: "test_run", evidence_id: String(ev.evidence_id ?? ""), phase: ev.phase, semantic_status: ev.semantic_status })),
      ]);
      const missingGreenFingerprint = greenRefs.refs.filter((ev) => !fingerprint_digest(ev.implementation_fingerprint));
      if (missingGreenFingerprint.length > 0) {
        blockers.push(reason("green_implementation_fingerprint_missing", "apply-verify-packet requires GREEN evidence to record implementation_fingerprint"));
      } else if (!greenRefs.refs.every((ev) => fingerprint_matches(ev.implementation_fingerprint, expectedFreshness.implementation_fingerprint))) {
        blockers.push(reason("green_implementation_fingerprint_mismatch", "apply-verify-packet requires current implementation fingerprint to match GREEN evidence implementation_fingerprint"));
      }
      if (!fingerprint_matches(codeReviewRefs.refs[0].observed_implementation_fingerprint, expectedFreshness.implementation_fingerprint)) {
        blockers.push(reason("task_code_review_implementation_fingerprint_mismatch", "apply-verify-packet requires code-reviewer observed_implementation_fingerprint to match current implementation fingerprint"));
      }
      if (Array.isArray(expectedFreshness.protected_dirty_paths) && expectedFreshness.protected_dirty_paths.length > 0) {
        blockers.push(reason("protected_path_dirty", `apply-verify-packet requires protected change artifacts to stay unchanged during executor-worker verification: ${renderList(expectedFreshness.protected_dirty_paths.map(String))}`, expectedFreshness.protected_dirty_paths.map(String)));
      }
    }
  }
  packet.declared_task_write_scope = writeScope;
  packet.task_edit = decision_status(taskEdit);
  packet.task_complete = safe_decision_status(ctx, "task_complete", taskId);
  Object.assign(packet, apply_task_context_fields(ctx, taskId, task, writeScope, [
    ...(Array.isArray(packet.executor_report_pinned_refs) ? packet.executor_report_pinned_refs : []),
    ...(Array.isArray(packet.task_code_review_report_pinned_refs) ? packet.task_code_review_report_pinned_refs : []),
  ]));
  packet.current_worktree_refs = dirty_repo_refs(ctx, "apply_verify current worktree refs");
  packet.protected_path_refs = Array.isArray(packet.expected_freshness_fingerprint?.protected_path_refs)
    ? packet.expected_freshness_fingerprint.protected_path_refs
    : apply_worker_protected_path_refs(ctx.repoRoot, ctx.changeRoot);
  packet.scope_diff_review_policy = {
    declared_task_write_scope: writeScope,
    forbidden_paths: ["proposal.md", "design.md", "tasks.md", "specs/", ".superspec/"],
    require_scope_verdict: true,
  };
  packet.verification_checks = [
    "red_or_characterization_pre_edit_evidence_bound_to_active_chain",
    "executor_report_same_chain_and_fresh",
    "task_code_review_report_same_chain_and_fresh",
    "green_test_run_same_chain_and_pinned_transcripts",
    "current_freshness_matches_expected_freshness_fingerprint",
    "protected_change_artifacts_clean",
  ];
  packet.executor_report_required_fields = [...APPLY_EXECUTOR_REPORT_REQUIRED_FIELDS];
  packet.code_review_report_required_fields = [...APPLY_CODE_REVIEW_REPORT_REQUIRED_FIELDS];
  packet.verifier_report_required_fields = [...APPLY_VERIFIER_REPORT_REQUIRED_FIELDS];
  packet.test_evidence_required_fields = ["command", "cwd", "exit_code", "repo_head", "implementation_fingerprint", "guard_artifact_manifest_fingerprint", "raw_log_pinned_refs"];
  packet.executor_report_refs = args.executor_report_refs ?? [];
  packet.task_code_review_report_refs = args.task_code_review_report_refs ?? [];
  packet.green_test_run_evidence_refs = args.green_test_run_evidence_refs ?? [];
  packet.red_test_run_evidence_refs = args.red_test_run_evidence_refs ?? [];
  packet.characterization_test_run_evidence_refs = args.characterization_test_run_evidence_refs ?? [];
  packet.worker_state = blockers.length === 0 ? "ready" : "blocked";
  if (blockers.length > 0) {
    packet.blockers = unique_strings(blockers.map((item) => item.code));
    packet.block_reasons = blockers;
  }
  return finalize_apply_worker_packet(packet);
}

function render_apply_worker_prompt(packet: JsonMap): string {
  const blockedHeaders: Record<string, string> = {
    apply_test: "DO NOT SPAWN TEST-RUNNER",
    apply_executor: "DO NOT SPAWN IMPLEMENTATION EXECUTOR",
    apply_code_review: "DO NOT SPAWN IMPLEMENTATION CODE-REVIEWER",
    apply_verify: "DO NOT SPAWN IMPLEMENTATION VERIFIER",
  };
  const lines: string[] = [];
  if (packet.worker_state === "blocked") {
    lines.push(blockedHeaders[String(packet.packet_kind)] ?? "DO NOT SPAWN WORKER", "");
  } else {
    lines.push("# SuperSpec Apply Worker Packet", "");
  }
  lines.push(
    `packet_kind: ${String(packet.packet_kind)}`,
    `change: ${String(packet.change)}`,
    `task_id: ${String(packet.task_id)}`,
    `worker_state: ${String(packet.worker_state)}`,
    `worker_chain_context: ${String(packet.worker_chain_context)}`,
  );
  if (typeof packet.test_id === "string") lines.push(`test_id: ${packet.test_id}`);
  if (typeof packet.phase === "string") lines.push(`phase: ${packet.phase}`);
  if (typeof packet.allowed_test_command === "string") lines.push(`allowed_test_command: ${packet.allowed_test_command}`);
  if (typeof packet.apply_worker_chain_id === "string") lines.push(`apply_worker_chain_id: ${packet.apply_worker_chain_id}`);
  if (packet.packet_kind === "apply_executor" && packet.worker_state === "ready") {
    lines.push(
      "",
      "CHAIN ACTIVATION VERIFIED FOR IMPLEMENTATION EXECUTOR",
      "The active apply_worker_chain evidence ref has been validated for this prompt.",
      "",
      "chain_activation_template:",
      JSON.stringify(packet.chain_activation_template ?? {}, null, 2),
    );
  }
  if (packet.worker_state === "ready") {
    lines.push("", "Packet JSON:", JSON.stringify(packet, null, 2));
  }
  if (Array.isArray(packet.blockers) && packet.blockers.length > 0) {
    lines.push("", "Blockers:", ...packet.blockers.map((item: string) => `- ${item}`));
  }
  if (Array.isArray(packet.block_reasons) && packet.block_reasons.length > 0) {
    lines.push("", "Blocker details:", ...packet.block_reasons.map((item: Reason) => `- ${item.code}: ${item.message}`));
  }
  if (Array.isArray(packet.stop_conditions) && packet.stop_conditions.length > 0) {
    lines.push("", "Stop conditions:", ...packet.stop_conditions.map((item: string) => `- ${item}`));
  }
  return `${lines.join("\n")}\n`;
}

function render_ref(ref: PinnedRef): string {
  return `- ${ref.root}:${ref.path} @ ${ref.blob_sha}`;
}

function render_review_prompt(ctx: PacketContext, packet: ReviewPacket): string {
  const lines: string[] = [
    `# SuperSpec Review Packet`,
    "",
    `consumer: ${packet.consumer}`,
    `gate: ${packet.gate}`,
    `role: ${packet.role}`,
    `round: ${packet.round}`,
    "",
    `Target refs:`,
    ...(packet.target_refs.length > 0 ? packet.target_refs.map(render_ref) : ["- none"]),
    "",
    `Source refs:`,
    ...(packet.source_refs.length > 0 ? packet.source_refs.map(render_ref) : ["- none"]),
  ];
  if (packet.required_load_refs && packet.required_load_refs.length > 0) {
    lines.push("", "Required load refs:", ...packet.required_load_refs.map(render_ref));
  }
  if (packet.required_claim_ids && packet.required_claim_ids.length > 0) {
    lines.push("", "Required claim ids:", ...packet.required_claim_ids.map((item) => `- ${item}`));
  }
  if (packet.must_read_verbatim_findings && packet.must_read_verbatim_findings.length > 0) {
    lines.push(
      "",
      "Must read verbatim findings:",
      ...packet.must_read_verbatim_findings.map((item) => `- ${item.evidence_id} :: ${item.finding_uid} @ ${item.evidence_ref.path}`),
    );
  }
  if (packet.must_read_verbatim_decisions && packet.must_read_verbatim_decisions.length > 0) {
    lines.push(
      "",
      "Must read decision bindings:",
      ...packet.must_read_verbatim_decisions.map((item) => `- ${item.evidence_id} :: ${item.decision_scope_key} @ ${item.evidence_ref.path}`),
    );
  }
  lines.push(
    "",
    `Required output kind: ${packet.required_output_kind}`,
    "Output contract fields:",
    ...packet.output_contract_fields.map((item) => `- ${item}`),
  );
  if (packet.required_review_scope && packet.required_review_scope.length > 0) {
    lines.push("", "Required review scope:", ...packet.required_review_scope.map((item) => `- ${item}`));
  }
  lines.push("", "Stop conditions:", ...packet.stop_conditions.map((item) => `- ${item}`));
  if (packet.round > 1 && packet.gate in REVIEW_TARGETS_BY_GATE) {
    lines.push("", render_finding_ledger(packet.gate, build_finding_ledger(packet.gate, ctx.evidences, packet.round)));
  }
  return `${lines.join("\n")}\n`;
}

function render_ledger(ctx: PacketContext, gateRaw: string, round?: number): string {
  const gate = normalize_gate(gateRaw);
  const entries = build_finding_ledger(gate, ctx.evidences, round ?? Number.POSITIVE_INFINITY);
  return `${render_finding_ledger(gate, entries)}\n`;
}

export function dispatch_packet(args: ParsedArgs): PacketDispatchResult {
  const ctx = load_packet_context(args.change);
  if (args.command === "workflow-packet") {
    const gate = normalize_gate(args.gate ?? "");
    if ((gate === "task_edit" || gate === "task_complete" || gate === "task_reopen") && !args.task_id) {
      throw new GuardError(`workflow-packet requires --task-id for gate ${gate}`);
    }
    return { output_format: "agent", payload: workflow_packet(ctx, gate, args.task_id) };
  }
  if (args.command === "review-packet") {
    assert_packet_context_clean(ctx);
    const round = args.round ?? 0;
    if (round < 1) throw new GuardError("review-packet requires --round >= 1");
    const packet = review_packet(ctx, args.gate ?? "", args.role ?? "", round, args.evidence_kind);
    if (args.packet_format === "prompt") {
      return { output_format: "prompt", payload: render_review_prompt(ctx, packet) };
    }
    return { output_format: "agent", payload: packet };
  }
  if (args.command === "apply-test-packet") {
    assert_packet_context_clean(ctx);
    const packet = apply_test_packet(ctx, args);
    if (args.packet_format === "prompt") return { output_format: "prompt", payload: render_apply_worker_prompt(packet) };
    return { output_format: "agent", payload: packet };
  }
  if (args.command === "apply-executor-packet") {
    assert_packet_context_clean(ctx);
    const packet = apply_executor_packet(ctx, args);
    if (args.packet_format === "prompt") return { output_format: "prompt", payload: render_apply_worker_prompt(packet) };
    return { output_format: "agent", payload: packet };
  }
  if (args.command === "apply-code-review-packet") {
    assert_packet_context_clean(ctx);
    const packet = apply_code_review_packet(ctx, args);
    if (args.packet_format === "prompt") return { output_format: "prompt", payload: render_apply_worker_prompt(packet) };
    return { output_format: "agent", payload: packet };
  }
  if (args.command === "apply-verify-packet") {
    assert_packet_context_clean(ctx);
    const packet = apply_verify_packet(ctx, args);
    if (args.packet_format === "prompt") return { output_format: "prompt", payload: render_apply_worker_prompt(packet) };
    return { output_format: "agent", payload: packet };
  }
  if (args.command === "ledger-render") {
    assert_packet_context_clean(ctx);
    return { output_format: "prompt", payload: render_ledger(ctx, args.gate ?? "", args.round) };
  }
  throw new GuardError(`unknown packet command: ${args.command}`);
}

export function is_packet_command(command: string): boolean {
  return command === "workflow-packet"
    || command === "review-packet"
    || command === "apply-test-packet"
    || command === "apply-executor-packet"
    || command === "apply-code-review-packet"
    || command === "apply-verify-packet"
    || command === "ledger-render";
}
