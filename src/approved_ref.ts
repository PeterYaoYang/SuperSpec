// SuperSpec 代码审查 approved_refs：只做存在性解析，不做语义匹配。

import { readFileSync, statSync } from "node:fs";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import { parseTasksMd, parseTestContractEntries } from "./format.ts";
import type { CodeReviewClaimKind } from "./types.ts";

export const CODE_REVIEW_CLAIM_KINDS = [
  "missing_approved",
  "breaks_existing",
  "unjustified_addition",
] as const;

const TEST_ID_RE = /^TEST-[A-Za-z0-9_-]+$/;
const TEST_CONTRACT_REL = join(".superspec", "artifacts", "test-contract.md");

export type ApprovedRefKind = "test" | "requirement" | "task" | "design" | "proposal";

export interface ResolvedApprovedRef {
  raw: string;
  kind: ApprovedRefKind;
  short: string;
}

function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function isPathInside(root: string, target: string): boolean {
  const rel = relative(root, target);
  return rel !== "" && !rel.startsWith(`..${sep}`) && rel !== ".." && !isAbsolute(rel);
}

function headingExists(content: string, title: string): boolean {
  const heading = new RegExp(`^#{1,6}[\\t ]+${escapeRegex(title)}(?:[\\t ]+#+)?[\\t ]*$`, "m");
  return heading.test(content);
}

function shortTestId(raw: string): string | null {
  const trimmed = raw.trim();
  if (TEST_ID_RE.test(trimmed)) return trimmed;
  const hash = trimmed.lastIndexOf("#");
  if (hash >= 0) {
    const id = trimmed.slice(hash + 1).trim();
    if (TEST_ID_RE.test(id)) return id;
  }
  return null;
}

function readChangeFile(changeRoot: string, relPath: string): string | null {
  const target = resolve(changeRoot, relPath);
  if (!isPathInside(resolve(changeRoot), target) && resolve(changeRoot) !== target) return null;
  try {
    if (!statSync(target).isFile()) return null;
    return readFileSync(target, "utf8");
  } catch {
    return null;
  }
}

export function isCodeReviewClaimKind(value: unknown): value is CodeReviewClaimKind {
  return typeof value === "string" && (CODE_REVIEW_CLAIM_KINDS as readonly string[]).includes(value);
}

export function shortApprovedRef(raw: string): string {
  const testId = shortTestId(raw);
  if (testId) return testId;
  const req = /#Requirement:\s*(.+)$/.exec(raw.trim());
  if (req) return `Requirement: ${req[1].trim()}`;
  const hash = raw.lastIndexOf("#");
  if (hash >= 0 && hash < raw.length - 1) return raw.slice(hash + 1).trim();
  return raw.trim();
}

export function resolveApprovedRef(changeRoot: string, raw: unknown): { ok: true; value: ResolvedApprovedRef } | { ok: false; reason: string } {
  if (typeof raw !== "string" || raw.trim() === "") {
    return { ok: false, reason: "approved_refs 条目必须是非空字符串" };
  }
  const ref = raw.trim();
  if (/[\u0000-\u001f\u007f]/.test(ref)) {
    return { ok: false, reason: `approved_refs 条目不能包含换行等控制字符：${JSON.stringify(ref)}` };
  }
  const testId = shortTestId(ref);
  if (testId) {
    if (ref.includes("#") && !ref.endsWith(`#${testId}`)) {
      return { ok: false, reason: `TEST 引用只能是裸 TEST-ID 或以 #TEST-ID 结尾指向 test-contract.md：${ref}` };
    }
    if (ref.includes("#")) {
      const path = ref.slice(0, ref.lastIndexOf("#")).replace(/\\/g, "/");
      const allowed = path === TEST_CONTRACT_REL.replace(/\\/g, "/")
        || path === "test-contract.md"
        || path.endsWith("/test-contract.md");
      if (!allowed) return { ok: false, reason: `TEST 引用只能指向 test-contract.md：${ref}` };
    }
    const content = readChangeFile(changeRoot, TEST_CONTRACT_REL);
    if (content == null) return { ok: false, reason: `无法读取 ${TEST_CONTRACT_REL.replace(/\\/g, "/")}，无法校验 TEST 引用：${ref}` };
    const parsed = parseTestContractEntries(content);
    if (!parsed.ok || !parsed.entries.some(entry => entry.test_id === testId)) {
      return { ok: false, reason: `${TEST_CONTRACT_REL.replace(/\\/g, "/")} 中不存在 ${testId}` };
    }
    return { ok: true, value: { raw: ref, kind: "test", short: testId } };
  }

  const separator = ref.indexOf("#");
  if (separator <= 0 || separator === ref.length - 1) {
    return { ok: false, reason: `锚点格式无法解析，应为 文件#标题 或 TEST-ID：${ref}` };
  }
  const path = ref.slice(0, separator).replace(/\\/g, "/");
  const anchor = ref.slice(separator + 1).trim();
  const content = readChangeFile(changeRoot, path);
  if (content == null) return { ok: false, reason: `${path} 在当前 change 中不存在` };

  if (path === "tasks.md") {
    const tasks = parseTasksMd(content);
    if (!tasks.some(task => task.taskId === anchor)) return { ok: false, reason: `tasks.md 中不存在任务 ${anchor}` };
    return { ok: true, value: { raw: ref, kind: "task", short: anchor } };
  }

  if (path === "design.md") {
    if (!headingExists(content, anchor)) return { ok: false, reason: `design.md 中不存在标题「${anchor}」` };
    return { ok: true, value: { raw: ref, kind: "design", short: anchor } };
  }

  if (path === "proposal.md") {
    if (!headingExists(content, anchor)) return { ok: false, reason: `proposal.md 中不存在标题「${anchor}」` };
    return { ok: true, value: { raw: ref, kind: "proposal", short: anchor } };
  }

  if (/^specs\/[^/]+\/spec\.md$/.test(path)) {
    const requirementTitle = anchor.startsWith("Requirement:")
      ? anchor.slice("Requirement:".length).trim()
      : "";
    if (!requirementTitle) return { ok: false, reason: `spec 锚点必须以 Requirement: 开头：${ref}` };
    if (!headingExists(content, `Requirement: ${requirementTitle}`)) {
      return { ok: false, reason: `${path} 中不存在 Requirement「${requirementTitle}」` };
    }
    return {
      ok: true,
      value: { raw: ref, kind: "requirement", short: `Requirement: ${requirementTitle}` },
    };
  }

  return { ok: false, reason: `只支持 tasks.md、design.md、proposal.md、specs/*/spec.md 与 test-contract.md 的锚点：${ref}` };
}

export function resolveApprovedRefs(
  changeRoot: string,
  refs: unknown,
): { ok: true; values: ResolvedApprovedRef[] } | { ok: false; reasons: string[] } {
  if (!Array.isArray(refs) || refs.length === 0) {
    return { ok: false, reasons: ["approved_refs 必须是非空字符串数组"] };
  }
  const values: ResolvedApprovedRef[] = [];
  const reasons: string[] = [];
  for (const raw of refs) {
    const resolved = resolveApprovedRef(changeRoot, raw);
    if (!resolved.ok) reasons.push(resolved.reason);
    else values.push(resolved.value);
  }
  if (reasons.length > 0) return { ok: false, reasons };
  return { ok: true, values };
}

export function hasBehaviorAnchor(values: readonly ResolvedApprovedRef[]): boolean {
  return values.some(value => value.kind === "test" || value.kind === "requirement");
}

export function reviewFixReason(claimKind: CodeReviewClaimKind, refs: readonly string[]): string {
  const shorts = refs.map(shortApprovedRef).filter(Boolean);
  const target = shorts.length > 0 ? shorts.join("、") : "已批准行为";
  return `兑现 ${target}（${claimKind}）`;
}
