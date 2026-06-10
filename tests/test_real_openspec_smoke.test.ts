// Opt-in real OpenSpec CLI smoke test (audit F-4, Phase 5 decision D5, 2026-06-10).
// The main suite stubs every `openspec` call and pins a single 1.4.1 golden fixture, so OpenSpec
// upgrades drift silently. This file is the drift detector: it scaffolds a throwaway project,
// drives the REAL CLI, and checks that guard's shape contract and end-to-end dispatch still hold.
// Run with: SUPERSPEC_REAL_OPENSPEC_SMOKE=1 npm test   (intended as an opt-in CI job)
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import test from "node:test";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import * as guard from "../superspec_guard.ts";

const OPT_IN = process.env.SUPERSPEC_REAL_OPENSPEC_SMOKE === "1";
const SKIP = OPT_IN ? false : "opt-in: set SUPERSPEC_REAL_OPENSPEC_SMOKE=1 to run against the real openspec CLI";
const GUARD_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const GUARD_TS = join(GUARD_ROOT, "superspec_guard.ts");
const CHANGE = "smoke-change";

function run(cmd: string, args: string[], cwd: string) {
  return spawnSync(cmd, args, { cwd, encoding: "utf8", timeout: 120_000 });
}

function scaffoldRealProject(): string {
  const repo = realpathSync(mkdtempSync(join(tmpdir(), "superspec-real-smoke-")));
  const git = run("git", ["init", "-q", "."], repo);
  assert.equal(git.status, 0, git.stderr);
  const init = run("openspec", ["init", "--tools", "none", "."], repo);
  assert.equal(init.status, 0, `openspec init failed:\n${init.stdout}${init.stderr}`);
  const changeRoot = join(repo, "openspec", "changes", CHANGE);
  mkdirSync(join(changeRoot, "specs", "smoke"), { recursive: true });
  writeFileSync(join(changeRoot, "proposal.md"), "# Proposal\n\n## Why\nSmoke.\n\n## What Changes\n- smoke\n", "utf8");
  writeFileSync(
    join(changeRoot, "specs", "smoke", "spec.md"),
    "## ADDED Requirements\n\n### Requirement: Smoke works\nThe system SHALL smoke.\n\n#### Scenario: Smoke passes\n- WHEN smoke\n- THEN pass\n",
    "utf8",
  );
  return repo;
}

test("real openspec CLI is installed when the smoke job is opted in", { skip: SKIP }, () => {
  // Opted-in means a CI job whose whole purpose is drift detection: a missing CLI must fail
  // loudly, never silently skip.
  const version = run("openspec", ["--version"], process.cwd());
  assert.equal(version.error, undefined, "openspec CLI not found on PATH");
  assert.equal(version.status, 0, version.stderr);
  assert.match(`${version.stdout}${version.stderr}`, /\d+\.\d+\.\d+/);
});

test("real openspec status output still satisfies guard's shape contract", { skip: SKIP }, () => {
  const repo = scaffoldRealProject();
  try {
    const proc = run("openspec", ["status", "--change", CHANGE, "--json"], repo);
    assert.equal(proc.status, 0, proc.stderr);
    const status = JSON.parse(proc.stdout);
    // The exact contract guard relies on for every judgement (R-3 drift detection).
    assert.deepEqual(guard.openspec_status_shape_reasons(status), []);
    const artifacts = guard.artifact_status_map(status);
    for (const id of ["proposal", "specs", "design", "tasks"]) {
      assert.ok(id in artifacts, `artifact ${id} missing from real status output`);
    }
    assert.equal(artifacts.proposal, "done");
    assert.equal(artifacts.specs, "done");
    assert.equal(artifacts.tasks, "blocked");
    assert.match(guard.status_fingerprint(status), /^sha256:[0-9a-f]{64}$/);
    assert.equal(realpathSync(guard.get_change_root(status)), join(repo, "openspec", "changes", CHANGE));
    assert.equal(realpathSync(guard.get_repo_root(status)), repo);
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});

test("real openspec validate passes on a minimal delta-bearing change", { skip: SKIP }, () => {
  const repo = scaffoldRealProject();
  try {
    const proc = run("openspec", ["validate", CHANGE], repo);
    assert.equal(proc.status, 0, `${proc.stdout}${proc.stderr}`);
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});

test("guard dispatch works end-to-end against the real CLI", { skip: SKIP }, () => {
  const repo = scaffoldRealProject();
  try {
    // status: allow, version echoed, lazy state not yet created.
    const status = run(process.execPath, [GUARD_TS, "status", "--change", CHANGE], repo);
    assert.equal(status.status, 0, status.stderr);
    const decision = JSON.parse(status.stdout);
    assert.equal(decision.allowed, true, JSON.stringify(decision.block_reasons));
    assert.match(String(decision.superspec_gate_summary.openspec_version), /^\d+\.\d+\.\d+$/);
    // check-enter on a bare change: guard must block on its own gate logic (missing discovery),
    // not fall over on real CLI output.
    const enter = run(process.execPath, [GUARD_TS, "check-enter", "--gate", "explore_complete", "--change", CHANGE], repo);
    assert.equal(enter.status, 1);
    const blocked = JSON.parse(enter.stdout);
    assert.equal(blocked.allowed, false);
    const blockedCodes = (blocked.block_reasons ?? []).map((item: any) => String(item.code));
    assert.ok(blockedCodes.includes("missing_discovery"), JSON.stringify(blockedCodes));
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});
