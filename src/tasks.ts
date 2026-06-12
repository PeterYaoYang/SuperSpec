import { createHash } from "node:crypto";
import { existsSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import type { JsonMap, Reason, TaskInfo } from "./util.ts";
import { reason, renderList, walkFiles } from "./util.ts";
import { sidecar_test_contract_path } from "./paths.ts";
import { live_pass } from "./evidence.ts";

const TASK_LINE = /^- \[( |x|X)\]\s+(\S+)\s*(.*)$/;
const ATTR_LINE = /^\s+- (\w+):\s*(.*)$/;
const TEST_ID_RE = /\bTEST-\d+[A-Za-z0-9_-]*\b/g;
const SCENARIO_RE = /^####\s+Scenario:?\s*(.+?)\s*$/;

export type TestContractRecord = {
  row: number;
  test_id: string;
  scenario_ref: string;
  invariant_refs: string[];
};

export type TestCommandResolution = {
  test_id: string;
  command: string | null;
  source: "test_command" | "test_command_ref" | null;
  command_ref?: string;
  expected_failure_signature?: string;
  expected_failure_classifier?: string;
  blockers: Reason[];
};

export function parse_tasks(changeRoot: string): Record<string, TaskInfo> {
  const tasksMd = join(changeRoot, "tasks.md");
  if (!existsSync(tasksMd) || !statSync(tasksMd).isFile()) return {};
  const tasks: Record<string, TaskInfo> = {};
  let current: TaskInfo | null = null;
  for (const raw of readFileSync(tasksMd, "utf8").split(/\r?\n/)) {
    const match = raw.match(TASK_LINE);
    if (match) {
      const checked = match[1].toLowerCase() === "x";
      const taskId = match[2].trim();
      current = { task_id: taskId, checked, desc: match[3].trim(), attrs: {} };
      tasks[taskId] = current;
      continue;
    }
    const attr = raw.match(ATTR_LINE);
    if (attr && current) {
      current.attrs[attr[1]] = attr[2].trim();
    } else if (raw && !raw.startsWith(" ") && !raw.startsWith("\t")) {
      current = null;
    }
  }
  return tasks;
}

// FIX-8 (audit A-5): checkbox-state-insensitive fingerprint of tasks.md. Checking a box is
// normal apply progress; any other edit (new task, attrs, descriptions) changes the hash and
// therefore invalidates the user's apply-scope approval.
export function tasks_structure_hash(changeRoot: string): string | null {
  const tasksMd = join(changeRoot, "tasks.md");
  if (!existsSync(tasksMd) || !statSync(tasksMd).isFile()) return null;
  const normalized = readFileSync(tasksMd, "utf8").replace(/^(\s*[-*]\s*)\[[xX]\]/gm, "$1[ ]");
  return `sha256:${createHash("sha256").update(normalized, "utf8").digest("hex")}`;
}

export function splitList(value: string): string[] {
  const stripped = value.trim().replace(/^\[/, "").replace(/\]$/, "");
  if (!stripped) return [];
  return stripped.split(/[,\s]+/).map((item) => item.trim()).filter(Boolean);
}

function parseMarkdownRow(line: string): string[] {
  return line.trim().replace(/^\|/, "").replace(/\|$/, "").split("|").map((cell) => cell.trim());
}

function isSeparatorRow(cells: string[]): boolean {
  return cells.length > 0 && cells.every((cell) => /^:?-{3,}:?$/.test(cell));
}

function normalizeHeader(header: string): string {
  return header.trim().toLowerCase().replace(/\s+/g, "_");
}

function tableLinesAfterHeading(text: string, headings: RegExp[]): string[] {
  const lines = text.split(/\r?\n/);
  const start = lines.findIndex((line) => headings.some((heading) => heading.test(line.trim())));
  if (start < 0) return [];
  const table: string[] = [];
  let started = false;
  for (const line of lines.slice(start + 1)) {
    const trimmed = line.trim();
    if (!trimmed && !started) continue;
    if (!trimmed.startsWith("|")) {
      if (started) break;
      continue;
    }
    started = true;
    table.push(line);
  }
  return table;
}

function columnIndex(headers: string[], predicate: (header: string) => boolean): number {
  return headers.findIndex(predicate);
}

export function parse_test_contract_records(changeRoot: string): TestContractRecord[] {
  const text = test_contract_text(changeRoot);
  const table = tableLinesAfterHeading(text, [/^##\s+测试覆盖矩阵\s*$/i, /^##\s+test coverage matrix\s*$/i]);
  if (table.length < 3) return [];
  const headers = parseMarkdownRow(table[0]).map(normalizeHeader);
  const testIdx = columnIndex(headers, (header) => header === "test-id" || header === "test_id" || header === "testid");
  const scenarioIdx = columnIndex(headers, (header) => header.includes("scenario") || header.includes("req") || header.includes("需求") || header.includes("关联"));
  const invIdx = columnIndex(headers, (header) => header.includes("inv"));
  if (testIdx < 0) return [];
  const records: TestContractRecord[] = [];
  for (const line of table.slice(1)) {
    const cells = parseMarkdownRow(line);
    if (isSeparatorRow(cells)) continue;
    const testId = cells[testIdx] ?? "";
    if (!TEST_ID_RE.test(testId)) continue;
    TEST_ID_RE.lastIndex = 0;
    records.push({
      row: records.length + 1,
      test_id: testId.match(TEST_ID_RE)?.[0] ?? "",
      scenario_ref: scenarioIdx >= 0 ? cells[scenarioIdx] ?? "" : "",
      invariant_refs: invIdx >= 0 ? splitList(cells[invIdx] ?? "").filter((item) => item.startsWith("INV-")) : [],
    });
  }
  return records;
}

export function parse_test_contract_ids(changeRoot: string): Set<string> {
  return new Set(parse_test_contract_records(changeRoot).map((record) => record.test_id).filter(Boolean));
}

export function test_contract_text(changeRoot: string): string {
  const filePath = sidecar_test_contract_path(changeRoot);
  if (!existsSync(filePath) || !statSync(filePath).isFile()) return "";
  return readFileSync(filePath, "utf8");
}

function test_contract_section_lines(changeRoot: string, testId: string): string[] {
  const lines = test_contract_text(changeRoot).split(/\r?\n/);
  const start = lines.findIndex((line) => {
    const match = line.trim().match(/^###\s+(\S+)\s*$/);
    return match?.[1] === testId;
  });
  if (start < 0) return [];
  const out: string[] = [];
  for (const line of lines.slice(start + 1)) {
    if (/^###\s+\S+/.test(line.trim()) || /^##\s+/.test(line.trim())) break;
    out.push(line);
  }
  return out;
}

function contractField(line: string): { key: string; value: string } | null {
  const match = line.match(/^\s*-\s+`?([A-Za-z0-9_-]+)`?\s*:\s*(.*)$/);
  if (!match) return null;
  return { key: match[1], value: match[2].trim() };
}

export function resolve_test_contract_command(changeRoot: string, testId: string, config: JsonMap = {}): TestCommandResolution {
  const blockers: Reason[] = [];
  const lines = test_contract_section_lines(changeRoot, testId);
  if (lines.length === 0) {
    return { test_id: testId, command: null, source: null, blockers: [reason("missing_test_contract_section", `test contract missing ### ${testId} section`)] };
  }
  const fields = new Map<string, string[]>();
  for (const line of lines) {
    const field = contractField(line);
    if (!field) continue;
    const values = fields.get(field.key) ?? [];
    values.push(field.value);
    fields.set(field.key, values);
  }
  const commands = fields.get("test_command") ?? [];
  const refs = fields.get("test_command_ref") ?? [];
  if (commands.length === 0 && refs.length === 0) blockers.push(reason("missing_test_command", `test contract ${testId} requires exactly one test_command or test_command_ref`));
  if (commands.length > 1 || refs.length > 1) blockers.push(reason("duplicate_test_command", `test contract ${testId} has duplicate test command fields`));
  if (commands.length > 0 && refs.length > 0) blockers.push(reason("ambiguous_test_command", `test contract ${testId} must not mix test_command and test_command_ref`));
  const expected_failure_signature = (fields.get("expected_failure_signature") ?? [])[0];
  const expected_failure_classifier = (fields.get("expected_failure_classifier") ?? [])[0];
  if (commands.length === 1 && refs.length === 0) {
    const command = commands[0];
    if (!command) blockers.push(reason("missing_test_command", `test contract ${testId} has empty test_command`));
    return {
      test_id: testId,
      command: command || null,
      source: command ? "test_command" : null,
      expected_failure_signature,
      expected_failure_classifier,
      blockers,
    };
  }
  if (refs.length === 1 && commands.length === 0) {
    const refValue = refs[0];
    const match = refValue.match(/^config\.commands\.([A-Za-z0-9_.-]+)$/);
    if (!match) {
      blockers.push(reason("untrusted_test_command_ref", `test contract ${testId} test_command_ref must be config.commands.<id>`));
      return { test_id: testId, command: null, source: null, command_ref: refValue, expected_failure_signature, expected_failure_classifier, blockers };
    }
    const commandId = match[1];
    const commandsConfig = config.commands;
    const command = commandsConfig && typeof commandsConfig === "object" ? commandsConfig[commandId] : undefined;
    if (typeof command !== "string" || !command.trim()) {
      blockers.push(reason("untrusted_test_command_ref", `test contract ${testId} test_command_ref ${refValue} does not resolve to config.commands.${commandId}`));
      return { test_id: testId, command: null, source: null, command_ref: refValue, expected_failure_signature, expected_failure_classifier, blockers };
    }
    return {
      test_id: testId,
      command,
      source: "test_command_ref",
      command_ref: refValue,
      expected_failure_signature,
      expected_failure_classifier,
      blockers,
    };
  }
  return { test_id: testId, command: null, source: null, expected_failure_signature, expected_failure_classifier, blockers };
}

export function parse_spec_scenarios(changeRoot: string): string[] {
  const specs = join(changeRoot, "specs");
  const scenarios: string[] = [];
  if (!existsSync(specs) || !statSync(specs).isDirectory()) return scenarios;
  for (const filePath of walkFiles(specs).sort()) {
    if (!filePath.endsWith(".md")) continue;
    for (const line of readFileSync(filePath, "utf8").split(/\r?\n/)) {
      const match = line.match(SCENARIO_RE);
      if (match) scenarios.push(match[1].trim());
    }
  }
  return scenarios;
}

export function test_contract_covers_scenario(changeRoot: string, scenario: string): boolean {
  return parse_test_contract_records(changeRoot).some((record) => record.scenario_ref.includes(scenario));
}

export function test_contract_invariant_refs_by_test(changeRoot: string): Map<string, Set<string>> {
  const out = new Map<string, Set<string>>();
  for (const record of parse_test_contract_records(changeRoot)) {
    const refs = out.get(record.test_id) ?? new Set<string>();
    for (const ref of record.invariant_refs) refs.add(ref);
    out.set(record.test_id, refs);
  }
  return out;
}

export function task_test_refs(tasks: Record<string, TaskInfo>): Set<string> {
  const refs = new Set<string>();
  for (const task of Object.values(tasks)) {
    for (const ref of splitList(task.attrs.test_refs ?? "")) refs.add(ref);
  }
  return refs;
}

export function write_scope_conflict_reasons(tasks: Record<string, TaskInfo>): Reason[] {
  const byGroup: Record<string, Record<string, string[]>> = {};
  for (const [taskId, task] of Object.entries(tasks)) {
    const group = task.attrs.parallel_group;
    if (!group) continue;
    for (const scope of splitList(task.attrs.write_scope ?? "")) {
      byGroup[group] ??= {};
      byGroup[group][scope] ??= [];
      byGroup[group][scope].push(taskId);
    }
  }
  const problems: Reason[] = [];
  for (const [group, scopes] of Object.entries(byGroup)) {
    for (const [scope, taskIds] of Object.entries(scopes)) {
      if (taskIds.length > 1) problems.push(reason("write_scope_conflict", `parallel_group ${group} has overlapping write_scope ${scope}: ${renderList(taskIds)}`));
    }
  }
  return problems;
}

export function red_green_test_ids(evidences: JsonMap[]): Set<string> {
  const ids = new Set<string>();
  for (const ev of live_pass(evidences, { kind: "test_run" })) {
    if (typeof ev.test_id === "string" && ev.test_id) ids.add(ev.test_id);
  }
  return ids;
}

export function task_test_evidence(evidences: JsonMap[], taskId: string, semanticStatus: string, gate: string | null = null): JsonMap[] {
  return live_pass(evidences, { gate, kind: "test_run", task_id: taskId }).filter((ev) => ev.semantic_status === semanticStatus);
}

export function task_alternative_verification(evidences: JsonMap[], taskId: string): JsonMap[] {
  return [
    ...live_pass(evidences, { kind: "alternative_verification", task_id: taskId }),
    ...live_pass(evidences, { kind: "manual_verification", task_id: taskId }),
  ];
}

export function evidence_test_id_reasons(evidences: JsonMap[], taskId: string, declared: Set<string>, contractIds: Set<string>, semanticStatus: string): Reason[] {
  const problems: Reason[] = [];
  for (const ev of evidences) {
    const tid = ev.test_id;
    if (typeof tid !== "string" || !tid) {
      problems.push(reason("missing_test_id", `task ${taskId} ${semanticStatus} evidence requires test_id`));
      continue;
    }
    if (declared.size > 0 && !declared.has(tid)) {
      problems.push(reason("test_contract_not_honored", `task ${taskId} ${semanticStatus} test_id ${tid} not in declared test_refs ${renderList([...declared].sort())}`));
    }
    if (contractIds.size > 0 && !contractIds.has(tid)) {
      problems.push(reason("test_contract_not_honored", `task ${taskId} ${semanticStatus} test_id ${tid} not in test-contract ids ${renderList([...contractIds].sort())}`));
    }
  }
  return problems;
}

export function declared_test_evidence_reasons(evidences: JsonMap[], taskId: string, declared: Set<string>, semanticStatus: string): Reason[] {
  if (declared.size === 0) return [];
  const covered = new Set(
    evidences
      .map((ev) => typeof ev.test_id === "string" ? ev.test_id : "")
      .filter((testId) => declared.has(testId)),
  );
  const missing = [...declared].filter((testId) => !covered.has(testId)).sort();
  if (missing.length === 0) return [];
  return [reason(
    "missing_declared_test_evidence",
    `task ${taskId} ${semanticStatus} evidence missing declared test_refs: ${renderList(missing)}`,
    missing,
  )];
}
