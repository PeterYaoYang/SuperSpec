# SuperSpec guard TypeScript Runtime Checklist

The legacy guard has been removed. The only supported runtime is:

```bash
./scripts/superspec_guard <command> --change <change>
```

The wrapper executes `node scripts/superspec/superspec_guard.ts` directly on Node 24+ using native type stripping.

## Runtime Contract

- Source: `scripts/superspec/superspec_guard.ts`
- Tests: `scripts/superspec/tests/*.test.ts`
- Typecheck: `cd scripts/superspec && npm run typecheck`
- Test: `cd scripts/superspec && npm test`
- Runtime dependencies: Node built-ins only.
- Dev dependencies: `typescript` and `@types/node` only.

## Change Rules

1. Keep the guard in erasable TypeScript syntax: no `enum`, `namespace`, decorators, parameter properties, or runtime-only TS constructs.
2. Do not add runtime npm dependencies.
3. Keep CLI output JSON and exit codes stable:
   - allow -> `0`
   - block -> `1`
   - guard/internal error -> `2`
4. Keep `scripts/superspec_guard` as the only skill-facing entrypoint.
5. Add or update `node:test` coverage for every gate behavior change.
6. Run `npm run typecheck`, `npm test`, and wrapper smoke checks before claiming completion.

## Required Verification

```bash
cd scripts/superspec
npm run typecheck
npm test
cd /Users/ihr/workProject/irenshi-attendance
./scripts/superspec_guard status --change openspec-delivery-extension
./scripts/superspec_guard check-init --change openspec-delivery-extension
./scripts/superspec_init
```
