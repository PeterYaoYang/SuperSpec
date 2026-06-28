// SuperSpec 流程引擎 — format.ts：文档格式解析的唯一权威源
//
// 所有文档的格式定义和解析逻辑都在这里。skills 文案引用这里的格式。
// 修改格式 = 修改这里 + 对应 skill。禁止在其它地方重复解析。

import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";

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
  const headingPattern = headings.map(escapeRegex).join("|");
  const sectionMatch = new RegExp(`^#{1,6}\\s*(?:${headingPattern})\\s*$`, "im").exec(content);
  if (!sectionMatch) return 0;
  const sectionStart = sectionMatch.index! + sectionMatch[0].length;
  // 截取到下一个标题或文件末尾
  const restContent = content.slice(sectionStart);
  const nextHeadingMatch = restContent.match(/^#{1,6}\s+/m);
  const sectionBody = nextHeadingMatch ? restContent.slice(0, nextHeadingMatch.index) : restContent;
  // 数未确认项
  const matches = sectionBody.match(/^\s*-\s+\[ \]/gm);
  return matches ? matches.length : 0;
}

/** 从 discovery.md 提取"待确认问题"段内的未确认项数量 */
export function countDiscoveryOpenQuestions(content: string): number {
  return countOpenChecklistItemsInSection(content, ["待确认问题", "Open Questions", "Pending Questions"]);
}

/** 完整校验 discovery.md：存在 + 非空 + 无未确认问题 */
export function validateDiscovery(changeRoot: string): { ok: boolean; message: string; openCount: number } {
  const path = join(changeRoot, ".superspec", "artifacts", "discovery.md");
  if (!existsSync(path)) return { ok: false, message: "discovery.md 不存在", openCount: -1 };
  const content = readFileSync(path, "utf8");
  if (!content.trim()) return { ok: false, message: "discovery.md 为空", openCount: -1 };
  const openCount = countDiscoveryOpenQuestions(content);
  if (openCount > 0) return { ok: false, message: `discovery.md 有 ${openCount} 个未确认问题`, openCount };
  return { ok: true, message: "discovery.md 就绪", openCount: 0 };
}

// ===== propose 待用户确认 =====
//
// 格式（propose skill 定义）：
//   ## 待用户确认
//   - [ ] DEC-001 是否兼容旧行为？
//   - [x] DEC-002 已确认的问题
//
// 引擎只解析指定计划文档中该段落内的 `- [ ]`，不误判其它 checklist。

export interface ProposeOpenQuestionFile {
  path: string;
  openCount: number;
}

const PROPOSE_CONFIRMATION_DOCS = [
  "proposal.md",
  "design.md",
  ".superspec/artifacts/test-contract.md",
] as const;

const PROPOSE_CONFIRMATION_HEADINGS = ["待用户确认", "待确认问题", "Open Questions", "Pending Questions"] as const;

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
// 格式（propose skill 定义）：
//   # Tasks
//
//   - [ ] TASK-001 实现登录 tdd_required:true
//   - [ ] TASK-002 更新文档 tdd_required:false no_tdd_reason:documentation-only
//
// 引擎解析每行任务：复选框状态、taskId、tdd_required、no_tdd_reason

export interface ParsedTask {
  taskId: string;
  lineIdx: number;
  done: boolean;
  tddRequired: boolean;
  noTddReason: string | null;
}

const TASK_LINE_RE = /^(- \[([ xX])\])\s+(\S+)/;

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

/** 返回未完成任务 */
export function pendingTasksInContent(content: string): ParsedTask[] {
  return parseTasksMd(content).filter(task => !task.done);
}

/** 在 tasks.md 中按 taskId 精确查找任务（词边界，不误判子串） */
export function findTaskInLines(lines: string[], taskId: string): number {
  for (let i = 0; i < lines.length; i++) {
    // 精确匹配行内的 taskId token
    const m = lines[i].match(TASK_LINE_RE);
    if (m && m[3] === taskId) return i;
    // 回退：用转义正则匹配（兼容 taskId 后跟标点的情况）
    const escaped = taskId.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    if (new RegExp("(?:^|\\s)" + escaped + "(?:\\s|$|[.,:;!?)\\]])").test(lines[i])) return i;
  }
  return -1;
}

/** tasks.md 结构指纹（复选框归一化） */
export function tasksStructureDigest(content: string, sha256Text: (s: string) => string): string {
  return sha256Text(content.replace(/- \[[xX]\]/g, "- [ ]"));
}

// ===== test-run JSON =====
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
// 引擎校验：test_id + task_structure_digest 必填，covers_task_ids 如存在必须是非空字符串数组，其余可选

export function validateTestRunInput(tr: Record<string, unknown>): { ok: boolean; message: string } {
  if (!tr.test_id) return { ok: false, message: "缺少 test_id" };
  if (!tr.task_structure_digest) return { ok: false, message: "缺少 task_structure_digest" };
  if (tr.covers_task_ids !== undefined) {
    if (!Array.isArray(tr.covers_task_ids)) return { ok: false, message: "covers_task_ids 必须是字符串数组" };
    if (tr.covers_task_ids.length === 0) return { ok: false, message: "covers_task_ids 不能是空数组" };
    if (!tr.covers_task_ids.every(item => typeof item === "string" && item.trim().length > 0)) {
      return { ok: false, message: "covers_task_ids 不能包含空字符串或非字符串" };
    }
  }
  return { ok: true, message: "" };
}

// ===== user-decision JSON =====
//
// 格式（explore skill 定义）：
//   {
//     "scope": "enter_propose",
//     "question": "是否进入计划阶段？",
//     "answer": "yes"
//   }
//
// 引擎校验：scope + answer 必填

export function validateUserDecision(d: Record<string, unknown>): { ok: boolean; message: string } {
  if (!d.scope) return { ok: false, message: "决策文件缺少 scope" };
  if (!d.answer) return { ok: false, message: "决策文件缺少 answer" };
  return { ok: true, message: "" };
}

// ===== business-invariants.md =====
//
// 格式（propose skill 定义）：
//   # Business Invariants
//   - INV-001 用户密码必须加密存储
//
// 引擎行为：Phase 1-5 只校验文件存在性（轻量）。
// 内部结构（INV-XXX 编号）是 agent 指引，引擎不逐行解析。

// ===== test-contract.md =====
//
// 格式（propose skill 定义）：
//   # Test Contract
//   | test_id | invariant | scenario |
//   |---|---|---|
//   | TEST-001 | INV-001 | 注册时密码被加密 |
//
// 引擎行为：Phase 1-5 只校验文件存在性（轻量）。
// 表格结构是 agent 指引，引擎不逐行解析。
