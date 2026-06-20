import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { installProject, WORKFLOW_AGENTS, WORKFLOW_PROMPTS, WORKFLOW_SKILLS } from "../src/install.ts";

function withTempProject(fn: (projectRoot: string) => void): void {
  const projectRoot = mkdtempSync(join(tmpdir(), "superspec-install-test-"));
  try {
    fn(projectRoot);
  } finally {
    rmSync(projectRoot, { recursive: true, force: true });
  }
}

test("installProject installs engine, workflow skills, role prompts, and agents", () => {
  withTempProject(projectRoot => {
    const result = installProject(projectRoot);

    assert.equal(result.ok, true);
    assert.deepEqual(result.installed.skills, [...WORKFLOW_SKILLS]);
    assert.deepEqual(result.installed.prompts, [...WORKFLOW_PROMPTS]);
    assert.deepEqual(result.installed.agents, [...WORKFLOW_AGENTS]);
    assert.deepEqual(
      result.installed.agents.filter(agent => /-review\.toml$/.test(agent)),
      [],
    );
    assert.equal(result.installed.config, ".codex/config.toml");
    assert.equal(existsSync(join(projectRoot, ".superspec", "changes")), true);
    assert.equal(readFileSync(join(projectRoot, ".superspec", ".gitignore"), "utf8"), "changes/\n*.log\n*.tmp\n");

    for (const skill of WORKFLOW_SKILLS) {
      assert.equal(existsSync(join(projectRoot, ".codex", "skills", skill, "SKILL.md")), true, skill);
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
  });
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
    assert.equal(existsSync(join(projectRoot, ".codex", "skills", "superspec-explore", "SKILL.md")), true);
    assert.equal(existsSync(join(projectRoot, ".codex", "prompts", "executor.md")), true);
    assert.equal(existsSync(join(projectRoot, ".codex", "agents", "executor.toml")), true);
    assert.equal(existsSync(join(projectRoot, ".codex", "config.toml")), true);
  });
});
