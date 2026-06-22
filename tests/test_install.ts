import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { installProject, WORKFLOW_AGENTS, WORKFLOW_PROMPTS, WORKFLOW_SKILLS } from "../src/install.ts";

const PACKAGE_VERSION = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")).version as string;

function withTempProject(fn: (projectRoot: string) => void): void {
  const projectRoot = mkdtempSync(join(tmpdir(), "superspec-install-test-"));
  try {
    fn(projectRoot);
  } finally {
    rmSync(projectRoot, { recursive: true, force: true });
  }
}

function countTopLevelContext(content: string): number {
  return content.match(/^context\s*:/gm)?.length ?? 0;
}

test("installProject installs engine, workflow skills, role prompts, and agents", () => {
  withTempProject(projectRoot => {
    const result = installProject(projectRoot);

    assert.equal(result.ok, true);
    assert.equal(result.message, `SuperSpec ${PACKAGE_VERSION} 已安装`);
    assert.deepEqual(result.installed.skills, [...WORKFLOW_SKILLS]);
    assert.deepEqual(result.installed.prompts, [...WORKFLOW_PROMPTS]);
    assert.deepEqual(result.installed.agents, [...WORKFLOW_AGENTS]);
    assert.deepEqual(
      result.installed.agents.filter(agent => /-review\.toml$/.test(agent)),
      [],
    );
    assert.equal(result.installed.config, ".codex/config.toml");
    assert.equal(result.installed.openspec_config, "openspec/config.yaml");
    assert.equal(existsSync(join(projectRoot, ".superspec", "changes")), true);
    assert.equal(readFileSync(join(projectRoot, ".superspec", ".gitignore"), "utf8"), "changes/\n*.log\n*.tmp\n");

    for (const skill of WORKFLOW_SKILLS) {
      const skillPath = join(projectRoot, ".codex", "skills", skill, "SKILL.md");
      assert.equal(existsSync(skillPath), true, skill);
      assert.match(readFileSync(skillPath, "utf8"), /^---\n[\s\S]*?\n---\n/, `${skill} should keep YAML frontmatter`);
    }
    for (const prompt of WORKFLOW_PROMPTS) {
      assert.equal(existsSync(join(projectRoot, ".codex", "prompts", prompt)), true, prompt);
    }
    for (const agent of WORKFLOW_AGENTS) {
      assert.equal(existsSync(join(projectRoot, ".codex", "agents", agent)), true, agent);
    }

    const config = readFileSync(join(projectRoot, ".codex", "config.toml"), "utf8");
    assert.match(config, /\[features\]/);
    assert.match(config, /multi_agent = true/);
    assert.match(config, /child_agents_md = true/);
    assert.match(config, /\[agents\]/);
    assert.match(config, /max_threads = 12/);
    assert.match(config, /max_depth = 1/);

    const openspecConfig = readFileSync(join(projectRoot, "openspec", "config.yaml"), "utf8");
    assert.match(openspecConfig, /^schema: spec-driven$/m);
    assert.match(openspecConfig, /^context: \|$/m);
    assert.match(openspecConfig, /语言：中文（简体）/);
    assert.match(openspecConfig, /所有产出物必须用简体中文撰写/);
    assert.doesNotMatch(openspecConfig, /^\s*language\s*:/m);
  });
});

test("CLI version reads package.json version", () => {
  const cli = new URL("../src/cli.ts", import.meta.url).pathname;
  const output = execFileSync(process.execPath, [cli, "--version"], {
    encoding: "utf8",
  });

  assert.equal(output.trim(), `SuperSpec ${PACKAGE_VERSION}`);
});

test("CLI init --scope project is a compatibility alias for install", () => {
  withTempProject(projectRoot => {
    const cli = new URL("../src/cli.ts", import.meta.url).pathname;
    const output = execFileSync(process.execPath, [cli, "init", "--scope", "project"], {
      cwd: projectRoot,
      encoding: "utf8",
    });
    const result = JSON.parse(output);

    assert.equal(result.ok, true);
    assert.deepEqual(result.installed.skills, [...WORKFLOW_SKILLS]);
    assert.deepEqual(result.installed.prompts, [...WORKFLOW_PROMPTS]);
    assert.deepEqual(result.installed.agents, [...WORKFLOW_AGENTS]);
    assert.equal(result.installed.openspec_config, "openspec/config.yaml");
    assert.equal(existsSync(join(projectRoot, ".codex", "skills", "superspec-explore", "SKILL.md")), true);
    assert.equal(existsSync(join(projectRoot, ".codex", "prompts", "executor.md")), true);
    assert.equal(existsSync(join(projectRoot, ".codex", "agents", "executor.toml")), true);
    assert.equal(existsSync(join(projectRoot, ".codex", "config.toml")), true);
    assert.equal(existsSync(join(projectRoot, "openspec", "config.yaml")), true);
  });
});

test("installProject appends OpenSpec Chinese context when top-level context is missing", () => {
  withTempProject(projectRoot => {
    mkdirSync(join(projectRoot, "openspec"), { recursive: true });
    const configPath = join(projectRoot, "openspec", "config.yaml");
    writeFileSync(configPath, "schema: custom\nfoo: bar\n");

    installProject(projectRoot);

    const first = readFileSync(configPath, "utf8");
    assert.match(first, /^schema: custom$/m);
    assert.match(first, /^foo: bar$/m);
    assert.equal(countTopLevelContext(first), 1);
    assert.match(first, /语言：中文（简体）/);
    assert.doesNotMatch(first, /^\s*language\s*:/m);

    installProject(projectRoot);
    const second = readFileSync(configPath, "utf8");
    assert.equal(second, first);
    assert.equal(countTopLevelContext(second), 1);
  });
});

test("installProject preserves existing top-level OpenSpec context", () => {
  withTempProject(projectRoot => {
    mkdirSync(join(projectRoot, "openspec"), { recursive: true });
    const configPath = join(projectRoot, "openspec", "config.yaml");
    const existing = "schema: spec-driven\n\ncontext: |\n  Existing team context.\n";
    writeFileSync(configPath, existing);

    installProject(projectRoot);

    assert.equal(readFileSync(configPath, "utf8"), existing);
  });
});

test("installProject ignores commented and nested context when ensuring OpenSpec context", () => {
  withTempProject(projectRoot => {
    mkdirSync(join(projectRoot, "openspec"), { recursive: true });
    const configPath = join(projectRoot, "openspec", "config.yaml");
    writeFileSync(configPath, "schema: spec-driven\n# context: |\nfoo:\n  context: nested\n");

    installProject(projectRoot);

    const config = readFileSync(configPath, "utf8");
    assert.match(config, /^# context: \|$/m);
    assert.match(config, /^  context: nested$/m);
    assert.equal(countTopLevelContext(config), 1);
    assert.match(config, /语言：中文（简体）/);
  });
});
