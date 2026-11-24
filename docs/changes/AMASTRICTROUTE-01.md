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
fix-all is already spent, normal hammer admission receives strict exact-head
hammer routes with findings, including CI repair. Other routes retain
`needs-closer` and refusal alerting.
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

Final review remediation anchors the successor deadline to the original
`requestedAt`, so repeated settlement updates cannot starve escalation. The
focused regression also refreshes the receipt during the live-head read to
exercise the locked recheck. Canonical custody docs and the handoff smoke now
describe and verify this clock under repeated polling.
The reported strict-mode default bypass does not reproduce: the executor
already normalizes `cfg?.strictMode !== false` before computing `strictExactHead`.
Regression cases cover omitted, undefined and enabled configuration with
exact-head findings and valid operator approval; each declines before identity,
certification, live-head or merge calls. The executor uses the same normalized
strict setting for tenure checks, and the lower-level merge gate also rejects
all three exact-head bypass attempts with strict mode omitted. The legacy
certification parameter remains necessary for superseded reviews and non-strict
mode.
Final-review validation passed: 164 tests across the watcher daemon, successor
and SMV files; lint with zero errors (147 existing warnings), contract
typechecking, the data-model catalog validator (103 entries), the offline
walkthrough demo and `git diff --check`. The Python worker-validation module
was unavailable in this checkout; commands used the checked-in bounded runner.

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

### Hammer closeout

The successor deadline sweep retires receipts after confirmed closure or head
movement, and suppresses the overdue page while a closer launch or retry owns
the exact head. Strict hammer fallback includes CI repair on a reviewed head
with findings. Post-deploy acceptance reads the decision journal with numeric
timestamps so it can detect a daemon route even after the PR closes. The
closure runbook documents per-PR operator recovery under strict mode.

### Final builder CI repair

Moved recovery timer startup into the existing watcher preflight leaf module,
preserving immediate execution, independent 30-second cadence, unreferenced
timers and successor shutdown on SIGTERM/SIGINT. This restores the watcher's
ARC-18 line budget without changing its ceiling or adding CI checks.
Targeted validation covers timer lifecycle, the watcher claim loop, the five
advisory fixes and the existing state-machine smoke. Lint (zero errors),
contract typechecking, the 103-entry data-model catalog validator and the
offline research walkthrough pass; the full suite remains with PR-head CI.

### Final Comment-only advisory remediation

Successor receipts now record `fallbackAt` when the spent fix-all hands custody
to normal hammer admission. The deadline sweep leaves paging to the hammer
through retry gaps and cap escalation. A different settlement clears the marker.
Successful immediate or overdue pages record `escalatedAt` under the receipt
lock and end deadline paging. Delivery failures remain retryable.
Retired receipt JSON expires after seven days, with a locked timestamp recheck
and retained lock inode. The data-model fragment records these optional fields;
the generated catalog remains main-owned.

The closer-successor source inventory includes `src/watcher-tick-preflight.mjs`.
The README, state/smoke declarations and sandbox handoff fixture reflect the
ownership, successful escalation and retirement behavior.
The committed operator acceptance plan now records 24 hours of strict
exact-head findings traffic, retry-cap pages and manual closures. More than
three pages or more than three manual closures requires policy review before
broader rollout. Strict runtime merge authority is unchanged.

The review follow-up separates daily retirement probes from successor deadline
paging and persists a five-minute probe backoff for live closers and unreadable
PRs. The daemon executor now requires known zero findings for approval-based
closure in strict mode, including for superseded reviews. Dispatch and successor
fallback share a case-insensitive full-SHA comparison. An unchanged terminal
hammer audit with unresolved strict findings still reaches the bounded retry
cap and its existing deduplicated operator page. The recovery timer stops once
across mixed shutdown signals. The PR body uses the committed plan command.

Lint passed with zero errors (147 existing warnings), contract typechecking,
the 103-entry catalog validator, the offline walkthrough and `git diff --check`
passed. The Python worker-validation module is unavailable in this checkout;
the checked-in bounded runner owns timeout and cleanup.
The separate SMV/closer-next-action run passed all 120 tests, including the
sandbox handoff smoke. The watcher claim-loop suite passed all 199 tests within
its separate 300-second bound. An initial combined run reached its 180-second
bound without failed assertions; the completed separate runs cover all three
files. Total completed targeted coverage: 387 tests.
