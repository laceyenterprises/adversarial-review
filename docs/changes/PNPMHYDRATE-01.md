# PNPMHYDRATE-01

## Summary

Canonical hammer validation now recognizes pnpm-locked product repositories.
It reads script invocations from local pull-request workflows and runs them in
workflow order under the exact pnpm version in `packageManager`, supplied through
the existing npm toolchain. Formatting, lint and tests therefore run when those
workflows require them, including for documentation-only changes.

Unsupported workflow shell/context syntax or a missing version pin raises a
typed selection error and fails the existing targeted validation phase. Missing
tools and execution failures for this selected runner cannot become a successful
skipped local battery. Existing Agent OS and adversarial-review selectors retain
their behavior; there is no additional CI gate or successor mechanism.

Offline synthetic tests verify selection, pin refusal, formatter failure and
missing-tool behavior without installing packages. The companion agent-os change
owns provisioning, readiness and the SEV1 report.

## Interface changes

The canonical selector can return a required pnpm workflow runner.
`ValidationSelectionError` reports unsupported/missing pnpm selection inputs;
the CLI uses the existing `targeted-validation-failed` phase.

## Verification

Individual offline test files: `node --test test/pnpmhydrate-01.test.mjs`
(7 passed) and `node --test test/hamselferrors-01.test.mjs` (11 passed).
Both ran through bounded worker validation with NETGUARD and a 600-second budget.
`npm run lint`: zero errors; `npm run typecheck:contracts`: passed;
`bash demo/research-finding-walkthrough.sh`: three byte-stable fixture deliveries.
