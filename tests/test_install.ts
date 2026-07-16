import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { installProject, WORKFLOW_AGENTS, WORKFLOW_PROMPTS, WORKFLOW_SKILLS } from "../src/install.ts";

const PACKAGE_VERSION = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")).version as string;
const OPENSPEC_REQUIRED_VERSION = "1.4.1";
const AGENTS_TEMPLATE = readFileSync(new URL("../templates/workflow/AGENTS.md", import.meta.url), "utf8").trimEnd();
const EXPECTED_WORKFLOW_AGENTS = [
  "architect.toml",
  "code-reviewer.toml",
  "critic.toml",
  "executor.toml",
  "explore.toml",
  "test-engineer.toml",
  "test-runner.toml",
  "verifier.toml",
] as const;

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

function cliPath(): string {
  return new URL("../src/cli.ts", import.meta.url).pathname;
}

function runCli(args: string[], projectRoot: string, env: Record<string, string> = {}) {
  return spawnSync(process.execPath, [cliPath(), ...args], {
    cwd: projectRoot,
    encoding: "utf8",
    env: {
      ...process.env,
      ...env,
    },
  });
}

function testEnv(env: Record<string, string> = {}): Record<string, string> {
  return {
    SUPERSPEC_TEST_MODE: "1",
    ...env,
  };
}

function writeExecutable(filePath: string, content: string): void {
  writeFileSync(filePath, content);
  chmodSync(filePath, 0o755);
}

function writeWindowsCmdShim(binDir: string, commandLog: string): void {
  const escapedLog = commandLog.replace(/'/g, "'\\''");
  writeExecutable(join(binDir, "cmd.exe"), `#!/bin/sh
echo "cmd.exe $@" >> '${escapedLog}'
if [ "$1" = "/d" ]; then shift; fi
if [ "$1" = "/s" ]; then shift; fi
if [ "$1" = "/c" ]; then shift; fi
exec "$@"
`);
}

test("installProject installs engine, workflow skills, role prompts, and agents", () => {
  withTempProject(projectRoot => {
    assert.deepEqual(WORKFLOW_AGENTS, EXPECTED_WORKFLOW_AGENTS);
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
    assert.equal(result.installed.workflow_config, ".superspec/config.json");
    assert.equal(result.installed.agents_md, "AGENTS.md");
    assert.equal(result.installed.openspec_config, "openspec/config.yaml");
    assert.equal(existsSync(join(projectRoot, ".superspec", "changes")), true);
    assert.deepEqual(JSON.parse(readFileSync(join(projectRoot, ".superspec", "config.json"), "utf8")), {
      workflow: { mode: "normal" },
    });
    assert.equal(readFileSync(join(projectRoot, ".superspec", ".gitignore"), "utf8"), "changes/\n*.log\n*.tmp\n");

    for (const skill of WORKFLOW_SKILLS) {
      const skillPath = join(projectRoot, ".codex", "skills", skill, "SKILL.md");
      assert.equal(existsSync(skillPath), true, skill);
      assert.match(readFileSync(skillPath, "utf8"), /^---\n[\s\S]*?\n---\n/, `${skill} should keep YAML frontmatter`);
    }
    assert.equal(existsSync(join(projectRoot, ".codex", "skills", "superspec-archive")), false);
    for (const prompt of WORKFLOW_PROMPTS) {
      assert.equal(existsSync(join(projectRoot, ".codex", "prompts", prompt)), true, prompt);
    }
    const installedSkillAndPromptSurfaces = [
      ...WORKFLOW_SKILLS.map(skill => [skill, readFileSync(join(projectRoot, ".codex", "skills", skill, "SKILL.md"), "utf8")] as const),
      ...WORKFLOW_PROMPTS.map(prompt => [prompt, readFileSync(join(projectRoot, ".codex", "prompts", prompt), "utf8")] as const),
    ];
    for (const [surface, content] of installedSkillAndPromptSurfaces) {
      assert.doesNotMatch(
        content,
        /状态机|job packet|task-start|snapshot|冻结|RED\/GREEN|scope|event|gate|propose_to_apply|mock|fake|seam|adapter|fixture|--self-test-fix/,
        surface,
      );
    }
    const installedAgentsMd = readFileSync(join(projectRoot, "AGENTS.md"), "utf8");
    assert.match(installedAgentsMd, /只有当用户显式调用 `superspec-\*`/);
    assert.match(installedAgentsMd, /不得自行启动工作流、创建 change、执行 `transition next`/);
    assert.doesNotMatch(
      installedAgentsMd,
      /状态机|job packet|task-start|snapshot|冻结|RED\/GREEN|scope|event|gate|propose_to_apply|mock|fake|seam|adapter|fixture/,
      "AGENTS.md",
    );
    for (const skill of WORKFLOW_SKILLS) {
      const content = readFileSync(join(projectRoot, ".codex", "skills", skill, "SKILL.md"), "utf8");
      assert.match(content, /^description: "仅在用户显式调用 \$superspec-/m, skill);
      assert.match(content, /不得自动触发。"$/m, skill);
    }
    for (const agent of WORKFLOW_AGENTS) {
      const agentPath = join(projectRoot, ".codex", "agents", agent);
      assert.equal(existsSync(agentPath), true, agent);
      const content = readFileSync(agentPath, "utf8");
      assert.match(content, /^model_reasoning_effort = "medium"$/m, agent);
      assert.doesNotMatch(content, /^model_reasoning_effort = "high"$/m, agent);
    }

    const proposeSkill = readFileSync(join(projectRoot, ".codex", "skills", "superspec-propose", "SKILL.md"), "utf8");
    assert.match(proposeSkill, /Skill 提供作者模板；工作流反馈材料问题时按反馈修正/);
    assert.match(proposeSkill, /只把用户已确认的行为、边界和有证据的风险写成计划/);
    assert.match(proposeSkill, /验证要求由工作流决定，计划不预设执行步骤/);
    assert.match(proposeSkill, /审查意见是独立证据，不会自动创造需求/);
    assert.match(proposeSkill, /每个普通 task 紧跟 `执行依据:`，显式写 `测试`、`设计`、`来源`、`验收`、`边界`/);
    assert.match(proposeSkill, /回同一 change 的 Explore 澄清/);
    assert.match(proposeSkill, /- 交付: <用户或系统可观察的端到端结果/);
    assert.match(proposeSkill, /- 依赖: <无 \/ 真正的前置任务>/);
    assert.match(proposeSkill, /按已确认的用户结果组织计划/);
    assert.match(proposeSkill, /task 优先按垂直交付拆分/);
    assert.match(proposeSkill, /只要计划包含 task/);
    assert.doesNotMatch(proposeSkill, /## 待用户确认/);
    assert.doesNotMatch(proposeSkill, /tdd_required|review_rejection|task-start|RED\/GREEN|mock|adapter|seam/);

    const applySkill = readFileSync(join(projectRoot, ".codex", "skills", "superspec-apply", "SKILL.md"), "utf8");
    assert.match(applySkill, /只执行当前返回的事项/);
    assert.match(applySkill, /测试描述调用方得到的能力，不把内部实现过程当成验收/);
    assert.match(applySkill, /预期来自规格、示例或可独立复核的结果，不复刻实现逻辑/);
    assert.match(applySkill, /优先沿用仓库已有的验证边界，证明用户或调用方可观察的结果/);
    assert.match(applySkill, /不为方便测试改变生产设计，也不把测试偏好升级为额外的开发步骤或测试义务/);
    assert.match(applySkill, /按工作流安排修复/);
    assert.doesNotMatch(applySkill, /task-start|RED\/GREEN|mock|fake|seam|adapter|fixture|--self-test-fix/);

    const exploreSkill = readFileSync(join(projectRoot, ".codex", "skills", "superspec-explore", "SKILL.md"), "utf8");
    assert.match(exploreSkill, /形成基于证据的 `discovery\.md`/);
    assert.match(exploreSkill, /主流程必须委派 `explore` subagent/);
    assert.match(exploreSkill, /事实应能追溯到源码、文档、命令输出或用户确认/);
    assert.match(exploreSkill, /审查意见用于补足证据，不自动创造新范围、新需求或新方案/);
    assert.match(exploreSkill, /## 待确认问题[\s\S]*- \[ \] Q-001/);
    assert.match(exploreSkill, /每轮先给当前事项的简短理解和决策信息/);
    assert.match(exploreSkill, /不要在用户对话中展示文档编号/);
    assert.match(exploreSkill, /不要只转述问题/);
    assert.match(exploreSkill, /按“事实自己查，决定交给用户”的顺序工作/);
    assert.match(exploreSkill, /只围绕这一件事提问并等待答复/);
    assert.doesNotMatch(exploreSkill, /`Q-xxx` 只是|当前问题的有效答复后|决定事件/);
    assert.doesNotMatch(exploreSkill, /给 subagent 的深扫任务书|对照 critic 的 Discovery 审查阻塞条件|review_rejection/);

    for (const prompt of ["critic.md", "architect.md"]) {
      const content = readFileSync(join(projectRoot, ".codex", "prompts", prompt), "utf8");
      assert.match(content, /不要因标题/, prompt);
      assert.match(content, /仅当/, prompt);
      assert.doesNotMatch(content, /状态机|job packet|JSON 报告按 job packet|每个新 finding 必须分配稳定 ID/, prompt);
    }

    const architectPrompt = readFileSync(join(projectRoot, ".codex", "prompts", "architect.md"), "utf8");
    assert.match(architectPrompt, /未改变的既有风险和理论故障不是 blocker/);
    assert.match(architectPrompt, /只审查本次接入是否破坏现有契约/);
    const criticPrompt = readFileSync(join(projectRoot, ".codex", "prompts", "critic.md"), "utf8");
    assert.match(criticPrompt, /技术路线优劣交给 Architect/);
    assert.match(criticPrompt, /范围判断、已声明验收/);
    assert.doesNotMatch(criticPrompt, /openspec validate <change>|执行依据语义审查/);
    const testEngineerPrompt = readFileSync(join(projectRoot, ".codex", "prompts", "test-engineer.md"), "utf8");
    assert.match(testEngineerPrompt, /通用故障矩阵和审查建议不能自行升级为必须新增的测试/);
    assert.match(testEngineerPrompt, /测试应证明用户或调用方可观察的结果/);
    assert.doesNotMatch(testEngineerPrompt, /状态机|job packet|RED\/GREEN|mock|fake|seam|表头含 `test_id` 和 `scenario`|执行依据/);

    const config = readFileSync(join(projectRoot, ".codex", "config.toml"), "utf8");
    assert.match(config, /\[features\]/);
    assert.match(config, /multi_agent = true/);
    assert.match(config, /child_agents_md = true/);
    assert.match(config, /\[agents\]/);
    assert.match(config, /max_threads = 12/);
    assert.match(config, /max_depth = 1/);

    const agentsMd = readFileSync(join(projectRoot, "AGENTS.md"), "utf8");
    assert.equal(agentsMd.trimEnd(), AGENTS_TEMPLATE);
    assert.match(agentsMd, /在用户已显式启动工作流或明确指定 change 后/);
    assert.match(agentsMd, /先确定对应 change；归属明确则回同一 change 的 `propose` 更新计划/);
    assert.match(agentsMd, /不要另建 repair change/);
    assert.match(agentsMd, /归属不明才询问/);
    assert.match(agentsMd, /主流程代为执行必要的工作流操作/);
    assert.match(agentsMd, /Explore 中需要用户决定业务、验收、范围或关键取舍时/);
    assert.match(agentsMd, /不得把这类答复默认写入 discovery/);
    assert.match(agentsMd, /--self-test-fix "<task>"/);
    assert.match(agentsMd, /每完成 `next` 返回的当前事项/);
    assert.match(agentsMd, /完成单个事项不等于完成整个 change/);
    assert.match(agentsMd, /SUPERSPEC:AGENTS:START/);
    assert.match(agentsMd, /superspec transition next --change "<change>"/);
    assert.match(agentsMd, /用户可见回复使用自然语言/);
    assert.doesNotMatch(agentsMd, /reviewer\.kind\/id/);
    assert.doesNotMatch(agentsMd, /external-agent/);

    const openspecConfig = readFileSync(join(projectRoot, "openspec", "config.yaml"), "utf8");
    assert.match(openspecConfig, /^schema: spec-driven$/m);
    assert.match(openspecConfig, /^context: \|$/m);
    assert.match(openspecConfig, /语言：中文（简体）/);
    assert.match(openspecConfig, /所有产出物必须用简体中文撰写/);
    assert.doesNotMatch(openspecConfig, /^\s*language\s*:/m);
  });
});

test("CLI version reads package.json version", () => {
  const output = execFileSync(process.execPath, [cliPath(), "--version"], {
    encoding: "utf8",
  });

  assert.equal(output.trim(), `SuperSpec ${PACKAGE_VERSION}`);
});

test("CLI init --scope project is a compatibility alias for install", () => {
  withTempProject(projectRoot => {
    const output = execFileSync(process.execPath, [cliPath(), "init", "--scope", "project"], {
      cwd: projectRoot,
      encoding: "utf8",
      env: testEnv(),
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
    assert.equal(existsSync(join(projectRoot, "AGENTS.md")), true);
    assert.equal(existsSync(join(projectRoot, "openspec", "config.yaml")), true);
    assert.deepEqual(result.openspec, {
      package: "@fission-ai/openspec",
      required_version: OPENSPEC_REQUIRED_VERSION,
      before: OPENSPEC_REQUIRED_VERSION,
      after: OPENSPEC_REQUIRED_VERSION,
      action: "already_satisfied",
    });
  });
});

test("CLI init installs pinned OpenSpec when CLI is missing", () => {
  withTempProject(projectRoot => {
    const output = execFileSync(process.execPath, [cliPath(), "init", "--scope", "project"], {
      cwd: projectRoot,
      encoding: "utf8",
      env: testEnv({
        SUPERSPEC_TEST_OPENSPEC_VERSION_SEQUENCE: `missing|${OPENSPEC_REQUIRED_VERSION}`,
        SUPERSPEC_TEST_SKIP_OPENSPEC_INSTALL: "1",
      }),
    });
    const result = JSON.parse(output);

    assert.equal(result.ok, true);
    assert.deepEqual(result.openspec, {
      package: "@fission-ai/openspec",
      required_version: OPENSPEC_REQUIRED_VERSION,
      before: null,
      after: OPENSPEC_REQUIRED_VERSION,
      action: "installed",
    });
    assert.equal(existsSync(join(projectRoot, ".codex", "skills", "superspec-explore", "SKILL.md")), true);
  });
});

test("CLI init installs OpenSpec through cmd.exe on Windows", () => {
  withTempProject(projectRoot => {
    const binDir = join(projectRoot, "bin");
    mkdirSync(binDir, { recursive: true });
    const commandLog = join(projectRoot, "commands.log");
    const escapedLog = commandLog.replace(/'/g, "'\\''");
    writeWindowsCmdShim(binDir, commandLog);
    writeExecutable(join(binDir, "npm.cmd"), `#!/bin/sh
echo "npm.cmd $@" >> '${escapedLog}'
if [ "$1" = "install" ]; then
  exit 0
fi
echo "unexpected npm.cmd $@" >&2
exit 1
`);

    const output = execFileSync(process.execPath, [cliPath(), "init", "--scope", "project"], {
      cwd: projectRoot,
      encoding: "utf8",
      env: testEnv({
        SUPERSPEC_TEST_PLATFORM: "win32",
        SUPERSPEC_TEST_OPENSPEC_VERSION_SEQUENCE: `missing|${OPENSPEC_REQUIRED_VERSION}`,
        PATH: `${binDir}:${process.env.PATH ?? ""}`,
      }),
    });
    const result = JSON.parse(output);
    const log = readFileSync(commandLog, "utf8");

    assert.equal(result.ok, true);
    assert.deepEqual(result.openspec, {
      package: "@fission-ai/openspec",
      required_version: OPENSPEC_REQUIRED_VERSION,
      before: null,
      after: OPENSPEC_REQUIRED_VERSION,
      action: "installed",
    });
    assert.match(log, /^cmd\.exe \/d \/s \/c npm\.cmd install -g @fission-ai\/openspec@1\.4\.1$/m);
    assert.match(log, /^npm\.cmd install -g @fission-ai\/openspec@1\.4\.1$/m);
  });
});

test("CLI update upgrades OpenSpec when version differs", () => {
  withTempProject(projectRoot => {
    const output = execFileSync(process.execPath, [cliPath(), "update", "--skip-self-update"], {
      cwd: projectRoot,
      encoding: "utf8",
      env: testEnv({
        SUPERSPEC_TEST_OPENSPEC_VERSION_SEQUENCE: `1.0.0|${OPENSPEC_REQUIRED_VERSION}`,
        SUPERSPEC_TEST_SKIP_OPENSPEC_INSTALL: "1",
      }),
    });
    const result = JSON.parse(output);

    assert.equal(result.ok, true);
    assert.equal(result.message, `SuperSpec ${PACKAGE_VERSION} 已更新项目工作流`);
    assert.deepEqual(result.openspec, {
      package: "@fission-ai/openspec",
      required_version: OPENSPEC_REQUIRED_VERSION,
      before: "1.0.0",
      after: OPENSPEC_REQUIRED_VERSION,
      action: "updated",
    });
  });
});

test("CLI init returns structured error when OpenSpec install fails", () => {
  withTempProject(projectRoot => {
    const run = runCli(["init", "--scope", "project"], projectRoot, testEnv({
      SUPERSPEC_TEST_OPENSPEC_VERSION_SEQUENCE: "missing",
      SUPERSPEC_TEST_OPENSPEC_INSTALL_ERROR: "permission denied",
    }));
    const result = JSON.parse(run.stdout);

    assert.equal(run.status, 1);
    assert.equal(result.ok, false);
    assert.match(result.message, /permission denied/);
    assert.deepEqual(result.openspec, {
      package: "@fission-ai/openspec",
      required_version: OPENSPEC_REQUIRED_VERSION,
      before: null,
      after: null,
      action: "failed",
      phase: "global_install",
    });
  });
});

test("CLI init 非交互模式不触发自升级提示", () => {
  withTempProject(projectRoot => {
    const output = execFileSync(process.execPath, [cliPath(), "init", "--scope", "project"], {
      cwd: projectRoot,
      encoding: "utf8",
      env: testEnv({
        SUPERSPEC_TEST_LATEST_VERSION: "99.0.0",
        SUPERSPEC_TEST_SKIP_GLOBAL_INSTALL: "1",
      }),
    });
    const result = JSON.parse(output);

    assert.equal(result.ok, true);
    assert.equal(result.self_update, undefined);
    assert.equal(result.message, `SuperSpec ${PACKAGE_VERSION} 已安装`);
    assert.equal(existsSync(join(projectRoot, ".codex", "skills", "superspec-explore", "SKILL.md")), true);
  });
});

test("CLI init 交互选择 no 时继续当前版本安装", () => {
  withTempProject(projectRoot => {
    const output = execFileSync(process.execPath, [cliPath(), "init", "--scope", "project"], {
      cwd: projectRoot,
      encoding: "utf8",
      env: testEnv({
        SUPERSPEC_TEST_ASSUME_TTY: "1",
        SUPERSPEC_TEST_PROMPT_ANSWER: "no",
        SUPERSPEC_TEST_LATEST_VERSION: "99.0.0",
      }),
    });
    const result = JSON.parse(output);

    assert.equal(result.ok, true);
    assert.equal(result.self_update, undefined);
    assert.equal(result.message, `SuperSpec ${PACKAGE_VERSION} 已安装`);
  });
});

test("CLI init 交互默认 yes 时升级并递归运行新版 CLI", () => {
  withTempProject(projectRoot => {
    const rerunPayload = {
      ok: true,
      message: "SuperSpec 99.0.0 已安装",
      installed: {
        engine_dir: ".superspec/",
        skills: [...WORKFLOW_SKILLS],
        prompts: [...WORKFLOW_PROMPTS],
        agents: [...WORKFLOW_AGENTS],
        config: ".codex/config.toml",
        workflow_config: ".superspec/config.json",
        openspec_config: "openspec/config.yaml",
      },
    };
    const output = execFileSync(process.execPath, [cliPath(), "init", "--scope", "project"], {
      cwd: projectRoot,
      encoding: "utf8",
      env: testEnv({
        SUPERSPEC_TEST_ASSUME_TTY: "1",
        SUPERSPEC_TEST_PROMPT_ANSWER: "",
        SUPERSPEC_TEST_LATEST_VERSION: "99.0.0",
        SUPERSPEC_TEST_SKIP_GLOBAL_INSTALL: "1",
        SUPERSPEC_TEST_CLI_VERSION: "99.0.0",
        SUPERSPEC_TEST_RERUN_OUTPUT: JSON.stringify(rerunPayload),
      }),
    });
    const result = JSON.parse(output);

    assert.equal(result.ok, true);
    assert.equal(result.message, "SuperSpec 99.0.0 已安装");
    assert.deepEqual(result.self_update, {
      updated: true,
      from: PACKAGE_VERSION,
      to: "99.0.0",
    });
  });
});

test("CLI init 在 Windows 平台使用 npm.cmd 和 superspec.cmd 自升级", () => {
  withTempProject(projectRoot => {
    const binDir = join(projectRoot, "bin");
    mkdirSync(binDir, { recursive: true });
    const commandLog = join(projectRoot, "commands.log");
    const escapedLog = commandLog.replace(/'/g, "'\\''");
    writeWindowsCmdShim(binDir, commandLog);
    const rerunPayload = JSON.stringify({
      ok: true,
      message: "SuperSpec 99.0.0 已安装",
    });

    writeExecutable(join(binDir, "npm.cmd"), `#!/bin/sh
echo "npm.cmd $@" >> '${escapedLog}'
if [ "$1" = "view" ]; then
  echo "99.0.0"
  exit 0
fi
if [ "$1" = "install" ]; then
  exit 0
fi
echo "unexpected npm.cmd $@" >&2
exit 1
`);
    writeExecutable(join(binDir, "superspec.cmd"), `#!/bin/sh
echo "superspec.cmd $@" >> '${escapedLog}'
if [ "$1" = "--version" ]; then
  echo "SuperSpec 99.0.0"
  exit 0
fi
if [ "$1" = "init" ]; then
  cat <<'JSON'
${rerunPayload}
JSON
  exit 0
fi
echo "unexpected superspec.cmd $@" >&2
exit 1
`);

    const output = execFileSync(process.execPath, [cliPath(), "init", "--scope", "project"], {
      cwd: projectRoot,
      encoding: "utf8",
      env: testEnv({
        SUPERSPEC_TEST_PLATFORM: "win32",
        SUPERSPEC_TEST_ASSUME_TTY: "1",
        SUPERSPEC_TEST_PROMPT_ANSWER: "",
        PATH: `${binDir}:${process.env.PATH ?? ""}`,
      }),
    });
    const result = JSON.parse(output);
    const log = readFileSync(commandLog, "utf8");

    assert.equal(result.ok, true);
    assert.deepEqual(result.self_update, {
      updated: true,
      from: PACKAGE_VERSION,
      to: "99.0.0",
    });
    assert.match(log, /^cmd\.exe \/d \/s \/c npm\.cmd view @peterxiaoyang\/superspec version$/m);
    assert.match(log, /^cmd\.exe \/d \/s \/c npm\.cmd install -g @peterxiaoyang\/superspec@latest$/m);
    assert.match(log, /^cmd\.exe \/d \/s \/c superspec\.cmd --version$/m);
    assert.match(log, /^cmd\.exe \/d \/s \/c superspec\.cmd init --scope project --skip-self-update$/m);
    assert.match(log, /^npm\.cmd view @peterxiaoyang\/superspec version$/m);
    assert.match(log, /^npm\.cmd install -g @peterxiaoyang\/superspec@latest$/m);
    assert.match(log, /^superspec\.cmd --version$/m);
    assert.match(log, /^superspec\.cmd init --scope project --skip-self-update$/m);
  });
});

test("CLI init latest 查询失败时提示 stderr 并继续安装", () => {
  withTempProject(projectRoot => {
    const run = runCli(["init", "--scope", "project"], projectRoot, testEnv({
      SUPERSPEC_TEST_ASSUME_TTY: "1",
      SUPERSPEC_TEST_NPM_VIEW_ERROR: "registry offline",
    }));
    const result = JSON.parse(run.stdout);

    assert.equal(run.status, 0);
    assert.match(run.stderr, /registry offline/);
    assert.equal(result.ok, true);
    assert.equal(result.message, `SuperSpec ${PACKAGE_VERSION} 已安装`);
  });
});

test("CLI update refreshes installed workflow templates without backups", () => {
  withTempProject(projectRoot => {
    installProject(projectRoot);
    const skillPath = join(projectRoot, ".codex", "skills", "superspec-explore", "SKILL.md");
    const deprecatedSkillPath = join(projectRoot, ".codex", "skills", "superspec-archive", "SKILL.md");
    const promptPath = join(projectRoot, ".codex", "prompts", "explore.md");
    const agentPath = join(projectRoot, ".codex", "agents", "explore.toml");
    writeFileSync(skillPath, "stale skill template\n");
    mkdirSync(join(projectRoot, ".codex", "skills", "superspec-archive"), { recursive: true });
    writeFileSync(deprecatedSkillPath, "stale archive skill\n");
    writeFileSync(promptPath, "stale prompt template\n");
    writeFileSync(agentPath, "stale agent template\n");

    const output = execFileSync(process.execPath, [cliPath(), "update", "--skip-self-update"], {
      cwd: projectRoot,
      encoding: "utf8",
      env: testEnv(),
    });
    const result = JSON.parse(output);

    assert.equal(result.ok, true);
    assert.equal(result.message, `SuperSpec ${PACKAGE_VERSION} 已更新项目工作流`);
    assert.deepEqual(result.installed.skills, [...WORKFLOW_SKILLS]);
    assert.equal(result.installed.agents_md, "AGENTS.md");
    assert.equal(
      readFileSync(skillPath, "utf8"),
      readFileSync(new URL("../templates/workflow/skills/superspec-explore/SKILL.md", import.meta.url), "utf8"),
    );
    assert.equal(
      readFileSync(promptPath, "utf8"),
      readFileSync(new URL("../templates/workflow/prompts/explore.md", import.meta.url), "utf8"),
    );
    assert.equal(
      readFileSync(agentPath, "utf8"),
      readFileSync(new URL("../templates/workflow/agents/explore.toml", import.meta.url), "utf8"),
    );
    assert.equal(existsSync(`${skillPath}.bak`), false);
    assert.equal(existsSync(deprecatedSkillPath), false);
    assert.equal(existsSync(`${promptPath}.bak`), false);
    assert.equal(existsSync(`${agentPath}.bak`), false);
  });
});

test("installProject appends and updates marker-bounded AGENTS.md without replacing user rules", () => {
  withTempProject(projectRoot => {
    const agentsPath = join(projectRoot, "AGENTS.md");
    writeFileSync(agentsPath, [
      "# Project Rules",
      "",
      "- Keep this user rule.",
      "",
    ].join("\n"));

    installProject(projectRoot);
    const first = readFileSync(agentsPath, "utf8");
    assert.match(first, /Keep this user rule/);
    assert.match(first, /SUPERSPEC:AGENTS:START/);
    assert.equal(existsSync(`${agentsPath}.bak`), false);

    const changed = first.replace("用户可见回复使用自然语言", "用户可见回复倾倒 JSON");
    writeFileSync(agentsPath, changed);
    installProject(projectRoot, { allowLegacyState: true });
    const second = readFileSync(agentsPath, "utf8");
    assert.match(second, /Keep this user rule/);
    assert.match(second, /用户可见回复使用自然语言/);
    assert.doesNotMatch(second, /用户可见回复倾倒 JSON/);
    assert.equal((second.match(/SUPERSPEC:AGENTS:START/g) ?? []).length, 1);
    assert.equal(existsSync(`${agentsPath}.bak`), false);
  });
});

test("installProject rejects AGENTS.md workflow template without SuperSpec markers", () => {
  withTempProject(projectRoot => {
    const templateRoot = join(projectRoot, "template");
    for (const skill of WORKFLOW_SKILLS) {
      const dir = join(templateRoot, "skills", skill);
      mkdirSync(dir, { recursive: true });
      writeFileSync(join(dir, "SKILL.md"), "---\nname: test\n---\n");
    }
    for (const prompt of WORKFLOW_PROMPTS) {
      const dir = join(templateRoot, "prompts");
      mkdirSync(dir, { recursive: true });
      writeFileSync(join(dir, prompt), "# Prompt\n");
    }
    for (const agent of WORKFLOW_AGENTS) {
      const dir = join(templateRoot, "agents");
      mkdirSync(dir, { recursive: true });
      writeFileSync(join(dir, agent), "# Agent\n");
    }
    writeFileSync(join(templateRoot, "AGENTS.md"), "# Missing markers\n");

    assert.throws(
      () => installProject(projectRoot, { templateRoot }),
      /template missing SuperSpec markers/,
    );
  });
});

test("CLI update 默认先安装 npm latest 并递归运行新 CLI", () => {
  withTempProject(projectRoot => {
    const rerunPayload = {
      ok: true,
      message: "SuperSpec 99.0.0 已更新项目工作流",
      installed: {
        engine_dir: ".superspec/",
        skills: [...WORKFLOW_SKILLS],
        prompts: [...WORKFLOW_PROMPTS],
        agents: [...WORKFLOW_AGENTS],
        config: ".codex/config.toml",
        workflow_config: ".superspec/config.json",
        openspec_config: "openspec/config.yaml",
      },
    };

    const output = execFileSync(process.execPath, [cliPath(), "update"], {
      cwd: projectRoot,
      encoding: "utf8",
      env: testEnv({
        SUPERSPEC_TEST_LATEST_VERSION: "99.0.0",
        SUPERSPEC_TEST_SKIP_GLOBAL_INSTALL: "1",
        SUPERSPEC_TEST_CLI_VERSION: "99.0.0",
        SUPERSPEC_TEST_RERUN_OUTPUT: JSON.stringify(rerunPayload),
      }),
    });
    const result = JSON.parse(output);

    assert.equal(result.ok, true);
    assert.equal(result.message, "SuperSpec 99.0.0 已更新项目工作流");
    assert.deepEqual(result.self_update, {
      updated: true,
      from: PACKAGE_VERSION,
      to: "99.0.0",
    });
  });
});

test("CLI update 在 Windows 平台使用 npm.cmd 和 superspec.cmd 自升级", () => {
  withTempProject(projectRoot => {
    const binDir = join(projectRoot, "bin");
    mkdirSync(binDir, { recursive: true });
    const commandLog = join(projectRoot, "commands.log");
    const escapedLog = commandLog.replace(/'/g, "'\\''");
    writeWindowsCmdShim(binDir, commandLog);
    const rerunPayload = JSON.stringify({
      ok: true,
      message: "SuperSpec 99.0.0 已更新项目工作流",
    });

    writeExecutable(join(binDir, "npm.cmd"), `#!/bin/sh
echo "npm.cmd $@" >> '${escapedLog}'
if [ "$1" = "view" ]; then
  echo "99.0.0"
  exit 0
fi
if [ "$1" = "install" ]; then
  exit 0
fi
echo "unexpected npm.cmd $@" >&2
exit 1
`);
    writeExecutable(join(binDir, "superspec.cmd"), `#!/bin/sh
echo "superspec.cmd $@" >> '${escapedLog}'
if [ "$1" = "--version" ]; then
  echo "SuperSpec 99.0.0"
  exit 0
fi
if [ "$1" = "update" ]; then
  cat <<'JSON'
${rerunPayload}
JSON
  exit 0
fi
echo "unexpected superspec.cmd $@" >&2
exit 1
`);

    const output = execFileSync(process.execPath, [cliPath(), "update"], {
      cwd: projectRoot,
      encoding: "utf8",
      env: testEnv({
        SUPERSPEC_TEST_PLATFORM: "win32",
        PATH: `${binDir}:${process.env.PATH ?? ""}`,
      }),
    });
    const result = JSON.parse(output);
    const log = readFileSync(commandLog, "utf8");

    assert.equal(result.ok, true);
    assert.deepEqual(result.self_update, {
      updated: true,
      from: PACKAGE_VERSION,
      to: "99.0.0",
    });
    assert.match(log, /^cmd\.exe \/d \/s \/c npm\.cmd view @peterxiaoyang\/superspec version$/m);
    assert.match(log, /^cmd\.exe \/d \/s \/c npm\.cmd install -g @peterxiaoyang\/superspec@latest$/m);
    assert.match(log, /^cmd\.exe \/d \/s \/c superspec\.cmd --version$/m);
    assert.match(log, /^cmd\.exe \/d \/s \/c superspec\.cmd update --skip-self-update$/m);
    assert.match(log, /^npm\.cmd view @peterxiaoyang\/superspec version$/m);
    assert.match(log, /^npm\.cmd install -g @peterxiaoyang\/superspec@latest$/m);
    assert.match(log, /^superspec\.cmd --version$/m);
    assert.match(log, /^superspec\.cmd update --skip-self-update$/m);
  });
});

test("CLI update latest 不高于当前版本时只同步项目模板", () => {
  withTempProject(projectRoot => {
    const output = execFileSync(process.execPath, [cliPath(), "update"], {
      cwd: projectRoot,
      encoding: "utf8",
      env: testEnv({
        SUPERSPEC_TEST_LATEST_VERSION: PACKAGE_VERSION,
      }),
    });
    const result = JSON.parse(output);

    assert.equal(result.ok, true);
    assert.equal(result.self_update, undefined);
    assert.equal(result.message, `SuperSpec ${PACKAGE_VERSION} 已更新项目工作流`);
  });
});

test("CLI update npm latest 查询失败时返回结构化错误", () => {
  withTempProject(projectRoot => {
    const run = runCli(["update"], projectRoot, testEnv({
      SUPERSPEC_TEST_NPM_VIEW_ERROR: "registry unavailable",
    }));
    const result = JSON.parse(run.stdout);

    assert.equal(run.status, 1);
    assert.equal(result.ok, false);
    assert.match(result.message, /registry unavailable/);
    assert.deepEqual(result.self_update, {
      updated: false,
      from: PACKAGE_VERSION,
      to: null,
      phase: "npm_view",
    });
  });
});

test("CLI update 全局安装失败时返回目标版本和 phase", () => {
  withTempProject(projectRoot => {
    const run = runCli(["update"], projectRoot, testEnv({
      SUPERSPEC_TEST_LATEST_VERSION: "99.0.0",
      SUPERSPEC_TEST_GLOBAL_INSTALL_ERROR: "permission denied",
    }));
    const result = JSON.parse(run.stdout);

    assert.equal(run.status, 1);
    assert.equal(result.ok, false);
    assert.match(result.message, /permission denied/);
    assert.deepEqual(result.self_update, {
      updated: false,
      from: PACKAGE_VERSION,
      to: "99.0.0",
      phase: "global_install",
    });
  });
});

test("CLI update 安装后 PATH 仍指向旧版本时失败", () => {
  withTempProject(projectRoot => {
    const run = runCli(["update"], projectRoot, testEnv({
      SUPERSPEC_TEST_LATEST_VERSION: "99.0.0",
      SUPERSPEC_TEST_SKIP_GLOBAL_INSTALL: "1",
      SUPERSPEC_TEST_CLI_VERSION: PACKAGE_VERSION,
    }));
    const result = JSON.parse(run.stdout);

    assert.equal(run.status, 1);
    assert.equal(result.ok, false);
    assert.match(result.message, /期望 99\.0\.0/);
    assert.equal(result.self_update.phase, "version_mismatch");
    assert.equal(result.self_update.to, "99.0.0");
  });
});

test("CLI update 新版 CLI rerun 失败时返回 rerun phase", () => {
  withTempProject(projectRoot => {
    const run = runCli(["update"], projectRoot, testEnv({
      SUPERSPEC_TEST_LATEST_VERSION: "99.0.0",
      SUPERSPEC_TEST_SKIP_GLOBAL_INSTALL: "1",
      SUPERSPEC_TEST_CLI_VERSION: "99.0.0",
      SUPERSPEC_TEST_RERUN_ERROR: "rerun failed",
    }));
    const result = JSON.parse(run.stdout);

    assert.equal(run.status, 1);
    assert.equal(result.ok, false);
    assert.match(result.message, /rerun failed/);
    assert.deepEqual(result.self_update, {
      updated: false,
      from: PACKAGE_VERSION,
      to: "99.0.0",
      phase: "rerun",
    });
  });
});

test("CLI update 新版 CLI 返回 ok false 时父进程也失败", () => {
  withTempProject(projectRoot => {
    const run = runCli(["update"], projectRoot, testEnv({
      SUPERSPEC_TEST_LATEST_VERSION: "99.0.0",
      SUPERSPEC_TEST_SKIP_GLOBAL_INSTALL: "1",
      SUPERSPEC_TEST_CLI_VERSION: "99.0.0",
      SUPERSPEC_TEST_RERUN_OUTPUT: JSON.stringify({ ok: false, message: "template sync failed" }),
    }));
    const result = JSON.parse(run.stdout);

    assert.equal(run.status, 1);
    assert.equal(result.ok, false);
    assert.equal(result.message, "template sync failed");
    assert.deepEqual(result.self_update, {
      updated: true,
      from: PACKAGE_VERSION,
      to: "99.0.0",
    });
  });
});

test("CLI update 新版 CLI 输出非 JSON 时失败", () => {
  withTempProject(projectRoot => {
    const run = runCli(["update"], projectRoot, testEnv({
      SUPERSPEC_TEST_LATEST_VERSION: "99.0.0",
      SUPERSPEC_TEST_SKIP_GLOBAL_INSTALL: "1",
      SUPERSPEC_TEST_CLI_VERSION: "99.0.0",
      SUPERSPEC_TEST_RERUN_OUTPUT: "not json\n",
    }));
    const result = JSON.parse(run.stdout);

    assert.equal(run.status, 1);
    assert.equal(result.ok, false);
    assert.equal(result.message, "新版 CLI 输出不是 JSON object");
    assert.deepEqual(result.self_update, {
      updated: false,
      from: PACKAGE_VERSION,
      to: "99.0.0",
      phase: "rerun_output",
    });
  });
});

test("CLI update 生产模式忽略 SUPERSPEC_TEST mock 变量", () => {
  withTempProject(projectRoot => {
    const binDir = join(projectRoot, "bin");
    mkdirSync(binDir, { recursive: true });
    const npmLog = join(projectRoot, "npm.log");
    const escapedLog = npmLog.replace(/'/g, "'\\''");
    writeExecutable(join(binDir, "npm"), `#!/bin/sh
echo "$@" >> '${escapedLog}'
if [ "$1" = "view" ]; then
  echo "${PACKAGE_VERSION}"
  exit 0
fi
echo "unexpected npm $@" >&2
exit 1
`);
    writeExecutable(join(binDir, "openspec"), `#!/bin/sh
if [ "$1" = "--version" ]; then
  echo "${OPENSPEC_REQUIRED_VERSION}"
  exit 0
fi
echo "unexpected openspec $@" >&2
exit 1
`);

    const output = execFileSync(process.execPath, [cliPath(), "update"], {
      cwd: projectRoot,
      encoding: "utf8",
      env: {
        ...process.env,
        NODE_ENV: "production",
        SUPERSPEC_TEST_MODE: "0",
        SUPERSPEC_TEST_LATEST_VERSION: "99.0.0",
        SUPERSPEC_TEST_SKIP_GLOBAL_INSTALL: "1",
        SUPERSPEC_TEST_RERUN_OUTPUT: JSON.stringify({ ok: true, message: "mocked" }),
        PATH: `${binDir}:${process.env.PATH ?? ""}`,
      },
    });
    const result = JSON.parse(output);

    assert.equal(result.ok, true);
    assert.equal(result.self_update, undefined);
    assert.match(readFileSync(npmLog, "utf8"), /^view @peterxiaoyang\/superspec version$/m);
  });
});

test("CLI update bootstraps old projects and ignores legacy self-update flags", () => {
  withTempProject(projectRoot => {
    const output = execFileSync(process.execPath, [cliPath(), "update", "--scope", "project", "--skip-self-update"], {
      cwd: projectRoot,
      encoding: "utf8",
      env: testEnv(),
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

    assert.throws(() => installProject(projectRoot), error => {
      assert.match(String(error), /检测到老版 SuperSpec/);
      assert.doesNotMatch(String(error), /归档/);
      return true;
    });

    const output = execFileSync(process.execPath, [cliPath(), "update", "--skip-self-update"], {
      cwd: projectRoot,
      encoding: "utf8",
      env: testEnv(),
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
