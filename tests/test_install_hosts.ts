import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { installProject, WORKFLOW_MARKDOWN_AGENTS, WORKFLOW_ROLES, WORKFLOW_SKILLS } from "../src/install.ts";

const CLAUDE_BLOCK = "<!-- SUPERSPEC:CLAUDE:START -->\n@AGENTS.md\n<!-- SUPERSPEC:CLAUDE:END -->";
const SUPERSPEC_ALLOW = "Bash(superspec *)";
const READ_ONLY_CLAUDE_TOOLS = "Read, Grep, Glob, Bash";
const WRITING_CLAUDE_TOOLS = "Read, Grep, Glob, Bash, Edit, Write";

function withTempProject(fn: (projectRoot: string) => void): void {
  const projectRoot = mkdtempSync(join(tmpdir(), "superspec-hosts-test-"));
  try {
    fn(projectRoot);
  } finally {
    rmSync(projectRoot, { recursive: true, force: true });
  }
}

function runCli(args: string[], projectRoot: string, env: Record<string, string> = {}) {
  const run = spawnSync(process.execPath, [new URL("../src/cli.ts", import.meta.url).pathname, ...args], {
    cwd: projectRoot,
    encoding: "utf8",
    env: { SUPERSPEC_TEST_MODE: "1", ...env },
  });
  return { status: run.status, result: JSON.parse(run.stdout), stderr: run.stderr };
}

function parseFrontmatter(content: string): { fields: Record<string, string>; body: string } {
  const match = /^---\n([\s\S]*?)\n---\n/.exec(content);
  assert.ok(match, "missing frontmatter");
  const fields = Object.fromEntries(match[1].split("\n").map(line => {
    const separator = line.indexOf(":");
    return [line.slice(0, separator).trim(), line.slice(separator + 1).trim()];
  }));
  return { fields, body: content.slice(match[0].length) };
}

function parseTomlStrings(content: string): Record<string, string> {
  const fields: Record<string, string> = {};
  for (const match of content.matchAll(/^([a-z_]+) = ("(?:[^"\\]|\\.)*")$/gm)) {
    fields[match[1]] = JSON.parse(match[2]);
  }
  return fields;
}

function readJson(path: string): any {
  return JSON.parse(readFileSync(path, "utf8"));
}

function sha256(path: string): string {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

/** 安装完整性：frontmatter 键、tools、正文非空；不比对 Prompt 措辞。 */
function assertMarkdownAgentsInstalled(agentsDir: string, tools: { readOnly: string; writing: string }): void {
  for (const role of WORKFLOW_ROLES) {
    const content = readFileSync(join(agentsDir, `${role}.md`), "utf8");
    const { fields, body } = parseFrontmatter(content);
    assert.equal(fields.name, role);
    assert.ok(typeof fields.description === "string" && fields.description.length > 0, role);
    assert.equal(fields.tools, role === "executor" ? tools.writing : tools.readOnly, role);
    assert.equal(fields.model, undefined, role);
    assert.ok(body.trim().length >= 80, `${role} agent body missing role summary/prompt`);
    assert.equal(body.includes(".codex/"), false, `${role} 引用了该宿主未安装的 .codex 文件`);
  }
}

/** Skills 已安装且带 frontmatter；不冻结 SKILL.md 全文。 */
function assertSkillsInstalled(skillsDir: string, skills: readonly string[]): void {
  for (const skill of skills) {
    const path = join(skillsDir, skill, "SKILL.md");
    assert.equal(existsSync(path), true, skill);
    const { fields, body } = parseFrontmatter(readFileSync(path, "utf8"));
    assert.ok(fields.name || fields.description || body.trim().length > 0, `${skill} SKILL.md empty`);
  }
}

test("claude-only install 写入 Claude skills/agents/CLAUDE.md/权限，不写 .codex", () => {
  withTempProject(projectRoot => {
    const result = installProject(projectRoot, { hosts: ["claude"] });

    assert.deepEqual(result.installed.hosts, ["claude"]);
    assert.deepEqual(result.installed.skills, []);
    assert.deepEqual(result.installed.prompts, []);
    assert.deepEqual(result.installed.agents, []);
    assert.equal(result.installed.config, "");
    assert.deepEqual(result.installed.claude, {
      skills: [...WORKFLOW_SKILLS],
      agents: [...WORKFLOW_MARKDOWN_AGENTS],
      claude_md: { path: "CLAUDE.md", status: "created" },
      settings: { path: ".claude/settings.json", status: "added", reason: null },
    });
    assert.equal(existsSync(join(projectRoot, ".codex")), false);

    for (const skill of WORKFLOW_SKILLS) {
      assertSkillsInstalled(join(projectRoot, ".claude", "skills"), [skill]);
    }
    assertMarkdownAgentsInstalled(join(projectRoot, ".claude", "agents"), {
      readOnly: READ_ONLY_CLAUDE_TOOLS,
      writing: WRITING_CLAUDE_TOOLS,
    });
    assert.equal(readFileSync(join(projectRoot, "CLAUDE.md"), "utf8"), `${CLAUDE_BLOCK}\n`);
    assert.deepEqual(readJson(join(projectRoot, ".claude", "settings.json")), {
      permissions: { allow: [SUPERSPEC_ALLOW] },
    });
    assert.deepEqual(readJson(join(projectRoot, ".superspec", "config.json")), {
      workflow: { mode: "normal", hosts: ["claude"] },
    });

    const manifest = readJson(join(projectRoot, ".superspec", "install-manifest.json"));
    assert.deepEqual(manifest.hosts, ["claude"]);
    assert.equal(manifest.project_files.length, WORKFLOW_SKILLS.length + WORKFLOW_ROLES.length);
    for (const entry of manifest.project_files) {
      assert.equal(entry.sha256, sha256(join(projectRoot, entry.path)), entry.path);
      assert.deepEqual(entry.hosts, ["claude"]);
    }
    assert.deepEqual(manifest.claude_md, { path: "CLAUDE.md" });
    assert.deepEqual(manifest.claude_settings, {
      path: ".claude/settings.json",
      created_file: true,
      added_allow: [SUPERSPEC_ALLOW],
    });
  });
});

test("OMP agent 安装写入 Markdown agents，不含 .codex 引用", () => {
  withTempProject(projectRoot => {
    const ompHome = join(projectRoot, "omp-home");
    mkdirSync(ompHome);
    installProject(projectRoot, { hosts: ["omp"], ompHome });

    assertMarkdownAgentsInstalled(join(ompHome, "agents"), {
      readOnly: "read, grep, glob, bash",
      writing: "read, grep, glob, bash, edit, write",
    });
    const manifest = readJson(join(projectRoot, ".superspec", "install-manifest.json"));
    assert.deepEqual(
      manifest.external_files.map((entry: { path: string }) => entry.path),
      WORKFLOW_MARKDOWN_AGENTS.map(agent => join(ompHome, "agents", agent)),
    );
  });
});

test("Codex agent 保留 description、不绑定模型，并引用已安装的 prompt 路径", () => {
  withTempProject(projectRoot => {
    installProject(projectRoot, { hosts: ["codex"] });

    for (const role of WORKFLOW_ROLES) {
      const content = readFileSync(join(projectRoot, ".codex", "agents", `${role}.toml`), "utf8");
      const fields = parseTomlStrings(content);
      assert.equal(fields.name, role);
      assert.ok(typeof fields.description === "string" && fields.description.length > 0, role);
      assert.equal("model" in fields, false, role);
      assert.equal("model_reasoning_effort" in fields, false, role);
      assert.match(content, /^developer_instructions = """\n[\s\S]+\n"""\n$/m, role);

      const promptRefs = [...content.matchAll(/\.codex\/prompts\/[\w-]+\.md/g)].map(match => match[0]);
      assert.deepEqual([...new Set(promptRefs)], [`.codex/prompts/${role}.md`], role);
      assert.equal(existsSync(join(projectRoot, promptRefs[0])), true, role);
      const promptBody = readFileSync(join(projectRoot, promptRefs[0]), "utf8").trim();
      assert.ok(promptBody.length >= 80, `${role} prompt file empty`);
    }
  });
});

test("已有 CLAUDE.md 只追加受管区块，重复安装字节不变，区块被改后原位恢复", () => {
  withTempProject(projectRoot => {
    const claudeMdPath = join(projectRoot, "CLAUDE.md");
    const userContent = "# Team rules\n\n- keep me\n";
    writeFileSync(claudeMdPath, userContent);

    const first = installProject(projectRoot, { hosts: ["claude"] });
    const afterFirst = readFileSync(claudeMdPath, "utf8");
    assert.equal(first.installed.claude.claude_md?.status, "appended");
    assert.equal(afterFirst.startsWith(userContent), true);
    assert.equal(afterFirst.split(CLAUDE_BLOCK).length, 2);

    const second = installProject(projectRoot, { hosts: ["claude"] });
    assert.equal(second.installed.claude.claude_md?.status, "unchanged");
    assert.equal(readFileSync(claudeMdPath, "utf8"), afterFirst);

    const tampered = afterFirst.replace("@AGENTS.md", "@OTHER.md");
    writeFileSync(claudeMdPath, `${tampered}\n## after\n`);
    const third = installProject(projectRoot, { hosts: ["claude"] });
    assert.equal(third.installed.claude.claude_md?.status, "updated");
    assert.equal(readFileSync(claudeMdPath, "utf8"), `${afterFirst}\n## after\n`);
  });
});

test("CLAUDE.md 已有独立 @AGENTS.md import 时不重复添加区块", () => {
  withTempProject(projectRoot => {
    const claudeMdPath = join(projectRoot, "CLAUDE.md");
    const userContent = "# Rules\n@AGENTS.md\n";
    writeFileSync(claudeMdPath, userContent);

    const result = installProject(projectRoot, { hosts: ["claude"] });

    assert.equal(result.installed.claude.claude_md?.status, "already_imported");
    assert.equal(readFileSync(claudeMdPath, "utf8"), userContent);
    assert.equal(readJson(join(projectRoot, ".superspec", "install-manifest.json")).claude_md, null);

    const switched = installProject(projectRoot, { hosts: ["codex"] });
    assert.equal(readFileSync(claudeMdPath, "utf8"), userContent);
    assert.equal(switched.installed.removal.removed.some(item => item.startsWith("CLAUDE.md")), false);
  });
});

test("Claude 权限合并保留已有设置，重复安装不重复写入", () => {
  withTempProject(projectRoot => {
    const settingsPath = join(projectRoot, ".claude", "settings.json");
    mkdirSync(join(projectRoot, ".claude"));
    const existing = {
      model: "sonnet",
      env: { FOO: "bar" },
      permissions: { allow: ["Bash(npm test)"], deny: ["Read(.env)"] },
    };
    writeFileSync(settingsPath, `${JSON.stringify(existing, null, 2)}\n`);

    const first = installProject(projectRoot, { hosts: ["claude"] });
    assert.equal(first.installed.claude.settings?.status, "added");
    assert.deepEqual(readJson(settingsPath), {
      ...existing,
      permissions: { allow: ["Bash(npm test)", SUPERSPEC_ALLOW], deny: ["Read(.env)"] },
    });

    const afterFirst = readFileSync(settingsPath, "utf8");
    const second = installProject(projectRoot, { hosts: ["claude"] });
    assert.equal(second.installed.claude.settings?.status, "unchanged");
    assert.equal(readFileSync(settingsPath, "utf8"), afterFirst);
    assert.deepEqual(readJson(join(projectRoot, ".superspec", "install-manifest.json")).claude_settings, {
      path: ".claude/settings.json",
      created_file: false,
      added_allow: [SUPERSPEC_ALLOW],
    });
  });
});

test("用户自己已有的 superspec 许可不记为 SuperSpec 所有，移除宿主时保留", () => {
  withTempProject(projectRoot => {
    const settingsPath = join(projectRoot, ".claude", "settings.json");
    mkdirSync(join(projectRoot, ".claude"));
    const existing = `${JSON.stringify({ permissions: { allow: [SUPERSPEC_ALLOW] } }, null, 2)}\n`;
    writeFileSync(settingsPath, existing);

    const result = installProject(projectRoot, { hosts: ["claude"] });
    assert.equal(result.installed.claude.settings?.status, "unchanged");
    assert.equal(readJson(join(projectRoot, ".superspec", "install-manifest.json")).claude_settings, null);

    installProject(projectRoot, { hosts: ["codex"] });
    assert.equal(readFileSync(settingsPath, "utf8"), existing);
  });
});

test("无效或非 object 的 settings.json 不修改并报告跳过原因", () => {
  for (const invalid of ["{ not json\n", "[]\n", "{\"permissions\": {\"allow\": \"Bash\"}}\n"]) {
    withTempProject(projectRoot => {
      const settingsPath = join(projectRoot, ".claude", "settings.json");
      mkdirSync(join(projectRoot, ".claude"));
      writeFileSync(settingsPath, invalid);

      const result = installProject(projectRoot, { hosts: ["claude"] });

      assert.equal(result.ok, true);
      assert.equal(result.installed.claude.settings?.status, "skipped", invalid);
      assert.ok(result.installed.claude.settings?.reason, invalid);
      assert.equal(readFileSync(settingsPath, "utf8"), invalid);
    });
  }
});

test("CLI --no-claude-permissions 生效并在 update 中保持，--claude-permissions 恢复", () => {
  withTempProject(projectRoot => {
    const settingsPath = join(projectRoot, ".claude", "settings.json");
    const configPath = join(projectRoot, ".superspec", "config.json");

    const install = runCli(["install", "--skip-self-update", "--hosts", "claude", "--no-claude-permissions"], projectRoot);
    assert.equal(install.status, 0, install.stderr);
    assert.equal(install.result.installed.claude.settings.status, "disabled");
    assert.equal(existsSync(settingsPath), false);
    assert.equal(readJson(configPath).workflow.claude_permissions, false);

    const update = runCli(["update", "--skip-self-update"], projectRoot);
    assert.equal(update.status, 0, update.stderr);
    assert.deepEqual(update.result.installed.hosts, ["claude"]);
    assert.equal(update.result.installed.claude.settings.status, "disabled");
    assert.equal(existsSync(settingsPath), false);

    const enable = runCli(["update", "--skip-self-update", "--claude-permissions"], projectRoot);
    assert.equal(enable.status, 0, enable.stderr);
    assert.equal(enable.result.installed.claude.settings.status, "added");
    assert.deepEqual(readJson(settingsPath).permissions.allow, [SUPERSPEC_ALLOW]);
    assert.equal(readJson(configPath).workflow.claude_permissions, undefined);

    const conflict = runCli(["update", "--skip-self-update", "--claude-permissions", "--no-claude-permissions"], projectRoot);
    assert.equal(conflict.status, 1);
    assert.equal(conflict.result.ok, false);

    const valued = runCli(["update", "--skip-self-update", "--claude-permissions", "false"], projectRoot);
    assert.equal(valued.status, 1);
    assert.equal(valued.result.ok, false);
    assert.deepEqual(readJson(settingsPath).permissions.allow, [SUPERSPEC_ALLOW]);
  });
});

test("关闭 Claude 权限时撤回 SuperSpec 添加的许可并保留用户条目", () => {
  withTempProject(projectRoot => {
    const settingsPath = join(projectRoot, ".claude", "settings.json");
    mkdirSync(join(projectRoot, ".claude"));
    writeFileSync(settingsPath, `${JSON.stringify({ permissions: { allow: ["Bash(npm test)"] } })}\n`);
    installProject(projectRoot, { hosts: ["claude"] });

    const result = installProject(projectRoot, { hosts: ["claude"], claudePermissions: false });

    assert.equal(result.installed.claude.settings?.status, "disabled");
    assert.deepEqual(readJson(settingsPath), { permissions: { allow: ["Bash(npm test)"] } });
    assert.deepEqual(result.installed.removal.removed, [`.claude/settings.json#permissions.allow:${SUPERSPEC_ALLOW}`]);
  });
});

test("codex+claude 切到 codex 删除未修改的 Claude 受管内容并保留用户修改", () => {
  withTempProject(projectRoot => {
    const claudeMdPath = join(projectRoot, "CLAUDE.md");
    const settingsPath = join(projectRoot, ".claude", "settings.json");
    writeFileSync(claudeMdPath, "# Team rules\n");
    mkdirSync(join(projectRoot, ".claude"));
    writeFileSync(settingsPath, `${JSON.stringify({ permissions: { allow: ["Bash(npm test)"] } })}\n`);
    installProject(projectRoot, { hosts: ["codex", "claude"] });
    const modifiedAgent = join(projectRoot, ".claude", "agents", "critic.md");
    writeFileSync(modifiedAgent, "my own critic\n");

    const result = installProject(projectRoot, { hosts: ["codex"] });
    const { removal } = result.installed;

    assert.deepEqual(result.installed.claude, { skills: [], agents: [], claude_md: null, settings: null });
    assert.deepEqual(removal.kept_modified, [".claude/agents/critic.md"]);
    assert.equal(readFileSync(modifiedAgent, "utf8"), "my own critic\n");
    for (const role of WORKFLOW_ROLES.filter(role => role !== "critic")) {
      assert.equal(existsSync(join(projectRoot, ".claude", "agents", `${role}.md`)), false, role);
      assert.ok(removal.removed.includes(`.claude/agents/${role}.md`), role);
    }
    assert.equal(existsSync(join(projectRoot, ".claude", "skills")), false);
    assert.equal(readFileSync(claudeMdPath, "utf8"), "# Team rules\n");
    assert.deepEqual(readJson(settingsPath), { permissions: { allow: ["Bash(npm test)"] } });
    for (const skill of WORKFLOW_SKILLS) {
      assert.equal(existsSync(join(projectRoot, ".codex", "skills", skill, "SKILL.md")), true, skill);
    }
    assert.equal(existsSync(join(projectRoot, ".codex", "agents", "critic.toml")), true);

    const manifest = readJson(join(projectRoot, ".superspec", "install-manifest.json"));
    assert.deepEqual(manifest.hosts, ["codex"]);
    assert.equal(manifest.project_files.some((entry: { path: string }) => entry.path.startsWith(".claude/")), false);
    assert.equal(manifest.claude_md, null);
    assert.equal(manifest.claude_settings, null);
  });
});

test("claude-only 切到 codex 时删除 SuperSpec 创建的 CLAUDE.md、settings.json 和空目录", () => {
  withTempProject(projectRoot => {
    installProject(projectRoot, { hosts: ["claude"] });

    const result = installProject(projectRoot, { hosts: ["codex"] });

    assert.equal(existsSync(join(projectRoot, ".claude")), false);
    assert.equal(existsSync(join(projectRoot, "CLAUDE.md")), false);
    assert.ok(result.installed.removal.removed.includes("CLAUDE.md"));
    assert.ok(result.installed.removal.removed.includes(".claude/settings.json"));
    assert.deepEqual(result.installed.removal.kept_modified, []);
  });
});

test("codex 切到 omp 保留共享 .codex/skills，移除 Codex 专属文件并报告 config.toml", () => {
  withTempProject(projectRoot => {
    const ompHome = join(projectRoot, "omp-home");
    mkdirSync(ompHome);
    installProject(projectRoot, { hosts: ["codex"] });
    const skillPath = join(projectRoot, ".codex", "skills", "superspec-explore", "SKILL.md");
    const skillBefore = readFileSync(skillPath, "utf8");

    const result = installProject(projectRoot, { hosts: ["omp"], ompHome });

    assert.equal(readFileSync(skillPath, "utf8"), skillBefore);
    assert.equal(existsSync(join(projectRoot, ".codex", "prompts")), false);
    assert.equal(existsSync(join(projectRoot, ".codex", "agents")), false);
    assert.equal(existsSync(join(projectRoot, ".codex", "config.toml")), true);
    assert.deepEqual(result.installed.removal.kept_shared_config, [".codex/config.toml"]);
    assert.equal(result.installed.removal.removed.some(path => path.startsWith(".codex/skills/")), false);
  });
});

test("omp 切到 claude 删除 .codex/skills，OMP 用户目录 agent 只报告不删除", () => {
  withTempProject(projectRoot => {
    const ompHome = join(projectRoot, "omp-home");
    mkdirSync(ompHome);
    installProject(projectRoot, { hosts: ["omp"], ompHome });

    const result = installProject(projectRoot, { hosts: ["claude"] });

    assert.equal(existsSync(join(projectRoot, ".codex")), false);
    assert.deepEqual(
      result.installed.removal.not_removed_external,
      WORKFLOW_MARKDOWN_AGENTS.map(agent => join(ompHome, "agents", agent)),
    );
    for (const agent of WORKFLOW_MARKDOWN_AGENTS) {
      assert.equal(existsSync(join(ompHome, "agents", agent)), true, agent);
    }
  });
});

test("没有安装清单的旧项目切换宿主时不清理，只写入清单", () => {
  withTempProject(projectRoot => {
    installProject(projectRoot, { hosts: ["codex"] });
    const manifestPath = join(projectRoot, ".superspec", "install-manifest.json");
    rmSync(manifestPath);

    const result = installProject(projectRoot, { hosts: ["claude"] });

    assert.deepEqual(result.installed.removal, {
      removed: [],
      kept_modified: [],
      not_removed_external: [],
      kept_shared_config: [],
    });
    assert.equal(existsSync(join(projectRoot, ".codex", "agents", "executor.toml")), true);
    assert.equal(existsSync(join(projectRoot, ".codex", "skills", "superspec-apply", "SKILL.md")), true);
    assert.deepEqual(readJson(manifestPath).hosts, ["claude"]);
  });
});

test("CLI 宿主选择支持 Claude Code 编号、别名与 all/both", () => {
  const cases: Array<[string, string[]]> = [
    ["3", ["claude"]],
    ["claude-code", ["claude"]],
    ["1,3", ["codex", "claude"]],
    ["both", ["codex", "omp"]],
    ["all", ["codex", "omp", "claude"]],
  ];
  for (const [answer, expected] of cases) {
    withTempProject(projectRoot => {
      const ompHome = join(projectRoot, "omp-home");
      mkdirSync(ompHome);
      const run = runCli(["install", "--skip-self-update", "--omp-home", ompHome], projectRoot, {
        SUPERSPEC_TEST_ASSUME_TTY: "1",
        SUPERSPEC_TEST_HOSTS_ANSWER: answer,
      });
      assert.equal(run.status, 0, run.stderr);
      assert.deepEqual(run.result.installed.hosts, expected, answer);
    });
  }

  withTempProject(projectRoot => {
    const run = runCli(["install", "--skip-self-update", "--hosts", "claude-code"], projectRoot);
    assert.equal(run.status, 0, run.stderr);
    assert.deepEqual(run.result.installed.hosts, ["claude"]);
    assert.deepEqual(readJson(join(projectRoot, ".superspec", "config.json")).workflow.hosts, ["claude"]);
  });
});

test("omp+claude 同时安装时两套 skills 都写入", () => {
  withTempProject(projectRoot => {
    const ompHome = join(projectRoot, "omp-home");
    mkdirSync(ompHome);
    const result = installProject(projectRoot, { hosts: ["omp", "claude"], ompHome });

    assert.deepEqual(result.installed.skills, [...WORKFLOW_SKILLS]);
    assert.deepEqual(result.installed.claude.skills, [...WORKFLOW_SKILLS]);
    for (const skill of WORKFLOW_SKILLS) {
      assert.equal(existsSync(join(projectRoot, ".codex", "skills", skill, "SKILL.md")), true, skill);
      assert.equal(existsSync(join(projectRoot, ".claude", "skills", skill, "SKILL.md")), true, skill);
    }
    assert.equal(existsSync(join(projectRoot, ".codex", "agents")), false);
  });
});
