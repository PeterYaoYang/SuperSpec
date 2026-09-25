/**
 * Offline checks for P2b data semantics: per-turn token deltas, session-artifact
 * collection (never auth.json), and turn-completion. No model calls.
 */

import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { collectSessionArtifacts, independentAgentAudit, parseCodexTrace } from "../hosts/codex.mjs";
import { summarizeUsageObservations, turnCompletion } from "./trace.mjs";

function writeJsonl(path, records) {
  writeFileSync(path, `${records.map(record => JSON.stringify(record)).join("\n")}\n`);
}

export function validateTraceSemantics() {
  const resumeUsage = summarizeUsageObservations([
    { agent_id: "main", thread_id: "T", raw_ref: { file: "turn-1.jsonl" }, total_tokens: 1000, input_tokens: 800, output_tokens: 200 },
    { agent_id: "main", thread_id: "T", raw_ref: { file: "turn-2.jsonl" }, total_tokens: 2500, input_tokens: 2100, output_tokens: 400 },
  ]);
  if (resumeUsage.total_tokens !== 2500 || resumeUsage.input_tokens !== 2100 || resumeUsage.output_tokens !== 400 || resumeUsage.series !== 1) {
    throw new Error(`resume usage must use per-turn deltas, got ${JSON.stringify(resumeUsage)}`);
  }

  const independent = summarizeUsageObservations([
    { agent_id: "main", thread_id: "A", total_tokens: 800, input_tokens: 600, output_tokens: 200 },
    { agent_id: "main", thread_id: "B", total_tokens: 900, input_tokens: 700, output_tokens: 200 },
  ]);
  if (independent.total_tokens !== 1700 || independent.series !== 2) {
    throw new Error(`independent sessions must not share a usage series, got ${JSON.stringify(independent)}`);
  }

  const reset = summarizeUsageObservations([
    { agent_id: "main", thread_id: "T", total_tokens: 500, input_tokens: 400, output_tokens: 100 },
    { agent_id: "main", thread_id: "T", total_tokens: 120, input_tokens: 100, output_tokens: 20 },
  ]);
  if (reset.total_tokens !== 620) {
    throw new Error(`non-monotonic usage must start a new series, got ${JSON.stringify(reset)}`);
  }

  const additive = summarizeUsageObservations([
    { agent_id: "main", thread_id: "T", semantics: "additive", total_tokens: 500, input_tokens: 400, output_tokens: 100 },
    { agent_id: "main", thread_id: "T", semantics: "additive", total_tokens: 700, input_tokens: 600, output_tokens: 100 },
    { agent_id: "main", thread_id: "T", semantics: "additive", total_tokens: 300, input_tokens: 250, output_tokens: 50 },
  ]);
  if (additive.total_tokens !== 1500 || additive.input_tokens !== 1250 || additive.output_tokens !== 250) {
    throw new Error(`per-call usage must be summed, not differenced, got ${JSON.stringify(additive)}`);
  }

  const root = mkdtempSync(join(tmpdir(), "superspec-p2b-semantics-"));
  try {
    const finished = join(root, "finished.jsonl");
    const truncated = join(root, "truncated.jsonl");
    const failed = join(root, "failed.jsonl");
    writeJsonl(finished, [
      { type: "thread.started", thread_id: "T" },
      { type: "item.completed", item: { type: "agent_message", text: "done" } },
      { type: "turn.completed", usage: { input_tokens: 10, output_tokens: 2, total_tokens: 12 } },
    ]);
    writeJsonl(truncated, [
      { type: "thread.started", thread_id: "T" },
      { type: "item.completed", item: { type: "agent_message", text: "mid" } },
    ]);
    writeJsonl(failed, [
      { type: "thread.started", thread_id: "T" },
      { type: "error", message: "stream dead" },
    ]);
    const finishedTrace = parseCodexTrace(finished);
    const truncatedTrace = parseCodexTrace(truncated);
    const failedTrace = parseCodexTrace(failed);
    if (!finishedTrace.turn_completed || !turnCompletion(finishedTrace).finished) {
      throw new Error("finished turn must have turn_completed and finished=true");
    }
    if (truncatedTrace.turn_completed || !turnCompletion(truncatedTrace).truncated) {
      throw new Error("truncated turn must not claim completion");
    }
    if (failedTrace.turn_completed || !turnCompletion(failedTrace).failed) {
      throw new Error("errored turn must be failed, not completed");
    }
    if (turnCompletion(finishedTrace, { timedOut: true }).finished) {
      throw new Error("timed-out turn must not be finished even when JSONL has turn.completed");
    }

    const hostHome = join(root, "codex-home");
    const dest = join(root, "collected");
    mkdirSync(join(hostHome, "sessions", "2026", "01", "01"), { recursive: true });
    writeFileSync(join(hostHome, "auth.json"), JSON.stringify({ OPENAI_API_KEY: "must-not-copy" }), { mode: 0o600 });
    writeJsonl(join(hostHome, "sessions", "2026", "01", "01", "rollout-parent.jsonl"), [
      { type: "session_meta", payload: { id: "parent-1", source: "exec", originator: "codex_exec" } },
    ]);
    writeJsonl(join(hostHome, "sessions", "2026", "01", "01", "rollout-child.jsonl"), [
      {
        type: "session_meta",
        payload: {
          id: "child-1",
          timestamp: "2026-01-01T00:10:00.000Z",
          parent_thread_id: "parent-1",
          thread_source: "subagent",
          agent_path: "/root/critic",
          agent_nickname: "Critic",
          source: { subagent: { thread_spawn: { parent_thread_id: "parent-1", agent_path: "/root/critic", agent_role: null } } },
        },
      },
      { type: "token_usage_record", payload: { thread_id: "child-1", thread_token_usage: { total_tokens: 33, input_tokens: 30, output_tokens: 3 } } },
    ]);
    chmodSync(hostHome, 0o700);
    const index = collectSessionArtifacts({ hostHome }, dest);
    if (existsSync(join(dest, "auth.json"))) throw new Error("session collection must not copy auth.json");
    if (index.files.length !== 2) throw new Error(`expected 2 collected rollouts, got ${index.files.length}`);
    const child = index.files.find(file => file.kind === "subagent");
    if (!child || child.thread_id !== "child-1" || child.parent_thread_id !== "parent-1") {
      throw new Error(`child session metadata missing: ${JSON.stringify(child)}`);
    }
    if (!existsSync(join(dest, "index.json"))) throw new Error("session collection must write index.json");

    const reviewWindow = { started_at: "2026-01-01T00:05:00.000Z", ended_at: "2026-01-01T00:20:00.000Z" };
    const inWindow = independentAgentAudit(parseCodexTrace(finished), { sessionIndex: index, window: reviewWindow });
    if (!inWindow.ok || inWindow.collected_subagent_count !== 1 || inWindow.attributed_thread_ids[0] !== "child-1") {
      throw new Error("child session started inside the review turn must prove independent-agent provenance");
    }
    if (independentAgentAudit(parseCodexTrace(finished), { sessionIndex: index }).ok) {
      throw new Error("child session without a review-turn window must not prove independence");
    }
    const earlierTurn = { started_at: "2026-01-01T00:00:00.000Z", ended_at: "2026-01-01T00:09:00.000Z" };
    if (independentAgentAudit(parseCodexTrace(finished), { sessionIndex: index, window: earlierTurn }).ok) {
      throw new Error("child session from another turn must not prove independence for the review turn");
    }
    if (independentAgentAudit(parseCodexTrace(finished)).ok) {
      throw new Error("parent-only trace without spawn or collected child must not prove independence");
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
  return true;
}
