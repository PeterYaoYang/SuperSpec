import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import test from "node:test";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

function findRepoRoot(start: string): string {
  let dir = resolve(start);
  while (true) {
    if (existsSync(join(dir, "package.json")) && existsSync(join(dir, "templates")) && existsSync(join(dir, "docs", "DISTRIBUTION.md"))) return dir;
    const parent = dirname(dir);
    if (parent === dir) return resolve(start);
    dir = parent;
  }
}

const REPO = findRepoRoot(dirname(fileURLToPath(import.meta.url)));
const PACKAGE_ROOT = REPO;
const TEMPLATE_ROOT = join(PACKAGE_ROOT, "templates");
const ADAPTER_ROOT = join(PACKAGE_ROOT, "adapters", "codex");

const REQUIRED_SKILLS = [
  "superspec-explore",
  "superspec-propose",
  "superspec-apply",
  "superspec-review",
  "superspec-archive",
] as const;

const REMOVED_STAGE_SKILLS = [
  "superspec-init",
  "superspec-design",
  "superspec-test-contract",
  "superspec-tasks",
  "superspec-verify",
] as const;

const REQUIRED_ROLES = [
  "architect",
  "critic",
  "test-engineer",
  "code-reviewer",
  "verifier",
] as const;

function templateSkillText(name: string): string {
  return readFileSync(join(TEMPLATE_ROOT, "workflow", "skills", name, "SKILL.md"), "utf8");
}

function templatePromptText(name: string): string {
  return readFileSync(join(TEMPLATE_ROOT, "workflow", "prompts", `${name}.md`), "utf8");
}

function proposalDocText(relPath: string): string {
  return readFileSync(join(REPO, "docs", relPath), "utf8");
}

function repoText(relPath: string): string {
  return readFileSync(join(REPO, relPath), "utf8");
}

function npmCommand(): string {
  return process.platform === "win32" ? "npm.cmd" : "npm";
}

test("superspec package declares workflow payload surface", () => {
  const pkg = JSON.parse(repoText("package.json"));
  assert.equal(pkg.name, "@peterxiaoyang/superspec");
  assert.equal(pkg.private, false);
  assert.equal(pkg.type, "module");
  assert.equal(pkg.engines.node, ">=20.19.0");
  assert.equal(pkg.bin.superspec, "bin/superspec.js");
  assert.equal(pkg.bin["superspec-guard"], "bin/superspec-guard.js");
  assert.equal(pkg.bin["superspec-init"], "bin/superspec-init.js");
  assert.equal(pkg.exports["."].default, "./dist/superspec.js");
  assert.equal(pkg.exports["./superspec_guard"].default, "./dist/superspec_guard.js");
  assert.equal(pkg.exports["./superspec_init"].default, "./dist/superspec_init.js");
  assert.equal(pkg.scripts.build, "node build.js");
  assert.equal(pkg.scripts.prepack, "npm run build");
  assert.equal(pkg.scripts.prepublishOnly, "npm run build");
  assert.ok(pkg.files.includes("bin"));
  assert.ok(pkg.files.includes("dist"));
  assert.ok(pkg.files.includes("templates"));
  assert.ok(pkg.files.includes("adapters"));
  assert.ok(pkg.files.includes("schemas"));
  assert.equal(pkg.files.includes("src"), false);
  assert.equal(pkg.files.includes("superspec.ts"), false);
  assert.equal(pkg.files.includes("tests"), false);
});

test("compiled runtime resolves package payload from the package root", () => {
  const build = spawnSync(npmCommand(), ["run", "build"], { cwd: REPO, encoding: "utf8" });
  assert.equal(build.status, 0, build.stderr || build.stdout);
  const proc = spawnSync(process.execPath, [
    "-e",
    [
      "const m = await import('./dist/src/install_engine.js');",
      "const result = m.load_install_map();",
      "if (result.problems.length) throw new Error(result.problems.join('\\n'));",
      "if (!m.PACKAGE_ROOT.endsWith('SuperSpec')) throw new Error(`bad package root: ${m.PACKAGE_ROOT}`);",
      "process.stdout.write(String(result.mappings.length));",
    ].join("\n"),
  ], { cwd: REPO, encoding: "utf8" });
  assert.equal(proc.status, 0, proc.stderr || proc.stdout);
  assert.equal(proc.stdout.trim(), "15");
});

test("bin launchers report unsupported Node versions before loading compiled runtime", () => {
  const proc = spawnSync(process.execPath, [
    "-e",
    "import('./bin/launch.js').then((m) => process.stdout.write([m.nodeVersionError('20.18.0') ?? 'ok', m.nodeVersionError('20.19.0') ?? 'ok'].join('\\n')))",
  ], { cwd: REPO, encoding: "utf8" });
  assert.equal(proc.status, 0);
  assert.match(proc.stdout, /requires Node\.js >=20\.19\.0/);
  assert.match(proc.stdout, /20\.18\.0/);
  assert.match(proc.stdout, /\nok$/);
});

test("all superspec skills exist", () => {
  for (const name of REQUIRED_SKILLS) {
    assert.equal(existsSync(join(TEMPLATE_ROOT, "workflow", "skills", name, "SKILL.md")), true, name);
  }
});

test("install map carries every package skill template", () => {
  const installMap = JSON.parse(repoText("adapters/codex/install-map.json"));
  const sources = new Set(installMap.mappings.map((item: Record<string, string>) => item.source));
  for (const name of REQUIRED_SKILLS) {
    assert.ok(sources.has(`templates/workflow/skills/${name}/SKILL.md`), name);
  }
});

test("package carries repo-local superspec roles", () => {
  for (const name of REQUIRED_ROLES) {
    const agent = readFileSync(join(ADAPTER_ROOT, "agents", `${name}.toml`), "utf8");
    const prompt = readFileSync(join(TEMPLATE_ROOT, "workflow", "prompts", `${name}.md`), "utf8");
    assert.ok(agent.includes(`name = "${name}"`), name);
    assert.ok(prompt.trim().length > 0, name);
  }
});

test("codex adapter maps generic workflow templates to repo-local surfaces", () => {
  const installMap = JSON.parse(repoText("adapters/codex/install-map.json"));
  assert.equal(installMap.adapter, "codex");
  const mappings = installMap.mappings.map((item: Record<string, string>) => `${item.kind}:${item.source}->${item.target}`);
  assert.ok(mappings.includes("skill:templates/workflow/skills/superspec-review/SKILL.md->.codex/skills/superspec-review/SKILL.md"));
  assert.ok(mappings.includes("prompt:templates/workflow/prompts/critic.md->.codex/prompts/critic.md"));
  assert.ok(mappings.includes("agent:adapters/codex/agents/critic.toml->.codex/agents/critic.toml"));
  assert.equal(mappings.some((item: string) => item.startsWith("wrapper:")), false);
  for (const item of installMap.mappings) {
    assert.equal(existsSync(join(PACKAGE_ROOT, item.source)), true, item.source);
  }
});

test("package carries sidecar templates and install manifest schema", () => {
  for (const name of ["archive-preservation.json", "business-invariants.md", "config.yaml", "discovery.md", "test-contract.md"]) {
    assert.equal(
      readFileSync(join(TEMPLATE_ROOT, "sidecar", name), "utf8"),
      proposalDocText(`templates/${name}`),
      name,
    );
  }
  const schema = JSON.parse(repoText("schemas/install-manifest.schema.json"));
  assert.equal(schema.title, "SuperSpec install manifest");
  assert.ok(schema.required.includes("files"));
  assert.ok(schema.properties.files.items.required.includes("managed"));
  assert.ok(schema.properties.files.items.required.includes("preexisting"));
});

test("script-only and internal stages are not user visible skills", () => {
  for (const name of REMOVED_STAGE_SKILLS) {
    assert.equal(existsSync(join(TEMPLATE_ROOT, "workflow", "skills", name, "SKILL.md")), false, name);
  }
});

test("distribution doc matches visible superspec skill set", () => {
  const actual = readdirSync(join(TEMPLATE_ROOT, "workflow", "skills")).filter((name) => name.startsWith("superspec-")).sort();
  assert.deepEqual(actual, [...REQUIRED_SKILLS].sort());

  const text = proposalDocText("DISTRIBUTION.md");
  assert.ok(text.includes("5 个用户可见 skill"));
  assert.ok(text.includes("explore/propose/apply/review/archive"));
  assert.equal(text.includes("superspec-{init,explore"), false);
  assert.equal(text.includes(".codex/skills/superspec-init/SKILL.md"), false);
  assert.equal(text.includes("skills/superspec-*/SKILL.md     (7)"), false);
});

test("superspec distribution files are not gitignored", () => {
  const checked = [
    "package.json",
    "bin/launch.js",
    "bin/superspec.js",
    "bin/superspec-guard.js",
    "bin/superspec-init.js",
    "build.js",
    "src/core.ts",
    "tests/test_superspec_guard.test.ts",
    "templates/workflow/skills/superspec-review/SKILL.md",
    "templates/workflow/prompts/critic.md",
    "adapters/codex/agents/critic.toml",
    "adapters/codex/install-map.json",
    "templates/sidecar/test-contract.md",
    "schemas/install-manifest.schema.json",
    "superspec.ts",
    "tsconfig.build.json",
  ];
  for (const path of checked) {
    const proc = spawnSync("git", ["check-ignore", "-q", path], { cwd: REPO });
    assert.equal(proc.status, 1, `${path} must be eligible for clean-checkout CI`);
  }
});

test("superspec CI watches package distribution inputs", () => {
  const workflow = repoText(".github/workflows/superspec.yml");
  assert.ok(workflow.includes('"src/**"'));
  assert.ok(workflow.includes('"tests/**"'));
  assert.ok(workflow.includes('"templates/**"'));
  assert.ok(workflow.includes('"adapters/**"'));
  assert.ok(workflow.includes('"bin/**"'));
  assert.ok(workflow.includes('"build.js"'));
  assert.ok(workflow.includes('"tsconfig.build.json"'));
  assert.ok(workflow.includes('"superspec_guard.ts"'));
  assert.ok(workflow.includes('"superspec_init.ts"'));
  assert.ok(workflow.includes('"superspec.ts"'));
  assert.ok(workflow.includes('".gitignore"'));
});

test("skills call guard before advancing", () => {
  for (const name of REQUIRED_SKILLS) {
    const text = templateSkillText(name);
    assert.ok(text.includes("superspec"), name);
    assert.ok(text.includes(" guard "), name);
    assert.equal(text.includes("SUPERSPEC_CLI"), false, name);
    assert.equal(text.includes("./node_modules/.bin/superspec-guard"), false, name);
    assert.equal(text.includes("SUPERSPEC_GUARD"), false, name);
    assert.equal(text.includes("${SUPERSPEC_GUARD:-./scripts/superspec_guard}"), false, name);
    assert.equal(text.includes("${"), false, name);
    assert.equal(text.includes("test -f "), false, name);
    assert.equal(text.includes("```bash"), false, name);
    assert.ok(text.includes("guard `block`"), name);
    assert.ok(text.includes("## 语言规则 / Language"), name);
    assert.ok(text.includes("默认使用简体中文"), name);
  }
  assert.ok(templateSkillText("superspec-explore").includes("init --scope project"));
  assert.equal(templateSkillText("superspec-explore").includes("SUPERSPEC_INIT"), false);
});

test("propose owns openspec package and sidecar gates", () => {
  const text = templateSkillText("superspec-propose");
  for (const phrase of [
    "proposal.md",
    "specs/**/*.md",
    "design.md",
    "tasks.md",
    ".superspec/artifacts/business-invariants.md",
    ".superspec/artifacts/test-contract.md",
    "critic",
    // DISC Phase 2: proposal review is a hard internal gate now; the old "advisory note /
    // 不新增 guard gate" wording must stay deleted and the disclosure loop must be present.
    "不是 advisory note",
    "propose.proposal_reviewed",
    "main_review_digest",
    "user_review_decision",
    "propose.invariants_reviewed",
    "propose.design_reviewed",
    "propose.test_plan_drafted",
    "propose.tasks_mapped",
    "check-apply-ready",
  ]) {
    assert.ok(text.includes(phrase), phrase);
  }
});

test("explore explicitly bridges openspec explore", () => {
  const text = templateSkillText("superspec-explore");
  assert.ok(text.includes(".codex/skills/openspec-explore/SKILL.md"));
  assert.ok(text.includes("OpenSpec Awareness"));
  assert.ok(text.includes("openspec list --json"));
  assert.ok(text.includes("openspec status --change"));
  assert.ok(text.includes("superspec-propose"));
  assert.ok(text.includes("openspec instructions"));
});

test("propose explicitly bridges openspec propose", () => {
  const text = templateSkillText("superspec-propose");
  assert.ok(text.includes(".codex/skills/openspec-propose/SKILL.md"));
  assert.ok(text.includes("openspec-propose"));
  assert.ok(text.includes("artifact-order"));
  assert.ok(text.includes("openspec instructions <artifact-id>"));
  assert.ok(text.includes("one-shot"));
});

test("apply explicitly bridges openspec apply", () => {
  const text = templateSkillText("superspec-apply");
  assert.ok(text.includes(".codex/skills/openspec-apply-change/SKILL.md"));
  assert.ok(text.includes("openspec-apply-change"));
  assert.ok(text.includes("contextFiles"));
  assert.ok(text.includes("progress"));
  assert.ok(text.includes("dynamic instruction"));
  assert.ok(text.includes("RED/GREEN"));
});

test("archive documents native archive handoff", () => {
  const text = templateSkillText("superspec-archive");
  assert.ok(text.includes(".codex/skills/openspec-archive-change/SKILL.md"));
  assert.ok(text.includes("`mkdir`/`mv` archive procedure"));
  assert.ok(text.includes("`openspec archive` 取代"));
  assert.ok(text.includes("openspec archive -y"));
  assert.ok(text.includes("--no-validate"));
  assert.ok(text.includes(".superspec/artifacts/business-invariants.md"));
  assert.ok(text.includes(".superspec/evidence/invariants/"));
});

test("test contract template preserves invariant mapping", () => {
  const text = proposalDocText("templates/test-contract.md");
  assert.ok(text.includes("关联 INV"));
  assert.ok(text.includes("invariant_refs"));
  assert.ok(text.includes("tasks.md"));
});

test("review requires repo-local native agents", () => {
  const text = templateSkillText("superspec-review");
  assert.ok(text.includes(".codex/agents/code-reviewer.toml"));
  assert.ok(text.includes(".codex/prompts/code-reviewer.md"));
  assert.ok(text.includes(".codex/agents/architect.toml"));
  assert.ok(text.includes(".codex/prompts/architect.md"));
  assert.ok(text.includes(".codex/agents/critic.toml"));
  assert.ok(text.includes(".codex/prompts/critic.md"));
  assert.ok(text.includes(".codex/agents/verifier.toml"));
  assert.ok(text.includes(".codex/prompts/verifier.md"));
  assert.ok(text.includes("`superspec-review` 直接拥有并执行 repo-local review 协议"));
  assert.ok(text.includes("不要为 code review 调用另一个 skill 或 workflow"));
  assert.ok(text.includes("不需要单独安装 `code-review` skill"));
  assert.ok(text.includes("native subagent"));
  assert.ok(text.includes("`review_complete` 是 allow-only gate"));
  assert.ok(text.includes("`main_adjudication.review_decision:\"allow\"`"));
  assert.ok(text.includes("`request_changes_route`"));
  assert.ok(text.includes("`verification_evidence_refs` 必须为空"));
  assert.ok(text.includes("`execution_mode:\"direct\"` + `created_by:\"main-thread\"`"));
  assert.ok(text.includes("main_adjudication"));
  assert.ok(text.includes("source_guidance"));
  assert.ok(text.includes("check-init"));
  assert.ok(text.includes("openspec validate"));
  assert.ok(text.includes("task_matrix_ref"));
  assert.ok(text.includes("scope_drift_ref"));
  assert.ok(text.includes("kind:\"final_test\""));
  assert.ok(text.includes("kind:\"main_adjudication\""));
  assert.ok(text.includes("Review Guidance 协议"));
  assert.ok(text.includes("规格一致性"));
  assert.ok(text.includes("安全性"));
  assert.ok(text.includes("严重级别"));
  assert.ok(text.includes("CRITICAL"));
  assert.ok(text.includes("每个 evidence file 都必须包含通用 schema 字段"));
  assert.ok(text.includes("evidence_id"));
  assert.ok(text.includes("非空 `{path, blob_sha}` 列表"));
  assert.ok(text.includes("kind:\"verification_review\""));
  assert.ok(text.includes("required_load_refs"));
  assert.ok(text.includes("required_claim_ids"));
  assert.ok(text.includes("source_evidence_refs"));
  assert.ok(text.includes("loaded_refs"));
  assert.ok(text.includes("不要用 main-thread self-review"));
});

test("review prompts require Chinese-only user-visible prose outside code identifiers", () => {
  for (const name of REQUIRED_ROLES) {
    const text = templatePromptText(name);
    assert.ok(text.includes("所有用户可见输出必须使用简体中文。"), name);
    assert.equal(text.includes("All user-visible output must be Simplified Chinese."), false, name);
    assert.equal(text.includes("Do not use English section headers"), false, name);
    assert.equal(text.includes("**Good:**"), false, name);
  }
});

test("business skills use positive overlay instructions", () => {
  const combined = REQUIRED_SKILLS.map((name) => templateSkillText(name)).join("\n");
  assert.ok(combined.includes("audit-only"));
  assert.ok(combined.includes("native_subagent"));
  assert.equal(combined.includes("Do not create `.codex/hooks.json`"), false);
  assert.equal(combined.includes("Do not create or use `openspec/schemas/superspec`"), false);
  assert.equal(combined.includes("schema: superspec"), false);
});

test("skills delegate to openspec instruction engine", () => {
  const propose = templateSkillText("superspec-propose");
  const apply = templateSkillText("superspec-apply");
  const archive = templateSkillText("superspec-archive");
  assert.ok(propose.includes("openspec instructions <artifact-id>"));
  assert.ok(apply.includes("openspec instructions apply"));
  assert.ok(archive.includes("openspec archive"));
});

test("human pause points are present", () => {
  const combined = REQUIRED_SKILLS.map((name) => templateSkillText(name)).join("\n");
  for (const phrase of [
    "design option selection",
    "tasks review confirmation",
    "apply isolation",
    "execution mode",
    "修复与接受偏差",
    "final `archive_ready` confirmation",
    "scope expands",
    "branch handling",
  ]) {
    assert.ok(combined.includes(phrase), phrase);
  }
  assert.ok(combined.includes("不要使用默认值、历史偏好或沉默作为确认"));
});
