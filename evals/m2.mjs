#!/usr/bin/env node

import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import {
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
import { recordedWorkerHost } from "./hosts/index.mjs";
import { DEFAULT_JUDGE_HOST_ID, getJudgeHost, judgeIdentity } from "./judges/index.mjs";
import { createInterruptController, createTempDirRegistry, sweepStaleTempDirs } from "./lib/interrupt.mjs";
import { currentEvaluatorDigest } from "./lib/provenance.mjs";
import { commandText, eventsOfKind } from "./lib/trace.mjs";

const EVAL_ROOT = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(EVAL_ROOT, "..");
const RUNS_ROOT = join(EVAL_ROOT, "runs");
const REASONING_LEVELS = new Set(["none", "low", "medium", "high", "xhigh", "max"]);
const REVIEW_TRANSCRIPT_LIMIT = 50;
const REVIEW_CHUNK_CHARS = 8_000;
const REVIEW_ARTIFACT_CHUNKS = 4;
const REVIEW_DIFF_CHUNKS = 8;
const REVIEW_CHANGED_FILE_LIMIT = 80;
const REVIEW_CHANGED_FILE_CHUNKS = 1;
const REVIEW_TEST_OUTPUT_CHARS = 3_000;
const REVIEW_INTERACTION_CHARS = 8_000;
const REVIEW_TIMELINE_TEXT_CHARS = 300;
const REVIEW_REPORT_SUMMARY_CHARS = 1_500;
const REVIEW_REPORT_ITEM_CHARS = 600;
const REVIEW_REPORTS_PATH = /^\.superspec\/changes\/[^/]+\/raw\/review-reports\.jsonl$/u;
const FACT_VISIBILITY_TIERS = ["no_decision_needed", "asked_user", "visible_in_confirmation", "volunteered_by_user", "invisible"];
const FACT_RESULTS = ["consistent", "unclear", "inconsistent"];
const USAGE_EXIT_CODE = 64;

class UsageError extends Error {}

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
    judgeHost: DEFAULT_JUDGE_HOST_ID,
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
    else if (argv[i] === "--judge-host") result.judgeHost = argv[++i] ?? "";
    else if (argv[i] === "--validate-faults") result.validateFaults = true;
    else throw new UsageError(`unknown argument: ${argv[i]}`);
  }
  if (!result.validateFaults && (!result.task || !result.replay)) throw new UsageError("--task and --replay are required");
  try { getJudgeHost(result.judgeHost); } catch (error) { throw new UsageError(error.message); }
  if (!/^[A-Za-z0-9_-]+$/.test(result.provider)) throw new UsageError(`invalid provider: ${result.provider}`);
  for (const [name, model] of [["reviewer A", result.reviewerAModel], ["reviewer B", result.reviewerBModel]]) {
    if (!/^[A-Za-z0-9._-]+$/.test(model)) throw new UsageError(`invalid ${name} model: ${model}`);
  }
  for (const [name, reasoning] of [["reviewer A", result.reviewerAReasoning], ["reviewer B", result.reviewerBReasoning]]) {
    if (!REASONING_LEVELS.has(reasoning)) throw new UsageError(`invalid ${name} reasoning: ${reasoning}`);
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
  return currentEvaluatorDigest();
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
  // 首条提示、终止决策（含最终 next 输出）和 Worker 最后一条消息说明最终交付了什么；
  // 引擎事件排在 transcript 末尾且时间线里另有完整记录，不能让它们把这几条挤出名额。
  for (const record of [
    eligible[0],
    ...eligible.filter(record => record.kind === "run_decision"),
    eligible.findLast(record => record.actor === "worker" && record.kind === "message"),
  ]) {
    if (record && selected.size < REVIEW_TRANSCRIPT_LIMIT) selected.set(record.sequence, record);
  }
  const important = eligible.filter(record => record.actor === "simulated_user"
    || record.actor === "engine"
    || record.kind === "run_decision"
    || (record.kind === "command_observation" && record.exit_code !== 0));
  const remaining = REVIEW_TRANSCRIPT_LIMIT - selected.size;
  if (remaining > 0) for (const record of important.slice(-remaining)) selected.set(record.sequence, record);
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

function boundedText(value, limit) {
  if (value.length <= limit) return value;
  const headChars = Math.ceil(limit / 2);
  const tailChars = Math.floor(limit / 2);
  const omitted = value.length - headChars - tailChars;
  return `${value.slice(0, headChars)}\n...[${omitted} chars omitted]...\n${value.slice(-tailChars)}`;
}

function boundedTestOutput(output) {
  return boundedText(output, REVIEW_TEST_OUTPUT_CHARS);
}

function isGeneratedReviewPath(path) {
  return /(?:^|\/)(?:target|build|dist|out|coverage|node_modules)(?:\/|$)/u.test(path);
}

function testEvidenceFromRun(runRoot) {
  const evidenceRoot = join(runRoot, "evidence");
  if (!existsSync(evidenceRoot)) return [];
  const manifest = existsSync(join(runRoot, "manifest.json")) ? json(join(runRoot, "manifest.json")) : {};
  const host = recordedWorkerHost(manifest);
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
    const parsed = host.parseTrace(path);
    for (const event of eventsOfKind(parsed, "command")) {
      const command = commandText(event);
      if (!isTestCommand(command)) continue;
      const output = String(event.output ?? "");
      const includedOutput = boundedTestOutput(output);
      tests.push({
        ref: `test:turn-${turn}:event-${event.raw_ref.nonblank_line}`,
        source: "worker_command",
        turn,
        command,
        exit_code: event.exit_code ?? null,
        status: event.status ?? null,
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

/** 隐藏事实只给评审，用来判断工作流是否让用户看见了相关决定；Worker 从未看到这些内容。 */
function hiddenFactsFromRun(runRoot) {
  const scenarioPath = join(runRoot, "scenario.json");
  if (!safeRegularWithin(scenarioPath, runRoot)) return { facts: [], limitations: [] };
  let scenario;
  try { scenario = json(scenarioPath); } catch { return { facts: [], limitations: ["scenario evidence malformed; hidden facts unavailable"] }; }
  const knownFacts = scenario?.simulated_user?.known_facts;
  if (knownFacts == null || typeof knownFacts !== "object" || Array.isArray(knownFacts)) return { facts: [], limitations: [] };
  const facts = Object.entries(knownFacts)
    .map(([factId, value]) => ({ fact_id: factId, statement: typeof value === "string" ? value.trim() : value == null ? "" : JSON.stringify(value) }))
    .filter(fact => fact.statement !== "");
  return { facts, limitations: [] };
}

/** 用户在每个交互边界实际看到的问题、可选答复，以及答复由谁给出。 */
function userInteractionsFromRun(runRoot) {
  const turnsPath = join(runRoot, "evidence", "simulated-user-turns.json");
  if (!safeRegularWithin(turnsPath, runRoot)) return { interactions: [], limitations: [] };
  let turns;
  try { turns = json(turnsPath); } catch { return { interactions: [], limitations: ["simulated user turns malformed"] }; }
  if (!Array.isArray(turns)) return { interactions: [], limitations: ["simulated user turns malformed"] };
  const interactions = [];
  const limitations = [];
  for (const turn of turns) {
    const askUser = turn?.next_output?.ask_user;
    if (askUser == null || typeof askUser !== "object") continue;
    const ref = `user-turn:${Number.isInteger(turn.turn) ? turn.turn : "terminal"}`;
    const question = String(askUser.question ?? turn.question ?? "");
    const workerMessage = typeof turn.worker_message === "string" ? turn.worker_message.trim() : "";
    const truncated = question.length > REVIEW_INTERACTION_CHARS || workerMessage.length > REVIEW_INTERACTION_CHARS;
    if (truncated) limitations.push(`user interaction truncated: ${ref}`);
    interactions.push({
      ref,
      turn: turn.turn ?? null,
      after_worker_turn: turn.after_worker_turn ?? null,
      scope: String(askUser.scope ?? turn.scope ?? ""),
      question: boundedText(question, REVIEW_INTERACTION_CHARS),
      question_chars: question.length,
      ...(workerMessage !== "" ? { worker_message: boundedText(workerMessage, REVIEW_INTERACTION_CHARS), worker_message_chars: workerMessage.length } : {}),
      truncated,
      allowed_answers: Array.isArray(askUser.allowed_answers) ? askUser.allowed_answers : [],
      action: turn.action ?? null,
      answer: turn.answer ?? null,
      ...(typeof turn.note === "string" && turn.note !== "" ? { note: turn.note } : {}),
      answer_source: turn.source ?? null,
      evidence_path: "evidence/simulated-user-turns.json",
    });
  }
  return { interactions, limitations };
}

/** 完整的状态时间线；transcript 受条数上限约束，早期事件可能被省略。 */
function workflowTimelineFromRun(runRoot) {
  const eventsPath = join(runRoot, "evidence", "events.jsonl");
  if (!safeRegularWithin(eventsPath, runRoot)) return [];
  const brief = value => {
    if (value == null) return undefined;
    return boundedText(typeof value === "string" ? value : JSON.stringify(value), REVIEW_TIMELINE_TEXT_CHARS);
  };
  const timeline = [];
  for (const line of readFileSync(eventsPath, "utf8").split("\n").filter(Boolean)) {
    let event;
    try { event = JSON.parse(line); } catch { continue; }
    if (typeof event?.event_id !== "string" || event.event_type === "transition_prepare") continue;
    const payload = event.payload ?? {};
    const entry = {
      ref: `engine_event:${event.event_id}`,
      event_type: event.event_type ?? null,
      created_at: event.created_at ?? null,
      transition: payload.transition,
      from_state: payload.from_state,
      to_state: payload.to_state,
      outcome: payload.outcome,
      reason: brief(payload.reason),
      role: payload.role,
      result_kind: payload.result_kind,
      findings: brief(payload.findings),
      scope: payload.scope,
      question_id: payload.question_id,
      question: brief(payload.question),
      answer: brief(payload.answer),
      accepted: payload.accepted,
      closure: payload.closure,
      phase_decision: payload.phase_confirmation?.decision,
      task_id: payload.task_id,
      test_id: payload.test_id,
      exit_code: payload.exit_code,
      semantic_status: payload.semantic_status,
    };
    timeline.push(Object.fromEntries(Object.entries(entry).filter(([, value]) => value !== undefined)));
  }
  return timeline;
}

/**
 * 审查角色登记的完整报告。job_accepted / job_rejected 事件只留 report_digest 与 raw_index，
 * 报告正文不在 changed-files 冻结范围内，只能从运行工作区读取，并按 workspace-changes 的内容指纹核对。
 */
function reviewReportsFromRun(runRoot, workspaceChangeRecords) {
  const reports = [];
  const limitations = [];
  const item = value => boundedText(typeof value === "string" ? value : JSON.stringify(value), REVIEW_REPORT_ITEM_CHARS);
  for (const change of workspaceChangeRecords) {
    if (typeof change?.path !== "string" || !REVIEW_REPORTS_PATH.test(change.path) || change.after?.type !== "file") continue;
    const path = join(runRoot, "workspace", change.path);
    if (!safeRegularWithin(path, runRoot)) {
      limitations.push(`review reports unavailable: ${change.path}`);
      continue;
    }
    if (typeof change.after.digest !== "string" || hashFile(path) !== change.after.digest) {
      limitations.push(`review reports digest mismatch: ${change.path}`);
      continue;
    }
    readFileSync(path, "utf8").split("\n").filter(Boolean).forEach((line, rawIndex) => {
      let report;
      try { report = JSON.parse(line); } catch {
        limitations.push(`review report malformed: ${change.path}#${rawIndex}`);
        return;
      }
      reports.push({
        ref: `review-report:${reports.length + 1}`,
        raw_index: rawIndex,
        job_id: report?.job_id ?? report?.review_scope?.job_id ?? null,
        role: report?.role ?? null,
        verdict: report?.verdict ?? null,
        summary: typeof report?.summary === "string" ? boundedText(report.summary, REVIEW_REPORT_SUMMARY_CHARS) : null,
        findings: (Array.isArray(report?.findings) ? report.findings : []).map(finding => ({
          id: finding?.id ?? null,
          blocking: finding?.blocking === true,
          type: finding?.type ?? null,
          claim_kind: finding?.claim_kind ?? null,
          approved_refs: Array.isArray(finding?.approved_refs) ? finding.approved_refs : [],
          description: item(finding?.description ?? finding),
        })),
        risks: (Array.isArray(report?.risks) ? report.risks : []).map(item),
        evidence_path: `workspace/${change.path}`,
      });
    });
  }
  return { reports, limitations };
}

function buildReviewBundle({ task, capability, capabilityFile, outcome, transcript, runRoot }) {
  const selectedTranscript = selectReviewTranscript(transcript);
  const artifacts = {};
  const limitations = [];
  const hiddenFacts = hiddenFactsFromRun(runRoot);
  const userInteractions = userInteractionsFromRun(runRoot);
  const workflowTimeline = workflowTimelineFromRun(runRoot);
  limitations.push(...hiddenFacts.limitations, ...userInteractions.limitations);
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
  const reviewReports = reviewReportsFromRun(runRoot, workspaceChangeRecords);
  limitations.push(...reviewReports.limitations);
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
    schema_version: 4,
    task: {
      id: task.id,
      description: task.description,
      target: task.target,
      workflow: task.workflow,
    },
    hard_result: outcome,
    capability_source: relative(runRoot, capabilityFile),
    gates: capability.gates,
    hidden_facts: hiddenFacts.facts,
    user_interactions: userInteractions.interactions,
    workflow_timeline: workflowTimeline,
    transcript: selectedTranscript.records,
    transcript_coverage: selectedTranscript.coverage,
    artifacts,
    changed_files: changedFiles,
    change_evidence: changeEvidence,
    test_evidence: testEvidence,
    review_reports: reviewReports.reports,
    review_coverage: {
      complete: limitations.length === 0,
      limitations,
      hidden_fact_count: hiddenFacts.facts.length,
      user_interaction_count: userInteractions.interactions.length,
      timeline_event_count: workflowTimeline.length,
      artifact_count: Object.keys(artifacts).length,
      changed_file_count: Object.keys(changedFiles).length,
      declared_artifact_count: (task.target.required_artifacts ?? []).length,
      test_evidence_count: testEvidence.length,
      review_report_count: reviewReports.reports.length,
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
  for (const interaction of bundle.user_interactions ?? []) refs.add(interaction.ref);
  for (const event of bundle.workflow_timeline ?? []) refs.add(event.ref);
  for (const report of bundle.review_reports ?? []) refs.add(report.ref);
  return refs;
}

function normalizeFactVisibility(items, factIds, refs) {
  const known = new Set(factIds);
  const seen = new Set();
  return (Array.isArray(items) ? items : []).flatMap(item => {
    const factId = String(item?.fact_id ?? "");
    if (!known.has(factId) || seen.has(factId) || !FACT_VISIBILITY_TIERS.includes(item?.tier)) return [];
    seen.add(factId);
    const evidenceRef = String(item?.evidence_ref ?? "");
    return [{
      fact_id: factId,
      tier: item.tier,
      result: FACT_RESULTS.includes(item?.result) ? item.result : "unreported",
      note: typeof item?.note === "string" ? item.note.trim() : "",
      evidence_ref: evidenceRef,
      evidence_valid: refs.has(evidenceRef),
    }];
  });
}

function normalizeReview(raw, reviewerId, refs, factIds = []) {
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
    fact_visibility: normalizeFactVisibility(raw?.fact_visibility, factIds, refs),
    confidence: Number.isFinite(confidence) ? Math.max(0, Math.min(1, confidence)) : 0,
  };
}

function citesUserTurn(vote) {
  return vote.evidence_valid && typeof vote.evidence_ref === "string" && vote.evidence_ref.startsWith("user-turn:");
}

/** 只有用户看不到且评审判定结果不一致或说不清才算失分；结果一致只记观察，评审没给出结果时无法下结论。 */
function hiddenFactIsFlaw(fact) {
  return fact.tier === "invisible" && ["inconsistent", "unclear"].includes(fact.result);
}

/**
 * 评审意见不一致时，优先采信引用了 user-turn 的可见性判断（用户确实被问到或看到确认）。
 * 没有这类证据时，有有效证据的意见优先，再取更差的一档。result 只作观察，不参与档位选择；
 * 它同样只取有有效证据的意见，都没有时才看全部意见，没有意见给出结果时记为 unreported。
 */
function mergeFactVisibility(reviews, factIds) {
  const worse = (order, left, right) => order.indexOf(right) > order.indexOf(left) ? right : left;
  return factIds.map(factId => {
    const votes = reviews.flatMap(review => (review.fact_visibility ?? [])
      .filter(item => item.fact_id === factId)
      .map(item => ({ reviewer_id: review.reviewer_id, ...item })));
    if (votes.length === 0) {
      return { fact_id: factId, tier: "unclassified", result: "unreported", evidence_ref: "", evidence_valid: false, conflict: false, votes: [] };
    }
    const supported = votes.filter(vote => vote.evidence_valid);
    const userTurnVotes = (supported.length > 0 ? supported : votes).filter(vote =>
      citesUserTurn(vote) && ["asked_user", "visible_in_confirmation"].includes(vote.tier)
    );
    const pool = userTurnVotes.length > 0 ? userTurnVotes : supported.length > 0 ? supported : votes;
    const decisive = pool.reduce((current, vote) => worse(FACT_VISIBILITY_TIERS, current.tier, vote.tier) === current.tier ? current : vote);
    const reportedResults = (supported.length > 0 ? supported : votes).map(vote => vote.result).filter(result => FACT_RESULTS.includes(result));
    return {
      fact_id: factId,
      tier: decisive.tier,
      result: reportedResults.length > 0 ? reportedResults.reduce((left, right) => worse(FACT_RESULTS, left, right)) : "unreported",
      evidence_ref: decisive.evidence_ref,
      evidence_valid: decisive.evidence_valid,
      conflict: new Set(votes.map(vote => vote.tier)).size > 1 || new Set(votes.map(vote => vote.result)).size > 1,
      votes: votes.map(({ fact_id, ...vote }) => vote),
    };
  });
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

function mergeReviews(reviews, factIds = []) {
  if (reviews.length === 0) {
    return { requirement_fit: 0, confidence: 0, requirement_fit_conflict: false, issues: [], workflow_optimizations: [], fact_visibility: mergeFactVisibility([], factIds) };
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
    fact_visibility: mergeFactVisibility(reviews, factIds),
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
  for (const fact of merged.fact_visibility ?? []) {
    if (!hiddenFactIsFlaw(fact)) continue;
    const note = fact.votes.find(vote => vote.tier === "invisible" && vote.note)?.note;
    findings.push({
      responsibility: "workflow",
      summary: `decision on hidden fact ${fact.fact_id} was not visible to the user${note ? `: ${note}` : ""}`,
      evidence_ref: fact.evidence_ref,
      confidence: fact.evidence_valid ? 0.8 : 0.2,
      source: "fact_visibility",
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

/** 隐藏事实只有“用户看不到且结果不一致或说不清”算工作流失分；结果一致只记观察。评审漏掉某条事实时无法下结论。 */
function finalStatus(hardStatus, merged) {
  if (hardStatus !== "DONE") return hardStatus;
  const facts = merged.fact_visibility ?? [];
  if (merged.issues.length > 0 || merged.workflow_optimizations.length > 0 || facts.some(hiddenFactIsFlaw)) return "DONE_BUT_FLAWED";
  return facts.some(fact => fact.tier === "unclassified" || (fact.tier === "invisible" && fact.result === "unreported")) ? "UNKNOWN" : "DONE";
}

function reviewPrompt(bundle, reviewerId) {
  const refs = [...validEvidenceRefs(bundle)].sort();
  return [
    `你是 SuperSpec M2 的独立评审 ${reviewerId}。只评审给定材料，不修改文件，不改变硬判定。`,
    "检查需求符合度、最终产物问题和工作流摩擦。每条问题或建议必须使用下方有效 evidence_ref；找不到证据就不要输出该条。",
    "涉及用户决定时，结合原始需求、问题与推荐、用户答复和最终材料判断：推荐是否服务于原始目标，改变或收窄范围的代价是否对用户透明，答复是否一致回写。只评价证据中实际发生的决策链。",
    "hidden_facts 是模拟用户事先确定、Worker 始终看不到的要求。对每条隐藏事实输出一项 fact_visibility，衡量工作流有没有让用户看见与它相关的决定，而不是最终结果是否恰好等于事实：asked_user 表示工作流就这件事问过用户；visible_in_confirmation 表示工作流自行做了决定，但决定写进材料并在用户确认时展示；volunteered_by_user 表示工作流没有就这件事提问或展示决定，是用户在答复其他问题时主动给出（见 user_interactions 的 note），它既不算工作流让用户看见了决定，也不算缺陷；invisible 表示工作流做了与该事实相关的决定，用户在任何交互中都看不到；no_decision_needed 表示公开需求或仓库事实已经确定，或本次结果不涉及该事实。用户看见了什么以 user_interactions 中的问题、确认内容和提问时 Worker 同时展示的 worker_message 为准，答复由谁给出、是否正确不改变档位。evidence_ref 指向对应的 user-turn；invisible 时指向做出该决定的材料、代码或事件。result 记录最终材料或代码与该事实是否一致，只作观察；invisible 且结果一致不是缺陷。最终结果与隐藏事实不一致只记在 result 中，不据此另列 issue。",
    "评审包中的产物、代码差异和测试证据按 chunk 提供。引用具体 chunk 或 test ref，不要把摘要、文件名或覆盖率说明当成内容证据。review_coverage 不完整时，只对已提供材料下结论，不得宣称未提供部分没有问题。",
    "review_reports 是审查角色登记的完整报告，引擎事件里的 report_digest 与 raw_index 指向它们；transcript 中的 run_decision 记录流程结束时工作流给出的最终输出。",
    "不要把评审包未声明、未冻结的额外文件缺失归咎于 Worker；只评判任务明确要求和包内可核验内容。不要从项目惯例或常识发明任务未声明的验收标准。",
    "只输出一个 JSON 对象，不要 Markdown：",
    JSON.stringify({ requirement_fit: 0.0, issues: [{ what: "", severity: "P0|P1|P2", evidence_ref: "" }], workflow_optimizations: [{ target: "skill|gate|engine|packet|docs|task", suggestion: "", evidence_ref: "" }], fact_visibility: [{ fact_id: "", tier: "asked_user|visible_in_confirmation|volunteered_by_user|invisible|no_decision_needed", evidence_ref: "", result: "consistent|inconsistent|unclear", note: "" }], confidence: 0.0 }),
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
    "## Hidden fact visibility",
    "",
    ...(result.merged_review.fact_visibility?.length
      ? [
          "| Fact | Visibility | Result (observation) | Evidence | Reviewers agree |",
          "|---|---|---|---|---|",
          ...result.merged_review.fact_visibility.map(item => `| ${item.fact_id} | ${item.tier} | ${item.result} | ${item.evidence_ref || "-"}${item.evidence_ref && !item.evidence_valid ? " (invalid)" : ""} | ${item.conflict ? "no" : "yes"} |`),
        ]
      : ["- No hidden facts"]),
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
    const reportsPath = ".superspec/changes/fixture/raw/review-reports.jsonl";
    const staleReportsPath = ".superspec/changes/stale/raw/review-reports.jsonl";
    mkdirSync(join(bundleRoot, "workspace", dirname(reportsPath)), { recursive: true });
    mkdirSync(join(bundleRoot, "workspace", dirname(staleReportsPath)), { recursive: true });
    writeFileSync(join(bundleRoot, "workspace", reportsPath), `${[
      { role: "code-reviewer", verdict: "fail", review_scope: { job_id: "JOB-code-1" }, summary: "发现 1 个阻塞问题", findings: [
        { id: "CR-001", blocking: true, type: "implementation", claim_kind: "missing_approved", approved_refs: ["TEST-001"], description: "零结果返回 -0" },
        { id: "CR-002", blocking: false, description: "极大金额溢出为 Infinity" },
      ], risks: ["半值窗口约 1 ULP"] },
      { job_id: "JOB-veri-1", role: "verifier", verdict: "pass", review_scope: { checked_paths: ["tasks.md"] }, findings: [{ id: "CR-002", blocking: false, description: "沿用上一轮 ID，问题仍存在" }] },
    ].map(report => JSON.stringify(report)).join("\n")}\n`);
    writeFileSync(join(bundleRoot, "workspace", staleReportsPath), "{}\n");
    writeJson(join(bundleRoot, "evidence", "workspace-changes.json"), [
      { path: "a.js", before: null, after: { path: "a.js", type: "file" } },
      { path: reportsPath, before: null, after: { path: reportsPath, type: "file", digest: hashFile(join(bundleRoot, "workspace", reportsPath)) } },
      { path: staleReportsPath, before: null, after: { path: staleReportsPath, type: "file", digest: "sha256:stale" } },
    ]);
    writeJson(join(bundleRoot, "evidence", "git-after.json"), { diff_base: "fixture", status: ["M  a.js"] });
    writeFileSync(join(bundleRoot, "evidence", "events.jsonl"), `${[
      { event_id: "EVT-prepare-1", event_type: "transition_prepare", payload: { transition: "propose", from_state: "explore", to_state: "propose" } },
      { event_id: "EVT-decision-1", event_type: "user_decision_recorded", payload: { scope: "propose_open_question:sha256:fixture:DEC-001", question: "耗时怎么显示？", answer: "显示 0.5s", accepted: true, closure: "closed" } },
      {
        event_id: "EVT-test-1",
        event_type: "test_run_recorded",
        event_digest: "sha256:test",
        payload: { test_id: "TEST-001", attempt_id: "ATT-1", command: "rg -q expected a.js", exit_code: 0, semantic_status: "expected_success" },
      },
    ].map(event => JSON.stringify(event)).join("\n")}\n`);
    writeJson(join(bundleRoot, "scenario.json"), { simulated_user: { known_facts: { duration: "499 毫秒显示 0.5s", calendar: "日期保持 UTC", formats: ["csv", "xlsx"], runtime_changes_allowed: false } } });
    writeJson(join(bundleRoot, "evidence", "simulated-user-turns.json"), [
      {
        turn: 2,
        after_worker_turn: 1,
        action: "reply",
        answer: "显示 0.5s",
        source: "ai_user",
        worker_message: "计划摘要：耗时不足 1 秒时保留一位小数",
        next_output: { path: "ask_user", ask_user: { question: "耗时怎么显示？选项：A 显示 0s（推荐） / B 显示 <1s", scope: "propose_open_question:sha256:fixture:DEC-001", allowed_answers: [] } },
      },
      { after_worker_turn: 2, action: "complete", next_output: { path: "done" } },
    ]);
    writeFileSync(join(bundleRoot, "evidence", "turn-1.jsonl"), [
      JSON.stringify({ type: "item.completed", item: { type: "command_execution", command: "npm test", aggregated_output: "pass\n", exit_code: 0, status: "completed" } }),
      JSON.stringify({ type: "item.completed", item: { type: "command_execution", command: "npm run test:unit", aggregated_output: `${"x".repeat(REVIEW_TEST_OUTPUT_CHARS + 10)}TAIL`, exit_code: 1, status: "failed" } }),
      "",
    ].join("\n"));
    const workerMessageCount = REVIEW_TRANSCRIPT_LIMIT + 10;
    const finalWorkerSequence = workerMessageCount + 1;
    const runDecisionSequence = finalWorkerSequence + 1;
    const bundleTranscript = [
      { sequence: 1, actor: "simulated_user", kind: "message", content: "message-1" },
      ...Array.from({ length: workerMessageCount }, (_, index) => ({
        sequence: index + 2,
        actor: "worker",
        kind: "message",
        content: index + 2 === finalWorkerSequence ? "交付说明：遗留意见与候选约定，是否写入？" : `message-${index + 2}`,
      })),
      { sequence: runDecisionSequence, actor: "simulated_user", kind: "run_decision", action: "complete", next_output: { path: "done", review_leftovers: { items: [{ id: "CR-002" }] } } },
      ...Array.from({ length: REVIEW_TRANSCRIPT_LIMIT + 50 }, (_, index) => ({
        sequence: runDecisionSequence + index + 1,
        actor: "engine",
        kind: "job_accepted",
        event_id: `EVT-fixture-${index + 1}`,
      })),
    ];
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
    const selectedSequences = new Set(bundle.transcript.map(record => record.sequence));
    if (bundle.schema_version !== 4
      || !selectedSequences.has(finalWorkerSequence)
      || !selectedSequences.has(runDecisionSequence)
      || bundle.review_reports.length !== 2
      || bundle.review_coverage.review_report_count !== 2
      || bundle.review_reports.map(report => report.raw_index).join(",") !== "0,1"
      || bundle.review_reports.map(report => report.job_id).join(",") !== "JOB-code-1,JOB-veri-1"
      || bundle.review_reports[0].findings[0].claim_kind !== "missing_approved"
      || bundle.review_reports[0].findings[0].approved_refs.join(",") !== "TEST-001"
      || bundle.review_reports[0].findings[1].blocking !== false
      || !bundleRefs.has("review-report:2")
      || !bundle.review_coverage.limitations.includes(`review reports digest mismatch: ${staleReportsPath}`)
      || bundle.hidden_facts.map(fact => fact.fact_id).join(",") !== "duration,calendar,formats,runtime_changes_allowed"
      || bundle.hidden_facts.find(fact => fact.fact_id === "formats")?.statement !== JSON.stringify(["csv", "xlsx"])
      || bundle.hidden_facts.find(fact => fact.fact_id === "runtime_changes_allowed")?.statement !== "false"
      || bundle.user_interactions.length !== 1
      || bundle.user_interactions[0].answer_source !== "ai_user"
      || bundle.user_interactions[0].worker_message !== "计划摘要：耗时不足 1 秒时保留一位小数"
      || !bundleRefs.has("user-turn:2")
      || !bundleRefs.has("engine_event:EVT-decision-1")
      || bundleRefs.has("engine_event:EVT-prepare-1")
      || bundle.workflow_timeline.find(event => event.ref === "engine_event:EVT-decision-1")?.closure !== "closed"
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
      throw new Error("review bundle v4 evidence coverage failed");
    }
  } finally {
    rmSync(bundleRoot, { recursive: true, force: true });
  }
  const factRefs = new Set(["user-turn:2", "artifact:design.md#chunk-1"]);
  const factIds = ["duration", "calendar"];
  const factReview = (reviewerId, factVisibility) => normalizeReview({ requirement_fit: 1, confidence: 1, issues: [], workflow_optimizations: [], fact_visibility: factVisibility }, reviewerId, factRefs, factIds);
  const invisibleReview = factReview("A", [
    { fact_id: "duration", tier: "invisible", evidence_ref: "artifact:design.md#chunk-1", result: "inconsistent", note: "设计自行选定向上取整" },
    { fact_id: "calendar", tier: "no_decision_needed", evidence_ref: "", result: "consistent" },
    { fact_id: "undeclared", tier: "asked_user", evidence_ref: "user-turn:2" },
  ]);
  const askedReview = factReview("B", [{ fact_id: "duration", tier: "asked_user", evidence_ref: "user-turn:2", result: "consistent" }]);
  const conflicting = mergeReviews([invisibleReview, askedReview], factIds);
  const conflictingDuration = conflicting.fact_visibility.find(fact => fact.fact_id === "duration");
  const unsupportedInvisible = mergeReviews([
    factReview("A", [{ fact_id: "duration", tier: "invisible", evidence_ref: "missing" }, { fact_id: "calendar", tier: "no_decision_needed", evidence_ref: "" }]),
    askedReview,
  ], factIds);
  const allVisible = mergeReviews([
    factReview("A", [{ fact_id: "duration", tier: "visible_in_confirmation", evidence_ref: "user-turn:2" }, { fact_id: "calendar", tier: "no_decision_needed", evidence_ref: "" }]),
    askedReview,
  ], factIds);
  const unclassified = mergeReviews([askedReview], factIds);
  const invisibleConsistent = mergeReviews([
    factReview("A", [{ fact_id: "duration", tier: "invisible", evidence_ref: "artifact:design.md#chunk-1", result: "consistent" }, { fact_id: "calendar", tier: "no_decision_needed", evidence_ref: "", result: "consistent" }]),
    factReview("B", [{ fact_id: "duration", tier: "invisible", evidence_ref: "artifact:design.md#chunk-1", result: "consistent" }]),
  ], factIds);
  const invisibleUnclear = mergeReviews([
    factReview("A", [{ fact_id: "duration", tier: "invisible", evidence_ref: "artifact:design.md#chunk-1", result: "unclear" }]),
  ], factIds);
  const invisibleUnreported = mergeReviews([
    factReview("A", [{ fact_id: "duration", tier: "invisible", evidence_ref: "artifact:design.md#chunk-1" }, { fact_id: "calendar", tier: "no_decision_needed", evidence_ref: "", result: "consistent" }]),
  ], factIds);
  const unsupportedResult = mergeReviews([
    factReview("A", [{ fact_id: "duration", tier: "invisible", evidence_ref: "missing", result: "inconsistent" }, { fact_id: "calendar", tier: "no_decision_needed", evidence_ref: "", result: "consistent" }]),
    askedReview,
  ], factIds);
  const volunteered = mergeReviews([
    factReview("A", [{ fact_id: "duration", tier: "volunteered_by_user", evidence_ref: "user-turn:2", result: "consistent" }, { fact_id: "calendar", tier: "no_decision_needed", evidence_ref: "", result: "consistent" }]),
  ], factIds);
  if (invisibleReview.fact_visibility.length !== 2
    || volunteered.fact_visibility.find(fact => fact.fact_id === "duration")?.tier !== "volunteered_by_user"
    || finalStatus("DONE", volunteered) !== "DONE"
    || conflictingDuration?.tier !== "asked_user"
    || conflictingDuration.conflict !== true
    || conflictingDuration.result !== "inconsistent"
    || finalStatus("DONE", conflicting) !== "DONE"
    || attribute({ outcome: done, capability: { gates: gates({}) }, merged: conflicting }).some(finding => finding.source === "fact_visibility")
    || unsupportedInvisible.fact_visibility.find(fact => fact.fact_id === "duration")?.tier !== "asked_user"
    || finalStatus("DONE", unsupportedInvisible) !== "DONE"
    || finalStatus("DONE", allVisible) !== "DONE"
    || finalStatus("DONE", invisibleConsistent) !== "DONE"
    || attribute({ outcome: done, capability: { gates: gates({}) }, merged: invisibleConsistent }).some(finding => finding.source === "fact_visibility")
    || finalStatus("DONE", invisibleUnclear) !== "DONE_BUT_FLAWED"
    || invisibleUnreported.fact_visibility.find(fact => fact.fact_id === "duration")?.result !== "unreported"
    || finalStatus("DONE", invisibleUnreported) !== "UNKNOWN"
    || attribute({ outcome: done, capability: { gates: gates({}) }, merged: invisibleUnreported }).some(finding => finding.source === "fact_visibility")
    || unsupportedResult.fact_visibility.find(fact => fact.fact_id === "duration")?.result !== "consistent"
    || unclassified.fact_visibility.find(fact => fact.fact_id === "calendar")?.tier !== "unclassified"
    || finalStatus("DONE", unclassified) !== "UNKNOWN") {
    throw new Error("hidden fact visibility grading failed");
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
  process.stdout.write(`${JSON.stringify({ ok: true, cases: { done: done.status, invalid: invalid.status, not_done: notDone.status, unknown: unknown.status, needs_human: human.status, configured_target_boundary: targetBoundary.status, injected: injected.status, invalid_evidence_downgraded: true, review_bundle_v4: true, fact_visibility: true, cheats: cheatResults } }, null, 2)}\n`);
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.validateFaults) { validateFaultMappings(); return 0; }
  const judgeHost = getJudgeHost(args.judgeHost);
  const tempDirs = createTempDirRegistry();
  sweepStaleTempDirs({ rules: judgeHost.stale_temp_dir_rules });
  let judge = null;
  const interrupt = createInterruptController({
    onInterrupt() { judge?.terminateAll("SIGTERM"); },
    onForcedExit() {
      judge?.terminateAll("SIGKILL");
      tempDirs.removeAll();
    },
  });
  try {
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
    const merged = { requirement_fit: 0, confidence: 1, requirement_fit_conflict: false, issues: [], workflow_optimizations: [], fact_visibility: [] };
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
    writeM2Manifest(outputRoot, { task_path: relative(REPO_ROOT, taskPath), task_digest: taskDigest, source_run: replayRoot, capability_digest: hashFile(capabilitySource.path), final_status: result.final_status, judge_host: judgeIdentity(judgeHost) });
    process.stdout.write(`${JSON.stringify({ run: outputRoot, final_status: result.final_status, hard_status: hard.status }, null, 2)}\n`);
    return hard.status === "NEEDS_HUMAN" ? 0 : hard.status === "UNKNOWN" ? 3 : 1;
  }

  if (interrupt.interrupted) return interruptedExit(outputRoot, interrupt);
  judge = judgeHost.createRunner({ role: "reviewer", provider: args.provider, registry: tempDirs });
  const reviewerConfigs = [
    { id: "A", model: args.reviewerAModel, reasoning: args.reviewerAReasoning },
    { id: "B", model: args.reviewerBModel, reasoning: args.reviewerBReasoning },
  ];
  const settledReviews = await Promise.allSettled(reviewerConfigs.map(config => judge.run({
    id: `${runId}-${config.id}`,
    model: config.model,
    reasoning: config.reasoning,
    cwd: outputRoot,
    prompt: reviewPrompt(bundle, config.id),
    tracePath: join(outputRoot, `review-${config.id.toLowerCase()}.jsonl`),
    stderrPath: join(outputRoot, `review-${config.id.toLowerCase()}.stderr.log`),
  }).then(result => result.json)));
  if (interrupt.interrupted) return interruptedExit(outputRoot, interrupt);
  const refs = validEvidenceRefs(bundle);
  const factIds = bundle.hidden_facts.map(fact => fact.fact_id);
  const reviews = [];
  const reviewerDetails = {};
  for (let index = 0; index < settledReviews.length; index++) {
    const config = reviewerConfigs[index];
    const key = config.id;
    const tracePath = join(outputRoot, `review-${key.toLowerCase()}.jsonl`);
    const threadIds = judgeHost.sessionIds(tracePath);
    const settled = settledReviews[index];
    if (settled.status === "fulfilled") {
      const review = normalizeReview(settled.value, key, refs, factIds);
      reviews.push(review);
      writeJson(join(outputRoot, `review-${key.toLowerCase()}.json`), review);
      reviewerDetails[key] = { status: "completed", model: config.model, reasoning: config.reasoning, thread_ids: threadIds };
    } else {
      const failure = judgeHost.failureDetail(tracePath, settled.reason);
      writeJson(join(outputRoot, `review-${key.toLowerCase()}.failure.json`), { reviewer_id: key, model: config.model, reasoning: config.reasoning, failure });
      reviewerDetails[key] = { status: "failed", model: config.model, reasoning: config.reasoning, thread_ids: threadIds, failure };
    }
  }
  const merged = mergeReviews(reviews, factIds);
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
  writeM2Manifest(outputRoot, { task_path: relative(REPO_ROOT, taskPath), task_digest: taskDigest, source_run: replayRoot, capability_digest: hashFile(capabilitySource.path), final_status: result.final_status, judge_host: judgeIdentity(judgeHost) });
  process.stdout.write(`${JSON.stringify({ run: outputRoot, final_status: result.final_status, hard_status: hard.status }, null, 2)}\n`);
  return ["DONE", "DONE_BUT_FLAWED", "NEEDS_HUMAN"].includes(result.final_status) ? 0 : result.final_status === "UNKNOWN" ? 3 : 1;
  } finally {
    judge?.terminateAll("SIGKILL");
    tempDirs.removeAll();
    tempDirs.dispose();
    interrupt.dispose();
  }
}

/** Interrupted reviews are never graded: no m2-result, only an interruption marker. */
function interruptedExit(outputRoot, interrupt) {
  writeJson(join(outputRoot, "interrupted.json"), { interrupted: true, signal: interrupt.signal, at: interrupt.at, final_status: "INVALID" });
  process.stderr.write(`M2 interrupted by ${interrupt.signal}; no semantic result was recorded\n`);
  return interrupt.exitCode();
}

try {
  process.exitCode = await main();
} catch (error) {
  process.stderr.write(`M2 failed: ${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = error instanceof UsageError ? USAGE_EXIT_CODE : 1;
}
