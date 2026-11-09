# PRERECEIPTADOPT-01

## Summary

Recover the unique closer receipt carrying an interrupted intent's own key when
its ticket is null/empty and optional repository/head identity matches. Preserve
foreign, ambiguous, multiple-row and worker-class protections. Terminal recovery
uses the shared retry/merge-aware lease observer before watcher admission.

See the [SEV2 report](../postmortems/SEV2-interrupted-closer-dispatch-could-not-adopt-its-own-empty-ticket-receipt-2026-11-08.md)
for incident evidence and the upstream projection follow-up.

## Interface changes

`settle-legacy-closer-intent.mjs` can recover a terminal keyed receipt rather
than refusing every existing receipt. Apply retains the owner/reason/audit
requirements and records `settled-terminal-receipt` on completed settlement;
unresolved terminal evidence reports `receipt-settlement-pending` and audits
`receipt-adopted-settlement-pending` with persisted state. Re-running is safe.
Terminal recovery resolves the HQ audit root explicitly, isolates observer
reader contracts and bounds nested capacity-scan reads. Exact-ticket recovery
preserves pinned non-hammer and legacy missing-class compatibility. Settled
receipts no longer consume fleet capacity.
Dry-run previews recovery without writes. Existing lease states, merge
authority, retry accounting and absence-proof requirements remain unchanged.

## Verification

Tests ran individually with `NETGUARD_LOG=<file>` and
`PATH=/Users/Shared/evalbench/work/netguard/bin:$PATH`, through
`cwp_dispatch.worker_validation --timeout-seconds 600`:

- `node --test test/ama-pre-receipt-intent.test.mjs`: 148 pass, 29 baseline
  failures; all 21 new ticket cases pass. Unmodified `origin/main` reproduces
  the same 29 failures.
- `node --test test/ama-hammer-background-dispatch.test.mjs`: 148 pass,
  including normal and rekeyed watcher admission after terminal recovery.
- `npm run lint`: zero errors; existing warnings.
- `npm run typecheck:contracts`: pass.

The full suite and demo were not run under the ticket's touched-tests-only
constraint. No live state was modified.

Remediation validation after rebasing onto fresh `origin/main`:

- Bounded targeted `PRERECEIPTADOPT-01` tests in the pre-receipt and background
  dispatch suites pass (34 top-level results; the background wrapper also runs
  and passes all 148 watcher cases).
- Focused capacity-settlement and independent PR-reader regressions pass (2/2).
- `npm run lint`: zero errors (existing warnings).
- `npm run typecheck:contracts`, `node scripts/validate-data-model-catalog.mjs`
  and `git diff --check`: pass.
- The SMV independent-graph test fails with graph hash `127a3252…` versus
  `12aa71a8…`; the identical failure reproduces on clean rebased HEAD
  `bd493eb042958ab5e75463ace2208daa112ac898`. No graph/guard is changed.
  Reviewed affected source projections were refreshed and separately verified.

The full suite and demo were not run under the remediation's targeted-only rule.
