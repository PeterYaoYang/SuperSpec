import type { Event } from "./types.ts";

/**
 * 当前 Explore 轮次的稳定标识。
 *
 * 同一轮内补充调查或创建审查工作项不会使当前确认事项失效；只有首次进入
 * Explore 或从后续阶段重新打开 Explore 时，才开始新的确认轮次。
 */
export function currentExploreRoundId(events: readonly Event[]): string {
  for (let index = events.length - 1; index >= 0; index--) {
    const event = events[index];
    if (event.event_type !== "transition_commit") continue;
    const payload = event.payload as {
      transition?: unknown;
      from_state?: unknown;
      to_state?: unknown;
      reopen_target?: unknown;
    };
    const enteredInitially = payload.transition === "explore" &&
      payload.from_state === "init" &&
      payload.to_state === "explore";
    const reopened = payload.transition === "reopen" && payload.reopen_target === "explore";
    if (enteredInitially || reopened) return event.event_id;
  }
  // 兼容升级前已处于 Explore 的历史 change；下一次重新进入时会使用真实轮次。
  return "legacy-explore-round";
}
