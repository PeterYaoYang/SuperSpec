import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, symlinkSync } from "node:fs";
import { join } from "node:path";

import * as guard from "../superspec_guard.ts";
import { runHookAdapter } from "../superspec_hook.ts";
import {
  assertNoForbiddenAgentKeys,
  captureMain,
  captureMainJson,
  archiveReadyEvidences,
  codes,
  materializeEvidenceRecord,
  prepareProposeComplete,
  roleEvidence,
  redEvidence,
  status,
  withFixture,
  withRuntime,
  writeText,
  type Fixture,
  type JsonMap,
} from "./helpers/superspec_guard_fixture.ts";

function eventFile(fx: Fixture, name: string, event: JsonMap): string {
  const rel = `.superspec/tmp/${name}.json`;
  const path = join(fx.change, rel);
  writeText(path, `${JSON.stringify(event, null, 2)}\n`);
  return path;
}

function applyPatchEvent(fx: Fixture, command: string, overrides: JsonMap = {}): JsonMap {
  return {
    hook_event_name: "PreToolUse",
    session_id: "manual-cli-session",
    turn_id: "turn-1",
    tool_name: "apply_patch",
    tool_use_id: "tool-1",
    cwd: fx.repo,
    tool_input: { command },
    ...overrides,
  };
}

function bashEvent(fx: Fixture, command: string, overrides: JsonMap = {}): JsonMap {
  return {
    hook_event_name: "PreToolUse",
    session_id: "manual-cli-session",
    turn_id: "turn-1",
    tool_name: "Bash",
    tool_use_id: "tool-1",
    cwd: fx.repo,
    tool_input: { command },
    ...overrides,
  };
}

function beginAuditSession(fx: Fixture): JsonMap {
  let payload: JsonMap | null = null;
  withRuntime({ load_context: () => [status(fx), fx.repo, fx.change, []] }, () => {
    const result = captureMainJson([
      "hook-session-begin",
      "--change", "demo-change",
      "--workflow", "superspec-apply",
      "--entrypoint-token", "test-token",
    ]);
    assert.equal(result.exitCode, 0);
    payload = result.payload;
    assert.equal(payload.strict_profile, "unavailable");
    assert.equal(payload.actions[0].trusted_active_session_created, false);
  });
  assert.ok(payload, "expected hook-session-begin payload");
  return payload;
}

function activeSessionFile(fx: Fixture): string {
  const dir = join(fx.change, ".superspec/hook-runtime/active-sessions");
  const file = readdirSync(dir).find((name) => name.endsWith(".json"));
  assert.ok(file, "expected active hook session file");
  return join(dir, file);
}

function validSessionRecord(fx: Fixture, changeId: string, overrides: JsonMap = {}): JsonMap {
  return {
    schema_version: 2,
    kind: "hook_active_session",
    trust: "audit-only",
    change_id: changeId,
    repo_root: fx.repo,
    session_id: "manual-cli-session",
    workflow: "superspec-apply",
    started_at: new Date().toISOString(),
    expires_at: new Date(Date.now() + 60_000).toISOString(),
    guard_version: "superspec-guard@1",
    adapter_version: "superspec-hook-adapter@2",
    hook_manifest_hash: null,
    strict_profile: "unavailable",
    audit_only_reasons: [],
    ...overrides,
  };
}

function assertSubagentOnlyHookManifest(manifest: any): void {
  assert.equal(manifest.hooks?.PreToolUse, undefined);
  assert.equal(manifest.hooks?.PostToolUse, undefined);
  assert.ok(Array.isArray((manifest.hooks as JsonMap).SubagentStart), "SubagentStart hook must be present");
  assert.ok(Array.isArray((manifest.hooks as JsonMap).SubagentStop), "SubagentStop hook must be present");
  assert.deepEqual(Object.keys(manifest.hooks as JsonMap).sort(), ["SubagentStart", "SubagentStop"]);
}

function assertNoLifecycleLeak(value: unknown): void {
  const text = JSON.stringify(value);
  assert.doesNotMatch(text, /lifecycle_nonce/u);
  assert.doesNotMatch(text, /lifecycle_token/u);
  assert.doesNotMatch(text, /close_args_by_reason/u);
}

withFixture("hook-health never claims strict when R-1/provenance are unavailable", (fx) => {
  withRuntime({ load_context: () => [status(fx), fx.repo, fx.change, []] }, () => {
    const { exitCode, payload } = captureMainJson(["hook-health", "--change", "demo-change"]);
    assert.equal(exitCode, 1);
    assert.equal(payload.strict_profile, "unavailable");
    assert.equal(payload.trust, "audit-only");
    assert.equal(payload.actions[0].mechanical, false);
    assert.equal(payload.actions[0].runtime_verified, false);
    const reasonCodes = codes(payload.audit_only_reasons);
    assert.ok(reasonCodes.includes("r1_deny_spike_not_passed"));
    assert.ok(reasonCodes.includes("hook_provenance_unavailable"));
  });
});

withFixture("superspec hook entrypoint registers core runtime without guard import ordering", () => {
  const proc = spawnSync(process.execPath, [
    "-e",
    [
      "await import('./superspec_hook.ts');",
      "const { runtime } = await import('./src/util.ts');",
      "if (typeof runtime.load_context !== 'function') throw new Error('runtime.load_context missing');",
      "process.stdout.write('registered');",
    ].join("\n"),
  ], { cwd: process.cwd(), encoding: "utf8" });
  assert.equal(proc.status, 0, proc.stderr || proc.stdout);
  assert.equal(proc.stdout, "registered");
});

withFixture("no active hook session passes ordinary edits but denies SuperSpec trust roots", (fx) => {
  const ordinaryRef = eventFile(fx, "ordinary", applyPatchEvent(fx, "*** Add File: src/ordinary.ts\n+ok\n"));
  const trustRootRef = eventFile(fx, "trust-root", applyPatchEvent(fx, "*** Update File: openspec/changes/demo-change/.superspec/superspec-state.json\n+{}\n"));
  const docDesignRef = eventFile(fx, "ordinary-doc-design", applyPatchEvent(fx, "*** Add File: docs/design.md\n+notes\n"));
  const sourceSpecsRef = eventFile(fx, "ordinary-source-specs", applyPatchEvent(fx, "*** Add File: src/specs/foo.ts\n+export const value = 1;\n"));
  withRuntime({ load_context: () => [status(fx), fx.repo, fx.change, []] }, () => {
    const ordinary = captureMainJson(["hook-check-write", "--change", "demo-change", "--event-ref", ordinaryRef]).payload;
    assert.equal(ordinary.allowed, true);
    assert.equal(ordinary.enforcement, "pass-through");
    const docDesign = captureMainJson(["hook-check-write", "--change", "demo-change", "--event-ref", docDesignRef]).payload;
    assert.equal(docDesign.allowed, true);
    assert.equal(docDesign.enforcement, "pass-through");
    const sourceSpecs = captureMainJson(["hook-check-write", "--change", "demo-change", "--event-ref", sourceSpecsRef]).payload;
    assert.equal(sourceSpecs.allowed, true);
    assert.equal(sourceSpecs.enforcement, "pass-through");
    const trustRoot = captureMainJson(["hook-check-write", "--change", "demo-change", "--event-ref", trustRootRef]).payload;
    assert.equal(trustRoot.allowed, false);
    assert.ok(codes(trustRoot.block_reasons).includes("protected_trust_root_write"), JSON.stringify(trustRoot.block_reasons));
  });
});

withFixture("no active hook session passes scoped implementation writes through", (fx) => {
  writeText(join(fx.change, "tasks.md"), "- [ ] TASK-001 Implement\n  - test_refs: TEST-001\n  - invariant_refs: INV-001\n  - write_scope: src/feature.ts\n");
  const ref = eventFile(fx, "no-active-scoped-write", applyPatchEvent(fx, "*** Add File: src/feature.ts\n+export const value = 1;\n"));
  withRuntime({ load_context: () => [status(fx), fx.repo, fx.change, []] }, () => {
    const decision = captureMainJson(["hook-check-write", "--change", "demo-change", "--event-ref", ref]).payload;
    assert.equal(decision.allowed, true, JSON.stringify(decision));
    assert.equal(decision.enforcement, "pass-through");
    assert.ok(codes(decision.audit_only_reasons).includes("hook_session_missing"), JSON.stringify(decision.audit_only_reasons));
  });
});

withFixture("default managed hooks manifest excludes tool hooks", () => {
  const manifest = JSON.parse(readFileSync(join(process.cwd(), "templates/hooks/codex-hooks.json"), "utf8"));
  assertSubagentOnlyHookManifest(manifest);
});

withFixture("managed subagent-only hooks manifest is accepted by init health", (fx) => {
  writeText(join(fx.repo, ".codex", "hooks.json"), readFileSync(join(process.cwd(), "templates/hooks/codex-hooks.json"), "utf8"));
  const decision = guard.check_init("demo-change", status(fx), fx.repo, fx.change);
  assert.equal(decision.allowed, true);
  assert.equal(codes(decision.block_reasons).includes("hook_manifest_unmanaged"), false, JSON.stringify(decision.block_reasons));
});

withFixture("tampered managed hooks manifest downgrades strict profile", (fx) => {
  writeText(join(fx.repo, ".codex", "hooks.json"), JSON.stringify({
    superspec: { managed: true, adapter_version: "superspec-hook@2" },
    hooks: {},
  }, null, 2));
  const decision = guard.check_init("demo-change", status(fx), fx.repo, fx.change);
  assert.equal(decision.allowed, false);
  assert.ok(codes(decision.block_reasons).includes("hook_manifest_unmanaged"), JSON.stringify(decision.block_reasons));
});

withFixture("tampered managed hooks manifest matcher downgrades strict profile", (fx) => {
  const manifest = JSON.parse(readFileSync(join(process.cwd(), "templates/hooks/codex-hooks.json"), "utf8"));
  manifest.hooks.SubagentStart[0].matcher = "NotSubagentStart";
  writeText(join(fx.repo, ".codex", "hooks.json"), JSON.stringify(manifest, null, 2));
  const decision = guard.check_init("demo-change", status(fx), fx.repo, fx.change);
  assert.equal(decision.allowed, false);
  assert.ok(codes(decision.block_reasons).includes("hook_manifest_unmanaged"), JSON.stringify(decision.block_reasons));
});

withFixture("unsupported write surface without active session passes through with audit-only downgrade", (fx) => {
  const ref = eventFile(fx, "node-repl-ordinary", {
    hook_event_name: "PreToolUse",
    session_id: "manual-cli-session",
    turn_id: "turn-1",
    tool_name: "node_repl",
    tool_use_id: "tool-node-1",
    cwd: fx.repo,
    tool_input: { path: "src/ordinary.ts" },
  });
  withRuntime({ load_context: () => [status(fx), fx.repo, fx.change, []] }, () => {
    const decision = captureMainJson(["hook-check-write", "--change", "demo-change", "--event-ref", ref]).payload;
    assert.equal(decision.allowed, true);
    assert.equal(decision.enforcement, "pass-through");
    assert.ok(codes(decision.audit_only_reasons).includes("unsupported_write_surface"), JSON.stringify(decision.audit_only_reasons));
  });
});

withFixture("malformed hook event ref fails closed", (fx) => {
  const ref = eventFile(fx, "malformed", {});
  writeText(ref, "{not json\n");
  withRuntime({ load_context: () => [status(fx), fx.repo, fx.change, []] }, () => {
    const decision = captureMainJson(["hook-check-write", "--change", "demo-change", "--event-ref", ref]).payload;
    assert.equal(decision.allowed, false);
    assert.ok(codes(decision.block_reasons).includes("hook_event_invalid"), JSON.stringify(decision.block_reasons));
  });
});

withFixture("hook adapter rejects malformed stdin and event schemas", (fx) => {
  for (const [name, stdin] of [
    ["empty", ""],
    ["empty-object", "{}"],
    ["unknown-event", JSON.stringify({ hook_event_name: "Unknown", cwd: fx.repo })],
    ["pretool-missing-tool", JSON.stringify({ hook_event_name: "PreToolUse", cwd: fx.repo, tool_input: {} })],
    ["pretool-missing-input", JSON.stringify({ hook_event_name: "PreToolUse", cwd: fx.repo, tool_name: "Bash" })],
  ] as const) {
    const result = runHookAdapter([], stdin);
    assert.equal(result.code, 2, `${name}: ${result.stdout}`);
    assert.match(result.stderr, /SuperSpec hook event parse failed/);
  }
});

withFixture("active audit-only hook session denies write_scope edit before task_edit allow", (fx) => {
  writeText(join(fx.change, "tasks.md"), "- [ ] TASK-001 Implement\n  - test_refs: TEST-001\n  - invariant_refs: INV-001\n  - write_scope: src/feature.ts\n");
  beginAuditSession(fx);
  const ref = eventFile(fx, "write-scope", applyPatchEvent(fx, "*** Add File: src/feature.ts\n+export const value = 1;\n"));
  withRuntime({ load_context: () => [status(fx), fx.repo, fx.change, []] }, () => {
    const decision = captureMainJson(["hook-check-write", "--change", "demo-change", "--event-ref", ref]).payload;
    assert.equal(decision.allowed, false);
    const reasonCodes = codes(decision.block_reasons);
    assert.ok(codes(decision.audit_only_reasons).includes("hook_session_audit_only"), JSON.stringify(decision.audit_only_reasons));
    assert.ok(reasonCodes.includes("task_edit_missing"), JSON.stringify(decision.block_reasons));
    assert.ok(reasonCodes.includes("missing_red_evidence"), JSON.stringify(decision.block_reasons));
  });
});

withFixture("active audit-only hook session denies write_scope parent directory operations before task_edit allow", (fx) => {
  writeText(join(fx.change, "tasks.md"), "- [ ] TASK-001 Implement\n  - test_refs: TEST-001\n  - invariant_refs: INV-001\n  - write_scope: src/feature.ts\n- [ ] TASK-002 Nested\n  - test_refs: TEST-002\n  - invariant_refs: INV-002\n  - write_scope: src/sub/feature.ts\n");
  beginAuditSession(fx);
  const refs = [
    eventFile(fx, "write-scope-parent-rm", bashEvent(fx, "rm -rf src")),
    eventFile(fx, "write-scope-parent-glob-rm", bashEvent(fx, "rm -rf src/*")),
    eventFile(fx, "write-scope-parent-mv-outside", bashEvent(fx, "mv src /tmp/src.bak")),
    eventFile(fx, "write-scope-parent-mv-inside", bashEvent(fx, "mv src src.bak")),
    eventFile(fx, "write-scope-find-execdir-rm", bashEvent(fx, "find src -maxdepth 1 -name feature.ts -execdir rm -f feature.ts \\;")),
    eventFile(fx, "write-scope-find-delete", bashEvent(fx, "find src -name feature.ts -delete")),
    eventFile(fx, "write-scope-rsync", bashEvent(fx, "rsync /tmp/feature.ts src/feature.ts")),
    eventFile(fx, "write-scope-curl-output", bashEvent(fx, "curl -L https://example.invalid/feature.ts -o src/feature.ts")),
    eventFile(fx, "write-scope-wget-output", bashEvent(fx, "wget -O src/feature.ts https://example.invalid/feature.ts")),
    eventFile(fx, "write-scope-find-execdir-nested-rm", bashEvent(fx, "find src -path src/sub/feature.ts -execdir rm -f feature.ts \\;")),
  ];
  withRuntime({ load_context: () => [status(fx), fx.repo, fx.change, []] }, () => {
    for (const ref of refs) {
      const decision = captureMainJson(["hook-check-command", "--change", "demo-change", "--event-ref", ref]).payload;
      assert.equal(decision.allowed, false);
      const reasonCodes = codes(decision.block_reasons);
      assert.ok(reasonCodes.includes("task_edit_missing"), JSON.stringify(decision.block_reasons));
      assert.ok(reasonCodes.includes("missing_red_evidence"), JSON.stringify(decision.block_reasons));
    }
  });
});

withFixture("active audit-only hook session guards Edit and Write scoped paths", (fx) => {
  const tasksText = "- [ ] TASK-001 Implement\n  - test_refs: TEST-001\n  - invariant_refs: INV-001\n  - write_scope: src/feature.ts\n";
  writeText(join(fx.change, "tasks.md"), tasksText);
  beginAuditSession(fx);
  const refs = [
    eventFile(fx, "edit-scoped-path", {
      hook_event_name: "PreToolUse",
      session_id: "manual-cli-session",
      turn_id: "turn-1",
      tool_name: "Edit",
      tool_use_id: "tool-edit",
      cwd: fx.repo,
      tool_input: { file_path: "src/feature.ts", old_string: "before", new_string: "after" },
    }),
    eventFile(fx, "write-scoped-path", {
      hook_event_name: "PreToolUse",
      session_id: "manual-cli-session",
      turn_id: "turn-1",
      tool_name: "Write",
      tool_use_id: "tool-write",
      cwd: fx.repo,
      tool_input: { path: "src/feature.ts", content: "after" },
    }),
  ];
  withRuntime({ load_context: () => [status(fx), fx.repo, fx.change, []] }, () => {
    for (const ref of refs) {
      const decision = captureMainJson(["hook-check-write", "--change", "demo-change", "--event-ref", ref]).payload;
      assert.equal(decision.allowed, false);
      assert.ok(codes(decision.block_reasons).includes("task_edit_missing"), JSON.stringify(decision.block_reasons));
    }
  });
  const evidences = [...prepareProposeComplete(fx, { tasksText }), redEvidence()];
  withRuntime({ load_context: () => [status(fx), fx.repo, fx.change, evidences] }, () => {
    for (const ref of refs) {
      const decision = captureMainJson(["hook-check-write", "--change", "demo-change", "--event-ref", ref]).payload;
      assert.equal(decision.allowed, true, JSON.stringify(decision));
      assert.equal(decision.enforcement, "guarded");
    }
  });
});

withFixture("active audit-only hook session still guards mismatched hook session ids", (fx) => {
  writeText(join(fx.change, "tasks.md"), "- [ ] TASK-001 Implement\n  - test_refs: TEST-001\n  - invariant_refs: INV-001\n  - write_scope: src/feature.ts\n");
  beginAuditSession(fx);
  const ref = eventFile(fx, "write-scope-mismatched-session", applyPatchEvent(fx, "*** Add File: src/feature.ts\n+export const value = 1;\n", {
    session_id: "codex-real-session",
  }));
  withRuntime({ load_context: () => [status(fx), fx.repo, fx.change, []] }, () => {
    const decision = captureMainJson(["hook-check-write", "--change", "demo-change", "--event-ref", ref]).payload;
    assert.equal(decision.allowed, false);
    const reasonCodes = codes(decision.block_reasons);
    assert.ok(reasonCodes.includes("task_edit_missing"), JSON.stringify(decision.block_reasons));
    assert.ok(codes(decision.audit_only_reasons).includes("hook_session_session_mismatch"), JSON.stringify(decision.audit_only_reasons));
  });
});

withFixture("hook adapter infers change from active session when SUPERSPEC_CHANGE is missing", (fx) => {
  writeText(join(fx.change, "tasks.md"), "- [ ] TASK-001 Implement\n  - test_refs: TEST-001\n  - invariant_refs: INV-001\n  - write_scope: src/feature.ts\n");
  beginAuditSession(fx);
  const previous = process.env.SUPERSPEC_CHANGE;
  delete process.env.SUPERSPEC_CHANGE;
  try {
    withRuntime({ load_context: () => [status(fx), fx.repo, fx.change, []] }, () => {
      const result = runHookAdapter([], JSON.stringify(applyPatchEvent(fx, "*** Add File: src/feature.ts\n+export const value = 1;\n")));
      assert.equal(result.code, 0, result.stderr);
      const payload = JSON.parse(result.stdout);
      assert.equal(payload.hookSpecificOutput.permissionDecision, "deny", result.stdout);
      assert.match(payload.hookSpecificOutput.permissionDecisionReason, /task_edit/i);
    });
  } finally {
    if (previous === undefined) delete process.env.SUPERSPEC_CHANGE;
    else process.env.SUPERSPEC_CHANGE = previous;
  }
});

withFixture("hook adapter infers audit lease even when hook event has a real session id", (fx) => {
  writeText(join(fx.change, "tasks.md"), "- [ ] TASK-001 Implement\n  - test_refs: TEST-001\n  - invariant_refs: INV-001\n  - write_scope: src/feature.ts\n");
  const previousChange = process.env.SUPERSPEC_CHANGE;
  const previousSession = process.env.CODEX_SESSION_ID;
  delete process.env.SUPERSPEC_CHANGE;
  delete process.env.CODEX_SESSION_ID;
  try {
    beginAuditSession(fx);
    withRuntime({ load_context: () => [status(fx), fx.repo, fx.change, []] }, () => {
      const result = runHookAdapter([], JSON.stringify(applyPatchEvent(fx, "*** Add File: src/feature.ts\n+export const value = 1;\n", {
        session_id: "codex-real-session",
      })));
      assert.equal(result.code, 0, result.stderr);
      const payload = JSON.parse(result.stdout);
      assert.equal(payload.hookSpecificOutput.permissionDecision, "deny", result.stdout);
      assert.match(payload.hookSpecificOutput.permissionDecisionReason, /task_edit/i);
    });
  } finally {
    if (previousChange === undefined) delete process.env.SUPERSPEC_CHANGE;
    else process.env.SUPERSPEC_CHANGE = previousChange;
    if (previousSession === undefined) delete process.env.CODEX_SESSION_ID;
    else process.env.CODEX_SESSION_ID = previousSession;
  }
});

withFixture("hook adapter routes missing-after-active session state to Guard without SUPERSPEC_CHANGE", (fx) => {
  writeText(join(fx.change, "tasks.md"), "- [ ] TASK-001 Implement\n  - test_refs: TEST-001\n  - invariant_refs: INV-001\n  - write_scope: src/feature.ts\n");
  beginAuditSession(fx);
  rmSync(activeSessionFile(fx), { force: true });
  const previous = process.env.SUPERSPEC_CHANGE;
  delete process.env.SUPERSPEC_CHANGE;
  try {
    withRuntime({ load_context: () => [status(fx), fx.repo, fx.change, []] }, () => {
      const result = runHookAdapter([], JSON.stringify(applyPatchEvent(fx, "*** Add File: src/feature.ts\n+export const value = 1;\n")));
      assert.equal(result.code, 0, result.stderr);
      const payload = JSON.parse(result.stdout);
      assert.equal(payload.hookSpecificOutput.permissionDecision, "deny", result.stdout);
      assert.match(payload.hookSpecificOutput.permissionDecisionReason, /no active SuperSpec hook session|task_edit/i);
    });
  } finally {
    if (previous === undefined) delete process.env.SUPERSPEC_CHANGE;
    else process.env.SUPERSPEC_CHANGE = previous;
  }
});

withFixture("hook adapter active-session inference does not cross nested repo boundary", (fx) => {
  beginAuditSession(fx);
  const childRepo = join(fx.repo, "packages", "child");
  writeText(join(childRepo, "package.json"), "{}\n");
  writeText(join(childRepo, ".codex", "hooks.json"), "{}\n");
  const previous = process.env.SUPERSPEC_CHANGE;
  delete process.env.SUPERSPEC_CHANGE;
  try {
    withRuntime({ load_context: () => [status(fx), fx.repo, fx.change, []] }, () => {
      const result = runHookAdapter([], JSON.stringify(applyPatchEvent(fx, "*** Update File: .codex/hooks.json\n+{}\n", {
        cwd: childRepo,
      })));
      assert.equal(result.code, 0, result.stderr);
      const payload = JSON.parse(result.stdout);
      assert.equal(payload.hookSpecificOutput.permissionDecision, undefined, result.stdout);
      assert.match(payload.hookSpecificOutput.additionalContext, /inert/i);
    });
  } finally {
    if (previous === undefined) delete process.env.SUPERSPEC_CHANGE;
    else process.env.SUPERSPEC_CHANGE = previous;
  }
});

withFixture("hook adapter active-session inference stops at nested git repo boundary", (fx) => {
  writeText(join(fx.change, "tasks.md"), "- [ ] TASK-001 Implement\n  - test_refs: TEST-001\n  - invariant_refs: INV-001\n  - write_scope: packages/child/src/feature.ts\n");
  beginAuditSession(fx);
  const childRepo = join(fx.repo, "packages", "child");
  writeText(join(childRepo, ".git"), "gitdir: ../.git/modules/child\n");
  const previous = process.env.SUPERSPEC_CHANGE;
  delete process.env.SUPERSPEC_CHANGE;
  try {
    withRuntime({ load_context: () => [status(fx), fx.repo, fx.change, []] }, () => {
      const result = runHookAdapter([], JSON.stringify(applyPatchEvent(fx, "*** Add File: src/feature.ts\n+export const value = 1;\n", {
        cwd: childRepo,
      })));
      assert.equal(result.code, 0, result.stderr);
      const payload = JSON.parse(result.stdout);
      assert.equal(payload.hookSpecificOutput.permissionDecision, undefined, result.stdout);
      assert.match(payload.hookSpecificOutput.additionalContext, /inert/i);
    });
  } finally {
    if (previous === undefined) delete process.env.SUPERSPEC_CHANGE;
    else process.env.SUPERSPEC_CHANGE = previous;
  }
});

withFixture("hook adapter denies escaped parent trust-root writes from nested git repo", (fx) => {
  beginAuditSession(fx);
  const childRepo = join(fx.repo, "packages", "child");
  writeText(join(childRepo, ".git"), "gitdir: ../.git/modules/child\n");
  const previous = process.env.SUPERSPEC_CHANGE;
  delete process.env.SUPERSPEC_CHANGE;
  try {
    const result = runHookAdapter([], JSON.stringify(applyPatchEvent(
      fx,
      "*** Update File: ../../openspec/changes/demo-change/.superspec/superspec-state.json\n+{}\n",
      { cwd: childRepo },
    )));
    assert.equal(result.code, 0, result.stderr);
    const payload = JSON.parse(result.stdout);
    assert.equal(payload.hookSpecificOutput.permissionDecision, "deny", result.stdout);
    assert.match(payload.hookSpecificOutput.permissionDecisionReason, /escapes the current repository root/i);
  } finally {
    if (previous === undefined) delete process.env.SUPERSPEC_CHANGE;
    else process.env.SUPERSPEC_CHANGE = previous;
  }
});

withFixture("hook adapter without change allows Codex hook config but denies SuperSpec state roots", (fx) => {
  const previous = process.env.SUPERSPEC_CHANGE;
  delete process.env.SUPERSPEC_CHANGE;
  try {
    const codexHook = runHookAdapter([], JSON.stringify(applyPatchEvent(fx, "*** Update File: .codex/hooks.json\n+{}\n")));
    assert.equal(codexHook.code, 0, codexHook.stderr);
    const codexHookPayload = JSON.parse(codexHook.stdout);
    assert.equal(codexHookPayload.hookSpecificOutput.permissionDecision, undefined, codexHook.stdout);

    for (const [name, path] of [
      ["codex-config", ".codex/config.toml"],
      ["codex-skill", ".codex/skills/local/SKILL.md"],
      ["codex-prompt", ".codex/prompts/local.md"],
      ["codex-agent", ".codex/agents/local.toml"],
      ["omx-state", ".omx/state/local.json"],
    ] as const) {
      const result = runHookAdapter([], JSON.stringify(applyPatchEvent(fx, `*** Update File: ${path}\n+ok\n`)));
      assert.equal(result.code, 0, `${name}: ${result.stderr}`);
      const payload = JSON.parse(result.stdout);
      assert.equal(payload.hookSpecificOutput.permissionDecision, undefined, `${name}: ${result.stdout}`);
    }

    const superspecState = runHookAdapter([], JSON.stringify(applyPatchEvent(fx, "*** Update File: .codex/superspec/install-manifest.json\n+{}\n")));
    assert.equal(superspecState.code, 0, superspecState.stderr);
    const superspecPayload = JSON.parse(superspecState.stdout);
    assert.equal(superspecPayload.hookSpecificOutput.permissionDecision, "deny", superspecState.stdout);
    assert.match(superspecPayload.hookSpecificOutput.permissionDecisionReason, /trust roots/i);
  } finally {
    if (previous === undefined) delete process.env.SUPERSPEC_CHANGE;
    else process.env.SUPERSPEC_CHANGE = previous;
  }
});

withFixture("hook adapter without change denies apply_patch move destinations into trust roots", (fx) => {
  const previous = process.env.SUPERSPEC_CHANGE;
  delete process.env.SUPERSPEC_CHANGE;
  try {
    const result = runHookAdapter([], JSON.stringify(applyPatchEvent(fx, "*** Update File: src/ordinary.ts\n*** Move to: .codex/superspec/install-manifest.json\n+{}\n")));
    assert.equal(result.code, 0, result.stderr);
    const payload = JSON.parse(result.stdout);
    assert.equal(payload.hookSpecificOutput.permissionDecision, "deny", result.stdout);
    assert.match(payload.hookSpecificOutput.permissionDecisionReason, /trust roots/i);
  } finally {
    if (previous === undefined) delete process.env.SUPERSPEC_CHANGE;
    else process.env.SUPERSPEC_CHANGE = previous;
  }
});

withFixture("hook adapter without change denies trust root case variants", (fx) => {
  const previous = process.env.SUPERSPEC_CHANGE;
  delete process.env.SUPERSPEC_CHANGE;
  try {
    for (const [name, command] of [
      ["codex-superspec-case", "*** Update File: .CODEx/SuperSpec/install-manifest.json\n+{}\n"],
      ["superspec-case", "*** Update File: .SuperSpec/superspec-state.json\n+{}\n"],
      ["change-superspec-case", "*** Update File: openspec/changes/demo-change/.SuperSpec/superspec-state.json\n+{}\n"],
    ] as const) {
      const result = runHookAdapter([], JSON.stringify(applyPatchEvent(fx, command)));
      assert.equal(result.code, 0, `${name}: ${result.stderr}`);
      const payload = JSON.parse(result.stdout);
      assert.equal(payload.hookSpecificOutput.permissionDecision, "deny", `${name}: ${result.stdout}`);
    }
  } finally {
    if (previous === undefined) delete process.env.SUPERSPEC_CHANGE;
    else process.env.SUPERSPEC_CHANGE = previous;
  }
});

withFixture("hook adapter without change allows ordinary OpenSpec artifact writes", (fx) => {
  const previous = process.env.SUPERSPEC_CHANGE;
  delete process.env.SUPERSPEC_CHANGE;
  try {
    const result = runHookAdapter([], JSON.stringify(applyPatchEvent(fx, "*** Add File: openspec/changes/other-change/proposal.md\n+notes\n")));
    assert.equal(result.code, 0, result.stderr);
    const payload = JSON.parse(result.stdout);
    assert.equal(payload.hookSpecificOutput.permissionDecision, undefined, result.stdout);
    assert.match(payload.hookSpecificOutput.additionalContext, /inert/i);
  } finally {
    if (previous === undefined) delete process.env.SUPERSPEC_CHANGE;
    else process.env.SUPERSPEC_CHANGE = previous;
  }
});

withFixture("hook adapter without change denies trust roots from subdirectory cwd", (fx) => {
  writeText(join(fx.repo, "src", ".keep"), "");
  const previous = process.env.SUPERSPEC_CHANGE;
  delete process.env.SUPERSPEC_CHANGE;
  try {
    const patchResult = runHookAdapter([], JSON.stringify(applyPatchEvent(fx, "*** Update File: ../.codex/hooks.json\n+{}\n", {
      cwd: join(fx.repo, "src"),
    })));
    assert.equal(patchResult.code, 0, patchResult.stderr);
    const patchPayload = JSON.parse(patchResult.stdout);
    assert.equal(patchPayload.hookSpecificOutput.permissionDecision, undefined, patchResult.stdout);

    const bashResult = runHookAdapter([], JSON.stringify(bashEvent(fx, "rm -rf ../openspec/changes/demo-change/.superspec", {
      cwd: join(fx.repo, "src"),
    })));
    assert.equal(bashResult.code, 0, bashResult.stderr);
    const bashPayload = JSON.parse(bashResult.stdout);
    assert.equal(bashPayload.hookSpecificOutput.permissionDecision, "deny", bashResult.stdout);

    const globResult = runHookAdapter([], JSON.stringify(bashEvent(fx, "rm -rf ../.co*", {
      cwd: join(fx.repo, "src"),
    })));
    assert.equal(globResult.code, 0, globResult.stderr);
    const globPayload = JSON.parse(globResult.stdout);
    assert.equal(globPayload.hookSpecificOutput.permissionDecision, "deny", globResult.stdout);
  } finally {
    if (previous === undefined) delete process.env.SUPERSPEC_CHANGE;
    else process.env.SUPERSPEC_CHANGE = previous;
  }
});

withFixture("hook adapter without change denies trust root parent deletes", (fx) => {
  const previous = process.env.SUPERSPEC_CHANGE;
  delete process.env.SUPERSPEC_CHANGE;
  try {
    for (const [name, command, expected] of [
      ["codex-root", "rm -rf .codex"],
      ["codex-static-sibling-prefix", "rm -rf .co", "allow"],
      ["codex-superspec-static-sibling-prefix", "rm -rf .codex/super", "allow"],
      ["codex-skills", "rm -rf .codex/skills", "allow"],
      ["codex-config", "rm -f .codex/config.toml", "allow"],
      ["codex-prompts", "rm -rf .codex/prompts", "allow"],
      ["codex-agents", "rm -rf .codex/agents", "allow"],
      ["omx-state", "rm -rf .omx/state", "allow"],
      ["openspec-change-static-sibling-prefix", "rm -rf openspec/change", "allow"],
      ["change-root", "rm -rf openspec/changes/demo-change"],
    ] as const) {
      const result = runHookAdapter([], JSON.stringify(bashEvent(fx, command)));
      assert.equal(result.code, 0, `${name}: ${result.stderr}`);
      const payload = JSON.parse(result.stdout);
      if (expected === "allow") {
        assert.equal(payload.hookSpecificOutput.permissionDecision, undefined, `${name}: ${result.stdout}`);
      } else {
        assert.equal(payload.hookSpecificOutput.permissionDecision, "deny", `${name}: ${result.stdout}`);
      }
    }
  } finally {
    if (previous === undefined) delete process.env.SUPERSPEC_CHANGE;
    else process.env.SUPERSPEC_CHANGE = previous;
  }
});

withFixture("hook adapter without change denies nested shell trust-root writes", (fx) => {
  const previous = process.env.SUPERSPEC_CHANGE;
  delete process.env.SUPERSPEC_CHANGE;
  try {
    for (const [name, command] of [
      ["nested-rm", "sh -c 'rm -rf openspec/changes/demo-change/.superspec'"],
      ["newline-rm", "echo ok\nrm -rf .codex"],
      ["group-rm", "( rm -rf .codex )"],
      ["brace-group-rm", "{ rm -rf .codex; }"],
      ["eval-rm", "eval \"rm -rf .codex\""],
      ["builtin-eval-rm", "builtin eval \"rm -rf .codex\""],
      ["fd-prefix-rm", "2>/dev/null rm -rf .codex"],
      ["env-s-rm", "env -S \"rm -rf .codex\""],
      ["dollar-substitution-rm", "echo \"$(rm -rf .superspec)\""],
      ["find-exec-group-rm", "find . \\( -name foo \\) -exec rm -rf .superspec \\;"],
      ["find-exec-sh-c-rm", "find . -exec sh -c 'rm -rf .codex' \\;"],
      ["find-exec-bash-lc-rm", "find . -exec bash -lc 'rm -rf .codex' \\;"],
      ["find-exec-env-s-rm", "find . -exec env -S 'rm -rf .codex' \\;"],
      ["find-execdir-rm", "find .codex -maxdepth 1 -name superspec -execdir rm -rf superspec \\;"],
      ["find-execdir-quote-split-predicate-rm", "find .co'dex' -path .co'dex'/superspec/install-manifest.json -execdir rm -f install-manifest.json \\;"],
      ["find-execdir-broad-root-name-rm", "find . -name install-manifest.json -execdir rm -f install-manifest.json \\;"],
      ["find-delete-codex-superspec", "find .codex/superspec -delete"],
      ["find-delete-change-superspec", "find openspec/changes/demo-change/.superspec -delete"],
      ["rsync-directory-basename", "rsync /tmp/superspec .codex"],
      ["rsync-delete-codex-parent", "rsync -a --delete /tmp/empty/ .codex/"],
      ["rsync-delete-change-parent", "rsync -a --delete /tmp/empty/ openspec/changes/demo-change/"],
      ["curl-remote-name-cd", "cd .codex; curl -O https://example.invalid/superspec"],
      ["curl-remote-name-url-option-cd", "cd .codex; curl -O --url=https://example.invalid/superspec"],
      ["curl-config-stdin-trust-root", "curl -K - <<EOF\nurl = \"https://example.invalid/state\"\noutput = \".codex/superspec/pwn\"\nEOF"],
      ["curl-config-file-unknown-target", "curl --config curl.conf"],
      ["curl-output-dir-output-relative", "curl --output-dir .codex --output superspec/install-manifest.json https://example.invalid/state"],
      ["curl-output-dir-short-output-relative", "curl --output-dir=.co'dex' -o superspec/install-manifest.json https://example.invalid/state"],
      ["curl-output-dir-attached-output-relative", "curl --output-dir .codex -osuperspec/install-manifest.json https://example.invalid/state"],
      ["curl-output-before-output-dir-relative", "curl -o superspec/install-manifest.json --output-dir .codex https://example.invalid/state"],
      ["curl-dump-header-trust-root", "curl -D .codex/superspec/headers https://example.invalid/state"],
      ["curl-cookie-jar-trust-root", "curl --cookie-jar .codex/superspec/cookies https://example.invalid/state"],
      ["curl-trace-trust-root", "curl --trace .codex/superspec/trace https://example.invalid/state"],
      ["curl-trace-ascii-trust-root", "curl --trace-ascii .codex/superspec/trace.txt https://example.invalid/state"],
      ["curl-stderr-trust-root", "curl --stderr .codex/superspec/stderr https://example.invalid/state"],
      ["curl-libcurl-trust-root", "curl --libcurl .codex/superspec/client.c https://example.invalid/state"],
      ["curl-etag-save-trust-root", "curl --etag-save .codex/superspec/etag https://example.invalid/state"],
      ["curl-dump-header-missing-target", "curl -D"],
      ["wget-directory-prefix-basename", "wget -P .codex https://example.invalid/superspec"],
    ] as const) {
      const result = runHookAdapter([], JSON.stringify(bashEvent(fx, command)));
      assert.equal(result.code, 0, `${name}: ${result.stderr}`);
      const payload = JSON.parse(result.stdout);
      assert.equal(payload.hookSpecificOutput.permissionDecision, "deny", `${name}: ${result.stdout}`);
    }
    const nestedCodexHook = runHookAdapter([], JSON.stringify(bashEvent(fx, "bash -lc \"cp /tmp/state.json .codex/hooks.json\"")));
    assert.equal(nestedCodexHook.code, 0, nestedCodexHook.stderr);
    const nestedCodexHookPayload = JSON.parse(nestedCodexHook.stdout);
    assert.equal(nestedCodexHookPayload.hookSpecificOutput.permissionDecision, undefined, nestedCodexHook.stdout);
  } finally {
    if (previous === undefined) delete process.env.SUPERSPEC_CHANGE;
    else process.env.SUPERSPEC_CHANGE = previous;
  }
});

withFixture("hook adapter without change denies package runner hook writers", (fx) => {
  const previous = process.env.SUPERSPEC_CHANGE;
  delete process.env.SUPERSPEC_CHANGE;
  try {
    for (const [name, command] of [
      ["npx-call-writer", "npx --package @peterxiaoyang/superspec --call \"superspec-guard hook-record-test --change demo-change --event-ref forged.json\""],
      ["npm-workspace-cancel", "npm --workspace app exec superspec-guard hook-session-end --change demo-change --reason cancelled"],
      ["npm-exec-short-workspace-cancel", "npm exec -w app superspec-guard hook-session-end --change demo-change --reason cancelled"],
      ["npm-x-short-workspace-cancel", "npm x -w app superspec-guard hook-session-end --change demo-change --reason cancelled"],
      ["npm-exec-short-workspace-separator-cancel", "npm exec -w app -- superspec-guard hook-session-end --change demo-change --reason cancelled"],
      ["pnpm-filter-cancel", "pnpm --filter app exec superspec-guard hook-session-end --change demo-change --reason cancelled"],
      ["pnpm-short-filter-cancel", "pnpm -F app exec superspec-guard hook-session-end --change demo-change --reason cancelled"],
      ["yarn-workspace-cancel", "yarn workspace app exec superspec-guard hook-session-end --change demo-change --reason cancelled"],
      ["yarn-cwd-workspace-cancel", "yarn --cwd . workspace app exec superspec-guard hook-session-end --change demo-change --reason cancelled"],
    ] as const) {
      const result = runHookAdapter([], JSON.stringify(bashEvent(fx, command)));
      assert.equal(result.code, 0, `${name}: ${result.stderr}`);
      const payload = JSON.parse(result.stdout);
      assert.equal(payload.hookSpecificOutput.permissionDecision, "deny", `${name}: ${result.stdout}`);
    }
  } finally {
    if (previous === undefined) delete process.env.SUPERSPEC_CHANGE;
    else process.env.SUPERSPEC_CHANGE = previous;
  }
});

withFixture("hook adapter without change denies trust root shell globs", (fx) => {
  const previous = process.env.SUPERSPEC_CHANGE;
  delete process.env.SUPERSPEC_CHANGE;
  try {
    for (const [name, command] of [
      ["codex-glob", "rm -rf .codex/*"],
      ["codex-brace", "rm -rf .codex/{superspec,skills}"],
      ["codex-prefix-glob", "rm -rf .co*"],
      ["codex-prefix-brace", "rm -rf .co{dex,}/superspec"],
      ["codex-absolute-prefix-glob", `rm -rf ${join(fx.repo, ".co")}*`],
      ["change-glob", "rm -rf openspec/changes/demo-change/*"],
      ["change-superspec-prefix-glob", "rm -rf openspec/changes/demo-change/.su*"],
    ] as const) {
      const result = runHookAdapter([], JSON.stringify(bashEvent(fx, command)));
      assert.equal(result.code, 0, `${name}: ${result.stderr}`);
      const payload = JSON.parse(result.stdout);
      assert.equal(payload.hookSpecificOutput.permissionDecision, "deny", `${name}: ${result.stdout}`);
    }
  } finally {
    if (previous === undefined) delete process.env.SUPERSPEC_CHANGE;
    else process.env.SUPERSPEC_CHANGE = previous;
  }
});

withFixture("hook adapter without change denies trust root shell option operands", (fx) => {
  const previous = process.env.SUPERSPEC_CHANGE;
  delete process.env.SUPERSPEC_CHANGE;
  try {
    for (const [name, command, expected] of [
      ["cp-double-dash", "cp -- /tmp/state.json .codex/superspec/install-manifest.json"],
      ["cp-target-directory", "cp -t .codex /tmp/state.json", "allow"],
      ["cp-attached-target-directory", "cp -t.codex /tmp/state.json", "allow"],
      ["cp-target-directory-basename", "cp -R -t .codex /tmp/superspec"],
      ["cp-target-directory-glob-basename", "cp -R -t .codex /tmp/super*"],
      ["cp-directory-basename", "cp -R /tmp/superspec .codex"],
      ["install-mode", "install -m 0644 /tmp/state.json .codex/superspec/install-manifest.json"],
      ["install-target-directory-basename", "install -t .codex /tmp/superspec"],
      ["install-directory-basename", "install /tmp/superspec .codex"],
      ["rm-third-operand", "rm -f foo bar .codex/superspec/install-manifest.json"],
      ["touch", "touch .codex/superspec/install-manifest.json"],
      ["truncate", "truncate -s 0 .codex/superspec/install-manifest.json"],
      ["ln", "ln -sf /tmp/state.json .codex/superspec/install-manifest.json"],
      ["ln-directory-basename", "ln -s /tmp/superspec .codex"],
      ["mv-target-directory", "mv -t .codex /tmp/state.json", "allow"],
      ["mv-target-directory-equals", "mv --target-directory=.co'dex' /tmp/state.json", "allow"],
      ["mv-target-directory-basename", "mv -t .codex /tmp/superspec"],
      ["mv-directory-basename", "mv /tmp/superspec .codex"],
      ["dd-of", "dd if=/tmp/state.json of=.codex/superspec/install-manifest.json"],
      ["rsync-remove-source-files", "rsync --remove-source-files .co'dex'/superspec/install-manifest.json src/backup/"],
      ["rsync-backup-dir", "rsync --backup --backup-dir=.co'dex'/superspec /tmp/a src/a"],
      ["rsync-partial-dir-basename", "rsync --partial-dir=.codex /tmp/superspec src/"],
      ["rsync-temp-dir-short", "rsync -T .codex /tmp/superspec src/"],
      ["rsync-temp-dir-short-attached", "rsync -T.co'dex' /tmp/superspec src/"],
      ["rsync-write-batch", "rsync --write-batch=.co'dex'/superspec/batch /tmp/a src/a"],
      ["rsync-delete-codex-parent", "rsync -a --delete /tmp/empty/ .codex/"],
      ["rsync-delete-delay-change-parent", "rsync -a --delete-delay /tmp/empty/ openspec/changes/demo-change/"],
      ["rsync-delete-codex-parent-post-include", "rsync -a --delete /tmp/empty/ .codex/ --include superspec"],
      ["rsync-delete-change-parent-post-exclude", "rsync -a --delete /tmp/empty/ openspec/changes/demo-change/ --exclude superspec-state.json"],
      ["tar-extract-codex-member", "tar -xf /tmp/state.tar -C .codex superspec"],
      ["tar-extract-codex-member-gzip", "tar -xzf /tmp/state.tar.gz -C .codex superspec/install-manifest.json"],
      ["tar-extract-codex-member-before-second-c", "tar -xf /tmp/state.tar -C .codex superspec/install-manifest.json -C src"],
      ["tar-old-style-extract-codex-member", "tar xCf .codex state.tar superspec/install-manifest.json"],
      ["tar-extract-codex-strip-components", "tar -xf /tmp/state.tar -C .codex --strip-components=1 x/superspec/install-manifest.json"],
      ["tar-extract-codex-unknown-members", "tar -xf /tmp/state.tar -C .codex"],
      ["tar-create-trust-root-archive", "tar -cf .codex/superspec/state.tar src"],
      ["tar-create-trust-root-file-before-mode", "tar --file=.co'dex'/superspec/state.tar --create src"],
      ["tar-create-trust-root-old-style", "tar cf .codex/superspec/state.tar src"],
      ["tar-create-trust-root-old-style-c-c-f", "tar cCf .codex .codex/superspec/state.tar src"],
      ["unzip-extract-codex-member", "unzip /tmp/state.zip -d .codex superspec/install-manifest.json"],
      ["unzip-extract-codex-unknown-members", "unzip /tmp/state.zip -d .codex"],
      ["curl-header-derived-name-output-dir", "curl -OJ --output-dir .codex https://example.invalid/download"],
      ["wget-content-disposition-directory-prefix", "wget --content-disposition -P .codex https://example.invalid/download"],
      ["wget-attached-directory-prefix-basename", "wget -P.codex https://example.invalid/superspec"],
      ["wget-combined-attached-directory-prefix-basename", "wget -qP.co'dex' https://example.invalid/superspec"],
    ] as const) {
      const result = runHookAdapter([], JSON.stringify(bashEvent(fx, command)));
      assert.equal(result.code, 0, `${name}: ${result.stderr}`);
      const payload = JSON.parse(result.stdout);
      if (expected === "allow") {
        assert.equal(payload.hookSpecificOutput.permissionDecision, undefined, `${name}: ${result.stdout}`);
      } else {
        assert.equal(payload.hookSpecificOutput.permissionDecision, "deny", `${name}: ${result.stdout}`);
      }
    }
  } finally {
    if (previous === undefined) delete process.env.SUPERSPEC_CHANGE;
    else process.env.SUPERSPEC_CHANGE = previous;
  }
});

withFixture("hook adapter without change denies links sourced from trust roots", (fx) => {
  const previous = process.env.SUPERSPEC_CHANGE;
  delete process.env.SUPERSPEC_CHANGE;
  try {
    const result = runHookAdapter([], JSON.stringify(bashEvent(fx, "ln -sf .co'dex'/superspec/install-manifest.json src/feature.ts")));
    assert.equal(result.code, 0, result.stderr);
    const payload = JSON.parse(result.stdout);
    assert.equal(payload.hookSpecificOutput.permissionDecision, "deny", result.stdout);
    assert.match(payload.hookSpecificOutput.permissionDecisionReason, /link source/i);
  } finally {
    if (previous === undefined) delete process.env.SUPERSPEC_CHANGE;
    else process.env.SUPERSPEC_CHANGE = previous;
  }
});

withFixture("hook adapter without change allows Bash copy from external source into ordinary project file", (fx) => {
  const previous = process.env.SUPERSPEC_CHANGE;
  delete process.env.SUPERSPEC_CHANGE;
  try {
    const result = runHookAdapter([], JSON.stringify(bashEvent(fx, "cp /tmp/state.json src/ordinary.ts")));
    assert.equal(result.code, 0, result.stderr);
    const payload = JSON.parse(result.stdout);
    assert.equal(payload.hookSpecificOutput.permissionDecision, undefined, result.stdout);
    assert.match(payload.hookSpecificOutput.additionalContext, /inert/i);
  } finally {
    if (previous === undefined) delete process.env.SUPERSPEC_CHANGE;
    else process.env.SUPERSPEC_CHANGE = previous;
  }
});

withFixture("hook adapter without change denies pathless write-capable trust-root text", (fx) => {
  const previous = process.env.SUPERSPEC_CHANGE;
  delete process.env.SUPERSPEC_CHANGE;
  try {
    const deniedEvents = [
      bashEvent(fx, "node -e \"require('fs').writeFileSync('.codex/superspec/install-manifest.json','{}')\""),
      {
        hook_event_name: "PreToolUse",
        session_id: "manual-cli-session",
        turn_id: "turn-1",
        tool_name: "mcp__runner",
        tool_use_id: "tool-mcp",
        cwd: fx.repo,
        tool_input: { code: "fs.writeFileSync('.codex/superspec/install-manifest.json', '{}')" },
      },
      {
        hook_event_name: "PreToolUse",
        session_id: "manual-cli-session",
        turn_id: "turn-1",
        tool_name: "node_repl",
        tool_use_id: "tool-node",
        cwd: fx.repo,
        tool_input: { code: "require('fs').writeFileSync('openspec/changes/demo-change/.superspec/raw/x.log', 'x')" },
      },
      {
        hook_event_name: "PreToolUse",
        session_id: "manual-cli-session",
        turn_id: "turn-1",
        tool_name: "node_repl",
        tool_use_id: "tool-node-change-root",
        cwd: fx.repo,
        tool_input: { code: "require('fs').rmSync('openspec/changes/demo-change', { recursive: true, force: true })" },
      },
      {
        hook_event_name: "PreToolUse",
        session_id: "manual-cli-session",
        turn_id: "turn-1",
        tool_name: "mcp__node_repl",
        tool_use_id: "tool-mcp-find-delete",
        cwd: fx.repo,
        tool_input: { code: "find .codex/superspec -delete" },
      },
      {
        hook_event_name: "PreToolUse",
        session_id: "manual-cli-session",
        turn_id: "turn-1",
        tool_name: "mcp__node_repl",
        tool_use_id: "tool-mcp-rsync",
        cwd: fx.repo,
        tool_input: { code: "rsync /tmp/state .co'dex'/superspec/state" },
      },
      {
        hook_event_name: "PreToolUse",
        session_id: "manual-cli-session",
        turn_id: "turn-1",
        tool_name: "mcp__node_repl",
        tool_use_id: "tool-mcp-curl",
        cwd: fx.repo,
        tool_input: { code: "curl -o .codex/superspec/state https://example.invalid/state" },
      },
      {
        hook_event_name: "PreToolUse",
        session_id: "manual-cli-session",
        turn_id: "turn-1",
        tool_name: "mcp__node_repl",
        tool_use_id: "tool-mcp-wget",
        cwd: fx.repo,
        tool_input: { code: "wget -O .codex/superspec/state https://example.invalid/state" },
      },
      {
        hook_event_name: "PreToolUse",
        session_id: "manual-cli-session",
        turn_id: "turn-1",
        tool_name: "unified_exec",
        tool_use_id: "tool-exec",
        cwd: fx.repo,
        tool_input: { args: ["python", "-c", "open('.superspec/state.json', 'w').write('{}')"] },
      },
    ];
    for (const event of deniedEvents) {
      const result = runHookAdapter([], JSON.stringify(event));
      assert.equal(result.code, 0, result.stderr);
      const payload = JSON.parse(result.stdout);
      assert.equal(payload.hookSpecificOutput.permissionDecision, "deny", result.stdout);
      assert.match(payload.hookSpecificOutput.permissionDecisionReason, /trust roots/i);
    }

    const readOnly = runHookAdapter([], JSON.stringify(bashEvent(fx, "echo .codex/hooks.json")));
    assert.equal(readOnly.code, 0, readOnly.stderr);
    const payload = JSON.parse(readOnly.stdout);
    assert.equal(payload.hookSpecificOutput.permissionDecision, undefined, readOnly.stdout);
    const codexHookWrite = runHookAdapter([], JSON.stringify(bashEvent(fx, "node -e \"require('fs').writeFileSync('.codex/hooks.json','{}')\"")));
    assert.equal(codexHookWrite.code, 0, codexHookWrite.stderr);
    const codexHookWritePayload = JSON.parse(codexHookWrite.stdout);
    assert.equal(codexHookWritePayload.hookSpecificOutput.permissionDecision, undefined, codexHookWrite.stdout);
    const readOnlyChangeRoot = runHookAdapter([], JSON.stringify(bashEvent(fx, "echo openspec/changes/demo-change")));
    assert.equal(readOnlyChangeRoot.code, 0, readOnlyChangeRoot.stderr);
    const changeRootPayload = JSON.parse(readOnlyChangeRoot.stdout);
    assert.equal(changeRootPayload.hookSpecificOutput.permissionDecision, undefined, readOnlyChangeRoot.stdout);
  } finally {
    if (previous === undefined) delete process.env.SUPERSPEC_CHANGE;
    else process.env.SUPERSPEC_CHANGE = previous;
  }
});

withFixture("hook adapter without change denies writes when active session inference is ambiguous", (fx) => {
  writeText(
    join(fx.repo, "openspec", "changes", "other-change", ".superspec", "hook-runtime", "active-sessions", "other.json"),
    `${JSON.stringify(validSessionRecord(fx, "other-change"), null, 2)}\n`,
  );
  beginAuditSession(fx);
  const previous = process.env.SUPERSPEC_CHANGE;
  delete process.env.SUPERSPEC_CHANGE;
  try {
    const result = runHookAdapter([], JSON.stringify(applyPatchEvent(fx, "*** Add File: src/feature.ts\n+export const value = 1;\n")));
    assert.equal(result.code, 0, result.stderr);
    const payload = JSON.parse(result.stdout);
    assert.equal(payload.hookSpecificOutput.permissionDecision, "deny", result.stdout);
    assert.match(payload.hookSpecificOutput.permissionDecisionReason, /multiple active SuperSpec sessions/i);
  } finally {
    if (previous === undefined) delete process.env.SUPERSPEC_CHANGE;
    else process.env.SUPERSPEC_CHANGE = previous;
  }
});

withFixture("hook adapter treats corrupt stale and mismatched hook-runtime state as ambiguous after activation", (fx) => {
  writeText(join(fx.repo, "openspec", "changes", "corrupt-change", ".superspec", "hook-runtime", "active-sessions", "corrupt.json"), "{}\n");
  writeText(
    join(fx.repo, "openspec", "changes", "stale-change", ".superspec", "hook-runtime", "active-sessions", "stale.json"),
    `${JSON.stringify(validSessionRecord(fx, "stale-change", { expires_at: new Date(Date.now() - 60_000).toISOString() }), null, 2)}\n`,
  );
  writeText(
    join(fx.repo, "openspec", "changes", "mismatch-change", ".superspec", "hook-runtime", "active-sessions", "mismatch.json"),
    `${JSON.stringify(validSessionRecord(fx, "mismatch-change", { session_id: "other-session" }), null, 2)}\n`,
  );
  const previous = process.env.SUPERSPEC_CHANGE;
  delete process.env.SUPERSPEC_CHANGE;
  try {
    const result = runHookAdapter([], JSON.stringify(applyPatchEvent(fx, "*** Add File: src/ordinary.ts\n+ok\n")));
    assert.equal(result.code, 0, result.stderr);
    const payload = JSON.parse(result.stdout);
    assert.equal(payload.hookSpecificOutput.permissionDecision, "deny", result.stdout);
    assert.match(payload.hookSpecificOutput.permissionDecisionReason, /multiple active SuperSpec sessions/i);
  } finally {
    if (previous === undefined) delete process.env.SUPERSPEC_CHANGE;
    else process.env.SUPERSPEC_CHANGE = previous;
  }
});

withFixture("hook adapter lifecycle command policy distinguishes bootstrap status and unsafe termination", (fx) => {
  const previous = process.env.SUPERSPEC_CHANGE;
  delete process.env.SUPERSPEC_CHANGE;
  try {
    for (const [name, command, denied] of [
      ["begin", "superspec guard hook-session-begin --change demo-change --workflow superspec-apply --entrypoint-token token", false],
      ["status", "superspec guard hook-session-status --change demo-change", false],
      ["completed", "superspec guard hook-session-end --change demo-change --reason completed", false],
      ["archived", "superspec guard hook-session-end --change demo-change --reason archived", false],
      ["cancelled", "superspec guard hook-session-end --change demo-change --reason cancelled", true],
      ["abandoned", "superspec guard hook-session-end --change demo-change --reason=abandoned", true],
      ["cancelled-quoted", "superspec guard hook-session-end --change demo-change --reason \"cancelled\"", true],
      ["abandoned-compat-quoted", "superspec-guard hook-session-end --change demo-change --reason='abandoned'", true],
      ["cancelled-shell-wrapper", "bash -lc \"superspec guard hook-session-end --change demo-change --reason cancelled\"", true],
      ["abandoned-shell-wrapper", "sh -c \"superspec-guard hook-session-end --change demo-change --reason=abandoned\"", true],
      ["status-shell-wrapper", "bash -lc \"superspec guard hook-session-status --change demo-change\"", false],
    ] as const) {
      const result = runHookAdapter([], JSON.stringify(bashEvent(fx, command)));
      assert.equal(result.code, 0, `${name}: ${result.stderr}`);
      const payload = JSON.parse(result.stdout);
      if (denied) {
        assert.equal(payload.hookSpecificOutput.permissionDecision, "deny", `${name}: ${result.stdout}`);
      } else {
        assert.equal(payload.hookSpecificOutput.permissionDecision, undefined, `${name}: ${result.stdout}`);
        assert.match(payload.hookSpecificOutput.additionalContext, /inert/i, `${name}: ${result.stdout}`);
      }
    }
  } finally {
    if (previous === undefined) delete process.env.SUPERSPEC_CHANGE;
    else process.env.SUPERSPEC_CHANGE = previous;
  }
});

withFixture("active audit-only hook session denies unsupported scoped write surfaces", (fx) => {
  writeText(join(fx.change, "tasks.md"), "- [ ] TASK-001 Implement\n  - test_refs: TEST-001\n  - invariant_refs: INV-001\n  - write_scope: src/feature.ts\n");
  beginAuditSession(fx);
  const ref = eventFile(fx, "node-repl-scoped", {
    hook_event_name: "PreToolUse",
    session_id: "manual-cli-session",
    turn_id: "turn-1",
    tool_name: "node_repl",
    tool_use_id: "tool-node-1",
    cwd: fx.repo,
    tool_input: { path: "src/feature.ts" },
  });
  withRuntime({ load_context: () => [status(fx), fx.repo, fx.change, []] }, () => {
    const decision = captureMainJson(["hook-check-write", "--change", "demo-change", "--event-ref", ref]).payload;
    assert.equal(decision.allowed, false);
    const reasonCodes = codes(decision.block_reasons);
    assert.ok(reasonCodes.includes("unsupported_write_surface"), JSON.stringify(decision.block_reasons));
    assert.ok(reasonCodes.includes("task_edit_missing"), JSON.stringify(decision.block_reasons));
  });
});

withFixture("hook check write denies escaped target paths outside repo root", (fx) => {
  const childRepo = join(fx.repo, "packages", "child");
  const childChange = join(childRepo, "openspec", "changes", "child-change");
  writeText(join(childChange, "tasks.md"), "- [ ] TASK-001 Implement\n");
  const ref = eventFile(fx, "outside-repo-target", applyPatchEvent(fx, "*** Add File: ../outside.txt\n+escape\n", {
    cwd: childRepo,
  }));
  const childStatus = {
    ...status(fx),
    changeRoot: childChange,
    planningHome: { root: childRepo },
  };
  withRuntime({ load_context: () => [childStatus, childRepo, childChange, []] }, () => {
    const decision = captureMainJson(["hook-check-write", "--change", "child-change", "--event-ref", ref]).payload;
    assert.equal(decision.allowed, false);
    assert.ok(codes(decision.block_reasons).includes("target_path_outside_repo"), JSON.stringify(decision.block_reasons));
  });
});

withFixture("hook check write denies attached short option target directories outside repo root", (fx) => {
  const childRepo = join(fx.repo, "packages", "child");
  const childChange = join(childRepo, "openspec", "changes", "child-change");
  writeText(join(childChange, "tasks.md"), "- [ ] TASK-001 Implement\n");
  const ref = eventFile(fx, "attached-target-dir-outside-repo", bashEvent(fx, "cp -t../outside src/ordinary.ts", {
    cwd: childRepo,
  }));
  const childStatus = {
    ...status(fx),
    changeRoot: childChange,
    planningHome: { root: childRepo },
  };
  withRuntime({ load_context: () => [childStatus, childRepo, childChange, []] }, () => {
    const decision = captureMainJson(["hook-check-command", "--change", "child-change", "--event-ref", ref]).payload;
    assert.equal(decision.allowed, false);
    assert.ok(codes(decision.block_reasons).includes("target_path_outside_repo"), JSON.stringify(decision.block_reasons));
  });
});

withFixture("hook check command denies shell redirection destinations outside repo root", (fx) => {
  const childRepo = join(fx.repo, "packages", "child");
  const childChange = join(childRepo, "openspec", "changes", "child-change");
  writeText(join(childChange, "tasks.md"), "- [ ] TASK-001 Implement\n");
  const refs = [
    eventFile(fx, "append-redirection-outside-repo", bashEvent(fx, "echo x >> ../outside.txt", {
      cwd: childRepo,
    })),
    eventFile(fx, "noclobber-redirection-outside-repo", bashEvent(fx, "echo x >| ../outside.txt", {
      cwd: childRepo,
    })),
    eventFile(fx, "stdout-stderr-redirection-outside-repo", bashEvent(fx, "echo x &> ../outside.txt", {
      cwd: childRepo,
    })),
    eventFile(fx, "stdout-stderr-append-redirection-outside-repo", bashEvent(fx, "echo x &>> ../outside.txt", {
      cwd: childRepo,
    })),
    eventFile(fx, "legacy-stdout-stderr-redirection-outside-repo", bashEvent(fx, "echo x >& ../outside.txt", {
      cwd: childRepo,
    })),
    eventFile(fx, "tilde-redirection-outside-repo", bashEvent(fx, "echo x > ~/outside.txt", {
      cwd: childRepo,
    })),
  ];
  const childStatus = {
    ...status(fx),
    changeRoot: childChange,
    planningHome: { root: childRepo },
  };
  withRuntime({ load_context: () => [childStatus, childRepo, childChange, []] }, () => {
    for (const ref of refs) {
      const decision = captureMainJson(["hook-check-command", "--change", "child-change", "--event-ref", ref]).payload;
      assert.equal(decision.allowed, false);
      assert.ok(codes(decision.block_reasons).includes("target_path_outside_repo"), JSON.stringify(decision.block_reasons));
    }
  });
});

withFixture("hook check command tracks shell cd before write targets", (fx) => {
  const childRepo = join(fx.repo, "packages", "child");
  const childChange = join(childRepo, "openspec", "changes", "child-change");
  writeText(join(childChange, "tasks.md"), "- [ ] TASK-001 Implement\n");
  const refs = [
    eventFile(fx, "cd-before-redirection-outside-repo", bashEvent(fx, "cd .. && echo x > outside.txt", {
      cwd: childRepo,
    })),
    eventFile(fx, "cd-before-nested-redirection-outside-repo", bashEvent(fx, "cd ..; sh -c 'echo x > outside.txt'", {
      cwd: childRepo,
    })),
  ];
  const childStatus = {
    ...status(fx),
    changeRoot: childChange,
    planningHome: { root: childRepo },
  };
  withRuntime({ load_context: () => [childStatus, childRepo, childChange, []] }, () => {
    for (const ref of refs) {
      const decision = captureMainJson(["hook-check-command", "--change", "child-change", "--event-ref", ref]).payload;
      assert.equal(decision.allowed, false);
      assert.ok(codes(decision.block_reasons).includes("target_path_outside_repo"), JSON.stringify(decision.block_reasons));
    }
  });
});

withFixture("hook check write denies symlink-resolved targets outside repo root", (fx) => {
  const childRepo = join(fx.repo, "packages", "child");
  const childChange = join(childRepo, "openspec", "changes", "child-change");
  const outside = join(fx.repo, "outside-target");
  writeText(join(childChange, "tasks.md"), "- [ ] TASK-001 Implement\n");
  writeText(join(childRepo, "src", ".keep"), "");
  writeText(join(outside, ".keep"), "");
  symlinkSync(outside, join(childRepo, "src", "escape"), "dir");
  const refs = [
    eventFile(fx, "symlink-redirection-outside-repo", bashEvent(fx, "echo x > src/escape/out.txt", {
      cwd: childRepo,
    })),
    eventFile(fx, "symlink-apply-patch-outside-repo", applyPatchEvent(fx, "*** Add File: src/escape/out.ts\n+escape\n", {
      cwd: childRepo,
    })),
  ];
  const childStatus = {
    ...status(fx),
    changeRoot: childChange,
    planningHome: { root: childRepo },
  };
  withRuntime({ load_context: () => [childStatus, childRepo, childChange, []] }, () => {
    const bash = captureMainJson(["hook-check-command", "--change", "child-change", "--event-ref", refs[0]]).payload;
    assert.equal(bash.allowed, false);
    assert.ok(codes(bash.block_reasons).includes("target_path_outside_repo"), JSON.stringify(bash.block_reasons));
    const patch = captureMainJson(["hook-check-write", "--change", "child-change", "--event-ref", refs[1]]).payload;
    assert.equal(patch.allowed, false);
    assert.ok(codes(patch.block_reasons).includes("target_path_outside_repo"), JSON.stringify(patch.block_reasons));
  });
});

withFixture("hook check write denies apply_patch move destinations outside repo root", (fx) => {
  const childRepo = join(fx.repo, "packages", "child");
  const childChange = join(childRepo, "openspec", "changes", "child-change");
  writeText(join(childChange, "tasks.md"), "- [ ] TASK-001 Implement\n");
  const ref = eventFile(fx, "move-outside-repo-target", applyPatchEvent(fx, "*** Update File: src/ordinary.ts\n*** Move to: ../outside.txt\n+escape\n", {
    cwd: childRepo,
  }));
  const childStatus = {
    ...status(fx),
    changeRoot: childChange,
    planningHome: { root: childRepo },
  };
  withRuntime({ load_context: () => [childStatus, childRepo, childChange, []] }, () => {
    const decision = captureMainJson(["hook-check-write", "--change", "child-change", "--event-ref", ref]).payload;
    assert.equal(decision.allowed, false);
    assert.ok(codes(decision.block_reasons).includes("target_path_outside_repo"), JSON.stringify(decision.block_reasons));
  });
});

withFixture("active audit-only hook session denies pathless trust-root writes delivered by exec-like surfaces", (fx) => {
  beginAuditSession(fx);
  const refs = [
    eventFile(fx, "active-mcp-trust-root-text", {
      hook_event_name: "PreToolUse",
      session_id: "manual-cli-session",
      turn_id: "turn-1",
      tool_name: "mcp__runner",
      tool_use_id: "tool-mcp",
      cwd: fx.repo,
      tool_input: { code: "fs.writeFileSync('.codex/superspec/install-manifest.json', '{}')" },
    }),
    eventFile(fx, "active-node-trust-root-text", {
      hook_event_name: "PreToolUse",
      session_id: "manual-cli-session",
      turn_id: "turn-1",
      tool_name: "node_repl",
      tool_use_id: "tool-node",
      cwd: fx.repo,
      tool_input: { code: "require('fs').writeFileSync('.superspec/state.json', '{}')" },
    }),
  ];
  withRuntime({ load_context: () => [status(fx), fx.repo, fx.change, []] }, () => {
    for (const ref of refs) {
      const decision = captureMainJson(["hook-check-write", "--change", "demo-change", "--event-ref", ref]).payload;
      assert.equal(decision.allowed, false);
      const reasonCodes = codes(decision.block_reasons);
      assert.ok(reasonCodes.includes("protected_trust_root_write"), JSON.stringify(decision.block_reasons));
      assert.ok(reasonCodes.includes("bash_write_target_unknown"), JSON.stringify(decision.block_reasons));
    }
  });
});

withFixture("active audit-only hook session denies case-variant write_scope and canonical paths", (fx) => {
  writeText(join(fx.change, "tasks.md"), "- [ ] TASK-001 Implement\n  - test_refs: TEST-001\n  - invariant_refs: INV-001\n  - write_scope: src/feature.ts\n");
  beginAuditSession(fx);
  const refs = [
    eventFile(fx, "write-scope-case", applyPatchEvent(fx, "*** Add File: SRC/Feature.ts\n+export const value = 1;\n")),
    eventFile(fx, "tasks-case", applyPatchEvent(fx, [
      "*** Update File: openspec/changes/demo-change/Tasks.md",
      "- [ ] TASK-001 Implement",
      "+ [x] TASK-001 Implement",
    ].join("\n"))),
  ];
  withRuntime({ load_context: () => [status(fx), fx.repo, fx.change, []] }, () => {
    const scoped = captureMainJson(["hook-check-write", "--change", "demo-change", "--event-ref", refs[0]]).payload;
    assert.equal(scoped.allowed, false);
    assert.ok(codes(scoped.block_reasons).includes("task_edit_missing"), JSON.stringify(scoped.block_reasons));
    const tasks = captureMainJson(["hook-check-write", "--change", "demo-change", "--event-ref", refs[1]]).payload;
    assert.equal(tasks.allowed, false);
    assert.ok(codes(tasks.block_reasons).includes("task_complete_missing"), JSON.stringify(tasks.block_reasons));
  });
});

withFixture("active audit-only hook session denies pathless unsupported write surfaces", (fx) => {
  beginAuditSession(fx);
  const refs = [
    eventFile(fx, "mcp-pathless", {
      hook_event_name: "PreToolUse",
      session_id: "manual-cli-session",
      turn_id: "turn-1",
      tool_name: "mcp__node_repl__js",
      tool_use_id: "tool-mcp-1",
      cwd: fx.repo,
      tool_input: { code: "await fs.promises.writeFile('.codex/superspec/install-manifest.json', '{}')" },
    }),
    eventFile(fx, "unknown-pathless", {
      hook_event_name: "PreToolUse",
      session_id: "manual-cli-session",
      turn_id: "turn-1",
      tool_name: "unified_exec",
      tool_use_id: "tool-exec-1",
      cwd: fx.repo,
      tool_input: { command: "touch .codex/superspec/install-manifest.json" },
    }),
  ];
  withRuntime({ load_context: () => [status(fx), fx.repo, fx.change, []] }, () => {
    for (const ref of refs) {
      const decision = captureMainJson(["hook-check-write", "--change", "demo-change", "--event-ref", ref]).payload;
      assert.equal(decision.allowed, false);
      assert.ok(codes(decision.block_reasons).includes("unsupported_write_surface"), JSON.stringify(decision.block_reasons));
    }
  });
});

withFixture("active audit-only hook session allows verification commands through PreToolUse", (fx) => {
  beginAuditSession(fx);
  const refs = [
    eventFile(fx, "node-test", bashEvent(fx, "node --test tests/test_superspec_hooks.test.ts")),
    eventFile(fx, "npm-test", bashEvent(fx, "npm test")),
    eventFile(fx, "npm-test-redirect-fd", bashEvent(fx, "npm test 2>&1")),
    eventFile(fx, "openspec-validate", bashEvent(fx, "openspec validate demo-change")),
    eventFile(fx, "openspec-validate-archive-argument", bashEvent(fx, "openspec validate archive")),
  ];
  withRuntime({ load_context: () => [status(fx), fx.repo, fx.change, []] }, () => {
    for (const ref of refs) {
      const decision = captureMainJson(["hook-check-command", "--change", "demo-change", "--event-ref", ref]).payload;
      assert.equal(decision.allowed, true, JSON.stringify(decision.block_reasons));
      assert.equal(decision.enforcement, "guarded");
    }
  });
});

withFixture("active audit-only hook session denies inline interpreter writes with unknown target", (fx) => {
  beginAuditSession(fx);
  const ref = eventFile(fx, "node-inline-write", bashEvent(fx, "node -e \"require('fs').writeFileSync('.codex/superspec/install-manifest.json', '{}')\""));
  withRuntime({ load_context: () => [status(fx), fx.repo, fx.change, []] }, () => {
    const decision = captureMainJson(["hook-check-command", "--change", "demo-change", "--event-ref", ref]).payload;
    assert.equal(decision.allowed, false);
    assert.ok(codes(decision.block_reasons).includes("bash_write_target_unknown"), JSON.stringify(decision.block_reasons));
  });
});

withFixture("apply_patch direct file paths keep real top-level a and b directories", (fx) => {
  writeText(join(fx.change, "tasks.md"), "- [ ] TASK-001 Implement\n  - test_refs: TEST-001\n  - invariant_refs: INV-001\n  - write_scope: a/src/feature.ts\n");
  beginAuditSession(fx);
  const ref = eventFile(fx, "top-level-a-path", applyPatchEvent(fx, "*** Add File: a/src/feature.ts\n+export const value = 1;\n"));
  withRuntime({ load_context: () => [status(fx), fx.repo, fx.change, []] }, () => {
    const decision = captureMainJson(["hook-check-write", "--change", "demo-change", "--event-ref", ref]).payload;
    assert.deepEqual(decision.target_paths, ["a/src/feature.ts"]);
    assert.equal(decision.allowed, false);
    assert.ok(codes(decision.block_reasons).includes("task_edit_missing"), JSON.stringify(decision.block_reasons));
  });
});

withFixture("tasks checkbox completion without task_complete allow is denied", (fx) => {
  writeText(join(fx.change, "tasks.md"), "- [ ] TASK-001 Implement\n  - test_refs: TEST-001\n  - invariant_refs: INV-001\n  - write_scope: src/feature.ts\n");
  beginAuditSession(fx);
  const ref = eventFile(fx, "checkbox", applyPatchEvent(fx, [
    "*** Update File: openspec/changes/demo-change/tasks.md",
    "- [ ] TASK-001 Implement",
    "+ [x] TASK-001 Implement",
  ].join("\n")));
  withRuntime({ load_context: () => [status(fx), fx.repo, fx.change, []] }, () => {
    const decision = captureMainJson(["hook-check-write", "--change", "demo-change", "--event-ref", ref]).payload;
    assert.equal(decision.allowed, false);
    assert.ok(codes(decision.block_reasons).includes("task_complete_missing"), JSON.stringify(decision.block_reasons));
  });
});

withFixture("tasks checkbox reopen without task_reopen allow is denied", (fx) => {
  writeText(join(fx.change, "tasks.md"), "- [x] TASK-001 Implement\n  - test_refs: TEST-001\n  - invariant_refs: INV-001\n  - write_scope: src/feature.ts\n");
  beginAuditSession(fx);
  const ref = eventFile(fx, "checkbox-reopen", applyPatchEvent(fx, [
    "*** Update File: openspec/changes/demo-change/tasks.md",
    "-- [x] TASK-001 Implement",
    "+- [ ] TASK-001 Implement",
  ].join("\n")));
  withRuntime({ load_context: () => [status(fx), fx.repo, fx.change, []] }, () => {
    const decision = captureMainJson(["hook-check-write", "--change", "demo-change", "--event-ref", ref]).payload;
    assert.equal(decision.allowed, false);
    assert.ok(codes(decision.block_reasons).includes("task_reopen_missing"), JSON.stringify(decision.block_reasons));
  });
});

withFixture("Bash archive before archive_ready is denied", (fx) => {
  const refs = [
    eventFile(fx, "archive", bashEvent(fx, "openspec archive -y demo-change")),
    eventFile(fx, "archive-quote-split", bashEvent(fx, "op'enspec' archive -y demo-change")),
    eventFile(fx, "archive-backslash-split", bashEvent(fx, "open\\spec archive -y demo-change")),
    eventFile(fx, "archive-ansi-c-quote-split", bashEvent(fx, "op$'\\x65n'spec archive -y demo-change")),
    eventFile(fx, "archive-locale-quote-split", bashEvent(fx, "op$\"en\"spec archive -y demo-change")),
    eventFile(fx, "archive-backslash-newline-split", bashEvent(fx, `open\\
spec archive -y demo-change`)),
    eventFile(fx, "archive-nested-quote-split", bashEvent(fx, "sh -c \"op'enspec' archive -y demo-change\"")),
    eventFile(fx, "archive-newline-command", bashEvent(fx, "echo ok\nopenspec archive -y demo-change")),
    eventFile(fx, "archive-eval-command", bashEvent(fx, "eval \"openspec archive -y demo-change\"")),
    eventFile(fx, "archive-builtin-eval-command", bashEvent(fx, "builtin eval \"openspec archive -y demo-change\"")),
    eventFile(fx, "archive-fd-prefix-command", bashEvent(fx, "2>/dev/null openspec archive -y demo-change")),
    eventFile(fx, "archive-env-s-command", bashEvent(fx, "env -S \"openspec archive -y demo-change\"")),
    eventFile(fx, "archive-find-exec-group-command", bashEvent(fx, "find . \\( -name foo \\) -exec openspec archive -y demo-change \\;")),
  ];
  withRuntime({ load_context: () => [status(fx), fx.repo, fx.change, []] }, () => {
    for (const ref of refs) {
      const decision = captureMainJson(["hook-check-command", "--change", "demo-change", "--event-ref", ref]).payload;
      assert.equal(decision.allowed, false);
      assert.ok(codes(decision.block_reasons).includes("archive_ready_missing"), JSON.stringify(decision.block_reasons));
    }
  });
});

withFixture("complex Bash archive and trust-root write wrappers are denied", (fx) => {
  const refs = [
    eventFile(fx, "archive-sh-wrapper", bashEvent(fx, "sh -c 'openspec archive -y demo-change'")),
    eventFile(fx, "archive-mv-wrapper", bashEvent(fx, "mv openspec/changes/demo-change openspec/archive/demo-change")),
    eventFile(fx, "trust-root-cp", bashEvent(fx, "cp /tmp/state.json openspec/changes/demo-change/.superspec/superspec-state.json")),
    eventFile(fx, "trust-root-rm-dir", bashEvent(fx, "rm -rf openspec/changes/demo-change/.superspec")),
    eventFile(fx, "nested-trust-root-cp", bashEvent(fx, "bash -lc \"cp /tmp/state.json .codex/superspec/install-manifest.json\"")),
    eventFile(fx, "nested-trust-root-rm", bashEvent(fx, "sh -c 'rm -rf openspec/changes/demo-change/.superspec'")),
    eventFile(fx, "trust-root-ln-source", bashEvent(fx, "ln -sf .co'dex'/superspec/install-manifest.json src/feature.ts")),
    eventFile(fx, "quote-split-redirection-trust-root", bashEvent(fx, "echo x > .co'dex'/superspec/install-manifest.json")),
    eventFile(fx, "quote-split-tee-trust-root", bashEvent(fx, "printf x | tee .co'dex'/superspec/install-manifest.json")),
    eventFile(fx, "quote-split-sed-trust-root", bashEvent(fx, "sed -i s/a/b/ .co'dex'/superspec/install-manifest.json")),
    eventFile(fx, "ansi-c-quote-split-redirection-trust-root", bashEvent(fx, "echo x > .co$'\\x64ex'/superspec/install-manifest.json")),
    eventFile(fx, "ansi-c-quote-split-cp-trust-root", bashEvent(fx, "cp /tmp/state.json .co$'dex'/superspec/install-manifest.json")),
    eventFile(fx, "stdout-stderr-redirection-trust-root", bashEvent(fx, "echo x &> .co'dex'/superspec/install-manifest.json")),
    eventFile(fx, "stdout-stderr-append-redirection-trust-root", bashEvent(fx, "echo x &>> .co'dex'/superspec/install-manifest.json")),
    eventFile(fx, "legacy-stdout-stderr-redirection-trust-root", bashEvent(fx, "echo x >& .co'dex'/superspec/install-manifest.json")),
    eventFile(fx, "prefix-glob-trust-root", bashEvent(fx, "rm -rf .co*")),
    eventFile(fx, "change-superspec-prefix-glob-trust-root", bashEvent(fx, "rm -rf openspec/changes/demo-change/.su*")),
    eventFile(fx, "newline-trust-root-rm", bashEvent(fx, "echo ok\nrm -rf .codex")),
    eventFile(fx, "subshell-trust-root-rm", bashEvent(fx, "( rm -rf .codex )")),
    eventFile(fx, "brace-group-trust-root-rm", bashEvent(fx, "{ rm -rf .codex; }")),
    eventFile(fx, "eval-trust-root-rm", bashEvent(fx, "eval \"rm -rf .codex\"")),
    eventFile(fx, "builtin-eval-trust-root-rm", bashEvent(fx, "builtin eval \"rm -rf .codex\"")),
    eventFile(fx, "fd-prefix-trust-root-rm", bashEvent(fx, "2>/dev/null rm -rf .codex")),
    eventFile(fx, "env-s-trust-root-rm", bashEvent(fx, "env -S \"rm -rf .codex\"")),
    eventFile(fx, "backtick-trust-root-rm", bashEvent(fx, "echo `rm -rf .superspec`")),
    eventFile(fx, "dollar-substitution-trust-root-rm", bashEvent(fx, "echo \"$(rm -rf .superspec)\"")),
    eventFile(fx, "find-exec-trust-root-rm", bashEvent(fx, "find . -maxdepth 0 -exec rm -rf .superspec \\;")),
    eventFile(fx, "find-exec-group-trust-root-rm", bashEvent(fx, "find . \\( -name foo \\) -exec rm -rf .superspec \\;")),
    eventFile(fx, "mv-target-directory-trust-root", bashEvent(fx, "mv -t .co'dex' /tmp/state.json")),
  ];
  withRuntime({ load_context: () => [status(fx), fx.repo, fx.change, []] }, () => {
    const wrappedArchive = captureMainJson(["hook-check-command", "--change", "demo-change", "--event-ref", refs[0]]).payload;
    assert.equal(wrappedArchive.allowed, false);
    assert.ok(codes(wrappedArchive.block_reasons).includes("archive_ready_missing"), JSON.stringify(wrappedArchive.block_reasons));
    const mvArchive = captureMainJson(["hook-check-command", "--change", "demo-change", "--event-ref", refs[1]]).payload;
    assert.equal(mvArchive.allowed, false);
    assert.ok(codes(mvArchive.block_reasons).includes("archive_ready_missing"), JSON.stringify(mvArchive.block_reasons));
    const trustRoot = captureMainJson(["hook-check-command", "--change", "demo-change", "--event-ref", refs[2]]).payload;
    assert.equal(trustRoot.allowed, false);
    assert.ok(codes(trustRoot.block_reasons).includes("protected_trust_root_write"), JSON.stringify(trustRoot.block_reasons));
    const trustRootDir = captureMainJson(["hook-check-command", "--change", "demo-change", "--event-ref", refs[3]]).payload;
    assert.equal(trustRootDir.allowed, false);
    assert.ok(codes(trustRootDir.block_reasons).includes("protected_trust_root_write"), JSON.stringify(trustRootDir.block_reasons));
    const nestedTrustRoot = captureMainJson(["hook-check-command", "--change", "demo-change", "--event-ref", refs[4]]).payload;
    assert.equal(nestedTrustRoot.allowed, false);
    assert.ok(codes(nestedTrustRoot.block_reasons).includes("protected_trust_root_write"), JSON.stringify(nestedTrustRoot.block_reasons));
    const nestedTrustRootDir = captureMainJson(["hook-check-command", "--change", "demo-change", "--event-ref", refs[5]]).payload;
    assert.equal(nestedTrustRootDir.allowed, false);
    assert.ok(codes(nestedTrustRootDir.block_reasons).includes("protected_trust_root_write"), JSON.stringify(nestedTrustRootDir.block_reasons));
    const trustRootLink = captureMainJson(["hook-check-command", "--change", "demo-change", "--event-ref", refs[6]]).payload;
    assert.equal(trustRootLink.allowed, false);
    assert.ok(codes(trustRootLink.block_reasons).includes("protected_trust_root_link_source"), JSON.stringify(trustRootLink.block_reasons));
    const quoteSplitRedirection = captureMainJson(["hook-check-command", "--change", "demo-change", "--event-ref", refs[7]]).payload;
    assert.equal(quoteSplitRedirection.allowed, false);
    assert.ok(codes(quoteSplitRedirection.block_reasons).includes("protected_trust_root_write"), JSON.stringify(quoteSplitRedirection.block_reasons));
    const quoteSplitTee = captureMainJson(["hook-check-command", "--change", "demo-change", "--event-ref", refs[8]]).payload;
    assert.equal(quoteSplitTee.allowed, false);
    assert.ok(codes(quoteSplitTee.block_reasons).includes("protected_trust_root_write"), JSON.stringify(quoteSplitTee.block_reasons));
    const quoteSplitSed = captureMainJson(["hook-check-command", "--change", "demo-change", "--event-ref", refs[9]]).payload;
    assert.equal(quoteSplitSed.allowed, false);
    assert.ok(codes(quoteSplitSed.block_reasons).includes("protected_trust_root_write"), JSON.stringify(quoteSplitSed.block_reasons));
    const ansiRedirection = captureMainJson(["hook-check-command", "--change", "demo-change", "--event-ref", refs[10]]).payload;
    assert.equal(ansiRedirection.allowed, false);
    assert.ok(codes(ansiRedirection.block_reasons).includes("protected_trust_root_write"), JSON.stringify(ansiRedirection.block_reasons));
    const ansiCp = captureMainJson(["hook-check-command", "--change", "demo-change", "--event-ref", refs[11]]).payload;
    assert.equal(ansiCp.allowed, false);
    assert.ok(codes(ansiCp.block_reasons).includes("protected_trust_root_write"), JSON.stringify(ansiCp.block_reasons));
    const stdoutStderr = captureMainJson(["hook-check-command", "--change", "demo-change", "--event-ref", refs[12]]).payload;
    assert.equal(stdoutStderr.allowed, false);
    assert.ok(codes(stdoutStderr.block_reasons).includes("protected_trust_root_write"), JSON.stringify(stdoutStderr.block_reasons));
    const stdoutStderrAppend = captureMainJson(["hook-check-command", "--change", "demo-change", "--event-ref", refs[13]]).payload;
    assert.equal(stdoutStderrAppend.allowed, false);
    assert.ok(codes(stdoutStderrAppend.block_reasons).includes("protected_trust_root_write"), JSON.stringify(stdoutStderrAppend.block_reasons));
    const legacyStdoutStderr = captureMainJson(["hook-check-command", "--change", "demo-change", "--event-ref", refs[14]]).payload;
    assert.equal(legacyStdoutStderr.allowed, false);
    assert.ok(codes(legacyStdoutStderr.block_reasons).includes("protected_trust_root_write"), JSON.stringify(legacyStdoutStderr.block_reasons));
    const prefixGlob = captureMainJson(["hook-check-command", "--change", "demo-change", "--event-ref", refs[15]]).payload;
    assert.equal(prefixGlob.allowed, false);
    assert.ok(codes(prefixGlob.block_reasons).includes("shell_path_may_touch_trust_root"), JSON.stringify(prefixGlob.block_reasons));
    const changeSuperspecPrefixGlob = captureMainJson(["hook-check-command", "--change", "demo-change", "--event-ref", refs[16]]).payload;
    assert.equal(changeSuperspecPrefixGlob.allowed, false);
    assert.ok(codes(changeSuperspecPrefixGlob.block_reasons).includes("shell_path_may_touch_trust_root"), JSON.stringify(changeSuperspecPrefixGlob.block_reasons));
    for (const ref of refs.slice(17, 28)) {
      const decision = captureMainJson(["hook-check-command", "--change", "demo-change", "--event-ref", ref]).payload;
      assert.equal(decision.allowed, false);
      const reasonCodes = codes(decision.block_reasons);
      assert.ok(
        reasonCodes.includes("protected_trust_root_write") || reasonCodes.includes("shell_path_may_touch_trust_root"),
        JSON.stringify(decision.block_reasons),
      );
    }
    const mvTargetDirectory = captureMainJson(["hook-check-command", "--change", "demo-change", "--event-ref", refs[28]]).payload;
    assert.equal(mvTargetDirectory.allowed, true, JSON.stringify(mvTargetDirectory.block_reasons));
  });
});

withFixture("active hook session denies trust root parent deletes", (fx) => {
  beginAuditSession(fx);
  const refs = [
    eventFile(fx, "delete-codex-root", bashEvent(fx, "rm -rf .codex")),
    eventFile(fx, "delete-change-root", bashEvent(fx, "rm -rf openspec/changes/demo-change")),
  ];
  withRuntime({ load_context: () => [status(fx), fx.repo, fx.change, []] }, () => {
    for (const ref of refs) {
      const decision = captureMainJson(["hook-check-command", "--change", "demo-change", "--event-ref", ref]).payload;
      assert.equal(decision.allowed, false);
      const reasonCodes = codes(decision.block_reasons);
      assert.ok(
        reasonCodes.includes("protected_trust_root_write") || reasonCodes.includes("shell_path_may_touch_trust_root"),
        JSON.stringify(decision.block_reasons),
      );
    }
    for (const [name, command] of [
      ["codex-config", "rm -f .codex/config.toml"],
      ["codex-hooks", "rm -f .codex/hooks.json"],
      ["codex-static-sibling-prefix", "rm -rf .co"],
      ["codex-superspec-static-sibling-prefix", "rm -rf .codex/super"],
      ["codex-skills", "rm -rf .codex/skills"],
      ["codex-prompts", "rm -rf .codex/prompts"],
      ["codex-agents", "rm -rf .codex/agents"],
      ["omx-state", "rm -rf .omx/state"],
      ["openspec-change-static-sibling-prefix", "rm -rf openspec/change"],
    ] as const) {
      const ref = eventFile(fx, `active-${name}-delete`, bashEvent(fx, command));
      const decision = captureMainJson(["hook-check-command", "--change", "demo-change", "--event-ref", ref]).payload;
      assert.equal(decision.allowed, true, `${name}: ${JSON.stringify(decision.block_reasons)}`);
      assert.equal(decision.enforcement, "guarded");
    }
    const codexHookRef = eventFile(fx, "active-codex-hooks-write", applyPatchEvent(fx, "*** Update File: .codex/hooks.json\n+{}\n"));
    const codexHook = captureMainJson(["hook-check-write", "--change", "demo-change", "--event-ref", codexHookRef]).payload;
    assert.equal(codexHook.allowed, true, JSON.stringify(codexHook.block_reasons));
    assert.equal(codexHook.enforcement, "guarded");
  });
});

withFixture("active hook session denies cross-change superspec trust roots", (fx) => {
  beginAuditSession(fx);
  const refs = [
    eventFile(fx, "cross-change-superspec", applyPatchEvent(fx, "*** Update File: openspec/changes/other-change/.superspec/superspec-state.json\n+{}\n")),
    eventFile(fx, "cross-change-superspec-case", applyPatchEvent(fx, "*** Update File: OpenSpec/Changes/Other-Change/.SuperSpec/superspec-state.json\n+{}\n")),
  ];
  withRuntime({ load_context: () => [status(fx), fx.repo, fx.change, []] }, () => {
    for (const ref of refs) {
      const decision = captureMainJson(["hook-check-write", "--change", "demo-change", "--event-ref", ref]).payload;
      assert.equal(decision.allowed, false);
      assert.ok(codes(decision.block_reasons).includes("protected_trust_root_write"), JSON.stringify(decision.block_reasons));
    }
  });
});

withFixture("active hook session denies trust root shell globs", (fx) => {
  beginAuditSession(fx);
  const refs = [
    eventFile(fx, "delete-codex-glob", bashEvent(fx, "rm -rf .codex/*")),
    eventFile(fx, "delete-codex-brace", bashEvent(fx, "rm -rf .codex/{superspec,skills}")),
    eventFile(fx, "delete-change-glob", bashEvent(fx, "rm -rf openspec/changes/demo-change/*")),
    eventFile(fx, "delete-codex-find-execdir-quoted-predicate", bashEvent(fx, "find .co'dex' -path .co'dex'/superspec/install-manifest.json -execdir rm -f install-manifest.json \\;")),
    eventFile(fx, "delete-codex-find-execdir-broad-root", bashEvent(fx, "find . -name install-manifest.json -execdir rm -f install-manifest.json \\;")),
    eventFile(fx, "delete-codex-find-delete", bashEvent(fx, "find .codex/superspec -delete")),
    eventFile(fx, "delete-change-find-delete", bashEvent(fx, "find openspec/changes/demo-change/.superspec -delete")),
  ];
  withRuntime({ load_context: () => [status(fx), fx.repo, fx.change, []] }, () => {
    for (const ref of refs) {
      const decision = captureMainJson(["hook-check-command", "--change", "demo-change", "--event-ref", ref]).payload;
      assert.equal(decision.allowed, false);
      const reasonCodes = codes(decision.block_reasons);
      assert.ok(
        reasonCodes.includes("protected_trust_root_write") || reasonCodes.includes("shell_path_may_touch_trust_root"),
        JSON.stringify(decision.block_reasons),
      );
    }
  });
});

withFixture("active hook session denies trust root shell option operands", (fx) => {
  beginAuditSession(fx);
  const refs = [
    eventFile(fx, "cp-double-dash-trust-root", bashEvent(fx, "cp -- /tmp/state.json .codex/superspec/install-manifest.json")),
    eventFile(fx, "cp-target-directory-basename-trust-root", bashEvent(fx, "cp -R -t .codex /tmp/superspec")),
    eventFile(fx, "cp-target-directory-glob-basename-trust-root", bashEvent(fx, "cp -R -t .codex /tmp/super*")),
    eventFile(fx, "cp-directory-basename-trust-root", bashEvent(fx, "cp -R /tmp/superspec .codex")),
    eventFile(fx, "install-mode-trust-root", bashEvent(fx, "install -m 0644 /tmp/state.json .codex/superspec/install-manifest.json")),
    eventFile(fx, "install-target-directory-basename-trust-root", bashEvent(fx, "install -t .codex /tmp/superspec")),
    eventFile(fx, "install-directory-basename-trust-root", bashEvent(fx, "install /tmp/superspec .codex")),
    eventFile(fx, "rm-third-operand-trust-root", bashEvent(fx, "rm -f foo bar openspec/changes/demo-change/.superspec/superspec-state.json")),
    eventFile(fx, "touch-trust-root", bashEvent(fx, "touch .codex/superspec/install-manifest.json")),
    eventFile(fx, "truncate-trust-root", bashEvent(fx, "truncate -s 0 .codex/superspec/install-manifest.json")),
    eventFile(fx, "ln-trust-root", bashEvent(fx, "ln -sf /tmp/state.json .codex/superspec/install-manifest.json")),
    eventFile(fx, "ln-directory-basename-trust-root", bashEvent(fx, "ln -s /tmp/superspec .codex")),
    eventFile(fx, "mv-target-directory-basename-trust-root", bashEvent(fx, "mv -t .codex /tmp/superspec")),
    eventFile(fx, "mv-directory-basename-trust-root", bashEvent(fx, "mv /tmp/superspec .codex")),
    eventFile(fx, "dd-of-trust-root", bashEvent(fx, "dd if=/tmp/state.json of=.codex/superspec/install-manifest.json")),
    eventFile(fx, "rsync-directory-basename-trust-root", bashEvent(fx, "rsync /tmp/superspec .codex")),
    eventFile(fx, "rsync-log-file-trust-root", bashEvent(fx, "rsync --log-file=.co'dex'/superspec/log /tmp/a src/a")),
    eventFile(fx, "rsync-remove-source-trust-root", bashEvent(fx, "rsync --remove-source-files .co'dex'/superspec/install-manifest.json src/backup/")),
    eventFile(fx, "rsync-backup-dir-trust-root", bashEvent(fx, "rsync --backup --backup-dir=.co'dex'/superspec /tmp/a src/a")),
    eventFile(fx, "rsync-partial-dir-basename-trust-root", bashEvent(fx, "rsync --partial-dir=.codex /tmp/superspec src/")),
    eventFile(fx, "rsync-temp-dir-short-basename-trust-root", bashEvent(fx, "rsync -T .codex /tmp/superspec src/")),
    eventFile(fx, "rsync-temp-dir-attached-basename-trust-root", bashEvent(fx, "rsync -T.co'dex' /tmp/superspec src/")),
    eventFile(fx, "rsync-write-batch-trust-root", bashEvent(fx, "rsync --write-batch=.co'dex'/superspec/batch /tmp/a src/a")),
    eventFile(fx, "rsync-delete-codex-parent-trust-root", bashEvent(fx, "rsync -a --delete /tmp/empty/ .codex/")),
    eventFile(fx, "rsync-delete-delay-change-parent-trust-root", bashEvent(fx, "rsync -a --delete-delay /tmp/empty/ openspec/changes/demo-change/")),
    eventFile(fx, "rsync-delete-codex-parent-post-include-trust-root", bashEvent(fx, "rsync -a --delete /tmp/empty/ .codex/ --include superspec")),
    eventFile(fx, "rsync-delete-change-parent-post-exclude-trust-root", bashEvent(fx, "rsync -a --delete /tmp/empty/ openspec/changes/demo-change/ --exclude superspec-state.json")),
    eventFile(fx, "tar-extract-codex-member-trust-root", bashEvent(fx, "tar -xf /tmp/state.tar -C .codex superspec")),
    eventFile(fx, "tar-extract-codex-member-gzip-trust-root", bashEvent(fx, "tar -xzf /tmp/state.tar.gz -C .codex superspec/install-manifest.json")),
    eventFile(fx, "tar-extract-codex-member-before-second-c-trust-root", bashEvent(fx, "tar -xf /tmp/state.tar -C .codex superspec/install-manifest.json -C src")),
    eventFile(fx, "tar-old-style-extract-codex-member-trust-root", bashEvent(fx, "tar xCf .codex state.tar superspec/install-manifest.json")),
    eventFile(fx, "tar-extract-codex-strip-components-trust-root", bashEvent(fx, "tar -xf /tmp/state.tar -C .codex --strip-components=1 x/superspec/install-manifest.json")),
    eventFile(fx, "tar-extract-codex-unknown-members-trust-root", bashEvent(fx, "tar -xf /tmp/state.tar -C .codex")),
    eventFile(fx, "tar-create-trust-root-archive", bashEvent(fx, "tar -cf .codex/superspec/state.tar src")),
    eventFile(fx, "tar-create-trust-root-file-before-mode", bashEvent(fx, "tar --file=.co'dex'/superspec/state.tar --create src")),
    eventFile(fx, "tar-create-trust-root-old-style", bashEvent(fx, "tar cf .codex/superspec/state.tar src")),
    eventFile(fx, "tar-create-trust-root-old-style-c-c-f", bashEvent(fx, "tar cCf .codex .codex/superspec/state.tar src")),
    eventFile(fx, "unzip-extract-codex-member-trust-root", bashEvent(fx, "unzip /tmp/state.zip -d .codex superspec/install-manifest.json")),
    eventFile(fx, "unzip-extract-codex-unknown-members-trust-root", bashEvent(fx, "unzip /tmp/state.zip -d .codex")),
    eventFile(fx, "curl-remote-name-cd-trust-root", bashEvent(fx, "cd .codex; curl -O https://example.invalid/superspec")),
    eventFile(fx, "curl-remote-name-all-url-option-cd-trust-root", bashEvent(fx, "cd .codex; curl --remote-name-all --url=https://example.invalid/superspec")),
    eventFile(fx, "curl-header-derived-output-dir-trust-root", bashEvent(fx, "curl -OJ --output-dir .codex https://example.invalid/download")),
    eventFile(fx, "curl-output-dir-output-relative-trust-root", bashEvent(fx, "curl --output-dir .codex --output superspec/install-manifest.json https://example.invalid/state")),
    eventFile(fx, "curl-output-dir-short-output-relative-trust-root", bashEvent(fx, "curl --output-dir=.co'dex' -o superspec/install-manifest.json https://example.invalid/state")),
    eventFile(fx, "curl-output-dir-attached-output-relative-trust-root", bashEvent(fx, "curl --output-dir .codex -osuperspec/install-manifest.json https://example.invalid/state")),
    eventFile(fx, "curl-output-before-output-dir-relative-trust-root", bashEvent(fx, "curl -o superspec/install-manifest.json --output-dir .codex https://example.invalid/state")),
    eventFile(fx, "curl-dump-header-trust-root", bashEvent(fx, "curl -D .codex/superspec/headers https://example.invalid/state")),
    eventFile(fx, "curl-cookie-jar-trust-root", bashEvent(fx, "curl --cookie-jar .codex/superspec/cookies https://example.invalid/state")),
    eventFile(fx, "curl-trace-trust-root", bashEvent(fx, "curl --trace .codex/superspec/trace https://example.invalid/state")),
    eventFile(fx, "curl-trace-ascii-trust-root", bashEvent(fx, "curl --trace-ascii .codex/superspec/trace.txt https://example.invalid/state")),
    eventFile(fx, "curl-stderr-trust-root", bashEvent(fx, "curl --stderr .codex/superspec/stderr https://example.invalid/state")),
    eventFile(fx, "curl-libcurl-trust-root", bashEvent(fx, "curl --libcurl .codex/superspec/client.c https://example.invalid/state")),
    eventFile(fx, "curl-etag-save-trust-root", bashEvent(fx, "curl --etag-save .codex/superspec/etag https://example.invalid/state")),
    eventFile(fx, "wget-directory-prefix-basename-trust-root", bashEvent(fx, "wget -P .codex https://example.invalid/superspec")),
    eventFile(fx, "wget-attached-directory-prefix-basename-trust-root", bashEvent(fx, "wget -P.codex https://example.invalid/superspec")),
    eventFile(fx, "wget-combined-attached-directory-prefix-basename-trust-root", bashEvent(fx, "wget -qP.co'dex' https://example.invalid/superspec")),
    eventFile(fx, "wget-content-disposition-prefix-trust-root", bashEvent(fx, "wget --content-disposition -P .codex https://example.invalid/download")),
  ];
  withRuntime({ load_context: () => [status(fx), fx.repo, fx.change, []] }, () => {
    for (const ref of refs) {
      const decision = captureMainJson(["hook-check-command", "--change", "demo-change", "--event-ref", ref]).payload;
      assert.equal(decision.allowed, false);
      const reasonCodes = codes(decision.block_reasons);
      assert.ok(
        reasonCodes.includes("protected_trust_root_write") || reasonCodes.includes("shell_path_may_touch_trust_root"),
        JSON.stringify(decision.block_reasons),
      );
    }
  });
});

withFixture("active hook session denies curl config-driven writes with unknown targets", (fx) => {
  beginAuditSession(fx);
  const refs = [
    eventFile(fx, "curl-config-stdin-unknown-target", bashEvent(fx, "curl -K - <<EOF\nurl = \"https://example.invalid/state\"\noutput = \".codex/superspec/pwn\"\nEOF")),
    eventFile(fx, "curl-config-file-unknown-target", bashEvent(fx, "curl --config curl.conf")),
    eventFile(fx, "curl-dump-header-missing-target", bashEvent(fx, "curl -D")),
  ];
  withRuntime({ load_context: () => [status(fx), fx.repo, fx.change, []] }, () => {
    for (const ref of refs) {
      const decision = captureMainJson(["hook-check-command", "--change", "demo-change", "--event-ref", ref]).payload;
      assert.equal(decision.allowed, false);
      assert.ok(
        codes(decision.block_reasons).includes("curl_config_write_target_unknown")
          || codes(decision.block_reasons).includes("curl_write_target_unknown"),
        JSON.stringify(decision.block_reasons),
      );
    }
  });
});

withFixture("active hook session denies write tool events without concrete targets", (fx) => {
  beginAuditSession(fx);
  const refs = [
    eventFile(fx, "apply-patch-missing-command", {
      hook_event_name: "PreToolUse",
      session_id: "manual-cli-session",
      turn_id: "turn-1",
      tool_name: "apply_patch",
      tool_use_id: "tool-1",
      cwd: fx.repo,
      tool_input: {},
    }),
    eventFile(fx, "edit-missing-path", {
      hook_event_name: "PreToolUse",
      session_id: "manual-cli-session",
      turn_id: "turn-1",
      tool_name: "Edit",
      tool_use_id: "tool-2",
      cwd: fx.repo,
      tool_input: { old_string: "before", new_string: "after" },
    }),
    eventFile(fx, "write-missing-path", {
      hook_event_name: "PreToolUse",
      session_id: "manual-cli-session",
      turn_id: "turn-1",
      tool_name: "Write",
      tool_use_id: "tool-3",
      cwd: fx.repo,
      tool_input: { content: "after" },
    }),
  ];
  withRuntime({ load_context: () => [status(fx), fx.repo, fx.change, []] }, () => {
    for (const ref of refs) {
      const decision = captureMainJson(["hook-check-write", "--change", "demo-change", "--event-ref", ref]).payload;
      assert.equal(decision.allowed, false);
      assert.ok(codes(decision.block_reasons).includes("unknown_patch_shape"), JSON.stringify(decision.block_reasons));
    }
  });
});

withFixture("model-controlled internal hook writer invocation is denied", (fx) => {
  const refs = [
    eventFile(fx, "internal-hook-writer", bashEvent(fx, "superspec guard hook-record-test --change demo-change --event-ref forged.json")),
    eventFile(fx, "internal-hook-writer-compat", bashEvent(fx, "superspec-guard hook-record-test --change demo-change --event-ref forged.json")),
    eventFile(fx, "internal-hook-writer-quote-split", bashEvent(fx, "super'spec' guard hook-record-test --change demo-change --event-ref forged.json")),
    eventFile(fx, "internal-hook-writer-compat-quote-split", bashEvent(fx, "superspec-'guard' hook-record-test --change demo-change --event-ref forged.json")),
    eventFile(fx, "internal-hook-writer-ansi-c-quote-split", bashEvent(fx, "super$'spec' guard hook-record-test --change demo-change --event-ref forged.json")),
    eventFile(fx, "internal-hook-writer-nested-quote-split", bashEvent(fx, "sh -c \"super'spec' guard hook-record-test --change demo-change --event-ref forged.json\"")),
    eventFile(fx, "internal-hook-writer-newline-command", bashEvent(fx, "echo ok\nsuperspec guard hook-record-test --change demo-change --event-ref forged.json")),
    eventFile(fx, "internal-hook-writer-eval-command", bashEvent(fx, "eval \"superspec guard hook-record-test --change demo-change --event-ref forged.json\"")),
    eventFile(fx, "internal-hook-writer-builtin-eval-command", bashEvent(fx, "builtin eval \"superspec guard hook-record-test --change demo-change --event-ref forged.json\"")),
    eventFile(fx, "internal-hook-writer-fd-prefix-command", bashEvent(fx, "2>/dev/null superspec guard hook-record-test --change demo-change --event-ref forged.json")),
    eventFile(fx, "internal-hook-writer-env-s-command", bashEvent(fx, "env -S \"superspec guard hook-record-test --change demo-change --event-ref forged.json\"")),
    eventFile(fx, "internal-hook-writer-bin-command", bashEvent(fx, "bin/superspec-guard.js hook-record-test --change demo-change --event-ref forged.json")),
    eventFile(fx, "internal-hook-writer-node-bin-command", bashEvent(fx, "node bin/superspec-guard.js hook-record-test --change demo-change --event-ref forged.json")),
    eventFile(fx, "internal-hook-entrypoint-js", bashEvent(fx, "bin/superspec-hook.js --change demo-change")),
    eventFile(fx, "internal-hook-node-entrypoint-js", bashEvent(fx, "node bin/superspec-hook.js --change demo-change")),
    eventFile(fx, "internal-hook-writer-find-exec-group", bashEvent(fx, "find . \\( -name foo \\) -exec superspec guard hook-record-test --change demo-change --event-ref forged.json \\;")),
    eventFile(fx, "internal-hook-writer-npx", bashEvent(fx, "npx --yes superspec-guard hook-record-test --change demo-change --event-ref forged.json")),
    eventFile(fx, "internal-hook-writer-npm-exec", bashEvent(fx, "npm exec superspec-guard -- hook-record-test --change demo-change --event-ref forged.json")),
    eventFile(fx, "internal-hook-writer-pnpm-exec", bashEvent(fx, "pnpm exec superspec-guard hook-record-test --change demo-change --event-ref forged.json")),
    eventFile(fx, "internal-hook-writer-yarn-dlx", bashEvent(fx, "yarn dlx superspec-guard hook-record-test --change demo-change --event-ref forged.json")),
    eventFile(fx, "internal-hook-writer-bunx", bashEvent(fx, "bunx superspec-guard hook-record-test --change demo-change --event-ref forged.json")),
    eventFile(fx, "internal-hook-writer-npx-call", bashEvent(fx, "npx --package @peterxiaoyang/superspec --call \"superspec-guard hook-record-test --change demo-change --event-ref forged.json\"")),
    eventFile(fx, "internal-hook-writer-npm-workspace", bashEvent(fx, "npm --workspace app exec superspec-guard hook-record-test --change demo-change --event-ref forged.json")),
    eventFile(fx, "internal-hook-writer-npm-exec-short-workspace", bashEvent(fx, "npm exec -w app superspec-guard hook-record-test --change demo-change --event-ref forged.json")),
    eventFile(fx, "internal-hook-writer-npm-x-short-workspace", bashEvent(fx, "npm x -w app superspec-guard hook-record-test --change demo-change --event-ref forged.json")),
    eventFile(fx, "internal-hook-writer-npm-exec-short-workspace-separator", bashEvent(fx, "npm exec -w app -- superspec-guard hook-record-test --change demo-change --event-ref forged.json")),
    eventFile(fx, "internal-hook-writer-pnpm-short-filter", bashEvent(fx, "pnpm -F app exec superspec-guard hook-record-test --change demo-change --event-ref forged.json")),
    eventFile(fx, "internal-hook-writer-yarn-workspace", bashEvent(fx, "yarn workspace app exec superspec-guard hook-record-test --change demo-change --event-ref forged.json")),
    eventFile(fx, "internal-hook-writer-yarn-cwd-workspace", bashEvent(fx, "yarn --cwd . workspace app exec superspec-guard hook-record-test --change demo-change --event-ref forged.json")),
  ];
  const terminateRef = eventFile(fx, "internal-hook-session-cancel", bashEvent(fx, "superspec guard hook-session-end --change demo-change --reason cancelled"));
  withRuntime({ load_context: () => [status(fx), fx.repo, fx.change, []] }, () => {
    for (const ref of refs) {
      const decision = captureMainJson(["hook-check-command", "--change", "demo-change", "--event-ref", ref]).payload;
      assert.equal(decision.allowed, false);
      assert.ok(codes(decision.block_reasons).includes("hook_internal_writer_invocation"), JSON.stringify(decision.block_reasons));
    }
    const terminate = captureMainJson(["hook-check-command", "--change", "demo-change", "--event-ref", terminateRef]).payload;
    assert.equal(terminate.allowed, false);
    assert.ok(codes(terminate.block_reasons).includes("hook_session_termination_untrusted"), JSON.stringify(terminate.block_reasons));
    const terminateQuotedRef = eventFile(fx, "internal-hook-session-cancel-quoted", bashEvent(fx, "superspec-guard hook-session-end --change demo-change --reason \"cancelled\""));
    const terminateQuoted = captureMainJson(["hook-check-command", "--change", "demo-change", "--event-ref", terminateQuotedRef]).payload;
    assert.equal(terminateQuoted.allowed, false);
    assert.ok(codes(terminateQuoted.block_reasons).includes("hook_session_termination_untrusted"), JSON.stringify(terminateQuoted.block_reasons));
    const terminateAbandonedQuotedRef = eventFile(fx, "internal-hook-session-abandon-quoted", bashEvent(fx, "superspec guard hook-session-end --change demo-change --reason 'abandoned'"));
    const terminateAbandonedQuoted = captureMainJson(["hook-check-command", "--change", "demo-change", "--event-ref", terminateAbandonedQuotedRef]).payload;
    assert.equal(terminateAbandonedQuoted.allowed, false);
    assert.ok(codes(terminateAbandonedQuoted.block_reasons).includes("hook_session_termination_untrusted"), JSON.stringify(terminateAbandonedQuoted.block_reasons));
    const terminateWrapperRef = eventFile(fx, "internal-hook-session-wrapper-cancel", bashEvent(fx, "bash -lc \"superspec guard hook-session-end --change demo-change --reason cancelled\""));
    const terminateWrapper = captureMainJson(["hook-check-command", "--change", "demo-change", "--event-ref", terminateWrapperRef]).payload;
    assert.equal(terminateWrapper.allowed, false);
    assert.ok(codes(terminateWrapper.block_reasons).includes("hook_session_termination_untrusted"), JSON.stringify(terminateWrapper.block_reasons));
    const terminateAbandonedWrapperRef = eventFile(fx, "internal-hook-session-wrapper-abandon", bashEvent(fx, "sh -c \"superspec-guard hook-session-end --change demo-change --reason=abandoned\""));
    const terminateAbandonedWrapper = captureMainJson(["hook-check-command", "--change", "demo-change", "--event-ref", terminateAbandonedWrapperRef]).payload;
    assert.equal(terminateAbandonedWrapper.allowed, false);
    assert.ok(codes(terminateAbandonedWrapper.block_reasons).includes("hook_session_termination_untrusted"), JSON.stringify(terminateAbandonedWrapper.block_reasons));
    const terminateBuiltinEvalRef = eventFile(fx, "internal-hook-session-builtin-eval-cancel", bashEvent(fx, "builtin eval \"superspec guard hook-session-end --change demo-change --reason cancelled\""));
    const terminateBuiltinEval = captureMainJson(["hook-check-command", "--change", "demo-change", "--event-ref", terminateBuiltinEvalRef]).payload;
    assert.equal(terminateBuiltinEval.allowed, false);
    assert.ok(codes(terminateBuiltinEval.block_reasons).includes("hook_session_termination_untrusted"), JSON.stringify(terminateBuiltinEval.block_reasons));
    const terminateFdPrefixRef = eventFile(fx, "internal-hook-session-fd-prefix-cancel", bashEvent(fx, "2>/dev/null superspec guard hook-session-end --change demo-change --reason cancelled"));
    const terminateFdPrefix = captureMainJson(["hook-check-command", "--change", "demo-change", "--event-ref", terminateFdPrefixRef]).payload;
    assert.equal(terminateFdPrefix.allowed, false);
    assert.ok(codes(terminateFdPrefix.block_reasons).includes("hook_session_termination_untrusted"), JSON.stringify(terminateFdPrefix.block_reasons));
    const terminateEnvSRef = eventFile(fx, "internal-hook-session-env-s-cancel", bashEvent(fx, "env -S \"superspec guard hook-session-end --change demo-change --reason cancelled\""));
    const terminateEnvS = captureMainJson(["hook-check-command", "--change", "demo-change", "--event-ref", terminateEnvSRef]).payload;
    assert.equal(terminateEnvS.allowed, false);
    assert.ok(codes(terminateEnvS.block_reasons).includes("hook_session_termination_untrusted"), JSON.stringify(terminateEnvS.block_reasons));
    const terminateFindExecGroupRef = eventFile(fx, "internal-hook-session-find-exec-group-cancel", bashEvent(fx, "find . \\( -name foo \\) -exec superspec guard hook-session-end --change demo-change --reason cancelled \\;"));
    const terminateFindExecGroup = captureMainJson(["hook-check-command", "--change", "demo-change", "--event-ref", terminateFindExecGroupRef]).payload;
    assert.equal(terminateFindExecGroup.allowed, false);
    assert.ok(codes(terminateFindExecGroup.block_reasons).includes("hook_session_termination_untrusted"), JSON.stringify(terminateFindExecGroup.block_reasons));
    const terminateBinRef = eventFile(fx, "internal-hook-session-bin-cancel", bashEvent(fx, "bin/superspec-guard.js hook-session-end --change demo-change --reason cancelled"));
    const terminateBin = captureMainJson(["hook-check-command", "--change", "demo-change", "--event-ref", terminateBinRef]).payload;
    assert.equal(terminateBin.allowed, false);
    assert.ok(codes(terminateBin.block_reasons).includes("hook_session_termination_untrusted"), JSON.stringify(terminateBin.block_reasons));
    const terminateNodeBinRef = eventFile(fx, "internal-hook-session-node-bin-cancel", bashEvent(fx, "node bin/superspec-guard.js hook-session-end --change demo-change --reason cancelled"));
    const terminateNodeBin = captureMainJson(["hook-check-command", "--change", "demo-change", "--event-ref", terminateNodeBinRef]).payload;
    assert.equal(terminateNodeBin.allowed, false);
    assert.ok(codes(terminateNodeBin.block_reasons).includes("hook_session_termination_untrusted"), JSON.stringify(terminateNodeBin.block_reasons));
    const terminateNpxRef = eventFile(fx, "internal-hook-session-npx-cancel", bashEvent(fx, "npx --yes superspec-guard hook-session-end --change demo-change --reason cancelled"));
    const terminateNpx = captureMainJson(["hook-check-command", "--change", "demo-change", "--event-ref", terminateNpxRef]).payload;
    assert.equal(terminateNpx.allowed, false);
    assert.ok(codes(terminateNpx.block_reasons).includes("hook_session_termination_untrusted"), JSON.stringify(terminateNpx.block_reasons));
    const terminateNpmExecRef = eventFile(fx, "internal-hook-session-npm-exec-cancel", bashEvent(fx, "npm exec superspec -- guard hook-session-end --change demo-change --reason cancelled"));
    const terminateNpmExec = captureMainJson(["hook-check-command", "--change", "demo-change", "--event-ref", terminateNpmExecRef]).payload;
    assert.equal(terminateNpmExec.allowed, false);
    assert.ok(codes(terminateNpmExec.block_reasons).includes("hook_session_termination_untrusted"), JSON.stringify(terminateNpmExec.block_reasons));
    const terminatePnpmExecRef = eventFile(fx, "internal-hook-session-pnpm-exec-cancel", bashEvent(fx, "pnpm exec superspec-guard hook-session-end --change demo-change --reason cancelled"));
    const terminatePnpmExec = captureMainJson(["hook-check-command", "--change", "demo-change", "--event-ref", terminatePnpmExecRef]).payload;
    assert.equal(terminatePnpmExec.allowed, false);
    assert.ok(codes(terminatePnpmExec.block_reasons).includes("hook_session_termination_untrusted"), JSON.stringify(terminatePnpmExec.block_reasons));
    const terminateNpxCallRef = eventFile(fx, "internal-hook-session-npx-call-cancel", bashEvent(fx, "npx --package @peterxiaoyang/superspec --call \"superspec-guard hook-session-end --change demo-change --reason cancelled\""));
    const terminateNpxCall = captureMainJson(["hook-check-command", "--change", "demo-change", "--event-ref", terminateNpxCallRef]).payload;
    assert.equal(terminateNpxCall.allowed, false);
    assert.ok(codes(terminateNpxCall.block_reasons).includes("hook_session_termination_untrusted"), JSON.stringify(terminateNpxCall.block_reasons));
    const terminateNpmWorkspaceRef = eventFile(fx, "internal-hook-session-npm-workspace-cancel", bashEvent(fx, "npm --workspace app exec superspec-guard hook-session-end --change demo-change --reason cancelled"));
    const terminateNpmWorkspace = captureMainJson(["hook-check-command", "--change", "demo-change", "--event-ref", terminateNpmWorkspaceRef]).payload;
    assert.equal(terminateNpmWorkspace.allowed, false);
    assert.ok(codes(terminateNpmWorkspace.block_reasons).includes("hook_session_termination_untrusted"), JSON.stringify(terminateNpmWorkspace.block_reasons));
    const terminatePnpmShortFilterRef = eventFile(fx, "internal-hook-session-pnpm-short-filter-cancel", bashEvent(fx, "pnpm -F app exec superspec-guard hook-session-end --change demo-change --reason cancelled"));
    const terminatePnpmShortFilter = captureMainJson(["hook-check-command", "--change", "demo-change", "--event-ref", terminatePnpmShortFilterRef]).payload;
    assert.equal(terminatePnpmShortFilter.allowed, false);
    assert.ok(codes(terminatePnpmShortFilter.block_reasons).includes("hook_session_termination_untrusted"), JSON.stringify(terminatePnpmShortFilter.block_reasons));
    const terminateYarnWorkspaceRef = eventFile(fx, "internal-hook-session-yarn-workspace-cancel", bashEvent(fx, "yarn workspace app exec superspec-guard hook-session-end --change demo-change --reason cancelled"));
    const terminateYarnWorkspace = captureMainJson(["hook-check-command", "--change", "demo-change", "--event-ref", terminateYarnWorkspaceRef]).payload;
    assert.equal(terminateYarnWorkspace.allowed, false);
    assert.ok(codes(terminateYarnWorkspace.block_reasons).includes("hook_session_termination_untrusted"), JSON.stringify(terminateYarnWorkspace.block_reasons));
    const terminateYarnCwdWorkspaceRef = eventFile(fx, "internal-hook-session-yarn-cwd-workspace-cancel", bashEvent(fx, "yarn --cwd . workspace app exec superspec-guard hook-session-end --change demo-change --reason cancelled"));
    const terminateYarnCwdWorkspace = captureMainJson(["hook-check-command", "--change", "demo-change", "--event-ref", terminateYarnCwdWorkspaceRef]).payload;
    assert.equal(terminateYarnCwdWorkspace.allowed, false);
    assert.ok(codes(terminateYarnCwdWorkspace.block_reasons).includes("hook_session_termination_untrusted"), JSON.stringify(terminateYarnCwdWorkspace.block_reasons));
  });
});

withFixture("archive and internal writer detectors ignore benign command arguments", (fx) => {
  beginAuditSession(fx);
  const refs = [
    eventFile(fx, "echo-archive-argument", bashEvent(fx, "echo openspec archive")),
    eventFile(fx, "printf-internal-writer-argument", bashEvent(fx, "printf \"%s\\n\" superspec guard hook-record-test")),
    eventFile(fx, "echo-lifecycle-argument", bashEvent(fx, "echo superspec guard hook-session-end --reason cancelled")),
    eventFile(fx, "fd-only-redirect", bashEvent(fx, "echo ok >&2")),
  ];
  withRuntime({ load_context: () => [status(fx), fx.repo, fx.change, []] }, () => {
    for (const ref of refs) {
      const decision = captureMainJson(["hook-check-command", "--change", "demo-change", "--event-ref", ref]).payload;
      assert.equal(decision.allowed, true, JSON.stringify(decision.block_reasons));
    }
  });
});

withFixture("corrupt active hook session blocks scoped writes", (fx) => {
  writeText(join(fx.change, "tasks.md"), "- [ ] TASK-001 Implement\n  - test_refs: TEST-001\n  - invariant_refs: INV-001\n  - write_scope: src/feature.ts\n");
  beginAuditSession(fx);
  writeText(activeSessionFile(fx), "not json\n");
  const ref = eventFile(fx, "corrupt-session-write", applyPatchEvent(fx, "*** Add File: src/feature.ts\n+export const value = 1;\n"));
  withRuntime({ load_context: () => [status(fx), fx.repo, fx.change, []] }, () => {
    const decision = captureMainJson(["hook-check-write", "--change", "demo-change", "--event-ref", ref]).payload;
    assert.equal(decision.allowed, false);
    assert.ok(codes(decision.block_reasons).includes("hook_session_corrupt"), JSON.stringify(decision.block_reasons));
  });
});

withFixture("corrupt superspec state blocks hook APIs before writing", (fx) => {
  beginAuditSession(fx);
  writeText(join(fx.change, ".superspec", "superspec-state.json"), "not json\n");
  const writeRef = eventFile(fx, "corrupt-state-ordinary-write", applyPatchEvent(fx, "*** Add File: src/ordinary.ts\n+ok\n"));
  const testRef = eventFile(fx, "corrupt-state-test-record", {
    hook_event_name: "PostToolUse",
    session_id: "manual-cli-session",
    turn_id: "turn-1",
    tool_name: "Bash",
    tool_use_id: "tool-test",
    cwd: fx.repo,
    tool_input: { command: "npm test" },
    tool_response: { exit_code: 0, stdout: "ok" },
  });
  withRuntime({ load_context: () => [status(fx), fx.repo, fx.change, []] }, () => {
    const writeDecision = captureMainJson(["hook-check-write", "--change", "demo-change", "--event-ref", writeRef]).payload;
    assert.equal(writeDecision.allowed, false);
    assert.ok(codes(writeDecision.block_reasons).includes("state_corrupt"), JSON.stringify(writeDecision.block_reasons));

    const recordDecision = captureMainJson(["hook-record-test", "--change", "demo-change", "--event-ref", testRef]).payload;
    assert.equal(recordDecision.allowed, false);
    assert.ok(codes(recordDecision.block_reasons).includes("state_corrupt"), JSON.stringify(recordDecision.block_reasons));
    assert.equal(existsSync(join(fx.change, ".superspec/evidence/hook-audit")), false);

    const statusDecision = captureMainJson(["hook-session-status", "--change", "demo-change"]).payload;
    assert.equal(statusDecision.allowed, false);
    assert.ok(codes(statusDecision.block_reasons).includes("state_corrupt"), JSON.stringify(statusDecision.block_reasons));
  });
});

withFixture("corrupt active hook session blocks ordinary writes", (fx) => {
  beginAuditSession(fx);
  writeText(activeSessionFile(fx), "not json\n");
  const ref = eventFile(fx, "corrupt-session-ordinary-write", applyPatchEvent(fx, "*** Add File: src/ordinary.ts\n+ok\n"));
  withRuntime({ load_context: () => [status(fx), fx.repo, fx.change, []] }, () => {
    const decision = captureMainJson(["hook-check-write", "--change", "demo-change", "--event-ref", ref]).payload;
    assert.equal(decision.allowed, false);
    const reasonCodes = codes(decision.block_reasons);
    assert.ok(reasonCodes.includes("hook_session_corrupt"), JSON.stringify(decision.block_reasons));
    assert.equal(reasonCodes.includes("task_edit_missing"), false, JSON.stringify(decision.block_reasons));
  });
});

withFixture("parseable corrupt active hook session blocks scoped writes after task_edit allow", (fx) => {
  const tasksText = "- [ ] TASK-001 Implement\n  - test_refs: TEST-001\n  - invariant_refs: INV-001\n  - write_scope: src/feature.ts\n";
  beginAuditSession(fx);
  writeText(activeSessionFile(fx), `${JSON.stringify({
    change_id: "demo-change",
    repo_root: fx.repo,
    session_id: "manual-cli-session",
    trust: "audit-only",
    expires_at: "not-date",
  }, null, 2)}\n`);
  const ref = eventFile(fx, "parseable-corrupt-session-write", applyPatchEvent(fx, "*** Add File: src/feature.ts\n+export const value = 1;\n"));
  const evidences = [...prepareProposeComplete(fx, { tasksText }), redEvidence()];
  withRuntime({ load_context: () => [status(fx), fx.repo, fx.change, evidences] }, () => {
    const decision = captureMainJson(["hook-check-write", "--change", "demo-change", "--event-ref", ref]).payload;
    assert.equal(decision.allowed, false);
    const reasonCodes = codes(decision.block_reasons);
    assert.ok(reasonCodes.includes("hook_session_corrupt"), JSON.stringify(decision.block_reasons));
    assert.equal(reasonCodes.includes("task_edit_missing"), false, JSON.stringify(decision.block_reasons));
  });
});

withFixture("malformed active hook session reason entries block scoped writes after task_edit allow", (fx) => {
  const tasksText = "- [ ] TASK-001 Implement\n  - test_refs: TEST-001\n  - invariant_refs: INV-001\n  - write_scope: src/feature.ts\n";
  beginAuditSession(fx);
  writeText(activeSessionFile(fx), `${JSON.stringify(validSessionRecord(fx, "demo-change", {
    audit_only_reasons: ["not-a-reason"],
  }), null, 2)}\n`);
  const ref = eventFile(fx, "malformed-session-reasons-write", applyPatchEvent(fx, "*** Add File: src/feature.ts\n+export const value = 1;\n"));
  const evidences = [...prepareProposeComplete(fx, { tasksText }), redEvidence()];
  withRuntime({ load_context: () => [status(fx), fx.repo, fx.change, evidences] }, () => {
    const decision = captureMainJson(["hook-check-write", "--change", "demo-change", "--event-ref", ref]).payload;
    assert.equal(decision.allowed, false);
    const reasonCodes = codes(decision.block_reasons);
    assert.ok(reasonCodes.includes("hook_session_corrupt"), JSON.stringify(decision.block_reasons));
    assert.equal(reasonCodes.includes("task_edit_missing"), false, JSON.stringify(decision.block_reasons));
  });
});

withFixture("missing active hook session blocks scoped writes", (fx) => {
  writeText(join(fx.change, "tasks.md"), "- [ ] TASK-001 Implement\n  - test_refs: TEST-001\n  - invariant_refs: INV-001\n  - write_scope: src/feature.ts\n");
  beginAuditSession(fx);
  rmSync(activeSessionFile(fx), { force: true });
  const ref = eventFile(fx, "missing-session-write", applyPatchEvent(fx, "*** Add File: src/feature.ts\n+export const value = 1;\n"));
  withRuntime({ load_context: () => [status(fx), fx.repo, fx.change, []] }, () => {
    const decision = captureMainJson(["hook-check-write", "--change", "demo-change", "--event-ref", ref]).payload;
    assert.equal(decision.allowed, false);
    const reasonCodes = codes(decision.block_reasons);
    assert.ok(reasonCodes.includes("hook_session_missing"), JSON.stringify(decision.block_reasons));
    assert.ok(reasonCodes.includes("task_edit_missing"), JSON.stringify(decision.block_reasons));
  });
});

withFixture("missing active session directory blocks scoped writes even after task_edit allow", (fx) => {
  beginAuditSession(fx);
  rmSync(join(fx.change, ".superspec/hook-runtime/active-sessions"), { recursive: true, force: true });
  const ref = eventFile(fx, "missing-session-dir-scoped-write", applyPatchEvent(fx, "*** Add File: src/feature.ts\n+export const value = 1;\n"));
  const tasksText = "- [ ] TASK-001 Implement\n  - invariant_refs: INV-001\n  - test_refs: TEST-001\n  - write_scope: src/feature.ts\n";
  const evidences = [...prepareProposeComplete(fx, { tasksText }), redEvidence()];
  withRuntime({ load_context: () => [status(fx), fx.repo, fx.change, evidences] }, () => {
    const decision = captureMainJson(["hook-check-write", "--change", "demo-change", "--event-ref", ref]).payload;
    assert.equal(decision.allowed, false);
    assert.ok(codes(decision.block_reasons).includes("hook_session_missing"), JSON.stringify(decision.block_reasons));
    assert.equal(codes(decision.block_reasons).includes("task_edit_missing"), false, JSON.stringify(decision.block_reasons));
  });
});

withFixture("missing active hook session blocks unknown patch shapes", (fx) => {
  beginAuditSession(fx);
  rmSync(activeSessionFile(fx), { force: true });
  const ref = eventFile(fx, "missing-session-unknown-patch", applyPatchEvent(fx, "not a parseable apply_patch payload"));
  withRuntime({ load_context: () => [status(fx), fx.repo, fx.change, []] }, () => {
    const decision = captureMainJson(["hook-check-write", "--change", "demo-change", "--event-ref", ref]).payload;
    assert.equal(decision.allowed, false);
    const reasonCodes = codes(decision.block_reasons);
    assert.ok(reasonCodes.includes("unknown_patch_shape"), JSON.stringify(decision.block_reasons));
  });
});

withFixture("deleted active session directory blocks unknown patch shapes", (fx) => {
  beginAuditSession(fx);
  rmSync(join(fx.change, ".superspec/hook-runtime/active-sessions"), { recursive: true, force: true });
  const ref = eventFile(fx, "deleted-session-dir-unknown-patch", applyPatchEvent(fx, "not a parseable apply_patch payload"));
  withRuntime({ load_context: () => [status(fx), fx.repo, fx.change, []] }, () => {
    const decision = captureMainJson(["hook-check-write", "--change", "demo-change", "--event-ref", ref]).payload;
    assert.equal(decision.allowed, false);
    assert.ok(codes(decision.block_reasons).includes("unknown_patch_shape"), JSON.stringify(decision.block_reasons));
  });
});

withFixture("hook adapter PostToolUse records telemetry only for test validation commands", (fx) => {
  const ordinary = {
    hook_event_name: "PostToolUse",
    session_id: "manual-cli-session",
    turn_id: "turn-1",
    tool_name: "Bash",
    tool_use_id: "tool-ordinary",
    cwd: fx.repo,
    tool_input: { command: "echo ok" },
    tool_response: { exit_code: 0, stdout: "ok" },
  };
  const testCommand = {
    ...ordinary,
    tool_use_id: "tool-test",
    tool_input: { command: "npm test" },
  };
  const shellWrappedTestCommand = {
    ...ordinary,
    tool_use_id: "tool-shell-wrapped-test",
    tool_input: { command: "sh -c 'npm test'" },
  };
  const echoTestText = {
    ...ordinary,
    tool_use_id: "tool-echo-test-text",
    tool_input: { command: "echo npm test" },
  };
  const printfValidateText = {
    ...ordinary,
    tool_use_id: "tool-printf-validate-text",
    tool_input: { command: "printf '%s\\n' 'openspec validate'" },
  };
  const backtickTestText = {
    ...ordinary,
    tool_use_id: "tool-backtick-test-text",
    tool_input: { command: "echo `npm test`" },
  };
  const dollarSubstitutionTestText = {
    ...ordinary,
    tool_use_id: "tool-dollar-substitution-test-text",
    tool_input: { command: "echo \"$(npm test)\"" },
  };
  const findExecTestText = {
    ...ordinary,
    tool_use_id: "tool-find-exec-test-text",
    tool_input: { command: "find . -maxdepth 0 -exec npm test \\;" },
  };
  const pipedTestText = {
    ...ordinary,
    tool_use_id: "tool-piped-test-text",
    tool_input: { command: "npm test | cat" },
  };
  withRuntime({ load_context: () => [status(fx), fx.repo, fx.change, []] }, () => {
    const inert = runHookAdapter(["--change", "demo-change"], JSON.stringify(ordinary));
    assert.equal(inert.code, 0, inert.stderr);
    assert.match(JSON.parse(inert.stdout).systemMessage, /ignored non-test command/u);
    assert.equal(existsSync(join(fx.change, ".superspec/evidence/hook-audit")), false);

    const echoedText = runHookAdapter(["--change", "demo-change"], JSON.stringify(echoTestText));
    assert.equal(echoedText.code, 0, echoedText.stderr);
    assert.match(JSON.parse(echoedText.stdout).systemMessage, /ignored non-test command/u);
    assert.equal(existsSync(join(fx.change, ".superspec/evidence/hook-audit")), false);

    const printedText = runHookAdapter(["--change", "demo-change"], JSON.stringify(printfValidateText));
    assert.equal(printedText.code, 0, printedText.stderr);
    assert.match(JSON.parse(printedText.stdout).systemMessage, /ignored non-test command/u);
    assert.equal(existsSync(join(fx.change, ".superspec/evidence/hook-audit")), false);

    const backtickText = runHookAdapter(["--change", "demo-change"], JSON.stringify(backtickTestText));
    assert.equal(backtickText.code, 0, backtickText.stderr);
    assert.match(JSON.parse(backtickText.stdout).systemMessage, /ignored non-test command/u);
    assert.equal(existsSync(join(fx.change, ".superspec/evidence/hook-audit")), false);

    const dollarSubstitutionText = runHookAdapter(["--change", "demo-change"], JSON.stringify(dollarSubstitutionTestText));
    assert.equal(dollarSubstitutionText.code, 0, dollarSubstitutionText.stderr);
    assert.match(JSON.parse(dollarSubstitutionText.stdout).systemMessage, /ignored non-test command/u);
    assert.equal(existsSync(join(fx.change, ".superspec/evidence/hook-audit")), false);

    const findExecText = runHookAdapter(["--change", "demo-change"], JSON.stringify(findExecTestText));
    assert.equal(findExecText.code, 0, findExecText.stderr);
    assert.match(JSON.parse(findExecText.stdout).systemMessage, /ignored non-test command/u);
    assert.equal(existsSync(join(fx.change, ".superspec/evidence/hook-audit")), false);

    const pipedText = runHookAdapter(["--change", "demo-change"], JSON.stringify(pipedTestText));
    assert.equal(pipedText.code, 0, pipedText.stderr);
    assert.match(JSON.parse(pipedText.stdout).systemMessage, /ignored non-test command/u);
    assert.equal(existsSync(join(fx.change, ".superspec/evidence/hook-audit")), false);

    const recorded = runHookAdapter(["--change", "demo-change"], JSON.stringify(testCommand));
    assert.equal(recorded.code, 0, recorded.stderr);
    assert.match(JSON.parse(recorded.stdout).systemMessage, /telemetry recorded/u);
    const wrapped = runHookAdapter(["--change", "demo-change"], JSON.stringify(shellWrappedTestCommand));
    assert.equal(wrapped.code, 0, wrapped.stderr);
    assert.match(JSON.parse(wrapped.stdout).systemMessage, /telemetry recorded/u);
    const files = readdirSync(join(fx.change, ".superspec/evidence/hook-audit")).filter((name) => name.endsWith(".json"));
    assert.equal(files.length, 2);
  });
});

withFixture("direct hook-record-test spoof creates audit-only telemetry only", (fx) => {
  const ref = eventFile(fx, "post-test", {
    hook_event_name: "PostToolUse",
    session_id: "manual-cli-session",
    turn_id: "turn-1",
    tool_name: "Bash",
    tool_use_id: "tool-1",
    cwd: fx.repo,
    tool_input: { command: "npm test" },
    tool_response: { exit_code: 0, stdout: "ok" },
  });
  withRuntime({ load_context: () => [status(fx), fx.repo, fx.change, []] }, () => {
    const decision = captureMainJson(["hook-record-test", "--change", "demo-change", "--event-ref", ref]).payload;
    assert.equal(decision.actions[0].trusted_runtime_evidence_written, false);
    const evidenceRel = decision.actions[0].audit_only_evidence_ref;
    const evidence = JSON.parse(readFileSync(join(fx.change, evidenceRel), "utf8"));
    assert.equal(evidence.trust, "audit-only");
    assert.equal(evidence.hook_provenance.validation, "audit-only");
    assert.equal(evidence.status, "blocked");
  });
});

withFixture("hook adapter SubagentStart records audit-only runlog with resolved change", (fx) => {
  const event = {
    hook_event_name: "SubagentStart",
    session_id: "manual-cli-session",
    turn_id: "turn-1",
    agent_id: "agent-1",
    agent_type: "critic",
    cwd: fx.repo,
    prompt: "review this",
  };
  withRuntime({ load_context: () => [status(fx), fx.repo, fx.change, []] }, () => {
    const result = runHookAdapter(["--change", "demo-change"], JSON.stringify(event));
    assert.equal(result.code, 0, result.stderr);
    assert.match(JSON.parse(result.stdout).systemMessage, /runlog recorded/u);
    const lines = readFileSync(join(fx.change, ".superspec/subagent-runlog.jsonl"), "utf8").trim().split(/\r?\n/u).map((line) => JSON.parse(line));
    assert.equal(lines.length, 1);
    assert.equal(lines[0].kind, "subagent_start");
    assert.equal(lines[0].trust, "audit-only");
  });
});

withFixture("hook adapter SubagentStart without resolved change returns inert success", (fx) => {
  const result = runHookAdapter([], JSON.stringify({
    hook_event_name: "SubagentStart",
    session_id: "manual-cli-session",
    turn_id: "turn-1",
    agent_id: "agent-1",
    agent_type: "critic",
    cwd: fx.repo,
    prompt: "review this",
  }));
  assert.equal(result.code, 0, result.stderr);
  assert.match(JSON.parse(result.stdout).systemMessage, /SUPERSPEC_CHANGE\/--change not set/u);
  assert.equal(existsSync(join(fx.change, ".superspec/subagent-runlog.jsonl")), false);
});

withFixture("hook adapter SubagentStart telemetry failure returns inert success", (fx) => {
  withRuntime({ load_context: () => { throw new Error("runtime unavailable"); } }, () => {
    const result = runHookAdapter(["--change", "demo-change"], JSON.stringify({
      hook_event_name: "SubagentStart",
      session_id: "manual-cli-session",
      turn_id: "turn-1",
      agent_id: "agent-1",
      agent_type: "critic",
      cwd: fx.repo,
      prompt: "review this",
    }));
    assert.equal(result.code, 0, result.stderr);
    const payload = JSON.parse(result.stdout);
    assert.match(payload.systemMessage, /runlog skipped/u);
    assert.match(payload.hookSpecificOutput.additionalContext, /did not block/u);
  });
});

withFixture("hook adapter malformed default subagent event returns inert success", () => {
  const result = runHookAdapter([], JSON.stringify({ hook_event_name: "SubagentStart" }));
  assert.equal(result.code, 0, result.stderr);
  const payload = JSON.parse(result.stdout);
  assert.match(payload.systemMessage, /SUPERSPEC_CHANGE\/--change not set/u);
  assert.match(payload.hookSpecificOutput?.additionalContext ?? payload.systemMessage, /did not block|not set/u);
});

withFixture("direct hook-record-subagent spoof creates audit-only runlog only", (fx) => {
  const startRef = eventFile(fx, "subagent-start", {
    hook_event_name: "SubagentStart",
    session_id: "manual-cli-session",
    turn_id: "turn-1",
    agent_id: "agent-1",
    agent_type: "critic",
    cwd: fx.repo,
    prompt: "review this",
  });
  const stopRef = eventFile(fx, "subagent-stop", {
    hook_event_name: "SubagentStop",
    session_id: "manual-cli-session",
    turn_id: "turn-1",
    agent_id: "agent-1",
    agent_type: "critic",
    cwd: fx.repo,
    last_assistant_message: "done",
    status: "completed",
  });
  withRuntime({ load_context: () => [status(fx), fx.repo, fx.change, []] }, () => {
    const start = captureMainJson(["hook-record-subagent-start", "--change", "demo-change", "--event-ref", startRef]).payload;
    const stop = captureMainJson(["hook-record-subagent-stop", "--change", "demo-change", "--event-ref", stopRef]).payload;
    assert.equal(start.actions[0].trusted_runlog_record_written, false);
    assert.equal(stop.actions[0].trusted_runlog_record_written, false);
    const lines = readFileSync(join(fx.change, ".superspec/subagent-runlog.jsonl"), "utf8").trim().split(/\r?\n/u).map((line) => JSON.parse(line));
    assert.equal(lines.length, 2);
    assert.ok(lines.every((line) => line.trust === "audit-only"), JSON.stringify(lines));
  });
});

withFixture("direct hook-session-end reaches Guard but cannot close before terminal gate", (fx) => {
  beginAuditSession(fx);
  withRuntime({ load_context: () => [status(fx), fx.repo, fx.change, []] }, () => {
    const ended = captureMainJson([
      "hook-session-end",
      "--change", "demo-change",
      "--reason", "completed",
    ]).payload;
    assert.equal(ended.actions[0].trusted_active_session_closed, false);
    assert.equal(ended.actions[0].audit_only_session_closed, false);
    assert.equal(ended.actions[0].active_session_present, true);
    assert.ok(codes(ended.audit_only_reasons).includes("hook_session_terminal_not_ready"), JSON.stringify(ended.audit_only_reasons));
    const ref = eventFile(fx, "ordinary-after-end", applyPatchEvent(fx, "*** Add File: src/ordinary.ts\n+ok\n"));
    const decision = captureMainJson(["hook-check-write", "--change", "demo-change", "--event-ref", ref]).payload;
    assert.equal(decision.allowed, true);
    assert.equal(decision.enforcement, "guarded");
  });
});

withFixture("hook-session-end completed closes audit lease only after terminal Guard authority", (fx) => {
  beginAuditSession(fx);
  const evidences = archiveReadyEvidences(fx);
  withRuntime({
    load_context: () => [status(fx), fx.repo, fx.change, evidences],
    dirty_worktree_reasons: () => [],
    dirty_write_scope_red_reasons: () => [],
  }, () => {
    const ended = captureMainJson([
      "hook-session-end",
      "--change", "demo-change",
      "--reason", "completed",
    ]).payload;
    assert.equal(ended.actions[0].trusted_active_session_closed, false);
    assert.equal(ended.actions[0].audit_only_session_closed, true);
    assert.equal(ended.actions[0].active_session_present, true);
    const ref = eventFile(fx, "ordinary-after-lifecycle-end", applyPatchEvent(fx, "*** Add File: src/ordinary.ts\n+ok\n"));
    const decision = captureMainJson(["hook-check-write", "--change", "demo-change", "--event-ref", ref]).payload;
    assert.equal(decision.allowed, true);
    assert.equal(decision.enforcement, "pass-through");
    const scopedRef = eventFile(fx, "scoped-after-lifecycle-end", applyPatchEvent(fx, "*** Add File: src/feature.ts\n+ok\n"));
    const scoped = captureMainJson(["hook-check-write", "--change", "demo-change", "--event-ref", scopedRef]).payload;
    assert.equal(scoped.allowed, true, JSON.stringify(scoped));
    assert.equal(scoped.enforcement, "pass-through");
  });
});

withFixture("ordinary hook-session-end cannot close trusted active session", (fx) => {
  beginAuditSession(fx);
  const trustedSessionFile = activeSessionFile(fx);
  writeText(
    trustedSessionFile,
    `${JSON.stringify(validSessionRecord(fx, "demo-change", {
      trust: "trusted",
      strict_profile: "available",
      audit_only_reasons: [],
    }), null, 2)}\n`,
  );
  const evidences = archiveReadyEvidences(fx);
  withRuntime({
    load_context: () => [status(fx), fx.repo, fx.change, evidences],
    dirty_worktree_reasons: () => [],
    dirty_write_scope_red_reasons: () => [],
  }, () => {
    const ended = captureMainJson([
      "hook-session-end",
      "--change", "demo-change",
      "--reason", "completed",
    ]).payload;
    assert.equal(ended.actions[0].trusted_active_session_closed, false);
    assert.equal(ended.actions[0].audit_only_session_closed, false);
    assert.equal(existsSync(trustedSessionFile), true);
    assert.ok(codes(ended.audit_only_reasons).includes("hook_session_trusted_close_unavailable"), JSON.stringify(ended.audit_only_reasons));
  });
});

withFixture("hook-session status diagnostics return success exit code", (fx) => {
  beginAuditSession(fx);
  withRuntime({ load_context: () => [status(fx), fx.repo, fx.change, []] }, () => {
    const statusResult = captureMainJson(["hook-session-status", "--change", "demo-change"]);
    assert.equal(statusResult.exitCode, 0);
    assert.equal(statusResult.payload.decision, "status");
    assert.equal(statusResult.payload.allowed, true);
    assertNoLifecycleLeak(statusResult.payload);
    assert.equal("record" in statusResult.payload.actions[0], false);
  });
});

withFixture("hook-session begin and status outputs do not leak lifecycle close tokens", (fx) => {
  withRuntime({ load_context: () => [status(fx), fx.repo, fx.change, []] }, () => {
    const beginJson = captureMainJson([
      "hook-session-begin",
      "--change", "demo-change",
      "--workflow", "superspec-archive",
      "--entrypoint-token", "test-token",
    ]);
    assert.equal(beginJson.exitCode, 0);
    assertNoLifecycleLeak(beginJson.payload);
    assert.equal("record" in beginJson.payload.actions[0], false);

    const beginResult = captureMain([
      "hook-session-begin",
      "--change", "demo-change",
      "--workflow", "superspec-archive",
      "--entrypoint-token", "test-token",
      "--format", "agent",
    ]);
    assert.equal(beginResult.exitCode, 0);
    const beginAgent = JSON.parse(beginResult.stdout);
    assertNoForbiddenAgentKeys(beginAgent);
    assertNoLifecycleLeak(beginAgent);

    const statusResult = captureMain(["hook-session-status", "--change", "demo-change", "--format", "agent"]);
    assert.equal(statusResult.exitCode, 0);
    const statusAgent = JSON.parse(statusResult.stdout);
    assertNoForbiddenAgentKeys(statusAgent);
    assertNoLifecycleLeak(statusAgent);
  });
});

withFixture("hook-session active record does not persist lifecycle token material", (fx) => {
  beginAuditSession(fx);
  const recordText = readFileSync(activeSessionFile(fx), "utf8");
  assert.doesNotMatch(recordText, /lifecycle_nonce/u);
  assert.doesNotMatch(recordText, /lifecycle_token/u);
  assert.doesNotMatch(recordText, /entrypoint_token/u);
});

withFixture("hook-session-end cancel and abandon do not close audit lease through ordinary CLI", (fx) => {
  for (const endReason of ["cancelled", "abandoned"] as const) {
    for (const withToken of [false, true]) {
      beginAuditSession(fx);
      const lifecycleToken = "legacy-ignored-token";
      withRuntime({ load_context: () => [status(fx), fx.repo, fx.change, []] }, () => {
        const args = [
          "hook-session-end",
          "--change", "demo-change",
          "--reason", endReason,
          ...(withToken ? ["--lifecycle-token", lifecycleToken] : []),
        ];
        const ended = captureMainJson(args).payload;
        assert.equal(ended.actions[0].trusted_active_session_closed, false);
        assert.equal(ended.actions[0].audit_only_session_closed, false);
        assertNoLifecycleLeak(ended);
        assert.equal("lifecycle_token_provided" in ended.actions[0], false);
        assert.equal("lifecycle_token_fingerprint" in ended.actions[0], false);
        assert.ok(codes(ended.audit_only_reasons).includes("hook_session_terminal_authority_unavailable"), JSON.stringify(ended.audit_only_reasons));
        const ref = eventFile(fx, `ordinary-after-${endReason}-${withToken}`, applyPatchEvent(fx, "*** Add File: src/ordinary.ts\n+ok\n"));
        const decision = captureMainJson(["hook-check-write", "--change", "demo-change", "--event-ref", ref]).payload;
        assert.equal(decision.allowed, true);
        assert.equal(decision.enforcement, "guarded");
      });
    }
  }
});

withFixture("hook-session-end archived without terminal archive proof cannot close audit lease", (fx) => {
  beginAuditSession(fx);
  const previousCwd = process.cwd();
  process.chdir(fx.repo);
  try {
    withRuntime({ load_context: () => [status(fx), fx.repo, fx.change, []] }, () => {
      const ended = captureMainJson([
        "hook-session-end",
        "--change", "demo-change",
        "--reason", "archived",
      ]).payload;
      assert.equal(ended.actions[0].trusted_active_session_closed, false);
      assert.equal(ended.actions[0].audit_only_session_closed, false);
      assert.ok(codes(ended.audit_only_reasons).includes("hook_session_terminal_not_ready"), JSON.stringify(ended.audit_only_reasons));
      const ref = eventFile(fx, "ordinary-after-nonterminal-end", applyPatchEvent(fx, "*** Add File: src/ordinary.ts\n+ok\n"));
      const decision = captureMainJson(["hook-check-write", "--change", "demo-change", "--event-ref", ref]).payload;
      assert.equal(decision.allowed, true);
      assert.equal(decision.enforcement, "guarded");
    });
  } finally {
    process.chdir(previousCwd);
  }
});

withFixture("hook-session-end archived closes audit lease from archived root without active status", (fx) => {
  beginAuditSession(fx);
  writeText(join(fx.change, ".superspec", "superspec-state.json"), "{}\n");
  guard.write_archive_preservation_bundle("demo-change", fx.change);
  const archiveRoot = join(fx.repo, "openspec", "changes", "archive", "2026-06-14-demo-change");
  mkdirSync(join(fx.repo, "openspec", "changes", "archive"), { recursive: true });
  renameSync(fx.change, archiveRoot);

  const previousCwd = process.cwd();
  process.chdir(fx.repo);
  try {
    withRuntime({
      load_context: () => {
        throw new Error("archived hook-session-end must not load active change context");
      },
    }, () => {
      const ended = captureMainJson([
        "hook-session-end",
        "--change", "demo-change",
        "--reason", "archived",
      ]).payload;
      assert.equal(ended.actions[0].trusted_active_session_closed, false);
      assert.equal(ended.actions[0].audit_only_session_closed, true);
      assert.equal(ended.actions[0].active_session_present, true);
      assert.equal(existsSync(join(archiveRoot, ".superspec", "hook-runtime", "active-sessions")), false);
      const archived = guard.check_archived("demo-change", fx.repo);
      assert.equal(archived.allowed, true, JSON.stringify(archived.block_reasons));
    });
  } finally {
    process.chdir(previousCwd);
  }
});

withFixture("strict runtime evidence cannot omit provenance token and exit code binding", (fx) => {
  const ev = materializeEvidenceRecord(fx, ".superspec/evidence/verification/EV-strict-final.json", {
    schema_version: 1,
    evidence_id: "EV-strict-final",
    change_id: "demo-change",
    gate: "review_complete",
    kind: "final_test",
    created_at: "2026-06-13T00:00:00Z",
    created_by: "test",
    status: "pass",
    trust: "runtime-verified",
    test_command: "npm test",
    output_ref: ".superspec/raw/final.log",
  });
  writeText(join(fx.change, ".superspec/raw/final.log"), "final log\n");
  const problems = guard.validate_evidence_schema(ev, "demo-change", fx.change, fx.repo);
  const reasonCodes = codes(problems);
  assert.ok(reasonCodes.includes("runtime_evidence_untrusted_provenance"), JSON.stringify(problems));
  assert.ok(reasonCodes.includes("runtime_evidence_missing_token"), JSON.stringify(problems));
  assert.ok(reasonCodes.includes("runtime_evidence_missing_exit_code"), JSON.stringify(problems));
});

withFixture("copied token with audit-only provenance cannot satisfy strict runtime evidence", (fx) => {
  const ev = materializeEvidenceRecord(fx, ".superspec/evidence/verification/EV-replayed-token.json", {
    schema_version: 1,
    evidence_id: "EV-replayed-token",
    change_id: "demo-change",
    gate: "review_complete",
    kind: "final_test",
    created_at: "2026-06-13T00:00:00Z",
    created_by: "test",
    status: "pass",
    trust: "runtime-verified",
    test_command: "npm test",
    output_ref: ".superspec/raw/final.log",
    hook_event_id: "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    exit_code: 0,
    command_fingerprint: "sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
    raw_log_pinned_refs: [{ path: ".superspec/raw/final.log", blob_sha: "sha256:cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc" }],
    token_binding: { token_id: "copied-token", nonce: "replayed" },
    hook_provenance: { validation: "audit-only", hook_event_name: "PostToolUse" },
  });
  writeText(join(fx.change, ".superspec/raw/final.log"), "final log\n");
  const problems = guard.validate_evidence_schema(ev, "demo-change", fx.change, fx.repo);
  const reasonCodes = codes(problems);
  assert.ok(reasonCodes.includes("runtime_evidence_untrusted_provenance"), JSON.stringify(problems));
  assert.equal(reasonCodes.includes("runtime_evidence_missing_token"), false, JSON.stringify(problems));
});

withFixture("forged trusted runtime evidence is still rejected while strict profile is unavailable", (fx) => {
  const ev = materializeEvidenceRecord(fx, ".superspec/evidence/verification/EV-forged-trusted.json", {
    schema_version: 1,
    evidence_id: "EV-forged-trusted",
    change_id: "demo-change",
    gate: "review_complete",
    kind: "final_test",
    created_at: "2026-06-13T00:00:00Z",
    created_by: "test",
    status: "pass",
    trust: "runtime-verified",
    test_command: "npm test",
    output_ref: ".superspec/raw/final.log",
    hook_event_id: "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    exit_code: 0,
    command_fingerprint: "sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
    raw_log_pinned_refs: [{ path: ".superspec/raw/final.log", blob_sha: "sha256:cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc" }],
    token_binding: { token_id: "forged-token", nonce: "forged" },
    hook_provenance: { validation: "trusted", hook_event_name: "PostToolUse" },
  });
  writeText(join(fx.change, ".superspec/raw/final.log"), "final log\n");
  const problems = guard.validate_evidence_schema(ev, "demo-change", fx.change, fx.repo);
  const reasonCodes = codes(problems);
  assert.ok(reasonCodes.includes("runtime_evidence_strict_profile_unavailable"), JSON.stringify(problems));
});

withFixture("runtime-verified role evidence without trusted runlog is rejected", (fx) => {
  const ev = roleEvidence(fx, "review_complete", "critic", {
    kind: "verification_review",
    trust: "runtime-verified",
    openspec_validate_ref: ".superspec/reports/validate.log",
    task_matrix_ref: ".superspec/reports/tasks.log",
    invariant_matrix_ref: ".superspec/reports/invariants.log",
    scope_drift_ref: ".superspec/reports/scope.log",
    test_evidence_refs: ["EV-final-test"],
  });
  for (const rel of [ev.openspec_validate_ref, ev.task_matrix_ref, ev.invariant_matrix_ref, ev.scope_drift_ref]) {
    writeText(join(fx.change, rel), "ok\n");
  }
  const problems = guard.validate_evidence_schema(ev, "demo-change", fx.change, fx.repo);
  assert.ok(codes(problems).includes("hook_runlog_missing"), JSON.stringify(problems));
});
