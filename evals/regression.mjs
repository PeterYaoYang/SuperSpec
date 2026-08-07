#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  copyFileSync,
  cpSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

const EVAL_ROOT = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(EVAL_ROOT, "..");
const DEFAULT_SUITE = join(EVAL_ROOT, "regression-suite.json");
const REASONING_LEVELS = new Set(["none", "low", "medium", "high", "xhigh", "max"]);
const REVIEW_ROLES = new Set(["critic", "architect", "test-engineer", "code-reviewer", "verifier"]);
const FIXED_EVALUATOR_FILES = [
  "evals/probe.mjs",
  "evals/arena.mjs",
  "evals/m2.mjs",
  "evals/lib/spawn.mjs",
  "build.js",
];
const HARNESS_DIGEST_FILES = [...FIXED_EVALUATOR_FILES, "node_modules/typescript/package.json"];

function parseArgs(argv) {
  const result = {
    suite: DEFAULT_SUITE,
    repetitions: null,
    provider: "openai",
    model: "gpt-5.6-terra",
    reasoning: "medium",
    reviewerAModel: "gpt-5.6-sol",
    reviewerAReasoning: "high",
    reviewerBModel: "gpt-5.6-terra",
    reviewerBReasoning: "high",
    withM2: false,
    releaseGate: false,
    validateFaults: false,
    dryRun: false,
    output: null,
    compareBaseline: null,
    compareCandidate: null,
    baselineRef: null,
    candidateRef: null,
    suiteWasExplicit: false,
  };

  for (let index = 0; index < argv.length; index++) {
    const arg = argv[index];
    if (arg === "--suite") {
      result.suite = resolve(argv[++index] ?? "");
      result.suiteWasExplicit = true;
    }
    else if (arg === "--repetitions") result.repetitions = Number(argv[++index] ?? "");
    else if (arg === "--provider") result.provider = argv[++index] ?? "";
    else if (arg === "--model") result.model = argv[++index] ?? "";
    else if (arg === "--reasoning") result.reasoning = argv[++index] ?? "";
    else if (arg === "--reviewer-a-model") result.reviewerAModel = argv[++index] ?? "";
    else if (arg === "--reviewer-a-reasoning") result.reviewerAReasoning = argv[++index] ?? "";
    else if (arg === "--reviewer-b-model") result.reviewerBModel = argv[++index] ?? "";
    else if (arg === "--reviewer-b-reasoning") result.reviewerBReasoning = argv[++index] ?? "";
    else if (arg === "--with-m2") result.withM2 = true;
    else if (arg === "--release-gate") result.releaseGate = true;
    else if (arg === "--validate-faults") result.validateFaults = true;
    else if (arg === "--dry-run") result.dryRun = true;
    else if (arg === "--output") result.output = resolve(argv[++index] ?? "");
    else if (arg === "--compare-baseline") result.compareBaseline = resolve(argv[++index] ?? "");
    else if (arg === "--compare-candidate") result.compareCandidate = resolve(argv[++index] ?? "");
    else if (arg === "--baseline-ref") result.baselineRef = argv[++index] ?? "";
    else if (arg === "--candidate-ref") result.candidateRef = argv[++index] ?? "";
    else if (arg === "--help" || arg === "-h") result.help = true;
    else throw new Error("unknown argument: " + arg);
  }

  if (result.help) return result;
  if (Boolean(result.baselineRef) !== Boolean(result.candidateRef)) {
    throw new Error("--baseline-ref and --candidate-ref must be provided together");
  }
  if ((result.baselineRef || result.candidateRef) && (result.compareBaseline || result.compareCandidate)) {
    throw new Error("Git ref comparison and report comparison are mutually exclusive");
  }
  if ((result.baselineRef || result.candidateRef) && result.dryRun) {
    throw new Error("--dry-run cannot be combined with Git ref comparison");
  }
  if (result.validateFaults || result.dryRun || result.compareBaseline || result.compareCandidate) return result;
  if (!Number.isInteger(result.repetitions)) result.repetitions = result.releaseGate ? 2 : 1;
  if (result.repetitions < 1 || result.repetitions > 20) throw new Error("--repetitions must be between 1 and 20");
  if (!/^[A-Za-z0-9_-]+$/.test(result.provider)) throw new Error("invalid provider: " + result.provider);
  if (!/^[A-Za-z0-9._-]+$/.test(result.model)) throw new Error("invalid model: " + result.model);
  for (const [name, value] of [
    ["reasoning", result.reasoning],
    ["reviewer-a-reasoning", result.reviewerAReasoning],
    ["reviewer-b-reasoning", result.reviewerBReasoning],
  ]) {
    if (!REASONING_LEVELS.has(value)) throw new Error("invalid " + name + ": " + value);
  }
  return result;
}

function help() {
  return [
    "SuperSpec M3 Regression",
    "",
    "运行回归集：",
    "  node evals/regression.mjs [选项]",
    "",
    "选项：",
    "  --suite <file>                  回归集 JSON，默认 evals/regression-suite.json",
    "  --repetitions <n>               每个任务重复次数，默认 1；--release-gate 默认 2",
    "  --provider <name>               Worker/Reviewer Provider",
    "  --model <name>                  Worker 模型",
    "  --reasoning <level>             Worker 推理强度",
    "  --with-m2                       每次 Probe 后执行 Arena + M2 双审",
    "  --release-gate                  启用稳定性和硬门禁映射自校验发布门",
    "  --dry-run                       只校验并打印回归集，不启动模型",
    "  --validate-faults               只运行评测器自身的确定性校验",
    "  --compare-baseline <report>     与基线 regression-result.json 对比",
    "  --compare-candidate <report>    与候选 regression-result.json 对比",
    "  --baseline-ref <git-ref>       从 Git ref 创建临时基线副本并运行回归",
    "  --candidate-ref <git-ref>      从 Git ref 创建临时候选副本并运行回归",
    "  --output <dir>                  输出目录",
  ].join("\n") + "\n";
}

function readJson(path) {
  return JSON.parse(readFileSync(path, "utf8"));
}

function writeJson(path, value) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(value, null, 2) + "\n");
}

function sha256File(path) {
  return "sha256:" + createHash("sha256").update(readFileSync(path)).digest("hex");
}

function evaluatorDigest(root = REPO_ROOT) {
  const files = Object.fromEntries(HARNESS_DIGEST_FILES.map(relativePath => {
    const path = join(root, relativePath);
    if (!existsSync(path)) throw new Error("evaluator file does not exist: " + relativePath);
    return [relativePath, sha256File(path)];
  }));
  return "sha256:" + createHash("sha256").update(JSON.stringify(files)).digest("hex");
}

function digestValue(value) {
  return "sha256:" + createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

function suiteContract(suite) {
  const groups = ["green", "boundary", "negative"];
  return {
    schema_version: suite.schema_version,
    id: suite.id,
    description: suite.description ?? null,
    groups: Object.fromEntries(groups.map(group => [group, suite.entries[group].map(entry => ({
      id: entry.id,
      task: entry.task,
      expected_status: entry.expectedStatus,
      task_digest: sha256File(entry.taskPath),
      scenario: entry.scenarioId,
      scenario_digest: entry.scenarioPath ? sha256File(entry.scenarioPath) : null,
    }))])),
  };
}

function suiteContractDigest(suite) {
  return digestValue(suiteContract(suite));
}

function executionEnvironment(runRoot) {
  const manifestPath = join(runRoot, "manifest.json");
  if (!existsSync(manifestPath)) return { digest: null, value: null, error: "manifest.json unavailable" };
  let manifest;
  try { manifest = readJson(manifestPath); } catch { return { digest: null, value: null, error: "manifest.json malformed" }; }
  const executables = Object.fromEntries(Object.entries(manifest.executables ?? {}).map(([name, value]) => [name, {
    version: value?.stdout ?? null,
    // The run-local superspec shim has an intentionally unique path; its
    // sealed package digest below is the stable identity we compare instead.
    realpath: name === "superspec" ? null : value?.realpath ?? null,
  }]));
  const requiredExecutables = ["codex", "node", "git", "openspec", "superspec"];
  const missingExecutables = requiredExecutables.flatMap(name => {
    const value = executables[name];
    return !value?.version || (name !== "superspec" && !value.realpath) ? [name] : [];
  });
  const provider = manifest.control?.provider;
  const launch = manifest.launch;
  const features = manifest.control?.features;
  const missing = [
    !launch?.provider || !launch.model || !launch.reasoning || !launch.sandbox || !launch.approval ? "launch" : null,
    !provider?.id || !provider.source_type || !provider.config_digest ? "provider" : null,
    !Array.isArray(provider?.selected_config_keys) || !Array.isArray(provider?.environment_keys) ? "provider_keys" : null,
    !manifest.package?.isolated_digest ? "subject_package" : null,
    !features || typeof features !== "object" ? "features" : null,
    ...missingExecutables.map(name => `executable:${name}`),
  ].filter(Boolean);
  if (missing.length > 0) {
    return { digest: null, value: null, error: `manifest metadata incomplete: ${missing.join(", ")}` };
  }
  const fingerprint = {
    launch: {
      provider: launch.provider,
      model: launch.model,
      reasoning: launch.reasoning,
      sandbox: launch.sandbox,
      approval: launch.approval,
    },
    provider: {
      id: provider.id,
      source_type: provider.source_type,
      selected_config_keys: provider.selected_config_keys,
      config_digest: provider.config_digest,
      environment_keys: provider.environment_keys,
      metadata: provider.metadata ?? null,
    },
    executables: Object.fromEntries(Object.entries(executables).filter(([name]) => name !== "superspec")),
    features,
  };
  return {
    digest: digestValue(fingerprint),
    // Keep the product package identity for evidence, but do not include it
    // in the control-variable digest: Git-ref comparisons must allow the
    // product under test to change.
    value: {
      ...fingerprint,
      package_digest: manifest.package.isolated_digest,
      subject_executable: executables.superspec,
    },
  };
}

function withinRoot(path, root) {
  const target = resolve(path);
  const base = resolve(root);
  return target === base || target.startsWith(base + sep);
}

function resolveRepoPath(path, label, repoRoot = REPO_ROOT) {
  const resolved = resolve(repoRoot, path);
  if (!withinRoot(resolved, repoRoot)) throw new Error(label + " escapes repository: " + path);
  if (!existsSync(resolved)) throw new Error(label + " does not exist: " + path);
  let real;
  try { real = realpathSync(resolved); } catch { throw new Error(label + " cannot be resolved safely: " + path); }
  if (!withinRoot(real, repoRoot)) throw new Error(label + " resolves outside repository: " + path);
  return resolved;
}

function parseJsonOutput(output, predicate = () => true) {
  const text = String(output ?? "");
  for (let index = 0; index < text.length; index++) {
    if (text[index] !== "{") continue;
    try {
      const value = JSON.parse(text.slice(index));
      if (value && typeof value === "object" && predicate(value)) return value;
    } catch {
      // Probe and M2 use pretty JSON; try the next object boundary.
    }
  }
  return null;
}

function runNode(script, args, cwd, maxBuffer = 80 * 1024 * 1024, timeoutMs = null) {
  const spawnOptions = { cwd, encoding: "utf8", maxBuffer };
  if (Number.isFinite(timeoutMs)) spawnOptions.timeout = Math.max(1, Math.floor(timeoutMs));
  const result = spawnSync(process.execPath, [script, ...args], spawnOptions);
  return {
    code: typeof result.status === "number" ? result.status : 3,
    signal: result.signal ?? null,
    stdout: result.stdout ?? "",
    stderr: result.stderr ?? "",
    error: result.error ? String(result.error.message ?? result.error) : null,
    timed_out: result.error?.code === "ETIMEDOUT"
      || (Number.isFinite(timeoutMs) && result.signal === "SIGTERM" && result.status === null),
  };
}

function readJsonl(path) {
  if (!existsSync(path)) return [];
  return readFileSync(path, "utf8")
    .split("\n")
    .filter(line => line.trim().length > 0)
    .flatMap(line => {
      try {
        return [JSON.parse(line)];
      } catch {
        return [];
      }
    });
}

function loadSuite(suitePath, repoRoot = REPO_ROOT) {
  const safeSuitePath = resolveRepoPath(suitePath, "regression suite", repoRoot);
  const suite = readJson(safeSuitePath);
  if (suite?.schema_version !== 1 || typeof suite.id !== "string") {
    throw new Error("regression suite must use schema_version 1 and have an id");
  }
  const groups = ["green", "boundary", "negative"];
  const entries = {};
  for (const group of groups) {
    if (!Array.isArray(suite[group])) throw new Error("suite group must be an array: " + group);
    entries[group] = suite[group].map((entry, index) => {
      if (!entry || typeof entry.id !== "string" || typeof entry.task !== "string") {
        throw new Error("invalid " + group + " entry at index " + index);
      }
      if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(entry.id)) {
        throw new Error("invalid " + group + " entry id: " + entry.id);
      }
      if (entries[group]?.some(item => item.id === entry.id)) {
        throw new Error("duplicate " + group + " entry: " + entry.id);
      }
      const taskPath = resolveRepoPath(entry.task, group + " task", repoRoot);
      const task = readJson(taskPath);
      const scenarioId = task?.workflow?.scenario_id;
      if (group !== "negative" && typeof scenarioId !== "string") {
        throw new Error("task has no workflow.scenario_id: " + entry.task);
      }
      const scenarioPath = group === "negative"
        ? null
        : resolveRepoPath("evals/scenarios/" + scenarioId + ".json", "scenario", repoRoot);
      if (scenarioPath && readJson(scenarioPath)?.id !== scenarioId) {
        throw new Error("scenario id mismatch: " + scenarioId);
      }
      const expectedStatus = entry.expected_status ?? (group === "green" ? "DONE" : group === "boundary" ? "NEEDS_HUMAN" : "INVALID");
      if (!["DONE", "NEEDS_HUMAN", "INVALID"].includes(expectedStatus)) {
        throw new Error("unsupported expected_status for " + entry.id + ": " + expectedStatus);
      }
      if (group === "green" && expectedStatus !== "DONE") throw new Error("green task must expect DONE: " + entry.id);
      if (group === "negative" && expectedStatus !== "INVALID") throw new Error("negative task must expect INVALID: " + entry.id);
      return {
        ...entry,
        group,
        taskPath,
        task,
        scenarioId,
        scenarioPath,
        expectedStatus,
      };
    });
  }
  const allIds = [...entries.green, ...entries.boundary, ...entries.negative].map(entry => entry.id);
  if (new Set(allIds).size !== allIds.length) throw new Error("suite entry ids must be globally unique");
  const loadedSuite = { ...suite, entries };
  return { ...loadedSuite, contract_digest: suiteContractDigest(loadedSuite) };
}

function taskWallBudgetMs(task) {
  const seconds = task?.budget?.max_wall_seconds;
  if (seconds == null) return null;
  if (!Number.isInteger(seconds) || seconds <= 0 || seconds > 86_400) {
    throw new Error("task budget.max_wall_seconds must be an integer between 1 and 86400");
  }
  return seconds * 1000;
}

function remainingTimeoutMs(deadline) {
  return deadline == null ? null : Math.max(1, deadline - Date.now());
}

function materializeInput(entry, inputsRoot, runId) {
  const inputRoot = join(inputsRoot, runId, entry.id);
  mkdirSync(inputRoot, { recursive: true });
  const taskPath = join(inputRoot, "task.json");
  const scenarioPath = join(inputRoot, "scenario.json");
  cpSync(entry.taskPath, taskPath);
  if (entry.scenarioPath) cpSync(entry.scenarioPath, scenarioPath);
  return { taskPath, scenarioPath };
}

function extractProbeResult(processResult) {
  const parsed = parseJsonOutput(processResult.stdout, value => typeof value.run === "string" && value.capability);
  return parsed;
}

function extractArenaResult(processResult) {
  return parseJsonOutput(processResult.stdout, value => typeof value.run === "string" && value.outcome);
}

function extractM2Result(processResult) {
  return parseJsonOutput(processResult.stdout, value => typeof value.run === "string" && typeof value.final_status === "string");
}

function runProbe(sourceRoot, input, options, timeoutMs = null) {
  const script = join(sourceRoot, "evals", "probe.mjs");
  const args = [
    "--scenario", input.scenarioPath,
    "--provider", options.provider,
    "--model", options.model,
    "--reasoning", options.reasoning,
  ];
  const processResult = runNode(script, args, sourceRoot, 80 * 1024 * 1024, timeoutMs);
  return { process: processResult, result: extractProbeResult(processResult) };
}

function runArena(sourceRoot, input, replayRoot, timeoutMs = null) {
  const script = join(sourceRoot, "evals", "arena.mjs");
  const processResult = runNode(script, ["--task", input.taskPath, "--replay", replayRoot], sourceRoot, 80 * 1024 * 1024, timeoutMs);
  return { process: processResult, result: extractArenaResult(processResult) };
}

function runM2(sourceRoot, input, replayRoot, options, timeoutMs = null) {
  const script = join(sourceRoot, "evals", "m2.mjs");
  const outputRoot = join(sourceRoot, "evals", "runs", `m2-${basename(replayRoot)}-${process.pid}-${Date.now()}`);
  mkdirSync(outputRoot, { recursive: true });
  const args = [
    "--task", input.taskPath,
    "--replay", replayRoot,
    "--output", outputRoot,
    "--provider", options.provider,
    "--reviewer-a-model", options.reviewerAModel,
    "--reviewer-a-reasoning", options.reviewerAReasoning,
    "--reviewer-b-model", options.reviewerBModel,
    "--reviewer-b-reasoning", options.reviewerBReasoning,
  ];
  const processResult = runNode(script, args, sourceRoot, 80 * 1024 * 1024, timeoutMs);
  writeFileSync(join(outputRoot, "runner-stdout.log"), processResult.stdout, { mode: 0o600 });
  writeFileSync(join(outputRoot, "runner-stderr.log"), processResult.stderr, { mode: 0o600 });
  const summary = extractM2Result(processResult);
  if (!summary?.run) return { process: processResult, outputRoot, result: summary };
  const resultPath = join(summary.run, "m2-result.json");
  if (!existsSync(resultPath)) return { process: processResult, outputRoot, result: summary };
  try {
    return { process: processResult, outputRoot, result: { ...readJson(resultPath), ...summary } };
  } catch {
    return { process: processResult, outputRoot, result: summary };
  }
}

function usageFromObject(value) {
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

function latestTraceUsage(path) {
  let latest = null;
  for (const record of readJsonl(path)) {
    const candidate = usageFromObject(record);
    if (candidate) latest = candidate;
  }
  return latest;
}

function sumTraceUsage(paths) {
  const values = paths.map(latestTraceUsage).filter(Boolean);
  if (values.length === 0) return { observed: false, total_tokens: null, turns_with_usage: 0 };
  return {
    observed: true,
    total_tokens: values.reduce((sum, value) => sum + value.total_tokens, 0),
    input_tokens: values.every(value => value.input_tokens !== null)
      ? values.reduce((sum, value) => sum + value.input_tokens, 0)
      : null,
    output_tokens: values.every(value => value.output_tokens !== null)
      ? values.reduce((sum, value) => sum + value.output_tokens, 0)
      : null,
    turns_with_usage: values.length,
  };
}

function tracePaths(root, prefix) {
  const evidence = join(root, "evidence");
  if (!existsSync(evidence)) return [];
  return readdirSync(evidence)
    .filter(name => name.startsWith(prefix) && name.endsWith(".jsonl"))
    .sort()
    .map(name => join(evidence, name));
}

function metricsCapabilitySource(runRoot, m2RunRoot = null, arenaRunRoot = null) {
  const originalPath = join(runRoot, "capability.json");
  const candidates = [
    [m2RunRoot, "review-bundle.json", "capability_source"],
    [arenaRunRoot, "source.json", "source_capability_file"],
  ];
  for (const [reportRoot, reportName, field] of candidates) {
    if (!reportRoot) continue;
    const reportPath = join(reportRoot, reportName);
    if (!existsSync(reportPath)) continue;
    try {
      const source = readJson(reportPath)[field];
      // These files are produced by the verified Arena/M2 path. Keep the
      // accepted source deliberately narrow so a derived report cannot make
      // metrics read an arbitrary path outside the sealed Probe run.
      if (source !== "capability.json" && source !== "capability.regraded.json") continue;
      const candidatePath = join(runRoot, source);
      if (existsSync(candidatePath)) return { path: candidatePath, source };
    } catch {
      // Fall back to the immutable original capability below.
    }
  }
  return { path: originalPath, source: "capability.json" };
}

function runMetrics(runRoot, m2RunRoot = null, arenaRunRoot = null) {
  const capabilitySource = metricsCapabilitySource(runRoot, m2RunRoot, arenaRunRoot);
  const capability = existsSync(capabilitySource.path) ? readJson(capabilitySource.path) : {};
  const events = readJsonl(join(runRoot, "evidence", "events.jsonl"));
  const workerTracePaths = tracePaths(runRoot, "turn-");
  const jobRoles = new Map();
  const acceptedJobs = new Set();
  let userDecisionCount = 0;
  let createdReviewJobs = 0;
  let acceptedReviewJobs = 0;

  for (const event of events) {
    if (event.event_type === "user_decision_recorded") userDecisionCount++;
    if (event.event_type === "transition_commit") {
      for (const job of event.payload?.new_jobs ?? []) {
        if (typeof job?.job_id !== "string") continue;
        jobRoles.set(job.job_id, job.role);
        if (REVIEW_ROLES.has(job.role)) {
          createdReviewJobs++;
        }
      }
    }
    if (event.event_type === "job_accepted" && typeof event.payload?.job_id === "string") {
      acceptedJobs.add(event.payload.job_id);
    }
  }
  for (const jobId of acceptedJobs) {
    if (REVIEW_ROLES.has(jobRoles.get(jobId))) acceptedReviewJobs++;
  }

  const reviewerTracePaths = m2RunRoot
    ? ["review-a.jsonl", "review-b.jsonl"].map(name => join(m2RunRoot, name)).filter(existsSync)
    : [];
  const stop = capability.dynamic_user?.stop ?? null;
  return {
    capability_source: capabilitySource.source,
    capability_digest: existsSync(capabilitySource.path) ? sha256File(capabilitySource.path) : null,
    worker_turns: workerTracePaths.length,
    user_confirmations: userDecisionCount,
    review_jobs_created: createdReviewJobs,
    review_jobs_accepted: acceptedReviewJobs,
    final_state: capability.dynamic_user?.final_state
      ?? capability.scripted_four_turn?.final_state
      ?? capability.scripted_three_turn?.final_state
      ?? capability.scripted_two_turn?.final_state
      ?? null,
    dynamic_stop: stop?.action ?? null,
    worker_tokens: sumTraceUsage(workerTracePaths),
    reviewer_tokens: sumTraceUsage(reviewerTracePaths),
  };
}

function hardStatus(entry, probe, arena, m2) {
  if (!probe?.result) return "INVALID";
  const capability = probe?.result?.capability ?? {};
  const invalidGates = ["process", "controlled_environment", "authenticity"].filter(name =>
    ["fail", "unavailable"].includes(capability.gates?.[name]?.status),
  );
  if (invalidGates.length > 0) return "INVALID";

  const arenaStatus = arena?.result?.outcome?.status;
  if (arenaStatus === "UNKNOWN" || !arenaStatus) return "UNKNOWN";
  if (arenaStatus !== "PROVISIONAL_DONE") return "NOT_DONE";

  const resultGates = ["scope", "artifact", "state", "stop_boundary"];
  const unavailableGates = resultGates.filter(name => capability.gates?.[name]?.status === "unavailable");
  if (unavailableGates.length > 0) return "UNKNOWN";
  const incompleteGates = resultGates.filter(name => capability.gates?.[name]?.status !== "pass");
  if (incompleteGates.length > 0) return "NOT_DONE";

  if (m2 && !m2.result) return "UNKNOWN";

  const dynamicStop = capability.dynamic_user?.stop;
  const targetBoundary = dynamicStop?.action === "needs_human"
    && dynamicStop.source === "configured_stop_scope"
    && capability.dynamic_user?.final_state === entry.task?.target?.state;
  const derived = dynamicStop?.action === "needs_human" && !targetBoundary ? "NEEDS_HUMAN" : "DONE";

  // M2 may add a hard invalidity (for example, a sealed development injection)
  // that is not represented in the Probe capability. It can only refine the
  // already-valid result; it must never override the independent hard gates
  // above with a user-facing boundary status.
  const m2Hard = m2?.result?.hard_outcome?.status;
  if (["INVALID", "UNKNOWN", "NOT_DONE"].includes(m2Hard)) return m2Hard;
  if (m2Hard === "NEEDS_HUMAN") return "NEEDS_HUMAN";
  return derived;
}

function normalizeStatus(entry, probe, arena, m2) {
  const hard = hardStatus(entry, probe, arena, m2);
  if (hard !== "DONE") return hard;
  return m2?.result?.final_status ?? "DONE";
}

function statusMatches(entry, status, hard, options = {}) {
  if (hard !== entry.expectedStatus) return false;
  if (entry.expectedStatus === "DONE" && !["DONE", "DONE_BUT_FLAWED"].includes(status)) return false;
  if (entry.expectedStatus === "NEEDS_HUMAN" && status !== "NEEDS_HUMAN") return false;
  if (entry.expectedStatus === "INVALID" && status !== "INVALID") return false;
  // When M2 is requested, an incomplete semantic review is not a complete
  // successful evaluation even if the independent hard gates passed.
  return !(options.withM2 && entry.expectedStatus === "DONE" && status === "UNKNOWN");
}

function archiveRun(runRoot, outputRoot, id) {
  if (!runRoot || !existsSync(runRoot)) return null;
  const destination = join(outputRoot, "replays", id.replace(/[^A-Za-z0-9._-]+/g, "_"));
  if (existsSync(destination)) throw new Error("replay archive already exists: " + destination);
  mkdirSync(dirname(destination), { recursive: true });
  cpSync(runRoot, destination, { recursive: true });
  writeArchiveManifest(destination, {
    kind: "replay",
    source: { run: resolve(runRoot) },
    source_digests: fileDigests(runRoot),
  });
  return destination;
}

function fileDigests(root) {
  const files = {};
  const walk = (current, prefix = "") => {
    if (!existsSync(current)) return;
    const entries = readdirSync(current, { withFileTypes: true })
      .sort((left, right) => left.name.localeCompare(right.name));
    for (const entry of entries) {
      const absolute = join(current, entry.name);
      const relativePath = prefix ? join(prefix, entry.name) : entry.name;
      if (relativePath === "archive-manifest.json") continue;
      if (entry.isDirectory()) walk(absolute, relativePath);
      else if (entry.isFile()) files[relativePath] = sha256File(absolute);
    }
  };
  walk(root);
  return files;
}

function writeArchiveManifest(destination, metadata = {}) {
  const manifestPath = join(destination, "archive-manifest.json");
  const previous = existsSync(manifestPath) ? readJson(manifestPath) : {};
  writeJson(manifestPath, {
    schema_version: 1,
    ...previous,
    ...metadata,
    archived_digests: fileDigests(destination),
  });
  return manifestPath;
}

function archiveInput(input, outputRoot, id) {
  const destination = join(outputRoot, "inputs", id.replace(/[^A-Za-z0-9._-]+/g, "_"));
  if (existsSync(destination)) throw new Error("input archive already exists: " + destination);
  mkdirSync(destination, { recursive: true });
  const taskDestination = join(destination, "task.json");
  copyFileSync(input.taskPath, taskDestination);
  const scenarioDestination = input.scenarioPath && existsSync(input.scenarioPath)
    ? join(destination, "scenario.json")
    : null;
  if (scenarioDestination) copyFileSync(input.scenarioPath, scenarioDestination);
  writeJson(join(destination, "input-manifest.json"), {
    schema_version: 1,
    task: { path: "task.json", digest: sha256File(taskDestination) },
    scenario: scenarioDestination ? { path: "scenario.json", digest: sha256File(scenarioDestination) } : null,
  });
  writeArchiveManifest(destination, {
    kind: "input_snapshot",
    source: { task_path: input.taskPath, scenario_path: input.scenarioPath },
    source_digests: {
      task: sha256File(input.taskPath),
      scenario: input.scenarioPath ? sha256File(input.scenarioPath) : null,
    },
  });
  return destination;
}

function rewritePathReferences(value, mappings) {
  if (typeof value === "string") {
    for (const mapping of mappings) {
      if (value === mapping.source) return mapping.destination;
      if (value.startsWith(mapping.source + sep)) return mapping.destination + value.slice(mapping.source.length);
    }
    return value;
  }
  if (Array.isArray(value)) return value.map(item => rewritePathReferences(item, mappings));
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, rewritePathReferences(item, mappings)]));
  }
  return value;
}

function rewriteArchivedReferences(archiveRoot, mappings, names) {
  if (!archiveRoot || !existsSync(archiveRoot)) return;
  const sortedMappings = mappings
    .filter(mapping => mapping?.source && mapping?.destination)
    .sort((left, right) => right.source.length - left.source.length);
  for (const name of names) {
    const path = join(archiveRoot, name);
    if (!existsSync(path)) continue;
    if (name.endsWith(".md")) {
      let content = readFileSync(path, "utf8");
      for (const mapping of sortedMappings) {
        if (mapping.source && mapping.destination) content = content.split(mapping.source).join(mapping.destination);
      }
      writeFileSync(path, content);
      continue;
    }
    let value;
    try { value = readJson(path); } catch { continue; }
    const rewritten = rewritePathReferences(value, sortedMappings);
    if (JSON.stringify(rewritten) !== JSON.stringify(value)) writeJson(path, rewritten);
  }
  const m2ManifestPath = join(archiveRoot, "m2-manifest.json");
  if (names.includes("m2-manifest.json") && existsSync(m2ManifestPath)) {
    try {
      const m2Manifest = readJson(m2ManifestPath);
      m2Manifest.files = Object.fromEntries(Object.keys(m2Manifest.files ?? {})
        .filter(name => existsSync(join(archiveRoot, name)))
        .map(name => [name, sha256File(join(archiveRoot, name))]));
      writeJson(m2ManifestPath, m2Manifest);
    } catch {
      // A malformed derived manifest should remain visible in the archive;
      // do not make archival fail after the source evidence was copied.
    }
  }
  writeArchiveManifest(archiveRoot, {
    rewritten_references: sortedMappings.map(mapping => ({ source: mapping.source, destination: mapping.destination })),
  });
}

function archivePathMappings({ sourceRoot, outputRoot, replaySource, archivedReplay, arenaRun, archivedArena, m2Run, archivedM2, m2ArenaRun, archivedM2Arena, input, archivedInput }) {
  const mappings = [];
  const add = (source, destination) => {
    if (!source || !destination || source === ".") return;
    const normalizedSource = String(source);
    if (mappings.some(mapping => mapping.source === normalizedSource)) return;
    mappings.push({ source: normalizedSource, destination: archiveRelativePath(outputRoot, destination) });
  };
  const addWithRelativeForms = (source, destination) => {
    if (!source || !destination) return;
    add(source, destination);
    // Arena/M2 manifests may store either an absolute path or a path relative
    // to the evaluated repository. Normalize every accepted form to the
    // portable path inside this regression archive.
    for (const base of [sourceRoot, REPO_ROOT]) add(relative(base, source), destination);
  };
  addWithRelativeForms(replaySource, archivedReplay);
  addWithRelativeForms(arenaRun, archivedArena);
  addWithRelativeForms(m2Run, archivedM2);
  addWithRelativeForms(m2ArenaRun, archivedM2Arena);
  const archivedTask = archivedInput ? join(archivedInput, "task.json") : null;
  addWithRelativeForms(input?.taskPath, archivedTask);
  const archivedScenario = archivedInput ? join(archivedInput, "scenario.json") : null;
  addWithRelativeForms(input?.scenarioPath, archivedScenario);
  return mappings;
}

function runAttempt(entry, sourceRoot, inputsRoot, outputRoot, options, repeat) {
  const runId = entry.id + "-repeat-" + repeat;
  const input = materializeInput(entry, inputsRoot, runId);
  const wallBudgetMs = taskWallBudgetMs(entry.task);
  const deadline = wallBudgetMs == null ? null : Date.now() + wallBudgetMs;
  const probe = runProbe(sourceRoot, input, options, remainingTimeoutMs(deadline));
  const probeRun = probe.result?.run ?? null;
  const arena = probeRun ? runArena(sourceRoot, input, probeRun, remainingTimeoutMs(deadline)) : null;
  const m2 = options.withM2 && probeRun ? runM2(sourceRoot, input, probeRun, options, remainingTimeoutMs(deadline)) : null;
  const timedOut = [probe, arena, m2].some(item => item?.process?.timed_out === true);
  // A partial result produced before the wall-clock watchdog fired is not a
  // valid completed attempt. Do not let a previously written DONE/M2 summary
  // turn a timed-out run into a passing result.
  const status = timedOut ? "UNKNOWN" : normalizeStatus(entry, probe, arena, m2);
  const hard = timedOut ? "UNKNOWN" : hardStatus(entry, probe, arena, m2);
  const replaySource = m2?.result?.source_run ?? probeRun;
  const archivedReplay = archiveRun(replaySource, outputRoot, runId);
  const archivedArena = archiveRun(arena?.result?.run ?? null, outputRoot, runId + "-arena");
  const archivedM2 = archiveRun(m2?.outputRoot ?? m2?.result?.run ?? null, outputRoot, runId + "-m2");
  const archivedM2Arena = archiveRun(m2?.result?.arena_run ?? null, outputRoot, runId + "-m2-arena");
  const archivedInput = archiveInput(input, outputRoot, runId);
  const archiveMappings = archivePathMappings({
    sourceRoot,
    outputRoot,
    replaySource,
    archivedReplay,
    arenaRun: arena?.result?.run,
    archivedArena,
    m2Run: m2?.outputRoot ?? m2?.result?.run,
    archivedM2,
    m2ArenaRun: m2?.result?.arena_run,
    archivedM2Arena,
    input,
    archivedInput,
  });
  // The Probe replay is sealed and must remain byte-for-byte intact. Arena and
  // M2 outputs are derived reports, so their references may safely point at
  // the archived copies instead of the temporary source paths.
  rewriteArchivedReferences(archivedArena, archiveMappings, ["source.json", "task.json", "report.md"]);
  rewriteArchivedReferences(archivedM2, archiveMappings, ["m2-result.json", "m2-manifest.json", "report.md"]);
  rewriteArchivedReferences(archivedM2Arena, archiveMappings, ["source.json", "task.json", "report.md"]);
  rewriteArchivedReferences(archivedInput, archiveMappings, ["archive-manifest.json"]);
  const inputManifest = archivedInput && existsSync(join(archivedInput, "input-manifest.json"))
    ? readJson(join(archivedInput, "input-manifest.json"))
    : null;
  const environment = probeRun ? executionEnvironment(probeRun) : null;
  const metrics = probeRun ? runMetrics(probeRun, m2?.result?.run ?? null, arena?.result?.run ?? null) : {
    worker_turns: 0,
    user_confirmations: 0,
    review_jobs_created: 0,
    review_jobs_accepted: 0,
    final_state: null,
    dynamic_stop: null,
    worker_tokens: { observed: false, total_tokens: null, turns_with_usage: 0 },
    reviewer_tokens: { observed: false, total_tokens: null, turns_with_usage: 0 },
  };
  const errors = [];
  if (!probe.result) errors.push("Probe output did not contain a sealed run result");
  if (probe.process.code !== 0 && !probeRun) errors.push("Probe exited " + probe.process.code);
  if (probe.process.timed_out || arena?.process.timed_out || m2?.process.timed_out) errors.push("task wall-clock budget exceeded");
  if (probeRun && !arena?.result) errors.push("Arena output unavailable");
  if (options.withM2 && probeRun && !m2?.result) errors.push("M2 output unavailable");
  if (probeRun && environment?.error) errors.push("Execution environment metadata unavailable: " + environment.error);
  return {
    entry_id: entry.id,
    group: entry.group,
    repeat,
    expected_status: entry.expectedStatus,
    status,
    hard_status: hard,
    matched: statusMatches(entry, status, hard, options),
    probe_exit_code: probe.process.code,
    arena_exit_code: arena?.process.code ?? null,
    m2_exit_code: m2?.process.code ?? null,
    timed_out: timedOut,
    wall_budget_ms: wallBudgetMs,
    probe_scenario_result: probe.result?.capability?.scenario_result ?? null,
    arena_status: arena?.result?.outcome?.status ?? null,
    m2_final_status: m2?.result?.final_status ?? null,
    environment_digest: environment?.digest ?? null,
    environment: environment?.value ?? null,
    metrics,
    replay: archivedReplay,
    arena_replay: archivedArena,
    m2_replay: archivedM2,
    m2_arena_replay: archivedM2Arena,
    input: archivedInput,
    archive_paths: {
      input: archiveRelativePath(outputRoot, archivedInput),
      probe_replay: archiveRelativePath(outputRoot, archivedReplay),
      arena_replay: archiveRelativePath(outputRoot, archivedArena),
      m2_replay: archiveRelativePath(outputRoot, archivedM2),
      m2_arena_replay: archiveRelativePath(outputRoot, archivedM2Arena),
    },
    input_snapshot: inputManifest ? {
      root: archivedInput,
      task: inputManifest.task,
      scenario: inputManifest.scenario,
      manifest: join(archivedInput, "input-manifest.json"),
    } : null,
    errors,
  };
}

function mean(values) {
  const numbers = values.filter(value => Number.isFinite(value));
  return numbers.length ? numbers.reduce((sum, value) => sum + value, 0) / numbers.length : null;
}

function summarizeEntry(entry, attempts) {
  const matched = attempts.filter(item => item.matched).length;
  const statuses = Object.fromEntries([...new Set(attempts.map(item => item.status))].sort().map(status => [
    status,
    attempts.filter(item => item.status === status).length,
  ]));
  const tokenValues = attempts
    .map(item => item.metrics.worker_tokens?.total_tokens)
    .filter(value => Number.isFinite(value));
  return {
    id: entry.id,
    group: entry.group,
    expected_status: entry.expectedStatus,
    repetitions: attempts.length,
    matched: matched,
    pass_rate: attempts.length ? matched / attempts.length : 0,
    stable: attempts.length > 0 && matched === attempts.length,
    statuses,
    mean_worker_turns: mean(attempts.map(item => item.metrics.worker_turns)),
    mean_user_confirmations: mean(attempts.map(item => item.metrics.user_confirmations)),
    mean_review_jobs: mean(attempts.map(item => item.metrics.review_jobs_created)),
    mean_worker_tokens: tokenValues.length ? mean(tokenValues) : null,
    worker_token_observations: tokenValues.length,
  };
}

function validateNegativeSuite(suite, sourceRoot = REPO_ROOT) {
  const processResult = runNode(join(sourceRoot, "evals", "m2.mjs"), ["--validate-faults"], sourceRoot);
  const parsed = parseJsonOutput(processResult.stdout, value => value.ok === true && value.cases?.cheats);
  const results = suite.entries.negative.map(entry => ({
    id: entry.id,
    expected_status: entry.expectedStatus,
    observed_status: parsed?.cases?.cheats?.[entry.id] ?? null,
    matched: parsed?.cases?.cheats?.[entry.id] === entry.expectedStatus,
  }));
  return {
    ok: processResult.code === 0 && Boolean(parsed?.ok) && results.every(item => item.matched),
    exit_code: processResult.code,
    results,
    error: processResult.code === 0 ? null : (processResult.stderr || processResult.stdout).trim(),
  };
}

function validateEvaluator(sourceRoot = REPO_ROOT) {
  const commands = [
    ["probe", join(sourceRoot, "evals", "probe.mjs")],
    ["arena", join(sourceRoot, "evals", "arena.mjs")],
    ["m2", join(sourceRoot, "evals", "m2.mjs")],
  ];
  const results = commands.map(([name, script]) => {
    const result = runNode(script, ["--validate-faults"], sourceRoot);
    const parsed = parseJsonOutput(result.stdout, value => value.ok === true);
    return { name, exit_code: result.code, ok: result.code === 0 && parsed?.ok === true };
  });
  return { ok: results.every(item => item.ok), results };
}

function validateAggregation() {
  const entry = { id: "fixture-green", group: "green", expectedStatus: "DONE" };
  const attempt = {
    entry_id: entry.id,
    status: "DONE",
    hard_status: "DONE",
    matched: true,
    metrics: {
      worker_turns: 3,
      user_confirmations: 2,
      review_jobs_created: 1,
      worker_tokens: { total_tokens: 120 },
    },
  };
  const summary = summarizeEntry(entry, [attempt, { ...attempt, repeat: 2 }]);
  if (summary.pass_rate !== 1 || summary.stable !== true || summary.mean_worker_turns !== 3 || summary.mean_worker_tokens !== 120) {
    return { ok: false, reason: "stable summary aggregation failed" };
  }
  const boundaryEntry = { id: "fixture-boundary", group: "boundary", expectedStatus: "NEEDS_HUMAN", task: { target: { state: "explore" } } };
  const validBoundaryProbe = {
    result: {
      capability: {
        gates: {
          process: { status: "pass" }, controlled_environment: { status: "pass" }, authenticity: { status: "pass" },
          scope: { status: "pass" }, artifact: { status: "pass" }, state: { status: "pass" }, stop_boundary: { status: "pass" },
        },
        dynamic_user: { final_state: "explore", stop: { action: "needs_human", reason: "decision" } },
      },
    },
    process: { code: 0 },
  };
  const invalidBoundaryProbe = structuredClone(validBoundaryProbe);
  invalidBoundaryProbe.result.capability.gates.authenticity = { status: "unavailable" };
  const validHard = hardStatus(boundaryEntry, validBoundaryProbe, { result: { outcome: { status: "PROVISIONAL_DONE" } } }, null);
  const invalidHard = hardStatus(boundaryEntry, invalidBoundaryProbe, { result: { outcome: { status: "PROVISIONAL_DONE" } } }, null);
  const greenEntry = { id: "fixture-green-hard", group: "green", expectedStatus: "DONE", task: { target: { state: "accepted" } } };
  const greenProbe = structuredClone(validBoundaryProbe);
  delete greenProbe.result.capability.dynamic_user;
  const greenHard = hardStatus(greenEntry, greenProbe, { result: { outcome: { status: "PROVISIONAL_DONE" } } }, null);
  const m2InvalidHard = hardStatus(greenEntry, greenProbe, { result: { outcome: { status: "PROVISIONAL_DONE" } } }, {
    result: { hard_outcome: { status: "INVALID" }, final_status: "NEEDS_HUMAN" },
  });
  const timeoutEntry = { id: "fixture-timeout", group: "green", expectedStatus: "DONE" };
  const timeoutStatus = "UNKNOWN";
  const timeoutHard = "UNKNOWN";
  if (greenHard !== "DONE" || m2InvalidHard !== "INVALID" || validHard !== "NEEDS_HUMAN" || invalidHard !== "INVALID"
    || statusMatches(boundaryEntry, "NEEDS_HUMAN", invalidHard)
    || statusMatches(timeoutEntry, timeoutStatus, timeoutHard)) {
    return { ok: false, reason: "boundary hard-gate ordering failed" };
  }
  const root = mkdtempSync(join(tmpdir(), "superspec-m3-validation-"));
  try {
    const environmentRoot = join(root, "environment");
    mkdirSync(environmentRoot, { recursive: true });
    const environmentManifest = {
      launch: { provider: "localproxy", model: "gpt-5.6-terra", reasoning: "medium", sandbox: "workspace-write", approval: "never" },
      control: {
        provider: { id: "localproxy", source_type: "host_codex_provider_whitelist", config_digest: "sha256:provider", selected_config_keys: [], environment_keys: [], metadata: {} },
        features: { supported: [], enabled: ["multi_agent"], disabled: [] },
      },
      package: { isolated_digest: "sha256:subject-a" },
      executables: Object.fromEntries(["codex", "node", "git", "openspec", "superspec"].map(name => [name, { stdout: name + "-version", realpath: "/bin/" + name }])),
    };
    writeJson(join(environmentRoot, "manifest.json"), environmentManifest);
    const environmentA = executionEnvironment(environmentRoot);
    writeJson(join(environmentRoot, "manifest.json"), { ...environmentManifest, package: { isolated_digest: "sha256:subject-b" } });
    const environmentB = executionEnvironment(environmentRoot);
    if (!environmentA?.digest || environmentA.digest !== environmentB?.digest || environmentA.value.package_digest === environmentB.value.package_digest) {
      return { ok: false, reason: "subject package changes must not alter environment digest" };
    }
    writeJson(join(environmentRoot, "manifest.json"), { ...environmentManifest, control: { ...environmentManifest.control, provider: { ...environmentManifest.control.provider, config_digest: null } } });
    if (executionEnvironment(environmentRoot)?.digest !== null) return { ok: false, reason: "incomplete environment metadata was accepted" };

    const baselinePath = join(root, "baseline.json");
    const candidatePath = join(root, "candidate.json");
    const archivePath = join(root, "archive-manifest.json");
    const nestedArchivePath = join(root, "nested-archive");
    mkdirSync(nestedArchivePath, { recursive: true });
    writeFileSync(join(nestedArchivePath, "evidence.txt"), "evidence\n");
    writeArchiveManifest(nestedArchivePath, { kind: "fixture_archive" });
    const nestedArchiveDigest = sha256File(join(nestedArchivePath, "archive-manifest.json"));
    const archiveContract = {
      schema_version: 1,
      kind: "m3_archive",
      suite: { id: "fixture", digest: "sha256:fixture-suite" },
      attempts: [{
        entry_id: "fixture-green",
        repeat: 1,
        input: "nested-archive",
        probe_replay: null,
        arena_replay: null,
        m2_replay: null,
        m2_arena_replay: null,
        archive_digests: { input: nestedArchiveDigest, probe_replay: null, arena_replay: null, m2_replay: null, m2_arena_replay: null },
      }],
    };
    writeJson(archivePath, {
      ...archiveContract,
    });
    const base = {
      kind: "m3_regression",
      suite_id: "fixture",
      source: {
        head: "base",
        evaluator_digest: "sha256:fixture-harness",
        runner_digest: "sha256:fixture-runner",
        suite_digest: "sha256:fixture-suite",
        environment_digest: "sha256:fixture-environment",
        archive_manifest: "archive-manifest.json",
        archive_manifest_digest: sha256File(archivePath),
      },
      options: {
        provider: "localproxy",
        model: "gpt-5.6-terra",
        reasoning: "medium",
        reviewer_a_model: "gpt-5.6-sol",
        reviewer_a_reasoning: "high",
        reviewer_b_model: "gpt-5.6-terra",
        reviewer_b_reasoning: "high",
        repetitions: 2,
        with_m2: false,
        release_gate: false,
      },
      group_summaries: [summary],
      release_gate: { requested: false, status: "NOT_REQUESTED", reasons: [] },
      negative_validation: { ok: true },
      environment_validation: { complete: true },
    };
    const candidate = {
      ...base,
      source: { ...base.source, head: "candidate" },
      group_summaries: [{ ...summary, stable: false, pass_rate: 0.5, matched: 1 }],
    };
    writeJson(baselinePath, base);
    writeJson(candidatePath, candidate);
    const compared = compareReports(baselinePath, candidatePath, join(root, "comparison"));
    if (compared.result.verdict !== "REGRESSION" || compared.result.regressions.length !== 1) {
      return { ok: false, reason: "baseline comparison failed" };
    }
    writeFileSync(archivePath, "tampered\n");
    let archiveTamperRejected = false;
    try { compareReports(baselinePath, candidatePath, join(root, "archive-tamper-comparison")); } catch (error) {
      archiveTamperRejected = String(error).includes("archive manifest digest mismatch");
    }
    if (!archiveTamperRejected) return { ok: false, reason: "archive digest tamper was not rejected" };
    writeJson(archivePath, {
      ...archiveContract,
    });

    const stableCandidatePath = join(root, "stable-candidate.json");
    const stableComparisonPath = join(root, "stable-comparison");
    writeJson(stableCandidatePath, { ...candidate, group_summaries: [summary] });
    const stableCompared = compareReports(baselinePath, stableCandidatePath, stableComparisonPath);
    if (stableCompared.result.verdict !== "NO_REGRESSION" || stableCompared.result.release_gate.candidate_failed !== false) {
      return { ok: false, reason: "ordinary comparison must not fail on an unrequested release gate" };
    }

    const requestedGatePath = join(root, "requested-gate.json");
    writeJson(requestedGatePath, {
      ...candidate,
      group_summaries: [summary],
      options: { ...base.options, release_gate: true },
      release_gate: { requested: true, status: "FAIL", reasons: ["fixture failure"] },
    });
    const gateBaselinePath = join(root, "gate-baseline.json");
    writeJson(gateBaselinePath, {
      ...base,
      options: { ...base.options, release_gate: true },
      release_gate: { requested: true, status: "PASS", reasons: [] },
    });
    const requestedCompared = compareReports(gateBaselinePath, requestedGatePath, join(root, "requested-comparison"));
    if (requestedCompared.result.verdict !== "REGRESSION" || requestedCompared.result.release_gate.candidate_failed !== true) {
      return { ok: false, reason: "requested release gate failure was not surfaced" };
    }

    let mismatchRejected = false;
    try {
      compareReports(baselinePath, join(root, "requested-gate.json"), join(root, "mismatch-comparison"));
    } catch (error) {
      mismatchRejected = String(error).includes("not comparable");
    }
    if (!mismatchRejected) return { ok: false, reason: "incompatible report options were accepted" };

    const missingMetadataPath = join(root, "missing-metadata.json");
    const missingMetadata = { ...base, source: { ...base.source } };
    delete missingMetadata.source.runner_digest;
    writeJson(missingMetadataPath, missingMetadata);
    let missingRejected = false;
    try { compareReports(baselinePath, missingMetadataPath, join(root, "missing-metadata-comparison")); } catch (error) {
      missingRejected = String(error).includes("missing comparison metadata");
    }
    if (!missingRejected) return { ok: false, reason: "reports without harness metadata were accepted" };

    const emptyOutput = join(root, "empty-output");
    mkdirSync(emptyOutput);
    assertReusableOutput(emptyOutput, "fixture output");
    const staleOutput = join(root, "stale-output");
    mkdirSync(staleOutput);
    writeFileSync(join(staleOutput, "stale.txt"), "stale\n");
    let staleRejected = false;
    try { assertReusableOutput(staleOutput, "fixture output"); } catch { staleRejected = true; }
    if (!staleRejected) return { ok: false, reason: "non-empty output directory was accepted" };

    const replayRoot = join(root, "replay");
    mkdirSync(replayRoot);
    writeFileSync(join(replayRoot, "evidence.txt"), "evidence\n");
    const archiveRoot = join(root, "archive");
    const archiveDestination = join(archiveRoot, "replays", "collision");
    mkdirSync(archiveDestination, { recursive: true });
    writeFileSync(join(archiveDestination, "old.txt"), "old\n");
    let archiveRejected = false;
    try { archiveRun(replayRoot, archiveRoot, "collision"); } catch { archiveRejected = true; }
    if (!archiveRejected || !existsSync(join(archiveDestination, "old.txt"))) {
      return { ok: false, reason: "existing replay archive was overwritten" };
    }

    const archiveFixtureRoot = join(root, "archive-fixture");
    const fixtureSourceRoot = join(root, "temporary-worktree");
    const fixtureInputPath = join(fixtureSourceRoot, ".m3-inputs-fixture", "entry", "task.json");
    const fixtureInputArchive = join(archiveFixtureRoot, "inputs", "entry");
    const fixtureTaskArchive = join(fixtureInputArchive, "task.json");
    const fixtureArenaArchive = join(archiveFixtureRoot, "replays", "entry-arena");
    mkdirSync(dirname(fixtureInputPath), { recursive: true });
    mkdirSync(fixtureInputArchive, { recursive: true });
    mkdirSync(fixtureArenaArchive, { recursive: true });
    writeJson(fixtureInputPath, { id: "fixture" });
    writeJson(fixtureTaskArchive, { id: "fixture" });
    writeJson(join(fixtureArenaArchive, "task.json"), { source: { task_path: relative(fixtureSourceRoot, fixtureInputPath) } });
    writeJson(join(fixtureArenaArchive, "source.json"), { source_run: join(fixtureSourceRoot, ".eval-runs", "probe") });
    const fixtureMappings = archivePathMappings({
      sourceRoot: fixtureSourceRoot,
      outputRoot: archiveFixtureRoot,
      replaySource: join(fixtureSourceRoot, ".eval-runs", "probe"),
      archivedReplay: join(archiveFixtureRoot, "replays", "entry"),
      arenaRun: join(fixtureSourceRoot, "evals", "runs", "arena"),
      archivedArena: fixtureArenaArchive,
      m2Run: null,
      archivedM2: null,
      m2ArenaRun: null,
      archivedM2Arena: null,
      input: { taskPath: fixtureInputPath },
      archivedInput: fixtureInputArchive,
    });
    rewriteArchivedReferences(fixtureArenaArchive, fixtureMappings, ["task.json", "source.json"]);
    const rewrittenTask = readJson(join(fixtureArenaArchive, "task.json"));
    const rewrittenSource = readJson(join(fixtureArenaArchive, "source.json"));
    if (rewrittenTask.source.task_path !== "inputs/entry/task.json"
      || rewrittenSource.source_run !== "replays/entry"
      || !existsSync(join(archiveFixtureRoot, rewrittenTask.source.task_path))) {
      return { ok: false, reason: "archive references were not normalized to portable paths" };
    }

    const metricsFixtureRoot = join(root, "metrics-run");
    const metricsArenaRoot = join(root, "metrics-arena");
    mkdirSync(metricsFixtureRoot, { recursive: true });
    mkdirSync(metricsArenaRoot, { recursive: true });
    writeJson(join(metricsFixtureRoot, "capability.json"), { dynamic_user: { final_state: "accepted", stop: { action: "complete" } } });
    writeJson(join(metricsFixtureRoot, "capability.regraded.json"), { dynamic_user: { final_state: "propose", stop: { action: "needs_human" } } });
    writeJson(join(metricsArenaRoot, "source.json"), { source_capability_file: "capability.regraded.json" });
    const metricsFixture = runMetrics(metricsFixtureRoot, null, metricsArenaRoot);
    if (metricsFixture.capability_source !== "capability.regraded.json"
      || metricsFixture.final_state !== "propose"
      || metricsFixture.dynamic_stop !== "needs_human") {
      return { ok: false, reason: "metrics did not follow the verified capability source" };
    }
    return { ok: true };
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

function gitHead(root) {
  const result = spawnSync("git", ["rev-parse", "HEAD"], { cwd: root, encoding: "utf8" });
  return result.status === 0 ? result.stdout.trim() : null;
}

function gitCommand(root, args) {
  const result = spawnSync("git", args, { cwd: root, encoding: "utf8", maxBuffer: 8 * 1024 * 1024 });
  return {
    code: typeof result.status === "number" ? result.status : 3,
    stdout: result.stdout ?? "",
    stderr: result.stderr ?? "",
    error: result.error ? String(result.error.message ?? result.error) : null,
  };
}

function resolveGitRef(root, ref, label) {
  if (typeof ref !== "string" || ref.trim() === "" || ref.includes("\0")) {
    throw new Error(label + " must be a non-empty Git ref");
  }
  const result = gitCommand(root, ["rev-parse", "--verify", "--end-of-options", ref + "^{commit}"]);
  const commit = result.stdout.trim();
  if (result.code !== 0 || !/^[0-9a-f]{40}$/i.test(commit)) {
    throw new Error(label + " is not a resolvable commit: " + ref + (result.stderr ? " (" + result.stderr.trim() + ")" : ""));
  }
  return commit;
}

function addDetachedWorktree(root, commit, worktreePath, label) {
  const result = gitCommand(root, ["worktree", "add", "--detach", worktreePath, commit]);
  if (result.code !== 0) {
    const detail = result.stderr || result.stdout || result.error || "unknown git error";
    throw new Error("cannot create " + label + " worktree: " + detail.trim());
  }
  return worktreePath;
}

function removeWorktree(root, worktreePath) {
  if (!existsSync(worktreePath)) return;
  const result = gitCommand(root, ["worktree", "remove", "--force", worktreePath]);
  if (result.code !== 0) rmSync(worktreePath, { recursive: true, force: true });
}

function overlayFixedEvaluator(worktreeRoot) {
  for (const relativePath of FIXED_EVALUATOR_FILES) {
    const source = join(REPO_ROOT, relativePath);
    const destination = join(worktreeRoot, relativePath);
    if (!existsSync(source)) throw new Error("fixed evaluator source does not exist: " + relativePath);
    const parts = relativePath.split(sep);
    let parent = worktreeRoot;
    for (const part of parts.slice(0, -1)) {
      parent = join(parent, part);
      if (existsSync(parent)) {
        const stat = lstatSync(parent);
        if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error("Git ref evaluator parent is not a real directory: " + relativePath);
      } else {
        mkdirSync(parent);
      }
    }
    if (existsSync(destination) && lstatSync(destination).isSymbolicLink()) {
      throw new Error("Git ref evaluator target is a symlink: " + relativePath);
    }
    copyFileSync(source, destination);
  }

  const dependencySource = join(REPO_ROOT, "node_modules");
  const dependencyTarget = join(worktreeRoot, "node_modules");
  const sourceTsc = join(dependencySource, "typescript", "bin", "tsc");
  const targetTsc = join(dependencyTarget, "typescript", "bin", "tsc");
  if (!existsSync(dependencyTarget)) {
    if (!existsSync(sourceTsc)) {
      throw new Error("fixed evaluator dependency is unavailable: node_modules/typescript/bin/tsc");
    }
    symlinkSync(dependencySource, dependencyTarget, "dir");
  } else {
    let targetReal;
    let sourceReal;
    try {
      targetReal = realpathSync(dependencyTarget);
      sourceReal = realpathSync(dependencySource);
    } catch {
      throw new Error("Git-ref worktree TypeScript dependency cannot be resolved safely");
    }
    if (targetReal !== sourceReal || !existsSync(targetTsc) || sha256File(targetTsc) !== sha256File(sourceTsc)) {
      throw new Error("Git-ref worktree has an incompatible TypeScript dependency");
    }
  }
}

function ensureSafeWorktreeDirectory(worktreeRoot, relativePath) {
  const target = join(worktreeRoot, relativePath);
  if (!existsSync(target)) {
    mkdirSync(target, { recursive: true });
    return target;
  }
  const stat = lstatSync(target);
  if (!stat.isDirectory() || stat.isSymbolicLink() || !withinRoot(realpathSync(target), worktreeRoot)) {
    throw new Error("Git ref runtime directory is unsafe: " + relativePath);
  }
  return target;
}

function runRefComparison(options) {
  const baselineCommit = resolveGitRef(REPO_ROOT, options.baselineRef, "baseline ref");
  const candidateCommit = resolveGitRef(REPO_ROOT, options.candidateRef, "candidate ref");
  const worktreeRoot = mkdtempSync(join(tmpdir(), "superspec-m3-ref-worktrees-"));
  const baselineRoot = join(worktreeRoot, "baseline");
  const candidateRoot = join(worktreeRoot, "candidate");
  const timestamp = new Date().toISOString().replace(/[-:.TZ]/g, "").slice(0, 14);
  const outputBase = options.output
    ? resolve(options.output)
    : join(REPO_ROOT, "evals", "runs", "m3-ref-compare-" + timestamp + "-" + process.pid);
  const baselineOutput = join(outputBase, "baseline");
  const candidateOutput = join(outputBase, "candidate");
  try {
    addDetachedWorktree(REPO_ROOT, baselineCommit, baselineRoot, "baseline");
    addDetachedWorktree(REPO_ROOT, candidateCommit, candidateRoot, "candidate");
    overlayFixedEvaluator(baselineRoot);
    overlayFixedEvaluator(candidateRoot);
    ensureSafeWorktreeDirectory(baselineRoot, ".eval-runs");
    ensureSafeWorktreeDirectory(candidateRoot, ".eval-runs");
    ensureSafeWorktreeDirectory(baselineRoot, "evals/runs");
    ensureSafeWorktreeDirectory(candidateRoot, "evals/runs");
    // Keep the test contract fixed while changing only the SuperSpec source under test.
    // This also lets a newer Runner compare against a ref that predates M3 files.
    const suitePath = options.suiteWasExplicit ? options.suite : DEFAULT_SUITE;
    const baselineSuite = loadSuite(suitePath, REPO_ROOT);
    const candidateSuite = loadSuite(suitePath, REPO_ROOT);
    const runOptions = { ...options, output: null, baselineRef: null, candidateRef: null };
    const baseline = runRegression(baselineSuite, runOptions, baselineRoot, baselineOutput);
    const candidate = runRegression(candidateSuite, runOptions, candidateRoot, candidateOutput);
    const comparison = compareReports(
      join(baseline.outputRoot, "regression-result.json"),
      join(candidate.outputRoot, "regression-result.json"),
      join(outputBase, "comparison"),
    );
    return {
      outputRoot: outputBase,
      baseline: { ref: options.baselineRef, commit: baselineCommit, report: join(baseline.outputRoot, "regression-result.json") },
      candidate: { ref: options.candidateRef, commit: candidateCommit, report: join(candidate.outputRoot, "regression-result.json") },
      comparison: comparison.result,
    };
  } finally {
    removeWorktree(REPO_ROOT, candidateRoot);
    removeWorktree(REPO_ROOT, baselineRoot);
    rmSync(worktreeRoot, { recursive: true, force: true });
  }
}

function reportMarkdown(report) {
  const lines = [
    "# SuperSpec M3 Regression",
    "",
    "- Suite: " + report.suite_id,
    "- Source: " + (report.source?.root ?? "unknown"),
    "- Commit: " + (report.source?.head ?? "unknown"),
    "- Archive manifest: " + (report.source?.archive_manifest ?? "unknown"),
    "- Repetitions: " + report.options.repetitions,
    "- Worker: " + report.options.provider + " / " + report.options.model + " / " + report.options.reasoning,
    "- M2: " + (report.options.with_m2 ? "enabled" : "disabled"),
    "",
    "## 结果摘要",
    "",
    "| ID | 分组 | 期望 | 通过率 | 稳定 | 平均回合 | 平均用户确认 | 平均审查 job |",
    "|---|---|---|---:|---|---:|---:|---:|",
  ];
  for (const summary of report.group_summaries) {
    lines.push("| " + summary.id + " | " + summary.group + " | " + summary.expected_status + " | "
      + (summary.pass_rate * 100).toFixed(1) + "% | " + (summary.stable ? "是" : "否") + " | "
      + (summary.mean_worker_turns ?? "-") + " | " + (summary.mean_user_confirmations ?? "-") + " | "
      + (summary.mean_review_jobs ?? "-") + " |");
  }
  lines.push("", "## 硬门禁映射自校验", "", "- 状态：" + (report.negative_validation?.ok ? "通过" : "失败"));
  for (const item of report.negative_validation?.results ?? []) {
    lines.push("- " + item.id + "：实际 " + (item.observed_status ?? "UNKNOWN") + "，期望 " + item.expected_status);
  }
  lines.push("", "## 执行环境指纹", "", "- 状态：" + (report.environment_validation?.complete ? "完整" : "缺失"));
  for (const item of report.environment_validation?.missing_attempts ?? []) lines.push("- 缺失：" + item);
  lines.push("", "## 发布门", "", "- 状态：" + report.release_gate.status);
  if (report.release_gate.requested === false) lines.push("- 本次未请求发布门");
  for (const reason of report.release_gate.reasons) lines.push("- " + reason);
  return lines.join("\n") + "\n";
}

function runSuite(suite, options, outputRoot, sourceRoot = REPO_ROOT) {
  const allEntries = [...suite.entries.green, ...suite.entries.boundary];
  const attempts = [];
  // Arena and M2 deliberately reject task paths outside the repository under
  // test. Keep the ephemeral input contract inside that repository, including
  // when a Git-ref worktree is being evaluated.
  const inputsRoot = mkdtempSync(join(sourceRoot, ".m3-inputs-"));
  try {
    if (!options.dryRun) {
      for (const entry of allEntries) {
        for (let repeat = 1; repeat <= options.repetitions; repeat++) {
          attempts.push(runAttempt(entry, sourceRoot, inputsRoot, outputRoot, options, repeat));
        }
      }
    }
    const groupSummaries = allEntries.map(entry => summarizeEntry(entry, attempts.filter(item => item.entry_id === entry.id)));
    return { attempts, groupSummaries };
  } finally {
    rmSync(inputsRoot, { recursive: true, force: true });
  }
}

function releaseGateReport(suite, options, summaries, negativeValidation) {
  if (!options.releaseGate) return { requested: false, status: "NOT_REQUESTED", reasons: [] };
  const reasons = [];
  if (options.repetitions < 2) reasons.push("发布门至少需要 2 次重复运行");
  for (const summary of summaries) {
    if (!summary.stable) reasons.push(summary.id + " 未达到稳定通过");
  }
  if (!negativeValidation.ok) reasons.push("硬门禁映射自校验未全部通过");
  return { requested: true, status: reasons.length === 0 ? "PASS" : "FAIL", reasons };
}

function assertReusableOutput(path, label) {
  if (!existsSync(path)) return;
  let entries;
  try {
    entries = readdirSync(path);
  } catch {
    throw new Error(label + " must be a directory: " + path);
  }
  if (entries.length > 0) throw new Error(label + " already exists and is not empty: " + path);
}

function archiveRelativePath(root, path) {
  if (!path) return null;
  const value = relative(root, path);
  return value === "" ? "." : value;
}

function writeRegressionArchiveManifest(suite, sourceRoot, outputRoot, execution) {
  const attempts = execution.attempts.map(attempt => ({
    entry_id: attempt.entry_id,
    repeat: attempt.repeat,
    input: archiveRelativePath(outputRoot, attempt.input),
    input_snapshot: attempt.input_snapshot ? {
      root: archiveRelativePath(outputRoot, attempt.input_snapshot.root),
      manifest: archiveRelativePath(outputRoot, attempt.input_snapshot.manifest),
      task: attempt.input_snapshot.task,
      scenario: attempt.input_snapshot.scenario,
    } : null,
    probe_replay: archiveRelativePath(outputRoot, attempt.replay),
    arena_replay: archiveRelativePath(outputRoot, attempt.arena_replay),
    m2_replay: archiveRelativePath(outputRoot, attempt.m2_replay),
    m2_arena_replay: archiveRelativePath(outputRoot, attempt.m2_arena_replay),
    archive_digests: Object.fromEntries(["input", "probe_replay", "arena_replay", "m2_replay", "m2_arena_replay"]
      .map(name => {
        const reference = {
          input: attempt.input,
          probe_replay: attempt.replay,
          arena_replay: attempt.arena_replay,
          m2_replay: attempt.m2_replay,
          m2_arena_replay: attempt.m2_arena_replay,
        }[name];
        const archiveReference = archiveRelativePath(outputRoot, reference);
        return [name, archiveReference && existsSync(join(outputRoot, archiveReference, "archive-manifest.json"))
          ? sha256File(join(outputRoot, archiveReference, "archive-manifest.json"))
          : null];
      })),
  }));
  const manifest = {
    schema_version: 1,
    kind: "m3_archive",
    suite: {
      id: suite.id,
      digest: suite.contract_digest,
      contract: suiteContract(suite),
    },
    source_root: sourceRoot,
    attempts,
  };
  const path = join(outputRoot, "archive-manifest.json");
  writeJson(path, manifest);
  return { path, digest: sha256File(path) };
}

function runRegression(suite, options, sourceRoot = REPO_ROOT, outputRoot = null) {
  const timestamp = new Date().toISOString().replace(/[-:.TZ]/g, "").slice(0, 14);
  const runOutputRoot = outputRoot ?? options.output ?? join(REPO_ROOT, "evals", "runs", "m3-" + suite.id + "-" + timestamp + "-" + process.pid);
  assertReusableOutput(runOutputRoot, "regression output");
  mkdirSync(runOutputRoot, { recursive: true });
  const negativeValidation = validateNegativeSuite(suite, sourceRoot);
  const execution = runSuite(suite, options, runOutputRoot, sourceRoot);
  const environmentObservations = execution.attempts.map(attempt => attempt.environment_digest);
  const missingEnvironmentAttempts = execution.attempts
    .filter(attempt => !attempt.environment_digest)
    .map(attempt => attempt.entry_id + "#" + attempt.repeat);
  const environmentComplete = execution.attempts.length > 0 && missingEnvironmentAttempts.length === 0;
  const gate = releaseGateReport(suite, options, execution.groupSummaries, negativeValidation);
  if (options.releaseGate && !environmentComplete) {
    gate.reasons.push("执行环境指纹缺失：" + (missingEnvironmentAttempts.join(", ") || "没有可比较的 attempt"));
    gate.status = "FAIL";
  }
  const archive = writeRegressionArchiveManifest(suite, sourceRoot, runOutputRoot, execution);
  const report = {
    schema_version: 1,
    kind: "m3_regression",
    suite_id: suite.id,
    source: {
      root: sourceRoot,
      head: gitHead(sourceRoot),
      evaluator_digest: evaluatorDigest(REPO_ROOT),
      runner_digest: sha256File(join(REPO_ROOT, "evals", "regression.mjs")),
      suite_digest: suite.contract_digest,
      suite_contract: suiteContract(suite),
      archive_manifest: relative(runOutputRoot, archive.path),
      archive_manifest_digest: archive.digest,
      environment_digest: environmentComplete ? digestValue(environmentObservations) : null,
      environment_observations: environmentObservations,
      subject_package_digests: [...new Set(execution.attempts.map(attempt => attempt.environment?.package_digest).filter(Boolean))].sort(),
    },
    options: {
      provider: options.provider,
      model: options.model,
      reasoning: options.reasoning,
      reviewer_a_model: options.reviewerAModel,
      reviewer_a_reasoning: options.reviewerAReasoning,
      reviewer_b_model: options.reviewerBModel,
      reviewer_b_reasoning: options.reviewerBReasoning,
      repetitions: options.repetitions,
      with_m2: options.withM2,
      release_gate: options.releaseGate,
    },
    group_summaries: execution.groupSummaries,
    attempts: execution.attempts,
    negative_validation: negativeValidation,
    environment_validation: {
      complete: environmentComplete,
      missing_attempts: missingEnvironmentAttempts,
    },
    release_gate: gate,
  };
  writeJson(join(runOutputRoot, "regression-result.json"), report);
  writeFileSync(join(runOutputRoot, "report.md"), reportMarkdown(report));
  return { outputRoot: runOutputRoot, report };
}

function compareReports(baselinePath, candidatePath, outputPath = null) {
  const baseline = readJson(baselinePath);
  const candidate = readJson(candidatePath);
  if (baseline?.kind !== "m3_regression" || candidate?.kind !== "m3_regression") {
    throw new Error("compare inputs must be m3 regression-result.json files");
  }
  const comparableFields = [
    ["suite_id", baseline.suite_id, candidate.suite_id],
    ["source.evaluator_digest", baseline.source?.evaluator_digest, candidate.source?.evaluator_digest],
    ["source.runner_digest", baseline.source?.runner_digest, candidate.source?.runner_digest],
    ["source.suite_digest", baseline.source?.suite_digest, candidate.source?.suite_digest],
    ["source.environment_digest", baseline.source?.environment_digest, candidate.source?.environment_digest],
    ["options.provider", baseline.options?.provider, candidate.options?.provider],
    ["options.model", baseline.options?.model, candidate.options?.model],
    ["options.reasoning", baseline.options?.reasoning, candidate.options?.reasoning],
    ["options.reviewer_a_model", baseline.options?.reviewer_a_model, candidate.options?.reviewer_a_model],
    ["options.reviewer_a_reasoning", baseline.options?.reviewer_a_reasoning, candidate.options?.reviewer_a_reasoning],
    ["options.reviewer_b_model", baseline.options?.reviewer_b_model, candidate.options?.reviewer_b_model],
    ["options.reviewer_b_reasoning", baseline.options?.reviewer_b_reasoning, candidate.options?.reviewer_b_reasoning],
    ["options.repetitions", baseline.options?.repetitions, candidate.options?.repetitions],
    ["options.with_m2", baseline.options?.with_m2, candidate.options?.with_m2],
    ["options.release_gate", baseline.options?.release_gate, candidate.options?.release_gate],
  ];
  const mismatches = comparableFields.filter(([, before, after]) => before !== after);
  const integrityMetadata = [
    ["negative_validation.ok", baseline.negative_validation?.ok, candidate.negative_validation?.ok],
    ["environment_validation.complete", baseline.environment_validation?.complete, candidate.environment_validation?.complete],
  ];
  const missingMetadata = [...comparableFields, ...integrityMetadata].filter(([, before, after]) => before == null || after == null);
  if (missingMetadata.length > 0) {
    throw new Error("reports are missing comparison metadata: " + missingMetadata.map(([name]) => name).join(", "));
  }
  if (mismatches.length > 0) {
    throw new Error("reports are not comparable: " + mismatches.map(([name, before, after]) => `${name}=${JSON.stringify(before)} vs ${JSON.stringify(after)}`).join(", "));
  }
  verifyReportArchive(baselinePath, baseline);
  verifyReportArchive(candidatePath, candidate);
  const baselineMap = new Map((baseline.group_summaries ?? []).map(item => [item.id, item]));
  const candidateMap = new Map((candidate.group_summaries ?? []).map(item => [item.id, item]));
  const ids = [...new Set([...baselineMap.keys(), ...candidateMap.keys()])].sort();
  const entries = ids.map(id => {
    const before = baselineMap.get(id) ?? null;
    const after = candidateMap.get(id) ?? null;
    const delta = key => before && after && Number.isFinite(before[key]) && Number.isFinite(after[key])
      ? after[key] - before[key]
      : null;
    return {
      id,
      group: after?.group ?? before?.group ?? null,
      before,
      after,
      pass_rate_delta: delta("pass_rate"),
      mean_worker_turns_delta: delta("mean_worker_turns"),
      mean_user_confirmations_delta: delta("mean_user_confirmations"),
      mean_review_jobs_delta: delta("mean_review_jobs"),
      mean_worker_tokens_delta: delta("mean_worker_tokens"),
      regressed: Boolean(before?.stable && (!after || !after.stable)),
    };
  });
  const regressions = entries.filter(item => item.regressed);
  const candidateGateFailed = candidate.release_gate?.requested === true && candidate.release_gate?.status === "FAIL";
  const candidateIntegrityFailures = [
    candidate.negative_validation?.ok === true ? null : "negative validation failed",
    candidate.environment_validation?.complete === true ? null : "execution environment fingerprint incomplete",
  ].filter(Boolean);
  const result = {
    schema_version: 1,
    kind: "m3_baseline_comparison",
    baseline: {
      report: baselinePath,
      suite_id: baseline.suite_id,
      source: baseline.source,
      options: baseline.options,
    },
    candidate: {
      report: candidatePath,
      suite_id: candidate.suite_id,
      source: candidate.source,
      options: candidate.options,
    },
    entries,
    regressions,
    release_gate: {
      baseline: baseline.release_gate?.status ?? null,
      candidate: candidate.release_gate?.status ?? null,
      candidate_failed: candidateGateFailed,
    },
    integrity_failures: candidateIntegrityFailures,
    verdict: regressions.length === 0 && !candidateGateFailed && candidateIntegrityFailures.length === 0 ? "NO_REGRESSION" : "REGRESSION",
  };
  const target = outputPath
    ? resolve(outputPath)
    : join(REPO_ROOT, "evals", "runs", "m3-compare-" + new Date().toISOString().replace(/[-:.TZ]/g, "").slice(0, 14) + "-" + process.pid);
  assertReusableOutput(target, "comparison output");
  mkdirSync(target, { recursive: true });
  writeJson(join(target, "comparison.json"), result);
  const lines = [
    "# SuperSpec M3 Baseline Comparison",
    "",
    "- Baseline: " + (baseline.source?.head ?? "unknown"),
    "- Candidate: " + (candidate.source?.head ?? "unknown"),
    "- Verdict: " + result.verdict,
    "- Candidate release gate: " + (result.release_gate.candidate ?? "not recorded"),
    "",
    "| ID | 通过率变化 | 回合变化 | 用户确认变化 | 审查 job 变化 | Token 变化 |",
    "|---|---:|---:|---:|---:|---:|",
  ];
  for (const item of entries) {
    lines.push("| " + item.id + " | " + (item.pass_rate_delta ?? "-") + " | "
      + (item.mean_worker_turns_delta ?? "-") + " | " + (item.mean_user_confirmations_delta ?? "-") + " | "
      + (item.mean_review_jobs_delta ?? "-") + " | " + (item.mean_worker_tokens_delta ?? "-") + " |");
  }
  writeFileSync(join(target, "comparison.md"), lines.join("\n") + "\n");
  return { target, result };
}

function verifyReportArchive(reportPath, report) {
  const archiveRelative = report.source?.archive_manifest;
  const expectedDigest = report.source?.archive_manifest_digest;
  if (typeof archiveRelative !== "string" || typeof expectedDigest !== "string") {
    throw new Error("report archive metadata is incomplete");
  }
  const reportRoot = dirname(resolve(reportPath));
  const archivePath = resolve(reportRoot, archiveRelative);
  if (!withinRoot(archivePath, reportRoot) || !existsSync(archivePath)) {
    throw new Error("report archive manifest is unavailable: " + archiveRelative);
  }
  const stat = lstatSync(archivePath);
  if (!stat.isFile() || stat.isSymbolicLink() || sha256File(archivePath) !== expectedDigest) {
    throw new Error("report archive manifest digest mismatch: " + archiveRelative);
  }
  const archive = readJson(archivePath);
  if (archive.kind !== "m3_archive"
    || archive.suite?.id !== report.suite_id
    || archive.suite?.digest !== report.source?.suite_digest
    || !Array.isArray(archive.attempts)) {
    throw new Error("report archive manifest contract mismatch");
  }
  const verifiedArchives = new Set();
  for (const attempt of archive.attempts ?? []) {
    if (!attempt?.archive_digests || typeof attempt.archive_digests !== "object") {
      throw new Error("report archive nested digest metadata is incomplete");
    }
    for (const name of ["input", "probe_replay", "arena_replay", "m2_replay", "m2_arena_replay"]) {
      const reference = attempt?.[name];
      if (!reference) continue;
      const referencePath = resolve(reportRoot, reference);
      if (!withinRoot(referencePath, reportRoot) || !existsSync(referencePath)) {
        throw new Error(`report archive reference unavailable: ${name}=${reference}`);
      }
      if (!verifiedArchives.has(referencePath)) {
        verifyArchivedDirectory(referencePath, reportRoot);
        verifiedArchives.add(referencePath);
      }
      const expectedNestedDigest = attempt.archive_digests[name];
      const nestedManifestPath = join(referencePath, "archive-manifest.json");
      if (typeof expectedNestedDigest !== "string" || sha256File(nestedManifestPath) !== expectedNestedDigest) {
        throw new Error(`nested archive manifest digest mismatch: ${name}=${reference}`);
      }
    }
  }
  return archive;
}

function verifyArchivedDirectory(archivePath, reportRoot) {
  const stat = lstatSync(archivePath);
  let archiveReal;
  let rootReal;
  try {
    archiveReal = realpathSync(archivePath);
    rootReal = realpathSync(reportRoot);
  } catch {
    throw new Error("report archive reference cannot be resolved: " + archivePath);
  }
  if (!stat.isDirectory() || stat.isSymbolicLink() || !withinRoot(archiveReal, rootReal)) {
    throw new Error("report archive reference escapes output: " + archivePath);
  }
  const manifestPath = join(archivePath, "archive-manifest.json");
  if (!existsSync(manifestPath) || lstatSync(manifestPath).isSymbolicLink()) {
    throw new Error("nested archive manifest unavailable: " + archivePath);
  }
  const manifest = readJson(manifestPath);
  const rejectSymlinks = current => {
    for (const entry of readdirSync(current, { withFileTypes: true })) {
      const child = join(current, entry.name);
      if (entry.isSymbolicLink()) throw new Error("nested archive contains symlink: " + child);
      if (entry.isDirectory()) rejectSymlinks(child);
    }
  };
  rejectSymlinks(archivePath);
  const expected = manifest.archived_digests;
  if (!expected || typeof expected !== "object"
    || JSON.stringify(expected) !== JSON.stringify(fileDigests(archivePath))) {
    throw new Error("nested archive digest mismatch: " + archivePath);
  }
}

function dryRun(suite, options) {
  const allEntries = [...suite.entries.green, ...suite.entries.boundary];
  return {
    ok: true,
    suite_id: suite.id,
    groups: {
      green: suite.entries.green.map(entry => entry.id),
      boundary: suite.entries.boundary.map(entry => entry.id),
      negative: suite.entries.negative.map(entry => entry.id),
    },
    repetitions: options.repetitions ?? (options.releaseGate ? 2 : 1),
    planned_runs: allEntries.length * (options.repetitions ?? (options.releaseGate ? 2 : 1)),
    with_m2: options.withM2,
  };
}

function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options.help) {
    process.stdout.write(help());
    return 0;
  }
  if (options.compareBaseline || options.compareCandidate) {
    if (!options.compareBaseline || !options.compareCandidate) throw new Error("--compare-baseline and --compare-candidate must be provided together");
    const comparison = compareReports(options.compareBaseline, options.compareCandidate, options.output);
    process.stdout.write(JSON.stringify({ output: comparison.target, verdict: comparison.result.verdict }, null, 2) + "\n");
    return comparison.result.verdict === "NO_REGRESSION" ? 0 : 1;
  }
  if (options.baselineRef || options.candidateRef) {
    const comparison = runRefComparison(options);
    process.stdout.write(JSON.stringify({
      output: comparison.outputRoot,
      baseline: comparison.baseline,
      candidate: comparison.candidate,
      verdict: comparison.comparison.verdict,
    }, null, 2) + "\n");
    return comparison.comparison.verdict === "NO_REGRESSION" ? 0 : 1;
  }
  const suite = loadSuite(options.suite);
  if (options.validateFaults) {
    const evaluator = validateEvaluator(REPO_ROOT);
    const negative = validateNegativeSuite(suite, REPO_ROOT);
    const aggregation = validateAggregation();
    process.stdout.write(JSON.stringify({ ok: evaluator.ok && negative.ok && aggregation.ok, suite_id: suite.id, evaluator, negative, aggregation }, null, 2) + "\n");
    return evaluator.ok && negative.ok && aggregation.ok ? 0 : 1;
  }
  if (options.dryRun) {
    process.stdout.write(JSON.stringify(dryRun(suite, options), null, 2) + "\n");
    return 0;
  }
  const execution = runRegression(suite, options, REPO_ROOT);
  process.stdout.write(JSON.stringify({
    output: execution.outputRoot,
    suite_id: suite.id,
    release_gate: execution.report.release_gate.status,
    summaries: execution.report.group_summaries,
  }, null, 2) + "\n");
  const anyMismatch = execution.report.group_summaries.some(summary => !summary.stable);
  if (options.releaseGate) return execution.report.release_gate.status === "PASS" ? 0 : 1;
  return anyMismatch ? 1 : 0;
}

try {
  process.exitCode = main();
} catch (error) {
  process.stderr.write("M3 regression failed: " + (error instanceof Error ? error.message : String(error)) + "\n");
  process.exitCode = 3;
}
