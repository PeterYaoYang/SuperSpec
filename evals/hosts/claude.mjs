/**
 * Claude Code worker-host adapter.
 *
 * Claude CLI is the protocol host, not an Anthropic-model lock-in: any backend
 * that speaks the Claude Messages request format can be reached by pointing
 * ANTHROPIC_BASE_URL / ANTHROPIC_AUTH_TOKEN (or ANTHROPIC_API_KEY) at that
 * proxy and passing --model <whatever that backend serves>.
 *
 * Launch: `claude -p --output-format stream-json --verbose` (never `--bare`,
 * so project skills and CLAUDE.md stay visible). Isolation uses
 * CLAUDE_CONFIG_DIR + an isolated HOME + a private CLAUDE_CODE_TMPDIR;
 * credentials stay in the Claude process environment, not the user's
 * ~/.claude OAuth store, and CLAUDE_CODE_SUBPROCESS_ENV_SCRUB keeps them out
 * of Bash and subagent subprocesses. Scrubbing forces the default permission
 * mode, so the isolated allow list is what keeps Bash, Write and `node -e`
 * from pausing for approval; Bash still runs inside the Claude sandbox (writes
 * confined to the workspace and temp), mirroring Codex `workspace-write`.
 * File tools may only read the workspace. The workspace is pre-trusted like a
 * real user's project, so its own permissions.allow entries apply. Trace
 * init/message events keep the requested model alias and the backend model
 * the CLI actually served.
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
  realpathSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { homedir, tmpdir } from "node:os";
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

export const CLAUDE_HOST_ID = "claude";
export const CLAUDE_ADAPTER_VERSION = "3";

const ENV_ALLOWLIST = [
  "PATH", "HOME", "TMPDIR", "LANG", "LC_ALL", "TERM", "USER", "SHELL",
  "SSL_CERT_FILE", "SSL_CERT_DIR", "HTTP_PROXY", "HTTPS_PROXY", "NO_PROXY",
  "ANTHROPIC_API_KEY", "ANTHROPIC_BASE_URL", "ANTHROPIC_AUTH_TOKEN",
];
const SKIP_SESSION_NAMES = new Set(["auth.json", ".credentials.json", "credentials.json"]);
const EFFORT = new Set(["low", "medium", "high", "xhigh", "max"]);
const SPAWN_TOOLS = /^(Agent|Task)$/;
const FILE_TOOLS = /^(Read|Write|Edit|MultiEdit|NotebookEdit|Grep|Glob|LS)$/;

function sha256(data) {
  return `sha256:${createHash("sha256").update(data).digest("hex")}`;
}

function mapEffort(reasoning) {
  if (reasoning === "none") return "low";
  return EFFORT.has(reasoning) ? reasoning : "medium";
}

function blockText(content) {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content.map(part => typeof part === "string" ? part : part?.text ?? part?.content ?? "").join("");
  }
  if (content && typeof content === "object") return String(content.text ?? content.content ?? JSON.stringify(content));
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
  const input = number(["input_tokens", "inputTokens", "prompt_tokens", "promptTokens", "input"]);
  const output = number(["output_tokens", "outputTokens", "completion_tokens", "completionTokens", "output"]);
  if (total !== null || input !== null || output !== null) {
    return { total_tokens: total ?? ((input ?? 0) + (output ?? 0)), input_tokens: input, output_tokens: output };
  }
  if (value.usage && typeof value.usage === "object") return usageFromObject(value.usage);
  return null;
}

export function controlledProviderProfile(provider, options = {}) {
  const source = options.env ?? process.env;
  if (!source.ANTHROPIC_API_KEY && !source.ANTHROPIC_AUTH_TOKEN) {
    throw new Error("Claude provider credential is unavailable (ANTHROPIC_API_KEY or ANTHROPIC_AUTH_TOKEN)");
  }
  const envKeys = ["ANTHROPIC_API_KEY", "ANTHROPIC_AUTH_TOKEN", "ANTHROPIC_BASE_URL"].filter(key => source[key]);
  return {
    id: provider || "anthropic",
    source_type: "env_anthropic",
    requires_openai_auth: false,
    env_keys: envKeys,
    config_digest: sha256(JSON.stringify({ provider: provider || "anthropic", base_url: Boolean(source.ANTHROPIC_BASE_URL) })),
    cli_args: [],
    selected_config_keys: envKeys,
    metadata: {
      base_url_protocol: source.ANTHROPIC_BASE_URL ? new URL(source.ANTHROPIC_BASE_URL).protocol : null,
    },
  };
}

/** Host credential/config stores the sandboxed Worker shell must never read. */
function hostSecretDirs(env = process.env) {
  const home = homedir();
  return [...new Set([
    join(home, ".claude"),
    join(home, ".codex"),
    join(home, ".omp"),
    join(home, ".ssh"),
    ...(env.CLAUDE_CONFIG_DIR ? [env.CLAUDE_CONFIG_DIR] : []),
    ...(env.CODEX_HOME ? [env.CODEX_HOME] : []),
  ])];
}

export function isolatedSettings() {
  return {
    permissions: {
      defaultMode: "default",
      allow: ["Bash(*)", "Read", "Write", "Edit", "MultiEdit", "Glob", "Grep", "NotebookEdit"],
      blockReadsOutsideWorkingDirectories: true,
    },
    sandbox: {
      enabled: true,
      autoAllowBashIfSandboxed: true,
      allowUnsandboxedCommands: false,
      filesystem: {
        allowRead: [homedir()],
        denyRead: hostSecretDirs(),
      },
    },
  };
}

/**
 * Claude keeps task and subagent output plus its sockets under CLAUDE_CODE_TMPDIR,
 * which otherwise defaults to /tmp/claude-<uid> shared by concurrent runs. Socket
 * paths cap its length, so the name stays short. Sandboxed Bash keeps its own
 * TMPDIR under /tmp/claude-<uid> because the sandbox only allows writes there.
 */
export function privateClaudeTmpDir(registry = null) {
  const dir = mkdtempSync(join(tmpdir(), `sscc-${process.pid}-`));
  registry?.track(dir);
  chmodSync(dir, 0o700);
  return dir;
}

export function isolatedClaudeHome(runId, { registry = null } = {}) {
  const home = mkdtempSync(join(tmpdir(), `superspec-probe-home-${runId}-`));
  registry?.track(home);
  const hostHome = mkdtempSync(join(tmpdir(), `superspec-probe-claude-${runId}-`));
  registry?.track(hostHome);
  chmodSync(home, 0o700);
  chmodSync(hostHome, 0o700);
  const claudeTmpDir = privateClaudeTmpDir(registry);
  const settingsPath = join(hostHome, "settings.json");
  writeFileSync(settingsPath, `${JSON.stringify(isolatedSettings(), null, 2)}\n`, { mode: 0o600 });
  return {
    home,
    hostHome,
    claudeHome: hostHome,
    claudeTmpDir,
    settingsPath,
    auth: { source_type: "env_api_key", exists: true, required: false, mode_ok: true, top_level_keys: [] },
    tempDirs: [home, hostHome, claudeTmpDir],
  };
}

/** A real user has accepted the trust dialog for their project; untrusted, Claude ignores the project's permissions.allow entries. */
function trustWorkspace(isolation, workspace, run) {
  const hostHome = isolation?.hostHome ?? isolation?.claudeHome;
  if (!hostHome || !workspace) return;
  const configPath = join(hostHome, ".claude.json");
  let config = {};
  try { config = JSON.parse(readFileSync(configPath, "utf8")); } catch {}
  const project = realpathSync(workspace);
  config.projects = { ...config.projects, [project]: { ...config.projects?.[project], hasTrustDialogAccepted: true } };
  writeFileSync(configPath, `${JSON.stringify(config, null, 2)}\n`, { mode: 0o600 });
  run?.recordMutation?.("setup.claude.trust-workspace", configPath, { project });
}

export function controlledEnv(home, hostHome, zdotdir, pathValue, systemShell, providerEnvKeys = [], { model = null, claudeTmpDir = null, scrubSubprocessEnv = false } = {}) {
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
  env.CLAUDE_CONFIG_DIR = hostHome;
  // Every Bash call starts in the launch cwd, so a missing per-command cwd means the workspace.
  env.CLAUDE_BASH_MAINTAIN_PROJECT_WORKING_DIR = "1";
  env.CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC = "1";
  // Built-in subagents default to Anthropic model aliases a protocol proxy may not serve.
  if (model) env.CLAUDE_CODE_SUBAGENT_MODEL = model;
  if (claudeTmpDir) env.CLAUDE_CODE_TMPDIR = claudeTmpDir;
  if (scrubSubprocessEnv) env.CLAUDE_CODE_SUBPROCESS_ENV_SCRUB = "1";
  env.ZDOTDIR = zdotdir;
  env.TMPDIR = source.TMPDIR ?? tmpdir();
  env.LANG = source.LANG ?? "en_US.UTF-8";
  env.LC_ALL = source.LC_ALL ?? "en_US.UTF-8";
  env.TERM = source.TERM ?? "dumb";
  env.USER = source.USER ?? "probe";
  env.SHELL = systemShell;
  return env;
}

function isBashTool(name) {
  return /^(Bash|bash)$/.test(String(name ?? ""));
}

function fileToolPaths(name, input) {
  const paths = [input.file_path, input.notebook_path, input.path];
  if (name === "Glob" && typeof input.pattern === "string" && /^[/~]/.test(input.pattern)) paths.push(input.pattern);
  return [...new Set(paths.filter(path => typeof path === "string" && path !== ""))];
}

function spawnReceiverId(block, toolUseResult) {
  if (typeof toolUseResult?.agentId === "string" && toolUseResult.agentId) return toolUseResult.agentId;
  return /agentId:\s*([A-Za-z0-9_-]+)/.exec(blockText(block.content))?.[1] ?? null;
}

function expandClaudeRecord(record, pending) {
  const type = typeof record?.type === "string" ? record.type : null;
  const sessionId = record?.session_id ?? record?.sessionId ?? null;
  const events = [];
  // Only the init handshake announces the session. Stream-json also emits many
  // other `system` records (thinking_tokens, status, …) that share session_id.
  if ((type === "system" && record.subtype === "init") || type === "init") {
    if (sessionId) {
      events.push({
        raw_type: type,
        kind: "thread",
        action: "started",
        thread_id: sessionId,
        ...(typeof record.model === "string" && record.model ? { model: record.model } : {}),
      });
    }
  }
  if (type === "system" && record.subtype === "task_notification" && typeof record.task_id === "string") {
    events.push({
      raw_type: type,
      kind: "agent_coordination",
      tool: "Agent",
      status: record.status === "completed" ? "completed" : String(record.status ?? "unknown"),
      sender_thread_id: sessionId,
      receiver_thread_ids: [record.task_id],
    });
  }
  if (type === "assistant") {
    for (const block of record.message?.content ?? []) {
      if (block?.type === "text" && typeof block.text === "string") {
        events.push({
          raw_type: type,
          kind: "message",
          role: "agent",
          text: block.text,
          ...(typeof record.message?.model === "string" && record.message.model ? { model: record.message.model } : {}),
        });
      }
      if (block?.type === "tool_use" && block.id) {
        pending.set(block.id, { name: block.name, input: block.input ?? {} });
        if (SPAWN_TOOLS.test(String(block.name ?? ""))) {
          events.push({
            raw_type: type,
            kind: "agent_coordination",
            tool: block.name,
            status: "requested",
            sender_thread_id: sessionId,
            receiver_thread_ids: [],
          });
        }
      }
    }
  }
  if (type === "user") {
    const toolResults = (record.message?.content ?? []).filter(block => block?.type === "tool_result");
    // stream-json attaches the structured tool result to the record, which carries one tool_result.
    const toolUseResult = toolResults.length === 1 && record.tool_use_result && typeof record.tool_use_result === "object"
      ? record.tool_use_result
      : null;
    for (const block of toolResults) {
      const pendingCall = pending.get(block.tool_use_id);
      const name = String(pendingCall?.name ?? "");
      const input = pendingCall?.input ?? {};
      const output = blockText(block.content);
      if (isBashTool(name) || (!pendingCall && typeof input.command === "string")) {
        events.push({
          raw_type: type,
          kind: "command",
          source_shape: "event",
          command: input.command ?? "",
          argv: null,
          status: block.is_error ? "failed" : "completed",
          exit_code: block.is_error ? 1 : 0,
          legacy_exit_code: null,
          cwd: input.cwd ?? input.workdir,
          output,
          output_field: "content",
          output_text: output,
          output_bytes: Buffer.byteLength(output),
        });
      } else if (SPAWN_TOOLS.test(name)) {
        const receiver = spawnReceiverId(block, toolUseResult);
        events.push({
          raw_type: type,
          kind: "agent_coordination",
          tool: name,
          status: block.is_error ? "failed" : toolUseResult?.status === "async_launched" ? "started" : "completed",
          sender_thread_id: sessionId,
          receiver_thread_ids: receiver ? [receiver] : [],
        });
      } else if (FILE_TOOLS.test(name)) {
        const paths = fileToolPaths(name, input);
        events.push({ raw_type: type, kind: "file_access", tool: name, status: block.is_error ? "failed" : "completed", paths });
        if (/^(Write|Edit|MultiEdit|NotebookEdit)$/.test(name) && paths[0]) {
          events.push({
            raw_type: type,
            kind: "file_change",
            status: block.is_error ? "failed" : "completed",
            changes: [{ path: paths[0], kind: name === "Write" && toolUseResult?.type === "create" ? "add" : "update" }],
          });
        }
      }
    }
  }
  if (type === "result") {
    if (record.is_error) {
      events.push({ raw_type: type, kind: "error", message: String(record.result ?? record.errors ?? "claude result error") });
    } else {
      // `usage` is per query; `modelUsage` is process-cumulative and would double count.
      events.push({ raw_type: type, kind: "turn_end", usage: record.usage ?? null });
    }
  }
  if (type === "error") events.push({ raw_type: type, kind: "error", message: record.message ?? record.error ?? "claude error" });
  if (events.length === 0) events.push({ raw_type: type, kind: "unknown" });
  return events;
}

/** stream-json announces its tool schema in the init handshake, so text-only turns are still recognized. */
function recognizesCommandSchema(record) {
  if (record?.type === "system" && record.subtype === "init" && Array.isArray(record.tools)) return true;
  if (record?.type === "user" && Array.isArray(record.message?.content)) {
    return record.message.content.some(block => block?.type === "tool_result");
  }
  if (record?.type === "assistant" && Array.isArray(record.message?.content)) {
    return record.message.content.some(block => block?.type === "tool_use");
  }
  return false;
}

function appendClaudeRecords(trace, records) {
  const pending = new Map();
  for (const { value, raw_ref } of records) {
    for (const event of expandClaudeRecord(value, pending)) {
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

export function parseClaudeTrace(paths, { appendLines = [] } = {}) {
  const trace = emptyTrace(CLAUDE_HOST_ID);
  for (const path of Array.isArray(paths) ? paths : [paths]) {
    if (!existsSync(path)) {
      trace.sources.push({ file: path, present: false, nonblank_lines: 0, parsed_records: 0, invalid_json_lines: 0, whitespace_only_lines: 0 });
      continue;
    }
    const { records, health } = splitJsonlRecords(readFileSync(path, "utf8"), path);
    addSourceHealth(trace, health);
    appendClaudeRecords(trace, records);
  }
  for (const { file = null, text } of appendLines) {
    const { records, health } = splitJsonlRecords(text, file);
    addSourceHealth(trace, { ...health, appended: true });
    appendClaudeRecords(trace, records);
  }
  return trace;
}

export function normalizeClaudeRecords(records, { file = null } = {}) {
  const trace = emptyTrace(CLAUDE_HOST_ID);
  const wrapped = records.map((value, index) => ({ value, raw_ref: { file, line: index + 1, nonblank_line: index + 1, record: index + 1 } }));
  addSourceHealth(trace, { file, present: true, nonblank_lines: records.length, parsed_records: records.length, invalid_json_lines: 0, whitespace_only_lines: 0 });
  appendClaudeRecords(trace, wrapped);
  return trace;
}

/**
 * Independent-agent provenance: Agent/Task calls in the audited turn that
 * completed with a named subagent (sync result or async task notification),
 * or subagent transcripts whose session started inside that turn's window.
 */
export function independentAgentAudit(trace, { sessionIndex = null, window = null } = {}) {
  const spawnCalls = eventsOfKind(trace, "agent_coordination").filter(event => event.status === "completed" && SPAWN_TOOLS.test(String(event.tool ?? "")));
  const receiverIds = [...new Set(spawnCalls.flatMap(event => Array.isArray(event.receiver_thread_ids) ? event.receiver_thread_ids : []).filter(id => typeof id === "string" && id !== ""))];
  return independentReviewAudit({ spawnCalls, receiverIds, sessionIndex, window });
}

/** Each stream-json `result.usage` covers one query, so observations are summed. */
export function usageObservations(trace) {
  const threadId = traceThreadIds(trace)[0] ?? null;
  return (trace?.events ?? []).flatMap(event => {
    if (event.kind !== "turn_end") return [];
    const usage = usageFromObject(event.usage ?? rawRecord(event));
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
      if (SKIP_SESSION_NAMES.has(name) || name.startsWith(".")) continue;
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

function readJsonlValues(path) {
  try {
    return splitJsonlRecords(readFileSync(path, "utf8"), path).records.map(record => record.value);
  } catch {
    return [];
  }
}

/** Subagent usage: last reported usage per assistant message id, summed. */
function subagentUsage(records) {
  const byMessage = new Map();
  for (const record of records) {
    if (record?.type !== "assistant" || !record.message?.usage) continue;
    byMessage.set(record.message.id ?? `record-${byMessage.size}`, record.message.usage);
  }
  return summarizeUsageObservations([...byMessage.values()].flatMap(usage => {
    const parsed = usageFromObject(usage);
    return parsed ? [{ semantics: "additive", ...parsed }] : [];
  }));
}

/**
 * Session layout: projects/<project>/<sessionId>.jsonl for the main thread and
 * projects/<project>/<sessionId>/subagents/agent-<id>.jsonl (+ .meta.json) for subagents.
 */
function sessionFileMeta(relative, absolute) {
  const subagent = /^projects\/[^/]+\/([^/]+)\/subagents\/agent-([^/]+)\.jsonl$/.exec(relative);
  if (subagent) {
    const records = readJsonlValues(absolute);
    let role = null;
    try { role = JSON.parse(readFileSync(absolute.replace(/\.jsonl$/, ".meta.json"), "utf8")).agentType ?? null; } catch {}
    const usage = subagentUsage(records);
    return {
      kind: "subagent",
      thread_id: subagent[2],
      parent_thread_id: subagent[1],
      started_at: records.find(record => typeof record?.timestamp === "string")?.timestamp ?? null,
      agent_role: role,
      usage: usage.observed ? usage : null,
    };
  }
  if (/^projects\/[^/]+\/[^/]+\/subagents\/agent-[^/]+\.meta\.json$/.test(relative)) {
    return { kind: "subagent_meta", thread_id: null };
  }
  const main = /^projects\/[^/]+\/([^/]+)\.jsonl$/.exec(relative);
  if (main) {
    const records = readJsonlValues(absolute);
    return {
      kind: "main",
      thread_id: main[1],
      started_at: records.find(record => typeof record?.timestamp === "string")?.timestamp ?? null,
    };
  }
  return { kind: "other", thread_id: null };
}

/**
 * Copies session transcripts under CLAUDE_CONFIG_DIR/projects (never settings,
 * credentials, shell snapshots or telemetry) and writes index.json.
 */
export function collectSessionArtifacts(isolation, destDir) {
  const hostHome = isolation?.hostHome ?? isolation?.claudeHome;
  if (!hostHome || !destDir) return { files: [], agents: [] };
  mkdirSync(destDir, { recursive: true, mode: 0o700 });
  const files = [];
  for (const source of listSessionFiles(hostHome)) {
    if (!source.relative.startsWith("projects/")) continue;
    const target = join(destDir, source.relative);
    mkdirSync(dirname(target), { recursive: true, mode: 0o700 });
    copyFileSync(source.absolute, target);
    chmodSync(target, 0o600);
    files.push({
      relative_path: source.relative,
      bytes: statSync(target).size,
      digest: sha256(readFileSync(target)),
      ...sessionFileMeta(source.relative, source.absolute),
    });
  }
  const subagents = files.filter(file => file.kind === "subagent");
  const index = {
    schema_version: 1,
    host: CLAUDE_HOST_ID,
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

function printArgs({ model, reasoning, launchFeatures, persistent }) {
  return [
    "-p",
    "--output-format", "stream-json",
    "--verbose",
    "--permission-mode", "default",
    "--permission-prompts", "none",
    "--model", model,
    "--effort", mapEffort(reasoning),
    ...(persistent ? [] : ["--no-session-persistence"]),
    ...(launchFeatures?.args ?? []),
  ];
}

export const claudeWorkerHost = Object.freeze({
  id: CLAUDE_HOST_ID,
  adapter_version: CLAUDE_ADAPTER_VERSION,
  display_name: "Claude Code",
  executable: "claude",
  required_tools: ["claude"],
  home_env_key: "CLAUDE_CONFIG_DIR",
  sensitive_env_keys: ["CLAUDE_CONFIG_DIR", "ANTHROPIC_API_KEY", "ANTHROPIC_AUTH_TOKEN"],
  command_evidence_source: "completed Claude tool_result",
  commands_inherit_launch_cwd: true,
  launch_policy: { sandbox: "claude-sandbox-workspace-write", approval: "default-mode-allowlist+sandboxed-bash+scrubbed-subprocess-env" },
  eval_defaults: { provider: "anthropic", model: "deepseek-v4.1-flash-expires-on-0910" },
  workspace_noise_dirs: [".claude/.cc-writes"],
  stale_temp_dir_rules: [
    { prefix: "superspec-probe-home-", pid: /^superspec-probe-home-.+-\d{14,17}-(\d+)(?:-user-\d+)?-[A-Za-z0-9]{6}$/ },
    { prefix: "superspec-probe-claude-", pid: /^superspec-probe-claude-.+-\d{14,17}-(\d+)(?:-user-\d+)?-[A-Za-z0-9]{6}$/ },
    { prefix: "sscc-", pid: /^sscc-(\d+)-[A-Za-z0-9]{6}$/, requirePid: true },
  ],

  resolveTools(lookup, { injection = null } = {}) {
    return { claude: injection === "missing-claude" ? null : lookup("claude") };
  },
  versionProbes() {
    return [["claude", ["--version"]]];
  },
  providerProfile: controlledProviderProfile,
  createIsolation({ runId, registry }) {
    return isolatedClaudeHome(runId, { registry });
  },
  assertIsolationReady(isolation) {
    if (!isolation.auth.mode_ok) throw new Error("isolated Claude authentication is unavailable");
  },
  controlledEnv({ isolation, zdotdir, pathValue, systemShell, providerProfile, model = null }) {
    return controlledEnv(isolation.home, isolation.hostHome, zdotdir, pathValue, systemShell, providerProfile.env_keys, {
      model,
      claudeTmpDir: isolation.claudeTmpDir,
      scrubSubprocessEnv: true,
    });
  },
  controlManifest({ isolation, providerProfile, features }) {
    return {
      home_isolated: isolation.home !== process.env.HOME,
      claude_config_isolated: isolation.hostHome !== (process.env.CLAUDE_CONFIG_DIR ?? join(process.env.HOME ?? "", ".claude")),
      auth_isolation: isolation.auth.mode_ok,
      auth: isolation.auth,
      ignored_user_config: true,
      claude_tmpdir_isolated: typeof isolation.claudeTmpDir === "string",
      subprocess_env_scrubbed: true,
      sandbox: isolatedSettings().sandbox,
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
    const version = await run(executable, ["--version"], { phase: "setup.claude-version", cwd, env });
    if (version.code !== 0) throw new Error(`Claude version probe failed: ${version.stderr || version.stdout}`);
    return { supported: new Map([["forward_subagent_text", { stage: "stable", enabled: true }]]), version: version.stdout.trim() };
  },
  installArgs() {
    return ["--hosts", CLAUDE_HOST_ID];
  },
  prepareWorkspace({ workspace, isolation, run } = {}) {
    trustWorkspace(isolation, workspace, run);
    return { original_digest: null, normalized_digest: null, removed: [] };
  },
  launchFeatures({ multiAgentEnabled }) {
    const args = multiAgentEnabled ? ["--forward-subagent-text"] : [];
    return {
      args,
      project_config_normalization: { removed: [] },
      manifest: {
        supported: ["forward_subagent_text"],
        enabled: multiAgentEnabled ? ["forward_subagent_text"] : [],
        disabled: multiAgentEnabled ? [] : ["forward_subagent_text"],
        multi_agent: multiAgentEnabled ? "enabled_by_default" : "disabled_by_scenario",
      },
    };
  },
  /** Scenario prompts name skills Codex-style (`$superspec-explore`); Claude invokes skills as slash commands. */
  translateWorkerPrompt(prompt) {
    return String(prompt).replace(/(^|\s)\$(superspec-[a-z][a-z0-9-]*)/g, "$1/$2");
  },
  isGuidanceFile(path) {
    return path === "AGENTS.md" || path === "CLAUDE.md" || /^\.claude\//.test(path);
  },
  freshLaunchArgs({ persistent, model, reasoning, providerProfile, launchFeatures }) {
    return printArgs({ model, reasoning, providerProfile, launchFeatures, persistent });
  },
  resumeLaunchArgs({ model, reasoning, providerProfile, launchFeatures, sessionId }) {
    return [...printArgs({ model, reasoning, providerProfile, launchFeatures, persistent: true }), "-r", sessionId];
  },
  sessionStorageEvidence(isolation, sessionId) {
    return sessionStorageEvidence(isolation.hostHome ?? isolation.claudeHome, sessionId);
  },
  /**
   * Only CLAUDE_CONFIG_DIR/projects holds this run's session output (spilled tool results,
   * subagent transcripts); the rest of the config dir is what Claude loads as user config
   * (settings.json, CLAUDE.md, skills/, agents/), so Worker access there stays a violation.
   * The private temp dir holds this run's task and subagent output.
   */
  sessionArtifactRoots(isolation) {
    const hostHome = isolation?.hostHome ?? isolation?.claudeHome;
    return [hostHome ? join(hostHome, "projects") : null, isolation?.claudeTmpDir].filter(Boolean);
  },
  sessionNotStoredMessage: "persistent session file was not found in isolated CLAUDE_CONFIG_DIR before resume",
  parseTrace: parseClaudeTrace,
  normalizeRecords: normalizeClaudeRecords,
  normalizeCommandItem(item) {
    return item;
  },
  independentAgentAudit,
  usageObservations,
  collectSessionArtifacts,
});
