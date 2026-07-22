#!/usr/bin/env node

import { createHash } from "node:crypto";
import {
  chmodSync,
  copyFileSync,
  cpSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readlinkSync,
  readdirSync,
  realpathSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { createDirectorSpawner } from "./lib/spawn.mjs";

const EVAL_ROOT = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(EVAL_ROOT, "..");
const RUNS_ROOT = join(REPO_ROOT, ".eval-runs");
const SCENARIO_PATH = join(EVAL_ROOT, "scenarios", "probe-explore.json");
const AUTH_ALLOWED_KEYS = new Set(["OPENAI_API_KEY", "auth_mode", "last_refresh", "tokens"]);
const ENV_ALLOWLIST = [
  "PATH", "HOME", "CODEX_HOME", "ZDOTDIR", "TMPDIR", "LANG", "LC_ALL", "TERM", "USER", "SHELL",
  "SSL_CERT_FILE", "SSL_CERT_DIR", "HTTP_PROXY", "HTTPS_PROXY", "NO_PROXY",
];
const REQUIRED_TOOLS = ["codex", "node", "git", "openspec", "rg", process.platform === "win32" ? "cmd.exe" : "sh"];
const CORE_GATES = ["process", "controlled_environment", "authenticity", "scope", "artifact", "state", "stop_boundary"];
const AUDIT_FORBIDDEN_WORKER_COMMANDS = [
  { family: "superspec_record_user_decision" },
  { family: "superspec_transition_except", allowed_subcommands: ["next", "explore"] },
];
const PROVIDER_ALLOWED_KEYS = new Set(["name", "base_url", "env_key", "wire_api", "requires_openai_auth"]);
const REASONING_LEVELS = new Set(["none", "low", "medium", "high", "xhigh", "max"]);

function parseArgs(argv) {
  const result = {
    validateFaults: false,
    inject: null,
    regrade: null,
    provider: "openai",
    model: "gpt-5.6-terra",
    reasoning: "medium",
    scenario: SCENARIO_PATH,
  };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--validate-faults") result.validateFaults = true;
    else if (argv[i] === "--inject") result.inject = argv[++i] ?? null;
    else if (argv[i] === "--regrade") result.regrade = argv[++i] ?? null;
    else if (argv[i] === "--provider") result.provider = argv[++i] ?? "";
    else if (argv[i] === "--model") result.model = argv[++i] ?? "";
    else if (argv[i] === "--reasoning") result.reasoning = argv[++i] ?? "";
    else if (argv[i] === "--scenario") result.scenario = resolve(argv[++i] ?? "");
    else throw new Error(`unknown argument: ${argv[i]}`);
  }
  if (!/^[A-Za-z0-9_-]+$/.test(result.provider)) throw new Error(`invalid provider: ${result.provider}`);
  if (!/^[A-Za-z0-9._-]+$/.test(result.model)) throw new Error(`invalid model: ${result.model}`);
  if (!REASONING_LEVELS.has(result.reasoning)) throw new Error(`invalid reasoning: ${result.reasoning}`);
  return result;
}

function stripTomlComment(line) {
  let quote = null;
  let escaped = false;
  for (let i = 0; i < line.length; i++) {
    const char = line[i];
    if (escaped) {
      escaped = false;
      continue;
    }
    if (quote === '"' && char === "\\") {
      escaped = true;
      continue;
    }
    if (char === '"' || char === "'") {
      quote = quote === char ? null : quote ?? char;
      continue;
    }
    if (char === "#" && quote === null) return line.slice(0, i);
  }
  return line;
}

function parseTomlScalar(raw, key) {
  const value = stripTomlComment(raw).trim();
  if (value.startsWith('"') && value.endsWith('"')) return JSON.parse(value);
  if (value.startsWith("'") && value.endsWith("'")) return value.slice(1, -1);
  if (value === "true") return true;
  if (value === "false") return false;
  throw new Error(`unsupported provider config value for ${key}`);
}

function tomlLiteral(value) {
  return typeof value === "boolean" ? String(value) : JSON.stringify(value);
}

function controlledProviderProfile(provider, options = {}) {
  if (provider === "openai") {
    return {
      id: provider,
      source_type: "codex_builtin_provider",
      requires_openai_auth: true,
      env_keys: [],
      config_digest: sha256(JSON.stringify({ provider })),
      cli_args: ["-c", `model_provider=${tomlLiteral(provider)}`],
      selected_config_keys: [],
    };
  }

  const sourceEnv = options.env ?? process.env;
  const codexHome = sourceEnv.CODEX_HOME ?? join(sourceEnv.HOME ?? "", ".codex");
  const configPath = options.configPath ?? join(codexHome, "config.toml");
  if (!existsSync(configPath)) throw new Error(`Codex provider config unavailable for ${provider}`);
  const section = `[model_providers.${provider}]`;
  const selected = {};
  let active = false;
  for (const rawLine of readFileSync(configPath, "utf8").split(/\r?\n/)) {
    const line = stripTomlComment(rawLine).trim();
    if (line.startsWith("[") && line.endsWith("]")) {
      active = line === section;
      continue;
    }
    if (!active || !line || line.startsWith("#")) continue;
    const match = /^([A-Za-z0-9_-]+)\s*=\s*(.+)$/.exec(line);
    if (!match || !PROVIDER_ALLOWED_KEYS.has(match[1])) continue;
    selected[match[1]] = parseTomlScalar(match[2], match[1]);
  }

  const name = typeof selected.name === "string" && selected.name ? selected.name : provider;
  if (typeof selected.base_url !== "string") throw new Error(`provider ${provider} has no valid base_url`);
  let baseUrl;
  try { baseUrl = new URL(selected.base_url); } catch { throw new Error(`provider ${provider} has no valid base_url`); }
  if (!["http:", "https:"].includes(baseUrl.protocol) || baseUrl.username || baseUrl.password || baseUrl.search || baseUrl.hash) {
    throw new Error(`provider ${provider} base_url must be credential-free http(s) without query or fragment`);
  }
  if (typeof selected.env_key !== "string" || !/^[A-Z][A-Z0-9_]*$/.test(selected.env_key)) throw new Error(`provider ${provider} has no valid env_key`);
  if (typeof selected.wire_api !== "string" || !["responses", "chat"].includes(selected.wire_api)) throw new Error(`provider ${provider} has unsupported wire_api`);
  if (selected.requires_openai_auth != null && typeof selected.requires_openai_auth !== "boolean") throw new Error(`provider ${provider} has invalid requires_openai_auth`);
  if (!sourceEnv[selected.env_key]) throw new Error(`provider credential environment variable is unavailable: ${selected.env_key}`);

  const normalized = {
    name,
    base_url: selected.base_url,
    env_key: selected.env_key,
    wire_api: selected.wire_api,
    requires_openai_auth: selected.requires_openai_auth ?? false,
  };
  const prefix = `model_providers.${provider}`;
  return {
    id: provider,
    source_type: "host_codex_provider_whitelist",
    requires_openai_auth: normalized.requires_openai_auth,
    env_keys: [normalized.env_key],
    config_digest: sha256(JSON.stringify(normalized)),
    cli_args: [
      "-c", `model_provider=${tomlLiteral(provider)}`,
      "-c", `${prefix}.name=${tomlLiteral(normalized.name)}`,
      "-c", `${prefix}.base_url=${tomlLiteral(normalized.base_url)}`,
      "-c", `${prefix}.env_key=${tomlLiteral(normalized.env_key)}`,
      "-c", `${prefix}.wire_api=${tomlLiteral(normalized.wire_api)}`,
      "-c", `${prefix}.requires_openai_auth=${tomlLiteral(normalized.requires_openai_auth)}`,
    ],
    selected_config_keys: Object.keys(normalized).sort(),
    metadata: {
      env_key: normalized.env_key,
      wire_api: normalized.wire_api,
      requires_openai_auth: normalized.requires_openai_auth,
      base_url_digest: sha256(normalized.base_url),
      base_url_protocol: new URL(normalized.base_url).protocol,
    },
  };
}

function isoForPath() {
  return new Date().toISOString().replace(/[-:.TZ]/g, "").slice(0, 14);
}

function sha256(data) {
  return `sha256:${createHash("sha256").update(data).digest("hex")}`;
}

function hashFile(path) {
  return sha256(readFileSync(path));
}

function currentEvaluatorDigest() {
  return sha256(JSON.stringify({
    probe: hashFile(fileURLToPath(import.meta.url)),
    spawn: hashFile(join(EVAL_ROOT, "lib", "spawn.mjs")),
  }));
}

function json(path) {
  return JSON.parse(readFileSync(path, "utf8"));
}

function writeJson(path, value) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
}

function posix(relativePath) {
  return relativePath.split(sep).join("/");
}

function walk(root, options = {}) {
  const out = [];
  const exclude = options.exclude ?? (() => false);
  const visit = (current, rel) => {
    const names = readdirSync(current).sort();
    for (const name of names) {
      const childRel = rel ? `${rel}/${name}` : name;
      if (exclude(childRel)) continue;
      const full = join(current, name);
      const stat = lstatSync(full);
      const base = { path: childRel, mode: stat.mode & 0o7777 };
      if (stat.isSymbolicLink()) {
        let target = null;
        let dangling = false;
        try { target = realpathSync(full); } catch { dangling = true; }
        out.push({ ...base, type: "symlink", link: readlinkSync(full), target, dangling });
      } else if (stat.isDirectory()) {
        out.push({ ...base, type: "directory", size: stat.size });
        visit(full, childRel);
      } else if (stat.isFile()) {
        out.push({ ...base, type: "file", size: stat.size, digest: hashFile(full) });
      } else {
        out.push({ ...base, type: "other", size: stat.size });
      }
    }
  };
  visit(root, "");
  return out;
}

function treeDigest(root, exclude = () => false) {
  const contentIdentity = walk(root, { exclude }).map(entry => ({
    path: entry.path,
    type: entry.type,
    ...(entry.digest ? { digest: entry.digest } : {}),
    ...(entry.target ? { target: entry.target } : {}),
  }));
  return sha256(JSON.stringify(contentIdentity));
}

function inventory(root) {
  return walk(root, { exclude: path => path === ".git" || path.startsWith(".git/") });
}

function directoryStructure(root, exclude = new Set()) {
  if (!existsSync(root)) return [];
  const entries = [];
  const visit = (current, rel) => {
    for (const name of readdirSync(current).sort()) {
      const childRel = rel ? `${rel}/${name}` : name;
      if (exclude.has(childRel)) continue;
      const full = join(current, name);
      const stat = lstatSync(full);
      entries.push({ path: childRel, type: stat.isDirectory() ? "directory" : stat.isFile() ? "file" : stat.isSymbolicLink() ? "symlink" : "other", mode: stat.mode & 0o7777 });
      if (stat.isDirectory()) visit(full, childRel);
    }
  };
  visit(root, "");
  return entries;
}

function sessionStorageEvidence(codexHome, threadId) {
  const structure = directoryStructure(codexHome, new Set(["auth.json"]));
  const sessionFiles = structure.filter(entry => entry.type === "file" && entry.path.includes(threadId));
  return {
    non_auth_entry_count: structure.length,
    matching_session_file_count: sessionFiles.length,
    matching_session_paths: sessionFiles.map(entry => entry.path),
    stored: sessionFiles.length > 0,
  };
}

function inventoryChanges(before, after) {
  const left = new Map(before.map(entry => [entry.path, entry]));
  const right = new Map(after.map(entry => [entry.path, entry]));
  const paths = [...new Set([...left.keys(), ...right.keys()])].sort();
  return paths.flatMap(path => {
    const a = left.get(path) ?? null;
    const b = right.get(path) ?? null;
    return JSON.stringify(a) === JSON.stringify(b) ? [] : [{ path, before: a, after: b }];
  });
}

function commandOnPath(name, pathValue) {
  if (name.includes(sep)) return existsSync(name) ? realpathSync(name) : null;
  for (const dir of pathValue.split(process.platform === "win32" ? ";" : ":")) {
    if (!dir) continue;
    const candidate = join(dir, name);
    if (existsSync(candidate)) return realpathSync(candidate);
  }
  return null;
}

function resolveHostTools(injection) {
  const hostPath = process.env.PATH ?? "";
  const tools = {};
  for (const name of REQUIRED_TOOLS) {
    tools[name] = injection === "missing-codex" && name === "codex" ? null : commandOnPath(name, hostPath);
  }
  for (const extra of ["zsh", "ls", "cat", "sed", "find", "mkdir", "cp", "mv", "rm", "pwd", "head", "tail", "sort", "wc", "xargs"]) {
    const found = commandOnPath(extra, hostPath);
    if (found) tools[extra] = found;
  }
  return tools;
}

function makeControlledPath(localBin) {
  const dirs = [localBin];
  for (const systemDir of ["/usr/bin", "/bin", "/usr/sbin", "/sbin"]) {
    if (existsSync(systemDir)) dirs.push(systemDir);
  }
  return [...new Set(dirs)].join(process.platform === "win32" ? ";" : ":");
}

function materializeToolShims(localBin, tools, run) {
  const systemRoots = ["/usr/bin/", "/bin/", "/usr/sbin/", "/sbin/"];
  const shims = {};
  for (const [name, executable] of Object.entries(tools)) {
    if (!executable || systemRoots.some(root => executable.startsWith(root))) continue;
    const target = join(localBin, name);
    if (existsSync(target)) continue;
    symlinkSync(executable, target);
    shims[name] = { path: target, realpath: realpathSync(target) };
  }
  run.recordMutation("setup.path.materialize-tool-shims", localBin, { shims });
  return shims;
}

function isolatedAuthHome(runId, requiresOpenaiAuth = true) {
  const home = mkdtempSync(join(tmpdir(), `superspec-probe-home-${runId}-`));
  const codexHome = mkdtempSync(join(tmpdir(), `superspec-probe-codex-${runId}-`));
  chmodSync(home, 0o700);
  chmodSync(codexHome, 0o700);
  const source = join(process.env.CODEX_HOME ?? join(process.env.HOME ?? "", ".codex"), "auth.json");
  const target = join(codexHome, "auth.json");
  let auth = requiresOpenaiAuth
    ? { source_type: "missing", exists: false, required: true, mode_ok: false, top_level_keys: [] }
    : { source_type: "not_required", exists: false, required: false, mode_ok: true, top_level_keys: [] };
  if (requiresOpenaiAuth && existsSync(source)) {
    const parsed = json(source);
    const keys = Object.keys(parsed).filter(key => AUTH_ALLOWED_KEYS.has(key)).sort();
    copyFileSync(source, target);
    chmodSync(target, 0o600);
    auth = {
      source_type: "codex_auth_json_copy",
      exists: true,
      required: true,
      mode_ok: (statSync(target).mode & 0o777) === 0o600,
      top_level_keys: keys,
    };
  }
  return { home, codexHome, auth };
}

function controlledEnv(home, codexHome, zdotdir, pathValue, systemShell, providerEnvKeys = []) {
  const source = process.env;
  const env = {};
  for (const key of ENV_ALLOWLIST) {
    if (source[key] != null) env[key] = source[key];
  }
  for (const key of providerEnvKeys) {
    if (source[key] != null) env[key] = source[key];
  }
  env.PATH = pathValue;
  env.HOME = home;
  env.CODEX_HOME = codexHome;
  env.ZDOTDIR = zdotdir;
  env.TMPDIR = source.TMPDIR ?? tmpdir();
  env.LANG = source.LANG ?? "en_US.UTF-8";
  env.LC_ALL = source.LC_ALL ?? "en_US.UTF-8";
  env.TERM = source.TERM ?? "dumb";
  env.USER = source.USER ?? "probe";
  env.SHELL = systemShell;
  return env;
}

function gate(status, evidence, detail, evidenceLevel = status === "unavailable" ? "unavailable" : "correlated") {
  return { status, evidence, evidence_level: evidenceLevel, ...(detail ? { detail } : {}) };
}

function workerProcessStatus(codes, timeouts, timeoutRecoveries, label = "Codex") {
  const recoveredTimeoutCount = timeouts.filter((timedOut, index) => timedOut && timeoutRecoveries[index] === true).length;
  const unrecoveredTimeoutCount = timeouts.filter((timedOut, index) => timedOut && timeoutRecoveries[index] !== true).length;
  const exitedCleanly = codes.every(code => code === 0) && unrecoveredTimeoutCount === 0;
  return {
    exitedCleanly,
    recoveredTimeoutCount,
    unrecoveredTimeoutCount,
    detail: exitedCleanly
      ? recoveredTimeoutCount > 0
        ? `${codes.length} ${label} turns exited cleanly; ${recoveredTimeoutCount} timed-out turn(s) were followed by recoverable workflow evidence`
        : `${codes.length} ${label} turn(s) completed with exit code 0`
      : `${label} exit codes ${codes.join("/")}; timed_out=${timeouts.join("/")}; recovered=${timeoutRecoveries.join("/")}`,
  };
}

function timeoutRecoveryFlags(timeouts, turnAuthenticities, sameThread, dynamicStop = null) {
  return timeouts.map((timedOut, index) => {
    if (!timedOut) return false;
    const laterSameThreadEvidence = sameThread === true && turnAuthenticities
      .slice(index + 1)
      .some(item => item?.status === "pass" && item.sequence?.ok === true && item.sequence?.boundary === true);
    const terminalBoundaryEvidence = turnAuthenticities[index]?.status === "pass"
      && turnAuthenticities[index]?.sequence?.ok === true
      && turnAuthenticities[index]?.sequence?.boundary === true
      && dynamicStop?.after_worker_turn === index + 1
      && ["complete", "needs_human"].includes(dynamicStop.action);
    return laterSameThreadEvidence || terminalBoundaryEvidence;
  });
}

function emptyCapability(scenarioId) {
  return {
    schema_version: 1,
    scenario_id: scenarioId,
    scenario_result: "INVALID",
    capability_verdict: "NO_GO",
    semantic_quality: "ungraded",
    exit_code: 3,
    gates: Object.fromEntries(CORE_GATES.map(name => [name, gate("unavailable", [])])),
    limitations: [],
  };
}

function finalizeCapability(capability) {
  const values = CORE_GATES.map(name => capability.gates[name].status);
  if (values.includes("fail")) {
    capability.scenario_result = "FAIL";
    capability.capability_verdict = "NO_GO";
    capability.exit_code = 1;
  } else if (values.includes("unavailable")) {
    capability.scenario_result = "INVALID";
    capability.capability_verdict = "NO_GO";
    capability.exit_code = 3;
  } else {
    capability.scenario_result = "PASS";
    capability.capability_verdict = capability.limitations.length ? "GO_WITH_LIMITATIONS" : "GO";
    capability.exit_code = capability.limitations.length ? 2 : 0;
  }
  return capability;
}

function safeRealpath(path) {
  try { return realpathSync(path); } catch { return null; }
}

function withinRoot(path, root) {
  const rel = relative(realpathSync(root), realpathSync(path));
  return rel === "" || (!rel.startsWith(`..${sep}`) && rel !== "..");
}

function safeRegularFile(path, workspace) {
  try {
    const stat = lstatSync(path);
    if (!stat.isFile() || stat.isSymbolicLink()) return { ok: false, reason: "not_regular_non_symlink" };
    if (!withinRoot(path, workspace)) return { ok: false, reason: "realpath_outside_workspace" };
    return { ok: true, realpath: realpathSync(path), stat };
  } catch (error) {
    return { ok: false, reason: error instanceof Error ? error.message : String(error) };
  }
}

function safeRegularWithin(path, root) {
  try {
    const stat = lstatSync(path);
    if (!stat.isFile() || stat.isSymbolicLink()) return { ok: false, reason: "not_regular_non_symlink" };
    if (!withinRoot(path, root)) return { ok: false, reason: "realpath_outside_frozen_root" };
    return { ok: true, realpath: realpathSync(path), stat };
  } catch (error) {
    return { ok: false, reason: error instanceof Error ? error.message : String(error) };
  }
}

function confinedWorkspaceWriteTarget(workspace, relativePath) {
  if (typeof relativePath !== "string" || relativePath.trim() === "" || isAbsolute(relativePath)) {
    throw new Error(`workspace fixture path must be a non-empty relative path: ${relativePath}`);
  }
  const target = resolve(workspace, relativePath);
  const rel = relative(workspace, target);
  if (rel === ".." || rel.startsWith(`..${sep}`) || isAbsolute(rel)) {
    throw new Error(`workspace fixture path escapes workspace: ${relativePath}`);
  }
  let current = workspace;
  for (const segment of rel.split(sep).filter(Boolean)) {
    current = join(current, segment);
    if (!existsSync(current)) continue;
    if (lstatSync(current).isSymbolicLink()) {
      throw new Error(`workspace fixture path crosses symlink: ${relativePath}`);
    }
  }
  return target;
}

function executableAllowed(value, identities, bareResolutionProven = false) {
  if (value === "superspec") return bareResolutionProven;
  if (!isAbsolute(value)) return false;
  const resolved = safeRealpath(value);
  return resolved != null && identities.some(identity => resolved === identity);
}

function canonicalSuperspecArgv(commandText) {
  if (!commandText || /(?:&&|\|\||[;|<>\n\r])/.test(commandText)) return null;
  const trimmed = commandText.trim();
  const transition = trimmed.match(/^superspec\s+transition\s+(next|explore|propose-ready|start-apply|review-ready|accept)\s+--change\s+(?:'([^']+)'|"([^"]+)"|([A-Za-z0-9._-]+))$/);
  const taskTransition = trimmed.match(/^superspec\s+transition\s+(task-start|task-complete)\s+--change\s+(?:'([^']+)'|"([^"]+)"|([A-Za-z0-9._-]+))\s+--task\s+(?:'([^']+)'|"([^"]+)"|([A-Za-z0-9._-]+))$/);
  const status = trimmed.match(/^superspec\s+status\s+--change\s+(?:'([^']+)'|"([^"]+)"|([A-Za-z0-9._-]+))$/);
  if (!transition && !taskTransition && !status) return null;
  const change = transition
    ? (transition[2] ?? transition[3] ?? transition[4])
    : taskTransition
      ? (taskTransition[2] ?? taskTransition[3] ?? taskTransition[4])
      : (status[1] ?? status[2] ?? status[3]);
  if (!/^[A-Za-z0-9._-]+$/.test(change)) return null;
  if (transition) return ["superspec", "transition", transition[1], "--change", change];
  if (taskTransition) {
    const task = taskTransition[5] ?? taskTransition[6] ?? taskTransition[7];
    if (!/^[A-Za-z0-9._-]+$/.test(task)) return null;
    return ["superspec", "transition", taskTransition[1], "--change", change, "--task", task];
  }
  return ["superspec", "status", "--change", change];
}

function boundedShellCommand(raw) {
  let match = raw.match(/^\/bin\/zsh\s+-lc\s+'([^']*)'$/s);
  if (match) return canonicalSuperspecArgv(match[1]);
  match = raw.match(/^\/bin\/zsh\s+-lc\s+"((?:[^"\\]|\\.)*)"$/s);
  if (!match) return null;
  const inner = match[1].replace(/\\(["\\])/g, "$1");
  return canonicalSuperspecArgv(inner);
}

function exactCommand(command, workspace, executableIdentities = [], bareResolutionProven = false) {
  if (!command || typeof command !== "object") return { kind: "unknown" };
  const status = command.status;
  const exitCode = command.exit_code ?? command.exitCode;
  const cwd = command.cwd ?? command.workdir ?? command.working_directory;
  const output = command.aggregated_output ?? command.output ?? "";
  const argv = Array.isArray(command.argv)
    ? command.argv
    : Array.isArray(command.command)
      ? command.command
      : null;
  let parsedArgv = null;
  if (argv && argv.every(value => typeof value === "string")) {
    parsedArgv = argv;
  } else if (typeof command.command === "string") {
    const raw = command.command.trim();
    const bounded = boundedShellCommand(raw);
    const canonical = canonicalSuperspecArgv(raw);
    if (bounded) parsedArgv = bounded;
    else if (canonical) parsedArgv = canonical;
    else if (/^(?:\/bin\/(?:zsh|sh)|zsh|sh)\s+-[a-z]*c\b/.test(raw)) {
      return { kind: "shell_wrapper", raw, status, exitCode, output };
    }
    else if (!raw || /(?:&&|\|\||[;|<>\n\r])/.test(raw)) return { kind: "unsafe_string", raw };
    else return { kind: "other_direct", raw };
  } else {
    return { kind: "unknown" };
  }

  if (typeof status !== "string") return { kind: "missing_status", argv: parsedArgv, output };
  if (status !== "completed") return { kind: "non_completed", argv: parsedArgv, status, output };
  if (!Number.isInteger(exitCode)) return { kind: "missing_exit_code", argv: parsedArgv, output };
  if (exitCode !== 0) return { kind: "failed", argv: parsedArgv, exitCode, output };
  const effectiveCwd = typeof cwd === "string" ? cwd : boundedShellCommand(command.command ?? "") ? workspace : null;
  if (effectiveCwd == null) return { kind: "missing_cwd", argv: parsedArgv, output };
  if (resolve(effectiveCwd) !== resolve(workspace)) return { kind: "wrong_cwd", argv: parsedArgv, cwd: effectiveCwd, output };
  return {
    kind: "direct",
    argv: parsedArgv,
    executable_allowed: executableAllowed(parsedArgv[0], executableIdentities, bareResolutionProven),
    cwd_source: typeof cwd === "string" ? "event" : "controlled_worker_launch",
    raw: typeof command.command === "string" ? command.command : undefined,
    output,
  };
}

function commandObjects(event) {
  if (event?.type === "item.completed" && event.item?.type === "command_execution") return [event.item];
  if (event?.type === "command_execution" || event?.type === "command.completed") return [event];
  if (event?.item?.type === "command_execution" && event?.item?.status === "completed") return [event.item];
  return [];
}

function parseTrace(tracePath, workspace, injection, executableIdentities, bareResolutionProven, recordMutation) {
  const tracePaths = Array.isArray(tracePath) ? tracePath : [tracePath];
  const rawLines = tracePaths.flatMap(path => existsSync(path) ? readFileSync(path, "utf8").split("\n").filter(Boolean) : []);
  if (injection === "unknown-jsonl") {
    const injected = JSON.stringify({ type: "future.event", payload: { retained: true } });
    const injectionPath = tracePaths[0];
    writeFileSync(injectionPath, `${readFileSync(injectionPath, "utf8")}${injected}\n`, { mode: 0o600 });
    rawLines.push(injected);
    recordMutation?.("injection.trace.unknown-jsonl", injectionPath, { injection });
  }
  const events = [];
  let malformed = 0;
  for (const line of rawLines) {
    try { events.push(JSON.parse(line)); } catch { malformed++; }
  }
  const commands = events.flatMap(commandObjects).map(item => exactCommand(item, workspace, executableIdentities, bareResolutionProven));
  const direct = commands.filter(item => item.kind === "direct");
  if (injection === "hide-required-command") {
    direct.splice(0, 1);
    recordMutation?.("injection.trace.hide-required-command", tracePaths[0], { injection });
  }
  const commandSchemaRecognized = events.some(event =>
    event?.type === "item.started" ||
    event?.type === "item.completed" ||
    event?.type === "command_execution" ||
    event?.type === "command.completed" ||
    event?.item?.type === "command_execution"
  );
  return { events, commands, direct, malformed, raw_event_count: rawLines.length, commandSchemaRecognized };
}

function traceThreadIds(tracePath) {
  if (!existsSync(tracePath)) return [];
  const ids = [];
  for (const line of readFileSync(tracePath, "utf8").split("\n").filter(Boolean)) {
    try {
      const event = JSON.parse(line);
      const id = event.thread_id ?? event.thread?.id;
      if ((event.type === "thread.started" || event.type === "thread.resumed") && typeof id === "string") ids.push(id);
    } catch {}
  }
  return [...new Set(ids)];
}

function traceAgentMessages(tracePath) {
  if (!existsSync(tracePath)) return [];
  const messages = [];
  for (const line of readFileSync(tracePath, "utf8").split("\n").filter(Boolean)) {
    try {
      const event = JSON.parse(line);
      if (event?.type === "item.completed" && event.item?.type === "agent_message" && typeof event.item.text === "string") messages.push(event.item.text);
    } catch {}
  }
  return messages;
}

function turnTracePath(evidenceDir, turn) {
  return join(evidenceDir, `turn-${turn}.jsonl`);
}

function turnStderrPath(evidenceDir, turn) {
  return join(evidenceDir, `turn-${turn}.stderr.log`);
}

function dynamicTurnLimit(scenario) {
  const value = scenario.budget?.max_worker_turns ?? scenario.stop?.max_turns ?? 12;
  if (!Number.isInteger(value) || value < 1 || value > 100) throw new Error("dynamic_user max_worker_turns must be an integer between 1 and 100");
  return value;
}

function multiAgentEnabledForScenario(scenario) {
  return scenario?.fixture?.enable_multi_agent !== false;
}

function workerTurnTimeoutMs(scenario) {
  const value = scenario.budget?.worker_turn_timeout_ms ?? 600_000;
  if (!Number.isInteger(value) || value < 60_000 || value > 3_600_000) throw new Error("worker_turn_timeout_ms must be an integer between 60000 and 3600000");
  return value;
}

function dynamicTracePaths(evidenceDir, turnCount) {
  return Array.from({ length: turnCount }, (_, index) => turnTracePath(evidenceDir, index + 1));
}

function evalWorkerPrompt(prompt) {
  return prompt;
}

function workerPromptEvidence(turn, originalPrompt, effectivePrompt, source, additions = []) {
  return {
    turn,
    source,
    original_prompt: originalPrompt,
    original_prompt_digest: sha256(originalPrompt),
    effective_prompt: effectivePrompt,
    effective_prompt_digest: sha256(effectivePrompt),
    additions,
  };
}

function observedWorkflowBoundary(trace) {
  const isDirectBoundary = item =>
    Array.isArray(item.argv)
    && item.executable_allowed === true
    && item.argv[1] === "transition"
    && ["next", "accept"].includes(item.argv[2]);
  const isShellBoundary = item => {
    const completedWrapper = item.kind === "shell_wrapper" && item.status === "completed" && item.exitCode === 0;
    if (!completedWrapper && item.executable_allowed !== true) return false;
    if (typeof item.raw !== "string") return false;
    return /(?:^|[;&|\n]\s*)superspec\s+transition\s+(?:next|accept)\b/.test(unwrapCommandForPolicy(item.raw));
  };
  const candidates = Array.isArray(trace.commands) && trace.commands.length > 0 ? trace.commands : trace.direct;
  const command = [...candidates].reverse().find(item => isDirectBoundary(item) || isShellBoundary(item));
  if (!command) return null;
  const output = parseLastJson(command.output);
  return { command, output, observation: isDirectBoundary(command) ? "direct" : "completed_shell_command" };
}

function classifyDynamicTurn(trace, workerCode) {
  if (workerCode !== 0) return { status: "unavailable", detail: `Worker exited ${workerCode}`, sequence: { ok: false } };
  if (trace.malformed > 0 || !trace.commandSchemaRecognized) {
    return { status: "unavailable", detail: "command event schema is not safely recognizable", sequence: { ok: false } };
  }
  const boundary = observedWorkflowBoundary(trace);
  if (!boundary) return { status: "pass", detail: "Worker turn completed without a directly observed workflow boundary; resume the same thread", sequence: { ok: true, boundary: false } };
  const label = Array.isArray(boundary.command.argv)
    ? boundary.command.argv.slice(1, 3).join(" ")
    : "completed shell workflow";
  return { status: "pass", detail: `directly observed ${label} boundary`, sequence: { ok: true, boundary: true } };
}

function dynamicExecutionStop(turn, classification) {
  return {
    action: "invalid_execution",
    after_worker_turn: turn,
    reason: classification.detail,
    evidence_status: classification.status,
  };
}

function workflowRecommendedAnswer(question, allowedAnswers = []) {
  const explicitLabels = [...question.matchAll(/(?:建议|推荐)\s*[：:]?\s*(?:选择|采用)?\s*([A-Z])\b/gu)]
    .map(match => match[1]);
  const markedLabels = [...question.matchAll(/(?:^|[\s/；,，：:])([A-Z])(?:[.．、：:\s]|$)[^/\n。]{0,160}?（推荐/gu)]
    .map(match => match[1]);
  const labels = [...new Set([...explicitLabels, ...markedLabels])];

  if (allowedAnswers.length > 0) {
    const directlyMarked = allowedAnswers.filter(answer =>
      question.includes(`${answer}（推荐`)
      || question.includes(`${answer}(推荐`)
      || question.includes(`建议：${answer}`)
      || question.includes(`建议: ${answer}`)
    );
    if (directlyMarked.length === 1) return directlyMarked[0];
    if (labels.length === 1) {
      const index = labels[0].charCodeAt(0) - 65;
      if (index >= 0 && index < allowedAnswers.length) return allowedAnswers[index];
    }
    return null;
  }

  if (labels.length !== 1) return null;
  return `选择 ${labels[0]}：采用工作流明确推荐的方案。`;
}

function simulatedUserDecision(nextOutput, policy = {}) {
  if (nextOutput?.path === "done" || nextOutput?.to_state === "accepted") {
    return { action: "complete", reason: "workflow reached its declared terminal result" };
  }
  if (nextOutput?.path !== "ask_user" || nextOutput.ask_user == null) {
    return { action: "needs_human", reason: "Worker did not expose a workflow ask_user boundary" };
  }
  const question = String(nextOutput.ask_user.question ?? "");
  const scope = String(nextOutput.ask_user.scope ?? "");
  const allowedAnswers = Array.isArray(nextOutput.ask_user.allowed_answers)
    ? nextOutput.ask_user.allowed_answers.filter(answer => typeof answer === "string" && answer.trim() !== "")
    : [];
  const stopPrefixes = policy.stop_scope_prefixes ?? [];
  if (stopPrefixes.some(prefix => scope.startsWith(prefix))) {
    return {
      action: "needs_human",
      reason: "workflow reached a boundary reserved for human approval by the simulated-user policy",
      question,
      scope,
      allowed_answers: allowedAnswers,
      source: "configured_stop_scope",
    };
  }
  for (const rule of policy.answers_by_question_pattern ?? []) {
    if (typeof rule?.pattern !== "string" || typeof rule?.answer !== "string") continue;
    let matches = false;
    try { matches = new RegExp(rule.pattern, "u").test(question); } catch { continue; }
    if (matches && (allowedAnswers.length === 0 || allowedAnswers.includes(rule.answer))) {
      return {
        action: "reply",
        answer: rule.answer,
        question,
        scope,
        source: "configured_question_answer",
      };
    }
  }
  const configured = Object.entries(policy.answers_by_scope_prefix ?? {})
    .find(([prefix]) => scope.startsWith(prefix))?.[1];
  if (typeof configured === "string" && allowedAnswers.includes(configured)) {
    return { action: "reply", answer: configured, question, scope, source: "configured_scope_answer" };
  }
  const autoPrefixes = policy.auto_confirm_scope_prefixes ?? ["phase_confirmation:"];
  if (autoPrefixes.some(prefix => scope.startsWith(prefix))) {
    const affirmative = allowedAnswers.find(answer => /确认|同意|进入|开始/.test(answer) && !/暂不|不进入|不同意|拒绝|取消/.test(answer));
    if (affirmative) return { action: "reply", answer: affirmative, question, scope, source: "phase_confirmation_policy" };
  }
  if (policy.follow_workflow_recommendation !== false) {
    const recommended = workflowRecommendedAnswer(question, allowedAnswers);
    if (recommended != null) {
      return { action: "reply", answer: recommended, question, scope, source: "workflow_recommendation" };
    }
  }
  return { action: "needs_human", reason: "workflow question requires an answer not authorized by the simulated-user policy", question, scope, allowed_answers: allowedAnswers };
}

function simulatedUserTurnFromOutput(nextOutput, scenario) {
  if (nextOutput?.path === "done" || nextOutput?.to_state === "accepted") {
    return { action: "complete", reason: "workflow reached its declared terminal result", next_output: nextOutput };
  }
  if (nextOutput?.path !== "ask_user") {
    const workerPromptOriginal = "继续推进。";
    return {
      action: "continue",
      reason: "workflow returned a non-user action",
      next_output: nextOutput,
      worker_prompt_original: workerPromptOriginal,
      worker_prompt: evalWorkerPrompt(workerPromptOriginal),
    };
  }
  const decision = simulatedUserDecision(nextOutput, scenario.simulated_user);
  if (decision.action !== "reply") return { ...decision, next_output: nextOutput };
  const workerPromptOriginal = decision.answer;
  return {
    ...decision,
    next_output: nextOutput,
    worker_prompt_original: workerPromptOriginal,
    worker_prompt: evalWorkerPrompt(workerPromptOriginal),
  };
}

function agentMessageRequestsUserReply(tracePath) {
  const message = traceAgentMessages(tracePath).at(-1)?.trim() ?? "";
  if (message === "") return null;
  const requestsReply = /(?:请|需要|等待|等你|由你).{0,32}(?:回复|答复|选择|确认|决定)|(?:回复|答复|选择|确认)[：:]|请选择|(?:please|need you to|waiting for you to).{0,48}(?:reply|respond|choose|confirm|decide)/iu.test(message);
  return requestsReply ? message : null;
}

function simulatedUserTurnFromTrace(tracePath, workspace, executableIdentities, bareResolutionProven, scenario) {
  const trace = parseTrace(tracePath, workspace, null, executableIdentities, bareResolutionProven, null);
  const boundary = observedWorkflowBoundary(trace);
  if (!boundary && scenario.simulated_user?.mode === "ai") {
    const question = agentMessageRequestsUserReply(tracePath);
    if (question != null) {
      return simulatedUserTurnFromOutput({
        path: "ask_user",
        ask_user: {
          question,
          scope: "agent_message:explicit_user_reply",
          allowed_answers: [],
        },
      }, scenario);
    }
  }
  return simulatedUserTurnFromOutput(boundary?.output ?? null, scenario);
}

function parseAgentMessageJson(tracePath) {
  const messages = traceAgentMessages(tracePath);
  const text = messages.at(-1) ?? "";
  const candidates = [
    text,
    text.match(/```(?:json)?\s*([\s\S]*?)```/i)?.[1],
    text.slice(text.indexOf("{"), text.lastIndexOf("}") + 1),
  ].filter(Boolean);
  for (const candidate of candidates) {
    try { return JSON.parse(candidate.trim()); } catch {}
  }
  throw new Error("simulated user did not return parseable JSON");
}

async function resolveSimulatedUserTurn({
  turn,
  tracePath,
  workspace,
  executableIdentities,
  bareResolutionProven,
  scenario,
  run,
  codex,
  providerProfile,
  model,
  reasoning,
  pathValue,
  systemShell,
  runRoot,
}) {
  const policyTurn = simulatedUserTurnFromTrace(tracePath, workspace, executableIdentities, bareResolutionProven, scenario);
  if (scenario.simulated_user?.mode !== "ai"
    || policyTurn.action === "complete"
    || policyTurn.source === "configured_stop_scope"
    || policyTurn.source === "configured_question_answer"
    || policyTurn.source === "configured_scope_answer"
    || policyTurn.source === "phase_confirmation_policy"
    || policyTurn.source === "workflow_recommendation") return policyTurn;
  const nextOutput = policyTurn.next_output;
  if (nextOutput?.path !== "ask_user") return policyTurn;
  const userTracePath = join(runRoot, "evidence", `user-turn-${turn}.jsonl`);
  const userStderrPath = join(runRoot, "evidence", `user-turn-${turn}.stderr.log`);
  const userWorkspace = mkdtempSync(join(tmpdir(), `superspec-sim-user-${turn}-`));
  const userAuth = isolatedAuthHome(`${basename(runRoot)}-user-${turn}`, providerProfile.requires_openai_auth);
  const userEnv = controlledEnv(userAuth.home, userAuth.codexHome, join(runRoot, "zdot"), pathValue, systemShell, providerProfile.env_keys);
  const advanceUntilTerminal = scenario.simulated_user?.advance_until_terminal !== false;
  const prompt = [
    "你是评测考场中的独立模拟用户。你不是开发者，不得读取工作区、日志、源码或隐藏文件，也不得调用工具。",
    advanceUntilTerminal
      ? "你的职责是配合工作流持续推进到终态。优先采用工作流明确推荐的答案；没有明确推荐时，依据公开需求、用户人设和已知事实选择最合理的答案，不得仅因存在取舍而停止。"
      : "只能依据公开需求、用户人设、已知事实和工作流本轮给出的真实选项作答。信息不足且会改变产品语义时可以要求真人决定。",
    advanceUntilTerminal
      ? "只输出一个 JSON 对象：{\"action\":\"reply\",\"answer\":\"\",\"reason\":\"\"}。allowed_answers 非空时，answer 必须逐字等于其中一项；为空时直接给出简短明确答复。"
      : "只输出一个 JSON 对象：{\"action\":\"reply|needs_human\",\"answer\":\"\",\"reason\":\"\"}。选择 reply 且 allowed_answers 非空时，answer 必须逐字等于其中一项。",
    `公开需求：${scenario.initial_prompt}`,
    `用户人设：${JSON.stringify(scenario.simulated_user?.persona ?? {})}`,
    `已知事实：${JSON.stringify(scenario.simulated_user?.known_facts ?? {})}`,
    `当前问题：${JSON.stringify(nextOutput.ask_user)}`,
  ].join("\n\n");
  const userArgs = [
    "exec", "--json", "--ephemeral", "--skip-git-repo-check", "--ignore-user-config", "--strict-config",
    "--sandbox", "read-only",
    "-m", scenario.simulated_user?.model ?? model,
    ...providerProfile.cli_args,
    "-c", `model_reasoning_effort=${tomlLiteral(scenario.simulated_user?.reasoning ?? reasoning)}`,
    "-c", "approval_policy=\"never\"",
    "--disable", "multi_agent",
    "-C", userWorkspace,
    "-",
  ];
  try {
    const result = await run(codex, userArgs, {
      phase: `simulated-user.turn-${turn}`,
      actor: "simulated_user",
      cwd: userWorkspace,
      env: userEnv,
      stdoutPath: userTracePath,
      stderrPath: userStderrPath,
      stdin: prompt,
      timeoutMs: 600_000,
    });
    if (result.code !== 0) throw new Error(`simulated user turn ${turn} exited ${result.code}: ${result.stderr.trim()}`);
    const raw = parseAgentMessageJson(userTracePath);
    const allowedAnswers = nextOutput.ask_user.allowed_answers ?? [];
    if (raw?.action === "needs_human") {
      if (advanceUntilTerminal) throw new Error(`simulated user turn ${turn} stopped although advance_until_terminal is enabled`);
      return { action: "needs_human", reason: String(raw.reason ?? "simulated user requires human input"), next_output: nextOutput, source: "ai_user", model_evidence: `evidence/user-turn-${turn}.jsonl` };
    }
    if (raw?.action !== "reply"
      || typeof raw.answer !== "string"
      || raw.answer.trim() === ""
      || allowedAnswers.length > 0 && !allowedAnswers.includes(raw.answer)) {
      throw new Error(`simulated user turn ${turn} returned an unauthorized answer`);
    }
    const workerPromptOriginal = raw.answer;
    return {
      action: "reply",
      answer: raw.answer,
      reason: String(raw.reason ?? ""),
      question: String(nextOutput.ask_user.question ?? ""),
      scope: String(nextOutput.ask_user.scope ?? ""),
      source: "ai_user",
      next_output: nextOutput,
      model_evidence: `evidence/user-turn-${turn}.jsonl`,
      worker_prompt_original: workerPromptOriginal,
      worker_prompt: evalWorkerPrompt(workerPromptOriginal),
    };
  } finally {
    rmSync(userWorkspace, { recursive: true, force: true });
    rmSync(userAuth.home, { recursive: true, force: true });
    rmSync(userAuth.codexHome, { recursive: true, force: true });
  }
}

function traceCompletedFileChanges(tracePath) {
  if (!existsSync(tracePath)) return [];
  const changes = [];
  for (const line of readFileSync(tracePath, "utf8").split("\n").filter(Boolean)) {
    try {
      const event = JSON.parse(line);
      if (event?.type === "item.completed" && event.item?.type === "file_change" && event.item.status === "completed") {
        for (const change of event.item.changes ?? []) changes.push(change);
      }
    } catch {}
  }
  return changes;
}

function independentAgentAudit(events) {
  const completedCalls = events.flatMap(event => {
    const item = event?.item;
    return event?.type === "item.completed" && item?.type === "collab_tool_call" && item.status === "completed" ? [item] : [];
  });
  const spawnCalls = completedCalls.filter(item => /spawn|delegate/i.test(String(item.tool ?? "")));
  const receiverIds = [...new Set(spawnCalls.flatMap(item => Array.isArray(item.receiver_thread_ids) ? item.receiver_thread_ids : []).filter(id => typeof id === "string" && id !== ""))];
  return {
    ok: receiverIds.length > 0,
    spawn_call_count: spawnCalls.length,
    receiver_thread_ids: receiverIds,
    empty_wait_count: completedCalls.filter(item => item.tool === "wait" && (!Array.isArray(item.receiver_thread_ids) || item.receiver_thread_ids.length === 0)).length,
  };
}

function traceCompletedCommand(tracePath, expectedCommand) {
  if (!existsSync(tracePath)) return null;
  for (const line of readFileSync(tracePath, "utf8").split("\n").filter(Boolean)) {
    try {
      const event = JSON.parse(line);
      for (const item of commandObjects(event)) {
        const raw = Array.isArray(item.argv) ? item.argv.join(" ") : String(item.command ?? "");
        if (item.status === "completed" && item.exit_code === 0 && unwrapCommandForPolicy(raw).trim() === expectedCommand) return item;
      }
    } catch {}
  }
  return null;
}

function superspecInvocationAudit(events, executableIdentities = [], bareResolutionProven = false) {
  const violations = [];
  for (const event of events) {
    for (const item of commandObjects(event)) {
      const raw = Array.isArray(item.argv) ? item.argv.join(" ") : String(item.command ?? "");
      if (Array.isArray(item.argv)) {
        const argv = item.argv;
        if (typeof argv[0] === "string" && executableAllowed(argv[0], executableIdentities, bareResolutionProven)) {
          violations.push({ command: raw, executable: argv[0] });
          continue;
        }
        if (typeof argv[1] === "string" && executableAllowed(argv[1], executableIdentities, false)) {
          violations.push({ command: raw, executable: argv[1] });
        }
        continue;
      }
      const command = unwrapCommandForPolicy(raw);
      for (const segment of command.split(/&&|\|\||;|\|/)) {
        const match = segment.trim().match(/^(?:env(?:\s+[A-Za-z_][A-Za-z0-9_]*=[^\s]+)*\s+)?(?:command\s+)?([^\s]+)(?:\s+([^\s]+))?/);
        if (!match) continue;
        const executable = match[1].replace(/^['"]|['"]$/g, "");
        const firstArg = match[2]?.replace(/^['"]|['"]$/g, "");
        if (executableAllowed(executable, executableIdentities, bareResolutionProven)
          || (firstArg && executableAllowed(firstArg, executableIdentities, false))) {
          violations.push({ command: raw, executable: executableAllowed(executable, executableIdentities, bareResolutionProven) ? executable : firstArg });
        }
      }
    }
  }
  return { ok: violations.length === 0, violations };
}

function negativeVerificationEvidence(tracePath, scenario) {
  const required = scenario.assertions.required_verification_commands ?? [];
  const completedProof = expectedCommand => {
    if (!existsSync(tracePath)) return null;
    for (const line of readFileSync(tracePath, "utf8").split("\n").filter(Boolean)) {
      try {
        const event = JSON.parse(line);
        for (const item of commandObjects(event)) {
          if (item.status !== "completed" || item.exit_code !== 0) continue;
          const raw = Array.isArray(item.argv) ? item.argv.join(" ") : String(item.command ?? "");
          const command = unwrapCommandForPolicy(raw).trim();
          if (command === expectedCommand) return { item, proof: "exact" };
          if (/[;|<>\n\r]/.test(command)) continue;
          const segments = command.split(/\s*&&\s*/);
          const changesDirectory = segments.some(segment => /^(?:cd|pushd|popd)(?:\s|$)/.test(segment));
          if (segments.length > 1 && segments.every(Boolean) && !changesDirectory && segments.includes(expectedCommand)) {
            return { item, proof: "successful_and_chain" };
          }
        }
      } catch {}
    }
    return null;
  };
  const matched = required.map(command => ({ command, result: completedProof(command) }));
  return {
    ok: matched.every(entry => entry.result != null),
    matched: matched.map(entry => ({ command: entry.command, completed: entry.result != null, proof: entry.result?.proof ?? null })),
  };
}

function negativeActivationState(changes, invocationAudit) {
  const stateChanges = changes.filter(change =>
    change.path === ".superspec/changes"
    || change.path.startsWith(".superspec/changes/")
    || change.path === "openspec/changes"
    || change.path.startsWith("openspec/changes/")
  );
  return {
    ok: invocationAudit.ok && stateChanges.length === 0,
    invocation_violations: invocationAudit.violations,
    state_changes: stateChanges.map(change => change.path),
  };
}

function pathWithin(candidate, root) {
  return candidate === root || candidate.startsWith(`${root}${sep}`);
}

function normalizedAuditPath(candidate) {
  const normalized = resolve(candidate);
  return safeRealpath(normalized) ?? normalized;
}

function hasShellControlSyntax(command) {
  let quote = null;
  let escaped = false;
  for (let index = 0; index < command.length; index++) {
    const char = command[index];
    if (escaped) { escaped = false; continue; }
    if (quote === '"' && char === "\\") { escaped = true; continue; }
    if (char === "'" || char === '"') { quote = quote === char ? null : quote ?? char; continue; }
    if (quote != null) continue;
    if (";&|<>`\r\n".includes(char) || char === "$" && command[index + 1] === "(") return true;
  }
  return false;
}

function isLeadingSearchPattern(command, candidate) {
  const escaped = candidate.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(
    `(?:^|[|;&]\\s*)(?:(?:[^\\s'\"]*\\/)?(?:rg|grep))\\s+(?:-[^\\s]+\\s+)*(['\"])${escaped}\\/?\\1(?:\\s|$)`,
  ).test(command);
}

function isSafeSuperspecStdinPayload(command, candidate) {
  const match = /^printf\s+'%s'\s+'(\{.*\}|\[.*\])'\s*\|\s*(?:(?:[^\s'"]*\/)?superspec)\s+record\s+(?:user-decision|job-submit|test-run)\b[^;&<>`]*\s-$/.exec(command.trim());
  if (!match || match[1].includes("'") || !match[1].includes(candidate)) return false;
  try { JSON.parse(match[1]); return true; } catch { return false; }
}

function stripSafeSuperspecJsonPayloads(command) {
  return command.replace(
    /printf\s+'%s(?:\\n)?'\s+'(\{[^']*\}|\[[^']*\])'\s*\|\s*(?:(?:[^\s'"]*\/)?superspec)\s+record\s+(?:user-decision|job-submit|test-run)\b/g,
    (match, payload) => {
      try {
        JSON.parse(payload);
        return match.replace(payload, "{}");
      } catch {
        return match;
      }
    },
  );
}

function isAwkRegexLiteral(command, candidate) {
  if (!/^(?:(?:[^\s'"]*\/)?awk)\s/.test(command.trim())) return false;
  const quotedProgram = /awk\s+(?:-[^\s]+\s+)*(['"])(.*?)\1/.exec(command);
  if (!quotedProgram || /\b(?:getline|system)\b|[<>]/.test(quotedProgram[2])) return false;
  return [...quotedProgram[2].matchAll(/\/((?:\\.|[^/])*)\//g)].some(match => match[0].includes(candidate));
}

function traceEnvironmentAudit(events, {
  workspace,
  packageRoot,
  binRoot,
  controlledHome,
  controlledCodexHome,
  controlledZdotdir,
  sensitiveEnvKeys = [],
}) {
  const violations = [];
  const allowedRoots = [workspace, packageRoot, binRoot].map(normalizedAuditPath);
  const restrictedRoots = [controlledHome, controlledCodexHome, controlledZdotdir].map(normalizedAuditPath);
  const systemRoots = ["/usr/bin", "/bin", "/usr/sbin", "/sbin"].map(normalizedAuditPath);
  const sensitiveNames = [...new Set(["CODEX_HOME", "ZDOTDIR", "OPENAI_API_KEY", ...sensitiveEnvKeys])];
  for (const event of events) {
    for (const item of commandObjects(event)) {
      const raw = Array.isArray(item.argv) ? item.argv.join(" ") : String(item.command ?? "");
      if (/\bnpm\s+root(?:\s+-g)?\b/.test(raw) || raw.includes("/lib/node_modules/")) {
        violations.push({ reason: "global_package_lookup", command: raw });
      }
      const unwrapped = unwrapCommandForPolicy(raw);
      const sourceTextSearch = !hasShellControlSyntax(unwrapped) && !/--pre(?:=|\s)/.test(unwrapped)
        && /^(?:(?:[^\s'"]*\/)?(?:rg|grep)|git\s+grep)(?:\s|$)/.test(unwrapped.trim());
      const expandsSensitiveEnvironment = sensitiveNames.some(name =>
        raw.includes(`$${name}`) || raw.includes(`\${${name}}`)
      );
      const referencesSensitiveEnvironment = expandsSensitiveEnvironment || !sourceTextSearch && sensitiveNames.some(name =>
        new RegExp(`\\b${name}\\b`).test(raw)
      );
      const inspectsEnvironment = /(?:^|[\s/])(?:env|printenv)(?:\s|$)/.test(raw)
        || !sourceTextSearch && /process\.env|os\.environ|System\.getenv|getenv\s*\(/.test(raw);
      if (referencesSensitiveEnvironment || inspectsEnvironment || /(?:^|[\s'"=(])~(?:\/|\s|$)/.test(raw)) {
        violations.push({ reason: "controlled_home_reference", command: raw });
      }
      const auditRaw = stripSafeSuperspecJsonPayloads(unwrapped);
      const absolutePaths = [...auditRaw.matchAll(/(?:^|[\s'"=(])((?:\/[A-Za-z0-9._@+,=:\-]+){2,})/g)].map(match => match[1]);
      for (const candidate of absolutePaths) {
        const cleaned = candidate.replace(/[),;]+$/, "");
        if (isLeadingSearchPattern(unwrapped, cleaned)
          || isSafeSuperspecStdinPayload(unwrapped, cleaned)
          || isAwkRegexLiteral(unwrapped, cleaned)) continue;
        const normalized = normalizedAuditPath(cleaned);
        if (restrictedRoots.some(root => pathWithin(normalized, root))) {
          violations.push({ reason: "controlled_home_path", path: cleaned, normalized_path: normalized, command: raw });
          continue;
        }
        const allowed = allowedRoots.some(root => pathWithin(normalized, root))
          || systemRoots.some(root => pathWithin(normalized, root))
          || normalized === "/dev/null";
        if (!allowed) violations.push({ reason: "absolute_path_outside_allowlist", path: cleaned, normalized_path: normalized, command: raw });
      }
      if (/(?:^|\s)\.\.(?:\/|\s|$)/.test(raw) || /(?:scenario\.json|manifest\.json|capability\.json|director-actions|turn-1\.jsonl)/.test(raw)) {
        violations.push({ reason: "relative_harness_traversal", command: raw });
      }
    }
  }
  return { ok: violations.length === 0, violations };
}

function unwrapCommandForPolicy(raw) {
  const single = raw.match(/^\/bin\/zsh\s+-lc\s+'([^']*)'$/s);
  if (single) return single[1];
  const double = raw.match(/^\/bin\/zsh\s+-lc\s+"((?:[^"\\]|\\.)*)"$/s);
  if (double) return double[1].replace(/\\(["\\])/g, "$1");
  const unquoted = raw.match(/^\/bin\/(?:zsh|sh)\s+-lc\s+([A-Za-z0-9._\/-]+)$/);
  if (unquoted) return unquoted[1];
  return raw;
}

function workerCommandPolicyAudit(events, assertions, executableIdentities = [], bareResolutionProven = false) {
  const violations = [];
  const enabled = new Set((assertions.forbidden_worker_commands ?? []).map(rule => rule.family));
  const transitionRule = (assertions.forbidden_worker_commands ?? []).find(rule => rule.family === "superspec_transition_except");
  for (const event of events) {
    for (const item of commandObjects(event)) {
      const raw = Array.isArray(item.argv) ? item.argv.join(" ") : String(item.command ?? "");
      const command = unwrapCommandForPolicy(raw);
      const matches = command.matchAll(/(?:^|\s)([^\s'";&|<>]+)\s+(record|transition)\s+([^\s'";&|<>]+)/g);
      for (const match of matches) {
        const executable = match[1];
        if (!executableAllowed(executable, executableIdentities, bareResolutionProven)) continue;
        const family = match[2];
        const subcommand = match[3];
        if (enabled.has("superspec_record_user_decision") && family === "record" && subcommand === "user-decision") {
          violations.push({ family: "superspec_record_user_decision", executable, command: raw });
        }
        if (transitionRule && family === "transition" && !transitionRule.allowed_subcommands.includes(subcommand)) {
          violations.push({ family: "superspec_transition_except", executable, subcommand, command: raw });
        }
      }
    }
  }
  return { ok: violations.length === 0, violations };
}

function validateAuditOverlay(originalScenario, currentScenario) {
  const errors = [];
  const originalPrompt = originalScenario.initial_prompt;
  const currentPrompt = currentScenario.initial_prompt;
  if (typeof originalPrompt !== "string" || typeof currentPrompt !== "string") {
    errors.push("scenario prompts must be strings");
  } else if (currentPrompt !== originalPrompt) {
    errors.push("current prompt differs from the frozen real-user prompt");
  }

  const originalRules = originalScenario.assertions?.forbidden_worker_commands ?? [];
  const currentRules = currentScenario.assertions?.forbidden_worker_commands ?? [];
  const rulesChanged = JSON.stringify(currentRules) !== JSON.stringify(originalRules);
  if (rulesChanged && JSON.stringify(currentRules) !== JSON.stringify(AUDIT_FORBIDDEN_WORKER_COMMANDS)) {
    errors.push("changed forbidden_worker_commands are not the approved audit-only rules");
  }

  const baseline = structuredClone(originalScenario);
  const overlay = structuredClone(currentScenario);
  overlay.initial_prompt = baseline.initial_prompt;
  if (baseline.assertions) delete baseline.assertions.forbidden_worker_commands;
  if (overlay.assertions) delete overlay.assertions.forbidden_worker_commands;
  if (JSON.stringify(overlay) !== JSON.stringify(baseline)) {
    errors.push("current scenario changes non-audit baseline fields");
  }
  return { ok: errors.length === 0, errors, promptChanged: currentPrompt !== originalPrompt, assertions: currentScenario.assertions };
}

function sameArgv(actual, expected, executableIdentities = [], bareResolutionProven = false) {
  if (!Array.isArray(actual) || !Array.isArray(expected)) return false;
  if (actual.length !== expected.length) return false;
  return actual.every((value, index) => {
    if (index === 0) return expected[index] === "superspec" && executableAllowed(value, executableIdentities, bareResolutionProven);
    return value === expected[index];
  });
}

function requiredSequence(direct, required, executableIdentities = [], bareResolutionProven = false) {
  if (!Array.isArray(required) || required.length === 0) return { ok: true, matched: [], cursor: 0 };
  let cursor = 0;
  const matched = [];
  for (const command of direct) {
    if (command.executable_allowed !== false && sameArgv(command.argv, required[cursor], executableIdentities, bareResolutionProven)) {
      matched.push(command);
      cursor++;
      if (cursor === required.length) break;
    }
  }
  return { ok: cursor === required.length, matched, cursor };
}

function matchesRequired(command, required, executableIdentities = [], bareResolutionProven = false) {
  return Array.isArray(command.argv) && command.executable_allowed !== false
    && required.some(expected => sameArgv(command.argv, expected, executableIdentities, bareResolutionProven));
}

function classifyAuthenticity(trace, required, workerCode, executableIdentities = [], bareResolutionProven = false, injection = null) {
  if (!Array.isArray(required) || required.length === 0) {
    if (workerCode !== 0) return { status: "unavailable", detail: `Worker exited ${workerCode}`, sequence: { ok: false } };
    if (trace.malformed > 0 || !trace.commandSchemaRecognized) {
      return { status: "unavailable", detail: "command event schema is not safely recognizable", sequence: { ok: false } };
    }
    const directBoundary = observedWorkflowBoundary(trace);
    if (directBoundary) {
      return { status: "pass", detail: "directly observed public SuperSpec workflow boundary", sequence: { ok: true } };
    }
    const correlatedWrapper = trace.commands.find(command => {
      if (command.kind !== "shell_wrapper" || command.status !== "completed" || command.exitCode !== 0) return false;
      const unwrapped = unwrapCommandForPolicy(command.raw);
      return [...unwrapped.matchAll(/(?:^|&&|\n|\|)\s*([^\s'";&|<>]+)\s+(?:status|jobs|record|transition)\b/g)]
        .some(match => executableAllowed(match[1], executableIdentities, bareResolutionProven));
    });
    return correlatedWrapper
      ? { status: "pass", detail: "completed Worker shell command contains a public SuperSpec invocation", sequence: { ok: true } }
      : { status: "unavailable", detail: "no completed public SuperSpec invocation was observable in this scripted turn", sequence: { ok: false } };
  }
  const sequence = requiredSequence(trace.direct, required, executableIdentities, bareResolutionProven);
  if (workerCode !== 0) {
    return { status: "unavailable", detail: "Worker did not start successfully", sequence };
  }
  if (trace.malformed > 0 || !trace.commandSchemaRecognized) {
    return { status: "unavailable", detail: "command event schema is not safely recognizable", sequence };
  }

  if (injection === "hide-required-command") {
    return { status: "unavailable", detail: "required direct evidence was intentionally hidden by director injection", sequence };
  }
  if (sequence.ok) {
    return { status: "pass", detail: "required completed command sequence has direct exit/cwd evidence", sequence };
  }
  const relevant = trace.commands.filter(command => matchesRequired(command, required, executableIdentities, bareResolutionProven));
  const unjudgeable = trace.commands.some(command =>
    [
      "missing_status", "non_completed", "missing_exit_code", "missing_cwd",
      "unknown", "unsafe_string", "shell_wrapper",
    ].includes(command.kind)
  );
  if (unjudgeable) {
    return { status: "unavailable", detail: "required direct command fields or safe argv are unavailable", sequence };
  }
  const explicitFailure = relevant.find(command => ["failed", "wrong_cwd"].includes(command.kind));
  if (explicitFailure) {
    return { status: "fail", detail: `required command evidence is ${explicitFailure.kind}`, sequence };
  }
  return {
    status: "fail",
    detail: `observable Worker trace proved only ${sequence.cursor}/${required.length} required commands in order`,
    sequence,
  };
}

function parseLastJson(text) {
  const trimmed = String(text ?? "").trim();
  if (!trimmed) return null;
  try { return JSON.parse(trimmed); } catch {}

  let last = null;
  let start = -1;
  let depth = 0;
  let quote = false;
  let escaped = false;
  for (let index = 0; index < trimmed.length; index++) {
    const char = trimmed[index];
    if (start < 0) {
      if (char === "{" || char === "[") {
        start = index;
        depth = 1;
        quote = false;
        escaped = false;
      }
      continue;
    }
    if (quote) {
      if (escaped) escaped = false;
      else if (char === "\\") escaped = true;
      else if (char === '"') quote = false;
      continue;
    }
    if (char === '"') {
      quote = true;
      continue;
    }
    if (char === "{" || char === "[") depth++;
    else if (char === "}" || char === "]") depth--;
    if (depth !== 0) continue;
    try { last = JSON.parse(trimmed.slice(start, index + 1)); } catch {}
    start = -1;
  }
  return last;
}

function directStatusResult(trace, expectedArgv, executableIdentities, bareResolutionProven) {
  const command = [...trace.direct].reverse().find(item =>
    sameArgv(item.argv, expectedArgv, executableIdentities, bareResolutionProven)
  );
  const parsed = command ? parseLastJson(command.output) : null;
  return {
    commandFound: Boolean(command),
    parsed: parsed != null,
    state: typeof parsed?.state === "string" ? parsed.state : null,
  };
}

function resumeStatusContinuity(turn1Trace, turn2Trace, scenario, executableIdentities, bareResolutionProven) {
  const turn1 = directStatusResult(
    turn1Trace,
    scenario.assertions.turn_1_required_worker_commands.at(-1),
    executableIdentities,
    bareResolutionProven,
  );
  const turn2 = directStatusResult(
    turn2Trace,
    scenario.assertions.turn_2_required_worker_commands.at(-1),
    executableIdentities,
    bareResolutionProven,
  );
  const expected = scenario.stop.snapshot_state;
  if (!turn1.parsed || !turn2.parsed || turn1.state == null || turn2.state == null) {
    return {
      status: "unavailable",
      detail: `direct status output unavailable or unparseable: turn-1=${turn1.state ?? "unavailable"}, turn-2=${turn2.state ?? "unavailable"}`,
      turn1,
      turn2,
    };
  }
  if (turn1.state !== expected || turn2.state !== expected) {
    return {
      status: "fail",
      detail: `expected both direct status outputs to report ${expected}, got ${turn1.state}/${turn2.state}`,
      turn1,
      turn2,
    };
  }
  return {
    status: "pass",
    detail: `both direct status outputs report ${expected}`,
    turn1,
    turn2,
  };
}

function pathAllowed(path, allowed) {
  return allowed.some(pattern => pattern.endsWith("/**")
    ? path === pattern.slice(0, -3) || path.startsWith(pattern.slice(0, -2))
    : path === pattern);
}

function inventoryChangeAllowed(change, allowed) {
  if (pathAllowed(change.path, allowed)) return true;
  const type = change.after?.type ?? change.before?.type;
  if (type !== "directory") return false;
  return allowed.some(pattern => {
    const target = pattern.endsWith("/**") ? pattern.slice(0, -3) : pattern;
    return target.startsWith(`${change.path}/`);
  });
}

function requiredFileContentErrors(root, assertions) {
  return Object.entries(assertions.required_file_contains ?? {}).flatMap(([relativePath, requiredFragments]) => {
    if (!Array.isArray(requiredFragments) || requiredFragments.some(fragment => typeof fragment !== "string")) {
      return [`${relativePath}: invalid required_file_contains contract`];
    }
    const absolute = join(root, relativePath);
    const check = safeRegularWithin(absolute, root);
    if (!check.ok) return [`${relativePath}: unavailable for content validation`];
    const content = readFileSync(absolute, "utf8");
    return requiredFragments.filter(fragment => {
      if (content.includes(fragment)) return false;
      if (!fragment.includes("<format>")) return true;
      const formats = requiredFragments
        .filter(candidate => /^[A-Za-z0-9]+$/.test(candidate) && content.toLowerCase().includes(candidate.toLowerCase()))
        .map(candidate => candidate.toLowerCase());
      return formats.length === 0 || !formats.every(format => content.includes(fragment.replaceAll("<format>", format)));
    }).map(fragment => `${relativePath}: missing ${JSON.stringify(fragment)}`);
  });
}

function readEvents(path) {
  if (!existsSync(path)) return { records: [], malformed: 0, present: false };
  const records = [];
  let malformed = 0;
  for (const line of readFileSync(path, "utf8").split("\n")) {
    if (!line.trim()) continue;
    try { records.push(JSON.parse(line)); } catch { malformed++; }
  }
  return { records, malformed, present: true };
}

function eventBase(event) {
  const {
    event_id: _eventId,
    event_digest: _eventDigest,
    ...base
  } = event;
  return base;
}

function digestOfExact(value) {
  const keys = Object.keys(value).sort();
  return sha256(JSON.stringify(value, keys));
}

function eventsDigestExact(events) {
  return sha256(events.map(event => event.event_digest).join("\n"));
}

function replayState(events) {
  let state = "init";
  for (const event of events) {
    if (event.event_type === "transition_commit" && typeof event.payload?.to_state === "string") state = event.payload.to_state;
  }
  return state;
}

function eventIntegrity(events, snapshot, expectedState) {
  if (!events.present || snapshot == null) return { status: "unavailable", detail: "events or snapshot unavailable" };
  if (events.malformed > 0) return { status: "unavailable", detail: "events.jsonl contains malformed records" };
  if (typeof snapshot.events_digest !== "string") return { status: "unavailable", detail: "snapshot events_digest unavailable" };
  if (events.records.some(event => typeof event.event_digest !== "string")) return { status: "unavailable", detail: "event digest field unavailable" };
  for (const event of events.records) {
    if (digestOfExact(eventBase(event)) !== event.event_digest) return { status: "unavailable", detail: `event payload digest mismatch: ${event.event_id ?? "unknown"}` };
  }
  let prefixLength = -1;
  for (let length = 0; length <= events.records.length; length++) {
    if (eventsDigestExact(events.records.slice(0, length)) === snapshot.events_digest) prefixLength = length;
  }
  if (prefixLength < 0) return { status: "unavailable", detail: "snapshot events_digest does not match any valid event prefix" };
  const prefixState = replayState(events.records.slice(0, prefixLength));
  if (snapshot.state !== prefixState) return { status: "unavailable", detail: `snapshot state ${snapshot.state} disagrees with prefix state ${prefixState}` };
  const derivedState = replayState(events.records);
  const expectedStates = Array.isArray(expectedState) ? expectedState : [expectedState];
  if (!expectedStates.includes(derivedState)) return { status: "fail", detail: `expected state ${expectedStates.join(" or ")}, got ${derivedState}`, derivedState, staleSnapshot: prefixLength < events.records.length };
  return {
    status: "pass",
    detail: prefixLength < events.records.length
      ? `full events state is ${derivedState}; snapshot is a valid stale prefix (${prefixLength}/${events.records.length})`
      : `snapshot and full events agree on state ${derivedState}`,
    derivedState,
    staleSnapshot: prefixLength < events.records.length,
    snapshotPrefixLength: prefixLength,
  };
}

function applyDecisionStopFacts(events, agentMessages) {
  const startedTasks = events.records
    .filter(event => event.event_type === "task_started")
    .map(event => event.payload?.task_id)
    .filter(taskId => typeof taskId === "string");
  const completedTasks = events.records
    .filter(event => event.event_type === "task_completed")
    .map(event => event.payload?.task_id)
    .filter(taskId => typeof taskId === "string");
  const reopenedFromApply = events.records.some(event => event.event_type === "transition_commit"
    && event.payload?.transition === "reopen"
    && event.payload?.from_state === "apply"
    && ["propose", "explore"].includes(event.payload?.to_state));
  const askedForDecision = agentMessages.some(message => /请确认|请选择|需要你确认|需要用户确认/.test(message));
  return { startedTasks, completedTasks, reopenedFromApply, askedForDecision };
}

function applyDecisionStoppedCorrectly(integrity, facts) {
  return integrity?.status === "pass"
    && facts.startedTasks.length <= 1
    && facts.completedTasks.length === 0
    && facts.reopenedFromApply
    && facts.askedForDecision;
}

function repairRoutingFacts(events, stop) {
  const reopens = events.records.filter(event => event.event_type === "transition_commit"
    && event.payload?.transition === "reopen");
  const latest = reopens.at(-1)?.payload ?? null;
  const forbiddenTargets = Array.isArray(stop.forbidden_reopen_targets) ? stop.forbidden_reopen_targets : [];
  const allowedFrom = Array.isArray(stop.allowed_reopen_from)
    ? stop.allowed_reopen_from
    : stop.required_reopen_from == null ? [] : [stop.required_reopen_from];
  return {
    reopen_count: reopens.length,
    latest_from: latest?.from_state ?? null,
    latest_target: latest?.reopen_target ?? latest?.to_state ?? null,
    allowed_from: allowedFrom,
    required_target: stop.required_reopen_target ?? null,
    forbidden_targets_seen: reopens
      .map(event => event.payload?.reopen_target ?? event.payload?.to_state)
      .filter(target => forbiddenTargets.includes(target)),
  };
}

function repairRoutingStoppedCorrectly(integrity, facts) {
  return integrity?.status === "pass"
    && facts.reopen_count > 0
    && (facts.allowed_from.length === 0 || facts.allowed_from.includes(facts.latest_from))
    && (facts.required_target == null || facts.latest_target === facts.required_target)
    && facts.forbidden_targets_seen.length === 0;
}

function secureEvidenceForWorker(evidenceDir, paths) {
  for (const path of paths) {
    if (existsSync(path)) chmodSync(path, 0o200);
  }
  chmodSync(evidenceDir, 0o300);
}

function restoreEvidenceAfterWorker(evidenceDir, paths) {
  chmodSync(evidenceDir, 0o700);
  for (const path of paths) if (existsSync(path)) chmodSync(path, 0o600);
}

function parseFeatureList(output) {
  const features = new Map();
  for (const line of output.split("\n")) {
    const match = /^([A-Za-z0-9_]+)\s+(stable|experimental|deprecated|removed|under development)\s+(true|false)\s*$/.exec(line.trim());
    if (match && match[2] !== "removed") features.set(match[1], { stage: match[2], enabled: match[3] === "true" });
  }
  return features;
}

function normalizeUnsupportedProjectFeatures(configPath, supported, run) {
  const original = readFileSync(configPath, "utf8");
  const removed = [];
  const normalized = original.split("\n").filter(line => {
    const match = /^\s*([A-Za-z0-9_]+)\s*=/.exec(line);
    if (match && !supported.has(match[1]) && match[1] === "child_agents_md") {
      removed.push(line);
      return false;
    }
    return true;
  }).join("\n");
  if (normalized !== original) {
    writeFileSync(configPath, normalized);
    run.recordMutation("setup.config.normalize-unsupported-features", configPath, { removed });
  }
  return {
    original_digest: sha256(original),
    normalized_digest: sha256(normalized),
    removed,
  };
}

function directorSafe(actionLog, workerStartedAt, superspecIdentities) {
  if (!existsSync(actionLog)) return { ok: false, offending: [], unavailable: true };
  const actions = readFileSync(actionLog, "utf8").split("\n").filter(Boolean).map(JSON.parse)
    .filter(entry => entry.event === "started" && entry.started_at >= workerStartedAt && entry.action_kind === "subprocess");
  const offending = actions.filter(action => {
    const identity = action.executable_realpath ?? safeRealpath(action.executable);
    let args = action.argv.slice(1);
    const directSuperspec = superspecIdentities.includes(identity);
    const nodeLaunchedSuperspec = args.length > 0 && superspecIdentities.includes(safeRealpath(args[0]));
    if (!directSuperspec && !nodeLaunchedSuperspec) return false;
    if (nodeLaunchedSuperspec) args = args.slice(1);
    return args[0] === "transition" || args[0] === "record";
  });
  return { ok: offending.length === 0, offending, unavailable: false };
}

function normalizeEvidencePaths(capability, runRoot) {
  const markerRoot = join(runRoot, "evidence", "absent");
  for (const [gateName, value] of Object.entries(capability.gates)) {
    value.evidence = value.evidence.map(evidencePath => {
      const absolute = join(runRoot, evidencePath);
      if (existsSync(absolute)) return evidencePath;
      const markerName = `${gateName}-${evidencePath.replace(/[^A-Za-z0-9._-]+/g, "_")}.json`;
      const markerPath = join(markerRoot, markerName);
      writeJson(markerPath, {
        schema_version: 1,
        evidence_status: "absent",
        requested_path: evidencePath,
        gate: gateName,
        gate_status: value.status,
        reason: value.detail ?? "evidence was not produced",
      });
      return posix(relative(runRoot, markerPath));
    });
  }
}

async function validateFaultMappings() {
  const outcomes = [];
  const make = statuses => {
    const cap = emptyCapability("synthetic");
    for (const [name, status] of Object.entries(statuses)) cap.gates[name] = gate(status, ["synthetic"]);
    for (const name of CORE_GATES) if (!(name in statuses)) cap.gates[name] = gate("pass", ["synthetic"]);
    return finalizeCapability(cap);
  };
  const cases = [
    ["all-pass", {}, ["PASS", "GO", 0]],
    ["direct-command-unavailable", { authenticity: "unavailable" }, ["INVALID", "NO_GO", 3]],
    ["discovery-missing", { artifact: "fail" }, ["FAIL", "NO_GO", 1]],
    ["scope-violation", { scope: "fail" }, ["FAIL", "NO_GO", 1]],
    ["fixture-invalid", { controlled_environment: "unavailable" }, ["INVALID", "NO_GO", 3]],
  ];
  for (const [name, statuses, expected] of cases) {
    const actual = make(statuses);
    const got = [actual.scenario_result, actual.capability_verdict, actual.exit_code];
    if (JSON.stringify(got) !== JSON.stringify(expected)) throw new Error(`${name}: expected ${expected}, got ${got}`);
    outcomes.push({ name, result: got });
  }
  const limitedPass = make({});
  limitedPass.limitations.push("historical audit-only prompt difference");
  finalizeCapability(limitedPass);
  if (limitedPass.scenario_result !== "PASS" || limitedPass.capability_verdict !== "GO_WITH_LIMITATIONS" || limitedPass.exit_code !== 2) {
    throw new Error("offline regrade limitation must cap an otherwise clean result at GO_WITH_LIMITATIONS/2");
  }
  outcomes.push({ name: "regrade-prompt-difference-caps-go", result: [limitedPass.capability_verdict, limitedPass.exit_code] });

  const workspace = "/tmp/workspace";
  const future = commandObjects({ type: "future.event", payload: { retained: true } });
  if (future.length !== 0) throw new Error("unknown event compatibility failed");
  const wrapper = exactCommand({ status: "completed", exit_code: 0, command: "/bin/zsh -lc 'superspec transition next --change x'" }, workspace, [], true);
  if (wrapper.kind !== "direct" || wrapper.cwd_source !== "controlled_worker_launch") throw new Error("bounded canonical shell wrapper must count as direct evidence");
  const doubleWrapper = exactCommand({ status: "completed", exit_code: 0, command: "/bin/zsh -lc \"superspec transition next --change \\\"x\\\"\"" }, workspace, [], true);
  if (doubleWrapper.kind !== "direct") throw new Error("bounded double-quoted shell wrapper must count as direct evidence");
  const taskWrapper = exactCommand({ status: "completed", exit_code: 0, command: "/bin/zsh -lc 'superspec transition task-start --change x --task 1.1'" }, workspace, [], true);
  if (taskWrapper.kind !== "direct" || !sameArgv(taskWrapper.argv, ["superspec", "transition", "task-start", "--change", "x", "--task", "1.1"], [], true)) {
    throw new Error("bounded task transition shell wrapper must count as direct evidence");
  }
  const chainedWrapper = exactCommand({ status: "completed", exit_code: 0, command: "/bin/zsh -lc 'superspec transition next --change x && git status'" }, workspace);
  if (chainedWrapper.kind !== "shell_wrapper") throw new Error("chained shell wrapper must be rejected");
  if (canonicalSuperspecArgv("superspec transition next --change 'x;rm'") !== null) throw new Error("unsafe quoted change must be rejected");
  outcomes.push({ name: "bounded-shell-wrapper-only", result: true });
  const allowedDirectory = inventoryChangeAllowed(
    { path: "openspec/changes/x/.superspec", before: null, after: { type: "directory" } },
    ["openspec/changes/x/.superspec/artifacts/discovery.md"],
  );
  if (!allowedDirectory) throw new Error("required artifact parent directories must be in scope");
  const allowedWildcardParent = inventoryChangeAllowed(
    { path: ".superspec/changes", before: { type: "directory" }, after: { type: "directory" } },
    [".superspec/changes/x/**"],
  );
  if (!allowedWildcardParent) throw new Error("wildcard state parent directory must be in scope");
  outcomes.push({ name: "artifact-parent-directory-allowed", result: true });

  const required = [
    ["superspec", "transition", "next", "--change", "x"],
    ["superspec", "transition", "explore", "--change", "x"],
    ["superspec", "transition", "next", "--change", "x"],
  ];
  const observableMissing = classifyAuthenticity({
    direct: [{ kind: "direct", argv: required[0] }],
    commands: [{ kind: "direct", argv: required[0] }],
    malformed: 0,
    commandSchemaRecognized: true,
  }, required, 0, [], true);
  if (observableMissing.status !== "fail") throw new Error("observable missing command must be FAIL");
  outcomes.push({ name: "observable-command-omission-fails", result: observableMissing.status });
  const missingCwd = classifyAuthenticity({
    direct: [],
    commands: [{ kind: "missing_cwd", argv: required[0] }],
    malformed: 0,
    commandSchemaRecognized: true,
  }, required, 0, [], true);
  if (missingCwd.status !== "unavailable") throw new Error("missing direct cwd must be INVALID/unavailable");
  outcomes.push({ name: "missing-direct-field-invalid", result: missingCwd.status });
  for (const kind of ["failed", "wrong_cwd"]) {
    const explicitBehaviorFailure = classifyAuthenticity({
      direct: [],
      commands: [{ kind, argv: required[0] }],
      malformed: 0,
      commandSchemaRecognized: true,
    }, required, 0, [], true);
    if (explicitBehaviorFailure.status !== "fail") throw new Error(`${kind} required command must be FAIL`);
    outcomes.push({ name: `${kind}-required-command-fails`, result: explicitBehaviorFailure.status });
  }
  const wrongOrder = classifyAuthenticity({
    direct: [
      { kind: "direct", argv: required[1] },
      { kind: "direct", argv: required[0] },
      { kind: "direct", argv: required[2] },
    ],
    commands: [],
    malformed: 0,
    commandSchemaRecognized: true,
  }, required, 0, [], true);
  if (wrongOrder.status !== "fail") throw new Error("wrong command order must be FAIL");
  outcomes.push({ name: "wrong-command-order-fails", result: wrongOrder.status });

  for (const [name, command] of [
    ["missing-status", { exit_code: 0, cwd: workspace, command: "superspec transition next --change x" }],
    ["missing-exit", { status: "completed", cwd: workspace, command: "superspec transition next --change x" }],
    ["non-completed", { status: "in_progress", exit_code: 0, cwd: workspace, command: "superspec transition next --change x" }],
  ]) {
    const parsed = exactCommand(command, workspace, [], true);
    const result = classifyAuthenticity({
      direct: [],
      commands: [parsed],
      malformed: 0,
      commandSchemaRecognized: true,
    }, required, 0, [], true);
    if (result.status !== "unavailable") throw new Error(`${name} must be INVALID/unavailable`);
    outcomes.push({ name: `${name}-invalid`, result: result.status });
  }
  const explicitNonzero = exactCommand({
    status: "completed",
    exit_code: 7,
    cwd: workspace,
    command: "superspec transition next --change x",
  }, workspace, [], true);
  const explicitNonzeroResult = classifyAuthenticity({
    direct: [],
    commands: [explicitNonzero],
    malformed: 0,
    commandSchemaRecognized: true,
  }, required, 0, [], true);
  if (explicitNonzeroResult.status !== "fail") throw new Error("explicit nonzero exit must be FAIL");
  outcomes.push({ name: "explicit-nonzero-exit-fails", result: explicitNonzeroResult.status });

  const nonlocal = exactCommand({
    status: "completed", exit_code: 0, cwd: workspace,
    argv: ["/opt/not-run-local/superspec", "transition", "next", "--change", "x"],
  }, workspace, ["/tmp/run/package/dist/cli.js"]);
  if (nonlocal.executable_allowed !== false) throw new Error("absolute nonlocal superspec must be rejected");
  outcomes.push({ name: "absolute-nonlocal-superspec-rejected", result: true });

  const fixtureRoot = mkdtempSync(join(tmpdir(), "superspec-probe-fixture-test-"));
  const contentRoot = join(fixtureRoot, "content");
  mkdirSync(join(contentRoot, "docs"), { recursive: true });
  writeFileSync(join(contentRoot, "docs", "export.md"), "CSV JSON ./output/report.csv ./output/report.json --output\n");
  const expandedPathErrors = requiredFileContentErrors(contentRoot, {
    required_file_contains: { "docs/export.md": ["CSV", "JSON", "./output/report.<format>", "--output"] },
  });
  if (expandedPathErrors.length !== 0) throw new Error(`expanded format paths should satisfy the placeholder contract: ${expandedPathErrors.join("; ")}`);
  outcomes.push({ name: "artifact-format-placeholder-expansion", result: true });
  const resumeTraceOne = join(fixtureRoot, "resume-turn-1.jsonl");
  const resumeTraceTwo = join(fixtureRoot, "resume-turn-2.jsonl");
  writeFileSync(resumeTraceOne, [
    JSON.stringify({ type: "thread.started", thread_id: "00000000-0000-0000-0000-000000000001" }),
    JSON.stringify({ type: "item.completed", item: { type: "command_execution", command: "/bin/zsh -lc 'pwd'", aggregated_output: "/tmp/workspace\n", exit_code: 0, status: "completed" } }),
    JSON.stringify({ type: "item.completed", item: { type: "agent_message", text: "RESUME_RULE_ACTIVE" } }),
    "",
  ].join("\n"));
  writeFileSync(resumeTraceTwo, [
    JSON.stringify({ type: "thread.started", thread_id: "00000000-0000-0000-0000-000000000001" }),
    JSON.stringify({ type: "item.completed", item: { type: "command_execution", command: "/bin/zsh -lc 'superspec status --change resume-session-check'", aggregated_output: "{\"state\":\"explore\"}\n", exit_code: 0, status: "completed" } }),
    "",
  ].join("\n"));
  if (traceThreadIds(resumeTraceOne)[0] !== traceThreadIds(resumeTraceTwo)[0]) throw new Error("resume thread identity parsing failed");
  if (canonicalSuperspecArgv("superspec status --change resume-session-check")?.join(" ") !== "superspec status --change resume-session-check") throw new Error("resume status command parsing failed");
  if (!traceCompletedCommand(resumeTraceOne, "pwd") || !traceAgentMessages(resumeTraceOne).some(message => message.includes("RESUME_RULE_ACTIVE"))) throw new Error("resume trace evidence parsing failed");
  outcomes.push({ name: "resume-thread-cwd-rule-evidence", result: true });

  const resumeScenario = {
    assertions: {
      turn_1_required_worker_commands: [["superspec", "status", "--change", "resume-session-check"]],
      turn_2_required_worker_commands: [["superspec", "status", "--change", "resume-session-check"]],
    },
    stop: { snapshot_state: "init" },
  };
  const statusTrace = state => ({
    direct: [{ argv: ["superspec", "status", "--change", "resume-session-check"], output: JSON.stringify({ state }) }],
  });
  const statusPass = resumeStatusContinuity(statusTrace("init"), statusTrace("init"), resumeScenario, [], true);
  const statusFail = resumeStatusContinuity(statusTrace("init"), statusTrace("explore"), resumeScenario, [], true);
  const statusUnavailable = resumeStatusContinuity(statusTrace("init"), { direct: [] }, resumeScenario, [], true);
  if (statusPass.status !== "pass" || statusFail.status !== "fail" || statusUnavailable.status !== "unavailable") {
    throw new Error("resume direct status continuity grading failed");
  }
  outcomes.push({ name: "resume-direct-status-continuity", result: [statusPass.status, statusFail.status, statusUnavailable.status] });

  const negativeTrace = join(fixtureRoot, "negative-turn.jsonl");
  writeFileSync(negativeTrace, [
    JSON.stringify({ type: "item.completed", item: { type: "command_execution", command: "/bin/zsh -lc 'node --test tests/format-label.test.mjs && git diff --check'", aggregated_output: "pass\n", exit_code: 0, status: "completed" } }),
    "",
  ].join("\n"));
  const negativeScenario = { assertions: { required_verification_commands: ["node --test tests/format-label.test.mjs"] } };
  const negativeEvidence = negativeVerificationEvidence(negativeTrace, negativeScenario);
  const wrongCwdTrace = join(fixtureRoot, "negative-wrong-cwd.jsonl");
  writeFileSync(wrongCwdTrace, `${JSON.stringify({ type: "item.completed", item: { type: "command_execution", command: "/bin/zsh -lc 'cd /tmp && node --test tests/format-label.test.mjs'", exit_code: 0, status: "completed" } })}\n`);
  const wrongCwdEvidence = negativeVerificationEvidence(wrongCwdTrace, negativeScenario);
  const cleanActivation = superspecInvocationAudit([
    { type: "item.completed", item: { type: "command_execution", command: "/bin/zsh -lc 'node --test tests/format-label.test.mjs'" } },
  ], [], true);
  const forbiddenActivation = superspecInvocationAudit([
    { type: "item.completed", item: { type: "command_execution", command: "/bin/zsh -lc 'superspec status --change unexpected'" } },
  ], [], true);
  const cleanState = negativeActivationState([{ path: "src/format-label.mjs" }], cleanActivation);
  const dirtyState = negativeActivationState([{ path: ".superspec/changes/unexpected/events.jsonl" }], cleanActivation);
  if (!negativeEvidence.ok || negativeEvidence.matched[0].proof !== "successful_and_chain" || wrongCwdEvidence.ok || !cleanActivation.ok || forbiddenActivation.ok || !cleanState.ok || dirtyState.ok) {
    throw new Error("negative activation evidence grading failed");
  }
  outcomes.push({ name: "negative-activation-boundary", result: true });

  const decisionStopEvent = (event_type, payload) => ({ event_type, payload });
  const decisionStopBase = [
    decisionStopEvent("task_started", { task_id: "1.1" }),
    decisionStopEvent("transition_commit", { transition: "reopen", from_state: "apply", to_state: "propose" }),
  ];
  const decisionFacts = records => applyDecisionStopFacts({ records }, ["需要你确认默认路径语义"]);
  const passIntegrity = { status: "pass" };
  if (!applyDecisionStoppedCorrectly(passIntegrity, decisionFacts(decisionStopBase))) {
    throw new Error("Apply decision stop pass mapping failed");
  }
  outcomes.push({ name: "apply-decision-stop-pass", result: true });

  const completedFacts = decisionFacts([...decisionStopBase, decisionStopEvent("task_completed", { task_id: "1.1" })]);
  if (applyDecisionStoppedCorrectly(passIntegrity, completedFacts)) throw new Error("completed task must fail Apply decision stop");
  outcomes.push({ name: "apply-decision-stop-completed-task-fails", result: true });

  const secondStartedFacts = decisionFacts([
    ...decisionStopBase,
    decisionStopEvent("task_started", { task_id: "2.1" }),
  ]);
  if (applyDecisionStoppedCorrectly(passIntegrity, secondStartedFacts)) throw new Error("second task start must fail Apply decision stop");
  outcomes.push({ name: "apply-decision-stop-second-task-fails", result: true });

  const noReopenFacts = decisionFacts([decisionStopEvent("task_started", { task_id: "1.1" })]);
  if (applyDecisionStoppedCorrectly(passIntegrity, noReopenFacts)) throw new Error("missing reopen must fail Apply decision stop");
  outcomes.push({ name: "apply-decision-stop-missing-reopen-fails", result: true });

  const noQuestionFacts = applyDecisionStopFacts({ records: decisionStopBase }, ["实现已停止"]);
  if (applyDecisionStoppedCorrectly(passIntegrity, noQuestionFacts)) throw new Error("missing user question must fail Apply decision stop");
  outcomes.push({ name: "apply-decision-stop-missing-question-fails", result: true });

  const repairStop = {
    allowed_reopen_from: ["apply", "apply_done"],
    required_reopen_target: "apply",
    forbidden_reopen_targets: ["propose", "explore"],
  };
  const repairEvents = { records: [decisionStopEvent("transition_commit", {
    transition: "reopen",
    from_state: "apply_done",
    to_state: "apply",
    reopen_target: "apply",
  })] };
  if (!repairRoutingStoppedCorrectly(passIntegrity, repairRoutingFacts(repairEvents, repairStop))) {
    throw new Error("repair routing pass mapping failed");
  }
  const wrongRepairEvents = { records: [decisionStopEvent("transition_commit", {
    transition: "reopen",
    from_state: "apply_done",
    to_state: "propose",
    reopen_target: "propose",
  })] };
  if (repairRoutingStoppedCorrectly(passIntegrity, repairRoutingFacts(wrongRepairEvents, repairStop))) {
    throw new Error("forbidden repair routing target must fail");
  }
  outcomes.push({ name: "repair-routing-boundary", result: true });

  if (!multiAgentEnabledForScenario({ fixture: {} })
    || multiAgentEnabledForScenario({ fixture: { enable_multi_agent: false } })) {
    throw new Error("multi-agent scenario default mapping failed");
  }
  outcomes.push({ name: "multi-agent-enabled-by-default", result: true });

  const automaticBoundary = simulatedUserDecision({
    path: "ask_user",
    ask_user: {
      question: "是否进入计划阶段？",
      scope: "phase_confirmation:explore_to_propose:fixture",
      allowed_answers: ["确认进入计划阶段", "暂不进入计划阶段"],
    },
  });
  const semanticBoundary = simulatedUserDecision({
    path: "ask_user",
    ask_user: {
      question: "默认路径应相对当前目录还是项目根目录？",
      scope: "explore_open_question:fixture",
      allowed_answers: ["相对当前目录", "相对项目根目录"],
    },
  });
  const configuredBoundary = simulatedUserDecision({
    path: "ask_user",
    ask_user: {
      question: "选择已知业务口径",
      scope: "explore_open_question:known",
      allowed_answers: ["采用现有口径", "修改口径"],
    },
  }, { answers_by_scope_prefix: { "explore_open_question:known": "采用现有口径" } });
  const configuredFreeTextBoundary = simulatedUserDecision({
    path: "ask_user",
    ask_user: {
      question: "是否需要新建一套人员适用范围 scope？",
      scope: "explore_open_question:scope",
      allowed_answers: [],
    },
  }, { answers_by_question_pattern: [{ pattern: "新建.*scope", answer: "不要新建；SaaS 已有通用 scope 时必须复用通用能力。" }] });
  const recommendedFreeTextBoundary = simulatedUserDecision({
    path: "ask_user",
    ask_user: {
      question: "选项：A 保留旧接口并返回默认规则 / B 破坏性修改旧接口。建议：A；这样兼容旧调用方。",
      scope: "explore_open_question:recommended",
      allowed_answers: [],
    },
  });
  const recommendedInlineFreeTextBoundary = simulatedUserDecision({
    path: "ask_user",
    ask_user: {
      question: "选项：A 查询人（推荐；字段描述查看者权限） / B 被查询员工。",
      scope: "explore_open_question:inline-recommended",
      allowed_answers: [],
    },
  });
  const recommendedNaturalFreeTextBoundary = simulatedUserDecision({
    path: "ask_user",
    ask_user: {
      question: "兼容路线：A 一次性迁移 / B legacy fallback。建议 A，因为它保持单一数据源。",
      scope: "propose_open_question:recommended",
      allowed_answers: [],
    },
  });
  const recommendedAllowedBoundary = simulatedUserDecision({
    path: "ask_user",
    ask_user: {
      question: "请选择发布方式：A 直接发布 / B 先小流量验证（推荐）。",
      scope: "business:release",
      allowed_answers: ["直接发布", "先小流量验证"],
    },
  });
  const ambiguousRecommendationBoundary = simulatedUserDecision({
    path: "ask_user",
    ask_user: {
      question: "A 使用方案一 / B 使用方案二，请决定。",
      scope: "business:ambiguous",
      allowed_answers: [],
    },
  });
  const configuredTerminalStop = simulatedUserDecision({
    path: "ask_user",
    ask_user: {
      question: "是否开始实现？",
      scope: "phase_confirmation:propose_to_apply:fixture",
      allowed_answers: ["确认开始实现", "留在计划阶段"],
    },
  }, { stop_scope_prefixes: ["phase_confirmation:propose_to_apply:"] });
  const explicitHumanStop = simulatedUserDecision({
    path: "ask_user",
    ask_user: {
      question: "是否开始实现？",
      scope: "phase_confirmation:propose_to_apply:fixture",
      allowed_answers: ["确认开始实现", "留在计划阶段"],
    },
  }, { advance_until_terminal: false, stop_scope_prefixes: ["phase_confirmation:propose_to_apply:"] });
  if (automaticBoundary.action !== "reply" || automaticBoundary.answer !== "确认进入计划阶段"
    || semanticBoundary.action !== "needs_human"
    || configuredBoundary.action !== "reply" || configuredBoundary.answer !== "采用现有口径"
    || configuredFreeTextBoundary.action !== "reply" || configuredFreeTextBoundary.source !== "configured_question_answer"
    || recommendedFreeTextBoundary.action !== "reply" || recommendedFreeTextBoundary.answer !== "选择 A：采用工作流明确推荐的方案。"
    || recommendedFreeTextBoundary.source !== "workflow_recommendation"
    || recommendedInlineFreeTextBoundary.action !== "reply" || recommendedInlineFreeTextBoundary.answer !== "选择 A：采用工作流明确推荐的方案。"
    || recommendedNaturalFreeTextBoundary.action !== "reply" || recommendedNaturalFreeTextBoundary.answer !== "选择 A：采用工作流明确推荐的方案。"
    || recommendedAllowedBoundary.action !== "reply" || recommendedAllowedBoundary.answer !== "先小流量验证"
    || ambiguousRecommendationBoundary.action !== "needs_human"
    || configuredTerminalStop.action !== "needs_human" || configuredTerminalStop.source !== "configured_stop_scope"
    || explicitHumanStop.action !== "needs_human" || explicitHumanStop.source !== "configured_stop_scope") {
    throw new Error("simulated-user boundary policy mapping failed");
  }
  outcomes.push({ name: "simulated-user-boundary-policy", result: true });

  const dynamicAcceptedTrace = {
    malformed: 0,
    commandSchemaRecognized: true,
    direct: [{ argv: ["superspec", "transition", "accept", "--change", "fixture"], executable_allowed: true, output: JSON.stringify({ to_state: "accepted" }) }],
  };
  const dynamicChainedBoundaryTrace = {
    malformed: 0,
    commandSchemaRecognized: true,
    direct: [{
      argv: ["/bin/zsh", "-lc", "superspec record job-submit --change fixture --job JOB-1 --report -; superspec transition next --change fixture"],
      executable_allowed: true,
      raw: "/bin/zsh -lc 'superspec record job-submit --change fixture --job JOB-1 --report -; superspec transition next --change fixture'",
      output: `${JSON.stringify({ accepted: true })}\n${JSON.stringify({ path: "ask_user", ask_user: { question: "是否继续？", scope: "phase_confirmation:test", allowed_answers: ["确认继续"] } })}`,
    }],
  };
  const dynamicChainedTerminalTrace = {
    malformed: 0,
    commandSchemaRecognized: true,
    direct: [{
      argv: ["superspec", "transition", "next", "--change", "fixture"],
      executable_allowed: true,
      output: JSON.stringify({ state: "review", path: "next_command", next_command: "superspec transition accept --change fixture" }),
    }, {
      argv: ["/bin/zsh", "-lc", "superspec transition accept --change fixture && superspec transition next --change fixture && git status --short"],
      executable_allowed: true,
      raw: "/bin/zsh -lc 'superspec transition accept --change fixture && superspec transition next --change fixture && git status --short'",
      output: `${JSON.stringify({ to_state: "accepted" }, null, 2)}\n${JSON.stringify({ state: "accepted", path: "done" }, null, 2)}\n M src/example.ts`,
    }],
  };
  const dynamicMissingBoundaryTrace = { malformed: 0, commandSchemaRecognized: true, direct: [] };
  const dynamicAccepted = classifyDynamicTurn(dynamicAcceptedTrace, 0);
  const dynamicChainedBoundary = observedWorkflowBoundary(dynamicChainedBoundaryTrace);
  const dynamicChainedReply = simulatedUserTurnFromOutput(dynamicChainedBoundary?.output, { simulated_user: {} });
  const dynamicChainedTerminal = observedWorkflowBoundary(dynamicChainedTerminalTrace);
  const dynamicMissingBoundary = classifyDynamicTurn(dynamicMissingBoundaryTrace, 0);
  const assertionFreeScriptedTurn = classifyAuthenticity({
    malformed: 0,
    commandSchemaRecognized: true,
    direct: [],
    commands: [{
      kind: "shell_wrapper",
      raw: "/bin/zsh -lc 'superspec transition reopen --change fixture --to apply --reason repair && superspec transition next --change fixture'",
      status: "completed",
      exitCode: 0,
    }],
  }, undefined, 0, [], true);
  const dynamicContinuation = simulatedUserTurnFromOutput({ path: "required_job", required_job: { name: "explore" } }, { simulated_user: {} });
  const dynamicRecommendedReply = simulatedUserTurnFromOutput({
    path: "ask_user",
    ask_user: { question: "A 采用兼容方案（推荐） / B 破坏兼容", scope: "business:compatibility", allowed_answers: [] },
  }, { simulated_user: {} });
  const dynamicNeedsHuman = simulatedUserTurnFromOutput({
    path: "ask_user",
    ask_user: { question: "选择业务语义", scope: "business:meaning", allowed_answers: ["A", "B"] },
  }, { simulated_user: {} });
  const explicitReplyTrace = join(fixtureRoot, "explicit-user-reply.jsonl");
  const completedMessageTrace = join(fixtureRoot, "completed-agent-message.jsonl");
  writeFileSync(explicitReplyTrace, `${JSON.stringify({ type: "item.completed", item: { type: "agent_message", text: "请明确回复是否确认进入下一阶段。" } })}\n`);
  writeFileSync(completedMessageTrace, `${JSON.stringify({ type: "item.completed", item: { type: "agent_message", text: "本轮工作已经完成。" } })}\n`);
  let invalidBudgetRejected = false;
  try { dynamicTurnLimit({ budget: { max_worker_turns: 0 } }); } catch { invalidBudgetRejected = true; }
  if (dynamicTurnLimit({ budget: { max_worker_turns: 17 } }) !== 17
    || dynamicAccepted.status !== "pass"
    || observedWorkflowBoundary(dynamicAcceptedTrace)?.output?.to_state !== "accepted"
    || dynamicChainedBoundary?.observation !== "completed_shell_command"
    || dynamicChainedReply.action !== "reply" || dynamicChainedReply.answer !== "确认继续"
    || dynamicChainedTerminal?.output?.path !== "done"
    || dynamicMissingBoundary.status !== "pass" || dynamicMissingBoundary.sequence.ok !== true
    || assertionFreeScriptedTurn.status !== "pass" || assertionFreeScriptedTurn.sequence.ok !== true
    || dynamicContinuation.action !== "continue"
    || dynamicContinuation.worker_prompt_original !== "继续推进。"
    || dynamicContinuation.worker_prompt !== evalWorkerPrompt(dynamicContinuation.worker_prompt_original)
    || dynamicRecommendedReply.action !== "reply"
    || dynamicRecommendedReply.worker_prompt_original !== "选择 A：采用工作流明确推荐的方案。"
    || dynamicRecommendedReply.worker_prompt !== dynamicRecommendedReply.worker_prompt_original
    || evalWorkerPrompt("真实用户短提示") !== "真实用户短提示"
    || dynamicNeedsHuman.action !== "needs_human"
    || agentMessageRequestsUserReply(explicitReplyTrace) == null
    || agentMessageRequestsUserReply(completedMessageTrace) != null
    || !invalidBudgetRejected) {
    throw new Error("dynamic arbitrary-turn boundary validation failed");
  }
  outcomes.push({ name: "dynamic-arbitrary-turn-boundary", result: true });
  const recoveredTimeoutProcess = workerProcessStatus([0, 0, 0], [false, true, false], [false, true, false]);
  const unrecoveredTimeoutProcess = workerProcessStatus([0], [true], [false]);
  const failedProcess = workerProcessStatus([0, 1], [false, false], [false, false]);
  if (!recoveredTimeoutProcess.exitedCleanly
    || recoveredTimeoutProcess.recoveredTimeoutCount !== 1
    || unrecoveredTimeoutProcess.exitedCleanly
    || unrecoveredTimeoutProcess.unrecoveredTimeoutCount !== 1
    || failedProcess.exitedCleanly) {
    throw new Error("recoverable timeout process classification failed");
  }
  const noBoundaryRecovery = timeoutRecoveryFlags(
    [true, false],
    [
      { status: "pass", sequence: { ok: true, boundary: false } },
      { status: "pass", sequence: { ok: true, boundary: false } },
    ],
    true,
    { action: "budget_exhausted", after_worker_turn: 2 },
  );
  const boundaryRecovery = timeoutRecoveryFlags(
    [true, false],
    [
      { status: "pass", sequence: { ok: true, boundary: false } },
      { status: "pass", sequence: { ok: true, boundary: true } },
    ],
    true,
    { action: "complete", after_worker_turn: 2 },
  );
  if (noBoundaryRecovery[0] || !boundaryRecovery[0]) {
    throw new Error("timeout recovery must require a directly observed later workflow boundary");
  }
  outcomes.push({ name: "recoverable-timeout-is-performance-evidence", result: true });

  const emptyIndependent = independentAgentAudit([
    { type: "item.completed", item: { type: "collab_tool_call", tool: "wait", receiver_thread_ids: [], status: "completed" } },
  ]);
  const spawnedIndependent = independentAgentAudit([
    { type: "item.completed", item: { type: "collab_tool_call", tool: "spawn_agent", receiver_thread_ids: ["child-thread-1"], status: "completed" } },
  ]);
  if (emptyIndependent.ok || emptyIndependent.empty_wait_count !== 1 || !spawnedIndependent.ok) {
    throw new Error("independent agent provenance audit failed");
  }
  outcomes.push({ name: "independent-agent-provenance", result: true });

  const providerConfig = join(fixtureRoot, "config.toml");
  writeFileSync(providerConfig, [
    "[model_providers.fixtureproxy]",
    "name = \"fixtureproxy\"",
    "base_url = \"http://127.0.0.1:43000/v1\"",
    "env_key = \"FIXTURE_PROXY_KEY\"",
    "wire_api = \"responses\"",
    "requires_openai_auth = true",
    "ignored_secret = \"must-not-copy\"",
    "[unrelated] # a valid commented table header must end the provider section",
    "base_url = \"http://127.0.0.1:9/should-not-overwrite\"",
    "",
  ].join("\n"));
  const providerProfile = controlledProviderProfile("fixtureproxy", {
    configPath: providerConfig,
    env: { FIXTURE_PROXY_KEY: "fixture-secret" },
  });
  if (providerProfile.env_keys[0] !== "FIXTURE_PROXY_KEY" || providerProfile.cli_args.some(value => value.includes("fixture-secret") || value.includes("ignored_secret") || value.includes("should-not-overwrite"))) {
    throw new Error("controlled provider profile leaked or copied non-whitelisted provider data");
  }
  const credentialUrlConfig = join(fixtureRoot, "credential-url.toml");
  writeFileSync(credentialUrlConfig, [
    "[model_providers.credentialproxy]",
    "base_url = \"https://user:password@example.invalid/v1?token=secret\"",
    "env_key = \"CREDENTIAL_PROXY_KEY\"",
    "wire_api = \"responses\"",
    "",
  ].join("\n"));
  let credentialUrlRejected = false;
  try {
    controlledProviderProfile("credentialproxy", {
      configPath: credentialUrlConfig,
      env: { CREDENTIAL_PROXY_KEY: "fixture-secret" },
    });
  } catch {
    credentialUrlRejected = true;
  }
  if (!credentialUrlRejected) throw new Error("credential-bearing provider base_url must be rejected");
  const noAuthDirs = isolatedAuthHome("fixture-no-openai-auth", false);
  if (!noAuthDirs.auth.mode_ok || noAuthDirs.auth.required || existsSync(join(noAuthDirs.codexHome, "auth.json"))) {
    throw new Error("provider without OpenAI auth requirement must receive an empty isolated CODEX_HOME");
  }
  rmSync(noAuthDirs.home, { recursive: true, force: true });
  rmSync(noAuthDirs.codexHome, { recursive: true, force: true });
  outcomes.push({ name: "controlled-provider-whitelist", result: true });

  const fixtureWorkspace = join(fixtureRoot, "workspace");
  mkdirSync(fixtureWorkspace);
  const regular = join(fixtureWorkspace, "regular.md");
  writeFileSync(regular, "ok\n");
  const external = join(fixtureRoot, "external.md");
  writeFileSync(external, "outside\n");
  symlinkSync(external, join(fixtureWorkspace, "external-link.md"));
  symlinkSync(join(fixtureRoot, "missing.md"), join(fixtureWorkspace, "dangling.md"));
  const localExecutable = join(fixtureRoot, "superspec");
  writeFileSync(localExecutable, "#!/bin/sh\n");
  chmodSync(localExecutable, 0o755);
  if (!executableAllowed(localExecutable, [realpathSync(localExecutable)])) throw new Error("recorded run-local executable must be accepted");
  if (safeRegularFile(join(fixtureWorkspace, "external-link.md"), fixtureWorkspace).ok) throw new Error("symlink artifact must be rejected");
  let fixtureSymlinkRejected = false;
  try {
    confinedWorkspaceWriteTarget(fixtureWorkspace, "external-link.md/escaped.md");
  } catch {
    fixtureSymlinkRejected = true;
  }
  if (!fixtureSymlinkRejected) throw new Error("workspace fixture writes through symlinks must be rejected");
  let fixtureTraversalRejected = false;
  try {
    confinedWorkspaceWriteTarget(fixtureWorkspace, "../escaped.md");
  } catch {
    fixtureTraversalRejected = true;
  }
  if (!fixtureTraversalRejected) throw new Error("workspace fixture traversal must be rejected");
  const walked = walk(fixtureWorkspace);
  if (!walked.some(entry => entry.path === "dangling.md" && entry.dangling)) throw new Error("dangling symlink must be inventoried safely");
  outcomes.push({ name: "symlink-and-dangling-safe", result: true });

  const hiddenEvidenceDir = join(fixtureRoot, "evidence");
  mkdirSync(hiddenEvidenceDir);
  const hiddenTrace = join(hiddenEvidenceDir, "turn.jsonl");
  writeFileSync(hiddenTrace, "secret-harness-evidence\n");
  secureEvidenceForWorker(hiddenEvidenceDir, [hiddenTrace]);
  const permissionLog = join(fixtureRoot, "permission-actions.jsonl");
  const permissionRun = createDirectorSpawner(permissionLog);
  const readAttempt = await permissionRun(process.execPath, ["-e", "require('fs').readFileSync(process.argv[1])", hiddenTrace], { phase: "test.evidence-unreadable" });
  restoreEvidenceAfterWorker(hiddenEvidenceDir, [hiddenTrace]);
  if (readAttempt.code === 0 || existsSync(join(fixtureRoot, "scenario.json"))) throw new Error("Worker-visible harness evidence/scenario isolation failed");
  outcomes.push({ name: "scenario-absent-evidence-unreadable", result: true });

  const transitionEventBase = { event_id: "E1", event_type: "transition_commit", payload: { to_state: "explore" } };
  const transitionEvent = { ...transitionEventBase, event_digest: digestOfExact(eventBase(transitionEventBase)) };
  const laterEventBase = { event_id: "E2", event_type: "user_decision_recorded", payload: { accepted: true } };
  const laterEvent = { ...laterEventBase, event_digest: digestOfExact(eventBase(laterEventBase)) };
  const goodSnapshot = { state: "explore", events_digest: eventsDigestExact([transitionEvent]) };
  if (eventIntegrity({ present: true, malformed: 1, records: [transitionEvent] }, goodSnapshot, "explore").status !== "unavailable") throw new Error("malformed events must be unavailable");
  if (eventIntegrity({ present: true, malformed: 0, records: [transitionEvent] }, { ...goodSnapshot, events_digest: "sha256:bad" }, "explore").status !== "unavailable") throw new Error("snapshot digest mismatch must be unavailable");
  if (eventIntegrity({ present: true, malformed: 0, records: [transitionEvent] }, { ...goodSnapshot, state: "propose" }, "explore").status !== "unavailable") throw new Error("snapshot/event state mismatch must be unavailable");
  const tampered = { ...transitionEvent, payload: { to_state: "propose" } };
  if (eventIntegrity({ present: true, malformed: 0, records: [tampered] }, goodSnapshot, "explore").status !== "unavailable") throw new Error("payload tamper with old digest must be unavailable");
  const stalePrefix = eventIntegrity({ present: true, malformed: 0, records: [transitionEvent, laterEvent] }, goodSnapshot, "explore");
  if (stalePrefix.status !== "pass" || !stalePrefix.staleSnapshot) throw new Error("valid stale snapshot prefix must pass with limitation");
  outcomes.push({ name: "event-integrity-mismatches-unavailable", result: true });

  const hidden = classifyAuthenticity({
    direct: [{ kind: "direct", argv: required[0], executable_allowed: true }],
    commands: [{ kind: "direct", argv: required[0], executable_allowed: true }],
    malformed: 0,
    commandSchemaRecognized: true,
  }, required, 0, [], true, "hide-required-command");
  if (hidden.status !== "unavailable") throw new Error("hidden required evidence must be unavailable");
  outcomes.push({ name: "hide-required-evidence-invalid", result: hidden.status });

  const audit = traceEnvironmentAudit([
    { type: "item.completed", item: { type: "command_execution", status: "completed", command: "/bin/zsh -lc 'npm root -g'" } },
  ], {
    workspace: "/controlled/workspace", packageRoot: "/controlled/package", binRoot: "/controlled/bin",
    controlledHome: "/controlled/home", controlledCodexHome: "/controlled/codex", controlledZdotdir: "/controlled/zdot",
  }, [], true);
  if (audit.ok || audit.violations[0]?.reason !== "global_package_lookup") throw new Error("global package lookup must fail controlled environment audit");
  const tempAudit = traceEnvironmentAudit([
    { type: "item.completed", item: { type: "command_execution", status: "completed", command: "/bin/zsh -lc 'sed -n 1,2p /tmp/leak'" } },
  ], {
    workspace: "/controlled/workspace", packageRoot: "/controlled/package", binRoot: "/controlled/bin",
    controlledHome: "/controlled/home", controlledCodexHome: "/controlled/codex", controlledZdotdir: "/controlled/zdot",
  });
  if (tempAudit.ok || !tempAudit.violations.some(item => item.reason === "absolute_path_outside_allowlist")) throw new Error("generic /tmp absolute path must fail audit");
  const relativeAudit = traceEnvironmentAudit([
    { type: "item.completed", item: { type: "command_execution", status: "completed", command: "/bin/zsh -lc 'sed -n 1,2p docs/export.md && find . -path */artifacts/*'" } },
  ], {
    workspace: "/controlled/workspace", packageRoot: "/controlled/package", binRoot: "/controlled/bin",
    controlledHome: "/controlled/home", controlledCodexHome: "/controlled/codex", controlledZdotdir: "/controlled/zdot",
  });
  if (!relativeAudit.ok) throw new Error("relative workspace paths must not be misclassified as absolute host paths");
  const sensitiveSourceSearchAudit = traceEnvironmentAudit([
    { type: "item.completed", item: { type: "command_execution", status: "completed", command: "/bin/zsh -lc \"rg 'process.env|OPENAI_API_KEY|System.getenv' src\"" } },
  ], {
    workspace: "/controlled/workspace", packageRoot: "/controlled/package", binRoot: "/controlled/bin",
    controlledHome: "/controlled/home", controlledCodexHome: "/controlled/codex", controlledZdotdir: "/controlled/zdot",
  });
  if (!sensitiveSourceSearchAudit.ok) throw new Error("workspace source searches for sensitive API names must remain allowed");
  const chainedSensitiveSourceSearchAudit = traceEnvironmentAudit([
    { type: "item.completed", item: { type: "command_execution", status: "completed", command: "/bin/zsh -lc \"rg 'process.env' src && node -e 'console.log(process.env.CODEX_HOME)'\"" } },
  ], {
    workspace: "/controlled/workspace", packageRoot: "/controlled/package", binRoot: "/controlled/bin",
    controlledHome: "/controlled/home", controlledCodexHome: "/controlled/codex", controlledZdotdir: "/controlled/zdot",
  });
  if (chainedSensitiveSourceSearchAudit.ok || !chainedSensitiveSourceSearchAudit.violations.some(item => item.reason === "controlled_home_reference")) {
    throw new Error("source-search exemption must not cover chained environment reads");
  }
  const awkRegexAudit = traceEnvironmentAudit([
    { type: "item.completed", item: { type: "command_execution", status: "completed", command: "/bin/zsh -lc \"awk '/CSV or JSON format/{ok=1} /--output/{override=1}' docs/export.md\"" } },
  ], {
    workspace: "/controlled/workspace", packageRoot: "/controlled/package", binRoot: "/controlled/bin",
    controlledHome: "/controlled/home", controlledCodexHome: "/controlled/codex", controlledZdotdir: "/controlled/zdot",
  });
  if (!awkRegexAudit.ok) throw new Error("awk regex literals must not be misclassified as absolute host paths");
  const pipedRgRegexAudit = traceEnvironmentAudit([
    { type: "item.completed", item: { type: "command_execution", status: "completed", command: "/bin/zsh -lc \"rg --files | rg '/src/test/'\"" } },
  ], {
    workspace: "/controlled/workspace", packageRoot: "/controlled/package", binRoot: "/controlled/bin",
    controlledHome: "/controlled/home", controlledCodexHome: "/controlled/codex", controlledZdotdir: "/controlled/zdot",
  });
  if (!pipedRgRegexAudit.ok) throw new Error("piped rg regex literals must not be misclassified as absolute host paths");
  const reviewPayloadPathAudit = traceEnvironmentAudit([
    { type: "item.completed", item: { type: "command_execution", status: "completed", command: "/bin/zsh -lc \"printf '%s' '{\\\"reviewer\\\":{\\\"id\\\":\\\"/root/critic\\\"},\\\"route\\\":\\\"/2ndparty/api/getPersonalLimit\\\"}' | superspec record job-submit --change x --job j --report -\"" } },
    { type: "item.completed", item: { type: "command_execution", status: "completed", command: "/bin/zsh -lc \"printf '%s\\\\n' '{\\\"reviewer\\\":{\\\"id\\\":\\\"/root/critic-rerun\\\"}}' | superspec record job-submit --change x --job j --report -; superspec transition next --change x\"" } },
  ], {
    workspace: "/controlled/workspace", packageRoot: "/controlled/package", binRoot: "/controlled/bin",
    controlledHome: "/controlled/home", controlledCodexHome: "/controlled/codex", controlledZdotdir: "/controlled/zdot",
  });
  if (!reviewPayloadPathAudit.ok) throw new Error(`review payload path literals must not be treated as host access: ${JSON.stringify(reviewPayloadPathAudit.violations)}`);
  const embeddedNodePathAudit = traceEnvironmentAudit([
    { type: "item.completed", item: { type: "command_execution", status: "completed", command: "/bin/zsh -lc \"node -e 'require(\\\"fs\\\").readFileSync(\\\"/outside/secret.json\\\")'\"" } },
    { type: "item.completed", item: { type: "command_execution", status: "completed", command: "/bin/zsh -lc 'tool --config=/outside/config.json'" } },
    { type: "item.completed", item: { type: "command_execution", status: "completed", command: "/bin/zsh -lc 'printf data > /outside/output.txt'" } },
    { type: "item.completed", item: { type: "command_execution", status: "completed", command: "/bin/zsh -lc 'reader --json '\"'\"'{\"path\":\"/outside/from-json.json\"}'\"'\"''" } },
    { type: "item.completed", item: { type: "command_execution", status: "completed", command: "/bin/zsh -lc \"awk 'BEGIN { getline x < \\\"/outside/from-awk.txt\\\" }'\"" } },
    { type: "item.completed", item: { type: "command_execution", status: "completed", command: "/bin/zsh -lc \"printf '%s' '{\\\"x\\\":\\\"'; cat /outside/from-quote-injection.txt; echo '\\\"}' | superspec record user-decision --change x --input -\"" } },
  ], {
    workspace: "/controlled/workspace", packageRoot: "/controlled/package", binRoot: "/controlled/bin",
    controlledHome: "/controlled/home", controlledCodexHome: "/controlled/codex", controlledZdotdir: "/controlled/zdot",
  });
  if (embeddedNodePathAudit.ok || embeddedNodePathAudit.violations.filter(item => item.reason === "absolute_path_outside_allowlist").length < 6) {
    throw new Error("embedded, option-assigned, redirected, JSON, awk-read, and quote-injected paths outside the allowlist must fail audit");
  }
  const explicitSearchRootAudit = traceEnvironmentAudit([
    { type: "item.completed", item: { type: "command_execution", status: "completed", command: "/bin/zsh -lc \"rg -n 'user-decision' /outside/.eval-runs/run-1\"" } },
  ], {
    workspace: "/controlled/workspace", packageRoot: "/controlled/package", binRoot: "/controlled/bin",
    controlledHome: "/controlled/home", controlledCodexHome: "/controlled/codex", controlledZdotdir: "/controlled/zdot",
  });
  if (explicitSearchRootAudit.ok || !explicitSearchRootAudit.violations.some(item => item.reason === "absolute_path_outside_allowlist")) {
    throw new Error("explicit rg search roots outside the allowlist must fail audit");
  }
  const traversalAudit = traceEnvironmentAudit([
    { type: "item.completed", item: { type: "command_execution", status: "completed", command: "/bin/zsh -lc 'ls /bin/../etc'" } },
  ], {
    workspace: "/controlled/workspace", packageRoot: "/controlled/package", binRoot: "/controlled/bin",
    controlledHome: "/controlled/home", controlledCodexHome: "/controlled/codex", controlledZdotdir: "/controlled/zdot",
  });
  if (traversalAudit.ok || !traversalAudit.violations.some(item => item.reason === "absolute_path_outside_allowlist")) throw new Error("normalized absolute path traversal must fail audit");
  const controlledHomeVariableAudit = traceEnvironmentAudit([
    { type: "item.completed", item: { type: "command_execution", status: "completed", command: "/bin/zsh -lc 'sed -n 1,2p $CODEX_HOME/auth.json'" } },
  ], {
    workspace: "/controlled/workspace", packageRoot: "/controlled/package", binRoot: "/controlled/bin",
    controlledHome: "/controlled/home", controlledCodexHome: "/controlled/codex", controlledZdotdir: "/controlled/zdot",
  });
  if (controlledHomeVariableAudit.ok || !controlledHomeVariableAudit.violations.some(item => item.reason === "controlled_home_reference")) {
    throw new Error("controlled home environment references must fail audit");
  }
  const controlledHomeCacheAudit = traceEnvironmentAudit([
    { type: "item.completed", item: { type: "command_execution", status: "completed", command: "/bin/zsh -lc 'find \"$HOME/.m2/repository\" -type f | head'" } },
  ], {
    workspace: "/controlled/workspace", packageRoot: "/controlled/package", binRoot: "/controlled/bin",
    controlledHome: "/controlled/home", controlledCodexHome: "/controlled/codex", controlledZdotdir: "/controlled/zdot",
  });
  if (!controlledHomeCacheAudit.ok) throw new Error("ordinary controlled HOME cache lookup must remain available to realistic workers");
  const indirectControlledHomeAudit = traceEnvironmentAudit([
    { type: "item.completed", item: { type: "command_execution", status: "completed", command: "/bin/zsh -lc 'sed -n 1,2p \"$(printenv CODEX_HOME)/auth.json\"'" } },
    { type: "item.completed", item: { type: "command_execution", status: "completed", command: "/usr/bin/node -e 'require(\"fs\").readFileSync(process.env.CODEX_HOME+\"/auth.json\")'" } },
  ], {
    workspace: "/controlled/workspace", packageRoot: "/controlled/package", binRoot: "/controlled/bin",
    controlledHome: "/controlled/home", controlledCodexHome: "/controlled/codex", controlledZdotdir: "/controlled/zdot",
  });
  if (indirectControlledHomeAudit.ok || indirectControlledHomeAudit.violations.filter(item => item.reason === "controlled_home_reference").length < 2) {
    throw new Error("indirect controlled home references must fail audit");
  }
  const controlledHomePathAudit = traceEnvironmentAudit([
    { type: "item.completed", item: { type: "command_execution", status: "completed", command: "/bin/zsh -lc 'sed -n 1,2p /controlled/codex/auth.json'" } },
  ], {
    workspace: "/controlled/workspace", packageRoot: "/controlled/package", binRoot: "/controlled/bin",
    controlledHome: "/controlled/home", controlledCodexHome: "/controlled/codex", controlledZdotdir: "/controlled/zdot",
  });
  if (controlledHomePathAudit.ok || !controlledHomePathAudit.violations.some(item => item.reason === "controlled_home_path")) {
    throw new Error("controlled home absolute paths must fail audit");
  }
  const tildeHomeAudit = traceEnvironmentAudit([
    { type: "item.completed", item: { type: "command_execution", status: "completed", command: "/bin/zsh -lc 'sed -n 1,2p ~/.codex/auth.json'" } },
  ], {
    workspace: "/controlled/workspace", packageRoot: "/controlled/package", binRoot: "/controlled/bin",
    controlledHome: "/controlled/home", controlledCodexHome: "/controlled/codex", controlledZdotdir: "/controlled/zdot",
  });
  if (tildeHomeAudit.ok || !tildeHomeAudit.violations.some(item => item.reason === "controlled_home_reference")) {
    throw new Error("tilde home references must fail audit");
  }
  outcomes.push({ name: "host-path-audit-fails", result: true });

  const policy = workerCommandPolicyAudit([
    { type: "item.completed", item: { type: "command_execution", command: "/bin/zsh -lc 'superspec record user-decision --change x --input ack.json'" } },
    { type: "item.completed", item: { type: "command_execution", command: "/bin/zsh -lc 'superspec transition propose-ready --change x'" } },
  ], {
    forbidden_worker_commands: [
      { family: "superspec_record_user_decision" },
      { family: "superspec_transition_except", allowed_subcommands: ["next", "explore"] },
    ],
  }, [], true);
  if (policy.ok || policy.violations.length !== 2) throw new Error("forbidden Worker SuperSpec commands must fail policy audit");
  const absolutePolicy = workerCommandPolicyAudit([
    { type: "item.completed", item: { type: "command_execution", command: `/bin/zsh -lc '${localExecutable} transition review-ready --change x'` } },
  ], {
    forbidden_worker_commands: [{ family: "superspec_transition_except", allowed_subcommands: ["next", "explore"] }],
  }, [realpathSync(localExecutable)], false);
  if (absolutePolicy.ok || absolutePolicy.violations.length !== 1) throw new Error("absolute run-local superspec must be policy audited");
  outcomes.push({ name: "forbidden-worker-superspec-policy", result: true });

  const overlayBaseline = {
    id: "x",
    initial_prompt: "baseline。",
    fixture: { change: "x" },
    stop: { snapshot_state: "explore" },
    assertions: { required_files: ["a"] },
  };
  const validOverlay = structuredClone(overlayBaseline);
  validOverlay.assertions.forbidden_worker_commands = structuredClone(AUDIT_FORBIDDEN_WORKER_COMMANDS);
  if (!validateAuditOverlay(overlayBaseline, validOverlay).ok) throw new Error("valid audit-only scenario overlay rejected");
  const unchangedCustomRules = structuredClone(overlayBaseline);
  unchangedCustomRules.assertions.forbidden_worker_commands = [
    { family: "superspec_record_user_decision" },
    { family: "superspec_transition_except", allowed_subcommands: [] },
  ];
  if (!validateAuditOverlay(unchangedCustomRules, structuredClone(unchangedCustomRules)).ok) throw new Error("unchanged scenario-specific audit rules rejected");
  const invalidOverlay = structuredClone(validOverlay);
  invalidOverlay.fixture.change = "changed";
  if (validateAuditOverlay(overlayBaseline, invalidOverlay).ok) throw new Error("non-audit scenario mutation accepted");
  outcomes.push({ name: "audit-overlay-baseline-locked", result: true });

  const frozenScenarioSource = join(fixtureRoot, "scenario-source.json");
  writeFileSync(frozenScenarioSource, "{\"version\":1}\n");
  const frozenBytes = readFileSync(frozenScenarioSource);
  writeFileSync(frozenScenarioSource, "{\"version\":2}\n");
  const frozenMaterialized = join(fixtureRoot, "scenario-materialized.json");
  writeFileSync(frozenMaterialized, frozenBytes);
  if (readFileSync(frozenMaterialized, "utf8") !== "{\"version\":1}\n") throw new Error("scenario TOCTOU freeze failed");
  outcomes.push({ name: "scenario-bytes-frozen-before-worker", result: true });

  if (existsSync("/bin/zsh")) {
    const loginBin = join(fixtureRoot, "login-bin");
    const loginZdot = join(fixtureRoot, "login-zdot");
    mkdirSync(loginBin);
    mkdirSync(loginZdot);
    const loginSuperspec = join(loginBin, "superspec");
    writeFileSync(loginSuperspec, "#!/bin/sh\nexit 0\n", { mode: 0o755 });
    chmodSync(loginSuperspec, 0o755);
    const loginPath = `${loginBin}:/usr/bin:/bin:/usr/sbin:/sbin`;
    writeFileSync(join(loginZdot, ".zprofile"), `export PATH='${loginPath}'\n`);
    const loginRun = createDirectorSpawner(join(fixtureRoot, "login-actions.jsonl"));
    const loginResult = await loginRun("/bin/zsh", ["-lc", "command -v superspec"], {
      phase: "test.login-path", env: { ...process.env, PATH: loginPath, ZDOTDIR: loginZdot },
    });
    if (loginResult.code !== 0 || resolve(loginResult.stdout.trim()) !== resolve(loginSuperspec)) throw new Error("login zsh PATH reset proof failed");
    outcomes.push({ name: "login-zprofile-path-resolution", result: true });
  }

  const frozenRun = join(fixtureRoot, "frozen-run");
  const frozenEvidence = join(frozenRun, "evidence");
  const frozenPackage = join(frozenRun, "package");
  mkdirSync(join(frozenRun, "artifacts"), { recursive: true });
  mkdirSync(frozenEvidence, { recursive: true });
  mkdirSync(join(frozenPackage, "dist"), { recursive: true });
  mkdirSync(join(frozenPackage, "templates"), { recursive: true });
  writeFileSync(join(frozenPackage, "dist", "format.js"), "export const validateDiscovery=()=>({ok:true,message:'ok'});\n");
  writeFileSync(join(frozenPackage, "package.json"), "{}\n");
  writeFileSync(join(frozenRun, "artifacts", "discovery.md"), "# Discovery\n");
  writeFileSync(join(frozenEvidence, "events.jsonl"), "{}\n");
  writeFileSync(join(frozenEvidence, "snapshot.json"), "{}\n");
  for (const name of ["git-before.json", "git-after.json", "git.diff", "turn-1.jsonl", "turn-1.stderr.log", "director-actions.jsonl"]) writeFileSync(join(frozenEvidence, name), "\n");
  const frozenScenario = { fixture: { change: "x" }, assertions: { required_files: ["openspec/changes/x/.superspec/artifacts/discovery.md"] } };
  const frozenScenarioBytes = Buffer.from(JSON.stringify(frozenScenario));
  writeFileSync(join(frozenRun, "scenario.json"), frozenScenarioBytes);
  const frozenAfter = [
    { path: frozenScenario.assertions.required_files[0], type: "file", digest: hashFile(join(frozenRun, "artifacts", "discovery.md")) },
    { path: ".superspec/changes/x/events.jsonl", type: "file", digest: hashFile(join(frozenEvidence, "events.jsonl")) },
    { path: ".superspec/changes/x/snapshot.json", type: "file", digest: hashFile(join(frozenEvidence, "snapshot.json")) },
  ];
  writeJson(join(frozenEvidence, "workspace-before.json"), []);
  writeJson(join(frozenEvidence, "workspace-after.json"), frozenAfter);
  writeJson(join(frozenEvidence, "workspace-changes.json"), inventoryChanges([], frozenAfter));
  const frozenManifest = { scenario: { digest: sha256(frozenScenarioBytes) }, package: { isolated_digest: frozenPackageDigest(frozenPackage) } };
  writeJson(join(frozenRun, "manifest.json"), frozenManifest);
  const frozenArgs = { runRoot: frozenRun, evidenceDir: frozenEvidence, packageRoot: frozenPackage, originalManifest: frozenManifest, originalScenarioBytes: frozenScenarioBytes, scenario: frozenScenario };
  if (validateFrozenRegradeInputs(frozenArgs).errors.length !== 0) throw new Error("valid frozen regrade fixture rejected");
  mkdirSync(join(frozenRun, "workspace"));
  writeFileSync(join(frozenRun, "workspace", "live-mutation.txt"), "ignored\n");
  if (validateFrozenRegradeInputs(frozenArgs).errors.length !== 0) throw new Error("live workspace mutation affected frozen regrade");
  const frozenSnapshotBytes = readFileSync(join(frozenEvidence, "snapshot.json"));
  const afterWithoutSnapshot = frozenAfter.filter(entry => entry.path !== ".superspec/changes/x/snapshot.json");
  rmSync(join(frozenEvidence, "snapshot.json"));
  writeJson(join(frozenEvidence, "workspace-after.json"), afterWithoutSnapshot);
  writeJson(join(frozenEvidence, "workspace-changes.json"), inventoryChanges([], afterWithoutSnapshot));
  if (validateFrozenRegradeInputs(frozenArgs).errors.length !== 0) throw new Error("matching absence of optional frozen state evidence rejected");
  writeFileSync(join(frozenEvidence, "snapshot.json"), frozenSnapshotBytes);
  writeJson(join(frozenEvidence, "workspace-after.json"), frozenAfter);
  writeJson(join(frozenEvidence, "workspace-changes.json"), inventoryChanges([], frozenAfter));
  const frozenPromptOriginal = "original prompt";
  const frozenPromptEffective = evalWorkerPrompt(frozenPromptOriginal);
  writeJson(join(frozenEvidence, "worker-prompts.json"), {
    schema_version: 1,
    additions: [],
    turns: [workerPromptEvidence(1, frozenPromptOriginal, frozenPromptEffective, { kind: "scenario", field: "initial_prompt" })],
  });
  frozenManifest.prompts = {
    schema_version: 1,
    evidence: "evidence/worker-prompts.json",
    turn_count: 1,
    initial_original_digest: sha256(frozenPromptOriginal),
    initial_effective_digest: sha256(frozenPromptEffective),
    additions: [],
  };
  if (validateFrozenRegradeInputs(frozenArgs).errors.length !== 0) throw new Error("valid worker prompt evidence rejected");
  const frozenPromptEvidence = json(join(frozenEvidence, "worker-prompts.json"));
  frozenPromptEvidence.turns[0].effective_prompt_digest = "sha256:tampered";
  writeJson(join(frozenEvidence, "worker-prompts.json"), frozenPromptEvidence);
  if (validateFrozenRegradeInputs(frozenArgs).errors.length === 0) throw new Error("worker prompt evidence tamper not detected");
  frozenPromptEvidence.turns[0].effective_prompt_digest = sha256(frozenPromptEffective);
  writeJson(join(frozenEvidence, "worker-prompts.json"), frozenPromptEvidence);
  const tamperCases = [
    [join(frozenRun, "artifacts", "discovery.md"), "tampered artifact\n"],
    [join(frozenEvidence, "events.jsonl"), "tampered events\n"],
    [join(frozenEvidence, "snapshot.json"), "tampered snapshot\n"],
    [join(frozenPackage, "dist", "format.js"), "tampered package\n"],
  ];
  for (const [path, tamperedContent] of tamperCases) {
    const original = readFileSync(path);
    writeFileSync(path, tamperedContent);
    if (validateFrozenRegradeInputs(frozenArgs).errors.length === 0) throw new Error(`tamper not detected: ${path}`);
    writeFileSync(path, original);
  }
  if (validateFrozenRegradeInputs({ ...frozenArgs, originalScenarioBytes: Buffer.from("tampered scenario") }).errors.length === 0) throw new Error("scenario tamper not detected");
  if (validateFrozenRegradeInputs({ ...frozenArgs, originalManifest: { ...frozenManifest, package: { isolated_digest: "sha256:tampered" } } }).errors.length === 0) throw new Error("manifest tamper not detected");
  outcomes.push({ name: "frozen-regrade-tamper-boundaries", result: true });

  const sealActionLog = join(frozenEvidence, "director-actions.jsonl");
  writeFileSync(sealActionLog, "", { mode: 0o600 });
  const sealRun = createDirectorSpawner(sealActionLog);
  createEvidenceSeal({ runRoot: frozenRun, packageRoot: frozenPackage, actionLog: sealActionLog, run: sealRun });
  if (!verifyEvidenceSeal({ runRoot: frozenRun, packageRoot: frozenPackage, actionLog: sealActionLog }).ok) throw new Error("valid evidence seal rejected");
  for (const path of [
    join(frozenEvidence, "turn-1.jsonl"),
    join(frozenEvidence, "git.diff"),
    sealActionLog,
    join(frozenRun, "evidence-seal.json"),
  ]) {
    const original = readFileSync(path);
    chmodSync(path, 0o600);
    writeFileSync(path, `${original.toString("utf8")}tampered\n`);
    if (verifyEvidenceSeal({ runRoot: frozenRun, packageRoot: frozenPackage, actionLog: sealActionLog }).ok) throw new Error(`sealed tamper not detected: ${path}`);
    writeFileSync(path, original);
    chmodSync(path, 0o400);
  }
  outcomes.push({ name: "evidence-seal-tamper-detected", result: true });

  const timeoutLog = join(fixtureRoot, "timeout-actions.jsonl");
  const timeoutRun = createDirectorSpawner(timeoutLog);
  const descendantPidFile = join(fixtureRoot, "descendant.pid");
  const timed = await timeoutRun(process.execPath, ["-e", "const{spawn}=require('child_process'),fs=require('fs');const c=spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{stdio:'ignore'});fs.writeFileSync(process.argv[1],String(c.pid));setInterval(()=>{},1000)", descendantPidFile], {
    phase: "test.timeout", timeoutMs: 500, killGraceMs: 100,
  });
  if (!timed.timedOut) throw new Error("spawn timeout must be observable");
  const descendantPid = Number(readFileSync(descendantPidFile, "utf8"));
  await new Promise(resolvePromise => setTimeout(resolvePromise, 50));
  let descendantAlive = true;
  try { process.kill(descendantPid, 0); } catch { descendantAlive = false; }
  if (descendantAlive) throw new Error("timed out descendant process survived group cleanup");
  timeoutRun.terminateAll("SIGKILL");
  rmSync(fixtureRoot, { recursive: true, force: true });
  if (existsSync(fixtureRoot)) throw new Error("fixture cleanup failed");
  outcomes.push({ name: "timeout-and-cleanup", result: true });
  process.stdout.write(`${JSON.stringify({ ok: true, cases: outcomes }, null, 2)}\n`);
}

function existingEvidencePaths(capability, runRoot) {
  const missing = [];
  for (const [gateName, value] of Object.entries(capability.gates)) {
    for (const evidencePath of value.evidence) {
      if (!existsSync(join(runRoot, evidencePath))) missing.push({ gate: gateName, path: evidencePath });
    }
  }
  return missing;
}

function inventoryEntry(inventoryEntries, path) {
  return inventoryEntries.find(entry => entry.path === path) ?? null;
}

function frozenPackageDigest(packageRoot) {
  return sha256(JSON.stringify({
    dist: treeDigest(join(packageRoot, "dist")),
    templates: treeDigest(join(packageRoot, "templates")),
    package: hashFile(join(packageRoot, "package.json")),
  }));
}

function packageFileDigests(packageRoot) {
  return Object.fromEntries(walk(packageRoot)
    .filter(entry => entry.type === "file")
    .map(entry => [entry.path, entry.digest]));
}

function validateFrozenRegradeInputs({ runRoot, evidenceDir, packageRoot, originalManifest, originalScenarioBytes, scenario }) {
  const errors = [];
  const negativeActivationMode = scenario.session_mode === "single_turn_negative_activation";
  const scriptedTwoTurnMode = scenario.session_mode === "two_turn_scripted";
  const scriptedThreeTurnMode = scenario.session_mode === "three_turn_scripted";
  const dynamicUserMode = scenario.session_mode === "dynamic_user";
  const scriptedFourTurnMode = scenario.session_mode === "four_turn_scripted";
  const scriptedMode = scriptedTwoTurnMode || scriptedThreeTurnMode || scriptedFourTurnMode;
  const workflowArtifactMode = scriptedMode || dynamicUserMode;
  if (sha256(originalScenarioBytes) !== originalManifest.scenario?.digest) errors.push("scenario digest does not match original manifest");
  let actualPackageDigest = null;
  try { actualPackageDigest = frozenPackageDigest(packageRoot); } catch (error) { errors.push(`package digest unavailable: ${error instanceof Error ? error.message : String(error)}`); }
  if (actualPackageDigest !== originalManifest.package?.isolated_digest) errors.push("isolated package tree digest does not match original manifest");

  const before = json(join(evidenceDir, "workspace-before.json"));
  const after = json(join(evidenceDir, "workspace-after.json"));
  const storedChanges = json(join(evidenceDir, "workspace-changes.json"));
  const recomputedChanges = inventoryChanges(before, after);
  if (JSON.stringify(storedChanges) !== JSON.stringify(recomputedChanges)) errors.push("workspace-changes is inconsistent with frozen before/after inventories");

  const change = scenario.fixture.change;
  if (negativeActivationMode || workflowArtifactMode) {
    for (const artifactRelative of scenario.assertions.required_files ?? []) {
      const artifactEvidence = join(runRoot, "artifacts", "files", artifactRelative);
      const artifactCheck = safeRegularWithin(artifactEvidence, join(runRoot, "artifacts"));
      const artifactInventory = inventoryEntry(after, artifactRelative);
      if (!artifactCheck.ok || artifactInventory?.digest !== (artifactCheck.ok ? hashFile(artifactEvidence) : null)) {
        errors.push(`frozen required artifact does not match after-inventory digest: ${artifactRelative}`);
      }
    }
  } else {
    const artifactRelative = scenario.assertions.required_files[0];
    const artifactEvidence = join(runRoot, "artifacts", "discovery.md");
    const artifactCheck = safeRegularWithin(artifactEvidence, runRoot);
    const artifactInventory = inventoryEntry(after, artifactRelative);
    if (!artifactCheck.ok || artifactInventory?.digest !== (artifactCheck.ok ? hashFile(artifactEvidence) : null)) errors.push("frozen artifact does not match after-inventory digest");
  }

  const changedFilesRoot = join(runRoot, "artifacts", "changed-files");
  if (existsSync(changedFilesRoot)) {
    for (const entry of walk(changedFilesRoot).filter(item => item.type === "file")) {
      const frozenPath = join(changedFilesRoot, entry.path);
      const expected = inventoryEntry(after, entry.path)?.digest;
      if (!safeRegularWithin(frozenPath, changedFilesRoot).ok || expected == null || expected !== hashFile(frozenPath)) {
        errors.push(`frozen changed file does not match after-inventory digest: ${entry.path}`);
      }
    }
  }

  if (scenario.session_mode === "two_turn_resume") {
    for (const markerPath of Object.keys(scenario.assertions.marker_contents ?? {})) {
      const frozenMarker = join(runRoot, "artifacts", markerPath);
      const markerCheck = safeRegularWithin(frozenMarker, join(runRoot, "artifacts"));
      const expected = inventoryEntry(after, markerPath)?.digest;
      if (expected == null && !existsSync(frozenMarker)) continue;
      if (!markerCheck.ok || expected !== hashFile(frozenMarker)) errors.push(`frozen resume marker does not match after-inventory digest: ${markerPath}`);
    }
  }

  for (const [name, inventoryPath] of [
    ["events.jsonl", `.superspec/changes/${change}/events.jsonl`],
    ["snapshot.json", `.superspec/changes/${change}/snapshot.json`],
  ]) {
    const frozenPath = join(evidenceDir, name);
    const check = safeRegularWithin(frozenPath, evidenceDir);
    const expected = inventoryEntry(after, inventoryPath)?.digest;
    if (expected == null) {
      if (check.ok) errors.push(`${name} exists without an after-inventory entry`);
    } else if (!check.ok || expected !== hashFile(frozenPath)) {
      errors.push(`${name} does not match after-inventory digest`);
    }
  }

  const requiredEvidence = ["git-before.json", "git-after.json", "git.diff", "turn-1.jsonl", "turn-1.stderr.log", "director-actions.jsonl"];
  if (scenario.session_mode === "two_turn_resume") requiredEvidence.push("turn-2.jsonl", "turn-2.stderr.log", "resume-turn-2-AGENTS.md");
  if (scriptedTwoTurnMode) requiredEvidence.push("turn-2.jsonl", "turn-2.stderr.log");
  if (scriptedThreeTurnMode) requiredEvidence.push("turn-2.jsonl", "turn-2.stderr.log", "turn-3.jsonl", "turn-3.stderr.log");
  if (scriptedFourTurnMode) requiredEvidence.push("turn-2.jsonl", "turn-2.stderr.log", "turn-3.jsonl", "turn-3.stderr.log", "turn-4.jsonl", "turn-4.stderr.log");
  if (dynamicUserMode) {
    requiredEvidence.push("simulated-user-turns.json");
    const workerTurnCount = originalManifest.simulated_user?.worker_turn_count ?? 4;
    for (let turn = 2; turn <= workerTurnCount; turn++) requiredEvidence.push(`turn-${turn}.jsonl`, `turn-${turn}.stderr.log`);
    const simulatedTurns = json(join(evidenceDir, "simulated-user-turns.json"));
    for (const turn of simulatedTurns) {
      if (typeof turn?.model_evidence === "string") {
        requiredEvidence.push(turn.model_evidence.replace(/^evidence\//, ""));
        requiredEvidence.push(turn.model_evidence.replace(/^evidence\//, "").replace(/\.jsonl$/, ".stderr.log"));
      }
    }
  }
  const promptEvidenceDeclared = originalManifest.prompts?.evidence != null;
  if (promptEvidenceDeclared) {
    if (originalManifest.prompts.evidence !== "evidence/worker-prompts.json") {
      errors.push("worker prompt evidence path is invalid");
    } else {
      requiredEvidence.push("worker-prompts.json");
    }
  }
  if (negativeActivationMode) requiredEvidence.push("verifier.json");
  for (const required of requiredEvidence) {
    if (!safeRegularWithin(join(evidenceDir, required), evidenceDir).ok) errors.push(`required frozen evidence unavailable: ${required}`);
  }
  if (negativeActivationMode && safeRegularWithin(join(evidenceDir, "verifier.json"), evidenceDir).ok) {
    try {
      const verifier = json(join(evidenceDir, "verifier.json"));
      const expectedArgs = scenario.verifier?.args;
      if (scenario.verifier?.executable !== "node" || !Array.isArray(expectedArgs)) errors.push("negative activation verifier scenario contract is invalid");
      if (originalManifest.verifier?.executable !== "node" || JSON.stringify(originalManifest.verifier?.args) !== JSON.stringify(expectedArgs)) {
        errors.push("negative activation verifier manifest contract mismatch");
      }
      if (JSON.stringify(verifier.args) !== JSON.stringify(expectedArgs)
        || safeRealpath(verifier.executable) !== originalManifest.executables?.node?.realpath
        || !Number.isInteger(verifier.exit_code)) {
        errors.push("negative activation frozen verifier evidence mismatch");
      }
    } catch {
      errors.push("negative activation frozen verifier evidence is malformed");
    }
  }
  if (promptEvidenceDeclared && safeRegularWithin(join(evidenceDir, "worker-prompts.json"), evidenceDir).ok) {
    try {
      const promptEvidence = json(join(evidenceDir, "worker-prompts.json"));
      const additions = Array.isArray(promptEvidence.additions) ? promptEvidence.additions : [];
      const turns = Array.isArray(promptEvidence.turns) ? promptEvidence.turns : [];
      if (promptEvidence.schema_version !== 1 || originalManifest.prompts.schema_version !== 1) {
        errors.push("worker prompt evidence schema is invalid");
      }
      if (turns.length !== originalManifest.prompts.turn_count) errors.push("worker prompt evidence turn count mismatch");
      const additionIds = new Set();
      for (const addition of additions) {
        if (typeof addition?.id !== "string" || additionIds.has(addition.id)
          || typeof addition.content !== "string" || addition.digest !== sha256(addition.content)) {
          errors.push("worker prompt addition evidence is invalid");
          continue;
        }
        additionIds.add(addition.id);
      }
      const manifestAdditions = additions.map(({ id, digest }) => ({ id, digest }));
      if (JSON.stringify(manifestAdditions) !== JSON.stringify(originalManifest.prompts.additions ?? [])) {
        errors.push("worker prompt additions do not match original manifest");
      }
      const traceTurns = readdirSync(evidenceDir)
        .map(name => name.match(/^turn-(\d+)\.jsonl$/)?.[1])
        .filter(Boolean)
        .map(Number)
        .sort((left, right) => left - right);
      if (JSON.stringify(traceTurns) !== JSON.stringify(turns.map(turn => turn?.turn))) {
        errors.push("worker prompt evidence does not cover every frozen Worker turn");
      }
      for (let index = 0; index < turns.length; index++) {
        const turn = turns[index];
        if (turn?.turn !== index + 1
          || typeof turn.source?.kind !== "string"
          || typeof turn.original_prompt !== "string"
          || turn.original_prompt_digest !== sha256(turn.original_prompt)
          || typeof turn.effective_prompt !== "string"
          || turn.effective_prompt_digest !== sha256(turn.effective_prompt)
          || !Array.isArray(turn.additions)
          || turn.additions.some(id => !additionIds.has(id))) {
          errors.push(`worker prompt evidence is invalid for turn ${index + 1}`);
        }
      }
      if (turns[0]?.original_prompt_digest !== originalManifest.prompts.initial_original_digest
        || turns[0]?.effective_prompt_digest !== originalManifest.prompts.initial_effective_digest) {
        errors.push("initial worker prompt evidence does not match original manifest");
      }
    } catch {
      errors.push("worker prompt evidence is malformed");
    }
  }
  return { errors, before, after, storedChanges, actualPackageDigest };
}

function sealInputPaths(runRoot) {
  const paths = [
    "evidence/turn-1.jsonl", "evidence/turn-1.stderr.log",
    "evidence/workspace-before.json", "evidence/workspace-after.json", "evidence/workspace-changes.json",
    "evidence/git-before.json", "evidence/git-after.json", "evidence/git.diff",
    "evidence/events.jsonl", "evidence/snapshot.json",
    "scenario.json", "manifest.json",
  ];
  const evidenceRoot = join(runRoot, "evidence");
  if (existsSync(evidenceRoot)) {
    for (const name of readdirSync(evidenceRoot).sort()) {
      if (/^(?:turn|user-turn)-\d+\.(?:jsonl|stderr\.log)$/.test(name) || ["simulated-user-turns.json", "worker-prompts.json"].includes(name)) {
        const relativePath = `evidence/${name}`;
        if (!paths.includes(relativePath)) paths.push(relativePath);
      }
    }
  }
  if (existsSync(join(runRoot, "evidence/verifier.json"))) paths.push("evidence/verifier.json");
  const artifactsRoot = join(runRoot, "artifacts");
  if (existsSync(artifactsRoot)) {
    for (const entry of walk(artifactsRoot)) {
      if (entry.type === "file") paths.push(`artifacts/${entry.path}`);
    }
  }
  if (existsSync(join(runRoot, "evidence/resume-turn-2-AGENTS.md"))) paths.push("evidence/resume-turn-2-AGENTS.md");
  return paths.map(relativePath => ({ relativePath, absolutePath: join(runRoot, relativePath) }));
}

function createEvidenceSeal({ runRoot, packageRoot, actionLog, run }) {
  const sealPath = join(runRoot, "evidence-seal.json");
  run.recordMutation("post-collection.evidence-seal-intent", sealPath, { actor: "director" });
  const directorPrefix = readFileSync(actionLog);
  const files = {};
  for (const { relativePath, absolutePath } of sealInputPaths(runRoot)) {
    const check = safeRegularWithin(absolutePath, runRoot);
    if (existsSync(absolutePath) && !check.ok) throw new Error(`cannot seal unsafe evidence: ${relativePath}`);
    files[relativePath] = check.ok ? hashFile(absolutePath) : null;
  }
  const seal = {
    schema_version: 1,
    created_at: new Date().toISOString(),
    actor: "director",
    evaluator_source_digest: currentEvaluatorDigest(),
    files,
    director_log_prefix_digest: sha256(directorPrefix),
    isolated_package_digest: frozenPackageDigest(packageRoot),
  };
  writeJson(sealPath, seal);
  const sealDigest = hashFile(sealPath);
  run.recordMutation("post-collection.evidence-seal-created", sealPath, { actor: "director", seal_digest: sealDigest });
  for (const { absolutePath } of sealInputPaths(runRoot)) if (existsSync(absolutePath)) chmodSync(absolutePath, 0o400);
  chmodSync(actionLog, 0o400);
  chmodSync(sealPath, 0o400);
  return seal;
}

function verifyEvidenceSeal({ runRoot, packageRoot, actionLog }) {
  const sealPath = join(runRoot, "evidence-seal.json");
  if (!safeRegularWithin(sealPath, runRoot).ok) return { ok: false, reason: "evidence seal unavailable", historicalUnsealed: true };
  let seal;
  try { seal = json(sealPath); } catch { return { ok: false, reason: "evidence seal malformed" }; }
  const expectedPaths = sealInputPaths(runRoot).map(item => item.relativePath).sort();
  const sealedPaths = Object.keys(seal.files ?? {}).sort();
  if (seal.schema_version !== 1 || seal.actor !== "director" || typeof seal.evaluator_source_digest !== "string") {
    return { ok: false, reason: "evidence seal metadata invalid" };
  }
  if (JSON.stringify(sealedPaths) !== JSON.stringify(expectedPaths)) return { ok: false, reason: "evidence seal file set mismatch" };
  const actionContent = readFileSync(actionLog, "utf8");
  const actionLines = actionContent.split("\n").filter(Boolean);
  let finalAction;
  try { finalAction = JSON.parse(actionLines.at(-1)); } catch { return { ok: false, reason: "director seal action malformed" }; }
  if (finalAction.phase !== "post-collection.evidence-seal-created" || finalAction.detail?.seal_digest !== hashFile(sealPath)) {
    return { ok: false, reason: "seal digest is not anchored by final director action" };
  }
  const prefix = `${actionLines.slice(0, -1).join("\n")}\n`;
  if (sha256(prefix) !== seal.director_log_prefix_digest) return { ok: false, reason: "director log prefix digest mismatch" };
  for (const [relativePath, expectedDigest] of Object.entries(seal.files ?? {})) {
    const absolutePath = join(runRoot, relativePath);
    if (expectedDigest === null) {
      if (existsSync(absolutePath)) return { ok: false, reason: `sealed absent evidence appeared: ${relativePath}` };
      continue;
    }
    if (typeof expectedDigest !== "string" || !safeRegularWithin(absolutePath, runRoot).ok || hashFile(absolutePath) !== expectedDigest) {
      return { ok: false, reason: `sealed evidence mismatch: ${relativePath}` };
    }
  }
  if (frozenPackageDigest(packageRoot) !== seal.isolated_package_digest) return { ok: false, reason: "sealed package digest mismatch" };
  return { ok: true, seal };
}

async function validateFrozenDiscovery(artifactPath, packageRoot) {
  const tempRoot = mkdtempSync(join(tmpdir(), "superspec-regrade-validate-"));
  try {
    const changeRoot = join(tempRoot, "change");
    const target = join(changeRoot, ".superspec", "artifacts", "discovery.md");
    mkdirSync(dirname(target), { recursive: true });
    copyFileSync(artifactPath, target);
    const validatorPath = join(packageRoot, "dist", "format.js");
    if (!safeRegularWithin(validatorPath, packageRoot).ok) return { ok: false, message: "isolated validator module unavailable" };
    const formatModule = await import(`${pathToFileURL(validatorPath).href}?regrade=${Date.now()}`);
    return formatModule.validateDiscovery(changeRoot);
  } finally {
    rmSync(tempRoot, { recursive: true, force: true });
  }
}

function rejectedRegrade(runRoot, scenarioId, reason, metadata = {}) {
  const capability = emptyCapability(scenarioId);
  for (const name of CORE_GATES) capability.gates[name] = gate("unavailable", [], name === "controlled_environment" ? reason : "formal grading withheld");
  capability.limitations.push(reason);
  finalizeCapability(capability);
  const manifest = {
    schema_version: 1,
    regraded_at: new Date().toISOString(),
    source_run: runRoot,
    worker_reexecuted: false,
    formal_grading_performed: false,
    rejection_reason: reason,
    ...metadata,
  };
  writeJson(join(runRoot, "capability.regraded.json"), capability);
  writeJson(join(runRoot, "regrade-manifest.json"), manifest);
  process.stdout.write(`${JSON.stringify({ run: runRoot, capability, regrade_manifest: "regrade-manifest.json" }, null, 2)}\n`);
  return capability.exit_code;
}

async function regradeExistingRun(inputRunDir) {
  const runRoot = resolve(inputRunDir);
  const evidenceDir = join(runRoot, "evidence");
  const workspace = join(runRoot, "workspace");
  const packageRoot = join(runRoot, "package");
  const localBin = join(runRoot, "bin");
  const actionLog = join(evidenceDir, "director-actions.jsonl");
  const originalManifest = json(join(runRoot, "manifest.json"));
  const originalScenarioBytes = readFileSync(join(runRoot, "scenario.json"));
  const originalScenario = JSON.parse(originalScenarioBytes.toString("utf8"));
  const currentScenarioPath = join(EVAL_ROOT, "scenarios", `${originalScenario.id}.json`);
  const currentScenarioBytes = existsSync(currentScenarioPath) ? readFileSync(currentScenarioPath) : originalScenarioBytes;
  const currentScenario = JSON.parse(currentScenarioBytes.toString("utf8"));
  const sealVerification = verifyEvidenceSeal({ runRoot, packageRoot, actionLog });
  if (!sealVerification.ok && !sealVerification.historicalUnsealed) {
    return rejectedRegrade(runRoot, originalScenario.id, `evidence seal verification failed: ${sealVerification.reason}`, {
      evidence_seal: sealVerification,
    });
  }
  const overlay = validateAuditOverlay(originalScenario, currentScenario);
  if (!overlay.ok) {
    return rejectedRegrade(runRoot, originalScenario.id, `audit overlay rejected: ${overlay.errors.join("; ")}`, {
      evidence_seal: sealVerification,
      audit_overlay: overlay,
    });
  }
  const frozen = validateFrozenRegradeInputs({
    runRoot, evidenceDir, packageRoot, originalManifest, originalScenarioBytes, scenario: originalScenario,
  });
  if (frozen.errors.length > 0) {
    return rejectedRegrade(runRoot, originalScenario.id, `regrade rejected tampered/inconsistent evidence: ${frozen.errors.join("; ")}`, {
      evidence_seal: sealVerification,
      audit_overlay: overlay,
    });
  }
  const capability = emptyCapability(originalScenario.id);
  const tracePath = join(evidenceDir, "turn-1.jsonl");
  const resumeMode = originalScenario.session_mode === "two_turn_resume";
  const scriptedTwoTurnMode = originalScenario.session_mode === "two_turn_scripted";
  const scriptedThreeTurnMode = originalScenario.session_mode === "three_turn_scripted";
  const dynamicUserMode = originalScenario.session_mode === "dynamic_user";
  const scriptedFourTurnMode = originalScenario.session_mode === "four_turn_scripted";
  const scriptedMode = scriptedTwoTurnMode || scriptedThreeTurnMode || scriptedFourTurnMode;
  const workflowArtifactMode = scriptedMode || dynamicUserMode;
  const persistentMode = resumeMode || scriptedMode || dynamicUserMode;
  const negativeActivationMode = originalScenario.session_mode === "single_turn_negative_activation";
  const resumeTracePath = join(evidenceDir, "turn-2.jsonl");
  const thirdTracePath = join(evidenceDir, "turn-3.jsonl");
  const fourthTracePath = join(evidenceDir, "turn-4.jsonl");
  const shimRealpath = originalManifest.package?.shim_realpath;
  const executableIdentities = typeof shimRealpath === "string" ? [shimRealpath] : [];
  const bareResolutionProven = originalManifest.launch?.bare_superspec_resolution?.proven === true;
  const dynamicWorkerTurnCount = dynamicUserMode ? (originalManifest.simulated_user?.worker_turn_count ?? 4) : 0;
  const tracePaths = dynamicUserMode
    ? dynamicTracePaths(evidenceDir, dynamicWorkerTurnCount)
    : scriptedFourTurnMode
    ? [tracePath, resumeTracePath, thirdTracePath, fourthTracePath]
    : scriptedThreeTurnMode ? [tracePath, resumeTracePath, thirdTracePath] : persistentMode ? [tracePath, resumeTracePath] : [tracePath];
  const trace = parseTrace(tracePaths, workspace, null, executableIdentities, bareResolutionProven, null);
  const turn1Trace = persistentMode ? parseTrace(tracePath, workspace, null, executableIdentities, bareResolutionProven, null) : trace;
  const turn2Trace = persistentMode ? parseTrace(resumeTracePath, workspace, null, executableIdentities, bareResolutionProven, null) : null;
  const turn3Trace = scriptedThreeTurnMode || scriptedFourTurnMode ? parseTrace(thirdTracePath, workspace, null, executableIdentities, bareResolutionProven, null) : null;
  const turn4Trace = scriptedFourTurnMode ? parseTrace(fourthTracePath, workspace, null, executableIdentities, bareResolutionProven, null) : null;
  const dynamicTurnTraces = dynamicUserMode
    ? tracePaths.map(path => parseTrace(path, workspace, null, executableIdentities, bareResolutionProven, null))
    : [];
  const actions = readFileSync(actionLog, "utf8").split("\n").filter(Boolean).map(JSON.parse);
  const workerStarted = actions.find(entry => entry.phase === "worker.turn-1" && entry.event === "started");
  const workerCompleted = actions.find(entry => entry.phase === "worker.turn-1" && entry.event === "completed");
  const resumeWorkerCompleted = actions.find(entry => entry.phase === "worker.turn-2-resume" && entry.event === "completed");
  const thirdWorkerCompleted = actions.find(entry => entry.phase === "worker.turn-3-resume" && entry.event === "completed");
  const fourthWorkerCompleted = actions.find(entry => entry.phase === "worker.turn-4-resume" && entry.event === "completed");
  const workerCode = workerCompleted?.exit_code ?? null;
  const resumeWorkerCode = resumeWorkerCompleted?.exit_code ?? null;
  const thirdWorkerCode = thirdWorkerCompleted?.exit_code ?? null;
  const fourthWorkerCode = fourthWorkerCompleted?.exit_code ?? null;
  const dynamicWorkerCodes = dynamicUserMode
    ? Array.from({ length: dynamicWorkerTurnCount }, (_, index) => {
        const turn = index + 1;
        return actions.find(entry => entry.phase === (turn === 1 ? "worker.turn-1" : `worker.turn-${turn}-resume`) && entry.event === "completed")?.exit_code ?? null;
      })
    : [];
  const dynamicWorkerTimeouts = dynamicUserMode
    ? Array.from({ length: dynamicWorkerTurnCount }, (_, index) => {
        const turn = index + 1;
        return actions.find(entry => entry.phase === (turn === 1 ? "worker.turn-1" : `worker.turn-${turn}-resume`) && entry.event === "completed")?.timed_out === true;
      })
    : [];
  const environmentAudit = traceEnvironmentAudit(trace.events, {
    workspace,
    packageRoot,
    binRoot: localBin,
    controlledHome: join(runRoot, "__deleted_controlled_home__"),
    controlledCodexHome: join(runRoot, "__deleted_controlled_codex_home__"),
    controlledZdotdir: originalManifest.launch?.zdotdir ?? join(runRoot, "zdot"),
    sensitiveEnvKeys: originalManifest.control?.provider?.environment_keys ?? [],
  });
  const commandPolicyAudit = workerCommandPolicyAudit(trace.events, overlay.assertions, executableIdentities, bareResolutionProven);
  const activationAudit = negativeActivationMode
    ? superspecInvocationAudit(trace.events, executableIdentities, bareResolutionProven)
    : null;
  const verificationEvidence = negativeActivationMode
    ? negativeVerificationEvidence(tracePath, originalScenario)
    : null;
  const turn1Authenticity = persistentMode && !dynamicUserMode
    ? classifyAuthenticity(turn1Trace, originalScenario.assertions.turn_1_required_worker_commands, workerCode, executableIdentities, bareResolutionProven, null)
    : null;
  const turn2Authenticity = persistentMode && !dynamicUserMode
    ? classifyAuthenticity(turn2Trace, originalScenario.assertions.turn_2_required_worker_commands, resumeWorkerCode, executableIdentities, bareResolutionProven, null)
    : null;
  const turn3Authenticity = scriptedThreeTurnMode || scriptedFourTurnMode
    ? classifyAuthenticity(turn3Trace, originalScenario.assertions.turn_3_required_worker_commands, thirdWorkerCode, executableIdentities, bareResolutionProven, null)
    : null;
  const turn4Authenticity = scriptedFourTurnMode
    ? classifyAuthenticity(turn4Trace, originalScenario.assertions.turn_4_required_worker_commands, fourthWorkerCode, executableIdentities, bareResolutionProven, null)
    : null;
  const turnAuthenticities = dynamicUserMode
    ? dynamicTurnTraces.map((turnTrace, index) => classifyDynamicTurn(turnTrace, dynamicWorkerCodes[index]))
    : persistentMode
    ? [turn1Authenticity, turn2Authenticity, ...((scriptedThreeTurnMode || scriptedFourTurnMode) ? [turn3Authenticity] : []), ...(scriptedFourTurnMode ? [turn4Authenticity] : [])]
    : [];
  let authenticity = persistentMode
    ? {
        status: turnAuthenticities.some(item => item.status === "fail")
          ? "fail"
          : turnAuthenticities.some(item => item.status === "unavailable") ? "unavailable" : "pass",
        detail: turnAuthenticities.map((item, index) => `${index === 0 ? "turn-1" : `resumed turn-${index + 1}`} ${item.status}`).join("; "),
        sequence: { ok: turnAuthenticities.every(item => item.sequence.ok) },
      }
    : negativeActivationMode
      ? workerCode !== 0
        ? { status: "unavailable", detail: "recorded Worker did not complete successfully", sequence: { ok: false } }
        : trace.malformed > 0 || !trace.commandSchemaRecognized
          ? { status: "unavailable", detail: "recorded command event schema is not safely recognizable", sequence: { ok: false } }
          : !activationAudit.ok
            ? { status: "fail", detail: `recorded ordinary task invoked SuperSpec: ${activationAudit.violations.map(item => item.command).join("; ")}`, sequence: { ok: verificationEvidence.ok } }
            : !verificationEvidence.ok
              ? { status: "fail", detail: "recorded required ordinary-task verification command was not directly completed", sequence: { ok: false } }
              : { status: "pass", detail: "recorded ordinary-task verification completed with no SuperSpec invocation", sequence: { ok: true } }
    : classifyAuthenticity(trace, originalScenario.assertions.required_worker_commands, workerCode, executableIdentities, bareResolutionProven, null);
  const independentReviewTrace = dynamicUserMode ? dynamicTurnTraces.at(-1) : turn4Trace;
  const independentReview = (scriptedFourTurnMode || dynamicUserMode) && originalScenario.assertions.require_independent_review === true
    ? independentAgentAudit(independentReviewTrace?.events ?? [])
    : null;
  if (independentReview && authenticity.status === "pass" && !independentReview.ok) {
    authenticity = {
      ...authenticity,
      status: "fail",
      detail: `${authenticity.detail}; no completed independent-agent spawn with a receiver thread was recorded`,
    };
  }
  const director = directorSafe(actionLog, workerStarted?.started_at ?? "", executableIdentities);
  const workerCodes = dynamicUserMode
    ? dynamicWorkerCodes
    : [workerCode, ...(persistentMode ? [resumeWorkerCode] : []), ...((scriptedThreeTurnMode || scriptedFourTurnMode) ? [thirdWorkerCode] : []), ...(scriptedFourTurnMode ? [fourthWorkerCode] : [])];
  const workerTimeouts = dynamicUserMode
    ? dynamicWorkerTimeouts
    : [workerCompleted?.timed_out === true, ...(persistentMode ? [resumeWorkerCompleted?.timed_out === true] : []), ...((scriptedThreeTurnMode || scriptedFourTurnMode) ? [thirdWorkerCompleted?.timed_out === true] : []), ...(scriptedFourTurnMode ? [fourthWorkerCompleted?.timed_out === true] : [])];
  const recordedSimulatedTurnsPath = join(evidenceDir, "simulated-user-turns.json");
  const recordedSimulatedTurns = dynamicUserMode && safeRegularWithin(recordedSimulatedTurnsPath, evidenceDir).ok
    ? json(recordedSimulatedTurnsPath)
    : [];
  const recordedDynamicStop = Array.isArray(recordedSimulatedTurns) ? recordedSimulatedTurns.at(-1) ?? null : null;
  const timeoutRecoveries = timeoutRecoveryFlags(
    workerTimeouts,
    turnAuthenticities,
    originalManifest.session?.same_thread === true,
    recordedDynamicStop,
  );
  const processStatus = workerProcessStatus(workerCodes, workerTimeouts, timeoutRecoveries, "recorded Worker");
  const workerStderrEvidence = ["evidence/director-actions.jsonl", ...tracePaths.map((_, index) => `evidence/turn-${index + 1}.stderr.log`)];
  const workerTraceEvidence = ["manifest.json", "evidence/director-actions.jsonl", ...tracePaths.map((_, index) => `evidence/turn-${index + 1}.jsonl`)];

  capability.gates.process = processStatus.exitedCleanly
    ? gate("pass", workerStderrEvidence, processStatus.detail)
    : gate("unavailable", workerStderrEvidence, processStatus.detail);
  if (processStatus.recoveredTimeoutCount > 0) capability.limitations.push(`${processStatus.recoveredTimeoutCount} recorded Worker turn(s) timed out but later workflow evidence remained recoverable`);
  capability.gates.controlled_environment = processStatus.exitedCleanly && director.ok && environmentAudit.ok
    ? gate("pass", workerTraceEvidence, "offline audit found no forbidden director action or host-path access")
    : !environmentAudit.ok
      ? gate("fail", ["evidence/turn-1.jsonl"], `recorded Worker accessed disallowed paths: ${environmentAudit.violations.map(item => item.reason).join(", ")}`)
      : gate("unavailable", ["evidence/director-actions.jsonl"], "recorded controlled environment cannot be proven");
  capability.gates.authenticity = gate(
    authenticity.status,
    [...tracePaths.map((_, index) => `evidence/turn-${index + 1}.jsonl`), "manifest.json"],
    authenticity.detail,
    authenticity.status === "pass" ? "direct" : authenticity.status === "unavailable" ? "unavailable" : "direct",
  );
  capability.gates.authenticity.components = authenticity.status === "pass" ? {
    command: { evidence_level: "direct", source: "completed command_execution event" },
    exit_code: { evidence_level: "direct", source: "completed command_execution event" },
    cwd: { evidence_level: "correlated", source: "recorded controlled Worker launch cwd" },
    executable_identity: negativeActivationMode
      ? { evidence_level: "correlated", source: "recorded controlled PATH and complete Worker command trace" }
      : { evidence_level: "correlated", source: "recorded login-zsh resolution proof" },
  } : { command: { evidence_level: authenticity.status === "unavailable" ? "unavailable" : "direct" } };
  if (independentReview) capability.independent_review = independentReview;

  const changes = frozen.storedChanges;
  const activationState = negativeActivationMode ? negativeActivationState(changes, activationAudit) : null;
  const scopeViolations = changes.filter(change => !inventoryChangeAllowed(change, originalScenario.assertions.allowed_worker_changes));
  capability.gates.scope = scopeViolations.length === 0
    ? gate("pass", ["evidence/workspace-before.json", "evidence/workspace-after.json", "evidence/git-after.json", "evidence/git.diff"])
    : gate("fail", ["evidence/workspace-before.json", "evidence/workspace-after.json", "evidence/git-after.json", "evidence/git.diff"], `out-of-scope paths: ${scopeViolations.map(item => item.path).join(", ")}`);

  const frozenArtifactPath = join(runRoot, "artifacts", "discovery.md");
  const artifactChecks = negativeActivationMode || workflowArtifactMode
    ? originalScenario.assertions.required_files.map(path => ({ path: `artifacts/files/${path}`, ...safeRegularWithin(join(runRoot, "artifacts", "files", path), join(runRoot, "artifacts")) }))
    : [{ path: "artifacts/discovery.md", ...safeRegularWithin(frozenArtifactPath, runRoot) }];
  const verifierPath = join(evidenceDir, "verifier.json");
  let verifierResult = null;
  if (negativeActivationMode && safeRegularWithin(verifierPath, evidenceDir).ok) {
    try { verifierResult = json(verifierPath); } catch {}
  }
  const artifactValidation = negativeActivationMode
    ? {
        ok: verifierResult?.exit_code === 0,
        message: verifierResult == null ? "frozen ordinary-task verifier unavailable" : `ordinary-task verifier exit ${verifierResult.exit_code}`,
      }
    : artifactChecks.every(check => check.ok)
      ? await validateFrozenDiscovery(frozenArtifactPath, packageRoot)
      : { ok: false, message: "required frozen artifact unavailable" };
  const markerContentErrors = resumeMode
    ? Object.entries(originalScenario.assertions.marker_contents ?? {}).flatMap(([markerPath, expected]) => {
        const frozenMarker = join(runRoot, "artifacts", markerPath);
        if (!safeRegularWithin(frozenMarker, join(runRoot, "artifacts")).ok) return [`${markerPath}: unavailable`];
        return readFileSync(frozenMarker, "utf8").trim() === expected ? [] : [`${markerPath}: content mismatch`];
    })
    : [];
  const requiredContentErrors = workflowArtifactMode
    ? requiredFileContentErrors(join(runRoot, "artifacts", "files"), originalScenario.assertions)
    : [];
  capability.gates.artifact = artifactChecks.every(check => check.ok) && artifactValidation.ok && markerContentErrors.length === 0 && requiredContentErrors.length === 0
    ? gate("pass", negativeActivationMode
        ? [...artifactChecks.map(check => check.path), "evidence/verifier.json"]
        : workflowArtifactMode
          ? artifactChecks.map(check => check.path)
        : resumeMode ? ["artifacts/discovery.md", "artifacts/resume-turn-1.txt", "artifacts/resume-turn-2.txt"] : ["artifacts/discovery.md"],
      negativeActivationMode
        ? `frozen ordinary-task artifact is valid and ${artifactValidation.message}`
        : workflowArtifactMode
          ? `all frozen workflow artifacts are valid; discovery validation: ${artifactValidation.message}`
        : resumeMode ? "frozen discovery and both workspace-write markers are valid; semantic quality is ungraded" : `discovery structure valid: ${artifactValidation.message}; semantic quality is ungraded`, "direct")
    : gate(authenticity.sequence.ok ? "fail" : "unavailable", ["evidence/workspace-after.json"], `artifact invalid: ${[artifactValidation.message, ...markerContentErrors, ...requiredContentErrors].join("; ")}`);

  const eventsPath = join(evidenceDir, "events.jsonl");
  const snapshotPath = join(evidenceDir, "snapshot.json");
  const eventsCheck = safeRegularWithin(eventsPath, evidenceDir);
  const snapshotCheck = safeRegularWithin(snapshotPath, evidenceDir);
  const events = eventsCheck.ok ? readEvents(eventsPath) : { records: [], malformed: 0, present: false };
  let snapshot = null;
  if (snapshotCheck.ok) try { snapshot = json(snapshotPath); } catch {}
  const statusContinuity = resumeMode
    ? resumeStatusContinuity(turn1Trace, turn2Trace, originalScenario, executableIdentities, bareResolutionProven)
    : null;
  const integrity = resumeMode || negativeActivationMode ? null : eventIntegrity(
    events,
    snapshot,
    originalScenario.stop.allowed_snapshot_states ?? originalScenario.stop.snapshot_state,
  );
  capability.gates.state = negativeActivationMode
    ? gate(activationState.ok ? "pass" : "fail", ["evidence/turn-1.jsonl", "evidence/workspace-changes.json"], activationState.ok ? "no recorded SuperSpec command or workflow-state change occurred" : `recorded unexpected SuperSpec activation: ${JSON.stringify(activationState)}`, "direct")
    : resumeMode
    ? gate(statusContinuity.status, ["evidence/turn-1.jsonl", "evidence/turn-2.jsonl"], statusContinuity.detail, "direct")
    : gate(integrity.status, ["evidence/snapshot.json", "evidence/events.jsonl"], integrity.detail);
  if (integrity?.staleSnapshot) capability.limitations.push(`snapshot is a valid stale event prefix (${integrity.snapshotPrefixLength}/${events.records.length})`);

  if (negativeActivationMode) {
    if (!activationAudit.ok || !activationState.ok) {
      capability.gates.stop_boundary = gate("fail", ["evidence/turn-1.jsonl", "evidence/workspace-changes.json"], `recorded ordinary request activated SuperSpec: ${JSON.stringify(activationState)}`, "direct");
    } else if (!verificationEvidence.ok || verifierResult == null) {
      capability.gates.stop_boundary = gate("unavailable", ["evidence/turn-1.jsonl", "evidence/verifier.json"], "recorded ordinary-task completion evidence is unavailable");
    } else if (verifierResult.exit_code !== 0) {
      capability.gates.stop_boundary = gate("fail", ["evidence/turn-1.jsonl", "evidence/verifier.json"], `recorded ordinary-task verifier failed with exit ${verifierResult.exit_code}`, "direct");
    } else {
      capability.gates.stop_boundary = gate("pass", ["evidence/turn-1.jsonl", "evidence/verifier.json", "evidence/workspace-changes.json"], "recorded ordinary request completed and stopped without activating SuperSpec", "direct");
    }
  } else if (dynamicUserMode) {
    const turnIds = tracePaths.map(path => traceThreadIds(path));
    const threadId = turnIds[0]?.[0] ?? null;
    const sameThread = threadId != null
      && turnIds.every(ids => ids.length === 1 && ids[0] === threadId)
      && originalManifest.session?.same_thread === true;
    const observedBoundaries = dynamicTurnTraces
      .map((trace, index) => ({ turn: index + 1, boundary: observedWorkflowBoundary(trace) }))
      .filter(item => item.boundary?.output != null);
    const terminalBoundary = [...observedBoundaries].reverse().find(item =>
      item.boundary.output.path === "done" || item.boundary.output.to_state === "accepted"
    ) ?? null;
    const finalBoundary = terminalBoundary?.boundary ?? observedBoundaries.at(-1)?.boundary ?? null;
    const simulatedTurnsPath = join(evidenceDir, "simulated-user-turns.json");
    const simulatedTurns = safeRegularWithin(simulatedTurnsPath, evidenceDir).ok ? json(simulatedTurnsPath) : [];
    const recordedStop = originalManifest.simulated_user?.stop
      ?? [...simulatedTurns].reverse().find(turn => ["complete", "needs_human", "budget_exhausted", "invalid_execution", "worker_failed"].includes(turn?.action))
      ?? null;
    const effectiveStop = terminalBoundary && integrity?.derivedState === "accepted"
      ? {
          action: "complete",
          after_worker_turn: terminalBoundary.turn,
          reason: "recorded trace reached the declared terminal workflow result",
          next_output: terminalBoundary.boundary.output,
        }
      : recordedStop;
    const finalOutput = finalBoundary?.output ?? effectiveStop?.next_output ?? null;
    const enteredArchive = events.records.some(event => event.event_type === "transition_commit" && event.payload?.to_state === "archive");
    capability.dynamic_user = {
      same_thread: sameThread,
      worker_turn_count: workerCodes.length,
      ...(terminalBoundary ? { terminal_worker_turn: terminalBoundary.turn } : {}),
      final_state: integrity?.derivedState ?? null,
      final_output: finalOutput,
      stop: effectiveStop,
    };
    const stopEvidence = [...tracePaths.map((_, index) => `evidence/turn-${index + 1}.jsonl`), "evidence/simulated-user-turns.json", "evidence/events.jsonl", "evidence/snapshot.json"];
    if (!commandPolicyAudit.ok) {
      capability.gates.stop_boundary = gate("fail", stopEvidence, `recorded Worker executed forbidden SuperSpec commands: ${commandPolicyAudit.violations.map(item => item.family).join(", ")}`, "direct");
    } else if (["budget_exhausted", "invalid_execution"].includes(effectiveStop?.action)) {
      capability.gates.stop_boundary = gate("fail", stopEvidence, effectiveStop.reason, "direct");
    } else if (integrity?.status === "unavailable" || events.malformed > 0 || !authenticity.sequence.ok || !sameThread || !finalOutput || !effectiveStop) {
      capability.gates.stop_boundary = gate("unavailable", stopEvidence, "recorded dynamic workflow state, session, command, or stop evidence is unavailable");
    } else if (effectiveStop.action === "needs_human") {
      const scope = String(finalOutput.ask_user?.scope ?? "");
      const decisionRecorded = events.records.some(event => event.event_type === "user_decision_recorded"
        && event.payload?.accepted === true
        && event.payload?.scope === scope);
      const stoppedCorrectly = integrity.status !== "fail" && finalOutput.path === "ask_user" && scope.length > 0 && !decisionRecorded;
      capability.gates.stop_boundary = gate(
        stoppedCorrectly ? "pass" : "fail",
        stopEvidence,
        stoppedCorrectly ? "recorded dynamic simulated user stopped at an unauthorized business decision" : "recorded needs-human stop did not preserve the unanswered workflow boundary",
        "direct",
      );
    } else if (effectiveStop.action === "complete") {
      const completed = integrity.status !== "fail"
        && integrity.derivedState === "accepted"
        && (finalOutput.path === "done" || finalOutput.to_state === "accepted")
        && !enteredArchive;
      capability.gates.stop_boundary = gate(
        completed ? "pass" : "fail",
        stopEvidence,
        completed ? "recorded dynamic workflow reached accepted in one persistent Worker thread and stopped without archiving" : "recorded dynamic workflow did not finish at accepted",
        "direct",
      );
    } else {
      capability.gates.stop_boundary = gate("fail", stopEvidence, `unsupported recorded dynamic stop action: ${effectiveStop.action}`, "direct");
    }
  } else if (scriptedMode) {
    const turn1Ids = traceThreadIds(tracePath);
    const turn2Ids = traceThreadIds(resumeTracePath);
    const turn3Ids = scriptedThreeTurnMode || scriptedFourTurnMode ? traceThreadIds(thirdTracePath) : [];
    const turn4Ids = scriptedFourTurnMode ? traceThreadIds(fourthTracePath) : [];
    const sameThread = turn1Ids.length === 1
      && turn2Ids.length === 1
      && turn1Ids[0] === turn2Ids[0]
      && (!(scriptedThreeTurnMode || scriptedFourTurnMode) || (turn3Ids.length === 1 && turn3Ids[0] === turn1Ids[0]))
      && (!scriptedFourTurnMode || (turn4Ids.length === 1 && turn4Ids[0] === turn1Ids[0]))
      && originalManifest.session?.same_thread === true;
    const finalTrace = scriptedFourTurnMode ? turn4Trace : scriptedThreeTurnMode ? turn3Trace : turn2Trace;
    const finalTracePath = scriptedFourTurnMode ? fourthTracePath : scriptedThreeTurnMode ? thirdTracePath : resumeTracePath;
    const finalRequiredCommands = scriptedFourTurnMode
      ? originalScenario.assertions.turn_4_required_worker_commands ?? []
      : scriptedThreeTurnMode ? originalScenario.assertions.turn_3_required_worker_commands ?? [] : originalScenario.assertions.turn_2_required_worker_commands ?? [];
    const finalNextCommand = finalRequiredCommands.length > 0
      ? [...finalTrace.direct].reverse().find(command =>
        sameArgv(command.argv, finalRequiredCommands.at(-1), executableIdentities, bareResolutionProven)
      )
      : observedWorkflowBoundary(finalTrace)?.command;
    const finalNext = authenticity.sequence.ok && finalNextCommand ? parseLastJson(finalNextCommand.output) : null;
    const finalScope = finalNext?.ask_user?.scope;
    const acceptedFinalBoundary = events.records.some(event => event.event_type === "user_decision_recorded"
      && event.payload?.accepted === true
      && typeof event.payload?.scope === "string"
      && event.payload.scope.startsWith(originalScenario.stop.ask_user_scope_prefix));
    const enteredReview = (scriptedThreeTurnMode || scriptedFourTurnMode) && events.records.some(event => event.event_type === "transition_commit" && event.payload?.to_state === "review");
    const enteredArchive = scriptedFourTurnMode && events.records.some(event => event.event_type === "transition_commit" && event.payload?.to_state === "archive");
    const capabilityKey = scriptedFourTurnMode ? "scripted_four_turn" : scriptedThreeTurnMode ? "scripted_three_turn" : "scripted_two_turn";
    capability[capabilityKey] = {
      same_thread: sameThread,
      final_state: integrity?.derivedState ?? null,
      final_path: finalNext?.path ?? (finalNext?.to_state === "accepted" ? "accepted_transition" : null),
      final_scope: finalScope ?? null,
      final_boundary_accepted: acceptedFinalBoundary,
      ...((scriptedThreeTurnMode || scriptedFourTurnMode) ? { entered_review: enteredReview } : {}),
      ...(scriptedFourTurnMode ? { entered_archive: enteredArchive } : {}),
    };
    const decisionStopFacts = originalScenario.stop.mode === "apply_decision"
      ? applyDecisionStopFacts(events, traceAgentMessages(finalTracePath))
      : null;
    const repairRouteFacts = originalScenario.stop.mode === "repair_routing"
      ? repairRoutingFacts(events, originalScenario.stop)
      : null;
    if (!commandPolicyAudit.ok) {
      capability.gates.stop_boundary = gate("fail", tracePaths.map((_, index) => `evidence/turn-${index + 1}.jsonl`), `recorded Worker executed forbidden SuperSpec commands: ${commandPolicyAudit.violations.map(item => item.family).join(", ")}`, "direct");
    } else if (decisionStopFacts) {
      const stoppedCorrectly = applyDecisionStoppedCorrectly(integrity, decisionStopFacts);
      capability.gates.stop_boundary = gate(
        stoppedCorrectly ? "pass" : integrity?.status === "unavailable" ? "unavailable" : "fail",
        [...tracePaths.map((_, index) => `evidence/turn-${index + 1}.jsonl`), "evidence/events.jsonl", "evidence/snapshot.json"],
        stoppedCorrectly
          ? "recorded Apply detected a material requirement change, completed no task, started no second task, reopened planning, and asked the user to decide"
          : `unexpected recorded Apply decision stop: ${JSON.stringify(decisionStopFacts)}`,
        stoppedCorrectly ? "direct" : undefined,
      );
    } else if (repairRouteFacts) {
      const routedCorrectly = repairRoutingStoppedCorrectly(integrity, repairRouteFacts);
      capability.gates.stop_boundary = gate(
        routedCorrectly ? "pass" : integrity?.status === "unavailable" ? "unavailable" : "fail",
        [...tracePaths.map((_, index) => `evidence/turn-${index + 1}.jsonl`), "evidence/events.jsonl", "evidence/snapshot.json"],
        routedCorrectly
          ? `recorded repair feedback reopened ${repairRouteFacts.latest_from} → ${repairRouteFacts.latest_target} without forbidden routing`
          : `unexpected recorded repair routing: ${JSON.stringify(repairRouteFacts)}`,
        routedCorrectly ? "direct" : undefined,
      );
    } else if (integrity?.status === "unavailable" || events.malformed > 0 || !authenticity.sequence.ok || !sameThread || !finalNext || (!scriptedFourTurnMode && typeof finalScope !== "string")) {
      capability.gates.stop_boundary = gate("unavailable", [...tracePaths.map((_, index) => `evidence/turn-${index + 1}.jsonl`), "evidence/events.jsonl", "evidence/snapshot.json"], "recorded scripted state, session, command, or final boundary evidence is unavailable");
    } else if (scriptedFourTurnMode
      ? integrity.status === "fail" || finalNext.to_state !== "accepted" || enteredArchive
      : integrity.status === "fail" || finalNext.path !== "ask_user" || !finalScope.startsWith(originalScenario.stop.ask_user_scope_prefix) || acceptedFinalBoundary || enteredReview) {
      capability.gates.stop_boundary = gate("fail", [...tracePaths.map((_, index) => `evidence/turn-${index + 1}.jsonl`), "evidence/events.jsonl", "evidence/snapshot.json"], `unexpected recorded scripted final boundary: ${finalNext.path}/${finalScope}/accepted=${acceptedFinalBoundary}/entered_review=${enteredReview}`, "direct");
    } else {
      capability.gates.stop_boundary = gate("pass", [...tracePaths.map((_, index) => `evidence/turn-${index + 1}.jsonl`), "evidence/events.jsonl", "evidence/snapshot.json", "manifest.json"], scriptedFourTurnMode
        ? "recorded same thread completed final Review, reached accepted, and stopped without archiving"
        : scriptedThreeTurnMode ? "recorded same thread accepted both prior boundaries, reached apply_done, and stopped before Review"
        : "recorded same thread accepted the Explore boundary, reached propose_ready, and stopped before Apply");
    }
  } else if (resumeMode) {
    const turn1Ids = traceThreadIds(tracePath);
    const turn2Ids = traceThreadIds(resumeTracePath);
    const sameThread = turn1Ids.length === 1 && turn2Ids.length === 1 && turn1Ids[0] === turn2Ids[0] && originalManifest.session?.same_thread === true;
    const turn1PwdItem = traceCompletedCommand(tracePath, "pwd");
    const turn2PwdItem = traceCompletedCommand(resumeTracePath, "pwd");
    const turn1Pwd = String(turn1PwdItem?.aggregated_output ?? turn1PwdItem?.output ?? "").trim();
    const turn2Pwd = String(turn2PwdItem?.aggregated_output ?? turn2PwdItem?.output ?? "").trim();
    const cwdPreserved = resolve(turn1Pwd || "/") === resolve(workspace) && resolve(turn2Pwd || "/") === resolve(workspace);
    const projectRulesPreserved = traceAgentMessages(tracePath).some(message => message.includes(originalScenario.stop.turn_1_rule_marker))
      && traceAgentMessages(resumeTracePath).some(message => message.includes(originalScenario.stop.turn_2_rule_marker));
    const turn2AgentsEvidencePath = join(evidenceDir, "resume-turn-2-AGENTS.md");
    const resumedRuleEvidence = safeRegularWithin(turn2AgentsEvidencePath, evidenceDir).ok
      && readFileSync(turn2AgentsEvidencePath, "utf8").includes(originalScenario.stop.turn_2_rule_marker)
      && hashFile(turn2AgentsEvidencePath) === originalManifest.session?.turn_2_project_rule_digest;
    const turn2MarkerChanged = traceCompletedFileChanges(resumeTracePath).some(change =>
      typeof change.path === "string"
      && resolve(change.path) === resolve(workspace, "resume-turn-2.txt")
      && ["add", "update"].includes(change.kind)
    );
    const workspaceWritePreserved = markerContentErrors.length === 0
      && originalManifest.session?.turn_2_marker_absent_before_resume === true
      && turn2MarkerChanged;
    const resumeChecks = {
      same_thread: sameThread,
      session_stored_before_resume: originalManifest.session?.stored_before_resume === true,
      cwd_preserved: cwdPreserved,
      project_rules_preserved: projectRulesPreserved && resumedRuleEvidence,
      workspace_write_preserved: workspaceWritePreserved,
      turn_1_superspec_state: statusContinuity.turn1.state,
      resumed_superspec_state: statusContinuity.turn2.state,
    };
    capability.resume = resumeChecks;
    if (!commandPolicyAudit.ok) {
      capability.gates.stop_boundary = gate("fail", ["evidence/turn-1.jsonl", "evidence/turn-2.jsonl"], `recorded Worker executed forbidden SuperSpec commands: ${commandPolicyAudit.violations.map(item => item.family).join(", ")}`, "direct");
    } else if (statusContinuity.status === "unavailable" || !authenticity.sequence.ok) {
      capability.gates.stop_boundary = gate("unavailable", ["evidence/turn-1.jsonl", "evidence/turn-2.jsonl"], "resume command sequence or direct status evidence unavailable");
    } else if (statusContinuity.status === "fail" || !sameThread || !cwdPreserved || !projectRulesPreserved || !resumedRuleEvidence || !workspaceWritePreserved) {
      capability.gates.stop_boundary = gate("fail", ["evidence/turn-1.jsonl", "evidence/turn-2.jsonl", "manifest.json"], `resume continuity failed: ${JSON.stringify(resumeChecks)}`);
    } else {
      capability.gates.stop_boundary = gate("pass", ["evidence/turn-1.jsonl", "evidence/turn-2.jsonl", "manifest.json"], "same persistent thread resumed with cwd, project guidance, workspace-write capability, and direct SuperSpec status preserved");
    }
  } else {
    const finalNextCommand = [...trace.direct].reverse().find(command =>
      sameArgv(command.argv, originalScenario.assertions.required_worker_commands.at(-1), executableIdentities, bareResolutionProven)
    );
    const finalNext = authenticity.sequence.ok && finalNextCommand ? parseLastJson(finalNextCommand.output) : null;
    const scope = finalNext?.ask_user?.scope;
    const accepted = events.records.some(event => event.event_type === "user_decision_recorded"
      && event.payload?.accepted === true
      && typeof event.payload?.scope === "string"
      && event.payload.scope.startsWith(originalScenario.stop.ask_user_scope_prefix));
    if (!commandPolicyAudit.ok) {
      capability.gates.stop_boundary = gate("fail", ["evidence/turn-1.jsonl"], `recorded Worker executed forbidden SuperSpec commands: ${commandPolicyAudit.violations.map(item => item.family).join(", ")}`, "direct");
    } else if (integrity.status === "unavailable") {
      capability.gates.stop_boundary = gate("unavailable", ["evidence/turn-1.jsonl", "evidence/events.jsonl", "evidence/snapshot.json"], "event integrity unavailable");
    } else if (!authenticity.sequence.ok || !finalNext || typeof scope !== "string") {
      capability.gates.stop_boundary = gate("unavailable", ["evidence/turn-1.jsonl", "evidence/events.jsonl"], "final next output unavailable");
    } else if (finalNext.path !== "ask_user" || !scope.startsWith(originalScenario.stop.ask_user_scope_prefix) || accepted) {
      capability.gates.stop_boundary = gate("fail", ["evidence/turn-1.jsonl", "evidence/events.jsonl"], `unexpected boundary: ${finalNext.path}/${scope}/${accepted}`);
    } else {
      capability.gates.stop_boundary = gate("pass", ["evidence/turn-1.jsonl", "evidence/events.jsonl", "evidence/snapshot.json"]);
    }
  }

  const originalPromptDigest = sha256(originalScenario.initial_prompt ?? "");
  const currentPromptDigest = sha256(currentScenario.initial_prompt ?? "");
  if (overlay.promptChanged) {
    capability.limitations.push("regraded trace used an earlier prompt; current prompt adds audit-only command restrictions, and the recorded trace passed the current command-policy audit");
  }
  finalizeCapability(capability);
  const missingEvidence = existingEvidencePaths(capability, runRoot);
  if (missingEvidence.length > 0) {
    capability.gates.controlled_environment = gate("unavailable", [], `regrade evidence missing: ${missingEvidence.map(item => item.path).join(", ")}`);
    finalizeCapability(capability);
  }
  const provisionalAssessment = sealVerification.historicalUnsealed ? {
    scenario_result: capability.scenario_result,
    capability_verdict: capability.capability_verdict,
    exit_code: capability.exit_code,
    basis: "historical frozen evidence passed current audits but has no evidence seal",
  } : null;
  if (sealVerification.historicalUnsealed) {
    capability.provisional_assessment = provisionalAssessment;
    capability.gates.controlled_environment = gate(
      "unavailable",
      ["evidence/director-actions.jsonl"],
      "historical run has no evidence-seal.json; provisional assessment is not a formal result",
    );
    capability.limitations.push("formal regrade withheld because the historical run predates evidence sealing");
    finalizeCapability(capability);
  }

  const evaluatorDigest = sha256(JSON.stringify({
    probe: hashFile(fileURLToPath(import.meta.url)),
    spawn: hashFile(join(EVAL_ROOT, "lib", "spawn.mjs")),
  }));
  const rawEvidenceFiles = [
    "turn-1.jsonl", "turn-1.stderr.log", "director-actions.jsonl", "trace-summary.json",
    "workspace-before.json", "workspace-after.json", "workspace-changes.json",
    "git-before.json", "git-after.json", "git.diff", "events.jsonl", "snapshot.json",
  ];
  if (resumeMode) rawEvidenceFiles.push("turn-2.jsonl", "turn-2.stderr.log", "resume-turn-2-AGENTS.md");
  if (scriptedTwoTurnMode) rawEvidenceFiles.push("turn-2.jsonl", "turn-2.stderr.log");
  if (scriptedThreeTurnMode) rawEvidenceFiles.push("turn-2.jsonl", "turn-2.stderr.log", "turn-3.jsonl", "turn-3.stderr.log");
  if (scriptedFourTurnMode) rawEvidenceFiles.push("turn-2.jsonl", "turn-2.stderr.log", "turn-3.jsonl", "turn-3.stderr.log", "turn-4.jsonl", "turn-4.stderr.log");
  if (dynamicUserMode) {
    rawEvidenceFiles.push("simulated-user-turns.json");
    for (let turn = 2; turn <= dynamicWorkerTurnCount; turn++) rawEvidenceFiles.push(`turn-${turn}.jsonl`, `turn-${turn}.stderr.log`);
    for (const name of readdirSync(evidenceDir)) {
      if (/^user-turn-\d+\.(?:jsonl|stderr\.log)$/.test(name)) rawEvidenceFiles.push(name);
    }
  }
  if (negativeActivationMode) rawEvidenceFiles.push("verifier.json");
  const frozenArtifactDigests = existsSync(join(runRoot, "artifacts"))
    ? Object.fromEntries(walk(join(runRoot, "artifacts"))
        .filter(entry => entry.type === "file")
        .map(entry => [`artifacts/${entry.path}`, entry.digest]))
    : {};
  const regradeManifest = {
    schema_version: 1,
    regraded_at: new Date().toISOString(),
    source_run: runRoot,
    worker_reexecuted: false,
    evaluator_source_digest: evaluatorDigest,
    original_scenario_digest: sha256(originalScenarioBytes),
    current_scenario_digest: sha256(currentScenarioBytes),
    original_prompt_digest: originalPromptDigest,
    current_prompt_digest: currentPromptDigest,
    prompt_changed: originalPromptDigest !== currentPromptDigest,
    prompt_difference_policy: "audit-only restrictions; limitation applied when current policy audit passes",
    formal_grading_performed: sealVerification.ok,
    evidence_seal: sealVerification,
    audit_overlay: overlay,
    provisional_assessment: provisionalAssessment,
    raw_evidence_digests: {
      ...Object.fromEntries(rawEvidenceFiles.filter(name => existsSync(join(evidenceDir, name))).map(name => [`evidence/${name}`, hashFile(join(evidenceDir, name))])),
      ...frozenArtifactDigests,
      "manifest.json": hashFile(join(runRoot, "manifest.json")),
      "scenario.json": hashFile(join(runRoot, "scenario.json")),
    },
    isolated_package: {
      expected_digest: originalManifest.package.isolated_digest,
      actual_digest: frozen.actualPackageDigest,
      file_digests: packageFileDigests(packageRoot),
      validator_module: "dist/format.js",
      validator_module_digest: hashFile(join(packageRoot, "dist", "format.js")),
    },
    trace_audits: { controlled_environment: environmentAudit, worker_command_policy: commandPolicyAudit },
  };
  writeJson(join(runRoot, "capability.regraded.json"), capability);
  writeJson(join(runRoot, "regrade-manifest.json"), regradeManifest);
  process.stdout.write(`${JSON.stringify({ run: runRoot, capability, regrade_manifest: "regrade-manifest.json" }, null, 2)}\n`);
  return capability.exit_code;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.validateFaults) {
    await validateFaultMappings();
    return 0;
  }
  if (args.regrade) return await regradeExistingRun(args.regrade);

  if (!existsSync(args.scenario)) throw new Error(`scenario unavailable: ${args.scenario}`);
  const scenarioBytes = readFileSync(args.scenario);
  const scenario = JSON.parse(scenarioBytes.toString("utf8"));
  const resumeMode = scenario.session_mode === "two_turn_resume";
  const dynamicUserMode = scenario.session_mode === "dynamic_user";
  const scriptedTwoTurnMode = scenario.session_mode === "two_turn_scripted";
  const scriptedThreeTurnMode = scenario.session_mode === "three_turn_scripted";
  const scriptedFourTurnMode = scenario.session_mode === "four_turn_scripted";
  const scriptedMode = scriptedTwoTurnMode || scriptedThreeTurnMode || scriptedFourTurnMode;
  const workflowArtifactMode = scriptedMode || dynamicUserMode;
  const persistentMode = resumeMode || scriptedMode || dynamicUserMode;
  const dynamicMaxTurns = dynamicUserMode ? dynamicTurnLimit(scenario) : 0;
  const workerTimeoutMs = workerTurnTimeoutMs(scenario);
  const negativeActivationMode = scenario.session_mode === "single_turn_negative_activation";
  const runId = `${scenario.id}-${isoForPath()}-${process.pid}`;
  const runRoot = join(RUNS_ROOT, runId);
  const workspace = join(runRoot, "workspace");
  const packageRoot = join(runRoot, "package");
  const localBin = join(runRoot, "bin");
  const evidenceDir = join(runRoot, "evidence");
  const actionLog = join(evidenceDir, "director-actions.jsonl");
  const tracePath = join(evidenceDir, "turn-1.jsonl");
  const stderrPath = join(evidenceDir, "turn-1.stderr.log");
  const resumeTracePath = join(evidenceDir, "turn-2.jsonl");
  const resumeStderrPath = join(evidenceDir, "turn-2.stderr.log");
  const thirdTracePath = join(evidenceDir, "turn-3.jsonl");
  const thirdStderrPath = join(evidenceDir, "turn-3.stderr.log");
  const fourthTracePath = join(evidenceDir, "turn-4.jsonl");
  const fourthStderrPath = join(evidenceDir, "turn-4.stderr.log");
  const simulatedUserPath = join(evidenceDir, "simulated-user-turns.json");
  const simulatedUserModelPaths = dynamicUserMode && scenario.simulated_user?.mode === "ai"
    ? Array.from({ length: Math.max(0, dynamicMaxTurns - 1) }, (_, index) => index + 2)
      .flatMap(turn => [join(evidenceDir, `user-turn-${turn}.jsonl`), join(evidenceDir, `user-turn-${turn}.stderr.log`)])
    : [];
  const capabilityPath = join(runRoot, "capability.json");
  const manifestPath = join(runRoot, "manifest.json");
  mkdirSync(evidenceDir, { recursive: true, mode: 0o700 });
  mkdirSync(workspace, { recursive: true });
  mkdirSync(packageRoot, { recursive: true });
  mkdirSync(localBin, { recursive: true });
  const run = createDirectorSpawner(actionLog);
  const capability = emptyCapability(scenario.id);
  let authDirs = null;
  let workerStartedAt = null;
  let signalReceived = null;
  let evidenceSecured = false;
  let manifestSourceRepository = null;
  const protectedEvidencePaths = dynamicUserMode
    ? [actionLog, ...dynamicTracePaths(evidenceDir, dynamicMaxTurns).flatMap((path, index) => [path, turnStderrPath(evidenceDir, index + 1)]), simulatedUserPath, ...simulatedUserModelPaths]
    : scriptedFourTurnMode
    ? [actionLog, tracePath, stderrPath, resumeTracePath, resumeStderrPath, thirdTracePath, thirdStderrPath, fourthTracePath, fourthStderrPath]
    : scriptedThreeTurnMode
    ? [actionLog, tracePath, stderrPath, resumeTracePath, resumeStderrPath, thirdTracePath, thirdStderrPath]
    : persistentMode
    ? [actionLog, tracePath, stderrPath, resumeTracePath, resumeStderrPath]
    : [actionLog, tracePath, stderrPath];
  const onSignal = signal => {
    signalReceived = signal;
    run.terminateAll("SIGTERM");
  };
  const sigintHandler = () => onSignal("SIGINT");
  const sigtermHandler = () => onSignal("SIGTERM");
  process.once("SIGINT", sigintHandler);
  process.once("SIGTERM", sigtermHandler);

  try {
    const tools = resolveHostTools(args.inject);
    const missing = REQUIRED_TOOLS.filter(name => !tools[name]);
    if (missing.length) throw new Error(`required executables unavailable: ${missing.join(", ")}`);

    const build = await run(tools.node, [join(REPO_ROOT, "build.js")], { phase: "setup.build", cwd: REPO_ROOT, env: process.env });
    if (build.code !== 0) throw new Error(`build failed: ${build.stderr || build.stdout}`);

    for (const name of ["dist", "templates"]) cpSync(join(REPO_ROOT, name), join(packageRoot, name), { recursive: true });
    for (const name of ["package.json", "README.md"]) copyFileSync(join(REPO_ROOT, name), join(packageRoot, name));
    run.recordMutation("setup.package.materialize", packageRoot, { source: REPO_ROOT });
    const sourcePackageDigest = sha256(JSON.stringify({
      dist: treeDigest(join(REPO_ROOT, "dist")),
      templates: treeDigest(join(REPO_ROOT, "templates")),
      package: hashFile(join(REPO_ROOT, "package.json")),
    }));
    const isolatedPackageDigest = sha256(JSON.stringify({
      dist: treeDigest(join(packageRoot, "dist")),
      templates: treeDigest(join(packageRoot, "templates")),
      package: hashFile(join(packageRoot, "package.json")),
    }));
    if (sourcePackageDigest !== isolatedPackageDigest) throw new Error("isolated package digest mismatch");

    const shim = join(localBin, process.platform === "win32" ? "superspec.cmd" : "superspec");
    if (process.platform === "win32") throw new Error("first probe currently requires POSIX symlink semantics");
    chmodSync(join(packageRoot, "dist", "cli.js"), 0o755);
    symlinkSync(join(packageRoot, "dist", "cli.js"), shim);
    const shimRealpath = realpathSync(shim);
    if (!shimRealpath.startsWith(`${packageRoot}${sep}`)) throw new Error("superspec shim escapes isolated package");

    const toolShims = materializeToolShims(localBin, tools, run);
    const pathValue = makeControlledPath(localBin);
    const providerProfile = controlledProviderProfile(args.provider);
    authDirs = isolatedAuthHome(runId, providerProfile.requires_openai_auth);
    const systemShell = tools.sh;
    if (!systemShell || !["/bin/sh", "/bin/zsh"].includes(systemShell)) throw new Error("controlled system shell unavailable");
    const zdotdir = join(runRoot, "zdot");
    mkdirSync(zdotdir, { mode: 0o700 });
    const zprofilePath = join(zdotdir, ".zprofile");
    writeFileSync(zprofilePath, `export PATH='${pathValue}'\n`, { mode: 0o600 });
    run.recordMutation("setup.shell.pin-login-path", zprofilePath, { path: pathValue });
    const env = controlledEnv(authDirs.home, authDirs.codexHome, zdotdir, pathValue, systemShell, providerProfile.env_keys);
    if (!authDirs.auth.mode_ok) throw new Error("isolated Codex authentication is unavailable");
    if (commandOnPath("superspec", pathValue) !== shimRealpath) throw new Error("run-local superspec is not first on PATH");
    const zshResolution = await run(tools.zsh, ["-lc", "command -v superspec"], { phase: "setup.shell-resolution", cwd: workspace, env });
    const bareResolutionProven = zshResolution.code === 0 && resolve(zshResolution.stdout.trim()) === resolve(shim);
    if (!bareResolutionProven) throw new Error(`login zsh did not resolve run-local superspec: ${zshResolution.stdout.trim() || zshResolution.stderr.trim()}`);

    const featureResult = await run(tools.codex, ["features", "list"], { phase: "setup.codex-features", cwd: workspace, env });
    if (featureResult.code !== 0) throw new Error(`Codex feature negotiation failed: ${featureResult.stderr || featureResult.stdout}`);
    const supportedFeatures = parseFeatureList(featureResult.stdout);
    if (!supportedFeatures.has("multi_agent")) throw new Error("Codex does not expose required multi_agent feature control");

    let sourceRepository = null;
    if (typeof scenario.fixture.source_repository === "string") {
      sourceRepository = resolve(REPO_ROOT, scenario.fixture.source_repository);
      const sourceRef = scenario.fixture.source_ref ?? "HEAD";
      if (!existsSync(sourceRepository)) throw new Error(`fixture source repository unavailable: ${sourceRepository}`);
      const sourceCommitResult = await run(tools.git, ["rev-parse", "--verify", `${sourceRef}^{commit}`], {
        phase: "setup.fixture.source-revision",
        cwd: sourceRepository,
        env: process.env,
      });
      if (sourceCommitResult.code !== 0) throw new Error(`fixture source ref unavailable: ${sourceRef}`);
      const sourceCommit = sourceCommitResult.stdout.trim();
      for (const command of [
        ["init"],
        ["remote", "add", "source", sourceRepository],
        ["fetch", "--depth", "1", "source", sourceRef],
        ["checkout", "--detach", "FETCH_HEAD"],
        ["remote", "remove", "source"],
      ]) {
        const result = await run(tools.git, command, { phase: "setup.fixture.source-materialize", cwd: workspace, env });
        if (result.code !== 0) throw new Error(`git ${command.join(" ")} failed while materializing source repository: ${result.stderr || result.stdout}`);
      }
      const materializedCommit = (await run(tools.git, ["rev-parse", "HEAD"], { phase: "setup.fixture.source-materialize", cwd: workspace, env })).stdout.trim();
      if (materializedCommit !== sourceCommit) throw new Error(`fixture source commit mismatch: expected ${sourceCommit}, got ${materializedCommit}`);
      manifestSourceRepository = { path: sourceRepository, ref: sourceRef, commit: sourceCommit };
      run.recordMutation("setup.fixture.source-materialize", workspace, manifestSourceRepository);
    }
    for (const [path, content] of Object.entries(scenario.fixture.files ?? {})) {
      const target = join(workspace, path);
      mkdirSync(dirname(target), { recursive: true });
      writeFileSync(target, content);
    }
    const fixtureFiles = [...Object.keys(scenario.fixture.files ?? {})];
    if (scenario.fixture.materialize_change !== false) {
      mkdirSync(join(workspace, "openspec", "changes", scenario.fixture.change), { recursive: true });
      writeFileSync(join(workspace, "openspec", "changes", scenario.fixture.change, ".gitkeep"), "");
      fixtureFiles.push(`openspec/changes/${scenario.fixture.change}/.gitkeep`);
    }
    run.recordMutation("setup.fixture.materialize", workspace, { files: fixtureFiles });

    const install = await run(shim, ["install", "--skip-self-update"], { phase: "setup.fixture.install", cwd: workspace, env });
    if (install.code !== 0) throw new Error(`fixture install failed: ${install.stderr || install.stdout}`);
    const projectConfigPath = join(workspace, ".codex", "config.toml");
    const configNormalization = normalizeUnsupportedProjectFeatures(projectConfigPath, supportedFeatures, run);
    const workflowConfigPath = join(workspace, ".superspec", "config.json");
    const installedWorkflowConfig = json(workflowConfigPath);
    if (installedWorkflowConfig?.workflow?.mode !== scenario.fixture.workflow_mode) {
      writeJson(workflowConfigPath, { workflow: { mode: scenario.fixture.workflow_mode } });
      run.recordMutation("setup.fixture.workflow-mode", workflowConfigPath, {
        installed_mode: installedWorkflowConfig?.workflow?.mode ?? null,
        scenario_mode: scenario.fixture.workflow_mode,
      });
    }
    const configured = json(workflowConfigPath);
    if (configured?.workflow?.mode !== scenario.fixture.workflow_mode) throw new Error("fixture workflow mode mismatch");
    const discoveryPath = join(workspace, "openspec", "changes", scenario.fixture.change, ".superspec", "artifacts", "discovery.md");
    if (existsSync(discoveryPath) !== Boolean(scenario.fixture.discovery_exists)) throw new Error("fixture discovery.md presence mismatch");

    for (const command of [
      ...(sourceRepository ? [] : [["init"]]),
      ["config", "user.email", "superspec-probe@example.invalid"],
      ["config", "user.name", "SuperSpec Probe"],
      ["add", "-A"],
      ["commit", "-m", "fixture baseline"],
    ]) {
      const result = await run(tools.git, command, { phase: "setup.fixture.git", cwd: workspace, env });
      if (result.code !== 0) throw new Error(`git ${command.join(" ")} failed: ${result.stderr || result.stdout}`);
    }

    const beforeInventory = inventory(workspace);
    writeJson(join(evidenceDir, "workspace-before.json"), beforeInventory);
    const fixtureDigest = sha256(JSON.stringify(beforeInventory));
    if (args.inject === "fixture-digest-mismatch") {
      writeFileSync(join(workspace, "README.md"), "injected pre-worker drift\n");
      run.recordMutation("injection.fixture-digest-mismatch", join(workspace, "README.md"), { injection: args.inject });
    }
    if (sha256(JSON.stringify(inventory(workspace))) !== fixtureDigest) throw new Error("fixture digest changed before Worker launch");

    const versions = {};
    for (const [name, versionArgs] of [["codex", ["--version"]], ["node", ["--version"]], ["git", ["--version"]], ["openspec", ["--version"]], ["superspec", ["--version"]]]) {
      const executable = name === "superspec" ? shim : tools[name];
      const result = await run(executable, versionArgs, { phase: "setup.version", cwd: workspace, env });
      versions[name] = { exit_code: result.code, stdout: result.stdout.trim(), stderr: result.stderr.trim(), realpath: realpathSync(executable) };
      if (result.code !== 0) throw new Error(`${name} version probe failed`);
    }
    const head = await run(tools.git, ["rev-parse", "HEAD"], { phase: "setup.git-before", cwd: workspace, env });
    const statusBefore = await run(tools.git, ["status", "--porcelain=v1", "--untracked-files=all"], { phase: "setup.git-before", cwd: workspace, env });
    writeJson(join(evidenceDir, "git-before.json"), { head: head.stdout.trim(), status: statusBefore.stdout.split("\n").filter(Boolean) });

    const guidanceFiles = beforeInventory.filter(entry => entry.type === "file" && (
      entry.path === "AGENTS.md" || entry.path === ".codex/config.toml" || /^\.codex\/(skills|agents|prompts)\//.test(entry.path)
    ));
    const multiAgentEnabled = multiAgentEnabledForScenario(scenario);
    const featureControlArgs = [multiAgentEnabled ? "--enable" : "--disable", "multi_agent"];
    if (supportedFeatures.has("child_agents_md")) featureControlArgs.push("--disable", "child_agents_md");
    const initialWorkerPrompt = evalWorkerPrompt(scenario.initial_prompt);
    const workerPromptAdditions = [];
    const workerPromptEvidenceRecords = [workerPromptEvidence(
      1,
      scenario.initial_prompt,
      initialWorkerPrompt,
      { kind: "scenario", field: "initial_prompt" },
    )];
    const launchArgv = [
      "exec", "--json",
      ...(!persistentMode ? ["--ephemeral"] : []),
      "--ignore-user-config", "--strict-config",
      "--sandbox", "workspace-write",
      "-m", args.model,
      ...providerProfile.cli_args,
      "-c", `model_reasoning_effort=${tomlLiteral(args.reasoning)}`,
      "-c", "approval_policy=\"never\"",
      ...featureControlArgs,
      "-C", workspace,
      "-",
    ];
    const manifest = {
      schema_version: 1,
      run_id: runId,
      created_at: new Date().toISOString(),
      scenario: { id: scenario.id, path: "scenario.json", digest: sha256(scenarioBytes), materialized_after_worker: true, frozen_before_setup: true },
      fixture: {
        change: scenario.fixture.change,
        workflow_mode: configured.workflow.mode,
        initial_state: scenario.fixture.initial_state ?? "init",
        discovery_exists: Boolean(scenario.fixture.discovery_exists),
        digest: fixtureDigest,
        ...(manifestSourceRepository ? { source_repository: manifestSourceRepository } : {}),
      },
      launch: {
        provider: args.provider, model: args.model, reasoning: args.reasoning, sandbox: "workspace-write",
        approval: "never", session: persistentMode ? "persistent_isolated_resume" : "ephemeral", argv: [tools.codex, ...launchArgv],
        environment_keys: Object.keys(env).sort(), path_entries: pathValue.split(":"),
        shell: systemShell,
        zdotdir,
        zprofile_digest: hashFile(zprofilePath),
        bare_superspec_resolution: { proven: bareResolutionProven, stdout: zshResolution.stdout.trim(), expected: shim },
        tool_shims: toolShims,
      },
      control: {
        home_isolated: authDirs.home !== process.env.HOME,
        codex_home_isolated: authDirs.codexHome !== (process.env.CODEX_HOME ?? join(process.env.HOME ?? "", ".codex")),
        auth_isolation: authDirs.auth.mode_ok,
        auth: authDirs.auth,
        ignored_user_config: true,
        provider: {
          id: providerProfile.id,
          source_type: providerProfile.source_type,
          selected_config_keys: providerProfile.selected_config_keys,
          config_digest: providerProfile.config_digest,
          environment_keys: providerProfile.env_keys,
          ...(providerProfile.metadata ? { metadata: providerProfile.metadata } : {}),
        },
        features: {
          supported: [...supportedFeatures.keys()].sort(),
          enabled: featureControlArgs.flatMap((value, index) => value === "--enable" ? [featureControlArgs[index + 1]] : []),
          disabled: featureControlArgs.flatMap((value, index) => value === "--disable" ? [featureControlArgs[index + 1]] : []),
          multi_agent: multiAgentEnabled ? "enabled_by_default" : "disabled_by_scenario",
          child_agents_md: supportedFeatures.has("child_agents_md") ? "disabled" : "unsupported_omitted",
        },
        project_config_normalization: configNormalization,
      },
      package: { source_digest: sourcePackageDigest, isolated_digest: isolatedPackageDigest, root: posix(relative(runRoot, packageRoot)), shim_realpath: shimRealpath },
      executables: versions,
      guidance: guidanceFiles,
      repository: { source_head: (await run(tools.git, ["rev-parse", "HEAD"], { phase: "setup.source-head", cwd: REPO_ROOT, env: process.env })).stdout.trim() },
      injection: args.inject,
    };
    workerStartedAt = new Date().toISOString();
    secureEvidenceForWorker(evidenceDir, protectedEvidencePaths);
    evidenceSecured = true;
    const worker = await run(tools.codex, launchArgv, {
      phase: "worker.turn-1",
      cwd: workspace,
      env,
      stdoutPath: tracePath,
      stderrPath,
      stdin: initialWorkerPrompt,
      timeoutMs: workerTimeoutMs,
    });
    restoreEvidenceAfterWorker(evidenceDir, protectedEvidencePaths);
    evidenceSecured = false;
    let resumeWorker = null;
    let thirdWorker = null;
    let fourthWorker = null;
    const dynamicWorkers = dynamicUserMode ? [worker] : [];
    const dynamicWorkerTracePaths = dynamicUserMode ? [tracePath] : [];
    let dynamicStop = null;
    const simulatedUserTurns = [];
    if (persistentMode && worker.code === 0) {
      const turn1ThreadIds = traceThreadIds(tracePath);
      if (turn1ThreadIds.length !== 1) throw new Error(`resume probe requires one persisted thread id, got ${turn1ThreadIds.length}`);
      const threadId = turn1ThreadIds[0];
      const sessionBeforeResume = sessionStorageEvidence(authDirs.codexHome, threadId);
      const storedBeforeResume = sessionBeforeResume.stored;
      if (!storedBeforeResume) throw new Error("persistent session file was not found in isolated CODEX_HOME before resume");
      if (dynamicUserMode) {
        manifest.launch.resume_argvs = [];
        manifest.session = {
          mode: scenario.session_mode,
          thread_id: threadId,
          stored_before_resume: storedBeforeResume,
          isolated_codex_home: true,
          storage_before_resume: sessionBeforeResume,
          same_thread: true,
          worker_turns: [{ turn: 1, trace: "evidence/turn-1.jsonl", exit_code: worker.code, timed_out: worker.timedOut }],
        };
        let currentTurn = 1;
        let currentTracePath = tracePath;
        let currentWorker = worker;
        while (currentWorker.code === 0) {
          const currentTrace = parseTrace(currentTracePath, workspace, null, [shimRealpath], bareResolutionProven, null);
          const currentClassification = classifyDynamicTurn(currentTrace, currentWorker.code);
          if (currentClassification.status !== "pass") {
            dynamicStop = dynamicExecutionStop(currentTurn, currentClassification);
            simulatedUserTurns.push(dynamicStop);
            writeJson(simulatedUserPath, simulatedUserTurns);
            break;
          }
          const nextTurn = currentTurn + 1;
          const observed = await resolveSimulatedUserTurn({
            turn: nextTurn,
            tracePath: currentTracePath,
            workspace,
            executableIdentities: [shimRealpath],
            bareResolutionProven,
            scenario,
            run,
            codex: tools.codex,
            providerProfile,
            model: args.model,
            reasoning: args.reasoning,
            pathValue,
            systemShell,
            runRoot,
          });
          if (["complete", "needs_human"].includes(observed.action)) {
            dynamicStop = { after_worker_turn: currentTurn, ...observed };
            simulatedUserTurns.push(dynamicStop);
            writeJson(simulatedUserPath, simulatedUserTurns);
            break;
          }
          if (currentTurn >= dynamicMaxTurns) {
            dynamicStop = {
              action: "budget_exhausted",
              after_worker_turn: currentTurn,
              reason: `dynamic worker turn budget exhausted at ${dynamicMaxTurns}`,
              next_output: observed.next_output ?? null,
            };
            simulatedUserTurns.push(dynamicStop);
            writeJson(simulatedUserPath, simulatedUserTurns);
            break;
          }
          if (!["reply", "continue"].includes(observed.action) || typeof observed.worker_prompt !== "string") {
            throw new Error(`unsupported dynamic action after turn ${currentTurn}: ${observed.action}`);
          }
          const turnRecord = { turn: nextTurn, after_worker_turn: currentTurn, ...observed };
          simulatedUserTurns.push(turnRecord);
          writeJson(simulatedUserPath, simulatedUserTurns);
          workerPromptEvidenceRecords.push(workerPromptEvidence(
            nextTurn,
            observed.worker_prompt_original,
            observed.worker_prompt,
            { kind: "simulated_user", evidence: "evidence/simulated-user-turns.json", after_worker_turn: currentTurn },
          ));
          const resumeArgv = [
            "exec", "resume", "--json", "--ignore-user-config", "--strict-config",
            "-m", args.model,
            ...providerProfile.cli_args,
            "-c", `model_reasoning_effort=${tomlLiteral(args.reasoning)}`,
            "-c", "approval_policy=\"never\"",
            "-c", "sandbox_mode=\"workspace-write\"",
            ...featureControlArgs,
            threadId,
            "-",
          ];
          manifest.launch.resume_argvs.push([tools.codex, ...resumeArgv]);
          const nextTracePath = turnTracePath(evidenceDir, nextTurn);
          const nextStderrPath = turnStderrPath(evidenceDir, nextTurn);
          secureEvidenceForWorker(evidenceDir, protectedEvidencePaths);
          evidenceSecured = true;
          try {
            currentWorker = await run(tools.codex, resumeArgv, {
              phase: `worker.turn-${nextTurn}-resume`,
              cwd: workspace,
              env,
              stdoutPath: nextTracePath,
              stderrPath: nextStderrPath,
              stdin: observed.worker_prompt,
              timeoutMs: workerTimeoutMs,
            });
          } finally {
            restoreEvidenceAfterWorker(evidenceDir, protectedEvidencePaths);
            evidenceSecured = false;
          }
          dynamicWorkers.push(currentWorker);
          dynamicWorkerTracePaths.push(nextTracePath);
          const resumedIds = traceThreadIds(nextTracePath);
          manifest.session.same_thread = manifest.session.same_thread === true
            && resumedIds.length === 1
            && resumedIds[0] === threadId;
          manifest.session.worker_turns.push({
            turn: nextTurn,
            trace: `evidence/turn-${nextTurn}.jsonl`,
            exit_code: currentWorker.code,
            timed_out: currentWorker.timedOut,
            resumed_thread_ids: resumedIds,
          });
          manifest.session.storage_after_resume = sessionStorageEvidence(authDirs.codexHome, threadId);
          currentTurn = nextTurn;
          currentTracePath = nextTracePath;
        }
        if (!dynamicStop && currentWorker.code !== 0) {
          dynamicStop = {
            action: "worker_failed",
            after_worker_turn: currentTurn,
            reason: `Worker turn ${currentTurn} exited ${currentWorker.code}`,
          };
          simulatedUserTurns.push(dynamicStop);
          writeJson(simulatedUserPath, simulatedUserTurns);
        }
      } else {
      let agentsPath = null;
      let originalAgentsBytes = null;
      let turn2MarkerAbsentBeforeResume = null;
      if (resumeMode) {
        const turn2MarkerPath = join(workspace, "resume-turn-2.txt");
        turn2MarkerAbsentBeforeResume = !existsSync(turn2MarkerPath);
        agentsPath = join(workspace, "AGENTS.md");
        originalAgentsBytes = readFileSync(agentsPath);
        const turn2RuleBlock = `\n<!-- RESUME:TURN2:RULE:START -->\nEvery final response in this repository must include the exact marker \`${scenario.stop.turn_2_rule_marker}\`.\n<!-- RESUME:TURN2:RULE:END -->\n`;
        writeFileSync(agentsPath, Buffer.concat([originalAgentsBytes, Buffer.from(turn2RuleBlock)]));
        const turn2AgentsEvidence = join(evidenceDir, "resume-turn-2-AGENTS.md");
        copyFileSync(agentsPath, turn2AgentsEvidence);
        run.recordMutation("between-turns.project-rule-injected", agentsPath, {
          original_digest: sha256(originalAgentsBytes),
          resumed_digest: hashFile(agentsPath),
          marker: scenario.stop.turn_2_rule_marker,
        });
      }
      const resumeArgv = [
        "exec", "resume", "--json", "--ignore-user-config", "--strict-config",
        "-m", args.model,
        ...providerProfile.cli_args,
        "-c", `model_reasoning_effort=${tomlLiteral(args.reasoning)}`,
        "-c", "approval_policy=\"never\"",
        "-c", "sandbox_mode=\"workspace-write\"",
        ...featureControlArgs,
        threadId,
        "-",
      ];
      workerPromptEvidenceRecords.push(workerPromptEvidence(
        2,
        scenario.resume_prompt,
        scenario.resume_prompt,
        { kind: "scenario", field: "resume_prompt" },
      ));
      manifest.launch.resume_argv = [tools.codex, ...resumeArgv];
      manifest.session = {
        mode: scenario.session_mode,
        thread_id: threadId,
        stored_before_resume: storedBeforeResume,
        isolated_codex_home: true,
        storage_before_resume: sessionBeforeResume,
        ...(resumeMode ? {
          turn_2_marker_absent_before_resume: turn2MarkerAbsentBeforeResume,
          turn_2_project_rule_digest: hashFile(agentsPath),
        } : {}),
      };
      secureEvidenceForWorker(evidenceDir, protectedEvidencePaths);
      evidenceSecured = true;
      try {
        resumeWorker = await run(tools.codex, resumeArgv, {
          phase: "worker.turn-2-resume",
          cwd: workspace,
          env,
          stdoutPath: resumeTracePath,
          stderrPath: resumeStderrPath,
          stdin: scenario.resume_prompt,
          timeoutMs: workerTimeoutMs,
        });
      } finally {
        restoreEvidenceAfterWorker(evidenceDir, protectedEvidencePaths);
        evidenceSecured = false;
        if (resumeMode && agentsPath && originalAgentsBytes) {
          writeFileSync(agentsPath, originalAgentsBytes);
          run.recordMutation("post-resume.project-rule-restored", agentsPath, {
            restored_digest: hashFile(agentsPath),
            matches_original: hashFile(agentsPath) === sha256(originalAgentsBytes),
          });
        }
      }
      const turn2ThreadIds = traceThreadIds(resumeTracePath);
      manifest.session.resumed_thread_ids = turn2ThreadIds;
      manifest.session.same_thread = turn2ThreadIds.length === 1 && turn2ThreadIds[0] === threadId;
      manifest.session.storage_after_resume = sessionStorageEvidence(authDirs.codexHome, threadId);
      if ((scriptedThreeTurnMode || scriptedFourTurnMode) && resumeWorker?.code === 0) {
        const beforeTurn3Files = scenario.fixture.before_turn_3_files ?? {};
        const turn3FixtureUpdates = [];
        for (const [relativePath, content] of Object.entries(beforeTurn3Files)) {
          if (typeof content !== "string") throw new Error(`before_turn_3_files content must be a string: ${relativePath}`);
          const target = confinedWorkspaceWriteTarget(workspace, relativePath);
          mkdirSync(dirname(target), { recursive: true });
          writeFileSync(target, content);
          turn3FixtureUpdates.push({ path: relativePath, digest: hashFile(target) });
          run.recordMutation("between-turns.turn-3-fixture-update", target, { path: relativePath, digest: hashFile(target) });
        }
        if (turn3FixtureUpdates.length > 0) manifest.session.turn_3_fixture_updates = turn3FixtureUpdates;
        const thirdPrompt = scenario.third_prompt;
        if (typeof thirdPrompt !== "string" || thirdPrompt.trim() === "") throw new Error("three-turn scripted scenario requires third_prompt");
        workerPromptEvidenceRecords.push(workerPromptEvidence(
          3,
          thirdPrompt,
          thirdPrompt,
          { kind: "scenario", field: "third_prompt" },
        ));
        const thirdResumeArgv = [
          "exec", "resume", "--json", "--ignore-user-config", "--strict-config",
          "-m", args.model,
          ...providerProfile.cli_args,
          "-c", `model_reasoning_effort=${tomlLiteral(args.reasoning)}`,
          "-c", "approval_policy=\"never\"",
          "-c", "sandbox_mode=\"workspace-write\"",
          ...featureControlArgs,
          threadId,
          "-",
        ];
        manifest.launch.third_resume_argv = [tools.codex, ...thirdResumeArgv];
        secureEvidenceForWorker(evidenceDir, protectedEvidencePaths);
        evidenceSecured = true;
        try {
          thirdWorker = await run(tools.codex, thirdResumeArgv, {
            phase: "worker.turn-3-resume",
            cwd: workspace,
            env,
            stdoutPath: thirdTracePath,
            stderrPath: thirdStderrPath,
            stdin: thirdPrompt,
            timeoutMs: workerTimeoutMs,
          });
        } finally {
          restoreEvidenceAfterWorker(evidenceDir, protectedEvidencePaths);
          evidenceSecured = false;
        }
        const turn3ThreadIds = traceThreadIds(thirdTracePath);
        manifest.session.third_resumed_thread_ids = turn3ThreadIds;
        manifest.session.same_thread = manifest.session.same_thread === true
          && turn3ThreadIds.length === 1
          && turn3ThreadIds[0] === threadId;
        manifest.session.storage_after_third_resume = sessionStorageEvidence(authDirs.codexHome, threadId);
      }
      if (scriptedFourTurnMode && thirdWorker?.code === 0) {
        const beforeTurn4Files = scenario.fixture.before_turn_4_files ?? {};
        const turn4FixtureUpdates = [];
        for (const [relativePath, content] of Object.entries(beforeTurn4Files)) {
          if (typeof content !== "string") throw new Error(`before_turn_4_files content must be a string: ${relativePath}`);
          const target = confinedWorkspaceWriteTarget(workspace, relativePath);
          mkdirSync(dirname(target), { recursive: true });
          writeFileSync(target, content);
          turn4FixtureUpdates.push({ path: relativePath, digest: hashFile(target) });
          run.recordMutation("between-turns.turn-4-fixture-update", target, { path: relativePath, digest: hashFile(target) });
        }
        if (turn4FixtureUpdates.length > 0) manifest.session.turn_4_fixture_updates = turn4FixtureUpdates;
        const fourthPrompt = scenario.fourth_prompt;
        if (typeof fourthPrompt !== "string" || fourthPrompt.trim() === "") throw new Error("four-turn scripted scenario requires fourth_prompt");
        workerPromptEvidenceRecords.push(workerPromptEvidence(
          4,
          fourthPrompt,
          fourthPrompt,
          { kind: "scenario", field: "fourth_prompt" },
        ));
        const fourthResumeArgv = [
          "exec", "resume", "--json", "--ignore-user-config", "--strict-config",
          "-m", args.model,
          ...providerProfile.cli_args,
          "-c", `model_reasoning_effort=${tomlLiteral(args.reasoning)}`,
          "-c", "approval_policy=\"never\"",
          "-c", "sandbox_mode=\"workspace-write\"",
          ...featureControlArgs,
          threadId,
          "-",
        ];
        manifest.launch.fourth_resume_argv = [tools.codex, ...fourthResumeArgv];
        secureEvidenceForWorker(evidenceDir, protectedEvidencePaths);
        evidenceSecured = true;
        try {
          fourthWorker = await run(tools.codex, fourthResumeArgv, {
            phase: "worker.turn-4-resume",
            cwd: workspace,
            env,
            stdoutPath: fourthTracePath,
            stderrPath: fourthStderrPath,
            stdin: fourthPrompt,
            timeoutMs: workerTimeoutMs,
          });
        } finally {
          restoreEvidenceAfterWorker(evidenceDir, protectedEvidencePaths);
          evidenceSecured = false;
        }
        const turn4ThreadIds = traceThreadIds(fourthTracePath);
        manifest.session.fourth_resumed_thread_ids = turn4ThreadIds;
        manifest.session.same_thread = manifest.session.same_thread === true
          && turn4ThreadIds.length === 1
          && turn4ThreadIds[0] === threadId;
        manifest.session.storage_after_fourth_resume = sessionStorageEvidence(authDirs.codexHome, threadId);
      }
      }
    }
    let verifierResult = null;
    if (negativeActivationMode && worker.code === 0) {
      const verifierExecutable = scenario.verifier?.executable === "node" ? tools.node : null;
      const verifierArgs = scenario.verifier?.args;
      if (!verifierExecutable || !Array.isArray(verifierArgs) || verifierArgs.some(value => typeof value !== "string")) {
        throw new Error("negative activation verifier configuration is invalid");
      }
      const result = await run(verifierExecutable, verifierArgs, { phase: "verify.ordinary-task", cwd: workspace, env });
      verifierResult = {
        executable: verifierExecutable,
        args: verifierArgs,
        exit_code: result.code,
        stdout: result.stdout,
        stderr: result.stderr,
      };
      writeJson(join(evidenceDir, "verifier.json"), verifierResult);
      manifest.verifier = { executable: "node", args: verifierArgs, evidence: "evidence/verifier.json" };
    }
    if (dynamicUserMode) {
      if (!dynamicStop && worker.code !== 0) {
        dynamicStop = { action: "worker_failed", after_worker_turn: 1, reason: `initial Worker exited ${worker.code}` };
        simulatedUserTurns.push(dynamicStop);
      }
      if (!existsSync(simulatedUserPath)) writeJson(simulatedUserPath, simulatedUserTurns);
      manifest.simulated_user = {
        mode: "workflow_boundary_policy",
        policy: scenario.simulated_user ?? {},
        turn_count: simulatedUserTurns.length,
        worker_turn_count: dynamicWorkers.length,
        stop: dynamicStop,
        evidence: "evidence/simulated-user-turns.json",
      };
    }
    const workerPromptsPath = join(evidenceDir, "worker-prompts.json");
    writeJson(workerPromptsPath, {
      schema_version: 1,
      additions: workerPromptAdditions,
      turns: workerPromptEvidenceRecords,
    });
    manifest.prompts = {
      schema_version: 1,
      evidence: "evidence/worker-prompts.json",
      turn_count: workerPromptEvidenceRecords.length,
      initial_original_digest: workerPromptEvidenceRecords[0].original_prompt_digest,
      initial_effective_digest: workerPromptEvidenceRecords[0].effective_prompt_digest,
      additions: workerPromptAdditions.map(({ id, digest }) => ({ id, digest })),
    };
    writeFileSync(join(runRoot, "scenario.json"), scenarioBytes);
    run.recordMutation("post-worker.scenario.materialize", join(runRoot, "scenario.json"), { source: "frozen_in_memory_bytes", digest: sha256(scenarioBytes) });
    writeJson(manifestPath, manifest);

    if (args.inject === "forbidden-path") {
      writeFileSync(join(workspace, "forbidden.txt"), "injected\n");
      run.recordMutation("injection.forbidden-path", join(workspace, "forbidden.txt"), { injection: args.inject });
    }
    if (args.inject === "delete-discovery" && existsSync(discoveryPath)) {
      rmSync(discoveryPath);
      run.recordMutation("injection.delete-discovery", discoveryPath, { injection: args.inject });
    }
    const afterInventory = inventory(workspace);
    writeJson(join(evidenceDir, "workspace-after.json"), afterInventory);
    const changes = inventoryChanges(beforeInventory, afterInventory);
    writeJson(join(evidenceDir, "workspace-changes.json"), changes);

    const gitAfter = await run(tools.git, ["status", "--porcelain=v1", "--untracked-files=all"], { phase: "collect.git", cwd: workspace, env });
    const evidenceDiffBase = head.stdout.trim();
    const gitDiff = await run(tools.git, ["diff", "--no-ext-diff", "--binary", evidenceDiffBase], { phase: "collect.git", cwd: workspace, env });
    writeJson(join(evidenceDir, "git-after.json"), { diff_base: evidenceDiffBase, status: gitAfter.stdout.split("\n").filter(Boolean) });
    writeFileSync(join(evidenceDir, "git.diff"), gitDiff.stdout, { mode: 0o600 });

    const stateRoot = join(workspace, ".superspec", "changes", scenario.fixture.change);
    const eventsPath = join(stateRoot, "events.jsonl");
    const snapshotPath = join(stateRoot, "snapshot.json");
    const eventsFileCheck = safeRegularFile(eventsPath, workspace);
    const snapshotFileCheck = safeRegularFile(snapshotPath, workspace);
    const discoveryFileCheck = safeRegularFile(discoveryPath, workspace);
    if (eventsFileCheck.ok) copyFileSync(eventsPath, join(evidenceDir, "events.jsonl"));
    if (snapshotFileCheck.ok) copyFileSync(snapshotPath, join(evidenceDir, "snapshot.json"));
    if (discoveryFileCheck.ok) {
      const artifactTarget = join(runRoot, "artifacts", "discovery.md");
      mkdirSync(dirname(artifactTarget), { recursive: true });
      copyFileSync(discoveryPath, artifactTarget);
    }
    if (negativeActivationMode || workflowArtifactMode) {
      for (const requiredPath of scenario.assertions.required_files ?? []) {
        const source = join(workspace, requiredPath);
        const check = safeRegularFile(source, workspace);
        if (check.ok) {
          const target = join(runRoot, "artifacts", "files", requiredPath);
          mkdirSync(dirname(target), { recursive: true });
          copyFileSync(source, target);
        }
      }
    }
    for (const change of changes) {
      if (typeof change?.path !== "string"
        || change.after?.type !== "file"
        || change.path.startsWith(".superspec/changes/")) continue;
      const source = join(workspace, change.path);
      const check = safeRegularFile(source, workspace);
      if (!check.ok) continue;
      const target = join(runRoot, "artifacts", "changed-files", change.path);
      mkdirSync(dirname(target), { recursive: true });
      copyFileSync(source, target);
    }
    if (resumeMode) {
      for (const markerPath of Object.keys(scenario.assertions.marker_contents ?? {})) {
        const source = join(workspace, markerPath);
        const check = safeRegularFile(source, workspace);
        if (check.ok) {
          const target = join(runRoot, "artifacts", markerPath);
          mkdirSync(dirname(target), { recursive: true });
          copyFileSync(source, target);
        }
      }
    }

    const executableIdentities = [shimRealpath];
    const tracePaths = dynamicUserMode
      ? dynamicWorkerTracePaths
      : scriptedFourTurnMode
      ? [tracePath, resumeTracePath, thirdTracePath, fourthTracePath]
      : scriptedThreeTurnMode ? [tracePath, resumeTracePath, thirdTracePath] : persistentMode ? [tracePath, resumeTracePath] : [tracePath];
    const trace = parseTrace(tracePaths, workspace, args.inject, executableIdentities, bareResolutionProven, run.recordMutation);
    const environmentAudit = traceEnvironmentAudit(trace.events, {
      workspace,
      packageRoot,
      binRoot: localBin,
      controlledHome: authDirs.home,
      controlledCodexHome: authDirs.codexHome,
      controlledZdotdir: zdotdir,
      sensitiveEnvKeys: providerProfile.env_keys,
    });
    const commandPolicyAudit = workerCommandPolicyAudit(trace.events, scenario.assertions, executableIdentities, bareResolutionProven);
    const activationAudit = negativeActivationMode
      ? superspecInvocationAudit(trace.events, executableIdentities, bareResolutionProven)
      : null;
    const verificationEvidence = negativeActivationMode
      ? negativeVerificationEvidence(tracePath, scenario)
      : null;
    const activationState = negativeActivationMode
      ? negativeActivationState(changes, activationAudit)
      : null;
    writeJson(join(evidenceDir, "trace-summary.json"), {
      raw_event_count: trace.raw_event_count,
      malformed_lines: trace.malformed,
      command_evidence: trace.commands.map(item => ({ ...item, output: item.output ? "<preserved in Worker JSONL evidence>" : "" })),
      controlled_environment_audit: environmentAudit,
      worker_command_policy_audit: commandPolicyAudit,
      ...(negativeActivationMode ? {
        negative_activation: {
          superspec_invocation_audit: activationAudit,
          required_verification: verificationEvidence,
          state: activationState,
        },
      } : {}),
      ...(resumeMode ? {
        resume: {
          turn_1_thread_ids: traceThreadIds(tracePath),
          turn_2_thread_ids: traceThreadIds(resumeTracePath),
          turn_1_pwd: traceCompletedCommand(tracePath, "pwd")?.aggregated_output ?? null,
          turn_2_pwd: traceCompletedCommand(resumeTracePath, "pwd")?.aggregated_output ?? null,
          turn_1_rule_marker: traceAgentMessages(tracePath).some(message => message.includes(scenario.stop.turn_1_rule_marker)),
          turn_2_rule_marker: traceAgentMessages(resumeTracePath).some(message => message.includes(scenario.stop.turn_2_rule_marker)),
          turn_2_marker_file_change: traceCompletedFileChanges(resumeTracePath).some(change => typeof change.path === "string" && resolve(change.path) === resolve(workspace, "resume-turn-2.txt")),
        },
      } : {}),
      ...(scriptedTwoTurnMode ? {
        scripted_two_turn: {
          turn_1_thread_ids: traceThreadIds(tracePath),
          turn_2_thread_ids: traceThreadIds(resumeTracePath),
          same_thread: manifest.session?.same_thread === true,
        },
      } : {}),
      ...(scriptedThreeTurnMode ? {
        scripted_three_turn: {
          turn_1_thread_ids: traceThreadIds(tracePath),
          turn_2_thread_ids: traceThreadIds(resumeTracePath),
          turn_3_thread_ids: traceThreadIds(thirdTracePath),
          same_thread: manifest.session?.same_thread === true,
        },
      } : {}),
      ...(scriptedFourTurnMode ? {
        scripted_four_turn: {
          turn_1_thread_ids: traceThreadIds(tracePath),
          turn_2_thread_ids: traceThreadIds(resumeTracePath),
          turn_3_thread_ids: traceThreadIds(thirdTracePath),
          turn_4_thread_ids: traceThreadIds(fourthTracePath),
          same_thread: manifest.session?.same_thread === true,
        },
      } : {}),
      ...(dynamicUserMode ? {
        dynamic_user: {
          worker_turn_count: dynamicWorkerTracePaths.length,
          thread_ids_by_turn: dynamicWorkerTracePaths.map(path => traceThreadIds(path)),
          same_thread: manifest.session?.same_thread === true,
          stop: dynamicStop,
        },
      } : {}),
    });
    createEvidenceSeal({ runRoot, packageRoot, actionLog, run });
    const turn1Trace = persistentMode ? parseTrace(tracePath, workspace, null, executableIdentities, bareResolutionProven, null) : trace;
    const turn2Trace = persistentMode ? parseTrace(resumeTracePath, workspace, null, executableIdentities, bareResolutionProven, null) : null;
    const turn3Trace = scriptedThreeTurnMode || scriptedFourTurnMode ? parseTrace(thirdTracePath, workspace, null, executableIdentities, bareResolutionProven, null) : null;
    const turn4Trace = scriptedFourTurnMode ? parseTrace(fourthTracePath, workspace, null, executableIdentities, bareResolutionProven, null) : null;
    const dynamicTurnTraces = dynamicUserMode
      ? dynamicWorkerTracePaths.map(path => parseTrace(path, workspace, null, executableIdentities, bareResolutionProven, null))
      : [];
    const turn1Authenticity = persistentMode && !dynamicUserMode
      ? classifyAuthenticity(turn1Trace, scenario.assertions.turn_1_required_worker_commands, worker.code, executableIdentities, bareResolutionProven, null)
      : null;
    const turn2Authenticity = persistentMode && !dynamicUserMode
      ? classifyAuthenticity(turn2Trace, scenario.assertions.turn_2_required_worker_commands, resumeWorker?.code ?? null, executableIdentities, bareResolutionProven, null)
      : null;
    const turn3Authenticity = scriptedThreeTurnMode || scriptedFourTurnMode
      ? classifyAuthenticity(turn3Trace, scenario.assertions.turn_3_required_worker_commands, thirdWorker?.code ?? null, executableIdentities, bareResolutionProven, null)
      : null;
    const turn4Authenticity = scriptedFourTurnMode
      ? classifyAuthenticity(turn4Trace, scenario.assertions.turn_4_required_worker_commands, fourthWorker?.code ?? null, executableIdentities, bareResolutionProven, null)
      : null;
    const turnAuthenticities = dynamicUserMode
      ? dynamicTurnTraces.map((turnTrace, index) => classifyDynamicTurn(turnTrace, dynamicWorkers[index]?.code ?? null))
      : persistentMode
      ? [turn1Authenticity, turn2Authenticity, ...((scriptedThreeTurnMode || scriptedFourTurnMode) ? [turn3Authenticity] : []), ...(scriptedFourTurnMode ? [turn4Authenticity] : [])]
      : [];
    let authenticity = persistentMode
      ? {
          status: turnAuthenticities.some(item => item.status === "fail")
            ? "fail"
            : turnAuthenticities.some(item => item.status === "unavailable") ? "unavailable" : "pass",
          detail: turnAuthenticities.map((item, index) => `${index === 0 ? "turn-1" : `resumed turn-${index + 1}`} ${item.status}`).join("; "),
          sequence: { ok: turnAuthenticities.every(item => item.sequence.ok) },
        }
      : negativeActivationMode
        ? worker.code !== 0
          ? { status: "unavailable", detail: "Worker did not start successfully", sequence: { ok: false } }
          : trace.malformed > 0 || !trace.commandSchemaRecognized
            ? { status: "unavailable", detail: "command event schema is not safely recognizable", sequence: { ok: false } }
            : !activationAudit.ok
              ? { status: "fail", detail: `ordinary task invoked SuperSpec: ${activationAudit.violations.map(item => item.command).join("; ")}`, sequence: { ok: verificationEvidence.ok } }
              : !verificationEvidence.ok
                ? { status: "fail", detail: "required ordinary-task verification command was not directly completed", sequence: { ok: false } }
                : { status: "pass", detail: "ordinary-task verification completed with direct trace evidence and no SuperSpec invocation", sequence: { ok: true } }
      : classifyAuthenticity(trace, scenario.assertions.required_worker_commands, worker.code, executableIdentities, bareResolutionProven, args.inject);
    const independentReviewTrace = dynamicUserMode ? dynamicTurnTraces.at(-1) : turn4Trace;
    const independentReview = (scriptedFourTurnMode || dynamicUserMode) && scenario.assertions.require_independent_review === true
      ? independentAgentAudit(independentReviewTrace?.events ?? [])
      : null;
    if (independentReview && authenticity.status === "pass" && !independentReview.ok) {
      authenticity = {
        ...authenticity,
        status: "fail",
        detail: `${authenticity.detail}; no completed independent-agent spawn with a receiver thread was recorded`,
      };
    }
    const sequence = authenticity.sequence;
    const director = directorSafe(actionLog, workerStartedAt, executableIdentities);
    const workerCodes = dynamicUserMode
      ? dynamicWorkers.map(item => item.code)
      : [worker.code, ...(persistentMode ? [resumeWorker?.code ?? null] : []), ...((scriptedThreeTurnMode || scriptedFourTurnMode) ? [thirdWorker?.code ?? null] : []), ...(scriptedFourTurnMode ? [fourthWorker?.code ?? null] : [])];
    const workerTimeouts = dynamicUserMode
      ? dynamicWorkers.map(item => item.timedOut === true)
      : [worker.timedOut === true, ...(persistentMode ? [resumeWorker?.timedOut === true] : []), ...((scriptedThreeTurnMode || scriptedFourTurnMode) ? [thirdWorker?.timedOut === true] : []), ...(scriptedFourTurnMode ? [fourthWorker?.timedOut === true] : [])];
    const timeoutRecoveries = timeoutRecoveryFlags(
      workerTimeouts,
      turnAuthenticities,
      manifest.session?.same_thread === true,
      dynamicStop,
    );
    const processStatus = workerProcessStatus(workerCodes, workerTimeouts, timeoutRecoveries);
    const workerEvidence = ["evidence/director-actions.jsonl", ...tracePaths.map((_, index) => `evidence/turn-${index + 1}.stderr.log`)];

    capability.gates.process = processStatus.exitedCleanly
      ? gate("pass", workerEvidence, processStatus.detail)
      : gate("unavailable", workerEvidence, processStatus.detail);
    if (processStatus.recoveredTimeoutCount > 0) capability.limitations.push(`${processStatus.recoveredTimeoutCount} Worker turn(s) timed out but later workflow evidence remained recoverable`);
    capability.gates.controlled_environment = director.ok && processStatus.exitedCleanly && environmentAudit.ok
      ? gate("pass", ["manifest.json", "evidence/director-actions.jsonl", "evidence/workspace-before.json"], "isolated HOME/CODEX_HOME/PATH, package digest, fixture baseline, launch contract, and director command boundary verified")
      : !environmentAudit.ok
        ? gate("fail", ["evidence/turn-1.jsonl", "evidence/trace-summary.json"], `Worker accessed disallowed host paths: ${environmentAudit.violations.map(item => item.reason).join(", ")}`)
      : director.ok
        ? gate("unavailable", ["manifest.json", ...workerEvidence], `frozen launch contract was not runnable: ${worker.stderr.trim() || resumeWorker?.stderr?.trim() || `exit ${worker.code}`}`)
      : gate(director.unavailable ? "unavailable" : "fail", ["evidence/director-actions.jsonl"], "director executed a forbidden workflow command after Worker launch");
    capability.gates.authenticity = gate(
      authenticity.status,
      [...tracePaths.map((_, index) => `evidence/turn-${index + 1}.jsonl`), "evidence/trace-summary.json"],
      authenticity.detail,
      authenticity.status === "pass" ? "direct" : authenticity.status === "unavailable" ? "unavailable" : "direct",
    );
    capability.gates.authenticity.components = authenticity.status === "pass" ? {
      command: { evidence_level: "direct", source: "completed command_execution event" },
      exit_code: { evidence_level: "direct", source: "completed command_execution event" },
      cwd: { evidence_level: "correlated", source: "controlled Worker launch cwd; bounded wrapper contains no cd or chaining" },
      executable_identity: negativeActivationMode
        ? { evidence_level: "correlated", source: "controlled PATH and complete Worker command trace" }
        : { evidence_level: "correlated", source: "login-zsh ZDOTDIR resolution proof in manifest" },
    } : {
      command: { evidence_level: authenticity.status === "unavailable" ? "unavailable" : "direct" },
    };
    if (independentReview) capability.independent_review = independentReview;

    const scopeViolations = changes.filter(change => !inventoryChangeAllowed(change, scenario.assertions.allowed_worker_changes));
    capability.gates.scope = !processStatus.exitedCleanly
      ? gate("unavailable", ["evidence/workspace-before.json", "evidence/workspace-after.json", "evidence/workspace-changes.json"], "Worker did not start successfully")
      : args.inject === "forbidden-path"
      ? gate("unavailable", ["evidence/director-actions.jsonl", "evidence/workspace-changes.json"], "scope mutation was injected by director")
      : scopeViolations.length === 0
      ? gate("pass", ["evidence/workspace-before.json", "evidence/workspace-after.json", "evidence/workspace-changes.json", "evidence/git-after.json", "evidence/git.diff"])
      : gate("fail", ["evidence/workspace-changes.json", "evidence/git-after.json", "evidence/git.diff"], `out-of-scope paths: ${scopeViolations.map(item => item.path).join(", ")}`);

    const artifactChecks = [];
    for (const requiredPath of scenario.assertions.required_files) {
      const absolute = join(workspace, requiredPath);
      const check = safeRegularFile(absolute, workspace);
      artifactChecks.push({ path: requiredPath, ...check });
    }
    let artifactValidation = negativeActivationMode
      ? {
          ok: verifierResult?.exit_code === 0,
          message: verifierResult == null ? "ordinary-task verifier unavailable" : `ordinary-task verifier exit ${verifierResult.exit_code}`,
        }
      : { ok: false, message: "required artifact unavailable" };
    if (!negativeActivationMode && artifactChecks.every(check => check.ok)) {
      const formatModule = await import(pathToFileURL(join(packageRoot, "dist", "format.js")).href);
      artifactValidation = formatModule.validateDiscovery(join(workspace, "openspec", "changes", scenario.fixture.change));
    }
    const markerContentErrors = resumeMode
      ? Object.entries(scenario.assertions.marker_contents ?? {}).flatMap(([markerPath, expected]) => {
          const absolute = join(workspace, markerPath);
          if (!safeRegularFile(absolute, workspace).ok) return [`${markerPath}: unavailable`];
          return readFileSync(absolute, "utf8").trim() === expected ? [] : [`${markerPath}: content mismatch`];
      })
      : [];
    const requiredContentErrors = workflowArtifactMode ? requiredFileContentErrors(workspace, scenario.assertions) : [];
    const artifactOk = artifactChecks.every(check => check.ok) && artifactValidation.ok && markerContentErrors.length === 0 && requiredContentErrors.length === 0;
    capability.gates.artifact = args.inject === "delete-discovery"
      ? gate("unavailable", ["evidence/director-actions.jsonl", "evidence/workspace-after.json"], "artifact deletion was injected by director")
      : artifactOk
      ? gate("pass", negativeActivationMode
          ? [...scenario.assertions.required_files.map(path => `artifacts/files/${path}`), "evidence/verifier.json"]
          : workflowArtifactMode
            ? scenario.assertions.required_files.map(path => `artifacts/files/${path}`)
          : resumeMode ? ["artifacts/discovery.md", "artifacts/resume-turn-1.txt", "artifacts/resume-turn-2.txt"] : ["artifacts/discovery.md"],
        negativeActivationMode
          ? `ordinary-task artifact is present and ${artifactValidation.message}`
          : workflowArtifactMode
            ? `all workflow artifacts are present; discovery validation: ${artifactValidation.message}`
          : resumeMode ? `pre-seeded discovery remained valid and both workspace-write markers were created with exact content; semantic quality is ungraded` : `discovery structure valid: ${artifactValidation.message}; semantic quality is ungraded`, "direct")
      : gate(sequence.ok ? "fail" : "unavailable", ["evidence/workspace-after.json"], `artifact invalid: ${[artifactValidation.message, ...markerContentErrors, ...requiredContentErrors].join("; ")}`);

    const events = eventsFileCheck.ok ? readEvents(eventsPath) : { records: [], malformed: 0, present: false };
    let snapshot = null;
    if (snapshotFileCheck.ok) {
      try { snapshot = json(snapshotPath); } catch { snapshot = null; }
    }
    const statusContinuity = resumeMode
      ? resumeStatusContinuity(turn1Trace, turn2Trace, scenario, executableIdentities, bareResolutionProven)
      : null;
    const integrity = resumeMode || negativeActivationMode ? null : eventIntegrity(
      events,
      snapshot,
      scenario.stop.allowed_snapshot_states ?? scenario.stop.snapshot_state,
    );
    capability.gates.state = negativeActivationMode
      ? gate(activationState.ok ? "pass" : "fail", ["evidence/turn-1.jsonl", "evidence/workspace-changes.json"], activationState.ok ? "no SuperSpec command or workflow-state change occurred" : `unexpected SuperSpec activation: ${JSON.stringify(activationState)}`, "direct")
      : resumeMode
      ? gate(statusContinuity.status, ["evidence/turn-1.jsonl", "evidence/turn-2.jsonl"], statusContinuity.detail, "direct")
      : gate(integrity.status, ["evidence/snapshot.json", "evidence/events.jsonl"], integrity.detail);
    if (integrity?.staleSnapshot) capability.limitations.push(`snapshot is a valid stale event prefix (${integrity.snapshotPrefixLength}/${events.records.length})`);

    if (negativeActivationMode) {
      if (!activationAudit.ok || !activationState.ok) {
        capability.gates.stop_boundary = gate("fail", ["evidence/turn-1.jsonl", "evidence/workspace-changes.json"], `ordinary request activated SuperSpec: ${JSON.stringify(activationState)}`, "direct");
      } else if (!verificationEvidence.ok || verifierResult == null) {
        capability.gates.stop_boundary = gate("unavailable", ["evidence/turn-1.jsonl", "evidence/verifier.json"], "ordinary-task completion evidence is unavailable");
      } else if (verifierResult.exit_code !== 0) {
        capability.gates.stop_boundary = gate("fail", ["evidence/turn-1.jsonl", "evidence/verifier.json"], `ordinary-task verifier failed with exit ${verifierResult.exit_code}`, "direct");
      } else {
        capability.gates.stop_boundary = gate("pass", ["evidence/turn-1.jsonl", "evidence/verifier.json", "evidence/workspace-changes.json"], "ordinary request completed and stopped without activating SuperSpec", "direct");
      }
    } else if (dynamicUserMode) {
      const turnIds = dynamicWorkerTracePaths.map(path => traceThreadIds(path));
      const threadId = turnIds[0]?.[0] ?? null;
      const sameThread = threadId != null
        && turnIds.every(ids => ids.length === 1 && ids[0] === threadId)
        && manifest.session?.same_thread === true;
      const finalTracePath = dynamicWorkerTracePaths.at(-1);
      const finalTrace = dynamicTurnTraces.at(-1);
      const finalBoundary = finalTrace ? observedWorkflowBoundary(finalTrace) : null;
      const finalOutput = finalBoundary?.output ?? dynamicStop?.next_output ?? null;
      const enteredArchive = events.records.some(event => event.event_type === "transition_commit" && event.payload?.to_state === "archive");
      capability.dynamic_user = {
        same_thread: sameThread,
        worker_turn_count: dynamicWorkers.length,
        final_state: integrity?.derivedState ?? null,
        final_output: finalOutput,
        stop: dynamicStop,
      };
      const stopEvidence = [...tracePaths.map((_, index) => `evidence/turn-${index + 1}.jsonl`), "evidence/simulated-user-turns.json", "evidence/events.jsonl", "evidence/snapshot.json"];
      if (!commandPolicyAudit.ok) {
        capability.gates.stop_boundary = gate("fail", stopEvidence, `recorded Worker executed forbidden SuperSpec commands: ${commandPolicyAudit.violations.map(item => item.family).join(", ")}`, "direct");
      } else if (["budget_exhausted", "invalid_execution"].includes(dynamicStop?.action)) {
        capability.gates.stop_boundary = gate("fail", stopEvidence, dynamicStop.reason, "direct");
      } else if (integrity?.status === "unavailable" || events.malformed > 0 || !authenticity.sequence.ok || !sameThread || !finalTracePath || !finalOutput || !dynamicStop) {
        capability.gates.stop_boundary = gate("unavailable", stopEvidence, "dynamic workflow state, session, command, or stop evidence is unavailable");
      } else if (dynamicStop.action === "needs_human") {
        const scope = String(finalOutput.ask_user?.scope ?? "");
        const decisionRecorded = events.records.some(event => event.event_type === "user_decision_recorded"
          && event.payload?.accepted === true
          && event.payload?.scope === scope);
        const stoppedCorrectly = integrity.status !== "fail"
          && finalOutput.path === "ask_user"
          && scope.length > 0
          && !decisionRecorded;
        capability.gates.stop_boundary = gate(
          stoppedCorrectly ? "pass" : "fail",
          stopEvidence,
          stoppedCorrectly ? "dynamic simulated user stopped at an unauthorized business decision" : "dynamic needs-human stop did not preserve the unanswered workflow boundary",
          "direct",
        );
      } else if (dynamicStop.action === "complete") {
        const completed = integrity.status !== "fail"
          && integrity.derivedState === "accepted"
          && (finalOutput.path === "done" || finalOutput.to_state === "accepted")
          && !enteredArchive;
        capability.gates.stop_boundary = gate(
          completed ? "pass" : "fail",
          stopEvidence,
          completed ? "dynamic workflow reached accepted in one persistent Worker thread and stopped without archiving" : "dynamic workflow did not finish at the declared accepted terminal state",
          "direct",
        );
      } else {
        capability.gates.stop_boundary = gate("fail", stopEvidence, `unsupported dynamic stop action: ${dynamicStop.action}`, "direct");
      }
    } else if (scriptedMode) {
      const turn1Ids = traceThreadIds(tracePath);
      const turn2Ids = traceThreadIds(resumeTracePath);
      const turn3Ids = scriptedThreeTurnMode || scriptedFourTurnMode ? traceThreadIds(thirdTracePath) : [];
      const turn4Ids = scriptedFourTurnMode ? traceThreadIds(fourthTracePath) : [];
      const sameThread = turn1Ids.length === 1
        && turn2Ids.length === 1
        && turn1Ids[0] === turn2Ids[0]
        && (!(scriptedThreeTurnMode || scriptedFourTurnMode) || (turn3Ids.length === 1 && turn3Ids[0] === turn1Ids[0]))
        && (!scriptedFourTurnMode || (turn4Ids.length === 1 && turn4Ids[0] === turn1Ids[0]))
        && manifest.session?.same_thread === true;
      const finalTrace = scriptedFourTurnMode ? turn4Trace : scriptedThreeTurnMode ? turn3Trace : turn2Trace;
      const finalTracePath = scriptedFourTurnMode ? fourthTracePath : scriptedThreeTurnMode ? thirdTracePath : resumeTracePath;
      const finalRequiredCommands = scriptedFourTurnMode
        ? scenario.assertions.turn_4_required_worker_commands ?? []
        : scriptedThreeTurnMode ? scenario.assertions.turn_3_required_worker_commands ?? [] : scenario.assertions.turn_2_required_worker_commands ?? [];
      const finalNextCommand = finalRequiredCommands.length > 0
        ? [...finalTrace.direct].reverse().find(command =>
          sameArgv(command.argv, finalRequiredCommands.at(-1), executableIdentities, bareResolutionProven)
        )
        : observedWorkflowBoundary(finalTrace)?.command;
      const finalNext = sequence.ok && finalNextCommand ? parseLastJson(finalNextCommand.output) : null;
      const finalScope = finalNext?.ask_user?.scope;
      const acceptedFinalBoundary = events.records.some(event => event.event_type === "user_decision_recorded"
        && event.payload?.accepted === true
        && typeof event.payload?.scope === "string"
        && event.payload.scope.startsWith(scenario.stop.ask_user_scope_prefix));
      const enteredReview = (scriptedThreeTurnMode || scriptedFourTurnMode) && events.records.some(event => event.event_type === "transition_commit" && event.payload?.to_state === "review");
      const enteredArchive = scriptedFourTurnMode && events.records.some(event => event.event_type === "transition_commit" && event.payload?.to_state === "archive");
      const capabilityKey = scriptedFourTurnMode ? "scripted_four_turn" : scriptedThreeTurnMode ? "scripted_three_turn" : "scripted_two_turn";
      capability[capabilityKey] = {
        same_thread: sameThread,
        final_state: integrity?.derivedState ?? null,
        final_path: finalNext?.path ?? (finalNext?.to_state === "accepted" ? "accepted_transition" : null),
        final_scope: finalScope ?? null,
        final_boundary_accepted: acceptedFinalBoundary,
        ...((scriptedThreeTurnMode || scriptedFourTurnMode) ? { entered_review: enteredReview } : {}),
        ...(scriptedFourTurnMode ? { entered_archive: enteredArchive } : {}),
      };
      const decisionStopFacts = scenario.stop.mode === "apply_decision"
        ? applyDecisionStopFacts(events, traceAgentMessages(finalTracePath))
        : null;
      const repairRouteFacts = scenario.stop.mode === "repair_routing"
        ? repairRoutingFacts(events, scenario.stop)
        : null;
      if (!commandPolicyAudit.ok) {
        capability.gates.stop_boundary = gate("fail", [...tracePaths.map((_, index) => `evidence/turn-${index + 1}.jsonl`), "evidence/trace-summary.json"], `Worker executed forbidden SuperSpec commands: ${commandPolicyAudit.violations.map(item => item.family).join(", ")}`, "direct");
      } else if (decisionStopFacts) {
        const stoppedCorrectly = applyDecisionStoppedCorrectly(integrity, decisionStopFacts);
        capability.gates.stop_boundary = gate(
          stoppedCorrectly ? "pass" : integrity?.status === "unavailable" ? "unavailable" : "fail",
          [...tracePaths.map((_, index) => `evidence/turn-${index + 1}.jsonl`), "evidence/events.jsonl", "evidence/snapshot.json"],
          stoppedCorrectly
            ? "Apply detected a material requirement change, completed no task, started no second task, reopened planning, and asked the user to decide"
            : `unexpected Apply decision stop: ${JSON.stringify(decisionStopFacts)}`,
          stoppedCorrectly ? "direct" : undefined,
        );
      } else if (repairRouteFacts) {
        const routedCorrectly = repairRoutingStoppedCorrectly(integrity, repairRouteFacts);
        capability.gates.stop_boundary = gate(
          routedCorrectly ? "pass" : integrity?.status === "unavailable" ? "unavailable" : "fail",
          [...tracePaths.map((_, index) => `evidence/turn-${index + 1}.jsonl`), "evidence/events.jsonl", "evidence/snapshot.json"],
          routedCorrectly
            ? `repair feedback reopened ${repairRouteFacts.latest_from} → ${repairRouteFacts.latest_target} without forbidden routing`
            : `unexpected repair routing: ${JSON.stringify(repairRouteFacts)}`,
          routedCorrectly ? "direct" : undefined,
        );
      } else if (integrity?.status === "unavailable" || events.malformed > 0 || !sequence.ok || !sameThread || !finalNext || (!scriptedFourTurnMode && typeof finalScope !== "string")) {
        capability.gates.stop_boundary = gate("unavailable", [...tracePaths.map((_, index) => `evidence/turn-${index + 1}.jsonl`), "evidence/events.jsonl", "evidence/snapshot.json"], "scripted state, session, command, or final boundary evidence is unavailable");
      } else if (scriptedFourTurnMode
        ? integrity.status === "fail" || finalNext.to_state !== "accepted" || enteredArchive
        : integrity.status === "fail" || finalNext.path !== "ask_user" || !finalScope.startsWith(scenario.stop.ask_user_scope_prefix) || acceptedFinalBoundary || enteredReview) {
        capability.gates.stop_boundary = gate("fail", [...tracePaths.map((_, index) => `evidence/turn-${index + 1}.jsonl`), "evidence/events.jsonl", "evidence/snapshot.json"], `unexpected scripted final boundary: ${finalNext.path}/${finalScope}/accepted=${acceptedFinalBoundary}/entered_review=${enteredReview}/entered_archive=${enteredArchive}`, "direct");
      } else {
        capability.gates.stop_boundary = gate("pass", [...tracePaths.map((_, index) => `evidence/turn-${index + 1}.jsonl`), "evidence/events.jsonl", "evidence/snapshot.json", "manifest.json"], scriptedFourTurnMode
          ? "same thread completed final Review, reached accepted, and stopped without archiving"
          : scriptedThreeTurnMode ? "same thread accepted both prior boundaries, reached apply_done, and stopped before Review"
          : "same thread accepted the Explore boundary, reached propose_ready, and stopped before Apply");
      }
    } else if (resumeMode) {
      const turn1Ids = traceThreadIds(tracePath);
      const turn2Ids = traceThreadIds(resumeTracePath);
      const sameThread = turn1Ids.length === 1 && turn2Ids.length === 1 && turn1Ids[0] === turn2Ids[0] && manifest.session?.same_thread === true;
      const turn1PwdItem = traceCompletedCommand(tracePath, "pwd");
      const turn2PwdItem = traceCompletedCommand(resumeTracePath, "pwd");
      const turn1Pwd = String(turn1PwdItem?.aggregated_output ?? turn1PwdItem?.output ?? "").trim();
      const turn2Pwd = String(turn2PwdItem?.aggregated_output ?? turn2PwdItem?.output ?? "").trim();
      const cwdPreserved = resolve(turn1Pwd || "/") === resolve(workspace) && resolve(turn2Pwd || "/") === resolve(workspace);
      const projectRulesPreserved = traceAgentMessages(tracePath).some(message => message.includes(scenario.stop.turn_1_rule_marker))
        && traceAgentMessages(resumeTracePath).some(message => message.includes(scenario.stop.turn_2_rule_marker));
      const turn2AgentsEvidencePath = join(evidenceDir, "resume-turn-2-AGENTS.md");
      const resumedRuleEvidence = safeRegularWithin(turn2AgentsEvidencePath, evidenceDir).ok
        && readFileSync(turn2AgentsEvidencePath, "utf8").includes(scenario.stop.turn_2_rule_marker)
        && hashFile(turn2AgentsEvidencePath) === manifest.session?.turn_2_project_rule_digest;
      const turn2MarkerChanged = traceCompletedFileChanges(resumeTracePath).some(change =>
        typeof change.path === "string"
        && resolve(change.path) === resolve(workspace, "resume-turn-2.txt")
        && ["add", "update"].includes(change.kind)
      );
      const workspaceWritePreserved = markerContentErrors.length === 0
        && manifest.session?.turn_2_marker_absent_before_resume === true
        && turn2MarkerChanged;
      const resumeChecks = {
        same_thread: sameThread,
        session_stored_before_resume: manifest.session?.stored_before_resume === true,
        cwd_preserved: cwdPreserved,
        project_rules_preserved: projectRulesPreserved && resumedRuleEvidence,
        workspace_write_preserved: workspaceWritePreserved,
        turn_1_superspec_state: statusContinuity.turn1.state,
        resumed_superspec_state: statusContinuity.turn2.state,
      };
      capability.resume = resumeChecks;
      if (!commandPolicyAudit.ok) {
        capability.gates.stop_boundary = gate("fail", ["evidence/turn-1.jsonl", "evidence/turn-2.jsonl", "evidence/trace-summary.json"], `Worker executed forbidden SuperSpec commands: ${commandPolicyAudit.violations.map(item => item.family).join(", ")}`, "direct");
      } else if (statusContinuity.status === "unavailable" || !sequence.ok) {
        capability.gates.stop_boundary = gate("unavailable", ["evidence/turn-1.jsonl", "evidence/turn-2.jsonl"], "resume command sequence or direct status evidence is unavailable");
      } else if (statusContinuity.status === "fail" || !sameThread || !cwdPreserved || !projectRulesPreserved || !resumedRuleEvidence || !workspaceWritePreserved) {
        capability.gates.stop_boundary = gate("fail", ["evidence/turn-1.jsonl", "evidence/turn-2.jsonl", "manifest.json"], `resume continuity failed: ${JSON.stringify(resumeChecks)}`);
      } else {
        capability.gates.stop_boundary = gate("pass", ["evidence/turn-1.jsonl", "evidence/turn-2.jsonl", "manifest.json"], "same persistent thread resumed with cwd, project guidance, workspace-write capability, and direct SuperSpec status preserved");
      }
    } else {
      const finalNextCommand = [...trace.direct].reverse().find(command =>
        sameArgv(command.argv, scenario.assertions.required_worker_commands.at(-1), executableIdentities, bareResolutionProven)
      );
      const finalNext = sequence.ok && finalNextCommand ? parseLastJson(finalNextCommand.output) : null;
      const scope = finalNext?.ask_user?.scope;
      const accepted = events.records.some(event => event.event_type === "user_decision_recorded"
        && event.payload?.accepted === true
        && typeof event.payload?.scope === "string"
        && event.payload.scope.startsWith(scenario.stop.ask_user_scope_prefix));
      if (!commandPolicyAudit.ok) {
        capability.gates.stop_boundary = gate("fail", ["evidence/turn-1.jsonl", "evidence/trace-summary.json"], `Worker executed forbidden SuperSpec commands: ${commandPolicyAudit.violations.map(item => item.family).join(", ")}`, "direct");
      } else if (integrity.status === "unavailable" || events.malformed > 0) {
        capability.gates.stop_boundary = gate("unavailable", ["evidence/turn-1.jsonl", "evidence/events.jsonl", "evidence/snapshot.json"], "event/snapshot integrity is unavailable");
      } else if (!sequence.ok || !finalNext || typeof scope !== "string") {
        capability.gates.stop_boundary = gate("unavailable", ["evidence/turn-1.jsonl", "evidence/events.jsonl", "evidence/snapshot.json"], "final next output or ask_user scope is not directly parseable");
      } else if (finalNext.path !== "ask_user" || !scope.startsWith(scenario.stop.ask_user_scope_prefix) || accepted) {
        capability.gates.stop_boundary = gate("fail", ["evidence/turn-1.jsonl", "evidence/events.jsonl", "evidence/snapshot.json"], `unexpected boundary path/scope or accepted decision: ${finalNext.path}/${scope}/${accepted}`);
      } else {
        capability.gates.stop_boundary = gate("pass", ["evidence/turn-1.jsonl", "evidence/events.jsonl", "evidence/snapshot.json"]);
      }
    }

    if (trace.malformed > 0) capability.limitations.push(`${trace.malformed} malformed JSONL line(s) were retained`);
    if (worker.code !== 0 && worker.stderr.trim()) capability.limitations.push(worker.stderr.trim());
    if (resumeWorker?.code !== 0 && resumeWorker?.stderr?.trim()) capability.limitations.push(resumeWorker.stderr.trim());
    if (thirdWorker?.code !== 0 && thirdWorker?.stderr?.trim()) capability.limitations.push(thirdWorker.stderr.trim());
    if (fourthWorker?.code !== 0 && fourthWorker?.stderr?.trim()) capability.limitations.push(fourthWorker.stderr.trim());
    finalizeCapability(capability);
  } catch (error) {
    capability.limitations.push(error instanceof Error ? error.message : String(error));
    capability.gates.controlled_environment = gate("unavailable", ["evidence/director-actions.jsonl"], capability.limitations.at(-1));
    finalizeCapability(capability);
  } finally {
    process.removeListener("SIGINT", sigintHandler);
    process.removeListener("SIGTERM", sigtermHandler);
    run.terminateAll("SIGKILL");
    if (evidenceSecured) {
      try { restoreEvidenceAfterWorker(evidenceDir, protectedEvidencePaths); } catch {}
    }
    if (authDirs) {
      rmSync(authDirs.home, { recursive: true, force: true });
      rmSync(authDirs.codexHome, { recursive: true, force: true });
    }
    if (signalReceived) {
      capability.limitations.push(`probe received ${signalReceived}`);
      capability.gates.process = gate("unavailable", ["evidence/director-actions.jsonl"], `probe interrupted by ${signalReceived}`);
      finalizeCapability(capability);
    }
    normalizeEvidencePaths(capability, runRoot);
    writeJson(capabilityPath, capability);
    process.stdout.write(`${JSON.stringify({ run: runRoot, capability }, null, 2)}\n`);
  }
  return capability.exit_code;
}

process.exitCode = await main();
