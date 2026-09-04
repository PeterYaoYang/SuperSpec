// SuperSpec 项目级工作流配置。所有阶段从同一位置解析默认 mode，
// 避免 CLI、Explore、Propose、Review 各自保留不同默认值。

import { existsSync, readFileSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { ReviewRisk } from "./review.ts";
import type { Event, State } from "./types.ts";

export const WORKFLOW_CONFIG_PATH = ".superspec/config.json";
/** 项目未声明 workflow.mode 时采用的默认档位。 */
export const DEFAULT_WORKFLOW_RISK: ReviewRisk = "normal";
export const DEFAULT_WORKFLOW_BUDGET = {
  tasks: 10,
  tests: 20,
  review_fix_rounds: 2,
} as const;
export type WorkflowBudget = {
  tasks: number | null;
  tests: number | null;
  review_fix_rounds: number | null;
};
export const WORKFLOW_HOSTS = ["codex", "omp"] as const;
export type WorkflowHost = (typeof WORKFLOW_HOSTS)[number];
/** 未声明 hosts 的旧项目按 Codex 入口处理。 */
export const DEFAULT_WORKFLOW_HOSTS: WorkflowHost[] = ["codex"];

export class WorkflowConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "WorkflowConfigError";
  }
}

function isReviewRisk(value: unknown): value is ReviewRisk {
  return value === "minimal" || value === "normal" || value === "strict";
}

function parseWorkflowBudgetValue(value: unknown, field: string): number | null {
  if (value === null) return null;
  if (typeof value !== "number" || !Number.isInteger(value) || value < 0) {
    throw new WorkflowConfigError(`${WORKFLOW_CONFIG_PATH} 的 workflow.budget.${field} 必须是非负整数或 null`);
  }
  return value;
}

function workflowBudgetFromObject(budget: Record<string, unknown> | undefined): WorkflowBudget {
  if (!budget) return { ...DEFAULT_WORKFLOW_BUDGET };
  const tasks = budget.tasks === undefined
    ? DEFAULT_WORKFLOW_BUDGET.tasks
    : parseWorkflowBudgetValue(budget.tasks, "tasks");
  const tests = budget.tests === undefined
    ? DEFAULT_WORKFLOW_BUDGET.tests
    : parseWorkflowBudgetValue(budget.tests, "tests");
  const review_fix_rounds = budget.review_fix_rounds === undefined
    ? DEFAULT_WORKFLOW_BUDGET.review_fix_rounds
    : parseWorkflowBudgetValue(budget.review_fix_rounds, "review_fix_rounds");
  return { tasks, tests, review_fix_rounds };
}

/**
 * 读取计划规模与 review-fix 上限；minimal 档整体忽略，budget 为 null 整体关闭，单项 null 关闭该项检查。
 * 注意 0 不等于关闭：tasks/tests 为 0 表示任何任务/TEST 都超预算，review_fix_rounds 为 0 表示不允许自动修复。
 */
export function workflowBudgetForRisk(projectRoot: string, risk: ReviewRisk): WorkflowBudget | null {
  if (risk === "minimal") return null;
  const workflow = workflowObject(readWorkflowConfigObject(projectRoot));
  if (!workflow) return { ...DEFAULT_WORKFLOW_BUDGET };
  if (workflow.budget === undefined) return { ...DEFAULT_WORKFLOW_BUDGET };
  // budget: null 表示整体关闭预算与修复上限。
  if (workflow.budget === null) return { tasks: null, tests: null, review_fix_rounds: null };
  if (typeof workflow.budget !== "object" || Array.isArray(workflow.budget)) {
    throw new WorkflowConfigError(`${WORKFLOW_CONFIG_PATH} 的 workflow.budget 必须是 object 或 null`);
  }
  return workflowBudgetFromObject(workflow.budget as Record<string, unknown>);
}

function isWorkflowHost(value: unknown): value is WorkflowHost {
  return value === "codex" || value === "omp";
}

export function normalizeWorkflowHosts(values: readonly string[]): WorkflowHost[] {
  const hosts = [...new Set(values.filter(isWorkflowHost))];
  hosts.sort((left, right) => WORKFLOW_HOSTS.indexOf(left) - WORKFLOW_HOSTS.indexOf(right));
  return hosts;
}

export function parseWorkflowHostsFlag(raw: string): WorkflowHost[] {
  const hosts = normalizeWorkflowHosts(raw.split(/[,\s]+/).filter(Boolean));
  if (hosts.length === 0) {
    throw new WorkflowConfigError(`hosts 只能是 ${WORKFLOW_HOSTS.join("、")}，至少选一个`);
  }
  return hosts;
}

function readWorkflowConfigObject(projectRoot: string): Record<string, unknown> | null {
  const configPath = join(projectRoot, WORKFLOW_CONFIG_PATH);
  if (!existsSync(configPath)) return null;

  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(configPath, "utf8"));
  } catch {
    throw new WorkflowConfigError(`${WORKFLOW_CONFIG_PATH} 必须是有效 JSON`);
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new WorkflowConfigError(`${WORKFLOW_CONFIG_PATH} 顶层必须是 JSON object`);
  }
  return parsed as Record<string, unknown>;
}

function workflowObject(parsed: Record<string, unknown> | null): Record<string, unknown> | undefined {
  if (!parsed || parsed.workflow === undefined) return undefined;
  if (parsed.workflow === null || typeof parsed.workflow !== "object" || Array.isArray(parsed.workflow)) {
    throw new WorkflowConfigError(`${WORKFLOW_CONFIG_PATH} 的 workflow 必须是 object`);
  }
  return parsed.workflow as Record<string, unknown>;
}

function hostsFromWorkflow(workflow: Record<string, unknown> | undefined): WorkflowHost[] {
  if (!workflow || workflow.hosts === undefined) return DEFAULT_WORKFLOW_HOSTS;
  if (!Array.isArray(workflow.hosts)) {
    throw new WorkflowConfigError(`${WORKFLOW_CONFIG_PATH} 的 workflow.hosts 必须是字符串数组`);
  }
  const hosts = normalizeWorkflowHosts(workflow.hosts.filter((item): item is string => typeof item === "string"));
  if (hosts.length === 0) {
    throw new WorkflowConfigError(`${WORKFLOW_CONFIG_PATH} 的 workflow.hosts 只能包含 ${WORKFLOW_HOSTS.join("、")}，至少一项`);
  }
  return hosts;
}

/** 读取项目已选宿主。缺少配置或缺少 workflow.hosts 时默认 Codex。 */
export function workflowHostsForProject(projectRoot: string): WorkflowHost[] {
  return hostsFromWorkflow(workflowObject(readWorkflowConfigObject(projectRoot)));
}

export function persistWorkflowHosts(projectRoot: string, hosts: WorkflowHost[]): string {
  const configPath = join(projectRoot, WORKFLOW_CONFIG_PATH);
  mkdirSync(dirname(configPath), { recursive: true });
  const parsed = readWorkflowConfigObject(projectRoot) ?? {};
  const workflow = workflowObject(parsed) ?? {};
  if (workflow.mode === undefined) workflow.mode = DEFAULT_WORKFLOW_RISK;
  workflow.hosts = normalizeWorkflowHosts(hosts);
  parsed.workflow = workflow;
  writeFileSync(configPath, `${JSON.stringify(parsed, null, 2)}\n`);
  return WORKFLOW_CONFIG_PATH;
}

export function workflowHostsDeclared(projectRoot: string): boolean {
  const workflow = workflowObject(readWorkflowConfigObject(projectRoot));
  return workflow !== undefined && workflow.hosts !== undefined;
}

function workflowModeFromPayload(payload: Record<string, unknown>): ReviewRisk | null {
  return isReviewRisk(payload.workflow_mode) ? payload.workflow_mode : null;
}

/**
 * Propose-ready 是一个 planning round 的冻结点。配置只影响尚未冻结的计划；
 * 已就绪计划必须沿用当时的 mode，直到 reopen 回到 propose 后创建新 round。
 */
export function workflowRiskForProposeRound(events: Event[], fallback: ReviewRisk): ReviewRisk {
  for (let i = events.length - 1; i >= 0; i--) {
    const event = events[i];
    if (event.event_type !== "transition_commit") continue;
    const payload = event.payload as { transition?: unknown; to_state?: unknown };
    if (payload.transition !== "propose-ready" || payload.to_state !== "propose_ready") continue;
    return workflowModeFromPayload(event.payload) ?? fallback;
  }
  return fallback;
}

/** 是否已经由当前引擎在 propose-ready 冻结 mode；缺失时是历史 planning round。 */
export function hasFrozenWorkflowModeForProposeRound(events: Event[]): boolean {
  for (let i = events.length - 1; i >= 0; i--) {
    const event = events[i];
    if (event.event_type !== "transition_commit") continue;
    const payload = event.payload as { transition?: unknown; to_state?: unknown };
    if (payload.transition !== "propose-ready" || payload.to_state !== "propose_ready") continue;
    return workflowModeFromPayload(event.payload) !== null;
  }
  return false;
}

/** Apply round 从 start-apply 起冻结；兼容首批事件中只写 review_policy 的格式。 */
export function workflowRiskForApplyRound(events: Event[], fallback: ReviewRisk): ReviewRisk {
  let latestStartApplyIndex = -1;
  for (let i = events.length - 1; i >= 0; i--) {
    const event = events[i];
    if (event.event_type !== "transition_commit") continue;
    const payload = event.payload as {
      transition?: unknown;
      to_state?: unknown;
      review_policy?: { review_risk?: unknown };
    };
    if (payload.transition === "start-apply" && payload.to_state === "apply") {
      latestStartApplyIndex = i;
      const frozenMode = workflowModeFromPayload(event.payload) ??
        (isReviewRisk(payload.review_policy?.review_risk) ? payload.review_policy.review_risk : null);
      if (frozenMode) return frozenMode;
      break;
    }
  }
  // 升级前 review policy 首次在 review-ready 才落盘；只在当前 start-apply 之后查找，
  // 防止 reopen 后新 round 泄漏第一轮策略。
  if (latestStartApplyIndex >= 0) {
    for (let i = events.length - 1; i >= latestStartApplyIndex; i--) {
      const event = events[i];
      if (event.event_type !== "transition_commit") continue;
      const payload = event.payload as { review_policy?: { review_risk?: unknown } };
      if (isReviewRisk(payload.review_policy?.review_risk)) return payload.review_policy.review_risk;
    }
  }
  return fallback;
}

/** 供阶段确认和登记共用，避免任何调用者从 JSON/CLI 注入本轮 mode。 */
export function workflowRiskForState(events: Event[], state: State, fallback: ReviewRisk): ReviewRisk {
  switch (state) {
    case "propose_ready":
      return workflowRiskForProposeRound(events, fallback);
    case "apply":
    case "apply_done":
    case "review":
    case "accepted":
      return workflowRiskForApplyRound(events, fallback);
    default:
      return fallback;
  }
}

/**
 * 读取项目默认模式。缺少配置或缺少 workflow.mode 时使用 normal。
 * 配置格式：{ "workflow": { "mode": "normal" } }
 */
export function workflowRiskForProject(projectRoot: string): ReviewRisk {
  const workflow = workflowObject(readWorkflowConfigObject(projectRoot));
  if (!workflow) return DEFAULT_WORKFLOW_RISK;
  const mode = workflow.mode;
  if (mode === undefined) return DEFAULT_WORKFLOW_RISK;
  if (!isReviewRisk(mode)) {
    throw new WorkflowConfigError(`${WORKFLOW_CONFIG_PATH} 的 workflow.mode 只能是 minimal、normal 或 strict`);
  }
  return mode;
}
