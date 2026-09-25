/**
 * Host-neutral representation of one recorded agent session ("NormalizedTrace").
 *
 * Host adapters (evals/hosts/*.mjs, evals/judges/*.mjs) translate their native
 * session records into this shape; gates, Arena and M2 read only this shape.
 * Every parsed raw record is retained: records without a semantic mapping stay
 * `unknown` (with `raw_type` / `item_type` for diagnostics). Hosts may expand
 * one raw record into several semantic events (e.g. an assistant message that
 * carries both text and tool calls); nothing the host emitted is dropped.
 *
 * @typedef {"command"|"message"|"file_change"|"file_access"|"agent_coordination"|"usage"|"turn_end"|"error"|"thread"|"unknown"} TraceEventKind
 *
 * @typedef {object} RawRef
 * @property {string|null} file          Source file (null for in-memory fixtures).
 * @property {number} line               1-based physical line in the file.
 * @property {number} nonblank_line      1-based index among non-empty lines (M2 test-evidence refs).
 * @property {number} record             1-based index among parsed records (Arena trajectory refs).
 *
 * @typedef {object} TraceEvent
 * @property {number} seq                Global order across every source of the trace.
 * @property {string} agent_id           Agent that produced the event ("main" until subagent traces exist).
 * @property {TraceEventKind} kind
 * @property {string|null} raw_type      Native record type (host specific, diagnostic only).
 * @property {RawRef} raw_ref
 *
 * Kind-specific fields:
 * - command: `command` (raw command value as recorded, normally the shell string),
 *   `argv` (string array when the host recorded one, else null), `status`,
 *   `exit_code` (canonical field, null when absent), `legacy_exit_code`,
 *   `cwd` (raw cwd value when recorded), `output` (raw output value),
 *   `output_field`, `output_text`, `output_bytes`, `source_shape`
 *   ("item.completed" | "event" | "item.status_completed").
 * - message: `role`, `text` (raw value).
 * - file_change: `status`, `changes` (raw array of `{ path, kind }`; kind is
 *   "add" | "update" | "delete" as in Codex file_change items).
 * - file_access: `tool`, `status`, `paths` (string array) for host file tools
 *   (read/search/edit) that bypass the shell and so leave no command event.
 * - agent_coordination: `tool`, `status`, `sender_thread_id`,
 *   `receiver_thread_ids` (raw), `agents_states`.
 * - thread: `action` ("started" | "resumed"), `thread_id` (raw).
 * - turn_end: `usage` (raw usage object as reported by the host).
 * - usage: `usage` (raw usage object reported outside a turn boundary).
 * - error: `message` (raw).
 * - unknown: `item_type` when the record wrapped a host item.
 *
 * @typedef {object} NormalizedTrace
 * @property {number} schema_version
 * @property {string} host
 * @property {{ id: string, parent: string|null }[]} agents
 * @property {object[]} sources          Per-file parse health.
 * @property {TraceEvent[]} events
 * @property {number} raw_event_count    Non-empty raw lines (plus appended lines).
 * @property {number} malformed_line_count  Non-empty lines that are not records (includes whitespace-only lines).
 * @property {number} invalid_json_line_count  Non-blank lines that fail to parse.
 * @property {boolean} command_schema_recognized  Host confirmed the command schema is one it understands.
 * @property {boolean} turn_completed  True only when the last non-unknown event is `turn_end`.
 * @property {{ seq: number, agent_id: string, raw_ref: RawRef, usage: unknown }[]} usage  Raw usage reports in order; no summation semantics.
 */

export const TRACE_SCHEMA_VERSION = 1;
export const MAIN_AGENT_ID = "main";

/**
 * @param {string} host
 * @returns {NormalizedTrace}
 */
export function emptyTrace(host) {
  return {
    schema_version: TRACE_SCHEMA_VERSION,
    host,
    agents: [{ id: MAIN_AGENT_ID, parent: null }],
    sources: [],
    events: [],
    raw_event_count: 0,
    malformed_line_count: 0,
    invalid_json_line_count: 0,
    command_schema_recognized: false,
    turn_completed: false,
    usage: [],
  };
}

/**
 * Appends a normalized event and keeps the parsed raw record reachable through
 * {@link rawRecord} without serializing it with the trace.
 * @param {NormalizedTrace} trace
 * @param {Omit<TraceEvent, "seq"|"agent_id"> & { agent_id?: string }} event
 * @param {unknown} raw
 * @returns {TraceEvent}
 */
export function appendTraceEvent(trace, event, raw) {
  const normalized = { seq: trace.events.length + 1, agent_id: event.agent_id ?? MAIN_AGENT_ID, ...event };
  Object.defineProperty(normalized, "raw", { value: raw, enumerable: false });
  trace.events.push(normalized);
  if ((normalized.kind === "turn_end" || normalized.kind === "usage") && normalized.usage != null) {
    trace.usage.push({ seq: normalized.seq, agent_id: normalized.agent_id, raw_ref: normalized.raw_ref, usage: normalized.usage });
  }
  finalizeTurnCompletion(trace);
  return normalized;
}

/** Last non-unknown event decides whether this JSONL is a finished turn. */
export function finalizeTurnCompletion(trace) {
  const last = [...(trace?.events ?? [])].reverse().find(event => event.kind !== "unknown") ?? null;
  trace.turn_completed = last?.kind === "turn_end";
  return last;
}

/**
 * Whether a parsed turn actually finished. `turn_completed` is parse-only;
 * timeout/interrupt come from the Director, not the JSONL.
 */
export function turnCompletion(trace, { timedOut = false, interrupted = false } = {}) {
  const last = [...(trace?.events ?? [])].reverse().find(event => event.kind !== "unknown") ?? null;
  const lastKind = last?.kind ?? null;
  const observedTurnEnd = eventsOfKind(trace, "turn_end").length > 0;
  const lastIsEnd = lastKind === "turn_end";
  const lastIsError = lastKind === "error";
  return {
    observed_turn_end: observedTurnEnd,
    finished: lastIsEnd && !timedOut && !interrupted,
    timed_out: timedOut === true,
    interrupted: interrupted === true,
    last_kind: lastKind,
    truncated: !lastIsEnd && !lastIsError && !timedOut && !interrupted,
    failed: lastIsError || timedOut === true,
  };
}

/**
 * Groups raw usage observations into monotonic series. Same thread across
 * resume files shares a series; a drop in cumulative totals starts a new one.
 * Observations marked `semantics: "additive"` (per-call usage) are each their
 * own series, so their delta is the reported value itself.
 */
export function groupUsageObservations(observations) {
  const series = new Map();
  let additive = 0;
  for (const observation of observations ?? []) {
    const key = observation.semantics === "additive"
      ? `additive:${additive++}`
      : observation.thread_id
      ? `thread:${observation.agent_id ?? MAIN_AGENT_ID}:${observation.thread_id}`
      : `file:${observation.agent_id ?? MAIN_AGENT_ID}:${observation.raw_ref?.file ?? "unknown"}`;
    if (!series.has(key)) series.set(key, []);
    series.get(key).push(observation);
  }
  return [...series.values()];
}

/**
 * Converts one cumulative series into per-report deltas. A non-monotonic total
 * is treated as a new series (independent thread reused the same key).
 */
export function usageDeltas(observations) {
  const deltas = [];
  let previous = null;
  for (const observation of observations ?? []) {
    const current = {
      total_tokens: observation.total_tokens ?? 0,
      input_tokens: observation.input_tokens,
      output_tokens: observation.output_tokens,
    };
    if (previous && current.total_tokens < previous.total_tokens) previous = null;
    const base = previous ?? { total_tokens: 0, input_tokens: 0, output_tokens: 0 };
    deltas.push({
      ...observation,
      total_tokens: Math.max(0, current.total_tokens - (base.total_tokens ?? 0)),
      input_tokens: current.input_tokens == null || base.input_tokens == null
        ? null
        : Math.max(0, current.input_tokens - base.input_tokens),
      output_tokens: current.output_tokens == null || base.output_tokens == null
        ? null
        : Math.max(0, current.output_tokens - base.output_tokens),
      cumulative: current,
    });
    previous = current;
  }
  return deltas;
}

/** Sums per-turn deltas across every series. */
export function summarizeUsage(seriesList) {
  const deltas = (seriesList ?? []).flatMap(usageDeltas);
  if (deltas.length === 0) {
    return { observed: false, total_tokens: null, input_tokens: null, output_tokens: null, turns_with_usage: 0, series: 0 };
  }
  return {
    observed: true,
    total_tokens: deltas.reduce((sum, item) => sum + item.total_tokens, 0),
    input_tokens: deltas.every(item => item.input_tokens !== null)
      ? deltas.reduce((sum, item) => sum + item.input_tokens, 0)
      : null,
    output_tokens: deltas.every(item => item.output_tokens !== null)
      ? deltas.reduce((sum, item) => sum + item.output_tokens, 0)
      : null,
    turns_with_usage: deltas.length,
    series: seriesList.length,
  };
}

export function summarizeUsageObservations(observations) {
  return summarizeUsage(groupUsageObservations(observations));
}

/**
 * Splits JSONL text into raw records while keeping every legacy line index.
 * @param {string} text
 * @param {string|null} file
 */
export function splitJsonlRecords(text, file) {
  const records = [];
  const health = { file, present: true, nonblank_lines: 0, parsed_records: 0, invalid_json_lines: 0, whitespace_only_lines: 0 };
  const lines = text.split("\n");
  for (let index = 0; index < lines.length; index++) {
    const line = lines[index];
    if (!line) continue;
    health.nonblank_lines++;
    if (!line.trim()) {
      health.whitespace_only_lines++;
      continue;
    }
    let value;
    try {
      value = JSON.parse(line);
    } catch {
      health.invalid_json_lines++;
      continue;
    }
    health.parsed_records++;
    records.push({ value, raw_ref: { file, line: index + 1, nonblank_line: health.nonblank_lines, record: health.parsed_records } });
  }
  return { records, health };
}

/** @param {NormalizedTrace} trace @param {TraceEventKind} kind */
export function eventsOfKind(trace, kind) {
  return (trace?.events ?? []).filter(event => event.kind === kind);
}

/** @param {TraceEvent} event */
export function rawRecord(event) {
  return event?.raw;
}

/**
 * Command text used by policy audits: argv joined with spaces when recorded,
 * otherwise the raw command value coerced to a string.
 * @param {TraceEvent} command
 */
export function commandText(command) {
  return Array.isArray(command.argv) ? command.argv.join(" ") : String(command.command ?? "");
}

/**
 * Collected subagent sessions attributable to one Worker turn: a subagent is
 * attributed only when its session start falls inside the turn's Director
 * window. Without a window (or a recorded start) nothing is attributable.
 * @param {{ files?: object[] }|null} sessionIndex
 * @param {{ started_at?: string|null, ended_at?: string|null }|null} window
 */
export function subagentSessionsInWindow(sessionIndex, window) {
  const subagents = (sessionIndex?.files ?? []).filter(file => file.kind === "subagent" && typeof file.thread_id === "string" && file.thread_id !== "");
  const start = Date.parse(window?.started_at ?? "");
  const end = window?.ended_at ? Date.parse(window.ended_at) : Number.POSITIVE_INFINITY;
  const attributed = Number.isFinite(start)
    ? subagents.filter(file => {
      const at = Date.parse(file.started_at ?? "");
      return Number.isFinite(at) && at >= start && at <= end;
    })
    : [];
  return { subagents, attributed };
}

/** Shared independent-review audit shape; hosts supply receiver ids from their own coordination events. */
export function independentReviewAudit({ spawnCalls, receiverIds, emptyWaitCount = 0, sessionIndex = null, window = null }) {
  const { subagents, attributed } = subagentSessionsInWindow(sessionIndex, window);
  const attributedIds = attributed.map(file => file.thread_id);
  return {
    ok: receiverIds.length > 0 || attributedIds.length > 0,
    spawn_call_count: spawnCalls.length,
    receiver_thread_ids: receiverIds,
    empty_wait_count: emptyWaitCount,
    collected_session_count: sessionIndex?.files?.length ?? 0,
    collected_subagent_count: subagents.length,
    collected_thread_ids: subagents.map(file => file.thread_id),
    window: window ? { started_at: window.started_at ?? null, ended_at: window.ended_at ?? null } : null,
    attributed_thread_ids: attributedIds,
  };
}

/** Unique thread/session ids announced by the trace, in first-seen order. */
export function traceThreadIds(trace) {
  return [...new Set(eventsOfKind(trace, "thread").map(event => event.thread_id).filter(id => typeof id === "string"))];
}

/** Final agent message texts (string texts only), in order. */
export function traceAgentMessages(trace) {
  return eventsOfKind(trace, "message")
    .filter(event => event.role === "agent" && typeof event.text === "string")
    .map(event => event.text);
}

/** Changes from completed file-change events, in order. */
export function traceCompletedFileChanges(trace) {
  const changes = [];
  for (const event of eventsOfKind(trace, "file_change")) {
    if (event.status !== "completed") continue;
    try {
      for (const change of event.changes ?? []) changes.push(change);
    } catch {}
  }
  return changes;
}

/**
 * Parses the last complete JSON value from command output (workflow CLIs print
 * one JSON document, sometimes after unrelated shell output).
 * @param {unknown} text
 */
export function parseLastJson(text) {
  const trimmed = String(text ?? "").trim();
  if (!trimmed) return null;
  try { return JSON.parse(trimmed); } catch {}

  let last = null;
  let start = -1;
  let depth = 0;
  let quote = false;
  let escaped = false;
  for (let index = 0; index < trimmed.length; index++) {
    const char = trimmed[index];
    if (start < 0) {
      if (char === "{" || char === "[") {
        start = index;
        depth = 1;
        quote = false;
        escaped = false;
      }
      continue;
    }
    if (quote) {
      if (escaped) escaped = false;
      else if (char === "\\") escaped = true;
      else if (char === '"') quote = false;
      continue;
    }
    if (char === '"') {
      quote = true;
      continue;
    }
    if (char === "{" || char === "[") depth++;
    else if (char === "}" || char === "]") depth--;
    if (depth !== 0) continue;
    try { last = JSON.parse(trimmed.slice(start, index + 1)); } catch {}
    start = -1;
  }
  return last;
}
