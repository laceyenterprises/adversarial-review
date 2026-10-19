# CEILINGPUSH-01: moved head had no owner after the review ceiling

## Incident and evidence

On 2026-10-19, a consumer PR exhausted its review rounds with blocking
findings recorded on an older head. A worker other than the hammer rebased
the branch and pushed fixes for each finding. CI became green and GitHub
reported `CLEAN`, but closure did not converge. The operator merged by hand.
This was the third reported silent merge dead end that day. The evidence
below is generic; no production identifiers or filesystem paths are retained.

- The watcher repeatedly emitted `review-ceiling-closure-transition` with
  `priorStatus: posted` and `status: posted` for the moved head.
- Each `hammer_wake` reported
  `eligibilityReason: clean-current-head-ci-green-policy-eligible`,
  `outcome: skipped`, and `reason: verdict-not-eligible`.
- An exact-head `rereview-wake request --reason remediation-closeout` was
  consumed (`pending: 0`), but no review dispatched beyond the ceiling.

## Cause

Ceiling admission restored the posted row and selected hammer ownership,
but rewrote that same row every poll. The wake reused merge eligibility:
the old changes-requested verdict could never satisfy the two eligible
merge verdicts, `settled-success` and
`ham_terminal_remediation_validated`. The stale-head gate snapshot also
discarded the old review's findings rather than retaining them as input to
terminal remediation. The durable re-review wake did not explain this
closure handoff, and the posted-row lane returned before its admission drain.

## Repair and choice

Option 1 keeps the hammer as the terminal owner. It preserves the review
ceiling and existing final-adjudicator protocol instead of admitting another
review cycle. On a ceiling-routed moved head, the closure snapshot reads the
last review at its original head and passes those findings to the closer.
The target remains the live head; this is not closer-authorship proof or
permission to merge an unreviewed push.

The native wake admits only the stale-head and stale-verdict misses for this
handoff, with no active remediation owner. It records
`review-ceiling-terminal-remediation`. All independent policy misses remain
effective. The existing closer ceiling route dispatches terminal remediation
under its lease and retry caps. Strict mode still requires remediation and
verification of every valid finding, exact-head checks, and validated HAM
commit/audit evidence before recording `ham_terminal_remediation_validated`
and merging. The merge verdict allowlist is unchanged.

Ceiling routing returns ownership on repeated observations without rewriting
or logging another transition, including when a caller has an older row
snapshot. The posted-row lane drains closeout wakes and explicitly settles
them as `skipped: review-ceiling-hammer-owned`; it never claims that a review
was admitted. If closure cannot act, the existing durable final-round wait
records the actual refusal and pages once at its 30-minute bound. There is no
new gate, label, config key, retry budget, or CI job.

STOPHOLDREVIEW-01 continues to release a review-required stop only on a later
exact-head posting receipt. This repair covers a different case: no further
review is admitted at the ceiling. REVERSALPROV-01's rebase provenance rules
remain required for any HAM reversal; dispatch does not waive primary-change
preservation. Empty PR handling also remains unchanged.

## Validation and deployment acceptance

Offline synthetic regressions cover the moved green head with an older
blocking review through the real wake, closer dispatcher and lease; repeated
polls dispatch only one live hammer. They also cover unchanged heads,
independent policy holds, closeout wake settlement, stale caller snapshots,
and one page with the refusal reason when closure cannot act. The shared
merge predicate still refuses the old verdict and stale validated head.

Local validation passed 284 scoped tests including the complete watcher
claim-loop suite, then 316 closure and coordination tests after rebasing onto
STOPHOLDINFRA-01. Lint, contract typechecking, the offline byte-equivalence
demo and sandbox smoke all passed. The required full suite reported 11,127
tests: 11,111 passed, 10 failed and 6 skipped. Nine process/CWD and PostgreSQL
socket failures reproduced with main's production sources. The remaining
pending-UNKNOWN test hit its 15-second timeout during the full run and passed
in both the baseline slice and the final scoped run. A fully green full-suite
result is not claimed.

After deploying the watcher, observe the next naturally occurring ceiling
handoff: one transition, a terminal-remediation wake, a hammer lease targeting
the new head, validation of every finding and exact-head checks, then
`ham_terminal_remediation_validated` and a hammer merge. A refusal must surface
its reason and one bounded-wait page. Host acceptance remains to be observed;
this change performs no live-state repair or mutation of other PRs.
