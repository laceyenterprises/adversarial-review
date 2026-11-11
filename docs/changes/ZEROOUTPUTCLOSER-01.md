# ZEROOUTPUTCLOSER-01

## Summary

A zero-output ticket refusal transfers closer custody to operator-escalated
instead of entering generic prelaunch slow retry. The same-head record retains
one successful escalation marker, clears the retry clock and suppresses dispatch
and merge-agent fallback. Historical slow-retry refusals are adopted immediately;
a new head keeps its own eligibility. Existing closer budgets are unchanged.

The companion agent-os PR makes the guard shape-aware and scopes strikes to the
PR head. After normal deployment and watcher restart, SRE observes 24 hours:
changed heads and terminal-audit attempts have no false zero-output refusal;
genuine refusals retain named operator custody and one escalation per head.
No live change is performed by this worker.

Final comment-only remediation skips unconfigured alert callbacks without
warning or recording delivery, so configuring delivery later can still page.
Alerts extract structured refusal diagnostics instead of displaying generic
object coercion. Focused regressions cover both findings.

## Interface changes

None in this remediation. Custody states, stored fields and delivery
deduplication retain their existing contracts.

## Verification

- `node test/run-tests.mjs test/zero-output-refusal.test.mjs test/unregistered-repo.test.mjs test/watcher-claim-loop.test.mjs`:
  all 179 targeted tests passed with repository isolation.
- `npm run lint`: passed with zero errors (existing warnings remain).
- `npm run typecheck:contracts`: passed.
- `bash demo/research-finding-walkthrough.sh`: passed offline.
- `node scripts/validate-data-model-catalog.mjs`: validated 93 entries.
