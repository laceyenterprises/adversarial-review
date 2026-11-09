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
unresolved terminal evidence reports `receipt-settlement-pending`.
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
