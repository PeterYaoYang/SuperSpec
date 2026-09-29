/**
 * Shared judge runtime: process spawn, JSON extraction, and failure detail.
 * Host-specific launch argv and isolation stay in each judge adapter.
 */

import { spawn } from "node:child_process";
import { existsSync, rmSync } from "node:fs";
import { join } from "node:path";
import { eventsOfKind, traceAgentMessages, traceThreadIds } from "../lib/trace.mjs";

export const JUDGE_TIMEOUT_MS = 600_000;

export function killProcessTree(child, signal) {
  if (!child?.pid) return;
  if (process.platform !== "win32") {
    try { process.kill(-child.pid, signal); return; } catch {}
  }
  try { child.kill(signal); } catch {}
}

export function commandOnPath(name) {
  for (const dir of (process.env.PATH ?? "").split(process.platform === "win32" ? ";" : ":")) {
    const candidate = join(dir, name);
    if (existsSync(candidate)) return candidate;
  }
  return null;
}

export function removeDirs(dirs, registry) {
  for (const dir of dirs) {
    rmSync(dir, { recursive: true, force: true });
    registry?.forget(dir);
  }
}

export function lastAgentMessageJson(trace, failureMessage) {
  const text = traceAgentMessages(trace).at(-1) ?? "";
  const candidates = [text, text.match(/```(?:json)?\s*([\s\S]*?)```/i)?.[1], text.slice(text.indexOf("{"), text.lastIndexOf("}") + 1)].filter(Boolean);
  for (const candidate of candidates) {
    try { return JSON.parse(candidate.trim()); } catch {}
  }
  throw new Error(failureMessage);
}

export function spawnJudge(executable, args, { cwd, env, prompt, active, timeoutMs = JUDGE_TIMEOUT_MS }) {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(executable, args, {
      cwd,
      env,
      shell: false,
      detached: process.platform !== "win32",
      stdio: ["pipe", "pipe", "pipe"],
    });
    active.add(child);
    const stdout = [];
    const stderr = [];
    let killTimer = null;
    let timedOut = false;
    const timeout = setTimeout(() => {
      timedOut = true;
      killProcessTree(child, "SIGTERM");
      killTimer = setTimeout(() => killProcessTree(child, "SIGKILL"), 2_000);
    }, timeoutMs);
    child.stdout.on("data", chunk => stdout.push(chunk));
    child.stderr.on("data", chunk => stderr.push(chunk));
    child.stdin.end(prompt);
    child.on("error", reject);
    child.on("close", code => {
      clearTimeout(timeout);
      if (killTimer) clearTimeout(killTimer);
      active.delete(child);
      resolvePromise({ code, timedOut, stdout: Buffer.concat(stdout).toString("utf8"), stderr: Buffer.concat(stderr).toString("utf8") });
    });
  });
}

export function judgeSessionIds(parseTrace) {
  return function sessionIds(tracePath) {
    return traceThreadIds(parseTrace(tracePath));
  };
}

export function judgeFailureDetail(parseTrace) {
  return function failureDetail(tracePath, error) {
    let detail = error instanceof Error ? error.message.split("\n")[0] : String(error);
    for (const event of eventsOfKind(parseTrace(tracePath), "error")) {
      if (typeof event.message === "string") detail = event.message;
    }
    return detail;
  };
}

/**
 * Provider 流挂起时 judge 进程会被超时终止，部分宿主收到 SIGTERM 后仍以 0 退出、trace 里只有开始事件；
 * 不能再把它当成“答复格式不对”，否则失败原因会指向模型输出而不是 Provider。
 */
export function judgeTimeoutError(label, timeoutMs = JUDGE_TIMEOUT_MS) {
  const error = new Error(`${label} timed out after ${timeoutMs} ms without completing a reply`);
  error.name = "JudgeTimeoutError";
  return error;
}

export function isTransientJudgeFailure(stdout, stderr) {
  return /stream disconnected|stream closed before response\.completed|timed out|overloaded|rate.?limit/iu.test(`${stderr}\n${stdout}`);
}
