// SuperSpec 流程引擎 — format.ts：文档格式解析的唯一权威源
//
// 所有可机械判定的文档协议、格式定义和解析逻辑都在这里。skills 只指导
// 生成与语义判断，不得自行充当格式校验器或在其它地方重复解析。

import { readFileSync, existsSync, realpathSync } from "node:fs";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import { sha256Text } from "./store.ts";
import { GREEN_ONLY_NO_TDD_REASON, type ExecutionContract, type ExecutionPolicy } from "./types.ts";

// ===== discovery.md =====
//
// 格式（explore skill 定义）：
//   ## 待确认问题
//   - [ ] 问题1的描述
//   - [ ] 问题2的描述
//
// 引擎只解析"待确认问题"段内的 `- [ ]`，不误判正常 checklist。

function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function countOpenChecklistItemsInSection(content: string, headings: readonly string[]): number {
  const sectionBody = sectionBodyByHeadings(content, headings);
  if (sectionBody == null) return 0;
  // 数未确认项
  const matches = sectionBody.match(/^\s*-\s+\[ \]/gm);
  return matches ? matches.length : 0;
}

function sectionRangeByHeadings(content: string, headings: readonly string[]): { start: number; end: number } | null {
  const headingPattern = headings.map(escapeRegex).join("|");
  const sectionMatch = new RegExp(`^#{1,6}\\s*(?:${headingPattern})\\s*$`, "im").exec(content);
  if (!sectionMatch) return null;
  const sectionStart = sectionMatch.index! + sectionMatch[0].length;
  // 截取到下一个标题或文件末尾
  const restContent = content.slice(sectionStart);
  const nextHeadingMatch = restContent.match(/^#{1,6}\s+/m);
  return {
    start: sectionStart,
    end: nextHeadingMatch ? sectionStart + nextHeadingMatch.index! : content.length,
  };
}

function sectionBodyByHeadings(content: string, headings: readonly string[]): string | null {
  const range = sectionRangeByHeadings(content, headings);
  return range ? content.slice(range.start, range.end) : null;
}

const DISCOVERY_QUESTION_HEADINGS = ["待确认问题", "Open Questions", "Pending Questions"] as const;

export const EXPLORE_OPEN_QUESTION_SCOPE_PREFIX = "explore_open_question:";

/**
 * Discovery 的未确认项是用户决策的唯一候选来源。这里保留原有的“仅指定段落内
 * checkbox 有效”语义；ID 缺失的历史文档按所有 checklist 在该段落中的稳定顺序
 * 使用 item-N，避免升级时要求迁移历史 change。
 */
export interface DiscoveryOpenQuestion {
  /** Q-xxx；历史材料没有 ID 时为 item-N。 */
  id: string;
  /** 在“待确认问题”段落中所有 checklist 的 1-based 顺序。 */
  ordinal: number;
  /** 去掉 markdown checkbox 后的原始内容，用于留痕与内部匹配。 */
  text: string;
  /** 包含 checkbox 的原始 Markdown 行，供诊断和测试使用。 */
  raw: string;
  /** 当前完整 discovery.md 的内容指纹，避免只改决策依据时沿用旧答复。 */
  documentFingerprint: string;
}

/** Discovery 待确认段中的一项；状态机需要同时识别待答复和已回写的项。 */
export interface DiscoveryQuestion extends DiscoveryOpenQuestion {
  status: "open" | "closed";
}

/**
 * 当前文档中同一确认事项的稳定键。结合 Q-ID、顺序和原文，避免把本轮开始前
 * 已经确认的旧事项误认为新答复。
 */
export function discoveryQuestionKey(question: Pick<DiscoveryQuestion, "id" | "ordinal" | "text">): string {
  return sha256Text(`${question.id}\n${question.ordinal}\n${question.text}`);
}

function normalizedDecisionQuestionText(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

/**
 * 当前决定所依据的规范化问题内容。会改变选择、推荐或影响的事实必须写入该问题项；
 * 状态机只绑定这份明确依据，不猜测文档其它段落与决定是否相关。
 */
export function discoveryQuestionDecisionBasisDigest(
  question: Pick<DiscoveryQuestion, "id" | "ordinal" | "text">,
): string {
  const legacyOrdinal = question.id.startsWith("item-") ? String(question.ordinal) : "explicit-id";
  return sha256Text(`decision-basis:v1\nexplore\n${question.id}\n${legacyOrdinal}\n${normalizedDecisionQuestionText(question.text)}`);
}

/**
 * 计算某一确认事项之外的 Discovery 决策上下文。回写时该事项本身会从问题改为
 * 结论，因此只归一化这一行；其余事实、证据和其它待确认项的改动都会使指纹失效。
 */
export function discoveryQuestionContextFingerprint(
  content: string,
  question: Pick<DiscoveryQuestion, "id" | "ordinal">,
): string | null {
  const range = sectionRangeByHeadings(content, DISCOVERY_QUESTION_HEADINGS);
  if (!range) return null;
  const sectionBody = content.slice(range.start, range.end);
  const checklist = /^\s*-\s+\[([ xX])\]\s+(.*?)\s*$/gm;
  let ordinal = 0;
  for (const match of sectionBody.matchAll(checklist)) {
    ordinal += 1;
    if (ordinal !== question.ordinal) continue;
    const lineStart = range.start + match.index!;
    const lineEnd = lineStart + match[0].length;
    const placeholder = `- [ ] <discovery-question:${question.id}:${question.ordinal}>`;
    return sha256Text(`${content.slice(0, lineStart)}${placeholder}${content.slice(lineEnd)}`);
  }
  return null;
}

/** 按文档顺序提取 discovery.md 的全部确认事项。 */
export function parseDiscoveryQuestions(content: string): DiscoveryQuestion[] {
  const sectionBody = sectionBodyByHeadings(content, DISCOVERY_QUESTION_HEADINGS);
  if (sectionBody == null) return [];

  const documentFingerprint = sha256Text(content);
  const questions: DiscoveryQuestion[] = [];
  const checklist = /^\s*-\s+\[([ xX])\]\s+(.*?)\s*$/gm;
  let ordinal = 0;

  for (const match of sectionBody.matchAll(checklist)) {
    ordinal += 1;
    const text = match[2];
    const idMatch = /^\s*(Q-[A-Za-z0-9][A-Za-z0-9_-]*)\b/.exec(text);
    questions.push({
      id: idMatch?.[1] ?? `item-${ordinal}`,
      ordinal,
      text,
      raw: match[0],
      documentFingerprint,
      status: match[1] === " " ? "open" : "closed",
    });
  }
  return questions;
}

/** 按文档顺序提取 discovery.md 中尚未确认的问题。 */
export function parseDiscoveryOpenQuestions(content: string): DiscoveryOpenQuestion[] {
  return parseDiscoveryQuestions(content)
    .filter(question => question.status === "open")
    .map(({ status: _status, ...question }) => question);
}

export function discoveryOpenQuestionScope(
  question: Pick<DiscoveryOpenQuestion, "id" | "ordinal" | "text">,
  exploreRoundId: string,
): string {
  const fingerprint = sha256Text(`${exploreRoundId}\n${discoveryQuestionDecisionBasisDigest(question)}`);
  return `${EXPLORE_OPEN_QUESTION_SCOPE_PREFIX}${fingerprint}:${question.id}`;
}

/** 兼容升级前已经展示给用户、但尚未登记的 scope。 */
export function legacyDiscoveryOpenQuestionScope(
  question: Pick<DiscoveryOpenQuestion, "id" | "documentFingerprint">,
  exploreRoundId: string,
): string {
  const fingerprint = sha256Text(`${exploreRoundId}\n${question.documentFingerprint}`);
  return `${EXPLORE_OPEN_QUESTION_SCOPE_PREFIX}${fingerprint}:${question.id}`;
}

/** 面向用户展示时隐藏 Q-xxx 这一内部编号；历史无编号问题保持原文。 */
export function discoveryOpenQuestionDisplayText(question: Pick<DiscoveryOpenQuestion, "id" | "text">): string {
  if (question.id.startsWith("Q-") && question.text.startsWith(question.id)) {
    return question.text.slice(question.id.length).replace(/^[\s:：—–-]+/, "").trim();
  }
  return question.text.trim();
}

/** 从 discovery.md 提取“待确认问题”段内的未确认项数量。 */
export function countDiscoveryOpenQuestions(content: string): number {
  return parseDiscoveryOpenQuestions(content).length;
}

export interface DiscoveryChainCoverageCheck {
  ok: boolean;
  message: string;
  present: boolean;
}

const DISCOVERY_CHAIN_HEADINGS = ["链路五要素"] as const;
const DISCOVERY_CHAIN_REQUIRED_COLUMNS = [
  "ID",
  "发现方式",
  "上游来源",
  "规则变形",
  "持久化语义",
  "下游消费者",
  "视图差异",
  "未知/排除",
  "证据",
  "状态",
] as const;
const DISCOVERY_CHAIN_STATUSES = new Set(["已确认", "未知阻塞", "未知非阻塞"]);

export function splitMarkdownTableRow(line: string): string[] {
  const trimmed = line.trim();
  if (!trimmed.startsWith("|") || !trimmed.endsWith("|")) return [];
  // GFM 表格中字面竖线写作 \|，按未转义竖线切分后还原
  return trimmed.slice(1, -1).split(/(?<!\\)\|/).map(cell => cell.trim().replace(/\\\|/g, "|"));
}

function isMarkdownTableSeparator(line: string): boolean {
  return /^\s*\|?\s*:?-{3,}:?\s*(?:\|\s*:?-{3,}:?\s*)+\|?\s*$/.test(line);
}

/** 轻量校验 discovery.md 的链路五要素段。只校验结构和阻塞未知，不判断业务真假。 */
export function validateDiscoveryChainCoverage(content: string): DiscoveryChainCoverageCheck {
  const sectionBody = sectionBodyByHeadings(content, DISCOVERY_CHAIN_HEADINGS);
  if (sectionBody == null) {
    // 兼容缺少链路五要素段的历史 discovery：不阻塞，实质要求由 critic 审查
    return { ok: true, message: "discovery.md 未声明链路五要素", present: false };
  }

  const tableLines = sectionBody.split("\n").filter(line => line.trim().startsWith("|"));
  if (tableLines.length < 2) {
    return { ok: false, message: "链路五要素缺少 Markdown 表格", present: true };
  }

  const header = splitMarkdownTableRow(tableLines[0]);
  if (header.length === 0 || !isMarkdownTableSeparator(tableLines[1])) {
    return { ok: false, message: "链路五要素表格格式无效", present: true };
  }

  const missingColumns = DISCOVERY_CHAIN_REQUIRED_COLUMNS.filter(col => !header.includes(col));
  if (missingColumns.length > 0) {
    return { ok: false, message: `链路五要素缺少必需列：${missingColumns.join(", ")}`, present: true };
  }

  const rows = tableLines.slice(2).map(splitMarkdownTableRow).filter(cells => cells.length > 0);
  if (rows.length === 0) {
    return { ok: false, message: "链路五要素至少需要一行链路记录", present: true };
  }

  const statusIdx = header.indexOf("状态");
  const requiredColumnIndexes = DISCOVERY_CHAIN_REQUIRED_COLUMNS.map(col => ({ col, idx: header.indexOf(col) }));
  const errors: string[] = [];

  for (const [idx, cells] of rows.entries()) {
    const rowNum = idx + 1;
    for (const { col, idx: colIdx } of requiredColumnIndexes) {
      if (!(cells[colIdx]?.trim())) {
        errors.push(`链路五要素第 ${rowNum} 行缺少${col}`);
      }
    }
    const status = cells[statusIdx]?.trim() ?? "";
    if (!DISCOVERY_CHAIN_STATUSES.has(status)) {
      errors.push(`链路五要素第 ${rowNum} 行状态必须是 已确认、未知阻塞 或 未知非阻塞`);
    }
    if (status.includes("未知阻塞") && countDiscoveryOpenQuestions(content) === 0) {
      errors.push("链路五要素存在未知阻塞，但待确认问题中没有未解决项");
    }
  }

  if (errors.length > 0) return { ok: false, message: [...new Set(errors)].join("；"), present: true };

  return { ok: true, message: "链路五要素就绪", present: true };
}

/**
 * 校验 discovery.md 的可解析结构。未确认问题不是格式错误：next 会把第一个问题
 * 作为当前用户决策返回；只有缺文档、空文档或已声明链路的结构错误才在此阻断。
 */
export function validateDiscovery(changeRoot: string): { ok: boolean; message: string; openCount: number } {
  const path = join(changeRoot, ".superspec", "artifacts", "discovery.md");
  if (!existsSync(path)) return { ok: false, message: "discovery.md 不存在", openCount: -1 };
  const content = readFileSync(path, "utf8");
  if (!content.trim()) return { ok: false, message: "discovery.md 为空", openCount: -1 };
  const chainCoverage = validateDiscoveryChainCoverage(content);
  if (!chainCoverage.ok) return { ok: false, message: chainCoverage.message, openCount: -1 };
  const openCount = countDiscoveryOpenQuestions(content);
  return {
    ok: true,
    message: openCount > 0 ? `discovery.md 结构有效，有 ${openCount} 个待确认问题` : "discovery.md 就绪",
    openCount,
  };
}

// ===== propose 待用户确认 =====
//
// 格式（状态机校验，propose skill 负责生成）：
//   ## 待用户确认
//   - [ ] DEC-001 是否兼容旧行为？
//   - [x] DEC-002 已确认的问题
//
// 引擎只解析指定计划文档中该段落内的 `- [ ]`，不误判其它 checklist。

export interface ProposeOpenQuestionFile {
  path: string;
  openCount: number;
}

export const PROPOSE_OPEN_QUESTION_SCOPE_PREFIX = "propose_open_question:";

export interface ProposeQuestion {
  path: string;
  id: string;
  ordinal: number;
  text: string;
  raw: string;
  documentFingerprint: string;
  status: "open" | "closed";
}

const PROPOSE_CONFIRMATION_DOCS = [
  "proposal.md",
  "design.md",
  ".superspec/artifacts/test-contract.md",
] as const;

const PROPOSE_CONFIRMATION_HEADINGS = ["待用户确认", "待确认问题", "Open Questions", "Pending Questions"] as const;

export function parseProposeQuestions(content: string, path: string): ProposeQuestion[] {
  const sectionBody = sectionBodyByHeadings(content, PROPOSE_CONFIRMATION_HEADINGS);
  if (sectionBody == null) return [];
  const documentFingerprint = sha256Text(content);
  const questions: ProposeQuestion[] = [];
  const checklist = /^\s*-\s+\[([ xX])\]\s+(.*?)\s*$/gm;
  let ordinal = 0;
  for (const match of sectionBody.matchAll(checklist)) {
    ordinal += 1;
    const text = match[2];
    const idMatch = /^\s*(DEC-[A-Za-z0-9][A-Za-z0-9_-]*)\b/.exec(text);
    questions.push({
      path,
      id: idMatch?.[1] ?? `item-${ordinal}`,
      ordinal,
      text,
      raw: match[0],
      documentFingerprint,
      status: match[1] === " " ? "open" : "closed",
    });
  }
  return questions;
}

export function proposeQuestionKey(question: Pick<ProposeQuestion, "path" | "id" | "ordinal" | "text">): string {
  return sha256Text(`${question.path}\n${question.id}\n${question.ordinal}\n${question.text}`);
}

/** Propose 决定的明确依据；其它计划材料变化不会自动使已展示决定失效。 */
export function proposeQuestionDecisionBasisDigest(
  question: Pick<ProposeQuestion, "path" | "id" | "ordinal" | "text">,
): string {
  const legacyOrdinal = question.id.startsWith("item-") ? String(question.ordinal) : "explicit-id";
  return sha256Text(`decision-basis:v1\npropose\n${question.path}\n${question.id}\n${legacyOrdinal}\n${normalizedDecisionQuestionText(question.text)}`);
}

export function proposeQuestionContextFingerprint(
  content: string,
  question: Pick<ProposeQuestion, "id" | "ordinal">,
): string | null {
  const range = sectionRangeByHeadings(content, PROPOSE_CONFIRMATION_HEADINGS);
  if (!range) return null;
  const sectionBody = content.slice(range.start, range.end);
  const checklist = /^\s*-\s+\[([ xX])\]\s+(.*?)\s*$/gm;
  let ordinal = 0;
  for (const match of sectionBody.matchAll(checklist)) {
    ordinal += 1;
    if (ordinal !== question.ordinal) continue;
    const lineStart = range.start + match.index!;
    const lineEnd = lineStart + match[0].length;
    const placeholder = `- [ ] <propose-question:${question.id}:${question.ordinal}>`;
    return sha256Text(`${content.slice(0, lineStart)}${placeholder}${content.slice(lineEnd)}`);
  }
  return null;
}

export function proposeOpenQuestionScope(question: ProposeQuestion, proposeRoundId: string): string {
  const fingerprint = sha256Text(`${proposeRoundId}\n${proposeQuestionDecisionBasisDigest(question)}`);
  return `${PROPOSE_OPEN_QUESTION_SCOPE_PREFIX}${fingerprint}:${question.id}`;
}

/** 兼容升级前已经展示给用户、但尚未登记的 scope。 */
export function legacyProposeOpenQuestionScope(question: ProposeQuestion, proposeRoundId: string): string {
  const fingerprint = sha256Text(`${proposeRoundId}\n${question.path}\n${question.documentFingerprint}`);
  return `${PROPOSE_OPEN_QUESTION_SCOPE_PREFIX}${fingerprint}:${question.id}`;
}

export function proposeOpenQuestionDisplayText(question: Pick<ProposeQuestion, "id" | "text">): string {
  if (question.id.startsWith("DEC-") && question.text.startsWith(question.id)) {
    return question.text.slice(question.id.length).replace(/^[\s:：—–-]+/, "").trim();
  }
  return question.text.trim();
}

export function collectProposeQuestions(changeRoot: string): ProposeQuestion[] {
  return PROPOSE_CONFIRMATION_DOCS.flatMap(path => {
    const fullPath = join(changeRoot, path);
    return existsSync(fullPath) ? parseProposeQuestions(readFileSync(fullPath, "utf8"), path) : [];
  });
}

export function countProposeOpenQuestionsInContent(content: string): number {
  return countOpenChecklistItemsInSection(content, PROPOSE_CONFIRMATION_HEADINGS);
}

export function collectProposeOpenQuestions(changeRoot: string): { openCount: number; files: ProposeOpenQuestionFile[] } {
  const files: ProposeOpenQuestionFile[] = [];
  for (const path of PROPOSE_CONFIRMATION_DOCS) {
    const fullPath = join(changeRoot, path);
    if (!existsSync(fullPath)) continue;
    const openCount = countProposeOpenQuestionsInContent(readFileSync(fullPath, "utf8"));
    if (openCount > 0) files.push({ path, openCount });
  }
  return {
    openCount: files.reduce((sum, file) => sum + file.openCount, 0),
    files,
  };
}

// ===== tasks.md =====
//
// task 行只定义顺序与标识。历史 task 仍允许附带 tdd_required/no_tdd_reason，
// 但新执行依据模式由 task-start 结合冻结策略生成有效证据要求。

export interface ParsedTask {
  taskId: string;
  lineIdx: number;
  done: boolean;
  tddRequired: boolean;
  noTddReason: string | null;
}

const TASK_LINE_RE = /^(- \[([ xX])\])\s+(\S+)/;
// 块头独占一行（允许全角/半角冒号）；PREFIX 变体用于识别"块头带尾部内容/误加 bullet"的格式错误
const EXECUTION_REQUIREMENT_LINE_RE = /^\s*执行依据[:：]\s*$/;
const EXECUTION_REQUIREMENT_PREFIX_RE = /^\s*-?\s*执行依据[:：]/;

const CONTRACT_FIELD_ALIASES: Record<string, keyof ExecutionContract> = {
  "测试": "tests",
  "Tests": "tests",
  "设计": "design",
  "Design": "design",
  "来源": "source",
  "Source": "source",
  // 原因是历史文档字段；新文档用验收，二者都归一为 acceptance。
  "验收": "acceptance",
  "Acceptance": "acceptance",
  "原因": "acceptance",
  "Reason": "acceptance",
  "边界": "guard",
  "Guard": "guard",
};

export interface ParsedExecutionRequirement {
  taskId: string;
  lineIdx: number;
  contract: ExecutionContract;
  /** 执行依据中实际出现的字段；用于区分“测试为空”和“遗漏测试字段”。 */
  declaredFields: Array<keyof ExecutionContract>;
  errors: string[];
}

export interface TestContractEntry {
  test_id: string;
  scenario: string;
}

export type TestContractParseResult =
  | { ok: true; entries: TestContractEntry[] }
  | { ok: false; entries: []; message: string };

/** 解析 tasks.md 的全部任务行 */
export function parseTasksMd(content: string): ParsedTask[] {
  const lines = content.split("\n");
  const tasks: ParsedTask[] = [];
  for (let i = 0; i < lines.length; i++) {
    const m = lines[i].match(TASK_LINE_RE);
    if (!m) continue;
    const taskId = m[3];
    const done = m[2].toLowerCase() === "x";
    // 用正则锚定字段边界，不依赖 includes()
    const tddMatch = lines[i].match(/\btdd_required:(true|false)\b/);
    const reasonMatch = lines[i].match(/\bno_tdd_reason:(\S+)\b/);
    tasks.push({
      taskId,
      lineIdx: i,
      done,
      tddRequired: tddMatch ? tddMatch[1] === "true" : true, // 默认 true
      noTddReason: reasonMatch ? reasonMatch[1] : null,
    });
  }
  return tasks;
}

/**
 * tasks.md 的机械结构校验。任务是否拆分合理、顺序是否符合真实依赖仍由
 * Critic/Architect 判断；这里仅拒绝引擎无法可靠驱动的格式。
 */
export function validateTasksDocument(content: string): string[] {
  const errors: string[] = [];
  if (!/^#\s+Tasks\s*$/m.test(content)) errors.push("tasks.md 缺少顶级 # Tasks 标题");

  const tasks = parseTasksMd(content);
  const seen = new Set<string>();
  for (const task of tasks) {
    if (seen.has(task.taskId)) errors.push(`tasks.md task ID 重复：${task.taskId}`);
    seen.add(task.taskId);
  }

  for (const [index, line] of content.split("\n").entries()) {
    if (/^\s+-\s+\[[ xX]\]\s+/.test(line)) {
      errors.push(`tasks.md 第 ${index + 1} 行存在缩进 checkbox；只有顶格 checkbox 可以作为可执行 task`);
    }
  }
  return errors;
}

function isTopLevelTaskLine(line: string): boolean {
  return TASK_LINE_RE.test(line);
}

function splitSourceRefs(value: string): string[] {
  return value
    .split(/[；;]/)
    .map(item => item.trim())
    .filter(Boolean);
}

function parseTestIds(value: string): { ids: string[]; ok: boolean } {
  const ids = value.match(/\bTEST-[A-Za-z0-9_-]+\b/g) ?? [];
  return { ids: [...new Set(ids)].sort(), ok: ids.length > 0 || value.trim() === "" };
}

function emptyContract(): ExecutionContract {
  return {
    tests: [],
    design: null,
    source: [],
    acceptance: null,
    guard: null,
  };
}

// 共享绑定判定：mode 判定与块解析都走这里，避免两处条件分裂。
// 从 task 行往下最多跳过 1 个纯空行（AI 生成时的常见格式波动，意图无歧义，直接接受）；
// 间隔更多空行或夹了其他内容的块不绑定，由孤儿检测报错。
function executionRequirementHeaderIdx(lines: string[], task: ParsedTask): number | null {
  let index = task.lineIdx + 1;
  if (index < lines.length && lines[index].trim() === "") index += 1;
  if (index < lines.length && EXECUTION_REQUIREMENT_LINE_RE.test(lines[index])) return index;
  return null;
}

function parseExecutionRequirementBlock(lines: string[], task: ParsedTask, headerIdx: number): ParsedExecutionRequirement {
  const contract = emptyContract();
  const errors: string[] = [];
  const seen = new Set<keyof ExecutionContract>();
  let index = headerIdx + 1;

  while (index < lines.length) {
    const line = lines[index];
    if (isTopLevelTaskLine(line) || /^#{1,6}\s+/.test(line)) break;
    if (/^\s*-\s+\[[ xX]\]/.test(line)) {
      errors.push(`${task.taskId} 的执行依据内不能包含复选框`);
    }

    const fieldMatch = line.match(/^\s*-\s*(测试|Tests|设计|Design|来源|Source|验收|Acceptance|原因|Reason|边界|Guard)\s*[:：]\s*(.*)$/);
    if (fieldMatch) {
      const key = CONTRACT_FIELD_ALIASES[fieldMatch[1]];
      const value = fieldMatch[2].trim();
      if (seen.has(key)) {
        errors.push(`${task.taskId} 的执行依据字段重复：${fieldMatch[1]}`);
      }
      seen.add(key);
      if (key === "tests") {
        const parsed = parseTestIds(value);
        if (!parsed.ok) errors.push(`${task.taskId} 的测试字段没有可解析的 TEST ID`);
        contract.tests = parsed.ids;
      } else if (key === "source") {
        contract.source = splitSourceRefs(value);
      } else {
        contract[key] = value || null;
      }
    }
    index += 1;
  }

  return { taskId: task.taskId, lineIdx: task.lineIdx, contract, declaredFields: [...seen], errors };
}

export function hasTaskBoundExecutionRequirements(content: string): boolean {
  const lines = content.split("\n");
  return parseTasksMd(content).some(task => executionRequirementHeaderIdx(lines, task) != null);
}

export function parseExecutionRequirements(content: string): ParsedExecutionRequirement[] {
  const lines = content.split("\n");
  const parsed: ParsedExecutionRequirement[] = [];
  for (const task of parseTasksMd(content)) {
    const headerIdx = executionRequirementHeaderIdx(lines, task);
    if (headerIdx != null) parsed.push(parseExecutionRequirementBlock(lines, task, headerIdx));
  }
  return parsed;
}

// 孤儿执行依据检测：块头存在但没有绑定到任何 task（间隔过多空行、夹了其他内容、
// 或块头带尾部文字导致整行不匹配）。这些块会被引擎静默忽略，必须显式报错阻断，
// 否则全部悬空时契约模式静默失效（使用者是 AI，报错消息要给出可直接执行的修复动作）。
export function orphanExecutionRequirementErrors(content: string): string[] {
  const lines = content.split("\n");
  const boundHeaderIdx = new Set<number>();
  for (const task of parseTasksMd(content)) {
    const headerIdx = executionRequirementHeaderIdx(lines, task);
    if (headerIdx != null) boundHeaderIdx.add(headerIdx);
  }
  const errors: string[] = [];
  for (let i = 0; i < lines.length; i++) {
    if (boundHeaderIdx.has(i)) continue;
    if (EXECUTION_REQUIREMENT_LINE_RE.test(lines[i])) {
      errors.push(`第 ${i + 1} 行的"执行依据:"没有绑定到任何 task（块头与 task 行之间最多允许一个空行），该块不会生效；请把它紧贴到所属 task 行下方`);
    } else if (EXECUTION_REQUIREMENT_PREFIX_RE.test(lines[i])) {
      errors.push(`第 ${i + 1} 行的"执行依据:"块头格式无法识别；块头必须独占一行（不带 bullet、冒号后不带内容），字段写在下方的 bullet 行`);
    }
  }
  return errors;
}

export function executionRequirementForTask(content: string, taskId: string): ParsedExecutionRequirement | null {
  return parseExecutionRequirements(content).find(item => item.taskId === taskId) ?? null;
}

// 契约"解析"与"采纳"的统一出口：contract 非 null 当且仅当本轮是契约模式且该 task 有绑定块。
// 消费方（attempt/details/packet）一律从这里取值，禁止各自组合 parsed 与 mode——
// 否则 legacy 轮会输出"看似契约、实按 legacy 校验"的误导态。
export function adoptedContractForTask(
  content: string,
  taskId: string,
  contractMode: boolean,
): { parsed: ParsedExecutionRequirement | null; contract: ExecutionContract | null } {
  const parsed = executionRequirementForTask(content, taskId);
  return { parsed, contract: contractMode ? parsed?.contract ?? null : null };
}

/**
 * Fix task 由状态机从已批准的实现范围派生；它没有 proposal 阶段执行依据块。
 * REVIEW-FIX-* 是发布前已有的持久化 task ID，FIX-SELFTEST-* 是当前引擎生成的
 * 自测修复 task。不能把通用 FIX-* 前缀保留为内部命名空间。
 */
export function isFixTaskId(taskId: string): boolean {
  return taskId.startsWith("REVIEW-FIX-") || taskId.startsWith("FIX-SELFTEST-");
}

/** @deprecated 新代码使用 isFixTaskId；保留给旧扩展和历史调用。 */
export function isReviewFixTaskId(taskId: string): boolean {
  return isFixTaskId(taskId);
}

export function isCharacterizationTask(task: ParsedTask): boolean {
  return task.tddRequired === false && task.noTddReason === "characterization";
}

export function parseTestContractEntries(content: string): TestContractParseResult {
  const lines = content.split("\n");
  const entries: TestContractEntry[] = [];
  const seen = new Set<string>();
  let sawMatchingHeader = false;

  for (let i = 0; i < lines.length - 1; i++) {
    const header = splitMarkdownTableRow(lines[i]);
    if (header.length === 0) continue;
    const normalizedHeader = header.map(cell => cell.trim().toLowerCase());
    const testIdIdx = normalizedHeader.indexOf("test_id");
    const scenarioIdx = normalizedHeader.indexOf("scenario");
    if (testIdIdx < 0 || scenarioIdx < 0) continue;
    if (!isMarkdownTableSeparator(lines[i + 1])) continue;
    sawMatchingHeader = true;
    for (let rowIndex = i + 2; rowIndex < lines.length; rowIndex++) {
      const row = splitMarkdownTableRow(lines[rowIndex]);
      if (row.length === 0) break;
      const testId = (row[testIdIdx] ?? "").trim();
      const scenario = (row[scenarioIdx] ?? "").trim();
      if (!testId) {
        return { ok: false, entries: [], message: `test-contract.md 第 ${rowIndex + 1} 行缺少 test_id` };
      }
      if (!/^TEST-[A-Za-z0-9_-]+$/.test(testId)) {
        return { ok: false, entries: [], message: `test-contract.md 中 TEST ID 格式无效：${testId}` };
      }
      if (seen.has(testId)) {
        return { ok: false, entries: [], message: `test-contract.md 中 TEST ID 重复：${testId}` };
      }
      if (!scenario) {
        return { ok: false, entries: [], message: `test-contract.md 中 ${testId} 缺少 scenario` };
      }
      seen.add(testId);
      entries.push({
        test_id: testId,
        scenario,
      });
    }
  }

  if (!sawMatchingHeader) return { ok: false, entries: [], message: "test-contract.md 缺少包含测试 ID（test_id）和场景（scenario）的表格" };
  if (entries.length === 0) return { ok: false, entries: [], message: "test-contract.md 没有 TEST-* 行" };
  return { ok: true, entries };
}

export interface ProposalImpactValidation {
  ok: boolean;
  message: string;
}

/** OpenSpec 项目的 proposal 采用固定 Impact 表格，供状态机进行纯结构校验。 */
export function validateProposalImpact(content: string): ProposalImpactValidation {
  const body = sectionBodyByHeadings(content, ["Impact"]);
  if (body == null) return { ok: false, message: "proposal.md 缺少 ## Impact" };
  const tableLines = body.split("\n").filter(line => line.trim().startsWith("|"));
  if (tableLines.length < 3 || !isMarkdownTableSeparator(tableLines[1])) {
    return { ok: false, message: "proposal.md 的 Impact 必须包含 Area / Reason 表格" };
  }
  const header = splitMarkdownTableRow(tableLines[0]).map(cell => cell.toLowerCase());
  const areaIdx = header.indexOf("area");
  const reasonIdx = header.indexOf("reason");
  if (areaIdx < 0 || reasonIdx < 0) {
    return { ok: false, message: "proposal.md 的 Impact 表格缺少 Area 或 Reason 列" };
  }
  const rows = tableLines.slice(2).map(splitMarkdownTableRow).filter(cells => cells.length > 0);
  if (rows.length === 0) return { ok: false, message: "proposal.md 的 Impact 表格至少需要一行" };
  for (const [index, row] of rows.entries()) {
    if (!row[areaIdx]?.trim() || !row[reasonIdx]?.trim()) {
      return { ok: false, message: `proposal.md 的 Impact 第 ${index + 1} 行缺少 Area 或 Reason` };
    }
  }
  return { ok: true, message: "proposal.md Impact 结构有效" };
}

export interface ExecutionRequirementValidation {
  ok: boolean;
  mode: boolean;
  contracts: ParsedExecutionRequirement[];
  errors: string[];
}

function isQualifiedDocumentRef(value: string): boolean {
  const ref = value.trim();
  return /^(?!\/)(?!.*(?:^|\/)\.\.(?:\/|$))[^\s#]+\.md#[^\s].*$/.test(ref);
}

function executionRequirementReferenceErrors(contract: ParsedExecutionRequirement): string[] {
  const errors: string[] = [];
  if (contract.contract.design && !isQualifiedDocumentRef(contract.contract.design)) {
    errors.push(`${contract.taskId} 的设计必须使用 文件.md#标题 的可定位引用`);
  }
  for (const source of contract.contract.source) {
    if (!isQualifiedDocumentRef(source)) {
      errors.push(`${contract.taskId} 的来源必须使用 文件.md#标题 的可定位引用：${source}`);
    }
  }
  return errors;
}

function parseQualifiedDocumentRef(value: string): { path: string; anchor: string } | null {
  const ref = value.trim();
  const separator = ref.indexOf("#");
  if (separator <= 0 || separator === ref.length - 1) return null;
  return { path: ref.slice(0, separator), anchor: ref.slice(separator + 1).trim() };
}

function isPathInside(root: string, target: string): boolean {
  const rel = relative(root, target);
  return rel !== "" && !rel.startsWith(`..${sep}`) && rel !== ".." && !isAbsolute(rel);
}

function documentContainsAnchor(content: string, anchor: string): boolean {
  if (/^(?:TEST|CHAIN|IDC)-[A-Za-z0-9_-]+$/.test(anchor)) {
    const token = new RegExp(`(?:^|[^A-Za-z0-9_-])${escapeRegex(anchor)}(?![A-Za-z0-9_-])`);
    return token.test(content);
  }
  // 支持 Markdown ATX 标题可选的 closing sequence（`## Route ##`），但正文
  // 中同名文字仍不能冒充可定位锚点。
  const heading = new RegExp(`^#{1,6}[\\t ]+${escapeRegex(anchor)}(?:[\\t ]+#+)?[\\t ]*$`, "m");
  return heading.test(content);
}

function documentAnchorParts(anchor: string): string[] {
  const parts = anchor.split(",").map(part => part.trim()).filter(Boolean);
  return parts.length > 1 && parts.every(part => /^(?:TEST|CHAIN|IDC)-[A-Za-z0-9_-]+$/.test(part))
    ? parts
    : [anchor];
}

function documentAnchorCandidates(content: string, path: string, requested: string): string[] {
  const candidates: { anchor: string; index: number }[] = [];
  for (const match of content.matchAll(/^#{1,6}[\t ]+(.+?)(?:[\t ]+#+)?[\t ]*$/gm)) {
    const anchor = match[1]?.trim();
    if (anchor) candidates.push({ anchor, index: match.index ?? candidates.length });
  }
  for (const match of content.matchAll(/(?:^|[^A-Za-z0-9_-])((?:TEST|CHAIN|IDC)-[A-Za-z0-9_-]+)(?![A-Za-z0-9_-])/gm)) {
    candidates.push({ anchor: match[1], index: match.index ?? candidates.length });
  }
  const normalizedRequested = requested.toLocaleLowerCase();
  const score = (anchor: string): number => {
    const normalized = anchor.toLocaleLowerCase();
    if (normalized === normalizedRequested) return 100;
    if (normalized.includes(normalizedRequested) || normalizedRequested.includes(normalized)) return 50;
    const requestedTokens = new Set(normalizedRequested.split(/[^\p{L}\p{N}_-]+/u).filter(Boolean));
    return normalized.split(/[^\p{L}\p{N}_-]+/u).filter(Boolean).filter(token => requestedTokens.has(token)).length * 10;
  };
  return [...new Map(candidates.map(candidate => [candidate.anchor, candidate])).values()]
    .sort((left, right) => score(right.anchor) - score(left.anchor) || left.index - right.index)
    .slice(0, 8)
    .map(candidate => `${path}#${candidate.anchor}`);
}

function canonicalDocumentRefPath(path: string): string {
  if (path === "discovery.md" || path === "test-contract.md") {
    return join(".superspec", "artifacts", path);
  }
  return path;
}

/**
 * 在已初始化的当前工作流中，把执行依据的文件/锚点可解析性作为状态机协议。
 * “该材料是否足以支撑 task”仍然是 Critic/Architect 的语义判断。
 */
export function validateExecutionRequirementDocumentReferences(
  changeRoot: string,
  contracts: readonly ParsedExecutionRequirement[],
): string[] {
  const root = resolve(changeRoot);
  const realRoot = realpathSync(root);
  const errors: string[] = [];
  for (const contract of contracts) {
    const refs = [contract.contract.design, ...contract.contract.source].filter((value): value is string => Boolean(value));
    for (const ref of refs) {
      const parsed = parseQualifiedDocumentRef(ref);
      if (!parsed) continue; // 语法错误由 executionRequirementReferenceErrors 报告。
      const target = resolve(root, canonicalDocumentRefPath(parsed.path));
      if (!isPathInside(root, target)) {
        errors.push(`${contract.taskId} 的引用越出 change 目录：${ref}`);
        continue;
      }
      if (!existsSync(target)) {
        errors.push(`${contract.taskId} 的引用文件不存在：${parsed.path}`);
        continue;
      }
      // resolve/relative 只能识别字面 `..`，不能阻止 change 内的符号链接指向
      // 外部文件；按真实路径再次校验，确保引用材料仍属于当前 change。
      let realTarget: string;
      try {
        realTarget = realpathSync(target);
      } catch {
        errors.push(`${contract.taskId} 的引用文件无法解析：${parsed.path}`);
        continue;
      }
      if (!isPathInside(realRoot, realTarget)) {
        errors.push(`${contract.taskId} 的引用越出 change 目录：${ref}`);
        continue;
      }
      const targetContent = readFileSync(target, "utf8");
      for (const anchor of documentAnchorParts(parsed.anchor)) {
        if (!documentContainsAnchor(targetContent, anchor)) {
          const candidates = documentAnchorCandidates(targetContent, parsed.path, anchor);
          errors.push(`${contract.taskId} 的引用锚点不存在：${parsed.path}#${anchor}${candidates.length > 0 ? `；可用锚点：${candidates.join("、")}` : ""}`);
        }
      }
    }
  }
  return errors;
}

export function validateExecutionRequirements(
  content: string,
  testContractContent: string | null,
  executionPolicy: ExecutionPolicy = "tdd",
  executionRequirementVersion: 1 | 2 = 2,
): ExecutionRequirementValidation {
  const tasks = parseTasksMd(content);
  // 历史 green-only task 在旧版本中用标记强制进入契约模式。保留该入口，
  // 防止已生成但尚未执行的 change 在升级后静默退回无验证的 legacy 模式；
  // 新 Propose 不再产生此标记。
  const hasLegacyGreenOnlyTask = tasks.some(task => task.noTddReason === GREEN_ONLY_NO_TDD_REASON);
  // v2 不允许“所有任务都没有执行依据”这一静默回退：新 Propose 的每个普通
  // task 都必须显式声明五字段。v1 的缺失版本仍保留旧的按需契约语义。
  const hasV2OrdinaryTask = executionRequirementVersion === 2 && tasks.some(task => !isFixTaskId(task.taskId));
  const mode = hasTaskBoundExecutionRequirements(content) || hasLegacyGreenOnlyTask || hasV2OrdinaryTask;
  const contracts = parseExecutionRequirements(content);
  // 孤儿检测必须在 mode=false 的 early return 之前：全部块都悬空时 mode=false，
  // 恰恰是最需要报错的场景（否则契约模式静默失效）
  const errors = [...orphanExecutionRequirementErrors(content), ...contracts.flatMap(item => item.errors)];
  if (!mode) return { ok: errors.length === 0, mode, contracts, errors };

  const contractsByTask = new Map(contracts.map(item => [item.taskId, item]));
  const declaredTestIds = new Set<string>();
  let needsTestContract = false;

  for (const task of tasks) {
    const contract = contractsByTask.get(task.taskId);
    const legacyGreenOnly = task.noTddReason === GREEN_ONLY_NO_TDD_REASON;
    if (legacyGreenOnly && task.tddRequired) {
      errors.push(`${task.taskId} 的 no_tdd_reason=${GREEN_ONLY_NO_TDD_REASON} 必须同时声明 tdd_required:false`);
    }
    if (legacyGreenOnly && executionPolicy !== "green_only") {
      errors.push(`${task.taskId} 的 no_tdd_reason=${GREEN_ONLY_NO_TDD_REASON} 只允许用于 GREEN-only apply`);
    }
    // v2 是本次改造后的新计划：每个普通 task 必须声明完整五字段，
    // `测试:` 可显式为空以表达非行为任务。旧计划只保持原 TDD 契约要求。
    if (executionRequirementVersion === 2 && !isFixTaskId(task.taskId) && !contract) {
      errors.push(`${task.taskId} 缺少执行依据`);
      continue;
    }
    if (executionRequirementVersion === 1 && task.tddRequired && !isFixTaskId(task.taskId) && !contract) {
      errors.push(`${task.taskId} 缺少执行依据`);
      continue;
    }
    if (contract && executionRequirementVersion === 2) {
      if (!contract.declaredFields.includes("tests")) errors.push(`${task.taskId} 的执行依据缺少测试字段`);
      if (!contract.contract.design) errors.push(`${task.taskId} 的执行依据缺少设计`);
      if (contract.contract.source.length === 0) errors.push(`${task.taskId} 的执行依据缺少来源`);
      if (!contract.contract.acceptance) errors.push(`${task.taskId} 的执行依据缺少验收目标`);
      if (!contract.contract.guard) errors.push(`${task.taskId} 的执行依据缺少边界`);
      errors.push(...executionRequirementReferenceErrors(contract));
    }
    if (contract && (executionRequirementVersion === 1 && task.tddRequired || legacyGreenOnly) && contract.contract.tests.length === 0) {
      errors.push(`${task.taskId} 的执行依据缺少测试`);
    }
    if (contract && contract.contract.tests.length > 0) {
      needsTestContract = true;
      for (const testId of contract.contract.tests) declaredTestIds.add(testId);
    }
  }

  if (needsTestContract) {
    if (testContractContent == null) {
      errors.push("test-contract.md 不存在，无法校验执行依据测试引用");
    } else {
      const parsed = parseTestContractEntries(testContractContent);
      if (!parsed.ok) {
        errors.push(parsed.message);
      } else {
        const known = new Set(parsed.entries.map(entry => entry.test_id));
        for (const testId of declaredTestIds) {
          if (!known.has(testId)) errors.push(`执行依据引用了不存在的 TEST ID：${testId}`);
        }
      }
    }
  }

  return { ok: errors.length === 0, mode, contracts, errors };
}

/** 返回未完成任务 */
export function pendingTasksInContent(content: string): ParsedTask[] {
  return parseTasksMd(content).filter(task => !task.done);
}

/** 在 tasks.md 中按 taskId 精确查找任务（词边界，不误判子串） */
export function findTaskInLines(lines: string[], taskId: string): number {
  const escaped = taskId.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  // 回退匹配也必须停留在顶格 checkbox 任务行内；否则上一任务的
  // “依赖/边界/验收”文本提到该 ID 时，会被误当成目标任务行。
  const taskIdAtLineStart = new RegExp(`^${escaped}(?=\\s|$|[.,:;!?)\\]])`);
  for (let i = 0; i < lines.length; i++) {
    // 精确匹配行内的 taskId token
    const m = lines[i].match(TASK_LINE_RE);
    if (m && m[3] === taskId) return i;
    // 回退：兼容 taskId 后跟标点的任务行，但不扫描普通说明文本。
    const taskLine = lines[i].match(/^-\s+\[[ xX]\]\s+(.+)$/);
    if (taskLine && taskIdAtLineStart.test(taskLine[1])) return i;
  }
  return -1;
}

/** tasks.md 结构指纹（复选框归一化） */
export function tasksStructureDigest(content: string, sha256Text: (s: string) => string): string {
  return sha256Text(content.replace(/- \[[xX]\]/g, "- [ ]"));
}

// ===== 测试运行 JSON =====
//
// 格式（apply skill 定义）：
//   {
//     "test_id": "TEST-XXX",
//     "attempt_id": "ATT-TASK-XXX-...",
//     "task_structure_digest": "sha256:...",
//     "command": "npm test",
//     "cwd": "/path",
//     "exit_code": 1,
//     "semantic_status": "expected_failure",
//     "covers_task_ids": ["TASK-001"],
//     "target_fingerprint": "sha256:..."
//   }
//
// 引擎校验：测试 ID（test_id）+ 任务结构指纹（task_structure_digest）必填，回归覆盖任务列表（covers_task_ids）如存在必须是非空字符串数组，其余可选
//（实际校验内联在 task.ts recordTestRunLoaded：契约模式走 validateContractTestRunInput，legacy 模式内联必填校验）

// ===== user-decision JSON =====
//
// 格式（explore skill 定义）：
//   {
//     "scope": "enter_propose",
//     "question": "是否进入计划阶段？",
//     "answer": "yes"
//   }
//
// 引擎校验：决策范围（scope）+ 答复内容（answer）必填

export function validateUserDecision(d: Record<string, unknown>): { ok: boolean; message: string } {
  if (!d.scope) return { ok: false, message: "决策文件缺少决策范围（scope）" };
  if (!d.answer) return { ok: false, message: "决策文件缺少答复内容（answer）" };
  return { ok: true, message: "" };
}

// ===== test-contract.md =====
//
// 格式（状态机校验，propose skill 负责生成）：
//   # Test Contract
//   | test_id | scenario |
//   |---|---|
//   | TEST-001 | 注册时密码被加密 |
//
// 引擎行为：当 task 声明 TEST 时，状态机解析表格、TEST ID 和 scenario，
// 并在 propose-ready / start-apply 阶段拒绝无效引用；测试语义和证明力仍由
// Test Engineer 判断。
