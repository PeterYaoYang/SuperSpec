/**
 * OMP judge adapter: isolated `omp -p --mode json` session whose final agent
 * message must be one JSON object. Used by M2 reviewers and the Probe AI
 * simulated user. Judges never see the Worker workspace.
 *
 * Isolation mirrors the Worker: whitelist the selected provider from the user's
 * models.yml into HOME/.omp/agent and launch with `provider/model`.
 */

import { chmodSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  controlledEnv,
  controlledProviderProfile,
  parseOmpTrace,
  resolveOmpModelRef,
  usageObservations,
} from "../hosts/omp.mjs";
import {
  JUDGE_TIMEOUT_MS,
  commandOnPath,
  isTransientJudgeFailure,
  judgeFailureDetail,
  judgeSessionIds,
  killProcessTree,
  lastAgentMessageJson,
  removeDirs,
  spawnJudge,
} from "./runtime.mjs";

export const OMP_JUDGE_ID = "omp";
export const OMP_JUDGE_ADAPTER_VERSION = "1";

const THINKING = new Set(["off", "minimal", "low", "medium", "high", "xhigh", "max", "auto"]);

function mapThinking(reasoning) {
  if (reasoning === "none") return "off";
  return THINKING.has(reasoning) ? reasoning : "medium";
}

function isolatedJudgeHome(id, providerProfile, registry) {
  const home = mkdtempSync(join(tmpdir(), `superspec-m2-home-${id}-`));
  registry?.track(home);
  const hostHome = mkdtempSync(join(tmpdir(), `superspec-m2-omp-${id}-`));
  registry?.track(hostHome);
  chmodSync(home, 0o700);
  chmodSync(hostHome, 0o700);
  const agentDir = join(home, ".omp", "agent");
  mkdirSync(agentDir, { recursive: true, mode: 0o700 });
  if (!providerProfile?.models_yaml) throw new Error("OMP judge isolation requires a models.yml provider profile");
  writeFileSync(join(agentDir, "models.yml"), providerProfile.models_yaml, { mode: 0o600 });
  writeFileSync(join(agentDir, "config.yml"), [
    "# Eval judge isolation: whitelisted models.yml provider only.",
    "disabledProviders:",
    "  - openai",
    "  - ollama",
    "  - lm-studio",
    "  - cursor",
    "",
  ].join("\n"), { mode: 0o600 });
  return { home, hostHome };
}

function requireOmp(label) {
  const executable = commandOnPath("omp");
  if (!executable) throw new Error(`omp executable unavailable for ${label}`);
  return executable;
}

function judgeArgs({ model, reasoning, sessionDir, providerProfile }) {
  return [
    "-p",
    "--mode", "json",
    "--auto-approve",
    "--approval-mode", "yolo",
    "--no-session",
    "--model", resolveOmpModelRef(model, providerProfile),
    "--thinking", mapThinking(reasoning),
    ...(sessionDir ? ["--session-dir", sessionDir] : []),
  ];
}

function createReviewerRunner({ provider, registry = null }) {
  const executable = requireOmp("M2 reviewers");
  const providerProfile = controlledProviderProfile(provider || "omp");
  const active = new Set();

  async function run({ id, model, reasoning, prompt, cwd, tracePath, stderrPath }) {
    const isolated = isolatedJudgeHome(id, providerProfile, registry);
    try {
      const env = controlledEnv(
        isolated.home,
        isolated.hostHome,
        isolated.home,
        process.env.PATH ?? "",
        process.env.SHELL ?? "/bin/zsh",
        providerProfile.env_keys,
      );
      const args = judgeArgs({ model, reasoning, sessionDir: isolated.hostHome, providerProfile });
      for (let attempt = 1; attempt <= 2; attempt++) {
        const result = await spawnJudge(executable, args, { cwd, env, prompt, active });
        const attemptSuffix = attempt === 1 ? ".attempt-1" : "";
        writeFileSync(`${tracePath}${attemptSuffix}`, result.stdout, { mode: 0o600 });
        writeFileSync(`${stderrPath}${attemptSuffix}`, result.stderr, { mode: 0o600 });
        if (result.code === 0) {
          if (attempt === 1) {
            writeFileSync(tracePath, result.stdout, { mode: 0o600 });
            writeFileSync(stderrPath, result.stderr, { mode: 0o600 });
          }
          return { json: lastAgentMessageJson(parseOmpTrace(tracePath), "reviewer did not return parseable JSON"), tracePath, stderrPath, attempts: attempt };
        }
        if (!isTransientJudgeFailure(result.stdout, result.stderr) || attempt === 2) {
          throw new Error(`reviewer ${id} exited ${result.code} after ${attempt} attempt(s): ${result.stderr.trim()}`);
        }
      }
      throw new Error(`reviewer ${id} exhausted its retry budget`);
    } finally {
      removeDirs([isolated.home, isolated.hostHome], registry);
    }
  }

  return {
    role: "reviewer",
    provider: providerProfile.id,
    run,
    terminateAll(signal = "SIGTERM") {
      for (const child of active) killProcessTree(child, signal);
    },
  };
}

function createSimulatedUserRunner({ executable, spawnDirector, pathValue, systemShell, zdotdir, runLabel, registry = null, provider = "omp" }) {
  const providerProfile = controlledProviderProfile(provider);
  const omp = executable && /(?:^|\/)omp$/.test(executable) ? executable : requireOmp("simulated user");

  async function run({ turn, model, reasoning, prompt, tracePath, stderrPath }) {
    const userWorkspace = mkdtempSync(join(tmpdir(), `superspec-sim-user-${turn}-`));
    registry?.track(userWorkspace);
    mkdirSync(userWorkspace, { recursive: true, mode: 0o700 });
    const isolated = isolatedJudgeHome(`${runLabel}-user-${turn}`, providerProfile, registry);
    const dirs = [userWorkspace, isolated.home, isolated.hostHome];
    try {
      const userEnv = controlledEnv(isolated.home, isolated.hostHome, zdotdir, pathValue, systemShell, providerProfile.env_keys);
      const result = await spawnDirector(omp, judgeArgs({ model, reasoning, sessionDir: isolated.hostHome, providerProfile }), {
        phase: `simulated-user.turn-${turn}`,
        actor: "simulated_user",
        cwd: userWorkspace,
        env: userEnv,
        stdoutPath: tracePath,
        stderrPath,
        stdin: prompt,
        timeoutMs: JUDGE_TIMEOUT_MS,
      });
      if (result.code !== 0) throw new Error(`simulated user turn ${turn} exited ${result.code}: ${result.stderr.trim()}`);
      return { json: lastAgentMessageJson(parseOmpTrace(tracePath), "simulated user did not return parseable JSON"), tracePath, stderrPath, attempts: 1 };
    } finally {
      removeDirs(dirs, registry);
    }
  }

  return {
    role: "simulated_user",
    provider: providerProfile.id,
    run,
    terminateAll(signal = "SIGTERM") {
      spawnDirector.terminateAll?.(signal);
    },
  };
}

export const ompJudgeHost = Object.freeze({
  id: OMP_JUDGE_ID,
  adapter_version: OMP_JUDGE_ADAPTER_VERSION,
  stale_temp_dir_rules: [
    { prefix: "superspec-m2-home-", pid: /^superspec-m2-home-.+-\d{14,17}-(\d+)(?:-user-\d+)?-[A-Za-z0-9]+-[A-Za-z0-9]{6}$/ },
    { prefix: "superspec-m2-omp-", pid: /^superspec-m2-omp-.+-\d{14,17}-(\d+)(?:-user-\d+)?-[A-Za-z0-9]+-[A-Za-z0-9]{6}$/ },
  ],
  createRunner(config) {
    if (config.role === "reviewer") return createReviewerRunner(config);
    if (config.role === "simulated_user") return createSimulatedUserRunner(config);
    throw new Error(`unsupported omp judge role: ${config.role}`);
  },
  parseTrace: parseOmpTrace,
  sessionIds: judgeSessionIds(parseOmpTrace),
  failureDetail: judgeFailureDetail(parseOmpTrace),
  usageObservations,
});
