#!/usr/bin/env node

import {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { createDirectorSpawner } from "./lib/spawn.mjs";

const EVAL_ROOT = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(EVAL_ROOT, "..");
const RUNS_ROOT = join(REPO_ROOT, ".eval-runs");
const PROVIDER_ENV_KEY = "LOCALPROXY_API_KEY";
const CHILD_MARKER = "DELEGATION_CHILD_OK_7F3A";
const PARENT_MARKER = "DELEGATION_PARENT_OK_7F3A";

function commandOnPath(name) {
  for (const directory of (process.env.PATH ?? "").split(process.platform === "win32" ? ";" : ":")) {
    if (!directory) continue;
    const candidate = join(directory, name);
    if (existsSync(candidate)) return realpathSync(candidate);
  }
  return null;
}

function readJsonl(path) {
  return readFileSync(path, "utf8").split("\n").filter(Boolean).flatMap(line => {
    try { return [JSON.parse(line)]; } catch { return []; }
  });
}

function isoForPath() {
  return new Date().toISOString().replace(/[-:TZ.]/g, "").slice(0, 14);
}

const codex = commandOnPath(process.platform === "win32" ? "codex.cmd" : "codex");
if (!codex) throw new Error("codex executable unavailable");
if (!process.env[PROVIDER_ENV_KEY]) throw new Error(`${PROVIDER_ENV_KEY} unavailable`);

const runId = `probe-delegation-${isoForPath()}-${process.pid}`;
const runRoot = join(RUNS_ROOT, runId);
const workspace = join(runRoot, "workspace");
const evidenceDir = join(runRoot, "evidence");
const tracePath = join(evidenceDir, "turn-1.jsonl");
const stderrPath = join(evidenceDir, "turn-1.stderr.log");
const actionLog = join(evidenceDir, "director-actions.jsonl");
mkdirSync(workspace, { recursive: true });
mkdirSync(evidenceDir, { recursive: true, mode: 0o700 });

const home = mkdtempSync(join(tmpdir(), `${runId}-home-`));
const codexHome = mkdtempSync(join(tmpdir(), `${runId}-codex-`));
chmodSync(home, 0o700);
chmodSync(codexHome, 0o700);
const sourceAuth = join(process.env.CODEX_HOME ?? join(process.env.HOME ?? "", ".codex"), "auth.json");
if (!existsSync(sourceAuth)) throw new Error("Codex auth.json unavailable");
copyFileSync(sourceAuth, join(codexHome, "auth.json"));
chmodSync(join(codexHome, "auth.json"), 0o600);

const prompt = [
  "This is a delegation transport probe, not a normal task.",
  "You must use the native spawn_agent collaboration tool exactly once with agent_type verifier.",
  `Tell the child to return exactly ${CHILD_MARKER} and do nothing else.`,
  "Wait for that exact child receiver thread to finish.",
  `Only after receiving the child result, reply exactly ${PARENT_MARKER} ${CHILD_MARKER}.`,
  "Do not use shell commands, files, or an empty wait. Do not simulate or paraphrase the child result.",
  "If spawning is unavailable or fails, reply exactly DELEGATION_SPAWN_FAILED.",
].join(" ");

const args = [
  "exec", "--json", "--ephemeral",
  "--ignore-user-config", "--strict-config",
  "--sandbox", "read-only",
  "-m", "gpt-5.6-terra",
  "-c", "model_provider=\"localproxy\"",
  "-c", "model_providers.localproxy.name=\"localproxy\"",
  "-c", "model_providers.localproxy.base_url=\"http://192.168.1.45:43000/v1\"",
  "-c", `model_providers.localproxy.env_key=\"${PROVIDER_ENV_KEY}\"`,
  "-c", "model_providers.localproxy.wire_api=\"responses\"",
  "-c", "model_providers.localproxy.requires_openai_auth=true",
  "-c", "model_reasoning_effort=\"high\"",
  "-c", "approval_policy=\"never\"",
  "--enable", "multi_agent",
  "-C", workspace,
  "-",
];

const env = {
  PATH: process.env.PATH ?? "",
  HOME: home,
  CODEX_HOME: codexHome,
  TMPDIR: process.env.TMPDIR ?? tmpdir(),
  LANG: process.env.LANG ?? "en_US.UTF-8",
  LC_ALL: process.env.LC_ALL ?? "en_US.UTF-8",
  TERM: process.env.TERM ?? "dumb",
  USER: process.env.USER ?? "probe",
  SHELL: process.env.SHELL ?? "/bin/zsh",
  [PROVIDER_ENV_KEY]: process.env[PROVIDER_ENV_KEY],
};

const run = createDirectorSpawner(actionLog);
let worker;
try {
  worker = await run(codex, args, {
    phase: "worker.delegation",
    cwd: workspace,
    env,
    stdoutPath: tracePath,
    stderrPath,
    stdin: prompt,
    timeoutMs: 600_000,
  });
} finally {
  run.terminateAll("SIGKILL");
  rmSync(home, { recursive: true, force: true });
  rmSync(codexHome, { recursive: true, force: true });
}

const events = readJsonl(tracePath);
const completedCollab = events.flatMap(event => {
  const item = event?.item;
  return event?.type === "item.completed" && item?.type === "collab_tool_call" && item.status === "completed" ? [item] : [];
});
const spawnCalls = completedCollab.filter(item => /spawn|delegate/i.test(String(item.tool ?? "")));
const receiverThreadIds = [...new Set(spawnCalls.flatMap(item => Array.isArray(item.receiver_thread_ids) ? item.receiver_thread_ids : []).filter(Boolean))];
const waits = completedCollab.filter(item => item.tool === "wait");
const messages = events.flatMap(event => event?.type === "item.completed" && event.item?.type === "agent_message" ? [String(event.item.text ?? "")] : []);
const turnCompleted = events.some(event => event?.type === "turn.completed");
const result = {
  schema_version: 1,
  run: runRoot,
  provider: "localproxy",
  model: "gpt-5.6-terra",
  reasoning: "high",
  worker_exit_code: worker.code,
  worker_signal: worker.signal,
  timed_out: worker.timedOut,
  turn_completed: turnCompleted,
  spawn_call_count: spawnCalls.length,
  receiver_thread_ids: receiverThreadIds,
  wait_calls: waits.map(item => ({ receiver_thread_ids: item.receiver_thread_ids ?? [], agents_states: item.agents_states ?? null })),
  child_marker_observed: messages.some(message => message.includes(CHILD_MARKER)),
  parent_marker_observed: messages.some(message => message.includes(PARENT_MARKER)),
};
result.pass = result.worker_exit_code === 0
  && result.turn_completed
  && result.spawn_call_count === 1
  && result.receiver_thread_ids.length === 1
  && result.child_marker_observed
  && result.parent_marker_observed;
writeFileSync(join(runRoot, "result.json"), `${JSON.stringify(result, null, 2)}\n`);
writeFileSync(join(runRoot, "manifest.json"), `${JSON.stringify({
  schema_version: 1,
  created_at: new Date().toISOString(),
  launch: { executable: codex, argv: args, cwd: workspace, sandbox: "read-only", multi_agent: "enabled" },
  credential: { environment_key: PROVIDER_ENV_KEY, value_recorded: false },
}, null, 2)}\n`);
process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
process.exitCode = result.pass ? 0 : 1;
