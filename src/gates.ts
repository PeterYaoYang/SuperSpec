import { existsSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import type { Decision, JsonMap, Reason } from "./util.ts";
import {
  ARTIFACT_ENTER_GATE,
  MAIN_ADJUDICATION_DECISIONS,
  REQUEST_CHANGES_ROUTES,
  NO_TDD_REASONS,
  OPENSPEC_ARTIFACTS,
  FINAL_VERIFICATION_ROLES,
  REQUIRED_SUPERSPEC_AGENT_ROLES,
  REQUIRED_SUPERSPEC_WORKFLOW_SKILLS,
  REQUIRED_OPENSPEC_CLI_SURFACES,
  REQUIRED_OPENSPEC_CODEX_SKILLS,
  REVIEW_GUIDANCE_ROLES,
  REVIEW_EVIDENCE_REQUIRED_FIELDS,
  TDD_MODES,
  VERIFY_EVIDENCE_REQUIRED_FIELDS,
  allow,
  block,
  commandExists,
  isObject,
  reason,
  renderList,
  repr,
  pinned_ref_key,
  safe_within,
  runCommand,
  sha256_text,
  runtime,
  toPosix,
} from "./util.ts";
import { all_done, artifact_status_map, get_repo_root, is_done, normalize_gate } from "./openspec.ts";
import { read_agent_toml_name, read_skill_frontmatter_name, sidecar_business_invariants_path, sidecar_discovery_path, sidecar_test_contract_path } from "./paths.ts";
import {
  business_invariant_ids,
  business_invariant_validation_reasons,
  automated_hard_business_invariant_ids,
  evidence_invariant_refs,
  evidence_invariant_ref_reasons,
  evidence_test_contract_invariant_reasons,
  human_confirmation_business_invariant_ids,
  invariant_matrix_coverage_reasons,
  post_implementation_business_invariant_ids,
  red_green_invariant_ids,
  test_contract_invariant_ids,
} from "./invariants.ts";
import {
  evidence_test_id_reasons,
  declared_test_evidence_reasons,
  parse_spec_scenarios,
  parse_tasks,
  parse_test_contract_ids,
  parse_test_contract_records,
  red_green_test_ids,
  splitList,
  tasks_structure_hash,
  task_alternative_verification,
  task_test_evidence,
  task_test_refs,
  test_contract_covers_scenario,
  test_contract_invariant_refs_by_test,
  write_scope_conflict_reasons,
} from "./tasks.ts";
import {
  duplicate_evidence_id_reasons,
  dangling_evidence_ref_reasons,
  final_verification_evidences,
  live_task_reopens,
  live_task_reopen_resolutions,
  live_pass,
  pass_task_reopens,
  supersede_reasons,
  unresolved_live_task_reopens,
  validate_evidence_schema,
  verify_reference_reasons,
} from "./evidence.ts";
import { review_disclosure_reasons } from "./disclosure.ts";
import { archive_manifest_path } from "./archive.ts";

function action_list(...items: Array<string | null | undefined | false>): string[] {
  return [...new Set(items.filter((item): item is string => typeof item === "string" && item.length > 0))];
}

const SOURCE_GUIDANCE_REPAIR_REASONS = new Set([
  "review_evidence_incomplete",
  "missing_rollback_target",
  "review_diff_not_covered",
  "review_diff_unavailable",
]);

const MAIN_ADJUDICATION_WRITE_REASONS = new Set([
  "missing_main_adjudication",
  "ambiguous_main_adjudication",
]);

const MAIN_ADJUDICATION_REPAIR_REASONS = new Set([
  "source_guidance_unreferenced",
  "verification_evidence_unreferenced",
  "required_claim_unadjudicated",
  "claim_adjudication_blocked",
  "blocking_findings_open",
  "required_load_unloaded",
]);

const VERIFICATION_REPAIR_REASONS = new Set([
  "verification_evidence_incomplete",
  "verification_ref_invalid",
  "verification_ref_missing",
  "test_evidence_ref_missing",
]);

function reason_codes(reasons: Reason[]): Set<string> {
  return new Set(reasons.map((item) => item.code));
}

function has_reason(codes: Set<string>, wanted: Set<string>): boolean {
  return [...wanted].some((code) => codes.has(code));
}

function review_complete_actions(
  change: string,
  reasons: Reason[],
  pre: Decision,
  opts: { missing_review_roles?: string[]; missing_verification_roles?: string[] } = {},
): string[] {
  const codes = reason_codes(reasons);
  const inheritedReadyActions = !pre.allowed ? pre.next_allowed_actions : [];
  const missingReviewRoles = (opts.missing_review_roles ?? []).sort();
  const missingVerificationRoles = (opts.missing_verification_roles ?? []).sort();
  return action_list(
    ...inheritedReadyActions,
    !pre.allowed && inheritedReadyActions.length === 0 ? `pass check-review-ready for ${change} first` : null,
    missingReviewRoles.length > 0 ? `collect review_complete source_guidance from missing roles: ${renderList(missingReviewRoles)}` : null,
    has_reason(codes, SOURCE_GUIDANCE_REPAIR_REASONS)
      ? "repair source_guidance evidence fields so every review lane has base/head refs, reviewed_files, and rollback_targets"
      : null,
    has_reason(codes, MAIN_ADJUDICATION_WRITE_REASONS)
      ? "write exactly one live main_adjudication referencing every live source_guidance and final verification evidence"
      : null,
    has_reason(codes, MAIN_ADJUDICATION_REPAIR_REASONS)
      ? "repair main_adjudication so it references all source_guidance/final verification evidence and explicitly covers required loads, claims, and blocking findings"
      : null,
    missingVerificationRoles.length > 0 ? `collect verification_review evidence from missing roles: ${renderList(missingVerificationRoles)}` : null,
    has_reason(codes, VERIFICATION_REPAIR_REASONS)
      ? "repair verification_review references so openspec_validate_ref, matrices, scope drift report, and test evidence refs are readable"
      : null,
    codes.has("scope_drift") ? "resolve scope drift before review close: narrow the change or record accepted/none with evidence" : null,
    codes.has("missing_final_tests") ? "record final_test pass evidence and reference it from verification_review" : null,
    codes.has("verify_failure_unconfirmed")
      ? "AskUserQuestion for the failed-verification disposition (fix or accept deviation) and record gate=\"verify_failure_handling\" human_confirmation referencing the failed evidence ids"
      : null,
    codes.has("validate_failed") ? `fix openspec validate failures for ${change}` : null,
  );
}

function request_changes_handoff_actions(adjudication: JsonMap): string[] {
  const route = String(adjudication.request_changes_route ?? "");
  const reopenTaskIds = Array.isArray(adjudication.reopen_task_ids) ? adjudication.reopen_task_ids.map((item) => String(item)).filter(Boolean) : [];
  if (route === "reopen_tasks") {
    return action_list(
      reopenTaskIds.length > 0
        ? `stop review completion and hand off to apply task_reopen for ${renderList(reopenTaskIds)}`
        : "stop review completion and hand off to apply task_reopen",
      "do not add allow-path verification_review/final_test evidence to this request_changes round",
    );
  }
  if (route === "change_update") {
    return action_list(
      "stop review completion and hand off to propose/change update",
      "do not add allow-path verification_review/final_test evidence to this request_changes round",
    );
  }
  return action_list("repair request_changes_route and hand off the review round before retrying review_complete");
}

function blocking_findings(ev: JsonMap): JsonMap[] {
  return (Array.isArray(ev.blocking_findings) ? ev.blocking_findings : []).filter((item) => isObject(item));
}

function string_set(raw: unknown, opts: { allowEmpty?: boolean } = {}): string[] | null {
  if (!Array.isArray(raw)) return null;
  const values = raw.map((item) => String(item)).filter(Boolean);
  if (!opts.allowEmpty && values.length === 0) return null;
  if (values.length !== raw.length) return null;
  return values;
}

function live_request_changes_adjudications(evidences: JsonMap[]): JsonMap[] {
  return live_pass(evidences, { gate: "review_complete", kind: "main_adjudication" })
    .filter((ev) => ev.review_decision === "request_changes");
}

function live_request_changes_reopen_adjudications_for_task(evidences: JsonMap[], taskId: string): JsonMap[] {
  return live_request_changes_adjudications(evidences).filter((ev) => (
    ev.request_changes_route === "reopen_tasks"
    && Array.isArray(ev.reopen_task_ids)
    && ev.reopen_task_ids.map((item: unknown) => String(item)).includes(taskId)
  ));
}

function output_ref_identity(changeRoot: string, ev: JsonMap): string | null {
  if (typeof ev.output_ref !== "string" || !ev.output_ref) return null;
  const outputPath = safe_within(changeRoot, ev.output_ref);
  if (outputPath === null || !existsSync(outputPath) || !statSync(outputPath).isFile()) return ev.output_ref;
  const st = statSync(outputPath);
  return `${st.dev}:${st.ino}`;
}

function duplicate_output_ref_reasons(changeRoot: string, evidences: JsonMap[]): Reason[] {
  const byRef = new Map<string, { refs: Set<string>; ids: string[] }>();
  for (const ev of evidences) {
    const identity = output_ref_identity(changeRoot, ev);
    if (identity === null) continue;
    const bucket = byRef.get(identity) ?? { refs: new Set(), ids: [] };
    bucket.refs.add(String(ev.output_ref));
    bucket.ids.push(String(ev.evidence_id ?? ev._path ?? ev.kind ?? "unknown"));
    byRef.set(identity, bucket);
  }
  const problems: Reason[] = [];
  for (const bucket of byRef.values()) {
    if (bucket.ids.length > 1) {
      const refs = [...bucket.refs].sort();
      const ids = bucket.ids.sort();
      problems.push(reason("evidence_output_ref_duplicate", `review evidence output_ref must be unique, ${renderList(refs)} is shared by: ${renderList(ids)}`, ids));
    }
  }
  return problems;
}

// FIX-11 (audit H-1): a propose-phase review stamp is a per-gate contract, not a rubber stamp.
// Within one gate, live/pass role evidence must not reuse the same output_ref (same dedup as
// review_complete). Reusing one output_ref across gates (the omnibus "refresh" pattern) is only
// legal when the evidence declares review_scope[] explicitly covering this gate's target artifact.
const PROPOSE_REVIEW_TARGET_ARTIFACTS: Record<string, string> = {
  explore_complete: ".superspec/artifacts/discovery.md",
  proposal_reviewed: "proposal.md",
  design_complete: "design.md",
  invariants_reviewed: ".superspec/artifacts/business-invariants.md",
  test_contract_drafted: ".superspec/artifacts/test-contract.md",
};

function propose_review_output_ref_reasons(changeRoot: string, evidences: JsonMap[], gate: string): Reason[] {
  const target = PROPOSE_REVIEW_TARGET_ARTIFACTS[gate];
  if (!target) return [];
  const gateReviews = live_pass(evidences, { gate });
  const problems = duplicate_output_ref_reasons(changeRoot, gateReviews);
  const foreign = live_pass(evidences).filter((ev) => normalize_gate(String(ev.gate ?? "")) !== gate);
  for (const ev of gateReviews) {
    const identity = output_ref_identity(changeRoot, ev);
    if (identity === null) continue;
    const reusedAcrossGates = foreign.some((other) => output_ref_identity(changeRoot, other) === identity);
    if (!reusedAcrossGates) continue;
    const scope = Array.isArray(ev.review_scope)
      ? ev.review_scope.filter((item: unknown) => typeof item === "string").map((item: unknown) => toPosix(String(item)))
      : [];
    if (!scope.includes(target)) {
      const id = String(ev.evidence_id ?? ev._path ?? ev.kind ?? "unknown");
      problems.push(reason(
        "review_scope_unverified",
        `${id}: output_ref ${repr(String(ev.output_ref))} is reused across gates; ${gate} requires review_scope[] covering ${target}`,
        [id],
      ));
    }
  }
  return problems;
}

function main_adjudication_source_guidance_reasons(adjudication: JsonMap, sourceGuidance: JsonMap[]): Reason[] {
  const reasons: Reason[] = [];
  const requiredClaims = new Set<string>();
  const requiredLoads = new Map<string, JsonMap>();
  const requiredFindings = new Set<string>();
  for (const ev of sourceGuidance) {
    for (const claimId of Array.isArray(ev.required_claim_ids) ? ev.required_claim_ids : []) requiredClaims.add(String(claimId));
    for (const refItem of Array.isArray(ev.required_load_refs) ? ev.required_load_refs : []) {
      if (isObject(refItem) && typeof refItem.path === "string" && typeof refItem.blob_sha === "string") {
        requiredLoads.set(pinned_ref_key(refItem), refItem);
      }
    }
    for (const finding of Array.isArray(ev.blocking_findings) ? ev.blocking_findings : []) {
      if (isObject(finding) && typeof finding.finding_id === "string" && finding.finding_id) requiredFindings.add(finding.finding_id);
    }
  }
  const claimCounts = new Map<string, number>();
  const claimNeedsFix: string[] = [];
  for (const item of Array.isArray(adjudication.claim_adjudications) ? adjudication.claim_adjudications : []) {
    if (!isObject(item) || typeof item.claim_id !== "string" || !item.claim_id) continue;
    claimCounts.set(item.claim_id, (claimCounts.get(item.claim_id) ?? 0) + 1);
    if (item.decision === "needs_fix") claimNeedsFix.push(item.claim_id);
  }
  const missingClaims = [...requiredClaims].filter((id) => !claimCounts.has(id)).sort();
  if (missingClaims.length > 0) {
    reasons.push(reason("required_claim_unadjudicated", `${adjudication._path}: main_adjudication must cover required_claim_ids from source_guidance: ${renderList(missingClaims)}`, missingClaims));
  }
  const duplicatedClaims = [...claimCounts.entries()].filter(([, count]) => count > 1).map(([id]) => id).sort();
  if (duplicatedClaims.length > 0) {
    reasons.push(reason("required_claim_unadjudicated", `${adjudication._path}: claim_adjudications must cover required_claim_ids exactly once: ${renderList(duplicatedClaims)}`, duplicatedClaims));
  }
  if (claimNeedsFix.length > 0) {
    reasons.push(reason("claim_adjudication_blocked", `${adjudication._path}: claim_adjudications still contain needs_fix: ${renderList(claimNeedsFix.sort())}`, claimNeedsFix.sort()));
  }
  const findingCounts = new Map<string, number>();
  const openFindings: string[] = [];
  for (const item of Array.isArray(adjudication.finding_adjudications) ? adjudication.finding_adjudications : []) {
    if (!isObject(item) || typeof item.finding_id !== "string" || !item.finding_id) continue;
    findingCounts.set(item.finding_id, (findingCounts.get(item.finding_id) ?? 0) + 1);
    if (item.decision === "needs_fix") openFindings.push(item.finding_id);
  }
  const missingFindings = [...requiredFindings].filter((id) => !findingCounts.has(id)).sort();
  if (missingFindings.length > 0) {
    reasons.push(reason("blocking_findings_open", `${adjudication._path}: finding_adjudications must cover every blocking finding exactly once: ${renderList(missingFindings)}`, missingFindings));
  }
  const duplicatedFindings = [...findingCounts.entries()].filter(([, count]) => count > 1).map(([id]) => id).sort();
  if (duplicatedFindings.length > 0) {
    reasons.push(reason("blocking_findings_open", `${adjudication._path}: finding_adjudications duplicate blocking finding ids: ${renderList(duplicatedFindings)}`, duplicatedFindings));
  }
  if (openFindings.length > 0) {
    reasons.push(reason("blocking_findings_open", `${adjudication._path}: blocking findings still require fixes: ${renderList(openFindings.sort())}`, openFindings.sort()));
  }
  const loadedPaths = new Set(
    (Array.isArray(adjudication.loaded_refs) ? adjudication.loaded_refs : [])
      .filter((item) => isObject(item) && typeof item.path === "string")
      .map((item) => pinned_ref_key(item)),
  );
  const missingLoads = [...requiredLoads.entries()].filter(([key]) => !loadedPaths.has(key)).map(([, item]) => String(item.path)).sort();
  if (missingLoads.length > 0) {
    reasons.push(reason("required_load_unloaded", `${adjudication._path}: main_adjudication must load required source refs before deciding: ${renderList(missingLoads)}`, missingLoads));
  }
  return reasons;
}

function request_changes_round_reasons(evidences: JsonMap[]): Reason[] {
  const reasons: Reason[] = [];
  const liveSourceGuidance = live_pass(evidences, { gate: "review_complete", kind: "source_guidance" });
  const liveSourceGuidanceById = new Map(liveSourceGuidance.map((ev) => [String(ev.evidence_id), ev]));
  for (const adjudication of live_request_changes_adjudications(evidences)) {
    const route = String(adjudication.request_changes_route ?? "");
    reasons.push(...main_adjudication_source_guidance_reasons(adjudication, liveSourceGuidance));
    if (route !== "reopen_tasks") continue;
    const sourceEvidenceIds = (Array.isArray(adjudication.source_evidence_refs) ? adjudication.source_evidence_refs : []).map((item) => String(item)).filter(Boolean);
    const sourceEvidenceIdSet = new Set(sourceEvidenceIds);
    const blockingSourceIds = (Array.isArray(adjudication.blocking_source_evidence_refs) ? adjudication.blocking_source_evidence_refs : []).map((item) => String(item)).filter(Boolean);
    const blockingSourceIdSet = new Set(blockingSourceIds);
    const reopenTaskIds = (Array.isArray(adjudication.reopen_task_ids) ? adjudication.reopen_task_ids : []).map((item) => String(item)).filter(Boolean);
    const missingLiveSourceGuidance = liveSourceGuidance
      .map((source) => String(source.evidence_id ?? ""))
      .filter(Boolean)
      .filter((evidenceId) => !sourceEvidenceIdSet.has(evidenceId))
      .sort();
    if (missingLiveSourceGuidance.length > 0) {
      reasons.push(reason(
        "main_adjudication_invalid",
        `${adjudication._path}: request_changes main_adjudication must reference every live/pass source_guidance in source_evidence_refs: ${renderList(missingLiveSourceGuidance)}`,
        missingLiveSourceGuidance,
      ));
    }
    const unknownSourceRefs = sourceEvidenceIds.filter((evidenceId) => !liveSourceGuidanceById.has(evidenceId)).sort();
    if (unknownSourceRefs.length > 0) {
      reasons.push(reason(
        "main_adjudication_invalid",
        `${adjudication._path}: request_changes source_evidence_refs must reference live/pass review_complete source_guidance evidence only: ${renderList(unknownSourceRefs)}`,
        unknownSourceRefs,
      ));
    }
    const blockerSourcesMissingFromBlockingRefs: string[] = [];
    for (const source of liveSourceGuidance) {
      const evidenceId = String(source.evidence_id ?? "");
      if (!evidenceId) continue;
      if (blocking_findings(source).length === 0) continue;
      if (!blockingSourceIdSet.has(evidenceId)) blockerSourcesMissingFromBlockingRefs.push(evidenceId);
    }
    if (blockerSourcesMissingFromBlockingRefs.length > 0) {
      reasons.push(reason(
        "main_adjudication_invalid",
        `${adjudication._path}: request_changes_route='reopen_tasks' must include every source_guidance with blocking_findings in blocking_source_evidence_refs: ${renderList(blockerSourcesMissingFromBlockingRefs.sort())}`,
        blockerSourcesMissingFromBlockingRefs.sort(),
      ));
    }
    const blockingGuidance: JsonMap[] = [];
    for (const evidenceId of blockingSourceIds) {
      const source = liveSourceGuidanceById.get(evidenceId);
      if (!source) {
        reasons.push(reason("main_adjudication_invalid", `${adjudication._path}: blocking_source_evidence_refs must reference live/pass review_complete source_guidance evidence: ${evidenceId}`, [evidenceId]));
        continue;
      }
      blockingGuidance.push(source);
    }
    const findingCoverage = new Map<string, number>();
    for (const source of blockingGuidance) {
      const findings = blocking_findings(source);
      if (findings.length === 0) {
        reasons.push(reason("mixed_request_changes_route", `${adjudication._path}: request_changes_route='reopen_tasks' requires blocking findings on ${source._path}`));
        continue;
      }
      if (source.agent_role !== "code-reviewer") {
        reasons.push(reason(
          "mixed_request_changes_route",
          `${adjudication._path}: request_changes_route='reopen_tasks' can only authorize task reopen from code-reviewer source_guidance, got ${repr(source.agent_role)} at ${source._path}`,
        ));
        continue;
      }
      for (const finding of findings) {
        const affected = string_set(finding.affected_task_ids);
        if (affected === null) {
          const findingId = typeof finding.finding_id === "string" && finding.finding_id ? finding.finding_id : "<unknown>";
          reasons.push(reason(
            "mixed_request_changes_route",
            `${adjudication._path}: request_changes_route='reopen_tasks' requires blocking finding ${repr(findingId)} from ${source._path} to provide non-empty affected_task_ids`,
          ));
          continue;
        }
        for (const taskId of affected) findingCoverage.set(taskId, (findingCoverage.get(taskId) ?? 0) + 1);
      }
    }
    for (const taskId of reopenTaskIds) {
      if ((findingCoverage.get(taskId) ?? 0) === 0) {
        reasons.push(reason("main_adjudication_invalid", `${adjudication._path}: request_changes_route='reopen_tasks' requires reopen-compatible blocking findings covering task ${taskId}`, [taskId]));
      }
    }
  }
  return reasons;
}

function archive_ready_actions(change: string, reasons: Reason[], review: Decision): string[] {
  const codes = reason_codes(reasons);
  const inheritedReviewActions = !review.allowed ? review.next_allowed_actions : [];
  return action_list(
    ...inheritedReviewActions,
    !review.allowed && inheritedReviewActions.length === 0 ? `pass check-review-complete for ${change} first` : null,
    codes.has("missing_final_confirmation") ? "record archive_ready human_confirmation evidence before calling openspec archive -y" : null,
    codes.has("validate_failed") ? `fix openspec validate failures for ${change}` : null,
  );
}

function default_gate_next_actions(gate: string): string[] {
  switch (gate) {
    case "explore_complete":
      return ["write .superspec/artifacts/discovery.md and record native_subagent critic evidence"];
    case "proposal_reviewed":
      return ["run the proposal critic review (round-tagged, findings[]) and record a main_review_digest disclosing every finding"];
    case "design_complete":
      return ["finish design.md, collect architect/critic/test-engineer evidence, and record design_complete human confirmation"];
    case "invariants_reviewed":
      return ["write .superspec/artifacts/business-invariants.md, collect critic/test-engineer evidence, and record required invariant confirmations"];
    case "test_contract_drafted":
      return ["write .superspec/artifacts/test-contract.md covering every Scenario and hard INV, then collect critic/test-engineer evidence"];
    case "test_contract_honored":
      return ["map every TEST-* and INV-* from test-contract into tasks.md and matching RED/GREEN evidence"];
    case "tasks_complete":
      return ["finish structured tasks.md metadata and resolve parallel_group/write_scope conflicts"];
    case "propose_complete":
      return ["pass explore_complete, proposal_reviewed, design_complete, invariants_reviewed, test_contract_drafted, and tasks_complete"];
    default:
      return [];
  }
}

export function openspec_init_reasons(repoRoot: string): Reason[] {
  const reasons: Reason[] = [];
  reasons.push(...runtime.openspec_cli_capability_reasons());
  const skillsRoot = join(repoRoot, ".codex", "skills");
  const missing = REQUIRED_OPENSPEC_CODEX_SKILLS.filter((name) => !existsSync(join(skillsRoot, name, "SKILL.md")));
  if (missing.length > 0) {
    reasons.push(reason(
      "openspec_init_missing",
      "OpenSpec native Codex skills are missing; run `openspec init --tools codex .` or `openspec update --force .` from the repository root",
      missing,
    ));
  }
  for (const name of REQUIRED_OPENSPEC_CODEX_SKILLS) {
    const skillPath = join(skillsRoot, name, "SKILL.md");
    if (!existsSync(skillPath)) continue;
    const declared = read_skill_frontmatter_name(skillPath);
    if (declared !== name) {
      reasons.push(reason("openspec_native_surface_invalid", `OpenSpec native skill ${skillPath} has invalid front matter name ${repr(declared)}`, [skillPath]));
    }
  }
  return reasons;
}

// D4 (audit G-2): check-init must notice when SuperSpec's own workflow skills are missing or
// corrupted, otherwise a deleted .codex/skills/superspec-* surface stays invisible end to end.
export function superspec_workflow_skill_reasons(repoRoot: string): Reason[] {
  const reasons: Reason[] = [];
  const skillsRoot = join(repoRoot, ".codex", "skills");
  const missing = REQUIRED_SUPERSPEC_WORKFLOW_SKILLS.filter((name) => !existsSync(join(skillsRoot, name, "SKILL.md")));
  if (missing.length > 0) {
    reasons.push(reason(
      "superspec_init_missing",
      "SuperSpec workflow skills are missing; run superspec-init (or this repository's superspec_init.ts) to (re)install them",
      missing,
    ));
  }
  for (const name of REQUIRED_SUPERSPEC_WORKFLOW_SKILLS) {
    const skillPath = join(skillsRoot, name, "SKILL.md");
    if (!existsSync(skillPath)) continue;
    const declared = read_skill_frontmatter_name(skillPath);
    if (declared !== name) {
      reasons.push(reason("superspec_skill_invalid", `SuperSpec workflow skill ${skillPath} has invalid front matter name ${repr(declared)}`, [skillPath]));
    }
  }
  return reasons;
}

export function superspec_agent_reasons(repoRoot: string): Reason[] {
  const reasons: Reason[] = [];
  const agentsRoot = join(repoRoot, ".codex", "agents");
  const promptsRoot = join(repoRoot, ".codex", "prompts");
  const missingAgents = REQUIRED_SUPERSPEC_AGENT_ROLES.filter((name) => !existsSync(join(agentsRoot, `${name}.toml`)));
  if (missingAgents.length > 0) {
    reasons.push(reason(
      "superspec_agent_missing",
      "repo-local superspec native agent definitions are missing; install .codex/agents/*.toml with the superspec distribution",
      missingAgents,
    ));
  }
  const missingPrompts = REQUIRED_SUPERSPEC_AGENT_ROLES.filter((name) => !existsSync(join(promptsRoot, `${name}.md`)));
  if (missingPrompts.length > 0) {
    reasons.push(reason(
      "superspec_prompt_missing",
      "repo-local superspec role prompts are missing; install .codex/prompts/*.md with the superspec distribution",
      missingPrompts,
    ));
  }
  for (const name of REQUIRED_SUPERSPEC_AGENT_ROLES) {
    const agentPath = join(agentsRoot, `${name}.toml`);
    if (!existsSync(agentPath)) continue;
    const declared = read_agent_toml_name(agentPath);
    if (declared !== name) {
      reasons.push(reason("superspec_agent_invalid", `superspec native agent ${agentPath} has invalid name ${repr(declared)}`, [agentPath]));
    }
  }
  for (const name of REQUIRED_SUPERSPEC_AGENT_ROLES) {
    const promptPath = join(promptsRoot, `${name}.md`);
    if (!existsSync(promptPath)) continue;
    if (!readFileSync(promptPath, "utf8").trim()) {
      reasons.push(reason("superspec_prompt_invalid", `superspec role prompt ${promptPath} is empty`, [promptPath]));
    }
  }
  return reasons;
}

export function openspec_cli_capability_reasons(): Reason[] {
  if (!commandExists("openspec")) return [reason("openspec_cli_unavailable", "openspec CLI is not available in PATH")];
  const problems: Reason[] = [];
  for (const args of REQUIRED_OPENSPEC_CLI_SURFACES) {
    const proc = runCommand("openspec", [...args], { timeout: 15_000 });
    if (proc.error) {
      problems.push(reason("openspec_native_surface_missing", `\`openspec ${args.join(" ")}\` failed: ${proc.error.message}`));
    } else if (proc.status !== 0) {
      problems.push(reason("openspec_native_surface_missing", `\`openspec ${args.join(" ")}\` failed: ${(proc.stderr || proc.stdout).trim()}`));
    }
  }
  return problems;
}

export function evidence_schema_guard(change: string, changeRoot: string, repoRoot: string, evidences: JsonMap[]): Reason[] {
  return [
    ...evidences.flatMap((ev) => validate_evidence_schema(ev, change, changeRoot, repoRoot)),
    ...duplicate_evidence_id_reasons(evidences),
    ...dangling_evidence_ref_reasons(evidences),
    ...supersede_reasons(evidences),
    ...request_changes_round_reasons(evidences),
  ];
}

export function check_init(change: string, status: JsonMap, repoRoot: string, changeRoot: string): Decision {
  const gate = "init";
  const amap = artifact_status_map(status);
  const reasons: Reason[] = [];
  reasons.push(...runtime.openspec_init_reasons(repoRoot));
  reasons.push(...runtime.superspec_agent_reasons(repoRoot));
  reasons.push(...runtime.superspec_workflow_skill_reasons(repoRoot));
  let schemaName = status.schemaName ?? status.schema;
  if (isObject(schemaName)) schemaName = schemaName.name;
  if (schemaName && schemaName !== "spec-driven") {
    reasons.push(reason("non_default_openspec_schema", `superspec v1 expects OpenSpec default spec-driven schema, got ${repr(schemaName)}`));
  }
  const missing = [...OPENSPEC_ARTIFACTS].filter((item) => !(item in amap)).sort();
  const unexpected = Object.keys(amap).filter((item) => !OPENSPEC_ARTIFACTS.has(item)).sort();
  if (missing.length > 0) reasons.push(reason("missing_openspec_artifacts", `OpenSpec status missing artifacts: ${renderList(missing)}`));
  if (unexpected.length > 0) reasons.push(reason("unexpected_openspec_artifacts", `superspec v1 uses default OpenSpec artifacts only; found: ${renderList(unexpected)}`));
  if (!Array.isArray(status.applyRequires) || !new Set(status.applyRequires).has("tasks")) {
    reasons.push(reason("unexpected_apply_requires", "OpenSpec applyRequires must include native tasks artifact"));
  }
  if (existsSync(join(repoRoot, ".codex", "hooks.json"))) reasons.push(reason("v1_hook_artifact_present", ".codex/hooks.json belongs to superspec v2"));
  if (existsSync(join(repoRoot, "openspec", "schemas", "superspec"))) reasons.push(reason("custom_superspec_schema_present", "openspec/schemas/superspec is not part of superspec v1 overlay"));
  if (reasons.length > 0) return block(change, gate, reasons, { openspec_summary: amap });
  return allow(change, gate, { openspec_summary: amap, gate_summary: { sidecar_root: ".superspec" } });
}

// FIX-4 (audit C-1): role review evidence must pin the current blob of the gate's target artifact,
// mirroring the invariants_reviewed current-blob check.
function stale_artifact_review_reasons(reviews: JsonMap[], changeRoot: string, artifactRel: string, code: string, gateName: string): Reason[] {
  const artifactPath = join(changeRoot, artifactRel);
  const artifactSha = existsSync(artifactPath) && statSync(artifactPath).isFile() ? runtime.file_blob_sha(artifactPath) : "";
  const reasons: Reason[] = [];
  for (const ev of reviews.filter((item) => item.agent_role)) {
    const targets = Array.isArray(ev.target_refs) ? ev.target_refs : [];
    const hasCurrentTarget = targets.some((item) => isObject(item) && item.path === artifactRel && item.blob_sha === artifactSha);
    if (!hasCurrentTarget) {
      reasons.push(reason(code, `${ev._path ?? ev.evidence_id}: ${gateName} evidence must target current ${artifactRel}`));
    }
  }
  return reasons;
}

export function check_superspec_gate(change: string, status: JsonMap, changeRoot: string, evidences: JsonMap[], gateRaw: string): Decision {
  const gate = normalize_gate(gateRaw);
  const amap = artifact_status_map(status);
  const reasons: Reason[] = [];
  if (gate === "explore_complete") {
    const discovery = sidecar_discovery_path(changeRoot);
    if (!existsSync(discovery) || !statSync(discovery).isFile() || !readFileSync(discovery, "utf8").trim()) reasons.push(reason("missing_discovery", "sidecar .superspec/artifacts/discovery.md missing or empty"));
    const exploreReviews = live_pass(evidences, { gate: "explore_complete" });
    for (const role of ["critic"]) {
      if (!exploreReviews.some((ev) => ev.agent_role === role)) reasons.push(reason("missing_native_subagent_evidence", `explore_complete requires native_subagent ${role} report`));
    }
    reasons.push(...stale_artifact_review_reasons(exploreReviews, changeRoot, ".superspec/artifacts/discovery.md", "stale_explore_review", "explore_complete"));
    // DISC Phase 1: material findings raised by explore reviews must be disclosed to the user
    // (main_review_digest + user_review_decision) before the gate can pass.
    reasons.push(...review_disclosure_reasons("explore_complete", changeRoot, evidences));
  } else if (gate === "proposal_reviewed") {
    // DISC Phase 2: proposal review is an internal gate, not an advisory note. It is born inside
    // the disclosure loop, so round-tagged critic evidence + digest are unconditionally required.
    const explore = check_superspec_gate(change, status, changeRoot, evidences, "explore_complete");
    if (!explore.allowed) {
      reasons.push(reason("explore_complete_failed", "proposal_reviewed requires explore_complete"));
      reasons.push(...explore.block_reasons);
    }
    if (!is_done(status, "proposal")) reasons.push(reason("missing_proposal", "proposal not done in OpenSpec"));
    const proposalReviews = live_pass(evidences, { gate: "proposal_reviewed" });
    if (!proposalReviews.some((ev) => ev.agent_role === "critic")) reasons.push(reason("missing_proposal_review", "proposal_reviewed requires native_subagent critic report"));
    reasons.push(...review_disclosure_reasons("proposal_reviewed", changeRoot, evidences));
  } else if (gate === "design_complete") {
    const proposal = check_superspec_gate(change, status, changeRoot, evidences, "proposal_reviewed");
    if (!proposal.allowed) {
      reasons.push(reason("proposal_reviewed_failed", "design_complete requires proposal_reviewed"));
      reasons.push(...proposal.block_reasons);
    }
    if (!is_done(status, "design")) reasons.push(reason("missing_design", "design not done in OpenSpec"));
    const designReviews = live_pass(evidences, { gate: "design_complete" });
    for (const role of ["architect", "critic", "test-engineer"]) {
      if (!designReviews.some((ev) => ev.agent_role === role)) reasons.push(reason(`missing_${role}_review`, `design_complete requires native_subagent ${role} report`));
    }
    if (live_pass(evidences, { kind: "human_confirmation", gate: "design_complete" }).length === 0) reasons.push(reason("missing_human_confirmation", "design_complete requires human confirmation"));
    reasons.push(...stale_artifact_review_reasons(designReviews, changeRoot, "design.md", "stale_design_review", "design_complete"));
    // DISC Phase 2: design reviews carrying round-tagged findings enter the disclosure loop
    // (legacy design evidence stays grandfathered, P2-3).
    reasons.push(...review_disclosure_reasons("design_complete", changeRoot, evidences));
  } else if (gate === "invariants_reviewed") {
    const design = check_superspec_gate(change, status, changeRoot, evidences, "design_complete");
    if (!design.allowed) {
      reasons.push(reason("design_complete_failed", "invariants_reviewed requires design_complete"));
      reasons.push(...design.block_reasons);
    }
    reasons.push(...business_invariant_validation_reasons(changeRoot));
    const invariantReviews = live_pass(evidences, { gate: "invariants_reviewed" });
    const roles = new Set(invariantReviews.map((ev) => ev.agent_role));
    for (const need of ["critic", "test-engineer"]) {
      if (!roles.has(need)) reasons.push(reason("missing_invariant_review", `invariants_reviewed requires native_subagent ${need} review`));
    }
    if (invariantReviews.length === 0) reasons.push(reason("missing_invariant_review", "invariants_reviewed requires passing review evidence"));
    reasons.push(...stale_artifact_review_reasons(invariantReviews, changeRoot, ".superspec/artifacts/business-invariants.md", "stale_invariant_review", "invariants_reviewed"));
    const humanRequired = human_confirmation_business_invariant_ids(changeRoot);
    if (humanRequired.size > 0) {
      const confirmed = new Set<string>();
      for (const ev of live_pass(evidences, { gate: "invariants_reviewed", kind: "human_confirmation" })) {
        for (const id of evidence_invariant_refs(ev)) confirmed.add(id);
      }
      const missing = [...humanRequired].filter((id) => !confirmed.has(id)).sort();
      if (missing.length > 0) reasons.push(reason("missing_human_confirmation", `human-confirmation invariants require explicit confirmation evidence: ${renderList(missing)}`));
    }
    // DISC Phase 3: round-tagged invariant reviews enter the disclosure loop (legacy stays grandfathered).
    reasons.push(...review_disclosure_reasons("invariants_reviewed", changeRoot, evidences));
  } else if (gate === "test_contract_drafted") {
    if (!is_done(status, "design")) reasons.push(reason("missing_design", "test_contract_drafted requires design done in OpenSpec"));
    const invariants = check_superspec_gate(change, status, changeRoot, evidences, "invariants_reviewed");
    if (!invariants.allowed) {
      reasons.push(reason("invariants_not_reviewed", "test_contract_drafted requires invariants_reviewed"));
      reasons.push(...invariants.block_reasons);
    }
    if (!existsSync(sidecar_test_contract_path(changeRoot))) {
      reasons.push(reason("missing_test_contract", "sidecar .superspec/artifacts/test-contract.md missing"));
    } else {
      if (parse_test_contract_ids(changeRoot).size === 0) reasons.push(reason("missing_coverage_matrix", "test-contract has no TEST-* entries"));
      const missingScenarios = parse_spec_scenarios(changeRoot).filter((scenario) => !test_contract_covers_scenario(changeRoot, scenario));
      if (missingScenarios.length > 0) reasons.push(reason("missing_coverage_matrix", `test-contract missing Scenario coverage: ${renderList(missingScenarios)}`));
      const contractInvariantIds = test_contract_invariant_ids(changeRoot);
      const missingInvariants = [...automated_hard_business_invariant_ids(changeRoot)].filter((id) => !contractInvariantIds.has(id)).sort();
      if (missingInvariants.length > 0) reasons.push(reason("invariant_not_honored", `test-contract missing hard business invariants: ${renderList(missingInvariants)}`));
      const postImplementationInvariants = post_implementation_business_invariant_ids(changeRoot);
      const postImplementationMapped = [...contractInvariantIds].filter((id) => postImplementationInvariants.has(id)).sort();
      if (postImplementationMapped.length > 0) reasons.push(reason("post_implementation_invariant_backfill", `test-contract cannot map created_after_implementation invariants: ${renderList(postImplementationMapped)}`));
    }
    const draftedReviews = live_pass(evidences, { gate: "test_contract_drafted" });
    const roles = new Set(draftedReviews.map((ev) => ev.agent_role));
    for (const need of ["test-engineer", "critic"]) {
      if (!roles.has(need)) reasons.push(reason("missing_test_contract_review", `test_contract_drafted requires native_subagent ${need} review`));
    }
    if (draftedReviews.length === 0) reasons.push(reason("missing_test_contract_review", "test_contract_drafted requires passing review evidence"));
    reasons.push(...stale_artifact_review_reasons(draftedReviews, changeRoot, ".superspec/artifacts/test-contract.md", "stale_test_contract_review", "test_contract_drafted"));
    // DISC Phase 3: round-tagged test-contract reviews enter the disclosure loop (legacy stays grandfathered).
    reasons.push(...review_disclosure_reasons("test_contract_drafted", changeRoot, evidences));
  } else if (gate === "test_contract_honored") {
    const drafted = check_superspec_gate(change, status, changeRoot, evidences, "test_contract_drafted");
    if (!drafted.allowed) {
      reasons.push(reason("test_contract_drafted_failed", "test_contract_honored requires test_contract_drafted"));
      reasons.push(...drafted.block_reasons);
    }
    if (!is_done(status, "tasks")) reasons.push(reason("missing_tasks", "test_contract_honored requires tasks done in OpenSpec"));
    const contractIds = parse_test_contract_ids(changeRoot);
    if (contractIds.size === 0) reasons.push(reason("missing_test_contract", "test-contract missing or has no TEST-* entries"));
    const validInvariantIds = business_invariant_ids(changeRoot);
    const contractInvariantIds = test_contract_invariant_ids(changeRoot);
    const unknownContractInvariants = [...contractInvariantIds].filter((item) => !validInvariantIds.has(item)).sort();
    if (unknownContractInvariants.length > 0) reasons.push(reason("invalid_invariant_ref", `test-contract references unknown business invariant: ${renderList(unknownContractInvariants)}`));
    const tasks = parse_tasks(changeRoot);
    const refs = task_test_refs(tasks);
    const missing = [...contractIds].filter((item) => !refs.has(item)).sort();
    if (missing.length > 0) reasons.push(reason("missing_task_test_refs", `test-contract ids not mapped by tasks.md test_refs: ${renderList(missing)}`));
    for (const record of parse_test_contract_records(changeRoot)) {
      const mappedTaskInvariantRefs = new Set<string>();
      for (const task of Object.values(tasks)) {
        if (!splitList(task.attrs.test_refs ?? "").includes(record.test_id)) continue;
        for (const inv of splitList(task.attrs.invariant_refs ?? "")) mappedTaskInvariantRefs.add(inv);
      }
      const missingInvariantRefs = record.invariant_refs.filter((item) => !mappedTaskInvariantRefs.has(item)).sort();
      if (missingInvariantRefs.length > 0) {
        reasons.push(reason("missing_task_invariant_refs", `test-contract ${record.test_id} invariant ids not mapped by matching tasks.md invariant_refs: ${renderList(missingInvariantRefs)}`));
      }
    }
    const unknownEvidence = [...red_green_test_ids(evidences)].filter((item) => !contractIds.has(item)).sort();
    if (unknownEvidence.length > 0) reasons.push(reason("test_contract_not_honored", `RED/GREEN evidence references unknown test_id: ${renderList(unknownEvidence)}`));
    const unknownEvidenceInvariants = [...red_green_invariant_ids(evidences)].filter((item) => !validInvariantIds.has(item)).sort();
    if (unknownEvidenceInvariants.length > 0) reasons.push(reason("invalid_invariant_ref", `RED/GREEN evidence references unknown invariant_id: ${renderList(unknownEvidenceInvariants)}`));
    reasons.push(...evidence_test_contract_invariant_reasons(live_pass(evidences, { kind: "test_run" }), "*", test_contract_invariant_refs_by_test(changeRoot), "RED/GREEN"));
  } else if (gate === "tasks_complete") {
    if (!is_done(status, "tasks")) reasons.push(reason("missing_tasks", "tasks not done in OpenSpec"));
    const honored = check_superspec_gate(change, status, changeRoot, evidences, "test_contract_honored");
    if (!honored.allowed) reasons.push(reason("test_contract_not_honored", "tasks_complete requires test_contract_honored"));
    const tasks = parse_tasks(changeRoot);
    if (Object.keys(tasks).length === 0) reasons.push(reason("invalid_task_graph", "tasks.md has no structured tasks"));
    reasons.push(...write_scope_conflict_reasons(tasks));
    // DISC Phase 3: tasks_complete enters the disclosure loop only once round-tagged review
    // evidence appears (design: no mandatory role review on this gate until then).
    reasons.push(...review_disclosure_reasons("tasks_complete", changeRoot, evidences));
  } else if (gate === "propose_complete") {
    for (const art of ["proposal", "specs", "design", "tasks"]) {
      if (!is_done(status, art)) reasons.push(reason(`missing_${art}`, `${art} not done in OpenSpec`));
    }
    for (const subgate of ["explore_complete", "proposal_reviewed", "design_complete", "invariants_reviewed", "test_contract_drafted", "tasks_complete"]) {
      const sub = check_superspec_gate(change, status, changeRoot, evidences, subgate);
      if (!sub.allowed) {
        reasons.push(reason(`${subgate}_failed`, `propose_complete requires passing internal gate '${subgate}'`));
        reasons.push(...sub.block_reasons);
      }
    }
  } else {
    return block(change, gate, [reason("unknown_gate", `unknown superspec gate: ${gate}`)]);
  }
  // FIX-11: per-gate output_ref dedup + cross-gate reuse scope contract for propose-phase reviews.
  reasons.push(...propose_review_output_ref_reasons(changeRoot, evidences, gate));
  if (reasons.length > 0) return block(change, gate, reasons, { openspec_summary: amap, next_actions: default_gate_next_actions(gate) });
  return allow(change, gate, { openspec_summary: amap });
}

export function check_artifact(change: string, status: JsonMap, changeRoot: string, evidences: JsonMap[], artifact: string): Decision {
  const amap = artifact_status_map(status);
  if (!OPENSPEC_ARTIFACTS.has(artifact)) return block(change, `${artifact}_enter`, [reason("not_openspec_artifact", `${artifact} is not an OpenSpec artifact; use check-enter for superspec gates`)]);
  if (!(artifact in amap)) return block(change, `${artifact}_enter`, [reason("unknown_artifact", `${artifact} not in openspec status artifacts`)]);
  const reasons: Reason[] = [];
  if (amap[artifact] === "blocked") {
    const found = (status.artifacts ?? []).find((item: JsonMap) => item.id === artifact);
    const missing = found?.missingDeps ?? [];
    reasons.push(reason("openspec_blocked", `${artifact} blocked by: ${renderList(missing)}`, missing));
  }
  const enterGate = ARTIFACT_ENTER_GATE[artifact];
  const gateDecision = enterGate ? check_superspec_gate(change, status, changeRoot, evidences, enterGate) : allow(change, "no_enter_gate");
  if (enterGate && !gateDecision.allowed) {
    reasons.push(reason(`${enterGate}_failed`, `entering ${artifact} requires passing superspec gate '${enterGate}'`));
    reasons.push(...gateDecision.block_reasons);
  }
  const gate = `${artifact}_enter`;
  if (reasons.length > 0) return block(change, gate, reasons, { openspec_summary: amap, next_actions: [enterGate ? `satisfy deps then record '${enterGate}' pass evidence` : "complete required OpenSpec dependencies"] });
  return allow(change, gate, { openspec_summary: amap });
}

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function rewrite_task_checkbox_text(text: string, taskId: string, fromChecked: boolean, toChecked: boolean): string | null {
  const pattern = new RegExp(`^(\\- \\[)( |x|X)(\\]\\s+${escapeRegExp(taskId)}(?:\\s.*)?)$`, "m");
  const match = text.match(pattern);
  if (!match) return null;
  const currentChecked = String(match[2]).toLowerCase() === "x";
  if (currentChecked !== fromChecked) return null;
  return text.replace(pattern, `$1${toChecked ? "x" : " "}$3`);
}

type TaskReopenHistory = {
  pass: JsonMap[];
  live: JsonMap[];
  liveResolved: JsonMap[];
  unresolvedLive: JsonMap[];
};

function task_reopen_history(evidences: JsonMap[], taskId: string): TaskReopenHistory {
  return {
    pass: pass_task_reopens(evidences, taskId),
    live: live_task_reopens(evidences, taskId),
    liveResolved: live_task_reopen_resolutions(evidences, taskId),
    unresolvedLive: unresolved_live_task_reopens(evidences, taskId),
  };
}

function task_reopen_match_key(ev: JsonMap): string {
  return `${String(ev.evidence_id ?? "")}\u0000${String(ev.reopen_id ?? "")}\u0000${String(ev.task_id ?? "")}`;
}

function matching_reopen_resolutions(evidences: JsonMap[], reopen: JsonMap): JsonMap[] {
  const key = task_reopen_match_key(reopen);
  return live_task_reopen_resolutions(evidences)
    .filter((resolution) => `${String(resolution.reopen_evidence_id ?? "")}\u0000${String(resolution.reopen_id ?? "")}\u0000${String(resolution.task_id ?? "")}` === key);
}

function task_reopen_global_lifecycle_reasons(changeRoot: string, evidences: JsonMap[]): Reason[] {
  const reasons: Reason[] = [];
  const tasks = parse_tasks(changeRoot);
  const passReopens = pass_task_reopens(evidences);
  const reopensByTask = new Map<string, JsonMap[]>();
  for (const reopen of passReopens) {
    const taskId = String(reopen.task_id ?? "");
    if (!taskId) continue;
    const items = reopensByTask.get(taskId) ?? [];
    items.push(reopen);
    reopensByTask.set(taskId, items);
  }
  for (const [taskId, reopens] of reopensByTask.entries()) {
    if (reopens.length > 1) {
      reasons.push(reason("reopen_lifecycle_exhausted", `task ${taskId} has multiple task_reopen histories in this change; v1 allows at most one`, [taskId]));
    }
    const task = tasks[taskId];
    if (!task) {
      reasons.push(reason("unknown_task", `task_reopen lifecycle references task ${taskId}, but task is not present in tasks.md`, [taskId]));
      continue;
    }
    if (!task.checked) {
      reasons.push(reason("unresolved_task_reopen", `task ${taskId} is reopened and must be checked again before review_ready`, [taskId]));
    }
    for (const reopen of reopens) {
      if (matching_reopen_resolutions(evidences, reopen).length === 0) {
        reasons.push(reason("unresolved_task_reopen", `task ${taskId} has task_reopen without matching live task_reopen_resolved`, [taskId]));
      }
    }
    reasons.push(...task_reopen_resolution_reasons(changeRoot, evidences, taskId));
  }
  return reasons;
}

function active_task_reopen_reasons(changeRoot: string, evidences: JsonMap[], task: JsonMap, taskId: string, phase: "pre_revert" | "post_revert"): { reopen: JsonMap | null; reasons: Reason[] } {
  const reasons: Reason[] = [];
  const history = task_reopen_history(evidences, taskId);
  if (history.pass.length > 1) reasons.push(reason("reopen_lifecycle_exhausted", `task ${taskId} already has reopen history in this change and cannot reopen again in v1`));
  if (history.unresolvedLive.length === 0) {
    reasons.push(reason("missing_task_reopen", `task ${taskId} requires exactly one unresolved task_reopen evidence`));
    return { reopen: null, reasons };
  }
  if (history.unresolvedLive.length > 1) {
    reasons.push(reason("ambiguous_task_reopen", `task ${taskId} has multiple unresolved task_reopen evidences`));
    return { reopen: null, reasons };
  }
  const reopen = history.unresolvedLive[0];
  const liveById = new Map(live_pass(evidences).map((ev) => [String(ev.evidence_id), ev]));
  const liveReviewMainAdjudicationById = new Map(
    live_pass(evidences, { gate: "review_complete", kind: "main_adjudication" }).map((ev) => [String(ev.evidence_id), ev]),
  );
  const liveReviewSourceGuidanceById = new Map(
    live_pass(evidences, { gate: "review_complete", kind: "source_guidance" }).map((ev) => [String(ev.evidence_id), ev]),
  );
  const sourceAdjudicationId = String(reopen.source_adjudication_evidence_id ?? "");
  const sourceGuidanceId = String(reopen.source_guidance_evidence_id ?? "");
  const sourceAdjudication = liveReviewMainAdjudicationById.get(sourceAdjudicationId);
  const sourceGuidance = liveReviewSourceGuidanceById.get(sourceGuidanceId);
  const violatedTests = Array.isArray(reopen.violated_test_ids) ? reopen.violated_test_ids.map((item: unknown) => String(item)) : [];
  const violatedRequirements = Array.isArray(reopen.violated_requirement_refs) ? reopen.violated_requirement_refs.map((item: unknown) => String(item)) : [];

  if (!sourceAdjudication) {
    reasons.push(reason("task_reopen_invalid", `task ${taskId}: source_adjudication_evidence_id must reference live/pass review_complete main_adjudication`));
  } else {
    const decision = String(sourceAdjudication.review_decision ?? "");
    if (!MAIN_ADJUDICATION_DECISIONS.includes(decision as (typeof MAIN_ADJUDICATION_DECISIONS)[number])) {
      reasons.push(reason("task_reopen_invalid", `task ${taskId}: source main_adjudication has unsupported review_decision=${repr(decision)}`));
    }
    if (decision !== "request_changes") {
      reasons.push(reason("task_reopen_invalid", `task ${taskId}: source main_adjudication must carry review_decision='request_changes'`));
    }
    const route = String(sourceAdjudication.request_changes_route ?? "");
    if (!REQUEST_CHANGES_ROUTES.includes(route as (typeof REQUEST_CHANGES_ROUTES)[number])) {
      reasons.push(reason("task_reopen_invalid", `task ${taskId}: source main_adjudication has unsupported request_changes_route=${repr(route)}`));
    }
    if (route !== "reopen_tasks") {
      reasons.push(reason("task_reopen_invalid", `task ${taskId}: source main_adjudication must carry request_changes_route='reopen_tasks'`));
    }
    const sourceEvidenceRefs = new Set((Array.isArray(sourceAdjudication.source_evidence_refs) ? sourceAdjudication.source_evidence_refs : []).map((item) => String(item)));
    if (!sourceEvidenceRefs.has(sourceGuidanceId)) {
      reasons.push(reason("task_reopen_invalid", `task ${taskId}: source main_adjudication must reference source_guidance_evidence_id`));
    }
    const blockingRefs = new Set((Array.isArray(sourceAdjudication.blocking_source_evidence_refs) ? sourceAdjudication.blocking_source_evidence_refs : []).map((item) => String(item)));
    if (!blockingRefs.has(sourceGuidanceId)) {
      reasons.push(reason("task_reopen_invalid", `task ${taskId}: source main_adjudication must include source_guidance_evidence_id in blocking_source_evidence_refs`));
    }
    const reopenTaskIds = new Set((Array.isArray(sourceAdjudication.reopen_task_ids) ? sourceAdjudication.reopen_task_ids : []).map((item) => String(item)));
    if (!reopenTaskIds.has(taskId)) {
      reasons.push(reason("task_reopen_invalid", `task ${taskId}: source main_adjudication must include task in reopen_task_ids`));
    }
  }

  if (!sourceGuidance || sourceGuidance.agent_role !== "code-reviewer") {
    reasons.push(reason("task_reopen_invalid", `task ${taskId}: source_guidance_evidence_id must reference live/pass review_complete code-reviewer source_guidance`));
  } else {
    const matchedBlockingFindings = blocking_findings(sourceGuidance)
      .filter((item) => (string_set(item.affected_task_ids) ?? []).includes(taskId));
    if (matchedBlockingFindings.length === 0) {
      reasons.push(reason("task_reopen_invalid", `task ${taskId}: source_guidance_evidence_id must include a blocking finding whose affected_task_ids covers the task`));
    }
  }

  const declaredTests = new Set(splitList(task.attrs.test_refs ?? ""));
  const invalidTests = violatedTests.filter((item) => !declaredTests.has(item)).sort();
  if (invalidTests.length > 0) {
    reasons.push(reason("task_reopen_invalid", `task ${taskId}: violated_test_ids must be drawn from task test_refs: ${renderList(invalidTests)}`, invalidTests));
  }

  const declaredRequirements = new Set(splitList(task.attrs.requirement_refs ?? ""));
  const invalidRequirements = violatedRequirements.filter((item) => !declaredRequirements.has(item)).sort();
  if (invalidRequirements.length > 0) {
    reasons.push(reason("task_reopen_invalid", `task ${taskId}: violated_requirement_refs must be drawn from task requirement_refs: ${renderList(invalidRequirements)}`, invalidRequirements));
  }

  if (reopen.scope_expansion !== false) {
    reasons.push(reason("scope_expansion_requires_propose", `task ${taskId}: scope_expansion=true cannot use task_reopen`));
  }

  const requiredSupersedes = Array.isArray(reopen.required_supersede_evidence_ids)
    ? reopen.required_supersede_evidence_ids.map((item: unknown) => String(item))
    : [];
  const liveConflicts = requiredSupersedes.filter((item) => liveById.has(item)).sort();
  if (liveConflicts.length > 0) {
    reasons.push(reason("task_reopen_invalid", `task ${taskId}: required_supersede_evidence_ids must already be out of live/pass: ${renderList(liveConflicts)}`, liveConflicts));
  }

  if (requiredSupersedes.includes(sourceAdjudicationId) || requiredSupersedes.includes(sourceGuidanceId)) {
    reasons.push(reason("task_reopen_invalid", `task ${taskId}: source evidence ids must not be listed in required_supersede_evidence_ids`));
  }

  const tasksPath = join(changeRoot, "tasks.md");
  const tasksText = existsSync(tasksPath) && statSync(tasksPath).isFile() ? readFileSync(tasksPath, "utf8") : "";
  const currentHash = sha256_text(tasksText);
  if (phase === "pre_revert") {
    if (currentHash !== reopen.before_tasks_sha256) {
      reasons.push(reason("task_reopen_invalid", `task ${taskId}: current tasks.md hash must match before_tasks_sha256 before authorized revert`));
    }
    const revertedText = rewrite_task_checkbox_text(tasksText, taskId, true, false);
    if (revertedText === null) {
      reasons.push(reason("task_reopen_invalid", `task ${taskId}: tasks.md must be transformable by only switching the task checkbox from [x] to [ ]`));
    } else if (sha256_text(revertedText) !== reopen.after_tasks_sha256) {
      reasons.push(reason("task_reopen_invalid", `task ${taskId}: after_tasks_sha256 must equal the raw-text hash after the authorized [x] -> [ ] revert`));
    }
  } else {
    if (currentHash !== reopen.after_tasks_sha256) {
      reasons.push(reason("task_reopen_invalid", `task ${taskId}: current tasks.md hash must match after_tasks_sha256 during reopened apply`));
    }
    const restoredText = rewrite_task_checkbox_text(tasksText, taskId, false, true);
    if (restoredText === null) {
      reasons.push(reason("task_reopen_invalid", `task ${taskId}: reopened tasks.md must be reversible by only switching the task checkbox from [ ] to [x]`));
    } else if (sha256_text(restoredText) !== reopen.before_tasks_sha256) {
      reasons.push(reason("task_reopen_invalid", `task ${taskId}: before_tasks_sha256 must equal the raw-text hash after restoring the task checkbox to [x]`));
    }
  }

  return { reopen, reasons };
}

type TaskReopenApplyState =
  | { mode: "ordinary" }
  | { mode: "reopened"; reopen: JsonMap }
  | { mode: "blocked"; reasons: Reason[] };

function task_reopen_apply_state(changeRoot: string, evidences: JsonMap[], task: JsonMap, taskId: string): TaskReopenApplyState {
  const history = task_reopen_history(evidences, taskId);
  const liveReviewAdjudications = live_pass(evidences, { gate: "review_complete", kind: "main_adjudication" });
  if (history.unresolvedLive.length > 0) {
    const reopenCheck = active_task_reopen_reasons(changeRoot, evidences, task, taskId, "post_revert");
    if (reopenCheck.reasons.length > 0 || !reopenCheck.reopen) return { mode: "blocked", reasons: reopenCheck.reasons };
    return { mode: "reopened", reopen: reopenCheck.reopen };
  }
  if (history.pass.length > 0) {
    return { mode: "blocked", reasons: [reason("missing_task_reopen", `task ${taskId} was reopened in this change and cannot continue unchecked without one live unresolved task_reopen`)] };
  }
  const liveReopenRequests = live_request_changes_reopen_adjudications_for_task(evidences, taskId);
  if (liveReopenRequests.length > 0) {
    return { mode: "blocked", reasons: [reason("missing_task_reopen", `task ${taskId} is referenced by request_changes(reopen_tasks) but has no live unresolved task_reopen`)] };
  }
  const liveChangeUpdateRequests = liveReviewAdjudications.filter((ev) => ev.review_decision === "request_changes" && ev.request_changes_route === "change_update");
  if (liveChangeUpdateRequests.length > 0) {
    return { mode: "blocked", reasons: [reason("change_update_required", `task ${taskId}: live request_changes(change_update) requires returning to propose/change update before apply`)] };
  }
  if (liveReviewAdjudications.length > 0) {
    return { mode: "blocked", reasons: [reason("missing_task_reopen", `task ${taskId} cannot continue unchecked after review without one live unresolved task_reopen`)] };
  }
  return { mode: "ordinary" };
}

function task_reopen_resolution_reasons(changeRoot: string, evidences: JsonMap[], taskId: string): Reason[] {
  const reasons: Reason[] = [];
  const tasks = parse_tasks(changeRoot);
  const task = tasks[taskId];
  const liveById = new Map(live_pass(evidences).map((ev) => [String(ev.evidence_id ?? ""), ev]));
  const passReopensById = new Map(pass_task_reopens(evidences).map((ev) => [String(ev.evidence_id ?? ""), ev]));
  const resolutions = live_task_reopen_resolutions(evidences, taskId);
  if (resolutions.length === 0) return reasons;

  const tasksPath = join(changeRoot, "tasks.md");
  const tasksText = existsSync(tasksPath) && statSync(tasksPath).isFile() ? readFileSync(tasksPath, "utf8") : "";
  const currentTasksHash = sha256_text(tasksText);

  for (const resolution of resolutions) {
    const resolutionPath = String(resolution._path ?? "task_reopen_resolved evidence");
    const reopenEvidenceId = String(resolution.reopen_evidence_id ?? "");
    const reopen = passReopensById.get(reopenEvidenceId);
    if (!reopen || reopen.kind !== "task_reopen") {
      reasons.push(reason("task_reopen_resolved_invalid", `${resolutionPath}: reopen_evidence_id must reference pass task_reopen evidence`, [reopenEvidenceId]));
      continue;
    }

    const reopenTaskId = String(reopen.task_id ?? "");
    const reopenId = String(reopen.reopen_id ?? "");
    const resolutionTaskId = String(resolution.task_id ?? "");
    const resolutionReopenId = String(resolution.reopen_id ?? "");
    if (resolutionTaskId !== reopenTaskId) {
      reasons.push(reason("task_reopen_resolved_invalid", `${resolutionPath}: task_id must match referenced task_reopen task_id=${repr(reopenTaskId)}`, [resolutionTaskId, reopenTaskId]));
    }
    if (resolutionReopenId !== reopenId) {
      reasons.push(reason("task_reopen_resolved_invalid", `${resolutionPath}: reopen_id must match referenced task_reopen reopen_id=${repr(reopenId)}`, [resolutionReopenId, reopenId]));
    }
    if (reopenTaskId !== taskId) {
      reasons.push(reason("task_reopen_resolved_invalid", `${resolutionPath}: referenced task_reopen belongs to ${reopenTaskId}, not ${taskId}`, [reopenTaskId, taskId]));
      continue;
    }

    if (!task) {
      reasons.push(reason("unknown_task", `${resolutionPath}: task ${taskId} not found in tasks.md`, [taskId]));
      continue;
    }
    if (!task.checked) {
      reasons.push(reason("task_reopen_resolved_invalid", `${resolutionPath}: task ${taskId} must be checked before task_reopen_resolved can close reopen`, [taskId]));
    }
    if (String(resolution.after_tasks_sha256 ?? "") !== currentTasksHash) {
      reasons.push(reason("task_reopen_resolved_invalid", `${resolutionPath}: current tasks.md hash must match task_reopen_resolved.after_tasks_sha256`));
    }
    if (String(resolution.after_tasks_sha256 ?? "") !== String(reopen.before_tasks_sha256 ?? "")) {
      reasons.push(reason("task_reopen_resolved_invalid", `${resolutionPath}: after_tasks_sha256 must match referenced task_reopen.before_tasks_sha256 after restoring the task checkbox`));
    }

    const requiredSupersedes = Array.isArray(reopen.required_supersede_evidence_ids)
      ? reopen.required_supersede_evidence_ids.map((item: unknown) => String(item))
      : [];
    const liveConflicts = requiredSupersedes.filter((item) => liveById.has(item)).sort();
    if (liveConflicts.length > 0) {
      reasons.push(reason("task_reopen_resolved_invalid", `${resolutionPath}: required_supersede_evidence_ids must be out of live/pass before resolving reopen: ${renderList(liveConflicts)}`, liveConflicts));
    }

    const successorIds = Array.isArray(resolution.successor_completion_evidence_ids)
      ? resolution.successor_completion_evidence_ids.map((item: unknown) => String(item)).filter(Boolean)
      : [];
    const successorEvidence: JsonMap[] = [];
    for (const successorId of successorIds) {
      const successor = liveById.get(successorId);
      if (!successor) {
        reasons.push(reason("task_reopen_resolved_invalid", `${resolutionPath}: successor_completion_evidence_ids entry is not live/pass: ${successorId}`, [successorId]));
        continue;
      }
      successorEvidence.push(successor);
      if (String(successor.task_id ?? "") !== taskId) {
        reasons.push(reason("task_reopen_resolved_invalid", `${resolutionPath}: successor evidence ${successorId} must belong to task ${taskId}`, [successorId, taskId]));
      }
      if (String(successor.reopen_id ?? "") !== reopenId) {
        reasons.push(reason("task_reopen_resolved_invalid", `${resolutionPath}: successor evidence ${successorId} must carry reopen_id=${repr(reopenId)}`, [successorId, reopenId]));
      }
    }

    const tddRequired = (task.attrs.tdd_required ?? "true").toLowerCase() !== "false";
    if (tddRequired) {
      const invalidSuccessorKinds = successorEvidence
        .filter((ev) => normalize_gate(String(ev.gate ?? "")) !== "task_complete" || ev.kind !== "test_run" || ev.semantic_status !== "expected_success")
        .map((ev) => String(ev.evidence_id ?? ev.kind ?? ""))
        .filter(Boolean)
        .sort();
      if (invalidSuccessorKinds.length > 0) {
        reasons.push(reason("task_reopen_resolved_invalid", `${resolutionPath}: tdd_required task successor evidence must be task_complete expected_success test_run: ${renderList(invalidSuccessorKinds)}`, invalidSuccessorKinds));
      }

      const violatedTests = (Array.isArray(reopen.violated_test_ids) ? reopen.violated_test_ids : []).map((item) => String(item)).filter(Boolean);
      const successorGreenIds = new Set(
        successorEvidence
          .filter((ev) => ev.kind === "test_run" && ev.semantic_status === "expected_success")
          .filter((ev) => String(ev.task_id ?? "") === taskId && String(ev.reopen_id ?? "") === reopenId)
          .map((ev) => String(ev.test_id ?? ""))
          .filter((testId) => violatedTests.includes(testId)),
      );
      const missingSuccessors = violatedTests.filter((testId) => !successorGreenIds.has(testId)).sort();
      if (missingSuccessors.length > 0) {
        reasons.push(reason("missing_reopen_successor", `${resolutionPath}: task ${taskId} requires successor GREEN evidence with reopen_id=${repr(reopenId)} for violated tests: ${renderList(missingSuccessors)}`, missingSuccessors));
      }
      const staleGreen = task_test_evidence(evidences, taskId, "expected_success", "task_complete")
        .filter((ev) => violatedTests.includes(String(ev.test_id ?? "")))
        .filter((ev) => String(ev.reopen_id ?? "") !== reopenId)
        .map((ev) => String(ev.evidence_id ?? ev.test_id ?? ""))
        .filter(Boolean)
        .sort();
      if (staleGreen.length > 0) {
        reasons.push(reason("stale_reopen_successor", `${resolutionPath}: task ${taskId} still has live pre-reopen GREEN evidence for violated tests: ${renderList(staleGreen)}`, staleGreen));
      }
    } else {
      const invalidSuccessorKinds = successorEvidence
        .filter((ev) => ev.kind !== "alternative_verification" && ev.kind !== "manual_verification")
        .map((ev) => String(ev.evidence_id ?? ev.kind ?? ""))
        .filter(Boolean)
        .sort();
      if (invalidSuccessorKinds.length > 0) {
        reasons.push(reason("task_reopen_resolved_invalid", `${resolutionPath}: tdd_required:false task successor evidence must be alternative/manual verification: ${renderList(invalidSuccessorKinds)}`, invalidSuccessorKinds));
      }
      const successorAlt = successorEvidence
        .filter((ev) => ev.kind === "alternative_verification" || ev.kind === "manual_verification")
        .filter((ev) => String(ev.task_id ?? "") === taskId && String(ev.reopen_id ?? "") === reopenId);
      if (successorAlt.length === 0) {
        reasons.push(reason("missing_reopen_successor", `${resolutionPath}: task ${taskId} requires alternative/manual verification with reopen_id=${repr(reopenId)} after reopen`));
      }
      const staleAlt = task_alternative_verification(evidences, taskId)
        .filter((ev) => String(ev.reopen_id ?? "") !== reopenId)
        .map((ev) => String(ev.evidence_id ?? ev.kind ?? ""))
        .filter(Boolean)
        .sort();
      if (staleAlt.length > 0) {
        reasons.push(reason("stale_reopen_successor", `${resolutionPath}: task ${taskId} still has live pre-reopen alternative/manual verification evidence: ${renderList(staleAlt)}`, staleAlt));
      }
    }
  }

  return reasons;
}

export function check_task_reopen(change: string, status: JsonMap, changeRoot: string, evidences: JsonMap[], taskId: string): Decision {
  const gate = "task_reopen";
  const reasons: Reason[] = [];
  if (!is_done(status, "tasks")) reasons.push(reason("missing_tasks", "tasks.md not done in OpenSpec"));
  const propose = check_superspec_gate(change, status, changeRoot, evidences, "propose_complete");
  if (!propose.allowed) {
    reasons.push(reason("propose_not_complete", "task_reopen requires propose_complete"));
    reasons.push(...propose.block_reasons);
  }
  const tasks = parse_tasks(changeRoot);
  const task = tasks[taskId];
  if (!task) return block(change, gate, [...reasons, reason("unknown_task", `task ${taskId} not found in tasks.md`)], { task_id: taskId });
  if (!task.checked) reasons.push(reason("task_reopen_invalid", `task ${taskId} must still be checked before authorized reopen revert`));
  reasons.push(...request_changes_round_reasons(evidences));
  const reopenCheck = active_task_reopen_reasons(changeRoot, evidences, task, taskId, "pre_revert");
  reasons.push(...reopenCheck.reasons);
  if (reasons.length > 0) return block(change, gate, reasons, { task_id: taskId, next_actions: [`keep ${taskId} checked, fix task_reopen evidence / supersedes, then rerun check-task-reopen`] });
  return allow(change, gate, { task_id: taskId });
}

// FIX-8 (audit A-5): apply work requires the user's explicit isolation/execution-mode choice,
// recorded as a human_confirmation that pins the approved tasks.md structure (checkbox-state
// insensitive). A structural tasks.md edit after that approval is the mechanical signature of
// apply-phase scope expansion (SPEC §14.7) and demands explicit user re-approval — redesign,
// split into a new change, or record a scope_expansion confirmation re-pinning the structure.
function apply_scope_confirmation_reasons(changeRoot: string, evidences: JsonMap[]): Reason[] {
  const isolation = live_pass(evidences, { gate: "apply_isolation", kind: "human_confirmation" });
  const currentHash = tasks_structure_hash(changeRoot);
  if (isolation.length === 0) {
    const hashHint = currentHash ? ` with tasks_structure_hash=${currentHash}` : "";
    return [reason(
      "apply_isolation_unconfirmed",
      `apply requires the user's explicit isolation/execution-mode choice: record gate="apply_isolation" human_confirmation${hashHint} before task work`,
    )];
  }
  if (currentHash === null) return [];
  const approvals = [...isolation, ...live_pass(evidences, { gate: "scope_expansion", kind: "human_confirmation" })];
  if (approvals.some((ev) => String(ev.tasks_structure_hash ?? "") === currentHash)) return [];
  return [reason(
    "scope_expansion_unconfirmed",
    `tasks.md structure changed after the last user-approved apply scope; ask the user to redesign/split the change or re-approve by recording gate="scope_expansion" human_confirmation with tasks_structure_hash=${currentHash}`,
  )];
}

export function check_task_edit(change: string, status: JsonMap, changeRoot: string, evidences: JsonMap[], taskId: string): Decision {
  const gate = "task_edit";
  const reasons: Reason[] = [];
  if (!is_done(status, "tasks")) reasons.push(reason("missing_tasks", "tasks.md not done in OpenSpec"));
  const propose = check_superspec_gate(change, status, changeRoot, evidences, "propose_complete");
  if (!propose.allowed) {
    reasons.push(reason("propose_not_complete", "task_edit requires propose_complete"));
    reasons.push(...propose.block_reasons);
  }
  reasons.push(...apply_scope_confirmation_reasons(changeRoot, evidences));
  const tasks = parse_tasks(changeRoot);
  const task = tasks[taskId];
  if (!task) return block(change, gate, [...reasons, reason("unknown_task", `task ${taskId} not found in tasks.md`)], { task_id: taskId });
  let reopenMode: TaskReopenApplyState = { mode: "ordinary" };
  if (task.checked) {
    if (task_reopen_history(evidences, taskId).unresolvedLive.length > 0) {
      reasons.push(reason("task_reopen_pending_revert", `task ${taskId} has unresolved task_reopen and must pass check-task-reopen before editing`));
    }
    reasons.push(reason("task_already_done", `task ${taskId} already checked`));
  } else {
    reopenMode = task_reopen_apply_state(changeRoot, evidences, task, taskId);
    if (reopenMode.mode === "blocked") reasons.push(...reopenMode.reasons);
  }
  const attrs = task.attrs;
  const tddRequired = (attrs.tdd_required ?? "true").toLowerCase() !== "false";
  const tddMode = attrs.tdd_mode ?? "new-behavior";
  const declared = new Set(splitList(attrs.test_refs ?? ""));
  const declaredInvariants = new Set(splitList(attrs.invariant_refs ?? ""));
  const contractIds = parse_test_contract_ids(changeRoot);
  const validInvariantIds = business_invariant_ids(changeRoot);
  if (!TDD_MODES.has(tddMode)) reasons.push(reason("invalid_tdd_mode", `task ${taskId}: tdd_mode=${repr(tddMode)}`));
  if (!tddRequired) {
    const nr = attrs.no_tdd_reason;
    if (!NO_TDD_REASONS.has(nr)) reasons.push(reason("invalid_no_tdd_reason", `task ${taskId}: no_tdd_reason=${repr(nr)}`));
  } else if (tddMode === "behavior-preserving-refactor") {
    const characterization = task_test_evidence(evidences, taskId, "expected_success", "task_edit");
    if (characterization.length === 0) reasons.push(reason("missing_characterization", `task ${taskId} (behavior-preserving-refactor) needs GREEN characterization test first`));
    reasons.push(...evidence_test_id_reasons(characterization, taskId, declared, contractIds, "characterization"));
    reasons.push(...declared_test_evidence_reasons(characterization, taskId, declared, "characterization"));
    reasons.push(...evidence_invariant_ref_reasons(characterization, taskId, declaredInvariants, validInvariantIds, "characterization"));
    reasons.push(...evidence_test_contract_invariant_reasons(characterization, taskId, test_contract_invariant_refs_by_test(changeRoot), "characterization"));
  } else {
    const red = task_test_evidence(evidences, taskId, "expected_failure", "task_edit");
    if (red.length === 0) reasons.push(reason("missing_red_evidence", `task ${taskId} requires RED evidence (expected_failure) before edit`));
    reasons.push(...evidence_test_id_reasons(red, taskId, declared, contractIds, "RED"));
    reasons.push(...declared_test_evidence_reasons(red, taskId, declared, "RED"));
    reasons.push(...evidence_invariant_ref_reasons(red, taskId, declaredInvariants, validInvariantIds, "RED"));
    reasons.push(...evidence_test_contract_invariant_reasons(red, taskId, test_contract_invariant_refs_by_test(changeRoot), "RED"));
  }
  if (reasons.length > 0) {
    const reasonSet = reason_codes(reasons);
    return block(change, gate, reasons, {
      task_id: taskId,
      next_actions: action_list(
        task.checked && task_reopen_history(evidences, taskId).unresolvedLive.length > 0
          ? `pass check-task-reopen for ${taskId} and perform the authorized [x] -> [ ] revert first`
          : null,
        reasonSet.has("change_update_required") ? `return to propose/change update before any further apply work on ${taskId}` : null,
        reasonSet.has("apply_isolation_unconfirmed") ? "AskUserQuestion for apply isolation/execution mode and record gate=\"apply_isolation\" human_confirmation" : null,
        reasonSet.has("scope_expansion_unconfirmed") ? "stop: redesign/split the change or record gate=\"scope_expansion\" human_confirmation re-approving tasks.md structure" : null,
        reopenMode.mode === "blocked" ? `repair or create task_reopen package for ${taskId} before resumed apply` : null,
        `write failing test + record RED evidence for ${taskId}`,
      ),
    });
  }
  return allow(change, gate, { task_id: taskId });
}

export function check_task_complete(change: string, status: JsonMap, changeRoot: string, evidences: JsonMap[], taskId: string): Decision {
  const gate = "task_complete";
  const reasons: Reason[] = [];
  if (!is_done(status, "tasks")) reasons.push(reason("missing_tasks", "tasks.md not done in OpenSpec"));
  const propose = check_superspec_gate(change, status, changeRoot, evidences, "propose_complete");
  if (!propose.allowed) {
    reasons.push(reason("propose_not_complete", "task_complete requires propose_complete"));
    reasons.push(...propose.block_reasons);
  }
  reasons.push(...apply_scope_confirmation_reasons(changeRoot, evidences));
  const task = parse_tasks(changeRoot)[taskId];
  if (!task) return block(change, gate, [reason("unknown_task", `task ${taskId} not found`)], { task_id: taskId });
  const reopenHistory = task_reopen_history(evidences, taskId);
  if (task.checked && reopenHistory.pass.length > 1) {
    reasons.push(reason("reopen_lifecycle_exhausted", `task ${taskId} has multiple task_reopen histories in this change; v1 allows at most one`, [taskId]));
  }
  if (task.checked && reopenHistory.unresolvedLive.length > 0) {
    reasons.push(reason("unresolved_task_reopen", `task ${taskId} has unresolved task_reopen and must complete reopened apply before ordinary completion`, [taskId]));
  }
  if (task.checked && (reopenHistory.liveResolved.length > 0 || reopenHistory.pass.length > 0)) {
    reasons.push(...task_reopen_resolution_reasons(changeRoot, evidences, taskId));
  }
  const reopenMode = !task.checked ? task_reopen_apply_state(changeRoot, evidences, task, taskId) : { mode: "ordinary" as const };
  if (!task.checked && reopenMode.mode === "blocked") reasons.push(...reopenMode.reasons);
  const attrs = task.attrs;
  const tddRequired = (attrs.tdd_required ?? "true").toLowerCase() !== "false";
  const tddMode = attrs.tdd_mode ?? "new-behavior";
  if (!TDD_MODES.has(tddMode)) reasons.push(reason("invalid_tdd_mode", `task ${taskId}: tdd_mode=${repr(tddMode)}`));
  if (tddRequired) {
    const green = task_test_evidence(evidences, taskId, "expected_success", "task_complete");
    if (green.length === 0) reasons.push(reason("missing_green_evidence", `task ${taskId} requires GREEN evidence (expected_success) before completion`));
    const declared = new Set(splitList(attrs.test_refs ?? ""));
    const declaredInvariants = new Set(splitList(attrs.invariant_refs ?? ""));
    if (declared.size === 0) reasons.push(reason("missing_task_test_refs", `task ${taskId} requires test_refs for GREEN evidence`));
    reasons.push(...evidence_test_id_reasons(green, taskId, declared, parse_test_contract_ids(changeRoot), "GREEN"));
    reasons.push(...declared_test_evidence_reasons(green, taskId, declared, "GREEN"));
    reasons.push(...evidence_invariant_ref_reasons(green, taskId, declaredInvariants, business_invariant_ids(changeRoot), "GREEN"));
    reasons.push(...evidence_test_contract_invariant_reasons(green, taskId, test_contract_invariant_refs_by_test(changeRoot), "GREEN"));
    if (reopenMode.mode === "reopened") {
      const reopen = reopenMode.reopen;
      const reopenId = String(reopen.reopen_id ?? "");
      const violatedTests = (Array.isArray(reopen.violated_test_ids) ? reopen.violated_test_ids : []).map((item) => String(item)).filter(Boolean);
      const successorGreen = green.filter((ev) => String(ev.reopen_id ?? "") === reopenId);
      const successorGreenIds = new Set(
        successorGreen
          .map((ev) => String(ev.test_id ?? ""))
          .filter((testId) => violatedTests.includes(testId)),
      );
      const missingSuccessors = violatedTests.filter((testId) => !successorGreenIds.has(testId)).sort();
      if (missingSuccessors.length > 0) {
        reasons.push(reason("missing_reopen_successor", `task ${taskId} requires successor GREEN evidence with reopen_id=${repr(reopenId)} for violated tests: ${renderList(missingSuccessors)}`, missingSuccessors));
      }
      const staleGreen = green
        .filter((ev) => violatedTests.includes(String(ev.test_id ?? "")))
        .filter((ev) => String(ev.reopen_id ?? "") !== reopenId)
        .map((ev) => String(ev.evidence_id ?? ev.test_id ?? ""))
        .filter(Boolean)
        .sort();
      if (staleGreen.length > 0) {
        reasons.push(reason("stale_reopen_successor", `task ${taskId} still has live pre-reopen GREEN evidence for violated tests: ${renderList(staleGreen)}`, staleGreen));
      }
    }
  } else {
    const nr = attrs.no_tdd_reason;
    if (!NO_TDD_REASONS.has(nr)) reasons.push(reason("invalid_no_tdd_reason", `task ${taskId}: no_tdd_reason=${repr(nr)}`));
    const verifications = task_alternative_verification(evidences, taskId);
    if (verifications.length === 0) reasons.push(reason("missing_alternative_verification", `task ${taskId} has tdd_required:false and needs alternative verification evidence`));
    if (reopenMode.mode === "reopened") {
      const reopen = reopenMode.reopen;
      const reopenId = String(reopen.reopen_id ?? "");
      const successorAlt = verifications.filter((ev) => String(ev.reopen_id ?? "") === reopenId);
      if (successorAlt.length === 0) {
        reasons.push(reason("missing_reopen_successor", `task ${taskId} requires alternative/manual verification with reopen_id=${repr(reopenId)} after reopen`));
      }
      const staleAlt = verifications
        .filter((ev) => String(ev.reopen_id ?? "") !== reopenId)
        .map((ev) => String(ev.evidence_id ?? ev.kind ?? ""))
        .filter(Boolean)
        .sort();
      if (staleAlt.length > 0) {
        reasons.push(reason("stale_reopen_successor", `task ${taskId} still has live pre-reopen alternative/manual verification evidence: ${renderList(staleAlt)}`, staleAlt));
      }
    }
  }
  if (reasons.length > 0) {
    const reasonSet = reason_codes(reasons);
    return block(change, gate, reasons, {
      task_id: taskId,
      next_actions: action_list(
        reasonSet.has("change_update_required") ? `return to propose/change update before any further apply work on ${taskId}` : null,
        reopenMode.mode === "blocked" ? `repair or recreate task_reopen package for ${taskId} before completion` : null,
        reopenMode.mode === "reopened" ? `record successor evidence with reopen_id for ${taskId} before check-task-complete` : null,
        `run test to GREEN + record evidence for ${taskId}`,
      ),
    });
  }
  return allow(change, gate, { task_id: taskId });
}

export function check_review_ready(change: string, status: JsonMap, changeRoot: string, evidences: JsonMap[]): Decision {
  const gate = "review_ready";
  const reasons: Reason[] = [];
  const nextActions: string[] = [];
  if (!all_done(status)) reasons.push(reason("artifacts_incomplete", "not all OpenSpec artifacts are done"));
  const propose = check_superspec_gate(change, status, changeRoot, evidences, "propose_complete");
  if (!propose.allowed) {
    reasons.push(reason("propose_not_complete", "review_ready requires propose_complete"));
    reasons.push(...propose.block_reasons);
    nextActions.push(...propose.next_allowed_actions);
    if (propose.next_allowed_actions.length === 0) nextActions.push("pass check-apply-ready / propose_complete before entering review");
  }
  const tasks = parse_tasks(changeRoot);
  const unchecked = Object.entries(tasks).filter(([, task]) => !task.checked).map(([taskId]) => taskId);
  if (unchecked.length > 0) {
    reasons.push(reason("tasks_incomplete", `unchecked tasks: ${renderList(unchecked)}`));
    nextActions.push("finish remaining unchecked tasks and mark them complete only after check-task-complete passes");
  }
  for (const [taskId, task] of Object.entries(tasks)) {
    if (!task.checked) continue;
    const taskDecision = check_task_complete(change, status, changeRoot, evidences, taskId);
    if (!taskDecision.allowed) {
      reasons.push(reason("task_evidence_incomplete", `checked task ${taskId} does not satisfy task_complete evidence`));
      reasons.push(...taskDecision.block_reasons);
      nextActions.push("rerun check-task-complete for each checked task and backfill missing GREEN or alternative verification evidence");
    }
  }
  const unresolvedReopens = unresolved_live_task_reopens(evidences);
  if (unresolvedReopens.length > 0) {
    const reopenTasks = unresolvedReopens.map((ev) => String(ev.task_id ?? "")).filter(Boolean).sort();
    reasons.push(reason("unresolved_task_reopen", `review_ready blocks while unresolved task_reopen exists: ${renderList(reopenTasks)}`, reopenTasks));
    nextActions.push("finish reopened apply, mark tasks complete again, and write task_reopen_resolved before re-entering review");
  }
  const lifecycleReasons = task_reopen_global_lifecycle_reasons(changeRoot, evidences);
  if (lifecycleReasons.length > 0) {
    reasons.push(...lifecycleReasons);
    nextActions.push("repair task_reopen lifecycle evidence and successor proof before re-entering review");
  }
  const [ok] = runtime.openspec_validate(change);
  if (!ok) {
    reasons.push(reason("validate_failed", "openspec validate did not pass"));
    nextActions.push(`fix openspec validate failures for ${change}`);
  }
  const repoRoot = get_repo_root(status);
  const dirtyWriteScopeReasons = runtime.dirty_write_scope_red_reasons(repoRoot, tasks, evidences);
  const dirtyWorktreeReasons = runtime.dirty_worktree_reasons(repoRoot, changeRoot, evidences);
  reasons.push(...dirtyWriteScopeReasons);
  reasons.push(...dirtyWorktreeReasons);
  if (dirtyWriteScopeReasons.length > 0) nextActions.push("record RED evidence for changed write_scope files before review");
  if (dirtyWorktreeReasons.length > 0) nextActions.push("record branch_handling human confirmation for unrelated dirty files, or clean them before review");
  if (reasons.length > 0) return block(change, gate, reasons, { next_actions: action_list(...nextActions) });
  return allow(change, gate);
}

export function check_review_complete(change: string, status: JsonMap, changeRoot: string, evidences: JsonMap[]): Decision {
  const gate = "review_complete";
  const pre = check_review_ready(change, status, changeRoot, evidences);
  const reasons: Reason[] = [];
  const repoRoot = get_repo_root(status);
  if (!pre.allowed) {
    reasons.push(reason("review_not_ready", "review_ready gate not satisfied"));
    reasons.push(...pre.block_reasons);
  }
  const reviews = live_pass(evidences, { gate: "review_complete" });
  reasons.push(...duplicate_output_ref_reasons(changeRoot, reviews));
  const sourceGuidance = reviews.filter((ev) => ev.kind === "source_guidance");
  const sourceGuidanceRoles = new Set(sourceGuidance.map((ev) => String(ev.agent_role)));
  const missingReviewRoles = REVIEW_GUIDANCE_ROLES.filter((need) => !sourceGuidanceRoles.has(need));
  for (const need of REVIEW_GUIDANCE_ROLES) {
    if (!sourceGuidanceRoles.has(need)) reasons.push(reason("missing_source_guidance", `review_complete requires ${need} source_guidance evidence`));
  }
  for (const ev of sourceGuidance) {
    for (const field of REVIEW_EVIDENCE_REQUIRED_FIELDS) {
      if (!ev[field]) reasons.push(reason("review_evidence_incomplete", `${ev._path}: missing ${field}`));
    }
    if (ev.reviewed_files !== undefined && (!Array.isArray(ev.reviewed_files) || ev.reviewed_files.length === 0)) reasons.push(reason("review_evidence_incomplete", `${ev._path}: reviewed_files must be a non-empty list`));
    reasons.push(...runtime.review_diff_coverage_reasons(repoRoot, ev));
    if (!Array.isArray(ev.rollback_targets) || ev.rollback_targets.length === 0) reasons.push(reason("missing_rollback_target", `${ev._path}: no rollback_targets`));
  }

  const mainAdjudications = reviews.filter((ev) => ev.kind === "main_adjudication");
  if (mainAdjudications.length === 1 && mainAdjudications[0].review_decision === "request_changes") {
    const adjudication = mainAdjudications[0];
    const requestChangeReasons = [...reasons, reason(
      "review_requests_changes",
      `${adjudication._path}: review_complete is allow-only; this review round ended with request_changes(${String(adjudication.request_changes_route ?? "missing_route")})`,
    )];
    const guidanceIds = new Set(sourceGuidance.map((ev) => String(ev.evidence_id)));
    const referencedIds = new Set((Array.isArray(adjudication.source_evidence_refs) ? adjudication.source_evidence_refs : []).map((item) => String(item)));
    const missingGuidance = [...guidanceIds].filter((id) => !referencedIds.has(id)).sort();
    if (missingGuidance.length > 0) {
      requestChangeReasons.push(reason("source_guidance_unreferenced", `${adjudication._path}: main_adjudication must reference every live source_guidance evidence_id: ${renderList(missingGuidance)}`, missingGuidance));
    }
    const unknownGuidanceRefs = [...referencedIds].filter((id) => !guidanceIds.has(id)).sort();
    if (unknownGuidanceRefs.length > 0) {
      requestChangeReasons.push(reason("source_guidance_unreferenced", `${adjudication._path}: source_evidence_refs must reference live source_guidance evidence only: ${renderList(unknownGuidanceRefs)}`, unknownGuidanceRefs));
    }
    const blockingIds = new Set((Array.isArray(adjudication.blocking_source_evidence_refs) ? adjudication.blocking_source_evidence_refs : []).map((item) => String(item)));
    const unknownBlockingRefs = [...blockingIds].filter((id) => !guidanceIds.has(id)).sort();
    if (unknownBlockingRefs.length > 0) {
      requestChangeReasons.push(reason("source_guidance_unreferenced", `${adjudication._path}: blocking_source_evidence_refs must reference live source_guidance evidence only: ${renderList(unknownBlockingRefs)}`, unknownBlockingRefs));
    }
    requestChangeReasons.push(...validate_evidence_schema(adjudication, change, changeRoot, repoRoot));
    requestChangeReasons.push(...sourceGuidance.flatMap((ev) => validate_evidence_schema(ev, change, changeRoot, repoRoot)));
    requestChangeReasons.push(...request_changes_round_reasons(evidences));
    const requestChangeOnly = requestChangeReasons.length === 1
      && requestChangeReasons[0].code === "review_requests_changes";
    return block(
      change,
      gate,
      requestChangeReasons,
      {
        next_actions: action_list(
          ...review_complete_actions(change, requestChangeReasons, pre, { missing_review_roles: missingReviewRoles }),
          ...(requestChangeOnly ? request_changes_handoff_actions(adjudication) : []),
        ),
      },
    );
  }

  const verifications = final_verification_evidences(evidences);
  const verificationProofs = live_pass(evidences, { gate: "review_complete" })
    .filter((ev) => ev.kind === "verification_review" || ev.kind === "final_test");
  const verifyReports = verifications.filter((ev) => ev.kind === "verification_review");
  const verifyRoles = new Set(verifyReports.map((ev) => ev.agent_role));
  const missingVerificationRoles = FINAL_VERIFICATION_ROLES.filter((need) => !verifyRoles.has(need));
  for (const need of FINAL_VERIFICATION_ROLES) {
    if (!verifyRoles.has(need)) reasons.push(reason("missing_final_verification_review", `missing verification_review by '${need}'`));
  }
  for (const ev of verifyReports) {
    for (const field of VERIFY_EVIDENCE_REQUIRED_FIELDS) {
      if (!ev[field]) reasons.push(reason("verification_evidence_incomplete", `${ev._path}: missing ${field}`));
    }
    reasons.push(...verify_reference_reasons(changeRoot, ev, evidences));
    reasons.push(...invariant_matrix_coverage_reasons(changeRoot, ev, evidences));
    if (![undefined, null, "none", "accepted"].includes(ev.scope_drift)) reasons.push(reason("scope_drift", `${ev._path}: scope_drift=${repr(ev.scope_drift)}`));
  }
  const finalTests = verificationProofs.filter((ev) => ev.kind === "final_test");
  if (finalTests.length === 0) {
    reasons.push(reason("missing_final_tests", "review_complete requires final_test pass evidence"));
  }

  // FIX-8 (audit A-5): a failed verification is a user decision point (fix vs accept deviation,
  // SPEC §14.4). History cannot be erased: every fail-status verification evidence — superseded
  // or not — must be covered by a live verify_failure_handling confirmation's confirmed_refs.
  const failedVerifications = evidences.filter((ev) =>
    normalize_gate(String(ev.gate ?? "")) === gate
    && (ev.kind === "verification_review" || ev.kind === "final_test")
    && ev.status === "fail");
  if (failedVerifications.length > 0) {
    const dispositions = new Set(
      live_pass(evidences, { gate: "verify_failure_handling", kind: "human_confirmation" })
        .flatMap((ev) => (Array.isArray(ev.confirmed_refs) ? ev.confirmed_refs.map((item) => String(item)) : [])),
    );
    const unhandled = failedVerifications
      .map((ev) => String(ev.evidence_id ?? ev._path ?? "unknown"))
      .filter((id) => !dispositions.has(id))
      .sort();
    if (unhandled.length > 0) {
      reasons.push(reason(
        "verify_failure_unconfirmed",
        `failed verification evidence requires explicit user disposition (fix or accept deviation) via gate="verify_failure_handling" human_confirmation confirming: ${renderList(unhandled)}`,
        unhandled,
      ));
    }
  }

  if (mainAdjudications.length === 0) {
    reasons.push(reason("missing_main_adjudication", "review_complete requires main_adjudication evidence authored by the main thread"));
  } else if (mainAdjudications.length > 1) {
    reasons.push(reason("ambiguous_main_adjudication", `review_complete requires exactly one live main_adjudication, found ${mainAdjudications.length}`));
  } else {
    const adjudication = mainAdjudications[0];
    if (adjudication.review_decision !== "allow") {
      reasons.push(reason("main_adjudication_invalid", `${adjudication._path}: review_complete only accepts main_adjudication.review_decision='allow'`));
    }
    const guidanceIds = new Set(sourceGuidance.map((ev) => String(ev.evidence_id)));
    const referencedIds = new Set((Array.isArray(adjudication.source_evidence_refs) ? adjudication.source_evidence_refs : []).map((item) => String(item)));
    const missingGuidance = [...guidanceIds].filter((id) => !referencedIds.has(id)).sort();
    if (missingGuidance.length > 0) {
      reasons.push(reason("source_guidance_unreferenced", `${adjudication._path}: main_adjudication must reference every live source_guidance evidence_id: ${renderList(missingGuidance)}`, missingGuidance));
    }
    const unknownGuidanceRefs = [...referencedIds].filter((id) => !guidanceIds.has(id)).sort();
    if (unknownGuidanceRefs.length > 0) {
      reasons.push(reason("source_guidance_unreferenced", `${adjudication._path}: source_evidence_refs must reference live source_guidance evidence only: ${renderList(unknownGuidanceRefs)}`, unknownGuidanceRefs));
    }
    const verificationIds = new Set(verificationProofs.map((ev) => String(ev.evidence_id)));
    const referencedVerificationIds = new Set((Array.isArray(adjudication.verification_evidence_refs) ? adjudication.verification_evidence_refs : []).map((item) => String(item)));
    const missingVerification = [...verificationIds].filter((id) => !referencedVerificationIds.has(id)).sort();
    if (missingVerification.length > 0) {
      reasons.push(reason("verification_evidence_unreferenced", `${adjudication._path}: main_adjudication must reference every live verification_review/final_test evidence_id: ${renderList(missingVerification)}`, missingVerification));
    }
    const verificationSetComplete = finalTests.length > 0 && missingVerificationRoles.length === 0;
    if (verificationSetComplete) {
      const unknownVerificationRefs = [...referencedVerificationIds].filter((id) => !verificationIds.has(id)).sort();
      if (unknownVerificationRefs.length > 0) {
        reasons.push(reason("verification_evidence_unreferenced", `${adjudication._path}: verification_evidence_refs must reference live verification_review/final_test evidence only: ${renderList(unknownVerificationRefs)}`, unknownVerificationRefs));
      }
    }
    reasons.push(...main_adjudication_source_guidance_reasons(adjudication, sourceGuidance));
  }
  const [ok] = runtime.openspec_validate(change);
  if (!ok) {
    reasons.push(reason("validate_failed", "openspec validate did not pass"));
  }
  if (reasons.length > 0) {
    return block(change, gate, reasons, {
      next_actions: review_complete_actions(change, reasons, pre, {
        missing_review_roles: missingReviewRoles,
        missing_verification_roles: missingVerificationRoles,
      }),
    });
  }
  return allow(change, gate);
}

export function check_verify_complete(change: string, status: JsonMap, changeRoot: string, evidences: JsonMap[]): Decision {
  return check_review_complete(change, status, changeRoot, evidences);
}

export function check_archive_ready(change: string, status: JsonMap, changeRoot: string, evidences: JsonMap[]): Decision {
  const gate = "archive_ready";
  const reasons: Reason[] = [];
  if (!all_done(status)) reasons.push(reason("artifacts_incomplete", "not all artifacts done"));
  const review = check_review_complete(change, status, changeRoot, evidences);
  const reviewCodes = reason_codes(review.block_reasons);
  if (!review.allowed) {
    reasons.push(reason("review_gate_failed", "archive_ready requires review_complete gate to pass"));
    reasons.push(...review.block_reasons);
  }
  const [ok] = runtime.openspec_validate(change);
  if (!ok && !reviewCodes.has("validate_failed")) {
    reasons.push(reason("validate_failed", "openspec validate did not pass"));
  }
  if (live_pass(evidences, { gate: "archive_ready", kind: "human_confirmation" }).length === 0) {
    reasons.push(reason("missing_final_confirmation", "archive_ready requires human confirmation evidence"));
  }
  if (reasons.length > 0) return block(change, gate, reasons, { next_actions: archive_ready_actions(change, reasons, review) });
  return allow(change, gate, { gate_summary: { archive_manifest: toPosix(relative(changeRoot, archive_manifest_path(changeRoot))) } });
}
