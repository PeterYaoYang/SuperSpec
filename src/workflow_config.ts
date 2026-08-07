// SuperSpec 项目级工作流配置。所有阶段从同一位置解析默认 mode，
// 避免 CLI、Explore、Propose、Review 各自保留不同默认值。

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { ReviewRisk } from "./review.ts";
import type { Event, State } from "./types.ts";

export const WORKFLOW_CONFIG_PATH = ".superspec/config.json";
/** 项目未声明 workflow.mode 时采用的默认档位。 */
export const DEFAULT_WORKFLOW_RISK: ReviewRisk = "normal";

export class WorkflowConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "WorkflowConfigError";
  }
}

function isReviewRisk(value: unknown): value is ReviewRisk {
  return value === "minimal" || value === "normal" || value === "strict";
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
  const configPath = join(projectRoot, WORKFLOW_CONFIG_PATH);
  if (!existsSync(configPath)) return DEFAULT_WORKFLOW_RISK;

  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(configPath, "utf8"));
  } catch {
    throw new WorkflowConfigError(`${WORKFLOW_CONFIG_PATH} 必须是有效 JSON`);
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new WorkflowConfigError(`${WORKFLOW_CONFIG_PATH} 顶层必须是 JSON object`);
  }
  const workflow = (parsed as { workflow?: unknown }).workflow;
  if (workflow === undefined) return DEFAULT_WORKFLOW_RISK;
  if (!workflow || typeof workflow !== "object" || Array.isArray(workflow)) {
    throw new WorkflowConfigError(`${WORKFLOW_CONFIG_PATH} 的 workflow 必须是 object`);
  }
  const mode = (workflow as { mode?: unknown }).mode;
  if (mode === undefined) return DEFAULT_WORKFLOW_RISK;
  if (!isReviewRisk(mode)) {
    throw new WorkflowConfigError(`${WORKFLOW_CONFIG_PATH} 的 workflow.mode 只能是 minimal、normal 或 strict`);
  }
  return mode;
}
