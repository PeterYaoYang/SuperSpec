import { existsSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import type { JsonMap, Reason } from "./util.ts";
import {
  CLAIM_ADJUDICATION_DECISIONS,
  EVIDENCE_KINDS,
  EVIDENCE_STATUSES,
  FINAL_VERIFICATION_ROLES,
  HUMAN_CONFIRMATION_GATES,
  FINAL_TEST_REQUIRED_FIELDS,
  FINDING_ADJUDICATION_DECISIONS,
  FORBIDDEN_FIELDS,
  MAIN_ADJUDICATION_DECISIONS,
  MAIN_ADJUDICATION_REQUIRED_FIELDS,
  NO_TDD_REASONS,
  REQUEST_CHANGES_ROUTES,
  ROLE_EVIDENCE_FIELDS,
  REVIEW_GUIDANCE_ROLES,
  SELF_REVIEW_MARKERS,
  SOURCE_GUIDANCE_REQUIRED_FIELDS,
  TASK_REOPEN_INVALIDITY_CLASSES,
  TASK_REOPEN_REQUIRED_FIELDS,
  TASK_REOPEN_RESOLVED_REQUIRED_FIELDS,
  VERIFY_EVIDENCE_REQUIRED_FIELDS,
  confirmation_text_has_pending_wording,
  fingerprint_obj,
  isObject,
  reason,
  renderList,
  repr,
  pinned_ref_key,
  runtime,
  safe_within,
  sha256_file,
  toPosix,
  UNCHECKED_CHECKBOX_RE,
  walkFiles,
} from "./util.ts";
import { effective_superseded_ids, normalize_gate } from "./openspec.ts";
import { superspec_dir } from "./paths.ts";
import {
  findings_schema_reasons,
  review_digest_schema_reasons,
  standing_authorization_schema_reasons,
  user_decision_schema_reasons,
} from "./disclosure.ts";
import {
  pinned_artifact_ref_reasons as shared_pinned_artifact_ref_reasons,
  worker_test_run_reasons,
} from "./apply_worker_chain.ts";
import { strictRoleRunlogReasons, strictRuntimeEvidenceReasons } from "./hooks/validation.ts";

function file_ref_reasons(baseRoot: string, ev: JsonMap, field: string, code: string): Reason[] {
  const problems: Reason[] = [];
  const raw = ev[field];
  if (raw === undefined) return problems;
  if (!Array.isArray(raw) || raw.length === 0) {
    problems.push(reason(code, `${ev._path}: ${field} must be a non-empty list`));
    return problems;
  }
  for (const refItem of raw) {
    if (typeof refItem !== "string" || !refItem) {
      problems.push(reason(code, `${ev._path}: ${field} entries must be non-empty strings`));
      continue;
    }
    const target = safe_within(baseRoot, refItem);
    if (target === null) {
      problems.push(reason("evidence_unsafe_ref", `${ev._path}: ${field} escapes allowed root: ${refItem}`));
      continue;
    }
    if (!existsSync(target) || !statSync(target).isFile()) {
      problems.push(reason(code, `${ev._path}: ${field} is not readable: ${refItem}`));
    }
  }
  return problems;
}

function contractField(line: string): { key: string; value: string } | null {
  const match = line.match(/^\s*-\s+`?([A-Za-z0-9_-]+)`?\s*:\s*(.*)$/);
  if (!match) return null;
  return { key: match[1], value: match[2].trim() };
}

function test_contract_section_lines(changeRoot: string, testId: string): string[] {
  const pathValue = join(changeRoot, ".superspec", "artifacts", "test-contract.md");
  if (!existsSync(pathValue) || !statSync(pathValue).isFile()) return [];
  const lines = readFileSync(pathValue, "utf8").split(/\r?\n/);
  const out: string[] = [];
  let inSection = false;
  for (const line of lines) {
    const heading = line.match(/^###\s+(.+?)\s*$/);
    if (heading) {
      if (inSection) break;
      inSection = heading[1].trim() === testId;
      continue;
    }
    if (inSection) out.push(line);
  }
  return out;
}

function expected_failure_contract(changeRoot: string, testId: string): { signature?: string; classifier?: string } {
  const fields = new Map<string, string[]>();
  for (const line of test_contract_section_lines(changeRoot, testId)) {
    const field = contractField(line);
    if (!field) continue;
    const values = fields.get(field.key) ?? [];
    values.push(field.value);
    fields.set(field.key, values);
  }
  const signature = (fields.get("expected_failure_signature") ?? [])[0];
  const classifier = (fields.get("expected_failure_classifier") ?? [])[0];
  return { signature, classifier };
}

function pinned_ref_list_reasons(
  ev: JsonMap,
  field: string,
  baseRoot: string,
  staleCode: string,
  opts: { allowEmpty?: boolean } = {},
): Reason[] {
  const problems: Reason[] = [];
  const raw = ev[field];
  if (!Array.isArray(raw)) {
    problems.push(reason("evidence_missing_field", `${ev._path}: ${field} must be a list`));
    return problems;
  }
  if (!opts.allowEmpty && raw.length === 0) {
    problems.push(reason("evidence_missing_field", `${ev._path}: ${field} must be a non-empty list`));
    return problems;
  }
  for (const refItem of raw) {
    if (!isObject(refItem)) {
      problems.push(reason(staleCode, `${ev._path}: ${field} item must be object`));
      continue;
    }
    const rel = refItem.path;
    const expected = refItem.blob_sha;
    if (typeof rel !== "string" || !rel || typeof expected !== "string" || !expected) {
      problems.push(reason(staleCode, `${ev._path}: ${field} requires path and blob_sha`));
      continue;
    }
    const target = safe_within(baseRoot, rel);
    if (target === null) {
      problems.push(reason("evidence_unsafe_ref", `${ev._path}: ${field} escapes allowed root: ${rel}`));
      continue;
    }
    if (!existsSync(target) || !statSync(target).isFile()) {
      problems.push(reason(staleCode, `${ev._path}: ${field} is not readable: ${rel}`));
      continue;
    }
    const actual = runtime.file_blob_sha(target);
    if (actual !== expected) problems.push(reason(staleCode, `${ev._path}: ${field} stale for ${rel}`));
  }
  return problems;
}

function pinned_ref_reasons(ev: JsonMap, field: string, baseRoot: string, staleCode: string): Reason[] {
  const problems: Reason[] = [];
  for (const refItem of ev[field] ?? []) {
    if (!isObject(refItem)) {
      problems.push(reason(staleCode, `${ev._path}: ${field} item must be object`));
      continue;
    }
    const rel = refItem.path;
    const expected = refItem.blob_sha;
    if (typeof rel !== "string" || typeof expected !== "string") {
      problems.push(reason(staleCode, `${ev._path}: ${field} requires path and blob_sha`));
      continue;
    }
    const target = safe_within(baseRoot, rel);
    if (target === null) {
      problems.push(reason("evidence_unsafe_ref", `${ev._path}: ${field} escapes allowed root: ${rel}`));
      continue;
    }
    if (!existsSync(target) || !statSync(target).isFile()) {
      problems.push(reason(staleCode, `${ev._path}: ${field} is not readable: ${rel}`));
      continue;
    }
    const actual = runtime.file_blob_sha(target);
    if (actual !== expected) problems.push(reason(staleCode, `${ev._path}: ${field} stale for ${rel}`));
  }
  return problems;
}

function string_list_field_reasons(ev: JsonMap, field: string, code: string, opts: { allowEmpty?: boolean } = {}): Reason[] {
  const raw = ev[field];
  if (!Array.isArray(raw) || (!opts.allowEmpty && raw.length === 0) || !raw.every((item) => typeof item === "string" && item.length > 0)) {
    return [reason(code, `${ev._path}: ${field} must be a non-empty string list`)];
  }
  return [];
}

const APPLY_WORKER_CHAIN_SURFACES = new Set(["implementation", "runtime_config"]);

function apply_worker_chain_ref_ids(ev: JsonMap, singleField: string, listField: string): string[] {
  const refs = new Set<string>();
  const single = ev[singleField];
  if (isObject(single) && typeof single.evidence_id === "string" && single.evidence_id) refs.add(single.evidence_id);
  else if (typeof single === "string" && single) refs.add(single);
  if (Array.isArray(ev[listField])) {
    for (const item of ev[listField]) {
      if (isObject(item) && typeof item.evidence_id === "string" && item.evidence_id) refs.add(item.evidence_id);
      else if (typeof item === "string" && item) refs.add(item);
    }
  }
  return [...refs].sort();
}

function fingerprint_field_reasons(ev: JsonMap, field: string, code: string): Reason[] {
  const raw = ev[field];
  if (typeof raw === "string") {
    return raw.startsWith("sha256:") ? [] : [reason(code, `${ev._path}: ${field} must be a sha256 fingerprint`)];
  }
  if (isObject(raw) && typeof raw.fingerprint_digest === "string" && raw.fingerprint_digest.startsWith("sha256:")) return [];
  return [reason(code, `${ev._path}: ${field} must be a sha256 fingerprint or fingerprint object`)];
}

function pinned_artifact_ref_item_reasons(
  refItem: unknown,
  field: string,
  changeRoot: string,
  expected: { kind?: string; role?: string; task_id?: string; chain_id?: string | null } = {},
): Reason[] {
  return shared_pinned_artifact_ref_reasons(changeRoot, refItem, field, {
    kind: expected.kind,
    role: expected.role,
    taskId: expected.task_id,
    chainId: expected.chain_id,
  });
}

export function role_target_ref_reasons(ev: JsonMap, targetRoot: string): Reason[] {
  const problems: Reason[] = [];
  const raw = ev.target_refs;
  if (!Array.isArray(raw)) {
    problems.push(reason("target_ref_invalid", `${ev._path}: target_refs must be a list of {path, blob_sha}`));
    return problems;
  }
  for (const refItem of raw) {
    if (!isObject(refItem)) {
      problems.push(reason("target_ref_invalid", `${ev._path}: target_refs item must be object`));
      continue;
    }
    const rel = refItem.path;
    const expected = refItem.blob_sha;
    if (typeof rel !== "string" || !rel || typeof expected !== "string" || !expected) {
      problems.push(reason("target_ref_invalid", `${ev._path}: target_refs requires path and blob_sha`));
      continue;
    }
    const target = safe_within(targetRoot, rel);
    if (target === null) {
      problems.push(reason("evidence_unsafe_ref", `${ev._path}: target_refs escapes allowed root: ${rel}`));
      continue;
    }
    if (!existsSync(target) || !statSync(target).isFile()) {
      problems.push(reason("stale_review", `${ev._path}: target_refs is not readable: ${rel}`));
      continue;
    }
    const actual = runtime.file_blob_sha(target);
    if (actual !== expected) problems.push(reason("stale_review", `${ev._path}: target_refs stale for ${rel}`));
  }
  return problems;
}

export function loaded_ref_reasons(ev: JsonMap, repoRoot: string): Reason[] {
  return pinned_ref_reasons(ev, "loaded_refs", repoRoot, "stale_loaded_ref");
}

export function verify_reference_reasons(changeRoot: string, ev: JsonMap, evidences: JsonMap[]): Reason[] {
  const problems: Reason[] = [];
  for (const field of ["openspec_validate_ref", "task_matrix_ref", "invariant_matrix_ref", "scope_drift_ref"]) {
    const value = ev[field];
    if (typeof value !== "string" || !value) continue;
    const filePath = safe_within(changeRoot, value);
    if (filePath === null) problems.push(reason("verification_ref_invalid", `${ev._path}: ${field} escapes change root: ${value}`));
    else if (!existsSync(filePath) || !statSync(filePath).isFile()) problems.push(reason("verification_ref_missing", `${ev._path}: ${field} is not readable: ${value}`));
  }
  const refs = ev.test_evidence_refs;
  if (refs === undefined) return problems;
  if (!Array.isArray(refs) || refs.length === 0) {
    problems.push(reason("verification_evidence_incomplete", `${ev._path}: test_evidence_refs must be a non-empty list`));
    return problems;
  }
  if (evidences.length === 0) return problems;
  const liveIds = new Set(live_pass(evidences).map((item) => item.evidence_id));
  const missing = refs.map((item) => String(item)).filter((item) => !liveIds.has(item)).sort();
  if (missing.length > 0) problems.push(reason("test_evidence_ref_missing", `${ev._path}: test_evidence_refs not live/pass: ${renderList(missing)}`, missing));
  return problems;
}

function is_final_verification_evidence(ev: JsonMap): boolean {
  if (ev.kind === "final_test" || ev.kind === "verification_review") return true;
  if (ev.agent_role === "verifier") return true;
  return VERIFY_EVIDENCE_REQUIRED_FIELDS.some((field) => field in ev);
}

export function is_final_verification_only_evidence(ev: JsonMap): boolean {
  return ev.kind === "final_test" || ev.kind === "verification_review" || ev.agent_role === "verifier";
}

export function final_verification_evidences(evidences: JsonMap[]): JsonMap[] {
  return live_pass(evidences, { gate: "review_complete" }).filter(is_final_verification_evidence);
}

export function index_evidence(changeRoot: string): JsonMap[] {
  const evRoot = join(superspec_dir(changeRoot), "evidence");
  const out: JsonMap[] = [];
  if (!existsSync(evRoot) || !statSync(evRoot).isDirectory()) return out;
  for (const filePath of walkFiles(evRoot).sort()) {
    if (!filePath.endsWith(".json")) continue;
    try {
      const data = JSON.parse(readFileSync(filePath, "utf8"));
      data._path = toPosix(relative(changeRoot, filePath));
      out.push(data);
    } catch {
      out.push({ _invalid: true, _path: toPosix(relative(changeRoot, filePath)) });
    }
  }
  return out;
}

export function evidence_fingerprint(changeRoot: string): string {
  const evRoot = join(superspec_dir(changeRoot), "evidence");
  const items: JsonMap[] = [];
  if (existsSync(evRoot) && statSync(evRoot).isDirectory()) {
    for (const filePath of walkFiles(evRoot).sort()) {
      if (filePath.endsWith(".json")) items.push({ path: toPosix(relative(changeRoot, filePath)), sha: sha256_file(filePath) });
    }
  }
  return fingerprint_obj(items);
}

function output_ref_reasons(
  ev: JsonMap,
  changeRoot: string,
  field = "output_ref",
  refCodes: { missing: string; empty: string } = { missing: "evidence_output_missing", empty: "evidence_output_empty" },
): Reason[] {
  const problems: Reason[] = [];
  const outputRef = ev[field];
  if (typeof outputRef !== "string" || !outputRef) {
    problems.push(reason("evidence_missing_field", `${ev._path}: ${field} must be a string`));
    return problems;
  }
  const outputPath = safe_within(changeRoot, outputRef);
  if (outputPath === null) problems.push(reason("evidence_unsafe_ref", `${ev._path}: ${field} escapes change root: ${outputRef}`));
  else if (!existsSync(outputPath) || !statSync(outputPath).isFile()) problems.push(reason(refCodes.missing, `${ev._path}: ${field} is not readable: ${outputRef}`));
  else {
    const text = readFileSync(outputPath, "utf8");
    if (text.trim().length === 0) problems.push(reason(refCodes.empty, `${ev._path}: ${field} must point to non-empty review/test output: ${outputRef}`));
  }
  return problems;
}

function file_identity(path: string): string {
  const st = statSync(path);
  return `${st.dev}:${st.ino}`;
}

function output_ref_target_overlap_reasons(ev: JsonMap, changeRoot: string, targetRoot: string): Reason[] {
  const problems: Reason[] = [];
  const outputRef = ev.output_ref;
  if (typeof outputRef !== "string" || !outputRef || !Array.isArray(ev.target_refs)) return problems;
  const outputPath = safe_within(changeRoot, outputRef);
  if (outputPath === null || !existsSync(outputPath) || !statSync(outputPath).isFile()) return problems;
  const outputIdentity = file_identity(outputPath);
  for (const refItem of ev.target_refs) {
    if (!isObject(refItem) || typeof refItem.path !== "string" || !refItem.path) continue;
    const targetPath = safe_within(targetRoot, refItem.path);
    if (targetPath === null || !existsSync(targetPath) || !statSync(targetPath).isFile()) continue;
    if (file_identity(targetPath) === outputIdentity) {
      problems.push(reason("evidence_output_ref_invalid", `${ev._path}: output_ref must not point at a reviewed target file: ${outputRef}`));
      break;
    }
  }
  return problems;
}

function string_list_reasons(ev: JsonMap, field: string, opts: { allowEmpty?: boolean } = {}): Reason[] {
  const problems: Reason[] = [];
  const raw = ev[field];
  if (!Array.isArray(raw)) {
    problems.push(reason("evidence_missing_field", `${ev._path}: ${field} must be a list`));
    return problems;
  }
  if (!opts.allowEmpty && raw.length === 0) {
    problems.push(reason("evidence_missing_field", `${ev._path}: ${field} must be a non-empty list`));
    return problems;
  }
  for (const item of raw) {
    if (typeof item !== "string" || !item) problems.push(reason("evidence_missing_field", `${ev._path}: ${field} entries must be non-empty strings`));
  }
  return problems;
}

function object_list_reasons(ev: JsonMap, field: string, opts: { allowEmpty?: boolean } = {}): Reason[] {
  const problems: Reason[] = [];
  const raw = ev[field];
  if (!Array.isArray(raw)) {
    problems.push(reason("evidence_missing_field", `${ev._path}: ${field} must be a list`));
    return problems;
  }
  if (!opts.allowEmpty && raw.length === 0) {
    problems.push(reason("evidence_missing_field", `${ev._path}: ${field} must be a non-empty list`));
    return problems;
  }
  for (const item of raw) {
    if (!isObject(item)) problems.push(reason("evidence_missing_field", `${ev._path}: ${field} entries must be objects`));
  }
  return problems;
}

function finding_string_list_reasons(ev: JsonMap, finding: JsonMap, field: string, opts: { allowEmpty?: boolean } = {}): Reason[] {
  const problems: Reason[] = [];
  const raw = finding[field];
  if (!Array.isArray(raw)) {
    problems.push(reason("blocking_findings_invalid", `${ev._path}: blocking finding ${repr(finding.finding_id)} requires ${field} to be a list`));
    return problems;
  }
  const values = raw.map((item: unknown) => String(item)).filter(Boolean);
  if (!opts.allowEmpty && values.length === 0) {
    problems.push(reason("blocking_findings_invalid", `${ev._path}: blocking finding ${repr(finding.finding_id)} requires non-empty ${field}`));
    return problems;
  }
  if (values.length !== raw.length) {
    problems.push(reason("blocking_findings_invalid", `${ev._path}: blocking finding ${repr(finding.finding_id)} requires non-empty string entries in ${field}`));
  }
  return problems;
}

// FIX-7 (audit C-3): human_confirmation minimal schema. The confirmation must say what was
// confirmed (confirmation_text), reference the confirmed content (confirmed_refs, or
// confirmed_paths for branch_handling), and target a gate where the guard actually consumes it.
function human_confirmation_reasons(ev: JsonMap): Reason[] {
  const problems: Reason[] = [];
  const gate = normalize_gate(String(ev.gate ?? ""));
  if (String(ev.created_by ?? "") !== "user") {
    problems.push(reason("human_confirmation_invalid", `${ev._path}: human_confirmation must be created_by user`));
  }
  if (!HUMAN_CONFIRMATION_GATES.has(gate)) {
    problems.push(reason(
      "human_confirmation_invalid",
      `${ev._path}: human_confirmation gate=${repr(ev.gate)} is not consumed by any guard gate; expected one of ${renderList([...HUMAN_CONFIRMATION_GATES].sort())}`,
    ));
  }
  if (typeof ev.confirmation_text !== "string" || !ev.confirmation_text.trim()) {
    problems.push(reason("human_confirmation_invalid", `${ev._path}: human_confirmation requires non-empty confirmation_text`));
  }
  const refsField = gate === "branch_handling" ? "confirmed_paths" : "confirmed_refs";
  const refs = ev[refsField];
  if (!Array.isArray(refs) || refs.length === 0 || !refs.every((item) => typeof item === "string" && item.trim())) {
    problems.push(reason("human_confirmation_invalid", `${ev._path}: human_confirmation requires non-empty string list ${refsField}`));
  }
  // FIX-8 (audit A-5): apply-scope confirmations must pin the approved tasks.md structure so the
  // guard can detect scope expansion (structural tasks.md edits) after the user's approval.
  if ((gate === "apply_isolation" || gate === "scope_expansion")
    && (typeof ev.tasks_structure_hash !== "string" || !ev.tasks_structure_hash.trim())) {
    problems.push(reason("human_confirmation_invalid", `${ev._path}: ${gate} human_confirmation requires tasks_structure_hash pinning the approved tasks.md structure`));
  }
  // B3: a pass confirmation must not carry unresolved signals. Strong signal: an unchecked checkbox
  // "[ ]" pasted into confirmation_text (the agent copied an open question list into the confirmation).
  // Weak signal: confirmation-pending wording shared with the explore gate (仍需确认 / 待确认 / ...),
  // scoped to confirmation semantics so legitimate "细节仍需在 propose 细化" prose is not flagged.
  // Real incident: secondment-hour-unit-support sealed status:"pass" while its confirmation_text said
  // "还需要评估..." — the gate's presence-check then let propose through with 8 open questions.
  const ctext = typeof ev.confirmation_text === "string" ? ev.confirmation_text : "";
  if (UNCHECKED_CHECKBOX_RE.test(ctext) || confirmation_text_has_pending_wording(ctext)) {
    problems.push(reason("human_confirmation_invalid", `${ev._path}: confirmation_text carries unresolved signals (unchecked checkbox or 「仍需确认/待确认」wording); do not record pass while open items remain`));
  }
  return problems;
}

// FIX-10 (audit C-5/H-4): test_run evidence is archived per run, not as a bare self-report.
// Every run must reference its raw log(s) (readable, non-empty, change-root relative), carry a
// result_summary, and every claimed test id (test_id / test_ids[]) must actually appear in at
// least one referenced log — a grep-level reality check; exit-code truth stays a v2 hook concern.
// Per-test fan-out stays legal, but a consolidated per-run record with test_ids[] is preferred.
function test_run_reasons(ev: JsonMap, changeRoot: string): Reason[] {
  const problems: Reason[] = [];
  const rawRefs = ev.raw_log_refs;
  const logTexts: string[] = [];
  if (!Array.isArray(rawRefs) || rawRefs.length === 0 || !rawRefs.every((item) => typeof item === "string" && item.trim())) {
    problems.push(reason("test_run_log_missing", `${ev._path}: test_run requires non-empty string list raw_log_refs`));
  } else {
    for (const refItem of rawRefs) {
      const target = safe_within(changeRoot, refItem);
      if (target === null) {
        problems.push(reason("evidence_unsafe_ref", `${ev._path}: raw_log_refs escapes change root: ${refItem}`));
        continue;
      }
      if (!existsSync(target) || !statSync(target).isFile()) {
        problems.push(reason("test_run_log_missing", `${ev._path}: raw_log_refs is not readable: ${refItem}`));
        continue;
      }
      const text = readFileSync(target, "utf8");
      if (!text.trim()) {
        problems.push(reason("test_run_log_missing", `${ev._path}: raw_log_refs must point to non-empty test output: ${refItem}`));
        continue;
      }
      logTexts.push(text);
    }
  }
  if (typeof ev.result_summary !== "string" || !ev.result_summary.trim()) {
    problems.push(reason("test_run_summary_missing", `${ev._path}: test_run requires non-empty result_summary`));
  }
  const runnerOrigin = ev.runner_origin;
  const executorWorkerRun = ev.apply_execution_chain === "executor_worker";
  if (runnerOrigin !== undefined && runnerOrigin !== "main-thread" && runnerOrigin !== "test-runner") {
    problems.push(reason("test_run_runner_origin_invalid", `${ev._path}: runner_origin must be main-thread or test-runner`));
  }
  if (runnerOrigin === "test-runner" && (typeof ev.phase !== "string" || !ev.phase)) {
    problems.push(reason("test_run_runner_origin_invalid", `${ev._path}: runner_origin=test-runner requires phase`));
  }
  if (runnerOrigin === "test-runner" && ev.gate === "task_complete" && ev.semantic_status === "expected_success" && !executorWorkerRun) {
    problems.push(reason("test_run_runner_origin_invalid", `${ev._path}: test-runner GREEN evidence must belong to apply_execution_chain=executor_worker`));
  }
  if (executorWorkerRun && runnerOrigin !== "test-runner") {
    problems.push(reason("test_run_runner_origin_invalid", `${ev._path}: apply_execution_chain=executor_worker requires runner_origin=test-runner`));
  }
  if (executorWorkerRun && (typeof ev.apply_worker_chain_id !== "string" || !ev.apply_worker_chain_id)) {
    problems.push(reason("test_run_worker_ref_missing", `${ev._path}: apply_execution_chain=executor_worker requires apply_worker_chain_id`));
  }
  if (runnerOrigin === "test-runner" || executorWorkerRun) {
    problems.push(...worker_test_run_reasons(
      changeRoot,
      ev,
      typeof ev.task_id === "string" ? ev.task_id : "",
      executorWorkerRun && typeof ev.apply_worker_chain_id === "string" ? ev.apply_worker_chain_id : null,
    ));
  }
  if (logTexts.length > 0) {
    const claimed = [
      ...(typeof ev.test_id === "string" && ev.test_id.trim() ? [ev.test_id.trim()] : []),
      ...(Array.isArray(ev.test_ids) ? ev.test_ids.filter((item) => typeof item === "string" && item.trim()).map((item) => String(item).trim()) : []),
    ];
    for (const testId of claimed) {
      if (!logTexts.some((text) => text.includes(testId))) {
        problems.push(reason("test_id_not_in_log", `${ev._path}: claimed test_id ${repr(testId)} does not appear in any referenced raw log`, [testId]));
      }
    }
  }
  if (ev.semantic_status === "expected_failure" && typeof ev.test_id === "string" && ev.test_id.trim()) {
    const expected = expected_failure_contract(changeRoot, ev.test_id.trim());
    if (expected.signature) {
      if (ev.expected_failure_signature !== expected.signature) {
        problems.push(reason("test_run_wrong_failure_reason", `${ev._path}: RED evidence expected_failure_signature must match test contract for ${ev.test_id}`, [ev.test_id]));
      }
      if (!logTexts.some((text) => text.includes(String(expected.signature)))) {
        problems.push(reason("test_run_wrong_failure_reason", `${ev._path}: RED raw_log_refs do not contain expected_failure_signature for ${ev.test_id}`, [ev.test_id]));
      }
    }
    if (expected.classifier && ev.expected_failure_classifier !== expected.classifier) {
      problems.push(reason("test_run_wrong_failure_reason", `${ev._path}: RED evidence expected_failure_classifier must match test contract for ${ev.test_id}`, [ev.test_id]));
    }
  }
  return problems;
}

function apply_worker_chain_reasons(ev: JsonMap, changeRoot: string): Reason[] {
  const problems: Reason[] = [];
  const state = String(ev.chain_state ?? "");
  if (!["active", "closed", "abandoned"].includes(state)) {
    problems.push(reason("apply_worker_chain_invalid", `${ev._path}: apply_worker_chain chain_state must be active, closed, or abandoned`));
  }
  for (const field of ["task_id", "apply_worker_chain_id"]) {
    if (typeof ev[field] !== "string" || !ev[field]) problems.push(reason("apply_worker_chain_invalid", `${ev._path}: apply_worker_chain requires ${field}`));
  }
  if (state === "active") {
    problems.push(...fingerprint_field_reasons(ev, "executor_packet_fingerprint", "apply_worker_chain_invalid"));
    problems.push(...fingerprint_field_reasons(ev, "source_implementation_fingerprint", "apply_worker_chain_invalid"));
    problems.push(...string_list_field_reasons(ev, "declared_task_write_scope", "apply_worker_chain_invalid"));
    const proofKind = String(ev.pre_edit_proof_kind ?? "red_or_characterization");
    if (proofKind !== "red_or_characterization" && proofKind !== "no_tdd_declared") {
      problems.push(reason("apply_worker_chain_invalid", `${ev._path}: active apply_worker_chain pre_edit_proof_kind must be red_or_characterization or no_tdd_declared`));
    } else if (proofKind === "no_tdd_declared") {
      problems.push(...string_list_field_reasons(ev, "pre_edit_evidence_refs", "apply_worker_chain_invalid", { allowEmpty: true }));
      if (Array.isArray(ev.pre_edit_evidence_refs) && ev.pre_edit_evidence_refs.length > 0) {
        problems.push(reason("apply_worker_chain_invalid", `${ev._path}: no_tdd_declared active apply_worker_chain requires empty pre_edit_evidence_refs`));
      }
      if (ev.tdd_required !== false) {
        problems.push(reason("apply_worker_chain_invalid", `${ev._path}: no_tdd_declared active apply_worker_chain requires tdd_required=false`));
      }
      if (!APPLY_WORKER_CHAIN_SURFACES.has(String(ev.apply_execution_surface ?? ""))) {
        problems.push(reason("apply_worker_chain_invalid", `${ev._path}: no_tdd_declared active apply_worker_chain requires apply_execution_surface implementation or runtime_config`));
      }
      if (!NO_TDD_REASONS.has(String(ev.no_tdd_reason ?? ""))) {
        problems.push(reason("apply_worker_chain_invalid", `${ev._path}: no_tdd_declared active apply_worker_chain requires valid no_tdd_reason`));
      }
    } else {
      problems.push(...string_list_field_reasons(ev, "pre_edit_evidence_refs", "apply_worker_chain_invalid"));
    }
  }
  if (state === "closed") {
    const taskId = typeof ev.task_id === "string" ? ev.task_id : undefined;
    const chainId = typeof ev.apply_worker_chain_id === "string" ? ev.apply_worker_chain_id : undefined;
    const refProblems = [
      ...pinned_artifact_ref_item_reasons(ev.executor_report_ref, "executor_report_ref", changeRoot, { kind: "worker_report", role: "executor", task_id: taskId, chain_id: chainId }),
      ...pinned_artifact_ref_item_reasons(ev.task_code_review_report_ref, "task_code_review_report_ref", changeRoot, { kind: "worker_report", role: "code-reviewer", task_id: taskId, chain_id: chainId }),
      ...pinned_artifact_ref_item_reasons(ev.verifier_report_ref, "verifier_report_ref", changeRoot, { kind: "worker_report", role: "verifier", task_id: taskId, chain_id: chainId }),
    ];
    problems.push(...refProblems);
    if (refProblems.length > 0) problems.push(reason("apply_worker_chain_invalid", `${ev._path}: closed apply_worker_chain report refs must be pinned same-chain worker reports`));
    const proofKind = String(ev.completion_proof_kind ?? "green_tests");
    if (proofKind !== "green_tests" && proofKind !== "alternative_verification") {
      problems.push(reason("apply_worker_chain_invalid", `${ev._path}: closed apply_worker_chain completion_proof_kind must be green_tests or alternative_verification`));
    } else if (proofKind === "green_tests") {
      if (apply_worker_chain_ref_ids(ev, "green_test_run_evidence_ref", "green_test_run_evidence_refs").length === 0) {
        problems.push(reason("apply_worker_chain_invalid", `${ev._path}: green_tests closed apply_worker_chain requires green_test_run_evidence_ref(s)`));
      }
    } else if (apply_worker_chain_ref_ids(ev, "alternative_verification_evidence_ref", "alternative_verification_evidence_refs").length === 0) {
      problems.push(reason("apply_worker_chain_invalid", `${ev._path}: alternative_verification closed apply_worker_chain requires alternative_verification_evidence_ref(s)`));
    }
    problems.push(...fingerprint_field_reasons(ev, "observed_freshness_fingerprint", "apply_worker_chain_invalid"));
  }
  if (state === "abandoned") {
    const taskId = typeof ev.task_id === "string" ? ev.task_id : undefined;
    const chainId = typeof ev.apply_worker_chain_id === "string" ? ev.apply_worker_chain_id : undefined;
    if ("restored_implementation_fingerprint" in ev) {
      problems.push(...fingerprint_field_reasons(ev, "restored_implementation_fingerprint", "apply_worker_chain_invalid"));
    }
    if ("restored_implementation_fingerprint" in ev && "serial_takeover_baseline_ref" in ev) {
      problems.push(reason("apply_worker_chain_invalid", `${ev._path}: abandoned apply_worker_chain restored_implementation_fingerprint and serial_takeover_baseline_ref are mutually exclusive`));
    }
    if (!("restored_implementation_fingerprint" in ev) && !("serial_takeover_baseline_ref" in ev)) {
      problems.push(reason("apply_worker_chain_invalid", `${ev._path}: abandoned apply_worker_chain requires restored_implementation_fingerprint or serial_takeover_baseline_ref`));
    }
    if ("serial_takeover_baseline_ref" in ev) {
      const baselineProblems = pinned_artifact_ref_item_reasons(
        ev.serial_takeover_baseline_ref,
        "serial_takeover_baseline_ref",
        changeRoot,
        { kind: "status_report", role: "verifier", task_id: taskId, chain_id: chainId },
      );
      problems.push(...baselineProblems);
      if (baselineProblems.length > 0) problems.push(reason("apply_worker_chain_invalid", `${ev._path}: abandoned apply_worker_chain serial_takeover_baseline_ref must be a pinned same-chain status_report`));
      if (typeof ev.takeover_confirmation_evidence_id !== "string" || !ev.takeover_confirmation_evidence_id) {
        problems.push(reason("apply_worker_chain_invalid", `${ev._path}: abandoned apply_worker_chain serial takeover requires takeover_confirmation_evidence_id`));
      }
      if ("successor_green_evidence_refs" in ev) {
        problems.push(...string_list_field_reasons(ev, "successor_green_evidence_refs", "apply_worker_chain_invalid"));
      }
    }
  }
  return problems;
}

export function validate_evidence_schema(ev: JsonMap, change: string, changeRoot: string, repoRoot: string): Reason[] {
  const problems: Reason[] = [];
  if (ev._invalid) return [reason("evidence_unparsable", `evidence not valid json: ${ev._path}`)];
  for (const field of ["schema_version", "evidence_id", "change_id", "gate", "kind", "created_at", "created_by", "status"]) {
    if (!(field in ev)) problems.push(reason("evidence_missing_field", `${ev._path}: missing ${field}`));
  }
  if (!EVIDENCE_STATUSES.has(String(ev.status))) problems.push(reason("evidence_bad_status", `${ev._path}: status=${repr(ev.status)}`));
  // FIX-7 (audit C-3): unknown kinds fail loudly instead of silently becoming "missing evidence".
  if (ev.kind !== undefined && !EVIDENCE_KINDS.has(String(ev.kind))) {
    problems.push(reason("evidence_unknown_kind", `${ev._path}: unknown kind ${repr(ev.kind)}; known kinds: ${renderList([...EVIDENCE_KINDS].sort())}`));
  }
  if (ev.kind === "human_confirmation") problems.push(...human_confirmation_reasons(ev));
  if (ev.kind === "test_run") problems.push(...test_run_reasons(ev, changeRoot));
  problems.push(...strictRuntimeEvidenceReasons(ev));
  if (ev.kind === "apply_worker_chain") problems.push(...apply_worker_chain_reasons(ev, changeRoot));
  // DISC Phase 1: disclosure evidence kinds and reviewer findings[] are schema-checked fail-closed.
  if (ev.kind === "main_review_digest") problems.push(...review_digest_schema_reasons(ev));
  if (ev.kind === "user_review_decision") problems.push(...user_decision_schema_reasons(ev));
  if (ev.kind === "review_standing_authorization") problems.push(...standing_authorization_schema_reasons(ev));
  if (ev.findings !== undefined) problems.push(...findings_schema_reasons(ev));
  if (ev.change_id !== undefined && ev.change_id !== change) problems.push(reason("evidence_change_mismatch", `${ev._path}: change_id=${repr(ev.change_id)} != ${change}`));
  for (const forbidden of Object.keys(ev).filter((key) => FORBIDDEN_FIELDS.has(key))) {
    problems.push(reason("evidence_forbidden_field", `${ev._path}: forbidden ${forbidden}`));
  }
  const base = superspec_dir(changeRoot);
  for (const refItem of ev.refs ?? []) {
    if (safe_within(base, String(refItem)) === null) problems.push(reason("evidence_unsafe_ref", `${ev._path}: ref escapes .superspec: ${refItem}`));
  }
  if (ev.agent_role) {
    const mode = ev.execution_mode;
    if (mode === "direct") problems.push(reason("self_review_not_allowed", `${ev._path}: role evidence cannot use execution_mode=direct`));
    else if (mode !== "native_subagent") problems.push(reason("missing_native_subagent_evidence", `${ev._path}: role evidence requires execution_mode=native_subagent`));
    const markerValues = new Set([String(ev.created_by ?? "").toLowerCase(), String(ev.agent_id ?? "").toLowerCase()]);
    if ([...markerValues].some((item) => SELF_REVIEW_MARKERS.has(item))) problems.push(reason("self_review_not_allowed", `${ev._path}: main-thread/self-review marker is not allowed`));
    for (const field of ROLE_EVIDENCE_FIELDS) {
      if (!(field in ev)) problems.push(reason("evidence_missing_field", `${ev._path}: role evidence missing ${field}`));
    }
    const outputRef = ev.output_ref;
    if (outputRef !== undefined) problems.push(...output_ref_reasons(ev, changeRoot));
    // FIX-9 (audit C-4): prompt_ref gets the same readable/non-empty treatment as output_ref;
    // a role evidence whose prompt never existed is a forged delegation claim by construction.
    if (ev.prompt_ref !== undefined) {
      problems.push(...output_ref_reasons(ev, changeRoot, "prompt_ref", { missing: "evidence_prompt_missing", empty: "evidence_prompt_empty" }));
    }
    if (!Array.isArray(ev.target_refs) || ev.target_refs.length === 0) problems.push(reason("missing_target_refs", `${ev._path}: role evidence requires non-empty target_refs`));
    const targetRoot = ev.kind === "source_guidance" ? repoRoot : changeRoot;
    problems.push(...role_target_ref_reasons(ev, targetRoot));
    problems.push(...output_ref_target_overlap_reasons(ev, changeRoot, targetRoot));
    problems.push(...strictRoleRunlogReasons(changeRoot, ev));
  }
  if (ev.kind === "source_guidance") {
    if (!REVIEW_GUIDANCE_ROLES.includes(String(ev.agent_role) as (typeof REVIEW_GUIDANCE_ROLES)[number])) {
      problems.push(reason("review_guidance_role_invalid", `${ev._path}: source_guidance requires agent_role in ${renderList([...REVIEW_GUIDANCE_ROLES])}`));
    }
    for (const field of SOURCE_GUIDANCE_REQUIRED_FIELDS) {
      if (!(field in ev)) problems.push(reason("evidence_missing_field", `${ev._path}: source_guidance missing ${field}`));
    }
    problems.push(...pinned_ref_list_reasons(ev, "source_refs", repoRoot, "source_ref_invalid"));
    problems.push(...pinned_ref_list_reasons(ev, "required_load_refs", repoRoot, "required_load_invalid", { allowEmpty: true }));
    problems.push(...string_list_reasons(ev, "required_claim_ids", { allowEmpty: true }));
    problems.push(...object_list_reasons(ev, "blocking_findings", { allowEmpty: true }));
    problems.push(...object_list_reasons(ev, "non_blocking_findings", { allowEmpty: true }));
    problems.push(...object_list_reasons(ev, "finding_dispositions", { allowEmpty: true }));
    if (Array.isArray(ev.required_load_refs) && Array.isArray(ev.source_refs)) {
      const allowed = new Set(ev.source_refs.filter(isObject).map((item) => pinned_ref_key(item)));
      const missing = ev.required_load_refs
        .filter(isObject)
        .map((item) => ({ item, key: pinned_ref_key(item) }))
        .filter(({ key }) => !allowed.has(key))
        .map(({ item }) => String(item.path));
      if (missing.length > 0) problems.push(reason("required_load_invalid", `${ev._path}: required_load_refs must be drawn from source_refs: ${renderList(missing)}`, missing));
    }
    const blockingIds = new Set<string>();
    for (const finding of Array.isArray(ev.blocking_findings) ? ev.blocking_findings : []) {
      if (!isObject(finding) || typeof finding.finding_id !== "string" || !finding.finding_id) {
        problems.push(reason("blocking_findings_invalid", `${ev._path}: blocking_findings entries require non-empty finding_id`));
        continue;
      }
      blockingIds.add(finding.finding_id);
      if ("affected_task_ids" in finding) problems.push(...finding_string_list_reasons(ev, finding, "affected_task_ids"));
      if ("violated_test_ids" in finding) problems.push(...finding_string_list_reasons(ev, finding, "violated_test_ids", { allowEmpty: true }));
      if ("violated_requirement_refs" in finding) problems.push(...finding_string_list_reasons(ev, finding, "violated_requirement_refs", { allowEmpty: true }));
      if ("why_completion_invalid" in finding && (typeof finding.why_completion_invalid !== "string" || !finding.why_completion_invalid)) {
        problems.push(reason("blocking_findings_invalid", `${ev._path}: blocking finding ${repr(finding.finding_id)} requires why_completion_invalid`));
      }
      if ("required_fix" in finding && (typeof finding.required_fix !== "string" || !finding.required_fix)) {
        problems.push(reason("blocking_findings_invalid", `${ev._path}: blocking finding ${repr(finding.finding_id)} requires required_fix`));
      }
      if ("completion_invalidity_class" in finding
        && !TASK_REOPEN_INVALIDITY_CLASSES.includes(String(finding.completion_invalidity_class) as (typeof TASK_REOPEN_INVALIDITY_CLASSES)[number])) {
        problems.push(reason("blocking_findings_invalid", `${ev._path}: blocking finding ${repr(finding.finding_id)} has unsupported completion_invalidity_class=${repr(finding.completion_invalidity_class)}`));
      }
      if ("scope_expansion" in finding && typeof finding.scope_expansion !== "boolean") {
        problems.push(reason("blocking_findings_invalid", `${ev._path}: blocking finding ${repr(finding.finding_id)} requires boolean scope_expansion`));
      }
      if ("reopen_recommendation" in finding && typeof finding.reopen_recommendation !== "boolean") {
        problems.push(reason("blocking_findings_invalid", `${ev._path}: blocking finding ${repr(finding.finding_id)} requires boolean reopen_recommendation`));
      }
    }
    const dispositionCounts = new Map<string, number>();
    for (const finding of Array.isArray(ev.finding_dispositions) ? ev.finding_dispositions : []) {
      if (!isObject(finding) || typeof finding.finding_id !== "string" || !finding.finding_id || typeof finding.recommendation !== "string" || !finding.recommendation || typeof finding.rationale !== "string" || !finding.rationale) {
        problems.push(reason("finding_disposition_invalid", `${ev._path}: finding_dispositions entries require finding_id, recommendation, and rationale`));
        continue;
      }
      dispositionCounts.set(finding.finding_id, (dispositionCounts.get(finding.finding_id) ?? 0) + 1);
    }
    const missingDispositions = [...blockingIds].filter((id) => !dispositionCounts.has(id)).sort();
    if (missingDispositions.length > 0) {
      problems.push(reason("finding_disposition_invalid", `${ev._path}: finding_dispositions must cover each blocking finding exactly once: ${renderList(missingDispositions)}`, missingDispositions));
    }
    const duplicatedDispositions = [...dispositionCounts.entries()].filter(([, count]) => count > 1).map(([id]) => id).sort();
    if (duplicatedDispositions.length > 0) {
      problems.push(reason("finding_disposition_invalid", `${ev._path}: finding_dispositions duplicate finding_id: ${renderList(duplicatedDispositions)}`, duplicatedDispositions));
    }
  }
  if (ev.kind === "main_adjudication") {
    if (ev.execution_mode !== "direct") problems.push(reason("main_adjudication_invalid", `${ev._path}: main_adjudication must set execution_mode="direct"`));
    if (ev.created_by !== "main-thread") problems.push(reason("main_adjudication_invalid", `${ev._path}: main_adjudication must set created_by="main-thread"`));
    for (const forbiddenField of ["agent_role", "agent_id", "prompt_ref"]) {
      if (ev[forbiddenField] !== undefined) problems.push(reason("main_adjudication_invalid", `${ev._path}: main_adjudication must not set ${forbiddenField}`));
    }
    for (const field of MAIN_ADJUDICATION_REQUIRED_FIELDS) {
      if (!(field in ev)) problems.push(reason("evidence_missing_field", `${ev._path}: main_adjudication missing ${field}`));
    }
    problems.push(...output_ref_reasons(ev, changeRoot));
    problems.push(...string_list_reasons(ev, "source_evidence_refs"));
    problems.push(...string_list_reasons(ev, "verification_evidence_refs", { allowEmpty: true }));
    if ("adjudicated_claim_ids" in ev) problems.push(...string_list_reasons(ev, "adjudicated_claim_ids", { allowEmpty: true }));
    if ("blocking_source_evidence_refs" in ev) problems.push(...string_list_reasons(ev, "blocking_source_evidence_refs", { allowEmpty: true }));
    if ("reopen_task_ids" in ev) problems.push(...string_list_reasons(ev, "reopen_task_ids", { allowEmpty: true }));
    if (!Array.isArray(ev.loaded_refs)) problems.push(reason("evidence_missing_field", `${ev._path}: loaded_refs must be a list`));
    else problems.push(...loaded_ref_reasons(ev, repoRoot));
    problems.push(...object_list_reasons(ev, "claim_adjudications", { allowEmpty: true }));
    problems.push(...object_list_reasons(ev, "finding_adjudications", { allowEmpty: true }));
    if (!("review_decision" in ev)) problems.push(reason("evidence_missing_field", `${ev._path}: main_adjudication missing review_decision`));
    for (const claim of Array.isArray(ev.claim_adjudications) ? ev.claim_adjudications : []) {
      if (!isObject(claim) || typeof claim.claim_id !== "string" || !claim.claim_id || typeof claim.rationale !== "string" || !claim.rationale) {
        problems.push(reason("claim_adjudication_invalid", `${ev._path}: claim_adjudications entries require claim_id and rationale`));
        continue;
      }
      if (!CLAIM_ADJUDICATION_DECISIONS.includes(String(claim.decision) as (typeof CLAIM_ADJUDICATION_DECISIONS)[number])) {
        problems.push(reason("claim_adjudication_invalid", `${ev._path}: claim_adjudications decision must be one of ${renderList([...CLAIM_ADJUDICATION_DECISIONS])}`));
      }
    }
    for (const finding of Array.isArray(ev.finding_adjudications) ? ev.finding_adjudications : []) {
      if (!isObject(finding) || typeof finding.finding_id !== "string" || !finding.finding_id || typeof finding.rationale !== "string" || !finding.rationale) {
        problems.push(reason("finding_adjudication_invalid", `${ev._path}: finding_adjudications entries require finding_id and rationale`));
        continue;
      }
      if (!FINDING_ADJUDICATION_DECISIONS.includes(String(finding.decision) as (typeof FINDING_ADJUDICATION_DECISIONS)[number])) {
        problems.push(reason("finding_adjudication_invalid", `${ev._path}: finding_adjudications decision must be one of ${renderList([...FINDING_ADJUDICATION_DECISIONS])}`));
      }
    }
    if (ev.review_decision !== undefined && !MAIN_ADJUDICATION_DECISIONS.includes(String(ev.review_decision) as (typeof MAIN_ADJUDICATION_DECISIONS)[number])) {
      problems.push(reason("main_adjudication_invalid", `${ev._path}: review_decision must be one of ${renderList([...MAIN_ADJUDICATION_DECISIONS])}`));
    }
    if (ev.request_changes_route !== undefined && !REQUEST_CHANGES_ROUTES.includes(String(ev.request_changes_route) as (typeof REQUEST_CHANGES_ROUTES)[number])) {
      problems.push(reason("main_adjudication_invalid", `${ev._path}: request_changes_route must be one of ${renderList([...REQUEST_CHANGES_ROUTES])}`));
    }
    const verificationRefs = Array.isArray(ev.verification_evidence_refs) ? ev.verification_evidence_refs.map((item: unknown) => String(item)) : [];
    const blockingSourceRefs = Array.isArray(ev.blocking_source_evidence_refs) ? ev.blocking_source_evidence_refs.map((item: unknown) => String(item)) : [];
    const reopenTaskIds = Array.isArray(ev.reopen_task_ids) ? ev.reopen_task_ids.map((item: unknown) => String(item)) : [];
    if (ev.review_decision === "allow") {
      if (!Array.isArray(ev.verification_evidence_refs) || verificationRefs.length === 0) {
        problems.push(reason("main_adjudication_invalid", `${ev._path}: allow review_decision requires non-empty verification_evidence_refs`));
      }
      if (ev.request_changes_route !== undefined) {
        problems.push(reason("main_adjudication_invalid", `${ev._path}: request_changes_route is only allowed when review_decision='request_changes'`));
      }
      if (reopenTaskIds.length > 0) {
        problems.push(reason("main_adjudication_invalid", `${ev._path}: reopen_task_ids are only allowed when review_decision='request_changes'`));
      }
      if (blockingSourceRefs.length > 0) {
        problems.push(reason("main_adjudication_invalid", `${ev._path}: blocking_source_evidence_refs are only allowed when review_decision='request_changes'`));
      }
    } else if (ev.review_decision === "request_changes") {
      const route = String(ev.request_changes_route ?? "");
      if (verificationRefs.length > 0) {
        problems.push(reason("main_adjudication_invalid", `${ev._path}: request_changes review_decision must keep verification_evidence_refs empty`));
      }
      if (blockingSourceRefs.length === 0) {
        problems.push(reason("main_adjudication_invalid", `${ev._path}: request_changes review_decision requires non-empty blocking_source_evidence_refs`));
      }
      if (!route) {
        problems.push(reason("main_adjudication_invalid", `${ev._path}: request_changes review_decision requires request_changes_route`));
      } else if (route === "reopen_tasks") {
        if (reopenTaskIds.length === 0) {
          problems.push(reason("main_adjudication_invalid", `${ev._path}: request_changes_route='reopen_tasks' requires non-empty reopen_task_ids`));
        }
      } else if (route === "change_update") {
        if (reopenTaskIds.length > 0) {
          problems.push(reason("main_adjudication_invalid", `${ev._path}: request_changes_route='change_update' must not set reopen_task_ids`));
        }
      }
    } else {
      if (ev.request_changes_route !== undefined) {
        problems.push(reason("main_adjudication_invalid", `${ev._path}: request_changes_route is only allowed when review_decision='request_changes'`));
      }
      if (reopenTaskIds.length > 0) {
        problems.push(reason("main_adjudication_invalid", `${ev._path}: reopen_task_ids are only allowed when review_decision='request_changes'`));
      }
      if (blockingSourceRefs.length > 0) {
        problems.push(reason("main_adjudication_invalid", `${ev._path}: blocking_source_evidence_refs are only allowed when review_decision='request_changes'`));
      }
    }
    if (Array.isArray(ev.blocking_source_evidence_refs) && Array.isArray(ev.source_evidence_refs)) {
      const allowed = new Set(ev.source_evidence_refs.map((item: unknown) => String(item)));
      const missing = ev.blocking_source_evidence_refs.map((item: unknown) => String(item)).filter((item: string) => !allowed.has(item));
      if (missing.length > 0) {
        problems.push(reason("main_adjudication_invalid", `${ev._path}: blocking_source_evidence_refs must be drawn from source_evidence_refs: ${renderList(missing)}`, missing));
      }
    }
  }
  if (ev.kind === "task_reopen") {
    if (normalize_gate(String(ev.gate ?? "")) !== "task_reopen") {
      problems.push(reason("task_reopen_invalid", `${ev._path}: task_reopen evidence must use gate="task_reopen"`));
    }
    for (const field of TASK_REOPEN_REQUIRED_FIELDS) {
      if (!(field in ev)) problems.push(reason("evidence_missing_field", `${ev._path}: task_reopen missing ${field}`));
    }
    problems.push(...string_list_reasons(ev, "violated_test_ids", { allowEmpty: true }));
    problems.push(...string_list_reasons(ev, "violated_requirement_refs", { allowEmpty: true }));
    problems.push(...string_list_reasons(ev, "invalidated_completion_evidence_ids"));
    problems.push(...string_list_reasons(ev, "required_supersede_evidence_ids"));
    if (!TASK_REOPEN_INVALIDITY_CLASSES.includes(String(ev.completion_invalidity_class) as (typeof TASK_REOPEN_INVALIDITY_CLASSES)[number])) {
      problems.push(reason("task_reopen_invalid", `${ev._path}: unsupported completion_invalidity_class=${repr(ev.completion_invalidity_class)}`));
    }
    if (ev.scope_expansion !== false) {
      problems.push(reason("task_reopen_invalid", `${ev._path}: task_reopen requires scope_expansion=false`));
    }
    if (typeof ev.reopen_id !== "string" || !ev.reopen_id) problems.push(reason("task_reopen_invalid", `${ev._path}: reopen_id must be a non-empty string`));
    for (const field of ["source_adjudication_evidence_id", "source_guidance_evidence_id", "before_tasks_sha256", "after_tasks_sha256", "why_completion_invalid", "required_fix"]) {
      if (typeof ev[field] !== "string" || !ev[field]) problems.push(reason("task_reopen_invalid", `${ev._path}: ${field} must be a non-empty string`));
    }
    if (Array.isArray(ev.invalidated_completion_evidence_ids) && Array.isArray(ev.required_supersede_evidence_ids)) {
      const required = new Set(ev.required_supersede_evidence_ids.map((item: unknown) => String(item)));
      const missing = ev.invalidated_completion_evidence_ids.map((item: unknown) => String(item)).filter((item: string) => !required.has(item));
      if (missing.length > 0) {
        problems.push(reason("task_reopen_invalid", `${ev._path}: required_supersede_evidence_ids must include invalidated_completion_evidence_ids: ${renderList(missing)}`, missing));
      }
    }
    if (Array.isArray(ev.required_supersede_evidence_ids)) {
      const sourceIds = new Set([String(ev.source_adjudication_evidence_id ?? ""), String(ev.source_guidance_evidence_id ?? "")]);
      const conflicts = ev.required_supersede_evidence_ids.map((item: unknown) => String(item)).filter((item: string) => sourceIds.has(item));
      if (conflicts.length > 0) {
        problems.push(reason("task_reopen_invalid", `${ev._path}: source evidence ids must not appear in required_supersede_evidence_ids: ${renderList(conflicts)}`, conflicts));
      }
    }
  }
  if (ev.kind === "task_reopen_resolved") {
    if (normalize_gate(String(ev.gate ?? "")) !== "task_reopen") {
      problems.push(reason("task_reopen_resolved_invalid", `${ev._path}: task_reopen_resolved evidence must use gate="task_reopen"`));
    }
    for (const field of TASK_REOPEN_RESOLVED_REQUIRED_FIELDS) {
      if (!(field in ev)) problems.push(reason("evidence_missing_field", `${ev._path}: task_reopen_resolved missing ${field}`));
    }
    if (typeof ev.reopen_evidence_id !== "string" || !ev.reopen_evidence_id) problems.push(reason("task_reopen_resolved_invalid", `${ev._path}: reopen_evidence_id must be a non-empty string`));
    if (typeof ev.reopen_id !== "string" || !ev.reopen_id) problems.push(reason("task_reopen_resolved_invalid", `${ev._path}: reopen_id must be a non-empty string`));
    if (typeof ev.after_tasks_sha256 !== "string" || !ev.after_tasks_sha256) problems.push(reason("task_reopen_resolved_invalid", `${ev._path}: after_tasks_sha256 must be a non-empty string`));
    problems.push(...string_list_reasons(ev, "successor_completion_evidence_ids"));
  }
  if (ev.workflow) {
    if (ev.workflow !== "code-review") problems.push(reason("workflow_evidence_invalid", `${ev._path}: unsupported workflow ${repr(ev.workflow)}`));
    if (ev.execution_mode !== "workflow") problems.push(reason("workflow_evidence_invalid", `${ev._path}: workflow evidence requires execution_mode=workflow`));
    problems.push(...output_ref_reasons(ev, changeRoot));
    const laneEvidenceRefs = ev.lane_evidence_refs;
    if (!laneEvidenceRefs || typeof laneEvidenceRefs !== "object" || Array.isArray(laneEvidenceRefs)) {
      problems.push(reason("code_review_workflow_incomplete", `${ev._path}: code-review workflow evidence requires lane_evidence_refs`));
    } else {
      for (const lane of ["code-reviewer", "architect"]) {
        const refItem = laneEvidenceRefs[lane];
        if (typeof refItem !== "string" || !refItem) problems.push(reason("code_review_workflow_incomplete", `${ev._path}: code-review workflow missing ${lane} lane evidence_id`));
      }
    }
  }
  if (ev.kind === "verification_review") {
    if (!FINAL_VERIFICATION_ROLES.includes(String(ev.agent_role) as (typeof FINAL_VERIFICATION_ROLES)[number])) {
      problems.push(reason("verification_role_invalid", `${ev._path}: verification_review requires agent_role in ${renderList([...FINAL_VERIFICATION_ROLES])}`));
    }
    for (const field of VERIFY_EVIDENCE_REQUIRED_FIELDS) {
      if (!(field in ev)) problems.push(reason("verification_evidence_incomplete", `${ev._path}: missing ${field}`));
    }
    problems.push(...verify_reference_reasons(changeRoot, ev, []));
  }
  if (ev.kind === "final_test") {
    for (const field of FINAL_TEST_REQUIRED_FIELDS) {
      if (!(field in ev)) problems.push(reason("verification_evidence_incomplete", `${ev._path}: final_test missing ${field}`));
    }
    problems.push(...output_ref_reasons(ev, changeRoot));
  }
  if (ev.requires_raw_artifact_refs === true) {
    if (!("raw_artifact_refs" in ev)) problems.push(reason("raw_artifact_refs_required", `${ev._path}: raw_artifact_refs required when requires_raw_artifact_refs=true`));
    else problems.push(...file_ref_reasons(repoRoot, ev, "raw_artifact_refs", "raw_artifact_refs_required"));
  } else if (ev.raw_artifact_refs !== undefined) {
    problems.push(...file_ref_reasons(repoRoot, ev, "raw_artifact_refs", "raw_artifact_ref_invalid"));
  }
  // FIX-10: test_run owns raw_log_refs with change-root semantics (audit H-4 flagged the
  // repo-root prefix as C-7 convention mixing); the legacy repo-root check stays for other kinds.
  if (ev.kind !== "test_run" && ev.raw_log_refs !== undefined) {
    problems.push(...file_ref_reasons(repoRoot, ev, "raw_log_refs", "raw_log_ref_invalid"));
  }
  return problems;
}

export function code_review_lane_evidence_reasons(ev: JsonMap, evidences: JsonMap[]): Reason[] {
  const problems: Reason[] = [];
  const refs = ev.lane_evidence_refs;
  if (!refs || typeof refs !== "object" || Array.isArray(refs)) {
    return [reason("code_review_workflow_incomplete", `${ev._path}: code-review workflow evidence requires lane_evidence_refs`)];
  }
  const liveById = new Map(live_pass(evidences, { gate: "review_complete" }).map((item) => [String(item.evidence_id), item]));
  for (const lane of ["code-reviewer", "architect"]) {
    const evidenceId = refs[lane];
    if (typeof evidenceId !== "string" || !evidenceId) {
      problems.push(reason("code_review_workflow_incomplete", `${ev._path}: code-review workflow missing ${lane} lane evidence_id`));
      continue;
    }
    const laneEvidence = liveById.get(evidenceId);
    if (!laneEvidence) {
      problems.push(reason("code_review_lane_evidence_missing", `${ev._path}: ${lane} lane_evidence_refs entry is not live/pass: ${evidenceId}`, [evidenceId]));
      continue;
    }
    if (laneEvidence.agent_role !== lane) {
      problems.push(reason("code_review_lane_role_mismatch", `${ev._path}: ${lane} lane_evidence_refs points to agent_role=${repr(laneEvidence.agent_role)}`, [evidenceId]));
    }
    if (laneEvidence.execution_mode !== "native_subagent") {
      problems.push(reason("missing_native_subagent_evidence", `${ev._path}: ${lane} lane evidence requires execution_mode=native_subagent`, [evidenceId]));
    }
  }
  return problems;
}

// FIX-6 (audit C-2) deliberate supersede exemption: task_reopen records are historical
// blockers, so they intentionally use find_pass instead of live_pass. If supersede could
// remove a task_reopen from the live set, one superseded evidence would erase the reopen
// obligation without a matching task_reopen_resolved record, contradicting the disclosure
// fixed-point rule that historical blockers must stay visible until explicitly resolved.
export function pass_task_reopens(evidences: JsonMap[], taskId: string | null = null): JsonMap[] {
  return find_pass(evidences, { gate: "task_reopen", kind: "task_reopen", task_id: taskId });
}

export function live_task_reopens(evidences: JsonMap[], taskId: string | null = null): JsonMap[] {
  return live_pass(evidences, { gate: "task_reopen", kind: "task_reopen", task_id: taskId });
}

export function live_task_reopen_resolutions(evidences: JsonMap[], taskId: string | null = null): JsonMap[] {
  return live_pass(evidences, { gate: "task_reopen", kind: "task_reopen_resolved", task_id: taskId });
}

function task_reopen_resolution_matches(resolution: JsonMap, reopen: JsonMap): boolean {
  return (
    String(resolution.reopen_evidence_id ?? "") === String(reopen.evidence_id ?? "")
    && String(resolution.reopen_id ?? "") === String(reopen.reopen_id ?? "")
    && String(resolution.task_id ?? "") === String(reopen.task_id ?? "")
  );
}

export function unresolved_live_task_reopens(evidences: JsonMap[], taskId: string | null = null): JsonMap[] {
  const resolutions = live_task_reopen_resolutions(evidences);
  return pass_task_reopens(evidences, taskId)
    .filter((reopen) => !resolutions.some((resolution) => task_reopen_resolution_matches(resolution, reopen)));
}

export function find_pass(evidences: JsonMap[], filters: { gate?: string | null; kind?: string | null; task_id?: string | null } = {}): JsonMap[] {
  const expectedGate = filters.gate !== undefined && filters.gate !== null ? normalize_gate(filters.gate) : null;
  return evidences.filter((ev) => {
    if (ev._invalid || ev.status !== "pass") return false;
    if (expectedGate !== null && normalize_gate(String(ev.gate ?? "")) !== expectedGate) return false;
    if (filters.kind !== undefined && filters.kind !== null && ev.kind !== filters.kind) return false;
    if (filters.task_id !== undefined && filters.task_id !== null && ev.task_id !== filters.task_id) return false;
    return true;
  });
}

export function superseded_ids(evidences: JsonMap[]): Set<string> {
  return effective_superseded_ids(evidences);
}

// FIX-6 (audit C-2): supersede is a rollback mechanism, so it needs an authorization model.
// A supersede evidence must point at an existing evidence_id, and a cross-gate supersede
// must carry a non-empty supersede_reason explaining why it reaches outside its own gate.
// FIX-9 (audit C-4): duplicate evidence ids make refs/supersede/Map-keyed lookups silently
// resolve to one arbitrary winner (last writer). Fail loudly instead of guessing.
export function duplicate_evidence_id_reasons(evidences: JsonMap[]): Reason[] {
  const byId = new Map<string, string[]>();
  for (const ev of evidences) {
    if (ev._invalid) continue;
    if (typeof ev.evidence_id !== "string" || !ev.evidence_id) continue;
    const bucket = byId.get(ev.evidence_id) ?? [];
    bucket.push(String(ev._path ?? "unknown"));
    byId.set(ev.evidence_id, bucket);
  }
  return [...byId.entries()]
    .filter(([, paths]) => paths.length > 1)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([id, paths]) => reason("evidence_id_duplicate", `evidence_id ${repr(id)} is used by ${paths.length} evidence files: ${renderList([...paths].sort())}`, [...paths].sort()));
}

// FIX-12 (audit D-3): cross-evidence reference integrity is a guard-wide capability, not a
// review_complete special case. Any `*_evidence_refs` field (string list, or lane map like
// lane_evidence_refs) naming an evidence_id that exists nowhere in the evidence set blocks
// dangling_evidence_ref — deleting an evidence file now trips a hard block instead of one
// transient state_fingerprint_stale. `supersedes` is covered by supersede_target_missing (FIX-6).
export function dangling_evidence_ref_reasons(evidences: JsonMap[]): Reason[] {
  const known = new Set<string>();
  for (const ev of evidences) {
    if (typeof ev.evidence_id === "string" && ev.evidence_id) known.add(ev.evidence_id);
  }
  const problems: Reason[] = [];
  for (const ev of evidences) {
    if (ev._invalid) continue;
    for (const [field, value] of Object.entries(ev).sort(([a], [b]) => a.localeCompare(b))) {
      if (!field.endsWith("_evidence_refs")) continue;
      let ids: string[];
      if (Array.isArray(value)) {
        ids = value.filter((item): item is string => typeof item === "string" && item.length > 0);
      } else if (isObject(value)) {
        ids = Object.values(value).filter((item): item is string => typeof item === "string" && item.length > 0);
      } else {
        continue;
      }
      const missing = [...new Set(ids)].filter((id) => !known.has(id)).sort();
      if (missing.length > 0) {
        problems.push(reason("dangling_evidence_ref", `${ev._path}: ${field} references unknown evidence_id: ${renderList(missing)}`, missing));
      }
    }
  }
  return problems;
}

export function supersede_reasons(evidences: JsonMap[]): Reason[] {
  const problems: Reason[] = [];
  const byId = new Map<string, JsonMap>();
  for (const ev of evidences) {
    if (ev._invalid) continue;
    const id = typeof ev.evidence_id === "string" ? ev.evidence_id : "";
    if (id && !byId.has(id)) byId.set(id, ev);
  }
  for (const ev of evidences) {
    if (ev._invalid || ev.status !== "superseded" || ev.supersedes === undefined) continue;
    const targetId = typeof ev.supersedes === "string" ? ev.supersedes : "";
    const target = targetId ? byId.get(targetId) : undefined;
    if (!target) {
      problems.push(reason(
        "supersede_target_missing",
        `${ev._path}: supersedes points at unknown evidence_id: ${repr(ev.supersedes)}`,
        targetId ? [targetId] : [],
      ));
      continue;
    }
    const sameGate = normalize_gate(String(ev.gate ?? "")) === normalize_gate(String(target.gate ?? ""));
    const supersedeReason = typeof ev.supersede_reason === "string" ? ev.supersede_reason.trim() : "";
    if (!sameGate && !supersedeReason) {
      problems.push(reason(
        "supersede_unauthorized",
        `${ev._path}: cross-gate supersede of ${targetId} (gate=${repr(target.gate)}) requires a non-empty supersede_reason`,
        [targetId],
      ));
    }
  }
  return problems;
}

export function live_pass(evidences: JsonMap[], filters: { gate?: string | null; kind?: string | null; task_id?: string | null } = {}): JsonMap[] {
  const dead = superseded_ids(evidences);
  return find_pass(evidences, filters).filter((ev) => !dead.has(ev.evidence_id));
}

export function live_user_confirmations(evidences: JsonMap[], gate: string): JsonMap[] {
  return live_pass(evidences, { gate, kind: "human_confirmation" })
    .filter((ev) => String(ev.created_by ?? "") === "user");
}
