# SuperSpec v2 Hook Contract

Status: implemented as audit-only fallback. Strict profile is unavailable until R-1 deny and hook-only provenance both pass in the target Codex environment.

## Entrypoints

- `superspec-hook --change <change>` reads a Codex hook JSON event from stdin.
- Guard-facing APIs:
  - `superspec guard hook-check-write --change <change> --event-ref <json>`
  - `superspec guard hook-check-command --change <change> --event-ref <json>`
  - `superspec guard hook-record-test --change <change> --event-ref <json>`
  - `superspec guard hook-record-subagent-start --change <change> --event-ref <json>`
  - `superspec guard hook-record-subagent-stop --change <change> --event-ref <json>`
  - `superspec guard hook-health --change <change>`
  - `superspec guard hook-session-begin/status/end --change <change> ...`

The adapter normalizes events and calls Guard APIs. When no change can be resolved, it may apply conservative bootstrap fail-closed checks for SuperSpec state roots, archive commands, internal hook writers, unsafe lifecycle termination, outside-repo targets, and ambiguous active sessions.

## Trust Model

Current strict decision output is always:

```json
{
  "strict_profile": "unavailable",
  "trust": "audit-only"
}
```

Required downgrade reasons include `r1_deny_spike_not_passed` and `hook_provenance_unavailable`; managed hook manifest absence or mismatch also adds `hook_manifest_missing_or_unmanaged`.

`--event-ref`, stdin JSON, environment variables, event ids, and token-like fields are input data only. They do not prove the event came from Codex's hook runner. Direct CLI calls and copied/replayed events can create audit telemetry, but never trusted evidence, trusted runlog, or trusted active sessions.

`hook-session-begin/status/end` and active-session records do not persist or echo lifecycle-token or entrypoint-token material. The compatibility `--lifecycle-token` input is ignored. `hook-session-end` can close an audit-only lease only after a terminal Guard condition passes (`completed` requires `review_complete`; `archived` requires `check-archived`). `cancelled` and `abandoned` currently return diagnostics only because trusted terminal provenance is unavailable. This returns ordinary work to inert pass-through behavior after proven terminal states, but it still never creates a trusted session-close claim while R-1/provenance are unavailable.

## Enforcement Behavior

- No active SuperSpec session: ordinary non-SuperSpec project writes pass through. SuperSpec state roots are denied or make strict health fail.
- Active audit-only session: scoped writes, task checkbox changes, protected OpenSpec canonical edits, early archive commands, internal hook writer calls, corrupt sessions, and unknown write targets fail closed.
- Missing or deleted active-session state fails closed for scoped/protected/unknown SuperSpec writes only after a workflow activation has created hook-runtime state; a repo/change that was never active remains inert/pass-through for ordinary non-SuperSpec writes.
- Multiple active sessions without `SUPERSPEC_CHANGE` fail closed for write-capable events; the caller must set the change id or close stale leases.
- State-root checks are path-intersection checks for `.superspec/**`, `.codex/superspec/**`, and `openspec/changes/*/.superspec/**`; parent directories such as `.codex` or `openspec/changes/<change>` are denied when the operation may overwrite, remove, or otherwise touch those SuperSpec state roots. Codex-owned configuration and extension surfaces such as `.codex/hooks.json`, `.codex/config.toml`, `.codex/skills/**`, `.codex/prompts/**`, `.codex/agents/**`, and `.omx/state/**` are outside SuperSpec hook protection scope.
- OpenSpec canonical checks are scoped to the current change path, `openspec/changes/<change>/{proposal.md,design.md,tasks.md,specs/**}`; ordinary project files such as `docs/design.md` or `src/specs/*` stay pass-through when no session is active.
- Unsupported write surfaces without an active session pass through with audit-only downgrade unless an event delivered to the adapter contains write-capable text that clearly touches SuperSpec trust roots. Unsupported scoped writes during an active session fail closed. Node REPL, unified exec, and similar exec-like surfaces remain strict-unavailable unless the hook runner actually delivers their events to the adapter.
- `PostToolUse` writes audit telemetry only for commands classified as test or validation commands. `SubagentStart/Stop` write audit telemetry only.

## Strict Evidence Preconditions

Strict runtime test evidence requires trusted hook provenance, Guard token binding, command fingerprint, numeric exit code, hook event id, raw log pinned refs, and semantic status/exit code consistency.

Strict role evidence requires trusted matching `SubagentStart` and `SubagentStop` records, expected role, and output binding. Audit-only runlog records do not satisfy strict role gates.

## Audit-only Residual Paths

- Human confirmation and user intent.
- R-1 failed physical deny for the current Codex invocation.
- Complex Bash, shell wrappers, package scripts, `unified_exec`, and archive-like filesystem moves beyond conservative classifiers.
- Unsupported MCP, Node REPL, and exec-like write surfaces.
- Direct `hook-record-*`, `hook-session-*`, or `superspec-hook` CLI calls.
- Copied/replayed hook stdin, environment, event ids, entrypoint/lifecycle tokens, or decision tokens.
- Hooks disabled, untrusted, unmanaged, not loaded, or missing adapter provenance.
