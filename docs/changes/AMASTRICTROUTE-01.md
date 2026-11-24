# AMASTRICTROUTE-01

## Summary

An exact-head review with findings takes precedence over a terminal remediation
receipt in strict mode. The shared table selects findings closure in R14 and
rescue projects the same owner. Strict-mode daemon routing requires zero findings
on a current-head review, including the head-scoped approval route. The existing
terminal proof for a superseded review still goes through daemon preflight.

## Interface changes

A refused successor handoff writes `needs-closer` to the existing head-scoped
receipt. Later closure passes can retry admission from either this state or the
legacy receipt. A confirmed successor records its remediation job ID. If final
fix-all is already spent, normal hammer admission receives only strict exact-head
final findings routes. Other routes retain `needs-closer` and refusal alerting.
Successor custody has an immediate refusal alert and a 1800-second escalation
for receipts that remain non-enrolled on the same open head. A bounded watcher
sweep checks receipts independently of closure selection, using the same page
latch for both observations.
The daemon executor also checks strict exact-head finding counts when called
without a shared decision.

The final Comment-only remediation preserves the strict-mode removal of the
per-PR `operator-approved` findings override. Approval still overrides the
verdict; accepting findings in the daemon lane requires `strict_mode: false`.

Strict exact-head findings now decline before unused HAM or head-closer
certification reads. Gate 1 consolidates the existing bypass expression without
changing merge authority. The acceptance command tolerates per-row read errors,
excludes those rows and explicitly refuses report-level errors.
The multi-pass fallback fixture exposed a related cap-page bypass: selecting R07
cleared the strict findings guard and retained an already succeeded dispatch.
Strict findings recognition now survives that stop, allowing terminal
reconciliation to reach the existing retry-cap page without another launch.

## Verification

Synthetic decision and successor fixtures reproduce the former daemon selection
and ownerless receipt. The regressions cover strict findings, strict zero
findings, non-strict findings, rescue agreement and a successful later retry.
The routing, successor, dispatch, retry-cap and state-machine suites passed
individually, along with lint, contract typechecking and the offline demo.
After deployment, a strict-mode Comment-only head with non-blocking findings
gets a closer or an explicit `needs-closer` receipt when admission is deferred.
The handoff smoke checks the 1800-second boundary, closed and moved heads,
and page deduplication across watcher restarts.

Final-round checks use `bash bin/run-bounded.sh --timeout <seconds> -- node
test/run-tests.mjs <targeted files>` for the daemon, watcher daemon wiring,
final fix-all, dispatch priority, retry cap, pr-blockers, claim-loop and SMV
files. The five-pass fallback fixture proves two launches, retained cap
accounting and one page. The shell fixtures execute the committed acceptance
command against synthetic row/report errors and route observations.
All 1,173 tests across these eight targeted files pass (785 + 199 + 142 + 47).
`npm run lint` reports zero errors (147 existing warnings);
`npm run typecheck:contracts`, `node scripts/validate-data-model-catalog.mjs`
(103 entries), `bash demo/research-finding-walkthrough.sh` and
`git diff --check` pass. The full suite remains the PR-head CI responsibility.
