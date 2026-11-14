# REVIEWTHROTTLESLEEP-01

## Summary

Pre-model GitHub exhaustion now releases reviewer claims and credential slots
instead of sleeping through the reset. Existing exhausted-provider fallback
remains available. Long unscoped throttle waits confirm current quota first,
and zero observations retain the quota headers needed for attribution.

See the [SEV2 report](../postmortems/SEV2-REVIEWTHROTTLESLEEP-01-reviewer-budget-sleep.md).
Historical core exhaustion remains unconfirmed; source tests do not establish
which consumer drained the incident bucket.

## Interface changes

- Reviewer exit 79 plus `[reviewer-github-budget-deferred]` JSON identifies a
  pre-model `github-budget-deferred` outcome with resource, credential, balance
  and reset. The pass is cancelled; no review, infrastructure or hard-ceiling attempt is charged.
- Existing cascade `nextRetryAfter` stores that exact reset; its
  `lastFailureModel` limits this hold to the deferred reviewer. Existing fallback
  may select another reviewer before reset without changing preferences.
- Budget observations may include `confirmedAt`. API-call diagnostics include
  `budget_exhaustion` and `budget_confirmation` units; only the five allowlisted
  raw quota headers are retained.
- No new configuration, CI check, gate or override label.

## Verification

Targeted `node --test <file>` runs pass for:

- `test/reviewer-github-budget.test.mjs`: CLI exit 79 before model/transport,
  swallowed optional deferrals and exhaustion on the final successful read.
- `test/rate-limit-throttle.test.mjs`: stale-zero confirmation and correction,
  failed/secondary-limit holds, sending identity and raw-header attribution.
- `test/reviewer-spawn-settle.test.mjs`: claim and credential-slot release,
  exact reset, cancellation accounting and replacement-claim protection.
- `test/afh-reviewer-fallback.test.mjs`: the existing exhausted-provider
  alternate can run before reset; preference returns after provider recovery.
- `test/watcher-review-dedup-ceiling.test.mjs`: cancelled budget deferrals do
  not spend the hard attempt ceiling.
- `test/metered-gh-cli.test.mjs`: quota-header attribution without debug secrets.
- `test/watcher-claim-loop.test.mjs`: pending requeue, reset hold and resumed
  dispatch, alongside the existing single-claim CAS regressions.
- `test/smv.test.mjs`: declared state transitions and disposable-Git smoke.

Tests run one file at a time, offline, with `NETGUARD_LOG` and the required
netguard `PATH`, bounded to 600 seconds through the worker-validation wrapper.
`npm run lint` and `npm run typecheck:contracts` pass; ESLint fixes/checks also
cover the changed source and test files. The full suite and walkthrough are
omitted under the ticket's explicit touched-test-only constraint.

## HAM remediation

The trailing pre-model budget check accepts an optional second argument with
`{ env }` for the sending credential. A malformed deferral receipt logs a
diagnostic, backs off, and releases only the matching claim rather than throwing.
Quota confirmation explicitly merges local and shared observations; the shared
reader already performs this merge, retaining its existing behavior.

CI fixtures export the new cascade seam, isolate long-wait confirmation from
external transport, select sleep telemetry by category, and keep the owner-store
status fixture within a short wait. The reviewer export list is compacted without
changing exports to satisfy the existing decomposition limit.

HAM verification: the changed-surface selection passed 2,009 tests before two
new test-only errors were corrected. The final settlement and watcher claim-loop
run passed all 207 tests. Lint (zero errors), contract typechecking, and the
research walkthrough passed. The additional ARC10 local selection reported
`local-battery-skipped-github-required-gate-authoritative`; exact-head GitHub
required checks remain mandatory.
