#!/usr/bin/env node

import { createHash } from "node:crypto";
import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

const EVAL_ROOT = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(EVAL_ROOT, "..");
const ARENA_RUNS_ROOT = join(EVAL_ROOT, "runs");

function parseArgs(argv) {
  const result = { task: null, replay: null, output: null, validateFaults: false };
  for (let index = 0; index < argv.length; index++) {
    if (argv[index] === "--task") result.task = argv[++index] ?? null;
    else if (argv[index] === "--replay") result.replay = argv[++index] ?? null;
    else if (argv[index] === "--output") result.output = argv[++index] ?? null;
    else if (argv[index] === "--validate-faults") result.validateFaults = true;
    else throw new Error(`unknown argument: ${argv[index]}`);
  }
  if (result.validateFaults) return result;
  if (!result.task) throw new Error("--task is required");
  if (!result.replay) throw new Error("--replay is required for the current M1 slice");
  return result;
}

function sha256(value) {
  return `sha256:${createHash("sha256").update(value).digest("hex")}`;
}

function hashFile(path) {
  return sha256(readFileSync(path));
}

function writeJson(path, value) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`);
}

function json(path) {
  return JSON.parse(readFileSync(path, "utf8"));
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

function verifySeal(runRoot) {
  const sealPath = join(runRoot, "evidence-seal.json");
  const actionPath = join(runRoot, "evidence", "director-actions.jsonl");
  if (!safeRegularWithin(sealPath, runRoot) || !safeRegularWithin(actionPath, runRoot)) {
    return { ok: false, reason: "evidence seal or director action log unavailable" };
  }
  let seal;
  try { seal = json(sealPath); } catch { return { ok: false, reason: "evidence seal malformed" }; }
  if (seal.schema_version !== 1 || seal.actor !== "director" || typeof seal.director_log_prefix_digest !== "string") {
    return { ok: false, reason: "evidence seal metadata invalid" };
  }
  for (const required of ["scenario.json", "manifest.json", "evidence/turn-1.jsonl"]) {
    if (!Object.hasOwn(seal.files ?? {}, required) || seal.files[required] === null) return { ok: false, reason: `required sealed evidence unavailable: ${required}` };
  }
  for (const [relativePath, digest] of Object.entries(seal.files ?? {})) {
    const absolute = join(runRoot, relativePath);
    if (digest === null) {
      if (existsSync(absolute)) return { ok: false, reason: `sealed absent evidence appeared: ${relativePath}` };
      continue;
    }
    if (typeof digest !== "string" || !safeRegularWithin(absolute, runRoot) || hashFile(absolute) !== digest) {
      return { ok: false, reason: `sealed evidence mismatch: ${relativePath}` };
    }
  }
  const actionContent = readFileSync(actionPath, "utf8");
  const actionLines = actionContent.split("\n").filter(Boolean);
  let finalAction;
  try { finalAction = JSON.parse(actionLines.at(-1) ?? "null"); } catch { return { ok: false, reason: "final director action malformed" }; }
  if (finalAction?.phase !== "post-collection.evidence-seal-created" || finalAction.detail?.seal_digest !== hashFile(sealPath)) {
    return { ok: false, reason: "evidence seal is not anchored by the final director action" };
  }
  const prefix = `${actionLines.slice(0, -1).join("\n")}\n`;
  if (sha256(prefix) !== seal.director_log_prefix_digest) return { ok: false, reason: "director action prefix digest mismatch" };
  return { ok: true, seal_digest: hashFile(sealPath), evaluator_source_digest: seal.evaluator_source_digest, sealed_paths: Object.keys(seal.files ?? {}).sort() };
}

function readJsonl(path) {
  if (!existsSync(path)) return { records: [], malformed: 0 };
  const records = [];
  let malformed = 0;
  for (const line of readFileSync(path, "utf8").split("\n")) {
    if (!line.trim()) continue;
    try { records.push(JSON.parse(line)); } catch { malformed++; }
  }
  return { records, malformed };
}

function eventBase(event) {
  const { event_id: _eventId, event_digest: _eventDigest, ...base } = event;
  return base;
}

function digestExact(value) {
  const keys = Object.keys(value).sort();
  return sha256(JSON.stringify(value, keys));
}

function eventsDigest(events) {
  return sha256(events.map(event => event.event_digest).join("\n"));
}

function replayState(events) {
  let state = "init";
  for (const event of events) {
    if (event.event_type === "transition_commit" && typeof event.payload?.to_state === "string") state = event.payload.to_state;
  }
  return state;
}

function inspectState(runRoot) {
  const eventsPath = join(runRoot, "evidence", "events.jsonl");
  const snapshotPath = join(runRoot, "evidence", "snapshot.json");
  if (!existsSync(snapshotPath)) return { status: "not_done", reason: "snapshot unavailable", state: null };
  const events = readJsonl(eventsPath);
  if (events.malformed > 0) return { status: "unknown", reason: "events contain malformed records", state: null };
  let snapshot;
  try { snapshot = json(snapshotPath); } catch { return { status: "unknown", reason: "snapshot malformed", state: null }; }
  if (typeof snapshot.events_digest !== "string" || events.records.some(event => typeof event.event_digest !== "string")) {
    return { status: "unknown", reason: "state digest evidence unavailable", state: null };
  }
  for (const event of events.records) {
    if (digestExact(eventBase(event)) !== event.event_digest) return { status: "unknown", reason: `event digest mismatch: ${event.event_id ?? "unknown"}`, state: null };
  }
  let prefixLength = -1;
  for (let length = 0; length <= events.records.length; length++) {
    if (eventsDigest(events.records.slice(0, length)) === snapshot.events_digest) prefixLength = length;
  }
  if (prefixLength < 0) return { status: "unknown", reason: "snapshot digest does not match an event prefix", state: null };
  const prefixState = replayState(events.records.slice(0, prefixLength));
  if (snapshot.state !== prefixState) return { status: "unknown", reason: "snapshot state disagrees with its event prefix", state: null };
  return {
    status: "ok",
    reason: prefixLength < events.records.length ? "snapshot is a valid stale prefix; full event state used" : "snapshot and events agree",
    state: replayState(events.records),
    snapshot_state: snapshot.state,
    snapshot_prefix_length: prefixLength,
    event_count: events.records.length,
  };
}

function transcriptFromRun(runRoot, scenario, manifest) {
  const transcript = [];
  let sequence = 1;
  const workerPromptEvidencePath = join(runRoot, "evidence", "worker-prompts.json");
  let workerPromptTurns = new Map();
  const promptEvidenceErrors = [];
  if (manifest.prompts?.evidence != null && manifest.prompts.evidence !== "evidence/worker-prompts.json") {
    promptEvidenceErrors.push("worker prompt evidence path is invalid");
  } else if (manifest.prompts?.evidence === "evidence/worker-prompts.json") {
    if (!safeRegularWithin(workerPromptEvidencePath, runRoot)) promptEvidenceErrors.push("worker prompt evidence unavailable");
    try {
      const evidence = json(workerPromptEvidencePath);
      const additions = Array.isArray(evidence.additions) ? evidence.additions : [];
      const additionIds = new Set(additions.filter(addition => typeof addition?.id === "string"
        && typeof addition.content === "string"
        && addition.digest === sha256(addition.content)).map(addition => addition.id));
      const turns = Array.isArray(evidence.turns) ? evidence.turns : [];
      const manifestAdditions = additions.map(({ id, digest }) => ({ id, digest }));
      const validTurns = turns.filter((turn, index) => turn?.turn === index + 1
            && typeof turn.source?.kind === "string"
            && typeof turn.original_prompt === "string"
            && turn.original_prompt_digest === sha256(turn.original_prompt)
            && typeof turn.effective_prompt === "string"
            && turn.effective_prompt_digest === sha256(turn.effective_prompt)
            && Array.isArray(turn.additions)
            && turn.additions.every(id => additionIds.has(id)));
      if (evidence.schema_version !== 1
        || manifest.prompts.schema_version !== 1
        || additions.length !== additionIds.size
        || turns.length !== manifest.prompts.turn_count
        || JSON.stringify(manifestAdditions) !== JSON.stringify(manifest.prompts.additions ?? [])
        || turns[0]?.original_prompt_digest !== manifest.prompts.initial_original_digest
        || turns[0]?.effective_prompt_digest !== manifest.prompts.initial_effective_digest
        || validTurns.length !== turns.length) {
        promptEvidenceErrors.push("worker prompt evidence is invalid");
      } else {
        workerPromptTurns = new Map(validTurns.map(turn => [turn.turn, turn]));
      }
    } catch {
      promptEvidenceErrors.push("worker prompt evidence is malformed");
    }
  }
  const simulatedUserEvidencePath = join(runRoot, "evidence", "simulated-user-turns.json");
  const simulatedUserTurns = scenario.session_mode === "dynamic_user" && safeRegularWithin(simulatedUserEvidencePath, runRoot)
    ? json(simulatedUserEvidencePath)
    : [];
  const initialPromptEvidence = workerPromptTurns.get(1);
  transcript.push({
    sequence: sequence++,
    actor: "simulated_user",
    kind: "message",
    content: initialPromptEvidence?.effective_prompt ?? scenario.initial_prompt,
    evidence_ref: initialPromptEvidence ? "evidence/worker-prompts.json#turn-1" : "scenario.json#initial_prompt",
    ...(initialPromptEvidence ? {
      original_content: initialPromptEvidence.original_prompt,
      original_content_digest: initialPromptEvidence.original_prompt_digest,
      effective_content_digest: initialPromptEvidence.effective_prompt_digest,
      prompt_additions: initialPromptEvidence.additions ?? [],
    } : {}),
  });
  const traceHealth = [];
  let workerTraceCount = 1;
  const appendTrace = (name, prompt = null, promptField = null, promptEvidence = null, frozenPrompt = null) => {
    if (prompt != null) {
      transcript.push({
        sequence: sequence++,
        actor: "simulated_user",
        kind: "message",
        content: prompt,
        evidence_ref: promptEvidence ?? `scenario.json#${promptField ?? "resume_prompt"}`,
        ...(frozenPrompt ? {
          original_content: frozenPrompt.original_prompt,
          original_content_digest: frozenPrompt.original_prompt_digest,
          effective_content_digest: frozenPrompt.effective_prompt_digest,
          prompt_additions: frozenPrompt.additions ?? [],
        } : {}),
      });
    }
    const trace = readJsonl(join(runRoot, "evidence", `${name}.jsonl`));
    traceHealth.push(trace.malformed);
    for (let index = 0; index < trace.records.length; index++) {
      const event = trace.records[index];
      const item = event?.item;
      if (event?.type === "item.completed" && item?.type === "command_execution") {
        transcript.push({
          sequence: sequence++,
          actor: "worker",
          kind: "command_observation",
          turn: name,
          command: item.command ?? item.argv ?? null,
          exit_code: item.exit_code ?? null,
          status: item.status ?? null,
          output_digest: sha256(String(item.aggregated_output ?? item.output ?? "")),
          output_excerpt: String(item.aggregated_output ?? item.output ?? "").slice(0, 500),
          evidence_ref: `trajectory:${name}:${index + 1}`,
        });
      } else if (event?.type === "item.completed" && item?.type === "agent_message") {
        transcript.push({
          sequence: sequence++,
          actor: "worker",
          kind: "message",
          turn: name,
          content: item.text ?? "",
          evidence_ref: `trajectory:${name}:${index + 1}`,
        });
      } else if (event?.type === "item.completed" && item?.type === "collab_tool_call") {
        transcript.push({
          sequence: sequence++,
          actor: "worker",
          kind: "agent_coordination",
          turn: name,
          tool: item.tool ?? null,
          sender_thread_id: item.sender_thread_id ?? null,
          receiver_thread_ids: Array.isArray(item.receiver_thread_ids) ? item.receiver_thread_ids : [],
          agents_states: item.agents_states ?? null,
          status: item.status ?? null,
          evidence_ref: `trajectory:${name}:${index + 1}`,
        });
      }
    }
  };
  appendTrace("turn-1");
  for (let turn = 2; ; turn++) {
    const traceName = `turn-${turn}`;
    if (!existsSync(join(runRoot, "evidence", `${traceName}.jsonl`))) break;
    workerTraceCount++;
    const promptField = turn === 2 ? "resume_prompt" : turn === 3 ? "third_prompt" : `turn_${turn}_prompt`;
    const dynamicTurn = simulatedUserTurns.find(item => item?.turn === turn);
    const frozenPrompt = workerPromptTurns.get(turn);
    appendTrace(
      traceName,
      frozenPrompt?.effective_prompt ?? dynamicTurn?.worker_prompt ?? scenario[promptField] ?? "继续",
      promptField,
      frozenPrompt ? `evidence/worker-prompts.json#turn-${turn}` : dynamicTurn ? `evidence/simulated-user-turns.json#turn-${turn}` : null,
      frozenPrompt,
    );
  }
  if (manifest.prompts?.evidence === "evidence/worker-prompts.json" && workerPromptTurns.size !== workerTraceCount) {
    promptEvidenceErrors.push("worker prompt evidence does not cover every Worker turn");
  }
  for (const terminal of simulatedUserTurns.filter(item => item?.turn == null && typeof item?.action === "string")) {
    transcript.push({
      sequence: sequence++,
      actor: "simulated_user",
      kind: "run_decision",
      action: terminal.action,
      reason: terminal.reason ?? null,
      after_worker_turn: terminal.after_worker_turn ?? null,
      next_output: terminal.next_output ?? null,
      evidence_ref: "evidence/simulated-user-turns.json#terminal",
    });
  }
  const engine = readJsonl(join(runRoot, "evidence", "events.jsonl"));
  for (const event of engine.records) {
    transcript.push({
      sequence: sequence++,
      actor: "engine",
      kind: event.event_type ?? "event",
      event_id: event.event_id ?? null,
      occurred_at: event.occurred_at ?? null,
      payload: event.payload ?? null,
      evidence_ref: `engine_event:${event.event_id ?? sequence - 1}`,
    });
  }
  transcript.push({
    sequence: sequence++,
    actor: "director",
    kind: "run_boundary",
    content: "Worker process and evidence collection completed; no cross-source causal ordering is inferred where Codex events lack timestamps.",
    worker_session: manifest.launch?.session ?? null,
    evidence_ref: "manifest.json#launch",
  });
  return {
    records: transcript,
    malformed_worker_lines: traceHealth.reduce((sum, count) => sum + count, 0),
    malformed_engine_lines: engine.malformed,
    prompt_evidence_errors: promptEvidenceErrors.length,
  };
}

function gradeOutcome(runRoot, task, seal, stateInspection, transcriptHealth = { malformed_worker_lines: 0, malformed_engine_lines: 0, prompt_evidence_errors: 0 }) {
  if (!seal.ok) return { status: "UNKNOWN", reasons: [seal.reason], target_state: task.target.state, observed_state: null };
  if (transcriptHealth.malformed_worker_lines > 0 || transcriptHealth.malformed_engine_lines > 0 || transcriptHealth.prompt_evidence_errors > 0) {
    return { status: "UNKNOWN", reasons: ["transcript evidence is malformed or incomplete"], target_state: task.target.state, observed_state: null };
  }
  if (stateInspection.status === "unknown") return { status: "UNKNOWN", reasons: [stateInspection.reason], target_state: task.target.state, observed_state: null };
  const artifacts = (task.target.required_artifacts ?? []).map(path => ({
    path,
    present: safeRegularWithin(join(runRoot, path), runRoot),
    sealed: seal.sealed_paths?.includes(path) === true,
  }));
  const reasons = [];
  if (stateInspection.state !== task.target.state) reasons.push(`expected state ${task.target.state}, got ${stateInspection.state ?? "unavailable"}`);
  for (const artifact of artifacts) {
    if (!artifact.present) reasons.push(`required artifact unavailable: ${artifact.path}`);
    else if (!artifact.sealed) reasons.push(`required artifact is not covered by the evidence seal: ${artifact.path}`);
  }
  return {
    status: reasons.length === 0 ? "PROVISIONAL_DONE" : "NOT_DONE",
    reasons,
    target_state: task.target.state,
    observed_state: stateInspection.state,
    artifacts,
    result_layer_only: true,
    release_gate_eligible: false,
  };
}

function reportMarkdown({ task, sourceRun, outcome, capability, capabilitySource, seal, transcript }) {
  const lines = [
    `# Arena Report: ${task.id}`,
    "",
    `- Source run: \`${sourceRun}\``,
    `- Workflow entry: \`${task.workflow.entry}\``,
    `- M1 outcome: **${outcome.status}**`,
    `- Probe capability (informational, post-seal): **${capability?.scenario_result ?? "UNKNOWN"} / ${capability?.capability_verdict ?? "UNKNOWN"}**`,
    `- Probe capability source: \`${capabilitySource}\``,
    `- Evidence seal: **${seal.ok ? "verified" : "invalid"}**`,
    `- Transcript records: ${transcript.records.length}`,
    "",
    "## Result boundary",
    "",
    `Target state: \`${outcome.target_state}\`; observed state: \`${outcome.observed_state ?? "unavailable"}\`.`,
    "",
  ];
  if (outcome.reasons.length > 0) {
    lines.push("Reasons:", "", ...outcome.reasons.map(reason => `- ${reason}`), "");
  }
  lines.push(
    "## Interpretation",
    "",
    "`PROVISIONAL_DONE` only means the M1 result layer observed the requested state and artifacts. It does not override Probe scope, isolation, authenticity, or stop-boundary failures and is not a release gate.",
    "",
    "## Probe gates",
    "",
    "| Gate | Status | Detail |",
    "|---|---|---|",
  );
  for (const [name, gate] of Object.entries(capability?.gates ?? {})) {
    lines.push(`| ${name} | ${gate.status} | ${(gate.detail ?? "").replace(/\|/g, "\\|")} |`);
  }
  lines.push("");
  return `${lines.join("\n")}\n`;
}

function isoForPath() {
  return new Date().toISOString().replace(/[-:TZ.]/g, "").slice(0, 14);
}

function validateFaultMappings() {
  const root = mkdtempSync(join(tmpdir(), "superspec-arena-faults-"));
  try {
    mkdirSync(join(root, "artifacts"), { recursive: true });
    writeFileSync(join(root, "artifacts", "discovery.md"), "# Discovery\n");
    const task = { target: { state: "explore", required_artifacts: ["artifacts/discovery.md"] } };
    const seal = { ok: true, sealed_paths: ["artifacts/discovery.md"] };
    const done = gradeOutcome(root, task, seal, { status: "ok", state: "explore" });
    const wrongState = gradeOutcome(root, task, seal, { status: "ok", state: "propose" });
    const unsealed = gradeOutcome(root, task, { ok: true, sealed_paths: [] }, { status: "ok", state: "explore" });
    const unknown = gradeOutcome(root, task, { ok: false, reason: "tampered" }, { status: "ok", state: "explore" });
    const malformed = gradeOutcome(root, task, seal, { status: "ok", state: "explore" }, { malformed_worker_lines: 1, malformed_engine_lines: 0 });
    if (done.status !== "PROVISIONAL_DONE" || wrongState.status !== "NOT_DONE" || unsealed.status !== "NOT_DONE" || unknown.status !== "UNKNOWN" || malformed.status !== "UNKNOWN") {
      throw new Error("arena outcome fault mapping failed");
    }
    const dynamicRoot = join(root, "dynamic");
    const dynamicEvidence = join(dynamicRoot, "evidence");
    mkdirSync(dynamicEvidence, { recursive: true });
    for (let turn = 1; turn <= 6; turn++) {
      writeFileSync(join(dynamicEvidence, `turn-${turn}.jsonl`), `${JSON.stringify({ type: "item.completed", item: { type: "agent_message", text: `worker-${turn}` } })}\n`);
    }
    writeJson(join(dynamicEvidence, "simulated-user-turns.json"), [
      ...Array.from({ length: 5 }, (_, index) => ({ turn: index + 2, action: "continue", worker_prompt: `continue-${index + 2}` })),
      { action: "complete", after_worker_turn: 6, reason: "accepted" },
    ]);
    const promptFixtureAdditions = [{ id: "fixture", content: "boundary", digest: sha256("boundary") }];
    const promptFixtureTurns = Array.from({ length: 6 }, (_, index) => ({
      turn: index + 1,
      source: { kind: index === 0 ? "scenario" : "simulated_user" },
      original_prompt: `original-${index + 1}`,
      original_prompt_digest: sha256(`original-${index + 1}`),
      effective_prompt: `effective-${index + 1}`,
      effective_prompt_digest: sha256(`effective-${index + 1}`),
      additions: ["fixture"],
    }));
    writeJson(join(dynamicEvidence, "worker-prompts.json"), {
      schema_version: 1,
      additions: promptFixtureAdditions,
      turns: promptFixtureTurns,
    });
    const dynamicTranscript = transcriptFromRun(dynamicRoot, { session_mode: "dynamic_user", initial_prompt: "$superspec-explore" }, {
      launch: { session: "persistent_isolated_resume" },
      prompts: {
        schema_version: 1,
        evidence: "evidence/worker-prompts.json",
        turn_count: promptFixtureTurns.length,
        initial_original_digest: promptFixtureTurns[0].original_prompt_digest,
        initial_effective_digest: promptFixtureTurns[0].effective_prompt_digest,
        additions: promptFixtureAdditions.map(({ id, digest }) => ({ id, digest })),
      },
    });
    if (!dynamicTranscript.records.some(record => record.turn === "turn-6" && record.content === "worker-6")
      || !dynamicTranscript.records.some(record => record.kind === "run_decision" && record.action === "complete" && record.after_worker_turn === 6)
      || dynamicTranscript.records[0]?.content !== "effective-1"
      || dynamicTranscript.records[0]?.original_content !== "original-1"
      || !dynamicTranscript.records.some(record => record.content === "effective-2" && record.original_content === "original-2")) {
      throw new Error("arena arbitrary dynamic transcript mapping failed");
    }
    process.stdout.write(`${JSON.stringify({ ok: true, cases: {
      result_complete: done.status,
      wrong_state: wrongState.status,
      unsealed_artifact: unsealed.status,
      invalid_seal: unknown.status,
      malformed_transcript: malformed.status,
      arbitrary_dynamic_transcript: true,
    } }, null, 2)}\n`);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

const args = parseArgs(process.argv.slice(2));
if (args.validateFaults) {
  validateFaultMappings();
  process.exit(0);
}
const taskPath = resolve(REPO_ROOT, args.task);
const sourceRun = resolve(REPO_ROOT, args.replay);
if (!safeRegularWithin(taskPath, REPO_ROOT)) throw new Error(`task unavailable or unsafe: ${taskPath}`);
if (!existsSync(sourceRun)) throw new Error(`source run unavailable: ${sourceRun}`);
const task = json(taskPath);
const scenario = json(join(sourceRun, "scenario.json"));
const manifest = json(join(sourceRun, "manifest.json"));
const originalCapability = json(join(sourceRun, "capability.json"));
let capability = originalCapability;
let capabilitySource = "capability.json";
const regradedCapabilityPath = join(sourceRun, "capability.regraded.json");
const regradeManifestPath = join(sourceRun, "regrade-manifest.json");
if (safeRegularWithin(regradedCapabilityPath, sourceRun) && safeRegularWithin(regradeManifestPath, sourceRun)) {
  const regradeManifest = json(regradeManifestPath);
  if (resolve(regradeManifest.source_run ?? "") === sourceRun && regradeManifest.worker_reexecuted === false) {
    capability = json(regradedCapabilityPath);
    capabilitySource = "capability.regraded.json";
  }
}
if (scenario.id !== task.workflow.scenario_id) throw new Error(`task scenario mismatch: expected ${task.workflow.scenario_id}, got ${scenario.id}`);
if (!String(scenario.initial_prompt ?? "").trim().startsWith(task.workflow.entry)) throw new Error("source scenario does not use the task's explicit workflow entry");

const outputRoot = args.output
  ? resolve(REPO_ROOT, args.output)
  : join(ARENA_RUNS_ROOT, `${task.id}-${isoForPath()}-${basename(sourceRun)}`);
if (outputRoot !== ARENA_RUNS_ROOT && !outputRoot.startsWith(`${ARENA_RUNS_ROOT}${sep}`)) {
  throw new Error(`arena output must stay within ${ARENA_RUNS_ROOT}`);
}
if (existsSync(outputRoot)) throw new Error(`arena output already exists: ${outputRoot}`);
mkdirSync(outputRoot, { recursive: true });
const seal = verifySeal(sourceRun);
const stateInspection = inspectState(sourceRun);
const transcript = transcriptFromRun(sourceRun, scenario, manifest);
const transcriptHealth = {
  malformed_worker_lines: transcript.malformed_worker_lines,
  malformed_engine_lines: transcript.malformed_engine_lines,
  prompt_evidence_errors: transcript.prompt_evidence_errors,
};
const outcome = gradeOutcome(sourceRun, task, seal, stateInspection, transcriptHealth);
const taskSnapshot = {
  ...task,
  source: { task_path: relative(REPO_ROOT, taskPath), scenario_digest: hashFile(join(sourceRun, "scenario.json")) },
};
writeJson(join(outputRoot, "task.json"), taskSnapshot);
writeJson(join(outputRoot, "source.json"), {
  source_run: sourceRun,
  arena_evaluator_digest: hashFile(fileURLToPath(import.meta.url)),
  evidence_seal: seal,
  source_capability_is_post_seal_informational: true,
  source_capability_file: capabilitySource,
  source_capability: {
    scenario_result: capability.scenario_result,
    capability_verdict: capability.capability_verdict,
    exit_code: capability.exit_code,
  },
  original_source_capability: {
    scenario_result: originalCapability.scenario_result,
    capability_verdict: originalCapability.capability_verdict,
    exit_code: originalCapability.exit_code,
  },
});
writeFileSync(join(outputRoot, "transcript.jsonl"), transcript.records.map(record => JSON.stringify(record)).join("\n") + "\n");
writeJson(join(outputRoot, "outcome.json"), { ...outcome, state_evidence: stateInspection, transcript_health: transcriptHealth });
writeFileSync(join(outputRoot, "report.md"), reportMarkdown({ task, sourceRun, outcome, capability, capabilitySource, seal, transcript }));
process.stdout.write(`${JSON.stringify({ run: outputRoot, outcome, source_capability: capability.scenario_result }, null, 2)}\n`);
process.exitCode = outcome.status === "UNKNOWN" ? 3 : outcome.status === "NOT_DONE" ? 1 : 0;
