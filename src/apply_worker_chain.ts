import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, relative } from "node:path";
import type { JsonMap, Reason } from "./util.ts";
import {
  deepEqual,
  fingerprint_obj,
  GuardError,
  REQUIRED_SUPERSPEC_AGENT_ROLES,
  REQUIRED_SUPERSPEC_WORKFLOW_SKILLS,
  NO_TDD_REASONS,
  isObject,
  reason,
  renderList,
  runtime,
  safe_within,
  sha256_text,
} from "./util.ts";
import { dirty_worktree_paths, file_blob_sha } from "./git.ts";
import { effective_superseded_ids } from "./openspec.ts";

export type ArtifactRefExpected = {
  kind?: string;
  role?: string;
  taskId?: string;
  chainId?: string | null;
};

export type ApplyWorkerArtifactMaterializeInput = {
  taskId: string;
  kind: "worker_report" | "raw_transcript" | "diff_transcript" | "status_report";
  role: "test-runner" | "executor" | "code-reviewer" | "verifier";
  content: string | Buffer | JsonMap;
  path?: string;
  refPath?: string;
  filename?: string;
  workerChainContext?: "none" | "executor_worker";
  applyWorkerChainId?: string;
  originPacketFingerprint?: string;
  sourceImplementationFingerprint?: unknown;
  producedImplementationFingerprint?: unknown;
  observedImplementationFingerprint?: unknown;
  inputRefDigest?: string;
  command?: string;
  cwd?: string;
  phase?: string;
  testId?: string;
  exitCode?: number;
  maxBytes?: number;
  metadata?: JsonMap;
};

const APPLY_WORKER_ARTIFACT_KINDS = new Set(["worker_report", "raw_transcript", "diff_transcript", "status_report"]);
const APPLY_WORKER_ARTIFACT_ROLES = new Set(["test-runner", "executor", "code-reviewer", "verifier"]);
const DEFAULT_APPLY_WORKER_ARTIFACT_MAX_BYTES = 1024 * 1024;
export const APPLY_WORKER_MAX_INLINE_REPORT_CHARS = 12000;

export const APPLY_TEST_RUNNER_REPORT_REQUIRED_FIELDS = [
  "role",
  "command",
  "command_source",
  "cwd",
  "phase",
  "task_id",
  "test_id",
  "exit_code",
  "semantic_status_candidate",
  "result_summary",
  "runtime_raw_transcript_ref",
  "repo_head",
  "pre_dirty_state",
  "post_dirty_state",
  "changed_files",
  "untracked_files",
  "invariant_refs",
  "source_refs",
  "origin_packet_fingerprint",
  "input_ref_digest",
  "source_implementation_fingerprint",
  "observed_implementation_fingerprint",
  "guard_fingerprint",
  "unverified_items",
] as const;

export const APPLY_EXECUTOR_REPORT_REQUIRED_FIELDS = [
  "role",
  "task_id",
  "apply_worker_chain_id",
  "cwd",
  "repo_head",
  "guard_fingerprint",
  "changed_files",
  "suggested_green_checks",
  "test_invariant_mapping",
  "runtime_artifact_refs",
  "origin_packet_fingerprint",
  "input_ref_digest",
  "source_implementation_fingerprint",
  "produced_implementation_fingerprint",
  "unverified_items",
  "risk_notes",
] as const;

export const APPLY_CODE_REVIEW_REPORT_REQUIRED_FIELDS = [
  "role",
  "review_status_candidate",
  "cwd",
  "repo_head",
  "guard_fingerprint",
  "executor_report_ref",
  "actual_changed_files",
  "changed_files",
  "untracked_files",
  "implementation_dirty_file_list",
  "implementation_fingerprint",
  "guard_artifact_manifest_fingerprint",
  "scope_verdict",
  "protected_path_verdict",
  "executor_report_mismatch",
  "test_invariant_mapping_verdict",
  "suggested_green_test_ids",
  "risk_notes",
  "runtime_raw_git_status_transcript_ref",
  "runtime_raw_git_diff_name_status_transcript_ref",
  "runtime_path_scoped_diff_transcript_refs",
  "origin_packet_fingerprint",
  "input_ref_digest",
  "source_implementation_fingerprint",
  "observed_implementation_fingerprint",
  "unverified_items",
] as const;

export const APPLY_VERIFIER_REPORT_REQUIRED_FIELDS = [
  "role",
  "completion_proof_kind",
  "pre_edit_proof_kind",
  "verification_status_candidate",
  "task_completion_verdict",
  "chain_consistency_verdict",
  "acceptance_coverage_verdict",
  "invariant_coverage_verdict",
  "test_coverage_verdict",
  "cwd",
  "repo_head",
  "guard_fingerprint",
  "expected_freshness_fingerprint",
  "observed_freshness_fingerprint",
  "freshness_verdict",
  "executor_report_ref",
  "task_code_review_report_ref",
  "actual_changed_files",
  "changed_files",
  "untracked_files",
  "implementation_dirty_file_list",
  "implementation_fingerprint",
  "guard_artifact_manifest_fingerprint",
  "unexpected_guard_owned_dirty_paths",
  "scope_verdict",
  "protected_path_verdict",
  "executor_code_review_mismatch",
  "test_evidence_mismatch",
  "runtime_raw_git_status_transcript_ref",
  "runtime_raw_git_diff_name_status_transcript_ref",
  "runtime_path_scoped_diff_transcript_refs",
  "diff_summary_refs",
  "origin_packet_fingerprint",
  "input_ref_digest",
  "source_implementation_fingerprint",
  "observed_implementation_fingerprint",
  "risk_notes",
  "triggered_stop_conditions",
  "unverified_items",
] as const;

function repo_rel(repoRoot: string, absPath: string): string | null {
  const rel = relative(repoRoot, absPath);
  if (!rel || rel.startsWith("..") || isAbsolute(rel)) return null;
  return rel.split("\\").join("/");
}

function repo_head(repoRoot: string): string {
  try {
    const line = runtime.git_lines(repoRoot, "rev-parse", "HEAD")[0];
    return line || "unknown";
  } catch {
    return "unknown";
  }
}

function guard_state_path(pathValue: string): boolean {
  return pathValue.endsWith(".superspec/superspec-state.json")
    || pathValue.endsWith(".superspec/superspec-state.lock")
    || pathValue.endsWith(".superspec/ledger.jsonl")
    || pathValue.includes(".superspec/evidence/")
    || pathValue.includes(".superspec/state/");
}

function protected_change_path(changePath: string): boolean {
  const pathValue = changePath.split("\\").join("/");
  return pathValue === "proposal.md"
    || pathValue === "design.md"
    || pathValue === "tasks.md"
    || pathValue.startsWith("specs/")
    || pathValue === ".superspec"
    || pathValue.startsWith(".superspec/");
}

function repo_path_snapshot(repoRoot: string, relPath: string): JsonMap {
  const absPath = safe_within(repoRoot, relPath);
  if (absPath === null || !existsSync(absPath)) return { path: relPath, status: "deleted", blob_sha: "deleted" };
  if (!statSync(absPath).isFile()) return { path: relPath, status: "non_file", blob_sha: "non_file" };
  return { path: relPath, status: "present", blob_sha: runtime.file_blob_sha(absPath) };
}

function snapshot_digest(items: unknown): string {
  return fingerprint_obj(items);
}

function implementation_transcript_digest(kind: string, items: JsonMap[]): string {
  return sha256_text(`${kind}\n${items.map((item) => `${String(item.status ?? "")}\t${String(item.path ?? "")}\t${String(item.blob_sha ?? "")}`).join("\n")}\n`);
}

function ref_repo_paths(repoRoot: string, changeRoot: string, refs: unknown[]): Set<string> {
  const paths = new Set<string>();
  for (const refItem of refs) {
    if (!isObject(refItem) || typeof refItem.path !== "string") continue;
    const target = safe_within(changeRoot, refItem.path);
    if (target === null) continue;
    const rel = repo_rel(repoRoot, target);
    if (rel) paths.add(rel);
  }
  return paths;
}

function managed_codex_surface_paths(repoRoot: string): string[] {
  const candidates = [
    ...REQUIRED_SUPERSPEC_WORKFLOW_SKILLS.map((name) => `.codex/skills/${name}/SKILL.md`),
    ...REQUIRED_SUPERSPEC_AGENT_ROLES.map((name) => `.codex/prompts/${name}.md`),
    ...REQUIRED_SUPERSPEC_AGENT_ROLES.map((name) => `.codex/agents/${name}.toml`),
    ".codex/config.toml",
    ".codex/superspec/install-manifest.json",
  ];
  return candidates.filter((pathValue) => {
    const absPath = safe_within(repoRoot, pathValue);
    return absPath !== null && existsSync(absPath);
  });
}

export function apply_worker_implementation_fingerprint(
  repoRoot: string,
  changeRoot: string,
  expectedGuardRefs: unknown[] = [],
  opts: { declaredTaskWriteScope?: string[]; protectedPathRefs?: unknown[] } = {},
): JsonMap {
  const changeRel = repo_rel(repoRoot, changeRoot) ?? "";
  const expectedGuardPaths = ref_repo_paths(repoRoot, changeRoot, expectedGuardRefs);
  const dirtyPaths = typeof runtime.dirty_worktree_paths === "function"
    ? runtime.dirty_worktree_paths(repoRoot) as string[]
    : dirty_worktree_paths(repoRoot);
  const unexpectedGuardOwnedDirtyPaths: string[] = [];
  const protectedDirtyPaths: string[] = [];
  const dirtyFiles = [...new Set(dirtyPaths)].sort().flatMap((relPath) => {
    const pathValue = relPath.split("\\").join("/");
    if (expectedGuardPaths.has(pathValue) || guard_state_path(pathValue)) return [];
    if (changeRel && pathValue.startsWith(`${changeRel}/`)) {
      const changePath = pathValue.slice(changeRel.length + 1);
      if (protected_change_path(changePath)) protectedDirtyPaths.push(pathValue);
      if (
        pathValue.startsWith(`${changeRel}/.superspec/reports/apply/`)
        || pathValue.startsWith(`${changeRel}/.superspec/raw/apply/`)
      ) {
        unexpectedGuardOwnedDirtyPaths.push(pathValue);
      }
      return [];
    }
    return [repo_path_snapshot(repoRoot, pathValue)];
  });
  const protectedDirtyFiles = [...new Set(protectedDirtyPaths)].sort().map((pathValue) => repo_path_snapshot(repoRoot, pathValue));
  const protectedPathRefs = Array.isArray(opts.protectedPathRefs) && opts.protectedPathRefs.length > 0
    ? opts.protectedPathRefs.filter(isObject)
    : protectedDirtyFiles;
  const codexManagedFiles = managed_codex_surface_paths(repoRoot).map((pathValue) => repo_path_snapshot(repoRoot, pathValue));
  const implementationDirtyFileList = dirtyFiles.map((item) => String(item.path ?? "")).filter(Boolean).sort();
  const declaredTaskWriteScope = Array.isArray(opts.declaredTaskWriteScope) ? opts.declaredTaskWriteScope.map(String).filter(Boolean).sort() : [];
  const scopedNameStatusTranscriptDigest = implementation_transcript_digest("git diff --name-status --", dirtyFiles);
  const scopedDiffTranscriptDigest = implementation_transcript_digest("git diff --binary --", dirtyFiles);
  const stable = {
    repo_head: repo_head(repoRoot),
    declared_task_write_scope: declaredTaskWriteScope,
    protected_path_refs: protectedPathRefs,
    implementation_dirty_file_list: implementationDirtyFileList,
    scoped_name_status_transcript_digest: scopedNameStatusTranscriptDigest,
    scoped_diff_transcript_digest: scopedDiffTranscriptDigest,
    dirty_files: dirtyFiles,
    codex_managed_files: codexManagedFiles,
    protected_dirty_files: protectedDirtyFiles,
  };
  return {
    ...stable,
    dirty_paths: dirtyFiles.map((item) => item.path),
    dirty_files_digest: snapshot_digest(dirtyFiles),
    codex_managed_paths: codexManagedFiles.map((item) => item.path),
    unexpected_guard_owned_dirty_paths: unexpectedGuardOwnedDirtyPaths.sort(),
    protected_dirty_paths: protectedDirtyFiles.map((item) => item.path),
    protected_path_refs: protectedPathRefs,
    fingerprint_digest: fingerprint_obj(stable),
    helper_version: "apply-worker-fingerprint-v1",
    computed_at: new Date().toISOString(),
  };
}

export function apply_worker_protected_path_refs(repoRoot: string, changeRoot: string, expectedGuardRefs: unknown[] = []): JsonMap[] {
  const fingerprint = apply_worker_implementation_fingerprint(repoRoot, changeRoot, expectedGuardRefs);
  return Array.isArray(fingerprint.protected_path_refs) ? fingerprint.protected_path_refs.filter(isObject) : [];
}

function pinned_summary(refItem: unknown): JsonMap | null {
  if (!isObject(refItem)) return null;
  const result: JsonMap = {};
  for (const key of [
    "root",
    "path",
    "blob_sha",
    "size_bytes",
    "kind",
    "role",
    "task_id",
    "worker_chain_context",
    "apply_worker_chain_id",
    "evidence_id",
    "phase",
    "semantic_status",
    "guard_fingerprint",
    "origin_packet_fingerprint",
    "input_ref_digest",
  ]) {
    if (refItem[key] !== undefined) result[key] = refItem[key];
  }
  return result;
}

export function worker_input_ref_digest(refs: unknown[]): string {
  const stable = refs.map((refItem) => {
    if (typeof refItem === "string") return { evidence_id: refItem };
    return pinned_summary(refItem) ?? refItem;
  });
  return fingerprint_obj(stable);
}

function evidence_summary(ev: JsonMap | undefined): JsonMap | null {
  if (!ev) return null;
  const result: JsonMap = {};
  for (const key of ["evidence_id", "kind", "gate", "task_id", "test_id", "phase", "semantic_status", "command", "cwd", "exit_code", "runner_origin", "apply_execution_chain", "apply_worker_chain_id"]) {
    if (ev[key] !== undefined) result[key] = ev[key];
  }
  if (isObject(ev.implementation_fingerprint)) result.implementation_fingerprint = { fingerprint_digest: fingerprint_digest(ev.implementation_fingerprint) };
  if (Array.isArray(ev.raw_log_refs)) result.raw_log_refs = [...ev.raw_log_refs].sort();
  if (Array.isArray(ev.raw_log_pinned_refs)) result.raw_log_pinned_refs = ev.raw_log_pinned_refs.map(pinned_summary).filter(Boolean);
  return result;
}

function evidence_file_ref(changeRoot: string, ev: JsonMap | undefined): JsonMap | null {
  if (!ev || typeof ev._path !== "string" || !ev._path) return null;
  const target = safe_within(changeRoot, ev._path);
  if (target === null || !existsSync(target) || !statSync(target).isFile()) return null;
  return {
    kind: "evidence",
    evidence_id: ev.evidence_id,
    gate: ev.gate,
    evidence_kind: ev.kind,
    path: ev._path,
    blob_sha: runtime.file_blob_sha(target),
  };
}

export function apply_worker_executor_input_ref_digest(evidences: JsonMap[], active: JsonMap): string {
  const preIds = Array.isArray(active.pre_edit_evidence_refs) ? active.pre_edit_evidence_refs.map(String).filter(Boolean).sort() : [];
  const activeInput: JsonMap = {
    kind: "apply_worker_chain",
    evidence_id: active.evidence_id,
    task_id: active.task_id,
    apply_worker_chain_id: active.apply_worker_chain_id,
    executor_packet_fingerprint: active.executor_packet_fingerprint,
    source_implementation_fingerprint: active.source_implementation_fingerprint,
    declared_task_write_scope: active.declared_task_write_scope,
    pre_edit_evidence_refs: preIds,
  };
  for (const field of ["pre_edit_proof_kind", "apply_execution_surface", "tdd_required", "no_tdd_reason"]) {
    if (active[field] !== undefined) activeInput[field] = active[field];
  }
  return worker_input_ref_digest([
    activeInput,
    ...preIds.map((id) => evidence_summary(evidences.find((ev) => String(ev.evidence_id ?? "") === id))).filter(Boolean),
  ]);
}

export function apply_worker_guard_artifact_manifest_fingerprint(items: JsonMap): JsonMap {
  const stable = {
    completion_proof_kind: items.completion_proof_kind ?? "green_tests",
    pre_edit_proof_kind: items.pre_edit_proof_kind ?? "red_or_characterization",
    pre_edit_evidence: Array.isArray(items.pre_edit_evidence) ? items.pre_edit_evidence : [],
    green_test_run: items.green_test_run ?? null,
    green_test_runs: Array.isArray(items.green_test_runs) ? items.green_test_runs : [],
    alternative_verification: items.alternative_verification ?? null,
    alternative_verifications: Array.isArray(items.alternative_verifications) ? items.alternative_verifications : [],
    executor_report_ref: pinned_summary(items.executor_report_ref),
    task_code_review_report_ref: pinned_summary(items.task_code_review_report_ref),
    accepted_test_runner_report_ref: pinned_summary(items.accepted_test_runner_report_ref),
    accepted_test_runner_report_refs: Array.isArray(items.accepted_test_runner_report_refs) ? items.accepted_test_runner_report_refs.map(pinned_summary).filter(Boolean) : [],
    raw_log_pinned_refs: Array.isArray(items.raw_log_pinned_refs) ? items.raw_log_pinned_refs.map(pinned_summary).filter(Boolean) : [],
    evidence_file_refs: Array.isArray(items.evidence_file_refs) ? items.evidence_file_refs.map(pinned_summary).filter(Boolean) : [],
    active_chain: items.active_chain ?? null,
  };
  return {
    ...stable,
    fingerprint_digest: fingerprint_obj(stable),
    helper_version: "apply-worker-guard-artifact-v1",
    computed_at: new Date().toISOString(),
  };
}

export function fingerprint_digest(value: unknown): string {
  if (typeof value === "string") return value;
  if (isObject(value) && typeof value.fingerprint_digest === "string") return value.fingerprint_digest;
  return "";
}

export function fingerprint_matches(actual: unknown, expected: unknown): boolean {
  const actualDigest = fingerprint_digest(actual);
  const expectedDigest = fingerprint_digest(expected);
  if (actualDigest && expectedDigest) return actualDigest === expectedDigest;
  return deepEqual(actual, expected);
}

export function read_pinned_artifact_json(changeRoot: string, refItem: unknown): JsonMap | null {
  if (!isObject(refItem) || typeof refItem.path !== "string") return null;
  const target = safe_within(changeRoot, refItem.path);
  if (target === null || !existsSync(target) || !statSync(target).isFile() || statSync(target).size <= 0) return null;
  try {
    const parsed = JSON.parse(readFileSync(target, "utf8"));
    return isObject(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

function expected_dir(kind: string, taskId: string | undefined): string | null {
  if (!taskId) return null;
  if (kind === "raw_transcript") return `.superspec/raw/apply/${taskId}/`;
  if (kind === "worker_report" || kind === "status_report" || kind === "diff_transcript") return `.superspec/reports/apply/${taskId}/`;
  return null;
}

function ensure_materialized_sha(value: unknown, field: string): void {
  if (typeof value !== "string" || !value.startsWith("sha256:")) {
    throw new GuardError(`apply_worker_artifact_materialize_invalid: ${field} must be a sha256 fingerprint`);
  }
}

function ensure_materialized_fingerprint(value: unknown, field: string): void {
  if (typeof value === "string" && value.startsWith("sha256:")) return;
  if (isObject(value) && typeof value.fingerprint_digest === "string" && value.fingerprint_digest.startsWith("sha256:")) return;
  throw new GuardError(`apply_worker_artifact_materialize_invalid: ${field} must be a sha256 fingerprint`);
}

function materialized_bytes(content: string | Buffer | JsonMap): Buffer {
  if (Buffer.isBuffer(content)) return content;
  if (typeof content === "string") return Buffer.from(content);
  if (isObject(content)) return Buffer.from(`${JSON.stringify(content, null, 2)}\n`);
  throw new GuardError("apply_worker_artifact_materialize_invalid: content must be string, Buffer, or object");
}

function materialized_ref_path(artifactPath: string): string {
  return `${artifactPath.replace(/(\.[^/.]+)?$/u, "")}.ref.json`;
}

function write_materialized_file_atomic(pathValue: string, bytes: Buffer): void {
  mkdirSync(dirname(pathValue), { recursive: true });
  const tmp = `${pathValue}.${Date.now()}.${Math.random().toString(16).slice(2)}.tmp`;
  try {
    writeFileSync(tmp, bytes);
    renameSync(tmp, pathValue);
  } catch (err) {
    rmSync(tmp, { force: true });
    throw err;
  }
}

type MaterializedFileSnapshot = { existed: false } | { existed: true; bytes: Buffer };

function materialized_file_snapshot(pathValue: string): MaterializedFileSnapshot {
  if (!existsSync(pathValue)) return { existed: false };
  const st = statSync(pathValue);
  if (!st.isFile()) return { existed: false };
  return { existed: true, bytes: readFileSync(pathValue) };
}

function restore_materialized_file(pathValue: string, snapshot: MaterializedFileSnapshot): void {
  if (snapshot.existed) {
    write_materialized_file_atomic(pathValue, snapshot.bytes);
    return;
  }
  rmSync(pathValue, { force: true });
}

export function materialize_apply_worker_artifact_ref(changeRoot: string, input: ApplyWorkerArtifactMaterializeInput): JsonMap {
  const taskId = input.taskId;
  const kind = input.kind;
  const role = input.role;
  if (typeof taskId !== "string" || !taskId || taskId.includes("/") || taskId.includes("..")) {
    throw new GuardError("apply_worker_artifact_materialize_invalid: taskId must be a safe task id");
  }
  if (!APPLY_WORKER_ARTIFACT_KINDS.has(kind)) throw new GuardError(`apply_worker_artifact_materialize_invalid: unsupported kind ${kind}`);
  if (!APPLY_WORKER_ARTIFACT_ROLES.has(role)) throw new GuardError(`apply_worker_artifact_materialize_invalid: unsupported role ${role}`);
  const baseDir = expected_dir(kind, taskId);
  if (!baseDir) throw new GuardError(`apply_worker_artifact_materialize_invalid: unsupported kind ${kind}`);
  const filename = input.filename ?? `${role}-${kind}.${kind === "worker_report" || kind === "status_report" ? "json" : "log"}`;
  if (filename.includes("/") || filename.includes("\\") || filename.includes("..") || !filename.trim()) {
    throw new GuardError("apply_worker_artifact_materialize_invalid: filename must be a safe basename");
  }
  const artifactRel = input.path ?? `${baseDir}${filename}`;
  if (!artifactRel.startsWith(baseDir)) throw new GuardError(`apply_worker_artifact_materialize_invalid: path must stay under ${baseDir}`);
  const artifactPath = safe_within(changeRoot, artifactRel);
  if (artifactPath === null) throw new GuardError("apply_worker_artifact_materialize_invalid: path escapes change root");
  const refRel = input.refPath ?? materialized_ref_path(artifactRel);
  if (!refRel.startsWith(baseDir)) throw new GuardError(`apply_worker_artifact_materialize_invalid: refPath must stay under ${baseDir}`);
  const refPath = safe_within(changeRoot, refRel);
  if (refPath === null) throw new GuardError("apply_worker_artifact_materialize_invalid: refPath escapes change root");
  if (refPath === artifactPath) throw new GuardError("apply_worker_artifact_materialize_invalid: refPath must differ from artifact path");
  const workerChainContext = input.workerChainContext ?? (input.applyWorkerChainId ? "executor_worker" : "none");
  if (workerChainContext !== "none" && workerChainContext !== "executor_worker") {
    throw new GuardError("apply_worker_artifact_materialize_invalid: workerChainContext must be none or executor_worker");
  }
  if (workerChainContext === "executor_worker" && (typeof input.applyWorkerChainId !== "string" || !input.applyWorkerChainId)) {
    throw new GuardError("apply_worker_artifact_materialize_invalid: executor_worker refs require applyWorkerChainId");
  }
  if (workerChainContext === "none" && input.applyWorkerChainId !== undefined) {
    throw new GuardError("apply_worker_artifact_materialize_invalid: non-chain refs must not declare applyWorkerChainId");
  }
  ensure_materialized_sha(input.originPacketFingerprint, "originPacketFingerprint");
  ensure_materialized_fingerprint(input.sourceImplementationFingerprint, "sourceImplementationFingerprint");
  ensure_materialized_sha(input.inputRefDigest, "inputRefDigest");
  const implementationField = role === "executor" ? "producedImplementationFingerprint" : "observedImplementationFingerprint";
  ensure_materialized_fingerprint(input[implementationField], implementationField);
  if (kind === "raw_transcript") {
    for (const field of ["command", "cwd", "phase", "testId"] as const) {
      if (typeof input[field] !== "string" || !input[field]) {
        throw new GuardError(`apply_worker_artifact_materialize_invalid: raw transcript requires ${field}`);
      }
    }
    if (typeof input.exitCode !== "number") throw new GuardError("apply_worker_artifact_materialize_invalid: raw transcript requires exitCode");
  }
  const bytes = materialized_bytes(input.content);
  const maxBytes = input.maxBytes ?? DEFAULT_APPLY_WORKER_ARTIFACT_MAX_BYTES;
  if (bytes.length === 0) throw new GuardError("apply_worker_artifact_materialize_invalid: artifact content is empty");
  if (bytes.length > maxBytes) throw new GuardError("apply_worker_artifact_materialize_invalid: artifact content exceeds maxBytes");
  const metadata = input.metadata ?? {};
  for (const reserved of [
    "root",
    "path",
    "blob_sha",
    "size_bytes",
    "kind",
    "role",
    "task_id",
    "created_at",
    "worker_chain_context",
    "apply_worker_chain_id",
    "origin_packet_fingerprint",
    "guard_fingerprint",
    "source_implementation_fingerprint",
    "produced_implementation_fingerprint",
    "observed_implementation_fingerprint",
    "input_ref_digest",
    "command",
    "cwd",
    "phase",
    "test_id",
    "exit_code",
  ]) {
    if (metadata[reserved] !== undefined) throw new GuardError(`apply_worker_artifact_materialize_invalid: metadata must not override ${reserved}`);
  }
  const artifactSnapshot = materialized_file_snapshot(artifactPath);
  write_materialized_file_atomic(artifactPath, bytes);
  const st = statSync(artifactPath);
  if (!st.isFile() || st.size <= 0) throw new GuardError("apply_worker_artifact_materialize_invalid: artifact write failed");
  const ref: JsonMap = {
    root: "change",
    path: artifactRel,
    blob_sha: file_blob_sha(artifactPath),
    size_bytes: st.size,
    kind,
    role,
    task_id: taskId,
    created_at: new Date().toISOString(),
    worker_chain_context: workerChainContext,
    origin_packet_fingerprint: input.originPacketFingerprint,
    guard_fingerprint: input.originPacketFingerprint,
    source_implementation_fingerprint: input.sourceImplementationFingerprint,
    input_ref_digest: input.inputRefDigest,
    ...(workerChainContext === "executor_worker" ? { apply_worker_chain_id: input.applyWorkerChainId } : {}),
    ...(role === "executor"
      ? { produced_implementation_fingerprint: input.producedImplementationFingerprint }
      : { observed_implementation_fingerprint: input.observedImplementationFingerprint }),
    ...(kind === "raw_transcript" ? {
      command: input.command,
      cwd: input.cwd,
      phase: input.phase,
      test_id: input.testId,
      exit_code: input.exitCode,
    } : {}),
    ...metadata,
  };
  try {
    write_materialized_file_atomic(refPath, Buffer.from(`${JSON.stringify(ref, null, 2)}\n`));
  } catch (err) {
    restore_materialized_file(artifactPath, artifactSnapshot);
    throw err;
  }
  return { ...ref, ref_path: refRel };
}

type WorkerReportFieldType = "array" | "fingerprint" | "mismatch" | "non_empty_array" | "number" | "object" | "ref" | "string";

const WORKER_REPORT_FIELD_TYPES: Record<string, WorkerReportFieldType> = {
  command: "string",
  command_source: "string",
  cwd: "string",
  phase: "string",
  task_id: "string",
  test_id: "string",
  exit_code: "number",
  semantic_status_candidate: "string",
  result_summary: "string",
  runtime_raw_transcript_ref: "ref",
  repo_head: "string",
  pre_dirty_state: "object",
  post_dirty_state: "object",
  changed_files: "array",
  untracked_files: "array",
  invariant_refs: "array",
  source_refs: "non_empty_array",
  apply_worker_chain_id: "string",
  guard_fingerprint: "string",
  suggested_green_checks: "array",
  test_invariant_mapping: "object",
  runtime_artifact_refs: "array",
  risk_notes: "array",
  review_status_candidate: "string",
  executor_report_ref: "ref",
  actual_changed_files: "array",
  implementation_dirty_file_list: "array",
  implementation_fingerprint: "fingerprint",
  source_implementation_fingerprint: "fingerprint",
  produced_implementation_fingerprint: "fingerprint",
  observed_implementation_fingerprint: "fingerprint",
  guard_artifact_manifest_fingerprint: "fingerprint",
  scope_verdict: "string",
  protected_path_verdict: "string",
  executor_report_mismatch: "mismatch",
  test_invariant_mapping_verdict: "string",
  suggested_green_test_ids: "array",
  runtime_raw_git_status_transcript_ref: "ref",
  runtime_raw_git_diff_name_status_transcript_ref: "ref",
  runtime_path_scoped_diff_transcript_refs: "array",
  verification_status_candidate: "string",
  task_completion_verdict: "string",
  chain_consistency_verdict: "string",
  acceptance_coverage_verdict: "string",
  invariant_coverage_verdict: "string",
  test_coverage_verdict: "string",
  expected_freshness_fingerprint: "fingerprint",
  observed_freshness_fingerprint: "fingerprint",
  freshness_verdict: "string",
  completion_proof_kind: "string",
  pre_edit_proof_kind: "string",
  green_test_run_evidence_refs: "array",
  alternative_verification_evidence_refs: "array",
  apply_execution_surface: "string",
  task_code_review_report_ref: "ref",
  unexpected_guard_owned_dirty_paths: "array",
  executor_code_review_mismatch: "mismatch",
  test_evidence_mismatch: "mismatch",
  diff_summary_refs: "array",
  triggered_stop_conditions: "array",
  unverified_items: "array",
};

function report_field_valid(value: unknown, fieldType: WorkerReportFieldType): boolean {
  if (fieldType === "array") return Array.isArray(value);
  if (fieldType === "fingerprint") return Boolean(fingerprint_digest(value));
  if (fieldType === "mismatch") return value !== undefined;
  if (fieldType === "non_empty_array") return Array.isArray(value) && value.length > 0;
  if (fieldType === "number") return typeof value === "number" && Number.isFinite(value);
  if (fieldType === "object") return isObject(value);
  if (fieldType === "ref") return isObject(value) || (typeof value === "string" && value.trim().length > 0);
  return typeof value === "string" && value.trim().length > 0;
}

function report_required_field_reasons(content: JsonMap, fields: readonly string[], label: string, code: string): Reason[] {
  const problems: Reason[] = [];
  for (const field of fields) {
    const fieldType = WORKER_REPORT_FIELD_TYPES[field] ?? "string";
    if (!report_field_valid(content[field], fieldType)) {
      problems.push(reason(code, `${label}: report requires ${field} (${fieldType})`, [label, field]));
    }
  }
  return problems;
}

function report_pass_verdict_reasons(content: JsonMap, fields: string[], label: string, code: string): Reason[] {
  return fields.flatMap((field) => content[field] === "pass"
    ? []
    : [reason(code, `${label}: report requires ${field}=pass`, [label, field])]);
}

function mismatch_clear(value: unknown): boolean {
  if (value === false || value === "none" || value === "pass") return true;
  if (Array.isArray(value) && value.length === 0) return true;
  if (isObject(value)) {
    if (value.status === "pass" || value.status === "none") return true;
    if (value.mismatch === false || value.has_mismatch === false) return true;
    if (Array.isArray(value.items) && value.items.length === 0) return true;
  }
  return false;
}

function report_mismatch_clear_reasons(content: JsonMap, fields: string[], label: string, code: string): Reason[] {
  return fields.flatMap((field) => mismatch_clear(content[field])
    ? []
    : [reason(code, `${label}: report requires ${field} to be clear`, [label, field])]);
}

function report_empty_array_reasons(content: JsonMap, fields: string[], label: string, code: string): Reason[] {
  return fields.flatMap((field) => Array.isArray(content[field]) && content[field].length === 0
    ? []
    : [reason(code, `${label}: report requires ${field} to be an empty array`, [label, field])]);
}

function worker_report_policy_reasons(content: JsonMap, label: string, code: string): Reason[] {
  const problems: Reason[] = [];
  let inlineChars = 0;
  for (const field of ["truncated", "is_truncated", "report_truncated", "output_truncated"]) {
    if (content[field] === true) problems.push(reason(code, `${label}: worker report must not be truncated (${field})`, [label, field]));
  }
  for (const [field, value] of Object.entries(content)) {
    if (typeof value !== "string") continue;
    if (field.endsWith("_ref") || field.endsWith("_refs") || field.endsWith("_fingerprint") || field === "role") continue;
    inlineChars += value.length;
    if (value.length > APPLY_WORKER_MAX_INLINE_REPORT_CHARS) {
      problems.push(reason(code, `${label}: worker report field ${field} exceeds max_inline_report_chars=${APPLY_WORKER_MAX_INLINE_REPORT_CHARS}`, [label, field]));
    }
  }
  if (inlineChars > APPLY_WORKER_MAX_INLINE_REPORT_CHARS) {
    problems.push(reason(code, `${label}: worker report inline text exceeds max_inline_report_chars=${APPLY_WORKER_MAX_INLINE_REPORT_CHARS}`, [label]));
  }
  for (const field of ["raw_log", "raw_logs", "raw_output", "full_log", "full_logs", "full_diff", "inline_diff", "compile_output", "compiler_output", "build_output", "generated_code"]) {
    const value = content[field];
    if (typeof value === "string" && value.trim()) {
      problems.push(reason(code, `${label}: worker report must use artifact refs instead of inline ${field}`, [label, field]));
    } else if (Array.isArray(value) && value.length > 0) {
      problems.push(reason(code, `${label}: worker report must use artifact refs instead of inline ${field}`, [label, field]));
    } else if (isObject(value) && Object.keys(value).length > 0) {
      problems.push(reason(code, `${label}: worker report must use artifact refs instead of inline ${field}`, [label, field]));
    }
  }
  return problems;
}

function validate_worker_report_content(content: JsonMap | null, refItem: JsonMap, label: string, expected: ArtifactRefExpected, code: string): Reason[] {
  const problems: Reason[] = [];
  if (!content) return [reason(code, `${label}: worker report artifact must be a JSON object`, [label])];
  problems.push(...worker_report_policy_reasons(content, label, code));
  if (expected.role && content.role !== expected.role) problems.push(reason(code, `${label}: report role must be ${expected.role}`, [label]));
  if (expected.taskId && content.task_id !== expected.taskId) problems.push(reason(code, `${label}: report task_id must be ${expected.taskId}`, [label]));
  if (expected.chainId && content.apply_worker_chain_id !== expected.chainId) problems.push(reason(code, `${label}: report apply_worker_chain_id mismatch`, [label]));
  if (typeof refItem.created_at !== "string" || Number.isNaN(Date.parse(refItem.created_at))) {
    problems.push(reason(code, `${label}: worker_report pinned ref requires created_at`, [label]));
  }
  for (const field of ["origin_packet_fingerprint", "input_ref_digest"]) {
    if (typeof content[field] !== "string" || !String(content[field]).startsWith("sha256:")) {
      problems.push(reason(code, `${label}: report requires ${field}`, [label]));
    }
    if (refItem[field] !== undefined && content[field] !== refItem[field]) {
      problems.push(reason(code, `${label}: report ${field} must match pinned ref`, [label]));
    }
  }
  if (typeof content.guard_fingerprint !== "string" || !content.guard_fingerprint.startsWith("sha256:")) {
    problems.push(reason(code, `${label}: report requires guard_fingerprint`, [label]));
  } else if (content.guard_fingerprint !== content.origin_packet_fingerprint) {
    problems.push(reason(code, `${label}: report guard_fingerprint must echo origin_packet_fingerprint`, [label]));
  }
  if (refItem.guard_fingerprint !== undefined && content.guard_fingerprint !== refItem.guard_fingerprint) {
    problems.push(reason(code, `${label}: report guard_fingerprint must match pinned ref`, [label]));
  }
  if (!fingerprint_digest(content.source_implementation_fingerprint)) {
    problems.push(reason(code, `${label}: report requires source_implementation_fingerprint`, [label]));
  }
  if (!fingerprint_digest(refItem.source_implementation_fingerprint)) {
    problems.push(reason(code, `${label}: pinned ref requires source_implementation_fingerprint`, [label]));
  }
  if (fingerprint_digest(content.source_implementation_fingerprint)
    && fingerprint_digest(refItem.source_implementation_fingerprint)
    && !fingerprint_matches(content.source_implementation_fingerprint, refItem.source_implementation_fingerprint)) {
    problems.push(reason(code, `${label}: report source_implementation_fingerprint must match pinned ref`, [label]));
  }
  const implementationField = expected.role === "executor" ? "produced_implementation_fingerprint" : "observed_implementation_fingerprint";
  const contentImplementation = fingerprint_digest(content[implementationField]);
  const refImplementation = fingerprint_digest(refItem[implementationField]);
  if (!contentImplementation) problems.push(reason(code, `${label}: report requires ${implementationField}`, [label]));
  if (!refImplementation) problems.push(reason(code, `${label}: pinned ref requires ${implementationField}`, [label]));
  if (contentImplementation && refImplementation && contentImplementation !== refImplementation) {
    problems.push(reason(code, `${label}: report ${implementationField} must match pinned ref`, [label]));
  }
  if (Array.isArray(content.unverified_items) && content.unverified_items.length > 0) {
    problems.push(reason(code, `${label}: report unverified_items must be empty before it can be pinned for downstream guard use`, [label]));
  }
  if (!Array.isArray(content.unverified_items)) {
    problems.push(reason(code, `${label}: report requires unverified_items array`, [label]));
  }
  if (expected.role === "verifier" && !fingerprint_digest(content.observed_freshness_fingerprint)) {
    problems.push(reason(code, `${label}: verifier report requires observed_freshness_fingerprint`, [label]));
  }
  if (expected.role === "test-runner") {
    problems.push(...report_required_field_reasons(content, APPLY_TEST_RUNNER_REPORT_REQUIRED_FIELDS, label, code));
  }
  if (expected.role === "executor") {
    problems.push(...report_required_field_reasons(content, APPLY_EXECUTOR_REPORT_REQUIRED_FIELDS, label, code));
  }
  if (expected.role === "verifier") {
    problems.push(...report_required_field_reasons(content, APPLY_VERIFIER_REPORT_REQUIRED_FIELDS, label, code));
    const proofKind = String(content.completion_proof_kind ?? "green_tests");
    if (proofKind !== "green_tests" && proofKind !== "alternative_verification") {
      problems.push(reason(code, `${label}: verifier report completion_proof_kind must be green_tests or alternative_verification`, [label]));
    } else if (proofKind === "green_tests") {
      if (String(content.pre_edit_proof_kind ?? "red_or_characterization") !== "red_or_characterization") {
        problems.push(reason(code, `${label}: green_tests verifier report requires pre_edit_proof_kind=red_or_characterization`, [label]));
      }
      if (!Array.isArray(content.green_test_run_evidence_refs) || content.green_test_run_evidence_refs.length === 0) {
        problems.push(reason(code, `${label}: green_tests verifier report requires green_test_run_evidence_refs`, [label]));
      }
      if (!Array.isArray(content.red_test_run_evidence_refs) && !Array.isArray(content.characterization_test_run_evidence_refs)) {
        problems.push(reason(code, `${label}: green_tests verifier report requires red_test_run_evidence_refs or characterization_test_run_evidence_refs`, [label]));
      }
    } else {
      if (content.pre_edit_proof_kind !== "no_tdd_declared") {
        problems.push(reason(code, `${label}: alternative_verification verifier report requires pre_edit_proof_kind=no_tdd_declared`, [label]));
      }
      if (!Array.isArray(content.alternative_verification_evidence_refs) || content.alternative_verification_evidence_refs.length === 0) {
        problems.push(reason(code, `${label}: alternative_verification verifier report requires alternative_verification_evidence_refs`, [label]));
      }
      if (Array.isArray(content.green_test_run_evidence_refs) && content.green_test_run_evidence_refs.length > 0) {
        problems.push(reason(code, `${label}: alternative_verification verifier report must not claim green_test_run_evidence_refs`, [label]));
      }
      if (Array.isArray(content.red_test_run_evidence_refs) && content.red_test_run_evidence_refs.length > 0) {
        problems.push(reason(code, `${label}: alternative_verification verifier report must not claim red_test_run_evidence_refs`, [label]));
      }
      if (Array.isArray(content.characterization_test_run_evidence_refs) && content.characterization_test_run_evidence_refs.length > 0) {
        problems.push(reason(code, `${label}: alternative_verification verifier report must not claim characterization_test_run_evidence_refs`, [label]));
      }
      if (content.tdd_required !== false) {
        problems.push(reason(code, `${label}: alternative_verification verifier report requires tdd_required=false`, [label]));
      }
      if (content.apply_execution_surface !== "implementation" && content.apply_execution_surface !== "runtime_config") {
        problems.push(reason(code, `${label}: alternative_verification verifier report requires implementation/runtime_config apply_execution_surface`, [label]));
      }
      if (!NO_TDD_REASONS.has(String(content.no_tdd_reason ?? ""))) {
        problems.push(reason(code, `${label}: alternative_verification verifier report requires valid no_tdd_reason`, [label]));
      }
    }
    problems.push(...report_pass_verdict_reasons(content, [
      "verification_status_candidate",
      "task_completion_verdict",
      "chain_consistency_verdict",
      "acceptance_coverage_verdict",
      "invariant_coverage_verdict",
      "test_coverage_verdict",
      "freshness_verdict",
      "scope_verdict",
      "protected_path_verdict",
    ], label, code));
    problems.push(...report_mismatch_clear_reasons(content, ["executor_code_review_mismatch", "test_evidence_mismatch"], label, code));
    problems.push(...report_empty_array_reasons(content, ["unexpected_guard_owned_dirty_paths", "triggered_stop_conditions"], label, code));
  }
  if (expected.role === "code-reviewer") {
    problems.push(...report_required_field_reasons(content, APPLY_CODE_REVIEW_REPORT_REQUIRED_FIELDS, label, code));
    const contentDigest = fingerprint_digest(content.observed_implementation_fingerprint);
    const refDigest = fingerprint_digest(refItem.observed_implementation_fingerprint);
    if (!contentDigest) problems.push(reason(code, `${label}: code-reviewer report requires observed_implementation_fingerprint`, [label]));
    if (!refDigest) problems.push(reason(code, `${label}: code-reviewer pinned ref requires observed_implementation_fingerprint`, [label]));
    if (contentDigest && refDigest && contentDigest !== refDigest) {
      problems.push(reason(code, `${label}: report observed_implementation_fingerprint must match pinned ref`, [label]));
    }
    problems.push(...report_pass_verdict_reasons(content, ["review_status_candidate", "scope_verdict", "protected_path_verdict", "test_invariant_mapping_verdict"], label, code));
    problems.push(...report_mismatch_clear_reasons(content, ["executor_report_mismatch"], label, code));
  }
  return problems;
}

function validate_status_report_content(content: JsonMap | null, label: string, expected: ArtifactRefExpected, code: string): Reason[] {
  const problems: Reason[] = [];
  if (!content) return [reason(code, `${label}: status report artifact must be a JSON object`, [label])];
  if (expected.taskId && content.task_id !== expected.taskId) problems.push(reason(code, `${label}: status report task_id must be ${expected.taskId}`, [label]));
  if (expected.chainId && content.apply_worker_chain_id !== expected.chainId && content.chain_id !== expected.chainId) {
    problems.push(reason(code, `${label}: status report apply_worker_chain_id mismatch`, [label]));
  }
  if (!fingerprint_digest(content.implementation_fingerprint)) {
    problems.push(reason(code, `${label}: status report requires implementation_fingerprint`, [label]));
  }
  return problems;
}

function validate_raw_transcript_ref(refItem: JsonMap, label: string, code: string): Reason[] {
  const problems: Reason[] = [];
  for (const field of ["command", "cwd", "phase", "test_id"]) {
    if (typeof refItem[field] !== "string" || !refItem[field]) problems.push(reason(code, `${label}: raw transcript requires ${field}`, [label]));
  }
  if (typeof refItem.exit_code !== "number") problems.push(reason(code, `${label}: raw transcript requires numeric exit_code`, [label]));
  return problems;
}

function validate_pinned_artifact_identity(refItem: JsonMap, label: string, code: string): Reason[] {
  const problems: Reason[] = [];
  if (typeof refItem.created_at !== "string" || Number.isNaN(Date.parse(refItem.created_at))) {
    problems.push(reason(code, `${label}: pinned artifact ref requires created_at`, [label]));
  }
  if (refItem.worker_chain_context !== "none" && refItem.worker_chain_context !== "executor_worker") {
    problems.push(reason(code, `${label}: worker_chain_context must be none or executor_worker`, [label]));
  }
  if (refItem.worker_chain_context === "executor_worker" && (typeof refItem.apply_worker_chain_id !== "string" || !refItem.apply_worker_chain_id)) {
    problems.push(reason(code, `${label}: executor_worker ref requires apply_worker_chain_id`, [label]));
  }
  if (refItem.worker_chain_context === "none" && refItem.apply_worker_chain_id !== undefined) {
    problems.push(reason(code, `${label}: non-chain ref must not declare apply_worker_chain_id`, [label]));
  }
  for (const field of ["origin_packet_fingerprint", "guard_fingerprint", "input_ref_digest"]) {
    if (typeof refItem[field] !== "string" || !String(refItem[field]).startsWith("sha256:")) {
      problems.push(reason(code, `${label}: pinned artifact ref requires ${field}`, [label, field]));
    }
  }
  if (refItem.origin_packet_fingerprint !== undefined
    && refItem.guard_fingerprint !== undefined
    && refItem.guard_fingerprint !== refItem.origin_packet_fingerprint) {
    problems.push(reason(code, `${label}: guard_fingerprint must echo origin_packet_fingerprint`, [label]));
  }
  if (!fingerprint_digest(refItem.source_implementation_fingerprint)) {
    problems.push(reason(code, `${label}: pinned artifact ref requires source_implementation_fingerprint`, [label]));
  }
  const implementationField = refItem.role === "executor" ? "produced_implementation_fingerprint" : "observed_implementation_fingerprint";
  if (!fingerprint_digest(refItem[implementationField])) {
    problems.push(reason(code, `${label}: pinned artifact ref requires ${implementationField}`, [label]));
  }
  return problems;
}

function field_mismatch_reasons(actual: unknown, expected: unknown, field: string, label: string, code: string): Reason[] {
  return deepEqual(actual, expected)
    ? []
    : [reason(code, `${label}: ${field} mismatch`, [label, field])];
}

function non_chain_artifact_context_reasons(refItem: JsonMap, label: string, code: string): Reason[] {
  const problems: Reason[] = [];
  if (refItem.worker_chain_context === "executor_worker" || typeof refItem.apply_worker_chain_id === "string") {
    problems.push(reason(code, `${label}: non-chain test-runner artifact must not declare executor_worker chain fields`, [label]));
  }
  return problems;
}

function worker_report_matches_test_run_reasons(report: JsonMap, ev: JsonMap, taskId: string, chainId: string | null, code: string): Reason[] {
  const problems: Reason[] = [];
  for (const field of ["command", "cwd", "phase", "test_id", "exit_code", "guard_fingerprint"]) {
    problems.push(...field_mismatch_reasons(report[field], ev[field], `worker_report.${field}`, "accepted_test_runner_report_ref", code));
  }
  for (const field of ["source_refs", "pre_dirty_state", "post_dirty_state", "changed_files", "untracked_files"]) {
    problems.push(...field_mismatch_reasons(report[field], ev[field], `worker_report.${field}`, "accepted_test_runner_report_ref", code));
  }
  for (const field of ["expected_failure_signature", "expected_failure_classifier"]) {
    if (ev[field] !== undefined || report[field] !== undefined) {
      problems.push(...field_mismatch_reasons(report[field], ev[field], `worker_report.${field}`, "accepted_test_runner_report_ref", code));
    }
  }
  problems.push(...field_mismatch_reasons(report.task_id, taskId, "worker_report.task_id", "accepted_test_runner_report_ref", code));
  problems.push(...field_mismatch_reasons(report.semantic_status_candidate, ev.semantic_status, "worker_report.semantic_status_candidate", "accepted_test_runner_report_ref", code));
  if (chainId) {
    problems.push(...field_mismatch_reasons(report.apply_worker_chain_id, chainId, "worker_report.apply_worker_chain_id", "accepted_test_runner_report_ref", code));
  }
  return problems;
}

function raw_transcript_matches_test_run_reasons(refItem: JsonMap, ev: JsonMap, taskId: string, chainId: string | null, code: string): Reason[] {
  const problems: Reason[] = [];
  for (const field of ["command", "cwd", "phase", "test_id", "exit_code"]) {
    problems.push(...field_mismatch_reasons(refItem[field], ev[field], `raw_transcript.${field}`, "raw_log_pinned_refs", code));
  }
  problems.push(...field_mismatch_reasons(refItem.task_id, taskId, "raw_transcript.task_id", "raw_log_pinned_refs", code));
  if (chainId) {
    problems.push(...field_mismatch_reasons(refItem.apply_worker_chain_id, chainId, "raw_transcript.apply_worker_chain_id", "raw_log_pinned_refs", code));
  }
  return problems;
}

export function pinned_artifact_ref_reasons(
  changeRoot: string,
  refItem: unknown,
  label: string,
  expected: ArtifactRefExpected = {},
  code = "pinned_artifact_ref_invalid",
): Reason[] {
  const problems: Reason[] = [];
  if (!isObject(refItem)) return [reason(code, `${label}: ref must be object`, [label])];
  const kind = expected.kind ?? (typeof refItem.kind === "string" ? refItem.kind : "");
  if (refItem.root !== "change") problems.push(reason(code, `${label}: root must be change`, [label]));
  for (const key of ["path", "blob_sha", "kind", "role", "task_id"]) {
    if (typeof refItem[key] !== "string" || !refItem[key]) problems.push(reason(code, `${label}: ${key} must be a non-empty string`, [label]));
  }
  if (expected.role && (typeof refItem.role !== "string" || !refItem.role)) problems.push(reason(code, `${label}: role must be a non-empty string`, [label]));
  if (typeof refItem.size_bytes !== "number") problems.push(reason(code, `${label}: size_bytes must be a number`, [label]));
  if (expected.kind && refItem.kind !== expected.kind) problems.push(reason(code, `${label}: kind must be ${expected.kind}`, [label]));
  if (expected.role && refItem.role !== expected.role) problems.push(reason(code, `${label}: role must be ${expected.role}`, [label]));
  if (expected.taskId && refItem.task_id !== expected.taskId) problems.push(reason(code, `${label}: task_id must be ${expected.taskId}`, [label]));
  if (expected.chainId) {
    if (refItem.worker_chain_context !== "executor_worker") problems.push(reason(code, `${label}: worker_chain_context must be executor_worker`, [label]));
    if (refItem.apply_worker_chain_id !== expected.chainId) problems.push(reason(code, `${label}: apply_worker_chain_id mismatch`, [label]));
  }
  const dir = expected_dir(kind, expected.taskId ?? (typeof refItem.task_id === "string" ? refItem.task_id : undefined));
  if (dir && typeof refItem.path === "string" && !refItem.path.startsWith(dir)) {
    problems.push(reason(code, `${label}: path must stay under ${dir}`, [label]));
  }
  const rel = typeof refItem.path === "string" ? refItem.path : "";
  const target = rel ? safe_within(changeRoot, rel) : null;
  if (target === null) {
    problems.push(reason(code, `${label}: path escapes change root`, [label]));
    return problems;
  }
  if (!existsSync(target) || !statSync(target).isFile()) {
    problems.push(reason(code, `${label}: path is not readable: ${rel}`, [label]));
    return problems;
  }
  const st = statSync(target);
  if (st.size <= 0) problems.push(reason(code, `${label}: path is empty: ${rel}`, [label]));
  if (typeof refItem.size_bytes === "number" && refItem.size_bytes !== st.size) problems.push(reason(code, `${label}: size_bytes is stale for ${rel}`, [label]));
  if (typeof refItem.blob_sha !== "string" || runtime.file_blob_sha(target) !== refItem.blob_sha) problems.push(reason(code, `${label}: blob_sha is stale for ${rel}`, [label]));
  problems.push(...validate_pinned_artifact_identity(refItem, label, code));
  if (kind === "raw_transcript") problems.push(...validate_raw_transcript_ref(refItem, label, code));
  if (kind === "worker_report") problems.push(...validate_worker_report_content(read_pinned_artifact_json(changeRoot, refItem), refItem, label, expected, code));
  if (kind === "status_report") problems.push(...validate_status_report_content(read_pinned_artifact_json(changeRoot, refItem), label, expected, code));
  return problems;
}

export function worker_test_run_reasons(
  changeRoot: string,
  ev: JsonMap,
  taskId: string,
  chainId: string | null,
  code = "test_run_worker_ref_missing",
): Reason[] {
  const problems: Reason[] = [];
  if (ev.runner_origin !== "test-runner") problems.push(reason(code, `${ev._path}: executor_worker test_run requires runner_origin=test-runner`));
  if (typeof ev.phase !== "string" || !ev.phase) problems.push(reason(code, `${ev._path}: runner_origin=test-runner requires phase`));
  if (chainId) {
    if (ev.apply_execution_chain !== "executor_worker") problems.push(reason(code, `${ev._path}: executor_worker test_run requires apply_execution_chain=executor_worker`));
    if (ev.apply_worker_chain_id !== chainId) problems.push(reason(code, `${ev._path}: apply_worker_chain_id mismatch`));
  } else if (ev.apply_execution_chain === "executor_worker" || typeof ev.apply_worker_chain_id === "string") {
    problems.push(reason(code, `${ev._path}: non-chain test-runner test_run must not declare executor_worker chain fields`));
  }
  for (const field of ["command", "cwd", "repo_head", "guard_fingerprint"]) {
    if (typeof ev[field] !== "string" || !ev[field]) problems.push(reason(code, `${ev._path}: executor_worker test_run requires ${field}`));
  }
  if (!Array.isArray(ev.source_refs) || ev.source_refs.length === 0) problems.push(reason(code, `${ev._path}: runner_origin=test-runner requires non-empty source_refs`));
  for (const field of ["pre_dirty_state", "post_dirty_state"]) {
    if (!isObject(ev[field])) problems.push(reason(code, `${ev._path}: runner_origin=test-runner requires ${field}`));
  }
  for (const field of ["changed_files", "untracked_files"]) {
    if (!Array.isArray(ev[field])) problems.push(reason(code, `${ev._path}: runner_origin=test-runner requires ${field}`));
  }
  if (typeof ev.exit_code !== "number") problems.push(reason(code, `${ev._path}: executor_worker test_run requires numeric exit_code`));
  if (!isObject(ev.implementation_fingerprint) || !fingerprint_digest(ev.implementation_fingerprint)) problems.push(reason(code, `${ev._path}: executor_worker test_run requires implementation_fingerprint`));
  if (!isObject(ev.guard_artifact_manifest_fingerprint) || !fingerprint_digest(ev.guard_artifact_manifest_fingerprint)) problems.push(reason(code, `${ev._path}: executor_worker test_run requires guard_artifact_manifest_fingerprint`));
  if (!isObject(ev.accepted_test_runner_report_ref)) {
    problems.push(reason(code, `${ev._path}: runner_origin=test-runner requires accepted_test_runner_report_ref`));
  } else {
    const reportRef = ev.accepted_test_runner_report_ref;
    problems.push(...pinned_artifact_ref_reasons(changeRoot, reportRef, "accepted_test_runner_report_ref", {
      kind: "worker_report",
      role: "test-runner",
      taskId,
      chainId: chainId ?? undefined,
    }, code));
    if (!chainId) problems.push(...non_chain_artifact_context_reasons(reportRef, "accepted_test_runner_report_ref", code));
    const report = read_pinned_artifact_json(changeRoot, reportRef);
    if (report) problems.push(...worker_report_matches_test_run_reasons(report, ev, taskId, chainId, code));
  }
  const rawRefs = ev.raw_log_pinned_refs;
  if (!Array.isArray(rawRefs) || rawRefs.length === 0 || !rawRefs.every(isObject)) {
    problems.push(reason(code, `${ev._path}: runner_origin=test-runner requires non-empty raw_log_pinned_refs`));
  } else {
    for (const refItem of rawRefs) {
      problems.push(...pinned_artifact_ref_reasons(changeRoot, refItem, "raw_log_pinned_refs", {
        kind: "raw_transcript",
        role: "test-runner",
        taskId,
        chainId: chainId ?? undefined,
      }, code));
      if (!chainId) problems.push(...non_chain_artifact_context_reasons(refItem, "raw_log_pinned_refs", code));
      problems.push(...raw_transcript_matches_test_run_reasons(refItem, ev, taskId, chainId, code));
    }
  }
  const rawLogRefs = Array.isArray(ev.raw_log_refs) ? ev.raw_log_refs.map(String).sort() : [];
  const pinnedPaths = Array.isArray(rawRefs) ? rawRefs.filter(isObject).map((item) => String(item.path ?? "")).filter(Boolean).sort() : [];
  if (rawLogRefs.length === 0 || !deepEqual(rawLogRefs, pinnedPaths)) {
    problems.push(reason(code, `${ev._path}: raw_log_refs must match raw_log_pinned_refs paths exactly: ${renderList(rawLogRefs)} != ${renderList(pinnedPaths)}`));
  }
  return problems;
}

export function pre_edit_worker_test_run_reasons(
  changeRoot: string,
  ev: JsonMap,
  taskId: string,
  code = "pre_edit_test_run_invalid",
): Reason[] {
  const problems: Reason[] = [];
  if (ev.kind !== "test_run") problems.push(reason(code, `${ev._path}: pre-edit evidence must be kind=test_run`));
  if (ev.gate !== "task_edit") problems.push(reason(code, `${ev._path}: pre-edit evidence must be gate=task_edit`));
  if (ev.task_id !== taskId) problems.push(reason(code, `${ev._path}: pre-edit evidence task_id must be ${taskId}`));
  const phase = typeof ev.phase === "string" ? ev.phase : "";
  const redOk = ev.semantic_status === "expected_failure" && (phase === "" || phase === "red");
  const characterizationOk = ev.semantic_status === "expected_success" && phase === "characterization";
  if (!redOk && !characterizationOk) {
    problems.push(reason(code, `${ev._path}: pre-edit evidence must be worker RED or characterization test_run`));
  }
  problems.push(...worker_test_run_reasons(changeRoot, ev, taskId, null, code));
  return problems;
}

function superseded_ids(evidences: JsonMap[]): Set<string> {
  return effective_superseded_ids(evidences);
}

function live_pass_by_id(evidences: JsonMap[], evidenceId: string): JsonMap | undefined {
  const dead = superseded_ids(evidences);
  return evidences.find((ev) => isObject(ev)
    && !ev._invalid
    && ev.status === "pass"
    && String(ev.evidence_id ?? "") === evidenceId
    && !dead.has(evidenceId));
}

export function pre_edit_evidence_ref_reasons(
  changeRoot: string,
  evidences: JsonMap[],
  active: JsonMap | null | undefined,
  taskId: string,
  code = "pre_edit_evidence_ref_invalid",
): Reason[] {
  const problems: Reason[] = [];
  if (!isObject(active)) return [reason(code, `task ${taskId} requires an active apply_worker_chain marker for pre-edit evidence validation`)];
  const preIds = Array.isArray(active.pre_edit_evidence_refs) ? active.pre_edit_evidence_refs.map(String).filter(Boolean) : [];
  const proofKind = String(active.pre_edit_proof_kind ?? "red_or_characterization");
  if (proofKind !== "red_or_characterization" && proofKind !== "no_tdd_declared") {
    return [reason(code, `task ${taskId} active apply_worker_chain has invalid pre_edit_proof_kind=${proofKind}`)];
  }
  if (proofKind === "no_tdd_declared") {
    if (preIds.length > 0) problems.push(reason(code, `task ${taskId} active apply_worker_chain no_tdd_declared must have empty pre_edit_evidence_refs`, preIds));
    if (active.tdd_required !== false) problems.push(reason(code, `task ${taskId} active apply_worker_chain no_tdd_declared requires tdd_required=false`));
    if (active.apply_execution_surface !== "implementation" && active.apply_execution_surface !== "runtime_config") {
      problems.push(reason(code, `task ${taskId} active apply_worker_chain no_tdd_declared requires implementation/runtime_config apply_execution_surface`));
    }
    if (!NO_TDD_REASONS.has(String(active.no_tdd_reason ?? ""))) {
      problems.push(reason(code, `task ${taskId} active apply_worker_chain no_tdd_declared requires valid no_tdd_reason`));
    }
    return problems;
  }
  if (preIds.length === 0) return [reason(code, `task ${taskId} active apply_worker_chain has no pre_edit_evidence_refs`)];
  for (const evidenceId of preIds) {
    const ev = live_pass_by_id(evidences, evidenceId);
    if (!ev) {
      problems.push(reason(code, `pre_edit_evidence_ref is not live/pass: ${evidenceId}`, [evidenceId]));
      continue;
    }
    problems.push(...pre_edit_worker_test_run_reasons(changeRoot, ev, taskId, code)
      .map((item) => ({ ...item, refs: item.refs.length > 0 ? item.refs : [evidenceId] })));
  }
  return problems;
}

export function compute_apply_worker_freshness(
  repoRoot: string,
  changeRoot: string,
  evidences: JsonMap[],
  taskId: string,
  chainId: string,
  refs: {
    executor_report_ref: unknown;
    task_code_review_report_ref: unknown;
    green_test_run_evidence_ref?: string;
    green_test_run_evidence_refs?: string[];
    alternative_verification_evidence_refs?: string[];
    completion_proof_kind?: "green_tests" | "alternative_verification";
    verifier_report_ref?: unknown;
  },
): JsonMap {
  const passEvidences = evidences.filter((ev) => isObject(ev) && !ev._invalid && ev.status === "pass");
  const active = passEvidences
    .filter((ev) => ev.gate === "task_complete" && ev.kind === "apply_worker_chain" && ev.task_id === taskId)
    .find((ev) => ev.chain_state === "active" && ev.apply_worker_chain_id === chainId);
  const greenIds = [...new Set([
    ...(Array.isArray(refs.green_test_run_evidence_refs) ? refs.green_test_run_evidence_refs : []),
    refs.green_test_run_evidence_ref,
  ].map(String).filter(Boolean))].sort();
  const greens = greenIds.map((greenId) => passEvidences
    .filter((ev) => ev.gate === "task_complete" && ev.kind === "test_run" && ev.task_id === taskId)
    .find((ev) => String(ev.evidence_id ?? "") === greenId)).filter((ev): ev is JsonMap => isObject(ev));
  const green = greens[0];
  const alternativeIds = [...new Set((Array.isArray(refs.alternative_verification_evidence_refs) ? refs.alternative_verification_evidence_refs : []).map(String).filter(Boolean))].sort();
  const alternatives = alternativeIds.map((evidenceId) => passEvidences
    .filter((ev) => (ev.kind === "alternative_verification" || ev.kind === "manual_verification") && ev.task_id === taskId)
    .find((ev) => String(ev.evidence_id ?? "") === evidenceId)).filter((ev): ev is JsonMap => isObject(ev));
  const alternative = alternatives[0];
  const completionProofKind = refs.completion_proof_kind ?? (alternativeIds.length > 0 ? "alternative_verification" : "green_tests");
  const preEditProofKind = String(active?.pre_edit_proof_kind ?? "red_or_characterization");
  const preIds = Array.isArray(active?.pre_edit_evidence_refs) ? active.pre_edit_evidence_refs.map(String) : [];
  const preEditEvidence = preIds.map((id) => evidences.find((ev) => String(ev.evidence_id ?? "") === id)).filter((ev): ev is JsonMap => isObject(ev));
  const preEdit = preEditEvidence.map(evidence_summary).filter(Boolean);
  const rawRefs = greens.flatMap((item) => Array.isArray(item.raw_log_pinned_refs) ? item.raw_log_pinned_refs : []);
  const acceptedTestRunnerRefs = greens.map((item) => item.accepted_test_runner_report_ref).filter(Boolean);
  const evidenceFileRefs = [
    evidence_file_ref(changeRoot, active),
    ...preEditEvidence.map((ev) => evidence_file_ref(changeRoot, ev)),
    ...greens.map((ev) => evidence_file_ref(changeRoot, ev)),
    ...alternatives.map((ev) => evidence_file_ref(changeRoot, ev)),
  ].filter((item): item is JsonMap => isObject(item));
  const expectedGuardRefs = [
    refs.executor_report_ref,
    refs.task_code_review_report_ref,
    refs.verifier_report_ref,
    ...acceptedTestRunnerRefs,
    ...(rawRefs as unknown[]),
    ...evidenceFileRefs,
  ];
  const activeScope = Array.isArray(active?.declared_task_write_scope) ? active.declared_task_write_scope.map(String).filter(Boolean) : [];
  const implementation = apply_worker_implementation_fingerprint(repoRoot, changeRoot, expectedGuardRefs, { declaredTaskWriteScope: activeScope });
  const greenImplementationDigest = fingerprint_digest(green?.implementation_fingerprint);
  const guardArtifact = apply_worker_guard_artifact_manifest_fingerprint({
    completion_proof_kind: completionProofKind,
    pre_edit_proof_kind: preEditProofKind,
    pre_edit_evidence: preEdit,
    green_test_run: evidence_summary(green),
    green_test_runs: greens.map(evidence_summary).filter(Boolean),
    alternative_verification: evidence_summary(alternative),
    alternative_verifications: alternatives.map(evidence_summary).filter(Boolean),
    executor_report_ref: refs.executor_report_ref,
    task_code_review_report_ref: refs.task_code_review_report_ref,
    accepted_test_runner_report_ref: green?.accepted_test_runner_report_ref,
    accepted_test_runner_report_refs: acceptedTestRunnerRefs,
    raw_log_pinned_refs: rawRefs,
    evidence_file_refs: evidenceFileRefs,
    active_chain: active ? {
      evidence_id: active.evidence_id,
      task_id: active.task_id,
      apply_worker_chain_id: active.apply_worker_chain_id,
      executor_packet_fingerprint: active.executor_packet_fingerprint,
      source_implementation_fingerprint: active.source_implementation_fingerprint,
      declared_task_write_scope: active.declared_task_write_scope,
      pre_edit_evidence_refs: active.pre_edit_evidence_refs,
      pre_edit_proof_kind: active.pre_edit_proof_kind,
      apply_execution_surface: active.apply_execution_surface,
      tdd_required: active.tdd_required,
      no_tdd_reason: active.no_tdd_reason,
    } : null,
  });
  const stable = {
    task_id: taskId,
    apply_worker_chain_id: chainId,
    completion_proof_kind: completionProofKind,
    pre_edit_proof_kind: preEditProofKind,
    repo_head: repo_head(repoRoot),
    implementation_fingerprint: {
      repo_head: implementation.repo_head,
      declared_task_write_scope: implementation.declared_task_write_scope,
      protected_path_refs: implementation.protected_path_refs,
      implementation_dirty_file_list: implementation.implementation_dirty_file_list,
      scoped_name_status_transcript_digest: implementation.scoped_name_status_transcript_digest,
      scoped_diff_transcript_digest: implementation.scoped_diff_transcript_digest,
      dirty_files: implementation.dirty_files,
      fingerprint_digest: implementation.fingerprint_digest,
    },
    guard_artifact_manifest_fingerprint: {
      fingerprint_digest: guardArtifact.fingerprint_digest,
    },
    green_implementation_fingerprint: greenImplementationDigest ? { fingerprint_digest: greenImplementationDigest } : null,
    pre_edit_evidence_refs: preIds,
    green_test_run_evidence_ref: refs.green_test_run_evidence_ref,
    green_test_run_evidence_refs: greenIds,
    alternative_verification_evidence_ref: alternativeIds[0] ?? null,
    alternative_verification_evidence_refs: alternativeIds,
    executor_report_ref: pinned_summary(refs.executor_report_ref),
    task_code_review_report_ref: pinned_summary(refs.task_code_review_report_ref),
  };
  return {
    ...stable,
    implementation_dirty_file_list: implementation.implementation_dirty_file_list,
    guard_artifact_manifest: guardArtifact,
    unexpected_guard_owned_dirty_paths: implementation.unexpected_guard_owned_dirty_paths,
    protected_dirty_paths: implementation.protected_dirty_paths,
    protected_path_refs: implementation.protected_path_refs,
    fingerprint_digest: fingerprint_obj(stable),
    helper_version: "apply-worker-freshness-v1",
    computed_at: new Date().toISOString(),
  };
}
