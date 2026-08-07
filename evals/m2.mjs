#!/usr/bin/env node

import { createHash } from "node:crypto";
import { spawn, spawnSync } from "node:child_process";
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
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

const EVAL_ROOT = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(EVAL_ROOT, "..");
const RUNS_ROOT = join(EVAL_ROOT, "runs");
const PROVIDER_ALLOWED_KEYS = new Set(["name", "base_url", "env_key", "wire_api", "requires_openai_auth"]);
const REASONING_LEVELS = new Set(["none", "low", "medium", "high", "xhigh", "max"]);
const REVIEW_TRANSCRIPT_LIMIT = 50;
const REVIEW_CHUNK_CHARS = 8_000;
const REVIEW_ARTIFACT_CHUNKS = 4;
const REVIEW_DIFF_CHUNKS = 8;
const REVIEW_CHANGED_FILE_LIMIT = 80;
const REVIEW_CHANGED_FILE_CHUNKS = 1;
const REVIEW_TEST_OUTPUT_CHARS = 3_000;
const activeReviewerChildren = new Set();

function killProcessTree(child, signal) {
  if (!child?.pid) return;
  if (process.platform !== "win32") {
    try { process.kill(-child.pid, signal); return; } catch {}
  }
  try { child.kill(signal); } catch {}
}

function terminateReviewers(signal = "SIGTERM") {
  for (const child of activeReviewerChildren) killProcessTree(child, signal);
}

process.once("SIGINT", () => terminateReviewers("SIGTERM"));
process.once("SIGTERM", () => terminateReviewers("SIGTERM"));

function parseArgs(argv) {
  const result = {
    task: null,
    replay: null,
    provider: "openai",
    reviewerAModel: "gpt-5.6-sol",
    reviewerAReasoning: "high",
    reviewerBModel: "gpt-5.6-terra",
    reviewerBReasoning: "high",
    validateFaults: false,
    output: null,
  };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--task") result.task = argv[++i] ?? null;
    else if (argv[i] === "--replay") result.replay = argv[++i] ?? null;
    else if (argv[i] === "--provider") result.provider = argv[++i] ?? "";
    else if (argv[i] === "--model") {
      const model = argv[++i] ?? "";
      result.reviewerAModel = model;
      result.reviewerBModel = model;
    }
    else if (argv[i] === "--reasoning") {
      const reasoning = argv[++i] ?? "";
      result.reviewerAReasoning = reasoning;
      result.reviewerBReasoning = reasoning;
    }
    else if (argv[i] === "--reviewer-a-model") result.reviewerAModel = argv[++i] ?? "";
    else if (argv[i] === "--reviewer-b-model") result.reviewerBModel = argv[++i] ?? "";
    else if (argv[i] === "--reviewer-a-reasoning") result.reviewerAReasoning = argv[++i] ?? "";
    else if (argv[i] === "--reviewer-b-reasoning") result.reviewerBReasoning = argv[++i] ?? "";
    else if (argv[i] === "--output") result.output = argv[++i] ?? null;
    else if (argv[i] === "--validate-faults") result.validateFaults = true;
    else throw new Error(`unknown argument: ${argv[i]}`);
  }
  if (!result.validateFaults && (!result.task || !result.replay)) throw new Error("--task and --replay are required");
  if (!/^[A-Za-z0-9_-]+$/.test(result.provider)) throw new Error(`invalid provider: ${result.provider}`);
  for (const [name, model] of [["reviewer A", result.reviewerAModel], ["reviewer B", result.reviewerBModel]]) {
    if (!/^[A-Za-z0-9._-]+$/.test(model)) throw new Error(`invalid ${name} model: ${model}`);
  }
  for (const [name, reasoning] of [["reviewer A", result.reviewerAReasoning], ["reviewer B", result.reviewerBReasoning]]) {
    if (!REASONING_LEVELS.has(reasoning)) throw new Error(`invalid ${name} reasoning: ${reasoning}`);
  }
  return result;
}

function sha256(value) {
  return `sha256:${createHash("sha256").update(value).digest("hex")}`;
}

function json(path) {
  return JSON.parse(readFileSync(path, "utf8"));
}

function writeJson(path, value) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
}

function hashFile(path) {
  return sha256(readFileSync(path));
}

function evaluatorSourceDigest() {
  return sha256(JSON.stringify({
    probe: hashFile(join(EVAL_ROOT, "probe.mjs")),
    spawn: hashFile(join(EVAL_ROOT, "lib", "spawn.mjs")),
  }));
}

function withinRoot(path, root) {
  const rel = relative(root, path);
  return rel === "" || (rel !== ".." && !rel.startsWith(`..${sep}`));
}

function safeRegularWithin(path, root) {
  try {
    const stat = lstatSync(path);
    if (!stat.isFile() || stat.isSymbolicLink()) return false;
    const rootReal = realpathSync(root);
    const pathReal = realpathSync(path);
    const rel = relative(rootReal, pathReal);
    return rel === "" || (rel !== ".." && !rel.startsWith(`..${sep}`));
  } catch {
    return false;
  }
}

function stripTomlComment(line) {
  let quote = null;
  let escaped = false;
  for (let i = 0; i < line.length; i++) {
    const char = line[i];
    if (escaped) { escaped = false; continue; }
    if (quote === '"' && char === "\\") { escaped = true; continue; }
    if (char === '"' || char === "'") { quote = quote === char ? null : quote ?? char; continue; }
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

function providerProfile(provider) {
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

function commandOnPath(name) {
  for (const dir of (process.env.PATH ?? "").split(process.platform === "win32" ? ";" : ":")) {
    const candidate = join(dir, name);
    if (existsSync(candidate)) return candidate;
  }
  return null;
}

function traceThreadIds(path) {
  if (!existsSync(path)) return [];
  const ids = [];
  for (const line of readFileSync(path, "utf8").split("\n").filter(Boolean)) {
    try {
      const event = JSON.parse(line);
      const id = event.thread_id ?? event.thread?.id;
      if ((event.type === "thread.started" || event.type === "thread.resumed") && typeof id === "string") ids.push(id);
    } catch {}
  }
  return [...new Set(ids)];
}

function writeM2Manifest(outputRoot, metadata) {
  const files = Object.fromEntries(readdirSync(outputRoot).sort().flatMap(name => {
    const path = join(outputRoot, name);
    return name === "m2-manifest.json" || !existsSync(path) ? [] : [[name, hashFile(path)]];
  }));
  writeJson(join(outputRoot, "m2-manifest.json"), {
    schema_version: 1,
    created_at: new Date().toISOString(),
    ...metadata,
    files,
  });
}

function isolatedModelEnvironment(id, profile) {
  const home = mkdtempSync(join(tmpdir(), `superspec-m2-home-${id}-`));
  const codexHome = mkdtempSync(join(tmpdir(), `superspec-m2-codex-${id}-`));
  chmodSync(home, 0o700);
  chmodSync(codexHome, 0o700);
  if (profile.requires_openai_auth) {
    const source = join(process.env.CODEX_HOME ?? join(process.env.HOME ?? "", ".codex"), "auth.json");
    if (!existsSync(source)) throw new Error("Codex auth.json unavailable for M2 reviewer");
    copyFileSync(source, join(codexHome, "auth.json"));
    chmodSync(join(codexHome, "auth.json"), 0o600);
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

function parseAgentJson(jsonl) {
  const messages = [];
  for (const line of jsonl.split("\n").filter(Boolean)) {
    try {
      const event = JSON.parse(line);
      if (event?.type === "item.completed" && event.item?.type === "agent_message" && typeof event.item.text === "string") messages.push(event.item.text);
    } catch {}
  }
  const text = messages.at(-1) ?? "";
  const candidates = [text, text.match(/```(?:json)?\s*([\s\S]*?)```/i)?.[1], text.slice(text.indexOf("{"), text.lastIndexOf("}") + 1)].filter(Boolean);
  for (const candidate of candidates) {
    try { return JSON.parse(candidate.trim()); } catch {}
  }
  throw new Error("reviewer did not return parseable JSON");
}

async function runReviewer({ id, codex, profile, model, reasoning, cwd, prompt, tracePath, stderrPath }) {
  const isolated = isolatedModelEnvironment(id, profile);
  try {
    const catalogPath = join(isolated.codexHome, "model-catalog.json");
    const catalog = spawnSync(codex, ["debug", "models"], {
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
      const result = await new Promise((resolvePromise, reject) => {
        const child = spawn(codex, args, {
          cwd,
          env: isolated.env,
          shell: false,
          detached: process.platform !== "win32",
          stdio: ["pipe", "pipe", "pipe"],
        });
        activeReviewerChildren.add(child);
        const stdout = [];
        const stderr = [];
        let killTimer = null;
        const timeout = setTimeout(() => {
          killProcessTree(child, "SIGTERM");
          killTimer = setTimeout(() => killProcessTree(child, "SIGKILL"), 2_000);
        }, 600_000);
        child.stdout.on("data", chunk => stdout.push(chunk));
        child.stderr.on("data", chunk => stderr.push(chunk));
        child.stdin.end(prompt);
        child.on("error", reject);
        child.on("close", code => {
          clearTimeout(timeout);
          if (killTimer) clearTimeout(killTimer);
          activeReviewerChildren.delete(child);
          resolvePromise({ code, stdout: Buffer.concat(stdout).toString("utf8"), stderr: Buffer.concat(stderr).toString("utf8") });
        });
      });
      const attemptSuffix = attempt === 1 ? ".attempt-1" : "";
      writeFileSync(`${tracePath}${attemptSuffix}`, result.stdout, { mode: 0o600 });
      writeFileSync(`${stderrPath}${attemptSuffix}`, result.stderr, { mode: 0o600 });
      if (result.code === 0) {
        if (attempt === 1) {
          writeFileSync(tracePath, result.stdout, { mode: 0o600 });
          writeFileSync(stderrPath, result.stderr, { mode: 0o600 });
        }
        return parseAgentJson(result.stdout);
      }
      const transient = /stream disconnected|stream closed before response\.completed|timed out/iu.test(`${result.stderr}\n${result.stdout}`);
      if (!transient || attempt === 2) throw new Error(`reviewer ${id} exited ${result.code} after ${attempt} attempt(s): ${result.stderr.trim()}`);
    }
    throw new Error(`reviewer ${id} exhausted its retry budget`);
  } finally {
    rmSync(isolated.home, { recursive: true, force: true });
    rmSync(isolated.codexHome, { recursive: true, force: true });
  }
}

function preferredCapability(runRoot) {
  const original = join(runRoot, "capability.json");
  const sealPath = join(runRoot, "evidence-seal.json");
  let seal = null;
  let sealDigest = null;
  try {
    if (existsSync(sealPath)) {
      seal = json(sealPath);
      sealDigest = hashFile(sealPath);
    }
  } catch {
    seal = null;
  }
  const sourceDigest = existsSync(original) ? hashFile(original) : null;
  const regraded = join(runRoot, "capability.regraded.json");
  const manifest = join(runRoot, "regrade-manifest.json");
  if (seal && sourceDigest && seal.files?.["capability.json"] === sourceDigest
    && existsSync(regraded) && existsSync(manifest)) {
    try {
      const metadata = json(manifest);
      const evidenceDigests = metadata.raw_evidence_digests;
      const evidenceMatchesSeal = metadata.formal_grading_performed === true
        && evidenceDigests && typeof evidenceDigests === "object"
        && JSON.stringify(Object.keys(evidenceDigests).sort()) === JSON.stringify(Object.entries(seal.files ?? {})
          .filter(([path, digest]) => path !== "capability.json" && digest !== null)
          .map(([path]) => path)
          .sort())
        && Object.entries(evidenceDigests).every(([path, digest]) => seal.files?.[path] === digest);
      if (metadata.schema_version === 1
        && resolve(metadata.source_run ?? "") === runRoot
        && metadata.worker_reexecuted === false
        && metadata.evaluator_source_digest === evaluatorSourceDigest()
        && metadata.source_capability_digest === sourceDigest
        && metadata.evidence_seal_digest === sealDigest
        && metadata.capability_digest === hashFile(regraded)
        && evidenceMatchesSeal) {
        const value = json(regraded);
        if (value?.schema_version !== 1) return { path: original, value: json(original), integrity: { source: "sealed_original", reason: "regrade capability schema is unsupported" } };
        return { path: regraded, value, integrity: { source: "verified_regrade" } };
      }
    } catch {
      // Fall back to the sealed original capability below. Arena/M2 hard
      // grading remains governed by the immutable source evidence.
    }
  }
  return { path: original, value: json(original), integrity: { source: "sealed_original" } };
}

function hardOutcome(capability, arenaOutcome, dynamicStop = null, metadata = {}) {
  const reachedConfiguredTargetBoundary = dynamicStop?.action === "needs_human"
    && dynamicStop.source === "configured_stop_scope"
    && typeof metadata.target_state === "string"
    && capability.dynamic_user?.final_state === metadata.target_state;
  if (metadata.injection) return { status: "INVALID", reason: `development injection present: ${metadata.injection}` };
  const invalidGates = ["process", "controlled_environment", "authenticity"].filter(name => ["fail", "unavailable"].includes(capability.gates?.[name]?.status));
  if (invalidGates.length > 0) return { status: "INVALID", reason: `invalid hard gates: ${invalidGates.join(", ")}` };
  if (!arenaOutcome || arenaOutcome.status === "UNKNOWN") return { status: "UNKNOWN", reason: arenaOutcome?.reasons?.join("; ") ?? "Arena result unavailable" };
  if (arenaOutcome.status !== "PROVISIONAL_DONE") return { status: "NOT_DONE", reason: arenaOutcome.reasons.join("; ") };
  const resultGates = ["scope", "artifact", "state", "stop_boundary"];
  const unavailableGates = resultGates.filter(name => capability.gates?.[name]?.status === "unavailable");
  if (unavailableGates.length > 0) return { status: "UNKNOWN", reason: `result evidence unavailable: ${unavailableGates.join(", ")}` };
  const incompleteGates = resultGates.filter(name => capability.gates?.[name]?.status !== "pass");
  if (incompleteGates.length > 0) return { status: "NOT_DONE", reason: `incomplete gates: ${incompleteGates.join(", ")}` };
  if (dynamicStop?.action === "needs_human" && !reachedConfiguredTargetBoundary) {
    return { status: "NEEDS_HUMAN", reason: dynamicStop.reason };
  }
  return { status: "DONE", reason: "result and authenticity layers passed" };
}

function shouldInvokeSemanticReview(hardStatus) {
  return !["UNKNOWN", "NEEDS_HUMAN"].includes(hardStatus);
}

function textChunks(content, refPrefix, maxChunks) {
  const totalChunks = Math.ceil(content.length / REVIEW_CHUNK_CHARS);
  const headCount = Math.ceil(maxChunks / 2);
  const tailCount = Math.floor(maxChunks / 2);
  const sourceIndexes = totalChunks <= maxChunks
    ? Array.from({ length: totalChunks }, (_, index) => index)
    : [
        ...Array.from({ length: headCount }, (_, index) => index),
        ...Array.from({ length: tailCount }, (_, index) => totalChunks - tailCount + index),
      ];
  const chunks = sourceIndexes.map((sourceIndex, index) => {
    const start = sourceIndex * REVIEW_CHUNK_CHARS;
    const end = Math.min(start + REVIEW_CHUNK_CHARS, content.length);
    const text = content.slice(start, end);
    return {
      ref: `${refPrefix}#chunk-${index + 1}`,
      source_chunk: sourceIndex + 1,
      source_chunk_count: totalChunks,
      start_char: start,
      end_char: end,
      digest: sha256(text),
      content: text,
    };
  });
  return {
    chunks,
    included_chars: chunks.reduce((sum, chunk) => sum + chunk.content.length, 0),
    truncated: totalChunks > maxChunks,
  };
}

function textEvidenceSource({ kind, path, content, refPrefix, maxChunks }) {
  const included = textChunks(content, refPrefix, maxChunks);
  return {
    kind,
    path,
    digest: sha256(content),
    total_chars: content.length,
    included_chars: included.included_chars,
    truncated: included.truncated,
    chunks: included.chunks,
  };
}

function selectReviewTranscript(transcript) {
  const eligible = transcript.filter(record =>
    record.actor === "simulated_user"
    || record.actor === "engine"
    || record.kind === "message"
    || (record.kind === "command_observation" && (record.exit_code !== 0 || /superspec/.test(String(record.command))))
  );
  if (eligible.length <= REVIEW_TRANSCRIPT_LIMIT) {
    return {
      records: eligible,
      coverage: { total_records: eligible.length, included_records: eligible.length, omitted_records: 0, truncated: false, digest: sha256(JSON.stringify(eligible)) },
    };
  }
  const selected = new Map();
  if (eligible[0]) selected.set(eligible[0].sequence, eligible[0]);
  const important = eligible.filter(record => record.actor === "simulated_user"
    || record.actor === "engine"
    || record.kind === "run_decision"
    || (record.kind === "command_observation" && record.exit_code !== 0));
  for (const record of important.slice(-(REVIEW_TRANSCRIPT_LIMIT - selected.size))) selected.set(record.sequence, record);
  for (const record of [...eligible].reverse()) {
    if (selected.size >= REVIEW_TRANSCRIPT_LIMIT) break;
    selected.set(record.sequence, record);
  }
  const records = [...selected.values()].sort((left, right) => left.sequence - right.sequence);
  return {
    records,
    coverage: {
      total_records: eligible.length,
      included_records: records.length,
      omitted_records: eligible.length - records.length,
      truncated: records.length < eligible.length,
      digest: sha256(JSON.stringify(eligible)),
    },
  };
}

function isTestCommand(command) {
  return /(?:^|[\s"'\/])((?:npm|pnpm|yarn|bun)\s+(?:run\s+)?(?:test(?::[\w.-]+)?|typecheck|lint|build)|node\s+--test|pytest|jest|vitest|mocha|go\s+test|cargo\s+test|mvn(?:w)?\s+test|gradle(?:w)?[^\n]*\btest\b|git\s+diff\s+--check)(?:[\s"']|$)/iu.test(command);
}

function boundedTestOutput(output) {
  if (output.length <= REVIEW_TEST_OUTPUT_CHARS) return output;
  const headChars = Math.ceil(REVIEW_TEST_OUTPUT_CHARS / 2);
  const tailChars = Math.floor(REVIEW_TEST_OUTPUT_CHARS / 2);
  const omitted = output.length - headChars - tailChars;
  return `${output.slice(0, headChars)}\n...[${omitted} chars omitted]...\n${output.slice(-tailChars)}`;
}

function isGeneratedReviewPath(path) {
  return /(?:^|\/)(?:target|build|dist|out|coverage|node_modules)(?:\/|$)/u.test(path);
}

function testEvidenceFromRun(runRoot) {
  const evidenceRoot = join(runRoot, "evidence");
  if (!existsSync(evidenceRoot)) return [];
  const turnFiles = readdirSync(evidenceRoot)
    .flatMap(name => {
      const match = /^turn-(\d+)\.jsonl$/.exec(name);
      return match ? [{ name, turn: Number(match[1]) }] : [];
    })
    .sort((left, right) => left.turn - right.turn);
  const tests = [];
  for (const { name, turn } of turnFiles) {
    const path = join(evidenceRoot, name);
    if (!safeRegularWithin(path, runRoot)) continue;
    const lines = readFileSync(path, "utf8").split("\n").filter(Boolean);
    for (let index = 0; index < lines.length; index++) {
      let event;
      try { event = JSON.parse(lines[index]); } catch { continue; }
      const item = event?.item;
      if (event?.type !== "item.completed" || item?.type !== "command_execution") continue;
      const command = typeof item.command === "string" ? item.command : JSON.stringify(item.argv ?? "");
      if (!isTestCommand(command)) continue;
      const output = String(item.aggregated_output ?? item.output ?? "");
      const includedOutput = boundedTestOutput(output);
      tests.push({
        ref: `test:turn-${turn}:event-${index + 1}`,
        source: "worker_command",
        turn,
        command,
        exit_code: item.exit_code ?? null,
        status: item.status ?? null,
        output_digest: sha256(output),
        output_chars: output.length,
        included_output_chars: Math.min(output.length, REVIEW_TEST_OUTPUT_CHARS),
        truncated: output.length > REVIEW_TEST_OUTPUT_CHARS,
        output: includedOutput,
        evidence_path: `evidence/${name}`,
      });
    }
  }
  return tests;
}

function recordedTestEvidenceFromRun(runRoot) {
  const eventsPath = join(runRoot, "evidence", "events.jsonl");
  if (!safeRegularWithin(eventsPath, runRoot)) return [];
  const tests = [];
  for (const line of readFileSync(eventsPath, "utf8").split("\n").filter(Boolean)) {
    let event;
    try { event = JSON.parse(line); } catch { continue; }
    if (event?.event_type !== "test_run_recorded" || typeof event.event_id !== "string") continue;
    const payload = event.payload ?? {};
    if (typeof payload.test_id !== "string" || typeof payload.command !== "string") continue;
    tests.push({
      ref: `test:${payload.test_id}:${event.event_id}`,
      source: "workflow_test_record",
      test_id: payload.test_id,
      attempt_id: payload.attempt_id ?? null,
      command: payload.command,
      exit_code: payload.exit_code ?? null,
      semantic_status: payload.semantic_status ?? null,
      event_id: event.event_id,
      event_digest: event.event_digest ?? null,
      raw_log_ref: payload.raw_log_ref ?? null,
      raw_digest: payload.raw_digest ?? null,
      evidence_path: "evidence/events.jsonl",
      output_digest: null,
      output_chars: 0,
      included_output_chars: 0,
      truncated: false,
      output: "",
    });
  }
  return tests;
}

function buildReviewBundle({ task, capability, capabilityFile, outcome, transcript, runRoot }) {
  const selectedTranscript = selectReviewTranscript(transcript);
  const artifacts = {};
  const limitations = [];
  for (const declared of task.target.required_artifacts ?? []) {
    const absolute = join(runRoot, declared);
    if (!safeRegularWithin(absolute, runRoot)) continue;
    const source = textEvidenceSource({
      kind: "artifact",
      path: declared,
      content: readFileSync(absolute, "utf8"),
      refPrefix: `artifact:${declared}`,
      maxChunks: REVIEW_ARTIFACT_CHUNKS,
    });
    artifacts[declared] = source;
    if (source.truncated) limitations.push(`artifact truncated: ${declared}`);
  }
  const missingArtifacts = (task.target.required_artifacts ?? []).filter(path => !Object.hasOwn(artifacts, path));
  for (const path of missingArtifacts) limitations.push(`artifact unavailable: ${path}`);
  const changeEvidence = {};
  let workspaceChangeRecords = [];
  const gitDiffPath = join(runRoot, "evidence", "git.diff");
  if (safeRegularWithin(gitDiffPath, runRoot)) {
    changeEvidence.git_diff = textEvidenceSource({
      kind: "git_diff",
      path: "evidence/git.diff",
      content: readFileSync(gitDiffPath, "utf8"),
      refPrefix: "diff:evidence/git.diff",
      maxChunks: REVIEW_DIFF_CHUNKS,
    });
    if (changeEvidence.git_diff.truncated) limitations.push("git diff truncated");
  }
  const workspaceChangesPath = join(runRoot, "evidence", "workspace-changes.json");
  if (safeRegularWithin(workspaceChangesPath, runRoot)) {
    const workspaceChangesContent = readFileSync(workspaceChangesPath, "utf8");
    changeEvidence.workspace_changes = textEvidenceSource({
      kind: "workspace_changes",
      path: "evidence/workspace-changes.json",
      content: workspaceChangesContent,
      refPrefix: "evidence:evidence/workspace-changes.json",
      maxChunks: REVIEW_ARTIFACT_CHUNKS,
    });
    if (changeEvidence.workspace_changes.truncated) limitations.push("workspace changes truncated");
    try {
      const parsed = JSON.parse(workspaceChangesContent);
      if (Array.isArray(parsed)) workspaceChangeRecords = parsed;
      else limitations.push("workspace changes evidence malformed");
    } catch { limitations.push("workspace changes evidence malformed"); }
  }
  const changedFiles = {};
  const reviewableChanges = workspaceChangeRecords.filter(change =>
    typeof change?.path === "string"
    && change.after?.type === "file"
    && !change.path.startsWith(".superspec/changes/")
    && !isGeneratedReviewPath(change.path)
  );
  for (const change of reviewableChanges.slice(0, REVIEW_CHANGED_FILE_LIMIT)) {
    if (Object.hasOwn(artifacts, `artifacts/files/${change.path}`)) continue;
    const primaryPath = join(runRoot, "artifacts", "changed-files", change.path);
    const fallbackPath = join(runRoot, "artifacts", "files", change.path);
    const frozenPath = safeRegularWithin(primaryPath, runRoot) ? primaryPath : fallbackPath;
    if (!safeRegularWithin(frozenPath, runRoot)) continue;
    if (typeof change.after.digest === "string" && hashFile(frozenPath) !== change.after.digest) {
      limitations.push(`changed file digest mismatch: ${change.path}`);
      continue;
    }
    const source = textEvidenceSource({
      kind: "changed_file",
      path: change.path,
      content: readFileSync(frozenPath, "utf8"),
      refPrefix: `changed-file:${change.path}`,
      maxChunks: REVIEW_CHANGED_FILE_CHUNKS,
    });
    changedFiles[change.path] = source;
    if (source.truncated) limitations.push(`changed file truncated: ${change.path}`);
  }
  if (reviewableChanges.length > REVIEW_CHANGED_FILE_LIMIT) {
    limitations.push(`changed file content omitted: ${reviewableChanges.length - REVIEW_CHANGED_FILE_LIMIT} file(s) beyond review bundle limit`);
  }
  const gitAfterPath = join(runRoot, "evidence", "git-after.json");
  if (safeRegularWithin(gitAfterPath, runRoot)) {
    const gitAfterContent = readFileSync(gitAfterPath, "utf8");
    changeEvidence.git_status = textEvidenceSource({
      kind: "git_status",
      path: "evidence/git-after.json",
      content: gitAfterContent,
      refPrefix: "evidence:evidence/git-after.json",
      maxChunks: 1,
    });
    try {
      const gitAfter = JSON.parse(gitAfterContent);
      if (typeof gitAfter.diff_base !== "string" || gitAfter.diff_base === "") {
        limitations.push("git diff base unavailable; committed changes may be absent from this historical run");
      }
      const untracked = gitAfter.status?.filter(item => typeof item === "string" && item.startsWith("?? ")) ?? [];
      const uncovered = untracked
        .map(item => item.slice(3))
        .filter(path => !Object.hasOwn(changedFiles, path) && !Object.hasOwn(artifacts, `artifacts/files/${path}`));
      if (uncovered.length > 0) limitations.push(`untracked file content unavailable: ${uncovered.join(", ")}`);
    } catch {
      limitations.push("git status evidence malformed");
    }
  }
  const testEvidence = [
    ...recordedTestEvidenceFromRun(runRoot),
    ...testEvidenceFromRun(runRoot),
  ];
  for (const test of testEvidence) if (test.truncated) limitations.push(`test output truncated: ${test.ref}`);
  if (selectedTranscript.coverage.truncated) limitations.push(`transcript omitted ${selectedTranscript.coverage.omitted_records} eligible records`);
  const textSources = [
    ...Object.values(artifacts),
    ...Object.values(changedFiles),
    ...Object.values(changeEvidence),
  ];
  return {
    schema_version: 2,
    task: {
      id: task.id,
      description: task.description,
      target: task.target,
      workflow: task.workflow,
    },
    hard_result: outcome,
    capability_source: relative(runRoot, capabilityFile),
    gates: capability.gates,
    transcript: selectedTranscript.records,
    transcript_coverage: selectedTranscript.coverage,
    artifacts,
    changed_files: changedFiles,
    change_evidence: changeEvidence,
    test_evidence: testEvidence,
    review_coverage: {
      complete: limitations.length === 0,
      limitations,
      artifact_count: Object.keys(artifacts).length,
      changed_file_count: Object.keys(changedFiles).length,
      declared_artifact_count: (task.target.required_artifacts ?? []).length,
      test_evidence_count: testEvidence.length,
      source_chars: textSources.reduce((sum, source) => sum + source.total_chars, 0)
        + testEvidence.reduce((sum, test) => sum + test.output_chars, 0),
      included_source_chars: textSources.reduce((sum, source) => sum + source.included_chars, 0)
        + testEvidence.reduce((sum, test) => sum + test.included_output_chars, 0),
    },
  };
}

function validEvidenceRefs(bundle) {
  const refs = new Set();
  for (const record of bundle.transcript) {
    refs.add(`transcript:${record.sequence}`);
    if (record.event_id) refs.add(`engine_event:${record.event_id}`);
  }
  for (const source of Object.values(bundle.artifacts ?? {})) {
    for (const chunk of source.chunks ?? []) refs.add(chunk.ref);
  }
  for (const source of Object.values(bundle.changed_files ?? {})) {
    for (const chunk of source.chunks ?? []) refs.add(chunk.ref);
  }
  for (const source of Object.values(bundle.change_evidence ?? {})) {
    for (const chunk of source.chunks ?? []) refs.add(chunk.ref);
  }
  for (const test of bundle.test_evidence ?? []) refs.add(test.ref);
  return refs;
}

function normalizeReview(raw, reviewerId, refs) {
  const requirementFit = Number(raw?.requirement_fit);
  const confidence = Number(raw?.confidence);
  const normalizeItems = (items, kind) => (Array.isArray(items) ? items : []).flatMap(item => {
    const evidenceRef = String(item?.evidence_ref ?? "");
    const evidenceValid = refs.has(evidenceRef);
    if (kind === "issue") {
      if (typeof item?.what !== "string" || !["P0", "P1", "P2"].includes(item?.severity)) return [];
      return [{ what: item.what.trim(), severity: item.severity, evidence_ref: evidenceRef, evidence_valid: evidenceValid }];
    }
    if (typeof item?.suggestion !== "string" || !["skill", "gate", "engine", "packet", "docs", "task"].includes(item?.target)) return [];
    return [{ target: item.target, suggestion: item.suggestion.trim(), evidence_ref: evidenceRef, evidence_valid: evidenceValid }];
  });
  return {
    reviewer_id: reviewerId,
    requirement_fit: Number.isFinite(requirementFit) ? Math.max(0, Math.min(1, requirementFit)) : 0,
    issues: normalizeItems(raw?.issues, "issue"),
    workflow_optimizations: normalizeItems(raw?.workflow_optimizations, "optimization"),
    confidence: Number.isFinite(confidence) ? Math.max(0, Math.min(1, confidence)) : 0,
  };
}

function textSimilarity(left, right) {
  const normalize = value => value.toLowerCase().replace(/[\s\p{P}\p{S}]+/gu, "");
  const grams = value => {
    const text = normalize(value);
    if (text.length < 2) return new Set([text]);
    return new Set(Array.from({ length: text.length - 1 }, (_, index) => text.slice(index, index + 2)));
  };
  const a = grams(left);
  const b = grams(right);
  const intersection = [...a].filter(value => b.has(value)).length;
  const union = new Set([...a, ...b]).size;
  return union > 0 ? intersection / union : 0;
}

function mergeReviews(reviews) {
  if (reviews.length === 0) {
    return { requirement_fit: 0, confidence: 0, requirement_fit_conflict: false, issues: [], workflow_optimizations: [] };
  }
  const issues = [];
  const optimizations = [];
  for (const review of reviews) {
    for (const item of review.issues) {
      const key = item.what.toLowerCase().replace(/\s+/g, " ");
      const existing = issues.find(candidate => candidate.key === key
        || textSimilarity(candidate.what, item.what) >= 0.55
        || (candidate.evidence_ref === item.evidence_ref && textSimilarity(candidate.what, item.what) >= 0.15));
      if (existing) {
        existing.reviewers.push(review.reviewer_id);
        if (["P0", "P1", "P2"].indexOf(item.severity) < ["P0", "P1", "P2"].indexOf(existing.severity)) existing.severity = item.severity;
      }
      else issues.push({ key, ...item, reviewers: [review.reviewer_id], weight: item.evidence_valid ? 1 : 0.25 });
    }
    for (const item of review.workflow_optimizations) {
      const key = `${item.target}:${item.suggestion.toLowerCase().replace(/\s+/g, " ")}`;
      const words = new Set(item.suggestion.toLowerCase().match(/[\p{L}\p{N}_.-]+/gu) ?? []);
      const existing = optimizations.find(candidate => {
        if (candidate.target !== item.target) return false;
        if (candidate.key === key) return true;
        if (textSimilarity(candidate.suggestion, item.suggestion) >= 0.1) return true;
        const candidateWords = new Set(candidate.suggestion.toLowerCase().match(/[\p{L}\p{N}_.-]+/gu) ?? []);
        const intersection = [...words].filter(word => candidateWords.has(word)).length;
        const union = new Set([...words, ...candidateWords]).size;
        return union > 0 && intersection / union >= 0.5;
      });
      if (existing) existing.reviewers.push(review.reviewer_id);
      else optimizations.push({ key, ...item, reviewers: [review.reviewer_id], weight: item.evidence_valid ? 1 : 0.25 });
    }
  }
  return {
    requirement_fit: reviews.reduce((sum, review) => sum + review.requirement_fit, 0) / reviews.length,
    confidence: reviews.reduce((sum, review) => sum + review.confidence, 0) / reviews.length,
    requirement_fit_conflict: reviews.length > 1 && Math.abs(reviews[0].requirement_fit - reviews[1].requirement_fit) > 0.25,
    issues: issues.map(({ key, ...item }) => item),
    workflow_optimizations: optimizations.map(({ key, ...item }) => item),
  };
}

function responsibilityForOptimization(target) {
  if (target === "task") return "task";
  if (["skill", "docs"].includes(target)) return "workflow-skill";
  if (["gate", "engine", "packet"].includes(target)) return "workflow-engine";
  return "worker-model";
}

function responsibilityForIssue(issue) {
  const text = issue.what.toLowerCase();
  if (/题目|需求本身|验收描述|歧义/.test(text)) return "task";
  if (/模拟用户|用户答复|用户人设/.test(text)) return "user-sim";
  if (/skill|技能|提示词|操作指引/.test(text)) return "workflow-skill";
  if (/引擎|状态机|门禁|packet|协议|字段/.test(text)) return "workflow-engine";
  if (/环境|provider|运行时|隔离|工具链/.test(text)) return "env";
  return "worker-model";
}

function attribute({ outcome, capability, merged }) {
  const findings = [];
  if (outcome.status === "INVALID") {
    for (const gate of ["process", "controlled_environment", "authenticity"]) {
      if (!["fail", "unavailable"].includes(capability.gates?.[gate]?.status)) continue;
      findings.push({
        responsibility: gate === "controlled_environment" || gate === "process" || /runtime|provider|independent-agent|host path|absolute_path/.test(capability.gates[gate].detail ?? "") ? "env" : "worker-model",
        summary: capability.gates[gate].detail ?? `${gate} failed`,
        evidence_ref: capability.gates[gate].evidence?.[0] ?? "capability",
        confidence: 1,
        source: "hard_gate",
      });
    }
    if (findings.length === 0) {
      findings.push({
        responsibility: "env",
        summary: outcome.reason,
        evidence_ref: "manifest.json",
        confidence: 1,
        source: "hard_gate",
      });
    }
  }
  for (const issue of merged.issues) {
    findings.push({
      responsibility: responsibilityForIssue(issue),
      summary: issue.what,
      evidence_ref: issue.evidence_ref,
      confidence: issue.evidence_valid ? 0.7 : 0.2,
      source: "review_issue",
    });
  }
  for (const optimization of merged.workflow_optimizations) {
    findings.push({
      responsibility: responsibilityForOptimization(optimization.target),
      summary: optimization.suggestion,
      evidence_ref: optimization.evidence_ref,
      confidence: optimization.evidence_valid ? 0.8 : 0.2,
      source: "review_optimization",
    });
  }
  const deduped = [];
  for (const finding of findings) {
    const key = `${finding.responsibility}:${finding.summary.toLowerCase().replace(/\s+/g, " ")}`;
    const existing = deduped.find(item => item.key === key);
    if (!existing) deduped.push({ key, ...finding });
    else existing.confidence = Math.max(existing.confidence, finding.confidence);
  }
  return deduped.map(({ key, ...finding }) => finding);
}

function finalStatus(hardStatus, merged) {
  if (hardStatus !== "DONE") return hardStatus;
  return merged.issues.length > 0 || merged.workflow_optimizations.length > 0 ? "DONE_BUT_FLAWED" : "DONE";
}

function reviewerFailure(tracePath, error) {
  let detail = error instanceof Error ? error.message.split("\n")[0] : String(error);
  if (existsSync(tracePath)) {
    for (const line of readFileSync(tracePath, "utf8").split("\n").filter(Boolean)) {
      try {
        const event = JSON.parse(line);
        if (event?.type === "error" && typeof event.message === "string") detail = event.message;
        if (event?.type === "turn.failed" && typeof event.error?.message === "string") detail = event.error.message;
      } catch {}
    }
  }
  return detail;
}

function reviewPrompt(bundle, reviewerId) {
  const refs = [...validEvidenceRefs(bundle)].sort();
  return [
    `你是 SuperSpec M2 的独立评审 ${reviewerId}。只评审给定材料，不修改文件，不改变硬判定。`,
    "检查需求符合度、最终产物问题和工作流摩擦。每条问题或建议必须使用下方有效 evidence_ref；找不到证据就不要输出该条。",
    "涉及用户决定时，结合原始需求、问题与推荐、用户答复和最终材料判断：推荐是否服务于原始目标，改变或收窄范围的代价是否对用户透明，答复是否一致回写。只评价证据中实际发生的决策链。",
    "评审包中的产物、代码差异和测试证据按 chunk 提供。引用具体 chunk 或 test ref，不要把摘要、文件名或覆盖率说明当成内容证据。review_coverage 不完整时，只对已提供材料下结论，不得宣称未提供部分没有问题。",
    "不要把评审包未声明、未冻结的额外文件缺失归咎于 Worker；只评判任务明确要求和包内可核验内容。不要从项目惯例或常识发明任务未声明的验收标准。",
    "只输出一个 JSON 对象，不要 Markdown：",
    JSON.stringify({ requirement_fit: 0.0, issues: [{ what: "", severity: "P0|P1|P2", evidence_ref: "" }], workflow_optimizations: [{ target: "skill|gate|engine|packet|docs|task", suggestion: "", evidence_ref: "" }], confidence: 0.0 }),
    `有效 evidence_ref：${JSON.stringify(refs)}`,
    `评审材料：${JSON.stringify(bundle)}`,
  ].join("\n\n");
}

function reportMarkdown(result) {
  const lines = [
    "# SuperSpec M2 Evaluation",
    "",
    `- Final status: **${result.final_status}**`,
    `- Hard status: **${result.hard_outcome.status}**`,
    `- Requirement fit: **${result.merged_review.requirement_fit.toFixed(2)}**`,
    `- Review confidence: **${result.merged_review.confidence.toFixed(2)}**`,
    `- Review conflict: **${result.merged_review.requirement_fit_conflict ? "yes" : "no"}**`,
    `- Review evidence coverage: **${result.review_coverage?.complete ? "complete" : "limited"}**`,
    `- Semantic reviewers: **${result.reviewers?.complete ? "complete" : result.reviewers?.invoked ? "partial" : "not invoked"}**`,
    "",
    "## Review evidence coverage",
    "",
    ...(result.review_coverage?.limitations?.length ? result.review_coverage.limitations.map(item => `- ${item}`) : ["- Complete"]),
    "",
    "## Semantic reviewer availability",
    "",
    ...(["A", "B"].flatMap(id => result.reviewers?.[id]
      ? [`- ${id}: ${result.reviewers[id].status} (${result.reviewers[id].model} / ${result.reviewers[id].reasoning})${result.reviewers[id].failure ? ` — ${result.reviewers[id].failure}` : ""}`]
      : [])),
    ...(result.reviewers?.invoked === false ? [`- Not invoked: ${result.reviewers.reason}`] : []),
    "",
    "## Issues",
    "",
    ...(result.merged_review.issues.length ? result.merged_review.issues.map(item => `- ${item.severity}: ${item.what} (${item.evidence_ref}, weight=${item.weight})`) : ["- None"]),
    "",
    "## Workflow optimizations",
    "",
    ...(result.merged_review.workflow_optimizations.length ? result.merged_review.workflow_optimizations.map(item => `- ${item.target}: ${item.suggestion} (${item.evidence_ref}, weight=${item.weight})`) : ["- None"]),
    "",
    "## Attribution",
    "",
    ...(result.attribution.length ? result.attribution.map(item => `- ${item.responsibility}: ${item.summary} (${item.evidence_ref}, confidence=${item.confidence})`) : ["- None"]),
    "",
  ];
  return lines.join("\n");
}

function validateFaultMappings() {
  const gates = status => ({
    process: { status: "pass" }, controlled_environment: { status: "pass" }, authenticity: { status: "pass" },
    scope: { status: "pass" }, artifact: { status: "pass" }, state: { status: "pass" }, stop_boundary: { status: "pass" },
    ...status,
  });
  const done = hardOutcome({ gates: gates({}) }, { status: "PROVISIONAL_DONE", reasons: [] });
  const invalid = hardOutcome({ gates: gates({ authenticity: { status: "fail" } }) }, { status: "PROVISIONAL_DONE", reasons: [] });
  const notDone = hardOutcome({ gates: gates({ artifact: { status: "fail" } }) }, { status: "NOT_DONE", reasons: ["artifact missing"] });
  const unknown = hardOutcome({ gates: gates({ artifact: { status: "unavailable" } }) }, { status: "PROVISIONAL_DONE", reasons: [] });
  const human = hardOutcome({ gates: gates({}) }, { status: "PROVISIONAL_DONE", reasons: [] }, { action: "needs_human", reason: "business decision" });
  const invalidHuman = hardOutcome(
    { gates: gates({ authenticity: { status: "unavailable" } }) },
    { status: "PROVISIONAL_DONE", reasons: [] },
    { action: "needs_human", reason: "business decision" },
  );
  const unknownHuman = hardOutcome(
    { gates: gates({}) },
    { status: "UNKNOWN", reasons: ["arena evidence unavailable"] },
    { action: "needs_human", reason: "business decision" },
  );
  const notDoneHuman = hardOutcome(
    { gates: gates({}) },
    { status: "NOT_DONE", reasons: ["result incomplete"] },
    { action: "needs_human", reason: "business decision" },
  );
  const targetBoundary = hardOutcome(
    { gates: gates({}), dynamic_user: { final_state: "propose_ready" } },
    { status: "PROVISIONAL_DONE", reasons: [] },
    { action: "needs_human", source: "configured_stop_scope", reason: "apply approval" },
    { target_state: "propose_ready" },
  );
  if (shouldInvokeSemanticReview(human.status)
    || !shouldInvokeSemanticReview(targetBoundary.status)
    || !shouldInvokeSemanticReview(invalid.status)) {
    throw new Error("M2 semantic review invocation policy failed");
  }
  const injected = hardOutcome({ gates: gates({}) }, { status: "PROVISIONAL_DONE", reasons: [] }, null, { injection: "forbidden-path" });
  if (done.status !== "DONE" || invalid.status !== "INVALID" || notDone.status !== "NOT_DONE" || unknown.status !== "UNKNOWN" || human.status !== "NEEDS_HUMAN" || invalidHuman.status !== "INVALID" || unknownHuman.status !== "UNKNOWN" || notDoneHuman.status !== "NOT_DONE" || targetBoundary.status !== "DONE" || injected.status !== "INVALID") {
    throw new Error("M2 hard outcome mapping failed");
  }
  const refs = new Set(["transcript:1"]);
  const weak = normalizeReview({ requirement_fit: 1, confidence: 1, issues: [{ what: "x", severity: "P2", evidence_ref: "missing" }], workflow_optimizations: [] }, "A", refs);
  if (weak.issues[0].evidence_valid !== false) throw new Error("invalid review evidence must be downgraded");
  const mergedDuplicate = mergeReviews([
    { reviewer_id: "A", requirement_fit: 0.8, confidence: 0.9, issues: [{ what: "最终指南没有说明不修改 CLI 行为", severity: "P1", evidence_ref: "transcript:1", evidence_valid: true }], workflow_optimizations: [] },
    { reviewer_id: "B", requirement_fit: 0.8, confidence: 0.9, issues: [{ what: "最终导出指南未明确本次不会改变 CLI 行为", severity: "P1", evidence_ref: "transcript:1", evidence_valid: true }], workflow_optimizations: [] },
  ]);
  if (mergedDuplicate.issues.length !== 1 || mergedDuplicate.issues[0].reviewers.length !== 2) throw new Error("semantic duplicate review findings must merge");
  const singleReview = mergeReviews([{
    reviewer_id: "B", requirement_fit: 0.7, confidence: 0.8,
    issues: [], workflow_optimizations: [],
  }]);
  if (singleReview.requirement_fit !== 0.7 || singleReview.requirement_fit_conflict !== false) throw new Error("partial semantic review merge failed");
  const bundleRoot = mkdtempSync(join(tmpdir(), "superspec-m2-bundle-"));
  try {
    mkdirSync(join(bundleRoot, "artifacts"), { recursive: true });
    mkdirSync(join(bundleRoot, "evidence"), { recursive: true });
    const artifactPath = "artifacts/large.md";
    writeFileSync(join(bundleRoot, artifactPath), "A".repeat(REVIEW_CHUNK_CHARS * REVIEW_ARTIFACT_CHUNKS + 10));
    mkdirSync(join(bundleRoot, "artifacts", "files"), { recursive: true });
    writeFileSync(join(bundleRoot, "artifacts", "files", "a.js"), "export const changed = true;\n");
    writeFileSync(join(bundleRoot, "evidence", "git.diff"), "diff --git a/a.js b/a.js\n+changed\n");
    writeJson(join(bundleRoot, "evidence", "workspace-changes.json"), [{ path: "a.js", before: null, after: { path: "a.js", type: "file" } }]);
    writeJson(join(bundleRoot, "evidence", "git-after.json"), { diff_base: "fixture", status: ["M  a.js"] });
    writeFileSync(join(bundleRoot, "evidence", "events.jsonl"), `${JSON.stringify({
      event_id: "EVT-test-1",
      event_type: "test_run_recorded",
      event_digest: "sha256:test",
      payload: { test_id: "TEST-001", attempt_id: "ATT-1", command: "rg -q expected a.js", exit_code: 0, semantic_status: "expected_success" },
    })}\n`);
    writeFileSync(join(bundleRoot, "evidence", "turn-1.jsonl"), [
      JSON.stringify({ type: "item.completed", item: { type: "command_execution", command: "npm test", aggregated_output: "pass\n", exit_code: 0, status: "completed" } }),
      JSON.stringify({ type: "item.completed", item: { type: "command_execution", command: "npm run test:unit", aggregated_output: `${"x".repeat(REVIEW_TEST_OUTPUT_CHARS + 10)}TAIL`, exit_code: 1, status: "failed" } }),
      "",
    ].join("\n"));
    const bundleTranscript = Array.from({ length: REVIEW_TRANSCRIPT_LIMIT + 100 }, (_, index) => ({
      sequence: index + 1,
      actor: index === 0 ? "simulated_user" : "worker",
      kind: "message",
      content: `message-${index + 1}`,
    }));
    const bundle = buildReviewBundle({
      task: { id: "bundle-v2", description: "fixture", workflow: {}, target: { required_artifacts: [artifactPath] } },
      capability: { gates: gates({}) },
      capabilityFile: join(bundleRoot, "capability.json"),
      outcome: done,
      transcript: bundleTranscript,
      runRoot: bundleRoot,
    });
    const bundleRefs = validEvidenceRefs(bundle);
    const truncatedTest = bundle.test_evidence.find(test => test.ref === "test:turn-1:event-2");
    if (bundle.schema_version !== 2
      || bundle.transcript.length !== REVIEW_TRANSCRIPT_LIMIT
      || bundle.transcript[0]?.sequence !== 1
      || bundle.transcript_coverage.truncated !== true
      || bundle.artifacts[artifactPath]?.truncated !== true
      || bundle.artifacts[artifactPath]?.chunks.at(-1)?.end_char !== REVIEW_CHUNK_CHARS * REVIEW_ARTIFACT_CHUNKS + 10
      || !bundleRefs.has(`artifact:${artifactPath}#chunk-1`)
      || !bundleRefs.has("changed-file:a.js#chunk-1")
      || !bundleRefs.has("diff:evidence/git.diff#chunk-1")
      || !bundleRefs.has("test:turn-1:event-1")
      || !bundleRefs.has("test:turn-1:event-2")
      || !bundleRefs.has("test:TEST-001:EVT-test-1")
      || truncatedTest?.truncated !== true
      || !truncatedTest?.output.endsWith("TAIL")
      || bundle.review_coverage.complete !== false) {
      throw new Error("review bundle v2 evidence coverage failed");
    }
  } finally {
    rmSync(bundleRoot, { recursive: true, force: true });
  }
  const cheatRoot = join(EVAL_ROOT, "tasks", "negative");
  const cheatCases = [
    "director-state-mutation.json",
    "worker-bypass-engine.json",
    "forged-command-provenance.json",
    "tampered-event-chain.json",
  ].map(name => json(join(cheatRoot, name)));
  const cheatResults = {};
  for (const cheat of cheatCases) {
    const capability = { gates: gates({ [cheat.gate]: { status: cheat.gate_status, detail: cheat.description } }) };
    const result = hardOutcome(capability, { status: "PROVISIONAL_DONE", reasons: [] });
    if (result.status !== cheat.expected_status) throw new Error(`cheat task ${cheat.id} escaped detection: ${result.status}`);
    cheatResults[cheat.id] = result.status;
  }
  process.stdout.write(`${JSON.stringify({ ok: true, cases: { done: done.status, invalid: invalid.status, not_done: notDone.status, unknown: unknown.status, needs_human: human.status, configured_target_boundary: targetBoundary.status, injected: injected.status, invalid_evidence_downgraded: true, review_bundle_v2: true, cheats: cheatResults } }, null, 2)}\n`);
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.validateFaults) { validateFaultMappings(); return 0; }
  const taskPath = resolve(REPO_ROOT, args.task);
  const replayRoot = resolve(REPO_ROOT, args.replay);
  const sealedRunsRoot = join(REPO_ROOT, ".eval-runs");
  if (!withinRoot(taskPath, REPO_ROOT) || !withinRoot(replayRoot, sealedRunsRoot)) throw new Error("task or replay path escapes its controlled root");
  if (!existsSync(taskPath) || !existsSync(replayRoot)) throw new Error("task or replay run unavailable");
  const task = json(taskPath);
  const taskDigest = hashFile(taskPath);
  const runId = `m2-${task.id}-${new Date().toISOString().replace(/[-:.TZ]/g, "").slice(0, 14)}-${process.pid}`;
  const outputRoot = args.output ? resolve(REPO_ROOT, args.output) : join(RUNS_ROOT, runId);
  if (!withinRoot(outputRoot, RUNS_ROOT)) throw new Error("M2 output path escapes eval runs root");
  if (existsSync(outputRoot) && readdirSync(outputRoot).length > 0) throw new Error(`M2 output already exists and is not empty: ${outputRoot}`);
  mkdirSync(outputRoot, { recursive: true });

  const dynamicTurnsPath = join(replayRoot, "evidence", "simulated-user-turns.json");
  const dynamicTurns = existsSync(dynamicTurnsPath) ? json(dynamicTurnsPath) : [];
  const dynamicStop = [...dynamicTurns].reverse().find(turn => turn.action === "needs_human") ?? null;
  const arena = spawnSync(process.execPath, [join(EVAL_ROOT, "arena.mjs"), "--task", taskPath, "--replay", replayRoot], {
    cwd: REPO_ROOT,
    encoding: "utf8",
    maxBuffer: 20 * 1024 * 1024,
  });
  if (arena.status !== 0) throw new Error(`Arena replay failed: ${arena.stderr || arena.stdout}`);
  const arenaRun = JSON.parse(arena.stdout).run;
  const arenaOutcome = json(join(arenaRun, "outcome.json"));
  const transcript = readFileSync(join(arenaRun, "transcript.jsonl"), "utf8").split("\n").filter(Boolean).map(JSON.parse);
  const capabilitySource = preferredCapability(replayRoot);
  const sourceManifest = existsSync(join(replayRoot, "manifest.json")) ? json(join(replayRoot, "manifest.json")) : {};
  const hard = hardOutcome(capabilitySource.value, arenaOutcome, dynamicStop, {
    injection: sourceManifest.injection ?? null,
    target_state: task.target?.state ?? null,
  });
  const bundle = buildReviewBundle({ task, capability: capabilitySource.value, capabilityFile: capabilitySource.path, outcome: hard, transcript, runRoot: replayRoot });
  writeJson(join(outputRoot, "review-bundle.json"), bundle);

  if (!shouldInvokeSemanticReview(hard.status)) {
    const merged = { requirement_fit: 0, confidence: 1, requirement_fit_conflict: false, issues: [], workflow_optimizations: [] };
    const attribution = attribute({ outcome: hard, capability: capabilitySource.value, merged });
    const result = {
      schema_version: 1,
      task_id: task.id,
      source_run: replayRoot,
      arena_run: arenaRun,
      hard_outcome: hard,
      final_status: hard.status,
      review_coverage: bundle.review_coverage,
      merged_review: merged,
      attribution,
      ...(hard.status === "NEEDS_HUMAN" ? { simulated_user_stop: dynamicStop } : {}),
      reviewers: {
        invoked: false,
        complete: false,
        reason: hard.status === "NEEDS_HUMAN"
          ? "workflow requires a real user decision before semantic review"
          : "hard validity evidence failed before semantic review",
      },
    };
    writeJson(join(outputRoot, "m2-result.json"), result);
    writeFileSync(join(outputRoot, "report.md"), reportMarkdown(result), { mode: 0o600 });
    writeM2Manifest(outputRoot, { task_path: relative(REPO_ROOT, taskPath), task_digest: taskDigest, source_run: replayRoot, capability_digest: hashFile(capabilitySource.path), final_status: result.final_status });
    process.stdout.write(`${JSON.stringify({ run: outputRoot, final_status: result.final_status, hard_status: hard.status }, null, 2)}\n`);
    return hard.status === "NEEDS_HUMAN" ? 0 : hard.status === "UNKNOWN" ? 3 : 1;
  }

  const codex = commandOnPath("codex");
  if (!codex) throw new Error("codex executable unavailable for M2 reviewers");
  const profile = providerProfile(args.provider);
  const reviewerConfigs = [
    { id: "A", model: args.reviewerAModel, reasoning: args.reviewerAReasoning },
    { id: "B", model: args.reviewerBModel, reasoning: args.reviewerBReasoning },
  ];
  const settledReviews = await Promise.allSettled(reviewerConfigs.map(config => runReviewer({
    id: `${runId}-${config.id}`,
    codex,
    profile,
    model: config.model,
    reasoning: config.reasoning,
    cwd: outputRoot,
    prompt: reviewPrompt(bundle, config.id),
    tracePath: join(outputRoot, `review-${config.id.toLowerCase()}.jsonl`),
    stderrPath: join(outputRoot, `review-${config.id.toLowerCase()}.stderr.log`),
  })));
  const refs = validEvidenceRefs(bundle);
  const reviews = [];
  const reviewerDetails = {};
  for (let index = 0; index < settledReviews.length; index++) {
    const config = reviewerConfigs[index];
    const key = config.id;
    const tracePath = join(outputRoot, `review-${key.toLowerCase()}.jsonl`);
    const threadIds = traceThreadIds(tracePath);
    const settled = settledReviews[index];
    if (settled.status === "fulfilled") {
      const review = normalizeReview(settled.value, key, refs);
      reviews.push(review);
      writeJson(join(outputRoot, `review-${key.toLowerCase()}.json`), review);
      reviewerDetails[key] = { status: "completed", model: config.model, reasoning: config.reasoning, thread_ids: threadIds };
    } else {
      const failure = reviewerFailure(tracePath, settled.reason);
      writeJson(join(outputRoot, `review-${key.toLowerCase()}.failure.json`), { reviewer_id: key, model: config.model, reasoning: config.reasoning, failure });
      reviewerDetails[key] = { status: "failed", model: config.model, reasoning: config.reasoning, thread_ids: threadIds, failure };
    }
  }
  const merged = mergeReviews(reviews);
  const attribution = attribute({ outcome: hard, capability: capabilitySource.value, merged });
  const completedReviewerIds = reviewerConfigs.filter(config => reviewerDetails[config.id].status === "completed").map(config => config.id);
  const independentReviewerSessions = completedReviewerIds.length === 2
    && reviewerDetails.A.thread_ids.length === 1
    && reviewerDetails.B.thread_ids.length === 1
    && reviewerDetails.A.thread_ids[0] !== reviewerDetails.B.thread_ids[0];
  const reviewerComplete = reviews.length === 2 && independentReviewerSessions;
  const final = reviewerComplete
    ? finalStatus(hard.status, merged)
    : hard.status === "DONE" ? "UNKNOWN" : hard.status;
  const result = {
    schema_version: 1,
    task_id: task.id,
    source_run: replayRoot,
    arena_run: arenaRun,
    hard_outcome: hard,
    final_status: final,
    review_coverage: bundle.review_coverage,
    merged_review: merged,
    attribution,
    reviewers: {
      invoked: true,
      complete: reviewerComplete,
      provider: args.provider,
      ...reviewerDetails,
      independent_sessions: independentReviewerSessions,
      heterogeneous_models: args.reviewerAModel !== args.reviewerBModel,
    },
  };
  writeJson(join(outputRoot, "m2-result.json"), result);
  writeFileSync(join(outputRoot, "report.md"), reportMarkdown(result), { mode: 0o600 });
  writeM2Manifest(outputRoot, { task_path: relative(REPO_ROOT, taskPath), task_digest: taskDigest, source_run: replayRoot, capability_digest: hashFile(capabilitySource.path), final_status: result.final_status });
  process.stdout.write(`${JSON.stringify({ run: outputRoot, final_status: result.final_status, hard_status: hard.status }, null, 2)}\n`);
  return ["DONE", "DONE_BUT_FLAWED", "NEEDS_HUMAN"].includes(result.final_status) ? 0 : result.final_status === "UNKNOWN" ? 3 : 1;
}

process.exitCode = await main();
