#!/usr/bin/env node

/**
 * Unit-style interrupt contract check. Spawns a long-lived child, sends
 * SIGTERM to this process, and asserts isolated temp dirs are removed and
 * capability.json is written INVALID without an evidence seal. No model calls.
 */

import { spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { createInterruptController, createTempDirRegistry, signalExitCode } from "./lib/interrupt.mjs";

const CORE_GATES = ["process", "controlled_environment", "authenticity", "scope", "artifact", "state", "stop_boundary"];

function writeJson(path, value) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`);
}

function emptyCapability() {
  return {
    schema_version: 1,
    scenario_id: "interrupt-self-test",
    scenario_result: "INVALID",
    capability_verdict: "NO_GO",
    exit_code: 3,
    gates: Object.fromEntries(CORE_GATES.map(name => [name, { status: "unavailable", evidence: [] }])),
    limitations: [],
  };
}

const runRoot = process.argv[2] ?? mkdtempSync(join(tmpdir(), "superspec-interrupt-case-"));
mkdirSync(runRoot, { recursive: true });
const capabilityPath = join(runRoot, "capability.json");
const manifestPath = join(runRoot, "manifest.json");
const trackedPath = join(runRoot, "tracked-dirs.json");
const tempDirs = createTempDirRegistry();
const home = tempDirs.track(mkdtempSync(join(tmpdir(), "superspec-probe-home-interrupt-")));
const hostHome = tempDirs.track(mkdtempSync(join(tmpdir(), "superspec-probe-codex-interrupt-")));
writeJson(trackedPath, [home, hostHome]);

const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], {
  stdio: "ignore",
  detached: process.platform !== "win32",
});

const interrupt = createInterruptController({
  onInterrupt() {
    if (child.pid && process.platform !== "win32") {
      try { process.kill(-child.pid, "SIGTERM"); } catch { try { child.kill("SIGTERM"); } catch {} }
    } else {
      try { child.kill("SIGTERM"); } catch {}
    }
  },
  onForcedExit(firstSignal) {
    if (child.pid && process.platform !== "win32") {
      try { process.kill(-child.pid, "SIGKILL"); } catch { try { child.kill("SIGKILL"); } catch {} }
    } else {
      try { child.kill("SIGKILL"); } catch {}
    }
    tempDirs.removeAll();
    const capability = emptyCapability();
    capability.interrupted = { signal: firstSignal, at: interrupt.at };
    capability.limitations.push(`probe was interrupted by ${firstSignal}; evidence was never sealed`);
    writeJson(capabilityPath, capability);
    if (!existsSync(manifestPath)) {
      writeJson(manifestPath, { schema_version: 1, interrupted: capability.interrupted });
    }
  },
});

try {
  setTimeout(() => process.kill(process.pid, "SIGTERM"), 50);
  await new Promise((_, reject) => {
    setTimeout(() => reject(new Error("interrupt self-test timed out waiting for SIGTERM")), 5_000);
  });
} catch (error) {
  if (!interrupt.interrupted) throw error;
} finally {
  interrupt.dispose();
  if (child.pid && process.platform !== "win32") {
    try { process.kill(-child.pid, "SIGKILL"); } catch { try { child.kill("SIGKILL"); } catch {} }
  } else {
    try { child.kill("SIGKILL"); } catch {}
  }
  tempDirs.removeAll();
  tempDirs.dispose();
  const capability = emptyCapability();
  capability.interrupted = { signal: interrupt.signal, at: interrupt.at };
  capability.limitations.push(`probe received ${interrupt.signal}`);
  writeJson(capabilityPath, capability);
  if (!existsSync(manifestPath)) {
    writeJson(manifestPath, { schema_version: 1, interrupted: capability.interrupted });
  }
}

process.exitCode = interrupt.interrupted ? signalExitCode(interrupt.signal) : 1;
