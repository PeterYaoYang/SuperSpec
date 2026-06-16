import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import test from "node:test";
import {
  copyFileSync,
  existsSync,
  linkSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { hostname, tmpdir } from "node:os";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import * as guard from "../superspec_guard.ts";
import { main_init } from "../src/init_cli.ts";
import { reason_message_zh, translate_action_zh } from "../src/i18n.ts";
import { project_init } from "../src/project_init.ts";
import {
  findRepoRoot,
  GUARD_ROOT,
  REPO_ROOT,
  GUARD_TS,
  GUARD_TS_URL,
  INIT_TS,
  mkdirp,
  writeText,
  readJson,
  materializeEvidenceRecord,
  codes,
  captureStdoutJson,
  captureStdoutText,
  captureMain,
  captureMainJson,
  assertSafeOutputHasNoLeaks,
  assertNoForbiddenAgentKeys,
  walkFiles,
  installOpenspecSkills,
  installSuperSpecAgents,
  createFixture,
  activeFixture,
  withFixture,
  withRuntime,
  waitForChild,
  waitForCondition,
  status,
  passEvidence,
  roleEvidence,
  reviewEvidence,
  reviewGuidanceEvidences,
  legacyCodeReviewWorkflowEvidence,
  mainAdjudication,
  verifyEvidence,
  DEFAULT_RUN_LOG,
  defaultRunLog,
  redEvidence,
  greenEvidence,
  taskReopenEvidence,
  taskReopenResolvedEvidence,
  supersededEvidence,
  alternativeVerificationEvidence,
  reopenBlockingFinding,
  finalTestEvidence,
  archiveReadyEvidences,
  reopenGuidanceEvidences,
  taskReopenReadyEvidences,
  businessInvariantsText,
  testContractText,
  testContractRowsText,
  invariantMatrixText,
  proposalReviewedEvidences,
  prepareProposeComplete,
  setTaskCheckbox,
  EXPLORE_ONLY_STATUS,
  DISCOVERY_REL,
  writeDiscovery,
  discoveryBlob,
  exploreCheck,
  exploreConfirmedEvidences,
  discSchemaCodes,
  exploreFinding,
  exploreRoundReview,
  exploreRoundPrompt,
  exploreDigest,
  dispositionOf,
  userDecision,
  standingAuth,
  supersedeMarker,
  PROPOSAL_REL,
  writeProposal,
  proposalTargets,
  proposalCheck,
  proposalFinding,
  proposalRoundReview,
  proposalRoundPrompt,
  proposalDigest,
  designTargetRefs,
  targetRefList,
  gateFinding,
  roundReviewWithTargets,
  roundDigestWithTargets,
  proposeChainThroughDesign,
} from "./helpers/superspec_guard_fixture.ts";
import type { JsonMap, Fixture } from "./helpers/superspec_guard_fixture.ts";

test("FIX-1 command surface accepts recompute rebuild-corrupt", () => {
  const args = guard.parse_argv(["recompute", "--change", "demo-change", "--rebuild-corrupt"]);
  assert.equal(args.command, "recompute");
  assert.equal(args.rebuild_corrupt, true);
});

withFixture("FIX-1 corrupt state blocks check commands and preserves the corrupt file", (fx) => {
  guard.ensure_sidecar_layout(fx.change);
  const statePath = join(fx.change, ".superspec", "superspec-state.json");
  writeText(statePath, "{corrupt json");
  withRuntime({ load_context: () => [status(fx), fx.repo, fx.change, []] }, () => {
    const [decision] = guard.dispatch({ command: "check-enter", change: "demo-change", gate: "explore_complete" });
    assert.equal(decision.allowed, false);
    assert.ok(codes(decision.block_reasons).includes("state_corrupt"), JSON.stringify(decision.block_reasons));
    assert.equal(readFileSync(statePath, "utf8"), "{corrupt json");
  });
});

withFixture("FIX-1 recompute without rebuild-corrupt blocks on corrupt state", (fx) => {
  guard.ensure_sidecar_layout(fx.change);
  const statePath = join(fx.change, ".superspec", "superspec-state.json");
  writeText(statePath, "{corrupt json");
  withRuntime({ load_context: () => [status(fx), fx.repo, fx.change, []] }, () => {
    const [decision] = guard.dispatch({ command: "recompute", change: "demo-change" });
    assert.equal(decision.allowed, false);
    assert.ok(codes(decision.block_reasons).includes("state_corrupt"), JSON.stringify(decision.block_reasons));
    assert.equal(readFileSync(statePath, "utf8"), "{corrupt json");
  });
});

withFixture("FIX-1 status reports state_corrupt for non-object state file", (fx) => {
  guard.ensure_sidecar_layout(fx.change);
  const statePath = join(fx.change, ".superspec", "superspec-state.json");
  writeText(statePath, "[1, 2]\n");
  withRuntime({ load_context: () => [status(fx), fx.repo, fx.change, []] }, () => {
    const [decision] = guard.dispatch({ command: "status", change: "demo-change" });
    assert.equal(decision.allowed, false);
    assert.ok(codes(decision.block_reasons).includes("state_corrupt"), JSON.stringify(decision.block_reasons));
    assert.equal(readFileSync(statePath, "utf8"), "[1, 2]\n");
  });
});

withFixture("FIX-1 recompute rebuild-corrupt rebuilds state and records ledger event", (fx) => {
  guard.ensure_sidecar_layout(fx.change);
  const statePath = join(fx.change, ".superspec", "superspec-state.json");
  writeText(statePath, "{corrupt json");
  withRuntime({ load_context: () => [status(fx), fx.repo, fx.change, []] }, () => {
    const [decision] = guard.dispatch({ command: "recompute", change: "demo-change", rebuild_corrupt: true });
    assert.equal(decision.allowed, true, JSON.stringify(decision));
    const state = readJson(statePath);
    assert.equal(state.change_id, "demo-change");
    const events = readFileSync(join(fx.change, ".superspec", "ledger.jsonl"), "utf8")
      .trim().split("\n").filter(Boolean).map((line) => JSON.parse(line));
    assert.ok(events.some((event) => event.kind === "state_corrupt_rebuilt"), JSON.stringify(events));
  });
});

withFixture("FIX-1 corrupt state blocks check-archive-ready without overwriting state", (fx) => {
  guard.ensure_sidecar_layout(fx.change);
  const statePath = join(fx.change, ".superspec", "superspec-state.json");
  writeText(statePath, "{corrupt json");
  withRuntime({ load_context: () => [status(fx), fx.repo, fx.change, []] }, () => {
    const [decision] = guard.dispatch({ command: "check-archive-ready", change: "demo-change" });
    assert.equal(decision.allowed, false);
    assert.ok(codes(decision.block_reasons).includes("state_corrupt"), JSON.stringify(decision.block_reasons));
    assert.equal(readFileSync(statePath, "utf8"), "{corrupt json");
  });
});

withFixture("FIX-1 recompute rebuild-corrupt on healthy state behaves like plain recompute", (fx) => {
  withRuntime({ load_context: () => [status(fx), fx.repo, fx.change, []] }, () => {
    const [first] = guard.dispatch({ command: "recompute", change: "demo-change" });
    assert.equal(first.allowed, true, JSON.stringify(first));
    const [second] = guard.dispatch({ command: "recompute", change: "demo-change", rebuild_corrupt: true });
    assert.equal(second.allowed, true, JSON.stringify(second));
    const events = readFileSync(join(fx.change, ".superspec", "ledger.jsonl"), "utf8")
      .trim().split("\n").filter(Boolean).map((line) => JSON.parse(line));
    assert.ok(!events.some((event) => event.kind === "state_corrupt_rebuilt"), JSON.stringify(events));
  });
});

withFixture("non-archive dispatch blocks when inputs change before state write", (fx) => {
  writeText(join(fx.change, "tasks.md"), "- [ ] TASK-001 Initial\n");
  let loadCount = 0;
  withRuntime({
    load_context: () => {
      loadCount += 1;
      if (loadCount === 2) writeText(join(fx.change, "tasks.md"), "- [ ] TASK-001 Mutated\n");
      return [status(fx), fx.repo, fx.change, []];
    },
  }, () => {
    const [decision] = guard.dispatch({ command: "recompute", change: "demo-change" });
    assert.equal(decision.allowed, false);
    assert.ok(codes(decision.block_reasons).includes("state_concurrent_update"));
    const state = readJson(join(fx.change, ".superspec", "superspec-state.json"));
    assert.equal(state.superspec.last_guard_decision, "block");
  });
});

withFixture("non-archive dispatch blocks when config changes before state write", (fx) => {
  let loadCount = 0;
  withRuntime({
    load_context: () => {
      loadCount += 1;
      if (loadCount === 2) writeText(join(fx.change, ".superspec", "config.yaml"), "unknown: value\n");
      return [status(fx), fx.repo, fx.change, []];
    },
  }, () => {
    const [decision] = guard.dispatch({ command: "recompute", change: "demo-change" });
    assert.equal(decision.allowed, false);
    assert.ok(codes(decision.block_reasons).includes("state_concurrent_update"));
    const state = readJson(join(fx.change, ".superspec", "superspec-state.json"));
    assert.ok(String(state.computed_from.change_config_fingerprint ?? "").startsWith("sha256:"));
    assert.equal(state.superspec.last_guard_decision, "block");
  });
});

withFixture("FIX-5 prepared state reuses decision-time fingerprints verbatim", (fx) => {
  writeText(join(fx.change, "tasks.md"), "- [ ] TASK-001 v1\n");
  const currentStatus = status(fx);
  const decisionFps = guard.compute_fingerprints(fx.change, currentStatus);
  writeText(join(fx.change, "tasks.md"), "- [ ] TASK-001 v2 mutated after decision\n");
  const decision = guard.allow("demo-change", "recompute");
  const prepared = guard.prepare_recomputed_state_write(
    "demo-change", fx.change, currentStatus, "tasks", "recompute", decision,
    { fingerprints: decisionFps },
  );
  assert.equal((prepared.state as JsonMap).computed_from.tasks_fingerprint, decisionFps.tasks_fingerprint);
});

withFixture("FIX-5 post-decision mutation is not absorbed into written state", (fx) => {
  writeText(join(fx.change, "tasks.md"), "- [ ] TASK-001 v1\n");
  const currentStatus = status(fx);
  const decision = guard.allow("demo-change", "recompute");
  const decisionFps = guard.compute_fingerprints(fx.change, currentStatus);
  // the audited window: file mutates after the decision but before prepare/write
  writeText(join(fx.change, "tasks.md"), "- [ ] TASK-001 mutated between decision and write\n");
  const prepared = guard.prepare_recomputed_state_write(
    "demo-change", fx.change, currentStatus, "tasks", "recompute", decision,
    { fingerprints: decisionFps },
  );
  guard.with_state_lock(fx.change, () => {
    guard.write_prepared_state_locked(fx.change, prepared);
  });
  const state = readJson(join(fx.change, ".superspec", "superspec-state.json"));
  assert.equal(state.computed_from.tasks_fingerprint, decisionFps.tasks_fingerprint);
  assert.notEqual(state.computed_from.tasks_fingerprint, guard.sha256_file(join(fx.change, "tasks.md")));
  assert.deepEqual(codes(guard.state_stale_reasons(fx.change, currentStatus)), ["state_fingerprint_stale"]);
});

withFixture("state fingerprint stale blocks after evidence change", (fx) => {
  const currentStatus = status(fx);
  const decision = guard.allow("demo-change", "recompute");
  guard.recompute_and_write_state("demo-change", fx.change, currentStatus, "tasks", "recompute", decision);
  writeText(join(fx.change, ".superspec", "evidence", "design", "EV-new.json"), JSON.stringify(passEvidence("design_complete")));
  const reasons = guard.state_stale_reasons(fx.change, currentStatus);
  assert.deepEqual(codes(reasons), ["state_fingerprint_stale"]);
});

withFixture("archive manifest matches archived sidecar", (fx) => {
  guard.ensure_sidecar_layout(fx.change);
  writeText(join(fx.change, ".superspec", "config.yaml"), "preset: full\n");
  writeText(join(fx.change, ".superspec", "superspec-state.json"), "{\"schema_version\":1}\n");
  const manifestPath = guard.write_archive_manifest("demo-change", fx.change);
  const archived = join(fx.repo, "openspec", "changes", "archive", "2026-06-08-demo-change");
  mkdirp(archived);
  for (const path of walkFiles(join(fx.change, ".superspec"))) {
    const dest = join(archived, relative(fx.change, path));
    mkdirp(dirname(dest));
    copyFileSync(path, dest);
  }
  const decision = guard.check_archived("demo-change", fx.repo);
  assert.equal(statSync(manifestPath).isFile(), true);
  assert.equal(decision.allowed, true, JSON.stringify(decision));
});

withFixture("check archived ignores suffix-only archive directory matches", (fx) => {
  const wrongArchived = join(fx.repo, "openspec", "changes", "archive", "2026-06-08-other-demo-change");
  writeText(join(wrongArchived, ".superspec", "artifacts", "archive-preservation.json"), `${JSON.stringify({
    schema_version: 1,
    change_id: "other-demo-change",
    kind: "superspec_archive_preservation",
    entries: [],
  }, null, 2)}\n`);

  const decision = guard.check_archived("demo-change", fx.repo);
  assert.equal(decision.allowed, false);
  assert.equal(decision.block_reasons[0].code, "archive_not_found");
});

withFixture("check archived ignores symlinked archive directory matches", (fx) => {
  const externalArchive = join(fx.tmp, "external-archive");
  writeText(join(externalArchive, ".superspec", "ledger.jsonl"), "");
  writeText(join(externalArchive, ".superspec", "superspec-state.json"), "{}\n");
  const manifest = {
    schema_version: 1,
    change_id: "demo-change",
    kind: "superspec_archive_preservation",
    entries: [
      { path: ".superspec/ledger.jsonl", sha256: guard.sha256_file(join(externalArchive, ".superspec", "ledger.jsonl")) },
      { path: ".superspec/superspec-state.json", sha256: guard.sha256_file(join(externalArchive, ".superspec", "superspec-state.json")) },
    ],
  };
  writeText(join(externalArchive, ".superspec", "artifacts", "archive-preservation.json"), `${JSON.stringify(manifest, null, 2)}\n`);
  mkdirp(join(fx.repo, "openspec", "changes", "archive"));
  symlinkSync(externalArchive, join(fx.repo, "openspec", "changes", "archive", "2026-06-08-demo-change"), "dir");

  const decision = guard.check_archived("demo-change", fx.repo);
  assert.equal(decision.allowed, false);
  assert.equal(decision.block_reasons[0].code, "archive_not_found");
});

withFixture("check archived blocks primary manifest change id mismatch", (fx) => {
  const archived = join(fx.repo, "openspec", "changes", "archive", "2026-06-08-demo-change");
  writeText(join(archived, ".superspec", "artifacts", "archive-preservation.json"), `${JSON.stringify({
    schema_version: 1,
    change_id: "other-change",
    kind: "superspec_archive_preservation",
    entries: [],
  }, null, 2)}\n`);

  const decision = guard.check_archived("demo-change", fx.repo);
  assert.equal(decision.allowed, false);
  assert.equal(decision.block_reasons[0].code, "archive_manifest_mismatch");
});

withFixture("check archived blocks empty primary manifest with matching change id", (fx) => {
  const archived = join(fx.repo, "openspec", "changes", "archive", "2026-06-08-demo-change");
  writeText(join(archived, ".superspec", "artifacts", "archive-preservation.json"), `${JSON.stringify({
    schema_version: 1,
    change_id: "demo-change",
    kind: "superspec_archive_preservation",
    entries: [],
  }, null, 2)}\n`);

  const decision = guard.check_archived("demo-change", fx.repo);
  assert.equal(decision.allowed, false);
  assert.equal(decision.block_reasons[0].code, "archive_manifest_mismatch");
});

withFixture("check archived blocks primary manifest entry path escape", (fx) => {
  const archived = join(fx.repo, "openspec", "changes", "archive", "2026-06-08-demo-change");
  const outside = join(fx.tmp, "outside-primary.txt");
  writeText(join(archived, ".superspec", "ledger.jsonl"), "");
  writeText(join(archived, ".superspec", "superspec-state.json"), "{}\n");
  writeText(outside, "outside\n");
  writeText(join(archived, ".superspec", "artifacts", "archive-preservation.json"), `${JSON.stringify({
    schema_version: 1,
    change_id: "demo-change",
    kind: "superspec_archive_preservation",
    entries: [
      { path: ".superspec/ledger.jsonl", sha256: guard.sha256_file(join(archived, ".superspec", "ledger.jsonl")) },
      { path: ".superspec/superspec-state.json", sha256: guard.sha256_file(join(archived, ".superspec", "superspec-state.json")) },
      { path: "../../../../outside-primary.txt", sha256: guard.sha256_file(outside) },
    ],
  }, null, 2)}\n`);

  const decision = guard.check_archived("demo-change", fx.repo);
  assert.equal(decision.allowed, false);
  assert.ok(codes(decision.block_reasons).includes("archive_manifest_mismatch"), JSON.stringify(decision));
});

withFixture("check archive ready dispatch manifest matches after state write", (fx) => {
  const currentStatus = status(fx);
  writeText(join(fx.change, ".superspec", "evidence", "invariants", "EV-invariant-review.json"), JSON.stringify(roleEvidence(fx, "invariants_reviewed", "critic")));
  const evidences = archiveReadyEvidences(fx);
  withRuntime({
    load_context: () => [currentStatus, fx.repo, fx.change, evidences],
    openspec_validate: () => [true, ""],
    dirty_worktree_reasons: () => [],
  }, () => {
    const [decision] = guard.dispatch({ command: "check-archive-ready", change: "demo-change" });
    assert.equal(decision.allowed, true, JSON.stringify(decision));
    const manifestPath = join(fx.change, decision.superspec_gate_summary.archive_manifest);
    const bundleManifest = join(fx.change, decision.superspec_gate_summary.archive_preservation_bundle);
    assert.equal(statSync(bundleManifest).isFile(), true);
    const manifest = readJson(manifestPath);
    const entries = Object.fromEntries(manifest.entries.map((entry: JsonMap) => [entry.path, entry.sha256]));
    assert.ok(".superspec/ledger.jsonl" in entries);
    assert.ok(".superspec/superspec-state.json" in entries);
    assert.ok(".superspec/artifacts/business-invariants.md" in entries);
    assert.ok(".superspec/artifacts/test-contract.md" in entries);
    assert.ok(".superspec/evidence/invariants/EV-invariant-review.json" in entries);
    for (const [rel, expected] of Object.entries(entries)) {
      assert.equal(guard.sha256_file(join(fx.change, rel)), expected, rel);
    }
  });
});

withFixture("concurrent check archive ready dispatches converge on coherent preservation artifacts", async (fx) => {
  const currentStatus = status(fx);
  writeText(join(fx.change, ".superspec", "evidence", "invariants", "EV-invariant-review.json"), JSON.stringify(roleEvidence(fx, "invariants_reviewed", "critic")));
  const evidences = archiveReadyEvidences(fx);
  const statusPath = join(fx.tmp, "status.json");
  const evidencesPath = join(fx.tmp, "evidences.json");
  const lockHeldMarkerPath = join(fx.tmp, "archive-ready-lock-held");
  const stateLockPath = join(fx.change, ".superspec", "superspec-state.lock");
  writeText(statusPath, `${JSON.stringify(currentStatus, null, 2)}\n`);
  writeText(evidencesPath, `${JSON.stringify(evidences, null, 2)}\n`);
  const childScript = `
import { readFileSync, writeFileSync } from "node:fs";

const delayMs = Number(process.env.SUPERSPEC_DELAY_MS ?? "0");
const sleep = (ms) => {
  if (ms <= 0) return;
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
};

const mod = await import(process.env.SUPERSPEC_GUARD_URL);
const status = JSON.parse(readFileSync(process.env.SUPERSPEC_STATUS_PATH, "utf8"));
const evidences = JSON.parse(readFileSync(process.env.SUPERSPEC_EVIDENCES_PATH, "utf8"));
const repoRoot = process.env.SUPERSPEC_REPO_ROOT;
const changeRoot = process.env.SUPERSPEC_CHANGE_ROOT;
const lockHeldMarkerPath = process.env.SUPERSPEC_LOCK_HELD_MARKER_PATH;
const begin = mod.runtime.begin_archive_preservation_bundle;
const startedAt = Date.now();

mod.runtime.load_context = () => [status, repoRoot, changeRoot, evidences];
mod.runtime.openspec_validate = () => [true, ""];
mod.runtime.dirty_worktree_reasons = () => [];
mod.runtime.review_diff_paths = () => ["tasks.md"];
mod.runtime.begin_archive_preservation_bundle = (...args) => {
  if (lockHeldMarkerPath) writeFileSync(lockHeldMarkerPath, "lock-held\\n");
  const txn = begin(...args);
  sleep(delayMs);
  return txn;
};

let retryCount = 0;
mod.runtime.on_state_retry = () => {
  retryCount += 1;
};
mod.runtime.max_state_write_retries = Number(process.env.SUPERSPEC_MAX_STATE_WRITE_RETRIES ?? "5");

const [decision] = mod.dispatch({ command: "check-archive-ready", change: "demo-change" });
process.stdout.write(JSON.stringify({ decision, elapsed_ms: Date.now() - startedAt, retry_count: retryCount }));
`;
  const baseEnv = {
    ...process.env,
    SUPERSPEC_GUARD_URL: GUARD_TS_URL,
    SUPERSPEC_STATUS_PATH: statusPath,
    SUPERSPEC_EVIDENCES_PATH: evidencesPath,
    SUPERSPEC_REPO_ROOT: fx.repo,
    SUPERSPEC_CHANGE_ROOT: fx.change,
  };
  const first = spawn(process.execPath, ["--input-type=module", "--eval", childScript], {
    cwd: fx.repo,
    env: {
      ...baseEnv,
      SUPERSPEC_DELAY_MS: "5000",
      SUPERSPEC_MAX_STATE_WRITE_RETRIES: "80",
      SUPERSPEC_LOCK_HELD_MARKER_PATH: lockHeldMarkerPath,
    },
  });
  await waitForCondition(() => existsSync(lockHeldMarkerPath) && existsSync(stateLockPath), 60000);
  const second = spawn(process.execPath, ["--input-type=module", "--eval", childScript], {
    cwd: fx.repo,
    env: { ...baseEnv, SUPERSPEC_DELAY_MS: "0", SUPERSPEC_MAX_STATE_WRITE_RETRIES: "80" },
  });
  const [firstResult, secondResult] = await Promise.all([waitForChild(first), waitForChild(second)]);
  for (const result of [firstResult, secondResult]) {
    assert.equal(result.code, 0, result.stderr);
    const payload = JSON.parse(result.stdout);
    assert.equal(payload.decision.allowed, true, result.stdout);
    assert.equal(payload.decision.gate, "archive_ready");
  }
  // The second process starts while the first holds the state lock. Depending on scheduler
  // timing it may wait in lock acquisition rather than entering the explicit retry hook, so
  // the durable assertion is the coherent double-allow state verified below.
  const statePath = join(fx.change, ".superspec", "superspec-state.json");
  const ledgerPath = join(fx.change, ".superspec", "ledger.jsonl");
  const manifestPath = join(fx.change, ".superspec", "artifacts", "archive-preservation.json");
  const bundleManifestPath = join(fx.change, "superspec-preservation", "manifest.json");
  assert.equal(statSync(statePath).isFile(), true);
  assert.equal(statSync(ledgerPath).isFile(), true);
  assert.equal(statSync(manifestPath).isFile(), true);
  assert.equal(statSync(bundleManifestPath).isFile(), true);
  assert.equal(existsSync(join(fx.change, ".superspec", "superspec-state.lock")), false);
  assert.equal(existsSync(join(fx.change, ".superspec", "superspec-state.tmp")), false);
  assert.equal(walkFiles(join(fx.change, ".superspec-staging")).length, 0);
  const ledgerEvents = readFileSync(ledgerPath, "utf8")
    .trim()
    .split(/\r?\n/)
    .filter(Boolean)
    .map((line) => JSON.parse(line));
  assert.equal(ledgerEvents.length, 2);
  assert.deepEqual(ledgerEvents.map((item: JsonMap) => item.decision), ["allow", "allow"]);
  const state = readJson(statePath);
  assert.equal(state.superspec.last_guard_decision, "allow");
  assert.equal(state.superspec.active_gate, "archive_ready");
  const manifest = readJson(manifestPath);
  const bundleManifest = readJson(bundleManifestPath);
  const manifestEntries = Object.fromEntries(manifest.entries.map((entry: JsonMap) => [entry.path, entry.sha256]));
  const bundleEntries = Object.fromEntries(bundleManifest.entries.map((entry: JsonMap) => [entry.path, entry.sha256]));
  assert.deepEqual(bundleEntries, manifestEntries);
  for (const [rel, expected] of Object.entries(manifestEntries)) {
    assert.equal(guard.sha256_file(join(fx.change, rel)), expected, rel);
    assert.equal(guard.sha256_file(join(fx.change, "superspec-preservation", "files", rel)), expected, `bundle:${rel}`);
  }
});

withFixture("archive ready blocks when preservation bundle cannot be written", (fx) => {
  const currentStatus = status(fx);
  const guidance = [
    ...reviewGuidanceEvidences(fx),
    reviewEvidence(fx, "critic"),
  ];
  const evidences = [
    ...prepareProposeComplete(fx, {
      checked: true,
      tasksText:
        "- [x] TASK-001 Implement\n" +
        "  - invariant_refs: INV-001\n" +
        "  - test_refs: TEST-001\n" +
        "  - tdd_required: false\n" +
        "  - no_tdd_reason: non-executable-spec-change\n",
    }),
    alternativeVerificationEvidence("TASK-001"),
    ...guidance,
    mainAdjudication(fx, guidance),
    verifyEvidence(fx, "verifier"),
    verifyEvidence(fx, "critic"),
    finalTestEvidence(fx),
    passEvidence("archive_ready", "human_confirmation"),
  ];
  withRuntime({
    load_context: () => [currentStatus, fx.repo, fx.change, evidences],
    openspec_validate: () => [true, ""],
    dirty_worktree_reasons: () => [],
    begin_archive_preservation_bundle: () => {
      throw new Error("no space");
    },
  }, () => {
    const [decision] = guard.dispatch({ command: "check-archive-ready", change: "demo-change" });
    assert.equal(decision.allowed, false);
    assert.ok(codes(decision.block_reasons).includes("missing_archive_preservation_plan"));
    assert.ok(decision.next_allowed_actions.length > 0);
    assert.ok(decision.next_allowed_actions.some((item: string) => item.includes("rerun check-archive-ready")));
    const state = readJson(join(fx.change, ".superspec", "superspec-state.json"));
    assert.equal(state.superspec.last_guard_decision, "block");
  });
});

withFixture("prepared state write preserves concurrent appended ledger events", (fx) => {
  const currentStatus = status(fx);
  const decision = guard.allow("demo-change", "recompute");
  const prepared = guard.prepare_recomputed_state_write("demo-change", fx.change, currentStatus, "tasks", "recompute", decision);
  guard.append_ledger(fx.change, { change_id: "demo-change", kind: "manual_event", gate: "manual", decision: "note" });
  guard.write_prepared_state_locked(fx.change, prepared);
  const events = readFileSync(join(fx.change, ".superspec", "ledger.jsonl"), "utf8")
    .trim()
    .split(/\r?\n/)
    .filter(Boolean)
    .map((line) => JSON.parse(line));
  assert.deepEqual(events.map((item: JsonMap) => item.kind), ["manual_event", "guard_decision"]);
});

withFixture("prepared state write removes tmp symlinks instead of following them", (fx) => {
  const currentStatus = status(fx);
  const decision = guard.allow("demo-change", "recompute");
  const prepared = guard.prepare_recomputed_state_write("demo-change", fx.change, currentStatus, "tasks", "recompute", decision);
  const base = join(fx.change, ".superspec");
  mkdirp(base);
  const outsideState = join(fx.tmp, "outside-state.txt");
  const outsideLedger = join(fx.tmp, "outside-ledger.txt");
  writeText(outsideState, "outside state\n");
  writeText(outsideLedger, "outside ledger\n");
  symlinkSync(outsideState, join(base, "superspec-state.tmp"));
  symlinkSync(outsideLedger, join(base, "ledger.tmp"));
  guard.write_prepared_state_locked(fx.change, prepared);
  assert.equal(readFileSync(outsideState, "utf8"), "outside state\n");
  assert.equal(readFileSync(outsideLedger, "utf8"), "outside ledger\n");
  assert.equal(existsSync(join(base, "superspec-state.tmp")), false);
  assert.equal(existsSync(join(base, "ledger.tmp")), false);
  assert.equal(lstatSync(join(base, "superspec-state.json")).isSymbolicLink(), false);
  assert.equal(lstatSync(join(base, "ledger.jsonl")).isSymbolicLink(), false);
});

withFixture("prepared state write removes tmp hard links instead of truncating targets", (fx) => {
  const currentStatus = status(fx);
  const decision = guard.allow("demo-change", "recompute");
  const prepared = guard.prepare_recomputed_state_write("demo-change", fx.change, currentStatus, "tasks", "recompute", decision);
  const base = join(fx.change, ".superspec");
  mkdirp(base);
  const outsideState = join(fx.tmp, "outside-hard-state.txt");
  const outsideLedger = join(fx.tmp, "outside-hard-ledger.txt");
  writeText(outsideState, "outside hard state\n");
  writeText(outsideLedger, "outside hard ledger\n");
  linkSync(outsideState, join(base, "superspec-state.tmp"));
  linkSync(outsideLedger, join(base, "ledger.tmp"));
  guard.write_prepared_state_locked(fx.change, prepared);
  assert.equal(readFileSync(outsideState, "utf8"), "outside hard state\n");
  assert.equal(readFileSync(outsideLedger, "utf8"), "outside hard ledger\n");
  assert.equal(existsSync(join(base, "superspec-state.tmp")), false);
  assert.equal(existsSync(join(base, "ledger.tmp")), false);
});

withFixture("archive preservation transaction rollback restores previous manifest and bundle", (fx) => {
  guard.write_archive_preservation_bundle("demo-change", fx.change);
  const manifestPath = join(fx.change, ".superspec", "artifacts", "archive-preservation.json");
  const bundlePath = join(fx.change, "superspec-preservation", "manifest.json");
  const oldManifest = readFileSync(manifestPath, "utf8");
  const oldBundle = readFileSync(bundlePath, "utf8");
  const txn = guard.begin_archive_preservation_bundle("demo-change", fx.change, {
    file_overrides: {
      ".superspec/ledger.jsonl": "{\"decision\":\"allow\"}\n",
      ".superspec/superspec-state.json": "{\"schema_version\":1}\n",
    },
  });
  assert.notEqual(readFileSync(manifestPath, "utf8"), oldManifest);
  assert.notEqual(readFileSync(bundlePath, "utf8"), oldBundle);
  txn.rollback();
  assert.equal(readFileSync(manifestPath, "utf8"), oldManifest);
  assert.equal(readFileSync(bundlePath, "utf8"), oldBundle);
});

withFixture("archive preservation first-run rollback removes promoted manifest and bundle", (fx) => {
  const manifestPath = join(fx.change, ".superspec", "artifacts", "archive-preservation.json");
  const bundleDir = join(fx.change, "superspec-preservation");
  const txn = guard.begin_archive_preservation_bundle("demo-change", fx.change, {
    file_overrides: {
      ".superspec/ledger.jsonl": "{\"decision\":\"allow\"}\n",
      ".superspec/superspec-state.json": "{\"schema_version\":1}\n",
    },
  });
  assert.equal(statSync(manifestPath).isFile(), true);
  assert.equal(statSync(join(bundleDir, "manifest.json")).isFile(), true);
  txn.rollback();
  assert.equal(existsSync(manifestPath), false);
  assert.equal(existsSync(bundleDir), false);
  assert.equal(walkFiles(join(fx.change, ".superspec-staging")).length, 0);
});

withFixture("archive preservation promote failure after bundle rename removes promoted artifacts", (fx) => {
  const manifestPath = join(fx.change, ".superspec", "artifacts", "archive-preservation.json");
  const bundleDir = join(fx.change, "superspec-preservation");
  assert.throws(() => withRuntime({
    after_archive_bundle_promote: () => {
      assert.equal(existsSync(bundleDir), true);
      assert.equal(existsSync(manifestPath), false);
      throw new Error("fail after bundle promote");
    },
  }, () => guard.begin_archive_preservation_bundle("demo-change", fx.change, {
    file_overrides: {
      ".superspec/ledger.jsonl": "{\"decision\":\"allow\"}\n",
      ".superspec/superspec-state.json": "{\"schema_version\":1}\n",
    },
  })), /fail after bundle promote/);
  assert.equal(existsSync(manifestPath), false);
  assert.equal(existsSync(bundleDir), false);
  assert.equal(walkFiles(join(fx.change, ".superspec-staging")).length, 0);
});

withFixture("archive ready blocks and restores state snapshot when state write CAS fails", (fx) => {
  const currentStatus = status(fx);
  const guidance = [
    ...reviewGuidanceEvidences(fx),
    reviewEvidence(fx, "critic"),
  ];
  const evidences = [
    ...prepareProposeComplete(fx, {
      checked: true,
      tasksText:
        "- [x] TASK-001 Implement\n" +
        "  - invariant_refs: INV-001\n" +
        "  - test_refs: TEST-001\n" +
        "  - tdd_required: false\n" +
        "  - no_tdd_reason: non-executable-spec-change\n",
    }),
    alternativeVerificationEvidence("TASK-001"),
    ...guidance,
    mainAdjudication(fx, guidance),
    verifyEvidence(fx, "verifier"),
    verifyEvidence(fx, "critic"),
    finalTestEvidence(fx),
    passEvidence("archive_ready", "human_confirmation"),
  ];
  withRuntime({
    load_context: () => [currentStatus, fx.repo, fx.change, evidences],
    openspec_validate: () => [true, ""],
    dirty_worktree_reasons: () => [],
  }, () => {
    const seedDecision = guard.allow("demo-change", "recompute");
    guard.recompute_and_write_state("demo-change", fx.change, currentStatus, "review", "review_complete", seedDecision);
    guard.write_archive_preservation_bundle("demo-change", fx.change);
    const manifestPath = join(fx.change, ".superspec", "artifacts", "archive-preservation.json");
    const bundlePath = join(fx.change, "superspec-preservation", "manifest.json");
    const statePath = join(fx.change, ".superspec", "superspec-state.json");
    const ledgerPath = join(fx.change, ".superspec", "ledger.jsonl");
    const oldManifest = readFileSync(manifestPath, "utf8");
    const oldBundle = readFileSync(bundlePath, "utf8");
    const oldStateText = readFileSync(statePath, "utf8");
    const oldLedgerText = readFileSync(ledgerPath, "utf8");
    const restoredSnapshots: Array<{ state_text: string | null; ledger_text: string }> = [];
    const oldLedgerEvents = oldLedgerText
      .trim()
      .split(/\r?\n/)
      .filter(Boolean)
      .map((line) => JSON.parse(line));
    const realBegin = guard.begin_archive_preservation_bundle;
    const [decision] = withRuntime({
      on_state_snapshot_restored: (payload: { state_text: string | null; ledger_text: string }) => {
        restoredSnapshots.push({ state_text: payload.state_text, ledger_text: payload.ledger_text });
      },
      begin_archive_preservation_bundle: (change: string, changeRoot: string, opts: JsonMap) => {
        const txn = realBegin(change, changeRoot, opts);
        writeText(statePath, `${JSON.stringify({
          schema_version: 1,
          change_id: change,
          computed_from: { openspec_status_fingerprint: "sha256:other" },
        }, null, 2)}\n`);
        return txn;
      },
    }, () => guard.dispatch({ command: "check-archive-ready", change: "demo-change" }));
    assert.equal(decision.allowed, false);
    assert.ok(codes(decision.block_reasons).includes("missing_archive_preservation_plan"));
    assert.equal(readFileSync(manifestPath, "utf8"), oldManifest);
    assert.equal(readFileSync(bundlePath, "utf8"), oldBundle);
    assert.equal(restoredSnapshots.length, 1);
    assert.equal(restoredSnapshots[0].state_text, oldStateText);
    assert.equal(restoredSnapshots[0].ledger_text, oldLedgerText);
    assert.equal(statSync(manifestPath).isFile(), true);
    assert.equal(statSync(bundlePath).isFile(), true);
    assert.equal(existsSync(join(fx.change, ".superspec", "superspec-state.tmp")), false);
    const ledgerEvents = readFileSync(ledgerPath, "utf8")
      .trim()
      .split(/\r?\n/)
      .filter(Boolean)
      .map((line) => JSON.parse(line));
    assert.equal(ledgerEvents.length, oldLedgerEvents.length + 1);
    assert.deepEqual(ledgerEvents.slice(0, oldLedgerEvents.length), oldLedgerEvents);
    assert.equal(ledgerEvents.at(-1)?.decision, "block");
    const state = readJson(statePath);
    assert.equal(state.superspec.last_guard_decision, "block");
  });
});

withFixture("archive ready state write failure without previous preservation removes promoted artifacts", (fx) => {
  const currentStatus = status(fx);
  const guidance = [
    ...reviewGuidanceEvidences(fx),
    reviewEvidence(fx, "critic"),
  ];
  const evidences = [
    ...prepareProposeComplete(fx, {
      checked: true,
      tasksText:
        "- [x] TASK-001 Implement\n" +
        "  - invariant_refs: INV-001\n" +
        "  - test_refs: TEST-001\n" +
        "  - tdd_required: false\n" +
        "  - no_tdd_reason: non-executable-spec-change\n",
    }),
    alternativeVerificationEvidence("TASK-001"),
    ...guidance,
    mainAdjudication(fx, guidance),
    verifyEvidence(fx, "verifier"),
    verifyEvidence(fx, "critic"),
    finalTestEvidence(fx),
    passEvidence("archive_ready", "human_confirmation"),
  ];
  withRuntime({
    load_context: () => [currentStatus, fx.repo, fx.change, evidences],
    openspec_validate: () => [true, ""],
    dirty_worktree_reasons: () => [],
  }, () => {
    const manifestPath = join(fx.change, ".superspec", "artifacts", "archive-preservation.json");
    const bundleDir = join(fx.change, "superspec-preservation");
    const statePath = join(fx.change, ".superspec", "superspec-state.json");
    const realBegin = guard.begin_archive_preservation_bundle;
    const [decision] = withRuntime({
      begin_archive_preservation_bundle: (change: string, changeRoot: string, opts: JsonMap) => {
        const txn = realBegin(change, changeRoot, opts);
        assert.equal(statSync(manifestPath).isFile(), true);
        assert.equal(statSync(join(bundleDir, "manifest.json")).isFile(), true);
        writeText(statePath, `${JSON.stringify({
          schema_version: 1,
          change_id: change,
          computed_from: { openspec_status_fingerprint: "sha256:other" },
        }, null, 2)}\n`);
        return txn;
      },
    }, () => guard.dispatch({ command: "check-archive-ready", change: "demo-change" }));
    assert.equal(decision.allowed, false);
    assert.ok(codes(decision.block_reasons).includes("missing_archive_preservation_plan"));
    assert.equal(existsSync(manifestPath), false);
    assert.equal(existsSync(bundleDir), false);
    const state = readJson(statePath);
    assert.equal(state.superspec.last_guard_decision, "block");
  });
});

withFixture("check archived blocks missing manifest", (fx) => {
  mkdirp(join(fx.repo, "openspec", "changes", "archive", "2026-06-08-demo-change", ".superspec"));
  const decision = guard.check_archived("demo-change", fx.repo);
  assert.equal(decision.allowed, false);
  assert.equal(decision.block_reasons[0].code, "superspec_not_preserved");
});

withFixture("check archived blocks fallback manifest change id mismatch", (fx) => {
  const archived = join(fx.repo, "openspec", "changes", "archive", "2026-06-08-demo-change");
  writeText(join(archived, "superspec-preservation", "manifest.json"), `${JSON.stringify({
    schema_version: 1,
    change_id: "other-change",
    kind: "superspec_archive_preservation_bundle",
    files_root: "files",
    entries: [],
  }, null, 2)}\n`);

  const decision = guard.check_archived("demo-change", fx.repo);
  assert.equal(decision.allowed, false);
  assert.equal(decision.block_reasons[0].code, "archive_manifest_mismatch");
});

withFixture("check archived blocks empty fallback manifest with matching change id", (fx) => {
  const archived = join(fx.repo, "openspec", "changes", "archive", "2026-06-08-demo-change");
  writeText(join(archived, "superspec-preservation", "manifest.json"), `${JSON.stringify({
    schema_version: 1,
    change_id: "demo-change",
    kind: "superspec_archive_preservation_bundle",
    files_root: "files",
    entries: [],
  }, null, 2)}\n`);

  const decision = guard.check_archived("demo-change", fx.repo);
  assert.equal(decision.allowed, false);
  assert.equal(decision.block_reasons[0].code, "archive_manifest_mismatch");
});

withFixture("check archived blocks fallback files root escape", (fx) => {
  const archived = join(fx.repo, "openspec", "changes", "archive", "2026-06-08-demo-change");
  writeText(join(archived, "superspec-preservation", "manifest.json"), `${JSON.stringify({
    schema_version: 1,
    change_id: "demo-change",
    kind: "superspec_archive_preservation_bundle",
    files_root: "../outside",
    entries: [
      { path: ".superspec/ledger.jsonl", sha256: "sha256:missing" },
      { path: ".superspec/superspec-state.json", sha256: "sha256:missing" },
    ],
  }, null, 2)}\n`);

  const decision = guard.check_archived("demo-change", fx.repo);
  assert.equal(decision.allowed, false);
  assert.equal(decision.block_reasons[0].code, "archive_manifest_mismatch");
});

withFixture("check archived blocks fallback manifest entry path escape", (fx) => {
  const archived = join(fx.repo, "openspec", "changes", "archive", "2026-06-08-demo-change");
  const filesRoot = join(archived, "superspec-preservation", "files");
  const outside = join(fx.tmp, "outside-fallback.txt");
  writeText(join(filesRoot, ".superspec", "ledger.jsonl"), "");
  writeText(join(filesRoot, ".superspec", "superspec-state.json"), "{}\n");
  writeText(outside, "outside\n");
  writeText(join(archived, "superspec-preservation", "manifest.json"), `${JSON.stringify({
    schema_version: 1,
    change_id: "demo-change",
    kind: "superspec_archive_preservation_bundle",
    files_root: "files",
    entries: [
      { path: ".superspec/ledger.jsonl", sha256: guard.sha256_file(join(filesRoot, ".superspec", "ledger.jsonl")) },
      { path: ".superspec/superspec-state.json", sha256: guard.sha256_file(join(filesRoot, ".superspec", "superspec-state.json")) },
      { path: "../../../../outside-fallback.txt", sha256: guard.sha256_file(outside) },
    ],
  }, null, 2)}\n`);

  const decision = guard.check_archived("demo-change", fx.repo);
  assert.equal(decision.allowed, false);
  assert.ok(codes(decision.block_reasons).includes("archive_manifest_mismatch"), JSON.stringify(decision));
});

withFixture("check archived allows preservation bundle when sidecar missing", (fx) => {
  guard.ensure_sidecar_layout(fx.change);
  writeText(join(fx.change, ".superspec", "config.yaml"), "preset: full\n");
  writeText(join(fx.change, ".superspec", "superspec-state.json"), "{\"schema_version\":1}\n");
  guard.write_archive_preservation_bundle("demo-change", fx.change);
  const archived = join(fx.repo, "openspec", "changes", "archive", "2026-06-08-demo-change");
  mkdirp(archived);
  const srcBundle = join(fx.change, "superspec-preservation");
  const dstBundle = join(archived, "superspec-preservation");
  for (const path of walkFiles(srcBundle)) {
    const dest = join(dstBundle, relative(srcBundle, path));
    mkdirp(dirname(dest));
    copyFileSync(path, dest);
  }
  const decision = guard.check_archived("demo-change", fx.repo);
  assert.equal(decision.allowed, true, JSON.stringify(decision));
  assert.equal(decision.superspec_gate_summary.fallback_manifest, "superspec-preservation/manifest.json");
});

test("hotfix forced upgrade requires human confirmation", () => {
  const reasons = guard.preset_upgrade_reasons({ preset: "hotfix" }, ["a.py", "b.py", "c.py"], false);
  assert.deepEqual(codes(reasons), ["preset_upgrade_requires_human_confirmation"]);
});

test("tweak forced upgrade allows human confirmation", () => {
  const reasons = guard.preset_upgrade_reasons({ preset: "tweak" }, ["a.py", "b.py", "c.py", "d.py", "e.py"], true);
  assert.deepEqual(reasons, []);
});

withFixture("dispatch blocks hotfix preset upgrade without confirmation", (fx) => {
  writeText(join(fx.change, ".superspec", "config.yaml"), "preset: hotfix\n");
  withRuntime({
    load_context: () => [status(fx), fx.repo, fx.change, []],
    dirty_worktree_paths: () => ["a.py", "b.py", "c.py"],
  }, () => {
    const [decision] = guard.dispatch({ command: "check-init", change: "demo-change" });
    assert.equal(decision.allowed, false);
    assert.ok(codes(decision.block_reasons).includes("preset_upgrade_requires_human_confirmation"));
    assert.equal(readJson(join(fx.change, ".superspec", "superspec-state.json")).superspec.preset_upgrade_required, true);
  });
});

withFixture("dispatch persists confirmed preset upgrade requirement", (fx) => {
  writeText(join(fx.change, ".superspec", "config.yaml"), "preset: hotfix\n");
  const evidences = [passEvidence("preset_upgrade", "human_confirmation")];
  withRuntime({
    load_context: () => [status(fx), fx.repo, fx.change, evidences],
    dirty_worktree_paths: () => ["a.py", "b.py", "c.py"],
  }, () => {
    const [decision] = guard.dispatch({ command: "check-init", change: "demo-change" });
    assert.equal(decision.allowed, true, JSON.stringify(decision));
    const state = readJson(join(fx.change, ".superspec", "superspec-state.json"));
    assert.equal(state.superspec.preset, "hotfix");
    assert.equal(state.superspec.preset_upgrade_required, true);
  });
});

test("no v1 hook or custom schema artifacts exist", () => {
  const tracked = spawnSync("git", ["ls-files", ".codex/hooks.json", "openspec/schemas/superspec"], { cwd: REPO_ROOT, encoding: "utf8" });
  assert.equal(tracked.status, 0, tracked.stderr);
  assert.equal(tracked.stdout.trim(), "");
});

test("status output includes observability fields", () => {
  const decision = guard.allow("demo-change", "status");
  assert.ok("decision" in decision);
  assert.ok("block_reasons" in decision);
  assert.ok("next_allowed_actions" in decision);
  assert.ok("trust_warnings" in decision);
});
