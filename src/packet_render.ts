import { existsSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { load_config, sidecar_business_invariants_path, sidecar_discovery_path, sidecar_test_contract_path } from "./paths.ts";
import { type ParsedArgs } from "./cli_args.ts";
import type { PacketDispatchResult, ReviewPacket, WorkflowPacket, PinnedRef, FindingSelector, DecisionSelector } from "./packet_schema.ts";
import {
  CLAIM_ADJUDICATION_DECISIONS,
  FINDING_ADJUDICATION_DECISIONS,
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
  isObject,
  renderList,
  runtime,
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
  if (args.command === "ledger-render") {
    assert_packet_context_clean(ctx);
    return { output_format: "prompt", payload: render_ledger(ctx, args.gate ?? "", args.round) };
  }
  throw new GuardError(`unknown packet command: ${args.command}`);
}

export function is_packet_command(command: string): boolean {
  return command === "workflow-packet" || command === "review-packet" || command === "ledger-render";
}
