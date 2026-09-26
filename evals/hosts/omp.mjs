/**
 * OMP (oh-my-pi) worker-host adapter.
 *
 * OMP is a protocol host: models are selected as `provider/model` and providers
 * live in `~/.omp/agent/models.yml` (apiKey is an env var name, not a secret).
 * Eval isolation writes a whitelist of that provider into the Worker HOME and
 * never copies user agent.db / OAuth stores.
 *
 * Launch: `omp -p --mode json --session-dir <isolated>`.
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
  splitJsonlRecords,
  summarizeUsageObservations,
  traceThreadIds,
} from "../lib/trace.mjs";

export const OMP_HOST_ID = "omp";
export const OMP_ADAPTER_VERSION = "3";
export const DEFAULT_OMP_PROVIDER_ID = "codex-current";

const ENV_ALLOWLIST = [
  "PATH", "HOME", "TMPDIR", "LANG", "LC_ALL", "TERM", "USER", "SHELL",
  "SSL_CERT_FILE", "SSL_CERT_DIR", "HTTP_PROXY", "HTTPS_PROXY", "NO_PROXY",
  "ANTHROPIC_API_KEY", "ANTHROPIC_BASE_URL", "ANTHROPIC_AUTH_TOKEN",
  "OPENAI_API_KEY", "OPENAI_BASE_URL", "OPENAI_AUTH_TOKEN",
  "OPENROUTER_API_KEY", "LOCALPROXY_API_KEY", "OMP_RELAY2028_API_KEY",
  "DEEPSEEK_API_KEY", "GLM_API_KEY", "ZHIPU_API_KEY", "TYPESAFE_API_KEY",
];
const GENERIC_PROVIDER_ALIASES = new Set(["", "omp", "openai", "anthropic", "localproxy"]);
const SKIP_SESSION_NAMES = new Set(["auth.json", "credentials.json", ".credentials.json"]);
const THINKING = new Set(["off", "minimal", "low", "medium", "high", "xhigh", "max", "auto"]);

function sha256(data) {
  return `sha256:${createHash("sha256").update(data).digest("hex")}`;
}

function mapThinking(reasoning) {
  if (reasoning === "none") return "off";
  return THINKING.has(reasoning) ? reasoning : "medium";
}

function blockText(content) {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content.map(part => typeof part === "string" ? part : part?.text ?? "").join("");
  }
  if (content && typeof content === "object") {
    if (Array.isArray(content.content)) return blockText(content.content);
    return String(content.text ?? content.content ?? "");
  }
  return String(content ?? "");
}

export function usageFromObject(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const number = keys => {
    for (const key of keys) {
      if (Number.isFinite(value[key])) return Number(value[key]);
    }
    return null;
  };
  const total = number(["total_tokens", "totalTokens"]);
  const input = number(["input_tokens", "inputTokens", "input"]);
  const output = number(["output_tokens", "outputTokens", "output"]);
  if (total !== null || input !== null || output !== null) {
    return { total_tokens: total ?? ((input ?? 0) + (output ?? 0)), input_tokens: input, output_tokens: output };
  }
  if (value.usage && typeof value.usage === "object") return usageFromObject(value.usage);
  return null;
}

/** Default models.yml path for the current user OMP install. */
export function defaultOmpModelsPath(env = process.env) {
  return env.OMP_MODELS_YML || join(env.HOME ?? "", ".omp", "agent", "models.yml");
}

/** Provider ids declared under `providers:` in an OMP models.yml. */
export function listOmpProviderIds(modelsText) {
  const ids = [];
  let inProviders = false;
  for (const line of String(modelsText).split(/\r?\n/)) {
    if (/^providers:\s*(?:#.*)?$/.test(line)) {
      inProviders = true;
      continue;
    }
    if (!inProviders) continue;
    if (/^\S/.test(line) && line.trim() && !line.trim().startsWith("#")) break;
    const match = /^  ([A-Za-z0-9_-]+):\s*(?:#.*)?$/.exec(line);
    if (match) ids.push(match[1]);
  }
  return ids;
}

/**
 * Extracts one provider block (including its `  id:` header) from models.yml.
 * Preserves the original YAML so OMP-specific fields (compat, thinking, …) stay intact.
 */
export function extractProviderYaml(modelsText, providerId) {
  const lines = String(modelsText).split(/\r?\n/);
  let inProviders = false;
  let collecting = false;
  const body = [];
  for (const line of lines) {
    if (/^providers:\s*(?:#.*)?$/.test(line)) {
      inProviders = true;
      continue;
    }
    if (!inProviders) continue;
    if (/^\S/.test(line) && line.trim() && !line.trim().startsWith("#")) break;
    const header = /^  ([A-Za-z0-9_-]+):\s*(?:#.*)?$/.exec(line);
    if (header) {
      if (collecting) break;
      collecting = header[1] === providerId;
      if (collecting) body.push(line);
      continue;
    }
    if (collecting) {
      if (!line.trim() || line.trim().startsWith("#") || /^ {2,}/.test(line)) body.push(line);
      else break;
    }
  }
  if (body.length === 0) throw new Error(`OMP provider not found in models.yml: ${providerId}`);
  return `${body.join("\n").replace(/\s+$/u, "")}\n`;
}

function providerField(providerYaml, key) {
  const match = new RegExp(`^\\s+${key}:\\s*(\\S+)\\s*(?:#.*)?$`, "m").exec(providerYaml);
  return match?.[1] ?? null;
}

function assertSafeBaseUrl(raw, providerId) {
  let url;
  try { url = new URL(raw); } catch {
    throw new Error(`OMP provider ${providerId} baseUrl is invalid`);
  }
  if (!["http:", "https:"].includes(url.protocol) || url.username || url.password || url.search || url.hash) {
    throw new Error(`OMP provider ${providerId} baseUrl is unsafe`);
  }
  return url;
}

function resolveProviderId(provider, availableIds) {
  if (provider && !GENERIC_PROVIDER_ALIASES.has(provider)) {
    if (!availableIds.includes(provider)) throw new Error(`OMP provider unavailable in models.yml: ${provider}`);
    return provider;
  }
  if (availableIds.includes(DEFAULT_OMP_PROVIDER_ID)) return DEFAULT_OMP_PROVIDER_ID;
  if (availableIds.length === 0) throw new Error("OMP models.yml declares no providers");
  return availableIds[0];
}

export function resolveOmpModelRef(model, providerProfile) {
  const value = String(model ?? "");
  if (!value) throw new Error("OMP model is required");
  if (value.includes("/")) return value;
  const providerId = providerProfile?.id;
  if (!providerId) return value;
  return `${providerId}/${value}`;
}

/**
 * Builds a controlled OMP provider profile from the user's models.yml whitelist.
 * `apiKey` in models.yml is the name of an environment variable; the secret stays in env.
 */
export function controlledProviderProfile(provider, options = {}) {
  const source = options.env ?? process.env;
  const modelsPath = options.modelsPath ?? defaultOmpModelsPath(source);
  if (!existsSync(modelsPath)) {
    throw new Error(`OMP models.yml unavailable: ${modelsPath}`);
  }
  const modelsText = readFileSync(modelsPath, "utf8");
  const availableIds = listOmpProviderIds(modelsText);
  const providerId = resolveProviderId(provider, availableIds);
  const providerYaml = extractProviderYaml(modelsText, providerId);
  const baseUrl = providerField(providerYaml, "baseUrl");
  const apiKeyEnv = providerField(providerYaml, "apiKey");
  if (!baseUrl || !apiKeyEnv) throw new Error(`OMP provider ${providerId} is missing baseUrl or apiKey`);
  if (!/^[A-Z][A-Z0-9_]*$/.test(apiKeyEnv)) throw new Error(`OMP provider ${providerId} apiKey must be an env var name`);
  if (!source[apiKeyEnv]) throw new Error(`OMP provider credential unavailable: ${apiKeyEnv}`);
  const url = assertSafeBaseUrl(baseUrl, providerId);
  const envKeys = [apiKeyEnv];
  for (const key of ENV_ALLOWLIST) {
    if (/(?:API_KEY|AUTH_TOKEN|BASE_URL)$/.test(key) && source[key] && !envKeys.includes(key)) envKeys.push(key);
  }
  return {
    id: providerId,
    source_type: "omp_models_yml",
    requires_openai_auth: false,
    env_keys: envKeys,
    config_digest: sha256(JSON.stringify({
      provider: providerId,
      base_url: baseUrl,
      api_key_env: apiKeyEnv,
      provider_yaml: sha256(providerYaml),
    })),
    cli_args: [],
    selected_config_keys: ["baseUrl", "api", "apiKey", "authHeader", "disableStrictTools", "models"],
    models_yaml: `providers:\n${providerYaml}`,
    metadata: {
      models_path: modelsPath,
      base_url_protocol: url.protocol,
      api_key_env: apiKeyEnv,
    },
  };
}

export function isolatedOmpHome(runId, providerProfile, { registry = null } = {}) {
  const home = mkdtempSync(join(tmpdir(), `superspec-probe-home-${runId}-`));
  registry?.track(home);
  const hostHome = mkdtempSync(join(tmpdir(), `superspec-probe-omp-${runId}-`));
  registry?.track(hostHome);
  chmodSync(home, 0o700);
  chmodSync(hostHome, 0o700);
  const agentDir = join(home, ".omp", "agent");
  mkdirSync(agentDir, { recursive: true, mode: 0o700 });
  if (!providerProfile?.models_yaml) throw new Error("OMP isolation requires a models.yml provider profile");
  writeFileSync(join(agentDir, "models.yml"), providerProfile.models_yaml, { mode: 0o600 });
  writeFileSync(join(agentDir, "config.yml"), [
    "# Eval isolation: keep only the whitelisted models.yml provider.",
    "disabledProviders:",
    "  - openai",
    "  - ollama",
    "  - lm-studio",
    "  - cursor",
    "# Eval evidence needs whole CLI JSON lines; the default 768-byte cap cuts ask_user questions.",
    "tools:",
    "  outputMaxColumns: 0",
    "",
  ].join("\n"), { mode: 0o600 });
  return {
    home,
    hostHome,
    sessionDir: hostHome,
    agentDir,
    auth: {
      source_type: "omp_models_yml",
      exists: true,
      required: true,
      mode_ok: true,
      top_level_keys: ["baseUrl", "apiKey"],
      provider_id: providerProfile.id,
      api_key_env: providerProfile.metadata?.api_key_env ?? null,
    },
    tempDirs: [home, hostHome],
  };
}

export function controlledEnv(home, hostHome, zdotdir, pathValue, systemShell, providerEnvKeys = []) {
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
  env.ZDOTDIR = zdotdir;
  env.PI_CODING_AGENT_DIR = join(home, ".omp", "agent");
  env.TMPDIR = source.TMPDIR ?? tmpdir();
  env.LANG = source.LANG ?? "en_US.UTF-8";
  env.LC_ALL = source.LC_ALL ?? "en_US.UTF-8";
  env.TERM = source.TERM ?? "dumb";
  env.USER = source.USER ?? "probe";
  env.SHELL = systemShell;
  return env;
}

const FILE_TOOLS = /^(read|write|edit|grep|find|ls)$/i;
const SPAWN_TOOLS = /^task$/i;

/** Filesystem paths named by a file tool; tool-internal URIs (skill://…) are not filesystem access. */
function fileToolPaths(args, result) {
  const paths = [result?.details?.resolvedPath, args.path, args.file_path, args.filePath];
  return [...new Set(paths.filter(path => typeof path === "string" && path !== "" && !/^[a-z][a-z0-9+.-]*:\/\//i.test(path)))];
}

function expandOmpRecord(record, pending) {
  const type = typeof record?.type === "string" ? record.type : null;
  const events = [];
  if (type === "session" && record.id) {
    events.push({ raw_type: type, kind: "thread", action: "started", thread_id: record.id });
  }
  if (type === "message_end" && record.message?.role === "assistant") {
    const text = blockText(record.message.content);
    if (text) events.push({ raw_type: type, kind: "message", role: "agent", text });
  }
  if (type === "tool_execution_start" && record.toolCallId) {
    pending.set(record.toolCallId, {
      toolName: record.toolName,
      args: record.args ?? {},
    });
  }
  if (type === "tool_execution_end") {
    const started = pending.get(record.toolCallId) ?? {};
    pending.delete(record.toolCallId);
    const toolName = String(record.toolName ?? started.toolName ?? "");
    const args = record.args ?? started.args ?? {};
    const command = typeof args.command === "string" ? args.command : null;
    const output = blockText(record.result);
    if (command != null || /^(bash|shell)$/i.test(toolName)) {
      events.push({
        raw_type: type,
        kind: "command",
        source_shape: "event",
        command: command ?? "",
        argv: null,
        status: record.isError ? "failed" : "completed",
        exit_code: record.isError ? 1 : 0,
        legacy_exit_code: null,
        cwd: args.cwd,
        output,
        output_field: "result",
        output_text: output,
        output_bytes: Buffer.byteLength(output),
      });
    }
    if (FILE_TOOLS.test(toolName)) {
      const paths = fileToolPaths(args, record.result);
      events.push({ raw_type: type, kind: "file_access", tool: toolName, status: record.isError ? "failed" : "completed", paths });
      const path = args.path ?? args.file_path ?? args.filePath;
      if (typeof path === "string" && path && /^(write|edit)$/i.test(toolName)) {
        events.push({
          raw_type: type,
          kind: "file_change",
          status: record.isError ? "failed" : "completed",
          changes: [{ path, kind: /^write$/i.test(toolName) ? "add" : "update" }],
        });
      }
    }
    if (SPAWN_TOOLS.test(toolName)) {
      events.push({
        raw_type: type,
        kind: "agent_coordination",
        tool: toolName,
        status: record.isError ? "failed" : "completed",
        sender_thread_id: null,
        // Task jobs are named, not threaded; subagent threads come from session artifacts.
        receiver_thread_ids: [],
      });
    }
  }
  // `turn_end` closes one model call inside the agent loop; `agent_end` closes the prompt.
  if (type === "turn_end") {
    events.push({ raw_type: type, kind: "usage", usage: record.message?.usage ?? record.usage ?? null });
  }
  if (type === "agent_end") {
    events.push({ raw_type: type, kind: "turn_end", usage: null });
  }
  if (type === "notice" && record.level === "error") {
    events.push({ raw_type: type, kind: "error", message: record.message ?? "omp notice error" });
  }
  if (type === "auto_retry_end" && record.success === false) {
    events.push({ raw_type: type, kind: "error", message: record.finalError ?? "omp retry failed" });
  }
  if (events.length === 0) events.push({ raw_type: type, kind: "unknown" });
  return events;
}

/** `--mode json` opens with a session header, so text-only turns are still recognized. */
function recognizesCommandSchema(record) {
  return (record?.type === "session" && typeof record.id === "string")
    || record?.type === "tool_execution_end"
    || record?.type === "tool_execution_start";
}

function appendOmpRecords(trace, records) {
  const pending = new Map();
  for (const { value, raw_ref } of records) {
    for (const event of expandOmpRecord(value, pending)) {
      appendTraceEvent(trace, { raw_ref, ...event }, value);
    }
    if (recognizesCommandSchema(value)) trace.command_schema_recognized = true;
  }
}

function addSourceHealth(trace, health) {
  trace.sources.push(health);
  trace.raw_event_count += health.nonblank_lines;
  trace.malformed_line_count += health.invalid_json_lines + health.whitespace_only_lines;
  trace.invalid_json_line_count += health.invalid_json_lines;
}

export function parseOmpTrace(paths, { appendLines = [] } = {}) {
  const trace = emptyTrace(OMP_HOST_ID);
  for (const path of Array.isArray(paths) ? paths : [paths]) {
    if (!existsSync(path)) {
      trace.sources.push({ file: path, present: false, nonblank_lines: 0, parsed_records: 0, invalid_json_lines: 0, whitespace_only_lines: 0 });
      continue;
    }
    const { records, health } = splitJsonlRecords(readFileSync(path, "utf8"), path);
    addSourceHealth(trace, health);
    appendOmpRecords(trace, records);
  }
  for (const { file = null, text } of appendLines) {
    const { records, health } = splitJsonlRecords(text, file);
    addSourceHealth(trace, { ...health, appended: true });
    appendOmpRecords(trace, records);
  }
  return trace;
}

export function normalizeOmpRecords(records, { file = null } = {}) {
  const trace = emptyTrace(OMP_HOST_ID);
  const wrapped = records.map((value, index) => ({ value, raw_ref: { file, line: index + 1, nonblank_line: index + 1, record: index + 1 } }));
  addSourceHealth(trace, { file, present: true, nonblank_lines: records.length, parsed_records: records.length, invalid_json_lines: 0, whitespace_only_lines: 0 });
  appendOmpRecords(trace, wrapped);
  return trace;
}

/**
 * Independent-agent provenance: OMP task jobs have no thread id in the parent
 * stream, so only subagent sessions (header `parentSession`) that started
 * inside the audited turn's window prove an independent agent ran.
 */
export function independentAgentAudit(trace, { sessionIndex = null, window = null } = {}) {
  const spawnCalls = eventsOfKind(trace, "agent_coordination").filter(event => event.status === "completed" && SPAWN_TOOLS.test(String(event.tool ?? "")));
  return independentReviewAudit({ spawnCalls, receiverIds: [], sessionIndex, window });
}

/** Each OMP `turn_end` reports the usage of one model call, so observations are summed. */
export function usageObservations(trace) {
  const threadId = traceThreadIds(trace)[0] ?? null;
  return (trace?.events ?? []).flatMap(event => {
    if (event.kind !== "usage" || event.usage == null) return [];
    const usage = usageFromObject(event.usage);
    return usage ? [{
      seq: event.seq,
      agent_id: event.agent_id,
      thread_id: event.thread_id ?? threadId,
      raw_ref: event.raw_ref,
      semantics: "additive",
      ...usage,
    }] : [];
  });
}

function listSessionFiles(hostHome) {
  const files = [];
  const visit = (dir, rel) => {
    if (!existsSync(dir)) return;
    for (const name of readdirSync(dir).sort()) {
      if (SKIP_SESSION_NAMES.has(name)) continue;
      const childRel = rel ? `${rel}/${name}` : name;
      const full = join(dir, name);
      let stat;
      try { stat = lstatSync(full); } catch { continue; }
      if (stat.isSymbolicLink()) continue;
      if (stat.isDirectory()) {
        visit(full, childRel);
        continue;
      }
      if (stat.isFile() && (name.endsWith(".jsonl") || name.endsWith(".json"))) files.push({ absolute: full, relative: childRel });
    }
  };
  visit(hostHome, "");
  return files;
}

function isoTimestamp(value) {
  if (typeof value === "number" && Number.isFinite(value)) return new Date(value).toISOString();
  if (typeof value === "string" && Number.isFinite(Date.parse(value))) return value;
  return null;
}

/**
 * Session files open with `{type:"session", id, timestamp, parentSession?}`.
 * Subagent sessions name the parent session file; the parent file stem ends in `_<id>`.
 */
function sessionFileMeta(absolute) {
  if (!absolute.endsWith(".jsonl")) return { kind: "other", thread_id: null };
  let records = [];
  try { records = splitJsonlRecords(readFileSync(absolute, "utf8"), absolute).records.map(record => record.value); } catch {}
  const header = records[0];
  if (header?.type !== "session" || typeof header.id !== "string") return { kind: "other", thread_id: null };
  const parentPath = typeof header.parentSession === "string" ? header.parentSession : null;
  const base = { thread_id: header.id, started_at: isoTimestamp(header.timestamp) };
  if (!parentPath) return { kind: "main", ...base };
  const usage = summarizeUsageObservations(records.flatMap(record => {
    const message = record?.message;
    const parsed = message?.role === "assistant" ? usageFromObject(message.usage) : null;
    return parsed ? [{ semantics: "additive", ...parsed }] : [];
  }));
  return {
    kind: "subagent",
    ...base,
    parent_thread_id: /_([^_/]+)\.jsonl$/.exec(parentPath)?.[1] ?? null,
    agent_role: header.agentName ?? header.agent ?? null,
    usage: usage.observed ? usage : null,
  };
}

export function collectSessionArtifacts(isolation, destDir) {
  const hostHome = isolation?.hostHome ?? isolation?.sessionDir;
  if (!hostHome || !destDir) return { files: [], agents: [] };
  mkdirSync(destDir, { recursive: true, mode: 0o700 });
  const files = [];
  for (const source of listSessionFiles(hostHome)) {
    const target = join(destDir, source.relative);
    mkdirSync(dirname(target), { recursive: true, mode: 0o700 });
    copyFileSync(source.absolute, target);
    chmodSync(target, 0o600);
    files.push({
      relative_path: source.relative,
      bytes: statSync(target).size,
      digest: sha256(readFileSync(target)),
      ...sessionFileMeta(target),
    });
  }
  const subagents = files.filter(file => file.kind === "subagent");
  const index = {
    schema_version: 1,
    host: OMP_HOST_ID,
    collected_at: new Date().toISOString(),
    files,
    agents: [
      { id: "main", parent: null },
      ...subagents.map(file => ({ id: file.thread_id, parent: file.parent_thread_id ?? "main", role: file.agent_role })),
    ],
    usage: summarizeUsageObservations(subagents.flatMap(file => file.usage?.observed
      ? [{ semantics: "additive", agent_id: file.thread_id, thread_id: file.thread_id, total_tokens: file.usage.total_tokens, input_tokens: file.usage.input_tokens, output_tokens: file.usage.output_tokens }]
      : [])),
  };
  writeFileSync(join(destDir, "index.json"), `${JSON.stringify(index, null, 2)}\n`, { mode: 0o600 });
  return index;
}

function sessionStorageEvidence(hostHome, threadId) {
  if (!threadId || !hostHome || !existsSync(hostHome)) {
    return { non_auth_entry_count: 0, matching_session_file_count: 0, matching_session_paths: [], stored: false };
  }
  const matches = listSessionFiles(hostHome).filter(entry => entry.relative.includes(threadId) || readFileSync(entry.absolute, "utf8").includes(threadId));
  return {
    non_auth_entry_count: listSessionFiles(hostHome).length,
    matching_session_file_count: matches.length,
    matching_session_paths: matches.map(entry => entry.relative),
    stored: matches.length > 0,
  };
}

function printArgs({ model, reasoning, sessionDir, persistent, providerProfile }) {
  return [
    "-p",
    "--mode", "json",
    "--auto-approve",
    "--approval-mode", "yolo",
    "--model", resolveOmpModelRef(model, providerProfile),
    "--thinking", mapThinking(reasoning),
    ...(sessionDir ? ["--session-dir", sessionDir] : []),
    ...(persistent ? [] : ["--no-session"]),
  ];
}

export const ompWorkerHost = Object.freeze({
  id: OMP_HOST_ID,
  adapter_version: OMP_ADAPTER_VERSION,
  display_name: "OMP",
  executable: "omp",
  required_tools: ["omp"],
  home_env_key: "HOME",
  sensitive_env_keys: [
    "ANTHROPIC_API_KEY", "ANTHROPIC_AUTH_TOKEN", "OPENAI_API_KEY", "OPENROUTER_API_KEY",
    "LOCALPROXY_API_KEY", "OMP_RELAY2028_API_KEY", "DEEPSEEK_API_KEY", "GLM_API_KEY", "ZHIPU_API_KEY", "TYPESAFE_API_KEY",
  ],
  command_evidence_source: "completed OMP tool_execution_end",
  commands_inherit_launch_cwd: true,
  launch_policy: { sandbox: "none", approval: "yolo" },
  eval_defaults: { provider: "codex-current", model: "deepseek-v4.1-flash-expires-on-0910" },
  stale_temp_dir_rules: [
    { prefix: "superspec-probe-home-", pid: /^superspec-probe-home-.+-\d{14,17}-(\d+)(?:-user-\d+)?-[A-Za-z0-9]{6}$/ },
    { prefix: "superspec-probe-omp-", pid: /^superspec-probe-omp-.+-\d{14,17}-(\d+)(?:-user-\d+)?-[A-Za-z0-9]{6}$/ },
  ],

  resolveTools(lookup, { injection = null } = {}) {
    return { omp: injection === "missing-omp" ? null : lookup("omp") };
  },
  versionProbes() {
    return [["omp", ["--version"]]];
  },
  providerProfile: controlledProviderProfile,
  createIsolation({ runId, providerProfile, registry }) {
    return isolatedOmpHome(runId, providerProfile, { registry });
  },
  assertIsolationReady(isolation) {
    if (!isolation.auth.mode_ok) throw new Error("isolated OMP authentication is unavailable");
    if (!existsSync(join(isolation.home, ".omp", "agent", "models.yml"))) {
      throw new Error("isolated OMP models.yml was not materialized");
    }
  },
  controlledEnv({ isolation, zdotdir, pathValue, systemShell, providerProfile }) {
    return controlledEnv(isolation.home, isolation.hostHome, zdotdir, pathValue, systemShell, providerProfile.env_keys);
  },
  controlManifest({ isolation, providerProfile, features }) {
    return {
      home_isolated: isolation.home !== process.env.HOME,
      session_dir_isolated: true,
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
  async negotiateFeatures({ run, executable, cwd, env }) {
    const version = await run(executable, ["--version"], { phase: "setup.omp-version", cwd, env });
    if (version.code !== 0) throw new Error(`OMP version probe failed: ${version.stderr || version.stdout}`);
    return { supported: new Map(), version: version.stdout.trim() };
  },
  installArgs({ isolation }) {
    return ["--hosts", OMP_HOST_ID, ...(isolation?.agentDir ? ["--omp-home", isolation.agentDir] : [])];
  },
  /** Scenario prompts name skills Codex-style (`$superspec-explore`); OMP invokes skills as `/skill:<name>`. */
  translateWorkerPrompt(prompt) {
    return String(prompt).replace(/(^|\s)\$(superspec-[a-z][a-z0-9-]*)/g, "$1/skill:$2");
  },
  prepareWorkspace() {
    return { original_digest: null, normalized_digest: null, removed: [] };
  },
  launchFeatures({ multiAgentEnabled }) {
    return {
      args: [],
      project_config_normalization: { removed: [] },
      manifest: {
        supported: [],
        enabled: [],
        disabled: [],
        multi_agent: multiAgentEnabled ? "host_default" : "disabled_by_scenario",
      },
    };
  },
  isGuidanceFile(path) {
    return path === "AGENTS.md" || /^\.codex\//.test(path) || /^\.claude\//.test(path) || /^\.omp\//.test(path);
  },
  freshLaunchArgs({ persistent, model, reasoning, isolation, providerProfile }) {
    return printArgs({
      model,
      reasoning,
      providerProfile,
      sessionDir: isolation?.sessionDir ?? isolation?.hostHome,
      persistent,
    });
  },
  resumeLaunchArgs({ model, reasoning, sessionId, isolation, providerProfile }) {
    return [
      ...printArgs({
        model,
        reasoning,
        providerProfile,
        sessionDir: isolation?.sessionDir ?? isolation?.hostHome,
        persistent: true,
      }),
      "--resume",
      sessionId,
    ];
  },
  sessionStorageEvidence(isolation, sessionId) {
    return sessionStorageEvidence(isolation.hostHome ?? isolation.sessionDir, sessionId);
  },
  /** The per-run session dir holds only this run's transcripts and artifact:// spill files; credentials live under home. */
  sessionArtifactRoots(isolation) {
    return [isolation?.sessionDir ?? isolation?.hostHome].filter(Boolean);
  },
  sessionNotStoredMessage: "persistent session file was not found in isolated OMP session-dir before resume",
  parseTrace: parseOmpTrace,
  normalizeRecords: normalizeOmpRecords,
  normalizeCommandItem(item) {
    return item;
  },
  independentAgentAudit,
  usageObservations,
  collectSessionArtifacts,
});
