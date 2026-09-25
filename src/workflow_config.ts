// SuperSpec 工作流配置与 change 级模式解析。
// 新 change 使用事件中的选择及轮次冻结值；项目 mode 仅为历史 change 提供回退。

import { existsSync, readFileSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { ReviewRisk } from "./review.ts";
import type { Event, State, WorkflowModeSelection, WorkflowModeStatus, WorkflowModeSelectionAction } from "./types.ts";

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
export const WORKFLOW_HOSTS = ["codex", "omp", "claude"] as const;
export type WorkflowHost = (typeof WORKFLOW_HOSTS)[number];
/** 未声明 hosts 的旧项目按 Codex 入口处理。 */
export const DEFAULT_WORKFLOW_HOSTS: WorkflowHost[] = ["codex"];
const WORKFLOW_HOST_ALIASES: Record<string, WorkflowHost> = { "claude-code": "claude" };

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
  return typeof value === "string" && (WORKFLOW_HOSTS as readonly string[]).includes(value);
}

export function normalizeWorkflowHosts(values: readonly string[]): WorkflowHost[] {
  const hosts = [...new Set(values.filter(isWorkflowHost))];
  hosts.sort((left, right) => WORKFLOW_HOSTS.indexOf(left) - WORKFLOW_HOSTS.indexOf(right));
  return hosts;
}

export function parseWorkflowHostsFlag(raw: string): WorkflowHost[] {
  const tokens = raw.toLowerCase().split(/[,\s]+/).filter(Boolean);
  const hosts = normalizeWorkflowHosts(tokens.map(token => WORKFLOW_HOST_ALIASES[token] ?? token));
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

/** Claude Code 项目权限默认开启；只有用户显式关闭时配置中才记录 false。 */
export function workflowClaudePermissionsForProject(projectRoot: string): boolean {
  const value = workflowObject(readWorkflowConfigObject(projectRoot))?.claude_permissions;
  if (value === undefined) return true;
  if (typeof value !== "boolean") {
    throw new WorkflowConfigError(`${WORKFLOW_CONFIG_PATH} 的 workflow.claude_permissions 必须是 boolean`);
  }
  return value;
}

/** claudePermissions 仅在用户显式选择时传入；未传入时保留项目已有选择。 */
export function persistWorkflowHosts(projectRoot: string, hosts: WorkflowHost[], claudePermissions?: boolean): string {
  const configPath = join(projectRoot, WORKFLOW_CONFIG_PATH);
  mkdirSync(dirname(configPath), { recursive: true });
  const parsed = readWorkflowConfigObject(projectRoot) ?? {};
  const workflow = workflowObject(parsed) ?? {};
  if (workflow.mode === undefined) workflow.mode = DEFAULT_WORKFLOW_RISK;
  workflow.hosts = normalizeWorkflowHosts(hosts);
  if (claudePermissions === false) workflow.claude_permissions = false;
  else if (claudePermissions === true) delete workflow.claude_permissions;
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

export function latestWorkflowModeSelection(events: readonly Event[]): WorkflowModeSelection | null {
  const event = events.findLast(event => event.event_type === "workflow_mode_selected");
  if (!event) return null;
  const { mode, source, reason, user_request } = event.payload;
  if ((mode !== "minimal" && mode !== "normal") || (source !== "agent" && source !== "user") || typeof reason !== "string") {
    throw new WorkflowConfigError("change 的模式选择记录无效");
  }
  return { mode, source, reason, ...(typeof user_request === "string" ? { user_request } : {}) };
}

export function changeUsesWorkflowModeSelection(events: readonly Event[]): boolean {
  return !events.some(event => event.event_type === "transition_commit") || events.some(event =>
    event.event_type === "workflow_mode_selected" ||
    (event.event_type === "transition_commit" && event.payload.workflow_mode_version === 1)
  );
}

/**
 * reopen --upgrade-mode 之后等待登记 normal。normal 选择或用户本人的选择都算已决定：
 * 用户明确维持 minimal 是受限升级允许的结论，不是可以无限绕过的缺口。
 */
export function workflowModeUpgradePending(events: readonly Event[]): boolean {
  const upgradeIndex = events.findLastIndex(event =>
    event.event_type === "transition_commit" &&
    event.payload.to_state === "explore" &&
    event.payload.workflow_mode_upgrade_target === "normal",
  );
  if (upgradeIndex < 0) return false;
  const selectionIndex = events.findLastIndex(event => event.event_type === "workflow_mode_selected");
  if (selectionIndex <= upgradeIndex) return true;
  const selection = latestWorkflowModeSelection(events);
  return selection?.mode !== "normal" && selection?.source !== "user";
}

export function requiresWorkflowModeSelection(events: readonly Event[]): boolean {
  return changeUsesWorkflowModeSelection(events) && (
    latestWorkflowModeSelection(events) === null || workflowModeUpgradePending(events)
  );
}

/** mode_selection_required 的 reason：新 change 首次选档与升级等待两种口径。 */
export function workflowModeSelectionReason(events: readonly Event[]): string {
  return workflowModeUpgradePending(events)
    ? "已请求升级到 normal，等待登记 normal 或由用户维持 minimal"
    : "需要根据初步调查选择当前 change 的模式";
}

function startedModeDependentWork(event: Event): boolean {
  if (event.event_type !== "transition_commit") return false;
  const jobs = event.payload.new_jobs;
  return (Array.isArray(jobs) && jobs.length > 0) ||
    ["propose", "propose_ready", "apply", "apply_done", "review", "accepted"].includes(String(event.payload.to_state));
}

/** 回到 Explore 允许升级，但不清除用于阻止降档的历史。 */
function modeSelectionFrozen(events: readonly Event[], state: State): boolean {
  if (state !== "init" && state !== "explore") return true;
  const roundStart = events.findLastIndex(event => event.event_type === "transition_commit" &&
    event.payload.to_state === "explore" && event.payload.from_state !== "explore");
  return events.some((event, index) => index > roundStart && startedModeDependentWork(event));
}

export function workflowModeSelectionError(
  events: Event[], state: State, selection: WorkflowModeSelection,
): string | null {
  const previous = latestWorkflowModeSelection(events);
  if (!changeUsesWorkflowModeSelection(events)) {
    return "历史 change 没有 change 级选档协议，继续沿用原模式与冻结记录";
  }
  if (modeSelectionFrozen(events, state)) {
    return "当前轮次模式已冻结；需要升级时请先 reopen --to explore，补齐探索与计划审查";
  }
  if (workflowModeUpgradePending(events) && selection.mode !== "normal" && selection.source === "agent") {
    return previous?.source === "user"
      ? "本 change 已请求升级到 normal；此前选档由用户决定，请由用户确认升级或明确维持 minimal"
      : "本 change 已请求升级到 normal，不能由 agent 就地维持 minimal；用户明确维持 minimal 时请用 source=user 登记用户原话";
  }
  if (previous?.source === "user" && selection.source === "agent") {
    return "已有用户明确选择，不能由 agent 覆盖；请说明新事实并取得用户明确选择";
  }
  if (previous?.mode === "normal" && selection.mode === "minimal" && events.some(startedModeDependentWork)) {
    return "change 已按 normal 进入审查或计划，不能降档绕过已有审查；reopen 不清除该约束";
  }
  return null;
}

export function workflowModeSelectionAction(change: string, upgradePending = false): WorkflowModeSelectionAction {
  if (upgradePending) {
    return {
      allowed_modes: ["minimal", "normal"],
      record_argv: ["superspec", "record", "workflow-mode", "--change", change, "--input", "-"],
      record_input: { mode: "normal", source: "agent", reason: null },
      user_record_input: { mode: null, source: "user", reason: null, user_request: null },
      instruction: "本 change 已请求升级到 normal：agent 提交 normal；选档来自用户时由用户用 user_record_input 决定，用户否决升级则按原话登记并维持 minimal。",
    };
  }
  return {
    allowed_modes: ["minimal", "normal"],
    record_argv: ["superspec", "record", "workflow-mode", "--change", change, "--input", "-"],
    record_input: { mode: null, source: "agent", reason: null },
    user_record_input: { mode: null, source: "user", reason: null, user_request: null },
    instruction: "用户明确指定优先：使用 user_record_input 并原样填写真实 user_request；否则使用 record_input，根据已有初步调查选择 minimal 或 normal 并简短告知，不新增评估角色或默认问答。两档的差别只是 normal 在 Explore 和 Propose 各多一道独立 critic 审查，并启用计划规模与修复轮次上限；discovery、测试契约、代码审查和最终验证两档相同。涉及需要用户拍板的业务口径或关键取舍，或会改变对外契约、兼容性时选 normal；否则选 minimal，受影响的调用方、文件或方法数量本身不是选 normal 的依据。minimal 之后出现推翻依据的新事实时可以 reopen 回 Explore 升级到 normal；normal 进入计划或审查后不能降档。reason 说明实际依据。",
  };
}

export function workflowModeStatus(
  events: Event[], state: State, fallback: ReviewRisk = DEFAULT_WORKFLOW_RISK, change?: string,
): WorkflowModeStatus {
  const selection = latestWorkflowModeSelection(events);
  if (requiresWorkflowModeSelection(events) && selection === null) {
    return { workflow_mode: null, mode_source: "unselected", mode_reason: workflowModeSelectionReason(events), mode_frozen: false };
  }
  const upgradePending = workflowModeUpgradePending(events);
  const workflowMode = workflowRiskForState(events, state, selection?.mode ?? fallback);
  const frozen = modeSelectionFrozen(events, state);
  const canReopenExplore = ["propose", "propose_ready", "apply", "apply_done", "review", "accepted"].includes(state);
  return {
    workflow_mode: workflowMode,
    mode_source: selection?.source ?? "legacy",
    mode_reason: selection?.reason ?? "沿用历史轮次冻结值或项目模式",
    mode_frozen: frozen,
    ...(upgradePending ? { mode_upgrade_pending: true as const } : {}),
    ...(change && selection?.mode === "minimal" && frozen && canReopenExplore ? {
      mode_upgrade: {
        target_mode: "normal",
        reopen_argv: ["superspec", "transition", "reopen", "--change", change, "--to", "explore", "--upgrade-mode", "normal", "--reason", "发现新事实，minimal 不再适用，需要补齐 normal 审查"],
        instruction: "只有新事实推翻 minimal 依据时使用，不用于绕过当前问题；回到 Explore 后按 next 返回的选档动作登记 normal。",
      },
    } : {}),
  };
}

/** 已选档 change 不读可变项目档位；legacy change 保留原有回退。 */
export function workflowRiskForChange(projectRoot: string, events: Event[], state: State, fallback?: ReviewRisk): ReviewRisk {
  const candidate = changeUsesWorkflowModeSelection(events)
    ? latestWorkflowModeSelection(events)?.mode ?? DEFAULT_WORKFLOW_RISK
    : fallback ?? workflowRiskForProject(projectRoot);
  return workflowRiskForState(events, state, candidate);
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
  fallback = latestWorkflowModeSelection(events)?.mode ?? fallback;
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
