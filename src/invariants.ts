import { existsSync, readFileSync, statSync } from "node:fs";
import type { JsonMap, Reason, TaskInfo } from "./util.ts";
import { reason, renderList, safe_within } from "./util.ts";
import { sidecar_business_invariants_path, sidecar_test_contract_path } from "./paths.ts";
import { live_pass } from "./evidence.ts";
import { parse_test_contract_records, splitList } from "./tasks.ts";

const INV_ID_RE = /\bINV-[A-Za-z0-9_-]+\b/g;

const REQUIRED_INVARIANT_FIELDS = [
  "statement",
  "scope",
  "source_anchors",
  "acceptance_refs",
  "risk_refs",
  "confidence",
  "enforcement_level",
  "test_refs_or_review_only_reason",
  "verification",
] as const;

const CONFIDENCE_VALUES = new Set(["confirmed", "source-backed", "inferred", "uncertain"]);
const ENFORCEMENT_VALUES = new Set(["automated-test", "review-checklist", "human-confirmation", "advisory"]);

function readTextIfFile(filePath: string): string {
  if (!existsSync(filePath) || !statSync(filePath).isFile()) return "";
  return readFileSync(filePath, "utf8");
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

function tableLinesAfterHeading(text: string, heading: string): string[] {
  const lines = text.split(/\r?\n/);
  const headingRe = new RegExp(`^##\\s+${heading}\\s*$`, "i");
  const start = lines.findIndex((line) => headingRe.test(line.trim()));
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

export function business_invariants_text(changeRoot: string): string {
  return readTextIfFile(sidecar_business_invariants_path(changeRoot));
}

export function parse_business_invariant_records(changeRoot: string): JsonMap[] {
  const text = business_invariants_text(changeRoot);
  const table = tableLinesAfterHeading(text, "Invariants");
  if (table.length < 3) return [];
  const headers = parseMarkdownRow(table[0]).map(normalizeHeader);
  const records: JsonMap[] = [];
  for (const line of table.slice(1)) {
    const cells = parseMarkdownRow(line);
    if (isSeparatorRow(cells)) continue;
    const record: JsonMap = {};
    headers.forEach((header, idx) => {
      record[header] = cells[idx] ?? "";
    });
    records.push(record);
  }
  return records;
}

function invariantId(record: JsonMap): string {
  return String(record["inv-id"] ?? record.inv_id ?? record.id ?? "").trim();
}

function isCreatedAfterImplementation(record: JsonMap): boolean {
  return ["true", "yes", "1"].includes(String(record.created_after_implementation ?? "").trim().toLowerCase());
}

function isHardInvariant(record: JsonMap): boolean {
  const confidence = String(record.confidence ?? "").trim();
  const enforcement = String(record.enforcement_level ?? "").trim();
  return (confidence === "confirmed" || confidence === "source-backed") && enforcement !== "advisory";
}

function enforcementLevel(record: JsonMap): string {
  return String(record.enforcement_level ?? "").trim();
}

export function business_invariant_ids(changeRoot: string): Set<string> {
  const records = parse_business_invariant_records(changeRoot);
  if (records.length > 0) return new Set(records.map(invariantId).filter(Boolean));
  return new Set([...business_invariants_text(changeRoot).matchAll(INV_ID_RE)].map((match) => match[0]));
}

export function hard_business_invariant_ids(changeRoot: string): Set<string> {
  const hard = new Set<string>();
  for (const record of parse_business_invariant_records(changeRoot)) {
    const id = invariantId(record);
    if (!id) continue;
    if (isHardInvariant(record) && !isCreatedAfterImplementation(record)) hard.add(id);
  }
  return hard;
}

export function automated_hard_business_invariant_ids(changeRoot: string): Set<string> {
  const hard = new Set<string>();
  for (const record of parse_business_invariant_records(changeRoot)) {
    const id = invariantId(record);
    if (!id) continue;
    if (isHardInvariant(record) && !isCreatedAfterImplementation(record) && enforcementLevel(record) === "automated-test") hard.add(id);
  }
  return hard;
}

export function post_implementation_business_invariant_ids(changeRoot: string): Set<string> {
  const ids = new Set<string>();
  for (const record of parse_business_invariant_records(changeRoot)) {
    const id = invariantId(record);
    if (id && isCreatedAfterImplementation(record)) ids.add(id);
  }
  return ids;
}

export function human_confirmation_business_invariant_ids(changeRoot: string): Set<string> {
  const ids = new Set<string>();
  for (const record of parse_business_invariant_records(changeRoot)) {
    const id = invariantId(record);
    if (!id) continue;
    const enforcement = String(record.enforcement_level ?? "").trim();
    if (enforcement === "human-confirmation") ids.add(id);
  }
  return ids;
}

export function business_invariant_validation_reasons(changeRoot: string): Reason[] {
  const filePath = sidecar_business_invariants_path(changeRoot);
  if (!existsSync(filePath) || !statSync(filePath).isFile()) {
    return [reason("missing_business_invariants", "sidecar .superspec/artifacts/business-invariants.md missing")];
  }
  const text = business_invariants_text(changeRoot);
  if (!text.trim()) return [reason("missing_business_invariants", "sidecar .superspec/artifacts/business-invariants.md empty")];
  const records = parse_business_invariant_records(changeRoot);
  const problems: Reason[] = [];
  if (records.length === 0) {
    problems.push(reason("invalid_business_invariants", "business-invariants.md has no parseable Invariants table"));
    return problems;
  }
  const seen = new Set<string>();
  records.forEach((record, idx) => {
    const row = idx + 1;
    const id = invariantId(record);
    if (!/^INV-[A-Za-z0-9_-]+$/.test(id)) {
      problems.push(reason("invalid_invariant_ref", `business-invariants row ${row} has invalid INV-ID ${id || "<empty>"}`));
    } else if (seen.has(id)) {
      problems.push(reason("invalid_invariant_ref", `duplicate business invariant id ${id}`));
    } else {
      seen.add(id);
    }
    for (const field of REQUIRED_INVARIANT_FIELDS) {
      if (!String(record[field] ?? "").trim()) {
        problems.push(reason("invalid_business_invariants", `${id || `row ${row}`}: missing ${field}`));
      }
    }
    const confidence = String(record.confidence ?? "").trim();
    if (confidence && !CONFIDENCE_VALUES.has(confidence)) {
      problems.push(reason("invalid_business_invariants", `${id || `row ${row}`}: unsupported confidence ${confidence}`));
    }
    const enforcement = String(record.enforcement_level ?? "").trim();
    if (enforcement && !ENFORCEMENT_VALUES.has(enforcement)) {
      problems.push(reason("invalid_business_invariants", `${id || `row ${row}`}: unsupported enforcement_level ${enforcement}`));
    }
    if (isCreatedAfterImplementation(record) && isHardInvariant(record)) {
      problems.push(reason("post_implementation_invariant_backfill", `${id || `row ${row}`}: created_after_implementation hard invariant cannot satisfy current RED/GREEN contract`));
    }
  });
  return problems;
}

export function test_contract_invariant_ids(changeRoot: string): Set<string> {
  const refs = new Set<string>();
  for (const record of parse_test_contract_records(changeRoot)) {
    for (const ref of record.invariant_refs) refs.add(ref);
  }
  return refs;
}

export function task_invariant_refs(tasks: Record<string, TaskInfo>): Set<string> {
  const refs = new Set<string>();
  for (const task of Object.values(tasks)) {
    for (const ref of splitList(task.attrs.invariant_refs ?? "")) refs.add(ref);
  }
  return refs;
}

export function evidence_invariant_refs(ev: JsonMap): Set<string> {
  const value = ev.invariant_refs;
  if (Array.isArray(value)) return new Set(value.map((item) => String(item)).filter(Boolean));
  if (typeof value === "string") return new Set(splitList(value));
  return new Set();
}

export function red_green_invariant_ids(evidences: JsonMap[]): Set<string> {
  const ids = new Set<string>();
  for (const ev of live_pass(evidences, { kind: "test_run" })) {
    for (const id of evidence_invariant_refs(ev)) ids.add(id);
  }
  return ids;
}

export function evidence_invariant_ref_reasons(evidences: JsonMap[], taskId: string, declared: Set<string>, validIds: Set<string>, semanticStatus: string): Reason[] {
  const problems: Reason[] = [];
  for (const ev of evidences) {
    const refs = evidence_invariant_refs(ev);
    if (declared.size > 0 && refs.size === 0) {
      problems.push(reason("missing_invariant_ref", `task ${taskId} ${semanticStatus} evidence requires invariant_refs`));
      continue;
    }
    for (const inv of refs) {
      if (declared.size > 0 && !declared.has(inv)) {
        problems.push(reason("invariant_not_honored", `task ${taskId} ${semanticStatus} invariant_ref ${inv} not in declared invariant_refs ${renderList([...declared].sort())}`));
      }
      if (validIds.size > 0 && !validIds.has(inv)) {
        problems.push(reason("invalid_invariant_ref", `task ${taskId} ${semanticStatus} references unknown invariant ${inv}`));
      }
    }
  }
  return problems;
}

export function evidence_test_contract_invariant_reasons(evidences: JsonMap[], taskId: string, byTest: Map<string, Set<string>>, semanticStatus: string): Reason[] {
  const problems: Reason[] = [];
  for (const ev of evidences) {
    const testId = typeof ev.test_id === "string" ? ev.test_id : "";
    const expected = byTest.get(testId) ?? new Set<string>();
    if (expected.size === 0) continue;
    const actual = evidence_invariant_refs(ev);
    if (actual.size === 0) {
      problems.push(reason("missing_invariant_ref", `task ${taskId} ${semanticStatus} evidence for ${testId} requires invariant_refs ${renderList([...expected].sort())}`));
      continue;
    }
    const missing = [...expected].filter((inv) => !actual.has(inv)).sort();
    if (missing.length > 0) {
      problems.push(reason("invariant_not_honored", `task ${taskId} ${semanticStatus} evidence for ${testId} missing invariant_refs ${renderList(missing)}`));
    }
  }
  return problems;
}

type InvariantMatrixRecord = {
  inv_id: string;
  status: string;
  evidence: string;
};

function firstMarkdownTableLines(text: string): string[] {
  const lines = text.split(/\r?\n/);
  const table: string[] = [];
  let started = false;
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed.startsWith("|")) {
      if (started) break;
      continue;
    }
    started = true;
    table.push(line);
  }
  return table;
}

function parse_invariant_matrix_records(text: string): { records: InvariantMatrixRecord[]; missing_columns: string[] } {
  const table = firstMarkdownTableLines(text);
  if (table.length < 3) return { records: [], missing_columns: ["table"] };
  const headers = parseMarkdownRow(table[0]).map(normalizeHeader);
  const invIdx = headers.findIndex((header) => header === "inv-id" || header === "inv_id" || header.includes("invariant") || header.includes("inv"));
  const statusIdx = headers.findIndex((header) => header === "status" || header.includes("状态"));
  const evidenceIdx = headers.findIndex((header) => header.includes("evidence") || header.includes("proof") || header.includes("证据"));
  const missingColumns: string[] = [];
  if (invIdx < 0) missingColumns.push("INV-ID");
  if (statusIdx < 0) missingColumns.push("status");
  if (evidenceIdx < 0) missingColumns.push("evidence");
  if (missingColumns.length > 0) return { records: [], missing_columns: missingColumns };
  const records: InvariantMatrixRecord[] = [];
  for (const line of table.slice(1)) {
    const cells = parseMarkdownRow(line);
    if (isSeparatorRow(cells)) continue;
    const invId = (cells[invIdx] ?? "").match(INV_ID_RE)?.[0] ?? "";
    if (!invId) continue;
    records.push({
      inv_id: invId,
      status: cells[statusIdx] ?? "",
      evidence: cells[evidenceIdx] ?? "",
    });
  }
  return { records, missing_columns: [] };
}

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function cellReferencesEvidenceId(cell: string, evidenceId: string): boolean {
  if (!evidenceId) return false;
  const tokenCandidates = cell
    .split(/[\s,;|()[\]{}<>`'"]+/)
    .map((item) => item.trim().replace(/^[.:]+|[.:]+$/g, ""))
    .filter(Boolean);
  if (tokenCandidates.includes(evidenceId)) return true;
  const pattern = new RegExp(`(^|[^A-Za-z0-9_-])${escapeRegExp(evidenceId)}([^A-Za-z0-9_-]|$)`);
  return pattern.test(cell);
}

function referencedLiveEvidenceIds(cell: string, liveEvidenceIds: Set<string>): string[] {
  return [...liveEvidenceIds].filter((evidenceId) => cellReferencesEvidenceId(cell, evidenceId)).sort();
}

export function invariant_matrix_coverage_reasons(changeRoot: string, ev: JsonMap, evidences: JsonMap[]): Reason[] {
  const matrixRef = ev.invariant_matrix_ref;
  if (typeof matrixRef !== "string" || !matrixRef) return [];
  const filePath = safe_within(changeRoot, matrixRef);
  if (filePath === null || !existsSync(filePath) || !statSync(filePath).isFile()) return [];
  const required = hard_business_invariant_ids(changeRoot);
  if (required.size === 0) return [];
  const { records, missing_columns: missingColumns } = parse_invariant_matrix_records(readFileSync(filePath, "utf8"));
  const label = String(ev._path ?? ev.evidence_id ?? "verification_review");
  const reasons: Reason[] = [];
  if (missingColumns.length > 0) {
    reasons.push(reason("invariant_matrix_incomplete", `${label}: invariant_matrix_ref ${matrixRef} missing parseable columns/table: ${renderList(missingColumns)}`, missingColumns));
    return reasons;
  }
  const byId = new Map(records.map((record) => [record.inv_id, record]));
  const missing = [...required].filter((id) => !byId.has(id)).sort();
  if (missing.length > 0) {
    reasons.push(reason("invariant_matrix_incomplete", `${label}: invariant matrix missing hard business invariants: ${renderList(missing)}`, missing));
  }
  const liveEvidenceIds = new Set(
    live_pass(evidences)
      .map((item) => String(item.evidence_id ?? ""))
      .filter(Boolean),
  );
  for (const id of [...required].sort()) {
    const record = byId.get(id);
    if (!record) continue;
    const status = record.status.trim().toLowerCase();
    if (status !== "pass" && status !== "accepted") {
      reasons.push(reason("invariant_matrix_incomplete", `${label}: invariant ${id} matrix status must be pass or accepted, got ${record.status || "<empty>"}`, [id]));
    }
    const evidenceIds = referencedLiveEvidenceIds(record.evidence, liveEvidenceIds);
    if (evidenceIds.length === 0) {
      reasons.push(reason("invariant_matrix_incomplete", `${label}: invariant ${id} matrix evidence must reference at least one live/pass evidence_id`, [id]));
    }
  }
  return reasons;
}
