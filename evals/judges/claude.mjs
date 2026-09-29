/**
 * Claude Code judge adapter: isolated `claude -p` session whose final agent
 * message must be one JSON object. Used by M2 reviewers and the Probe AI
 * simulated user. Judges never see the Worker workspace.
 */

import { chmodSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  controlledEnv,
  parseClaudeTrace,
  privateClaudeTmpDir,
  usageObservations,
} from "../hosts/claude.mjs";
import {
  JUDGE_TIMEOUT_MS,
  commandOnPath,
  isTransientJudgeFailure,
  judgeFailureDetail,
  judgeSessionIds,
  judgeTimeoutError,
  killProcessTree,
  lastAgentMessageJson,
  removeDirs,
  spawnJudge,
} from "./runtime.mjs";

export const CLAUDE_JUDGE_ID = "claude";
export const CLAUDE_JUDGE_ADAPTER_VERSION = "1";

const EFFORT = new Set(["low", "medium", "high", "xhigh", "max"]);

function mapEffort(reasoning) {
  if (reasoning === "none") return "low";
  return EFFORT.has(reasoning) ? reasoning : "medium";
}

function isolatedJudgeHome(id, registry) {
  const home = mkdtempSync(join(tmpdir(), `superspec-m2-home-${id}-`));
  registry?.track(home);
  const hostHome = mkdtempSync(join(tmpdir(), `superspec-m2-claude-${id}-`));
  registry?.track(hostHome);
  chmodSync(home, 0o700);
  chmodSync(hostHome, 0o700);
  writeFileSync(join(hostHome, "settings.json"), `${JSON.stringify({
    permissions: { allow: ["Read"] },
  }, null, 2)}\n`, { mode: 0o600 });
  return { home, hostHome, claudeTmpDir: privateClaudeTmpDir(registry) };
}

function requireClaude(label) {
  const executable = commandOnPath("claude");
  if (!executable) throw new Error(`claude executable unavailable for ${label}`);
  return executable;
}

function requireAnthropicKeys() {
  const envKeys = ["ANTHROPIC_API_KEY", "ANTHROPIC_AUTH_TOKEN", "ANTHROPIC_BASE_URL"].filter(key => process.env[key]);
  if (!process.env.ANTHROPIC_API_KEY && !process.env.ANTHROPIC_AUTH_TOKEN) {
    throw new Error("Claude judge credential is unavailable (ANTHROPIC_API_KEY or ANTHROPIC_AUTH_TOKEN)");
  }
  return envKeys;
}

function judgeArgs({ model, reasoning }) {
  return [
    "-p",
    "--output-format", "stream-json",
    "--verbose",
    "--permission-mode", "acceptEdits",
    "--permission-prompts", "none",
    "--no-session-persistence",
    "--model", model,
    "--effort", mapEffort(reasoning),
  ];
}

function createReviewerRunner({ provider, registry = null }) {
  const executable = requireClaude("M2 reviewers");
  const envKeys = requireAnthropicKeys();
  const active = new Set();

  async function run({ id, model, reasoning, prompt, cwd, tracePath, stderrPath }) {
    const isolated = isolatedJudgeHome(id, registry);
    try {
      const env = controlledEnv(isolated.home, isolated.hostHome, isolated.home, process.env.PATH ?? "", process.env.SHELL ?? "/bin/zsh", envKeys, { claudeTmpDir: isolated.claudeTmpDir });
      const args = judgeArgs({ model, reasoning });
      for (let attempt = 1; attempt <= 2; attempt++) {
        const result = await spawnJudge(executable, args, { cwd, env, prompt, active });
        const attemptSuffix = attempt === 1 ? ".attempt-1" : "";
        writeFileSync(`${tracePath}${attemptSuffix}`, result.stdout, { mode: 0o600 });
        writeFileSync(`${stderrPath}${attemptSuffix}`, result.stderr, { mode: 0o600 });
        if (result.timedOut) {
          if (attempt === 2) throw judgeTimeoutError(`reviewer ${id} (attempt ${attempt})`);
          continue;
        }
        if (result.code === 0) {
          if (attempt === 1) {
            writeFileSync(tracePath, result.stdout, { mode: 0o600 });
            writeFileSync(stderrPath, result.stderr, { mode: 0o600 });
          }
          return { json: lastAgentMessageJson(parseClaudeTrace(tracePath), "reviewer did not return parseable JSON"), tracePath, stderrPath, attempts: attempt };
        }
        if (!isTransientJudgeFailure(result.stdout, result.stderr) || attempt === 2) {
          throw new Error(`reviewer ${id} exited ${result.code} after ${attempt} attempt(s): ${result.stderr.trim()}`);
        }
      }
      throw new Error(`reviewer ${id} exhausted its retry budget`);
    } finally {
      removeDirs([isolated.home, isolated.hostHome, isolated.claudeTmpDir], registry);
    }
  }

  return {
    role: "reviewer",
    provider: provider || "anthropic",
    run,
    terminateAll(signal = "SIGTERM") {
      for (const child of active) killProcessTree(child, signal);
    },
  };
}

function createSimulatedUserRunner({ executable, spawnDirector, pathValue, systemShell, zdotdir, runLabel, registry = null }) {
  const envKeys = requireAnthropicKeys();
  const claude = executable && /(?:^|\/)claude$/.test(executable) ? executable : requireClaude("simulated user");

  async function run({ turn, model, reasoning, prompt, tracePath, stderrPath }) {
    const userWorkspace = mkdtempSync(join(tmpdir(), `superspec-sim-user-${turn}-`));
    registry?.track(userWorkspace);
    mkdirSync(userWorkspace, { recursive: true, mode: 0o700 });
    const isolated = isolatedJudgeHome(`${runLabel}-user-${turn}`, registry);
    const dirs = [userWorkspace, isolated.home, isolated.hostHome, isolated.claudeTmpDir];
    try {
      const userEnv = controlledEnv(isolated.home, isolated.hostHome, zdotdir, pathValue, systemShell, envKeys, { claudeTmpDir: isolated.claudeTmpDir });
      const result = await spawnDirector(claude, judgeArgs({ model, reasoning }), {
        phase: `simulated-user.turn-${turn}`,
        actor: "simulated_user",
        cwd: userWorkspace,
        env: userEnv,
        stdoutPath: tracePath,
        stderrPath,
        stdin: prompt,
        timeoutMs: JUDGE_TIMEOUT_MS,
      });
      if (result.timedOut) throw judgeTimeoutError(`simulated user turn ${turn}`);
      if (result.code !== 0) throw new Error(`simulated user turn ${turn} exited ${result.code}: ${result.stderr.trim()}`);
      return { json: lastAgentMessageJson(parseClaudeTrace(tracePath), "simulated user did not return parseable JSON"), tracePath, stderrPath, attempts: 1 };
    } finally {
      removeDirs(dirs, registry);
    }
  }

  return {
    role: "simulated_user",
    provider: "anthropic",
    run,
    terminateAll(signal = "SIGTERM") {
      spawnDirector.terminateAll?.(signal);
    },
  };
}

export const claudeJudgeHost = Object.freeze({
  id: CLAUDE_JUDGE_ID,
  adapter_version: CLAUDE_JUDGE_ADAPTER_VERSION,
  stale_temp_dir_rules: [
    { prefix: "superspec-m2-home-", pid: /^superspec-m2-home-.+-\d{14,17}-(\d+)(?:-user-\d+)?-[A-Za-z0-9]+-[A-Za-z0-9]{6}$/ },
    { prefix: "superspec-m2-claude-", pid: /^superspec-m2-claude-.+-\d{14,17}-(\d+)(?:-user-\d+)?-[A-Za-z0-9]+-[A-Za-z0-9]{6}$/ },
    { prefix: "sscc-", pid: /^sscc-(\d+)-[A-Za-z0-9]{6}$/, requirePid: true },
  ],
  createRunner(config) {
    if (config.role === "reviewer") return createReviewerRunner(config);
    if (config.role === "simulated_user") return createSimulatedUserRunner(config);
    throw new Error(`unsupported claude judge role: ${config.role}`);
  },
  parseTrace: parseClaudeTrace,
  sessionIds: judgeSessionIds(parseClaudeTrace),
  failureDetail: judgeFailureDetail(parseClaudeTrace),
  usageObservations,
});
