import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import test from "node:test";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

function findRepoRoot(start: string): string {
  let dir = resolve(start);
  while (true) {
    if (existsSync(join(dir, "package.json")) && existsSync(join(dir, "templates")) && existsSync(join(dir, "src"))) return dir;
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
  "executor",
  "test-runner",
  "test-engineer",
  "code-reviewer",
  "verifier",
] as const;

const OPTIONAL_HELPER_ROLES = [
  "explore",
] as const;

const PACKAGE_ROLES = [
  ...REQUIRED_ROLES,
  ...OPTIONAL_HELPER_ROLES,
] as const;

const REVIEW_ROLES = [
  "architect",
  "critic",
  "test-engineer",
  "code-reviewer",
  "verifier",
] as const;

function templateSkillText(name: string): string {
  return readFileSync(join(TEMPLATE_ROOT, "workflow", "skills", name, "SKILL.md"), "utf8");
}

function projectLocalSkillText(name: string): string {
  return readFileSync(join(REPO, ".codex", "skills", name, "SKILL.md"), "utf8");
}

function templatePromptText(name: string): string {
  return readFileSync(join(TEMPLATE_ROOT, "workflow", "prompts", `${name}.md`), "utf8");
}

function projectLocalPromptText(name: string): string {
  return readFileSync(join(REPO, ".codex", "prompts", `${name}.md`), "utf8");
}

function adapterAgentText(name: string): string {
  return readFileSync(join(ADAPTER_ROOT, "agents", `${name}.toml`), "utf8");
}

function projectLocalAgentText(name: string): string {
  return readFileSync(join(REPO, ".codex", "agents", `${name}.toml`), "utf8");
}

function templateSkillDescription(name: string): string {
  const match = /^description:\s*"([^"]+)"/mu.exec(templateSkillText(name));
  assert.ok(match, `${name} should declare a skill description`);
  return match[1];
}

function proposalDocText(relPath: string): string {
  return readFileSync(join(REPO, "docs", relPath), "utf8");
}

function repoText(relPath: string): string {
  return readFileSync(join(REPO, relPath), "utf8");
}

function superspecCommandLines(text: string): Array<{ line: string; lineNo: number }> {
  // Only real command lines (inside fenced code blocks, starting with `superspec …`)
  // count — not prose that merely mentions `superspec init` inline. File line numbers
  // are preserved because callers slice the original text by `lineNo` for context.
  const hits: Array<{ line: string; lineNo: number }> = [];
  const lines = text.split(/\r?\n/u);
  let inFence = false;
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index].trim();
    if (line.startsWith("```")) {
      inFence = !inFence;
      continue;
    }
    if (inFence && /^superspec(?:\.cmd)?\s+(?:guard|check|init)\b/u.test(line)) {
      hits.push({ line, lineNo: index + 1 });
    }
  }
  return hits;
}

function npmCommand(): string {
  return process.platform === "win32" ? "npm.cmd" : "npm";
}
	// ── Step 0: REWRITTEN_SKILLS opt-in + prose terminology detector + command parsability ──

	const REWRITTEN_SKILLS: Set<string> = new Set(["superspec-explore", "superspec-archive", "superspec-review", "superspec-propose", "superspec-apply"]);

	const PROSE_BLACKLIST = [
	  "guard", "block", "packet", "gate",
	  "native subagent", "native lane",
	  "materialize", "pinned ref",
	  "main_adjudication", "chain_activation_template",
	  "apply_execution_surface", "completion_proof_kind",
	  "pre_edit_proof_kind", "serial takeover",
	];

	const PROSE_WHITELIST = new Set([
	  "critic", "architect", "executor", "verifier",
	  "test-engineer", "test-runner", "code-reviewer",
	  "alternative_verification", "manual_verification",
	  "final_test", "test_run",
	]);

	const LEGAL_GATES = new Set([
	  "status", "init", "recompute", "openspec_preflight",
	  "project_init", "project_update", "project_uninstall",
	  "user_install", "user_update", "user_uninstall",
	  "guard_error", "preset_upgrade", "branch_handling",
	  "apply_isolation", "scope_expansion", "verify_failure_handling",
	  "explore_complete", "proposal_reviewed", "design_complete",
	  "invariants_reviewed", "test_contract_drafted", "test_contract_honored",
	  "tasks_complete", "propose_complete", "apply_ready",
	  "task_reopen", "task_edit", "task_complete",
	  "review_ready", "review_complete", "verify_complete",
	  "archive_ready", "archived",
	]);

	const TASK_GATES = new Set(["task_edit", "task_complete", "task_reopen"]);

	const PACKET_COMMANDS = [
	  "workflow-packet", "review-packet",
	  "apply-test-packet", "apply-executor-packet",
	  "apply-code-review-packet", "apply-verify-packet",
	];

	function stripFencedCodeBlocks(text: string): string {
	  return text.replace(/```[\s\S]*?```/gu, "");
	}

	function stripInlineCode(text: string): string {
	  return text.replace(/`[^`]+`/gu, "");
	}

	function extractProse(text: string): string {
	  return stripInlineCode(stripFencedCodeBlocks(text));
	}

	function extractFencedCodeBlocks(text: string): string[] {
	  const blocks: string[] = [];
	  const re = /```[\s\S]*?```/gu;
	  let match;
	  while ((match = re.exec(text)) !== null) {
	    blocks.push(match[0]);
	  }
	  return blocks;
	}

	function wordBoundaryMatch(text: string, term: string): boolean {
	  if (term.includes(" ")) return text.includes(term);
	  const escaped = term.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
	  return new RegExp(`\\b${escaped}\\b`, "u").test(text);
	}

	function assertSkillProseTerminology(name: string, text: string): void {
	  if (!REWRITTEN_SKILLS.has(name)) return;
	  const prose = extractProse(text);
	  for (const term of PROSE_BLACKLIST) {
	    if (PROSE_WHITELIST.has(term)) continue;
	    assert.equal(
	      wordBoundaryMatch(prose, term),
	      false,
	      `${name}: prose must not contain "${term}"`,
	    );
	  }
	  // soft-check: gate / block / packet as isolated CJK-adjacent tokens
	  for (const soft of ["gate", "block", "packet"]) {
	    if (new RegExp(`[\\u4e00-\\u9fff]${soft}`, "u").test(prose)) {
	      assert.fail(`${name}: prose contains CJK-adjacent "${soft}" (likely unguarded internal term)`);
	    }
	  }
	}

	function assertSkillCommandParsability(name: string, text: string): void {
	  if (!REWRITTEN_SKILLS.has(name)) return;
	  const blocks = extractFencedCodeBlocks(text);
	  for (const block of blocks) {
	    const lines = block.split(/\r?\n/u);
	    for (const rawLine of lines) {
	      const line = rawLine.trim();
	      if (!line || line.startsWith("```")) continue;
	      const hasPacketCmd = PACKET_COMMANDS.some((cmd) => line.includes(cmd));
	      if (!hasPacketCmd) continue;
	      assert.match(
	        line,
	        /^superspec\s+check\s+/u,
	        `${name}: packet command line must start with "superspec check": ${line}`,
	      );
	      if (line.includes("workflow-packet")) {
	        const gateMatch = line.match(/--gate\s+(\S+)/u);
	        if (gateMatch) {
	          const gate = gateMatch[1];
	          assert.ok(
	            LEGAL_GATES.has(gate),
	            `${name}: workflow-packet --gate "${gate}" is not a legal gate`,
	          );
	          if (TASK_GATES.has(gate)) {
	            assert.match(
	              line,
	              /--task-id\s+\S+/u,
	              `${name}: workflow-packet --gate ${gate} must include --task-id`,
	            );
	          }
	        }
	      }
	      if (line.includes("check review-packet ")) {
	        assert.match(
	          line,
	          /--round\s+\d+/u,
	          `${name}: review-packet must include --round: ${line}`,
	        );
	      }
	    }
	  }
	}

test("superspec package declares workflow payload surface", () => {
  const pkg = JSON.parse(repoText("package.json"));
  assert.equal(pkg.name, "@peterxiaoyang/superspec");
  assert.equal(pkg.private, false);
  assert.equal(pkg.type, "module");
  assert.equal(pkg.engines.node, ">=20.19.0");
  assert.equal(pkg.bin.superspec, "bin/superspec.js");
  assert.equal(pkg.bin["superspec-check"], "bin/superspec-check.js");
  assert.equal(pkg.bin["superspec-hook"], "bin/superspec-hook.js");
  assert.equal(pkg.bin["superspec-init"], "bin/superspec-init.js");
  assert.equal(pkg.exports["."].default, "./dist/superspec.js");
  assert.equal(pkg.exports["./superspec_guard"].default, "./dist/superspec_guard.js");
  assert.equal(pkg.exports["./superspec_hook"].default, "./dist/superspec_hook.js");
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
  assert.equal(pkg.files.includes(".codex-plugin"), false);
  assert.equal(pkg.files.includes("skills"), false);
  const lock = JSON.parse(repoText("package-lock.json"));
  assert.deepEqual(lock.packages[""].bin, pkg.bin);
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
  assert.equal(proc.stdout.trim(), "22");
});

test("compiled superspec hook bin initializes core runtime", () => {
  const build = spawnSync(npmCommand(), ["run", "build"], { cwd: REPO, encoding: "utf8" });
  assert.equal(build.status, 0, build.stderr || build.stdout);
  const event = JSON.stringify({
    hook_event_name: "PreToolUse",
    tool_name: "Bash",
    cwd: REPO,
    tool_input: { command: "echo ok" },
  });
  const inert = spawnSync(process.execPath, ["bin/superspec-hook.js"], {
    cwd: REPO,
    input: event,
    encoding: "utf8",
  });
  assert.equal(inert.status, 0, inert.stderr || inert.stdout);
  assert.match(inert.stdout, /SuperSpec hook inert/u);

  const guarded = spawnSync(process.execPath, ["bin/superspec-hook.js", "--change", "demo-change"], {
    cwd: REPO,
    input: event,
    encoding: "utf8",
  });
  assert.doesNotMatch(guarded.stderr, /runtime\.load_context/u);
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
  for (const name of PACKAGE_ROLES) {
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
  assert.ok(mappings.includes("prompt:templates/workflow/prompts/explore.md->.codex/prompts/explore.md"));
  assert.ok(mappings.includes("prompt:templates/workflow/prompts/executor.md->.codex/prompts/executor.md"));
  assert.ok(mappings.includes("prompt:templates/workflow/prompts/test-runner.md->.codex/prompts/test-runner.md"));
  assert.ok(mappings.includes("agent:adapters/codex/agents/critic.toml->.codex/agents/critic.toml"));
  assert.ok(mappings.includes("agent:adapters/codex/agents/explore.toml->.codex/agents/explore.toml"));
  assert.ok(mappings.includes("agent:adapters/codex/agents/executor.toml->.codex/agents/executor.toml"));
  assert.ok(mappings.includes("agent:adapters/codex/agents/test-runner.toml->.codex/agents/test-runner.toml"));
  assert.ok(mappings.includes("hook:templates/hooks/codex-hooks.json->.codex/hooks.json"));
  assert.equal(mappings.some((item: string) => item.startsWith("wrapper:")), false);
  for (const item of installMap.mappings) {
    assert.equal(existsSync(join(PACKAGE_ROOT, item.source)), true, item.source);
  }
});

test("apply worker chain lifecycle uses one shared runtime source", () => {
  const packetRender = repoText("src/packet_render.ts");
  const lifecycle = repoText("src/apply_worker_chain_lifecycle.ts");

  assert.equal(packetRender.includes("function terminal_apply_worker_chain_valid"), false);
  assert.equal(packetRender.includes("terminal_apply_worker_chain_valid("), false);
  assert.match(packetRender, /apply_worker_chain_lifecycle_state/u);
  assert.doesNotMatch(lifecycle, /from "\.\/(?:gates|packet_render|core)\.ts"/u);
});

test("runtime import graph keeps apply worker chain lifecycle acyclic", () => {
  const files = [
    "src/apply_worker_chain_lifecycle.ts",
    "src/apply_worker_chain.ts",
    "src/evidence.ts",
    "src/tasks.ts",
    "src/gates.ts",
    "src/packet_render.ts",
    "src/core.ts",
  ];
  const fileSet = new Set(files);
  const graph = new Map<string, string[]>();
  for (const file of files) {
    const text = repoText(file);
    const imports = [...text.matchAll(/(?:import|export)\s+(?:type\s+)?(?:[^"']*?\s+from\s+)?["'](\.\/[^"']+)["']/gu)]
      .map((match) => `src/${match[1].replace(/^\.\//u, "")}`)
      .filter((target) => fileSet.has(target));
    graph.set(file, imports);
  }
  const visiting = new Set<string>();
  const visited = new Set<string>();
  const stack: string[] = [];
  const visit = (file: string): void => {
    if (visited.has(file)) return;
    if (visiting.has(file)) {
      const cycle = [...stack.slice(stack.indexOf(file)), file].join(" -> ");
      assert.fail(`runtime import cycle detected: ${cycle}`);
    }
    visiting.add(file);
    stack.push(file);
    for (const next of graph.get(file) ?? []) visit(next);
    stack.pop();
    visiting.delete(file);
    visited.add(file);
  };
  for (const file of files) visit(file);
});

test("apply worker chain lifecycle reasons remain exported from package guard entrypoint", async () => {
  const guard = await import("../superspec_guard.ts");
  assert.equal(typeof guard.apply_worker_chain_lifecycle_reasons, "function");
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

test("visible superspec skill set matches required skills", () => {
  const actual = readdirSync(join(TEMPLATE_ROOT, "workflow", "skills")).filter((name) => name.startsWith("superspec-")).sort();
  assert.deepEqual(actual, [...REQUIRED_SKILLS].sort());
});

test("superspec distribution files are not gitignored", () => {
  const checked = [
    "package.json",
    "bin/launch.js",
    "bin/superspec.js",
    "bin/superspec-check.js",
    "bin/superspec-init.js",
    "build.js",
    "src/core.ts",
    "tests/test_superspec_guard.test.ts",
    "templates/workflow/skills/superspec-review/SKILL.md",
    "templates/workflow/prompts/critic.md",
    "templates/workflow/prompts/executor.md",
    "templates/workflow/prompts/test-runner.md",
    "adapters/codex/agents/critic.toml",
    "adapters/codex/agents/executor.toml",
    "adapters/codex/agents/test-runner.toml",
    "adapters/codex/install-map.json",
    "templates/sidecar/test-contract.md",
    "schemas/install-manifest.schema.json",
    "superspec.ts",
    "tsconfig.build.json",
    "openspec/changes/demo/proposal.md",
    "openspec/changes/demo/design.md",
    "openspec/changes/demo/tasks.md",
    "openspec/changes/demo/specs/example/spec.md",
    "openspec/specs/example/spec.md",
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
    assert.ok(text.includes(" check "), name);
    assert.equal(text.includes("SUPERSPEC_CLI"), false, name);
    assert.equal(text.includes("./node_modules/.bin/superspec-guard"), false, name);
    assert.equal(text.includes("SUPERSPEC_GUARD"), false, name);
    assert.equal(text.includes("${SUPERSPEC_GUARD:-./scripts/superspec_guard}"), false, name);
    assert.equal(text.includes("${"), false, name);
    assert.equal(text.includes("test -f "), false, name);
    assert.equal(text.includes("```bash"), false, name);
    assert.ok(text.includes("## 语言规则 / Language"), name);
    assert.ok(text.includes("## 命令执行 / Shell"), name);
    assert.ok(text.includes("superspec.cmd"), name);
    assert.ok(text.includes("openspec.cmd"), name);
    assert.ok(text.includes("superspec.ps1"), name);
    assert.ok(text.includes("默认使用简体中文"), name);
    assert.ok(text.includes("不把内部证据种类"), name);
  }
  assert.ok(templateSkillText("superspec-explore").includes("init --scope project"));
  assert.equal(templateSkillText("superspec-explore").includes("SUPERSPEC_INIT"), false);
});

test("workflow skills use safe agent output for ordinary superspec commands", () => {
  for (const name of REQUIRED_SKILLS) {
    const text = templateSkillText(name);
    const lines = superspecCommandLines(text);
    assert.ok(lines.length > 0, name);
    for (const { line, lineNo } of lines) {
      if (line.includes("--format json")) {
        const nearby = text.split(/\r?\n/u).slice(Math.max(0, lineNo - 4), lineNo + 3).join("\n");
        assert.match(nearby, /诊断|debug|debugging/u, `${name}:${lineNo} json output must be explicitly diagnostic`);
        continue;
      }
      if (line.includes("review-packet") && line.includes("--format prompt")) continue;
      if (line.includes("apply-test-packet") && line.includes("--format prompt")) continue;
      if (line.includes("apply-executor-packet") && line.includes("--format prompt")) continue;
      if (line.includes("apply-code-review-packet") && line.includes("--format prompt")) continue;
      if (line.includes("apply-verify-packet") && line.includes("--format prompt")) continue;
      if (/\b(?:recompute|status|hook-health|check-init|check-review-ready|check-review-complete|check-archive-ready|check-archived)\b/u.test(line)) continue;
      assert.match(line, /--format agent\b/u, `${name}:${lineNo} must use --format agent or review-packet prompt: ${line}`);
    }
    assert.ok(text.includes("普通 workflow 命令使用 `--format agent`"), name);
    assert.ok(text.includes("`--format json` 只用于诊断"), name);
  }
});

test("workflow skill descriptions are user-facing Chinese, not bilingual protocol summaries", () => {
  const expectedDescriptions: Record<(typeof REQUIRED_SKILLS)[number], string> = {
    "superspec-explore": "1.新需求刚开始时用：先把目标、范围、风险和现有代码事实弄清楚，产出探索记录（`discovery.md`）；这一步只探索，不写正式方案，也不改代码。",
    "superspec-propose": "2.需求已经清楚后用：把探索记录（`discovery.md`）整理成正式方案包，包括方案说明（`proposal.md`）、需求规格（`specs/**`）、设计说明（`design.md`）、任务清单（`tasks.md`）、测试契约和业务约束；这一步只定方案，不写实现。",
    "superspec-apply": "3.方案通过后用：按 tasks 一项项写代码、跑测试、记录证据；每个任务都要先证明测试会失败，再实现到测试通过。",
    "superspec-review": "4.代码任务做完后用：让 reviewer、architect 和 critic 检查实现，跑最终验证，判断能不能进入归档；有问题就退回修。",
    "superspec-archive": "5.所有审查和验证通过后用：把完成的 change 归档到 specs，并确认关键证据和历史没有丢失；这一步是流程收尾。",
  };
  for (const name of REQUIRED_SKILLS) {
    const description = templateSkillDescription(name);
    assert.equal(description, expectedDescriptions[name], name);
    assert.equal(description.includes(" / "), false, name);
    assert.doesNotMatch(description, /\b(Produce|Explore|Apply|Archive|review phase|guard checks|gates)\b/u, name);
  }
});

test("workflow skills declare short SuperSpec source metadata", () => {
  for (const name of REQUIRED_SKILLS) {
    const text = templateSkillText(name);
    assert.match(text, /^metadata:\n  author: SuperSpec\n  source: SuperSpec\n---/mu, name);
    assert.doesNotMatch(text.slice(0, text.indexOf("---", 4)), /github|https?:|peteryaoyang-superspec/iu, name);
  }
});

test("project-local superspec skills mirror packaged workflow templates", () => {
  if (!existsSync(join(REPO, ".codex", "skills"))) return;
  const installedSuperspecSkills = REQUIRED_SKILLS
    .map((name) => join(REPO, ".codex", "skills", name, "SKILL.md"))
    .filter((path) => existsSync(path));
  if (installedSuperspecSkills.length === 0) return;
  for (const name of REQUIRED_SKILLS) {
    assert.equal(projectLocalSkillText(name), templateSkillText(name), name);
  }
});

test("project-local role prompts and agents mirror packaged templates", () => {
  if (!existsSync(join(REPO, ".codex", "prompts")) || !existsSync(join(REPO, ".codex", "agents"))) return;
  for (const name of REQUIRED_ROLES) {
    assert.equal(projectLocalPromptText(name), templatePromptText(name), name);
    assert.equal(projectLocalAgentText(name), adapterAgentText(name), name);
  }
  for (const name of OPTIONAL_HELPER_ROLES) {
    const promptInstalled = existsSync(join(REPO, ".codex", "prompts", `${name}.md`));
    const agentInstalled = existsSync(join(REPO, ".codex", "agents", `${name}.toml`));
    assert.equal(promptInstalled, agentInstalled, `${name} helper prompt/agent should be installed together`);
    if (!promptInstalled) continue;
    assert.equal(projectLocalPromptText(name), templatePromptText(name), name);
    assert.equal(projectLocalAgentText(name), adapterAgentText(name), name);
  }
});

test("skills avoid high-risk internal protocol names in user-facing step prose", () => {
  const forbiddenPatterns: RegExp[] = [
    /等待\s+`user_review_decision`/u,
    /拿到\s+`user_review_decision`/u,
    /写本轮\s+`main_review_digest`/u,
    /主流程记录\s+`main_review_digest`/u,
  ];
  for (const name of REQUIRED_SKILLS) {
    const text = templateSkillText(name);
    for (const pattern of forbiddenPatterns) {
      assert.equal(pattern.test(text), false, `${name} leaks ${pattern}`);
    }
  }
});

test("workflow skills constrain confusing user-visible decision wording", () => {
  const wordingRule = "用户可见文案不得使用“裁决”描述用户动作";
  for (const name of REQUIRED_SKILLS) {
    const text = templateSkillText(name);
    assert.ok(text.includes(wordingRule), name);
    assert.ok(text.includes("统一说“确认”“范围取舍”“处理方式选择”或“用户确认记录”"), name);

    const unexpected = text
      .split(/\r?\n/u)
      .map((line, index) => ({ line, index: index + 1 }))
      .filter(({ line }) => line.includes("裁决") && !line.includes(wordingRule));
    assert.deepEqual(unexpected, [], `${name} should not use 裁决 outside the wording rule`);
  }
});

test("workflow skills are thin packet-driven entrypoints", () => {
  const maxChars: Record<(typeof REQUIRED_SKILLS)[number], number> = {
    "superspec-explore": 4200,
    "superspec-propose": 5200,
    "superspec-apply": 5900,
    "superspec-review": 5200,
    "superspec-archive": 3600,
  };
  for (const name of REQUIRED_SKILLS) {
    const text = templateSkillText(name);
    assert.ok(text.length <= maxChars[name], `${name} should stay thin: ${text.length}`);
    assert.ok(text.includes("## 阶段职责"), name);
    assert.ok(text.includes("## 第一条必跑命令"), name);
    assert.equal(text.includes("## 证据契约"), false, name);
    assert.equal(text.includes("### 严重级别"), false, name);
    assert.equal(text.includes("每个 evidence file 都必须包含通用 schema 字段"), false, name);
  }
  assert.ok(templateSkillText("superspec-propose").includes("review-packet --format prompt"));
  assert.ok(templateSkillText("superspec-review").includes("review-packet --change"));
  assert.ok(templateSkillText("superspec-archive").includes("workflow-packet --change"));
});

test("propose owns openspec package and sidecar gates as wrapper anchors", () => {
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
    "review-packet --role main-thread",
    "用户确认",
    "propose.invariants_reviewed",
    "propose.design_reviewed",
    "propose.test_plan_drafted",
    "propose.tasks_mapped",
    "apply_ready",
  ]) {
    assert.ok(text.includes(phrase), phrase);
  }
});

test("explore uses OpenSpec CLI surfaces directly", () => {
  const text = templateSkillText("superspec-explore");
  assert.equal(text.includes(".codex/skills/openspec-explore/SKILL.md"), false);
  assert.ok(text.includes("直接使用 OpenSpec CLI surface"));
  assert.ok(text.includes("openspec list --json"));
  assert.ok(text.includes("openspec new change"));
  assert.ok(text.includes("仅当 `openspec list --json` 没有匹配 change 时运行"));
  assert.ok(text.includes("不要先跑 `openspec --help`"));
  assert.ok(text.includes("openspec status --change"));
  assert.ok(text.includes("superspec-propose"));
  assert.ok(text.includes("不写 `proposal.md`"));
  assert.ok(text.includes(".codex/agents/explore.toml"));
  assert.ok(text.includes("不能替代 `critic` 审查证据"));
});

test("propose uses OpenSpec instructions CLI directly", () => {
  const text = templateSkillText("superspec-propose");
  assert.equal(text.includes(".codex/skills/openspec-propose/SKILL.md"), false);
  assert.ok(text.includes("直接使用 OpenSpec CLI surface"));
  assert.ok(text.includes("artifact 顺序"));
  assert.ok(text.includes("openspec instructions <artifact-id>"));
  assert.ok(text.includes("不要手写绕过"));
});

test("apply uses OpenSpec apply instructions CLI directly", () => {
  const text = templateSkillText("superspec-apply");
  assert.equal(text.includes(".codex/skills/openspec-apply-change/SKILL.md"), false);
  assert.ok(text.includes("直接使用 OpenSpec CLI surface"));
  assert.ok(text.includes("contextFiles"));
  assert.ok(text.includes("progress"));
  assert.ok(text.includes("dynamic instruction"));
  assert.ok(text.includes("RED/GREEN"));
});

test("apply delegates implementation edits to repo-local executor", () => {
  const text = templateSkillText("superspec-apply");
  assert.ok(text.includes(".codex/agents/executor.toml"));
  assert.ok(text.includes(".codex/prompts/executor.md"));
  assert.ok(text.includes(".codex/agents/test-runner.toml"));
  assert.ok(text.includes(".codex/prompts/test-runner.md"));
  assert.ok(text.includes("apply-executor-packet"));
});

test("apply execution surface is documented in SPEC and test-engineer prompt", () => {
  const spec = repoText("docs/SPEC.md");
  assert.ok(spec.includes("`apply_execution_surface` 枚举"));
  assert.ok(spec.includes("`implementation` / `runtime_config` / `docs_generated` / `no_code`"));
  assert.ok(spec.includes("缺省且 `write_scope` 非空时视为 `implementation`"));
  assert.ok(spec.includes("缺省且 `write_scope` 为空时视为 `no_code`"));
  assert.ok(spec.includes("RED/characterization/GREEN 由 repo-local `test-runner` worker 产生"));
  assert.ok(spec.includes("implementation/runtime_config 由 repo-local `executor` worker chain 产生"));
  assert.ok(spec.includes("bounded `test-engineer` lane"));
  assert.ok(spec.includes("completion_proof_kind:\"alternative_verification\""));
  assert.ok(spec.includes("pre_edit_proof_kind:\"no_tdd_declared\""));

  const testEngineer = templatePromptText("test-engineer");
  assert.ok(testEngineer.includes("新增或修改 RED/characterization 测试文件"));
  assert.ok(testEngineer.includes("bounded native lane"));
  assert.ok(testEngineer.includes("正式 RED/characterization/GREEN 运行证据仍由 test-runner packet 生成"));
});

test("test-runner prompt forbids main-thread formal test evidence", () => {
  const text = templatePromptText("test-runner");
  assert.ok(text.includes("只有 test-runner worker 运行结果可以成为正式 RED/characterization/GREEN candidate"));
  assert.ok(text.includes("不要让主线程代跑或伪造正式 evidence"));
});

test("verifier prompt documents no-TDD alternative worker-chain proof", () => {
  const text = templatePromptText("verifier");
  assert.ok(text.includes("alternative_verification_evidence_refs"));
  assert.ok(text.includes("active chain no-TDD metadata"));
});

test("apply guidance documents generic framework-agnostic test evidence semantics", () => {
  const GENERIC_TEST_EVIDENCE_PHRASES = [
    "target test identity executed",
    "command exit code alone is not proof",
    "blocked before the target test runner",
    "do not classify environment/build failures as RED or GREEN",
  ];
  const MAVEN_JUNIT_TOKENS = [
    "mvn test",
    "mvn -pl",
    "-Dtest",
    "-DfailIfNoTests",
    "-Dsurefire.failIfNoSpecifiedTests",
    "endPosTable",
    "Surefire",
    "JUnit",
  ];
  const targets = [
    { label: "apply skill", text: templateSkillText("superspec-apply") },
    { label: "test-runner prompt", text: templatePromptText("test-runner") },
    { label: "sidecar test-contract", text: repoText("templates/sidecar/test-contract.md") },
    { label: "SPEC", text: repoText("docs/SPEC.md") },
  ];
  for (const target of targets) {
    for (const phrase of GENERIC_TEST_EVIDENCE_PHRASES) {
      assert.ok(target.text.includes(phrase), `${target.label} missing phrase: ${phrase}`);
    }
    for (const token of MAVEN_JUNIT_TOKENS) {
      assert.equal(target.text.includes(token), false, `${target.label} must not contain Maven/JUnit token: ${token}`);
    }
  }
});

test("archive documents native archive handoff", () => {
  const text = templateSkillText("superspec-archive");
  assert.equal(text.includes(".codex/skills/openspec-archive-change/SKILL.md"), false);
  assert.ok(text.includes("直接使用 OpenSpec CLI surface"));
  assert.ok(text.includes("native OpenSpec CLI"));
  assert.ok(text.includes("SuperSpec 不重新实现移动、spec sync 或 validation"));
  assert.ok(text.includes("openspec archive -y"));
  assert.ok(text.includes("--no-validate"));
  assert.ok(text.includes(".superspec/artifacts/business-invariants.md"));
  assert.ok(text.includes("test-contract.md"));
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
  assert.ok(text.includes("check-init"));
  assert.ok(text.includes("openspec validate"));
});

test("review prompts require Chinese-only user-visible prose outside code identifiers", () => {
  for (const name of PACKAGE_ROLES) {
    const text = templatePromptText(name);
    assert.ok(text.includes("所有用户可见输出必须使用简体中文。"), name);
    assert.equal(text.includes("All user-visible output must be Simplified Chinese."), false, name);
    assert.equal(text.includes("Do not use English section headers"), false, name);
    assert.equal(text.includes("**Good:**"), false, name);
  }
});

test("role prompts are thin packet-driven review surfaces", () => {
  for (const name of REVIEW_ROLES) {
    const text = templatePromptText(name);
    assert.ok(text.length <= 1800, `${name} prompt should stay thin: ${text.length}`);
    assert.ok(text.includes("## 角色身份"), name);
    assert.ok(text.includes("## 读写边界"), name);
    assert.ok(text.includes("## SuperSpec Packet 规则"), name);
    assert.ok(text.includes("## 输出风格"), name);
    assert.ok(text.includes("`review-packet`"), name);
    assert.ok(text.includes("`prompt_ref`"), name);
    assert.ok(text.includes("`required_output_kind`"), name);
    assert.ok(text.includes("`output_contract_fields`"), name);
    assert.ok(text.includes("不要依赖本 prompt 记忆输出 schema"), name);
    assert.equal(text.includes("<output_contract>"), false, name);
    assert.equal(text.includes("<execution_loop>"), false, name);
    assert.equal(text.includes("## 结论摘要"), false, name);
    assert.equal(text.includes("Code Review Summary"), false, name);
  }
});

test("executor prompt is a thin packet-driven apply implementation surface", () => {
  const text = templatePromptText("executor");
  assert.ok(text.length <= 1800, `executor prompt should stay thin: ${text.length}`);
  assert.ok(text.includes("## 角色身份"));
  assert.ok(text.includes("## 读写边界"));
  assert.ok(text.includes("## SuperSpec Packet 规则"));
  assert.ok(text.includes("## 输出风格"));
  assert.ok(text.includes("`apply-executor-packet`"));
  assert.ok(text.includes("`prompt_ref`"));
  assert.ok(text.includes("`declared_task_write_scope`"));
  assert.ok(text.includes("`guard_fingerprint`"));
  assert.ok(text.includes("不要修改 `proposal.md`/`design.md`/`tasks.md`/`specs/**`/`.superspec/**`"));
  assert.ok(text.includes("不要依赖本 prompt 记忆输出 schema"));
  assert.equal(text.includes("`review-packet`"), false);
  assert.equal(text.includes("`required_output_kind`"), false);
  assert.equal(text.includes("`output_contract_fields`"), false);
  assert.equal(text.includes("<output_contract>"), false);
  assert.equal(text.includes("<execution_loop>"), false);
});

test("explore prompt is a thin packet-driven discovery surface", () => {
  const text = templatePromptText("explore");
  assert.ok(text.length <= 1800, `explore prompt should stay thin: ${text.length}`);
  assert.ok(text.includes("## 角色身份"));
  assert.ok(text.includes("## 读写边界"));
  assert.ok(text.includes("## SuperSpec Packet 规则"));
  assert.ok(text.includes("## 输出风格"));
  assert.ok(text.includes("`workflow-packet`"));
  assert.ok(text.includes("`prompt_ref`"));
  assert.ok(text.includes("不要依赖本 prompt 记忆输出 schema"));
  assert.equal(text.includes("`review-packet`"), false);
  assert.equal(text.includes("`required_output_kind`"), false);
  assert.equal(text.includes("`output_contract_fields`"), false);
  assert.equal(text.includes("<output_contract>"), false);
  assert.equal(text.includes("<execution_loop>"), false);
});

test("test-runner prompt is a thin packet-driven apply test surface", () => {
  const text = templatePromptText("test-runner");
  assert.ok(text.length <= 3200, `test-runner prompt should stay bounded: ${text.length}`);
  assert.ok(text.includes("## 角色身份"));
  assert.ok(text.includes("## 读写边界"));
  assert.ok(text.includes("## SuperSpec Packet 规则"));
  assert.ok(text.includes("## 输出风格"));
  assert.ok(text.includes("`apply-test-packet`"));
  assert.ok(text.includes("`prompt_ref`"));
  assert.ok(text.includes("不要凭本 prompt 记忆或发明字段名"));
  assert.equal(text.includes("`review-packet`"), false);
  assert.equal(text.includes("`required_output_kind`"), false);
  assert.equal(text.includes("`output_contract_fields`"), false);
  assert.equal(text.includes("<output_contract>"), false);
  assert.equal(text.includes("<execution_loop>"), false);
});

test("role agent toml files are thin prompt-bound entrypoints", () => {
  for (const name of PACKAGE_ROLES) {
    const text = adapterAgentText(name);
    assert.ok(text.length <= 1200, `${name} agent should stay thin: ${text.length}`);
    assert.ok(text.includes(`name = "${name}"`), name);
    assert.ok(text.includes("Prompt binding:"), name);
    assert.ok(text.includes(`.codex/prompts/${name}.md`), name);
    if (name === "executor") assert.ok(text.includes("`apply-executor-packet`"), name);
    else if (name === "test-runner") assert.ok(text.includes("`apply-test-packet`"), name);
    else if (name === "explore") assert.ok(text.includes("`workflow-packet`"), name);
    else assert.ok(text.includes("`review-packet`"), name);
    assert.ok(text.includes("`prompt_ref`"), name);
    assert.ok(text.includes("Boundary:"), name);
    assert.ok(text.includes("Output:"), name);
    assert.equal(text.includes("<output_contract>"), false, name);
    assert.equal(text.includes("<execution_loop>"), false, name);
    assert.equal(text.includes("<posture_overlay>"), false, name);
    assert.equal(text.includes("OMX Agent Metadata"), false, name);
    assert.equal(text.includes("native_subagent_leaf_guard"), false, name);
  }
});

test("business skills use positive overlay instructions", () => {
  const combined = REQUIRED_SKILLS.map((name) => templateSkillText(name)).join("\n");
  assert.equal(combined.includes("Do not create `.codex/hooks.json`"), false);
  assert.equal(combined.includes("Do not create or use `openspec/schemas/superspec`"), false);
  assert.equal(combined.includes("schema: superspec"), false);
  assert.equal(combined.includes("hook-session-begin"), false);
  assert.equal(combined.includes("hook-session-status"), false);
  assert.equal(combined.includes("hook-session-end"), false);
});

test("skills delegate to openspec instruction engine", () => {
  const propose = templateSkillText("superspec-propose");
  const apply = templateSkillText("superspec-apply");
  const archive = templateSkillText("superspec-archive");
  assert.ok(propose.includes("openspec instructions <artifact-id>"));
  assert.ok(apply.includes("openspec instructions apply"));
  assert.ok(archive.includes("openspec archive"));
});

test("phase-2 migrated hard protocol lockpoints to guard tests", () => {
  const guardTests = readdirSync(join(REPO, "tests"))
    .filter((name) => /^test_superspec_guard.*\.test\.ts$/u.test(name))
    .sort()
    .map((name) => repoText(`tests/${name}`))
    .join("\n");
  for (const phrase of [
    "review-packet serves main-thread digest and adjudication contracts with exact required refs",
    "review-packet fails closed when review evidence contract is stale",
    "review-packet prompt and ledger-render share the deterministic round>1 ledger block",
    "packet commands are strictly read-only and do not touch state, ledger, or preservation artifacts",
    "main adjudication requires canonical main-thread author boundary",
    "main adjudication request_changes requires route",
    "review complete blocks request_changes and hands off to apply",
    "DISC main_review_digest schema is fail-closed",
    "DISC user_review_decision schema is fail-closed",
    "DISC material terminal dispositions require a binding user decision",
  ]) {
    assert.ok(guardTests.includes(phrase), phrase);
  }
});

test("human pause points are present", () => {
  const combined = REQUIRED_SKILLS.map((name) => templateSkillText(name)).join("\n");
  for (const phrase of [
    "探索结论、范围边界和进入 propose 的授权",
    "设计选项选择",
    "任务审查确认",
    "apply isolation 和 execution mode",
    "`archive_ready` 最终确认",
    "scope expands",
    "分支状态",
  ]) {
    assert.ok(combined.includes(phrase), phrase);
  }
  assert.ok(combined.includes("不要使用默认值、历史偏好或沉默作为确认"));
});

test("REWRITTEN_SKILLS prose detector and command parsability harness (opt-in, activates per-skill on rewrite)", () => {
  for (const name of REQUIRED_SKILLS) {
    const text = templateSkillText(name);
    assertSkillProseTerminology(name, text);
    assertSkillCommandParsability(name, text);
  }
});
