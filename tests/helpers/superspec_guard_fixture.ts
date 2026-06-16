import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import test from "node:test";
import {
  existsSync,
  linkSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { hostname, tmpdir } from "node:os";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import * as guard from "../../superspec_guard.ts";
import { main_init } from "../../src/init_cli.ts";
import { reason_message_zh, translate_action_zh } from "../../src/i18n.ts";
import { project_init } from "../../src/project_init.ts";

export type JsonMap = Record<string, any>;

export function findRepoRoot(start: string): string {
  let dir = resolve(start);
  while (true) {
    if (existsSync(join(dir, "openspec")) && existsSync(join(dir, ".codex"))) return dir;
    const parent = dirname(dir);
    if (parent === dir) return resolve(start);
    dir = parent;
  }
}

export const GUARD_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
export const REPO_ROOT = findRepoRoot(GUARD_ROOT);
export const GUARD_TS = join(GUARD_ROOT, "superspec_guard.ts");
export const GUARD_TS_URL = new URL("../../superspec_guard.ts", import.meta.url).href;
export const INIT_TS = join(GUARD_ROOT, "superspec_init.ts");

export function mkdirp(path: string): void {
  mkdirSync(path, { recursive: true });
}

export function writeText(path: string, text: string): void {
  mkdirp(dirname(path));
  writeFileSync(path, text, "utf8");
}

export function readJson(path: string): JsonMap {
  return JSON.parse(readFileSync(path, "utf8"));
}

export function materializeEvidenceRecord(fx: Fixture, relPath: string, evidence: JsonMap): JsonMap {
  writeText(join(fx.change, relPath), `${JSON.stringify(evidence, null, 2)}\n`);
  return { ...evidence, _path: relPath };
}

export function codes(items: JsonMap[] | undefined): string[] {
  return (items ?? []).map((item) => String(item.code));
}

export function captureStdoutJson(run: () => void): JsonMap {
  const writes: string[] = [];
  const savedWrite = process.stdout.write;
  process.stdout.write = ((chunk: any) => {
    writes.push(String(chunk));
    return true;
  }) as typeof process.stdout.write;
  try {
    run();
  } finally {
    process.stdout.write = savedWrite;
  }
  return JSON.parse(writes.join(""));
}

export function captureStdoutText(run: () => void): string {
  const writes: string[] = [];
  const savedWrite = process.stdout.write;
  process.stdout.write = ((chunk: any) => {
    writes.push(String(chunk));
    return true;
  }) as typeof process.stdout.write;
  try {
    run();
  } finally {
    process.stdout.write = savedWrite;
  }
  return writes.join("");
}

export function captureMain(argv: string[]): { exitCode: number; stdout: string } {
  let exitCode = 0;
  const stdout = captureStdoutText(() => {
    exitCode = guard.main(argv);
  });
  return { exitCode, stdout };
}

export function captureMainJson(argv: string[]): { exitCode: number; payload: JsonMap } {
  const { exitCode, stdout } = captureMain(argv);
  return { exitCode, payload: JSON.parse(stdout) };
}

export function assertSafeOutputHasNoLeaks(text: string): void {
  const forbiddenPatterns: RegExp[] = [
    /needs_user_decision/iu,
    /user_review_decision/iu,
    /main_review_digest/iu,
    /decision_scope_key/iu,
    /finding_uid/iu,
    /needs_user_decision_pending/iu,
    /unknown_gate/iu,
    /explore_complete/iu,
    /check-enter/iu,
    /raw_secret_gate/iu,
    /raw_secret_reason/iu,
    /AskUserQuestion/u,
    /export\s+function/iu,
    /function\s+foo\s*\(/iu,
    /用户裁决/u,
    /裁决/u,
    /审查指导证据/u,
    /验证审查证据/u,
    /最终测试通过证据/u,
    /主流程最终判断记录/u,
  ];
  for (const pattern of forbiddenPatterns) {
    assert.doesNotMatch(text, pattern, `safe output leaked ${pattern}: ${text}`);
  }
}

export function assertNoForbiddenAgentKeys(value: unknown): void {
  const forbidden = new Set(["gate", "command", "reason_codes", "block_reasons", "workflow_terms_zh", "message", "message_zh"]);
  const visit = (item: unknown): void => {
    if (Array.isArray(item)) {
      for (const child of item) visit(child);
      return;
    }
    if (!item || typeof item !== "object") return;
    for (const [key, child] of Object.entries(item as JsonMap)) {
      assert.equal(forbidden.has(key), false, `agent output leaked key ${key}`);
      visit(child);
    }
  };
  visit(value);
}


export function walkFiles(root: string): string[] {
  const out: string[] = [];
  if (!existsSync(root)) return out;
  for (const name of readdirSync(root)) {
    const path = join(root, name);
    const st = statSync(path);
    if (st.isDirectory()) out.push(...walkFiles(path));
    else if (st.isFile()) out.push(path);
  }
  return out;
}

export type Fixture = {
  tmp: string;
  repo: string;
  change: string;
  cleanup: () => void;
};

export function installOpenspecSkills(repo: string): void {
  const skillsRoot = join(repo, ".codex", "skills");
  for (const name of guard.REQUIRED_OPENSPEC_CODEX_SKILLS) {
    writeText(join(skillsRoot, name, "SKILL.md"), `---\nname: ${name}\n---\n`);
  }
  for (const name of guard.REQUIRED_SUPERSPEC_WORKFLOW_SKILLS) {
    writeText(join(skillsRoot, name, "SKILL.md"), `---\nname: ${name}\n---\n`);
  }
}

export function installSuperSpecAgents(repo: string): void {
  const agentsRoot = join(repo, ".codex", "agents");
  for (const name of guard.REQUIRED_SUPERSPEC_AGENT_ROLES) {
    writeText(join(agentsRoot, `${name}.toml`), `name = "${name}"\ndescription = "test ${name}"\n`);
  }
  const promptsRoot = join(repo, ".codex", "prompts");
  for (const name of guard.REQUIRED_SUPERSPEC_AGENT_ROLES) {
    writeText(join(promptsRoot, `${name}.md`), `# ${name}\n\nTest prompt for ${name}.\n`);
  }
}

export function createFixture(): Fixture {
  const tmp = mkdtempSync(join(tmpdir(), "superspec-"));
  const repo = tmp;
  spawnSync("git", ["init"], { cwd: repo, stdio: "ignore" });
  const change = join(repo, "openspec", "changes", "demo-change");
  mkdirp(change);
  installOpenspecSkills(repo);
  installSuperSpecAgents(repo);
  const savedRuntime = { ...guard.runtime };
  guard.runtime.openspec_cli_capability_reasons = () => [];
  guard.runtime.openspec_validate = () => [true, "valid"];
  guard.runtime.review_diff_paths = () => ["tasks.md"];
  return {
    tmp,
    repo,
    change,
    cleanup: () => {
      Object.assign(guard.runtime, savedRuntime);
      rmSync(tmp, { recursive: true, force: true });
    },
  };
}

// FIX-10: redEvidence/greenEvidence need the live fixture to lazily write their default raw
// log without changing 90 call sites; tests run with concurrency:false so this is safe.
export let activeFixture: Fixture | null = null;

export function withFixture(name: string, fn: (fx: Fixture) => void | Promise<void>): void {
  test(name, { concurrency: false }, async () => {
    const fx = createFixture();
    activeFixture = fx;
    try {
      await fn(fx);
    } finally {
      activeFixture = null;
      fx.cleanup();
    }
  });
}

export function withRuntime<T>(overrides: JsonMap, fn: () => T): T {
  const saved: JsonMap = {};
  for (const key of Object.keys(overrides)) saved[key] = guard.runtime[key];
  Object.assign(guard.runtime, overrides);
  try {
    return fn();
  } finally {
    Object.assign(guard.runtime, saved);
  }
}

export function waitForChild(proc: ReturnType<typeof spawn>): Promise<{ code: number | null; signal: NodeJS.Signals | null; stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    let stdout = "";
    let stderr = "";
    proc.stdout?.setEncoding("utf8");
    proc.stderr?.setEncoding("utf8");
    proc.stdout?.on("data", (chunk) => {
      stdout += chunk;
    });
    proc.stderr?.on("data", (chunk) => {
      stderr += chunk;
    });
    proc.on("error", reject);
    proc.on("close", (code, signal) => {
      resolve({ code, signal, stdout, stderr });
    });
  });
}

export async function waitForCondition(check: () => boolean, timeoutMs: number, stepMs = 20): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (check()) return;
    await new Promise((resolve) => setTimeout(resolve, stepMs));
  }
  throw new Error(`condition not met within ${timeoutMs}ms`);
}

export function status(fx: Fixture, statuses: Record<string, string> = {}): JsonMap {
  const artifacts = ["proposal", "specs", "design", "tasks"].map((name) => ({
    id: name,
    status: statuses[name] ?? "done",
    missingDeps: [],
  }));
  return {
    changeRoot: fx.change,
    planningHome: { root: fx.repo },
    artifacts,
    applyRequires: ["tasks"],
    schemaName: "spec-driven",
  };
}

export function passEvidence(gate: string, kind = "review", overrides: JsonMap = {}): JsonMap {
  // FIX-7: human_confirmation carries a minimal schema (confirmation_text + confirmed refs).
  const confirmationDefaults: JsonMap = kind === "human_confirmation"
    ? {
      created_by: "user",
      confirmation_text: `human confirmed ${gate}`,
      ...(gate === "branch_handling" ? {} : { confirmed_refs: [`${gate}-confirmed`] }),
    }
    : {};
  return {
    schema_version: 1,
    evidence_id: `EV-${gate}`,
    change_id: "demo-change",
    gate,
    kind,
    created_at: "2026-06-08T00:00:00Z",
    created_by: "test",
    status: "pass",
    ...confirmationDefaults,
    ...overrides,
  };
}

export function roleEvidence(fx: Fixture, gate: string, role: string, overrides: JsonMap = {}): JsonMap {
  const evidenceKind = typeof overrides.kind === "string" && overrides.kind ? overrides.kind : "review";
  const outputRef = overrides.output_ref ?? `.superspec/reports/${gate}-${role}-${evidenceKind}.md`;
  const sourceAnchors = overrides.source_anchors ?? [];
  // FIX-9: prompt_ref must be readable/non-empty; write the default prompt unless the test overrides it.
  const promptRef = overrides.prompt_ref ?? `.superspec/reports/${gate}-${role}-prompt.md`;
  if (overrides.prompt_ref === undefined) writeText(join(fx.change, promptRef), `${role} prompt for ${gate}\n`);
  const localOverrides = { ...overrides };
  delete localOverrides.output_ref;
  delete localOverrides.source_anchors;
  delete localOverrides.prompt_ref;
  writeText(join(fx.change, outputRef), `${role} pass\n`);
  let targetRefs = localOverrides.target_refs;
  delete localOverrides.target_refs;
  if (targetRefs === undefined) {
    const gateArtifactRel: Record<string, string> = {
      explore_complete: ".superspec/artifacts/discovery.md",
      design_complete: "design.md",
      invariants_reviewed: ".superspec/artifacts/business-invariants.md",
      test_contract_drafted: ".superspec/artifacts/test-contract.md",
    };
    const artifactRel = gateArtifactRel[gate];
    const artifactTarget = artifactRel ? join(fx.change, artifactRel) : "";
    if (artifactRel && existsSync(artifactTarget)) {
      targetRefs = [{ path: artifactRel, blob_sha: guard.file_blob_sha(artifactTarget) }];
    } else {
      const target = join(fx.change, `${gate}-${role}-${evidenceKind}-target.md`);
      writeText(target, `${gate} ${role} target\n`);
      targetRefs = [{ path: `${gate}-${role}-${evidenceKind}-target.md`, blob_sha: guard.file_blob_sha(target) }];
    }
  }
  return passEvidence(gate, "review", {
    // FIX-9: role-unique default id so multi-role gates do not collide on evidence_id.
    evidence_id: `EV-${gate}-${role}`,
    agent_role: role,
    execution_mode: "native_subagent",
    agent_id: `agent-${role}`,
    prompt_ref: promptRef,
    output_ref: outputRef,
    source_anchors: sourceAnchors,
    target_refs: targetRefs,
    ...localOverrides,
  });
}

export function reviewEvidence(fx: Fixture, role: string, overrides: JsonMap = {}): JsonMap {
  const localOverrides = { ...overrides };
  const sourceTarget = join(fx.change, ".superspec", "artifacts", `review-${role}-source.md`);
  writeText(sourceTarget, `${role} source\n`);
  const sourceRel = relative(fx.repo, sourceTarget);
  const sourceRefs = localOverrides.source_refs ?? [{ path: sourceRel, blob_sha: guard.file_blob_sha(sourceTarget) }];
  delete localOverrides.source_refs;
  const requiredLoadRefs = localOverrides.required_load_refs ?? sourceRefs.slice(0, 1);
  delete localOverrides.required_load_refs;
  const requiredClaimIds = localOverrides.required_claim_ids ?? [`CLAIM-${role.toUpperCase()}-001`];
  delete localOverrides.required_claim_ids;
  let targetRefs = localOverrides.target_refs;
  delete localOverrides.target_refs;
  if (targetRefs === undefined) {
    const target = join(fx.change, `review_complete-${role}-target.md`);
    writeText(target, `${role} target\n`);
    targetRefs = [{ path: relative(fx.repo, target), blob_sha: guard.file_blob_sha(target) }];
  }
  const blockingFindings = localOverrides.blocking_findings ?? [];
  delete localOverrides.blocking_findings;
  const nonBlockingFindings = localOverrides.non_blocking_findings ?? [];
  delete localOverrides.non_blocking_findings;
  const findingDispositions = localOverrides.finding_dispositions
    ?? blockingFindings.map((item: JsonMap) => ({
      finding_id: item.finding_id,
      recommendation: "fix",
      rationale: "Fix before allow",
    }));
  delete localOverrides.finding_dispositions;
  return roleEvidence(fx, "review_complete", role, {
    evidence_id: localOverrides.evidence_id ?? `EV-${role}-guidance`,
    kind: "source_guidance",
    target_refs: targetRefs,
    source_refs: sourceRefs,
    required_load_refs: requiredLoadRefs,
    required_claim_ids: requiredClaimIds,
    base_ref: "base-sha",
    head_ref: "head-sha",
    reviewed_files: ["tasks.md"],
    rollback_targets: ["tasks.md"],
    blocking_findings: blockingFindings,
    non_blocking_findings: nonBlockingFindings,
    finding_dispositions: findingDispositions,
    ...localOverrides,
  });
}

export function reviewGuidanceEvidences(fx: Fixture, overrides: JsonMap = {}): JsonMap[] {
  const laneOverrides = overrides.lane_overrides ?? {};
  const reviewedFiles = overrides.reviewed_files ?? ["tasks.md"];
  return [
    reviewEvidence(fx, "code-reviewer", {
      evidence_id: "EV-code-reviewer-guidance",
      reviewed_files: reviewedFiles,
      ...laneOverrides["code-reviewer"],
    }),
    reviewEvidence(fx, "architect", {
      evidence_id: "EV-architect-guidance",
      reviewed_files: reviewedFiles,
      ...laneOverrides.architect,
    }),
  ];
}

export function legacyCodeReviewWorkflowEvidence(fx: Fixture): JsonMap {
  const synthesisRef = ".superspec/reports/review-complete-code-review.md";
  const laneRefs = {
    "code-reviewer": ".superspec/reports/review-complete-code-reviewer.md",
    architect: ".superspec/reports/review-complete-architect.md",
  };
  writeText(join(fx.change, synthesisRef), "code-review synthesis pass\n");
  for (const laneRef of Object.values(laneRefs)) writeText(join(fx.change, laneRef), "lane pass\n");
  return passEvidence("review_complete", "workflow_review", {
    workflow: "code-review",
    execution_mode: "workflow",
    output_ref: synthesisRef,
    lane_refs: laneRefs,
    final_verdict: "APPROVE",
    architectural_status: "CLEAR",
    base_ref: "base-sha",
    head_ref: "head-sha",
    reviewed_files: ["tasks.md"],
    rollback_targets: ["tasks.md"],
  });
}

export function mainAdjudication(fx: Fixture, guidance: JsonMap[], overrides: JsonMap = {}): JsonMap {
  const outputRef = overrides.output_ref ?? ".superspec/reports/review-complete-main-adjudication.md";
  writeText(join(fx.change, outputRef), "main adjudication\n");
  const localOverrides = { ...overrides };
  delete localOverrides.output_ref;
  const reviewDecision = localOverrides.review_decision ?? "allow";
  delete localOverrides.review_decision;
  const sourceEvidenceRefs = localOverrides.source_evidence_refs ?? guidance.map((ev) => ev.evidence_id);
  delete localOverrides.source_evidence_refs;
  const verificationEvidenceRefs = localOverrides.verification_evidence_refs ?? (reviewDecision === "request_changes" ? [] : ["EV-verifier-verification", "EV-critic-verification", "EV-final-test"]);
  delete localOverrides.verification_evidence_refs;
  const requiredLoads = guidance.flatMap((ev) => Array.isArray(ev.required_load_refs) ? ev.required_load_refs : []);
  const loadedRefs = localOverrides.loaded_refs ?? requiredLoads.map((refItem: JsonMap) => ({ ...refItem }));
  delete localOverrides.loaded_refs;
  const claimAdjudications = localOverrides.claim_adjudications ?? guidance
    .flatMap((ev) => Array.isArray(ev.required_claim_ids) ? ev.required_claim_ids : [])
    .map((claimId: string) => ({ claim_id: claimId, decision: "accept", rationale: "accepted" }));
  delete localOverrides.claim_adjudications;
  const findingAdjudications = localOverrides.finding_adjudications ?? guidance
    .flatMap((ev) => Array.isArray(ev.blocking_findings) ? ev.blocking_findings : [])
    .map((item: JsonMap) => ({ finding_id: item.finding_id, decision: "accepted_fixed", rationale: "fixed" }));
  delete localOverrides.finding_adjudications;
  const blockingSourceEvidenceRefs = localOverrides.blocking_source_evidence_refs ?? [];
  delete localOverrides.blocking_source_evidence_refs;
  const reopenTaskIds = localOverrides.reopen_task_ids ?? [];
  delete localOverrides.reopen_task_ids;
  return passEvidence("review_complete", "main_adjudication", {
    evidence_id: localOverrides.evidence_id ?? "EV-main-adjudication",
    created_by: "main-thread",
    execution_mode: "direct",
    output_ref: outputRef,
    source_evidence_refs: sourceEvidenceRefs,
    verification_evidence_refs: verificationEvidenceRefs,
    loaded_refs: loadedRefs,
    claim_adjudications: claimAdjudications,
    finding_adjudications: findingAdjudications,
    blocking_source_evidence_refs: blockingSourceEvidenceRefs,
    reopen_task_ids: reopenTaskIds,
    review_decision: reviewDecision,
    ...localOverrides,
  });
}

export function verifyEvidence(fx: Fixture, role: string, overrides: JsonMap = {}): JsonMap {
  const createRefs = overrides.create_refs ?? true;
  const localOverrides = { ...overrides };
  delete localOverrides.create_refs;
  const gate = localOverrides.gate ?? "review_complete";
  delete localOverrides.gate;
  const fields = {
    kind: "verification_review",
    openspec_validate_ref: ".superspec/raw/openspec-validate.txt",
    task_matrix_ref: ".superspec/reports/task-matrix.md",
    invariant_matrix_ref: ".superspec/reports/invariant-matrix.md",
    scope_drift_ref: ".superspec/reports/scope-drift.md",
    test_evidence_refs: ["EV-final-test"],
    scope_drift: "none",
    ...localOverrides,
  };
  if (createRefs) {
    for (const key of ["openspec_validate_ref", "task_matrix_ref", "invariant_matrix_ref", "scope_drift_ref"]) {
      const ref = fields[key as keyof typeof fields];
      if (typeof ref !== "string") continue;
      writeText(join(fx.change, ref), key === "invariant_matrix_ref" ? invariantMatrixText() : `${key}: pass\n`);
    }
  }
  return roleEvidence(fx, gate, role, {
    evidence_id: localOverrides.evidence_id ?? `EV-${role}-verification`,
    ...fields,
  });
}

// FIX-10: test_run schema requires readable raw_log_refs whose content names the claimed
// test_id. Appends to the shared default run log so every test id claimed in a fixture stays
// greppable; created lazily so init/sidecar lazy-creation tests keep a pristine .superspec.
export const DEFAULT_RUN_LOG = ".superspec/raw/test-run.log";

export function defaultRunLog(testId: string): string {
  if (activeFixture !== null) {
    const target = join(activeFixture.change, DEFAULT_RUN_LOG);
    const line = `test run output: ${testId} executed\n`;
    const existing = existsSync(target) ? readFileSync(target, "utf8") : "";
    if (!existing.includes(line)) writeText(target, existing + line);
  }
  return DEFAULT_RUN_LOG;
}

export function redEvidence(taskId = "TASK-001", testId = "TEST-001", invariantRefs: string[] = ["INV-001"], overrides: JsonMap = {}): JsonMap {
  return passEvidence("task_edit", "test_run", {
    task_id: taskId,
    test_id: testId,
    invariant_refs: invariantRefs,
    semantic_status: "expected_failure",
    // FIX-10: test_run schema requires run-level log refs and a summary.
    raw_log_refs: [defaultRunLog(testId)],
    result_summary: `RED run for ${testId}`,
    ...overrides,
  });
}

export function greenEvidence(taskId = "TASK-001", testId = "TEST-001", invariantRefs: string[] = ["INV-001"], overrides: JsonMap = {}): JsonMap {
  return passEvidence("task_complete", "test_run", {
    task_id: taskId,
    test_id: testId,
    invariant_refs: invariantRefs,
    semantic_status: "expected_success",
    // FIX-10: test_run schema requires run-level log refs and a summary.
    raw_log_refs: [defaultRunLog(testId)],
    result_summary: `GREEN run for ${testId}`,
    ...overrides,
  });
}

export function taskReopenEvidence(fx: Fixture, overrides: JsonMap = {}): JsonMap {
  const localOverrides = { ...overrides };
  const taskId = localOverrides.task_id ?? "TASK-001";
  delete localOverrides.task_id;
  const tasksPath = join(fx.change, "tasks.md");
  const beforeText = readFileSync(tasksPath, "utf8");
  const afterText = beforeText.replace(`- [x] ${taskId}`, `- [ ] ${taskId}`);
  assert.notEqual(afterText, beforeText, `task ${taskId} must start as checked for reopen fixture`);
  return passEvidence("task_reopen", "task_reopen", {
    evidence_id: localOverrides.evidence_id ?? "EV-task-reopen",
    reopen_id: localOverrides.reopen_id ?? "reopen-001",
    source_adjudication_evidence_id: localOverrides.source_adjudication_evidence_id ?? "EV-main-adjudication",
    source_guidance_evidence_id: localOverrides.source_guidance_evidence_id ?? "EV-code-reviewer-guidance",
    task_id: taskId,
    violated_test_ids: localOverrides.violated_test_ids ?? ["TEST-001"],
    violated_requirement_refs: localOverrides.violated_requirement_refs ?? [],
    invalidated_completion_evidence_ids: localOverrides.invalidated_completion_evidence_ids ?? ["EV-old-green"],
    required_supersede_evidence_ids: localOverrides.required_supersede_evidence_ids ?? ["EV-old-green"],
    completion_invalidity_class: localOverrides.completion_invalidity_class ?? "insufficient_completion_evidence",
    scope_expansion: localOverrides.scope_expansion ?? false,
    why_completion_invalid: localOverrides.why_completion_invalid ?? "behavior evidence insufficient",
    required_fix: localOverrides.required_fix ?? "rebuild behavior evidence",
    before_tasks_sha256: localOverrides.before_tasks_sha256 ?? guard.sha256_text(beforeText),
    after_tasks_sha256: localOverrides.after_tasks_sha256 ?? guard.sha256_text(afterText),
    ...localOverrides,
  });
}

export function taskReopenResolvedEvidence(fx: Fixture, overrides: JsonMap = {}): JsonMap {
  const localOverrides = { ...overrides };
  const taskId = localOverrides.task_id ?? "TASK-001";
  delete localOverrides.task_id;
  const tasksPath = join(fx.change, "tasks.md");
  const tasksText = readFileSync(tasksPath, "utf8");
  return passEvidence("task_reopen", "task_reopen_resolved", {
    evidence_id: localOverrides.evidence_id ?? "EV-task-reopen-resolved",
    reopen_evidence_id: localOverrides.reopen_evidence_id ?? "EV-task-reopen",
    reopen_id: localOverrides.reopen_id ?? "reopen-001",
    task_id: taskId,
    successor_completion_evidence_ids: localOverrides.successor_completion_evidence_ids ?? ["EV-green-successor"],
    after_tasks_sha256: localOverrides.after_tasks_sha256 ?? guard.sha256_text(tasksText),
    ...localOverrides,
  });
}

export function supersededEvidence(targetEvidenceId: string, overrides: JsonMap = {}): JsonMap {
  return passEvidence("task_reopen", "superseded", {
    evidence_id: overrides.evidence_id ?? `EV-superseded-${targetEvidenceId}`,
    status: "superseded",
    supersedes: targetEvidenceId,
    // FIX-6: cross-gate supersede requires explicit authorization.
    supersede_reason: overrides.supersede_reason ?? "task reopen invalidated prior completion evidence",
    ...overrides,
  });
}

export function alternativeVerificationEvidence(taskId = "TASK-001", overrides: JsonMap = {}): JsonMap {
  return passEvidence("task_complete", overrides.kind ?? "alternative_verification", {
    task_id: taskId,
    ...overrides,
  });
}

export function reopenBlockingFinding(taskId = "TASK-001", overrides: JsonMap = {}): JsonMap {
  return {
    finding_id: overrides.finding_id ?? `F-${taskId}-REOPEN`,
    severity: overrides.severity ?? "HIGH",
    affected_task_ids: overrides.affected_task_ids ?? [taskId],
    violated_test_ids: overrides.violated_test_ids ?? ["TEST-001"],
    violated_requirement_refs: overrides.violated_requirement_refs ?? [],
    why_completion_invalid: overrides.why_completion_invalid ?? "behavior evidence insufficient",
    required_fix: overrides.required_fix ?? "rebuild behavior evidence",
    completion_invalidity_class: overrides.completion_invalidity_class ?? "insufficient_completion_evidence",
    scope_expansion: overrides.scope_expansion ?? false,
    reopen_recommendation: overrides.reopen_recommendation ?? true,
    ...overrides,
  };
}

export function finalTestEvidence(fx: Fixture, overrides: JsonMap = {}): JsonMap {
  const outputRef = overrides.output_ref ?? ".superspec/raw/final-test.log";
  writeText(join(fx.change, outputRef), "final test pass\n");
  return passEvidence("review_complete", "final_test", {
    evidence_id: "EV-final-test",
    test_command: "test",
    output_ref: outputRef,
    semantic_status: "expected_success",
    ...overrides,
  });
}

export function archiveReadyEvidences(fx: Fixture): JsonMap[] {
  const guidance = [
    ...reviewGuidanceEvidences(fx),
    reviewEvidence(fx, "critic"),
  ];
  return [
    ...prepareProposeComplete(fx, {
      checked: true,
      tasksText:
        "- [x] TASK-001 Implement\n" +
        "  - invariant_refs: INV-001\n" +
        "  - test_refs: TEST-001\n" +
        "  - tdd_required: false\n" +
        "  - no_tdd_reason: non-executable-spec-change\n",
    }),
    alternativeVerificationEvidence("TASK-001"),
    ...guidance,
    mainAdjudication(fx, guidance),
    verifyEvidence(fx, "verifier"),
    verifyEvidence(fx, "critic"),
    finalTestEvidence(fx),
    passEvidence("archive_ready", "human_confirmation"),
  ];
}

export function reopenGuidanceEvidences(fx: Fixture): JsonMap[] {
  return reviewGuidanceEvidences(fx, {
    lane_overrides: {
      "code-reviewer": {
        blocking_findings: [
          reopenBlockingFinding("TASK-001", { finding_id: "FINDING-REOPEN-001" }),
        ],
      },
    },
  });
}

export function taskReopenReadyEvidences(fx: Fixture): JsonMap[] {
  const guidance = [
    ...reopenGuidanceEvidences(fx),
    reviewEvidence(fx, "critic"),
  ];
  return [
    ...prepareProposeComplete(fx, { checked: true }),
    ...guidance,
    mainAdjudication(fx, guidance, {
      review_decision: "request_changes",
      request_changes_route: "reopen_tasks",
      blocking_source_evidence_refs: ["EV-code-reviewer-guidance"],
      reopen_task_ids: ["TASK-001"],
      verification_evidence_refs: [],
    }),
    taskReopenEvidence(fx),
  ];
}

export function businessInvariantsText(id = "INV-001", overrides: JsonMap = {}): string {
  const confidence = overrides.confidence ?? "source-backed";
  const enforcement = overrides.enforcement_level ?? "automated-test";
  const verification = overrides.verification ?? "automated-test";
  const createdAfterImplementation = overrides.created_after_implementation ?? "false";
  return [
    "# 业务不变量",
    "",
    "## Invariants",
    "",
    "| INV-ID | statement | scope | source_anchors | acceptance_refs | risk_refs | confidence | enforcement_level | test_refs_or_review_only_reason | verification | risk_if_broken | invalidation_triggers | created_after_implementation |",
    "|---|---|---|---|---|---|---|---|---|---|---|---|---|",
    `| ${id} | Stable business rule | attendance | specs/attendance/spec.md | REQ-001 | RISK-001 | ${confidence} | ${enforcement} | TEST-001 | ${verification} | regression | source changes | ${createdAfterImplementation} |`,
    "",
  ].join("\n");
}

export function testContractText(testId = "TEST-001", scenario = "Scenario A", invariantRefs = "INV-001"): string {
  return testContractRowsText([{ test_id: testId, scenario, invariant_refs: invariantRefs }]);
}

export function testContractRowsText(rows: Array<{ test_id: string; scenario: string; invariant_refs: string }>): string {
  return [
    "## 测试覆盖矩阵",
    "",
    "| TEST-ID | 关联 REQ/Scenario | 关联 INV | 维度 | 测试意图（断言什么行为） | 预期 RED 原因 |",
    "|---|---|---|---|---|---|",
    ...rows.map((row) => `| ${row.test_id} | ${row.scenario} | ${row.invariant_refs} | 正常路径 | behavior | expected failure |`),
    "",
  ].join("\n");
}

export function invariantMatrixText(rows: Array<{ inv_id?: string; status?: string; evidence?: string }> = [{}]): string {
  return [
    "| INV-ID | status | evidence | gap |",
    "|---|---|---|---|",
    ...rows.map((row) => `| ${row.inv_id ?? "INV-001"} | ${row.status ?? "pass"} | ${row.evidence ?? "EV-final-test"} | none |`),
    "",
  ].join("\n");
}

// DISC Phase 2: proposal_reviewed is a born-disclosure gate, so every fixture that needs the
// propose chain records a round-tagged critic review plus a clean round-1 digest pinning
// proposal.md + discovery.md.
export function proposalReviewedEvidences(fx: Fixture): JsonMap[] {
  const proposalPath = join(fx.change, "proposal.md");
  if (!existsSync(proposalPath)) writeText(proposalPath, "proposal\n");
  const discoveryPath = join(fx.change, ".superspec", "artifacts", "discovery.md");
  if (!existsSync(discoveryPath)) writeText(discoveryPath, "discovery\n");
  const targets = [
    { path: "proposal.md", blob_sha: guard.file_blob_sha(proposalPath) },
    { path: ".superspec/artifacts/discovery.md", blob_sha: guard.file_blob_sha(discoveryPath) },
  ];
  return [
    roleEvidence(fx, "proposal_reviewed", "critic", {
      evidence_id: "EV-proposal-r1-critic",
      review_round_id: "proposal_reviewed-r1",
      output_ref: ".superspec/reports/proposal-r1-critic.md",
      findings: [],
      target_refs: targets,
    }),
    passEvidence("proposal_reviewed", "main_review_digest", {
      evidence_id: "EV-proposal-r1-digest",
      created_by: "main-thread",
      review_round_id: "proposal_reviewed-r1",
      target_refs: targets,
      source_review_evidence_refs: ["EV-proposal-r1-critic"],
      previous_digest_refs: [],
      finding_dispositions: [],
    }),
  ];
}

export function prepareProposeComplete(fx: Fixture, opts: { checked?: boolean; testContract?: string; tasksText?: string } = {}): JsonMap[] {
  const artifacts = join(fx.change, ".superspec", "artifacts");
  mkdirp(artifacts);
  writeText(join(artifacts, "discovery.md"), "discovery\n");
  writeText(join(artifacts, "business-invariants.md"), businessInvariantsText());
  writeText(join(artifacts, "test-contract.md"), opts.testContract ?? testContractText());
  writeText(join(fx.change, "specs", "attendance", "spec.md"), "#### Scenario: Scenario A\n");
  writeText(join(fx.change, "design.md"), "design\n");
  const marker = opts.checked ? "x" : " ";
  writeText(
    join(fx.change, "tasks.md"),
    opts.tasksText ??
      (`- [${marker}] TASK-001 Implement\n` +
        "  - invariant_refs: INV-001\n" +
        "  - test_refs: TEST-001\n"),
  );
  return [
    roleEvidence(fx, "explore_complete", "critic"),
    passEvidence("explore_complete", "human_confirmation"),
    ...proposalReviewedEvidences(fx),
    roleEvidence(fx, "design_complete", "architect"),
    roleEvidence(fx, "design_complete", "critic"),
    roleEvidence(fx, "design_complete", "test-engineer"),
    passEvidence("design_complete", "human_confirmation"),
    roleEvidence(fx, "invariants_reviewed", "critic"),
    roleEvidence(fx, "invariants_reviewed", "test-engineer"),
    roleEvidence(fx, "test_contract_drafted", "test-engineer"),
    roleEvidence(fx, "test_contract_drafted", "critic"),
    // FIX-8: apply-phase gates require a user-confirmed isolation choice pinning tasks.md structure.
    passEvidence("apply_isolation", "human_confirmation", {
      evidence_id: "EV-apply-isolation",
      confirmation_text: "user chose worktree isolation and serial execution",
      tasks_structure_hash: guard.tasks_structure_hash(fx.change),
    }),
  ];
}

export function setTaskCheckbox(changeRoot: string, taskId: string, checked: boolean): void {
  const tasksPath = join(changeRoot, "tasks.md");
  const before = readFileSync(tasksPath, "utf8");
  const after = before.replace(`- [${checked ? " " : "x"}] ${taskId}`, `- [${checked ? "x" : " "}] ${taskId}`);
  assert.notEqual(after, before, `task ${taskId} checkbox replacement failed`);
  writeText(tasksPath, after);
}


export const EXPLORE_ONLY_STATUS = { proposal: "blocked", specs: "blocked", design: "blocked", tasks: "blocked" };
export const DISCOVERY_REL = ".superspec/artifacts/discovery.md";

export function writeDiscovery(fx: Fixture, text = "discovery facts v1\n"): void {
  writeText(join(fx.change, ".superspec", "artifacts", "discovery.md"), text);
}

export function discoveryBlob(fx: Fixture): string {
  return guard.file_blob_sha(join(fx.change, ".superspec", "artifacts", "discovery.md"));
}

export function exploreCheck(fx: Fixture, evidences: JsonMap[]): JsonMap {
  return guard.check_superspec_gate("demo-change", status(fx, EXPLORE_ONLY_STATUS), fx.change, evidences, "explore_complete");
}

export function exploreConfirmedEvidences(fx: Fixture): JsonMap[] {
  return [
    roleEvidence(fx, "explore_complete", "critic"),
    passEvidence("explore_complete", "human_confirmation"),
  ];
}

export function discSchemaCodes(fx: Fixture, evidences: JsonMap[]): string[] {
  return codes(guard.evidence_schema_guard("demo-change", fx.change, fx.repo, evidences));
}

export function exploreFinding(round = 1, overrides: JsonMap = {}): JsonMap {
  const base: JsonMap = {
    finding_id: "EXP-SCOPE-001",
    finding_type: "blocker",
    category: "scope",
    material_categories: ["scope"],
    decision_scope_key: "demo-change:explore:rollout-scope",
    summary: "discovery scope is ambiguous about rollout boundaries",
    requires_user_decision: true,
    ...overrides,
  };
  if (base.finding_uid === undefined) base.finding_uid = `explore_complete:EV-explore-r${round}-critic:${base.finding_id}`;
  return base;
}

export function exploreRoundReview(fx: Fixture, round: number, findings: JsonMap[], overrides: JsonMap = {}): JsonMap {
  return roleEvidence(fx, "explore_complete", "critic", {
    evidence_id: `EV-explore-r${round}-critic`,
    review_round_id: `explore_complete-r${round}`,
    output_ref: `.superspec/reports/explore-r${round}-critic.md`,
    findings,
    ...overrides,
  });
}

export function exploreRoundPrompt(fx: Fixture, round: number, priorEvidences: JsonMap[]): string {
  const rel = `.superspec/reports/explore-r${round}-critic-prompt.md`;
  const ledger = guard.render_finding_ledger(
    "explore_complete",
    guard.build_finding_ledger("explore_complete", priorEvidences, round),
  );
  writeText(join(fx.change, rel), `critic prompt for explore round ${round}\n\n${ledger}\n`);
  return rel;
}

export function exploreDigest(fx: Fixture, round: number, dispositions: JsonMap[], overrides: JsonMap = {}): JsonMap {
  return passEvidence("explore_complete", "main_review_digest", {
    evidence_id: `EV-explore-r${round}-digest`,
    created_by: "main-thread",
    review_round_id: `explore_complete-r${round}`,
    target_refs: [{ path: DISCOVERY_REL, blob_sha: discoveryBlob(fx) }],
    source_review_evidence_refs: [`EV-explore-r${round}-critic`],
    previous_digest_refs: round > 1 ? [`EV-explore-r${round - 1}-digest`] : [],
    finding_dispositions: dispositions,
    ...overrides,
  });
}

export function dispositionOf(finding: JsonMap, overrides: JsonMap = {}): JsonMap {
  return {
    finding_id: finding.finding_id,
    finding_uid: finding.finding_uid,
    origin_review_evidence_id: String(finding.finding_uid).split(":")[1],
    finding_type: finding.finding_type,
    category: finding.category,
    material_categories: finding.material_categories ?? [],
    decision_scope_key: finding.decision_scope_key ?? "",
    summary: finding.summary,
    disposition: "needs_user_decision",
    rationale: "material finding routed to user confirmation",
    route: "stay_same_gate_user_decision",
    route_reason: "material scope finding requires user confirmation",
    ...overrides,
  };
}

export function userDecision(fx: Fixture, finding: JsonMap, overrides: JsonMap = {}): JsonMap {
  return passEvidence("explore_complete", "user_review_decision", {
    evidence_id: "EV-user-decision-1",
    created_by: "user",
    review_round_id: "explore_complete-r1",
    decision: "option_a",
    finding_uids: [finding.finding_uid],
    decision_scope_key: finding.decision_scope_key,
    material_categories: finding.material_categories ?? [],
    confirmed_refs: [{ path: DISCOVERY_REL, blob_sha: discoveryBlob(fx) }],
    ...overrides,
  });
}

export function standingAuth(overrides: JsonMap = {}): JsonMap {
  return passEvidence("explore_complete", "review_standing_authorization", {
    evidence_id: "EV-standing-auth-1",
    created_by: "user",
    confirmation_text: "user authorizes self-serve acceptance of implementation/test_gap deviations in explore",
    allowed_categories: ["implementation", "test_gap"],
    excluded_categories: [],
    valid_gates: ["explore_complete"],
    expires_at: null,
    ...overrides,
  });
}

export function supersedeMarker(targetId: string): JsonMap {
  return passEvidence("explore_complete", "superseded", {
    evidence_id: `EV-supersede-${targetId}`,
    status: "superseded",
    supersedes: targetId,
  });
}


// ── DISC Phase 2: proposal_reviewed internal gate + design_complete disclosure ──

export const PROPOSAL_REL = "proposal.md";

export function writeProposal(fx: Fixture, text = "proposal v1\n"): void {
  writeText(join(fx.change, PROPOSAL_REL), text);
}

export function proposalTargets(fx: Fixture): JsonMap[] {
  return [
    { path: PROPOSAL_REL, blob_sha: guard.file_blob_sha(join(fx.change, PROPOSAL_REL)) },
    { path: DISCOVERY_REL, blob_sha: discoveryBlob(fx) },
  ];
}

export function proposalCheck(fx: Fixture, evidences: JsonMap[]): JsonMap {
  return guard.check_superspec_gate("demo-change", status(fx), fx.change, evidences, "proposal_reviewed");
}

export function proposalFinding(round = 1, overrides: JsonMap = {}): JsonMap {
  const base: JsonMap = {
    finding_id: "PROP-SCOPE-001",
    finding_type: "blocker",
    category: "scope",
    material_categories: ["scope"],
    decision_scope_key: "demo-change:proposal:hidden-scope",
    summary: "proposal silently widens scope beyond discovery",
    ...overrides,
  };
  if (base.finding_uid === undefined) base.finding_uid = `proposal_reviewed:EV-proposal-r${round}-critic:${base.finding_id}`;
  return base;
}

export function proposalRoundReview(fx: Fixture, round: number, findings: JsonMap[], overrides: JsonMap = {}): JsonMap {
  return roleEvidence(fx, "proposal_reviewed", "critic", {
    evidence_id: `EV-proposal-r${round}-critic`,
    review_round_id: `proposal_reviewed-r${round}`,
    output_ref: `.superspec/reports/proposal-r${round}-critic.md`,
    findings,
    target_refs: proposalTargets(fx),
    ...overrides,
  });
}

export function proposalRoundPrompt(fx: Fixture, round: number, priorEvidences: JsonMap[]): string {
  const rel = `.superspec/reports/proposal-r${round}-critic-prompt.md`;
  const ledger = guard.render_finding_ledger(
    "proposal_reviewed",
    guard.build_finding_ledger("proposal_reviewed", priorEvidences, round),
  );
  writeText(join(fx.change, rel), `critic prompt for proposal round ${round}\n\n${ledger}\n`);
  return rel;
}

export function proposalDigest(fx: Fixture, round: number, dispositions: JsonMap[], overrides: JsonMap = {}): JsonMap {
  return passEvidence("proposal_reviewed", "main_review_digest", {
    evidence_id: `EV-proposal-r${round}-digest`,
    created_by: "main-thread",
    review_round_id: `proposal_reviewed-r${round}`,
    target_refs: proposalTargets(fx),
    source_review_evidence_refs: [`EV-proposal-r${round}-critic`],
    previous_digest_refs: round > 1 ? [`EV-proposal-r${round - 1}-digest`] : [],
    finding_dispositions: dispositions,
    ...overrides,
  });
}

export function designTargetRefs(fx: Fixture): JsonMap[] {
  const set = guard.enumerate_review_targets("design_complete", fx.change);
  assert.ok(set, "design target set must be enumerable in this fixture");
  return [...set.entries()].map(([path, blob_sha]) => ({ path, blob_sha }));
}


// ── DISC Phase 3: invariants_reviewed / test_contract_drafted / tasks_complete ──

export function targetRefList(set: Map<string, string>): JsonMap[] {
  return [...set.entries()].map(([path, blob_sha]) => ({ path, blob_sha }));
}

export function gateFinding(gate: string, round: number, evidenceId: string, findingId: string, overrides: JsonMap = {}): JsonMap {
  const base: JsonMap = {
    finding_id: findingId,
    finding_type: "blocker",
    category: "business_semantics",
    material_categories: ["business_semantics"],
    decision_scope_key: "demo-change:invariants:truth",
    summary: "business invariant truth is uncertain and needs user adjudication",
    requires_user_decision: true,
    ...overrides,
  };
  if (base.finding_uid === undefined) base.finding_uid = `${gate}:${evidenceId}:${base.finding_id}`;
  return base;
}

export function roundReviewWithTargets(
  fx: Fixture,
  gate: string,
  role: string,
  round: number,
  targets: Map<string, string>,
  findings: JsonMap[],
  overrides: JsonMap = {},
): JsonMap {
  return roleEvidence(fx, gate, role, {
    evidence_id: `EV-${gate}-r${round}-${role}`,
    review_round_id: `${gate}-r${round}`,
    output_ref: `.superspec/reports/${gate}-r${round}-${role}.md`,
    findings,
    target_refs: targetRefList(targets),
    ...overrides,
  });
}

export function roundDigestWithTargets(
  fx: Fixture,
  gate: string,
  round: number,
  targets: Map<string, string>,
  dispositions: JsonMap[],
  overrides: JsonMap = {},
): JsonMap {
  return passEvidence(gate, "main_review_digest", {
    evidence_id: `EV-${gate}-r${round}-digest`,
    created_by: "main-thread",
    review_round_id: `${gate}-r${round}`,
    target_refs: targetRefList(targets),
    source_review_evidence_refs: [`EV-${gate}-r${round}-critic`],
    previous_digest_refs: round > 1 ? [`EV-${gate}-r${round - 1}-digest`] : [],
    finding_dispositions: dispositions,
    ...overrides,
  });
}

export function proposeChainThroughDesign(fx: Fixture): JsonMap[] {
  return prepareProposeComplete(fx).filter((ev) => !["invariants_reviewed", "test_contract_drafted"].includes(String(ev.gate)));
}
