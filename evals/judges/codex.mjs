/**
 * Codex judge adapter: runs an isolated, read-only, ephemeral `codex exec`
 * session whose final agent message must be one JSON object. Used by M2
 * reviewers ("reviewer" role) and by the Probe AI simulated user
 * ("simulated_user" role). Each role keeps its own invocation contract
 * (argv, isolation, retry and failure messages) because recorded evidence and
 * failure attribution depend on them.
 */

import { spawnSync } from "node:child_process";
import {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdtempSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  controlledEnv,
  controlledProviderProfile,
  isolatedAuthHome,
  parseCodexTrace,
  parseTomlScalar,
  stripTomlComment,
  tomlLiteral,
  usageObservations,
} from "../hosts/codex.mjs";
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

export const CODEX_JUDGE_ID = "codex";
export const CODEX_JUDGE_ADAPTER_VERSION = "1";

const PROVIDER_ALLOWED_KEYS = new Set(["name", "base_url", "env_key", "wire_api", "requires_openai_auth"]);

/** Reviewer provider profile (M2 contract: builtin openai or a complete whitelisted host provider). */
function reviewerProviderProfile(provider) {
  if (provider === "openai") {
    return { id: provider, requires_openai_auth: true, env_keys: [], cli_args: ["-c", `model_provider=${tomlLiteral(provider)}`] };
  }
  const codexHome = process.env.CODEX_HOME ?? join(process.env.HOME ?? "", ".codex");
  const configPath = join(codexHome, "config.toml");
  if (!existsSync(configPath)) throw new Error(`Codex provider config unavailable for ${provider}`);
  const section = `[model_providers.${provider}]`;
  const selected = {};
  let active = false;
  for (const rawLine of readFileSync(configPath, "utf8").split(/\r?\n/)) {
    const line = stripTomlComment(rawLine).trim();
    if (line.startsWith("[") && line.endsWith("]")) { active = line === section; continue; }
    if (!active || !line) continue;
    const match = /^([A-Za-z0-9_-]+)\s*=\s*(.+)$/.exec(line);
    if (match && PROVIDER_ALLOWED_KEYS.has(match[1])) selected[match[1]] = parseTomlScalar(match[2], match[1]);
  }
  if (typeof selected.base_url !== "string" || typeof selected.env_key !== "string" || typeof selected.wire_api !== "string") {
    throw new Error(`provider ${provider} configuration is incomplete`);
  }
  const baseUrl = new URL(selected.base_url);
  if (!["http:", "https:"].includes(baseUrl.protocol) || baseUrl.username || baseUrl.password || baseUrl.search || baseUrl.hash) {
    throw new Error(`provider ${provider} base_url is unsafe`);
  }
  if (!/^[A-Z][A-Z0-9_]*$/.test(selected.env_key) || !process.env[selected.env_key]) throw new Error(`provider credential unavailable: ${selected.env_key}`);
  if (!["responses", "chat"].includes(selected.wire_api)) throw new Error(`provider ${provider} wire_api is unsupported`);
  const normalized = {
    name: typeof selected.name === "string" && selected.name ? selected.name : provider,
    base_url: selected.base_url,
    env_key: selected.env_key,
    wire_api: selected.wire_api,
    requires_openai_auth: selected.requires_openai_auth ?? false,
  };
  const prefix = `model_providers.${provider}`;
  return {
    id: provider,
    requires_openai_auth: normalized.requires_openai_auth,
    env_keys: [normalized.env_key],
    cli_args: [
      "-c", `model_provider=${tomlLiteral(provider)}`,
      "-c", `${prefix}.name=${tomlLiteral(normalized.name)}`,
      "-c", `${prefix}.base_url=${tomlLiteral(normalized.base_url)}`,
      "-c", `${prefix}.env_key=${tomlLiteral(normalized.env_key)}`,
      "-c", `${prefix}.wire_api=${tomlLiteral(normalized.wire_api)}`,
      "-c", `${prefix}.requires_openai_auth=${tomlLiteral(normalized.requires_openai_auth)}`,
    ],
  };
}

function isolatedReviewerEnvironment(id, profile, registry) {
  const home = mkdtempSync(join(tmpdir(), `superspec-m2-home-${id}-`));
  registry?.track(home);
  const codexHome = mkdtempSync(join(tmpdir(), `superspec-m2-codex-${id}-`));
  registry?.track(codexHome);
  try {
    chmodSync(home, 0o700);
    chmodSync(codexHome, 0o700);
    if (profile.requires_openai_auth) {
      const source = join(process.env.CODEX_HOME ?? join(process.env.HOME ?? "", ".codex"), "auth.json");
      if (!existsSync(source)) throw new Error("Codex auth.json unavailable for M2 reviewer");
      copyFileSync(source, join(codexHome, "auth.json"));
      chmodSync(join(codexHome, "auth.json"), 0o600);
    }
  } catch (error) {
    removeDirs([home, codexHome], registry);
    throw error;
  }
  const env = {};
  for (const key of ["PATH", "TMPDIR", "LANG", "LC_ALL", "TERM", "USER", "SHELL", "SSL_CERT_FILE", "SSL_CERT_DIR", "HTTP_PROXY", "HTTPS_PROXY", "NO_PROXY", ...profile.env_keys]) {
    if (process.env[key] != null) env[key] = process.env[key];
  }
  env.HOME = home;
  env.CODEX_HOME = codexHome;
  env.TERM = env.TERM ?? "dumb";
  return { home, codexHome, env };
}

function createReviewerRunner({ provider, registry = null }) {
  const executable = commandOnPath("codex");
  if (!executable) throw new Error("codex executable unavailable for M2 reviewers");
  const profile = reviewerProviderProfile(provider);
  const active = new Set();

  async function run({ id, model, reasoning, prompt, cwd, tracePath, stderrPath }) {
    const isolated = isolatedReviewerEnvironment(id, profile, registry);
    try {
      const catalogPath = join(isolated.codexHome, "model-catalog.json");
      const catalog = spawnSync(executable, ["debug", "models"], {
        cwd,
        env: process.env,
        encoding: "utf8",
        maxBuffer: 4 * 1024 * 1024,
      });
      if (catalog.status !== 0) throw new Error(`reviewer ${id} model catalog unavailable: ${catalog.stderr.trim()}`);
      let catalogJson;
      try { catalogJson = JSON.parse(catalog.stdout); } catch { throw new Error(`reviewer ${id} model catalog is malformed`); }
      if (!Array.isArray(catalogJson?.models) || !catalogJson.models.some(item => item?.slug === model)) {
        throw new Error(`reviewer ${id} model is absent from the local Codex catalog: ${model}`);
      }
      writeFileSync(catalogPath, `${JSON.stringify(catalogJson)}\n`, { mode: 0o600 });
      const args = [
        "exec", "--json", "--ephemeral", "--ignore-user-config", "--strict-config",
        "--sandbox", "read-only", "-m", model,
        ...profile.cli_args,
        "-c", `model_catalog_json=${tomlLiteral(catalogPath)}`,
        "-c", `model_reasoning_effort=${tomlLiteral(reasoning)}`,
        "-c", "approval_policy=\"never\"",
        "--enable", "multi_agent",
        "-C", cwd,
        "-",
      ];
      for (let attempt = 1; attempt <= 2; attempt++) {
        const result = await spawnJudge(executable, args, { cwd, env: isolated.env, prompt, active });
        const attemptSuffix = attempt === 1 ? ".attempt-1" : "";
        writeFileSync(`${tracePath}${attemptSuffix}`, result.stdout, { mode: 0o600 });
        writeFileSync(`${stderrPath}${attemptSuffix}`, result.stderr, { mode: 0o600 });
        if (result.code === 0) {
          if (attempt === 1) {
            writeFileSync(tracePath, result.stdout, { mode: 0o600 });
            writeFileSync(stderrPath, result.stderr, { mode: 0o600 });
          }
          return { json: lastAgentMessageJson(parseCodexTrace(tracePath), "reviewer did not return parseable JSON"), tracePath, stderrPath, attempts: attempt };
        }
        if (!isTransientJudgeFailure(result.stdout, result.stderr) || attempt === 2) {
          throw new Error(`reviewer ${id} exited ${result.code} after ${attempt} attempt(s): ${result.stderr.trim()}`);
        }
      }
      throw new Error(`reviewer ${id} exhausted its retry budget`);
    } finally {
      removeDirs([isolated.home, isolated.codexHome], registry);
    }
  }

  return {
    role: "reviewer",
    provider: profile.id,
    run,
    terminateAll(signal = "SIGTERM") {
      for (const child of active) killProcessTree(child, signal);
    },
  };
}

function createSimulatedUserRunner({ executable = null, providerProfile = null, provider = "openai", spawnDirector, pathValue, systemShell, zdotdir, runLabel, registry = null }) {
  const codex = executable ?? commandOnPath("codex");
  if (!codex) throw new Error("codex executable unavailable for the simulated user");
  providerProfile ??= controlledProviderProfile(provider);
  async function run({ turn, model, reasoning, prompt, tracePath, stderrPath }) {
    const userWorkspace = mkdtempSync(join(tmpdir(), `superspec-sim-user-${turn}-`));
    registry?.track(userWorkspace);
    const dirs = [userWorkspace];
    try {
      const userAuth = isolatedAuthHome(`${runLabel}-user-${turn}`, providerProfile.requires_openai_auth, { registry });
      dirs.push(userAuth.home, userAuth.codexHome);
      const userEnv = controlledEnv(userAuth.home, userAuth.codexHome, zdotdir, pathValue, systemShell, providerProfile.env_keys);
      const userArgs = [
        "exec", "--json", "--ephemeral", "--skip-git-repo-check", "--ignore-user-config", "--strict-config",
        "--sandbox", "read-only",
        "-m", model,
        ...providerProfile.cli_args,
        "-c", `model_reasoning_effort=${tomlLiteral(reasoning)}`,
        "-c", "approval_policy=\"never\"",
        "--disable", "multi_agent",
        "-C", userWorkspace,
        "-",
      ];
      const result = await spawnDirector(codex, userArgs, {
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
      return { json: lastAgentMessageJson(parseCodexTrace(tracePath), "simulated user did not return parseable JSON"), tracePath, stderrPath, attempts: 1 };
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

export const codexJudgeHost = Object.freeze({
  id: CODEX_JUDGE_ID,
  adapter_version: CODEX_JUDGE_ADAPTER_VERSION,
  stale_temp_dir_rules: [
    // superspec-m2-{home,codex}-m2-<task>-<timestamp>-<pid>-<reviewer>-XXXXXX
    { prefix: "superspec-m2-home-", pid: /^superspec-m2-home-m2-.+-\d{14}-(\d+)-[A-Za-z0-9]+-[A-Za-z0-9]{6}$/ },
    { prefix: "superspec-m2-codex-", pid: /^superspec-m2-codex-m2-.+-\d{14}-(\d+)-[A-Za-z0-9]+-[A-Za-z0-9]{6}$/ },
  ],
  /**
   * @param {{ role: "reviewer", provider: string, registry?: object }
   *   | { role: "simulated_user", executable?: string|null, providerProfile?: object|null, provider?: string, spawnDirector: Function, pathValue: string, systemShell: string, zdotdir: string, runLabel: string, registry?: object }} config
   *   Simulated-user executable/profile are reused from the Worker only when it is also Codex; otherwise resolved here.
   */
  createRunner(config) {
    if (config.role === "reviewer") return createReviewerRunner(config);
    if (config.role === "simulated_user") return createSimulatedUserRunner(config);
    throw new Error(`unsupported codex judge role: ${config.role}`);
  },
  parseTrace: parseCodexTrace,
  sessionIds: judgeSessionIds(parseCodexTrace),
  failureDetail: judgeFailureDetail(parseCodexTrace),
  usageObservations,
});
