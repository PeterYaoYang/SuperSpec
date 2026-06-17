// SuperSpec 流程引擎 — skill-loop：薄适配循环驱动

/**
 * skillLoop 是 agent 适配层的核心函数。
 * 它不是 CLI 命令（实际 agent 循环由 LLM 驱动），
 * 而是一个可测试的逻辑函数，验证 next→execute→record 循环的正确性。
 */

import { next } from "./next.ts";
import type { NextOutput } from "./types.ts";

export interface LoopStep {
  step: number;
  state: string;
  path: string;
  action: string;
  detail?: string;
}

export interface LoopResult {
  completed: boolean;
  steps: LoopStep[];
  finalState: string;
  message: string;
}

/**
 * 执行 agent 循环逻辑（不实际执行命令，只模拟状态推进）。
 * 用于测试 next 返回值链是否自洽。
 *
 * @param nextFn next 函数（可 mock）
 * @param executeFn 命令执行函数（可 mock，返回是否成功）
 * @param maxSteps 防无限循环
 */
export function simulateLoop(
  nextFn: () => NextOutput,
  executeFn: (output: NextOutput) => boolean,
  maxSteps: number = 20,
): LoopResult {
  const steps: LoopStep[] = [];
  let completed = false;

  for (let i = 0; i < maxSteps; i++) {
    const output = nextFn();
    const step: LoopStep = {
      step: i + 1,
      state: output.state,
      path: output.path,
      action: "",
    };

    switch (output.path) {
      case "done":
        step.action = "stop";
        step.detail = output.reason;
        steps.push(step);
        completed = true;
        return { completed, steps, finalState: output.state, message: output.reason };

      case "next_command":
        step.action = "execute";
        step.detail = output.next_command;
        steps.push(step);
        if (!executeFn(output)) {
          return { completed: false, steps, finalState: output.state, message: `执行失败：${output.next_command}` };
        }
        break;

      case "required_job":
        step.action = "job";
        step.detail = output.required_jobs.map(j => `${j.role}(${j.job_id})`).join(", ");
        steps.push(step);
        if (!executeFn(output)) {
          return { completed: false, steps, finalState: output.state, message: `工作项执行失败` };
        }
        break;

      case "ask_user":
        step.action = "ask";
        step.detail = output.ask_user.question;
        steps.push(step);
        return { completed: false, steps, finalState: output.state, message: `需要用户确认：${output.ask_user.question}` };
    }
  }

  return { completed: false, steps, finalState: steps[steps.length - 1]?.state ?? "unknown", message: "达到最大步数" };
}
