/**
 * Codex CLI worker-host adapter.
 *
 * Owns everything that depends on how the Codex CLI is launched, isolated and
 * recorded: tool lookup, version/feature negotiation, isolated auth/HOME, the
 * controlled environment, provider whitelisting, fresh/resume argv, session
 * storage evidence and translation of `codex exec --json` JSONL into a
 * NormalizedTrace. Grading code must not read Codex JSONL directly.
 */

import { createHash } from "node:crypto";
import {
  chmodSync,
  copyFileSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import {
  appendTraceEvent,
  emptyTrace,
  eventsOfKind,
  independentReviewAudit,
  rawRecord,
  splitJsonlRecords,
  summarizeUsageObservations,
  traceThreadIds,
} from "../lib/trace.mjs";

export const CODEX_HOST_ID = "codex";
export const CODEX_ADAPTER_VERSION = "3";

const AUTH_ALLOWED_KEYS = new Set(["OPENAI_API_KEY", "auth_mode", "last_refresh", "tokens"]);
const ENV_ALLOWLIST = [
  "PATH", "HOME", "CODEX_HOME", "ZDOTDIR", "TMPDIR", "LANG", "LC_ALL", "TERM", "USER", "SHELL",
  "SSL_CERT_FILE", "SSL_CERT_DIR", "HTTP_PROXY", "HTTPS_PROXY", "NO_PROXY",
];
const PROVIDER_ALLOWED_KEYS = new Set(["name", "base_url", "env_key", "wire_api", "requires_openai_auth"]);

function sha256(data) {
  return `sha256:${createHash("sha256").update(data).digest("hex")}`;
}

function hostCodexHome(env = process.env) {
  return env.CODEX_HOME ?? join(env.HOME ?? "", ".codex");
}

export function stripTomlComment(line) {
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

export function parseTomlScalar(raw, key) {
  const value = stripTomlComment(raw).trim();
  if (value.startsWith('"') && value.endsWith('"')) return JSON.parse(value);
  if (value.startsWith("'") && value.endsWith("'")) return value.slice(1, -1);
  if (value === "true") return true;
  if (value === "false") return false;
  throw new Error(`unsupported provider config value for ${key}`);
}

export function tomlLiteral(value) {
  return typeof value === "boolean" ? String(value) : JSON.stringify(value);
}

/**
 * Worker provider profile: builtin `openai`, or a whitelisted
 * `[model_providers.<name>]` section from the host Codex config.
 */
export function controlledProviderProfile(provider, options = {}) {
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

/**
 * Creates a fresh HOME and CODEX_HOME for one Codex session. Only the host
 * `auth.json` is copied, and only when the provider requires OpenAI auth.
 * Both directories are registered before anything is copied into them so an
 * interrupt can never leave an unregistered credential copy behind.
 */
export function isolatedAuthHome(runId, requiresOpenaiAuth = true, { registry = null } = {}) {
  const home = mkdtempSync(join(tmpdir(), `superspec-probe-home-${runId}-`));
  registry?.track(home);
  const codexHome = mkdtempSync(join(tmpdir(), `superspec-probe-codex-${runId}-`));
  registry?.track(codexHome);
  chmodSync(home, 0o700);
  chmodSync(codexHome, 0o700);
  const source = join(hostCodexHome(), "auth.json");
  const target = join(codexHome, "auth.json");
  let auth = requiresOpenaiAuth
    ? { source_type: "missing", exists: false, required: true, mode_ok: false, top_level_keys: [] }
    : { source_type: "not_required", exists: false, required: false, mode_ok: true, top_level_keys: [] };
  if (requiresOpenaiAuth && existsSync(source)) {
    const parsed = JSON.parse(readFileSync(source, "utf8"));
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
  return { home, codexHome, auth, tempDirs: [home, codexHome] };
}

export function controlledEnv(home, codexHome, zdotdir, pathValue, systemShell, providerEnvKeys = []) {
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

export function parseFeatureList(output) {
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

export function sessionStorageEvidence(codexHome, threadId) {
  const structure = directoryStructure(codexHome, new Set(["auth.json"]));
  const sessionFiles = structure.filter(entry => entry.type === "file" && entry.path.includes(threadId));
  return {
    non_auth_entry_count: structure.length,
    matching_session_file_count: sessionFiles.length,
    matching_session_paths: sessionFiles.map(entry => entry.path),
    stored: sessionFiles.length > 0,
  };
}

function commandSourceShape(record) {
  if (record?.type === "item.completed" && record.item?.type === "command_execution") return { shape: "item.completed", item: record.item };
  if (record?.type === "command_execution" || record?.type === "command.completed") return { shape: "event", item: record };
  if (record?.item?.type === "command_execution" && record?.item?.status === "completed") return { shape: "item.status_completed", item: record.item };
  return null;
}

/** Maps a Codex command item (or legacy top-level command event) to normalized command fields. */
export function normalizeCommandItem(item, sourceShape = "item.completed") {
  const output = item.aggregated_output ?? item.output;
  const outputText = String(output ?? "");
  return {
    kind: "command",
    source_shape: sourceShape,
    command: item.command,
    argv: Array.isArray(item.argv) ? item.argv : null,
    status: item.status,
    exit_code: item.exit_code ?? null,
    legacy_exit_code: item.exitCode ?? null,
    cwd: item.cwd ?? item.workdir ?? item.working_directory,
    output,
    output_field: item.aggregated_output != null ? "aggregated_output" : item.output != null ? "output" : null,
    output_text: outputText,
    output_bytes: Buffer.byteLength(outputText),
  };
}

function normalizeRecord(record) {
  const type = typeof record?.type === "string" ? record.type : null;
  const command = commandSourceShape(record);
  if (command) return { raw_type: type, ...normalizeCommandItem(command.item, command.shape) };
  const item = record?.item;
  if (type === "item.completed" && item?.type === "agent_message") {
    return { raw_type: type, kind: "message", role: "agent", text: item.text };
  }
  if (type === "item.completed" && item?.type === "file_change") {
    return { raw_type: type, kind: "file_change", status: item.status, changes: item.changes ?? [] };
  }
  if (type === "item.completed" && item?.type === "collab_tool_call") {
    return {
      raw_type: type,
      kind: "agent_coordination",
      tool: item.tool,
      status: item.status,
      sender_thread_id: item.sender_thread_id,
      receiver_thread_ids: item.receiver_thread_ids,
      agents_states: item.agents_states,
    };
  }
  if (type === "thread.started" || type === "thread.resumed") {
    return { raw_type: type, kind: "thread", action: type === "thread.started" ? "started" : "resumed", thread_id: record.thread_id ?? record.thread?.id };
  }
  if (type === "turn.completed") return { raw_type: type, kind: "turn_end", usage: record.usage ?? null };
  if (type === "error") return { raw_type: type, kind: "error", message: record.message };
  if (type === "turn.failed") return { raw_type: type, kind: "error", message: record.error?.message };
  return { raw_type: type, kind: "unknown", ...(item && typeof item === "object" && typeof item.type === "string" ? { item_type: item.type } : {}) };
}

function recognizesCommandSchema(record) {
  return record?.type === "item.started"
    || record?.type === "item.completed"
    || record?.type === "command_execution"
    || record?.type === "command.completed"
    || record?.item?.type === "command_execution";
}

function appendRecords(trace, records) {
  for (const { value, raw_ref } of records) {
    appendTraceEvent(trace, { raw_ref, ...normalizeRecord(value) }, value);
    if (recognizesCommandSchema(value)) trace.command_schema_recognized = true;
  }
}

function addSourceHealth(trace, health) {
  trace.sources.push(health);
  trace.raw_event_count += health.nonblank_lines;
  trace.malformed_line_count += health.invalid_json_lines + health.whitespace_only_lines;
  trace.invalid_json_line_count += health.invalid_json_lines;
}

/**
 * Parses one or more `codex exec --json` stdout files into a NormalizedTrace.
 * `appendLines` adds raw lines after all files (used by director fault
 * injection, which appends to evidence after it was read).
 */
export function parseCodexTrace(paths, { appendLines = [] } = {}) {
  const trace = emptyTrace(CODEX_HOST_ID);
  for (const path of Array.isArray(paths) ? paths : [paths]) {
    if (!existsSync(path)) {
      trace.sources.push({ file: path, present: false, nonblank_lines: 0, parsed_records: 0, invalid_json_lines: 0, whitespace_only_lines: 0 });
      continue;
    }
    const { records, health } = splitJsonlRecords(readFileSync(path, "utf8"), path);
    addSourceHealth(trace, health);
    appendRecords(trace, records);
  }
  for (const { file = null, text } of appendLines) {
    const { records, health } = splitJsonlRecords(text, file);
    addSourceHealth(trace, { ...health, appended: true });
    appendRecords(trace, records);
  }
  return trace;
}

/** Builds a NormalizedTrace from in-memory Codex records (fixtures, delegation diagnostics). */
export function normalizeCodexRecords(records, { file = null } = {}) {
  const trace = emptyTrace(CODEX_HOST_ID);
  const wrapped = records.map((value, index) => ({ value, raw_ref: { file, line: index + 1, nonblank_line: index + 1, record: index + 1 } }));
  addSourceHealth(trace, { file, present: true, nonblank_lines: records.length, parsed_records: records.length, invalid_json_lines: 0, whitespace_only_lines: 0 });
  appendRecords(trace, wrapped);
  return trace;
}

/**
 * Independent-agent provenance: completed Codex collab spawns in the audited
 * turn that name a receiver thread, or collected subagent rollouts whose
 * session started inside that turn's Director window.
 */
export function independentAgentAudit(trace, { sessionIndex = null, window = null } = {}) {
  const completedCalls = eventsOfKind(trace, "agent_coordination").filter(event => event.status === "completed");
  const spawnCalls = completedCalls.filter(event => /spawn|delegate/i.test(String(event.tool ?? "")));
  const receiverIds = [...new Set(spawnCalls.flatMap(event => Array.isArray(event.receiver_thread_ids) ? event.receiver_thread_ids : []).filter(id => typeof id === "string" && id !== ""))];
  return independentReviewAudit({
    spawnCalls,
    receiverIds,
    emptyWaitCount: completedCalls.filter(event => event.tool === "wait" && (!Array.isArray(event.receiver_thread_ids) || event.receiver_thread_ids.length === 0)).length,
    sessionIndex,
    window,
  });
}

/**
 * Token usage found on a record: top-level token fields, or a nested `usage`
 * object. Semantics (per-turn vs cumulative) are not interpreted here.
 */
export function usageFromObject(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const number = keys => {
    for (const key of keys) {
      if (Number.isFinite(value[key])) return Number(value[key]);
    }
    return null;
  };
  const total = number(["total_tokens", "totalTokens"]);
  const input = number(["input_tokens", "inputTokens", "prompt_tokens", "promptTokens"]);
  const output = number(["output_tokens", "outputTokens", "completion_tokens", "completionTokens"]);
  if (total !== null || input !== null || output !== null) {
    return { total_tokens: total ?? ((input ?? 0) + (output ?? 0)), input_tokens: input, output_tokens: output };
  }
  if (value.usage && typeof value.usage === "object") return usageFromObject(value.usage);
  return null;
}

/** Usage hook: official turn/usage events only. Codex `turn.completed.usage` is thread-cumulative. */
export function usageObservations(trace) {
  const threadId = traceThreadIds(trace)[0] ?? null;
  return (trace?.events ?? []).flatMap(event => {
    if (event.kind !== "turn_end" && event.kind !== "usage") return [];
    const usage = usageFromObject(event.usage ?? rawRecord(event));
    return usage ? [{
      seq: event.seq,
      agent_id: event.agent_id,
      thread_id: event.thread_id ?? threadId,
      raw_ref: event.raw_ref,
      semantics: "cumulative",
      ...usage,
    }] : [];
  });
}

function sessionMetaFromRollout(path) {
  if (!existsSync(path)) return null;
  for (const line of readFileSync(path, "utf8").split("\n")) {
    if (!line.trim()) continue;
    let record;
    try { record = JSON.parse(line); } catch { return null; }
    if (record?.type !== "session_meta") return { thread_id: null, kind: "unknown" };
    const payload = record.payload ?? {};
    const spawn = payload.source?.subagent?.thread_spawn ?? {};
    const parent = payload.parent_thread_id ?? spawn.parent_thread_id ?? null;
    const isSubagent = payload.thread_source === "subagent" || parent != null;
    const startedAt = payload.timestamp ?? record.timestamp;
    return {
      thread_id: typeof payload.id === "string" ? payload.id : null,
      parent_thread_id: typeof parent === "string" ? parent : null,
      started_at: typeof startedAt === "string" ? startedAt : null,
      kind: isSubagent ? "subagent" : "main",
      agent_path: payload.agent_path ?? spawn.agent_path ?? null,
      agent_nickname: payload.agent_nickname ?? spawn.agent_nickname ?? null,
      agent_role: payload.agent_role ?? spawn.agent_role ?? null,
      originator: payload.originator ?? null,
    };
  }
  return null;
}

function lastThreadUsageFromRollout(path) {
  let last = null;
  if (!existsSync(path)) return null;
  for (const line of readFileSync(path, "utf8").split("\n")) {
    if (!line.trim()) continue;
    let record;
    try { record = JSON.parse(line); } catch { continue; }
    if (record?.type !== "token_usage_record") continue;
    last = usageFromObject(record.payload?.thread_token_usage ?? record.payload?.usage ?? record.payload);
  }
  return last;
}

function listRolloutFiles(hostHome) {
  const files = [];
  const visit = (dir, rel) => {
    if (!existsSync(dir)) return;
    for (const name of readdirSync(dir).sort()) {
      if (name === "auth.json") continue;
      const childRel = rel ? `${rel}/${name}` : name;
      const full = join(dir, name);
      let stat;
      try { stat = lstatSync(full); } catch { continue; }
      if (stat.isSymbolicLink()) continue;
      if (stat.isDirectory()) {
        visit(full, childRel);
        continue;
      }
      if (!stat.isFile() || !name.endsWith(".jsonl")) continue;
      if (name.startsWith("rollout-") || childRel.includes("sessions/")) files.push({ absolute: full, relative: childRel });
    }
  };
  visit(hostHome, "");
  return files;
}

/**
 * Copies isolated host session rollouts (never auth.json) into destDir and
 * writes index.json. Child events are not merged into the Worker grading trace.
 */
export function collectSessionArtifacts(isolation, destDir) {
  const hostHome = isolation?.hostHome ?? isolation?.codexHome;
  if (!hostHome || !destDir) return { files: [], agents: [] };
  const sources = listRolloutFiles(hostHome);
  mkdirSync(destDir, { recursive: true, mode: 0o700 });
  const files = [];
  for (const source of sources) {
    const target = join(destDir, source.relative);
    mkdirSync(dirname(target), { recursive: true, mode: 0o700 });
    copyFileSync(source.absolute, target);
    chmodSync(target, 0o600);
    const meta = sessionMetaFromRollout(target) ?? {};
    const usage = lastThreadUsageFromRollout(target);
    files.push({
      relative_path: source.relative,
      bytes: statSync(target).size,
      digest: sha256(readFileSync(target)),
      ...meta,
      usage,
    });
  }
  const agents = [
    { id: "main", parent: null },
    ...files.filter(file => file.kind === "subagent" && file.thread_id).map(file => ({
      id: file.thread_id,
      parent: file.parent_thread_id ?? "main",
      path: file.agent_path,
      nickname: file.agent_nickname,
      role: file.agent_role,
    })),
  ];
  const index = {
    schema_version: 1,
    host: CODEX_HOST_ID,
    collected_at: new Date().toISOString(),
    files,
    agents,
    usage: summarizeUsageObservations(files.filter(file => file.kind === "subagent").flatMap(file => file.usage && file.thread_id
      ? [{ agent_id: file.thread_id, thread_id: file.thread_id, ...file.usage }]
      : [])),
  };
  writeFileSync(join(destDir, "index.json"), `${JSON.stringify(index, null, 2)}\n`, { mode: 0o600 });
  return index;
}

const STALE_TEMP_DIR_RULES = [
  // superspec-probe-{home,codex}-<scenario>-<timestamp>-<pid>[-user-<turn>]-XXXXXX
  { prefix: "superspec-probe-home-", pid: /^superspec-probe-home-.+-\d{14,17}-(\d+)(?:-user-\d+)?-[A-Za-z0-9]{6}$/ },
  { prefix: "superspec-probe-codex-", pid: /^superspec-probe-codex-.+-\d{14,17}-(\d+)(?:-user-\d+)?-[A-Za-z0-9]{6}$/ },
  // delegation-probe: probe-delegation-<timestamp>-<pid>-{home,codex}-XXXXXX
  { prefix: "probe-delegation-", pid: /^probe-delegation-\d{14}-(\d+)-(?:home|codex)-[A-Za-z0-9]{6}$/, requirePid: true },
];

function workerLaunchCommon({ model, reasoning, providerProfile }) {
  return [
    "-m", model,
    ...providerProfile.cli_args,
    "-c", `model_reasoning_effort=${tomlLiteral(reasoning)}`,
    "-c", "approval_policy=\"never\"",
  ];
}

/** @type {import("./index.mjs").WorkerHost} */
export const codexWorkerHost = Object.freeze({
  id: CODEX_HOST_ID,
  adapter_version: CODEX_ADAPTER_VERSION,
  display_name: "Codex",
  executable: "codex",
  required_tools: ["codex"],
  home_env_key: "CODEX_HOME",
  sensitive_env_keys: ["CODEX_HOME", "OPENAI_API_KEY"],
  command_evidence_source: "completed command_execution event",
  commands_inherit_launch_cwd: false,
  launch_policy: { sandbox: "workspace-write", approval: "never" },
  eval_defaults: { provider: "openai", model: "gpt-5.6-terra" },
  stale_temp_dir_rules: STALE_TEMP_DIR_RULES,

  resolveTools(lookup, { injection = null } = {}) {
    return { codex: injection === "missing-codex" ? null : lookup("codex") };
  },
  versionProbes() {
    return [["codex", ["--version"]]];
  },
  providerProfile: controlledProviderProfile,
  createIsolation({ runId, providerProfile, registry }) {
    const dirs = isolatedAuthHome(runId, providerProfile.requires_openai_auth, { registry });
    return { ...dirs, hostHome: dirs.codexHome };
  },
  assertIsolationReady(isolation) {
    if (!isolation.auth.mode_ok) throw new Error("isolated Codex authentication is unavailable");
  },
  controlledEnv({ isolation, zdotdir, pathValue, systemShell, providerProfile }) {
    return controlledEnv(isolation.home, isolation.codexHome, zdotdir, pathValue, systemShell, providerProfile.env_keys);
  },
  controlManifest({ isolation, providerProfile, features }) {
    return {
      home_isolated: isolation.home !== process.env.HOME,
      codex_home_isolated: isolation.codexHome !== hostCodexHome(),
      auth_isolation: isolation.auth.mode_ok,
      auth: isolation.auth,
      ignored_user_config: true,
      provider: {
        id: providerProfile.id,
        source_type: providerProfile.source_type,
        selected_config_keys: providerProfile.selected_config_keys,
        config_digest: providerProfile.config_digest,
        environment_keys: providerProfile.env_keys,
        ...(providerProfile.metadata ? { metadata: providerProfile.metadata } : {}),
      },
      features: features.manifest,
      project_config_normalization: features.project_config_normalization,
    };
  },

  /** Queries supported features and fixes the launch feature flags. */
  async negotiateFeatures({ run, executable, cwd, env }) {
    const featureResult = await run(executable, ["features", "list"], { phase: "setup.codex-features", cwd, env });
    if (featureResult.code !== 0) throw new Error(`Codex feature negotiation failed: ${featureResult.stderr || featureResult.stdout}`);
    const supported = parseFeatureList(featureResult.stdout);
    if (!supported.has("multi_agent")) throw new Error("Codex does not expose required multi_agent feature control");
    return { supported };
  },
  installArgs() {
    return ["--hosts", CODEX_HOST_ID];
  },
  translateWorkerPrompt(prompt) {
    return prompt;
  },
  /** Normalizes installed project configuration against negotiated features. */
  prepareWorkspace({ workspace, features, run }) {
    return normalizeUnsupportedProjectFeatures(join(workspace, ".codex", "config.toml"), features.supported, run);
  },
  launchFeatures({ features, multiAgentEnabled, projectConfigNormalization }) {
    const supported = features.supported;
    const args = [multiAgentEnabled ? "--enable" : "--disable", "multi_agent"];
    if (supported.has("child_agents_md")) args.push("--disable", "child_agents_md");
    return {
      args,
      project_config_normalization: projectConfigNormalization,
      manifest: {
        supported: [...supported.keys()].sort(),
        enabled: args.flatMap((value, index) => value === "--enable" ? [args[index + 1]] : []),
        disabled: args.flatMap((value, index) => value === "--disable" ? [args[index + 1]] : []),
        multi_agent: multiAgentEnabled ? "enabled_by_default" : "disabled_by_scenario",
        child_agents_md: supported.has("child_agents_md") ? "disabled" : "unsupported_omitted",
      },
    };
  },
  isGuidanceFile(path) {
    return path === "AGENTS.md" || path === ".codex/config.toml" || /^\.codex\/(skills|agents|prompts)\//.test(path);
  },
  freshLaunchArgs({ persistent, model, reasoning, providerProfile, launchFeatures, workspace }) {
    return [
      "exec", "--json",
      ...(!persistent ? ["--ephemeral"] : []),
      "--ignore-user-config", "--strict-config",
      "--sandbox", "workspace-write",
      ...workerLaunchCommon({ model, reasoning, providerProfile }),
      ...launchFeatures.args,
      "-C", workspace,
      "-",
    ];
  },
  resumeLaunchArgs({ model, reasoning, providerProfile, launchFeatures, sessionId }) {
    return [
      "exec", "resume", "--json", "--ignore-user-config", "--strict-config",
      ...workerLaunchCommon({ model, reasoning, providerProfile }),
      "-c", "sandbox_mode=\"workspace-write\"",
      ...launchFeatures.args,
      sessionId,
      "-",
    ];
  },
  sessionStorageEvidence(isolation, sessionId) {
    return sessionStorageEvidence(isolation.codexHome, sessionId);
  },
  sessionNotStoredMessage: "persistent session file was not found in isolated CODEX_HOME before resume",

  parseTrace: parseCodexTrace,
  normalizeRecords: normalizeCodexRecords,
  normalizeCommandItem,
  independentAgentAudit,
  usageObservations,
  collectSessionArtifacts,
});
