// Manifest-driven install/update/uninstall engine tests (audit G-1, Phase 5 decision D4).
// Engine invariants under test: install-map is the only install source, the manifest is the only
// removal/update authority, manifest sha256 is the managed baseline, and user-modified /
// preexisting files plus .superspec runtime data are never overwritten or deleted.
import assert from "node:assert/strict";
import test from "node:test";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, dirname, join } from "node:path";

import * as guard from "../superspec_guard.ts";
import { main_init, maybe_install_missing_openspec } from "../src/init_cli.ts";
import { ensure_openspec_chinese_context, missing_openspec_cli_message, OPENSPEC_INSTALL_DOC_URL, recommended_openspec_install_plan } from "../src/project_init.ts";

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

function oldManagedFourHookManifest(): string {
  return `${JSON.stringify({
    superspec: {
      managed: true,
      adapter_version: "superspec-hook@2",
      strict_profile_default: "audit-only-until-r1-provenance-passes",
    },
    hooks: {
      PreToolUse: [
        {
          matcher: "Bash|apply_patch|Edit|Write|mcp__.*",
          hooks: [{ type: "command", command: 'superspec-hook --change "$SUPERSPEC_CHANGE"', timeout: 120, statusMessage: "SuperSpec 写入策略检查" }],
        },
      ],
      PostToolUse: [
        {
          matcher: "Bash",
          hooks: [{ type: "command", command: 'superspec-hook --change "$SUPERSPEC_CHANGE"', timeout: 120, statusMessage: "SuperSpec 运行证据记录" }],
        },
      ],
      SubagentStart: [
        {
          matcher: ".*",
          hooks: [{ type: "command", command: 'superspec-hook --change "$SUPERSPEC_CHANGE"', timeout: 120, statusMessage: "SuperSpec 子智能体启动记录" }],
        },
      ],
      SubagentStop: [
        {
          matcher: ".*",
          hooks: [{ type: "command", command: 'superspec-hook --change "$SUPERSPEC_CHANGE"', timeout: 120, statusMessage: "SuperSpec 子智能体停止记录" }],
        },
      ],
    },
  }, null, 2)}\n`;
}

function currentManagedHookManifest(): string {
  return readFileSync(join(process.cwd(), "templates", "hooks", "codex-hooks.json"), "utf8");
}

function createHookEngineFixture(hookManifest: string = currentManagedHookManifest()): EngineFixture {
  const tmp = mkdtempSync(join(tmpdir(), "superspec-hook-install-"));
  const packageRoot = join(tmp, "pkg");
  const repo = join(tmp, "repo");
  mkdirSync(repo, { recursive: true });
  writeText(join(packageRoot, "package.json"), JSON.stringify({ name: "superspec-test", version: "9.9.9" }));
  writeText(join(packageRoot, "templates", "hooks", "codex-hooks.json"), hookManifest);
  writeText(join(packageRoot, "adapters", "codex", "install-map.json"), JSON.stringify({
    adapter: "codex",
    version: 1,
    mappings: [
      { kind: "hook", source: "templates/hooks/codex-hooks.json", target: ".codex/hooks.json" },
    ],
  }));
  return { packageRoot, repo, cleanup: () => rmSync(tmp, { recursive: true, force: true }) };
}

const SKILL_TARGET = ".codex/skills/superspec-demo/SKILL.md";
const USER_SKILL_TARGET = "skills/superspec-demo/SKILL.md";
const WRAPPER_TARGET = "scripts/superspec_demo";
const HOOK_TARGET = ".codex/hooks.json";
const USER_HOOK_TARGET = "hooks.json";

function assertSubagentOnlyHookManifest(path: string): void {
  const parsed = JSON.parse(readFileSync(path, "utf8"));
  assert.equal(parsed.superspec.managed, true);
  assert.equal(parsed.hooks.PreToolUse, undefined);
  assert.equal(parsed.hooks.PostToolUse, undefined);
  assert.ok(Array.isArray(parsed.hooks.SubagentStart), "SubagentStart hook must be present");
  assert.ok(Array.isArray(parsed.hooks.SubagentStop), "SubagentStop hook must be present");
  assert.deepEqual(Object.keys(parsed.hooks).sort(), ["SubagentStart", "SubagentStop"]);
}

function tomlTable(text: string, table: string): string {
  const match = new RegExp(`(?:^|\\n)\\[${table}\\]\\n?([\\s\\S]*?)(?=\\n\\[[^\\]]+\\]|$)`, "u").exec(text);
  return match?.[1] ?? "";
}

function assertTomlSetting(text: string, table: string, key: string, value: string): void {
  const body = tomlTable(text, table);
  assert.match(body, new RegExp(`^${key}\\s*=\\s*${value}$`, "mu"), `${table}.${key}`);
}

function installFakeNpmThatInstallsOpenSpec(binDir: string): void {
  mkdirSync(binDir, { recursive: true });
  const openspecPath = join(binDir, "openspec");
  const npmPath = join(binDir, "npm");
  writeText(
    npmPath,
    [
      `#!${process.execPath}`,
      "import { chmodSync, writeFileSync } from 'node:fs';",
      "import { join } from 'node:path';",
      `const binDir = ${JSON.stringify(binDir)};`,
      `const openspecPath = ${JSON.stringify(openspecPath)};`,
      `const skills = ${JSON.stringify([...guard.REQUIRED_OPENSPEC_CODEX_SKILLS])};`,
      "const openspecSource = [",
      `  ${JSON.stringify(`#!${process.execPath}`)},`,
      "  \"import { mkdirSync, writeFileSync } from 'node:fs';\",",
      "  \"import { join } from 'node:path';\",",
      `  ${JSON.stringify(`const skills = ${JSON.stringify([...guard.REQUIRED_OPENSPEC_CODEX_SKILLS])};`)},`,
      "  'const args = process.argv.slice(2);',",
      "  \"if (args[0] === '--version') { console.log('OpenSpec 1.4.1'); process.exit(0); }\",",
      "  \"if (args[1] === '--help' && ['list', 'instructions', 'archive', 'validate', 'status'].includes(args[0] ?? '')) process.exit(0);\",",
      "  \"if (args[0] === 'init' || args[0] === 'update') {\",",
      "  \"  for (const name of skills) {\",",
      "  \"    const dir = join(process.cwd(), '.codex', 'skills', name);\",",
      "  \"    mkdirSync(dir, { recursive: true });\",",
      "  \"    writeFileSync(join(dir, 'SKILL.md'), `---\\\\nname: ${name}\\\\n---\\\\n`, 'utf8');\",",
      "  '  }',",
      "  '  process.exit(0);',",
      "  '}',",
      "  'process.exit(0);',",
      "].join('\\n');",
      "writeFileSync(openspecPath, openspecSource, 'utf8');",
      "chmodSync(openspecPath, 0o755);",
      "writeFileSync(join(binDir, 'openspec.cmd'), '@echo off\\r\\nnode \"%~dp0openspec\" %*\\r\\n', 'utf8');",
      "writeFileSync(join(binDir, 'npm-installed-openspec.txt'), process.argv.slice(2).join(' '), 'utf8');",
      "",
    ].join("\n"),
  );
  chmodSync(npmPath, 0o755);
  writeText(join(binDir, "npm.cmd"), `@echo off\r\n"${process.execPath}" "%~dp0npm" %*\r\n`);
}

function installFakeOpenSpecVersion(binDir: string, version: string): void {
  mkdirSync(binDir, { recursive: true });
  const openspecPath = join(binDir, "openspec");
  writeText(
    openspecPath,
    [
      `#!${process.execPath}`,
      "const args = process.argv.slice(2);",
      `if (args[0] === '--version') { console.log('OpenSpec ${version}'); process.exit(0); }`,
      "process.exit(0);",
      "",
    ].join("\n"),
  );
  chmodSync(openspecPath, 0o755);
  writeText(join(binDir, "openspec.cmd"), `@echo off\r\n"${process.execPath}" "%~dp0openspec" %*\r\n`);
}

test("real install map loads and every source file exists", () => {
  const { mappings, problems } = guard.load_install_map();
  assert.deepEqual(problems, []);
  assert.equal(mappings.length, 22, `expected 5 skills, 1 hook manifest, 8 prompts, and 8 agents, got ${mappings.length}`);
  const targets = mappings.map((item) => item.target);
  for (const name of guard.REQUIRED_SUPERSPEC_WORKFLOW_SKILLS) {
    assert.ok(targets.includes(`.codex/skills/${name}/SKILL.md`), name);
  }
  assert.ok(targets.includes(".codex/hooks.json"), "managed v2 hooks manifest");
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

test("windows command selection prefers cmd and bat shims from where.exe output", () => {
  assert.equal(
    guard.selectWindowsCommandCandidate("openspec", [
      "C:\\Users\\me\\AppData\\Roaming\\npm\\openspec",
      "C:\\Users\\me\\AppData\\Roaming\\npm\\openspec.cmd",
      "",
    ].join("\r\n")),
    "C:\\Users\\me\\AppData\\Roaming\\npm\\openspec.cmd",
  );
  assert.equal(
    guard.selectWindowsCommandCandidate("openspec", [
      "C:\\tools\\openspec",
      "C:\\tools\\openspec.bat",
    ].join("\n")),
    "C:\\tools\\openspec.bat",
  );
  assert.equal(guard.selectWindowsCommandCandidate("openspec", "C:\\tools\\openspec\n"), "C:\\tools\\openspec");
});

test("windows cmd shim invocation passes the shim path and args separately", () => {
  const invocation = guard.windowsCmdShimInvocation("C:\\Program Files\\nodejs\\openspec.cmd", [
    "demo change",
    "x&y",
    "pipe|value",
    "out>file",
    "quote\" & calc & \"value",
  ]);
  assert.equal(invocation.cmd, "cmd.exe");
  assert.deepEqual(invocation.args, [
    "/d",
    "/c",
    "C:\\Program Files\\nodejs\\openspec.cmd",
    "demo change",
    "x&y",
    "pipe|value",
    "out>file",
    "quote\" & calc & \"value",
  ]);
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
    assert.deepEqual(manifest.configPatch, {
      path: ".codex/config.toml",
      retainedOnUninstall: true,
      managed: false,
    });
    assert.ok(manifest.createdDirs.includes(".codex/skills/superspec-demo"), JSON.stringify(manifest.createdDirs));
    const config = readFileSync(join(fx.repo, ".codex", "config.toml"), "utf8");
    assertTomlSetting(config, "features", "multi_agent", "true");
    assertTomlSetting(config, "features", "child_agents_md", "true");
    assertTomlSetting(config, "agents", "max_threads", "12");
    assertTomlSetting(config, "agents", "max_depth", "1");
    // Idempotent re-install: everything already matches, nothing is rewritten as "created".
    const again = guard.install_workflow(fx.repo, { packageRoot: fx.packageRoot });
    assert.deepEqual(again.problems, []);
    assert.ok(again.actions.every((item) => item.status === "ok"), JSON.stringify(again.actions));
  } finally {
    fx.cleanup();
  }
});

test("fresh install writes subagent-only hooks manifest", () => {
  const fx = createHookEngineFixture();
  try {
    const result = guard.install_workflow(fx.repo, { packageRoot: fx.packageRoot });
    assert.deepEqual(result.problems, []);
    assertSubagentOnlyHookManifest(join(fx.repo, HOOK_TARGET));
    const entry = (result.manifest!.files as any[]).find((item) => item.path === HOOK_TARGET);
    assert.deepEqual({ managed: entry.managed, preexisting: entry.preexisting }, { managed: true, preexisting: false });
  } finally {
    fx.cleanup();
  }
});

test("init migrates pre-existing managed four-hook manifest to subagent-only manifest", () => {
  for (const scope of ["project", "user"] as const) {
    const fx = createHookEngineFixture();
    try {
      const target = scope === "user" ? USER_HOOK_TARGET : HOOK_TARGET;
      writeText(join(fx.repo, target), oldManagedFourHookManifest());

      const result = guard.install_workflow(fx.repo, { packageRoot: fx.packageRoot, scope });
      assert.deepEqual(result.problems, []);
      assertSubagentOnlyHookManifest(join(fx.repo, target));
      const entry = (result.manifest!.files as any[]).find((item) => item.path === target);
      assert.deepEqual({ managed: entry.managed, preexisting: entry.preexisting }, { managed: true, preexisting: false });
      assert.ok(result.actions.some((item) => item.action === `install ${target}` && item.status === "updated"), `${scope}: ${JSON.stringify(result.actions)}`);
    } finally {
      fx.cleanup();
    }
  }
});

test("init preserves user-modified hooks manifest and writes new baseline aside", () => {
  for (const scope of ["project", "user"] as const) {
    const fx = createHookEngineFixture();
    try {
      const target = scope === "user" ? USER_HOOK_TARGET : HOOK_TARGET;
      writeText(join(fx.repo, target), `${oldManagedFourHookManifest()}\n/* user local hook tweak */\n`);

      const result = guard.install_workflow(fx.repo, { packageRoot: fx.packageRoot, scope });
      assert.deepEqual(result.problems, []);
      assert.match(readFileSync(join(fx.repo, target), "utf8"), /user local hook tweak/u);
      assertSubagentOnlyHookManifest(join(fx.repo, `${target}.new`));
      const entry = (result.manifest!.files as any[]).find((item) => item.path === target);
      assert.deepEqual({ managed: entry.managed, preexisting: entry.preexisting }, { managed: false, preexisting: true });
      assert.ok(result.actions.some((item) => item.action === `install ${target}` && item.status === "skipped"), `${scope}: ${JSON.stringify(result.actions)}`);
    } finally {
      fx.cleanup();
    }
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
    const config = readFileSync(join(fx.repo, "config.toml"), "utf8");
    assertTomlSetting(config, "agents", "max_threads", "12");
    assert.equal(result.manifest!.installScope, "user");
    assert.equal(result.manifest!.files.length, 1);
    assert.equal((result.manifest!.files as any[])[0].path, USER_SKILL_TARGET);
    assert.deepEqual(result.manifest!.configPatch, {
      path: "config.toml",
      retainedOnUninstall: true,
      managed: false,
    });
  } finally {
    fx.cleanup();
  }
});

test("install merges Codex config without dropping unrelated user settings", () => {
  const fx = createEngineFixture();
  try {
    writeText(
      join(fx.repo, ".codex", "config.toml"),
      [
        'model = "gpt-5.5"',
        "",
        "[features]",
        "hooks = true",
        "multi_agent = false",
        "",
        "[agents]",
        "max_threads = 6",
        "",
        "[model_providers.localproxy]",
        'name = "localproxy"',
        "",
      ].join("\n"),
    );
    const result = guard.install_workflow(fx.repo, { packageRoot: fx.packageRoot });
    assert.deepEqual(result.problems, []);
    const config = readFileSync(join(fx.repo, ".codex", "config.toml"), "utf8");
    assert.match(config, /^model = "gpt-5\.5"$/mu);
    assert.match(config, /^hooks = true$/mu);
    assert.match(config, /^name = "localproxy"$/mu);
    assertTomlSetting(config, "features", "multi_agent", "false");
    assertTomlSetting(config, "features", "child_agents_md", "true");
    assertTomlSetting(config, "agents", "max_threads", "6");
    assertTomlSetting(config, "agents", "max_depth", "1");
    assert.ok(result.actions.some((item) => item.action === "configure .codex/config.toml" && item.status === "updated"));

    const forced = guard.install_workflow(fx.repo, { packageRoot: fx.packageRoot, force: true });
    assert.deepEqual(forced.problems, []);
    const forcedConfig = readFileSync(join(fx.repo, ".codex", "config.toml"), "utf8");
    assertTomlSetting(forcedConfig, "features", "multi_agent", "true");
    assertTomlSetting(forcedConfig, "agents", "max_threads", "12");
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

test("update migrates unchanged managed four-hook manifest to subagent-only manifest", () => {
  for (const scope of ["project", "user"] as const) {
    const fx = createHookEngineFixture(oldManagedFourHookManifest());
    try {
      assert.deepEqual(guard.install_workflow(fx.repo, { packageRoot: fx.packageRoot, scope }).problems, []);
      const target = scope === "user" ? USER_HOOK_TARGET : HOOK_TARGET;
      assert.ok(JSON.parse(readFileSync(join(fx.repo, target), "utf8")).hooks.PreToolUse, `${scope}: old baseline should contain PreToolUse before update`);
      writeText(join(fx.packageRoot, "templates", "hooks", "codex-hooks.json"), currentManagedHookManifest());

      const result = guard.update_workflow(fx.repo, { packageRoot: fx.packageRoot, scope });
      assert.deepEqual(result.problems, []);
      assertSubagentOnlyHookManifest(join(fx.repo, target));
      assert.ok(result.actions.some((item) => item.action === `update ${target}` && item.status === "updated"), `${scope}: ${JSON.stringify(result.actions)}`);
    } finally {
      fx.cleanup();
    }
  }
});

test("update preserves user-modified hooks manifest and writes new baseline aside", () => {
  for (const scope of ["project", "user"] as const) {
    const fx = createHookEngineFixture(oldManagedFourHookManifest());
    try {
      assert.deepEqual(guard.install_workflow(fx.repo, { packageRoot: fx.packageRoot, scope }).problems, []);
      const target = scope === "user" ? USER_HOOK_TARGET : HOOK_TARGET;
      writeText(join(fx.repo, target), `${oldManagedFourHookManifest()}\n/* user local hook tweak */\n`);
      writeText(join(fx.packageRoot, "templates", "hooks", "codex-hooks.json"), currentManagedHookManifest());

      const result = guard.update_workflow(fx.repo, { packageRoot: fx.packageRoot, scope });
      assert.deepEqual(result.problems, []);
      assert.match(readFileSync(join(fx.repo, target), "utf8"), /user local hook tweak/u);
      assertSubagentOnlyHookManifest(join(fx.repo, `${target}.new`));
      assert.ok(result.actions.some((item) => item.action === `update ${target}` && item.status === "skipped"), `${scope}: ${JSON.stringify(result.actions)}`);
    } finally {
      fx.cleanup();
    }
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
    assert.equal(main_init(["--update", "--uninstall", "--format", "json"]), 2);
    const summary = JSON.parse(writes.join(""));
    assert.equal(summary.block_reasons[0].code, "guard_error");
    assert.equal(summary.gate_label_zh, "命令执行异常");
    assert.match(summary.block_reasons[0].message, /不能同时使用/u);
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
    assert.equal(main_init(["--path", fx.repo, "--uninstall", "--format", "json"]), 1);
    const summary = JSON.parse(writes.join(""));
    assert.equal(summary.allowed, false);
    assert.equal(summary.block_reasons[0].code, "project_uninstall_failed");
    assert.equal(summary.gate_label_zh, "项目级卸载");
  } finally {
    process.stdout.write = savedWrite;
    fx.cleanup();
  }
});

test("openspec install plan prefers npm-compatible global installers in stable order", () => {
  const seen: string[] = [];
  const plan = recommended_openspec_install_plan({
    cwd: "/repo",
    commandExistsFn: (cmd, meta) => {
      seen.push(`${cmd}@${meta?.cwd ?? ""}`);
      return cmd === "pnpm";
    },
  });
  assert.deepEqual(seen, ["npm@/repo", "pnpm@/repo"]);
  assert.ok(plan);
  assert.equal(plan.manager, "pnpm");
  assert.equal(plan.rendered, "pnpm add -g @fission-ai/openspec@latest");
});

test("missing openspec message falls back to docs when no supported package manager is available", () => {
  const message = missing_openspec_cli_message({
    commandExistsFn: () => false,
  });
  assert.match(message, /PATH 中缺少 OpenSpec CLI/u);
  assert.match(message, new RegExp(OPENSPEC_INSTALL_DOC_URL.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
});

test("openspec probe rejects openspec-chinese even when it reports a compatible version", () => {
  const probe = guard.openspec_cli_probe({
    commandExistsFn: () => true,
    run: (cmd, args) => {
      assert.equal(cmd, "openspec");
      if (args[0] === "--version") return { status: 0, stdout: "openspec-chinese 1.4.1\n", stderr: "" };
      return { status: 0, stdout: "", stderr: "" };
    },
  });
  assert.equal(probe.ok, false);
  assert.equal(probe.state, "invalid");
  assert.match(probe.message, /openspec-chinese/u);
});

test("openspec probe requires list CLI surface for explore grounding", () => {
  const probe = guard.openspec_cli_probe({
    commandExistsFn: () => true,
    run: (_cmd, args) => {
      if (args[0] === "--version") return { status: 0, stdout: "OpenSpec 1.4.1\n", stderr: "" };
      if (args[0] === "list" && args[1] === "--help") return { status: 1, stdout: "", stderr: "unknown command list\n" };
      return { status: 0, stdout: "", stderr: "" };
    },
  });
  assert.equal(probe.ok, false);
  assert.equal(probe.state, "invalid");
  assert.match(probe.message, /openspec list --help/u);
});

test("init automatically installs openspec when it is missing", async () => {
  const writes: string[] = [];
  const runs: Array<{ cmd: string; args: string[] }> = [];
  let openspecInstalled = false;
  const result = await maybe_install_missing_openspec({
    cwd: "/repo",
    scope: "project",
    mode: "install",
    commandExistsFn: (cmd) => {
      if (cmd === "npm") return true;
      if (cmd === "openspec") return openspecInstalled;
      return false;
    },
    run: (cmd, args) => {
      if (cmd === "npm") {
        runs.push({ cmd, args });
        openspecInstalled = true;
        return { status: 0, stdout: "", stderr: "" };
      }
      if (cmd === "openspec" && args[0] === "--version") return { status: 0, stdout: "OpenSpec 1.4.1\n", stderr: "" };
      return { status: 0, stdout: "", stderr: "" };
    },
    writeStderr: (text) => {
      writes.push(text);
    },
  });
  assert.equal(result, "installed");
  assert.equal(runs.length, 1);
  assert.deepEqual(runs[0], {
    cmd: "npm",
    args: ["install", "-g", "@fission-ai/openspec@latest"],
  });
  assert.ok(writes.some((item) => item.includes("将自动安装或升级")));
  assert.ok(writes.some((item) => item.includes("npm install -g @fission-ai/openspec@latest")));
  assert.ok(writes.some((item) => item.includes("OpenSpec CLI 安装或升级完成")));
});

test("init reports skipped when no supported package manager can install openspec", async () => {
  const writes: string[] = [];
  const result = await maybe_install_missing_openspec({
    cwd: "/repo",
    scope: "user",
    mode: "install",
    commandExistsFn: () => false,
    run: () => {
      throw new Error("run should not be called");
    },
    writeStderr: (text) => {
      writes.push(text);
    },
  });
  assert.equal(result, "skipped");
  assert.ok(writes.some((item) => item.includes("未找到 npm、pnpm、yarn 或 bun")));
});

test("init automatically upgrades openspec when the installed version is too old", async () => {
  const writes: string[] = [];
  const runs: Array<{ cmd: string; args: string[] }> = [];
  let upgraded = false;
  const result = await maybe_install_missing_openspec({
    cwd: "/repo",
    scope: "project",
    mode: "install",
    commandExistsFn: (cmd) => cmd === "npm" || cmd === "openspec",
    run: (cmd, args) => {
      if (cmd === "npm") {
        runs.push({ cmd, args });
        upgraded = true;
        return { status: 0, stdout: "", stderr: "" };
      }
      if (cmd === "openspec" && args[0] === "--version") {
        return { status: 0, stdout: upgraded ? "OpenSpec 1.4.1\n" : "OpenSpec 1.3.0\n", stderr: "" };
      }
      return { status: 0, stdout: "", stderr: "" };
    },
    writeStderr: (text) => {
      writes.push(text);
    },
  });
  assert.equal(result, "installed");
  assert.deepEqual(runs, [{ cmd: "npm", args: ["install", "-g", "@fission-ai/openspec@latest"] }]);
  assert.ok(writes.some((item) => /1\.3\.0 低于 SuperSpec 要求的最低版本 1\.4\.1/u.test(item)));
  assert.ok(writes.some((item) => item.includes("将自动安装或升级")));
});

test("init automatically replaces unsupported openspec variants even when openspec exists", async () => {
  const writes: string[] = [];
  const runs: Array<{ cmd: string; args: string[] }> = [];
  let installedOfficial = false;
  const result = await maybe_install_missing_openspec({
    cwd: "/repo",
    scope: "project",
    mode: "install",
    commandExistsFn: (cmd) => cmd === "npm" || cmd === "openspec",
    run: (cmd, args) => {
      if (cmd === "npm") {
        runs.push({ cmd, args });
        installedOfficial = true;
        return { status: 0, stdout: "", stderr: "" };
      }
      if (cmd === "openspec" && args[0] === "--version") return { status: 0, stdout: "OpenSpec 1.4.1\n", stderr: "" };
      if (cmd === "openspec" && !installedOfficial) return { status: 1, stdout: "", stderr: "unknown command" };
      return { status: 0, stdout: "", stderr: "" };
    },
    writeStderr: (text) => {
      writes.push(text);
    },
  });
  assert.equal(result, "installed");
  assert.deepEqual(runs, [{ cmd: "npm", args: ["install", "-g", "@fission-ai/openspec@latest"] }]);
  assert.ok(writes.some((item) => item.includes("缺少必需的原生能力")));
  assert.ok(writes.some((item) => item.includes("将自动安装或升级")));
});

test("init retries openspec install with force when an incompatible global bin blocks install", async () => {
  const writes: string[] = [];
  const runs: Array<{ cmd: string; args: string[] }> = [];
  let installedOfficial = false;
  let installAttempts = 0;
  const result = await maybe_install_missing_openspec({
    cwd: "/repo",
    scope: "project",
    mode: "install",
    commandExistsFn: (cmd) => cmd === "npm" || cmd === "openspec",
    run: (cmd, args) => {
      if (cmd === "npm") {
        runs.push({ cmd, args });
        installAttempts += 1;
        if (installAttempts === 1) return { status: 1, stdout: "", stderr: "npm ERR! EEXIST: file already exists, symlink 'openspec'" };
        installedOfficial = true;
        return { status: 0, stdout: "", stderr: "" };
      }
      if (cmd === "openspec" && args[0] === "--version") {
        return { status: 0, stdout: installedOfficial ? "OpenSpec 1.4.1\n" : "openspec-chinese 1.4.1\n", stderr: "" };
      }
      return { status: 0, stdout: "", stderr: "" };
    },
    writeStderr: (text) => {
      writes.push(text);
    },
  });
  assert.equal(result, "installed");
  assert.deepEqual(runs, [
    { cmd: "npm", args: ["install", "-g", "@fission-ai/openspec@latest"] },
    { cmd: "npm", args: ["install", "-g", "--force", "@fission-ai/openspec@latest"] },
  ]);
  assert.ok(writes.some((item) => item.includes("覆盖重试")));
});

test("init does not force retry openspec install for unrelated global bin conflicts", async () => {
  const writes: string[] = [];
  const runs: Array<{ cmd: string; args: string[] }> = [];
  const result = await maybe_install_missing_openspec({
    cwd: "/repo",
    scope: "project",
    mode: "install",
    commandExistsFn: (cmd) => cmd === "npm",
    run: (cmd, args) => {
      if (cmd === "npm") {
        runs.push({ cmd, args });
        return { status: 1, stdout: "", stderr: "npm ERR! EEXIST: file already exists, symlink 'other-tool'" };
      }
      return { status: 0, stdout: "", stderr: "" };
    },
    writeStderr: (text) => {
      writes.push(text);
    },
  });
  assert.equal(result, "failed");
  assert.deepEqual(runs, [{ cmd: "npm", args: ["install", "-g", "@fission-ai/openspec@latest"] }]);
  assert.equal(writes.some((item) => item.includes("覆盖重试")), false);
});

test("non-interactive init also installs openspec automatically", async () => {
  const runs: Array<{ cmd: string; args: string[] }> = [];
  let openspecInstalled = false;
  const result = await maybe_install_missing_openspec({
    cwd: "/repo",
    scope: "project",
    mode: "install",
    interactive: false,
    commandExistsFn: (cmd) => {
      if (cmd === "npm") return true;
      if (cmd === "openspec") return openspecInstalled;
      return false;
    },
    run: (cmd, args) => {
      if (cmd === "npm") {
        runs.push({ cmd, args });
        openspecInstalled = true;
      }
      if (cmd === "openspec" && args[0] === "--version") return { status: 0, stdout: "OpenSpec 1.4.1\n", stderr: "" };
      return { status: 0, stdout: "", stderr: "" };
    },
    writeStderr: () => {},
  });
  assert.equal(result, "installed");
  assert.deepEqual(runs, [{ cmd: "npm", args: ["install", "-g", "@fission-ai/openspec@latest"] }]);
});

test("update and uninstall do not trigger openspec installation preflight", async () => {
  for (const mode of ["update", "uninstall"] as const) {
    let probed = false;
    let ran = false;
    const result = await maybe_install_missing_openspec({
      cwd: "/repo",
      scope: "user",
      mode,
      probeOpenspecFn: () => {
        probed = true;
        return { ok: false, state: "missing", version: null, message: "missing" };
      },
      run: () => {
        ran = true;
        return { status: 0, stdout: "", stderr: "" };
      },
      writeStderr: () => {},
    });
    assert.equal(result, "not-needed", mode);
    assert.equal(probed, false, mode);
    assert.equal(ran, false, mode);
  }
});

test("main init with explicit project scope upgrades openspec before project setup", () => {
  const tmp = mkdtempSync(join(tmpdir(), "superspec-scope-init-"));
  const repo = join(tmp, "repo");
  const bin = join(tmp, "bin");
  const stdout: string[] = [];
  const stderr: string[] = [];
  const savedStdout = process.stdout.write;
  const savedStderr = process.stderr.write;
  const savedPath = process.env.PATH;
  const savedPathAlt = process.env.Path;
  mkdirSync(repo, { recursive: true });
  installFakeNpmThatInstallsOpenSpec(bin);
  installFakeOpenSpecVersion(bin, "1.3.0");
  process.env.PATH = [bin, savedPath ?? savedPathAlt ?? ""].filter(Boolean).join(delimiter);
  if (process.platform === "win32") process.env.Path = process.env.PATH;
  process.stdout.write = ((chunk: any) => {
    stdout.push(String(chunk));
    return true;
  }) as typeof process.stdout.write;
  process.stderr.write = ((chunk: any) => {
    stderr.push(String(chunk));
    return true;
  }) as typeof process.stderr.write;
  try {
    const exitCode = main_init(["--scope", "project", "--path", repo, "--format", "json"]);
    assert.equal(exitCode, 0, stderr.join(""));
    assert.equal(existsSync(join(bin, "npm-installed-openspec.txt")), true, "explicit --scope project must trigger OpenSpec upgrade");
    const summary = JSON.parse(stdout.join(""));
    assert.equal(summary.allowed, true, JSON.stringify(summary.block_reasons));
    assert.equal(existsSync(join(repo, ".codex", "skills", "openspec-explore", "SKILL.md")), false);
    assert.equal(existsSync(join(repo, ".codex", "skills", "superspec-explore", "SKILL.md")), true);
  } finally {
    process.stdout.write = savedStdout;
    process.stderr.write = savedStderr;
    process.env.PATH = savedPath;
    if (savedPathAlt === undefined) delete process.env.Path;
    else process.env.Path = savedPathAlt;
    rmSync(tmp, { recursive: true, force: true });
  }
});

test("init automatically installs openspec for user scope too", async () => {
  const runs: Array<{ cmd: string; args: string[] }> = [];
  let openspecInstalled = false;
  const result = await maybe_install_missing_openspec({
    cwd: "/repo",
    scope: "user",
    mode: "install",
    commandExistsFn: (cmd) => {
      if (cmd === "npm") return true;
      if (cmd === "openspec") return openspecInstalled;
      return false;
    },
    run: (cmd, args) => {
      if (cmd === "npm") {
        runs.push({ cmd, args });
        openspecInstalled = true;
        return { status: 0, stdout: "", stderr: "" };
      }
      if (cmd === "openspec" && args[0] === "--version") return { status: 0, stdout: "OpenSpec 1.4.1\n", stderr: "" };
      return { status: 0, stdout: "", stderr: "" };
    },
    writeStderr: () => {},
  });
  assert.equal(result, "installed");
  assert.deepEqual(runs, [{ cmd: "npm", args: ["install", "-g", "@fission-ai/openspec@latest"] }]);
});

test("main init with user scope blocks when openspec auto install fails", () => {
  const tmp = mkdtempSync(join(tmpdir(), "superspec-user-init-fail-"));
  const repo = join(tmp, "repo");
  const codexHome = join(tmp, "codex-home");
  const bin = join(tmp, "bin");
  const stdout: string[] = [];
  const stderr: string[] = [];
  const savedStdout = process.stdout.write;
  const savedStderr = process.stderr.write;
  const savedPath = process.env.PATH;
  const savedPathAlt = process.env.Path;
  mkdirSync(repo, { recursive: true });
  installFakeOpenSpecVersion(bin, "1.3.0");
  writeText(
    join(bin, "npm"),
    [
      `#!${process.execPath}`,
      "console.error('permission denied');",
      "process.exit(1);",
      "",
    ].join("\n"),
  );
  chmodSync(join(bin, "npm"), 0o755);
  process.env.PATH = [bin, savedPath ?? savedPathAlt ?? ""].filter(Boolean).join(delimiter);
  if (process.platform === "win32") process.env.Path = process.env.PATH;
  process.stdout.write = ((chunk: any) => {
    stdout.push(String(chunk));
    return true;
  }) as typeof process.stdout.write;
  process.stderr.write = ((chunk: any) => {
    stderr.push(String(chunk));
    return true;
  }) as typeof process.stderr.write;
  try {
    const exitCode = main_init(["--scope", "user", "--path", repo, "--codex-home", codexHome, "--format", "json"]);
    assert.equal(exitCode, 1);
    const summary = JSON.parse(stdout.join(""));
    assert.equal(summary.allowed, false);
    assert.equal(summary.gate, "openspec_preflight");
    assert.equal(summary.install_scope, "user");
    assert.equal(summary.block_reasons[0].code, "openspec_auto_install_failed");
    assert.equal(existsSync(join(codexHome, "skills", "superspec-explore", "SKILL.md")), false);
    assert.ok(stderr.join("").includes("自动安装 OpenSpec CLI 失败"));
  } finally {
    process.stdout.write = savedStdout;
    process.stderr.write = savedStderr;
    process.env.PATH = savedPath;
    if (savedPathAlt === undefined) delete process.env.Path;
    else process.env.Path = savedPathAlt;
    rmSync(tmp, { recursive: true, force: true });
  }
});

test("main init with explicit user scope installs openspec before user setup", () => {
  const tmp = mkdtempSync(join(tmpdir(), "superspec-user-init-"));
  const repo = join(tmp, "repo");
  const codexHome = join(tmp, "codex-home");
  const bin = join(tmp, "bin");
  const stdout: string[] = [];
  const stderr: string[] = [];
  const savedStdout = process.stdout.write;
  const savedStderr = process.stderr.write;
  const savedPath = process.env.PATH;
  const savedPathAlt = process.env.Path;
  mkdirSync(repo, { recursive: true });
  installFakeNpmThatInstallsOpenSpec(bin);
  installFakeOpenSpecVersion(bin, "1.3.0");
  process.env.PATH = [bin, savedPath ?? savedPathAlt ?? ""].filter(Boolean).join(delimiter);
  if (process.platform === "win32") process.env.Path = process.env.PATH;
  process.stdout.write = ((chunk: any) => {
    stdout.push(String(chunk));
    return true;
  }) as typeof process.stdout.write;
  process.stderr.write = ((chunk: any) => {
    stderr.push(String(chunk));
    return true;
  }) as typeof process.stderr.write;
  try {
    const exitCode = main_init(["--scope", "user", "--path", repo, "--codex-home", codexHome, "--format", "json"]);
    assert.equal(exitCode, 0, stderr.join(""));
    assert.equal(existsSync(join(bin, "npm-installed-openspec.txt")), true, "explicit --scope user must also trigger OpenSpec upgrade");
    const summary = JSON.parse(stdout.join(""));
    assert.equal(summary.allowed, true, JSON.stringify(summary.block_reasons));
    assert.equal(summary.install_scope, "user");
    assert.equal(existsSync(join(codexHome, "skills", "superspec-explore", "SKILL.md")), true);
  } finally {
    process.stdout.write = savedStdout;
    process.stderr.write = savedStderr;
    process.env.PATH = savedPath;
    if (savedPathAlt === undefined) delete process.env.Path;
    else process.env.Path = savedPathAlt;
    rmSync(tmp, { recursive: true, force: true });
  }
});

test("interactive init surfaces install failures in Chinese without leaking raw shell text", async () => {
  const writes: string[] = [];
  const result = await maybe_install_missing_openspec({
    cwd: "/repo",
    scope: "project",
    mode: "install",
    interactive: true,
    commandExistsFn: (cmd) => cmd === "npm",
    run: () => ({
      status: 1,
      stdout: "",
      stderr: "permission denied",
    }),
    writeStderr: (text) => {
      writes.push(text);
    },
  });
  assert.equal(result, "failed");
  assert.ok(writes.some((item) => item.includes("自动安装 OpenSpec CLI 失败：权限不足")));
  assert.equal(writes.some((item) => item.includes("permission denied")), false);
  assert.equal(writes.some((item) => item.includes("exit status")), false);
});

test("ensure_openspec_chinese_context creates config when missing", () => {
  const tmp = mkdtempSync(join(tmpdir(), "sc-"));
  try { const a = ensure_openspec_chinese_context(tmp); assert.equal(a.status, "created"); assert.ok(existsSync(join(tmp, "openspec", "config.yaml"))); assert.ok(readFileSync(join(tmp, "openspec", "config.yaml"), "utf8").includes("所有文档必须使用中文编写")); }
  finally { rmSync(tmp, { recursive: true, force: true }); }
});
test("ensure_openspec_chinese_context is idempotent", () => {
  const tmp = mkdtempSync(join(tmpdir(), "sc-"));
  try { assert.equal(ensure_openspec_chinese_context(tmp).status, "created"); assert.equal(ensure_openspec_chinese_context(tmp).status, "ok"); }
  finally { rmSync(tmp, { recursive: true, force: true }); }
});
test("ensure_openspec_chinese_context replaces English context", () => {
  const tmp = mkdtempSync(join(tmpdir(), "sc-"));
  try { const d = join(tmp, "openspec"); mkdirSync(d, { recursive: true }); writeFileSync(join(d, "config.yaml"), "context: |\n  English.\n", "utf8"); assert.equal(ensure_openspec_chinese_context(tmp).status, "updated"); assert.ok(readFileSync(join(d, "config.yaml"), "utf8").includes("所有文档必须使用中文编写")); }
  finally { rmSync(tmp, { recursive: true, force: true }); }
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
