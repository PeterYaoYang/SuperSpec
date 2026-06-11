import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import test from "node:test";
import {
  copyFileSync,
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

import * as guard from "../superspec_guard.ts";
import { main_init } from "../src/init_cli.ts";
import { reason_message_zh, translate_action_zh } from "../src/i18n.ts";
import { project_init } from "../src/project_init.ts";

type JsonMap = Record<string, any>;

function findRepoRoot(start: string): string {
  let dir = resolve(start);
  while (true) {
    if (existsSync(join(dir, "openspec")) && existsSync(join(dir, ".codex"))) return dir;
    const parent = dirname(dir);
    if (parent === dir) return resolve(start);
    dir = parent;
  }
}

const GUARD_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const REPO_ROOT = findRepoRoot(GUARD_ROOT);
const GUARD_TS = join(GUARD_ROOT, "superspec_guard.ts");
const GUARD_TS_URL = new URL("../superspec_guard.ts", import.meta.url).href;
const INIT_TS = join(GUARD_ROOT, "superspec_init.ts");

function mkdirp(path: string): void {
  mkdirSync(path, { recursive: true });
}

function writeText(path: string, text: string): void {
  mkdirp(dirname(path));
  writeFileSync(path, text, "utf8");
}

function readJson(path: string): JsonMap {
  return JSON.parse(readFileSync(path, "utf8"));
}

function codes(items: JsonMap[] | undefined): string[] {
  return (items ?? []).map((item) => String(item.code));
}

function captureStdoutJson(run: () => void): JsonMap {
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

test("decorateDecision adds Chinese workflow labels without changing reason codes", () => {
  const raw = guard.block("demo-change", "explore_complete", [
    guard.reason("needs_user_decision_pending", "explore_complete: finding is waiting for the user's A/B/C/D decision"),
  ], {
    next_actions: ["rerun check-enter --change demo-change --gate explore_complete"],
  });
  const decorated = guard.decorateDecision(raw, { command: "check-enter" });
  assert.equal(decorated.command_label_zh, "进入阶段前检查");
  assert.equal(decorated.gate_label_zh, "探索完成");
  assert.equal(decorated.decision_zh, "未通过");
  assert.equal(decorated.block_reasons[0].code, "needs_user_decision_pending");
  assert.equal(decorated.block_reasons[0].label_zh, "等待用户确认");
  assert.equal(decorated.next_allowed_actions_zh[0], "重新运行进入阶段前检查。");
  assert.ok(Array.isArray(decorated.workflow_terms_zh));
  assert.ok(decorated.workflow_terms_zh.some((item: JsonMap) => item.term === "check-enter" && item.label_zh === "进入阶段前检查"));
  assert.ok(decorated.workflow_terms_zh.some((item: JsonMap) => item.term === "acceptance" && item.label_zh === "验收标准"));
  assert.ok(decorated.workflow_terms_zh.some((item: JsonMap) => item.term === "user_review_decision" && item.label_zh === "用户确认记录"));
  assert.ok(decorated.workflow_terms_zh.some((item: JsonMap) => item.term === "main_review_digest" && item.label_zh === "审查问题记录"));
});

test("printDecision adds Chinese display fields while preserving machine-readable fields", () => {
  const raw = guard.block("demo-change", "explore_complete", [
    guard.reason("needs_user_decision_pending", "explore_complete: finding is waiting for the user's A/B/C/D decision"),
  ], {
    next_actions: ["fix project_init_failed reasons, then rerun superspec init --scope project"],
  });
  raw.actions = [
    {
      action: "install .codex/skills/superspec-explore/SKILL.md",
      status: "updated",
      detail: "existing file backed up to .codex/skills/superspec-explore/SKILL.md.bak",
    },
  ];
  const printed = captureStdoutJson(() => {
    guard.printDecision(raw, { command: "check-enter" });
  });
  assert.equal(printed.block_reasons[0].code, "needs_user_decision_pending");
  assert.match(printed.block_reasons[0].message, /finding is waiting for the user's A\/B\/C\/D decision/u);
  assert.equal(printed.block_reasons[0].message_zh, "等待用户确认：当前问题需要用户确认，请先选择 A/B/C/D 中的一项。");
  assert.equal(printed.next_allowed_actions[0], "fix project_init_failed reasons, then rerun superspec init --scope project");
  assert.equal(printed.next_allowed_actions_zh[0], "先处理项目初始化失败对应问题，然后重新运行相关命令。");
  assert.match(printed.trust_warnings[0], /audit-only\/self-reported/u);
  assert.match(printed.trust_warnings_zh[0], /审计参考|自报信息/u);
  assert.equal(printed.actions[0].action, "install .codex/skills/superspec-explore/SKILL.md");
  assert.equal(printed.actions[0].action_zh, "安装 .codex/skills/superspec-explore/SKILL.md");
  assert.equal(printed.actions[0].status, "updated");
  assert.equal(printed.actions[0].status_zh, "已更新");
  assert.equal(printed.actions[0].detail, "existing file backed up to .codex/skills/superspec-explore/SKILL.md.bak");
  assert.equal(printed.actions[0].detail_zh, "已有文件已备份到 .codex/skills/superspec-explore/SKILL.md.bak。");
  assert.ok(printed.workflow_terms_zh.some((item: JsonMap) => item.term === "user_review_decision" && item.label_zh === "用户确认记录"));
  assert.ok(printed.workflow_terms_zh.some((item: JsonMap) => item.term === "main_review_digest" && item.label_zh === "审查问题记录"));
});

test("printDecision adds Windows PowerShell cmd shim hints for openspec and superspec commands", () => {
  const raw = guard.block("demo-change", "project_init", [
    guard.reason("openspec_init_missing", "Run `openspec init --tools codex .` and then `superspec init --scope project`."),
  ]);
  const printed = captureStdoutJson(() => {
    guard.printDecision(raw, { command: "init" });
  });
  assert.deepEqual(printed.windows_powershell_command_hints, [
    "Windows PowerShell: use `openspec.cmd init --tools codex .`",
    "Windows PowerShell: use `superspec.cmd init --scope project`",
  ]);
});

test("reason_message_zh rewrites workflow-internal review terms into Chinese explanation", () => {
  const rendered = reason_message_zh("missing_source_guidance", "review_complete requires critic source_guidance evidence");
  assert.match(rendered, /缺少审查指导证据/u);
  assert.match(rendered, /审查完成/u);
  assert.match(rendered, /严格审查/u);
  assert.equal(rendered.includes("source_guidance"), false);
  assert.equal(rendered.includes("review_complete"), false);

  const mixed = reason_message_zh("user_decision_unbound", "用户确认已写入 user_review_decision 但 main_review_digest 未引用 confirmed_refs");
  assert.match(mixed, /用户确认记录/u);
  assert.match(mixed, /审查问题记录/u);
  assert.match(mixed, /已确认内容引用/u);
  assert.equal(mixed.includes("user_review_decision"), false);
  assert.equal(mixed.includes("main_review_digest"), false);
  assert.equal(mixed.includes("confirmed_refs"), false);
});

test("translate_action_zh hides workflow-internal terms in review completion actions", () => {
  assert.equal(
    translate_action_zh("collect review_complete source_guidance from missing roles: critic, verifier"),
    "补齐审查完成所缺的审查指导证据（角色：严格审查、验证审查）。",
  );
  assert.equal(
    translate_action_zh("record final_test pass evidence and reference it from verification_review"),
    "记录最终测试通过证据，并在验证审查证据中引用它。",
  );
});

function walkFiles(root: string): string[] {
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

type Fixture = {
  tmp: string;
  repo: string;
  change: string;
  cleanup: () => void;
};

function installOpenspecSkills(repo: string): void {
  const skillsRoot = join(repo, ".codex", "skills");
  for (const name of guard.REQUIRED_OPENSPEC_CODEX_SKILLS) {
    writeText(join(skillsRoot, name, "SKILL.md"), `---\nname: ${name}\n---\n`);
  }
  for (const name of guard.REQUIRED_SUPERSPEC_WORKFLOW_SKILLS) {
    writeText(join(skillsRoot, name, "SKILL.md"), `---\nname: ${name}\n---\n`);
  }
}

function installSuperSpecAgents(repo: string): void {
  const agentsRoot = join(repo, ".codex", "agents");
  for (const name of guard.REQUIRED_SUPERSPEC_AGENT_ROLES) {
    writeText(join(agentsRoot, `${name}.toml`), `name = "${name}"\ndescription = "test ${name}"\n`);
  }
  const promptsRoot = join(repo, ".codex", "prompts");
  for (const name of guard.REQUIRED_SUPERSPEC_AGENT_ROLES) {
    writeText(join(promptsRoot, `${name}.md`), `# ${name}\n\nTest prompt for ${name}.\n`);
  }
}

function createFixture(): Fixture {
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
let activeFixture: Fixture | null = null;

function withFixture(name: string, fn: (fx: Fixture) => void | Promise<void>): void {
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

function withRuntime<T>(overrides: JsonMap, fn: () => T): T {
  const saved: JsonMap = {};
  for (const key of Object.keys(overrides)) saved[key] = guard.runtime[key];
  Object.assign(guard.runtime, overrides);
  try {
    return fn();
  } finally {
    Object.assign(guard.runtime, saved);
  }
}

function waitForChild(proc: ReturnType<typeof spawn>): Promise<{ code: number | null; signal: NodeJS.Signals | null; stdout: string; stderr: string }> {
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

async function waitForCondition(check: () => boolean, timeoutMs: number, stepMs = 20): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (check()) return;
    await new Promise((resolve) => setTimeout(resolve, stepMs));
  }
  throw new Error(`condition not met within ${timeoutMs}ms`);
}

const LEGACY_MACHINE_STRING_FIELDS = new Set([
  "prompt_ref",
  "output_ref",
  "openspec_validate_ref",
  "task_matrix_ref",
  "invariant_matrix_ref",
  "scope_drift_ref",
]);
const LEGACY_MACHINE_STRING_LIST_FIELDS = new Set([
  "refs",
  "raw_artifact_refs",
  "raw_log_refs",
  "reviewed_files",
  "rollback_targets",
]);
const LEGACY_MACHINE_PATH_OBJECT_LIST_FIELDS = new Set(["target_refs", "loaded_refs", "source_refs", "required_load_refs"]);

function rewriteLegacySidecarString(value: string): string {
  return value.replaceAll(".irsflow/", ".superspec/");
}

function rewriteLegacyJson(value: any, field: string | null = null): any {
  if (Array.isArray(value)) {
    if (field && LEGACY_MACHINE_STRING_LIST_FIELDS.has(field)) return value.map((item) => rewriteLegacySidecarString(String(item)));
    if (field && LEGACY_MACHINE_PATH_OBJECT_LIST_FIELDS.has(field)) {
      return value.map((item) => (
        typeof item === "object" && item !== null && !Array.isArray(item) && typeof item.path === "string"
          ? { ...item, path: rewriteLegacySidecarString(item.path) }
          : item
      ));
    }
    return value.map((item) => rewriteLegacyJson(item, field));
  }
  if (value && typeof value === "object") {
    const out: JsonMap = {};
    for (const [key, nested] of Object.entries(value)) out[key] = rewriteLegacyJson(nested, key);
    if ("irsflow" in out) {
      out.superspec = out.irsflow;
      delete out.irsflow;
    }
    return out;
  }
  if (typeof value === "string" && field && LEGACY_MACHINE_STRING_FIELDS.has(field)) return rewriteLegacySidecarString(value);
  return value;
}

function importLegacyIrsflowFixture(sourceChange: string, destChange: string): void {
  for (const sourcePath of walkFiles(sourceChange)) {
    const rel = relative(sourceChange, sourcePath);
    let destRel = rel.replace(".irsflow/", ".superspec/");
    if (destRel === ".irsflow/irsflow-state.json" || destRel === ".superspec/irsflow-state.json") destRel = ".superspec/superspec-state.json";
    const destPath = join(destChange, destRel);
    mkdirp(dirname(destPath));
    if (sourcePath.endsWith(".json")) {
      const data = rewriteLegacyJson(readJson(sourcePath));
      writeText(destPath, `${JSON.stringify(data, null, 2)}\n`);
    } else {
      copyFileSync(sourcePath, destPath);
    }
  }
}

function status(fx: Fixture, statuses: Record<string, string> = {}): JsonMap {
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

function passEvidence(gate: string, kind = "review", overrides: JsonMap = {}): JsonMap {
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

function roleEvidence(fx: Fixture, gate: string, role: string, overrides: JsonMap = {}): JsonMap {
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

function reviewEvidence(fx: Fixture, role: string, overrides: JsonMap = {}): JsonMap {
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

function reviewGuidanceEvidences(fx: Fixture, overrides: JsonMap = {}): JsonMap[] {
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

function legacyCodeReviewWorkflowEvidence(fx: Fixture): JsonMap {
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

function mainAdjudication(fx: Fixture, guidance: JsonMap[], overrides: JsonMap = {}): JsonMap {
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

function verifyEvidence(fx: Fixture, role: string, overrides: JsonMap = {}): JsonMap {
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
const DEFAULT_RUN_LOG = ".superspec/raw/test-run.log";

function defaultRunLog(testId: string): string {
  if (activeFixture !== null) {
    const target = join(activeFixture.change, DEFAULT_RUN_LOG);
    const line = `test run output: ${testId} executed\n`;
    const existing = existsSync(target) ? readFileSync(target, "utf8") : "";
    if (!existing.includes(line)) writeText(target, existing + line);
  }
  return DEFAULT_RUN_LOG;
}

function redEvidence(taskId = "TASK-001", testId = "TEST-001", invariantRefs: string[] = ["INV-001"], overrides: JsonMap = {}): JsonMap {
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

function greenEvidence(taskId = "TASK-001", testId = "TEST-001", invariantRefs: string[] = ["INV-001"], overrides: JsonMap = {}): JsonMap {
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

function taskReopenEvidence(fx: Fixture, overrides: JsonMap = {}): JsonMap {
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

function taskReopenResolvedEvidence(fx: Fixture, overrides: JsonMap = {}): JsonMap {
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

function supersededEvidence(targetEvidenceId: string, overrides: JsonMap = {}): JsonMap {
  return passEvidence("task_reopen", "superseded", {
    evidence_id: overrides.evidence_id ?? `EV-superseded-${targetEvidenceId}`,
    status: "superseded",
    supersedes: targetEvidenceId,
    // FIX-6: cross-gate supersede requires explicit authorization.
    supersede_reason: overrides.supersede_reason ?? "task reopen invalidated prior completion evidence",
    ...overrides,
  });
}

function alternativeVerificationEvidence(taskId = "TASK-001", overrides: JsonMap = {}): JsonMap {
  return passEvidence("task_complete", overrides.kind ?? "alternative_verification", {
    task_id: taskId,
    ...overrides,
  });
}

function reopenBlockingFinding(taskId = "TASK-001", overrides: JsonMap = {}): JsonMap {
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

function finalTestEvidence(fx: Fixture, overrides: JsonMap = {}): JsonMap {
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

function archiveReadyEvidences(fx: Fixture): JsonMap[] {
  const guidance = [
    ...reviewGuidanceEvidences(fx),
    reviewEvidence(fx, "critic"),
  ];
  return [
    ...prepareProposeComplete(fx, { checked: true }),
    greenEvidence(),
    ...guidance,
    mainAdjudication(fx, guidance),
    verifyEvidence(fx, "verifier"),
    verifyEvidence(fx, "critic"),
    finalTestEvidence(fx),
    passEvidence("archive_ready", "human_confirmation"),
  ];
}

function reopenGuidanceEvidences(fx: Fixture): JsonMap[] {
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

function taskReopenReadyEvidences(fx: Fixture): JsonMap[] {
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

function businessInvariantsText(id = "INV-001", overrides: JsonMap = {}): string {
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

function testContractText(testId = "TEST-001", scenario = "Scenario A", invariantRefs = "INV-001"): string {
  return testContractRowsText([{ test_id: testId, scenario, invariant_refs: invariantRefs }]);
}

function testContractRowsText(rows: Array<{ test_id: string; scenario: string; invariant_refs: string }>): string {
  return [
    "## 测试覆盖矩阵",
    "",
    "| TEST-ID | 关联 REQ/Scenario | 关联 INV | 维度 | 测试意图（断言什么行为） | 预期 RED 原因 |",
    "|---|---|---|---|---|---|",
    ...rows.map((row) => `| ${row.test_id} | ${row.scenario} | ${row.invariant_refs} | 正常路径 | behavior | expected failure |`),
    "",
  ].join("\n");
}

function invariantMatrixText(rows: Array<{ inv_id?: string; status?: string; evidence?: string }> = [{}]): string {
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
function proposalReviewedEvidences(fx: Fixture): JsonMap[] {
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

function prepareProposeComplete(fx: Fixture, opts: { checked?: boolean; testContract?: string; tasksText?: string } = {}): JsonMap[] {
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

function setTaskCheckbox(changeRoot: string, taskId: string, checked: boolean): void {
  const tasksPath = join(changeRoot, "tasks.md");
  const before = readFileSync(tasksPath, "utf8");
  const after = before.replace(`- [${checked ? " " : "x"}] ${taskId}`, `- [${checked ? "x" : " "}] ${taskId}`);
  assert.notEqual(after, before, `task ${taskId} checkbox replacement failed`);
  writeText(tasksPath, after);
}

withFixture("sidecar layout creates required v1 directories", (fx) => {
  guard.ensure_sidecar_layout(fx.change);
  const base = join(fx.change, ".superspec");
  assert.equal(statSync(join(base, "ledger.jsonl")).isFile(), true);
  for (const rel of guard.REQUIRED_SIDECAR_DIRS) {
    assert.equal(statSync(join(base, rel)).isDirectory(), true, rel);
  }
  assert.equal(statSync(join(base, "handoffs")).isDirectory(), true);
  assert.equal(statSync(join(base, "reports")).isDirectory(), true);
  assert.equal(statSync(join(base, "raw")).isDirectory(), true);
});

withFixture("state filename is superspec-state", (fx) => {
  guard.write_state_atomic(fx.change, {
    schema_version: 1,
    change_id: "demo-change",
    guard_version: "test",
  });
  const base = join(fx.change, ".superspec");
  assert.equal(statSync(join(base, "superspec-state.json")).isFile(), true);
  assert.equal(existsSync(join(base, "state.json")), false);
  assert.equal(existsSync(join(base, "state.lock")), false);
  assert.equal(readJson(join(base, "superspec-state.json")).change_id, "demo-change");
});

withFixture("state write CAS blocks on fingerprint mismatch", (fx) => {
  const initial = { schema_version: 1, change_id: "demo-change", computed_from: { openspec_status_fingerprint: "sha256:old" } };
  const replacement = { schema_version: 1, change_id: "demo-change", computed_from: { openspec_status_fingerprint: "sha256:new" } };
  guard.write_state_atomic(fx.change, initial);
  assert.throws(() => guard.write_state_atomic(fx.change, replacement, {
    expected_state_fingerprints: { openspec_status_fingerprint: "sha256:other" },
  }), guard.GuardError);
  assert.equal(readJson(join(fx.change, ".superspec", "superspec-state.json")).computed_from.openspec_status_fingerprint, "sha256:old");
});

withFixture("ledger and state written atomically", (fx) => {
  const initial = { schema_version: 1, change_id: "demo-change", computed_from: { openspec_status_fingerprint: "sha256:old" } };
  const replacement = { schema_version: 1, change_id: "demo-change", computed_from: { openspec_status_fingerprint: "sha256:new" } };
  guard.write_state_atomic(fx.change, initial);
  const ledger = join(fx.change, ".superspec", "ledger.jsonl");
  const beforeLedger = readFileSync(ledger, "utf8");
  assert.throws(() => guard.write_state_atomic(fx.change, replacement, {
    expected_state_fingerprints: { openspec_status_fingerprint: "sha256:other" },
    ledger_event: { change_id: "demo-change", kind: "guard_decision", gate: "x", decision: "allow" },
  }), guard.GuardError);
  assert.equal(readFileSync(ledger, "utf8"), beforeLedger);
  assert.equal(readJson(join(fx.change, ".superspec", "superspec-state.json")).computed_from.openspec_status_fingerprint, "sha256:old");
});

withFixture("project config is optional and uses defaults", (fx) => {
  const [config, problems] = guard.load_config(fx.repo, fx.change);
  assert.deepEqual(problems, []);
  assert.equal(config.preset, "full");
  assert.equal(config.trust.v1_evidence, "audit-only");
});

withFixture("change config overrides project config", (fx) => {
  writeText(join(fx.repo, ".superspec", "config.yaml"), "preset: hotfix\ncommands:\n  test: project-test\n");
  writeText(join(fx.change, ".superspec", "config.yaml"), "preset: tweak\ncommands:\n  test: change-test\n");
  const [config, problems] = guard.load_config(fx.repo, fx.change);
  assert.deepEqual(problems, []);
  assert.equal(config.preset, "tweak");
  assert.equal(config.commands.test, "change-test");
});

withFixture("unknown config key blocks unless x namespace", (fx) => {
  writeText(join(fx.change, ".superspec", "config.yaml"), "unknown: value\nx-local: allowed\n");
  const [, problems] = guard.load_config(fx.repo, fx.change);
  assert.deepEqual(codes(problems), ["unknown_config_key"]);
});

withFixture("config and state aliases are rejected", (fx) => {
  writeText(join(fx.repo, ".superspec.yaml"), "preset: full\n");
  writeText(join(fx.change, ".superspec", "config.json"), "{}\n");
  writeText(join(fx.change, ".superspec", "state.json"), "{}\n");
  const [, problems] = guard.load_config(fx.repo, fx.change);
  assert.deepEqual(codes(problems), ["forbidden_alias_path", "forbidden_alias_path", "forbidden_alias_path"]);
});

withFixture("safe_within rejects absolute parent and symlink escape", (fx) => {
  const outside = join(fx.repo, "outside");
  mkdirp(outside);
  const sidecar = join(fx.change, ".superspec");
  mkdirp(sidecar);
  symlinkSync(outside, join(sidecar, "escape"), "dir");
  assert.equal(guard.safe_within(fx.change, "/tmp/x"), null);
  assert.equal(guard.safe_within(fx.change, "../x"), null);
  assert.equal(guard.safe_within(fx.change, ".superspec/escape/file.txt"), null);
});

withFixture("evidence index skips symlinked and hardlinked evidence entries", (fx) => {
  const outside = join(fx.tmp, "outside-evidence");
  mkdirp(outside);
  writeText(join(outside, "EV-external.json"), `${JSON.stringify(passEvidence("design_complete"), null, 2)}\n`);
  writeText(join(outside, "EV-hardlink.json"), `${JSON.stringify(passEvidence("design_complete", "review", { evidence_id: "EV-hardlink" }), null, 2)}\n`);
  mkdirp(join(fx.change, ".superspec", "evidence"));
  symlinkSync(outside, join(fx.change, ".superspec", "evidence", "design"), "dir");
  mkdirp(join(fx.change, ".superspec", "evidence", "reviews"));
  linkSync(join(outside, "EV-hardlink.json"), join(fx.change, ".superspec", "evidence", "reviews", "EV-hardlink.json"));
  const direct = passEvidence("explore_complete", "review", { evidence_id: "EV-direct" });
  writeText(join(fx.change, ".superspec", "evidence", "discovery", "EV-direct.json"), `${JSON.stringify(direct, null, 2)}\n`);

  const indexed = guard.index_evidence(fx.change);
  assert.deepEqual(indexed.map((item: JsonMap) => item.evidence_id).sort(), ["EV-direct"]);
});

withFixture("archive preservation skips symlinked and hardlinked sidecar files", (fx) => {
  guard.ensure_sidecar_layout(fx.change);
  const outside = join(fx.tmp, "external-raw.log");
  const outsideHardlink = join(fx.tmp, "external-hardlink.log");
  writeText(outside, "external raw\n");
  writeText(outsideHardlink, "external hardlink raw\n");
  symlinkSync(outside, join(fx.change, ".superspec", "raw", "external.log"));
  linkSync(outsideHardlink, join(fx.change, ".superspec", "raw", "external-hardlink.log"));
  writeText(join(fx.change, ".superspec", "raw", "local.log"), "local raw\n");

  const manifestEntries = guard.sidecar_manifest_entries(fx.change).map((entry: JsonMap) => entry.path);
  assert.ok(manifestEntries.includes(".superspec/raw/local.log"));
  assert.ok(!manifestEntries.includes(".superspec/raw/external.log"));
  assert.ok(!manifestEntries.includes(".superspec/raw/external-hardlink.log"));

  guard.write_archive_preservation_bundle("demo-change", fx.change);
  const bundleManifest = readJson(join(fx.change, "superspec-preservation", "manifest.json"));
  const bundleEntries = bundleManifest.entries.map((entry: JsonMap) => entry.path);
  assert.ok(bundleEntries.includes(".superspec/raw/local.log"));
  assert.ok(!bundleEntries.includes(".superspec/raw/external.log"));
  assert.ok(!bundleEntries.includes(".superspec/raw/external-hardlink.log"));
  assert.equal(existsSync(join(fx.change, "superspec-preservation", "files", ".superspec", "raw", "external.log")), false);
  assert.equal(existsSync(join(fx.change, "superspec-preservation", "files", ".superspec", "raw", "external-hardlink.log")), false);
});

test("command surface includes check-archived", () => {
  const args = guard.parse_argv(["check-archived", "--change", "demo-change"]);
  assert.equal(args.command, "check-archived");
  assert.equal(args.change, "demo-change");
});

test("command surface includes init and apply-ready", () => {
  const init = guard.parse_argv(["init", "--change", "demo-change", "--create"]);
  assert.equal(init.command, "init");
  assert.equal(init.create, true);
  assert.equal(guard.parse_argv(["check-init", "--change", "demo-change"]).command, "check-init");
  assert.equal(guard.parse_argv(["check-apply-ready", "--change", "demo-change"]).command, "check-apply-ready");
});

test("command surface keeps check-verify-ready compatibility alias", () => {
  assert.equal(guard.parse_argv(["check-verify-ready", "--change", "demo-change"]).command, "check-verify-ready");
});

test("A-2 command surface accepts recompute force-unlock", () => {
  const args = guard.parse_argv(["recompute", "--change", "demo-change", "--force-unlock"]);
  assert.equal(args.command, "recompute");
  assert.equal(args.force_unlock, true);
});

test("command surface includes check-task-reopen", () => {
  const args = guard.parse_argv(["check-task-reopen", "--change", "demo-change", "--task-id", "TASK-001"]);
  assert.equal(args.command, "check-task-reopen");
  assert.equal(args.task_id, "TASK-001");
});

test("cli root help matches argparse-style surface", () => {
  const proc = spawnSync(process.execPath, [GUARD_TS, "--help"], { encoding: "utf8" });
  assert.equal(proc.status, 0);
  assert.equal(proc.stderr, "");
  assert.ok(proc.stdout.includes("usage: superspec_guard [-h]"));
  assert.ok(proc.stdout.includes("SuperSpec 守护检查（v1）"));
  assert.ok(proc.stdout.includes("check-task-complete"));
  assert.ok(proc.stdout.includes("check-task-reopen"));
  assert.equal(proc.stdout.includes("show this help message and exit"), false);
});

test("cli missing command emits usage to stderr", () => {
  const proc = spawnSync(process.execPath, [GUARD_TS], { encoding: "utf8" });
  assert.equal(proc.status, 2);
  assert.equal(proc.stdout, "");
  assert.ok(proc.stderr.includes("usage: superspec_guard [-h]"));
  assert.ok(proc.stderr.includes("缺少必填参数：command"));
  assert.equal(proc.stderr.includes("guard_error"), false);
  assert.equal(proc.stderr.includes("the following arguments are required"), false);
});

test("cli unknown command emits argparse-style invalid choice", () => {
  const proc = spawnSync(process.execPath, [GUARD_TS, "nope"], { encoding: "utf8" });
  assert.equal(proc.status, 2);
  assert.equal(proc.stdout, "");
  assert.ok(proc.stderr.includes("命令无效：'nope'"));
  assert.equal(proc.stderr.includes("guard_error"), false);
  assert.equal(proc.stderr.includes("invalid choice"), false);
});

test("cli subcommand help emits usage to stdout", () => {
  const proc = spawnSync(process.execPath, [GUARD_TS, "check-artifact", "--help"], { encoding: "utf8" });
  assert.equal(proc.status, 0);
  assert.equal(proc.stderr, "");
  assert.ok(proc.stdout.includes("usage: superspec_guard check-artifact [-h] --change CHANGE --artifact ARTIFACT"));
});

test("standalone init help emits init-specific usage", () => {
  const proc = spawnSync(process.execPath, [INIT_TS, "--help"], { encoding: "utf8" });
  assert.equal(proc.status, 0);
  assert.equal(proc.stderr, "");
  assert.ok(proc.stdout.includes("usage: superspec init [-h] [--scope {project,user}]"));
  assert.ok(proc.stdout.includes("可选参数："));
  assert.ok(proc.stdout.includes("--user"));
  assert.equal(proc.stdout.includes("show this help message and exit"), false);
});

test("openspec status golden fixture matches 1.4.1 shape", () => {
  const fixture = join(GUARD_ROOT, "tests", "fixtures", "openspec-status-1.4.1.json");
  const currentStatus = readJson(fixture);
  assert.deepEqual(guard.openspec_status_shape_reasons(currentStatus), []);
  assert.equal(guard.artifact_status_map(currentStatus).tasks, "done");
  assert.equal(
    guard.status_fingerprint(currentStatus),
    "sha256:5a3e2b1ad8ae1791bf92ddbc5de392794d5a8d90002f9fe2203564adc91e690c",
  );
});

withFixture("init rejects non-default openspec schema", (fx) => {
  const decision = guard.check_init("demo-change", { ...status(fx), schemaName: "superspec" }, fx.repo, fx.change);
  assert.equal(decision.allowed, false);
  assert.equal(decision.block_reasons[0].code, "non_default_openspec_schema");
});

withFixture("init blocks when openspec codex skills missing", (fx) => {
  unlinkSync(join(fx.repo, ".codex", "skills", "openspec-propose", "SKILL.md"));
  const decision = guard.check_init("demo-change", status(fx), fx.repo, fx.change);
  assert.equal(decision.allowed, false);
  assert.ok(codes(decision.block_reasons).includes("openspec_init_missing"), JSON.stringify(decision));
  const missing = decision.block_reasons.find((item: JsonMap) => item.code === "openspec_init_missing");
  assert.ok(missing);
  assert.ok(missing.refs.includes("openspec-propose"));
});

withFixture("init blocks when openspec codex skill frontmatter invalid", (fx) => {
  writeText(join(fx.repo, ".codex", "skills", "openspec-propose", "SKILL.md"), "---\nname: not-openspec-propose\n---\n");
  const decision = guard.check_init("demo-change", status(fx), fx.repo, fx.change);
  assert.equal(decision.allowed, false);
  assert.ok(codes(decision.block_reasons).includes("openspec_native_surface_invalid"));
});

withFixture("init blocks when openspec cli surface missing", (fx) => {
  withRuntime({
    openspec_cli_capability_reasons: () => [
      guard.reason("openspec_native_surface_missing", "`openspec instructions --help` failed"),
    ],
  }, () => {
    const decision = guard.check_init("demo-change", status(fx), fx.repo, fx.change);
    assert.equal(decision.allowed, false);
    assert.ok(codes(decision.block_reasons).includes("openspec_native_surface_missing"));
  });
});

withFixture("init blocks when superspec agent definitions are missing", (fx) => {
  unlinkSync(join(fx.repo, ".codex", "agents", "critic.toml"));
  const decision = guard.check_init("demo-change", status(fx), fx.repo, fx.change);
  assert.equal(decision.allowed, false);
  assert.ok(codes(decision.block_reasons).includes("superspec_agent_missing"));
  const missing = decision.block_reasons.find((item: JsonMap) => item.code === "superspec_agent_missing");
  assert.ok(missing);
  assert.ok(missing.refs.includes("critic"));
});

withFixture("init blocks when superspec agent name is invalid", (fx) => {
  writeText(join(fx.repo, ".codex", "agents", "critic.toml"), 'name = "not-critic"\n');
  const decision = guard.check_init("demo-change", status(fx), fx.repo, fx.change);
  assert.equal(decision.allowed, false);
  assert.ok(codes(decision.block_reasons).includes("superspec_agent_invalid"));
});

withFixture("init blocks when superspec role prompts are missing", (fx) => {
  unlinkSync(join(fx.repo, ".codex", "prompts", "critic.md"));
  const decision = guard.check_init("demo-change", status(fx), fx.repo, fx.change);
  assert.equal(decision.allowed, false);
  assert.ok(codes(decision.block_reasons).includes("superspec_prompt_missing"));
  const missing = decision.block_reasons.find((item: JsonMap) => item.code === "superspec_prompt_missing");
  assert.ok(missing);
  assert.ok(missing.refs.includes("critic"));
});

withFixture("init blocks when superspec role prompt is empty", (fx) => {
  writeText(join(fx.repo, ".codex", "prompts", "critic.md"), "");
  const decision = guard.check_init("demo-change", status(fx), fx.repo, fx.change);
  assert.equal(decision.allowed, false);
  assert.ok(codes(decision.block_reasons).includes("superspec_prompt_invalid"));
});

withFixture("init allows when openspec codex skills exist", (fx) => {
  const decision = guard.check_init("demo-change", status(fx), fx.repo, fx.change);
  assert.equal(decision.allowed, true, JSON.stringify(decision));
});

withFixture("init blocks when a superspec workflow skill is missing", (fx) => {
  // D4 (audit G-2): deleting .codex/skills/superspec-* must surface at check-init.
  rmSync(join(fx.repo, ".codex", "skills", "superspec-propose"), { recursive: true, force: true });
  const decision = guard.check_init("demo-change", status(fx), fx.repo, fx.change);
  assert.equal(decision.allowed, false);
  const missing = decision.block_reasons.find((item: JsonMap) => item.code === "superspec_init_missing");
  assert.ok(missing, JSON.stringify(decision.block_reasons));
  assert.ok(missing.refs.includes("superspec-propose"));
});

withFixture("init blocks when a superspec workflow skill has invalid front matter", (fx) => {
  writeText(join(fx.repo, ".codex", "skills", "superspec-review", "SKILL.md"), "---\nname: not-superspec-review\n---\n");
  const decision = guard.check_init("demo-change", status(fx), fx.repo, fx.change);
  assert.equal(decision.allowed, false);
  assert.ok(codes(decision.block_reasons).includes("superspec_skill_invalid"), JSON.stringify(decision.block_reasons));
});

withFixture("guard init compatibility creates only state and ledger", (fx) => {
  withRuntime({ load_context: () => [status(fx, { proposal: "blocked", specs: "blocked", design: "blocked", tasks: "blocked" }), fx.repo, fx.change, []] }, () => {
    const [summary] = guard.dispatch({ command: "init", change: "demo-change", create: true });
    assert.equal(summary.allowed, true, JSON.stringify(summary));
    assert.deepEqual(summary.sidecar, {
      root: ".superspec",
      state: ".superspec/superspec-state.json",
      ledger: ".superspec/ledger.jsonl",
    });
    const sidecarEntries = readdirSync(join(fx.change, ".superspec")).sort();
    assert.deepEqual(sidecarEntries, ["ledger.jsonl", "superspec-state.json"]);
  });
});

test("standalone project init creates missing project surfaces without a change", () => {
  const tmp = mkdtempSync(join(tmpdir(), "superspec-project-init-"));
  const writes: string[] = [];
  const savedWrite = process.stdout.write;
  let summary: JsonMap;
  process.stdout.write = ((chunk: any, ...args: any[]) => {
    writes.push(String(chunk));
    return true;
  }) as typeof process.stdout.write;
  try {
    assert.equal(main_init(["--path", tmp]), 0);
    summary = JSON.parse(writes.join(""));
    assert.equal(summary.allowed, true, JSON.stringify(summary));
    assert.equal(summary.gate, "project_init");
    assert.equal(summary.gate_label_zh, "项目初始化");
    assert.equal(summary.change_id, null);
    for (const name of guard.REQUIRED_OPENSPEC_CODEX_SKILLS) {
      assert.equal(existsSync(join(tmp, ".codex", "skills", name, "SKILL.md")), true, name);
    }
    for (const name of guard.REQUIRED_SUPERSPEC_AGENT_ROLES) {
      assert.equal(existsSync(join(tmp, ".codex", "agents", `${name}.toml`)), true, name);
      assert.equal(existsSync(join(tmp, ".codex", "prompts", `${name}.md`)), true, name);
    }
    assert.deepEqual(readdirSync(join(tmp, "openspec", "changes")).filter((name) => !name.startsWith(".") && name !== "archive"), []);
    assert.equal(existsSync(join(tmp, ".superspec")), false);
  } finally {
    process.stdout.write = savedWrite;
    rmSync(tmp, { recursive: true, force: true });
  }
});

withFixture("sidecar output directories are lazy-created on write", (fx) => {
  const base = join(fx.change, ".superspec");
  guard.write_state_atomic(fx.change, { schema_version: 1, change_id: "demo-change" });
  assert.deepEqual(readdirSync(base).sort(), ["ledger.jsonl", "superspec-state.json"]);

  guard.write_sidecar_json(fx.change, "evidence/discovery/EV-discovery.json", passEvidence("explore_complete"));
  assert.equal(statSync(join(base, "evidence", "discovery", "EV-discovery.json")).isFile(), true);
  assert.equal(existsSync(join(base, "reports")), false);
  assert.equal(existsSync(join(base, "raw")), false);

  guard.write_sidecar_text(fx.change, "reports/explore.md", "pass\n");
  guard.write_sidecar_text(fx.change, "raw/openspec-status.json", "{}\n");
  guard.write_sidecar_text(fx.change, "handoffs/apply.md", "handoff\n");
  assert.equal(statSync(join(base, "reports", "explore.md")).isFile(), true);
  assert.equal(statSync(join(base, "raw", "openspec-status.json")).isFile(), true);
  assert.equal(statSync(join(base, "handoffs", "apply.md")).isFile(), true);
});

withFixture("explore complete requires discovery sidecar", (fx) => {
  const decision = guard.check_superspec_gate("demo-change", status(fx, { proposal: "blocked", specs: "blocked", design: "blocked", tasks: "blocked" }), fx.change, [
    roleEvidence(fx, "explore_complete", "critic"),
  ], "explore_complete");
  assert.equal(decision.allowed, false);
  assert.ok(codes(decision.block_reasons).includes("missing_discovery"));
  assert.ok(decision.next_allowed_actions.length > 0);
});

withFixture("explore complete blocks until discovery is human confirmed", (fx) => {
  writeText(join(fx.change, ".superspec", "artifacts", "discovery.md"), "source anchors and facts\n");
  const blocked = guard.check_superspec_gate("demo-change", status(fx, { proposal: "blocked", specs: "blocked", design: "blocked", tasks: "blocked" }), fx.change, [
    roleEvidence(fx, "explore_complete", "critic"),
  ], "explore_complete");
  assert.equal(blocked.allowed, false, JSON.stringify(blocked));
  assert.ok(codes(blocked.block_reasons).includes("missing_human_confirmation"));
  const nonUser = guard.check_superspec_gate("demo-change", status(fx, { proposal: "blocked", specs: "blocked", design: "blocked", tasks: "blocked" }), fx.change, [
    roleEvidence(fx, "explore_complete", "critic"),
    passEvidence("explore_complete", "human_confirmation", { created_by: "main-thread" }),
  ], "explore_complete");
  assert.equal(nonUser.allowed, false, JSON.stringify(nonUser));
  assert.ok(codes(nonUser.block_reasons).includes("missing_human_confirmation"));
  const allowed = guard.check_superspec_gate("demo-change", status(fx, { proposal: "blocked", specs: "blocked", design: "blocked", tasks: "blocked" }), fx.change, [
    roleEvidence(fx, "explore_complete", "critic"),
    passEvidence("explore_complete", "human_confirmation"),
  ], "explore_complete");
  assert.equal(allowed.allowed, true, JSON.stringify(allowed));
});

withFixture("FIX-4 explore complete blocks stale discovery review after discovery edit", (fx) => {
  const discoveryPath = join(fx.change, ".superspec", "artifacts", "discovery.md");
  writeText(discoveryPath, "discovery v1 facts\n");
  const evidences = [
    roleEvidence(fx, "explore_complete", "critic"),
    passEvidence("explore_complete", "human_confirmation"),
  ];
  const exploreStatus = status(fx, { proposal: "blocked", specs: "blocked", design: "blocked", tasks: "blocked" });
  const before = guard.check_superspec_gate("demo-change", exploreStatus, fx.change, evidences, "explore_complete");
  assert.equal(before.allowed, true, JSON.stringify(before));
  writeText(discoveryPath, "discovery v2 facts changed after review\n");
  const after = guard.check_superspec_gate("demo-change", exploreStatus, fx.change, evidences, "explore_complete");
  assert.equal(after.allowed, false);
  assert.ok(codes(after.block_reasons).includes("stale_explore_review"), JSON.stringify(after.block_reasons));
});

withFixture("FIX-4 design complete blocks stale design review after design edit", (fx) => {
  writeText(join(fx.change, ".superspec", "artifacts", "discovery.md"), "discovery facts\n");
  const designPath = join(fx.change, "design.md");
  writeText(designPath, "design v1\n");
  const evidences = [
    ...exploreConfirmedEvidences(fx),
    ...proposalReviewedEvidences(fx),
    roleEvidence(fx, "design_complete", "architect"),
    roleEvidence(fx, "design_complete", "critic"),
    roleEvidence(fx, "design_complete", "test-engineer"),
    passEvidence("design_complete", "human_confirmation"),
  ];
  const before = guard.check_superspec_gate("demo-change", status(fx), fx.change, evidences, "design_complete");
  assert.equal(before.allowed, true, JSON.stringify(before));
  writeText(designPath, "design v2 changed after review\n");
  const after = guard.check_superspec_gate("demo-change", status(fx), fx.change, evidences, "design_complete");
  assert.equal(after.allowed, false);
  assert.ok(codes(after.block_reasons).includes("stale_design_review"), JSON.stringify(after.block_reasons));
});

withFixture("FIX-4 test contract drafted blocks stale contract review after contract edit", (fx) => {
  const evidences = prepareProposeComplete(fx);
  const before = guard.check_superspec_gate("demo-change", status(fx), fx.change, evidences, "test_contract_drafted");
  assert.equal(before.allowed, true, JSON.stringify(before));
  const contractPath = join(fx.change, ".superspec", "artifacts", "test-contract.md");
  writeText(contractPath, `${testContractText()}\n<!-- edited after review -->\n`);
  const after = guard.check_superspec_gate("demo-change", status(fx), fx.change, evidences, "test_contract_drafted");
  assert.equal(after.allowed, false);
  assert.ok(codes(after.block_reasons).includes("stale_test_contract_review"), JSON.stringify(after.block_reasons));
});

withFixture("FIX-4 state fingerprints cover discovery and design artifacts", (fx) => {
  writeText(join(fx.change, ".superspec", "artifacts", "discovery.md"), "discovery v1\n");
  writeText(join(fx.change, "design.md"), "design v1\n");
  const currentStatus = status(fx);
  const decision = guard.allow("demo-change", "recompute");
  guard.recompute_and_write_state("demo-change", fx.change, currentStatus, "tasks", "recompute", decision);
  const state = readJson(join(fx.change, ".superspec", "superspec-state.json"));
  assert.ok(String(state.computed_from.discovery_fingerprint ?? "").startsWith("sha256:"), JSON.stringify(state.computed_from));
  assert.ok(String(state.computed_from.design_fingerprint ?? "").startsWith("sha256:"), JSON.stringify(state.computed_from));
  writeText(join(fx.change, ".superspec", "artifacts", "discovery.md"), "discovery v2\n");
  assert.deepEqual(codes(guard.state_stale_reasons(fx.change, currentStatus)), ["state_fingerprint_stale"]);
  guard.recompute_and_write_state("demo-change", fx.change, currentStatus, "tasks", "recompute", decision);
  assert.deepEqual(guard.state_stale_reasons(fx.change, currentStatus), []);
  writeText(join(fx.change, "design.md"), "design v2\n");
  assert.deepEqual(codes(guard.state_stale_reasons(fx.change, currentStatus)), ["state_fingerprint_stale"]);
});

withFixture("FIX-2 design complete blocks when explore_complete not satisfied", (fx) => {
  writeText(join(fx.change, "design.md"), "design\n");
  const decision = guard.check_superspec_gate("demo-change", status(fx), fx.change, [
    roleEvidence(fx, "design_complete", "architect"),
    roleEvidence(fx, "design_complete", "critic"),
    roleEvidence(fx, "design_complete", "test-engineer"),
    passEvidence("design_complete", "human_confirmation"),
  ], "design_complete");
  assert.equal(decision.allowed, false);
  const decisionCodes = codes(decision.block_reasons);
  assert.ok(decisionCodes.includes("explore_complete_failed"), JSON.stringify(decisionCodes));
  assert.ok(decisionCodes.includes("missing_discovery"), JSON.stringify(decisionCodes));
});

withFixture("FIX-2 design complete allows when explore_complete satisfied", (fx) => {
  writeText(join(fx.change, ".superspec", "artifacts", "discovery.md"), "source anchors and facts\n");
  writeText(join(fx.change, "design.md"), "design\n");
  const decision = guard.check_superspec_gate("demo-change", status(fx), fx.change, [
    ...exploreConfirmedEvidences(fx),
    ...proposalReviewedEvidences(fx),
    roleEvidence(fx, "design_complete", "architect"),
    roleEvidence(fx, "design_complete", "critic"),
    roleEvidence(fx, "design_complete", "test-engineer"),
    passEvidence("design_complete", "human_confirmation"),
  ], "design_complete");
  assert.equal(decision.allowed, true, JSON.stringify(decision));
});

withFixture("test contract drafted blocks until design is user-confirmed", (fx) => {
  writeText(join(fx.change, ".superspec", "artifacts", "discovery.md"), "source anchors and facts\n");
  writeText(join(fx.change, "design.md"), "design\n");
  writeText(join(fx.change, ".superspec", "artifacts", "business-invariants.md"), businessInvariantsText());
  writeText(join(fx.change, ".superspec", "artifacts", "test-contract.md"), testContractText());
  writeText(join(fx.change, "specs", "attendance", "spec.md"), "#### Scenario: Scenario A\n");
  const base = [
    ...exploreConfirmedEvidences(fx),
    ...proposalReviewedEvidences(fx),
    roleEvidence(fx, "design_complete", "architect"),
    roleEvidence(fx, "design_complete", "critic"),
    roleEvidence(fx, "design_complete", "test-engineer"),
    roleEvidence(fx, "invariants_reviewed", "critic"),
    roleEvidence(fx, "invariants_reviewed", "test-engineer"),
    roleEvidence(fx, "test_contract_drafted", "test-engineer"),
    roleEvidence(fx, "test_contract_drafted", "critic"),
  ];
  const missing = guard.check_superspec_gate("demo-change", status(fx, { tasks: "blocked" }), fx.change, base, "test_contract_drafted");
  assert.equal(missing.allowed, false, JSON.stringify(missing));
  assert.ok(codes(missing.block_reasons).includes("design_complete_failed"), JSON.stringify(missing.block_reasons));
  assert.ok(codes(missing.block_reasons).includes("missing_human_confirmation"), JSON.stringify(missing.block_reasons));
  const nonUser = guard.check_superspec_gate("demo-change", status(fx, { tasks: "blocked" }), fx.change, [
    ...base,
    passEvidence("design_complete", "human_confirmation", { created_by: "main-thread" }),
  ], "test_contract_drafted");
  assert.equal(nonUser.allowed, false, JSON.stringify(nonUser));
  assert.ok(codes(nonUser.block_reasons).includes("missing_human_confirmation"), JSON.stringify(nonUser.block_reasons));
});

withFixture("test contract drafted passes without tasks", (fx) => {
  writeText(join(fx.change, ".superspec", "artifacts", "discovery.md"), "source anchors and facts\n");
  writeText(join(fx.change, "design.md"), "design\n");
  writeText(join(fx.change, ".superspec", "artifacts", "business-invariants.md"), businessInvariantsText());
  writeText(join(fx.change, ".superspec", "artifacts", "test-contract.md"), testContractText());
  const decision = guard.check_superspec_gate("demo-change", status(fx, { tasks: "blocked" }), fx.change, [
    ...exploreConfirmedEvidences(fx),
    ...proposalReviewedEvidences(fx),
    roleEvidence(fx, "design_complete", "architect"),
    roleEvidence(fx, "design_complete", "critic"),
    roleEvidence(fx, "design_complete", "test-engineer"),
    passEvidence("design_complete", "human_confirmation"),
    roleEvidence(fx, "invariants_reviewed", "critic"),
    roleEvidence(fx, "invariants_reviewed", "test-engineer"),
    roleEvidence(fx, "test_contract_drafted", "test-engineer"),
    roleEvidence(fx, "test_contract_drafted", "critic"),
  ], "test_contract_drafted");
  assert.equal(decision.allowed, true, JSON.stringify(decision));
});

withFixture("test contract drafted blocks missing scenario coverage", (fx) => {
  writeText(join(fx.change, ".superspec", "artifacts", "business-invariants.md"), businessInvariantsText());
  writeText(join(fx.change, ".superspec", "artifacts", "test-contract.md"), testContractText("TEST-001", "unrelated", "INV-001"));
  writeText(join(fx.change, "specs", "attendance", "spec.md"), "#### Scenario: Clock in validates policy\n");
  const decision = guard.check_superspec_gate("demo-change", status(fx, { tasks: "blocked" }), fx.change, [
    roleEvidence(fx, "design_complete", "architect"),
    roleEvidence(fx, "design_complete", "critic"),
    roleEvidence(fx, "design_complete", "test-engineer"),
    passEvidence("design_complete", "human_confirmation"),
    roleEvidence(fx, "invariants_reviewed", "critic"),
    roleEvidence(fx, "invariants_reviewed", "test-engineer"),
    roleEvidence(fx, "test_contract_drafted", "test-engineer"),
    roleEvidence(fx, "test_contract_drafted", "critic"),
  ], "test_contract_drafted");
  assert.equal(decision.allowed, false);
  assert.ok(codes(decision.block_reasons).includes("missing_coverage_matrix"));
});

withFixture("invariants reviewed requires business invariants sidecar", (fx) => {
  const decision = guard.check_superspec_gate("demo-change", status(fx), fx.change, [
    roleEvidence(fx, "design_complete", "architect"),
    roleEvidence(fx, "design_complete", "critic"),
    roleEvidence(fx, "design_complete", "test-engineer"),
    passEvidence("design_complete", "human_confirmation"),
    roleEvidence(fx, "invariants_reviewed", "critic"),
    roleEvidence(fx, "invariants_reviewed", "test-engineer"),
  ], "invariants_reviewed");
  assert.equal(decision.allowed, false);
  assert.ok(codes(decision.block_reasons).includes("missing_business_invariants"));
});

withFixture("invariants reviewed requires critic and test engineer", (fx) => {
  writeText(join(fx.change, ".superspec", "artifacts", "business-invariants.md"), businessInvariantsText());
  const decision = guard.check_superspec_gate("demo-change", status(fx), fx.change, [
    roleEvidence(fx, "design_complete", "architect"),
    roleEvidence(fx, "design_complete", "critic"),
    roleEvidence(fx, "design_complete", "test-engineer"),
    passEvidence("design_complete", "human_confirmation"),
    roleEvidence(fx, "invariants_reviewed", "critic"),
  ], "invariants_reviewed");
  assert.equal(decision.allowed, false);
  assert.ok(codes(decision.block_reasons).includes("missing_invariant_review"));
});

withFixture("invariants reviewed evidence must target current business invariants", (fx) => {
  writeText(join(fx.change, ".superspec", "artifacts", "business-invariants.md"), businessInvariantsText());
  const unrelated = join(fx.change, "unrelated.md");
  writeText(unrelated, "not the invariant file\n");
  const decision = guard.check_superspec_gate("demo-change", status(fx), fx.change, [
    roleEvidence(fx, "design_complete", "architect"),
    roleEvidence(fx, "design_complete", "critic"),
    roleEvidence(fx, "design_complete", "test-engineer"),
    passEvidence("design_complete", "human_confirmation"),
    roleEvidence(fx, "invariants_reviewed", "critic", {
      target_refs: [{ path: "unrelated.md", blob_sha: guard.file_blob_sha(unrelated) }],
    }),
    roleEvidence(fx, "invariants_reviewed", "test-engineer"),
  ], "invariants_reviewed");
  assert.equal(decision.allowed, false);
  assert.ok(codes(decision.block_reasons).includes("stale_invariant_review"));
});

withFixture("invariants reviewed blocks hard post implementation backfill", (fx) => {
  writeText(join(fx.change, ".superspec", "artifacts", "business-invariants.md"), businessInvariantsText("INV-001", { created_after_implementation: "true" }));
  const decision = guard.check_superspec_gate("demo-change", status(fx), fx.change, [
    roleEvidence(fx, "design_complete", "architect"),
    roleEvidence(fx, "design_complete", "critic"),
    roleEvidence(fx, "design_complete", "test-engineer"),
    passEvidence("design_complete", "human_confirmation"),
    roleEvidence(fx, "invariants_reviewed", "critic"),
    roleEvidence(fx, "invariants_reviewed", "test-engineer"),
  ], "invariants_reviewed");
  assert.equal(decision.allowed, false);
  assert.ok(codes(decision.block_reasons).includes("post_implementation_invariant_backfill"));
});

withFixture("invariants reviewed requires human confirmation for human-confirmation invariants", (fx) => {
  writeText(join(fx.change, ".superspec", "artifacts", "business-invariants.md"), businessInvariantsText("INV-001", { enforcement_level: "human-confirmation", verification: "human confirmation evidence" }));
  const decision = guard.check_superspec_gate("demo-change", status(fx), fx.change, [
    roleEvidence(fx, "design_complete", "architect"),
    roleEvidence(fx, "design_complete", "critic"),
    roleEvidence(fx, "design_complete", "test-engineer"),
    passEvidence("design_complete", "human_confirmation"),
    roleEvidence(fx, "invariants_reviewed", "critic"),
    roleEvidence(fx, "invariants_reviewed", "test-engineer"),
  ], "invariants_reviewed");
  assert.equal(decision.allowed, false);
  assert.ok(codes(decision.block_reasons).includes("missing_human_confirmation"));
});

withFixture("test contract drafted allows human-confirmation invariant outside TEST matrix with human evidence", (fx) => {
  writeText(join(fx.change, ".superspec", "artifacts", "discovery.md"), "source anchors and facts\n");
  writeText(join(fx.change, "design.md"), "design\n");
  writeText(join(fx.change, ".superspec", "artifacts", "business-invariants.md"), businessInvariantsText("INV-HUMAN", { enforcement_level: "human-confirmation", verification: "human confirmation evidence" }));
  writeText(join(fx.change, ".superspec", "artifacts", "test-contract.md"), testContractText("TEST-001", "Scenario A", ""));
  writeText(join(fx.change, "specs", "attendance", "spec.md"), "#### Scenario: Scenario A\n");
  const decision = guard.check_superspec_gate("demo-change", status(fx, { tasks: "blocked" }), fx.change, [
    ...exploreConfirmedEvidences(fx),
    ...proposalReviewedEvidences(fx),
    roleEvidence(fx, "design_complete", "architect"),
    roleEvidence(fx, "design_complete", "critic"),
    roleEvidence(fx, "design_complete", "test-engineer"),
    passEvidence("design_complete", "human_confirmation"),
    roleEvidence(fx, "invariants_reviewed", "critic"),
    roleEvidence(fx, "invariants_reviewed", "test-engineer"),
    passEvidence("invariants_reviewed", "human_confirmation", { invariant_refs: ["INV-HUMAN"] }),
    roleEvidence(fx, "test_contract_drafted", "test-engineer"),
    roleEvidence(fx, "test_contract_drafted", "critic"),
  ], "test_contract_drafted");
  assert.equal(decision.allowed, true, JSON.stringify(decision));
});

withFixture("test contract drafted blocks automated hard invariant outside TEST matrix", (fx) => {
  writeText(join(fx.change, ".superspec", "artifacts", "business-invariants.md"), businessInvariantsText("INV-001", { enforcement_level: "automated-test" }));
  writeText(join(fx.change, ".superspec", "artifacts", "test-contract.md"), testContractText("TEST-001", "Scenario A", ""));
  writeText(join(fx.change, "specs", "attendance", "spec.md"), "#### Scenario: Scenario A\n");
  const decision = guard.check_superspec_gate("demo-change", status(fx, { tasks: "blocked" }), fx.change, [
    roleEvidence(fx, "design_complete", "architect"),
    roleEvidence(fx, "design_complete", "critic"),
    roleEvidence(fx, "design_complete", "test-engineer"),
    passEvidence("design_complete", "human_confirmation"),
    roleEvidence(fx, "invariants_reviewed", "critic"),
    roleEvidence(fx, "invariants_reviewed", "test-engineer"),
    roleEvidence(fx, "test_contract_drafted", "test-engineer"),
    roleEvidence(fx, "test_contract_drafted", "critic"),
  ], "test_contract_drafted");
  assert.equal(decision.allowed, false);
  assert.ok(codes(decision.block_reasons).includes("invariant_not_honored"));
});

withFixture("test contract drafted ignores ids outside coverage matrix", (fx) => {
  writeText(join(fx.change, ".superspec", "artifacts", "business-invariants.md"), businessInvariantsText());
  writeText(join(fx.change, ".superspec", "artifacts", "test-contract.md"), "## Notes\n\nTEST-001 Scenario A INV-001\n");
  const decision = guard.check_superspec_gate("demo-change", status(fx, { tasks: "blocked" }), fx.change, [
    roleEvidence(fx, "design_complete", "architect"),
    roleEvidence(fx, "design_complete", "critic"),
    roleEvidence(fx, "design_complete", "test-engineer"),
    passEvidence("design_complete", "human_confirmation"),
    roleEvidence(fx, "invariants_reviewed", "critic"),
    roleEvidence(fx, "invariants_reviewed", "test-engineer"),
    roleEvidence(fx, "test_contract_drafted", "test-engineer"),
    roleEvidence(fx, "test_contract_drafted", "critic"),
  ], "test_contract_drafted");
  assert.equal(decision.allowed, false);
  assert.ok(codes(decision.block_reasons).includes("missing_coverage_matrix"));
});

withFixture("check artifact requires test contract before tasks", (fx) => {
  const decision = guard.check_artifact("demo-change", status(fx, { tasks: "ready" }), fx.change, [], "tasks");
  assert.equal(decision.allowed, false);
  assert.ok(codes(decision.block_reasons).includes("test_contract_drafted_failed"));
  assert.ok(codes(decision.block_reasons).includes("missing_test_contract"));
});

withFixture("check artifact allows tasks after test contract drafted", (fx) => {
  const decision = guard.check_artifact("demo-change", status(fx, { tasks: "ready" }), fx.change, prepareProposeComplete(fx), "tasks");
  assert.equal(decision.allowed, true, JSON.stringify(decision));
});

withFixture("FIX-3 test contract honored blocks when test_contract_drafted not satisfied", (fx) => {
  const evidences = prepareProposeComplete(fx).filter((ev) => ev.gate !== "test_contract_drafted");
  const decision = guard.check_superspec_gate("demo-change", status(fx), fx.change, evidences, "test_contract_honored");
  assert.equal(decision.allowed, false);
  const decisionCodes = codes(decision.block_reasons);
  assert.ok(decisionCodes.includes("test_contract_drafted_failed"), JSON.stringify(decisionCodes));
  assert.ok(decisionCodes.includes("missing_test_contract_review"), JSON.stringify(decisionCodes));
});

withFixture("FIX-3 test contract honored allows when test_contract_drafted satisfied", (fx) => {
  const decision = guard.check_superspec_gate("demo-change", status(fx), fx.change, prepareProposeComplete(fx), "test_contract_honored");
  assert.equal(decision.allowed, true, JSON.stringify(decision));
});

withFixture("test contract honored blocks before tasks", (fx) => {
  writeText(join(fx.change, ".superspec", "artifacts", "test-contract.md"), testContractText("TEST-001", "Scenario A", ""));
  const decision = guard.check_superspec_gate("demo-change", status(fx, { tasks: "blocked" }), fx.change, [], "test_contract_honored");
  assert.ok(codes(decision.block_reasons).includes("missing_tasks"));
});

withFixture("test contract honored requires task test refs", (fx) => {
  writeText(join(fx.change, ".superspec", "artifacts", "test-contract.md"), testContractText("TEST-001", "Scenario A", ""));
  writeText(join(fx.change, "tasks.md"), "- [ ] TASK-001 Implement\n  - test_refs: TEST-002\n");
  const decision = guard.check_superspec_gate("demo-change", status(fx), fx.change, [], "test_contract_honored");
  assert.equal(decision.allowed, false);
  assert.ok(codes(decision.block_reasons).includes("missing_task_test_refs"));
});

withFixture("test contract honored allows mapped test refs", (fx) => {
  const evidences = prepareProposeComplete(fx);
  const decision = guard.check_superspec_gate("demo-change", status(fx), fx.change, evidences, "test_contract_honored");
  assert.equal(decision.allowed, true, JSON.stringify(decision));
});

withFixture("test contract honored requires task invariant refs", (fx) => {
  writeText(join(fx.change, ".superspec", "artifacts", "business-invariants.md"), businessInvariantsText());
  writeText(join(fx.change, ".superspec", "artifacts", "test-contract.md"), testContractText());
  writeText(join(fx.change, "tasks.md"), "- [ ] TASK-001 Implement\n  - test_refs: TEST-001\n");
  const decision = guard.check_superspec_gate("demo-change", status(fx), fx.change, [], "test_contract_honored");
  assert.equal(decision.allowed, false);
  assert.ok(codes(decision.block_reasons).includes("missing_task_invariant_refs"));
});

withFixture("test contract honored requires invariant refs on matching test task", (fx) => {
  writeText(join(fx.change, ".superspec", "artifacts", "business-invariants.md"), businessInvariantsText());
  writeText(join(fx.change, ".superspec", "artifacts", "test-contract.md"), testContractText());
  writeText(join(fx.change, "tasks.md"),
    "- [ ] TASK-001 Different test owns invariant\n" +
      "  - test_refs: TEST-999\n" +
      "  - invariant_refs: INV-001\n" +
      "- [ ] TASK-002 Contract test lacks invariant\n" +
      "  - test_refs: TEST-001\n");
  const decision = guard.check_superspec_gate("demo-change", status(fx), fx.change, [], "test_contract_honored");
  assert.equal(decision.allowed, false);
  assert.ok(codes(decision.block_reasons).includes("missing_task_invariant_refs"));
});

withFixture("task edit requires evidence invariant refs to match test contract row", (fx) => {
  const evidences = prepareProposeComplete(fx);
  writeText(
    join(fx.change, "tasks.md"),
    "- [ ] TASK-001 Implement\n" +
      "  - invariant_refs: INV-001, INV-002\n" +
      "  - test_refs: TEST-001\n",
  );
  const decision = guard.check_task_edit("demo-change", status(fx), fx.change, [
    ...evidences,
    passEvidence("task_edit", "test_run", { task_id: "TASK-001", test_id: "TEST-001", invariant_refs: ["INV-002"], semantic_status: "expected_failure" }),
  ], "TASK-001");
  assert.equal(decision.allowed, false);
  assert.ok(codes(decision.block_reasons).includes("invariant_not_honored"));
});

withFixture("tasks complete blocks parallel write scope conflict", (fx) => {
  writeText(join(fx.change, ".superspec", "artifacts", "test-contract.md"), testContractText("TEST-001", "Scenario A", ""));
  writeText(join(fx.change, "tasks.md"),
    "- [ ] TASK-001 Implement A\n" +
      "  - test_refs: TEST-001\n" +
      "  - parallel_group: G1\n" +
      "  - write_scope: src/service.py\n" +
      "- [ ] TASK-002 Implement B\n" +
      "  - test_refs: TEST-001\n" +
      "  - parallel_group: G1\n" +
      "  - write_scope: src/service.py\n");
  const decision = guard.check_superspec_gate("demo-change", status(fx), fx.change, [], "tasks_complete");
  assert.equal(decision.allowed, false);
  assert.ok(codes(decision.block_reasons).includes("write_scope_conflict"));
});

withFixture("propose complete requires all internal gates", (fx) => {
  const decision = guard.check_superspec_gate("demo-change", status(fx), fx.change, [], "propose_complete");
  assert.equal(decision.allowed, false);
  const decisionCodes = codes(decision.block_reasons);
  assert.ok(decisionCodes.includes("explore_complete_failed"));
  assert.ok(decisionCodes.includes("design_complete_failed"));
  assert.ok(decisionCodes.includes("invariants_reviewed_failed"));
  assert.ok(decisionCodes.includes("test_contract_drafted_failed"));
  assert.ok(decisionCodes.includes("tasks_complete_failed"));
});

withFixture("propose gate aliases map to internal gates", (fx) => {
  const evidences = prepareProposeComplete(fx);
  assert.equal(guard.GATE_ALIASES["propose.apply_ready"], "apply_ready");
  const decision = guard.check_superspec_gate("demo-change", status(fx), fx.change, evidences, "propose.apply_ready");
  assert.equal(decision.allowed, true, JSON.stringify(decision));
});

withFixture("apply-ready blocks until apply isolation is user-confirmed", (fx) => {
  const evidences = prepareProposeComplete(fx).filter((ev) => ev.gate !== "apply_isolation");
  const decision = guard.check_apply_ready("demo-change", status(fx), fx.change, evidences);
  assert.equal(decision.allowed, false, JSON.stringify(decision));
  assert.ok(codes(decision.block_reasons).includes("apply_isolation_unconfirmed"), JSON.stringify(decision.block_reasons));
  const nonUser = prepareProposeComplete(fx).map((ev) => (
    ev.gate === "apply_isolation" ? { ...ev, created_by: "main-thread" } : ev
  ));
  const nonUserDecision = guard.check_apply_ready("demo-change", status(fx), fx.change, nonUser);
  assert.equal(nonUserDecision.allowed, false, JSON.stringify(nonUserDecision));
  assert.ok(codes(nonUserDecision.block_reasons).includes("apply_isolation_unconfirmed"), JSON.stringify(nonUserDecision.block_reasons));
  const aliasDecision = guard.check_superspec_gate("demo-change", status(fx), fx.change, evidences, "propose.apply_ready");
  assert.equal(aliasDecision.allowed, false, JSON.stringify(aliasDecision));
  assert.ok(codes(aliasDecision.block_reasons).includes("apply_isolation_unconfirmed"), JSON.stringify(aliasDecision.block_reasons));
  withRuntime({ load_context: () => [status(fx), fx.repo, fx.change, evidences] }, () => {
    const [ready] = guard.dispatch({ command: "check-apply-ready", change: "demo-change" });
    assert.equal(ready.allowed, false, JSON.stringify(ready));
    assert.ok(codes(ready.block_reasons).includes("apply_isolation_unconfirmed"), JSON.stringify(ready.block_reasons));
    const [enter] = guard.dispatch({ command: "check-enter", change: "demo-change", gate: "apply_ready" });
    assert.equal(enter.allowed, false, JSON.stringify(enter));
    assert.ok(codes(enter.block_reasons).includes("apply_isolation_unconfirmed"), JSON.stringify(enter.block_reasons));
    const [aliasEnter] = guard.dispatch({ command: "check-enter", change: "demo-change", gate: "propose.apply_ready" });
    assert.equal(aliasEnter.allowed, false, JSON.stringify(aliasEnter));
    assert.ok(codes(aliasEnter.block_reasons).includes("apply_isolation_unconfirmed"), JSON.stringify(aliasEnter.block_reasons));
  });
});

withFixture("task edit blocks when propose not complete", (fx) => {
  writeText(join(fx.change, "tasks.md"), "- [ ] TASK-001 Implement\n  - test_refs: TEST-001\n");
  const decision = guard.check_task_edit("demo-change", status(fx), fx.change, [], "TASK-001");
  assert.equal(decision.allowed, false);
  assert.ok(codes(decision.block_reasons).includes("propose_not_complete"));
});

withFixture("task edit after propose complete requires red", (fx) => {
  const decision = guard.check_task_edit("demo-change", status(fx), fx.change, prepareProposeComplete(fx), "TASK-001");
  assert.equal(decision.allowed, false);
  assert.ok(codes(decision.block_reasons).includes("missing_red_evidence"));
});

withFixture("task edit rejects red evidence from wrong gate", (fx) => {
  const evidences = [
    ...prepareProposeComplete(fx),
    passEvidence("review_complete", "test_run", {
      task_id: "TASK-001",
      test_id: "TEST-001",
      invariant_refs: ["INV-001"],
      semantic_status: "expected_failure",
    }),
  ];
  const decision = guard.check_task_edit("demo-change", status(fx), fx.change, evidences, "TASK-001");
  assert.equal(decision.allowed, false);
  assert.ok(codes(decision.block_reasons).includes("missing_red_evidence"));
});

withFixture("task complete after propose complete requires green", (fx) => {
  const evidences = [
    ...prepareProposeComplete(fx),
    passEvidence("task_edit", "test_run", { task_id: "TASK-001", test_id: "TEST-001", invariant_refs: ["INV-001"], semantic_status: "expected_failure" }),
  ];
  const decision = guard.check_task_complete("demo-change", status(fx), fx.change, evidences, "TASK-001");
  assert.equal(decision.allowed, false);
  assert.ok(codes(decision.block_reasons).includes("missing_green_evidence"));
});

withFixture("task complete rejects green evidence from wrong gate", (fx) => {
  const evidences = [
    ...prepareProposeComplete(fx),
    redEvidence(),
    passEvidence("task_edit", "test_run", {
      task_id: "TASK-001",
      test_id: "TEST-001",
      invariant_refs: ["INV-001"],
      semantic_status: "expected_success",
    }),
  ];
  const decision = guard.check_task_complete("demo-change", status(fx), fx.change, evidences, "TASK-001");
  assert.equal(decision.allowed, false);
  assert.ok(codes(decision.block_reasons).includes("missing_green_evidence"));
});

withFixture("task complete requires green for every declared test ref", (fx) => {
  const evidences = prepareProposeComplete(fx);
  writeText(join(fx.change, ".superspec", "artifacts", "test-contract.md"), testContractRowsText([
    { test_id: "TEST-001", scenario: "Scenario A", invariant_refs: "INV-001" },
    { test_id: "TEST-002", scenario: "Scenario A", invariant_refs: "INV-001" },
  ]));
  writeText(
    join(fx.change, "tasks.md"),
    "- [ ] TASK-001 Implement\n" +
      "  - invariant_refs: INV-001\n" +
      "  - test_refs: TEST-001, TEST-002\n",
  );
  const decision = guard.check_task_complete("demo-change", status(fx), fx.change, [
    ...evidences,
    greenEvidence("TASK-001", "TEST-001", ["INV-001"]),
  ], "TASK-001");
  assert.equal(decision.allowed, false);
  assert.ok(codes(decision.block_reasons).includes("missing_declared_test_evidence"));
});

withFixture("task complete allows when every declared test ref has green", (fx) => {
  const evidences = prepareProposeComplete(fx, {
    testContract: testContractRowsText([
      { test_id: "TEST-001", scenario: "Scenario A", invariant_refs: "INV-001" },
      { test_id: "TEST-002", scenario: "Scenario A", invariant_refs: "INV-001" },
    ]),
    tasksText:
      "- [ ] TASK-001 Implement\n" +
      "  - invariant_refs: INV-001\n" +
      "  - test_refs: TEST-001, TEST-002\n",
  });
  const decision = guard.check_task_complete("demo-change", status(fx), fx.change, [
    ...evidences,
    greenEvidence("TASK-001", "TEST-001", ["INV-001"]),
    greenEvidence("TASK-001", "TEST-002", ["INV-001"], { evidence_id: "EV-green-002" }),
  ], "TASK-001");
  assert.equal(decision.allowed, true, JSON.stringify(decision));
});

withFixture("task complete no tdd requires alternative verification", (fx) => {
  const evidences = prepareProposeComplete(fx);
  writeText(join(fx.change, "tasks.md"),
    "- [ ] TASK-001 Docs\n" +
      "  - invariant_refs: INV-001\n" +
      "  - test_refs: TEST-001\n" +
      "  - tdd_required: false\n" +
      "  - no_tdd_reason: documentation-only\n");
  const decision = guard.check_task_complete("demo-change", status(fx), fx.change, evidences, "TASK-001");
  assert.equal(decision.allowed, false);
  assert.ok(codes(decision.block_reasons).includes("missing_alternative_verification"));
});

withFixture("review ready blocks checked task without green", (fx) => {
  const evidences = prepareProposeComplete(fx, { checked: true });
  withRuntime({
    openspec_validate: () => [true, ""],
    dirty_worktree_reasons: () => [],
  }, () => {
    const decision = guard.check_review_ready("demo-change", status(fx), fx.change, evidences);
    assert.equal(decision.allowed, false);
    assert.ok(codes(decision.block_reasons).includes("task_evidence_incomplete"));
    assert.ok(decision.next_allowed_actions.length > 0);
  });
});

withFixture("review ready propagates missing declared test evidence", (fx) => {
  const evidences = prepareProposeComplete(fx, { checked: true });
  writeText(join(fx.change, ".superspec", "artifacts", "test-contract.md"), testContractRowsText([
    { test_id: "TEST-001", scenario: "Scenario A", invariant_refs: "INV-001" },
    { test_id: "TEST-002", scenario: "Scenario A", invariant_refs: "INV-001" },
  ]));
  writeText(
    join(fx.change, "tasks.md"),
    "- [x] TASK-001 Implement\n" +
      "  - invariant_refs: INV-001\n" +
      "  - test_refs: TEST-001, TEST-002\n",
  );
  withRuntime({ openspec_validate: () => [true, ""], dirty_worktree_reasons: () => [] }, () => {
    const decision = guard.check_review_ready("demo-change", status(fx), fx.change, [
      ...evidences,
      greenEvidence("TASK-001", "TEST-001", ["INV-001"]),
    ]);
    assert.equal(decision.allowed, false);
    assert.ok(codes(decision.block_reasons).includes("missing_declared_test_evidence"));
  });
});

withFixture("review ready blocks write scope change without red", (fx) => {
  const evidences = [...prepareProposeComplete(fx, { checked: true }), greenEvidence()];
  writeText(join(fx.change, "tasks.md"), "- [x] TASK-001 Implement\n  - invariant_refs: INV-001\n  - test_refs: TEST-001\n  - write_scope: src/service.py\n");
  withRuntime({
    openspec_validate: () => [true, ""],
    dirty_worktree_reasons: () => [],
    dirty_worktree_paths: () => ["src/service.py"],
  }, () => {
    const decision = guard.check_review_ready("demo-change", status(fx), fx.change, evidences);
    assert.equal(decision.allowed, false);
    assert.ok(codes(decision.block_reasons).includes("missing_red_evidence"));
  });
});

withFixture("review ready allows write scope change with red and green", (fx) => {
  const evidences = [
    ...prepareProposeComplete(fx, {
      checked: true,
      tasksText: "- [x] TASK-001 Implement\n  - invariant_refs: INV-001\n  - test_refs: TEST-001\n  - write_scope: src/service.py\n",
    }),
    passEvidence("task_edit", "test_run", { task_id: "TASK-001", test_id: "TEST-001", invariant_refs: ["INV-001"], semantic_status: "expected_failure" }),
    greenEvidence("TASK-001", "TEST-001", ["INV-001"]),
  ];
  withRuntime({
    openspec_validate: () => [true, ""],
    dirty_worktree_reasons: () => [],
    dirty_worktree_paths: () => ["src/service.py"],
  }, () => {
    const decision = guard.check_review_ready("demo-change", status(fx), fx.change, evidences);
    assert.equal(decision.allowed, true, JSON.stringify(decision));
  });
});

withFixture("review complete requires diff contract fields", (fx) => {
  const guidance = [
    ...reviewGuidanceEvidences(fx, { lane_overrides: { "code-reviewer": { base_ref: undefined } } }),
    reviewEvidence(fx, "critic"),
  ];
  const evidences = [
    ...prepareProposeComplete(fx, { checked: true }),
    greenEvidence(),
    ...guidance,
    mainAdjudication(fx, guidance),
    verifyEvidence(fx, "verifier"),
    verifyEvidence(fx, "critic"),
    finalTestEvidence(fx),
  ];
  withRuntime({ openspec_validate: () => [true, ""], dirty_worktree_reasons: () => [] }, () => {
    const decision = guard.check_review_complete("demo-change", status(fx), fx.change, evidences);
    assert.equal(decision.allowed, false);
    assert.ok(codes(decision.block_reasons).includes("review_evidence_incomplete"));
  });
});

withFixture("review complete blocks when reviewed files miss diff", (fx) => {
  const guidance = [
    ...reviewGuidanceEvidences(fx, { reviewed_files: ["tasks.md"] }),
    reviewEvidence(fx, "critic", { reviewed_files: ["tasks.md", "src/service.py"] }),
  ];
  const evidences = [
    ...prepareProposeComplete(fx, { checked: true }),
    greenEvidence(),
    ...guidance,
    mainAdjudication(fx, guidance),
    verifyEvidence(fx, "verifier"),
    verifyEvidence(fx, "critic"),
    finalTestEvidence(fx),
  ];
  withRuntime({
    openspec_validate: () => [true, ""],
    dirty_worktree_reasons: () => [],
    review_diff_paths: () => ["tasks.md", "src/service.py"],
  }, () => {
    const decision = guard.check_review_complete("demo-change", status(fx), fx.change, evidences);
    assert.equal(decision.allowed, false);
    assert.ok(codes(decision.block_reasons).includes("review_diff_not_covered"));
  });
});

withFixture("review complete blocks non-string base and head refs", (fx) => {
  const guidance = [
    reviewEvidence(fx, "code-reviewer", { base_ref: { sha: "base" } }),
    reviewEvidence(fx, "architect"),
    reviewEvidence(fx, "critic"),
  ];
  const evidences = [
    ...prepareProposeComplete(fx, { checked: true }),
    greenEvidence(),
    ...guidance,
    mainAdjudication(fx, guidance),
    verifyEvidence(fx, "verifier"),
    verifyEvidence(fx, "critic"),
    finalTestEvidence(fx),
  ];
  withRuntime({ openspec_validate: () => [true, ""], dirty_worktree_reasons: () => [] }, () => {
    const decision = guard.check_review_complete("demo-change", status(fx), fx.change, evidences);
    assert.equal(decision.allowed, false);
    assert.ok(codes(decision.block_reasons).includes("review_evidence_incomplete"));
  });
});

withFixture("review complete allows when reviewed files cover diff", (fx) => {
  const guidance = [
    ...reviewGuidanceEvidences(fx, { reviewed_files: ["tasks.md", "src/service.py"] }),
    reviewEvidence(fx, "critic", { reviewed_files: ["tasks.md", "src/service.py"] }),
  ];
  const evidences = [
    ...prepareProposeComplete(fx, { checked: true }),
    greenEvidence(),
    ...guidance,
    mainAdjudication(fx, guidance),
    verifyEvidence(fx, "verifier"),
    verifyEvidence(fx, "critic"),
    finalTestEvidence(fx),
  ];
  withRuntime({
    openspec_validate: () => [true, ""],
    dirty_worktree_reasons: () => [],
    review_diff_paths: () => ["tasks.md", "src/service.py"],
  }, () => {
    const decision = guard.check_review_complete("demo-change", status(fx), fx.change, evidences);
    assert.equal(decision.allowed, true, JSON.stringify(decision));
  });
});

withFixture("review complete blocks missing architect guidance", (fx) => {
  const guidance = [
    reviewEvidence(fx, "code-reviewer", { reviewed_files: ["tasks.md", "src/service.py"] }),
    reviewEvidence(fx, "critic", { reviewed_files: ["tasks.md", "src/service.py"] }),
  ];
  const evidences = [
    ...prepareProposeComplete(fx, { checked: true }),
    greenEvidence(),
    ...guidance,
    mainAdjudication(fx, guidance),
    verifyEvidence(fx, "verifier"),
    verifyEvidence(fx, "critic"),
    finalTestEvidence(fx),
  ];
  withRuntime({
    openspec_validate: () => [true, ""],
    dirty_worktree_reasons: () => [],
    review_diff_paths: () => ["tasks.md", "src/service.py"],
  }, () => {
    const decision = guard.check_review_complete("demo-change", status(fx), fx.change, evidences);
    assert.equal(decision.allowed, false);
    assert.ok(codes(decision.block_reasons).includes("missing_source_guidance"));
    const collectAction = decision.next_allowed_actions.find((item: string) => item.includes("collect review_complete source_guidance from missing roles:"));
    assert.ok(collectAction?.includes("architect"));
    assert.ok(!collectAction?.includes("code-reviewer"));
    assert.ok(!collectAction?.includes("critic"));
  });
});

withFixture("review ready preserves propose actions without generic fallback", (fx) => {
  withRuntime({ openspec_validate: () => [true, ""], dirty_worktree_reasons: () => [] }, () => {
    const decision = guard.check_review_ready("demo-change", status(fx), fx.change, []);
    assert.equal(decision.allowed, false);
    assert.ok(decision.next_allowed_actions.includes("pass explore_complete, proposal_reviewed, design_complete, invariants_reviewed, test_contract_drafted, and tasks_complete"));
    assert.ok(!decision.next_allowed_actions.some((item: string) => item.includes("pass check-apply-ready")));
  });
});

withFixture("review complete blocks legacy workflow evidence without main adjudication", (fx) => {
  const evidences = [
    ...prepareProposeComplete(fx, { checked: true }),
    greenEvidence(),
    legacyCodeReviewWorkflowEvidence(fx),
    reviewEvidence(fx, "critic"),
    verifyEvidence(fx, "verifier"),
    verifyEvidence(fx, "critic"),
    finalTestEvidence(fx),
  ];
  withRuntime({ openspec_validate: () => [true, ""], dirty_worktree_reasons: () => [] }, () => {
    const decision = guard.check_review_complete("demo-change", status(fx), fx.change, evidences);
    assert.equal(decision.allowed, false);
    assert.ok(codes(decision.block_reasons).includes("missing_main_adjudication"));
  });
});

withFixture("review complete blocks when main adjudication omits required claim", (fx) => {
  const guidance = [
    ...reviewGuidanceEvidences(fx),
    reviewEvidence(fx, "critic", { required_claim_ids: ["CLAIM-CRITIC-001", "CLAIM-CRITIC-002"] }),
  ];
  const evidences = [
    ...prepareProposeComplete(fx, { checked: true }),
    greenEvidence(),
    ...guidance,
    mainAdjudication(fx, guidance, {
      claim_adjudications: [
        { claim_id: "CLAIM-CODE-REVIEWER-001", decision: "accept", rationale: "accepted" },
        { claim_id: "CLAIM-ARCHITECT-001", decision: "accept", rationale: "accepted" },
        { claim_id: "CLAIM-CRITIC-001", decision: "accept", rationale: "accepted" },
      ],
    }),
    verifyEvidence(fx, "verifier"),
    verifyEvidence(fx, "critic"),
    finalTestEvidence(fx),
  ];
  withRuntime({ openspec_validate: () => [true, ""], dirty_worktree_reasons: () => [] }, () => {
    const decision = guard.check_review_complete("demo-change", status(fx), fx.change, evidences);
    assert.equal(decision.allowed, false);
    assert.ok(codes(decision.block_reasons).includes("required_claim_unadjudicated"));
  });
});

withFixture("A-5 request_changes uses shared adjudication coverage helper", (fx) => {
  const guidance = [
    ...reopenGuidanceEvidences(fx),
    reviewEvidence(fx, "critic", { required_claim_ids: ["CLAIM-CRITIC-001", "CLAIM-CRITIC-002"] }),
  ];
  const evidences = [
    ...prepareProposeComplete(fx, { checked: true }),
    greenEvidence(),
    ...guidance,
    mainAdjudication(fx, guidance, {
      review_decision: "request_changes",
      request_changes_route: "reopen_tasks",
      blocking_source_evidence_refs: ["EV-code-reviewer-guidance"],
      reopen_task_ids: ["TASK-001"],
      claim_adjudications: [
        { claim_id: "CLAIM-CODE-REVIEWER-001", decision: "accept", rationale: "accepted" },
        { claim_id: "CLAIM-ARCHITECT-001", decision: "accept", rationale: "accepted" },
        { claim_id: "CLAIM-CRITIC-001", decision: "accept", rationale: "accepted" },
      ],
    }),
  ];
  withRuntime({ openspec_validate: () => [true, ""], dirty_worktree_reasons: () => [] }, () => {
    const decision = guard.check_review_complete("demo-change", status(fx), fx.change, evidences);
    assert.equal(decision.allowed, false);
    assert.ok(codes(decision.block_reasons).includes("required_claim_unadjudicated"));
    assert.ok(!decision.next_allowed_actions.some((item: string) => item.includes("task_reopen")));
  });
});

withFixture("review complete blocks when main adjudication omits required load", (fx) => {
  const guidance = [
    ...reviewGuidanceEvidences(fx),
    reviewEvidence(fx, "critic"),
  ];
  const missingLoad = guidance[2].required_load_refs[0];
  const evidences = [
    ...prepareProposeComplete(fx, { checked: true }),
    greenEvidence(),
    ...guidance,
    mainAdjudication(fx, guidance, {
      loaded_refs: guidance
        .flatMap((ev) => Array.isArray(ev.required_load_refs) ? ev.required_load_refs : [])
        .filter((refItem: JsonMap) => refItem.path !== missingLoad.path || refItem.blob_sha !== missingLoad.blob_sha)
        .map((refItem: JsonMap) => ({ ...refItem })),
    }),
    verifyEvidence(fx, "verifier"),
    verifyEvidence(fx, "critic"),
    finalTestEvidence(fx),
  ];
  withRuntime({ openspec_validate: () => [true, ""], dirty_worktree_reasons: () => [] }, () => {
    const decision = guard.check_review_complete("demo-change", status(fx), fx.change, evidences);
    assert.equal(decision.allowed, false);
    assert.ok(codes(decision.block_reasons).includes("required_load_unloaded"));
  });
});

withFixture("review complete blocks when main adjudication omits verification evidence refs", (fx) => {
  const guidance = [
    ...reviewGuidanceEvidences(fx),
    reviewEvidence(fx, "critic"),
  ];
  const evidences = [
    ...prepareProposeComplete(fx, { checked: true }),
    greenEvidence(),
    ...guidance,
    mainAdjudication(fx, guidance, { verification_evidence_refs: ["EV-verifier-verification", "EV-final-test"] }),
    verifyEvidence(fx, "verifier"),
    verifyEvidence(fx, "critic"),
    finalTestEvidence(fx),
  ];
  withRuntime({ openspec_validate: () => [true, ""], dirty_worktree_reasons: () => [] }, () => {
    const decision = guard.check_review_complete("demo-change", status(fx), fx.change, evidences);
    assert.equal(decision.allowed, false);
    assert.ok(codes(decision.block_reasons).includes("verification_evidence_unreferenced"));
  });
});

withFixture("review complete blocks unknown source evidence refs on allow path", (fx) => {
  const guidance = [
    ...reviewGuidanceEvidences(fx),
    reviewEvidence(fx, "critic"),
  ];
  const evidences = [
    ...prepareProposeComplete(fx, { checked: true }),
    greenEvidence(),
    ...guidance,
    mainAdjudication(fx, guidance, {
      source_evidence_refs: [...guidance.map((ev) => ev.evidence_id), "EV-fake-guidance"],
    }),
    verifyEvidence(fx, "verifier"),
    verifyEvidence(fx, "critic"),
    finalTestEvidence(fx),
  ];
  withRuntime({ openspec_validate: () => [true, ""], dirty_worktree_reasons: () => [] }, () => {
    const decision = guard.check_review_complete("demo-change", status(fx), fx.change, evidences);
    assert.equal(decision.allowed, false);
    assert.ok(codes(decision.block_reasons).includes("source_guidance_unreferenced"));
  });
});

withFixture("review complete blocks unknown verification evidence refs on allow path", (fx) => {
  const guidance = [
    ...reviewGuidanceEvidences(fx),
    reviewEvidence(fx, "critic"),
  ];
  const evidences = [
    ...prepareProposeComplete(fx, { checked: true }),
    greenEvidence(),
    ...guidance,
    mainAdjudication(fx, guidance, {
      verification_evidence_refs: ["EV-verifier-verification", "EV-critic-verification", "EV-final-test", "EV-fake-final"],
    }),
    verifyEvidence(fx, "verifier"),
    verifyEvidence(fx, "critic"),
    finalTestEvidence(fx),
  ];
  withRuntime({ openspec_validate: () => [true, ""], dirty_worktree_reasons: () => [] }, () => {
    const decision = guard.check_review_complete("demo-change", status(fx), fx.change, evidences);
    assert.equal(decision.allowed, false);
    assert.ok(codes(decision.block_reasons).includes("verification_evidence_unreferenced"));
  });
});

withFixture("review complete blocks wrong-kind verification evidence refs on allow path", (fx) => {
  const guidance = [
    ...reviewGuidanceEvidences(fx),
    reviewEvidence(fx, "critic"),
  ];
  const wrongKindVerification = passEvidence("review_complete", "review", {
    evidence_id: "EV-wrong-kind-verifier",
    agent_role: "verifier",
  });
  const evidences = [
    ...prepareProposeComplete(fx, { checked: true }),
    greenEvidence(),
    ...guidance,
    mainAdjudication(fx, guidance, {
      verification_evidence_refs: ["EV-verifier-verification", "EV-critic-verification", "EV-final-test", "EV-wrong-kind-verifier"],
    }),
    verifyEvidence(fx, "verifier"),
    verifyEvidence(fx, "critic"),
    finalTestEvidence(fx),
    wrongKindVerification,
  ];
  withRuntime({ openspec_validate: () => [true, ""], dirty_worktree_reasons: () => [] }, () => {
    const decision = guard.check_review_complete("demo-change", status(fx), fx.change, evidences);
    assert.equal(decision.allowed, false);
    assert.ok(codes(decision.block_reasons).includes("verification_evidence_unreferenced"));
  });
});

withFixture("review complete blocks when blocking finding lacks adjudication", (fx) => {
  const guidance = [
    ...reviewGuidanceEvidences(fx),
    reviewEvidence(fx, "critic", {
      blocking_findings: [{ finding_id: "FINDING-001", summary: "critical issue" }],
      finding_dispositions: [{ finding_id: "FINDING-001", recommendation: "fix", rationale: "must fix" }],
    }),
  ];
  const evidences = [
    ...prepareProposeComplete(fx, { checked: true }),
    greenEvidence(),
    ...guidance,
    mainAdjudication(fx, guidance, { finding_adjudications: [] }),
    verifyEvidence(fx, "verifier"),
    verifyEvidence(fx, "critic"),
    finalTestEvidence(fx),
  ];
  withRuntime({ openspec_validate: () => [true, ""], dirty_worktree_reasons: () => [] }, () => {
    const decision = guard.check_review_complete("demo-change", status(fx), fx.change, evidences);
    assert.equal(decision.allowed, false);
    assert.ok(codes(decision.block_reasons).includes("blocking_findings_open"));
  });
});

withFixture("review complete requires final test evidence", (fx) => {
  const guidance = [
    ...reviewGuidanceEvidences(fx),
    reviewEvidence(fx, "critic"),
  ];
  const evidences = [
    ...prepareProposeComplete(fx, { checked: true }),
    greenEvidence(),
    ...guidance,
    mainAdjudication(fx, guidance),
    verifyEvidence(fx, "verifier"),
    verifyEvidence(fx, "critic"),
  ];
  withRuntime({ openspec_validate: () => [true, ""], dirty_worktree_reasons: () => [] }, () => {
    const decision = guard.check_review_complete("demo-change", status(fx), fx.change, evidences);
    assert.equal(decision.allowed, false);
    assert.ok(codes(decision.block_reasons).includes("missing_final_tests"));
  });
});

withFixture("review complete preserves review_ready actions without generic fallback", (fx) => {
  withRuntime({ dirty_worktree_reasons: () => [] }, () => {
    const decision = guard.check_review_complete("demo-change", status(fx), fx.change, prepareProposeComplete(fx, { checked: false }));
    assert.equal(decision.allowed, false);
    assert.ok(decision.next_allowed_actions.includes("finish remaining unchecked tasks and mark them complete only after check-task-complete passes"));
    assert.ok(!decision.next_allowed_actions.some((item: string) => item.includes("pass check-review-ready")));
  });
});

withFixture("review complete validate failure only recommends validate fix", (fx) => {
  const guidance = [
    ...reviewGuidanceEvidences(fx),
    reviewEvidence(fx, "critic"),
  ];
  const evidences = [
    ...prepareProposeComplete(fx, { checked: true }),
    greenEvidence(),
    ...guidance,
    mainAdjudication(fx, guidance),
    verifyEvidence(fx, "verifier"),
    verifyEvidence(fx, "critic"),
    finalTestEvidence(fx),
  ];
  withRuntime({ openspec_validate: () => [false, "invalid"], dirty_worktree_reasons: () => [] }, () => {
    const decision = guard.check_review_complete("demo-change", status(fx), fx.change, evidences);
    assert.equal(decision.allowed, false);
    assert.deepEqual(decision.next_allowed_actions, ["fix openspec validate failures for demo-change"]);
  });
});

withFixture("review complete missing final tests does not suggest verification repair", (fx) => {
  const guidance = [
    ...reviewGuidanceEvidences(fx),
    reviewEvidence(fx, "critic"),
  ];
  const evidences = [
    ...prepareProposeComplete(fx, { checked: true }),
    greenEvidence(),
    ...guidance,
    mainAdjudication(fx, guidance),
    verifyEvidence(fx, "verifier", { test_evidence_refs: ["EV-task_complete"] }),
    verifyEvidence(fx, "critic", { test_evidence_refs: ["EV-task_complete"] }),
  ];
  withRuntime({ openspec_validate: () => [true, ""], dirty_worktree_reasons: () => [] }, () => {
    const decision = guard.check_review_complete("demo-change", status(fx), fx.change, evidences);
    assert.equal(decision.allowed, false);
    assert.ok(decision.next_allowed_actions.includes("record final_test pass evidence and reference it from verification_review"));
    assert.ok(!decision.next_allowed_actions.some((item: string) => item.includes("repair verification_review references")));
    assert.ok(!decision.next_allowed_actions.some((item: string) => item.includes("repair main_adjudication")));
  });
});

withFixture("review complete ignores verification evidence recorded only under verify_complete gate", (fx) => {
  const guidance = [
    ...reviewGuidanceEvidences(fx),
    reviewEvidence(fx, "critic"),
  ];
  const evidences = [
    ...prepareProposeComplete(fx, { checked: true }),
    greenEvidence(),
    ...guidance,
    mainAdjudication(fx, guidance, { verification_evidence_refs: [] }),
    verifyEvidence(fx, "verifier", { gate: "verify_complete" }),
    verifyEvidence(fx, "critic", { gate: "verify_complete" }),
    finalTestEvidence(fx, { gate: "verify_complete" }),
  ];
  withRuntime({ openspec_validate: () => [true, ""], dirty_worktree_reasons: () => [] }, () => {
    const decision = guard.check_review_complete("demo-change", status(fx), fx.change, evidences);
    assert.equal(decision.allowed, false);
    assert.ok(codes(decision.block_reasons).includes("missing_final_verification_review"));
    assert.ok(codes(decision.block_reasons).includes("missing_final_tests"));
  });
});

withFixture("review complete blocks missing verification reference file", (fx) => {
  const guidance = [
    ...reviewGuidanceEvidences(fx),
    reviewEvidence(fx, "critic"),
  ];
  const evidences = [
    ...prepareProposeComplete(fx, { checked: true }),
    greenEvidence(),
    ...guidance,
    mainAdjudication(fx, guidance),
    verifyEvidence(fx, "verifier", {
      create_refs: false,
      openspec_validate_ref: ".superspec/raw/verifier-missing-validate.txt",
      task_matrix_ref: ".superspec/reports/verifier-missing-task-matrix.md",
      scope_drift_ref: ".superspec/reports/verifier-missing-scope-drift.md",
    }),
    verifyEvidence(fx, "critic"),
    finalTestEvidence(fx),
  ];
  withRuntime({ openspec_validate: () => [true, ""], dirty_worktree_reasons: () => [] }, () => {
    const decision = guard.check_review_complete("demo-change", status(fx), fx.change, evidences);
    assert.equal(decision.allowed, false);
    assert.ok(codes(decision.block_reasons).includes("verification_ref_missing"));
  });
});

withFixture("review complete requires invariant matrix reference", (fx) => {
  const guidance = [
    ...reviewGuidanceEvidences(fx),
    reviewEvidence(fx, "critic"),
  ];
  const verifier = verifyEvidence(fx, "verifier", { invariant_matrix_ref: ".superspec/reports/verifier-invariant-matrix.md" });
  unlinkSync(join(fx.change, ".superspec", "reports", "verifier-invariant-matrix.md"));
  const evidences = [
    ...prepareProposeComplete(fx, { checked: true }),
    greenEvidence(),
    ...guidance,
    mainAdjudication(fx, guidance),
    verifier,
    verifyEvidence(fx, "critic"),
    finalTestEvidence(fx),
  ];
  withRuntime({ openspec_validate: () => [true, ""], dirty_worktree_reasons: () => [] }, () => {
    const decision = guard.check_review_complete("demo-change", status(fx), fx.change, evidences);
    assert.equal(decision.allowed, false);
    assert.ok(codes(decision.block_reasons).includes("verification_ref_missing"));
  });
});

withFixture("review complete rejects empty invariant matrix", (fx) => {
  const guidance = [
    ...reviewGuidanceEvidences(fx),
    reviewEvidence(fx, "critic"),
  ];
  const verifier = verifyEvidence(fx, "verifier", { invariant_matrix_ref: ".superspec/reports/verifier-invariant-matrix.md" });
  writeText(join(fx.change, ".superspec", "reports", "verifier-invariant-matrix.md"), "");
  const evidences = [
    ...prepareProposeComplete(fx, { checked: true }),
    greenEvidence(),
    ...guidance,
    mainAdjudication(fx, guidance),
    verifier,
    verifyEvidence(fx, "critic"),
    finalTestEvidence(fx),
  ];
  withRuntime({ openspec_validate: () => [true, ""], dirty_worktree_reasons: () => [] }, () => {
    const decision = guard.check_review_complete("demo-change", status(fx), fx.change, evidences);
    assert.equal(decision.allowed, false);
    assert.ok(codes(decision.block_reasons).includes("invariant_matrix_incomplete"));
  });
});

withFixture("review complete rejects invariant matrix paragraph token without table row", (fx) => {
  const guidance = [
    ...reviewGuidanceEvidences(fx),
    reviewEvidence(fx, "critic"),
  ];
  const verifier = verifyEvidence(fx, "verifier", { invariant_matrix_ref: ".superspec/reports/verifier-invariant-matrix.md" });
  writeText(join(fx.change, ".superspec", "reports", "verifier-invariant-matrix.md"), "INV-001 pass EV-final-test\n");
  const evidences = [
    ...prepareProposeComplete(fx, { checked: true }),
    greenEvidence(),
    ...guidance,
    mainAdjudication(fx, guidance),
    verifier,
    verifyEvidence(fx, "critic"),
    finalTestEvidence(fx),
  ];
  withRuntime({ openspec_validate: () => [true, ""], dirty_worktree_reasons: () => [] }, () => {
    const decision = guard.check_review_complete("demo-change", status(fx), fx.change, evidences);
    assert.equal(decision.allowed, false);
    assert.ok(codes(decision.block_reasons).includes("invariant_matrix_incomplete"));
  });
});

withFixture("review complete rejects invariant matrix confirmed status", (fx) => {
  const guidance = [
    ...reviewGuidanceEvidences(fx),
    reviewEvidence(fx, "critic"),
  ];
  const verifier = verifyEvidence(fx, "verifier", { invariant_matrix_ref: ".superspec/reports/verifier-invariant-matrix.md" });
  writeText(join(fx.change, ".superspec", "reports", "verifier-invariant-matrix.md"), invariantMatrixText([{ status: "confirmed", evidence: "EV-final-test" }]));
  const evidences = [
    ...prepareProposeComplete(fx, { checked: true }),
    greenEvidence(),
    ...guidance,
    mainAdjudication(fx, guidance),
    verifier,
    verifyEvidence(fx, "critic"),
    finalTestEvidence(fx),
  ];
  withRuntime({ openspec_validate: () => [true, ""], dirty_worktree_reasons: () => [] }, () => {
    const decision = guard.check_review_complete("demo-change", status(fx), fx.change, evidences);
    assert.equal(decision.allowed, false);
    assert.ok(codes(decision.block_reasons).includes("invariant_matrix_incomplete"));
  });
});

withFixture("review complete rejects invariant matrix unknown evidence id", (fx) => {
  const guidance = [
    ...reviewGuidanceEvidences(fx),
    reviewEvidence(fx, "critic"),
  ];
  const verifier = verifyEvidence(fx, "verifier", { invariant_matrix_ref: ".superspec/reports/verifier-invariant-matrix.md" });
  writeText(join(fx.change, ".superspec", "reports", "verifier-invariant-matrix.md"), invariantMatrixText([{ evidence: "EV-missing-final-test" }]));
  const evidences = [
    ...prepareProposeComplete(fx, { checked: true }),
    greenEvidence(),
    ...guidance,
    mainAdjudication(fx, guidance),
    verifier,
    verifyEvidence(fx, "critic"),
    finalTestEvidence(fx),
  ];
  withRuntime({ openspec_validate: () => [true, ""], dirty_worktree_reasons: () => [] }, () => {
    const decision = guard.check_review_complete("demo-change", status(fx), fx.change, evidences);
    assert.equal(decision.allowed, false);
    assert.ok(codes(decision.block_reasons).includes("invariant_matrix_incomplete"));
  });
});

withFixture("review complete validates verifier and critic invariant matrices independently", (fx) => {
  const guidance = [
    ...reviewGuidanceEvidences(fx),
    reviewEvidence(fx, "critic"),
  ];
  const criticVerification = verifyEvidence(fx, "critic", { invariant_matrix_ref: ".superspec/reports/critic-invariant-matrix.md" });
  writeText(join(fx.change, ".superspec", "reports", "critic-invariant-matrix.md"), invariantMatrixText([{ inv_id: "INV-OTHER", evidence: "EV-final-test" }]));
  const evidences = [
    ...prepareProposeComplete(fx, { checked: true }),
    greenEvidence(),
    ...guidance,
    mainAdjudication(fx, guidance),
    verifyEvidence(fx, "verifier"),
    criticVerification,
    finalTestEvidence(fx),
  ];
  withRuntime({ openspec_validate: () => [true, ""], dirty_worktree_reasons: () => [] }, () => {
    const decision = guard.check_review_complete("demo-change", status(fx), fx.change, evidences);
    assert.equal(decision.allowed, false);
    assert.ok(codes(decision.block_reasons).includes("invariant_matrix_incomplete"));
  });
});

withFixture("review complete accepts non EV-prefixed evidence id in invariant matrix", (fx) => {
  const guidance = [
    ...reviewGuidanceEvidences(fx),
    reviewEvidence(fx, "critic"),
  ];
  const finalTest = finalTestEvidence(fx, { evidence_id: "final-test-custom" });
  const verifier = verifyEvidence(fx, "verifier", {
    test_evidence_refs: ["final-test-custom"],
    invariant_matrix_ref: ".superspec/reports/verifier-invariant-matrix.md",
  });
  const criticVerification = verifyEvidence(fx, "critic", {
    test_evidence_refs: ["final-test-custom"],
    invariant_matrix_ref: ".superspec/reports/critic-invariant-matrix.md",
  });
  writeText(join(fx.change, ".superspec", "reports", "verifier-invariant-matrix.md"), invariantMatrixText([{ evidence: "`final-test-custom`" }]));
  writeText(join(fx.change, ".superspec", "reports", "critic-invariant-matrix.md"), invariantMatrixText([{ evidence: "[final-test-custom](../raw/final-test.log)" }]));
  const evidences = [
    ...prepareProposeComplete(fx, { checked: true }),
    greenEvidence(),
    ...guidance,
    mainAdjudication(fx, guidance, { verification_evidence_refs: ["EV-verifier-verification", "EV-critic-verification", "final-test-custom"] }),
    verifier,
    criticVerification,
    finalTest,
  ];
  withRuntime({ openspec_validate: () => [true, ""], dirty_worktree_reasons: () => [] }, () => {
    const decision = guard.check_review_complete("demo-change", status(fx), fx.change, evidences);
    assert.equal(decision.allowed, true, JSON.stringify(decision));
  });
});

withFixture("review complete blocks unknown test evidence ref", (fx) => {
  const guidance = [
    ...reviewGuidanceEvidences(fx),
    reviewEvidence(fx, "critic"),
  ];
  const evidences = [
    ...prepareProposeComplete(fx, { checked: true }),
    greenEvidence(),
    ...guidance,
    mainAdjudication(fx, guidance),
    verifyEvidence(fx, "verifier", { test_evidence_refs: ["EV-missing"] }),
    verifyEvidence(fx, "critic"),
    finalTestEvidence(fx),
  ];
  withRuntime({ openspec_validate: () => [true, ""], dirty_worktree_reasons: () => [] }, () => {
    const decision = guard.check_review_complete("demo-change", status(fx), fx.change, evidences);
    assert.equal(decision.allowed, false);
    assert.ok(codes(decision.block_reasons).includes("test_evidence_ref_missing"));
  });
});

withFixture("archive ready requires archive confirmation gate", (fx) => {
  const guidance = [
    ...reviewGuidanceEvidences(fx),
    reviewEvidence(fx, "critic"),
  ];
  const evidences = [
    ...prepareProposeComplete(fx, { checked: true }),
    greenEvidence(),
    ...guidance,
    mainAdjudication(fx, guidance),
    verifyEvidence(fx, "verifier"),
    verifyEvidence(fx, "critic"),
    finalTestEvidence(fx),
    passEvidence("design_complete", "human_confirmation"),
  ];
  withRuntime({ openspec_validate: () => [true, ""], dirty_worktree_reasons: () => [] }, () => {
    const decision = guard.check_archive_ready("demo-change", status(fx), fx.change, evidences);
    assert.equal(decision.allowed, false);
    assert.ok(codes(decision.block_reasons).includes("missing_final_confirmation"));
    assert.ok(decision.next_allowed_actions.some((item: string) => item.includes("archive_ready human_confirmation")));
  });
});

withFixture("archive ready preserves inherited review actions without generic fallback", (fx) => {
  const guidance = [
    ...reviewGuidanceEvidences(fx),
    reviewEvidence(fx, "critic"),
  ];
  const evidences = [
    ...prepareProposeComplete(fx, { checked: false }),
    ...guidance,
    mainAdjudication(fx, guidance),
    verifyEvidence(fx, "verifier"),
    verifyEvidence(fx, "critic"),
    finalTestEvidence(fx),
    passEvidence("archive_ready", "human_confirmation"),
  ];
  withRuntime({ openspec_validate: () => [true, ""], dirty_worktree_reasons: () => [] }, () => {
    const decision = guard.check_archive_ready("demo-change", status(fx), fx.change, evidences);
    assert.equal(decision.allowed, false);
    assert.ok(decision.next_allowed_actions.includes("finish remaining unchecked tasks and mark them complete only after check-task-complete passes"));
    assert.ok(!decision.next_allowed_actions.some((item: string) => item.includes("pass check-review-complete")));
  });
});

withFixture("dispatch retries transient state lock contention", (fx) => {
  guard.ensure_sidecar_layout(fx.change);
  const lock = join(fx.change, ".superspec", "superspec-state.lock");
  writeText(lock, "");
  const releaser = spawn("sh", ["-c", `sleep 0.1 && rm -f ${JSON.stringify(lock)}`], { stdio: "ignore" });
  releaser.unref();
  withRuntime({ load_context: () => [status(fx), fx.repo, fx.change, []] }, () => {
    const [decision] = guard.dispatch({ command: "recompute", change: "demo-change" });
    assert.equal(decision.allowed, true, JSON.stringify(decision));
  });
});

withFixture("A-2 stale lock is reclaimed after holder death", (fx) => {
  guard.ensure_sidecar_layout(fx.change);
  const lock = join(fx.change, ".superspec", "superspec-state.lock");
  writeText(lock, `${JSON.stringify({
    pid: 999_999_999,
    hostname: hostname(),
    created_at: new Date().toISOString(),
  })}\n`);
  withRuntime({ load_context: () => [status(fx), fx.repo, fx.change, []] }, () => {
    const [decision] = guard.dispatch({ command: "recompute", change: "demo-change" });
    assert.equal(decision.allowed, true, JSON.stringify(decision));
    assert.equal(existsSync(lock), false);
  });
});

withFixture("A-2 live aged state lock is not reclaimed", (fx) => {
  guard.ensure_sidecar_layout(fx.change);
  const lock = join(fx.change, ".superspec", "superspec-state.lock");
  writeText(lock, `${JSON.stringify({
    pid: process.pid,
    hostname: hostname(),
    created_at: "2000-01-01T00:00:00.000Z",
  })}\n`);
  withRuntime({
    load_context: () => [status(fx), fx.repo, fx.change, []],
    max_state_write_retries: 1,
  }, () => {
    assert.throws(
      () => guard.dispatch({ command: "recompute", change: "demo-change" }),
      /state_concurrent_update:/,
    );
    assert.equal(existsSync(lock), true);
  });
});

withFixture("A-2 recompute force-unlock removes fresh state lock", (fx) => {
  guard.ensure_sidecar_layout(fx.change);
  const lock = join(fx.change, ".superspec", "superspec-state.lock");
  writeText(lock, `${JSON.stringify({
    pid: process.pid,
    hostname: "localhost",
    created_at: new Date().toISOString(),
  })}\n`);
  withRuntime({ load_context: () => [status(fx), fx.repo, fx.change, []] }, () => {
    const [decision] = guard.dispatch({ command: "recompute", change: "demo-change", force_unlock: true });
    assert.equal(decision.allowed, true, JSON.stringify(decision));
    assert.equal(existsSync(lock), false);
  });
});

withFixture("A-2 recompute force-unlock rejects live state lock", (fx) => {
  guard.ensure_sidecar_layout(fx.change);
  const lock = join(fx.change, ".superspec", "superspec-state.lock");
  writeText(lock, `${JSON.stringify({
    pid: process.pid,
    hostname: hostname(),
    created_at: "2000-01-01T00:00:00.000Z",
  })}\n`);
  withRuntime({ load_context: () => [status(fx), fx.repo, fx.change, []] }, () => {
    assert.throws(
      () => guard.dispatch({ command: "recompute", change: "demo-change", force_unlock: true }),
      /refusing --force-unlock for live guard process/,
    );
    assert.equal(existsSync(lock), true);
  });
});

test("A-4c ledger created_at and event_id cannot be overridden by caller", () => {
  const event = guard.materialize_ledger_event({
    event_id: "EVT-user",
    created_at: "2000-01-01T00:00:00.000Z",
    kind: "guard_decision",
  });
  assert.notEqual(event.event_id, "EVT-user");
  assert.notEqual(event.created_at, "2000-01-01T00:00:00.000Z");
  assert.equal(event.kind, "guard_decision");
});

test("A-4a ledger event ids are unique within the same millisecond", () => {
  const originalNow = Date.now;
  Date.now = () => 42;
  try {
    const first = guard.materialize_ledger_event({ kind: "guard_decision" });
    const second = guard.materialize_ledger_event({ kind: "guard_decision" });
    assert.notEqual(first.event_id, second.event_id);
  } finally {
    Date.now = originalNow;
  }
});

withFixture("role evidence direct execution blocks", (fx) => {
  writeText(join(fx.change, ".superspec", "reports", "critic.md"), "pass\n");
  const ev = passEvidence("design_complete", "review", {
    agent_role: "critic",
    execution_mode: "direct",
    agent_id: "agent-1",
    prompt_ref: ".superspec/reports/prompt.md",
    output_ref: ".superspec/reports/critic.md",
    source_anchors: [],
    target_refs: [],
  });
  const problems = guard.validate_evidence_schema(ev, "demo-change", fx.change, fx.repo);
  assert.ok(codes(problems).includes("self_review_not_allowed"));
});

withFixture("role evidence main thread marker blocks", (fx) => {
  const ev = roleEvidence(fx, "design_complete", "critic", { created_by: "leader" });
  const problems = guard.validate_evidence_schema(ev, "demo-change", fx.change, fx.repo);
  assert.ok(codes(problems).includes("self_review_not_allowed"));
});

withFixture("role evidence stale target blob blocks", (fx) => {
  writeText(join(fx.change, "design.md"), "v1\n");
  const ev = roleEvidence(fx, "design_complete", "critic", {
    target_refs: [{ path: "design.md", blob_sha: "0000000000000000000000000000000000000000" }],
  });
  const problems = guard.validate_evidence_schema(ev, "demo-change", fx.change, fx.repo);
  assert.ok(codes(problems).includes("stale_review"));
});

withFixture("role evidence missing target file blocks without throwing", (fx) => {
  const ev = roleEvidence(fx, "design_complete", "critic", {
    target_refs: [{ path: "missing-design.md", blob_sha: "sha256:missing" }],
  });
  const problems = guard.validate_evidence_schema(ev, "demo-change", fx.change, fx.repo);
  assert.ok(codes(problems).includes("stale_review"));
});

withFixture("A-7 role evidence with empty output_ref is rejected", (fx) => {
  const ev = roleEvidence(fx, "design_complete", "critic", {
    output_ref: ".superspec/reports/empty-review.md",
  });
  writeText(join(fx.change, ".superspec", "reports", "empty-review.md"), "");
  const problems = guard.validate_evidence_schema(ev, "demo-change", fx.change, fx.repo);
  assert.ok(codes(problems).includes("evidence_output_empty"));
});

withFixture("A-7 role evidence output_ref cannot point at a reviewed target", (fx) => {
  const outputRef = ".superspec/reports/reviewed-target.md";
  const ev = roleEvidence(fx, "design_complete", "critic", {
    output_ref: outputRef,
  });
  ev.target_refs = [{ path: outputRef, blob_sha: guard.file_blob_sha(join(fx.change, outputRef)) }];
  const problems = guard.validate_evidence_schema(ev, "demo-change", fx.change, fx.repo);
  assert.ok(codes(problems).includes("evidence_output_ref_invalid"));
});

withFixture("A-7 role evidence output_ref hardlink cannot point at a reviewed target", (fx) => {
  const targetRel = ".superspec/reports/reviewed-target.md";
  const hardlinkRel = ".superspec/reports/reviewed-target-hardlink.md";
  const ev = roleEvidence(fx, "design_complete", "critic", {
    output_ref: hardlinkRel,
  });
  const targetPath = join(fx.change, targetRel);
  const hardlinkPath = join(fx.change, hardlinkRel);
  writeText(targetPath, "reviewed target\n");
  unlinkSync(hardlinkPath);
  linkSync(targetPath, hardlinkPath);
  ev.target_refs = [{ path: targetRel, blob_sha: guard.file_blob_sha(targetPath) }];
  const problems = guard.validate_evidence_schema(ev, "demo-change", fx.change, fx.repo);
  assert.ok(codes(problems).includes("evidence_output_ref_invalid"));
});

withFixture("role evidence fresh target blob allows", (fx) => {
  const target = join(fx.change, "design.md");
  writeText(target, "v1\n");
  const ev = roleEvidence(fx, "design_complete", "critic", {
    target_refs: [{ path: "design.md", blob_sha: guard.file_blob_sha(target) }],
  });
  assert.deepEqual(guard.validate_evidence_schema(ev, "demo-change", fx.change, fx.repo), []);
});

test("A-6 file_blob_sha ignores git clean filters", () => {
  const tmp = mkdtempSync(join(tmpdir(), "superspec-filter-"));
  try {
    spawnSync("git", ["init"], { cwd: tmp, stdio: "ignore" });
    writeText(join(tmp, ".gitattributes"), "*.txt filter=upper\n");
    spawnSync("git", ["config", "filter.upper.clean", "tr a-z A-Z"], { cwd: tmp, stdio: "ignore" });
    const filePath = join(tmp, "file.txt");
    const upperPath = join(tmp, "upper.txt");
    writeText(filePath, "abc\n");
    writeText(upperPath, "ABC\n");

    const raw = spawnSync("git", ["hash-object", "--no-filters", filePath], { cwd: tmp, encoding: "utf8" }).stdout.trim();
    const filtered = spawnSync("git", ["hash-object", "--path=file.txt", filePath], { cwd: tmp, encoding: "utf8" }).stdout.trim();
    const upper = spawnSync("git", ["hash-object", "--no-filters", upperPath], { cwd: tmp, encoding: "utf8" }).stdout.trim();

    assert.notEqual(raw, filtered);
    assert.equal(filtered, upper);
    assert.equal(guard.file_blob_sha(filePath), raw);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

withFixture("source guidance invalid source ref blocks", (fx) => {
  const ev = reviewEvidence(fx, "critic", { source_refs: [{ path: "../escape.md", blob_sha: "sha1" }] });
  const problems = guard.validate_evidence_schema(ev, "demo-change", fx.change, fx.repo);
  assert.ok(codes(problems).includes("evidence_unsafe_ref"));
});

withFixture("main adjudication stale loaded ref blocks", (fx) => {
  const guidance = [
    ...reviewGuidanceEvidences(fx),
    reviewEvidence(fx, "critic"),
  ];
  const ev = mainAdjudication(fx, guidance, {
    loaded_refs: guidance
      .flatMap((item) => item.required_load_refs)
      .map((refItem: JsonMap) => ({ path: refItem.path, blob_sha: "0000000000000000000000000000000000000000" })),
  });
  const problems = guard.validate_evidence_schema(ev, "demo-change", fx.change, fx.repo);
  assert.ok(codes(problems).includes("stale_loaded_ref"));
});

withFixture("main adjudication missing loaded ref file blocks without throwing", (fx) => {
  const guidance = [
    ...reviewGuidanceEvidences(fx),
    reviewEvidence(fx, "critic"),
  ];
  const ev = mainAdjudication(fx, guidance, {
    loaded_refs: [{ path: "missing-loaded-ref.md", blob_sha: "sha256:missing" }],
  });
  const problems = guard.validate_evidence_schema(ev, "demo-change", fx.change, fx.repo);
  assert.ok(codes(problems).includes("stale_loaded_ref"));
});

withFixture("main adjudication request_changes requires route", (fx) => {
  const guidance = [
    ...reviewGuidanceEvidences(fx),
    reviewEvidence(fx, "critic"),
  ];
  const ev = mainAdjudication(fx, guidance, {
    review_decision: "request_changes",
    blocking_source_evidence_refs: ["EV-code-reviewer-guidance"],
    verification_evidence_refs: [],
  });
  const problems = guard.validate_evidence_schema(ev, "demo-change", fx.change, fx.repo);
  assert.ok(codes(problems).includes("main_adjudication_invalid"));
});

withFixture("main adjudication rejects comment verdict", (fx) => {
  const guidance = [
    ...reviewGuidanceEvidences(fx),
    reviewEvidence(fx, "critic"),
  ];
  const ev = mainAdjudication(fx, guidance, { review_decision: "comment" });
  const problems = guard.validate_evidence_schema(ev, "demo-change", fx.change, fx.repo);
  assert.ok(codes(problems).includes("main_adjudication_invalid"));
});

withFixture("main adjudication requires canonical main-thread author boundary", (fx) => {
  const guidance = [
    ...reviewGuidanceEvidences(fx),
    reviewEvidence(fx, "critic"),
  ];
  const wrongMode = mainAdjudication(fx, guidance, { execution_mode: "workflow" });
  const wrongAuthor = mainAdjudication(fx, guidance, { created_by: "critic" });
  const forgedAgent = mainAdjudication(fx, guidance, { agent_id: "agent-critic" });
  assert.ok(codes(guard.validate_evidence_schema(wrongMode, "demo-change", fx.change, fx.repo)).includes("main_adjudication_invalid"));
  assert.ok(codes(guard.validate_evidence_schema(wrongAuthor, "demo-change", fx.change, fx.repo)).includes("main_adjudication_invalid"));
  assert.ok(codes(guard.validate_evidence_schema(forgedAgent, "demo-change", fx.change, fx.repo)).includes("main_adjudication_invalid"));
});

withFixture("main adjudication allow requires verification evidence refs", (fx) => {
  const guidance = [
    ...reviewGuidanceEvidences(fx),
    reviewEvidence(fx, "critic"),
  ];
  const ev = mainAdjudication(fx, guidance, { verification_evidence_refs: [] });
  const problems = guard.validate_evidence_schema(ev, "demo-change", fx.change, fx.repo);
  assert.ok(codes(problems).includes("main_adjudication_invalid"));
});

withFixture("main adjudication request_changes allows empty verification evidence refs", (fx) => {
  const guidance = [
    ...reopenGuidanceEvidences(fx),
    reviewEvidence(fx, "critic"),
  ];
  const ev = mainAdjudication(fx, guidance, {
    review_decision: "request_changes",
    request_changes_route: "reopen_tasks",
    blocking_source_evidence_refs: ["EV-code-reviewer-guidance"],
    reopen_task_ids: ["TASK-001"],
    verification_evidence_refs: [],
  });
  const problems = guard.validate_evidence_schema(ev, "demo-change", fx.change, fx.repo);
  assert.ok(!codes(problems).includes("main_adjudication_invalid"), JSON.stringify(problems));
});

withFixture("main adjudication request_changes rejects verification evidence refs", (fx) => {
  const guidance = [
    ...reviewGuidanceEvidences(fx),
    reviewEvidence(fx, "critic"),
  ];
  const ev = mainAdjudication(fx, guidance, {
    review_decision: "request_changes",
    request_changes_route: "reopen_tasks",
    blocking_source_evidence_refs: ["EV-code-reviewer-guidance"],
    reopen_task_ids: ["TASK-001"],
    verification_evidence_refs: ["EV-verifier-verification"],
  });
  const problems = guard.validate_evidence_schema(ev, "demo-change", fx.change, fx.repo);
  assert.ok(codes(problems).includes("main_adjudication_invalid"));
});

withFixture("review complete blocks request_changes and hands off to apply", (fx) => {
  const guidance = [
    ...reopenGuidanceEvidences(fx),
    reviewEvidence(fx, "critic"),
  ];
  const evidences = [
    ...prepareProposeComplete(fx, { checked: true }),
    greenEvidence(),
    ...guidance,
    mainAdjudication(fx, guidance, {
      review_decision: "request_changes",
      request_changes_route: "reopen_tasks",
      blocking_source_evidence_refs: ["EV-code-reviewer-guidance"],
      reopen_task_ids: ["TASK-001"],
    }),
  ];
  withRuntime({ openspec_validate: () => [true, ""], dirty_worktree_reasons: () => [] }, () => {
    const decision = guard.check_review_complete("demo-change", status(fx), fx.change, evidences);
    const reasonSet = codes(decision.block_reasons);
    assert.equal(decision.allowed, false);
    assert.ok(reasonSet.includes("review_requests_changes"));
    assert.ok(!reasonSet.includes("missing_final_verification_review"));
    assert.ok(!reasonSet.includes("missing_final_tests"));
    assert.ok(decision.next_allowed_actions.some((item: string) => item.includes("task_reopen")));
  });
});

withFixture("dispatch review complete request_changes survives schema guard and hands off", (fx) => {
  const guidance = [
    ...reopenGuidanceEvidences(fx),
    reviewEvidence(fx, "critic"),
  ];
  const evidences = [
    ...prepareProposeComplete(fx, { checked: true }),
    greenEvidence(),
    ...guidance,
    mainAdjudication(fx, guidance, {
      review_decision: "request_changes",
      request_changes_route: "reopen_tasks",
      blocking_source_evidence_refs: ["EV-code-reviewer-guidance"],
      reopen_task_ids: ["TASK-001"],
    }),
  ];
  withRuntime({
    load_context: () => [status(fx), fx.repo, fx.change, evidences],
    openspec_validate: () => [true, ""],
    dirty_worktree_reasons: () => [],
  }, () => {
    const [decision, route] = guard.dispatch({ command: "check-review-complete", change: "demo-change" });
    assert.equal(route, "review");
    assert.equal(decision.allowed, false);
    assert.ok(codes(decision.block_reasons).includes("review_requests_changes"));
    assert.ok(!codes(decision.block_reasons).includes("main_adjudication_invalid"), JSON.stringify(decision.block_reasons));
    assert.ok(decision.next_allowed_actions.some((item: string) => item.includes("task_reopen")));
  });
});

withFixture("dispatch request_changes with verification refs does not hand off", (fx) => {
  const guidance = [
    ...reopenGuidanceEvidences(fx),
    reviewEvidence(fx, "critic"),
  ];
  const evidences = [
    ...prepareProposeComplete(fx, { checked: true }),
    greenEvidence(),
    ...guidance,
    mainAdjudication(fx, guidance, {
      review_decision: "request_changes",
      request_changes_route: "reopen_tasks",
      blocking_source_evidence_refs: ["EV-code-reviewer-guidance"],
      reopen_task_ids: ["TASK-001"],
      verification_evidence_refs: ["EV-verifier-verification"],
    }),
  ];
  withRuntime({
    load_context: () => [status(fx), fx.repo, fx.change, evidences],
    openspec_validate: () => [true, ""],
    dirty_worktree_reasons: () => [],
  }, () => {
    const [decision] = guard.dispatch({ command: "check-review-complete", change: "demo-change" });
    const reasonSet = codes(decision.block_reasons);
    assert.equal(decision.allowed, false);
    assert.ok(reasonSet.includes("review_requests_changes"));
    assert.ok(reasonSet.includes("main_adjudication_invalid"));
    assert.ok(!decision.next_allowed_actions.some((item: string) => item.includes("hand off")));
    assert.ok(!decision.next_allowed_actions.some((item: string) => item.includes("task_reopen")));
  });
});

withFixture("dispatch request_changes missing route does not hand off", (fx) => {
  const guidance = [
    ...reopenGuidanceEvidences(fx),
    reviewEvidence(fx, "critic"),
  ];
  const evidences = [
    ...prepareProposeComplete(fx, { checked: true }),
    greenEvidence(),
    ...guidance,
    mainAdjudication(fx, guidance, {
      review_decision: "request_changes",
      blocking_source_evidence_refs: ["EV-code-reviewer-guidance"],
      verification_evidence_refs: [],
    }),
  ];
  withRuntime({
    load_context: () => [status(fx), fx.repo, fx.change, evidences],
    openspec_validate: () => [true, ""],
    dirty_worktree_reasons: () => [],
  }, () => {
    const [decision] = guard.dispatch({ command: "check-review-complete", change: "demo-change" });
    const reasonSet = codes(decision.block_reasons);
    assert.equal(decision.allowed, false);
    assert.ok(reasonSet.includes("review_requests_changes"));
    assert.ok(reasonSet.includes("main_adjudication_invalid"));
    assert.ok(!decision.next_allowed_actions.some((item: string) => item.includes("hand off")));
  });
});

withFixture("dispatch request_changes with malformed source guidance does not hand off", (fx) => {
  const guidance = [
    ...reviewGuidanceEvidences(fx, {
      lane_overrides: {
        "code-reviewer": {
          source_refs: [],
          required_load_refs: [],
          blocking_findings: [
            {
              finding_id: "FINDING-REOPEN-MALFORMED-SOURCE",
              affected_task_ids: ["TASK-001"],
            },
          ],
        },
      },
    }),
    reviewEvidence(fx, "critic"),
  ];
  const evidences = [
    ...prepareProposeComplete(fx, { checked: true }),
    greenEvidence(),
    ...guidance,
    mainAdjudication(fx, guidance, {
      review_decision: "request_changes",
      request_changes_route: "reopen_tasks",
      blocking_source_evidence_refs: ["EV-code-reviewer-guidance"],
      reopen_task_ids: ["TASK-001"],
      verification_evidence_refs: [],
    }),
  ];
  withRuntime({
    load_context: () => [status(fx), fx.repo, fx.change, evidences],
    openspec_validate: () => [true, ""],
    dirty_worktree_reasons: () => [],
  }, () => {
    const [decision] = guard.dispatch({ command: "check-review-complete", change: "demo-change" });
    const reasonSet = codes(decision.block_reasons);
    assert.equal(decision.allowed, false);
    assert.ok(reasonSet.includes("review_requests_changes"));
    assert.ok(reasonSet.includes("evidence_missing_field"));
    assert.ok(!decision.next_allowed_actions.some((item: string) => item.includes("hand off")));
    assert.ok(!decision.next_allowed_actions.some((item: string) => item.includes("task_reopen")));
  });
});

withFixture("task reopen blocks under-adjudicated request_changes guidance", (fx) => {
  const guidance = [
    ...reopenGuidanceEvidences(fx),
    reviewEvidence(fx, "critic"),
  ];
  const evidences = [
    ...prepareProposeComplete(fx, { checked: true }),
    ...guidance,
    mainAdjudication(fx, guidance, {
      review_decision: "request_changes",
      request_changes_route: "reopen_tasks",
      blocking_source_evidence_refs: ["EV-code-reviewer-guidance"],
      reopen_task_ids: ["TASK-001"],
      verification_evidence_refs: [],
      loaded_refs: [],
      claim_adjudications: [
        { claim_id: "CLAIM-CODE-REVIEWER-001", decision: "accept", rationale: "accepted" },
      ],
      finding_adjudications: [],
    }),
    taskReopenEvidence(fx),
  ];
  const decision = guard.check_task_reopen("demo-change", status(fx), fx.change, evidences, "TASK-001");
  const reasonSet = codes(decision.block_reasons);
  assert.equal(decision.allowed, false);
  assert.ok(reasonSet.includes("required_load_unloaded"), JSON.stringify(decision.block_reasons));
  assert.ok(reasonSet.includes("required_claim_unadjudicated"), JSON.stringify(decision.block_reasons));
  assert.ok(reasonSet.includes("blocking_findings_open"), JSON.stringify(decision.block_reasons));
});

withFixture("task reopen blocks without user-confirmed apply isolation", (fx) => {
  const evidences = taskReopenReadyEvidences(fx);
  const allowed = guard.check_task_reopen("demo-change", status(fx), fx.change, evidences, "TASK-001");
  assert.equal(allowed.allowed, true, JSON.stringify(allowed));

  const missingIsolation = evidences.filter((ev) => ev.gate !== "apply_isolation");
  const missing = guard.check_task_reopen("demo-change", status(fx), fx.change, missingIsolation, "TASK-001");
  assert.equal(missing.allowed, false, JSON.stringify(missing));
  assert.ok(codes(missing.block_reasons).includes("apply_isolation_unconfirmed"), JSON.stringify(missing.block_reasons));
  assert.ok(!codes(missing.block_reasons).includes("task_reopen_invalid"), JSON.stringify(missing.block_reasons));

  const nonUserIsolation = evidences.map((ev) => (
    ev.gate === "apply_isolation" ? { ...ev, created_by: "main-thread" } : ev
  ));
  const nonUser = guard.check_task_reopen("demo-change", status(fx), fx.change, nonUserIsolation, "TASK-001");
  assert.equal(nonUser.allowed, false, JSON.stringify(nonUser));
  assert.ok(codes(nonUser.block_reasons).includes("apply_isolation_unconfirmed"), JSON.stringify(nonUser.block_reasons));
  assert.ok(!codes(nonUser.block_reasons).includes("task_reopen_invalid"), JSON.stringify(nonUser.block_reasons));
});

withFixture("task reopen rejects non-review source guidance authorization", (fx) => {
  const guidance = [
    ...reopenGuidanceEvidences(fx),
    reviewEvidence(fx, "critic"),
  ];
  const oldGuidance = reviewEvidence(fx, "code-reviewer", {
    evidence_id: "EV-old-code-reviewer-guidance",
    gate: "design_complete",
    blocking_findings: [
      {
        finding_id: "FINDING-OLD-REOPEN",
        affected_task_ids: ["TASK-001"],
      },
    ],
  });
  const evidences = [
    ...prepareProposeComplete(fx, { checked: true }),
    ...guidance,
    oldGuidance,
    mainAdjudication(fx, guidance, {
      review_decision: "request_changes",
      request_changes_route: "reopen_tasks",
      source_evidence_refs: [...guidance.map((ev) => ev.evidence_id), "EV-old-code-reviewer-guidance"],
      blocking_source_evidence_refs: ["EV-code-reviewer-guidance", "EV-old-code-reviewer-guidance"],
      reopen_task_ids: ["TASK-001"],
      verification_evidence_refs: [],
    }),
    taskReopenEvidence(fx, { source_guidance_evidence_id: "EV-old-code-reviewer-guidance" }),
  ];
  const schemaProblems = guard.evidence_schema_guard("demo-change", fx.change, fx.repo, evidences);
  assert.ok(codes(schemaProblems).includes("main_adjudication_invalid"), JSON.stringify(schemaProblems));
  const decision = guard.check_task_reopen("demo-change", status(fx), fx.change, evidences, "TASK-001");
  const reasonSet = codes(decision.block_reasons);
  assert.equal(decision.allowed, false);
  assert.ok(reasonSet.includes("main_adjudication_invalid"), JSON.stringify(decision.block_reasons));
  assert.ok(reasonSet.includes("task_reopen_invalid"), JSON.stringify(decision.block_reasons));
});

withFixture("request_changes handoff requires live source guidance", (fx) => {
  const evidences = [
    ...prepareProposeComplete(fx, { checked: true }),
    greenEvidence(),
    mainAdjudication(fx, [], {
      review_decision: "request_changes",
      request_changes_route: "change_update",
      source_evidence_refs: ["EV-fake-guidance"],
      blocking_source_evidence_refs: ["EV-fake-guidance"],
    }),
  ];
  withRuntime({
    load_context: () => [status(fx), fx.repo, fx.change, evidences],
    openspec_validate: () => [true, ""],
    dirty_worktree_reasons: () => [],
  }, () => {
    const [decision] = guard.dispatch({ command: "check-review-complete", change: "demo-change" });
    const reasonSet = codes(decision.block_reasons);
    assert.equal(decision.allowed, false);
    assert.ok(reasonSet.includes("missing_source_guidance"));
    assert.ok(reasonSet.includes("source_guidance_unreferenced"));
    assert.ok(!decision.next_allowed_actions.some((item: string) => item.includes("hand off")));
  });
});

withFixture("task edit blocks when live request_changes route is change_update", (fx) => {
  const guidance = [
    ...reopenGuidanceEvidences(fx),
    reviewEvidence(fx, "critic"),
  ];
  const evidences = [
    ...prepareProposeComplete(fx, { checked: false }),
    greenEvidence(),
    ...guidance,
    mainAdjudication(fx, guidance, {
      review_decision: "request_changes",
      request_changes_route: "change_update",
      blocking_source_evidence_refs: ["EV-code-reviewer-guidance"],
    }),
  ];
  const decision = guard.check_task_edit("demo-change", status(fx), fx.change, evidences, "TASK-001");
  assert.equal(decision.allowed, false);
  assert.ok(codes(decision.block_reasons).includes("change_update_required"));
});

withFixture("task complete blocks when live request_changes route is change_update", (fx) => {
  const guidance = [
    ...reopenGuidanceEvidences(fx),
    reviewEvidence(fx, "critic"),
  ];
  const evidences = [
    ...prepareProposeComplete(fx, { checked: false }),
    greenEvidence(),
    ...guidance,
    mainAdjudication(fx, guidance, {
      review_decision: "request_changes",
      request_changes_route: "change_update",
      blocking_source_evidence_refs: ["EV-code-reviewer-guidance"],
    }),
  ];
  const decision = guard.check_task_complete("demo-change", status(fx), fx.change, evidences, "TASK-001");
  assert.equal(decision.allowed, false);
  assert.ok(codes(decision.block_reasons).includes("change_update_required"));
});

withFixture("task reopen blocks when source adjudication route is change_update", (fx) => {
  const guidance = [
    ...reopenGuidanceEvidences(fx),
    reviewEvidence(fx, "critic"),
  ];
  const evidences = [
    ...prepareProposeComplete(fx, { checked: true }),
    ...guidance,
    mainAdjudication(fx, guidance, {
      review_decision: "request_changes",
      request_changes_route: "change_update",
      blocking_source_evidence_refs: ["EV-code-reviewer-guidance"],
      verification_evidence_refs: [],
    }),
    taskReopenEvidence(fx),
  ];
  const decision = guard.check_task_reopen("demo-change", status(fx), fx.change, evidences, "TASK-001");
  assert.equal(decision.allowed, false);
  assert.ok(codes(decision.block_reasons).includes("task_reopen_invalid"));
});

withFixture("task reopen missing task id blocks schema", (fx) => {
  prepareProposeComplete(fx, { checked: true });
  const ev = taskReopenEvidence(fx);
  delete ev.task_id;
  const problems = guard.validate_evidence_schema(ev, "demo-change", fx.change, fx.repo);
  assert.ok(codes(problems).includes("evidence_missing_field"));
});

withFixture("task reopen wrong gate blocks schema", (fx) => {
  prepareProposeComplete(fx, { checked: true });
  const ev = taskReopenEvidence(fx, { gate: "review_complete" });
  const problems = guard.validate_evidence_schema(ev, "demo-change", fx.change, fx.repo);
  assert.ok(codes(problems).includes("task_reopen_invalid"));
});

withFixture("task reopen resolved wrong gate blocks schema", (fx) => {
  prepareProposeComplete(fx, { checked: true });
  const ev = taskReopenResolvedEvidence(fx, { gate: "review_complete" });
  const problems = guard.validate_evidence_schema(ev, "demo-change", fx.change, fx.repo);
  assert.ok(codes(problems).includes("task_reopen_resolved_invalid"));
});

withFixture("request_changes reopen route blocks mixed blockers", (fx) => {
  const guidance = [
    ...reopenGuidanceEvidences(fx),
    reviewEvidence(fx, "critic", {
      blocking_findings: [{ finding_id: "FINDING-CRITIC-SCOPE", summary: "needs change update" }],
      finding_dispositions: [{ finding_id: "FINDING-CRITIC-SCOPE", recommendation: "fix", rationale: "return to propose" }],
    }),
  ];
  const evidences = [
    ...guidance,
    mainAdjudication(fx, guidance, {
      review_decision: "request_changes",
      request_changes_route: "reopen_tasks",
      blocking_source_evidence_refs: ["EV-code-reviewer-guidance", "EV-critic-guidance"],
      reopen_task_ids: ["TASK-001"],
      verification_evidence_refs: [],
    }),
  ];
  const problems = guard.evidence_schema_guard("demo-change", fx.change, fx.repo, evidences);
  assert.ok(codes(problems).includes("mixed_request_changes_route"), JSON.stringify(problems));
});

withFixture("request_changes reopen route allows minimal affected task ids mapping", (fx) => {
  const guidance = [
    ...reviewGuidanceEvidences(fx, {
      lane_overrides: {
        "code-reviewer": {
          blocking_findings: [
            {
              finding_id: "FINDING-REOPEN-MINIMAL",
              affected_task_ids: ["TASK-001"],
            },
          ],
        },
      },
    }),
    reviewEvidence(fx, "critic"),
  ];
  const evidences = [
    ...guidance,
    mainAdjudication(fx, guidance, {
      review_decision: "request_changes",
      request_changes_route: "reopen_tasks",
      blocking_source_evidence_refs: ["EV-code-reviewer-guidance"],
      reopen_task_ids: ["TASK-001"],
      verification_evidence_refs: [],
    }),
  ];
  const problems = guard.evidence_schema_guard("demo-change", fx.change, fx.repo, evidences);
  assert.ok(!codes(problems).includes("mixed_request_changes_route"), JSON.stringify(problems));
  assert.ok(!codes(problems).includes("main_adjudication_invalid"), JSON.stringify(problems));
});

withFixture("request_changes reopen route blocks blocker missing affected task ids", (fx) => {
  const guidance = [
    ...reviewGuidanceEvidences(fx, {
      lane_overrides: {
        "code-reviewer": {
          blocking_findings: [
            {
              finding_id: "FINDING-REOPEN-MISSING-TASK",
            },
          ],
        },
      },
    }),
    reviewEvidence(fx, "critic"),
  ];
  const evidences = [
    ...guidance,
    mainAdjudication(fx, guidance, {
      review_decision: "request_changes",
      request_changes_route: "reopen_tasks",
      blocking_source_evidence_refs: ["EV-code-reviewer-guidance"],
      reopen_task_ids: ["TASK-001"],
      verification_evidence_refs: [],
    }),
  ];
  const problems = guard.evidence_schema_guard("demo-change", fx.change, fx.repo, evidences);
  assert.ok(codes(problems).includes("mixed_request_changes_route"), JSON.stringify(problems));
});

withFixture("request_changes reopen route blocks omitted blocker source guidance", (fx) => {
  const guidance = [
    ...reopenGuidanceEvidences(fx),
    reviewEvidence(fx, "critic", {
      blocking_findings: [{ finding_id: "FINDING-CRITIC-SCOPE", summary: "needs change update" }],
      finding_dispositions: [{ finding_id: "FINDING-CRITIC-SCOPE", recommendation: "fix", rationale: "return to propose" }],
    }),
  ];
  const evidences = [
    ...guidance,
    mainAdjudication(fx, guidance, {
      review_decision: "request_changes",
      request_changes_route: "reopen_tasks",
      blocking_source_evidence_refs: ["EV-code-reviewer-guidance"],
      reopen_task_ids: ["TASK-001"],
      verification_evidence_refs: [],
    }),
  ];
  const problems = guard.evidence_schema_guard("demo-change", fx.change, fx.repo, evidences);
  const reasonSet = codes(problems);
  assert.ok(reasonSet.includes("main_adjudication_invalid") || reasonSet.includes("mixed_request_changes_route"));
});

withFixture("request_changes reopen route blocks blocker guidance omitted from source evidence refs", (fx) => {
  const guidance = [
    ...reopenGuidanceEvidences(fx),
    reviewEvidence(fx, "critic", {
      blocking_findings: [{ finding_id: "FINDING-CRITIC-SCOPE", summary: "needs change update" }],
      finding_dispositions: [{ finding_id: "FINDING-CRITIC-SCOPE", recommendation: "fix", rationale: "return to propose" }],
    }),
  ];
  const evidences = [
    ...guidance,
    mainAdjudication(fx, guidance, {
      review_decision: "request_changes",
      request_changes_route: "reopen_tasks",
      source_evidence_refs: ["EV-code-reviewer-guidance", "EV-architect-guidance"],
      blocking_source_evidence_refs: ["EV-code-reviewer-guidance"],
      reopen_task_ids: ["TASK-001"],
      verification_evidence_refs: [],
    }),
  ];
  const problems = guard.evidence_schema_guard("demo-change", fx.change, fx.repo, evidences);
  assert.ok(codes(problems).includes("main_adjudication_invalid"), JSON.stringify(problems));
});

withFixture("dispatch check-task-reopen routes through reopen gate", (fx) => {
  const guidance = [
    ...reopenGuidanceEvidences(fx),
    reviewEvidence(fx, "critic"),
  ];
  const evidences = [
    ...prepareProposeComplete(fx, { checked: true }),
    ...guidance,
    mainAdjudication(fx, guidance, {
      review_decision: "request_changes",
      request_changes_route: "change_update",
      blocking_source_evidence_refs: ["EV-code-reviewer-guidance"],
      verification_evidence_refs: [],
    }),
    taskReopenEvidence(fx),
  ];
  withRuntime({ load_context: () => [status(fx), fx.repo, fx.change, evidences] }, () => {
    const [decision, route] = guard.dispatch({ command: "check-task-reopen", change: "demo-change", task_id: "TASK-001" });
    assert.equal(route, "apply");
    assert.equal(decision.gate, "task_reopen");
    assert.equal(decision.allowed, false);
    assert.ok(codes(decision.block_reasons).includes("task_reopen_invalid"));
  });
});

withFixture("task reopen requires code-reviewer affected_task_ids coverage", (fx) => {
  const guidance = [
    ...reviewGuidanceEvidences(fx, {
      lane_overrides: {
        "code-reviewer": {
          blocking_findings: [
            {
              finding_id: "FINDING-REOPEN-002",
              affected_task_ids: ["TASK-999"],
            },
          ],
        },
      },
    }),
    reviewEvidence(fx, "critic"),
  ];
  const evidences = [
    ...prepareProposeComplete(fx, { checked: true }),
    ...guidance,
    mainAdjudication(fx, guidance, {
      review_decision: "request_changes",
      request_changes_route: "reopen_tasks",
      blocking_source_evidence_refs: ["EV-code-reviewer-guidance"],
      reopen_task_ids: ["TASK-001"],
    }),
    taskReopenEvidence(fx),
  ];
  const decision = guard.check_task_reopen("demo-change", status(fx), fx.change, evidences, "TASK-001");
  assert.equal(decision.allowed, false);
  assert.ok(codes(decision.block_reasons).includes("task_reopen_invalid"));
});

withFixture("task edit blocks unchecked task referenced by request_changes without task reopen", (fx) => {
  const guidance = [
    ...reopenGuidanceEvidences(fx),
    reviewEvidence(fx, "critic"),
  ];
  const evidences = [
    ...prepareProposeComplete(fx),
    ...guidance,
    mainAdjudication(fx, guidance, {
      review_decision: "request_changes",
      request_changes_route: "reopen_tasks",
      blocking_source_evidence_refs: ["EV-code-reviewer-guidance"],
      reopen_task_ids: ["TASK-001"],
      verification_evidence_refs: [],
    }),
  ];
  const decision = guard.check_task_edit("demo-change", status(fx), fx.change, evidences, "TASK-001");
  assert.equal(decision.allowed, false);
  assert.ok(codes(decision.block_reasons).includes("missing_task_reopen"));
});

withFixture("task edit rejects wrong-gate task reopen", (fx) => {
  const guidance = [
    ...reopenGuidanceEvidences(fx),
    reviewEvidence(fx, "critic"),
  ];
  const evidences = [
    ...prepareProposeComplete(fx, { checked: true }),
    ...guidance,
    mainAdjudication(fx, guidance, {
      review_decision: "request_changes",
      request_changes_route: "reopen_tasks",
      blocking_source_evidence_refs: ["EV-code-reviewer-guidance"],
      reopen_task_ids: ["TASK-001"],
      verification_evidence_refs: [],
    }),
    taskReopenEvidence(fx, { gate: "review_complete" }),
    redEvidence(),
  ];
  setTaskCheckbox(fx.change, "TASK-001", false);
  const decision = guard.check_task_edit("demo-change", status(fx), fx.change, evidences, "TASK-001");
  assert.equal(decision.allowed, false);
  assert.ok(codes(decision.block_reasons).includes("missing_task_reopen"));
});

withFixture("task edit allows resumed reopened apply after authorized revert", (fx) => {
  const guidance = [
    ...reopenGuidanceEvidences(fx),
    reviewEvidence(fx, "critic"),
  ];
  const evidences = [
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
    redEvidence(),
  ];
  setTaskCheckbox(fx.change, "TASK-001", false);
  const decision = guard.check_task_edit("demo-change", status(fx), fx.change, evidences, "TASK-001");
  assert.equal(decision.allowed, true, JSON.stringify(decision));
});

withFixture("task complete blocks reopened task without successor evidence", (fx) => {
  const guidance = [
    ...reopenGuidanceEvidences(fx),
    reviewEvidence(fx, "critic"),
  ];
  const evidences = [
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
  setTaskCheckbox(fx.change, "TASK-001", false);
  const decision = guard.check_task_complete("demo-change", status(fx), fx.change, evidences, "TASK-001");
  assert.equal(decision.allowed, false);
  assert.ok(codes(decision.block_reasons).includes("missing_reopen_successor"));
});

withFixture("task complete blocks reopened task with stale pre-reopen green still live", (fx) => {
  const guidance = [
    ...reopenGuidanceEvidences(fx),
    reviewEvidence(fx, "critic"),
  ];
  const evidences = [
    ...prepareProposeComplete(fx, { checked: true }),
    ...guidance,
    mainAdjudication(fx, guidance, {
      review_decision: "request_changes",
      request_changes_route: "reopen_tasks",
      blocking_source_evidence_refs: ["EV-code-reviewer-guidance"],
      reopen_task_ids: ["TASK-001"],
      verification_evidence_refs: [],
    }),
    taskReopenEvidence(fx, {
      invalidated_completion_evidence_ids: [],
      required_supersede_evidence_ids: [],
    }),
    greenEvidence("TASK-001", "TEST-001", ["INV-001"], { evidence_id: "EV-old-green" }),
    greenEvidence("TASK-001", "TEST-001", ["INV-001"], {
      evidence_id: "EV-green-successor",
      reopen_id: "reopen-001",
    }),
  ];
  setTaskCheckbox(fx.change, "TASK-001", false);
  const decision = guard.check_task_complete("demo-change", status(fx), fx.change, evidences, "TASK-001");
  assert.equal(decision.allowed, false);
  assert.ok(codes(decision.block_reasons).includes("stale_reopen_successor"));
});

withFixture("task complete allows reopened task with superseded old green and successor green", (fx) => {
  const guidance = [
    ...reopenGuidanceEvidences(fx),
    reviewEvidence(fx, "critic"),
  ];
  const evidences = [
    ...prepareProposeComplete(fx, { checked: true }),
    ...guidance,
    mainAdjudication(fx, guidance, {
      review_decision: "request_changes",
      request_changes_route: "reopen_tasks",
      blocking_source_evidence_refs: ["EV-code-reviewer-guidance"],
      reopen_task_ids: ["TASK-001"],
      verification_evidence_refs: [],
    }),
    passEvidence("task_complete", "test_run", {
      evidence_id: "EV-old-green",
      task_id: "TASK-001",
      test_id: "TEST-001",
      invariant_refs: ["INV-001"],
      semantic_status: "expected_success",
    }),
    supersededEvidence("EV-old-green"),
    taskReopenEvidence(fx),
    greenEvidence("TASK-001", "TEST-001", ["INV-001"], {
      evidence_id: "EV-green-successor",
      reopen_id: "reopen-001",
    }),
  ];
  setTaskCheckbox(fx.change, "TASK-001", false);
  const decision = guard.check_task_complete("demo-change", status(fx), fx.change, evidences, "TASK-001");
  assert.equal(decision.allowed, true, JSON.stringify(decision));
});

withFixture("review ready blocks unresolved task reopen", (fx) => {
  const guidance = [
    ...reopenGuidanceEvidences(fx),
    reviewEvidence(fx, "critic"),
  ];
  const evidences = [
    ...prepareProposeComplete(fx, { checked: true }),
    greenEvidence(),
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
  withRuntime({
    openspec_validate: () => [true, ""],
    dirty_worktree_reasons: () => [],
  }, () => {
    const decision = guard.check_review_ready("demo-change", status(fx), fx.change, evidences);
    assert.equal(decision.allowed, false);
    assert.ok(codes(decision.block_reasons).includes("unresolved_task_reopen"));
  });
});

withFixture("task complete blocks task_reopen hidden by generic superseded evidence", (fx) => {
  const guidance = [
    ...reopenGuidanceEvidences(fx),
    reviewEvidence(fx, "critic"),
  ];
  const evidences = [
    ...prepareProposeComplete(fx, { checked: true }),
    greenEvidence(),
    ...guidance,
    mainAdjudication(fx, guidance, {
      review_decision: "request_changes",
      request_changes_route: "reopen_tasks",
      blocking_source_evidence_refs: ["EV-code-reviewer-guidance"],
      reopen_task_ids: ["TASK-001"],
      verification_evidence_refs: [],
    }),
    taskReopenEvidence(fx, {
      invalidated_completion_evidence_ids: [],
      required_supersede_evidence_ids: [],
    }),
    supersededEvidence("EV-task-reopen"),
  ];
  const decision = guard.check_task_complete("demo-change", status(fx), fx.change, evidences, "TASK-001");
  assert.equal(decision.allowed, false);
  assert.ok(codes(decision.block_reasons).includes("unresolved_task_reopen"));
});

withFixture("review ready blocks task_reopen hidden by generic superseded evidence", (fx) => {
  const guidance = [
    ...reopenGuidanceEvidences(fx),
    reviewEvidence(fx, "critic"),
  ];
  const evidences = [
    ...prepareProposeComplete(fx, { checked: true }),
    greenEvidence(),
    ...guidance,
    mainAdjudication(fx, guidance, {
      review_decision: "request_changes",
      request_changes_route: "reopen_tasks",
      blocking_source_evidence_refs: ["EV-code-reviewer-guidance"],
      reopen_task_ids: ["TASK-001"],
      verification_evidence_refs: [],
    }),
    taskReopenEvidence(fx, {
      invalidated_completion_evidence_ids: [],
      required_supersede_evidence_ids: [],
    }),
    supersededEvidence("EV-task-reopen"),
  ];
  withRuntime({ openspec_validate: () => [true, ""], dirty_worktree_reasons: () => [] }, () => {
    const decision = guard.check_review_ready("demo-change", status(fx), fx.change, evidences);
    assert.equal(decision.allowed, false);
    assert.ok(codes(decision.block_reasons).includes("unresolved_task_reopen"));
  });
});

withFixture("FIX-6 supersede blocks dangling target evidence id", (fx) => {
  const evidences = [
    greenEvidence("TASK-001", "TEST-001", ["INV-001"], { evidence_id: "EV-old-green" }),
    supersededEvidence("EV-not-there"),
  ];
  const problems = guard.evidence_schema_guard("demo-change", fx.change, fx.repo, evidences);
  assert.ok(codes(problems).includes("supersede_target_missing"), JSON.stringify(problems));
});

withFixture("FIX-6 cross-gate supersede without reason blocks supersede_unauthorized", (fx) => {
  const evidences = [
    greenEvidence("TASK-001", "TEST-001", ["INV-001"], { evidence_id: "EV-old-green" }),
    passEvidence("task_reopen", "superseded", {
      evidence_id: "EV-kill",
      status: "superseded",
      supersedes: "EV-old-green",
    }),
  ];
  const problems = guard.evidence_schema_guard("demo-change", fx.change, fx.repo, evidences);
  assert.ok(codes(problems).includes("supersede_unauthorized"), JSON.stringify(problems));
});

withFixture("FIX-6 same-gate supersede without reason is authorized", (fx) => {
  const evidences = [
    greenEvidence("TASK-001", "TEST-001", ["INV-001"], { evidence_id: "EV-old-green" }),
    passEvidence("task_complete", "superseded", {
      evidence_id: "EV-kill",
      status: "superseded",
      supersedes: "EV-old-green",
    }),
  ];
  const problems = guard.evidence_schema_guard("demo-change", fx.change, fx.repo, evidences);
  assert.ok(!codes(problems).includes("supersede_unauthorized"), JSON.stringify(problems));
  assert.ok(!codes(problems).includes("supersede_target_missing"), JSON.stringify(problems));
});

withFixture("FIX-6 cross-gate supersede with non-empty reason is authorized", (fx) => {
  const evidences = [
    greenEvidence("TASK-001", "TEST-001", ["INV-001"], { evidence_id: "EV-old-green" }),
    supersededEvidence("EV-old-green"),
  ];
  const problems = guard.evidence_schema_guard("demo-change", fx.change, fx.repo, evidences);
  assert.ok(!codes(problems).includes("supersede_unauthorized"), JSON.stringify(problems));
  assert.ok(!codes(problems).includes("supersede_target_missing"), JSON.stringify(problems));
});

withFixture("FIX-6 empty supersede_reason does not authorize cross-gate supersede", (fx) => {
  const evidences = [
    greenEvidence("TASK-001", "TEST-001", ["INV-001"], { evidence_id: "EV-old-green" }),
    passEvidence("task_reopen", "superseded", {
      evidence_id: "EV-kill",
      status: "superseded",
      supersedes: "EV-old-green",
      supersede_reason: "   ",
    }),
  ];
  const problems = guard.evidence_schema_guard("demo-change", fx.change, fx.repo, evidences);
  assert.ok(codes(problems).includes("supersede_unauthorized"), JSON.stringify(problems));
});

withFixture("FIX-6 dispatch records evidence_superseded ledger event exactly once", (fx) => {
  const evidences = [
    greenEvidence("TASK-001", "TEST-001", ["INV-001"], { evidence_id: "EV-old-green" }),
    passEvidence("task_complete", "superseded", {
      evidence_id: "EV-kill",
      status: "superseded",
      supersedes: "EV-old-green",
    }),
  ];
  withRuntime({ load_context: () => [status(fx), fx.repo, fx.change, evidences] }, () => {
    guard.dispatch({ command: "recompute", change: "demo-change" });
    guard.dispatch({ command: "recompute", change: "demo-change" });
  });
  const events = readFileSync(join(fx.change, ".superspec", "ledger.jsonl"), "utf8")
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line))
    .filter((event) => event.kind === "evidence_superseded");
  assert.equal(events.length, 1, JSON.stringify(events));
  assert.equal(events[0].superseded_by, "EV-kill");
  assert.equal(events[0].supersedes, "EV-old-green");
  assert.equal(events[0].change_id, "demo-change");
});

withFixture("FIX-7 unknown evidence kind blocks evidence_unknown_kind", (fx) => {
  const evidences = [
    passEvidence("task_complete", "test_rnu", {
      evidence_id: "EV-typo-kind",
      task_id: "TASK-001",
    }),
  ];
  const problems = guard.evidence_schema_guard("demo-change", fx.change, fx.repo, evidences);
  assert.ok(codes(problems).includes("evidence_unknown_kind"), JSON.stringify(problems));
});

withFixture("FIX-7 whitelisted evidence kinds do not report unknown kind", (fx) => {
  const kinds = [
    "review",
    "subagent_report",
    "workflow_review",
    "source_guidance",
    "main_adjudication",
    "verification_review",
    "final_test",
    "test_run",
    "alternative_verification",
    "manual_verification",
    "task_reopen",
    "task_reopen_resolved",
    "human_confirmation",
    "superseded",
  ];
  for (const kind of kinds) {
    const problems = guard.evidence_schema_guard("demo-change", fx.change, fx.repo, [
      passEvidence("design_complete", kind, { evidence_id: `EV-kind-${kind}` }),
    ]);
    assert.ok(!codes(problems).includes("evidence_unknown_kind"), `${kind}: ${JSON.stringify(problems)}`);
  }
});

withFixture("FIX-7 human confirmation requires non-empty confirmation_text", (fx) => {
  const evidences = [
    passEvidence("design_complete", "human_confirmation", {
      evidence_id: "EV-hc",
      confirmed_refs: ["design.md"],
      confirmation_text: "  ",
    }),
  ];
  const problems = guard.evidence_schema_guard("demo-change", fx.change, fx.repo, evidences);
  assert.ok(codes(problems).includes("human_confirmation_invalid"), JSON.stringify(problems));
});

withFixture("FIX-7 human confirmation requires non-empty confirmed_refs", (fx) => {
  const evidences = [
    passEvidence("design_complete", "human_confirmation", {
      evidence_id: "EV-hc",
      confirmation_text: "confirmed design trade-offs",
      confirmed_refs: [],
    }),
  ];
  const problems = guard.evidence_schema_guard("demo-change", fx.change, fx.repo, evidences);
  assert.ok(codes(problems).includes("human_confirmation_invalid"), JSON.stringify(problems));
});

withFixture("FIX-7 human confirmation gate must be a recognized confirmation gate", (fx) => {
  const evidences = [
    passEvidence("task_complete", "human_confirmation", {
      evidence_id: "EV-hc",
      confirmation_text: "confirmed",
      confirmed_refs: ["tasks.md"],
    }),
  ];
  const problems = guard.evidence_schema_guard("demo-change", fx.change, fx.repo, evidences);
  assert.ok(codes(problems).includes("human_confirmation_invalid"), JSON.stringify(problems));
});

withFixture("FIX-7 complete human confirmation passes minimal schema", (fx) => {
  const evidences = [
    passEvidence("design_complete", "human_confirmation", {
      evidence_id: "EV-hc",
      confirmation_text: "confirmed design trade-offs",
      confirmed_refs: ["design.md"],
    }),
  ];
  const problems = guard.evidence_schema_guard("demo-change", fx.change, fx.repo, evidences);
  assert.ok(!codes(problems).includes("human_confirmation_invalid"), JSON.stringify(problems));
});

withFixture("FIX-7 human confirmation must be user-authored", (fx) => {
  const problems = guard.evidence_schema_guard("demo-change", fx.change, fx.repo, [
    passEvidence("design_complete", "human_confirmation", {
      evidence_id: "EV-hc-main-thread",
      created_by: "main-thread",
      confirmation_text: "confirmed design trade-offs",
      confirmed_refs: ["design.md"],
    }),
  ]);
  assert.ok(codes(problems).includes("human_confirmation_invalid"), JSON.stringify(problems));
});

withFixture("FIX-7 branch handling confirmation uses confirmed_paths pattern", (fx) => {
  const evidences = [
    passEvidence("branch_handling", "human_confirmation", {
      evidence_id: "EV-hc-branch",
      confirmation_text: "unrelated dirty files acknowledged",
      confirmed_paths: ["unrelated.txt"],
    }),
  ];
  const problems = guard.evidence_schema_guard("demo-change", fx.change, fx.repo, evidences);
  assert.ok(!codes(problems).includes("human_confirmation_invalid"), JSON.stringify(problems));
  const missingPaths = guard.evidence_schema_guard("demo-change", fx.change, fx.repo, [
    passEvidence("branch_handling", "human_confirmation", {
      evidence_id: "EV-hc-branch-2",
      confirmation_text: "unrelated dirty files acknowledged",
    }),
  ]);
  assert.ok(codes(missingPaths).includes("human_confirmation_invalid"), JSON.stringify(missingPaths));
});

withFixture("FIX-8 apply isolation confirmation requires tasks_structure_hash", (fx) => {
  const problems = guard.evidence_schema_guard("demo-change", fx.change, fx.repo, [
    passEvidence("apply_isolation", "human_confirmation", { evidence_id: "EV-iso-no-hash" }),
  ]);
  assert.ok(codes(problems).includes("human_confirmation_invalid"), JSON.stringify(problems));
  const ok = guard.evidence_schema_guard("demo-change", fx.change, fx.repo, [
    passEvidence("apply_isolation", "human_confirmation", { evidence_id: "EV-iso-hash", tasks_structure_hash: "sha256:abc" }),
    passEvidence("scope_expansion", "human_confirmation", { evidence_id: "EV-scope-hash", tasks_structure_hash: "sha256:def" }),
    passEvidence("verify_failure_handling", "human_confirmation", { evidence_id: "EV-vfh" }),
  ]);
  assert.ok(!codes(ok).includes("human_confirmation_invalid"), JSON.stringify(ok));
});

withFixture("FIX-8 task edit blocks without apply isolation confirmation", (fx) => {
  const evidences = [
    ...prepareProposeComplete(fx).filter((ev) => ev.gate !== "apply_isolation"),
    redEvidence(),
  ];
  const decision = guard.check_task_edit("demo-change", status(fx), fx.change, evidences, "TASK-001");
  assert.equal(decision.allowed, false);
  assert.ok(codes(decision.block_reasons).includes("apply_isolation_unconfirmed"), JSON.stringify(decision.block_reasons));
});

withFixture("FIX-8 task edit allows with live apply isolation confirmation", (fx) => {
  const decision = guard.check_task_edit("demo-change", status(fx), fx.change, [
    ...prepareProposeComplete(fx),
    redEvidence(),
  ], "TASK-001");
  assert.equal(decision.allowed, true, JSON.stringify(decision));
});

withFixture("FIX-8 task gates block tasks structure change without scope re-approval", (fx) => {
  const evidences = [...prepareProposeComplete(fx), redEvidence()];
  const tasksPath = join(fx.change, "tasks.md");
  writeText(tasksPath, readFileSync(tasksPath, "utf8") + "- [ ] TASK-002 Extra scope\n  - test_refs: TEST-001\n");
  const blocked = guard.check_task_edit("demo-change", status(fx), fx.change, evidences, "TASK-001");
  assert.equal(blocked.allowed, false);
  assert.ok(codes(blocked.block_reasons).includes("scope_expansion_unconfirmed"), JSON.stringify(blocked.block_reasons));
  const reapproved = guard.check_task_edit("demo-change", status(fx), fx.change, [
    ...evidences,
    passEvidence("scope_expansion", "human_confirmation", {
      evidence_id: "EV-scope-reapproval",
      tasks_structure_hash: guard.tasks_structure_hash(fx.change),
    }),
  ], "TASK-001");
  assert.ok(!codes(reapproved.block_reasons ?? []).includes("scope_expansion_unconfirmed"), JSON.stringify(reapproved));
  assert.ok(!codes(reapproved.block_reasons ?? []).includes("apply_isolation_unconfirmed"), JSON.stringify(reapproved));
});

withFixture("FIX-8 checkbox toggles do not require scope re-approval", (fx) => {
  const evidences = [...prepareProposeComplete(fx), redEvidence(), greenEvidence()];
  const before = guard.tasks_structure_hash(fx.change);
  setTaskCheckbox(fx.change, "TASK-001", true);
  assert.equal(guard.tasks_structure_hash(fx.change), before);
  const decision = guard.check_task_complete("demo-change", status(fx), fx.change, evidences, "TASK-001");
  assert.ok(!codes(decision.block_reasons ?? []).includes("scope_expansion_unconfirmed"), JSON.stringify(decision));
  assert.ok(!codes(decision.block_reasons ?? []).includes("apply_isolation_unconfirmed"), JSON.stringify(decision));
});

withFixture("FIX-8 review complete blocks failed verification without user disposition", (fx) => {
  const guidance = [
    ...reviewGuidanceEvidences(fx, { reviewed_files: ["tasks.md", "src/service.py"] }),
    reviewEvidence(fx, "critic", { reviewed_files: ["tasks.md", "src/service.py"] }),
  ];
  writeText(join(fx.change, ".superspec", "raw", "final-test-failed.log"), "final test fail\n");
  const evidences = [
    ...prepareProposeComplete(fx, { checked: true }),
    greenEvidence(),
    ...guidance,
    mainAdjudication(fx, guidance),
    verifyEvidence(fx, "verifier"),
    verifyEvidence(fx, "critic"),
    finalTestEvidence(fx),
    passEvidence("review_complete", "final_test", {
      evidence_id: "EV-final-test-failed",
      status: "fail",
      test_command: "test",
      output_ref: ".superspec/raw/final-test-failed.log",
      semantic_status: "expected_success",
    }),
  ];
  withRuntime({
    openspec_validate: () => [true, ""],
    dirty_worktree_reasons: () => [],
    review_diff_paths: () => ["tasks.md", "src/service.py"],
  }, () => {
    const blocked = guard.check_review_complete("demo-change", status(fx), fx.change, evidences);
    assert.equal(blocked.allowed, false);
    assert.ok(codes(blocked.block_reasons).includes("verify_failure_unconfirmed"), JSON.stringify(blocked.block_reasons));
    const confirmed = guard.check_review_complete("demo-change", status(fx), fx.change, [
      ...evidences,
      passEvidence("verify_failure_handling", "human_confirmation", {
        evidence_id: "EV-verify-failure-disposition",
        confirmation_text: "user chose: fix and rerun final tests",
        confirmed_refs: ["EV-final-test-failed"],
      }),
    ]);
    assert.equal(confirmed.allowed, true, JSON.stringify(confirmed));
  });
});

withFixture("FIX-8 superseding a failed verification does not erase disposition duty", (fx) => {
  const guidance = [
    ...reviewGuidanceEvidences(fx, { reviewed_files: ["tasks.md", "src/service.py"] }),
    reviewEvidence(fx, "critic", { reviewed_files: ["tasks.md", "src/service.py"] }),
  ];
  writeText(join(fx.change, ".superspec", "raw", "final-test-failed.log"), "final test fail\n");
  const evidences = [
    ...prepareProposeComplete(fx, { checked: true }),
    greenEvidence(),
    ...guidance,
    mainAdjudication(fx, guidance),
    verifyEvidence(fx, "verifier"),
    verifyEvidence(fx, "critic"),
    finalTestEvidence(fx),
    passEvidence("review_complete", "final_test", {
      evidence_id: "EV-final-test-failed",
      status: "fail",
      test_command: "test",
      output_ref: ".superspec/raw/final-test-failed.log",
      semantic_status: "expected_success",
    }),
    passEvidence("review_complete", "superseded", {
      evidence_id: "EV-hide-failure",
      status: "superseded",
      supersedes: "EV-final-test-failed",
    }),
  ];
  withRuntime({
    openspec_validate: () => [true, ""],
    dirty_worktree_reasons: () => [],
    review_diff_paths: () => ["tasks.md", "src/service.py"],
  }, () => {
    const blocked = guard.check_review_complete("demo-change", status(fx), fx.change, evidences);
    assert.equal(blocked.allowed, false);
    assert.ok(codes(blocked.block_reasons).includes("verify_failure_unconfirmed"), JSON.stringify(blocked.block_reasons));
  });
});

withFixture("FIX-9 role evidence prompt_ref must be readable and non-empty", (fx) => {
  const ev = roleEvidence(fx, "design_complete", "architect", {
    evidence_id: "EV-prompt-check",
    prompt_ref: ".superspec/reports/custom-prompt.md",
  });
  const missing = guard.evidence_schema_guard("demo-change", fx.change, fx.repo, [ev]);
  assert.ok(codes(missing).includes("evidence_prompt_missing"), JSON.stringify(missing));
  writeText(join(fx.change, ".superspec", "reports", "custom-prompt.md"), "   \n");
  const empty = guard.evidence_schema_guard("demo-change", fx.change, fx.repo, [ev]);
  assert.ok(codes(empty).includes("evidence_prompt_empty"), JSON.stringify(empty));
  writeText(join(fx.change, ".superspec", "reports", "custom-prompt.md"), "review the design against discovery\n");
  const ok = guard.evidence_schema_guard("demo-change", fx.change, fx.repo, [ev]);
  assert.ok(!codes(ok).includes("evidence_prompt_missing"), JSON.stringify(ok));
  assert.ok(!codes(ok).includes("evidence_prompt_empty"), JSON.stringify(ok));
});

withFixture("FIX-9 prompt_ref escaping the change root is unsafe", (fx) => {
  const ev = roleEvidence(fx, "design_complete", "architect", {
    evidence_id: "EV-prompt-escape",
    prompt_ref: "../outside-prompt.md",
  });
  const problems = guard.evidence_schema_guard("demo-change", fx.change, fx.repo, [ev]);
  assert.ok(codes(problems).includes("evidence_unsafe_ref"), JSON.stringify(problems));
});

withFixture("FIX-9 duplicate evidence_id blocks evidence_id_duplicate", (fx) => {
  const problems = guard.evidence_schema_guard("demo-change", fx.change, fx.repo, [
    passEvidence("design_complete", "human_confirmation", { evidence_id: "EV-dup" }),
    greenEvidence("TASK-001", "TEST-001", ["INV-001"], { evidence_id: "EV-dup" }),
  ]);
  assert.ok(codes(problems).includes("evidence_id_duplicate"), JSON.stringify(problems));
  const ok = guard.evidence_schema_guard("demo-change", fx.change, fx.repo, [
    passEvidence("design_complete", "human_confirmation", { evidence_id: "EV-unique-a" }),
    greenEvidence("TASK-001", "TEST-001", ["INV-001"], { evidence_id: "EV-unique-b" }),
  ]);
  assert.ok(!codes(ok).includes("evidence_id_duplicate"), JSON.stringify(ok));
});

withFixture("FIX-10 test_run requires raw_log_refs and result_summary", (fx) => {
  const bare = passEvidence("task_complete", "test_run", {
    evidence_id: "EV-run-bare",
    task_id: "TASK-001",
    test_id: "TEST-001",
    semantic_status: "expected_success",
    raw_log_refs: undefined,
    result_summary: undefined,
  });
  const problems = guard.evidence_schema_guard("demo-change", fx.change, fx.repo, [bare]);
  assert.ok(codes(problems).includes("test_run_log_missing"), JSON.stringify(problems));
  assert.ok(codes(problems).includes("test_run_summary_missing"), JSON.stringify(problems));
});

withFixture("FIX-10 test_run log must be readable, non-empty, and inside the change root", (fx) => {
  const make = (id: string, refs: string[]): JsonMap => passEvidence("task_complete", "test_run", {
    evidence_id: id,
    task_id: "TASK-001",
    test_id: "TEST-001",
    semantic_status: "expected_success",
    raw_log_refs: refs,
    result_summary: "1 test passed",
  });
  const missing = guard.evidence_schema_guard("demo-change", fx.change, fx.repo, [make("EV-run-missing", [".superspec/raw/nope.log"])]);
  assert.ok(codes(missing).includes("test_run_log_missing"), JSON.stringify(missing));
  writeText(join(fx.change, ".superspec", "raw", "empty.log"), "   \n");
  const empty = guard.evidence_schema_guard("demo-change", fx.change, fx.repo, [make("EV-run-empty", [".superspec/raw/empty.log"])]);
  assert.ok(codes(empty).includes("test_run_log_missing"), JSON.stringify(empty));
  const escape = guard.evidence_schema_guard("demo-change", fx.change, fx.repo, [make("EV-run-escape", ["../escape.log"])]);
  assert.ok(codes(escape).includes("evidence_unsafe_ref"), JSON.stringify(escape));
});

withFixture("FIX-10 claimed test_id must appear in a referenced raw log", (fx) => {
  writeText(join(fx.change, ".superspec", "raw", "run.log"), "JUnit: TEST-001 passed\n");
  const liar = passEvidence("task_complete", "test_run", {
    evidence_id: "EV-run-liar",
    task_id: "TASK-001",
    test_id: "TEST-999",
    semantic_status: "expected_success",
    raw_log_refs: [".superspec/raw/run.log"],
    result_summary: "claims TEST-999",
  });
  const problems = guard.evidence_schema_guard("demo-change", fx.change, fx.repo, [liar]);
  assert.ok(codes(problems).includes("test_id_not_in_log"), JSON.stringify(problems));
  const honest = passEvidence("task_complete", "test_run", {
    evidence_id: "EV-run-honest",
    task_id: "TASK-001",
    test_id: "TEST-001",
    semantic_status: "expected_success",
    raw_log_refs: [".superspec/raw/run.log"],
    result_summary: "TEST-001 passed",
  });
  const ok = guard.evidence_schema_guard("demo-change", fx.change, fx.repo, [honest]);
  assert.ok(!codes(ok).includes("test_id_not_in_log"), JSON.stringify(ok));
});

withFixture("FIX-10 per-run consolidated test_run with test_ids list is valid", (fx) => {
  writeText(join(fx.change, ".superspec", "raw", "batch.log"), "TEST-001 ok\nTEST-002 ok\n");
  const run = passEvidence("task_complete", "test_run", {
    evidence_id: "EV-run-batch",
    task_id: "TASK-001",
    test_ids: ["TEST-001", "TEST-002"],
    semantic_status: "expected_success",
    raw_log_refs: [".superspec/raw/batch.log"],
    result_summary: "2 tests passed in one run",
  });
  const ok = guard.evidence_schema_guard("demo-change", fx.change, fx.repo, [run]);
  assert.ok(!codes(ok).some((code) => code.startsWith("test_run_") || code === "test_id_not_in_log"), JSON.stringify(ok));
  const partial = passEvidence("task_complete", "test_run", {
    evidence_id: "EV-run-partial",
    task_id: "TASK-001",
    test_ids: ["TEST-001", "TEST-404"],
    semantic_status: "expected_success",
    raw_log_refs: [".superspec/raw/batch.log"],
    result_summary: "claims a test the log never ran",
  });
  const problems = guard.evidence_schema_guard("demo-change", fx.change, fx.repo, [partial]);
  assert.ok(codes(problems).includes("test_id_not_in_log"), JSON.stringify(problems));
});

withFixture("FIX-11 same-gate role evidence must not reuse output_ref", (fx) => {
  const evidences = prepareProposeComplete(fx);
  const shared = ".superspec/reports/design-shared.md";
  writeText(join(fx.change, shared), "one report stamped by two roles\n");
  for (const ev of evidences) {
    if (ev.gate === "design_complete" && (ev.agent_role === "architect" || ev.agent_role === "critic")) {
      ev.output_ref = shared;
    }
  }
  const decision = guard.check_superspec_gate("demo-change", status(fx), fx.change, evidences, "design_complete");
  assert.equal(decision.allowed, false);
  assert.ok(codes(decision.block_reasons).includes("evidence_output_ref_duplicate"), JSON.stringify(decision.block_reasons));
});

withFixture("FIX-11 cross-gate output_ref reuse without review_scope blocks review_scope_unverified", (fx) => {
  const evidences = prepareProposeComplete(fx);
  const omnibus = ".superspec/reports/refresh-critic-review.md";
  writeText(join(fx.change, omnibus), "omnibus refresh review of everything\n");
  for (const ev of evidences) {
    if (ev.agent_role === "critic" && (ev.gate === "explore_complete" || ev.gate === "design_complete")) {
      ev.output_ref = omnibus;
    }
  }
  const explore = guard.check_superspec_gate("demo-change", status(fx), fx.change, evidences, "explore_complete");
  assert.equal(explore.allowed, false);
  assert.ok(codes(explore.block_reasons).includes("review_scope_unverified"), JSON.stringify(explore.block_reasons));
  const design = guard.check_superspec_gate("demo-change", status(fx), fx.change, evidences, "design_complete");
  assert.equal(design.allowed, false);
  assert.ok(codes(design.block_reasons).includes("review_scope_unverified"), JSON.stringify(design.block_reasons));
});

withFixture("FIX-11 omnibus reuse with review_scope covering gate targets is allowed", (fx) => {
  const evidences = prepareProposeComplete(fx);
  const omnibus = ".superspec/reports/refresh-critic-review.md";
  writeText(join(fx.change, omnibus), "omnibus refresh review with declared scope\n");
  for (const ev of evidences) {
    if (ev.agent_role === "critic" && (ev.gate === "explore_complete" || ev.gate === "design_complete")) {
      ev.output_ref = omnibus;
      ev.review_scope = [".superspec/artifacts/discovery.md", "design.md"];
    }
  }
  const explore = guard.check_superspec_gate("demo-change", status(fx), fx.change, evidences, "explore_complete");
  assert.ok(!codes(explore.block_reasons).includes("review_scope_unverified"), JSON.stringify(explore.block_reasons));
  assert.equal(explore.allowed, true, JSON.stringify(explore.block_reasons));
  const design = guard.check_superspec_gate("demo-change", status(fx), fx.change, evidences, "design_complete");
  assert.ok(!codes(design.block_reasons).includes("review_scope_unverified"), JSON.stringify(design.block_reasons));
  assert.equal(design.allowed, true, JSON.stringify(design.block_reasons));
});

withFixture("FIX-11 review_scope missing this gate's target artifact still blocks", (fx) => {
  const evidences = prepareProposeComplete(fx);
  const omnibus = ".superspec/reports/refresh-critic-review.md";
  writeText(join(fx.change, omnibus), "omnibus refresh review with partial scope\n");
  for (const ev of evidences) {
    if (ev.agent_role === "critic" && (ev.gate === "explore_complete" || ev.gate === "design_complete")) {
      ev.output_ref = omnibus;
      // Scope covers discovery only; the design_complete stamp is outside the declared contract.
      ev.review_scope = [".superspec/artifacts/discovery.md"];
    }
  }
  const explore = guard.check_superspec_gate("demo-change", status(fx), fx.change, evidences, "explore_complete");
  assert.ok(!codes(explore.block_reasons).includes("review_scope_unverified"), JSON.stringify(explore.block_reasons));
  const design = guard.check_superspec_gate("demo-change", status(fx), fx.change, evidences, "design_complete");
  assert.equal(design.allowed, false);
  assert.ok(codes(design.block_reasons).includes("review_scope_unverified"), JSON.stringify(design.block_reasons));
});

withFixture("FIX-12 dangling *_evidence_refs blocks dangling_evidence_ref", (fx) => {
  const adjudication = passEvidence("review_complete", "main_adjudication", {
    evidence_id: "EV-adjudication",
    execution_mode: "direct",
    created_by: "main-thread",
    review_decision: "allow",
    source_evidence_refs: ["EV-ghost-guidance"],
    verification_evidence_refs: ["EV-verifier-verification"],
  });
  const verification = verifyEvidence(fx, "verifier");
  const finalTest = finalTestEvidence(fx);
  const problems = guard.evidence_schema_guard("demo-change", fx.change, fx.repo, [adjudication, verification, finalTest]);
  assert.ok(codes(problems).includes("dangling_evidence_ref"), JSON.stringify(problems));
  const dangling = problems.filter((item) => item.code === "dangling_evidence_ref");
  assert.equal(dangling.length, 1, JSON.stringify(dangling));
  assert.ok(dangling[0].message.includes("EV-ghost-guidance"), JSON.stringify(dangling));
});

withFixture("FIX-12 dangling lane_evidence_refs object values block dangling_evidence_ref", (fx) => {
  const workflow = roleEvidence(fx, "review_complete", "code-reviewer", {
    evidence_id: "EV-workflow",
    workflow: "code-review",
    execution_mode: "workflow",
    lane_evidence_refs: { "code-reviewer": "EV-ghost-lane", architect: "EV-architect-lane" },
  });
  const architectLane = roleEvidence(fx, "review_complete", "architect", { evidence_id: "EV-architect-lane" });
  const problems = guard.evidence_schema_guard("demo-change", fx.change, fx.repo, [workflow, architectLane]);
  const dangling = problems.filter((item) => item.code === "dangling_evidence_ref");
  assert.equal(dangling.length, 1, JSON.stringify(problems));
  assert.ok(dangling[0].message.includes("EV-ghost-lane"), JSON.stringify(dangling));
});

withFixture("FIX-12 fully resolved evidence refs do not report dangling", (fx) => {
  const guidance = roleEvidence(fx, "review_complete", "critic", { evidence_id: "EV-critic-guidance" });
  const adjudication = passEvidence("review_complete", "main_adjudication", {
    evidence_id: "EV-adjudication",
    execution_mode: "direct",
    created_by: "main-thread",
    review_decision: "allow",
    source_evidence_refs: ["EV-critic-guidance"],
  });
  const problems = guard.evidence_schema_guard("demo-change", fx.change, fx.repo, [guidance, adjudication]);
  assert.ok(!codes(problems).includes("dangling_evidence_ref"), JSON.stringify(problems));
});

// FIX-13 (audit F-1): backfill tests for previously-untested reason codes, grouped by defense line.

withFixture("FIX-13 evidence schema base defenses", (fx) => {
  const problems = guard.evidence_schema_guard("demo-change", fx.change, fx.repo, [
    { _invalid: true, _path: "evidence/bad.json" },
    passEvidence("design_complete", "review", { evidence_id: "EV-bad-status", status: "maybe" }),
    passEvidence("design_complete", "review", { evidence_id: "EV-wrong-change", change_id: "other-change" }),
    passEvidence("design_complete", "review", { evidence_id: "EV-forbidden", current_stage: "apply" }),
  ]);
  const reasonSet = codes(problems);
  for (const code of ["evidence_unparsable", "evidence_bad_status", "evidence_change_mismatch", "evidence_forbidden_field"]) {
    assert.ok(reasonSet.includes(code), `${code}: ${JSON.stringify(problems)}`);
  }
});

withFixture("FIX-13 role evidence schema defenses", (fx) => {
  const problems = guard.evidence_schema_guard("demo-change", fx.change, fx.repo, [
    roleEvidence(fx, "design_complete", "architect", { target_refs: [] }),
    roleEvidence(fx, "design_complete", "critic", { execution_mode: "remote_api" }),
  ]);
  const reasonSet = codes(problems);
  assert.ok(reasonSet.includes("missing_target_refs"), JSON.stringify(problems));
  assert.ok(reasonSet.includes("missing_native_subagent_evidence"), JSON.stringify(problems));
});

withFixture("FIX-13 source guidance contract defenses", (fx) => {
  const problems = guard.evidence_schema_guard("demo-change", fx.change, fx.repo, [
    reviewEvidence(fx, "intern"),
    reviewEvidence(fx, "critic", {
      evidence_id: "EV-bad-load",
      required_load_refs: [{ path: "not-in-sources.md", blob_sha: "deadbeef" }],
    }),
    reviewEvidence(fx, "architect", {
      evidence_id: "EV-bad-findings",
      blocking_findings: [{}],
    }),
    reviewEvidence(fx, "code-reviewer", {
      evidence_id: "EV-bad-dispositions",
      blocking_findings: [{ finding_id: "FINDING-001", affected_task_ids: ["TASK-001"] }],
      finding_dispositions: [],
    }),
  ]);
  const reasonSet = codes(problems);
  for (const code of ["review_guidance_role_invalid", "required_load_invalid", "blocking_findings_invalid", "finding_disposition_invalid"]) {
    assert.ok(reasonSet.includes(code), `${code}: ${JSON.stringify(problems)}`);
  }
});

withFixture("FIX-13 adjudication entry defenses", (fx) => {
  const problems = guard.evidence_schema_guard("demo-change", fx.change, fx.repo, [
    mainAdjudication(fx, [], {
      claim_adjudications: [{}],
      finding_adjudications: [{}],
    }),
  ]);
  const reasonSet = codes(problems);
  assert.ok(reasonSet.includes("claim_adjudication_invalid"), JSON.stringify(problems));
  assert.ok(reasonSet.includes("finding_adjudication_invalid"), JSON.stringify(problems));
});

withFixture("FIX-13 verification evidence defenses", (fx) => {
  const problems = guard.evidence_schema_guard("demo-change", fx.change, fx.repo, [
    verifyEvidence(fx, "intern"),
    passEvidence("review_complete", "final_test", { evidence_id: "EV-bare-final-test" }),
    verifyEvidence(fx, "verifier", { openspec_validate_ref: "../../escape.txt", create_refs: false }),
  ]);
  const reasonSet = codes(problems);
  for (const code of ["verification_role_invalid", "verification_evidence_incomplete", "verification_ref_invalid"]) {
    assert.ok(reasonSet.includes(code), `${code}: ${JSON.stringify(problems)}`);
  }
});

withFixture("FIX-13 code-review workflow evidence defenses", (fx) => {
  const schemaProblems = guard.evidence_schema_guard("demo-change", fx.change, fx.repo, [
    passEvidence("review_complete", "workflow_review", {
      evidence_id: "EV-bad-workflow",
      workflow: "perf-review",
      execution_mode: "direct",
    }),
    passEvidence("review_complete", "workflow_review", {
      evidence_id: "EV-incomplete-workflow",
      workflow: "code-review",
      execution_mode: "workflow",
    }),
  ]);
  const schemaSet = codes(schemaProblems);
  assert.ok(schemaSet.includes("workflow_evidence_invalid"), JSON.stringify(schemaProblems));
  assert.ok(schemaSet.includes("code_review_workflow_incomplete"), JSON.stringify(schemaProblems));

  const architectLane = passEvidence("review_complete", "review", {
    evidence_id: "EV-arch-lane",
    agent_role: "critic",
    execution_mode: "native_subagent",
  });
  const workflowEv = passEvidence("review_complete", "workflow_review", {
    evidence_id: "EV-workflow",
    workflow: "code-review",
    execution_mode: "workflow",
    lane_evidence_refs: { "code-reviewer": "EV-missing-lane", architect: "EV-arch-lane" },
  });
  const laneProblems = guard.code_review_lane_evidence_reasons(workflowEv, [workflowEv, architectLane]);
  const laneSet = codes(laneProblems);
  assert.ok(laneSet.includes("code_review_lane_evidence_missing"), JSON.stringify(laneProblems));
  assert.ok(laneSet.includes("code_review_lane_role_mismatch"), JSON.stringify(laneProblems));
});

withFixture("FIX-13 init surface defenses", (fx) => {
  writeText(join(fx.repo, ".codex", "hooks.json"), "{}\n");
  writeText(join(fx.repo, "openspec", "schemas", "superspec", "schema.yaml"), "custom\n");
  const brokenStatus = {
    ...status(fx),
    artifacts: [
      { id: "proposal", status: "done", missingDeps: [] },
      { id: "specs", status: "done", missingDeps: [] },
      { id: "design", status: "done", missingDeps: [] },
      { id: "epics", status: "done", missingDeps: [] },
    ],
    applyRequires: [],
  };
  const decision = guard.check_init("demo-change", brokenStatus, fx.repo, fx.change);
  assert.equal(decision.allowed, false);
  const reasonSet = codes(decision.block_reasons);
  for (const code of ["missing_openspec_artifacts", "unexpected_openspec_artifacts", "unexpected_apply_requires", "v1_hook_artifact_present", "custom_superspec_schema_present"]) {
    assert.ok(reasonSet.includes(code), `${code}: ${JSON.stringify(decision.block_reasons)}`);
  }
});

withFixture("FIX-13 artifact entry defenses", (fx) => {
  const bogus = guard.check_artifact("demo-change", status(fx), fx.change, [], "bogus");
  assert.equal(bogus.allowed, false);
  assert.ok(codes(bogus.block_reasons).includes("not_openspec_artifact"));

  const missingDesign = { ...status(fx), artifacts: status(fx).artifacts.filter((item: JsonMap) => item.id !== "design") };
  const unknown = guard.check_artifact("demo-change", missingDesign, fx.change, [], "design");
  assert.equal(unknown.allowed, false);
  assert.ok(codes(unknown.block_reasons).includes("unknown_artifact"));

  const blockedDesign = {
    ...status(fx),
    artifacts: status(fx).artifacts.map((item: JsonMap) => item.id === "design" ? { ...item, status: "blocked", missingDeps: ["proposal"] } : item),
  };
  const blocked = guard.check_artifact("demo-change", blockedDesign, fx.change, [], "design");
  assert.equal(blocked.allowed, false);
  assert.ok(codes(blocked.block_reasons).includes("openspec_blocked"));
});

withFixture("FIX-13 gate routing defenses", (fx) => {
  const unknownGate = guard.check_superspec_gate("demo-change", status(fx), fx.change, [], "no_such_gate");
  assert.equal(unknownGate.allowed, false);
  assert.ok(codes(unknownGate.block_reasons).includes("unknown_gate"));

  const design = guard.check_superspec_gate("demo-change", status(fx, { design: "ready" }), fx.change, [], "design_complete");
  assert.ok(codes(design.block_reasons).includes("missing_design"));

  const drafted = guard.check_superspec_gate("demo-change", status(fx), fx.change, [], "test_contract_drafted");
  assert.ok(codes(drafted.block_reasons).includes("invariants_not_reviewed"));

  writeText(join(fx.change, ".superspec", "artifacts", "business-invariants.md"), "free prose with no table\n");
  const invariants = guard.check_superspec_gate("demo-change", status(fx), fx.change, [], "invariants_reviewed");
  assert.ok(codes(invariants.block_reasons).includes("invalid_business_invariants"));

  writeText(join(fx.change, "tasks.md"), "notes only, no structured tasks\n");
  const tasksGate = guard.check_superspec_gate("demo-change", status(fx), fx.change, [], "tasks_complete");
  assert.ok(codes(tasksGate.block_reasons).includes("invalid_task_graph"));
});

withFixture("FIX-13 review readiness defenses", (fx) => {
  writeText(join(fx.change, "tasks.md"), "- [ ] TASK-001 Implement\n  - test_refs: TEST-001\n");
  const ready = withRuntime({ openspec_validate: () => [true, ""], dirty_worktree_reasons: () => [] }, () =>
    guard.check_review_ready("demo-change", status(fx, { proposal: "ready" }), fx.change, []));
  assert.equal(ready.allowed, false);
  const readySet = codes(ready.block_reasons);
  assert.ok(readySet.includes("artifacts_incomplete"), JSON.stringify(ready.block_reasons));
  assert.ok(readySet.includes("tasks_incomplete"), JSON.stringify(ready.block_reasons));

  const complete = withRuntime({ openspec_validate: () => [true, ""], dirty_worktree_reasons: () => [] }, () =>
    guard.check_review_complete("demo-change", status(fx, { proposal: "ready" }), fx.change, []));
  assert.equal(complete.allowed, false);
  assert.ok(codes(complete.block_reasons).includes("review_not_ready"), JSON.stringify(complete.block_reasons));

  const archive = withRuntime({ openspec_validate: () => [true, ""], dirty_worktree_reasons: () => [] }, () =>
    guard.check_archive_ready("demo-change", status(fx), fx.change, []));
  assert.equal(archive.allowed, false);
  assert.ok(codes(archive.block_reasons).includes("review_gate_failed"), JSON.stringify(archive.block_reasons));
});

withFixture("FIX-13 TDD enumeration defenses", (fx) => {
  const evidences = prepareProposeComplete(fx, {
    tasksText:
      "- [ ] TASK-101 Bad mode\n" +
      "  - tdd_mode: time-travel\n" +
      "  - test_refs: TEST-001\n" +
      "  - invariant_refs: INV-001\n" +
      "- [ ] TASK-102 Bad exemption\n" +
      "  - tdd_required: false\n" +
      "  - no_tdd_reason: vibes\n" +
      "- [ ] TASK-103 Refactor\n" +
      "  - tdd_mode: behavior-preserving-refactor\n" +
      "  - test_refs: TEST-001\n" +
      "  - invariant_refs: INV-001\n" +
      "- [x] TASK-104 Done already\n",
  });
  const cases: Array<[string, string]> = [
    ["TASK-101", "invalid_tdd_mode"],
    ["TASK-102", "invalid_no_tdd_reason"],
    ["TASK-103", "missing_characterization"],
    ["TASK-104", "task_already_done"],
  ];
  for (const [taskId, code] of cases) {
    const decision = guard.check_task_edit("demo-change", status(fx), fx.change, evidences, taskId);
    assert.equal(decision.allowed, false, taskId);
    assert.ok(codes(decision.block_reasons).includes(code), `${taskId} ${code}: ${JSON.stringify(codes(decision.block_reasons))}`);
  }
});

withFixture("FIX-13 RED evidence id and invariant defenses", (fx) => {
  const evidences = [
    ...prepareProposeComplete(fx),
    redEvidence("TASK-001", "", ["INV-001"], { evidence_id: "EV-red-no-test-id" }),
    redEvidence("TASK-001", "TEST-999", ["INV-001"], { evidence_id: "EV-red-unknown-test" }),
    redEvidence("TASK-001", "TEST-001", [], { evidence_id: "EV-red-no-invariants" }),
    redEvidence("TASK-001", "TEST-001", ["INV-999"], { evidence_id: "EV-red-unknown-invariant" }),
  ];
  const decision = guard.check_task_edit("demo-change", status(fx), fx.change, evidences, "TASK-001");
  assert.equal(decision.allowed, false);
  const reasonSet = codes(decision.block_reasons);
  for (const code of ["missing_test_id", "test_contract_not_honored", "missing_invariant_ref", "invalid_invariant_ref"]) {
    assert.ok(reasonSet.includes(code), `${code}: ${JSON.stringify(reasonSet)}`);
  }
});

withFixture("FIX-13 reopen lifecycle defenses", (fx) => {
  const checkedEvidences = [
    ...prepareProposeComplete(fx, { checked: true }),
    taskReopenEvidence(fx),
  ];
  const pending = guard.check_task_edit("demo-change", status(fx), fx.change, checkedEvidences, "TASK-001");
  assert.equal(pending.allowed, false);
  assert.ok(codes(pending.block_reasons).includes("task_reopen_pending_revert"), JSON.stringify(codes(pending.block_reasons)));

  const ambiguousEvidences = [
    ...checkedEvidences,
    taskReopenEvidence(fx, { evidence_id: "EV-task-reopen-2", reopen_id: "reopen-002" }),
  ];
  setTaskCheckbox(fx.change, "TASK-001", false);
  const ambiguous = guard.check_task_edit("demo-change", status(fx), fx.change, ambiguousEvidences, "TASK-001");
  assert.equal(ambiguous.allowed, false);
  assert.ok(codes(ambiguous.block_reasons).includes("ambiguous_task_reopen"), JSON.stringify(codes(ambiguous.block_reasons)));
});

withFixture("FIX-13 scope expansion cannot ride task_reopen", (fx) => {
  const evidences = [
    ...prepareProposeComplete(fx, { checked: true }),
    taskReopenEvidence(fx, { scope_expansion: true }),
  ];
  const decision = guard.check_task_reopen("demo-change", status(fx), fx.change, evidences, "TASK-001");
  assert.equal(decision.allowed, false);
  assert.ok(codes(decision.block_reasons).includes("scope_expansion_requires_propose"), JSON.stringify(codes(decision.block_reasons)));
});

withFixture("FIX-13 ambiguous main adjudication blocks review_complete", (fx) => {
  const guidance = [
    ...reviewGuidanceEvidences(fx),
    reviewEvidence(fx, "critic"),
  ];
  const evidences = [
    ...prepareProposeComplete(fx, { checked: true }),
    greenEvidence(),
    ...guidance,
    mainAdjudication(fx, guidance),
    mainAdjudication(fx, guidance, { evidence_id: "EV-main-adjudication-2" }),
    verifyEvidence(fx, "verifier"),
    verifyEvidence(fx, "critic"),
    finalTestEvidence(fx),
  ];
  const decision = withRuntime({ openspec_validate: () => [true, ""], dirty_worktree_reasons: () => [] }, () =>
    guard.check_review_complete("demo-change", status(fx), fx.change, evidences));
  assert.equal(decision.allowed, false);
  assert.ok(codes(decision.block_reasons).includes("ambiguous_main_adjudication"), JSON.stringify(codes(decision.block_reasons)));
});

withFixture("FIX-13 review completion disposition defenses", (fx) => {
  const guidance = [
    ...reviewGuidanceEvidences(fx),
    reviewEvidence(fx, "critic", { rollback_targets: [] }),
  ];
  const claims = guidance.flatMap((ev) => Array.isArray(ev.required_claim_ids) ? ev.required_claim_ids : []);
  const evidences = [
    ...prepareProposeComplete(fx, { checked: true }),
    greenEvidence(),
    ...guidance,
    mainAdjudication(fx, guidance, {
      claim_adjudications: claims.map((claimId: string) => ({ claim_id: claimId, decision: "needs_fix", rationale: "unresolved" })),
    }),
    verifyEvidence(fx, "verifier", { scope_drift: "expanded" }),
    verifyEvidence(fx, "critic"),
    finalTestEvidence(fx),
  ];
  const decision = withRuntime({ openspec_validate: () => [true, ""], dirty_worktree_reasons: () => [] }, () =>
    guard.check_review_complete("demo-change", status(fx), fx.change, evidences));
  assert.equal(decision.allowed, false);
  const reasonSet = codes(decision.block_reasons);
  for (const code of ["claim_adjudication_blocked", "missing_rollback_target", "scope_drift"]) {
    assert.ok(reasonSet.includes(code), `${code}: ${JSON.stringify(reasonSet)}`);
  }
});

withFixture("FIX-13 infra failure defenses", (fx) => {
  assert.ok(codes(guard.openspec_status_shape_reasons({})).includes("openspec_status_incompatible"));

  const diffProblems = withRuntime({
    review_diff_paths: () => {
      throw new Error("git unavailable");
    },
  }, () => guard.review_diff_coverage_reasons(fx.repo, { _path: "ev", base_ref: "a", head_ref: "b", reviewed_files: ["tasks.md"] }));
  assert.ok(codes(diffProblems).includes("review_diff_unavailable"), JSON.stringify(diffProblems));

  const writes: string[] = [];
  const savedWrite = process.stdout.write;
  process.stdout.write = ((chunk: any) => {
    writes.push(String(chunk));
    return true;
  }) as typeof process.stdout.write;
  let exitCode: number;
  try {
    exitCode = withRuntime({
      load_context: () => {
        throw new TypeError("boom");
      },
    }, () => guard.main(["status", "--change", "demo-change"]));
  } finally {
    process.stdout.write = savedWrite;
  }
  assert.equal(exitCode, 2);
  const printed = JSON.parse(writes.join(""));
  assert.ok(codes(printed.block_reasons).includes("guard_internal_error"), JSON.stringify(printed.block_reasons));
});

withFixture("FIX-13 missing openspec CLI defenses", (fx) => {
  const savedPath = process.env.PATH;
  process.env.PATH = "";
  try {
    assert.ok(codes(guard.openspec_cli_capability_reasons()).includes("openspec_cli_unavailable"));
    const summary = project_init(fx.repo);
    assert.equal(summary.allowed, false);
    assert.ok(codes(summary.block_reasons).includes("project_init_failed"), JSON.stringify(summary.block_reasons));
    assert.match(String(summary.block_reasons[0].message), /OpenSpec CLI/);
  } finally {
    process.env.PATH = savedPath;
  }
});

withFixture("FIX-6 corrupt state suppresses supersede ledger recording", (fx) => {
  guard.ensure_sidecar_layout(fx.change);
  writeText(join(fx.change, ".superspec", "superspec-state.json"), "{not json\n");
  const ledgerBefore = existsSync(join(fx.change, ".superspec", "ledger.jsonl"))
    ? readFileSync(join(fx.change, ".superspec", "ledger.jsonl"), "utf8")
    : "";
  const evidences = [
    greenEvidence("TASK-001", "TEST-001", ["INV-001"], { evidence_id: "EV-old-green" }),
    passEvidence("task_complete", "superseded", {
      evidence_id: "EV-kill",
      status: "superseded",
      supersedes: "EV-old-green",
    }),
  ];
  withRuntime({ load_context: () => [status(fx), fx.repo, fx.change, evidences] }, () => {
    const [decision] = guard.dispatch({ command: "check-task-complete", change: "demo-change", task_id: "TASK-001" });
    assert.equal(decision.allowed, false);
    assert.ok(codes(decision.block_reasons).includes("state_corrupt"));
  });
  const ledgerAfter = existsSync(join(fx.change, ".superspec", "ledger.jsonl"))
    ? readFileSync(join(fx.change, ".superspec", "ledger.jsonl"), "utf8")
    : "";
  assert.equal(ledgerAfter, ledgerBefore);
});

withFixture("review ready blocks forged task reopen resolution without successor evidence", (fx) => {
  const guidance = [
    ...reopenGuidanceEvidences(fx),
    reviewEvidence(fx, "critic"),
  ];
  const evidences = [
    ...prepareProposeComplete(fx, { checked: true }),
    greenEvidence("TASK-001", "TEST-001", ["INV-001"], { evidence_id: "EV-old-green" }),
    ...guidance,
    mainAdjudication(fx, guidance, {
      review_decision: "request_changes",
      request_changes_route: "reopen_tasks",
      blocking_source_evidence_refs: ["EV-code-reviewer-guidance"],
      reopen_task_ids: ["TASK-001"],
      verification_evidence_refs: [],
    }),
    taskReopenEvidence(fx),
    taskReopenResolvedEvidence(fx, {
      successor_completion_evidence_ids: ["EV-forged-missing-successor"],
    }),
  ];
  withRuntime({ openspec_validate: () => [true, ""], dirty_worktree_reasons: () => [] }, () => {
    const decision = guard.check_review_ready("demo-change", status(fx), fx.change, evidences);
    assert.equal(decision.allowed, false);
    assert.ok(codes(decision.block_reasons).includes("task_reopen_resolved_invalid"));
    assert.ok(codes(decision.block_reasons).includes("missing_reopen_successor"));
  });
});

withFixture("review ready blocks resolved task_reopen when task was removed from tasks", (fx) => {
  const guidance = [
    ...reopenGuidanceEvidences(fx),
    reviewEvidence(fx, "critic"),
  ];
  const baseEvidences = prepareProposeComplete(fx, { checked: true });
  const reopen = taskReopenEvidence(fx, {
    invalidated_completion_evidence_ids: [],
    required_supersede_evidence_ids: [],
  });
  writeText(
    join(fx.change, "tasks.md"),
    "- [x] TASK-002 Replacement\n" +
      "  - invariant_refs: INV-001\n" +
      "  - test_refs: TEST-001\n",
  );
  const evidences = [
    ...baseEvidences,
    greenEvidence("TASK-002", "TEST-001", ["INV-001"], { evidence_id: "EV-task-002-green" }),
    ...guidance,
    mainAdjudication(fx, guidance, {
      review_decision: "request_changes",
      request_changes_route: "reopen_tasks",
      blocking_source_evidence_refs: ["EV-code-reviewer-guidance"],
      reopen_task_ids: ["TASK-001"],
      verification_evidence_refs: [],
    }),
    reopen,
    greenEvidence("TASK-001", "TEST-001", ["INV-001"], {
      evidence_id: "EV-green-successor",
      reopen_id: "reopen-001",
    }),
    taskReopenResolvedEvidence(fx),
  ];
  withRuntime({ openspec_validate: () => [true, ""], dirty_worktree_reasons: () => [] }, () => {
    const decision = guard.check_review_ready("demo-change", status(fx), fx.change, evidences);
    assert.equal(decision.allowed, false);
    assert.ok(codes(decision.block_reasons).includes("unknown_task"));
  });
});

withFixture("review ready rejects wrong-gate task reopen resolution", (fx) => {
  const guidance = [
    ...reopenGuidanceEvidences(fx),
    reviewEvidence(fx, "critic"),
  ];
  const evidences = [
    ...prepareProposeComplete(fx, { checked: true }),
    greenEvidence("TASK-001", "TEST-001", ["INV-001"], { evidence_id: "EV-old-green" }),
    supersededEvidence("EV-old-green"),
    ...guidance,
    mainAdjudication(fx, guidance, {
      review_decision: "request_changes",
      request_changes_route: "reopen_tasks",
      blocking_source_evidence_refs: ["EV-code-reviewer-guidance"],
      reopen_task_ids: ["TASK-001"],
      verification_evidence_refs: [],
    }),
    taskReopenEvidence(fx),
    greenEvidence("TASK-001", "TEST-001", ["INV-001"], {
      evidence_id: "EV-green-successor",
      reopen_id: "reopen-001",
    }),
    taskReopenResolvedEvidence(fx, {
      gate: "review_complete",
    }),
  ];
  withRuntime({ openspec_validate: () => [true, ""], dirty_worktree_reasons: () => [] }, () => {
    const decision = guard.check_review_ready("demo-change", status(fx), fx.change, evidences);
    assert.equal(decision.allowed, false);
    assert.ok(codes(decision.block_reasons).includes("unresolved_task_reopen"));
  });
});

withFixture("task complete rejects wrong-gate task reopen resolution", (fx) => {
  const guidance = [
    ...reopenGuidanceEvidences(fx),
    reviewEvidence(fx, "critic"),
  ];
  const evidences = [
    ...prepareProposeComplete(fx, { checked: true }),
    greenEvidence("TASK-001", "TEST-001", ["INV-001"], { evidence_id: "EV-old-green" }),
    supersededEvidence("EV-old-green"),
    ...guidance,
    mainAdjudication(fx, guidance, {
      review_decision: "request_changes",
      request_changes_route: "reopen_tasks",
      blocking_source_evidence_refs: ["EV-code-reviewer-guidance"],
      reopen_task_ids: ["TASK-001"],
      verification_evidence_refs: [],
    }),
    taskReopenEvidence(fx),
    greenEvidence("TASK-001", "TEST-001", ["INV-001"], {
      evidence_id: "EV-green-successor",
      reopen_id: "reopen-001",
    }),
    taskReopenResolvedEvidence(fx, {
      gate: "review_complete",
    }),
  ];
  const decision = guard.check_task_complete("demo-change", status(fx), fx.change, evidences, "TASK-001");
  assert.equal(decision.allowed, false);
  assert.ok(codes(decision.block_reasons).includes("unresolved_task_reopen"));
});

withFixture("review ready blocks task reopen resolution with mismatched reopen id", (fx) => {
  const guidance = [
    ...reopenGuidanceEvidences(fx),
    reviewEvidence(fx, "critic"),
  ];
  const evidences = [
    ...prepareProposeComplete(fx, { checked: true }),
    greenEvidence("TASK-001", "TEST-001", ["INV-001"], { evidence_id: "EV-old-green" }),
    supersededEvidence("EV-old-green"),
    ...guidance,
    mainAdjudication(fx, guidance, {
      review_decision: "request_changes",
      request_changes_route: "reopen_tasks",
      blocking_source_evidence_refs: ["EV-code-reviewer-guidance"],
      reopen_task_ids: ["TASK-001"],
      verification_evidence_refs: [],
    }),
    taskReopenEvidence(fx),
    greenEvidence("TASK-001", "TEST-001", ["INV-001"], {
      evidence_id: "EV-green-successor",
      reopen_id: "reopen-001",
    }),
    taskReopenResolvedEvidence(fx, {
      reopen_id: "wrong-reopen-id",
    }),
  ];
  withRuntime({ openspec_validate: () => [true, ""], dirty_worktree_reasons: () => [] }, () => {
    const decision = guard.check_review_ready("demo-change", status(fx), fx.change, evidences);
    assert.equal(decision.allowed, false);
    assert.ok(codes(decision.block_reasons).includes("task_reopen_resolved_invalid"));
    assert.ok(codes(decision.block_reasons).includes("unresolved_task_reopen"));
  });
});

withFixture("review ready blocks cross-task task reopen resolution from closing another task", (fx) => {
  const guidance = [
    ...reopenGuidanceEvidences(fx),
    reviewEvidence(fx, "critic"),
  ];
  const evidences = [
    ...prepareProposeComplete(fx, { checked: true }),
    greenEvidence("TASK-001", "TEST-001", ["INV-001"], { evidence_id: "EV-old-green" }),
    supersededEvidence("EV-old-green"),
    ...guidance,
    mainAdjudication(fx, guidance, {
      review_decision: "request_changes",
      request_changes_route: "reopen_tasks",
      blocking_source_evidence_refs: ["EV-code-reviewer-guidance"],
      reopen_task_ids: ["TASK-001"],
      verification_evidence_refs: [],
    }),
    taskReopenEvidence(fx),
    greenEvidence("TASK-001", "TEST-001", ["INV-001"], {
      evidence_id: "EV-green-successor",
      reopen_id: "reopen-001",
    }),
    taskReopenResolvedEvidence(fx, {
      task_id: "TASK-999",
    }),
  ];
  withRuntime({ openspec_validate: () => [true, ""], dirty_worktree_reasons: () => [] }, () => {
    const decision = guard.check_review_ready("demo-change", status(fx), fx.change, evidences);
    assert.equal(decision.allowed, false);
    assert.ok(codes(decision.block_reasons).includes("unresolved_task_reopen"));
  });
});

withFixture("review ready blocks multiple resolved task_reopen histories for same task", (fx) => {
  const guidance = [
    ...reopenGuidanceEvidences(fx),
    reviewEvidence(fx, "critic"),
  ];
  const evidences = [
    ...prepareProposeComplete(fx, { checked: true }),
    ...guidance,
    mainAdjudication(fx, guidance, {
      review_decision: "request_changes",
      request_changes_route: "reopen_tasks",
      blocking_source_evidence_refs: ["EV-code-reviewer-guidance"],
      reopen_task_ids: ["TASK-001"],
      verification_evidence_refs: [],
    }),
    taskReopenEvidence(fx, {
      evidence_id: "EV-task-reopen-1",
      reopen_id: "reopen-001",
      invalidated_completion_evidence_ids: [],
      required_supersede_evidence_ids: [],
    }),
    taskReopenEvidence(fx, {
      evidence_id: "EV-task-reopen-2",
      reopen_id: "reopen-002",
      invalidated_completion_evidence_ids: [],
      required_supersede_evidence_ids: [],
    }),
    greenEvidence("TASK-001", "TEST-001", ["INV-001"], {
      evidence_id: "EV-green-successor-1",
      reopen_id: "reopen-001",
    }),
    greenEvidence("TASK-001", "TEST-001", ["INV-001"], {
      evidence_id: "EV-green-successor-2",
      reopen_id: "reopen-002",
    }),
    taskReopenResolvedEvidence(fx, {
      evidence_id: "EV-task-reopen-resolved-1",
      reopen_evidence_id: "EV-task-reopen-1",
      reopen_id: "reopen-001",
      successor_completion_evidence_ids: ["EV-green-successor-1"],
    }),
    taskReopenResolvedEvidence(fx, {
      evidence_id: "EV-task-reopen-resolved-2",
      reopen_evidence_id: "EV-task-reopen-2",
      reopen_id: "reopen-002",
      successor_completion_evidence_ids: ["EV-green-successor-2"],
    }),
  ];
  withRuntime({ openspec_validate: () => [true, ""], dirty_worktree_reasons: () => [] }, () => {
    const decision = guard.check_review_ready("demo-change", status(fx), fx.change, evidences);
    assert.equal(decision.allowed, false);
    assert.ok(codes(decision.block_reasons).includes("reopen_lifecycle_exhausted"));
  });
});

withFixture("review ready allows task reopen resolution with bound successor evidence", (fx) => {
  const guidance = [
    ...reopenGuidanceEvidences(fx),
    reviewEvidence(fx, "critic"),
  ];
  const evidences = [
    ...prepareProposeComplete(fx, { checked: true }),
    greenEvidence("TASK-001", "TEST-001", ["INV-001"], { evidence_id: "EV-old-green" }),
    supersededEvidence("EV-old-green"),
    ...guidance,
    mainAdjudication(fx, guidance, {
      review_decision: "request_changes",
      request_changes_route: "reopen_tasks",
      blocking_source_evidence_refs: ["EV-code-reviewer-guidance"],
      reopen_task_ids: ["TASK-001"],
      verification_evidence_refs: [],
    }),
    taskReopenEvidence(fx),
    greenEvidence("TASK-001", "TEST-001", ["INV-001"], {
      evidence_id: "EV-green-successor",
      reopen_id: "reopen-001",
    }),
    taskReopenResolvedEvidence(fx),
  ];
  withRuntime({ openspec_validate: () => [true, ""], dirty_worktree_reasons: () => [] }, () => {
    const decision = guard.check_review_ready("demo-change", status(fx), fx.change, evidences);
    assert.equal(decision.allowed, true, JSON.stringify(decision));
  });
});

withFixture("review evidence requiring raw artifacts blocks when missing", (fx) => {
  const ev = reviewEvidence(fx, "critic", {
    requires_raw_artifact_refs: true,
  });
  delete ev.raw_artifact_refs;
  const problems = guard.validate_evidence_schema(ev, "demo-change", fx.change, fx.repo);
  assert.ok(codes(problems).includes("raw_artifact_refs_required"));
});

withFixture("dirty worktree unknown source blocks without human confirmation", (fx) => {
  withRuntime({ dirty_worktree_paths: () => ["unrelated.txt"] }, () => {
    const reasons = guard.dirty_worktree_reasons(fx.repo, fx.change, []);
    assert.deepEqual(codes(reasons), ["dirty_worktree_unattributed"]);
  });
});

withFixture("dirty worktree human confirmation allows attribution", (fx) => {
  withRuntime({ dirty_worktree_paths: () => ["unrelated.txt"] }, () => {
    const reasons = guard.dirty_worktree_reasons(fx.repo, fx.change, [passEvidence("branch_handling", "human_confirmation", { confirmed_paths: ["unrelated.txt"] })]);
    assert.deepEqual(reasons, []);
  });
});

withFixture("A-3 human_confirmation only waives its declared paths", (fx) => {
  withRuntime({ dirty_worktree_paths: () => ["unrelated-a.txt", "unrelated-b.txt"] }, () => {
    const reasons = guard.dirty_worktree_reasons(fx.repo, fx.change, [passEvidence("branch_handling", "human_confirmation", { confirmed_paths: ["unrelated-a.txt"] })]);
    assert.deepEqual(codes(reasons), ["dirty_worktree_unattributed"]);
    assert.deepEqual(reasons[0].refs, []);
    assert.ok(reasons[0].message.includes("unrelated-b.txt"));
  });
});

withFixture("dirty worktree parses porcelain z paths with spaces", (fx) => {
  writeText(join(fx.repo, "unrelated file.txt"), "dirty\n");
  assert.ok(guard.dirty_worktree_paths(fx.repo).includes("unrelated file.txt"));
});

withFixture("dirty worktree expands rename source paths for write scope checks", (fx) => {
  writeText(join(fx.repo, "src", "old.txt"), "old\n");
  assert.equal(spawnSync("git", ["add", "src/old.txt"], { cwd: fx.repo }).status, 0);
  assert.equal(spawnSync("git", ["-c", "user.name=Test", "-c", "user.email=test@example.com", "commit", "-m", "base"], { cwd: fx.repo, stdio: "ignore" }).status, 0);
  mkdirp(join(fx.repo, "dst"));
  assert.equal(spawnSync("git", ["mv", "src/old.txt", "dst/new name.txt"], { cwd: fx.repo }).status, 0);

  const dirty = guard.dirty_worktree_paths(fx.repo);
  assert.ok(dirty.includes("src/old.txt"));
  assert.ok(dirty.includes("dst/new name.txt"));

  const tasks = {
    "TASK-001": {
      task_id: "TASK-001",
      checked: false,
      desc: "Implement",
      attrs: { write_scope: "src" },
    },
  };
  assert.ok(codes(guard.dirty_write_scope_red_reasons(fx.repo, tasks, [])).includes("missing_red_evidence"));

  const attributionReasons = guard.dirty_worktree_reasons(
    fx.repo,
    fx.change,
    [passEvidence("branch_handling", "human_confirmation", { confirmed_paths: ["dst"] })],
  );
  assert.deepEqual(codes(attributionReasons), ["dirty_worktree_unattributed"]);
  assert.ok(attributionReasons[0].message.includes("src/old.txt"));
});

withFixture("workflow dirty write scope inspection fails closed", (fx) => {
  const tasks = {
    "TASK-001": {
      task_id: "TASK-001",
      checked: false,
      desc: "Implement",
      attrs: { write_scope: "src" },
    },
  };
  withRuntime({ dirty_worktree_paths: () => { throw new Error("git unavailable"); } }, () => {
    const reasons = guard.dirty_write_scope_red_reasons(fx.repo, tasks, []);
    assert.deepEqual(codes(reasons), ["dirty_worktree_unavailable"]);
  });
});

withFixture("review ready dirty worktree inspection fails closed", (fx) => {
  withRuntime({
    dirty_worktree_paths: () => { throw new Error("git unavailable"); },
    openspec_validate: () => [true, ""],
  }, () => {
    const decision = guard.check_review_ready("demo-change", status(fx), fx.change, []);
    assert.equal(decision.allowed, false);
    assert.ok(codes(decision.block_reasons).includes("dirty_worktree_unavailable"));
  });
});

withFixture("A-7 review_complete rejects duplicate output_ref", (fx) => {
  const sharedOutput = ".superspec/reports/shared-review.md";
  const guidance = [
    reviewEvidence(fx, "code-reviewer", { output_ref: sharedOutput }),
    reviewEvidence(fx, "architect", { output_ref: sharedOutput }),
    reviewEvidence(fx, "critic"),
  ];
  const evidences = [
    ...prepareProposeComplete(fx, { checked: true }),
    greenEvidence(),
    ...guidance,
    mainAdjudication(fx, guidance),
    verifyEvidence(fx, "verifier"),
    verifyEvidence(fx, "critic"),
    finalTestEvidence(fx),
  ];
  withRuntime({ openspec_validate: () => [true, ""], dirty_worktree_reasons: () => [] }, () => {
    const decision = guard.check_review_complete("demo-change", status(fx), fx.change, evidences);
    assert.equal(decision.allowed, false);
    assert.ok(codes(decision.block_reasons).includes("evidence_output_ref_duplicate"));
  });
});

withFixture("A-7 review_complete rejects path-aliased duplicate output_ref", (fx) => {
  const guidance = [
    reviewEvidence(fx, "code-reviewer", { output_ref: ".superspec/reports/shared-review.md" }),
    reviewEvidence(fx, "architect", { output_ref: ".superspec/reports/./shared-review.md" }),
    reviewEvidence(fx, "critic"),
  ];
  const evidences = [
    ...prepareProposeComplete(fx, { checked: true }),
    greenEvidence(),
    ...guidance,
    mainAdjudication(fx, guidance),
    verifyEvidence(fx, "verifier"),
    verifyEvidence(fx, "critic"),
    finalTestEvidence(fx),
  ];
  withRuntime({ openspec_validate: () => [true, ""], dirty_worktree_reasons: () => [] }, () => {
    const decision = guard.check_review_complete("demo-change", status(fx), fx.change, evidences);
    assert.equal(decision.allowed, false);
    assert.ok(codes(decision.block_reasons).includes("evidence_output_ref_duplicate"));
  });
});

withFixture("check verify ready compatibility alias recomputes review gate", (fx) => {
  writeText(join(fx.change, "tasks.md"), "- [x] TASK-001 Implement\n  - test_refs: TEST-001\n");
  const evidences = [
    passEvidence("review_complete"),
    verifyEvidence(fx, "verifier"),
    verifyEvidence(fx, "critic"),
    finalTestEvidence(fx),
  ];
  withRuntime({ openspec_validate: () => [true, ""], dirty_worktree_reasons: () => [] }, () => {
    const decision = guard.check_verify_complete("demo-change", status(fx), fx.change, evidences);
    assert.equal(decision.allowed, false);
    assert.equal(decision.gate, "review_complete");
    assert.ok(codes(decision.block_reasons).includes("missing_source_guidance"));
  });
});

withFixture("archive ready blocks when openspec validate fails", (fx) => {
  writeText(join(fx.change, "tasks.md"), "- [x] TASK-001 Implement\n  - test_refs: TEST-001\n");
  const guidance = [
    ...reviewGuidanceEvidences(fx),
    reviewEvidence(fx, "critic"),
  ];
  const evidences = [
    ...prepareProposeComplete(fx, { checked: true }),
    greenEvidence(),
    ...guidance,
    mainAdjudication(fx, guidance),
    verifyEvidence(fx, "verifier"),
    verifyEvidence(fx, "critic"),
    finalTestEvidence(fx),
    passEvidence("archive_ready", "human_confirmation"),
  ];
  withRuntime({ openspec_validate: () => [false, "invalid"], dirty_worktree_reasons: () => [] }, () => {
    const decision = guard.check_archive_ready("demo-change", status(fx), fx.change, evidences);
    assert.equal(decision.allowed, false);
    assert.ok(codes(decision.block_reasons).includes("validate_failed"));
  });
});

withFixture("dispatch clamps blocked route to openspec floor", (fx) => {
  const blockedStatus = status(fx, { specs: "blocked", design: "blocked", tasks: "blocked" });
  withRuntime({
    load_context: () => [blockedStatus, fx.repo, fx.change, []],
    openspec_validate: () => [true, ""],
    dirty_worktree_reasons: () => [],
  }, () => {
    const [decision] = guard.dispatch({ command: "check-review-ready", change: "demo-change" });
    const state = readJson(join(fx.change, ".superspec", "superspec-state.json"));
    assert.equal(decision.allowed, false);
    assert.equal(state.superspec.guard_route_phase, "init");
    assert.equal(state.superspec.requested_route_phase, "review");
  });
});

withFixture("state recompute after delete", (fx) => {
  const currentStatus = status(fx);
  const decision = guard.allow("demo-change", "recompute");
  guard.recompute_and_write_state("demo-change", fx.change, currentStatus, "tasks", "recompute", decision);
  rmSync(join(fx.change, ".superspec", "superspec-state.json"));
  guard.recompute_and_write_state("demo-change", fx.change, currentStatus, "tasks", "recompute", decision);
  assert.equal(statSync(join(fx.change, ".superspec", "superspec-state.json")).isFile(), true);
});

withFixture("dispatch recompute writes state", (fx) => {
  withRuntime({ load_context: () => [status(fx), fx.repo, fx.change, []] }, () => {
    const [decision] = guard.dispatch({ command: "recompute", change: "demo-change" });
    assert.equal(decision.allowed, true, JSON.stringify(decision));
    assert.equal(statSync(join(fx.change, ".superspec", "superspec-state.json")).isFile(), true);
  });
});

test("FIX-1 command surface accepts recompute rebuild-corrupt", () => {
  const args = guard.parse_argv(["recompute", "--change", "demo-change", "--rebuild-corrupt"]);
  assert.equal(args.command, "recompute");
  assert.equal(args.rebuild_corrupt, true);
});

withFixture("FIX-1 corrupt state blocks check commands and preserves the corrupt file", (fx) => {
  guard.ensure_sidecar_layout(fx.change);
  const statePath = join(fx.change, ".superspec", "superspec-state.json");
  writeText(statePath, "{corrupt json");
  withRuntime({ load_context: () => [status(fx), fx.repo, fx.change, []] }, () => {
    const [decision] = guard.dispatch({ command: "check-enter", change: "demo-change", gate: "explore_complete" });
    assert.equal(decision.allowed, false);
    assert.ok(codes(decision.block_reasons).includes("state_corrupt"), JSON.stringify(decision.block_reasons));
    assert.equal(readFileSync(statePath, "utf8"), "{corrupt json");
  });
});

withFixture("FIX-1 recompute without rebuild-corrupt blocks on corrupt state", (fx) => {
  guard.ensure_sidecar_layout(fx.change);
  const statePath = join(fx.change, ".superspec", "superspec-state.json");
  writeText(statePath, "{corrupt json");
  withRuntime({ load_context: () => [status(fx), fx.repo, fx.change, []] }, () => {
    const [decision] = guard.dispatch({ command: "recompute", change: "demo-change" });
    assert.equal(decision.allowed, false);
    assert.ok(codes(decision.block_reasons).includes("state_corrupt"), JSON.stringify(decision.block_reasons));
    assert.equal(readFileSync(statePath, "utf8"), "{corrupt json");
  });
});

withFixture("FIX-1 status reports state_corrupt for non-object state file", (fx) => {
  guard.ensure_sidecar_layout(fx.change);
  const statePath = join(fx.change, ".superspec", "superspec-state.json");
  writeText(statePath, "[1, 2]\n");
  withRuntime({ load_context: () => [status(fx), fx.repo, fx.change, []] }, () => {
    const [decision] = guard.dispatch({ command: "status", change: "demo-change" });
    assert.equal(decision.allowed, false);
    assert.ok(codes(decision.block_reasons).includes("state_corrupt"), JSON.stringify(decision.block_reasons));
    assert.equal(readFileSync(statePath, "utf8"), "[1, 2]\n");
  });
});

withFixture("FIX-1 recompute rebuild-corrupt rebuilds state and records ledger event", (fx) => {
  guard.ensure_sidecar_layout(fx.change);
  const statePath = join(fx.change, ".superspec", "superspec-state.json");
  writeText(statePath, "{corrupt json");
  withRuntime({ load_context: () => [status(fx), fx.repo, fx.change, []] }, () => {
    const [decision] = guard.dispatch({ command: "recompute", change: "demo-change", rebuild_corrupt: true });
    assert.equal(decision.allowed, true, JSON.stringify(decision));
    const state = readJson(statePath);
    assert.equal(state.change_id, "demo-change");
    const events = readFileSync(join(fx.change, ".superspec", "ledger.jsonl"), "utf8")
      .trim().split("\n").filter(Boolean).map((line) => JSON.parse(line));
    assert.ok(events.some((event) => event.kind === "state_corrupt_rebuilt"), JSON.stringify(events));
  });
});

withFixture("FIX-1 corrupt state blocks check-archive-ready without overwriting state", (fx) => {
  guard.ensure_sidecar_layout(fx.change);
  const statePath = join(fx.change, ".superspec", "superspec-state.json");
  writeText(statePath, "{corrupt json");
  withRuntime({ load_context: () => [status(fx), fx.repo, fx.change, []] }, () => {
    const [decision] = guard.dispatch({ command: "check-archive-ready", change: "demo-change" });
    assert.equal(decision.allowed, false);
    assert.ok(codes(decision.block_reasons).includes("state_corrupt"), JSON.stringify(decision.block_reasons));
    assert.equal(readFileSync(statePath, "utf8"), "{corrupt json");
  });
});

withFixture("FIX-1 recompute rebuild-corrupt on healthy state behaves like plain recompute", (fx) => {
  withRuntime({ load_context: () => [status(fx), fx.repo, fx.change, []] }, () => {
    const [first] = guard.dispatch({ command: "recompute", change: "demo-change" });
    assert.equal(first.allowed, true, JSON.stringify(first));
    const [second] = guard.dispatch({ command: "recompute", change: "demo-change", rebuild_corrupt: true });
    assert.equal(second.allowed, true, JSON.stringify(second));
    const events = readFileSync(join(fx.change, ".superspec", "ledger.jsonl"), "utf8")
      .trim().split("\n").filter(Boolean).map((line) => JSON.parse(line));
    assert.ok(!events.some((event) => event.kind === "state_corrupt_rebuilt"), JSON.stringify(events));
  });
});

withFixture("non-archive dispatch blocks when inputs change before state write", (fx) => {
  writeText(join(fx.change, "tasks.md"), "- [ ] TASK-001 Initial\n");
  let loadCount = 0;
  withRuntime({
    load_context: () => {
      loadCount += 1;
      if (loadCount === 2) writeText(join(fx.change, "tasks.md"), "- [ ] TASK-001 Mutated\n");
      return [status(fx), fx.repo, fx.change, []];
    },
  }, () => {
    const [decision] = guard.dispatch({ command: "recompute", change: "demo-change" });
    assert.equal(decision.allowed, false);
    assert.ok(codes(decision.block_reasons).includes("state_concurrent_update"));
    const state = readJson(join(fx.change, ".superspec", "superspec-state.json"));
    assert.equal(state.superspec.last_guard_decision, "block");
  });
});

withFixture("non-archive dispatch blocks when config changes before state write", (fx) => {
  let loadCount = 0;
  withRuntime({
    load_context: () => {
      loadCount += 1;
      if (loadCount === 2) writeText(join(fx.change, ".superspec", "config.yaml"), "unknown: value\n");
      return [status(fx), fx.repo, fx.change, []];
    },
  }, () => {
    const [decision] = guard.dispatch({ command: "recompute", change: "demo-change" });
    assert.equal(decision.allowed, false);
    assert.ok(codes(decision.block_reasons).includes("state_concurrent_update"));
    const state = readJson(join(fx.change, ".superspec", "superspec-state.json"));
    assert.ok(String(state.computed_from.change_config_fingerprint ?? "").startsWith("sha256:"));
    assert.equal(state.superspec.last_guard_decision, "block");
  });
});

withFixture("FIX-5 prepared state reuses decision-time fingerprints verbatim", (fx) => {
  writeText(join(fx.change, "tasks.md"), "- [ ] TASK-001 v1\n");
  const currentStatus = status(fx);
  const decisionFps = guard.compute_fingerprints(fx.change, currentStatus);
  writeText(join(fx.change, "tasks.md"), "- [ ] TASK-001 v2 mutated after decision\n");
  const decision = guard.allow("demo-change", "recompute");
  const prepared = guard.prepare_recomputed_state_write(
    "demo-change", fx.change, currentStatus, "tasks", "recompute", decision,
    { fingerprints: decisionFps },
  );
  assert.equal((prepared.state as JsonMap).computed_from.tasks_fingerprint, decisionFps.tasks_fingerprint);
});

withFixture("FIX-5 post-decision mutation is not absorbed into written state", (fx) => {
  writeText(join(fx.change, "tasks.md"), "- [ ] TASK-001 v1\n");
  const currentStatus = status(fx);
  const decision = guard.allow("demo-change", "recompute");
  const decisionFps = guard.compute_fingerprints(fx.change, currentStatus);
  // the audited window: file mutates after the decision but before prepare/write
  writeText(join(fx.change, "tasks.md"), "- [ ] TASK-001 mutated between decision and write\n");
  const prepared = guard.prepare_recomputed_state_write(
    "demo-change", fx.change, currentStatus, "tasks", "recompute", decision,
    { fingerprints: decisionFps },
  );
  guard.with_state_lock(fx.change, () => {
    guard.write_prepared_state_locked(fx.change, prepared);
  });
  const state = readJson(join(fx.change, ".superspec", "superspec-state.json"));
  assert.equal(state.computed_from.tasks_fingerprint, decisionFps.tasks_fingerprint);
  assert.notEqual(state.computed_from.tasks_fingerprint, guard.sha256_file(join(fx.change, "tasks.md")));
  assert.deepEqual(codes(guard.state_stale_reasons(fx.change, currentStatus)), ["state_fingerprint_stale"]);
});

withFixture("state fingerprint stale blocks after evidence change", (fx) => {
  const currentStatus = status(fx);
  const decision = guard.allow("demo-change", "recompute");
  guard.recompute_and_write_state("demo-change", fx.change, currentStatus, "tasks", "recompute", decision);
  writeText(join(fx.change, ".superspec", "evidence", "design", "EV-new.json"), JSON.stringify(passEvidence("design_complete")));
  const reasons = guard.state_stale_reasons(fx.change, currentStatus);
  assert.deepEqual(codes(reasons), ["state_fingerprint_stale"]);
});

withFixture("archive manifest matches archived sidecar", (fx) => {
  guard.ensure_sidecar_layout(fx.change);
  writeText(join(fx.change, ".superspec", "config.yaml"), "preset: full\n");
  writeText(join(fx.change, ".superspec", "superspec-state.json"), "{\"schema_version\":1}\n");
  const manifestPath = guard.write_archive_manifest("demo-change", fx.change);
  const archived = join(fx.repo, "openspec", "changes", "archive", "2026-06-08-demo-change");
  mkdirp(archived);
  for (const path of walkFiles(join(fx.change, ".superspec"))) {
    const dest = join(archived, relative(fx.change, path));
    mkdirp(dirname(dest));
    copyFileSync(path, dest);
  }
  const decision = guard.check_archived("demo-change", fx.repo);
  assert.equal(statSync(manifestPath).isFile(), true);
  assert.equal(decision.allowed, true, JSON.stringify(decision));
});

withFixture("check archived ignores suffix-only archive directory matches", (fx) => {
  const wrongArchived = join(fx.repo, "openspec", "changes", "archive", "2026-06-08-other-demo-change");
  writeText(join(wrongArchived, ".superspec", "artifacts", "archive-preservation.json"), `${JSON.stringify({
    schema_version: 1,
    change_id: "other-demo-change",
    kind: "superspec_archive_preservation",
    entries: [],
  }, null, 2)}\n`);

  const decision = guard.check_archived("demo-change", fx.repo);
  assert.equal(decision.allowed, false);
  assert.equal(decision.block_reasons[0].code, "archive_not_found");
});

withFixture("check archived ignores symlinked archive directory matches", (fx) => {
  const externalArchive = join(fx.tmp, "external-archive");
  writeText(join(externalArchive, ".superspec", "ledger.jsonl"), "");
  writeText(join(externalArchive, ".superspec", "superspec-state.json"), "{}\n");
  const manifest = {
    schema_version: 1,
    change_id: "demo-change",
    kind: "superspec_archive_preservation",
    entries: [
      { path: ".superspec/ledger.jsonl", sha256: guard.sha256_file(join(externalArchive, ".superspec", "ledger.jsonl")) },
      { path: ".superspec/superspec-state.json", sha256: guard.sha256_file(join(externalArchive, ".superspec", "superspec-state.json")) },
    ],
  };
  writeText(join(externalArchive, ".superspec", "artifacts", "archive-preservation.json"), `${JSON.stringify(manifest, null, 2)}\n`);
  mkdirp(join(fx.repo, "openspec", "changes", "archive"));
  symlinkSync(externalArchive, join(fx.repo, "openspec", "changes", "archive", "2026-06-08-demo-change"), "dir");

  const decision = guard.check_archived("demo-change", fx.repo);
  assert.equal(decision.allowed, false);
  assert.equal(decision.block_reasons[0].code, "archive_not_found");
});

withFixture("check archived blocks primary manifest change id mismatch", (fx) => {
  const archived = join(fx.repo, "openspec", "changes", "archive", "2026-06-08-demo-change");
  writeText(join(archived, ".superspec", "artifacts", "archive-preservation.json"), `${JSON.stringify({
    schema_version: 1,
    change_id: "other-change",
    kind: "superspec_archive_preservation",
    entries: [],
  }, null, 2)}\n`);

  const decision = guard.check_archived("demo-change", fx.repo);
  assert.equal(decision.allowed, false);
  assert.equal(decision.block_reasons[0].code, "archive_manifest_mismatch");
});

withFixture("check archived blocks empty primary manifest with matching change id", (fx) => {
  const archived = join(fx.repo, "openspec", "changes", "archive", "2026-06-08-demo-change");
  writeText(join(archived, ".superspec", "artifacts", "archive-preservation.json"), `${JSON.stringify({
    schema_version: 1,
    change_id: "demo-change",
    kind: "superspec_archive_preservation",
    entries: [],
  }, null, 2)}\n`);

  const decision = guard.check_archived("demo-change", fx.repo);
  assert.equal(decision.allowed, false);
  assert.equal(decision.block_reasons[0].code, "archive_manifest_mismatch");
});

withFixture("check archived blocks primary manifest entry path escape", (fx) => {
  const archived = join(fx.repo, "openspec", "changes", "archive", "2026-06-08-demo-change");
  const outside = join(fx.tmp, "outside-primary.txt");
  writeText(join(archived, ".superspec", "ledger.jsonl"), "");
  writeText(join(archived, ".superspec", "superspec-state.json"), "{}\n");
  writeText(outside, "outside\n");
  writeText(join(archived, ".superspec", "artifacts", "archive-preservation.json"), `${JSON.stringify({
    schema_version: 1,
    change_id: "demo-change",
    kind: "superspec_archive_preservation",
    entries: [
      { path: ".superspec/ledger.jsonl", sha256: guard.sha256_file(join(archived, ".superspec", "ledger.jsonl")) },
      { path: ".superspec/superspec-state.json", sha256: guard.sha256_file(join(archived, ".superspec", "superspec-state.json")) },
      { path: "../../../../outside-primary.txt", sha256: guard.sha256_file(outside) },
    ],
  }, null, 2)}\n`);

  const decision = guard.check_archived("demo-change", fx.repo);
  assert.equal(decision.allowed, false);
  assert.ok(codes(decision.block_reasons).includes("archive_manifest_mismatch"), JSON.stringify(decision));
});

withFixture("check archive ready dispatch manifest matches after state write", (fx) => {
  const currentStatus = status(fx);
  writeText(join(fx.change, ".superspec", "evidence", "invariants", "EV-invariant-review.json"), JSON.stringify(roleEvidence(fx, "invariants_reviewed", "critic")));
  const evidences = archiveReadyEvidences(fx);
  withRuntime({
    load_context: () => [currentStatus, fx.repo, fx.change, evidences],
    openspec_validate: () => [true, ""],
    dirty_worktree_reasons: () => [],
  }, () => {
    const [decision] = guard.dispatch({ command: "check-archive-ready", change: "demo-change" });
    assert.equal(decision.allowed, true, JSON.stringify(decision));
    const manifestPath = join(fx.change, decision.superspec_gate_summary.archive_manifest);
    const bundleManifest = join(fx.change, decision.superspec_gate_summary.archive_preservation_bundle);
    assert.equal(statSync(bundleManifest).isFile(), true);
    const manifest = readJson(manifestPath);
    const entries = Object.fromEntries(manifest.entries.map((entry: JsonMap) => [entry.path, entry.sha256]));
    assert.ok(".superspec/ledger.jsonl" in entries);
    assert.ok(".superspec/superspec-state.json" in entries);
    assert.ok(".superspec/artifacts/business-invariants.md" in entries);
    assert.ok(".superspec/artifacts/test-contract.md" in entries);
    assert.ok(".superspec/evidence/invariants/EV-invariant-review.json" in entries);
    for (const [rel, expected] of Object.entries(entries)) {
      assert.equal(guard.sha256_file(join(fx.change, rel)), expected, rel);
    }
  });
});

withFixture("concurrent check archive ready dispatches converge on coherent preservation artifacts", async (fx) => {
  const currentStatus = status(fx);
  writeText(join(fx.change, ".superspec", "evidence", "invariants", "EV-invariant-review.json"), JSON.stringify(roleEvidence(fx, "invariants_reviewed", "critic")));
  const evidences = archiveReadyEvidences(fx);
  const statusPath = join(fx.tmp, "status.json");
  const evidencesPath = join(fx.tmp, "evidences.json");
  const lockHeldMarkerPath = join(fx.tmp, "archive-ready-lock-held");
  const stateLockPath = join(fx.change, ".superspec", "superspec-state.lock");
  writeText(statusPath, `${JSON.stringify(currentStatus, null, 2)}\n`);
  writeText(evidencesPath, `${JSON.stringify(evidences, null, 2)}\n`);
  const childScript = `
import { readFileSync, writeFileSync } from "node:fs";

const delayMs = Number(process.env.SUPERSPEC_DELAY_MS ?? "0");
const sleep = (ms) => {
  if (ms <= 0) return;
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
};

const mod = await import(process.env.SUPERSPEC_GUARD_URL);
const status = JSON.parse(readFileSync(process.env.SUPERSPEC_STATUS_PATH, "utf8"));
const evidences = JSON.parse(readFileSync(process.env.SUPERSPEC_EVIDENCES_PATH, "utf8"));
const repoRoot = process.env.SUPERSPEC_REPO_ROOT;
const changeRoot = process.env.SUPERSPEC_CHANGE_ROOT;
const lockHeldMarkerPath = process.env.SUPERSPEC_LOCK_HELD_MARKER_PATH;
const begin = mod.runtime.begin_archive_preservation_bundle;
const startedAt = Date.now();

mod.runtime.load_context = () => [status, repoRoot, changeRoot, evidences];
mod.runtime.openspec_validate = () => [true, ""];
mod.runtime.dirty_worktree_reasons = () => [];
mod.runtime.review_diff_paths = () => ["tasks.md"];
mod.runtime.begin_archive_preservation_bundle = (...args) => {
  if (lockHeldMarkerPath) writeFileSync(lockHeldMarkerPath, "lock-held\\n");
  const txn = begin(...args);
  sleep(delayMs);
  return txn;
};

let retryCount = 0;
mod.runtime.on_state_retry = () => {
  retryCount += 1;
};
mod.runtime.max_state_write_retries = Number(process.env.SUPERSPEC_MAX_STATE_WRITE_RETRIES ?? "5");

const [decision] = mod.dispatch({ command: "check-archive-ready", change: "demo-change" });
process.stdout.write(JSON.stringify({ decision, elapsed_ms: Date.now() - startedAt, retry_count: retryCount }));
`;
  const baseEnv = {
    ...process.env,
    SUPERSPEC_GUARD_URL: GUARD_TS_URL,
    SUPERSPEC_STATUS_PATH: statusPath,
    SUPERSPEC_EVIDENCES_PATH: evidencesPath,
    SUPERSPEC_REPO_ROOT: fx.repo,
    SUPERSPEC_CHANGE_ROOT: fx.change,
  };
  const first = spawn(process.execPath, ["--input-type=module", "--eval", childScript], {
    cwd: fx.repo,
    env: {
      ...baseEnv,
      SUPERSPEC_DELAY_MS: "5000",
      SUPERSPEC_MAX_STATE_WRITE_RETRIES: "80",
      SUPERSPEC_LOCK_HELD_MARKER_PATH: lockHeldMarkerPath,
    },
  });
  await waitForCondition(() => existsSync(lockHeldMarkerPath) && existsSync(stateLockPath), 20000);
  const second = spawn(process.execPath, ["--input-type=module", "--eval", childScript], {
    cwd: fx.repo,
    env: { ...baseEnv, SUPERSPEC_DELAY_MS: "0", SUPERSPEC_MAX_STATE_WRITE_RETRIES: "80" },
  });
  const [firstResult, secondResult] = await Promise.all([waitForChild(first), waitForChild(second)]);
  for (const result of [firstResult, secondResult]) {
    assert.equal(result.code, 0, result.stderr);
    const payload = JSON.parse(result.stdout);
    assert.equal(payload.decision.allowed, true, result.stdout);
    assert.equal(payload.decision.gate, "archive_ready");
  }
  const secondPayload = JSON.parse(secondResult.stdout);
  assert.ok(secondPayload.retry_count >= 1, secondResult.stdout);
  const statePath = join(fx.change, ".superspec", "superspec-state.json");
  const ledgerPath = join(fx.change, ".superspec", "ledger.jsonl");
  const manifestPath = join(fx.change, ".superspec", "artifacts", "archive-preservation.json");
  const bundleManifestPath = join(fx.change, "superspec-preservation", "manifest.json");
  assert.equal(statSync(statePath).isFile(), true);
  assert.equal(statSync(ledgerPath).isFile(), true);
  assert.equal(statSync(manifestPath).isFile(), true);
  assert.equal(statSync(bundleManifestPath).isFile(), true);
  assert.equal(existsSync(join(fx.change, ".superspec", "superspec-state.lock")), false);
  assert.equal(existsSync(join(fx.change, ".superspec", "superspec-state.tmp")), false);
  assert.equal(walkFiles(join(fx.change, ".superspec-staging")).length, 0);
  const ledgerEvents = readFileSync(ledgerPath, "utf8")
    .trim()
    .split(/\r?\n/)
    .filter(Boolean)
    .map((line) => JSON.parse(line));
  assert.equal(ledgerEvents.length, 2);
  assert.deepEqual(ledgerEvents.map((item: JsonMap) => item.decision), ["allow", "allow"]);
  const state = readJson(statePath);
  assert.equal(state.superspec.last_guard_decision, "allow");
  assert.equal(state.superspec.active_gate, "archive_ready");
  const manifest = readJson(manifestPath);
  const bundleManifest = readJson(bundleManifestPath);
  const manifestEntries = Object.fromEntries(manifest.entries.map((entry: JsonMap) => [entry.path, entry.sha256]));
  const bundleEntries = Object.fromEntries(bundleManifest.entries.map((entry: JsonMap) => [entry.path, entry.sha256]));
  assert.deepEqual(bundleEntries, manifestEntries);
  for (const [rel, expected] of Object.entries(manifestEntries)) {
    assert.equal(guard.sha256_file(join(fx.change, rel)), expected, rel);
    assert.equal(guard.sha256_file(join(fx.change, "superspec-preservation", "files", rel)), expected, `bundle:${rel}`);
  }
});

withFixture("archive ready blocks when preservation bundle cannot be written", (fx) => {
  const currentStatus = status(fx);
  const guidance = [
    ...reviewGuidanceEvidences(fx),
    reviewEvidence(fx, "critic"),
  ];
  const evidences = [
    ...prepareProposeComplete(fx, { checked: true }),
    greenEvidence(),
    ...guidance,
    mainAdjudication(fx, guidance),
    verifyEvidence(fx, "verifier"),
    verifyEvidence(fx, "critic"),
    finalTestEvidence(fx),
    passEvidence("archive_ready", "human_confirmation"),
  ];
  withRuntime({
    load_context: () => [currentStatus, fx.repo, fx.change, evidences],
    openspec_validate: () => [true, ""],
    dirty_worktree_reasons: () => [],
    begin_archive_preservation_bundle: () => {
      throw new Error("no space");
    },
  }, () => {
    const [decision] = guard.dispatch({ command: "check-archive-ready", change: "demo-change" });
    assert.equal(decision.allowed, false);
    assert.ok(codes(decision.block_reasons).includes("missing_archive_preservation_plan"));
    assert.ok(decision.next_allowed_actions.length > 0);
    assert.ok(decision.next_allowed_actions.some((item: string) => item.includes("rerun check-archive-ready")));
    const state = readJson(join(fx.change, ".superspec", "superspec-state.json"));
    assert.equal(state.superspec.last_guard_decision, "block");
  });
});

withFixture("prepared state write preserves concurrent appended ledger events", (fx) => {
  const currentStatus = status(fx);
  const decision = guard.allow("demo-change", "recompute");
  const prepared = guard.prepare_recomputed_state_write("demo-change", fx.change, currentStatus, "tasks", "recompute", decision);
  guard.append_ledger(fx.change, { change_id: "demo-change", kind: "manual_event", gate: "manual", decision: "note" });
  guard.write_prepared_state_locked(fx.change, prepared);
  const events = readFileSync(join(fx.change, ".superspec", "ledger.jsonl"), "utf8")
    .trim()
    .split(/\r?\n/)
    .filter(Boolean)
    .map((line) => JSON.parse(line));
  assert.deepEqual(events.map((item: JsonMap) => item.kind), ["manual_event", "guard_decision"]);
});

withFixture("prepared state write removes tmp symlinks instead of following them", (fx) => {
  const currentStatus = status(fx);
  const decision = guard.allow("demo-change", "recompute");
  const prepared = guard.prepare_recomputed_state_write("demo-change", fx.change, currentStatus, "tasks", "recompute", decision);
  const base = join(fx.change, ".superspec");
  mkdirp(base);
  const outsideState = join(fx.tmp, "outside-state.txt");
  const outsideLedger = join(fx.tmp, "outside-ledger.txt");
  writeText(outsideState, "outside state\n");
  writeText(outsideLedger, "outside ledger\n");
  symlinkSync(outsideState, join(base, "superspec-state.tmp"));
  symlinkSync(outsideLedger, join(base, "ledger.tmp"));
  guard.write_prepared_state_locked(fx.change, prepared);
  assert.equal(readFileSync(outsideState, "utf8"), "outside state\n");
  assert.equal(readFileSync(outsideLedger, "utf8"), "outside ledger\n");
  assert.equal(existsSync(join(base, "superspec-state.tmp")), false);
  assert.equal(existsSync(join(base, "ledger.tmp")), false);
  assert.equal(lstatSync(join(base, "superspec-state.json")).isSymbolicLink(), false);
  assert.equal(lstatSync(join(base, "ledger.jsonl")).isSymbolicLink(), false);
});

withFixture("prepared state write removes tmp hard links instead of truncating targets", (fx) => {
  const currentStatus = status(fx);
  const decision = guard.allow("demo-change", "recompute");
  const prepared = guard.prepare_recomputed_state_write("demo-change", fx.change, currentStatus, "tasks", "recompute", decision);
  const base = join(fx.change, ".superspec");
  mkdirp(base);
  const outsideState = join(fx.tmp, "outside-hard-state.txt");
  const outsideLedger = join(fx.tmp, "outside-hard-ledger.txt");
  writeText(outsideState, "outside hard state\n");
  writeText(outsideLedger, "outside hard ledger\n");
  linkSync(outsideState, join(base, "superspec-state.tmp"));
  linkSync(outsideLedger, join(base, "ledger.tmp"));
  guard.write_prepared_state_locked(fx.change, prepared);
  assert.equal(readFileSync(outsideState, "utf8"), "outside hard state\n");
  assert.equal(readFileSync(outsideLedger, "utf8"), "outside hard ledger\n");
  assert.equal(existsSync(join(base, "superspec-state.tmp")), false);
  assert.equal(existsSync(join(base, "ledger.tmp")), false);
});

withFixture("archive preservation transaction rollback restores previous manifest and bundle", (fx) => {
  guard.write_archive_preservation_bundle("demo-change", fx.change);
  const manifestPath = join(fx.change, ".superspec", "artifacts", "archive-preservation.json");
  const bundlePath = join(fx.change, "superspec-preservation", "manifest.json");
  const oldManifest = readFileSync(manifestPath, "utf8");
  const oldBundle = readFileSync(bundlePath, "utf8");
  const txn = guard.begin_archive_preservation_bundle("demo-change", fx.change, {
    file_overrides: {
      ".superspec/ledger.jsonl": "{\"decision\":\"allow\"}\n",
      ".superspec/superspec-state.json": "{\"schema_version\":1}\n",
    },
  });
  assert.notEqual(readFileSync(manifestPath, "utf8"), oldManifest);
  assert.notEqual(readFileSync(bundlePath, "utf8"), oldBundle);
  txn.rollback();
  assert.equal(readFileSync(manifestPath, "utf8"), oldManifest);
  assert.equal(readFileSync(bundlePath, "utf8"), oldBundle);
});

withFixture("archive preservation first-run rollback removes promoted manifest and bundle", (fx) => {
  const manifestPath = join(fx.change, ".superspec", "artifacts", "archive-preservation.json");
  const bundleDir = join(fx.change, "superspec-preservation");
  const txn = guard.begin_archive_preservation_bundle("demo-change", fx.change, {
    file_overrides: {
      ".superspec/ledger.jsonl": "{\"decision\":\"allow\"}\n",
      ".superspec/superspec-state.json": "{\"schema_version\":1}\n",
    },
  });
  assert.equal(statSync(manifestPath).isFile(), true);
  assert.equal(statSync(join(bundleDir, "manifest.json")).isFile(), true);
  txn.rollback();
  assert.equal(existsSync(manifestPath), false);
  assert.equal(existsSync(bundleDir), false);
  assert.equal(walkFiles(join(fx.change, ".superspec-staging")).length, 0);
});

withFixture("archive preservation promote failure after bundle rename removes promoted artifacts", (fx) => {
  const manifestPath = join(fx.change, ".superspec", "artifacts", "archive-preservation.json");
  const bundleDir = join(fx.change, "superspec-preservation");
  assert.throws(() => withRuntime({
    after_archive_bundle_promote: () => {
      assert.equal(existsSync(bundleDir), true);
      assert.equal(existsSync(manifestPath), false);
      throw new Error("fail after bundle promote");
    },
  }, () => guard.begin_archive_preservation_bundle("demo-change", fx.change, {
    file_overrides: {
      ".superspec/ledger.jsonl": "{\"decision\":\"allow\"}\n",
      ".superspec/superspec-state.json": "{\"schema_version\":1}\n",
    },
  })), /fail after bundle promote/);
  assert.equal(existsSync(manifestPath), false);
  assert.equal(existsSync(bundleDir), false);
  assert.equal(walkFiles(join(fx.change, ".superspec-staging")).length, 0);
});

withFixture("archive ready blocks and restores state snapshot when state write CAS fails", (fx) => {
  const currentStatus = status(fx);
  const guidance = [
    ...reviewGuidanceEvidences(fx),
    reviewEvidence(fx, "critic"),
  ];
  const evidences = [
    ...prepareProposeComplete(fx, { checked: true }),
    greenEvidence(),
    ...guidance,
    mainAdjudication(fx, guidance),
    verifyEvidence(fx, "verifier"),
    verifyEvidence(fx, "critic"),
    finalTestEvidence(fx),
    passEvidence("archive_ready", "human_confirmation"),
  ];
  withRuntime({
    load_context: () => [currentStatus, fx.repo, fx.change, evidences],
    openspec_validate: () => [true, ""],
    dirty_worktree_reasons: () => [],
  }, () => {
    const seedDecision = guard.allow("demo-change", "recompute");
    guard.recompute_and_write_state("demo-change", fx.change, currentStatus, "review", "review_complete", seedDecision);
    guard.write_archive_preservation_bundle("demo-change", fx.change);
    const manifestPath = join(fx.change, ".superspec", "artifacts", "archive-preservation.json");
    const bundlePath = join(fx.change, "superspec-preservation", "manifest.json");
    const statePath = join(fx.change, ".superspec", "superspec-state.json");
    const ledgerPath = join(fx.change, ".superspec", "ledger.jsonl");
    const oldManifest = readFileSync(manifestPath, "utf8");
    const oldBundle = readFileSync(bundlePath, "utf8");
    const oldStateText = readFileSync(statePath, "utf8");
    const oldLedgerText = readFileSync(ledgerPath, "utf8");
    const restoredSnapshots: Array<{ state_text: string | null; ledger_text: string }> = [];
    const oldLedgerEvents = oldLedgerText
      .trim()
      .split(/\r?\n/)
      .filter(Boolean)
      .map((line) => JSON.parse(line));
    const realBegin = guard.begin_archive_preservation_bundle;
    const [decision] = withRuntime({
      on_state_snapshot_restored: (payload: { state_text: string | null; ledger_text: string }) => {
        restoredSnapshots.push({ state_text: payload.state_text, ledger_text: payload.ledger_text });
      },
      begin_archive_preservation_bundle: (change: string, changeRoot: string, opts: JsonMap) => {
        const txn = realBegin(change, changeRoot, opts);
        writeText(statePath, `${JSON.stringify({
          schema_version: 1,
          change_id: change,
          computed_from: { openspec_status_fingerprint: "sha256:other" },
        }, null, 2)}\n`);
        return txn;
      },
    }, () => guard.dispatch({ command: "check-archive-ready", change: "demo-change" }));
    assert.equal(decision.allowed, false);
    assert.ok(codes(decision.block_reasons).includes("missing_archive_preservation_plan"));
    assert.equal(readFileSync(manifestPath, "utf8"), oldManifest);
    assert.equal(readFileSync(bundlePath, "utf8"), oldBundle);
    assert.equal(restoredSnapshots.length, 1);
    assert.equal(restoredSnapshots[0].state_text, oldStateText);
    assert.equal(restoredSnapshots[0].ledger_text, oldLedgerText);
    assert.equal(statSync(manifestPath).isFile(), true);
    assert.equal(statSync(bundlePath).isFile(), true);
    assert.equal(existsSync(join(fx.change, ".superspec", "superspec-state.tmp")), false);
    const ledgerEvents = readFileSync(ledgerPath, "utf8")
      .trim()
      .split(/\r?\n/)
      .filter(Boolean)
      .map((line) => JSON.parse(line));
    assert.equal(ledgerEvents.length, oldLedgerEvents.length + 1);
    assert.deepEqual(ledgerEvents.slice(0, oldLedgerEvents.length), oldLedgerEvents);
    assert.equal(ledgerEvents.at(-1)?.decision, "block");
    const state = readJson(statePath);
    assert.equal(state.superspec.last_guard_decision, "block");
  });
});

withFixture("archive ready state write failure without previous preservation removes promoted artifacts", (fx) => {
  const currentStatus = status(fx);
  const guidance = [
    ...reviewGuidanceEvidences(fx),
    reviewEvidence(fx, "critic"),
  ];
  const evidences = [
    ...prepareProposeComplete(fx, { checked: true }),
    greenEvidence(),
    ...guidance,
    mainAdjudication(fx, guidance),
    verifyEvidence(fx, "verifier"),
    verifyEvidence(fx, "critic"),
    finalTestEvidence(fx),
    passEvidence("archive_ready", "human_confirmation"),
  ];
  withRuntime({
    load_context: () => [currentStatus, fx.repo, fx.change, evidences],
    openspec_validate: () => [true, ""],
    dirty_worktree_reasons: () => [],
  }, () => {
    const manifestPath = join(fx.change, ".superspec", "artifacts", "archive-preservation.json");
    const bundleDir = join(fx.change, "superspec-preservation");
    const statePath = join(fx.change, ".superspec", "superspec-state.json");
    const realBegin = guard.begin_archive_preservation_bundle;
    const [decision] = withRuntime({
      begin_archive_preservation_bundle: (change: string, changeRoot: string, opts: JsonMap) => {
        const txn = realBegin(change, changeRoot, opts);
        assert.equal(statSync(manifestPath).isFile(), true);
        assert.equal(statSync(join(bundleDir, "manifest.json")).isFile(), true);
        writeText(statePath, `${JSON.stringify({
          schema_version: 1,
          change_id: change,
          computed_from: { openspec_status_fingerprint: "sha256:other" },
        }, null, 2)}\n`);
        return txn;
      },
    }, () => guard.dispatch({ command: "check-archive-ready", change: "demo-change" }));
    assert.equal(decision.allowed, false);
    assert.ok(codes(decision.block_reasons).includes("missing_archive_preservation_plan"));
    assert.equal(existsSync(manifestPath), false);
    assert.equal(existsSync(bundleDir), false);
    const state = readJson(statePath);
    assert.equal(state.superspec.last_guard_decision, "block");
  });
});

withFixture("check archived blocks missing manifest", (fx) => {
  mkdirp(join(fx.repo, "openspec", "changes", "archive", "2026-06-08-demo-change", ".superspec"));
  const decision = guard.check_archived("demo-change", fx.repo);
  assert.equal(decision.allowed, false);
  assert.equal(decision.block_reasons[0].code, "superspec_not_preserved");
});

withFixture("check archived blocks fallback manifest change id mismatch", (fx) => {
  const archived = join(fx.repo, "openspec", "changes", "archive", "2026-06-08-demo-change");
  writeText(join(archived, "superspec-preservation", "manifest.json"), `${JSON.stringify({
    schema_version: 1,
    change_id: "other-change",
    kind: "superspec_archive_preservation_bundle",
    files_root: "files",
    entries: [],
  }, null, 2)}\n`);

  const decision = guard.check_archived("demo-change", fx.repo);
  assert.equal(decision.allowed, false);
  assert.equal(decision.block_reasons[0].code, "archive_manifest_mismatch");
});

withFixture("check archived blocks empty fallback manifest with matching change id", (fx) => {
  const archived = join(fx.repo, "openspec", "changes", "archive", "2026-06-08-demo-change");
  writeText(join(archived, "superspec-preservation", "manifest.json"), `${JSON.stringify({
    schema_version: 1,
    change_id: "demo-change",
    kind: "superspec_archive_preservation_bundle",
    files_root: "files",
    entries: [],
  }, null, 2)}\n`);

  const decision = guard.check_archived("demo-change", fx.repo);
  assert.equal(decision.allowed, false);
  assert.equal(decision.block_reasons[0].code, "archive_manifest_mismatch");
});

withFixture("check archived blocks fallback files root escape", (fx) => {
  const archived = join(fx.repo, "openspec", "changes", "archive", "2026-06-08-demo-change");
  writeText(join(archived, "superspec-preservation", "manifest.json"), `${JSON.stringify({
    schema_version: 1,
    change_id: "demo-change",
    kind: "superspec_archive_preservation_bundle",
    files_root: "../outside",
    entries: [
      { path: ".superspec/ledger.jsonl", sha256: "sha256:missing" },
      { path: ".superspec/superspec-state.json", sha256: "sha256:missing" },
    ],
  }, null, 2)}\n`);

  const decision = guard.check_archived("demo-change", fx.repo);
  assert.equal(decision.allowed, false);
  assert.equal(decision.block_reasons[0].code, "archive_manifest_mismatch");
});

withFixture("check archived blocks fallback manifest entry path escape", (fx) => {
  const archived = join(fx.repo, "openspec", "changes", "archive", "2026-06-08-demo-change");
  const filesRoot = join(archived, "superspec-preservation", "files");
  const outside = join(fx.tmp, "outside-fallback.txt");
  writeText(join(filesRoot, ".superspec", "ledger.jsonl"), "");
  writeText(join(filesRoot, ".superspec", "superspec-state.json"), "{}\n");
  writeText(outside, "outside\n");
  writeText(join(archived, "superspec-preservation", "manifest.json"), `${JSON.stringify({
    schema_version: 1,
    change_id: "demo-change",
    kind: "superspec_archive_preservation_bundle",
    files_root: "files",
    entries: [
      { path: ".superspec/ledger.jsonl", sha256: guard.sha256_file(join(filesRoot, ".superspec", "ledger.jsonl")) },
      { path: ".superspec/superspec-state.json", sha256: guard.sha256_file(join(filesRoot, ".superspec", "superspec-state.json")) },
      { path: "../../../../outside-fallback.txt", sha256: guard.sha256_file(outside) },
    ],
  }, null, 2)}\n`);

  const decision = guard.check_archived("demo-change", fx.repo);
  assert.equal(decision.allowed, false);
  assert.ok(codes(decision.block_reasons).includes("archive_manifest_mismatch"), JSON.stringify(decision));
});

withFixture("check archived allows preservation bundle when sidecar missing", (fx) => {
  guard.ensure_sidecar_layout(fx.change);
  writeText(join(fx.change, ".superspec", "config.yaml"), "preset: full\n");
  writeText(join(fx.change, ".superspec", "superspec-state.json"), "{\"schema_version\":1}\n");
  guard.write_archive_preservation_bundle("demo-change", fx.change);
  const archived = join(fx.repo, "openspec", "changes", "archive", "2026-06-08-demo-change");
  mkdirp(archived);
  const srcBundle = join(fx.change, "superspec-preservation");
  const dstBundle = join(archived, "superspec-preservation");
  for (const path of walkFiles(srcBundle)) {
    const dest = join(dstBundle, relative(srcBundle, path));
    mkdirp(dirname(dest));
    copyFileSync(path, dest);
  }
  const decision = guard.check_archived("demo-change", fx.repo);
  assert.equal(decision.allowed, true, JSON.stringify(decision));
  assert.equal(decision.superspec_gate_summary.fallback_manifest, "superspec-preservation/manifest.json");
});

test("hotfix forced upgrade requires human confirmation", () => {
  const reasons = guard.preset_upgrade_reasons({ preset: "hotfix" }, ["a.py", "b.py", "c.py"], false);
  assert.deepEqual(codes(reasons), ["preset_upgrade_requires_human_confirmation"]);
});

test("tweak forced upgrade allows human confirmation", () => {
  const reasons = guard.preset_upgrade_reasons({ preset: "tweak" }, ["a.py", "b.py", "c.py", "d.py", "e.py"], true);
  assert.deepEqual(reasons, []);
});

withFixture("dispatch blocks hotfix preset upgrade without confirmation", (fx) => {
  writeText(join(fx.change, ".superspec", "config.yaml"), "preset: hotfix\n");
  withRuntime({
    load_context: () => [status(fx), fx.repo, fx.change, []],
    dirty_worktree_paths: () => ["a.py", "b.py", "c.py"],
  }, () => {
    const [decision] = guard.dispatch({ command: "check-init", change: "demo-change" });
    assert.equal(decision.allowed, false);
    assert.ok(codes(decision.block_reasons).includes("preset_upgrade_requires_human_confirmation"));
    assert.equal(readJson(join(fx.change, ".superspec", "superspec-state.json")).superspec.preset_upgrade_required, true);
  });
});

withFixture("dispatch persists confirmed preset upgrade requirement", (fx) => {
  writeText(join(fx.change, ".superspec", "config.yaml"), "preset: hotfix\n");
  const evidences = [passEvidence("preset_upgrade", "human_confirmation")];
  withRuntime({
    load_context: () => [status(fx), fx.repo, fx.change, evidences],
    dirty_worktree_paths: () => ["a.py", "b.py", "c.py"],
  }, () => {
    const [decision] = guard.dispatch({ command: "check-init", change: "demo-change" });
    assert.equal(decision.allowed, true, JSON.stringify(decision));
    const state = readJson(join(fx.change, ".superspec", "superspec-state.json"));
    assert.equal(state.superspec.preset, "hotfix");
    assert.equal(state.superspec.preset_upgrade_required, true);
  });
});

withFixture("legacy irsflow fixture is normalized as superspec test input only", (fx) => {
  const sourceChange = join(GUARD_ROOT, "tests", "fixtures", "legacy-irsflow-change");
  importLegacyIrsflowFixture(sourceChange, fx.change);
  const state = readJson(join(fx.change, ".superspec", "superspec-state.json"));
  const review = readJson(join(fx.change, ".superspec", "evidence", "reviews", "EV-review-code-reviewer-20260608.json"));
  assert.ok("superspec" in state);
  assert.equal("irsflow" in state, false);
  assert.equal(review.output_ref.startsWith(".superspec/"), true);
  assert.equal(review.target_refs.some((item: JsonMap) => String(item.path).includes(".superspec/")), true);
  assert.equal(review.source_anchors.some((item: string) => item.includes(".irsflow/")), true);
});

test("no v1 hook or custom schema artifacts exist", () => {
  assert.equal(existsSync(join(REPO_ROOT, ".codex", "hooks.json")), false);
  assert.equal(existsSync(join(REPO_ROOT, "openspec", "schemas", "superspec")), false);
});

test("status output includes observability fields", () => {
  const decision = guard.allow("demo-change", "status");
  assert.ok("decision" in decision);
  assert.ok("block_reasons" in decision);
  assert.ok("next_allowed_actions" in decision);
  assert.ok("trust_warnings" in decision);
});

// ─────────────────────────────────────────────────────────────────────────────
// DISC (disclosure design Phase 1): explore_complete review disclosure fixed point.
// Material findings raised by role reviews must reach the user via main_review_digest
// + user_review_decision instead of being silently consumed by the main thread.
// Legacy evidence without review_round_id/findings stays grandfathered (B6).
// ─────────────────────────────────────────────────────────────────────────────

const EXPLORE_ONLY_STATUS = { proposal: "blocked", specs: "blocked", design: "blocked", tasks: "blocked" };
const DISCOVERY_REL = ".superspec/artifacts/discovery.md";

function writeDiscovery(fx: Fixture, text = "discovery facts v1\n"): void {
  writeText(join(fx.change, ".superspec", "artifacts", "discovery.md"), text);
}

function discoveryBlob(fx: Fixture): string {
  return guard.file_blob_sha(join(fx.change, ".superspec", "artifacts", "discovery.md"));
}

function exploreCheck(fx: Fixture, evidences: JsonMap[]): JsonMap {
  return guard.check_superspec_gate("demo-change", status(fx, EXPLORE_ONLY_STATUS), fx.change, evidences, "explore_complete");
}

function exploreConfirmedEvidences(fx: Fixture): JsonMap[] {
  return [
    roleEvidence(fx, "explore_complete", "critic"),
    passEvidence("explore_complete", "human_confirmation"),
  ];
}

function discSchemaCodes(fx: Fixture, evidences: JsonMap[]): string[] {
  return codes(guard.evidence_schema_guard("demo-change", fx.change, fx.repo, evidences));
}

function exploreFinding(round = 1, overrides: JsonMap = {}): JsonMap {
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

function exploreRoundReview(fx: Fixture, round: number, findings: JsonMap[], overrides: JsonMap = {}): JsonMap {
  return roleEvidence(fx, "explore_complete", "critic", {
    evidence_id: `EV-explore-r${round}-critic`,
    review_round_id: `explore_complete-r${round}`,
    output_ref: `.superspec/reports/explore-r${round}-critic.md`,
    findings,
    ...overrides,
  });
}

function exploreRoundPrompt(fx: Fixture, round: number, priorEvidences: JsonMap[]): string {
  const rel = `.superspec/reports/explore-r${round}-critic-prompt.md`;
  const ledger = guard.render_finding_ledger(
    "explore_complete",
    guard.build_finding_ledger("explore_complete", priorEvidences, round),
  );
  writeText(join(fx.change, rel), `critic prompt for explore round ${round}\n\n${ledger}\n`);
  return rel;
}

function exploreDigest(fx: Fixture, round: number, dispositions: JsonMap[], overrides: JsonMap = {}): JsonMap {
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

function dispositionOf(finding: JsonMap, overrides: JsonMap = {}): JsonMap {
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

function userDecision(fx: Fixture, finding: JsonMap, overrides: JsonMap = {}): JsonMap {
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

function standingAuth(overrides: JsonMap = {}): JsonMap {
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

function supersedeMarker(targetId: string): JsonMap {
  return passEvidence("explore_complete", "superseded", {
    evidence_id: `EV-supersede-${targetId}`,
    status: "superseded",
    supersedes: targetId,
  });
}

withFixture("DISC main_review_digest schema is fail-closed", (fx) => {
  writeDiscovery(fx);
  const finding = exploreFinding();
  const good = exploreDigest(fx, 1, [dispositionOf(finding)], { status: "blocked" });
  assert.ok(!discSchemaCodes(fx, [good]).includes("review_digest_invalid"), JSON.stringify(discSchemaCodes(fx, [good])));
  const cases: JsonMap[] = [
    exploreDigest(fx, 1, [], { review_round_id: undefined }),
    exploreDigest(fx, 1, [], { review_round_id: "round-one" }),
    exploreDigest(fx, 1, [], { created_by: "test" }),
    exploreDigest(fx, 1, [], { target_refs: [] }),
    exploreDigest(fx, 1, [], { source_review_evidence_refs: [] }),
    exploreDigest(fx, 1, [], { finding_dispositions: "none" }),
    // review_complete must use main_adjudication as its disclosure carrier (design §8).
    exploreDigest(fx, 1, [], { gate: "review_complete" }),
    // disposition entry problems
    exploreDigest(fx, 1, [dispositionOf(finding, { disposition: "ignored" })]),
    exploreDigest(fx, 1, [dispositionOf(finding, { disposition: "fixed", rationale: "" })]),
    exploreDigest(fx, 1, [dispositionOf(finding, { disposition: "fixed", route: undefined })]),
    exploreDigest(fx, 1, [dispositionOf(finding, { disposition: "fixed", decision_scope_key: "" })]),
    // per-disposition proof shape
    exploreDigest(fx, 1, [dispositionOf(finding, { disposition: "fixed" })]),
    exploreDigest(fx, 1, [dispositionOf(finding, { disposition: "false_positive" })]),
    exploreDigest(fx, 1, [dispositionOf(finding, { disposition: "user_decided" })]),
    // needs_user_decision on a status:"pass" digest is a contradiction
    exploreDigest(fx, 1, [dispositionOf(finding)], { status: "pass" }),
  ];
  for (const [idx, ev] of cases.entries()) {
    assert.ok(discSchemaCodes(fx, [ev]).includes("review_digest_invalid"), `case ${idx}: ${JSON.stringify(discSchemaCodes(fx, [ev]))}`);
  }
});

withFixture("DISC user_review_decision schema is fail-closed", (fx) => {
  writeDiscovery(fx);
  const finding = exploreFinding();
  const good = userDecision(fx, finding);
  assert.ok(!discSchemaCodes(fx, [good]).includes("user_decision_invalid"), JSON.stringify(discSchemaCodes(fx, [good])));
  const goodD = userDecision(fx, finding, {
    decision: "option_d_custom",
    user_text: "只读 ScheduleActualServiceImpl 做行为锚点，不修改共享服务。",
    structured_decision: {
      scope: ["VacationController"],
      non_goals: ["shared service"],
      acceptance_impact: [],
      test_impact: [],
      requires_artifact_update: true,
      requires_rereview: true,
    },
  });
  assert.ok(!discSchemaCodes(fx, [goodD]).includes("user_decision_invalid"), JSON.stringify(discSchemaCodes(fx, [goodD])));
  const cases: JsonMap[] = [
    userDecision(fx, finding, { created_by: "main-thread" }),
    userDecision(fx, finding, { decision: "option_z" }),
    userDecision(fx, finding, { finding_uids: [] }),
    userDecision(fx, finding, { decision_scope_key: "" }),
    userDecision(fx, finding, { confirmed_refs: [] }),
    userDecision(fx, finding, { decision: "option_d_custom" }),
    userDecision(fx, finding, {
      decision: "option_d_custom",
      user_text: "ok",
      structured_decision: { scope: [], non_goals: [], acceptance_impact: [], test_impact: [], requires_artifact_update: "yes", requires_rereview: true },
    }),
    userDecision(fx, finding, {
      decision: "option_d_custom",
      user_text: "ok",
      structured_decision: { scope: [], requires_artifact_update: false, requires_rereview: false },
    }),
  ];
  for (const [idx, ev] of cases.entries()) {
    assert.ok(discSchemaCodes(fx, [ev]).includes("user_decision_invalid"), `case ${idx}: ${JSON.stringify(discSchemaCodes(fx, [ev]))}`);
  }
});

withFixture("DISC review_standing_authorization schema is fail-closed", (fx) => {
  writeDiscovery(fx);
  assert.ok(!discSchemaCodes(fx, [standingAuth()]).includes("standing_authorization_invalid"));
  const cases: JsonMap[] = [
    standingAuth({ created_by: "main-thread" }),
    standingAuth({ confirmation_text: "" }),
    standingAuth({ valid_gates: [] }),
    standingAuth({ allowed_categories: ["scope"], excluded_categories: ["scope"] }),
    standingAuth({ allowed_categories: ["vibes"] }),
  ];
  for (const [idx, ev] of cases.entries()) {
    assert.ok(discSchemaCodes(fx, [ev]).includes("standing_authorization_invalid"), `case ${idx}: ${JSON.stringify(discSchemaCodes(fx, [ev]))}`);
  }
});

withFixture("DISC findings on role review evidence are schema-checked", (fx) => {
  writeDiscovery(fx);
  const good = exploreRoundReview(fx, 1, [exploreFinding()]);
  assert.ok(!discSchemaCodes(fx, [good]).includes("review_finding_invalid"), JSON.stringify(discSchemaCodes(fx, [good])));
  const cases: JsonMap[] = [
    exploreRoundReview(fx, 1, [exploreFinding(1, { finding_type: "nitpick" })]),
    exploreRoundReview(fx, 1, [exploreFinding(1, { category: "vibes" })]),
    exploreRoundReview(fx, 1, [exploreFinding(1, { material_categories: ["scope"], decision_scope_key: "" })]),
    exploreRoundReview(fx, 1, [exploreFinding(1, { finding_uid: "explore_complete:EV-other:EXP-SCOPE-001" })]),
    exploreRoundReview(fx, 1, [exploreFinding(1, { summary: "" })]),
    // findings without a parseable same-gate round id break the round chain
    exploreRoundReview(fx, 1, [exploreFinding()], { review_round_id: undefined }),
  ];
  for (const [idx, ev] of cases.entries()) {
    assert.ok(discSchemaCodes(fx, [ev]).includes("review_finding_invalid"), `case ${idx}: ${JSON.stringify(discSchemaCodes(fx, [ev]))}`);
  }
});

withFixture("DISC B6 legacy explore evidence without rounds stays grandfathered", (fx) => {
  writeDiscovery(fx);
  const decision = exploreCheck(fx, exploreConfirmedEvidences(fx));
  assert.equal(decision.allowed, true, JSON.stringify(decision));
});

withFixture("DISC material blocker without digest blocks explore", (fx) => {
  writeDiscovery(fx);
  const decision = exploreCheck(fx, [exploreRoundReview(fx, 1, [exploreFinding()])]);
  assert.equal(decision.allowed, false);
  const reasonCodes = codes(decision.block_reasons);
  assert.ok(reasonCodes.includes("missing_review_digest"), JSON.stringify(reasonCodes));
  assert.ok(reasonCodes.includes("finding_unresolved"), JSON.stringify(reasonCodes));
});

withFixture("DISC needs_user_decision keeps the gate blocked until the user decides", (fx) => {
  writeDiscovery(fx);
  const finding = exploreFinding();
  const decision = exploreCheck(fx, [
    exploreRoundReview(fx, 1, [finding]),
    exploreDigest(fx, 1, [dispositionOf(finding)], { status: "blocked" }),
  ]);
  assert.equal(decision.allowed, false);
  assert.ok(codes(decision.block_reasons).includes("needs_user_decision_pending"), JSON.stringify(decision.block_reasons));
});

withFixture("DISC digest must cover every finding of its round", (fx) => {
  writeDiscovery(fx);
  const finding = exploreFinding();
  const decision = exploreCheck(fx, [
    exploreRoundReview(fx, 1, [finding]),
    exploreDigest(fx, 1, []),
  ]);
  assert.equal(decision.allowed, false);
  assert.ok(codes(decision.block_reasons).includes("finding_undisclosed"), JSON.stringify(decision.block_reasons));
});

withFixture("DISC latest round and digest must pin the current target set", (fx) => {
  writeDiscovery(fx);
  const evidences = [
    exploreRoundReview(fx, 1, []),
    exploreDigest(fx, 1, []),
    passEvidence("explore_complete", "human_confirmation"),
  ];
  const before = exploreCheck(fx, evidences);
  assert.equal(before.allowed, true, JSON.stringify(before));
  writeDiscovery(fx, "discovery facts v2 edited after review\n");
  const after = exploreCheck(fx, evidences);
  assert.equal(after.allowed, false);
  const reasonCodes = codes(after.block_reasons);
  assert.ok(reasonCodes.includes("review_round_stale"), JSON.stringify(reasonCodes));
  assert.ok(reasonCodes.includes("review_digest_stale"), JSON.stringify(reasonCodes));
});

withFixture("DISC clean rerun cannot erase an old open blocker", (fx) => {
  writeDiscovery(fx);
  const finding = exploreFinding();
  const r1 = exploreRoundReview(fx, 1, [finding]);
  const r2 = exploreRoundReview(fx, 2, [], { prompt_ref: exploreRoundPrompt(fx, 2, [r1]) });
  const decision = exploreCheck(fx, [
    r1,
    r2,
    exploreDigest(fx, 2, [], { previous_digest_refs: [] }),
  ]);
  assert.equal(decision.allowed, false);
  const reasonCodes = codes(decision.block_reasons);
  assert.ok(reasonCodes.includes("finding_unresolved"), JSON.stringify(reasonCodes));
  assert.ok(reasonCodes.includes("digest_chain_broken"), JSON.stringify(reasonCodes));
});

withFixture("DISC disposition identity must match the origin finding verbatim", (fx) => {
  writeDiscovery(fx);
  const finding = exploreFinding(1, { finding_type: "scope_risk" });
  const decision = exploreCheck(fx, [
    exploreRoundReview(fx, 1, [finding]),
    exploreDigest(fx, 1, [dispositionOf(finding, {
      disposition: "fixed",
      category: "implementation",
      material_categories: [],
      summary: "minor wording nit (downgraded)",
      artifact_update_refs: [DISCOVERY_REL],
    })]),
  ]);
  assert.equal(decision.allowed, false);
  const reasonCodes = codes(decision.block_reasons);
  assert.ok(reasonCodes.includes("finding_identity_mismatch"), JSON.stringify(reasonCodes));
  assert.ok(reasonCodes.includes("finding_summary_not_verbatim"), JSON.stringify(reasonCodes));
});

withFixture("DISC material terminal dispositions require a binding user decision", (fx) => {
  writeDiscovery(fx);
  const finding = exploreFinding(1, { finding_type: "scope_risk" });
  const review = exploreRoundReview(fx, 1, [finding]);
  const terminal = (overrides: JsonMap = {}) => exploreDigest(fx, 1, [dispositionOf(finding, {
    disposition: "user_decided",
    user_decision_refs: ["EV-user-decision-1"],
    ...overrides,
  })]);
  // material fixed without any user anchor (rule 8): source/artifact proof alone is not enough
  const noAnchor = exploreCheck(fx, [review, exploreDigest(fx, 1, [dispositionOf(finding, {
    disposition: "fixed",
    artifact_update_refs: [DISCOVERY_REL],
  })])]);
  assert.ok(codes(noAnchor.block_reasons).includes("user_decision_unbound"), JSON.stringify(noAnchor.block_reasons));
  const unboundCases: JsonMap[][] = [
    // decision exists but names a different finding_uid
    [review, terminal(), userDecision(fx, finding, { finding_uids: ["explore_complete:EV-explore-r1-critic:OTHER-001"] })],
    // decision_scope_key mismatch
    [review, terminal(), userDecision(fx, finding, { decision_scope_key: "demo-change:explore:another-issue" })],
    // material categories not covered
    [review, terminal(), userDecision(fx, finding, { material_categories: [] })],
    // confirmed blob does not match what the origin review pinned
    [review, terminal(), userDecision(fx, finding, { confirmed_refs: [{ path: DISCOVERY_REL, blob_sha: "0".repeat(40) }] })],
    // dangling ref: decision evidence does not exist at all
    [review, terminal()],
  ];
  for (const [idx, evidences] of unboundCases.entries()) {
    const decision = exploreCheck(fx, evidences);
    assert.equal(decision.allowed, false, `case ${idx}`);
    assert.ok(codes(decision.block_reasons).includes("user_decision_unbound"), `case ${idx}: ${JSON.stringify(decision.block_reasons)}`);
  }
});

withFixture("DISC option_d_custom drives artifact update, re-review, and the full loop", (fx) => {
  writeDiscovery(fx);
  const finding = exploreFinding();
  const r1 = exploreRoundReview(fx, 1, [finding]);
  const r1Digest = exploreDigest(fx, 1, [dispositionOf(finding)], { status: "blocked" });
  const decisionEv = userDecision(fx, finding, {
    decision: "option_d_custom",
    user_text: "缩小到适配器层，共享服务只读。",
    structured_decision: {
      scope: ["VacationDurationGetAdapter"],
      non_goals: ["ScheduleActualServiceImpl"],
      acceptance_impact: ["adapter contract"],
      test_impact: ["characterization tests"],
      requires_artifact_update: true,
      requires_rereview: true,
    },
  });
  // requires_rereview: consuming pass digest in the same round is too early
  const sameRound = exploreCheck(fx, [r1, decisionEv, exploreDigest(fx, 1, [dispositionOf(finding, {
    disposition: "user_decided",
    user_decision_refs: ["EV-user-decision-1"],
    artifact_update_refs: [DISCOVERY_REL],
  })])]);
  assert.ok(codes(sameRound.block_reasons).includes("rereview_required"), JSON.stringify(sameRound.block_reasons));
  // now run the full loop: update discovery, supersede stale r1 review, rerun critic, digest round 2
  writeDiscovery(fx, "discovery facts v2 narrowed to adapter layer\n");
  const r2 = exploreRoundReview(fx, 2, [], { prompt_ref: exploreRoundPrompt(fx, 2, [r1, r1Digest]) });
  // requires_artifact_update: terminal disposition must cite the artifact update
  const noUpdateRef = exploreCheck(fx, [
    r1, r1Digest, decisionEv, supersedeMarker("EV-explore-r1-critic"), r2,
    exploreDigest(fx, 2, [dispositionOf(finding, {
      disposition: "user_decided",
      user_decision_refs: ["EV-user-decision-1"],
    })]),
  ]);
  assert.ok(codes(noUpdateRef.block_reasons).includes("artifact_update_required"), JSON.stringify(noUpdateRef.block_reasons));
  const full = exploreCheck(fx, [
    r1, r1Digest, decisionEv, supersedeMarker("EV-explore-r1-critic"), r2,
    exploreDigest(fx, 2, [dispositionOf(finding, {
      disposition: "user_decided",
      user_decision_refs: ["EV-user-decision-1"],
      artifact_update_refs: [DISCOVERY_REL],
    })]),
    passEvidence("explore_complete", "human_confirmation"),
  ]);
  assert.equal(full.allowed, true, JSON.stringify(full.block_reasons));
});

withFixture("DISC standing authorization coverage is category, gate, type, and expiry bound", (fx) => {
  writeDiscovery(fx);
  // allow path: non-material finding accepted through an explicit user standing authorization
  const minor = exploreFinding(1, {
    finding_id: "EXP-IMPL-001",
    finding_type: "non_blocking_finding",
    category: "implementation",
    material_categories: [],
    decision_scope_key: "",
    requires_user_decision: false,
    summary: "implementation note: adapter naming could be tighter",
  });
  const review = exploreRoundReview(fx, 1, [minor]);
  const accepted = (authOverrides: JsonMap = {}, findingOverride: JsonMap = minor) => [
    exploreRoundReview(fx, 1, [findingOverride]),
    standingAuth(authOverrides),
    exploreDigest(fx, 1, [dispositionOf(findingOverride, {
      disposition: "accepted_deviation",
      standing_authorization_refs: ["EV-standing-auth-1"],
    })]),
    passEvidence("explore_complete", "human_confirmation"),
  ];
  const ok = exploreCheck(fx, accepted());
  assert.equal(ok.allowed, true, JSON.stringify(ok.block_reasons));
  const material = exploreFinding(1, { finding_type: "scope_risk" });
  const unboundCases: JsonMap[][] = [
    // material category not in allowed_categories
    accepted({}, material),
    // blockers can never ride a standing authorization
    accepted({ allowed_categories: ["scope", "implementation", "test_gap"] }, exploreFinding()),
    // gate mismatch
    accepted({ valid_gates: ["design_complete"] }),
    // expired
    accepted({ expires_at: "2020-01-01T00:00:00Z" }),
    // excluded wins over allowed even if listed
    accepted({ excluded_categories: ["implementation"] }),
  ];
  for (const [idx, evidences] of unboundCases.entries()) {
    const decision = exploreCheck(fx, evidences);
    assert.equal(decision.allowed, false, `case ${idx}`);
    assert.ok(codes(decision.block_reasons).includes("standing_authorization_unbound"), `case ${idx}: ${JSON.stringify(decision.block_reasons)}`);
  }
  assert.ok(review);
});

withFixture("DISC accepted material deviation must be acknowledged by the clean round", (fx) => {
  writeDiscovery(fx);
  const finding = exploreFinding(1, { finding_type: "scope_risk" });
  const r1 = exploreRoundReview(fx, 1, [finding]);
  const r1Digest = exploreDigest(fx, 1, [dispositionOf(finding)], { status: "blocked" });
  const decisionEv = userDecision(fx, finding);
  const r2Digest = exploreDigest(fx, 2, [dispositionOf(finding, {
    disposition: "accepted_deviation",
    user_decision_refs: ["EV-user-decision-1"],
  })]);
  const withoutAck = exploreCheck(fx, [
    r1, r1Digest, decisionEv,
    exploreRoundReview(fx, 2, [], { prompt_ref: exploreRoundPrompt(fx, 2, [r1, r1Digest]) }),
    r2Digest,
  ]);
  assert.equal(withoutAck.allowed, false);
  assert.ok(codes(withoutAck.block_reasons).includes("accepted_deviation_unacknowledged"), JSON.stringify(withoutAck.block_reasons));
  const withAck = exploreCheck(fx, [
    r1, r1Digest, decisionEv,
    exploreRoundReview(fx, 2, [], {
      prompt_ref: exploreRoundPrompt(fx, 2, [r1, r1Digest]),
      acknowledged_accepted_deviation_uids: [finding.finding_uid],
    }),
    r2Digest,
    passEvidence("explore_complete", "human_confirmation"),
  ]);
  assert.equal(withAck.allowed, true, JSON.stringify(withAck.block_reasons));
});

withFixture("DISC round numbering must be continuous and digest chain unbroken", (fx) => {
  writeDiscovery(fx);
  const finding = exploreFinding();
  const r1 = exploreRoundReview(fx, 1, [finding]);
  const gap = exploreCheck(fx, [
    r1,
    exploreRoundReview(fx, 3, [], { prompt_ref: exploreRoundPrompt(fx, 3, [r1]) }),
  ]);
  assert.ok(codes(gap.block_reasons).includes("review_round_discontinuous"), JSON.stringify(gap.block_reasons));
  const r1Digest = exploreDigest(fx, 1, [dispositionOf(finding)], { status: "blocked" });
  const broken = exploreCheck(fx, [
    r1, r1Digest, userDecision(fx, finding),
    exploreRoundReview(fx, 2, [], { prompt_ref: exploreRoundPrompt(fx, 2, [r1, r1Digest]) }),
    exploreDigest(fx, 2, [dispositionOf(finding, {
      disposition: "user_decided",
      user_decision_refs: ["EV-user-decision-1"],
    })], { previous_digest_refs: [] }),
  ]);
  assert.ok(codes(broken.block_reasons).includes("digest_chain_broken"), JSON.stringify(broken.block_reasons));
});

withFixture("DISC round k>1 prompt must embed the tool-rendered finding ledger", (fx) => {
  writeDiscovery(fx);
  const finding = exploreFinding(1, { finding_type: "scope_risk" });
  const r1 = exploreRoundReview(fx, 1, [finding]);
  const r1Digest = exploreDigest(fx, 1, [dispositionOf(finding)], { status: "blocked" });
  const decisionEv = userDecision(fx, finding);
  const r2Digest = exploreDigest(fx, 2, [dispositionOf(finding, {
    disposition: "user_decided",
    user_decision_refs: ["EV-user-decision-1"],
  })]);
  const bare = exploreCheck(fx, [r1, r1Digest, decisionEv, exploreRoundReview(fx, 2, []), r2Digest]);
  assert.equal(bare.allowed, false);
  assert.ok(codes(bare.block_reasons).includes("ledger_injection_missing"), JSON.stringify(bare.block_reasons));
  const injected = exploreCheck(fx, [
    r1, r1Digest, decisionEv,
    exploreRoundReview(fx, 2, [], { prompt_ref: exploreRoundPrompt(fx, 2, [r1, r1Digest]) }),
    r2Digest,
  ]);
  assert.ok(!codes(injected.block_reasons).includes("ledger_injection_missing"), JSON.stringify(injected.block_reasons));
});

withFixture("DISC exceeding the round budget escalates to the user", (fx) => {
  writeDiscovery(fx);
  const finding = exploreFinding();
  const evidences: JsonMap[] = [exploreRoundReview(fx, 1, [finding]), exploreDigest(fx, 1, [dispositionOf(finding)], { status: "blocked" })];
  for (let round = 2; round <= 4; round++) {
    evidences.push(exploreRoundReview(fx, round, [], { prompt_ref: exploreRoundPrompt(fx, round, evidences.slice()) }));
    evidences.push(exploreDigest(fx, round, [dispositionOf(finding)], { status: "blocked" }));
  }
  const decision = exploreCheck(fx, evidences);
  assert.equal(decision.allowed, false);
  const budget = decision.block_reasons.find((item: JsonMap) => item.code === "round_budget_exhausted");
  assert.ok(budget, JSON.stringify(codes(decision.block_reasons)));
  assert.ok(String(budget.message).includes("escalate_round_budget"), JSON.stringify(budget));
});

// ── DISC Phase 2: proposal_reviewed internal gate + design_complete disclosure ──

const PROPOSAL_REL = "proposal.md";

function writeProposal(fx: Fixture, text = "proposal v1\n"): void {
  writeText(join(fx.change, PROPOSAL_REL), text);
}

function proposalTargets(fx: Fixture): JsonMap[] {
  return [
    { path: PROPOSAL_REL, blob_sha: guard.file_blob_sha(join(fx.change, PROPOSAL_REL)) },
    { path: DISCOVERY_REL, blob_sha: discoveryBlob(fx) },
  ];
}

function proposalCheck(fx: Fixture, evidences: JsonMap[]): JsonMap {
  return guard.check_superspec_gate("demo-change", status(fx), fx.change, evidences, "proposal_reviewed");
}

function proposalFinding(round = 1, overrides: JsonMap = {}): JsonMap {
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

function proposalRoundReview(fx: Fixture, round: number, findings: JsonMap[], overrides: JsonMap = {}): JsonMap {
  return roleEvidence(fx, "proposal_reviewed", "critic", {
    evidence_id: `EV-proposal-r${round}-critic`,
    review_round_id: `proposal_reviewed-r${round}`,
    output_ref: `.superspec/reports/proposal-r${round}-critic.md`,
    findings,
    target_refs: proposalTargets(fx),
    ...overrides,
  });
}

function proposalRoundPrompt(fx: Fixture, round: number, priorEvidences: JsonMap[]): string {
  const rel = `.superspec/reports/proposal-r${round}-critic-prompt.md`;
  const ledger = guard.render_finding_ledger(
    "proposal_reviewed",
    guard.build_finding_ledger("proposal_reviewed", priorEvidences, round),
  );
  writeText(join(fx.change, rel), `critic prompt for proposal round ${round}\n\n${ledger}\n`);
  return rel;
}

function proposalDigest(fx: Fixture, round: number, dispositions: JsonMap[], overrides: JsonMap = {}): JsonMap {
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

function designTargetRefs(fx: Fixture): JsonMap[] {
  const set = guard.enumerate_review_targets("design_complete", fx.change);
  assert.ok(set, "design target set must be enumerable in this fixture");
  return [...set.entries()].map(([path, blob_sha]) => ({ path, blob_sha }));
}

withFixture("DISC2 proposal_reviewed is a hard gate with a mandatory disclosure loop", (fx) => {
  writeDiscovery(fx);
  writeProposal(fx);
  const explore = exploreConfirmedEvidences(fx);
  // No proposal review at all: both the role check and the born-disclosure check block.
  const empty = proposalCheck(fx, [...explore]);
  assert.equal(empty.allowed, false);
  assert.ok(codes(empty.block_reasons).includes("missing_proposal_review"), JSON.stringify(empty.block_reasons));
  assert.ok(codes(empty.block_reasons).includes("missing_review_digest"), JSON.stringify(empty.block_reasons));
  // Old-style (round-less, findings-less) critic evidence cannot dodge the disclosure loop:
  // proposal_reviewed has no legacy population, so there is no grandfather path.
  const oldStyle = proposalCheck(fx, [...explore, roleEvidence(fx, "proposal_reviewed", "critic")]);
  assert.equal(oldStyle.allowed, false);
  assert.ok(codes(oldStyle.block_reasons).includes("missing_review_digest"), JSON.stringify(oldStyle.block_reasons));
  // Round-tagged clean review + digest is the only allow path.
  const full = proposalCheck(fx, [...explore, proposalRoundReview(fx, 1, []), proposalDigest(fx, 1, [])]);
  assert.equal(full.allowed, true, JSON.stringify(full.block_reasons));
});

withFixture("DISC2 proposal blocker cannot be silently fixed by the main thread", (fx) => {
  writeDiscovery(fx);
  writeProposal(fx);
  const explore = exploreConfirmedEvidences(fx);
  const finding = proposalFinding();
  const r1 = proposalRoundReview(fx, 1, [finding]);
  const r1Digest = proposalDigest(fx, 1, [dispositionOf(finding)], { status: "blocked" });
  // Disclosed but waiting for the user: hard stop.
  const pending = proposalCheck(fx, [...explore, r1, r1Digest]);
  assert.equal(pending.allowed, false);
  assert.ok(codes(pending.block_reasons).includes("needs_user_decision_pending"), JSON.stringify(pending.block_reasons));
  // "Silent fix" without any disclosure: rerun the critic straight to a clean round and never
  // give the r1 blocker a disposition — the ledger keeps the history alive.
  const silent = proposalCheck(fx, [
    ...explore, r1,
    proposalRoundReview(fx, 2, [], { prompt_ref: proposalRoundPrompt(fx, 2, [r1]) }),
    proposalDigest(fx, 2, [], { previous_digest_refs: [] }),
  ]);
  assert.equal(silent.allowed, false);
  assert.ok(codes(silent.block_reasons).includes("finding_unresolved"), JSON.stringify(silent.block_reasons));
  // Dropping the disclosed finding from the next digest is just as blocked: the pending
  // user decision survives in the ledger.
  const dropped = proposalCheck(fx, [
    ...explore, r1, r1Digest,
    proposalRoundReview(fx, 2, [], { prompt_ref: proposalRoundPrompt(fx, 2, [r1, r1Digest]) }),
    proposalDigest(fx, 2, []),
  ]);
  assert.equal(dropped.allowed, false);
  assert.ok(codes(dropped.block_reasons).includes("needs_user_decision_pending"), JSON.stringify(dropped.block_reasons));
  // Legal path: user decision + user_decided disposition in the round 2 digest.
  const decisionEv = userDecision(fx, finding, {
    gate: "proposal_reviewed",
    review_round_id: "proposal_reviewed-r1",
    confirmed_refs: proposalTargets(fx),
  });
  const legal = proposalCheck(fx, [
    ...explore, r1, r1Digest, decisionEv,
    proposalRoundReview(fx, 2, [], { prompt_ref: proposalRoundPrompt(fx, 2, [r1, r1Digest]) }),
    proposalDigest(fx, 2, [dispositionOf(finding, { disposition: "user_decided", user_decision_refs: ["EV-user-decision-1"] })]),
  ]);
  assert.equal(legal.allowed, true, JSON.stringify(legal.block_reasons));
});

withFixture("DISC2 disposition routes are bounded globally and per gate", (fx) => {
  writeDiscovery(fx);
  writeProposal(fx);
  const explore = exploreConfirmedEvidences(fx);
  const finding = proposalFinding();
  // Unknown route fails the digest schema outright.
  const schemaCodes = discSchemaCodes(fx, [proposalDigest(fx, 1, [dispositionOf(finding, { route: "just-fix-it" })], { status: "blocked" })]);
  assert.ok(schemaCodes.includes("review_digest_invalid"), JSON.stringify(schemaCodes));
  // A known route that is illegal on this gate blocks: reopen_tasks belongs to review_complete.
  const r1 = proposalRoundReview(fx, 1, [finding]);
  const illegal = proposalCheck(fx, [
    ...explore, r1,
    proposalDigest(fx, 1, [dispositionOf(finding, { route: "reopen_tasks" })], { status: "blocked" }),
  ]);
  assert.ok(codes(illegal.block_reasons).includes("finding_route_invalid"), JSON.stringify(illegal.block_reasons));
  // return_explore is the legal escape hatch for discovery-incomplete proposal findings.
  const legalRoute = proposalCheck(fx, [
    ...explore, r1,
    proposalDigest(fx, 1, [dispositionOf(finding, { route: "return_explore" })], { status: "blocked" }),
  ]);
  assert.ok(!codes(legalRoute.block_reasons).includes("finding_route_invalid"), JSON.stringify(legalRoute.block_reasons));
});

withFixture("DISC2 design/specs/propose paths all require proposal_reviewed", (fx) => {
  // Canonical state surfaces (design Phase 2): entry gates, alias, route phase.
  assert.equal(guard.ARTIFACT_ENTER_GATE.specs, "proposal_reviewed");
  assert.equal(guard.ARTIFACT_ENTER_GATE.design, "proposal_reviewed");
  assert.equal(guard.GATE_ALIASES["propose.proposal_reviewed"], "proposal_reviewed");
  assert.equal(guard.GATE_ROUTE.proposal_reviewed, "propose");
  const evidences = prepareProposeComplete(fx, { checked: true }).filter((ev) => ev.gate !== "proposal_reviewed");
  // Direct design gate and its alias.
  for (const gateName of ["design_complete", "propose.design_reviewed"]) {
    const decision = guard.check_superspec_gate("demo-change", status(fx), fx.change, evidences, gateName);
    assert.equal(decision.allowed, false, gateName);
    assert.ok(codes(decision.block_reasons).includes("proposal_reviewed_failed"), `${gateName}: ${JSON.stringify(codes(decision.block_reasons))}`);
  }
  // propose_complete subgate list.
  const propose = guard.check_superspec_gate("demo-change", status(fx), fx.change, evidences, "propose_complete");
  assert.equal(propose.allowed, false);
  assert.ok(codes(propose.block_reasons).includes("proposal_reviewed_failed"), JSON.stringify(codes(propose.block_reasons)));
  // Artifact entry paths for specs/design.
  for (const artifact of ["specs", "design"]) {
    const entry = guard.check_artifact("demo-change", status(fx), fx.change, evidences, artifact);
    assert.equal(entry.allowed, false, artifact);
    assert.ok(codes(entry.block_reasons).includes("proposal_reviewed_failed"), `${artifact}: ${JSON.stringify(codes(entry.block_reasons))}`);
  }
  // Direct tasks-side entries block while a predecessor disclosure gate is missing.
  for (const gateName of ["propose.tasks_mapped", "tasks_complete"]) {
    const decision = guard.check_superspec_gate("demo-change", status(fx), fx.change, evidences, gateName);
    assert.equal(decision.allowed, false, gateName);
    assert.ok(codes(decision.block_reasons).includes("test_contract_not_honored"), `${gateName}: ${JSON.stringify(codes(decision.block_reasons))}`);
  }
  // Restoring the proposal evidence restores the whole chain.
  const restored = guard.check_superspec_gate("demo-change", status(fx), fx.change, prepareProposeComplete(fx, { checked: true }), "propose_complete");
  assert.equal(restored.allowed, true, JSON.stringify(restored.block_reasons));
});

withFixture("DISC2 design disclosure pins the full glob target set (set equality)", (fx) => {
  const evidences = prepareProposeComplete(fx);
  const designTargets = designTargetRefs(fx);
  assert.ok(designTargets.some((ref) => ref.path === "specs/attendance/spec.md"), JSON.stringify(designTargets));
  const roundEvidences = [
    ...evidences,
    roleEvidence(fx, "design_complete", "critic", {
      evidence_id: "EV-design-r1-critic",
      review_round_id: "design_complete-r1",
      output_ref: ".superspec/reports/design-r1-critic.md",
      findings: [],
      target_refs: designTargets,
    }),
    passEvidence("design_complete", "main_review_digest", {
      evidence_id: "EV-design-r1-digest",
      created_by: "main-thread",
      review_round_id: "design_complete-r1",
      target_refs: designTargets,
      source_review_evidence_refs: ["EV-design-r1-critic"],
      previous_digest_refs: [],
      finding_dispositions: [],
    }),
  ];
  const before = guard.check_superspec_gate("demo-change", status(fx), fx.change, roundEvidences, "design_complete");
  assert.equal(before.allowed, true, JSON.stringify(before.block_reasons));
  // A spec file added after the digest changes the enumerated set: every pinned blob still
  // matches, but set equality (P1-6) makes both the round and the digest stale.
  writeText(join(fx.change, "specs", "attendance", "extra.md"), "#### Scenario: Scenario B\n");
  const after = guard.check_superspec_gate("demo-change", status(fx), fx.change, roundEvidences, "design_complete");
  assert.equal(after.allowed, false);
  assert.ok(codes(after.block_reasons).includes("review_round_stale"), JSON.stringify(codes(after.block_reasons)));
  assert.ok(codes(after.block_reasons).includes("review_digest_stale"), JSON.stringify(codes(after.block_reasons)));
});

withFixture("DISC2 legacy design evidence stays grandfathered until round-tagged evidence appears", (fx) => {
  // prepareProposeComplete uses legacy (round-less) design reviews; the disclosure loop must
  // stay inactive for them (P2-3) so in-flight changes are not retroactively blocked.
  const decision = guard.check_superspec_gate("demo-change", status(fx), fx.change, prepareProposeComplete(fx), "design_complete");
  assert.equal(decision.allowed, true, JSON.stringify(decision.block_reasons));
});

// ── DISC Phase 3: invariants_reviewed / test_contract_drafted / tasks_complete ──

function targetRefList(set: Map<string, string>): JsonMap[] {
  return [...set.entries()].map(([path, blob_sha]) => ({ path, blob_sha }));
}

function gateFinding(gate: string, round: number, evidenceId: string, findingId: string, overrides: JsonMap = {}): JsonMap {
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

function roundReviewWithTargets(
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

function roundDigestWithTargets(
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

function proposeChainThroughDesign(fx: Fixture): JsonMap[] {
  return prepareProposeComplete(fx).filter((ev) => !["invariants_reviewed", "test_contract_drafted"].includes(String(ev.gate)));
}

withFixture("DISC3 invariants material blocker requires disclosure when round-tagged", (fx) => {
  const base = proposeChainThroughDesign(fx);
  const targets = guard.enumerate_review_targets("invariants_reviewed", fx.change)!;
  const finding = gateFinding("invariants_reviewed", 1, "EV-invariants-r1-critic", "INV-TRUTH-001");
  const decision = guard.check_superspec_gate("demo-change", status(fx), fx.change, [
    ...base,
    roundReviewWithTargets(fx, "invariants_reviewed", "critic", 1, targets, [finding]),
    roleEvidence(fx, "invariants_reviewed", "test-engineer"),
  ], "invariants_reviewed");
  assert.equal(decision.allowed, false);
  const reasonCodes = codes(decision.block_reasons);
  assert.ok(reasonCodes.includes("missing_review_digest"), JSON.stringify(reasonCodes));
  assert.ok(reasonCodes.includes("finding_unresolved"), JSON.stringify(reasonCodes));
});

withFixture("DISC3 upstream business-invariants edit stale after digest", (fx) => {
  const base = proposeChainThroughDesign(fx);
  const targets = guard.enumerate_review_targets("invariants_reviewed", fx.change)!;
  const finding = gateFinding("invariants_reviewed", 1, "EV-invariants-r1-critic", "INV-TRUTH-001");
  const review = roundReviewWithTargets(fx, "invariants_reviewed", "critic", 1, targets, [finding]);
  const digest = roundDigestWithTargets(fx, "invariants_reviewed", 1, targets, [dispositionOf(finding, {
    disposition: "needs_user_decision",
    route: "stay_same_gate_user_decision",
    route_reason: "business semantics need user confirmation",
  })], { status: "blocked" });
  const evidences = [...base, review, roleEvidence(fx, "invariants_reviewed", "test-engineer"), digest];
  const before = guard.check_superspec_gate("demo-change", status(fx), fx.change, evidences, "invariants_reviewed");
  assert.equal(before.allowed, false);
  assert.ok(codes(before.block_reasons).includes("needs_user_decision_pending"));
  writeText(join(fx.change, ".superspec", "artifacts", "business-invariants.md"), businessInvariantsText("INV-002"));
  const after = guard.check_superspec_gate("demo-change", status(fx), fx.change, evidences, "invariants_reviewed");
  assert.equal(after.allowed, false);
  assert.ok(codes(after.block_reasons).includes("review_digest_stale"), JSON.stringify(codes(after.block_reasons)));
});

withFixture("DISC3 illegal disposition routes block per gate matrix", (fx) => {
  const base = proposeChainThroughDesign(fx);
  const invTargets = guard.enumerate_review_targets("invariants_reviewed", fx.change)!;
  const invFinding = gateFinding("invariants_reviewed", 1, "EV-invariants-r1-critic", "INV-TRUTH-001");
  const invReview = roundReviewWithTargets(fx, "invariants_reviewed", "critic", 1, invTargets, [invFinding]);
  const invIllegal = guard.check_superspec_gate("demo-change", status(fx), fx.change, [
    ...base,
    invReview,
    roleEvidence(fx, "invariants_reviewed", "test-engineer"),
    roundDigestWithTargets(fx, "invariants_reviewed", 1, invTargets, [dispositionOf(invFinding, {
      disposition: "needs_user_decision",
      route: "reopen_tasks",
      route_reason: "illegal on invariants gate",
    })], { status: "blocked" }),
  ], "invariants_reviewed");
  assert.ok(codes(invIllegal.block_reasons).includes("finding_route_invalid"), JSON.stringify(invIllegal.block_reasons));

  const tcTargets = guard.enumerate_review_targets("test_contract_drafted", fx.change)!;
  const tcFinding = gateFinding("test_contract_drafted", 1, "EV-test-contract-r1-critic", "TC-ACCEPT-001", {
    category: "acceptance",
    material_categories: ["acceptance"],
    decision_scope_key: "demo-change:test-contract:acceptance",
    summary: "acceptance criteria conflict with spec scenario",
  });
  const tcReview = roundReviewWithTargets(fx, "test_contract_drafted", "critic", 1, tcTargets, [tcFinding]);
  const tcIllegal = guard.check_superspec_gate("demo-change", status(fx), fx.change, [
    ...prepareProposeComplete(fx).filter((ev) => ev.gate !== "test_contract_drafted"),
    tcReview,
    roleEvidence(fx, "test_contract_drafted", "test-engineer"),
    roundDigestWithTargets(fx, "test_contract_drafted", 1, tcTargets, [dispositionOf(tcFinding, {
      disposition: "needs_user_decision",
      route: "return_test_contract_drafted",
      route_reason: "wrong route on test_contract gate",
    })], { status: "blocked" }),
  ], "test_contract_drafted");
  assert.ok(codes(tcIllegal.block_reasons).includes("finding_route_invalid"), JSON.stringify(tcIllegal.block_reasons));
});

withFixture("DISC3 test_contract glob set equality stale when spec file added", (fx) => {
  const base = prepareProposeComplete(fx);
  const targets = guard.enumerate_review_targets("test_contract_drafted", fx.change)!;
  const evidences = [
    ...base.filter((ev) => ev.gate !== "test_contract_drafted"),
    roundReviewWithTargets(fx, "test_contract_drafted", "critic", 1, targets, []),
    roleEvidence(fx, "test_contract_drafted", "test-engineer"),
    roundDigestWithTargets(fx, "test_contract_drafted", 1, targets, []),
  ];
  const before = guard.check_superspec_gate("demo-change", status(fx), fx.change, evidences, "test_contract_drafted");
  assert.equal(before.allowed, true, JSON.stringify(before.block_reasons));
  writeText(join(fx.change, "specs", "attendance", "extra.md"), "#### Scenario: Scenario B\n");
  const after = guard.check_superspec_gate("demo-change", status(fx), fx.change, evidences, "test_contract_drafted");
  assert.equal(after.allowed, false);
  assert.ok(codes(after.block_reasons).includes("review_digest_stale"), JSON.stringify(codes(after.block_reasons)));
});

withFixture("DISC3 legacy invariants and test_contract evidence stay grandfathered", (fx) => {
  const decision = guard.check_superspec_gate("demo-change", status(fx), fx.change, prepareProposeComplete(fx), "invariants_reviewed");
  assert.equal(decision.allowed, true, JSON.stringify(decision.block_reasons));
  const drafted = guard.check_superspec_gate("demo-change", status(fx), fx.change, prepareProposeComplete(fx), "test_contract_drafted");
  assert.equal(drafted.allowed, true, JSON.stringify(drafted.block_reasons));
});

withFixture("DISC3 tasks_complete disclosure activates only with round-tagged review", (fx) => {
  const base = prepareProposeComplete(fx, { checked: true });
  const legacy = guard.check_superspec_gate("demo-change", status(fx), fx.change, base, "tasks_complete");
  assert.equal(legacy.allowed, true, JSON.stringify(legacy.block_reasons));
  const targets = guard.enumerate_review_targets("tasks_complete", fx.change)!;
  const finding = gateFinding("tasks_complete", 1, "EV-tasks-r1-critic", "TASK-MAP-001", {
    category: "acceptance",
    material_categories: ["acceptance"],
    decision_scope_key: "demo-change:tasks:mapping",
    summary: "task test_refs do not cover the agreed acceptance boundary",
  });
  const review = roundReviewWithTargets(fx, "tasks_complete", "critic", 1, targets, [finding]);
  const blocked = guard.check_superspec_gate("demo-change", status(fx), fx.change, [...base, review], "tasks_complete");
  assert.equal(blocked.allowed, false);
  assert.ok(codes(blocked.block_reasons).includes("missing_review_digest"), JSON.stringify(blocked.block_reasons));
  const legalRoute = roundDigestWithTargets(fx, "tasks_complete", 1, targets, [dispositionOf(finding, {
    disposition: "needs_user_decision",
    route: "return_test_contract_drafted",
    route_reason: "acceptance mapping wrong; return to test contract gate",
  })], { status: "blocked" });
  const withRoute = guard.check_superspec_gate("demo-change", status(fx), fx.change, [...base, review, legalRoute], "tasks_complete");
  assert.ok(!codes(withRoute.block_reasons).includes("finding_route_invalid"), JSON.stringify(withRoute.block_reasons));
});

withFixture("DISC3 root-mismatched or escaping pinned target paths fail closed as stale", (fx) => {
  // Design §7: every propose-period gate pins change-root relative paths. Repo-root prefixes or
  // "../" traversal never equal the enumerated canonical set, so set equality (P1-6) must block.
  const base = proposeChainThroughDesign(fx);
  const targets = guard.enumerate_review_targets("invariants_reviewed", fx.change)!;
  const badTargets = [...targets.entries()].map(([path, blob_sha], idx) => ({
    path: idx === 0 ? `openspec/changes/demo-change/${path}` : `../demo-change/${path}`,
    blob_sha,
  }));
  const review = roleEvidence(fx, "invariants_reviewed", "critic", {
    evidence_id: "EV-invariants_reviewed-r1-critic",
    review_round_id: "invariants_reviewed-r1",
    output_ref: ".superspec/reports/invariants_reviewed-r1-critic.md",
    findings: [],
    target_refs: badTargets,
  });
  const digest = passEvidence("invariants_reviewed", "main_review_digest", {
    evidence_id: "EV-invariants_reviewed-r1-digest",
    created_by: "main-thread",
    review_round_id: "invariants_reviewed-r1",
    target_refs: badTargets,
    source_review_evidence_refs: ["EV-invariants_reviewed-r1-critic"],
    previous_digest_refs: [],
    finding_dispositions: [],
  });
  const decision = guard.check_superspec_gate("demo-change", status(fx), fx.change, [
    ...base,
    review,
    roleEvidence(fx, "invariants_reviewed", "test-engineer"),
    digest,
  ], "invariants_reviewed");
  assert.equal(decision.allowed, false);
  const reasonCodes = codes(decision.block_reasons);
  assert.ok(reasonCodes.includes("review_round_stale"), JSON.stringify(reasonCodes));
  assert.ok(reasonCodes.includes("review_digest_stale"), JSON.stringify(reasonCodes));
});
