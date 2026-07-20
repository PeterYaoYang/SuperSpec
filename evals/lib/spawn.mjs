import { spawn } from "node:child_process";
import { appendFileSync, createWriteStream, mkdirSync, realpathSync } from "node:fs";
import { dirname } from "node:path";

function now() {
  return new Date().toISOString();
}

function appendJsonl(file, value) {
  mkdirSync(dirname(file), { recursive: true });
  appendFileSync(file, `${JSON.stringify(value)}\n`, { encoding: "utf8", mode: 0o600 });
}

/**
 * The only subprocess entry point used by the probe. Commands are never run
 * through a shell. Every invocation is recorded before it starts and after it
 * exits so command provenance can be audited independently of Worker JSONL.
 */
export function createDirectorSpawner(actionLog) {
  let sequence = 0;
  const active = new Set();

  const killProcessTree = (child, signal) => {
    if (!child?.pid) return;
    if (process.platform !== "win32") {
      try { process.kill(-child.pid, signal); return; } catch {}
    }
    try { child.kill(signal); } catch {}
  };

  const executableIdentity = executable => {
    try { return realpathSync(executable); } catch { return null; }
  };

  async function runDirector(executable, args = [], options = {}) {
    const id = `director-${++sequence}`;
    const startedAt = now();
    const action = {
      schema_version: 1,
      id,
      phase: options.phase ?? "unspecified",
      actor: options.actor ?? "director",
      action_kind: options.actionKind ?? "subprocess",
      executable,
      executable_realpath: executableIdentity(executable),
      argv: [executable, ...args],
      cwd: options.cwd ?? process.cwd(),
      started_at: startedAt,
    };
    appendJsonl(actionLog, { ...action, event: "started" });

    return await new Promise((resolve, reject) => {
      const stdoutChunks = [];
      const stderrChunks = [];
      const stdoutFile = options.stdoutPath ? createWriteStream(options.stdoutPath, { mode: 0o600 }) : null;
      const stderrFile = options.stderrPath ? createWriteStream(options.stderrPath, { mode: 0o600 }) : null;
      let settled = false;

      const closeFiles = callback => {
        const files = [stdoutFile, stderrFile].filter(Boolean);
        if (files.length === 0) return callback();
        let pending = files.length;
        for (const file of files) file.end(() => {
          pending--;
          if (pending === 0) callback();
        });
      };

      const child = spawn(executable, args, {
        cwd: options.cwd,
        env: options.env,
        stdio: [options.stdin == null ? "ignore" : "pipe", "pipe", "pipe"],
        shell: false,
        detached: process.platform !== "win32",
      });
      active.add(child);
      const timeoutMs = options.timeoutMs ?? 120_000;
      const killGraceMs = options.killGraceMs ?? 2_000;
      let timedOut = false;
      let killTimer = null;
      const timeout = timeoutMs > 0 ? setTimeout(() => {
        timedOut = true;
        killProcessTree(child, "SIGTERM");
        killTimer = setTimeout(() => killProcessTree(child, "SIGKILL"), killGraceMs);
      }, timeoutMs) : null;

      if (options.stdin != null) {
        child.stdin.end(options.stdin);
      }
      child.stdout.on("data", chunk => {
        stdoutChunks.push(chunk);
        stdoutFile?.write(chunk);
      });
      child.stderr.on("data", chunk => {
        stderrChunks.push(chunk);
        stderrFile?.write(chunk);
      });

      child.on("error", error => {
        if (settled) return;
        settled = true;
        active.delete(child);
        if (timeout) clearTimeout(timeout);
        if (killTimer) clearTimeout(killTimer);
        const completed = {
          ...action,
          event: "completed",
          ended_at: now(),
          exit_code: null,
          signal: null,
          spawn_error: error.message,
          timed_out: timedOut,
        };
        appendJsonl(actionLog, completed);
        const wrapped = new Error(`failed to spawn ${executable}: ${error.message}`);
        wrapped.cause = error;
        wrapped.result = completed;
        closeFiles(() => reject(wrapped));
      });

      child.on("close", (code, signal) => {
        if (settled) return;
        settled = true;
        active.delete(child);
        if (timeout) clearTimeout(timeout);
        if (killTimer) clearTimeout(killTimer);
        const stdout = Buffer.concat(stdoutChunks).toString("utf8");
        const stderr = Buffer.concat(stderrChunks).toString("utf8");
        const completed = {
          ...action,
          event: "completed",
          ended_at: now(),
          exit_code: code,
          signal,
          timed_out: timedOut,
          stdout_bytes: Buffer.byteLength(stdout),
          stderr_bytes: Buffer.byteLength(stderr),
        };
        appendJsonl(actionLog, completed);
        closeFiles(() => resolve({ code, signal, stdout, stderr, timedOut, action: completed }));
      });
    });
  }

  runDirector.recordMutation = (phase, target, detail = {}) => {
    const timestamp = now();
    appendJsonl(actionLog, {
      schema_version: 1,
      id: `director-${++sequence}`,
      event: "completed",
      phase,
      actor: "director",
      action_kind: "injected_mutation",
      target,
      detail,
      started_at: timestamp,
      ended_at: timestamp,
      exit_code: 0,
      signal: null,
    });
  };
  runDirector.terminateAll = signal => {
    for (const child of active) killProcessTree(child, signal ?? "SIGTERM");
  };
  return runDirector;
}
