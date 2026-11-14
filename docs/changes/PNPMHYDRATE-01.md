# PNPMHYDRATE-01

## Summary

Canonical hammer validation now recognizes pnpm-locked product repositories.
It reads script invocations from local pull-request workflows and runs them in
workflow order under the exact pnpm version in `packageManager`, supplied through
the existing npm toolchain. Formatting, lint and tests therefore run when those
workflows require them, including for documentation-only changes.

Missing or floating version pins raise a typed selection error and fail targeted
validation. Unmodelled workflow shapes use the exact-head GitHub fallback;
gated jobs and steps are excluded. Version pins are enforced, but optional
packageManager integrity suffixes are not verified. Selected batteries default
to a load-scaled 1800-second nominal budget, with explicit CLI overrides honored.
A private scratch startup receipt separates npm provisioning from script failures:
startup failures retry once within the same budget, then return the existing
non-counted `validation-environment-failed` closer outcome. Script failures remain
real failures and are never retried. No CI gate or successor mechanism is added.

Offline synthetic tests verify selection, pin refusal, formatter failure and
missing-tool behavior without installing packages. The companion agent-os change
owns provisioning, readiness and the SEV1 report.

## Interface changes

The canonical selector can return a required pnpm workflow runner.
`ValidationSelectionError` reports missing/floating pins as real failures;
`UnsupportedPnpmWorkflowError` selects the existing skipped-battery fallback.
The runner supplies a nominal timeout and startup receipt requirement. Exit 78
is reserved for tool startup failure at the canonical CLI/controller boundary;
repository script exit 78 becomes 1.

## Verification

Bounded targeted validation passed for `test/pnpmhydrate-01.test.mjs`,
`test/hamcontrollerscript-01.test.mjs`, `test/hamselferrors-01.test.mjs` and
`test/run-bounded.test.mjs`. Tests use local npm/pnpm stubs, never registry access.
`npm run lint`: zero errors (existing warnings); `npm run typecheck:contracts`:
passed; `bash demo/research-finding-walkthrough.sh`: three byte-stable deliveries.
`git diff --check` and controller shell syntax passed. No full local suite ran.
