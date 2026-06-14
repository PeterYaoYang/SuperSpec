import { existsSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import type { Reason } from "../util.ts";
import { reason, sha256_file } from "../util.ts";
import { HOOK_ADAPTER_VERSION } from "./types.ts";

type HookEntry = {
  matcher?: unknown;
  hooks?: unknown;
};

type ExpectedHookEntry = {
  eventName: string;
  matcher: string;
  timeout: number;
  statusMessage: string;
};

const HOOK_COMMAND = 'superspec-hook --change "$SUPERSPEC_CHANGE"';

const EXPECTED_HOOK_MATRIX: ExpectedHookEntry[] = [
  {
    eventName: "SubagentStart",
    matcher: ".*",
    timeout: 120,
    statusMessage: "SuperSpec 子智能体启动记录",
  },
  {
    eventName: "SubagentStop",
    matcher: ".*",
    timeout: 120,
    statusMessage: "SuperSpec 子智能体停止记录",
  },
];

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function hasExactKeys(value: Record<string, unknown>, keys: string[]): boolean {
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  return actual.length === expected.length && actual.every((key, index) => key === expected[index]);
}

function hookEntryMatches(entry: HookEntry, expected: ExpectedHookEntry): boolean {
  if (entry.matcher !== expected.matcher) return false;
  if (!Array.isArray(entry.hooks) || entry.hooks.length !== 1) return false;
  const hook = entry.hooks[0];
  if (!isRecord(hook)) return false;
  if (!hasExactKeys(hook, ["type", "command", "timeout", "statusMessage"])) return false;
  return hook.type === "command"
    && hook.command === HOOK_COMMAND
    && hook.timeout === expected.timeout
    && hook.statusMessage === expected.statusMessage;
}

function hookMatrixPresent(parsed: any): boolean {
  const hooks = parsed?.hooks;
  if (!hooks || typeof hooks !== "object") return false;
  if (!isRecord(hooks)) return false;
  if (!hasExactKeys(hooks, EXPECTED_HOOK_MATRIX.map((entry) => entry.eventName))) return false;
  return EXPECTED_HOOK_MATRIX.every((expected) => {
    const entries = hooks[expected.eventName];
    return Array.isArray(entries)
      && entries.length === 1
      && hookEntryMatches(entries[0] as HookEntry, expected);
  });
}

export function hookManifestHash(repoRoot: string): string | null {
  const hookPath = join(repoRoot, ".codex", "hooks.json");
  if (!existsSync(hookPath) || !statSync(hookPath).isFile()) return null;
  return sha256_file(hookPath);
}

export function managedHooksManifestPresent(repoRoot: string): boolean {
  const hookPath = join(repoRoot, ".codex", "hooks.json");
  if (!existsSync(hookPath) || !statSync(hookPath).isFile()) return false;
  try {
    const parsed = JSON.parse(readFileSync(hookPath, "utf8"));
    return parsed?.superspec?.managed === true
      && parsed?.superspec?.adapter_version === HOOK_ADAPTER_VERSION
      && parsed?.superspec?.strict_profile_default === "audit-only-until-r1-provenance-passes"
      && hookMatrixPresent(parsed);
  } catch {
    return false;
  }
}

export function hookInitReasons(repoRoot: string): Reason[] {
  const hookPath = join(repoRoot, ".codex", "hooks.json");
  if (!existsSync(hookPath)) return [];
  if (managedHooksManifestPresent(repoRoot)) return [];
  return [reason("hook_manifest_unmanaged", ".codex/hooks.json exists but is not the SuperSpec-managed v2 hook manifest; strict profile must downgrade")];
}
