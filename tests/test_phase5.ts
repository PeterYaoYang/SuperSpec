// SuperSpec 流程引擎 — Phase 5 测试：skill-loop 适配循环

import test from "node:test";
import assert from "node:assert/strict";
import { simulateLoop } from "../src/skill_loop.ts";
import type { NextOutput } from "../src/types.ts";

test("simulateLoop：done 路径立即停止", () => {
  const result = simulateLoop(
    () => ({ state: "archive", path: "done", reason: "已完成" }) as NextOutput,
    () => true,
  );
  assert.equal(result.completed, true);
  assert.equal(result.steps.length, 1);
  assert.equal(result.finalState, "archive");
});

test("simulateLoop：next_command → done 两步完成", () => {
  let callCount = 0;
  const outputs: NextOutput[] = [
    { state: "accepted", path: "next_command", next_command: "superspec transition archive", reason: "归档", missing_inputs: [] },
    { state: "archive", path: "done", reason: "已完成" },
  ];
  const result = simulateLoop(
    () => outputs[callCount++],
    () => true,
  );
  assert.equal(result.completed, true);
  assert.equal(result.steps.length, 2);
  assert.equal(result.steps[0].action, "execute");
  assert.equal(result.steps[1].action, "stop");
});

test("simulateLoop：required_job → next_command → done", () => {
  let callCount = 0;
  const outputs: NextOutput[] = [
    { state: "propose", path: "required_job", required_jobs: [{ job_id: "JOB-1", role: "proposal-auditor", packet_command: "superspec jobs packet" }], reason: "需要审查" },
    { state: "propose", path: "next_command", next_command: "superspec transition propose-ready", reason: "推进", missing_inputs: [] },
    { state: "propose_ready", path: "next_command", next_command: "superspec transition start-apply", reason: "执行", missing_inputs: [] },
    { state: "archive", path: "done", reason: "完成" },
  ];
  const result = simulateLoop(
    () => outputs[callCount++],
    () => true,
  );
  assert.equal(result.completed, true);
  assert.equal(result.steps.length, 4);
  assert.equal(result.steps[0].action, "job");
  assert.equal(result.steps[1].action, "execute");
});

test("simulateLoop：ask_user 暂停", () => {
  const result = simulateLoop(
    () => ({ state: "explore", path: "ask_user", ask_user: { question: "请确认", allowed_answers: ["yes"], scope: "explore" }, reason: "需确认" }) as NextOutput,
    () => true,
  );
  assert.equal(result.completed, false);
  assert.equal(result.steps.length, 1);
  assert.ok(result.message.includes("请确认"));
});

test("simulateLoop：execute 失败立即停止", () => {
  const result = simulateLoop(
    () => ({ state: "apply", path: "next_command", next_command: "superspec transition task-complete", reason: "完成", missing_inputs: [] }) as NextOutput,
    () => false,
  );
  assert.equal(result.completed, false);
  assert.ok(result.message.includes("失败"));
});

test("simulateLoop：达到 maxSteps 停止", () => {
  let count = 0;
  const result = simulateLoop(
    () => ({ state: "apply", path: "next_command", next_command: `cmd-${count++}`, reason: "循环", missing_inputs: [] }) as NextOutput,
    () => true,
    3,
  );
  assert.equal(result.completed, false);
  assert.equal(result.steps.length, 3);
  assert.ok(result.message.includes("最大步数"));
});
