# SuperSpec guard fix checklist

This checklist is TS-only. Historical alternate guard and legacy test artifacts have been removed.

## Current Target Files

- Guard: `scripts/superspec/superspec_guard.ts`
- Init script: `scripts/superspec/superspec_init.ts`
- Guard modules: `scripts/superspec/src/*.ts`
- Tests: `scripts/superspec/tests/*.test.ts`
- Wrapper: `scripts/superspec_guard`
- Init alias: `scripts/superspec_init`

## Required Checks

```bash
cd scripts/superspec
npm run typecheck
npm test
cd /Users/ihr/workProject/irenshi-attendance
./scripts/superspec_guard status --change openspec-delivery-extension
./scripts/superspec_guard check-init --change openspec-delivery-extension
./scripts/superspec_init
```

## Maintenance Rules

1. Keep OpenSpec as the canonical planning system.
2. Keep SuperSpec state and evidence under `.superspec`.
3. Keep repo-local SuperSpec native agents under `.codex/agents`.
4. Add a failing `node:test` case before changing guard semantics.
5. Do not reintroduce a second guard implementation.
