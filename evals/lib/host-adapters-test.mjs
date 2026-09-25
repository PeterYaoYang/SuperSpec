/**
 * Offline checks for Claude and OMP host/judge adapters: JSONL decode,
 * isolation, launch argv, session artifact collection. No model calls.
 */

import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getWorkerHost, registeredWorkerHostIds } from "../hosts/index.mjs";
import { resolveOmpModelRef } from "../hosts/omp.mjs";
import { getJudgeHost, registeredJudgeHostIds } from "../judges/index.mjs";
import { lastAgentMessageJson } from "../judges/runtime.mjs";
import { eventsOfKind, summarizeUsageObservations, traceAgentMessages, traceThreadIds, turnCompletion } from "./trace.mjs";

function writeJsonl(path, records) {
  writeFileSync(path, `${records.map(record => JSON.stringify(record)).join("\n")}\n`);
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

export function validateHostAdapters() {
  const ids = registeredWorkerHostIds();
  assert(ids.includes("claude") && ids.includes("omp") && ids.includes("codex"), `worker hosts missing claude/omp: ${ids.join(",")}`);
  const judgeIds = registeredJudgeHostIds();
  assert(judgeIds.includes("claude") && judgeIds.includes("omp") && judgeIds.includes("codex"), `judge hosts missing claude/omp: ${judgeIds.join(",")}`);

  const claude = getWorkerHost("claude");
  const omp = getWorkerHost("omp");
  const claudeJudge = getJudgeHost("claude");
  const ompJudge = getJudgeHost("omp");
  assert(claudeJudge.parseTrace === claude.parseTrace, "claude judge must reuse the worker decoder");
  assert(ompJudge.parseTrace === omp.parseTrace, "omp judge must reuse the worker decoder");

  const root = mkdtempSync(join(tmpdir(), "superspec-host-adapters-"));
  try {
    validateClaude(claude, claudeJudge, root);
    validateOmp(omp, ompJudge, root);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

function validateClaude(host, judge, root) {
  const sessionId = "claude-session-1";
  const fixture = join(root, "claude-turn.jsonl");
  writeJsonl(fixture, [
    { type: "system", subtype: "init", session_id: sessionId },
    {
      type: "assistant",
      session_id: sessionId,
      message: {
        content: [
          { type: "text", text: "{\"ok\":true}" },
          { type: "tool_use", id: "tool-1", name: "Bash", input: { command: "superspec status --change x" } },
          { type: "tool_use", id: "tool-2", name: "Edit", input: { file_path: "openspec/changes/x/proposal.md" } },
          { type: "tool_use", id: "tool-3", name: "Task", input: { prompt: "review" } },
        ],
        usage: { input_tokens: 40, output_tokens: 10 },
      },
    },
    {
      type: "user",
      session_id: sessionId,
      message: {
        content: [
          { type: "tool_result", tool_use_id: "tool-1", content: "{\"state\":\"explore\"}\n" },
          { type: "tool_result", tool_use_id: "tool-2", content: "ok" },
          { type: "tool_result", tool_use_id: "tool-3", content: "done", tool_use_id_alias: "child-1" },
        ],
      },
    },
    { type: "result", session_id: sessionId, is_error: false, usage: { input_tokens: 40, output_tokens: 10, total_tokens: 50 } },
  ]);
  const trace = host.parseTrace(fixture);
  assert(trace.host === "claude", "claude trace host");
  assert(traceThreadIds(trace)[0] === sessionId, "claude thread id");
  assert(eventsOfKind(trace, "thread").length === 1, "claude must not treat every system event as a thread");
  assert(traceAgentMessages(trace).some(text => text.includes("\"ok\":true")), "claude agent message");
  const commands = eventsOfKind(trace, "command");
  assert(commands.length === 1 && commands[0].command === "superspec status --change x" && commands[0].status === "completed", "claude bash tool_result");
  assert(eventsOfKind(trace, "file_change").some(event => event.changes?.[0]?.path === "openspec/changes/x/proposal.md" && event.changes[0].kind === "update"), "claude edit file_change is an update");
  assert(eventsOfKind(trace, "file_access").some(event => event.tool === "Edit" && event.paths[0] === "openspec/changes/x/proposal.md"), "claude edit is file access");
  assert(eventsOfKind(trace, "agent_coordination").some(event => event.status === "completed"), "claude task coordination");
  assert(trace.turn_completed && turnCompletion(trace).finished, "claude result is turn_end");
  assert(trace.command_schema_recognized, "claude command schema");
  assert(lastAgentMessageJson(trace, "claude json").ok === true, "claude judge json extract");
  assert(judge.sessionIds(fixture)[0] === sessionId, "claude judge session id");

  const noisy = host.normalizeRecords([
    { type: "system", subtype: "init", session_id: sessionId },
    { type: "system", subtype: "thinking_tokens", session_id: sessionId, estimated_tokens: 1 },
    { type: "system", subtype: "status", session_id: sessionId },
    { type: "result", session_id: sessionId, is_error: false, usage: { total_tokens: 1 } },
  ]);
  assert(eventsOfKind(noisy, "thread").length === 1 && noisy.turn_completed, "claude ignores non-init system noise");

  const unknown = host.normalizeRecords([{ type: "future.event", retained: true }]);
  assert(unknown.events[0]?.kind === "unknown" && eventsOfKind(unknown, "command").length === 0, "claude unknown event");

  const textOnly = host.normalizeRecords([
    { type: "system", subtype: "init", session_id: sessionId, tools: ["Bash", "Read"] },
    { type: "assistant", session_id: sessionId, message: { content: [{ type: "text", text: "请选择 A 或 B" }] } },
    { type: "result", session_id: sessionId, is_error: false, usage: { input_tokens: 5, output_tokens: 1 } },
  ]);
  assert(textOnly.command_schema_recognized && textOnly.turn_completed, "claude text-only turn keeps a recognized schema");

  const delegated = host.normalizeRecords([
    { type: "system", subtype: "init", session_id: sessionId, tools: ["Agent"] },
    { type: "assistant", session_id: sessionId, message: { content: [
      { type: "tool_use", id: "spawn-1", name: "Agent", input: { prompt: "review", run_in_background: true } },
    ] } },
    { type: "user", session_id: sessionId, message: { content: [{ type: "tool_result", tool_use_id: "spawn-1", content: "launched" }] },
      tool_use_result: { isAsync: true, status: "async_launched", agentId: "agent-a1" } },
    { type: "assistant", session_id: sessionId, message: { content: [
      { type: "tool_use", id: "write-1", name: "Write", input: { file_path: "notes.md", content: "x" } },
      { type: "tool_use", id: "read-1", name: "Read", input: { file_path: "/etc/hosts" } },
    ] } },
    { type: "user", session_id: sessionId, message: { content: [{ type: "tool_result", tool_use_id: "write-1", content: "ok" }] }, tool_use_result: { type: "create", filePath: "notes.md" } },
    { type: "user", session_id: sessionId, message: { content: [{ type: "tool_result", tool_use_id: "read-1", content: "blocked", is_error: true }] } },
    { type: "result", session_id: sessionId, is_error: false, usage: { input_tokens: 100, output_tokens: 20 } },
    { type: "system", subtype: "task_notification", session_id: sessionId, task_id: "agent-a1", status: "completed" },
    { type: "result", session_id: sessionId, is_error: false, usage: { input_tokens: 30, output_tokens: 10 } },
  ]);
  const coordination = eventsOfKind(delegated, "agent_coordination");
  assert(coordination.some(event => event.status === "started" && event.receiver_thread_ids[0] === "agent-a1"), "claude async Agent launch names its agent");
  assert(host.independentAgentAudit(delegated).receiver_thread_ids[0] === "agent-a1", "claude completed task notification proves the subagent");
  assert(eventsOfKind(delegated, "file_change").some(event => event.changes[0].kind === "add"), "claude Write create is an add");
  assert(eventsOfKind(delegated, "file_access").some(event => event.tool === "Read" && event.paths[0] === "/etc/hosts"), "claude Read is audited file access");
  const additiveUsage = summarizeUsageObservations(host.usageObservations(delegated));
  assert(additiveUsage.total_tokens === 160 && additiveUsage.input_tokens === 130, `claude per-query usage is summed, got ${JSON.stringify(additiveUsage)}`);
  const failedAsync = host.normalizeRecords([
    { type: "system", subtype: "task_notification", session_id: sessionId, task_id: "agent-a2", status: "failed" },
  ]);
  assert(!host.independentAgentAudit(failedAsync).ok, "claude failed subagent does not prove independence");
  assert(host.translateWorkerPrompt("$superspec-explore change `x`") === "/superspec-explore change `x`", "claude skill entry uses slash syntax");
  assert(host.installArgs({}).join(" ") === "--hosts claude", "claude fixture installs claude entry points");

  let missingCreds = false;
  try { host.providerProfile("anthropic", { env: {} }); } catch { missingCreds = true; }
  assert(missingCreds, "claude provider without key must fail");
  const profile = host.providerProfile("anthropic", { env: { ANTHROPIC_API_KEY: "fixture-key", ANTHROPIC_BASE_URL: "https://example.invalid" } });
  assert(profile.env_keys.includes("ANTHROPIC_API_KEY") && !JSON.stringify(profile.cli_args).includes("fixture-key"), "claude provider must not copy secrets");

  const isolation = host.createIsolation({ runId: "adapter-claude" });
  try {
    assert(isolation.home !== process.env.HOME, "claude HOME isolated");
    assert(isolation.hostHome !== (process.env.CLAUDE_CONFIG_DIR ?? join(process.env.HOME ?? "", ".claude")), "claude config isolated");
    assert(existsSync(join(isolation.hostHome, "settings.json")), "claude settings written");
    assert(!existsSync(join(isolation.hostHome, "auth.json")), "claude must not copy user OAuth");
    const settings = JSON.parse(readFileSync(join(isolation.hostHome, "settings.json"), "utf8"));
    assert(settings.sandbox?.enabled === true && settings.sandbox.allowUnsandboxedCommands === false, "claude Bash runs sandboxed");
    assert(settings.permissions?.blockReadsOutsideWorkingDirectories === true, "claude file tools are confined to the workspace");
    const env = host.controlledEnv({
      isolation,
      zdotdir: isolation.home,
      pathValue: "/bin",
      systemShell: "/bin/zsh",
      providerProfile: profile,
      model: "deepseek-v4-flash",
    });
    assert(env.CLAUDE_CONFIG_DIR === isolation.hostHome && env.HOME === isolation.home, "claude controlled env");
    assert(env.CLAUDE_CODE_SUBAGENT_MODEL === "deepseek-v4-flash", "claude subagents use the Worker model");
    writeFileSync(join(isolation.hostHome, "auth.json"), "{}\n");
    mkdirSync(join(isolation.hostHome, "telemetry"), { recursive: true });
    writeFileSync(join(isolation.hostHome, "telemetry", "events.json"), "{}\n");
    const project = join(isolation.hostHome, "projects", "-workspace");
    mkdirSync(join(project, sessionId, "subagents"), { recursive: true });
    writeJsonl(join(project, `${sessionId}.jsonl`), [{ type: "user", sessionId, timestamp: "2026-01-01T00:00:00.000Z" }]);
    writeJsonl(join(project, sessionId, "subagents", "agent-a1.jsonl"), [
      { type: "user", sessionId, timestamp: "2026-01-01T00:10:00.000Z" },
      { type: "assistant", timestamp: "2026-01-01T00:10:01.000Z", message: { id: "m1", usage: { input_tokens: 10, output_tokens: 2 } } },
      { type: "assistant", timestamp: "2026-01-01T00:10:02.000Z", message: { id: "m1", usage: { input_tokens: 10, output_tokens: 2 } } },
      { type: "assistant", timestamp: "2026-01-01T00:10:03.000Z", message: { id: "m2", usage: { input_tokens: 20, output_tokens: 3 } } },
    ]);
    writeFileSync(join(project, sessionId, "subagents", "agent-a1.meta.json"), JSON.stringify({ agentType: "critic" }));
    writeFileSync(join(project, sessionId, "subagents", "agent-a2.meta.json"), JSON.stringify({ agentType: "Explore" }));
    const dest = join(isolation.home, "collected");
    const index = host.collectSessionArtifacts(isolation, dest);
    assert(index.files.every(file => file.relative_path.startsWith("projects/")), "claude collection keeps only session transcripts");
    const main = index.files.find(file => file.kind === "main");
    const child = index.files.find(file => file.kind === "subagent");
    assert(main?.thread_id === sessionId, "claude main session id");
    assert(child?.thread_id === "a1" && child.parent_thread_id === sessionId && child.agent_role === "critic", `claude subagent metadata: ${JSON.stringify(child)}`);
    assert(index.files.filter(file => file.kind === "subagent").length === 1, "claude spawn metadata without a transcript is not a subagent session");
    assert(index.usage.total_tokens === 35, `claude subagent usage dedupes message ids, got ${JSON.stringify(index.usage)}`);
    const reviewTurn = { started_at: "2026-01-01T00:05:00.000Z", ended_at: "2026-01-01T00:20:00.000Z" };
    const laterTurn = { started_at: "2026-01-01T00:30:00.000Z", ended_at: null };
    assert(host.independentAgentAudit(host.normalizeRecords([]), { sessionIndex: index, window: reviewTurn }).ok, "claude subagent inside the review turn proves independence");
    assert(!host.independentAgentAudit(host.normalizeRecords([]), { sessionIndex: index, window: laterTurn }).ok, "claude subagent from an earlier turn does not");
  } finally {
    for (const dir of isolation.tempDirs) rmSync(dir, { recursive: true, force: true });
  }

  assert(host.resolveTools(() => "/bin/claude", { injection: "missing-claude" }).claude === null, "claude missing injection");
  const features = host.launchFeatures({ multiAgentEnabled: true });
  const fresh = host.freshLaunchArgs({ persistent: false, model: "claude-sonnet-4-6", reasoning: "high", launchFeatures: features });
  const persistent = host.freshLaunchArgs({ persistent: true, model: "claude-sonnet-4-6", reasoning: "high", launchFeatures: features });
  const resume = host.resumeLaunchArgs({ model: "claude-sonnet-4-6", reasoning: "high", launchFeatures: features, sessionId });
  assert(fresh.includes("-p") && fresh.includes("stream-json") && !fresh.includes("--bare"), "claude launch is print+stream-json, not bare");
  assert(fresh.includes("--no-session-persistence") && !persistent.includes("--no-session-persistence"), "claude persistence flag");
  assert(resume.includes("-r") && resume.includes(sessionId) && !resume.includes("--no-session-persistence"), "claude resume");
  assert(features.args.includes("--forward-subagent-text"), "claude multi-agent forwards subagent text");
}

function validateOmp(host, judge, root) {
  const sessionId = "omp-session-1";
  const fixture = join(root, "omp-turn.jsonl");
  writeJsonl(fixture, [
    { type: "session", id: sessionId },
    { type: "message_end", message: { role: "assistant", content: [{ type: "text", text: "{\"ok\":true}" }], usage: { input_tokens: 20, output_tokens: 5 } } },
    { type: "tool_execution_start", toolName: "bash", toolCallId: "call-1", args: { command: "superspec status --change x" } },
    { type: "tool_execution_end", toolName: "bash", toolCallId: "call-1", result: "{\"state\":\"explore\"}\n", isError: false },
    { type: "tool_execution_start", toolName: "task", toolCallId: "child-1", args: { prompt: "review" } },
    { type: "tool_execution_end", toolName: "task", toolCallId: "child-1", result: "done", isError: false },
    { type: "turn_end", message: { role: "assistant", usage: { input: 20, output: 5, totalTokens: 25 } } },
    { type: "tool_execution_start", toolName: "write", toolCallId: "w-1", args: { path: "notes.md", content: "x" } },
    { type: "tool_execution_end", toolName: "write", toolCallId: "w-1", result: { content: [{ type: "text", text: "ok" }], details: { resolvedPath: "/tmp/ws/notes.md" } }, isError: false },
    { type: "tool_execution_start", toolName: "edit", toolCallId: "e-1", args: { path: "docs/a.md" } },
    { type: "tool_execution_end", toolName: "edit", toolCallId: "e-1", result: "ok", isError: false },
    { type: "tool_execution_start", toolName: "read", toolCallId: "r-1", args: { path: "skill://superspec-explore" } },
    { type: "tool_execution_end", toolName: "read", toolCallId: "r-1", result: "skill", isError: false },
    { type: "turn_end", message: { role: "assistant", usage: { input: 40, output: 10, totalTokens: 50 } } },
    { type: "agent_end", messages: [] },
  ]);
  const trace = host.parseTrace(fixture);
  assert(trace.host === "omp", "omp trace host");
  assert(traceThreadIds(trace)[0] === sessionId, "omp thread id");
  assert(traceAgentMessages(trace).some(text => text.includes("\"ok\":true")), "omp agent message");
  const commands = eventsOfKind(trace, "command");
  assert(commands.some(event => event.command === "superspec status --change x" && event.status === "completed"), "omp tool_execution_end");
  assert(eventsOfKind(trace, "agent_coordination").some(event => event.tool === "task"), "omp task coordination");
  assert(trace.turn_completed && turnCompletion(trace).finished, "omp agent_end completes the prompt");
  assert(eventsOfKind(trace, "turn_end").length === 1, "omp per-call turn_end is usage, not a prompt boundary");
  const ompUsage = summarizeUsageObservations(host.usageObservations(trace));
  assert(ompUsage.total_tokens === 75 && ompUsage.input_tokens === 60, `omp per-call usage is summed, got ${JSON.stringify(ompUsage)}`);
  const ompChanges = eventsOfKind(trace, "file_change").map(event => event.changes[0]);
  assert(ompChanges.some(change => change.path === "notes.md" && change.kind === "add") && ompChanges.some(change => change.path === "docs/a.md" && change.kind === "update"), "omp write/edit map to add/update");
  const ompAccess = eventsOfKind(trace, "file_access");
  assert(ompAccess.some(event => event.paths.includes("/tmp/ws/notes.md")), "omp write access uses the resolved path");
  assert(ompAccess.find(event => event.tool === "read")?.paths.length === 0, "omp skill:// reads are not filesystem access");
  assert(trace.command_schema_recognized, "omp command schema");
  const midPrompt = host.normalizeRecords([
    { type: "session", id: sessionId },
    { type: "turn_end", message: { role: "assistant", usage: { totalTokens: 5 } } },
  ]);
  assert(!midPrompt.turn_completed && midPrompt.command_schema_recognized, "omp stream without agent_end is not complete but schema is recognized");
  assert(host.translateWorkerPrompt("$superspec-explore change `x`") === "/skill:superspec-explore change `x`", "omp skill entry syntax");
  assert(lastAgentMessageJson(trace, "omp json").ok === true, "omp judge json extract");
  assert(judge.sessionIds(fixture)[0] === sessionId, "omp judge session id");

  const unknown = host.normalizeRecords([{ type: "future.event", retained: true }]);
  assert(unknown.events[0]?.kind === "unknown", "omp unknown event");

  let missingCreds = false;
  try { host.providerProfile("omp", { env: {}, modelsPath: join(root, "missing-models.yml") }); } catch { missingCreds = true; }
  assert(missingCreds, "omp provider without models.yml must fail");

  const modelsPath = join(root, "models.yml");
  writeFileSync(modelsPath, [
    "providers:",
    "  codex-current:",
    "    baseUrl: http://127.0.0.1:43000/v1",
    "    api: openai-completions",
    "    apiKey: OPENAI_API_KEY",
    "    authHeader: true",
    "    disableStrictTools: true",
    "    models:",
    "      - id: deepseek-v4-flash",
    "        name: DeepSeek V4 Flash",
    "        reasoning: true",
    "        input: [text]",
    "        contextWindow: 200000",
    "        maxTokens: 16384",
    "",
  ].join("\n"));
  const profile = host.providerProfile("omp", {
    modelsPath,
    env: { OPENAI_API_KEY: "fixture-key", HOME: root },
  });
  assert(profile.id === "codex-current", "omp generic provider maps to codex-current");
  assert(profile.env_keys.includes("OPENAI_API_KEY"), "omp provider env keys");
  assert(profile.models_yaml.includes("codex-current:") && profile.models_yaml.includes("OPENAI_API_KEY"), "omp models yaml whitelist");
  assert(!profile.models_yaml.includes("fixture-key"), "omp must not copy secret values into models.yml");
  assert(resolveOmpModelRef("deepseek-v4-flash", profile) === "codex-current/deepseek-v4-flash", "omp judge/worker share provider/model refs");
  assert(judge.parseTrace === host.parseTrace, "omp judge reuses worker decoder");

  const isolation = host.createIsolation({ runId: "adapter-omp", providerProfile: profile });
  try {
    assert(isolation.home !== process.env.HOME, "omp HOME isolated");
    assert(isolation.sessionDir === isolation.hostHome, "omp session dir isolated");
    assert(existsSync(join(isolation.home, ".omp", "agent", "models.yml")), "omp models.yml materialized");
    writeFileSync(join(isolation.hostHome, "auth.json"), "{}\n");
    mkdirSync(join(isolation.hostHome, "sessions"), { recursive: true });
    writeFileSync(join(isolation.hostHome, "sessions", `${sessionId}.jsonl`), `${JSON.stringify({ id: sessionId })}\n`);
    const dest = join(isolation.home, "collected");
    const index = host.collectSessionArtifacts(isolation, dest);
    assert(index.files.every(file => !file.relative_path.endsWith("auth.json")), "omp collection skips auth");
    assert(index.files.some(file => file.relative_path === `sessions/${sessionId}.jsonl`), "omp collection keeps session files");
    const stored = host.sessionStorageEvidence(isolation, sessionId);
    assert(stored.stored, "omp session storage evidence");
    const mainStem = `2026-01-01T00-00-00-000Z_${sessionId}`;
    writeJsonl(join(isolation.hostHome, `${mainStem}.jsonl`), [{ type: "session", id: sessionId, timestamp: "2026-01-01T00:00:00.000Z" }]);
    mkdirSync(join(isolation.hostHome, mainStem), { recursive: true });
    writeJsonl(join(isolation.hostHome, mainStem, "Critic.jsonl"), [
      { type: "session", id: "omp-child-1", timestamp: "2026-01-01T00:10:00.000Z", parentSession: join(isolation.hostHome, `${mainStem}.jsonl`) },
      { type: "message", message: { role: "assistant", usage: { input: 7, output: 3, totalTokens: 10 } } },
    ]);
    const withChild = host.collectSessionArtifacts(isolation, join(isolation.home, "collected-child"));
    const ompChild = withChild.files.find(file => file.kind === "subagent");
    assert(ompChild?.thread_id === "omp-child-1" && ompChild.parent_thread_id === sessionId, `omp subagent session metadata: ${JSON.stringify(ompChild)}`);
    assert(withChild.files.find(file => file.kind === "main")?.thread_id === sessionId, "omp main session header");
    assert(withChild.usage.total_tokens === 10, "omp subagent usage");
    const reviewTurn = { started_at: "2026-01-01T00:05:00.000Z", ended_at: "2026-01-01T00:20:00.000Z" };
    assert(host.independentAgentAudit(trace, { sessionIndex: withChild, window: reviewTurn }).ok, "omp subagent inside the review turn proves independence");
    assert(!host.independentAgentAudit(trace, { sessionIndex: withChild }).ok, "omp task call without an attributable subagent session does not");
    assert(host.installArgs({ isolation }).join(" ") === `--hosts omp --omp-home ${isolation.agentDir}`, "omp fixture installs into the isolated agent dir");
    const fresh = host.freshLaunchArgs({ persistent: false, model: "deepseek-v4-flash", reasoning: "high", isolation, providerProfile: profile });
    const persistent = host.freshLaunchArgs({ persistent: true, model: "deepseek-v4-flash", reasoning: "medium", isolation, providerProfile: profile });
    const resume = host.resumeLaunchArgs({ model: "deepseek-v4-flash", reasoning: "medium", sessionId, isolation, providerProfile: profile });
    const withoutIsolation = host.freshLaunchArgs({ persistent: false, model: "deepseek-v4-flash", reasoning: "high", providerProfile: profile });
    assert(fresh.includes("-p") && fresh.includes("json") && fresh.includes("--auto-approve"), "omp print+json");
    assert(fresh.includes("codex-current/deepseek-v4-flash"), "omp model uses provider/model");
    assert(fresh.includes("--session-dir") && fresh.includes(isolation.hostHome), "omp session-dir from isolation");
    assert(fresh.includes("--no-session") && !persistent.includes("--no-session"), "omp persistence flag");
    assert(resume.includes("--resume") && resume.includes(sessionId), "omp resume");
    assert(!withoutIsolation.includes("--session-dir"), "omp omits session-dir when isolation is absent");
  } finally {
    for (const dir of isolation.tempDirs) rmSync(dir, { recursive: true, force: true });
  }

  assert(host.resolveTools(() => "/bin/omp", { injection: "missing-omp" }).omp === null, "omp missing injection");
}
