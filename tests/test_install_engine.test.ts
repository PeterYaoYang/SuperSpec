// Manifest-driven install/update/uninstall engine tests (audit G-1, Phase 5 decision D4).
// Engine invariants under test: install-map is the only install source, the manifest is the only
// removal/update authority, manifest sha256 is the managed baseline, and user-modified /
// preexisting files plus .superspec runtime data are never overwritten or deleted.
import assert from "node:assert/strict";
import test from "node:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import * as guard from "../superspec_guard.ts";
import { main_init } from "../src/init_cli.ts";

function writeText(path: string, text: string): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, text, "utf8");
}

type EngineFixture = { packageRoot: string; repo: string; cleanup: () => void };

// A miniature package root the test fully controls, so template "upgrades" can be simulated
// without touching the real adapters/templates.
function createEngineFixture(): EngineFixture {
  const tmp = mkdtempSync(join(tmpdir(), "superspec-install-"));
  const packageRoot = join(tmp, "pkg");
  const repo = join(tmp, "repo");
  mkdirSync(repo, { recursive: true });
  writeText(join(packageRoot, "package.json"), JSON.stringify({ name: "superspec-test", version: "9.9.9" }));
  writeText(join(packageRoot, "templates", "skill.md"), "---\nname: superspec-demo\n---\nv1\n");
  writeText(join(packageRoot, "wrappers", "superspec_demo"), "#!/bin/sh\necho v1\n");
  writeText(join(packageRoot, "adapters", "codex", "install-map.json"), JSON.stringify({
    adapter: "codex",
    version: 1,
    mappings: [
      { kind: "skill", source: "templates/skill.md", target: ".codex/skills/superspec-demo/SKILL.md" },
      { kind: "wrapper", source: "wrappers/superspec_demo", target: "scripts/superspec_demo" },
    ],
  }));
  return { packageRoot, repo, cleanup: () => rmSync(tmp, { recursive: true, force: true }) };
}

const SKILL_TARGET = ".codex/skills/superspec-demo/SKILL.md";
const USER_SKILL_TARGET = "skills/superspec-demo/SKILL.md";
const WRAPPER_TARGET = "scripts/superspec_demo";

test("real install map loads and every source file exists", () => {
  const { mappings, problems } = guard.load_install_map();
  assert.deepEqual(problems, []);
  assert.equal(mappings.length, 15, `expected 5 skills, 5 prompts, and 5 agents, got ${mappings.length}`);
  const targets = mappings.map((item) => item.target);
  for (const name of guard.REQUIRED_SUPERSPEC_WORKFLOW_SKILLS) {
    assert.ok(targets.includes(`.codex/skills/${name}/SKILL.md`), name);
  }
});

test("command lookup is platform-aware and does not use sh on Windows", () => {
  const win = guard.commandLookupInvocation("openspec", "win32");
  assert.equal(win.cmd, "where.exe");
  assert.deepEqual(win.args, ["openspec"]);
  assert.equal(win.shell, false);

  const unix = guard.commandLookupInvocation("openspec", "linux");
  assert.equal(unix.cmd, "sh");
  assert.deepEqual(unix.args, ["-c", "command -v openspec"]);
});

test("windows cmd shim invocation escapes shell metacharacters per argument", () => {
  const invocation = guard.windowsCmdShimInvocation("C:\\Program Files\\nodejs\\openspec.cmd", [
    "demo change",
    "x&y",
    "pipe|value",
    "out>file",
    "quote\" & calc & \"value",
  ]);
  assert.equal(invocation.cmd, "cmd.exe");
  assert.deepEqual(invocation.args.slice(0, 3), ["/d", "/s", "/c"]);
  const commandLine = invocation.args[3];
  assert.match(commandLine, /Program\^ Files/);
  assert.match(commandLine, /x\^&y/);
  assert.match(commandLine, /pipe\^\|value/);
  assert.match(commandLine, /out\^>file/);
  assert.match(commandLine, /quote/);
  for (let idx = commandLine.indexOf('"'); idx !== -1; idx = commandLine.indexOf('"', idx + 1)) {
    assert.equal(commandLine[idx - 1], "^", `raw quote at index ${idx}: ${commandLine}`);
  }
  assert.doesNotMatch(commandLine, / x&y /);
  assert.doesNotMatch(commandLine, / pipe\|value /);
  assert.doesNotMatch(commandLine, / out>file /);
  assert.doesNotMatch(commandLine, / & calc & /);
});

test("fresh install copies files, sets wrapper exec bit, and writes a schema-valid manifest", () => {
  const fx = createEngineFixture();
  try {
    const result = guard.install_workflow(fx.repo, { packageRoot: fx.packageRoot });
    assert.deepEqual(result.problems, []);
    assert.equal(readFileSync(join(fx.repo, SKILL_TARGET), "utf8").includes("v1"), true);
    assert.ok(statSync(join(fx.repo, WRAPPER_TARGET)).mode & 0o100, "wrapper must be executable");
    const { manifest, problems } = guard.read_install_manifest(fx.repo);
    assert.deepEqual(problems, []);
    assert.ok(manifest);
    assert.deepEqual(guard.manifest_shape_problems(manifest), []);
    assert.equal(manifest.superspecVersion, "9.9.9");
    assert.equal(manifest.files.length, 2);
    assert.ok(manifest.files.every((entry: any) => entry.managed === true && entry.preexisting === false));
    assert.ok(manifest.createdDirs.includes(".codex/skills/superspec-demo"), JSON.stringify(manifest.createdDirs));
    // Idempotent re-install: everything already matches, nothing is rewritten as "created".
    const again = guard.install_workflow(fx.repo, { packageRoot: fx.packageRoot });
    assert.deepEqual(again.problems, []);
    assert.ok(again.actions.every((item) => item.status === "ok"), JSON.stringify(again.actions));
  } finally {
    fx.cleanup();
  }
});

test("user-scope install targets Codex home surfaces and skips project wrappers", () => {
  const fx = createEngineFixture();
  try {
    const result = guard.install_workflow(fx.repo, { packageRoot: fx.packageRoot, scope: "user" });
    assert.deepEqual(result.problems, []);
    assert.equal(readFileSync(join(fx.repo, USER_SKILL_TARGET), "utf8").includes("v1"), true);
    assert.equal(existsSync(join(fx.repo, WRAPPER_TARGET)), false, "user scope must not install project wrapper scripts");
    assert.equal(existsSync(join(fx.repo, guard.USER_INSTALL_MANIFEST_REL)), true, "user manifest location");
    assert.equal(existsSync(join(fx.repo, guard.PROJECT_INSTALL_MANIFEST_REL)), false, "project manifest must not be written");
    assert.equal(result.manifest!.installScope, "user");
    assert.equal(result.manifest!.files.length, 1);
    assert.equal((result.manifest!.files as any[])[0].path, USER_SKILL_TARGET);
  } finally {
    fx.cleanup();
  }
});

test("install never overwrites a pre-existing different file unless forced", () => {
  const fx = createEngineFixture();
  try {
    writeText(join(fx.repo, SKILL_TARGET), "user content\n");
    const result = guard.install_workflow(fx.repo, { packageRoot: fx.packageRoot });
    assert.deepEqual(result.problems, []);
    assert.equal(readFileSync(join(fx.repo, SKILL_TARGET), "utf8"), "user content\n");
    const entry = (result.manifest!.files as any[]).find((item) => item.path === SKILL_TARGET);
    assert.deepEqual({ managed: entry.managed, preexisting: entry.preexisting }, { managed: false, preexisting: true });

    const forced = guard.install_workflow(fx.repo, { packageRoot: fx.packageRoot, force: true });
    assert.deepEqual(forced.problems, []);
    assert.equal(readFileSync(join(fx.repo, SKILL_TARGET), "utf8").includes("v1"), true);
    assert.equal(readFileSync(join(fx.repo, `${SKILL_TARGET}.bak`), "utf8"), "user content\n");
  } finally {
    fx.cleanup();
  }
});

test("update rolls unmodified files forward and keeps user edits with a *.new sidecar", () => {
  const fx = createEngineFixture();
  try {
    assert.deepEqual(guard.install_workflow(fx.repo, { packageRoot: fx.packageRoot }).problems, []);
    // Template upgrade with an unmodified target: rolled forward.
    writeText(join(fx.packageRoot, "templates", "skill.md"), "---\nname: superspec-demo\n---\nv2\n");
    const first = guard.update_workflow(fx.repo, { packageRoot: fx.packageRoot });
    assert.deepEqual(first.problems, []);
    assert.equal(readFileSync(join(fx.repo, SKILL_TARGET), "utf8").includes("v2"), true);
    // User edits the managed file, then another template upgrade: user version kept, ours as *.new.
    writeText(join(fx.repo, SKILL_TARGET), "user tweaked\n");
    writeText(join(fx.packageRoot, "templates", "skill.md"), "---\nname: superspec-demo\n---\nv3\n");
    const second = guard.update_workflow(fx.repo, { packageRoot: fx.packageRoot });
    assert.deepEqual(second.problems, []);
    assert.equal(readFileSync(join(fx.repo, SKILL_TARGET), "utf8"), "user tweaked\n");
    assert.equal(readFileSync(join(fx.repo, `${SKILL_TARGET}.new`), "utf8").includes("v3"), true);
    // Baseline sha must stay the OLD managed baseline so uninstall still sees the modification.
    const entry = (second.manifest!.files as any[]).find((item) => item.path === SKILL_TARGET);
    assert.notEqual(entry.sha256, guard.sha256_file(join(fx.repo, SKILL_TARGET)));
  } finally {
    fx.cleanup();
  }
});

test("update removes managed files dropped from the install map only when unmodified", () => {
  const fx = createEngineFixture();
  try {
    assert.deepEqual(guard.install_workflow(fx.repo, { packageRoot: fx.packageRoot }).problems, []);
    writeText(join(fx.packageRoot, "adapters", "codex", "install-map.json"), JSON.stringify({
      adapter: "codex",
      version: 1,
      mappings: [{ kind: "skill", source: "templates/skill.md", target: SKILL_TARGET }],
    }));
    const result = guard.update_workflow(fx.repo, { packageRoot: fx.packageRoot });
    assert.deepEqual(result.problems, []);
    assert.equal(existsSync(join(fx.repo, WRAPPER_TARGET)), false, "dropped unmodified managed file must be removed");
  } finally {
    fx.cleanup();
  }
});

test("update without a manifest fails closed", () => {
  const fx = createEngineFixture();
  try {
    const result = guard.update_workflow(fx.repo, { packageRoot: fx.packageRoot });
    assert.equal(result.problems.length, 1);
    assert.match(result.problems[0], /install manifest missing/);
  } finally {
    fx.cleanup();
  }
});

test("uninstall removes only unmodified managed files and never touches data or user edits", () => {
  const fx = createEngineFixture();
  try {
    writeText(join(fx.repo, SKILL_TARGET), "preexisting user file\n");
    assert.deepEqual(guard.install_workflow(fx.repo, { packageRoot: fx.packageRoot }).problems, []);
    writeText(join(fx.repo, ".superspec", "ledger.jsonl"), "{}\n");

    const dry = guard.uninstall_workflow(fx.repo, { dryRun: true });
    assert.deepEqual(dry.problems, []);
    assert.ok(dry.actions.some((item) => item.status === "would_remove" && item.action.includes(WRAPPER_TARGET)));
    assert.equal(existsSync(join(fx.repo, WRAPPER_TARGET)), true, "dry-run must not delete");
    assert.equal(existsSync(join(fx.repo, guard.INSTALL_MANIFEST_REL)), true, "dry-run must keep the manifest");

    const result = guard.uninstall_workflow(fx.repo);
    assert.deepEqual(result.problems, []);
    assert.equal(existsSync(join(fx.repo, WRAPPER_TARGET)), false, "unmodified managed file removed");
    assert.equal(readFileSync(join(fx.repo, SKILL_TARGET), "utf8"), "preexisting user file\n");
    assert.equal(readFileSync(join(fx.repo, ".superspec", "ledger.jsonl"), "utf8"), "{}\n", ".superspec data is never touched");
    assert.equal(existsSync(join(fx.repo, guard.INSTALL_MANIFEST_REL)), false, "manifest removed after uninstall");
  } finally {
    fx.cleanup();
  }
});

test("uninstall without a manifest fails closed", () => {
  const fx = createEngineFixture();
  try {
    const result = guard.uninstall_workflow(fx.repo);
    assert.equal(result.problems.length, 1);
    assert.match(result.problems[0], /install manifest missing/);
  } finally {
    fx.cleanup();
  }
});

test("init cli rejects --update together with --uninstall", () => {
  const writes: string[] = [];
  const savedWrite = process.stdout.write;
  process.stdout.write = ((chunk: any) => {
    writes.push(String(chunk));
    return true;
  }) as typeof process.stdout.write;
  try {
    assert.equal(main_init(["--update", "--uninstall"]), 2);
    const summary = JSON.parse(writes.join(""));
    assert.equal(summary.block_reasons[0].code, "guard_error");
    assert.match(summary.block_reasons[0].message, /mutually exclusive/);
  } finally {
    process.stdout.write = savedWrite;
  }
});

test("init cli --uninstall surfaces engine problems as a block decision", () => {
  const fx = createEngineFixture();
  const writes: string[] = [];
  const savedWrite = process.stdout.write;
  process.stdout.write = ((chunk: any) => {
    writes.push(String(chunk));
    return true;
  }) as typeof process.stdout.write;
  try {
    assert.equal(main_init(["--path", fx.repo, "--uninstall"]), 1);
    const summary = JSON.parse(writes.join(""));
    assert.equal(summary.allowed, false);
    assert.equal(summary.block_reasons[0].code, "project_uninstall_failed");
  } finally {
    process.stdout.write = savedWrite;
    fx.cleanup();
  }
});

test("templates and guard constants stay consistent (install map covers all workflow skills and roles)", () => {
  // DISTRIBUTION §9: if guard constants change, the install map must follow.
  const { mappings } = guard.load_install_map();
  const targets = new Set(mappings.map((item) => item.target));
  for (const name of guard.REQUIRED_SUPERSPEC_WORKFLOW_SKILLS) {
    assert.ok(targets.has(`.codex/skills/${name}/SKILL.md`), `install map missing workflow skill ${name}`);
  }
  for (const name of guard.REQUIRED_SUPERSPEC_AGENT_ROLES) {
    assert.ok(targets.has(`.codex/agents/${name}.toml`), `install map missing agent ${name}`);
    assert.ok(targets.has(`.codex/prompts/${name}.md`), `install map missing prompt ${name}`);
  }
});
