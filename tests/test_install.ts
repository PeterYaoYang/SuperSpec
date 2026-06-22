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

test("CLI update refreshes installed workflow skills from bundled templates", () => {
  withTempProject(projectRoot => {
    installProject(projectRoot);
    const cli = new URL("../src/cli.ts", import.meta.url).pathname;
    const skillPath = join(projectRoot, ".codex", "skills", "superspec-explore", "SKILL.md");
    writeFileSync(skillPath, "stale skill template\n");
    writeFileSync(`${skillPath}.bak`, "older backup\n");

    const output = execFileSync(process.execPath, [cli, "update"], {
      cwd: projectRoot,
      encoding: "utf8",
    });
    const result = JSON.parse(output);

    assert.equal(result.ok, true);
    assert.equal(result.message, `SuperSpec ${PACKAGE_VERSION} 已更新项目工作流`);
    assert.deepEqual(result.installed.skills, [...WORKFLOW_SKILLS]);
    assert.equal(
      readFileSync(skillPath, "utf8"),
      readFileSync(new URL("../templates/workflow/skills/superspec-explore/SKILL.md", import.meta.url), "utf8"),
    );
    assert.equal(readFileSync(`${skillPath}.bak`, "utf8"), "stale skill template\n");
  });
});

test("CLI update bootstraps old projects and ignores legacy self-update flags", () => {
  withTempProject(projectRoot => {
    const cli = new URL("../src/cli.ts", import.meta.url).pathname;
    const output = execFileSync(process.execPath, [cli, "update", "--scope", "project", "--skip-self-update"], {
      cwd: projectRoot,
      encoding: "utf8",
    });
    const result = JSON.parse(output);

    assert.equal(result.ok, true);
    assert.equal(result.message, `SuperSpec ${PACKAGE_VERSION} 已更新项目工作流`);
    assert.deepEqual(result.installed.skills, [...WORKFLOW_SKILLS]);
    assert.equal(existsSync(join(projectRoot, ".superspec", "changes")), true);
    assert.equal(existsSync(join(projectRoot, ".codex", "skills", "superspec-explore", "SKILL.md")), true);
    assert.equal(existsSync(join(projectRoot, ".codex", "prompts", "executor.md")), true);
    assert.equal(existsSync(join(projectRoot, ".codex", "agents", "executor.toml")), true);
  });
});

test("CLI update allows legacy state while install still blocks it", () => {
  withTempProject(projectRoot => {
    mkdirSync(join(projectRoot, "openspec", "changes", "old-change", ".superspec"), { recursive: true });
    writeFileSync(join(projectRoot, "openspec", "changes", "old-change", ".superspec", "ledger.jsonl"), "{}\n");

    assert.throws(
      () => installProject(projectRoot),
      /检测到老版 SuperSpec/,
    );

    const cli = new URL("../src/cli.ts", import.meta.url).pathname;
    const output = execFileSync(process.execPath, [cli, "update", "--skip-self-update"], {
      cwd: projectRoot,
      encoding: "utf8",
    });
    const result = JSON.parse(output);

    assert.equal(result.ok, true);
    assert.equal(existsSync(join(projectRoot, ".superspec", "changes")), true);
    assert.equal(existsSync(join(projectRoot, ".codex", "skills", "superspec-propose", "SKILL.md")), true);
  });
});

test("installProject removes old managed superspec hook and keeps a backup", () => {
  withTempProject(projectRoot => {
    mkdirSync(join(projectRoot, ".codex"), { recursive: true });
    const hooksPath = join(projectRoot, ".codex", "hooks.json");
    const legacyHooks = {
      superspec: {
        managed: true,
        adapter_version: "superspec-hook@2",
      },
      hooks: {
        SubagentStart: [
          {
            matcher: ".*",
            hooks: [
              {
                type: "command",
                command: "superspec-hook --change \"$SUPERSPEC_CHANGE\"",
              },
            ],
          },
        ],
      },
    };
    writeFileSync(hooksPath, `${JSON.stringify(legacyHooks, null, 2)}\n`);

    installProject(projectRoot, { allowLegacyState: true });

    assert.equal(existsSync(hooksPath), false);
    assert.equal(readFileSync(`${hooksPath}.bak`, "utf8"), `${JSON.stringify(legacyHooks, null, 2)}\n`);
  });
});

test("installProject removes only old superspec hook commands from mixed hooks", () => {
  withTempProject(projectRoot => {
    mkdirSync(join(projectRoot, ".codex"), { recursive: true });
    const hooksPath = join(projectRoot, ".codex", "hooks.json");
    const mixedHooks = {
      superspec: {
        managed: true,
        adapter_version: "superspec-hook@2",
      },
      custom: {
        keep: true,
      },
      hooks: {
        SubagentStart: [
          {
            matcher: ".*",
            hooks: [
              {
                type: "command",
                command: "superspec-hook --change \"$SUPERSPEC_CHANGE\"",
              },
              {
                type: "command",
                command: "echo keep",
              },
            ],
          },
        ],
      },
    };
    writeFileSync(hooksPath, `${JSON.stringify(mixedHooks, null, 2)}\n`);

    installProject(projectRoot, { allowLegacyState: true });

    const migrated = readFileSync(hooksPath, "utf8");
    assert.equal(readFileSync(`${hooksPath}.bak`, "utf8"), `${JSON.stringify(mixedHooks, null, 2)}\n`);
    assert.doesNotMatch(migrated, /superspec-hook/);
    assert.match(migrated, /echo keep/);
    assert.match(migrated, /"custom"/);
  });
});

test("installProject leaves unmanaged hooks untouched", () => {
  withTempProject(projectRoot => {
    mkdirSync(join(projectRoot, ".codex"), { recursive: true });
    const hooksPath = join(projectRoot, ".codex", "hooks.json");
    const userHooks = {
      hooks: {
        Stop: [
          {
            matcher: ".*",
            hooks: [
              {
                type: "command",
                command: "echo user",
              },
            ],
          },
        ],
      },
    };
    writeFileSync(hooksPath, `${JSON.stringify(userHooks, null, 2)}\n`);

    installProject(projectRoot, { allowLegacyState: true });

    assert.equal(readFileSync(hooksPath, "utf8"), `${JSON.stringify(userHooks, null, 2)}\n`);
    assert.equal(existsSync(`${hooksPath}.bak`), false);
  });
});

test("installProject leaves malformed hooks untouched", () => {
  withTempProject(projectRoot => {
    mkdirSync(join(projectRoot, ".codex"), { recursive: true });
    const hooksPath = join(projectRoot, ".codex", "hooks.json");
    writeFileSync(hooksPath, "{ not json\n");

    installProject(projectRoot, { allowLegacyState: true });

    assert.equal(readFileSync(hooksPath, "utf8"), "{ not json\n");
    assert.equal(existsSync(`${hooksPath}.bak`), false);
  });
});

test("installProject leaves managed hooks without old superspec-hook commands untouched", () => {
  withTempProject(projectRoot => {
    mkdirSync(join(projectRoot, ".codex"), { recursive: true });
    const hooksPath = join(projectRoot, ".codex", "hooks.json");
    const managedWithoutLegacyCommand = {
      superspec: {
        managed: true,
        adapter_version: "superspec-hook@2",
      },
      hooks: {
        Stop: [
          {
            matcher: ".*",
            hooks: [
              {
                type: "command",
                command: "echo managed",
              },
            ],
          },
        ],
      },
    };
    writeFileSync(hooksPath, `${JSON.stringify(managedWithoutLegacyCommand, null, 2)}\n`);

    installProject(projectRoot, { allowLegacyState: true });

    assert.equal(readFileSync(hooksPath, "utf8"), `${JSON.stringify(managedWithoutLegacyCommand, null, 2)}\n`);
    assert.equal(existsSync(`${hooksPath}.bak`), false);
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
