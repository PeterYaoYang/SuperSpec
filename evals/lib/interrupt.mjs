/**
 * Interrupt and temp-dir safety shared by evaluator entry points.
 *
 * Isolated HOME / host-home directories may hold credential copies, so they
 * are registered the moment they are created and removed on every exit path:
 * normal completion, the first interrupt (graceful unwind), a repeated
 * interrupt (forced exit) and process `exit`. Stale directories left by a
 * process that died without running any of these paths (SIGKILL, crash) are
 * swept at the next start.
 */

import { lstatSync, readdirSync, rmSync } from "node:fs";
import { constants, tmpdir } from "node:os";
import { join } from "node:path";

export const INTERRUPT_SIGNALS = Object.freeze(["SIGINT", "SIGTERM", "SIGHUP"]);
const DAY_MS = 24 * 60 * 60 * 1000;
const DEAD_OWNER_MIN_AGE_MS = 60 * 1000;

/** Conventional shell exit status for termination by `signal` (130 for SIGINT, 143 for SIGTERM). */
export function signalExitCode(signal) {
  const number = constants.signals[signal];
  return Number.isInteger(number) ? 128 + number : 1;
}

/**
 * Tracks directories that must never outlive the process.
 * `removeAll` never throws; it returns the paths it could not remove.
 */
export function createTempDirRegistry() {
  const dirs = new Set();
  const removeAll = () => {
    const failures = [];
    for (const dir of [...dirs]) {
      try {
        rmSync(dir, { recursive: true, force: true });
        dirs.delete(dir);
      } catch (error) {
        failures.push({ path: dir, error: error instanceof Error ? error.message : String(error) });
      }
    }
    return failures;
  };
  const onExit = () => { removeAll(); };
  process.on("exit", onExit);
  return {
    track(path) {
      dirs.add(path);
      return path;
    },
    forget(path) {
      dirs.delete(path);
    },
    removeAll,
    tracked() {
      return [...dirs];
    },
    dispose() {
      process.removeListener("exit", onExit);
    },
  };
}

/**
 * Installs interrupt handlers. The first signal records the interruption and
 * calls `onInterrupt` so the caller can stop children and unwind normally.
 * A repeated signal calls `onForcedExit` (must be synchronous) and exits with
 * the status of the first signal.
 */
export function createInterruptController({ signals = INTERRUPT_SIGNALS, onInterrupt, onForcedExit } = {}) {
  const state = { signal: null, at: null, count: 0 };
  const handle = signal => {
    state.count++;
    if (state.count === 1) {
      state.signal = signal;
      state.at = new Date().toISOString();
      onInterrupt?.(signal);
      return;
    }
    try { onForcedExit?.(state.signal, signal); } finally {
      process.exit(signalExitCode(state.signal));
    }
  };
  const listeners = signals.map(signal => {
    const listener = () => handle(signal);
    process.on(signal, listener);
    return [signal, listener];
  });
  return {
    get interrupted() {
      return state.signal != null;
    },
    get signal() {
      return state.signal;
    },
    get at() {
      return state.at;
    },
    exitCode() {
      return signalExitCode(state.signal);
    },
    dispose() {
      for (const [signal, listener] of listeners) process.removeListener(signal, listener);
    },
  };
}

export function processAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error?.code === "EPERM";
  }
}

/**
 * Removes stale evaluator temp dirs from `root`.
 *
 * A rule names a prefix and a regex whose first group is the owning pid (the
 * pid is embedded by the run-id scheme that created the directory). A
 * directory is removed only when it is a real directory owned by this user and
 * either its owner pid is no longer alive (and it is older than a minute), or
 * — when no pid can be derived and the rule allows it — it is older than a
 * day. Live owners and young unparsable names are always kept.
 */
export function sweepStaleTempDirs({ rules, root = tmpdir(), now = Date.now(), isAlive = processAlive, maxUnownedAgeMs = DAY_MS } = {}) {
  const result = { root, removed: [], kept_live_owner: 0, kept_unowned_recent: 0, failures: [] };
  let names;
  try { names = readdirSync(root); } catch { return result; }
  const uid = typeof process.getuid === "function" ? process.getuid() : null;
  for (const name of names.sort()) {
    const rule = rules.find(candidate => name.startsWith(candidate.prefix));
    if (!rule) continue;
    const path = join(root, name);
    let stat;
    try { stat = lstatSync(path); } catch { continue; }
    if (!stat.isDirectory() || stat.isSymbolicLink() || (uid != null && stat.uid !== uid)) continue;
    const age = now - stat.mtimeMs;
    const pid = Number(rule.pid.exec(name)?.[1] ?? NaN);
    let stale;
    if (Number.isInteger(pid) && pid > 0) {
      if (pid === process.pid || isAlive(pid)) {
        result.kept_live_owner++;
        continue;
      }
      stale = age >= DEAD_OWNER_MIN_AGE_MS;
    } else {
      stale = rule.requirePid !== true && age >= maxUnownedAgeMs;
      if (!stale) result.kept_unowned_recent++;
    }
    if (!stale) continue;
    try {
      rmSync(path, { recursive: true, force: true });
      result.removed.push(name);
    } catch (error) {
      result.failures.push({ name, error: error instanceof Error ? error.message : String(error) });
    }
  }
  return result;
}
